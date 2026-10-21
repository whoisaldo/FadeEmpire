import Foundation
import Observation

enum AppTab: Hashable { case schedule, activity, links, barbers, settings }

/// Where a tapped push leads: that booking's day on that chair. The notification's custom
/// keys are `event_id`, `kind`, `booking_id`, `barber_id` and `booking_date` (CONTRACT.md).
struct PushRoute: Equatable {
    let barberId: UUID
    let date: ShopDay

    init(barberId: UUID, date: ShopDay) {
        self.barberId = barberId
        self.date = date
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let barber = (userInfo["barber_id"] as? String).flatMap(UUID.init(uuidString:)),
              let day = (userInfo["booking_date"] as? String).flatMap(ShopDay.init(iso:)) else { return nil }
        self.init(barberId: barber, date: day)
    }
}

/// Session state shared by every screen: who is signed in, which chair is selected,
/// and the Activity badge.
@MainActor @Observable
final class AppModel {
    /// `offline`: signed in, but launch could not reach the server; it retries on Retry, on
    /// foregrounding and when the network comes back.
    enum Phase: Equatable { case starting, offline, signedOut, changePassword, ready }

    /// What a failed launch leads to. Only a session that is gone or a login with no access
    /// signs out; anything else keeps the session and waits for a retry.
    enum LaunchOutcome: Equatable { case signIn(notice: String), offline(BackendError) }

    let backend: Backend
    let clock: ShopClock
    let pushEnvironment: String
    /// The mock never asks for notification permission (it would block UI tests).
    let usesPush: Bool

    var phase: Phase = .starting
    var me: Me?
    var email: String?
    var selectedChairId: UUID?
    var unreadCount = 0
    var tab: AppTab = .schedule
    /// Why the last session ended, shown on the sign-in screen.
    var signInNotice: String?
    /// The day a tapped push asked for; the Schedule tab shows it, then clears it.
    var requestedDay: ShopDay?
    private var pendingRoute: PushRoute?
    private(set) var deviceToken: String?
    /// Why the last launch attempt failed while `phase == .offline`.
    private(set) var launchError: BackendError?
    private(set) var retrying = false
    /// Goes up after a push arrives while the app is open, so the lists on screen reload.
    private(set) var pushCount = 0
    @ObservationIgnored private var meLoads = LoadGeneration()
    @ObservationIgnored private var unreadLoads = LoadGeneration()
    /// The notification switches as last saved, the send queued last, and how many switch
    /// changes there have been (a refresh that overlaps one keeps the switches as they are).
    @ObservationIgnored private var savedPrefs: (Bool, Bool, Bool)?
    @ObservationIgnored private var prefsSend: Task<Void, Error>?
    @ObservationIgnored private var prefsEdits = 0
    @ObservationIgnored private var networkUp: Bool?

    init(backend: Backend, clock: ShopClock = .system, pushEnvironment: String = "sandbox", usesPush: Bool = false) {
        self.backend = backend
        self.clock = clock
        self.pushEnvironment = pushEnvironment
        self.usesPush = usesPush
    }

    var chairs: [Chair] { me?.chairs ?? [] }
    var selectedChair: Chair? { chairs.first { $0.id == selectedChairId } ?? chairs.first }
    var manageableChairs: [Chair] { chairs.filter(\.canManage) }
    var isManager: Bool { me?.isManager ?? false }

    func start() async {
        do {
            guard try await backend.restoreSession() else {
                phase = .signedOut
                return
            }
            try await loadMe()
            launchError = nil
        } catch {
            switch Self.launchOutcome(for: error) {
            case .signIn(let notice):
                await endSession()
                signInNotice = notice
            case .offline(let e):
                launchError = e
                phase = .offline
            }
        }
    }

    nonisolated static func launchOutcome(for error: Error) -> LaunchOutcome {
        let e = error as? BackendError ?? SupabaseBackend.mapError(error)
        switch e {
        case .notSignedIn, .noAccess: return .signIn(notice: e.message)
        default: return .offline(e)
        }
    }

    /// Retry, foregrounding, or the network coming back while launch is waiting for the server.
    func retryLaunch() async {
        guard phase == .offline, !retrying else { return }
        retrying = true
        await start()
        retrying = false
    }

    func signIn(email: String, password: String) async throws {
        signInNotice = nil
        try await backend.signIn(email: email, password: password)
        try await loadMe()
    }

    private func loadMe() async throws {
        let generation = meLoads.next()
        let edits = prefsEdits
        var me: Me
        do {
            me = try await backend.me()
        } catch BackendError.noAccess {
            // Signed in, but no staff row, a disabled login, or an inactive chair.
            await endSession()
            signInNotice = BackendError.noAccess.message
            throw BackendError.noAccess
        }
        guard meLoads.isCurrent(generation) else { return }   // a newer refresh answers instead
        if edits != prefsEdits, let current = self.me {
            me.notifyBookings = current.notifyBookings
            me.notifyCancellations = current.notifyCancellations
            me.notifyViewedChairs = current.notifyViewedChairs
        } else {
            savedPrefs = (me.notifyBookings, me.notifyCancellations, me.notifyViewedChairs)
        }
        self.me = me
        email = await backend.currentEmail()
        if selectedChairId == nil || !me.chairs.contains(where: { $0.id == selectedChairId }) {
            selectedChairId = me.chairs.first?.id
        }
        phase = me.mustChangePassword ? .changePassword : .ready
        if phase == .ready {
            if let route = pendingRoute { open(route) }
            await refreshUnread()
        }
    }

