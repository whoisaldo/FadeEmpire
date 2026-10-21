import XCTest

/// Captures every main screen on the mock. Runs only from ios/scripts/screenshots.sh,
/// which sets SCREENSHOT_DIR (and SCREENSHOT_PREFIX for the device size).
final class ScreenshotTests: MockUITestCase {
    private var dir: URL!
    private var prefix = ""
    private var index = 0

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["SCREENSHOT_DIR"], !path.isEmpty else { throw XCTSkip("SCREENSHOT_DIR not set") }
        dir = URL(fileURLWithPath: path)
        prefix = env["SCREENSHOT_PREFIX"] ?? "iphone"
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    private func shot(_ name: String) {
        sleep(1)
        index += 1
        let file = dir.appendingPathComponent(String(format: "%@-%02d-%@.png", prefix, index, name))
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: file)
    }

    private func back() { app.navigationBars.buttons.element(boundBy: 0).tap() }

    func testCaptureBarberScreens() {
        index = 0
        launch(extra: ["-mock-must-change", "hassan@local.test"])
        shot("sign-in")
        type("signin-email", "hassan@local.test")
        type("signin-password", "fade-local-1")
        tap("signin-submit")
        XCTAssertTrue(el("newpassword-field").waitForExistence(timeout: 5))
        shot("new-password")
        type("newpassword-field", "hassan-chair-1")
        type("newpassword-confirm", "hassan-chair-1")
        tap("newpassword-submit")

        XCTAssertTrue(el("new-appointment").waitForExistence(timeout: 5))
        shot("schedule")
        tap("booking-Tyler Brooks")
        XCTAssertTrue(el("cancel-appointment").waitForExistence(timeout: 5))
        shot("appointment")
        back()
        tap("booking-Jamal Carter")
        XCTAssertTrue(el("cancel-appointment").waitForExistence(timeout: 5))
        shot("appointment-group")
        back()
        tap("new-appointment")
        tap("newday-2026-10-23")
        tap("slot-10:00")
        shot("new-appointment")
        app.buttons["Close"].tap()
        app.swipeDown()  // back to the top, where the chair switcher is
        tap("chair-larry")
        XCTAssertTrue(app.staticTexts["Larry's chair"].waitForExistence(timeout: 5))
        shot("schedule-view-only")
        tap("chair-hassan")
        tap("open-days-off")
        XCTAssertTrue(el("dayoff-add").waitForExistence(timeout: 5))
        shot("days-off")
        app.buttons["Done"].tap()

        tab("Activity")
        sleep(1)
        shot("activity")
        tab("Links")
        XCTAssertTrue(el("add-link").waitForExistence(timeout: 5))
        shot("links")
        app.buttons["QR code for VIP flyer"].tap()
        XCTAssertTrue(el("qr-image").waitForExistence(timeout: 5))
        shot("link-qr")
        app.buttons["Done"].tap()
        tab("Settings")
        shot("settings")
    }

    func testCaptureCancelFlow() {
        index = 20
        launch(as: "hassan@local.test")
        tap("booking-Tyler Brooks")
        tap("cancel-appointment")
        shot("cancel-confirm")
        tapDialogButton("Cancel appointment", id: "confirm-cancel")
        XCTAssertTrue(el("cancelled-title").waitForExistence(timeout: 5))
        shot("cancel-text-customer")
    }

    func testCaptureManagerScreens() {
        index = 30
        launch(as: "ali@local.test")
        XCTAssertTrue(el("chair-hassan").waitForExistence(timeout: 5))
        shot("manager-schedule")
        tab("Barbers")
        XCTAssertTrue(el("barber-hassan").waitForExistence(timeout: 5))
        shot("barbers")
        tap("barber-larry")
        XCTAssertTrue(el("barber-hours").waitForExistence(timeout: 5))
        shot("barber-detail")
        app.swipeUp()
        shot("barber-detail-login-grants")
        tap("deactivate")
        XCTAssertTrue(el("deactivate-count").waitForExistence(timeout: 5))
        shot("barber-deactivate")
        app.buttons["Keep active"].tap()
        back()
        tap("add-barber")
        type("barber-name", "Marco Silva")
        app.keyboards.buttons["return"].tap()
        shot("barber-new")
        app.swipeUp()
        shot("barber-new-hours")
    }
}
