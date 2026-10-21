import Network
import SwiftUI
import UIKit
import UserNotifications

/// Launch arguments for previews, UI tests and screenshots:
/// `-mock-backend` uses `MockBackend`; with it, `-mock-now 2026-10-22T13:00` pins the clock
/// (shop time), `-mock-session hassan@local.test` starts signed in, and
/// `-mock-must-change hassan@local.test` makes that login pick a new password (as after a reset), and
/// `-mock-fault me:network:1,barberSchedule:network:*` makes those calls fail (count, or `*` for every call).
/// A push tap without SpringBoard: `-mock-open-push '<payload JSON>'` is tapped at cold launch, and
/// `-mock-warm-push '<payload JSON>'` is tapped the next time the app comes back from the background.
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

    /// A notification's custom keys as JSON, read the way APNs hands them to the delegate.
    static func pushPayload(_ flag: String) -> [AnyHashable: Any]? {
        guard useMock, let raw = value(flag) else { return nil }
        return payload(json: raw)
    }

    static func payload(json: String) -> [AnyHashable: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [AnyHashable: Any]
    }

    /// `call:network|server[:count|*]`, comma-separated; a count of 1 when left out.
    static func parseFaults(_ raw: String) -> [MockBackend.Call: MockBackend.Fault] {
        var faults: [MockBackend.Call: MockBackend.Fault] = [:]
        for item in raw.split(separator: ",") {
            let parts = item.split(separator: ":").map(String.init)
            guard parts.count >= 2, let call = MockBackend.Call(rawValue: parts[0]) else { continue }
            let error: BackendError = parts[1] == "network" ? .network : .server(parts[1])
            let times: Int? = parts.count > 2 ? (parts[2] == "*" ? nil : Int(parts[2]) ?? 1) : 1
            faults[call] = MockBackend.Fault(error: error, times: times)
        }
        return faults
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
            let backend = MockBackend(clock: clock, signedInAs: value("-mock-session"),
                                      mustChangePassword: Set([value("-mock-must-change")].compactMap { $0 }),
                                      faults: value("-mock-fault").map(parseFaults) ?? [:])
            return AppModel(backend: backend, clock: clock)
        }
        let info = Bundle.main.infoDictionary ?? [:]
        let url = URL(string: info["FESupabaseURL"] as? String ?? "")!
        let key = info["FESupabaseKey"] as? String ?? ""
        return AppModel(backend: SupabaseBackend(url: url, key: key), pushEnvironment: PushEnvironment.current(), usesPush: true)
    }
}

/// The APNs environment the device token belongs to, which the provisioning profile decides, not
/// the build configuration: a Release build run from Xcode is signed for development and gets a
/// sandbox token. App Store and TestFlight installs carry no `embedded.mobileprovision`.
enum PushEnvironment {
    static func current() -> String {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        return from(provisioningProfile: profile)
        #endif
    }

    /// The profile is a signed envelope around a plist whose `Entitlements` name the environment:
    /// `production` for ad hoc and distribution profiles, `development` otherwise.
    static func from(provisioningProfile data: Data?) -> String {
        guard let data else { return "production" }
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: data[start.lowerBound..<end.upperBound], format: nil),
              let entitlements = (plist as? [String: Any])?["Entitlements"] as? [String: Any]
        else { return "sandbox" }
        return entitlements["aps-environment"] as? String == "production" ? "production" : "sandbox"
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var onToken: ((Data) -> Void)?
    var onPush: (() -> Void)?
    var onOpen: ((PushRoute) -> Void)? {
        didSet {
            guard let onOpen, let route = waitingRoute else { return }
            waitingRoute = nil
            onOpen(route)
        }
    }
    /// A push tapped at cold launch arrives before the root view installs `onOpen`.
    private var waitingRoute: PushRoute?

    func open(_ route: PushRoute) {
        if let onOpen { onOpen(route) } else { waitingRoute = route }
    }

    /// Every tapped notification comes through here: the real delegate below, and the mock's
    /// launch arguments for tests.
    func handleTap(userInfo: [AnyHashable: Any]) {
        guard let route = PushRoute(userInfo: userInfo) else { return }
        open(route)
    }

    /// The mock's warm tap, waiting for the app to come back from the background.
    private var warmTap = LaunchOptions.pushPayload("-mock-warm-push")

    func returnedFromBackground() {
        guard let payload = warmTap else { return }
        warmTap = nil
        handleTap(userInfo: payload)
    }

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // The mock's cold-launch tap, arriving before the root view is up, as a real one does.
        if let payload = LaunchOptions.pushPayload("-mock-open-push") { handleTap(userInfo: payload) }
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

    /// Tapping a push opens that booking's day on that chair.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        await MainActor.run { handleTap(userInfo: userInfo) }
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
    @State private var wasInBackground = false

    init() { Theme.applyAppearance() }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(.gold)
                .task {
                    delegate.onToken = { token in Task { await model.deviceTokenReceived(token) } }
                    delegate.onPush = { Task { await model.pushReceived() } }
                    delegate.onOpen = { route in Task { @MainActor in model.open(route) } }
                    await model.start()
                }
                .task { await watchNetwork() }
                .onChange(of: model.phase) { _, phase in
                    if phase == .ready, model.usesPush { AppDelegate.registerForPush() }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { wasInBackground = true }
                    if phase == .active {
                        if wasInBackground { delegate.returnedFromBackground() }
                        wasInBackground = false
                        Task { await model.refresh() }
                    }
                }
        }
    }

    /// Tells the model each time the network path changes, so a launch that found no network
    /// tries again once it is back.
    private func watchNetwork() async {
        let monitor = NWPathMonitor()
        let updates = AsyncStream<Bool> { continuation in
            monitor.pathUpdateHandler = { continuation.yield($0.status == .satisfied) }
            monitor.start(queue: DispatchQueue(label: "network-path"))
        }
        for await isUp in updates { await model.networkChanged(isUp: isUp) }
        monitor.cancel()
    }
}
