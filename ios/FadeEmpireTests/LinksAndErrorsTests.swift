import Supabase
import XCTest
@testable import FadeEmpire

final class LinksTests: XCTestCase {
    func testPlainLink() {
        XCTAssertEqual(BookingLinks.plain(slug: "larry").absoluteString, "https://chicopeefadeempire.com/larry")
    }

    func testLinkWithService() {
        XCTAssertEqual(BookingLinks.withService(slug: "larry", service: "hair-cut").absoluteString,
                       "https://chicopeefadeempire.com/?barber=larry&service=hair-cut#book")
    }

    func testCustomLinks() {
        let now = Instant(Date())
        let vip = BookingLink(id: UUID(), barberId: UUID(), label: "VIP flyer", serviceSlug: "vip-haircut", createdAt: now)
        let bio = BookingLink(id: UUID(), barberId: UUID(), label: "Instagram bio", serviceSlug: nil, createdAt: now)
        XCTAssertEqual(BookingLinks.url(for: vip, slug: "hassan").absoluteString,
                       "https://chicopeefadeempire.com/?barber=hassan&service=vip-haircut#book")
        XCTAssertEqual(BookingLinks.url(for: bio, slug: "hassan").absoluteString, "https://chicopeefadeempire.com/hassan")
    }

    func testPhoneURLs() {
        XCTAssertEqual(Phone.display("4135550134"), "(413) 555-0134")
        XCTAssertEqual(Phone.display("14135550134"), "(413) 555-0134")
        XCTAssertEqual(Phone.call("413-555-0134")?.absoluteString, "tel:+14135550134")
        XCTAssertEqual(Phone.text("4135550134")?.absoluteString, "sms:+14135550134")
        XCTAssertEqual(Phone.text("4135550134", body: "Hi & bye: 2+2 #1")?.absoluteString,
                       "sms:+14135550134?&body=Hi%20%26%20bye:%202%2B2%20%231")
    }

    func testCancellationText() {
        let id = UUID(uuidString: "6B1F8A2E-1111-4000-8000-000000000001")!
        let text = Messages.cancellation(firstName: "Marcus", barberName: "Hassan", barberSlug: "hassan",
                                         serviceName: "Hair Cut", day: ShopDay(iso: "2026-10-23")!,
                                         time: ShopTime(hour: 14, minute: 15), bookingId: id)
        XCTAssertTrue(text.hasPrefix("FADE EMPIRE — CANCELLATION"))
        XCTAssertTrue(text.contains("Was:     Hair Cut"))
        XCTAssertTrue(text.contains("Date:    Friday, October 23"))
        XCTAssertTrue(text.contains("Time:    2:15 PM"))
        XCTAssertTrue(text.contains("Ref:     6b1f8a2e"))
        XCTAssertTrue(text.contains("https://chicopeefadeempire.com/hassan"))
        XCTAssertEqual(Messages.firstName("Marcus Reed"), "Marcus")
    }

    func testSlugRules() {
        XCTAssertTrue(BarberDraft.isValidSlug("larry"))
        XCTAssertTrue(BarberDraft.isValidSlug("dj-2"))
        XCTAssertFalse(BarberDraft.isValidSlug("L"))
        XCTAssertFalse(BarberDraft.isValidSlug("Larry"))
        XCTAssertFalse(BarberDraft.isValidSlug("larry_b"))
        XCTAssertEqual(BarbersModel.suggestedSlug("Marco  Silva Jr."), "marco-silva-jr")
        XCTAssertEqual(BarbersModel.suggestedSlug("José"), "jose")
    }
}

final class ErrorMappingTests: XCTestCase {
    func testContractCodes() {
        XCTAssertEqual(BackendError.from(code: "forbidden"), .forbidden)
        XCTAssertEqual(BackendError.from(code: "slot_taken"), .slotTaken)
        XCTAssertEqual(BackendError.from(code: "outside_store_hours"), .outsideStoreHours)
        XCTAssertEqual(BackendError.from(code: "outside_working_hours"), .outsideWorkingHours)
        XCTAssertEqual(BackendError.from(code: "invalid_slot_alignment"), .invalidSlot)
        XCTAssertEqual(BackendError.from(code: "slug_taken"), .slugTaken)
        XCTAssertEqual(BackendError.from(code: "invalid_credentials"), .invalidCredentials)
        XCTAssertEqual(BackendError.from(code: "something_new"), .server("something_new"))
    }

    func testMessagesAreSpecific() {
        XCTAssertEqual(BackendError.slotTaken.message, "That time was just booked. Pick another time.")
        XCTAssertTrue(BackendError.outsideStoreHours.message.contains("closed Tuesdays"))
        XCTAssertEqual(BackendError.forbidden.message, "You can't change this chair.")
    }

    func testPostgrestErrors() {
        XCTAssertEqual(SupabaseBackend.mapError(PostgrestError(code: "23505", message: "slot_taken")), .slotTaken)
        XCTAssertEqual(SupabaseBackend.mapError(PostgrestError(code: "P0001", message: "forbidden")), .forbidden)
        XCTAssertEqual(SupabaseBackend.mapError(PostgrestError(code: "P0001", message: "outside_store_hours")), .outsideStoreHours)
        XCTAssertEqual(SupabaseBackend.mapError(PostgrestError(code: "42501", message: "permission denied for function app_book")), .forbidden)
        XCTAssertEqual(SupabaseBackend.mapError(PostgrestError(code: "PGRST301", message: "JWT expired")), .notSignedIn)
    }

    func testFunctionAuthAndNetworkErrors() {
        let body = Data(#"{"error":"email_taken"}"#.utf8)
        XCTAssertEqual(SupabaseBackend.mapError(FunctionsError.httpError(code: 409, data: body)), .emailTaken)
        XCTAssertEqual(SupabaseBackend.mapError(FunctionsError.httpError(code: 403, data: Data())), .forbidden)
        XCTAssertEqual(SupabaseBackend.mapError(AuthError.sessionMissing), .notSignedIn)
        XCTAssertEqual(SupabaseBackend.mapError(URLError(.notConnectedToInternet)), .network)
        XCTAssertEqual(SupabaseBackend.mapError(BackendError.slotTaken), .slotTaken)
    }
}
