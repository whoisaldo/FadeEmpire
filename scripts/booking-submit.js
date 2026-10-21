// booking-submit.js — form submission + group-booking UI + the result cards.
//
// Flow:
//   1. Pre-validate (HTML5 + barber/slot selection + guest overrun).
//   2. Call book_slot or book_slot_group RPC.
//   3. On success: the booking exists. Show who is booked, when, the total,
//      and "Send your details to <barber>:" with WhatsApp (and Text where
//      sms: works) links to the prefilled message. Nothing opens by itself.
//   4. On a known DB answer (slot_taken, invalid_phone, too_many_active_bookings,
//      ...): show its message inline with its next step (pick another time,
//      fix the phone, cancel a booking). slot_taken must never fall back —
//      that would cause a double booking.
//   5. On a network or unknown failure: log to booking_errors and show the
//      amber card: the time isn't reserved, and the same send links carry the
//      request (with a ⚠ BOOKING SYSTEM ERROR prefix) to the barber. We don't
//      lose the customer to a transient backend hiccup.

import { bookSlot, bookSlotGroup, logBookingError, BookingError } from './booking-rpc.js';
import {
  getSelection, refreshAvailability as gridRefresh, clearTime, whenAvailable, setLocked, chooseBarber, selectDayFrom,
  isSlotTaken,
} from './booking-grid.js';
import {
  totalCents, formatTotal, formatPhoneDisplay, minutesToLabel,
  dateLabelFromIso, ERROR_MESSAGES, FALLBACK_CODES, hmsToMinutes, minutesToHms,
  includedAddons, isUnpricedService,
} from './booking-helpers.js';
import { buildBookingMessage, messagingUrl, serviceLine, ADDON_LABELS, SERVICE_LABELS } from './booking-messages.js';
import { buildIcs, icsDataUrl } from './booking-calendar.js';
import { validateBookingInput, partyFits, planParty } from './booking-validate.js';
import { SERVICE_PRICES_CENTS } from './config.js';
import { getBarber } from './roster.js';

const MAX_GUESTS = 5;          // primary + 5 guests = 6, book_slot_group's limit (too_many_people)

/* ---------- Reading the form ---------- */

/** The paid add-ons. Ones the service includes are shown checked but disabled. */
function readAddons(form) {
  return [...form.querySelectorAll('input[name="addons"]:checked:not(:disabled)')].map(i => i.value);
}

function readGuests(form) {
  return [...form.querySelectorAll('[data-guest]')]
    .map(row => ({
      name:        row.querySelector('[data-guest-name]').value.trim(),
      serviceSlug: row.querySelector('[data-guest-service]').value,
    }))
    .filter(g => g.name && g.serviceSlug);
}

function readGuestsRaw(form) {
  return [...form.querySelectorAll('[data-guest]')]
    .map(row => ({
      name:        row.querySelector('[data-guest-name]').value.trim(),
      serviceSlug: row.querySelector('[data-guest-service]').value,
    }));
}

/** Map the form's service value to the slug we book in the DB. */
function bookableService(service) {
  return service === 'custom' ? 'hair-cut' : service;
}

/** The primary's booking as the customer asked for it. "Something else" holds
 *  a hair-cut slot in the DB, but it is priced at the chair, so only its
 *  add-ons carry a price here. */
function asRequested(booking, service, addons) {
  if (!isUnpricedService(service)) return booking;
  return { ...booking, service_slug: service, total_price_cents: totalCents(service, addons) };
}

/* ---------- Add-ons the chosen service already includes ---------- */

function setIncluded(input, included) {
  const row   = input.closest('.booking__addon');
  const price = row?.querySelector('.t-mono');
  if (!row || !price || row.classList.contains('is-included') === included) return;
  if (included) {
    input.dataset.wasChecked = String(input.checked);   // restored when the service changes back
    price.dataset.price = price.textContent;
    price.textContent = 'included';
    input.checked = true;
  } else {
    input.checked = input.dataset.wasChecked === 'true';
    price.textContent = price.dataset.price;
  }
  input.disabled = included;
  row.classList.toggle('is-included', included);
}

function syncIncludedAddons(form) {
  const included = includedAddons(form.querySelector('[data-service-select]').value);
  form.querySelectorAll('input[name="addons"]').forEach(i => setIncluded(i, included.includes(i.value)));
}

/* ---------- Total + timeline updates + overrun check ---------- */

function updateTotal(form) {
  const primaryService = form.querySelector('[data-service-select]').value;
  const addons         = readAddons(form);
  let cents = totalCents(primaryService, addons);

  for (const g of readGuests(form)) {
    cents += SERVICE_PRICES_CENTS[g.serviceSlug] || 0;
  }

  form.querySelector('[data-total-display]').textContent = formatTotal(cents, isUnpricedService(primaryService));
}

const PAST_CLOSING = 'The last person would start after closing. Pick an earlier time or fewer people.';

