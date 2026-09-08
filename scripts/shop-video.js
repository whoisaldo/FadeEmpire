// shop-video.js — the tour video and the gallery's motion plate.
//
// Both clips are marked `preload="none"` with their file in a data attribute,
// so nothing downloads until the plate scrolls near the viewport. They play
// muted and looped, pause when they scroll out again (battery, data), and
// never autoplay for people who asked the OS for reduced motion. The tour
// gets a sound toggle: off by default, one tap to hear it.

const NEAR = '200px 0px';

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function isPhone() {
  return window.matchMedia?.('(max-width: 768px)').matches ?? false;
}

function safePlay(video) {
  const p = video.play();
  if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked: the poster stays */ });
}

/** Attach the right file once, then play/pause with visibility.
 *  Returns { attach } so a user gesture can force the file to load. */
function bindLazyClip(video) {
  const src = video.dataset.src
    || (isPhone() ? video.dataset.srcMobile : video.dataset.srcDesktop)
    || video.dataset.srcDesktop;
  if (!src) return { attach() {} };

  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    video.src = src;
    video.load();
  };

  const play = () => {
    attach();
    if (prefersReducedMotion()) return;
    safePlay(video);
  };

  if (!('IntersectionObserver' in window)) {
    play();
    return { attach };
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) play();
      else if (attached) video.pause();
    });
  }, { rootMargin: NEAR, threshold: 0.2 });
  io.observe(video);
  return { attach };
}

function bindSoundToggle(figure, video, clip) {
  const button = figure.querySelector('[data-video-sound]');
  const text   = figure.querySelector('[data-video-sound-text]');
  if (!button) return;

  const render = () => {
    const on = !video.muted;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Turn sound off' : 'Turn sound on');
    if (text) text.textContent = on ? 'Sound on' : 'Sound off';
  };

  button.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted) {
      // Unmuting is a user gesture, so playback is allowed even where
      // autoplay with sound is not. Restart from the top so the voice-over
      // makes sense.
      clip.attach();
      video.currentTime = 0;
      safePlay(video);
    }
    render();
  });

  // If the user scrolls away with sound on, muting on pause keeps the page
  // quiet when it scrolls back into view.
  video.addEventListener('pause', () => {
    if (!video.muted) {
      video.muted = true;
      render();
    }
  });

  render();
}

export function initShopVideo() {
  const figure = document.querySelector('[data-shop-video]');
  if (figure) {
    const video = figure.querySelector('video');
    if (video) {
      video.muted = true;     // the attribute alone is not enough in every browser
      const clip = bindLazyClip(video);
      bindSoundToggle(figure, video, clip);
      // Tapping the video itself toggles play/pause (there are no native controls)
      video.addEventListener('click', () => {
        if (video.paused) { clip.attach(); safePlay(video); }
        else video.pause();
      });
    }
  }

  document.querySelectorAll('.plate__video').forEach((video) => {
    video.muted = true;
    bindLazyClip(video);
  });
}
