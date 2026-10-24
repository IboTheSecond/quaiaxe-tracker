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

// ---- v2: ranges, history and share parsing, leaderboard, unlock schedule, live feed decoding, fee-loop rows -----------------
// Everything below is pure (no DOM, no network) so the page script, the build and the tests share one copy. Third-party
// values (StratumX, log data) are validated here before the page ever puts them in markup, a link or a chart.

/** The periods StratumX accepts for history and share lists. It rejects 30d ("invalid period, must be 1h, 24h, or 7d"). */
export const TRACKER_RANGES = Object.freeze(['1h', '24h', '7d']);
/** A chart or list with more points than this is shown as unavailable instead of drawn. */
export const MAX_HISTORY_POINTS = 1500;
export function isTrackerRange(value) {
  return typeof value === 'string' && TRACKER_RANGES.includes(value);
}

const finiteNumber = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));

/**
 * StratumX hashrate history -> [{ t: epoch ms, hashrate }] oldest first. null when the answer is malformed, oversized or
 * holds any bad point (a chart is drawn from all of it or none of it); [] when it is valid and empty.
 */
export function parseHistory(json) {
  const points = json && Array.isArray(json.points) ? json.points : null;
  if (!points || points.length > MAX_HISTORY_POINTS) return null;
  const out = [];
  for (const p of points) {
    if (!p || typeof p !== 'object' || typeof p.timestamp !== 'string' || !finiteNumber(p.hashrate)) return null;
    const t = Date.parse(p.timestamp);
    const hashrate = Number(p.hashrate);
    if (!Number.isFinite(t) || hashrate < 0) return null;
    out.push({ t, hashrate });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** StratumX share list -> [{ t, luck, worker, algorithm }] oldest first, with the same all-or-nothing rule as parseHistory. */
export function parseShares(json) {
  const list = json && Array.isArray(json.shares) ? json.shares : null;
  if (!list || list.length > MAX_HISTORY_POINTS) return null;
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || typeof s.timestamp !== 'string' || !finiteNumber(s.luckPercent)) return null;
    const t = Date.parse(s.timestamp);
    const luck = Number(s.luckPercent);
    if (!Number.isFinite(t) || luck < 0) return null;
    out.push({ t, luck, worker: typeof s.worker === 'string' ? s.worker : '', algorithm: typeof s.algorithm === 'string' ? s.algorithm : '' });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 0x00ab…12cd for a well formed address, a dash for anything else. */
export function shortAddress(address) {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—';
}

/**
 * The busiest rigs of a miners/batch answer: [{ nick, address, algorithm, hashrate, online }]. A worker name is whatever the
 * miner typed, so it stays text for the caller to escape; an address is kept only when it is a well formed 0x address.
 */
export function topWorkers(workers, limit = 8) {
  if (!Array.isArray(workers)) return [];
  const rows = [];
  for (const w of workers) {
    if (!w || typeof w !== 'object' || !finiteNumber(w.hashrate) || Number(w.hashrate) < 0) continue;
    rows.push({
      nick: String(w.workerName || '').replace(/^0x[0-9a-fA-F]{40}\.?/, '') || '—',
      address: typeof w.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w.address) ? w.address : null,
      algorithm: String(w.algorithm || '—'),
      hashrate: Number(w.hashrate),
      online: w.isConnected === true,
    });
  }
  return rows.sort((a, b) => b.hashrate - a.hashrate).slice(0, limit);
}

const DAY_MS = 86_400_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Workshares grouped by UTC day, each day with the estimated unlock day (found + lock period, 14 days by default). */
export function scheduleByDay(blocks, lockDays = 14) {
  if (!Array.isArray(blocks)) return [];
  const days = new Map();
  for (const b of blocks) {
    const ms = b && typeof b.foundAt === 'string' ? Date.parse(b.foundAt) : NaN;
    if (!Number.isFinite(ms)) continue;
    const key = dayOf(ms);
    days.set(key, (days.get(key) || 0) + 1);
  }
  return [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, count]) => ({ day, count, unlockDay: dayOf(Date.parse(`${day}T00:00:00Z`) + lockDays * DAY_MS) }));
}

