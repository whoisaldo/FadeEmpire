-- 005_people.sql — pgTAP: people tracking (0019) — party_id, is_guest,
-- person_key, and the owner-only v_people view. Rolls back.
--
-- The whole file is ONE transaction, so every row it inserts shares
-- created_at — the same signal the party trigger keys on. Each scenario uses
-- its own phone so they stay separate parties; the "same phone, a later
-- booking" case sets created_at explicitly.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function tap_next_dow(p_dow int) returns date language sql as $$
  select (current_date + ((p_dow - extract(dow from current_date)::int + 7) % 7 + 7))::date
$$;

-- Transaction-local two-slot service, to exercise continuation rows (see 003).
insert into services (slug, display_name, base_price_cents, duration_minutes, sort_order)
values ('tap-long', 'pgTAP Two-Slot Service', 9000, 90, 999);

select has_column('public', 'bookings', 'party_id',   'bookings.party_id exists');
select has_column('public', 'bookings', 'is_guest',   'bookings.is_guest exists');
select has_column('public', 'bookings', 'person_key', 'bookings.person_key exists');
select has_view  ('public', 'v_people',               'people view exists');

-- ---------- A solo booking is its own party ----------
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(4), '10:00', 'Solo Sam', '5554440001') $$,
  'solo booking'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5554440001' and party_id = id and not is_guest),
  1, 'a solo booking is its own party and not a guest'
);

-- ---------- A parent, a kid and a friend share one party ----------
select lives_ok(
  $$ select * from book_slot_group('hassan', tap_next_dow(4), '10:00', '5554440002',
       '[{"name":"Dana Parent","service_slug":"hair-cut"},
         {"name":"Kai","service_slug":"kids-cut"},
         {"name":"Fred Smith","service_slug":"hair-cut"}]'::jsonb) $$,
  'group of three books'
);
select is(
  (select count(distinct party_id)::int from bookings where customer_phone = '5554440002'),
  1, 'the whole group shares one party_id'
);
select is(
  (select party_id from bookings where customer_phone = '5554440002' and customer_name = 'Kai'),
  (select id from bookings where customer_phone = '5554440002' and customer_name = 'Dana Parent'),
  'party_id is the booker''s booking id'
);
select results_eq(
  $$ select customer_name, is_guest from bookings
      where customer_phone = '5554440002' order by booking_time $$,
  $$ values ('Dana Parent', false), ('Kai', true), ('Fred Smith', true) $$,
  'the booker is not a guest; the kid and the friend are'
);
select results_eq(
  $$ select person_key from bookings
      where customer_phone = '5554440002' order by booking_time $$,
  $$ values ('5554440002:dana'), ('5554440002:kai'), ('5554440002:fred') $$,
  'person_key is the phone plus the lowercased first name'
);

-- ---------- A guest's continuation slot stays with the guest ----------
select lives_ok(
  $$ select * from book_slot_group('larry', tap_next_dow(4), '13:00', '5554440003',
       '[{"name":"Lee Booker","service_slug":"hair-cut"},
         {"name":"Long Guest","service_slug":"tap-long"}]'::jsonb) $$,
  'group with a two-slot guest books'
);
select results_eq(
  $$ select booking_time::text, is_guest, linked_to is not null from bookings
      where customer_phone = '5554440003' order by booking_time $$,
  $$ values ('13:00:00', false, false), ('13:45:00', true, false), ('14:30:00', true, true) $$,
  'the guest''s continuation slot is a guest row too'
);
select is(
  (select count(distinct party_id)::int from bookings where customer_phone = '5554440003'),
  1, 'the continuation slot shares the party'
);

-- ---------- The same phone booking later starts a new party ----------
insert into bookings (barber_id, service_id, booking_date, booking_time,
                      customer_name, customer_phone, total_price_cents, status, created_at)
select b.id, s.id, tap_next_dow(5), '10:00', '  DANA p.', '5554440002', 3500, 'confirmed',
       now() + interval '1 day'
  from barbers b, services s
 where b.slug = 'hassan' and s.slug = 'hair-cut';

select results_eq(
  $$ select is_guest, party_id = id, person_key from bookings
      where customer_phone = '5554440002' and booking_date = tap_next_dow(5) $$,
  $$ values (false, true, '5554440002:dana') $$,
  'a later booking from the same phone is its own party, and "  DANA p." is still dana'
);

-- ---------- An explicit party_id is kept ----------
insert into bookings (barber_id, service_id, booking_date, booking_time,
                      customer_name, customer_phone, total_price_cents, status,
                      party_id, is_guest)
select b.id, s.id, tap_next_dow(5), '10:45', 'Walk In', '5554440004', 2500, 'confirmed',
       (select id from bookings where customer_name = 'Solo Sam'), true
  from barbers b, services s
 where b.slug = 'hassan' and s.slug = 'kids-cut';

select is(
  (select party_id from bookings where customer_phone = '5554440004'),
  (select id from bookings where customer_name = 'Solo Sam'),
  'a party_id set on insert is not overwritten'
);

-- ---------- v_people: one row per person, kept bookings only ----------
select results_eq(
  $$ select name, is_kid, bookings, visits, booked_as_guest from v_people
      where phone = '5554440002' order by person_key $$,
  $$ values ('  DANA p.', false, 2, 2, 0),
            ('Fred Smith', false, 1, 1, 1),
            ('Kai', true, 1, 1, 1) $$,
  'v_people: Dana twice, the kid flagged by the Kids Cut, both guests counted'
);

select lives_ok(
  $$ select cancel_booking(
       (select id from bookings where customer_name = 'Fred Smith'), '5554440002') $$,
  'the friend cancels'
);
select is(
  (select count(*)::int from v_people where phone = '5554440002'),
  2, 'a cancelled booking drops out of v_people'
);
select is(
  (select bookings from v_people where person_key = '5554440003:long'),
  1, 'a two-slot service is one booking, not two'
);

select * from finish();
rollback;
