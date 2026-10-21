-- 007_barber_app.sql — pgTAP: the barber app's database API (0022). Logins and
-- chairs, what each role sees and may change, booking_events from every path,
-- app_free_slots against book_slot, the manager RPCs, activity unread state,
-- devices and push recipients, and the pg_net notify trigger. Rolls back.
--
-- Logins are rows in auth.users with fixed ids; "signing in" is setting
-- request.jwt.claims (what auth.uid() reads) and the authenticated role, the
-- same two things PostgREST does for a request with that user's JWT.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function tap_next_dow(p_dow int) returns date language sql as $$
  select (current_date + ((p_dow - extract(dow from current_date)::int + 7) % 7 + 7))::date
$$;

create function tap_claims(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;

create function tap_barber(p_slug text) returns uuid language sql as $$
  select id from barbers where slug = p_slug
$$;

-- Security definer so it finds the booking whoever is signed in (RLS would hide it).
create function tap_booking(p_phone text) returns uuid language sql security definer as $$
  select id from bookings where customer_phone = p_phone and linked_to is null
   order by created_at desc, booking_time limit 1
$$;

create function tap_events(p_phone text) returns text language sql as $$
  select coalesce(string_agg(e.kind || ':' || e.actor, ',' order by e.id), '')
    from booking_events e join bookings bk on bk.id = e.booking_id
   where bk.customer_phone = p_phone
$$;

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

-- Transaction-local two-slot service, to check continuation rows write no events.
insert into services (slug, display_name, base_price_cents, duration_minutes, sort_order)
values ('tap-long', 'pgTAP Two-Slot Service', 9000, 90, 999);

-- ---------- Logins ----------
-- ali (manager), hassan, larry, and a stranger with a login but no staff row.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-a000-000000000001', 'ali@tap.test',      'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000002', 'hassan@tap.test',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000003', 'larry@tap.test',    'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000004', 'stranger@tap.test', 'authenticated', 'authenticated');

insert into staff (user_id, role, barber_id, display_name, activity_seen_at) values
  ('00000000-0000-4000-a000-000000000001', 'manager', null,                 'Ali',    now() - interval '1 hour'),
  ('00000000-0000-4000-a000-000000000002', 'barber',  tap_barber('hassan'), 'Hassan', now() - interval '1 hour'),
  ('00000000-0000-4000-a000-000000000003', 'barber',  tap_barber('larry'),  'Larry',  now() - interval '1 hour');

-- ======================= Schema =======================
select has_table('public', 'staff',              'staff table exists');
select has_table('public', 'barber_view_grants', 'barber_view_grants table exists');
select has_table('public', 'booking_events',     'booking_events table exists');
select has_table('public', 'booking_links',      'booking_links table exists');
select has_table('public', 'device_tokens',      'device_tokens table exists');
select has_column('public', 'barbers', 'title',  'barbers.title exists');
select results_eq(
  $$ select slug, title from barbers where slug in ('hassan', 'larry') order by sort_order $$,
  $$ values ('hassan', 'Master Barber'), ('larry', 'Barber') $$,
  'titles are backfilled'
);
select is(
  (select count(*)::int from barber_view_grants
    where viewer_barber_id = tap_barber('hassan') and barber_id = tap_barber('larry')),
  1, 'the migration seeds hassan → larry as a view grant'
);
select throws_ok(
  $$ insert into staff (user_id, role, display_name)
     values ('00000000-0000-4000-a000-000000000004', 'barber', 'No Chair') $$,
  '23514', null,
  'a barber login must have a chair'
);
select is(
  (select bool_and(relrowsecurity) from pg_class
    where relname in ('staff', 'barber_view_grants', 'booking_events', 'booking_links', 'device_tokens')
      and relnamespace = 'public'::regnamespace),
  true, 'RLS is on for every new table'
);

-- ======================= Grants =======================
-- Every function this migration adds, by name. The count keeps the checks below
-- from passing on an empty set.
create temp table tap_new_functions as
select p.oid, (p.proname::text collate "default") as proname, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and (p.proname like 'app\_%' or p.proname like 'manager\_%' or p.proname like 'notify\_%'
        or p.proname in ('book_slot_at', 'tg_booking_events', 'tg_notify_booking_event'));
grant select on tap_new_functions to anon, authenticated;

select is((select count(*)::int from tap_new_functions), 33, 'the migration adds 33 functions');
select is(
  (select count(*)::int from tap_new_functions where has_function_privilege('anon', oid, 'execute')),
  0, 'anon can execute none of the new functions'
);
select is(
  (select count(*)::int from tap_new_functions where has_function_privilege('public', oid, 'execute')),
  0, 'public can execute none of the new functions'
);
select is(
  (select count(*)::int from tap_new_functions where not prosecdef),
  0, 'every new function is security definer'
);
select is(
  (select count(*)::int from tap_new_functions where not coalesce('search_path=public' = any(proconfig), false)),
  0, 'every new security definer function sets search_path = public'
);
select results_eq(
  $$ select proname from tap_new_functions
      where not has_function_privilege('authenticated', oid, 'execute') order by 1 $$,
  $$ values ('app_caller'), ('app_clear_actor'), ('app_set_actor'), ('book_slot_at'),
            ('notify_drop_device_tokens'), ('notify_event_payload'),
            ('tg_booking_events'), ('tg_notify_booking_event') $$,
  'the internal functions are closed to authenticated too'
);
select is(
  has_function_privilege('service_role', 'notify_event_payload(bigint)', 'execute'),
  true, 'service_role can read push payloads'
);
select is(
  has_function_privilege('anon', 'book_slot(text, text, date, time, text, text, text[], text, text, text, int, boolean, boolean)', 'execute'),
  true, 'anon can still execute book_slot'
);

