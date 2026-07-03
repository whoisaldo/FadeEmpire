// booking-validate.js — pure validation + party-scheduling logic for the
// booking form. No DOM access: booking-submit.js feeds it plain data, and the
// unit tests exercise it directly.

import {
  slotsForWeekday, weekdayFromIso, serviceSlotCount, cleanPhone,
} from './booking-helpers.js';
import { BARBERS, SLOT_MINUTES } from './config.js';

/**
 * Lay out a party (primary + guests) starting at `startMin`, duration-aware:
 * each person occupies serviceSlotCount(service) consecutive slots and the
 * next person starts when the previous one ends. Mirrors book_slot_group.
 * `services`: array of service slugs, index 0 = the primary person.
 * Returns [{ serviceSlug, startMin, slotCount, slotMins: [m, ...] }, ...].
 */
export function planParty(startMin, services) {
  let cursor = startMin;
  return services.map((serviceSlug) => {
    const slotCount = serviceSlotCount(serviceSlug);
    const slotMins  = Array.from({ length: slotCount }, (_, i) => cursor + i * SLOT_MINUTES);
    const entry = { serviceSlug, startMin: cursor, slotCount, slotMins };
    cursor += slotCount * SLOT_MINUTES;
    return entry;
  });
}

/**
 * Check every occupied sub-slot of a planned party against the barber's
 * bookable slots for that date. Returns { ok, offenders } where `offenders`
 * is the set of person indexes whose chair time runs past closing (or lands
 * on a closed day).
 */
export function partyFits({ date, barberSlug, startMin, services }) {
  const weekday    = weekdayFromIso(date);
  const validSlots = new Set(slotsForWeekday(weekday, barberSlug));
  const offenders  = [];
  planParty(startMin, services).forEach((person, idx) => {
    if (!person.slotMins.every(m => validSlots.has(m))) offenders.push(idx);
  });
  return { ok: offenders.length === 0, offenders };
}

/**
 * Validate the whole booking form payload before hitting the RPC.
 * Returns { ok: true } or { ok: false, code, message } with a code that maps
 * into ERROR_MESSAGES (plus form-only codes handled by the caller).
 */
export function validateBookingInput({
  name, phone, serviceSlug, date, time, barberSlug, guests = [],
}) {
  if (!date || !time) {
    return { ok: false, code: 'no_slot', message: 'Pick a day and a time slot above first.' };
  }
  if (!barberSlug || !BARBERS[barberSlug]) {
    return { ok: false, code: 'no_barber', message: 'Pick a barber above first.' };
  }
  if (!name || name.trim().length < 2) {
    return { ok: false, code: 'bad_name', message: 'Please enter a name (at least 2 characters).' };
  }
  if (cleanPhone(phone).length < 10) {
    return { ok: false, code: 'bad_phone', message: 'Please enter a valid 10-digit phone number.' };
  }
  if (!serviceSlug) {
    return { ok: false, code: 'no_service', message: 'Please choose a service.' };
  }
  if (guests.some(g => !g.name || !g.serviceSlug)) {
    return { ok: false, code: 'incomplete_guests', message: 'Please complete or remove the guest rows below.' };
  }
  return { ok: true };
}
