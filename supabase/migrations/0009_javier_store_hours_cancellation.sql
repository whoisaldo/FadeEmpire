-- 0009_javier_store_hours_cancellation.sql
--
-- Four changes:
--   1. STORE HOURS as a first-class table. The shop itself is open Mon–Sat
--      9:00 AM – 6:00 PM and closed Sundays. Every bookable slot must fit the
--      store hours FIRST, then the barber's own schedule. Both book_slot and
--      book_slot_group validate against both tables (defense in depth — the
--      seeded barber schedules already fall inside store hours, but a future
--      schedule edit can never leak a booking outside store hours).
--   2. SECOND BARBER: Javier. Works Mon–Sat 9:00–6:00 (off Sundays = store
--      closure). Hassan's schedule changes to 10:00–6:00, off Tuesdays.
--   3. book_slot_group becomes DURATION-AWARE. Previously every person in a
--      group occupied exactly one 30-min slot, so a VIP (60 min) in a group
--      overlapped the next guest's chair time. Now each person occupies
--      ceil(duration/30) consecutive slots (continuation rows linked_to their
--      primary row), and the next person starts after the previous one ends.
--   4. CUSTOMER CANCELLATION LOOKUP: find_bookings_by_phone(p_phone) lets a
--      customer list their own upcoming bookings using their phone number as
--      cheap auth, so the site can offer a cancel button. cancel_booking()
--      (from 0006) already frees the slot atomically — a cancelled row drops
--      out of the partial unique index, reopening the slot.
--
-- Run once in the Supabase SQL editor (or psql) for project mjehfaonibgobimfiijk.
-- Idempotent: tables use IF NOT EXISTS + upserts, functions use CREATE OR REPLACE.

-- =============================================================================
-- 1. store_hours — the shop's opening hours, one row per open weekday
-- =============================================================================

create table if not exists store_hours (
  id          uuid primary key default gen_random_uuid(),
  weekday     smallint not null unique check (weekday between 0 and 6),  -- 0=Sun
  open_time   time not null,
  close_time  time not null,
  check (open_time < close_time)
);

alter table store_hours enable row level security;

drop policy if exists "public read store hours" on store_hours;
create policy "public read store hours" on store_hours
  for select to anon, authenticated using (true);

-- Mon–Sat 9:00–18:00. Sunday has no row = closed.
insert into store_hours (weekday, open_time, close_time)
select w, '09:00:00'::time, '18:00:00'::time
from generate_series(1, 6) as w
on conflict (weekday)
  do update set open_time = excluded.open_time, close_time = excluded.close_time;

delete from store_hours where weekday = 0;

-- =============================================================================
-- 2. Barbers + schedules
-- =============================================================================

-- Javier — second chair.
insert into barbers (slug, display_name, bio, photo_url, sort_order)
values (
  'javier',
  'Javier',
  'Barber. Clean tapers, sharp lineups, classic scissor work. In the shop Monday through Saturday.',
  './assets/Barbers/Javier/optimized/JavierBarber_tablet.jpg',
  10
)
on conflict (slug) do update set
  display_name = excluded.display_name,
  photo_url    = excluded.photo_url,
  is_active    = true,
  sort_order   = excluded.sort_order;

-- Rebuild both barbers' weekly schedules from scratch (idempotent).
--   Hassan: 10:00–18:00, off Tuesdays (and Sundays — store closed).
--   Javier: 09:00–18:00, off Sundays (store closed anyway).
delete from barber_schedules
 where barber_id in (select id from barbers where slug in ('hassan', 'javier'));

insert into barber_schedules (barber_id, weekday, open_time, close_time)
select b.id, w, '10:00:00'::time, '18:00:00'::time
  from barbers b, unnest(array[1, 3, 4, 5, 6]) as w   -- Mon, Wed, Thu, Fri, Sat
 where b.slug = 'hassan';

insert into barber_schedules (barber_id, weekday, open_time, close_time)
select b.id, w, '09:00:00'::time, '18:00:00'::time
  from barbers b, generate_series(1, 6) as w          -- Mon … Sat
 where b.slug = 'javier';

