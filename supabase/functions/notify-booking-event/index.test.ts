// deno test supabase/functions/notify-booking-event/
// fetch is stubbed: a fake PostgREST returns the event payload and records
// dropped tokens, a fake APNs answers per token with a configurable status.
// The APNs key is a P-256 key generated per run, so the provider token's
// signature is checked for real.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  type Apns,
  APNS_HOSTS,
  type BookingEvent,
  DEFAULT_TOPIC,
  type Env,
  formatDate,
  formatTime,
  handle,
  type Payload,
  providerToken,
  pushFor,
  pushesFor,
  readEnv,
  type Recipient,
  TOKEN_WINDOW_S,
} from './notify.ts';

const SUPABASE_URL = 'http://db.test';
const KEY = 'service-key';
const NOW = new Date('2026-10-20T16:00:00Z');

const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
const PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;

const dryEnv: Env = readEnv((name) => ({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY } as Record<string, string>)[name]);
const liveVars: Record<string, string> = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: KEY,
  APNS_KEY_ID: 'KEY1234567',
  APNS_TEAM_ID: '9X79V37Q89',
  APNS_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'), // as a one-line secret
};
const liveEnv: Env = readEnv((name) => liveVars[name]);

const LARRY_CHAIR = 'barber-larry';
const event = (over: Partial<BookingEvent> = {}): BookingEvent => ({
  id: 41,
  kind: 'booked',
  actor: 'customer',
  actor_user_id: null,
  booking_id: 'booking-1',
  barber_id: LARRY_CHAIR,
  barber_name: 'Larry',
  customer_first_name: 'Marcus',
  booking_date: '2026-10-22',
  booking_time: '14:15:00',
  is_guest: false,
  service_name: 'Hair Cut',
  party_size: 1,
  ...over,
});
const recipient = (over: Partial<Recipient> = {}): Recipient => ({
  token: 'tok-larry',
  environment: 'production',
  user_id: 'user-larry',
  role: 'barber',
  own_chair: true,
  notify_bookings: true,
  notify_cancellations: true,
  notify_viewed_chairs: false,
  ...over,
});
const hassan = (over: Partial<Recipient> = {}) =>
  recipient({ token: 'tok-hassan', user_id: 'user-hassan', own_chair: false, environment: 'sandbox', ...over });
const ali = (over: Partial<Recipient> = {}) =>
  recipient({ token: 'tok-ali', user_id: 'user-ali', role: 'manager', own_chair: false, ...over });

type Fake = {
  payload: Payload;
  apnsStatus: Record<string, number>; // token -> status, default 200
  apnsReason: Record<string, string>;
  apnsThrows?: boolean;
  pushes: { url: string; headers: Headers; body: Record<string, unknown> }[];
  dropped: string[][];
  rpcs: string[];
};

function stubFetch(fake: Partial<Fake>): Fake & { restore: () => void } {
  const state: Fake = { payload: { event: null, recipients: [] }, apnsStatus: {}, apnsReason: {}, pushes: [], dropped: [], rpcs: [], ...fake };
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(APNS_HOSTS.sandbox) || url.startsWith(APNS_HOSTS.production)) {
      if (state.apnsThrows) throw new TypeError('network down');
      const token = url.split('/').pop()!;
      state.pushes.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const status = state.apnsStatus[token] ?? 200;
      const reason = state.apnsReason[token];
      return new Response(reason ? JSON.stringify({ reason }) : null, { status });
    }
    const headers = new Headers(init?.headers);
    if (headers.get('Authorization') !== `Bearer ${KEY}`) throw new Error(`rpc without the service key: ${url}`);
    if (url === `${SUPABASE_URL}/rest/v1/rpc/notify_event_payload`) {
      state.rpcs.push('notify_event_payload');
      assertEquals(JSON.parse(String(init?.body)), { p_event_id: 41 });
      return Response.json(state.payload);
    }
    if (url === `${SUPABASE_URL}/rest/v1/rpc/notify_drop_device_tokens`) {
      state.rpcs.push('notify_drop_device_tokens');
      const tokens = JSON.parse(String(init?.body)).p_tokens as string[];
      state.dropped.push(tokens);
      return Response.json(tokens.length);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return Object.assign(state, { restore: () => (globalThis.fetch = original) });
}

const quiet = () => {
  const { log, error } = console;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, { log, error }) };
};

