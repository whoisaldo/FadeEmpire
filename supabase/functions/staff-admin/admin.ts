// staff-admin logic: app logins, managed by the manager from the barber app.
// The caller's JWT is checked against Supabase Auth (GET /auth/v1/user) and the
// staff table; only a manager with a working login gets past that. Everything
// after it runs with the service role key: the Auth admin API for the login,
// PostgREST for the staff row and device tokens.
//
// POST {action: "create_login", email, display_name, role, barber_id?} -> {user_id, temporary_password}
//      {action: "reset_password", user_id}                             -> {temporary_password}
//      {action: "disable_login", user_id} / {action: "enable_login", user_id} -> {ok: true}
// Errors are {error: code} with a 4xx or 5xx status (see AdminError uses below).

export type Env = { supabaseUrl: string; serviceKey: string };

export function readEnv(get: (name: string) => string | undefined): Env {
  return {
    supabaseUrl: (get('SUPABASE_URL') ?? '').replace(/\/+$/, ''),
    serviceKey: get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  };
}

// A disabled login is banned for 100 years; enabling lifts the ban.
export const BAN_DURATION = '876000h';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Short, common, unambiguous words for temporary passwords: 4 words plus 2
// digits, e.g. "Lamp-river-oak-mint-42", read out or typed on a phone once. The
// capital, the digits and the hyphens (a symbol to Auth) meet the strictest
// password requirement the project can set.
export const WORDS = [
  'acorn', 'amber', 'anchor', 'apple', 'arrow', 'aspen', 'atlas', 'bacon', 'badge', 'bagel',
  'basil', 'beach', 'bean', 'bear', 'bell', 'berry', 'birch', 'bison', 'blade', 'bloom',
  'board', 'boat', 'bolt', 'bonus', 'boot', 'brass', 'bread', 'brick', 'brook', 'brush',
  'cabin', 'cable', 'cactus', 'camel', 'candy', 'canoe', 'cargo', 'cedar', 'chalk', 'charm',
  'chess', 'chili', 'cider', 'cliff', 'clock', 'cloud', 'clover', 'coast', 'cobra', 'cocoa',
  'comet', 'coral', 'cotton', 'crane', 'creek', 'crown', 'cube', 'daisy', 'delta', 'denim',
  'desk', 'dime', 'disco', 'dock', 'dove', 'dragon', 'drum', 'eagle', 'echo', 'elbow',
  'elm', 'ember', 'fable', 'falcon', 'fern', 'ferry', 'field', 'finch', 'flag', 'flame',
  'flint', 'flute', 'forest', 'fox', 'frost', 'fudge', 'garden', 'gecko', 'ginger', 'glove',
  'goat', 'grape', 'gravel', 'harbor', 'hawk', 'hazel', 'honey', 'horse', 'iris', 'island',
  'ivory', 'jacket', 'jade', 'jelly', 'jet', 'juice', 'kayak', 'kettle', 'kiwi', 'koala',
  'ladder', 'lake', 'lamp', 'lemon', 'lily', 'lime', 'lion', 'llama', 'lotus', 'magnet',
  'mango', 'maple', 'marble', 'meadow', 'melon', 'mint', 'mirror', 'moose', 'moss', 'mule',
  'nest', 'noble', 'north', 'oak', 'oasis', 'ocean', 'olive', 'onion', 'orbit', 'otter',
  'owl', 'paddle', 'panda', 'paper', 'peach', 'pearl', 'pecan', 'pepper', 'piano', 'pilot',
  'pine', 'pixel', 'plum', 'pond', 'poppy', 'prism', 'pump', 'quail', 'quartz', 'quilt',
  'rabbit', 'radio', 'raven', 'reef', 'ribbon', 'ridge', 'river', 'robin', 'rocket', 'rope',
  'rose', 'ruby', 'saddle', 'sage', 'salt', 'sand', 'satin', 'scarf', 'seal', 'shell',
  'silk', 'silver', 'slate', 'sled', 'snow', 'sock', 'solar', 'spark', 'spice', 'spoon',
  'spruce', 'stone', 'storm', 'straw', 'sugar', 'summit', 'swan', 'table', 'tango', 'thyme',
  'tiger', 'timber', 'toast', 'topaz', 'torch', 'tower', 'trail', 'tulip', 'tuna', 'turtle',
  'velvet', 'violet', 'wagon', 'walnut', 'wave', 'whale', 'wheat', 'willow', 'window', 'wolf',
  'yarn', 'yeti', 'zebra', 'zinc',
];

