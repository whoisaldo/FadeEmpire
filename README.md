# Fade Empire Barbershop

A static + PWA website for **Fade Empire**, a two-chair barbershop in Chicopee, Massachusetts (Hassan + Larry). Built freelance to host the shop's brand presence and a race-proof online booking flow.

Live: <https://chicopeefadeempire.com>

**Hours** — store: 10 AM–6 PM, every day (the store opens with its earliest barber). Hassan: 10–6, off Tuesdays. Larry: 10–6, every day. Bookable slots are the intersection of store hours and the barber's schedule, enforced in the DB and mirrored in the client. (Javier retired July 2026 — deactivated by migration 0013, never deleted, so his booking history keeps its barber.)

---

## What it does

- **Editorial dark-luxury landing page** — hero, barber feature spreads, asymmetric portfolio essay, typeset services menu, service comparison field guide, illustrated map + clock-dial hours
- **Per-barber booking** — pick Hassan or Larry; each barber has his own days off, opening hours, and availability grid
- **Race-proof booking** — visual day picker + slot pills, served by an atomic Supabase Postgres RPC (`book_slot`) that uses a partial unique index to make double-booking impossible at the database level
- **Group bookings** — book yourself + friends/kids in consecutive 30-minute slots, all-or-nothing transactional, duration-aware (a VIP in the party takes two slots before the next guest starts)
- **Multi-slot services** — VIP (60 min) automatically books two linked consecutive slots
- **Customer cancellation** — enter the phone you booked with, see your upcoming bookings, cancel with a two-tap confirm; the DB frees the slot instantly and the site preps a cancellation text to the shop
- **Messaging fallback** — if the DB is unreachable for any reason, the customer is still routed to WhatsApp/SMS with all the booking details, and the failure is logged to `booking_errors` for review
- **PWA** — installable on iOS / Android via Add to Home Screen; service worker caches assets and survives offline
- **Live shop status** — OPEN / CLOSING SOON / CLOSED stamp in the nav, "Next available" banner (earliest slot across both barbers) pulled from Supabase
- **Mobile-first** — sticky bottom Book-a-Chair CTA, thumb-sized tap targets, safe-area insets
- **Unit + DOM tests** — vitest suite covering schedule math, validation, message building, and the real booking form markup wired to mocked RPCs

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

No build step. No `package.json`. No `node_modules` checked in. The site as-deployed is exactly what lives in the repo.

---

## Project structure