const request = (body: unknown, key = KEY) =>
  new Request('http://fn.test/notify-booking-event', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function invoke(fake: Partial<Fake>, env: Env = liveEnv) {
  const stub = stubFetch(fake);
  const log = quiet();
  try {
    const res = await handle(request({ event_id: 41 }), env, NOW);
    return { status: res.status, json: await res.json(), stub, lines: log.lines };
  } finally {
    log.restore();
    stub.restore();
  }
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
}

// ---------- Copy ----------

Deno.test('copy: own chair, a new booking', () => {
  assertEquals(pushFor(event(), recipient()), {
    token: 'tok-larry',
    environment: 'production',
    title: 'New booking',
    body: 'Marcus · Thu Oct 22, 2:15 PM · Hair Cut',
  });
});

Deno.test('copy: a viewed chair names the chair', () => {
  assertEquals(
    pushFor(event(), hassan({ notify_viewed_chairs: true }))?.body,
    "Marcus · Thu Oct 22, 2:15 PM · Hair Cut · Larry's chair",
  );
});

Deno.test('copy: titles per kind', () => {
  const titles = (['booked', 'moved', 'cancelled', 'no_show'] as const)
    .map((kind) => pushFor(event({ kind }), recipient())?.title);
  assertEquals(titles, ['New booking', 'Moved', 'Cancelled', 'No-show']);
});

Deno.test('copy: a group booking names the booker and the rest', () => {
  assertEquals(pushFor(event({ party_size: 3 }), recipient())?.body, 'Marcus + 2 · Thu Oct 22, 2:15 PM · Hair Cut');
  assertEquals(pushFor(event({ party_size: 3, kind: 'cancelled' }), recipient())?.body, 'Marcus · Thu Oct 22, 2:15 PM · Hair Cut');
});

Deno.test('dates and times', () => {
  assertEquals(formatDate('2026-10-22'), 'Thu Oct 22');
  assertEquals(formatTime('10:00:00'), '10:00 AM');
  assertEquals(formatTime('12:15:00'), '12:15 PM');
  assertEquals(formatTime('17:30:00'), '5:30 PM');
});

// ---------- Recipients ----------

Deno.test('rules: own chair follows notify_bookings and notify_cancellations', () => {
  assertEquals(pushFor(event(), recipient({ notify_bookings: false })), null);
  assertEquals(pushFor(event({ kind: 'moved' }), recipient({ notify_bookings: false })), null);
  assert(pushFor(event({ kind: 'cancelled' }), recipient({ notify_bookings: false })));
  assertEquals(pushFor(event({ kind: 'cancelled' }), recipient({ notify_cancellations: false })), null);
  assertEquals(pushFor(event({ kind: 'no_show' }), recipient({ notify_cancellations: false })), null);
  assert(pushFor(event(), recipient({ notify_cancellations: false })));
});

Deno.test('rules: a granted chair also needs notify_viewed_chairs', () => {
  assertEquals(pushFor(event(), hassan()), null);
  assert(pushFor(event(), hassan({ notify_viewed_chairs: true })));
  assertEquals(pushFor(event(), hassan({ notify_viewed_chairs: true, notify_bookings: false })), null);
});

Deno.test('rules: the manager is a granted viewer of every chair', () => {
  assertEquals(pushFor(event(), ali()), null);
  assertEquals(pushFor(event(), ali({ notify_viewed_chairs: true }))?.body, "Marcus · Thu Oct 22, 2:15 PM · Hair Cut · Larry's chair");
});

Deno.test('rules: the user who acted gets nothing', () => {
  const byLarry = event({ kind: 'cancelled', actor: 'barber', actor_user_id: 'user-larry' });
  assertEquals(pushFor(byLarry, recipient()), null);
  assert(pushFor(byLarry, ali({ notify_viewed_chairs: true })));
});

Deno.test('rules: a group guest makes no booking push of its own, but its cancellation does', () => {
  assertEquals(pushFor(event({ is_guest: true, party_size: 3 }), recipient()), null);
  assert(pushFor(event({ is_guest: true, kind: 'cancelled' }), recipient()));
});

Deno.test('pushesFor: no event, no pushes', () => {
  assertEquals(pushesFor({ event: null, recipients: [recipient()] }), []);
});

// ---------- Provider token ----------

Deno.test('provider token: ES256, kid and iss, signature verifies', async () => {
  const apns = liveEnv.apns as Apns;
  const jwt = await providerToken(apns, NOW);
  const [h, c, s] = jwt.split('.');
  assertEquals(decodePart(h), { alg: 'ES256', kid: 'KEY1234567' });
  const claims = decodePart(c);
  assertEquals(claims.iss, '9X79V37Q89');
  const iat = claims.iat as number;
  assert(iat <= NOW.getTime() / 1000 && iat > NOW.getTime() / 1000 - TOKEN_WINDOW_S);
  const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  assertEquals(sig.length, 64);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.publicKey,
    sig,
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert(ok, 'signature verifies with the public key');
});

Deno.test('provider token: one token per 50-minute window', async () => {
  const apns = liveEnv.apns as Apns;
  const a = await providerToken(apns, NOW);
  const b = await providerToken(apns, new Date(NOW.getTime() + 60_000));
  const later = await providerToken(apns, new Date(NOW.getTime() + TOKEN_WINDOW_S * 1000));
  assertEquals(a, b);
  assert(a !== later);
});

Deno.test('readEnv: the APNs secrets, topic default, and dry without them', () => {
  assertEquals(liveEnv.apns?.topic, DEFAULT_TOPIC);
  assertEquals(liveEnv.apns?.privateKey, PEM);
  assertEquals(dryEnv.apns, null);
  assertEquals(readEnv((n) => ({ ...liveVars, APNS_TEAM_ID: '' } as Record<string, string>)[n]).apns, null);
});

// ---------- The handler ----------

Deno.test('handler: the service role key is required', async () => {
  const stub = stubFetch({});
  try {
    const res = await handle(request({ event_id: 41 }, 'anon-key'), liveEnv, NOW);
    assertEquals(res.status, 401);
    assertEquals(stub.rpcs, []);
  } finally {
    stub.restore();
  }
});

Deno.test('handler: event_id is required', async () => {
  const res = await handle(request({ event: 41 }), liveEnv, NOW);
  assertEquals(res.status, 400);
});

Deno.test('handler: without APNs secrets it logs and returns 200, sending nothing', async () => {
  const { status, json, stub, lines } = await invoke({ payload: { event: event(), recipients: [recipient()] } }, dryEnv);
  assertEquals(status, 200);
  assertEquals(json, { dry_run: true, event_id: 41, due: 1, sent: 0, failed: 0, dropped: 0 });
  assertEquals(stub.pushes, []);
  assert(lines.some((l) => l.includes('[dry-run]') && l.includes('New booking | Marcus')));
});

Deno.test('handler: sends per device, to the sandbox or production host', async () => {
  const { status, json, stub } = await invoke({
    payload: {
      event: event(),
      recipients: [recipient(), hassan({ notify_viewed_chairs: true }), ali()],
    },
  });
  assertEquals(status, 200);
  assertEquals(json, { dry_run: false, event_id: 41, due: 2, sent: 2, failed: 0, dropped: 0 });
  assertEquals(stub.pushes.map((p) => p.url), [
    'https://api.push.apple.com/3/device/tok-larry',
    'https://api.sandbox.push.apple.com/3/device/tok-hassan',
  ]);
  const first = stub.pushes[0];
  assertEquals(first.headers.get('apns-topic'), 'com.chicopeefadeempire.barbers');
  assertEquals(first.headers.get('apns-push-type'), 'alert');
  assert(first.headers.get('authorization')?.startsWith('bearer ey'));
  assertEquals(first.body, {
    aps: { alert: { title: 'New booking', body: 'Marcus · Thu Oct 22, 2:15 PM · Hair Cut' }, sound: 'default', 'thread-id': LARRY_CHAIR },
    event_id: 41,
    kind: 'booked',
    booking_id: 'booking-1',
    barber_id: LARRY_CHAIR,
    booking_date: '2026-10-22',
  });
});

Deno.test('handler: tokens APNs reports dead are dropped, other failures are not', async () => {
  const { json, stub } = await invoke({
    payload: {
      event: event({ kind: 'cancelled' }),
      recipients: [
        recipient({ token: 'tok-gone' }),
        recipient({ token: 'tok-bad' }),
        recipient({ token: 'tok-busy' }),
        recipient({ token: 'tok-fine' }),
      ],
    },
    apnsStatus: { 'tok-gone': 410, 'tok-bad': 400, 'tok-busy': 503 },
    apnsReason: { 'tok-gone': 'Unregistered', 'tok-bad': 'BadDeviceToken', 'tok-busy': 'ServiceUnavailable' },
  });
  assertEquals(json, { dry_run: false, event_id: 41, due: 4, sent: 1, failed: 1, dropped: 2 });
  assertEquals(stub.dropped, [['tok-gone', 'tok-bad']]);
});

Deno.test('handler: a network error counts as failed, drops nothing', async () => {
  const { status, json, stub } = await invoke({
    payload: { event: event(), recipients: [recipient()] },
    apnsThrows: true,
  });
  assertEquals(status, 200);
  assertEquals(json.failed, 1);
  assertEquals(stub.dropped, []);
});

Deno.test('handler: an event that is gone sends nothing', async () => {
  const { status, json, stub } = await invoke({ payload: { event: null, recipients: [] } });
  assertEquals(status, 200);
  assertEquals(json.due, 0);
  assertEquals(stub.pushes, []);
});
