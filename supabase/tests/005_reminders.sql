-- 005_reminders.sql — pgTAP: SMS reminder columns, the booking RPC flags,
-- reminders_due(), rebook_due(), mark_reminder_sent(), and their grants.
-- Rolls back.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function tap_next_dow(p_dow int) returns date language sql as $$
  select (current_date + ((p_dow - extract(dow from current_date)::int + 7) % 7 + 7))::date
$$;

-- Inserts a primary booking starting at p_at (shop-local date and time are
-- derived from it, so slot_at = p_at). Bypasses book_slot's hour and date
-- rules so the due windows can be tested to the minute, past and future.
create function tap_book(
  p_phone  text,
  p_name   text,
  p_at     timestamptz,
  p_status booking_status default 'confirmed',
  p_barber text           default 'hassan',
  p_remind boolean        default true,
  p_rebook boolean        default false
) returns uuid language sql as $$
  insert into bookings (barber_id, service_id, booking_date, booking_time,
                        customer_name, customer_phone, total_price_cents,
                        status, hold_expires_at, remind_sms, rebook_sms)
  select b.id, s.id,
         (p_at at time zone 'America/New_York')::date,
         (p_at at time zone 'America/New_York')::time,
         p_name, p_phone, 3000, p_status,
         case when p_status = 'pending' then now() + interval '15 minutes' end,
         p_remind, p_rebook
    from barbers b, services s
   where b.slug = p_barber and s.slug = 'hair-cut'
  returning id
$$;

create function tap_reminder_ids(p_phone text) returns uuid[] language sql as $$
  select booking_ids from reminders_due() where phone = p_phone
$$;

create function tap_rebook_due(p_phone text) returns boolean language sql as $$
  select exists (select 1 from rebook_due() where phone = p_phone)
$$;

