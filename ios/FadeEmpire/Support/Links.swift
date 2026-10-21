import Foundation

/// Booking links into the website (CONTRACT.md, "Booking links").
enum BookingLinks {
    static let site = "https://chicopeefadeempire.com"

    /// `https://chicopeefadeempire.com/larry`
    static func plain(slug: String) -> URL {
        URL(string: "\(site)/\(slug)")!
    }

    /// `https://chicopeefadeempire.com/?barber=larry&service=hair-cut#book`
    static func withService(slug: String, service: String) -> URL {
        var c = URLComponents(string: site + "/")!
        c.queryItems = [URLQueryItem(name: "barber", value: slug), URLQueryItem(name: "service", value: service)]
        c.fragment = "book"
        return c.url!
    }

    /// A custom link opens on its service when it has one; otherwise it is the plain link.
    static func url(for link: BookingLink, slug: String) -> URL {
        link.serviceSlug.map { withService(slug: slug, service: $0) } ?? plain(slug: slug)
    }
}

/// Phone numbers are stored as 10 digits (migration 0011). Calls and texts leave the
/// app only through tel: and sms: URLs.
enum Phone {
    static func digits(_ raw: String) -> String {
        var d = raw.filter(\.isNumber)
        if d.count == 11, d.hasPrefix("1") { d.removeFirst() }
        return d
    }

    /// (413) 555-0134
    static func display(_ raw: String) -> String {
        let d = Array(digits(raw))
        guard d.count == 10 else { return raw }
        return "(\(String(d[0..<3]))) \(String(d[3..<6]))-\(String(d[6..<10]))"
    }

    static func e164(_ raw: String) -> String { "+1" + digits(raw) }

    static func call(_ raw: String) -> URL? { URL(string: "tel:\(e164(raw))") }

    /// The site's sms: form (`sms:+1…?&body=…`), which iOS fills in.
    static func text(_ raw: String, body: String? = nil) -> URL? {
        guard let body else { return URL(string: "sms:\(e164(raw))") }
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=?+#")
        let encoded = body.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return URL(string: "sms:\(e164(raw))?&body=\(encoded)")
    }
}

/// Texts the barber can send from the app.
enum Messages {
    /// The prefilled text to a customer after a cancel. It follows the shop's
    /// cancellation wording (scripts/booking-messages.js, buildCancelMessage), addressed
    /// to the customer, with the barber's booking link to rebook.
    static func cancellation(firstName: String, barberName: String, barberSlug: String,
                             serviceName: String, day: ShopDay, time: ShopTime, bookingId: UUID) -> String {
        [
            "FADE EMPIRE — CANCELLATION",
            "",
            "Name:    \(firstName)",
            "Barber:  \(barberName)",
            "Was:     \(serviceName)",
            "Date:    \(ShopFormat.longDay(day))",
            "Time:    \(ShopFormat.time(time))",
            "Ref:     \(bookingId.uuidString.lowercased().prefix(8))",
            "",
            "Book another time: \(BookingLinks.plain(slug: barberSlug).absoluteString)",
        ].joined(separator: "\n")
    }

    static func firstName(_ full: String) -> String {
        full.split(separator: " ").first.map(String.init) ?? full
    }
}
