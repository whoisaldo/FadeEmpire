// live-health.mjs — end-to-end health check against the LIVE site + database.
//
// Read-only by design: every request here is one the public website itself
// makes from any visitor's browser (public anon key, public tables, and one
// RPC call that fails validation before it could ever write a row).
//
// What it catches:
//   * site down / stale deploy (missing markup the current client needs,
//     a 404 page that no longer forwards barber links)
//   * DB drift: prices/store hours changed in Studio but not in config.js
//     (or vice versa) — the #1 hazard of the mirror-constants architecture
//   * the barbers read the site makes failing, or returning data the booking
//     form cannot use (bad slugs, hours outside the store's)
//   * config.js's fallback barbers disagreeing with the database on hours
//   * missing RPCs after a botched migration (booking + cancellation break)
//   * security regressions: bookings PII readable by anon, owner RPCs exposed
//
// Barbers are managed in the app: the site reads them from the database, so
// a barber added or deactivated there is not drift. config.js's BARBERS is only
// the fallback for a failed read; a fallback barber who is no longer active,
// or renamed, is printed as a note, not a failure.
//
// Usage:  node tests/ci/live-health.mjs
//   LIVE_BASE_URL   override the site origin (default https://chicopeefadeempire.com)
//   SITE_RETRIES    retries for the site-content check (default 1; CI uses more
//                   because GitHub Pages deploys lag a push by a minute or two)

import {
  SUPABASE_URL, SUPABASE_ANON_KEY, STORE_HOURS, BARBERS, SHOP_TZ,
  SERVICE_PRICES_CENTS, SERVICE_DURATIONS_MIN, ADDON_PRICES_CENTS,
} from '../../scripts/config.js';
import { ROSTER_SELECT } from '../../scripts/roster.js';

const SITE = process.env.LIVE_BASE_URL || 'https://chicopeefadeempire.com';
const SITE_RETRIES = Math.max(1, parseInt(process.env.SITE_RETRIES || '1', 10));
const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'content-type': 'application/json',
};

const hmsToMin = (hms) => { const [h, m] = hms.split(':').map(Number); return h * 60 + m; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shopToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ }).format(new Date());

// The active barbers, read once the way the site reads them (booking-rpc.js
// fetchBarbers): { status, body } with body in sort order.
let rosterRead;
const readRoster = () => (rosterRead ||= rest(
  `barbers?select=${ROSTER_SELECT}&is_active=eq.true&barber_closures.closure_date=gte.${shopToday()}&order=sort_order,slug`));
const notes = [];

