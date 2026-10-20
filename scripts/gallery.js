// gallery.js — the work: the lightbox.
//
// Plates are <figure data-plate="stem" data-caption="name"> elements. Tapping
// one opens the single <dialog data-lightbox> with the 1200 px file for that
// stem and its name under it, and arrow keys / swipes / the two buttons move
// through the photos. The video plate has no stem and is skipped by the lightbox. Opening adds a history
// entry that names the photo, so the browser's Back closes it instead of
// leaving the page and Forward opens it again; closing any other way removes
// that entry again.

const IMG_DIR = './assets/img';

function plateImages(root) {
  return [...root.querySelectorAll('[data-plate]')].map((figure) => ({
    stem:    figure.dataset.plate,
    caption: figure.dataset.caption || '',
    alt:     figure.querySelector('img')?.getAttribute('alt') || '',
  }));
}

/* ---------- Lightbox ---------- */

function initLightbox(root) {
  const dialog = document.querySelector('[data-lightbox]');
  if (!dialog) return null;

  // Old browsers without <dialog>: a tap opens the big file in a new tab.
  if (typeof dialog.showModal !== 'function') {
    root.querySelectorAll('[data-lightbox-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stem = btn.closest('[data-plate]')?.dataset.plate;
        if (stem) window.open(`${IMG_DIR}/${stem}-1200.jpg`, '_blank', 'noopener');
      });
    });
    return null;
  }

  const img   = dialog.querySelector('[data-lightbox-img]');
  const cap   = dialog.querySelector('[data-lightbox-cap]');
  const count = dialog.querySelector('[data-lightbox-count]');
  const items = plateImages(root);
  let index = 0;
  let returnTo = null;     // the plate that gets focus on close
  let openedBy = null;     // the plate the visitor tapped to open the viewer
  const onOurEntry = () => Boolean(history.state?.lightbox);

  const show = (i) => {
    index = (i + items.length) % items.length;
    const item = items[index];
    img.src = `${IMG_DIR}/${item.stem}-1200.jpg`;
    img.srcset = `${IMG_DIR}/${item.stem}-800.jpg 800w, ${IMG_DIR}/${item.stem}-1200.jpg 1200w`;
    img.sizes = '92vw';
    img.alt = item.alt;
    cap.textContent = item.caption;
    count.textContent = `${String(index + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`;
    // Our entry follows the photo on screen, so Forward brings back the last one seen.
    if (dialog.open && onOurEntry()) history.replaceState({ lightbox: item.stem }, '');
  };

  const plateButton = (stem) => [...root.querySelectorAll('[data-plate]')]
    .find((figure) => figure.dataset.plate === stem)?.querySelector('[data-lightbox-open]');

  // fromHistory: the entry already exists (Forward, or a reload on it).
  const open = (stem, opener, { fromHistory = false } = {}) => {
    const i = items.findIndex((it) => it.stem === stem);
    if (i < 0) return;
    if (opener) openedBy = opener;
    returnTo = opener || plateButton(stem);
    show(i);
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';
    if (!fromHistory) history.pushState({ lightbox: stem }, '');
  };

  const close = () => {
    if (dialog.open) dialog.close();
  };

  // Back off our entry closes the photo; Forward onto it opens that photo again.
  window.addEventListener('popstate', (e) => {
    const stem = e.state?.lightbox;
    if (stem) open(stem, null, { fromHistory: true });
    else close();
  });

  dialog.addEventListener('close', () => {
    document.body.style.overflow = '';
    img.removeAttribute('src');
    img.removeAttribute('srcset');
    // A plate other than the one tapped (the photo came back through Forward
    // or a reload) may be far down the page or along the filmstrip: bring it
    // into view first, so its focus ring is on screen.
    const target = returnTo;
    const moved = Boolean(target) && target !== openedBy;
    const refocus = () => {
      if (moved) {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      }
      target?.focus?.({ preventScroll: true });
    };
    // Closed with the button, Escape or the backdrop: our entry is still on
    // top, so drop it and the next Back leaves the page as usual. (Closed by
    // Back, the browser has already left the entry.) Landing on the page's
    // entry restores its old scroll position just after popstate, so a plate
    // that needs scrolling waits one task past it.
    if (onOurEntry()) {
      if (moved) window.addEventListener('popstate', () => setTimeout(refocus), { once: true });
      else refocus();
      history.back();
    } else {
      refocus();
    }
  });

  dialog.querySelector('[data-lightbox-close]')?.addEventListener('click', close);
  dialog.querySelector('[data-lightbox-prev]')?.addEventListener('click', () => show(index - 1));
  dialog.querySelector('[data-lightbox-next]')?.addEventListener('click', () => show(index + 1));

  // Tap on the dark backdrop closes; taps on the figure and buttons don't.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });

  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); show(index - 1); }
  });

  // Swipe left/right on phones
  let touchX = null;
  dialog.addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
  dialog.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) < 40) return;
    show(dx < 0 ? index + 1 : index - 1);
  }, { passive: true });

  root.querySelectorAll('[data-lightbox-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stem = btn.closest('[data-plate]')?.dataset.plate;
      if (stem) open(stem, btn);
    });
  });

  // A reload on our entry shows its photo, so that entry never sits there empty.
  if (onOurEntry()) open(history.state.lightbox, null, { fromHistory: true });

  return { open, close, show, get index() { return index; }, size: items.length };
}

/* ---------- Boot ---------- */

export function initGallery() {
  const root = document.querySelector('[data-gallery]');
  if (!root) return null;
  return initLightbox(root);
}