// A uniform index below n from crypto randomness (rejection sampling, no modulo bias).
function randomBelow(n: number, random: (a: Uint32Array) => Uint32Array): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    random(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function temporaryPassword(
  random: (a: Uint32Array) => Uint32Array = (a) => crypto.getRandomValues(a),
): string {
  const words = Array.from({ length: 4 }, () => WORDS[randomBelow(WORDS.length, random)]);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  const digits = String(randomBelow(100, random)).padStart(2, '0');
  return `${words.join('-')}-${digits}`;
}

class AdminError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function serviceHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.serviceKey,
    Authorization: `Bearer ${env.serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function rest<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: serviceHeaders(env, (init.headers ?? {}) as Record<string, string>),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = '';
    try {
      code = JSON.parse(text)?.code ?? '';
    } catch { /* not JSON */ }
    if (code === '23505') throw new AdminError(409, 'barber_has_login');
    throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function authAdmin(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return await fetch(`${env.supabaseUrl}/auth/v1/admin/${path}`, {
    method,
    headers: serviceHeaders(env),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// The caller's user id when their JWT is valid, their login is not disabled,
// and their staff row is a manager.
async function requireManager(env: Env, req: Request): Promise<string> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer \S+$/.test(auth)) throw new AdminError(401, 'unauthorized');
  const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.serviceKey, Authorization: auth },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new AdminError(401, 'unauthorized');
  }
  const user = await res.json() as { id?: string; banned_until?: string | null };
  if (!user.id) throw new AdminError(401, 'unauthorized');
  if (user.banned_until && Date.parse(user.banned_until) > Date.now()) throw new AdminError(403, 'forbidden');
  const rows = await rest<{ role: string }[]>(env, `staff?select=role&user_id=eq.${user.id}`);
  if (rows[0]?.role !== 'manager') throw new AdminError(403, 'forbidden');
  return user.id;
}

function userIdFrom(body: Record<string, unknown>): string {
  const id = typeof body.user_id === 'string' ? body.user_id : '';
  if (!UUID_RE.test(id)) throw new AdminError(400, 'invalid_user_id');
  return id;
}

async function requireStaff(env: Env, userId: string): Promise<void> {
  const rows = await rest<unknown[]>(env, `staff?select=user_id&user_id=eq.${userId}`);
  if (rows.length === 0) throw new AdminError(404, 'user_not_found');
}

// A failed Auth admin call as the error the app is given: a password the project's
// policy rejects is weak_password, an email with a login already is email_taken, and
// anything else is internal, with Auth's answer logged.
async function authFailure(res: Response, what: string): Promise<Error> {
  const text = await res.text();
  let code: unknown;
  try {
    // error_code, or code in Auth's 2024-01-01 API format (otherwise code is the HTTP status).
    const body = JSON.parse(text);
    code = body?.error_code ?? body?.code;
  } catch { /* not JSON */ }
  if (code === 'weak_password') return new AdminError(422, 'weak_password');
  if (code === 'email_exists' || code === 'user_already_exists') return new AdminError(409, 'email_taken');
  return new Error(`${what}: ${res.status} ${text}`);
}

async function updateUser(env: Env, userId: string, attrs: Record<string, unknown>): Promise<void> {
  const res = await authAdmin(env, 'PUT', `users/${userId}`, attrs);
  if (res.status === 404) {
    await res.body?.cancel();
    throw new AdminError(404, 'user_not_found');
  }
  if (!res.ok) throw await authFailure(res, `auth update ${userId}`);
  await res.body?.cancel();
}

async function createLogin(env: Env, body: Record<string, unknown>) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  const role = body.role;
  const barberId = body.barber_id ?? null;
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AdminError(400, 'invalid_email');
  if (displayName.length < 1 || displayName.length > 60) throw new AdminError(400, 'invalid_display_name');
  if (role !== 'barber' && role !== 'manager') throw new AdminError(400, 'invalid_role');
  if (barberId !== null && (typeof barberId !== 'string' || !UUID_RE.test(barberId))) {
    throw new AdminError(400, 'invalid_barber_id');
  }
  if (role === 'barber' && barberId === null) throw new AdminError(400, 'barber_required');
  if (barberId !== null) {
    const barbers = await rest<unknown[]>(env, `barbers?select=id&id=eq.${barberId}`);
    if (barbers.length === 0) throw new AdminError(404, 'barber_not_found');
    const taken = await rest<unknown[]>(env, `staff?select=user_id&barber_id=eq.${barberId}`);
    if (taken.length > 0) throw new AdminError(409, 'barber_has_login');
  }

  const password = temporaryPassword();
  const res = await authAdmin(env, 'POST', 'users', {
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (!res.ok) throw await authFailure(res, `auth create ${email}`);
  const user = await res.json() as { id: string };

  try {
    await rest(env, 'staff', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: user.id,
        role,
        barber_id: barberId,
        display_name: displayName,
        must_change_password: true,
      }),
    });
  } catch (err) {
    // No staff row means the login can do nothing; remove it so the email is free again.
    const del = await authAdmin(env, 'DELETE', `users/${user.id}`);
    await del.body?.cancel();
    throw err;
  }
  return { user_id: user.id, temporary_password: password };
}

async function resetPassword(env: Env, body: Record<string, unknown>) {
  const userId = userIdFrom(body);
  await requireStaff(env, userId);
  const password = temporaryPassword();
  await updateUser(env, userId, { password });
  await rest(env, `staff?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ must_change_password: true }),
  });
  return { temporary_password: password };
}

async function disableLogin(env: Env, body: Record<string, unknown>, callerId: string) {
  const userId = userIdFrom(body);
  if (userId === callerId) throw new AdminError(400, 'cannot_disable_self');
  await requireStaff(env, userId);
  await updateUser(env, userId, { ban_duration: BAN_DURATION });
  await rest(env, `device_tokens?user_id=eq.${userId}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  return { ok: true };
}

async function enableLogin(env: Env, body: Record<string, unknown>) {
  const userId = userIdFrom(body);
  await requireStaff(env, userId);
  await updateUser(env, userId, { ban_duration: 'none' });
  return { ok: true };
}

export async function handle(req: Request, env: Env): Promise<Response> {
  if (!env.supabaseUrl || !env.serviceKey) {
    return Response.json({ error: 'not_configured' }, { status: 500 });
  }
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  try {
    const callerId = await requireManager(env, req);
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw new AdminError(400, 'invalid_request');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AdminError(400, 'invalid_request');
    }
    switch (body.action) {
      case 'create_login':
        return Response.json(await createLogin(env, body));
      case 'reset_password':
        return Response.json(await resetPassword(env, body));
      case 'disable_login':
        return Response.json(await disableLogin(env, body, callerId));
      case 'enable_login':
        return Response.json(await enableLogin(env, body));
      default:
        throw new AdminError(400, 'invalid_action');
    }
  } catch (err) {
    if (err instanceof AdminError) return Response.json({ error: err.code }, { status: err.status });
    console.error(String(err));
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
