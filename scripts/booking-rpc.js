// booking-rpc.js — Supabase RPC wrappers.

import { sb } from './supabase.js';
import { DEFAULT_BARBER_SLUG } from './config.js';
import { ROSTER_SELECT, rosterFromRows, barberList } from './roster.js';
import {
  mapBookingErrorCode, isoDate, slotsForDate, minutesToHms, minutesToLabel,
  nowMinutesInShopTz, addDaysIso, dateLabelFromIso,
} from './booking-helpers.js';

export class BookingError extends Error {
  constructor(code, cause) {
    super(code);
    this.code  = code;
    this.cause = cause;
  }
}

/** `status` is the HTTP status PostgREST answered with (429 = rate limited). */
function toBookingError(error, rpcName, status) {
  console.error(`[booking] ${rpcName} RPC failed:`, error);
  return new BookingError(mapBookingErrorCode(error, status), error);
}

/** book_slot and book_slot_group take the text-consent flags from migration
 *  0020 on. Against a database without it PostgREST finds no function with
 *  that signature (PGRST202), so the booking goes once more without them. */
async function rpcWithConsent(rpcName, args) {
  const res = await sb.rpc(rpcName, args);
  if (res.error?.code !== 'PGRST202') return res;
  console.warn(`[booking] ${rpcName} takes no p_remind_sms/p_rebook_sms yet (migration 0020); booking without them`);
  const { p_remind_sms, p_rebook_sms, ...older } = args;
  return sb.rpc(rpcName, older);
}

/**
 * Atomically book a slot. Throws BookingError on conflict / validation error.
 * Returns N rows (one per 45-min slot the service occupies); row 0 is the
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
  remindSms = true,      // "Text me a reminder the day before"
  rebookSms = false,     // "Text me when it's time for my next cut"
}) {
  const { data, error, status } = await rpcWithConsent('book_slot', {
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
    p_remind_sms:     remindSms,
    p_rebook_sms:     rebookSms,
  });

  if (error) throw toBookingError(error, 'book_slot', status);
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
  remindSms = true,
  rebookSms = false,
}) {
  const { data, error, status } = await rpcWithConsent('book_slot_group', {
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
    p_remind_sms:     remindSms,
    p_rebook_sms:     rebookSms,
  });
  if (error) throw toBookingError(error, 'book_slot_group', status);
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
  const { data, error, status } = await sb.rpc('find_bookings_by_phone', { p_phone: phone });
  if (error) throw toBookingError(error, 'find_bookings_by_phone', status);
  return data || [];
}

/**
 * Cancel a booking (customer-side). The DB verifies the phone matches, flips
 * the row to `cancelled`, and cascades to linked continuation slots — the
 * partial unique index then lets someone else book the freed time.
 */
export async function cancelBooking({ bookingId, phone }) {
  const { error, status } = await sb.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_phone:      phone,
  });
  if (error) throw toBookingError(error, 'cancel_booking', status);
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
 * The active barbers with their weeks and days off from today on, in the
 * shop's order, as roster entries (roster.js). anon reads only active rows
 * (RLS). Throws BookingError when the read fails, so the caller keeps
 * config.js's barbers.
 */
export async function fetchBarbers() {
  const { data, error, status } = await sb
    .from('barbers')
    .select(ROSTER_SELECT)
    .eq('is_active', true)
    .gte('barber_closures.closure_date', isoDate(new Date()))
    .order('sort_order')
    .order('slug');
  if (error) {
    console.warn('[booking] fetchBarbers failed', error);
    throw new BookingError(mapBookingErrorCode(error, status), error);
  }
  return rosterFromRows(data || []);
}

/**
 * Fetch all active (pending/confirmed) bookings between [fromDate, toDate].
 * Pass `barberSlug` to scope to one barber, or null for every barber.
 * Returns array of { barber_slug, booking_date, booking_time, status }.
 * Driven by the PII-free v_slot_availability view. Throws BookingError when
 * the read fails: an empty list means "nothing booked", so a failed read must
 * never look like one.
 */
export async function fetchAvailability({ fromDate, toDate, barberSlug = DEFAULT_BARBER_SLUG }) {
  let query = sb
    .from('v_slot_availability')
    .select('barber_slug,booking_date,booking_time,status')
    .gte('booking_date', fromDate)
    .lte('booking_date', toDate);
  if (barberSlug) query = query.eq('barber_slug', barberSlug);

  const { data, error, status } = await query;
  if (error) {
    console.warn('[booking] fetchAvailability failed', error);
    throw new BookingError(mapBookingErrorCode(error, status), error);
  }
  return data || [];
}

/**
 * Find the next available 45-minute slot across ALL barbers, looking up to
 * 14 days ahead. Returns { date, time, label, barberSlug, barberName } or null.
 * Throws when availability can't be read.
 */
export async function fetchNextAvailable() {
  const fromDate = isoDate(new Date());
  const toDate   = addDaysIso(fromDate, 14);
  const taken    = await fetchAvailability({ fromDate, toDate, barberSlug: null });

  const takenSet = new Set(
    taken.map(r => `${r.barber_slug}|${r.booking_date}|${r.booking_time.slice(0, 5)}`)
  );

  const todayIso = fromDate;
  const nowMin   = nowMinutesInShopTz();
  const barbers  = barberList();

  for (let i = 0; i <= 14; i++) {
    const iso = addDaysIso(fromDate, i);

    // Earliest free slot this day, comparing across barbers.
    let best = null;
    for (const barber of barbers) {
      for (const m of slotsForDate(iso, barber.slug)) {
        if (iso === todayIso && m <= nowMin) continue;               // past slot today
        if (takenSet.has(`${barber.slug}|${iso}|${minutesToHms(m).slice(0, 5)}`)) continue;
        if (!best || m < best.minutes) best = { minutes: m, barber };
        break;                                                       // first free = earliest for this barber
      }
    }
    if (best) {
      const time = minutesToLabel(best.minutes);
      return {
        date: iso,
        time: minutesToHms(best.minutes),
        barberSlug: best.barber.slug,
        barberName: best.barber.name,
        label: `${dayLabel(iso)} · ${time} · ${best.barber.name.toUpperCase()}`,
        shortLabel: `${dateLabelFromIso(iso, { weekday: 'short' })} ${time}`,   // fits the sticky bar
      };
    }
  }
  return null;
}

function dayLabel(iso) {
  return dateLabelFromIso(iso, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
}
