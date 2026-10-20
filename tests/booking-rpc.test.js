// The RPC wrappers against a stubbed PostgREST client: a failed availability
// read has to surface as a failure, never as "nothing is booked".

import { describe, it, expect, vi, beforeEach } from 'vitest';

let result;
vi.mock('../scripts/supabase.js', () => {
  const query = {
    select() { return query; }, gte() { return query; }, lte() { return query; }, eq() { return query; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return { sb: { from: () => query, rpc: vi.fn() } };
});

const { fetchAvailability, fetchNextAvailable, bookSlot, bookSlotGroup, BookingError } = await import('../scripts/booking-rpc.js');
const { sb } = await import('../scripts/supabase.js');

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

describe('a database before migration 0019 (C3)', () => {
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
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('migration 0019'));
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
