import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focus: Field?

    enum Field { case email, password }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image("Knight")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 96)
                    .frame(maxWidth: .infinity)
                    .accessibilityHidden(true)
                    .padding(.top, 48)
                Text("Fade Empire")
                    .font(.display(34, relativeTo: .largeTitle))
                    .foregroundStyle(Color.bone)
                    .frame(maxWidth: .infinity)
                    .accessibilityAddTraits(.isHeader)
                Text("Sign in with the login Ali set up for you.")
                    .font(.callout)
                    .foregroundStyle(Color.boneSoft)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)

                VStack(spacing: 12) {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                        .fieldStyle()
                        .accessibilityIdentifier("signin-email")
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit(submit)
                        .fieldStyle()
                        .accessibilityIdentifier("signin-password")
                }
                ErrorText(message: error)
                Button(action: submit) {
                    if busy { ProgressView().tint(Color.ink) } else { Text("Sign in") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy || email.isEmpty || password.isEmpty)
                .accessibilityIdentifier("signin-submit")
                Text("Forgot your password? Ask Ali to reset it.")
                    .font(.footnote)
                    .foregroundStyle(Color.boneSoft)
                    .frame(maxWidth: .infinity)
            }
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func submit() {
        guard !busy, !email.isEmpty, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            do { try await app.signIn(email: email, password: password) } catch { self.error = app.handle(error) }
            busy = false
        }
    }
}

/// Used for the forced change at first sign-in and from Settings.
struct NewPasswordView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let forced: Bool
    @State private var password = ""
    @State private var confirm = ""
    @State private var error: String?
    @State private var busy = false

    private var mismatch: Bool { !confirm.isEmpty && password != confirm }
    private var ready: Bool { password.count >= 8 && password == confirm }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(forced ? "Choose your password" : "Change password")
                    .font(.display(30, relativeTo: .largeTitle))
                    .foregroundStyle(Color.bone)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, forced ? 48 : 8)
                Text(forced
                     ? "You signed in with a temporary password. Pick your own to continue: at least 8 characters."
                     : "At least 8 characters.")
                    .font(.callout)
                    .foregroundStyle(Color.boneSoft)
                SecureField("New password", text: $password)
                    .textContentType(.newPassword)
                    .fieldStyle()
                    .accessibilityIdentifier("newpassword-field")
                SecureField("New password again", text: $confirm)
                    .textContentType(.newPassword)
                    .fieldStyle()
                    .accessibilityIdentifier("newpassword-confirm")
                if mismatch {
                    Text("The two passwords don't match.").font(.callout).foregroundStyle(Color.danger)
                }
                ErrorText(message: error)
                Button(action: submit) {
                    if busy { ProgressView().tint(Color.ink) } else { Text("Save password") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!ready || busy)
                .accessibilityIdentifier("newpassword-submit")
                if forced {
                    Button("Sign out") { Task { await app.signOut() } }
                        .buttonStyle(OutlineButtonStyle())
                }
            }
            .padding(24)
        }
        .background(Color.ink.ignoresSafeArea())
    }

    private func submit() {
        busy = true
        error = nil
        Task {
            do {
                try await app.changePassword(password)
                if !forced { dismiss() }
            } catch {
                self.error = app.handle(error)
            }
            busy = false
        }
    }
}

extension View {
    /// Text field on ink: tall enough for a thumb, with a hairline border.
    func fieldStyle() -> some View {
        padding(.horizontal, 14)
            .frame(minHeight: 52)
            .background(Color.ink2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.rule))
            .foregroundStyle(Color.bone)
    }
}
