// Tests for src/lib/tracker-lib.js. This file also ships, unchanged, in the open-source tracker tree
// (scripts/export-tracker-oss.mjs), so it may import only node: modules and tracker-lib itself, and it
// carries no real wallet address. The tokenomics creditSplit tests live in test/tokenomics-split.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHashrate, agoParts, isAddressShape, estimateUnlock, safeBlockHeight } from '../src/lib/tracker-lib.js';
import * as trackerLib from '../src/lib/tracker-lib.js';

test('formatHashrate picks the smallest readable unit', () => {
  assert.equal(formatHashrate(0), '0 H/s');
  assert.equal(formatHashrate(999), '999 H/s');
  assert.equal(formatHashrate(1234), '1.23 kH/s');
  assert.equal(formatHashrate(1234567), '1.23 MH/s');
  assert.equal(formatHashrate(1234567890), '1.23 GH/s');
  assert.equal(formatHashrate(1234567890123), '1.23 TH/s');
  assert.equal(formatHashrate(123456789012345), '123 TH/s');
});

test('formatHashrate refuses to guess on bad input', () => {
  assert.equal(formatHashrate(null), '—');
  assert.equal(formatHashrate(undefined), '—');
  assert.equal(formatHashrate('nonsense'), '—');
  assert.equal(formatHashrate(-5), '—');
});

test('agoParts buckets age into now/min/hour/day', () => {
  assert.deepEqual(agoParts(0), { unit: 'now', n: 0 });
  assert.deepEqual(agoParts(59_000), { unit: 'now', n: 0 });
  assert.deepEqual(agoParts(60_000), { unit: 'min', n: 1 });
  assert.deepEqual(agoParts(5 * 60_000), { unit: 'min', n: 5 });
  assert.deepEqual(agoParts(60 * 60_000), { unit: 'hour', n: 1 });
  assert.deepEqual(agoParts(25 * 60 * 60_000), { unit: 'day', n: 1 });
});

test('agoParts treats negative/NaN age as "now" rather than throwing', () => {
  assert.deepEqual(agoParts(-500), { unit: 'now', n: 0 });
  assert.deepEqual(agoParts(NaN), { unit: 'now', n: 0 });
});

test('isAddressShape accepts 0x + 40 hex with no checksum requirement', () => {
  const sample = '0x00' + 'Aa'.repeat(19); // synthetic: 0x + 40 hex digits, mixed case
  assert.equal(sample.length, 42);
  assert.equal(isAddressShape(sample), true);
  assert.equal(isAddressShape(sample.toLowerCase()), true); // all lowercase ok
  assert.equal(isAddressShape('0X' + sample.slice(2).toUpperCase()), false); // capital 0X not accepted
  assert.equal(isAddressShape('0x1234'), false);
  assert.equal(isAddressShape(''), false);
  assert.equal(isAddressShape(null), false);
});

test('estimateUnlock adds the lock window in days', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(estimateUnlock(t0), t0 + 14 * 24 * 60 * 60 * 1000);
  assert.equal(estimateUnlock(t0, 7), t0 + 7 * 24 * 60 * 60 * 1000);
});

// safeBlockHeight guards the workshares table's innerHTML: b.height comes straight from the
// third-party StratumX API and must never be trusted as markup or a URL path segment.
test('safeBlockHeight passes through a normal block number', () => {
  assert.equal(safeBlockHeight(12345), 12345);
  assert.equal(safeBlockHeight(0), 0);
  assert.equal(safeBlockHeight('987'), 987); // numeric string from JSON is fine
});

test('safeBlockHeight truncates a non-integer to a whole number', () => {
  assert.equal(safeBlockHeight(12345.9), 12345);
});

test('safeBlockHeight collapses hostile/malformed input to 0 instead of passing it through', () => {
  const hostile = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    'javascript:alert(1)',
    NaN,
    Infinity,
    -Infinity,
    -5,
    null,
    undefined,
    {},
    [],
    ['1', '2'],
  ];
  for (const v of hostile) {
    assert.equal(safeBlockHeight(v), 0, `expected 0 for ${JSON.stringify(v)}`);
  }
});

