// booking-submit.js — form submission + group-booking UI + redirect + fallback.
//
// Flow:
//   1. Pre-validate (HTML5 + slot selection + guest overrun).
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
  fmtShopTime, ERROR_MESSAGES, HARD_FAIL_CODES, hmsToMinutes,
  slotsForWeekday, shopWeekday,
} from './booking-helpers.js';
import { SHOP_PHONE, SERVICE_PRICES_CENTS } from './config.js';

const SERVICE_LABELS = {
  'hair-cut':     'Hair Cut',
  'line-up':      'Line Up',
  'beard-trim':   'Beard Trim',
  'kids-cut':     'Kids Cut',
  'military-cut': 'Military Cut',
  'senior-cut':   'Senior Cut',
  'vip-haircut':  'VIP Haircut',
  'custom':       'Custom Request',
};

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

/** Update the live timeline + return true if every guest slot fits working hours. */
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

  const startMin   = hmsToMinutes(sel.time);
  const wk         = shopWeekday(new Date(`${sel.date}T12:00:00`));
  const validSlots = new Set(slotsForWeekday(wk));
  const primaryName = (form.querySelector('input[name=name]').value || 'You').trim() || 'You';

  let overrun = false;
  const lines = [`${primaryName} — ${minutesToLabel(startMin)}`];
  guests.forEach((g, i) => {
    const m = startMin + (i + 1) * 30;
    const label = `${g.name || 'Guest ' + (i + 1)} — ${minutesToLabel(m)}`;
    if (!validSlots.has(m)) {
      overrun = true;
      lines.push(`${label}   ⚠ past closing`);
    } else {
      lines.push(label);
    }
  });
  timelineEl.textContent = lines.join('   ·   ');
  timelineEl.hidden = false;
  timelineEl.toggleAttribute('data-overrun', overrun);
  return !overrun;
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