-- ---------- Schema ----------
select is(
  (select n.nspname::text from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_net'),
  'extensions', 'pg_net is installed in the extensions schema'
);
select has_column('public', 'bookings', 'remind_sms',       'bookings.remind_sms exists');
select has_column('public', 'bookings', 'rebook_sms',       'bookings.rebook_sms exists');
select has_column('public', 'bookings', 'reminder_sent_at', 'bookings.reminder_sent_at exists');
select has_column('public', 'bookings', 'rebook_sent_at',   'bookings.rebook_sent_at exists');
select has_column('public', 'bookings', 'sms_last_error',   'bookings.sms_last_error exists');
select col_not_null('public', 'bookings', 'remind_sms', 'remind_sms is not null');
select col_not_null('public', 'bookings', 'rebook_sms', 'rebook_sms is not null');
select col_default_is('public', 'bookings', 'remind_sms', 'true',  'remind_sms defaults to true');
select col_default_is('public', 'bookings', 'rebook_sms', 'false', 'rebook_sms defaults to false');

select is(
  (select count(*)::int from pg_proc where proname = 'book_slot' and pronamespace = 'public'::regnamespace),
  1, 'exactly one book_slot overload'
);
select is(
  (select count(*)::int from pg_proc where proname = 'book_slot_group' and pronamespace = 'public'::regnamespace),
  1, 'exactly one book_slot_group overload'
);

-- ---------- Consent first: rows that predate 0019 are opted out ----------
-- Replays 0019's own remind_sms statements, read from the CLI's migration
-- history (supabase_migrations.schema_migrations): the column is dropped
-- (inside this transaction), a row is inserted with an old updated_at, then
-- the two statements run against it.
select is(
  (select count(*)::int from supabase_migrations.schema_migrations, unnest(statements) st
    where version = '0019' and st ~* 'update\s+bookings\s+set\s+remind_sms'),
  0, '0019 has no UPDATE of remind_sms'
);
select is(
  (select count(*)::int from supabase_migrations.schema_migrations, unnest(statements) st
    where version = '0019'
      and (st ~* 'add\s+column\s+if\s+not\s+exists\s+remind_sms\s+boolean\s+not\s+null\s+default\s+false'
        or st ~* 'alter\s+column\s+remind_sms\s+set\s+default\s+true')),
  2, '0019 adds remind_sms with default false, then sets the default to true'
);

alter table bookings drop column remind_sms;
insert into bookings (barber_id, service_id, booking_date, booking_time,
                      customer_name, customer_phone, total_price_cents, status,
                      created_at, updated_at)
select b.id, s.id, ((now() + interval '23 hours 30 minutes') at time zone 'America/New_York')::date,
       ((now() + interval '23 hours 30 minutes') at time zone 'America/New_York')::time,
       'Booked Before', '5554448001', 3000, 'confirmed',
       '2026-01-01 12:00+00', '2026-01-01 12:00+00'
  from barbers b, services s
 where b.slug = 'hassan' and s.slug = 'hair-cut';
do $$
declare st text;
begin
  for st in
    select x from supabase_migrations.schema_migrations, unnest(statements) with ordinality u(x, n)
     where version = '0019'
       and (x ~* 'add\s+column\s+if\s+not\s+exists\s+remind_sms\s'
         or x ~* 'alter\s+column\s+remind_sms\s+set\s+default')
     order by n
  loop
    execute st;
  end loop;
end $$;
select is(
  (select remind_sms from bookings where customer_phone = '5554448001'),
  false, 'a booking that existed before the migration has remind_sms false'
);
select is(
  (select updated_at from bookings where customer_phone = '5554448001'),
  '2026-01-01 12:00+00'::timestamptz, 'and its updated_at is unchanged'
);
select is(tap_reminder_ids('5554448001'), null, 'and is not due a reminder');

insert into bookings (barber_id, service_id, booking_date, booking_time,
                      customer_name, customer_phone, total_price_cents, status)
select b.id, s.id, tap_next_dow(5), '11:00', 'Booked After', '5554448002', 3000, 'confirmed'
  from barbers b, services s
 where b.slug = 'hassan' and s.slug = 'hair-cut';
select results_eq(
  $$ select remind_sms, rebook_sms from bookings where customer_phone = '5554448002' $$,
  $$ values (true, false) $$,
  'a booking inserted after it takes the defaults: remind on, rebook off'
);

-- ---------- Booking RPCs store the flags ----------
select lives_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(3), '10:00', 'Default Flags', '5554449001') $$,
  'book_slot without the new arguments still works'
);
select results_eq(
  $$ select remind_sms, rebook_sms from bookings where customer_phone = '5554449001' $$,
  $$ values (true, false) $$,
  'book_slot defaults: remind on, rebook off'
);
select lives_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(3), '10:45', 'Set Flags', '5554449002',
                             p_remind_sms => false, p_rebook_sms => true) $$,
  'book_slot accepts p_remind_sms / p_rebook_sms'
);
select results_eq(
  $$ select remind_sms, rebook_sms from bookings where customer_phone = '5554449002' $$,
  $$ values (false, true) $$,
  'book_slot stores the passed flags'
);

insert into services (slug, display_name, base_price_cents, duration_minutes, sort_order)
values ('tap-long', 'pgTAP Two-Slot Service', 9000, 90, 999);

select lives_ok(
  $$ select * from book_slot_group('larry', tap_next_dow(3), '10:00', '5554449003',
       '[{"name":"Group Long","service_slug":"tap-long"},
         {"name":"Group Kid","service_slug":"kids-cut"}]'::jsonb) $$,
  'book_slot_group without the new arguments still works'
);
select results_eq(
  $$ select count(*)::int, bool_and(remind_sms), bool_or(rebook_sms)
       from bookings where customer_phone = '5554449003' $$,
  $$ values (3, true, false) $$,
  'book_slot_group defaults on all three rows (two people, one continuation)'
);
select lives_ok(
  $$ select * from book_slot_group('larry', tap_next_dow(4), '10:00', '5554449004',
       '[{"name":"Group Long","service_slug":"tap-long"},
         {"name":"Group Kid","service_slug":"kids-cut"}]'::jsonb,
       p_remind_sms => false, p_rebook_sms => true) $$,
  'book_slot_group accepts p_remind_sms / p_rebook_sms'
);
select results_eq(
  $$ select count(*)::int, bool_or(remind_sms), bool_and(rebook_sms)
       from bookings where customer_phone = '5554449004' $$,
  $$ values (3, false, true) $$,
  'book_slot_group stores the passed flags on every row, continuation included'
);

