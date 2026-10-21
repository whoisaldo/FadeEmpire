-- 0022_barber_app.sql
--
-- The database side of the barber app (docs/barber-app/CONTRACT.md):
--
--   1. barbers.title ("Master Barber", "Barber"), shown on the site and in the app.
--   2. staff: one row per app login (manager or barber), keyed by auth.users.
--      barber_view_grants: chairs a barber may view read-only (Hassan → Larry).
--      booking_events: booked / cancelled / no_show / moved, written by triggers.
--      booking_links: a barber's custom booking links. device_tokens: APNs tokens.
--   3. Helpers app_is_manager(), app_my_barber_id(), app_can_view(), app_can_manage().
--      A login that is disabled (auth.users.banned_until in the future) counts as
--      no login at once, without waiting for its JWT to expire. A barber whose chair
--      is inactive has no chair, so sees nothing.
--   4. book_slot is split: book_slot_at(barber_id, ...) holds 0020's body verbatim
--      (store hours, barber schedule, closures, the 45-minute grid, slot_taken via
--      the partial unique index, server-side price) and book_slot is a wrapper that
--      resolves the slug. A trigger on bookings (tg_booking_no_overlap) rejects any
--      active booking that overlaps another on the same chair, with slot_taken, so
--      a grid moved by manager_set_schedule cannot double-book a chair. app_book
--      calls book_slot_at, so the app and the site share one set of booking rules. The per-phone limit (6 active future bookings) is
--      the anon anti-spam rule; app_book skips it, because a barber booking a
--      regular's standing appointments, or walk-ins under the shop's phone, is not
--      spam. App bookings store remind_sms = false: the customer never ticked the
--      site's SMS consent box.
--   5. Triggers on bookings write booking_events for primary rows (linked_to is
--      null). The actor comes from the app RPCs (fe.actor / fe.actor_user, set
--      transaction-locally like 0020's fe.sms_bookkeeping), else from the row: a web
--      insert is the customer, cancelled_by names who cancelled, anything else is
--      'system'. Undoing a no-show deletes that booking's no_show event.
--
--      "moved": the site's "Move it" (scripts/booking-cancel.js) calls the same
--      cancel_booking as Cancel, then the customer books a new time through
--      book_slot / book_slot_group like any booking. Nothing in either call says
--      "move". The trigger therefore records 'moved' instead of 'booked' when a web
--      booking's booker (not a guest) has a customer cancellation of their own
--      primary booking within the last 30 minutes, matched on the NANP-equivalent
--      phone (0011). The cancellation itself stays a 'cancelled' event. A customer
--      who cancels and rebooks within 30 minutes without the Move button reads as a
--      move too, which is what it is for the barber.
--
--   6. A trigger on booking_events posts {event_id} to the notify-booking-event
--      Edge Function through pg_net, with the URL and key read from Vault
--      ('notify-booking-event-url', 'notify-booking-event-key'). Without both
--      secrets it does nothing; any failure to queue is a warning, never a failed
--      booking. tools/deploy-barber-app.sh creates the secrets.
--   7. app_* RPCs (authenticated only) and manager_* RPCs (authenticated, raise
--      forbidden unless the caller is a manager). notify_event_payload() and
--      notify_drop_device_tokens() are for the Edge Function (service_role only).
--   8. Storage bucket barber-photos: public read, manager-only writes.
--
-- Grants follow 0010 and 0011: every new function revokes execute from public and
-- anon explicitly (and from authenticated where the app must not call it); every
-- new table revokes everything from anon and authenticated, then grants exactly
-- what the app needs. bookings gains a select grant for authenticated, limited by
-- the RLS policy to the chairs the caller can manage. A view-only chair is read
-- through app_bookings, without customer phones. confirm_booking (0001) is closed
-- to authenticated: service_role only.
--
-- Errors are raised as messages the app matches on, with the same SQLSTATEs as the
-- booking RPCs: forbidden (42501), barber_not_found / booking_not_found (P0002),
-- and 22023 for invalid input (invalid_range, invalid_status, invalid_status_change,
-- not_primary, cannot_cancel, date_out_of_range, invalid_slug, slug_reserved,
-- slug_taken, slug_locked, invalid_name, invalid_schedule, outside_store_hours,
-- invalid_grant, invalid_environment, invalid_token), plus every book_slot code.
--
-- Apply with `supabase db push --linked` (tools/deploy-barber-app.sh) for project
-- mjehfaonibgobimfiijk. Idempotent.

-- =============================================================================
-- 1. barbers.title
-- =============================================================================

alter table barbers add column if not exists title text;

update barbers set title = 'Master Barber' where slug = 'hassan' and title is null;
update barbers set title = 'Barber'        where slug = 'larry'  and title is null;

-- =============================================================================
-- 2. Tables
-- =============================================================================

create table if not exists staff (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  role                  text not null check (role in ('manager', 'barber')),
  barber_id             uuid unique references barbers(id),
  display_name          text not null check (length(trim(display_name)) between 1 and 60),
  must_change_password  boolean not null default true,
  notify_bookings       boolean not null default true,
  notify_cancellations  boolean not null default true,
  notify_viewed_chairs  boolean not null default false,
  activity_seen_at      timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  constraint staff_barber_has_chair check (role = 'manager' or barber_id is not null)
);

create table if not exists barber_view_grants (
  viewer_barber_id  uuid not null references barbers(id) on delete cascade,
  barber_id         uuid not null references barbers(id) on delete cascade,
  primary key (viewer_barber_id, barber_id),
  check (viewer_barber_id <> barber_id)
);

-- actor_user_id is the staff login that caused the event (null for customers and
-- the system): app_activity's is_unread and the push skip it.
create table if not exists booking_events (
  id             bigint generated always as identity primary key,
  booking_id     uuid not null references bookings(id) on delete cascade,
  barber_id      uuid not null references barbers(id),
  kind           text not null check (kind in ('booked', 'cancelled', 'no_show', 'moved')),
  actor          text not null check (actor in ('customer', 'barber', 'manager', 'system')),
  actor_user_id  uuid references auth.users(id) on delete set null,
  occurred_at    timestamptz not null default now()
);

create index if not exists booking_events_barber_idx  on booking_events (barber_id, id desc);
create index if not exists booking_events_booking_idx on booking_events (booking_id);

create table if not exists booking_links (
  id            uuid primary key default gen_random_uuid(),
  barber_id     uuid not null references barbers(id) on delete cascade,
  label         text not null check (length(trim(label)) between 1 and 60),
  service_slug  text references services(slug),
  created_at    timestamptz not null default now()
);

create index if not exists booking_links_barber_idx on booking_links (barber_id, created_at);

create table if not exists device_tokens (
  token        text primary key check (length(token) between 1 and 200),
  user_id      uuid not null references auth.users(id) on delete cascade,
  environment  text not null check (environment in ('sandbox', 'production')),
  updated_at   timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on device_tokens (user_id);

-- Hassan can view Larry's chair, read-only. The manager can change it in the app.
insert into barber_view_grants (viewer_barber_id, barber_id)
select v.id, b.id
  from barbers v, barbers b
 where v.slug = 'hassan' and b.slug = 'larry'
on conflict do nothing;

-- RLS on, everything locked, then exactly what the app needs. staff, grants,
-- events and device tokens are read and written only through the RPCs below.
alter table staff              enable row level security;
alter table barber_view_grants enable row level security;
alter table booking_events     enable row level security;
alter table booking_links      enable row level security;
alter table device_tokens      enable row level security;

revoke all on staff, barber_view_grants, booking_events, booking_links, device_tokens
  from public, anon, authenticated;
grant all on staff, barber_view_grants, booking_events, booking_links, device_tokens
  to service_role;
revoke all on sequence booking_events_id_seq from public, anon, authenticated;
grant usage, select on sequence booking_events_id_seq to service_role;

grant select, insert, delete on booking_links to authenticated;

-- =============================================================================
-- 3. Helpers
-- =============================================================================

-- The caller's staff row, or no row when the caller has none or the login is
-- disabled. Internal: the helpers below and the RPCs use it.
create or replace function app_caller()
returns setof staff
language sql
stable
security definer
set search_path = public
as $$
  select s.*
    from staff s
    join auth.users u on u.id = s.user_id
   where s.user_id = auth.uid()
     and (u.banned_until is null or u.banned_until <= now())
$$;

revoke execute on function app_caller() from public, anon, authenticated;

create or replace function app_is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from app_caller() c where c.role = 'manager')
$$;

-- Null unless the caller's chair is active.
create or replace function app_my_barber_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select b.id
    from app_caller() c
    join barbers b on b.id = c.barber_id
   where b.is_active
$$;

-- app_can_view and app_can_manage return true or false, never null: the RPCs
-- guard with `if not app_can_...`, and `not null` would let the call through.
create or replace function app_can_view(p_barber_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_barber_id is not null and (
    app_is_manager()
    or p_barber_id = app_my_barber_id()
    or exists (
      select 1
        from barber_view_grants g
        join barbers b on b.id = g.barber_id
       where g.viewer_barber_id = app_my_barber_id()
         and g.barber_id        = p_barber_id
         and b.is_active
    )
  ), false)
$$;

create or replace function app_can_manage(p_barber_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_barber_id is not null and (app_is_manager() or p_barber_id = app_my_barber_id()), false)
$$;

revoke execute on function app_is_manager()        from public, anon;
revoke execute on function app_my_barber_id()      from public, anon;
revoke execute on function app_can_view(uuid)      from public, anon;
revoke execute on function app_can_manage(uuid)    from public, anon;
grant  execute on function app_is_manager()        to authenticated;
grant  execute on function app_my_barber_id()      to authenticated;
grant  execute on function app_can_view(uuid)      to authenticated;
grant  execute on function app_can_manage(uuid)    to authenticated;

-- Marks the rest of this transaction's booking changes as the caller's: 'manager'
-- when a manager acts on a chair that is not their own, else 'barber'. The event
-- trigger reads both settings; app_clear_actor() resets them before the RPC returns.
create or replace function app_set_actor(p_barber_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  v_actor := case
               when app_is_manager() and p_barber_id is distinct from app_my_barber_id()
                 then 'manager'
               else 'barber'
             end;
  perform set_config('fe.actor', v_actor, true);
  perform set_config('fe.actor_user', auth.uid()::text, true);
  return v_actor;
end;
$$;

create or replace function app_clear_actor()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('fe.actor', '', true);
  perform set_config('fe.actor_user', '', true);
end;
$$;

revoke execute on function app_set_actor(uuid) from public, anon, authenticated;
revoke execute on function app_clear_actor()   from public, anon, authenticated;

-- =============================================================================
-- 4. RLS for the app
-- =============================================================================

-- Direct reads are for chairs the caller can manage. A view-only chair is read
-- through app_bookings, which leaves out the customer's phone: a booking id plus
-- its phone is all cancel_booking (the site's customer path) asks for.
grant select on bookings to authenticated;

drop policy if exists "staff read viewable bookings" on bookings;
drop policy if exists "staff read managed bookings" on bookings;
create policy "staff read managed bookings" on bookings
  for select to authenticated using (app_can_manage(barber_id));

drop policy if exists "managers read all barbers" on barbers;
create policy "managers read all barbers" on barbers
  for select to authenticated using (app_is_manager());

drop policy if exists "staff read own links"   on booking_links;
drop policy if exists "staff add own links"    on booking_links;
drop policy if exists "staff delete own links" on booking_links;
create policy "staff read own links" on booking_links
  for select to authenticated using (app_can_manage(barber_id));
create policy "staff add own links" on booking_links
  for insert to authenticated with check (app_can_manage(barber_id));
create policy "staff delete own links" on booking_links
  for delete to authenticated using (app_can_manage(barber_id));

-- confirm_booking (0001) flips a pending booking to confirmed. 0010 left it granted
-- to authenticated for owner tooling, but nothing calls it as authenticated (owner
-- tooling uses the service role key), and with the app every login is
-- authenticated, staff row or not.
revoke execute on function confirm_booking(uuid) from public, anon, authenticated;
grant  execute on function confirm_booking(uuid) to service_role;

-- =============================================================================
-- 5. book_slot_at — 0020's book_slot body, by barber id, with the phone limit
--    switchable. book_slot keeps its signature and behavior and calls it.
--    Then the overlap trigger every booking path goes through.
-- =============================================================================

create or replace function book_slot_at(
  p_barber_id      uuid,
  p_service_slug   text,
  p_date           date,
  p_time           time,
  p_customer_name  text,
  p_customer_phone text,
  p_addon_slugs    text[],
  p_notes          text,
  p_custom_request text,
  p_source         text,
  p_remind_sms     boolean,
  p_rebook_sms     boolean,
  p_phone_limit    boolean
)
returns table (
  booking_id        uuid,
  slot_index        int,
  booking_time      time,
  booking_status    booking_status,
  hold_expires_at   timestamptz,
  total_price_cents int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_barber       barbers%rowtype;
  v_service      services%rowtype;
  v_sched        barber_schedules%rowtype;
  v_addon_total  int := 0;
  v_total        int;
  v_primary_id   uuid;
  v_link_id      uuid;
  v_phone_clean  text;
  v_slot_count   int;
  v_idx          int;
  v_slot_time    time;
  v_slot_min     int;
  v_step         int;
  v_open_min     int;
  v_close_min    int;
  v_addons_clean text[];
  v_notes_clean  text;
  v_custom_clean text;
begin
  v_phone_clean := regexp_replace(coalesce(p_customer_phone, ''), '\D', '', 'g');
  if length(v_phone_clean) < 10 then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_customer_name, ''))) < 2 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  select * into v_barber from barbers
   where barbers.id = p_barber_id and barbers.is_active = true;
  if not found then raise exception 'barber_not_found' using errcode = 'P0002'; end if;

  select * into v_service from services
   where services.slug = p_service_slug and services.is_active = true;
  if not found then raise exception 'service_not_found' using errcode = 'P0002'; end if;

  if p_date < current_date or p_date > current_date + interval '60 days' then
    raise exception 'date_out_of_range' using errcode = '22023';
  end if;

  if extract(second from p_time)::int <> 0 then
    raise exception 'invalid_slot_alignment' using errcode = '22023';
  end if;

  v_slot_min := extract(hour from p_time)::int * 60
              + extract(minute from p_time)::int;

  -- Slots sit on the barber's grid: open_time + n * slot_minutes. The grid is
  -- only checkable against that weekday's schedule row; on a day off, or at a
  -- time outside the window, the per-slot loop below raises store_closed /
  -- outside_working_hours exactly as before.
  select s.* into v_sched
    from barber_schedules s
   where s.barber_id = v_barber.id
     and s.weekday   = extract(dow from p_date)::smallint;

  v_step := coalesce(v_sched.slot_minutes, 45);

  if found then
    v_open_min  := extract(hour from v_sched.open_time)::int * 60
                 + extract(minute from v_sched.open_time)::int;
    v_close_min := extract(hour from v_sched.close_time)::int * 60
                 + extract(minute from v_sched.close_time)::int;
    if v_slot_min >= v_open_min and v_slot_min < v_close_min
       and (v_slot_min - v_open_min) % v_step <> 0 then
      raise exception 'invalid_slot_alignment' using errcode = '22023';
    end if;
  end if;

  -- Service duration drives slot count: ceil division by the grid step, min 1.
  -- Every 30-min service fills one 45-min slot; the 60-min VIP spans two.
  v_slot_count := greatest(1, ceil(v_service.duration_minutes::numeric / v_step)::int);

  -- Validate every slot: store hours FIRST, then the barber's schedule + closures.
  for v_idx in 0 .. v_slot_count - 1 loop
    v_slot_time := make_time((v_slot_min + v_idx * v_step) / 60,
                             (v_slot_min + v_idx * v_step) % 60, 0);

    if not is_within_store_hours(p_date, v_slot_time) then
      raise exception 'store_closed' using errcode = '22023';
    end if;

    if not exists (
      select 1 from barber_schedules s
       where s.barber_id = v_barber.id
         and s.weekday   = extract(dow from p_date)::smallint
         and v_slot_time >= s.open_time
         and v_slot_time <  s.close_time
    ) then
      raise exception 'outside_working_hours' using errcode = '22023';
    end if;

    if exists (
      select 1 from barber_closures c
       where c.barber_id = v_barber.id and c.closure_date = p_date
    ) then
      raise exception 'barber_closed' using errcode = '22023';
    end if;
  end loop;

  -- Compute total from DB-side prices
  v_addons_clean := coalesce(p_addon_slugs, '{}'::text[]);
  if array_length(v_addons_clean, 1) > 0 then
    select coalesce(sum(a.price_cents), 0) into v_addon_total
      from addons a
     where a.slug = any(v_addons_clean) and a.is_active = true;
  end if;
  v_total := v_service.base_price_cents + v_addon_total;

  -- Per-phone rate limit: max 6 active future bookings (group + multi-slot pushes this up).
  if p_phone_limit and (
    select count(*) from bookings b
      where b.customer_phone = v_phone_clean
        and b.status in ('pending', 'confirmed')
        and b.slot_at >= now()
  ) + v_slot_count > 6 then
    raise exception 'too_many_active_bookings' using errcode = '23505';
  end if;

  v_notes_clean  := nullif(trim(coalesce(p_notes, '')), '');
  v_custom_clean := nullif(trim(coalesce(p_custom_request, '')), '');

  -- Atomic insert loop. Any unique_violation rolls back ALL previous inserts
  -- in the transaction (function-level transaction).
  -- Slots are inserted CONFIRMED with no hold — they stay locked until cancelled.
  v_primary_id := gen_random_uuid();
  for v_idx in 0 .. v_slot_count - 1 loop
    v_slot_time := make_time((v_slot_min + v_idx * v_step) / 60,
                             (v_slot_min + v_idx * v_step) % 60, 0);

    if v_idx = 0 then
      v_link_id := null;
    else
      v_link_id := v_primary_id;
    end if;

    begin
      insert into bookings (
        id, barber_id, service_id, booking_date, booking_time,
        customer_name, customer_phone, customer_notes,
        selected_addons, custom_request,
        total_price_cents, status, hold_expires_at, source, linked_to,
        remind_sms, rebook_sms
      ) values (
        case when v_idx = 0 then v_primary_id else gen_random_uuid() end,
        v_barber.id, v_service.id, p_date, v_slot_time,
        trim(p_customer_name), v_phone_clean,
        v_notes_clean,
        case when v_idx = 0 then v_addons_clean else '{}'::text[] end,
        case when v_idx = 0 then v_custom_clean else null end,
        case when v_idx = 0 then v_total else 0 end,         -- snapshot price only on primary
        'confirmed', null, coalesce(p_source, 'web'),
        v_link_id,
        coalesce(p_remind_sms, true), coalesce(p_rebook_sms, false)
      );
    exception
      when unique_violation then
        raise exception 'slot_taken' using errcode = '23505',
          detail = format('Conflict on slot %s', v_slot_time);
    end;

    booking_id        := case when v_idx = 0 then v_primary_id else null end;
    slot_index        := v_idx;
    booking_time      := v_slot_time;
    booking_status    := 'confirmed';
    hold_expires_at   := null;
    total_price_cents := case when v_idx = 0 then v_total else 0 end;
    return next;
  end loop;

  return;
end;
$$;

revoke execute on function book_slot_at(uuid, text, date, time, text, text, text[], text, text, text, boolean, boolean, boolean)
  from public, anon, authenticated;

-- book_slot: same signature, grants and behavior as 0020. The slug lookup runs
-- after the phone and name checks inside book_slot_at, so the error order holds:
-- an unknown or inactive slug passes a null id, which raises barber_not_found.
create or replace function book_slot(
  p_barber_slug    text,
  p_service_slug   text,
  p_date           date,
  p_time           time,
  p_customer_name  text,
  p_customer_phone text,
  p_addon_slugs    text[]   default '{}',
  p_notes          text     default null,
  p_custom_request text     default null,
  p_source         text     default 'web',
  p_hold_minutes   int      default 15,
  p_remind_sms     boolean  default true,
  p_rebook_sms     boolean  default false
)
returns table (
  booking_id        uuid,
  slot_index        int,
  booking_time      time,
  booking_status    booking_status,
  hold_expires_at   timestamptz,
  total_price_cents int
)
language sql
security definer
set search_path = public
as $$
  select *
    from book_slot_at(
      (select b.id from barbers b where b.slug = p_barber_slug and b.is_active),
      p_service_slug, p_date, p_time, p_customer_name, p_customer_phone,
      p_addon_slugs, p_notes, p_custom_request, p_source,
      p_remind_sms, p_rebook_sms, true
    )
$$;

revoke all on function book_slot(text, text, date, time, text, text, text[], text, text, text, int, boolean, boolean) from public;
grant execute on function book_slot(text, text, date, time, text, text, text[], text, text, text, int, boolean, boolean)
  to anon, authenticated;

-- How long an active booking holds its chair, given the weekday's slot_minutes.
-- 0016 moved the shop from a 30- to a 45-minute grid and left the bookings already
-- made where they were: a cut booked before it is 30 minutes long, and a two-slot
-- service booked before it is a primary plus a continuation 30 minutes later. A
-- row's era is its created_at. The repo does not record the moment 0016 ran in
-- production, so the cutoff is 0016's commit (2026-08-20 20:53:08 PDT), the
-- earliest it could have run: a row created before it can only be on the 30-minute
-- grid. A half-hour row created between the commit and the push would be measured
-- at 45, which can only refuse a booking, never double one. booking_date cannot
-- tell the eras apart: a booking made the day before 0016 could be for 60 days
-- after it.
create or replace function booking_minutes(p_created_at timestamptz, p_step int)
returns int
language sql
immutable
security definer
set search_path = public
as $$
  select case when p_created_at < timestamptz '2026-08-21 03:53:08+00' then 30 else p_step end
$$;

revoke execute on function booking_minutes(timestamptz, int) from public, anon, authenticated;

-- No two active bookings (pending, confirmed, completed) on one chair overlap in
-- time. 0001's unique index compares start times only: once manager_set_schedule
-- moves a day's grid (open 10:00 → 10:15), a 10:15 slot passes it on top of a
-- 10:00 booking. Each row holds one grid slot, [booking_time, booking_time +
-- booking_minutes(created_at, slot_minutes)), with that weekday's slot_minutes (45
-- without a schedule row). The rows of one appointment (a primary and the rows
-- whose linked_to points to it) never conflict with each other, so undoing a
-- no-show on any appointment that holds its chair today works on an empty chair.
-- The check runs before every insert, and every update that makes a row active or
-- moves it, under one shop-wide transaction lock: a second booking anywhere in the
-- shop waits until the first commits, then sees it (each statement in a volatile
-- function takes a new snapshot). One lock for the whole shop, not one per chair
-- and day, so two transactions that book several chairs in opposite orders cannot
-- deadlock; with two chairs the wait is negligible. It raises slot_taken as a
-- unique_violation, which book_slot_at, 0020's book_slot_group and app_set_status
-- already catch and raise as slot_taken, so every booking path has the rule.
create or replace function tg_booking_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step  int;
  v_other time;
