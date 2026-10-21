import Supabase
import XCTest
@testable import FadeEmpire

/// Launch on a weak network, push routing and environment, the Activity badge, day-off reasons.
@MainActor
final class LaunchAndPushTests: XCTestCase {
    // MARK: - Launch

    func testLaunchOutcomeForEachError() {
        let signIn = { (e: BackendError) in AppModel.LaunchOutcome.signIn(notice: e.message) }
        XCTAssertEqual(AppModel.launchOutcome(for: BackendError.notSignedIn), signIn(.notSignedIn))
        XCTAssertEqual(AppModel.launchOutcome(for: BackendError.noAccess), signIn(.noAccess))
        XCTAssertEqual(AppModel.launchOutcome(for: AuthError.sessionMissing), signIn(.notSignedIn))
        XCTAssertEqual(AppModel.launchOutcome(for: PostgrestError(code: "PGRST301", message: "JWT expired")), signIn(.notSignedIn))
        XCTAssertEqual(AppModel.launchOutcome(for: URLError(.notConnectedToInternet)), .offline(.network))
        XCTAssertEqual(AppModel.launchOutcome(for: URLError(.timedOut)), .offline(.network))
        XCTAssertEqual(AppModel.launchOutcome(for: BackendError.network), .offline(.network))
        XCTAssertEqual(AppModel.launchOutcome(for: BackendError.server("unexpected_response")), .offline(.server("unexpected_response")))
        XCTAssertEqual(AppModel.launchOutcome(for: FunctionsError.httpError(code: 503, data: Data())), .offline(.server("staff-admin 503")))
    }

    func testNetworkFailureAtLaunchKeepsTheSession() async {
        let backend = MockBackend(clock: .fixed(pinnedNow), signedInAs: "hassan@local.test",
                                  faults: [.me: MockBackend.Fault(error: .network, times: 2)])
        let app = AppModel(backend: backend, clock: .fixed(pinnedNow))
        await app.start()
        XCTAssertEqual(app.phase, .offline)
        XCTAssertEqual(app.launchError, .network)
        XCTAssertNil(app.signInNotice)
        let session = try? await backend.restoreSession()
        XCTAssertEqual(session, true, "still signed in")
        await app.retryLaunch()
        XCTAssertEqual(app.phase, .offline, "the second try fails too")
        await app.networkChanged(isUp: false)
        await app.networkChanged(isUp: true)   // the network comes back: tries again
        XCTAssertEqual(app.phase, .ready)
        XCTAssertEqual(app.me?.displayName, "Hassan")
        XCTAssertNil(app.launchError)
    }

    func testForegroundRetriesOfflineLaunch() async {
        let backend = MockBackend(clock: .fixed(pinnedNow), signedInAs: "hassan@local.test",
                                  faults: [.restoreSession: MockBackend.Fault(error: .server("internal"))])
        let app = AppModel(backend: backend, clock: .fixed(pinnedNow))
        await app.start()
        XCTAssertEqual(app.phase, .offline)
        XCTAssertEqual(app.launchError, .server("internal"))
        await app.refresh()   // what foregrounding calls
        XCTAssertEqual(app.phase, .ready)
    }

    func testFirstNetworkReportDoesNotRetry() async {
        let backend = MockBackend(clock: .fixed(pinnedNow), signedInAs: "hassan@local.test",
                                  faults: [.me: MockBackend.Fault(error: .network)])
        let app = AppModel(backend: backend, clock: .fixed(pinnedNow))
        await app.start()
        await app.networkChanged(isUp: true)
        XCTAssertEqual(app.phase, .offline, "only a network that comes back retries")
    }

    func testInvalidSessionAtLaunchSignsOutWithNotice() async {
        let backend = MockBackend(clock: .fixed(pinnedNow), signedInAs: "hassan@local.test",
                                  faults: [.restoreSession: MockBackend.Fault(error: .notSignedIn)])
        let app = AppModel(backend: backend, clock: .fixed(pinnedNow))
        await app.start()
        XCTAssertEqual(app.phase, .signedOut)
        XCTAssertEqual(app.signInNotice, BackendError.notSignedIn.message)
    }

    func testNoAccessAtLaunchSignsOutWithNotice() async throws {
        let backend = mock(as: "ali@local.test")
        _ = try await backend.setActive(barberId: MockSeed.larryId, active: false)
        try await backend.signOut()
        try await backend.signIn(email: "larry@local.test", password: MockSeed.password)
        let app = AppModel(backend: backend, clock: .fixed(pinnedNow))
        await app.start()
        XCTAssertEqual(app.phase, .signedOut)
        XCTAssertEqual(app.signInNotice, BackendError.noAccess.message)
    }

    func testNoStoredSessionGoesToSignInQuietly() async {
        let app = AppModel(backend: mock(), clock: .fixed(pinnedNow))
        await app.start()
        XCTAssertEqual(app.phase, .signedOut)
        XCTAssertNil(app.signInNotice)
    }