-- ======================= Bookings to look at =======================
select lives_ok($$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(3), '10:00', 'Hassan Client', '5557770001') $$, 'a web booking on hassan''s chair');
select lives_ok($$ select * from book_slot('larry',  'hair-cut', tap_next_dow(3), '10:00', 'Larry Client',  '5557770002') $$, 'a web booking on larry''s chair');
select lives_ok($$ select * from book_slot('larry',  'hair-cut', tap_next_dow(3), '10:45', 'Larry Second',  '5557770003') $$, 'a second one on larry''s chair');

-- ======================= Anon =======================
set local role anon;
select is(tap_table_hidden('staff'),              true, 'anon cannot read staff');
select is(tap_table_hidden('barber_view_grants'), true, 'anon cannot read barber_view_grants');
select is(tap_table_hidden('booking_events'),     true, 'anon cannot read booking_events');
select is(tap_table_hidden('booking_links'),      true, 'anon cannot read booking_links');
select is(tap_table_hidden('device_tokens'),      true, 'anon cannot read device_tokens');
select is(tap_table_hidden('bookings'),           true, 'anon still cannot read bookings');
select throws_ok($$ select * from app_me() $$, '42501', null, 'anon cannot call app_me');
select throws_ok($$ select * from app_bookings(tap_barber('larry'), current_date, current_date + 30) $$, '42501', null, 'anon cannot call app_bookings');
select throws_ok($$ select manager_set_active(tap_barber('larry'), false) $$, '42501', null, 'anon cannot call manager_set_active');
select is((select count(*)::int from barbers where slug = 'javier'), 0, 'anon still cannot see the retired barber');
reset role;

-- ======================= A stranger: a login with no staff row =======================
select tap_claims('00000000-0000-4000-a000-000000000004');
set local role authenticated;
select is((select count(*)::int from app_me()), 0, 'a login with no staff row gets no app_me row');
select is((select count(*)::int from bookings), 0, 'a login with no staff row reads no bookings');
select is((select count(*)::int from app_activity()), 0, 'a login with no staff row has no activity');
select is((select count(*)::int from booking_links), 0, 'a login with no staff row reads no links');
select throws_ok($$ select * from app_bookings(tap_barber('larry'), tap_next_dow(3), tap_next_dow(3)) $$, '42501', 'forbidden', 'a login with no staff row cannot list a chair');
select throws_ok($$ select app_book(tap_barber('larry'), 'hair-cut', tap_next_dow(3), '11:30', 'Sneaky Booker', '5557770099') $$, '42501', 'forbidden', 'a login with no staff row cannot book');
select throws_ok($$ select * from manager_staff() $$, '42501', 'forbidden', 'a login with no staff row is not a manager');
select throws_ok($$ select app_register_device('tok-stranger', 'sandbox') $$, '42501', 'forbidden', 'a login with no staff row cannot register a device');
select is(app_can_view(tap_barber('larry')), false, 'app_can_view is false for a stranger');
reset role;

-- ======================= Larry: his own chair only =======================
select tap_claims('00000000-0000-4000-a000-000000000003');
set local role authenticated;
select results_eq(
  $$ select role, display_name, barber_slug, jsonb_array_length(chairs) from app_me() $$,
  $$ values ('barber', 'Larry', 'larry', 1) $$,
  'larry''s app_me: barber, his chair, one chair'
);
select is(
  (select count(*)::int from bookings where barber_id = tap_barber('hassan')),
  0, 'larry reads none of hassan''s bookings through RLS'
);
select is(
  (select count(*)::int from bookings where barber_id = tap_barber('larry') and linked_to is null),
  2, 'larry reads his own bookings through RLS'
);
select throws_ok($$ select * from app_bookings(tap_barber('hassan'), tap_next_dow(3), tap_next_dow(3)) $$, '42501', 'forbidden', 'larry cannot list hassan''s chair');
select is(
  (select count(*)::int from app_bookings(tap_barber('larry'), tap_next_dow(3), tap_next_dow(3))),
  2, 'larry lists his own day'
);
select throws_ok($$ select app_cancel_booking(tap_booking('5557770001')) $$, '42501', 'forbidden', 'larry cannot cancel on hassan''s chair');
reset role;

