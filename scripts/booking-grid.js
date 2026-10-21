// booking-grid.js — barber picker + visual day picker + slot pills.
//
// Renders a barber chooser, a 14-day chip row, and a slot column for the
// selected day. State flow: user picks barber → picks day → picks slot →
// hidden fields date/time set → `booking:selected` event fires → submit
// handler reads it. Every piece re-renders when the barber changes, because
// each barber has different days off and opening hours.
//
// The barbers themselves come from the database (loadBarbers, roster.js):
// the picker starts as index.html's two buttons and is rebuilt from the
// active barbers once they are read, or stays config.js's if the read fails.
// Their names, titles and bios are the app's text: they reach the page as
// text only, never as markup.

import { fetchAvailability, fetchBarbers } from './booking-rpc.js';
import {
  isoDate, slotsForDate, minutesToHms, minutesToLabel, barberHoursLabel,
  nowMinutesInShopTz, weekdayFromIso, dateLabelFromIso, addDaysIso, takenSlots, hmsToMinutes,
} from './booking-helpers.js';
import { DEFAULT_BARBER_SLUG, STORE_HOURS, SHOP_PHONE } from './config.js';
import { barberList, getBarber, setRoster } from './roster.js';

const DAYS_AHEAD = 14;          // how many days the picker shows

let state = {
  barberSlug:   DEFAULT_BARBER_SLUG,
  selectedDate: null,      // 'YYYY-MM-DD'
  selectedTime: null,      // 'HH:MM:SS'
  isTaken:      () => false, // (barber, date, minutes) => whether a booking on the CURRENT barber's chair overlaps
  // Availability read for the current barber: 'loading' (nothing read yet),
  // 'ok' (isTaken is real, possibly never true), or 'error' (the read failed, so
  // no slot is offered until a retry succeeds).
  availability: 'loading',
};
let loadSeq = 0;           // drops stale responses when reads overlap
let settledSeq = 0;        // the newest read that has landed or failed
let pickSeq = 0;           // the shortcut pick still waiting, if any (see bindExternalPick)
let touched = false;       // the customer has picked a barber by hand

/** A choice the customer makes by hand cancels a shortcut pick still waiting
 *  on a read, so the pick can't overwrite it when the read lands. */
function cancelPick() { pickSeq++; }

/* ---------- Locked while a confirmation shows ---------- */

// After a booking the picker must not change under the confirmation: its
// parts go inert (no taps, no focus) and every way in is refused, including
// the shortcuts from elsewhere on the page and the background refresh.
// "Book another" unlocks, and the day row and the picker catch up on what
// they skipped. A booking request in flight locks it too (booking-submit.js),
// so the barbers read meanwhile, none included, wait for the answer.
let locked = false;
let rosterWaiting = null;  // barbers read while locked: { before } for rosterChanged on unlock
const LOCKED_PARTS = ['.booking__callout', '.booking__barbers', '[data-day-row]', '[data-slot-grid]'];

export function setLocked(on) {
  locked = on;
  LOCKED_PARTS.forEach(sel => document.querySelectorAll(sel).forEach(el => el.toggleAttribute('inert', on)));
  if (on) return;
  if (rosterWaiting) {
    const { before } = rosterWaiting;
    rosterWaiting = null;
    rosterChanged(before);
  }
  maybeRolloverDay();
}

/* ---------- Barber picker ---------- */

function selectBarber(slug, { keepDate = false } = {}) {
  if (!getBarber(slug) || locked) return;
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
    state.isTaken = () => false;
    state.availability = 'loading';
    renderDayRow();
    syncForm();
    loadAvailability();
  }
}

/** A barber chosen from outside the picker: a returning customer's, or the
 *  barber of a booking being moved. Before the grid boots this only sets the
 *  barber it starts with, so the first read is already his. */
let booted = false;
export function chooseBarber(slug) {
  if (!booted) {
    if (getBarber(slug)) state.barberSlug = slug;
    return;
  }
  cancelPick();
  selectBarber(slug);
}

