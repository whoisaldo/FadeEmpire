# Fade Empire Barbershop

A static + PWA website for **Fade Empire**, a one-chair master barbershop in Chicopee, Massachusetts. Built freelance to host the shop's brand presence and a race-proof online booking flow.

Live: <https://chicopeefadeempire.com>

---

## What it does

- **Editorial dark-luxury landing page** — hero, master barber feature spread, asymmetric portfolio essay, typeset services menu, service comparison field guide, illustrated map + clock-dial hours
- **Race-proof booking** — visual day picker + slot pills, served by an atomic Supabase Postgres RPC (`book_slot`) that uses a partial unique index to make double-booking impossible at the database level
- **Group bookings** — book yourself + friends/kids in consecutive 30-minute slots, all-or-nothing transactional
- **Multi-slot services** — VIP (60 min) automatically books two linked consecutive slots
- **Messaging fallback** — if the DB is unreachable for any reason, the customer is still routed to WhatsApp/SMS with all the booking details, and the failure is logged to `booking_errors` for review
- **PWA** — installable on iOS / Android via Add to Home Screen; service worker caches assets and survives offline
- **Live shop status** — OPEN / CLOSING SOON / CLOSED stamp in the nav, "Next available" banner pulled from Supabase
- **Mobile-first** — sticky bottom Book-a-Chair CTA, thumb-sized tap targets, safe-area insets

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
│   ├── config.js                 SUPABASE_URL / anon key / shop schedule / service prices
│   ├── supabase.js               Singleton Supabase client (loaded from esm.sh)
│   ├── booking-rpc.js            bookSlot, bookSlotGroup, logBookingError, fetchAvailability
│   ├── booking-grid.js           Day picker + slot pills + visibility/midnight auto-refresh
│   ├── booking-submit.js         Form submit, group flow, WhatsApp/SMS redirect, fallback path
│   ├── booking-helpers.js        Timezone math, formatting, error-code mapping
│   ├── cover.js                  Nav, OPEN/CLOSED stamp, Next-Available banner, sticky CTA
│   ├── reveals.js                IntersectionObserver scroll reveals
│   └── visit.js                  Clock-dial "now" hand + open-arc rendering
├── supabase/
│   └── migrations/
│       ├── 0001_init.sql               Initial schema + RLS + RPCs + pg_cron
│       ├── 0002_fix_book_slot_ambiguity.sql
│       ├── 0003_fix_availability_view.sql
│       ├── 0004_book_slot_group.sql    Group/atomic multi-person booking
│       ├── 0005_fix_addons_null_in_group.sql
│       └── 0006_robustness.sql         VIP duration + error logging + custom_request in groups
└── assets/
    ├── Haircuts/optimized/             Portfolio plates (mobile/tablet variants)
    ├── Barbers/Hassan/optimized/       Barber profile photos
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

- `SELECT` `barbers`, `services`, `addons`, `barber_schedules`, `barber_closures` (public marketing data only)
- `SELECT` `v_slot_availability` view (exposes only date/time/status — **no PII**)
- `EXECUTE` `book_slot`, `book_slot_group`, `cancel_booking`, `log_booking_error`

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