function showSuccess(form, { text, link }) {
  hideMessages(form);
  const card = form.querySelector('[data-form-success]');
  card.querySelector('[data-success-text]').textContent = text;
  const a = card.querySelector('[data-success-link]');
  if (link) { a.href = link; a.hidden = false; } else { a.hidden = true; }
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showFallback(form, { text, link }) {
  hideMessages(form);
  const card = form.querySelector('[data-form-fallback]');
  if (!card) {
    // Fallback card markup missing — degrade to the regular success card.
    showSuccess(form, { text, link });
    return;
  }
  card.querySelector('[data-fallback-text]').textContent = text;
  const a = card.querySelector('[data-fallback-link]');
  if (link) { a.href = link; a.hidden = false; } else { a.hidden = true; }
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

  // 3. Slot selection must exist.
  const sel = getSelection();
  if (!sel.date || !sel.time) {
    showError(form, 'unknown', 'Pick a day and a time slot above first.');
    submitBtns.forEach(b => (b.disabled = false));
    return;
  }

  // 4. Read form data
  const fd = new FormData(form);
  const name    = (fd.get('name') || '').toString().trim();
  const phone   = (fd.get('phone') || '').toString().trim();
  const service = (fd.get('service') || '').toString();
  const notes   = (fd.get('notes') || '').toString().trim();
  const custom  = (fd.get('custom_request') || '').toString().trim();
  const addons  = readAddons(form);
  const guests  = readGuests(form);
  const guestsRaw = readGuestsRaw(form);

  if (!name || !phone || !service) {
    showError(form, 'unknown', 'Please fill out name, phone, and service.');
    submitBtns.forEach(b => (b.disabled = false));
    return;
  }
  if (guestsRaw.length && guestsRaw.some(g => !g.name || !g.serviceSlug)) {
    showError(form, 'unknown', 'Please complete or remove the guest rows below.');
    submitBtns.forEach(b => (b.disabled = false));
    return;
  }
  // Recheck guest overrun — UI should have prevented this already, but verify.
  if (!updateTimelineAndCheckOverrun(form)) {
    showError(form, 'outside_hours', 'One of your guests is past closing time. Pick an earlier start.');
    submitBtns.forEach(b => (b.disabled = false));
    return;
  }

  // 5. Pre-open placeholder tab on desktop (preserves user gesture)
  const isMobile = window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  const placeholder = (!isMobile && (mode === 'whatsapp' || mode === 'sms'))
    ? window.open('about:blank', '_blank', 'noopener')
    : null;

  // 6. Call the appropriate RPC
  let bookings;        // unified array of person bookings
  let rpcError = null;
  let primaryServiceSlug = service === 'custom' ? 'hair-cut' : service;
  try {
    if (guests.length === 0) {
      const rows = await bookSlot({
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
      // book_slot now returns N rows; row 0 is primary, rows 1+ are linked continuation slots.
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
  const slotDate    = new Date(`${sel.date}T12:00:00`);
  const dateLabel   = fmtShopTime(slotDate, { weekday: 'long', month: 'long', day: 'numeric' });
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
        date: sel.date, time: sel.time, service, addons, guests, notes,
        name, phone_last4: phone.replace(/\D/g, '').slice(-4),
        is_group: guests.length > 0,
      },
      user_agent: navigator.userAgent,
      source: 'web',
    });

    // Build "pending-ref" so Hassan can correlate manual confirmations.
    const pendingRef = 'pending-' +
      (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 8);

    // Reconstruct a bookings-shaped array from the form data for message building.
    const fakeBookings = (guests.length === 0
      ? [{ person_name: name, service_slug: service, booking_time: sel.time,
           total_price_cents: SERVICE_PRICES_CENTS[primaryServiceSlug] || 0,
           addons, booking_id: pendingRef }]
      : [
          { person_name: name, service_slug: service, booking_time: sel.time,
            total_price_cents: SERVICE_PRICES_CENTS[primaryServiceSlug] || 0,
            addons, booking_id: pendingRef },
          ...guests.map((g, i) => {
            const m = hmsToMinutes(sel.time) + (i + 1) * 30;
            const t = `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00`;
            return {
              person_name: g.name, service_slug: g.serviceSlug, booking_time: t,
              total_price_cents: SERVICE_PRICES_CENTS[g.serviceSlug] || 0,
              addons: [], booking_id: `${pendingRef}-g${i+1}`,
            };
          }),
        ]);

    const fallbackMessage = buildBookingMessage({
      name,
      phone: formatPhoneDisplay(phone),
      dateLabel,
      bookings: fakeBookings,
      notes,
      customRequest: service === 'custom' ? custom : null,
      useMarkdown,
      systemError: true,
      errorCode: code,
    });
    const url = mode === 'whatsapp'
      ? `https://wa.me/${SHOP_PHONE}?text=${encodeURIComponent(fallbackMessage)}`
      : `sms:+${SHOP_PHONE}?&body=${encodeURIComponent(fallbackMessage)}`;

    showFallback(form, {
      text: `Couldn't lock the slot in our system right now — but we're sending your request straight to Hassan. He'll confirm by ${mode === 'whatsapp' ? 'WhatsApp' : 'text'} as soon as possible.`,
      link: url,
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
    dateLabel, bookings, notes,
    customRequest: service === 'custom' ? custom : null,
    useMarkdown,
    systemError: false,
  });
  const encoded = encodeURIComponent(message);
  const url = mode === 'whatsapp'
    ? `https://wa.me/${SHOP_PHONE}?text=${encoded}`
    : `sms:+${SHOP_PHONE}?&body=${encoded}`;

  const total = bookings.reduce((s, b) => s + b.total_price_cents, 0);
  const primaryBooking = bookings.find(b => b.booking_id) || bookings[0];
  const slotLabel = guests.length > 0
    ? `${guests.length + 1} chairs · ${dateLabel} · starting ${minutesToLabel(hmsToMinutes(primaryBooking.booking_time))}`
    : `${dateLabel} at ${minutesToLabel(hmsToMinutes(primaryBooking.booking_time))}`;

  showSuccess(form, {
    text: `${slotLabel} — held for 15 minutes. ${
      guests.length > 0
        ? `Hassan will be expecting ${guests.length + 1} of you.`
        : `Hassan will be expecting you.`
    } Total: ${formatPrice(total)}.`,
    link: url,
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

/* ---------- Build the booking message (single + group + fallback) ---------- */

function buildBookingMessage({
  name, phone, dateLabel, bookings, notes, customRequest,
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
