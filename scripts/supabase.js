// supabase.js — the database client.
//
// The site only ever talks to PostgREST (table/view reads and RPC calls), so
// it loads @supabase/postgrest-js alone instead of the full supabase-js
// bundle: same `.from()` / `.rpc()` query builder, same { data, error }
// results, about 150 KB less JavaScript on every phone. No bundler, no
// package.json for the site itself; the module comes from esm.sh.
//
// The anon key is public by design; security is RLS + SECURITY DEFINER RPCs.

import { PostgrestClient } from 'https://esm.sh/@supabase/postgrest-js@1.16.3';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const sb = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
  headers: {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'x-client-info': 'fade-empire-web/2.0',
  },
});
