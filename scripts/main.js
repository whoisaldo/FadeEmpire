// main.js — entry point. Boots all feature modules.

import { initCover }          from './cover.js';
import { initReveals }        from './reveals.js';
import { initBookingGrid }    from './booking-grid.js';
import { initBookingSubmit }  from './booking-submit.js';
import { initBookingCancel }  from './booking-cancel.js';
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
  // When a new SW takes control of this page (because we bumped the cache
  // version), reload once so the user is running against fresh code. Guard
  // against the very-first install (no prior controller) which would otherwise
  // reload on first visit.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    if (!navigator.serviceWorker.controller) return; // shouldn't fire, but guard
    reloaded = true;
    window.location.reload();
  });
}

ready(() => {
  initCover();
  initReveals();
  initVisit();
  initBookingSubmit();
  initBookingCancel();
  initBookingGrid();           // async; loads availability in the background
  registerSW();
});
