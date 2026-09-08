// @vitest-environment jsdom
//
// The non-booking page modules against the real index.html markup:
//   * cover.js    the nav stamp, the hero status line, the "next open slot"
//                 lines, the phone-only compare collapse
//   * visit.js    today's row and the status in the hours card
//   * shop-video.js  the tour video (lazy file, muted default, sound toggle)
//   * gallery.js  the lightbox and the filmstrip counter
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
});

/* ================= cover.js ================= */

describe('cover.js: live status and next open slot', () => {
  async function bootCover(now) {
    vi.useFakeTimers({ now, toFake: ['Date', 'setInterval', 'clearInterval'] });
    document.body.innerHTML = HEADER + HERO + MENU + MOBILE_CTA + '<section id="book"></section>';
    const rpc = await import('../scripts/booking-rpc.js');
    const { initCover } = await import('../scripts/cover.js');
    return { rpc, initCover };
  }

  it('shows OPEN in the nav and "Closes 6 PM" in the hero during open hours', async () => {
    const { initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'));   // Wed 1 PM EDT
    initCover();
    expect($('[data-open-stamp]').classList.contains('stamp--open')).toBe(true);
    expect($('[data-open-stamp] .stamp__text').textContent).toBe('Open now');
    expect($('[data-hero-status]').dataset.state).toBe('open');
    expect($('[data-hero-status-label]').textContent).toBe('Open now');
    expect($('[data-hero-status-detail]').textContent).toBe('Closes 6 PM');
  });

  it('shows CLOSED with the next opening on the closed Tuesday', async () => {
    const { initCover } = await bootCover(new Date('2026-09-08T16:00:00Z'));   // Tue noon EDT
    initCover();
    expect($('[data-open-stamp]').classList.contains('stamp--closed')).toBe(true);
    expect($('[data-hero-status-detail]').textContent).toBe('Opens tomorrow 10 AM');
  });

  it('re-evaluates every minute so a tab left open flips at closing time', async () => {
    const { initCover } = await bootCover(new Date('2026-09-09T21:59:30Z'));   // Wed 5:59:30 PM
    initCover();
    expect($('[data-open-stamp]').classList.contains('stamp--soon')).toBe(true);
    vi.setSystemTime(new Date('2026-09-09T22:00:30Z'));                          // 6:00:30 PM
    vi.advanceTimersByTime(60_000);
    expect($('[data-open-stamp]').classList.contains('stamp--closed')).toBe(true);
    expect($('[data-hero-status-detail]').textContent).toBe('Opens tomorrow 10 AM');
  });

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

  it('keeps the next-slot lines hidden when there is nothing free or the lookup fails', async () => {
    const { rpc, initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'));
    rpc.fetchNextAvailable.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    initCover();
    await vi.advanceTimersByTimeAsync(10);
    expect($('[data-next-available]').hidden).toBe(true);
    expect($('[data-mobile-cta-next]').hidden).toBe(true);
  });

  it('collapses "Which one do I book?" on phones and keeps it open on desktop', async () => {
    let { initCover } = await bootCover(new Date('2026-09-09T17:00:00Z'));
    matchMediaMatches = (q) => q.includes('max-width: 600px');
    initCover();
    expect($('[data-compare]').open).toBe(false);

    vi.resetModules();
    ({ initCover } = await bootCover(new Date('2026-09-09T17:00:00Z')));
    matchMediaMatches = () => false;
    initCover();
    expect($('[data-compare]').open).toBe(true);
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

/* ================= gallery.js ================= */

describe('gallery.js: lightbox and filmstrip', () => {
  let api;
  async function bootGallery() {
    // jsdom has no <dialog> methods; give it the two the module uses.
    HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    document.body.innerHTML = GALLERY;
    const { initGallery } = await import('../scripts/gallery.js');
    api = initGallery();
  }

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
    document.body.innerHTML = MENU;
    const observed = [];
    let callback;
    window.IntersectionObserver = class {
      constructor(cb) { callback = cb; }
      observe(el) { observed.push(el); }
      unobserve() {}
    };
    const { initReveals } = await import('../scripts/reveals.js');
    initReveals();

    const h2 = $('#menu .section__head h2');
    expect(observed).not.toContain(h2);
    expect(observed).toContain(h2.parentElement);

    callback([{ isIntersecting: true, target: h2.parentElement }]);
    expect(h2.classList.contains('is-visible')).toBe(true);
    // Siblings of the headline are watched on their own, not through the head.
    const dek = $('#menu .section__dek');
    expect(observed).toContain(dek);
    expect(dek.classList.contains('is-visible')).toBe(false);
    callback([{ isIntersecting: true, target: dek }]);
    expect(dek.classList.contains('is-visible')).toBe(true);
    delete window.IntersectionObserver;
  });
});
