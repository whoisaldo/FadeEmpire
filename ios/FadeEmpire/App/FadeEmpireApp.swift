import SwiftUI
import UIKit
import UserNotifications

/// Launch arguments for previews, UI tests and screenshots:
/// `-mock-backend` uses `MockBackend`; with it, `-mock-now 2026-10-22T13:00` pins the clock
/// (shop time) and `-mock-session hassan@local.test` starts signed in.
enum LaunchOptions {
    static let arguments = ProcessInfo.processInfo.arguments

    static var useMock: Bool { arguments.contains("-mock-backend") }

    static func value(_ flag: String) -> String? {
        guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }
        return arguments[i + 1]
    }

    /// "2026-10-22T13:00", read as shop time.
    static func parseShopDateTime(_ raw: String) -> Date? {
        let parts = raw.split(separator: "T")
        guard parts.count == 2, let day = ShopDay(iso: String(parts[0])), let time = ShopTime(hms: String(parts[1])) else { return nil }
        return day.at(time)
    }

    @MainActor static func makeModel() -> AppModel {
        if useMock {
            let clock: ShopClock
            if let pinned = value("-mock-now").flatMap(parseShopDateTime) {
                // The pinned instant moves forward with real time, so "booked just now" stays true.
                let start = Date()
                clock = ShopClock { pinned.addingTimeInterval(Date().timeIntervalSince(start)) }
            } else {
                clock = .system
            }
            if arguments.contains("-disable-animations") { UIView.setAnimationsEnabled(false) }
            return AppModel(backend: MockBackend(clock: clock, signedInAs: value("-mock-session")), clock: clock)
        }
        let info = Bundle.main.infoDictionary ?? [:]
        let url = URL(string: info["FESupabaseURL"] as? String ?? "")!
        let key = info["FESupabaseKey"] as? String ?? ""
        let environment = info["FEPushEnvironment"] as? String ?? "sandbox"
        return AppModel(backend: SupabaseBackend(url: url, key: key), pushEnvironment: environment, usesPush: true)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var onToken: ((Data) -> Void)?
    var onPush: (() -> Void)?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        onToken?(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    /// A push while the app is open shows as a banner and refreshes what is on screen.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        await MainActor.run { onPush?() }
        return [.banner, .sound, .list]
    }

    static func registerForPush() {
        Task {
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if granted { await MainActor.run { UIApplication.shared.registerForRemoteNotifications() } }
        }
    }
}

@main
struct FadeEmpireApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = LaunchOptions.makeModel()
    @Environment(\.scenePhase) private var scenePhase

    init() { Theme.applyAppearance() }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(.gold)
                .task {
                    delegate.onToken = { token in Task { await model.deviceTokenReceived(token) } }
                    delegate.onPush = { Task { await model.refresh() } }
                    await model.start()
                }
                .onChange(of: model.phase) { _, phase in
                    if phase == .ready, model.usesPush { AppDelegate.registerForPush() }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.refresh() } }
                }
        }
    }
}
