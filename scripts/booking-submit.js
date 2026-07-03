// booking-submit.js — form submission + group-booking UI + redirect + fallback.
//
// Flow:
//   1. Pre-validate (HTML5 + barber/slot selection + guest overrun).
//   2. Open placeholder tab synchronously on desktop (gesture-preserving).
//   3. Call book_slot or book_slot_group RPC.
//   4. On success: show success card + redirect to WhatsApp/SMS.
//   5. On slot_taken: hard-fail (refresh grid, ask user to pick another slot).
//      This is the ONE error that must not fall back — would cause double-booking.
//   6. On any other RPC error: log to booking_errors, show amber fallback card,
//      still build the WhatsApp message (with a ⚠ BOOKING SYSTEM ERROR prefix),
//      and redirect anyway. We don't lose the customer to a transient backend hiccup.

import { bookSlot, bookSlotGroup, logBookingError, BookingError } from './booking-rpc.js';
import { getSelection, refreshAvailability as gridRefresh, clearSelection } from './booking-grid.js';
import {
  totalCents, formatPrice, formatPhoneDisplay, minutesToLabel,
  dateLabelFromIso, ERROR_MESSAGES, HARD_FAIL_CODES, hmsToMinutes, minutesToHms,
} from './booking-helpers.js';
import { buildBookingMessage, messagingUrl } from './booking-messages.js';
import { validateBookingInput, partyFits, planParty } from './booking-validate.js';
import { SERVICE_PRICES_CENTS, BARBERS } from './config.js';

const MAX_GUESTS = 4;          // primary + up to 4 guests = 5 people total

/* ---------- Reading the form ---------- */

