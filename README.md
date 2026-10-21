# Fade Empire Barbershop

A static + PWA website for **Fade Empire**, a two-chair barbershop in Chicopee, Massachusetts (Hassan + Larry). Built freelance to host the shop's brand presence and a race-proof online booking flow.

Live: <https://chicopeefadeempire.com>

**Hours** — store: 10 AM–6 PM, six days a week, **closed Tuesdays** (since September 2026, migration 0017). Hassan and Larry both work 10–6 every open day. Walk-ins are welcome. Appointments run every 45 minutes from open; the last one starts at 5:30 PM and can run to 6:15 — the barber stays past close to finish. Bookable slots are the intersection of store hours and the barber's schedule, enforced in the DB and mirrored in the client. (Javier retired July 2026 — deactivated by migration 0013, never deleted, so his booking history keeps its barber.)

---

## What it does

- **Landing page** built around the shop's own photos and the professionally edited tour video: hero, "inside the shop" (video with a sound toggle, off by default), the price list and a "which one do I book?" comparison, a fifteen-plate gallery with a lightbox, the two barbers, booking, and the storefront with live hours.
- **Per-barber booking** — pick a barber; each has their own weekly hours, days off, and availability grid. The barbers come from the database (`barbers` + `barber_schedules` + upcoming `barber_closures`), so one the manager adds in the barber app shows up without a deploy and a deactivated one disappears; `config.js`'s Hassan and Larry are the fallback when the read fails or takes over 2.5 s (it is taken when it lands, and re-checks the day and time already picked). A read that finds no bookable barber means nobody is offered online: the booking section gives the shop's phone instead. A slot is taken when any booking on that chair overlaps it, so a booking left off a barber's new hours still blocks it
- **Booking links** — barbers share `chicopeefadeempire.com/<slug>` and `/?barber=<slug>&service=<service-slug>#book` from the app. The query picks the barber and the service and lands on the form; `404.html` forwards `/<slug>` (and `/<slug>/`) to it when the slug is an active barber and shows the normal 404 otherwise. Unknown or inactive values change nothing
- **Race-proof booking** — visual day picker + slot pills, served by an atomic Supabase Postgres RPC (`book_slot`) that uses a partial unique index to make double-booking impossible at the database level
- **The price list books itself** — each service row is a button ("Book Hair Cut, $30") that picks that service in the form and moves to the next step still to do; each add-on row ("Add Hot Towel, +$5") ticks or unticks its box the same way
- **Group bookings** — book yourself + friends/kids in consecutive 45-minute slots, all-or-nothing transactional, duration-aware (a service longer than one slot pushes the next guest back before they start)
- **Multi-slot services** — any service longer than the 45-minute grid books linked consecutive slots automatically. No current service needs it: the VIP is 45 minutes (migration 0018), so every service fits one slot — the machinery stays for the day one doesn't
- **Customer cancellation** — enter the phone you booked with, see your upcoming bookings, cancel with a two-tap confirm; the DB frees the slot instantly and the site preps a cancellation text to the shop
- **Move a booking** — "Move it" next to Cancel, the same two taps ("Yes, move Wed 10:00 AM"): the booking is cancelled, the form takes its barber, service and add-ons, under the guest's own name when it is someone else's booking (and opens again if a confirmation was showing, the card kept as the record), and focus goes to the day row for a new time: the booking's own day if it still has an open time, otherwise the next
- **Text consent** — two boxes in your details: a reminder the day before (on by default) and a text when the next cut is due, about every 3 weeks (off). Sent with the booking as `p_remind_sms` / `p_rebook_sms` (migration 0020)
- **Returning customer** — after a booking, the customer's own choices (name, phone, barber, service, add-ons, the text boxes; never guests, nor a guest's booking moved to a new time) stay in `localStorage` under `fe.lastBooking`. The next visit opens with "Welcome back" and the form filled in, the cancel panel has the phone, and the sticky bar reads "Rebook · Hassan". "Not you? Clear" forgets it
- **Add to calendar** — the confirmation offers `fade-empire-<date>.ics`: one event per booking (a group spans the first start to the last end), in UTC from the shop's clock, with the address, the shop phone and the cancel link
- **Messaging fallback** — if the DB is unreachable for any reason, the customer is still routed to WhatsApp/SMS with all the booking details, and the failure is logged to `booking_errors` for review
- **PWA** — installable on iOS / Android via Add to Home Screen; service worker caches assets and survives offline
- **Live shop status** — OPEN / CLOSING SOON / CLOSED in the nav, "Open now · Closes 6 PM" in the hero and the hours card (today's row highlighted), "Next open slot" (earliest slot across every barber) pulled from Supabase
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
├── 404.html                      Custom 404; forwards /<barber-slug> to the booking form
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
│   ├── barbers.css               The chair spreads (two built by hand, plain ones for barbers added in the app)
│   ├── booking-grid.css          Day chips, slot pills, form, success/error/fallback cards, cancel panel
│   ├── visit.css                 Storefront, hours card, contact
│   ├── motion.css                Scroll reveals + reduced-motion fallbacks
│   └── responsive.css            The phone layer (≤600px), tablet tweaks, sticky CTA bar, print
├── scripts/
│   ├── main.js                   Entry point: boots every module, registers the SW
│   ├── config.js                 SUPABASE_URL / anon key / STORE_HOURS / BARBERS (the fallback) / prices
│   ├── roster.js                 The barbers on offer: config.js's until the database's are read
│   ├── supabase.js               Singleton Supabase client (postgrest-js, vendored in scripts/vendor/)
│   ├── booking-rpc.js            bookSlot, bookSlotGroup, cancelBooking, findBookingsByPhone, fetchNextAvailable, fetchBarbers
│   ├── booking-grid.js           Reads the barbers; barber picker + day picker + slot pills + auto-refresh
│   ├── booking-link.js           ?barber=&service= from a barber's link
│   ├── booking-submit.js         Form submit, group flow, the result cards and their WhatsApp/text links, fallback path
│   ├── booking-cancel.js         Phone lookup → two-tap cancel → prefilled text to the shop
│   ├── booking-return.js         The remembered customer: saved choices, the rebook card, Clear
│   ├── booking-validate.js       Pure form validation + duration-aware party planning
│   ├── booking-messages.js       Booking + cancellation message builders, deep-link URLs
│   ├── booking-calendar.js       The .ics for "Add to calendar"
│   ├── booking-helpers.js        Timezone math, schedule intersection, shopStatus(), formatting, error map
│   ├── barbers-section.js        The barbers section follows the database: hides, appends, renames the heading
│   ├── pretty-link.js            404.html's /<slug> lookup (one anon REST read)
│   ├── nav.js                    Mobile menu (loads without the database client)
│   ├── page.js                   Nav stamp, hero status, sticky nav, compare collapse, footer year, #fragment landing (no database)
│   ├── cover.js                  Next-open-slot lines, sticky CTA
│   ├── shop-video.js             Lazy, muted, visibility-paused video + the sound toggle
│   ├── gallery.js                Lightbox (keys, swipe, focus return)
│   ├── visit.js                  Today's row + live status in the hours card
│   └── reveals.js                IntersectionObserver scroll reveals
├── tools/
│   ├── build-assets.py           Source photos → assets/img/*-{480..2000}.{jpg,webp} + assets/brand/ (icons, social card)
│   ├── build-video.sh            Source clips → assets/video/*.mp4 + poster frames
│   ├── screenshot.py             Playwright captures at phone/tablet/desktop sizes + overflow check
│   ├── serve-pages.py            Local server that answers like GitHub Pages (404.html, status 404)
│   ├── preview-local.sh          The site against the local stack, on :8021 over the tailnet
│   ├── export-appointments.sh    Owner tooling (see tools/README.md)
│   ├── deploy-reminders.sh       Deploys the SMS reminders (see Reminders below)
│   ├── deploy-barber-app.sh      Deploys the barber app backend (see Barber app backend below)
│   ├── local-stack.sh            Local Supabase stack for the barber app (own Colima VM)
│   ├── local-stack-check.py      Its staff-admin login flow check (local-stack.sh check)
│   ├── service-role-check.sql    The privileges the Edge Functions need as service_role (CI, check, deploy)
│   ├── booking-lock-check.sh     Two-session check of the booking overlap lock on the local stack
│   └── local-stack-seed.sql      Its sample logins and week of bookings
├── tests/                        vitest suite (see below) + tests/ci/live-health.mjs
├── supabase/
│   ├── migrations/
│   │   ├── 0001_init.sql               Initial schema + RLS + RPCs + pg_cron
│   │   ├── 0002_fix_book_slot_ambiguity.sql
│   │   ├── 0003_fix_availability_view.sql
│   │   ├── 0004_book_slot_group.sql    Group/atomic multi-person booking
│   │   ├── 0005_fix_addons_null_in_group.sql
│   │   ├── 0006_robustness.sql         VIP duration + error logging + custom_request in groups
│   │   ├── 0007_lock_web_bookings_and_hours.sql  Confirm-on-create (no holds)
│   │   ├── 0008_add_beard_addon.sql
│   │   ├── 0009_javier_store_hours_cancellation.sql  Javier + store_hours + cancel lookup
│   │   ├── 0010_lock_owner_functions.sql   Revoke owner RPCs from anon (CI catch)
│   │   ├── 0011_phone_normalization_and_grants.sql   NANP phone matching + explicit grants (CI catch)
│   │   ├── 0012_hassan_sundays.sql         Hassan works Sundays → store open 7 days
│   │   ├── 0013_retire_javier_add_larry.sql  Javier retired (unbookable), Larry added 10–6 daily
│   │   ├── 0014_store_hours_follow_barbers.sql  Store window → 10–6 daily (earliest barber)
│   │   ├── 0015_beard_trim_price.sql       Standalone beard trim $15 (beard add-on stayed +$10 until 0021)
│   │   ├── 0016_45_minute_slots.sql        Appointments every 45 minutes (grid-aware RPCs)
│   │   ├── 0017_closed_tuesdays.sql        Shop closed Tuesdays (store_hours + Larry's schedule)
│   │   ├── 0018_vip_45_minutes.sql         VIP is 45 minutes — one slot like everything else
│   │   ├── 0019_people_tracking.sql        Party, guest and per-person columns + owner-only v_people view
│   │   ├── 0020_sms_reminders.sql          SMS consent columns + reminder/rebook queries for send-reminders
│   │   ├── 0021_beard_addon_15.sql         Beard add-on $10 → $15
│   │   └── 0022_barber_app.sql             Barber app: logins, view grants, booking events, app + manager RPCs
│   ├── functions/send-reminders/ Edge Function that sends the reminder texts (Deno)
│   ├── functions/staff-admin/    Edge Function: the manager creates, resets, disables app logins
│   ├── functions/notify-booking-event/  Edge Function: APNs pushes for booking events
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
python3 tools/build-assets.py       # every photo at 480/800/1200(/1600/2000) px (plus 160 px face crops of the barbers for the booking buttons), JPG + WebP, EXIF baked in
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
- `SELECT` on `v_people` (one row per person who has booked; service role / Studio only)
- `EXECUTE` `confirm_booking` (service_role only; signed-in app users cannot either, since 0022)

### Messaging fallback

If the booking RPC can't be reached or fails with an error the client can't name (network, RLS misconfiguration, anything unmapped), the client:

1. Logs the failure to `booking_errors` table for Hassan to review
2. Builds a fallback WhatsApp/SMS message with a `⚠ BOOKING SYSTEM ERROR — manual confirm needed` banner
3. Shows an amber card saying the time isn't reserved yet
4. Offers the request to the barber through the same WhatsApp/text links as a successful booking

This means a customer is never lost to a transient backend hiccup. Known answers from the DB (`slot_taken`, `invalid_phone`, `too_many_active_bookings`, `service_not_found`, and the rest of `ERROR_MESSAGES`) are shown inline with their next step instead: pick another time, fix the field, or cancel a booking. `slot_taken` in particular must never fall back, or the shop would get a real double booking.

### Reminders

The `send-reminders` Edge Function runs hourly. pg_cron calls it through pg_net, and it sends texts through Twilio.

#### What is sent

- **Day-before reminder.** Confirmed bookings starting 23 to 25 hours from now, with `remind_sms` on and `reminder_sent_at` empty. One text per phone per day: a group booked from one phone gets one text listing each person and time.
  `Fade Empire: your appointment is tomorrow, Wed Oct 21 at 10:00 AM with Hassan. 1193 Memorial Dr, Chicopee. To cancel: https://chicopeefadeempire.com/#cancel`
- **Rebook nudge.** The phone's most recent visit (confirmed or completed, already started) has `rebook_sms` on and `rebook_sent_at` empty, started 21 to 42 days ago, and the phone has no pending or confirmed booking after it.
  `Fade Empire: it's been 3 weeks since your last cut with Hassan. Book your next one: https://chicopeefadeempire.com/#book. Reply STOP to stop.`

Each text is sent once. Before a send the function claims the rows (`claim_reminders`), which re-checks that the booking is still confirmed (or completed, for a rebook) and still opted in, so two overlapping runs cannot text the same booking and a booking cancelled in the meantime is not texted. A row is marked sent once Twilio accepts the message. Without the Twilio secrets the function runs dry: it logs each message and marks nothing.

`reminders_due`, `rebook_due`, `claim_reminders` and `mark_reminder_sent` are executable by `service_role` only. Claiming and marking do not change `bookings.updated_at`.

#### Consent

Each booking row has two flags: `remind_sms` (default on) and `rebook_sms` (default off). `book_slot` and `book_slot_group` take them as `p_remind_sms` and `p_rebook_sms`; a caller that omits them gets the defaults.

Bookings that exist when migration 0020 runs start with `remind_sms` off, because they predate the consent checkbox the booking form is gaining in this release. Bookings made after it take the column default (on).

#### Quiet hours

Nothing goes out from 20:00 to 09:00 shop time (America/New_York). A run in that window does nothing and returns `{"dry_run": false, "skipped": "quiet hours: 21:00 in America/New_York; texts go out 09:00-20:00"}`. The schedule stays hourly: slots run 10:00 to 17:15, so every reminder window falls between 09:00 and 18:15 the day before, and a rebook nudge has a 21-day window. The function secrets `QUIET_START_HOUR` and `QUIET_END_HOUR` (whole hours, 0-23) move the bounds; an invalid value falls back to 20 and 9.

#### Deploy

From a checkout of `main` with 0020 on it, in a terminal:

```bash
tools/deploy-reminders.sh --dry-run          # prints every command; writes nothing
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1413... \
CONFIRM_PROD=1 tools/deploy-reminders.sh     # migration list, db push, functions deploy, secrets set, Vault, cron.schedule
```

- **Two confirmations.** `CONFIRM_PROD=1` lets the script run at all. The script then prints `supabase migration list --linked` (pending migrations have an empty Remote column) and runs `supabase db push` without `--yes`, so the CLI lists the pending migrations again and asks; answer `n` to stop. The CLI takes its default (yes) when stdin is not a terminal, so the script refuses a real run without one.
- **Variables.** `tools/.env.local` is read first; a variable already set in the environment wins over the file. `CONFIRM_PROD` counts only from the environment. `TWILIO_MESSAGING_SERVICE_SID` can replace `TWILIO_FROM`; `SITE_URL` overrides the link base.
- **Service role key.** It must be the legacy service_role JWT (three dot-separated parts, `eyJ...`); other formats are rejected. The script stores it in Supabase Vault as `send-reminders-service-key` (created on the first run, updated after), and the cron job reads it from `vault.decrypted_secrets` when it runs, so `cron.job` and `cron.job_run_details` never hold it. Re-run the script to rotate it.
- **Twilio secrets.** They reach `supabase secrets set` through a mode-600 temp file (`--env-file`) that is deleted afterwards. On a first deploy, leaving the `TWILIO_*` variables out deploys in dry mode. On a re-run, leaving them out keeps the secrets already set; the script runs `supabase secrets list` and says whether they exist (texts go out) or not (dry).
- **Dry run.** When the checkout is already linked, the dry run also runs the two read-only listings (`migration list`, `secrets list`). Nothing else is executed.

The script is safe to re-run.

#### Turn off

```bash
supabase db query --linked "select cron.unschedule('send-reminders');"
supabase db query --linked "delete from vault.secrets where name = 'send-reminders-service-key';"   # optional
```

To keep the schedule but stop sending, remove the Twilio secrets (`supabase secrets unset TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM`); the function goes back to dry runs.

#### Troubleshooting

- **Run summary.** Each run returns and logs JSON counts per kind: `sent`, `failed` (retried next run), `rejected` (not retried), `skipped` (claimed by another run). Read it in the dashboard under Edge Functions -> send-reminders -> Logs.
- **Cron history.** `supabase db query --linked "select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'send-reminders') order by start_time desc limit 5;"`
- **Permanent rejections.** Twilio errors 21610 (the customer replied STOP), 21211 (invalid number), 21614 (not a mobile) and 21408 (region not enabled) mark the row and keep the code and message in `bookings.sms_last_error`, so the number is not retried.
- **Other failures** (5xx, 429, other 4xx, network) leave the row unmarked; its claim holds for 10 minutes and the next hourly run retries it while the booking is still due.
- **Sent but not marked.** If Twilio accepts a message but the mark fails, the function logs an error with the booking ids. Mark them by hand, or they are texted again once the claim expires: `select mark_reminder_sent(array['<id>']::uuid[], 'reminder');`
- **Tests.** `deno test --no-lock supabase/functions/send-reminders/` for the function; `supabase/tests/006_reminders.sql` for the queries.

### Barber app backend

The database API, access rules and Edge Functions behind the iOS barber app (`docs/barber-app/CONTRACT.md` is the full contract). Migration 0022 adds:

- **Logins and access.** `staff` (one row per app login: `manager` or `barber`, keyed by `auth.users`), `barber_view_grants` (Hassan views Larry's chair read-only), and `barbers.title`. A barber sees their own chair plus granted chairs; the manager sees and changes everything. A deactivated barber, or a login the manager disabled, sees nothing at once. The app reads `bookings` through RLS (`app_can_view`) and changes them only through RPCs: `app_*` for barbers, `manager_*` for the manager. anon can execute none of them.
- **Bookings from the app.** `app_book` and `book_slot` share one body (`book_slot_at`), so the store hours, barber schedule, closures, 45-minute grid, `slot_taken` race safety and server-side prices are the same. Staff skip the anon per-phone limit, and app bookings get no SMS reminder (no consent box). `app_free_slots` uses the site's slot rule, so every slot it lists books.
- **Activity and pushes.** Triggers on `bookings` write `booking_events` (`booked`, `cancelled`, `no_show`, and `moved` for a rebooking within 30 minutes of the same customer's own cancellation, which is what the site's "Move it" does). A trigger on `booking_events` posts each event to the `notify-booking-event` function through pg_net, with the URL and key in Vault; without those secrets it does nothing. The function sends APNs alerts by each login's settings, and runs dry (logs, sends nothing) without the `APNS_*` secrets.
- **Logins.** The `staff-admin` function (manager JWT only) creates logins with a temporary password, resets passwords, and disables or enables logins. No email or SMS goes out.
- **Photos.** Storage bucket `barber-photos`: public read, manager writes.

#### Local stack

```bash
tools/local-stack.sh start   # Colima profile fadeempire, project fadeempire-app, API http://127.0.0.1:56321, seeded
tools/local-stack.sh test    # fresh database, db lint, every pgTAP suite, then seeds again and checks
tools/local-stack.sh check   # service_role's privileges, then staff-admin's login flow end to end (reset and test end with it)
tools/local-stack.sh env     # URL + anon key for the app's Debug-Local config
tools/local-stack.sh reset | functions | stop
tools/booking-lock-check.sh  # two sessions at once: no deadlock across chairs, one slot_taken per overlap
```

It runs only on its own Colima VM (`DOCKER_HOST=unix://$HOME/.colima/fadeempire/docker.sock`) and ports 56320-56329; the default docker context and ports 5432x/5532x belong to other projects on this machine. Seeded logins (local only, password `fade-local-1`): `ali@local.test` (manager), `hassan@local.test`, `larry@local.test`, plus a week of bookings on both chairs with a group, a cancellation, a move and a no-show (`tools/local-stack-seed.sql`).

#### Deploy

```bash
tools/deploy-barber-app.sh --dry-run
SUPABASE_SERVICE_ROLE_KEY=eyJ... MANAGER_EMAIL=you@example.com \
APNS_KEY_ID=... APNS_TEAM_ID=9X79V37Q89 APNS_KEY_FILE=~/AuthKey_XXXXXXXXXX.p8 \
CONFIRM_PROD=1 tools/deploy-barber-app.sh   # db push, two functions, APNs secrets, Vault, manager login
SUPABASE_SERVICE_ROLE_KEY=<local service role key> MANAGER_EMAIL=you@example.com \
tools/deploy-barber-app.sh --local          # the manager login step only, against the local stack
```

Same safeguards as `deploy-reminders.sh` (two confirmations, a terminal, secrets only through mode-600 temp files). It prints the manager's temporary password once. Then, in the dashboard, turn off **Allow new users to sign up**: the app has no sign-up. The APNs variables can come later; until then pushes run dry.

---

## Local development

```bash
cd FadeEmpire
python3 -m http.server 8000
open http://localhost:8000
```

That's it. Open the site, edit any file, refresh. Phone first: check the ≤600px layout before desktop.

`http.server` answers a missing path with its own 404, so barber links (`/larry`) only work under `tools/serve-pages.py`, which answers like GitHub Pages: 404.html with status 404.

```bash
python3 tools/serve-pages.py . --port 8000   # like GitHub Pages, on 0.0.0.0
tools/preview-local.sh                       # a copy wired to the local stack (tools/local-stack.sh), on :8021
```

`preview-local.sh` hard-links the site into `site-preview` next to the checkout (no extra disk), writes that copy's `config.js` with the local stack's URL (the Tailscale IP, so a phone can use it) and anon key, and serves it on port 8021; it stops if the port is taken. To try a barber added in the app, insert one into the local database (a `barbers` row and `barber_schedules` inside store hours) and reload.

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
| `booking-calendar.test.js` | The .ics read back by a small parser (`ics-parse.js`): required properties, UTC times in EDT and EST, groups, escaping, CRLF |
| `barbers.dom.test.js` | The site following the database's barbers, booted as main.js boots: a third barber in the picker (hours, days, times, booking), a deactivated one gone, a day off, a failed or slow read falling back to `config.js`, the barbers section (hidden spreads, plain spreads, heading) and the hero line, booking links (`?barber=&service=`, bad values, a link over the returning customer, a link to a barber that arrives late), hostile text in every field, an empty answer, barbers that land during a confirmation or close the picked day or time, and off-grid bookings |
| `pretty-link.test.js` | `/<slug>` links: which paths are slugs, the redirect target, the anon lookup (found, not found, error, timeout) |
| `booking-form.dom.test.js` | The real `#book` markup with the real modules and a mocked RPC layer: grid, barber switching, success, group, slot_taken hard-fail, fallback, cancellation, and the edge cases (closed-day tags, next-slot pick, last slot of the day, guest cap, custom requests, double-tap, midnight rollover, the five-minute refresh) |
| `page-modules.dom.test.js` | page.js (stamp, hero status, sticky nav, phone-only compare collapse, landing on a #fragment), cover.js (next-slot lines), nav.js (mobile menu), main.js (booking or database client failing to load), visit.js (today's row, status, midnight), shop-video.js (lazy file choice, muted default, sound toggle, reduced motion), gallery.js (lightbox, keys, swipe, focus return) |
| `site-content.test.js` | Drift guards on `index.html`: every price in the menu / form / guest rows / JSON-LD matches `config.js`, the hours card and structured data match `STORE_HOURS`, the shipped picker and spreads match `BARBERS` (the fallback) and its hours lines, 404.html's inline slug check matches `pretty-link.js`, one `?v=` release, no served folder a barber slug could shadow, every referenced asset exists on disk, every image has alt + dimensions, videos are muted/inline/lazy |

### Database tests (pgTAP)

`supabase/tests/*.sql` is a pgTAP suite that runs against a REAL local Postgres
(the same `supabase/postgres` image the hosted project uses) with all
migrations applied from scratch: schema + seeds + hours, the booking RPC
(store/barber hours enforcement, double-booking races, VIP multi-slot,
server-side pricing, rate limits), group bookings, the cancellation flow,
the anon security model (RLS + function grants), people tracking, reminders,
and the barber app (007). Needs Docker:

```bash
npm run test:db    # supabase db start && supabase test db
```

### CI (GitHub Actions)

- **`.github/workflows/ci.yml`** — on every push/PR: the vitest suite, the
  full DB suite above (fresh Postgres, all migrations, `db lint`, pgTAP), and
  the Deno tests for send-reminders, staff-admin and notify-booking-event. The Supabase CLI (2.109.0) and Deno (2.9.7)
  versions are pinned. Make all three jobs required checks on `main` so
  nothing broken can deploy.
- **`.github/workflows/live-health.yml`** — daily at 7 am ET, after every push
  to `main`, and on demand: read-only end-to-end checks against the LIVE site
  and database using only the public anon key. Verifies the deploy is current,
  prices/hours/barbers in Supabase still match the `config.js` mirrors, the
  booking + cancellation RPCs are live and validating, and the security
  posture holds (no PII readable by anon, owner and manager RPCs not
  executable). Barbers are managed in the app, so it checks the barbers read
  the site makes (it works, and every barber in it has a link-safe slug and
  hours inside the store's), that `config.js`'s fallback barbers have the
  database's hours, and that `/<slug>` reaches the forwarding 404 page; a
  barber added or deactivated in the app is not a failure (a fallback barber
  gone from the database is printed as a note). Run it locally anytime with
  `npm run health`.

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

To count the people who have booked, not just phone numbers. A group booking stores one row per person under the booker's phone; `party_id` ties them together, `is_guest` marks the friends and kids, and `v_people` has one row per phone + first name:

```sql
select count(*)                                    as people,
       count(*) filter (where is_kid)              as kids,        -- has had a Kids Cut
       count(*) filter (where booked_as_guest > 0) as came_as_a_guest,
       count(distinct phone)                       as phones
  from v_people;
```

---

## Developer

Ali Younes — `aldo@sideband.studio`

© 2026 Fade Empire. All rights reserved.
