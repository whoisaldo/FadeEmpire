-- 002_book_slot.sql — pgTAP: the single-booking RPC end to end.
-- Hours enforcement (store + per-barber), validation, double-booking,
-- VIP (one slot), multi-slot machinery, server-side pricing, rate limiting. Rolls back.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- Deterministic future dates: next <dow> at least 7 days out (inside the
-- 60-day booking window, never today).  0=Sun … 6=Sat.
create function tap_next_dow(p_dow int) returns date language sql as $$
  select (current_date + ((p_dow - extract(dow from current_date)::int + 7) % 7 + 7))::date
$$;

-- ---------- Happy path (45-minute grid from the 10:00 open — 0016) ----------
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '11:30', 'Tap Customer', '5551110001') $$,
  'larry books a Wednesday 11:30 hair cut'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5551110001' and status = 'confirmed'),
  1, 'the booking landed as confirmed (no hold)'
);

select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '10:00', 'Early Bird', '5551110002') $$,
  'larry takes the 10:00 opener (store + barber both open at 10)'
);
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '10:45', 'Second Slot', '5551110029') $$,
  'the 10:45 slot books — the grid steps by 45 minutes now'
);
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '17:30', 'Last Slot', '5551110003') $$,
  'the 17:30 closer books (runs to 6:15 — the barber stays past close to finish)'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(2), '11:30', 'Tue Customer', '5551110004') $$,
  '22023', 'store_closed',
  'the shop is closed Tuesdays — larry cannot be booked either (0017)'
);

-- ---------- Hours enforcement ----------
select throws_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(3), '09:00', 'Too Early', '5551110005') $$,
  '22023', 'store_closed',
  'hassan cannot be booked at 9:00 (the store itself opens at 10 now)'
);
select throws_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(2), '11:30', 'Tue Try', '5551110006') $$,
  '22023', 'store_closed',
  'hassan cannot be booked on Tuesdays (the store check runs before the schedule check)'
);
-- A barber off while the store is open is a different error. No such gap
-- exists in the real schedules (both chairs fill the store window), so carve
-- one out inside this transaction: hassan leaves at 2 PM next Monday.
update barber_schedules set close_time = '14:00'
 where barber_id = (select id from barbers where slug = 'hassan') and weekday = 1;
select throws_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(1), '15:15', 'After Hours', '5551110032') $$,
  '22023', 'outside_working_hours',
  'a slot inside store hours but outside the barber''s own schedule raises outside_working_hours'
);
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(0), '12:15', 'Sun Regular', '5551110007') $$,
  'larry works Sundays too (six days — every day but Tuesday)'
);
select lives_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(0), '11:30', 'Sun Cut', '5551110027') $$,
  'hassan works Sundays'
);
select throws_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(0), '09:30', 'Sun Early', '5551110028') $$,
  '22023', 'store_closed',
  'sunday opens at 10 — the 9:30 slot does not exist'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '18:00', 'Late Try', '5551110008') $$,
  '22023', 'store_closed',
  'the 18:00 slot does not exist (store closes at 6)'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '08:30', 'Dawn Try', '5551110009') $$,
  '22023', 'store_closed',
  'the 8:30 slot does not exist (store opens at 10)'
);

-- ---------- Input validation ----------
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '11:15', 'Off Grid', '5551110010') $$,
  '22023', 'invalid_slot_alignment',
  'slots must sit on the 45-minute grid from the 10:00 open'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '11:00', 'Old Grid', '5551110031') $$,
  '22023', 'invalid_slot_alignment',
  'the old half-hour grid is gone — 11:00 no longer aligns'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', current_date - 1, '11:00', 'Yesterday', '5551110011') $$,
  '22023', 'date_out_of_range',
  'past dates are rejected'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', current_date + 61, '11:00', 'Far Future', '5551110012') $$,
  '22023', 'date_out_of_range',
  'bookings cap at 60 days out'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '12:00', 'Short Phone', '55511') $$,
  '22023', 'invalid_phone',
  'phone must have at least 10 digits'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '12:00', 'X', '5551110013') $$,
  '22023', 'invalid_name',
  'name must be at least 2 characters'
);
select throws_ok(
  $$ select * from book_slot('nobody', 'hair-cut', tap_next_dow(3), '12:00', 'Ghost Barber', '5551110014') $$,
  'P0002', 'barber_not_found',
  'unknown barber slug is rejected'
);
select throws_ok(
  $$ select * from book_slot('javier', 'hair-cut', tap_next_dow(3), '12:00', 'Old Regular', '5551110030') $$,
  'P0002', 'barber_not_found',
  'javier is retired — booking him fails like any unknown barber'
);
select throws_ok(
  $$ select * from book_slot('larry', 'mullet-deluxe', tap_next_dow(3), '12:00', 'Ghost Service', '5551110015') $$,
  'P0002', 'service_not_found',
  'unknown service slug is rejected'
);

