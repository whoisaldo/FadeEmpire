// deno test supabase/functions/send-reminders/
// fetch is stubbed: a fake PostgREST holds the due rows and the claims, a
// fake Twilio answers with a configurable status and body, or throws.

import { assertEquals } from 'jsr:@std/assert@1';
import {
  type Env,
  formatDate,
  formatTime,
  handle,
  PERMANENT_ERRORS,
  QUIET_END_HOUR,
  QUIET_START_HOUR,
  readEnv,
  type RebookRow,
  rebookText,
  type ReminderRow,
  reminderText,
  run,
  toE164,
} from './reminders.ts';

const SITE = 'https://chicopeefadeempire.com';
const SUPABASE_URL = 'http://db.test';
const KEY = 'service-key';
// 12:00 in America/New_York (EDT): outside quiet hours.
const NOON = new Date('2026-10-20T16:00:00Z');

const twilioEnv = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: KEY,
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_FROM: '+14135550000',
};
const envFrom = (vars: Record<string, string>): Env => readEnv((name) => vars[name]);
const dryEnv = envFrom({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY });
const liveEnv = envFrom(twilioEnv);

const reminderRow = (): ReminderRow => ({
  phone: '4135551234',
  appointment_date: '2026-10-21',
  booking_ids: ['b1'],
  people: [{ id: 'b1', name: 'Ali', time: '10:00', barber: 'Hassan' }],
});
const rebookRow = (): RebookRow => ({
  phone: '4135559876',
  barber_name: 'Larry',
  last_visit: '2026-09-28',
  booking_ids: ['b9'],
});

type Fake = {
  reminders: ReminderRow[];
  rebooks: RebookRow[];
  twilioStatus: number;
  twilioBody?: unknown;
  twilioThrows?: boolean;
  twilioDelayMs?: number;
  markStatus?: number;
  sms: URLSearchParams[];
  rpcs: string[];
  claims: Set<string>; // 'kind:id' held by some run
  marks: { p_booking_ids: string[]; p_kind: string; p_error?: string }[];
};

// Installs the stub and returns its state; marking a row removes it from the
// due lists, like the real sent_at columns do. claim_reminders returns the ids
// not already in `claims` and adds them, like the real claim column.
function stubFetch(fake: Partial<Fake> = {}): Fake & { restore: () => void } {
  const state: Fake = {
    reminders: [],
    rebooks: [],
    twilioStatus: 201,
    sms: [],
    rpcs: [],
    claims: new Set(),
    marks: [],
    ...fake,
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.twilio.com/')) {
      state.sms.push(new URLSearchParams(String(init?.body)));
      if (state.twilioDelayMs) await new Promise((r) => setTimeout(r, state.twilioDelayMs));
      if (state.twilioThrows) throw new TypeError('network down');
      const body = state.twilioBody ?? { status: state.twilioStatus };
      return new Response(JSON.stringify(body), { status: state.twilioStatus });
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) state.rpcs.push(url.split('/').pop()!);
    if (url === `${SUPABASE_URL}/rest/v1/rpc/reminders_due`) return Response.json(state.reminders);
    if (url === `${SUPABASE_URL}/rest/v1/rpc/rebook_due`) return Response.json(state.rebooks);
    if (url === `${SUPABASE_URL}/rest/v1/rpc/claim_reminders`) {
      const args = JSON.parse(String(init?.body));
      const free = (args.p_booking_ids as string[]).filter((id) => !state.claims.has(`${args.p_kind}:${id}`));
      free.forEach((id) => state.claims.add(`${args.p_kind}:${id}`));
      return Response.json(free);
    }
    if (url === `${SUPABASE_URL}/rest/v1/rpc/mark_reminder_sent`) {
      if (state.markStatus) return new Response('mark failed', { status: state.markStatus });
      const args = JSON.parse(String(init?.body));
      state.marks.push(args);
      const sent = (ids: string[]) => ids.some((id) => args.p_booking_ids.includes(id));
      if (args.p_kind === 'reminder') state.reminders = state.reminders.filter((r) => !sent(r.booking_ids));
      if (args.p_kind === 'rebook') state.rebooks = state.rebooks.filter((r) => !sent(r.booking_ids));
      return Response.json(args.p_booking_ids.length);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return Object.assign(state, { restore: () => (globalThis.fetch = original) });
}

const quiet = () => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  return () => Object.assign(console, { log, error });
};

