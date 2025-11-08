const select = (selector, scope = document) => scope.querySelector(selector);
const selectAll = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

const state = {
  scrollOffset: 0
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const smoothScrollTo = (target) => {
  const nav = select('#nav');
  if (!target) return;
  const offset = nav ? nav.offsetHeight - 8 : 0;
  const top = target.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: 'smooth' });
};

const initPreloader = () => {
  const preloader = select('#preloader');
  if (!preloader) return;

  window.addEventListener('load', () => {
    preloader.style.opacity = '0';
    preloader.style.pointerEvents = 'none';
    setTimeout(() => {
      preloader.remove();
    }, 600);
  });
};

const initNav = () => {
  const nav = select('#nav');
  const navToggle = select('#navToggle');
  const navMenu = select('#navMenu');
  const links = selectAll('[data-nav]');

  if (!nav) return;

  const closeMenu = () => {
    navMenu?.classList.remove('is-open');
    navToggle?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nav-open');
  };

  const openMenu = () => {
    navMenu?.classList.add('is-open');
    navToggle?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('nav-open');
  };

  navToggle?.addEventListener('click', () => {
    const expanded = navToggle.getAttribute('aria-expanded') === 'true';
    expanded ? closeMenu() : openMenu();
  });

  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      const hash = link.getAttribute('href');
      if (!hash?.startsWith('#')) return;
      event.preventDefault();
      const target = document.querySelector(hash);
      closeMenu();
      smoothScrollTo(target);
    });
  });

  window.addEventListener(
    'scroll',
    () => {
      const current = window.scrollY;
      nav.classList.toggle('nav--solid', current > 40);
      nav.classList.toggle('nav--condensed', current > 120);
      state.scrollOffset = current;
    },
    { passive: true }
  );

  document.addEventListener('click', (event) => {
    if (!nav.contains(event.target) && navMenu?.classList.contains('is-open')) {
      closeMenu();
    }
  });
};

const initScrollAnimations = () => {
  const animatedElements = selectAll('[data-animate]');

  if (!animatedElements.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const delay = Number(entry.target.dataset.delay ?? '0');
          entry.target.classList.add('is-visible');
          entry.target.style.transitionDelay = `${delay}s`;
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.2,
      rootMargin: '0px 0px -10% 0px'
    }
  );

  animatedElements.forEach((element) => observer.observe(element));
};

const initHeroParticles = () => {
  const canvas = select('#heroParticles');
  if (!canvas) return;

  const context = canvas.getContext('2d');
  let particles = [];
  let animationFrame;

  const createParticles = () => {
    const { innerWidth: width, innerHeight: height } = window;
    canvas.width = width;
    canvas.height = height;
    particles = Array.from({ length: width < 768 ? 24 : 40 }).map(() => ({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: Math.random() * 1.4 + 0.4,
      speedY: Math.random() * 0.6 + 0.2,
      speedX: (Math.random() - 0.5) * 0.4,
      opacity: Math.random() * 0.4 + 0.2
    }));
  };

  const tick = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((particle) => {
      context.beginPath();
      context.fillStyle = `rgba(212, 175, 55, ${particle.opacity})`;
      context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      context.fill();
      particle.y -= particle.speedY;
      particle.x += particle.speedX;
      if (particle.y < -10) {
        particle.y = canvas.height + 10;
        particle.x = Math.random() * canvas.width;
      }
    });
    animationFrame = requestAnimationFrame(tick);
  };

  createParticles();
  tick();
  window.addEventListener('resize', createParticles);

  window.addEventListener('unload', () => cancelAnimationFrame(animationFrame));
};