async function rest(path) {
  const res = await fetch(`${REST}/${path}`, { headers: HEADERS });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function rpc(name, args) {
  const res = await fetch(`${REST}/rpc/${name}`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/* ---------------- checks ---------------- */

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('site is up and serving the current client', async () => {
  let last = '';
  for (let i = 1; i <= SITE_RETRIES; i++) {
    try {
      const res = await fetch(SITE, { headers: { 'cache-control': 'no-cache' } });
      const html = await res.text();
      if (res.status !== 200) { last = `HTTP ${res.status}`; }
      else if (!html.includes('data-barber-option=')) { last = 'barber picker markup missing (stale deploy?)'; }
      else if (!html.includes('data-barbers-head')) { last = 'barbers section hooks missing (stale deploy?)'; }
      else if (html.includes('data-barber-option="javier"')) { last = 'retired barber still in the markup (stale deploy?)'; }
      else if (!html.includes('data-cancel-root')) { last = 'cancellation panel markup missing (stale deploy?)'; }
      else if (!html.includes('data-hours-list')) { last = 'hours card markup missing (stale deploy?)'; }
      else return `200 OK, current markup present (attempt ${i})`;
    } catch (err) { last = String(err); }
    if (i < SITE_RETRIES) await sleep(30_000);
  }
  throw new Error(last);
});

check('the barbers read the site makes works, and every barber in it can be booked', async () => {
  const { status, body } = await readRoster();
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
  if (!Array.isArray(body)) throw new Error('response is not an array');
  const store = await rest('store_hours?select=weekday,open_time,close_time');
  if (store.status !== 200) throw new Error(`store_hours HTTP ${store.status}`);
  const storeByDay = Object.fromEntries(store.body.map(r => [r.weekday, r]));
  const problems = [];
  const slugs = new Set();
  for (const b of body) {
    if (!/^[a-z0-9-]{2,30}$/.test(b.slug || '')) problems.push(`slug "${b.slug}" is not a link-safe slug`);
    if (slugs.has(b.slug)) problems.push(`slug ${b.slug} twice`);
    slugs.add(b.slug);
    if (!(b.display_name || '').trim()) problems.push(`${b.slug} has no name`);
    if (!Array.isArray(b.barber_schedules) || !Array.isArray(b.barber_closures)) problems.push(`${b.slug}: schedules/closures not embedded`);
    for (const s of b.barber_schedules || []) {
      const day = storeByDay[s.weekday];
      if (!day) problems.push(`${b.slug} works weekday ${s.weekday}, when the store is closed`);
      else if (s.open_time < day.open_time || s.close_time > day.close_time || s.open_time >= s.close_time) {
        problems.push(`${b.slug} weekday ${s.weekday}: ${s.open_time}-${s.close_time} outside store ${day.open_time}-${day.close_time}`);
      }
    }
  }
  const bookable = body.filter(b => b.barber_schedules?.length);
  if (!bookable.length) problems.push('no active barber has weekly hours: the site falls back to config.js');
  if (problems.length) throw new Error(problems.join(' | '));
  const waiting = body.filter(b => !b.barber_schedules?.length).map(b => b.slug);
  return `barbers: ${bookable.map(b => b.slug).join(', ')}${waiting.length ? ` (no hours yet, not offered: ${waiting})` : ''}`;
});

check('config.js fallback barbers agree with the database', async () => {
  const { status, body } = await readRoster();
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const db = Object.fromEntries(body.map(b => [b.slug, b]));
  const drift = [];
  const agreed = [];
  for (const [slug, cfg] of Object.entries(BARBERS)) {
    const row = db[slug];
    if (!row) { notes.push(`config.js fallback barber ${slug} is not active in the database`); continue; }
    if (row.display_name !== cfg.name) notes.push(`config.js names ${slug} "${cfg.name}", the database "${row.display_name}"`);
    const week = Object.fromEntries(row.barber_schedules.map(r => [r.weekday, { open: hmsToMin(r.open_time), close: hmsToMin(r.close_time) }]));
    for (const wk of [0, 1, 2, 3, 4, 5, 6]) {
      const a = cfg.schedule[wk], b = week[wk];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        drift.push(`${slug} weekday ${wk}: DB ${JSON.stringify(b)} vs config ${JSON.stringify(a)}`);
      }
    }
    agreed.push(slug);
  }
  if (drift.length) throw new Error(drift.join(' | '));
  return agreed.length ? `${agreed.join(' + ')} hours aligned` : 'no fallback barber is active (see notes)';
});

check('the 404 page forwards a barber link (/<slug>)', async () => {
  const { status, body } = await readRoster();
  if (status !== 200 || !body.length) throw new Error('no active barber to try');
  const slug = body[0].slug;
  const res = await fetch(`${SITE}/${slug}`, { headers: { 'cache-control': 'no-cache' } });
  const html = await res.text();
  if (res.status !== 404) throw new Error(`/${slug} answered HTTP ${res.status}, not the 404 page (a file or folder shadows the slug?)`);
  if (!html.includes('resolvePrettyLink')) throw new Error('404.html has no barber-link check (stale deploy?)');
  const lookup = await rest(`barbers?select=slug&is_active=eq.true&slug=eq.${slug}`);
  if (lookup.status !== 200 || lookup.body?.[0]?.slug !== slug) throw new Error(`the 404 page's lookup for ${slug} failed: HTTP ${lookup.status}`);
  return `/${slug} is the 404 page, and its lookup finds ${slug}`;
});

check('service prices + durations match config.js mirrors', async () => {
  const { status, body } = await rest('services?select=slug,base_price_cents,duration_minutes&is_active=eq.true');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const drift = [];
  for (const s of body) {
    if (SERVICE_PRICES_CENTS[s.slug] !== s.base_price_cents) {
      drift.push(`${s.slug}: DB ${s.base_price_cents}¢ vs config ${SERVICE_PRICES_CENTS[s.slug]}¢`);
    }
    if (SERVICE_DURATIONS_MIN[s.slug] !== s.duration_minutes) {
      drift.push(`${s.slug}: DB ${s.duration_minutes}min vs config ${SERVICE_DURATIONS_MIN[s.slug]}min`);
    }
  }
  const missing = Object.keys(SERVICE_PRICES_CENTS).filter(k => !body.some(s => s.slug === k));
  if (missing.length) drift.push(`in config but not active in DB: ${missing}`);
  if (drift.length) throw new Error(drift.join(' | '));
  return `${body.length} services aligned`;
});

check('add-on prices match config.js mirror', async () => {
  const { status, body } = await rest('addons?select=slug,price_cents&is_active=eq.true');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const drift = [];
  for (const a of body) {
    if (ADDON_PRICES_CENTS[a.slug] !== a.price_cents) {
      drift.push(`${a.slug}: DB ${a.price_cents}¢ vs config ${ADDON_PRICES_CENTS[a.slug]}¢`);
    }
  }
  const missing = Object.keys(ADDON_PRICES_CENTS).filter(k => !body.some(a => a.slug === k));
  if (missing.length) drift.push(`in config but not active in DB: ${missing}`);
  if (drift.length) throw new Error(drift.join(' | '));
  return `${body.length} add-ons aligned`;
});

check('store hours match config.js STORE_HOURS', async () => {
  const { status, body } = await rest('store_hours?select=weekday,open_time,close_time&order=weekday');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const db = Object.fromEntries(body.map(r => [r.weekday, { open: hmsToMin(r.open_time), close: hmsToMin(r.close_time) }]));
  for (const wk of [0, 1, 2, 3, 4, 5, 6]) {
    const a = STORE_HOURS[wk], b = db[wk];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`weekday ${wk}: DB ${JSON.stringify(b)} vs config ${JSON.stringify(a)}`);
    }
  }
  return 'all 7 weekdays agree (10–6, closed Tuesdays)';
});

