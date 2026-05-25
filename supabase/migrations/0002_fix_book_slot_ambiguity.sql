-- 0002_fix_book_slot_ambiguity.sql
--
-- Bugfix: in 0001_init.sql the book_slot() function defined a RETURNS TABLE
-- column named `status` (same as bookings.status), making column references
-- inside subqueries ambiguous (Postgres error 42702).
--
-- Fix: qualify every reference to the bookings table column, and the
-- per-phone subquery now uses an aliased table.

-- Drop both candidate signatures defensively (the old one with 11 params,
-- and a possibly-stale variant) so the CREATE OR REPLACE below is clean.
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
  p_hold_minutes   int      default 15
)
returns table (
  booking_id        uuid,
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
  v_new_id       uuid;
  v_hold_expires timestamptz;
  v_phone_clean  text;
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
  if not found then
    raise exception 'barber_not_found' using errcode = 'P0002';
  end if;

  select * into v_service from services
    where services.slug = p_service_slug and services.is_active = true;
  if not found then
    raise exception 'service_not_found' using errcode = 'P0002';
  end if;

  if p_date < current_date or p_date > current_date + interval '60 days' then
    raise exception 'date_out_of_range' using errcode = '22023';
  end if;

  if not exists (
    select 1 from barber_schedules s
     where s.barber_id = v_barber.id
       and s.weekday   = extract(dow from p_date)::smallint
       and p_time     >= s.open_time
       and p_time     <  s.close_time
  ) then
    raise exception 'outside_working_hours' using errcode = '22023';
  end if;

  if exists (
    select 1 from barber_closures c
     where c.barber_id    = v_barber.id
       and c.closure_date = p_date
  ) then
    raise exception 'barber_closed' using errcode = '22023';
  end if;

  if extract(minute from p_time)::int not in (0, 30)
     or extract(second from p_time)::int <> 0 then
    raise exception 'invalid_slot_alignment' using errcode = '22023';
  end if;

  if array_length(p_addon_slugs, 1) > 0 then
    select coalesce(sum(a.price_cents), 0) into v_addon_total
      from addons a
     where a.slug = any(p_addon_slugs) and a.is_active = true;
  end if;

  v_total := v_service.base_price_cents + v_addon_total;

  -- Per-phone rate limit: max 3 active future holds (anti-spam).
  -- Aliased table reference avoids ambiguity with the function's RETURNS columns.
  if (
    select count(*) from bookings b
     where b.customer_phone = v_phone_clean
       and b.status in ('pending', 'confirmed')
       and b.slot_at >= now()
  ) >= 3 then
    raise exception 'too_many_active_bookings' using errcode = '23505';
  end if;

  v_hold_expires := now() + make_interval(mins => greatest(p_hold_minutes, 5));
  v_new_id       := gen_random_uuid();

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
