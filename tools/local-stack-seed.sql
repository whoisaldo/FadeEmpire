-- local-stack-seed.sql — sample data for the LOCAL barber-app stack only.
-- tools/local-stack.sh runs it after creating the three auth logins through the
-- admin API. Never run it against the hosted project.
--
-- What it makes, around today (shop time): two days back to six days ahead,
-- both chairs, about five bookings in eight slots, on the real grid and inside
-- the real hours (closed Tuesdays are skipped). On top of that, through the real
-- RPCs so booking_events reads the way production would:
--   a group booking (a parent and two kids, book_slot_group, Hassan),
--   a customer cancellation (cancel_booking, Larry),
--   a move (cancel_booking, then book_slot with the same phone, Hassan),
--   a barber cancellation (app_cancel_booking as Hassan),
--   an app booking (app_book as Hassan),
--   a no-show (app_set_status as Larry, yesterday or earlier).
-- Activity in the last six hours shows as unread for all three logins.

do $seed$
declare
  v_ali          uuid;
  v_hassan_user  uuid;
  v_larry_user   uuid;
  v_hassan       uuid;
  v_larry        uuid;
  v_today        date := (now() at time zone 'America/New_York')::date;
  v_date         date;
  v_chair        record;
  v_sched        record;
  v_time         time;
  v_n            int;
  v_h            int;
  v_name         text;
  v_phone        text;
  v_service      record;
  v_addons       text[];
  v_slot_at      timestamptz;
  v_created      timestamptz;
  v_group_date   date;
  v_id           uuid;
  v_phone2       text;
  v_free         time;
  v_ev_cancel    uuid;
  v_ev_move      uuid;
  v_ev_barber    uuid;
  v_ev_app       uuid;
  v_ev_noshow    uuid;
  v_names        text[] := array[
    'Marcus Reed', 'Jayden Torres', 'Kevin Nguyen', 'Luis Ramirez', 'Andre Johnson',
    'Tyler Brooks', 'Carlos Rivera', 'Mike Sullivan', 'Darnell Hayes', 'Jose Martinez',
    'Brandon Lee', 'Omar Haddad', 'Chris Walsh', 'Devon Carter', 'Sam Patel',
    'Nick Kowalski', 'Eli Cohen', 'Jamal Wright', 'Ryan O''Connor', 'Victor Santos',
    'Adam Chen', 'Malik Ross', 'Tony Pereira', 'Isaiah Grant', 'Pete Dubois'];
  v_services     text[] := array['hair-cut', 'hair-cut', 'hair-cut', 'hair-cut', 'line-up',
                                 'beard-trim', 'kids-cut', 'vip-haircut', 'senior-cut', 'military-cut'];
