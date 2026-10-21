// Unit tests for the pure booking helpers: time math, per-barber scheduling,
// store-hours intersection, formatting, and RPC error mapping.

import { describe, it, expect, afterEach } from 'vitest';
import {
  isoDate, minutesToHms, minutesToLabel, hmsToMinutes,
  weekdayFromIso, dateLabelFromIso, addDaysIso,
  effectiveHours, slotsForWeekday, slotsForDate, barberHoursLabel, serviceDurationMin, serviceSlotCount,
  totalCents, includedAddons, paidAddons, formatPrice, formatPhoneDisplay, cleanPhone,
  mapBookingErrorCode, FALLBACK_CODES, ERROR_MESSAGES, takenSlots,
} from '../scripts/booking-helpers.js';
import { STORE_HOURS, BARBERS } from '../scripts/config.js';
import { setRoster, resetRoster, rosterFromRows } from '../scripts/roster.js';

describe('time + date helpers', () => {
  it('minutesToHms formats minutes-from-midnight', () => {
    expect(minutesToHms(540)).toBe('09:00:00');
    expect(minutesToHms(600)).toBe('10:00:00');
    expect(minutesToHms(1050)).toBe('17:30:00');
    expect(minutesToHms(0)).toBe('00:00:00');
  });

  it('minutesToLabel renders 12-hour labels', () => {
    expect(minutesToLabel(540)).toBe('9:00 AM');
    expect(minutesToLabel(720)).toBe('12:00 PM');
    expect(minutesToLabel(750)).toBe('12:30 PM');
    expect(minutesToLabel(1050)).toBe('5:30 PM');
    expect(minutesToLabel(0)).toBe('12:00 AM');
  });

  it('hmsToMinutes round-trips with minutesToHms', () => {
    for (const m of [0, 540, 600, 630, 1050]) {
      expect(hmsToMinutes(minutesToHms(m))).toBe(m);
    }
  });

  it('isoDate formats in the shop timezone, not the machine timezone', () => {
    // 03:00 UTC on Jul 6 is still Jul 5, 11 PM in America/New_York (EDT).
    expect(isoDate(new Date('2026-07-06T03:00:00Z'))).toBe('2026-07-05');
    expect(isoDate(new Date('2026-07-06T14:00:00Z'))).toBe('2026-07-06');
  });

  it('weekdayFromIso is pure calendar math (0=Sun … 6=Sat)', () => {
    expect(weekdayFromIso('2026-07-05')).toBe(0); // Sunday
    expect(weekdayFromIso('2026-07-06')).toBe(1); // Monday
    expect(weekdayFromIso('2026-07-07')).toBe(2); // Tuesday
    expect(weekdayFromIso('2026-07-11')).toBe(6); // Saturday
    expect(weekdayFromIso('2028-02-29')).toBe(2); // leap day
  });

  it('addDaysIso steps calendar dates straight through both DST changes', () => {
    expect(addDaysIso('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysIso('2026-10-31', 2)).toBe('2026-11-02');
    expect(addDaysIso('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDaysIso('2026-03-07', 2)).toBe('2026-03-09');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('dateLabelFromIso renders the SAME calendar day regardless of viewer TZ', () => {
    expect(dateLabelFromIso('2026-07-04')).toBe('Saturday, July 4');
    expect(dateLabelFromIso('2026-07-04', { weekday: 'short', month: 'short', day: 'numeric' }))
      .toBe('Sat, Jul 4');
  });
});

describe('store hours + barber schedules', () => {
  it('the store is open 10–6 six days a week and closed Tuesdays', () => {
    for (const wk of [0, 1, 3, 4, 5, 6]) {
      expect(STORE_HOURS[wk]).toEqual({ open: 10 * 60, close: 18 * 60 });
    }
    expect(STORE_HOURS[2]).toBeUndefined();
  });

  it('effectiveHours intersects store and barber hours', () => {
    // Store and both barbers all run 10–6, so the intersection is 10–6.
    expect(effectiveHours(1, 'hassan')).toEqual({ open: 600, close: 1080 });
    expect(effectiveHours(1, 'larry')).toEqual({ open: 600, close: 1080 });
  });

  it('Tuesdays are closed for both barbers; Sundays are open for both', () => {
    expect(effectiveHours(2, 'hassan')).toBeNull();
    expect(effectiveHours(2, 'larry')).toBeNull();
    expect(effectiveHours(0, 'hassan')).toEqual({ open: 600, close: 1080 });
    expect(effectiveHours(0, 'larry')).toEqual({ open: 600, close: 1080 });
  });

  it('slotsForWeekday generates 45-min slots; the last starts at 5:30 and runs past close', () => {
    const hassanMon = slotsForWeekday(1, 'hassan');
    expect(hassanMon[0]).toBe(600);                    // first slot 10:00
    expect(hassanMon[1]).toBe(645);                    // then 10:45 — the 45-min grid
    expect(hassanMon[hassanMon.length - 1]).toBe(1050); // last slot 5:30 (ends 6:15)
    expect(hassanMon).toHaveLength(11);

    const larryMon = slotsForWeekday(1, 'larry');
    expect(larryMon[0]).toBe(600);                     // first slot 10:00
    expect(larryMon).toHaveLength(11);
  });

  it('slotsForWeekday returns [] on closed days, slots on working days', () => {
    expect(slotsForWeekday(2, 'hassan')).toEqual([]);  // shop closed Tuesdays
    expect(slotsForWeekday(2, 'larry')).toEqual([]);   // nobody works Tuesdays
    const hassanSun = slotsForWeekday(0, 'hassan');    // Hassan works Sundays 10–6
    expect(hassanSun[0]).toBe(600);
    expect(hassanSun).toHaveLength(11);
  });

  it('every configured barber slot STARTS inside store hours (config self-consistency)', () => {
    // The last slot may END past close (the barber stays to finish), so the
    // invariant is on the start time only — same rule the DB enforces.
    for (const barber of Object.values(BARBERS)) {
      for (let wk = 0; wk <= 6; wk++) {
        for (const m of slotsForWeekday(wk, barber.slug)) {
          const store = STORE_HOURS[wk];
          expect(store, `weekday ${wk} should be open if ${barber.slug} has slots`).toBeTruthy();
          expect(m).toBeGreaterThanOrEqual(store.open);
          expect(m).toBeLessThan(store.close);
        }
      }
    }
  });

  it('unknown or retired barbers have no bookable slots', () => {
    expect(slotsForWeekday(1, 'nobody')).toEqual([]);
    expect(slotsForWeekday(1, 'javier')).toEqual([]); // retired July 2026
  });
});

describe('any barber from the database (roster.js)', () => {
  afterEach(() => resetRoster());
  const days = (open, close, list) => list.map(weekday => ({ weekday, open_time: open, close_time: close }));
  const roster = (...rows) => setRoster(rosterFromRows(rows.map(r => ({ barber_closures: [], ...r }))));

  it('a third barber\'s slots are the store-hours intersection of the barber\'s week', () => {
    // Marcus: 9 to 7 asked, but the shop is open 10 to 6; Wed to Sat only.
    roster({ slug: 'marcus', display_name: 'Marcus', barber_schedules: days('09:00:00', '19:00:00', [2, 3, 4, 5, 6]) });
    expect(effectiveHours(3, 'marcus')).toEqual({ open: 600, close: 1080 });
    expect(slotsForWeekday(3, 'marcus')[0]).toBe(600);
    expect(slotsForWeekday(3, 'marcus').at(-1)).toBe(1050);
    expect(slotsForWeekday(2, 'marcus')).toEqual([]);    // the shop's closed Tuesday wins
    expect(slotsForWeekday(1, 'marcus')).toEqual([]);    // Marcus's own day off
    expect(slotsForWeekday(1, 'hassan')).toEqual([]);    // not in the roster any more
  });

  it('slotsForDate drops a barber\'s day off and nobody else\'s', () => {
    roster(
      { slug: 'hassan', display_name: 'Hassan', barber_schedules: days('10:00:00', '18:00:00', [0, 1, 3, 4, 5, 6]),
        barber_closures: [{ closure_date: '2026-07-08' }] },
      { slug: 'larry', display_name: 'Larry', barber_schedules: days('10:00:00', '18:00:00', [0, 1, 3, 4, 5, 6]) },
    );
    expect(slotsForDate('2026-07-08', 'hassan')).toEqual([]);
    expect(slotsForDate('2026-07-08', 'larry')).toHaveLength(11);
    expect(slotsForDate('2026-07-09', 'hassan')).toHaveLength(11);
    expect(slotsForDate('2026-07-07', 'larry')).toEqual([]);   // Tuesday
  });

  it('the hours line for config.js\'s barbers is the one index.html ships', () => {
    for (const slug of Object.keys(BARBERS)) {
      expect(barberHoursLabel(slug)).toBe('10 to 6 · Closed Tue');
      expect(barberHoursLabel(slug, { long: true })).toBe('10 AM to 6 PM · Closed Tuesdays');
    }
  });

  it('the hours line says which days a barber is off, and the times only when they are the same every day', () => {
    roster(
      { slug: 'marcus', display_name: 'Marcus', barber_schedules: days('12:00:00', '18:00:00', [3, 4, 5, 6]) },
      { slug: 'dre', display_name: 'Dre', barber_schedules: [
        ...days('10:00:00', '14:00:00', [0, 1]), ...days('12:00:00', '18:00:00', [3, 4, 5, 6])] },
      { slug: 'sam', display_name: 'Sam', barber_schedules: days('10:30:00', '17:15:00', [0, 1, 3, 4, 5, 6]) },
    );
    expect(barberHoursLabel('marcus')).toBe('12 to 6 · Off Sun, Mon, Tue');
    expect(barberHoursLabel('marcus', { long: true })).toBe('12 PM to 6 PM · Off Sundays, Mondays and Tuesdays');
    expect(barberHoursLabel('dre')).toBe('Closed Tue');
    expect(barberHoursLabel('sam', { long: true })).toBe('10:30 AM to 5:15 PM · Closed Tuesdays');
    expect(barberHoursLabel('nobody')).toBe('Off Sun, Mon, Tue, Wed, Thu, Fri, Sat');
  });
});

describe('taken slots (a booking holds its chair for 45 minutes)', () => {
  const row = (barber_slug, booking_date, booking_time) => ({ barber_slug, booking_date, booking_time, status: 'confirmed' });

  it('a booking on the grid takes its own slot only', () => {
    const taken = takenSlots([row('hassan', '2026-07-08', '10:45:00')]);
    expect(taken('hassan', '2026-07-08', 645)).toBe(true);
    expect(taken('hassan', '2026-07-08', 600)).toBe(false);    // 10:00 ends as it starts
    expect(taken('hassan', '2026-07-08', 690)).toBe(false);    // 11:30 starts as it ends
  });

  it('a booking off the grid takes both slots it overlaps', () => {
    const taken = takenSlots([row('hassan', '2026-07-08', '11:30:00')]);
    expect(taken('hassan', '2026-07-08', 615)).toBe(false);    // 10:15 to 11:00
    expect(taken('hassan', '2026-07-08', 660)).toBe(true);     // 11:00 to 11:45
    expect(taken('hassan', '2026-07-08', 705)).toBe(true);     // 11:45 to 12:30
    expect(taken('hassan', '2026-07-08', 750)).toBe(false);    // 12:30
  });

  it('only on that chair, that day', () => {
    const taken = takenSlots([row('hassan', '2026-07-08', '11:30:00')]);
    expect(taken('larry', '2026-07-08', 660)).toBe(false);
    expect(taken('hassan', '2026-07-09', 660)).toBe(false);
    expect(takenSlots([])('hassan', '2026-07-08', 660)).toBe(false);
  });
});

describe('service durations', () => {
  it('every service fits one 45-min slot — the VIP is 45 minutes now', () => {
    expect(serviceDurationMin('vip-haircut')).toBe(45);
    expect(serviceSlotCount('vip-haircut')).toBe(1);
    expect(serviceSlotCount('hair-cut')).toBe(1);
    expect(serviceSlotCount('line-up')).toBe(1);
    expect(serviceSlotCount('unknown-service')).toBe(1); // safe default
  });
});

describe('pricing', () => {
  it('totalCents sums service + addons from the price mirrors', () => {
    expect(totalCents('hair-cut')).toBe(3000);
    expect(totalCents('hair-cut', ['beard'])).toBe(4500);
    expect(totalCents('vip-haircut', ['wax'])).toBe(6500);
    expect(totalCents('nope', ['nope-addon'])).toBe(0);
  });

  it('the VIP includes beard, hot towel, facial, and eyebrows: they add nothing, wax still does (P3)', () => {
    expect(includedAddons('vip-haircut')).toEqual(['eyebrows', 'hot-towel', 'facial', 'beard']);
    expect(includedAddons('hair-cut')).toEqual([]);
    expect(paidAddons('vip-haircut', ['beard', 'facial', 'wax'])).toEqual(['wax']);
    expect(paidAddons('hair-cut', ['beard', 'facial'])).toEqual(['beard', 'facial']);
    expect(totalCents('vip-haircut', ['beard', 'facial', 'hot-towel', 'eyebrows'])).toBe(6000);
  });

  it('a Beard Trim includes the Beard add-on; the other add-ons still count (D14)', () => {
    expect(includedAddons('beard-trim')).toEqual(['beard']);
    expect(totalCents('beard-trim', ['beard'])).toBe(1500);
    expect(totalCents('beard-trim', ['beard', 'hot-towel'])).toBe(2000);
  });

  it('formatPrice renders whole dollars and cents', () => {
    expect(formatPrice(3000)).toBe('$30');
    expect(formatPrice(3050)).toBe('$30.50');
    expect(formatPrice(0)).toBe('$0');
  });
});

describe('phone helpers', () => {
  it('formatPhoneDisplay renders progressive US formatting', () => {
    expect(formatPhoneDisplay('4138854440')).toBe('(413) 885-4440');
    expect(formatPhoneDisplay('413')).toBe('413');
    expect(formatPhoneDisplay('41388')).toBe('(413) 88');
  });

  it('cleanPhone strips formatting and a leading US country code', () => {
    expect(cleanPhone('(413) 885-4440')).toBe('4138854440');
    expect(cleanPhone('1-413-885-4440')).toBe('4138854440');
    expect(cleanPhone('+1 413 885 4440')).toBe('4138854440');
    expect(cleanPhone('885-4440')).toBe('8854440');
    expect(cleanPhone('')).toBe('');
    expect(cleanPhone(null)).toBe('');
  });
});

describe('mapBookingErrorCode', () => {
  const codeOf = (message, extra = {}) => mapBookingErrorCode({ message, ...extra });

  it('maps every RPC exception string to a user-facing code', () => {
    expect(codeOf('slot_taken')).toBe('slot_taken');
    expect(codeOf('outside_working_hours')).toBe('outside_hours');
    expect(codeOf('store_closed')).toBe('store_closed');
    expect(codeOf('barber_closed')).toBe('closed');
    expect(codeOf('too_many_active_bookings')).toBe('too_many');
    expect(codeOf('too_many_people')).toBe('too_many_people');
    expect(codeOf('invalid_people')).toBe('invalid_people');
    expect(codeOf('invalid_phone')).toBe('bad_phone');
    expect(codeOf('invalid_name')).toBe('bad_name');
    expect(codeOf('date_out_of_range')).toBe('bad_date');
    expect(codeOf('invalid_slot_alignment')).toBe('bad_slot');
    expect(codeOf('barber_not_found')).toBe('barber_not_found');
    expect(codeOf('service_not_found')).toBe('service_not_found');
    expect(codeOf('cannot_cancel')).toBe('cannot_cancel');
    expect(codeOf('cancel_via_primary')).toBe('cannot_cancel');
  });

  it('maps infra failures', () => {
    expect(mapBookingErrorCode({ code: 'PGRST202', message: '' })).toBe('not_setup');
    expect(codeOf('Could not find the function public.book_slot')).toBe('not_setup');
    const netErr = new TypeError('Failed to fetch');
    expect(mapBookingErrorCode(netErr)).toBe('network');
    expect(codeOf('some new exotic failure')).toBe('unknown');
    expect(mapBookingErrorCode(null)).toBe('unknown');
  });

  it('an HTTP 429 is rate_limited whatever its code field, unless the DB named the problem (R5)', () => {
    expect(mapBookingErrorCode({ message: 'Too Many Requests', code: '' }, 429)).toBe('rate_limited');
    expect(mapBookingErrorCode({ message: '', code: 'P0001' }, 429)).toBe('rate_limited');
    expect(mapBookingErrorCode({ message: 'too_many_active_bookings', code: 'P0001' }, 429)).toBe('too_many');
    expect(mapBookingErrorCode({ message: 'Too Many Requests', code: '' }, 500)).toBe('unknown');
    expect(ERROR_MESSAGES.rate_limited).toBe('Too many attempts. Wait a minute and try again.');
    expect(FALLBACK_CODES.has('rate_limited')).toBe(false);
  });

  it('every mapped code has a human message', () => {
    const codes = [
      'slot_taken', 'outside_hours', 'store_closed', 'closed', 'too_many',
      'too_many_people', 'invalid_people', 'bad_phone', 'bad_name', 'bad_date',
      'bad_slot', 'barber_not_found', 'service_not_found', 'cannot_cancel',
      'not_setup', 'network', 'rate_limited', 'unknown',
    ];
    for (const c of codes) {
      expect(ERROR_MESSAGES[c], `message for ${c}`).toBeTruthy();
    }
  });

  it('only network and unknown failures fall back to a manual message (P16)', () => {
    expect([...FALLBACK_CODES].sort()).toEqual(['network', 'unknown']);
    expect(FALLBACK_CODES.has('slot_taken')).toBe(false);
  });
});
