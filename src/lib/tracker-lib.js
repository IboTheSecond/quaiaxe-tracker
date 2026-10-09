/**
 * tracker-lib.js — dependency-free pure helpers for the /tracker page: hashrate formatting,
 * "x min ago" bucketing, and loose address-shape validation for the StratumX API (which accepts any
 * 0x + 40-hex address and does not require or check a checksum — unlike validatePayoutAddress in
 * quaiaxe-core.js, which is stricter because it gates an on-chain payout wallet).
 */

const HASHRATE_UNITS = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];

/**
 * Format a hashrate given in H/s (hashes per second) into a human string with the smallest unit
 * that keeps the mantissa readable, e.g. formatHashrate(1234567) -> "1.23 MH/s".
 * @param {number|string|null|undefined} hs
 * @returns {string} '—' for null/undefined/NaN/negative input, otherwise "N.NN UNIT".
 */
export function formatHashrate(hs) {
  const n = Number(hs);
  if (hs == null || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 H/s';
  let v = n;
  let i = 0;
  while (v >= 1000 && i < HASHRATE_UNITS.length - 1) { v /= 1000; i += 1; }
  if (i === 0) return `${Math.round(v)} H/s`;
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${HASHRATE_UNITS[i]}`;
}

/**
 * Bucket the age (in milliseconds) of a past event into a translation key + count, so the caller can
 * render a localized "{n} min ago" / "just now" string from its own i18n table without this module
 * knowing any language.
 * @param {number} ageMs  now - thenMs; negative or NaN treated as 0.
 * @returns {{unit: 'now'|'min'|'hour'|'day', n: number}}
 */
export function agoParts(ageMs) {
  const ms = Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return { unit: 'now', n: 0 };
  const min = Math.floor(sec / 60);
  if (min < 60) return { unit: 'min', n: min };
  const hour = Math.floor(min / 60);
  if (hour < 24) return { unit: 'hour', n: hour };
  const day = Math.floor(hour / 24);
  return { unit: 'day', n: day };
}

/** Loose shape check the StratumX API itself accepts: 0x + 40 hex chars. No checksum required. */
export function isAddressShape(input) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(input || '').trim());
}

/**
 * Coerce a third-party API field (StratumX's workshare `height`) to a safe non-negative integer
 * before it is ever interpolated into an href or innerHTML. Anything that is not a finite,
 * non-negative number — a string, an object, NaN, Infinity, a negative value — collapses to 0
 * rather than being trusted as markup or a URL path segment.
 * @param {*} value
 * @returns {number}
 */
export function safeBlockHeight(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * The same coercion for the share counters (valid / stale / invalid) in the worker table: they come
 * straight from the third-party StratumX response and are interpolated into innerHTML, so a counter
 * that is not a plain non-negative number becomes 0 instead of reaching the markup.
 * @param {*} value
 * @returns {number}
 */
export const safeCount = safeBlockHeight;

/**
 * Estimate the next unlock instant from the earliest share timestamp in a window, per Quai's ~14-day
 * reward lock. Always a rough estimate — the caller must say so.
 * @param {number} firstShareMs  epoch ms of the earliest share considered
 * @param {number} [lockDays=14]
 * @returns {number} epoch ms
 */
export function estimateUnlock(firstShareMs, lockDays = 14) {
  return firstShareMs + lockDays * 24 * 60 * 60 * 1000;
}
