import SwiftUI

struct ScheduleView: View {
    @Environment(AppModel.self) private var app
    @State private var model: ScheduleModel?

    var body: some View {
        NavigationStack {
            Group {
                if let model { ScheduleContent(model: model) } else { Color.ink }
            }
            .background(Color.ink.ignoresSafeArea())
        }
        .onAppear { if model == nil { model = ScheduleModel(app: app) } }
    }
}

private struct ScheduleContent: View {
    @Bindable var model: ScheduleModel
    @State private var showingNew = false
    @State private var showingDaysOff = false

    var body: some View {
        List {
            Section {
                if model.showsChairSwitcher { ChairSwitcher(model: model) }
                DayStrip(days: model.days, selected: $model.selectedDay, today: model.today,
                         count: model.activeCount(on:), status: model.status(of:))
            }
            .listRowBackground(Color.ink)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden)

            Section {
                let rows = model.bookings(on: model.selectedDay)
                if let error = model.error {
                    ErrorText(message: error).listRowBackground(Color.ink2)
                }
                if rows.isEmpty {
                    Text(model.status(of: model.selectedDay).isOpen ? "No appointments." : "No appointments that day.")
                        .foregroundStyle(Color.boneSoft)
                        .listRowBackground(Color.ink2)
                        .accessibilityIdentifier("schedule-empty")
                }
                ForEach(rows) { booking in
                    NavigationLink(value: booking.id) { AppointmentRow(booking: booking) }
                        .listRowBackground(Color.ink2)
                        .accessibilityIdentifier("booking-\(booking.customerName)")
                }
            } header: {
                DayHeader(day: model.selectedDay, status: model.status(of: model.selectedDay),
                          count: model.activeCount(on: model.selectedDay))
            }
        }
        .listStyle(.insetGrouped)
        .inkBackground()
        .navigationTitle(model.chair.map { "\($0.displayName)'s chair" } ?? "Schedule")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showingDaysOff = true } label: { Label("Days off", systemImage: "calendar.badge.minus") }
                    .accessibilityIdentifier("open-days-off")
            }
            if model.canAddAppointment {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingNew = true } label: { Label("New appointment", systemImage: "plus") }
                        .accessibilityIdentifier("new-appointment")
                }
            }
        }
        .navigationDestination(for: UUID.self) { id in AppointmentDetailView(model: model, bookingId: id) }
        .sheet(isPresented: $showingNew) {
            if let chair = model.chair {
                NewAppointmentView(chair: chair, startDay: model.selectedDay) { day in
                    model.selectedDay = day
                    Task { await model.load() }
                }
            }
        }
        .sheet(isPresented: $showingDaysOff, onDismiss: { Task { await model.load() } }) {
            if let chair = model.chair { DaysOffView(chair: chair) }
        }
        .autoRefresh { await model.load() }
        .onChange(of: model.app.requestedDay, initial: true) { _, day in
            if day != nil { Task { await model.showRequestedDay() } }
        }
    }
}

/// Chips for each visible chair; granted chairs say "View only".
private struct ChairSwitcher: View {
    let model: ScheduleModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.chairs) { chair in
                    let selected = chair.id == model.chair?.id
                    Button {
                        Task { await model.selectChair(chair.id) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(chair.displayName).font(.headline)
                            if let note = note(for: chair) {
                                Text(note)
                                    .font(.caption)
                                    .foregroundStyle(selected ? Color.ink.opacity(0.75) : Color.boneSoft)
                            }
                        }
                        .padding(.horizontal, 14)
                        .frame(minWidth: 96, minHeight: 52, alignment: .leading)
                        .foregroundStyle(selected ? Color.ink : Color.bone)
                        .background(selected ? Color.gold : Color.ink2, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.rule))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(chair.displayName)'s chair\(chair.canManage ? "" : ", view only")")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("chair-\(chair.slug)")
                }
            }
            .padding(.horizontal, 16)
        }
        .padding(.top, 8)
    }

    /// The manager manages every chair but owns none, so their chips carry no "Your chair".
    private func note(for chair: Chair) -> String? {
        if !chair.isActive { return "Inactive" }
        if !chair.canManage { return "View only" }
        return chair.id == model.app.me?.barberId ? "Your chair" : nil
    }
}