-- ======================= Hassan: his chair, plus larry's read-only =======================
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select results_eq(
  $$ select role, barber_slug,
            (select array_agg(c ->> 'slug' order by o) from jsonb_array_elements(chairs) with ordinality as x(c, o)),
            (select array_agg((c ->> 'can_manage')::boolean order by o) from jsonb_array_elements(chairs) with ordinality as x(c, o))
       from app_me() $$,
  $$ values ('barber', 'hassan', array['hassan', 'larry'], array[true, false]) $$,
  'hassan''s chairs: his own first and managed, then larry''s view-only'
);
select is(
  (select array_agg(k order by k) from app_me(), jsonb_object_keys(chairs -> 0) as k),
  array['barber_id', 'can_manage', 'display_name', 'is_active', 'slug', 'title'],
  'a chair has exactly barber_id, slug, display_name, title, is_active, can_manage'
);
select is(
  (select count(*)::int from bookings where linked_to is null),
  3, 'hassan reads his and larry''s bookings through RLS'
);
select results_eq(
  $$ select customer_name, can_manage, service_name, status, source, party_size, end_time::text
       from app_bookings(tap_barber('larry'), tap_next_dow(3), tap_next_dow(3)) order by booking_time $$,
  $$ values ('Larry Client', false, 'Hair Cut', 'confirmed', 'web', 1, '10:45:00'),
            ('Larry Second', false, 'Hair Cut', 'confirmed', 'web', 1, '11:30:00') $$,
  'hassan lists larry''s day, can_manage false, end_time at the end of the 45-minute slot'
);
select throws_ok($$ select * from app_cancel_booking(tap_booking('5557770002')) $$, '42501', 'forbidden', 'hassan cannot cancel on larry''s chair');
select throws_ok($$ select app_set_status(tap_booking('5557770002'), 'no_show') $$, '42501', 'forbidden', 'hassan cannot mark a no-show on larry''s chair');
select throws_ok($$ select app_book(tap_barber('larry'), 'hair-cut', tap_next_dow(3), '11:30', 'Hassan Books Larry', '5557770004') $$, '42501', 'forbidden', 'hassan cannot book on larry''s chair');
select throws_ok($$ select app_add_day_off(tap_barber('larry'), tap_next_dow(4)) $$, '42501', 'forbidden', 'hassan cannot add a day off for larry');
select throws_ok($$ select app_remove_day_off(tap_barber('larry'), tap_next_dow(4)) $$, '42501', 'forbidden', 'hassan cannot remove larry''s day off');
select throws_ok($$ insert into booking_links (barber_id, label) values (tap_barber('larry'), 'Not mine') $$, '42501', null, 'hassan cannot add a link to larry''s chair');
select lives_ok($$ insert into booking_links (barber_id, label, service_slug) values (tap_barber('hassan'), 'Fades', 'hair-cut') $$, 'hassan adds a link to his own chair');
select is((select count(*)::int from booking_links), 1, 'hassan reads his own links');
select throws_ok($$ select * from manager_staff() $$, '42501', 'forbidden', 'hassan is not a manager');
select throws_ok($$ select manager_set_view_grant(tap_barber('larry'), tap_barber('hassan'), true) $$, '42501', 'forbidden', 'hassan cannot grant himself views');
reset role;

-- ======================= Deactivated barber, disabled login =======================
update barbers set is_active = false where slug = 'larry';
select tap_claims('00000000-0000-4000-a000-000000000003');
set local role authenticated;
select is((select count(*)::int from app_me()), 0, 'a deactivated barber gets no app_me row');
select is((select count(*)::int from bookings), 0, 'a deactivated barber reads no bookings');
select is((select count(*)::int from app_activity()), 0, 'a deactivated barber has no activity');
select throws_ok($$ select * from app_bookings(tap_barber('larry'), tap_next_dow(3), tap_next_dow(3)) $$, '42501', 'forbidden', 'a deactivated barber cannot list his own chair');
reset role;
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select is(
  (select jsonb_array_length(chairs) from app_me()), 1,
  'a grant to an inactive chair shows nothing: hassan sees only his own'
);
reset role;
update barbers set is_active = true where slug = 'larry';

update auth.users set banned_until = now() + interval '100 years' where id = '00000000-0000-4000-a000-000000000002';
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select is((select count(*)::int from app_me()), 0, 'a disabled login gets no app_me row at once');
select is((select count(*)::int from bookings), 0, 'a disabled login reads no bookings');
reset role;
update auth.users set banned_until = null where id = '00000000-0000-4000-a000-000000000002';

-- ======================= The manager =======================
select tap_claims('00000000-0000-4000-a000-000000000001');
set local role authenticated;
select results_eq(
  $$ select role, barber_id, barber_slug, jsonb_array_length(chairs),
            (select bool_and((c ->> 'can_manage')::boolean) from jsonb_array_elements(chairs) c)
       from app_me() $$,
  $$ values ('manager', null::uuid, null::text, 3, true) $$,
  'the manager sees and manages every chair, the retired one included'
);
select is((select count(*)::int from barbers), 3, 'the manager reads inactive barbers through RLS');
select is((select count(*)::int from bookings where linked_to is null), 3, 'the manager reads every booking');
select is(
  (select count(*)::int from app_bookings(tap_barber('larry'), tap_next_dow(3), tap_next_dow(3)) where can_manage),
  2, 'the manager manages larry''s chair'
);
select results_eq(
  $$ select email, role, is_disabled from manager_staff() order by email $$,
  $$ values ('ali@tap.test', 'manager', false), ('hassan@tap.test', 'barber', false),
            ('larry@tap.test', 'barber', false) $$,
  'manager_staff lists every login with its email'
);
select lives_ok($$ select * from app_cancel_booking(tap_booking('5557770003')) $$, 'the manager cancels on larry''s chair');
select is(
  (select cancelled_by from bookings where id = tap_booking('5557770003')),
  'manager', 'cancelled_by is manager'
);
select lives_ok(
  $$ select manager_set_view_grant(tap_barber('larry'), tap_barber('hassan'), true) $$,
  'the manager grants larry a view of hassan''s chair'
);
select throws_ok(
  $$ select manager_set_view_grant(tap_barber('larry'), tap_barber('larry'), true) $$,
  '22023', 'invalid_grant', 'a chair cannot be granted to itself'
);
reset role;
select tap_claims('00000000-0000-4000-a000-000000000003');
set local role authenticated;
select is((select jsonb_array_length(chairs) from app_me()), 2, 'larry now sees two chairs');
reset role;
select tap_claims('00000000-0000-4000-a000-000000000001');
set local role authenticated;
select lives_ok(
  $$ select manager_set_view_grant(tap_barber('larry'), tap_barber('hassan'), false) $$,
  'the manager takes the grant back'
);

