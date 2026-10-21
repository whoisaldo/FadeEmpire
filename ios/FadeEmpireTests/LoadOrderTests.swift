import XCTest
@testable import FadeEmpire

/// Overlapping loads finishing out of order: only the newest one's result is applied.
@MainActor
final class LoadOrderTests: XCTestCase {
    private func signedIn(_ backend: MockBackend) async -> AppModel {
        let app = AppModel(backend: backend, clock: .fixed(pinnedNow))
        await app.start()
        return app
    }

    /// Waits until the backend has been asked `count` times, so a delayed call has taken its answer.
    private func waitForCalls(_ backend: MockBackend, _ call: MockBackend.Call, _ count: Int) async {
        for _ in 0..<500 {
            if await backend.callCount(call) >= count { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("\(call) was not called \(count) times")
    }

    func testGenerationKeepsOnlyTheNewest() {
        var loads = LoadGeneration()
        let first = loads.next()
        let second = loads.next()
        XCTAssertFalse(loads.isCurrent(first))
        XCTAssertTrue(loads.isCurrent(second))
    }

    /// A refresh that read the schedule before a cancel lands after the cancel's own reload:
    /// the appointment stays cancelled.
    func testStaleScheduleLoadLosesToActionFollowUp() async throws {
        let backend = mock(as: "hassan@local.test")
        let app = await signedIn(backend)
        let schedule = ScheduleModel(app: app)
        await schedule.load()
        let tyler = schedule.bookings.first { $0.customerName == "Tyler Brooks" }!
        XCTAssertEqual(tyler.status, .confirmed)

        let before = await backend.callCount(.bookings)
        await backend.inject(.bookings, delay: .milliseconds(600))
        let stale = Task { await schedule.load() }
        await waitForCalls(backend, .bookings, before + 1)
        _ = try await schedule.cancel(tyler)
        XCTAssertEqual(schedule.booking(id: tyler.id)?.status, .cancelled)
        await stale.value
        XCTAssertEqual(schedule.booking(id: tyler.id)?.status, .cancelled, "the older load is dropped")
    }

    /// A slow load of one chair finishing after a switch to another never shows under it.
    func testChairSwitchDropsTheOtherChairsLoad() async {
        let backend = mock(as: "hassan@local.test")
        let app = await signedIn(backend)
        let schedule = ScheduleModel(app: app)
        await schedule.load()
        let before = await backend.callCount(.bookings)
        await backend.inject(.bookings, delay: .milliseconds(600))
        let stale = Task { await schedule.load() }
        await waitForCalls(backend, .bookings, before + 1)
        await schedule.selectChair(MockSeed.larryId)
        await stale.value
        XCTAssertFalse(schedule.bookings.isEmpty)
        XCTAssertTrue(schedule.bookings.allSatisfy { $0.barberId == MockSeed.larryId })
    }

    /// An older failing load does not put an error over a newer good one.
    func testStaleFailureDoesNotOverwrite() async {
        let backend = mock(as: "hassan@local.test")
        let app = await signedIn(backend)
        let schedule = ScheduleModel(app: app)
        let before = await backend.callCount(.bookings)
        await backend.inject(.bookings, delay: .milliseconds(600), error: .network)
        let stale = Task { await schedule.load() }
        await waitForCalls(backend, .bookings, before + 1)
        await schedule.load()
        await stale.value
        XCTAssertNil(schedule.error)
        XCTAssertFalse(schedule.bookings.isEmpty)
    }

    /// The Barbers tab: a reload that read Larry before a save lands last and is dropped.
    func testStaleBarbersLoadLosesToSave() async throws {
        let backend = mock(as: "ali@local.test")
        let app = await signedIn(backend)
        let model = BarbersModel(app: app)
        await model.load()
        let before = await backend.callCount(.barbers)
        await backend.inject(.barbers, delay: .milliseconds(600))
        let stale = Task { await model.load() }
        await waitForCalls(backend, .barbers, before + 1)
        let larry = model.barber(MockSeed.larryId)!
        _ = try await model.save(BarberDraft(id: larry.id, slug: larry.slug, displayName: larry.displayName,
                                             title: larry.title ?? "", bio: "Saved bio.", photoUrl: larry.photoUrl),
                                 photo: nil, hours: nil)
        await stale.value
        XCTAssertEqual(model.barber(MockSeed.larryId)?.bio, "Saved bio.")
    }

    /// The badge: an unread count read before Activity was marked seen does not bring it back.
    func testStaleUnreadCountLosesToMarkSeen() async {
        let backend = mock(as: "hassan@local.test")
        let app = await signedIn(backend)
        XCTAssertEqual(app.unreadCount, 3)
        let before = await backend.callCount(.activity)
        await backend.inject(.activity, delay: .milliseconds(600))
        let stale = Task { await app.refreshUnread() }
        await waitForCalls(backend, .activity, before + 1)
        await app.markActivitySeen()
        await stale.value
        XCTAssertEqual(app.unreadCount, 0)
    }

    /// Two switches flipped quickly: both end up stored, whatever order the sends would land in.
    func testQuickNotificationSwitchesKeepBoth() async throws {
        let backend = mock(as: "hassan@local.test")
        let app = await signedIn(backend)
        XCTAssertEqual(app.me?.notifyBookings, true)
        XCTAssertEqual(app.me?.notifyCancellations, true)
        await backend.inject(.setNotifyPrefs, delay: .milliseconds(400))
        let first = app.setNotifyPref(\.notifyBookings, false)
        let second = app.setNotifyPref(\.notifyCancellations, false)
        XCTAssertEqual(app.me?.notifyBookings, false, "the switch moves at once")
        try await first.value
        try await second.value
        let stored = try await backend.me()
        XCTAssertFalse(stored.notifyBookings)
        XCTAssertFalse(stored.notifyCancellations)
        XCTAssertFalse(stored.notifyViewedChairs)
    }

    func testFailedSwitchGoesBack() async {
        let backend = mock(as: "hassan@local.test")
        let app = await signedIn(backend)
        await backend.inject(.setNotifyPrefs, error: .network)
        do {
            try await app.setNotifyPref(\.notifyBookings, false).value
            XCTFail("the send failed")
        } catch {
            XCTAssertEqual(error as? BackendError, .network)
        }
        XCTAssertEqual(app.me?.notifyBookings, true, "shows what is stored")
    }

    /// A refresh that overlaps a switch keeps the switch where the user put it.
    func testRefreshDuringSwitchKeepsIt() async throws {
        let backend = mock(as: "hassan@local.test")
        let app = await signedIn(backend)
        let before = await backend.callCount(.me)
        await backend.inject(.me, delay: .milliseconds(500))
        let refresh = Task { await app.refresh() }
        await waitForCalls(backend, .me, before + 1)
        try await app.setNotifyPref(\.notifyBookings, false).value
        await refresh.value
        XCTAssertEqual(app.me?.notifyBookings, false)
    }
}