begin
  if new.status not in ('pending', 'confirmed', 'completed') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status in ('pending', 'confirmed', 'completed')
     and new.barber_id    = old.barber_id
     and new.booking_date = old.booking_date
     and new.booking_time = old.booking_time then
    return new;   -- pending → confirmed → completed keeps the same chair time
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fe.bookings', 0));

  select s.slot_minutes into v_step
    from barber_schedules s
   where s.barber_id = new.barber_id
     and s.weekday   = extract(dow from new.booking_date)::smallint;
  v_step := coalesce(v_step, 45);

  select o.booking_time into v_other
    from bookings o
   where o.barber_id    = new.barber_id
     and o.booking_date = new.booking_date
     and coalesce(o.linked_to, o.id) <> coalesce(new.linked_to, new.id)
     and o.status in ('pending', 'confirmed', 'completed')
     and new.booking_date + o.booking_time
           < new.booking_date + new.booking_time
             + make_interval(mins => booking_minutes(new.created_at, v_step))
     and new.booking_date + new.booking_time
           < new.booking_date + o.booking_time
             + make_interval(mins => booking_minutes(o.created_at, v_step))
   limit 1;
  if found then
    raise exception 'slot_taken' using errcode = '23505',
      detail = format('%s overlaps the active booking at %s', new.booking_time, v_other);
  end if;
  return new;
