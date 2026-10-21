// roster.js — the barbers the site offers.
//
// It starts as config.js's BARBERS, so the first paint and the offline PWA
// have the two chairs the page was built with. booking-grid.js replaces it
// with the database's active barbers once the read lands (rosterFromRows), so
// a barber the manager adds in the app shows up without a deploy and a
// deactivated one is gone. Nothing here reaches the database: page.js and
// the helpers import it statically.

import { BARBERS } from './config.js';

/** The columns the site reads, with each barber's week and upcoming days off.
 *  tests/ci/live-health.mjs runs the same select against production. */
export const ROSTER_SELECT =
  'slug,display_name,title,bio,photo_url,sort_order,'
  + 'barber_schedules(weekday,open_time,close_time),barber_closures(closure_date)';

const fromConfig = () => Object.values(BARBERS).map(b => ({ ...b, closures: new Set() }));

let list = fromConfig();
let fromDatabase = false;

/** Every barber on offer, in the shop's order. */
export function barberList() { return list; }

/** One barber by slug, or null when the shop has no such active barber. */
export function getBarber(slug) { return list.find(b => b.slug === slug) || null; }

/** Whether the list came from the database (false: config.js's fallback). */
export function rosterIsLive() { return fromDatabase; }

export function setRoster(next) {
  list = next;
  fromDatabase = true;
}

/** Back to config.js's barbers (tests). */
export function resetRoster() {
  list = fromConfig();
  fromDatabase = false;
}

const toMin = (hms) => { const [h, m] = hms.split(':').map(Number); return h * 60 + m; };

/** `barbers` rows (ROSTER_SELECT, active only, in sort_order) to the roster.
 *  A barber with no weekly hours yet has nothing to book, so is left out. */
export function rosterFromRows(rows) {
  return rows.map(r => {
    const schedule = {};
    for (const s of r.barber_schedules || []) {
      schedule[s.weekday] = { open: toMin(s.open_time), close: toMin(s.close_time) };
    }
    return {
      slug:     r.slug,
      name:     r.display_name,
      title:    r.title || '',
      bio:      r.bio || '',
      photoUrl: r.photo_url || '',
      schedule,
      closures: new Set((r.barber_closures || []).map(c => c.closure_date)),
    };
  }).filter(b => Object.keys(b.schedule).length > 0);
}
