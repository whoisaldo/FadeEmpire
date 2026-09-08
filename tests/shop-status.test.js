// Unit tests for the live status line and the timezone helpers behind it:
// open / closing soon / closed with the right "what happens next" detail,
// across the closed Tuesday, and across daylight-saving switches.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  shopStatus, minutesToShortLabel, nowMinutesInShopTz, shopWeekday, isoDate,
} from '../scripts/booking-helpers.js';
import { STORE_HOURS } from '../scripts/config.js';

const MON = 1, TUE = 2, WED = 3, SUN = 0;
const OPEN = 10 * 60, CLOSE = 18 * 60;

describe('minutesToShortLabel', () => {
  it('drops ":00" on the hour and keeps minutes otherwise', () => {
    expect(minutesToShortLabel(600)).toBe('10 AM');
    expect(minutesToShortLabel(1080)).toBe('6 PM');
    expect(minutesToShortLabel(1050)).toBe('5:30 PM');
    expect(minutesToShortLabel(0)).toBe('12 AM');
    expect(minutesToShortLabel(720)).toBe('12 PM');
  });
});

describe('shopStatus', () => {
  it('is open in the middle of an open day and says when it closes', () => {
    expect(shopStatus({ weekday: WED, nowMin: 13 * 60 }))
      .toEqual({ state: 'open', label: 'Open now', detail: 'Closes 6 PM' });
  });

  it('flips to "closing soon" inside the last hour, inclusive of the boundary', () => {
    expect(shopStatus({ weekday: WED, nowMin: CLOSE - 61 }).state).toBe('open');
    expect(shopStatus({ weekday: WED, nowMin: CLOSE - 60 }).state).toBe('soon');
    expect(shopStatus({ weekday: WED, nowMin: CLOSE - 1 })).toMatchObject({ state: 'soon', label: 'Closing soon' });
  });

  it('respects a custom closing-soon window', () => {
    expect(shopStatus({ weekday: WED, nowMin: CLOSE - 45, closingSoonMin: 30 }).state).toBe('open');
    expect(shopStatus({ weekday: WED, nowMin: CLOSE - 20, closingSoonMin: 30 }).state).toBe('soon');
  });

  it('is open exactly at opening time and closed exactly at closing time', () => {
    expect(shopStatus({ weekday: WED, nowMin: OPEN }).state).toBe('open');
    expect(shopStatus({ weekday: WED, nowMin: OPEN - 1 }).state).toBe('closed');
    expect(shopStatus({ weekday: WED, nowMin: CLOSE }).state).toBe('closed');
  });

  it('before opening on an open day it says "Opens today"', () => {
    expect(shopStatus({ weekday: WED, nowMin: 8 * 60 }))
      .toEqual({ state: 'closed', label: 'Closed', detail: 'Opens today 10 AM' });
  });

  it('after closing it points at tomorrow when tomorrow is open', () => {
    expect(shopStatus({ weekday: WED, nowMin: 19 * 60 }).detail).toBe('Opens tomorrow 10 AM');
    expect(shopStatus({ weekday: SUN, nowMin: 19 * 60 }).detail).toBe('Opens tomorrow 10 AM');
  });

  it('skips the closed Tuesday: Monday evening points at Wednesday', () => {
    expect(shopStatus({ weekday: MON, nowMin: 19 * 60 }))
      .toEqual({ state: 'closed', label: 'Closed', detail: 'Opens Wed 10 AM' });
  });

  it('on the closed day itself it is closed all day and points at tomorrow', () => {
    for (const nowMin of [0, 9 * 60, 12 * 60, 17 * 60 + 30, 23 * 60 + 59]) {
      expect(shopStatus({ weekday: TUE, nowMin }))
        .toEqual({ state: 'closed', label: 'Closed', detail: 'Opens tomorrow 10 AM' });
    }
  });

  it('never claims to be open on a day STORE_HOURS has no entry for', () => {
    for (let wk = 0; wk <= 6; wk++) {
      if (STORE_HOURS[wk]) continue;
      for (let m = 0; m < 24 * 60; m += 15) expect(shopStatus({ weekday: wk, nowMin: m }).state).toBe('closed');
    }
  });

  it('defaults to the shop clock when called without arguments', () => {
    const now = shopStatus();
    expect(['open', 'soon', 'closed']).toContain(now.state);
    expect(now.label.length).toBeGreaterThan(0);
  });
});

describe('shop clock across daylight-saving switches', () => {
  afterEach(() => vi.useRealTimers());

  it('reads the wall clock in America/New_York, not UTC', () => {
    vi.useFakeTimers({ now: new Date('2026-07-06T14:00:00Z'), toFake: ['Date'] }); // 10:00 EDT
    expect(nowMinutesInShopTz()).toBe(600);
    expect(shopWeekday()).toBe(MON);
  });

  it('spring forward: 07:00Z on 2026-03-08 is 3 AM, the 2 AM hour never existed', () => {
    vi.useFakeTimers({ now: new Date('2026-03-08T07:00:00Z'), toFake: ['Date'] });
    expect(nowMinutesInShopTz()).toBe(180);
    expect(isoDate(new Date())).toBe('2026-03-08');
  });

  it('fall back: 06:30Z on 2026-11-01 is 1:30 AM EST, the day does not change', () => {
    vi.useFakeTimers({ now: new Date('2026-11-01T06:30:00Z'), toFake: ['Date'] });
    expect(nowMinutesInShopTz()).toBe(90);
    expect(isoDate(new Date())).toBe('2026-11-01');
    expect(shopWeekday()).toBe(SUN);
  });

  it('late-night UTC is still the previous shop day', () => {
    vi.useFakeTimers({ now: new Date('2026-09-09T03:30:00Z'), toFake: ['Date'] }); // Tue 11:30 PM EDT
    expect(isoDate(new Date())).toBe('2026-09-08');
    expect(shopWeekday()).toBe(TUE);
    expect(shopStatus().detail).toBe('Opens tomorrow 10 AM');
  });
});