end;
$$;

revoke execute on function tg_booking_no_overlap() from public, anon, authenticated;

drop trigger if exists bookings_no_overlap on bookings;
create trigger bookings_no_overlap
  before insert or update of status, barber_id, booking_date, booking_time on bookings
  for each row execute function tg_booking_no_overlap();

-- =============================================================================
-- 6. booking_events, written by triggers on bookings
-- =============================================================================

create or replace function tg_booking_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind       text;
  v_actor      text := nullif(current_setting('fe.actor', true), '');
  v_actor_user uuid := nullif(current_setting('fe.actor_user', true), '')::uuid;
  v_phone10    text;
begin
  if new.linked_to is not null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'confirmed') then
      return null;
    end if;
    v_kind := 'booked';
    if v_actor is null and new.source = 'web' and not new.is_guest then
      v_phone10 := case when length(new.customer_phone) = 11 and new.customer_phone like '1%'
                        then substr(new.customer_phone, 2) else new.customer_phone end;
      if exists (
        select 1 from bookings c
         where c.customer_phone in (v_phone10, '1' || v_phone10)
           and c.id <> new.id
           and c.linked_to is null
           and c.status = 'cancelled'
           and c.cancelled_by = 'customer'
           and c.cancelled_at >= now() - interval '30 minutes'
      ) then
        v_kind := 'moved';
      end if;
    end if;
    v_actor := coalesce(v_actor, case when new.source = 'web' then 'customer' else 'system' end);
  elsif new.status is not distinct from old.status then
    return null;
  elsif new.status = 'cancelled' and old.status in ('pending', 'confirmed') then
    v_kind  := 'cancelled';
    v_actor := case when new.cancelled_by in ('customer', 'barber', 'manager') then new.cancelled_by
                    else coalesce(v_actor, 'system') end;
  elsif new.status = 'no_show' then
    v_kind  := 'no_show';
    v_actor := coalesce(v_actor, 'system');
  elsif old.status = 'no_show' then
    -- Undo: the booking is back, so the feed no longer says it was missed.
    delete from booking_events e where e.booking_id = new.id and e.kind = 'no_show';
    return null;
  else
    return null;
  end if;

  insert into booking_events (booking_id, barber_id, kind, actor, actor_user_id)
  values (new.id, new.barber_id, v_kind, v_actor,
          case when v_actor in ('barber', 'manager') then v_actor_user end);
  return null;
