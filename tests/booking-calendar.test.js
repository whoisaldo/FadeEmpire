// The "Add to calendar" file (C2), read back with a small parser: the
// properties calendar apps need, UTC times from the shop's clock across
// daylight saving, and CRLF line endings.

import { describe, it, expect } from 'vitest';
import { buildIcs, icsDataUrl, shopTimeToUtc } from '../scripts/booking-calendar.js';
import { parseIcs, icsUnescape, icsDate } from './ics-parse.js';

const one = (over = {}) => buildIcs({
  uid: 'b1f0c2d4-0000-0000-0000-000000000001', date: '2026-07-08', barberName: 'Larry',
  people: [{ name: 'Dana Reyes', service: 'Hair Cut', detail: 'Hair Cut + Beard', time: '11:30:00' }],
  now: new Date('2026-07-06T14:00:00Z'),
  ...over,
});
const eventOf = (ics) => {
  const [cal] = parseIcs(ics);
  expect(cal.type).toBe('VCALENDAR');
  expect(cal.children).toHaveLength(1);
  return { cal, ev: cal.children[0] };
};

describe('the .ics file (C2)', () => {
  it('is a VCALENDAR with one VEVENT carrying every required property, CRLF throughout', () => {
    const ics = one();
    expect(ics.split('\r\n').length - 1).toBe(ics.split('\n').length - 1);   // no bare LF
    const { cal, ev } = eventOf(ics);
    expect(cal.props.VERSION).toBe('2.0');
    expect(cal.props.PRODID).toBeTruthy();
    expect(ev.type).toBe('VEVENT');
    for (const p of ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'URL']) {
      expect(ev.props[p], p).toBeTruthy();
    }
    expect(ev.props.SUMMARY).toBe('Fade Empire: Hair Cut with Larry');
    expect(icsUnescape(ev.props.LOCATION)).toBe('1193 Memorial Dr, Chicopee, MA 01020');
    expect(ev.props.URL).toBe('https://chicopeefadeempire.com/#book');
    expect(icsDate(ev.props.DTSTAMP).toISOString()).toBe('2026-07-06T14:00:00.000Z');
  });

  it('the description lists the person, service and time, the shop phone and how to cancel', () => {
    const { ev } = eventOf(one());
    expect(icsUnescape(ev.props.DESCRIPTION).split('\n')).toEqual([
      'Dana Reyes · Hair Cut + Beard · 11:30 AM',
      '413·885·4440',
      'To cancel: https://chicopeefadeempire.com/#cancel',
    ]);
  });

  it('a summer (EDT, UTC-4) slot is written in UTC and lasts 45 minutes', () => {
    const { ev } = eventOf(one());
    expect(ev.props.DTSTART).toBe('20260708T153000Z');
    expect(ev.props.DTEND).toBe('20260708T161500Z');
  });

  it('a winter (EST, UTC-5) slot is written in UTC', () => {
    const { ev } = eventOf(one({ date: '2026-12-02', people: [{ name: 'Dana', service: 'Line Up', detail: 'Line Up', time: '10:00:00' }] }));
    expect(ev.props.DTSTART).toBe('20261202T150000Z');
    expect(ev.props.DTEND).toBe('20261202T154500Z');
  });

  it('the days the clocks change use the offset in force at the shop\'s opening hours', () => {
    expect(shopTimeToUtc('2026-11-01', 10 * 60).toISOString()).toBe('2026-11-01T15:00:00.000Z');   // EST from 2 AM
    expect(shopTimeToUtc('2026-03-08', 10 * 60).toISOString()).toBe('2026-03-08T14:00:00.000Z');   // EDT from 2 AM
    expect(shopTimeToUtc('2026-10-31', 17 * 60 + 30).toISOString()).toBe('2026-10-31T21:30:00.000Z');
  });

  it('a group spans the first start to the last end, titled by its size, one line per person', () => {
    const { ev } = eventOf(one({
      people: [
        { name: 'Dana Reyes', service: 'Hair Cut', detail: 'Hair Cut', time: '10:00:00' },
        { name: 'Sam', service: 'Kids Cut', detail: 'Kids Cut', time: '10:45:00' },
        { name: 'Lee', service: 'Line Up', detail: 'Line Up', time: '11:30:00' },
      ],
    }));
    expect(ev.props.SUMMARY).toBe('Fade Empire: 3 appointments with Larry');
    expect(ev.props.DTSTART).toBe('20260708T140000Z');
    expect(ev.props.DTEND).toBe('20260708T161500Z');     // 11:30 + 45 = 12:15 EDT
    expect(icsUnescape(ev.props.DESCRIPTION).split('\n').slice(0, 3)).toEqual([
      'Dana Reyes · Hair Cut · 10:00 AM', 'Sam · Kids Cut · 10:45 AM', 'Lee · Line Up · 11:30 AM',
    ]);
  });

  it('the event ends one slot after the last slot it holds, continuation slots included', () => {
    const { ev } = eventOf(one({ lastStart: '12:15:00' }));
    expect(ev.props.DTEND).toBe('20260708T170000Z');
  });

  it('the UID is the booking id\'s, the same however often the file is made', () => {
    const a = eventOf(one()).ev.props.UID;
    const b = eventOf(one({ now: new Date('2026-07-07T09:00:00Z') })).ev.props.UID;
    expect(a).toBe('b1f0c2d4-0000-0000-0000-000000000001@chicopeefadeempire.com');
    expect(b).toBe(a);
  });

  it('commas, semicolons and backslashes in a name are escaped and read back as typed', () => {
    const { ev } = eventOf(one({ people: [{ name: 'Reyes, Dana; Jr\\', service: 'Hair Cut', detail: 'Hair Cut', time: '11:30:00' }] }));
    expect(ev.props.DESCRIPTION).toContain('Reyes\\, Dana\\; Jr\\\\');
    expect(icsUnescape(ev.props.DESCRIPTION)).toContain('Reyes, Dana; Jr\\ · Hair Cut');
  });

  it('the link target is a text/calendar data: URL that decodes to the same file', () => {
    const ics = one();
    const url = icsDataUrl(ics);
    expect(url.startsWith('data:text/calendar;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe(ics);
  });
});
