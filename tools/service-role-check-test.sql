-- service-role-check-test.sql — tools/service-role-check.sql catches what it is for.
-- Each case takes something away from service_role (or drops a function) inside a
-- transaction that is rolled back, runs the check, and expects its error to name
-- exactly that. Run by CI after the check itself, on a database with every
-- migration applied:
--   psql <db url> -X -q -f tools/service-role-check-test.sql
-- Exits non-zero, after listing the failed cases, when any case fails.

\set ON_ERROR_STOP 0
\set VERBOSITY terse
\set failed ''

-- Baseline: everything is there.
\set LAST_ERROR_MESSAGE ''
\ir service-role-check.sql
select :'LAST_ERROR_MESSAGE' = '' as hit \gset
\if :hit
\else
  \set failed :failed' baseline'
\endif

-- disable_login's filtered DELETE needs SELECT on the column it filters on.
begin;
revoke select on device_tokens from service_role;
\set LAST_ERROR_MESSAGE ''
\ir service-role-check.sql
rollback;
\set want 'service_role is missing: select(user_id) on public.device_tokens'
select position(:'want' in :'LAST_ERROR_MESSAGE') > 0 as hit \gset
\if :hit
\else
  \set failed :failed' device_tokens-select'
\endif

-- Column-level: the deploy script reads display_name and must_change_password back.
begin;
revoke select on staff from service_role;
grant select (user_id, role, barber_id) on staff to service_role;
\set LAST_ERROR_MESSAGE ''
\ir service-role-check.sql
rollback;
\set want 'service_role is missing: select(display_name) on public.staff, select(must_change_password) on public.staff'
select position(:'want' in :'LAST_ERROR_MESSAGE') > 0 as hit \gset
\if :hit
\else
  \set failed :failed' staff-select-columns'
\endif

-- reset_password's PATCH and the deploy script's PATCH.
begin;
revoke update on staff from service_role;
\set LAST_ERROR_MESSAGE ''
\ir service-role-check.sql
rollback;
\set want 'service_role is missing: update(must_change_password) on public.staff, update(role) on public.staff'
select position(:'want' in :'LAST_ERROR_MESSAGE') > 0 as hit \gset
\if :hit
\else
  \set failed :failed' staff-update'
\endif

-- create_login's barber lookup.
begin;
revoke select on barbers from service_role;
\set LAST_ERROR_MESSAGE ''
\ir service-role-check.sql
rollback;
\set want 'service_role is missing: select(id) on public.barbers'
select position(:'want' in :'LAST_ERROR_MESSAGE') > 0 as hit \gset
\if :hit
\else
  \set failed :failed' barbers-select'
\endif

-- notify-booking-event's RPC.
begin;
revoke execute on function notify_event_payload(bigint) from service_role;
\set LAST_ERROR_MESSAGE ''
\ir service-role-check.sql
rollback;
\set want 'service_role is missing: execute on public.notify_event_payload(bigint)'
select position(:'want' in :'LAST_ERROR_MESSAGE') > 0 as hit \gset
\if :hit
\else
  \set failed :failed' notify-execute'
\endif

-- A database without 0022 (production before db push): not applied, never "missing".
begin;
drop function notify_event_payload(bigint);
drop table device_tokens;
\set LAST_ERROR_MESSAGE ''
\ir service-role-check.sql
rollback;
\set want 'not applied: this database has no public.device_tokens, public.notify_event_payload(bigint).'
select position(:'want' in :'LAST_ERROR_MESSAGE') > 0 as hit \gset
\if :hit
\else
  \set failed :failed' not-applied'
\endif

\set ON_ERROR_STOP 1
select :'failed' = '' as passed \gset
\if :passed
  \echo 'service-role-check-test: every case passed'
\else
  \echo 'service-role-check-test: failed:' :failed
  do $$ begin raise exception 'service-role-check-test failed'; end $$;
\endif
