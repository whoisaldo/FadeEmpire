// page.js — page helpers that need nothing from the database:
//   * the live OPEN / CLOSING SOON / CLOSED stamp in the nav
//   * the status line in the hero ("Open now · Closes 6 PM")
//   * sticky-nav solidification
//   * the phone-only collapse of "Which one do I book?"
//   * the year in the footer
//   * landing on a #fragment once the page has finished growing
// main.js loads this statically, before anything that reaches the database
// client, so none of it depends on that client loading.

import { CLOSING_SOON_MIN } from './config.js';
import { shopStatus } from './booking-helpers.js';

/* ---------- Live status: nav stamp + hero line ---------- */

function updateStatus() {
  const status = shopStatus({ closingSoonMin: CLOSING_SOON_MIN });

  const stamp = document.querySelector('[data-open-stamp]');
  if (stamp) {
    stamp.classList.remove('stamp--open', 'stamp--soon', 'stamp--closed');
    stamp.classList.add(`stamp--${status.state}`);
    const text = stamp.querySelector('.stamp__text');
    if (text) text.textContent = status.label;
  }

  const hero = document.querySelector('[data-hero-status]');
  if (hero) {
    hero.dataset.state = status.state;
    const label  = hero.querySelector('[data-hero-status-label]');
    const detail = hero.querySelector('[data-hero-status-detail]');
    if (label)  label.textContent  = status.label;
    if (detail) detail.textContent = status.detail;
  }
}

/* ---------- Sticky nav ---------- */

function initStickyNav() {
  const nav = document.querySelector('[data-nav]');
  if (!nav) return;
  const onScroll = () => {
    nav.classList.toggle('is-solid', window.scrollY > 32);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

/* ---------- "Which one do I book?" ----------
   A <details> that ships closed so phones never flash the four cards before
   collapsing them. Desktop opens it here (the table should always show) and
   the summary stops toggling: clicks, Enter and Space are all a click on a
   <summary>, so cancelling the click covers mouse and keyboard. The summary
   also leaves the Tab order there, since it does nothing. */

function initCompare() {
  const details = document.querySelector('[data-compare]');
  const summary = details?.querySelector('summary');
  if (!details || !summary || !window.matchMedia) return;
  const phone = window.matchMedia('(max-width: 600px)');
  const sync = () => {
    details.open = !phone.matches;
    if (phone.matches) summary.removeAttribute('tabindex');
    else summary.setAttribute('tabindex', '-1');
  };
  summary.addEventListener('click', (e) => {
    if (!phone.matches) e.preventDefault();
  });
  sync();
  phone.addEventListener?.('change', sync);
}

/* ---------- Footer year ---------- */

function initYear() {
  const el = document.querySelector('[data-year]');
  if (el) el.textContent = new Date().getFullYear();
}

/* ---------- Landing on a #fragment ----------
   On a cold load of /#book, WebKit can jump to the fragment before the fonts,
   the photos and the booking modules have finished laying out, and the
   growth after the jump leaves the form thousands of pixels away. Once the
   page has loaded, the fonts are in and the booking modules have started (or
   3 s have gone by without them), the target is scrolled to once more,
   without the smooth scrolling html has. The browser's own smooth jump may
   still be under way then, and Chromium carries it on past an instant
   scroll, so the page has to sit still for a moment first. A customer who
   scrolled, tapped or focused something in the meantime keeps their place.
   #cancel belongs to booking-cancel.js, which opens the panel and focuses
   its field. */

const BOOKING_WAIT_MS = 3000;
const SCROLL_QUIET_MS = 250;

function scrollSettled() {
  return new Promise((resolve) => {
    const quiet = new AbortController();
    let timer;
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { quiet.abort(); resolve(); }, SCROLL_QUIET_MS);
    };
    window.addEventListener('scroll', wait, { passive: true, signal: quiet.signal });
    wait();
  });
}

function initHashLanding() {
  const id = location.hash.slice(1);
  const target = id && id !== 'cancel' && document.getElementById(id);
  if (!target || document.readyState === 'complete') return;

  let movedOn = false;
  const watch = new AbortController();
  const moved = () => { movedOn = true; watch.abort(); };
  for (const type of ['wheel', 'touchmove', 'pointerdown', 'hashchange']) {
    window.addEventListener(type, moved, { passive: true, signal: watch.signal });
  }
  document.addEventListener('focusin', moved, { signal: watch.signal });
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) moved();
  }, { signal: watch.signal });

  const loaded = new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  const booking = new Promise((resolve) => {
    if (document.documentElement.hasAttribute('data-booking-ready')) return resolve();
    document.addEventListener('booking:ready', resolve, { once: true });
    setTimeout(resolve, BOOKING_WAIT_MS);
  });
  Promise.all([loaded, document.fonts?.ready, booking]).then(scrollSettled).then(() => {
    watch.abort();
    if (movedOn) return;
    const root = document.documentElement;
    const before = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
    root.style.scrollBehavior = before;
  });
}

/* ---------- Boot ---------- */

export function initPage() {
  initStickyNav();
  initCompare();
  initYear();
  initHashLanding();
  updateStatus();
  setInterval(updateStatus, 60_000);
}
