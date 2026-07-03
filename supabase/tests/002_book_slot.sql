-- 002_book_slot.sql — pgTAP: the single-booking RPC end to end.
-- Hours enforcement (store + per-barber), validation, double-booking,
-- multi-slot VIP, server-side pricing, rate limiting. Rolls back.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- Deterministic future dates: next <dow> at least 7 days out (inside the
-- 60-day booking window, never today).  0=Sun … 6=Sat.
create function tap_next_dow(p_dow int) returns date language sql as $$
  select (current_date + ((p_dow - extract(dow from current_date)::int + 7) % 7 + 7))::date
$$;

-- ---------- Happy path ----------
select lives_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '11:00', 'Tap Customer', '5551110001') $$,
  'javier books a Wednesday 11:00 hair cut'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5551110001' and status = 'confirmed'),
  1, 'the booking landed as confirmed (no hold)'
);

select lives_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '09:00', 'Early Bird', '5551110002') $$,
  'javier takes the 9:00 opener (store + barber both open)'
);
select lives_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '17:30', 'Last Slot', '5551110003') $$,
  'the 17:30 slot books (ends exactly at close)'
);
select lives_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(2), '11:00', 'Tue Customer', '5551110004') $$,
  'javier works Tuesdays'
);

-- ---------- Hours enforcement ----------
select throws_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(3), '09:00', 'Too Early', '5551110005') $$,
  '22023', 'outside_working_hours',
  'hassan cannot be booked at 9:00 (he starts at 10)'
);
select throws_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(2), '11:00', 'Tue Try', '5551110006') $$,
  '22023', 'outside_working_hours',
  'hassan cannot be booked on Tuesdays'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(0), '11:00', 'Sun Try', '5551110007') $$,
  '22023', 'outside_working_hours',
  'javier cannot be booked on Sundays (his day off)'
);
select lives_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(0), '11:00', 'Sun Cut', '5551110027') $$,
  'hassan works Sundays'
);
select throws_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(0), '09:30', 'Sun Early', '5551110028') $$,
  '22023', 'store_closed',
  'sunday opens at 10 — the 9:30 slot does not exist'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '18:00', 'Late Try', '5551110008') $$,
  '22023', 'store_closed',
  'the 18:00 slot does not exist (store closes at 6)'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '08:30', 'Dawn Try', '5551110009') $$,
  '22023', 'store_closed',
  'the 8:30 slot does not exist (store opens at 9)'
);

-- ---------- Input validation ----------
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '11:15', 'Off Grid', '5551110010') $$,
  '22023', 'invalid_slot_alignment',
  'slots must sit on the half hour'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', current_date - 1, '11:00', 'Yesterday', '5551110011') $$,
  '22023', 'date_out_of_range',
  'past dates are rejected'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', current_date + 61, '11:00', 'Far Future', '5551110012') $$,
  '22023', 'date_out_of_range',
  'bookings cap at 60 days out'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '12:00', 'Short Phone', '55511') $$,
  '22023', 'invalid_phone',
  'phone must have at least 10 digits'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '12:00', 'X', '5551110013') $$,
  '22023', 'invalid_name',
  'name must be at least 2 characters'
);
select throws_ok(
  $$ select * from book_slot('nobody', 'hair-cut', tap_next_dow(3), '12:00', 'Ghost Barber', '5551110014') $$,
  'P0002', 'barber_not_found',
  'unknown barber slug is rejected'
);
select throws_ok(
  $$ select * from book_slot('javier', 'mullet-deluxe', tap_next_dow(3), '12:00', 'Ghost Service', '5551110015') $$,
  'P0002', 'service_not_found',
  'unknown service slug is rejected'
);

-- ---------- Double-booking is impossible ----------
select lives_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '13:00', 'First Wins', '5551110016') $$,
  'first customer takes 13:00'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '13:00', 'Second Loses', '5551110017') $$,
  '23505', 'slot_taken',
  'second customer on the same slot gets slot_taken'
);
select lives_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(3), '13:00', 'Other Chair', '5551110018') $$,
  'the same time with the OTHER barber is a different slot'
);

-- ---------- Server-side pricing (never trust the client) ----------
select is(
  (select max(total_price_cents)::int
     from book_slot('javier', 'hair-cut', tap_next_dow(3), '12:00', 'Price Check', '5551110019',
                    array['beard', 'facial'])),
  6000,
  'hair cut + beard + facial totals $60 from DB prices'
);
select is(
  (select max(total_price_cents)::int
     from book_slot('javier', 'hair-cut', tap_next_dow(3), '12:30', 'Bogus Addon', '5551110020',
                    array['free-money-glitch'])),
  3000,
  'unknown add-on slugs are ignored, not priced'
);

-- ---------- VIP: 60 minutes = two linked slots, all-or-nothing ----------
select is(
  (select count(*)::int
     from book_slot('javier', 'vip-haircut', tap_next_dow(3), '14:00', 'Vip Two', '5551110021')),
  2, 'a VIP booking returns two slot rows'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5551110021' and status = 'confirmed'),
  2, 'both VIP slots are locked in the table'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5551110021' and linked_to is not null),
  1, 'the continuation slot links back to the primary'
);
select throws_ok(
  $$ select * from book_slot('javier', 'vip-haircut', tap_next_dow(3), '17:30', 'Vip Late', '5551110022') $$,
  '22023', 'store_closed',
  'a VIP cannot start at 17:30 — its second half falls past closing'
);

-- VIP overlap: 15:30 is taken, so a 15:00 VIP (needs 15:00 + 15:30) must fail
-- AND leave nothing behind (transaction-level all-or-nothing).
select lives_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '15:30', 'Blocker', '5551110023') $$,
  'a regular cut holds 15:30'
);
select throws_ok(
  $$ select * from book_slot('javier', 'vip-haircut', tap_next_dow(3), '15:00', 'Vip Overlap', '5551110024') $$,
  '23505', 'slot_taken',
  'a VIP overlapping an existing booking is rejected'
);
select is(
  (select count(*)::int from bookings where customer_phone = '5551110024'),
  0, 'the failed VIP left no partial rows behind'
);

-- ---------- One-off closures ----------
insert into barber_closures (barber_id, closure_date, reason)
select id, tap_next_dow(5), 'pgTAP holiday' from barbers where slug = 'javier';
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(5), '11:00', 'Holiday Try', '5551110025') $$,
  '22023', 'barber_closed',
  'a closure day blocks booking even inside normal hours'
);

-- ---------- Per-phone rate limit: max 6 active future slots ----------
select lives_ok(
  $$ select * from book_slot_group('javier', tap_next_dow(4), '10:00', '5551110026',
       '[{"name":"P One","service_slug":"hair-cut"},{"name":"P Two","service_slug":"hair-cut"},
         {"name":"P Three","service_slug":"hair-cut"},{"name":"P Four","service_slug":"hair-cut"},
         {"name":"P Five","service_slug":"hair-cut"},{"name":"P Six","service_slug":"hair-cut"}]'::jsonb) $$,
  'a phone can hold six active slots (full group)'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(4), '14:00', 'One Too Many', '5551110026') $$,
  '23505', 'too_many_active_bookings',
  'the seventh active slot for one phone is rejected'
);

select * from finish();
rollback;
