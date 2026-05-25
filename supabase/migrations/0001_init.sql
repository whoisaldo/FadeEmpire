-- FadeEmpire — 0001_init.sql
-- Atomic, race-proof booking schema for a single barbershop.
--
-- Run this once in the Supabase SQL editor for project mjehfaonibgobimfiijk.
-- Idempotent where reasonable (`if not exists`), but starts from a clean slate —
-- drop the old `bookings` table first if it already exists with a different shape.
--
-- The critical mechanism: a SECURITY DEFINER RPC `book_slot()` that does the
-- INSERT under a partial unique index. Two concurrent calls for the same
-- (barber, date, time) resolve to exactly one success and one slot_taken error.

-- =============================================================================
-- 0. Clean slate (run with care — only on initial setup)
-- =============================================================================

drop view  if exists v_slot_availability cascade;
drop table if exists bookings           cascade;
drop type  if exists booking_status     cascade;
drop table if exists barber_closures    cascade;
drop table if exists barber_schedules   cascade;
drop table if exists service_addons     cascade;
drop table if exists addons             cascade;
drop table if exists services           cascade;
drop table if exists barbers            cascade;

-- =============================================================================
-- 1. Extensions
-- =============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_cron";    -- scheduled hold cleanup

-- =============================================================================
-- 2. Reference tables (public read, owner write via service_role / Studio)
-- =============================================================================

create table barbers (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  display_name  text not null,
  bio           text,
  photo_url     text,
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);

create table services (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique not null,
  display_name      text not null,
  base_price_cents  int  not null,
  duration_minutes  int  not null default 30,
  is_active         boolean not null default true,
  sort_order        int  not null default 0,
  created_at        timestamptz not null default now()
);

create table addons (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  display_name  text not null,
  price_cents   int  not null,
  is_active     boolean not null default true,
  sort_order    int  not null default 0
);

-- Working hours: one row per (barber, weekday).
create table barber_schedules (
  id            uuid primary key default gen_random_uuid(),
  barber_id     uuid not null references barbers(id) on delete cascade,
  weekday       smallint not null check (weekday between 0 and 6),  -- 0=Sun
  open_time     time not null,
  close_time    time not null,
  slot_minutes  smallint not null default 30,
  unique (barber_id, weekday)
);

-- One-off closures (holidays, sick days).
create table barber_closures (
  id            uuid primary key default gen_random_uuid(),
  barber_id     uuid not null references barbers(id) on delete cascade,
  closure_date  date not null,
  reason        text,
  unique (barber_id, closure_date)
);

-- =============================================================================
-- 3. Bookings (the only table with PII — locked down via RLS)
-- =============================================================================

create type booking_status as enum (
  'pending',    -- created, slot held, awaiting owner confirmation
  'confirmed',  -- owner confirmed via WhatsApp/SMS
  'completed',  -- chair time done
  'cancelled',  -- customer or owner cancelled
  'no_show',    -- customer didn't show
  'expired'     -- pending hold ran past TTL
);

create table bookings (
  id              uuid primary key default gen_random_uuid(),
  barber_id       uuid not null references barbers(id),
  service_id      uuid not null references services(id),

  booking_date    date not null,
  booking_time    time not null,
  slot_at         timestamptz generated always as
                    ((booking_date::timestamp + booking_time)
                     at time zone 'America/New_York') stored,

  customer_name   text not null,
  customer_phone  text not null,    -- digits-only, enforced below
  customer_notes  text,
  selected_addons text[] not null default '{}',
  custom_request  text,

  total_price_cents int not null,   -- snapshot at booking time

  status          booking_status not null default 'pending',
  hold_expires_at timestamptz,
  cancelled_at    timestamptz,
  cancelled_by    text,             -- 'customer' | 'owner' | 'system'

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  source          text not null default 'web',  -- 'web' | 'mobile' | 'walk_in' | 'phone'

  constraint phone_digits_only
    check (customer_phone ~ '^[0-9]{10,15}$'),
  constraint name_not_blank
    check (length(trim(customer_name)) > 0),
  constraint hold_only_when_pending
    check ((status = 'pending' and hold_expires_at is not null)
        or (status <> 'pending' and hold_expires_at is null))
);

-- THE constraint that makes double-booking impossible at the DB level.
-- Two concurrent inserts for the same active slot — one wins, the other raises
-- unique_violation (SQLSTATE 23505), which book_slot() converts to slot_taken.
-- Cancelled/expired/no_show rows don't occupy the slot.
create unique index bookings_active_slot_uidx
  on bookings (barber_id, booking_date, booking_time)
  where status in ('pending', 'confirmed', 'completed');

-- Hot query: "all bookings for this barber on this day"
create index bookings_barber_date_idx
  on bookings (barber_id, booking_date)
  where status in ('pending', 'confirmed');

-- Cleanup query: "expired pending holds"
create index bookings_hold_expiry_idx
  on bookings (hold_expires_at)
  where status = 'pending';

-- updated_at trigger
create or replace function tg_set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists bookings_updated_at on bookings;
create trigger bookings_updated_at
  before update on bookings
  for each row execute procedure tg_set_updated_at();

