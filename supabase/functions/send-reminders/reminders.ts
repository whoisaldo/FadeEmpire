// send-reminders logic: reads the due rows from Postgres, texts each one
// through Twilio, and marks a row sent only after Twilio returns 2xx.
// Without Twilio credentials it runs dry: logs each message, marks nothing.

export type Twilio = {
  accountSid: string;
  authToken: string;
  from?: string;
  messagingServiceSid?: string;
};

export type Env = {
  supabaseUrl: string;
  serviceKey: string;
  siteUrl: string;
  twilio: Twilio | null;
};

export type ReminderRow = {
  phone: string;
  appointment_date: string; // 'YYYY-MM-DD', shop-local
  booking_ids: string[];
  people: { name: string; time: string; barber: string }[]; // time 'HH:MM', shop-local
};

export type RebookRow = {
  phone: string;
  barber_name: string;
  last_visit: string;
  booking_ids: string[];
};

type Counts = { due: number; sent: number; failed: number };
export type Summary = { dry_run: boolean; reminders: Counts; rebooks: Counts };

const DEFAULT_SITE_URL = 'https://chicopeefadeempire.com';
const ADDRESS = '1193 Memorial Dr, Chicopee';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function readEnv(get: (name: string) => string | undefined): Env {
  const accountSid = get('TWILIO_ACCOUNT_SID');
  const authToken = get('TWILIO_AUTH_TOKEN');
  const from = get('TWILIO_FROM');
  const messagingServiceSid = get('TWILIO_MESSAGING_SERVICE_SID');
  const configured = accountSid && authToken && (from || messagingServiceSid);
  return {
    supabaseUrl: (get('SUPABASE_URL') ?? '').replace(/\/+$/, ''),
    serviceKey: get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    siteUrl: (get('SITE_URL') || DEFAULT_SITE_URL).replace(/\/+$/, ''),
    twilio: configured ? { accountSid, authToken, from, messagingServiceSid } : null,
  };
}

// Stored phones are digits only: 10 digits (US), or 11-15 with a country code.
export function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

// '2026-10-21' -> 'Wed Oct 21'
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${MONTHS[m - 1]} ${d}`;
}

// '10:00' or '10:00:00' -> '10:00 AM'; '13:45' -> '1:45 PM'
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function reminderText(row: ReminderRow, siteUrl: string): string {
  const date = formatDate(row.appointment_date);
  const tail = `${ADDRESS}. To cancel: ${siteUrl}/#cancel`;
  if (row.people.length === 1) {
    const p = row.people[0];
    return `Fade Empire: your appointment is tomorrow, ${date} at ${formatTime(p.time)} with ${p.barber}. ${tail}`;
  }
  const oneBarber = row.people.every((p) => p.barber === row.people[0].barber);
  const list = row.people
    .map((p) => `${p.name} ${formatTime(p.time)}` + (oneBarber ? '' : ` with ${p.barber}`))
    .join(', ');
  const barber = oneBarber ? ` with ${row.people[0].barber}` : '';
  return `Fade Empire: your appointments are tomorrow, ${date}: ${list}${barber}. ${tail}`;
}

export function rebookText(row: RebookRow, siteUrl: string): string {
  return `Fade Empire: it's been 3 weeks since your last cut with ${row.barber_name}. ` +
    `Book your next one: ${siteUrl}/#book. Reply STOP to stop.`;
}

function maskPhone(e164: string): string {
  return e164.slice(0, 2) + '*'.repeat(Math.max(0, e164.length - 6)) + e164.slice(-4);
}

async function rpc<T>(env: Env, name: string, args: Record<string, unknown> = {}): Promise<T> {
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

async function sendSms(twilio: Twilio, to: string, body: string): Promise<Response> {
  const form = new URLSearchParams({ To: to, Body: body });
  if (twilio.messagingServiceSid) form.set('MessagingServiceSid', twilio.messagingServiceSid);
  else form.set('From', twilio.from!);
  return await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${twilio.accountSid}:${twilio.authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    },
  );
}

async function deliver(
  env: Env,
  kind: 'reminder' | 'rebook',
  messages: { phone: string; ids: string[]; body: string }[],
): Promise<Counts> {
  const counts: Counts = { due: messages.length, sent: 0, failed: 0 };
  for (const m of messages) {
    const to = toE164(m.phone);
    if (!env.twilio) {
      console.log(`[dry-run] ${kind} to ${maskPhone(to)}: ${m.body}`);
      continue;
    }
    let res: Response;
    try {
      res = await sendSms(env.twilio, to, m.body);
    } catch (err) {
      counts.failed++;
      console.error(`${kind} to ${maskPhone(to)} failed: ${err}`);
      continue;
    }
    if (!res.ok) {
      counts.failed++;
      console.error(`${kind} to ${maskPhone(to)} failed: Twilio ${res.status} ${await res.text()}`);
      continue;
    }
    await res.body?.cancel();
    counts.sent++;
    try {
      await rpc<number>(env, 'mark_reminder_sent', { p_booking_ids: m.ids, p_kind: kind });
    } catch (err) {
      console.error(`${kind} to ${maskPhone(to)} sent but not marked: ${err}`);
    }
  }
  return counts;
}

export async function run(env: Env): Promise<Summary> {
  const reminders = await rpc<ReminderRow[]>(env, 'reminders_due');
  const rebooks = await rpc<RebookRow[]>(env, 'rebook_due');
  return {
    dry_run: env.twilio === null,
    reminders: await deliver(env, 'reminder', reminders.map((r) => ({
      phone: r.phone,
      ids: r.booking_ids,
      body: reminderText(r, env.siteUrl),
    }))),
    rebooks: await deliver(env, 'rebook', rebooks.map((r) => ({
      phone: r.phone,
      ids: r.booking_ids,
      body: rebookText(r, env.siteUrl),
    }))),
  };
}

// Only the service role key may trigger a run.
export async function handle(req: Request, env: Env): Promise<Response> {
  if (!env.supabaseUrl || !env.serviceKey) {
    return Response.json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 500 });
  }
  if (req.headers.get('Authorization') !== `Bearer ${env.serviceKey}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const summary = await run(env);
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (err) {
    console.error(String(err));
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