// ---------- Text ----------

Deno.test('reminder text, one person', () => {
  assertEquals(
    reminderText(reminderRow(), SITE),
    'Fade Empire: your appointment is tomorrow, Wed Oct 21 at 10:00 AM with Hassan. ' +
      '1193 Memorial Dr, Chicopee. To cancel: https://chicopeefadeempire.com/#cancel',
  );
});

Deno.test('reminder text, group with one barber', () => {
  const row = reminderRow();
  row.people = [
    { id: 'b1', name: 'Ali', time: '10:00', barber: 'Hassan' },
    { id: 'b2', name: 'Sam', time: '10:45', barber: 'Hassan' },
  ];
  assertEquals(
    reminderText(row, SITE),
    'Fade Empire: your appointments are tomorrow, Wed Oct 21: Ali 10:00 AM, Sam 10:45 AM with Hassan. ' +
      '1193 Memorial Dr, Chicopee. To cancel: https://chicopeefadeempire.com/#cancel',
  );
});

Deno.test('reminder text, group across both barbers names each', () => {
  const row = reminderRow();
  row.people = [
    { id: 'b1', name: 'Ali', time: '13:00', barber: 'Hassan' },
    { id: 'b2', name: 'Sam', time: '13:00', barber: 'Larry' },
  ];
  assertEquals(
    reminderText(row, SITE),
    'Fade Empire: your appointments are tomorrow, Wed Oct 21: Ali 1:00 PM with Hassan, Sam 1:00 PM with Larry. ' +
      '1193 Memorial Dr, Chicopee. To cancel: https://chicopeefadeempire.com/#cancel',
  );
});

Deno.test('rebook text', () => {
  assertEquals(
    rebookText(rebookRow(), SITE),
    "Fade Empire: it's been 3 weeks since your last cut with Larry. " +
      'Book your next one: https://chicopeefadeempire.com/#book. Reply STOP to stop.',
  );
});

Deno.test('date, time and phone formatting', () => {
  assertEquals(formatDate('2026-11-01'), 'Sun Nov 1');
  assertEquals(formatTime('12:15'), '12:15 PM');
  assertEquals(formatTime('17:30:00'), '5:30 PM');
  assertEquals(toE164('4135551234'), '+14135551234');
  assertEquals(toE164('14135551234'), '+14135551234');
  assertEquals(toE164('442071234567'), '+442071234567');
});

Deno.test('SITE_URL defaults and loses a trailing slash', () => {
  assertEquals(dryEnv.siteUrl, SITE);
  assertEquals(envFrom({ SITE_URL: 'https://example.test/' }).siteUrl, 'https://example.test');
});

