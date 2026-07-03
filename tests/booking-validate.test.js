// Unit tests for booking-validate.js — the booking form's pure validation and
// duration-aware party planning (mirrors book_slot_group in the DB).

import { describe, it, expect } from 'vitest';
import { planParty, partyFits, validateBookingInput } from '../scripts/booking-validate.js';

// 2026-07-08 is a Wednesday: Hassan 10–6, Javier 9–6.
const WED = '2026-07-08';
// 2026-07-07 is a Tuesday: Hassan off, Javier 9–6.
const TUE = '2026-07-07';
// 2026-07-05 is a Sunday: store closed.
const SUN = '2026-07-05';

describe('planParty', () => {
  it('stacks people back-to-back in 30-min slots', () => {
    const plan = planParty(600, ['hair-cut', 'kids-cut', 'line-up']);
    expect(plan.map(p => p.startMin)).toEqual([600, 630, 660]);
    expect(plan.every(p => p.slotCount === 1)).toBe(true);
  });

  it('gives a VIP two slots and pushes the next person a full hour', () => {
    const plan = planParty(600, ['vip-haircut', 'hair-cut']);
    expect(plan[0]).toMatchObject({ startMin: 600, slotCount: 2, slotMins: [600, 630] });
    expect(plan[1]).toMatchObject({ startMin: 660, slotCount: 1 });
  });

  it('handles a VIP in the middle of the party', () => {
    const plan = planParty(600, ['hair-cut', 'vip-haircut', 'kids-cut']);
    expect(plan.map(p => p.startMin)).toEqual([600, 630, 690]);
  });
});

describe('partyFits', () => {
  it('accepts a single cut inside working hours', () => {
    expect(partyFits({
      date: WED, barberSlug: 'hassan', startMin: 600, services: ['hair-cut'],
    })).toEqual({ ok: true, offenders: [] });
  });

  it('accepts the last slot of the day (ends exactly at close)', () => {
    expect(partyFits({
      date: WED, barberSlug: 'hassan', startMin: 1050, services: ['hair-cut'],
    }).ok).toBe(true);
  });

  it('accepts a VIP whose second slot ends exactly at close', () => {
    expect(partyFits({
      date: WED, barberSlug: 'javier', startMin: 1020, services: ['vip-haircut'],
    }).ok).toBe(true);
  });

  it('rejects a VIP starting on the last slot (second half past close)', () => {
    const res = partyFits({
      date: WED, barberSlug: 'javier', startMin: 1050, services: ['vip-haircut'],
    });
    expect(res.ok).toBe(false);
    expect(res.offenders).toEqual([0]);
  });

  it('flags only the guests who run past closing', () => {
    // 5:00 PM start: primary 5:00 ok, guest#1 5:30 ok, guest#2 6:00 past close.
    const res = partyFits({
      date: WED, barberSlug: 'hassan', startMin: 1020,
      services: ['hair-cut', 'kids-cut', 'line-up'],
    });
    expect(res.ok).toBe(false);
    expect(res.offenders).toEqual([2]);
  });

  it('a VIP primary pushes the guest past closing (duration-aware)', () => {
    // 5:00 PM VIP takes 5:00+5:30; the guest would start at 6:00 → past close.
    const res = partyFits({
      date: WED, barberSlug: 'javier', startMin: 1020,
      services: ['vip-haircut', 'hair-cut'],
    });
    expect(res.ok).toBe(false);
    expect(res.offenders).toEqual([1]);
  });

  it('rejects Hassan on Tuesdays but accepts Javier', () => {
    const hassan = partyFits({ date: TUE, barberSlug: 'hassan', startMin: 660, services: ['hair-cut'] });
    expect(hassan.ok).toBe(false);
    expect(hassan.offenders).toEqual([0]);
    expect(partyFits({ date: TUE, barberSlug: 'javier', startMin: 660, services: ['hair-cut'] }).ok).toBe(true);
  });

  it('rejects everyone on Sundays (store closed)', () => {
    expect(partyFits({ date: SUN, barberSlug: 'hassan', startMin: 660, services: ['hair-cut'] }).ok).toBe(false);
    expect(partyFits({ date: SUN, barberSlug: 'javier', startMin: 660, services: ['hair-cut'] }).ok).toBe(false);
  });

  it('rejects Hassan before his 10 AM start even though the store opens at 9', () => {
    expect(partyFits({ date: WED, barberSlug: 'hassan', startMin: 540, services: ['hair-cut'] }).ok).toBe(false);
    expect(partyFits({ date: WED, barberSlug: 'javier', startMin: 540, services: ['hair-cut'] }).ok).toBe(true);
  });
});

describe('validateBookingInput', () => {
  const good = {
    name: 'Test Customer',
    phone: '(413) 555-0123',
    serviceSlug: 'hair-cut',
    date: WED,
    time: '11:00:00',
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
