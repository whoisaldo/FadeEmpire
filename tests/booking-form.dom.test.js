// @vitest-environment jsdom
//
// Integration tests for the booking form: the REAL markup from index.html
// (the whole #book section, including the guest template and cancel panel)
// wired up with the real booking-grid/booking-submit/booking-cancel modules.
// Only the RPC layer (Supabase) is mocked — so these tests catch broken
// selectors, event wiring, validation, barber switching, and both the
// success and failure submit paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---- Mock the RPC layer (this also keeps the esm.sh supabase import out) ----
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
    findBookingsByPhone: vi.fn(async () => []),
    cancelBooking:       vi.fn(async () => {}),
  };
});

const __dir = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dir, '..', 'index.html'), 'utf8');

/** Extract the #book section markup from the real index.html, whatever
 *  classes the section carries this week. */
function bookSectionHtml() {
  const open = indexHtml.match(/<section[^>]*\sid="book"[^>]*>/);
  expect(open, 'a <section id="book"> in index.html').toBeTruthy();
  const start = open.index;
  const end   = indexHtml.indexOf('</section>', start);
  return indexHtml.slice(start, end + '</section>'.length);
}

// A fixed "now": Monday 2026-07-06, 10:00 AM in America/New_York (14:00 UTC).
const FIXED_NOW = new Date('2026-07-06T14:00:00Z');

let rpc, grid, submitMod, cancelMod;

async function boot(extraHtml = '') {
  document.body.innerHTML = extraHtml + bookSectionHtml();
  rpc       = await import('../scripts/booking-rpc.js');
  grid      = await import('../scripts/booking-grid.js');
  submitMod = await import('../scripts/booking-submit.js');
  cancelMod = await import('../scripts/booking-cancel.js');
  submitMod.initBookingSubmit();
  cancelMod.initBookingCancel();
  await grid.initBookingGrid();
}

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function fill(sel, value) {
  const el = $(sel);
  el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function clickDay(iso) {
  const chip = $(`[data-day-row] .booking__day[data-date="${iso}"]`);
  expect(chip, `day chip ${iso}`).toBeTruthy();
  chip.click();
}

function clickSlot(hms) {
  const pill = $(`[data-slot-grid] .booking__slot[data-time="${hms}"]`);
  expect(pill, `slot pill ${hms}`).toBeTruthy();
  pill.click();
}

/** Switch barber and let his availability read land (slots take no taps before it). */
async function pickBarber(slug) {
  $(`[data-barber-option="${slug}"]`).click();
  await vi.waitFor(() => expect($('[data-slot-grid] .booking__slot.is-loading')).toBeNull());
}

function fillPrimary({ name = 'Test Customer', phone = '4135550123', service = 'hair-cut' } = {}) {
  fill('input[name="name"]', name);
  fill('input[name="phone"]', phone);
  fill('[data-service-select]', service);
}

beforeEach(async () => {
  // Date + intervals are faked (the grid's midnight/refresh timers); timeouts
  // stay real so vi.waitFor and the modules' rAF fallbacks keep working.
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.resetModules();

  // jsdom gaps the modules rely on
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  Element.prototype.scrollIntoView = vi.fn();
  window.open = vi.fn().mockReturnValue({ closed: false, close: vi.fn(), location: {} });
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  }

  // Mock implementations survive vi.resetModules() (clearAllMocks only clears
  // call history), so re-prime availability or a prior test's taken slots leak
  // into the next boot's grid and disable the pill that test is about to click.
  rpc = await import('../scripts/booking-rpc.js');
  rpc.fetchAvailability.mockResolvedValue([]);

  await boot();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

/* ================= Grid + barber switching ================= */

describe('booking grid', () => {
  it('renders 14 day chips and pre-selects the first open day', () => {
    const chips = $$('[data-day-row] .booking__day');
    expect(chips).toHaveLength(14);
    // Monday Jul 6 is open for Hassan (default barber) → selected.
    expect(chips[0].dataset.date).toBe('2026-07-06');
    expect(chips[0].getAttribute('aria-selected')).toBe('true');
  });

  it('disables Tuesday (shop closed) but keeps Sunday open', () => {
    const tue = $('[data-day-row] .booking__day[data-date="2026-07-07"]');
    const sun = $('[data-day-row] .booking__day[data-date="2026-07-12"]');
    expect(tue.disabled).toBe(true);
    expect(sun.disabled).toBe(false);
  });

  it("renders Hassan's Sunday slots from 10:00 (every day opens at 10)", () => {
    clickDay('2026-07-12');
    const pills = $$('[data-slot-grid] .booking__slot');
    expect(pills[0].dataset.time).toBe('10:00:00');
    expect(pills[pills.length - 1].dataset.time).toBe('17:30:00');
  });

  it("renders Hassan's Monday slots from 10:00 with past ones disabled", () => {
    const pills = $$('[data-slot-grid] .booking__slot');
    expect(pills[0].dataset.time).toBe('10:00:00');
    expect(pills[pills.length - 1].dataset.time).toBe('17:30:00');
    // now = 10:00 → the 10:00 slot is already "past" (m <= now), 10:45 is bookable.
    expect(pills[0].disabled).toBe(true);
    expect(pills[1].dataset.time).toBe('10:45:00');
    expect(pills[1].disabled).toBe(false);
  });

  it('switching to Larry keeps Tuesday closed, keeps Sunday open, and re-fetches his grid', () => {
    $('[data-barber-option="larry"]').click();

    expect($('[data-barber-option="larry"]').getAttribute('aria-checked')).toBe('true');
    expect($('[data-barber-option="hassan"]').getAttribute('aria-checked')).toBe('false');

    // The shop is closed Tuesdays — no barber unlocks it.
    const tue = $('[data-day-row] .booking__day[data-date="2026-07-07"]');
    expect(tue.disabled).toBe(true);
    const sun = $('[data-day-row] .booking__day[data-date="2026-07-12"]');
    expect(sun.disabled).toBe(false);

    clickDay('2026-07-08');
    const pills = $$('[data-slot-grid] .booking__slot');
    expect(pills[0].dataset.time).toBe('10:00:00');
    // Availability was re-fetched for Larry.
    expect(rpc.fetchAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ barberSlug: 'larry' })
    );
  });

  it('marks slots taken from availability data and drops a stolen selection', async () => {
    rpc.fetchAvailability.mockResolvedValue([
      { barber_slug: 'hassan', booking_date: '2026-07-08', booking_time: '10:45:00', status: 'confirmed' },
    ]);
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    expect($('[data-form-time]').value).toBe('11:30:00');

    await grid.refreshAvailability();
    const taken = $('[data-slot-grid] .booking__slot[data-time="10:45:00"]');
    expect(taken.disabled).toBe(true);
    expect(taken.classList.contains('is-taken')).toBe(true);
    // Our own selection (11:30) survives the re-render.
    expect($('[data-form-time]').value).toBe('11:30:00');
    expect($(`[data-slot-grid] .booking__slot[data-time="11:30:00"]`).classList.contains('is-selected')).toBe(true);

    // Now someone books OUR slot → selection must be dropped.
    rpc.fetchAvailability.mockResolvedValue([
      { barber_slug: 'hassan', booking_date: '2026-07-08', booking_time: '11:30:00', status: 'confirmed' },
    ]);
    await grid.refreshAvailability();
    expect($('[data-form-time]').value).toBe('');
  });

  it('a failed availability read offers no slot, says so, and Retry recovers (P2)', async () => {
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.fetchAvailability.mockRejectedValueOnce(new rpc.BookingError('network'));
    await grid.refreshAvailability();

    const slots = $('[data-slot-grid]');
    expect(slots.textContent).toContain("Couldn't load open times.");
    expect($$('[data-slot-grid] .booking__slot')).toHaveLength(0);
    expect($('[data-form-time]').value).toBe('');            // nothing selectable, nothing kept
    expect($('[data-form-date]').value).toBe('2026-07-08');  // the day stays

    rpc.fetchAvailability.mockResolvedValueOnce([
      { barber_slug: 'hassan', booking_date: '2026-07-08', booking_time: '10:45:00', status: 'confirmed' },
    ]);
    $('[data-slots-retry]').click();
    await vi.waitFor(() => expect($$('[data-slot-grid] .booking__slot')).toHaveLength(11));
    expect($('[data-slot-grid] .booking__slot[data-time="10:45:00"]').classList.contains('is-taken')).toBe(true);
    expect($('[data-slot-grid] .booking__slot[data-time="11:30:00"]').disabled).toBe(false);
  });

  it('pills take no taps until the first read lands: loading is not "all open" (P2)', async () => {
    let resolve;
    rpc.fetchAvailability.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    $('[data-barber-option="larry"]').click();
    clickDay('2026-07-08');
    const pills = $$('[data-slot-grid] .booking__slot');
    expect(pills.length).toBe(11);
    expect(pills.every(p => p.disabled && p.classList.contains('is-loading'))).toBe(true);
    expect($('[data-slot-grid]').hasAttribute('aria-busy')).toBe(true);

    resolve([]);   // an empty successful read: every slot is open
    await vi.waitFor(() => expect($('[data-slot-grid] .booking__slot').disabled).toBe(false));
    expect($$('[data-slot-grid] .booking__slot.is-loading')).toHaveLength(0);
    expect($('[data-slot-grid]').hasAttribute('aria-busy')).toBe(false);
  });

  it('selection pill shows day, time, and barber', () => {
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    expect($('[data-selected-pill]').hidden).toBe(false);
    expect($('[data-selected-text]').textContent).toBe('Wed, Jul 8 · 11:30 AM · Hassan');
  });
});

