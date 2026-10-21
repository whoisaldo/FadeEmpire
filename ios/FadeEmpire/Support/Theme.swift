import SwiftUI
import UIKit

/// The website's palette (styles/tokens.css): warm ink, bone text, brass used sparingly.
extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }

    static let ink = Color(hex: 0x0A0908)
    static let ink2 = Color(hex: 0x14110F)
    static let ink3 = Color(hex: 0x1E1A16)
    static let bone = Color(hex: 0xEDE6D6)
    static let boneSoft = Color(hex: 0xEDE6D6, opacity: 0.68)
    static let rule = Color(hex: 0xEDE6D6, opacity: 0.12)
    static let gold = Color(hex: 0xC8A24A)
    static let goldPale = Color(hex: 0xE0C078)
    static let goldSoft = Color(hex: 0xC8A24A, opacity: 0.18)
    static let danger = Color(hex: 0xE07A6B)
    static let success = Color(hex: 0x8FBE92)
}

extension Font {
    /// Fraunces (bundled under the OFL) for big headings only; it scales with Dynamic Type.
    static func display(_ size: CGFloat, relativeTo style: Font.TextStyle = .title) -> Font {
        .custom("Fraunces72pt-SemiBold", size: size, relativeTo: style)
    }
}

enum Theme {
    /// Bars drawn on ink. Every screen uses inline titles; Fraunces is for headings in the content.
    static func applyAppearance() {
        let bone = UIColor(Color.bone)
        let nav = UINavigationBarAppearance()
        nav.configureWithOpaqueBackground()
        nav.backgroundColor = UIColor(Color.ink)
        nav.shadowColor = UIColor(Color.rule)
        nav.titleTextAttributes = [.foregroundColor: bone]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = UIColor(Color.ink2)
        tab.shadowColor = UIColor(Color.rule)
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
    }
}

/// The one filled button style: brass, used for the main action on a screen.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(Color.ink)
            .background(Color.gold.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.35),
                        in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
    }
}

/// Outlined button for secondary actions (Call, Text, Copy).
struct OutlineButtonStyle: ButtonStyle {
    var tint: Color = .bone

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(tint)
            .background(configuration.isPressed ? Color.ink3 : Color.ink2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.rule))
            .contentShape(Rectangle())
    }
}

extension View {
    /// Ink page background behind lists and forms.
    func inkBackground() -> some View {
        scrollContentBackground(.hidden).background(Color.ink.ignoresSafeArea())
    }
}

/// A small status label ("Cancelled", "No-show", "View only").
struct Tag: View {
    let text: String
    var color: Color = .boneSoft

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(color)
            .overlay(Capsule().stroke(color.opacity(0.6)))
    }
}

/// Inline error line shown above a form's action.
struct ErrorText: View {
    let message: String?

    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.callout)
                .foregroundStyle(Color.danger)
                .accessibilityIdentifier("error-message")
        }
    }
}