end;
$$;

revoke execute on function tg_booking_events() from public, anon, authenticated;

drop trigger if exists bookings_events_insert on bookings;
create trigger bookings_events_insert
  after insert on bookings
  for each row execute function tg_booking_events();

drop trigger if exists bookings_events_status on bookings;
create trigger bookings_events_status
  after update of status on bookings
  for each row execute function tg_booking_events();

-- =============================================================================
-- 7. Push: booking_events → pg_net → notify-booking-event (Vault-held URL + key)
-- =============================================================================

create or replace function tg_notify_booking_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s
   where s.name = 'notify-booking-event-url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s
   where s.name = 'notify-booking-event-key';
  if v_url is null or v_key is null then
    return null;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('event_id', new.id),
    timeout_milliseconds := 10000
  );
  return null;
exception when others then
  -- A push is a courtesy; the booking change it describes must still commit.
  raise warning 'notify-booking-event not queued for event %: %', new.id, sqlerrm;
  return null;
end;
$$;

revoke execute on function tg_notify_booking_event() from public, anon, authenticated;

drop trigger if exists booking_events_notify on booking_events;
create trigger booking_events_notify
  after insert on booking_events
  for each row execute function tg_notify_booking_event();

-- What the Edge Function needs for one event: the booking as the push shows it,
-- and every device whose user can view the chair (managers: every chair; barbers:
-- their own active chair and chairs granted to it). The function applies the
-- per-user preferences and skips the actor.
create or replace function notify_event_payload(p_event_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with e as (
    select ev.id, ev.kind, ev.actor, ev.actor_user_id, ev.booking_id, ev.barber_id,
           b.display_name as barber_name, b.is_active as barber_active,
           split_part(trim(bk.customer_name), ' ', 1) as customer_first_name,
           bk.booking_date, bk.booking_time, bk.is_guest,
           s.display_name as service_name,
           (select count(*)::int from bookings p
             where p.party_id = bk.party_id and p.linked_to is null
               and p.status in ('pending', 'confirmed')) as party_size
      from booking_events ev
      join bookings bk on bk.id = ev.booking_id
      join barbers  b  on b.id  = ev.barber_id
      join services s  on s.id  = bk.service_id
     where ev.id = p_event_id
  ),
  r as (
    select d.token, d.environment, st.user_id, st.role,
           coalesce(st.barber_id = e.barber_id, false) as own_chair,
           st.notify_bookings, st.notify_cancellations, st.notify_viewed_chairs
      from e
      cross join staff st
      join auth.users u on u.id = st.user_id
      join device_tokens d on d.user_id = st.user_id
      left join barbers sb on sb.id = st.barber_id
     where (u.banned_until is null or u.banned_until <= now())
       and (st.role = 'manager'
            or (sb.is_active and (
                  st.barber_id = e.barber_id
                  or (e.barber_active and exists (
                        select 1 from barber_view_grants g
                         where g.viewer_barber_id = st.barber_id
                           and g.barber_id = e.barber_id))
               )))
  )
  select jsonb_build_object(
    'event', (select to_jsonb(e) - 'barber_active' from e),
    'recipients', coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id, r.token) from r), '[]'::jsonb)
  )
