// visit.js — the hours card: highlights today's row and keeps the live
// status line ("Open now · Closes 6 PM") current. The rows themselves are
// static HTML so they render without JS; tests/site-content.test.js checks
// they agree with STORE_HOURS.

import { shopStatus, shopWeekday } from './booking-helpers.js';
import { CLOSING_SOON_MIN } from './config.js';

function markToday(list, weekday) {
  list.querySelectorAll('[data-weekday]').forEach((row) => {
    row.classList.toggle('is-today', Number(row.dataset.weekday) === weekday);
  });
}

function renderStatus(root, status) {
  root.dataset.state = status.state;
  const label  = root.querySelector('[data-hours-status]');
  const detail = root.querySelector('[data-hours-detail]');
  if (label)  label.textContent  = status.label;
  if (detail) detail.textContent = status.detail;
}

export function initVisit() {
  const list = document.querySelector('[data-hours-list]');
  const statusRoot = document.querySelector('[data-visit-status]');
  if (!list && !statusRoot) return;

  const tick = () => {
    const weekday = shopWeekday();
    if (list) markToday(list, weekday);
    if (statusRoot) renderStatus(statusRoot, shopStatus({ weekday, closingSoonMin: CLOSING_SOON_MIN }));
  };

  tick();
  setInterval(tick, 60_000);
}
