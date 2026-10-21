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
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(tint)
            .background(configuration.isPressed ? Color.ink3 : Color.ink2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.rule))
            .contentShape(Rectangle())
    }
}

/// Buttons side by side in equal columns while each label fits its column on one line, stacked
/// full width when one doesn't (the accessibility text sizes), so a label never breaks inside a word.
struct ActionRow<Content: View>: View {
    var spacing: CGFloat = 10
    @ViewBuilder let content: Content

    var body: some View {
        ActionRowLayout(spacing: spacing) { content }.labelStyle(ActionLabelStyle())
    }
}

/// Icon and title on one line that never wraps, so the width the row measures is the width it
/// draws (the default style measured narrower and then broke "Call" into "C / all").
struct ActionLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.icon
            configuration.title.fixedSize(horizontal: true, vertical: false)
        }
    }
}

struct ActionRowLayout: Layout {
    var spacing: CGFloat

    /// The column width when the row fits side by side, nil when it stacks.
    private func columnWidth(_ width: CGFloat, _ subviews: Subviews) -> CGFloat? {
        let count = CGFloat(max(subviews.count, 1))
        let column = (width - spacing * (count - 1)) / count
        let widest = subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        return widest <= column ? column : nil
    }

    private func frames(_ width: CGFloat, _ subviews: Subviews) -> [CGRect] {
        if let column = columnWidth(width, subviews) {
            let height = subviews.map { $0.sizeThatFits(ProposedViewSize(width: column, height: nil)).height }.max() ?? 0
            return subviews.indices.map { CGRect(x: CGFloat($0) * (column + spacing), y: 0, width: column, height: height) }
        }
        var y: CGFloat = 0
        return subviews.map { view in
            let height = view.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
            defer { y += height + spacing }
            return CGRect(x: 0, y: y, width: width, height: height)
        }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.map { $0.sizeThatFits(.unspecified).width + spacing }.reduce(-spacing, +)
        return CGSize(width: width, height: frames(width, subviews).map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (view, frame) in zip(subviews, frames(bounds.width, subviews)) {
            view.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                       proposal: ProposedViewSize(width: frame.width, height: frame.height))
        }
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
