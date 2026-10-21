import SwiftUI

struct NewAppointmentView: View {
    let chair: Chair
    let onBooked: (ShopDay) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var service = Catalog.services[0].slug
    @State private var day: ShopDay
    @State private var slots: [ShopTime] = []
    @State private var slotsLoaded = false
    @State private var slotLoads = LoadGeneration()
    /// A time chip grows with the text size, so "10:45 AM" stays on one line.
    @ScaledMetric(relativeTo: .subheadline) private var slotWidth: CGFloat = 96
    @State private var time: ShopTime?
    @State private var name = ""
    @State private var phone = ""
    @State private var addons: Set<String> = []
    @State private var notes = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var typing: Bool

    init(chair: Chair, startDay: ShopDay, onBooked: @escaping (ShopDay) -> Void) {
        self.chair = chair
        self.onBooked = onBooked
        _day = State(initialValue: startDay)
    }

    private var days: [ShopDay] { (0...ScheduleModel.windowDays).map { app.clock.today.adding(days: $0) } }
    private var canBook: Bool {
        time != nil && name.trimmingCharacters(in: .whitespaces).count >= 2 && Phone.digits(phone).count == 10 && !busy
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Service") {
                    Picker("Service", selection: $service) {
                        ForEach(Catalog.services) { s in
                            Text("\(s.name) · \(ShopFormat.price(cents: s.priceCents))").tag(s.slug)
                        }
                    }
                    .pickerStyle(.navigationLink)
                    .accessibilityIdentifier("new-service")
                }
                .listRowBackground(Color.ink2)

                Section {
                    DayStrip(days: days, selected: $day, today: app.clock.today, count: { _ in 0 },
                             status: { Catalog.storeHours[$0.weekday].map(DayStatus.open) ?? .shopClosed }, idPrefix: "newday")
                        .listRowInsets(EdgeInsets())
                    slotGrid
                } header: {
                    Text("\(ShopFormat.longDay(day)) · free times")
                }
                .listRowBackground(Color.ink2)

                Section("Customer") {
                    TextField("Name", text: $name)
                        .textContentType(.name)
                        .frame(minHeight: 44)
                        .focused($typing)
                        .accessibilityIdentifier("new-name")
                    TextField("Phone (10 digits)", text: $phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                        .frame(minHeight: 44)
                        .focused($typing)
                        .accessibilityIdentifier("new-phone")
                }
                .listRowBackground(Color.ink2)

                Section("Add-ons") {
                    ForEach(Catalog.addons) { a in
                        let included = Catalog.isIncluded(a.slug, in: service)
                        Toggle(isOn: Binding(get: { included || addons.contains(a.slug) },
                                             set: { on in if on { addons.insert(a.slug) } else { addons.remove(a.slug) } })) {
                            HStack {
                                Text(a.name)
                                Spacer()
                                Text(included ? "Included" : (a.priceCents == 0 ? "Free" : "+\(ShopFormat.price(cents: a.priceCents))"))
                                    .foregroundStyle(Color.boneSoft)
                            }
                        }
                        .disabled(included)
                        .frame(minHeight: 44)
                    }
                }
                .listRowBackground(Color.ink2)

                Section("Notes") {
                    TextField("Notes for the chair", text: $notes, axis: .vertical)
                        .lineLimit(2...5)
                        .focused($typing)
                        .accessibilityIdentifier("new-notes")
                }
                .listRowBackground(Color.ink2)

                Section {
                    LabeledContent("Total", value: ShopFormat.price(cents: Catalog.totalCents(service: service, addons: addons)))
                    ErrorText(message: error)
                    Button(action: book) {
                        if busy { ProgressView().tint(Color.ink) } else {
                            Text(time.map { "Book \(ShopFormat.day(day)), \(ShopFormat.time($0))" } ?? "Pick a time")
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!canBook)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .accessibilityIdentifier("new-book")
                }
                .listRowBackground(Color.ink2)
            }
            .inkBackground()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("New appointment · \(chair.displayName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                // The phone pad has no return key.
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { typing = false }.accessibilityIdentifier("keyboard-done")
                }
            }
            .task(id: day) { await loadSlots() }
        }
    }

    @ViewBuilder private var slotGrid: some View {
        if !slotsLoaded {
            ProgressView().frame(maxWidth: .infinity)
        } else if slots.isEmpty {
            Text(Catalog.storeHours[day.weekday] == nil ? "Shop closed." : "No free times. Try another day.")
                .foregroundStyle(Color.boneSoft)
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: slotWidth), spacing: 8)], spacing: 8) {
                ForEach(slots, id: \.self) { t in
                    let picked = t == time
                    Button { time = t } label: {
                        Text(ShopFormat.time(t))
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .foregroundStyle(picked ? Color.ink : Color.bone)
                            .background(picked ? Color.gold : Color.ink3, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(picked ? .isSelected : [])
                    .accessibilityIdentifier("slot-\(t.hhmm)")
                }
            }
            .padding(.vertical, 4)
        }
    }

    /// A quick change of day can leave an older day's answer landing last; only the newest applies.
    private func loadSlots() async {
        let generation = slotLoads.next()
        let requested = day
        slotsLoaded = false
        time = nil
        do {
            let free = try await app.backend.freeSlots(barberId: chair.id, date: requested)
            guard slotLoads.isCurrent(generation), requested == day else { return }
            slots = free
        } catch {
            guard slotLoads.isCurrent(generation), requested == day else { return }
            slots = []
            self.error = app.handle(error)
        }
        slotsLoaded = true
    }

    private func book() {
        guard let time else { return }
        busy = true
        error = nil
        let paid = addons.filter { !Catalog.isIncluded($0, in: service) }
        let request = NewBooking(barberId: chair.id, serviceSlug: service, date: day, time: time,
                                 customerName: name.trimmingCharacters(in: .whitespaces), customerPhone: phone,
                                 addonSlugs: Catalog.addons.map(\.slug).filter(paid.contains),
                                 notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes)
        Task {
            do {
                _ = try await app.backend.book(request)
                onBooked(day)
                dismiss()
            } catch {
                let e = error as? BackendError
                self.error = app.handle(error)
                if e == .slotTaken { await loadSlots() }
            }
            busy = false
        }
    }
}
