import Foundation

/// A `timestamptz` from the API, decoded from its text form.
struct Instant: Codable, Hashable, Comparable, Sendable {
    let date: Date

    init(_ date: Date) { self.date = date }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let d = ShopFormat.parseTimestamp(raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad timestamp \(raw)"))
        }
        date = d
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(ISO8601DateFormatter().string(from: date))
    }

    static func < (a: Instant, b: Instant) -> Bool { a.date < b.date }
}

enum Role: String, Codable, Sendable { case manager, barber }

/// A chair the signed-in user may see (`app_me().chairs`).
struct Chair: Codable, Hashable, Identifiable, Sendable {
    let barberId: UUID
    let slug: String
    let displayName: String
    let title: String?
    let isActive: Bool
    let canManage: Bool

    var id: UUID { barberId }

    enum CodingKeys: String, CodingKey {
        case barberId = "barber_id", slug, displayName = "display_name", title
        case isActive = "is_active", canManage = "can_manage"
    }
}

/// `app_me()`
struct Me: Codable, Hashable, Sendable {
    let userId: UUID
    let role: Role
    let displayName: String
    let barberId: UUID?
    let barberSlug: String?
    var mustChangePassword: Bool
    var notifyBookings: Bool
    var notifyCancellations: Bool
    var notifyViewedChairs: Bool
    let chairs: [Chair]

    var isManager: Bool { role == .manager }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id", role, displayName = "display_name", barberId = "barber_id"
        case barberSlug = "barber_slug", mustChangePassword = "must_change_password"
        case notifyBookings = "notify_bookings", notifyCancellations = "notify_cancellations"
        case notifyViewedChairs = "notify_viewed_chairs", chairs
    }
}

enum BookingStatus: String, Codable, Sendable {
    case pending, confirmed, completed, cancelled, expired
    case noShow = "no_show"

    /// Still holding the slot.
    var isActive: Bool { self == .pending || self == .confirmed || self == .completed }
}

/// `app_bookings()` row. Primary rows only.
struct Booking: Codable, Hashable, Identifiable, Sendable {
    let id: UUID
    let barberId: UUID
    let barberSlug: String
    let date: ShopDay
    let time: ShopTime
    let endTime: ShopTime
    let serviceSlug: String
    let serviceName: String
    let durationMinutes: Int
    let addons: [String]
    let customRequest: String?
    let customerNotes: String?
    let customerName: String
    /// Null on a chair the caller only views.
    var customerPhone: String?
    let totalPriceCents: Int
    var status: BookingStatus
    let source: String
    let isGuest: Bool
    let partyId: UUID?
    let partySize: Int
    let createdAt: Instant
    var cancelledAt: Instant?
    var cancelledBy: String?
    var canManage: Bool

    enum CodingKeys: String, CodingKey {
        case id, barberId = "barber_id", barberSlug = "barber_slug", date = "booking_date"
        case time = "booking_time", endTime = "end_time", serviceSlug = "service_slug"
        case serviceName = "service_name", durationMinutes = "duration_minutes", addons
        case customRequest = "custom_request", customerNotes = "customer_notes"
        case customerName = "customer_name", customerPhone = "customer_phone"
        case totalPriceCents = "total_price_cents", status, source, isGuest = "is_guest"
        case partyId = "party_id", partySize = "party_size", createdAt = "created_at"
        case cancelledAt = "cancelled_at", cancelledBy = "cancelled_by", canManage = "can_manage"
    }
}

/// `app_cancel_booking()`: what the app needs to text the customer.
struct CancelledBooking: Codable, Hashable, Sendable {
    let bookingId: UUID
    let customerName: String
    let customerPhone: String
    let date: ShopDay
    let time: ShopTime

    enum CodingKeys: String, CodingKey {
        case bookingId = "booking_id", customerName = "customer_name", customerPhone = "customer_phone"
        case date = "booking_date", time = "booking_time"
    }
}

enum ActivityKind: String, Codable, Sendable {
    case booked, cancelled, moved
    case noShow = "no_show"
}

/// `app_activity()` row.
struct ActivityEvent: Codable, Hashable, Identifiable, Sendable {
    let eventId: Int64
    let kind: ActivityKind
    let actor: String
    let occurredAt: Instant
    let bookingId: UUID
    let barberId: UUID
    let barberSlug: String
    let barberName: String
    let customerName: String
    let date: ShopDay
    let time: ShopTime
    let serviceName: String
    var isUnread: Bool

