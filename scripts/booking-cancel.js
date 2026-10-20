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
import { canText } from './booking-submit.js';
import { BARBERS } from './config.js';

const ARM_TIMEOUT_MS = 5000;   // "tap again to confirm" window

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** The status line is a live region that stays in the page (empty and
 *  visually hidden when there's nothing to say), so each change is announced. */
function setStatus(root, text, tone = 'muted') {
  const status = root.querySelector('[data-cancel-status]');
  if (!status) return;
  status.textContent = text || '';
  status.dataset.tone = tone;
}

/** The phone field as the thing to fix: marked invalid, described by the
 *  status line, and focused (the same pattern as the booking form). */
function markPhone(root, invalid) {
  const input = root.querySelector('[data-cancel-phone]');
  if (invalid) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', 'cancel-status');
    input.focus();
  } else {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
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
  setStatus(root, `${bookings.length} upcoming booking${bookings.length > 1 ? 's' : ''}. Cancel any of them below.`, 'ok');

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
        btn.focus();               // it was disabled while focused
        return;
      }

      // Cancelled in the DB — the slot is already freed. Offer the prefilled
      // note to the barber the same way the reservation card does: plain
      // links, nothing opened on its own. WhatsApp opens in a new tab on a
      // desktop and in place on a phone; Text only where sms: can work.
      const message = (useMarkdown) => buildCancelMessage({
        firstName:    b.first_name || 'Customer',
        phone:        formatPhoneDisplay(phoneDigits),
        barberName:   barber,
        serviceLabel: service,
        dateLabel:    dateLabelFromIso(b.booking_date),
        timeLabel:    minutesToLabel(hmsToMinutes(b.booking_time)),
        ref:          b.booking_id,
        useMarkdown,
      });
      const phone = canText();

      row.classList.add('is-cancelled');
      row.removeChild(btn);
      const done = el('div', 'cancel__done');
      const waLink = el('a', 'btn btn--mini', 'WhatsApp');
      waLink.href = messagingUrl('whatsapp', message(true));
      waLink.rel = 'noopener';
      if (!phone) waLink.target = '_blank';
      done.appendChild(waLink);
      if (phone) {
        const smsLink = el('a', 'btn btn--mini', 'Text');
        smsLink.href = messagingUrl('sms', message(false));
        done.appendChild(smsLink);
      }
      row.appendChild(done);
      waLink.focus();              // the Cancel button that had focus is gone

      setStatus(root, `Cancelled. Let ${barber || 'the shop'} know:`, 'ok');

      // The confirmation card may be showing this booking (booking-submit.js).
      document.dispatchEvent(new CustomEvent('booking:cancelled', { detail: {
        bookingId: b.booking_id, phone: phoneDigits, date: b.booking_date, time: b.booking_time,
      } }));

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
    markPhone(root, true);
    return;
  }
  markPhone(root, false);

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
    if (code === 'bad_phone') markPhone(root, true);
  } finally {
    const hadFocus = document.activeElement === button || document.activeElement === document.body;
    button.disabled = false;
    button.textContent = 'Find my booking';
    if (hadFocus) button.focus();  // disabling it mid-lookup dropped focus
  }
}

/* ---------- Boot ---------- */

export function initBookingCancel() {
  const root = document.querySelector('[data-cancel-root]');
  if (!root) return;

  const input = root.querySelector('[data-cancel-phone]');
  input.addEventListener('input', (e) => {
    if (input.getAttribute('aria-invalid') === 'true') markPhone(root, false);
    let digits = e.target.value.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    e.target.value = formatPhoneDisplay(digits.slice(0, 10));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); lookup(root); }
  });

  root.querySelector('[data-cancel-find]').addEventListener('click', () => lookup(root));

  const openPanel = () => {
    root.hidden = false;
    document.querySelectorAll('[data-cancel-open]').forEach(b => b.setAttribute('aria-expanded', 'true'));
    root.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
  };

  // "Cancel a booking" under a too-many-bookings error: open the panel with
  // the phone they just used and list its bookings.
  document.addEventListener('booking:cancel', (e) => {
    input.value = formatPhoneDisplay(cleanPhone(e.detail?.phone));
    openPanel();
    lookup(root);
  });

  // The reminder texts link to /#cancel: open the panel there, on load or
  // when the hash changes to it. (Without JS, #cancel is the fine print.)
  const fromHash = () => { if (location.hash === '#cancel') openPanel(); };
  window.addEventListener('hashchange', fromHash);
  fromHash();
  // The browser's own jump to the fragment during load blurs the field, so
  // focus it again once the page has loaded.
  if (document.readyState !== 'complete') window.addEventListener('load', fromHash, { once: true });
  // A #cancel link followed while the hash is already #cancel changes no
  // hash, so it opens the panel from the click.
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('a[href*="#cancel"]');
    if (!link || link.hash !== '#cancel' || link.pathname !== location.pathname || location.hash !== '#cancel') return;
    e.preventDefault();
    openPanel();
  });

  // The "Cancel a booking" disclosure in the booking fine print: opens the
  // panel and puts the cursor in Phone; a second tap closes it again.
  document.querySelectorAll('[data-cancel-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!root.hidden) {
        root.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      openPanel();
    });
  });
}
