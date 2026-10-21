// The RPC wrappers against a stubbed PostgREST client: a failed availability
// read has to surface as a failure, never as "nothing is booked".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let result;
let calls;          // every query-builder call since the last from(): [[method, ...args]]
vi.mock('../scripts/supabase.js', () => {
  const query = {};
  for (const method of ['select', 'gte', 'lte', 'eq', 'order']) {
    query[method] = (...args) => { calls.push([method, ...args]); return query; };
  }
  query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return { sb: { from: (table) => { calls = [['from', table]]; return query; }, rpc: vi.fn() } };
});

const { fetchAvailability, fetchNextAvailable, fetchBarbers, bookSlot, bookSlotGroup, BookingError } = await import('../scripts/booking-rpc.js');
const { sb } = await import('../scripts/supabase.js');
const { ROSTER_SELECT, setRoster, resetRoster, safePhotoUrl } = await import('../scripts/roster.js');
const { SUPABASE_URL } = await import('../scripts/config.js');
const BUCKET = `${SUPABASE_URL}/storage/v1/object/public/barber-photos/`;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('rate limiting (R5)', () => {
  it('a 429 from PostgREST reaches the form as rate_limited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sb.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Too Many Requests', code: '' }, status: 429 });
    await expect(bookSlot({ serviceSlug: 'hair-cut', date: '2026-07-08', time: '11:30:00', name: 'A', phone: '4135550123' }))
      .rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('availability reads (P2)', () => {
  it('a failed read throws instead of returning an empty list', async () => {
    result = { data: null, error: { name: 'TypeError', message: 'TypeError: Failed to fetch' } };
    await expect(fetchAvailability({ fromDate: '2026-07-06', toDate: '2026-07-20' }))
      .rejects.toBeInstanceOf(BookingError);
    await expect(fetchNextAvailable()).rejects.toBeInstanceOf(BookingError);
  });

  it('a successful empty read is an empty list', async () => {
    result = { data: [], error: null };
    await expect(fetchAvailability({ fromDate: '2026-07-06', toDate: '2026-07-20' })).resolves.toEqual([]);
  });
});

describe('text consent (C3)', () => {
  const single = { serviceSlug: 'hair-cut', date: '2026-07-08', time: '11:30:00', name: 'A Customer', phone: '4135550123' };

  it('book_slot carries p_remind_sms and p_rebook_sms in all four combinations', async () => {
    for (const remindSms of [true, false]) {
      for (const rebookSms of [true, false]) {
        sb.rpc.mockResolvedValueOnce({ data: [], error: null });
        await bookSlot({ ...single, remindSms, rebookSms });
        const [name, args] = sb.rpc.mock.calls.at(-1);
        expect(name).toBe('book_slot');
        expect(args).toMatchObject({ p_remind_sms: remindSms, p_rebook_sms: rebookSms });
      }
    }
  });

  it('defaults to the DB defaults: reminder on, next-cut texts off', async () => {
    sb.rpc.mockResolvedValueOnce({ data: [], error: null });
    await bookSlot(single);
    expect(sb.rpc.mock.calls.at(-1)[1]).toMatchObject({ p_remind_sms: true, p_rebook_sms: false });
  });

  it('book_slot_group carries both flags', async () => {
    for (const [remindSms, rebookSms] of [[true, true], [false, false], [false, true], [true, false]]) {
      sb.rpc.mockResolvedValueOnce({ data: [], error: null });
      await bookSlotGroup({
        date: '2026-07-08', startTime: '11:30:00', phone: '4135550123', remindSms, rebookSms,
        people: [{ name: 'A Customer', serviceSlug: 'hair-cut' }, { name: 'Kid', serviceSlug: 'kids-cut' }],
      });
      const [name, args] = sb.rpc.mock.calls.at(-1);
      expect(name).toBe('book_slot_group');
      expect(args).toMatchObject({ p_remind_sms: remindSms, p_rebook_sms: rebookSms });
    }
  });
});

