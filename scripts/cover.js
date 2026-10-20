// cover.js — nav and hero helpers:
//   * the live OPEN / CLOSING SOON / CLOSED stamp in the nav
//   * the status line in the hero ("Open now · Closes 6 PM")
//   * the "next open slot" line (hero, booking callout, sticky bar)
//   * sticky-nav solidification, the mobile menu, the sticky CTA bar
//   * the year in the footer

import { CLOSING_SOON_MIN } from './config.js';
import { shopStatus } from './booking-helpers.js';
import { fetchNextAvailable } from './booking-rpc.js';

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

/* ---------- Next open slot ---------- */

const NEXT_SLOT_LINES = ['[data-next-available]', '[data-next-available-callout]', '[data-mobile-cta-next]'];

async function updateNextAvailable() {
  let next;
  try {
    next = await fetchNextAvailable();
  } catch (err) {
    console.warn('[cover] next available lookup failed', err);
  }
  // No claim about a free slot without a successful read that found one.
  if (!next) {
    NEXT_SLOT_LINES.forEach(sel => { const el = document.querySelector(sel); if (el) el.hidden = true; });
    return;
  }

  const fill = (textSel, showSel, label) => {
    const text = document.querySelector(textSel);
    const show = document.querySelector(showSel);
    if (text) text.textContent = label;
    if (show) show.hidden = false;
  };
  fill('[data-next-available-slot]',          '[data-next-available]',         next.label);
  fill('[data-next-available-slot-callout]',  '[data-next-available-callout]', next.label);
  fill('[data-mobile-cta-next-slot]',         '[data-mobile-cta-next]',        next.shortLabel || next.label);

  // "Reserve it" in the hero and "Take it" in the booking section both hand
  // the advertised barber, day and time to the grid.
  document.querySelectorAll('[data-pick-next]').forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('booking:pick', { detail: next }));
      document.getElementById('book')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
}

/* ---------- Sticky mobile CTA bar ---------- */

function initMobileCta() {
  const cta  = document.querySelector('[data-mobile-cta]');
  const book = document.getElementById('book');
  if (!cta || !book) return;

  // Show the bar once the user scrolls past most of the hero.
  const showAfter = () => window.innerHeight * 0.6;

  let visible = false;
  const setVisible = (v) => {
    if (v === visible) return;
    visible = v;
    cta.classList.toggle('is-visible', v);
    cta.setAttribute('aria-hidden', v ? 'false' : 'true');
  };

  // Hide while the booking section is on screen (it would be redundant).
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([entry]) => {
      cta.classList.toggle('is-in-book', entry.isIntersecting);
    }, { threshold: 0.18 });
    io.observe(book);
  }

  const onScroll = () => setVisible(window.scrollY > showAfter());
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
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

/* ---------- Mobile menu ---------- */

function initMobileNav() {
  const nav    = document.querySelector('[data-nav]');
  const toggle = document.querySelector('[data-nav-toggle]');
  if (!nav || !toggle) return;

  const close = () => {
    nav.removeAttribute('data-nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    document.body.style.overflow = '';
  };
  const open = () => {
    nav.setAttribute('data-nav-open', '');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    document.body.style.overflow = 'hidden';
  };

  toggle.addEventListener('click', () => {
    nav.hasAttribute('data-nav-open') ? close() : open();
  });
  nav.querySelectorAll('.nav__link').forEach(a => a.addEventListener('click', close));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.hasAttribute('data-nav-open')) close();
  });
}

/* ---------- "Which one do I book?" ----------
   A <details> that ships closed so phones never flash the four cards before
   collapsing them. Desktop opens it here (the table should always show) and
   the summary goes inert through CSS once open. */

function initCompare() {
  const details = document.querySelector('[data-compare]');
  if (!details || !window.matchMedia) return;
  const phone = window.matchMedia('(max-width: 600px)');
  const sync = () => { details.open = !phone.matches; };
  sync();
  phone.addEventListener?.('change', sync);
}

/* ---------- Footer year ---------- */

function initYear() {
  const el = document.querySelector('[data-year]');
  if (el) el.textContent = new Date().getFullYear();
}

/* ---------- Boot ---------- */

export function initCover() {
  initStickyNav();
  initMobileNav();
  initMobileCta();
  initCompare();
  initYear();
  updateStatus();
  setInterval(updateStatus, 60_000);
  updateNextAvailable();
  setInterval(updateNextAvailable, 5 * 60_000);
}
