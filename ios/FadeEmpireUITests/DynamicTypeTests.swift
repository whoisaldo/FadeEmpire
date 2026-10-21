import XCTest

/// The largest accessibility text size on the mock: action labels stay whole words. Screens are
/// attached to the result and, with DYNAMIC_TYPE_SHOTS_DIR set (TEST_RUNNER_DYNAMIC_TYPE_SHOTS_DIR
/// for xcodebuild), written there too.
final class DynamicTypeTests: MockUITestCase {
    private let largest = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

    private func shot(_ name: String) {
        sleep(1)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let path = ProcessInfo.processInfo.environment["DYNAMIC_TYPE_SHOTS_DIR"], !path.isEmpty else { return }
        let dir = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? png.write(to: dir.appendingPathComponent("\(name).png"))
    }

    /// One line of the buttons' text at this size is about 60 pt tall; a label broken onto a
    /// second line makes its button about twice that.
    private let oneLineButton: CGFloat = 100

    func testLargestTextKeepsActionLabelsWhole() {
        launch(as: "hassan@local.test", extra: largest)
        XCTAssertTrue(el("day-header").waitForExistence(timeout: 10))
        shot("schedule")
        app.swipeUp()
        shot("schedule-appointments")

        tap("booking-Tyler Brooks", timeout: 3)   // below the fold at this size: scrolls to it
        let call = el("detail-call"), text = el("detail-text")
        XCTAssertTrue(call.waitForExistence(timeout: 5))
        print("Call \(call.frame), Text \(text.frame)")
        shot("appointment-detail")
        XCTAssertGreaterThanOrEqual(text.frame.minY, call.frame.maxY - 1, "Text stacks under Call")
        XCTAssertEqual(call.frame.width, text.frame.width, accuracy: 1, "each the row's full width")
        XCTAssertLessThan(call.frame.height, oneLineButton, "\"Call\" on one line")
        XCTAssertLessThan(text.frame.height, oneLineButton, "\"Text\" on one line")

        app.navigationBars.buttons.element(boundBy: 0).tap()
        tab("Links")
        let copy = app.buttons["Copy link Hassan's booking page"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        for label in ["Copy link Hassan's booking page", "Share link Hassan's booking page", "QR code for Hassan's booking page"] {
            let button = app.buttons[label].firstMatch
            print("\(label) \(button.frame)")
            XCTAssertLessThan(button.frame.height, oneLineButton, label)
        }
        for _ in 0..<4 where !app.buttons["QR code for Hassan's booking page"].isHittable { app.swipeUp() }
        shot("links")
    }

    /// The other screens at this size, for a look: not asserted beyond loading.
    func testLargestTextOtherScreens() {
        launch(as: "ali@local.test", extra: largest)
        XCTAssertTrue(app.tabBars.buttons["Barbers"].waitForExistence(timeout: 10))
        tap("chair-larry")
        shot("schedule-manager-larry")
        tab("Barbers")
        tap("barber-larry")
        XCTAssertTrue(el("edit-barber").waitForExistence(timeout: 10))
        shot("barber-detail")
        tap("edit-barber")
        _ = reveal("hours-1")
        shot("barber-editor-hours")
        app.buttons["Close"].firstMatch.tap()
        tab("Activity")
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
        shot("activity")
        tab("Settings")
        shot("settings")
        tab("Schedule")
        tap("new-appointment")
        tap("newday-2026-10-23")
        shot("new-appointment")
    }
}
