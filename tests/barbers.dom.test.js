// @vitest-environment jsdom
//
// The site follows the database's barbers: the real #barbers and #book
// markup from index.html with the real modules, booted the way main.js boots
// them (barbers read first, then the returning customer, then a booking link,
// then the grid). Only the RPC layer is mocked. Covers:
//   * the picker built from the database: a third barber appears and books,
//     a deactivated one is gone, a day off shows, a failed or slow read
//   * the barbers section: a deactivated barber's spread hidden, a plain
//     spread for any other active barber, the heading
//   * booking links: ?barber=&service= picks both; bad values change nothing

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rosterFromRows } from '../scripts/roster.js';

vi.mock('../scripts/booking-rpc.js', () => {
  class BookingError extends Error {
    constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
  }
  return {
    BookingError,
    bookSlot:            vi.fn(async () => []),
    bookSlotGroup:       vi.fn(async () => []),
    logBookingError:     vi.fn(async () => {}),
    fetchAvailability:   vi.fn(async () => []),
    fetchNextAvailable:  vi.fn(async () => null),
    fetchBarbers:        vi.fn(async () => []),
    findBookingsByPhone: vi.fn(async () => []),
    cancelBooking:       vi.fn(async () => {}),
  };
});

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: globalThis.jsdom.window.localStorage });

const __dir = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
function section(id) {
  const open = indexHtml.match(new RegExp(`<section[^>]*\\sid="${id}"[^>]*>`));
  expect(open, `<section id="${id}">`).toBeTruthy();
  const end = indexHtml.indexOf('</section>', open.index);
  return indexHtml.slice(open.index, end + '</section>'.length);
}

// Monday 2026-07-06, 10:00 AM in Chicopee.
const FIXED_NOW = new Date('2026-07-06T14:00:00Z');

const days = (open, close, list) => list.map(weekday => ({ weekday, open_time: open, close_time: close }));
const OPEN_DAYS = [0, 1, 3, 4, 5, 6];
const HASSAN = { slug: 'hassan', display_name: 'Hassan', title: 'Master Barber', bio: 'Licensed.', photo_url: null,
  barber_schedules: days('10:00:00', '18:00:00', OPEN_DAYS), barber_closures: [] };
const LARRY = { slug: 'larry', display_name: 'Larry', title: 'Barber', bio: null, photo_url: null,
  barber_schedules: days('10:00:00', '18:00:00', OPEN_DAYS), barber_closures: [] };
// Added in the app: Wednesday to Saturday, noon to six, no photo yet.
const MARCUS = { slug: 'marcus', display_name: 'Marcus', title: 'Barber', bio: 'Tapers and skin fades.', photo_url: null,
  barber_schedules: days('12:00:00', '18:00:00', [3, 4, 5, 6]), barber_closures: [] };

let rpc, grid;
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const pickerSlugs = () => $$('[data-barber-option]').map(b => b.dataset.barberOption);
const checked = () => $('[data-barber-option][aria-checked="true"]')?.dataset.barberOption;
const visibleSpreads = () => $$('[data-barber-spread]:not([hidden])').map(s => s.dataset.barberSpread);

/** The database answers with these rows (or rejects with an Error). */
function database(rows, { delayMs = 0 } = {}) {
  rpc.fetchBarbers.mockImplementation(() => new Promise((resolve, reject) => setTimeout(() => (
    rows instanceof Error ? reject(rows) : resolve(rosterFromRows(rows))), delayMs)));
}

/** main.js's order, with the barbers' wait shortened for the slow-read tests. */
async function boot({ search = '', waitMs = 200 } = {}) {
  document.body.innerHTML = section('barbers') + section('book');
  const spreads = await import('../scripts/barbers-section.js');
  grid = await import('../scripts/booking-grid.js');
  const submit = await import('../scripts/booking-submit.js');
  const cancel = await import('../scripts/booking-cancel.js');
  const ret = await import('../scripts/booking-return.js');
  const link = await import('../scripts/booking-link.js');
  spreads.initBarberSpreads();
  submit.initBookingSubmit();
  cancel.initBookingCancel();
  await grid.loadBarbers({ waitMs });
  ret.initBookingReturn();
  link.applyBookingLink(search);
  await grid.initBookingGrid();
}

