// booking-grid.js — barber picker + visual day picker + slot pills.
//
// Renders a barber chooser, a 14-day chip row, and a slot column for the
// selected day. State flow: user picks barber → picks day → picks slot →
// hidden fields date/time set → `booking:selected` event fires → submit
// handler reads it. Every piece re-renders when the barber changes, because
// each barber has different days off and opening hours.

import { fetchAvailability } from './booking-rpc.js';
import {
  isoDate, slotsForWeekday, minutesToHms, minutesToLabel,
  nowMinutesInShopTz, weekdayFromIso, dateLabelFromIso, addDaysIso,
} from './booking-helpers.js';
import { BARBERS, DEFAULT_BARBER_SLUG } from './config.js';

const DAYS_AHEAD = 14;          // how many days the picker shows

let state = {
  barberSlug:   DEFAULT_BARBER_SLUG,
  selectedDate: null,      // 'YYYY-MM-DD'
  selectedTime: null,      // 'HH:MM:SS'
  takenSet:     new Set(), // 'YYYY-MM-DD|HH:MM' keys for the CURRENT barber's taken slots
  // Availability read for the current barber: 'loading' (nothing read yet),
  // 'ok' (takenSet is real, possibly empty), or 'error' (the read failed, so
  // no slot is offered until a retry succeeds).
  availability: 'loading',
};
let loadSeq = 0;           // drops stale responses when reads overlap

/* ---------- Locked while a confirmation shows ---------- */

// After a booking the picker must not change under the confirmation: its
// parts go inert (no taps, no focus) and every way in is refused, including
// the shortcuts from elsewhere on the page and the background refresh.
// "Book another" unlocks.
let locked = false;
const LOCKED_PARTS = ['.booking__callout', '.booking__barbers', '[data-day-row]', '[data-slot-grid]'];

export function setLocked(on) {
  locked = on;
  LOCKED_PARTS.forEach(sel => document.querySelectorAll(sel).forEach(el => el.toggleAttribute('inert', on)));
}

/* ---------- Barber picker ---------- */

function selectBarber(slug, { keepDate = false } = {}) {
  if (!BARBERS[slug] || locked) return;
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
    state.availability = 'loading';
    renderDayRow();
    syncForm();
    loadAvailability();
  }
}

function bindBarberPicker() {
  document.querySelectorAll('[data-barber-option]').forEach(btn => {
    btn.addEventListener('click', () => selectBarber(btn.dataset.barberOption));
  });

  // "Book with X" buttons in the barbers section jump here pre-selected,
  // with focus on the next step still to do.
  document.querySelectorAll('[data-book-barber]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectBarber(btn.dataset.bookBarber);
      document.dispatchEvent(new CustomEvent('booking:focus-next'));
    });
  });
}

/* ---------- Day row ---------- */

/** Whether today still has a slot that hasn't started (after 5:30 PM it doesn't). */
function todayHasSlotsLeft(todayIso) {
  const nowMin = nowMinutesInShopTz();
  return slotsForWeekday(weekdayFromIso(todayIso), state.barberSlug).some(m => m > nowMin);
}