/** Update the live timeline + return what keeps the party from fitting: ''
 *  when every person's chair time is inside working hours and free, else the
 *  line to show next to Reserve. A later person's time is free by the grid's
 *  own rule (a booking off the grid can overlap it while the start is open).
 *  Duration-aware: a service that spans more than one slot pushes the next
 *  guest back by that many slots (none do today — the VIP is 45 minutes —
 *  but the plan mirrors book_slot_group either way). */
function updateTimelineAndCheck(form) {
  const timelineEl = form.querySelector('[data-group-timeline]');
  if (!timelineEl) return '';

  const guests = readGuestsRaw(form);
  if (guests.length === 0) {
    timelineEl.hidden = true;
    return '';
  }

  const sel = getSelection();
  if (!sel.date || !sel.time) {
    timelineEl.hidden = false;
    timelineEl.removeAttribute('data-overrun');
    timelineEl.textContent = 'Pick a start time above to see the schedule.';
    return '';
  }

  const startMin    = hmsToMinutes(sel.time);
  const primaryName = (form.querySelector('input[name=name]').value || 'You').trim() || 'You';
  const primarySvc  = bookableService(form.querySelector('[data-service-select]').value || 'hair-cut');
  const services    = [primarySvc, ...guests.map(g => g.serviceSlug || 'hair-cut')];
  const names       = [primaryName, ...guests.map((g, i) => g.name || `Guest ${i + 1}`)];

  const plan = planParty(startMin, services);
  const { offenders, taken } = partyFits({
    date: sel.date, barberSlug: sel.barberSlug, startMin, services, isTaken: isSlotTaken,
  });
  const offenderSet = new Set(offenders);
  const takenSet    = new Set(taken);

  const lines = plan.map((p, i) =>
    `${names[i]} — ${minutesToLabel(p.startMin)}`
      + (offenderSet.has(i) ? '   ⚠ past closing' : takenSet.has(i) ? '   ⚠ already booked' : '')
  );
  timelineEl.textContent = lines.join('   ·   ');
  timelineEl.hidden = false;
  timelineEl.toggleAttribute('data-overrun', offenderSet.size + takenSet.size > 0);
  if (offenderSet.size) return PAST_CLOSING;
  if (takenSet.size) {
    const i = taken[0];
    return `${names[i]} would start at ${minutesToLabel(plan[i].startMin)}, which is already booked. Pick another start time.`;
  }
  return '';
}

/** Side-effect-y wrapper that also turns Reserve off while the party
 *  doesn't fit, and says why next to it. */
function updateTimeline(form) {
  const text = updateTimelineAndCheck(form);
  setFlag(form, 'overrun', Boolean(text));
  const note = form.querySelector('[data-overrun-note]');
  if (note && note.textContent !== text) note.textContent = text;
}

/* ---------- Guest add/remove ---------- */

function addGuest(form) {
  const list     = form.querySelector('[data-guest-list]');
  const template = form.querySelector('[data-guest-template]');
  const addBtn   = form.querySelector('[data-add-guest]');
  if (!list || !template || !addBtn) return;
  if (list.children.length >= MAX_GUESTS) return;

  const node = template.content.firstElementChild.cloneNode(true);
  const idx  = list.children.length + 1;
  node.querySelector('.booking__guest-label').textContent = idx === 1 ? 'Friend / Kid' : `Friend / Kid #${idx}`;
  list.appendChild(node);

  node.querySelector('[data-remove-guest]').addEventListener('click', () => {
    node.remove();
    relabelGuests(form);
    updateTotal(form);
    updateTimeline(form);
    addBtn.disabled = false;
    addBtn.focus();            // the removed row took focus with it
  });
  node.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input',  () => { updateTotal(form); updateTimeline(form); });
    el.addEventListener('change', () => { updateTotal(form); updateTimeline(form); });
  });

  if (list.children.length >= MAX_GUESTS) addBtn.disabled = true;

  updateTotal(form);
  updateTimeline(form);
  node.querySelector('[data-guest-name]').focus();
}

function relabelGuests(form) {
  [...form.querySelectorAll('[data-guest]')].forEach((row, i) => {
    row.querySelector('.booking__guest-label').textContent =
      i === 0 ? 'Friend / Kid' : `Friend / Kid #${i + 1}`;
  });
}

/* ---------- Error / success / fallback surfaces ---------- */

function hideMessages(form) {
  form.querySelector('[data-form-error]').hidden    = true;
  form.querySelector('[data-form-success]').hidden  = true;
  shown = null;                // the confirmation is gone, so nothing tracks it
  const fb = form.querySelector('[data-form-fallback]');
  if (fb) fb.hidden = true;
}

/** Say something through one of the always-present live regions. Emptied
 *  first, so the same message twice is announced twice. */
function announce(form, kind, text) {
  const region = form.querySelector(kind === 'alert' ? '[data-live-alert]' : '[data-live-status]');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 50);
}

/** Field errors: the control that needs fixing is marked invalid, described
 *  by the inline error, and focused. */
function clearInvalid(form) {
  const book = form.closest('#book') || document;
  book.querySelectorAll('[aria-invalid="true"]').forEach(el => {
    el.removeAttribute('aria-invalid');
    if (el.getAttribute('aria-describedby') === 'booking-error') el.removeAttribute('aria-describedby');
  });
}