const initGallery = () => {
  const filters = selectAll('.gallery__filter');
  const items = selectAll('.gallery__item');
  const lightbox = select('#lightbox');
  const lightboxImage = select('#lightboxImage');
  const lightboxVideo = select('#lightboxVideo');
  const lightboxClose = select('#lightboxClose');
  let lastFocus = null;

  const filterItems = (category) => {
    items.forEach((item) => {
      const itemCategory = item.dataset.category;
      const isVisible = category === 'all' || itemCategory === category;
      item.style.pointerEvents = isVisible ? 'auto' : 'none';
      item.style.opacity = isVisible ? '1' : '0';
      item.style.transform = isVisible ? 'translateY(0)' : 'translateY(40px)';
      item.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    });
  };

  filters.forEach((button) => {
    button.addEventListener('click', () => {
      filters.forEach((entry) => {
        entry.classList.remove('is-active');
        entry.setAttribute('aria-selected', 'false');
      });
      button.classList.add('is-active');
      button.setAttribute('aria-selected', 'true');
      filterItems(button.dataset.filter ?? 'all');
    });
  });

  const openLightbox = (src, type = 'image') => {
    if (!lightbox) return;
    lightbox.classList.add('is-open');
    lightbox.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';

    if (type === 'video' && lightboxVideo) {
      lightboxVideo.src = src;
      lightboxVideo.style.display = 'block';
      lightboxVideo.play().catch(() => {});
      lightboxImage?.removeAttribute('src');
      if (lightboxImage) lightboxImage.style.display = 'none';
    } else if (lightboxImage) {
      lightboxImage.src = src;
      lightboxImage.style.display = 'block';
      if (lightboxVideo) {
        lightboxVideo.pause();
        lightboxVideo.removeAttribute('src');
        lightboxVideo.style.display = 'none';
      }
    }
    lightboxClose?.focus();
  };

  const closeLightbox = () => {
    if (!lightbox) return;
    lightbox.classList.remove('is-open');
    lightbox.setAttribute('hidden', '');
    document.body.style.overflow = '';
    if (lightboxVideo) {
      lightboxVideo.pause();
      lightboxVideo.removeAttribute('src');
      lightboxVideo.style.display = 'none';
    }
    if (lightboxImage) {
      lightboxImage.removeAttribute('src');
      lightboxImage.style.display = 'none';
    }
    lastFocus?.focus();
  };

  items.forEach((item) => {
    item.addEventListener('click', () => {
      const img = item.querySelector('img');
      const src = img?.getAttribute('src');
      if (!src) return;
      lastFocus = item;
      openLightbox(src, item.dataset.type);
    });
    item.addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        item.click();
      }
    });
    item.setAttribute('tabindex', '0');
  });

  lightboxClose?.addEventListener('click', closeLightbox);
  lightbox?.addEventListener('click', (event) => {
    if (event.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && lightbox?.classList.contains('is-open')) closeLightbox();
  });
};

const initWhatsappBookingForm = () => {
  const form = select('#whatsappBookingForm');
  if (!form) return;

  const nameInput = select('#bookingName', form);
  const phoneInput = select('#bookingPhone', form);
  const serviceSelect = select('#bookingService', form);
  const customGroup = select('#customServiceGroup', form);
  const customTextarea = select('#bookingCustomService', form);
  const dateInput = select('#bookingDate', form);
  const timeSelect = select('#bookingTime', form);
  const notesTextarea = select('#bookingNotes', form);
  const smsButton = select('#smsPrimary');

  const formatPhone = (value) => {
    const digits = value.replace(/\D/g, '').slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  };

  const populateTimes = () => {
    if (!timeSelect) return;
    const fragment = document.createDocumentFragment();
    for (let hour = 10; hour <= 16; hour += 1) {
      for (let minute = 0; minute <= 30; minute += 30) {
        if (hour === 16 && minute > 30) continue;
        const suffix = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour > 12 ? hour - 12 : hour;
        const displayMinutes = minute === 0 ? '00' : '30';
        const label = `${displayHour}:${displayMinutes} ${suffix}`;
        const option = document.createElement('option');
        option.value = label;
        option.textContent = label;
        fragment.appendChild(option);
      }
    }
    timeSelect.appendChild(fragment);
  };

  const setMinDate = () => {
    if (!dateInput) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const offset = today.getTimezoneOffset();
    const localISO = new Date(today.getTime() - offset * 60000).toISOString().split('T')[0];
    dateInput.min = localISO;
  };

  const toggleCustomService = (show) => {
    if (!customGroup || !customTextarea) return;
    customGroup.hidden = !show;
    customTextarea.required = show;
    if (!show) customTextarea.value = '';
  };

  const buildMessage = () => {
    const formattedDate = dateInput?.value
      ? new Date(dateInput.value).toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric'
        })
      : '';

    const serviceValue = serviceSelect?.value || '';
    const serviceText =
      serviceValue === 'Custom Request'
        ? `Custom Request: ${customTextarea?.value || ''}`
        : serviceValue;

    let message = '🔥 *FADE EMPIRE BOOKING REQUEST* 🔥\n\n';
    message += `👤 *Name:* ${nameInput?.value.trim()}\n`;
    if (phoneInput?.value.trim()) message += `📱 *Phone:* ${phoneInput.value.trim()}\n`;
    message += `✂️ *Service:* ${serviceText}\n`;
    message += `📅 *Date:* ${formattedDate}\n`;
    message += `⏰ *Time:* ${timeSelect?.value}\n`;
    if (notesTextarea?.value.trim()) message += `📝 *Notes:* ${notesTextarea.value.trim()}\n`;
    message += '\n_Sent from FadeEmpire.com_';
    return message;
  };

  serviceSelect?.addEventListener('change', (event) => {
    toggleCustomService(event.target.value === 'Custom Request');
  });

  phoneInput?.addEventListener('input', (event) => {
    event.target.value = formatPhone(event.target.value);
  });

  form.addEventListener('submit', (event) => {
      event.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const message = buildMessage();
    const whatsappURL = `https://wa.me/14138854440?text=${encodeURIComponent(message)}`;
    window.open(whatsappURL, '_blank', 'noopener');
  });

  smsButton?.addEventListener('click', (event) => {
    event.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const message = buildMessage().replace(/\*/g, '').replace(/_/g, '');
    window.location.href = `sms:4138854440?&body=${encodeURIComponent(message)}`;
  });

  populateTimes();
  setMinDate();
  toggleCustomService(serviceSelect?.value === 'Custom Request');
};

