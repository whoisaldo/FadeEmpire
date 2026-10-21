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

/// The manager's Barbers tab: profiles, hours, logins, view grants, active state.
@MainActor @Observable
final class BarbersModel {
    let app: AppModel
    private(set) var barbers: [Barber] = []
    private(set) var staff: [StaffMember] = []
    private(set) var grants: Set<ViewGrant> = []
    /// False when `manager_view_grants` failed: the switches can't show the current state.
    private(set) var grantsLoaded = false
    private(set) var schedules: [UUID: [ScheduleDay]] = [:]
    var error: String?

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
        do {
            async let b = backend.barbers()
            async let s = backend.staff()
            let (rows, people) = try await (b, s)
            barbers = rows
            staff = people
            // Loaded on its own, so the rest of the tab works without it.
            if let grantRows = try? await backend.viewGrants() {
                grants = Set(grantRows)
                grantsLoaded = true
            } else {
                grantsLoaded = false
            }
            var hours: [UUID: [ScheduleDay]] = [:]
            for row in rows { hours[row.id] = try await backend.barberSchedule(barberId: row.id) }
            schedules = hours
            error = nil
        } catch {
            self.error = app.handle(error)
        }
    }

    /// Saves the profile (uploading a new photo first), then the week's hours. Also returns
    /// how many upcoming bookings the new hours leave out (they stay booked).
    func save(_ draft: BarberDraft, hours: HoursDraft, photo: Data?) async throws -> (id: UUID, outsideHours: Int) {
        var d = draft
        if let photo { d.photoUrl = try await backend.uploadBarberPhoto(photo, slug: d.slug) }
        let id = try await backend.saveBarber(d)
        let outside = try await backend.setSchedule(barberId: id, days: hours.schedule)
        await load()
        await app.refresh()
        return (id, outside)
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
