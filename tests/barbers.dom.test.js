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
//   * what the app sends is text: hostile values in every field make no markup
//   * an answer with no barber offers nobody online; barbers that land while
//     a confirmation shows are taken on "Book another"; a late answer that
//     closes the picked day or time clears it and says so
//   * a slot overlapped by an off-grid booking is taken
//   * the hero line names the barbers and counts the chairs

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rosterFromRows } from '../scripts/roster.js';
import { SUPABASE_URL } from '../scripts/config.js';

/** Where the app's photos live: public objects in the project's bucket. */
const PHOTO = (name) => `${SUPABASE_URL}/storage/v1/object/public/barber-photos/${name}`;

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

/** The answer is held until release(rows) (or release(new Error(...))). */
function heldDatabase() {
  let release;
  const answer = new Promise((resolve, reject) => {
    release = (rows) => (rows instanceof Error ? reject(rows) : resolve(rosterFromRows(rows)));
  });
  rpc.fetchBarbers.mockImplementation(() => answer);
  return release;
}

/** Availability held until release(rows). */
function heldAvailability() {
  let release;
  rpc.fetchAvailability.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  return (rows = []) => release(rows);
}

/** main.js's order, with the barbers' wait shortened for the slow-read tests. */
async function boot({ search = '', waitMs = 200 } = {}) {
  document.body.innerHTML = section('hero') + section('barbers') + section('book');
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
    database([HASSAN, { ...MARCUS, photo_url: PHOTO('marcus.jpg') }]);
    await boot();
    const img = $('[data-barber-option="marcus"] img.booking__barber-photo');
    expect(img.getAttribute('src')).toBe(PHOTO('marcus.jpg'));
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

  it('an answer with no bookable barber is the shop\'s: nobody is offered online, and the section says how to reach the shop', async () => {
    database([{ ...MARCUS, barber_schedules: [] }]);
    await boot();
    expect(pickerSlugs()).toEqual([]);
    expect($('#book').hasAttribute('data-no-barbers')).toBe(true);
    const note = $('[data-no-barbers-note]');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Online booking isn't available right now. Call 413·885·4440 or walk in.");
    expect(note.querySelector('a').getAttribute('href')).toBe('tel:+14138854440');
    expect(rpc.fetchAvailability).not.toHaveBeenCalled();
    expect($('[data-form-date]').value).toBe('');
    expect($('[data-form-time]').value).toBe('');
    expect($('[data-cancel-open]')).not.toBeNull();             // an existing booking can still be cancelled
    // The barbers section offers nobody either.
    expect(visibleSpreads()).toEqual([]);
    expect($('#barbers').hidden).toBe(true);
    expect($('[data-book-barber]:not([hidden])')?.closest('[data-barber-spread]:not([hidden])') ?? null).toBeNull();
  });

  it('an empty answer that lands late takes the form down, picks and all', async () => {
    database([], { delayMs: 150 });
    await boot({ waitMs: 20 });
    expect(pickerSlugs()).toEqual(['hassan', 'larry']);
    $('[data-slot-grid] .booking__slot:not([disabled])').click();
    expect($('[data-form-time]').value).toBe('10:45:00');

    await vi.waitFor(() => expect($('#book').hasAttribute('data-no-barbers')).toBe(true));
    expect(pickerSlugs()).toEqual([]);
    expect($('[data-no-barbers-note]').hidden).toBe(false);
    expect(grid.getSelection()).toMatchObject({ date: null, time: null });
    expect($('[data-form-time]').value).toBe('');
    expect($('#barbers').hidden).toBe(true);
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
    database([HASSAN, { ...MARCUS, photo_url: PHOTO('m.jpg'), title: null, bio: null }]);
    await boot();
    const spread = $('[data-barber-spread="marcus"]');
    const img = spread.querySelector('figure.feature__portrait img');
    expect(img.getAttribute('src')).toBe(PHOTO('m.jpg'));
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

/* ================= What the app sends is text ================= */

/** Every attribute on the page that a hostile value could have made. */
function hostileTraces() {
  const found = [];
  for (const node of document.querySelectorAll('*')) {
    if (['SCRIPT', 'B', 'IFRAME'].includes(node.tagName)) found.push(node.tagName);
    for (const a of node.attributes) {
      if (a.name.startsWith('on') || /javascript:|evil\.test|xss/i.test(a.value)) found.push(`${node.tagName} ${a.name}=${a.value}`);
    }
  }
  return found;
}

const HOSTILE_NAME = '<img src=x onerror=window.xss=1>';
const HOSTILE = {
  ...HASSAN,
  display_name: HOSTILE_NAME,
  title:        '<script>window.xss=2</script>',
  bio:          '<b onmouseover=window.xss=3>bio</b>',
  photo_url:    'javascript:window.xss=4',
  barber_closures: [{ closure_date: '2026-07-08' }, { closure_date: '"><img src=x onerror=window.xss=5>' }],
};

describe('what the app sends reaches the page as text', () => {
  it('hostile values in every field make no element and no attribute', async () => {
    database([
      HOSTILE,
      { ...MARCUS, slug: 'marc"><img src=x onerror=window.xss=6>', display_name: 'Bad slug' },
      { ...MARCUS, slug: 'other', display_name: '<svg onload=window.xss=7>', photo_url: 'https://evil.test/storage/v1/object/public/barber-photos/o.jpg' },
      { ...MARCUS, slug: 'plain', display_name: 'Plain', photo_url: PHOTO('p.jpg').replace('https:', 'http:') },
      { ...MARCUS, slug: 'quote', display_name: 'Quote', photo_url: `${PHOTO('q.jpg')}" onerror="alert(8)` },
    ]);
    await boot();

    expect(pickerSlugs()).toEqual(['hassan', 'other', 'plain', 'quote']);   // the bad slug is not offered
    expect(hostileTraces()).toEqual([]);
    expect($('[data-barber-option="other"] .booking__barber-name').textContent).toBe('<svg onload=window.xss=7>');
    // No photo from anywhere but the project's bucket, over https.
    for (const slug of ['other', 'plain']) {
      expect($(`[data-barber-option="${slug}"] img`)).toBeNull();
      expect($(`[data-barber-spread="${slug}"] img`)).toBeNull();
    }
    // A quote in the project's own URL stays inside the one attribute, escaped.
    expect($('[data-barber-spread="quote"] img').getAttribute('src')).toBe(`${PHOTO('q.jpg')}%22%20onerror=%22alert(8)`);

    // The built spread for Hassan is the shipped one; the others are text.
    const other = $('[data-barber-spread="other"]');
    expect(other.querySelector('.feature__name').textContent).toBe('<svg onload=window.xss=7>');
    expect(other.querySelector('svg')).toBeNull();
    expect($('[data-barbers-head]').textContent).toBe(`${HOSTILE_NAME}, <svg onload=window.xss=7>, Plain and Quote.`);
    expect($('[data-hero-dek]').querySelector('*')).toBeNull();

    // The day label, the selection pill and the slot grid's messages.
    $('[data-slot-grid] .booking__slot:not([disabled])').click();
    expect($('[data-selected-text]').textContent).toBe(`Mon, Jul 6 · 10:45 AM · ${HOSTILE_NAME}`);
    expect($('[data-slots-day-label]').textContent).toBe(`Monday, Jul 6 · ${HOSTILE_NAME}`);
    expect(hostileTraces()).toEqual([]);
  });

  it('a barber\'s name in "is off this day" is text (a shortcut onto a day off)', async () => {
    database([HOSTILE, LARRY]);
    await boot();
    document.dispatchEvent(new CustomEvent('booking:pick', { detail: { date: '2026-07-08', time: '10:00:00', barberSlug: 'hassan' } }));
    await vi.waitFor(() => expect($('[data-slot-grid]').textContent).toBe(`${HOSTILE_NAME} is off this day.`));
    expect($('[data-slot-grid] img')).toBeNull();
    expect(hostileTraces()).toEqual([]);
  });

  it('the reviewer\'s race: a late roster that closes every day, then late availability, makes no markup', async () => {
    const releaseRoster = heldDatabase();
    const releaseAvailability = heldAvailability();
    const booting = boot({ waitMs: 20 });
    await vi.waitFor(() => expect(rpc.fetchAvailability).toHaveBeenCalled());   // the grid is up, reading
    const everyDay = Array.from({ length: 18 }, (_, i) => ({ closure_date: `2026-07-${String(5 + i).padStart(2, '0')}` }));
    releaseRoster([{ ...HASSAN, display_name: HOSTILE_NAME, barber_closures: everyDay }]);
    await vi.waitFor(() => expect($$('[data-day-row] .booking__day:not([disabled])')).toHaveLength(0));
    releaseAvailability([]);
    await booting;
    await vi.waitFor(() => expect($('[data-slot-grid]').hasAttribute('aria-busy')).toBe(false));
    expect($('[data-slot-grid]').textContent).toBe(`${HOSTILE_NAME} has no open days in the next two weeks.`);
    expect(hostileTraces()).toEqual([]);
  });
});

/* ================= Late barbers: checked again, said plainly ================= */

describe('a late roster checks the customer\'s picks again', () => {
  it('days off for every day: nothing stays selected or offered, and the grid says so', async () => {
    database([{ ...HASSAN, barber_closures: Array.from({ length: 14 }, (_, i) => ({ closure_date: `2026-07-${String(6 + i).padStart(2, '0')}` })) }, LARRY],
      { delayMs: 150 });
    await boot({ waitMs: 20 });
    $('[data-slot-grid] .booking__slot[data-time="10:45:00"]').click();
    expect(grid.getSelection()).toMatchObject({ date: '2026-07-06', time: '10:45:00' });

    await vi.waitFor(() => expect($$('[data-day-row] .booking__day:not([disabled])')).toHaveLength(0));
    expect(grid.getSelection()).toMatchObject({ date: null, time: null, barberSlug: 'hassan' });
    expect($$('[data-slot-grid] .booking__slot')).toHaveLength(0);
    expect($('[data-slot-grid]').textContent).toBe('Hassan has no open days in the next two weeks.');
    expect($('[data-slots-day-label]').textContent).toBe('Time');
    expect($('[data-form-date]').value).toBe('');
    expect($('[data-form-time]').value).toBe('');
    expect($('[data-selected-pill]').hidden).toBe(true);
    expect($('[data-slots-note]').textContent).toBe('Mon, Jul 6 at 10:45 AM is no longer open.');
    // Larry still books.
    $('[data-barber-option="larry"]').click();
    await vi.waitFor(() => expect($('[data-slot-grid] .booking__slot:not([disabled])')).not.toBeNull());
  });

  it('new hours that leave the picked time off the grid drop it and say so; the day stays', async () => {
    database([{ ...HASSAN, barber_schedules: days('12:00:00', '18:00:00', OPEN_DAYS) }, LARRY], { delayMs: 150 });
    await boot({ waitMs: 20 });
    $('[data-slot-grid] .booking__slot[data-time="10:45:00"]').click();

    await vi.waitFor(() => expect($('[data-barber-option="hassan"] .booking__barber-hours').textContent).toBe('12 to 6 · Closed Tue'));
    expect(grid.getSelection()).toMatchObject({ date: '2026-07-06', time: null });
    expect(pills()[0]).toBe('12:00:00');
    expect($('[data-slot-grid] .booking__slot.is-selected')).toBeNull();
    expect($('[data-form-time]').value).toBe('');
    expect($('[data-slots-note]').textContent).toBe('Mon, Jul 6 at 10:45 AM is no longer open. Pick another time.');
  });

  it('new hours that keep the picked time keep it, and say nothing', async () => {
    database([{ ...HASSAN, barber_schedules: days('10:45:00', '18:00:00', OPEN_DAYS) }, LARRY], { delayMs: 150 });
    await boot({ waitMs: 20 });
    $('[data-slot-grid] .booking__slot[data-time="11:30:00"]').click();
    await vi.waitFor(() => expect(pills()[0]).toBe('10:45:00'));
    expect(grid.getSelection()).toMatchObject({ date: '2026-07-06', time: '11:30:00' });
    expect($('[data-slot-grid] .booking__slot.is-selected').dataset.time).toBe('11:30:00');
    expect($('[data-slots-note]').textContent).toBe('');
  });

  it('a barber taken off the site gives way to the first one, and the form says who is gone', async () => {
    database([HASSAN], { delayMs: 150 });
    await boot({ waitMs: 20 });
    $('[data-barber-option="larry"]').click();
    await vi.waitFor(() => expect($('[data-slot-grid] .booking__slot.is-loading')).toBeNull());
    $('[data-slot-grid] .booking__slot:not([disabled])').click();
    await vi.waitFor(() => expect(pickerSlugs()).toEqual(['hassan']));
    expect(checked()).toBe('hassan');
    expect(grid.getSelection().time).toBeNull();
    expect($('[data-slots-note]').textContent).toBe("Larry isn't taking online bookings right now.");
  });
});

describe('barbers that land while a confirmation shows', () => {
  it('are taken on "Book another": the picker is the database\'s and its buttons work', async () => {
    const release = heldDatabase();
    await boot({ waitMs: 20 });
    rpc.bookSlot.mockResolvedValue([{ booking_id: 'b1', slot_index: 0, booking_time: '10:45:00', total_price_cents: 3000 }]);
    $('[data-slot-grid] .booking__slot[data-time="10:45:00"]').click();
    fill('input[name="name"]', 'Test Customer');
    fill('input[name="phone"]', '4135550123');
    fill('[data-service-select]', 'hair-cut');
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));

    release([MARCUS]);
    await vi.waitFor(() => expect(visibleSpreads()).toEqual(['marcus']));
    expect(pickerSlugs()).toEqual(['hassan', 'larry']);          // nothing changes under the confirmation
    expect($('[data-success-text]').textContent).toBe('Monday, July 6 · Hassan');

    $('[data-book-another]').click();
    expect(pickerSlugs()).toEqual(['marcus']);
    expect(checked()).toBe('marcus');
    expect($('[data-slots-note]').textContent).toBe("Hassan isn't taking online bookings right now.");
    expect(rpc.fetchAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ barberSlug: 'marcus' }));
    await vi.waitFor(() => expect($('[data-slot-grid] .booking__slot.is-loading')).toBeNull());
    expect(chip('2026-07-08').getAttribute('aria-selected')).toBe('true');   // Marcus's first day
    $('[data-slot-grid] .booking__slot[data-time="12:45:00"]').click();
    expect(grid.getSelection()).toMatchObject({ barberSlug: 'marcus', date: '2026-07-08', time: '12:45:00' });
  });
});