/** An https t.me link (bot or channel, optional ?start= payload) and nothing else; anything different renders no button. */
export function safeTelegramUrl(value) {
  if (typeof value !== 'string') return null;
  return /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}(\?start=[A-Za-z0-9_-]{1,64})?$/.test(value) ? value : null;
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Non-negative integer wei as a decimal string (BigInt, number-safe integer or digits), else null. */
export function weiString(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  return typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : null;
}

/** An explorer link for a 32-byte transaction hash, null for anything else. */
export function txUrl(hash) {
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `https://quaiscan.io/tx/${hash}` : null;
}

/** YYYY-MM-DD (UTC) from epoch seconds, a dash for anything that is not a plausible time. */
export function utcDate(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? dayOf(seconds * 1000) : '—';
}

/** Exact decimal text of a wei amount (18 decimals): BigInt rounding half up, grouped, EN or TR separators. */
export function formatWei(wei, digits = 2, lang = 'en') {
  const s = weiString(wei);
  if (s == null) return '—';
  const scale = 10n ** BigInt(18 - digits);
  const units = (BigInt(s) + scale / 2n) / scale;
  const base = 10n ** BigInt(digits);
  const whole = (units / base).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US');
  if (digits === 0) return whole;
  return `${whole}${lang === 'tr' ? ',' : '.'}${(units % base).toString().padStart(digits, '0')}`;
}

// ---- live feed: the log shapes the page reads (QaxeBurnVault.Swept, QAXE Transfer) --------------------------------------
const enc = new TextEncoder();
const topic = (signature) => `0x${keccak256Hex(enc.encode(signature))}`;
export const FEED_TOPICS = Object.freeze({
  transfer: topic('Transfer(address,address,uint256)'),
  // QaxeBurnVault.Swept(caller indexed, slice, fee, refund, quaiSpent, burned, remainingAvailable)
  swept: topic('Swept(address,uint256,uint256,uint256,uint256,uint256,uint256)'),
});
const hexInt = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(v) ? Number(BigInt(v)) : null);
const words = (data) => (typeof data === 'string' && /^0x(?:[0-9a-fA-F]{64})*$/.test(data) ? (data.length - 2) / 64 : -1);
const wordAt = (data, i) => BigInt(`0x${data.slice(2 + i * 64, 66 + i * 64)}`);
const topicAddress = (t) => (typeof t === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(t) ? `0x${t.slice(26).toLowerCase()}` : null);

/** One eth_getLogs / subscription log of the burn vault -> { b, li, tx, burned, quai } (decimal strings), or null. */
export function decodeSwept(log) {
  if (!log || typeof log !== 'object' || !Array.isArray(log.topics) || log.topics.length !== 2 || log.topics[0] !== FEED_TOPICS.swept) return null;
  if (words(log.data) < 6 || !/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash))) return null;
  const b = hexInt(log.blockNumber);
  const li = log.logIndex == null ? 0 : hexInt(log.logIndex);
  if (b == null || li == null) return null;
  return { b, li, tx: log.transactionHash, burned: wordAt(log.data, 4).toString(), quai: wordAt(log.data, 3).toString() };
}

/** One QAXE Transfer log -> { b, li, tx, from, to, amount } with lowercase addresses and a decimal amount, or null. */
export function decodeTransferLog(log) {
  if (!log || typeof log !== 'object' || !Array.isArray(log.topics) || log.topics.length !== 3 || log.topics[0] !== FEED_TOPICS.transfer) return null;
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  if (!from || !to || words(log.data) < 1 || !/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash))) return null;
  const b = hexInt(log.blockNumber);
  const li = log.logIndex == null ? 0 : hexInt(log.logIndex);
  if (b == null || li == null) return null;
  return { b, li, tx: log.transactionHash, from, to, amount: wordAt(log.data, 0).toString() };
}

// ---- the QuaiAxe fee loop: buybacks with their half-burn, never mixed with the mining (vault) burns ------------------------
// A row is { tx, b, ts, quai, qaxe, burned, burnTx }: QUAI spent (null when only the QAXE leg was seen live), QAXE bought,
// QAXE burned by the wallet right after (null until that burn is seen). Held = bought - burned.

