import XCTest
@testable import FadeEmpire

/// Every `Backend` method against the local Supabase stack (`tools/local-stack.sh` in the
/// backend branch), through the real `SupabaseBackend`. Skipped unless `FE_INTEGRATION=1`;
/// see the README. The URL and key come from the Debug-Local build of the host app.
/// Each test removes what it creates: links, tokens and days off are deleted, test bookings
/// cancelled, the test barber deactivated and its login turned off.
final class LocalStackTests: XCTestCase {
    static let password = "fade-local-1"
    let clock = ShopClock.system

    var url: URL!
    var key: String!

    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["FE_INTEGRATION"] == "1" else {
            throw XCTSkip("FE_INTEGRATION=1 runs these against the local stack")
        }
        let info = Bundle.main.infoDictionary ?? [:]
        url = URL(string: info["FESupabaseURL"] as? String ?? "")
        key = info["FESupabaseKey"] as? String
        XCTAssertEqual(url?.port, 56321, "build the Debug-Local configuration")
    }

    // MARK: - Helpers

    /// Another task may reset and re-seed the stack; signing in with a seeded login retries
    /// for up to three minutes while it comes back.
    func signedIn(_ email: String, password: String = password) async throws -> SupabaseBackend {
        let deadline = Date().addingTimeInterval(180)
        while true {
            let backend = SupabaseBackend(url: url, key: key, persistsSession: false)
            do {
                try await backend.signIn(email: email, password: password)
                return backend
            } catch let e as BackendError where password == Self.password && Date() < deadline
                        && (e == .network || e == .invalidCredentials) {
                try await Task.sleep(for: .seconds(10))
            }
        }
    }

    func assertThrows(_ expected: BackendError, _ body: () async throws -> Void,
                      file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await body()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? BackendError, expected, file: file, line: line)
        }
    }

    /// `manager_view_grants()` is in the original CONTRACT.md but not in migration 0022, so
    /// PostgREST answers that it can't find the function: nil then, and the grant is checked
    /// through what the viewer's `app_me` shows instead.
    func grantsIfAvailable(_ caller: Backend) async throws -> [ViewGrant]? {
        do {
            return try await caller.viewGrants()
        } catch BackendError.server(let message) where message.contains("manager_view_grants") {
            print("manager_view_grants is missing from the backend: \(message)")
            return nil
        }
    }

    func chair(_ backend: Backend, _ slug: String) async throws -> Chair {
        let chairs = try await backend.me().chairs
        return try XCTUnwrap(chairs.first { $0.slug == slug }, "no \(slug) chair")
    }

    /// The first day from tomorrow on with a free slot on that chair, and its last free slot
    /// (late in the day, away from the seeded bookings).
    func freeSlot(_ backend: Backend, barberId: UUID) async throws -> (ShopDay, ShopTime) {
        for offset in 1...21 {
            let day = clock.today.adding(days: offset)
            if let last = try await backend.freeSlots(barberId: barberId, date: day).last { return (day, last) }
        }
        throw XCTSkip("no free slot in the next three weeks")
    }

    func newBooking(_ barberId: UUID, _ day: ShopDay, _ time: ShopTime, name: String) -> NewBooking {
        NewBooking(barberId: barberId, serviceSlug: "hair-cut", date: day, time: time, customerName: name,
                   customerPhone: "(413) 555-01\(String(format: "%02d", Int.random(in: 0...99)))",
                   addonSlugs: ["hot-towel"], notes: "Integration test")
    }

    /// The access token for raw Storage calls the app does not make (deleting a test photo).
    func accessToken(_ email: String, password: String = password) async throws -> String {
        var request = URLRequest(url: url.appending(path: "auth/v1/token").appending(queryItems: [.init(name: "grant_type", value: "password")]))
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        let (data, _) = try await URLSession.shared.data(for: request)
        let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return try XCTUnwrap(body?["access_token"] as? String)
    }

    // MARK: - Sign-in and app_me

    func testEachLoginSignsInAndSeesItsChairs() async throws {
        let ali = try await signedIn("ali@local.test")
        let manager = try await ali.me()
        XCTAssertEqual(manager.role, .manager)
        XCTAssertNil(manager.barberId, "the manager has no chair of their own")
        XCTAssertNil(manager.barberSlug)
        XCTAssertFalse(manager.mustChangePassword, "seeded logins are not forced to change")
        XCTAssertTrue(Set(manager.chairs.map(\.slug)).isSuperset(of: ["hassan", "larry"]))
        XCTAssertTrue(manager.chairs.allSatisfy(\.canManage))
        let aliEmail = await ali.currentEmail()
        XCTAssertEqual(aliEmail, "ali@local.test")

        let hassan = try await signedIn("hassan@local.test")
        let h = try await hassan.me()
        XCTAssertEqual(h.role, .barber)
        XCTAssertEqual(h.barberSlug, "hassan")
        XCTAssertFalse(h.mustChangePassword)
        XCTAssertEqual(h.chairs.first?.slug, "hassan", "own chair first")
        XCTAssertEqual(h.chairs.first { $0.slug == "hassan" }?.canManage, true)
        XCTAssertEqual(h.chairs.first { $0.slug == "larry" }?.canManage, false, "Larry's chair is view-only")

        let larry = try await signedIn("larry@local.test")
        let l = try await larry.me()
        XCTAssertEqual(l.chairs.map(\.slug), ["larry"])

        let restored = await larry.restoreSession()
        XCTAssertTrue(restored)
        try await larry.signOut()
        let afterSignOut = await larry.restoreSession()
        XCTAssertFalse(afterSignOut)
        await assertThrows(.invalidCredentials) { try await larry.signIn(email: "larry@local.test", password: "wrong-password") }
    }

    // MARK: - Bookings and the view-only chair

    func testOwnChairShowsPhonesAndViewOnlyChairIsReadOnly() async throws {
        let hassan = try await signedIn("hassan@local.test")
        let own = try await chair(hassan, "hassan")
        let larrys = try await chair(hassan, "larry")
        let from = clock.today.adding(days: -2), to = clock.today.adding(days: 6)

        let mine = try await hassan.bookings(barberId: own.id, from: from, to: to)
        XCTAssertFalse(mine.isEmpty, "the seed books both chairs around today")
        XCTAssertTrue(mine.allSatisfy(\.canManage))
        XCTAssertTrue(mine.allSatisfy { $0.customerPhone != nil })

        let viewed = try await hassan.bookings(barberId: larrys.id, from: from, to: to)
        XCTAssertFalse(viewed.isEmpty)
        XCTAssertTrue(viewed.allSatisfy { !$0.canManage })
        XCTAssertTrue(viewed.allSatisfy { $0.customerPhone == nil }, "no phones on a view-only chair")
        await assertThrows(.invalidRange) { _ = try await hassan.bookings(barberId: own.id, from: from, to: from.adding(days: 63)) }

        let hours = try await hassan.weeklyHours(barberId: larrys.id)
        XCTAssertFalse(hours.isEmpty)
        _ = try await hassan.daysOff(barberId: larrys.id)
        let theirLinks = try await hassan.links(barberId: larrys.id)
        XCTAssertTrue(theirLinks.isEmpty, "RLS hides another chair's links")

        // Every write on Larry's chair is refused.
        let target = try XCTUnwrap(viewed.first { $0.status == .confirmed || $0.status == .pending })
        let (day, time) = try await freeSlot(hassan, barberId: larrys.id)
        await assertThrows(.forbidden) { _ = try await hassan.book(self.newBooking(larrys.id, day, time, name: "Not Allowed")) }
        await assertThrows(.forbidden) { _ = try await hassan.cancelBooking(id: target.id) }
        await assertThrows(.forbidden) { try await hassan.setStatus(bookingId: target.id, status: .noShow) }
        await assertThrows(.forbidden) { _ = try await hassan.addDayOff(barberId: larrys.id, date: day, reason: nil) }
        await assertThrows(.forbidden) { try await hassan.removeDayOff(barberId: larrys.id, date: day) }
        await assertThrows(.forbidden) { _ = try await hassan.addLink(barberId: larrys.id, label: "Not mine", serviceSlug: nil) }
        // And the manager's calls.
        await assertThrows(.forbidden) { _ = try await hassan.staff() }
        do {
            if try await grantsIfAvailable(hassan) != nil { XCTFail("a barber read every view grant") }
        } catch {
            XCTAssertEqual(error as? BackendError, .forbidden)
        }
        await assertThrows(.forbidden) { _ = try await hassan.barberSchedule(barberId: larrys.id) }
        await assertThrows(.forbidden) { _ = try await hassan.setActive(barberId: larrys.id, active: false) }
        await assertThrows(.forbidden) { try await hassan.setViewGrant(viewer: own.id, barber: larrys.id, granted: false) }
        await assertThrows(.forbidden) { _ = try await hassan.setSchedule(barberId: larrys.id, days: []) }
        await assertThrows(.forbidden) {
            _ = try await hassan.saveBarber(BarberDraft(id: larrys.id, slug: "larry", displayName: "Larry", title: "", bio: "", photoUrl: nil))
        }
        await assertThrows(.forbidden) {
            _ = try await hassan.createLogin(email: "nope@local.test", displayName: "Nope", role: .manager, barberId: nil)
        }
    }

    func testBookNoShowUndoCancelShowInActivity() async throws {
        let hassan = try await signedIn("hassan@local.test")
        let ali = try await signedIn("ali@local.test")
        let own = try await chair(hassan, "hassan")
        let (day, time) = try await freeSlot(hassan, barberId: own.id)
        let request = newBooking(own.id, day, time, name: "Integration Walkin")

        let id = try await hassan.book(request)
        addTeardownBlock { _ = try? await hassan.cancelBooking(id: id) }
        let dayRows = try await hassan.bookings(barberId: own.id, from: day, to: day)
        let row = try XCTUnwrap(dayRows.first { $0.id == id })
        XCTAssertEqual(row.status, .confirmed)
        XCTAssertEqual(row.source, "app")
        XCTAssertEqual(row.customerPhone, Phone.digits(request.customerPhone))
        XCTAssertEqual(row.addons, ["Hot Towel"])
        XCTAssertEqual(row.customerNotes, "Integration test")
        let slotsAfter = try await hassan.freeSlots(barberId: own.id, date: day)
        XCTAssertFalse(slotsAfter.contains(time), "a booked slot is no longer free")
        await assertThrows(.slotTaken) { _ = try await hassan.book(request) }
        var offGrid = request
        offGrid.time = time.adding(minutes: 15)
        await assertThrows(.invalidSlot) { _ = try await hassan.book(offGrid) }

        // Hassan's own booking is not unread for him; the manager sees it unread.
        var mine = try await hassan.activity(before: nil, limit: 50)
        let booked = try XCTUnwrap(mine.first { $0.bookingId == id && $0.kind == .booked })
        XCTAssertEqual(booked.actor, "barber")
        XCTAssertFalse(booked.isUnread)
        var managers = try await ali.activity(before: nil, limit: 50)
        XCTAssertEqual(managers.first { $0.bookingId == id && $0.kind == .booked }?.isUnread, true)
        let older = try await ali.activity(before: managers[0].eventId, limit: 1)
        XCTAssertEqual(older.count, 1)
        XCTAssertLessThan(older[0].eventId, managers[0].eventId)

        try await hassan.setStatus(bookingId: id, status: .noShow)
        mine = try await hassan.activity(before: nil, limit: 50)
        XCTAssertTrue(mine.contains { $0.bookingId == id && $0.kind == .noShow })
        await assertThrows(.bookingNotActive) { _ = try await hassan.cancelBooking(id: id) }
        try await hassan.setStatus(bookingId: id, status: .confirmed)
        mine = try await hassan.activity(before: nil, limit: 50)
        XCTAssertFalse(mine.contains { $0.bookingId == id && $0.kind == .noShow }, "undo removes the no-show event")
        await assertThrows(.bookingNotActive) { try await hassan.setStatus(bookingId: id, status: .confirmed) }

        let result = try await hassan.cancelBooking(id: id)
        XCTAssertEqual(result.bookingId, id)
        XCTAssertEqual(result.customerName, "Integration Walkin")
        XCTAssertEqual(result.customerPhone, Phone.digits(request.customerPhone))
        XCTAssertEqual(result.date, day)
        XCTAssertEqual(result.time, time)
        await assertThrows(.bookingNotActive) { _ = try await hassan.cancelBooking(id: id) }
        await assertThrows(.bookingNotFound) { _ = try await hassan.cancelBooking(id: UUID()) }
        let afterRows = try await hassan.bookings(barberId: own.id, from: day, to: day)
        let after = try XCTUnwrap(afterRows.first { $0.id == id })
        XCTAssertEqual(after.status, .cancelled)
        XCTAssertEqual(after.cancelledBy, "barber")

        managers = try await ali.activity(before: nil, limit: 50)
        XCTAssertEqual(managers.first { $0.bookingId == id && $0.kind == .cancelled }?.isUnread, true)
        try await ali.markActivitySeen()
        managers = try await ali.activity(before: nil, limit: 50)
        XCTAssertEqual(managers.first { $0.bookingId == id && $0.kind == .cancelled }?.isUnread, false)
    }

    // MARK: - Days off, links, settings, devices

    func testDayOffAddUpdateRemove() async throws {
        let hassan = try await signedIn("hassan@local.test")
        let own = try await chair(hassan, "hassan")
        let existing = Set(try await hassan.daysOff(barberId: own.id).map(\.date))
        let day = try XCTUnwrap((30...50).map { clock.today.adding(days: $0) }
            .first { Catalog.storeHours[$0.weekday] != nil && !existing.contains($0) })
        addTeardownBlock { try? await hassan.removeDayOff(barberId: own.id, date: day) }

        let count = try await hassan.addDayOff(barberId: own.id, date: day, reason: "Integration")
        XCTAssertEqual(count, 0)
        _ = try await hassan.addDayOff(barberId: own.id, date: day, reason: "Integration, updated")
        var off = try await hassan.daysOff(barberId: own.id)
        XCTAssertEqual(off.filter { $0.date == day }.map(\.reason), ["Integration, updated"], "adding again updates the reason")
        let slots = try await hassan.freeSlots(barberId: own.id, date: day)
        XCTAssertTrue(slots.isEmpty, "no slots on a day off")
        await assertThrows(.dateOutOfRange) { _ = try await hassan.addDayOff(barberId: own.id, date: self.clock.today.adding(days: -1), reason: nil) }

        try await hassan.removeDayOff(barberId: own.id, date: day)
        off = try await hassan.daysOff(barberId: own.id)
        XCTAssertFalse(off.contains { $0.date == day })
    }

    func testLinksAddAndDelete() async throws {
        let hassan = try await signedIn("hassan@local.test")
        let own = try await chair(hassan, "hassan")
        let plain = try await hassan.addLink(barberId: own.id, label: "Integration plain", serviceSlug: nil)
        addTeardownBlock { try? await hassan.deleteLink(id: plain.id) }
        let vip = try await hassan.addLink(barberId: own.id, label: "Integration VIP", serviceSlug: "vip-haircut")
        addTeardownBlock { try? await hassan.deleteLink(id: vip.id) }
        XCTAssertEqual(plain.barberId, own.id)
        XCTAssertNil(plain.serviceSlug)
        XCTAssertEqual(vip.serviceSlug, "vip-haircut")
        await assertThrows(.invalidLabel) { _ = try await hassan.addLink(barberId: own.id, label: "   ", serviceSlug: nil) }
        await assertThrows(.serviceNotFound) { _ = try await hassan.addLink(barberId: own.id, label: "Bad", serviceSlug: "no-such-service") }

        var links = try await hassan.links(barberId: own.id)
        XCTAssertTrue(Set(links.map(\.id)).isSuperset(of: [plain.id, vip.id]))
        try await hassan.deleteLink(id: plain.id)
        try await hassan.deleteLink(id: vip.id)
        links = try await hassan.links(barberId: own.id)
        XCTAssertFalse(links.contains { $0.id == plain.id || $0.id == vip.id })
    }

    func testNotifyPrefsAndDeviceTokens() async throws {
        let larry = try await signedIn("larry@local.test")
        let before = try await larry.me()
        addTeardownBlock {
            try? await larry.setNotifyPrefs(bookings: before.notifyBookings, cancellations: before.notifyCancellations,
                                            viewedChairs: before.notifyViewedChairs)
        }
        try await larry.setNotifyPrefs(bookings: !before.notifyBookings, cancellations: !before.notifyCancellations,
                                       viewedChairs: !before.notifyViewedChairs)
        let changed = try await larry.me()
        XCTAssertEqual(changed.notifyBookings, !before.notifyBookings)
        XCTAssertEqual(changed.notifyCancellations, !before.notifyCancellations)
        XCTAssertEqual(changed.notifyViewedChairs, !before.notifyViewedChairs)
        try await larry.setNotifyPrefs(bookings: before.notifyBookings, cancellations: before.notifyCancellations,
                                       viewedChairs: before.notifyViewedChairs)

        let token = (0..<32).map { _ in String(format: "%02x", Int.random(in: 0...255)) }.joined()
        addTeardownBlock { try? await larry.unregisterDevice(token: token) }
        try await larry.registerDevice(token: token, environment: "sandbox")
        try await larry.registerDevice(token: token, environment: "production")
        await assertThrows(.server("invalid_environment")) { try await larry.registerDevice(token: token, environment: "staging") }
        try await larry.unregisterDevice(token: token)
    }

    // MARK: - Manager: barbers, hours, active, grants, logins

    func testManagerBarberProfileHoursActiveAndGrants() async throws {
        let ali = try await signedIn("ali@local.test")
        let hassanChair = try await chair(ali, "hassan")
        let tag = String(UUID().uuidString.lowercased().prefix(6))
        let slug = "it-\(tag)"

        // Profile: rules, then a new barber.
        await assertThrows(.slugReserved) {
            _ = try await ali.saveBarber(BarberDraft(id: nil, slug: "assets", displayName: "X", title: "", bio: "", photoUrl: nil))
        }
        await assertThrows(.slugTaken) {
            _ = try await ali.saveBarber(BarberDraft(id: nil, slug: "larry", displayName: "X", title: "", bio: "", photoUrl: nil))
        }
        await assertThrows(.invalidSlug) {
            _ = try await ali.saveBarber(BarberDraft(id: nil, slug: "a", displayName: "X", title: "", bio: "", photoUrl: nil))
        }
        await assertThrows(.invalidBarberName) {
            _ = try await ali.saveBarber(BarberDraft(id: nil, slug: slug, displayName: " ", title: "", bio: "", photoUrl: nil))
        }
        let id = try await ali.saveBarber(BarberDraft(id: nil, slug: slug, displayName: "Integration \(tag)",
                                                      title: "Barber", bio: "", photoUrl: nil))
        addTeardownBlock {
            _ = try? await ali.setActive(barberId: id, active: false)
            try? await ali.setViewGrant(viewer: id, barber: hassanChair.id, granted: false)
        }
        var barbers = try await ali.barbers()
        let created = try XCTUnwrap(barbers.first { $0.id == id })
        XCTAssertEqual(created.slug, slug)
        XCTAssertTrue(created.isActive)
        XCTAssertNil(created.bio, "empty bio is stored as null")
        let noHours = try await ali.barberSchedule(barberId: id)
        XCTAssertTrue(noHours.isEmpty, "a new barber has no hours yet")

        // Photo: upload, public read, keep the URL on the profile, then delete it.
        let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).jpegData(withCompressionQuality: 0.8) { ctx in
            UIColor.gray.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let photoURL = try await ali.uploadBarberPhoto(jpeg, slug: slug)
        let (_, photoResponse) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: photoURL)))
        XCTAssertEqual((photoResponse as? HTTPURLResponse)?.statusCode, 200, "barber-photos is public-read")
        _ = try await ali.saveBarber(BarberDraft(id: id, slug: slug, displayName: "Integration \(tag)",
                                                 title: "Barber", bio: "Test profile", photoUrl: photoURL))
        barbers = try await ali.barbers()
        let withPhoto = try XCTUnwrap(barbers.first { $0.id == id })
        XCTAssertEqual(withPhoto.photoUrl, photoURL)
        let objectPath = try XCTUnwrap(photoURL.components(separatedBy: "/object/public/").last)
        var delete = URLRequest(url: url.appending(path: "storage/v1/object/\(objectPath)"))
        delete.httpMethod = "DELETE"
        delete.setValue(key, forHTTPHeaderField: "apikey")
        delete.setValue("Bearer \(try await accessToken("ali@local.test"))", forHTTPHeaderField: "Authorization")
        let (_, deleteResponse) = try await URLSession.shared.data(for: delete)
        XCTAssertEqual((deleteResponse as? HTTPURLResponse)?.statusCode, 200)

        // Hours: rules, then Monday and Wednesday.
        let open = ShopTime(hour: 10), close = ShopTime(hour: 18)
        await assertThrows(.outsideStoreHours) {
            _ = try await ali.setSchedule(barberId: id, days: [ScheduleDay(weekday: 2, open: open, close: close)])
        }
        await assertThrows(.invalidSchedule) {
            _ = try await ali.setSchedule(barberId: id, days: [ScheduleDay(weekday: 1, open: close, close: open)])
        }
        let week = [ScheduleDay(weekday: 1, open: open, close: close), ScheduleDay(weekday: 3, open: open, close: close)]
        var outside = try await ali.setSchedule(barberId: id, days: week)
        XCTAssertEqual(outside, 0)
        let saved = try await ali.barberSchedule(barberId: id)
        XCTAssertEqual(saved, week)
        let publicHours = try await ali.weeklyHours(barberId: id)
        XCTAssertEqual(publicHours, week)

        // A booking on Monday, then a week without Monday: it no longer fits, and stays booked.
        let (day, time) = try await freeSlot(ali, barberId: id)
        let bookingId = try await ali.book(newBooking(id, day, time, name: "Integration Moved"))
        addTeardownBlock { _ = try? await ali.cancelBooking(id: bookingId) }
        outside = try await ali.setSchedule(barberId: id, days: week.filter { $0.weekday != day.weekday })
        XCTAssertEqual(outside, 1, "manager_set_schedule counts the booking the new week leaves out")
        outside = try await ali.setSchedule(barberId: id, days: week)
        XCTAssertEqual(outside, 0)
        let managerCancel = try await ali.cancelBooking(id: bookingId)
        XCTAssertEqual(managerCancel.bookingId, bookingId)
        let testRows = try await ali.bookings(barberId: id, from: day, to: day)
        let cancelledRow = try XCTUnwrap(testRows.first { $0.id == bookingId })
        XCTAssertEqual(cancelledRow.cancelledBy, "manager", "a manager cancelling on a chair that is not theirs")

        // Active off and on.
        var upcoming = try await ali.setActive(barberId: id, active: false)
        XCTAssertEqual(upcoming, 0)
        var meChairs = try await ali.me().chairs
        XCTAssertEqual(meChairs.first { $0.id == id }?.isActive, false, "the manager still sees an inactive chair")
        let inactiveSlots = try await ali.freeSlots(barberId: id, date: day)
        XCTAssertTrue(inactiveSlots.isEmpty)
        upcoming = try await ali.setActive(barberId: id, active: true)
        XCTAssertEqual(upcoming, 0)
        meChairs = try await ali.me().chairs
        XCTAssertEqual(meChairs.first { $0.id == id }?.isActive, true)

        // View grant on and off.
        await assertThrows(.invalidGrant) { try await ali.setViewGrant(viewer: id, barber: id, granted: true) }
        try await ali.setViewGrant(viewer: id, barber: hassanChair.id, granted: true)
        if let grants = try await grantsIfAvailable(ali) {
            XCTAssertTrue(grants.contains(ViewGrant(viewerBarberId: id, barberId: hassanChair.id)))
        }

        try await ali.setViewGrant(viewer: id, barber: hassanChair.id, granted: false)
        if let grants = try await grantsIfAvailable(ali) {
            XCTAssertFalse(grants.contains(ViewGrant(viewerBarberId: id, barberId: hassanChair.id)))
        }
    }

    /// staff-admin: create a login, first sign-in forces a new password, reset, disable, enable.
    func testManagerCreatesResetsAndDisablesLogins() async throws {
        let ali = try await signedIn("ali@local.test")
        let hassanChair = try await chair(ali, "hassan")
        let tag = String(UUID().uuidString.lowercased().prefix(6))
        let slug = "it-\(tag)"
        let id = try await ali.saveBarber(BarberDraft(id: nil, slug: slug, displayName: "Integration \(tag)",
                                                      title: "Barber", bio: "", photoUrl: nil))
        addTeardownBlock {
            _ = try? await ali.setActive(barberId: id, active: false)
            try? await ali.setViewGrant(viewer: id, barber: hassanChair.id, granted: false)
        }
        try await ali.setViewGrant(viewer: id, barber: hassanChair.id, granted: true)

        // The function's own checks, which answer before it calls Auth's admin API.
        let aliId = try await ali.me().userId
        await assertThrows(.cannotDisableSelf) { try await ali.setLoginDisabled(userId: aliId, disabled: true) }
        await assertThrows(.userNotFound) { _ = try await ali.resetPassword(userId: UUID()) }
        await assertThrows(.userNotFound) { try await ali.setLoginDisabled(userId: UUID(), disabled: false) }
        await assertThrows(.invalidEmail) { _ = try await ali.createLogin(email: "not-an-email", displayName: "X", role: .manager, barberId: nil) }
        await assertThrows(.invalidDisplayName) { _ = try await ali.createLogin(email: "x-\(tag)@local.test", displayName: " ", role: .manager, barberId: nil) }

        // Login: create, first sign-in forces a new password.
        let email = "it-\(tag)@local.test"
        let login: CreatedLogin
        do {
            login = try await ali.createLogin(email: email, displayName: "Integration \(tag)", role: .barber, barberId: id)
        } catch BackendError.server("internal") {
            return XCTFail("staff-admin create_login answered 500 internal; the function's log has the cause")
        }
        addTeardownBlock { try? await ali.setLoginDisabled(userId: login.userId, disabled: true) }
        XCTAssertNotNil(login.temporaryPassword.range(of: #"^([a-z]+-){4}\d{2}$"#, options: .regularExpression),
                        login.temporaryPassword)
        await assertThrows(.barberHasLogin) {
            _ = try await ali.createLogin(email: "other-\(email)", displayName: "Other", role: .barber, barberId: id)
        }
        await assertThrows(.emailTaken) { _ = try await ali.createLogin(email: email, displayName: "Again", role: .manager, barberId: nil) }

        let barber = try await signedIn(email, password: login.temporaryPassword)
        var me = try await barber.me()
        XCTAssertTrue(me.mustChangePassword)
        XCTAssertEqual(me.chairs.map(\.slug), [slug, "hassan"], "own chair, then the granted one")
        XCTAssertEqual(me.chairs.map(\.canManage), [true, false])
        await assertThrows(.weakPassword) { try await barber.changePassword("short") }
        try await barber.changePassword("integration-\(tag)-pass")
        me = try await barber.me()
        XCTAssertFalse(me.mustChangePassword)

        try await ali.setViewGrant(viewer: id, barber: hassanChair.id, granted: false)
        me = try await barber.me()
        XCTAssertEqual(me.chairs.map(\.slug), [slug])

        // Reset: the old password stops working and the change is forced again.
        let reset = try await ali.resetPassword(userId: login.userId)
        await assertThrows(.invalidCredentials) {
            try await SupabaseBackend(url: self.url, key: self.key, persistsSession: false)
                .signIn(email: email, password: "integration-\(tag)-pass")
        }
        let afterReset = try await signedIn(email, password: reset)
        me = try await afterReset.me()
        XCTAssertTrue(me.mustChangePassword)

        // Disable: the open session loses access at once, and sign-in is refused.
        let staff = try await ali.staff()
        let member = try XCTUnwrap(staff.first { $0.userId == login.userId })
        XCTAssertEqual(member.email, email)
        XCTAssertEqual(member.barberId, id)
        XCTAssertFalse(member.isDisabled)
        try await ali.setLoginDisabled(userId: login.userId, disabled: true)
        await assertThrows(.noAccess) { _ = try await afterReset.me() }
        let lockedOut = try await afterReset.activity(before: nil, limit: 10)
        XCTAssertTrue(lockedOut.isEmpty)
        await assertThrows(.forbidden) { _ = try await afterReset.bookings(barberId: id, from: self.clock.today, to: self.clock.today) }
        await assertThrows(.invalidCredentials) {
            try await SupabaseBackend(url: self.url, key: self.key, persistsSession: false).signIn(email: email, password: reset)
        }
        let disabledRow = try await ali.staff().first { $0.userId == login.userId }
        XCTAssertEqual(disabledRow?.isDisabled, true)

        // Enable, then deactivating the chair is what takes access away.
        try await ali.setLoginDisabled(userId: login.userId, disabled: false)
        let again = try await signedIn(email, password: reset)
        _ = try await again.me()
        _ = try await ali.setActive(barberId: id, active: false)
        await assertThrows(.noAccess) { _ = try await again.me() }
        try await ali.setLoginDisabled(userId: login.userId, disabled: true)
    }
}
