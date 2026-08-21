-- 0016_45_minute_slots.sql
--
-- Pace change, straight from Hassan: 30 minutes per cut isn't enough — 45 is.
-- Appointments now run on a 45-minute grid for the whole shop (both chairs
-- stay in step, which keeps group bookings and the availability grid simple):
--
--   10:00 · 10:45 · 11:30 · 12:15 · 1:00 · 1:45 · 2:30 · 3:15 · 4:00 · 4:45 · 5:30
--
-- Hours don't change (store + both barbers 10–6). The LAST appointment still
-- starts at 5:30 PM — same as before — but now runs to 6:15, and the barber
-- stays past the 6:00 close to finish it. That was already the DB's semantic
-- (a slot is valid if it STARTS before close_time); this migration just makes
-- the grid math honor it.
--
-- Mechanically:
--   1. barber_schedules.slot_minutes — the column has existed since 0001 but
--      nothing read it; the 30-minute grid was hardcoded in both booking RPCs.
--      Set every row (and the column default) to 45.
--   2. book_slot / book_slot_group — replace the hardcoded "minute in (0,30)"
--      alignment check with a real grid check against the barber's schedule
--      for that weekday: open_time + n * slot_minutes. (On a 45 grid the
--      minute-of-hour cycles 00 → 45 → 30 → 15, so a fixed minute set can't
--      express it.) Continuation slots step by slot_minutes, and a service
--      occupies ceil(duration / slot_minutes) slots — so every 30-min service
--      fills one 45-min slot, and the 60-min VIP still spans two (now 90 min
--      of calendar, ending on the grid).
--
-- Error semantics preserved: times outside the store window still raise
-- store_closed, a barber's day off still raises outside_working_hours, and
-- off-grid times inside the window raise invalid_slot_alignment.
--
-- Apply with `supabase db push --linked` (or run once in the SQL editor) for
-- project mjehfaonibgobimfiijk. Idempotent.
--
-- NOTE for the owner: existing future bookings on the old half-hour grid
-- (e.g. 11:00, 14:30 was fine but 11:00 isn't a slot anymore) are NOT moved
-- or cancelled — they keep their times and stay visible in Studio. Review
-- anything booked at a time that's off the new grid and call the customer:
--
--   select bk.booking_date, bk.booking_time, bk.customer_name, bk.customer_phone,
--          b.display_name as barber
--     from bookings bk join barbers b on b.id = bk.barber_id
--    where bk.status in ('pending', 'confirmed')
--      and bk.booking_date >= current_date
--      and ((extract(hour from bk.booking_time)::int * 60
--          + extract(minute from bk.booking_time)::int) - 600) % 45 <> 0
--    order by bk.booking_date, bk.booking_time;

-- =============================================================================
-- 1. The grid: 45 minutes, everywhere
-- =============================================================================

alter table barber_schedules alter column slot_minutes set default 45;

update barber_schedules set slot_minutes = 45;

-- =============================================================================
-- 2. book_slot — grid-aware alignment + slot stepping (otherwise 0009 verbatim)
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
   where barbers.slug = p_barber_slug and barbers.is_active = true;
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
-- 3. book_slot_group — same grid treatment (otherwise 0009 verbatim)
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
  v_sched        barber_schedules%rowtype;
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
  v_step         int;
  v_open_min     int;
  v_close_min    int;
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

  if extract(second from p_start_time)::int <> 0 then
    raise exception 'invalid_slot_alignment' using errcode = '22023';
  end if;

  v_cursor_min := extract(hour from p_start_time)::int * 60
                + extract(minute from p_start_time)::int;

  -- Grid alignment against the barber's schedule for that weekday (see
  -- book_slot above — same rules, same error ordering).
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
    if v_cursor_min >= v_open_min and v_cursor_min < v_close_min
       and (v_cursor_min - v_open_min) % v_step <> 0 then
      raise exception 'invalid_slot_alignment' using errcode = '22023';
    end if;
  end if;

  -- Pre-compute total slot count for the rate limit (duration-aware).
  for v_idx in 0 .. v_count - 1 loop
    v_service_slug := coalesce(p_people -> v_idx ->> 'service_slug', '');
    select * into v_service from services
      where services.slug = v_service_slug and services.is_active = true;
    if not found then raise exception 'service_not_found' using errcode = 'P0002'; end if;
    v_total_slots := v_total_slots
                   + greatest(1, ceil(v_service.duration_minutes::numeric / v_step)::int);
  end loop;

  if (
    select count(*) from bookings b
      where b.customer_phone = v_phone_clean
        and b.status in ('pending', 'confirmed')
        and b.slot_at >= now()
  ) + v_total_slots > 6 then
    raise exception 'too_many_active_bookings' using errcode = '23505';
  end if;

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

    v_person_slots := greatest(1, ceil(v_service.duration_minutes::numeric / v_step)::int);
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
      v_slot_time := make_time((v_person_min + v_slot_idx * v_step) / 60,
                               (v_person_min + v_slot_idx * v_step) % 60, 0);

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

    v_cursor_min := v_cursor_min + v_person_slots * v_step;
  end loop;

  return;
end;
$$;

grant execute on function book_slot_group(text, date, time, text, jsonb, int, text)
  to anon, authenticated;

-- =============================================================================
-- DONE. Manual verification:
--
--   select b.slug, s.weekday, s.slot_minutes
--     from barber_schedules s join barbers b on b.id = s.barber_id
--    order by b.slug, s.weekday;
--   -- every row: slot_minutes = 45
--
--   select * from book_slot('hassan', 'hair-cut', current_date + 1, '10:45',
--                           'Grid Test', '5551230101');
--   -- succeeds (10:45 is on the new grid) unless tomorrow is Tuesday
--
--   select * from book_slot('hassan', 'hair-cut', current_date + 1, '11:00',
--                           'Grid Test', '5551230102');
--   -- raises invalid_slot_alignment — 11:00 was a slot on the old 30-min grid
--
--   select * from book_slot('hassan', 'hair-cut', current_date + 1, '17:30',
--                           'Last Cut', '5551230103');
--   -- succeeds — the day's last appointment, runs to 6:15 (past the 6:00 close)
-- =============================================================================
