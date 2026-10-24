// Runs the REAL assets/tracker.js against a hand-made DOM and a fake network, so tests can see what
// the page does (what lands in innerHTML, which requests go out, what the tiles say) with no browser
// and no dependency. Nothing here copies page logic: the script under test is read from disk and
// evaluated unchanged. Only its one `import` line is replaced by the real tracker-lib exports,
// because Node cannot resolve the root-absolute browser path /assets/lib/tracker-lib.js.
//
// The fake network follows what the live services did when measured on 2026-10-09 and 2026-10-24:
//  - StratumX pool API: POST /miners/batch, GET /pool/blocks, /pool/shares, /miner/hashrate/history. Periods are 1h, 24h
//    and 7d; any other period (30d) is refused with a 400, like the real API.
//  - Quai Cyprus-1 JSON-RPC: a JSON-RPC 2.0 envelope, hex-quantity results, eth_call returns one 32-byte
//    word, quai_getBalance refuses a non-checksummed address ("address has invalid checksum", -32000)
//    while quai_getLockedBalance accepts any casing, eth_getLogs also needs checksummed addresses and refuses a
//    range over 10,000 blocks, unknown methods answer -32601.
//  - The RPC's WebSocket: quai_subscribe answers with a subscription id; the test pushes newHeads and logs.
// All fixture data is synthetic: no live capture, no real worker name, no real wallet.
//
// The node's checksum rule needs keccak, which Node does not ship. This harness is strict in the same direction
// with a table instead: an address is accepted by quai_getBalance, eth_call and eth_getLogs only in the exact spelling
// listed in KNOWN_CHECKSUMMED, so a lowercase or wrongly cased address is refused the way the real node refuses it.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as trackerLib from '../../src/lib/tracker-lib.js';
import { renderTracker } from '../../src/page.mjs';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const TRACKER_JS = path.join(ROOT, 'assets', 'tracker.js');
export const CONFIG = JSON.parse(await readFile(path.join(ROOT, 'config.example.json'), 'utf8'));

/** Fixed clock for fixtures (2026-10-05 12:00 UTC); nothing in the fixtures depends on the real now. */
export const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const DEFAULT_ADDR = CONFIG.trackedAddresses[0];
/** A synthetic address (already on the scanner's allowlist), in its checksummed spelling. */
export const OTHER_ADDR = '0x00AAAaaAAAaaaAaAAaAaAaAaaaAAAAaAAAAAaaAA';
const KNOWN_CHECKSUMMED = new Set([DEFAULT_ADDR, OTHER_ADDR, CONFIG.vault]);
/** The address the fake page believes it is served from (assembled, so the file carries no literal link). */
export const PAGE_URL = ['https', '://', 'tracker.example', '/tracker/'].join('');
const iso = (ms) => new Date(ms).toISOString();
const resolve = (v, arg, extra) => (typeof v === 'function' ? v(arg, extra) : v);
const RealDate = Date;

