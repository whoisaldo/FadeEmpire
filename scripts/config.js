// config.js — site-wide constants.
//
// The Supabase anon key is intentionally public; security comes from RLS policies
// and the SECURITY DEFINER `book_slot` RPC, not from hiding this string.

export const SUPABASE_URL      = 'https://mjehfaonibgobimfiijk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_vCj7QAuA2-9Wp_ufQiv84Q_qDYwP9fd';

export const SHOP_PHONE  = '14138854440';            // E.164 minus the '+', for wa.me / sms:
export const SHOP_TZ     = 'America/New_York';

// STORE hours mirrored from `store_hours`. Open every day: Mon–Sat 9–6 and
// Sunday 10–6 (Hassan's Sunday shift). Used for the OPEN/CLOSED stamp and
// the clock dial. 0 = Sunday … 6 = Saturday; minutes-from-midnight.
export const STORE_HOURS = {
  0: { open: 10 * 60, close: 18 * 60 }, // Sun (Hassan only)
  1: { open: 9 * 60, close: 18 * 60 }, // Mon
  2: { open: 9 * 60, close: 18 * 60 }, // Tue
  3: { open: 9 * 60, close: 18 * 60 }, // Wed
  4: { open: 9 * 60, close: 18 * 60 }, // Thu
  5: { open: 9 * 60, close: 18 * 60 }, // Fri
  6: { open: 9 * 60, close: 18 * 60 }, // Sat
};

// Barbers + their weekly schedules, mirrored from `barbers`/`barber_schedules`.
// A barber's bookable hours are the INTERSECTION of these and STORE_HOURS —
// the DB enforces the same rule, this mirror only drives the UI.
export const BARBERS = {
  hassan: {
    slug: 'hassan',
    name: 'Hassan',
    title: 'Master Barber',
    photo: {
      mobile: './assets/Barbers/Hassan/optimized/HassanBarber_mobile.png',
      tablet: './assets/Barbers/Hassan/optimized/HassanBarber_tablet.png',
    },
    hoursLabel: '10 AM – 6 PM · Off Tuesdays',
    schedule: {
      0: { open: 10 * 60, close: 18 * 60 }, // Sun
      1: { open: 10 * 60, close: 18 * 60 }, // Mon
      3: { open: 10 * 60, close: 18 * 60 }, // Wed
      4: { open: 10 * 60, close: 18 * 60 }, // Thu
      5: { open: 10 * 60, close: 18 * 60 }, // Fri
      6: { open: 10 * 60, close: 18 * 60 }, // Sat
    },
  },
  javier: {
    slug: 'javier',
    name: 'Javier',
    title: 'Barber',
    photo: {
      mobile: './assets/Barbers/Javier/optimized/JavierBarber_mobile.jpg',
      tablet: './assets/Barbers/Javier/optimized/JavierBarber_tablet.jpg',
    },
    hoursLabel: '9 AM – 6 PM · Mon–Sat',
    schedule: {
      1: { open: 9 * 60, close: 18 * 60 }, // Mon
      2: { open: 9 * 60, close: 18 * 60 }, // Tue
      3: { open: 9 * 60, close: 18 * 60 }, // Wed
      4: { open: 9 * 60, close: 18 * 60 }, // Thu
      5: { open: 9 * 60, close: 18 * 60 }, // Fri
      6: { open: 9 * 60, close: 18 * 60 }, // Sat
    },
  },
};

export const DEFAULT_BARBER_SLUG = 'hassan';

export const SLOT_MINUTES = 30;

// Closing-soon threshold, in minutes before close
export const CLOSING_SOON_MIN = 60;

// Service prices in cents (mirror of services table, used for client-side total preview).
export const SERVICE_PRICES_CENTS = {
  'hair-cut':     3000,
  'line-up':      1000,
  'beard-trim':   1000,
  'kids-cut':     2500,
  'military-cut': 2500,
  'senior-cut':   2500,
  'vip-haircut':  6000,
};

// Chair time per service in minutes (mirror of services.duration_minutes).
// Drives how many consecutive 30-min slots a booking occupies.
export const SERVICE_DURATIONS_MIN = {
  'hair-cut':     30,
  'line-up':      30,
  'beard-trim':   30,
  'kids-cut':     30,
  'military-cut': 30,
  'senior-cut':   30,
  'vip-haircut':  60,
};

export const ADDON_PRICES_CENTS = {
  'eyebrows':   0,
  'hot-towel':  500,
  'facial':     2000,
  'wax':        500,
  'beard':      1000,
};