/// Today plus 4 weeks. Each cell shows the weekday, the date, and the booking count
/// or why the chair is closed.
struct DayStrip: View {
    let days: [ShopDay]
    @Binding var selected: ShopDay
    let today: ShopDay
    let count: (ShopDay) -> Int
    let status: (ShopDay) -> DayStatus
    var idPrefix = "day"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 6) {
                    ForEach(days) { day in cell(day).id(day) }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }
            .onAppear { proxy.scrollTo(selected, anchor: .center) }
        }
    }

    private func cell(_ day: ShopDay) -> some View {
        let isSelected = day == selected
        let st = status(day)
        let n = count(day)
        return Button { selected = day } label: {
            VStack(spacing: 3) {
                Text(day == today ? "Today" : ShopFormat.weekday(day))
                    .font(.caption2.weight(.semibold))
                Text("\(day.day)").font(.title3.weight(.semibold)).monospacedDigit()
                Group {
                    if !st.isOpen { Image(systemName: "moon.zzz") } else if n > 0 { Text("\(n)") } else { Text("–") }
                }
                .font(.caption2)
            }
            .frame(minWidth: 52, minHeight: 72)
            .foregroundStyle(isSelected ? Color.ink : (st.isOpen ? Color.bone : Color.boneSoft))
            .background(isSelected ? Color.gold : Color.ink2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(day == today && !isSelected ? Color.gold : Color.rule))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibility(day, st, n))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("\(idPrefix)-\(day.iso)")
    }

    private func accessibility(_ day: ShopDay, _ st: DayStatus, _ n: Int) -> String {
        let name = (day == today ? "Today, " : "") + ShopFormat.longDay(day)
        if let label = st.label { return "\(name), \(label)" }
        return "\(name), \(n) appointment\(n == 1 ? "" : "s")"
    }
}

private struct DayHeader: View {
    let day: ShopDay
    let status: DayStatus
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(ShopFormat.longDay(day))
                .font(.display(22, relativeTo: .title2))
                .foregroundStyle(Color.bone)
                .textCase(nil)
            Group {
                switch status {
                case .open(let h):
                    Text("\(ShopFormat.time(h.open)) – \(ShopFormat.time(h.close)) · \(count) booked")
                default:
                    Text(status.label ?? "").foregroundStyle(Color.goldPale)
                }
            }
            .font(.subheadline)
            .foregroundStyle(Color.boneSoft)
            .textCase(nil)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("day-header")
        .padding(.top, 8)
    }
}

struct AppointmentRow: View {
    let booking: Booking

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text(ShopFormat.time(booking.time))
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(booking.status.isActive ? Color.gold : Color.boneSoft)
                .frame(minWidth: 72, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(booking.customerName)
                    .font(.headline)
                    .foregroundStyle(booking.status.isActive ? Color.bone : Color.boneSoft)
                    .strikethrough(booking.status == .cancelled)
                Text(([booking.serviceName] + booking.addons).joined(separator: " + "))
                    .font(.subheadline)
                    .foregroundStyle(Color.boneSoft)
                HStack(spacing: 6) {
                    if let tag = booking.statusTag { Tag(text: tag.0, color: tag.1) }
                    if booking.partySize > 1 { Tag(text: "Group of \(booking.partySize)") }
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

extension Booking {
    var statusTag: (String, Color)? {
        switch status {
        case .cancelled: return ("Cancelled", .danger)
        case .noShow: return ("No-show", .danger)
        case .pending: return ("Not confirmed", .goldPale)
        case .expired: return ("Expired", .boneSoft)
        case .confirmed, .completed: return nil
        }
    }

    var sourceLabel: String {
        switch source {
        case "web", "mobile": return "online"
        case "app": return "in the app"
        case "phone": return "by phone"
        case "walk_in": return "as a walk-in"
        default: return source
        }
    }
}
