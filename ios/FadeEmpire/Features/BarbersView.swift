import PhotosUI
import SwiftUI

struct BarbersView: View {
    @Environment(AppModel.self) private var app
    @State private var model: BarbersModel?

    var body: some View {
        Group {
            if let model { BarbersList(model: model) } else { Color.ink.ignoresSafeArea() }
        }
        .onAppear { if model == nil { model = BarbersModel(app: app) } }
    }
}

private struct BarbersList: View {
    let model: BarbersModel
    @State private var adding = false
    @State private var path: [UUID] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error = model.error { ErrorText(message: error).listRowBackground(Color.ink2) }
                ForEach(model.sorted) { b in
                    NavigationLink(value: b.id) {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(b.displayName).font(.headline).foregroundStyle(b.isActive ? Color.bone : Color.boneSoft)
                                if !b.isActive { Tag(text: "Inactive") }
                            }
                            Text([b.title, "/\(b.slug)", loginSummary(b)].compactMap { $0 }.joined(separator: " · "))
                                .font(.subheadline)
                                .foregroundStyle(Color.boneSoft)
                        }
                        .padding(.vertical, 4)
                    }
                    .listRowBackground(Color.ink2)
                    .accessibilityIdentifier("barber-\(b.slug)")
                }
            }
            .listStyle(.insetGrouped)
            .inkBackground()
            .navigationTitle("Barbers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { adding = true } label: { Label("Add barber", systemImage: "plus") }
                        .accessibilityIdentifier("add-barber")
                }
            }
            .navigationDestination(for: UUID.self) { BarberDetailView(model: model, barberId: $0) }
            .autoRefresh { await model.load() }
            .sheet(isPresented: $adding) {
                BarberEditorView(model: model, barber: nil) { id, _ in path = [id] }
            }
        }
    }

    private func loginSummary(_ b: Barber) -> String {
        guard let login = model.login(for: b.id) else { return "No login" }
        return login.isDisabled ? "Login off" : "Has login"
    }
}