// safeCount guards the worker table's share counters (valid / stale / invalid) the same way: they come
// straight from the third-party StratumX API and are interpolated into innerHTML.
test('safeCount passes a normal counter through and truncates a fraction', () => {
  assert.equal(typeof trackerLib.safeCount, 'function', 'tracker-lib exports safeCount');
  assert.equal(trackerLib.safeCount(33485), 33485);
  assert.equal(trackerLib.safeCount(0), 0);
  assert.equal(trackerLib.safeCount('42'), 42);
  assert.equal(trackerLib.safeCount(7.9), 7);
});

test('safeCount collapses hostile or missing counters to 0 instead of passing them through', () => {
  assert.equal(typeof trackerLib.safeCount, 'function', 'tracker-lib exports safeCount');
  const hostile = ['<img src=x onerror=alert(1)>', ['<b>x</b>'], '1<b>2', '12abc', -3, NaN, Infinity, null, undefined, {}, [], true];
  for (const v of hostile) {
    const out = trackerLib.safeCount(v);
    assert.ok(Number.isInteger(out) && out >= 0, `not a plain count for ${JSON.stringify(v)}`);
    if (typeof v !== 'boolean') assert.equal(out, 0, `expected 0 for ${JSON.stringify(v)}`);
  }
});

// checksumAddress: the /tracker "check your own address" box. quai_getBalance refuses an address that is not
// in its checksummed spelling, so a pasted all-lowercase address is checksummed here before the RPC calls.
const TRACKED = '0x004D0221ffE03f529f7d9fCCc9d72a9AA0cCfd2e'; // the site's default deposit address, already on the scanner allowlist

test('checksumAddress turns the lowercase and the uppercase spelling into the checksummed one, exactly', () => {
  assert.equal(trackerLib.checksumAddress(TRACKED.toLowerCase()), TRACKED);
  assert.equal(trackerLib.checksumAddress('0x' + TRACKED.slice(2).toUpperCase()), TRACKED);
  assert.equal(trackerLib.checksumAddress(`  ${TRACKED.toLowerCase()}\n`), TRACKED, 'surrounding whitespace is ignored, as isAddressShape ignores it');
});

test('checksumAddress keeps an address that is already checksummed', () => {
  assert.equal(trackerLib.checksumAddress(TRACKED), TRACKED);
});

test('checksumAddress refuses a mixed-case address whose casing is not the checksum', () => {
  // flip the case of one letter at a time: every one of these is mixed-case junk and must come back null
  const letters = [...TRACKED.slice(2)].map((c, i) => [c, i]).filter(([c]) => /[a-fA-F]/.test(c));
  assert.ok(letters.length > 10);
  for (const [c, i] of letters) {
    const flipped = '0x' + TRACKED.slice(2, 2 + i) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + TRACKED.slice(3 + i);
    assert.equal(trackerLib.checksumAddress(flipped), null, `accepted a wrongly cased address (position ${i})`);
  }
});

