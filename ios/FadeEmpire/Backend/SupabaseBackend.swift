import Foundation
import Supabase

/// The real API: migration 0022's RPCs, the `booking_links`, `barbers` and
/// `barber_schedules` tables, the `barber-photos` bucket, and the `staff-admin` function.
final class SupabaseBackend: Backend {
    let client: SupabaseClient

    init(url: URL, key: String) {
        client = SupabaseClient(
            supabaseURL: url, supabaseKey: key,
            options: SupabaseClientOptions(auth: .init(emitLocalSessionAsInitialSession: true)))
    }

    /// Runs one call and turns whatever it throws into a `BackendError`.
    private func call<T>(_ body: () async throws -> T) async throws -> T {
        do { return try await body() } catch { throw Self.mapError(error) }
    }

    private func rpc<T: Decodable>(_ fn: String, _ params: [String: AnyJSON] = [:]) async throws -> T {
        try await call { try await client.rpc(fn, params: params).execute().value }
    }

    /// A set-returning function that answers one row, or none.
    private func rpcRow<T: Decodable>(_ fn: String, _ params: [String: AnyJSON] = [:]) async throws -> T? {
        let rows: [T] = try await rpc(fn, params)
        return rows.first
    }

    private func rpcVoid(_ fn: String, _ params: [String: AnyJSON] = [:]) async throws {
        try await call { _ = try await client.rpc(fn, params: params).execute() }
    }

    private static func id(_ u: UUID) -> AnyJSON { .string(u.uuidString.lowercased()) }
    private static func text(_ s: String?) -> AnyJSON { s.map { .string($0) } ?? .null }

    // MARK: - Errors

    /// Postgres raises the contract's codes as the exception text, so PostgREST sends
    /// `{"code": "42501", "message": "forbidden"}` and the message is what matches. Table
    /// writes fail with a bare SQLSTATE instead: RLS (42501), the label check (23514), the
    /// service foreign key (23503). Auth sends an error code; staff-admin answers
    /// `{"error": "<code>"}` with a non-2xx status.
    static func mapError(_ error: Error) -> BackendError {
        switch error {
        case let e as BackendError:
            return e
        case let e as PostgrestError:
            let mapped = BackendError.from(code: e.message)
            guard case .server = mapped else { return mapped }
            switch e.code {
            case "42501": return .forbidden
            case "23505": return .slotTaken
            case "23514": return .invalidLabel
            case "23503": return .serviceNotFound
            case "PGRST301", "PGRST303": return .notSignedIn
            default: return mapped
            }
        case let e as AuthError:
            switch e {
            case .sessionMissing: return .notSignedIn
            case .weakPassword: return .weakPassword
            default:
                // Older Auth servers answer a bad password with `invalid_grant`.
                if e.errorCode.rawValue == "invalid_grant" { return .invalidCredentials }
                return BackendError.from(code: e.errorCode.rawValue)
            }
        case let e as FunctionsError:
            guard case let .httpError(status, data) = e else { return .network }
            struct Body: Decodable { let error: String }
            if let body = try? JSONDecoder().decode(Body.self, from: data) { return .from(code: body.error) }
            if status == 401 { return .notSignedIn }
            if status == 403 { return .forbidden }
            return .server("staff-admin \(status)")
        case is URLError:
            return .network
        case let e as StorageError:
            return .server(e.message)
        case is DecodingError:
            return .server("unexpected_response")
        default:
            return .server(String(describing: error))
        }
    }

    // MARK: - Auth

    func restoreSession() async -> Bool {
        (try? await client.auth.session) != nil
    }

    func signIn(email: String, password: String) async throws {
        try await call {
            _ = try await client.auth.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
        }
    }

    func changePassword(_ newPassword: String) async throws {
        try await call { _ = try await client.auth.update(user: UserAttributes(password: newPassword)) }
        try await rpcVoid("app_password_changed")
    }

    func signOut() async throws {
        try await call { try await client.auth.signOut(scope: .local) }
    }

    func currentEmail() async -> String? { client.auth.currentUser?.email }

    // MARK: - App RPCs

    func me() async throws -> Me {
        guard let me: Me = try await rpcRow("app_me") else { throw BackendError.noAccess }
        return me
    }

