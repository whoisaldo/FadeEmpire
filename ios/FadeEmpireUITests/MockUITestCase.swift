import XCTest

/// Launch and query helpers for tests on the MockBackend, pinned to Thursday Oct 22, 2026,
/// 1:00 PM shop time.
class MockUITestCase: XCTestCase {
    var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
    }

    @discardableResult
    func launch(as email: String? = nil) -> XCUIApplication {
        app = XCUIApplication()
        app.launchArguments = ["-mock-backend", "-mock-now", "2026-10-22T13:00", "-disable-animations"]
        if let email { app.launchArguments += ["-mock-session", email] }
        app.launch()
        return app
    }

    func el(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    /// Waits for the element, scrolling down when a list has not drawn it yet.
    func reveal(_ id: String, timeout: TimeInterval = 5) -> XCUIElement {
        let e = el(id)
        if !e.waitForExistence(timeout: timeout) {
            for _ in 0..<10 where !e.exists { app.swipeUp() }
        }
        XCTAssertTrue(e.exists, "missing \(id)")
        if !e.isHittable { app.swipeUp() }
        return e
    }

    func tap(_ id: String, timeout: TimeInterval = 5) {
        reveal(id, timeout: timeout).tap()
    }

    func element(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func type(_ id: String, _ text: String) {
        tap(id)
        el(id).typeText(text)
    }

    func tab(_ name: String) { app.tabBars.buttons[name].firstMatch.tap() }

    /// The button in a confirmation dialog or alert. Its label repeats the button that opened
    /// it, so prefer the dialog's identifier and fall back to the last match.
    func tapDialogButton(_ label: String, id: String? = nil) {
        if let id {
            // iOS can draw the dialog's button twice (popover and its accessibility copy).
            let matches = app.buttons.matching(identifier: id)
            if matches.firstMatch.waitForExistence(timeout: 2) {
                (matches.allElementsBoundByIndex.first(where: \.isHittable) ?? matches.firstMatch).tap()
                return
            }
        }
        let all = app.buttons.matching(NSPredicate(format: "label == %@", label))
        XCTAssertTrue(all.firstMatch.waitForExistence(timeout: 3), "no dialog button \(label)")
        all.element(boundBy: all.count - 1).tap()
    }
}