function renderDayRow() {
  const row = document.querySelector('[data-day-row]');
  if (!row) return;
  row.innerHTML = '';

  const todayIso = isoDate(new Date());

  for (let i = 0; i < DAYS_AHEAD; i++) {
    const iso = addDaysIso(todayIso, i);
    const wk  = weekdayFromIso(iso);
    const slots = slotsForWeekday(wk, state.barberSlug);
    const closed = slots.length === 0;
    // Today after its last slot: not offered, and it says why.
    const over = !closed && i === 0 && !todayHasSlotsLeft(iso);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'booking__day' + (closed || over ? ' is-closed' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.dataset.date = iso;
    if (closed || over) btn.disabled = true;

    const note = closed ? 'Closed' : over ? 'No slots left' : null;
    btn.innerHTML = `
      <span class="booking__day-weekday">${dateLabelFromIso(iso, { weekday: 'short' })}</span>
      <span class="booking__day-num">${dateLabelFromIso(iso, { day: 'numeric' })}</span>
      <span class="booking__day-month">${note || dateLabelFromIso(iso, { month: 'short' })}</span>
    `;
    if (note) {
      btn.querySelector('.booking__day-month').classList.add('booking__day-closed');
      btn.title = note;
    }

    btn.addEventListener('click', () => selectDate(iso));
    row.appendChild(btn);
  }

  // Keep the previously-selected day if this barber also works it;
  // otherwise pre-select the first day with a slot left (closed days and a
  // finished today are skipped).
  const keep = state.selectedDate &&
    row.querySelector(`.booking__day[data-date="${state.selectedDate}"]:not(.is-closed)`);
  const firstOpen = keep || row.querySelector('.booking__day:not(.is-closed)');
  const time = keep ? state.selectedTime : null;
  if (firstOpen) selectDate(firstOpen.dataset.date);
  // A rebuild that keeps the day keeps the customer's time too, if still open.
  if (time && document.querySelector(`[data-slot-grid] .booking__slot[data-time="${time}"]:not([disabled])`)) {
    selectTime(time);
  }
}

/* ---------- Slot column ---------- */

function selectDate(iso) {
  if (locked) return;
  state.selectedDate = iso;
  state.selectedTime = null;
  setSlotsNote('');

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
      `${dateLabelFromIso(iso, { weekday: 'long', month: 'short', day: 'numeric' })} · ${barber ? barber.name : '—'}`;
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

  if (state.availability === 'error') {
    wrap.removeAttribute('aria-busy');
    wrap.innerHTML = '<p class="booking__slots-empty booking__slots-error">Couldn\'t load open times.</p>'
      + '<button type="button" class="btn btn--mini booking__slots-retry" data-slots-retry>Retry</button>';
    wrap.querySelector('[data-slots-retry]').addEventListener('click', retry);
    // Nothing is offered while availability is unknown, so drop a pick too.
    if (state.selectedTime) {
      state.selectedTime = null;
      syncForm();
    }
    return;
  }

  const loading  = state.availability === 'loading';
  wrap.toggleAttribute('aria-busy', loading);
  const todayIso = isoDate(new Date());
  const nowMin   = nowMinutesInShopTz();
  let selectionStillOpen = false;

  for (const m of slots) {
    const hms  = minutesToHms(m);
    const hhmm = hms.slice(0, 5);
    const key  = `${iso}|${hhmm}`;
    const isTaken = state.takenSet.has(key);
    const isPast  = iso === todayIso && m <= nowMin;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'booking__slot';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.dataset.time = hms;
    btn.textContent = minutesToLabel(m);

    if (loading && !isPast) {
      // Not read yet: shown, not offered. A pick made before the read (the
      // next-slot shortcut) stays marked until the read confirms or drops it.
      btn.classList.add('is-loading');
      btn.disabled = true;
      if (state.selectedTime === hms) {
        btn.setAttribute('aria-checked', 'true');
        btn.classList.add('is-selected');
        selectionStillOpen = true;
      }
    } else if (isTaken) {
      btn.classList.add('is-taken');
      btn.disabled = true;
      btn.title = 'Already booked';
    } else if (isPast) {
      btn.classList.add('is-past');
      btn.disabled = true;
      btn.title = 'Already passed';
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

/** Retry re-renders the grid, which takes the focused button with it: focus
 *  holds on the selected day, then goes to the first open time once the read
 *  lands (the day if there is none, Retry again if the read failed again). */
async function retry() {
  const day = () => document.querySelector('[data-day-row] .booking__day[aria-selected="true"]');
  loadAvailability();
  const holding = day();
  holding?.focus({ preventScroll: true });
  await whenAvailable();
  if (![holding, document.body].includes(document.activeElement)) return;   // the customer moved on
  const grid = document.querySelector('[data-slot-grid]');
  (grid.querySelector('.booking__slot:not([disabled])') || grid.querySelector('[data-slots-retry]') || day())
    ?.focus({ preventScroll: true });
}

/** Select a time. Only an open pill can be selected: a taken, passed or
 *  not-yet-read slot is never picked, whoever asks. Returns whether it was. */
function selectTime(hms) {
  if (locked) return false;
  const pill = document.querySelector(`[data-slot-grid] .booking__slot[data-time="${hms}"]`);
  if (!pill || pill.disabled) return false;
  setSlotsNote('');
  state.selectedTime = hms;
  document.querySelectorAll('[data-slot-grid] .booking__slot').forEach(b => {
    const on = b.dataset.time === hms;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.classList.toggle('is-selected', on);
  });
  syncForm();
  return true;
}

/** The one-line note under the slots (empty and visually hidden otherwise). */
function setSlotsNote(text) {
  const note = document.querySelector('[data-slots-note]');
  if (note && note.textContent !== text) note.textContent = text;
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

let lastLoad = Promise.resolve();
function loadAvailability() {
  if (locked) return lastLoad;         // "Book another" refreshes
  lastLoad = readAvailability();
  return lastLoad;
}

async function readAvailability() {
  const seq = ++loadSeq;
  const barberSlug = state.barberSlug;
  const fromDate = isoDate(new Date());
  if (state.availability === 'error') {      // Retry: back to "not read yet"
    state.availability = 'loading';
    renderSlots();
  }
  let rows;
  try {
    rows = await fetchAvailability({
      fromDate, toDate: addDaysIso(fromDate, DAYS_AHEAD), barberSlug,
    });
  } catch (_) {
    if (seq !== loadSeq || barberSlug !== state.barberSlug) return;
    state.availability = 'error';
    renderSlots();
    return;
  }
  if (seq !== loadSeq || barberSlug !== state.barberSlug) return;   // superseded mid-flight
  state.takenSet = new Set(rows.map(r => `${r.booking_date}|${r.booking_time.slice(0,5)}`));
  state.availability = 'ok';
  renderSlots();
}

/* ---------- External pickers (next-available, "Pick this" button) ---------- */

function bindExternalPick() {
  // "Reserve it" / "Take it": the advertised slot comes from a separate read,
  // so it is taken only if this barber's grid, once read, shows it open. A
  // failed read leaves "Couldn't load open times."; a slot booked or passed
  // since is said so; either way nothing is selected.
  document.addEventListener('booking:pick', async (e) => {
    const { date, time, barberSlug } = e.detail || {};
    if (!date || !time) return;
    if (locked) {                      // the confirmation is the next step
      document.dispatchEvent(new CustomEvent('booking:focus-next'));
      return;
    }
    if (barberSlug) selectBarber(barberSlug, { keepDate: true });
    selectDate(date);
    // Times still loading: go to the day now, its times shown loading, and
    // finish the pick when the read lands.
    let waitingOn = null;
    if (state.availability === 'loading') {
      waitingOn = document.querySelector(`[data-day-row] .booking__day[data-date="${date}"]`);
      waitingOn?.focus({ preventScroll: true });
      waitingOn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    await whenAvailable();
    if (state.selectedDate !== date || (barberSlug && state.barberSlug !== barberSlug)) return;   // superseded
    if (state.availability === 'ok' && !selectTime(time)) {
      const pill = document.querySelector(`[data-slot-grid] .booking__slot[data-time="${time}"]`);
      if (pill?.classList.contains('is-taken')) setSlotsNote('That time was just booked.');
      else if (pill?.classList.contains('is-past')) setSlotsNote('That time has passed.');
    }
    // Focus moves on unless the customer moved it themselves while waiting.
    if (waitingOn && ![waitingOn, document.body].includes(document.activeElement)) return;
    document.dispatchEvent(new CustomEvent('booking:focus-next'));
  });

  document.querySelector('[data-clear-selected]')?.addEventListener('click', clearTime);
}

/* ---------- Auto-refresh: tab visibility + midnight rollover ---------- */

let _cachedToday = null;
function maybeRolloverDay() {
  if (locked) return;                  // caught up by the next tick after "Book another"
  const today = isoDate(new Date());
  const todayChip = document.querySelector(`[data-day-row] .booking__day[data-date="${today}"]`);
  if (_cachedToday && _cachedToday !== today) {
    // Day rolled over while the tab was open. Rebuild the picker so yesterday
    // drops off, and re-render the current slots to apply the past-slot filter.
    _cachedToday = today;
    renderDayRow();
  } else if (todayChip && !todayChip.disabled && !todayHasSlotsLeft(today)) {
    renderDayRow();                    // today's last slot just started
  } else if (!_cachedToday) {
    _cachedToday = today;
  }
}

function initAutoRefresh() {
  _cachedToday = isoDate(new Date());   // so the first wake-up after midnight is detected

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

/** Resolves once the latest availability read has landed (or failed),
 *  including a read that starts while this one is waited on. */
export async function whenAvailable() {
  let load;
  do {
    load = lastLoad;
    await load;
  } while (load !== lastLoad);
}

export function getSelection() {
  return { date: state.selectedDate, time: state.selectedTime, barberSlug: state.barberSlug };
}

/** Drop the chosen time but keep the day: the day chip stays highlighted, so
 *  the date it stands for has to stay selected too. */
export function clearTime() {
  if (locked) return;
  state.selectedTime = null;
  syncForm();
  document.querySelectorAll('[data-slot-grid] .booking__slot').forEach(b => {
    b.setAttribute('aria-checked', 'false');
    b.classList.remove('is-selected');
  });
}
