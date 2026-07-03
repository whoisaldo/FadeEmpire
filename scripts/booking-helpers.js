// booking-helpers.js — pure helpers shared across booking modules.

import {
  STORE_HOURS, BARBERS, DEFAULT_BARBER_SLUG, SHOP_TZ, SLOT_MINUTES,
  SERVICE_PRICES_CENTS, SERVICE_DURATIONS_MIN, ADDON_PRICES_CENTS,
} from './config.js';

/** Strict ISO yyyy-mm-dd in local (shop) time for a given Date. */
export function isoDate(d) {
  // Format as if d were in the shop timezone. For a single-shop site this is fine.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d); // en-CA produces YYYY-MM-DD
}

/** "HH:MM:SS" from minutes-since-midnight (e.g. 600 → "10:00:00"). */
export function minutesToHms(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${h}:${m}:00`;
}

/** "10:00 AM" pretty label from minutes. */
export function minutesToLabel(mins) {
  const h24 = Math.floor(mins / 60);
  const m   = mins % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = ((h24 + 11) % 12) + 1;
  const mm  = String(m).padStart(2, '0');
  return `${h12}:${mm} ${period}`;
}

/** Parse "HH:MM:SS" to minutes-since-midnight. */
export function hmsToMinutes(hms) {
  const [h, m] = hms.split(':').map(Number);
  return h * 60 + m;
}

/** Format a Date in shop timezone with given Intl options. */
export function fmtShopTime(d, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TZ, ...opts }).format(d);
}

/**
 * Weekday (0=Sun … 6=Sat) for a calendar date given as 'YYYY-MM-DD'.
 * Pure calendar math — immune to the viewer's local timezone. (Parsing
 * `${iso}T12:00:00` as a local Date shifts the day for far-east visitors.)
 */
export function weekdayFromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Human label ("Friday, July 4") for a 'YYYY-MM-DD' calendar date, TZ-safe. */
export function dateLabelFromIso(iso, opts = { weekday: 'long', month: 'long', day: 'numeric' }) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Current minutes-since-midnight in the shop timezone (handles DST). */
export function nowMinutesInShopTz() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = +parts.find(p => p.type === 'hour').value;
  const m = +parts.find(p => p.type === 'minute').value;
  return (h % 24) * 60 + m;
}

/** Day-of-week (0-6) in the shop timezone. */
export function shopWeekday(d = new Date()) {
  const wk = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ, weekday: 'short',
  }).format(d);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(wk);
}

/**
 * Effective bookable hours for a barber on a weekday: the intersection of
 * STORE_HOURS and the barber's own schedule. Null = closed (store closed,
 * barber's day off, or no overlap). Mirrors the DB-side double check.
 */
export function effectiveHours(weekday, barberSlug = DEFAULT_BARBER_SLUG) {
  const store  = STORE_HOURS[weekday];
  const barber = BARBERS[barberSlug]?.schedule?.[weekday];
  if (!store || !barber) return null;
  const open  = Math.max(store.open, barber.open);
  const close = Math.min(store.close, barber.close);
  return open < close ? { open, close } : null;
}

/**
 * Generate the slot list (in minutes) for a given weekday and barber.
 * Returns [] if the store is closed or the barber is off that day.
 */
export function slotsForWeekday(weekday, barberSlug = DEFAULT_BARBER_SLUG) {
  const hours = effectiveHours(weekday, barberSlug);
  if (!hours) return [];
  const out = [];
  for (let m = hours.open; m + SLOT_MINUTES <= hours.close; m += SLOT_MINUTES) {
    out.push(m);
  }
  return out;
}

/** Chair time in minutes for a service slug (unknown slugs default to one slot). */
export function serviceDurationMin(serviceSlug) {
  return SERVICE_DURATIONS_MIN[serviceSlug] || SLOT_MINUTES;
}

/** How many consecutive 30-min slots a service occupies. */
export function serviceSlotCount(serviceSlug) {
  return Math.max(1, Math.ceil(serviceDurationMin(serviceSlug) / SLOT_MINUTES));
}

/** Compute total cents from service + addon slugs. */
export function totalCents(serviceSlug, addonSlugs = []) {
  const base = SERVICE_PRICES_CENTS[serviceSlug] || 0;
  const add  = addonSlugs.reduce((s, a) => s + (ADDON_PRICES_CENTS[a] || 0), 0);
  return base + add;
}

/** Format cents as $30 / $30.50. */
export function formatPrice(cents) {
  if (!cents) return '$0';
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** Format a phone for display: 4138854440 → (413) 885-4440. */
export function formatPhoneDisplay(digits) {
  const d = String(digits).replace(/\D/g, '').slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0,3)}) ${d.slice(3)}`;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

/** Normalize user phone input to bare digits; drops a leading US country code. */
export function cleanPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

/** Map a Postgres error from the booking RPCs to a user-friendly code. */
export function mapBookingErrorCode(err) {
  if (!err) return 'unknown';
  const msg  = err.message || '';
  const code = err.code    || '';
  // PostgREST returns PGRST202 when an RPC function isn't found.
  if (code === 'PGRST202' || msg.includes('Could not find the function')) return 'not_setup';
  // Generic network / fetch failure
  if (err.name === 'TypeError' && msg.toLowerCase().includes('fetch'))    return 'network';
  if (msg.includes('slot_taken'))              return 'slot_taken';
  if (msg.includes('outside_working_hours'))   return 'outside_hours';
  if (msg.includes('store_closed'))            return 'store_closed';
  if (msg.includes('barber_closed'))           return 'closed';
  if (msg.includes('too_many_active_bookings'))return 'too_many';
  if (msg.includes('too_many_people'))         return 'too_many_people';
  if (msg.includes('invalid_people'))          return 'invalid_people';
  if (msg.includes('invalid_phone'))           return 'bad_phone';
  if (msg.includes('invalid_name'))            return 'bad_name';
  if (msg.includes('date_out_of_range'))       return 'bad_date';
  if (msg.includes('invalid_slot_alignment'))  return 'bad_slot';
  if (msg.includes('barber_not_found'))        return 'barber_not_found';
  if (msg.includes('service_not_found'))       return 'service_not_found';
  if (msg.includes('cannot_cancel'))           return 'cannot_cancel';
  if (msg.includes('cancel_via_primary'))      return 'cannot_cancel';
  return 'unknown';
}

/** Which error codes should NOT fall back to the messaging path.
 *  `slot_taken` must hard-fail to prevent real double-booking. Everything else
 *  is recoverable — we still want to ping the shop via WhatsApp/SMS.
 */
export const HARD_FAIL_CODES = new Set(['slot_taken']);

export const ERROR_MESSAGES = {
  slot_taken:      'That time was just booked. Pick another slot above.',
  outside_hours:   'Your barber is off at that time. Try a different slot.',
  store_closed:    'The shop is closed at that time. Try a different slot.',
  closed:          'The shop is closed that day. Try another date.',
  too_many:        'You already have several active bookings. Cancel one first or call us.',
  bad_phone:       'Please enter a valid 10-digit phone number.',
  bad_name:        'Please enter a name (at least 2 characters).',
  bad_date:        'Date is too far out — we book up to 60 days ahead.',
  bad_slot:        "That time doesn't line up with our slots. Pick a slot pill instead.",
  invalid_people:  'The guest list looks off. Remove and re-add guests, or refresh the page.',
  too_many_people: 'Max 6 people per group. Split into two bookings.',
  barber_not_found:'Shop is not accepting online bookings right now. Call 413·885·4440.',
  service_not_found:'That service isn\'t available. Pick another from the menu.',
  cannot_cancel:   "We couldn't find an active booking matching that phone. It may already be cancelled.",
  not_setup:       'Online booking is being set up. Please call or text 413·885·4440 to reserve.',
  network:         "Can't reach our booking system right now. Call or text 413·885·4440 to reserve.",
  unknown:         'Something went wrong. Please try again, or call 413·885·4440.',
};
