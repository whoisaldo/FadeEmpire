// shop-video.js — the tour video and the gallery's motion plate.
//
// Both clips are marked `preload="none"` with their file in a data attribute,
// so nothing downloads until the plate scrolls near the viewport. They play
// muted and looped, pause when they scroll out again (battery, data), and
// never autoplay for people who asked the OS for reduced motion. Each clip
// has a pause button; a clip the visitor paused stays paused when it scrolls
// back into view. The tour also gets a sound toggle (off by default) and
// shows its captions whenever the sound is on.

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
 *  Returns { attach, userPaused }: a user gesture can force the file to
 *  load, and while userPaused is set, scrolling back does not restart it. */
function bindLazyClip(video) {
  const src = video.dataset.src
    || (isPhone() ? video.dataset.srcMobile : video.dataset.srcDesktop)
    || video.dataset.srcDesktop;
  const clip = { attach() {}, userPaused: false };
  if (!src) return clip;

  let attached = false;
  clip.attach = () => {
    if (attached) return;
    attached = true;
    video.src = src;
    video.load();
  };

  const play = () => {
    clip.attach();
    if (prefersReducedMotion() || clip.userPaused) return;
    safePlay(video);
  };

  if (!('IntersectionObserver' in window)) {
    play();
    return clip;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) play();
      else if (attached) video.pause();
    });
  }, { rootMargin: NEAR, threshold: 0.2 });
  io.observe(video);
  return clip;
}

/** Play or pause on a visitor's request, and remember a pause. */
function togglePlayback(video, clip) {
  if (video.paused) {
    clip.userPaused = false;
    clip.attach();
    safePlay(video);
  } else {
    clip.userPaused = true;
    video.pause();
  }
}

/** The pause button reads as pressed whenever the clip is not playing. */
function bindPauseToggle(button, video, clip) {
  if (!button) return;
  const render = () => button.setAttribute('aria-pressed', video.paused ? 'true' : 'false');
  button.addEventListener('click', () => togglePlayback(video, clip));
  video.addEventListener('play', render);
  video.addEventListener('pause', render);
  render();
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
    // Captions follow the sound: shown while the voice-over plays.
    const captions = video.textTracks?.[0];
    if (captions) captions.mode = on ? 'showing' : 'hidden';
  };

  button.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted) {
      // Unmuting is a user gesture, so playback is allowed even where
      // autoplay with sound is not. Restart from the top so the voice-over
      // makes sense.
      clip.userPaused = false;
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
      bindPauseToggle(figure.querySelector('[data-video-pause]'), video, clip);
      // Tapping the video itself toggles play/pause (there are no native controls)
      video.addEventListener('click', () => togglePlayback(video, clip));
    }
  }

  document.querySelectorAll('.plate__video').forEach((video) => {
    video.muted = true;
    const clip = bindLazyClip(video);
    bindPauseToggle(video.parentElement.querySelector('[data-video-pause]'), video, clip);
    video.addEventListener('click', () => togglePlayback(video, clip));
  });
}