const realAddListener = document.addEventListener.bind(document);
let docListeners = [];
document.addEventListener = (type, fn, opts) => {
  docListeners.push([type, fn, opts]);
  return realAddListener(type, fn, opts);
};

function fill(sel, value) {
  const el = $(sel);
  el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
const chip = (iso) => $(`[data-day-row] .booking__day[data-date="${iso}"]`);
const pills = () => $$('[data-slot-grid] .booking__slot').map(p => p.dataset.time);

beforeEach(async () => {
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.resetModules();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  Element.prototype.scrollIntoView = vi.fn();
  window.open = vi.fn().mockReturnValue({ closed: false, close: vi.fn(), location: {} });
  rpc = await import('../scripts/booking-rpc.js');
  rpc.fetchAvailability.mockResolvedValue([]);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  docListeners.forEach(([type, fn, opts]) => document.removeEventListener(type, fn, opts));
  docListeners = [];
  document.body.innerHTML = '';
});

/* ================= The picker ================= */

describe('the picker follows the database', () => {
  it('a barber added in the app appears after the two built ones, with the barber\'s own hours', async () => {
    database([HASSAN, LARRY, MARCUS]);
    await boot();
    expect(pickerSlugs()).toEqual(['hassan', 'larry', 'marcus']);
    const marcus = $('[data-barber-option="marcus"]');
    expect(marcus.getAttribute('role')).toBe('radio');
    expect(marcus.getAttribute('aria-checked')).toBe('false');
    expect(marcus.querySelector('.booking__barber-name').textContent).toBe('Marcus');
    expect(marcus.querySelector('.booking__barber-hours').textContent).toBe('12 to 6 · Off Sun, Mon, Tue');
    expect(marcus.querySelector('img')).toBeNull();              // no photo yet: no photo block
    // The shipped buttons stay, face crops and all.
    expect($('[data-barber-option="hassan"] img').getAttribute('src')).toBe('./assets/img/hassan-face-160.jpg');
    expect($('[data-barber-option="hassan"] .booking__barber-hours').textContent).toBe('10 to 6 · Closed Tue');
  });

  it('a photo from the app shows in the picker button', async () => {
    database([HASSAN, { ...MARCUS, photo_url: 'https://cdn.test/barber-photos/marcus.jpg' }]);
    await boot();
    const img = $('[data-barber-option="marcus"] img.booking__barber-photo');
    expect(img.getAttribute('src')).toBe('https://cdn.test/barber-photos/marcus.jpg');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('width')).toBe('52');
  });

  it('the third barber\'s days, times and availability are the barber\'s own, and the booking goes through', async () => {
    database([HASSAN, LARRY, MARCUS]);
    await boot();
    $('[data-barber-option="marcus"]').click();
    await vi.waitFor(() => expect($('[data-slot-grid] .booking__slot.is-loading')).toBeNull());

    expect(rpc.fetchAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ barberSlug: 'marcus' }));
    expect(chip('2026-07-06').textContent).toContain('Off');     // Monday: the shop is open, Marcus is not in
    expect(chip('2026-07-06').disabled).toBe(true);
    expect(chip('2026-07-07').textContent).toContain('Closed');  // Tuesday: the shop is closed
    expect(chip('2026-07-08').getAttribute('aria-selected')).toBe('true');
    expect(pills()).toEqual(['12:00:00', '12:45:00', '13:30:00', '14:15:00', '15:00:00', '15:45:00', '16:30:00', '17:15:00']);
    expect($('[data-slots-day-label]').textContent).toBe('Wednesday, Jul 8 · Marcus');

    rpc.bookSlot.mockResolvedValue([{ booking_id: 'm1', slot_index: 0, booking_time: '12:45:00', total_price_cents: 3000 }]);
    $('[data-slot-grid] .booking__slot[data-time="12:45:00"]').click();
    fill('input[name="name"]', 'Test Customer');
    fill('input[name="phone"]', '4135550123');
    fill('[data-service-select]', 'hair-cut');
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    expect(rpc.bookSlot).toHaveBeenCalledWith(expect.objectContaining({
      barberSlug: 'marcus', date: '2026-07-08', time: '12:45:00', serviceSlug: 'hair-cut',
    }));
    expect($('[data-success-text]').textContent).toBe('Wednesday, July 8 · Marcus');
  });

  it('a deactivated barber is gone from the picker', async () => {
    database([HASSAN, MARCUS]);
    await boot();
    expect(pickerSlugs()).toEqual(['hassan', 'marcus']);
    expect(checked()).toBe('hassan');
  });

  it('when the default barber is deactivated the form starts on the first one still offered', async () => {
    database([LARRY]);
    await boot();
    expect(pickerSlugs()).toEqual(['larry']);
    expect(checked()).toBe('larry');
    expect(rpc.fetchAvailability).toHaveBeenCalledWith(expect.objectContaining({ barberSlug: 'larry' }));
  });

  it('a returning customer whose barber was deactivated starts fresh', async () => {
    localStorage.setItem('fe.lastBooking', JSON.stringify({
      name: 'Ana', phone: '4135550123', barberSlug: 'larry', serviceSlug: 'hair-cut', addons: [],
    }));
    database([HASSAN]);
    await boot();
    expect($('[data-rebook]').hidden).toBe(true);
    expect(checked()).toBe('hassan');
  });

  it('a returning customer of a barber added in the app is welcomed back to the same barber', async () => {
    localStorage.setItem('fe.lastBooking', JSON.stringify({
      name: 'Ana', phone: '4135550123', barberSlug: 'marcus', serviceSlug: 'hair-cut', addons: [],
    }));
    database([HASSAN, LARRY, MARCUS]);
    await boot();
    expect($('[data-rebook-text]').textContent).toBe('Welcome back, Ana. Same as last time: Marcus, Hair Cut. Pick a day.');
    expect(checked()).toBe('marcus');
  });

  it('a day off from the app closes that day for that barber only', async () => {
    database([{ ...HASSAN, barber_closures: [{ closure_date: '2026-07-08' }] }, LARRY]);
    await boot();
    expect(chip('2026-07-08').disabled).toBe(true);
    expect(chip('2026-07-08').textContent).toContain('Off');
    $('[data-barber-option="larry"]').click();
    expect(chip('2026-07-08').disabled).toBe(false);
  });

  it('a failed read keeps config.js\'s barbers, the shipped buttons, and the shipped spreads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    database(new Error('offline'));
    await boot();
    expect(pickerSlugs()).toEqual(['hassan', 'larry']);
    expect($('[data-barber-option="larry"] img').getAttribute('src')).toBe('./assets/img/larry-face-160.jpg');
    expect(checked()).toBe('hassan');
    expect(visibleSpreads()).toEqual(['hassan', 'larry']);
    expect($('[data-barbers-head]').textContent).toBe('Hassan and Larry.');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('barbers not read'), expect.any(Error));
    // Both still book.
    $('[data-barber-option="larry"]').click();
    expect(checked()).toBe('larry');
  });

  it('an answer with no bookable barber keeps config.js\'s too', async () => {
    database([{ ...MARCUS, barber_schedules: [] }]);
    await boot();
    expect(pickerSlugs()).toEqual(['hassan', 'larry']);
  });

  it('a slow read: the form starts on config.js\'s barbers, then follows the database when it lands', async () => {
    database([HASSAN, MARCUS], { delayMs: 150 });
    await boot({ waitMs: 20 });
    expect(pickerSlugs()).toEqual(['hassan', 'larry']);
    expect(visibleSpreads()).toEqual(['hassan', 'larry']);

    await vi.waitFor(() => expect(pickerSlugs()).toEqual(['hassan', 'marcus']));
    expect(checked()).toBe('hassan');
    expect(visibleSpreads()).toEqual(['hassan', 'marcus']);
  });

  it('a slow read that drops the barber being looked at moves the form to the first one offered', async () => {
    database([HASSAN], { delayMs: 150 });
    await boot({ waitMs: 20 });
    $('[data-barber-option="larry"]').click();
    await vi.waitFor(() => expect(pickerSlugs()).toEqual(['hassan']));
    expect(checked()).toBe('hassan');
    expect(rpc.fetchAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ barberSlug: 'hassan' }));
  });
});

