// send-reminders Edge Function, invoked hourly by pg_cron through pg_net.
// The logic lives in reminders.ts so the tests can import it without serving.

import { handle, readEnv } from './reminders.ts';

Deno.serve((req) => handle(req, readEnv((name) => Deno.env.get(name))));
