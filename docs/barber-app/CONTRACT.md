# Fade Empire barber app: contract

The iOS app (`ios/`), the database (`supabase/migrations/0022_barber_app.sql`), the Edge
Function `staff-admin`, and the website all build against this file. If an implementation
has to differ, change this file in the same commit and say so in the report.

## People and access

| Who | Role | Can see | Can change |
| --- | --- | --- | --- |
| Ali | `manager` | every chair, active or not | everything: barbers, hours, logins, view grants, any appointment |
| Hassan, Larry, new barbers | `barber` | their own chair, plus chairs granted to them read-only | their own chair's appointments, days off, links |

- Hassan can view Larry's chair, read-only. The migration seeds this as a grant; the manager can change it later.
- A barber who is deactivated, or whose login is disabled, sees nothing.
- Barbers sign in with email and password. There is no public sign-up path in the app. The manager creates each
  login from the app. That returns a temporary password once, and the barber must change it on first sign-in.
  No email or SMS is sent by the system.
- Removing a barber means deactivating them, not deleting the row. Their booking history keeps its barber (the
  Javier precedent, migration 0013). Deactivating does not cancel upcoming bookings; the app shows them first.

## Database (migration 0022_barber_app.sql)

Rule from 0010: every new function gets explicit `revoke execute ... from public, anon` (and from
`authenticated` where it is not meant for the app). Every SECURITY DEFINER function sets `search_path = public`.

### Tables

```
barbers            + title text                 -- "Master Barber"; shown on the site and in the app
staff              user_id uuid pk -> auth.users on delete cascade
                   role text check in ('manager','barber')
                   barber_id uuid unique null -> barbers   (required when role = 'barber')
                   display_name text not null
                   must_change_password boolean not null default true
                   notify_bookings boolean not null default true
                   notify_cancellations boolean not null default true
                   notify_viewed_chairs boolean not null default false
                   activity_seen_at timestamptz not null default now()
                   created_at timestamptz not null default now()
barber_view_grants viewer_barber_id uuid -> barbers, barber_id uuid -> barbers, pk (both), check (viewer <> barber)
booking_events     id bigint identity pk, booking_id uuid -> bookings on delete cascade,
                   barber_id uuid -> barbers, kind text check in ('booked','cancelled','no_show','moved'),
                   actor text check in ('customer','barber','manager','system'), occurred_at timestamptz default now()
                   -- written by triggers on bookings (primary rows only: linked_to is null)
booking_links      id uuid pk, barber_id uuid -> barbers on delete cascade, label text (1-60 chars),
                   service_slug text null -> services(slug), created_at timestamptz default now()
device_tokens      token text pk, user_id uuid -> auth.users on delete cascade,
                   environment text check in ('sandbox','production'), updated_at timestamptz
```

RLS: `bookings` gets a select policy for `authenticated` using `app_can_view(barber_id)`. All writes go through the
RPCs below. `booking_links` allows select/insert/delete where `app_can_manage(barber_id)`. `barbers` gains a select
policy for managers that includes inactive rows. Storage bucket `barber-photos` is public-read, and only managers
can write to it.

### Helpers (SECURITY DEFINER, stable, granted to authenticated)

