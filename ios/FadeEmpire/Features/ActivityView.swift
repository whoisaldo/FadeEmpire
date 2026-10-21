import SwiftUI

struct ActivityView: View {
    @Environment(AppModel.self) private var app
    @State private var events: [ActivityEvent] = []
    @State private var canLoadOlder = false
    @State private var error: String?
    static let pageSize = 50

    var body: some View {
        NavigationStack {
            List {
                if let error { ErrorText(message: error).listRowBackground(Color.ink2) }
                if events.isEmpty && error == nil {
                    Text("Bookings, cancellations and no-shows on your chairs show up here.")
                        .foregroundStyle(Color.boneSoft)
                        .listRowBackground(Color.ink2)
                }
                ForEach(events) { e in
                    ActivityRow(event: e, ownChair: e.barberId == app.me?.barberId)
                        .listRowBackground(e.isUnread ? Color.goldSoft.opacity(0.5) : Color.ink2)
                }
                if canLoadOlder {
                    Button("Load older") { Task { await loadOlder() } }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .listRowBackground(Color.ink2)
                }
            }
            .listStyle(.insetGrouped)
            .inkBackground()
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .autoRefresh { await load() }
        }
    }

    /// Loading the list counts as viewing it: the badge clears, and the rows keep their
    /// unread shading until the next load.
    private func load() async {
        do {
            let page = try await app.backend.activity(before: nil, limit: Self.pageSize)
            events = page
            canLoadOlder = page.count == Self.pageSize
            error = nil
            if page.contains(where: \.isUnread) || app.unreadCount > 0 { await app.markActivitySeen() }
        } catch {
            self.error = app.handle(error)
        }
    }

    private func loadOlder() async {
        guard let last = events.last else { return }
        do {
            let page = try await app.backend.activity(before: last.eventId, limit: Self.pageSize)
            events += page
            canLoadOlder = page.count == Self.pageSize
        } catch {
            self.error = app.handle(error)
        }
    }
}

private struct ActivityRow: View {
    let event: ActivityEvent
    let ownChair: Bool

    private var title: String {
        switch event.kind {
        case .booked: return "New booking"
        case .cancelled: return "Cancelled"
        case .noShow: return "No-show"
        case .moved: return "Moved"
        }
    }

    private var icon: (String, Color) {
        switch event.kind {
        case .booked: return ("calendar.badge.plus", .success)
        case .cancelled: return ("calendar.badge.minus", .danger)
        case .noShow: return ("person.fill.questionmark", .danger)
        case .moved: return ("arrow.left.arrow.right", .goldPale)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon.0)
                .foregroundStyle(icon.1)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text("\(title) · \(event.customerName)").font(.headline).foregroundStyle(Color.bone)
                    if event.isUnread {
                        Circle().fill(Color.gold).frame(width: 8, height: 8).accessibilityLabel("Unread")
                    }
                }
                Text("\(ShopFormat.slot(event.date, event.time)) · \(event.serviceName)"
                     + (ownChair ? "" : " · \(event.barberName)'s chair"))
                    .font(.subheadline)
                    .foregroundStyle(Color.boneSoft)
                Text("\(ShopFormat.timestamp(event.occurredAt.date)) · by \(event.actor)")
                    .font(.caption)
                    .foregroundStyle(Color.boneSoft)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("activity-\(event.eventId)")
    }
}
