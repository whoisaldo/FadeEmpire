// cover.js — hero/nav helpers:
//   * live OPEN / CLOSING SOON / CLOSED stamp in the nav
//   * the "Next Available" hero banner (also mirrored into the booking section)
//   * the issue-number badge in the hero eyebrow
//   * sticky-nav solidification on scroll
//   * year injection in footer

import { STORE_HOURS, CLOSING_SOON_MIN } from './config.js';
import { nowMinutesInShopTz, shopWeekday } from './booking-helpers.js';
import { fetchNextAvailable } from './booking-rpc.js';

/* ---------- OPEN / CLOSED stamp ---------- */

function updateOpenStamp() {
  const el = document.querySelector('[data-open-stamp]');
  if (!el) return;
  const wk    = shopWeekday();
  const sched = STORE_HOURS[wk];
  const nowM  = nowMinutesInShopTz();

  let state = 'closed';
  let label = 'Closed';

  if (sched && nowM >= sched.open && nowM < sched.close) {
    if (sched.close - nowM <= CLOSING_SOON_MIN) {
      state = 'soon';
      label = 'Closing Soon';
    } else {
      state = 'open';
      label = 'Open Now';
    }
  }

  el.classList.remove('stamp--open', 'stamp--soon', 'stamp--closed');
  el.classList.add(`stamp--${state}`);
  const text = el.querySelector('.stamp__text');
  if (text) text.textContent = label;
}

/* ---------- Issue number ---------- */

function updateIssueNumber() {
  const el = document.querySelector('[data-issue-no]');
  if (!el) return;
  // Issue 1 = week of launch (Jan 1 2026); incremented weekly thereafter.
  const launch = new Date('2026-01-05T00:00:00-05:00');
  const weeks  = Math.max(0, Math.floor((Date.now() - launch.getTime()) / (7 * 86400000)));
  el.textContent = String(weeks + 1).padStart(3, '0');
}

/* ---------- Next available banner ---------- */

async function updateNextAvailable() {
  const heroBanner    = document.querySelector('[data-next-available]');
  const bookingPill   = document.querySelector('[data-next-available-callout]');
  const mobileNext    = document.querySelector('[data-mobile-cta-next]');
  const mobileSlot    = document.querySelector('[data-mobile-cta-next-slot]');

  try {
    const next = await fetchNextAvailable();
    if (!next) return;

    const slotEl = document.querySelector('[data-next-available-slot]');
    if (slotEl) slotEl.textContent = next.label;
    if (heroBanner) heroBanner.hidden = false;

    const bookingSlotEl = document.querySelector('[data-next-available-slot-callout]');
    if (bookingSlotEl) bookingSlotEl.textContent = next.label;
    if (bookingPill) bookingPill.hidden = false;

    if (mobileSlot) mobileSlot.textContent = next.label;
    if (mobileNext) mobileNext.hidden = false;

    // "Pick this" button in the booking section hands the slot to the grid.
    const pickBtn = document.querySelector('[data-pick-next]');
    if (pickBtn) {
      pickBtn.onclick = () => {
        document.dispatchEvent(new CustomEvent('booking:pick', { detail: next }));
        document.getElementById('book')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    }
  } catch (err) {
    // Network problem — just hide the banner, don't surface anything.
    console.warn('[cover] next available lookup failed', err);
  }
}

/* ---------- Sticky mobile CTA bar visibility ---------- */

function initMobileCta() {
  const cta  = document.querySelector('[data-mobile-cta]');
  const book = document.getElementById('book');
  if (!cta || !book) return;

  // Show the CTA bar once the user scrolls past the hero (~one viewport height).
  const showAfter = () => window.innerHeight * 0.6;

  let visible = false;
  const setVisible = (v) => {
    if (v === visible) return;
    visible = v;
    cta.classList.toggle('is-visible', v);
    cta.setAttribute('aria-hidden', v ? 'false' : 'true');
  };

  // Hide when the booking section is on screen (it would be redundant).
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

/* ---------- Sticky nav solidification ---------- */

function initStickyNav() {
  const nav = document.querySelector('[data-nav]');
  if (!nav) return;
  const onScroll = () => {
    nav.classList.toggle('is-solid', window.scrollY > 32);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

/* ---------- Mobile menu toggle ---------- */

function initMobileNav() {
  const nav    = document.querySelector('[data-nav]');
  const toggle = document.querySelector('[data-nav-toggle]');
  if (!nav || !toggle) return;

  const close = () => {
    nav.removeAttribute('data-nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  };
  const open = () => {
    nav.setAttribute('data-nav-open', '');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  };

  toggle.addEventListener('click', () => {
    nav.hasAttribute('data-nav-open') ? close() : open();
  });
  nav.querySelectorAll('.nav__link').forEach(a => a.addEventListener('click', close));
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
  initYear();
  updateIssueNumber();
  updateOpenStamp();
  setInterval(updateOpenStamp, 60_000); // re-check every minute
  updateNextAvailable();
  setInterval(updateNextAvailable, 5 * 60_000); // re-check every 5 min
}