-- ---------- reminders_due: the 23-25 hour window ----------
select tap_book('5554440001', 'Edge Early', now() + interval '23 hours');
select tap_book('5554440002', 'Edge Late',  now() + interval '25 hours');
select tap_book('5554440003', 'Too Soon',   now() + interval '23 hours' - interval '1 minute');
select tap_book('5554440004', 'Too Far',    now() + interval '25 hours' + interval '1 minute');

select isnt(tap_reminder_ids('5554440001'), null, 'due at exactly 23 hours');
select isnt(tap_reminder_ids('5554440002'), null, 'due at exactly 25 hours');
select is(tap_reminder_ids('5554440003'), null, 'not due at 22h59m');
select is(tap_reminder_ids('5554440004'), null, 'not due at 25h01m');

-- ---------- reminders_due: flags, sent marker, status ----------
select tap_book('5554440005', 'Opted Out', now() + interval '24 hours', p_remind => false);
select is(tap_reminder_ids('5554440005'), null, 'remind_sms false is never due');

select tap_book('5554440006', 'Already Sent', now() + interval '24 hours 1 minute');
update bookings set reminder_sent_at = now() where customer_phone = '5554440006';
select is(tap_reminder_ids('5554440006'), null, 'reminder_sent_at set is never due');

select tap_book('5554440007', 'Cancelled', now() + interval '24 hours 2 minutes', 'cancelled');
select is(tap_reminder_ids('5554440007'), null, 'cancelled bookings are excluded');

select tap_book('5554440008', 'Pending', now() + interval '24 hours 3 minutes', 'pending');
select is(tap_reminder_ids('5554440008'), null, 'pending bookings are excluded (only confirmed)');

select tap_book('5554440009', 'Done Already', now() + interval '24 hours 4 minutes', 'no_show');
select is(tap_reminder_ids('5554440009'), null, 'no_show bookings are excluded');

-- ---------- reminders_due: one row per phone per day ----------
-- Three people from one phone with one barber. The third starts 90 minutes
-- before or after the first (whichever stays on the same shop-local day),
-- so it is outside the 23-25 hour window but still on the same day.
select tap_book('5554440010', 'Dad One', now() + interval '24 hours', p_barber => 'larry');
select tap_book('5554440010', 'Kid Two', now() + interval '24 hours 45 minutes', p_barber => 'larry')
 where ((now() + interval '24 hours 45 minutes') at time zone 'America/New_York')::date
     = ((now() + interval '24 hours') at time zone 'America/New_York')::date;
select tap_book('5554440010', 'Kid Two', now() + interval '23 hours 15 minutes', p_barber => 'larry')
 where ((now() + interval '24 hours 45 minutes') at time zone 'America/New_York')::date
    <> ((now() + interval '24 hours') at time zone 'America/New_York')::date;
select tap_book('5554440010', 'Late Three',
  case when ((now() + interval '25 hours 30 minutes') at time zone 'America/New_York')::date
          = ((now() + interval '24 hours') at time zone 'America/New_York')::date
       then now() + interval '25 hours 30 minutes'
       else now() + interval '22 hours 30 minutes' end,
  p_barber => 'larry');
select tap_book('5554440010', 'Cancelled Four', now() + interval '24 hours 10 minutes', 'cancelled', 'larry');