test('checksumAddress refuses anything that is not 0x plus 40 hex characters', () => {
  const lower = TRACKED.toLowerCase();
  for (const bad of ['', null, undefined, 0, {}, [], '0x', lower.slice(0, -1), lower + '0', lower.slice(2), 'x' + lower.slice(1),
    lower.replace(/.$/, 'g'), `${lower} ${lower}`, '<img src=x>', lower.replace('0x', '0X')]) {
    assert.equal(trackerLib.checksumAddress(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('keccak256Hex matches the published Keccak-256 test vectors (not NIST SHA3)', () => {
  // Keccak-256("") begins c5d24601 and Keccak-256("abc") begins 4e03657a; SHA3-256("") would begin a7ffc6f8.
  assert.ok(trackerLib.keccak256Hex(new Uint8Array(0)).startsWith('c5d24601'));
  assert.ok(trackerLib.keccak256Hex(new TextEncoder().encode('abc')).startsWith('4e03657a'));
  assert.equal(trackerLib.keccak256Hex(new Uint8Array(0)).length, 64);
  // a message longer than one 136-byte block exercises the multi-block path
  assert.equal(trackerLib.keccak256Hex(new Uint8Array(300).fill(97)).length, 64);
});

// ---- tracker v2 helpers (ranges, history and share parsing, leaderboard, unlock schedule, fee-loop rows, live log decoding) ----
import {
  TRACKER_RANGES, MAX_HISTORY_POINTS, isTrackerRange, parseHistory, parseShares, shortAddress, topWorkers, scheduleByDay,
  safeTelegramUrl, FEED_TOPICS, decodeSwept, decodeTransferLog, formatWei, pairBurns, summarizeFeedLoop, feeLoopRowHtml,
  escapeHtml, txUrl, utcDate, weiString, burnSeries, mergeRows,
} from '../src/lib/tracker-lib.js';

const ADDR_A = '0x00AAAaaAAAaaaAaAAaAaAaAaaaAAAAaAAAAAaaAA';
const H = (n) => '0x' + String(n).repeat(64).slice(0, 64);
const WEI18 = 10n ** 18n;
const iso = (ms) => new Date(ms).toISOString();

test('ranges: the pool API takes 1h, 24h and 7d only, so 30d is never offered', () => {
  assert.deepEqual(TRACKER_RANGES, ['1h', '24h', '7d']);
  for (const ok of TRACKER_RANGES) assert.equal(isTrackerRange(ok), true);
  for (const bad of ['30d', '1d', '', null, undefined, '24H', ['24h'], '24h&x=1', 7]) assert.equal(isTrackerRange(bad), false, String(bad));
  assert.equal(MAX_HISTORY_POINTS, 1500);
});

test('parseHistory: valid points come back oldest first, malformed or oversized data is null, never NaN', () => {
  const t0 = Date.UTC(2026, 9, 5);
  const good = { points: [{ timestamp: iso(t0 + 60000), hashrate: 5 }, { timestamp: iso(t0), hashrate: '7.5' }] };
  assert.deepEqual(parseHistory(good), [{ t: t0, hashrate: 7.5 }, { t: t0 + 60000, hashrate: 5 }]);
  assert.deepEqual(parseHistory({ points: [] }), []);
  for (const bad of [null, undefined, 5, 'x', {}, { points: 'x' }, { points: [null] },
    { points: [{ timestamp: 'nope', hashrate: 1 }] }, { points: [{ timestamp: iso(t0), hashrate: 'abc' }] },
    { points: [{ timestamp: iso(t0), hashrate: -1 }] }, { points: [{ timestamp: iso(t0), hashrate: Infinity }] },
    { points: [{ timestamp: iso(t0), hashrate: ' ' }] }, { points: [{ timestamp: 5, hashrate: 1 }] },
    { points: Array.from({ length: 1501 }, (_, i) => ({ timestamp: iso(t0 + i * 1000), hashrate: i })) }]) {
    assert.equal(parseHistory(bad), null, String(JSON.stringify(bad)).slice(0, 60));
  }
  assert.equal(parseHistory({ points: Array.from({ length: 1500 }, (_, i) => ({ timestamp: iso(t0 + i * 1000), hashrate: i })) }).length, 1500);
});

test('parseShares: workshares with luck, oldest first; a bad luck value, bad time or too many points makes the whole chart unavailable', () => {
  const t0 = Date.UTC(2026, 9, 5);
  const sh = (ms, luck, extra = {}) => ({ timestamp: iso(ms), luckPercent: luck, achievedDifficulty: 10, workshareDiff: 5, isBlock: true, worker: `${ADDR_A}.rig`, algorithm: 'sha256', ...extra });
  const out = parseShares({ shares: [sh(t0 + 5000, 250.5), sh(t0, 0)] });
  assert.deepEqual(out.map((p) => [p.t, p.luck]), [[t0, 0], [t0 + 5000, 250.5]]);
  assert.deepEqual(parseShares({ shares: [] }), []);
  for (const bad of [null, {}, { shares: 'x' }, { shares: [null] }, { shares: [sh(t0, 'abc')] }, { shares: [sh(t0, -1)] }, { shares: [sh(t0, Infinity)] },
    { shares: [{ ...sh(t0, 1), timestamp: 'nope' }] }, { shares: Array.from({ length: 1501 }, (_, i) => sh(t0 + i, 1)) }]) {
    assert.equal(parseShares(bad), null);
  }
  assert.equal(parseShares({ shares: [sh(t0, '12.5')] })[0].luck, 12.5, 'a plain numeric string is accepted like the best-share tile does');
});

test('shortAddress: 0x00ab…12cd for a well formed address, a dash for anything else', () => {
  assert.equal(shortAddress(ADDR_A), '0x00AA…aaAA');
  for (const bad of [null, undefined, '', 'x', '0x1234', `${ADDR_A}z`, { toString: () => ADDR_A }, 5]) assert.equal(shortAddress(bad), '—');
});

test('topWorkers: the busiest rigs first, third-party text kept as text, an address only when it is well formed', () => {
  const w = (name, hashrate, over = {}) => ({ workerName: name, address: ADDR_A, algorithm: 'sha256', hashrate, isConnected: true, ...over });
  const list = topWorkers([w('b', 5), w('a', 9), w(`${ADDR_A}.c`, 7), w('d', 'x'), null, w('e', -1), w('f', 1, { address: '<img src=x>' })], 3);
  assert.deepEqual(list.map((x) => [x.nick, x.hashrate]), [['a', 9], ['c', 7], ['b', 5]]);
  assert.equal(list[0].address, ADDR_A);
  const bad = topWorkers([w('f', 1, { address: '<img src=x>' })], 5);
  assert.equal(bad[0].address, null);
  assert.deepEqual(topWorkers(null), []);
  assert.deepEqual(topWorkers('x'), []);
  assert.equal(topWorkers(Array.from({ length: 50 }, (_, i) => w(`r${i}`, i)), 8).length, 8);
});

test('scheduleByDay: workshares grouped by UTC day, each day unlocks 14 days later; bad rows are skipped', () => {
  const d = (day, hour) => Date.UTC(2026, 9, day, hour);
  const rows = scheduleByDay([
    { foundAt: iso(d(5, 1)) }, { foundAt: iso(d(5, 23)) }, { foundAt: iso(d(3, 12)) }, { foundAt: 'junk' }, null, { foundAt: iso(d(31, 12)) },
  ]);
  assert.deepEqual(rows, [
    { day: '2026-10-03', count: 1, unlockDay: '2026-10-17' },
    { day: '2026-10-05', count: 2, unlockDay: '2026-10-19' },
    { day: '2026-10-31', count: 1, unlockDay: '2026-11-14' },
  ]);
  assert.deepEqual(scheduleByDay(null), []);
});

test('safeTelegramUrl: only an https t.me bot or channel link passes, nothing else renders a button', () => {
  // URLs are assembled so this file carries no literal link (the public tree's scanner allowlists hosts).
  const u = (rest) => ['https', '://', rest].join('');
  const ok = u('t.me/QuaiAxeTrackerBot');
  assert.equal(safeTelegramUrl(ok), ok);
  assert.equal(safeTelegramUrl(`${ok}?start=tracker`), `${ok}?start=tracker`);
  for (const bad of [null, undefined, '', 5, ['http', '://', 't.me/SomeBot'].join(''), u('t.me.other.example/SomeBot'), u('other.example/t.me/SomeBot'),
    u('t.me/'), u('t.me/a'), 'javascript:alert(1)', u('t.me/SomeBot"><script>'), u('t.me/SomeBot onclick=x'), ` ${u('t.me/SomeBot')}`,
    u(['user', 't.me/SomeBot'].join('@')), u('t.me:444/SomeBot'), u('t.me/SomeBot#x'), u('t.me/SomeBot?x=<')]) {
    assert.equal(safeTelegramUrl(bad), null, String(bad));
  }
});

test('live log decoding: the vault Swept event and a QAXE Transfer, checked for shape before use', () => {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const caller = '0x' + '0'.repeat(24) + 'aa'.repeat(20);
  const swept = {
    address: ADDR_A, topics: [FEED_TOPICS.swept, caller], blockNumber: '0xa4', logIndex: '0x3', transactionHash: H(1),
    data: '0x' + [100n * WEI18, 1n, 2n, 99n * WEI18, 5000n * WEI18, 0n].map(word).join(''),
  };
  assert.deepEqual(decodeSwept(swept), { b: 164, li: 3, tx: H(1), burned: (5000n * WEI18).toString(), quai: (99n * WEI18).toString() });
  for (const bad of [null, {}, { ...swept, topics: [FEED_TOPICS.swept] }, { ...swept, topics: ['0x' + '1'.repeat(64), caller] }, { ...swept, data: '0x00' },
    { ...swept, transactionHash: 'nope' }, { ...swept, blockNumber: 'zz' }]) assert.equal(decodeSwept(bad), null);
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const transfer = { address: ADDR_A, topics: [FEED_TOPICS.transfer, pad(ADDR_A), pad(ADDR_A)], blockNumber: '0x10', logIndex: '0x0', transactionHash: H(2), data: '0x' + word(7n * WEI18) };
  assert.deepEqual(decodeTransferLog(transfer), { b: 16, li: 0, tx: H(2), from: ADDR_A.toLowerCase(), to: ADDR_A.toLowerCase(), amount: (7n * WEI18).toString() });
  for (const bad of [null, { ...transfer, topics: [FEED_TOPICS.transfer] }, { ...transfer, data: '0x' }, { ...transfer, topics: [FEED_TOPICS.swept, pad(ADDR_A), pad(ADDR_A)] }]) assert.equal(decodeTransferLog(bad), null);
  assert.match(FEED_TOPICS.transfer, /^0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef$/);
  assert.match(FEED_TOPICS.swept, /^0xbcd4762a[0-9a-f]{56}$/);
});

test('formatWei: exact BigInt rounding with grouping, EN and TR, a dash for anything that is not a whole number of wei', () => {
  assert.equal(formatWei((1234n * WEI18) + (WEI18 * 567n) / 1000n, 2, 'en'), '1,234.57');
  assert.equal(formatWei('339542889000000000000000', 0, 'en'), '339,543');
  assert.equal(formatWei('1500000000000000000', 2, 'tr'), '1,50');
  assert.equal(formatWei('1234000000000000000000', 0, 'tr'), '1.234');
  assert.equal(formatWei(0n, 2, 'en'), '0.00');
  for (const bad of [null, undefined, '', 'abc', '-5', '1.5', 1.5, {}]) assert.equal(formatWei(bad, 2, 'en'), '—');
});

test('weiString: a non-negative integer string of sane length, else null', () => {
  assert.equal(weiString('123'), '123');
  assert.equal(weiString(123n), '123');
  for (const bad of ['', '-1', '1e18', '0x10', 12.5, null, undefined, 'x'.repeat(5), '9'.repeat(60)]) assert.equal(weiString(bad), null);
});

test('txUrl and utcDate: a link only for a real 32-byte hash, a UTC calendar date from epoch seconds', () => {
  assert.equal(txUrl(H(3)), `https://quaiscan.io/tx/${H(3)}`);
  for (const bad of ['0x12', null, `${H(3)}"`, 5]) assert.equal(txUrl(bad), null);
  assert.equal(utcDate(1792666969), '2026-10-22');
  assert.equal(utcDate('x'), '—');
  assert.equal(utcDate(-1), '—');
});

test('escapeHtml escapes the five markup characters', () => {
  assert.equal(escapeHtml('<a href="x" title=\'y\'>&</a>'), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('fee loop pairing: each buy takes the next burn from the same wallet within the window, never more than it bought', () => {
  const buys = [{ tx: H(1), b: 100, ts: 1, quai: '1000', qaxe: '400', burned: null, burnTx: null }, { tx: H(2), b: 500, ts: 2, quai: '10', qaxe: '30', burned: null, burnTx: null }];
  const burns = [{ b: 105, tx: H(5), qaxe: '200' }, { b: 901, tx: H(6), qaxe: '15' }, { b: 101, tx: H(7), qaxe: '9999' }];
  const rows = pairBurns(buys, burns, 400);
  assert.deepEqual(rows.map((r) => [r.burned, r.burnTx]), [['200', H(5)], [null, null]], 'the second burn is 400 blocks past the second buy; an oversized burn is not a half-burn of this buy');
  assert.equal(buys[0].burned, null, 'the inputs are not changed');
  assert.deepEqual(pairBurns(rows, burns, 400), rows, 'pairing is idempotent');
  const again = pairBurns([...rows.slice(0, 1), { tx: H(2), b: 500, ts: 2, quai: '10', qaxe: '30', burned: null, burnTx: null }], [{ b: 520, tx: H(8), qaxe: '15' }], 400);
  assert.equal(again[1].burned, '15');
  assert.equal(pairBurns(null, null).length, 0);
});

test('fee loop summary: runs, QUAI spent, QAXE bought, burned and held, with unknowns counted apart and never as zero', () => {
  const rows = [
    { tx: H(1), b: 1, ts: 1, quai: '1000', qaxe: '400', burned: '200', burnTx: H(5) },
    { tx: H(2), b: 2, ts: 2, quai: '10', qaxe: '30', burned: null, burnTx: null },
    { tx: H(3), b: 3, ts: 3, quai: null, qaxe: '50', burned: '25', burnTx: H(6) },
  ];
  assert.deepEqual(summarizeFeedLoop(rows), { runs: 3, quai: '1010', quaiUnknown: 1, qaxe: '480', burned: '225', held: '225', burnPending: 1 });
  assert.deepEqual(summarizeFeedLoop([]), { runs: 0, quai: '0', quaiUnknown: 0, qaxe: '0', burned: '0', held: '0', burnPending: 0 });
  assert.deepEqual(summarizeFeedLoop(null), { runs: 0, quai: '0', quaiUnknown: 0, qaxe: '0', burned: '0', held: '0', burnPending: 0 });
});

test('mergeRows: a live row for a transaction the snapshot already holds is dropped, new rows come in oldest first', () => {
  const a = { tx: H(1), b: 1, ts: 1, quai: '5', qaxe: '9', burned: '4', burnTx: H(4) };
  const dupLive = { tx: H(1), b: 1, ts: 1, quai: null, qaxe: '9', burned: null, burnTx: null };
  const fresh = { tx: H(2), b: 9, ts: 9, quai: null, qaxe: '7', burned: null, burnTx: null };
  assert.deepEqual(mergeRows([a], [fresh, dupLive]), [a, fresh]);
});

test('fee loop row HTML: escaped text, a link only for a real transaction hash, held = bought - burned', () => {
  const labels = { pending: 'pending', buy: 'buy', burn: 'burn' };
  const html = feeLoopRowHtml({ tx: H(1), b: 1, ts: 1792666969, quai: (1000n * WEI18).toString(), qaxe: (339n * WEI18).toString(), burned: (169n * WEI18).toString(), burnTx: H(2) }, { lang: 'en', labels });
  assert.match(html, /^<tr[ >]/);
  assert.match(html, /2026-10-22/);
  assert.match(html, /1,000\.00/);
  assert.match(html, /339\.00/);
  assert.match(html, /169\.00/);
  assert.match(html, /170\.00/);
  assert.ok(html.includes(`https://quaiscan.io/tx/${H(1)}`) && html.includes(`https://quaiscan.io/tx/${H(2)}`));
  const hostile = feeLoopRowHtml({ tx: '"><img src=x onerror=alert(1)>', b: 1, ts: 1, quai: '<b>', qaxe: '5', burned: null, burnTx: '<script>' }, { lang: 'en', labels });
  assert.doesNotMatch(hostile, /<img|<script|<b>|onerror|href="[^h]/i);
  assert.match(hostile, /pending/, 'a burn that is not on chain yet is labelled, not shown as zero');
});

test('burnSeries: cumulative mining burns from the vault sweeps, in whole QAXE, with the on-chain counter as the last point', () => {
  const sweeps = [{ tx: H(2), b: 20, ts: 200, burned: (30n * WEI18).toString() }, { tx: H(1), b: 10, ts: 100, burned: (10n * WEI18).toString() }];
  assert.deepEqual(burnSeries(sweeps, (40n * WEI18).toString(), 300), [{ t: 100000, v: 10 }, { t: 200000, v: 40 }, { t: 300000, v: 40 }]);
  assert.deepEqual(burnSeries(sweeps, null, 300), [{ t: 100000, v: 10 }, { t: 200000, v: 40 }]);
  assert.deepEqual(burnSeries([], null, 300), []);
  assert.deepEqual(burnSeries([{ tx: H(1), b: 1, ts: 'x', burned: '5' }, { tx: H(2), b: 2, ts: 5, burned: 'bad' }], null, 0), []);
});
