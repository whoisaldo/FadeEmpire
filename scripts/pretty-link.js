// pretty-link.js — chicopeefadeempire.com/<slug>, a barber's own link.
//
// GitHub Pages answers every missing path with 404.html, which calls
// resolvePrettyLink: a path that is one slug (/larry or /larry/) and names
// an active barber goes on to /?barber=larry#book (booking-link.js picks the
// barber there). Anything else, or a read that fails or is slow, leaves the
// normal 404. One small anon REST read; no database client.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/** A barber slug as the whole path. 404.html's inline check repeats this
 *  pattern (tests/site-content.test.js keeps the two the same). */
export const SLUG_PATH = /^\/([a-z0-9-]{2,30})\/?$/i;

/** How long the 404 page waits on the read before it shows the 404. */
export const LOOKUP_WAIT_MS = 3000;

export function slugFromPath(pathname) {
  const m = SLUG_PATH.exec(pathname || '');
  return m ? m[1].toLowerCase() : null;
}

/** Where a barber's link goes: the booking form, with a service carried over
 *  from /<slug>?service=<service-slug>. */
export function bookingUrl(slug, search = '') {
  const query = new URLSearchParams({ barber: slug });
  const service = new URLSearchParams(search).get('service');
  if (service) query.set('service', service);
  return `/?${query}#book`;
}

/** Whether `slug` is an active barber. False when the read fails or takes
 *  longer than `waitMs`. */
export async function isActiveBarber(slug, { fetchFn = fetch, waitMs = LOOKUP_WAIT_MS } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), waitMs);
  try {
    const res = await fetchFn(
      `${SUPABASE_URL}/rest/v1/barbers?select=slug&is_active=eq.true&slug=eq.${encodeURIComponent(slug)}`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: abort.signal },
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.some(r => r.slug === slug);
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The booking URL to replace this 404 with, or null to show the 404. */
export async function resolvePrettyLink({ pathname, search } = {}, options) {
  const slug = slugFromPath(pathname);
  if (!slug || !(await isActiveBarber(slug, options))) return null;
  return bookingUrl(slug, search);
}
