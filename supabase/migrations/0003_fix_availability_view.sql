-- 0003_fix_availability_view.sql
--
-- Bugfix: v_slot_availability was created with security_invoker=true. Combined
-- with the bookings RLS lockdown (no anon SELECT), this made the view return
-- zero rows for the anon role — breaking the time-grid client-side.
--
-- Fix: re-create the view with security_invoker=false (the default) so it
-- runs with the definer/owner's permissions and bypasses RLS. The view itself
-- exposes only barber_slug + date + time + status — no PII. That's the
-- intended controlled hole through the RLS lockdown.

drop view if exists v_slot_availability cascade;

create view v_slot_availability as
select
  b.id          as barber_id,
  b.slug        as barber_slug,
  bk.booking_date,
  bk.booking_time,
  bk.status
from barbers b
join bookings bk on bk.barber_id = b.id
where bk.status in ('pending', 'confirmed')
  and bk.booking_date between current_date
                          and current_date + interval '60 days';

grant select on v_slot_availability to anon, authenticated;