select is(
  (select count(*)::int from reminders_due() where phone = '5554440010'),
  1, 'a group from one phone is one row'
);
select is(
  array_length(tap_reminder_ids('5554440010'), 1),
  3, 'the row lists all three confirmed people, including the one outside the window'
);
select is(
  (select array_agg(p ->> 'name' order by p ->> 'time')
     from reminders_due() r, jsonb_array_elements(r.people) p
    where r.phone = '5554440010'
      and p ->> 'name' in ('Dad', 'Kid')),
  (select array_agg(split_part(customer_name, ' ', 1) order by booking_time)
     from bookings
    where customer_phone = '5554440010' and customer_name in ('Dad One', 'Kid Two')),
  'people carry first names in start-time order'
);
select is(
  (select count(*)::int from reminders_due() r, jsonb_array_elements(r.people) p
    where r.phone = '5554440010' and p ->> 'barber' = 'Larry'),
  3, 'each person carries the barber name'
);
select is(
  (select appointment_date from reminders_due() where phone = '5554440010'),
  ((now() + interval '24 hours') at time zone 'America/New_York')::date,
  'appointment_date is the shop-local date'
);

-- The same number stored with and without the US country code is one phone.
select tap_book('15554440011', 'Plus One', now() + interval '24 hours 20 minutes');
select tap_book('5554440011',  'No Plus',  now() + interval '24 hours 21 minutes', p_barber => 'larry');
select is(
  array_length(tap_reminder_ids('5554440011'), 1),
  2, '1-prefixed and 10-digit forms group as one phone'
);
select is(
  (select count(*)::int from reminders_due() where phone = '15554440011'),
  0, 'the phone is reported in its 10-digit form'
);

-- A booking the next day from the same phone is not pulled into this text.
select tap_book('5554440012', 'Tomorrow', now() + interval '24 hours 30 minutes');
select tap_book('5554440012', 'Day After', now() + interval '48 hours 30 minutes');
select is(
  array_length(tap_reminder_ids('5554440012'), 1),
  1, 'only the same day is listed'
);

-- Two phones at the same hour are two rows.
select tap_book('5554440013', 'Phone A', now() + interval '24 hours 40 minutes');
select tap_book('5554440014', 'Phone B', now() + interval '24 hours 40 minutes', p_barber => 'larry');
select is(
  (select count(*)::int from reminders_due() where phone in ('5554440013', '5554440014')),
  2, 'two phones are two rows'
);

-- ---------- mark_reminder_sent ----------
select is(
  mark_reminder_sent(tap_reminder_ids('5554440010'), 'reminder'),
  3, 'marking the group sets three rows'
);
select is(tap_reminder_ids('5554440010'), null, 'a marked group is no longer due');
select is(
  (select count(*)::int from bookings where customer_phone = '5554440010' and reminder_sent_at is not null),
  3, 'reminder_sent_at is set on the marked rows only (the cancelled row stays null)'
);
select is(
  mark_reminder_sent((select array_agg(id) from bookings
                       where customer_phone = '5554440010' and status = 'confirmed'), 'reminder'),
  0, 'marking again changes nothing'
);
select is(
  (select sms_last_error from bookings where customer_phone = '5554440010' and status = 'confirmed' limit 1),
  null, 'a plain mark leaves sms_last_error null'
);

-- A permanent Twilio rejection marks the row and keeps the reason.
select tap_book('5554440015', 'Unsubscribed', now() + interval '24 hours 50 minutes');
select is(
  mark_reminder_sent(tap_reminder_ids('5554440015'), 'reminder',
                     '21610: Attempt to send to unsubscribed recipient'),
  1, 'marking with an error sets one row'
);
select is(tap_reminder_ids('5554440015'), null, 'a row marked with an error is no longer due');
select results_eq(
  $$ select reminder_sent_at is not null, sms_last_error from bookings where customer_phone = '5554440015' $$,
  $$ values (true, '21610: Attempt to send to unsubscribed recipient') $$,
  'reminder_sent_at and sms_last_error are both set'
);
select is(
  mark_reminder_sent((select array_agg(id) from bookings where customer_phone = '5554440015'), 'reminder'),
  0, 'a later mark without an error changes nothing on that row'
);
select is(
  (select sms_last_error from bookings where customer_phone = '5554440015'),
  '21610: Attempt to send to unsubscribed recipient', 'and the reason is kept'
);

select throws_ok(
  $$ select mark_reminder_sent(array[gen_random_uuid()], 'other') $$,
  '22023', 'invalid_kind',
  'unknown kind is rejected'
);