/** A pool-API / RPC world with plausible, fully synthetic data. Every field may be a value or a function of the request. */
export function defaultWorld(overrides = {}) {
  const worker = (name, over) => ({
    workerName: `${DEFAULT_ADDR}.${name}`, algorithm: 'sha256', hashrate: 4.6e12,
    sharesValid: 20000, sharesStale: 3, sharesInvalid: 1,
    lastShareAt: iso(T0 - 20_000), isConnected: true, connectedAt: iso(T0 - HOUR),
    difficulty: '1', nodeName: 'node-1', address: DEFAULT_ADDR, ...over,
  });
  const found = (hoursAgo, name) => ({
    height: 10_500_000 + hoursAgo, hash: '0x' + String(hoursAgo).padStart(64, '0'), worker: `${DEFAULT_ADDR}.${name}`,
    algorithm: 'sha256', difficulty: '123456', foundAt: iso(T0 - hoursAgo * HOUR), nodeName: 'node-1',
  });
  const histPoints = (period) => {
    const n = period === '1h' ? 61 : period === '7d' ? 337 : 289;
    const span = period === '1h' ? HOUR : period === '7d' ? 7 * DAY : DAY;
    return Array.from({ length: n }, (_, i) => ({ timestamp: iso(T0 - span + (i * span) / (n - 1)), hashrate: 6e12 + 3.55e12 * Math.abs(Math.sin(i / 20)), workers: 2 }));
  };
  const share = (minAgo, luck) => ({ achievedDifficulty: 10, algorithm: 'sha256', isBlock: true, luckPercent: luck, timestamp: iso(T0 - minAgo * 60_000), worker: `${DEFAULT_ADDR}.rig-a.sha256`, workshareDiff: 5 });
  return {
    head: 10_783_200,
    miners: () => ({
      stats: { workersTotal: 2, workersConnected: 1, hashrateSha: 9.29e12, hashrateScrypt: 0, hashrateKawpow: 0, sharesValid: 33485, sharesStale: 0, sharesInvalid: 0 },
      workers: [worker('rig-a', {}), worker('rig-b', { isConnected: false, hashrate: 0, sharesValid: 13485, sharesStale: 0, sharesInvalid: 0 })],
    }),
    blocks1h: () => [],
    blocks24h: () => [found(3, 'rig-a'), found(9, 'rig-a')],
    // The oldest workshare is 5 days before T0, so the unlock estimate is T0 + 9 days.
    blocks7d: () => [found(1, 'rig-a'), found(48, 'rig-b'), found(120, 'rig-a')],
    shares: (addrs, period) => ({
      bestShareLuck: 824.1, averageLuck: 0.9, totalShares: 1000, expectedShares: 900, blocksFound: 2, workshareDiff: '1',
      shares: period === '7d' ? [share(60, 120.5), share(2000, 3000), share(5000, 40)] : [share(60, 120.5), share(600, 0.4)],
    }),
    history: (addrs, period) => ({ period, points: histPoints(period) }),
    rpc: { locked: 449_130_400_000_000_000_000n, balance: 10_493_800_000_000_000_000n, burned: 33_442n * 10n ** 18n },
    // eth_getLogs: (filter) => [log, ...]; blockTime: (blockNumber) => epoch seconds
    logs: () => [],
    blockTime: (n) => Math.floor(T0 / 1000) + (n - 10_783_000) * 3,
    ...overrides,
  };
}

function makeEl(id, tag = 'div') {
  const el = {
    id, tagName: tag.toUpperCase(), textContent: '', value: '', className: '', style: {}, children: [], listeners: {}, svg: null, _html: '', attrs: {}, hidden: false,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; this.svg = null; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    querySelector(sel) { return sel === 'svg' && this._html.includes('<svg') ? (this.svg ||= makeEl('', 'svg')) : null; },
    querySelectorAll(sel) { const n = this.querySelector(sel); return n ? [n] : []; },
    select() { this.selected = true; },
    remove() {},
    getBoundingClientRect() { return { left: 0, width: 960 }; },
  };
  return el;
}

/**
 * Start the real tracker page logic. Returns handles to look at the DOM, the requests and the clock.
 * `extra` is what the quaiaxe.com build passes to renderTracker (feed, embedUrl, card); `ws: false` hides WebSocket.
 */
