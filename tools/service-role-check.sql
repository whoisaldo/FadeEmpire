-- service-role-check.sql — every privilege the Edge Functions and
-- tools/deploy-barber-app.sh use with the service role key. Raises one error that
-- names whatever is missing; prints nothing when all of it is there.
--
-- The hosted project's service_role got table grants from Supabase's old default
-- privileges; a fresh database gives it none, so anything not granted by a
-- migration works in production and fails everywhere else (or the other way round,
-- in a future project). Run by CI after the migrations, by tools/local-stack.sh
-- check, and by tools/deploy-barber-app.sh after db push. Add a line here when a
-- function starts using a table or RPC.

do $check$
declare
  v_missing text;
begin
  select string_agg(format('%s on %s', v.priv, v.obj), ', ' order by v.obj, v.priv)
    into v_missing
    from (values
      -- staff-admin: the caller's staff row, a new login's barber and staff row,
      -- the must-change flag, a disabled login's device tokens
      ('table',    'public.barbers',                               'select'),
      ('table',    'public.staff',                                 'select'),
      ('table',    'public.staff',                                 'insert'),
      ('table',    'public.staff',                                 'update'),
      ('table',    'public.device_tokens',                         'delete'),
      -- notify-booking-event
      ('function', 'public.notify_event_payload(bigint)',          'execute'),
      ('function', 'public.notify_drop_device_tokens(text[])',     'execute'),
      -- send-reminders
      ('function', 'public.reminders_due()',                       'execute'),
      ('function', 'public.rebook_due()',                          'execute'),
      ('function', 'public.claim_reminders(text, uuid[])',         'execute'),
      ('function', 'public.mark_reminder_sent(uuid[], text, text)', 'execute')
    ) as v(kind, obj, priv)
   where not case v.kind
               when 'table' then has_table_privilege('service_role', v.obj, v.priv)
               else has_function_privilege('service_role', v.obj::regprocedure, v.priv)
             end;
  if v_missing is not null then
    raise exception 'service_role is missing: %', v_missing;
  end if;
end
$check$;