-- ---------- rebook_due: the 21-42 day window ----------
select tap_book('5554441001', 'Rebook 21', now() - interval '21 days', p_rebook => true);
select tap_book('5554441002', 'Rebook 42', now() - interval '42 days', p_rebook => true);
select tap_book('5554441003', 'Rebook 20', now() - interval '21 days' + interval '1 minute', p_rebook => true);
select tap_book('5554441004', 'Rebook 43', now() - interval '42 days' - interval '1 minute', p_rebook => true);

select is(tap_rebook_due('5554441001'), true,  'rebook due at exactly 21 days');
select is(tap_rebook_due('5554441002'), true,  'rebook due at exactly 42 days');
select is(tap_rebook_due('5554441003'), false, 'rebook not due at 20d23h59m');
select is(tap_rebook_due('5554441004'), false, 'rebook not due at 42d00h01m');

select is(
  (select barber_name from rebook_due() where phone = '5554441001'),
  'Hassan', 'rebook row carries the barber of the last visit'
);

-- ---------- rebook_due: flags and sent marker ----------
select tap_book('5554441005', 'No Opt In', now() - interval '25 days 1 minutes');
select is(tap_rebook_due('5554441005'), false, 'rebook_sms false is never due');

select tap_book('5554441006', 'Rebook Sent', now() - interval '25 days 2 minutes', p_rebook => true);
update bookings set rebook_sent_at = now() where customer_phone = '5554441006';
select is(tap_rebook_due('5554441006'), false, 'rebook_sent_at set is never due');

select tap_book('5554441007', 'Completed', now() - interval '25 days 3 minutes', 'completed', p_rebook => true);
select is(tap_rebook_due('5554441007'), true, 'a completed visit counts');

select tap_book('5554441008', 'Cancelled Visit', now() - interval '25 days 4 minutes', 'cancelled', p_rebook => true);
select is(tap_rebook_due('5554441008'), false, 'a cancelled visit is not a visit');

-- ---------- rebook_due: most recent visit, no later booking ----------
select tap_book('5554441009', 'Has Next', now() - interval '25 days 5 minutes', p_rebook => true);
select tap_book('5554441009', 'Has Next', now() + interval '5 days');
select is(tap_rebook_due('5554441009'), false, 'a later confirmed booking blocks the nudge');

select tap_book('5554441010', 'Next Cancelled', now() - interval '25 days 6 minutes', p_rebook => true);
select tap_book('5554441010', 'Next Cancelled', now() + interval '5 days', 'cancelled');
select is(tap_rebook_due('5554441010'), true, 'a later cancelled booking does not block it');

select tap_book('5554441011', 'Came Back', now() - interval '30 days', p_rebook => true);
select tap_book('5554441011', 'Came Back', now() - interval '10 days', p_rebook => true);
select is(tap_rebook_due('5554441011'), false, 'the most recent visit (10 days ago) decides');

select tap_book('5554441012', 'Opted Out Later', now() - interval '35 days', p_rebook => true);
select tap_book('5554441012', 'Opted Out Later', now() - interval '25 days 7 minutes', p_rebook => false);
select is(tap_rebook_due('5554441012'), false, 'the flag on the most recent visit decides');

select tap_book('15554441013', 'Plus Form', now() - interval '25 days 8 minutes', p_rebook => true);
select tap_book('5554441013',  'Plus Form', now() + interval '3 days');
select is(tap_rebook_due('5554441013'), false, 'a later booking under the other phone form blocks it');

select is(
  (select count(*)::int from rebook_due() where phone = '5554441001'),
  1, 'one row per phone'
);

-- ---------- mark_reminder_sent('rebook') ----------
select is(
  mark_reminder_sent((select booking_ids from rebook_due() where phone = '5554441001'), 'rebook'),
  1, 'marking a rebook sets one row'
);
select is(tap_rebook_due('5554441001'), false, 'a marked rebook is no longer due');
select is(
  (select reminder_sent_at from bookings where customer_phone = '5554441001'),
  null, 'rebook marking leaves reminder_sent_at alone'
);

