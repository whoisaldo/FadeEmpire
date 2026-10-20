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

const { fetchAvailability, fetchNextAvailable, BookingError } = await import('../scripts/booking-rpc.js');

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
