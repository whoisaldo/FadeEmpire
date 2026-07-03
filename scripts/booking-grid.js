// booking-grid.js — barber picker + visual day picker + slot pills.
//
// Renders a barber chooser, a 14-day chip row, and a slot column for the
// selected day. State flow: user picks barber → picks day → picks slot →
// hidden fields date/time set → `booking:selected` event fires → submit
// handler reads it. Every piece re-renders when the barber changes, because
// each barber has different days off and opening hours.

import { fetchAvailability } from './booking-rpc.js';
import {
  isoDate, slotsForWeekday, minutesToHms, minutesToLabel, shopWeekday,
  nowMinutesInShopTz, fmtShopTime, weekdayFromIso, dateLabelFromIso,
} from './booking-helpers.js';
import { BARBERS, DEFAULT_BARBER_SLUG } from './config.js';

const DAYS_AHEAD = 14;          // how many days the picker shows
const LUNCH_MIN  = null;         // optional: lunch break minutes (e.g. 13*60 for 1pm); null = none

let state = {
  barberSlug:   DEFAULT_BARBER_SLUG,
  selectedDate: null,      // 'YYYY-MM-DD'
  selectedTime: null,      // 'HH:MM:SS'
  takenSet:     new Set(), // 'YYYY-MM-DD|HH:MM' keys for the CURRENT barber's taken slots
};

/* ---------- Barber picker ---------- */

function selectBarber(slug, { keepDate = false } = {}) {
  if (!BARBERS[slug]) return;
  const changed = state.barberSlug !== slug;
  state.barberSlug = slug;

  document.querySelectorAll('[data-barber-option]').forEach(b => {
    const on = b.dataset.barberOption === slug;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.classList.toggle('is-selected', on);
  });

  if (changed) {
    // A different barber has different days off, hours, and taken slots.
    state.selectedTime = null;
    if (!keepDate) state.selectedDate = null;
    state.takenSet = new Set();
    renderDayRow();
    syncForm();
    loadAvailability();
  }
}

