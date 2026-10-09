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
