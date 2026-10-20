// main.js — entry point. Boots all feature modules.
//
// The page modules that need nothing from the database load statically,
// the mobile menu (nav.js) and the page helpers (page.js) first. cover.js and
// the booking modules reach the database client, so they load through dynamic
// imports: if one of them fails, the rest of the page still works, and the
// booking section says how to book instead.

import { initMobileNav }      from './nav.js';
import { initPage }           from './page.js';
import { initReveals }        from './reveals.js';
import { initShopVideo }      from './shop-video.js';
import { initGallery }        from './gallery.js';
import { initVisit }          from './visit.js';
import { SHOP_PHONE }         from './config.js';

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

function showBookingUnavailable() {
  const container = document.querySelector('#book .container');
  if (!container || container.querySelector('[data-booking-offline]')) return;
  const note = document.createElement('p');
  note.className = 'booking-offline';
  note.dataset.bookingOffline = '';
  note.setAttribute('role', 'status');
  const call = document.createElement('a');
  call.href = `tel:+${SHOP_PHONE}`;
  call.textContent = '413·885·4440';
  note.append("Online booking isn't loading. Call ", call, ' or walk in.');
  container.prepend(note);
}

ready(() => {
  registerSW();
  initMobileNav();
  initPage();
  initReveals();
  initShopVideo();
  initGallery();
  initVisit();

  // cover.js and the three booking modules load side by side and fail on
  // their own: a booking module that fails shows the notice at once, without
  // waiting on cover.js or the other two.
  import('./cover.js')
    .then((cover) => cover.initCover())
    .catch((err) => console.warn('[main] next open slot and sticky bar failed to start', err));

  const bookingFailed = (err) => {
    console.warn('[main] booking failed to start', err);
    showBookingUnavailable();
  };
  const load = (module) => module.catch((err) => { bookingFailed(err); throw err; });
  Promise.all([
    load(import('./booking-grid.js')),
    load(import('./booking-submit.js')),
    load(import('./booking-cancel.js')),
  ]).then(([grid, submit, cancel]) => {
    try {
      submit.initBookingSubmit();
      cancel.initBookingCancel();
      grid.initBookingGrid();  // async; loads availability in the background
    } catch (err) {
      bookingFailed(err);
    }
  }, () => {});                // each failed import has already shown the notice
});