$$;

create or replace function notify_drop_device_tokens(p_tokens text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from device_tokens where token = any(p_tokens);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function notify_event_payload(bigint)       from public, anon, authenticated;
revoke execute on function notify_drop_device_tokens(text[])  from public, anon, authenticated;
grant  execute on function notify_event_payload(bigint)       to service_role;
grant  execute on function notify_drop_device_tokens(text[])  to service_role;

-- =============================================================================
-- 8. App RPCs (authenticated only)
-- =============================================================================

create or replace function app_me()
returns table (
  user_id               uuid,
  role                  text,
  display_name          text,
  barber_id             uuid,
  barber_slug           text,
  must_change_password  boolean,
  notify_bookings       boolean,
  notify_cancellations  boolean,
  notify_viewed_chairs  boolean,
  chairs                jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me   staff%rowtype;
  v_mine uuid := app_my_barber_id();
begin
  select * into v_me from app_caller();
  if not found or (v_me.role = 'barber' and v_mine is null) then
    return;   -- no login, a disabled login, or a deactivated barber: no access
  end if;

  return query
  select v_me.user_id, v_me.role, v_me.display_name, v_mine,
         (select b.slug from barbers b where b.id = v_mine),
         v_me.must_change_password, v_me.notify_bookings,
         v_me.notify_cancellations, v_me.notify_viewed_chairs,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'barber_id',    b.id,
                    'slug',         b.slug,
                    'display_name', b.display_name,
                    'title',        b.title,
                    'is_active',    b.is_active,
                    'can_manage',   app_can_manage(b.id))
                  order by (b.id = v_mine) desc nulls last, b.sort_order, b.display_name)
             from barbers b
            where app_can_view(b.id)
         ), '[]'::jsonb);
end;
$$;