-- NOTE for the owner: bookings made under the old "7 days, 10–6" hours may now
-- fall outside the new hours (Sundays, or Tuesdays for Hassan). They are NOT
-- auto-cancelled — review them and call the customers:
--
--   select bk.booking_date, bk.booking_time, bk.customer_name, bk.customer_phone,
--          b.display_name as barber
--     from bookings bk join barbers b on b.id = bk.barber_id
--    where bk.status in ('pending', 'confirmed')
--      and bk.booking_date >= current_date
--      and (extract(dow from bk.booking_date) = 0
--           or (b.slug = 'hassan' and extract(dow from bk.booking_date) = 2))
--    order by bk.booking_date, bk.booking_time;

-- =============================================================================
-- 3. Store-hours guard used by both booking RPCs
-- =============================================================================

create or replace function is_within_store_hours(p_date date, p_time time)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from store_hours h
     where h.weekday = extract(dow from p_date)::smallint
       and p_time   >= h.open_time
       and p_time   <  h.close_time
  );
$$;

-- =============================================================================
-- 4. book_slot — adds the store-hours check (otherwise identical to 0007)
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
  v_addon_total  int := 0;
  v_total        int;
  v_primary_id   uuid;
  v_link_id      uuid;
  v_phone_clean  text;
  v_slot_count   int;
  v_idx          int;
  v_slot_time    time;
  v_slot_min     int;
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
   where barbers.slug = p_barber_slug and barbers.is_active = true;
  if not found then raise exception 'barber_not_found' using errcode = 'P0002'; end if;

  select * into v_service from services
   where services.slug = p_service_slug and services.is_active = true;
  if not found then raise exception 'service_not_found' using errcode = 'P0002'; end if;

  if p_date < current_date or p_date > current_date + interval '60 days' then
    raise exception 'date_out_of_range' using errcode = '22023';
  end if;

  if extract(minute from p_time)::int not in (0, 30)
     or extract(second from p_time)::int <> 0 then
    raise exception 'invalid_slot_alignment' using errcode = '22023';
  end if;

  -- Service duration drives slot count. 30-min slot, ceil division. min 1.
  v_slot_count := greatest(1, ceil(v_service.duration_minutes::numeric / 30)::int);
  v_slot_min   := extract(hour from p_time)::int * 60
                + extract(minute from p_time)::int;

  -- Validate every slot: store hours FIRST, then the barber's schedule + closures.
  for v_idx in 0 .. v_slot_count - 1 loop
    v_slot_time := make_time((v_slot_min + v_idx * 30) / 60,
                             (v_slot_min + v_idx * 30) % 60, 0);

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
  if (
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
    v_slot_time := make_time((v_slot_min + v_idx * 30) / 60,
                             (v_slot_min + v_idx * 30) % 60, 0);

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
        total_price_cents, status, hold_expires_at, source, linked_to
      ) values (
        case when v_idx = 0 then v_primary_id else gen_random_uuid() end,
        v_barber.id, v_service.id, p_date, v_slot_time,
        trim(p_customer_name), v_phone_clean,
        v_notes_clean,
        case when v_idx = 0 then v_addons_clean else '{}'::text[] end,
        case when v_idx = 0 then v_custom_clean else null end,
        case when v_idx = 0 then v_total else 0 end,         -- snapshot price only on primary
        'confirmed', null, coalesce(p_source, 'web'),
        v_link_id
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

revoke all on function book_slot(text, text, date, time, text, text, text[], text, text, text, int) from public;
grant execute on function book_slot(text, text, date, time, text, text, text[], text, text, text, int)
  to anon, authenticated;

-- =============================================================================
-- 5. book_slot_group — store-hours check + duration-aware per-person slots
-- =============================================================================

create or replace function book_slot_group(
  p_barber_slug    text,
  p_date           date,
  p_start_time     time,
  p_customer_phone text,
  p_people         jsonb,
  p_hold_minutes   int     default 15,
  p_source         text    default 'web'
)
returns table (
  booking_id        uuid,
  person_index      int,
  person_name       text,
  service_slug      text,
  booking_time      time,
  total_price_cents int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_barber       barbers%rowtype;
  v_phone_clean  text;
  v_count        int;
  v_idx          int;
  v_person       jsonb;
  v_person_name  text;
  v_service_slug text;
  v_addon_slugs  text[];
  v_notes        text;
  v_custom       text;
  v_service      services%rowtype;
  v_addon_total  int;
  v_total        int;
  v_slot_time    time;
  v_cursor_min   int;          -- rolling start (minutes) for the next person
  v_person_min   int;          -- this person's start
  v_person_slots int;          -- slots this person's service occupies
  v_slot_idx     int;
  v_primary_id   uuid;
  v_total_slots  int := 0;
begin
  v_phone_clean := regexp_replace(coalesce(p_customer_phone, ''), '\D', '', 'g');
  if length(v_phone_clean) < 10 then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  if p_people is null or jsonb_typeof(p_people) <> 'array' then
    raise exception 'invalid_people' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_people);
  if v_count < 1 then raise exception 'invalid_people' using errcode = '22023'; end if;
  if v_count > 6 then raise exception 'too_many_people' using errcode = '22023'; end if;

  select * into v_barber from barbers
   where barbers.slug = p_barber_slug and barbers.is_active = true;
  if not found then raise exception 'barber_not_found' using errcode = 'P0002'; end if;

  if p_date < current_date or p_date > current_date + interval '60 days' then
    raise exception 'date_out_of_range' using errcode = '22023';
  end if;

  if extract(minute from p_start_time)::int not in (0, 30)
     or extract(second from p_start_time)::int <> 0 then
    raise exception 'invalid_slot_alignment' using errcode = '22023';
  end if;

  -- Pre-compute total slot count for the rate limit (duration-aware).
  for v_idx in 0 .. v_count - 1 loop
    v_service_slug := coalesce(p_people -> v_idx ->> 'service_slug', '');
    select * into v_service from services
      where services.slug = v_service_slug and services.is_active = true;
    if not found then raise exception 'service_not_found' using errcode = 'P0002'; end if;
    v_total_slots := v_total_slots
                   + greatest(1, ceil(v_service.duration_minutes::numeric / 30)::int);
  end loop;

  if (
    select count(*) from bookings b
      where b.customer_phone = v_phone_clean
        and b.status in ('pending', 'confirmed')
        and b.slot_at >= now()
  ) + v_total_slots > 6 then
    raise exception 'too_many_active_bookings' using errcode = '23505';
  end if;

  v_cursor_min := extract(hour from p_start_time)::int * 60
                + extract(minute from p_start_time)::int;

  for v_idx in 0 .. v_count - 1 loop
    v_person      := p_people -> v_idx;
    v_person_name := nullif(trim(coalesce(v_person ->> 'name', '')), '');
    v_service_slug:= coalesce(v_person ->> 'service_slug', '');
    v_notes       := nullif(trim(coalesce(v_person ->> 'notes', '')), '');
    v_custom      := nullif(trim(coalesce(v_person ->> 'custom_request', '')), '');

    if v_person ? 'addons' and jsonb_typeof(v_person -> 'addons') = 'array' then
      select coalesce(array_agg(value::text), '{}'::text[]) into v_addon_slugs
        from jsonb_array_elements_text(v_person -> 'addons');
    else
      v_addon_slugs := '{}';
    end if;
    v_addon_slugs := coalesce(v_addon_slugs, '{}'::text[]);

    if v_person_name is null or length(v_person_name) < 2 then
      raise exception 'invalid_name' using errcode = '22023';
    end if;

    select * into v_service from services
      where services.slug = v_service_slug and services.is_active = true;
    if not found then raise exception 'service_not_found' using errcode = 'P0002'; end if;

    v_person_slots := greatest(1, ceil(v_service.duration_minutes::numeric / 30)::int);
    v_person_min   := v_cursor_min;

    v_addon_total := 0;
    if array_length(v_addon_slugs, 1) > 0 then
      select coalesce(sum(a.price_cents), 0) into v_addon_total
        from addons a
       where a.slug = any(v_addon_slugs) and a.is_active = true;
    end if;
    v_total := v_service.base_price_cents + v_addon_total;

    v_primary_id := gen_random_uuid();

    for v_slot_idx in 0 .. v_person_slots - 1 loop
      v_slot_time := make_time((v_person_min + v_slot_idx * 30) / 60,
                               (v_person_min + v_slot_idx * 30) % 60, 0);

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

      begin
        insert into bookings (
          id, barber_id, service_id, booking_date, booking_time,
          customer_name, customer_phone, customer_notes,
          selected_addons, custom_request, total_price_cents,
          status, hold_expires_at, source, linked_to
        ) values (
          case when v_slot_idx = 0 then v_primary_id else gen_random_uuid() end,
          v_barber.id, v_service.id, p_date, v_slot_time,
          v_person_name, v_phone_clean,
          case when v_slot_idx = 0 then v_notes else null end,
          case when v_slot_idx = 0 then v_addon_slugs else '{}'::text[] end,
          case when v_slot_idx = 0 then v_custom else null end,
          case when v_slot_idx = 0 then v_total else 0 end,
          'confirmed', null, coalesce(p_source, 'web'),
          case when v_slot_idx = 0 then null else v_primary_id end
        );
      exception
        when unique_violation then
          raise exception 'slot_taken' using errcode = '23505',
            detail = format('Conflict on slot %s', v_slot_time);
      end;
    end loop;

    booking_id        := v_primary_id;
    person_index      := v_idx;
    person_name       := v_person_name;
    service_slug      := v_service_slug;
    booking_time      := make_time(v_person_min / 60, v_person_min % 60, 0);
    total_price_cents := v_total;
    return next;

    v_cursor_min := v_cursor_min + v_person_slots * 30;
  end loop;

  return;
end;
$$;

grant execute on function book_slot_group(text, date, time, text, jsonb, int, text)
  to anon, authenticated;

-- =============================================================================
-- 6. find_bookings_by_phone — customer-side lookup for the cancel flow
--
-- The phone number acts as cheap auth (same model as cancel_booking). Returns
-- only that phone's own upcoming active bookings, primaries only (continuation
-- rows of multi-slot services are hidden — cancelling the primary cascades).
-- First name only — the caller already knows who they are; keep PII minimal.
-- =============================================================================

