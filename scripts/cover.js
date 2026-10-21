// cover.js — the parts of the page outside #book that lead into booking:
//   * the "next open slot" lines (hero, booking callout, sticky bar), which
//     read the database and show only once the booking modules have started
//     (booking:ready / data-booking-ready), with Reserve it and Take it
//   * the sticky CTA bar, kept away while the booking section shows
// Everything else on the page that needs no database lives in page.js and
// nav.js, so it keeps working when the database client fails to load.

import { fetchNextAvailable } from './booking-rpc.js';

/* ---------- Next open slot ---------- */

const NEXT_SLOT_LINES = ['[data-next-available]', '[data-next-available-callout]', '[data-mobile-cta-next]'];

async function updateNextAvailable() {
  // The lines lead into the booking form, so none until its modules are up
  // (booking-grid.js says so); if they never load, the lines never show.
  if (!document.documentElement.hasAttribute('data-booking-ready')) {
    NEXT_SLOT_LINES.forEach(sel => { const el = document.querySelector(sel); if (el) el.hidden = true; });
    document.addEventListener('booking:ready', updateNextAvailable, { once: true });
    return;
  }
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
  // the advertised barber, day and time to the grid, which then moves focus
  // (and the page) to the next step still to do.
  document.querySelectorAll('[data-pick-next]').forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('booking:pick', { detail: next }));
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

  // Hide while any of the booking section is on screen (it would be
  // redundant) or a booking control has focus (it would cover the next field
  // when the keyboard shrinks the view). The section is taller than a short
  // viewport, so any visible part counts, not a share of it.
  let bookInView = false;
  let bookFocused = false;
  const syncBook = () => cta.classList.toggle('is-in-book', bookInView || bookFocused);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([entry]) => {
      bookInView = entry.isIntersecting;
      syncBook();
    }, { threshold: 0 });
    io.observe(book);
  }
  book.addEventListener('focusin', () => { bookFocused = true; syncBook(); });
  book.addEventListener('focusout', (e) => { bookFocused = book.contains(e.relatedTarget); syncBook(); });

  const onScroll = () => setVisible(window.scrollY > showAfter());
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
}

/* ---------- Boot ---------- */

export function initCover() {
  initMobileCta();
  updateNextAvailable();
  setInterval(updateNextAvailable, 5 * 60_000);
  // The barbers arrived after the lines were filled (a slow read): the next
  // slot may belong to a barber who is new, or gone.
  document.addEventListener('booking:barbers', () => {
    if (document.documentElement.hasAttribute('data-booking-ready')) updateNextAvailable();
  });
}
