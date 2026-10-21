// booking-link.js — the booking links barbers share from the app.
//
//   /?barber=<slug>&service=<service-slug>#book
//
// picks the barber and the service in the form; page.js lands the page on
// #book. (/<slug> on its own reaches here through 404.html.) A barber the
// shop does not offer, or a service the form does not have, is ignored: the
// form starts as it would without the link. Runs after booking-return.js, so
// a link wins over a returning customer's last barber and service.

import { chooseBarber, barberTouched } from './booking-grid.js';
import { getBarber, rosterIsLive } from './roster.js';

/** The barber and service a link asks for, lowercased, or null. */
export function readBookingLink(search) {
  const params = new URLSearchParams(search || '');
  const value = (key) => (params.get(key) || '').trim().toLowerCase() || null;
  return { barber: value('barber'), service: value('service') };
}

function chooseService(slug) {
  const select = document.querySelector('[data-service-select]');
  if (!select || ![...select.options].some(o => o.value && o.value === slug)) return;
  select.value = slug;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Call before initBookingGrid, once the barbers are in (loadBarbers). */
export function applyBookingLink(search = location.search) {
  const { barber, service } = readBookingLink(search);
  if (service) chooseService(service);
  if (!barber) return;
  if (getBarber(barber)) {
    chooseBarber(barber);
  } else if (!rosterIsLive()) {
    // The barbers were slow and the form started on config.js's: a barber
    // added in the app is picked once they arrive, unless the customer has
    // picked one by hand by then.
    document.addEventListener('booking:barbers', () => {
      if (getBarber(barber) && !barberTouched()) chooseBarber(barber);
    }, { once: true });
  }
}