begin
  select id into v_ali         from auth.users where email = 'ali@local.test';
  select id into v_hassan_user from auth.users where email = 'hassan@local.test';
  select id into v_larry_user  from auth.users where email = 'larry@local.test';
  select id into v_hassan from barbers where slug = 'hassan';
  select id into v_larry  from barbers where slug = 'larry';
  if v_ali is null or v_hassan_user is null or v_larry_user is null then
    raise exception 'create the three local logins first (tools/local-stack.sh does)';
  end if;

  -- Seeded logins skip the forced password change; reset_password in staff-admin
  -- turns it back on for testing that screen.
  insert into staff (user_id, role, barber_id, display_name, must_change_password, activity_seen_at)
  values (v_ali,         'manager', null,     'Ali',    false, now() - interval '6 hours'),
         (v_hassan_user, 'barber',  v_hassan, 'Hassan', false, now() - interval '6 hours'),
         (v_larry_user,  'barber',  v_larry,  'Larry',  false, now() - interval '6 hours')
  on conflict (user_id) do nothing;

  -- ---------- The group: first open day two or more days out, Hassan, 1 PM ----------
  select d into v_group_date
    from generate_series(v_today + 2, v_today + 9, interval '1 day') as g(d0),
         lateral (select g.d0::date as d) x
   where exists (select 1 from barber_schedules s
                  where s.barber_id = v_hassan and s.weekday = extract(dow from x.d)::smallint)
     and exists (select 1 from store_hours h where h.weekday = extract(dow from x.d)::smallint)
   order by d
   limit 1;

  perform * from book_slot_group('hassan', v_group_date, '13:00', '4135550142',
    '[{"name":"Andre Silva","service_slug":"hair-cut","addons":["hot-towel"]},
      {"name":"Mateo Silva","service_slug":"kids-cut"},
      {"name":"Lucas Silva","service_slug":"kids-cut","custom_request":"Same as last time, short on the sides"}]'::jsonb);

  -- ---------- A week of bookings, inserted on the grid ----------
  for v_date in select (v_today + i) from generate_series(-2, 6) as i loop
    for v_chair in select b.id, b.slug from barbers b where b.slug in ('hassan', 'larry') order by b.sort_order loop
      select s.open_time, s.close_time, s.slot_minutes into v_sched
        from barber_schedules s
       where s.barber_id = v_chair.id and s.weekday = extract(dow from v_date)::smallint;
      continue when not found;

      v_n := 0;
      v_time := v_sched.open_time;
      while v_time < v_sched.close_time loop
        v_h := abs(hashtext(v_date::text || v_chair.slug || v_n::text));
        if is_within_store_hours(v_date, v_time)
           and v_h % 8 < 5
           and not exists (select 1 from bookings bk
                            where bk.barber_id = v_chair.id and bk.booking_date = v_date
                              and bk.booking_time = v_time and bk.status in ('pending', 'confirmed')) then
          v_name  := v_names[1 + v_h % array_length(v_names, 1)];
          v_phone := '413555' || lpad((1000 + v_h % 9000)::text, 4, '0');
          select s.id, s.slug, s.base_price_cents into v_service
            from services s where s.slug = v_services[1 + (v_h / 7) % array_length(v_services, 1)];
          v_addons := case when v_service.slug = 'hair-cut' and v_h % 5 = 0 then array['beard']
                           when v_service.slug = 'hair-cut' and v_h % 7 = 0 then array['hot-towel', 'eyebrows']
                           else '{}' end;
          v_slot_at := (v_date + v_time) at time zone 'America/New_York';
          v_created := least(v_slot_at - make_interval(days => 1 + v_h % 4, hours => v_h % 9),
                             now() - make_interval(mins => 20 + v_h % 600));
          insert into bookings (barber_id, service_id, booking_date, booking_time,
                                customer_name, customer_phone, selected_addons,
                                customer_notes, total_price_cents, status, hold_expires_at,
                                source, created_at, remind_sms)
          values (v_chair.id, v_service.id, v_date, v_time, v_name, v_phone, v_addons,
                  case when v_h % 11 = 0 then 'Running 5 min late maybe' end,
                  v_service.base_price_cents
                    + coalesce((select sum(a.price_cents) from addons a where a.slug = any(v_addons)), 0),
                  'confirmed', null, 'web', v_created, v_h % 3 <> 0);
        end if;
        v_n := v_n + 1;
        v_time := v_time + make_interval(mins => v_sched.slot_minutes);
      end loop;
    end loop;
  end loop;

  -- Booking events took the insert time; give them the booking's own created_at.
  update booking_events e
     set occurred_at = bk.created_at
    from bookings bk
   where bk.id = e.booking_id and e.kind = 'booked';

  -- ---------- A customer cancellation (Larry, a few days out) ----------
  select bk.id, bk.customer_phone into v_ev_cancel, v_phone
    from bookings bk
   where bk.barber_id = v_larry and bk.booking_date >= v_today + 2
     and bk.status = 'confirmed' and bk.linked_to is null and bk.customer_phone <> '4135550142'
   order by bk.booking_date, bk.booking_time
   limit 1;
  perform cancel_booking(v_ev_cancel, v_phone);

  -- ---------- A move (Hassan): cancel, then the same phone books another time ----------
  select bk.id, bk.customer_phone, bk.customer_name into v_id, v_phone2, v_name
    from bookings bk
   where bk.barber_id = v_hassan and bk.booking_date = (
           select min(b2.booking_date) from bookings b2
            where b2.barber_id = v_hassan and b2.booking_date >= v_today + 1)
     and bk.status = 'confirmed' and bk.linked_to is null and bk.customer_phone <> '4135550142'
   order by bk.booking_time desc
   limit 1;
  perform cancel_booking(v_id, v_phone2);

  select x.t::time into v_free
    from (select bk.booking_date from bookings bk where bk.id = v_id) d,
         barber_schedules s,
         generate_series(d.booking_date + s.open_time, d.booking_date + s.close_time - interval '1 second',
                         make_interval(mins => s.slot_minutes)) as x(t)
   where s.barber_id = v_hassan and s.weekday = extract(dow from d.booking_date)::smallint
     and x.t::time > (select bk.booking_time from bookings bk where bk.id = v_id)
     and not exists (select 1 from bookings bk
                      where bk.barber_id = v_hassan and bk.booking_date = d.booking_date
                        and bk.booking_time = x.t::time and bk.status in ('pending', 'confirmed'))
   order by x.t
   limit 1;
  if v_free is not null then
    select b.booking_id into v_ev_move
      from bookings bk,
           lateral book_slot('hassan', 'hair-cut', bk.booking_date, v_free, v_name, v_phone2) b
     where bk.id = v_id and b.slot_index = 0;
  end if;

  -- ---------- Barber actions, as the barber's login ----------
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_hassan_user, 'role', 'authenticated')::text, true);

  select bk.id into v_ev_barber
    from bookings bk
   where bk.barber_id = v_hassan and bk.booking_date >= v_today + 3
     and bk.status = 'confirmed' and bk.linked_to is null and bk.customer_phone <> '4135550142'
   order by bk.booking_date, bk.booking_time
   limit 1;
  perform * from app_cancel_booking(v_ev_barber);

  select x.t::time into v_free
    from barber_schedules s,
         generate_series((v_today + 1) + s.open_time, (v_today + 1) + s.close_time - interval '1 second',
                         make_interval(mins => s.slot_minutes)) as x(t)
   where s.barber_id = v_hassan and s.weekday = extract(dow from v_today + 1)::smallint
     and not exists (select 1 from bookings bk
                      where bk.barber_id = v_hassan and bk.booking_date = v_today + 1
                        and bk.booking_time = x.t::time and bk.status in ('pending', 'confirmed'))
   order by x.t
   limit 1;
  if v_free is not null then
    v_ev_app := app_book(v_hassan, 'hair-cut', v_today + 1, v_free, 'Frank Moretti', '4135550188',
                         array['beard'], 'Regular, booked at the chair');
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_larry_user, 'role', 'authenticated')::text, true);

  select bk.id into v_ev_noshow
    from bookings bk
   where bk.barber_id = v_larry and bk.booking_date < v_today
     and bk.status = 'confirmed' and bk.linked_to is null
   order by bk.booking_date desc, bk.booking_time desc
   limit 1;
  if v_ev_noshow is not null then
    perform app_set_status(v_ev_noshow, 'no_show');
  end if;

  perform set_config('request.jwt.claims', '', true);

  -- Spread the RPC-made events over the last few hours so the feed reads in order.
  update booking_events set occurred_at = now() - interval '5 hours'
   where booking_id = v_ev_cancel and kind = 'cancelled';
  update bookings set cancelled_at = now() - interval '5 hours' where id = v_ev_cancel;
  update booking_events set occurred_at = now() - interval '3 hours'
   where booking_id = v_id and kind = 'cancelled';
  update bookings set cancelled_at = now() - interval '3 hours' where id = v_id;
  update booking_events set occurred_at = now() - interval '3 hours' + interval '2 minutes'
   where booking_id = v_ev_move;
  update bookings set created_at = now() - interval '3 hours' + interval '2 minutes' where id = v_ev_move;
  update booking_events set occurred_at = now() - interval '90 minutes'
   where booking_id = v_ev_barber and kind = 'cancelled';
  update bookings set cancelled_at = now() - interval '90 minutes' where id = v_ev_barber;
  update booking_events set occurred_at = now() - interval '40 minutes' where booking_id = v_ev_app;
  update bookings set created_at = now() - interval '40 minutes' where id = v_ev_app;
  update booking_events set occurred_at = now() - interval '15 minutes'
   where booking_id = v_ev_noshow and kind = 'no_show';

  -- ---------- Links ----------
  insert into booking_links (barber_id, label, service_slug)
  values (v_larry,  'Kids cuts', 'kids-cut'),
         (v_larry,  'Instagram bio', null),
         (v_hassan, 'VIP clients', 'vip-haircut');
end
$seed$;
