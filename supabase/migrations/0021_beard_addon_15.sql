-- 0021_beard_addon_15.sql
--
-- Price change: beard work on top of a cut (the `beard` add-on) goes from $10
-- to $15, the same as a standalone Beard Trim (0015). The Beard Trim service
-- is unchanged, and still includes the add-on at no charge (client-side
-- INCLUDED_ADDONS), as does the VIP.
--
-- Existing bookings keep the total they were booked at (total_price_cents is
-- a snapshot); only new bookings price the add-on at $15.
--
-- Apply with `supabase db push --linked` (or run once in the SQL editor) for
-- project mjehfaonibgobimfiijk. Idempotent.

update addons set price_cents = 1500 where slug = 'beard';
