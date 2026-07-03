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

/** Extract the #book section markup from the real index.html. */
function bookSectionHtml() {
  const start = indexHtml.indexOf('<section class="section section--alt" id="book">');
  const end   = indexHtml.indexOf('</section>', start);
  expect(start).toBeGreaterThan(-1);
  return indexHtml.slice(start, end + '</section>'.length);
}

// A fixed "now": Monday 2026-07-06, 10:00 AM in America/New_York (14:00 UTC).
const FIXED_NOW = new Date('2026-07-06T14:00:00Z');

let rpc, grid, submitMod, cancelMod;

async function boot() {
  document.body.innerHTML = bookSectionHtml();
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

function fillPrimary({ name = 'Test Customer', phone = '4135550123', service = 'hair-cut' } = {}) {
  fill('input[name="name"]', name);
  fill('input[name="phone"]', phone);
  fill('[data-service-select]', service);
}

beforeEach(async () => {
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] });
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

  it('disables Tuesday for Hassan but keeps his Sunday open', () => {
    const tue = $('[data-day-row] .booking__day[data-date="2026-07-07"]');
    const sun = $('[data-day-row] .booking__day[data-date="2026-07-12"]');
    expect(tue.disabled).toBe(true);
    expect(sun.disabled).toBe(false);
  });

  it("renders Hassan's Sunday slots from 10:00 (store opens late on Sundays)", () => {
    clickDay('2026-07-12');
    const pills = $$('[data-slot-grid] .booking__slot');
    expect(pills[0].dataset.time).toBe('10:00:00');
    expect(pills[pills.length - 1].dataset.time).toBe('17:30:00');
  });

  it("renders Hassan's Monday slots from 10:00 with past ones disabled", () => {
    const pills = $$('[data-slot-grid] .booking__slot');
    expect(pills[0].dataset.time).toBe('10:00:00');
    expect(pills[pills.length - 1].dataset.time).toBe('17:30:00');
    // now = 10:00 → the 10:00 slot is already "past" (m <= now), 10:30 is bookable.
    expect(pills[0].disabled).toBe(true);
    expect(pills[1].dataset.time).toBe('10:30:00');
    expect(pills[1].disabled).toBe(false);
  });

  it('switching to Javier opens Tuesday, closes Sunday, and adds the 9 AM start', () => {
    $('[data-barber-option="javier"]').click();

    expect($('[data-barber-option="javier"]').getAttribute('aria-checked')).toBe('true');
    expect($('[data-barber-option="hassan"]').getAttribute('aria-checked')).toBe('false');

    const tue = $('[data-day-row] .booking__day[data-date="2026-07-07"]');
    expect(tue.disabled).toBe(false);
    const sun = $('[data-day-row] .booking__day[data-date="2026-07-12"]');
    expect(sun.disabled).toBe(true);

    clickDay('2026-07-07');
    const pills = $$('[data-slot-grid] .booking__slot');
    expect(pills[0].dataset.time).toBe('09:00:00');
    // Availability was re-fetched for Javier.
    expect(rpc.fetchAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ barberSlug: 'javier' })
    );
  });

  it('marks slots taken from availability data and drops a stolen selection', async () => {
    rpc.fetchAvailability.mockResolvedValue([
      { barber_slug: 'hassan', booking_date: '2026-07-08', booking_time: '11:00:00', status: 'confirmed' },
    ]);
    clickDay('2026-07-08');
    clickSlot('11:30:00');
    expect($('[data-form-time]').value).toBe('11:30:00');

    await grid.refreshAvailability();
    const taken = $('[data-slot-grid] .booking__slot[data-time="11:00:00"]');
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

  it('selection pill shows day, time, and barber', () => {
    clickDay('2026-07-08');
    clickSlot('11:00:00');
    expect($('[data-selected-pill]').hidden).toBe(false);
    expect($('[data-selected-text]').textContent).toBe('Wed, Jul 8 · 11:00 AM · Hassan');
  });
});

/* ================= Submit: success path ================= */

