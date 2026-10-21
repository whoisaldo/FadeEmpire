// notify-booking-event logic. A trigger on booking_events posts {event_id}
// here through pg_net (0022). The function reads the event and the devices
// that may hear about it (notify_event_payload), applies each user's
// notification settings, and sends an APNs alert to each device that wants it.
// Tokens APNs reports as dead are deleted (notify_drop_device_tokens). Without
// the APNS_* secrets it runs dry: logs each push, sends nothing, returns 200.
//
// Who hears about an event:
//   - nobody whose own action caused it (actor_user_id);
//   - their own chair: notify_bookings for booked/moved, notify_cancellations
//     for cancelled/no_show;
//   - a granted chair, and every chair for a manager who does not cut on it:
//     the same setting AND notify_viewed_chairs;
//   - a guest added to a group booking makes no booked/moved push of its own:
//     the booker's push says "Andre + 2".

export type Apns = { keyId: string; teamId: string; privateKey: string; topic: string };

export type Env = {
  supabaseUrl: string;
  serviceKey: string;
  apns: Apns | null;
};

export type EventKind = 'booked' | 'cancelled' | 'no_show' | 'moved';

export type BookingEvent = {
  id: number;
  kind: EventKind;
  actor: string;
  actor_user_id: string | null;
  booking_id: string;
  barber_id: string;
  barber_name: string;
  customer_first_name: string;
  booking_date: string; // 'YYYY-MM-DD', shop-local
  booking_time: string; // 'HH:MM:SS', shop-local
  is_guest: boolean;
  service_name: string;
  party_size: number;
};

export type Recipient = {
  token: string;
  environment: 'sandbox' | 'production';
  user_id: string;
  role: 'manager' | 'barber';
  own_chair: boolean;
  notify_bookings: boolean;
  notify_cancellations: boolean;
  notify_viewed_chairs: boolean;
};

export type Payload = { event: BookingEvent | null; recipients: Recipient[] };

export type Push = { token: string; environment: Recipient['environment']; title: string; body: string };

type Summary = {
  dry_run: boolean;
  event_id: number;
  due: number;
  sent: number;
  failed: number;
  dropped: number;
};

export const DEFAULT_TOPIC = 'com.chicopeefadeempire.barbers';
export const APNS_HOSTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;

// APNs rejects a provider token older than an hour and one refreshed more than
// every 20 minutes. Every token's iat is rounded down to a 50-minute boundary,
// so all runs in the same window sign the same claims.
export const TOKEN_WINDOW_S = 50 * 60;

// APNs answers that mean the token will never work again: delete it.
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const TITLES: Record<EventKind, string> = {
  booked: 'New booking',
  moved: 'Moved',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function readEnv(get: (name: string) => string | undefined): Env {
  const keyId = get('APNS_KEY_ID')?.trim();
  const teamId = get('APNS_TEAM_ID')?.trim();
  // A .p8 pasted into a one-line secret often arrives with literal "\n".
  const privateKey = get('APNS_PRIVATE_KEY')?.replace(/\\n/g, '\n').trim();
  return {
    supabaseUrl: (get('SUPABASE_URL') ?? '').replace(/\/+$/, ''),
    serviceKey: get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    apns: keyId && teamId && privateKey
      ? { keyId, teamId, privateKey, topic: get('APNS_TOPIC')?.trim() || DEFAULT_TOPIC }
      : null,
  };
}

// '2026-10-23' -> 'Thu Oct 23'
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${MONTHS[m - 1]} ${d}`;
}

// '14:15:00' -> '2:15 PM'
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

// The push for one device, or null when this user should not get one.
export function pushFor(event: BookingEvent, r: Recipient): Push | null {
  if (event.actor_user_id && r.user_id === event.actor_user_id) return null;
  const isBooking = event.kind === 'booked' || event.kind === 'moved';
  if (isBooking && event.is_guest) return null;
  const wants = isBooking ? r.notify_bookings : r.notify_cancellations;
  if (!wants || (!r.own_chair && !r.notify_viewed_chairs)) return null;

  const others = isBooking && event.party_size > 1 ? ` + ${event.party_size - 1}` : '';
  const name = (event.customer_first_name || 'Customer') + others;
  const chair = r.own_chair ? '' : ` · ${event.barber_name}'s chair`;
  return {
    token: r.token,
    environment: r.environment,
    title: TITLES[event.kind],
    body: `${name} · ${formatDate(event.booking_date)}, ${formatTime(event.booking_time)} · ${event.service_name}${chair}`,
  };
}

