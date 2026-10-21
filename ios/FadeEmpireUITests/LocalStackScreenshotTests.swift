import XCTest

/// The main screens with real data from the local Supabase stack, signed in as Hassan and
/// as Ali. Needs a Debug-Local build and runs only from ios/scripts/local-stack-screenshots.sh,
/// which sets LOCAL_SHOTS_DIR. Nothing is changed: the flows only open screens.
final class LocalStackScreenshotTests: MockUITestCase {
    private var dir: URL!
    private var prefix = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let path = env["LOCAL_SHOTS_DIR"], !path.isEmpty else { throw XCTSkip("LOCAL_SHOTS_DIR not set") }
        dir = URL(fileURLWithPath: path)
        prefix = env["SCREENSHOT_PREFIX"] ?? "iphone"
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    private func shot(_ name: String) {
        sleep(2)
        let file = dir.appendingPathComponent("\(prefix)-\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: file)
    }

    private func back() { app.navigationBars.buttons.element(boundBy: 0).tap() }

    /// Launches the real app (no mock arguments) at the sign-in screen, signing out first
    /// when a session survived the last run.
    private func launchSignedOut() {
        app = XCUIApplication()
        app.launch()
        let email = el("signin-email")
        let tabs = app.tabBars.firstMatch
        let deadline = Date().addingTimeInterval(60)
        while !email.exists && !tabs.exists && Date() < deadline { sleep(1) }
        if tabs.exists { signOut() }
        XCTAssertTrue(email.waitForExistence(timeout: 30))
    }

    private func signIn(_ email: String) {
        type("signin-email", email)
        type("signin-password", "fade-local-1")
        tap("signin-submit")
        let signedIn = app.tabBars.buttons["Schedule"].waitForExistence(timeout: 60)
        XCTAssertTrue(signedIn, "sign-in as \(email) failed: \(el("error-message").exists ? el("error-message").label : "no message")")
    }

    private func signOut() {
        tab("Settings")
        tap("sign-out")
        tapDialogButton("Sign out", id: "confirm-sign-out")
        XCTAssertTrue(el("signin-email").waitForExistence(timeout: 30))
    }

    /// The visible strip day with the most appointments, so the list shows real bookings.
    private func busiestDay() {
        let days = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'day-2' AND label CONTAINS ' appointment'"))
        XCTAssertTrue(days.firstMatch.waitForExistence(timeout: 30))
        func count(_ e: XCUIElement) -> Int {
            let parts = e.label.components(separatedBy: ", ")
            return parts.last.flatMap { Int($0.components(separatedBy: " ").first ?? "") } ?? 0
        }
        let best = days.allElementsBoundByIndex.filter(\.isHittable).max { count($0) < count($1) }
        best?.tap()
        sleep(2)
    }

    private var firstBooking: XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'booking-'")).firstMatch
    }

    func testHassanScreens() {
        launchSignedOut()
        shot("01-sign-in")
        signIn("hassan@local.test")
        busiestDay()
        shot("02-schedule")
        XCTAssertTrue(firstBooking.waitForExistence(timeout: 30))
        firstBooking.tap()
        XCTAssertTrue(el("cancel-appointment").waitForExistence(timeout: 30) || el("undo-no-show").exists
                      || app.staticTexts["Cancelled"].exists)
        shot("03-appointment")
        back()
        tap("new-appointment")
        sleep(3)
        shot("04-new-appointment")
        app.buttons["Close"].tap()
        app.swipeDown()
        tap("chair-larry")
        XCTAssertTrue(app.staticTexts["Larry's chair"].waitForExistence(timeout: 30))
        busiestDay()
        shot("05-schedule-larry-view-only")
        XCTAssertTrue(firstBooking.waitForExistence(timeout: 30))
        firstBooking.tap()
        XCTAssertTrue(app.staticTexts["View only"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Call'")).firstMatch.exists)
        shot("06-appointment-view-only")
        back()
        app.swipeDown()
        tap("chair-hassan")
        tap("open-days-off")
        sleep(3)
        shot("07-days-off")
        app.buttons["Done"].tap()
        tab("Activity")
        sleep(3)
        shot("08-activity")
        tab("Links")
        XCTAssertTrue(el("add-link").waitForExistence(timeout: 30))
        shot("09-links")
        tab("Settings")
        shot("10-settings")
        signOut()
    }

    func testManagerScreens() {
        launchSignedOut()
        signIn("ali@local.test")
        busiestDay()
        shot("21-manager-schedule")
        tab("Barbers")
        XCTAssertTrue(el("barber-larry").waitForExistence(timeout: 30))
        shot("22-barbers")
        tap("barber-larry")
        XCTAssertTrue(el("barber-hours").waitForExistence(timeout: 30))
        shot("23-barber-detail")
        app.swipeUp()
        shot("24-barber-login-grants")
        app.swipeDown()
        tap("edit-barber")
        sleep(2)
        shot("25-barber-edit")
        app.swipeUp()
        shot("26-barber-edit-hours")
        app.buttons["Close"].tap()
        tab("Activity")
        sleep(3)
        shot("27-manager-activity")
        signOut()
    }
}