    func bookings(barberId: UUID, from: ShopDay, to: ShopDay) async throws -> [Booking] {
        try await rpc("app_bookings", ["p_barber_id": Self.id(barberId), "p_from": .string(from.iso), "p_to": .string(to.iso)])
    }

    func freeSlots(barberId: UUID, date: ShopDay) async throws -> [ShopTime] {
        struct Row: Decodable { let slot_time: ShopTime }
        let rows: [Row] = try await rpc("app_free_slots", ["p_barber_id": Self.id(barberId), "p_date": .string(date.iso)])
        return rows.map(\.slot_time)
    }

    func book(_ n: NewBooking) async throws -> UUID {
        try await rpc("app_book", [
            "p_barber_id": Self.id(n.barberId),
            "p_service_slug": .string(n.serviceSlug),
            "p_date": .string(n.date.iso),
            "p_time": .string(n.time.hms),
            "p_customer_name": .string(n.customerName),
            "p_customer_phone": .string(Phone.digits(n.customerPhone)),
            "p_addon_slugs": .array(n.addonSlugs.map { .string($0) }),
            "p_notes": Self.text(n.notes),
        ])
    }

    func cancelBooking(id: UUID) async throws -> CancelledBooking {
        guard let row: CancelledBooking = try await rpcRow("app_cancel_booking", ["p_booking_id": Self.id(id)]) else {
            throw BackendError.bookingNotFound
        }
        return row
    }

    func setStatus(bookingId: UUID, status: BookingStatus) async throws {
        try await rpcVoid("app_set_status", ["p_booking_id": Self.id(bookingId), "p_status": .string(status.rawValue)])
    }

    func activity(before: Int64?, limit: Int) async throws -> [ActivityEvent] {
        try await rpc("app_activity", ["p_before": before.map { .integer(Int($0)) } ?? .null, "p_limit": .integer(limit)])
    }

    func markActivitySeen() async throws { try await rpcVoid("app_mark_activity_seen") }

    func daysOff(barberId: UUID) async throws -> [DayOff] {
        try await rpc("app_days_off", ["p_barber_id": Self.id(barberId)])
    }

    func addDayOff(barberId: UUID, date: ShopDay, reason: String?) async throws -> Int {
        try await rpc("app_add_day_off", ["p_barber_id": Self.id(barberId), "p_date": .string(date.iso), "p_reason": Self.text(reason)])
    }

    func removeDayOff(barberId: UUID, date: ShopDay) async throws {
        try await rpcVoid("app_remove_day_off", ["p_barber_id": Self.id(barberId), "p_date": .string(date.iso)])
    }

    func setNotifyPrefs(bookings: Bool, cancellations: Bool, viewedChairs: Bool) async throws {
        try await rpcVoid("app_set_notify_prefs", ["p_bookings": .bool(bookings), "p_cancellations": .bool(cancellations),
                                                   "p_viewed_chairs": .bool(viewedChairs)])
    }

    func registerDevice(token: String, environment: String) async throws {
        try await rpcVoid("app_register_device", ["p_token": .string(token), "p_environment": .string(environment)])
    }

    func unregisterDevice(token: String) async throws {
        try await rpcVoid("app_unregister_device", ["p_token": .string(token)])
    }

    func weeklyHours(barberId: UUID) async throws -> [ScheduleDay] {
        try await call {
            try await client.from("barber_schedules").select("weekday,open_time,close_time")
                .eq("barber_id", value: barberId.uuidString.lowercased()).order("weekday").execute().value
        }
    }

    // MARK: - booking_links

    private static let linkColumns = "id,barber_id,label,service_slug,created_at"

    func links(barberId: UUID) async throws -> [BookingLink] {
        try await call {
            try await client.from("booking_links").select(Self.linkColumns)
                .eq("barber_id", value: barberId.uuidString.lowercased()).order("created_at").execute().value
        }
    }

    func addLink(barberId: UUID, label: String, serviceSlug: String?) async throws -> BookingLink {
        let row: [String: AnyJSON] = ["barber_id": Self.id(barberId), "label": .string(label), "service_slug": Self.text(serviceSlug)]
        return try await call {
            try await client.from("booking_links").insert(row, returning: .representation)
                .select(Self.linkColumns).single().execute().value
        }
    }

