-- 003_group_and_cancel.sql — pgTAP: group bookings (duration-aware) and the
-- customer cancellation flow (lookup by phone → cancel → slot freed). Rolls back.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function tap_next_dow(p_dow int) returns date language sql as $$
  select (current_date + ((p_dow - extract(dow from current_date)::int + 7) % 7 + 7))::date
$$;

-- ---------- Group bookings stack duration-aware ----------
-- A VIP (60 min) up front pushes the next guest a full hour, not 30 minutes.
select results_eq(
  $$ select booking_time::text
       from book_slot_group('larry', tap_next_dow(3), '10:00', '5552220001',
         '[{"name":"Vip Dad","service_slug":"vip-haircut"},
           {"name":"Kid Guest","service_slug":"kids-cut"}]'::jsonb)
      order by person_index $$,
  $$ values ('10:00:00'), ('11:00:00') $$,
  'guest after a VIP starts at 11:00, not 10:30'
);
select is(
  (select count(*)::int from bookings where customer_phone = '5552220001'),
  3, 'VIP + guest occupy three physical slots (10:00, 10:30 linked, 11:00)'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5552220001' and booking_time = '10:30' and linked_to is not null),
  1, 'the 10:30 slot is the VIP continuation row'
);

-- ---------- Group is all-or-nothing on conflict ----------
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '13:30', 'Solo Blocker', '5552220002') $$,
  'a solo cut holds 13:30'
);
select throws_ok(
  $$ select * from book_slot_group('larry', tap_next_dow(3), '13:00', '5552220003',
       '[{"name":"Group A","service_slug":"hair-cut"},
         {"name":"Group B","service_slug":"hair-cut"}]'::jsonb) $$,
  '23505', 'slot_taken',
  'a group hitting one taken slot fails entirely'
);
select is(
  (select count(*)::int from bookings where customer_phone = '5552220003'),
  0, 'the failed group left no partial rows'
);

-- ---------- Group input validation ----------
select throws_ok(
  $$ select * from book_slot_group('larry', tap_next_dow(3), '15:00', '5552220004',
       '"not-an-array"'::jsonb) $$,
  '22023', 'invalid_people',
  'people payload must be a JSON array'
);
select throws_ok(
  $$ select * from book_slot_group('larry', tap_next_dow(3), '15:00', '5552220005',
       '[{"name":"A1","service_slug":"hair-cut"},{"name":"A2","service_slug":"hair-cut"},
         {"name":"A3","service_slug":"hair-cut"},{"name":"A4","service_slug":"hair-cut"},
         {"name":"A5","service_slug":"hair-cut"},{"name":"A6","service_slug":"hair-cut"},
         {"name":"A7","service_slug":"hair-cut"}]'::jsonb) $$,
  '22023', 'too_many_people',
  'groups cap at six people'
);

-- ---------- find_bookings_by_phone: own bookings only, primaries only ----------
select lives_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(4), '10:00', 'Findme Tester', '5552220010') $$,
  'findme books a thursday cut with hassan'
);
select lives_ok(
  $$ select * from book_slot('larry', 'vip-haircut', tap_next_dow(4), '15:00', 'Findme Tester', '5552220010') $$,
  'findme also books a thursday VIP with larry'
);
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(4), '11:00', 'Someone Else', '5552220011') $$,
  'an unrelated customer books too'
);

select results_eq(
  $$ select barber_slug, service_slug, booking_time::text, first_name
       from find_bookings_by_phone('5552220010')
      order by booking_date, booking_time $$,
  $$ values ('hassan', 'hair-cut', '10:00:00', 'Findme'),
            ('larry', 'vip-haircut', '15:00:00', 'Findme') $$,
  'lookup returns exactly the callers two primaries, first name only'
);
select is(
  (select count(*)::int from find_bookings_by_phone('5552220010')),
  2, 'VIP continuation rows are hidden from the lookup'
);
select is(
  (select count(*)::int from find_bookings_by_phone('5552220099')),
  0, 'a phone with no bookings sees an empty list'
);
select throws_ok(
  $$ select * from find_bookings_by_phone('55522') $$,
  '22023', 'invalid_phone',
  'lookup rejects short phone numbers'
);
-- Formatting is forgiving: same digits, punctuation ignored.
select is(
  (select count(*)::int from find_bookings_by_phone('1 (555) 222-0010')),
  2, 'lookup cleans formatting and a leading country code'
);

-- ---------- cancel_booking: phone is the auth ----------
select throws_ok(
  $$ select cancel_booking(
       (select booking_id from find_bookings_by_phone('5552220010')
         where service_slug = 'hair-cut' limit 1),
       '5559999999') $$,
  'P0002', 'cannot_cancel',
  'cancelling with the wrong phone is rejected'
);

select lives_ok(
  $$ select cancel_booking(
       (select booking_id from find_bookings_by_phone('5552220010')
         where service_slug = 'hair-cut' limit 1),
       '5552220010') $$,
  'cancelling with the right phone succeeds'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5552220010' and status = 'cancelled'),
  1, 'the haircut row is marked cancelled'
);

-- The freed slot is instantly bookable by someone else.
select lives_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(4), '10:00', 'Slot Sniper', '5552220012') $$,
  'the cancelled 10:00 slot reopens immediately'
);

-- Cancelling the VIP primary cascades to its continuation slot.
select lives_ok(
  $$ select cancel_booking(
       (select booking_id from find_bookings_by_phone('5552220010') limit 1),
       '5552220010') $$,
  'cancelling the VIP primary succeeds'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5552220010' and status = 'cancelled'),
  3, 'VIP cancel cascades: primary + continuation + earlier haircut all cancelled'
);
select is(
  (select count(*)::int from find_bookings_by_phone('5552220010')),
  0, 'cancelled bookings vanish from the lookup'
);

-- A continuation row cannot be cancelled directly.
select lives_ok(
  $$ select * from book_slot('larry', 'vip-haircut', tap_next_dow(5), '10:00', 'Linked Probe', '5552220013') $$,
  'a fresh VIP for the linked-row test'
);
select throws_ok(
  $$ select cancel_booking(
       (select id from bookings where customer_phone = '5552220013' and linked_to is not null),
       '5552220013') $$,
  'P0002', 'cancel_via_primary',
  'continuation slots must be cancelled via their primary'
);

-- Double-cancel is rejected.
select throws_ok(
  $$ select cancel_booking(
       (select id from bookings
         where customer_phone = '5552220010' and status = 'cancelled' and linked_to is null
           and booking_time = '10:00' limit 1),
       '5552220010') $$,
  'P0002', 'cannot_cancel',
  'an already-cancelled booking cannot be cancelled again'
);

select * from finish();
rollback;