/* ================= Submit: success path ================= */

describe('booking submit — success', () => {
  it('books a single cut with the selected barber and shows the success card', async () => {
    rpc.bookSlot.mockResolvedValue([{
      booking_id: 'b1', slot_index: 0, booking_time: '11:30:00',
      booking_status: 'confirmed', hold_expires_at: null, total_price_cents: 4000,
    }]);

    await pickBarber('larry');
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('input[name="addons"][value="beard"]').click();
    expect($('[data-total-display]').textContent).toBe('$40');

    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));

    expect(rpc.bookSlot).toHaveBeenCalledWith(expect.objectContaining({
      barberSlug: 'larry',
      serviceSlug: 'hair-cut',
      date: '2026-07-08',
      time: '11:30:00',
      name: 'Test Customer',
      addons: ['beard'],
    }));
    expect($('[data-success-text]').textContent).toBe('Wednesday, July 8 · Larry');
    expect($$('[data-success-list] li').map(li => li.textContent))
      .toEqual(['Test Customer · Hair Cut + Beard · 11:30 AM']);
    expect($('[data-success-total]').textContent).toBe('$40');
    const link = $('[data-form-success] [data-send-whatsapp]');
    expect(link.hidden).toBe(false);
    expect(link.href).toContain('wa.me');
    expect(decodeURIComponent(link.href)).toContain('Barber:  Larry');
  });

  it('after a booking, focus lands on the confirmation and the always-present status region announces it (D8)', async () => {
    const live = $('[data-live-status]');
    expect(live).toBeTruthy();
    expect(live.getAttribute('role')).toBe('status');
    expect(live.hidden).toBe(false);
    expect(live.textContent).toBe('');
    expect($('[data-live-alert]').getAttribute('role')).toBe('alert');

    rpc.bookSlot.mockResolvedValue([{ booking_id: 'f1', slot_index: 0, booking_time: '11:30:00', total_price_cents: 3000 }]);
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-submit]').focus();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    expect(document.activeElement).toBe($('[data-form-success]'));
    expect($('[data-form-success]').getAttribute('tabindex')).toBe('-1');
    await vi.waitFor(() => expect(live.textContent).toBe("Your chair is reserved. Send the message so Hassan has your details; he'll reply to confirm."));
  });

  it('an error is announced through the alert region and takes focus (D8)', async () => {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError('barber_not_found'));
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    expect(document.activeElement).toBe($('[data-form-error]'));
    await vi.waitFor(() => expect($('[data-live-alert]').textContent).toContain('not accepting online bookings'));
  });

  it('submitting without a time marks the slot grid invalid and focuses the first open time (D9)', async () => {
    clickDay('2026-07-08');
    fillPrimary();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    const grid = $('[data-slot-grid]');
    expect(grid.getAttribute('aria-invalid')).toBe('true');
    expect(grid.getAttribute('aria-describedby')).toBe('booking-error');
    expect($('#booking-error').textContent).toContain('Pick a day and a time');
    expect(document.activeElement).toBe($('[data-slot-grid] .booking__slot:not([disabled])'));
    clickSlot('11:30:00');                                      // fixing it clears the mark
    expect(grid.hasAttribute('aria-invalid')).toBe(false);
  });

  it('a short phone is marked, described by the error, focused, and cleared on edit (D9)', async () => {
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary({ phone: '55501' });
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    const phone = $('input[name="phone"]');
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(phone.getAttribute('aria-describedby')).toBe('booking-error');
    expect(document.activeElement).toBe(phone);
    fill('input[name="phone"]', '4135550123');
    expect(phone.hasAttribute('aria-invalid')).toBe(false);
  });

  it('a party past closing says why Reserve is off, next to it, in a live region (D9)', () => {
    const note = $('[data-overrun-note]');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe('');
    expect($('[data-submit]').getAttribute('aria-describedby')).toBe(note.id);
    clickDay('2026-07-08');
    clickSlot('17:30:00');
    fillPrimary();
    $('[data-add-guest]').click();
    fill('[data-guest-list] [data-guest-name]', 'Friend');
    fill('[data-guest-list] [data-guest-service]', 'hair-cut');
    expect($('[data-submit]').disabled).toBe(true);
    expect(note.textContent).toBe('The last person would start after closing. Pick an earlier time or fewer people.');
    clickSlot('14:30:00');
    expect($('[data-submit]').disabled).toBe(false);
    expect(note.textContent).toBe('');
  });

  it('removing a guest moves focus to Add, not the top of the page (D8)', () => {
    $('[data-add-guest]').click();
    $('[data-add-guest]').click();
    $$('[data-guest-list] [data-remove-guest]')[0].click();
    expect(document.activeElement).toBe($('[data-add-guest]'));
  });

  it('one Reserve button books first; the card then offers the message by WhatsApp only on a desktop (D18, D3)', async () => {
    rpc.bookSlot.mockResolvedValue([{ booking_id: 'd1', slot_index: 0, booking_time: '11:30:00', total_price_cents: 3000 }]);
    expect($$('[data-booking-form] [type="submit"]')).toHaveLength(1);
    expect($('[data-submit]').textContent.trim()).toBe('Reserve');
    expect($('[data-booking-form]').textContent).not.toContain('Reserve by text');
    expect($('[data-booking-form]').textContent).not.toContain('Reserve on WhatsApp');

    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));

    expect(window.open).not.toHaveBeenCalled();             // no blank placeholder tab
    expect(rpc.bookSlot).toHaveBeenCalledTimes(1);           // booked before any channel is chosen
    const card = $('[data-form-success]');
    expect(card.querySelector('[data-success-next]').textContent)
      .toBe("Your chair is reserved. Send the message so Hassan has your details; he'll reply to confirm.");
    expect(card.querySelector('[data-send-head]').textContent).toBe('Send your details to Hassan:');
    const wa = card.querySelector('[data-send-whatsapp]');
    expect(wa.textContent).toBe('WhatsApp');
    expect(wa.href).toContain('https://wa.me/14138854440?text=');
    expect(wa.target).toBe('_blank');
    expect(wa.rel).toBe('noopener');
    expect(card.querySelector('[data-send-sms]').hidden).toBe(true);   // sms: has nothing to open on a desktop
    expect(card.textContent).not.toMatch(/didn't open|Ref|tap the button/i);
  });

  it('on a phone the card offers WhatsApp and Text, both opening in place (D18, D3)', async () => {
    window.matchMedia.mockReturnValue({
      matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
    rpc.bookSlot.mockResolvedValue([{ booking_id: 'd2', slot_index: 0, booking_time: '11:30:00', total_price_cents: 3000 }]);
    await pickBarber('larry');
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    const card = $('[data-form-success]');
    expect(card.querySelector('[data-send-head]').textContent).toBe('Send your details to Larry:');
    const wa = card.querySelector('[data-send-whatsapp]');
    const sms = card.querySelector('[data-send-sms]');
    expect(wa.hasAttribute('target')).toBe(false);
    expect(sms.hidden).toBe(false);
    expect(sms.textContent).toBe('Text');
    expect(sms.href).toMatch(/^sms:\+14138854440\?&body=/);
    expect(decodeURIComponent(sms.href)).toContain('Barber:  Larry');
    expect(decodeURIComponent(wa.href)).toContain('*FADE EMPIRE — BOOKING REQUEST*');   // WhatsApp keeps its markdown
    expect(decodeURIComponent(sms.href)).not.toContain('*FADE EMPIRE');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('the fallback card says the time is not reserved and offers the same send links (D18)', async () => {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError('network'));
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-fallback]').hidden).toBe(false));
    const card = $('[data-form-fallback]');
    expect(card.textContent).toContain('Not reserved yet');
    expect(card.querySelector('[data-fallback-text]').textContent)
      .toBe("Couldn't reach the booking system, so this time isn't reserved yet. Hassan will reply to confirm once he has your details.");
    expect(card.querySelector('[data-send-head]').textContent).toBe('Send your details to Hassan:');
    expect(card.querySelector('[data-send-whatsapp]').target).toBe('_blank');
    expect(window.open).not.toHaveBeenCalled();
    expect($('[data-submit]').disabled).toBe(false);          // not booked: Reserve can be tried again
  });

  it('books a group, lists every person in the confirmation, and keeps the form until Book another (P15)', async () => {
    rpc.bookSlotGroup.mockResolvedValue([
      { booking_id: 'g1', person_index: 0, person_name: 'Test Customer',
        service_slug: 'hair-cut', booking_time: '11:30:00', total_price_cents: 3000 },
      { booking_id: 'g2', person_index: 1, person_name: 'Kiddo',
        service_slug: 'kids-cut', booking_time: '12:15:00', total_price_cents: 2500 },
    ]);

    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();

    $('[data-add-guest]').click();
    const row = $('[data-guest-list] [data-guest]');
    row.querySelector('[data-guest-name]').value = 'Kiddo';
    row.querySelector('[data-guest-name]').dispatchEvent(new Event('input', { bubbles: true }));
    row.querySelector('[data-guest-service]').value = 'kids-cut';
    row.querySelector('[data-guest-service]').dispatchEvent(new Event('change', { bubbles: true }));

    expect($('[data-total-display]').textContent).toBe('$55');
    expect($('[data-group-timeline]').hidden).toBe(false);
    expect($('[data-group-timeline]').textContent).toContain('Kiddo — 12:15 PM');

    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));

    expect(rpc.bookSlotGroup).toHaveBeenCalledWith(expect.objectContaining({
      barberSlug: 'hassan',
      date: '2026-07-08',
      startTime: '11:30:00',
      people: [
        expect.objectContaining({ name: 'Test Customer', serviceSlug: 'hair-cut' }),
        expect.objectContaining({ name: 'Kiddo', serviceSlug: 'kids-cut' }),
      ],
    }));
    // The confirmation names everyone, their service and time, and the total.
    expect($$('[data-success-list] li').map(li => li.textContent)).toEqual([
      'Test Customer · Hair Cut · 11:30 AM',
      'Kiddo · Kids Cut · 12:15 PM',
    ]);
    expect($('[data-success-total]').textContent).toBe('$55');
    // The form stays as submitted: no $0 next to a confirmed price, guests kept.
    expect($('[data-total-display]').textContent).toBe('$55');
    expect($$('[data-guest-list] [data-guest]')).toHaveLength(1);
    expect($('input[name="name"]').value).toBe('Test Customer');
    expect($('[data-submit]').disabled).toBe(true);           // Reserve is off until Book another

    const refreshes = rpc.fetchAvailability.mock.calls.length;
    $('[data-book-another]').click();
    expect($('[data-form-success]').hidden).toBe(true);
    expect($$('[data-guest-list] [data-guest]')).toHaveLength(0);
    expect($('input[name="name"]').value).toBe('');
    expect($('[data-total-display]').textContent).toBe('$0');
    expect($('[data-submit]').disabled).toBe(false);
    expect($('[data-form-time]').value).toBe('');
    expect(rpc.fetchAvailability.mock.calls.length).toBeGreaterThan(refreshes);
  });
});

