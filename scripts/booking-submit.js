// booking-submit.js — form submission + group-booking UI + redirect.
//
// Flow (single person):
//   click → open blank tab synchronously (preserves user gesture) →
//   await book_slot RPC → redirect blank tab to wa.me / sms link →
//   show success card with manual fallback link.
//
// Flow (with guests): same, but calls book_slot_group instead, which atomically
// inserts N consecutive slots. Hassan messages one phone for the whole group.

import { bookSlot, bookSlotGroup, BookingError } from './booking-rpc.js';
import { getSelection, refreshAvailability as gridRefresh, clearSelection } from './booking-grid.js';
import {
  totalCents, formatPrice, formatPhoneDisplay, minutesToLabel,
  fmtShopTime, ERROR_MESSAGES, buildMessage, hmsToMinutes,
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
  // Used for validation feedback — even incomplete rows count.
  return [...form.querySelectorAll('[data-guest]')]
    .map(row => ({
      name:        row.querySelector('[data-guest-name]').value.trim(),
      serviceSlug: row.querySelector('[data-guest-service]').value,
    }));
}

/* ---------- Total + timeline updates ---------- */

function updateTotal(form) {
  const primaryService = form.querySelector('[data-service-select]').value;
  const addons         = readAddons(form);
  let cents = totalCents(primaryService, addons);

  for (const g of readGuests(form)) {
    cents += SERVICE_PRICES_CENTS[g.serviceSlug] || 0;
  }

  form.querySelector('[data-total-display]').textContent = formatPrice(cents);
}