describe('booking submit — success', () => {
  it('books a single cut with the selected barber and shows the success card', async () => {
    rpc.bookSlot.mockResolvedValue([{
      booking_id: 'b1', slot_index: 0, booking_time: '11:00:00',
      booking_status: 'confirmed', hold_expires_at: null, total_price_cents: 4000,
    }]);

    $('[data-barber-option="javier"]').click();
    clickDay('2026-07-08');
    clickSlot('11:00:00');
    fillPrimary();
    $('input[name="addons"][value="beard"]').click();
    expect($('[data-total-display]').textContent).toBe('$40');

    $('[data-submit-whatsapp]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));

    expect(rpc.bookSlot).toHaveBeenCalledWith(expect.objectContaining({
      barberSlug: 'javier',
      serviceSlug: 'hair-cut',
      date: '2026-07-08',
      time: '11:00:00',
      name: 'Test Customer',
      addons: ['beard'],
    }));
    const text = $('[data-success-text]').textContent;
    expect(text).toContain('Javier will be expecting you');
    expect(text).toContain('$40');
    const link = $('[data-success-link]');
    expect(link.hidden).toBe(false);
    expect(link.href).toContain('wa.me');
    expect(decodeURIComponent(link.href)).toContain('Barber:  Javier');
  });

  it('books a group through book_slot_group and resets guest rows after', async () => {
    rpc.bookSlotGroup.mockResolvedValue([
      { booking_id: 'g1', person_index: 0, person_name: 'Test Customer',
        service_slug: 'hair-cut', booking_time: '11:00:00', total_price_cents: 3000 },
      { booking_id: 'g2', person_index: 1, person_name: 'Kiddo',
        service_slug: 'kids-cut', booking_time: '11:30:00', total_price_cents: 2500 },
    ]);

    clickDay('2026-07-08');
    clickSlot('11:00:00');
    fillPrimary();

    $('[data-add-guest]').click();
    const row = $('[data-guest-list] [data-guest]');
    row.querySelector('[data-guest-name]').value = 'Kiddo';
    row.querySelector('[data-guest-name]').dispatchEvent(new Event('input', { bubbles: true }));
    row.querySelector('[data-guest-service]').value = 'kids-cut';
    row.querySelector('[data-guest-service]').dispatchEvent(new Event('change', { bubbles: true }));

    expect($('[data-total-display]').textContent).toBe('$55');
    expect($('[data-group-timeline]').hidden).toBe(false);
    expect($('[data-group-timeline]').textContent).toContain('Kiddo — 11:30 AM');

    $('[data-submit-sms]').click();
    await vi.waitFor(() => expect($('[data-form-success]').hidden).toBe(false));

    expect(rpc.bookSlotGroup).toHaveBeenCalledWith(expect.objectContaining({
      barberSlug: 'hassan',
      date: '2026-07-08',
      startTime: '11:00:00',
      people: [
        expect.objectContaining({ name: 'Test Customer', serviceSlug: 'hair-cut' }),
        expect.objectContaining({ name: 'Kiddo', serviceSlug: 'kids-cut' }),
      ],
    }));
    // Guest rows cleared after success (back-button safety).
    expect($$('[data-guest-list] [data-guest]')).toHaveLength(0);
  });
});

/* ================= Submit: validation + failure paths ================= */

describe('booking submit — validation and failures', () => {
  it('blocks submit without a slot selection', async () => {
    fillPrimary();
    $('[data-submit-whatsapp]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    expect($('[data-form-error]').textContent).toContain('Pick a day and a time');
    expect(rpc.bookSlot).not.toHaveBeenCalled();
  });

  it('blocks submit with a short phone number', async () => {
    clickDay('2026-07-08');
    clickSlot('11:00:00');
    fillPrimary({ phone: '55501' });
    $('[data-submit-whatsapp]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));
    expect($('[data-form-error]').textContent).toContain('10-digit');
    expect(rpc.bookSlot).not.toHaveBeenCalled();
  });

  it('disables submit while a guest overruns closing time (duration-aware)', () => {
    clickDay('2026-07-08');
    clickSlot('17:00:00');
    fillPrimary({ service: 'vip-haircut' });   // VIP 5:00–6:00, guest would start 6:00

    $('[data-add-guest]').click();
    const row = $('[data-guest-list] [data-guest]');
    row.querySelector('[data-guest-name]').value = 'Friend';
    row.querySelector('[data-guest-name]').dispatchEvent(new Event('input', { bubbles: true }));
    row.querySelector('[data-guest-service]').value = 'hair-cut';
    row.querySelector('[data-guest-service]').dispatchEvent(new Event('change', { bubbles: true }));

    const timeline = $('[data-group-timeline]');
    expect(timeline.textContent).toContain('⚠ past closing');
    expect($('[data-submit-whatsapp]').disabled).toBe(true);
    expect($('[data-submit-sms]').disabled).toBe(true);

    // Moving to an earlier slot clears the overrun and re-enables submit.
    clickSlot('15:00:00');
    expect(timeline.textContent).not.toContain('⚠ past closing');
    expect($('[data-submit-whatsapp]').disabled).toBe(false);
  });

  it('hard-fails on slot_taken: error card, no fallback, availability refreshed', async () => {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError('slot_taken'));

    clickDay('2026-07-08');
    clickSlot('11:00:00');
    fillPrimary();
    const callsBefore = rpc.fetchAvailability.mock.calls.length;

    $('[data-submit-whatsapp]').click();
    await vi.waitFor(() => expect($('[data-form-error]').hidden).toBe(false));

    expect($('[data-form-error]').textContent).toContain('just booked');
    expect($('[data-form-fallback]').hidden).toBe(true);
    expect($('[data-form-success]').hidden).toBe(true);
    expect(rpc.logBookingError).not.toHaveBeenCalled();
    expect(rpc.fetchAvailability.mock.calls.length).toBeGreaterThan(callsBefore);
    // Selection cleared so the user must re-pick a fresh slot.
    expect($('[data-form-time]').value).toBe('');
  });

  it('soft-fails on other errors: logs it and still routes to messaging', async () => {
    rpc.bookSlot.mockRejectedValue(new rpc.BookingError('network'));

    clickDay('2026-07-08');
    clickSlot('11:00:00');
    fillPrimary();
    $('[data-submit-whatsapp]').click();
    await vi.waitFor(() => expect($('[data-form-fallback]').hidden).toBe(false));

    expect(rpc.logBookingError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'network',
      attempted: expect.objectContaining({ barber: 'hassan', date: '2026-07-08' }),
    }));
    const link = $('[data-fallback-link]');
    expect(link.hidden).toBe(false);
    expect(decodeURIComponent(link.href)).toContain('BOOKING SYSTEM ERROR');
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
