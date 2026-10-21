// booking-return.js — the returning customer.
//
// After a booking (booking:booked from booking-submit.js) the customer's own
// choices stay in localStorage on this device: name, phone, barber, service,
// add-ons and the two text boxes. Guests are not kept, nor a replacement
// booked for someone else after a Move. On the next visit the
// form starts filled in with them, the card at the top of #book says so, the
// cancel panel has the phone, and the sticky bar reads "Rebook · <Barber>"
// with that barber's next open slot (cover.js). "Not you? Clear" forgets it all.
//
// Within one visit the card shows only until a booking is made: "Book
// another" gives a fresh form, as it always has. The next visit shows the
// new booking's choices.
//
// Barbers read late (booking-grid.js) can drop the saved barber after the
// form started on him: the picker moves to another, so the card and the
// sticky bar stop naming him for the rest of the visit. The saved record
// keeps him for a visit when he is back.

import { chooseBarber } from './booking-grid.js';
import { resetForm } from './booking-submit.js';
import { formatPhoneDisplay } from './booking-helpers.js';
import { SERVICE_LABELS, ADDON_LABELS } from './booking-messages.js';
import { getBarber } from './roster.js';

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
    || !getBarber(saved.barberSlug) || !SERVICE_LABELS[saved.serviceSlug]) return null;
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

/** "Same as last time: Hassan, Hair Cut + Beard, Wax." (no barber when his
 *  isn't on offer). */
export function sameAsLastTime(saved) {
  const barber = getBarber(saved.barberSlug);
  const addons = saved.addons.length ? ` + ${saved.addons.map(a => ADDON_LABELS[a]).join(', ')}` : '';
  return `Same as last time: ${barber ? `${barber.name}, ` : ''}${SERVICE_LABELS[saved.serviceSlug]}${addons}.`;
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

/** "Rebook · <Barber>", or the shipped label. The barber it names goes in
 *  data-rebook-barber, and booking:rebook-barber tells cover.js, so the time
 *  after it is that barber's next open slot, never another's. */
function setStickyLabel(saved) {
  const label = document.querySelector('[data-mobile-cta-label]');
  if (!label) return;
  label.dataset.label ??= label.textContent;
  const barber = saved && getBarber(saved.barberSlug);
  label.textContent = barber ? `Rebook · ${barber.name}` : label.dataset.label;
  const slug = barber ? barber.slug : '';
  if (slug === (label.dataset.rebookBarber || '')) return;
  if (slug) label.dataset.rebookBarber = slug;
  else delete label.dataset.rebookBarber;
  document.dispatchEvent(new CustomEvent('booking:rebook-barber'));
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

  // The barbers landed late without the saved barber: the form is on
  // another now, so nothing names him as the one being rebooked.
  document.addEventListener('booking:barbers', () => {
    if (!saved?.barberSlug || getBarber(saved.barberSlug)) return;
    saved = { ...saved, barberSlug: null };
    if (!card.hidden) renderCard(card, saved);
    setStickyLabel(saved);
  });

  document.addEventListener('booking:booked', (e) => {
    card.hidden = true;                // the confirmation is showing
    if (e.detail.forSomeoneElse) return;   // a moved guest's booking: the device's owner stays remembered
    saved = saveLastBooking(e.detail);
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
