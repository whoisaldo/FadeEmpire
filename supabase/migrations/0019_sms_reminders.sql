-- 0019_sms_reminders.sql
--
-- SMS reminders, sent by the send-reminders Edge Function (hourly, pg_cron +
-- pg_net; the schedule itself is created by tools/deploy-reminders.sh).
--
--   1. bookings: remind_sms (default true), rebook_sms (default false),
--      reminder_sent_at, rebook_sent_at, sms_last_error. Existing rows start
--      opted out because they predate the consent checkbox the booking form
--      is gaining in this release: remind_sms is added with default false, so
--      rows that exist when this runs read false, then the default becomes
--      true for new rows. No UPDATE runs, so updated_at and the
--      bookings_updated_at trigger are untouched.
--   2. book_slot / book_slot_group take p_remind_sms and p_rebook_sms as
--      trailing parameters with defaults. The old signatures are dropped so
--      PostgREST resolves the current client's named-argument calls to the
--      new functions unambiguously. Bodies are 0016 verbatim plus the two
--      columns, stored on every row the call inserts.
--   3. reminders_due(), rebook_due(), claim_reminders(), mark_reminder_sent():
--      service_role only. claim_reminders runs before each send so two
--      overlapping runs cannot text the same booking. mark_reminder_sent also
--      records a permanent Twilio rejection, so a number Twilio will never
--      accept is not retried every hour.
--
-- Phone numbers are grouped by their 10-digit form, so '14135551234' and
-- '4135551234' are the same customer (same rule as 0011).

-- =============================================================================
-- 1. pg_net for the schedule (pg_cron is installed by 0001)
--
-- Guarded with a catalog check instead of `create extension if not exists`:
-- Supabase's after-create scripts run even when the extension already exists
-- and are skipped, and pg_cron's script revokes cron.job from postgres, which fails
-- with "dependent privileges exist" once postgres has granted on cron.job.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    create extension pg_net;
  end if;
end
$$;

-- =============================================================================
-- 2. Columns
-- =============================================================================

alter table bookings add column if not exists remind_sms       boolean not null default false;
alter table bookings alter column remind_sms set default true;
alter table bookings add column if not exists rebook_sms       boolean not null default false;
alter table bookings add column if not exists reminder_sent_at timestamptz;
alter table bookings add column if not exists rebook_sent_at   timestamptz;
alter table bookings add column if not exists sms_last_error   text;
alter table bookings add column if not exists reminder_claimed_at timestamptz;
alter table bookings add column if not exists rebook_claimed_at   timestamptz;

-- claim_reminders and mark_reminder_sent turn fe.sms_bookkeeping on for the
-- duration of their own UPDATE (transaction-local), so the trigger leaves
-- updated_at alone for SMS bookkeeping. Every other update still bumps it.
create or replace function tg_set_updated_at()
returns trigger as $$
begin
  if current_setting('fe.sms_bookkeeping', true) = 'on' then
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

-- =============================================================================
-- 3. book_slot — 0016 plus p_remind_sms / p_rebook_sms
-- =============================================================================

drop function if exists book_slot(text, text, date, time, text, text, text[], text, text, text, int);

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

revoke all on function book_slot(text, text, date, time, text, text, text[], text, text, text, int, boolean, boolean) from public;
grant execute on function book_slot(text, text, date, time, text, text, text[], text, text, text, int, boolean, boolean)
  to anon, authenticated;

-- =============================================================================
-- 4. book_slot_group — 0016 plus p_remind_sms / p_rebook_sms
-- =============================================================================

drop function if exists book_slot_group(text, date, time, text, jsonb, int, text);