export async function startTracker({ lang = 'en', world = defaultWorld(), config = CONFIG, extra = {}, ws = true, now = T0, clipboard = true, share = false } = {}) {
  const html = renderTracker(lang, config, extra);
  const els = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], makeEl(m[1])]));
  for (const id of ['trk-i18n', 'trk-config', 'trk-data']) {
    const block = html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`));
    if (!block) { if (id === 'trk-data') { els.delete(id); continue; } throw new Error(`harness: the template has no #${id} data block`); }
    els.get(id).textContent = block[1];
  }

  for (const m of html.matchAll(/<textarea[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    els.get(m[1]).value = m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  const clock = { now };
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(clock.now); }
    static now() { return clock.now; }
  }

  const calls = [];
  const apiBase = new URL(config.stratumxApi);
  const rpcUrl = new URL(config.rpc);
  const hex = (n) => '0x' + n.toString(16);
  const rpcReply = (req) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: req.id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
    const qty = (n) => '0x' + n.toString(16);
    const strict = (a) => typeof a === 'string' && KNOWN_CHECKSUMMED.has(a);
    switch (req.method) {
      case 'quai_getLockedBalance':
        if (req.params.length !== 1) return err(-32602, 'invalid number of params');
        return ok(qty(resolve(world.rpc.locked, req.params[0])));
      case 'quai_getBalance':
        if (req.params.length !== 2 || req.params[1] !== 'latest') return err(-32602, 'invalid params');
        if (!strict(req.params[0])) return err(-32000, 'address has invalid checksum');
        return ok(qty(resolve(world.rpc.balance, req.params[0])));
      case 'eth_call': {
        const [callObj, tag] = req.params;
        if (tag !== 'latest' || !strict(callObj.to)) return err(-32000, 'address has invalid checksum');
        if (callObj.data !== '0xd157e301') return err(-32000, 'execution reverted');
        return ok('0x' + world.rpc.burned.toString(16).padStart(64, '0'));
      }
      case 'quai_blockNumber':
        if (req.params.length !== 0) return err(-32602, 'invalid params');
        return ok(hex(resolve(world.head)));
      case 'quai_getHeaderByNumber': {
        if (req.params.length !== 1 || !/^0x[0-9a-f]+$/.test(req.params[0])) return err(-32602, 'invalid params');
        return ok({ woHeader: { number: req.params[0], timestamp: hex(resolve(world.blockTime, Number(BigInt(req.params[0])))) } });
      }
      case 'eth_getLogs': {
        const f = req.params && req.params[0];
        if (!f || !strict(f.address)) return err(-32000, 'address has invalid checksum');
        if (!/^0x[0-9a-f]+$/.test(f.fromBlock) || !/^0x[0-9a-f]+$/.test(f.toBlock)) return err(-32602, 'invalid block range');
        if (Number(BigInt(f.toBlock) - BigInt(f.fromBlock)) >= 10_000) return err(-32000, 'query returned more than 10000 results or range too large');
        if (!Array.isArray(f.topics)) return err(-32602, 'invalid topics');
        for (const t of f.topics.flat()) if (t != null && !/^0x[0-9a-f]{64}$/.test(t)) return err(-32602, 'invalid topic');
        return ok(resolve(world.logs, f));
      }
      default:
        return err(-32601, `the method ${req.method} does not exist/is not available`);
    }
  };
  async function fetch(input, opts = {}) {
    const url = new URL(String(input));
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(input), origin: url.origin, path: url.pathname, method, body });
    let data = null;
    if (url.origin === rpcUrl.origin && url.pathname === rpcUrl.pathname) {
      data = method === 'POST' ? rpcReply(body) : null;
    } else if (url.origin === apiBase.origin && url.pathname.startsWith(apiBase.pathname)) {
      const route = url.pathname.slice(apiBase.pathname.length);
      const period = url.searchParams.get('period');
      const addrs = (url.searchParams.get('addresses') || '').split(',').filter(Boolean);
      const needsPeriod = route === '/pool/blocks' || route === '/pool/shares' || route === '/miner/hashrate/history';
      if (needsPeriod && !['1h', '24h', '7d'].includes(period)) return { ok: false, status: 400, json: async () => { throw new Error('invalid period, must be 1h, 24h, or 7d'); } };
      if (route === '/miners/batch' && method === 'POST') data = resolve(world.miners, body.addresses);
      else if (route === '/pool/blocks') data = resolve(period === '7d' ? world.blocks7d : period === '1h' ? world.blocks1h : world.blocks24h, addrs, period);
      else if (route === '/pool/shares') data = resolve(world.shares, addrs, period);
      else if (route === '/miner/hashrate/history') data = resolve(world.history, addrs, period);
    }
    if (data == null) return { ok: false, status: 503, json: async () => { throw new Error('no body'); } };
    return { ok: true, status: 200, json: async () => data };
  }

  // ---- the RPC WebSocket ----
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = String(url); this.readyState = 0; this.sent = []; this.subs = new Map(); this.closed = false;
      sockets.push(this);
    }
    send(data) {
      const req = JSON.parse(data);
      this.sent.push(req);
      if (req.method === 'quai_subscribe') {
        const id = `0x${(this.subs.size + 1).toString(16).padStart(32, '0')}`;
        this.subs.set(id, req.params);
        this.onmessage && this.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: id }) });
      }
    }
    close() { this.closed = true; this.readyState = 3; this.onclose && this.onclose({ code: 1000 }); }
  }

  const timeouts = [];
  const intervals = [];
  const docListeners = {};
  const copied = [];
  const shared = [];
  const document = {
    documentElement: { lang }, hidden: false,
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    getElementById: (id) => els.get(id) || null,
    createElement: (tag) => makeEl('', tag),
    execCommand: () => true,
  };

  const source = await readFile(TRACKER_JS, 'utf8');
  const importRe = /^import\s*\{([^}]*)\}\s*from\s*'\/assets\/lib\/tracker-lib\.js';[ \t]*$/m;
  const imp = source.match(importRe);
  if (!imp) throw new Error('harness: assets/tracker.js no longer imports /assets/lib/tracker-lib.js the expected way');
  const sandbox = {
    document, fetch, Date: FakeDate,
    location: { href: PAGE_URL },
    setInterval: (fn, ms) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; },
    clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms, cleared: false }); return timeouts.length; },
    clearTimeout: (id) => { if (timeouts[id - 1]) timeouts[id - 1].cleared = true; },
  };
  if (ws) sandbox.WebSocket = FakeWebSocket;
  if (clipboard || share) {
    sandbox.navigator = {};
    if (clipboard) sandbox.navigator.clipboard = { writeText: async (t) => { copied.push(t); } };
    if (share) sandbox.navigator.share = async (d) => { shared.push(d); };
  }
  for (const name of imp[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(name in trackerLib)) throw new Error(`harness: tracker.js imports ${name}, which tracker-lib does not export`);
    sandbox[name] = trackerLib[name];
  }
  vm.runInContext(source.replace(importRe, ''), vm.createContext(sandbox), { filename: 'assets/tracker.js' });

  const rpcOrigin = rpcUrl.origin;
  const page = {
    html, world, calls, intervals, sockets, copied, shared, clock, sandbox,
    el: (id) => els.get(id),
    text: (id) => els.get(id).textContent,
    i18n: JSON.parse(els.get('trk-i18n').textContent),
    rpcCalls: (method) => calls.filter((c) => c.origin === rpcOrigin && c.path === rpcUrl.pathname && (!method || c.body.method === method)),
    stratumCalls: () => calls.filter((c) => c.origin === apiBase.origin),
    clearCalls: () => { calls.length = 0; },
    async settle() { for (let i = 0; i < 25; i += 1) await new Promise((r) => setImmediate(r)); },
    /** Fire the 30 s poll once, as the browser timer would. */
    async tick() { for (const t of intervals.filter((x) => !x.cleared && x.ms === 30000)) t.fn(); await page.settle(); },
    /** Fire the 10 s fast poll once. */
    async fastTick() { for (const t of intervals.filter((x) => !x.cleared && x.ms === 10000)) t.fn(); await page.settle(); },
    /** Run the pending setTimeout callbacks (reconnects). */
    async flushTimers() { const due = timeouts.filter((x) => !x.cleared && !x.ran); for (const t of due) { t.ran = true; t.fn(); } await page.settle(); },
    /** Type an address into section 06 and press the button. */
    async check(address) {
      els.get('trk-check-addr').value = address;
      for (const fn of els.get('trk-check-go').listeners.click || []) fn({});
      await page.settle();
    },
    async click(id) { for (const fn of els.get(id).listeners.click || []) await fn({ target: els.get(id) }); await page.settle(); },
    /** Open the newest fake WebSocket, as the browser does when the connection is made. */
    async wsOpen(i = sockets.length - 1) { const s = sockets[i]; s.readyState = 1; s.onopen && s.onopen({}); await page.settle(); return s; },
    /** Push a subscription message: kind is 'newHeads' or the index of the logs subscription. */
    async wsPush(result, which, i = sockets.length - 1) {
      const s = sockets[i];
      const entries = [...s.subs.entries()];
      const [id] = which === 'newHeads' ? entries.find(([, p]) => p[0] === 'newHeads') : entries.filter(([, p]) => p[0] === 'logs')[which];
      s.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', method: 'quai_subscription', params: { subscription: id, result } }) });
      await page.settle();
    },
    async wsClose(i = sockets.length - 1) { const s = sockets[i]; s.readyState = 3; s.onclose && s.onclose({ code: 1006 }); await page.settle(); },
    hidden(value) { document.hidden = value; for (const fn of docListeners.visibilitychange || []) fn({}); },
  };
  await page.settle();
  return page;
}
