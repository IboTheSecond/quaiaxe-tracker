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

// ---- address checksum (EIP-55 style, as Quai nodes check it) --------------------------------------------------------
// quai_getBalance answers "address has invalid checksum" for an address that is not in its checksummed spelling, and the
// "check your own address" box takes whatever the visitor pastes, often all lowercase. checksumAddress() fixes the
// spelling before any RPC call. It needs Keccak-256 (not NIST SHA3), which neither the browser nor Node ships, so a
// small BigInt sponge lives here. It is this repository's own code, the same sponge as keccak256 in quaiaxe-core.js (no
// third-party package; it ships under the tracker repository's MIT licence); test/tracker-checksum-parity.test.mjs, which
// stays private, pins the two together.

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const KECCAK_MASK = (1n << 64n) - 1n;
const rotl64 = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & KECCAK_MASK);

function keccakF(s) {
  for (let round = 0; round < 24; round += 1) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) b[y + ((2 * x + 3 * y) % 5) * 5] = rotl64(s[x + 5 * y], KECCAK_ROT[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & KECCAK_MASK & b[((x + 2) % 5) + y]);
    }
    s[0] ^= KECCAK_RC[round];
  }
}

/** Keccak-256 of a Uint8Array, as 64 lowercase hex characters without a 0x prefix. */
export function keccak256Hex(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i += 1) {
      let w = 0n;
      for (let j = 7; j >= 0; j -= 1) w = (w << 8n) | BigInt(padded[off + i * 8 + j]);
      s[i] ^= w;
    }
    keccakF(s);
  }
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 8; j += 1) out += Number((s[i] >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * The checksummed spelling of an address, or null when the input cannot be one.
 * Accepts 0x + 40 hex characters (surrounding whitespace ignored). An all-lowercase or all-uppercase address carries no
 * checksum, so it is checksummed. A mixed-case address already claims a checksum, so it is returned only when its
 * casing is exactly the right one; any other mixed-case address (a typo, or junk) is refused with null.
 * @param {*} input
 * @returns {string|null}
 */
export function checksumAddress(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  const hex = s.slice(2).toLowerCase();
  const hash = keccak256Hex(new TextEncoder().encode(hex));
  let out = '0x';
  for (let i = 0; i < 40; i += 1) out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  const body = s.slice(2);
  const unsigned = body === body.toLowerCase() || body === body.toUpperCase();
  return unsigned || out === s ? out : null;
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