-- ---------- manager_save_barber ----------
select lives_ok(
  $$ select manager_save_barber(null, 'Marco', 'Marco', 'Barber', 'New chair.', null) $$,
  'the manager adds a barber'
);
select results_eq(
  $$ select slug, display_name, title, is_active,
            sort_order > (select max(sort_order) from barbers where slug <> 'marco')
       from barbers where slug = 'marco' $$,
  $$ values ('marco', 'Marco', 'Barber', true, true) $$,
  'a new barber is active, slug lowercased, sorted after the last one'
);
select throws_ok($$ select manager_save_barber(null, 'larry', 'Larry Two', null, null, null) $$, '22023', 'slug_taken', 'slugs are unique');
select throws_ok($$ select manager_save_barber(null, 'a', 'Al', null, null, null) $$, '22023', 'invalid_slug', 'slugs are 2-30 characters');
select throws_ok($$ select manager_save_barber(null, 'bad slug', 'Al', null, null, null) $$, '22023', 'invalid_slug', 'slugs are [a-z0-9-]');
select throws_ok($$ select manager_save_barber(null, 'assets', 'Al', null, null, null) $$, '22023', 'slug_reserved', 'a slug cannot be one of the site''s own paths');
select throws_ok($$ select manager_save_barber(tap_barber('larry'), 'lawrence', 'Larry', 'Barber', null, null) $$, '22023', 'slug_locked', 'a slug with bookings cannot change');
select lives_ok($$ select manager_save_barber(tap_barber('larry'), 'larry', 'Larry', 'Senior Barber', 'Bio.', null) $$, 'the rest of a barber with bookings can change');
select is((select title from barbers where slug = 'larry'), 'Senior Barber', 'the title changed');
select lives_ok($$ select manager_save_barber(tap_barber('marco'), 'marco-b', 'Marco', 'Barber', null, null) $$, 'a slug without bookings can change');

-- ---------- manager_set_schedule ----------
select throws_ok(
  $$ select manager_set_schedule(tap_barber('marco-b'), '[{"weekday":1,"open":"09:00","close":"17:00"}]') $$,
  '22023', 'outside_store_hours', 'opening before the store opens is rejected'
);
select throws_ok(
  $$ select manager_set_schedule(tap_barber('marco-b'), '[{"weekday":1,"open":"10:00","close":"18:30"}]') $$,
  '22023', 'outside_store_hours', 'closing after the store closes is rejected'
);
select throws_ok(
  $$ select manager_set_schedule(tap_barber('marco-b'), '[{"weekday":2,"open":"10:00","close":"18:00"}]') $$,
  '22023', 'outside_store_hours', 'a Tuesday is rejected: the store is closed'
);
select throws_ok(
  $$ select manager_set_schedule(tap_barber('marco-b'), '[{"weekday":1,"open":"12:00","close":"11:00"}]') $$,
  '22023', 'invalid_schedule', 'open must be before close'
);
select throws_ok(
  $$ select manager_set_schedule(tap_barber('marco-b'), '[{"weekday":1,"open":"10:00","close":"18:00"},{"weekday":1,"open":"10:00","close":"12:00"}]') $$,
  '22023', 'invalid_schedule', 'a weekday appears once'
);
select lives_ok(
  $$ select manager_set_schedule(tap_barber('marco-b'),
       '[{"weekday":1,"open":"10:00","close":"18:00"},{"weekday":3,"open":"12:00","close":"16:00"}]') $$,
  'a week inside store hours is saved'
);
select results_eq(
  $$ select weekday, open_time::text, close_time::text from manager_barber_schedule(tap_barber('marco-b')) $$,
  $$ values (1, '10:00:00', '18:00:00'), (3, '12:00:00', '16:00:00') $$,
  'manager_barber_schedule reads it back'
);
select lives_ok(
  $$ select manager_set_schedule(tap_barber('marco-b'), '[{"weekday":5,"open":"10:00","close":"14:00"}]') $$,
  'a new week replaces the old one'
);
select is((select count(*)::int from barber_schedules where barber_id = tap_barber('marco-b')), 1, 'only the new week remains');

