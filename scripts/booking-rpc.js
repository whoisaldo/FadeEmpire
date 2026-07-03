// booking-rpc.js — Supabase RPC wrappers.

import { sb } from './supabase.js';
import { BARBERS, DEFAULT_BARBER_SLUG } from './config.js';

export class BookingError extends Error {
  constructor(code, cause) {
    super(code);
    this.code  = code;
    this.cause = cause;
  }
}

async function toBookingError(error, rpcName) {
  const { mapBookingErrorCode } = await import('./booking-helpers.js');
  console.error(`[booking] ${rpcName} RPC failed:`, error);
  return new BookingError(mapBookingErrorCode(error), error);
}

/**
 * Atomically book a slot. Throws BookingError on conflict / validation error.
 * Returns N rows (one per 30-min slot the service occupies); row 0 is the
 * primary booking and carries booking_id + price + addons.
 */
export async function bookSlot({
  barberSlug = DEFAULT_BARBER_SLUG,
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

  if (error) throw await toBookingError(error, 'book_slot');
  return data || [];
}

/**
 * Atomically book a group of consecutive slots starting at `startTime`.
 * `people` is an array of { name, serviceSlug, addons?, notes?, customRequest? }.
 * All-or-nothing: any conflict raises BookingError('slot_taken') and the
 * transaction rolls back. Returns array of { booking_id, person_index,
 * person_name, service_slug, booking_time, total_price_cents }.
 */
export async function bookSlotGroup({
  barberSlug = DEFAULT_BARBER_SLUG,
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
      name:           p.name,
      service_slug:   p.serviceSlug,
      addons:         p.addons || [],
      notes:          p.notes || null,
      custom_request: p.customRequest || null,
    })),
    p_hold_minutes:   holdMinutes,
    p_source:         source,
  });
  if (error) throw await toBookingError(error, 'book_slot_group');
  return data || [];
}

/**
 * List a phone number's own upcoming active bookings (primaries only).
 * The phone acts as cheap auth — same trust model as cancel_booking.
 * Returns array of { booking_id, barber_slug, barber_name, service_slug,
 * service_name, first_name, booking_date, booking_time, duration_minutes,
 * selected_addons, total_price_cents, booking_status }.
 */
export async function findBookingsByPhone(phone) {
  const { data, error } = await sb.rpc('find_bookings_by_phone', { p_phone: phone });
  if (error) throw await toBookingError(error, 'find_bookings_by_phone');
  return data || [];
}

/**
 * Cancel a booking (customer-side). The DB verifies the phone matches, flips
 * the row to `cancelled`, and cascades to linked continuation slots — the
 * partial unique index then lets someone else book the freed time.
 */
export async function cancelBooking({ bookingId, phone }) {
  const { error } = await sb.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_phone:      phone,
  });
  if (error) throw await toBookingError(error, 'cancel_booking');
}

/**
 * Fire-and-forget client-side error log. Inserts into booking_errors so the
 * owner can review failed booking attempts in Supabase Studio. Never throws —
 * if logging itself fails, we don't want to block the customer's fallback path.
 */
export async function logBookingError(payload) {
  try {
    await sb.rpc('log_booking_error', { p: payload });
  } catch (err) {
    console.warn('[booking] log_booking_error failed (ignored):', err);
  }
}

/**
 * Fetch all active (pending/confirmed) bookings between [fromDate, toDate].
 * Pass `barberSlug` to scope to one barber, or null for every barber.
 * Returns array of { barber_slug, booking_date, booking_time, status }.
 * Driven by the PII-free v_slot_availability view.
 */
export async function fetchAvailability({ fromDate, toDate, barberSlug = DEFAULT_BARBER_SLUG }) {
  let query = sb
    .from('v_slot_availability')
    .select('barber_slug,booking_date,booking_time,status')
    .gte('booking_date', fromDate)
    .lte('booking_date', toDate);
  if (barberSlug) query = query.eq('barber_slug', barberSlug);

  const { data, error } = await query;
  if (error) {
    console.warn('[booking] fetchAvailability failed', error);
    return [];
  }
  return data || [];
}

/**
 * Find the next available 30-minute slot across ALL barbers, looking up to
 * 14 days ahead. Returns { date, time, label, barberSlug, barberName } or null.
 */
export async function fetchNextAvailable() {
  const today = new Date();
  const inTwoWeeks = new Date(today.getTime() + 14 * 86400000);
  const { isoDate, slotsForWeekday, minutesToHms, minutesToLabel, shopWeekday, nowMinutesInShopTz } =
    await import('./booking-helpers.js');

  const fromDate = isoDate(today);
  const toDate   = isoDate(inTwoWeeks);
  const taken    = await fetchAvailability({ fromDate, toDate, barberSlug: null });

  const takenSet = new Set(
    taken.map(r => `${r.barber_slug}|${r.booking_date}|${r.booking_time.slice(0, 5)}`)
  );

  const todayIso = fromDate;
  const nowMin   = nowMinutesInShopTz();
  const barbers  = Object.values(BARBERS);

  for (let i = 0; i <= 14; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const iso = isoDate(d);
    const wk  = shopWeekday(d);

    // Earliest free slot this day, comparing across barbers.
    let best = null;
    for (const barber of barbers) {
      for (const m of slotsForWeekday(wk, barber.slug)) {
        if (iso === todayIso && m <= nowMin) continue;               // past slot today
        if (takenSet.has(`${barber.slug}|${iso}|${minutesToHms(m).slice(0, 5)}`)) continue;
        if (!best || m < best.minutes) best = { minutes: m, barber };
        break;                                                       // first free = earliest for this barber
      }
    }
    if (best) {
      return {
        date: iso,
        time: minutesToHms(best.minutes),
        barberSlug: best.barber.slug,
        barberName: best.barber.name,
        label: `${dayLabel(d)} · ${minutesToLabel(best.minutes)} · ${best.barber.name.toUpperCase()}`,
      };
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