-- =============================================================================
-- 4. Row-Level Security
--
-- Threat model: the anon key is a public string baked into client JS. Assume
-- an adversary can do anything the anon role is allowed to do.
-- =============================================================================

-- Lock bookings entirely from anon. The RPC bypasses RLS via SECURITY DEFINER.
alter table bookings enable row level security;

-- Reference tables: public read-only
alter table barbers          enable row level security;
alter table services         enable row level security;
alter table addons           enable row level security;
alter table barber_schedules enable row level security;
alter table barber_closures  enable row level security;

drop policy if exists "public read barbers"  on barbers;
drop policy if exists "public read services" on services;
drop policy if exists "public read addons"   on addons;
drop policy if exists "public read schedules" on barber_schedules;
drop policy if exists "public read closures" on barber_closures;

create policy "public read barbers"  on barbers
  for select to anon, authenticated using (is_active = true);

create policy "public read services" on services
  for select to anon, authenticated using (is_active = true);

create policy "public read addons"   on addons
  for select to anon, authenticated using (is_active = true);

create policy "public read schedules" on barber_schedules
  for select to anon, authenticated using (true);

create policy "public read closures" on barber_closures
  for select to anon, authenticated using (true);

-- =============================================================================
-- 5. PII-free availability view
--
-- This is what the client polls to render the time-grid. It exposes only
-- (barber, date, time, status) for active bookings in the next 60 days.
-- No names, no phones, no notes.
-- =============================================================================

create or replace view v_slot_availability
with (security_invoker = true) as
select
  b.id          as barber_id,
  b.slug        as barber_slug,
  bk.booking_date,
  bk.booking_time,
  bk.status
from barbers b
join bookings bk on bk.barber_id = b.id
where bk.status in ('pending', 'confirmed')
  and bk.booking_date between current_date
                          and current_date + interval '60 days';

grant select on v_slot_availability to anon, authenticated;

