-- 0014_store_hours_follow_barbers.sql
--
-- Hours correction: with Javier retired (0013) the 9 AM hour has no chair —
-- Hassan and Larry both start at 10. The store window now matches the
-- earliest barber: 10:00–18:00 every day of the week.
--
-- is_within_store_hours() reads this table live, so both booking RPCs pick
-- the change up with no function edits. The barber schedules (10–6) exactly
-- fill the new store window.
--
-- Apply with `supabase db push --linked` (or run once in the SQL editor).

insert into store_hours (weekday, open_time, close_time)
select w, '10:00:00'::time, '18:00:00'::time
from generate_series(0, 6) as w
on conflict (weekday)
  do update set open_time = excluded.open_time, close_time = excluded.close_time;