-- ---------- manager_set_active ----------
select is(manager_set_active(tap_barber('larry'), false), 1, 'deactivating larry reports his one upcoming booking');
select is((select is_active from barbers where slug = 'larry'), false, 'larry is inactive');
select is(manager_set_active(tap_barber('larry'), true), 1, 'reactivating reports the same booking, still there');
reset role;
set local role anon;
select is((select count(*)::int from barbers where is_active), 3, 'anon sees the new barber at once');
reset role;
select tap_claims('00000000-0000-4000-a000-000000000001');
set local role authenticated;
select lives_ok($$ select manager_set_active(tap_barber('marco-b'), false) $$, 'the new barber is deactivated');
reset role;
set local role anon;
select is((select count(*)::int from barbers where is_active), 2, 'and disappears from the site at once');
reset role;

-- ======================= booking_events =======================
select is(tap_events('5557770001'), 'booked:customer', 'a web booking writes booked by the customer');
select is(tap_events('5557770003'), 'booked:customer,cancelled:manager', 'the manager''s cancel writes cancelled by the manager');

select lives_ok(
  $$ select cancel_booking(tap_booking('5557770002'), '5557770002') $$,
  'the customer cancels on the site'
);
select is(tap_events('5557770002'), 'booked:customer,cancelled:customer', 'a customer cancellation writes cancelled by the customer');

-- "Move it": cancel_booking, then the same phone books again.
select lives_ok($$ select * from book_slot('larry', 'hair-cut', tap_next_dow(4), '10:00', 'Mover Customer', '5557770010') $$, 'a booking to move');
select lives_ok($$ select cancel_booking(tap_booking('5557770010'), '5557770010') $$, 'Move it cancels it');
select lives_ok($$ select * from book_slot('larry', 'hair-cut', tap_next_dow(4), '12:15', 'Mover Customer', '15557770010') $$, 'and books the new time (same number, with the country code)');
select is(tap_events('5557770010') || '|' || tap_events('15557770010'),
          'booked:customer,cancelled:customer|moved:customer',
          'the rebooking reads as moved');

-- Group: one booked event per person, none for continuation slots.
select lives_ok(
  $$ select * from book_slot_group('hassan', tap_next_dow(4), '13:00', '5557770020',
       '[{"name":"Group Parent","service_slug":"tap-long"},{"name":"Group Kid","service_slug":"kids-cut"}]'::jsonb) $$,
  'a group: a two-slot service and a kids cut'
);
select is(tap_events('5557770020'), 'booked:customer,booked:customer', 'a group writes one booked event per person, none for the continuation slot');

select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select lives_ok($$ select * from app_cancel_booking(tap_booking('5557770001')) $$, 'hassan cancels on his own chair');
reset role;
select is(tap_events('5557770001'), 'booked:customer,cancelled:barber', 'a barber cancel writes cancelled by the barber');
select results_eq(
  $$ select cancelled_by, actor_user_id from bookings bk join booking_events e on e.booking_id = bk.id
      where bk.id = tap_booking('5557770001') and e.kind = 'cancelled' $$,
  $$ values ('barber', '00000000-0000-4000-a000-000000000002'::uuid) $$,
  'the barber cancel records who did it'
);

select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select results_eq(
  $$ select customer_name, customer_phone, booking_time::text
       from app_cancel_booking((select id from bookings where customer_phone = '5557770020'
                                  and customer_name = 'Group Kid')) $$,
  $$ values ('Group Kid', '5557770020', '14:30:00') $$,
  'app_cancel_booking returns what the app needs to text the customer'
);
select throws_ok(
  $$ select * from app_cancel_booking((select id from bookings where customer_phone = '5557770020'
                                         and customer_name = 'Group Kid')) $$,
  '22023', 'cannot_cancel', 'a cancelled booking cannot be cancelled again'
);
select throws_ok(
  $$ select * from app_cancel_booking((select id from bookings where customer_phone = '5557770020'
                                         and linked_to is not null)) $$,
  '22023', 'not_primary', 'a continuation slot is cancelled through its primary'
);
select lives_ok($$ select * from app_cancel_booking(tap_booking('5557770020')) $$, 'cancelling the two-slot primary');
select is(
  (select count(*)::int from bookings where customer_phone = '5557770020' and status = 'cancelled'),
  3, 'the continuation slot is freed with it'
);

-- No-show and undo.
select lives_ok($$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(5), '10:00', 'Late Larry Fan', '5557770030') $$, 'hassan books in the app');
select is(
  (select source || ':' || remind_sms::text from bookings where id = tap_booking('5557770030')),
  'app:false', 'an app booking is source app, no SMS reminder (no consent box was ticked)'
);
select lives_ok($$ select app_set_status(tap_booking('5557770030'), 'no_show') $$, 'hassan marks it a no-show');
select is((select status::text from bookings where id = tap_booking('5557770030')), 'no_show', 'it is a no-show');
select throws_ok($$ select app_set_status(tap_booking('5557770030'), 'no_show') $$, '22023', 'invalid_status_change', 'a no-show cannot be marked twice');
select throws_ok($$ select app_set_status(tap_booking('5557770030'), 'completed') $$, '22023', 'invalid_status', 'only no_show and confirmed are accepted');
reset role;
select is(tap_events('5557770030'), 'booked:barber,no_show:barber', 'an app booking and a no-show, both by the barber');
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select lives_ok($$ select app_set_status(tap_booking('5557770030'), 'confirmed') $$, 'hassan undoes the no-show');
select is((select status::text from bookings where id = tap_booking('5557770030')), 'confirmed', 'it is confirmed again');
select throws_ok($$ select app_set_status(tap_booking('5557770030'), 'confirmed') $$, '22023', 'invalid_status_change', 'undo only applies to a no-show');
reset role;
select is(tap_events('5557770030'), 'booked:barber', 'undoing a no-show removes its event');