```
FadeEmpire/
├── index.html                    Main page (single-page editorial layout)
├── 404.html                      Custom 404
├── manifest.webmanifest          PWA manifest
├── sw.js                         Service worker (network-first JS/CSS, cache-first images)
├── robots.txt                    SEO crawler rules
├── sitemap.xml                   SEO sitemap
├── CNAME                         GitHub Pages custom-domain pointer
├── .nojekyll                     Disables Jekyll on Pages so folders prefixed _ work
├── styles/
│   ├── tokens.css                CSS variables, font @imports, grain texture
│   ├── type.css                  Typography roles (display, body, mono, eyebrow)
│   ├── layout.css                Containers, section frame, hairline rules
│   ├── components.css            Buttons, nav, OPEN/CLOSED stamp, footer
│   ├── hero.css                  Hero section
│   ├── menu.css                  Typeset services menu + comparison cards
│   ├── gallery.css               Asymmetric editorial photo essay
│   ├── hassan.css                Barber feature spread
│   ├── booking-grid.css          Day chips, slot pills, form, success/error/fallback cards
│   ├── visit.css                 Illustrated map + clock-dial hours
│   ├── motion.css                Scroll-reveal animations
│   └── responsive.css            Mobile-first overrides + sticky CTA bar
├── scripts/
│   ├── main.js                   Entry point — boots all modules, registers SW
│   ├── config.js                 SUPABASE_URL / anon key / STORE_HOURS / BARBERS / prices
│   ├── supabase.js               Singleton Supabase client (loaded from esm.sh)
│   ├── booking-rpc.js            bookSlot, bookSlotGroup, cancelBooking, findBookingsByPhone…
│   ├── booking-grid.js           Barber picker + day picker + slot pills + auto-refresh
│   ├── booking-submit.js         Form submit, group flow, WhatsApp/SMS redirect, fallback path
│   ├── booking-cancel.js         Phone lookup → two-tap cancel → prefilled text to the shop
│   ├── booking-validate.js       Pure form validation + duration-aware party planning
│   ├── booking-messages.js       Booking + cancellation message builders, deep-link URLs
│   ├── booking-helpers.js        Timezone math, schedule intersection, formatting, error map
│   ├── cover.js                  Nav, OPEN/CLOSED stamp, Next-Available banner, sticky CTA
│   ├── reveals.js                IntersectionObserver scroll reveals
│   └── visit.js                  Clock-dial "now" hand + open-arc rendering
├── tests/                        vitest suite (pure logic + jsdom booking-form integration)
├── supabase/
│   └── migrations/
│       ├── 0001_init.sql               Initial schema + RLS + RPCs + pg_cron
│       ├── 0002_fix_book_slot_ambiguity.sql
│       ├── 0003_fix_availability_view.sql
│       ├── 0004_book_slot_group.sql    Group/atomic multi-person booking
│       ├── 0005_fix_addons_null_in_group.sql
│       ├── 0006_robustness.sql         VIP duration + error logging + custom_request in groups
│       ├── 0007_lock_web_bookings_and_hours.sql  Confirm-on-create (no holds)
│       ├── 0008_add_beard_addon.sql
│       ├── 0009_javier_store_hours_cancellation.sql  Javier + store_hours + cancel lookup
│       ├── 0010_lock_owner_functions.sql   Revoke owner RPCs from anon (CI catch)
│       ├── 0011_phone_normalization_and_grants.sql   NANP phone matching + explicit grants (CI catch)
│       ├── 0012_hassan_sundays.sql         Hassan works Sundays → store open 7 days
│       ├── 0013_retire_javier_add_larry.sql  Javier retired (unbookable), Larry added 10–6 daily
│       ├── 0014_store_hours_follow_barbers.sql  Store window → 10–6 daily (earliest barber)
│       └── 0015_beard_trim_price.sql       Standalone beard trim $15 (beard add-on stays +$10)
└── assets/
    ├── Haircuts/optimized/             Portfolio plates (mobile/tablet variants)
    ├── Barbers/Hassan/optimized/       Hassan profile photos
    ├── Barbers/Larry/optimized/        Larry profile photos
    ├── Barbers/Javier/optimized/       Javier profile photos (retired — kept for the record)
    └── FadeEmpireStore/                Brand assets (logo, storefront)
```

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

If the booking RPC fails for any reason other than `slot_taken` (network, RLS misconfiguration, schema mismatch, pg_cron failure, anything), the client:

1. Logs the failure to `booking_errors` table for Hassan to review
2. Builds a fallback WhatsApp/SMS message with a `⚠ BOOKING SYSTEM ERROR — manual confirm needed` banner
3. Shows an amber fallback card with the details
4. Redirects to WhatsApp/SMS anyway

This means a customer is never lost to a transient backend hiccup. `slot_taken` is the one error that hard-fails (otherwise we'd cause real double-bookings).

---

## Local development

```bash
cd FadeEmpire
python3 -m http.server 8000
open http://localhost:8000
```

That's it. Open the site, edit any file, refresh.

### Tests

The booking logic (schedule intersection, validation, party planning, message
building) and the booking form itself (real `#book` markup + real modules, RPC
layer mocked) are covered by a vitest suite:

```bash
npm install        # one-time; installs vitest + jsdom only (never deployed)
npm test           # run the whole suite
npm run test:watch # watch mode while developing
```

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

The Service Worker is `network-first` for same-origin JS/CSS, so deploys propagate immediately without manual cache clears.

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
