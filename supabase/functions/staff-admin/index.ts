// staff-admin Edge Function, called by the barber app with the manager's JWT.
// The logic lives in admin.ts so the tests can import it without serving.

import { handle, readEnv } from './admin.ts';

Deno.serve((req) => handle(req, readEnv((name) => Deno.env.get(name))));
