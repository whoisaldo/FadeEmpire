// Unit tests for booking-messages.js — the WhatsApp/SMS texts and deep links.

import { describe, it, expect } from 'vitest';
import {
  buildBookingMessage, buildCancelMessage, messagingUrl, SERVICE_LABELS,
} from '../scripts/booking-messages.js';
import { SHOP_PHONE, SERVICE_PRICES_CENTS } from '../scripts/config.js';

describe('messagingUrl', () => {
  it('builds a WhatsApp deep link with the encoded message', () => {
    expect(messagingUrl('whatsapp', 'hello world'))
      .toBe(`https://wa.me/${SHOP_PHONE}?text=hello%20world`);
  });

  it('builds an sms: link with the encoded body', () => {
    expect(messagingUrl('sms', 'hello & goodbye'))
      .toBe(`sms:+${SHOP_PHONE}?&body=hello%20%26%20goodbye`);
  });
});

describe('SERVICE_LABELS', () => {
  it('covers every priced service plus the custom option', () => {
    for (const slug of Object.keys(SERVICE_PRICES_CENTS)) {
      expect(SERVICE_LABELS[slug], `label for ${slug}`).toBeTruthy();
    }
    expect(SERVICE_LABELS.custom).toBeTruthy();
  });
});

describe('buildBookingMessage', () => {
  const single = {
    name: 'Test Customer',
    phone: '(413) 555-0123',
    barberName: 'Javier',
    dateLabel: 'Wednesday, July 8',
    bookings: [{
      booking_id: 'abc12345-6789',
      person_name: 'Test Customer',
      service_slug: 'hair-cut',
      booking_time: '11:00:00',
      total_price_cents: 4000,
      addons: ['beard'],
    }],
    notes: 'fade on the sides',
    customRequest: null,
    useMarkdown: true,
  };

  it('includes contact, barber, date, service, time, ref, add-ons, notes, total', () => {
    const msg = buildBookingMessage(single);
    expect(msg).toContain('*FADE EMPIRE — BOOKING REQUEST*');
    expect(msg).toContain('Contact: Test Customer');
    expect(msg).toContain('Phone:   (413) 555-0123');
    expect(msg).toContain('Barber:  Javier');
    expect(msg).toContain('Date:    Wednesday, July 8');
    expect(msg).toContain('Service: Hair Cut');
    expect(msg).toContain('Time:    11:00 AM');
    expect(msg).toContain('Ref:     abc12345');
    expect(msg).toContain('Add-ons: beard');
    expect(msg).toContain('Notes:  fade on the sides');
    expect(msg).toContain('Total:   $40');
    expect(msg).toContain('chicopeefadeempire.com');
  });

  it('drops markdown markers in SMS mode', () => {
    const msg = buildBookingMessage({ ...single, useMarkdown: false });
    expect(msg).toContain('FADE EMPIRE — BOOKING REQUEST');
    expect(msg).not.toContain('*FADE EMPIRE');
    expect(msg).not.toContain('_Sent from');
  });

  it('lists every person and the party size for group bookings', () => {
    const msg = buildBookingMessage({
      ...single,
      notes: '',
      bookings: [
        { booking_id: 'aaaa1111', person_name: 'Dad', service_slug: 'hair-cut',
          booking_time: '11:00:00', total_price_cents: 3000, addons: [] },
        { booking_id: 'bbbb2222', person_name: 'Kid', service_slug: 'kids-cut',
          booking_time: '11:30:00', total_price_cents: 2500, addons: [] },
      ],
    });
    expect(msg).toContain('Party:   2 people');
    expect(msg).toContain('— Dad —');
    expect(msg).toContain('— Kid —');
    expect(msg).toContain('Time:    11:30 AM');
    expect(msg).toContain('Total:   $55');
  });

  it('prefixes the system-error warning on the fallback path', () => {
    const msg = buildBookingMessage({ ...single, systemError: true, errorCode: 'network' });
    expect(msg).toContain('⚠ BOOKING SYSTEM ERROR — manual confirm needed');
    expect(msg).toContain('(code: network)');
    expect(msg).toContain('please reply to confirm the slot');
  });

  it('labels continuation slots of multi-slot services', () => {
    const msg = buildBookingMessage({
      ...single,
      bookings: [
        { booking_id: 'vip11111', person_name: 'T', service_slug: 'vip-haircut',
          booking_time: '14:00:00', total_price_cents: 6000, addons: [] },
        { booking_id: null, person_name: 'T', service_slug: 'vip-haircut',
          booking_time: '14:30:00', total_price_cents: 0, addons: [] },
      ],
    });
    expect(msg).toContain('Ref:     continuation');
  });
});

describe('buildCancelMessage', () => {
  const args = {
    firstName: 'Test',
    phone: '(413) 555-0123',
    barberName: 'Hassan',
    serviceLabel: 'Hair Cut',
    dateLabel: 'Friday, July 10',
    timeLabel: '2:00 PM',
    ref: 'abcd1234-ef56-7890',
  };

  it('includes everything the barber needs to recognize the gap', () => {
    const msg = buildCancelMessage(args);
    expect(msg).toContain('FADE EMPIRE — CANCELLATION');
    expect(msg).toContain('Name:    Test');
    expect(msg).toContain('Phone:   (413) 555-0123');
    expect(msg).toContain('Barber:  Hassan');
    expect(msg).toContain('Was:     Hair Cut');
    expect(msg).toContain('Date:    Friday, July 10');
    expect(msg).toContain('Time:    2:00 PM');
    expect(msg).toContain('Ref:     abcd1234');
    expect(msg).toContain('The slot is open again.');
  });

  it('supports markdown for the WhatsApp variant', () => {
    const msg = buildCancelMessage({ ...args, useMarkdown: true });
    expect(msg).toContain('*FADE EMPIRE — CANCELLATION*');
  });

  it('fits in a URL without breaking (sms deep link)', () => {
    const url = messagingUrl('sms', buildCancelMessage(args));
    expect(url.startsWith(`sms:+${SHOP_PHONE}?&body=`)).toBe(true);
    expect(decodeURIComponent(url.split('body=')[1])).toContain('CANCELLATION');
  });
});