create or replace function book_slot_group(
  p_barber_slug    text,
  p_date           date,
  p_start_time     time,
  p_customer_phone text,
  p_people         jsonb,
  p_hold_minutes   int     default 15,
  p_source         text    default 'web',
  p_remind_sms     boolean default true,
  p_rebook_sms     boolean default false
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
          status, hold_expires_at, source, linked_to,
          remind_sms, rebook_sms
        ) values (
          case when v_slot_idx = 0 then v_primary_id else gen_random_uuid() end,
          v_barber.id, v_service.id, p_date, v_slot_time,
          v_person_name, v_phone_clean,
          case when v_slot_idx = 0 then v_notes else null end,
          case when v_slot_idx = 0 then v_addon_slugs else '{}'::text[] end,
          case when v_slot_idx = 0 then v_custom else null end,
          case when v_slot_idx = 0 then v_total else 0 end,
          'confirmed', null, coalesce(p_source, 'web'),
          case when v_slot_idx = 0 then null else v_primary_id end,
          coalesce(p_remind_sms, true), coalesce(p_rebook_sms, false)
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

revoke all on function book_slot_group(text, date, time, text, jsonb, int, text, boolean, boolean) from public;
grant execute on function book_slot_group(text, date, time, text, jsonb, int, text, boolean, boolean)
  to anon, authenticated;

-- =============================================================================
-- 5. reminders_due — one row per phone per appointment day
--
-- A (phone, day) is due when any of its confirmed, unsent, opted-in primary
-- bookings starts 23 to 25 hours from now. The row then lists every such
-- booking that phone has later that day, so a group gets one text.
-- =============================================================================

create or replace function reminders_due()
returns table (
  phone            text,
  appointment_date date,
  booking_ids      uuid[],
  people           jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with eligible as (
    select bk.id,
           case when length(bk.customer_phone) = 11 and bk.customer_phone like '1%'
                then substr(bk.customer_phone, 2) else bk.customer_phone end as phone,
           bk.booking_date,
           bk.booking_time,
           bk.slot_at,
           split_part(trim(bk.customer_name), ' ', 1) as first_name,
           b.display_name as barber_name
      from bookings bk
      join barbers b on b.id = bk.barber_id
     where bk.status = 'confirmed'
       and bk.linked_to is null
       and bk.remind_sms
       and bk.reminder_sent_at is null
       and bk.slot_at > now()
  ),
  due as (
    select distinct e.phone, e.booking_date
      from eligible e
     where e.slot_at between now() + interval '23 hours' and now() + interval '25 hours'
  )
  select e.phone,
         e.booking_date,
         array_agg(e.id order by e.booking_time, e.id),
         jsonb_agg(jsonb_build_object(
                     'id',     e.id,
                     'name',   e.first_name,
                     'time',   to_char(e.booking_time, 'HH24:MI'),
                     'barber', e.barber_name)
                   order by e.booking_time, e.id)
    from eligible e
    join due d on d.phone = e.phone and d.booking_date = e.booking_date
   group by e.phone, e.booking_date
   order by min(e.slot_at), e.phone;
$$;

revoke all on function reminders_due() from public, anon, authenticated;
grant execute on function reminders_due() to service_role;

-- =============================================================================
-- 6. rebook_due — one row per phone
--
-- The phone's most recent visit is its latest confirmed or completed primary
-- booking that has started. It is due when that visit has rebook_sms set,
-- rebook_sent_at null, started 21 to 42 days ago, and the phone has no
-- pending or confirmed booking starting after it.
-- =============================================================================

create or replace function rebook_due()
returns table (
  phone       text,
  barber_name text,
  last_visit  date,
  booking_ids uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  with keyed as (
    select bk.id,
           case when length(bk.customer_phone) = 11 and bk.customer_phone like '1%'
                then substr(bk.customer_phone, 2) else bk.customer_phone end as phone,
           bk.barber_id,
           bk.booking_date,
           bk.slot_at,
           bk.status,
           bk.rebook_sms,
           bk.rebook_sent_at
      from bookings bk
     where bk.linked_to is null
  ),
  latest as (
    select distinct on (k.phone) k.*
      from keyed k
     where k.status in ('confirmed', 'completed')
       and k.slot_at <= now()
     order by k.phone, k.slot_at desc, k.id desc
  )
  select l.phone, b.display_name, l.booking_date, array[l.id]
    from latest l
    join barbers b on b.id = l.barber_id
   where l.rebook_sms
     and l.rebook_sent_at is null
     and l.slot_at between now() - interval '42 days' and now() - interval '21 days'
     and not exists (
       select 1 from keyed k
        where k.phone = l.phone
          and k.status in ('pending', 'confirmed')
          and k.slot_at > l.slot_at
     )
   order by l.slot_at, l.phone;
$$;

revoke all on function rebook_due() from public, anon, authenticated;
grant execute on function rebook_due() to service_role;

-- =============================================================================
-- 7. mark_reminder_sent — p_kind is 'reminder' or 'rebook'
--
-- Sets the matching sent_at on rows where it is still null and returns the
-- number of rows changed. p_error is set when Twilio rejected the number for
-- good: the row is marked so it is not retried, and sms_last_error keeps the
-- reason.
-- =============================================================================

create or replace function mark_reminder_sent(
  p_booking_ids uuid[],
  p_kind        text,
  p_error       text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform set_config('fe.sms_bookkeeping', 'on', true);
  if p_kind = 'reminder' then
    update bookings
       set reminder_sent_at = now(),
           sms_last_error   = coalesce(p_error, sms_last_error)
     where id = any(p_booking_ids)
       and reminder_sent_at is null;
  elsif p_kind = 'rebook' then
    update bookings
       set rebook_sent_at = now(),
           sms_last_error = coalesce(p_error, sms_last_error)
     where id = any(p_booking_ids)
       and rebook_sent_at is null;
  else
    raise exception 'invalid_kind' using errcode = '22023';
  end if;

  get diagnostics v_count = row_count;
  perform set_config('fe.sms_bookkeeping', 'off', true);
  return v_count;
end;
$$;

revoke all on function mark_reminder_sent(uuid[], text, text) from public, anon, authenticated;
grant execute on function mark_reminder_sent(uuid[], text, text) to service_role;

-- =============================================================================
-- 8. claim_reminders — p_kind is 'reminder' or 'rebook'
--
-- Called right before a send. Sets the matching claimed_at on rows that are
-- still eligible (reminder: confirmed with remind_sms; rebook: confirmed or
-- completed with rebook_sms), not yet sent, and unclaimed or claimed more
-- than 10 minutes ago, and returns the ids it claimed. A booking cancelled
-- or opted out after the due query ran is not claimed. Concurrent calls for the same row
-- serialize on the row lock; the second re-checks the claim after the first
-- commits and gets nothing. A claim left by a run that died expires after
-- 10 minutes.
-- =============================================================================

create or replace function claim_reminders(p_kind text, p_booking_ids uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  perform set_config('fe.sms_bookkeeping', 'on', true);
  if p_kind = 'reminder' then
    with claimed as (
      update bookings
         set reminder_claimed_at = now()
       where id = any(p_booking_ids)
         and status = 'confirmed'
         and remind_sms
         and reminder_sent_at is null
         and (reminder_claimed_at is null
              or reminder_claimed_at < now() - interval '10 minutes')
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_ids from claimed;
  elsif p_kind = 'rebook' then
    with claimed as (
      update bookings
         set rebook_claimed_at = now()
       where id = any(p_booking_ids)
         and status in ('confirmed', 'completed')
         and rebook_sms
         and rebook_sent_at is null
         and (rebook_claimed_at is null
              or rebook_claimed_at < now() - interval '10 minutes')
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_ids from claimed;
  else
    raise exception 'invalid_kind' using errcode = '22023';
  end if;

  perform set_config('fe.sms_bookkeeping', 'off', true);
  return v_ids;
end;
$$;

revoke all on function claim_reminders(text, uuid[]) from public, anon, authenticated;
grant execute on function claim_reminders(text, uuid[]) to service_role;
