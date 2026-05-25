// supabase.js — singleton Supabase client, loaded from the official ESM CDN.
// No bundler. No package.json. Works directly on GitHub Pages.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'x-client-info': 'fade-empire-web/1.0' } },
});