/* ================= Submit: validation + failure paths ================= */

describe('booking submit — validation and failures', () => {
  it('blocks submit without a slot selection', async () => {
    fillPrimary();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    expect($('[data-form-error]').textContent).toContain('Pick a day and a time');
    expect(rpc.bookSlot).not.toHaveBeenCalled();
  });

  it('blocks submit with a short phone number', async () => {
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary({ phone: '55501' });
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    expect($('[data-form-error]').textContent).toContain('10-digit');
    expect(rpc.bookSlot).not.toHaveBeenCalled();
  });

  it('disables submit while a guest overruns closing time (duration-aware)', () => {
    clickDay('2026-07-08');
    clickSlot('17:30:00');
    fillPrimary({ service: 'vip-haircut' });   // VIP (45 min) takes the 5:30 closer, guest would start 6:15

    $('[data-add-guest]').click();
    const row = $('[data-guest-list] [data-guest]');
    row.querySelector('[data-guest-name]').value = 'Friend';
    row.querySelector('[data-guest-name]').dispatchEvent(new Event('input', { bubbles: true }));
    row.querySelector('[data-guest-service]').value = 'hair-cut';
    row.querySelector('[data-guest-service]').dispatchEvent(new Event('change', { bubbles: true }));

    const timeline = $('[data-group-timeline]');
    expect(timeline.textContent).toContain('⚠ past closing');
    expect($('[data-submit]').disabled).toBe(true);
    expect($('[data-submit]').disabled).toBe(true);

    // Moving to an earlier slot clears the overrun and re-enables submit.
    clickSlot('14:30:00');
    expect(timeline.textContent).not.toContain('⚠ past closing');
    expect($('[data-submit]').disabled).toBe(false);
  });

  it('hard-fails on slot_taken: error card, no fallback, availability refreshed', async () => {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError('slot_taken'));

    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    const callsBefore = rpc.fetchAvailability.mock.calls.length;

    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));

    expect($('[data-form-error]').textContent).toContain('just booked');
    expect($('[data-form-fallback]').hidden).toBe(true);
    expect($('[data-form-success]').hidden).toBe(true);
    expect(rpc.logBookingError).not.toHaveBeenCalled();
    expect(rpc.fetchAvailability.mock.calls.length).toBeGreaterThan(callsBefore);
    // Selection cleared so the user must re-pick a fresh slot.
    expect($('[data-form-time]').value).toBe('');
  });

  it('after slot_taken, tapping another time on the same day is enough to book (P1)', async () => {
    rpc.bookSlot.mockRejectedValueOnce(new rpc.BookingError('slot_taken'));
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    rpc.fetchAvailability.mockResolvedValue([   // the refresh after the conflict shows the stolen slot
      { barber_slug: 'hassan', booking_date: '2026-07-08', booking_time: '11:30:00', status: 'confirmed' },
    ]);
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    await vi.waitFor(() => expect($('[data-slot-grid] .booking__slot[data-time="11:30:00"]').disabled).toBe(true));

    expect($('[data-form-date]').value).toBe('2026-07-08');   // day kept, matching the highlighted chip
    expect($('[data-form-time]').value).toBe('');
    expect($('[data-day-row] .booking__day[data-date="2026-07-08"]').getAttribute('aria-selected')).toBe('true');
    expect($$('[data-slot-grid] .booking__slot.is-selected')).toHaveLength(0);

    rpc.bookSlot.mockResolvedValueOnce([{ booking_id: 'b2', slot_index: 0, booking_time: '12:15:00', total_price_cents: 3000 }]);
    clickSlot('12:15:00');
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    expect(rpc.bookSlot).toHaveBeenLastCalledWith(expect.objectContaining({ date: '2026-07-08', time: '12:15:00' }));
  });

  it('soft-fails on other errors: logs it and still routes to messaging', async () => {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError('network'));

    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-fallback]').hidden).toBe(false));

    expect(rpc.logBookingError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'network',
      attempted: expect.objectContaining({ barber: 'hassan', date: '2026-07-08' }),
    }));
    const link = $('[data-form-fallback] [data-send-whatsapp]');
    expect(link.hidden).toBe(false);
    expect(decodeURIComponent(link.href)).toContain('BOOKING SYSTEM ERROR');
  });

  async function submitWithRpcError(code) {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError(code));
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    expect($('[data-form-fallback]').hidden).toBe(true);     // no manual-message card
    expect($('[data-form-success]').hidden).toBe(true);
    expect($('[data-submit]').disabled).toBe(false);
  }

  it('too_many_active_bookings stays inline and offers Cancel a booking with the phone filled in (P16)', async () => {
    rpc.findBookingsByPhone.mockResolvedValue([]);
    await submitWithRpcError('too_many');
    expect($('[data-form-error]').textContent).toContain('Cancel one first');
    expect(rpc.logBookingError).toHaveBeenCalledWith(expect.objectContaining({ code: 'too_many' }));
    const action = $('[data-form-error-action]');
    expect(action.hidden).toBe(false);
    expect(action.textContent).toBe('Cancel a booking');

    action.click();
    expect($('[data-cancel-root]').hidden).toBe(false);
    expect($('[data-cancel-open]').getAttribute('aria-expanded')).toBe('true');
    expect($('[data-cancel-phone]').value).toBe('(413) 555-0123');
    await vi.waitFor(() => expect(rpc.findBookingsByPhone).toHaveBeenCalledWith('4135550123'));
  });

  it('invalid_phone stays inline and puts the cursor in Phone (P16)', async () => {
    await submitWithRpcError('bad_phone');
    expect($('[data-form-error]').textContent).toContain('valid 10-digit phone');
    expect($('[data-form-error-action]').hidden).toBe(true);
    expect(document.activeElement).toBe($('input[name="phone"]'));
  });

  it('service_not_found stays inline and puts the cursor in Service (P16)', async () => {
    await submitWithRpcError('service_not_found');
    expect($('[data-form-error]').textContent).toContain("That service isn't available");
    expect(document.activeElement).toBe($('[data-service-select]'));
  });

  it('outside_working_hours stays inline and asks for another time on the same day (P16)', async () => {
    await submitWithRpcError('outside_hours');
    expect($('[data-form-error]').textContent).toContain('Try a different slot');
    expect($('[data-form-time]').value).toBe('');
    expect($('[data-form-date]').value).toBe('2026-07-08');
  });

  it('the fallback request prices add-ons exactly like the on-page total (P4)', async () => {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError('network'));
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('input[name="addons"][value="hot-towel"]').click();
    $('input[name="addons"][value="facial"]').click();
    expect($('[data-total-display]').textContent).toBe('$55');
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-fallback]').hidden).toBe(false));
    const msg = decodeURIComponent($('[data-form-fallback] [data-send-whatsapp]').href);
    expect(msg).toContain('Total:   $55');
    expect(msg).not.toContain('$30');
  });

  it('a fallback "Something else" request says price at the chair, not $30 (P5)', async () => {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError('network'));
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary({ service: 'custom' });
    fill('textarea[name="custom_request"]', 'Design on the side');
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-fallback]').hidden).toBe(false));
    const msg = decodeURIComponent($('[data-form-fallback] [data-send-whatsapp]').href);
    expect(msg).toContain('Something else: Design on the side · price at the chair');
    expect(msg).toContain('Total:   Price at the chair');
    expect(msg).not.toContain('$30');
  });
});

