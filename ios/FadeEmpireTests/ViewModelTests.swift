import XCTest
@testable import FadeEmpire

@MainActor
final class ViewModelTests: XCTestCase {
    private func signedIn(_ email: String) async -> AppModel {
        let app = AppModel(backend: mock(as: email), clock: .fixed(pinnedNow))
        await app.start()
        return app
    }

    func testChairSwitching() async {
        let app = await signedIn("hassan@local.test")
        let schedule = ScheduleModel(app: app)
        await schedule.load()
        XCTAssertTrue(schedule.showsChairSwitcher)
        XCTAssertEqual(schedule.chair?.slug, "hassan")
        XCTAssertFalse(schedule.isViewOnly)
        XCTAssertTrue(schedule.canAddAppointment)
        XCTAssertTrue(schedule.bookings.allSatisfy { $0.barberSlug == "hassan" })

        await schedule.selectChair(MockSeed.larryId)
        XCTAssertEqual(schedule.chair?.slug, "larry")
        XCTAssertEqual(app.selectedChairId, MockSeed.larryId, "the choice is shared with Days off and Links")
        XCTAssertTrue(schedule.isViewOnly)
        XCTAssertFalse(schedule.canAddAppointment)
        XCTAssertFalse(schedule.bookings.isEmpty)
        XCTAssertTrue(schedule.bookings.allSatisfy { $0.barberSlug == "larry" })
    }

    func testViewOnlyChairsExposeNoActions() async {
        let app = await signedIn("hassan@local.test")
        let schedule = ScheduleModel(app: app)
        await schedule.selectChair(MockSeed.larryId)
        for booking in schedule.bookings {
            XCTAssertEqual(ScheduleModel.actions(for: booking), [], booking.customerName)
        }
    }

    func testOwnChairActionsFollowStatus() async {
        let app = await signedIn("hassan@local.test")
        let schedule = ScheduleModel(app: app)
        await schedule.load()
        let day = schedule.bookings(on: schedule.today)
        let noShow = day.first { $0.status == .noShow }!
        let cancelled = day.first { $0.status == .cancelled }!
        let confirmed = day.first { $0.status == .confirmed }!
        XCTAssertEqual(ScheduleModel.actions(for: noShow), [.undoNoShow])
        XCTAssertEqual(ScheduleModel.actions(for: cancelled), [])
        XCTAssertEqual(ScheduleModel.actions(for: confirmed), [.cancel, .markNoShow])
        XCTAssertEqual(schedule.activeCount(on: schedule.today), 4)
    }

    func testPartyMembers() async {
        let app = await signedIn("hassan@local.test")
        let schedule = ScheduleModel(app: app)
        await schedule.load()
        let jamal = schedule.bookings.first { $0.customerName == "Jamal Carter" }!
        XCTAssertEqual(schedule.partyMembers(of: jamal).map(\.customerName), ["Ezra Carter"])
    }

    func testDayStatus() async {
        let app = await signedIn("hassan@local.test")
        let schedule = ScheduleModel(app: app)
        await schedule.selectChair(MockSeed.larryId)
        XCTAssertEqual(schedule.status(of: ShopDay(iso: "2026-10-27")!), .shopClosed)
        XCTAssertEqual(schedule.status(of: ShopDay(iso: "2026-10-28")!), .dayOff(reason: "Family event"))
        XCTAssertEqual(schedule.status(of: ShopDay(iso: "2026-10-22")!),
                       .open(OpenHours(open: ShopTime(hour: 10), close: ShopTime(hour: 18))))
    }

    func testUnreadBadge() async {
        let app = await signedIn("hassan@local.test")
        XCTAssertEqual(app.phase, .ready)
        XCTAssertEqual(app.unreadCount, 3)
        await app.markActivitySeen()
        XCTAssertEqual(app.unreadCount, 0)
        await app.refreshUnread()
        XCTAssertEqual(app.unreadCount, 0)
    }

    func testForcedPasswordPhase() async throws {
        let app = AppModel(backend: mock(), clock: .fixed(pinnedNow))
        await app.start()
        XCTAssertEqual(app.phase, .signedOut)
        try await app.signIn(email: "hassan@local.test", password: MockSeed.password)
        XCTAssertEqual(app.phase, .changePassword)
        try await app.changePassword("my-own-password")
        XCTAssertEqual(app.phase, .ready)
        await app.signOut()
        XCTAssertEqual(app.phase, .signedOut)
        XCTAssertNil(app.me)
    }

    func testLostSessionReturnsToSignIn() async {
        let app = await signedIn("larry@local.test")
        XCTAssertEqual(app.handle(BackendError.notSignedIn), BackendError.notSignedIn.message)
        XCTAssertEqual(app.phase, .signedOut)
    }

    func testHoursDraft() {
        let draft = HoursDraft.storeDefault
        XCTAssertEqual(draft.schedule.map(\.weekday), [0, 1, 3, 4, 5, 6])
        XCTAssertEqual(HoursDraft.choices(for: 1).first, ShopTime(hour: 10))
        XCTAssertEqual(HoursDraft.choices(for: 1).last, ShopTime(hour: 18))
        XCTAssertTrue(HoursDraft.choices(for: 2).isEmpty)
        XCTAssertTrue(HoursDraft.summary(draft.schedule).hasPrefix("Mon 10:00 AM–6:00 PM"))
    }
}
