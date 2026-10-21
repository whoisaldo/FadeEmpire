import XCTest
@testable import FadeEmpire

/// Thursday Oct 22, 2026, 1:00 PM at the shop: the day the UI tests and screenshots use.
let pinnedNow = ShopDay(iso: "2026-10-22")!.at(ShopTime(hour: 13))

func mock(as email: String? = nil, mustChangePassword: Set<String> = []) -> MockBackend {
    MockBackend(clock: .fixed(pinnedNow), signedInAs: email, mustChangePassword: mustChangePassword)
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

    func testSeededLoginsHaveNoForcedChange() async throws {
        let b = mock()
        for email in ["ali@local.test", "hassan@local.test", "larry@local.test"] {
            try await b.signIn(email: email, password: MockSeed.password)
            let me = try await b.me()
            XCTAssertFalse(me.mustChangePassword, email)
        }
    }

    func testSignInAndForcedPassword() async throws {
        let b = mock(mustChangePassword: ["hassan@local.test"])
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
        XCTAssertTrue(larrys.allSatisfy { $0.customerPhone == nil }, "a view-only chair shows no phones")
        let own = try await b.bookings(barberId: hassan, from: thursday, to: thursday)
        XCTAssertTrue(own.allSatisfy(\.canManage))
        XCTAssertTrue(own.allSatisfy { $0.customerPhone != nil })
        await assertThrows(.invalidRange) {
            _ = try await b.bookings(barberId: self.hassan, from: self.thursday, to: self.thursday.adding(days: 63))
        }
        await assertThrows(.invalidRange) {
            _ = try await b.bookings(barberId: self.hassan, from: self.thursday, to: self.thursday.adding(days: -1))
        }
    }

    func testManagerHasNoChairOfTheirOwn() async throws {
        let me = try await mock(as: "ali@local.test").me()
        XCTAssertEqual(me.role, .manager)
        XCTAssertNil(me.barberId)
        XCTAssertNil(me.barberSlug)
    }

    func testBarberCannotTouchOtherChairs() async throws {
        let b = mock(as: "hassan@local.test")
        let target = try await b.bookings(barberId: larry, from: thursday, to: thursday)[0]
        await assertThrows(.forbidden) { _ = try await b.cancelBooking(id: target.id) }
        await assertThrows(.forbidden) { try await b.setStatus(bookingId: target.id, status: .noShow) }
        await assertThrows(.forbidden) { _ = try await b.addDayOff(barberId: self.larry, date: self.thursday.adding(days: 2), reason: nil) }
        let larryLinks = try await b.links(barberId: larry)
        XCTAssertTrue(larryLinks.isEmpty, "RLS: another chair's links read as none")
        await assertThrows(.forbidden) { _ = try await b.addLink(barberId: self.larry, label: "Mine now", serviceSlug: nil) }
        await assertThrows(.forbidden) { _ = try await b.setActive(barberId: self.larry, active: false) }
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
        // Larry's pending or confirmed bookings that have not started: 3:15 PM today and five later.
        let count = try await b.setActive(barberId: larry, active: false)
        XCTAssertEqual(count, 6)
        await assertThrows(.cannotDisableSelf) {
            let me = try await b.me()
            try await b.setLoginDisabled(userId: me.userId, disabled: true)
        }
    }

    func testDeactivatedBarberSeesNothing() async throws {
        let b = mock(as: "ali@local.test")
        _ = try await b.setActive(barberId: hassan, active: false)
        try await b.signOut()
        try await b.signIn(email: "hassan@local.test", password: MockSeed.password)
        await assertThrows(.noAccess) { _ = try await b.me() }
        await assertThrows(.forbidden) { _ = try await b.bookings(barberId: self.hassan, from: self.thursday, to: self.thursday) }
        await assertThrows(.forbidden) { _ = try await b.bookings(barberId: self.larry, from: self.thursday, to: self.thursday) }
        let events = try await b.activity(before: nil, limit: 50)
        XCTAssertTrue(events.isEmpty)
    }

    func testDisabledLoginCannotSignIn() async throws {
        let b = mock(as: "ali@local.test")
        let larryLogin = try await b.staff().first { $0.email == "larry@local.test" }!
        try await b.setLoginDisabled(userId: larryLogin.userId, disabled: true)
        try await b.signOut()
        await assertThrows(.invalidCredentials) { try await b.signIn(email: "larry@local.test", password: MockSeed.password) }
    }

    func testDisablingDropsDeviceTokens() async throws {
        let b = mock(as: "larry@local.test")
        try await b.registerDevice(token: "abc", environment: "sandbox")
        let larryId = try await b.me().userId
        try await b.signOut()
        try await b.signIn(email: "ali@local.test", password: MockSeed.password)
        try await b.setLoginDisabled(userId: larryId, disabled: true)
        let devices = await b.devices
        XCTAssertNil(devices["abc"])
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
        let count = try await b.addDayOff(barberId: hassan, date: friday, reason: "Dentist")
        XCTAssertEqual(count, 3)
        // Adding the same day again updates its reason.
        _ = try await b.addDayOff(barberId: hassan, date: friday, reason: "Doctor")
        let off = try await b.daysOff(barberId: hassan)
        XCTAssertEqual(off.filter { $0.date == friday }.map(\.reason), ["Doctor"])
        await assertThrows(.dateOutOfRange) { _ = try await b.addDayOff(barberId: self.hassan, date: self.thursday.adding(days: -1), reason: nil) }
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
        await assertThrows(.slugReserved) {
            _ = try await b.saveBarber(BarberDraft(id: nil, slug: "assets", displayName: "Assets", title: "", bio: "", photoUrl: nil))
        }
        await assertThrows(.invalidBarberName) {
            _ = try await b.saveBarber(BarberDraft(id: nil, slug: "nobody", displayName: "  ", title: "", bio: "", photoUrl: nil))
        }
        let id = try await b.saveBarber(BarberDraft(id: nil, slug: "Marco", displayName: "Marco", title: "Barber", bio: "", photoUrl: nil))
        let rows = try await b.barbers()
        XCTAssertEqual(rows.last?.id, id, "new barbers go after the last one")
        await assertThrows(.outsideStoreHours) {
            _ = try await b.setSchedule(barberId: id, days: [ScheduleDay(weekday: 2, open: ShopTime(hour: 10), close: ShopTime(hour: 18))])
        }
        await assertThrows(.outsideStoreHours) {
            _ = try await b.setSchedule(barberId: id, days: [ScheduleDay(weekday: 1, open: ShopTime(hour: 9), close: ShopTime(hour: 18))])
        }
        await assertThrows(.invalidSchedule) {
            _ = try await b.setSchedule(barberId: id, days: [ScheduleDay(weekday: 1, open: ShopTime(hour: 14), close: ShopTime(hour: 12))])
        }
        let stranded = try await b.setSchedule(barberId: id, days: [ScheduleDay(weekday: 1, open: ShopTime(hour: 12), close: ShopTime(hour: 18))])
        XCTAssertEqual(stranded, 0, "a new barber has no bookings")
        await assertThrows(.invalidGrant) { try await b.setViewGrant(viewer: id, barber: id, granted: true) }
        let login = try await b.createLogin(email: "marco@local.test", displayName: "Marco", role: .barber, barberId: id)
        XCTAssertNotNil(login.temporaryPassword.range(of: #"^([a-z]+-){4}\d{2}$"#, options: .regularExpression))
        await assertThrows(.barberHasLogin) { _ = try await b.createLogin(email: "m2@local.test", displayName: "M", role: .barber, barberId: id) }
        await assertThrows(.invalidDisplayName) { _ = try await b.createLogin(email: "m3@local.test", displayName: " ", role: .manager, barberId: nil) }
        await assertThrows(.emailTaken) { _ = try await b.createLogin(email: "marco@local.test", displayName: "M", role: .manager, barberId: nil) }
        try await b.setViewGrant(viewer: id, barber: hassan, granted: true)
        try await b.signOut()
        try await b.signIn(email: "marco@local.test", password: login.temporaryPassword)
        let me = try await b.me()
        XCTAssertTrue(me.mustChangePassword)
        XCTAssertEqual(me.chairs.map(\.slug), ["marco", "hassan"])
    }

    func testScheduleChangeCountsBookingsThatNoLongerFit() async throws {
        let b = mock(as: "ali@local.test")
        let week = try await b.barberSchedule(barberId: larry)
        // Friday off: Larry's two Friday bookings no longer fit.
        var n = try await b.setSchedule(barberId: larry, days: week.filter { $0.weekday != 5 })
        XCTAssertEqual(n, 2)
        // Back to the full week, but Thursday opening at 10:15: the rest of today's grid moves off
        // Malik Johnson's 3:15 PM; the 10:45 that already started does not count.
        n = try await b.setSchedule(barberId: larry, days: week.map {
            $0.weekday == 4 ? ScheduleDay(weekday: 4, open: ShopTime(hour: 10, minute: 15), close: $0.close) : $0
        })
        XCTAssertEqual(n, 1)
        n = try await b.setSchedule(barberId: larry, days: week)
        XCTAssertEqual(n, 0)
    }

    func testNoShowAndUndo() async throws {
        let b = mock(as: "hassan@local.test")
        let day = try await b.bookings(barberId: hassan, from: thursday, to: thursday)
        let noShow = day.first { $0.status == .noShow }!
        let cancelled = day.first { $0.status == .cancelled }!
        await assertThrows(.bookingNotActive) { _ = try await b.cancelBooking(id: noShow.id) }
        await assertThrows(.bookingNotActive) { try await b.setStatus(bookingId: cancelled.id, status: .noShow) }
        await assertThrows(.bookingNotActive) { try await b.setStatus(bookingId: cancelled.id, status: .confirmed) }
        await assertThrows(.bookingNotFound) { _ = try await b.cancelBooking(id: UUID()) }
        try await b.setStatus(bookingId: noShow.id, status: .confirmed)
        var events = try await b.activity(before: nil, limit: 200)
        XCTAssertFalse(events.contains { $0.bookingId == noShow.id && $0.kind == .noShow }, "undo deletes the no_show event")
        try await b.setStatus(bookingId: noShow.id, status: .noShow)
        events = try await b.activity(before: nil, limit: 200)
        XCTAssertEqual(events.first?.kind, .noShow)
        XCTAssertEqual(events.first?.bookingId, noShow.id)
    }
}
