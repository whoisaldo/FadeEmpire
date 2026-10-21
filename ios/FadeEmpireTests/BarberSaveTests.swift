import XCTest
@testable import FadeEmpire

/// Saving a barber: the hours are sent only when loaded and changed, the fields are checked
/// before any upload, and the profile and hours have separate results.
@MainActor
final class BarberSaveTests: XCTestCase {
    private let larry = MockSeed.larryId

    private func manager(_ backend: MockBackend) async -> BarbersModel {
        let app = AppModel(backend: backend, clock: .fixed(pinnedNow))
        await app.start()
        return BarbersModel(app: app)
    }

    private func draft(_ b: Barber, bio: String? = nil, name: String? = nil, title: String? = nil) -> BarberDraft {
        BarberDraft(id: b.id, slug: b.slug, displayName: name ?? b.displayName, title: title ?? b.title ?? "",
                    bio: bio ?? b.bio ?? "", photoUrl: b.photoUrl)
    }

    // MARK: - Hours rules

    func testHoursNotLoadedAreNeverSent() {
        var edit = HoursEdit.forBarber(saved: nil)
        XCTAssertNil(edit.original)
        XCTAssertNil(edit.edited)
        XCTAssertNil(edit.toSave, "a bio-only edit while the hours load leaves them alone")
        XCTAssertFalse(edit.leavesNoWorkingDays)
        edit.loaded([ScheduleDay(weekday: 1, open: ShopTime(hour: 10), close: ShopTime(hour: 18))])
        XCTAssertEqual(edit.edited?.days.keys.sorted(), [1])
        XCTAssertNil(edit.toSave, "loaded but unchanged")
    }

    func testUnchangedHoursAreNotSent() {
        let week = HoursDraft.storeDefault.schedule
        var edit = HoursEdit.forBarber(saved: week)
        XCTAssertNil(edit.toSave)
        edit.edited?.days[5] = nil
        XCTAssertEqual(edit.toSave?.map(\.weekday), [0, 1, 3, 4, 6])
        XCTAssertFalse(edit.leavesNoWorkingDays)
        edit.edited?.days[5] = Catalog.storeHours[5]
        XCTAssertNil(edit.toSave, "changed back is unchanged")
    }

    func testLaterLoadDoesNotOverwriteEdits() {
        var edit = HoursEdit.forBarber(saved: HoursDraft.storeDefault.schedule)
        edit.edited?.days[0] = nil
        edit.loaded([])
        XCTAssertEqual(edit.toSave?.map(\.weekday), [1, 3, 4, 5, 6])
    }

    func testClearingEveryDayNeedsConfirmation() {
        var edit = HoursEdit.forBarber(saved: HoursDraft.storeDefault.schedule)
        edit.edited = HoursDraft(days: [:])
        XCTAssertEqual(edit.toSave, [])
        XCTAssertTrue(edit.leavesNoWorkingDays)
        // A barber who already has no hours and keeps none: nothing is sent, nothing to confirm.
        let none = HoursEdit.forBarber(saved: [])
        XCTAssertNil(none.toSave)
        XCTAssertFalse(none.leavesNoWorkingDays)
    }

    func testNewBarberAlwaysSendsHours() {
        var edit = HoursEdit.forNewBarber()
        XCTAssertEqual(edit.toSave?.map(\.weekday), [0, 1, 3, 4, 5, 6])
        edit.edited = HoursDraft(days: [:])
        XCTAssertEqual(edit.toSave, [])
        XCTAssertTrue(edit.leavesNoWorkingDays)
    }

    func testProfileOnlySaveLeavesHoursAlone() async throws {
        let backend = mock(as: "ali@local.test")
        let model = await manager(backend)
        await model.load()
        let before = model.schedules[larry]
        let result = try await model.save(draft(model.barber(larry)!, bio: "New bio."), photo: nil, hours: nil)
        XCTAssertEqual(result.hours, .unchanged)
        let calls = await backend.callCount(.setSchedule)
        XCTAssertEqual(calls, 0, "no manager_set_schedule call")
        XCTAssertEqual(model.schedules[larry], before)
        XCTAssertEqual(model.barber(larry)?.bio, "New bio.")
    }

