import Foundation
import Observation

/// How a day reads in the strip and above its list.
enum DayStatus: Equatable {
    case open(OpenHours)
    case shopClosed
    case notWorking
    case dayOff(reason: String?)
    case chairInactive

    var label: String? {
        switch self {
        case .open: return nil
        case .shopClosed: return "Shop closed"
        case .notWorking: return "Not working"
        case .dayOff(let reason): return reason.map { "Day off · \($0)" } ?? "Day off"
        case .chairInactive: return "Chair inactive"
        }
    }

    var isOpen: Bool { if case .open = self { return true } else { return false } }
}

enum AppointmentAction: Equatable { case cancel, markNoShow, undoNoShow }

/// The Schedule tab: one chair, today plus 4 weeks.
@MainActor @Observable
final class ScheduleModel {
    let app: AppModel
    var selectedDay: ShopDay
    private(set) var bookings: [Booking] = []
    private(set) var daysOff: [ShopDay: DayOff] = [:]
    private(set) var hours: [Int: ScheduleDay] = [:]
    var error: String?
    @ObservationIgnored private var loads = LoadGeneration()

    init(app: AppModel) {
        self.app = app
        selectedDay = app.clock.today
    }

    static let windowDays = 28

    var today: ShopDay { app.clock.today }
    var days: [ShopDay] { (0...Self.windowDays).map { today.adding(days: $0) } }
    var chair: Chair? { app.selectedChair }
    var chairs: [Chair] { app.chairs }
    var showsChairSwitcher: Bool { chairs.count > 1 }
    var isViewOnly: Bool { !(chair?.canManage ?? false) }
    var canAddAppointment: Bool { (chair?.canManage ?? false) && (chair?.isActive ?? false) }

    func bookings(on day: ShopDay) -> [Booking] {
        bookings.filter { $0.date == day }.sorted { $0.time < $1.time }
    }

    /// Bookings still holding a slot that day (the strip's count).
    func activeCount(on day: ShopDay) -> Int {
        bookings.filter { $0.date == day && $0.status.isActive }.count
    }

    func status(of day: ShopDay) -> DayStatus {
        if chair?.isActive == false { return .chairInactive }
        guard let store = Catalog.storeHours[day.weekday] else { return .shopClosed }
        if let off = daysOff[day] { return .dayOff(reason: Self.visibleReason(off, canManage: chair?.canManage ?? false)) }
        guard let mine = hours[day.weekday] else { return .notWorking }
        return .open(OpenHours(open: max(store.open, mine.open), close: min(store.close, mine.close)))
    }

    /// A day off's reason is for the chair's barber and the manager: a chair the user only views
    /// shows "Day off", whether or not the server sent the reason.
    nonisolated static func visibleReason(_ off: DayOff, canManage: Bool) -> String? {
        canManage ? off.reason : nil
    }

    /// What the appointment screen may offer. View-only chairs get nothing.
    static func actions(for booking: Booking) -> [AppointmentAction] {
        guard booking.canManage else { return [] }
        switch booking.status {
        case .pending, .confirmed: return [.cancel, .markNoShow]
        case .completed: return [.markNoShow]
        case .noShow: return [.undoNoShow]
        case .cancelled, .expired: return []
        }
    }

    /// Others booked together with this one (same party), in time order.
    func partyMembers(of booking: Booking) -> [Booking] {
        guard booking.partySize > 1, let party = booking.partyId else { return [] }
        return bookings.filter { $0.partyId == party && $0.id != booking.id }.sorted { $0.time < $1.time }
    }

    func selectChair(_ id: UUID) async {
        guard id != app.selectedChairId else { return }
        app.selectedChairId = id
        bookings = []
        daysOff = [:]
        hours = [:]
        await load()
    }

    /// The day a tapped push asked for (its chair is already selected), or today when
    /// that day is outside the strip.
    func showRequestedDay() async {
        guard let day = app.requestedDay else { return }
        app.requestedDay = nil
        selectedDay = days.contains(day) ? day : today
        if bookings.contains(where: { $0.barberId != chair?.id }) {   // the push was for another chair
            bookings = []
            daysOff = [:]
            hours = [:]
        }
        await load()
    }

    func load() async {
        guard let chair else { return }
        if !days.contains(selectedDay) { selectedDay = today }
        let generation = loads.next()
        do {
            async let b = app.backend.bookings(barberId: chair.id, from: today, to: today.adding(days: Self.windowDays))
            async let off = app.backend.daysOff(barberId: chair.id)
            async let h = app.backend.weeklyHours(barberId: chair.id)
            let (rows, closures, week) = try await (b, off, h)
            guard loads.isCurrent(generation), chair.id == app.selectedChair?.id else { return }
            bookings = rows
            daysOff = Dictionary(closures.map { ($0.date, $0) }, uniquingKeysWith: { a, _ in a })
            hours = Dictionary(week.map { ($0.weekday, $0) }, uniquingKeysWith: { a, _ in a })
            error = nil
            await app.refreshUnread()
        } catch {
            guard loads.isCurrent(generation) else { return }
            self.error = app.handle(error)
        }
    }

    func cancel(_ booking: Booking) async throws -> CancelledBooking {
        let result = try await app.backend.cancelBooking(id: booking.id)
        await load()
        return result
    }

    func setStatus(_ booking: Booking, _ status: BookingStatus) async throws {
        try await app.backend.setStatus(bookingId: booking.id, status: status)
        await load()
    }

    func booking(id: UUID) -> Booking? { bookings.first { $0.id == id } }
}
