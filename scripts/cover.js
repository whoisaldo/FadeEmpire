// cover.js — the parts of the nav and hero that touch booking:
//   * the "next open slot" line (hero, booking callout, sticky bar), which
//     reads the database
//   * the sticky CTA bar
// Everything else on the page that needs no database lives in page.js and
// nav.js, so it keeps working when the database client fails to load.

import { fetchNextAvailable } from './booking-rpc.js';

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

/* ---------- Boot ---------- */

export function initCover() {
  initMobileCta();
  updateNextAvailable();
  setInterval(updateNextAvailable, 5 * 60_000);
}