/** The picker's buttons, one per barber on offer, in the shop's order. The
 *  buttons index.html ships (with their face crops) are kept for the barbers
 *  still on offer; a barber from the database gets one built here, with the
 *  photo when there is one. The hours line follows the barber's week. */
function renderPicker() {
  const row = document.querySelector('.booking__barbers-row');
  if (!row) return;
  const existing = new Map([...row.querySelectorAll('[data-barber-option]')].map(b => [b.dataset.barberOption, b]));
  const buttons = barberList().map(barber => {
    const btn = existing.get(barber.slug) || pickerButton(barber);
    const on = barber.slug === state.barberSlug;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.classList.toggle('is-selected', on);
    const hours = btn.querySelector('.booking__barber-hours');
    if (hours) hours.textContent = barberHoursLabel(barber.slug);
    return btn;
  });
  // Moving a focused button would drop its focus, so only a changed list is re-laid.
  const same = buttons.length === row.children.length && buttons.every((b, i) => row.children[i] === b);
  if (!same) row.replaceChildren(...buttons);
}

function pickerButton(barber) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'booking__barber';
  btn.setAttribute('role', 'radio');
  btn.dataset.barberOption = barber.slug;
  if (barber.photoUrl) {
    const img = document.createElement('img');
    img.className = 'booking__barber-photo';
    img.src = barber.photoUrl;
    img.width = 52;
    img.height = 52;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    btn.append(img);
  }
  const info = document.createElement('span');
  info.className = 'booking__barber-info';
  const name = document.createElement('span');
  name.className = 'booking__barber-name t-display-sm';
  name.textContent = barber.name;
  const hours = document.createElement('span');
  hours.className = 'booking__barber-hours t-meta';
  info.append(name, hours);
  btn.append(info);
  return btn;
}

function bindBarberPicker() {
  // Delegated: the picker's buttons and the barbers section's spreads are
  // rebuilt when the barbers are read.
  document.addEventListener('click', (e) => {
    const option = e.target.closest?.('[data-barber-option]');
    if (option) {
      touched = true;
      cancelPick();
      selectBarber(option.dataset.barberOption);
      return;
    }
    // "Book with X" buttons in the barbers section jump here pre-selected,
    // with focus on the next step still to do.
    const book = e.target.closest?.('[data-book-barber]');
    if (book) {
      touched = true;
      cancelPick();
      selectBarber(book.dataset.bookBarber);
      document.dispatchEvent(new CustomEvent('booking:focus-next'));
    }
  });
}

/** Whether the customer has picked a barber by hand (booking-link.js). */
export function barberTouched() { return touched; }

/* ---------- The barbers, from the database ---------- */

/** How long the booking form waits for the barbers before it starts with
 *  config.js's (it takes the database's later, when they arrive). */
export const ROSTER_WAIT_MS = 2500;

/** Read the active barbers into roster.js. Resolves once they are in, or
 *  after `waitMs` (or a failed read) with config.js's still on offer; never
 *  rejects. A read that lands after the wait is taken then: the picker and
 *  the day row follow it, and `booking:barbers` tells the barbers section.
 *  A read that finds no bookable barber is the shop's answer, not a failure:
 *  nobody is offered online. */
export function loadBarbers({ waitMs = ROSTER_WAIT_MS } = {}) {
  const read = fetchBarbers().then((roster) => {
    const before = getBarber(state.barberSlug);
    setRoster(roster);
    if (booted) rosterChanged(before);
    document.dispatchEvent(new CustomEvent('booking:barbers'));
  }, (err) => {
    console.warn('[booking] barbers not read; offering config.js\'s', err);
  });
  return Promise.race([read, new Promise((resolve) => setTimeout(resolve, waitMs))]);
}