Deno.test('Twilio needs SID, token, and a sender', () => {
  assertEquals(envFrom({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }).twilio, null);
  assertEquals(
    envFrom({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG1' })
      .twilio?.messagingServiceSid,
    'MG1',
  );
});

// ---------- Runs ----------

Deno.test('dry run sends nothing and marks nothing', async () => {
  const fake = stubFetch({ reminders: [reminderRow()], rebooks: [rebookRow()] });
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const summary = await run(dryEnv);
    assertEquals(summary, {
      dry_run: true,
      reminders: { due: 1, sent: 0, failed: 0, rejected: 0, skipped: 0 },
      rebooks: { due: 1, sent: 0, failed: 0, rejected: 0, skipped: 0 },
    });
    assertEquals(fake.sms.length, 0);
    assertEquals(fake.marks.length, 0);
    assertEquals(fake.rpcs.filter((r) => r === 'claim_reminders').length, 0);
    assertEquals(lines.length, 2);
    assertEquals(lines[0], `[dry-run] reminder to +1******1234: ${reminderText(reminderRow(), SITE)}`);
  } finally {
    console.log = log;
    fake.restore();
  }
});

Deno.test('Twilio 2xx sends E.164 and marks the rows sent', async () => {
  const group = reminderRow();
  group.booking_ids = ['b1', 'b2'];
  group.people.push({ id: 'b2', name: 'Sam', time: '10:45', barber: 'Hassan' });
  const fake = stubFetch({ reminders: [group], rebooks: [rebookRow()] });
  try {
    const summary = await run(liveEnv);
    assertEquals(summary, {
      dry_run: false,
      reminders: { due: 1, sent: 1, failed: 0, rejected: 0, skipped: 0 },
      rebooks: { due: 1, sent: 1, failed: 0, rejected: 0, skipped: 0 },
    });
    assertEquals(fake.sms.map((f) => f.get('To')), ['+14135551234', '+14135559876']);
    assertEquals(fake.sms[0].get('From'), '+14135550000');
    assertEquals(fake.sms[0].get('Body'), reminderText(group, SITE));
    assertEquals(fake.marks, [
      { p_booking_ids: ['b1', 'b2'], p_kind: 'reminder' },
      { p_booking_ids: ['b9'], p_kind: 'rebook' },
    ]);
  } finally {
    fake.restore();
  }
});

const twilioError = (code: number, message: string) => ({ code, message, status: 400 });

Deno.test('the permanent error list', () => {
  assertEquals([...PERMANENT_ERRORS].sort(), [21211, 21408, 21610, 21614]);
});

Deno.test('a permanent Twilio 4xx marks the row and records the code', async () => {
  for (const code of PERMANENT_ERRORS) {
    const fake = stubFetch({
      reminders: [reminderRow()],
      rebooks: [rebookRow()],
      twilioStatus: 400,
      twilioBody: twilioError(code, 'Rejected'),
    });
    const restoreConsole = quiet();
    try {
      const summary = await run(liveEnv);
      assertEquals(summary.reminders, { due: 1, sent: 0, failed: 0, rejected: 1, skipped: 0 });
      assertEquals(summary.rebooks, { due: 1, sent: 0, failed: 0, rejected: 1, skipped: 0 });
      assertEquals(fake.marks, [
        { p_booking_ids: ['b1'], p_kind: 'reminder', p_error: `${code}: Rejected` },
        { p_booking_ids: ['b9'], p_kind: 'rebook', p_error: `${code}: Rejected` },
      ]);
      assertEquals(fake.reminders.length, 0);
      assertEquals(fake.rebooks.length, 0);
    } finally {
      restoreConsole();
      fake.restore();
    }
  }
});

Deno.test('transient failures leave the row unmarked', async () => {
  const cases: Partial<Fake>[] = [
    { twilioStatus: 500 },
    { twilioStatus: 503 },
    { twilioStatus: 429, twilioBody: { code: 20429, message: 'Too Many Requests', status: 429 } },
    { twilioStatus: 401, twilioBody: { code: 20003, message: 'Authenticate', status: 401 } },
    { twilioStatus: 400, twilioBody: { status: 400 } },
    { twilioStatus: 500, twilioBody: { code: 21610, message: 'not a 4xx', status: 500 } },
    { twilioThrows: true },
  ];
  for (const c of cases) {
    const fake = stubFetch({ reminders: [reminderRow()], ...c });
    const restoreConsole = quiet();
    try {
      const summary = await run(liveEnv);
      assertEquals(summary.reminders, { due: 1, sent: 0, failed: 1, rejected: 0, skipped: 0 }, JSON.stringify(c));
      assertEquals(fake.sms.length, 1);
      assertEquals(fake.marks.length, 0);
      assertEquals(fake.reminders.length, 1);
    } finally {
      restoreConsole();
      fake.restore();
    }
  }
});

Deno.test('a second run after a permanent error sends nothing for that row', async () => {
  const fake = stubFetch({
    reminders: [reminderRow()],
    twilioStatus: 400,
    twilioBody: twilioError(21610, 'Attempt to send to unsubscribed recipient'),
  });
  const restoreConsole = quiet();
  try {
    await run(liveEnv);
    assertEquals(fake.sms.length, 1);
    const second = await run(liveEnv);
    assertEquals(second.reminders, { due: 0, sent: 0, failed: 0, rejected: 0, skipped: 0 });
    assertEquals(fake.sms.length, 1);
    assertEquals(fake.marks.length, 1);
  } finally {
    restoreConsole();
    fake.restore();
  }
});

Deno.test('second run is a no-op', async () => {
  const fake = stubFetch({ reminders: [reminderRow()], rebooks: [rebookRow()] });
  try {
    await run(liveEnv);
    assertEquals(fake.sms.length, 2);
    const second = await run(liveEnv);
    assertEquals(second, {
      dry_run: false,
      reminders: { due: 0, sent: 0, failed: 0, rejected: 0, skipped: 0 },
      rebooks: { due: 0, sent: 0, failed: 0, rejected: 0, skipped: 0 },
    });
    assertEquals(fake.sms.length, 2);
    assertEquals(fake.marks.length, 2);
  } finally {
    fake.restore();
  }
});

Deno.test('messaging service SID is used as the sender when set', async () => {
  const fake = stubFetch({ rebooks: [rebookRow()] });
  try {
    await run(envFrom({ ...twilioEnv, TWILIO_FROM: '', TWILIO_MESSAGING_SERVICE_SID: 'MG1' }));
    assertEquals(fake.sms[0].get('MessagingServiceSid'), 'MG1');
    assertEquals(fake.sms[0].get('From'), null);
  } finally {
    fake.restore();
  }
});

// ---------- HTTP handler ----------

Deno.test('handler rejects a request without the service role key', async () => {
  const fake = stubFetch({ reminders: [reminderRow()] });
  try {
    const res = await handle(
      new Request('http://fn.test', { method: 'POST', headers: { Authorization: 'Bearer anon-key' } }),
      liveEnv,
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
    assertEquals(fake.sms.length, 0);
  } finally {
    fake.restore();
  }
});

Deno.test('handler returns the JSON summary', async () => {
  const fake = stubFetch({ reminders: [reminderRow()] });
  const restoreConsole = quiet();
  try {
    const res = await handle(
      new Request('http://fn.test', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }),
      dryEnv,
      NOON,
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      dry_run: true,
      reminders: { due: 1, sent: 0, failed: 0, rejected: 0, skipped: 0 },
      rebooks: { due: 0, sent: 0, failed: 0, rejected: 0, skipped: 0 },
    });
  } finally {
    restoreConsole();
    fake.restore();
  }
});

