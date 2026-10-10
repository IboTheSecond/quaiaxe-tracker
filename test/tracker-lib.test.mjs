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
