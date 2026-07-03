-- 0011_phone_normalization_and_grants.sql
--
-- Two fixes surfaced by the first CI replay of the migrations on a fresh
-- database (pgTAP suite, PR #1):
--
-- 1. EXPLICIT TABLE GRANTS. On a brand-new database the anon role has no
--    SELECT grant on the public reference tables — production only works
--    because the hosted project was created under older Supabase default
--    privileges that auto-granted table access. RLS policies do not replace
--    grants (you need BOTH), so a fresh environment (local dev, CI, a future
--    project migration) served zero marketing data. Grant explicitly; these
--    are no-ops where the grants already exist.
--
-- 2. PHONE NORMALIZATION in the customer lookup/cancel path. The RPCs strip
--    non-digits but never handled a leading US country code: a booking stored
--    as '14135551234' (11 digits passes the CHECK constraint) could never be
--    found or cancelled with '4135551234' — and vice versa. The lookup and
--    cancel functions now match all NANP-equivalent forms of the number.

-- =============================================================================
-- 1. Explicit read grants for the public marketing tables
-- =============================================================================

grant select on barbers          to anon, authenticated;
grant select on services         to anon, authenticated;
grant select on addons           to anon, authenticated;
grant select on barber_schedules to anon, authenticated;
grant select on barber_closures  to anon, authenticated;
grant select on store_hours      to anon, authenticated;

-- (v_slot_availability was already granted explicitly in 0001; bookings and
--  booking_errors intentionally get NO grants — RPC-only access.)

-- =============================================================================
-- 2. find_bookings_by_phone — match NANP-equivalent phone forms
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
  v_digits     text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_candidates text[];
begin
  if length(v_digits) < 10 then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  -- The same number may be stored with or without the US country code.
  v_candidates := array[v_digits];
  if length(v_digits) = 11 and v_digits like '1%' then
    v_candidates := v_candidates || substr(v_digits, 2);
  elsif length(v_digits) = 10 then
    v_candidates := v_candidates || ('1' || v_digits);
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
  where bk.customer_phone = any(v_candidates)
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
-- 3. cancel_booking — same phone-candidate matching
-- =============================================================================

create or replace function cancel_booking(p_booking_id uuid, p_phone text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_digits     text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_candidates text[];
  v_is_linked  boolean;
begin
  v_candidates := array[v_digits];
  if length(v_digits) = 11 and v_digits like '1%' then
    v_candidates := v_candidates || substr(v_digits, 2);
  elsif length(v_digits) = 10 then
    v_candidates := v_candidates || ('1' || v_digits);
  end if;

  -- Disallow cancelling a continuation/linked row directly — must cancel the primary.
  select linked_to is not null into v_is_linked
    from bookings where id = p_booking_id;
  if v_is_linked then
    raise exception 'cancel_via_primary' using errcode = 'P0002';
  end if;

  -- Cancel the primary
  update bookings
     set status          = 'cancelled',
         cancelled_at    = now(),
         cancelled_by    = 'customer',
         hold_expires_at = null
   where id              = p_booking_id
     and customer_phone  = any(v_candidates)
     and status in ('pending', 'confirmed');
  if not found then
    raise exception 'cannot_cancel' using errcode = 'P0002';
  end if;

  -- Cascade to linked rows (the continuation slots of multi-slot services)
  update bookings
     set status          = 'cancelled',
         cancelled_at    = now(),
         cancelled_by    = 'customer',
         hold_expires_at = null
   where linked_to       = p_booking_id
     and status in ('pending', 'confirmed');
end;
$$;

revoke all on function cancel_booking(uuid, text) from public;
grant execute on function cancel_booking(uuid, text) to anon, authenticated;