struct BarberDetailView: View {
    let model: BarbersModel
    let barberId: UUID
    @State private var editing = false
    @State private var creatingLogin = false
    @State private var tempPassword: TempPassword?
    @State private var deactivating: [Booking]?
    @State private var notice: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        if let b = model.barber(barberId) {
            content(b)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.ink)
        }
    }

    private func content(_ b: Barber) -> some View {
        let login = model.login(for: b.id)
        return List {
            Section {
                HStack(spacing: 14) {
                    AsyncImage(url: b.photoUrl.flatMap(URL.init(string:))) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Image(systemName: "person.crop.square").font(.largeTitle).foregroundStyle(Color.boneSoft)
                    }
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(b.displayName).font(.display(26, relativeTo: .title)).foregroundStyle(Color.bone)
                        Text(b.title ?? "No title").foregroundStyle(Color.boneSoft)
                        Text(BookingLinks.plain(slug: b.slug).absoluteString)
                            .font(.footnote.monospaced()).foregroundStyle(Color.goldPale)
                    }
                }
                if let bio = b.bio { Text(bio).font(.callout).foregroundStyle(Color.boneSoft) }
                Button("Edit profile and hours") { editing = true }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("edit-barber")
            } footer: {
                if !b.isActive { Text("Inactive: hidden from the website and not bookable.") }
            }
            .listRowBackground(Color.ink2)

            Section("Weekly hours") {
                HoursStatus(model: model, barber: b) { hours in
                    Text(HoursDraft.summary(hours))
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(Color.bone)
                        .accessibilityIdentifier("barber-hours")
                }
            }
            .listRowBackground(Color.ink2)

            Section {
                if let login {
                    LabeledContent("Email", value: login.email)
                    LabeledContent("Last sign-in", value: login.lastSignInAt.map { ShopFormat.timestamp($0.date) } ?? "Never")
                    LabeledContent("Status", value: login.isDisabled ? "Turned off" : "On")
                    Button("Reset password") { reset(login) }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("reset-password")
                    Button(login.isDisabled ? "Turn login on" : "Turn login off", role: login.isDisabled ? nil : .destructive) {
                        toggleLogin(login)
                    }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("toggle-login")
                } else {
                    Text("No login yet. \(b.displayName) can't use the app.").foregroundStyle(Color.boneSoft)
                    Button("Create login") { creatingLogin = true }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("create-login")
                }
            } header: {
                Text("App login")
            } footer: {
                if login?.isDisabled == true { Text("Turned off: they can't sign in and get no alerts.") }
            }
            .listRowBackground(Color.ink2)

            let others = model.sorted.filter { $0.id != b.id }
            if !others.isEmpty {
                Section {
                    ForEach(others) { other in
                        Toggle(isOn: Binding(get: { model.canView(viewer: b.id, barber: other.id) },
                                             set: { on in Task { await model.setGrant(viewer: b.id, barber: other.id, granted: on) } })) {
                            Text("\(other.displayName)'s chair" + (other.isActive ? "" : " (inactive)"))
                        }
                        .frame(minHeight: 44)
                        .disabled(!model.grantsLoaded)
                        .accessibilityIdentifier("grant-\(other.slug)")
                    }
                } header: {
                    Text("Can also view")
                } footer: {
                    Text(model.grantsLoaded
                         ? "Read-only: \(b.displayName) sees those appointments but can't change them."
                         : "Can't load who can view which chair, so these can't be changed right now.")
                        .accessibilityIdentifier("grants-footer")
                }
                .listRowBackground(Color.ink2)
            }

            Section {
                ErrorText(message: error)
                if b.isActive {
                    Button("Deactivate \(b.displayName)", role: .destructive) { startDeactivate(b) }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("deactivate")
                } else {
                    Button("Reactivate \(b.displayName)") { reactivate(b) }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("reactivate")
                }
            }
            .listRowBackground(Color.ink2)
            .disabled(busy)
        }
        .listStyle(.insetGrouped)
        .inkBackground()
        .navigationTitle(b.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editing) {
            BarberEditorView(model: model, barber: b) { id, outside in
                notice = BarbersModel.outsideHoursNotice(name: model.barber(id)?.displayName ?? b.displayName, count: outside)
            }
        }
        .sheet(isPresented: $creatingLogin) {
            CreateLoginView(model: model, barber: b) { tempPassword = $0 }
        }
        .sheet(item: $tempPassword) { TempPasswordView(item: $0) }
        .sheet(isPresented: Binding(get: { deactivating != nil }, set: { if !$0 { deactivating = nil } })) {
            DeactivateView(barber: b, upcoming: deactivating ?? []) { deactivate(b) }
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") {}
        }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do { try await work() } catch { self.error = model.app.handle(error) }
            busy = false
        }
    }

    private func reset(_ login: StaffMember) {
        run {
            let pw = try await model.resetPassword(login)
            tempPassword = TempPassword(name: login.displayName, email: login.email, password: pw)
        }
    }

    private func toggleLogin(_ login: StaffMember) {
        run { try await model.setDisabled(login, !login.isDisabled) }
    }

    /// The upcoming bookings come first, so the manager sees who is affected.
    private func startDeactivate(_ b: Barber) {
        run { deactivating = try await model.upcomingBookings(b.id) }
    }

    private func deactivate(_ b: Barber) {
        deactivating = nil
        run {
            let n = try await model.setActive(b.id, false)
            notice = "\(b.displayName) is inactive and off the website. \(n) upcoming booking\(n == 1 ? " is" : "s are") still booked."
        }
    }

    private func reactivate(_ b: Barber) {
        run {
            _ = try await model.setActive(b.id, true)
            notice = "\(b.displayName) is active and bookable on the website again."
        }
    }
}

/// A barber's saved hours once loaded; until then that they are loading, or that they failed
/// to load, with a Retry.
private struct HoursStatus<Loaded: View>: View {
    let model: BarbersModel
    let barber: Barber
    @ViewBuilder let loaded: ([ScheduleDay]) -> Loaded
    @State private var retrying = false

