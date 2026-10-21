import XCTest
@testable import FadeEmpire

/// Shop-zone dates and times must not depend on the phone's zone.
final class ShopTimeTests: XCTestCase {
    private var savedZone: TimeZone!

    override func setUp() {
        savedZone = NSTimeZone.default
        // A phone set far from Chicopee.
        NSTimeZone.default = TimeZone(identifier: "Asia/Tokyo")!
    }

    override func tearDown() { NSTimeZone.default = savedZone }

    private func utc(_ s: String) -> Date { ISO8601DateFormatter().date(from: s)! }

    func testTimeLabels() {
        XCTAssertEqual(ShopFormat.time(ShopTime(hour: 10)), "10:00 AM")
        XCTAssertEqual(ShopFormat.time(ShopTime(hour: 12, minute: 15)), "12:15 PM")
        XCTAssertEqual(ShopFormat.time(ShopTime(hour: 0, minute: 5)), "12:05 AM")
        XCTAssertEqual(ShopFormat.time(ShopTime(hms: "17:30:00")!), "5:30 PM")
        XCTAssertEqual(ShopTime(hms: "14:15:00")?.hms, "14:15:00")
        XCTAssertEqual(ShopTime(hour: 9, minute: 5).hhmm, "09:05")
        XCTAssertNil(ShopTime(hms: "noon"))
    }

    func testDayLabelsAndWeekdays() {
        let d = ShopDay(iso: "2026-10-23")!
        XCTAssertEqual(ShopFormat.day(d), "Fri Oct 23")
        XCTAssertEqual(ShopFormat.longDay(d), "Friday, October 23")
        XCTAssertEqual(d.weekday, 5)
        XCTAssertEqual(ShopDay(iso: "2026-10-27")!.weekday, 2, "Tuesday, the shop's closed day")
        XCTAssertNil(ShopDay(iso: "2026-13-01"))
    }

    func testTodayIsTheShopsDayNotThePhones() {
        // 03:00 UTC on Oct 22 is still Oct 21 in Chicopee (and already noon on the 22nd in Tokyo).
        XCTAssertEqual(ShopDay(utc("2026-10-22T03:00:00Z")).iso, "2026-10-21")
        XCTAssertEqual(ShopTime(utc("2026-10-22T03:00:00Z")), ShopTime(hour: 23))
        XCTAssertEqual(ShopClock.fixed(utc("2026-10-22T17:00:00Z")).today.iso, "2026-10-22")
    }

    func testFallBackDSTBoundary() {
        // Clocks go back at 2 AM on Sunday Nov 1, 2026: 1:30 AM happens twice.
        XCTAssertEqual(ShopFormat.timestamp(utc("2026-11-01T05:30:00Z")), "Sun Nov 1, 1:30 AM")
        XCTAssertEqual(ShopFormat.timestamp(utc("2026-11-01T06:30:00Z")), "Sun Nov 1, 1:30 AM")
        // A 10 AM slot is 14:00 UTC the day before and 15:00 UTC on the day.
        XCTAssertEqual(ShopDay(iso: "2026-10-31")!.at(ShopTime(hour: 10)), utc("2026-10-31T14:00:00Z"))
        XCTAssertEqual(ShopDay(iso: "2026-11-01")!.at(ShopTime(hour: 10)), utc("2026-11-01T15:00:00Z"))
        // The day strip walks across the change without skipping or repeating a day.
        let strip = (0..<4).map { ShopDay(iso: "2026-10-30")!.adding(days: $0).iso }
        XCTAssertEqual(strip, ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"])
        XCTAssertEqual(ShopDay(iso: "2026-10-30")!.days(until: ShopDay(iso: "2026-11-02")!), 3)
    }

    func testSpringForwardDSTBoundary() {
        // Mar 8, 2026: 2:30 AM does not exist; 07:30 UTC is 3:30 AM EDT.
        XCTAssertEqual(ShopFormat.timestamp(utc("2026-03-08T07:30:00Z")), "Sun Mar 8, 3:30 AM")
        XCTAssertEqual(ShopDay(iso: "2026-03-07")!.adding(days: 1).iso, "2026-03-08")
        XCTAssertEqual(ShopDay(iso: "2026-03-08")!.adding(days: 1).iso, "2026-03-09")
    }

    func testPostgresTimestamps() {
        XCTAssertEqual(ShopFormat.parseTimestamp("2026-10-22T17:05:00.123456+00:00")?.timeIntervalSince1970.rounded(),
                       utc("2026-10-22T17:05:00Z").timeIntervalSince1970)
        XCTAssertEqual(ShopFormat.parseTimestamp("2026-10-22 17:05:00+00"), utc("2026-10-22T17:05:00Z"))
        XCTAssertEqual(ShopFormat.parseTimestamp("2026-10-22T17:05:00Z"), utc("2026-10-22T17:05:00Z"))
        XCTAssertNil(ShopFormat.parseTimestamp("yesterday"))
    }

    func testPrices() {
        XCTAssertEqual(ShopFormat.price(cents: 3000), "$30")
        XCTAssertEqual(ShopFormat.price(cents: 3050), "$30.50")
        XCTAssertEqual(ShopFormat.price(cents: 0), "$0")
        // VIP includes the beard; wax is extra.
        XCTAssertEqual(Catalog.totalCents(service: "vip-haircut", addons: ["beard", "wax"]), 6500)
        XCTAssertEqual(Catalog.totalCents(service: "hair-cut", addons: ["beard", "hot-towel"]), 5000)
    }

    func testDecodesWireRows() throws {
        let json = """
        {"id":"6b1f8a2e-0000-4000-8000-000000000001","barber_id":"00000000-0000-4000-8000-0000000000a1",
         "barber_slug":"hassan","booking_date":"2026-10-23","booking_time":"14:15:00","end_time":"15:00:00",
         "service_slug":"hair-cut","service_name":"Hair Cut","duration_minutes":30,"addons":["Hot Towel"],
         "custom_request":null,"customer_notes":null,"customer_name":"Marcus Reed","customer_phone":"4135550134",
         "total_price_cents":3500,"status":"no_show","source":"web","is_guest":false,
         "party_id":"6b1f8a2e-0000-4000-8000-0000000000ff","party_size":1,
         "created_at":"2026-10-20T21:14:00.5+00:00","cancelled_at":null,"cancelled_by":null,"can_manage":true}
        """
        let b = try JSONDecoder().decode(Booking.self, from: Data(json.utf8))
        XCTAssertEqual(b.status, .noShow)
        XCTAssertEqual(b.date.iso, "2026-10-23")
        XCTAssertEqual(ShopFormat.slot(b.date, b.time), "Fri Oct 23, 2:15 PM")
        XCTAssertEqual(ShopFormat.timestamp(b.createdAt.date), "Tue Oct 20, 5:14 PM")
    }
}