-- ---------- Double-booking is impossible ----------
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '13:00', 'First Wins', '5551110016') $$,
  'first customer takes 13:00'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '13:00', 'Second Loses', '5551110017') $$,
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
     from book_slot('larry', 'hair-cut', tap_next_dow(3), '12:15', 'Price Check', '5551110019',
                    array['beard', 'facial'])),
  6000,
  'hair cut + beard + facial totals $60 from DB prices'
);
select is(
  (select max(total_price_cents)::int
     from book_slot('larry', 'hair-cut', tap_next_dow(3), '13:45', 'Bogus Addon', '5551110020',
                    array['free-money-glitch'])),
  3000,
  'unknown add-on slugs are ignored, not priced'
);

-- ---------- VIP: 45 minutes = ONE slot, like every other service (0018) ----------
select is(
  (select count(*)::int
     from book_slot('larry', 'vip-haircut', tap_next_dow(3), '14:30', 'Vip One', '5551110021')),
  1, 'a VIP booking returns a single slot row'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5551110021' and linked_to is not null),
  0, 'a VIP has no continuation row'
);
select lives_ok(
  $$ select * from book_slot('hassan', 'vip-haircut', tap_next_dow(3), '17:30', 'Vip Closer', '5551110022') $$,
  'a VIP can take the 17:30 closer now — it fits in one slot'
);

-- ---------- Multi-slot machinery: any service longer than the grid spans linked slots ----------
-- No real service needs two slots anymore, so stand one up for this
-- transaction only (rolled back with everything else): 90 minutes = 2 slots.
insert into services (slug, display_name, base_price_cents, duration_minutes, sort_order)
values ('tap-long', 'pgTAP Two-Slot Service', 9000, 90, 999);

select is(
  (select count(*)::int
     from book_slot('hassan', 'tap-long', tap_next_dow(3), '14:30', 'Long Two', '5551110033')),
  2, 'a two-slot service returns two slot rows'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5551110033' and status = 'confirmed'),
  2, 'both slots are locked in the table'
);
select is(
  (select count(*)::int from bookings
    where customer_phone = '5551110033' and linked_to is not null),
  1, 'the continuation slot links back to the primary'
);
select throws_ok(
  $$ select * from book_slot('larry', 'tap-long', tap_next_dow(4), '17:30', 'Long Late', '5551110034') $$,
  '22023', 'store_closed',
  'a two-slot service cannot start on the 17:30 closer — its second slot falls past closing'
);

-- Overlap: 16:45 is taken, so a 16:00 two-slot booking (needs 16:00 + 16:45)
-- must fail AND leave nothing behind (transaction-level all-or-nothing).
select lives_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(3), '16:45', 'Blocker', '5551110023') $$,
  'a regular cut holds 16:45'
);
select throws_ok(
  $$ select * from book_slot('larry', 'tap-long', tap_next_dow(3), '16:00', 'Long Overlap', '5551110024') $$,
  '23505', 'slot_taken',
  'a two-slot booking overlapping an existing booking is rejected'
);
select is(
  (select count(*)::int from bookings where customer_phone = '5551110024'),
  0, 'the failed two-slot booking left no partial rows behind'
);

-- ---------- One-off closures ----------
insert into barber_closures (barber_id, closure_date, reason)
select id, tap_next_dow(5), 'pgTAP holiday' from barbers where slug = 'larry';
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(5), '11:30', 'Holiday Try', '5551110025') $$,
  '22023', 'barber_closed',
  'a closure day blocks booking even inside normal hours'
);

-- ---------- Per-phone rate limit: max 6 active future slots ----------
select lives_ok(
  $$ select * from book_slot_group('larry', tap_next_dow(4), '10:00', '5551110026',
       '[{"name":"P One","service_slug":"hair-cut"},{"name":"P Two","service_slug":"hair-cut"},
         {"name":"P Three","service_slug":"hair-cut"},{"name":"P Four","service_slug":"hair-cut"},
         {"name":"P Five","service_slug":"hair-cut"},{"name":"P Six","service_slug":"hair-cut"}]'::jsonb) $$,
  'a phone can hold six active slots (full group)'
);
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(4), '14:30', 'One Too Many', '5551110026') $$,
  '23505', 'too_many_active_bookings',
  'the seventh active slot for one phone is rejected'
);

select * from finish();
rollback;