    func testMockFaultLaunchArgument() {
        let faults = LaunchOptions.parseFaults("me:network:1,barberSchedule:network:*,links:internal")
        XCTAssertEqual(faults[.me]?.error, .network)
        XCTAssertEqual(faults[.me]?.times, 1)
        XCTAssertNotNil(faults[.barberSchedule])
        XCTAssertNil(faults[.barberSchedule]!.times, "every call")
        XCTAssertEqual(faults[.links]?.error, .server("internal"))
        XCTAssertEqual(faults[.links]?.times, 1)
    }

    // MARK: - Push

    func testColdLaunchPushWaitsForHandler() {
        let delegate = AppDelegate()
        let route = PushRoute(barberId: MockSeed.larryId, date: ShopDay(iso: "2026-10-23")!)
        delegate.open(route)
        var opened: [PushRoute] = []
        delegate.onOpen = { opened.append($0) }
        XCTAssertEqual(opened, [route], "delivered once the root view installs the handler")
        delegate.onOpen = { opened.append($0) }
        XCTAssertEqual(opened, [route], "and only once")
        let later = PushRoute(barberId: MockSeed.hassanId, date: ShopDay(iso: "2026-10-24")!)
        delegate.open(later)
        XCTAssertEqual(opened, [route, later])
    }

    func testPushWhileOpenReloadsLists() async {
        let app = AppModel(backend: mock(as: "hassan@local.test"), clock: .fixed(pinnedNow))
        await app.start()
        XCTAssertEqual(app.pushCount, 0)
        await app.pushReceived()
        XCTAssertEqual(app.pushCount, 1, "every list on screen reloads on this")
    }

    /// A provisioning profile: a signed envelope with the plist inside.
    private func profile(aps: String?) -> Data {
        let entitlements = aps.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>Name</key><string>FE</string><key>Entitlements</key><dict>\(entitlements)</dict></dict></plist>
        """
        return Data([0x30, 0x82, 0x1F, 0x00, 0x06, 0x09]) + Data(plist.utf8) + Data([0xA0, 0x82, 0x0D, 0x00])
    }

    func testPushEnvironmentFollowsTheProfile() {
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: profile(aps: "development")), "sandbox",
                       "a Release build run from Xcode is signed for development")
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: profile(aps: "production")), "production", "ad hoc")
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: nil), "production", "App Store and TestFlight carry no profile")
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: profile(aps: nil)), "sandbox")
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: Data([0x01, 0x02])), "sandbox")
        XCTAssertEqual(PushEnvironment.current(), "sandbox", "the simulator")
    }

    // MARK: - Activity badge

    func testActivityMarksSeenOnlyWhenOnScreen() {
        let unread = ActivityEvent(eventId: 1, kind: .booked, actor: "customer", occurredAt: Instant(pinnedNow),
                                   bookingId: UUID(), barberId: MockSeed.hassanId, barberSlug: "hassan", barberName: "Hassan",
                                   customerName: "Tyler", date: ShopDay(iso: "2026-10-22")!, time: ShopTime(hour: 16),
                                   serviceName: "Hair Cut", isUnread: true)
        XCTAssertTrue(AppModel.marksActivitySeen(tab: .activity, isActive: true, page: [unread], unreadCount: 1))
        XCTAssertFalse(AppModel.marksActivitySeen(tab: .schedule, isActive: true, page: [unread], unreadCount: 1),
                       "a hidden Activity tab refreshing on foreground leaves the badge")
        XCTAssertFalse(AppModel.marksActivitySeen(tab: .activity, isActive: false, page: [unread], unreadCount: 1),
                       "in the background")
        XCTAssertFalse(AppModel.marksActivitySeen(tab: .activity, isActive: true, page: [], unreadCount: 0), "nothing to mark")
    }

    // MARK: - Day-off reasons

    func testViewOnlyChairShowsNoReason() async {
        let app = AppModel(backend: mock(as: "hassan@local.test"), clock: .fixed(pinnedNow))
        await app.start()
        let schedule = ScheduleModel(app: app)
        await schedule.selectChair(MockSeed.larryId)
        let wednesday = ShopDay(iso: "2026-10-28")!
        XCTAssertEqual(schedule.status(of: wednesday), .dayOff(reason: nil))
        XCTAssertEqual(schedule.status(of: wednesday).label, "Day off")
    }

    func testOwnChairShowsReason() async {
        let app = AppModel(backend: mock(as: "larry@local.test"), clock: .fixed(pinnedNow))
        await app.start()
        let schedule = ScheduleModel(app: app)
        await schedule.load()
        XCTAssertEqual(schedule.status(of: ShopDay(iso: "2026-10-28")!).label, "Day off · Family event")
    }

    func testReasonPresentOrNull() {
        let day = ShopDay(iso: "2026-10-28")!
        let withReason = DayOff(date: day, reason: "Family event", bookingsThatDay: 0)
        let without = DayOff(date: day, reason: nil, bookingsThatDay: 0)
        XCTAssertEqual(ScheduleModel.visibleReason(withReason, canManage: true), "Family event")
        XCTAssertNil(ScheduleModel.visibleReason(withReason, canManage: false))
        XCTAssertNil(ScheduleModel.visibleReason(without, canManage: true))
        XCTAssertNil(ScheduleModel.visibleReason(without, canManage: false))
        XCTAssertEqual(DayStatus.dayOff(reason: nil).label, "Day off")
    }
}
