// Unit tests for booking-validate.js — the booking form's pure validation and
// duration-aware party planning (mirrors book_slot_group in the DB).

import { describe, it, expect } from 'vitest';
import { planParty, partyFits, validateBookingInput } from '../scripts/booking-validate.js';

// 2026-07-08 is a Wednesday: Hassan and Larry both work 10–6.
const WED = '2026-07-08';
// 2026-07-07 is a Tuesday: the shop is closed — nobody works.
const TUE = '2026-07-07';
// 2026-07-05 is a Sunday: store opens at 10, both barbers work 10–6.
const SUN = '2026-07-05';

describe('planParty', () => {
  it('stacks people back-to-back in 45-min slots', () => {
    const plan = planParty(600, ['hair-cut', 'kids-cut', 'line-up']);
    expect(plan.map(p => p.startMin)).toEqual([600, 645, 690]);
    expect(plan.every(p => p.slotCount === 1)).toBe(true);
  });

  it('a VIP is one slot now (45 min) — the next person starts 45 minutes later', () => {
    const plan = planParty(600, ['vip-haircut', 'hair-cut']);
    expect(plan[0]).toMatchObject({ startMin: 600, slotCount: 1, slotMins: [600] });
    expect(plan[1]).toMatchObject({ startMin: 645, slotCount: 1 });
  });

  it('a VIP in the middle of the party no longer stretches it', () => {
    const plan = planParty(600, ['hair-cut', 'vip-haircut', 'kids-cut']);
    expect(plan.map(p => p.startMin)).toEqual([600, 645, 690]);
  });
});

describe('partyFits', () => {
  it('accepts a single cut inside working hours', () => {
    expect(partyFits({
      date: WED, barberSlug: 'hassan', startMin: 600, services: ['hair-cut'],
    })).toEqual({ ok: true, offenders: [] });
  });

  it('accepts the last slot of the day (5:30 — runs to 6:15, barber stays)', () => {
    expect(partyFits({
      date: WED, barberSlug: 'hassan', startMin: 1050, services: ['hair-cut'],
    }).ok).toBe(true);
  });

  it('accepts a VIP on the 5:30 closer — it is a single slot now', () => {
    expect(partyFits({
      date: WED, barberSlug: 'larry', startMin: 1050, services: ['vip-haircut'],
    }).ok).toBe(true);
  });

  it('flags only the guests who run past closing', () => {
    // 4:45 PM start: primary 4:45 ok, guest#1 5:30 ok, guest#2 6:15 past close.
    const res = partyFits({
      date: WED, barberSlug: 'hassan', startMin: 1005,
      services: ['hair-cut', 'kids-cut', 'line-up'],
    });
    expect(res.ok).toBe(false);
    expect(res.offenders).toEqual([2]);
  });

  it('a VIP on the closer fits, but the guest after it lands past closing', () => {
    // 5:30 PM VIP takes the last slot; the guest would start at 6:15 → past close.
    const res = partyFits({
      date: WED, barberSlug: 'larry', startMin: 1050,
      services: ['vip-haircut', 'hair-cut'],
    });
    expect(res.ok).toBe(false);
    expect(res.offenders).toEqual([1]);
  });

  it('rejects starts that sat on the old 30-min grid (11:00 is off-grid now)', () => {
    expect(partyFits({ date: WED, barberSlug: 'hassan', startMin: 660, services: ['hair-cut'] }).ok).toBe(false);
  });

  it('rejects both barbers on Tuesdays — the shop is closed', () => {
    const hassan = partyFits({ date: TUE, barberSlug: 'hassan', startMin: 690, services: ['hair-cut'] });
    expect(hassan.ok).toBe(false);
    expect(hassan.offenders).toEqual([0]);
    const larry = partyFits({ date: TUE, barberSlug: 'larry', startMin: 690, services: ['hair-cut'] });
    expect(larry.ok).toBe(false);
    expect(larry.offenders).toEqual([0]);
  });

  it('Sundays: the store opens at 10 and both barbers work', () => {
    expect(partyFits({ date: SUN, barberSlug: 'hassan', startMin: 690, services: ['hair-cut'] }).ok).toBe(true);
    expect(partyFits({ date: SUN, barberSlug: 'larry', startMin: 690, services: ['hair-cut'] }).ok).toBe(true);
    expect(partyFits({ date: SUN, barberSlug: 'hassan', startMin: 570, services: ['hair-cut'] }).ok).toBe(false); // 9:30, store opens 10 on Sun
  });

  it('rejects 9 AM starts — the shop day runs 10–6 now', () => {
    expect(partyFits({ date: WED, barberSlug: 'hassan', startMin: 540, services: ['hair-cut'] }).ok).toBe(false);
    expect(partyFits({ date: WED, barberSlug: 'larry', startMin: 540, services: ['hair-cut'] }).ok).toBe(false);
  });

  it('javier is retired — no bookable slots on any day', () => {
    expect(partyFits({ date: WED, barberSlug: 'javier', startMin: 690, services: ['hair-cut'] }).ok).toBe(false);
    expect(partyFits({ date: TUE, barberSlug: 'javier', startMin: 690, services: ['hair-cut'] }).ok).toBe(false);
  });
});