Deno.test('handler returns 500 when a due query fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response('boom', { status: 503 }));
  const restoreConsole = quiet();
  try {
    const res = await handle(
      new Request('http://fn.test', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }),
      liveEnv,
      NOON,
    );
    assertEquals(res.status, 500);
    await res.body?.cancel();
  } finally {
    restoreConsole();
    globalThis.fetch = original;
  }
});

// ---------- Quiet hours ----------

const post = () => new Request('http://fn.test', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });

// Calls the handler at `at` with one due reminder; returns what happened.
async function handleAt(env: Env, at: string) {
  const fake = stubFetch({ reminders: [reminderRow()] });
  const restoreConsole = quiet();
  try {
    const res = await handle(post(), env, new Date(at));
    return {
      status: res.status,
      body: await res.json(),
      sms: fake.sms.length,
      marks: fake.marks.length,
      rpcs: fake.rpcs,
    };
  } finally {
    restoreConsole();
    fake.restore();
  }
}

Deno.test('quiet hours default to 20:00-09:00', () => {
  assertEquals([QUIET_START_HOUR, QUIET_END_HOUR], [20, 9]);
  assertEquals([liveEnv.quietStartHour, liveEnv.quietEndHour], [20, 9]);
});

Deno.test('quiet hours: both sides of 09:00 and 20:00 in America/New_York', async () => {
  const cases: [string, string, boolean][] = [
    // [instant, shop time, sends]
    ['2026-10-20T12:59:00Z', '08:59 EDT', false],
    ['2026-10-20T13:00:00Z', '09:00 EDT', true],
    ['2026-10-20T23:59:00Z', '19:59 EDT', true],
    ['2026-10-21T00:00:00Z', '20:00 EDT', false],
    ['2026-12-15T13:59:00Z', '08:59 EST', false],
    ['2026-12-15T14:00:00Z', '09:00 EST', true],
    ['2026-12-16T00:59:00Z', '19:59 EST', true],
    ['2026-12-16T01:00:00Z', '20:00 EST', false],
  ];
  for (const [at, label, sends] of cases) {
    const r = await handleAt(liveEnv, at);
    assertEquals(r.status, 200, label);
    if (sends) {
      assertEquals([r.sms, r.marks], [1, 1], label);
      assertEquals(r.body.reminders, { due: 1, sent: 1, failed: 0, rejected: 0, skipped: 0 }, label);
    } else {
      assertEquals([r.sms, r.marks, r.rpcs.length], [0, 0, 0], label);
      assertEquals(r.body, {
        dry_run: false,
        skipped: `quiet hours: ${label.slice(0, 5)} in America/New_York; texts go out 09:00-20:00`,
      }, label);
    }
  }
});

