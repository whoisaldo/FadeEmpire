-- 004_security.sql — pgTAP: the anon threat model.
-- The anon key is public in the client JS, so assume an attacker holds it.
-- These tests run statements AS the anon role and assert what it can and
-- cannot do. Rolls back.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function tap_next_dow(p_dow int) returns date language sql as $$
  select (current_date + ((p_dow - extract(dow from current_date)::int + 7) % 7 + 7))::date
$$;

-- A table is "hidden" from the current role if reading it either raises
-- permission-denied (no grant — fresh databases) or yields zero rows
-- (legacy grant + RLS with no policy — the hosted project). Both are a
-- correct lockdown; readable ROWS are the regression we're guarding against.
create function tap_table_hidden(p_table text) returns boolean
language plpgsql as $$
declare v_count int;
begin
  execute format('select count(*) from %I', p_table) into v_count;
  return v_count = 0;
exception when insufficient_privilege then
  return true;
end;
$$;

-- Seed one real booking as the superuser so there is PII worth protecting.
select lives_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(6), '10:00', 'Private Person', '5553330001') $$,
  'seed booking exists'
);

-- The availability view exposes exactly five PII-free columns.
select columns_are(
  'public', 'v_slot_availability',
  array['barber_id', 'barber_slug', 'booking_date', 'booking_time', 'status'],
  'availability view has no name/phone/notes columns'
);

-- ======================= AS ANON =======================
set local role anon;

select is(
  tap_table_hidden('bookings'),
  true, 'anon cannot read any bookings rows (denied or RLS-empty)'
);
select is(
  tap_table_hidden('booking_errors'),
  true, 'anon cannot read any booking_errors rows (denied or RLS-empty)'
);
select throws_ok(
  $$ insert into bookings (barber_id, service_id, booking_date, booking_time,
                           customer_name, customer_phone, total_price_cents,
                           status, hold_expires_at)
     select b.id, s.id, tap_next_dow(6), '12:00', 'Sneaky', '5553330099', 0,
            'confirmed', null
       from barbers b, services s
      where b.slug = 'javier' and s.slug = 'hair-cut' $$,
  '42501', null,
  'anon cannot INSERT into bookings directly — only via the RPCs'
);

-- Public marketing data is readable.
select is((select count(*)::int from barbers where is_active), 2, 'anon reads active barbers');
select is((select count(*)::int from store_hours), 6, 'anon reads store hours');

-- The availability view works for anon and shows the seeded slot — sans PII.
select is(
  (select count(*)::int from v_slot_availability
    where barber_slug = 'javier'
      and booking_date = tap_next_dow(6)
      and booking_time = '10:00'),
  1, 'anon sees the taken slot in the availability view'
);

-- Customer-facing RPCs are executable by anon (SECURITY DEFINER does the work).
select lives_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(6), '11:00', 'Anon Booker', '5553330002') $$,
  'anon can book through book_slot'
);
select is(
  (select count(*)::int from find_bookings_by_phone('5553330002')),
  1, 'anon can look up their own bookings by phone'
);
select lives_ok(
  $$ select cancel_booking(
       (select booking_id from find_bookings_by_phone('5553330002') limit 1),
       '5553330002') $$,
  'anon can cancel their own booking'
);
select lives_ok(
  $$ select log_booking_error('{"code":"tap-test","message":"from 004_security"}'::jsonb) $$,
  'anon can log a booking error'
);

-- Owner/system functions are NOT executable by anon.
select throws_ok(
  $$ select confirm_booking(gen_random_uuid()) $$,
  '42501', null,
  'anon cannot execute confirm_booking (owner-only)'
);
select throws_ok(
  $$ select expire_pending_holds() $$,
  '42501', null,
  'anon cannot execute expire_pending_holds (cron-only)'
);

-- ======================= BACK TO SUPERUSER =======================
reset role;

select is(
  (select count(*)::int from bookings where customer_phone in ('5553330001', '5553330002')),
  2, 'the rows really exist — RLS (not absence of data) hid them from anon'
);
select is(
  (select count(*)::int from booking_errors),
  1, 'the anon error log landed in booking_errors'
);

select * from finish();
rollback;
