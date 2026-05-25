// booking-helpers.js — pure helpers shared across booking modules.

import { SCHEDULE, SHOP_TZ, SLOT_MINUTES, SERVICE_PRICES_CENTS, ADDON_PRICES_CENTS } from './config.js';

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

/** Generate the slot list (in minutes) for a given weekday. Returns [] if closed. */
export function slotsForWeekday(weekday) {
  const sched = SCHEDULE[weekday];
  if (!sched) return [];
  const out = [];
  for (let m = sched.open; m + SLOT_MINUTES <= sched.close; m += SLOT_MINUTES) {
    out.push(m);
  }
  return out;
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

/** Build the WhatsApp/SMS booking message. `useMarkdown` adds * and _ wrappers. */
export function buildMessage({ bookingId, name, phone, serviceLabel, dateLabel, timeLabel, addons, notes, customRequest, totalLabel, useMarkdown = true }) {
  const bold = (s) => useMarkdown ? `*${s}*` : s;
  const italic = (s) => useMarkdown ? `_${s}_` : s;
  const lines = [
    `${bold('FADE EMPIRE — BOOKING REQUEST')}`,
    ``,
    `Ref:    ${bookingId || '—'}`,
    `Name:   ${name}`,
    `Phone:  ${phone}`,
    `Service:${serviceLabel}`,
    `Date:   ${dateLabel}`,
    `Time:   ${timeLabel}`,
  ];
  if (addons && addons.length) lines.push(`Add-ons:${addons.join(', ')}`);
  if (customRequest) lines.push(`Custom: ${customRequest}`);
  if (notes) lines.push(`Notes:  ${notes}`);
  lines.push(`Total:  ${totalLabel}`);
  lines.push('');
  lines.push(italic('Sent from chicopeefadeempire.com'));
  return lines.join('\n');
}

/** Map a Postgres error from book_slot() to a user-friendly code. */
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
  if (msg.includes('barber_closed'))           return 'closed';
  if (msg.includes('too_many_active_bookings'))return 'too_many';
  if (msg.includes('invalid_phone'))           return 'bad_phone';
  if (msg.includes('invalid_name'))            return 'bad_name';
  if (msg.includes('date_out_of_range'))       return 'bad_date';
  if (msg.includes('invalid_slot_alignment'))  return 'bad_slot';
  return 'unknown';
}

export const ERROR_MESSAGES = {
  slot_taken:    'That time was just booked. Pick another slot above.',
  outside_hours: "We're closed at that time. Try a different slot.",
  closed:        'The shop is closed that day. Try another date.',
  too_many:      'You already have several active holds. Cancel one first or call us.',
  bad_phone:     'Please enter a valid 10-digit phone number.',
  bad_name:      'Please enter your name.',
  bad_date:      'Date is too far out — we book up to 60 days ahead.',
  bad_slot:      "That time doesn't line up with our slots. Pick a slot pill instead.",
  not_setup:     'Online booking is being set up. Please call or text 413·885·4440 to reserve.',
  network:       "Can't reach our booking system right now. Call or text 413·885·4440 to reserve.",
  unknown:       'Something went wrong. Please try again, or call 413·885·4440.',
};
