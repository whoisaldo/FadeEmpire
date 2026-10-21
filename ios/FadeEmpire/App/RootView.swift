import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            Color.ink.ignoresSafeArea()
            switch app.phase {
            case .starting:
                ProgressView().accessibilityLabel("Loading")
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
    /// The refresh rule for every list: on appear, pull-to-refresh, foregrounding,
    /// and every 60 seconds while the list is on screen.
    func autoRefresh(_ load: @escaping @MainActor () async -> Void) -> some View {
        modifier(AutoRefresh(load: load))
    }
}

private struct AutoRefresh: ViewModifier {
    let load: @MainActor () async -> Void
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
    }
}
