import XCTest

/// Launch and query helpers for tests on the MockBackend, pinned to Thursday Oct 22, 2026,
/// 1:00 PM shop time.
class MockUITestCase: XCTestCase {
    var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
    }

    @discardableResult
    func launch(as email: String? = nil, extra: [String] = []) -> XCUIApplication {
        app = XCUIApplication()
        app.launchArguments = ["-mock-backend", "-mock-now", "2026-10-22T13:00", "-disable-animations"] + extra
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
        focus(id).typeText(text)
    }

    /// Taps the field until it has keyboard focus. The tap can land before the field takes focus
    /// on a loaded machine, or on the keyboard's toolbar when the field sits under it (the
    /// previous field keeps focus); then the keyboard goes away and it taps again.
    @discardableResult
    func focus(_ id: String, attempts: Int = 3, timeout: TimeInterval = 10) -> XCUIElement {
        let field = reveal(id)
        let focused = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ AND hasKeyboardFocus == true", id)).firstMatch
        for _ in 0..<attempts {
            field.tap()
            if focused.waitForExistence(timeout: timeout) { return field }
            dismissKeyboard()
            if !field.isHittable { app.swipeUp() }
        }
        XCTFail("\(id) never got keyboard focus after \(attempts) taps")
        return field
    }

    /// The keyboard toolbar's Done (the phone pad has no return key), else the return key.
    func dismissKeyboard() {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }
        let done = el("keyboard-done"), ret = keyboard.buttons["return"]
        if done.exists { done.tap() } else if ret.exists { ret.tap() }
        _ = keyboard.waitForNonExistence(timeout: 5)
    }

    /// Taps an element found by something other than its identifier once it is there.
    func tapWhenPresent(_ e: XCUIElement, _ what: String, timeout: TimeInterval = 5) {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "missing \(what)")
        e.tap()
    }

    func tab(_ name: String) { tapWhenPresent(app.tabBars.buttons[name].firstMatch, "tab \(name)", timeout: 10) }

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