/** Give each unpaired buy the earliest unused burn at or after its block, within `windowBlocks`, that is not larger than the buy. */
export function pairBurns(rows, burns, windowBlocks = 400) {
  const list = Array.isArray(rows) ? rows : [];
  const pool = (Array.isArray(burns) ? burns : []).filter((x) => x && weiString(x.qaxe) != null && Number.isFinite(x.b)).slice().sort((a, b) => a.b - b.b);
  const used = new Set(list.map((r) => r.burnTx).filter(Boolean));
  return list.map((r) => {
    if (r.burned != null) return { ...r };
    const hit = pool.find((x) => !used.has(x.tx) && x.b >= r.b && x.b - r.b <= windowBlocks && BigInt(x.qaxe) <= BigInt(r.qaxe));
    if (!hit) return { ...r };
    used.add(hit.tx);
    return { ...r, burned: hit.qaxe, burnTx: hit.tx };
  });
}

/** Snapshot rows plus live rows: a live row for a transaction the snapshot already holds is dropped. Oldest first. */
export function mergeRows(base, live) {
  const seen = new Set((base || []).map((r) => r.tx));
  const extra = [];
  for (const r of live || []) if (!seen.has(r.tx)) { seen.add(r.tx); extra.push(r); }
  return [...(base || []), ...extra].sort((a, b) => a.b - b.b);
}

/** Totals over fee-loop rows only. Unknown legs are counted apart (quaiUnknown, burnPending), never added as zero. */
export function summarizeFeedLoop(rows) {
  const out = { runs: 0, quai: 0n, quaiUnknown: 0, qaxe: 0n, burned: 0n, held: 0n, burnPending: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    const qaxe = weiString(r.qaxe);
    if (qaxe == null) continue;
    out.runs += 1;
    out.qaxe += BigInt(qaxe);
    const quai = weiString(r.quai);
    if (quai == null) out.quaiUnknown += 1; else out.quai += BigInt(quai);
    const burned = weiString(r.burned);
    if (burned == null) out.burnPending += 1; else { out.burned += BigInt(burned); out.held += BigInt(qaxe) - BigInt(burned); }
  }
  return { ...out, quai: out.quai.toString(), qaxe: out.qaxe.toString(), burned: out.burned.toString(), held: out.held.toString() };
}

/** One <tr> of the fee-loop table. Every value is validated or escaped; links go to quaiscan.io for real hashes only. */
export function feeLoopRowHtml(row, { lang = 'en', labels = {} } = {}) {
  const qaxe = weiString(row.qaxe);
  const burned = weiString(row.burned);
  const held = qaxe != null && burned != null ? (BigInt(qaxe) - BigInt(burned)).toString() : null;
  const link = (hash, text) => { const u = txUrl(hash); return u ? `<a href="${u}" target="_blank" rel="noopener">${escapeHtml(text)}</a>` : ''; };
  const pending = escapeHtml(labels.pending || '—');
  const links = [link(row.tx, labels.buy || 'buy'), link(row.burnTx, labels.burn || 'burn')].filter(Boolean).join(' · ') || '—';
  return `<tr class="trk-row"><td>${utcDate(row.ts)}</td><td>${formatWei(row.quai, 2, lang)}</td><td>${formatWei(qaxe, 2, lang)}</td>` +
    `<td>${burned == null ? pending : formatWei(burned, 2, lang)}</td><td>${held == null ? pending : formatWei(held, 2, lang)}</td><td>${links}</td></tr>`;
}

/** Cumulative QAXE burned by mining (whole QAXE) from the vault's sweeps, ending at the counter read now when given. */
export function burnSeries(sweeps, counterWei, nowSeconds) {
  const list = (Array.isArray(sweeps) ? sweeps : [])
    .filter((s) => s && typeof s.ts === 'number' && Number.isFinite(s.ts) && weiString(s.burned) != null)
    .slice().sort((a, b) => a.ts - b.ts || a.b - b.b);
  const out = [];
  let sum = 0n;
  for (const s of list) {
    sum += BigInt(s.burned);
    out.push({ t: s.ts * 1000, v: Number(sum / 10n ** 14n) / 1e4 });
  }
  const now = weiString(counterWei);
  if (out.length && now != null && Number.isFinite(nowSeconds) && nowSeconds > 0) out.push({ t: nowSeconds * 1000, v: Number(BigInt(now) / 10n ** 14n) / 1e4 });
  return out;
}
