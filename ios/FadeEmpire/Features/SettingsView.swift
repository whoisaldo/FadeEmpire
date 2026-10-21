import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var changingPassword = false
    @State private var confirmingSignOut = false
    @State private var error: String?

    private var viewedChairNames: String {
        app.chairs.filter { !$0.canManage }.map(\.displayName).joined(separator: ", ")
    }

    var body: some View {
        NavigationStack {
            List {
                if let me = app.me {
                    Section {
                        LabeledContent("Name", value: me.displayName)
                        if let email = app.email { LabeledContent("Email", value: email) }
                        LabeledContent("Role", value: me.isManager ? "Manager" : "Barber")
                    }
                    .listRowBackground(Color.ink2)

                    Section {
                        toggle("New bookings", \.notifyBookings, id: "notify-bookings")
                        toggle("Cancellations and no-shows", \.notifyCancellations, id: "notify-cancellations")
                        if me.isManager {
                            toggle("Alerts for every chair", \.notifyViewedChairs, id: "notify-viewed")
                        } else if !viewedChairNames.isEmpty {
                            toggle("Also for \(viewedChairNames)'s chair", \.notifyViewedChairs, id: "notify-viewed")
                        }
                        ErrorText(message: error)
                    } header: {
                        Text("Notifications")
                    } footer: {
                        Text(me.isManager
                             ? "With \"every chair\" off you get no alerts. You never get alerts for changes you make."
                             : "You never get alerts for changes you make yourself.")
                    }
                    .listRowBackground(Color.ink2)
                }

                Section {
                    Button("Change password") { changingPassword = true }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("change-password")
                    Button("Sign out", role: .destructive) { confirmingSignOut = true }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("sign-out")
                }
                .listRowBackground(Color.ink2)
            }
            .listStyle(.insetGrouped)
            .inkBackground()
            .navigationTitle("Settings")
            .sheet(isPresented: $changingPassword) { NewPasswordView(forced: false) }
            .confirmationDialog("Sign out?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await app.signOut() } }
            } message: {
                Text("This phone stops getting alerts until you sign in again.")
            }
        }
    }

    private func toggle(_ title: String, _ key: WritableKeyPath<Me, Bool>, id: String) -> some View {
        Toggle(title, isOn: Binding(
            get: { app.me?[keyPath: key] ?? false },
            set: { on in
                guard var prefs = app.me else { return }
                prefs[keyPath: key] = on
                Task {
                    do {
                        try await app.setNotifyPrefs(bookings: prefs.notifyBookings, cancellations: prefs.notifyCancellations,
                                                     viewedChairs: prefs.notifyViewedChairs)
                        error = nil
                    } catch {
                        self.error = app.handle(error)
                    }
                }
            }))
        .frame(minHeight: 44)
        .accessibilityIdentifier(id)
    }
}