`app_is_manager()`, `app_my_barber_id()` (null unless the caller's barber is active),
`app_can_view(p_barber_id uuid)`, `app_can_manage(p_barber_id uuid)`.

### RPCs for the app (granted to authenticated only)

Times are shop-local (`America/New_York`). Dates are `YYYY-MM-DD`; times are `HH:MM:SS`.

| RPC | Returns | Notes |
| --- | --- | --- |
| `app_me()` | one row: `user_id, role, display_name, barber_id, barber_slug, must_change_password, notify_bookings, notify_cancellations, notify_viewed_chairs, chairs jsonb` | `chairs` = `[{barber_id, slug, display_name, title, is_active, can_manage}]` the caller may see, own chair first, then `sort_order`. The manager gets every barber. |
| `app_bookings(p_barber_id uuid, p_from date, p_to date)` | rows: `id, barber_id, barber_slug, booking_date, booking_time, end_time, service_slug, service_name, duration_minutes, addons text[] (display names), custom_request, customer_notes, customer_name, customer_phone, total_price_cents, status, source, is_guest, party_id, party_size, created_at, cancelled_at, cancelled_by, can_manage` | Primary rows only. Includes cancelled and no-show rows so the day shows what happened. Raises `forbidden` unless `app_can_view`. |
| `app_free_slots(p_barber_id uuid, p_date date)` | rows: `slot_time time` | The same rule the site uses: store hours ∩ barber schedule, minus closures, minus taken slots, 45-minute grid from open, no past slots today. |
| `app_book(p_barber_id uuid, p_service_slug text, p_date date, p_time time, p_customer_name text, p_customer_phone text, p_addon_slugs text[] default '{}', p_notes text default null)` | `booking_id uuid` | Requires `app_can_manage`. Goes through `book_slot` logic with `source = 'app'`. Raises the same error codes as `book_slot` (`slot_taken`, etc.). |
| `app_cancel_booking(p_booking_id uuid)` | one row: `booking_id, customer_name, customer_phone, booking_date, booking_time` | Requires `app_can_manage`. Sets `cancelled`, `cancelled_by = 'barber' \| 'manager'`, and frees linked continuation slots. Returns the data the app needs to prefill a text to the customer. |
| `app_set_status(p_booking_id uuid, p_status text)` | void | `p_status` in `no_show`, `confirmed` (undo a no-show). Requires `app_can_manage`. |
| `app_activity(p_before bigint default null, p_limit int default 50)` | rows: `event_id, kind, actor, occurred_at, booking_id, barber_id, barber_slug, barber_name, customer_name, booking_date, booking_time, service_name, is_unread` | Chairs the caller can view, newest first. `is_unread` = after `activity_seen_at` and not caused by the caller. |
| `app_mark_activity_seen()` | void | |
| `app_days_off(p_barber_id uuid)` | rows: `closure_date, reason, bookings_that_day int` | Today onward. |
| `app_add_day_off(p_barber_id uuid, p_date date, p_reason text default null)` | `bookings_that_day int` | Requires `app_can_manage`. Does not cancel bookings; the app warns when the count is above 0. |
| `app_remove_day_off(p_barber_id uuid, p_date date)` | void | |
| `app_set_notify_prefs(p_bookings bool, p_cancellations bool, p_viewed_chairs bool)` | void | |
| `app_register_device(p_token text, p_environment text)` / `app_unregister_device(p_token text)` | void | |
| `app_password_changed()` | void | Clears `must_change_password`. Called after `auth.updateUser(password:)`. |

### Manager RPCs (granted to authenticated, raise `forbidden` unless `app_is_manager()`)

| RPC | Returns | Notes |
| --- | --- | --- |
| `manager_staff()` | rows: `user_id, email, role, display_name, barber_id, last_sign_in_at, is_disabled` | Reads `auth.users`. |
| `manager_save_barber(p_id uuid, p_slug text, p_display_name text, p_title text, p_bio text, p_photo_url text)` | `barber_id uuid` | `p_id` null creates the barber. The slug is lowercase `[a-z0-9-]`, 2-30 characters, unique, and immutable once bookings exist. A new barber gets `sort_order` after the last one. |
| `manager_set_schedule(p_barber_id uuid, p_days jsonb)` | void | `[{weekday 0-6, open "HH:MM", close "HH:MM"}]` replaces the week. Each day must sit inside `store_hours` for that weekday; otherwise it raises `outside_store_hours`. |
| `manager_set_active(p_barber_id uuid, p_active boolean)` | `upcoming_bookings int` | Deactivating hides the barber from the site and the booking RPCs at once. |
| `manager_set_view_grant(p_viewer_barber_id uuid, p_barber_id uuid, p_granted boolean)` | void | |
| `manager_barber_schedule(p_barber_id uuid)` | rows: `weekday, open_time, close_time` | Includes inactive barbers. |

### Edge Function `staff-admin` (POST, caller's JWT, caller must be a manager)

`{action: "create_login", email, display_name, role: "barber"|"manager", barber_id?}` returns `{user_id, temporary_password}`.
`{action: "reset_password", user_id}` returns `{temporary_password}`.
`{action: "disable_login", user_id}` and `{action: "enable_login", user_id}` return `{ok: true}`. Disabling bans the
auth user and deletes their device tokens.
Users are created with `email_confirm: true`, so no email goes out. A temporary password is 4 short words plus 2 digits.

### Edge Function `notify-booking-event`

A trigger on `booking_events` posts to it through `pg_net`, using a Vault-held URL and key, following 0020's
pattern. It sends an APNs alert to every device whose user can view the chair and wants that kind:
own chair → `notify_bookings` / `notify_cancellations`; a granted chair → also `notify_viewed_chairs`. The
manager is treated like a granted viewer for every chair. It skips the user whose action caused the event. Without
the `APNS_*` secrets it logs and returns 200. Push copy: title `New booking` / `Cancelled` / `No-show`, body
`Marcus · Thu Oct 23, 2:15 PM · Hair Cut` (+ ` · Larry's chair` when it is not the user's own chair).

## Booking links (app → website)

- Plain barber link: `https://chicopeefadeempire.com/<slug>`, e.g. `/larry`. GitHub Pages serves `404.html`, which
  redirects an active barber's slug to `/?barber=<slug>#book` and shows the normal 404 otherwise.
- Link with options: `https://chicopeefadeempire.com/?barber=<slug>&service=<service-slug>#book`.
- The site preselects the barber and service from those parameters and lands on the booking form. An unknown or
  inactive barber falls back to the normal picker.
- Custom links are rows in `booking_links` (label + optional service). The app shows each one with Copy, Share, and QR.

## Website changes

- The booking picker's barbers and hours come from the database (`barbers` + `barber_schedules`, already
  anon-readable). `config.js` is the fallback when the read fails, so a barber added in the app appears without a
  deploy, and a deactivated one disappears.
- The barbers section keeps its two hand-built spreads for Hassan and Larry. It hides a spread whose barber is
  inactive and appends a simple spread (photo from `photo_url`, name, title, bio) for any other active barber.

## iOS app

- `ios/` in this repo, XcodeGen `project.yml` with the generated `.xcodeproj` committed, Swift + SwiftUI, iOS 17.0+,
  bundle id `com.chicopeefadeempire.barbers`, team `9X79V37Q89`, display name `Fade Empire`.
- One dependency: `supabase-swift` (SPM, pinned).
- Build configurations: `Debug-Local` points at the local stack (`http://127.0.0.1:55321`); `Debug` and `Release`
  point at production (`SUPABASE_URL` and the publishable key from `scripts/config.js`). Values live in `.xcconfig`
  files.
- A `Backend` protocol with a Supabase implementation and an in-memory `MockBackend`. The launch argument
  `-mock-backend` selects the mock (previews, UI tests, screenshots).
- Screens:
  - Sign in, then a forced new password when required.
  - **Schedule**: a chair switcher when the user can see more than one chair, with "View only" on granted chairs.
    It has a day strip (today plus 4 weeks) and the day's appointments. Closed days and days off show as such.
  - **Appointment** detail: Call, Text, service, add-ons, request, notes, price, party, and when and how it was
    booked. Actions when `can_manage`: Cancel (confirm, then offer a prefilled text to the customer), Mark no-show
    or Undo.
  - **New appointment**: service, date, free slot, name, phone, add-ons, notes.
  - **Days off**: list, add, and remove, with a warning when bookings exist that day.
  - **Activity**: booked, cancelled, no-show, and moved events, with an unread badge on the tab.
  - **Links**: the plain link and custom links, with Copy, Share, QR, add, and delete.
  - **Settings**: notification toggles, change password, sign out.
  - Manager only, **Barbers**: list, add or edit (name, slug, title, bio, photo, weekly hours), deactivate (upcoming
    bookings shown first), reactivate, app login (create, reset password, disable or enable), and "Can also view"
    grants.
- Data refreshes on launch, foregrounding, pull-to-refresh, and every 60 s while visible. Push notifications use
  the APNs token through `app_register_device`.
- Copy rule for the whole app: every string tells the barber something they need. No decorative or filler text.

## Local stack (development only)

A dedicated Colima profile `fadeempire` with its own Docker socket (`DOCKER_HOST=unix:///Users/aldo/.colima/fadeempire/docker.sock`).
It runs a Supabase stack with project id `fadeempire-app`, API on 55321 and DB on 55322. Ports 54321-54325 belong
to another project and are never used. Seeded logins (local only, password `fade-local-1`):
`ali@local.test` (manager), `hassan@local.test`, `larry@local.test`.