/* ================= Off-grid bookings ================= */

describe('a booking off the barber\'s grid', () => {
  it('takes every slot it overlaps (a booking holds the chair for 45 minutes)', async () => {
    // Hassan's day now starts at 10:15; a booking made on the old grid sits at 11:30 Wednesday.
    database([{ ...HASSAN, barber_schedules: days('10:15:00', '18:00:00', OPEN_DAYS) }, LARRY]);
    rpc.fetchAvailability.mockResolvedValue([
      { barber_slug: 'hassan', booking_date: '2026-07-08', booking_time: '11:30:00', status: 'confirmed' },
    ]);
    await boot();
    chip('2026-07-08').click();
    await vi.waitFor(() => expect($('[data-slot-grid] .booking__slot.is-loading')).toBeNull());
    const pill = (t) => $(`[data-slot-grid] .booking__slot[data-time="${t}"]`);
    expect(pills().slice(0, 4)).toEqual(['10:15:00', '11:00:00', '11:45:00', '12:30:00']);
    for (const t of ['11:00:00', '11:45:00']) {
      expect(pill(t).classList.contains('is-taken')).toBe(true);
      expect(pill(t).disabled).toBe(true);
    }
    for (const t of ['10:15:00', '12:30:00']) expect(pill(t).disabled).toBe(false);
  });
});

