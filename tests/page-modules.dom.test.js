// @vitest-environment jsdom
//
// The non-booking page modules against the real index.html markup:
//   * main.js     booking loads apart from the rest of the page
//   * nav.js      the mobile menu
//   * page.js     the nav stamp, the hero status line, the sticky nav, the
//                 phone-only compare collapse, landing on a #fragment
//   * cover.js    the "next open slot" lines
//   * visit.js    today's row and the status in the hours card
//   * shop-video.js  the tour video (lazy file, muted default, sound toggle,
//                 no caption track) and the pause buttons on both clips
//   * gallery.js  the lightbox (with Back) and the filmstrip counter
//   * reveals.js  scroll reveals, and the CSS that skips them
// jsdom has no IntersectionObserver, media playback, or <dialog> methods, so
// those are stubbed just enough to drive the code paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('../scripts/booking-rpc.js', () => ({
  fetchNextAvailable: vi.fn(async () => null),
}));

const __dir = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dir, '..', 'index.html'), 'utf8');

function section(id) {
  const open = indexHtml.match(new RegExp(`<section[^>]*\\sid="${id}"[^>]*>`));
  expect(open, `<section id="${id}">`).toBeTruthy();
  const end = indexHtml.indexOf('</section>', open.index);
  return indexHtml.slice(open.index, end + '</section>'.length);
}
function element(re) {
  const m = indexHtml.match(re);
  expect(m).toBeTruthy();
  return m[0];
}

const HEADER = element(/<header class="nav"[\s\S]*?<\/header>/);
const HERO   = section('hero');
const MENU   = section('menu');
const VISIT  = section('visit');
const SHOP   = section('shop');
const GALLERY = section('gallery');
const MOBILE_CTA = element(/<div class="mobile-cta"[\s\S]*?<\/div>\s*<\/div>/);

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let matchMediaMatches;
beforeEach(() => {
  vi.resetModules();
  matchMediaMatches = () => false;
  window.matchMedia = vi.fn((q) => ({
    matches: matchMediaMatches(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  Element.prototype.scrollIntoView = vi.fn();
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  document.documentElement.removeAttribute('data-booking-ready');
});

/* ================= cover.js ================= */

describe('page.js: live status, sticky nav, and the compare table', () => {
  async function bootPage(now) {
    vi.useFakeTimers({ now, toFake: ['Date', 'setInterval', 'clearInterval'] });
    document.body.innerHTML = HEADER + HERO + MENU + MOBILE_CTA + '<section id="book"></section>';
    const { initPage } = await import('../scripts/page.js');
    return { initPage };
  }

  it('shows OPEN in the nav and "Closes 6 PM" in the hero during open hours', async () => {
    const { initPage } = await bootPage(new Date('2026-09-09T17:00:00Z'));   // Wed 1 PM EDT
    initPage();
    expect($('[data-open-stamp]').classList.contains('stamp--open')).toBe(true);
    expect($('[data-open-stamp] .stamp__text').textContent).toBe('Open now');
    expect($('[data-hero-status]').dataset.state).toBe('open');
    expect($('[data-hero-status-label]').textContent).toBe('Open now');
    expect($('[data-hero-status-detail]').textContent).toBe('Closes 6 PM');
  });

  it('shows CLOSED with the next opening on the closed Tuesday', async () => {
    const { initPage } = await bootPage(new Date('2026-09-08T16:00:00Z'));   // Tue noon EDT
    initPage();
    expect($('[data-open-stamp]').classList.contains('stamp--closed')).toBe(true);
    expect($('[data-hero-status-detail]').textContent).toBe('Opens tomorrow 10 AM');
  });

  it('re-evaluates every minute so a tab left open flips at closing time', async () => {
    const { initPage } = await bootPage(new Date('2026-09-09T21:59:30Z'));   // Wed 5:59:30 PM
    initPage();
    expect($('[data-open-stamp]').classList.contains('stamp--soon')).toBe(true);
    vi.setSystemTime(new Date('2026-09-09T22:00:30Z'));                          // 6:00:30 PM
    vi.advanceTimersByTime(60_000);
    expect($('[data-open-stamp]').classList.contains('stamp--closed')).toBe(true);
    expect($('[data-hero-status-detail]').textContent).toBe('Opens tomorrow 10 AM');
  });

  it('solidifies the nav once the page scrolls past the top', async () => {
    const { initPage } = await bootPage(new Date('2026-09-09T17:00:00Z'));
    initPage();
    expect($('[data-nav]').classList.contains('is-solid')).toBe(false);
    window.scrollY = 200;
    window.dispatchEvent(new Event('scroll'));
    expect($('[data-nav]').classList.contains('is-solid')).toBe(true);
    window.scrollY = 0;
    window.dispatchEvent(new Event('scroll'));
    expect($('[data-nav]').classList.contains('is-solid')).toBe(false);
  });

  it('collapses "Which one do I book?" on phones and keeps it open on desktop', async () => {
    let { initPage } = await bootPage(new Date('2026-09-09T17:00:00Z'));
    matchMediaMatches = (q) => q.includes('max-width: 600px');
    initPage();
    expect($('[data-compare]').open).toBe(false);

    vi.resetModules();
    ({ initPage } = await bootPage(new Date('2026-09-09T17:00:00Z')));
    matchMediaMatches = () => false;
    initPage();
    expect($('[data-compare]').open).toBe(true);
  });

  it('on desktop the table cannot be folded away: the summary click (also Enter and Space) is cancelled', async () => {
    const { initPage } = await bootPage(new Date('2026-09-09T17:00:00Z'));
    matchMediaMatches = () => false;
    initPage();
    const summary = $('[data-compare] summary');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(summary.dispatchEvent(click)).toBe(false);
    expect($('[data-compare]').open).toBe(true);
    expect(summary.getAttribute('tabindex')).toBe('-1');      // a summary that does nothing is not a Tab stop
  });

  it('on phones the summary still toggles the cards', async () => {
    const { initPage } = await bootPage(new Date('2026-09-09T17:00:00Z'));
    matchMediaMatches = (q) => q.includes('max-width: 600px');
    initPage();
    const summary = $('[data-compare] summary');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(summary.dispatchEvent(click)).toBe(true);
    expect(summary.hasAttribute('tabindex')).toBe(false);
  });
});

describe('page.js: landing on a #fragment after the page has grown (X2)', () => {
  let calls, readyState;

  // A cold load of /#<hash>: the document is still loading when page.js runs.
  async function land(hash) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    readyState = 'interactive';
    vi.spyOn(document, 'readyState', 'get').mockImplementation(() => readyState);
    history.replaceState(null, '', hash || location.pathname);
    document.body.innerHTML = HEADER + HERO + MENU + '<section id="book"><p id="cancel"></p></section>';
    // Earlier tests' pages still wait on window events; record this page's elements only.
    calls = [];
    Element.prototype.scrollIntoView = vi.fn(function (opts) {
      if (this.isConnected) calls.push([this, opts, document.documentElement.style.scrollBehavior]);
    });
    const { initPage } = await import('../scripts/page.js');
    initPage();
  }
  const load = () => { readyState = 'complete'; window.dispatchEvent(new Event('load')); };
  const bookingReady = () => document.dispatchEvent(new CustomEvent('booking:ready'));
  const settle = () => vi.advanceTimersByTimeAsync(250);   // the page sits still for 250 ms
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, '', location.pathname);
  });

  it('scrolls to #book once more, instantly, after load and the booking modules', async () => {
    await land('#book');
    load();
    await settle();
    expect(calls).toEqual([]);                         // the booking modules have not started yet
    bookingReady();
    await settle();
    expect(calls).toEqual([[$('#book'), { block: 'start', behavior: 'auto' }, 'auto']]);
    expect(document.documentElement.style.scrollBehavior).toBe('');   // html's own smooth scrolling is back
    bookingReady();
    await settle();
    expect(calls).toHaveLength(1);                     // once
  });

  it('waits 3 s at most for the booking modules', async () => {
    await land('#book');
    load();
    await vi.advanceTimersByTimeAsync(2900);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(calls.map(([el]) => el)).toEqual([$('#book')]);
  });

  it("waits for the browser's own smooth jump to stop: Chromium carries it on past an instant scroll", async () => {
    await land('#book');
    load();
    bookingReady();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      window.dispatchEvent(new Event('scroll'));
    }
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map(([el]) => el)).toEqual([$('#book')]);
  });

  for (const [what, act] of [
    ['scrolled with the wheel', () => window.dispatchEvent(new Event('wheel'))],
    ['pressed Page Down', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))],
    ['tapped the page', () => window.dispatchEvent(new Event('pointerdown'))],
    ['focused a link', () => $('a').focus()],
  ]) {
    it(`leaves the page alone when the customer ${what} before then`, async () => {
      await land('#book');
      act();
      load();
      bookingReady();
      await settle();
      expect(calls).toEqual([]);
    });
  }

  it('does nothing without a hash, for #cancel (booking-cancel.js owns it), or for a hash that names nothing', async () => {
    for (const hash of ['', '#cancel', '#nowhere']) {
      await land(hash);
      load();
      bookingReady();
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls, hash).toEqual([]);
      vi.restoreAllMocks();
    }
  });
});

