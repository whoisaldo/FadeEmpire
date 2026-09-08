-- 0017_closed_tuesdays.sql
--
-- Hours change: the shop is CLOSED on Tuesdays. Nobody works that day — not
-- Hassan (who already had Tuesdays off) and now not Larry either. The store
-- runs six days a week:
--
--   Wed–Mon  10:00–18:00  (both chairs)
--   Tuesday  closed
--
--   1. STORE HOURS. Delete the Tuesday row. is_within_store_hours() reads this
--      table live, so both booking RPCs start raising store_closed for any
--      Tuesday slot with no function edits — the store check runs before the
--      per-barber schedule check, so the customer sees "the shop is closed".
--   2. LARRY'S SCHEDULE. Delete his Tuesday row so nothing advertises hours
--      nobody works (the 001_schema pgTAP test asserts every schedule row fits
--      inside store hours). His bio said "including Tuesdays" — reworded.
--
-- Apply with `supabase db push --linked` (or run once in the SQL editor) for
-- project mjehfaonibgobimfiijk. Idempotent.
--
-- NOTE for the owner: existing future TUESDAY bookings (all Larry's) are NOT
-- auto-cancelled — they keep their slots and stay visible in Studio. Review
-- them and call the customers to move them to another day, then cancel:
--
--   select bk.booking_date, bk.booking_time, bk.customer_name, bk.customer_phone,
--          b.display_name as barber
--     from bookings bk join barbers b on b.id = bk.barber_id
--    where bk.status in ('pending', 'confirmed')
--      and bk.booking_date >= current_date
--      and extract(dow from bk.booking_date) = 2
--    order by bk.booking_date, bk.booking_time;

delete from store_hours where weekday = 2;

delete from barber_schedules where weekday = 2;

update barbers
   set bio = 'Barber. Second chair, six days a week. In the shop 10 to 6 — closed Tuesdays, like the rest of the shop.'
 where slug = 'larry';

-- =============================================================================
-- Manual verification:
--
--   select weekday, open_time, close_time from store_hours order by weekday;
--   -- six rows: 0,1,3,4,5,6 — no weekday 2
--
--   select b.slug, s.weekday from barber_schedules s join barbers b on b.id = s.barber_id
--    where s.weekday = 2;
--   -- zero rows
--
--   select is_within_store_hours(<next tuesday>::date, '11:30');
--   -- false
-- =============================================================================