function bindBarberPicker() {
  document.querySelectorAll('[data-barber-option]').forEach(btn => {
    btn.addEventListener('click', () => selectBarber(btn.dataset.barberOption));
  });

  // "Book with X" buttons in the barbers section jump here pre-selected.
  document.querySelectorAll('[data-book-barber]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectBarber(btn.dataset.bookBarber);
      document.getElementById('book')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

/* ---------- Day row ---------- */

function renderDayRow() {
  const row = document.querySelector('[data-day-row]');
  if (!row) return;
  row.innerHTML = '';

  const today = new Date();

  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const iso = isoDate(d);
    const wk  = shopWeekday(d);
    const slots = slotsForWeekday(wk, state.barberSlug);
    const closed = slots.length === 0;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'booking__day' + (closed ? ' is-closed' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.dataset.date = iso;
    if (closed) btn.disabled = true;

    btn.innerHTML = `
      <span class="booking__day-weekday">${fmtShopTime(d, { weekday: 'short' })}</span>
      <span class="booking__day-num">${fmtShopTime(d, { day: 'numeric' })}</span>
      <span class="booking__day-month">${fmtShopTime(d, { month: 'short' })}</span>
    `;

    btn.addEventListener('click', () => selectDate(iso));
    row.appendChild(btn);
  }

  // Keep the previously-selected day if this barber also works it;
  // otherwise pre-select the first open day.
  const keep = state.selectedDate &&
    row.querySelector(`.booking__day[data-date="${state.selectedDate}"]:not(.is-closed)`);
  const firstOpen = keep || row.querySelector('.booking__day:not(.is-closed)');
  if (firstOpen) selectDate(firstOpen.dataset.date);
}

/* ---------- Slot column ---------- */

function selectDate(iso) {
  state.selectedDate = iso;
  state.selectedTime = null;

  // Update day-row aria-selected
  document.querySelectorAll('[data-day-row] .booking__day').forEach(b => {
    const on = b.dataset.date === iso;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.classList.toggle('is-selected', on);
  });

  // Update slot label
  const dayLabel = document.querySelector('[data-slots-day-label]');
  if (dayLabel) {
    const barber = BARBERS[state.barberSlug];
    dayLabel.textContent =
      `${dateLabelFromIso(iso)} · with ${barber ? barber.name : '—'}`;
  }

  renderSlots();
  syncForm();
}

function renderSlots() {
  const wrap = document.querySelector('[data-slot-grid]');
  if (!wrap) return;
  wrap.innerHTML = '';

  const iso = state.selectedDate;
  if (!iso) {
    wrap.innerHTML = '<p class="booking__slots-empty t-italic">Pick a day above to see open slots.</p>';
    return;
  }

  const wk = weekdayFromIso(iso);
  const slots = slotsForWeekday(wk, state.barberSlug);

  if (slots.length === 0) {
    const barber = BARBERS[state.barberSlug];
    wrap.innerHTML = `<p class="booking__slots-empty t-italic">${
      barber ? `${barber.name} is off this day.` : 'Closed this day.'
    }</p>`;
    return;
  }

  const todayIso = isoDate(new Date());
  const nowMin   = nowMinutesInShopTz();
  let selectionStillOpen = false;

  for (const m of slots) {
    const hms  = minutesToHms(m);
    const hhmm = hms.slice(0, 5);
    const key  = `${iso}|${hhmm}`;
    const isTaken = state.takenSet.has(key);
    const isPast  = iso === todayIso && m <= nowMin;
    const isLunch = LUNCH_MIN !== null && m === LUNCH_MIN;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'booking__slot';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.dataset.time = hms;
    btn.textContent = minutesToLabel(m);

    if (isTaken) {
      btn.classList.add('is-taken');
      btn.disabled = true;
      btn.title = 'Already booked';
    } else if (isPast) {
      btn.classList.add('is-past');
      btn.disabled = true;
      btn.title = 'In the past';
    } else if (isLunch) {
      btn.classList.add('is-lunch');
      btn.disabled = true;
      btn.title = 'Lunch break';
    } else {
      btn.addEventListener('click', () => selectTime(hms));
      // Re-apply the user's current selection across background re-renders
      // (availability refresh every 5 min / on tab focus rebuilds the pills).
      if (state.selectedTime === hms) {
        btn.setAttribute('aria-checked', 'true');
        btn.classList.add('is-selected');
        selectionStillOpen = true;
      }
    }

    wrap.appendChild(btn);
  }

  // The slot the user had picked was booked by someone else mid-session —
  // drop it from the form so submit can't even attempt a double-book.
  if (state.selectedTime && !selectionStillOpen) {
    state.selectedTime = null;
    syncForm();
  }
}

function selectTime(hms) {
  state.selectedTime = hms;
  document.querySelectorAll('[data-slot-grid] .booking__slot').forEach(b => {
    const on = b.dataset.time === hms;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.classList.toggle('is-selected', on);
  });
  syncForm();
}

/* ---------- Form sync ---------- */

function syncForm() {
  document.querySelector('[data-form-date]').value = state.selectedDate || '';
  document.querySelector('[data-form-time]').value = state.selectedTime || '';

  const pill = document.querySelector('[data-selected-pill]');
  const text = document.querySelector('[data-selected-text]');
  if (state.selectedDate && state.selectedTime) {
    const dLabel = dateLabelFromIso(state.selectedDate, { weekday: 'short', month: 'short', day: 'numeric' });
    const tLabel = minutesToLabel(parseInt(state.selectedTime.slice(0,2)) * 60 + parseInt(state.selectedTime.slice(3,5)));
    const barber = BARBERS[state.barberSlug];
    text.textContent = `${dLabel} · ${tLabel}${barber ? ` · ${barber.name}` : ''}`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }

  document.dispatchEvent(new CustomEvent('booking:selected', {
    detail: { date: state.selectedDate, time: state.selectedTime, barberSlug: state.barberSlug },
  }));
}

/* ---------- Availability load ---------- */

async function loadAvailability() {
  const barberSlug = state.barberSlug;
  const today = new Date();
  const end   = new Date(today.getTime() + DAYS_AHEAD * 86400000);
  const rows  = await fetchAvailability({
    fromDate: isoDate(today), toDate: isoDate(end), barberSlug,
  });
  if (barberSlug !== state.barberSlug) return;   // user switched barber mid-flight
  state.takenSet = new Set(rows.map(r => `${r.booking_date}|${r.booking_time.slice(0,5)}`));
  renderSlots();
}

/* ---------- External pickers (next-available, "Pick this" button) ---------- */

function bindExternalPick() {
  document.addEventListener('booking:pick', (e) => {
    const { date, time, barberSlug } = e.detail || {};
    if (!date || !time) return;
    if (barberSlug) selectBarber(barberSlug, { keepDate: true });
    selectDate(date);
    // Wait a tick for slot DOM to render
    requestAnimationFrame(() => selectTime(time));
  });

  document.querySelector('[data-clear-selected]')?.addEventListener('click', () => {
    state.selectedTime = null;
    syncForm();
    document.querySelectorAll('[data-slot-grid] .booking__slot').forEach(b => {
      b.setAttribute('aria-checked', 'false');
      b.classList.remove('is-selected');
    });
  });
}

/* ---------- Auto-refresh: tab visibility + midnight rollover ---------- */

let _cachedToday = null;
function maybeRolloverDay() {
  const today = isoDate(new Date());
  if (_cachedToday && _cachedToday !== today) {
    // Day rolled over while the tab was open. Rebuild the picker so yesterday
    // drops off, and re-render the current slots to apply the past-slot filter.
    _cachedToday = today;
    renderDayRow();
  } else if (!_cachedToday) {
    _cachedToday = today;
  }
}

function initAutoRefresh() {
  // Refresh availability when the tab becomes visible again. Customers commonly
  // tab away (e.g. to check calendar) — when they come back the slot grid
  // shouldn't show stale "available" slots that someone else booked meanwhile.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    maybeRolloverDay();
    loadAvailability();
  });

  // Long-open tabs: poll for midnight + refresh availability every 5 min.
  setInterval(() => {
    maybeRolloverDay();
    if (!document.hidden) loadAvailability();
  }, 5 * 60_000);
}

/* ---------- Boot ---------- */

export async function initBookingGrid() {
  if (!document.querySelector('[data-day-row]')) return;
  bindBarberPicker();
  selectBarber(state.barberSlug);   // paint initial aria-checked state
  renderDayRow();
  bindExternalPick();
  initAutoRefresh();
  await loadAvailability();
}

/** Exposed for booking-submit.js to refresh after a successful book/cancel */
export async function refreshAvailability() {
  await loadAvailability();
}

export function getSelection() {
  return { date: state.selectedDate, time: state.selectedTime, barberSlug: state.barberSlug };
}

export function clearSelection() {
  state.selectedDate = null;
  state.selectedTime = null;
  syncForm();
}
