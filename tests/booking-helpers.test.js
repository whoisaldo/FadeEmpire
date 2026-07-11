// Unit tests for the pure booking helpers: time math, per-barber scheduling,
// store-hours intersection, formatting, and RPC error mapping.

import { describe, it, expect } from 'vitest';
import {
  isoDate, minutesToHms, minutesToLabel, hmsToMinutes,
  weekdayFromIso, dateLabelFromIso,
  effectiveHours, slotsForWeekday, serviceDurationMin, serviceSlotCount,
  totalCents, formatPrice, formatPhoneDisplay, cleanPhone,
  mapBookingErrorCode, HARD_FAIL_CODES, ERROR_MESSAGES,
} from '../scripts/booking-helpers.js';
import { STORE_HOURS, BARBERS } from '../scripts/config.js';

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

  it('dateLabelFromIso renders the SAME calendar day regardless of viewer TZ', () => {
    expect(dateLabelFromIso('2026-07-04')).toBe('Saturday, July 4');
    expect(dateLabelFromIso('2026-07-04', { weekday: 'short', month: 'short', day: 'numeric' }))
      .toBe('Sat, Jul 4');
  });
});

describe('store hours + barber schedules', () => {
  it('the store is open Mon–Sat 9–6 and Sunday 10–6', () => {
    expect(STORE_HOURS[0]).toEqual({ open: 10 * 60, close: 18 * 60 });
    for (const wk of [1, 2, 3, 4, 5, 6]) {
      expect(STORE_HOURS[wk]).toEqual({ open: 9 * 60, close: 18 * 60 });
    }
  });

  it('effectiveHours intersects store and barber hours', () => {
    // Both barbers open at 10 even though the store opens at 9 Mon–Sat.
    expect(effectiveHours(1, 'hassan')).toEqual({ open: 600, close: 1080 });
    expect(effectiveHours(1, 'larry')).toEqual({ open: 600, close: 1080 });
  });

  it('Hassan is off Tuesdays; Larry covers all seven days', () => {
    expect(effectiveHours(2, 'hassan')).toBeNull();
    expect(effectiveHours(2, 'larry')).not.toBeNull();
    expect(effectiveHours(0, 'hassan')).toEqual({ open: 600, close: 1080 });
    expect(effectiveHours(0, 'larry')).toEqual({ open: 600, close: 1080 });
  });

  it('slotsForWeekday generates 30-min slots that END by closing time', () => {
    const hassanMon = slotsForWeekday(1, 'hassan');
    expect(hassanMon[0]).toBe(600);                    // first slot 10:00
    expect(hassanMon[hassanMon.length - 1]).toBe(1050); // last slot 5:30 (ends 6:00)
    expect(hassanMon).toHaveLength(16);

    const larryMon = slotsForWeekday(1, 'larry');
    expect(larryMon[0]).toBe(600);                     // first slot 10:00
    expect(larryMon).toHaveLength(16);
  });

  it('slotsForWeekday returns [] on days off, slots on working days', () => {
    expect(slotsForWeekday(2, 'hassan')).toEqual([]);  // Hassan's Tuesday off
    expect(slotsForWeekday(2, 'larry')).toHaveLength(16); // Larry covers Tuesdays
    const hassanSun = slotsForWeekday(0, 'hassan');    // Hassan works Sundays 10–6
    expect(hassanSun[0]).toBe(600);
    expect(hassanSun).toHaveLength(16);
  });

  it('every configured barber slot is inside store hours (config self-consistency)', () => {
    for (const barber of Object.values(BARBERS)) {
      for (let wk = 0; wk <= 6; wk++) {
        for (const m of slotsForWeekday(wk, barber.slug)) {
          const store = STORE_HOURS[wk];
          expect(store, `weekday ${wk} should be open if ${barber.slug} has slots`).toBeTruthy();
          expect(m).toBeGreaterThanOrEqual(store.open);
          expect(m + 30).toBeLessThanOrEqual(store.close);
        }
      }
    }
  });

  it('unknown or retired barbers have no bookable slots', () => {
    expect(slotsForWeekday(1, 'nobody')).toEqual([]);
    expect(slotsForWeekday(1, 'javier')).toEqual([]); // retired July 2026
  });
});

describe('service durations', () => {
  it('VIP takes two slots, everything else one', () => {
    expect(serviceDurationMin('vip-haircut')).toBe(60);
    expect(serviceSlotCount('vip-haircut')).toBe(2);
    expect(serviceSlotCount('hair-cut')).toBe(1);
    expect(serviceSlotCount('line-up')).toBe(1);
    expect(serviceSlotCount('unknown-service')).toBe(1); // safe default
  });
});

describe('pricing', () => {
  it('totalCents sums service + addons from the price mirrors', () => {
    expect(totalCents('hair-cut')).toBe(3000);
    expect(totalCents('hair-cut', ['beard'])).toBe(4000);
    expect(totalCents('vip-haircut', ['facial', 'eyebrows'])).toBe(8000);
    expect(totalCents('nope', ['nope-addon'])).toBe(0);
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

  it('every mapped code has a human message', () => {
    const codes = [
      'slot_taken', 'outside_hours', 'store_closed', 'closed', 'too_many',
      'too_many_people', 'invalid_people', 'bad_phone', 'bad_name', 'bad_date',
      'bad_slot', 'barber_not_found', 'service_not_found', 'cannot_cancel',
      'not_setup', 'network', 'unknown',
    ];
    for (const c of codes) {
      expect(ERROR_MESSAGES[c], `message for ${c}`).toBeTruthy();
    }
  });

  it('only slot_taken hard-fails (no messaging fallback)', () => {
    expect([...HARD_FAIL_CODES]).toEqual(['slot_taken']);
  });
});
