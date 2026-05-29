// config.js — site-wide constants.
//
// The Supabase anon key is intentionally public; security comes from RLS policies
// and the SECURITY DEFINER `book_slot` RPC, not from hiding this string.

export const SUPABASE_URL      = 'https://mjehfaonibgobimfiijk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_vCj7QAuA2-9Wp_ufQiv84Q_qDYwP9fd';

export const BARBER_SLUG = 'hassan';
export const SHOP_PHONE  = '14138854440';            // E.164 minus the '+', for wa.me / sms:
export const SHOP_TZ     = 'America/New_York';

// Working schedule mirrored from `barber_schedules`. Used for OPEN/CLOSED stamp
// and time-grid construction. 0 = Sunday … 6 = Saturday.
// Hours expressed in minutes from midnight to make math easy.
export const SCHEDULE = {
  0: { open: 10 * 60, close: 18 * 60 }, // Sun
  1: { open: 10 * 60, close: 18 * 60 }, // Mon
  2: { open: 10 * 60, close: 18 * 60 }, // Tue
  3: { open: 10 * 60, close: 18 * 60 }, // Wed
  4: { open: 10 * 60, close: 18 * 60 }, // Thu
  5: { open: 10 * 60, close: 18 * 60 }, // Fri
  6: { open: 10 * 60, close: 18 * 60 }, // Sat
};

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

export const ADDON_PRICES_CENTS = {
  'eyebrows':   0,
  'hot-towel':  500,
  'facial':     2000,
  'wax':        500,
};