    var body: some View {
        if let hours = model.schedules[barber.id] {
            loaded(hours)
        } else if model.scheduleFailed.contains(barber.id) {
            VStack(alignment: .leading, spacing: 8) {
                ErrorText(message: "Can't load \(barber.displayName)'s hours.")
                Button(retrying ? "Loading…" : "Retry") {
                    retrying = true
                    Task {
                        await model.loadSchedule(barber.id)
                        retrying = false
                    }
                }
                .disabled(retrying)
                .frame(minHeight: 44)
                .accessibilityIdentifier("hours-retry")
            }
        } else {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading \(barber.displayName)'s hours…").foregroundStyle(Color.boneSoft)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("hours-loading")
        }
    }
}

struct TempPassword: Identifiable {
    let name: String
    let email: String
    let password: String
    var id: String { password }
}

/// Shown once; the password is not stored anywhere in the app.
private struct TempPasswordView: View {
    let item: TempPassword
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Temporary password for \(item.name)")
                    .font(.display(26, relativeTo: .title))
                    .foregroundStyle(Color.bone)
                    .accessibilityAddTraits(.isHeader)
                LabeledContent("Email", value: item.email).foregroundStyle(Color.bone)
                Text(item.password)
                    .font(.title2.monospaced().weight(.semibold))
                    .foregroundStyle(Color.goldPale)
                    .textSelection(.enabled)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.ink2, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("temp-password")
                Text("Shown only this once. Give it to \(item.name) in person; the app asks them to pick their own at first sign-in. No email is sent.")
                    .font(.callout)
                    .foregroundStyle(Color.boneSoft)
                Button(copied ? "Copied" : "Copy password") {
                    UIPasteboard.general.string = item.password
                    copied = true
                }
                .buttonStyle(OutlineButtonStyle())
                Spacer()
            }
            .padding(24)
            .background(Color.ink.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("temp-password-done")
                }
            }
        }
        .interactiveDismissDisabled()
    }
}

private struct CreateLoginView: View {
    let model: BarbersModel
    let barber: Barber
    let onCreated: (TempPassword) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("login-email")
                } footer: {
                    Text("\(barber.displayName) signs in with this email and a temporary password you hand over.")
                }
                .listRowBackground(Color.ink2)
                Section {
                    ErrorText(message: error)
                    Button("Create login", action: create)
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(!email.contains("@") || busy)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .accessibilityIdentifier("login-create")
                }
                .listRowBackground(Color.ink2)
            }
            .inkBackground()
            .navigationTitle("Login for \(barber.displayName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    private func create() {
        busy = true
        error = nil
        Task {
            do {
                let created = try await model.createLogin(for: barber, email: email)
                dismiss()
                onCreated(TempPassword(name: barber.displayName, email: email.lowercased(), password: created.temporaryPassword))
            } catch {
                self.error = model.app.handle(error)
            }
            busy = false
        }
    }
}

private struct DeactivateView: View {
    let barber: Barber
    let upcoming: [Booking]
    let onConfirm: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if upcoming.isEmpty {
                        Text("No upcoming bookings.").foregroundStyle(Color.boneSoft)
                    }
                    ForEach(upcoming) { b in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(ShopFormat.slot(b.date, b.time)) · \(b.customerName)").foregroundStyle(Color.bone)
                            Text(([b.serviceName] + [b.customerPhone.map(Phone.display)].compactMap { $0 }).joined(separator: " · ")).font(.subheadline).foregroundStyle(Color.boneSoft)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    Text("Upcoming bookings (\(upcoming.count))").accessibilityIdentifier("deactivate-count")
                } footer: {
                    Text("Deactivating hides \(barber.displayName) from the website and booking at once. These stay booked: cancel or move them yourself.")
                }
                .listRowBackground(Color.ink2)
                Section {
                    Button("Deactivate \(barber.displayName)", role: .destructive) { onConfirm() }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .accessibilityIdentifier("confirm-deactivate")
                }
                .listRowBackground(Color.ink2)
            }
            .listStyle(.insetGrouped)
            .inkBackground()
            .navigationTitle("Deactivate \(barber.displayName)?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Keep active") { dismiss() } } }
        }
    }
}

