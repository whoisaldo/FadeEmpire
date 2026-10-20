// Drift guards for index.html. Prices, hours, and barbers live in config.js
// (mirrored from the database and checked against it by tests/ci/live-health
// .mjs); the page repeats them in the menu, the booking form, the hours card,
// and the structured data. Editing one and forgetting another is the easiest
// way to lie to a customer, so this file reads the real markup and compares.
// It also checks that every image and video the page references exists on
// disk, which the asset pipeline (tools/build-assets.py) can otherwise break.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STORE_HOURS, BARBERS, SERVICE_PRICES_CENTS, SERVICE_DURATIONS_MIN,
  ADDON_PRICES_CENTS, SLOT_MINUTES,
} from '../scripts/config.js';
import { SERVICE_LABELS } from '../scripts/booking-messages.js';
import { minutesToShortLabel, formatPrice } from '../scripts/booking-helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHEMA_DAYS   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** All <select> blocks in the page, as [{ attrs, options: [[value, label]] }]. */
function selects() {
  return [...html.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)].map((m) => ({
    attrs: m[1],
    options: [...m[2].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((o) => [o[1], o[2].trim()]),
  }));
}

function serviceOptionPrice(label) {
  const m = label.match(/\$(\d+)/);
  return m ? Number(m[1]) * 100 : null;
}

