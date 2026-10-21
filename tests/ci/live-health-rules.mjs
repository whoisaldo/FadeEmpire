// live-health-rules.mjs — the decisions live-health.mjs makes about what
// production answers, apart from the network so tests/live-health.test.js can
// check them.

/** The barbers columns in ROSTER_SELECT that migration 0022 adds. */
export const COLUMNS_FROM_0022 = ['title'];

/**
 * The 0022 column the barbers read failed on, when production does not have
 * 0022 yet; null for any other answer. PostgREST passes Postgres's
 * undefined_column error through as HTTP 400:
 * {"code":"42703","message":"column barbers.title does not exist"}.
 */
export function missing0022Column({ status, body }) {
  if (status !== 400 || body?.code !== '42703') return null;
  const m = /^column barbers\.([a-z_]+) does not exist$/.exec(body.message ?? '');
  return m && COLUMNS_FROM_0022.includes(m[1]) ? m[1] : null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const hours = (day) => (day ? `${hhmm(day.open)}-${hhmm(day.close)}` : 'off');
const hmsToMin = (hms) => { const [h, m] = hms.split(':').map(Number); return h * 60 + m; };

/**
 * config.js's fallback barbers against the database's active ones (the
 * barbers read's rows). The app changes names and hours without a deploy, so
 * every difference is a note, not a failure: `agreed` are the fallback barbers
 * whose name and week match.
 */
export function compareFallback(barbers, rows) {
  const db = Object.fromEntries(rows.map(b => [b.slug, b]));
  const notes = [];
  const agreed = [];
  for (const [slug, cfg] of Object.entries(barbers)) {
    const row = db[slug];
    if (!row) { notes.push(`config.js fallback barber ${slug} is not active in the database`); continue; }
    let same = true;
    if (row.display_name !== cfg.name) {
      notes.push(`config.js names ${slug} "${cfg.name}", the database "${row.display_name}"`);
      same = false;
    }
    const week = Object.fromEntries(row.barber_schedules.map(r => [r.weekday, { open: hmsToMin(r.open_time), close: hmsToMin(r.close_time) }]));
    const days = [0, 1, 2, 3, 4, 5, 6]
      .filter(wk => hours(cfg.schedule[wk]) !== hours(week[wk]))
      .map(wk => `${DAYS[wk]} ${hours(week[wk])} (config.js ${hours(cfg.schedule[wk])})`);
    if (days.length) {
      notes.push(`${cfg.name}'s hours in the database differ from config.js's fallback on ${days.join(', ')}: `
        + 'the site uses the database\'s; refresh config.js in a later deploy');
      same = false;
    }
    if (same) agreed.push(slug);
  }
  return { notes, agreed };
}
