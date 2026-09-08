// main.js — entry point. Boots all feature modules.

import { initCover }          from './cover.js';
import { initReveals }        from './reveals.js';
import { initShopVideo }      from './shop-video.js';
import { initGallery }        from './gallery.js';
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
  // When a NEW worker takes over an already-controlled page (we bumped the
  // cache version), reload once so the visitor runs the fresh code. On the
  // very first visit there is no controller yet; the new worker claims the
  // page and `controllerchange` fires, but reloading there would restart the
  // page mid-load and abort the availability fetch, so that case is skipped.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

ready(() => {
  initCover();
  initReveals();
  initShopVideo();
  initGallery();
  initVisit();
  initBookingSubmit();
  initBookingCancel();
  initBookingGrid();           // async; loads availability in the background
  registerSW();
});