    func deleteLink(id: UUID) async throws {
        try await call { _ = try await client.from("booking_links").delete().eq("id", value: id.uuidString.lowercased()).execute() }
    }

    // MARK: - Manager

    func barbers() async throws -> [Barber] {
        try await call {
            try await client.from("barbers").select("id,slug,display_name,title,bio,photo_url,is_active,sort_order")
                .order("sort_order").execute().value
        }
    }

    func staff() async throws -> [StaffMember] { try await rpc("manager_staff") }

    func saveBarber(_ d: BarberDraft) async throws -> UUID {
        do {
            return try await rpc("manager_save_barber", [
                "p_id": d.id.map(Self.id) ?? .null,
                "p_slug": .string(d.slug),
                "p_display_name": .string(d.displayName),
                "p_title": .string(d.title),
                "p_bio": .string(d.bio),
                "p_photo_url": Self.text(d.photoUrl),
            ])
        } catch BackendError.invalidName {
            throw BackendError.invalidBarberName   // the barber's name here, not a customer's
        }
    }

    func uploadBarberPhoto(_ jpeg: Data, slug: String) async throws -> String {
        let path = "\(slug)/\(UUID().uuidString.lowercased()).jpg"
        return try await call {
            let bucket = client.storage.from("barber-photos")
            try await bucket.upload(path, data: jpeg, options: FileOptions(contentType: "image/jpeg", upsert: false))
            return try bucket.getPublicURL(path: path).absoluteString
        }
    }

    func barberSchedule(barberId: UUID) async throws -> [ScheduleDay] {
        try await rpc("manager_barber_schedule", ["p_barber_id": Self.id(barberId)])
    }

    /// `affected_bookings int`. A backend from before that change answers 204 with no body: 0.
    func setSchedule(barberId: UUID, days: [ScheduleDay]) async throws -> Int {
        let json: [AnyJSON] = days.map { .object(["weekday": .integer($0.weekday), "open": .string($0.open.hhmm), "close": .string($0.close.hhmm)]) }
        let response = try await call {
            try await client.rpc("manager_set_schedule", params: ["p_barber_id": Self.id(barberId), "p_days": .array(json)]).execute()
        }
        guard !response.data.isEmpty else { return 0 }
        return (try? JSONDecoder().decode(Int.self, from: response.data)) ?? 0
    }

    func setActive(barberId: UUID, active: Bool) async throws -> Int {
        try await rpc("manager_set_active", ["p_barber_id": Self.id(barberId), "p_active": .bool(active)])
    }

    func viewGrants() async throws -> [ViewGrant] { try await rpc("manager_view_grants") }

    func setViewGrant(viewer: UUID, barber: UUID, granted: Bool) async throws {
        try await rpcVoid("manager_set_view_grant", ["p_viewer_barber_id": Self.id(viewer), "p_barber_id": Self.id(barber),
                                                     "p_granted": .bool(granted)])
    }

    // MARK: - staff-admin

    private func staffAdmin<T: Decodable>(_ body: [String: AnyJSON]) async throws -> T {
        try await call { try await client.functions.invoke("staff-admin", options: FunctionInvokeOptions(body: body)) }
    }

    func createLogin(email: String, displayName: String, role: Role, barberId: UUID?) async throws -> CreatedLogin {
        try await staffAdmin(["action": "create_login", "email": .string(email.trimmingCharacters(in: .whitespaces).lowercased()),
                              "display_name": .string(displayName), "role": .string(role.rawValue),
                              "barber_id": barberId.map(Self.id) ?? .null])
    }

    func resetPassword(userId: UUID) async throws -> String {
        struct Reply: Decodable { let temporary_password: String }
        let r: Reply = try await staffAdmin(["action": "reset_password", "user_id": Self.id(userId)])
        return r.temporary_password
    }

    func setLoginDisabled(userId: UUID, disabled: Bool) async throws {
        struct Reply: Decodable { let ok: Bool }
        let _: Reply = try await staffAdmin(["action": .string(disabled ? "disable_login" : "enable_login"), "user_id": Self.id(userId)])
    }
}