create or replace function app_bookings(p_barber_id uuid, p_from date, p_to date)
returns table (
  id                 uuid,
  barber_id          uuid,
  barber_slug        text,
  booking_date       date,
  booking_time       time,
  end_time           time,
  service_slug       text,
  service_name       text,
  duration_minutes   int,
  addons             text[],
  custom_request     text,
  customer_notes     text,
  customer_name      text,
  customer_phone     text,
  total_price_cents  int,
  status             text,
  source             text,
  is_guest           boolean,
  party_id           uuid,
  party_size         int,
  created_at         timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       text,
  can_manage         boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_manage boolean;
begin
  if not app_can_view(p_barber_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  v_manage := app_can_manage(p_barber_id);

  -- end_time is the end of the chair time on the grid: a 30-minute cut in a
  -- 45-minute slot ends 45 minutes after it starts. customer_phone is null on a
  -- chair the caller only views: with it, the booking id would cancel through
  -- cancel_booking as the customer.
  return query
  select bk.id, bk.barber_id, b.slug, bk.booking_date, bk.booking_time,
         (bk.booking_time + make_interval(mins =>
            greatest(1, ceil(s.duration_minutes::numeric / coalesce(sch.slot_minutes, 45))::int)
            * coalesce(sch.slot_minutes, 45)))::time,
         s.slug, s.display_name, s.duration_minutes,
         coalesce((select array_agg(a.display_name order by x.ord)
                     from unnest(bk.selected_addons) with ordinality as x(addon_slug, ord)
                     join addons a on a.slug = x.addon_slug), '{}'::text[]),
         bk.custom_request, bk.customer_notes, bk.customer_name,
         case when v_manage then bk.customer_phone end,
         bk.total_price_cents, bk.status::text, bk.source, bk.is_guest, bk.party_id,
         (select count(*)::int from bookings p
           where p.party_id = bk.party_id and p.linked_to is null and p.status <> 'expired'),
         bk.created_at, bk.cancelled_at, bk.cancelled_by, v_manage
    from bookings bk
    join barbers  b on b.id = bk.barber_id
    join services s on s.id = bk.service_id
    left join barber_schedules sch
      on sch.barber_id = bk.barber_id
     and sch.weekday   = extract(dow from bk.booking_date)::smallint
   where bk.barber_id = p_barber_id
     and bk.linked_to is null
     and bk.booking_date between p_from and p_to
     and bk.status <> 'expired'
   order by bk.booking_date, bk.booking_time, bk.created_at;
end;
$$;

-- The site's rule (scripts/booking-helpers.js slotsForWeekday + booking-grid.js):
-- from the barber's open time in slot_minutes steps while the slot starts before
-- the barber's close, inside store hours, not a day off, not already started, and
-- not overlapping an active booking (one left off the grid by a schedule change
-- blocks the slots it overlaps, as tg_booking_no_overlap does). Out of book_slot's date window (today .. +60 days) or for an inactive
-- barber there are no slots, so every slot listed is one book_slot accepts.
create or replace function app_free_slots(p_barber_id uuid, p_date date)
returns table (slot_time time)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_sched barber_schedules%rowtype;
begin
  if not app_can_view(p_barber_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_date is null or p_date < current_date or p_date > current_date + interval '60 days'
     or not exists (select 1 from barbers b where b.id = p_barber_id and b.is_active)
     or exists (select 1 from barber_closures c
                 where c.barber_id = p_barber_id and c.closure_date = p_date) then
    return;
  end if;

  select s.* into v_sched
    from barber_schedules s
   where s.barber_id = p_barber_id
     and s.weekday   = extract(dow from p_date)::smallint;
  if not found then
    return;
  end if;

  return query
  select g.t::time
    from generate_series(p_date + v_sched.open_time,
                         p_date + v_sched.close_time - interval '1 second',
                         make_interval(mins => v_sched.slot_minutes)) as g(t)
   where is_within_store_hours(p_date, g.t::time)
     and (g.t at time zone 'America/New_York') > now()
     and not exists (
       select 1 from bookings bk
        where bk.barber_id    = p_barber_id
          and bk.booking_date = p_date
          and bk.status in ('pending', 'confirmed', 'completed')
          and p_date + bk.booking_time < g.t + make_interval(mins => v_sched.slot_minutes)
          and g.t < p_date + bk.booking_time
                    + make_interval(mins => booking_minutes(bk.created_at, v_sched.slot_minutes)))
   order by 1;
end;
$$;

create or replace function app_book(
  p_barber_id      uuid,
  p_service_slug   text,
  p_date           date,
  p_time           time,
  p_customer_name  text,
  p_customer_phone text,
  p_addon_slugs    text[] default '{}',
  p_notes          text   default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not app_can_manage(p_barber_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform app_set_actor(p_barber_id);
  select bs.booking_id into v_id
    from book_slot_at(p_barber_id, p_service_slug, p_date, p_time,
                      p_customer_name, p_customer_phone, p_addon_slugs, p_notes,
                      null, 'app', false, false, false) bs
   where bs.slot_index = 0;
  perform app_clear_actor();
  return v_id;
end;
$$;

create or replace function app_cancel_booking(p_booking_id uuid)
returns table (
  booking_id      uuid,
  customer_name   text,
  customer_phone  text,
  booking_date    date,
  booking_time    time
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_bk    bookings%rowtype;
  v_actor text;
begin
  select * into v_bk from bookings b where b.id = p_booking_id;
  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;
  if not app_can_manage(v_bk.barber_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_bk.linked_to is not null then
    raise exception 'not_primary' using errcode = '22023';
  end if;
  if v_bk.status not in ('pending', 'confirmed') then
    raise exception 'cannot_cancel' using errcode = '22023';
  end if;

  v_actor := app_set_actor(v_bk.barber_id);
  update bookings b
     set status          = 'cancelled',
         cancelled_at    = now(),
         cancelled_by    = v_actor,
         hold_expires_at = null
   where b.id = p_booking_id or (b.linked_to = p_booking_id and b.status in ('pending', 'confirmed'));
  perform app_clear_actor();

  return query
  select v_bk.id, v_bk.customer_name, v_bk.customer_phone, v_bk.booking_date, v_bk.booking_time;
end;
$$;

create or replace function app_set_status(p_booking_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bk bookings%rowtype;
begin
  select * into v_bk from bookings b where b.id = p_booking_id;
  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;
  if not app_can_manage(v_bk.barber_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_bk.linked_to is not null then
    raise exception 'not_primary' using errcode = '22023';
  end if;

  perform app_set_actor(v_bk.barber_id);
  if p_status = 'no_show' then
    if v_bk.status not in ('pending', 'confirmed', 'completed') then
      raise exception 'invalid_status_change' using errcode = '22023';
    end if;
    update bookings b
       set status = 'no_show', hold_expires_at = null
     where b.id = p_booking_id
        or (b.linked_to = p_booking_id and b.status in ('pending', 'confirmed', 'completed'));
  elsif p_status = 'confirmed' then
    if v_bk.status <> 'no_show' then
      raise exception 'invalid_status_change' using errcode = '22023';
    end if;
    begin
      update bookings b
         set status = 'confirmed'
       where b.id = p_booking_id
          or (b.linked_to = p_booking_id and b.status = 'no_show');
    exception when unique_violation then
      raise exception 'slot_taken' using errcode = '23505';
    end;
  else
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  perform app_clear_actor();
end;
$$;

create or replace function app_activity(p_before bigint default null, p_limit int default 50)
returns table (
  event_id       bigint,
  kind           text,
  actor          text,
  occurred_at    timestamptz,
  booking_id     uuid,
  barber_id      uuid,
  barber_slug    text,
  barber_name    text,
  customer_name  text,
  booking_date   date,
  booking_time   time,
  service_name   text,
  is_unread      boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_seen timestamptz;
begin
  select c.activity_seen_at into v_seen from app_caller() c;
  if not found then
    return;
  end if;

  return query
  select e.id, e.kind, e.actor, e.occurred_at, e.booking_id, e.barber_id,
         b.slug, b.display_name, bk.customer_name, bk.booking_date, bk.booking_time,
         s.display_name,
         e.occurred_at > v_seen and e.actor_user_id is distinct from auth.uid()
    from booking_events e
    join bookings bk on bk.id = e.booking_id
    join barbers  b  on b.id  = e.barber_id
    join services s  on s.id  = bk.service_id
   where e.barber_id in (select vb.id from barbers vb where app_can_view(vb.id))
     and (p_before is null or e.id < p_before)
   order by e.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

create or replace function app_mark_activity_seen()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update staff s set activity_seen_at = now()
   where s.user_id in (select c.user_id from app_caller() c);
end;
$$;

create or replace function app_days_off(p_barber_id uuid)
returns table (closure_date date, reason text, bookings_that_day int)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not app_can_view(p_barber_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select c.closure_date, c.reason,
         (select count(*)::int from bookings bk
           where bk.barber_id = c.barber_id and bk.booking_date = c.closure_date
             and bk.linked_to is null and bk.status in ('pending', 'confirmed'))
    from barber_closures c
   where c.barber_id = p_barber_id
     and c.closure_date >= current_date
   order by c.closure_date;
end;
$$;

create or replace function app_add_day_off(p_barber_id uuid, p_date date, p_reason text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app_can_manage(p_barber_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_date is null or p_date < current_date then
    raise exception 'date_out_of_range' using errcode = '22023';
  end if;

  insert into barber_closures (barber_id, closure_date, reason)
  values (p_barber_id, p_date, nullif(trim(coalesce(p_reason, '')), ''))
  on conflict (barber_id, closure_date) do update set reason = excluded.reason;

  return (select count(*)::int from bookings bk
           where bk.barber_id = p_barber_id and bk.booking_date = p_date
             and bk.linked_to is null and bk.status in ('pending', 'confirmed'));
end;
$$;

create or replace function app_remove_day_off(p_barber_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app_can_manage(p_barber_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from barber_closures c where c.barber_id = p_barber_id and c.closure_date = p_date;
end;
$$;

create or replace function app_set_notify_prefs(p_bookings boolean, p_cancellations boolean, p_viewed_chairs boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update staff s
     set notify_bookings      = coalesce(p_bookings, s.notify_bookings),
         notify_cancellations = coalesce(p_cancellations, s.notify_cancellations),
         notify_viewed_chairs = coalesce(p_viewed_chairs, s.notify_viewed_chairs)
   where s.user_id in (select c.user_id from app_caller() c);
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- A token registered again (same phone, another login) moves to the new user.
create or replace function app_register_device(p_token text, p_environment text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from app_caller()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_environment is null or p_environment not in ('sandbox', 'production') then
    raise exception 'invalid_environment' using errcode = '22023';
  end if;
  if p_token is null or length(trim(p_token)) not between 1 and 200 then
    raise exception 'invalid_token' using errcode = '22023';
  end if;

  insert into device_tokens (token, user_id, environment, updated_at)
  values (trim(p_token), auth.uid(), p_environment, now())
  on conflict (token) do update
    set user_id = excluded.user_id, environment = excluded.environment, updated_at = now();
end;
$$;

create or replace function app_unregister_device(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from device_tokens d where d.token = trim(p_token) and d.user_id = auth.uid();
end;
$$;

create or replace function app_password_changed()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update staff s set must_change_password = false
   where s.user_id in (select c.user_id from app_caller() c);
end;
$$;

revoke execute on function app_me()                                       from public, anon;
revoke execute on function app_bookings(uuid, date, date)                 from public, anon;
revoke execute on function app_free_slots(uuid, date)                     from public, anon;
revoke execute on function app_book(uuid, text, date, time, text, text, text[], text) from public, anon;
revoke execute on function app_cancel_booking(uuid)                       from public, anon;
revoke execute on function app_set_status(uuid, text)                     from public, anon;
revoke execute on function app_activity(bigint, int)                      from public, anon;
revoke execute on function app_mark_activity_seen()                       from public, anon;
revoke execute on function app_days_off(uuid)                             from public, anon;
revoke execute on function app_add_day_off(uuid, date, text)              from public, anon;
revoke execute on function app_remove_day_off(uuid, date)                 from public, anon;
revoke execute on function app_set_notify_prefs(boolean, boolean, boolean) from public, anon;
revoke execute on function app_register_device(text, text)                from public, anon;
revoke execute on function app_unregister_device(text)                    from public, anon;
revoke execute on function app_password_changed()                         from public, anon;

grant execute on function app_me()                                       to authenticated;
grant execute on function app_bookings(uuid, date, date)                 to authenticated;
grant execute on function app_free_slots(uuid, date)                     to authenticated;
grant execute on function app_book(uuid, text, date, time, text, text, text[], text) to authenticated;
grant execute on function app_cancel_booking(uuid)                       to authenticated;
grant execute on function app_set_status(uuid, text)                     to authenticated;
grant execute on function app_activity(bigint, int)                      to authenticated;
grant execute on function app_mark_activity_seen()                       to authenticated;
grant execute on function app_days_off(uuid)                             to authenticated;
grant execute on function app_add_day_off(uuid, date, text)              to authenticated;
grant execute on function app_remove_day_off(uuid, date)                 to authenticated;
grant execute on function app_set_notify_prefs(boolean, boolean, boolean) to authenticated;
grant execute on function app_register_device(text, text)                to authenticated;
grant execute on function app_unregister_device(text)                    to authenticated;
grant execute on function app_password_changed()                         to authenticated;

-- =============================================================================
-- 9. Manager RPCs (authenticated; forbidden unless app_is_manager())
-- =============================================================================

create or replace function manager_staff()
returns table (
  user_id          uuid,
  email            text,
  role             text,
  display_name     text,
  barber_id        uuid,
  last_sign_in_at  timestamptz,
  is_disabled      boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not app_is_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select s.user_id, u.email::text, s.role, s.display_name, s.barber_id,
         u.last_sign_in_at, coalesce(u.banned_until > now(), false)
    from staff s
    join auth.users u on u.id = s.user_id
   order by (s.role = 'manager') desc, s.display_name;
end;
$$;

-- Slugs are the site's plain booking links (/<slug>), so they cannot be one of
-- the site's own top-level paths.
create or replace function manager_save_barber(
  p_id            uuid,
  p_slug          text,
  p_display_name  text,
  p_title         text,
  p_bio           text,
  p_photo_url     text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_name text := trim(coalesce(p_display_name, ''));
  v_old  barbers%rowtype;
  v_id   uuid;
begin
  if not app_is_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_slug !~ '^[a-z0-9-]{2,30}$' then
    raise exception 'invalid_slug' using errcode = '22023';
  end if;
  if v_slug = any(array['assets', 'docs', 'ios', 'scripts', 'styles', 'supabase',
                        'tests', 'tools', 'index', 'robots', 'sitemap', 'manifest', 'sw']) then
    raise exception 'slug_reserved' using errcode = '22023';
  end if;
  if length(v_name) not between 1 and 40 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  begin
    if p_id is null then
      insert into barbers (slug, display_name, title, bio, photo_url, sort_order)
      values (v_slug, v_name,
              nullif(trim(coalesce(p_title, '')), ''),
              nullif(trim(coalesce(p_bio, '')), ''),
              nullif(trim(coalesce(p_photo_url, '')), ''),
              (select coalesce(max(b.sort_order), 0) + 10 from barbers b))
      returning id into v_id;
    else
      select * into v_old from barbers b where b.id = p_id;
      if not found then
        raise exception 'barber_not_found' using errcode = 'P0002';
      end if;
      if v_old.slug <> v_slug and exists (select 1 from bookings bk where bk.barber_id = p_id) then
        raise exception 'slug_locked' using errcode = '22023';
      end if;
      update barbers b
         set slug         = v_slug,
             display_name = v_name,
             title        = nullif(trim(coalesce(p_title, '')), ''),
             bio          = nullif(trim(coalesce(p_bio, '')), ''),
             photo_url    = nullif(trim(coalesce(p_photo_url, '')), '')
       where b.id = p_id;
      v_id := p_id;
    end if;
  exception when unique_violation then
    raise exception 'slug_taken' using errcode = '22023';
  end;

  return v_id;
end;
$$;

-- p_days: [{weekday 0-6, open "HH:MM", close "HH:MM"}], one entry per working
-- day; it replaces the barber's whole week. Each day must sit inside that
-- weekday's store hours (a weekday the store is closed has none). Returns how
-- many upcoming bookings the new week leaves stranded: on a day it no longer
-- works, outside its hours, or off its 45-minute grid. They stay booked (no new
-- booking can overlap them); the app warns.
drop function if exists manager_set_schedule(uuid, jsonb);
create function manager_set_schedule(p_barber_id uuid, p_days jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day    jsonb;
  v_wd     int;
  v_open   time;
  v_close  time;
  v_seen   int[] := '{}'::int[];
begin
  if not app_is_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from barbers b where b.id = p_barber_id) then
    raise exception 'barber_not_found' using errcode = 'P0002';
  end if;
  if p_days is null or jsonb_typeof(p_days) <> 'array' then
    raise exception 'invalid_schedule' using errcode = '22023';
  end if;

  delete from barber_schedules s where s.barber_id = p_barber_id;

  for v_day in select value from jsonb_array_elements(p_days) loop
    if jsonb_typeof(v_day) <> 'object'
       or coalesce(v_day ->> 'weekday', '') !~ '^[0-6]$'
       or coalesce(v_day ->> 'open',  '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$'
       or coalesce(v_day ->> 'close', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' then
      raise exception 'invalid_schedule' using errcode = '22023';
    end if;
    v_wd    := (v_day ->> 'weekday')::int;
    v_open  := (v_day ->> 'open')::time;
    v_close := (v_day ->> 'close')::time;
    if v_wd = any(v_seen) or v_open >= v_close then
      raise exception 'invalid_schedule' using errcode = '22023';
    end if;
    v_seen := v_seen || v_wd;

    if not exists (
      select 1 from store_hours h
       where h.weekday = v_wd and v_open >= h.open_time and v_close <= h.close_time
    ) then
      raise exception 'outside_store_hours' using errcode = '22023';
    end if;

    insert into barber_schedules (barber_id, weekday, open_time, close_time, slot_minutes)
    values (p_barber_id, v_wd, v_open, v_close, 45);
  end loop;

  return (
    select count(distinct coalesce(bk.linked_to, bk.id))::int
      from bookings bk
      left join barber_schedules s
        on s.barber_id = bk.barber_id
       and s.weekday   = extract(dow from bk.booking_date)::smallint
     where bk.barber_id = p_barber_id
       and bk.status in ('pending', 'confirmed', 'completed')
       and bk.slot_at >= now()
       and (s.barber_id is null
            or bk.booking_time <  s.open_time
            or bk.booking_time >= s.close_time
            or (extract(epoch from bk.booking_time - s.open_time)::int / 60) % s.slot_minutes <> 0));
end;
$$;

-- Returns the chair's upcoming bookings, which deactivating leaves in place.
create or replace function manager_set_active(p_barber_id uuid, p_active boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app_is_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update barbers b set is_active = coalesce(p_active, b.is_active) where b.id = p_barber_id;
  if not found then
    raise exception 'barber_not_found' using errcode = 'P0002';
  end if;

  return (select count(*)::int from bookings bk
           where bk.barber_id = p_barber_id and bk.linked_to is null
             and bk.status in ('pending', 'confirmed') and bk.slot_at >= now());
end;
$$;

create or replace function manager_set_view_grant(p_viewer_barber_id uuid, p_barber_id uuid, p_granted boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app_is_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_viewer_barber_id is not distinct from p_barber_id then
    raise exception 'invalid_grant' using errcode = '22023';
  end if;
  if (select count(*) from barbers b where b.id in (p_viewer_barber_id, p_barber_id)) <> 2 then
    raise exception 'barber_not_found' using errcode = 'P0002';
  end if;

  if p_granted then
    insert into barber_view_grants (viewer_barber_id, barber_id)
    values (p_viewer_barber_id, p_barber_id)
    on conflict do nothing;
  else
    delete from barber_view_grants g
     where g.viewer_barber_id = p_viewer_barber_id and g.barber_id = p_barber_id;
  end if;
end;
$$;

create or replace function manager_barber_schedule(p_barber_id uuid)
returns table (weekday int, open_time time, close_time time)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not app_is_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select s.weekday::int, s.open_time, s.close_time
    from barber_schedules s
   where s.barber_id = p_barber_id
   order by s.weekday;
end;
$$;

revoke execute on function manager_staff()                                        from public, anon;
revoke execute on function manager_save_barber(uuid, text, text, text, text, text) from public, anon;
revoke execute on function manager_set_schedule(uuid, jsonb)                      from public, anon;
revoke execute on function manager_set_active(uuid, boolean)                      from public, anon;
revoke execute on function manager_set_view_grant(uuid, uuid, boolean)            from public, anon;
revoke execute on function manager_barber_schedule(uuid)                          from public, anon;

grant execute on function manager_staff()                                        to authenticated;
grant execute on function manager_save_barber(uuid, text, text, text, text, text) to authenticated;
grant execute on function manager_set_schedule(uuid, jsonb)                      to authenticated;
grant execute on function manager_set_active(uuid, boolean)                      to authenticated;
grant execute on function manager_set_view_grant(uuid, uuid, boolean)            to authenticated;
grant execute on function manager_barber_schedule(uuid)                          to authenticated;

-- =============================================================================
-- 10. Storage: barber-photos (public read, manager writes)
--
-- Guarded so a database without the storage schema (a bare Postgres) still
-- applies the migration.
-- =============================================================================

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'storage schema not present: barber-photos bucket not created';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('barber-photos', 'barber-photos', true)
  on conflict (id) do update set public = true;

  execute 'drop policy if exists "managers add barber photos" on storage.objects';
  execute 'drop policy if exists "managers change barber photos" on storage.objects';
  execute 'drop policy if exists "managers delete barber photos" on storage.objects';
  execute 'drop policy if exists "managers list barber photos" on storage.objects';
  execute $p$create policy "managers add barber photos" on storage.objects
             for insert to authenticated
             with check (bucket_id = 'barber-photos' and public.app_is_manager())$p$;
  execute $p$create policy "managers change barber photos" on storage.objects
             for update to authenticated
             using (bucket_id = 'barber-photos' and public.app_is_manager())
             with check (bucket_id = 'barber-photos' and public.app_is_manager())$p$;
  execute $p$create policy "managers delete barber photos" on storage.objects
             for delete to authenticated
             using (bucket_id = 'barber-photos' and public.app_is_manager())$p$;
  execute $p$create policy "managers list barber photos" on storage.objects
             for select to authenticated
             using (bucket_id = 'barber-photos' and public.app_is_manager())$p$;
end
$$;

-- =============================================================================
-- DONE. Manual verification:
--
--   select slug, title from barbers order by sort_order;
--   -- hassan Master Barber · javier (null, inactive) · larry Barber
--
--   select v.slug as viewer, b.slug as chair
--     from barber_view_grants g
--     join barbers v on v.id = g.viewer_barber_id
--     join barbers b on b.id = g.barber_id;
--   -- hassan → larry
--
--   select kind, actor, occurred_at from booking_events order by id desc limit 5;
-- =============================================================================