describe('service prices in the markup match config.js', () => {
  const primary = selects().find((s) => s.attrs.includes('data-service-select'));
  const guest   = selects().find((s) => s.attrs.includes('data-guest-service'));

  it('the booking form offers every priced service, at the configured price', () => {
    expect(primary).toBeTruthy();
    for (const [slug, cents] of Object.entries(SERVICE_PRICES_CENTS)) {
      const opt = primary.options.find(([value]) => value === slug);
      expect(opt, `option for ${slug}`).toBeTruthy();
      expect(serviceOptionPrice(opt[1]), `price shown for ${slug}`).toBe(cents);
    }
  });

  it('the form only offers known slugs (plus the empty prompt and "custom")', () => {
    const allowed = new Set([...Object.keys(SERVICE_PRICES_CENTS), 'custom', '']);
    for (const [value] of primary.options) expect(allowed.has(value), `unknown slug ${value}`).toBe(true);
  });

  it('guest rows offer the same services as the primary select, minus "custom"', () => {
    expect(guest).toBeTruthy();
    const primarySlugs = primary.options.map(([v]) => v).filter((v) => v && v !== 'custom');
    const guestSlugs   = guest.options.map(([v]) => v).filter(Boolean);
    expect(guestSlugs).toEqual(primarySlugs);
    for (const [value, label] of guest.options) {
      if (value) expect(serviceOptionPrice(label)).toBe(SERVICE_PRICES_CENTS[value]);
    }
  });

  it('the typeset menu lists each service once with the configured price', () => {
    const items = [...html.matchAll(/<li class="menu__item">[\s\S]*?menu__name[^>]*>([^<]+)<[\s\S]*?menu__price[^>]*>\$(\d+)<\/span>/g)]
      .map((m) => [m[1].trim(), Number(m[2]) * 100]);
    const byLabel = Object.fromEntries(Object.entries(SERVICE_LABELS).map(([slug, label]) => [label, slug]));
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const [name, cents] of items) {
      const slug = byLabel[name];
      expect(slug, `menu item "${name}" is a known service`).toBeTruthy();
      expect(cents, `menu price for ${name}`).toBe(SERVICE_PRICES_CENTS[slug]);
    }
  });

  it('the VIP card, the comparison, and the JSON-LD price range agree with config', () => {
    const vip = SERVICE_PRICES_CENTS['vip-haircut'];
    expect(html).toContain(`<span class="t-price--lg">${formatPrice(vip)}</span>`);
    expect(html.match(/compare__price">\$60</g)?.length).toBeGreaterThanOrEqual(2);
    const prices = Object.values(SERVICE_PRICES_CENTS);
    expect(html).toContain(`"priceRange": "${formatPrice(Math.min(...prices))}–${formatPrice(Math.max(...prices))}"`);
  });

  it('the VIP copy states its real chair time', () => {
    expect(html).toContain(`${SERVICE_DURATIONS_MIN['vip-haircut']}-minute sitting`);
    expect(html).toContain(`${SLOT_MINUTES}-min appointments`);
  });
});

describe('add-ons in the markup match config.js', () => {
  it('every add-on checkbox exists with the configured price', () => {
    for (const [slug, cents] of Object.entries(ADDON_PRICES_CENTS)) {
      const re = new RegExp(`name="addons" value="${slug}"><span>[^<]+</span><span class="t-mono">([^<]+)</span>`);
      const m = html.match(re);
      expect(m, `checkbox for ${slug}`).toBeTruthy();
      expect(m[1]).toBe(cents === 0 ? 'free' : `+${formatPrice(cents)}`);
    }
  });

  it('there is no add-on checkbox the config does not know about', () => {
    const slugs = [...html.matchAll(/name="addons" value="([^"]+)"/g)].map((m) => m[1]);
    expect(slugs.sort()).toEqual(Object.keys(ADDON_PRICES_CENTS).sort());
  });

  it('the menu add-on list shows the same prices', () => {
    const rows = [...html.matchAll(/<li><span class="t-display-sm">([^<]+)<\/span><span class="t-price">([^<]+)<\/span><\/li>/g)];
    expect(rows).toHaveLength(Object.keys(ADDON_PRICES_CENTS).length);
    for (const [, name, price] of rows) {
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      expect(ADDON_PRICES_CENTS[slug], `menu add-on ${name}`).not.toBeUndefined();
      expect(price).toBe(ADDON_PRICES_CENTS[slug] === 0 ? 'free' : `+${formatPrice(ADDON_PRICES_CENTS[slug])}`);
    }
  });
});

describe('hours in the markup match STORE_HOURS', () => {
  it('the hours card has one row per weekday with the right times or "Closed"', () => {
    const rows = [...html.matchAll(/<li data-weekday="(\d)"([^>]*)><span class="visit__day">([^<]+)<\/span><span class="t-mono">([^<]+)<\/span><\/li>/g)];
    expect(rows).toHaveLength(7);
    for (const [, wk, attrs, name, times] of rows) {
      const hours = STORE_HOURS[Number(wk)];
      expect(name).toBe(WEEKDAY_NAMES[Number(wk)]);
      if (!hours) {
        expect(times).toBe('Closed');
        expect(attrs).toContain('is-closed');
      } else {
        expect(times).toBe(`${minutesToShortLabel(hours.open)} – ${minutesToShortLabel(hours.close)}`);
        expect(attrs).not.toContain('is-closed');
      }
    }
  });

  it('the JSON-LD opening hours list exactly the open days', () => {
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const spec = ld.openingHoursSpecification[0];
    const openDays = Object.keys(STORE_HOURS).map((wk) => SCHEMA_DAYS[Number(wk)]);
    expect([...spec.dayOfWeek].sort()).toEqual([...openDays].sort());
    const [{ open, close }] = Object.values(STORE_HOURS);
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    expect(spec.opens).toBe(hhmm(open));
    expect(spec.closes).toBe(hhmm(close));
  });

  it('closed days are named in the copy, not just implied', () => {
    const closed = [0, 1, 2, 3, 4, 5, 6].filter((wk) => !STORE_HOURS[wk]).map((wk) => WEEKDAY_NAMES[wk]);
    for (const day of closed) expect(html).toContain(`Closed ${day}s`);
  });
});

describe('barbers in the markup match config.js', () => {
  it('the picker offers exactly the active barbers, and the spreads match', () => {
    const picker = [...html.matchAll(/data-barber-option="([^"]+)"/g)].map((m) => m[1]);
    const spreads = [...html.matchAll(/data-book-barber="([^"]+)"/g)].map((m) => m[1]);
    expect(picker.sort()).toEqual(Object.keys(BARBERS).sort());
    expect(spreads.sort()).toEqual(Object.keys(BARBERS).sort());
    expect(html).not.toContain('javier');
  });

  it('the structured data names each active barber', () => {
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const names = ld.employee.map((e) => e.name).sort();
    expect(names).toEqual(Object.values(BARBERS).map((b) => b.name).sort());
  });
});

describe('every asset the page references exists', () => {
  const refs = new Set();
  for (const m of html.matchAll(/\.\/assets\/[^\s"',)]+/g)) refs.add(m[0].slice(2));
  const manifest = readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8');
  for (const m of manifest.matchAll(/\.\/assets\/[^\s"',)]+/g)) refs.add(m[0].slice(2));

  it('finds a healthy number of asset references', () => {
    expect(refs.size).toBeGreaterThan(60);
  });

  it('each referenced image, video, and icon is on disk', () => {
    const missing = [...refs].filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  // The lightbox <img> is filled by scripts/gallery.js and sized by CSS.
  const pageImgs = () => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((t) => !t.includes('data-lightbox-img'));

  it('the brand images declare their real pixel size (the mark is a square-ish knight, not the old logo box)', () => {
    // PNG: width/height are the 4 bytes at offsets 16 and 20 of the IHDR chunk.
    const png = (file) => {
      const buf = readFileSync(join(ROOT, 'assets/brand', file));
      return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    };
    for (const file of ['logo-mark-240.png', 'logo-full-480.png']) {
      const tag = html.match(new RegExp(`<img[^>]*${file}[^>]*>`))?.[0];
      expect(tag, `an <img> for ${file}`).toBeTruthy();
      const [w, h] = png(file);
      expect(tag).toContain(`width="${w}"`);
      expect(tag).toContain(`height="${h}"`);
    }
  });

  it('every <img> has an alt attribute and a width/height (no layout shift)', () => {
    const imgs = pageImgs();
    expect(imgs.length).toBeGreaterThan(15);
    for (const tag of imgs) {
      expect(tag, tag).toMatch(/\balt="/);
      expect(tag, tag).toMatch(/\bwidth="\d+"/);
      expect(tag, tag).toMatch(/\bheight="\d+"/);
    }
  });

  it('only the hero image is eager; everything below the fold is lazy', () => {
    const eager = pageImgs().filter((t) => !/loading="lazy"/.test(t));
    expect(eager).toHaveLength(2);                       // hero + the nav mark
    expect(eager.some((t) => t.includes('hero-cut'))).toBe(true);
  });

  it('the tour and the motion plate start muted, inline, and without preloading', () => {
    const videos = [...html.matchAll(/<video\b[^>]*>/g)].map((m) => m[0]);
    expect(videos).toHaveLength(2);
    for (const tag of videos) {
      expect(tag).toMatch(/\bmuted\b/);
      expect(tag).toMatch(/\bplaysinline\b/);
      expect(tag).toMatch(/preload="none"/);
      expect(tag).not.toMatch(/\bautoplay\b/);            // scripts/shop-video.js starts them when visible
    }
  });
});

describe('the page before (or without) its scripts', () => {
  it('the nav stamp ships the hours, not a live state it cannot know yet', () => {
    const stamp = html.match(/<span class="([^"]*)" data-open-stamp[^>]*>([\s\S]*?)<\/span>\s*<\/span>/);
    expect(stamp).toBeTruthy();
    expect(stamp[1]).toBe('stamp');                      // no stamp--open / --closed class
    expect(stamp[2]).toMatch(/<span class="stamp__text">10–6 · Closed Tue$/);
  });

  it('the first two links are "Skip to main content" then "Skip to booking", both to real targets', () => {
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].slice(0, 2).map((m) => [m[1], m[2]]);
    expect(links).toEqual([['#main', 'Skip to main content'], ['#book', 'Skip to booking']]);
    expect(html).toMatch(/<main id="main">/);
    expect(html).toMatch(/<section[^>]*id="book"/);
  });

  it('the tour carries English captions', () => {
    expect(html).toMatch(/<track kind="captions" src="\.\/assets\/video\/shop-tour\.vtt" srclang="en" label="English">/);
  });
});

describe('the gallery and 404 styles', () => {
  /** Every top-level rule in a stylesheet, as [selectors[], body]. */
  const rules = (file) => [...readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].split(',').map((s) => s.trim()), m[2]]);

  it('gallery photos fill their plates; only the pause button sits absolutely in a corner', () => {
    const css = rules('styles/gallery.css');
    const fill = css.find(([sel]) => sel.includes('.plate img'));
    expect(fill[0]).toEqual(['.plate img', '.plate__video']);
    expect(fill[1]).toMatch(/width:\s*100%/);
    expect(fill[1]).toMatch(/object-fit:\s*cover/);
    for (const [sel, body] of css) {
      if (sel.includes('.plate img')) expect(body).not.toMatch(/position:\s*absolute/);
    }
    expect(css.find(([sel]) => sel.join() === '.plate__pause')[1]).toMatch(/position:\s*absolute/);
  });

  it('the 404 page loads its styles and icons from the site root, so nested missing URLs keep them', () => {
    const page = readFileSync(join(ROOT, '404.html'), 'utf8');
    const local = [...page.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !/^https?:/.test(h));
    expect(local.length).toBeGreaterThanOrEqual(4);
    for (const href of local) expect(href.startsWith('/')).toBe(true);
  });
});

describe('the copy is free of the old placeholders', () => {
  it('has no fake magazine chrome or invented statistics', () => {
    for (const tell of ['Issue No.', 'Chapter I', 'Plate 01', '2,000+', '★ 5.0', 'No filters', 'no AI hair']) {
      expect(html, tell).not.toContain(tell);
    }
  });
});
