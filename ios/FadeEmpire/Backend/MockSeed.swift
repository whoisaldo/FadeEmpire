import Foundation

/// The mock's starting data, laid out around the clock's "today": Hassan and Larry with a
/// week of bookings (a group, a cancellation, a no-show), retired Javier, Hassan's
/// read-only grant on Larry's chair, and the three local logins (password `fade-local-1`).
struct MockSeed {
    static let password = "fade-local-1"
    static let hassanId = UUID(uuidString: "00000000-0000-4000-8000-0000000000a1")!
    static let larryId = UUID(uuidString: "00000000-0000-4000-8000-0000000000a2")!
    static let javierId = UUID(uuidString: "00000000-0000-4000-8000-0000000000a3")!

    var accounts: [MockBackend.Account] = []
    var barbers: [Barber] = []
    var schedules: [UUID: [ScheduleDay]] = [:]
    var grants: Set<ViewGrant> = []
    var bookings: [MockBackend.StoredBooking] = []
    var events: [MockBackend.Event] = []
    var closures: [UUID: [ShopDay: String]] = [:]
    var links: [BookingLink] = []

    init(clock: ShopClock) {
        let now = clock.now()
        let today = clock.today
        let seenAt = now.addingTimeInterval(-3 * 3600)

        barbers = [
            Barber(id: Self.hassanId, slug: "hassan", displayName: "Hassan", title: "Master Barber",
                   bio: "Owner of the shop. Skin fades, tapers and beard work.", photoUrl: nil, isActive: true, sortOrder: 1),
            Barber(id: Self.larryId, slug: "larry", displayName: "Larry", title: "Barber",
                   bio: "Classic cuts and clean line-ups.", photoUrl: nil, isActive: true, sortOrder: 2),
            Barber(id: Self.javierId, slug: "javier", displayName: "Javier", title: "Barber",
                   bio: nil, photoUrl: nil, isActive: false, sortOrder: 3),
        ]
        let fullWeek = [0, 1, 3, 4, 5, 6].map { ScheduleDay(weekday: $0, open: ShopTime(hour: 10), close: ShopTime(hour: 18)) }
        schedules = [Self.hassanId: fullWeek, Self.larryId: fullWeek,
                     Self.javierId: [1, 3, 4, 5, 6].map { ScheduleDay(weekday: $0, open: ShopTime(hour: 10), close: ShopTime(hour: 18)) }]
        grants = [ViewGrant(viewerBarberId: Self.hassanId, barberId: Self.larryId)]

        let ali = UUID(uuidString: "00000000-0000-4000-8000-0000000000f1")!
        let hassan = UUID(uuidString: "00000000-0000-4000-8000-0000000000f2")!
        let larry = UUID(uuidString: "00000000-0000-4000-8000-0000000000f3")!
        accounts = [
            .init(userId: ali, email: "ali@local.test", password: Self.password, role: .manager, displayName: "Ali",
                  barberId: nil, mustChangePassword: false, notifyViewedChairs: true, activitySeenAt: seenAt,
                  lastSignInAt: now.addingTimeInterval(-86_400)),
            .init(userId: hassan, email: "hassan@local.test", password: Self.password, role: .barber, displayName: "Hassan",
                  barberId: Self.hassanId, mustChangePassword: true, activitySeenAt: seenAt,
                  lastSignInAt: now.addingTimeInterval(-7_200)),
            .init(userId: larry, email: "larry@local.test", password: Self.password, role: .barber, displayName: "Larry",
                  barberId: Self.larryId, mustChangePassword: false, activitySeenAt: seenAt,
                  lastSignInAt: now.addingTimeInterval(-3 * 86_400)),
        ]

        // The open days from today on, so the first few always land on working days.
        let openDays = (0..<10).map { today.adding(days: $0) }.filter { Catalog.storeHours[$0.weekday] != nil }
        let slot = { (i: Int) in ShopTime(minutes: 600 + i * Shop.slotMinutes) }  // 0 = 10:00 AM
        // Customers without a fixed name in the layout below; never reused.
        let names = ["Marcus Reed", "Devon Price", "Andre Mitchell", "Chris Nguyen", "Eddie Santos", "Kevin Diaz",
                     "Omar Haddad", "Jordan Hayes", "Sam Patel", "Nate Rivera", "Isaiah Moore", "Brandon Lee",
                     "Victor Cruz", "Darnell King", "Felix Romero", "Theo Grant"]
        var nameIndex = 0
        var phoneSuffix = 120

        func add(_ barber: UUID, _ day: ShopDay, _ slotIndex: Int, _ service: String,
                 addons: [String] = [], notes: String? = nil, name: String? = nil, status: BookingStatus = .confirmed,
                 bookedAgo: TimeInterval = 3 * 86_400, source: String = "web", party: (UUID, Int, Bool)? = nil,
                 phone: String? = nil) -> Booking {
            let svc = Catalog.service(service)!
            let customer = name ?? names[nameIndex % names.count]
            if name == nil { nameIndex += 1 }
            phoneSuffix += 7
            let slug = barber == Self.hassanId ? "hassan" : "larry"
            let created = now.addingTimeInterval(-bookedAgo)
            let b = Booking(
                id: UUID(), barberId: barber, barberSlug: slug, date: day, time: slot(slotIndex),
                endTime: slot(slotIndex).adding(minutes: Shop.slotMinutes), serviceSlug: svc.slug, serviceName: svc.name,
                durationMinutes: svc.minutes,
                addons: Catalog.addons.filter { addons.contains($0.slug) }.map(\.name),
                customRequest: nil, customerNotes: notes, customerName: customer,
                customerPhone: phone ?? "413555\(String(format: "%04d", phoneSuffix))",
                totalPriceCents: Catalog.totalCents(service: svc.slug, addons: Set(addons)),
                status: status, source: source, isGuest: party?.2 ?? false, partyId: party?.0 ?? UUID(),
                partySize: party?.1 ?? 1, createdAt: Instant(created), cancelledAt: nil, cancelledBy: nil, canManage: false)
            bookings.append(.init(row: b, createdBy: nil))
            events.append(.init(id: Int64(events.count + 1), kind: .booked, actor: "customer", occurredAt: created,
                                bookingId: b.id, causedBy: nil))
            return b
        }

        guard openDays.count >= 5 else { return }
        let d0 = openDays[0], d1 = openDays[1], d2 = openDays[2], d3 = openDays[3], d4 = openDays[4]

        // Hassan, first open day: a no-show, a group of two, a cancellation, a VIP booked an hour ago.
        let noShow = add(Self.hassanId, d0, 0, "hair-cut", bookedAgo: 5 * 86_400)
        _ = add(Self.hassanId, d0, 2, "beard-trim", addons: ["hot-towel"], bookedAgo: 4 * 86_400)
        let party = UUID()
        _ = add(Self.hassanId, d0, 6, "hair-cut", name: "Jamal Carter", party: (party, 2, false), phone: "4135550188")
        _ = add(Self.hassanId, d0, 7, "kids-cut", notes: "Jamal's son, first cut at the shop",
                name: "Ezra Carter", party: (party, 2, true), phone: "4135550188")
        let cancelled = add(Self.hassanId, d0, 8, "line-up", name: "Luis Ortega", bookedAgo: 2 * 86_400)
        _ = add(Self.hassanId, d0, 9, "vip-haircut", addons: ["wax"], notes: "Wants the beard kept long on the chin",
                name: "Tyler Brooks", bookedAgo: 3_600)

        // Larry, first open day; one booked two hours ago shows unread to Hassan.
        _ = add(Self.larryId, d0, 1, "hair-cut")
        _ = add(Self.larryId, d0, 3, "military-cut", source: "phone")
        _ = add(Self.larryId, d0, 7, "hair-cut", addons: ["eyebrows"], name: "Malik Johnson", bookedAgo: 7_200)

        // The rest of the week.
        _ = add(Self.hassanId, d1, 1, "hair-cut")
        _ = add(Self.hassanId, d1, 4, "senior-cut")
        _ = add(Self.hassanId, d1, 8, "hair-cut", addons: ["beard"])
        _ = add(Self.larryId, d1, 2, "line-up")
        let moved = add(Self.larryId, d1, 5, "hair-cut", name: "Ray Thompson", bookedAgo: 86_400)
        _ = add(Self.hassanId, d2, 0, "vip-haircut")
        _ = add(Self.hassanId, d2, 5, "hair-cut")
        _ = add(Self.larryId, d2, 3, "kids-cut")
        _ = add(Self.hassanId, d3, 2, "hair-cut")
        _ = add(Self.larryId, d3, 6, "beard-trim")
        _ = add(Self.hassanId, d4, 3, "military-cut")
        _ = add(Self.larryId, d4, 1, "hair-cut")

        func setStatus(_ b: Booking, _ status: BookingStatus, by: String, at: Date) {
            let i = bookings.firstIndex { $0.row.id == b.id }!
            bookings[i].row.status = status
            if status == .cancelled {
                bookings[i].row.cancelledAt = Instant(at)
                bookings[i].row.cancelledBy = by
            }
        }
        // The no-show is marked by Hassan himself, so it is not unread for him.
        let noShowAt = min(now, d0.at(slot(0)).addingTimeInterval(1_500))
        setStatus(noShow, .noShow, by: "barber", at: noShowAt)
        events.append(.init(id: Int64(events.count + 1), kind: .noShow, actor: "barber", occurredAt: noShowAt,
                            bookingId: noShow.id, causedBy: hassan))
        let cancelAt = now.addingTimeInterval(-2_400)
        setStatus(cancelled, .cancelled, by: "customer", at: cancelAt)
        events.append(.init(id: Int64(events.count + 1), kind: .cancelled, actor: "customer", occurredAt: cancelAt,
                            bookingId: cancelled.id, causedBy: nil))
        events.append(.init(id: Int64(events.count + 1), kind: .moved, actor: "customer",
                            occurredAt: now.addingTimeInterval(-26 * 3_600), bookingId: moved.id, causedBy: nil))
        events.sort { $0.occurredAt < $1.occurredAt }
        events = events.enumerated().map { i, e in
            .init(id: Int64(i + 1), kind: e.kind, actor: e.actor, occurredAt: e.occurredAt, bookingId: e.bookingId,
                  causedBy: e.causedBy)
        }

        // Larry has a day off later in the week; Hassan has one in two weeks.
        closures = [Self.larryId: [openDays[5]: "Family event"],
                    Self.hassanId: [(14..<21).map { today.adding(days: $0) }.first { Catalog.storeHours[$0.weekday] != nil }!: ""]]

        links = [BookingLink(id: UUID(), barberId: Self.hassanId, label: "Instagram bio", serviceSlug: nil,
                             createdAt: Instant(now.addingTimeInterval(-30 * 86_400))),
                 BookingLink(id: UUID(), barberId: Self.hassanId, label: "VIP flyer", serviceSlug: "vip-haircut",
                             createdAt: Instant(now.addingTimeInterval(-10 * 86_400)))]
    }
}
