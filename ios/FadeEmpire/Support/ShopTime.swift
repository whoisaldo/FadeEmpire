import Foundation

/// The shop's fixed facts. Every date and time in the app is read in the shop's zone,
/// whatever zone the phone is set to.
enum Shop {
    static let timeZone = TimeZone(identifier: "America/New_York")!
    static let locale = Locale(identifier: "en_US_POSIX")
    static let slotMinutes = 45

    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        c.locale = locale
        return c
    }()
}

/// A calendar day in the shop's zone. `YYYY-MM-DD` on the wire.
struct ShopDay: Hashable, Comparable, Identifiable, Codable, Sendable {
    let year: Int
    let month: Int
    let day: Int

    var id: String { iso }

    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    init?(iso: String) {
        let parts = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]), (1...31).contains(parts[2]) else { return nil }
        self.init(year: parts[0], month: parts[1], day: parts[2])
    }

    /// The shop-zone day an instant falls on.
    init(_ date: Date) {
        let c = Shop.calendar.dateComponents([.year, .month, .day], from: date)
        self.init(year: c.year!, month: c.month!, day: c.day!)
    }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let day = ShopDay(iso: raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad date \(raw)"))
        }
        self = day
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(iso)
    }

    var iso: String { String(format: "%04d-%02d-%02d", year, month, day) }

    /// Midnight at the shop on this day.
    var start: Date {
        Shop.calendar.date(from: DateComponents(year: year, month: month, day: day))!
    }

    /// Noon is never skipped or repeated by a DST change, so day arithmetic goes through it.
    private var noon: Date {
        Shop.calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }

    func adding(days: Int) -> ShopDay {
        ShopDay(Shop.calendar.date(byAdding: .day, value: days, to: noon)!)
    }

    /// 0 = Sunday … 6 = Saturday, the numbering `store_hours` and `barber_schedules` use.
    var weekday: Int { Shop.calendar.component(.weekday, from: noon) - 1 }

    func days(until other: ShopDay) -> Int {
        Shop.calendar.dateComponents([.day], from: noon, to: other.noon).day!
    }

    /// The instant this day and shop time happen.
    func at(_ time: ShopTime) -> Date {
        Shop.calendar.date(from: DateComponents(year: year, month: month, day: day,
                                                hour: time.minutes / 60, minute: time.minutes % 60))!
    }

    static func < (a: ShopDay, b: ShopDay) -> Bool { a.iso < b.iso }
}

/// A wall-clock time at the shop, as minutes after midnight. `HH:MM:SS` on the wire.
struct ShopTime: Hashable, Comparable, Codable, Sendable {
    let minutes: Int

    init(minutes: Int) { self.minutes = minutes }

    init(hour: Int, minute: Int = 0) { self.minutes = hour * 60 + minute }

    init?(hms: String) {
        let parts = hms.split(separator: ":").compactMap { Int($0) }
        guard parts.count >= 2, (0...24).contains(parts[0]), (0...59).contains(parts[1]) else { return nil }
        self.minutes = parts[0] * 60 + parts[1]
    }

    /// The shop-zone time of day an instant falls on.
    init(_ date: Date) {
        let c = Shop.calendar.dateComponents([.hour, .minute], from: date)
        self.minutes = c.hour! * 60 + c.minute!
    }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let t = ShopTime(hms: raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad time \(raw)"))
        }
        self = t
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(hms)
    }

    var hms: String { String(format: "%02d:%02d:00", minutes / 60, minutes % 60) }
    var hhmm: String { String(format: "%02d:%02d", minutes / 60, minutes % 60) }

    func adding(minutes delta: Int) -> ShopTime { ShopTime(minutes: minutes + delta) }

    static func < (a: ShopTime, b: ShopTime) -> Bool { a.minutes < b.minutes }
}

/// "Now", injectable so the mock and the tests can pin it.
struct ShopClock: Sendable {
    var now: @Sendable () -> Date

    static let system = ShopClock { Date() }

    static func fixed(_ date: Date) -> ShopClock { ShopClock { date } }

    var today: ShopDay { ShopDay(now()) }
    var timeOfDay: ShopTime { ShopTime(now()) }
}

/// Every user-visible date, time and price format in one place.
enum ShopFormat {
    private static func formatter(_ pattern: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Shop.locale
        f.timeZone = Shop.timeZone
        f.dateFormat = pattern
        return f
    }

    private static let shortDay = formatter("EEE MMM d")
    private static let longDay = formatter("EEEE, MMMM d")
    private static let weekdayShort = formatter("EEE")
    private static let stamp = formatter("EEE MMM d, h:mm a")

    /// "2:15 PM"
    static func time(_ t: ShopTime) -> String {
        let h = (t.minutes / 60) % 24
        let m = t.minutes % 60
        let h12 = h % 12 == 0 ? 12 : h % 12
        return String(format: "%d:%02d %@", h12, m, h < 12 ? "AM" : "PM")
    }

    /// "Thu Oct 23"
    static func day(_ d: ShopDay) -> String { shortDay.string(from: d.start) }

    /// "Thursday, October 23"
    static func longDay(_ d: ShopDay) -> String { longDay.string(from: d.start) }

    /// "Thu"
    static func weekday(_ d: ShopDay) -> String { weekdayShort.string(from: d.start) }

    /// "Thu Oct 23, 2:15 PM" for an instant, read in the shop's zone.
    static func timestamp(_ date: Date) -> String { stamp.string(from: date) }

    /// "Thu Oct 23, 2:15 PM" for a booking's shop-local day and time.
    static func slot(_ d: ShopDay, _ t: ShopTime) -> String { "\(day(d)), \(time(t))" }

    /// $30 / $30.50, the site's formatPrice.
    static func price(cents: Int) -> String {
        if cents == 0 { return "$0" }
        return cents % 100 == 0 ? "$\(cents / 100)" : String(format: "$%.2f", Double(cents) / 100)
    }

    /// Postgres `timestamptz` text ("2026-10-22T13:05:00.123456+00:00") or plain ISO 8601.
    static func parseTimestamp(_ raw: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: raw) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: raw) { return d }
        // Postgres may send a space separator and a short "+00" offset.
        var s = raw.replacingOccurrences(of: " ", with: "T")
        if let r = s.range(of: #"[+-]\d{2}$"#, options: .regularExpression) { s.replaceSubrange(r, with: s[r] + ":00") }
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        return iso.date(from: s)
    }
}