select is(
  mark_reminder_sent((select booking_ids from rebook_due() where phone = '5554441002'), 'rebook',
                     '21211: Invalid ''To'' Phone Number'),
  1, 'a rebook marked with an error sets one row'
);
select results_eq(
  $$ select rebook_sent_at is not null, reminder_sent_at is null, sms_last_error
       from bookings where customer_phone = '5554441002' $$,
  $$ values (true, true, '21211: Invalid ''To'' Phone Number') $$,
  'rebook_sent_at and sms_last_error are set, reminder_sent_at is not'
);
select is(tap_rebook_due('5554441002'), false, 'that rebook is no longer due');

select is(
  (select count(*)::int from pg_proc where proname = 'mark_reminder_sent' and pronamespace = 'public'::regnamespace),
  1, 'exactly one mark_reminder_sent overload'
);

-- ---------- claim_reminders: the 10-minute claim window ----------
select has_column('public', 'bookings', 'reminder_claimed_at', 'bookings.reminder_claimed_at exists');
select has_column('public', 'bookings', 'rebook_claimed_at',   'bookings.rebook_claimed_at exists');

select tap_book('5554442001', 'Claim One', now() + interval '24 hours 55 minutes');
select tap_book('5554442001', 'Claim Two', now() + interval '24 hours 55 minutes', p_barber => 'larry');

select is(
  (select array_agg(p ->> 'id' order by p ->> 'id')
     from reminders_due() r, jsonb_array_elements(r.people) p where r.phone = '5554442001'),
  (select array_agg(id::text order by id::text) from bookings where customer_phone = '5554442001'),
  'each person in a reminder row carries its booking id'
);

select is(
  array_length(claim_reminders('reminder', tap_reminder_ids('5554442001')), 1),
  2, 'a first claim gets both rows'
);
select is(
  claim_reminders('reminder', tap_reminder_ids('5554442001')),
  '{}'::uuid[], 'a second claim gets nothing'
);
select isnt(tap_reminder_ids('5554442001'), null, 'a claimed row is still due until it is marked');
update bookings set rebook_sms = true where customer_phone = '5554442001';
select is(
  array_length(claim_reminders('rebook', tap_reminder_ids('5554442001')), 1),
  2, 'a reminder claim does not block a rebook claim'
);

update bookings set reminder_claimed_at = now() - interval '10 minutes'
 where customer_phone = '5554442001';
select is(
  claim_reminders('reminder', tap_reminder_ids('5554442001')),
  '{}'::uuid[], 'a claim exactly 10 minutes old still holds'
);

update bookings set reminder_claimed_at = now() - interval '10 minutes 1 second'
 where customer_phone = '5554442001';
select is(
  array_length(claim_reminders('reminder', tap_reminder_ids('5554442001')), 1),
  2, 'a claim older than 10 minutes can be taken again'
);

update bookings set reminder_claimed_at = now() - interval '11 minutes'
 where customer_phone = '5554442001' and customer_name = 'Claim Two';
select is(
  claim_reminders('reminder', tap_reminder_ids('5554442001')),
  (select array_agg(id) from bookings where customer_phone = '5554442001' and customer_name = 'Claim Two'),
  'only the expired row of a group is claimed'
);

select mark_reminder_sent(tap_reminder_ids('5554442001'), 'reminder');
update bookings set reminder_claimed_at = null where customer_phone = '5554442001';
select is(
  claim_reminders('reminder', (select array_agg(id) from bookings where customer_phone = '5554442001')),
  '{}'::uuid[], 'a sent row cannot be claimed'
);
select is(
  claim_reminders('reminder', array[gen_random_uuid()]),
  '{}'::uuid[], 'unknown ids claim nothing'
);
-- Eligibility is re-checked at claim time: a row listed by the due query
-- that is cancelled or opted out before the send is not claimed.
select tap_book('5554442002', 'Cancel Later', now() + interval '24 hours 56 minutes');
select tap_book('5554442003', 'Opt Out Later', now() + interval '24 hours 57 minutes');
create temp table tap_listed on commit drop as
  select phone, booking_ids from reminders_due() where phone in ('5554442002', '5554442003');