/* ================= The hero line ================= */

describe('the hero line follows the barbers', () => {
  it('ships naming Hassan and Larry, the same line the roster of the two makes', async () => {
    const { heroLine } = await import('../scripts/barbers-section.js');
    document.body.innerHTML = section('hero');
    expect($('[data-hero-dek]').textContent.trim().replace(/\s+/g, ' ')).toBe(heroLine(['Hassan', 'Larry']));
  });

  it('names the barbers on offer and counts their chairs', async () => {
    database([HASSAN, LARRY, MARCUS]);
    await boot();
    expect($('[data-hero-dek]').textContent)
      .toBe('Three chairs on Memorial Drive. Fades, beards, and line-ups by Hassan, Larry and Marcus, 10 to 6, six days a week.');
  });

  it('one barber, one chair; and Larry\'s line about Hassan goes with Hassan', async () => {
    database([LARRY]);
    await boot();
    expect($('[data-hero-dek]').textContent)
      .toBe('One chair on Memorial Drive. Fades, beards, and line-ups by Larry, 10 to 6, six days a week.');
    expect($('#larry [data-needs-barber="hassan"]').hidden).toBe(true);
  });

  it('nobody online: the line names no one', async () => {
    database([]);
    await boot();
    expect($('[data-hero-dek]').textContent).toBe('Fades, beards, and line-ups on Memorial Drive, 10 to 6, six days a week.');
  });

  it('a failed read leaves the shipped line', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    database(new Error('offline'));
    await boot();
    expect($('[data-hero-dek]').textContent.trim()).toMatch(/^Two chairs on Memorial Drive\. Fades, beards, and line-ups by Hassan and Larry,/);
  });
});
