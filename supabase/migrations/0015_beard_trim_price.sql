-- 0015_beard_trim_price.sql
--
-- Price correction: a standalone Beard Trim is $15. Beard work ON TOP of a
-- haircut stays a $10 add-on (the `beard` row in `addons` is unchanged) —
-- the two are priced differently on purpose.
--
-- Apply with `supabase db push --linked` (or run once in the SQL editor).

update services set base_price_cents = 1500 where slug = 'beard-trim';
