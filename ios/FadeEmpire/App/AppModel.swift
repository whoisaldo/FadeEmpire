import Foundation
import Observation

enum AppTab: Hashable { case schedule, activity, links, barbers, settings }

/// Session state shared by every screen: who is signed in, which chair is selected,
/// and the Activity badge.
@MainActor @Observable
final class AppModel {
    enum Phase: Equatable { case starting, signedOut, changePassword, ready }

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
    private(set) var deviceToken: String?

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
        guard await backend.restoreSession() else {
            phase = .signedOut
            return
        }
        do { try await loadMe() } catch { phase = .signedOut }
    }

    func signIn(email: String, password: String) async throws {
        try await backend.signIn(email: email, password: password)
        try await loadMe()
    }

    private func loadMe() async throws {
        let me = try await backend.me()
        self.me = me
        email = await backend.currentEmail()
        if selectedChairId == nil || !me.chairs.contains(where: { $0.id == selectedChairId }) {
            selectedChairId = me.chairs.first?.id
        }
        phase = me.mustChangePassword ? .changePassword : .ready
        if phase == .ready { await refreshUnread() }
    }

    func changePassword(_ password: String) async throws {
        try await backend.changePassword(password)
        me?.mustChangePassword = false
        phase = .ready
        await refreshUnread()
    }

    /// Launch, foreground, and after a push: who I am, my chairs, the badge.
    func refresh() async {
        guard phase == .ready else { return }
        do {
            try await loadMe()
        } catch {
            _ = handle(error)
        }
    }

    func refreshUnread() async {
        guard let events = try? await backend.activity(before: nil, limit: 50) else { return }
        unreadCount = events.filter(\.isUnread).count
    }

    func markActivitySeen() async {
        guard (try? await backend.markActivitySeen()) != nil else { return }
        unreadCount = 0
    }

    func signOut() async {
        if let token = deviceToken { try? await backend.unregisterDevice(token: token) }
        try? await backend.signOut()
        me = nil
        email = nil
        selectedChairId = nil
        unreadCount = 0
        tab = .schedule
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

    func setNotifyPrefs(bookings: Bool, cancellations: Bool, viewedChairs: Bool) async throws {
        try await backend.setNotifyPrefs(bookings: bookings, cancellations: cancellations, viewedChairs: viewedChairs)
        me?.notifyBookings = bookings
        me?.notifyCancellations = cancellations
        me?.notifyViewedChairs = viewedChairs
    }

    func deviceTokenReceived(_ token: Data) async {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        guard phase == .ready else { return }
        try? await backend.registerDevice(token: hex, environment: pushEnvironment)
    }
}
