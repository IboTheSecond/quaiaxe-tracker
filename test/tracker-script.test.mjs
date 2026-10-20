// What the /tracker page script (assets/tracker.js) actually does, run unchanged against a fake DOM and a
// Quai-shaped fake network (test/helpers/tracker-harness.mjs). Covers the open-source release fixes:
// share counters are numbers before they reach innerHTML, one poll reads the rewards once, "next unlock"
// never outlives the address or cycle it was computed for, and chart labels carry no inline style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatHashrate } from '../src/lib/tracker-lib.js';
import { startTracker, defaultWorld, CONFIG, TRACKER_JS, T0, DAY, DEFAULT_ADDR, OTHER_ADDR } from './helpers/tracker-harness.mjs';

const shortDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const clock = (iso) => new Date(iso).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' });

test('a normal pool response fills the tiles and the worker table', async () => {
  const page = await startTracker();
  assert.equal(page.text('trk-online'), '1');
  assert.equal(page.text('trk-total'), '2');
  assert.equal(page.text('trk-sh-valid'), '33485');
  const rows = page.el('trk-workers-body').innerHTML;
  assert.match(rows, /<td>rig-a<\/td>/);
  assert.match(rows, /<td>20000\/3\/1<\/td>/);
  assert.match(rows, /<td>13485\/0\/0<\/td>/);
});

test('a failed or malformed miner batch clears every miner-derived value', async () => {
  const page = await startTracker();
  const ids = ['trk-online', 'trk-total', 'trk-hr-sha', 'trk-hr-scrypt', 'trk-hr-kawpow', 'trk-sh-valid', 'trk-sh-stale', 'trk-sh-invalid'];
  assert.equal(page.text('trk-hr-sha'), '9.29 TH/s', 'precondition: the old value is visible');
  for (const failed of [null, { stats: null }]) {
    page.world.miners = failed;
    await page.tick();
    for (const id of ids) assert.equal(page.text(id), page.i18n['tracker.unavailable'], id);
    assert.match(page.el('trk-workers-body').innerHTML, /unavailable right now/);
  }
});

test('share counters from the pool API are numbers before they reach innerHTML, whatever the API sends', async () => {
  const hostile = ['<img src=x onerror=alert(1)>', ['<img src=x onerror=alert(1)>'], '"><script>alert(1)</script>', '1<b>2', -7, '9007199254740993abc'];
  const base = defaultWorld();
  const world = defaultWorld({
    miners: (addrs) => {
      const j = base.miners(addrs);
      j.workers[0].sharesValid = hostile[0];
      j.workers[0].sharesStale = hostile[1];
      j.workers[0].sharesInvalid = hostile[2];
      j.workers[1].sharesValid = hostile[3];
      j.workers[1].sharesStale = hostile[4];
      j.workers[1].sharesInvalid = hostile[5];
      return j;
    },
  });
  const page = await startTracker({ world });
  const rows = page.el('trk-workers-body').innerHTML;
  assert.doesNotMatch(rows, /<img|<script|<b>|onerror|alert/i, 'pool-supplied text reached the markup');
  assert.match(rows, /<td>0\/0\/0<\/td>/, 'a hostile counter collapses to 0');
  assert.equal((rows.match(/<tr>/g) || []).length, 2, 'still exactly one row per worker');
});

test('one poll reads the rewards once per address, and the whole request budget stays at 5 pool calls + 3 RPC reads', async () => {
  const page = await startTracker();
  assert.equal(page.rpcCalls('quai_getLockedBalance').length, 1, 'locked balance read once');
  assert.equal(page.rpcCalls('quai_getBalance').length, 1, 'unlocked balance read once');
  assert.equal(page.rpcCalls('eth_call').length, 1, 'burn vault read once');
  assert.equal(page.stratumCalls().length, 5, 'miners/batch, blocks 24h, blocks 7d, shares, history');
  assert.equal(page.calls.length, 8);
  // and the tiles still fill
  assert.equal(page.text('trk-locked'), '449.1304');
  assert.equal(page.text('trk-unlocked'), '10.4938');
  assert.equal(page.text('trk-burned'), '33,442');
  // a second 30 s cycle costs the same, not more
  page.clearCalls();
  await page.tick();
  assert.equal(page.rpcCalls().length, 3);
  assert.equal(page.stratumCalls().length, 5);
});

test('the tracker only calls the two API hosts from the config', async () => {
  const page = await startTracker();
  await page.check(OTHER_ADDR);
  const origins = [...new Set(page.calls.map((c) => c.origin))].sort();
  assert.deepEqual(origins, [new URL(CONFIG.rpc).origin, new URL(CONFIG.stratumxApi).origin].sort());
});

test('next unlock is the oldest 7-day workshare plus 14 days', async () => {
  const page = await startTracker();
  assert.equal(page.text('trk-nextunlock'), shortDate(T0 - 5 * DAY + 14 * DAY));
});