-- =============================================================================
-- 6. book_slot() — atomic, race-proof booking RPC
-- =============================================================================

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
  p_hold_minutes   int      default 15
)
returns table (
  booking_id        uuid,
  status            booking_status,
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
  v_addon_total  int := 0;
  v_total        int;
  v_new_id       uuid;
  v_hold_expires timestamptz;
  v_phone_clean  text;
begin
  -- 1. Sanitize phone to digits only
  v_phone_clean := regexp_replace(coalesce(p_customer_phone, ''), '\D', '', 'g');
  if length(v_phone_clean) < 10 then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  -- 2. Validate name
  if length(trim(coalesce(p_customer_name, ''))) < 2 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- 3. Load barber & service (must be active)
  select * into v_barber from barbers
    where slug = p_barber_slug and is_active = true;
  if not found then
    raise exception 'barber_not_found' using errcode = 'P0002';
  end if;

  select * into v_service from services
    where slug = p_service_slug and is_active = true;
  if not found then
    raise exception 'service_not_found' using errcode = 'P0002';
  end if;

  -- 4. Date must be today or future, max 60 days out
  if p_date < current_date or p_date > current_date + interval '60 days' then
    raise exception 'date_out_of_range' using errcode = '22023';
  end if;

  -- 5. Barber must work that weekday at that time
  if not exists (
    select 1 from barber_schedules
    where barber_id = v_barber.id
      and weekday   = extract(dow from p_date)::smallint
      and p_time   >= open_time
      and p_time   <  close_time
  ) then
    raise exception 'outside_working_hours' using errcode = '22023';
  end if;

  -- 6. Not on a one-off closure day
  if exists (
    select 1 from barber_closures
    where barber_id = v_barber.id and closure_date = p_date
  ) then
    raise exception 'barber_closed' using errcode = '22023';
  end if;

  -- 7. Slot must be on a 30-minute boundary
  if extract(minute from p_time)::int not in (0, 30)
     or extract(second from p_time)::int <> 0 then
    raise exception 'invalid_slot_alignment' using errcode = '22023';
  end if;

  -- 8. Compute addon total from DB-side prices (NEVER trust client price)
  if array_length(p_addon_slugs, 1) > 0 then
    select coalesce(sum(price_cents), 0) into v_addon_total
      from addons
     where slug = any(p_addon_slugs) and is_active = true;
  end if;

  v_total := v_service.base_price_cents + v_addon_total;

  -- 9. Per-phone rate limit: max 3 active future holds (anti-spam)
  if (
    select count(*) from bookings
     where customer_phone = v_phone_clean
       and status in ('pending', 'confirmed')
       and slot_at >= now()
  ) >= 3 then
    raise exception 'too_many_active_bookings' using errcode = '23505';
  end if;

  v_hold_expires := now() + make_interval(mins => greatest(p_hold_minutes, 5));
  v_new_id       := gen_random_uuid();

  -- 10. THE atomic INSERT. The partial unique index makes this race-proof.
  begin
    insert into bookings (
      id, barber_id, service_id, booking_date, booking_time,
      customer_name, customer_phone, customer_notes,
      selected_addons, custom_request,
      total_price_cents, status, hold_expires_at, source
    ) values (
      v_new_id, v_barber.id, v_service.id, p_date, p_time,
      trim(p_customer_name), v_phone_clean,
      nullif(trim(coalesce(p_notes, '')), ''),
      coalesce(p_addon_slugs, '{}'),
      nullif(trim(coalesce(p_custom_request, '')), ''),
      v_total, 'pending', v_hold_expires, coalesce(p_source, 'web')
    );
  exception
    when unique_violation then
      raise exception 'slot_taken' using errcode = '23505';
  end;

  return query
    select v_new_id, 'pending'::booking_status, v_hold_expires, v_total;
end;
$$;

revoke all on function book_slot(text, text, date, time, text, text, text[], text, text, text, int) from public;
grant execute on function book_slot(text, text, date, time, text, text, text[], text, text, text, int)
  to anon, authenticated;

-- =============================================================================
-- 7. confirm_booking() — owner-side, flips pending → confirmed
-- =============================================================================

create or replace function confirm_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update bookings
     set status = 'confirmed',
         hold_expires_at = null
   where id = p_booking_id
     and status = 'pending';

  if not found then
    raise exception 'booking_not_pending' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function confirm_booking(uuid) from public;
grant execute on function confirm_booking(uuid) to authenticated;
-- Intentionally NOT granted to anon — only an authenticated owner can confirm.

-- =============================================================================
-- 8. cancel_booking() — customer-side, phone acts as cheap auth
-- =============================================================================

create or replace function cancel_booking(p_booking_id uuid, p_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone_clean text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  update bookings
     set status          = 'cancelled',
         cancelled_at    = now(),
         cancelled_by    = 'customer',
         hold_expires_at = null
   where id              = p_booking_id
     and customer_phone  = v_phone_clean
     and status in ('pending', 'confirmed');

  if not found then
    raise exception 'cannot_cancel' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function cancel_booking(uuid, text) from public;
grant execute on function cancel_booking(uuid, text) to anon, authenticated;

-- =============================================================================
-- 9. expire_pending_holds() — scheduled cleanup
-- =============================================================================

create or replace function expire_pending_holds()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update bookings
     set status = 'expired',
         hold_expires_at = null
   where status = 'pending'
     and hold_expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function expire_pending_holds() from public;
-- Not granted to anon — only the cron job (running as superuser) calls this.

-- Run every 2 minutes. pg_cron is free on Supabase.
-- Unschedule first in case this migration is re-run.
do $$
declare
  v_job_id int;
begin
  select jobid into v_job_id from cron.job where jobname = 'expire-holds';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
end;
$$;

select cron.schedule(
  'expire-holds',
  '*/2 * * * *',
  $$ select expire_pending_holds(); $$
);

-- =============================================================================
-- 10. Seed data
-- =============================================================================

-- Hassan — the one barber
insert into barbers (slug, display_name, bio, sort_order)
values (
  'hassan',
  'Hassan',
  'Master barber. Licensed. Originally from Lebanon, cutting in Chicopee since 2018.',
  0
);

-- Services (prices in cents)
insert into services (slug, display_name, base_price_cents, duration_minutes, sort_order) values
  ('hair-cut',     'Hair Cut',     3000, 30, 10),
  ('line-up',      'Line Up',      1000, 30, 20),
  ('beard-trim',   'Beard Trim',   1000, 30, 30),
  ('kids-cut',     'Kids Cut',     2500, 30, 40),
  ('military-cut', 'Military Cut', 2500, 30, 50),
  ('senior-cut',   'Senior Cut',   2500, 30, 60),
  ('vip-haircut',  'VIP Haircut',  6000, 60, 70);

-- Addons (prices in cents; 0 = complimentary)
insert into addons (slug, display_name, price_cents, sort_order) values
  ('eyebrows',  'Eyebrows',    0, 10),
  ('hot-towel', 'Hot Towel',  500, 20),
  ('facial',    'Facial',    2000, 30),
  ('wax',       'Wax',        500, 40);

-- Hassan's working hours: Monday–Saturday, 10:00 AM – 5:30 PM.
-- Sunday is closed (no row = closed for that weekday).
insert into barber_schedules (barber_id, weekday, open_time, close_time)
select id, weekday, '10:00:00'::time, '17:30:00'::time
from barbers, generate_series(1, 6) as weekday  -- 1=Mon ... 6=Sat
where slug = 'hassan';

-- =============================================================================
-- DONE.
--
-- Manual verification:
--
--   select * from book_slot(
--     'hassan', 'hair-cut', current_date + 1, '14:00:00',
--     'Test Customer', '5551234567'
--   );
--   -- Returns one row with booking_id, status='pending', hold_expires_at, total_price_cents=3000
--
--   select * from book_slot(
--     'hassan', 'hair-cut', current_date + 1, '14:00:00',
--     'Other Customer', '5559876543'
--   );
--   -- Raises: slot_taken
--
--   select * from v_slot_availability where barber_slug = 'hassan';
--   -- Shows one row (booking_time = '14:00:00', status = 'pending'); NO PII.
--
-- =============================================================================
