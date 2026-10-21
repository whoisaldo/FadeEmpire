import Foundation
import Observation

/// One weekday in the hours editor; nil hours = not working.
struct HoursDraft: Equatable {
    var days: [Int: OpenHours]

    /// A new barber starts on the shop's full hours.
    static let storeDefault = HoursDraft(days: Catalog.storeHours)

    init(days: [Int: OpenHours]) { self.days = days }

    init(_ schedule: [ScheduleDay]) {
        days = Dictionary(schedule.map { ($0.weekday, OpenHours(open: $0.open, close: $0.close)) }, uniquingKeysWith: { a, _ in a })
    }

    var schedule: [ScheduleDay] {
        days.keys.sorted().map { ScheduleDay(weekday: $0, open: days[$0]!.open, close: days[$0]!.close) }
    }

    /// Monday first, the way the shop talks about its week.
    static let displayOrder = [1, 2, 3, 4, 5, 6, 0]

    /// Half-hour choices inside the shop's hours that weekday.
    static func choices(for weekday: Int) -> [ShopTime] {
        guard let store = Catalog.storeHours[weekday] else { return [] }
        return stride(from: store.open.minutes, through: store.close.minutes, by: 30).map(ShopTime.init(minutes:))
    }

    static func summary(_ schedule: [ScheduleDay]) -> String {
        guard !schedule.isEmpty else { return "No hours set" }
        return displayOrder.compactMap { wd in
            schedule.first { $0.weekday == wd }.map {
                "\(Catalog.weekdayNames[wd].prefix(3)) \(ShopFormat.time($0.open))–\(ShopFormat.time($0.close))"
            }
        }.joined(separator: "\n")
    }
}

/// The hours half of the editor. `original` is what is saved, nil while it is still loading or
/// failed to load; the hours are sent only when they were loaded and changed, so editing just
/// the profile never touches them. A new barber has no hours yet, so theirs are always sent.
struct HoursEdit: Equatable {
    var original: HoursDraft?
    var edited: HoursDraft?
    let isNew: Bool

    static func forNewBarber() -> HoursEdit { HoursEdit(original: HoursDraft(days: [:]), edited: .storeDefault, isNew: true) }

    static func forBarber(saved: [ScheduleDay]?) -> HoursEdit {
        HoursEdit(original: saved.map(HoursDraft.init), edited: saved.map(HoursDraft.init), isNew: false)
    }

    /// The saved hours arrived after the editor opened.
    mutating func loaded(_ saved: [ScheduleDay]) {
        guard original == nil else { return }
        original = HoursDraft(saved)
        edited = original
    }

    /// The week to send to `manager_set_schedule`, or nil to leave the saved hours alone.
    var toSave: [ScheduleDay]? {
        guard let original, let edited, isNew || edited != original else { return nil }
        return edited.schedule
    }

    /// Saving would leave the barber with no working day, so the website stops offering them.
    var leavesNoWorkingDays: Bool { toSave?.isEmpty == true }
}

/// The manager's Barbers tab: profiles, hours, logins, view grants, active state.
@MainActor @Observable
final class BarbersModel {
    let app: AppModel
    private(set) var barbers: [Barber] = []
    private(set) var staff: [StaffMember] = []
    private(set) var grants: Set<ViewGrant> = []
    /// False when `manager_view_grants` failed: the switches can't show the current state.
    private(set) var grantsLoaded = false
    /// Each barber's saved hours, once loaded (`manager_barber_schedule`).
    private(set) var schedules: [UUID: [ScheduleDay]] = [:]
    /// Barbers whose hours failed to load on the last try.
    private(set) var scheduleFailed: Set<UUID> = []
    var error: String?
    @ObservationIgnored private var loads = LoadGeneration()

    init(app: AppModel) { self.app = app }

    var backend: Backend { app.backend }

    /// Active barbers first, then inactive, each in site order.
    var sorted: [Barber] {
        barbers.sorted { ($0.isActive ? 0 : 1, $0.sortOrder) < ($1.isActive ? 0 : 1, $1.sortOrder) }
    }

    func barber(_ id: UUID) -> Barber? { barbers.first { $0.id == id } }

    func login(for barberId: UUID) -> StaffMember? {
        staff.first { $0.role == .barber && $0.barberId == barberId }
    }

    func canView(viewer: UUID, barber: UUID) -> Bool {
        grants.contains(ViewGrant(viewerBarberId: viewer, barberId: barber))
    }

