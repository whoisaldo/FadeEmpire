// booking-rpc.js — Supabase RPC wrappers.

import { sb } from './supabase.js';
import { BARBER_SLUG } from './config.js';

export class BookingError extends Error {
  constructor(code, cause) {
    super(code);
    this.code  = code;
    this.cause = cause;
  }
}

/**
 * Atomically book a slot. Throws BookingError on conflict / validation error.
 * Returns { booking_id, status, hold_expires_at, total_price_cents } on success.
 */
export async function bookSlot({
  barberSlug = BARBER_SLUG,
  serviceSlug,
  date,            // 'YYYY-MM-DD'
  time,            // 'HH:MM:SS'
  name,
  phone,
  addons = [],
  notes,
  customRequest,
  source = 'web',
  holdMinutes = 15,
}) {
  const { data, error } = await sb.rpc('book_slot', {
    p_barber_slug:    barberSlug,
    p_service_slug:   serviceSlug,
    p_date:           date,
    p_time:           time,
    p_customer_name:  name,
    p_customer_phone: phone,
    p_addon_slugs:    addons,
    p_notes:          notes || null,
    p_custom_request: customRequest || null,
    p_source:         source,
    p_hold_minutes:   holdMinutes,
  });

  if (error) {
    const { mapBookingErrorCode } = await import('./booking-helpers.js');
    console.error('[booking] book_slot RPC failed:', error);
    throw new BookingError(mapBookingErrorCode(error), error);
  }
  return data && data[0];
}

/**
 * Atomically book a group of consecutive slots starting at `startTime`.
 * `people` is an array of { name, serviceSlug, addons?, notes? }.
 * All-or-nothing: any conflict raises BookingError('slot_taken') and the
 * transaction rolls back. Returns array of { booking_id, person_index,
 * person_name, service_slug, booking_time, total_price_cents }.
 */
export async function bookSlotGroup({
  barberSlug = BARBER_SLUG,
  date,
  startTime,
  phone,
  people,
  source = 'web',
  holdMinutes = 15,
}) {
  const { data, error } = await sb.rpc('book_slot_group', {
    p_barber_slug:    barberSlug,
    p_date:           date,
    p_start_time:     startTime,
    p_customer_phone: phone,
    p_people:         people.map(p => ({
      name:         p.name,
      service_slug: p.serviceSlug,
      addons:       p.addons || [],
      notes:        p.notes || null,
    })),
    p_hold_minutes:   holdMinutes,
    p_source:         source,
  });
  if (error) {
    const { mapBookingErrorCode } = await import('./booking-helpers.js');
    console.error('[booking] book_slot_group RPC failed:', error);
    throw new BookingError(mapBookingErrorCode(error), error);
  }
  return data || [];
}

/**
 * Fetch all active (pending/confirmed) bookings between [fromDate, toDate]
 * for the configured barber. Returns array of { booking_date, booking_time, status }.
 * Driven by the PII-free v_slot_availability view.
 */
export async function fetchAvailability({ fromDate, toDate, barberSlug = BARBER_SLUG }) {
  const { data, error } = await sb
    .from('v_slot_availability')
    .select('booking_date,booking_time,status')
    .eq('barber_slug', barberSlug)
    .gte('booking_date', fromDate)
    .lte('booking_date', toDate);

  if (error) {
    console.warn('[booking] fetchAvailability failed', error);
    return [];
  }
  return data || [];
}

/**
 * Find the next available 30-minute slot, looking up to 14 days ahead.
 * Returns { date, time, label } or null.
 */
export async function fetchNextAvailable() {
  const today = new Date();
  const inTwoWeeks = new Date(today.getTime() + 14 * 86400000);
  const { isoDate, slotsForWeekday, minutesToHms, minutesToLabel, shopWeekday, nowMinutesInShopTz } =
    await import('./booking-helpers.js');

  const fromDate = isoDate(today);
  const toDate   = isoDate(inTwoWeeks);
  const taken    = await fetchAvailability({ fromDate, toDate });

  const takenSet = new Set(
    taken.map(r => `${r.booking_date}|${r.booking_time.slice(0, 5)}`)
  );

  const todayIso = fromDate;
  const nowMin   = nowMinutesInShopTz();

  for (let i = 0; i <= 14; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const iso = isoDate(d);
    const wk  = shopWeekday(d);
    const slots = slotsForWeekday(wk);

    for (const m of slots) {
      // skip past slots on today
      if (iso === todayIso && m <= nowMin) continue;
      const hhmm = minutesToHms(m).slice(0, 5);
      if (takenSet.has(`${iso}|${hhmm}`)) continue;
      return { date: iso, time: minutesToHms(m), label: `${dayLabel(d)} · ${minutesToLabel(m)}` };
    }
  }
  return null;
}

function dayLabel(d) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric',
  }).format(d).toUpperCase();
}