test('next unlock does not survive a switch to an address with no workshares', async () => {
  const world = defaultWorld({ blocks7d: (addrs) => (addrs[0] === DEFAULT_ADDR ? defaultWorld().blocks7d() : []) });
  const page = await startTracker({ world });
  assert.equal(page.text('trk-nextunlock'), shortDate(T0 - 5 * DAY + 14 * DAY), 'precondition: the default address has an estimate');
  await page.check(OTHER_ADDR);
  assert.match(page.el('trk-ws-body').innerHTML, /No workshares in the last 7 days\./);
  assert.equal(page.text('trk-nextunlock'), page.i18n['tracker.rewards.nextunlock.none']);
});

test('next unlock does not survive a failed workshare fetch either', async () => {
  const page = await startTracker();
  assert.equal(page.text('trk-nextunlock'), shortDate(T0 - 5 * DAY + 14 * DAY), 'precondition: an estimate on the first cycle');
  page.world.blocks7d = null; // the pool API goes down for the next cycle
  await page.tick();
  assert.equal(page.text('trk-nextunlock'), page.i18n['tracker.rewards.nextunlock.none']);
});

test('an old address response cannot repaint any panel after a new address finishes', async () => {
  let releaseMiners, releaseShares, releaseHistory;
  const oldMiners = new Promise((resolve) => { releaseMiners = resolve; });
  const oldShares = new Promise((resolve) => { releaseShares = resolve; });
  const oldHistory = new Promise((resolve) => { releaseHistory = resolve; });
  const normal = defaultWorld();
  const world = defaultWorld({
    miners: (addrs) => addrs[0] === DEFAULT_ADDR ? oldMiners : { stats: { ...normal.miners().stats, workersConnected: 0, workersTotal: 0 }, workers: [] },
    blocks7d: (addrs) => addrs[0] === DEFAULT_ADDR ? oldShares : [],
    history: (addrs) => addrs[0] === DEFAULT_ADDR ? oldHistory : { points: [
      { timestamp: new Date(T0 - DAY).toISOString(), hashrate: 1 },
      { timestamp: new Date(T0).toISOString(), hashrate: 2 },
    ] },
  });
  const page = await startTracker({ world });
  await page.check(OTHER_ADDR);
  const expected = {
    address: page.text('trk-check-addr-out'), online: page.text('trk-online'),
    unlock: page.text('trk-nextunlock'), rows: page.el('trk-ws-body').innerHTML,
    chart: page.el('trk-chart').innerHTML,
  };
  assert.equal(expected.online, '0');
  assert.equal(expected.unlock, page.i18n['tracker.rewards.nextunlock.none']);
  releaseMiners(normal.miners()); releaseShares(normal.blocks7d()); releaseHistory(normal.history());
  await page.settle();
  assert.deepEqual({
    address: page.text('trk-check-addr-out'), online: page.text('trk-online'),
    unlock: page.text('trk-nextunlock'), rows: page.el('trk-ws-body').innerHTML,
    chart: page.el('trk-chart').innerHTML,
  }, expected);
});

test('an older poll for the same address cannot repaint the newer poll', async () => {
  let release;
  const old = new Promise((resolve) => { release = resolve; });
  const normal = defaultWorld();
  let calls = 0;
  const page = await startTracker({ world: defaultWorld({
    miners: () => ++calls === 1 ? old : { stats: { ...normal.miners().stats, workersConnected: 0 }, workers: [] },
  }) });
  await page.tick();
  assert.equal(page.text('trk-online'), '0');
  release(normal.miners());
  await page.settle();
  assert.equal(page.text('trk-online'), '0');
});

test('the hashrate chart draws its axis labels without any inline style attribute', async () => {
  const page = await startTracker();
  const wrap = page.el('trk-chart');
  assert.match(wrap.innerHTML, /<svg/);
  assert.ok(!/\sstyle\s*=/i.test(wrap.innerHTML), 'chart markup carries an inline style attribute');
  assert.equal(wrap.children.length, 6, 'three hashrate labels and three time labels');

  const pts = defaultWorld().history().points;
  const peak = Math.max(...pts.map((p) => p.hashrate));
  const [y0, y1, y2, x0, x1, x2] = wrap.children;
  // hashrate labels: top of the chart, middle, bottom (same positions the inline styles used to give)
  assert.deepEqual([y0, y1, y2].map((n) => n.textContent), [formatHashrate(peak), formatHashrate(peak / 2), formatHashrate(0)]);
  assert.deepEqual([y0, y1, y2].map((n) => n.style.top), ['calc(12.73% - 8px)', 'calc(50.00% - 8px)', 'calc(87.27% - 8px)']);
  // time labels: first point, middle point, last point
  assert.deepEqual([x0, x1, x2].map((n) => n.textContent), [clock(pts[0].timestamp), clock(pts[144].timestamp), clock(pts[288].timestamp)]);
  assert.deepEqual([x0, x1, x2].map((n) => n.style.left), ['2.92%', '50%', '97.08%']);
  assert.deepEqual([x0, x1, x2].map((n) => n.style.transform), ['translateX(0)', 'translateX(-50%)', 'translateX(-100%)']);
  for (const n of [y0, y1, y2]) assert.match(n.className, /\blab\b.*\blab-y\b/);
  for (const n of [x0, x1, x2]) assert.match(n.className, /\blab\b.*\blab-x\b/);
});