function updateTimeline(form) {
  const timelineEl = form.querySelector('[data-group-timeline]');
  if (!timelineEl) return;

  const guests = readGuestsRaw(form);
  if (guests.length === 0) { timelineEl.hidden = true; return; }

  const sel = getSelection();
  if (!sel.date || !sel.time) {
    timelineEl.hidden = false;
    timelineEl.textContent = 'Pick a start time above to see the schedule.';
    return;
  }

  const startMin = hmsToMinutes(sel.time);
  const primaryName = (form.querySelector('input[name=name]').value || 'You').trim() || 'You';
  const lines = [`${primaryName} — ${minutesToLabel(startMin)}`];
  guests.forEach((g, i) => {
    const t = minutesToLabel(startMin + (i + 1) * 30);
    lines.push(`${g.name || 'Guest ' + (i + 1)} — ${t}`);
  });
  timelineEl.hidden = false;
  timelineEl.textContent = lines.join('   ·   ');
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

/* ---------- Error / success surfaces ---------- */

function hideMessages(form) {
  form.querySelector('[data-form-error]').hidden   = true;
  form.querySelector('[data-form-success]').hidden = true;
}

function showError(form, code, override) {
  const el = form.querySelector('[data-form-error]');
  el.textContent = override || ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown;
  el.hidden = false;
  form.querySelector('[data-form-success]').hidden = true;
}

function showSuccess(form, { text, link }) {
  form.querySelector('[data-form-error]').hidden = true;
  const card = form.querySelector('[data-form-success]');
  card.querySelector('[data-success-text]').textContent = text;
  const a = card.querySelector('[data-success-link]');
  if (link) {
    a.href = link;
    a.hidden = false;
  } else {
    a.hidden = true;
  }
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- Submit ---------- */

async function submit(form, mode) {
  hideMessages(form);

  const sel = getSelection();
  if (!sel.date || !sel.time) {
    showError(form, 'unknown', 'Pick a day and a time slot above first.');
    return;
  }

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
    return;
  }
  if (guestsRaw.length && guestsRaw.some(g => !g.name || !g.serviceSlug)) {
    showError(form, 'unknown', 'Please complete or remove the guest rows below.');
    return;
  }

  // -------- Open a placeholder tab SYNCHRONOUSLY so popup blockers don't fire --------
  // On mobile Safari especially, window.open after `await` is blocked. Pre-opening
  // a blank tab preserves the user-gesture context; we redirect it after the RPC.
  const placeholder = (mode === 'whatsapp' || mode === 'sms')
    ? window.open('about:blank', '_blank', 'noopener')
    : null;

  const submitBtns = form.querySelectorAll('[data-submit-whatsapp], [data-submit-sms]');
  submitBtns.forEach(b => (b.disabled = true));

  let result;
  let bookings;        // unified array of person bookings
  try {
    if (guests.length === 0) {
      // Single-person flow
      result = await bookSlot({
        serviceSlug: service === 'custom' ? 'hair-cut' : service,
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
      bookings = [{
        booking_id:       result.booking_id,
        person_name:      name,
        service_slug:     service,
        booking_time:     sel.time,
        total_price_cents:result.total_price_cents,
        addons,
      }];
    } else {
      // Group flow: primary + guests, all consecutive slots from sel.time
      const people = [
        {
          name,
          serviceSlug: service === 'custom' ? 'hair-cut' : service,
          addons,
          notes: notes || null,
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
    if (placeholder) placeholder.close();
    if (err instanceof BookingError) {
      // Surface the raw PG message under known-but-unmapped codes so the user
      // (and we, in mobile diagnostics) can see what's actually wrong.
      const detail = err.cause && (err.cause.message || err.cause.details);
      if (err.code === 'unknown' && detail) {
        showError(form, 'unknown',
          `${ERROR_MESSAGES.unknown}\n\n[${detail}]`);
      } else {
        showError(form, err.code);
      }
      if (err.code === 'slot_taken') {
        await gridRefresh();
        clearSelection();
      }
    } else {
      console.error('[booking] submit failed', err);
      const detail = err && (err.message || String(err));
      showError(form, 'unknown',
        detail ? `${ERROR_MESSAGES.unknown}\n\n[${detail}]` : undefined);
    }
    submitBtns.forEach(b => (b.disabled = false));
    return;
  }

  // -------- Build the message that goes to Hassan --------
  const slotDate  = new Date(`${sel.date}T12:00:00`);
  const dateLabel = fmtShopTime(slotDate, { weekday: 'long', month: 'long', day: 'numeric' });
  const useMarkdown = mode === 'whatsapp';
  const message = buildGroupMessage({
    name, phone: formatPhoneDisplay(phone),
    dateLabel, bookings, notes, customRequest: service === 'custom' ? custom : null,
    useMarkdown,
  });

  // -------- Build redirect URL and direct the placeholder tab --------
  const encoded = encodeURIComponent(message);
  const url = mode === 'whatsapp'
    ? `https://wa.me/${SHOP_PHONE}?text=${encoded}`
    : `sms:+${SHOP_PHONE}?&body=${encoded}`;

  if (placeholder && !placeholder.closed) {
    try { placeholder.location.href = url; } catch (_) { /* cross-origin nav blocked? */ }
  } else {
    // Popup blocked. Fall back to current-window navigation on mobile,
    // or rely on the manual click-through link in the success card.
    if (window.innerWidth < 768) {
      window.location.href = url;
      return;
    }
  }

  // -------- Show success card with manual fallback link --------
  const total = bookings.reduce((s, b) => s + b.total_price_cents, 0);
  const slotLabel = bookings.length > 1
    ? `${bookings.length} chairs · ${dateLabel} · starting ${minutesToLabel(hmsToMinutes(bookings[0].booking_time))}`
    : `${dateLabel} at ${minutesToLabel(hmsToMinutes(bookings[0].booking_time))}`;
  showSuccess(form, {
    text: `${slotLabel} — held for 15 minutes. ${
      bookings.length > 1
        ? `Hassan will be expecting ${bookings.length} of you.`
        : `Hassan will be expecting you.`
    } Total: ${formatPrice(total)}.`,
    link: url,
  });

  // Refresh availability so booked slots disappear, then clear the form selection.
  await gridRefresh();
  submitBtns.forEach(b => (b.disabled = false));
}

/* ---------- Build the group-aware notification message ---------- */

function buildGroupMessage({ name, phone, dateLabel, bookings, notes, customRequest, useMarkdown }) {
  const bold   = (s) => useMarkdown ? `*${s}*` : s;
  const italic = (s) => useMarkdown ? `_${s}_` : s;
  const lines = [];
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
    lines.push(`  Ref:     ${b.booking_id.slice(0, 8)}`);
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
  lines.push(italic('Sent from chicopeefadeempire.com'));
  return lines.join('\n');
}

/* ---------- Phone formatting + custom toggle ---------- */

function bindPhoneFormatter(form) {
  const input = form.querySelector('[data-phone-input]');
  if (!input) return;
  input.addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
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

  // Re-render the timeline whenever the user picks a new slot
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
