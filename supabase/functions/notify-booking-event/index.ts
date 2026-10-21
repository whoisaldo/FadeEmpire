// notify-booking-event Edge Function, called through pg_net by the trigger on
// booking_events (0022). The logic lives in notify.ts so the tests can import
// it without serving.

import { handle, readEnv } from './notify.ts';

Deno.serve((req) => handle(req, readEnv((name) => Deno.env.get(name))));
