-- 0012_hassan_sundays.sql
--
-- Hours correction: Hassan DOES work Sundays. "Hassan: 10–6 every day except
-- Tuesdays" means exactly that — so the shop is effectively open seven days:
--
--   Mon–Sat  9:00–18:00  (Javier 9–6; Hassan from 10, off Tuesdays)
--   Sunday  10:00–18:00  (Hassan only)
--
-- 0009 had treated "store hours Mon–Sat" as a hard Sunday closure. This adds
-- the Sunday store window and Hassan's Sunday schedule. Javier stays Mon–Sat.

insert into store_hours (weekday, open_time, close_time)
values (0, '10:00:00', '18:00:00')
on conflict (weekday)
  do update set open_time = excluded.open_time, close_time = excluded.close_time;

insert into barber_schedules (barber_id, weekday, open_time, close_time)
select id, 0, '10:00:00'::time, '18:00:00'::time
  from barbers where slug = 'hassan'
on conflict (barber_id, weekday)
  do update set open_time = excluded.open_time, close_time = excluded.close_time;