/// Add or edit a barber: name, link name (slug), title, bio, photo, weekly hours.
struct BarberEditorView: View {
    let model: BarbersModel
    let barber: Barber?
    /// The barber's id and how many upcoming bookings the saved hours leave out.
    let onSaved: (UUID, Int) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var slug: String
    @State private var slugEdited: Bool
    @State private var title: String
    @State private var bio: String
    @State private var hours: HoursEdit
    @State private var photoItem: PhotosPickerItem?
    @State private var photo: Data?
    @State private var error: String?
    @State private var busy = false
    @State private var confirmingNoHours = false
    /// After the profile saved but the hours did not: the barber's id (a new barber exists now)
    /// and the photo already uploaded, so Save retries without a second barber or upload.
    @State private var savedId: UUID?
    @State private var photoUrl: String?

    init(model: BarbersModel, barber: Barber?, onSaved: @escaping (UUID, Int) -> Void) {
        self.model = model
        self.barber = barber
        self.onSaved = onSaved
        _name = State(initialValue: barber?.displayName ?? "")
        _slug = State(initialValue: barber?.slug ?? "")
        _slugEdited = State(initialValue: barber != nil)
        _title = State(initialValue: barber?.title ?? "Barber")
        _bio = State(initialValue: barber?.bio ?? "")
        _hours = State(initialValue: barber.map { HoursEdit.forBarber(saved: model.schedules[$0.id]) } ?? .forNewBarber())
        _savedId = State(initialValue: barber?.id)
        _photoUrl = State(initialValue: barber?.photoUrl)
    }

    private var draft: BarberDraft {
        BarberDraft(id: savedId, slug: slug, displayName: name.trimmingCharacters(in: .whitespaces),
                    title: title, bio: bio, photoUrl: photoUrl)
    }

    private var problems: BarberDraft.Problems { draft.problems(others: model.barbers) }
    private var displayName: String { barber?.displayName ?? (name.isEmpty ? "this barber" : name) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("barber-name")
                        .onChange(of: name) { _, new in if !slugEdited { slug = BarbersModel.suggestedSlug(new) } }
                    fieldProblem(name.isEmpty ? nil : problems.name, id: "name")
                    TextField("Link name", text: Binding(get: { slug }, set: { slug = $0.lowercased(); slugEdited = true }))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("barber-slug")
                    TextField("Title, e.g. Master Barber", text: $title)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("barber-title")
                    fieldProblem(problems.title, id: "title")
                    TextField("Bio for the website", text: $bio, axis: .vertical)
                        .lineLimit(2...6)
                        .accessibilityIdentifier("barber-bio")
                    fieldProblem(problems.bio, id: "bio")
                } header: {
                    Text("Profile")
                } footer: {
                    Text(problems.slug?.message ?? BookingLinks.plain(slug: slug).absoluteString)
                        .font(.footnote.monospaced())
                        .foregroundStyle(problems.slug == nil ? Color.goldPale : Color.danger)
                }
                .listRowBackground(Color.ink2)

                Section("Photo") {
                    PhotosPicker(selection: $photoItem, matching: .images) {
                        Label(photo != nil ? "Photo picked: replace" : (barber?.photoUrl != nil ? "Replace photo" : "Pick photo"),
                              systemImage: "photo")
                    }
                    .frame(minHeight: 44)
                    if let photo, let img = UIImage(data: photo) {
                        Image(uiImage: img).resizable().scaledToFit().frame(height: 120).accessibilityLabel("Picked photo")
                    }
                }
                .listRowBackground(Color.ink2)

                Section {
                    if hours.edited != nil {
                        ForEach(HoursDraft.displayOrder, id: \.self) { wd in dayRow(wd) }
                    } else if let barber {
                        HoursStatus(model: model, barber: barber) { _ in EmptyView() }
                    }
                } header: {
                    Text("Weekly hours")
                } footer: {
                    Text(hours.edited != nil ? "Inside the shop's hours: 10 AM – 6 PM, closed Tuesdays."
                                             : "Saving now changes only the profile; the hours stay as they are.")
                }
                .listRowBackground(Color.ink2)