describe('validateBookingInput', () => {
  const good = {
    name: 'Test Customer',
    phone: '(413) 555-0123',
    serviceSlug: 'hair-cut',
    date: WED,
    time: '11:30:00',
    barberSlug: 'hassan',
    guests: [],
  };

  it('accepts a complete single booking', () => {
    expect(validateBookingInput(good)).toEqual({ ok: true });
  });

  it('accepts a complete group booking', () => {
    expect(validateBookingInput({
      ...good, guests: [{ name: 'Kid', serviceSlug: 'kids-cut' }],
    })).toEqual({ ok: true });
  });

  it('requires a slot selection first', () => {
    expect(validateBookingInput({ ...good, date: null }).code).toBe('no_slot');
    expect(validateBookingInput({ ...good, time: null }).code).toBe('no_slot');
  });

  it('requires a known barber', () => {
    expect(validateBookingInput({ ...good, barberSlug: null }).code).toBe('no_barber');
    expect(validateBookingInput({ ...good, barberSlug: 'ghost' }).code).toBe('no_barber');
    expect(validateBookingInput({ ...good, barberSlug: 'javier' }).code).toBe('no_barber'); // retired
  });

  it('requires a real name', () => {
    expect(validateBookingInput({ ...good, name: '' }).code).toBe('bad_name');
    expect(validateBookingInput({ ...good, name: ' J ' }).code).toBe('bad_name');
  });

  it('requires 10 phone digits (formatting ignored, country code ok)', () => {
    expect(validateBookingInput({ ...good, phone: '885-4440' }).code).toBe('bad_phone');
    expect(validateBookingInput({ ...good, phone: '1 (413) 885-4440' }).ok).toBe(true);
  });

  it('requires a service', () => {
    expect(validateBookingInput({ ...good, serviceSlug: '' }).code).toBe('no_service');
  });

  it('rejects half-filled guest rows', () => {
    expect(validateBookingInput({
      ...good, guests: [{ name: 'Kid', serviceSlug: '' }],
    }).code).toBe('incomplete_guests');
    expect(validateBookingInput({
      ...good, guests: [{ name: '', serviceSlug: 'kids-cut' }],
    }).code).toBe('incomplete_guests');
  });

  it('every failure carries a human-readable message', () => {
    const bads = [
      { ...good, date: null },
      { ...good, barberSlug: null },
      { ...good, name: '' },
      { ...good, phone: '123' },
      { ...good, serviceSlug: '' },
      { ...good, guests: [{ name: '', serviceSlug: '' }] },
    ];
    for (const b of bads) {
      const res = validateBookingInput(b);
      expect(res.ok).toBe(false);
      expect(res.message.length).toBeGreaterThan(10);
    }
  });
});