    var id: Int64 { eventId }

    enum CodingKeys: String, CodingKey {
        case eventId = "event_id", kind, actor, occurredAt = "occurred_at", bookingId = "booking_id"
        case barberId = "barber_id", barberSlug = "barber_slug", barberName = "barber_name"
        case customerName = "customer_name", date = "booking_date", time = "booking_time"
        case serviceName = "service_name", isUnread = "is_unread"
    }
}

/// `app_days_off()` row.
struct DayOff: Codable, Hashable, Identifiable, Sendable {
    let date: ShopDay
    let reason: String?
    let bookingsThatDay: Int

    var id: ShopDay { date }

    enum CodingKeys: String, CodingKey {
        case date = "closure_date", reason, bookingsThatDay = "bookings_that_day"
    }
}

/// A `booking_links` row.
struct BookingLink: Codable, Hashable, Identifiable, Sendable {
    let id: UUID
    let barberId: UUID
    let label: String
    let serviceSlug: String?
    let createdAt: Instant

    enum CodingKeys: String, CodingKey {
        case id, barberId = "barber_id", label, serviceSlug = "service_slug", createdAt = "created_at"
    }
}

/// A `barbers` row as the manager reads it (inactive rows included).
struct Barber: Codable, Hashable, Identifiable, Sendable {
    let id: UUID
    var slug: String
    var displayName: String
    var title: String?
    var bio: String?
    var photoUrl: String?
    var isActive: Bool
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id, slug, displayName = "display_name", title, bio, photoUrl = "photo_url"
        case isActive = "is_active", sortOrder = "sort_order"
    }
}

/// What `manager_save_barber` takes. `id` nil creates the barber.
struct BarberDraft: Hashable, Sendable {
    var id: UUID?
    var slug: String
    var displayName: String
    var title: String
    var bio: String
    var photoUrl: String?

    /// Lowercase `[a-z0-9-]`, 2–30 characters (CONTRACT.md, manager_save_barber).
    static func isValidSlug(_ s: String) -> Bool {
        s.range(of: "^[a-z0-9-]{2,30}$", options: .regularExpression) != nil
    }

    /// The website's own top-level paths; a barber's link can't take one (`slug_reserved`).
    static let reservedSlugs: Set<String> = ["assets", "docs", "ios", "scripts", "styles", "supabase", "tests", "tools",
                                             "index", "robots", "sitemap", "manifest", "sw"]
}

/// One weekday of a barber's hours. 0 = Sunday.
struct ScheduleDay: Codable, Hashable, Sendable {
    let weekday: Int
    let open: ShopTime
    let close: ShopTime

    enum CodingKeys: String, CodingKey { case weekday, open = "open_time", close = "close_time" }
}

/// `manager_staff()` row.
struct StaffMember: Codable, Hashable, Identifiable, Sendable {
    let userId: UUID
    let email: String
    let role: Role
    let displayName: String
    let barberId: UUID?
    let lastSignInAt: Instant?
    var isDisabled: Bool

    var id: UUID { userId }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id", email, role, displayName = "display_name", barberId = "barber_id"
        case lastSignInAt = "last_sign_in_at", isDisabled = "is_disabled"
    }
}

/// `manager_view_grants()` row: `viewer` may see `barber`'s chair, read-only.
struct ViewGrant: Codable, Hashable, Sendable {
    let viewerBarberId: UUID
    let barberId: UUID

    enum CodingKeys: String, CodingKey { case viewerBarberId = "viewer_barber_id", barberId = "barber_id" }
}

/// `staff-admin` `create_login`.
struct CreatedLogin: Codable, Hashable, Sendable {
    let userId: UUID
    let temporaryPassword: String

    enum CodingKeys: String, CodingKey { case userId = "user_id", temporaryPassword = "temporary_password" }
}

/// What `app_book` takes.
struct NewBooking: Hashable, Sendable {
    var barberId: UUID
    var serviceSlug: String
    var date: ShopDay
    var time: ShopTime
    var customerName: String
    var customerPhone: String
    var addonSlugs: [String]
    var notes: String?
}