-- ======================= app_book enforces book_slot's rules =======================
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select throws_ok($$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(2), '10:00', 'Tue Try', '5557770040') $$, '22023', 'store_closed', 'app_book: closed Tuesdays');
select throws_ok($$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(5), '10:00', 'Taken Try', '5557770041') $$, '23505', 'slot_taken', 'app_book: a taken slot raises slot_taken');
select throws_ok($$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(5), '10:30', 'Grid Try', '5557770042') $$, '22023', 'invalid_slot_alignment', 'app_book: off the 45-minute grid');
select throws_ok($$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(5), '18:00', 'Late Try', '5557770043') $$, '22023', 'store_closed', 'app_book: after close');
select throws_ok($$ select app_book(tap_barber('hassan'), 'hair-cut', current_date - 1, '10:00', 'Past Try', '5557770044') $$, '22023', 'date_out_of_range', 'app_book: no past dates');
select throws_ok($$ select app_book(tap_barber('hassan'), 'nope', tap_next_dow(5), '10:45', 'Svc Try', '5557770045') $$, 'P0002', 'service_not_found', 'app_book: unknown service');
select throws_ok($$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(5), '10:45', 'Phone Try', '555') $$, '22023', 'invalid_phone', 'app_book: phone is validated');
select lives_ok($$ select app_add_day_off(tap_barber('hassan'), tap_next_dow(6), 'Wedding') $$, 'hassan takes a Saturday off');
select throws_ok($$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(6), '10:00', 'Closed Try', '5557770046') $$, '22023', 'barber_closed', 'app_book: a day off');
select lives_ok(
  $$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(5), '10:45', 'Price Check', '5557770047',
                     array['beard', 'eyebrows'], '  Fade, no line  ') $$,
  'app_book with add-ons and notes'
);
select results_eq(
  $$ select total_price_cents, customer_notes from bookings where id = tap_booking('5557770047') $$,
  $$ values (4500, 'Fade, no line') $$,
  'app_book prices on the server: $30 cut + $15 beard + free eyebrows'
);
select is(
  (select addons from app_bookings(tap_barber('hassan'), tap_next_dow(5), tap_next_dow(5)) where customer_name = 'Price Check'),
  array['Beard', 'Eyebrows'], 'app_bookings shows add-ons by name'
);
-- The site's per-phone limit (6 active future bookings) is for anon; staff book past it.
select lives_ok(
  $$ select app_book(tap_barber('hassan'), 'hair-cut', tap_next_dow(0) + 7 * n, '10:00', 'Standing Regular', '5557770048')
       from generate_series(0, 6) as n $$,
  'staff can book a regular''s seven standing appointments'
);
reset role;
select throws_ok(
  $$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(1), '10:00', 'Standing Regular', '5557770048') $$,
  '23505', 'too_many_active_bookings', 'the same phone on the site still hits the limit'
);

-- ======================= app_free_slots agrees with book_slot =======================
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select is(
  (select count(*)::int from app_free_slots(tap_barber('hassan'), tap_next_dow(3))),
  11, 'an open day with hassan''s one booking cancelled lists all 11 grid slots'
);
select results_eq(
  $$ select slot_time::text from app_free_slots(tap_barber('hassan'), tap_next_dow(3)) limit 3 $$,
  $$ values ('10:00:00'), ('10:45:00'), ('11:30:00') $$,
  'slots run on the 45-minute grid from open'
);
select is(
  (select max(slot_time)::text from app_free_slots(tap_barber('hassan'), tap_next_dow(3))),
  '17:30:00', 'the last slot starts at 5:30'
);
select is((select count(*)::int from app_free_slots(tap_barber('hassan'), tap_next_dow(2))), 0, 'no slots on a closed Tuesday');
select is((select count(*)::int from app_free_slots(tap_barber('hassan'), tap_next_dow(6))), 0, 'no slots on a day off');
select is((select count(*)::int from app_free_slots(tap_barber('hassan'), current_date - 1)), 0, 'no slots in the past');
select is((select count(*)::int from app_free_slots(tap_barber('hassan'), current_date + 61)), 0, 'no slots past the 60-day window');
select is(
  (select count(*)::int from app_free_slots(tap_barber('larry'), tap_next_dow(4))),
  10, 'larry''s Thursday: the moved booking holds one slot'
);
select is(
  (select count(*)::int from app_free_slots(tap_barber('larry'), tap_next_dow(4)) where slot_time = '12:15'),
  0, 'the taken slot is not listed'
);
select is(
  (select count(*)::int from app_free_slots(tap_barber('larry'), tap_next_dow(4)) where slot_time = '10:00'),
  1, 'the slot freed by the move is listed again'
);
select throws_ok($$ select * from app_free_slots(tap_barber('marco-b'), tap_next_dow(5)) $$, '42501', 'forbidden', 'a chair hassan cannot view has no slots for him');
reset role;

