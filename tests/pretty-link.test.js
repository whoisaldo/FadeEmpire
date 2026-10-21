// The /<slug> barber links: 404.html hands the path to scripts/pretty-link.js,
// which reads the active barbers and says where to go. Pure functions plus a
// stubbed fetch; the inline check in 404.html is compared with the module's
// pattern in tests/site-content.test.js.

import { describe, it, expect, vi } from 'vitest';
import {
  slugFromPath, bookingUrl, isActiveBarber, resolvePrettyLink, SLUG_PATH, LOOKUP_WAIT_MS,
} from '../scripts/pretty-link.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../scripts/config.js';

const answer = (rows, status = 200) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => rows }));

describe('slugFromPath', () => {
  it('takes one path segment, with or without the trailing slash, lowercased', () => {
    expect(slugFromPath('/larry')).toBe('larry');
    expect(slugFromPath('/larry/')).toBe('larry');
    expect(slugFromPath('/Larry')).toBe('larry');
    expect(slugFromPath('/big-mike2')).toBe('big-mike2');
  });

  it('anything else is not a barber link', () => {
    for (const path of ['/', '', '/a', `/${'x'.repeat(31)}`, '/larry/extra', '/larry.html', '/assets/img/x.jpg',
      '/lar ry', '/larry%20', '//larry', '/l_arry']) {
      expect(slugFromPath(path), path).toBeNull();
    }
    expect(slugFromPath(undefined)).toBeNull();
  });

  it('accepts the slugs manager_save_barber accepts: [a-z0-9-], 2 to 30 characters', () => {
    expect(SLUG_PATH.test('/ab')).toBe(true);
    expect(SLUG_PATH.test(`/${'a'.repeat(30)}`)).toBe(true);
  });
});

describe('bookingUrl', () => {
  it('goes to the booking form with the barber picked', () => {
    expect(bookingUrl('larry')).toBe('/?barber=larry#book');
  });

  it('carries a service over, and nothing else', () => {
    expect(bookingUrl('larry', '?service=vip-haircut&utm_source=ig')).toBe('/?barber=larry&service=vip-haircut#book');
    expect(bookingUrl('larry', '?barber=hassan')).toBe('/?barber=larry#book');
  });
});

describe('isActiveBarber', () => {
  it('asks for that slug among the active barbers, with the anon key', async () => {
    const fetchFn = answer([{ slug: 'larry' }]);
    expect(await isActiveBarber('larry', { fetchFn })).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${SUPABASE_URL}/rest/v1/barbers?select=slug&is_active=eq.true&slug=eq.larry`);
    expect(init.headers).toEqual({ apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('no row (unknown or deactivated: anon sees active barbers only) is false', async () => {
    expect(await isActiveBarber('javier', { fetchFn: answer([]) })).toBe(false);
  });

  it('an error answer, a broken body, or a network failure is false', async () => {
    expect(await isActiveBarber('larry', { fetchFn: answer({ message: 'nope' }, 500) })).toBe(false);
    expect(await isActiveBarber('larry', { fetchFn: answer({ message: 'not a list' }) })).toBe(false);
    expect(await isActiveBarber('larry', { fetchFn: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) })).toBe(false);
  });

  it('a read slower than the wait is aborted and is false', async () => {
    const fetchFn = vi.fn((url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.useFakeTimers();
    try {
      let active;
      isActiveBarber('larry', { fetchFn }).then((answer) => { active = answer; });
      await vi.advanceTimersByTimeAsync(LOOKUP_WAIT_MS - 1);
      expect(active).toBeUndefined();                  // still asking
      await vi.advanceTimersByTimeAsync(1);
      expect(active).toBe(false);
      expect(fetchFn.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolvePrettyLink', () => {
  it('an active barber\'s path resolves to the booking form', async () => {
    expect(await resolvePrettyLink({ pathname: '/larry/', search: '' }, { fetchFn: answer([{ slug: 'larry' }]) }))
      .toBe('/?barber=larry#book');
  });

  it('a path that is no barber is the 404, without a read when it cannot be a slug', async () => {
    const fetchFn = answer([]);
    expect(await resolvePrettyLink({ pathname: '/not-a-barber', search: '' }, { fetchFn })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const never = answer([{ slug: 'x' }]);
    expect(await resolvePrettyLink({ pathname: '/assets/nope.png', search: '' }, { fetchFn: never })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it('a failed read is the 404', async () => {
    expect(await resolvePrettyLink({ pathname: '/larry', search: '' }, { fetchFn: answer(null, 503) })).toBeNull();
  });
});