describe('a database before migration 0020 (C3)', () => {
  const single = { serviceSlug: 'hair-cut', date: '2026-07-08', time: '11:30:00', name: 'A Customer', phone: '4135550123' };
  const noSignature = {
    data: null, status: 404,
    error: { code: 'PGRST202', message: 'Could not find the function public.book_slot(...) in the schema cache' },
  };

  it('book_slot without the consent flags is retried once without them, with a warning', async () => {
    sb.rpc.mockClear();
    sb.rpc.mockResolvedValueOnce(noSignature).mockResolvedValueOnce({ data: [{ booking_id: 'b1' }], error: null });
    await expect(bookSlot({ ...single, remindSms: false, rebookSms: true })).resolves.toEqual([{ booking_id: 'b1' }]);
    expect(sb.rpc).toHaveBeenCalledTimes(2);
    const [[, first], [name, retry]] = sb.rpc.mock.calls;
    expect(first).toMatchObject({ p_remind_sms: false, p_rebook_sms: true });
    expect(name).toBe('book_slot');
    expect(retry).not.toHaveProperty('p_remind_sms');
    expect(retry).not.toHaveProperty('p_rebook_sms');
    expect(retry).toEqual(Object.fromEntries(Object.entries(first).filter(([k]) => !/^p_(remind|rebook)_sms$/.test(k))));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('migration 0020'));
  });

  it('book_slot_group is retried the same way', async () => {
    sb.rpc.mockClear();
    sb.rpc.mockResolvedValueOnce(noSignature).mockResolvedValueOnce({ data: [], error: null });
    await bookSlotGroup({
      date: '2026-07-08', startTime: '11:30:00', phone: '4135550123',
      people: [{ name: 'A Customer', serviceSlug: 'hair-cut' }, { name: 'Kid', serviceSlug: 'kids-cut' }],
    });
    expect(sb.rpc).toHaveBeenCalledTimes(2);
    const [name, retry] = sb.rpc.mock.calls[1];
    expect(name).toBe('book_slot_group');
    expect(retry).not.toHaveProperty('p_remind_sms');
    expect(retry).not.toHaveProperty('p_rebook_sms');
    expect(retry.p_people).toHaveLength(2);
  });

  it('retries only once, and only for PGRST202', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sb.rpc.mockClear();
    sb.rpc.mockResolvedValueOnce(noSignature).mockResolvedValueOnce(noSignature);
    await expect(bookSlot(single)).rejects.toBeInstanceOf(BookingError);
    expect(sb.rpc).toHaveBeenCalledTimes(2);

    sb.rpc.mockClear();
    sb.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'slot_taken' }, status: 400 });
    await expect(bookSlot(single)).rejects.toMatchObject({ code: 'slot_taken' });
    expect(sb.rpc).toHaveBeenCalledTimes(1);
  });
});

/* ---------- The barbers, from the database ---------- */

const week = (open, close, days = [0, 1, 3, 4, 5, 6]) =>
  days.map(weekday => ({ weekday, open_time: open, close_time: close }));

describe('fetchBarbers: the roster the site offers', () => {
  it('reads the active barbers in sort order, with their week and the days off from today', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-06T14:00:00Z'), toFake: ['Date'] });
    result = { data: [
      { slug: 'hassan', display_name: 'Hassan', title: 'Master Barber', bio: null, photo_url: null, sort_order: 0,
        barber_schedules: week('10:00:00', '18:00:00'), barber_closures: [{ closure_date: '2026-07-09' }] },
      { slug: 'marcus', display_name: 'Marcus', title: null, bio: 'Tapers.', photo_url: `${BUCKET}m.jpg`, sort_order: 20,
        barber_schedules: week('12:00:00', '18:00:00', [3, 4, 5, 6]), barber_closures: [] },
    ], error: null };
    const roster = await fetchBarbers();
    vi.useRealTimers();

    expect(calls).toEqual([
      ['from', 'barbers'], ['select', ROSTER_SELECT], ['eq', 'is_active', true],
      ['gte', 'barber_closures.closure_date', '2026-07-06'], ['order', 'sort_order'], ['order', 'slug'],
    ]);
    expect(roster.map(b => b.slug)).toEqual(['hassan', 'marcus']);
    expect(roster[0]).toMatchObject({ name: 'Hassan', title: 'Master Barber', bio: '', photoUrl: '' });
    expect(roster[0].schedule[1]).toEqual({ open: 600, close: 1080 });
    expect(roster[0].schedule[2]).toBeUndefined();
    expect([...roster[0].closures]).toEqual(['2026-07-09']);
    expect(roster[1]).toMatchObject({ name: 'Marcus', title: '', bio: 'Tapers.', photoUrl: `${BUCKET}m.jpg` });
    expect(Object.keys(roster[1].schedule)).toEqual(['3', '4', '5', '6']);
  });

  it('leaves out a barber with no weekly hours yet (nothing to book)', async () => {
    result = { data: [
      { slug: 'hassan', display_name: 'Hassan', barber_schedules: week('10:00:00', '18:00:00'), barber_closures: [] },
      { slug: 'newbie', display_name: 'Newbie', barber_schedules: [], barber_closures: [] },
    ], error: null };
    expect((await fetchBarbers()).map(b => b.slug)).toEqual(['hassan']);
  });

  it('leaves out a row whose slug breaks the slug rule (it goes into attributes and selectors)', async () => {
    const row = (slug) => ({ slug, display_name: 'X', barber_schedules: week('10:00:00', '18:00:00'), barber_closures: [] });
    result = { data: [row('hassan'), row('a"]<b>'), row('UPPER'), row('x'), row(null), row('larry-2')], error: null };
    expect((await fetchBarbers()).map(b => b.slug)).toEqual(['hassan', 'larry-2']);
  });

  it('a photo is the project\'s own bucket over https, or none', () => {
    expect(safePhotoUrl(`${BUCKET}marcus.jpg`)).toBe(`${BUCKET}marcus.jpg`);
    for (const bad of [
      null, '', 'marcus.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA',
      BUCKET.replace('https:', 'http:') + 'm.jpg',                              // not https
      'https://evil.test/storage/v1/object/public/barber-photos/m.jpg',        // another host
      `https://evil.test/?u=${BUCKET}m.jpg`,
      `${SUPABASE_URL}.evil.test/storage/v1/object/public/barber-photos/m.jpg`,
      `${SUPABASE_URL}/storage/v1/object/public/other-bucket/m.jpg`,           // another bucket
      `${SUPABASE_URL}/rest/v1/barbers`,
    ]) expect(safePhotoUrl(bad), String(bad)).toBe('');
  });

  it('a failed read throws, so the caller keeps config.js\'s barbers', async () => {
    result = { data: null, error: { name: 'TypeError', message: 'TypeError: Failed to fetch' } };
    await expect(fetchBarbers()).rejects.toBeInstanceOf(BookingError);
  });
});

