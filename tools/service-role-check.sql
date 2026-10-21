-- service-role-check.sql — every privilege the Edge Functions and
-- tools/deploy-barber-app.sh use with the service role key. Raises one error that
-- names whatever is missing; prints nothing when all of it is there.
--
-- The hosted project's service_role got table grants from Supabase's old default
-- privileges; a fresh database gives it none, so anything not granted by a
-- migration works in production and fails everywhere else (or the other way round,
-- in a future project). Run by CI after the migrations, by tools/local-stack.sh
-- check, and by tools/deploy-barber-app.sh after db push. Add a line here when a
-- function starts using a table, a column or an RPC.
--
-- PostgREST needs SELECT on every column a request reads or filters on, including
-- the filters of a PATCH or DELETE (user_id=eq.…) and an upsert's on_conflict
-- column; INSERT and UPDATE on the columns it writes. return=minimal reads nothing.
--
-- A table, column or function that is not in the database at all is a migration
-- that is not applied (0022 before db push), not a missing privilege: that is a
-- different error, "not applied: …".

do $check$
declare
  v_absent  text;
  v_missing text;
begin
  with needed (kind, obj, col, priv) as (values
    -- staff-admin (admin.ts). The caller's role: staff?select=role&user_id=eq.
    -- A login's staff row exists: staff?select=user_id&user_id=eq.
    -- A barber exists, and has no login yet: barbers?select=id&id=eq.,
    -- staff?select=user_id&barber_id=eq.
    ('column',   'public.barbers',       'id',                   'select'),
    ('column',   'public.staff',         'user_id',              'select'),
    ('column',   'public.staff',         'role',                 'select'),
    ('column',   'public.staff',         'barber_id',            'select'),
    -- create_login: POST staff (return=minimal)
    ('column',   'public.staff',         'user_id',              'insert'),
    ('column',   'public.staff',         'role',                 'insert'),
    ('column',   'public.staff',         'barber_id',            'insert'),
    ('column',   'public.staff',         'display_name',         'insert'),
    ('column',   'public.staff',         'must_change_password', 'insert'),
    -- reset_password: PATCH staff?user_id=eq. {must_change_password}
    ('column',   'public.staff',         'must_change_password', 'update'),
    -- disable_login: DELETE device_tokens?user_id=eq.
    ('table',    'public.device_tokens', null,                   'delete'),
    ('column',   'public.device_tokens', 'user_id',              'select'),
    -- deploy-barber-app.sh, the manager's staff row: POST staff?on_conflict=user_id
    -- (the same columns as create_login), PATCH staff?user_id=eq. {role}, then
    -- GET staff?user_id=eq.&select=role,display_name,must_change_password
    ('column',   'public.staff',         'role',                 'update'),
    ('column',   'public.staff',         'display_name',         'select'),
    ('column',   'public.staff',         'must_change_password', 'select'),
    -- notify-booking-event
    ('function', 'public.notify_event_payload(bigint)',           null, 'execute'),
    ('function', 'public.notify_drop_device_tokens(text[])',      null, 'execute'),
    -- send-reminders
    ('function', 'public.reminders_due()',                        null, 'execute'),
    ('function', 'public.rebook_due()',                           null, 'execute'),
    ('function', 'public.claim_reminders(text, uuid[])',          null, 'execute'),
    ('function', 'public.mark_reminder_sent(uuid[], text, text)', null, 'execute')
  ),
  checked as (
    select n.*,
           case when n.kind = 'function' or to_regclass(n.obj) is null then n.obj
                else n.col || ' of ' || n.obj end as label,
           case n.kind
             when 'function' then to_regprocedure(n.obj) is null
             when 'table'    then to_regclass(n.obj) is null
             else not exists (select 1 from pg_attribute a
                               where a.attrelid = to_regclass(n.obj) and a.attname = n.col
                                 and a.attnum > 0 and not a.attisdropped)
           end as absent
      from needed n
  )
  select string_agg(distinct c.label, ', ') filter (where c.absent),
         string_agg(format('%s%s on %s', c.priv, coalesce('(' || c.col || ')', ''), c.obj), ', '
                    order by c.obj, c.col, c.priv)
           filter (where case
                     when c.absent then false
                     when c.kind = 'function' then not has_function_privilege('service_role', to_regprocedure(c.obj), c.priv)
                     when c.kind = 'table'    then not has_table_privilege('service_role', to_regclass(c.obj), c.priv)
                     else not has_column_privilege('service_role', to_regclass(c.obj), c.col, c.priv)
                   end)
    into v_absent, v_missing
    from checked c;

  if v_absent is not null then
    raise exception 'not applied: this database has no %. Apply the migrations first.', v_absent;
  end if;
  if v_missing is not null then
    raise exception 'service_role is missing: %', v_missing;
  end if;
end
$check$;