    func load() async {
        let generation = loads.next()
        do {
            async let b = backend.barbers()
            async let s = backend.staff()
            let (rows, people) = try await (b, s)
            guard loads.isCurrent(generation) else { return }
            barbers = rows
            staff = people
            error = nil
            // Loaded on their own, so the rest of the tab works without them.
            let grantRows = try? await backend.viewGrants()
            guard loads.isCurrent(generation) else { return }
            if let grantRows { grants = Set(grantRows) }
            grantsLoaded = grantRows != nil
            await withTaskGroup(of: (UUID, [ScheduleDay]?).self) { group in
                for row in rows {
                    group.addTask { [backend] in (row.id, try? await backend.barberSchedule(barberId: row.id)) }
                }
                for await (id, week) in group where loads.isCurrent(generation) {
                    record(id, week)
                }
            }
        } catch {
            guard loads.isCurrent(generation) else { return }
            self.error = app.handle(error)
        }
    }

    /// The Retry next to hours that failed to load.
    func loadSchedule(_ barberId: UUID) async {
        scheduleFailed.remove(barberId)
        record(barberId, try? await backend.barberSchedule(barberId: barberId))
    }

    private func record(_ id: UUID, _ week: [ScheduleDay]?) {
        schedules[id] = week
        if week == nil { scheduleFailed.insert(id) } else { scheduleFailed.remove(id) }
    }

    enum HoursResult: Equatable {
        case unchanged
        /// With how many upcoming bookings the new hours leave out (they stay booked).
        case saved(outsideHours: Int)
        case failed(String)
    }

    struct SaveResult {
        let id: UUID
        /// The photo now saved, so a retry does not upload it again.
        let photoUrl: String?
        let hours: HoursResult
    }

    /// Saves the profile, uploading a picked photo first, then the hours when `hours` is set.
    /// The fields are checked before anything is uploaded, so a refused save leaves no stray
    /// photo behind. A failed profile save throws; a failed hours save is in the result, as
    /// the profile is saved by then.
    func save(_ draft: BarberDraft, photo: Data?, hours: [ScheduleDay]?) async throws -> SaveResult {
        if let problem = draft.problems(others: barbers).first { throw problem }
        var d = draft
        if let photo { d.photoUrl = try await backend.uploadBarberPhoto(photo, slug: d.slug) }
        let id = try await backend.saveBarber(d)
        var result = HoursResult.unchanged
        if let hours {
            do {
                result = .saved(outsideHours: try await backend.setSchedule(barberId: id, days: hours))
            } catch {
                result = .failed(app.handle(error))
            }
        }
        await load()
        await app.refresh()
        return SaveResult(id: id, photoUrl: d.photoUrl, hours: result)
    }

    /// After saving hours that leave bookings outside them, so the manager contacts those customers.
    nonisolated static func outsideHoursNotice(name: String, count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1
            ? "1 upcoming appointment no longer fits \(name)'s hours. It's still booked: contact that customer."
            : "\(count) upcoming appointments no longer fit \(name)'s hours. They're still booked: contact those customers."
    }

    /// Pending or confirmed bookings that have not started, as `manager_set_active` counts them.
    func upcomingBookings(_ barberId: UUID) async throws -> [Booking] {
        let today = app.clock.today, now = app.clock.timeOfDay
        return try await backend.bookings(barberId: barberId, from: today, to: today.adding(days: 60))
            .filter { ($0.status == .pending || $0.status == .confirmed) && ($0.date > today || $0.time >= now) }
    }

    func setActive(_ barberId: UUID, _ active: Bool) async throws -> Int {
        let n = try await backend.setActive(barberId: barberId, active: active)
        await load()
        await app.refresh()
        return n
    }

    func setGrant(viewer: UUID, barber: UUID, granted: Bool) async {
        do {
            try await backend.setViewGrant(viewer: viewer, barber: barber, granted: granted)
            let g = ViewGrant(viewerBarberId: viewer, barberId: barber)
            if granted { grants.insert(g) } else { grants.remove(g) }
        } catch {
            self.error = app.handle(error)
        }
    }

    func createLogin(for barber: Barber, email: String) async throws -> CreatedLogin {
        let created = try await backend.createLogin(email: email, displayName: barber.displayName, role: .barber, barberId: barber.id)
        await load()
        return created
    }

    func resetPassword(_ member: StaffMember) async throws -> String {
        try await backend.resetPassword(userId: member.userId)
    }

    func setDisabled(_ member: StaffMember, _ disabled: Bool) async throws {
        try await backend.setLoginDisabled(userId: member.userId, disabled: disabled)
        await load()
    }

    /// "Omar Haddad" → "omar-haddad", trimmed to the slug rules.
    nonisolated static func suggestedSlug(_ name: String) -> String {
        let lowered = name.lowercased().folding(options: .diacriticInsensitive, locale: Shop.locale)
        let dashed = lowered.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let collapsed = dashed.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(30))
    }
}