function readAddons(form) {
  return [...form.querySelectorAll('input[name="addons"]:checked')].map(i => i.value);
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

/* ---------- Total + timeline updates + overrun check ---------- */

function updateTotal(form) {
  const primaryService = form.querySelector('[data-service-select]').value;
  const addons         = readAddons(form);
  let cents = totalCents(primaryService, addons);

  for (const g of readGuests(form)) {
    cents += SERVICE_PRICES_CENTS[g.serviceSlug] || 0;
  }

  form.querySelector('[data-total-display]').textContent = formatPrice(cents);
}

/** Update the live timeline + return true if every person's chair time fits
 *  working hours. Duration-aware: a VIP occupies two slots, so the next guest
 *  starts an hour later, not 30 minutes. */
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

/** Side-effect-y wrapper that also enables/disables submit buttons. */
function updateTimeline(form) {
  const ok = updateTimelineAndCheckOverrun(form);
  const submitBtns = form.querySelectorAll('[data-submit-whatsapp], [data-submit-sms]');
  submitBtns.forEach(b => {
    if (!ok) {
      b.disabled = true;
      b.setAttribute('data-overrun-blocked', '');
    } else if (b.hasAttribute('data-overrun-blocked')) {
      b.disabled = false;
      b.removeAttribute('data-overrun-blocked');
    }
  });
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

function showError(form, code, override) {
  hideMessages(form);
  const el = form.querySelector('[data-form-error]');
  el.textContent = override || ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown;
  el.hidden = false;
}

function linkLabel(mode) {
  return mode === 'sms' ? 'Open Messages →' : 'Open WhatsApp →';
}

function showSuccess(form, { text, link, mode }) {
  hideMessages(form);
  const card = form.querySelector('[data-form-success]');
  card.querySelector('[data-success-text]').textContent = text;
  const a = card.querySelector('[data-success-link]');
  if (link) { a.href = link; a.textContent = linkLabel(mode); a.hidden = false; } else { a.hidden = true; }
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showFallback(form, { text, link, mode }) {
  hideMessages(form);
  const card = form.querySelector('[data-form-fallback]');
  if (!card) {
    // Fallback card markup missing — degrade to the regular success card.
    showSuccess(form, { text, link, mode });
    return;
  }
  card.querySelector('[data-fallback-text]').textContent = text;
  const a = card.querySelector('[data-fallback-link]');
  if (link) { a.href = link; a.textContent = linkLabel(mode); a.hidden = false; } else { a.hidden = true; }
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- Submit ---------- */

async function submit(form, mode) {
  // 1. Pre-flight HTML5 validation — surface required-field errors cleanly
  //    BEFORE we open any placeholder tab or hit the RPC.
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  hideMessages(form);

  // 2. Disable buttons immediately to slam the double-tap window shut.
  const submitBtns = form.querySelectorAll('[data-submit-whatsapp], [data-submit-sms]');
  submitBtns.forEach(b => (b.disabled = true));

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
    submitBtns.forEach(b => (b.disabled = false));
    return;
  }
  // Recheck guest overrun — UI should have prevented this already, but verify.
  if (!updateTimelineAndCheckOverrun(form)) {
    showError(form, 'outside_hours', 'One of your party runs past closing time. Pick an earlier start.');
    submitBtns.forEach(b => (b.disabled = false));
    return;
  }

  const barber     = BARBERS[sel.barberSlug];
  const barberName = barber ? barber.name : 'the shop';

  // 5. Pre-open placeholder tab on desktop (preserves user gesture)
  const isMobile = window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  const placeholder = (!isMobile && (mode === 'whatsapp' || mode === 'sms'))
    ? window.open('about:blank', '_blank', 'noopener')
    : null;

  // 6. Call the appropriate RPC
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
      bookings = rows.map(r => ({
        booking_id:        r.booking_id,
        person_name:       r.person_name,
        service_slug:      r.service_slug,
        booking_time:      r.booking_time,
        total_price_cents: r.total_price_cents,
        addons:            r.person_index === 0 ? addons : [],
      }));
    }
  } catch (err) {
    rpcError = err;
  }

  // 7. Build context shared by both success + fallback paths
  const dateLabel   = dateLabelFromIso(sel.date);
  const useMarkdown = mode === 'whatsapp';

  /* ===== ERROR PATH ===== */
  if (rpcError) {
    const code = (rpcError instanceof BookingError) ? rpcError.code : 'unknown';

    // 7a. Hard-fail: slot_taken must NOT fall back to messaging (would double-book).
    if (HARD_FAIL_CODES.has(code)) {
      if (placeholder) placeholder.close();
      showError(form, code);
      await gridRefresh();
      clearSelection();
      submitBtns.forEach(b => (b.disabled = false));
      return;
    }

    // 7b. Soft-fail: log to booking_errors, then build a fallback message and
    //     route the customer to WhatsApp/SMS anyway. We don't lose customers
    //     to transient backend hiccups.
    const cause = rpcError && rpcError.cause;
    logBookingError({
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

    // Build "pending-ref" so the shop can correlate manual confirmations.
    const pendingRef = 'pending-' +
      (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 8);

    // Reconstruct a bookings-shaped array from the form data for message
    // building — duration-aware so the times match what was attempted.
    const services = [primaryServiceSlug, ...guests.map(g => g.serviceSlug)];
    const plan     = planParty(hmsToMinutes(sel.time), services);
    const fakeBookings = plan.map((p, i) => ({
      person_name:       i === 0 ? name : guests[i - 1].name,
      service_slug:      i === 0 ? service : guests[i - 1].serviceSlug,
      booking_time:      minutesToHms(p.startMin),
      total_price_cents: SERVICE_PRICES_CENTS[p.serviceSlug] || 0,
      addons:            i === 0 ? addons : [],
      booking_id:        i === 0 ? pendingRef : `${pendingRef}-g${i}`,
    }));

    const fallbackMessage = buildBookingMessage({
      name,
      phone: formatPhoneDisplay(phone),
      barberName,
      dateLabel,
      bookings: fakeBookings,
      notes,
      customRequest: service === 'custom' ? custom : null,
      useMarkdown,
      systemError: true,
      errorCode: code,
    });
    const url = messagingUrl(mode, fallbackMessage);

    showFallback(form, {
      text: `Couldn't lock the slot in our system right now — but we're sending your request straight to ${barberName}. You'll get a confirmation by ${mode === 'whatsapp' ? 'WhatsApp' : 'text'} as soon as possible.`,
      link: url,
      mode,
    });

    // Redirect: same pattern as success path.
    if (isMobile) {
      setTimeout(() => { window.location.href = url; }, 800);
    } else if (placeholder && !placeholder.closed) {
      try { placeholder.location.href = url; } catch (_) { /* noop */ }
    }
    submitBtns.forEach(b => (b.disabled = false));
    return;
  }

  /* ===== SUCCESS PATH ===== */
  const message = buildBookingMessage({
    name, phone: formatPhoneDisplay(phone),
    barberName,
    dateLabel, bookings, notes,
    customRequest: service === 'custom' ? custom : null,
    useMarkdown,
    systemError: false,
  });
  const url = messagingUrl(mode, message);

  const total = bookings.reduce((s, b) => s + b.total_price_cents, 0);
  const primaryBooking = bookings.find(b => b.booking_id) || bookings[0];
  const slotLabel = guests.length > 0
    ? `${guests.length + 1} chairs · ${dateLabel} · starting ${minutesToLabel(hmsToMinutes(primaryBooking.booking_time))}`
    : `${dateLabel} at ${minutesToLabel(hmsToMinutes(primaryBooking.booking_time))}`;

  showSuccess(form, {
    text: `${slotLabel} — reserved. ${barberName} will be expecting ${
      guests.length > 0 ? `${guests.length + 1} of you` : 'you'
    }. Total: ${formatPrice(total)}.`,
    link: url,
    mode,
  });

  if (isMobile) {
    setTimeout(() => { window.location.href = url; }, 700);
  } else if (placeholder && !placeholder.closed) {
    try { placeholder.location.href = url; } catch (_) { /* noop */ }
  }

  // Refresh availability so booked slots disappear; reset form for back-button safety.
  await gridRefresh();
  form.reset();
  clearSelection();
  // remove any dynamically-added guest rows
  form.querySelectorAll('[data-guest]').forEach(row => row.remove());
  form.querySelector('[data-add-guest]').disabled = false;
  updateTotal(form);
  updateTimeline(form);
  submitBtns.forEach(b => (b.disabled = false));
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

function bindCustomToggle(form) {
  const select      = form.querySelector('[data-service-select]');
  const customField = form.querySelector('[data-custom-field]');
  if (!select || !customField) return;
  const update = () => { customField.hidden = select.value !== 'custom'; };
  select.addEventListener('change', update);
  update();
}

/* ---------- Boot ---------- */

export function initBookingSubmit() {
  const form = document.querySelector('[data-booking-form]');
  if (!form) return;

  bindPhoneFormatter(form);
  bindCustomToggle(form);

  form.querySelector('[data-service-select]').addEventListener('change', () => {
    updateTotal(form); updateTimeline(form);
  });
  form.querySelectorAll('input[name="addons"]').forEach(i =>
    i.addEventListener('change', () => updateTotal(form))
  );
  form.querySelector('input[name="name"]').addEventListener('input', () => updateTimeline(form));

  form.querySelector('[data-add-guest]').addEventListener('click', () => addGuest(form));

  document.addEventListener('booking:selected', () => updateTimeline(form));

  updateTotal(form);
  updateTimeline(form);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(form, 'whatsapp');
  });
  form.querySelector('[data-submit-whatsapp]')?.addEventListener('click', (e) => {
    e.preventDefault();
    submit(form, 'whatsapp');
  });
  form.querySelector('[data-submit-sms]')?.addEventListener('click', (e) => {
    e.preventDefault();
    submit(form, 'sms');
  });
}
