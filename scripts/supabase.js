// supabase.js — the database client.
//
// The site only ever talks to PostgREST (table/view reads and RPC calls), so
// it loads @supabase/postgrest-js alone instead of the full supabase-js
// bundle: same `.from()` / `.rpc()` query builder, same { data, error }
// results, about 150 KB less JavaScript on every phone. No bundler, no
// package.json for the site itself. The module is esm.sh's single-file build
// (https://esm.sh/@supabase/postgrest-js@1.16.3?bundle), copied into
// scripts/vendor so the page does not depend on a third-party CDN.
//
// The anon key is public by design; security is RLS + SECURITY DEFINER RPCs.

import { PostgrestClient } from './vendor/postgrest-js-1.16.3.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const sb = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
  headers: {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'x-client-info': 'fade-empire-web/2.0',
  },
});
