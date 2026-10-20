// send-reminders logic: reads the due rows from Postgres, claims each one
// (claim_reminders) so an overlapping run cannot send it too, texts it
// through Twilio, and marks a row sent only after Twilio returns 2xx or
// rejects the number for good (PERMANENT_ERRORS). Without Twilio credentials
// it runs dry: logs each message, marks nothing. During quiet hours it does
// nothing at all.

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
  quietStartHour: number;
  quietEndHour: number;
};

export type ReminderRow = {
  phone: string;
  appointment_date: string; // 'YYYY-MM-DD', shop-local
  booking_ids: string[];
  people: { id: string; name: string; time: string; barber: string }[]; // time 'HH:MM', shop-local
};

export type RebookRow = {
  phone: string;
  barber_name: string;
  last_visit: string;
  booking_ids: string[];
};

// failed: retried next run. rejected: marked with the error, never retried.
// skipped: claimed by another run, which sends it.
type Counts = { due: number; sent: number; failed: number; rejected: number; skipped: number };
export type Summary = { dry_run: boolean; reminders: Counts; rebooks: Counts };

const DEFAULT_SITE_URL = 'https://chicopeefadeempire.com';
// No texts from QUIET_START_HOUR until QUIET_END_HOUR, shop time. The hourly
// schedule keeps running; the due windows absorb the wait (a 10:00 AM
// appointment's 23-25 hour window is 09:00-11:00 the day before).
const SHOP_TZ = 'America/New_York';
export const QUIET_START_HOUR = 20;
export const QUIET_END_HOUR = 9;
const ADDRESS = '1193 Memorial Dr, Chicopee';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Twilio error codes, returned with a 4xx by the send request, that mean this
// number will not take a text from us. The row is marked so the hourly run
// stops retrying it, and the code and message go to bookings.sms_last_error.
//   21211  the 'To' number is invalid
//   21408  the account has no permission to send to the number's region
//   21610  the recipient replied STOP
//   21614  the 'To' number is not a mobile number
// 30006 (landline or unreachable carrier) and 30007 (carrier filtering) are
// not listed: Twilio reports them in delivery status callbacks after it has
// accepted the message, never in the send response this function reads.
// Every other failure (5xx, 429, other 4xx such as bad credentials, network
// errors) leaves the row unmarked for the next run.
export const PERMANENT_ERRORS = new Set([21211, 21408, 21610, 21614]);

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
    quietStartHour: hourFrom(get('QUIET_START_HOUR'), QUIET_START_HOUR),
    quietEndHour: hourFrom(get('QUIET_END_HOUR'), QUIET_END_HOUR),
  };
}

// An hour 0-23 from the environment, or the fallback when unset or invalid.
function hourFrom(raw: string | undefined, fallback: number): number {
  const s = raw?.trim() ?? '';
  return /^\d{1,2}$/.test(s) && Number(s) <= 23 ? Number(s) : fallback;
}

// The reason to send nothing at `now`, or null when texts may go out.
export function quietHours(env: Env, now: Date): string | null {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const hour = Number(clock.slice(0, 2));
  const start = env.quietStartHour;
  const end = env.quietEndHour;
  const quiet = start > end ? hour >= start || hour < end : hour >= start && hour < end;
  if (!quiet) return null;
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return `quiet hours: ${clock} in ${SHOP_TZ}; texts go out ${hh(end)}-${hh(start)}`;
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

// 'CODE: message' when a Twilio error response is permanent, else null.
function permanentError(status: number, body: string): string | null {
  if (status < 400 || status >= 500) return null;
  let err: { code?: unknown; message?: unknown };
  try {
    err = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof err?.code !== 'number' || !PERMANENT_ERRORS.has(err.code)) return null;
  return `${err.code}: ${err.message ?? ''}`;
}

// body(ids) builds the text for the booking ids this run claimed.
type Message = { phone: string; ids: string[]; body: (ids: string[]) => string };

async function deliver(env: Env, kind: 'reminder' | 'rebook', messages: Message[]): Promise<Counts> {
  const counts: Counts = { due: messages.length, sent: 0, failed: 0, rejected: 0, skipped: 0 };
  for (const m of messages) {
    const to = toE164(m.phone);
    if (!env.twilio) {
      console.log(`[dry-run] ${kind} to ${maskPhone(to)}: ${m.body(m.ids)}`);
      continue;
    }
    let ids: string[];
    try {
      ids = await rpc<string[]>(env, 'claim_reminders', { p_kind: kind, p_booking_ids: m.ids });
    } catch (err) {
      counts.failed++;
      console.error(`${kind} to ${maskPhone(to)} not claimed: ${err}`);
      continue;
    }
    if (ids.length === 0) {
      counts.skipped++;
      continue;
    }
    const mark = async (outcome: string, error?: string) => {
      try {
        await rpc<number>(env, 'mark_reminder_sent', {
          p_booking_ids: ids,
          p_kind: kind,
          ...(error ? { p_error: error } : {}),
        });
      } catch (err) {
        console.error(`${kind} to ${maskPhone(to)} ${outcome} but not marked, booking ids ${ids.join(', ')}: ${err}`);
      }
    };
    let res: Response;
    try {
      res = await sendSms(env.twilio, to, m.body(ids));
    } catch (err) {
      counts.failed++;
      console.error(`${kind} to ${maskPhone(to)} failed: ${err}`);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      const error = permanentError(res.status, body);
      if (error) {
        counts.rejected++;
        console.error(`${kind} to ${maskPhone(to)} rejected, not retrying: ${error}`);
        await mark('rejected', error);
      } else {
        counts.failed++;
        console.error(`${kind} to ${maskPhone(to)} failed: Twilio ${res.status} ${body}`);
      }
      continue;
    }
    await res.body?.cancel();
    counts.sent++;
    await mark('sent');
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
      body: (ids) => reminderText({ ...r, people: r.people.filter((p) => ids.includes(p.id)) }, env.siteUrl),
    }))),
    rebooks: await deliver(env, 'rebook', rebooks.map((r) => ({
      phone: r.phone,
      ids: r.booking_ids,
      body: () => rebookText(r, env.siteUrl),
    }))),
  };
}

// Only the service role key may trigger a run. Quiet hours skip it before any
// query, so nothing is sent or marked.
export async function handle(req: Request, env: Env, now = new Date()): Promise<Response> {
  if (!env.supabaseUrl || !env.serviceKey) {
    return Response.json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 500 });
  }
  if (req.headers.get('Authorization') !== `Bearer ${env.serviceKey}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const skipped = quietHours(env, now);
  if (skipped) {
    const summary = { dry_run: env.twilio === null, skipped };
    console.log(JSON.stringify(summary));
    return Response.json(summary);
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
