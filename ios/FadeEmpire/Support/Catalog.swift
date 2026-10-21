import Foundation

/// Services, add-ons and store hours, mirrored from scripts/config.js and
/// scripts/booking-messages.js. The database prices every booking itself;
/// these only drive the pickers and the price preview.
struct Service: Identifiable, Hashable, Sendable {
    let slug: String
    let name: String
    let priceCents: Int
    let minutes: Int
    var id: String { slug }
}

struct Addon: Identifiable, Hashable, Sendable {
    let slug: String
    let name: String
    let priceCents: Int
    var id: String { slug }
}

struct OpenHours: Hashable, Sendable {
    let open: ShopTime
    let close: ShopTime
}

enum Catalog {
    static let services: [Service] = [
        Service(slug: "hair-cut", name: "Hair Cut", priceCents: 3000, minutes: 30),
        Service(slug: "line-up", name: "Line Up", priceCents: 1000, minutes: 30),
        Service(slug: "beard-trim", name: "Beard Trim", priceCents: 1500, minutes: 30),
        Service(slug: "kids-cut", name: "Kids Cut", priceCents: 2500, minutes: 30),
        Service(slug: "military-cut", name: "Military Cut", priceCents: 2500, minutes: 30),
        Service(slug: "senior-cut", name: "Senior Cut", priceCents: 2500, minutes: 30),
        Service(slug: "vip-haircut", name: "VIP Haircut", priceCents: 6000, minutes: 45),
    ]

    static let addons: [Addon] = [
        Addon(slug: "eyebrows", name: "Eyebrows", priceCents: 0),
        Addon(slug: "hot-towel", name: "Hot Towel", priceCents: 500),
        Addon(slug: "wax", name: "Wax", priceCents: 500),
        Addon(slug: "beard", name: "Beard", priceCents: 1500),
        Addon(slug: "facial", name: "Facial", priceCents: 2000),
    ]

    /// Add-ons a service already includes (config.js INCLUDED_ADDONS).
    static let includedAddons: [String: Set<String>] = [
        "vip-haircut": ["eyebrows", "hot-towel", "facial", "beard"],
        "beard-trim": ["beard"],
    ]

    /// `store_hours`: 10 AM – 6 PM, closed Tuesdays (no entry = closed). 0 = Sunday.
    static let storeHours: [Int: OpenHours] = {
        let day = OpenHours(open: ShopTime(hour: 10), close: ShopTime(hour: 18))
        return [0: day, 1: day, 3: day, 4: day, 5: day, 6: day]
    }()

    static func service(_ slug: String?) -> Service? { services.first { $0.slug == slug } }

    static func serviceName(_ slug: String?) -> String {
        guard let slug else { return "Any service" }
        return service(slug)?.name ?? slug
    }

    static func isIncluded(_ addon: String, in service: String) -> Bool {
        includedAddons[service]?.contains(addon) ?? false
    }

    /// The preview total: the service plus paid add-ons it does not already include.
    static func totalCents(service: String, addons: Set<String>) -> Int {
        let base = self.service(service)?.priceCents ?? 0
        return base + Self.addons
            .filter { addons.contains($0.slug) && !isIncluded($0.slug, in: service) }
            .reduce(0) { $0 + $1.priceCents }
    }

    static let weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
}
