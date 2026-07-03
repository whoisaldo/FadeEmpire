-- 001_schema.sql — pgTAP: schema, seeds, hours, and the race-proof index.
-- Runs against a fresh local database with ALL migrations (0001–0009) applied.
-- Everything runs in a transaction and rolls back.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------- Tables + view exist ----------
select has_table('public', 'barbers',          'barbers table exists');
select has_table('public', 'services',         'services table exists');
select has_table('public', 'addons',           'addons table exists');
select has_table('public', 'barber_schedules', 'barber_schedules table exists');
select has_table('public', 'barber_closures',  'barber_closures table exists');
select has_table('public', 'bookings',         'bookings table exists');
select has_table('public', 'booking_errors',   'booking_errors table exists');
select has_table('public', 'store_hours',      'store_hours table exists');
select has_view ('public', 'v_slot_availability', 'availability view exists');

-- ---------- RPCs exist ----------
select has_function('public', 'book_slot',              'book_slot() exists');
select has_function('public', 'book_slot_group',        'book_slot_group() exists');
select has_function('public', 'cancel_booking',         'cancel_booking() exists');
select has_function('public', 'find_bookings_by_phone', 'find_bookings_by_phone() exists');
select has_function('public', 'confirm_booking',        'confirm_booking() exists');
select has_function('public', 'log_booking_error',      'log_booking_error() exists');
select has_function('public', 'expire_pending_holds',   'expire_pending_holds() exists');
select has_function('public', 'is_within_store_hours',  'is_within_store_hours() exists');

-- ---------- The constraint that makes double-booking impossible ----------
select has_index('public', 'bookings', 'bookings_active_slot_uidx',
                 'partial unique index on (barber, date, time) exists');

-- ---------- RLS is on for every table holding or gating data ----------
select is((select relrowsecurity from pg_class where relname = 'bookings'),       true, 'RLS enabled on bookings');
select is((select relrowsecurity from pg_class where relname = 'booking_errors'), true, 'RLS enabled on booking_errors');
select is((select relrowsecurity from pg_class where relname = 'barbers'),        true, 'RLS enabled on barbers');
select is((select relrowsecurity from pg_class where relname = 'store_hours'),    true, 'RLS enabled on store_hours');

-- ---------- Barbers seed ----------
select is((select count(*)::int from barbers where is_active), 2, 'exactly two active barbers');
select results_eq(
  $$ select slug from barbers where is_active order by sort_order $$,
  $$ values ('hassan'), ('javier') $$,
  'active barbers are hassan then javier'
);

-- ---------- Store hours: Mon–Sat 9–6, Sunday 10–6 ----------
select is((select count(*)::int from store_hours), 7, 'store is open all seven days');
select results_eq(
  $$ select weekday::int, open_time::text, close_time::text from store_hours order by weekday $$,
  $$ values (0,'10:00:00','18:00:00'),
            (1,'09:00:00','18:00:00'), (2,'09:00:00','18:00:00'), (3,'09:00:00','18:00:00'),
            (4,'09:00:00','18:00:00'), (5,'09:00:00','18:00:00'), (6,'09:00:00','18:00:00') $$,
  'store hours are 9–6 Mon–Sat and 10–6 Sundays'
);

-- ---------- Hassan: 10–6 every day except Tuesdays ----------
select results_eq(
  $$ select s.weekday::int, s.open_time::text, s.close_time::text
       from barber_schedules s join barbers b on b.id = s.barber_id
      where b.slug = 'hassan' order by s.weekday $$,
  $$ values (0,'10:00:00','18:00:00'), (1,'10:00:00','18:00:00'), (3,'10:00:00','18:00:00'),
            (4,'10:00:00','18:00:00'), (5,'10:00:00','18:00:00'), (6,'10:00:00','18:00:00') $$,
  'hassan works Sun–Mon and Wed–Sat 10:00–18:00 (off Tuesdays)'
);

-- ---------- Javier: 9–6 Mon–Sat ----------
select results_eq(
  $$ select s.weekday::int, s.open_time::text, s.close_time::text
       from barber_schedules s join barbers b on b.id = s.barber_id
      where b.slug = 'javier' order by s.weekday $$,
  $$ values (1,'09:00:00','18:00:00'), (2,'09:00:00','18:00:00'), (3,'09:00:00','18:00:00'),
            (4,'09:00:00','18:00:00'), (5,'09:00:00','18:00:00'), (6,'09:00:00','18:00:00') $$,
  'javier works Mon–Sat 09:00–18:00'
);

-- ---------- No barber schedule leaks outside store hours ----------
select is(
  (select count(*)::int
     from barber_schedules s
     left join store_hours h on h.weekday = s.weekday
    where h.weekday is null
       or s.open_time  < h.open_time
       or s.close_time > h.close_time),
  0,
  'every barber schedule fits inside store hours'
);

-- ---------- Services + addons seeds ----------
select is((select count(*)::int from services where is_active), 7, 'seven active services');
select is((select duration_minutes from services where slug = 'vip-haircut'), 60, 'VIP takes 60 minutes');
select is((select base_price_cents from services where slug = 'hair-cut'), 3000, 'hair cut is $30');
select is((select count(*)::int from addons where is_active), 5, 'five active add-ons');
select is((select price_cents from addons where slug = 'beard'), 1000, 'beard add-on is $10');
select is((select price_cents from addons where slug = 'eyebrows'), 0, 'eyebrows are free');

-- ---------- is_within_store_hours helper sanity ----------
select is(is_within_store_hours('2026-07-06'::date, '09:00'::time), true,  'Mon 9:00 is inside store hours');
select is(is_within_store_hours('2026-07-06'::date, '17:30'::time), true,  'Mon 17:30 is inside store hours');
select is(is_within_store_hours('2026-07-06'::date, '18:00'::time), false, 'Mon 18:00 is past closing');
select is(is_within_store_hours('2026-07-06'::date, '08:30'::time), false, 'Mon 8:30 is before opening');
select is(is_within_store_hours('2026-07-05'::date, '12:00'::time), true,  'Sunday midday is open');
select is(is_within_store_hours('2026-07-05'::date, '09:30'::time), false, 'Sunday 9:30 is before the 10:00 Sunday open');

select * from finish();
rollback;