    /// A tapped push: that chair's Schedule on that day. Waits for sign-in when needed.
    func open(_ route: PushRoute) {
        guard phase == .ready, let me else {
            pendingRoute = route
            return
        }
        pendingRoute = nil
        if me.chairs.contains(where: { $0.id == route.barberId }) { selectedChairId = route.barberId }
        requestedDay = route.date
        tab = .schedule
    }

    func changePassword(_ password: String) async throws {
        try await backend.changePassword(password)
        me?.mustChangePassword = false
        phase = .ready
        if let route = pendingRoute { open(route) }
        await refreshUnread()
    }

    /// Launch, foreground, and after a push: who I am, my chairs, the badge.
    func refresh() async {
        if phase == .offline { return await retryLaunch() }
        guard phase == .ready else { return }
        do {
            try await loadMe()
        } catch {
            _ = handle(error)
        }
    }

    /// The network came back (not the first report at launch): retry or refresh.
    func networkChanged(isUp: Bool) async {
        let cameBack = isUp && networkUp == false
        networkUp = isUp
        if cameBack { await refresh() }
    }

    /// A push while the app is open: the badge, then whatever list is on screen.
    func pushReceived() async {
        await refresh()
        pushCount += 1
    }

    func refreshUnread() async {
        let generation = unreadLoads.next()
        guard let events = try? await backend.activity(before: nil, limit: 50), unreadLoads.isCurrent(generation) else { return }
        unreadCount = events.filter(\.isUnread).count
    }

    func markActivitySeen() async {
        let generation = unreadLoads.next()
        guard (try? await backend.markActivitySeen()) != nil, unreadLoads.isCurrent(generation) else { return }
        unreadCount = 0
    }

    /// Activity marks itself seen only while it is the tab on screen in the foreground; a
    /// refresh of the hidden tab (foregrounding, the timer, a push) leaves the badge alone.
    nonisolated static func marksActivitySeen(tab: AppTab, isActive: Bool, page: [ActivityEvent], unreadCount: Int) -> Bool {
        tab == .activity && isActive && (page.contains(where: \.isUnread) || unreadCount > 0)
    }

    func signOut() async {
        if let token = deviceToken { try? await backend.unregisterDevice(token: token) }
        await endSession()
    }

    private func endSession() async {
        try? await backend.signOut()
        me = nil
        email = nil
        selectedChairId = nil
        unreadCount = 0
        tab = .schedule
        requestedDay = nil
        phase = .signedOut
    }

    /// The message to show for a failed call; a lost session sends the user back to sign-in.
    func handle(_ error: Error) -> String {
        let e = error as? BackendError ?? SupabaseBackend.mapError(error)
        if e == .notSignedIn {
            me = nil
            phase = .signedOut
        }
        return e.message
    }

    /// The switch moves at once. Sends wait for the one before, and each sends all three switches
    /// as they are when it goes out, so quick taps never store an older value. When the last
    /// send fails the switches go back to what is saved.
    @discardableResult
    func setNotifyPref(_ key: WritableKeyPath<Me, Bool>, _ on: Bool) -> Task<Void, Error> {
        me?[keyPath: key] = on
        prefsEdits += 1
        let edit = prefsEdits
        let previous = prefsSend
        let send = Task { @MainActor [backend] in
            _ = await previous?.result
            guard let me = self.me else { return }
            let prefs = (me.notifyBookings, me.notifyCancellations, me.notifyViewedChairs)
            do {
                try await backend.setNotifyPrefs(bookings: prefs.0, cancellations: prefs.1, viewedChairs: prefs.2)
                self.savedPrefs = prefs
            } catch {
                if edit == self.prefsEdits, let saved = self.savedPrefs {
                    self.me?.notifyBookings = saved.0
                    self.me?.notifyCancellations = saved.1
                    self.me?.notifyViewedChairs = saved.2
                }
                throw error
            }
        }
        prefsSend = send
        return send
    }

    func deviceTokenReceived(_ token: Data) async {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        guard phase == .ready else { return }
        try? await backend.registerDevice(token: hex, environment: pushEnvironment)
    }
}

/// Overlapping loads (the timer, foregrounding, pull-to-refresh, an action's follow-up) can
/// finish out of order. Each load takes the next number and applies its result only if no
/// newer load started meanwhile, so an action's own follow-up always beats the loads before it.
struct LoadGeneration {
    private(set) var current = 0

    mutating func next() -> Int {
        current += 1
        return current
    }

    func isCurrent(_ generation: Int) -> Bool { generation == current }
}