create or replace function find_bookings_by_phone(p_phone text)
returns table (
  booking_id        uuid,
  barber_slug       text,
  barber_name       text,
  service_slug      text,
  service_name      text,
  first_name        text,
  booking_date      date,
  booking_time      time,
  duration_minutes  int,
  selected_addons   text[],
  total_price_cents int,
  booking_status    booking_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone_clean text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if length(v_phone_clean) < 10 then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  return query
  select
    bk.id,
    b.slug,
    b.display_name,
    s.slug,
    s.display_name,
    split_part(bk.customer_name, ' ', 1),
    bk.booking_date,
    bk.booking_time,
    s.duration_minutes,
    bk.selected_addons,
    bk.total_price_cents,
    bk.status
  from bookings bk
  join barbers  b on b.id = bk.barber_id
  join services s on s.id = bk.service_id
  where bk.customer_phone = v_phone_clean
    and bk.status in ('pending', 'confirmed')
    and bk.linked_to is null
    and bk.slot_at >= now() - interval '30 minutes'
  order by bk.booking_date, bk.booking_time
  limit 20;
end;
$$;

revoke all on function find_bookings_by_phone(text) from public;
grant execute on function find_bookings_by_phone(text) to anon, authenticated;

-- =============================================================================
-- DONE. Manual verification:
--
--   select * from store_hours order by weekday;
--   -- 6 rows: Mon–Sat 09:00–18:00
--
--   select b.slug, s.weekday, s.open_time, s.close_time
--     from barber_schedules s join barbers b on b.id = s.barber_id
--    order by b.slug, s.weekday;
--   -- hassan: 1,3,4,5,6 @ 10:00–18:00 · javier: 1..6 @ 09:00–18:00
--
--   select * from book_slot('javier', 'hair-cut', current_date + 1, '09:00:00',
--                           'Test Customer', '5551230000');
--   -- succeeds (Javier opens at 9) unless tomorrow is Sunday
--
--   select * from book_slot('hassan', 'hair-cut', current_date + 1, '09:00:00',
--                           'Test Customer', '5551230001');
--   -- raises outside_working_hours (Hassan starts at 10)
--
--   select * from find_bookings_by_phone('5551230000');
--   select cancel_booking((select bk.booking_id from find_bookings_by_phone('5551230000') bk limit 1), '5551230000');
--   select * from find_bookings_by_phone('5551230000');  -- gone; slot reopened
-- =============================================================================
