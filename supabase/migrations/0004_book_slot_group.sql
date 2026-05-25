-- 0004_book_slot_group.sql
--
-- Group booking: one customer reserves N consecutive 30-minute slots in a
-- single atomic transaction. Used for "me + my kid", "me + a friend", etc.
--
-- All-or-nothing: if any slot in the sequence is unavailable (taken, outside
-- working hours, on a closure day), the entire booking fails and no rows are
-- inserted. The transaction rollback is implicit (RAISE EXCEPTION inside the
-- plpgsql function aborts the surrounding statement).
--
-- The slots share a customer_phone (Hassan messages one person). Each "person"
-- in the group can have a different name, service, addons, and notes.

create or replace function book_slot_group(
  p_barber_slug    text,
  p_date           date,
  p_start_time     time,
  p_customer_phone text,
  p_people         jsonb,       -- [{name, service_slug, addons[], notes}, ...]
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
  v_service      services%rowtype;
  v_addon_total  int;
  v_total        int;
  v_slot_time    time;
  v_slot_min     int;
  v_hold_expires timestamptz;
  v_new_id       uuid;
begin
  -- 1. Sanitize phone
  v_phone_clean := regexp_replace(coalesce(p_customer_phone, ''), '\D', '', 'g');
  if length(v_phone_clean) < 10 then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  -- 2. Validate people array
  if p_people is null or jsonb_typeof(p_people) <> 'array' then
    raise exception 'invalid_people' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_people);
  if v_count < 1 then
    raise exception 'invalid_people' using errcode = '22023';
  end if;
  if v_count > 6 then
    -- sanity cap; nobody books 6 cuts at once. Anti-abuse.
    raise exception 'too_many_people' using errcode = '22023';
  end if;

  -- 3. Load barber
  select * into v_barber from barbers
   where barbers.slug = p_barber_slug and barbers.is_active = true;
  if not found then
    raise exception 'barber_not_found' using errcode = 'P0002';
  end if;

  -- 4. Date in range
  if p_date < current_date or p_date > current_date + interval '60 days' then
    raise exception 'date_out_of_range' using errcode = '22023';
  end if;

  -- 5. Slot alignment
  if extract(minute from p_start_time)::int not in (0, 30)
     or extract(second from p_start_time)::int <> 0 then
    raise exception 'invalid_slot_alignment' using errcode = '22023';
  end if;

  -- 6. Per-phone rate limit applies to the GROUP — count active holds.
  if (
    select count(*) from bookings b
      where b.customer_phone = v_phone_clean
        and b.status in ('pending', 'confirmed')
        and b.slot_at >= now()
  ) + v_count > 6 then
    raise exception 'too_many_active_bookings' using errcode = '23505';
  end if;

  v_hold_expires := now() + make_interval(mins => greatest(p_hold_minutes, 5));
  v_slot_min     := extract(hour from p_start_time)::int * 60
                  + extract(minute from p_start_time)::int;

  -- 7. Loop, validate each person, insert each slot.
  for v_idx in 0 .. v_count - 1 loop
    v_person      := p_people -> v_idx;
    v_person_name := nullif(trim(coalesce(v_person ->> 'name', '')), '');
    v_service_slug:= coalesce(v_person ->> 'service_slug', '');
    v_notes       := nullif(trim(coalesce(v_person ->> 'notes', '')), '');

    -- Addons array
    if v_person ? 'addons' and jsonb_typeof(v_person -> 'addons') = 'array' then
      select array_agg(value::text)::text[] into v_addon_slugs
        from jsonb_array_elements_text(v_person -> 'addons');
    else
      v_addon_slugs := '{}';
    end if;

    if v_person_name is null or length(v_person_name) < 2 then
      raise exception 'invalid_name' using errcode = '22023';
    end if;

    -- Service lookup
    select * into v_service from services
      where services.slug = v_service_slug and services.is_active = true;
    if not found then
      raise exception 'service_not_found' using errcode = 'P0002';
    end if;

    -- Compute this person's slot time (consecutive 30-min steps)
    v_slot_time := make_time((v_slot_min + v_idx * 30) / 60,
                             (v_slot_min + v_idx * 30) % 60, 0);

    -- Working hours check for this specific slot
    if not exists (
      select 1 from barber_schedules s
        where s.barber_id = v_barber.id
          and s.weekday   = extract(dow from p_date)::smallint
          and v_slot_time >= s.open_time
          and v_slot_time <  s.close_time
    ) then
      raise exception 'outside_working_hours' using errcode = '22023';
    end if;

    -- Closure check
    if exists (
      select 1 from barber_closures c
        where c.barber_id    = v_barber.id
          and c.closure_date = p_date
    ) then
      raise exception 'barber_closed' using errcode = '22023';
    end if;

    -- Addon total
    v_addon_total := 0;
    if array_length(v_addon_slugs, 1) > 0 then
      select coalesce(sum(a.price_cents), 0) into v_addon_total
        from addons a
       where a.slug = any(v_addon_slugs) and a.is_active = true;
    end if;

    v_total  := v_service.base_price_cents + v_addon_total;
    v_new_id := gen_random_uuid();

    -- Insert. The partial unique index raises unique_violation if any slot
    -- in the requested sequence is taken; we re-raise as slot_taken and the
    -- whole transaction rolls back, taking any earlier inserts with it.
    begin
      insert into bookings (
        id, barber_id, service_id, booking_date, booking_time,
        customer_name, customer_phone, customer_notes,
        selected_addons, total_price_cents,
        status, hold_expires_at, source
      ) values (
        v_new_id, v_barber.id, v_service.id, p_date, v_slot_time,
        v_person_name, v_phone_clean, v_notes,
        v_addon_slugs, v_total,
        'pending', v_hold_expires, coalesce(p_source, 'web')
      );
    exception
      when unique_violation then
        raise exception 'slot_taken' using errcode = '23505',
          detail = format('Conflict on slot %s', v_slot_time);
    end;

    -- Append this row to the function's return set
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

revoke all on function book_slot_group(text, date, time, text, jsonb, int, text) from public;
grant execute on function book_slot_group(text, date, time, text, jsonb, int, text)
  to anon, authenticated;