select is((select count(*)::int from tap_listed), 2, 'both rows are due before the change');
update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer'
 where customer_phone = '5554442002';
update bookings set remind_sms = false where customer_phone = '5554442003';
select is(tap_reminder_ids('5554442002'), null, 'the cancelled row is no longer due');
select is(tap_reminder_ids('5554442003'), null, 'the opted-out row is no longer due');
select is(
  claim_reminders('reminder', (select booking_ids from tap_listed where phone = '5554442002')),
  '{}'::uuid[], 'a booking cancelled after the due query is not claimed'
);
select is(
  claim_reminders('reminder', (select booking_ids from tap_listed where phone = '5554442003')),
  '{}'::uuid[], 'a booking opted out of reminders after the due query is not claimed'
);

select tap_book('5554442004', 'Rebook Cancelled', now() - interval '26 days', 'cancelled', p_rebook => true);
select tap_book('5554442005', 'Rebook Off',       now() - interval '26 days 1 minute', p_rebook => false);
select tap_book('5554442006', 'Rebook Done',      now() - interval '26 days 2 minutes', 'completed', p_rebook => true);
select is(
  claim_reminders('rebook', (select array_agg(id) from bookings where customer_phone = '5554442004')),
  '{}'::uuid[], 'a cancelled booking is not claimed for a rebook'
);
select is(
  claim_reminders('rebook', (select array_agg(id) from bookings where customer_phone = '5554442005')),
  '{}'::uuid[], 'a booking with rebook_sms false is not claimed for a rebook'
);
select is(
  array_length(claim_reminders('rebook', (select array_agg(id) from bookings where customer_phone = '5554442006')), 1),
  1, 'a completed booking with rebook_sms is claimed for a rebook'
);

select throws_ok(
  $$ select claim_reminders('other', array[gen_random_uuid()]) $$,
  '22023', 'invalid_kind',
  'claim_reminders rejects an unknown kind'
);

-- ---------- SMS bookkeeping leaves updated_at alone ----------
-- now() is fixed inside this transaction, so the row starts with an old
-- updated_at: any bump would move it to now().
select tap_book('5554443001', 'Stamp Check', now() + interval '24 hours 58 minutes');
update bookings set updated_at = '2026-01-01 12:00+00' where customer_phone = '5554443001';
select is(
  (select updated_at from bookings where customer_phone = '5554443001'),
  now(), 'control: a normal update bumps updated_at'
);
alter table bookings disable trigger bookings_updated_at;
update bookings set updated_at = '2026-01-01 12:00+00' where customer_phone = '5554443001';
alter table bookings enable trigger bookings_updated_at;

select is(
  array_length(claim_reminders('reminder', tap_reminder_ids('5554443001')), 1),
  1, 'the row is claimed'
);
select is(
  (select updated_at from bookings where customer_phone = '5554443001'),
  '2026-01-01 12:00+00'::timestamptz, 'a claim leaves updated_at unchanged'
);
select is(
  mark_reminder_sent((select array_agg(id) from bookings where customer_phone = '5554443001'), 'reminder'),
  1, 'the row is marked'
);
select is(
  (select updated_at from bookings where customer_phone = '5554443001'),
  '2026-01-01 12:00+00'::timestamptz, 'a mark leaves updated_at unchanged'
);
select is(
  (select reminder_claimed_at is not null and reminder_sent_at is not null
     from bookings where customer_phone = '5554443001'),
  true, 'the claim and the mark were written'
);
select is(current_setting('fe.sms_bookkeeping', true), 'off', 'the setting is off again after the call');
update bookings set customer_notes = 'later edit' where customer_phone = '5554443001';
select is(
  (select updated_at from bookings where customer_phone = '5554443001'),
  now(), 'a normal update in the same transaction still bumps updated_at'
);