    func testFailedScheduleLoadIsReportedPerBarber() async {
        let backend = mock(as: "ali@local.test")
        await backend.inject(.barberSchedule, error: .network, times: nil)
        let model = await manager(backend)
        await model.load()
        XCTAssertFalse(model.barbers.isEmpty, "the profiles still load")
        XCTAssertNil(model.schedules[larry])
        XCTAssertTrue(model.scheduleFailed.contains(larry))
        XCTAssertNil(HoursEdit.forBarber(saved: model.schedules[larry]).toSave)
    }

    func testRetryLoadsOneBarbersHours() async {
        let backend = mock(as: "ali@local.test")
        await backend.inject(.barberSchedule, error: .network, times: 3)   // every barber on the first load
        let model = await manager(backend)
        await model.load()
        XCTAssertTrue(model.scheduleFailed.contains(larry))
        await model.loadSchedule(larry)
        XCTAssertFalse(model.scheduleFailed.contains(larry))
        XCTAssertEqual(model.schedules[larry]?.count, 6)
    }

    func testHoursFailureIsSeparateFromProfile() async throws {
        let backend = mock(as: "ali@local.test")
        let model = await manager(backend)
        await model.load()
        await backend.inject(.setSchedule, error: .network)
        let b = model.barber(larry)!
        let result = try await model.save(draft(b, bio: "Changed."), photo: nil, hours: [])
        XCTAssertEqual(result.id, larry)
        XCTAssertEqual(result.hours, .failed(BackendError.network.message))
        XCTAssertEqual(model.barber(larry)?.bio, "Changed.", "the profile saved anyway")
        XCTAssertEqual(model.schedules[larry]?.count, 6, "the hours stayed")
    }

    // MARK: - Field checks before upload

    func testRefusedCharacters() {
        XCTAssertFalse(BarberDraft.hasRefusedCharacters("Larry \"The Blade\" O'Neil"))
        XCTAssertTrue(BarberDraft.hasRefusedCharacters("<b>Larry</b>"))
        XCTAssertTrue(BarberDraft.hasRefusedCharacters("Larry>"))
        XCTAssertTrue(BarberDraft.hasRefusedCharacters("Lar\u{7}ry"))
        XCTAssertTrue(BarberDraft.hasRefusedCharacters("Lar\u{85}ry"))
        XCTAssertTrue(BarberDraft.hasRefusedCharacters("Two\nlines"), "a name or title has no line breaks")
        XCTAssertFalse(BarberDraft.hasRefusedCharacters("Two\nlines\r\nthree", allowsLineBreaks: true))
        XCTAssertTrue(BarberDraft.hasRefusedCharacters("Tab\there", allowsLineBreaks: true))
        XCTAssertFalse(BarberDraft.hasRefusedCharacters("José · Barbería 💈"))
    }

    func testProblemsPointAtTheField() {
        let others = MockSeed(clock: .fixed(pinnedNow)).barbers
        var d = BarberDraft(id: nil, slug: "marco", displayName: "Marco", title: "Barber", bio: "Fades.\nBeards.", photoUrl: nil)
        XCTAssertNil(d.problems(others: others).first)
        d.bio = "<script>"
        XCTAssertEqual(d.problems(others: others), BarberDraft.Problems(bio: .invalidText))
        d.bio = ""
        d.title = "Barber\u{1}"
        XCTAssertEqual(d.problems(others: others), BarberDraft.Problems(title: .invalidText))
        d.title = ""
        d.displayName = "Marco <3"
        XCTAssertEqual(d.problems(others: others).name, .invalidText)
        d.displayName = String(repeating: "a", count: 41)
        XCTAssertEqual(d.problems(others: others).name, .invalidBarberName)
        d.displayName = "Marco"
        d.slug = "larry"
        XCTAssertEqual(d.problems(others: others).slug, .slugTaken)
        d.slug = "assets"
        XCTAssertEqual(d.problems(others: others).slug, .slugReserved)
        d.slug = "M"
        XCTAssertEqual(d.problems(others: others).slug, .invalidSlug)
        // Larry keeps his own link name.
        let larry = BarberDraft(id: MockSeed.larryId, slug: "larry", displayName: "Larry", title: "", bio: "", photoUrl: nil)
        XCTAssertNil(larry.problems(others: others).first)
    }