export function pushesFor(payload: Payload): Push[] {
  if (!payload.event) return [];
  return payload.recipients.map((r) => pushFor(payload.event!, r)).filter((p): p is Push => p !== null);
}

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemBody(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

const tokenCache = new Map<string, string>();

// The ES256 provider token APNs expects: header {alg, kid}, claims {iss, iat},
// signed with the .p8 key. WebCrypto's ECDSA signature is already the raw
// r||s form JWS uses.
export async function providerToken(apns: Apns, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000 / TOKEN_WINDOW_S) * TOKEN_WINDOW_S;
  const cacheKey = `${apns.teamId}:${apns.keyId}:${iat}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(apns.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signingInput = `${base64url(JSON.stringify({ alg: 'ES256', kid: apns.keyId }))}.` +
    base64url(JSON.stringify({ iss: apns.teamId, iat }));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const token = `${signingInput}.${base64url(new Uint8Array(signature))}`;
  tokenCache.clear();
  tokenCache.set(cacheKey, token);
  return token;
}

async function rpc<T>(env: Env, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name} failed: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

function maskToken(token: string): string {
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

async function send(apns: Apns, jwt: string, push: Push, event: BookingEvent): Promise<Response> {
  return await fetch(`${APNS_HOSTS[push.environment]}/3/device/${push.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': apns.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: { alert: { title: push.title, body: push.body }, sound: 'default', 'thread-id': event.barber_id },
      event_id: event.id,
      kind: event.kind,
      booking_id: event.booking_id,
      barber_id: event.barber_id,
      booking_date: event.booking_date,
    }),
  });
}

export async function run(env: Env, eventId: number, now = new Date()): Promise<Summary> {
  const payload = await rpc<Payload>(env, 'notify_event_payload', { p_event_id: eventId });
  const pushes = pushesFor(payload);
  const summary: Summary = {
    dry_run: env.apns === null,
    event_id: eventId,
    due: pushes.length,
    sent: 0,
    failed: 0,
    dropped: 0,
  };
  if (!env.apns) {
    for (const p of pushes) console.log(`[dry-run] ${p.environment} ${maskToken(p.token)}: ${p.title} | ${p.body}`);
    return summary;
  }

  const jwt = await providerToken(env.apns, now);
  const dead: string[] = [];
  for (const p of pushes) {
    let res: Response;
    try {
      res = await send(env.apns, jwt, p, payload.event!);
    } catch (err) {
      summary.failed++;
      console.error(`push to ${maskToken(p.token)} failed: ${err}`);
      continue;
    }
    if (res.ok) {
      await res.body?.cancel();
      summary.sent++;
      continue;
    }
    const text = await res.text();
    let reason = '';
    try {
      reason = JSON.parse(text)?.reason ?? '';
    } catch { /* not JSON */ }
    if (res.status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
      dead.push(p.token);
    } else {
      summary.failed++;
      console.error(`push to ${maskToken(p.token)} failed: APNs ${res.status} ${text}`);
    }
  }
  if (dead.length > 0) {
    try {
      summary.dropped = await rpc<number>(env, 'notify_drop_device_tokens', { p_tokens: dead });
    } catch (err) {
      console.error(`dead tokens not dropped (${dead.length}): ${err}`);
    }
  }
  return summary;
}

// Only the service role key (the one the trigger reads from Vault) may call it.
export async function handle(req: Request, env: Env, now = new Date()): Promise<Response> {
  if (!env.supabaseUrl || !env.serviceKey) {
    return Response.json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 500 });
  }
  if (req.headers.get('Authorization') !== `Bearer ${env.serviceKey}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  let eventId: unknown;
  try {
    eventId = (await req.json())?.event_id;
  } catch {
    eventId = undefined;
  }
  if (typeof eventId !== 'number' || !Number.isInteger(eventId) || eventId < 1) {
    return Response.json({ error: 'event_id required' }, { status: 400 });
  }
  try {
    const summary = await run(env, eventId, now);
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (err) {
    console.error(String(err));
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
