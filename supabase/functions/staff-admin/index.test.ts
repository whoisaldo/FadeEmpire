// deno test supabase/functions/staff-admin/
// fetch is stubbed: a fake Supabase Auth (the caller's /user and the admin API)
// and a fake PostgREST holding the staff, barbers and device_tokens rows.

import { assert, assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@1';
import { BAN_DURATION, type Env, handle, readEnv, temporaryPassword, WORDS } from './admin.ts';

const SUPABASE_URL = 'http://db.test';
const KEY = 'service-key';
const env: Env = readEnv((name) => ({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY } as Record<string, string>)[name]);

const ALI = '00000000-0000-4000-a000-000000000001';
const HASSAN = '00000000-0000-4000-a000-000000000002';
const LARRY_BARBER = '10000000-0000-4000-a000-000000000003';
const HASSAN_BARBER = '10000000-0000-4000-a000-000000000002';
const NEW_USER = '00000000-0000-4000-a000-000000000009';
const PASSWORD_RE = /^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/;

type Staff = { user_id: string; role: string; barber_id: string | null; display_name?: string; must_change_password?: boolean };
type Fake = {
  tokens: Record<string, { id: string; banned_until?: string | null }>; // JWT -> user
  staff: Staff[];
  barbers: string[];
  devices: { token: string; user_id: string }[];
  createStatus?: number;
  createBody?: unknown;
  staffInsertStatus?: number;
  staffInsertBody?: unknown;
  calls: { method: string; url: string; body?: unknown }[];
  created: { email: string; password: string; email_confirm: boolean }[];
  updates: { id: string; attrs: Record<string, unknown> }[];
  deletedUsers: string[];
};

function eqParam(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  return v?.startsWith('eq.') ? v.slice(3) : null;
}

function stubFetch(fake: Partial<Fake> = {}): Fake & { restore: () => void } {
  const state: Fake = {
    tokens: { 'jwt-ali': { id: ALI }, 'jwt-hassan': { id: HASSAN } },
    staff: [
      { user_id: ALI, role: 'manager', barber_id: null },
      { user_id: HASSAN, role: 'barber', barber_id: HASSAN_BARBER },
    ],
    barbers: [HASSAN_BARBER, LARRY_BARBER],
    devices: [{ token: 'tok-h', user_id: HASSAN }, { token: 'tok-a', user_id: ALI }],
    calls: [],
    created: [],
    updates: [],
    deletedUsers: [],
    ...fake,
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ method, url: url.pathname + url.search, body });
    const headers = new Headers(init?.headers);

    if (url.pathname === '/auth/v1/user') {
      const jwt = headers.get('Authorization')?.replace('Bearer ', '') ?? '';
      const user = state.tokens[jwt];
      return user ? Response.json(user) : Response.json({ msg: 'invalid JWT' }, { status: 401 });
    }

    // Everything past the caller check must use the service role key.
    if (headers.get('Authorization') !== `Bearer ${KEY}` || headers.get('apikey') !== KEY) {
      throw new Error(`call without the service key: ${method} ${url}`);
    }

    if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
      if (state.createStatus) return Response.json(state.createBody ?? {}, { status: state.createStatus });
      state.created.push(body);
      return Response.json({ id: NEW_USER, email: body.email });
    }
    const userPath = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
    if (userPath && method === 'PUT') {
      if (!state.staff.some((s) => s.user_id === userPath[1]) && userPath[1] !== NEW_USER) {
        return Response.json({ msg: 'User not found' }, { status: 404 });
      }
      state.updates.push({ id: userPath[1], attrs: body });
      return Response.json({ id: userPath[1] });
    }
    if (userPath && method === 'DELETE') {
      state.deletedUsers.push(userPath[1]);
      return Response.json({});
    }

    if (url.pathname === '/rest/v1/staff' && method === 'GET') {
      const uid = eqParam(url, 'user_id');
      const bid = eqParam(url, 'barber_id');
      return Response.json(state.staff.filter((s) => (uid ? s.user_id === uid : true) && (bid ? s.barber_id === bid : true)));
    }
    if (url.pathname === '/rest/v1/staff' && method === 'POST') {
      if (state.staffInsertStatus) {
        return Response.json(state.staffInsertBody ?? { code: 'XX000' }, { status: state.staffInsertStatus });
      }
      state.staff.push(body);
      return new Response(null, { status: 201 });
    }
    if (url.pathname === '/rest/v1/staff' && method === 'PATCH') {
      const uid = eqParam(url, 'user_id');
      state.staff.filter((s) => s.user_id === uid).forEach((s) => Object.assign(s, body));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/rest/v1/barbers' && method === 'GET') {
      const id = eqParam(url, 'id');
      return Response.json(state.barbers.filter((b) => b === id).map((b) => ({ id: b })));
    }
    if (url.pathname === '/rest/v1/device_tokens' && method === 'DELETE') {
      const uid = eqParam(url, 'user_id');
      state.devices = state.devices.filter((d) => d.user_id !== uid);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return Object.assign(state, { restore: () => (globalThis.fetch = original) });
}