describe('fetchNextAvailable follows the roster', () => {
  const NOW = new Date('2026-07-06T14:00:00Z');          // Mon 10:00 AM in Chicopee
  const barber = (slug, name, schedule, closures = []) => ({ slug, name, schedule, closures: new Set(closures) });
  const daily = (open, close, days = [0, 1, 3, 4, 5, 6]) => Object.fromEntries(days.map(d => [d, { open, close }]));

  beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
  afterEach(() => { vi.useRealTimers(); resetRoster(); });

  it('a third barber from the database can hold the next open slot', async () => {
    setRoster([barber('hassan', 'Hassan', daily(600, 1080)), barber('marcus', 'Marcus', daily(600, 1080))]);
    // Hassan is booked solid today; Marcus has 10:45.
    const hassanToday = [645, 690, 735, 780, 825, 870, 915, 960, 1005, 1050]
      .map(m => ({ barber_slug: 'hassan', booking_date: '2026-07-06', booking_time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00` }));
    result = { data: hassanToday, error: null };
    const next = await fetchNextAvailable();
    expect(next).toMatchObject({ date: '2026-07-06', time: '10:45:00', barberSlug: 'marcus', barberName: 'Marcus' });
    expect(next.label).toBe('MON, JUL 6 · 10:45 AM · MARCUS');
  });

  it('a slot overlapped by an off-grid booking is not offered', async () => {
    // Hassan's day starts at 10:15 now; a booking from the old grid sits at 10:30.
    setRoster([barber('hassan', 'Hassan', daily(615, 1080))]);
    result = { data: [{ barber_slug: 'hassan', booking_date: '2026-07-06', booking_time: '10:30:00' }], error: null };
    // 10:15 and 11:00 both overlap [10:30, 11:15); 11:45 is the first free.
    expect(await fetchNextAvailable()).toMatchObject({ date: '2026-07-06', time: '11:45:00' });
  });

  it('one barber\'s next slot: only that barber\'s bookings are read, and another barber\'s earlier slot is not it', async () => {
    setRoster([barber('hassan', 'Hassan', daily(600, 1080)), barber('larry', 'Larry', daily(600, 1080))]);
    // Hassan is booked 10:45 to 1:00 today; Larry is free at 10:45.
    result = { data: [645, 690, 735].map(m => ({ barber_slug: 'hassan', booking_date: '2026-07-06',
      booking_time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00` })), error: null };
    expect(await fetchNextAvailable({ barberSlug: 'hassan' }))
      .toMatchObject({ date: '2026-07-06', time: '13:00:00', barberSlug: 'hassan', shortLabel: 'Mon 1:00 PM' });
    expect(calls).toContainEqual(['eq', 'barber_slug', 'hassan']);
    expect(await fetchNextAvailable()).toMatchObject({ time: '10:45:00', barberSlug: 'larry' });
  });

  it('a barber not on offer has no next slot, without a read', async () => {
    setRoster([barber('larry', 'Larry', daily(600, 1080))]);
    calls = [];
    expect(await fetchNextAvailable({ barberSlug: 'hassan' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a day off and a deactivated barber are never offered', async () => {
    // Only Larry is active, and he is off today (Monday): the next slot is Wednesday at 10.
    setRoster([barber('larry', 'Larry', daily(600, 1080), ['2026-07-06'])]);
    result = { data: [], error: null };
    expect(await fetchNextAvailable()).toMatchObject({ date: '2026-07-08', time: '10:00:00', barberSlug: 'larry' });
  });
});