function markInvalid(form, control, focusTarget = control) {
  clearInvalid(form);
  control.setAttribute('aria-invalid', 'true');
  control.setAttribute('aria-describedby', 'booking-error');
  focusTarget.focus();
}

/** The slot grid as the control to fix: marked as a group, focus on its
 *  first open time (on Retry while the times failed to load). */
function markSlotsInvalid(form) {
  const grid = document.querySelector('[data-slot-grid]');
  if (!grid) return;
  const first = grid.querySelector('.booking__slot:not([disabled])')
    || grid.querySelector('[data-slots-retry]')
    || document.querySelector('[data-day-row] .booking__day[aria-selected="true"]');
  markInvalid(form, grid, first || form.querySelector('[data-form-error]'));
}

/** Inline error. `action` is an optional { label, run } button under it.
 *  Focus goes to the error itself unless the caller marks a field. */
function showError(form, code, override, action = null) {
  hideMessages(form);
  clearInvalid(form);
  const el   = form.querySelector('[data-form-error]');
  const text = el.querySelector('[data-form-error-text]') || el;
  text.textContent = override || ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown;
  const btn = el.querySelector('[data-form-error-action]');
  if (btn) {
    btn.hidden = !action;
    btn.textContent = action ? action.label : '';
    btn.onclick = action ? action.run : null;
  }
  el.hidden = false;
  announce(form, 'alert', text.textContent);
  (action && btn ? btn : el).focus({ preventScroll: true });
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** A line in the error area that leaves the cards and focus where they are. */
function showNote(form, text) {
  const el = form.querySelector('[data-form-error]');
  el.querySelector('[data-form-error-text]').textContent = text;
  const btn = el.querySelector('[data-form-error-action]');
  btn.hidden = true;
  btn.onclick = null;
  el.hidden = false;
  announce(form, 'status', text);
}

/** The control a client-side refusal is about. */
function controlForCheck(form, code) {
  switch (code) {
    case 'bad_name':   return form.querySelector('input[name="name"]');
    case 'bad_phone':  return form.querySelector('input[name="phone"]');
    case 'no_service': return form.querySelector('[data-service-select]');
    case 'no_barber':  return document.querySelector('[data-barber-option]');
    case 'incomplete_guests':
      return [...form.querySelectorAll('[data-guest-name], [data-guest-service]')].find(el => !el.value.trim());
    default:           return null;
  }
}

// Known DB answers that are about the chosen time: the fix is another slot.
const PICK_ANOTHER_TIME = new Set(['slot_taken', 'outside_hours', 'store_closed', 'closed', 'bad_slot', 'bad_date']);
// Known DB answers about one field: the fix is that field.
const FIELD_FOR_CODE = {
  bad_phone:         'input[name="phone"]',
  bad_name:          'input[name="name"]',
  service_not_found: '[data-service-select]',
  invalid_people:    '[data-guest-name]',
  too_many_people:   '[data-guest-name]',
};

/** Show a known DB answer inline and set up its next step. */
async function showKnownError(form, code, phone) {
  if (code === 'too_many') {
    showError(form, code, null, {
      label: 'Cancel a booking',
      run: () => document.dispatchEvent(new CustomEvent('booking:cancel', { detail: { phone } })),
    });
    return;
  }
  showError(form, code);
  if (PICK_ANOTHER_TIME.has(code)) {
    clearTime();             // keep the day so the next tap on a time is enough
    await gridRefresh();
    markSlotsInvalid(form);
    return;
  }
  const field = FIELD_FOR_CODE[code] && form.querySelector(FIELD_FOR_CODE[code]);
  if (field) markInvalid(form, field);
}

/** Where an sms: link can open something: phones and tablets. */
export function canText() {
  return window.matchMedia('(pointer: coarse)').matches
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** "Send your details to <barber>:" with plain links to the prefilled
 *  message. On a phone they navigate in place, which hands off to WhatsApp
 *  or Messages; on a desktop WhatsApp opens in a new tab and Text is left
 *  out, since sms: has nothing to open there. */
function fillSend(card, { barberName, whatsapp, sms }) {
  const phone = canText();
  card.querySelector('[data-send-head]').textContent = `Send your details to ${barberName}:`;
  const wa = card.querySelector('[data-send-whatsapp]');
  wa.href = whatsapp;
  if (phone) wa.removeAttribute('target'); else wa.target = '_blank';
  const text = card.querySelector('[data-send-sms]');
  text.href = sms;
  text.hidden = !phone;
}

/** "Add to calendar": the .ics for what the card shows, `file` being
 *  { name, href } (or null once nothing is left on it). */
function fillCalendar(card, file) {
  const link = card.querySelector('[data-add-calendar]');
  if (!link) return;
  link.hidden = !file;
  if (!file) return;
  link.href = file.href;
  link.download = file.name;
}

/** The confirmation: who is booked, for what, at what time, the total, and
 *  how the barber gets the details. `people` is [{ name, service, time }]. */
function showSuccess(form, { text, people, total, next, send, calendar }) {
  hideMessages(form);
  const card = form.querySelector('[data-form-success]');
  setCardCancelled(card, false);
  card.querySelector('[data-success-text]').textContent = text;
  card.querySelector('[data-success-list]').replaceChildren(...people.map(p => {
    const li = document.createElement('li');
    li.textContent = `${p.name} · ${p.service} · ${p.time}`;
    li.dataset.bookingId = p.id;
    return li;
  }));
  card.querySelector('[data-success-total]').textContent = total;
  card.querySelector('[data-success-next]').textContent = next;
  fillSend(card, send);
  fillCalendar(card, calendar);
  card.querySelector('[data-book-another]').hidden = false;   // a Move may have hidden it
  revealCard(form, card, next);
}

/** The confirmation once everything on it is cancelled: "Cancelled.", what
 *  it was, and no total, next step or send links. */
function setCardCancelled(card, on) {
  const head = card.querySelector('[data-success-head]');
  head.textContent = on ? 'Cancelled.' : 'Chair reserved';
  head.classList.toggle('tone-gold', !on);
  card.querySelectorAll('.booking__success-total, [data-success-next], .booking__send, [data-add-calendar]')
    .forEach(el => { el.hidden = on; });
}

// The booking the confirmation card shows, so a cancel from the panel below
// can update it: { barberSlug, phone, date, rows, cancelled: Set of ids,
// send(rows), calendar(rows) }. Kept while the card is on screen, also after
// a Move has opened the form again; cleared when the card is hidden.
let shown = null;

/** A booking was cancelled in the panel. If the card shows it, that person
 *  is struck off the card, the total and the message to the barber; once
 *  nobody is left the card says "Cancelled." and a locked form opens again
 *  as after "Book another", leaving focus and the cancel status where they are.
 *  A Move opens the form itself (moveBooking), after it has read the name and phone. */
function onCancelled(form, { bookingId, barberSlug, phone, date, time, move = false } = {}) {
  if (!shown) return;
  // The booking id first; otherwise the same barber, phone, day and time (one
  // barber's slot holds one booking, so that is the same booking too).
  const open = shown.rows.filter(b => b.booking_id && !shown.cancelled.has(b.booking_id));
  const hit = (bookingId && open.find(b => b.booking_id === bookingId))
    || open.find(b => barberSlug === shown.barberSlug && phone === shown.phone
      && date === shown.date && b.booking_time === time);
  if (!hit) return;
  shown.cancelled.add(hit.booking_id);
  const card = form.querySelector('[data-form-success]');
  const left = shown.rows.filter(b => !shown.cancelled.has(b.booking_id));
  if (!left.some(b => b.booking_id)) {
    setCardCancelled(card, true);
    if (form.dataset.booked === 'true' && !move) unlock(form);
    return;
  }
  const li = card.querySelector(`[data-success-list] li[data-booking-id="${hit.booking_id}"]`);
  if (li) li.textContent += ' · Cancelled';
  card.querySelector('[data-success-total]').textContent = formatTotal(
    left.reduce((sum, b) => sum + b.total_price_cents, 0), left.some(b => isUnpricedService(b.service_slug)));
  fillSend(card, shown.send(left));
  fillCalendar(card, shown.calendar(left));
}

function showFallback(form, { text, send }) {
  hideMessages(form);
  const card = form.querySelector('[data-form-fallback]');
  card.querySelector('[data-fallback-text]').textContent = text;
  fillSend(card, send);
  revealCard(form, card, `Not reserved yet. ${text}`);
}

/** Show a result card, put keyboard focus on it, and announce it. */
function revealCard(form, card, announcement) {
  clearInvalid(form);
  card.hidden = false;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  announce(form, 'status', announcement);
}

/* ---------- Reserve button state ---------- */

/** Reserve is off while a request is in flight, while the party runs past
 *  closing, and after a booking until "Book another". */
function setFlag(form, key, on) {
  form.dataset[key] = on ? 'true' : 'false';
  const off = ['busy', 'overrun', 'booked'].some(k => form.dataset[k] === 'true');
  form.querySelectorAll('[data-submit]').forEach(b => { b.disabled = off; });
}

/** A request in flight: Reserve off, and the picker locked as under a
 *  confirmation, so barbers read meanwhile wait (booking-grid.js) and can't
 *  take down the confirmation the request comes back with. */
function setBusy(form, on) {
  setFlag(form, 'busy', on);
  setLocked(on);
}

/** Booked: Reserve off, and the picker and every field locked so nothing on
 *  screen can change under the confirmation, until "Book another". */
function setBooked(form, on) {
  setFlag(form, 'booked', on);
  setLocked(on);
  form.querySelectorAll('[data-selected-pill], .booking__grid').forEach(el => el.toggleAttribute('inert', on));
}

/* ---------- Submit ---------- */

async function submit(form) {
  if (form.dataset.busy === 'true' || form.dataset.booked === 'true') return;

  // 1. Validation below covers every required field and names it inline
  //    (the form is novalidate, so no browser bubble competes with it).
  hideMessages(form);

  // 2. Disable Reserve immediately to slam the double-tap window shut.
  setBusy(form, true);

  // 3. Read form data + selection, then validate as one unit.
  const sel = getSelection();
  const fd = new FormData(form);
  const name    = (fd.get('name') || '').toString().trim();
  const phone   = (fd.get('phone') || '').toString().trim();
  const service = (fd.get('service') || '').toString();
  const notes   = (fd.get('notes') || '').toString().trim();
  const custom  = (fd.get('custom_request') || '').toString().trim();
  const addons  = readAddons(form);
  const guests  = readGuests(form);
  const guestsRaw = readGuestsRaw(form);
  const remindSms = form.querySelector('input[name="remind_sms"]').checked;
  const rebookSms = form.querySelector('input[name="rebook_sms"]').checked;

  const check = validateBookingInput({
    name, phone, serviceSlug: service,
    date: sel.date, time: sel.time, barberSlug: sel.barberSlug,
    guests: guestsRaw,
  });
  if (!check.ok) {
    setBusy(form, false);
    // No time because the times never loaded: picking a day won't help, Retry will.
    const unread = check.code === 'no_slot' && document.querySelector('[data-slots-retry]');
    showError(form, check.code, unread ? "Open times haven't loaded yet. Tap Retry above." : check.message);
    if (check.code === 'no_slot') {
      markSlotsInvalid(form);
    } else {
      const control = controlForCheck(form, check.code);
      if (control) markInvalid(form, control);
    }
    return;
  }
  // Recheck the party — UI should have prevented this already, but verify.
  const unfit = updateTimelineAndCheck(form);
  if (unfit) {
    setBusy(form, false);
    showError(form, 'outside_hours', unfit === PAST_CLOSING
      ? 'One of your party runs past closing time. Pick an earlier start.' : unfit);
    markSlotsInvalid(form);
    return;
  }

  const barber     = getBarber(sel.barberSlug);
  const barberName = barber ? barber.name : 'the shop';

  // 4. Call the appropriate RPC
  let bookings;        // unified array of person bookings
  let rpcError = null;
  const primaryServiceSlug = bookableService(service);
  try {
    if (guests.length === 0) {
      const rows = await bookSlot({
        barberSlug: sel.barberSlug,
        serviceSlug: primaryServiceSlug,
        date: sel.date,
        time: sel.time,
        name,
        phone,
        addons,
        notes,
        customRequest: service === 'custom' ? custom : null,
        source: 'web',
        holdMinutes: 15,
        remindSms,
        rebookSms,
      });
      // book_slot returns N rows; row 0 is primary, rows 1+ are linked continuation slots.
      const primary = rows[0] || {};
      bookings = rows.map((r, i) => ({
        booking_id:        i === 0 ? primary.booking_id : null,
        person_name:       name,
        service_slug:      service,
        booking_time:      r.booking_time,
        total_price_cents: i === 0 ? primary.total_price_cents : 0,
        addons:            i === 0 ? addons : [],
        slot_index:        r.slot_index ?? i,
        person_index:      0,
      }));
      bookings[0] = asRequested(bookings[0], service, addons);
    } else {
      const people = [
        {
          name,
          serviceSlug: primaryServiceSlug,
          addons,
          notes: notes || null,
          customRequest: service === 'custom' ? custom : null,
        },
        ...guests.map(g => ({ name: g.name, serviceSlug: g.serviceSlug, addons: [] })),
      ];
      const rows = await bookSlotGroup({
        barberSlug: sel.barberSlug,
        date:      sel.date,
        startTime: sel.time,
        phone,
        people,
        source: 'web',
        holdMinutes: 15,
        remindSms,
        rebookSms,
      });
      bookings = rows.map(r => {
        const b = {
          booking_id:        r.booking_id,
          person_name:       r.person_name,
          service_slug:      r.service_slug,
          booking_time:      r.booking_time,
          total_price_cents: r.total_price_cents,
          addons:            r.person_index === 0 ? addons : [],
          person_index:      r.person_index,
        };
        return r.person_index === 0 ? asRequested(b, service, addons) : b;
      });
    }
  } catch (err) {
    rpcError = err;
  }

  // 5. Context shared by the success and fallback paths: the prefilled
  //    message in both flavours (WhatsApp markdown, plain text).
  const dateLabel = dateLabelFromIso(sel.date);
  const sendLinks = (rows, extra = {}) => {
    const build = (useMarkdown) => buildBookingMessage({
      name, phone: formatPhoneDisplay(phone), barberName, dateLabel, bookings: rows, notes,
      customRequest: service === 'custom' ? custom : null, useMarkdown, ...extra,
    });
    return { barberName, whatsapp: messagingUrl('whatsapp', build(true)), sms: messagingUrl('sms', build(false)) };
  };

  /* ===== ERROR PATH ===== */
  if (rpcError) {
    const code = (rpcError instanceof BookingError) ? rpcError.code : 'unknown';
    const cause = rpcError && rpcError.cause;
    const logError = () => logBookingError({
      code:    code,
      message: cause && cause.message ? cause.message : (rpcError.message || ''),
      details: cause && cause.details ? cause.details : '',
      attempted: {
        date: sel.date, time: sel.time, barber: sel.barberSlug,
        service, addons, guests, notes,
        name, phone_last4: phone.replace(/\D/g, '').slice(-4),
        is_group: guests.length > 0,
      },
      user_agent: navigator.userAgent,
      source: 'web',
    });

    // 5a. A known answer from the DB: inline, with its own next step. Never
    //     a messaging fallback (for slot_taken that would double-book).
    if (!FALLBACK_CODES.has(code)) {
      if (code !== 'slot_taken') logError();
      setBusy(form, false);
      await showKnownError(form, code, phone);
      return;
    }

    // 5b. Network or unknown failure: log to booking_errors, then offer the
    //     request as a message to the barber. We don't lose customers to
    //     transient backend hiccups, and we don't claim the slot is held.
    logError();

    // Build "pending-ref" so the shop can correlate manual confirmations.
    const pendingRef = 'pending-' +
      (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 8);

    // Reconstruct a bookings-shaped array from the form data for message
    // building — duration-aware so the times match what was attempted, and
    // priced exactly like the on-page total (service + paid add-ons).
    const services = [primaryServiceSlug, ...guests.map(g => g.serviceSlug)];
    const plan     = planParty(hmsToMinutes(sel.time), services);
    const fakeBookings = plan.map((p, i) => ({
      person_name:       i === 0 ? name : guests[i - 1].name,
      service_slug:      i === 0 ? service : guests[i - 1].serviceSlug,
      booking_time:      minutesToHms(p.startMin),
      total_price_cents: i === 0 ? totalCents(service, addons) : totalCents(p.serviceSlug),
      addons:            i === 0 ? addons : [],
      booking_id:        i === 0 ? pendingRef : `${pendingRef}-g${i}`,
    }));

    showFallback(form, {
      text: `Couldn't reach the booking system, so this time isn't reserved yet. ${barberName} will reply to confirm once your details arrive.`,
      send: sendLinks(fakeBookings, { systemError: true, errorCode: code }),
    });
    setBusy(form, false);
    return;
  }

  /* ===== SUCCESS PATH ===== */
  const total = bookings.reduce((s, b) => s + b.total_price_cents, 0);
  const unpriced = bookings.some(b => isUnpricedService(b.service_slug));
  const detail = (b) => serviceLine(b.service_slug, custom)
    + (b.addons.length ? ` + ${b.addons.map(a => ADDON_LABELS[a] || a).join(', ')}` : '');
  // One line per person; a multi-slot service's continuation rows have no id.
  const people = bookings.filter(b => b.booking_id).map(b => ({
    id:      b.booking_id,
    name:    b.person_name,
    service: detail(b),
    time:    minutesToLabel(hmsToMinutes(b.booking_time)),
  }));
  // The calendar event runs from the first start to one slot after the last.
  const calendar = (rows) => {
    const booked = rows.filter(b => b.booking_id);
    if (!booked.length) return null;
    return {
      name: `fade-empire-${sel.date}.ics`,
      href: icsDataUrl(buildIcs({
        uid: booked[0].booking_id, date: sel.date, barberName,
        people: booked.map(b => ({
          name: b.person_name, service: SERVICE_LABELS[b.service_slug] || b.service_slug,
          detail: detail(b), time: b.booking_time,
        })),
        lastStart: rows.map(b => b.booking_time).sort().pop(),
      })),
    };
  };

  // The booking already exists; the message is how the barber gets the details.
  showSuccess(form, {
    text: `${dateLabel} · ${barberName}`,
    people,
    total: formatTotal(total, unpriced),
    next: `${people.length > 1 ? 'Your chairs are reserved.' : 'Your chair is reserved.'} Send the message so ${barberName} has your details and can reply to confirm.`,
    send: sendLinks(bookings),
    calendar: calendar(bookings),
  });
  shown = {
    barberSlug: sel.barberSlug, phone: phone.replace(/\D/g, '').slice(-10), date: sel.date,
    rows: bookings, cancelled: new Set(), send: sendLinks, calendar,
  };

  // The form stays as submitted next to the confirmation, and Reserve stays
  // off, until "Book another". The picker stays locked from the request on.
  form.dataset.busy = 'false';
  setBooked(form, true);

  // The customer's own choices, for next time (booking-return.js). Guests aren't kept.
  const forSomeoneElse = movedFor === 'someone-else';
  movedFor = null;
  document.dispatchEvent(new CustomEvent('booking:booked', { detail: {
    name, phone: phone.replace(/\D/g, '').slice(-10), barberSlug: sel.barberSlug,
    serviceSlug: service, addons, remindSms, rebookSms, forSomeoneElse,
  } }));
}

/** After a shortcut has filled part of the booking (Book with Hassan, Book
 *  the VIP, Reserve it, Take it): focus the next step still to do, so Tab
 *  carries on from there. Times take focus only once availability is read,
 *  and not at all if the customer has focused something else meanwhile. */
async function focusNextStep(form) {
  if (form.dataset.booked === 'true') {          // locked: the confirmation is the next step
    const card = form.querySelector('[data-form-success]');
    card.focus({ preventScroll: true });
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  // Nobody books online: the next step is the line with the shop's phone.
  const offline = document.querySelector('#book[data-no-barbers] [data-no-barbers-note]');
  if (offline) {
    offline.focus({ preventScroll: true });
    offline.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const tapped = document.activeElement;
  await whenAvailable();
  if (![tapped, document.body].includes(document.activeElement)) return;   // the customer moved on
  const sel = getSelection();
  const target = !sel.time
    ? document.querySelector('[data-slot-grid] .booking__slot:not([disabled])')
      || document.querySelector('[data-slots-retry]')
      || document.querySelector('[data-day-row] .booking__day[aria-selected="true"]')
    : ['input[name="name"]', 'input[name="phone"]', '[data-service-select]']
        .map(q => form.querySelector(q)).find(el => el && !el.value.trim())
      || form.querySelector('[data-submit]');
  if (!target) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Whose booking the last Move opened the form for: 'own', 'someone-else'
// (a guest, a child), or null. Someone else's replacement is booked under
// their name and never becomes the remembered customer (booking-return.js).
let movedFor = null;

/** Whether a moved booking is someone else's: a guest line on the card, or a
 *  first name other than the card's primary (or, with no card, the name typed). */
function movingSomeoneElse(bookingId, firstName, typedName) {
  const onCard = shown && bookingId && shown.rows.find(b => b.booking_id === bookingId);
  if (onCard) return onCard.person_index !== 0;
  const primary = shown?.rows.find(b => b.person_index === 0)?.person_name || typedName;
  const first = (n) => String(n || '').trim().split(/\s+/)[0].toLowerCase();
  return Boolean(primary && firstName && first(primary) !== first(firstName));
}

/** "Move it" in the cancel panel: the old booking is cancelled (and struck
 *  off the confirmation, if it is on it). A locked form opens again the way
 *  "Book another" opens it, the card staying as the record; then the form
 *  takes the booking's barber, service and add-ons, keeps the name and phone
 *  (filled from the lookup when empty) and the two text boxes as the customer
 *  left them, and focus goes to the day row for a new time:
 *  the booking's own day if it still has an open time, otherwise the next.
 *  The add-ons come from the lookup, else from the card's line for the
 *  booking; with neither, the error area says to tick them again. */
async function moveBooking(form, { bookingId, barberSlug, serviceSlug, date, firstName, phone, addons } = {}) {
  // What the customer typed wins over the lookup's first name and phone,
  // unless the booking is someone else's: then it goes under their name.
  const name = form.querySelector('input[name="name"]');
  const tel  = form.querySelector('input[name="phone"]');
  const typedName = name.value.trim() ? name.value : '';
  const typedTel  = tel.value.trim() ? tel.value : '';
  const someoneElse = movingSomeoneElse(bookingId, firstName, typedName);
  const onCard = shown && bookingId && shown.rows.find(b => b.booking_id === bookingId);
  const carried = Array.isArray(addons) ? addons : onCard ? onCard.addons : null;
  // The text boxes are the customer's own choice: opening the form must not
  // reset them to their defaults.
  const remind = form.querySelector('input[name="remind_sms"]');
  const rebook = form.querySelector('input[name="rebook_sms"]');
  const consent = { remind: remind.checked, rebook: rebook.checked };
  if (form.dataset.booked === 'true') unlock(form);
  // The card stays as the record, without "Book another": it would empty
  // the form this Move has just filled in.
  form.querySelector('[data-form-success] [data-book-another]').hidden = true;
  remind.checked = consent.remind;
  rebook.checked = consent.rebook;
  movedFor = someoneElse ? 'someone-else' : 'own';
  // One fresh read for the freed slot: a new barber's is already on its way.
  const sameBarber = getSelection().barberSlug === barberSlug;
  chooseBarber(barberSlug);
  if (sameBarber) gridRefresh();
  const select = form.querySelector('[data-service-select]');
  if (serviceSlug && select.querySelector(`option[value="${serviceSlug}"]`)) {
    select.value = serviceSlug;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Ones the service includes stay as it shows them (checked, disabled).
  form.querySelectorAll('input[name="addons"]:not(:disabled)').forEach(input => {
    input.checked = Boolean(carried?.includes(input.value));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (!carried) showNote(form, "Add-ons weren't carried over. Tick them again.");
  name.value = someoneElse ? firstName : (typedName || firstName || '');
  tel.value  = typedTel || (phone ? formatPhoneDisplay(phone) : '');

  const selectedDay = () => document.querySelector('[data-day-row] .booking__day[aria-selected="true"]')
    || document.querySelector('[data-day-row] .booking__day:not([disabled])');
  const settled = selectDayFrom(date);          // the booking's day now, checked once read
  const first = selectedDay();
  if (!first) return;
  first.focus({ preventScroll: true });
  first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await settled;
  // A full day moved the selection on: focus follows unless the customer moved it.
  const now = selectedDay();
  if (now === first || ![first, document.body].includes(document.activeElement)) return;
  now.focus({ preventScroll: true });
  now.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Out of the booked state: the picker and fields open and emptied. */
function unlock(form) {
  setBooked(form, false);
  resetForm(form);
}

/** Every field back to its default, no guests, no time picked. */
export function resetForm(form) {
  movedFor = null;
  form.reset();
  form.querySelectorAll('[data-guest]').forEach(row => row.remove());
  form.querySelector('[data-add-guest]').disabled = false;
  form.querySelectorAll('input[name="addons"]').forEach(i => { i.dataset.wasChecked = 'false'; });
  syncCustomField(form);       // reset() fires no change event
  syncIncludedAddons(form);
  clearTime();
  updateTotal(form);
  updateTimeline(form);
}

/** "Book another": a fresh form, and a grid that shows the slots just taken. */
function startOver(form) {
  unlock(form);
  hideMessages(form);
  gridRefresh();
  // The card that had focus is gone: start again at step 01, the barber.
  const start = document.querySelector('[data-barber-option][aria-checked="true"]')
    || document.querySelector('[data-barber-option]')
    || document.querySelector('[data-day-row] .booking__day:not([disabled])');
  if (start) {
    start.focus({ preventScroll: true });
    start.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/* ---------- Phone formatting + custom toggle ---------- */

function bindPhoneFormatter(form) {
  const input = form.querySelector('[data-phone-input]');
  if (!input) return;
  input.addEventListener('input', (e) => {
    // Accept leading 1 (US country code) but normalize to 10 digits for display.
    let digits = e.target.value.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    digits = digits.slice(0, 10);
    e.target.value = formatPhoneDisplay(digits);
  });
}

/** Show the "what are you after?" box only while the service is "custom". */
function syncCustomField(form) {
  const select      = form.querySelector('[data-service-select]');
  const customField = form.querySelector('[data-custom-field]');
  if (!select || !customField) return;
  customField.hidden = select.value !== 'custom';
}

function bindCustomToggle(form) {
  form.querySelector('[data-service-select]')?.addEventListener('change', () => syncCustomField(form));
  syncCustomField(form);
}

/* ---------- Boot ---------- */

export function initBookingSubmit() {
  const form = document.querySelector('[data-booking-form]');
  if (!form) return;

  bindPhoneFormatter(form);
  bindCustomToggle(form);

  form.querySelector('[data-service-select]').addEventListener('change', () => {
    syncIncludedAddons(form); updateTotal(form); updateTimeline(form);
  });
  form.querySelectorAll('input[name="addons"]').forEach(i =>
    i.addEventListener('change', () => updateTotal(form))
  );
  form.querySelector('input[name="name"]').addEventListener('input', () => updateTimeline(form));

  form.querySelector('[data-add-guest]').addEventListener('click', () => addGuest(form));
  form.querySelector('[data-book-another]')?.addEventListener('click', () => startOver(form));

  // "Book the VIP" and the service rows of the price list: the service is
  // chosen (and totalled), then the page moves to the next step still to do
  // instead of the bare #book. Nobody books online: the rows call the shop,
  // through the phone line's own tel: link.
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-book-service]');
    if (!link) return;
    e.preventDefault();
    const call = document.querySelector('#book[data-no-barbers] [data-no-barbers-note] a');
    if (call) { call.click(); return; }
    if (form.dataset.booked === 'true') { focusNextStep(form); return; }
    const select = form.querySelector('[data-service-select]');
    select.value = link.dataset.bookService;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    focusNextStep(form);
  });
  // An add-on row in the price list ticks (or unticks) that add-on and moves
  // on the same way. One the service already includes stays included.
  document.addEventListener('click', (e) => {
    const row = e.target.closest?.('[data-book-addon]');
    if (!row) return;
    const input = form.querySelector(`input[name="addons"][value="${row.dataset.bookAddon}"]`);
    if (input && !input.disabled && form.dataset.booked !== 'true') {
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    focusNextStep(form);
  });
  document.addEventListener('booking:focus-next', () => focusNextStep(form));
  document.addEventListener('booking:cancelled', (e) => onCancelled(form, e.detail));
  document.addEventListener('booking:move', (e) => moveBooking(form, e.detail));

  document.addEventListener('booking:selected', (e) => {
    updateTimeline(form);
    const grid = document.querySelector('[data-slot-grid]');
    if (e.detail?.time && grid?.getAttribute('aria-invalid') === 'true') clearInvalid(form);
  });
  // Editing a field marked invalid clears the mark.
  form.addEventListener('input', (e) => {
    if (e.target.getAttribute?.('aria-invalid') === 'true') {
      e.target.removeAttribute('aria-invalid');
      e.target.removeAttribute('aria-describedby');
    }
  });

  updateTotal(form);
  updateTimeline(form);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(form);
  });
}
