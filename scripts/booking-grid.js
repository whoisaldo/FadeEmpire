// booking-grid.js — visual day picker + slot pills.
//
// Renders a 7-day chip row + a slot column for the selected day.
// State flow: user picks day → user picks slot → hidden fields date/time set →
// `booking:selected` event fires → submit handler reads it.

import { fetchAvailability } from './booking-rpc.js';
import {
  isoDate, slotsForWeekday, minutesToHms, minutesToLabel, shopWeekday,
  nowMinutesInShopTz, fmtShopTime,
} from './booking-helpers.js';

const DAYS_AHEAD = 14;          // how many days the picker shows
const LUNCH_MIN  = null;         // optional: lunch break minutes (e.g. 13*60 for 1pm); null = none

let state = {
  selectedDate: null,      // 'YYYY-MM-DD'
  selectedTime: null,      // 'HH:MM:SS'
  takenSet:     new Set(), // 'YYYY-MM-DD|HH:MM' keys for taken slots
};

/* ---------- Day row ---------- */

function renderDayRow() {
  const row = document.querySelector('[data-day-row]');
  if (!row) return;
  row.innerHTML = '';

  const today = new Date();
  const todayIso = isoDate(today);

  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const iso = isoDate(d);
    const wk  = shopWeekday(d);
    const slots = slotsForWeekday(wk);
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

  // Pre-select the first non-closed day
  const firstOpen = row.querySelector('.booking__day:not(.is-closed)');
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
    const d = new Date(`${iso}T12:00:00`);
    dayLabel.textContent = fmtShopTime(d, { weekday: 'long', month: 'long', day: 'numeric' });
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

  const d = new Date(`${iso}T12:00:00`);
  const wk = shopWeekday(d);
  const slots = slotsForWeekday(wk);

  if (slots.length === 0) {
    wrap.innerHTML = '<p class="booking__slots-empty t-italic">Closed this day.</p>';
    return;
  }

  const todayIso = isoDate(new Date());
  const nowMin   = nowMinutesInShopTz();

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
    }

    wrap.appendChild(btn);
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
    const d = new Date(`${state.selectedDate}T12:00:00`);
    const dLabel = fmtShopTime(d, { weekday: 'short', month: 'short', day: 'numeric' });
    const tLabel = minutesToLabel(parseInt(state.selectedTime.slice(0,2)) * 60 + parseInt(state.selectedTime.slice(3,5)));
    text.textContent = `${dLabel} · ${tLabel}`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }

  document.dispatchEvent(new CustomEvent('booking:selected', {
    detail: { date: state.selectedDate, time: state.selectedTime },
  }));
}

/* ---------- Availability load ---------- */

async function loadAvailability() {
  const today = new Date();
  const end   = new Date(today.getTime() + DAYS_AHEAD * 86400000);
  const rows  = await fetchAvailability({
    fromDate: isoDate(today), toDate: isoDate(end),
  });
  state.takenSet = new Set(rows.map(r => `${r.booking_date}|${r.booking_time.slice(0,5)}`));
  renderSlots();
}

/* ---------- External pickers (next-available, "Pick this" button) ---------- */

function bindExternalPick() {
  document.addEventListener('booking:pick', (e) => {
    const { date, time } = e.detail || {};
    if (!date || !time) return;
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
  renderDayRow();
  bindExternalPick();
  initAutoRefresh();
  await loadAvailability();
}

/** Exposed for booking-submit.js to refresh after a successful book */
export async function refreshAvailability() {
  await loadAvailability();
}

export function getSelection() {
  return { date: state.selectedDate, time: state.selectedTime };
}

export function clearSelection() {
  state.selectedDate = null;
  state.selectedTime = null;
  syncForm();
}