/** The barbers changed after the grid started: rebuild the picker, and the
 *  day row for the barber's (maybe new) hours and days off. Whatever the
 *  customer had picked is checked again: a barber no longer on offer gives
 *  way to the first one, and a day or time no longer open is dropped, with a
 *  line saying so. `before` is the barber selected before the read. While
 *  a confirmation shows, or a booking request is in flight, nothing changes;
 *  it is all done on unlock. */
function rosterChanged(before) {
  if (locked) {
    rosterWaiting ??= { before };
    return;
  }
  const was = { date: state.selectedDate, time: state.selectedTime };
  renderPicker();
  showNoBarbers(!barberList().length);
  if (!barberList().length) {
    state.barberSlug = null;
    state.selectedDate = state.selectedTime = null;
    syncForm();
    return;
  }
  if (!getBarber(state.barberSlug)) {
    selectBarber(barberList()[0].slug);
    if (before) setSlotsNote(`${before.name} isn't taking online bookings right now.`);
    return;
  }
  renderDayRow();
  if (was.time && (state.selectedDate !== was.date || state.selectedTime !== was.time)) {
    const when = `${dateLabelFromIso(was.date, { weekday: 'short', month: 'short', day: 'numeric' })} at ${minutesToLabel(hmsToMinutes(was.time))}`;
    setSlotsNote(`${when} is no longer open.${state.selectedDate ? ' Pick another time.' : ''}`);
  }
}

/** No barber takes online bookings: the booking steps give way to a line
 *  with the shop's phone (index.html's CSS hides them on [data-no-barbers]).
 *  "Cancel a booking" stays. The sticky bar's gold button calls the shop
 *  instead, and its call icon, which would repeat it, goes. */
function showNoBarbers(on) {
  document.querySelector('[data-mobile-cta-book]')?.toggleAttribute('hidden', on);
  document.querySelector('[data-mobile-cta-call]')?.toggleAttribute('hidden', on);
  document.querySelector('[data-mobile-cta-offline]')?.toggleAttribute('hidden', !on);
  const book = document.getElementById('book');
  if (!book) return;
  book.toggleAttribute('data-no-barbers', on);
  let note = book.querySelector('[data-no-barbers-note]');
  if (on && !note) {
    note = document.createElement('p');
    note.className = 'booking-offline';
    note.dataset.noBarbersNote = '';
    note.setAttribute('role', 'status');
    const call = document.createElement('a');
    call.href = `tel:+${SHOP_PHONE}`;
    call.textContent = '413·885·4440';
    note.append("Online booking isn't available right now. Call ", call, ' or walk in.');
    book.querySelector('.booking')?.prepend(note);
  }
  if (note) note.hidden = !on;
}

/* ---------- Day row ---------- */

/** Whether today still has a slot that hasn't started (after 5:30 PM it doesn't). */
function todayHasSlotsLeft(todayIso) {
  const nowMin = nowMinutesInShopTz();
  return slotsForDate(todayIso, state.barberSlug).some(m => m > nowMin);
}

function renderDayRow() {
  const row = document.querySelector('[data-day-row]');
  if (!row) return;
  row.innerHTML = '';

  const todayIso = isoDate(new Date());

  for (let i = 0; i < DAYS_AHEAD; i++) {
    const iso = addDaysIso(todayIso, i);
    const slots = slotsForDate(iso, state.barberSlug);
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

    // "Closed" is the shop's closed day; "Off" a day only this barber is out.
    const note = closed ? (STORE_HOURS[weekdayFromIso(iso)] ? 'Off' : 'Closed') : over ? 'No slots left' : null;
    btn.innerHTML = `
      <span class="booking__day-weekday">${dateLabelFromIso(iso, { weekday: 'short' })}</span>
      <span class="booking__day-num">${dateLabelFromIso(iso, { day: 'numeric' })}</span>
      <span class="booking__day-month">${note || dateLabelFromIso(iso, { month: 'short' })}</span>
    `;
    if (note) {
      btn.querySelector('.booking__day-month').classList.add('booking__day-closed');
      btn.title = note;
    }

    btn.addEventListener('click', () => { cancelPick(); selectDate(iso); });
    row.appendChild(btn);
  }

  // Keep the previously-selected day if this barber also works it;
  // otherwise pre-select the first day with a slot left (closed days and a
  // finished today are skipped).
  // With no open day at all, nothing stays selected.
  const keep = state.selectedDate &&
    row.querySelector(`.booking__day[data-date="${state.selectedDate}"]:not(.is-closed)`);
  const firstOpen = keep || row.querySelector('.booking__day:not(.is-closed)');
  // A rebuild that keeps the day keeps the customer's time too, if still open.
  if (firstOpen) selectDate(firstOpen.dataset.date, { time: keep ? state.selectedTime : null });
  else clearDay();
}