/* ================= The barbers section ================= */

describe('the barbers section follows the database', () => {
  it('a deactivated barber\'s spread is hidden, and the heading names who is left', async () => {
    database([HASSAN]);
    await boot();
    expect($('#larry').hidden).toBe(true);
    expect($('#hassan').hidden).toBe(false);
    expect($('[data-barbers-head]').textContent).toBe('Hassan.');
    expect($('[data-barbers-dek]').hidden).toBe(true);           // "either barber" says nothing with one
  });

  it('any other active barber gets a plain spread: name, title, bio, hours, and a Book button that picks that barber', async () => {
    database([HASSAN, LARRY, MARCUS]);
    await boot();
    expect(visibleSpreads()).toEqual(['hassan', 'larry', 'marcus']);
    const spread = $('[data-barber-spread="marcus"]');
    expect(spread.id).toBe('barber-marcus');
    expect(spread.classList.contains('feature--text')).toBe(true);   // no photo: no photo block
    expect(spread.querySelector('figure')).toBeNull();
    expect(spread.querySelector('.feature__name').textContent).toBe('Marcus');
    expect(spread.querySelector('.feature__title').textContent).toBe('Barber');
    expect([...spread.querySelectorAll('.feature__body > p')].map(p => p.textContent)).toEqual(['Barber', 'Tapers and skin fades.']);
    expect(spread.querySelector('.feature__hours').textContent).toBe('12 PM to 6 PM · Off Sundays, Mondays and Tuesdays');
    expect(spread.classList.contains('feature--flip')).toBe(false);  // third visible: photo side back on the left
    expect(spread.querySelector('.reveal')).toBeNull();               // nothing waits on a scroll reveal
    expect($('[data-barbers-head]').textContent).toBe('Hassan, Larry and Marcus.');
    expect($('[data-barbers-dek]').textContent).toBe('Book whichever chair is open. Prices are the same with every barber.');

    const book = spread.querySelector('[data-book-barber="marcus"]');
    expect(book.textContent).toBe('Book with Marcus');
    book.click();
    expect(checked()).toBe('marcus');
  });

  it('a photo from the app fills the portrait, and the plain spread takes the flip in turn', async () => {
    database([HASSAN, { ...MARCUS, photo_url: 'https://cdn.test/m.jpg', title: null, bio: null }]);
    await boot();
    const spread = $('[data-barber-spread="marcus"]');
    const img = spread.querySelector('figure.feature__portrait img');
    expect(img.getAttribute('src')).toBe('https://cdn.test/m.jpg');
    expect(img.getAttribute('alt')).toBe('Marcus');
    expect(spread.classList.contains('feature--flip')).toBe(true);   // second visible spread
    expect(spread.querySelector('.feature__title')).toBeNull();      // no title, no empty line
    expect([...spread.querySelectorAll('.feature__body > p')]).toHaveLength(0);
  });

  it('the built spreads\' hours lines follow the barber\'s week from the app', async () => {
    database([HASSAN, { ...LARRY, barber_schedules: days('12:00:00', '18:00:00', [3, 4, 5, 6]) }]);
    await boot();
    expect($('#hassan .feature__hours').textContent).toBe('10 AM to 6 PM · Closed Tuesdays');
    expect($('#larry .feature__hours').textContent).toBe('12 PM to 6 PM · Off Sundays, Mondays and Tuesdays');
  });

  it('text from the database is text, never markup', async () => {
    database([HASSAN, { ...MARCUS, display_name: '<img src=x onerror=alert(1)>', bio: '<b>bold</b>' }]);
    await boot();
    const spread = $('[data-barber-spread="marcus"]');
    expect(spread.querySelector('.feature__name').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(spread.querySelector('b')).toBeNull();
    expect($('[data-barber-option="marcus"] img')).toBeNull();
  });
});

/* ================= Booking links ================= */

describe('booking links (?barber=&service=)', () => {
  it('picks the barber and the service, and that barber\'s grid is the first one read', async () => {
    database([HASSAN, LARRY]);
    await boot({ search: '?barber=larry&service=vip-haircut' });
    expect(checked()).toBe('larry');
    expect($('[data-service-select]').value).toBe('vip-haircut');
    expect($('[data-total-display]').textContent).toBe('$60');
    expect(rpc.fetchAvailability).toHaveBeenCalledTimes(1);
    expect(rpc.fetchAvailability).toHaveBeenCalledWith(expect.objectContaining({ barberSlug: 'larry' }));
  });

  it('a barber added in the app can be linked', async () => {
    database([HASSAN, LARRY, MARCUS]);
    await boot({ search: '?barber=marcus' });
    expect(checked()).toBe('marcus');
    expect(chip('2026-07-08').getAttribute('aria-selected')).toBe('true');
  });

  it('is case- and space-tolerant', async () => {
    database([HASSAN, LARRY]);
    await boot({ search: '?barber=%20Larry%20&service=VIP-Haircut' });
    expect(checked()).toBe('larry');
    expect($('[data-service-select]').value).toBe('vip-haircut');
  });

  it('an unknown barber, an inactive barber, or an unknown service changes nothing', async () => {
    database([HASSAN, LARRY]);
    await boot({ search: '?barber=nobody&service=bogus' });
    expect(checked()).toBe('hassan');
    expect($('[data-service-select]').value).toBe('');

    database([HASSAN]);
    docListeners.forEach(([type, fn, opts]) => document.removeEventListener(type, fn, opts));
    docListeners = [];
    vi.resetModules();
    rpc = await import('../scripts/booking-rpc.js');
    database([HASSAN]);
    await boot({ search: '?barber=larry&service=line-up' });
    expect(checked()).toBe('hassan');
    expect($('[data-service-select]').value).toBe('line-up');    // the service still stands on its own
  });

  it('the empty service prompt is not a service', async () => {
    database([HASSAN, LARRY]);
    await boot({ search: '?service=' });
    expect($('[data-service-select]').value).toBe('');
  });

  it('a link wins over the returning customer\'s last barber and service, and keeps the rest', async () => {
    localStorage.setItem('fe.lastBooking', JSON.stringify({
      name: 'Ana', phone: '4135550123', barberSlug: 'hassan', serviceSlug: 'hair-cut', addons: [],
    }));
    database([HASSAN, LARRY]);
    await boot({ search: '?barber=larry&service=beard-trim' });
    expect(checked()).toBe('larry');
    expect($('[data-service-select]').value).toBe('beard-trim');
    expect($('input[name="name"]').value).toBe('Ana');
  });

  it('with slow barbers, a link to one added in the app is picked once they arrive', async () => {
    database([HASSAN, LARRY, MARCUS], { delayMs: 150 });
    await boot({ search: '?barber=marcus', waitMs: 20 });
    expect(checked()).toBe('hassan');
    await vi.waitFor(() => expect(checked()).toBe('marcus'));
  });

  it('…unless the customer picked a barber by hand meanwhile', async () => {
    database([HASSAN, LARRY, MARCUS], { delayMs: 150 });
    await boot({ search: '?barber=marcus', waitMs: 20 });
    $('[data-barber-option="larry"]').click();
    await vi.waitFor(() => expect(pickerSlugs()).toContain('marcus'));
    expect(checked()).toBe('larry');
  });

  it('readBookingLink reads both values, lowercased and trimmed, or null', async () => {
    const { readBookingLink } = await import('../scripts/booking-link.js');
    expect(readBookingLink('?barber=Larry&service=vip-haircut')).toEqual({ barber: 'larry', service: 'vip-haircut' });
    expect(readBookingLink('')).toEqual({ barber: null, service: null });
    expect(readBookingLink('?barber=%20')).toEqual({ barber: null, service: null });
  });
});
