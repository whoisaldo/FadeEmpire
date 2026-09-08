// reveals.js — IntersectionObserver-driven scroll reveals.
//
// Elements with class="reveal" get .is-visible once they scroll into view.
// Section headlines are masked with clip-path while hidden, and Chromium
// reports a fully clipped element as never intersecting, so those are
// watched through their parent (.section__head) instead of themselves.

function anchorFor(el) {
  const masked = el.tagName === 'H2' && el.parentElement?.classList.contains('section__head');
  return masked ? el.parentElement : el;
}

export function initReveals() {
  const targets = [...document.querySelectorAll('.reveal')];
  if (!targets.length || !('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const byAnchor = new Map();
  for (const el of targets) {
    const anchor = anchorFor(el);
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
    byAnchor.get(anchor).push(el);
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      byAnchor.get(entry.target)?.forEach((el) => el.classList.add('is-visible'));
      io.unobserve(entry.target);
    });
  }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });

  byAnchor.forEach((_, anchor) => io.observe(anchor));
}
