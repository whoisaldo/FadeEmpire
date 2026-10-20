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

async function updateNextAvailable() {
  let next;
  try {
    next = await fetchNextAvailable();
  } catch (err) {
    console.warn('[cover] next available lookup failed', err);   // network trouble: leave the lines hidden
    return;
  }
  if (!next) return;

  const fill = (textSel, showSel, label) => {
    const text = document.querySelector(textSel);
    const show = document.querySelector(showSel);
    if (text) text.textContent = label;
    if (show) show.hidden = false;
  };
  fill('[data-next-available-slot]',          '[data-next-available]',         next.label);
  fill('[data-next-available-slot-callout]',  '[data-next-available-callout]', next.label);
  fill('[data-mobile-cta-next-slot]',         '[data-mobile-cta-next]',        next.shortLabel || next.label);

  // "Take it" in the booking section hands the slot to the grid.
  const pickBtn = document.querySelector('[data-pick-next]');
  if (pickBtn) {
    pickBtn.onclick = () => {
      document.dispatchEvent(new CustomEvent('booking:pick', { detail: next }));
      document.getElementById('book')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
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

/* While the menu is open it is the only thing a keyboard can reach: focus
   starts on the first link, Tab cycles through the links and the toggle,
   Escape closes, and the rest of the page is inert (aria-hidden where the
   browser has no inert). Closing hands focus back to the toggle. */

function initMobileNav() {
  const nav    = document.querySelector('[data-nav]');
  const toggle = document.querySelector('[data-nav-toggle]');
  if (!nav || !toggle) return;

  const links = [...nav.querySelectorAll('.nav__link')];
  const cycle = [...links, toggle];
  const hasInert = 'inert' in HTMLElement.prototype;
  let walled = [];   // [element, its aria-hidden before the menu opened]

  const isOpen = () => nav.hasAttribute('data-nav-open');

  const wallOff = () => {
    walled = [...document.body.children]
      .filter((el) => el !== nav && !el.contains(nav) && el.tagName !== 'SCRIPT')
      .map((el) => [el, el.getAttribute('aria-hidden')]);
    walled.forEach(([el]) => {
      el.setAttribute('inert', '');
      if (!hasInert) el.setAttribute('aria-hidden', 'true');
    });
  };
  const unwall = () => {
    walled.forEach(([el, ariaHidden]) => {
      el.removeAttribute('inert');
      if (hasInert) return;
      if (ariaHidden == null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', ariaHidden);
    });
    walled = [];
  };

  const close = ({ restoreFocus = true } = {}) => {
    if (!isOpen()) return;
    nav.removeAttribute('data-nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    document.body.style.overflow = '';
    unwall();
    if (restoreFocus) toggle.focus();
  };
  const open = () => {
    nav.setAttribute('data-nav-open', '');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    document.body.style.overflow = 'hidden';
    wallOff();
    links[0]?.focus();
  };

  toggle.addEventListener('click', () => {
    isOpen() ? close() : open();
  });
  // A link jumps to its section, so focus goes with it, not back to the toggle.
  links.forEach((a) => a.addEventListener('click', () => close({ restoreFocus: false })));

  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const at = cycle.indexOf(document.activeElement);
    const step = e.shiftKey ? -1 : 1;
    const next = at < 0 ? (e.shiftKey ? cycle.length - 1 : 0) : (at + step + cycle.length) % cycle.length;
    cycle[next].focus();
  });

  // Widening past the phone layout turns the sheet back into the inline nav.
  window.matchMedia?.('(min-width: 900px)').addEventListener?.('change', (e) => {
    if (e.matches) close({ restoreFocus: false });
  });
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