describe('cover.js: next open slot', () => {
  // bookingReady: the booking modules have started (booking-grid.js sets it).
  async function bootCover(now, { bookingReady = true } = {}) {
    vi.useFakeTimers({ now, toFake: ['Date', 'setInterval', 'clearInterval'] });
    document.documentElement.toggleAttribute('data-booking-ready', bookingReady);
    document.body.innerHTML = HEADER + HERO + MENU + MOBILE_CTA + '<section id="book"></section>';
    const rpc = await import('../scripts/booking-rpc.js');
    const { initCover } = await import('../scripts/cover.js');
    return { rpc, initCover };
  }

  it('fills the hero, the booking callout, and the sticky bar with the next slot', async () => {
    const { rpc, initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'));
    rpc.fetchNextAvailable.mockResolvedValue({
      date: '2026-09-10', time: '10:45:00', barberSlug: 'larry', barberName: 'Larry',
      label: 'THU, SEP 10 · 10:45 AM · LARRY', shortLabel: 'Thu 10:45 AM',
    });
    document.body.insertAdjacentHTML('beforeend', section('book'));
    initCover();
    await vi.waitFor(() => expect($('[data-next-available]').hidden).toBe(false));
    expect($('[data-next-available-slot]').textContent).toBe('THU, SEP 10 · 10:45 AM · LARRY');
    expect($('[data-next-available-callout]').hidden).toBe(false);
    expect($('[data-mobile-cta-next]').hidden).toBe(false);
    expect($('[data-mobile-cta-next-slot]').textContent).toBe('Thu 10:45 AM');   // the short form fits the bar

    // "Take it" hands the slot to the grid through the booking:pick event.
    const picked = vi.fn();
    document.addEventListener('booking:pick', (e) => picked(e.detail));
    $('[data-pick-next]').click();
    expect(picked).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-10', time: '10:45:00', barberSlug: 'larry' }));
  });

  it('"Reserve it" in the hero picks the advertised slot exactly like "Take it" (P11)', async () => {
    const { rpc, initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'));
    const next = {
      date: '2026-09-10', time: '10:45:00', barberSlug: 'larry', barberName: 'Larry',
      label: 'THU, SEP 10 · 10:45 AM · LARRY', shortLabel: 'Thu 10:45 AM',
    };
    rpc.fetchNextAvailable.mockResolvedValue(next);
    document.body.insertAdjacentHTML('beforeend', section('book'));
    initCover();
    await vi.waitFor(() => expect($('[data-next-available]').hidden).toBe(false));

    const picked = vi.fn();
    document.addEventListener('booking:pick', (e) => picked(e.detail));
    const reserve = $('[data-next-available] a');
    expect(reserve.textContent).toBe('Reserve it');
    reserve.click();
    expect(picked).toHaveBeenCalledWith(next);
    $('[data-next-available-callout] [data-pick-next]').click();
    expect(picked).toHaveBeenCalledTimes(2);
    expect(picked.mock.calls[1][0]).toBe(picked.mock.calls[0][0]);
  });

  it('shows no next-slot line until the booking modules have started, then shows them', async () => {
    const { rpc, initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'), { bookingReady: false });
    rpc.fetchNextAvailable.mockResolvedValue({
      date: '2026-09-10', time: '10:45:00', barberSlug: 'larry', barberName: 'Larry',
      label: 'THU, SEP 10 · 10:45 AM · LARRY', shortLabel: 'Thu 10:45 AM',
    });
    document.body.insertAdjacentHTML('beforeend', section('book'));
    initCover();
    await vi.advanceTimersByTimeAsync(10);
    expect($('[data-next-available]').hidden).toBe(true);           // a failed booking import stops here
    expect($('[data-next-available-callout]').hidden).toBe(true);
    expect($('[data-mobile-cta-next]').hidden).toBe(true);
    expect(rpc.fetchNextAvailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);                  // the refresh doesn't show them either
    expect($('[data-next-available]').hidden).toBe(true);

    document.documentElement.setAttribute('data-booking-ready', '');  // what booking-grid.js does
    document.dispatchEvent(new CustomEvent('booking:ready'));
    await vi.waitFor(() => expect($('[data-next-available]').hidden).toBe(false));
    expect($('[data-next-available-callout]').hidden).toBe(false);
    expect($('[data-mobile-cta-next]').hidden).toBe(false);
    expect(rpc.fetchNextAvailable).toHaveBeenCalledTimes(1);
  });

  it('keeps the next-slot lines hidden when there is nothing free or the lookup fails', async () => {
    const { rpc, initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'));
    rpc.fetchNextAvailable.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    initCover();
    await vi.advanceTimersByTimeAsync(10);
    expect($('[data-next-available]').hidden).toBe(true);
    expect($('[data-mobile-cta-next]').hidden).toBe(true);
  });

  it('takes the next-slot lines down again when a later read fails (P2)', async () => {
    const { rpc, initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'));
    rpc.fetchNextAvailable.mockResolvedValueOnce({
      date: '2026-09-10', time: '10:45:00', barberSlug: 'larry', barberName: 'Larry',
      label: 'THU, SEP 10 · 10:45 AM · LARRY', shortLabel: 'Thu 10:45 AM',
    });
    document.body.insertAdjacentHTML('beforeend', section('book'));
    initCover();
    await vi.waitFor(() => expect($('[data-next-available]').hidden).toBe(false));

    rpc.fetchNextAvailable.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect($('[data-next-available]').hidden).toBe(true);
    expect($('[data-next-available-callout]').hidden).toBe(true);
    expect($('[data-mobile-cta-next]').hidden).toBe(true);
  });

  it('the sticky bar stays away while any of booking shows or a booking field has focus (P17)', async () => {
    let observe, options;
    window.IntersectionObserver = class { constructor(cb, opts) { observe = cb; options = opts; } observe() {} disconnect() {} };
    const { initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'));
    document.body.querySelector('#book').remove();
    document.body.insertAdjacentHTML('beforeend', section('book'));
    initCover();
    const cta = $('[data-mobile-cta]');

    // A short viewport only ever shows a small share of the tall section.
    expect(options.threshold).toBe(0);
    observe([{ isIntersecting: true, intersectionRatio: 0.12 }]);
    expect(cta.classList.contains('is-in-book')).toBe(true);
    observe([{ isIntersecting: false, intersectionRatio: 0 }]);
    expect(cta.classList.contains('is-in-book')).toBe(false);

    $('#book input[name="name"]').focus();
    expect(cta.classList.contains('is-in-book')).toBe(true);
    $('#book input[name="phone"]').focus();                  // moving between fields keeps it away
    expect(cta.classList.contains('is-in-book')).toBe(true);
    $('#book input[name="phone"]').blur();
    expect(cta.classList.contains('is-in-book')).toBe(false);
    delete window.IntersectionObserver;
  });
});

/* ================= nav.js: mobile menu ================= */

describe('nav.js: the mobile menu', () => {
  async function bootMenu() {
    document.body.innerHTML = HEADER + HERO + MOBILE_CTA + '<section id="book"></section>';
    const { initMobileNav } = await import('../scripts/nav.js');
    initMobileNav();
  }
  const key = (k, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
  const walled = () => [...document.body.children].filter((el) => !el.matches('[data-nav]'));

  it('opening moves focus to the first link and makes the rest of the page inert', async () => {
    await bootMenu();
    const toggle = $('[data-nav-toggle]');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe($('.nav__link'));
    expect(walled().length).toBeGreaterThan(0);
    for (const el of walled()) expect(el.hasAttribute('inert'), el.className || el.id).toBe(true);
    if (!('inert' in HTMLElement.prototype)) {                       // jsdom: the aria-hidden fallback
      for (const el of walled()) expect(el.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('Tab and Shift+Tab cycle through the links and the toggle only', async () => {
    await bootMenu();
    const toggle = $('[data-nav-toggle]');
    const links = $$('.nav__link');
    toggle.click();
    links[links.length - 1].focus();
    key('Tab');
    expect(document.activeElement).toBe(toggle);
    key('Tab');
    expect(document.activeElement).toBe(links[0]);
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(toggle);
  });

  it('Escape closes it, hands focus back to the toggle, and restores the page', async () => {
    await bootMenu();
    const toggle = $('[data-nav-toggle]');
    const cta = $('[data-mobile-cta]');
    const ctaHidden = cta.getAttribute('aria-hidden');
    toggle.click();
    key('Escape');
    expect($('[data-nav]').hasAttribute('data-nav-open')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(document.body.style.overflow).toBe('');
    for (const el of walled()) expect(el.hasAttribute('inert')).toBe(false);
    expect(cta.getAttribute('aria-hidden')).toBe(ctaHidden);         // its own state, not the menu's
    expect($('#hero').hasAttribute('aria-hidden')).toBe(false);
  });

  it('a menu link closes it without pulling focus back to the toggle', async () => {
    await bootMenu();
    const toggle = $('[data-nav-toggle]');
    toggle.click();
    const link = $('.nav__link[href="#barbers"]');
    link.focus();
    link.click();
    expect($('[data-nav]').hasAttribute('data-nav-open')).toBe(false);
    expect(document.activeElement).not.toBe(toggle);
    for (const el of walled()) expect(el.hasAttribute('inert')).toBe(false);
  });
});

/* ================= main.js ================= */

describe('main.js: booking loads apart from the rest of the page', () => {
  it('if the booking modules fail to load, the page still starts and #book says how to book', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-09T17:00:00Z'), toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.doMock('../scripts/booking-grid.js', () => { throw new Error('offline'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = HEADER + HERO + section('book');
    await import('../scripts/main.js');
    await vi.waitFor(() => expect($('[data-booking-offline]')).toBeTruthy());

    const note = $('[data-booking-offline]');
    expect(note.textContent).toBe("Online booking isn't loading. Call 413·885·4440 or walk in.");
    expect(note.querySelector('a').getAttribute('href')).toBe('tel:+14138854440');
    expect($('#book .container').firstElementChild).toBe(note);
    expect(warn).toHaveBeenCalledWith('[main] booking failed to start', expect.any(Error));
    // page.js still ran: the stamp shows the live state, not the shipped text.
    expect($('[data-open-stamp]').classList.contains('stamp--open')).toBe(true);
    vi.doUnmock('../scripts/booking-grid.js');
  });

  it('a failed booking module shows the notice at once, even while cover.js is still loading', async () => {
    let releaseCover;
    const coverHeld = new Promise((resolve) => { releaseCover = resolve; });
    const initCover = vi.fn();
    vi.doMock('../scripts/cover.js', async () => { await coverHeld; return { initCover }; });
    vi.doMock('../scripts/booking-grid.js', () => { throw new Error('offline'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = HEADER + HERO + section('book');
    try {
      await import('../scripts/main.js');
      await vi.waitFor(() => expect($('[data-booking-offline]')).toBeTruthy());
      expect(initCover).not.toHaveBeenCalled();         // cover.js has not arrived yet

      releaseCover();
      await vi.waitFor(() => expect(initCover).toHaveBeenCalled());
      expect($$('[data-booking-offline]')).toHaveLength(1);
    } finally {
      releaseCover();
      vi.doUnmock('../scripts/cover.js');
      vi.doUnmock('../scripts/booking-grid.js');
    }
  });

  it('if the database client fails to load, the menu, live status, sticky nav and desktop compare table all still work', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-09T17:00:00Z'), toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.doMock('../scripts/supabase.js', () => { throw new Error('vendor file blocked'); });
    vi.doUnmock('../scripts/booking-rpc.js');          // the real one, which imports the client
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    matchMediaMatches = () => false;                   // 1280 wide: no phone query matches
    document.body.innerHTML = HEADER + HERO + MENU + MOBILE_CTA + section('book');
    await import('../scripts/main.js');
    await vi.waitFor(() => expect($('[data-booking-offline]')).toBeTruthy());
    expect(warn).toHaveBeenCalledWith('[main] next open slot and sticky bar failed to start', expect.any(Error));

    expect($('[data-open-stamp] .stamp__text').textContent).toBe('Open now');
    const compare = $('[data-compare]');
    expect(compare.open).toBe(true);
    expect(compare.querySelector('summary').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
    window.scrollY = 200;
    window.dispatchEvent(new Event('scroll'));
    expect($('[data-nav]').classList.contains('is-solid')).toBe(true);
    window.scrollY = 0;

    const toggle = $('[data-nav-toggle]');
    const links = $$('.nav__link');
    const key = (k, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
    toggle.click();
    expect($('[data-nav]').hasAttribute('data-nav-open')).toBe(true);
    expect(document.activeElement).toBe(links[0]);
    expect($('#hero').hasAttribute('inert')).toBe(true);
    links[links.length - 1].focus();
    key('Tab');
    expect(document.activeElement).toBe(toggle);
    key('Tab');
    expect(document.activeElement).toBe(links[0]);
    key('Escape');
    expect($('[data-nav]').hasAttribute('data-nav-open')).toBe(false);
    expect(document.activeElement).toBe(toggle);
    expect($('#hero').hasAttribute('inert')).toBe(false);
    vi.doUnmock('../scripts/supabase.js');
  });
});

/* ================= visit.js ================= */

describe('visit.js: the hours card', () => {
  async function bootVisit(now) {
    vi.useFakeTimers({ now, toFake: ['Date', 'setInterval', 'clearInterval'] });
    document.body.innerHTML = VISIT;
    const { initVisit } = await import('../scripts/visit.js');
    initVisit();
  }

  it('marks today and shows the live status', async () => {
    await bootVisit(new Date('2026-09-11T15:00:00Z'));    // Fri 11 AM
    const today = $$('[data-hours-list] .is-today');
    expect(today).toHaveLength(1);
    expect(today[0].dataset.weekday).toBe('5');
    expect($('[data-visit-status]').dataset.state).toBe('open');
    expect($('[data-hours-status]').textContent).toBe('Open now');
    expect($('[data-hours-detail]').textContent).toBe('Closes 6 PM');
  });

  it('the closed day is both static-closed and highlighted when it is today', async () => {
    await bootVisit(new Date('2026-09-08T15:00:00Z'));    // Tue
    const tue = $('[data-hours-list] [data-weekday="2"]');
    expect(tue.classList.contains('is-closed')).toBe(true);
    expect(tue.classList.contains('is-today')).toBe(true);
    expect(tue.textContent).toContain('Closed');
    expect($('[data-hours-status]').textContent).toBe('Closed');
  });

  it('moves the highlight when midnight passes in the shop timezone', async () => {
    await bootVisit(new Date('2026-09-11T03:59:30Z'));    // Thu 11:59:30 PM EDT
    expect($('[data-hours-list] .is-today').dataset.weekday).toBe('4');
    vi.setSystemTime(new Date('2026-09-11T04:00:30Z'));  // Fri 12:00:30 AM
    vi.advanceTimersByTime(60_000);
    expect($('[data-hours-list] .is-today').dataset.weekday).toBe('5');
    expect($('[data-hours-detail]').textContent).toBe('Opens today 10 AM');
  });
});

/* ================= shop-video.js ================= */

describe('shop-video.js: the tour', () => {
  let play, load;
  async function bootVideo({ phone = false } = {}) {
    matchMediaMatches = (q) => phone && q.includes('max-width: 768px');
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    document.body.innerHTML = SHOP + GALLERY;
    const { initShopVideo } = await import('../scripts/shop-video.js');
    initShopVideo();
    return $('[data-shop-video] video');
  }

  it('starts muted, picks the phone file on phones, and plays without sound', async () => {
    const video = await bootVideo({ phone: true });
    expect(video.muted).toBe(true);
    expect(video.getAttribute('src')).toContain('shop-tour-540.mp4');
    expect(load).toHaveBeenCalled();
    expect(play).toHaveBeenCalled();
    expect($('[data-video-sound]').getAttribute('aria-pressed')).toBe('false');
    expect($('[data-video-sound-text]').textContent).toBe('Sound off');
  });

  it('picks the larger file on desktop', async () => {
    const video = await bootVideo({ phone: false });
    expect(video.getAttribute('src')).toContain('shop-tour-720.mp4');
  });

  it('the sound button unmutes, restarts from the top, and reads as pressed', async () => {
    const video = await bootVideo();
    video.currentTime = 9;
    $('[data-video-sound]').click();
    expect(video.muted).toBe(false);
    expect(video.currentTime).toBe(0);
    expect($('[data-video-sound]').getAttribute('aria-pressed')).toBe('true');
    expect($('[data-video-sound]').getAttribute('aria-label')).toBe('Turn sound off');
    expect($('[data-video-sound-text]').textContent).toBe('Sound on');

    $('[data-video-sound]').click();
    expect(video.muted).toBe(true);
    expect($('[data-video-sound-text]').textContent).toBe('Sound off');
  });

  it('goes quiet again if the clip pauses with sound on (scrolled away)', async () => {
    const video = await bootVideo();
    $('[data-video-sound]').click();
    expect(video.muted).toBe(false);
    video.dispatchEvent(new Event('pause'));
    expect(video.muted).toBe(true);
    expect($('[data-video-sound]').getAttribute('aria-pressed')).toBe('false');
  });

  it('does not autoplay for people who asked for reduced motion, but the button still works', async () => {
    matchMediaMatches = (q) => q.includes('prefers-reduced-motion');
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    document.body.innerHTML = SHOP;
    const { initShopVideo } = await import('../scripts/shop-video.js');
    initShopVideo();
    expect(play).not.toHaveBeenCalled();
    $('[data-video-sound]').click();                       // a real gesture: fine to play
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('the gallery motion plate is muted and lazy too', async () => {
    await bootVideo();
    const plate = $('.plate__video');
    expect(plate.muted).toBe(true);
    expect(plate.getAttribute('src')).toContain('mirror-check.mp4');
  });
});

describe('shop-video.js: pause buttons and the sound toggle', () => {
  const pausedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
  let play, observers;

  beforeEach(() => {
    // Playback that reports itself: play/pause flip `paused` and fire events.
    const playing = new WeakSet();
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return !playing.has(this); } });
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () {
      playing.add(this); this.dispatchEvent(new Event('play')); return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () {
      playing.delete(this); this.dispatchEvent(new Event('pause'));
    });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    observers = [];
    window.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe(el) { this.el = el; }
      unobserve() {}
    };
  });
  afterEach(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', pausedDescriptor);
    delete window.IntersectionObserver;
    vi.restoreAllMocks();
  });

  async function boot() {
    document.body.innerHTML = SHOP + GALLERY;
    const { initShopVideo } = await import('../scripts/shop-video.js');
    initShopVideo();
  }
  const scroll = (video, inView) => observers.find((o) => o.el === video).cb([{ isIntersecting: inView, target: video }]);

  for (const [name, figureSel] of [['tour', '[data-shop-video]'], ['gallery clip', '.plate--video']]) {
    it(`the ${name} pauses from its own button, reads as pressed, and stays paused when it scrolls back`, async () => {
      await boot();
      const video  = $(`${figureSel} video`);
      const button = $(`${figureSel} [data-video-pause]`);
      expect(button.tagName).toBe('BUTTON');            // Space and Enter come with the element
      expect(button.getAttribute('type')).toBe('button');
      scroll(video, true);
      expect(video.paused).toBe(false);
      expect(button.getAttribute('aria-pressed')).toBe('false');

      button.click();
      expect(video.paused).toBe(true);
      expect(button.getAttribute('aria-pressed')).toBe('true');

      play.mockClear();
      scroll(video, false);
      scroll(video, true);
      expect(play).not.toHaveBeenCalled();             // the visitor's pause wins over autoplay

      button.click();
      expect(video.paused).toBe(false);
      expect(button.getAttribute('aria-pressed')).toBe('false');
      scroll(video, false);                            // offscreen pause still happens
      expect(video.paused).toBe(true);
      scroll(video, true);
      expect(video.paused).toBe(false);
    });
  }

  it('with reduced motion both pause buttons start pressed, because nothing plays', async () => {
    matchMediaMatches = (q) => q.includes('prefers-reduced-motion');
    await boot();
    for (const video of $$('video')) scroll(video, true);
    expect(play).not.toHaveBeenCalled();
    for (const button of $$('[data-video-pause]')) expect(button.getAttribute('aria-pressed')).toBe('true');
    $('.plate--video [data-video-pause]').click();     // a deliberate press still plays
    expect($('.plate__video').paused).toBe(false);
  });

  it('the tour has no caption track (the voice-over is captioned in the video), and sound on and off still work', async () => {
    await boot();
    const video = $('[data-shop-video] video');
    const sound = $('[data-video-sound]');
    expect(video.querySelector('track')).toBeNull();
    expect(video.muted).toBe(true);
    sound.click();
    expect(video.muted).toBe(false);
    expect(video.paused).toBe(false);
    expect(sound.getAttribute('aria-pressed')).toBe('true');
    expect(sound.textContent.trim()).toBe('Sound on');
    sound.click();
    expect(video.muted).toBe(true);
    expect(sound.getAttribute('aria-pressed')).toBe('false');
    expect(sound.textContent.trim()).toBe('Sound off');
    sound.click();
    video.dispatchEvent(new Event('pause'));          // scrolled away: muted again
    expect(video.muted).toBe(true);
  });
});

/* ================= gallery.js ================= */

describe('gallery.js: lightbox and filmstrip', () => {
  let api, hist;

  /** A session history the test can see: entry 0 is the page we came from,
      entry 1 this page. back() and forward() fire popstate like a browser. */
  function fakeHistory(entries = ['previous page', null]) {
    const stack = [...entries];
    let at = stack.length - 1;
    const go = (step) => {
      at += step;
      window.dispatchEvent(new PopStateEvent('popstate', { state: stack[at] }));
    };
    vi.spyOn(History.prototype, 'state', 'get').mockImplementation(() => stack[at]);
    vi.spyOn(history, 'pushState').mockImplementation((state) => { stack.splice(at + 1); stack.push(state); at += 1; });
    vi.spyOn(history, 'replaceState').mockImplementation((state) => { stack[at] = state; });
    vi.spyOn(history, 'back').mockImplementation(() => go(-1));
    vi.spyOn(history, 'forward').mockImplementation(() => go(1));
    return { stack, get at() { return at; } };
  }

  async function bootGallery(entries) {
    // jsdom has no <dialog> methods; give it the two the module uses.
    HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    hist = fakeHistory(entries);
    document.body.innerHTML = GALLERY;
    const { initGallery } = await import('../scripts/gallery.js');
    api = initGallery();
  }
  afterEach(() => vi.restoreAllMocks());

  it('opens the tapped photo at full size with its caption and position', async () => {
    await bootGallery();
    $('[data-plate="cut-crop-goatee"] [data-lightbox-open]').click();
    const dialog = $('[data-lightbox]');
    expect(dialog.hasAttribute('open')).toBe(true);
    expect($('[data-lightbox-img]').getAttribute('src')).toBe('./assets/img/cut-crop-goatee-1200.jpg');
    expect($('[data-lightbox-img]').alt).toContain('French crop');
    expect($('[data-lightbox-cap]').textContent).toBe('Crop, goatee');
    expect($('[data-lightbox-count]').textContent).toBe('04 / 14');   // the video plate is not a photo
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('next / prev wrap around both ends', async () => {
    await bootGallery();
    $('[data-plate="cut-textured-taper"] [data-lightbox-open]').click();
    $('[data-lightbox-prev]').click();
    expect($('[data-lightbox-count]').textContent).toBe('14 / 14');
    $('[data-lightbox-next]').click();
    expect($('[data-lightbox-count]').textContent).toBe('01 / 14');
    $('[data-lightbox]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect($('[data-lightbox-count]').textContent).toBe('02 / 14');
  });

  it('closing restores scrolling, drops the image, and returns focus to the plate', async () => {
    await bootGallery();
    const opener = $('[data-plate="cut-low-fade"] [data-lightbox-open]');
    opener.focus();
    opener.click();
    $('[data-lightbox-close]').click();
    expect($('[data-lightbox]').hasAttribute('open')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect($('[data-lightbox-img]').hasAttribute('src')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  const dialogOpen = () => $('[data-lightbox]').hasAttribute('open');
  const nextTask = () => new Promise((resolve) => setTimeout(resolve));

  it('Back closes the open photo instead of leaving the page', async () => {
    await bootGallery();
    const opener = $('[data-plate="cut-low-fade"] [data-lightbox-open]');
    opener.focus();
    opener.click();
    expect(hist.stack).toEqual(['previous page', null, { lightbox: 'cut-low-fade' }]);
    history.back();
    expect(dialogOpen()).toBe(false);
    expect(hist.at).toBe(1);                           // still on this page
    expect(document.activeElement).toBe(opener);
  });

  it('Back, Forward, Back: Forward reopens the same photo, and the second Back closes it again', async () => {
    await bootGallery();
    const opener = $('[data-plate="cut-low-fade"] [data-lightbox-open]');
    opener.focus();
    opener.click();
    $('[data-lightbox-next]').click();                 // the entry follows the photo on screen
    const seen = $('[data-lightbox-cap]').textContent;
    history.back();
    expect(dialogOpen()).toBe(false);

    history.forward();
    expect(dialogOpen()).toBe(true);
    expect($('[data-lightbox-cap]').textContent).toBe(seen);
    expect(hist.stack).toHaveLength(3);                // reopened without a new entry

    history.back();
    expect(dialogOpen()).toBe(false);
    expect(hist.at).toBe(1);
    // Focus lands on the plate of the photo that was on screen.
    const shown = $$('[data-plate]').find((f) => f.querySelector('.plate__cap')?.textContent.trim() === seen);
    expect(document.activeElement).toBe(shown.querySelector('[data-lightbox-open]'));
    history.back();
    expect(hist.at).toBe(0);                           // and the next Back leaves the page
  });

  it('closing with the button or Escape takes the entry back off, so the next Back leaves', async () => {
    await bootGallery();
    $('[data-plate="cut-low-fade"] [data-lightbox-open]').click();
    $('[data-lightbox-close]').click();
    expect(dialogOpen()).toBe(false);
    expect(hist.at).toBe(1);

    $('[data-plate="cut-low-fade"] [data-lightbox-open]').click();
    $('[data-lightbox]').close();                      // what Escape ends in on a modal <dialog>
    expect(hist.at).toBe(1);
    expect(history.back).toHaveBeenCalledTimes(2);
    history.back();
    expect(hist.at).toBe(0);
    expect(dialogOpen()).toBe(false);
  });

  for (const [path, closeIt] of [['Escape', () => $('[data-lightbox]').close()], ['Back', () => history.back()]]) {
    it(`after Forward restores a later photo, closing by ${path} scrolls its plate into view before focusing it`, async () => {
      await bootGallery();
      const first = $$('[data-plate] [data-lightbox-open]')[0];
      first.focus();
      first.click();
      for (let i = 0; i < 6; i++) $('[data-lightbox]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      history.back();
      history.forward();
      const target = $$('[data-plate] [data-lightbox-open]')[6];
      // Only this page's elements: earlier tests' galleries still listen for popstate on detached nodes.
      const calls = [];
      Element.prototype.scrollIntoView = vi.fn(function (opts) { if (this.isConnected) calls.push(['scroll', this, opts]); });
      const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function () { if (this.isConnected) calls.push(['focus', this]); });

      closeIt();
      expect($('[data-lightbox]').hasAttribute('open')).toBe(false);
      if (path === 'Escape') {
        // Its own history.back() lands on the page entry, and the browser
        // restores that entry's scroll just after popstate: wait past it.
        expect(calls).toEqual([]);
        await nextTask();
      }
      expect(calls).toEqual([
        ['scroll', target, { block: 'nearest', inline: 'nearest', behavior: 'smooth' }],
        ['focus', target],
      ]);
      focus.mockRestore();
    });
  }

  it('under reduced motion that scroll is instant; closing on the tapped plate does not scroll at all', async () => {
    matchMediaMatches = (q) => q.includes('prefers-reduced-motion');
    await bootGallery();
    const first = $$('[data-plate] [data-lightbox-open]')[0];
    first.click();
    $('[data-lightbox-next]').click();
    history.back();
    history.forward();
    Element.prototype.scrollIntoView = vi.fn();
    $('[data-lightbox-close]').click();
    await nextTask();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    expect(document.activeElement).toBe($$('[data-plate] [data-lightbox-open]')[1]);

    Element.prototype.scrollIntoView = vi.fn();
    first.focus();
    first.click();
    for (let i = 0; i < 6; i++) $('[data-lightbox-next]').click();
    $('[data-lightbox-close]').click();               // no history trip: focus goes back to the tapped plate
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
  });

  it('a reload on a photo entry shows that photo, so the entry never sits there empty', async () => {
    await bootGallery(['previous page', null, { lightbox: 'cut-low-fade' }]);
    expect(dialogOpen()).toBe(true);
    expect($('[data-lightbox-img]').getAttribute('src')).toBe('./assets/img/cut-low-fade-1200.jpg');
    $('[data-lightbox-close]').click();
    expect(hist.at).toBe(1);
    await nextTask();
    expect(document.activeElement).toBe($('[data-plate="cut-low-fade"] [data-lightbox-open]'));
  });

  it('the caption and the count are announced when the photo changes', async () => {
    await bootGallery();
    expect($('[data-lightbox-cap]').closest('[aria-live="polite"]')).toBeTruthy();
    expect($('[data-lightbox-count]').closest('[aria-live="polite"]')).toBeTruthy();
  });

  it('a horizontal swipe moves through the photos', async () => {
    await bootGallery();
    $('[data-plate="cut-textured-taper"] [data-lightbox-open]').click();
    const dialog = $('[data-lightbox]');
    const touch = (type, x) => dialog.dispatchEvent(Object.assign(new Event(type), { changedTouches: [{ clientX: x }] }));
    touch('touchstart', 300); touch('touchend', 100);      // swipe left = next
    expect($('[data-lightbox-count]').textContent).toBe('02 / 14');
    touch('touchstart', 100); touch('touchend', 300);      // swipe right = back
    expect($('[data-lightbox-count]').textContent).toBe('01 / 14');
    touch('touchstart', 100); touch('touchend', 120);      // a tap-sized wobble does nothing
    expect($('[data-lightbox-count]').textContent).toBe('01 / 14');
  });

  it('the filmstrip counter reports the plate under the middle of the strip', async () => {
    await bootGallery();
    const strip = $('[data-gallery]');
    const plates = $$('.plate');
    expect($('[data-filmstrip-total]').textContent).toBe(String(plates.length).padStart(2, '0'));
    // Lay the plates out 300px apart in a 390px viewport (jsdom has no layout).
    plates.forEach((p, i) => Object.defineProperty(p, 'offsetLeft', { value: i * 300 }));
    Object.defineProperty(strip, 'clientWidth', { value: 390 });
    strip.scrollLeft = 900;
    strip.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 5));
    expect($('[data-filmstrip-index]').textContent).toBe('04');
    expect($('[data-filmstrip-bar]').style.transform).toBe('translateX(300%)');
  });
});

/* ================= reveals.js ================= */

describe('reveals.js: scroll reveals', () => {
  it('reveals everything at once when IntersectionObserver is missing', async () => {
    document.body.innerHTML = MENU;
    const { initReveals } = await import('../scripts/reveals.js');
    initReveals();
    expect($$('.reveal:not(.is-visible)')).toHaveLength(0);
  });

  it('watches masked section headlines through their parent, since a fully clipped element never intersects', async () => {
    document.body.innerHTML = GALLERY;
    const observed = [];
    let callback;
    window.IntersectionObserver = class {
      constructor(cb) { callback = cb; }
      observe(el) { observed.push(el); }
      unobserve() {}
    };
    const { initReveals } = await import('../scripts/reveals.js');
    initReveals();

    const h2 = $('#gallery .section__head h2');
    expect(observed).not.toContain(h2);
    expect(observed).toContain(h2.parentElement);

    callback([{ isIntersecting: true, target: h2.parentElement }]);
    expect(h2.classList.contains('is-visible')).toBe(true);
    // Siblings of the headline are watched on their own, not through the head.
    const dek = $('#gallery .section__dek');
    expect(observed).toContain(dek);
    expect(dek.classList.contains('is-visible')).toBe(false);
    callback([{ isIntersecting: true, target: dek }]);
    expect(dek.classList.contains('is-visible')).toBe(true);
    delete window.IntersectionObserver;
  });

  it('reveals on the first visible pixel, with no shrunken viewport', async () => {
    document.body.innerHTML = MENU;
    let options;
    window.IntersectionObserver = class {
      constructor(cb, opts) { options = opts; }
      observe() {}
      unobserve() {}
    };
    const { initReveals } = await import('../scripts/reveals.js');
    initReveals();
    expect(options.threshold).toBe(0);
    expect(options.rootMargin).toBeUndefined();
    delete window.IntersectionObserver;
  });

  it('reduced motion and print show every reveal as is: opaque, in place, unclipped', () => {
    const css = readFileSync(join(__dir, '..', 'styles', 'motion.css'), 'utf8');
    const block = (at) => {
      const start = css.indexOf(at);
      expect(start, at).toBeGreaterThan(-1);
      let depth = 0;
      for (let i = css.indexOf('{', start); i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
      }
      return '';
    };
    for (const at of ['@media (prefers-reduced-motion: reduce)', '@media print']) {
      const rule = block(at).match(/\.reveal,\s*\.section__head h2\.reveal\s*\{([^}]*)\}/);
      expect(rule, at).toBeTruthy();
      expect(rule[1]).toMatch(/opacity:\s*1;/);
      expect(rule[1]).toMatch(/transform:\s*none;/);
      expect(rule[1]).toMatch(/clip-path:\s*none;/);
    }
  });
});