-- ---------- Ownership and grants ----------
select is(
  (select bool_and(prosecdef) from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('reminders_due', 'rebook_due', 'mark_reminder_sent', 'claim_reminders')),
  true, 'the four reminder functions are security definer'
);
select is(
  (select count(distinct proowner)::int from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('reminders_due', 'rebook_due', 'mark_reminder_sent', 'claim_reminders', 'confirm_booking')),
  1, 'the reminder functions have the same owner as confirm_booking'
);

select is(has_function_privilege('anon', 'claim_reminders(text, uuid[])', 'execute'), false, 'anon has no execute on claim_reminders');
select is(has_function_privilege('authenticated', 'claim_reminders(text, uuid[])', 'execute'), false, 'authenticated has no execute on claim_reminders');
select is(has_function_privilege('service_role', 'claim_reminders(text, uuid[])', 'execute'), true, 'service_role can execute claim_reminders');
select is(has_function_privilege('anon', 'reminders_due()', 'execute'), false, 'anon has no execute on reminders_due');
select is(has_function_privilege('anon', 'rebook_due()', 'execute'), false, 'anon has no execute on rebook_due');
select is(has_function_privilege('anon', 'mark_reminder_sent(uuid[], text, text)', 'execute'), false, 'anon has no execute on mark_reminder_sent');
select is(has_function_privilege('authenticated', 'reminders_due()', 'execute'), false, 'authenticated has no execute on reminders_due');
select is(has_function_privilege('authenticated', 'rebook_due()', 'execute'), false, 'authenticated has no execute on rebook_due');
select is(has_function_privilege('authenticated', 'mark_reminder_sent(uuid[], text, text)', 'execute'), false, 'authenticated has no execute on mark_reminder_sent');
select is(has_function_privilege('service_role', 'reminders_due()', 'execute'), true, 'service_role can execute reminders_due');
select is(has_function_privilege('service_role', 'rebook_due()', 'execute'), true, 'service_role can execute rebook_due');
select is(has_function_privilege('service_role', 'mark_reminder_sent(uuid[], text, text)', 'execute'), true, 'service_role can execute mark_reminder_sent');

set local role anon;
select throws_ok($$ select * from reminders_due() $$, '42501', null, 'anon cannot call reminders_due');
select throws_ok($$ select * from rebook_due() $$, '42501', null, 'anon cannot call rebook_due');
select throws_ok($$ select mark_reminder_sent(array[gen_random_uuid()], 'reminder') $$, '42501', null, 'anon cannot call mark_reminder_sent');
select throws_ok($$ select claim_reminders('reminder', array[gen_random_uuid()]) $$, '42501', null, 'anon cannot call claim_reminders');
reset role;

set local role authenticated;
select throws_ok($$ select * from reminders_due() $$, '42501', null, 'authenticated cannot call reminders_due');
select throws_ok($$ select * from rebook_due() $$, '42501', null, 'authenticated cannot call rebook_due');
select throws_ok($$ select mark_reminder_sent(array[gen_random_uuid()], 'reminder') $$, '42501', null, 'authenticated cannot call mark_reminder_sent');
select throws_ok($$ select claim_reminders('reminder', array[gen_random_uuid()]) $$, '42501', null, 'authenticated cannot call claim_reminders');
reset role;

set local role service_role;
select lives_ok($$ select * from reminders_due() $$, 'service_role can call reminders_due');
select lives_ok($$ select * from rebook_due() $$, 'service_role can call rebook_due');
select lives_ok($$ select claim_reminders('reminder', array[gen_random_uuid()]) $$, 'service_role can call claim_reminders');
reset role;

-- The booking RPCs stay open to anon with the new parameters.
select is(
  has_function_privilege('anon', 'book_slot(text, text, date, time, text, text, text[], text, text, text, int, boolean, boolean)', 'execute'),
  true, 'anon can still execute book_slot'
);
select is(
  has_function_privilege('anon', 'book_slot_group(text, date, time, text, jsonb, int, text, boolean, boolean)', 'execute'),
  true, 'anon can still execute book_slot_group'
);

select * from finish();
rollback;
