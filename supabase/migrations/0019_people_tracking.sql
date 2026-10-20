-- 0019_people_tracking.sql
--
-- Count people, not phone numbers. A group booking already stores one row per
-- person (the booker plus each friend or kid, every row under the booker's
-- phone), but nothing recorded who came together, who was a guest, or which
-- rows are the same person across visits. Counting distinct phones folds a
-- parent and their two kids into one customer.
--
-- This adds, on bookings:
--   party_id    the booker's booking id, shared by everyone booked in the same
--               book_slot_group call. A solo booking is its own party.
--   is_guest    false for the booker, true for each friend or kid they added.
--   person_key  phone + ':' + lowercased first name. A kid booked under a
--               parent's phone gets their own key. Spelling drift ("Mike" vs
--               "Michael") still makes two people — the key is a heuristic.
-- and an owner-only view, v_people: one row per person_key with their visits,
-- whether they've had a Kids Cut, and how often they came as someone's guest.
--
-- How party_id is assigned: book_slot_group inserts the whole party in one
-- transaction, so every row shares created_at (now() is the transaction start).
-- A BEFORE INSERT trigger looks for an earlier row with the same phone and
-- created_at; if there is one, the new row joins that party as a guest. The
-- booking RPCs are untouched, so a later rewrite of either one keeps working.
-- An insert that sets party_id itself (e.g. by hand in Studio) is left alone.
--
-- Backfill: past rows are grouped the same way (phone + exact created_at) and
-- the earliest slot in each party is the booker. bookings.updated_at is not
-- bumped by the backfill.
--
-- Apply with `supabase db push --linked` (or run once in the SQL editor) for
-- project mjehfaonibgobimfiijk. Idempotent.

-- =============================================================================
-- 1. Columns
-- =============================================================================

alter table bookings
  add column if not exists party_id   uuid,
  add column if not exists is_guest   boolean not null default false,
  add column if not exists person_key text generated always as
    (customer_phone || ':' || lower(split_part(btrim(customer_name), ' ', 1))) stored;

-- The trigger's lookup: "rows this phone inserted in this transaction".
create index if not exists bookings_phone_created_idx
  on bookings (customer_phone, created_at);

-- =============================================================================
-- 2. Assign the party on insert
-- =============================================================================

create or replace function tg_set_booking_party()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_party uuid;
begin
  if new.party_id is not null then
    return new;
  end if;

  -- A continuation slot of a multi-slot service belongs to its primary's person.
  if new.linked_to is not null then
    select b.party_id, b.is_guest into new.party_id, new.is_guest
      from bookings b
     where b.id = new.linked_to;
    return new;
  end if;

  select b.party_id into v_party
    from bookings b
   where b.customer_phone = new.customer_phone
     and b.created_at     = new.created_at
     and b.linked_to is null
   limit 1;

  new.party_id := coalesce(v_party, new.id);
  new.is_guest := v_party is not null;
  return new;
end;
$$;

revoke execute on function tg_set_booking_party() from public, anon, authenticated;

drop trigger if exists bookings_set_party on bookings;
create trigger bookings_set_party
  before insert on bookings
  for each row execute function tg_set_booking_party();

-- =============================================================================
-- 3. Backfill
-- =============================================================================

alter table bookings disable trigger bookings_updated_at;

with ranked as (
  select id,
         first_value(id) over w as party,
         row_number()    over w as pos
    from bookings
   where linked_to is null
  window w as (partition by customer_phone, created_at order by booking_time, id)
)
update bookings b
   set party_id = r.party,
       is_guest = r.pos > 1
  from ranked r
 where b.id = r.id;

update bookings c
   set party_id = p.party_id,
       is_guest = p.is_guest
  from bookings p
 where c.linked_to = p.id;

alter table bookings enable trigger bookings_updated_at;

alter table bookings alter column party_id set not null;

-- =============================================================================
-- 4. v_people — owner-only, one row per person
-- =============================================================================
-- Kept bookings only (cancelled and expired rows are left out), primaries only
-- (a two-slot service is one booking). visits counts distinct days, upcoming
-- ones included. security_invoker so RLS on bookings applies to whoever reads
-- it; anon and authenticated have no grant at all.

create or replace view v_people
with (security_invoker = true) as
select
  bk.person_key,
  bk.customer_phone                                             as phone,
  (array_agg(bk.customer_name order by bk.created_at desc))[1]  as name,
  bool_or(s.slug = 'kids-cut')                                  as is_kid,
  count(*)::int                                                 as bookings,
  count(distinct bk.booking_date)::int                          as visits,
  (count(*) filter (where bk.is_guest))::int                    as booked_as_guest,
  min(bk.created_at)                                            as first_booked_at,
  min(bk.booking_date)                                          as first_visit,
  max(bk.booking_date)                                          as last_visit
from bookings bk
join services s on s.id = bk.service_id
where bk.linked_to is null
  and bk.status not in ('cancelled', 'expired')
group by bk.person_key, bk.customer_phone;

revoke all on v_people from public, anon, authenticated;
grant select on v_people to service_role;

-- =============================================================================
-- DONE. Manual verification:
--
--   select count(*)                                    as people,
--          count(*) filter (where is_kid)              as kids,
--          count(*) filter (where booked_as_guest > 0) as came_as_a_guest,
--          count(distinct phone)                       as phones
--     from v_people;
--
--   select party_id, count(*) as party_size
--     from bookings
--    where linked_to is null
--    group by party_id
--   having count(*) > 1
--    order by max(created_at) desc
--    limit 10;
-- =============================================================================
