// tests/ci/live-health.mjs's decisions: the barbers read before migration
// 0022 is applied (a note and skipped checks, not failures), and config.js's
// fallback barbers against hours the app changed (a note). The rules are
// tested directly, then the whole script runs with fetch replaced by a fake
// production (a preload module), so nothing is contacted.

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { missing0022Column, compareFallback } from './ci/live-health-rules.mjs';
import { BARBERS } from '../scripts/config.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// What production's PostgREST answers before 0022 (checked against PostgREST v14).
const PRE_0022 = { status: 400, body: { code: '42703', details: null, hint: null, message: 'column barbers.title does not exist' } };

// The database's rows for config.js's barbers, as the barbers read returns them.
const hms = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
const rowsFor = (barbers) => Object.values(barbers).map((b, i) => ({
  slug: b.slug, display_name: b.name, title: b.title, bio: null, photo_url: null, sort_order: i,
  barber_schedules: Object.entries(b.schedule).map(([wk, d]) => ({ weekday: Number(wk), open_time: hms(d.open), close_time: hms(d.close) })),
  barber_closures: [],
}));

describe('missing0022Column', () => {
  it('names the 0022 column production lacks', () => {
    expect(missing0022Column(PRE_0022)).toBe('title');
  });

  it.each([
    ['a column 0022 does not add', { status: 400, body: { ...PRE_0022.body, message: 'column barbers.bio does not exist' } }],
    ['a missing column in an embedded table', { status: 400, body: { ...PRE_0022.body, message: 'column barber_schedules_1.title does not exist' } }],
    ['another error code', { status: 400, body: { code: 'PGRST100', message: 'column barbers.title does not exist' } }],
    ['another status', { status: 500, body: PRE_0022.body }],
    ['a missing table', { status: 404, body: { code: 'PGRST205', message: 'Could not find the table public.barbers' } }],
    ['a body that is not JSON', { status: 400, body: null }],
    ['a working read', { status: 200, body: [] }],
  ])('is null for %s', (_, read) => {
    expect(missing0022Column(read)).toBeNull();
  });
});

describe('compareFallback', () => {
  it('agrees when the database has config.js\'s barbers', () => {
    expect(compareFallback(BARBERS, rowsFor(BARBERS))).toEqual({ notes: [], agreed: Object.keys(BARBERS) });
  });

  it('notes hours the app changed, naming the barber and the days', () => {
    const rows = rowsFor(BARBERS);
    const hassan = rows.find(r => r.slug === 'hassan');
    hassan.barber_schedules = hassan.barber_schedules
      .filter(s => s.weekday !== 1)                                             // Monday off
      .map(s => (s.weekday === 0 ? { ...s, close_time: '14:00:00' } : s));     // Sunday until 2
    const { notes, agreed } = compareFallback(BARBERS, rows);
    expect(agreed).toEqual(['larry']);
    expect(notes).toEqual(['Hassan\'s hours in the database differ from config.js\'s fallback on '
      + 'Sunday 10:00-14:00 (config.js 10:00-18:00), Monday off (config.js 10:00-18:00): '
      + 'the site uses the database\'s; refresh config.js in a later deploy']);
  });

  it('notes a fallback barber renamed or no longer active', () => {
    const rows = rowsFor(BARBERS).filter(r => r.slug !== 'larry');
    rows[0].display_name = 'Hassan A.';
    const { notes, agreed } = compareFallback(BARBERS, rows);
    expect(agreed).toEqual([]);
    expect(notes).toEqual([
      'config.js names hassan "Hassan", the database "Hassan A."',
      'config.js fallback barber larry is not active in the database',
    ]);
  });
});