                Section {
                    ErrorText(message: error)
                    Button(barber == nil ? "Add barber" : "Save", action: save)
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(problems.first != nil || name.trimmingCharacters(in: .whitespaces).count < 2 || busy)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .accessibilityIdentifier("barber-save")
                }
                .listRowBackground(Color.ink2)
            }
            .inkBackground()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(barber == nil ? "New barber" : "Edit \(barber!.displayName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onChange(of: photoItem) { _, item in
                Task {
                    guard let data = try? await item?.loadTransferable(type: Data.self), let img = UIImage(data: data) else { return }
                    photo = Self.jpeg(img)
                }
            }
            .onChange(of: barber.flatMap { model.schedules[$0.id] }) { _, saved in
                if let saved { hours.loaded(saved) }
            }
            .alert("Save \(displayName) with no working days?", isPresented: $confirmingNoHours) {
                Button("Save with no working days", role: .destructive) { commit() }
                    .accessibilityIdentifier("confirm-no-hours")
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text(hours.isNew
                     ? "The website won't offer \(displayName) for booking until you set hours."
                     : "The website stops offering \(displayName) for booking. Bookings already made stay booked.")
            }
        }
    }

    @ViewBuilder private func fieldProblem(_ problem: BackendError?, id: String) -> some View {
        if let problem {
            Text(problem.message)
                .font(.footnote)
                .foregroundStyle(Color.danger)
                .accessibilityIdentifier("problem-\(id)")
        }
    }

    @ViewBuilder private func dayRow(_ wd: Int) -> some View {
        let name = Catalog.weekdayNames[wd]
        if Catalog.storeHours[wd] == nil {
            LabeledContent(name, value: "Shop closed").foregroundStyle(Color.boneSoft)
        } else {
            let choices = HoursDraft.choices(for: wd)
            VStack(alignment: .leading, spacing: 6) {
                Toggle(name, isOn: Binding(get: { hours.edited?.days[wd] != nil },
                                           set: { hours.edited?.days[wd] = $0 ? Catalog.storeHours[wd] : nil }))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("hours-\(wd)")
                if let h = hours.edited?.days[wd] {
                    HStack {
                        Picker("\(name) start", selection: Binding(get: { h.open }, set: { hours.edited?.days[wd] = OpenHours(open: $0, close: max(h.close, $0.adding(minutes: 30))) })) {
                            ForEach(choices.dropLast(), id: \.self) { Text(ShopFormat.time($0)).tag($0) }
                        }
                        Text("to").foregroundStyle(Color.boneSoft)
                        Picker("\(name) end", selection: Binding(get: { h.close }, set: { hours.edited?.days[wd] = OpenHours(open: min(h.open, $0.adding(minutes: -30)), close: $0) })) {
                            ForEach(choices.dropFirst(), id: \.self) { Text(ShopFormat.time($0)).tag($0) }
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
            }
        }
    }

    static func jpeg(_ image: UIImage) -> Data? {
        let side: CGFloat = 1200
        let scale = min(1, side / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let resized = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return resized.jpegData(compressionQuality: 0.82)
    }

    private func save() {
        if hours.leavesNoWorkingDays { confirmingNoHours = true } else { commit() }
    }

    private func commit() {
        busy = true
        error = nil
        Task {
            do {
                let saved = try await model.save(draft, photo: photo, hours: hours.toSave)
                savedId = saved.id
                photoUrl = saved.photoUrl
                photo = nil
                switch saved.hours {
                case .unchanged:
                    dismiss()
                    onSaved(saved.id, 0)
                case .saved(let outside):
                    dismiss()
                    onSaved(saved.id, outside)
                case .failed(let message):
                    // The profile is saved; Save again retries the hours.
                    self.error = "Profile saved. The hours weren't saved: \(message)"
                }
            } catch {
                self.error = model.app.handle(error)
            }
            busy = false
        }
    }
}