-- Every slot listed books, and each one booked drops off the list.
create function tap_book_every_free_slot(p_slug text, p_date date) returns int language plpgsql as $$
declare
  v_slot time;
  v_failed int := 0;
  v_n int := 0;
begin
  for v_slot in select slot_time from app_free_slots(tap_barber(p_slug), p_date) loop
    v_n := v_n + 1;
    begin
      perform * from book_slot(p_slug, 'hair-cut', p_date, v_slot, 'Fill Customer',
                               '55577781' || lpad(v_n::text, 2, '0'));
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;
  return v_failed;
end;
$$;
select tap_claims('00000000-0000-4000-a000-000000000001');
select is(tap_book_every_free_slot('larry', tap_next_dow(4)), 0, 'book_slot accepts every slot app_free_slots lists');
select is((select count(*)::int from app_free_slots(tap_barber('larry'), tap_next_dow(4))), 0, 'and once booked, none is listed');
select throws_ok(
  $$ select * from book_slot('larry', 'hair-cut', tap_next_dow(4), '10:45', 'Late Comer', '5557770050') $$,
  '23505', 'slot_taken', 'the full day really is full'
);

-- ======================= Days off =======================
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select is(app_add_day_off(tap_barber('hassan'), tap_next_dow(5), 'Doctor'), 2, 'a day off with bookings reports them, and does not cancel them');
select is(
  (select count(*)::int from bookings where barber_id = tap_barber('hassan') and booking_date = tap_next_dow(5)
     and status = 'confirmed' and linked_to is null),
  2, 'those bookings are still confirmed'
);
select results_eq(
  $$ select closure_date, reason, bookings_that_day from app_days_off(tap_barber('hassan')) $$,
  $$ values (tap_next_dow(5), 'Doctor', 2), (tap_next_dow(6), 'Wedding', 0) $$,
  'app_days_off lists them in date order with their booking counts'
);
select lives_ok($$ select app_remove_day_off(tap_barber('hassan'), tap_next_dow(5)) $$, 'hassan removes one');
select is((select count(*)::int from app_days_off(tap_barber('hassan'))), 1, 'one day off left');
select is((select count(*)::int from app_days_off(tap_barber('larry'))), 0, 'hassan can read larry''s days off');
select throws_ok($$ select app_add_day_off(tap_barber('hassan'), current_date - 1) $$, '22023', 'date_out_of_range', 'no days off in the past');
reset role;

-- ======================= Activity =======================
-- hassan's chair so far: booked + cancelled (his own cancel) for 5557770001, a group
-- of two booked (customer) then both cancelled by hassan, and app bookings by hassan.
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select is(
  (select count(*)::int from app_activity(null, 200) where is_unread and actor = 'barber'),
  0, 'hassan''s own actions are never unread for him'
);
select ok(
  (select count(*)::int from app_activity(null, 200) where is_unread and actor = 'customer') >= 3,
  'customer events on his chairs are unread for hassan'
);
select is(
  (select count(*)::int from app_activity(null, 200) where barber_slug = 'larry') > 0,
  true, 'hassan''s activity includes larry''s chair'
);
select ok(
  (select array_agg(event_id) = array_agg(event_id order by event_id desc) from app_activity(null, 200)),
  'activity is newest first'
);
select is(
  (select count(*)::int from app_activity((select max(event_id) from app_activity(null, 1)), 2)),
  2, 'p_before and p_limit page through it'
);
select is(
  (select count(*)::int from app_activity((select min(event_id) from app_activity(null, 200)), 50)),
  0, 'nothing before the oldest event'
);
select lives_ok($$ select app_mark_activity_seen() $$, 'hassan marks activity seen');
select is((select count(*)::int from app_activity(null, 200) where is_unread), 0, 'nothing is unread after that');
reset role;
select tap_claims('00000000-0000-4000-a000-000000000001');
set local role authenticated;
select ok(
  (select count(*)::int from app_activity(null, 200) where is_unread and actor = 'barber') > 0,
  'hassan''s actions are unread for the manager'
);
select is(
  (select count(*)::int from app_activity(null, 200) where barber_slug = 'hassan' and kind = 'cancelled' and actor = 'barber'),
  3, 'the manager sees hassan''s three cancellations'
);
reset role;
select tap_claims('00000000-0000-4000-a000-000000000003');
set local role authenticated;
select is(
  (select count(*)::int from app_activity(null, 200) where barber_slug <> 'larry'),
  0, 'larry''s activity has only his own chair'
);
reset role;

