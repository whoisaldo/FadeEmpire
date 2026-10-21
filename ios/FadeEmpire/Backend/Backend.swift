import Foundation

/// Every RPC, table call and Edge Function action the app uses (docs/barber-app/CONTRACT.md).
/// `SupabaseBackend` talks to the real API; `MockBackend` is in memory for previews, UI
/// tests and screenshots (launch argument `-mock-backend`).
protocol Backend: AnyObject, Sendable {
    // Auth
    func restoreSession() async -> Bool
    func signIn(email: String, password: String) async throws
    /// `auth.updateUser(password:)`, then `app_password_changed()`.
    func changePassword(_ newPassword: String) async throws
    func signOut() async throws
    func currentEmail() async -> String?

    // App RPCs
    func me() async throws -> Me
    func bookings(barberId: UUID, from: ShopDay, to: ShopDay) async throws -> [Booking]
    func freeSlots(barberId: UUID, date: ShopDay) async throws -> [ShopTime]
    func book(_ booking: NewBooking) async throws -> UUID
    func cancelBooking(id: UUID) async throws -> CancelledBooking
    /// `no_show`, or `confirmed` to undo a no-show.
    func setStatus(bookingId: UUID, status: BookingStatus) async throws
    func activity(before: Int64?, limit: Int) async throws -> [ActivityEvent]
    func markActivitySeen() async throws
    func daysOff(barberId: UUID) async throws -> [DayOff]
    /// Returns how many bookings that day already has.
    func addDayOff(barberId: UUID, date: ShopDay, reason: String?) async throws -> Int
    func removeDayOff(barberId: UUID, date: ShopDay) async throws
    func setNotifyPrefs(bookings: Bool, cancellations: Bool, viewedChairs: Bool) async throws
    func registerDevice(token: String, environment: String) async throws
    func unregisterDevice(token: String) async throws
    /// `barber_schedules`, readable by everyone, for closed-day display.
    func weeklyHours(barberId: UUID) async throws -> [ScheduleDay]

    // booking_links table
    func links(barberId: UUID) async throws -> [BookingLink]
    func addLink(barberId: UUID, label: String, serviceSlug: String?) async throws -> BookingLink
    func deleteLink(id: UUID) async throws

    // Manager RPCs and tables
    func barbers() async throws -> [Barber]
    func staff() async throws -> [StaffMember]
    func saveBarber(_ draft: BarberDraft) async throws -> UUID
    func uploadBarberPhoto(_ jpeg: Data, slug: String) async throws -> String
    func barberSchedule(barberId: UUID) async throws -> [ScheduleDay]
    func setSchedule(barberId: UUID, days: [ScheduleDay]) async throws
    /// Returns the barber's upcoming bookings count.
    func setActive(barberId: UUID, active: Bool) async throws -> Int
    func viewGrants() async throws -> [ViewGrant]
    func setViewGrant(viewer: UUID, barber: UUID, granted: Bool) async throws

    // Edge Function staff-admin
    func createLogin(email: String, displayName: String, role: Role, barberId: UUID?) async throws -> CreatedLogin
    func resetPassword(userId: UUID) async throws -> String
    func setLoginDisabled(userId: UUID, disabled: Bool) async throws
}

/// Every failure the app can show, each with words a barber can act on.
enum BackendError: Error, Equatable, LocalizedError {
    case forbidden
    case notSignedIn
    case invalidCredentials
    case weakPassword
    case network
    case slotTaken
    case outsideStoreHours
    case outsideWorkingHours
    case storeClosed
    case barberClosed
    case dateOutOfRange
    case invalidSlot
    case invalidPhone
    case invalidName
    case serviceNotFound
    case barberNotFound
    case tooManyActiveBookings
    case bookingNotActive
    case dayOffExists
    case invalidSlug
    case slugTaken
    case slugLocked
    case invalidLabel
    case emailTaken
    case invalidEmail
    case loginExists
    case server(String)

    /// Maps the code a Postgres `raise exception '<code>'`, an Auth error, or the
    /// staff-admin function returns.
    static func from(code raw: String) -> BackendError {
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch code {
        case "forbidden", "42501", "not_manager": return .forbidden
        case "not_signed_in", "not_authenticated", "session_missing", "jwt expired", "pgrst301": return .notSignedIn
        case "invalid_credentials", "invalid_grant", "user_banned": return .invalidCredentials
        case "weak_password", "same_password": return .weakPassword
        case "slot_taken": return .slotTaken
        case "outside_store_hours": return .outsideStoreHours
        case "outside_working_hours": return .outsideWorkingHours
        case "store_closed": return .storeClosed
        case "barber_closed": return .barberClosed
        case "date_out_of_range": return .dateOutOfRange
        case "invalid_slot_alignment", "invalid_slot": return .invalidSlot
        case "invalid_phone": return .invalidPhone
        case "invalid_name": return .invalidName
        case "service_not_found": return .serviceNotFound
        case "barber_not_found": return .barberNotFound
        case "too_many_active_bookings": return .tooManyActiveBookings
        case "booking_not_active", "cannot_cancel", "booking_not_found": return .bookingNotActive
        case "day_off_exists": return .dayOffExists
        case "invalid_slug": return .invalidSlug
        case "slug_taken": return .slugTaken
        case "slug_locked": return .slugLocked
        case "invalid_label": return .invalidLabel
        case "email_taken", "email_exists", "user_already_exists": return .emailTaken
        case "invalid_email", "email_address_invalid": return .invalidEmail
        case "login_exists": return .loginExists
        default: return .server(raw)
        }
    }

    var errorDescription: String? { message }

    var message: String {
        switch self {
        case .forbidden: return "You can't change this chair."
        case .notSignedIn: return "You've been signed out. Sign in again."
        case .invalidCredentials: return "That email and password don't match, or this login is turned off."
        case .weakPassword: return "Pick a different password: at least 8 characters, not your temporary one."
        case .network: return "Can't reach the shop's system. Check your connection and pull to refresh."
        case .slotTaken: return "That time was just booked. Pick another time."
        case .outsideStoreHours: return "Those hours are outside the shop's hours for that day (10 AM – 6 PM, closed Tuesdays)."
        case .outsideWorkingHours: return "The barber isn't working at that time."
        case .storeClosed: return "The shop is closed at that time."
        case .barberClosed: return "That day is a day off for this chair."
        case .dateOutOfRange: return "That date is too far out. Bookings go up to 60 days ahead."
        case .invalidSlot: return "That time isn't on the 45-minute grid. Pick a listed time."
        case .invalidPhone: return "Enter a 10-digit phone number."
        case .invalidName: return "Enter the customer's name (at least 2 characters)."
        case .serviceNotFound: return "That service isn't offered any more. Pick another."
        case .barberNotFound: return "This barber isn't taking bookings (inactive)."
        case .tooManyActiveBookings: return "That phone number already has the most upcoming bookings allowed."
        case .bookingNotActive: return "That appointment was already cancelled or changed. Pull to refresh."
        case .dayOffExists: return "That day is already a day off."
        case .invalidSlug: return "Link name: 2–30 lowercase letters, numbers or dashes."
        case .slugTaken: return "Another barber already uses that link name."
        case .slugLocked: return "The link name can't change once the barber has bookings."
        case .invalidLabel: return "Give the link a name of 1–60 characters."
        case .emailTaken: return "That email already has a login."
        case .invalidEmail: return "Enter a valid email address."
        case .loginExists: return "This barber already has a login."
        case .server(let code): return "The shop's system refused that (\(code)). Try again."
        }
    }
}
