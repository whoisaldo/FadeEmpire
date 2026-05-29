// visit.js — clock-dial:
//   * draws the open-arc for today's schedule (10am–6pm daily)
//   * positions the "now" hand at the current shop-local time

import { SCHEDULE } from './config.js';
import { shopWeekday, nowMinutesInShopTz } from './booking-helpers.js';

const CX = 100, CY = 100, R = 78;

function angleForMinutes(m) {
  // 12-hour face: 0 mins = top (12 o'clock = 270° in SVG math? we use clockwise from 12.)
  // For a 24-hour day mapped onto a 12-hour clock, take m modulo 720 (12 hours).
  // We assume the shop hours all fall within 10 AM – 6 PM, so a 12-hour face works.
  const hourFraction = (m % 720) / 720; // 0..1
  return -90 + hourFraction * 360; // SVG: 0deg = 3 o'clock, we want 0 = 12 o'clock
}

function polar(angleDeg, r = R) {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

function drawArc(openM, closeM) {
  const arc = document.querySelector('[data-dial-arc]');
  if (!arc) return;
  const a1 = angleForMinutes(openM);
  const a2 = angleForMinutes(closeM);
  const [x1, y1] = polar(a1);
  const [x2, y2] = polar(a2);
  const sweep = (closeM - openM) > 360 ? 1 : 0;
  const large = (closeM - openM) > 360 ? 1 : 0;
  arc.setAttribute('d', `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`);
}

function positionHand(nowM) {
  const hand = document.querySelector('[data-dial-hand]');
  if (!hand) return;
  const ang = angleForMinutes(nowM) + 90; // -90 already baked into angleForMinutes; +90 to rotate
  hand.style.transform = `rotate(${ang}deg)`;
}

function updateStatusText(wk, sched, nowM) {
  const el = document.querySelector('[data-hours-status]');
  if (!el) return;
  if (!sched) {
    el.textContent = 'Closed today';
    return;
  }
  if (nowM < sched.open)         el.textContent = 'Opens later today';
  else if (nowM >= sched.close)  el.textContent = 'Closed for today';
  else if (sched.close - nowM <= 60) el.textContent = 'Closing soon';
  else                           el.textContent = 'Open now';
}

export function initVisit() {
  if (!document.querySelector('[data-dial-arc]')) return;
  const wk    = shopWeekday();
  const sched = SCHEDULE[wk];
  const nowM  = nowMinutesInShopTz();
  if (sched) {
    drawArc(sched.open, sched.close);
  } else {
    // Find the next open day's hours; draw faintly
    for (let i = 1; i <= 7; i++) {
      const s = SCHEDULE[(wk + i) % 7];
      if (s) { drawArc(s.open, s.close); break; }
    }
  }
  positionHand(nowM);
  updateStatusText(wk, sched, nowM);
  setInterval(() => {
    const m = nowMinutesInShopTz();
    positionHand(m);
    updateStatusText(shopWeekday(), SCHEDULE[shopWeekday()], m);
  }, 60_000);
}