// A fake production: the site and every request live-health makes. An unknown
// URL throws, so the script cannot reach the network.
const FAKE_PRODUCTION = (config) => `
import { SUPABASE_URL, STORE_HOURS, SERVICE_PRICES_CENTS, SERVICE_DURATIONS_MIN, ADDON_PRICES_CENTS } from ${JSON.stringify(config)};
const scenario = JSON.parse(process.env.FAKE_PRODUCTION);
const hms = (min) => \`\${String(Math.floor(min / 60)).padStart(2, '0')}:\${String(min % 60).padStart(2, '0')}:00\`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REST = SUPABASE_URL + '/rest/v1/';
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === 'http://site.test') {
    return new Response('<div data-barber-option="hassan" data-barbers-head data-cancel-root data-hours-list></div>');
  }
  if (url.startsWith('http://site.test/')) return new Response('<script>resolvePrettyLink</script>', { status: 404 });
  if (!url.startsWith(REST)) throw new Error('unexpected fetch ' + url);
  const path = decodeURIComponent(url.slice(REST.length));
  if (path.startsWith('barbers?select=slug,display_name')) return json(scenario.roster.body, scenario.roster.status);
  if (path.startsWith('barbers?select=slug&')) return json([{ slug: path.match(/slug=eq\\.([a-z0-9-]+)/)[1] }]);
  if (path.startsWith('store_hours?')) {
    return json(Object.entries(STORE_HOURS).map(([wk, d]) => ({ weekday: Number(wk), open_time: hms(d.open), close_time: hms(d.close) })));
  }
  if (path.startsWith('services?')) {
    return json(Object.keys(SERVICE_PRICES_CENTS).map(slug => ({ slug, base_price_cents: SERVICE_PRICES_CENTS[slug], duration_minutes: SERVICE_DURATIONS_MIN[slug] })));
  }
  if (path.startsWith('addons?')) return json(Object.entries(ADDON_PRICES_CENTS).map(([slug, price_cents]) => ({ slug, price_cents })));
  if (/^(v_slot_availability|bookings|v_people)\\?/.test(path)) return json([]);
  if (path === 'rpc/find_bookings_by_phone') return json([]);
  if (path === 'rpc/book_slot') return json({ code: 'P0001', message: 'invalid_phone' }, 400);
  if (path === 'rpc/manager_staff') return scenario.pre0022 ? json({ code: 'PGRST202' }, 404) : json({ code: '42501' }, 401);
  if (path === 'rpc/confirm_booking') return json({ code: '42501' }, 401);
  throw new Error('unexpected fetch ' + url);
};
`;

const dir = mkdtempSync(join(tmpdir(), 'fe-health-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const preload = join(dir, 'fake-production.mjs');
writeFileSync(preload, FAKE_PRODUCTION(pathToFileURL(join(REPO, 'scripts', 'config.js')).href));

function health(scenario) {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(REPO, 'tests', 'ci', 'live-health.mjs')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH, LIVE_BASE_URL: 'http://site.test', FAKE_PRODUCTION: JSON.stringify(scenario) },
  });
  return { ...r, out: r.stdout + r.stderr };
}

const ROSTER_CHECKS = [
  'the barbers read the site makes works, and every barber in it can be booked',
  'config.js fallback barbers compared with the database',
  'the 404 page forwards a barber link (/<slug>)',
];

describe('live-health.mjs against a fake production', () => {
  it('passes when production matches config.js', () => {
    const r = health({ roster: { status: 200, body: rowsFor(BARBERS) } });
    expect(r.out).toContain('14/14 checks passed');
    expect(r.out).not.toContain('note:');
    expect(r.status).toBe(0);
  });

  it('before 0022: a note, the barbers checks skipped, and no failure', () => {
    const r = health({ roster: PRE_0022, pre0022: true });
    for (const name of ROSTER_CHECKS) expect(r.out).toContain(`  - ${name}  —  skipped: migration 0022 not applied yet`);
    expect(r.out.match(/note: migration 0022 not applied yet/g)).toHaveLength(1);
    expect(r.out).toContain('· note: migration 0022 not applied yet: the site is using config.js\'s barbers');
    expect(r.out).toContain('11/14 checks passed, 3 skipped');
    expect(r.status).toBe(0);
  });

  it.each([
    ['fails for another reason', { status: 500, body: { message: 'boom' } }],
    ['lacks a column 0022 does not add', { status: 400, body: { code: '42703', message: 'column barbers.bio does not exist' } }],
  ])('fails the barbers checks when the read %s', (_, roster) => {
    const r = health({ roster });
    for (const name of ROSTER_CHECKS) expect(r.out).toContain(`  ✗ ${name}`);
    expect(r.out).not.toContain('skipped');
    expect(r.status).toBe(1);
  });

  it('notes hours the manager changed in the app, and passes', () => {
    const rows = rowsFor(BARBERS);
    rows.find(r => r.slug === 'larry').barber_schedules.find(s => s.weekday === 6).close_time = '15:00:00';
    const r = health({ roster: { status: 200, body: rows } });
    expect(r.out).toContain('· note: Larry\'s hours in the database differ from config.js\'s fallback on Saturday 10:00-15:00');
    expect(r.out).toContain('14/14 checks passed');
    expect(r.status).toBe(0);
  });

  it('still fails hours outside the store\'s', () => {
    const rows = rowsFor(BARBERS);
    rows.find(r => r.slug === 'larry').barber_schedules.find(s => s.weekday === 6).close_time = '20:00:00';
    const r = health({ roster: { status: 200, body: rows } });
    expect(r.out).toContain(`  ✗ ${ROSTER_CHECKS[0]}`);
    expect(r.out).toContain('larry weekday 6: 10:00:00-20:00:00 outside store');
    expect(r.status).toBe(1);
  });
});