const initBackToTop = () => {
  const button = select('#backToTop');
  if (!button) return;

  window.addEventListener(
    'scroll',
    () => {
      const scrolled = window.scrollY;
      if (scrolled > 520) {
        button.classList.add('is-visible');
      } else {
        button.classList.remove('is-visible');
      }
    },
    { passive: true }
  );

  button.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
};

const initCookieBanner = () => {
  const banner = select('#cookieBanner');
  if (!banner) return;
  const accept = select('#cookieAccept');
  const decline = select('#cookieDecline');

  const storageKey = 'fadeEmpireCookies';
  const stored = localStorage.getItem(storageKey);

  if (!stored) {
    setTimeout(() => banner.classList.add('is-visible'), 1200);
  }

  const handleChoice = (choice) => {
    localStorage.setItem(storageKey, choice);
    banner.classList.remove('is-visible');
  };

  accept?.addEventListener('click', () => handleChoice('accepted'));
  decline?.addEventListener('click', () => handleChoice('declined'));
};

const initCursor = () => {
  const cursor = select('#cursor');
  if (!cursor) return;
  const updatePosition = (event) => {
    cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
  };
  const activate = () => cursor.classList.add('is-active');
  const deactivate = () => cursor.classList.remove('is-active');

  document.addEventListener('pointermove', updatePosition);
  selectAll('a, button, .gallery__item').forEach((element) => {
    element.addEventListener('mouseenter', activate);
    element.addEventListener('mouseleave', deactivate);
  });
};

const initLazyImages = () => {
  const images = selectAll('img[loading="lazy"]');
  if ('loading' in HTMLImageElement.prototype) {
    images.forEach((img) => {
      if (img.dataset.src) img.src = img.dataset.src;
    });
    return;
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
          const img = entry.target;
      if (img.dataset.src) {
        img.src = img.dataset.src;
      }
      obs.unobserve(img);
    });
  });

  images.forEach((img) => observer.observe(img));
};

const initYear = () => {
  const yearEl = select('#year');
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }
};

const initSmoothAnchors = () => {
  selectAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (event) => {
      const hash = anchor.getAttribute('href');
      if (!hash || hash === '#') return;
      const target = document.querySelector(hash);
      if (!target) return;
      event.preventDefault();
      smoothScrollTo(target);
    });
  });
};

const initHeroParallax = () => {
  const hero = select('#hero');
  const background = select('.hero__kenburns');
  if (!hero || !background) return;

  hero.addEventListener('mousemove', (event) => {
    const rect = hero.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 10;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 10;
    background.style.transform = `scale(1.1) translate(${clamp(-x, -12, 12)}px, ${clamp(
      -y,
      -12,
      12
    )}px)`;
  });

  hero.addEventListener('mouseleave', () => {
    background.style.transform = 'scale(1.1) translate(0, 0)';
  });
};

const init = () => {
  initPreloader();
  initNav();
  initScrollAnimations();
  initHeroParticles();
  initGallery();
  initWhatsappBookingForm();
  initBackToTop();
  initCookieBanner();
  initCursor();
  initLazyImages();
  initYear();
  initSmoothAnchors();
  initHeroParallax();
};

document.addEventListener('DOMContentLoaded', init);