Deno.test('QUIET_START_HOUR and QUIET_END_HOUR override the bounds', async () => {
  const env = envFrom({ ...twilioEnv, QUIET_START_HOUR: '22', QUIET_END_HOUR: '7' });
  const cases: [string, string, boolean][] = [
    ['2026-10-20T10:59:00Z', '06:59 EDT', false],
    ['2026-10-20T11:00:00Z', '07:00 EDT', true],
    ['2026-10-21T01:59:00Z', '21:59 EDT', true],
    ['2026-10-21T02:00:00Z', '22:00 EDT', false],
  ];
  for (const [at, label, sends] of cases) {
    const r = await handleAt(env, at);
    assertEquals(r.sms, sends ? 1 : 0, label);
    if (!sends) {
      assertEquals(r.body.skipped, `quiet hours: ${label.slice(0, 5)} in America/New_York; texts go out 07:00-22:00`);
    }
  }
});

Deno.test('an invalid quiet hour falls back to the default', () => {
  const env = envFrom({ QUIET_START_HOUR: '24', QUIET_END_HOUR: 'nine' });
  assertEquals([env.quietStartHour, env.quietEndHour], [20, 9]);
});

// ---------- Claims ----------

Deno.test('two concurrent runs send each row once; the second claims nothing', async () => {
  const fake = stubFetch({ reminders: [reminderRow()], rebooks: [rebookRow()], twilioDelayMs: 20 });
  try {
    const [a, b] = await Promise.all([run(liveEnv), run(liveEnv)]);
    assertEquals(fake.sms.map((f) => f.get('To')).sort(), ['+14135551234', '+14135559876']);
    assertEquals(fake.marks.length, 2);
    for (const kind of ['reminders', 'rebooks'] as const) {
      assertEquals([a[kind].due, b[kind].due], [1, 1], kind);
      assertEquals(a[kind].sent + b[kind].sent, 1, kind);
      assertEquals(a[kind].skipped + b[kind].skipped, 1, kind);
    }
  } finally {
    fake.restore();
  }
});

Deno.test('rows claimed by another run are skipped: no send, no mark', async () => {
  const fake = stubFetch({
    reminders: [reminderRow()],
    rebooks: [rebookRow()],
    claims: new Set(['reminder:b1', 'rebook:b9']),
  });
  try {
    const summary = await run(liveEnv);
    assertEquals(summary.reminders, { due: 1, sent: 0, failed: 0, rejected: 0, skipped: 1 });
    assertEquals(summary.rebooks, { due: 1, sent: 0, failed: 0, rejected: 0, skipped: 1 });
    assertEquals(fake.sms.length, 0);
    assertEquals(fake.marks.length, 0);
  } finally {
    fake.restore();
  }
});

Deno.test('a group with one person claimed elsewhere texts and marks only the rest', async () => {
  const group = reminderRow();
  group.booking_ids = ['b1', 'b2'];
  group.people.push({ id: 'b2', name: 'Sam', time: '10:45', barber: 'Hassan' });
  const fake = stubFetch({ reminders: [group], claims: new Set(['reminder:b2']) });
  try {
    const summary = await run(liveEnv);
    assertEquals(summary.reminders.sent, 1);
    assertEquals(fake.sms[0].get('Body'), reminderText(reminderRow(), SITE));
    assertEquals(fake.marks, [{ p_booking_ids: ['b1'], p_kind: 'reminder' }]);
  } finally {
    fake.restore();
  }
});

Deno.test('a 2xx followed by a failed mark is logged at error level with the booking ids', async () => {
  const group = reminderRow();
  group.booking_ids = ['b1', 'b2'];
  group.people.push({ id: 'b2', name: 'Sam', time: '10:45', barber: 'Hassan' });
  const fake = stubFetch({ reminders: [group], markStatus: 500 });
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    const summary = await run(liveEnv);
    assertEquals(summary.reminders.sent, 1);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].startsWith('reminder to +1******1234 sent but not marked, booking ids b1, b2: '), true);
  } finally {
    console.error = error;
    fake.restore();
  }
});
