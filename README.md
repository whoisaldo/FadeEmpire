# Fade Empire Barbershop

A static + PWA website for **Fade Empire**, a two-chair barbershop in Chicopee, Massachusetts (Hassan + Larry). Built freelance to host the shop's brand presence and a race-proof online booking flow.

Live: <https://chicopeefadeempire.com>

**Hours** — store: 10 AM–6 PM, six days a week, **closed Tuesdays** (since September 2026, migration 0017). Hassan and Larry both work 10–6 every open day. Walk-ins are welcome. Appointments run every 45 minutes from open; the last one starts at 5:30 PM and can run to 6:15 — the barber stays past close to finish. Bookable slots are the intersection of store hours and the barber's schedule, enforced in the DB and mirrored in the client. (Javier retired July 2026 — deactivated by migration 0013, never deleted, so his booking history keeps its barber.)

---

## What it does

- **Landing page** built around the shop's own photos and the professionally edited tour video: hero, "inside the shop" (video with a sound toggle, off by default), the price list and a "which one do I book?" comparison, a fifteen-plate gallery with a lightbox, the two barbers, booking, and the storefront with live hours.
- **Per-barber booking** — pick Hassan or Larry; each barber has his own days off, opening hours, and availability grid
- **Race-proof booking** — visual day picker + slot pills, served by an atomic Supabase Postgres RPC (`book_slot`) that uses a partial unique index to make double-booking impossible at the database level
- **Group bookings** — book yourself + friends/kids in consecutive 45-minute slots, all-or-nothing transactional, duration-aware (a service longer than one slot pushes the next guest back before they start)
- **Multi-slot services** — any service longer than the 45-minute grid books linked consecutive slots automatically. No current service needs it: the VIP is 45 minutes (migration 0018), so every service fits one slot — the machinery stays for the day one doesn't
- **Customer cancellation** — enter the phone you booked with, see your upcoming bookings, cancel with a two-tap confirm; the DB frees the slot instantly and the site preps a cancellation text to the shop
- **Text consent** — two boxes in your details: a reminder the day before (on by default) and a text when the next cut is due, about every 3 weeks (off). Sent with the booking as `p_remind_sms` / `p_rebook_sms` (migration 0019)
- **Returning customer** — after a booking, the customer's own choices (name, phone, barber, service, add-ons, the text boxes; never guests) stay in `localStorage` under `fe.lastBooking`. The next visit opens with "Welcome back" and the form filled in, the cancel panel has the phone, and the sticky bar reads "Rebook · Hassan". "Not you? Clear" forgets it
- **Messaging fallback** — if the DB is unreachable for any reason, the customer is still routed to WhatsApp/SMS with all the booking details, and the failure is logged to `booking_errors` for review
- **PWA** — installable on iOS / Android via Add to Home Screen; service worker caches assets and survives offline
- **Live shop status** — OPEN / CLOSING SOON / CLOSED in the nav, "Open now · Closes 6 PM" in the hero and the hours card (today's row highlighted), "Next open slot" (earliest slot across both barbers) pulled from Supabase
- **Mobile-first** — sticky bottom Book-a-Chair CTA, swipe filmstrip gallery, thumb-sized tap targets, safe-area insets, lazy video that only downloads once it scrolls into view
- **Tests** — 140+ vitest cases: schedule math, validation, message building, the live status line across DST, the real booking form driven under jsdom with mocked RPCs, the video/lightbox/hours modules, and drift guards that read `index.html` and fail if a price, hour, or asset path disagrees with `config.js` or the disk

---

## Tech stack

| Layer | Technology |
|---|---|
| Markup | Plain HTML5, no framework |
| Styling | Hand-written CSS, modular per-section, no preprocessor |
| Behavior | Vanilla ES modules (loaded directly, no bundler) |
| Data layer | Supabase (Postgres + REST + RPC). Anon key is public, security enforced by RLS + SECURITY DEFINER RPCs |
| Booking notifications | WhatsApp Business + SMS deep-links (Hassan confirms manually) |
| Hosting | GitHub Pages (custom domain `chicopeefadeempire.com`) |
| PWA | Service Worker (`sw.js`) + Web App Manifest |
| Fonts | Fraunces (display), General Sans via Fontshare (body), JetBrains Mono (numerals) |
| Images / video | Pillow + ffmpeg scripts in `tools/` generate every size the page serves; the outputs are committed |

No build step at deploy time: `package.json` exists only for the test tooling, `node_modules` is never checked in, and the site as-deployed is exactly what lives in the repo.

---

## Project structure

```
FadeEmpire/
├── index.html                    The page (single-page layout)
├── 404.html                      Custom 404
├── manifest.webmanifest          PWA manifest (icons in assets/brand/)
├── sw.js                         Service worker (network-first JS/CSS, cache-first images, video bypassed)
├── robots.txt · sitemap.xml      SEO
├── CNAME · .nojekyll             GitHub Pages
├── styles/
│   ├── tokens.css                CSS variables, grain texture, base reset
│   ├── type.css                  Typography roles (display, body, mono, eyebrow)
│   ├── layout.css                Containers, section frame, skip link
│   ├── components.css            Buttons, nav + mobile menu, OPEN/CLOSED stamp, footer
│   ├── hero.css                  Hero cover + page-load sequence
│   ├── shop.css                  "Inside the shop": tour video, room photo, LED-grid motif
│   ├── menu.css                  Price list, VIP card, add-ons, comparison (cards on phone, table on desktop)
│   ├── gallery.css               12-column editorial grid + lightbox
│   ├── barbers.css               The two chair spreads
│   ├── booking-grid.css          Day chips, slot pills, form, success/error/fallback cards, cancel panel
│   ├── visit.css                 Storefront, hours card, contact
│   ├── motion.css                Scroll reveals + reduced-motion fallbacks
│   └── responsive.css            The phone layer (≤600px), tablet tweaks, sticky CTA bar, print
├── scripts/
│   ├── main.js                   Entry point: boots every module, registers the SW
│   ├── config.js                 SUPABASE_URL / anon key / STORE_HOURS / BARBERS / prices
│   ├── supabase.js               Singleton Supabase client (loaded from esm.sh)
│   ├── booking-rpc.js            bookSlot, bookSlotGroup, cancelBooking, findBookingsByPhone, fetchNextAvailable
│   ├── booking-grid.js           Barber picker + day picker + slot pills + auto-refresh
│   ├── booking-submit.js         Form submit, group flow, the result cards and their WhatsApp/text links, fallback path
│   ├── booking-cancel.js         Phone lookup → two-tap cancel → prefilled text to the shop
│   ├── booking-return.js         The remembered customer: saved choices, the rebook card, Clear
│   ├── booking-validate.js       Pure form validation + duration-aware party planning
│   ├── booking-messages.js       Booking + cancellation message builders, deep-link URLs
│   ├── booking-helpers.js        Timezone math, schedule intersection, shopStatus(), formatting, error map
│   ├── cover.js                  Nav stamp, hero status, next-open-slot lines, sticky CTA, mobile menu
│   ├── shop-video.js             Lazy, muted, visibility-paused video + the sound toggle
│   ├── gallery.js                Lightbox (keys, swipe, focus return) + filmstrip counter
│   ├── visit.js                  Today's row + live status in the hours card
│   └── reveals.js                IntersectionObserver scroll reveals
├── tools/
│   ├── build-assets.py           Source photos → assets/img/*-{480..2000}.{jpg,webp} + assets/brand/ (icons, social card)
│   ├── build-video.sh            Source clips → assets/video/*.mp4 + poster frames
│   ├── screenshot.py             Playwright captures at phone/tablet/desktop sizes + overflow check
│   └── export-appointments.sh    Owner tooling (see tools/README.md)
├── tests/                        vitest suite (see below) + tests/ci/live-health.mjs
├── supabase/
│   ├── migrations/0001 … 0018    Schema, RLS, RPCs, hours, barbers, prices (see the history in git)
│   └── tests/                    pgTAP suites
└── assets/
    ├── img/                      Everything the page serves (generated, committed)
    ├── video/                    shop-tour-540.mp4, shop-tour-720.mp4, mirror-check.mp4 (generated, committed)
    ├── brand/                    Logo cut-outs, PWA icons, apple-touch-icon, og-cover.jpg (generated, committed)
    ├── Haircuts/                 Source photos + the mirror-check source clip
    ├── FadeEmpireStore/          Logo, storefront, interior sources
    └── Barbers/                  Hassan, Larry (Javier retired; kept for the record)
```

### Images and video

Sources stay in `assets/Haircuts`, `assets/FadeEmpireStore`, `assets/Barbers`. Everything the page actually loads is generated:

```bash
pip3 install pillow                 # once
python3 tools/build-assets.py       # every photo at 480/800/1200(/1600/2000) px, JPG + WebP, EXIF baked in
python3 tools/build-assets.py hero-cut brand   # just one stem, or just the brand files

brew install ffmpeg                 # once
TOUR_SRC=~/Desktop/newFadeEmpireAssets/FadeEmpireOfficialVideo.MP4 tools/build-video.sh
```

The tour master (15 MB) is not in the repo; point `TOUR_SRC` at it when re-encoding. Add a photo by dropping the source in place, adding a line to `SOURCES` in `tools/build-assets.py`, running it, and writing the `<picture>` block. `tests/site-content.test.js` fails if the page references a file that was not generated.

---

## Booking architecture (the interesting part)

### The race-proof guarantee

Two customers can hit "Reserve" for the exact same slot within microseconds of each other. The DB only ever inserts one booking row, the other gets `slot_taken`. This isn't done with optimistic UI checks or pessimistic locks — it's a **partial unique index**:

```sql
create unique index bookings_active_slot_uidx
  on bookings (barber_id, booking_date, booking_time)
  where status in ('pending','confirmed','completed');
```

Cancelled / expired / no-show rows don't occupy the index, so a freed slot is immediately available again. The `book_slot` RPC wraps the INSERT in a `BEGIN…EXCEPTION when unique_violation` and re-raises `slot_taken` with a user-facing error code.

### What anon CAN do

- `SELECT` `barbers`, `services`, `addons`, `barber_schedules`, `barber_closures`, `store_hours` (public marketing data only)
- `SELECT` `v_slot_availability` view (exposes only barber/date/time/status — **no PII**)
- `EXECUTE` `book_slot`, `book_slot_group`, `cancel_booking`, `find_bookings_by_phone`, `log_booking_error`

`find_bookings_by_phone` uses the phone number as cheap auth (the same trust model as `cancel_booking`): it returns only that phone's own upcoming bookings, first-name only, primaries only.

### What anon CANNOT do

- `SELECT` / `INSERT` / `UPDATE` / `DELETE` on `bookings` directly (RLS denies all)
- `SELECT` on `booking_errors` (Hassan-only via Supabase Studio)
- `EXECUTE` `confirm_booking` (authenticated only)

### Messaging fallback

If the booking RPC can't be reached or fails with an error the client can't name (network, RLS misconfiguration, anything unmapped), the client:

1. Logs the failure to `booking_errors` table for Hassan to review
2. Builds a fallback WhatsApp/SMS message with a `⚠ BOOKING SYSTEM ERROR — manual confirm needed` banner
3. Shows an amber card saying the time isn't reserved yet
4. Offers the request to the barber through the same WhatsApp/text links as a successful booking

This means a customer is never lost to a transient backend hiccup. Known answers from the DB (`slot_taken`, `invalid_phone`, `too_many_active_bookings`, `service_not_found`, and the rest of `ERROR_MESSAGES`) are shown inline with their next step instead: pick another time, fix the field, or cancel a booking. `slot_taken` in particular must never fall back, or the shop would get a real double booking.

---

## Local development

```bash
cd FadeEmpire
python3 -m http.server 8000
open http://localhost:8000
```

That's it. Open the site, edit any file, refresh. Phone first: check the ≤600px layout before desktop.

```bash
pip3 install playwright && python3 -m playwright install chromium   # once
python3 tools/screenshot.py mobile /tmp/m.png            # full page at 390px, prints console errors + overflow
python3 tools/screenshot.py desktop /tmp/d.png "#book"   # one section at 1440px
```

### Tests

```bash
npm install        # one-time; installs vitest + jsdom only (never deployed)
npm test           # run the whole suite
npm run test:watch # watch mode while developing
```

| File | What it covers |
|---|---|
| `booking-helpers.test.js` | Time math, per-barber schedules, store-hours intersection, pricing, phone helpers, RPC error mapping |
| `shop-status.test.js` | `shopStatus()` open / closing soon / closed with the next opening (skips the closed Tuesday), boundaries at open and close, the shop clock across both DST switches |
| `booking-validate.test.js` | Duration-aware party planning and pure form validation |
| `booking-messages.test.js` | The WhatsApp/SMS texts and deep links |
| `booking-form.dom.test.js` | The real `#book` markup with the real modules and a mocked RPC layer: grid, barber switching, success, group, slot_taken hard-fail, fallback, cancellation, and the edge cases (closed-day tags, next-slot pick, last slot of the day, guest cap, custom requests, double-tap, midnight rollover, the five-minute refresh) |
| `page-modules.dom.test.js` | cover.js (stamp, hero status, next-slot lines, phone-only compare collapse), visit.js (today's row, status, midnight), shop-video.js (lazy file choice, muted default, sound toggle, reduced motion), gallery.js (lightbox, keys, swipe, focus return, filmstrip counter) |
| `site-content.test.js` | Drift guards on `index.html`: every price in the menu / form / guest rows / JSON-LD matches `config.js`, the hours card and structured data match `STORE_HOURS`, the barbers match `BARBERS`, every referenced asset exists on disk, every image has alt + dimensions, videos are muted/inline/lazy |

### Database tests (pgTAP)

`supabase/tests/*.sql` is a pgTAP suite that runs against a REAL local Postgres
(the same `supabase/postgres` image the hosted project uses) with all
migrations applied from scratch: schema + seeds + hours, the booking RPC
(store/barber hours enforcement, double-booking races, VIP multi-slot,
server-side pricing, rate limits), group bookings, the cancellation flow, and
the anon security model (RLS + function grants). Needs Docker:

```bash
npm run test:db    # supabase db start && supabase test db
```

### CI (GitHub Actions)

- **`.github/workflows/ci.yml`** — on every push/PR: the vitest suite and the
  full DB suite above (fresh Postgres, all migrations, `db lint`, pgTAP).
  Make both jobs required checks on `main` so nothing broken can deploy.
- **`.github/workflows/live-health.yml`** — daily at 7 am ET, after every push
  to `main`, and on demand: read-only end-to-end checks against the LIVE site
  and database using only the public anon key. Verifies the deploy is current,
  prices/hours/barbers in Supabase still match the `config.js` mirrors, the
  booking + cancellation RPCs are live and validating, and the security
  posture holds (no PII readable by anon, owner RPCs not executable). Run it
  locally anytime with `npm run health`.

The Service Worker is `network-first` for same-origin JS/CSS, so deploys propagate immediately without manual cache clears. Bump `VERSION` in `sw.js` and the `?v=` query on the stylesheet/script tags in `index.html` with every release so installed PWAs refresh.

### Editing the database

The Supabase project is referenced from `scripts/config.js` (anon key is public — security is at the DB layer, not the key). To apply migrations:

```bash
supabase login                                    # one-time
supabase link --project-ref mjehfaonibgobimfiijk  # one-time
supabase db push --linked --yes                   # pushes any unpushed migrations
```

To inspect failed booking attempts:

```sql
select * from booking_errors order by occurred_at desc limit 50;
```

---

## Developer

Ali Younes — `whois.younes@gmail.com`

© 2026 Fade Empire. All rights reserved.