    func testRefusedTextUploadsNoPhoto() async throws {
        let backend = mock(as: "ali@local.test")
        let model = await manager(backend)
        await model.load()
        do {
            _ = try await model.save(draft(model.barber(larry)!, bio: "<b>bold</b>"), photo: Data([0xFF, 0xD8]), hours: nil)
            XCTFail("refused before saving")
        } catch {
            XCTAssertEqual(error as? BackendError, .invalidText)
        }
        let uploads = await backend.uploadedPhotos
        XCTAssertEqual(uploads, [], "nothing left in barber-photos")
        let saves = await backend.callCount(.saveBarber)
        XCTAssertEqual(saves, 0)
    }

    func testPhotoUploadsOnceAndSaves() async throws {
        let backend = mock(as: "ali@local.test")
        let model = await manager(backend)
        await model.load()
        let result = try await model.save(draft(model.barber(larry)!), photo: Data([0xFF, 0xD8]), hours: nil)
        let uploads = await backend.uploadedPhotos
        XCTAssertEqual(uploads.count, 1)
        XCTAssertEqual(result.photoUrl, model.barber(larry)?.photoUrl)
        XCTAssertTrue(BarberDraft.isValidPhotoUrl(result.photoUrl ?? ""), result.photoUrl ?? "nil")
    }

    func testPhotoUrlRule() {
        XCTAssertTrue(BarberDraft.isValidPhotoUrl("https://abc.supabase.co/storage/v1/object/public/barber-photos/larry/1f.jpg"))
        XCTAssertTrue(BarberDraft.isValidPhotoUrl("http://127.0.0.1:56321/storage/v1/object/public/barber-photos/larry/a.b-c_d.jpg"))
        XCTAssertFalse(BarberDraft.isValidPhotoUrl("./assets/larry.jpg"))
        XCTAssertFalse(BarberDraft.isValidPhotoUrl("http://example.com/storage/v1/object/public/barber-photos/x.jpg"))
        XCTAssertFalse(BarberDraft.isValidPhotoUrl("https://abc.supabase.co/storage/v1/object/public/barber-photos/.hidden"))
        XCTAssertFalse(BarberDraft.isValidPhotoUrl("https://abc.supabase.co/storage/v1/object/public/barber-photos/x.jpg?x=1"))
    }

    func testMockRefusesLikeTheDatabase() async throws {
        let backend = mock(as: "ali@local.test")
        let larry = try await backend.barbers().first { $0.id == self.larry }!
        do {
            _ = try await backend.saveBarber(draft(larry, title: "<i>"))
            XCTFail("invalid_text")
        } catch {
            XCTAssertEqual(error as? BackendError, .invalidText)
        }
        var bad = draft(larry)
        bad.photoUrl = "https://evil.example/x.jpg"
        do {
            _ = try await backend.saveBarber(bad)
            XCTFail("invalid_photo_url")
        } catch {
            XCTAssertEqual(error as? BackendError, .invalidPhotoUrl)
        }
    }

    // MARK: - Error words

    func testNewCodesHaveWords() {
        XCTAssertEqual(BackendError.from(code: "invalid_text"), .invalidText)
        XCTAssertEqual(BackendError.from(code: "invalid_photo_url"), .invalidPhotoUrl)
        XCTAssertTrue(BackendError.invalidText.message.contains("< or >"), BackendError.invalidText.message)
        XCTAssertTrue(BackendError.invalidPhotoUrl.message.contains("photo"))
        XCTAssertFalse(BackendError.invalidText.message.contains("refused"))
    }
}
