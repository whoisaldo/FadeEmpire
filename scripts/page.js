// page.js — page helpers that need nothing from the database:
//   * the live OPEN / CLOSING SOON / CLOSED stamp in the nav
//   * the status line in the hero ("Open now · Closes 6 PM")
//   * sticky-nav solidification
//   * the phone-only collapse of "Which one do I book?"
//   * the year in the footer
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

/* ---------- Boot ---------- */

export function initPage() {
  initStickyNav();
  initCompare();
  initYear();
  updateStatus();
  setInterval(updateStatus, 60_000);
}