/** No day selected: the label goes back to "Time" and the grid says why. */
function clearDay() {
  state.selectedDate = state.selectedTime = null;
  const dayLabel = document.querySelector('[data-slots-day-label]');
  if (dayLabel) dayLabel.textContent = 'Time';
  renderSlots();
  syncForm();
}

/* ---------- Slot column ---------- */

/** Select a day. `time` keeps a time already picked, if it is open that day
 *  (renderSlots drops it otherwise). */
function selectDate(iso, { time = null } = {}) {
  if (locked) return;
  state.selectedDate = iso;
  state.selectedTime = time;
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
    const barber = getBarber(state.barberSlug);
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
  const barber = getBarber(state.barberSlug);
  if (!iso) {
    const anyOpen = document.querySelector('[data-day-row] .booking__day:not(.is-closed)');
    wrap.append(slotsEmpty(anyOpen || !barber
      ? 'Pick a day above to see open slots.'
      : `${barber.name} has no open days in the next two weeks.`));
    return;
  }

  const slots = slotsForDate(iso, state.barberSlug);

  if (slots.length === 0) {
    wrap.append(slotsEmpty(barber ? `${barber.name} is off this day.` : 'Closed this day.'));
    return;
  }

  if (state.availability === 'error') {
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
  const todayIso = isoDate(new Date());
  const nowMin   = nowMinutesInShopTz();
  let selectionStillOpen = false;

  for (const m of slots) {
    const hms  = minutesToHms(m);
    const isTaken = state.isTaken(state.barberSlug, iso, m);
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
      btn.addEventListener('click', () => { cancelPick(); selectTime(hms); });
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

/** The grid's one-line message (a barber's name in it is text). */
function slotsEmpty(text) {
  const p = document.createElement('p');
  p.className = 'booking__slots-empty t-italic';
  p.textContent = text;
  return p;
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

/** The grid is busy while any read is in flight, including a background
 *  refresh that leaves the current times on screen. */
function reading() { return settledSeq !== loadSeq; }

function syncBusy() {
  const wrap = document.querySelector('[data-slot-grid]');
  if (!wrap) return;
  if (reading()) wrap.setAttribute('aria-busy', 'true');   // an empty value isn't exposed as busy
  else wrap.removeAttribute('aria-busy');
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
    const barber = getBarber(state.barberSlug);
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
  if (!getBarber(state.barberSlug)) return lastLoad;   // no barber offered online
  lastLoad = readAvailability();
  return lastLoad;
}

async function readAvailability() {
  const seq = ++loadSeq;
  syncBusy();
  try {
    await readInto(seq);
  } finally {
    if (seq === loadSeq) settle(seq);
  }
}

async function readInto(seq) {
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
  state.isTaken = takenSlots(rows);
  state.availability = 'ok';
  renderSlots();
  syncForm();          // a party's later times are checked against the new bookings too
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
    const pick = ++pickSeq;            // a newer pick or a choice by hand cancels this one
    if (barberSlug) selectBarber(barberSlug, { keepDate: true });
    selectDate(date);
    // A read in flight (first load, barber switch or background refresh): go
    // to the day now, the grid shown busy, and finish the pick when it lands.
    let waitingOn = null;
    if (reading()) {
      waitingOn = document.querySelector(`[data-day-row] .booking__day[data-date="${date}"]`);
      waitingOn?.focus({ preventScroll: true });
      waitingOn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    await whenAvailable();
    if (pick !== pickSeq) return;      // cancelled while it waited
    if (state.selectedDate !== date || (barberSlug && state.barberSlug !== barberSlug)) return;   // moved on
    if (state.availability === 'ok' && !selectTime(time)) {
      const pill = document.querySelector(`[data-slot-grid] .booking__slot[data-time="${time}"]`);
      if (pill?.classList.contains('is-taken')) setSlotsNote('That time was just booked.');
      else if (pill?.classList.contains('is-past')) setSlotsNote('That time has passed.');
    }
    // Focus moves on unless the customer moved it themselves while waiting.
    if (waitingOn && ![waitingOn, document.body].includes(document.activeElement)) return;
    document.dispatchEvent(new CustomEvent('booking:focus-next'));
  });

  document.querySelector('[data-clear-selected]')?.addEventListener('click', () => { cancelPick(); clearTime(); });
}

/* ---------- A moved booking's day ---------- */

/** Whether this barber has a time on `iso` that is neither booked nor past. */
function hasOpenSlot(iso) {
  const todayIso = isoDate(new Date());
  const nowMin   = nowMinutesInShopTz();
  return slotsForDate(iso, state.barberSlug).some(m =>
    !(iso === todayIso && m <= nowMin) && !state.isTaken(state.barberSlug, iso, m));
}

/** After a Move: the booking's day is selected at once if this barber works
 *  it, and once his availability is read it stays if it still has an open
 *  time; otherwise the next day in the picker that has one. A choice made by
 *  hand meanwhile wins. Resolves to the day selected, or null if none was. */
export async function selectDayFrom(iso) {
  if (locked || !iso) return null;
  const pick = ++pickSeq;
  if (document.querySelector(`[data-day-row] .booking__day[data-date="${iso}"]:not([disabled])`)) selectDate(iso);
  await whenAvailable();
  if (pick !== pickSeq || locked) return null;
  const day = [...document.querySelectorAll('[data-day-row] .booking__day:not([disabled])')]
    .map(b => b.dataset.date).find(d => d >= iso && hasOpenSlot(d));
  if (!day) return null;
  if (day !== state.selectedDate) selectDate(day);
  return day;
}

/* ---------- Auto-refresh: tab visibility + midnight rollover ---------- */

let _cachedToday = null;
function maybeRolloverDay() {
  if (locked) return;                  // caught up on unlock
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
  booted = true;
  // A barber the database no longer offers (deactivated) gives way to the first.
  if (!getBarber(state.barberSlug)) state.barberSlug = barberList()[0]?.slug ?? null;
  bindBarberPicker();
  renderPicker();                   // the barbers on offer, initial aria-checked state
  showNoBarbers(!barberList().length);
  renderDayRow();
  bindExternalPick();
  initAutoRefresh();
  // The "next open slot" lines (cover.js) lead here: they show from now on.
  document.documentElement.setAttribute('data-booking-ready', '');
  document.dispatchEvent(new CustomEvent('booking:ready'));
  await loadAvailability();
}

/** Exposed for booking-submit.js to refresh after a successful book/cancel */
export async function refreshAvailability() {
  await loadAvailability();
}

/** Resolves once the newest availability read has landed (or failed): a
 *  read it supersedes is never waited for, and a read that starts meanwhile is. */
let waiters = [];
export function whenAvailable() {
  if (settledSeq === loadSeq) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}

function settle(seq) {
  settledSeq = seq;
  syncBusy();
  const ready = waiters;
  waiters = [];
  ready.forEach((resolve) => resolve());
}

/** Whether a booking on this barber's chair overlaps the slot at `minutes`
 *  on `iso`: the rule the grid marks taken slots by (the current barber's read). */
export function isSlotTaken(barberSlug, iso, minutes) {
  return state.isTaken(barberSlug, iso, minutes);
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
