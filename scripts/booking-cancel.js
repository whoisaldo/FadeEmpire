// booking-cancel.js — customer-side cancellation flow.
//
// Flow:
//   1. Customer enters the phone number they booked with → find_bookings_by_phone
//      RPC lists that phone's own upcoming bookings (phone = cheap auth, same
//      trust model as cancel_booking in the DB).
//   2. Tap Cancel on a booking → tap again to confirm (no browser confirm()
//      dialogs) → cancel_booking RPC flips the row to `cancelled`, which drops
//      it out of the partial unique index — the slot instantly reopens.
//   3. On success we prefill a cancellation text to the shop so the barber
//      knows the gap is real: auto-open SMS on mobile, tap-to-send links on
//      desktop. Then the slot grid refreshes so the freed time shows as open.

import { findBookingsByPhone, cancelBooking, BookingError } from './booking-rpc.js';
import { refreshAvailability as gridRefresh } from './booking-grid.js';
import {
  cleanPhone, formatPhoneDisplay, minutesToLabel, hmsToMinutes,
  dateLabelFromIso, formatPrice, ERROR_MESSAGES,
} from './booking-helpers.js';
import { buildCancelMessage, messagingUrl, SERVICE_LABELS } from './booking-messages.js';
import { BARBERS } from './config.js';

const ARM_TIMEOUT_MS = 5000;   // "tap again to confirm" window

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(root, text, tone = 'muted') {
  const status = root.querySelector('[data-cancel-status]');
  if (!status) return;
  status.textContent = text || '';
  status.hidden = !text;
  status.dataset.tone = tone;
}

/* ---------- Rendering the bookings list ---------- */

function bookingLine(b) {
  const service = SERVICE_LABELS[b.service_slug] || b.service_name || b.service_slug;
  const barber  = BARBERS[b.barber_slug]?.name || b.barber_name || '';
  const when    = `${dateLabelFromIso(b.booking_date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${minutesToLabel(hmsToMinutes(b.booking_time))}`;
  return { service, barber, when };
}

function renderBookings(root, bookings, phoneDigits) {
  const list = root.querySelector('[data-cancel-results]');
  list.innerHTML = '';

  if (!bookings.length) {
    setStatus(root, 'No upcoming bookings found for that number.', 'muted');
    return;
  }
  setStatus(root, `${bookings.length} upcoming booking${bookings.length > 1 ? 's' : ''} — cancel any of them below.`, 'ok');

  bookings.forEach((b) => {
    const { service, barber, when } = bookingLine(b);

    const row  = el('div', 'cancel__row');
    const info = el('div', 'cancel__info');
    info.appendChild(el('span', 'cancel__service t-display-sm',
      b.first_name ? `${b.first_name} · ${service}` : service));
    info.appendChild(el('span', 'cancel__meta t-meta',
      `with ${barber} · ${when} · ${formatPrice(b.total_price_cents)}`));
    row.appendChild(info);

    const btn = el('button', 'btn btn--ghost cancel__btn', 'Cancel');
    btn.type = 'button';
    let armed = false;
    let disarmTimer = null;

    btn.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        btn.textContent = 'Tap again to confirm';
        btn.classList.add('is-arming');
        disarmTimer = setTimeout(() => {
          armed = false;
          btn.textContent = 'Cancel';
          btn.classList.remove('is-arming');
        }, ARM_TIMEOUT_MS);
        return;
      }

      clearTimeout(disarmTimer);
      btn.disabled = true;
      btn.textContent = 'Cancelling…';

      try {
        await cancelBooking({ bookingId: b.booking_id, phone: phoneDigits });
      } catch (err) {
        const code = err instanceof BookingError ? err.code : 'unknown';
        btn.disabled = false;
        armed = false;
        btn.textContent = 'Cancel';
        btn.classList.remove('is-arming');
        setStatus(root, ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown, 'error');
        return;
      }

      // Cancelled in the DB — the slot is already freed. Now hand the customer
      // a prefilled text so the barber hears about the gap immediately.
      const message = buildCancelMessage({
        firstName:    b.first_name || 'Customer',
        phone:        formatPhoneDisplay(phoneDigits),
        barberName:   barber,
        serviceLabel: service,
        dateLabel:    dateLabelFromIso(b.booking_date),
        timeLabel:    minutesToLabel(hmsToMinutes(b.booking_time)),
        ref:          b.booking_id,
      });
      const smsUrl = messagingUrl('sms', message);
      const waUrl  = messagingUrl('whatsapp', message);

      row.classList.add('is-cancelled');
      row.removeChild(btn);
      const done = el('div', 'cancel__done');
      done.appendChild(el('span', 'cancel__done-text t-meta', 'Cancelled — the slot is freed.'));
      const smsLink = el('a', 'btn btn--mini', 'Text the shop');
      smsLink.href = smsUrl;
      const waLink = el('a', 'btn btn--mini', 'WhatsApp');
      waLink.href = waUrl;
      waLink.target = '_blank';
      waLink.rel = 'noopener';
      done.appendChild(smsLink);
      done.appendChild(waLink);
      row.appendChild(done);

      setStatus(root, 'Your booking is cancelled. Please send the prefilled text so the shop knows right away.', 'ok');

      // Mobile: open the SMS compose sheet automatically.
      const isMobile = window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
      if (isMobile) {
        setTimeout(() => { window.location.href = smsUrl; }, 600);
      }

      // Freed slot should show as open in the grid without a reload.
      gridRefresh();
    });

    row.appendChild(btn);
    list.appendChild(row);
  });
}

/* ---------- Lookup ---------- */

async function lookup(root) {
  const input  = root.querySelector('[data-cancel-phone]');
  const button = root.querySelector('[data-cancel-find]');
  const list   = root.querySelector('[data-cancel-results]');
  const digits = cleanPhone(input.value);

  if (digits.length < 10) {
    setStatus(root, 'Enter the 10-digit phone number you booked with.', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'Looking…';
  list.innerHTML = '';
  setStatus(root, '');

  try {
    const bookings = await findBookingsByPhone(digits);
    renderBookings(root, bookings, digits);
  } catch (err) {
    const code = err instanceof BookingError ? err.code : 'unknown';
    setStatus(root, ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Find my booking';
  }
}

/* ---------- Boot ---------- */

export function initBookingCancel() {
  const root = document.querySelector('[data-cancel-root]');
  if (!root) return;

  const input = root.querySelector('[data-cancel-phone]');
  input.addEventListener('input', (e) => {
    let digits = e.target.value.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    e.target.value = formatPhoneDisplay(digits.slice(0, 10));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); lookup(root); }
  });

  root.querySelector('[data-cancel-find]').addEventListener('click', () => lookup(root));

  // The "Need to cancel?" toggle in the booking fine print.
  document.querySelectorAll('[data-cancel-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      root.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input.focus({ preventScroll: true });
    });
  });
}
