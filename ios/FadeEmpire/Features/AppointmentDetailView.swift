import SwiftUI

struct AppointmentDetailView: View {
    let model: ScheduleModel
    let bookingId: UUID
    @Environment(\.openURL) private var openURL
    @State private var confirmingCancel = false
    @State private var cancelled: CancelledBooking?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        if let booking = model.booking(id: bookingId) {
            content(booking)
        } else {
            Text("This appointment is no longer in this chair's next 4 weeks.")
                .foregroundStyle(Color.boneSoft)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.ink.ignoresSafeArea())
        }
    }

    private func content(_ b: Booking) -> some View {
        let actions = ScheduleModel.actions(for: b)
        return List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(b.customerName)
                        .font(.display(28, relativeTo: .title))
                        .foregroundStyle(Color.bone)
                        .accessibilityAddTraits(.isHeader)
                    Text("\(ShopFormat.longDay(b.date)) · \(ShopFormat.time(b.time))")
                        .font(.headline)
                        .foregroundStyle(Color.gold)
                    HStack(spacing: 6) {
                        if let tag = b.statusTag { Tag(text: tag.0, color: tag.1) }
                        if !b.canManage { Tag(text: "View only") }
                    }
                }
                .padding(.vertical, 4)
                // A view-only chair has no phone (app_bookings leaves it out), so no Call or Text.
                if b.canManage, let phone = b.customerPhone {
                    ActionRow {
                        Button { if let url = Phone.call(phone) { openURL(url) } } label: {
                            Label("Call", systemImage: "phone")
                        }
                        .buttonStyle(OutlineButtonStyle())
                        .accessibilityLabel("Call \(b.customerName), \(Phone.display(phone))")
                        .accessibilityIdentifier("detail-call")
                        Button { if let url = Phone.text(phone) { openURL(url) } } label: {
                            Label("Text", systemImage: "message")
                        }
                        .buttonStyle(OutlineButtonStyle())
                        .accessibilityLabel("Text \(b.customerName)")
                        .accessibilityIdentifier("detail-text")
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
            .listRowBackground(Color.ink2)

            Section {
                if b.canManage, let phone = b.customerPhone { row("Phone", Phone.display(phone)) }
                row("Service", "\(b.serviceName) · \(b.durationMinutes) min")
                if !b.addons.isEmpty { row("Add-ons", b.addons.joined(separator: ", ")) }
                if let r = b.customRequest, !r.isEmpty { row("Request", r) }
                if let n = b.customerNotes, !n.isEmpty { row("Notes", n) }
                row("Price", ShopFormat.price(cents: b.totalPriceCents))
                if b.partySize > 1 {
                    let others = model.partyMembers(of: b)
                    row("Party", "Group of \(b.partySize)" + (b.isGuest ? " · guest" : "")
                        + (others.isEmpty ? "" : " · with " + others.map { "\($0.customerName) \(ShopFormat.time($0.time))" }.joined(separator: ", ")))
                }
                row("Booked", "\(ShopFormat.timestamp(b.createdAt.date)) · \(b.sourceLabel)")
                if b.status == .cancelled, let at = b.cancelledAt {
                    row("Cancelled", "\(ShopFormat.timestamp(at.date))" + (b.cancelledBy.map { " · by \($0)" } ?? ""))
                }
            }
            .listRowBackground(Color.ink2)

            if !actions.isEmpty {
                Section {
                    ErrorText(message: error)
                    if actions.contains(.cancel) {
                        Button(role: .destructive) { confirmingCancel = true } label: {
                            Label("Cancel appointment", systemImage: "xmark.circle").frame(minHeight: 44)
                        }
                        .accessibilityIdentifier("cancel-appointment")
                    }
                    if actions.contains(.markNoShow) {
                        Button { setStatus(b, .noShow) } label: {
                            Label("Mark no-show", systemImage: "person.fill.questionmark").frame(minHeight: 44)
                        }
                        .accessibilityIdentifier("mark-no-show")
                    }
                    if actions.contains(.undoNoShow) {
                        Button { setStatus(b, .confirmed) } label: {
                            Label("Undo no-show", systemImage: "arrow.uturn.backward").frame(minHeight: 44)
                        }
                        .accessibilityIdentifier("undo-no-show")
                    }
                }
                .listRowBackground(Color.ink2)
                .disabled(busy)
            }
        }
        .listStyle(.insetGrouped)
        .inkBackground()
        .navigationTitle(ShopFormat.time(b.time))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Cancel \(Messages.firstName(b.customerName))'s \(ShopFormat.time(b.time)) \(b.serviceName)?",
                            isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("Cancel appointment", role: .destructive) { cancel(b) }
                .accessibilityIdentifier("confirm-cancel")
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("The slot opens on the website right away.")
        }
        .sheet(item: $cancelled) { c in
            CancelledSheet(cancelled: c, booking: b, barberName: model.chair?.displayName ?? b.barberSlug)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        LabeledContent {
            Text(value).foregroundStyle(Color.bone).multilineTextAlignment(.trailing)
        } label: {
            Text(label).foregroundStyle(Color.boneSoft)
        }
        .accessibilityElement(children: .combine)
    }

    private func cancel(_ b: Booking) {
        busy = true
        Task {
            do { cancelled = try await model.cancel(b); error = nil } catch { self.error = model.app.handle(error) }
            busy = false
        }
    }

    private func setStatus(_ b: Booking, _ status: BookingStatus) {
        busy = true
        Task {
            do { try await model.setStatus(b, status); error = nil } catch { self.error = model.app.handle(error) }
            busy = false
        }
    }
}

extension CancelledBooking: Identifiable { var id: UUID { bookingId } }

/// After a cancel: offer the customer a prefilled text, through Messages or the share sheet.
private struct CancelledSheet: View {
    let cancelled: CancelledBooking
    let booking: Booking
    let barberName: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private var first: String { Messages.firstName(cancelled.customerName) }
    private var message: String {
        Messages.cancellation(firstName: first, barberName: barberName, barberSlug: booking.barberSlug,
                              serviceName: booking.serviceName, day: cancelled.date, time: cancelled.time,
                              bookingId: cancelled.bookingId)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Cancelled")
                        .font(.display(30, relativeTo: .largeTitle))
                        .foregroundStyle(Color.bone)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("cancelled-title")
                    Text("\(ShopFormat.day(cancelled.date)), \(ShopFormat.time(cancelled.time)) is open again. Let \(first) know:")
                        .foregroundStyle(Color.boneSoft)
                    Text(message)
                        .font(.callout.monospaced())
                        .foregroundStyle(Color.bone)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.ink2, in: RoundedRectangle(cornerRadius: 10))
                        .accessibilityIdentifier("cancel-message")
                    Button {
                        if let url = Phone.text(cancelled.customerPhone, body: message) { openURL(url) }
                    } label: {
                        Label("Text \(first)", systemImage: "message")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("text-customer")
                    ShareLink(item: message) { Label("Share…", systemImage: "square.and.arrow.up") }
                        .buttonStyle(OutlineButtonStyle())
                }
                .padding(20)
            }
            .background(Color.ink.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("cancelled-done")
                }
            }
        }
        .presentationDetents([.large])
    }
}