-- ======================= Settings and devices =======================
update staff set must_change_password = true where user_id = '00000000-0000-4000-a000-000000000003';
select tap_claims('00000000-0000-4000-a000-000000000003');
set local role authenticated;
select is((select must_change_password from app_me()), true, 'a new login must change its password');
select lives_ok($$ select app_password_changed() $$, 'larry changes it');
select is((select must_change_password from app_me()), false, 'and the flag clears');
select lives_ok($$ select app_set_notify_prefs(false, true, true) $$, 'larry sets his notifications');
select results_eq(
  $$ select notify_bookings, notify_cancellations, notify_viewed_chairs from app_me() $$,
  $$ values (false, true, true) $$, 'app_me reads them back'
);
select lives_ok($$ select app_register_device('tok-larry', 'sandbox') $$, 'larry registers his phone');
select throws_ok($$ select app_register_device('tok-larry-2', 'staging') $$, '22023', 'invalid_environment', 'environment is sandbox or production');
reset role;
select tap_claims('00000000-0000-4000-a000-000000000002');
set local role authenticated;
select lives_ok($$ select app_register_device('tok-hassan', 'production') $$, 'hassan registers his phone');
select lives_ok($$ select app_register_device('tok-hassan-old', 'production') $$, 'and an old one');
select lives_ok($$ select app_unregister_device('tok-hassan-old') $$, 'and removes the old one');
select lives_ok($$ select app_unregister_device('tok-larry') $$, 'removing someone else''s token does nothing');
reset role;
select tap_claims('00000000-0000-4000-a000-000000000001');
set local role authenticated;
select lives_ok($$ select app_register_device('tok-ali', 'sandbox') $$, 'the manager registers his phone');
reset role;
select results_eq(
  $$ select token, user_id::text, environment from device_tokens order by token $$,
  $$ values ('tok-ali', '00000000-0000-4000-a000-000000000001', 'sandbox'),
            ('tok-hassan', '00000000-0000-4000-a000-000000000002', 'production'),
            ('tok-larry', '00000000-0000-4000-a000-000000000003', 'sandbox') $$,
  'three devices, one per login'
);

-- ======================= Push payloads =======================
select lives_ok($$ select * from book_slot('larry', 'hair-cut', tap_next_dow(0), '10:00', 'Marcus Reed', '5557770060') $$, 'a booking on larry''s chair');
select results_eq(
  $$ select r ->> 'token', (r ->> 'own_chair')::boolean, r ->> 'role'
       from jsonb_array_elements(notify_event_payload(
              (select max(e.id) from booking_events e where e.booking_id = tap_booking('5557770060'))) -> 'recipients') r
      order by 1 $$,
  $$ values ('tok-ali', false, 'manager'), ('tok-hassan', false, 'barber'), ('tok-larry', true, 'barber') $$,
  'larry''s chair: larry (own), hassan (granted), ali (manager)'
);
select results_eq(
  $$ select e ->> 'kind', e ->> 'customer_first_name', e ->> 'service_name', e ->> 'barber_name',
            (e ->> 'party_size')::int, e ->> 'booking_time'
       from (select notify_event_payload(
               (select max(id) from booking_events where booking_id = tap_booking('5557770060'))) -> 'event' as e) x $$,
  $$ values ('booked', 'Marcus', 'Hair Cut', 'Larry', 1, '10:00:00') $$,
  'the payload carries what the push says, first name only'
);
select lives_ok($$ select * from book_slot('hassan', 'hair-cut', tap_next_dow(0), '10:45', 'Other Guy', '5557770061') $$, 'a booking on hassan''s chair');
select results_eq(
  $$ select r ->> 'token'
       from jsonb_array_elements(notify_event_payload(
              (select max(id) from booking_events where booking_id = tap_booking('5557770061'))) -> 'recipients') r
      order by 1 $$,
  $$ values ('tok-ali'), ('tok-hassan') $$,
  'hassan''s chair: not larry, who has no grant'
);
update auth.users set banned_until = now() + interval '1 day' where id = '00000000-0000-4000-a000-000000000002';
select is(
  (select count(*)::int from jsonb_array_elements(notify_event_payload(
     (select max(id) from booking_events where booking_id = tap_booking('5557770061'))) -> 'recipients') r
    where r ->> 'token' = 'tok-hassan'),
  0, 'a disabled login gets no pushes'
);
update auth.users set banned_until = null where id = '00000000-0000-4000-a000-000000000002';
select is(notify_drop_device_tokens(array['tok-hassan', 'nope']), 1, 'notify_drop_device_tokens removes the tokens APNs rejected');

-- ======================= The notify trigger (pg_net + Vault) =======================
select is(
  (select count(*)::int from net.http_request_queue),
  0, 'without the Vault secrets, events queue no requests'
);
select lives_ok(
  $$ select vault.create_secret('http://functions.test/notify-booking-event', 'notify-booking-event-url'),
            vault.create_secret('tap-service-key', 'notify-booking-event-key') $$,
  'the two Vault secrets'
);
select lives_ok($$ select * from book_slot('larry', 'hair-cut', tap_next_dow(0), '10:45', 'Pushed Customer', '5557770070') $$, 'a booking with the secrets set');
select results_eq(
  $$ select url, method::text, headers ->> 'Authorization',
            convert_from(body, 'utf8')::jsonb ->> 'event_id'
       from net.http_request_queue $$,
  $$ select 'http://functions.test/notify-booking-event', 'POST', 'Bearer tap-service-key',
            (select max(id)::text from booking_events) $$,
  'the event is posted to the function with the key'
);

select * from finish();
rollback;
