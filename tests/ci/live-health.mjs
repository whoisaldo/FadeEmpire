// live-health.mjs — end-to-end health check against the LIVE site + database.
//
// Read-only by design: every request here is one the public website itself
// makes from any visitor's browser (public anon key, public tables, and one
// RPC call that fails validation before it could ever write a row).
//
// What it catches:
//   * site down / stale deploy (missing markup the current client needs)
//   * DB drift: prices/hours/barbers changed in Studio but not in config.js
//     (or vice versa) — the #1 hazard of the mirror-constants architecture
//   * missing RPCs after a botched migration (booking + cancellation break)
//   * security regressions: bookings PII readable by anon, owner RPCs exposed
//
// Usage:  node tests/ci/live-health.mjs
//   LIVE_BASE_URL   override the site origin (default https://chicopeefadeempire.com)
//   SITE_RETRIES    retries for the site-content check (default 1; CI uses more
//                   because GitHub Pages deploys lag a push by a minute or two)

import {
  SUPABASE_URL, SUPABASE_ANON_KEY, STORE_HOURS, BARBERS,
  SERVICE_PRICES_CENTS, SERVICE_DURATIONS_MIN, ADDON_PRICES_CENTS,
} from '../../scripts/config.js';

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
      else if (!html.includes('data-barber-option="larry"')) { last = 'barber picker markup missing (stale deploy?)'; }
      else if (html.includes('data-barber-option="javier"')) { last = 'retired barber still in the markup (stale deploy?)'; }
      else if (!html.includes('data-cancel-root')) { last = 'cancellation panel markup missing (stale deploy?)'; }
      else return `200 OK, current markup present (attempt ${i})`;
    } catch (err) { last = String(err); }
    if (i < SITE_RETRIES) await sleep(30_000);
  }
  throw new Error(last);
});

check('active barbers in DB match config.js BARBERS', async () => {
  const { status, body } = await rest('barbers?select=slug,is_active&is_active=eq.true&order=slug');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const db = body.map(b => b.slug).sort();
  const mirror = Object.keys(BARBERS).sort();
  if (JSON.stringify(db) !== JSON.stringify(mirror)) {
    throw new Error(`DB [${db}] != config.js [${mirror}]`);
  }
  return `barbers: ${db.join(', ')}`;
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
  return 'all 7 weekdays agree (10–6 every day)';
});

check('barber schedules match config.js BARBERS[].schedule', async () => {
  const { status, body } = await rest('barber_schedules?select=weekday,open_time,close_time,barber_id,barbers(slug)');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const db = {};
  for (const r of body) {
    const slug = r.barbers?.slug;
    if (!slug) continue;
    (db[slug] ||= {})[r.weekday] = { open: hmsToMin(r.open_time), close: hmsToMin(r.close_time) };
  }
  for (const [slug, cfg] of Object.entries(BARBERS)) {
    for (const wk of [0, 1, 2, 3, 4, 5, 6]) {
      const a = cfg.schedule[wk], b = db[slug]?.[wk];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`${slug} weekday ${wk}: DB ${JSON.stringify(b)} vs config ${JSON.stringify(a)}`);
      }
    }
  }
  return 'hassan + larry schedules aligned';
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
  // is deployed and its guard rails run, without touching real data.
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
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
