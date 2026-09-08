#!/usr/bin/env python3
"""Screenshot the site at phone / tablet / desktop sizes for a visual check.

    python3 -m http.server 8010                      # in the repo root, another terminal
    python3 tools/screenshot.py mobile out.png       # full page (lazy images forced to load)
    python3 tools/screenshot.py mobile out.png "#book"   # one element
    python3 tools/screenshot.py desktop out.png 1200     # viewport scrolled to y=1200
    python3 tools/screenshot.py mobile out.png --reduced # prefers-reduced-motion

Needs Playwright for Python:  pip3 install playwright && python3 -m playwright install chromium
Prints console errors and any element wider than the viewport (a horizontal-scroll
bug), which is the mistake phones punish most. Chromium caps a full-page capture
around 16k device pixels, so very long pages come out blank at the bottom;
capture those sections by selector instead.
"""

import json
import sys

from playwright.sync_api import sync_playwright

PROFILES = {
    'small':   dict(viewport={'width': 360, 'height': 740}, device_scale_factor=2, is_mobile=True, has_touch=True),
    'mobile':  dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True),
    'tablet':  dict(viewport={'width': 820, 'height': 1180}, device_scale_factor=2, is_mobile=True, has_touch=True),
    'laptop':  dict(viewport={'width': 1280, 'height': 800}, device_scale_factor=1),
    'desktop': dict(viewport={'width': 1440, 'height': 900}, device_scale_factor=1),
}

OVERFLOW_PROBE = """() => {
  const w = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed'
        && !el.closest('.plates, .booking__days, .hero__bg')) {  // scrollers and the hero zoom are fine
      bad.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ` [${Math.round(r.left)}..${Math.round(r.right)}]`);
    }
  });
  return { clientWidth: w, scrollWidth: document.documentElement.scrollWidth, offenders: bad.slice(0, 12) };
}"""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    mode, out = args[0], args[1]
    target = args[2] if len(args) > 2 else 'full'
    url = 'http://localhost:8010/index.html'

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(**PROFILES[mode],
                                  reduced_motion='reduce' if '--reduced' in sys.argv else 'no-preference')
        page = ctx.new_page()
        errors = []
        page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.goto(url, wait_until='networkidle')
        page.wait_for_timeout(800)
        if target == 'full':
            page.evaluate("document.querySelectorAll('img[loading=lazy]').forEach(i => { i.loading = 'eager'; })")
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(800)
        page.evaluate("document.querySelectorAll('.reveal').forEach(e => e.classList.add('is-visible'))")
        page.wait_for_timeout(300)
        overflow = page.evaluate(OVERFLOW_PROBE)
        if target == 'full':
            page.screenshot(path=out, full_page=True)
        elif target.isdigit():
            page.evaluate(f'window.scrollTo(0, {target})')
            page.wait_for_timeout(600)
            page.screenshot(path=out)
        else:
            el = page.query_selector(target)
            el.scroll_into_view_if_needed()
            page.wait_for_timeout(600)
            el.screenshot(path=out)
        print(json.dumps({'errors': errors[:10], 'overflow': overflow}, indent=1))
        browser.close()


if __name__ == '__main__':
    main()
