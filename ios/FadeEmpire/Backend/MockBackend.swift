import Foundation

/// In-memory backend with the same permission rules as migration 0022: a barber manages
/// only their own chair, sees granted chairs read-only, and the manager can do everything.
/// Seed data is laid out around the clock's "today" (see `MockSeed`).
actor MockBackend: Backend {
    struct Account {
        let userId: UUID
        var email: String
        var password: String
        let role: Role
        var displayName: String
        let barberId: UUID?
        var mustChangePassword: Bool
        var notifyBookings = true
        var notifyCancellations = true
        var notifyViewedChairs = false
        var activitySeenAt: Date
        var isDisabled = false
        var lastSignInAt: Date?
    }

    struct StoredBooking {
        var row: Booking
        /// The user whose action wrote the booking, so their own events are not "unread".
        var createdBy: UUID?
    }

    struct Event {
        let id: Int64
        let kind: ActivityKind
        let actor: String
        let occurredAt: Date
        let bookingId: UUID
        let causedBy: UUID?
    }

    let clock: ShopClock
    var accounts: [Account]
    var barberRows: [Barber]
    var schedules: [UUID: [ScheduleDay]]
    var grants: Set<ViewGrant>
    var storedBookings: [StoredBooking]
    var events: [Event]
    /// Days off; an empty reason means none was given.
    var closures: [UUID: [ShopDay: String]]
    var linkRows: [BookingLink]
    var devices: [String: UUID] = [:]
    var signedIn: UUID?

    /// Calls a test can slow down or make fail (`inject`, or `-mock-fault` at launch).
    enum Call: String, Sendable {
        case restoreSession, me, bookings, daysOff, weeklyHours, links, activity, markActivitySeen
        case setNotifyPrefs, barbers, staff, viewGrants, barberSchedule, saveBarber, uploadBarberPhoto, setSchedule
    }

    /// `times` nil: every call.
    struct Fault: Sendable {
        var delay: Duration = .zero
        var error: BackendError?
        var times: Int? = 1
    }

    private var faults: [Call: [Fault]] = [:]
    private(set) var callCounts: [Call: Int] = [:]
    /// Paths `uploadBarberPhoto` stored, so tests can see a refused save uploaded nothing.
    private(set) var uploadedPhotos: [String] = []

    /// `mustChangePassword` lists logins that start as if the manager had just reset them.
    init(clock: ShopClock, signedInAs email: String? = nil, mustChangePassword: Set<String> = [],
         faults: [Call: Fault] = [:]) {
        self.clock = clock
        self.faults = faults.mapValues { [$0] }
        let seed = MockSeed(clock: clock)
        accounts = seed.accounts
        barberRows = seed.barbers
        schedules = seed.schedules
        grants = seed.grants
        storedBookings = seed.bookings
        events = seed.events
        closures = seed.closures
        linkRows = seed.links
        for i in accounts.indices where mustChangePassword.contains(accounts[i].email) {
            accounts[i].mustChangePassword = true
        }
        if let email, let i = accounts.firstIndex(where: { $0.email == email }) {
            signedIn = accounts[i].userId
        }
    }

    /// Queues a fault for the next calls of `call`, after any already queued.
    func inject(_ call: Call, delay: Duration = .zero, error: BackendError? = nil, times: Int? = 1) {
        faults[call, default: []].append(Fault(delay: delay, error: error, times: times))
    }

    func callCount(_ call: Call) -> Int { callCounts[call] ?? 0 }

    /// Reads call this after taking their answer, so a delayed read returns what was true when it
    /// was asked (and can land after a newer one); writes call it before changing anything.
    private func fault(_ call: Call) async throws {
        callCounts[call, default: 0] += 1
        guard var f = faults[call]?.first else { return }
        if let times = f.times {
            if times <= 1 { faults[call]!.removeFirst() } else { f.times = times - 1; faults[call]![0] = f }
        }
        if f.delay > .zero { try? await Task.sleep(for: f.delay) }
        if let e = f.error { throw e }
    }

    // MARK: - Permission rules (app_caller, app_is_manager, app_my_barber_id, app_can_view, app_can_manage)

    /// The signed-in login. A disabled login keeps its session but counts as no login
    /// (app_caller), so every rule below answers no for it.
    private func caller() throws -> Account {
        guard let id = signedIn, let a = accounts.first(where: { $0.userId == id }) else { throw BackendError.notSignedIn }
        return a
    }

    private func isManager(_ a: Account) -> Bool { a.role == .manager && !a.isDisabled }

    private func myBarberId(_ a: Account) -> UUID? {
        guard !a.isDisabled, let id = a.barberId, barberRows.first(where: { $0.id == id })?.isActive == true else { return nil }
        return id
    }

    func canView(_ a: Account, _ barberId: UUID) -> Bool {
        if isManager(a) { return true }
        guard let mine = myBarberId(a) else { return false }
        return mine == barberId
            || (grants.contains(ViewGrant(viewerBarberId: mine, barberId: barberId))
                && barberRows.first { $0.id == barberId }?.isActive == true)
    }

    func canManage(_ a: Account, _ barberId: UUID) -> Bool {
        isManager(a) || myBarberId(a) == barberId
    }

    private func requireView(_ barberId: UUID) throws -> Account {
        let a = try caller()
        guard canView(a, barberId) else { throw BackendError.forbidden }
        return a
    }

    private func requireManage(_ barberId: UUID) throws -> Account {
        let a = try caller()
        guard canManage(a, barberId) else { throw BackendError.forbidden }
        return a
    }

    private func requireManager() throws -> Account {
        let a = try caller()
        guard isManager(a) else { throw BackendError.forbidden }
        return a
    }

    /// `manager` when a manager acts on a chair that is not their own (app_set_actor).
    private func actorName(_ a: Account, on barberId: UUID) -> String {
        isManager(a) && a.barberId != barberId ? "manager" : "barber"
    }

    /// Upcoming: the slot has not started yet.
    private func isUpcoming(_ b: Booking) -> Bool {
        b.date > clock.today || (b.date == clock.today && b.time >= clock.timeOfDay)
    }

    private func barber(_ id: UUID) throws -> Barber {
        guard let b = barberRows.first(where: { $0.id == id }) else { throw BackendError.barberNotFound }
        return b
    }

    // MARK: - Auth

    func restoreSession() async throws -> Bool {
        let restored = signedIn != nil
        try await fault(.restoreSession)
        return restored
    }

    func signIn(email: String, password: String) async throws {
        let e = email.trimmingCharacters(in: .whitespaces).lowercased()
        guard let i = accounts.firstIndex(where: { $0.email == e && $0.password == password }),
              !accounts[i].isDisabled else { throw BackendError.invalidCredentials }
        accounts[i].lastSignInAt = clock.now()
        signedIn = accounts[i].userId
    }

    func changePassword(_ newPassword: String) async throws {
        let a = try caller()
        guard newPassword.count >= 8, newPassword != a.password else { throw BackendError.weakPassword }
        let i = accounts.firstIndex { $0.userId == a.userId }!
        accounts[i].password = newPassword
        accounts[i].mustChangePassword = false
    }

    func signOut() async throws { signedIn = nil }

    func currentEmail() async -> String? { try? caller().email }

    // MARK: - App RPCs

    /// No row (`noAccess`) for a disabled login or a barber whose chair is inactive.
    func me() async throws -> Me {
        let a = try caller()
        let mine = myBarberId(a)
        guard !a.isDisabled, a.role == .manager || mine != nil else { throw BackendError.noAccess }
        let visible = barberRows
            .filter { canView(a, $0.id) }
            .sorted { lhs, rhs in
                if lhs.id == mine { return true }
                if rhs.id == mine { return false }
                return lhs.sortOrder < rhs.sortOrder
            }
        let chairs = visible.map {
            Chair(barberId: $0.id, slug: $0.slug, displayName: $0.displayName, title: $0.title,
                  isActive: $0.isActive, canManage: canManage(a, $0.id))
        }
        let slug = mine.flatMap { id in barberRows.first { $0.id == id }?.slug }
        let me = Me(userId: a.userId, role: a.role, displayName: a.displayName, barberId: mine, barberSlug: slug,
                  mustChangePassword: a.mustChangePassword, notifyBookings: a.notifyBookings,
                  notifyCancellations: a.notifyCancellations, notifyViewedChairs: a.notifyViewedChairs,
                  chairs: chairs)
        try await fault(.me)
        return me
    }

    func bookings(barberId: UUID, from: ShopDay, to: ShopDay) async throws -> [Booking] {
        let a = try requireView(barberId)
        guard from <= to, from.days(until: to) <= 62 else { throw BackendError.invalidRange }
        let manage = canManage(a, barberId)
        let rows: [Booking] = storedBookings
            .map(\.row)
            .filter { $0.barberId == barberId && $0.date >= from && $0.date <= to && $0.status != .expired }
            .sorted { ($0.date, $0.time) < ($1.date, $1.time) }
            .map { b in
                var b = b
                b.canManage = manage
                if !manage { b.customerPhone = nil }   // a view-only chair gets no phones
                return b
            }
        try await fault(.bookings)
        return rows
    }

    /// Store hours ∩ the barber's hours, minus days off and taken slots, on the
    /// 45-minute grid from open, with no past slots today.
    func freeSlots(barberId: UUID, date: ShopDay) async throws -> [ShopTime] {
        _ = try requireView(barberId)
        return openSlots(barberId: barberId, date: date)
    }

    private func gridSlots(barberId: UUID, date: ShopDay) -> [ShopTime] {
        guard let store = Catalog.storeHours[date.weekday],
              let mine = schedules[barberId]?.first(where: { $0.weekday == date.weekday }),
              barberRows.first(where: { $0.id == barberId })?.isActive == true,
              closures[barberId]?[date] == nil else { return [] }
        let open = max(store.open, mine.open), close = min(store.close, mine.close)
        return stride(from: open.minutes, to: close.minutes, by: Shop.slotMinutes).map(ShopTime.init(minutes:))
    }

    private func openSlots(barberId: UUID, date: ShopDay) -> [ShopTime] {
        let today = clock.today
        guard date >= today, today.days(until: date) <= 60 else { return [] }
        let taken = Set(storedBookings.map(\.row)
            .filter { $0.barberId == barberId && $0.date == date && $0.status.isActive }
            .map(\.time))
        let now = clock.timeOfDay
        return gridSlots(barberId: barberId, date: date)
            .filter { !taken.contains($0) && (date > today || $0 > now) }
    }

    func book(_ n: NewBooking) async throws -> UUID {
        let a = try requireManage(n.barberId)
        let b = try barber(n.barberId)
        guard b.isActive else { throw BackendError.barberNotFound }
        let name = n.customerName.trimmingCharacters(in: .whitespaces)
        guard name.count >= 2 else { throw BackendError.invalidName }
        let phone = Phone.digits(n.customerPhone)
        guard phone.count == 10 else { throw BackendError.invalidPhone }
        guard let service = Catalog.service(n.serviceSlug) else { throw BackendError.serviceNotFound }
        guard n.date >= clock.today, clock.today.days(until: n.date) <= 60 else { throw BackendError.dateOutOfRange }
        guard Catalog.storeHours[n.date.weekday] != nil else { throw BackendError.storeClosed }
        guard closures[n.barberId]?[n.date] == nil else { throw BackendError.barberClosed }
        let grid = gridSlots(barberId: n.barberId, date: n.date)
        guard !grid.isEmpty else { throw BackendError.outsideWorkingHours }
        guard grid.contains(n.time) else { throw BackendError.invalidSlot }
        guard openSlots(barberId: n.barberId, date: n.date).contains(n.time) else { throw BackendError.slotTaken }

        let addons = Catalog.addons.filter { n.addonSlugs.contains($0.slug) && !Catalog.isIncluded($0.slug, in: service.slug) }
        let row = Booking(
            id: UUID(), barberId: b.id, barberSlug: b.slug, date: n.date, time: n.time,
            endTime: n.time.adding(minutes: Shop.slotMinutes), serviceSlug: service.slug, serviceName: service.name,
            durationMinutes: service.minutes, addons: addons.map(\.name), customRequest: nil,
            customerNotes: n.notes?.isEmpty == true ? nil : n.notes, customerName: name, customerPhone: phone,
            totalPriceCents: Catalog.totalCents(service: service.slug, addons: Set(n.addonSlugs)),
            status: .confirmed, source: "app", isGuest: false, partyId: UUID(), partySize: 1,
            createdAt: Instant(clock.now()), cancelledAt: nil, cancelledBy: nil, canManage: true)
        storedBookings.append(StoredBooking(row: row, createdBy: a.userId))
        record(.booked, actor: actorName(a, on: b.id), booking: row.id, by: a.userId)
        return row.id
    }

    private func record(_ kind: ActivityKind, actor: String, booking: UUID, by user: UUID?) {
        let id = (events.map(\.id).max() ?? 0) + 1
        events.append(Event(id: id, kind: kind, actor: actor, occurredAt: clock.now(), bookingId: booking, causedBy: user))
    }

    private func bookingIndex(_ id: UUID) throws -> Int {
        guard let i = storedBookings.firstIndex(where: { $0.row.id == id }) else { throw BackendError.bookingNotFound }
        return i
    }

    func cancelBooking(id: UUID) async throws -> CancelledBooking {
        let i = try bookingIndex(id)
        let barberId = storedBookings[i].row.barberId
        let a = try requireManage(barberId)
        // cannot_cancel unless pending or confirmed
        guard [.pending, .confirmed].contains(storedBookings[i].row.status) else { throw BackendError.bookingNotActive }
        storedBookings[i].row.status = .cancelled
        storedBookings[i].row.cancelledAt = Instant(clock.now())
        storedBookings[i].row.cancelledBy = actorName(a, on: barberId)
        record(.cancelled, actor: actorName(a, on: barberId), booking: id, by: a.userId)
        let r = storedBookings[i].row
        return CancelledBooking(bookingId: id, customerName: r.customerName, customerPhone: r.customerPhone ?? "",
                                date: r.date, time: r.time)
    }

    func setStatus(bookingId: UUID, status: BookingStatus) async throws {
        let i = try bookingIndex(bookingId)
        let row = storedBookings[i].row
        let a = try requireManage(row.barberId)
        switch status {
        case .noShow:
            guard row.status.isActive else { throw BackendError.bookingNotActive }   // invalid_status_change
            storedBookings[i].row.status = .noShow
            record(.noShow, actor: actorName(a, on: row.barberId), booking: bookingId, by: a.userId)
        case .confirmed:
            guard row.status == .noShow else { throw BackendError.bookingNotActive }   // invalid_status_change
            let rebooked = storedBookings.contains {
                $0.row.id != bookingId && $0.row.barberId == row.barberId && $0.row.date == row.date
                    && $0.row.time == row.time && $0.row.status.isActive
            }
            guard !rebooked else { throw BackendError.slotTaken }
            storedBookings[i].row.status = .confirmed
            events.removeAll { $0.bookingId == bookingId && $0.kind == .noShow }   // undo deletes the no_show event
        default:
            throw BackendError.server("invalid_status")
        }
    }

    func activity(before: Int64?, limit: Int) async throws -> [ActivityEvent] {
        let a = try caller()
        let byId = Dictionary(uniqueKeysWithValues: storedBookings.map { ($0.row.id, $0.row) })
        let page: [ActivityEvent] = events
            .filter { e in before.map { e.id < $0 } ?? true }
            .sorted { $0.id > $1.id }
            .compactMap { e -> ActivityEvent? in
                guard let b = byId[e.bookingId], canView(a, b.barberId),
                      let barber = barberRows.first(where: { $0.id == b.barberId }) else { return nil }
                return ActivityEvent(
                    eventId: e.id, kind: e.kind, actor: e.actor, occurredAt: Instant(e.occurredAt),
                    bookingId: b.id, barberId: b.barberId, barberSlug: barber.slug, barberName: barber.displayName,
                    customerName: b.customerName, date: b.date, time: b.time, serviceName: b.serviceName,
                    isUnread: e.occurredAt > a.activitySeenAt && e.causedBy != a.userId)
            }
            .prefix(limit)
            .map { $0 }
        try await fault(.activity)
        return page
    }

    func markActivitySeen() async throws {
        let a = try caller()
        try await fault(.markActivitySeen)
        let i = accounts.firstIndex { $0.userId == a.userId }!
        accounts[i].activitySeenAt = clock.now()
    }

    func daysOff(barberId: UUID) async throws -> [DayOff] {
        _ = try requireView(barberId)
        let rows: [DayOff] = (closures[barberId] ?? [:])
            .filter { $0.key >= clock.today }
            .sorted { $0.key < $1.key }
            .map { DayOff(date: $0.key, reason: $0.value.isEmpty ? nil : $0.value,
                         bookingsThatDay: activeCount(barberId, on: $0.key)) }
        try await fault(.daysOff)
        return rows
    }

    /// Pending or confirmed bookings that day (bookings_that_day).
    private func activeCount(_ barberId: UUID, on day: ShopDay) -> Int {
        storedBookings.filter {
            $0.row.barberId == barberId && $0.row.date == day && [.pending, .confirmed].contains($0.row.status)
        }.count
    }

    /// Adding a day that is already off updates its reason.
    func addDayOff(barberId: UUID, date: ShopDay, reason: String?) async throws -> Int {
        _ = try requireManage(barberId)
        guard date >= clock.today else { throw BackendError.dateOutOfRange }
        closures[barberId, default: [:]][date] = reason?.trimmingCharacters(in: .whitespaces) ?? ""
        return activeCount(barberId, on: date)
    }

    func removeDayOff(barberId: UUID, date: ShopDay) async throws {
        _ = try requireManage(barberId)
        closures[barberId]?[date] = nil
    }

    func setNotifyPrefs(bookings: Bool, cancellations: Bool, viewedChairs: Bool) async throws {
        let a = try caller()
        try await fault(.setNotifyPrefs)
        let i = accounts.firstIndex { $0.userId == a.userId }!
        accounts[i].notifyBookings = bookings
        accounts[i].notifyCancellations = cancellations
        accounts[i].notifyViewedChairs = viewedChairs
    }

    func registerDevice(token: String, environment: String) async throws {
        let a = try caller()
        guard !a.isDisabled else { throw BackendError.forbidden }
        guard ["sandbox", "production"].contains(environment) else { throw BackendError.server("invalid_environment") }
        devices[token] = a.userId
    }

    /// Only removes the caller's own token.
    func unregisterDevice(token: String) async throws {
        let a = try caller()
        if devices[token] == a.userId { devices[token] = nil }
    }

    func weeklyHours(barberId: UUID) async throws -> [ScheduleDay] {
        let week = (schedules[barberId] ?? []).sorted { $0.weekday < $1.weekday }
        try await fault(.weeklyHours)
        return week
    }

    // MARK: - booking_links

    /// RLS: a chair the caller cannot manage reads as no links.
    func links(barberId: UUID) async throws -> [BookingLink] {
        let a = try caller()
        let rows = canManage(a, barberId) ? linkRows.filter { $0.barberId == barberId }.sorted { $0.createdAt < $1.createdAt } : []
        try await fault(.links)
        return rows
    }

    func addLink(barberId: UUID, label: String, serviceSlug: String?) async throws -> BookingLink {
        _ = try requireManage(barberId)
        let l = label.trimmingCharacters(in: .whitespaces)
        guard (1...60).contains(l.count) else { throw BackendError.invalidLabel }
        if let s = serviceSlug, Catalog.service(s) == nil { throw BackendError.serviceNotFound }
        let link = BookingLink(id: UUID(), barberId: barberId, label: l, serviceSlug: serviceSlug,
                               createdAt: Instant(clock.now()))
        linkRows.append(link)
        return link
    }

    /// RLS: deleting another chair's link deletes nothing, without an error.
    func deleteLink(id: UUID) async throws {
        let a = try caller()
        guard let link = linkRows.first(where: { $0.id == id }), canManage(a, link.barberId) else { return }
        linkRows.removeAll { $0.id == id }
    }

    // MARK: - Manager

    func barbers() async throws -> [Barber] {
        _ = try requireManager()
        let rows = barberRows.sorted { $0.sortOrder < $1.sortOrder }
        try await fault(.barbers)
        return rows
    }

    func staff() async throws -> [StaffMember] {
        _ = try requireManager()
        let rows = accounts.map {
            StaffMember(userId: $0.userId, email: $0.email, role: $0.role, displayName: $0.displayName,
                        barberId: $0.barberId, lastSignInAt: $0.lastSignInAt.map(Instant.init), isDisabled: $0.isDisabled)
        }
        try await fault(.staff)
        return rows
    }

    func saveBarber(_ d: BarberDraft) async throws -> UUID {
        _ = try requireManager()
        try await fault(.saveBarber)
        let slug = d.slug.trimmingCharacters(in: .whitespaces).lowercased()
        guard BarberDraft.isValidSlug(slug) else { throw BackendError.invalidSlug }
        guard !BarberDraft.reservedSlugs.contains(slug) else { throw BackendError.slugReserved }
        let name = d.displayName.trimmingCharacters(in: .whitespaces)
        guard (1...40).contains(name.count) else { throw BackendError.invalidBarberName }
        if barberRows.contains(where: { $0.slug == slug && $0.id != d.id }) { throw BackendError.slugTaken }
        let title = d.title.trimmingCharacters(in: .whitespaces)
        let bio = d.bio.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !BarberDraft.hasRefusedCharacters(name), !BarberDraft.hasRefusedCharacters(title),
              !BarberDraft.hasRefusedCharacters(bio, allowsLineBreaks: true) else { throw BackendError.invalidText }
        // A photo passed back unchanged is not checked (Larry's is a relative path).
        let oldPhoto = d.id.flatMap { id in barberRows.first { $0.id == id }?.photoUrl }
        if let photo = d.photoUrl, !photo.isEmpty, photo != oldPhoto, !BarberDraft.isValidPhotoUrl(photo) {
            throw BackendError.invalidPhotoUrl
        }
        if let id = d.id {
            guard let i = barberRows.firstIndex(where: { $0.id == id }) else { throw BackendError.barberNotFound }
            if barberRows[i].slug != slug, storedBookings.contains(where: { $0.row.barberId == id }) {
                throw BackendError.slugLocked
            }
            barberRows[i].slug = slug
            barberRows[i].displayName = name
            barberRows[i].title = title.isEmpty ? nil : title
            barberRows[i].bio = bio.isEmpty ? nil : bio
            barberRows[i].photoUrl = d.photoUrl
            return id
        }
        let b = Barber(id: UUID(), slug: slug, displayName: name, title: title.isEmpty ? nil : title,
                       bio: bio.isEmpty ? nil : bio, photoUrl: d.photoUrl, isActive: true,
                       sortOrder: (barberRows.map(\.sortOrder).max() ?? 0) + 10)
        barberRows.append(b)
        return b.id
    }

    func uploadBarberPhoto(_ jpeg: Data, slug: String) async throws -> String {
        _ = try requireManager()
        try await fault(.uploadBarberPhoto)
        let path = "\(slug)/\(UUID().uuidString.lowercased()).jpg"
        uploadedPhotos.append(path)
        return "https://mock.local/storage/v1/object/public/barber-photos/\(path)"
    }

    func barberSchedule(barberId: UUID) async throws -> [ScheduleDay] {
        _ = try requireManager()
        let week = (schedules[barberId] ?? []).sorted { $0.weekday < $1.weekday }
        try await fault(.barberSchedule)
        return week
    }

    /// Replaces the week; returns the upcoming active bookings it leaves on a day off, outside
    /// the hours, or off the 45-minute grid from open. They stay booked.
    func setSchedule(barberId: UUID, days: [ScheduleDay]) async throws -> Int {
        _ = try requireManager()
        try await fault(.setSchedule)
        _ = try barber(barberId)
        guard Set(days.map(\.weekday)).count == days.count,
              days.allSatisfy({ (0...6).contains($0.weekday) && $0.open < $0.close }) else { throw BackendError.invalidSchedule }
        for d in days {
            guard let store = Catalog.storeHours[d.weekday], d.open >= store.open, d.close <= store.close
            else { throw BackendError.outsideStoreHours }
        }
        schedules[barberId] = days
        return storedBookings.map(\.row).filter { b in
            guard b.barberId == barberId, b.status.isActive, isUpcoming(b) else { return false }
            guard let day = days.first(where: { $0.weekday == b.date.weekday }) else { return true }
            return b.time < day.open || b.time >= day.close || (b.time.minutes - day.open.minutes) % Shop.slotMinutes != 0
        }.count
    }

    func setActive(barberId: UUID, active: Bool) async throws -> Int {
        _ = try requireManager()
        guard let i = barberRows.firstIndex(where: { $0.id == barberId }) else { throw BackendError.barberNotFound }
        barberRows[i].isActive = active
        return storedBookings.map(\.row).filter {
            $0.barberId == barberId && [.pending, .confirmed].contains($0.status) && isUpcoming($0)
        }.count
    }

    func viewGrants() async throws -> [ViewGrant] {
        _ = try requireManager()
        let rows = Array(grants)
        try await fault(.viewGrants)
        return rows
    }

    func setViewGrant(viewer: UUID, barber: UUID, granted: Bool) async throws {
        _ = try requireManager()
        guard viewer != barber else { throw BackendError.invalidGrant }
        _ = try self.barber(viewer)
        _ = try self.barber(barber)
        let g = ViewGrant(viewerBarberId: viewer, barberId: barber)
        if granted { grants.insert(g) } else { grants.remove(g) }
    }

    // MARK: - staff-admin

    static let words = ["brass", "chair", "fade", "lamp", "comb", "taper", "razor", "towel", "mirror", "clip",
                        "steam", "knight", "crown", "line", "edge", "shine"]

    /// Four short words and two digits, the staff-admin format.
    static func temporaryPassword() -> String {
        (0..<4).map { _ in words.randomElement()! }.joined(separator: "-") + "-" + String(format: "%02d", Int.random(in: 0...99))
    }

    func createLogin(email: String, displayName: String, role: Role, barberId: UUID?) async throws -> CreatedLogin {
        _ = try requireManager()
        let e = email.trimmingCharacters(in: .whitespaces).lowercased()
        guard e.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil else { throw BackendError.invalidEmail }
        let name = displayName.trimmingCharacters(in: .whitespaces)
        guard (1...60).contains(name.count) else { throw BackendError.invalidDisplayName }
        if role == .barber && barberId == nil { throw BackendError.server("barber_required") }
        if let barberId {
            _ = try barber(barberId)
            guard !accounts.contains(where: { $0.barberId == barberId }) else { throw BackendError.barberHasLogin }
        }
        guard !accounts.contains(where: { $0.email == e }) else { throw BackendError.emailTaken }
        let password = Self.temporaryPassword()
        let account = Account(userId: UUID(), email: e, password: password, role: role, displayName: name,
                              barberId: barberId, mustChangePassword: true, activitySeenAt: clock.now())
        accounts.append(account)
        return CreatedLogin(userId: account.userId, temporaryPassword: password)
    }

    func resetPassword(userId: UUID) async throws -> String {
        _ = try requireManager()
        guard let i = accounts.firstIndex(where: { $0.userId == userId }) else { throw BackendError.userNotFound }
        let password = Self.temporaryPassword()
        accounts[i].password = password
        accounts[i].mustChangePassword = true
        return password
    }

    func setLoginDisabled(userId: UUID, disabled: Bool) async throws {
        let me = try requireManager()
        if disabled && userId == me.userId { throw BackendError.cannotDisableSelf }
        guard let i = accounts.firstIndex(where: { $0.userId == userId }) else { throw BackendError.userNotFound }
        accounts[i].isDisabled = disabled
        if disabled { devices = devices.filter { $0.value != userId } }
    }
}
