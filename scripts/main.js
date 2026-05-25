// main.js — entry point. Boots all feature modules.

import { initCover }          from './cover.js';
import { initReveals }        from './reveals.js';
import { initBookingGrid }    from './booking-grid.js';
import { initBookingSubmit }  from './booking-submit.js';
import { initVisit }          from './visit.js';

function ready(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[sw] register failed', err);
    });
  });
}

ready(() => {
  initCover();
  initReveals();
  initVisit();
  initBookingSubmit();
  initBookingGrid();           // async; loads availability in the background
  registerSW();
});
