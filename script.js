// Fade Empire - Vanilla JS interactions

(() => {
  const qs = (sel, el = document) => el.querySelector(sel);
  const qsa = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const header = qs('#site-header');
  const navToggle = qs('#navToggle');
  const navList = qs('#primary-nav');
  const yearEl = qs('#year');
  const bookingForm = qs('#bookingForm');
  const hiddenIframe = qs('#hidden_iframe');
  const successEl = qs('#formSuccess');
  const bookBtn = qs('#bookBtn');
  const smsBtn = qs('#textBarberBtn');
  const smsDesktop = qs('#smsDesktop');
  const copyPhoneBtn = qs('#copyPhoneBtn');
  const copiedToast = qs('#copiedToast');
  const phoneInput = qs('#phone');
  const dateInput = qs('#date');
  const timeInput = qs('#time');
  const viewInGoogle = qs('#viewInGoogle');

  // Set current year
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // Header scroll behavior
  let lastY = window.scrollY;
  const onScroll = () => {
    const curY = window.scrollY;
    if (curY > 10) header.classList.add('is-scrolled'); else header.classList.remove('is-scrolled');
    const goingDown = curY > lastY && curY > 120;
    header.classList.toggle('header--hidden', goingDown);
    lastY = curY;
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // Mobile nav toggle
  navToggle?.addEventListener('click', () => {
    const isOpen = header.classList.toggle('nav--open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) navToggle.setAttribute('aria-label', 'Close menu'); else navToggle.setAttribute('aria-label', 'Open menu');
  });
  // Close nav on link click (mobile)
  qsa('.nav__link').forEach((a) => a.addEventListener('click', () => {
    header.classList.remove('nav--open');
    navToggle?.setAttribute('aria-expanded', 'false');
  }));
  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') header.classList.remove('nav--open');
  });

  // Smooth scroll for internal links
  qsa('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (!id || id === '#') return;
      const target = qs(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Intersection Observer for reveals
  const revealEls = qsa('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add('reveal-active');
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.2 });
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('reveal-active'));
  }

  // Gallery lightbox
  const lightbox = qs('#lightbox');
  const lightboxImg = qs('#lightboxImage');
  const lightboxClose = qs('#lightboxClose');
  qsa('.gallery__item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const img = qs('img', btn);
      if (!img) return;
      lightboxImg.src = img.src;
      lightbox?.removeAttribute('hidden');
    });
  });
  const closeLightbox = () => lightbox?.setAttribute('hidden', '');
  lightboxClose?.addEventListener('click', closeLightbox);
  lightbox?.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

  // Form helpers
  const setMinDate = () => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const today = `${yyyy}-${mm}-${dd}`;
    if (dateInput) dateInput.min = today;
  };
  setMinDate();

  // Time constraints
  if (timeInput) { timeInput.min = '09:00'; timeInput.max = '19:00'; }

  // Phone formatting: (555) 123-4567
  const formatPhone = (value) => {
    const digits = value.replace(/\D/g, '').slice(0, 10);
    const p1 = digits.slice(0, 3);
    const p2 = digits.slice(3, 6);
    const p3 = digits.slice(6, 10);
    if (digits.length > 6) return `(${p1}) ${p2}-${p3}`;
    if (digits.length > 3) return `(${p1}) ${p2}`;
    if (digits.length > 0) return `(${p1}`;
    return '';
  };
  phoneInput?.addEventListener('input', (e) => {
    const t = e.target;
    const start = t.selectionStart;
    const oldLen = t.value.length;
    t.value = formatPhone(t.value);
    const newLen = t.value.length;
    const delta = newLen - oldLen;
    t.setSelectionRange(start + delta, start + delta);
  });

  const setError = (id, msg) => {
    const el = qs(`#error-${id}`);
    if (el) el.textContent = msg;
  };
  const clearErrors = () => qsa('.field-error').forEach((e) => (e.textContent = ''));

  const validateForm = () => {
    clearErrors();
    let ok = true;
    const nameVal = qs('#fullName')?.value.trim();
    if (!nameVal) { setError('fullName', 'Please enter your name'); ok = false; }

    const phoneVal = (phoneInput?.value || '').replace(/\D/g, '');
    if (phoneVal.length !== 10) { setError('phone', 'Enter a valid 10-digit phone'); ok = false; }

    const emailInput = qs('#email');
    if (emailInput && emailInput.value) {
      const emailOk = /.+@.+\..+/.test(emailInput.value);
      if (!emailOk) { setError('email', 'Enter a valid email'); ok = false; }
    }

    const service = qs('#service');
    if (!service?.value) { setError('service', 'Select a service'); ok = false; }

    const d = qs('#date')?.value;
    if (!d) { setError('date', 'Choose a date'); ok = false; }

    const t = qs('#time')?.value;
    if (!t) { setError('time', 'Choose a time'); ok = false; }
    else {
      if (t < '09:00' || t > '19:00') { setError('time', 'Select a time between 9:00 and 19:00'); ok = false; }
    }

    return ok;
  };

  // Hidden iframe handler: show success after submission completes
  hiddenIframe?.addEventListener('load', () => {
    // Assume success on iframe load
    showSuccess();
  });

  const showSuccess = () => {
    if (!successEl) return;
    successEl.hidden = false;
    bookingForm?.reset();
    setMinDate();
    window.setTimeout(() => { successEl.hidden = true; }, 6000);
  };

  // Form submit handling
  bookingForm?.addEventListener('submit', (e) => {
    if (!validateForm()) { e.preventDefault(); return; }
    bookBtn?.setAttribute('disabled', 'true');
    bookBtn.textContent = 'Submitting…';

    const action = bookingForm.getAttribute('action') || '';
    const isPlaceholder = action.includes('YOUR_FORM_ID');

    if (isPlaceholder) {
      // Demo mode: simulate success
      e.preventDefault();
      window.setTimeout(() => {
        showSuccess();
        bookBtn?.removeAttribute('disabled');
        bookBtn.textContent = '📅 Book Appointment';
      }, 900);
    } else {
      // Allow native submit to hidden iframe, but guard with timeout
      window.setTimeout(() => {
        bookBtn?.removeAttribute('disabled');
        bookBtn.textContent = '📅 Book Appointment';
      }, 5000);
    }
  });

  // Link to Google Forms: leave as placeholder until user updates
  if (viewInGoogle) viewInGoogle.addEventListener('click', (ev) => {
    const href = viewInGoogle.getAttribute('href');
    if (href === '#') {
      ev.preventDefault();
      alert('Replace the booking form action with your Google Form URL, then update this link. See README.md.');
    }
  });

  // SMS integration
  const barberPhoneDigits = '15551234567';
  const isMobile = () => /Android|iPhone|iPad|iPod|Mobile|BlackBerry|IEMobile|Silk/.test(navigator.userAgent);
  smsBtn?.addEventListener('click', () => {
    const msg = encodeURIComponent("Hi! I'd like to book an appointment at Fade Empire.");
    if (isMobile()) {
      // Use ?&body to maximize compatibility across platforms
      window.location.href = `sms:${barberPhoneDigits}?&body=${msg}`;
    } else {
      smsDesktop?.removeAttribute('hidden');
      copiedToast?.setAttribute('hidden', '');
    }
  });

  copyPhoneBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('(555) 123-4567');
      copiedToast?.removeAttribute('hidden');
      window.setTimeout(() => copiedToast?.setAttribute('hidden', ''), 2000);
    } catch {
      // Fallback prompt
      window.prompt('Copy phone number:', '(555) 123-4567');
    }
  });
})();