test('oversized or malformed pool history is visibly unavailable instead of rendering an unsafe chart', async () => {
  const page = await startTracker();
  assert.match(page.el('trk-chart').innerHTML, /<svg/);
  const normal = defaultWorld();
  for (const points of [
    Array.from({ length: 2000 }, (_, i) => ({ timestamp: new Date(T0 - DAY + i * 1000).toISOString(), hashrate: i })),
    [{ timestamp: new Date(T0).toISOString(), hashrate: 'not-a-number' }],
  ]) {
    page.world.history = () => ({ points });
    await page.tick();
    assert.equal(page.text('trk-chart-status'), page.i18n['tracker.unavailable']);
    assert.equal(page.el('trk-chart').innerHTML, '');
  }
  page.world.history = normal.history;
  await page.tick();
  assert.match(page.el('trk-chart').innerHTML, /<svg/, 'a later good poll recovers');
});

test('nonfinite, negative or malformed luck never renders a numerical percentage', async () => {
  const page = await startTracker();
  for (const value of ['bad', Infinity, -1, '']) {
    page.world.shares = () => ({ bestShareLuck: value });
    await page.tick();
    assert.equal(page.text('trk-luck-best'), page.i18n['tracker.unavailable'], String(value));
  }
  page.world.shares = () => ({ bestShareLuck: 824.1 });
  await page.tick();
  assert.equal(page.text('trk-luck-best'), '824.1%');
});

// The CSP for /tracker/ is style-src 'self': an inline style attribute (or a <style> block, or
// setAttribute('style')) written by this script would be refused by the browser.
test('assets/tracker.js writes no inline style attribute, style element or cssText', async () => {
  const src = await readFile(TRACKER_JS, 'utf8');
  assert.ok(!/\bstyle\s*=\s*["'`\\]/.test(src), 'a style="" attribute in a template string');
  assert.ok(!/setAttribute\(\s*['"`]style/.test(src), 'setAttribute("style", ...)');
  assert.ok(!/cssText|<style/.test(src), 'cssText or a <style> element');
});

// The "check your own address" box. quai_getBalance refuses an address that is not in its checksummed spelling,
// and visitors paste lowercase, so the page checksums the address before the first RPC call.
test('a lowercase address pasted into the check box is checksummed: the node accepts it and the tiles fill', async () => {
  const page = await startTracker();
  page.el('trk-unlocked').textContent = 'stale';
  page.el('trk-locked').textContent = 'stale';
  page.clearCalls();
  await page.check(OTHER_ADDR.toLowerCase());
  assert.equal(page.text('trk-check-err'), '', 'no error for a valid address in the wrong casing');
  assert.equal(page.text('trk-check-addr-out'), OTHER_ADDR, 'the address shown is the checksummed one');
  const balanceCalls = page.rpcCalls('quai_getBalance');
  assert.equal(balanceCalls.length, 1);
  assert.equal(balanceCalls[0].body.params[0], OTHER_ADDR, 'quai_getBalance gets the checksummed spelling');
  assert.equal(page.text('trk-unlocked'), '10.4938', 'unlocked QUAI is filled, not "unavailable"');
  assert.equal(page.text('trk-locked'), '449.1304');
  for (const c of page.rpcCalls('quai_getLockedBalance')) assert.equal(c.body.params[0], OTHER_ADDR);
});

test('an all-uppercase address in the check box is checksummed too', async () => {
  const page = await startTracker();
  page.clearCalls();
  await page.check('0x' + OTHER_ADDR.slice(2).toUpperCase());
  assert.equal(page.text('trk-check-err'), '');
  assert.equal(page.text('trk-check-addr-out'), OTHER_ADDR);
  assert.equal(page.text('trk-unlocked'), '10.4938');
});

test('a mixed-case address with the wrong casing is refused, with no request sent and the old address kept', async () => {
  const page = await startTracker();
  const before = page.text('trk-check-addr-out');
  const letter = [...OTHER_ADDR.slice(2)].findIndex((c) => /[a-fA-F]/.test(c));
  const flip = (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  const wrong = '0x' + OTHER_ADDR.slice(2, 2 + letter) + flip(OTHER_ADDR[2 + letter]) + OTHER_ADDR.slice(3 + letter);
  page.clearCalls();
  await page.check(wrong);
  assert.equal(page.text('trk-check-err'), page.i18n['tracker.check.err']);
  assert.equal(page.calls.length, 0, 'nothing is sent for a refused address');
  assert.equal(page.text('trk-check-addr-out'), before);
});
