// nav.js — the mobile menu.
//
// Kept apart from cover.js, which reaches the database client: main.js loads
// this one statically, so the menu works even when that client fails to load.

/* While the menu is open it is the only thing a keyboard can reach: focus
   starts on the first link, Tab cycles through the links and the toggle,
   Escape closes, and the rest of the page is inert (aria-hidden where the
   browser has no inert). Closing hands focus back to the toggle. */

export function initMobileNav() {
  const nav    = document.querySelector('[data-nav]');
  const toggle = document.querySelector('[data-nav-toggle]');
  if (!nav || !toggle) return;

  const links = [...nav.querySelectorAll('.nav__link')];
  const cycle = [...links, toggle];
  const hasInert = 'inert' in HTMLElement.prototype;
  let walled = [];   // [element, its aria-hidden before the menu opened]

  const isOpen = () => nav.hasAttribute('data-nav-open');

  const wallOff = () => {
    walled = [...document.body.children]
      .filter((el) => el !== nav && !el.contains(nav) && el.tagName !== 'SCRIPT')
      .map((el) => [el, el.getAttribute('aria-hidden')]);
    walled.forEach(([el]) => {
      el.setAttribute('inert', '');
      if (!hasInert) el.setAttribute('aria-hidden', 'true');
    });
  };
  const unwall = () => {
    walled.forEach(([el, ariaHidden]) => {
      el.removeAttribute('inert');
      if (hasInert) return;
      if (ariaHidden == null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', ariaHidden);
    });
    walled = [];
  };

  const close = ({ restoreFocus = true } = {}) => {
    if (!isOpen()) return;
    nav.removeAttribute('data-nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    document.body.style.overflow = '';
    unwall();
    if (restoreFocus) toggle.focus();
  };
  const open = () => {
    nav.setAttribute('data-nav-open', '');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    document.body.style.overflow = 'hidden';
    wallOff();
    links[0]?.focus();
  };

  toggle.addEventListener('click', () => {
    isOpen() ? close() : open();
  });
  // A link jumps to its section, so focus goes with it, not back to the toggle.
  links.forEach((a) => a.addEventListener('click', () => close({ restoreFocus: false })));

  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const at = cycle.indexOf(document.activeElement);
    const step = e.shiftKey ? -1 : 1;
    const next = at < 0 ? (e.shiftKey ? cycle.length - 1 : 0) : (at + step + cycle.length) % cycle.length;
    cycle[next].focus();
  });

  // Widening past the phone layout turns the sheet back into the inline nav.
  window.matchMedia?.('(min-width: 900px)').addEventListener?.('change', (e) => {
    if (e.matches) close({ restoreFocus: false });
  });
}
