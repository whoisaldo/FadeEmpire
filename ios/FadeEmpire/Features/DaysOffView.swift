import SwiftUI

struct DaysOffView: View {
    let chair: Chair
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var daysOff: [DayOff] = []
    @State private var newDay: ShopDay?
    @State private var reason = ""
    @State private var error: String?
    @State private var busy = false
    @State private var warning: (day: ShopDay, count: Int)?

    private var days: [ShopDay] { (0...60).map { app.clock.today.adding(days: $0) } }
    @State private var loads = LoadGeneration()

    /// Barbers who only view this chair see "Day off" without it.
    private var reasonHint: String {
        app.isManager && chair.id != app.me?.barberId
            ? "Reason (optional, only \(chair.displayName) and you see it)"
            : "Reason (optional, only you and Ali see it)"
    }
    private var taken: Set<ShopDay> { Set(daysOff.map(\.date)) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if daysOff.isEmpty {
                        Text("No days off coming up.").foregroundStyle(Color.boneSoft)
                    }
                    ForEach(daysOff) { off in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(ShopFormat.longDay(off.date)).font(.headline).foregroundStyle(Color.bone)
                                if let r = ScheduleModel.visibleReason(off, canManage: chair.canManage) {
                                    Text(r).font(.subheadline).foregroundStyle(Color.boneSoft)
                                }
                                if off.bookingsThatDay > 0 {
                                    Label("\(off.bookingsThatDay) still booked that day", systemImage: "exclamationmark.triangle")
                                        .font(.subheadline)
                                        .foregroundStyle(Color.goldPale)
                                }
                            }
                            Spacer()
                            if chair.canManage {
                                Button(role: .destructive) { remove(off) } label: {
                                    Image(systemName: "trash").frame(width: 44, height: 44)
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("Remove day off \(ShopFormat.longDay(off.date))")
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("dayoff-\(off.date.iso)")
                    }
                } header: {
                    Text("Coming up")
                } footer: {
                    if !chair.canManage { Text("View only: \(chair.displayName) manages these.") }
                }
                .listRowBackground(Color.ink2)

                if chair.canManage {
                    Section {
                        Picker("Day", selection: $newDay) {
                            Text("Pick a day").tag(ShopDay?.none)
                            ForEach(days.filter { !taken.contains($0) && Catalog.storeHours[$0.weekday] != nil }) { d in
                                Text(ShopFormat.longDay(d)).tag(ShopDay?.some(d))
                            }
                        }
                        .pickerStyle(.navigationLink)
                        .accessibilityIdentifier("dayoff-picker")
                        TextField(reasonHint, text: $reason)
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("dayoff-reason")
                        ErrorText(message: error)
                        Button(action: add) { Text("Add day off") }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(newDay == nil || busy)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                            .accessibilityIdentifier("dayoff-add")
                    } header: {
                        Text("Add a day off")
                    } footer: {
                        Text("The site stops offering that day. Bookings already made stay booked.")
                    }
                    .listRowBackground(Color.ink2)
                }
            }
            .listStyle(.insetGrouped)
            .inkBackground()
            .navigationTitle("Days off · \(chair.displayName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .autoRefresh { await load() }
            .alert("\(warning?.count ?? 0) still booked on \(warning.map { ShopFormat.day($0.day) } ?? "")",
                   isPresented: Binding(get: { warning != nil }, set: { if !$0 { warning = nil } })) {
                Button("OK") {}
            } message: {
                Text("The day off is saved, but those appointments are not cancelled. Cancel or move them from the schedule and text the customers.")
            }
        }
    }

    private func load() async {
        let generation = loads.next()
        do {
            let rows = try await app.backend.daysOff(barberId: chair.id)
            guard loads.isCurrent(generation) else { return }
            daysOff = rows
        } catch {
            guard loads.isCurrent(generation) else { return }
            self.error = app.handle(error)
        }
    }

    private func add() {
        guard let day = newDay else { return }
        busy = true
        error = nil
        Task {
            do {
                let count = try await app.backend.addDayOff(barberId: chair.id, date: day,
                                                            reason: reason.isEmpty ? nil : reason)
                newDay = nil
                reason = ""
                await load()
                if count > 0 { warning = (day, count) }
            } catch {
                self.error = app.handle(error)
            }
            busy = false
        }
    }

    private func remove(_ off: DayOff) {
        Task {
            do {
                try await app.backend.removeDayOff(barberId: chair.id, date: off.date)
                await load()
            } catch {
                self.error = app.handle(error)
            }
        }
    }
}
