// gallery.js — the work: the phone filmstrip counter and the lightbox.
//
// Plates are <figure data-plate="stem"> elements. Tapping one opens the
// single <dialog data-lightbox> with the 1200 px file for that stem, and
// arrow keys / swipes / the two buttons move through the photos. The video
// plate has no stem and is skipped by the lightbox.

const IMG_DIR = './assets/img';

function plateImages(root) {
  return [...root.querySelectorAll('[data-plate]')].map((figure) => ({
    stem:    figure.dataset.plate,
    caption: figure.querySelector('.plate__cap')?.textContent.trim() || '',
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
  let returnTo = null;

  const show = (i) => {
    index = (i + items.length) % items.length;
    const item = items[index];
    img.src = `${IMG_DIR}/${item.stem}-1200.jpg`;
    img.srcset = `${IMG_DIR}/${item.stem}-800.jpg 800w, ${IMG_DIR}/${item.stem}-1200.jpg 1200w`;
    img.sizes = '92vw';
    img.alt = item.alt;
    cap.textContent = item.caption;
    count.textContent = `${String(index + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`;
  };

  const open = (stem, opener) => {
    const i = items.findIndex((it) => it.stem === stem);
    if (i < 0) return;
    returnTo = opener || null;
    show(i);
    dialog.showModal();
    document.body.style.overflow = 'hidden';
  };

  const close = () => {
    if (dialog.open) dialog.close();
  };

  dialog.addEventListener('close', () => {
    document.body.style.overflow = '';
    img.removeAttribute('src');
    img.removeAttribute('srcset');
    returnTo?.focus?.({ preventScroll: true });
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

  return { open, close, show, get index() { return index; }, size: items.length };
}

/* ---------- Filmstrip counter (phone) ---------- */

function initFilmstrip(root) {
  const counter = document.querySelector('[data-filmstrip-count]');
  if (!counter) return;
  const indexEl = counter.querySelector('[data-filmstrip-index]');
  const totalEl = counter.querySelector('[data-filmstrip-total]');
  const bar     = counter.querySelector('[data-filmstrip-bar]');
  const plates  = [...root.querySelectorAll('.plate')];
  if (!plates.length) return;

  totalEl.textContent = String(plates.length).padStart(2, '0');
  if (bar) bar.style.width = `${100 / plates.length}%`;

  let raf = 0;
  const update = () => {
    raf = 0;
    const mid = root.scrollLeft + root.clientWidth / 2;
    let current = 0;
    plates.forEach((plate, i) => {
      if (plate.offsetLeft <= mid) current = i;
    });
    indexEl.textContent = String(current + 1).padStart(2, '0');
    if (bar) bar.style.transform = `translateX(${current * 100}%)`;
  };

  root.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(update);
  }, { passive: true });
  update();
}

/* ---------- Boot ---------- */

export function initGallery() {
  const root = document.querySelector('[data-gallery]');
  if (!root) return null;
  initFilmstrip(root);
  return initLightbox(root);
}
