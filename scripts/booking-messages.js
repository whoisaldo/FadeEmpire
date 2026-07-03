// booking-messages.js — builds the WhatsApp/SMS texts sent to the shop.
// Pure string building; shared by booking-submit.js and booking-cancel.js.

import { minutesToLabel, hmsToMinutes, formatPrice } from './booking-helpers.js';
import { SHOP_PHONE } from './config.js';

export const SERVICE_LABELS = {
  'hair-cut':     'Hair Cut',
  'line-up':      'Line Up',
  'beard-trim':   'Beard Trim',
  'kids-cut':     'Kids Cut',
  'military-cut': 'Military Cut',
  'senior-cut':   'Senior Cut',
  'vip-haircut':  'VIP Haircut',
  'custom':       'Custom Request',
};

/** Deep-link URL that opens WhatsApp or the native SMS app with a prefilled text. */
export function messagingUrl(mode, message) {
  const encoded = encodeURIComponent(message);
  return mode === 'whatsapp'
    ? `https://wa.me/${SHOP_PHONE}?text=${encoded}`
    : `sms:+${SHOP_PHONE}?&body=${encoded}`;
}

/** The booking-request text (single person, group, or system-error fallback). */
export function buildBookingMessage({
  name, phone, barberName, dateLabel, bookings, notes, customRequest,
  useMarkdown, systemError = false, errorCode = '',
}) {
  const bold   = (s) => useMarkdown ? `*${s}*` : s;
  const italic = (s) => useMarkdown ? `_${s}_` : s;
  const lines = [];

  if (systemError) {
    lines.push(bold('⚠ BOOKING SYSTEM ERROR — manual confirm needed'));
    if (errorCode) lines.push(italic(`(code: ${errorCode})`));
    lines.push('');
  }

  lines.push(bold('FADE EMPIRE — BOOKING REQUEST'));
  lines.push('');
  lines.push(`Contact: ${name}`);
  lines.push(`Phone:   ${phone}`);
  if (barberName) lines.push(`Barber:  ${barberName}`);
  lines.push(`Date:    ${dateLabel}`);
  if (bookings.length > 1) lines.push(`Party:   ${bookings.length} people`);
  lines.push('');

  bookings.forEach((b, i) => {
    const t = minutesToLabel(hmsToMinutes(b.booking_time));
    lines.push(`${bookings.length > 1 ? '— ' + b.person_name + ' —' : '—'}`);
    lines.push(`  Service: ${SERVICE_LABELS[b.service_slug] || b.service_slug}`);
    lines.push(`  Time:    ${t}`);
    const ref = b.booking_id ? String(b.booking_id).slice(0, 8) : 'continuation';
    lines.push(`  Ref:     ${ref}`);
    if (b.addons && b.addons.length) {
      lines.push(`  Add-ons: ${b.addons.map(a => a.replace(/-/g, ' ')).join(', ')}`);
    }
    if (i < bookings.length - 1) lines.push('');
  });

  if (customRequest) { lines.push(''); lines.push(`Custom: ${customRequest}`); }
  if (notes)         { lines.push(''); lines.push(`Notes:  ${notes}`); }

  const total = bookings.reduce((s, b) => s + b.total_price_cents, 0);
  lines.push('');
  lines.push(`Total:   ${formatPrice(total)}`);
  lines.push('');
  lines.push(italic(systemError
    ? 'Sent from chicopeefadeempire.com — please reply to confirm the slot.'
    : 'Sent from chicopeefadeempire.com'));
  return lines.join('\n');
}

/** The cancellation text sent to the shop after a successful customer cancel. */
export function buildCancelMessage({
  firstName, phone, barberName, serviceLabel, dateLabel, timeLabel, ref,
  useMarkdown = false,
}) {
  const bold   = (s) => useMarkdown ? `*${s}*` : s;
  const italic = (s) => useMarkdown ? `_${s}_` : s;
  const lines = [
    bold('FADE EMPIRE — CANCELLATION'),
    '',
    `Name:    ${firstName}`,
    `Phone:   ${phone}`,
  ];
  if (barberName) lines.push(`Barber:  ${barberName}`);
  lines.push(`Was:     ${serviceLabel}`);
  lines.push(`Date:    ${dateLabel}`);
  lines.push(`Time:    ${timeLabel}`);
  if (ref) lines.push(`Ref:     ${String(ref).slice(0, 8)}`);
  lines.push('');
  lines.push('The slot is open again.');
  lines.push('');
  lines.push(italic('Sent from chicopeefadeempire.com'));
  return lines.join('\n');
}
