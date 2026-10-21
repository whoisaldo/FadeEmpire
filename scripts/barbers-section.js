// barbers-section.js — the barbers section follows the database's barbers.
//
// index.html ships hand-built spreads for Hassan and Larry. Once the active
// barbers are read (booking-grid.js loadBarbers fires `booking:barbers`), a
// spread whose barber is no longer active is hidden, each hours line follows
// the barber's week, and every other active barber gets a plain spread built
// here: photo (when there is one), name, title, bio, and a Book button. The
// heading and the hero line name the barbers on offer, and the hero line
// counts their chairs. With no barber on offer the section and its nav link
// are hidden. Without the read, the page stays as shipped. Needs nothing from
// the database client itself.

import { barberList, getBarber } from './roster.js';
import { barberHoursLabel } from './booking-helpers.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** "Hassan", "Hassan and Larry", "Hassan, Larry and Marcus". */
function nameList(names) {
  if (names.length < 2) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "Hassan.", "Hassan and Larry.", "Hassan, Larry and Marcus." */
export function barbersHeading(names) {
  return `${nameList(names)}.`;
}

const CHAIRS = ['', 'One chair', 'Two chairs', 'Three chairs', 'Four chairs', 'Five chairs', 'Six chairs'];

/** The hero line for the barbers on offer; index.html ships it for Hassan
 *  and Larry. The hours are the shop's (STORE_HOURS). */
export function heroLine(names) {
  const hours = '10 to 6, six days a week.';
  if (!names.length) return `Fades, beards, and line-ups on Memorial Drive, ${hours}`;
  const chairs = CHAIRS[names.length] || `${names.length} chairs`;
  return `${chairs} on Memorial Drive. Fades, beards, and line-ups by ${nameList(names)}, ${hours}`;
}

function barbersDek(count) {
  if (count < 2) return '';
  return `Book whichever chair is open. Prices are the same with ${count === 2 ? 'either' : 'every'} barber.`;
}

function simpleSpread(barber) {
  const spread = el('div', 'feature');
  spread.id = `barber-${barber.slug}`;
  spread.dataset.barberSpread = barber.slug;
  spread.dataset.generated = '';
  if (barber.photoUrl) {
    const figure = el('figure', 'feature__portrait');
    const img = el('img');
    img.src = barber.photoUrl;
    img.width = 800;
    img.height = 1000;
    img.alt = barber.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    figure.append(img);
    spread.append(figure);
  } else {
    spread.classList.add('feature--text');
  }
  const body = el('div', 'feature__body');
  body.append(el('h3', 'feature__name t-display-md', barber.name));
  if (barber.title) body.append(el('p', 'feature__title t-eyebrow', barber.title));
  if (barber.bio) body.append(el('p', '', barber.bio));
  const actions = el('div', 'feature__actions');
  const book = el('button', 'btn btn--gold', `Book with ${barber.name}`);
  book.type = 'button';
  book.dataset.bookBarber = barber.slug;
  actions.append(book, el('span', 't-meta feature__hours'));
  body.append(actions);
  spread.append(body);
  return spread;
}

export function renderBarberSpreads() {
  const section = document.getElementById('barbers');
  const container = section?.querySelector('.container');
  if (!container) return;

  container.querySelectorAll('[data-barber-spread][data-generated]').forEach(s => s.remove());
  const handBuilt = new Set();
  container.querySelectorAll('[data-barber-spread]').forEach(spread => {
    handBuilt.add(spread.dataset.barberSpread);
    spread.hidden = !getBarber(spread.dataset.barberSpread);
  });
  for (const barber of barberList()) {
    if (!handBuilt.has(barber.slug)) container.append(simpleSpread(barber));
  }

  // Alternate the photo side down the visible spreads, as the two built ones do.
  [...container.querySelectorAll('[data-barber-spread][data-generated]')].forEach(spread => {
    const visibleBefore = [...container.querySelectorAll('[data-barber-spread]:not([hidden])')].indexOf(spread);
    spread.classList.toggle('feature--flip', visibleBefore % 2 === 1);
  });
  container.querySelectorAll('[data-barber-spread]:not([hidden])').forEach(spread => {
    const hours = spread.querySelector('.feature__hours');
    if (hours) hours.textContent = barberHoursLabel(spread.dataset.barberSpread, { long: true });
  });
  // A line that sends the customer to another barber goes with that barber.
  container.querySelectorAll('[data-needs-barber]').forEach(line => {
    line.hidden = !getBarber(line.dataset.needsBarber);
  });

  const names = barberList().map(b => b.name);
  section.hidden = !names.length;
  document.querySelectorAll('a[href="#barbers"]').forEach(a => { a.hidden = !names.length; });
  const hero = document.querySelector('[data-hero-dek]');
  if (hero) hero.textContent = heroLine(names);
  const head = section.querySelector('[data-barbers-head]');
  if (head) head.textContent = barbersHeading(names);
  const dek = section.querySelector('[data-barbers-dek]');
  if (dek) {
    dek.textContent = barbersDek(names.length);
    dek.hidden = !dek.textContent;
  }
}

export function initBarberSpreads() {
  document.addEventListener('booking:barbers', renderBarberSpreads);
}
