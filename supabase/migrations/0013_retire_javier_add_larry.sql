-- 0013_retire_javier_add_larry.sql
--
-- Roster change: Javier no longer works at Fade Empire. Larry takes the
-- second chair, working 10:00–6:00 every single day.
--
--   1. RETIRE JAVIER. `is_active = false` makes him unbookable and invisible:
--      book_slot / book_slot_group look barbers up WITH is_active = true (so
--      booking him raises barber_not_found), and the barbers RLS read policy
--      filters on is_active (so anon can no longer even see the row). The row
--      itself stays — bookings.barber_id references it, so his booking
--      history keeps its barber. His schedule rows are deleted so nothing
--      advertises hours nobody works.
--   2. ADD LARRY. Second chair (sort_order 10, after Hassan's 0),
--      10:00–18:00 all seven weekdays — always inside store hours
--      (Mon–Sat 9–6, Sun 10–6).
--
-- Apply with `supabase db push --linked` (or run once in the SQL editor) for
-- project mjehfaonibgobimfiijk. Idempotent: upsert + rebuild-by-slug.

update barbers set is_active = false where slug = 'javier';

delete from barber_schedules
 where barber_id in (select id from barbers where slug = 'javier');

-- Larry — the new second chair.
insert into barbers (slug, display_name, bio, photo_url, sort_order)
values (
  'larry',
  'Larry',
  'Barber. Second chair, seven days a week. In the shop 10 to 6 — including Tuesdays.',
  './assets/Barbers/Larry/optimized/LarryBarber_tablet.jpg',
  10
)
on conflict (slug) do update set
  display_name = excluded.display_name,
  bio          = excluded.bio,
  photo_url    = excluded.photo_url,
  is_active    = true,
  sort_order   = excluded.sort_order;

-- Larry: 10:00–18:00 every day (0=Sun … 6=Sat). Rebuild from scratch.
delete from barber_schedules
 where barber_id in (select id from barbers where slug = 'larry');

insert into barber_schedules (barber_id, weekday, open_time, close_time)
select b.id, w, '10:00:00'::time, '18:00:00'::time
  from barbers b, generate_series(0, 6) as w
 where b.slug = 'larry';

-- NOTE for the owner: Javier's upcoming bookings are NOT auto-cancelled —
-- they still hold their slots (and those slots stay blocked for that chair
-- even though it can't take new bookings). Review them and call the
-- customers to move them to Hassan or Larry, then cancel:
--
--   select bk.id, bk.booking_date, bk.booking_time,
--          bk.customer_name, bk.customer_phone
--     from bookings bk join barbers b on b.id = bk.barber_id
--    where b.slug = 'javier'
--      and bk.status in ('pending', 'confirmed')
--      and bk.booking_date >= current_date
--    order by bk.booking_date, bk.booking_time;
