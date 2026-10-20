// booking-calendar.js — the "Add to calendar" file for a confirmed booking.
// Pure string building: an iCalendar (RFC 5545) event in UTC, from the shop's
// America/New_York wall-clock times, so any calendar app shows it right
// wherever the phone is.

import { SHOP_TZ, SLOT_MINUTES } from './config.js';
import { hmsToMinutes, minutesToLabel } from './booking-helpers.js';

const SITE     = 'https://chicopeefadeempire.com';
const LOCATION = '1193 Memorial Dr, Chicopee, MA 01020';
const PHONE    = '413·885·4440';

/** The shop's offset from UTC at an instant, in minutes (-240 EDT, -300 EST). */
function shopOffsetMin(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((wall - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/** The instant a shop wall-clock time ('YYYY-MM-DD', minutes from midnight) happens. */
export function shopTimeToUtc(iso, minutes) {
  const [y, m, d] = iso.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  const guess = wall - shopOffsetMin(new Date(wall)) * 60000;
  return new Date(wall - shopOffsetMin(new Date(guess)) * 60000);
}

/** 20260708T153000Z */
function icsTime(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** A TEXT value: backslash, semicolon and comma escaped, newlines as \n. */
function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/**
 * The .ics text for one booking (one person or a group).
 *   uid        the first booking id, so the same booking is the same event
 *   date       'YYYY-MM-DD'
 *   people     [{ name, service, detail, time }]: service is the plain label
 *              (for the title), detail the line the confirmation card shows
 *              (service and add-ons), time 'HH:MM:SS'
 *   lastStart  the last slot's 'HH:MM:SS'; the event ends one slot after it
 */
export function buildIcs({ uid, date, barberName, people, lastStart, now = new Date() }) {
  const start = shopTimeToUtc(date, hmsToMinutes(people[0].time));
  const end   = shopTimeToUtc(date, hmsToMinutes(lastStart || people[people.length - 1].time) + SLOT_MINUTES);
  const summary = people.length > 1
    ? `Fade Empire: ${people.length} appointments with ${barberName}`
    : `Fade Empire: ${people[0].service} with ${barberName}`;
  const description = [
    ...people.map(p => `${p.name} · ${p.detail} · ${minutesToLabel(hmsToMinutes(p.time))}`),
    PHONE,
    `To cancel: ${SITE}/#cancel`,
  ].join('\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fade Empire//chicopeefadeempire.com//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}@chicopeefadeempire.com`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(summary)}`,
    `LOCATION:${icsText(LOCATION)}`,
    `DESCRIPTION:${icsText(description)}`,
    `URL:${SITE}/#book`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}

/** The file as a link target: a data: URL works without a Blob to revoke. */
export function icsDataUrl(ics) {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}