function post(body: unknown, jwt: string | null = 'jwt-ali'): Request {
  return new Request('http://fn.test/staff-admin', {
    method: 'POST',
    headers: jwt ? { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(fake: Partial<Fake>, body: unknown, jwt: string | null = 'jwt-ali') {
  const stub = stubFetch(fake);
  const { error } = console;
  console.error = () => {};
  try {
    const res = await handle(post(body, jwt), env);
    return { status: res.status, json: await res.json(), stub };
  } finally {
    console.error = error;
    stub.restore();
  }
}

const createBarber = {
  action: 'create_login',
  email: '  Marco@Example.com ',
  display_name: 'Marco',
  role: 'barber',
  barber_id: LARRY_BARBER,
};

// ---------- Temporary passwords ----------

Deno.test('temporary password: four short words and two digits', () => {
  for (let i = 0; i < 50; i++) {
    const pw = temporaryPassword();
    assertMatch(pw, PASSWORD_RE);
    const words = pw.split('-').slice(0, 4);
    assert(words.every((w) => WORDS.includes(w)), pw);
  }
  assertNotEquals(temporaryPassword(), temporaryPassword());
});

Deno.test('temporary password: the word list is short words, no repeats', () => {
  assertEquals(new Set(WORDS).size, WORDS.length);
  assert(WORDS.length >= 200);
  assert(WORDS.every((w) => /^[a-z]{3,6}$/.test(w)));
});

Deno.test('temporary password: digits pad to two', () => {
  // A random source that always returns 0 picks the first word and "00".
  assertEquals(temporaryPassword((a) => a.fill(0)), `${WORDS[0]}-${WORDS[0]}-${WORDS[0]}-${WORDS[0]}-00`);
});

// ---------- The caller ----------

Deno.test('GET is not allowed', async () => {
  const res = await handle(new Request('http://fn.test/staff-admin'), env);
  assertEquals(res.status, 405);
  assertEquals(await res.json(), { error: 'method_not_allowed' });
});

Deno.test('missing configuration is a 500', async () => {
  const res = await handle(post({}), readEnv(() => undefined));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: 'not_configured' });
});

Deno.test('no Authorization header: 401', async () => {
  const { status, json, stub } = await call({}, createBarber, null);
  assertEquals([status, json], [401, { error: 'unauthorized' }]);
  assertEquals(stub.calls.length, 0);
});

Deno.test('an invalid JWT: 401, nothing else called', async () => {
  const { status, json, stub } = await call({}, createBarber, 'jwt-forged');
  assertEquals([status, json], [401, { error: 'unauthorized' }]);
  assertEquals(stub.calls.map((c) => c.url), ['/auth/v1/user']);
});

Deno.test('a barber is not a manager: 403', async () => {
  const { status, json, stub } = await call({}, createBarber, 'jwt-hassan');
  assertEquals([status, json], [403, { error: 'forbidden' }]);
  assertEquals(stub.created.length, 0);
});

Deno.test('a login with no staff row: 403', async () => {
  const { status, json } = await call({ tokens: { 'jwt-x': { id: NEW_USER } } }, createBarber, 'jwt-x');
  assertEquals([status, json], [403, { error: 'forbidden' }]);
});

Deno.test('a disabled manager login: 403', async () => {
  const banned = new Date(Date.now() + 86400_000).toISOString();
  const { status, json } = await call({ tokens: { 'jwt-ali': { id: ALI, banned_until: banned } } }, createBarber);
  assertEquals([status, json], [403, { error: 'forbidden' }]);
});

Deno.test('a body that is not JSON: 400', async () => {
  const { status, json } = await call({}, '{not json');
  assertEquals([status, json], [400, { error: 'invalid_request' }]);
});

Deno.test('an unknown action: 400', async () => {
  const { status, json } = await call({}, { action: 'delete_everything' });
  assertEquals([status, json], [400, { error: 'invalid_action' }]);
});

// ---------- create_login ----------

Deno.test('create_login: a barber login, confirmed, no email sent, must change password', async () => {
  const { status, json, stub } = await call({}, createBarber);
  assertEquals(status, 200);
  assertEquals(Object.keys(json).sort(), ['temporary_password', 'user_id']);
  assertEquals(json.user_id, NEW_USER);
  assertMatch(json.temporary_password, PASSWORD_RE);
  assertEquals(stub.created, [{
    email: 'marco@example.com',
    password: json.temporary_password,
    email_confirm: true,
    user_metadata: { display_name: 'Marco' },
  } as unknown as Fake['created'][number]]);
  assertEquals(stub.staff.at(-1), {
    user_id: NEW_USER,
    role: 'barber',
    barber_id: LARRY_BARBER,
    display_name: 'Marco',
    must_change_password: true,
  });
});

Deno.test('create_login: a manager login needs no chair', async () => {
  const { status, json, stub } = await call({}, {
    action: 'create_login', email: 'second@example.com', display_name: 'Second', role: 'manager',
  });
  assertEquals(status, 200);
  assertEquals(json.user_id, NEW_USER);
  assertEquals(stub.staff.at(-1)?.barber_id, null);
});

Deno.test('create_login: input checks', async () => {
  const cases: [Record<string, unknown>, number, string][] = [
    [{ email: 'not-an-email' }, 400, 'invalid_email'],
    [{ display_name: '  ' }, 400, 'invalid_display_name'],
    [{ role: 'owner' }, 400, 'invalid_role'],
    [{ barber_id: null }, 400, 'barber_required'],
    [{ barber_id: 'larry' }, 400, 'invalid_barber_id'],
    [{ barber_id: '20000000-0000-4000-a000-000000000000' }, 404, 'barber_not_found'],
    [{ barber_id: HASSAN_BARBER }, 409, 'barber_has_login'],
  ];
  for (const [change, wantStatus, wantError] of cases) {
    const { status, json, stub } = await call({}, { ...createBarber, ...change });
    assertEquals([status, json], [wantStatus, { error: wantError }], JSON.stringify(change));
    assertEquals(stub.created.length, 0);
  }
});

Deno.test('create_login: an email already in use is 409 email_taken', async () => {
  const { status, json } = await call(
    { createStatus: 422, createBody: { code: 422, error_code: 'email_exists', msg: 'already registered' } },
    createBarber,
  );
  assertEquals([status, json], [409, { error: 'email_taken' }]);
});

Deno.test('create_login: if the staff row fails, the new login is deleted again', async () => {
  const { status, json, stub } = await call({ staffInsertStatus: 500 }, createBarber);
  assertEquals([status, json], [500, { error: 'internal' }]);
  assertEquals(stub.deletedUsers, [NEW_USER]);
});

Deno.test('create_login: a chair taken in a race is 409 barber_has_login, and the login is deleted', async () => {
  const { status, json, stub } = await call(
    { staffInsertStatus: 409, staffInsertBody: { code: '23505', message: 'duplicate key' } },
    createBarber,
  );
  assertEquals([status, json], [409, { error: 'barber_has_login' }]);
  assertEquals(stub.deletedUsers, [NEW_USER]);
});

// ---------- reset_password ----------

Deno.test('reset_password: a new temporary password, and the change is forced again', async () => {
  const { status, json, stub } = await call({}, { action: 'reset_password', user_id: HASSAN });
  assertEquals(status, 200);
  assertEquals(Object.keys(json), ['temporary_password']);
  assertMatch(json.temporary_password, PASSWORD_RE);
  assertEquals(stub.updates, [{ id: HASSAN, attrs: { password: json.temporary_password } }]);
  assertEquals(stub.staff.find((s) => s.user_id === HASSAN)?.must_change_password, true);
});

Deno.test('reset_password: user_id must be a staff login', async () => {
  assertEquals(
    (await call({}, { action: 'reset_password', user_id: 'nope' })).json,
    { error: 'invalid_user_id' },
  );
  const { status, json, stub } = await call({}, { action: 'reset_password', user_id: NEW_USER });
  assertEquals([status, json], [404, { error: 'user_not_found' }]);
  assertEquals(stub.updates.length, 0);
});

// ---------- disable_login / enable_login ----------

Deno.test('disable_login: bans the login and deletes its device tokens', async () => {
  const { status, json, stub } = await call({}, { action: 'disable_login', user_id: HASSAN });
  assertEquals([status, json], [200, { ok: true }]);
  assertEquals(stub.updates, [{ id: HASSAN, attrs: { ban_duration: BAN_DURATION } }]);
  assertEquals(stub.devices, [{ token: 'tok-a', user_id: ALI }]);
});

Deno.test('disable_login: the manager cannot disable their own login', async () => {
  const { status, json, stub } = await call({}, { action: 'disable_login', user_id: ALI });
  assertEquals([status, json], [400, { error: 'cannot_disable_self' }]);
  assertEquals(stub.updates.length, 0);
});

Deno.test('disable_login: an unknown login is 404', async () => {
  const { status, json } = await call({}, { action: 'disable_login', user_id: NEW_USER });
  assertEquals([status, json], [404, { error: 'user_not_found' }]);
});

Deno.test('enable_login: lifts the ban', async () => {
  const { status, json, stub } = await call({}, { action: 'enable_login', user_id: HASSAN });
  assertEquals([status, json], [200, { ok: true }]);
  assertEquals(stub.updates, [{ id: HASSAN, attrs: { ban_duration: 'none' } }]);
});