check('availability view is readable (slot grid data source)', async () => {
  const { status, body } = await rest('v_slot_availability?select=barber_slug,booking_date,booking_time,status&limit=5');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (!Array.isArray(body)) throw new Error('response is not an array');
  const leaked = body.some(r => 'customer_name' in r || 'customer_phone' in r);
  if (leaked) throw new Error('view is exposing PII columns!');
  return `readable, ${body.length} row(s) sampled, no PII fields`;
});

check('find_bookings_by_phone RPC is live (cancellation lookup)', async () => {
  const { status, body } = await rpc('find_bookings_by_phone', { p_phone: '5550009999' });
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
  if (!Array.isArray(body)) throw new Error('expected an array');
  return `live, returned ${body.length} rows for a dummy phone`;
});

check('book_slot RPC is live and validating (no row created)', async () => {
  // A 5-digit phone fails validation BEFORE any insert — proves the function
  // is deployed and its guard rails run, without touching real data. The
  // phone is checked before the barber, so this holds whoever is active.
  const { status, body } = await rpc('book_slot', {
    p_barber_slug: 'hassan', p_service_slug: 'hair-cut',
    p_date: '2030-01-01', p_time: '11:00:00',
    p_customer_name: 'Healthcheck', p_customer_phone: '55501',
  });
  const msg = JSON.stringify(body);
  if (status === 200) throw new Error('a 5-digit phone was ACCEPTED — validation regressed');
  if (!msg.includes('invalid_phone')) throw new Error(`unexpected error: HTTP ${status} ${msg}`);
  return 'rejects bad input with invalid_phone, as designed';
});

check('anon cannot read booking PII (RLS lockdown)', async () => {
  const { status, body } = await rest('bookings?select=customer_phone&limit=1');
  if (status === 200 && Array.isArray(body) && body.length > 0) {
    throw new Error('anon read a bookings row — RLS REGRESSION');
  }
  return status === 200 ? 'RLS returns zero rows to anon' : `denied with HTTP ${status}`;
});

check('anon cannot read the people view', async () => {
  const { status, body } = await rest('v_people?select=phone&limit=1');
  if (status === 200 && Array.isArray(body) && body.length > 0) {
    throw new Error('anon read a v_people row — GRANT REGRESSION');
  }
  return status === 200 ? 'returns zero rows to anon' : `denied with HTTP ${status}`;
});

check('anon cannot execute the barber app\'s manager RPCs', async () => {
  const { status, body } = await rpc('manager_staff', {});
  const msg = JSON.stringify(body);
  if (status >= 200 && status < 300) throw new Error('anon executed manager_staff!');
  if (status === 404 && msg.includes('PGRST202')) return 'migration 0022 not deployed yet';
  if (msg.includes('"forbidden"')) throw new Error('manager_staff RAN for anon (grant regression; only its own check stopped it)');
  return `denied with HTTP ${status}`;
});

check('anon cannot execute confirm_booking (owner-only RPC)', async () => {
  const { status, body } = await rpc('confirm_booking', {
    p_booking_id: '00000000-0000-0000-0000-000000000000',
  });
  if (status >= 200 && status < 300) throw new Error('anon executed confirm_booking!');
  const msg = JSON.stringify(body);
  if (msg.includes('booking_not_pending')) {
    throw new Error('confirm_booking RAN for anon (grant regression)');
  }
  return `denied with HTTP ${status}`;
});

/* ---------------- runner ---------------- */

let failed = 0;
console.log(`Live health — site: ${SITE}\n            — db:   ${SUPABASE_URL}\n`);
for (const { name, fn } of checks) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? `  —  ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}
for (const note of notes) console.log(`  · note: ${note}`);
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