/* ================= Cancellation flow ================= */

describe('cancellation flow', () => {
  const bookingRow = {
    booking_id: 'cafebabe-0000-0000-0000-000000000000',
    barber_slug: 'hassan',
    barber_name: 'Hassan',
    service_slug: 'hair-cut',
    service_name: 'Hair Cut',
    first_name: 'Test',
    booking_date: '2026-07-10',
    booking_time: '14:00:00',
    duration_minutes: 30,
    selected_addons: [],
    total_price_cents: 3000,
    booking_status: 'confirmed',
  };

  function openPanelAndFind(phone = '4135550123') {
    $('[data-cancel-open]').click();
    expect($('[data-cancel-root]').hidden).toBe(false);
    fill('[data-cancel-phone]', phone);
    $('[data-cancel-find]').click();
  }

  it('"Cancel a booking" toggles: a second tap closes the panel and leaves focus on the control (P18)', () => {
    const toggle = $('[data-cancel-open]');
    toggle.focus();
    toggle.click();
    expect($('[data-cancel-root]').hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe($('[data-cancel-phone]'));

    toggle.focus();
    toggle.click();
    expect($('[data-cancel-root]').hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('requires a 10-digit phone before looking anything up', async () => {
    $('[data-cancel-open]').click();
    fill('[data-cancel-phone]', '413555');
    $('[data-cancel-find]').click();
    await vi.waitFor(() => expect($('[data-cancel-status]').hidden).toBe(false));
    expect($('[data-cancel-status]').textContent).toContain('10-digit');
    expect(rpc.findBookingsByPhone).not.toHaveBeenCalled();
  });

  it('lists the bookings found for the phone', async () => {
    rpc.findBookingsByPhone.mockResolvedValue([bookingRow]);
    openPanelAndFind();
    await vi.waitFor(() => expect($$('.cancel__row')).toHaveLength(1));

    expect(rpc.findBookingsByPhone).toHaveBeenCalledWith('4135550123');
    const row = $('.cancel__row');
    expect(row.textContent).toContain('Test · Hair Cut');
    expect(row.textContent).toContain('with Hassan');
    expect(row.textContent).toContain('Fri, Jul 10 · 2:00 PM');
    expect(row.textContent).toContain('$30');
  });

  it('shows the empty state when nothing matches', async () => {
    rpc.findBookingsByPhone.mockResolvedValue([]);
    openPanelAndFind();
    await vi.waitFor(() => expect($('[data-cancel-status]').hidden).toBe(false));
    expect($('[data-cancel-status]').textContent).toContain('No upcoming bookings');
  });

  it('cancels only after a second confirming tap, then preps the barber text', async () => {
    rpc.findBookingsByPhone.mockResolvedValue([bookingRow]);
    openPanelAndFind();
    await vi.waitFor(() => expect($$('.cancel__row')).toHaveLength(1));

    const btn = $('.cancel__btn');
    btn.click();                                     // arm
    expect(btn.textContent).toContain('Tap again');
    expect(rpc.cancelBooking).not.toHaveBeenCalled();

    const gridCallsBefore = rpc.fetchAvailability.mock.calls.length;
    btn.click();                                     // confirm
    await vi.waitFor(() => expect($('.cancel__row').classList.contains('is-cancelled')).toBe(true));

    expect(rpc.cancelBooking).toHaveBeenCalledWith({
      bookingId: bookingRow.booking_id,
      phone: '4135550123',
    });

    // Prefilled cancellation text for the shop, both channels.
    const links = $$('.cancel__done a');
    expect(links).toHaveLength(2);
    const smsHref = decodeURIComponent(links[0].href);
    expect(smsHref).toContain('CANCELLATION');
    expect(smsHref).toContain('Hair Cut');
    expect(smsHref).toContain('2:00 PM');
    expect(links[1].href).toContain('wa.me');

    // Grid refreshed so the freed slot shows as open.
    expect(rpc.fetchAvailability.mock.calls.length).toBeGreaterThan(gridCallsBefore);
    expect($('[data-cancel-status]').textContent).toContain('cancelled');
  });

  it('keeps focus after lookup and after cancelling, and the status region is there from the start (D8)', async () => {
    expect($('[data-cancel-status]').hidden).toBe(false);
    expect($('[data-cancel-status]').getAttribute('role')).toBe('status');
    rpc.findBookingsByPhone.mockResolvedValue([bookingRow]);
    $('[data-cancel-open]').click();
    fill('[data-cancel-phone]', '4135550123');
    $('[data-cancel-find]').focus();
    $('[data-cancel-find]').click();
    await vi.waitFor(() => expect($$('.cancel__row')).toHaveLength(1));
    expect(document.activeElement).toBe($('[data-cancel-find]'));

    const btn = $('.cancel__btn');
    btn.focus();
    btn.click();
    btn.click();
    await vi.waitFor(() => expect($('.cancel__row').classList.contains('is-cancelled')).toBe(true));
    expect(document.activeElement).toBe($('.cancel__done'));
    expect($('[data-cancel-status]').textContent).toContain('cancelled');
  });

  it('surfaces cannot_cancel from the DB without breaking the row', async () => {
    rpc.findBookingsByPhone.mockResolvedValue([bookingRow]);
    rpc.cancelBooking.mockRejectedValue(new rpc.BookingError('cannot_cancel'));
    openPanelAndFind();
    await vi.waitFor(() => expect($$('.cancel__row')).toHaveLength(1));

    const btn = $('.cancel__btn');
    btn.click();
    btn.click();
    await vi.waitFor(() => expect($('[data-cancel-status]').dataset.tone).toBe('error'));
    expect($('[data-cancel-status]').textContent).toContain("couldn't find an active booking");
    expect($('.cancel__row').classList.contains('is-cancelled')).toBe(false);
    expect(btn.disabled).toBe(false);
  });
});

/* ================= Edge cases ================= */

describe('booking edge cases', () => {
  it('closed days carry a visible "Closed" tag, not just a faded chip', () => {
    const tue = $('[data-day-row] .booking__day[data-date="2026-07-07"]');
    expect(tue.disabled).toBe(true);
    expect(tue.textContent).toContain('Closed');
    expect(tue.querySelector('.booking__day-closed')).toBeTruthy();
    const wed = $('[data-day-row] .booking__day[data-date="2026-07-08"]');
    expect(wed.textContent).not.toContain('Closed');
  });

  it('the "next open slot" pick selects barber, day, and time in one go', async () => {
    document.dispatchEvent(new CustomEvent('booking:pick', {
      detail: { date: '2026-07-09', time: '12:15:00', barberSlug: 'larry' },
    }));
    await vi.waitFor(() => expect($('[data-form-time]').value).toBe('12:15:00'));
    expect($('[data-barber-option="larry"]').getAttribute('aria-checked')).toBe('true');
    expect($('[data-form-date]').value).toBe('2026-07-09');
    expect($('[data-selected-text]').textContent).toBe('Thu, Jul 9 · 12:15 PM · Larry');
  });

  it('"Book the VIP" in the menu selects VIP and totals it before the jump to the form (P10)', () => {
    const vipLink = indexHtml.match(/<a [^>]*class="[^"]*menu__feature-cta[^>]*>[^<]*<\/a>/)[0];
    document.body.insertAdjacentHTML('afterbegin', vipLink);
    fillPrimary({ service: 'line-up' });                     // a different service already chosen
    const link = $('.menu__feature-cta');
    expect(link.textContent).toBe('Book the VIP');
    link.click();
    expect($('[data-service-select]').value).toBe('vip-haircut');
    expect($('[data-total-display]').textContent).toBe('$60');
    expect($('input[name="addons"][value="facial"]').disabled).toBe(true);
  });

  it('Take it / Reserve it: focus moves to the first empty detail once the slot is picked (D12)', async () => {
    document.dispatchEvent(new CustomEvent('booking:pick', {
      detail: { date: '2026-07-09', time: '12:15:00', barberSlug: 'larry' },
    }));
    await vi.waitFor(() => expect(document.activeElement).toBe($('input[name="name"]')));
    expect($('[data-form-time]').value).toBe('12:15:00');
    fill('input[name="name"]', 'Pat');
    document.dispatchEvent(new CustomEvent('booking:pick', {
      detail: { date: '2026-07-09', time: '13:00:00', barberSlug: 'larry' },
    }));
    await vi.waitFor(() => expect(document.activeElement).toBe($('input[name="phone"]')));
  });

  it('Book with Larry: focus moves to his first open time once his availability is read (D12)', async () => {
    const bookWith = indexHtml.match(/<button[^>]*data-book-barber="larry"[^>]*>[^<]*<\/button>/)[0];
    vi.resetModules();                 // a fresh grid that binds the inserted button
    await boot(bookWith);
    $('button[data-book-barber="larry"]').click();
    await vi.waitFor(() => expect(document.activeElement?.classList.contains('booking__slot')).toBe(true));
    expect(document.activeElement.disabled).toBe(false);
    expect($('[data-barber-option="larry"]').getAttribute('aria-checked')).toBe('true');
  });

  it('Book the VIP: focus moves to the first open time when none is picked yet (D12)', async () => {
    const vipLink = indexHtml.match(/<a [^>]*class="[^"]*menu__feature-cta[^>]*>[^<]*<\/a>/)[0];
    document.body.insertAdjacentHTML('afterbegin', vipLink);
    $('.menu__feature-cta').click();
    await vi.waitFor(() => expect(document.activeElement?.classList.contains('booking__slot')).toBe(true));
    expect($('[data-service-select]').value).toBe('vip-haircut');
  });

  it('switching barber drops the chosen time (his grid is different) but not the day', () => {
    clickDay('2026-07-10');
    clickSlot('14:30:00');
    expect($('[data-selected-pill]').hidden).toBe(false);

    $('[data-barber-option="larry"]').click();
    expect($('[data-form-time]').value).toBe('');
    expect($('[data-selected-pill]').hidden).toBe(true);
    // The first open day is re-selected for the new barber (Fri stays open for Larry too).
    expect($('[data-form-date]').value).toBe('2026-07-06');
  });

  it('the clear button empties the selection and un-checks every pill', () => {
    clickDay('2026-07-08');
    clickSlot('13:00:00');
    $('[data-clear-selected]').click();
    expect($('[data-form-time]').value).toBe('');
    expect($('[data-selected-pill]').hidden).toBe(true);
    expect($$('[data-slot-grid] .booking__slot.is-selected')).toHaveLength(0);
  });

  it('the last slot of the day (5:30 PM) is bookable, including for a VIP', async () => {
    rpc.bookSlot.mockResolvedValue([{ booking_id: 'late', slot_index: 0, booking_time: '17:30:00', total_price_cents: 6000 }]);
    clickDay('2026-07-08');
    clickSlot('17:30:00');
    fillPrimary({ service: 'vip-haircut' });
    expect($('[data-submit]').disabled).toBe(false);
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    expect(rpc.bookSlot).toHaveBeenCalledWith(expect.objectContaining({ time: '17:30:00', serviceSlug: 'vip-haircut' }));
    expect($('[data-success-list]').textContent).toContain('5:30 PM');
  });

  it('a slot that just passed is disabled the moment the grid re-renders', () => {
    // 10:00 AM sharp: the 10:00 slot is gone, 10:45 is next.
    const first = $$('[data-slot-grid] .booking__slot');
    expect(first[0].classList.contains('is-past')).toBe(true);
    expect(first[0].title).toBe('Already passed');
    expect(first[1].disabled).toBe(false);
  });

  it('caps the party at six people, the server\'s group limit, and re-enables the button when one leaves', () => {
    expect($('.booking__group-dek').textContent).toContain('Up to six of you.');
    const add = $('[data-add-guest]');
    for (let i = 0; i < 5; i++) add.click();
    expect($$('[data-guest-list] [data-guest]')).toHaveLength(5);
    expect(add.disabled).toBe(true);
    add.click();                                          // ignored
    expect($$('[data-guest-list] [data-guest]')).toHaveLength(5);

    $$('[data-guest-list] [data-remove-guest]')[1].click();
    expect($$('[data-guest-list] [data-guest]')).toHaveLength(4);
    expect(add.disabled).toBe(false);
    // Labels re-number after a removal.
    expect($$('[data-guest-list] .booking__guest-label').map(l => l.textContent))
      .toEqual(['Friend / Kid', 'Friend / Kid #2', 'Friend / Kid #3', 'Friend / Kid #4']);
  });

  it('a half-filled guest row is refused before any RPC, with the empty field marked and focused (D9)', async () => {
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-add-guest]').click();
    fill('[data-guest-list] [data-guest-name]', 'Kid');           // no service picked
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    expect($('[data-form-error]').textContent).toContain('complete or remove the guest rows');
    const svc = $('[data-guest-list] [data-guest-service]');
    expect(svc.getAttribute('aria-invalid')).toBe('true');
    expect(svc.getAttribute('aria-describedby')).toBe('booking-error');
    expect(document.activeElement).toBe(svc);
    expect(rpc.bookSlot).not.toHaveBeenCalled();
    expect(rpc.bookSlotGroup).not.toHaveBeenCalled();
    expect($('[data-submit]').disabled).toBe(false);     // nothing left disabled
  });

  it('a group total counts every guest, and a VIP guest pushes the next one 45 minutes', () => {
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary({ service: 'hair-cut' });
    $('[data-add-guest]').click();
    $('[data-add-guest]').click();
    const rows = $$('[data-guest-list] [data-guest]');
    const set = (row, name, svc) => {
      row.querySelector('[data-guest-name]').value = name;
      row.querySelector('[data-guest-name]').dispatchEvent(new Event('input', { bubbles: true }));
      row.querySelector('[data-guest-service]').value = svc;
      row.querySelector('[data-guest-service]').dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(rows[0], 'Sam', 'vip-haircut');
    set(rows[1], 'Kid', 'kids-cut');
    expect($('[data-total-display]').textContent).toBe('$115');   // 30 + 60 + 25
    const timeline = $('[data-group-timeline]').textContent;
    expect(timeline).toContain('Sam — 12:15 PM');
    expect(timeline).toContain('Kid — 1:00 PM');
  });

  it('VIP shows its extras as included, charges only wax, and gives them back on switching away (P3)', async () => {
    rpc.bookSlot.mockResolvedValue([{ booking_id: 'v1', slot_index: 0, booking_time: '11:30:00', total_price_cents: 6500 }]);
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary({ service: 'hair-cut' });
    $('input[name="addons"][value="beard"]').click();          // chosen before switching to VIP
    expect($('[data-total-display]').textContent).toBe('$40');

    fill('[data-service-select]', 'vip-haircut');
    const addon = (v) => $(`input[name="addons"][value="${v}"]`);
    const price = (v) => addon(v).closest('.booking__addon').querySelector('.t-mono').textContent;
    for (const v of ['beard', 'hot-towel', 'facial', 'eyebrows']) {
      expect(addon(v).checked, v).toBe(true);
      expect(addon(v).disabled, v).toBe(true);
      expect(price(v), v).toBe('included');
    }
    expect(addon('wax').disabled).toBe(false);
    expect(price('wax')).toBe('+$5');
    expect($('[data-total-display]').textContent).toBe('$60');
    addon('wax').click();
    expect($('[data-total-display]').textContent).toBe('$65');

    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    expect(rpc.bookSlot).toHaveBeenCalledWith(expect.objectContaining({ serviceSlug: 'vip-haircut', addons: ['wax'] }));
  });

  it('Book another after a VIP booking gives back unticked, priced add-ons (P3, P15)', async () => {
    rpc.bookSlot.mockResolvedValue([{ booking_id: 'v2', slot_index: 0, booking_time: '11:30:00', total_price_cents: 6000 }]);
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary({ service: 'hair-cut' });
    $('input[name="addons"][value="beard"]').click();
    fill('[data-service-select]', 'vip-haircut');
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    expect($('[data-success-list] li').textContent).toBe('Test Customer · VIP Haircut · 11:30 AM');
    $('[data-book-another]').click();
    for (const v of ['beard', 'hot-towel', 'facial', 'eyebrows']) {
      const input = $(`input[name="addons"][value="${v}"]`);
      expect(input.checked, v).toBe(false);
      expect(input.disabled, v).toBe(false);
    }
    expect($('input[name="addons"][value="beard"]').closest('.booking__addon').querySelector('.t-mono').textContent).toBe('+$10');
  });

  it('Beard Trim shows the Beard add-on as included and leaves the rest selectable (D14)', () => {
    fillPrimary({ service: 'beard-trim' });
    const addon = (v) => $(`input[name="addons"][value="${v}"]`);
    expect(addon('beard').checked).toBe(true);
    expect(addon('beard').disabled).toBe(true);
    expect(addon('beard').closest('.booking__addon').querySelector('.t-mono').textContent).toBe('included');
    expect(addon('hot-towel').disabled).toBe(false);
    expect($('[data-total-display]').textContent).toBe('$15');
    addon('hot-towel').click();
    expect($('[data-total-display]').textContent).toBe('$20');
  });

  it('switching away from VIP restores the add-ons as they were (P3)', () => {
    fillPrimary({ service: 'hair-cut' });
    $('input[name="addons"][value="beard"]').click();
    fill('[data-service-select]', 'vip-haircut');
    fill('[data-service-select]', 'line-up');
    const addon = (v) => $(`input[name="addons"][value="${v}"]`);
    expect(addon('beard').checked).toBe(true);
    expect(addon('facial').checked).toBe(false);
    expect(addon('facial').disabled).toBe(false);
    expect(addon('facial').closest('.booking__addon').querySelector('.t-mono').textContent).toBe('+$20');
    expect($('[data-total-display]').textContent).toBe('$20');    // 10 + beard 10
  });

  it('a VIP guest adds $60 and books with no add-ons (guest rows carry none) (P3)', async () => {
    rpc.bookSlotGroup.mockResolvedValue([
      { booking_id: 'g1', person_index: 0, person_name: 'Test Customer', service_slug: 'line-up', booking_time: '11:30:00', total_price_cents: 1000 },
      { booking_id: 'g2', person_index: 1, person_name: 'Sam', service_slug: 'vip-haircut', booking_time: '12:15:00', total_price_cents: 6000 },
    ]);
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary({ service: 'line-up' });
    $('[data-add-guest]').click();
    const row = $('[data-guest-list] [data-guest]');
    row.querySelector('[data-guest-name]').value = 'Sam';
    row.querySelector('[data-guest-name]').dispatchEvent(new Event('input', { bubbles: true }));
    row.querySelector('[data-guest-service]').value = 'vip-haircut';
    row.querySelector('[data-guest-service]').dispatchEvent(new Event('change', { bubbles: true }));
    expect($('[data-total-display]').textContent).toBe('$70');
    $('[data-submit]').click();
    await vi.waitFor(() => expect(rpc.bookSlotGroup).toHaveBeenCalled());
    expect(rpc.bookSlotGroup.mock.calls[0][0].people[1]).toEqual(expect.objectContaining({ serviceSlug: 'vip-haircut', addons: [] }));
  });

  it('"Something else" is priced at the chair: never $0, never the $30 of the slot it holds (P5)', async () => {
    rpc.bookSlot.mockResolvedValue([{ booking_id: 'c1', slot_index: 0, booking_time: '11:30:00', total_price_cents: 3000 }]);
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary({ service: 'custom' });
    expect($('[data-custom-field]').hidden).toBe(false);
    expect($('[data-total-display]').textContent).toBe('Price at the chair');
    $('input[name="addons"][value="beard"]').click();
    expect($('[data-total-display]').textContent).toBe('$10 + price at the chair');
    $('input[name="addons"][value="beard"]').click();
    fill('textarea[name="custom_request"]', 'Mid taper, keep the length on top');
    $('[data-submit]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    expect(rpc.bookSlot).toHaveBeenCalledWith(expect.objectContaining({
      serviceSlug: 'hair-cut',                          // the slot is still held through the same mapping
      customRequest: 'Mid taper, keep the length on top',
    }));
    const card = $('[data-form-success]').textContent;
    expect($('[data-success-list] li').textContent)
      .toBe('Test Customer · Something else: Mid taper, keep the length on top · price at the chair · 11:30 AM');
    expect($('[data-success-total]').textContent).toBe('Price at the chair');
    expect(card).not.toContain('$30');
    const msg = decodeURIComponent($('[data-form-success] [data-send-whatsapp]').href);
    expect(msg).toContain('Something else: Mid taper, keep the length on top · price at the chair');
    expect(msg).toContain('Total:   Price at the chair');
    expect(msg).not.toContain('$30');
    // The custom box hides again once the customer starts over.
    $('[data-book-another]').click();
    expect($('[data-custom-field]').hidden).toBe(true);
  });

  it('formats a pasted phone with a country code down to ten digits', () => {
    fill('input[name="phone"]', '+1 (413) 885-4440');
    expect($('input[name="phone"]').value).toBe('(413) 885-4440');
    fill('[data-cancel-phone]', '14138854440');
    expect($('[data-cancel-phone]').value).toBe('(413) 885-4440');
  });

  it('double-tapping reserve sends one booking, not two', async () => {
    let resolve;
    rpc.bookSlot.mockImplementation(() => new Promise((r) => { resolve = r; }));
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    fillPrimary();
    $('[data-submit]').click();
    $('[data-submit]').click();
    $('[data-submit]').click();
    await vi.waitFor(() => expect(rpc.bookSlot).toHaveBeenCalledTimes(1));
    expect($('[data-submit]').disabled).toBe(true);
    resolve([{ booking_id: 'x', slot_index: 0, booking_time: '11:30:00', total_price_cents: 3000 }]);
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));
    expect(rpc.bookSlot).toHaveBeenCalledTimes(1);
    // Booked: Reserve stays off until the customer starts over (D7).
    expect($('[data-submit]').disabled).toBe(true);
    $('[data-submit]').click();
    $('[data-booking-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(rpc.bookSlot).toHaveBeenCalledTimes(1);
    $('[data-book-another]').click();
    expect($('[data-submit]').disabled).toBe(false);
  });

  it('rebuilds the day row when the tab wakes up on a new day', async () => {
    expect($$('[data-day-row] .booking__day')[0].dataset.date).toBe('2026-07-06');
    vi.setSystemTime(new Date('2026-07-07T14:00:00Z'));     // Tuesday, next morning
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect($$('[data-day-row] .booking__day')[0].dataset.date).toBe('2026-07-07'));
    // Today is the closed Tuesday, so Wednesday is pre-selected.
    expect($('[data-form-date]').value).toBe('2026-07-08');
    expect(rpc.fetchAvailability).toHaveBeenCalledWith(expect.objectContaining({ fromDate: '2026-07-07' }));
  });

  async function bootAt(iso) {
    vi.resetModules();
    vi.setSystemTime(new Date(iso));
    await boot();
  }

  it('after the last slot, today reads "No slots left" and the next open day is selected (D5)', async () => {
    await bootAt('2026-07-06T21:45:00Z');                    // Mon 5:45 PM EDT, Tue closed
    const mon = $('[data-day-row] .booking__day[data-date="2026-07-06"]');
    expect(mon.disabled).toBe(true);
    expect(mon.textContent).toContain('No slots left');
    expect($('[data-day-row] .booking__day[data-date="2026-07-07"]').textContent).toContain('Closed');
    expect($('[data-form-date]').value).toBe('2026-07-08');
    expect($('[data-day-row] .booking__day[data-date="2026-07-08"]').getAttribute('aria-selected')).toBe('true');
    expect($$('[data-slot-grid] .booking__slot:not([disabled])')).toHaveLength(11);
  });

  it('just before the 5:30 slot, today is still offered (D5)', async () => {
    await bootAt('2026-07-06T21:29:00Z');                    // Mon 5:29 PM EDT
    expect($('[data-form-date]').value).toBe('2026-07-06');
    expect($('[data-slot-grid] .booking__slot[data-time="17:30:00"]').disabled).toBe(false);
    expect($('[data-day-row] .booking__day[data-date="2026-07-06"]').textContent).not.toContain('No slots left');
  });

  it('on a closed Tuesday the next open day is selected (D5)', async () => {
    await bootAt('2026-07-07T14:00:00Z');                    // Tue 10 AM EDT
    expect($('[data-day-row] .booking__day[data-date="2026-07-07"]').textContent).toContain('Closed');
    expect($('[data-form-date]').value).toBe('2026-07-08');
  });

  it('when today runs out with the tab open, the chip updates and a pick on another day stays (D5)', async () => {
    clickDay('2026-07-09');
    clickSlot('11:30:00');
    // The five-minute tick (not visibilitychange: earlier tests' module
    // instances still listen on this document) carries the clock past 5:30.
    vi.setSystemTime(new Date('2026-07-06T21:26:00Z'));
    vi.advanceTimersByTime(5 * 60_000);                      // 5:31 PM: the last slot has started
    await vi.waitFor(() => expect($('[data-day-row] .booking__day[data-date="2026-07-06"]').disabled).toBe(true));
    expect($('[data-day-row] .booking__day[data-date="2026-07-06"]').textContent).toContain('No slots left');
    expect($('[data-form-date]').value).toBe('2026-07-09');
    expect($('[data-form-time]').value).toBe('11:30:00');
  });

  it('the day row lists each date once across the November DST change', async () => {
    vi.setSystemTime(new Date('2026-10-25T04:30:00Z'));     // Sun Oct 25, 00:30 EDT
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect($$('[data-day-row] .booking__day')[0].dataset.date).toBe('2026-10-25'));
    const dates = $$('[data-day-row] .booking__day').map(c => c.dataset.date);
    expect(dates).toHaveLength(14);
    expect(new Set(dates).size).toBe(14);
    expect(dates[7]).toBe('2026-11-01');
    expect(dates[13]).toBe('2026-11-07');
    const nov1 = $('[data-day-row] .booking__day[data-date="2026-11-01"]');
    expect(nov1.textContent.replace(/\s+/g, ' ').trim()).toBe('Sun 1 Nov');
    expect($('[data-day-row] .booking__day[data-date="2026-11-03"]').disabled).toBe(true);   // a Tuesday
  });

  it('refreshes availability every five minutes while the tab is visible', () => {
    const before = rpc.fetchAvailability.mock.calls.length;
    vi.advanceTimersByTime(5 * 60_000);
    expect(rpc.fetchAvailability.mock.calls.length).toBe(before + 1);
  });
});
