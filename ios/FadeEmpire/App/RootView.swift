import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            Color.ink.ignoresSafeArea()
            switch app.phase {
            case .starting:
                ProgressView().accessibilityLabel("Loading")
            case .offline:
                OfflineView()
            case .signedOut:
                SignInView()
            case .changePassword:
                NewPasswordView(forced: true)
            case .ready:
                MainTabs()
            }
        }
    }
}

/// Launch could not reach the server. The session stays; the app tries again on its own.
private struct OfflineView: View {
    @Environment(AppModel.self) private var app

    private var detail: String {
        if case .server(let code)? = app.launchError {
            return "The shop's system answered with an error (\(code)). You're still signed in. Try again in a minute."
        }
        return "Check the phone's internet connection. You're still signed in; the app tries again when the connection is back."
    }

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.exclamationmark")
                .font(.largeTitle)
                .foregroundStyle(Color.goldPale)
                .accessibilityHidden(true)
            Text("Can't reach the shop's system")
                .font(.display(26, relativeTo: .title))
                .foregroundStyle(Color.bone)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("offline-title")
            Text(detail)
                .font(.callout)
                .foregroundStyle(Color.boneSoft)
                .multilineTextAlignment(.center)
            Button { Task { await app.retryLaunch() } } label: {
                if app.retrying { ProgressView().tint(Color.ink) } else { Text("Try again") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(app.retrying)
            .accessibilityIdentifier("offline-retry")
        }
        .padding(24)
    }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        TabView(selection: $app.tab) {
            ScheduleView()
                .tabItem { Label("Schedule", systemImage: "calendar") }
                .tag(AppTab.schedule)
            ActivityView()
                .tabItem {
                    // The iOS 26 tab bar does not read the badge out, so VoiceOver gets it here.
                    Label("Activity", systemImage: "bell")
                        .accessibilityValue(app.unreadCount > 0 ? "\(app.unreadCount) unread" : "")
                }
                .badge(app.unreadCount)
                .tag(AppTab.activity)
            LinksView()
                .tabItem { Label("Links", systemImage: "link") }
                .tag(AppTab.links)
            if app.isManager {
                BarbersView()
                    .tabItem { Label("Barbers", systemImage: "person.2") }
                    .tag(AppTab.barbers)
            }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
    }
}

extension View {
    /// The refresh rule for every list: on appear, pull-to-refresh, foregrounding, a push
    /// arriving while the app is open, and every 60 seconds while the list is on screen.
    func autoRefresh(_ load: @escaping @MainActor () async -> Void) -> some View {
        modifier(AutoRefresh(load: load))
    }
}

private struct AutoRefresh: ViewModifier {
    let load: @MainActor () async -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .refreshable { await load() }
            .task {
                await load()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(60))
                    if Task.isCancelled { break }
                    await load()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await load() } }
            }
            .onChange(of: app.pushCount) { _, _ in Task { await load() } }
    }
}
