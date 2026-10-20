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
import { getSelection, refreshAvailability as gridRefresh, clearTime } from './booking-grid.js';
import {
  totalCents, formatTotal, formatPhoneDisplay, minutesToLabel,
  dateLabelFromIso, ERROR_MESSAGES, FALLBACK_CODES, hmsToMinutes, minutesToHms,
  includedAddons, isUnpricedService,
} from './booking-helpers.js';
import { buildBookingMessage, messagingUrl, serviceLine, ADDON_LABELS } from './booking-messages.js';
import { validateBookingInput, partyFits, planParty } from './booking-validate.js';
import { SERVICE_PRICES_CENTS, BARBERS } from './config.js';

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

/** Update the live timeline + return true if every person's chair time fits
 *  working hours. Duration-aware: a service that spans more than one slot
 *  pushes the next guest back by that many slots (none do today — the VIP is
 *  45 minutes — but the plan mirrors book_slot_group either way). */
function updateTimelineAndCheckOverrun(form) {
  const timelineEl = form.querySelector('[data-group-timeline]');
  if (!timelineEl) return true;

  const guests = readGuestsRaw(form);
  if (guests.length === 0) {
    timelineEl.hidden = true;
    return true;
  }

  const sel = getSelection();
  if (!sel.date || !sel.time) {
    timelineEl.hidden = false;
    timelineEl.removeAttribute('data-overrun');
    timelineEl.textContent = 'Pick a start time above to see the schedule.';
    return true;
  }

  const startMin    = hmsToMinutes(sel.time);
  const primaryName = (form.querySelector('input[name=name]').value || 'You').trim() || 'You';
  const primarySvc  = bookableService(form.querySelector('[data-service-select]').value || 'hair-cut');
  const services    = [primarySvc, ...guests.map(g => g.serviceSlug || 'hair-cut')];
  const names       = [primaryName, ...guests.map((g, i) => g.name || `Guest ${i + 1}`)];

  const plan = planParty(startMin, services);
  const { offenders } = partyFits({
    date: sel.date, barberSlug: sel.barberSlug, startMin, services,
  });
  const offenderSet = new Set(offenders);

  const lines = plan.map((p, i) =>
    `${names[i]} — ${minutesToLabel(p.startMin)}${offenderSet.has(i) ? '   ⚠ past closing' : ''}`
  );
  timelineEl.textContent = lines.join('   ·   ');
  timelineEl.hidden = false;
  timelineEl.toggleAttribute('data-overrun', offenderSet.size > 0);
  return offenderSet.size === 0;
}

/** Side-effect-y wrapper that also turns Reserve off while the party overruns. */
function updateTimeline(form) {
  setFlag(form, 'overrun', !updateTimelineAndCheckOverrun(form));
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
  const fb = form.querySelector('[data-form-fallback]');
  if (fb) fb.hidden = true;
}

/** Inline error. `action` is an optional { label, run } button under it. */
function showError(form, code, override, action = null) {
  hideMessages(form);
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
    return;
  }
  const field = FIELD_FOR_CODE[code] && form.querySelector(FIELD_FOR_CODE[code]);
  if (field) field.focus();
}

