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
│   ├── booking-submit.js         Form submit, group flow, WhatsApp/SMS redirect, fallback path
│   ├── booking-cancel.js         Phone lookup → two-tap cancel → prefilled text to the shop
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
│   ├── export-appointments.sh    Owner tooling (see tools/README.md)
│   └── deploy-reminders.sh       Deploys the SMS reminders (see Reminders below)
├── tests/                        vitest suite (see below) + tests/ci/live-health.mjs
├── supabase/
│   ├── migrations/0001 … 0019    Schema, RLS, RPCs, hours, barbers, prices, reminders (see the history in git)
│   ├── functions/send-reminders/ Edge Function that sends the reminder texts (Deno)
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

If the booking RPC fails for any reason other than `slot_taken` (network, RLS misconfiguration, schema mismatch, pg_cron failure, anything), the client:

1. Logs the failure to `booking_errors` table for Hassan to review
2. Builds a fallback WhatsApp/SMS message with a `⚠ BOOKING SYSTEM ERROR — manual confirm needed` banner
3. Shows an amber fallback card with the details
4. Redirects to WhatsApp/SMS anyway

This means a customer is never lost to a transient backend hiccup. `slot_taken` is the one error that hard-fails (otherwise we'd cause real double-bookings).

### Reminders

The `send-reminders` Edge Function runs hourly (pg_cron calls it through pg_net) and sends texts through Twilio:

- **Day-before reminder.** Confirmed bookings starting 23 to 25 hours from now, with `remind_sms` set and `reminder_sent_at` empty. One text per phone per day; a group booked from one phone gets one text listing each person and time.
  `Fade Empire: your appointment is tomorrow, Wed Oct 21 at 10:00 AM with Hassan. 1193 Memorial Dr, Chicopee. To cancel: https://chicopeefadeempire.com/#cancel`
- **Rebook nudge.** The phone's most recent visit (confirmed or completed, already started) has `rebook_sms` set, started 21 to 42 days ago, has `rebook_sent_at` empty, and the phone has no pending or confirmed booking after it.
  `Fade Empire: it's been 3 weeks since your last cut with Hassan. Book your next one: https://chicopeefadeempire.com/#book. Reply STOP to stop.`

Quiet hours: nothing goes out from 20:00 to 09:00 shop time (America/New_York). A run in that window queries, sends and marks nothing and returns `{"dry_run": false, "skipped": "quiet hours: 21:00 in America/New_York; texts go out 09:00-20:00"}`. The schedule stays hourly because the due windows absorb the wait: the shop's slots run 10:00 to 17:15, so every reminder window falls between 09:00 and 18:15 the day before, and a rebook nudge has a 21-day window. The function secrets `QUIET_START_HOUR` and `QUIET_END_HOUR` (whole hours, 0-23) move the bounds; an invalid value falls back to 20 and 9.

Opt-in flags live on each booking row: `remind_sms` (default on) and `rebook_sms` (default off). Migration 0019 sets `remind_sms = false` on every booking that exists when it runs, because those customers never saw the checkbox; only bookings made after it can get a reminder. `book_slot` and `book_slot_group` take them as `p_remind_sms` and `p_rebook_sms`; callers that omit them get the defaults. A row is marked sent once Twilio accepts the message, and a second run sends nothing new. If Twilio rejects the number for good (21610 the customer replied STOP, 21211 invalid number, 21614 not a mobile, 21408 region not enabled on the account), the row is marked too and `sms_last_error` keeps the code and message, so that number is not retried every hour. Any other failure (5xx, 429, other 4xx, network) leaves the row unmarked and the next run retries it while the booking is still due. The JSON summary counts each kind: `sent`, `failed` (retried), `rejected` (not retried). Without the Twilio secrets the function runs dry: it logs each message and marks nothing. The due queries (`reminders_due`, `rebook_due`, `mark_reminder_sent`) are executable by `service_role` only.

Deploy (from a checkout of `main` with 0019 on it):

```bash
tools/deploy-reminders.sh --dry-run          # prints every command; runs nothing
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1413... \
CONFIRM_PROD=1 tools/deploy-reminders.sh     # db push, functions deploy, secrets set, Vault, cron.schedule
```

The cron job does not contain the service role key. The script stores it in Supabase Vault as `send-reminders-service-key` (created on the first run, updated on later runs), and the job's command reads it from `vault.decrypted_secrets` each time it runs, so neither `cron.job` nor `cron.job_run_details` holds the key. To rotate the key, re-run the script with the new one.

`TWILIO_MESSAGING_SERVICE_SID` can replace `TWILIO_FROM`; `SITE_URL` overrides the link base. Leave the `TWILIO_*` variables out to deploy in dry mode first and read the function logs in the dashboard. The script is safe to re-run.

Turn it off:

```bash
supabase db query --linked "select cron.unschedule('send-reminders');"
supabase db query --linked "delete from vault.secrets where name = 'send-reminders-service-key';"   # optional
```

To keep the schedule but stop sending, remove the Twilio secrets (`supabase secrets unset TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM`); the function goes back to dry runs.

Function tests: `deno test --no-lock supabase/functions/send-reminders/`.

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

- **`.github/workflows/ci.yml`** — on every push/PR: the vitest suite, the
  full DB suite above (fresh Postgres, all migrations, `db lint`, pgTAP), and
  the send-reminders Deno tests. The Supabase CLI (2.109.0) and Deno (2.9.7)
  versions are pinned. Make all three jobs required checks on `main` so
  nothing broken can deploy.
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
