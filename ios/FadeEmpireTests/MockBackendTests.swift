import XCTest
@testable import FadeEmpire

/// Thursday Oct 22, 2026, 1:00 PM at the shop: the day the UI tests and screenshots use.
let pinnedNow = ShopDay(iso: "2026-10-22")!.at(ShopTime(hour: 13))

func mock(as email: String? = nil) -> MockBackend {
    MockBackend(clock: .fixed(pinnedNow), signedInAs: email)
}

final class MockBackendTests: XCTestCase {
    let thursday = ShopDay(iso: "2026-10-22")!
    let hassan = MockSeed.hassanId
    let larry = MockSeed.larryId

    private func assertThrows(_ expected: BackendError, _ body: () async throws -> Void,
                              file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await body()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? BackendError, expected, file: file, line: line)
        }
    }

    func testSignInAndForcedPassword() async throws {
        let b = mock()
        await assertThrows(.invalidCredentials) { try await b.signIn(email: "hassan@local.test", password: "nope") }
        try await b.signIn(email: "Hassan@local.test", password: MockSeed.password)
        var me = try await b.me()
        XCTAssertTrue(me.mustChangePassword)
        await assertThrows(.weakPassword) { try await b.changePassword(MockSeed.password) }
        try await b.changePassword("a-new-password")
        me = try await b.me()
        XCTAssertFalse(me.mustChangePassword)
    }

    func testHassanSeesLarryViewOnly() async throws {
        let b = mock(as: "hassan@local.test")
        let me = try await b.me()
        XCTAssertEqual(me.chairs.map(\.slug), ["hassan", "larry"], "own chair first")
        XCTAssertEqual(me.chairs.map(\.canManage), [true, false])
        let larrys = try await b.bookings(barberId: larry, from: thursday, to: thursday.adding(days: 7))
        XCTAssertFalse(larrys.isEmpty)
        XCTAssertTrue(larrys.allSatisfy { !$0.canManage })
        let own = try await b.bookings(barberId: hassan, from: thursday, to: thursday)
        XCTAssertTrue(own.allSatisfy(\.canManage))
    }

    func testBarberCannotTouchOtherChairs() async throws {
        let b = mock(as: "hassan@local.test")
        let target = try await b.bookings(barberId: larry, from: thursday, to: thursday)[0]
        await assertThrows(.forbidden) { _ = try await b.cancelBooking(id: target.id) }
        await assertThrows(.forbidden) { try await b.setStatus(bookingId: target.id, status: .noShow) }
        await assertThrows(.forbidden) { _ = try await b.addDayOff(barberId: self.larry, date: self.thursday.adding(days: 2), reason: nil) }
        await assertThrows(.forbidden) { _ = try await b.links(barberId: self.larry) }
        await assertThrows(.forbidden) {
            _ = try await b.book(NewBooking(barberId: self.larry, serviceSlug: "hair-cut", date: self.thursday.adding(days: 1),
                                            time: ShopTime(hour: 10), customerName: "Test", customerPhone: "4135550100",
                                            addonSlugs: [], notes: nil))
        }
        await assertThrows(.forbidden) { _ = try await b.barbers() }
        await assertThrows(.forbidden) { _ = try await b.createLogin(email: "x@y.z", displayName: "X", role: .barber, barberId: self.hassan) }
    }

    func testLarryHasNoGrantOnHassan() async throws {
        let b = mock(as: "larry@local.test")
        let me = try await b.me()
        XCTAssertEqual(me.chairs.map(\.slug), ["larry"])
        await assertThrows(.forbidden) { _ = try await b.bookings(barberId: self.hassan, from: self.thursday, to: self.thursday) }
    }

    func testManagerCanDoEverything() async throws {
        let b = mock(as: "ali@local.test")
        let me = try await b.me()
        XCTAssertEqual(me.chairs.map(\.slug), ["hassan", "larry", "javier"], "every barber, inactive included")
        XCTAssertTrue(me.chairs.allSatisfy(\.canManage))
        let target = try await b.bookings(barberId: larry, from: thursday, to: thursday).first { $0.status.isActive }!
        let cancelled = try await b.cancelBooking(id: target.id)
        XCTAssertEqual(cancelled.customerName, target.customerName)
        let after = try await b.bookings(barberId: larry, from: thursday, to: thursday).first { $0.id == target.id }!
        XCTAssertEqual(after.status, .cancelled)
        XCTAssertEqual(after.cancelledBy, "manager")
        let count = try await b.setActive(barberId: larry, active: false)
        XCTAssertGreaterThan(count, 0)
    }

    func testDeactivatedBarberSeesNothing() async throws {
        let b = mock(as: "ali@local.test")
        _ = try await b.setActive(barberId: hassan, active: false)
        try await b.signOut()
        try await b.signIn(email: "hassan@local.test", password: MockSeed.password)
        let me = try await b.me()
        XCTAssertTrue(me.chairs.isEmpty)
        XCTAssertNil(me.barberId)
        await assertThrows(.forbidden) { _ = try await b.bookings(barberId: self.hassan, from: self.thursday, to: self.thursday) }
    }

    func testDisabledLoginCannotSignIn() async throws {
        let b = mock(as: "ali@local.test")
        let larryLogin = try await b.staff().first { $0.email == "larry@local.test" }!
        try await b.setLoginDisabled(userId: larryLogin.userId, disabled: true)
        try await b.signOut()
        await assertThrows(.invalidCredentials) { try await b.signIn(email: "larry@local.test", password: MockSeed.password) }
    }

    func testFreeSlotsAndBooking() async throws {
        let b = mock(as: "hassan@local.test")
        // After 1 PM: 1:45, then 4:00 (Luis cancelled), then 5:30. 2:30, 3:15 and 4:45 are booked.
        let slots = try await b.freeSlots(barberId: hassan, date: thursday)
        XCTAssertEqual(slots.map(\.hhmm), ["13:45", "16:00", "17:30"])
        let tuesday = try await b.freeSlots(barberId: hassan, date: ShopDay(iso: "2026-10-27")!)
        XCTAssertTrue(tuesday.isEmpty, "shop closed Tuesdays")
        let request = NewBooking(barberId: hassan, serviceSlug: "hair-cut", date: thursday, time: ShopTime(hour: 13, minute: 45),
                                 customerName: "Walk In", customerPhone: "(413) 555-0199", addonSlugs: ["hot-towel"], notes: nil)
        _ = try await b.book(request)
        await assertThrows(.slotTaken) { _ = try await b.book(request) }
        var offGrid = request
        offGrid.time = ShopTime(hour: 14)
        await assertThrows(.invalidSlot) { _ = try await b.book(offGrid) }
        var shortPhone = request
        shortPhone.customerPhone = "555"
        await assertThrows(.invalidPhone) { _ = try await b.book(shortPhone) }
    }

    func testDaysOffCountBookings() async throws {
        let b = mock(as: "hassan@local.test")
        let friday = thursday.adding(days: 1)
        let count = try await b.addDayOff(barberId: hassan, date: friday, reason: "Doctor")
        XCTAssertEqual(count, 3)
        await assertThrows(.dayOffExists) { _ = try await b.addDayOff(barberId: self.hassan, date: friday, reason: nil) }
        let off = try await b.daysOff(barberId: hassan)
        XCTAssertEqual(off.first { $0.date == friday }?.reason, "Doctor")
        let whileOff = try await b.freeSlots(barberId: hassan, date: friday)
        XCTAssertTrue(whileOff.isEmpty)
        try await b.removeDayOff(barberId: hassan, date: friday)
        let afterRemoval = try await b.freeSlots(barberId: hassan, date: friday)
        XCTAssertFalse(afterRemoval.isEmpty)
    }

    func testActivityUnreadSkipsOwnActions() async throws {
        let b = mock(as: "hassan@local.test")
        var events = try await b.activity(before: nil, limit: 50)
        XCTAssertEqual(events.filter(\.isUnread).count, 3)
        XCTAssertFalse(events.first { $0.kind == .noShow }!.isUnread, "Hassan marked it himself")
        let own = try await b.bookings(barberId: hassan, from: thursday, to: thursday).first { $0.status.isActive }!
        _ = try await b.cancelBooking(id: own.id)
        events = try await b.activity(before: nil, limit: 50)
        XCTAssertEqual(events.first?.kind, .cancelled)
        XCTAssertFalse(events.first!.isUnread)
        try await b.markActivitySeen()
        events = try await b.activity(before: nil, limit: 50)
        XCTAssertEqual(events.filter(\.isUnread).count, 0)
        let older = try await b.activity(before: events[1].eventId, limit: 2)
        XCTAssertEqual(older.map(\.eventId), [events[2].eventId, events[3].eventId])
    }

    func testManagerBarberRules() async throws {
        let b = mock(as: "ali@local.test")
        await assertThrows(.slugTaken) {
            _ = try await b.saveBarber(BarberDraft(id: nil, slug: "larry", displayName: "Other", title: "", bio: "", photoUrl: nil))
        }
        await assertThrows(.slugLocked) {
            _ = try await b.saveBarber(BarberDraft(id: self.larry, slug: "lawrence", displayName: "Larry", title: "Barber", bio: "", photoUrl: nil))
        }
        let id = try await b.saveBarber(BarberDraft(id: nil, slug: "marco", displayName: "Marco", title: "Barber", bio: "", photoUrl: nil))
        let rows = try await b.barbers()
        XCTAssertEqual(rows.last?.id, id, "new barbers go after the last one")
        await assertThrows(.outsideStoreHours) {
            try await b.setSchedule(barberId: id, days: [ScheduleDay(weekday: 2, open: ShopTime(hour: 10), close: ShopTime(hour: 18))])
        }
        await assertThrows(.outsideStoreHours) {
            try await b.setSchedule(barberId: id, days: [ScheduleDay(weekday: 1, open: ShopTime(hour: 9), close: ShopTime(hour: 18))])
        }
        try await b.setSchedule(barberId: id, days: [ScheduleDay(weekday: 1, open: ShopTime(hour: 12), close: ShopTime(hour: 18))])
        let login = try await b.createLogin(email: "marco@local.test", displayName: "Marco", role: .barber, barberId: id)
        XCTAssertNotNil(login.temporaryPassword.range(of: #"^([a-z]+-){4}\d{2}$"#, options: .regularExpression))
        await assertThrows(.loginExists) { _ = try await b.createLogin(email: "m2@local.test", displayName: "M", role: .barber, barberId: id) }
        await assertThrows(.emailTaken) { _ = try await b.createLogin(email: "marco@local.test", displayName: "M", role: .manager, barberId: nil) }
        try await b.setViewGrant(viewer: id, barber: hassan, granted: true)
        try await b.signOut()
        try await b.signIn(email: "marco@local.test", password: login.temporaryPassword)
        let me = try await b.me()
        XCTAssertTrue(me.mustChangePassword)
        XCTAssertEqual(me.chairs.map(\.slug), ["marco", "hassan"])
    }
}
