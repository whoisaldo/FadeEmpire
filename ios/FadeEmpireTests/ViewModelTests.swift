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
        XCTAssertEqual(schedule.status(of: ShopDay(iso: "2026-10-28")!), .dayOff(reason: nil), "Larry's reason is his and Ali's")
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
        let app = AppModel(backend: mock(mustChangePassword: ["hassan@local.test"]), clock: .fixed(pinnedNow))
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

    func testNoAccessSignsOutAndSaysSo() async throws {
        let backend = mock(as: "ali@local.test")
        _ = try await backend.setActive(barberId: MockSeed.hassanId, active: false)
        try await backend.signOut()
        let app = AppModel(backend: backend, clock: .fixed(pinnedNow))
        await app.start()
        do {
            try await app.signIn(email: "hassan@local.test", password: MockSeed.password)
            XCTFail("an inactive chair's login has no access")
        } catch {
            XCTAssertEqual(error as? BackendError, .noAccess)
        }
        XCTAssertEqual(app.phase, .signedOut)
        XCTAssertNil(app.me)
        XCTAssertEqual(app.signInNotice, BackendError.noAccess.message)
        let session = try await backend.restoreSession()
        XCTAssertFalse(session, "the session is dropped, not left half signed in")
        try await app.signIn(email: "larry@local.test", password: MockSeed.password)
        XCTAssertEqual(app.phase, .ready)
        XCTAssertNil(app.signInNotice)
    }

    func testPushPayloadOpensThatDayOnThatChair() async {
        let payload: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "New booking", "body": "Marcus · Fri Oct 23, 10:45 AM · Line Up · Larry's chair"],
                    "thread-id": MockSeed.larryId.uuidString.lowercased()],
            "event_id": 42, "kind": "moved", "booking_id": UUID().uuidString.lowercased(),
            "barber_id": MockSeed.larryId.uuidString.lowercased(), "booking_date": "2026-10-23",
        ]
        let route = PushRoute(userInfo: payload)
        XCTAssertEqual(route, PushRoute(barberId: MockSeed.larryId, date: ShopDay(iso: "2026-10-23")!))
        XCTAssertNil(PushRoute(userInfo: ["kind": "booked"]))

        let app = await signedIn("hassan@local.test")
        let schedule = ScheduleModel(app: app)
        await schedule.load()
        app.tab = .activity
        app.open(route!)
        XCTAssertEqual(app.tab, .schedule)
        XCTAssertEqual(app.selectedChairId, MockSeed.larryId)
        await schedule.showRequestedDay()
        XCTAssertNil(app.requestedDay)
        XCTAssertEqual(schedule.selectedDay, ShopDay(iso: "2026-10-23"))
        XCTAssertTrue(schedule.isViewOnly)
        XCTAssertTrue(schedule.bookings.allSatisfy { $0.barberSlug == "larry" })
        XCTAssertTrue(schedule.bookings(on: schedule.selectedDay).contains { $0.customerName == "Ray Thompson" })
    }

    func testPushTappedBeforeSignInWaits() async throws {
        let app = AppModel(backend: mock(), clock: .fixed(pinnedNow))
        await app.start()
        app.open(PushRoute(barberId: MockSeed.larryId, date: ShopDay(iso: "2026-10-24")!))
        XCTAssertNil(app.requestedDay)
        try await app.signIn(email: "hassan@local.test", password: MockSeed.password)
        XCTAssertEqual(app.selectedChairId, MockSeed.larryId)
        XCTAssertEqual(app.requestedDay, ShopDay(iso: "2026-10-24"))
    }

    func testOutsideHoursNotice() {
        XCTAssertNil(BarbersModel.outsideHoursNotice(name: "Larry", count: 0))
        XCTAssertEqual(BarbersModel.outsideHoursNotice(name: "Larry", count: 1),
                       "1 upcoming appointment no longer fits Larry's hours. It's still booked: contact that customer.")
        XCTAssertEqual(BarbersModel.outsideHoursNotice(name: "Larry", count: 3),
                       "3 upcoming appointments no longer fit Larry's hours. They're still booked: contact those customers.")
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
