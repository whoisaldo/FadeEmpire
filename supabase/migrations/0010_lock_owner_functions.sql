-- 0010_lock_owner_functions.sql
--
-- Security fix, found by the live-health CI check: the anon role could
-- execute confirm_booking() (and expire_pending_holds()) even though 0001
-- revoked them "from public".
--
-- Root cause: Supabase sets default privileges that grant EXECUTE on every
-- new public-schema function to the anon/authenticated roles EXPLICITLY.
-- `revoke ... from public` removes only the PUBLIC pseudo-role grant — the
-- role-specific default grants survive it. Owner/system functions therefore
-- need an explicit revoke from anon (and authenticated where applicable).
--
-- Impact before this fix: anyone with the public anon key could flip a
-- pending booking to confirmed, or force-expire pending holds. (Since 0007
-- web bookings are created confirmed, so exposure was limited — but the
-- grants were still wrong.)
--
-- Rule for future migrations: after CREATE FUNCTION, grant/revoke against
-- anon + authenticated explicitly; never assume "revoke from public" locked
-- it down. The pgTAP suite (supabase/tests/004_security.sql) and the
-- live-health workflow both assert this from now on.

revoke execute on function confirm_booking(uuid)  from public, anon;
revoke execute on function expire_pending_holds() from public, anon, authenticated;

-- Owner tooling keeps working: confirm_booking stays granted to authenticated
-- (from 0001); expire_pending_holds is executed by pg_cron as the superuser
-- and needs no role grants at all.
