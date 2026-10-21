import XCTest

/// End-to-end flows on the MockBackend.
final class FlowTests: MockUITestCase {
    func testSignInWithForcedNewPassword() {
        launch(extra: ["-mock-must-change", "hassan@local.test"])
        type("signin-email", "hassan@local.test")
        type("signin-password", "fade-local-1")
        tap("signin-submit")
        XCTAssertTrue(app.staticTexts["Choose your password"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.tabBars.firstMatch.exists, "nothing else is reachable before the change")
        type("newpassword-field", "hassan-chair-1")
        type("newpassword-confirm", "hassan-chair-1")
        tap("newpassword-submit")
        XCTAssertTrue(app.tabBars.buttons["Schedule"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Hassan's chair"].exists)
    }

    func testWrongPasswordIsExplained() {
        launch()
        type("signin-email", "larry@local.test")
        type("signin-password", "wrong")
        tap("signin-submit")
        XCTAssertTrue(el("error-message").waitForExistence(timeout: 5))
    }

    func testViewOnlyChairHasNoActions() {
        launch(as: "hassan@local.test")
        XCTAssertTrue(el("new-appointment").waitForExistence(timeout: 5))
        tap("chair-larry")
        XCTAssertTrue(app.staticTexts["Larry's chair"].waitForExistence(timeout: 5))
        XCTAssertFalse(el("new-appointment").exists, "no New appointment on a view-only chair")
        tap("booking-Andre Mitchell")
        XCTAssertTrue(app.staticTexts["Andre Mitchell"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["View only"].exists)
        // No phone on a view-only chair: no Call, no Text, no number.
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Call'")).firstMatch.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Text'")).firstMatch.exists)
        XCTAssertFalse(element(containing: "(413) 555-").exists)
        XCTAssertFalse(el("cancel-appointment").exists)
        XCTAssertFalse(el("mark-no-show").exists)
        XCTAssertFalse(el("undo-no-show").exists)
        // Days off are listed but cannot be changed.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        tap("open-days-off")
        XCTAssertTrue(app.staticTexts["Wednesday, October 28"].waitForExistence(timeout: 5))
        XCTAssertFalse(el("dayoff-add").exists)
    }

    func testCancelOffersTextToCustomer() {
        launch(as: "hassan@local.test")
        tap("booking-Tyler Brooks")
        tap("cancel-appointment")
        tapDialogButton("Cancel appointment", id: "confirm-cancel")
        XCTAssertTrue(el("cancelled-title").waitForExistence(timeout: 5))
        XCTAssertTrue(el("text-customer").exists)
        XCTAssertEqual(el("text-customer").label, "Text Tyler")
        let message = el("cancel-message").label
        XCTAssertTrue(message.contains("FADE EMPIRE — CANCELLATION"), message)
        XCTAssertTrue(message.contains("Time:    4:45 PM"), message)
        tap("cancelled-done")
        XCTAssertTrue(app.staticTexts["Cancelled"].waitForExistence(timeout: 5))
        XCTAssertFalse(el("cancel-appointment").exists)
    }

    func testBookIntoFreeSlot() {
        launch(as: "hassan@local.test")
        tap("new-appointment")
        tap("newday-2026-10-23")
        XCTAssertFalse(el("slot-10:45").waitForExistence(timeout: 2), "10:45 is taken that day")
        tap("slot-10:00")
        type("new-name", "Walk In Test")
        type("new-phone", "4135550199")
        tap("keyboard-done")
        let book = reveal("new-book")
        XCTAssertEqual(book.label, "Book Fri Oct 23, 10:00 AM")
        book.tap()
        XCTAssertTrue(el("booking-Walk In Test").waitForExistence(timeout: 5))
        XCTAssertTrue(el("day-header").label.contains("Friday, October 23"), el("day-header").label)
    }

    func testDayOffWarnsAboutBookings() {
        launch(as: "hassan@local.test")
        tap("open-days-off")
        tap("dayoff-picker")
        let friday = app.buttons["Friday, October 23"].firstMatch
        XCTAssertTrue(friday.waitForExistence(timeout: 5))
        friday.tap()
        type("dayoff-reason", "Dentist")
        tap("dayoff-add")
        let alert = app.alerts["3 still booked on Fri Oct 23"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        alert.buttons["OK"].tap()
        XCTAssertTrue(el("dayoff-2026-10-23").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["3 still booked that day"].exists)
    }

    func testCustomLinkURL() {
        launch(as: "hassan@local.test")
        tab("Links")
        XCTAssertEqual(el("link-url-Hassan's booking page").label, "https://chicopeefadeempire.com/hassan")
        tap("add-link")
        type("link-label", "Fade Friday")
        tap("link-service")
        app.buttons["Hair Cut"].firstMatch.tap()
        XCTAssertEqual(el("link-preview").label, "https://chicopeefadeempire.com/?barber=hassan&service=hair-cut#book")
        tap("link-save")
        let url = el("link-url-Fade Friday")
        XCTAssertTrue(url.waitForExistence(timeout: 5))
        XCTAssertEqual(url.label, "https://chicopeefadeempire.com/?barber=hassan&service=hair-cut#book")
        app.buttons["QR code for Fade Friday"].tap()
        XCTAssertTrue(el("qr-image").waitForExistence(timeout: 5))
    }

    func testManagerAddsBarberWithHoursAndLogin() {
        launch(as: "ali@local.test")
        tab("Barbers")
        tap("add-barber")
        type("barber-name", "Marco Silva")
        app.keyboards.buttons["return"].tap()
        XCTAssertEqual(el("barber-slug").value as? String, "marco-silva")
        // Sunday off; the switch sits at the row's trailing edge.
        let sunday = reveal("hours-0")
        sunday.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(sunday.value as? String, "0")
        tap("barber-save")
        let hours = el("barber-hours")
        XCTAssertTrue(hours.waitForExistence(timeout: 5))
        XCTAssertTrue(hours.label.contains("Mon 10:00 AM–6:00 PM"), hours.label)
        XCTAssertFalse(hours.label.contains("Sun"), hours.label)
        XCTAssertFalse(hours.label.contains("Tue"), hours.label)
        tap("create-login")
        type("login-email", "marco@local.test")
        tap("login-create")
        let pw = el("temp-password")
        XCTAssertTrue(pw.waitForExistence(timeout: 5))
        XCTAssertNotNil(pw.label.range(of: #"^([a-z]+-){4}\d{2}$"#, options: .regularExpression), pw.label)
        tap("temp-password-done")
        XCTAssertFalse(el("temp-password").exists, "shown once")
        XCTAssertTrue(element(containing: "marco@local.test").waitForExistence(timeout: 5))
        XCTAssertTrue(el("reset-password").exists)
    }

    func testManagerToldWhenNewHoursLeaveBookingsOut() {
        launch(as: "ali@local.test")
        tab("Barbers")
        tap("barber-larry")
        tap("edit-barber")
        // Friday off: the switch sits at the row's trailing edge.
        let friday = reveal("hours-5")
        friday.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(friday.value as? String, "0")
        tap("barber-save")
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertTrue(alert.label.contains("2 upcoming appointments no longer fit Larry's hours"), alert.label)
        alert.buttons["OK"].tap()
        XCTAssertFalse(el("barber-hours").label.contains("Fri"), el("barber-hours").label)
    }

    func testManagerDeactivatesAfterSeeingBookings() {
        launch(as: "ali@local.test")
        tab("Barbers")
        tap("barber-larry")
        tap("deactivate")
        let count = el("deactivate-count")
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        XCTAssertEqual(count.label, "Upcoming bookings (6)")
        XCTAssertTrue(element(containing: "Malik Johnson").exists, "the affected customers are listed")
        tap("confirm-deactivate")
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.label.contains("Larry is inactive"), alert.label)
        XCTAssertTrue(alert.label.contains("6 upcoming bookings are still booked"), alert.label)
        alert.buttons["OK"].tap()
        XCTAssertTrue(el("reactivate").waitForExistence(timeout: 5))
    }

    func testActivityBadgeClearsAfterViewing() {
        launch(as: "hassan@local.test")
        let activity = app.tabBars.buttons["Activity"].firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        let badged = NSPredicate(format: "value == '3 unread'")
        expectation(for: badged, evaluatedWith: activity)
        waitForExpectations(timeout: 5)
        activity.tap()
        XCTAssertTrue(element(containing: "New booking · Tyler Brooks").waitForExistence(timeout: 5))
        tab("Schedule")
        let cleared = NSPredicate(format: "value == ''")
        expectation(for: cleared, evaluatedWith: activity)
        waitForExpectations(timeout: 5)
    }
}
