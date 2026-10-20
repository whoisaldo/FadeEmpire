// booking-return.js — the returning customer.
//
// After a booking (booking:booked from booking-submit.js) the customer's own
// choices stay in localStorage on this device: name, phone, barber, service,
// add-ons and the two text boxes. Guests are not kept. On the next visit the
// form starts filled in with them, the card at the top of #book says so, the
// cancel panel has the phone, and the sticky bar reads "Rebook · <Barber>":
// a day, a time and Reserve rebook. "Not you? Clear" forgets it all.
//
// Within one visit the card shows only until a booking is made: "Book
// another" gives a fresh form, as it always has. The next visit shows the
// new booking's choices.

import { chooseBarber } from './booking-grid.js';
import { resetForm } from './booking-submit.js';
import { formatPhoneDisplay } from './booking-helpers.js';
import { SERVICE_LABELS, ADDON_LABELS } from './booking-messages.js';
import { BARBERS } from './config.js';

const KEY = 'fe.lastBooking';

/** The saved booking, or null. A record from an older release can name a
 *  barber or service that is gone (Javier retired): it is ignored. */
export function loadLastBooking() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(KEY));
  } catch (_) {
    return null;
  }
  if (!saved || typeof saved.name !== 'string' || !saved.name.trim()
    || !/^\d{10}$/.test(saved.phone || '')
    || !BARBERS[saved.barberSlug] || !SERVICE_LABELS[saved.serviceSlug]) return null;
  return { ...saved, addons: (saved.addons || []).filter(a => ADDON_LABELS[a]) };
}

/** Keep a booking for next time. Returns what was saved: null when this
 *  browser keeps nothing (storage off), so the page never claims otherwise. */
export function saveLastBooking({ name, phone, barberSlug, serviceSlug, addons, remindSms, rebookSms }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      name, phone, barberSlug, serviceSlug, addons, remindSms, rebookSms,
      savedAt: new Date().toISOString(),
    }));
  } catch (_) {
    return null;
  }
  return loadLastBooking();
}

export function clearLastBooking() {
  try { localStorage.removeItem(KEY); } catch (_) { /* nothing was kept */ }
}

/** "Same as last time: Hassan, Hair Cut + Beard, Wax." */
export function sameAsLastTime(saved) {
  const addons = saved.addons.length ? ` + ${saved.addons.map(a => ADDON_LABELS[a]).join(', ')}` : '';
  return `Same as last time: ${BARBERS[saved.barberSlug].name}, ${SERVICE_LABELS[saved.serviceSlug]}${addons}.`;
}

/* ---------- The page ---------- */

function renderCard(card, saved) {
  card.hidden = !saved;
  const text = card.querySelector('[data-rebook-text]');
  if (!saved) { text.textContent = ''; return; }
  const welcome = document.createElement('strong');
  welcome.textContent = `Welcome back, ${saved.name.trim().split(/\s+/)[0]}.`;
  text.replaceChildren(welcome, ` ${sameAsLastTime(saved)} Pick a day.`);
}

function setStickyLabel(saved) {
  const label = document.querySelector('[data-mobile-cta-label]');
  if (!label) return;
  label.dataset.label ??= label.textContent;
  label.textContent = saved ? `Rebook · ${BARBERS[saved.barberSlug].name}` : label.dataset.label;
}

/** The form as last time: barber, service, add-ons, name, phone, text boxes.
 *  The change events bring the included add-ons, the total and the
 *  "Something else" box along, as if chosen by hand. */
function prefill(form, saved) {
  chooseBarber(saved.barberSlug);
  form.querySelector('input[name="name"]').value = saved.name;
  form.querySelector('input[name="phone"]').value = formatPhoneDisplay(saved.phone);
  const select = form.querySelector('[data-service-select]');
  select.value = saved.serviceSlug;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  form.querySelectorAll('input[name="addons"]:not(:disabled)').forEach(input => {
    input.checked = saved.addons.includes(input.value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  form.querySelector('input[name="remind_sms"]').checked = saved.remindSms !== false;
  form.querySelector('input[name="rebook_sms"]').checked = saved.rebookSms === true;
}

/** Runs before initBookingGrid, so the grid starts on the saved barber. */
export function initBookingReturn() {
  const form = document.querySelector('[data-booking-form]');
  const card = document.querySelector('[data-rebook]');
  if (!form || !card) return;
  const cancelPhone = document.querySelector('[data-cancel-phone]');

  let saved = loadLastBooking();
  renderCard(card, saved);
  setStickyLabel(saved);
  if (saved) {
    prefill(form, saved);
    if (cancelPhone && !cancelPhone.value) cancelPhone.value = formatPhoneDisplay(saved.phone);
  }

  document.addEventListener('booking:booked', (e) => {
    saved = saveLastBooking(e.detail);
    card.hidden = true;                // the confirmation is showing
    setStickyLabel(saved);
  });

  card.querySelector('[data-rebook-clear]').addEventListener('click', () => {
    if (cancelPhone && saved && cancelPhone.value === formatPhoneDisplay(saved.phone)) cancelPhone.value = '';
    clearLastBooking();
    saved = null;
    resetForm(form);
    renderCard(card, null);
    setStickyLabel(null);
    // The button that had focus is gone: start at step 01, the barber.
    document.querySelector('[data-barber-option][aria-checked="true"]')?.focus({ preventScroll: true });
  });
}