/** Where an sms: link can open something: phones and tablets. */
function canText() {
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

/** The confirmation: who is booked, for what, at what time, the total, and
 *  how the barber gets the details. `people` is [{ name, service, time }]. */
function showSuccess(form, { text, people, total, next, send }) {
  hideMessages(form);
  const card = form.querySelector('[data-form-success]');
  card.querySelector('[data-success-text]').textContent = text;
  card.querySelector('[data-success-list]').replaceChildren(...people.map(p => {
    const li = document.createElement('li');
    li.textContent = `${p.name} · ${p.service} · ${p.time}`;
    return li;
  }));
  card.querySelector('[data-success-total]').textContent = total;
  card.querySelector('[data-success-next]').textContent = next;
  fillSend(card, send);
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showFallback(form, { text, send }) {
  hideMessages(form);
  const card = form.querySelector('[data-form-fallback]');
  card.querySelector('[data-fallback-text]').textContent = text;
  fillSend(card, send);
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- Reserve button state ---------- */

/** Reserve is off while a request is in flight, while the party runs past
 *  closing, and after a booking until "Book another". */
function setFlag(form, key, on) {
  form.dataset[key] = on ? 'true' : 'false';
  const off = ['busy', 'overrun', 'booked'].some(k => form.dataset[k] === 'true');
  form.querySelectorAll('[data-submit]').forEach(b => { b.disabled = off; });
}

/* ---------- Submit ---------- */

async function submit(form) {
  if (form.dataset.busy === 'true' || form.dataset.booked === 'true') return;

  // 1. Pre-flight HTML5 validation — surface required-field errors cleanly
  //    before we hit the RPC.
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  hideMessages(form);

  // 2. Disable Reserve immediately to slam the double-tap window shut.
  setFlag(form, 'busy', true);

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

  const check = validateBookingInput({
    name, phone, serviceSlug: service,
    date: sel.date, time: sel.time, barberSlug: sel.barberSlug,
    guests: guestsRaw,
  });
  if (!check.ok) {
    showError(form, check.code, check.message);
    setFlag(form, 'busy', false);
    return;
  }
  // Recheck guest overrun — UI should have prevented this already, but verify.
  if (!updateTimelineAndCheckOverrun(form)) {
    showError(form, 'outside_hours', 'One of your party runs past closing time. Pick an earlier start.');
    setFlag(form, 'busy', false);
    return;
  }

  const barber     = BARBERS[sel.barberSlug];
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
      });
      bookings = rows.map(r => {
        const b = {
          booking_id:        r.booking_id,
          person_name:       r.person_name,
          service_slug:      r.service_slug,
          booking_time:      r.booking_time,
          total_price_cents: r.total_price_cents,
          addons:            r.person_index === 0 ? addons : [],
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
      await showKnownError(form, code, phone);
      setFlag(form, 'busy', false);
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
      text: `Couldn't reach the booking system, so this time isn't reserved yet. ${barberName} will reply to confirm once he has your details.`,
      send: sendLinks(fakeBookings, { systemError: true, errorCode: code }),
    });
    setFlag(form, 'busy', false);
    return;
  }

  /* ===== SUCCESS PATH ===== */
  const total = bookings.reduce((s, b) => s + b.total_price_cents, 0);
  const unpriced = bookings.some(b => isUnpricedService(b.service_slug));
  // One line per person; a multi-slot service's continuation rows have no id.
  const people = bookings.filter(b => b.booking_id).map(b => ({
    name:    b.person_name,
    service: serviceLine(b.service_slug, custom)
      + (b.addons.length ? ` + ${b.addons.map(a => ADDON_LABELS[a] || a).join(', ')}` : ''),
    time:    minutesToLabel(hmsToMinutes(b.booking_time)),
  }));

  // The booking already exists; the message is how the barber gets the details.
  showSuccess(form, {
    text: `${dateLabel} · ${barberName}`,
    people,
    total: formatTotal(total, unpriced),
    next: `${people.length > 1 ? 'Your chairs are reserved.' : 'Your chair is reserved.'} Send the message so ${barberName} has your details; he'll reply to confirm.`,
    send: sendLinks(bookings),
  });

  // The form stays as submitted next to the confirmation, and Reserve stays
  // off, until "Book another".
  form.dataset.busy = 'false';
  setFlag(form, 'booked', true);
}

/** "Book another": a fresh form, and a grid that shows the slots just taken. */
function startOver(form) {
  form.reset();
  form.querySelectorAll('[data-guest]').forEach(row => row.remove());
  form.querySelector('[data-add-guest]').disabled = false;
  form.querySelectorAll('input[name="addons"]').forEach(i => { i.dataset.wasChecked = 'false'; });
  syncCustomField(form);       // reset() fires no change event
  syncIncludedAddons(form);
  hideMessages(form);
  clearTime();
  updateTotal(form);
  updateTimeline(form);
  setFlag(form, 'booked', false);
  gridRefresh();
  form.closest('.booking')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  // "Book the VIP" in the menu: the service is chosen (and totalled) before
  // the link's own #book jump lands on the form.
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-book-service]');
    if (!link) return;
    const select = form.querySelector('[data-service-select]');
    select.value = link.dataset.bookService;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  document.addEventListener('booking:selected', () => updateTimeline(form));

  updateTotal(form);
  updateTimeline(form);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(form);
  });
}
