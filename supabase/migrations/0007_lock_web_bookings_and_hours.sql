-- 0007_lock_web_bookings_and_hours.sql
--
-- Two changes:
--   1. Web bookings are now CONFIRMED on creation (no 15-minute hold / no expiry).
--      Root-cause fix for double-booking: previously book_slot inserted a `pending`
--      row with a 15-min hold_expires_at, and the expire-holds cron flipped it to
--      `expired` (removing it from the partial unique index) before anyone confirmed
--      it — because this static site has no owner-confirm UI. The slot then reopened
--      and a second customer could book the same time. Inserting `confirmed` with
--      hold_expires_at = null keeps the slot locked in the unique index until Hassan
--      cancels it manually. No-shows are cancelled by hand in Supabase Studio.
--   2. Shop hours: open 7 days, 10:00 AM – 6:00 PM (was Mon–Sat 10:00–17:30, Sun closed).
--
-- Run once in the Supabase SQL editor for project mjehfaonibgobimfiijk.
-- Idempotent: book_slot/book_slot_group use CREATE OR REPLACE; schedule uses upsert.

-- =============================================================================
-- 1. book_slot — insert CONFIRMED (no hold / no expiry)
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

  -- Validate every slot in the sequence fits working hours + closure
  for v_idx in 0 .. v_slot_count - 1 loop
    v_slot_time := make_time((v_slot_min + v_idx * 30) / 60,
                             (v_slot_min + v_idx * 30) % 60, 0);

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
-- 2. book_slot_group — insert CONFIRMED (no hold / no expiry)
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
  v_slot_min     int;
  v_new_id       uuid;
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

  if (
    select count(*) from bookings b
      where b.customer_phone = v_phone_clean
        and b.status in ('pending', 'confirmed')
        and b.slot_at >= now()
  ) + v_count > 6 then
    raise exception 'too_many_active_bookings' using errcode = '23505';
  end if;

  v_slot_min := extract(hour from p_start_time)::int * 60
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

    v_slot_time := make_time((v_slot_min + v_idx * 30) / 60,
                             (v_slot_min + v_idx * 30) % 60, 0);

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

    v_addon_total := 0;
    if array_length(v_addon_slugs, 1) > 0 then
      select coalesce(sum(a.price_cents), 0) into v_addon_total
        from addons a
       where a.slug = any(v_addon_slugs) and a.is_active = true;
    end if;

    v_total  := v_service.base_price_cents + v_addon_total;
    v_new_id := gen_random_uuid();

    begin
      insert into bookings (
        id, barber_id, service_id, booking_date, booking_time,
        customer_name, customer_phone, customer_notes,
        selected_addons, custom_request, total_price_cents,
        status, hold_expires_at, source
      ) values (
        v_new_id, v_barber.id, v_service.id, p_date, v_slot_time,
        v_person_name, v_phone_clean, v_notes,
        coalesce(v_addon_slugs, '{}'::text[]),
        v_custom,
        v_total, 'confirmed', null, coalesce(p_source, 'web')
      );
    exception
      when unique_violation then
        raise exception 'slot_taken' using errcode = '23505',
          detail = format('Conflict on slot %s', v_slot_time);
    end;

    booking_id        := v_new_id;
    person_index      := v_idx;
    person_name       := v_person_name;
    service_slug      := v_service_slug;
    booking_time      := v_slot_time;
    total_price_cents := v_total;
    return next;
  end loop;

  return;
end;
$$;

grant execute on function book_slot_group(text, date, time, text, jsonb, int, text)
  to anon, authenticated;

-- =============================================================================
-- 3. Shop hours — open 7 days, 10:00 AM – 6:00 PM
-- =============================================================================

-- Move close from 17:30 to 18:00 for all existing (Mon–Sat) rows.
update barber_schedules s
   set close_time = '18:00:00'
  from barbers b
 where s.barber_id = b.id and b.slug = 'hassan';

-- Add Sunday (weekday 0), or update it if it somehow already exists.
insert into barber_schedules (barber_id, weekday, open_time, close_time)
select id, 0, '10:00:00', '18:00:00' from barbers where slug = 'hassan'
on conflict (barber_id, weekday)
  do update set open_time = excluded.open_time, close_time = excluded.close_time;
