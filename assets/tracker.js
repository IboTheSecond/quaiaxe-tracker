/**
 * assets/tracker.js — the /tracker page. Live workers + hashrate + shares from StratumX's public
 * pool API, workshares from the Quai chain (as reported by StratumX), hashrate and workshare-luck charts with
 * range tabs (1h / 24h / 7d, the periods StratumX accepts), locked/unlocked QUAI read straight from rpc.quai.network
 * in the visitor's browser, and the mining burn figure (QaxeBurnVault.totalTokensBurned(), read on-chain; never a
 * combined burn total). When the page build supplies the fee-loop data block, it also shows the QuaiAxe fee loop
 * (buybacks with their half-burn) and a live feed of mining burns, buys and burns from the chain: pushed over the
 * RPC's WebSocket when that works, polled otherwise. Every section fails gracefully to an "unavailable" state per
 * source — nothing here is ever invented. A 30 s cycle refreshes everything while the tab is visible and a 10 s poll
 * picks up new workshares; both pause while it is hidden.
 *
 * Third-party text and numbers are validated or escaped in tracker-lib.js before they reach innerHTML or a link.
 * Mining (burn vault) burns and fee-loop burns are separate figures with separate painters: nothing adds them.
 */
import {
  formatHashrate, agoParts, checksumAddress, safeBlockHeight, safeCount, escapeHtml, isTrackerRange, parseHistory, parseShares,
  shortAddress, topWorkers, scheduleByDay, FEED_TOPICS, decodeSwept, decodeTransferLog, formatWei, pairBurns, mergeRows,
  summarizeFeedLoop, feeLoopRowHtml, burnSeries, weiString, txUrl, utcDate,
} from '/assets/lib/tracker-lib.js';

const $ = (id) => document.getElementById(id);
const i18nEl = $('trk-i18n');
const configEl = $('trk-config');
if (i18nEl && configEl) {
  const I18N = JSON.parse(i18nEl.textContent);
  const CONFIG = JSON.parse(configEl.textContent);
  const dataEl = $('trk-data');
  let DATA = null;
  try { DATA = dataEl ? JSON.parse(dataEl.textContent) : null; } catch (e) { DATA = null; }
  const FEED = DATA && DATA.feed && typeof DATA.feed === 'object' ? DATA.feed : null;
  const lang = document.documentElement.lang === 'tr' ? 'tr' : 'en';
  const isTr = lang === 'tr';
  const loc = isTr ? 'tr-TR' : 'en-US';
  const nf = (n, d) => Number(n).toLocaleString(loc, { minimumFractionDigits: d, maximumFractionDigits: d });
  const API = CONFIG.stratumxApi || 'https://backend.stratumx.org/api';
  const RPC = CONFIG.rpc || 'https://rpc.quai.network/cyprus1';
  const WSS = RPC.replace(/^https:/, 'wss:');
  const SLOW_MS = 30000;
  const FAST_MS = 10000;
  const LOG_SPAN = 9998; // blocks after the first in one eth_getLogs range: under the RPC's 10,000 block limit
  const MAX_CHUNKS = 4;
  const MAX_EVENTS = 14;
  const STRIP_CELLS = 48;

  const DEFAULT_ADDRESSES = (CONFIG.trackedAddresses || []).slice();
  let addresses = DEFAULT_ADDRESSES.slice();
  let hrRange = '24h';
  let wsRange = '24h';

  async function getJSON(url, opts) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  async function rpcCall(method, params) {
    const j = await getJSON(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return j && !j.error ? j.result : null;
  }

  function setText(id, text) { const n = $(id); if (n) n.textContent = text; }

  function agoText(ms) {
    const p = agoParts(ms);
    if (p.unit === 'now') return isTr ? 'az önce' : 'just now';
    const unitWord = { min: isTr ? 'dk önce' : 'min ago', hour: isTr ? 'sa önce' : 'hr ago', day: isTr ? 'gün önce' : 'd ago' }[p.unit];
    return `${p.n} ${unitWord}`;
  }

  const hexq = (n) => `0x${n.toString(16)}`;
  const pageNow = () => Date.now();

  // One page-wide generation per refresh (and per address change): an older response never repaints newer state.
  let refreshGeneration = 0;
  const currentSnapshot = () => {
    const generation = refreshGeneration;
    return { addresses: [...addresses], current: () => generation === refreshGeneration };
  };
  // A chart also has its own token: choosing another range makes the earlier range's answer stale.
  const chartToken = { hr: 0, ws: 0 };
  function scoped(kind, base) {
    chartToken[kind] += 1;
    const mine = chartToken[kind];
    return { addresses: base.addresses, current: () => base.current() && chartToken[kind] === mine };
  }

  // ---------- live feed list (workshares, mining burns, fee-loop buys and burns) ----------
  const feedItems = [];
  function queueEvent(kind, text, link, whenMs) {
    feedItems.unshift({ kind, text, link, whenMs, fresh: true });
    if (feedItems.length > MAX_EVENTS) feedItems.length = MAX_EVENTS;
  }
  function renderFeed() {
    const list = $('trk-feed');
    if (!list) return;
    if (!feedItems.length) { list.innerHTML = `<li class="trk-feed-empty" id="trk-feed-empty">${escapeHtml(I18N['tracker.feed.empty'])}</li>`; return; }
    list.innerHTML = feedItems.map((e) => {
      const href = e.link ? ` <a href="${e.link}" target="_blank" rel="noopener">↗</a>` : '';
      const when = Number.isFinite(e.whenMs) ? agoText(pageNow() - e.whenMs) : '—';
      return `<li class="trk-ev trk-ev-${e.kind}${e.fresh ? ' trk-tick' : ''}"><b>${escapeHtml(I18N[`tracker.feed.kind.${e.kind}`])}</b><span>${escapeHtml(e.text)}${href}</span><time>${escapeHtml(when)}</time></li>`;
    }).join('');
    for (const e of feedItems) e.fresh = false;
  }

  // ---------- chart drawing ----------
  const CW = 960, CH = 220, PAD = 28;
  const xAt = (i, n) => PAD + (i / Math.max(1, n - 1)) * (CW - PAD * 2);
  const gridLines = () => [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gy = (PAD + f * (CH - PAD * 2)).toFixed(1);
    return `<line class="trk-grid" x1="${PAD}" y1="${gy}" x2="${CW - PAD}" y2="${gy}"/>`;
  }).join('');
  // Axis labels as HTML over the stretched SVG (text inside a preserveAspectRatio="none" SVG would
  // distort). Their look is in site.css (.chart .lab). Only the computed position is set here, through the
  // CSSOM (el.style.top = ...), which the page's style-src 'self' allows; an inline style attribute it would not.
  function label(cls, text, pos) {
    const n = document.createElement('span');
    n.className = `lab ${cls}`;
    n.textContent = text;
    Object.assign(n.style, pos);
    return n;
  }
  const yLabel = (f, text) => label('lab-y', text, { top: `calc(${((PAD + f * (CH - PAD * 2)) / CH * 100).toFixed(2)}% - 8px)` });
  const xLabel = (pct, text, align) => label('lab-x', text, { left: `${pct}%`, transform: `translateX(${align})` });
  const xLabels = (first, mid, last) => [
    xLabel((PAD / CW * 100).toFixed(2), first, '0'), xLabel(50, mid, '-50%'), xLabel(((CW - PAD) / CW * 100).toFixed(2), last, '-100%'),
  ];
  const axisFormat = (range) => (range === '7d' ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
  const stamp = (t, range) => new Date(t).toLocaleString(loc, axisFormat(range));
  const stampFull = (t) => new Date(t).toLocaleString(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function mountChart(wrap, svgInner, labels) {
    wrap.innerHTML = `<svg viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="none" role="presentation">${svgInner}</svg>`;
    labels.forEach((n) => wrap.appendChild(n));
    return wrap.querySelector('svg');
  }
  function bindReadout(svg, readoutId, xs, text) {
    const readout = $(readoutId);
    if (!svg || !readout) return;
    svg.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const rx = (ev.clientX - rect.left) / rect.width * CW;
      let nearest = 0, best = Infinity;
      xs.forEach((x, i) => { const d = Math.abs(x - rx); if (d < best) { best = d; nearest = i; } });
      readout.textContent = text(nearest);
    });
    svg.addEventListener('pointerleave', () => { readout.textContent = ' '; });
  }
  function chartMessage(wrapId, statusId, readoutId, text) {
    const wrap = $(wrapId);
    if (wrap) wrap.innerHTML = '';
    setText(statusId, text);
    if (readoutId) setText(readoutId, '');
  }

  function drawHashrate(wrap, points, range) {
    const values = points.map((p) => p.hashrate);
    const max = values.reduce((current, value) => Math.max(current, value), 1);
    const y = (v) => CH - PAD - (v / (max || 1)) * (CH - PAD * 2);
    const x = (i) => xAt(i, points.length);
    const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${path} L${x(values.length - 1).toFixed(1)},${(CH - PAD).toFixed(1)} L${x(0).toFixed(1)},${(CH - PAD).toFixed(1)} Z`;
    const mid = points[Math.floor((points.length - 1) / 2)];
    const svg = mountChart(wrap, `${gridLines()}<path class="trk-area" d="${area}"/><path class="trk-ln" d="${path}"/>`, [
      yLabel(0, formatHashrate(max)), yLabel(0.5, formatHashrate(max / 2)), yLabel(1, formatHashrate(0)),
      ...xLabels(stamp(points[0].t, range), stamp(mid.t, range), stamp(points[points.length - 1].t, range)),
    ]);
    bindReadout(svg, 'trk-chart-readout', points.map((p, i) => x(i)), (i) => `${stamp(points[i].t, range)} — ${formatHashrate(points[i].hashrate)}`);
  }

  // luck on a log scale: a handful of lucky workshares would flatten everything else on a linear one
  function drawLuck(wrap, shares, range) {
    const max = shares.reduce((m, s) => Math.max(m, s.luck), 0);
    const top = Math.log10(1 + max) || 1;
    const t0 = shares[0].t, t1 = shares[shares.length - 1].t;
    const x = (s) => (t1 > t0 ? PAD + ((s.t - t0) / (t1 - t0)) * (CW - PAD * 2) : CW / 2);
    const y = (s) => CH - PAD - (Math.log10(1 + s.luck) / top) * (CH - PAD * 2);
    const hotAt = shares.findIndex((s) => s.luck === max);
    const marks = shares.map((s, i) => `<rect class="trk-pt${i === hotAt ? ' hot' : ''}" x="${(x(s) - 3).toFixed(1)}" y="${(y(s) - 3).toFixed(1)}" width="6" height="6"/>`).join('');
    const mid = shares[Math.floor((shares.length - 1) / 2)];
    const svg = mountChart(wrap, gridLines() + marks, [
      yLabel(0, `${nf(max, 0)}%`), yLabel(1, '0%'), ...xLabels(stamp(t0, range), stamp(mid.t, range), stamp(t1, range)),
    ]);
    bindReadout(svg, 'trk-luck-readout', shares.map(x), (i) => `${stampFull(shares[i].t)} — ${nf(shares[i].luck, 1)}% luck`);
  }

  // ---------- section 01: live miners, top rigs ----------
  const MINER_IDS = ['trk-online', 'trk-total', 'trk-hr-sha', 'trk-hr-scrypt', 'trk-hr-kawpow', 'trk-sh-valid', 'trk-sh-stale', 'trk-sh-invalid', 'trk-p-hr'];
  function minerBatchValid(batch) {
    const s = batch && batch.stats;
    const count = (n) => Number.isSafeInteger(n) && n >= 0;
    const rate = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    return s && typeof s === 'object' && !Array.isArray(s) && Array.isArray(batch.workers)
      && ['workersConnected', 'workersTotal', 'sharesValid', 'sharesStale', 'sharesInvalid'].every((key) => count(s[key]))
      && ['hashrateSha', 'hashrateScrypt', 'hashrateKawpow'].every((key) => rate(s[key]));
  }
  function minersUnavailable() {
    for (const id of MINER_IDS) setText(id, I18N['tracker.unavailable']);
    const body = $('trk-workers-body');
    if (body) body.innerHTML = `<tr><td colspan="6">${I18N['tracker.unavailable']}</td></tr>`;
    const top = $('trk-top-body');
    if (top) top.innerHTML = `<tr><td colspan="6">${I18N['tracker.unavailable']}</td></tr>`;
  }
  async function refreshMiners(snapshot) {
    const j = await getJSON(`${API}/miners/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: snapshot.addresses }),
    });
    if (!snapshot.current()) return;
    if (!minerBatchValid(j)) { minersUnavailable(); return; }
    const s = j.stats;
    setText('trk-online', String(s.workersConnected ?? '—'));
    setText('trk-total', String(s.workersTotal ?? '—'));
    setText('trk-hr-sha', formatHashrate(s.hashrateSha));
    setText('trk-hr-scrypt', formatHashrate(s.hashrateScrypt));
    setText('trk-hr-kawpow', formatHashrate(s.hashrateKawpow));
    setText('trk-p-hr', formatHashrate(s.hashrateSha + s.hashrateScrypt + s.hashrateKawpow));
    setText('trk-sh-valid', String(s.sharesValid ?? '—'));
    setText('trk-sh-stale', String(s.sharesStale ?? '—'));
    setText('trk-sh-invalid', String(s.sharesInvalid ?? '—'));

    const workers = (Array.isArray(j.workers) ? j.workers : []).filter((w) => w && typeof w === 'object');
    const body = $('trk-workers-body');
    if (body) {
      if (!workers.length) {
        body.innerHTML = `<tr><td colspan="6">${I18N['tracker.table.empty']}</td></tr>`;
      } else {
        const now = Date.now();
        body.innerHTML = workers.map((w) => {
          const nick = (w.workerName || '').replace(/^0x[0-9a-fA-F]{40}\.?/, '') || '—';
          const last = w.lastShareAt ? agoText(now - Date.parse(w.lastShareAt)) : '—';
          const status = w.isConnected ? I18N['tracker.status.online'] : I18N['tracker.status.offline'];
          // The share counters are third-party numbers going into innerHTML: coerce them like b.height below.
          return `<tr><td>${escapeHtml(nick)}</td><td>${escapeHtml(String(w.algorithm || '—'))}</td>` +
            `<td>${formatHashrate(w.hashrate)}</td>` +
            `<td>${safeCount(w.sharesValid)}/${safeCount(w.sharesStale)}/${safeCount(w.sharesInvalid)}</td>` +
            `<td>${last}</td>` +
            `<td><span class="dot ${w.isConnected ? 'on' : 'off'}"></span> ${status}</td></tr>`;
        }).join('');
      }
    }
    // Top rigs: the busiest workers of the tracked address(es) by hashrate. Names are miner-typed text (escaped);
    // an address link only for a well formed address. This is not the whole StratumX pool.
    const rigs = topWorkers(workers, Infinity).filter((r) => r.hashrate > 0);
    const total = rigs.reduce((sum, r) => sum + r.hashrate, 0);
    const top = $('trk-top-body');
    if (top) {
      top.innerHTML = rigs.length ? rigs.slice(0, 8).map((r, i) => {
        const miner = r.address ? `<a href="https://quaiscan.io/address/${r.address}" target="_blank" rel="noopener">${shortAddress(r.address)}</a>` : '—';
        const share = total > 0 ? `${nf(r.hashrate / total * 100, 1)}%` : '—';
        return `<tr><td>${i + 1}</td><td>${escapeHtml(r.nick)}</td><td>${miner}</td><td>${escapeHtml(r.algorithm)}</td><td>${formatHashrate(r.hashrate)}</td><td>${share}</td></tr>`;
      }).join('') : `<tr><td colspan="6">${I18N['tracker.top.empty']}</td></tr>`;
    }
  }

  // ---------- section 03: workshares (table, counts, unlock schedule), the furnace strip ----------
  const wsKey = (b) => `${typeof b.hash === 'string' ? b.hash : ''}:${safeBlockHeight(b.height)}:${typeof b.foundAt === 'string' ? b.foundAt : ''}`;
  const wsTime = (b) => Date.parse(b.foundAt);
  const validWs = (b) => b && typeof b === 'object' && Number.isFinite(wsTime(b));
  let seeded = false;
  const knownWs = new Set();
  let wsList = []; // newest first, at most 50: what the workshare table shows
  let stripItems = []; // oldest first, at most STRIP_CELLS
  let ws24h = null;

  function wsRowHtml(b, fresh) {
    const nick = (b.worker || '').split('.').slice(1).join('.') || b.worker || '—';
    const time = new Date(b.foundAt).toLocaleString(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    // b.height is a third-party API field (StratumX). Coerce to a plain non-negative integer
    // before it ever reaches an href or innerHTML — a malformed/hostile value collapses to
    // 0 rather than being interpolated as markup (e.g. into the href, which escapeHtml alone
    // would not make safe against a javascript: or data: URL).
    const height = safeBlockHeight(b.height);
    return `<tr${fresh ? ' class="trk-tick"' : ''}><td><a href="https://quaiscan.io/block/${height}" target="_blank" rel="noopener">${height} ${escapeHtml(I18N['tracker.workshares.viewblock'])}</a></td>` +
      `<td>${escapeHtml(time)}</td><td>${escapeHtml(nick)}</td><td>${escapeHtml(String(b.algorithm || '—'))}</td></tr>`;
  }
  function renderWsTable(freshKeys) {
    const body = $('trk-ws-body');
    if (!body) return;
    body.innerHTML = wsList.map((b) => wsRowHtml(b, freshKeys.has(wsKey(b)))).join('');
  }
  function paintCounts() {
    if (ws24h == null) return;
    setText('trk-ws-24h', String(ws24h));
    setText('trk-p-ws', String(ws24h));
  }
  // The furnace strip: the last 48 workshares, newest on the right; the fresher, the hotter. Real workshares only.
  function paintStrip(freshKeys) {
    const strip = $('trk-strip');
    if (!strip) return;
    const now = pageNow();
    const cells = new Array(STRIP_CELLS).fill('');
    const shown = stripItems.slice(-STRIP_CELLS);
    shown.forEach((it, i) => {
      const age = now - it.t;
      const heat = age < 60000 ? 'fresh' : age < 300000 ? 'h1' : age < 1200000 ? 'h2' : 'share';
      cells[STRIP_CELLS - shown.length + i] = `${heat}${freshKeys.has(it.key) ? ' trk-tick' : ''}`;
    });
    strip.innerHTML = cells.map((c) => (c ? `<i class="${c}"></i>` : '<i></i>')).join('');
  }
  function renderSchedule(blocks7d) {
    const body = $('trk-schedule-body');
    if (!body) return;
    if (!Array.isArray(blocks7d)) { body.innerHTML = `<tr><td colspan="3">${I18N['tracker.unavailable']}</td></tr>`; return; }
    const rows = scheduleByDay(blocks7d);
    body.innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${r.day}</td><td>${r.count}</td><td>${r.unlockDay}</td></tr>`).join('')
      : `<tr><td colspan="3">${I18N['tracker.schedule.empty']}</td></tr>`;
  }

  async function refreshWorkshares(snapshot) {
    const addrParam = encodeURIComponent(snapshot.addresses.join(','));
    const [blocks24h, blocks7d] = await Promise.all([
      getJSON(`${API}/pool/blocks?addresses=${addrParam}&period=24h`),
      getJSON(`${API}/pool/blocks?addresses=${addrParam}&period=7d`),
    ]);
    if (!snapshot.current()) return null;

    ws24h = Array.isArray(blocks24h) ? blocks24h.length : null;
    if (ws24h == null) { setText('trk-ws-24h', I18N['tracker.unavailable']); setText('trk-p-ws', I18N['tracker.unavailable']); } else paintCounts();

    // 7-day workshare count. (StratumX's averageLuck averages every tiny share, not workshares, so it
    // read as a misleading "0.9%" — replaced 2026-09-27.)
    setText('trk-luck-avg', Array.isArray(blocks7d) ? String(blocks7d.length) : I18N['tracker.unavailable']);

    // What is already known is not "new": the first look at an address only fills the lists; the 10 s poll announces the rest.
    for (const list of [blocks24h, blocks7d]) for (const b of Array.isArray(list) ? list : []) if (validWs(b)) knownWs.add(wsKey(b));
    if (Array.isArray(blocks24h)) seeded = true;
    if (Array.isArray(blocks24h)) {
      stripItems = blocks24h.filter(validWs).map((b) => ({ t: wsTime(b), key: wsKey(b) })).sort((a, b) => a.t - b.t).slice(-STRIP_CELLS);
      paintStrip(new Set());
    }

    // Start from "no estimate" on every pass. A failed fetch or an empty list must not leave the previous
    // address's (or the previous cycle's) earliest workshare behind to drive the "next unlock" tile.
    let earliestShareMs = null;
    const body = $('trk-ws-body');
    if (!Array.isArray(blocks7d)) {
      wsList = [];
      if (body) body.innerHTML = `<tr><td colspan="4">${I18N['tracker.unavailable']}</td></tr>`;
    } else if (!blocks7d.length) {
      wsList = [];
      if (body) body.innerHTML = `<tr><td colspan="4">${I18N['tracker.workshares.table.empty']}</td></tr>`;
    } else {
      const sorted = blocks7d.slice().sort((a, b) => Date.parse(b.foundAt) - Date.parse(a.foundAt));
      earliestShareMs = sorted.length ? Date.parse(sorted[sorted.length - 1].foundAt) : null;
      wsList = sorted.slice(0, 50);
      renderWsTable(new Set());
    }
    renderSchedule(blocks7d);
    // paintRewards() is not called here: refreshAll() runs it once, after this resolves and
    // earliestShareMs is set. A second call would read every balance and the burn vault twice per cycle.
    return earliestShareMs;
  }

  // The 10 s poll: only the last hour, to catch new workshares as they are found.
  async function fastWorkshares(snapshot) {
    const j = await getJSON(`${API}/pool/blocks?addresses=${encodeURIComponent(snapshot.addresses.join(','))}&period=1h`);
    if (!snapshot.current() || !Array.isArray(j) || !seeded) return;
    const fresh = j.filter((b) => validWs(b) && !knownWs.has(wsKey(b))).sort((a, b) => wsTime(a) - wsTime(b));
    if (!fresh.length) { paintStrip(new Set()); return; } // ages move on, and an earlier tick animation is not replayed
    const freshKeys = new Set();
    for (const b of fresh) {
      const key = wsKey(b);
      knownWs.add(key);
      freshKeys.add(key);
      const nick = (b.worker || '').split('.').slice(1).join('.') || b.worker || '—';
      queueEvent('ws', I18N['tracker.feed.ws'].replace('{who}', nick).replace('{n}', nf(safeBlockHeight(b.height), 0)), null, wsTime(b));
      wsList.unshift(b);
      stripItems.push({ t: wsTime(b), key });
    }
    wsList = wsList.slice(0, 50);
    stripItems = stripItems.slice(-STRIP_CELLS);
    if (ws24h != null) ws24h += fresh.length;
    renderWsTable(freshKeys);
    paintStrip(freshKeys);
    paintCounts();
    renderFeed();
  }

  // ---------- section 02: hashrate chart with range tabs ----------
  async function refreshHashrate(snapshot) {
    const range = hrRange;
    const j = await getJSON(`${API}/miner/hashrate/history?addresses=${encodeURIComponent(snapshot.addresses.join(','))}&period=${range}`);
    if (!snapshot.current()) return;
    const wrap = $('trk-chart');
    if (!wrap) return;
    const points = parseHistory(j);
    if (points == null) { chartMessage('trk-chart', 'trk-chart-status', 'trk-chart-readout', I18N['tracker.unavailable']); return; }
    if (!points.length) { chartMessage('trk-chart', 'trk-chart-status', null, I18N['tracker.chart.empty']); return; }
    setText('trk-chart-status', '');
    drawHashrate(wrap, points, range);
  }

  // ---------- section 03: workshare luck chart with range tabs, best share ----------
  function luckValue(raw) {
    return typeof raw === 'number' || (typeof raw === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) ? Number(raw) : NaN;
  }
  async function refreshShares(snapshot) {
    const range = wsRange;
    const addr = encodeURIComponent(snapshot.addresses.join(','));
    const [list, day] = await Promise.all([
      getJSON(`${API}/pool/shares?addresses=${addr}&period=${range}`),
      range === '24h' ? Promise.resolve(null) : getJSON(`${API}/pool/shares?addresses=${addr}&period=24h`),
    ]);
    if (!snapshot.current()) return;
    const bestSource = range === '24h' ? list : day;
    const luck = luckValue(bestSource && bestSource.bestShareLuck);
    setText('trk-luck-best', Number.isFinite(luck) && luck >= 0 ? `${nf(luck, 1)}%` : I18N['tracker.unavailable']);
    const wrap = $('trk-luck-chart');
    if (!wrap) return;
    const shares = parseShares(list);
    if (shares == null) { chartMessage('trk-luck-chart', 'trk-luck-status', 'trk-luck-readout', I18N['tracker.unavailable']); return; }
    if (!shares.length) { chartMessage('trk-luck-chart', 'trk-luck-status', 'trk-luck-readout', I18N['tracker.luck.empty']); return; }
    setText('trk-luck-status', '');
    drawLuck(wrap, shares, range);
  }

  // ---------- section 04: rewards, the mining burn tile and chart ----------
  let lastVaultWei = null; // the burn vault's own counter, as last read on chain
  async function readVault() {
    const burnedHex = CONFIG.vault ? await rpcCall('eth_call', [{ to: CONFIG.vault, data: '0xd157e301' }, 'latest']) : null;
    return typeof burnedHex === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(burnedHex) ? BigInt(burnedHex) : null;
  }
  function paintBurnTile(wei) {
    // Burned by mining: the burn vault's own counter, read on-chain (totalTokensBurned()). Not the token's total burn.
    lastVaultWei = wei == null ? null : wei.toString();
    const text = wei != null ? nf(Number(wei) / 1e18, 0) : I18N['tracker.unavailable'];
    setText('trk-burned', text);
    setText('trk-p-burn', text);
    paintBurnChart();
  }
  async function paintRewards(snapshot, earliestShareMs) {
    if (!snapshot.addresses.length || !snapshot.current()) return;
    const [lockedResults, unlockedResults] = await Promise.all([
      Promise.all(snapshot.addresses.map((a) => rpcCall('quai_getLockedBalance', [a]))),
      Promise.all(snapshot.addresses.map((a) => rpcCall('quai_getBalance', [a, 'latest']))),
    ]);
    if (!snapshot.current()) return;
    const sumHex = (arr) => {
      const nonNull = arr.filter((v) => v != null);
      if (!nonNull.length) return null;
      return nonNull.reduce((acc, v) => acc + BigInt(v), 0n);
    };
    const locked = sumHex(lockedResults);
    const unlocked = sumHex(unlockedResults);
    const fmtQuai = (wei) => nf(Number(wei) / 1e18, 4);
    setText('trk-locked', locked != null ? fmtQuai(locked) : I18N['tracker.unavailable']);
    setText('trk-unlocked', unlocked != null ? fmtQuai(unlocked) : I18N['tracker.unavailable']);

    if (earliestShareMs) {
      const unlockMs = earliestShareMs + 14 * 24 * 60 * 60 * 1000;
      const d = new Date(unlockMs);
      setText('trk-nextunlock', d.toLocaleDateString(loc, { month: 'short', day: 'numeric' }));
    } else {
      setText('trk-nextunlock', I18N['tracker.rewards.nextunlock.none']);
    }

    const wei = await readVault();
    if (!snapshot.current()) return;
    paintBurnTile(wei);
  }

  // ---------- mining burns over time (the burn vault's sweeps only) ----------
  let sweepRows = FEED && Array.isArray(FEED.sweeps) ? FEED.sweeps.filter((s) => s && weiString(s.burned) != null).map((s) => ({ ...s })) : [];
  function paintBurnChart() {
    const wrap = $('trk-burn-chart');
    if (!wrap || !FEED) return;
    const series = burnSeries(sweepRows, lastVaultWei, Math.floor(pageNow() / 1000));
    if (!series.length) { chartMessage('trk-burn-chart', 'trk-burn-status', 'trk-burn-readout', I18N['tracker.burnchart.empty']); return; }
    setText('trk-burn-status', '');
    const max = series.reduce((m, p) => Math.max(m, p.v), 0) || 1;
    const t0 = series[0].t, t1 = series[series.length - 1].t;
    const x = (p) => (t1 > t0 ? PAD + ((p.t - t0) / (t1 - t0)) * (CW - PAD * 2) : CW / 2);
    const y = (p) => CH - PAD - (p.v / max) * (CH - PAD * 2);
    let path = `M${x(series[0]).toFixed(1)},${y(series[0]).toFixed(1)}`;
    for (let i = 1; i < series.length; i += 1) path += ` L${x(series[i]).toFixed(1)},${y(series[i - 1]).toFixed(1)} L${x(series[i]).toFixed(1)},${y(series[i]).toFixed(1)}`;
    const marks = series.map((p) => `<rect class="trk-pt" x="${(x(p) - 3).toFixed(1)}" y="${(y(p) - 3).toFixed(1)}" width="6" height="6"/>`).join('');
    const day = { month: 'short', day: 'numeric' };
    const mid = series[Math.floor((series.length - 1) / 2)];
    const svg = mountChart(wrap, `${gridLines()}<path class="trk-ln" d="${path}"/>${marks}`, [
      yLabel(0, nf(max, 0)), yLabel(0.5, nf(max / 2, 0)), yLabel(1, '0'),
      ...xLabels(new Date(t0).toLocaleDateString(loc, day), new Date(mid.t).toLocaleDateString(loc, day), new Date(t1).toLocaleDateString(loc, day)),
    ]);
    bindReadout(svg, 'trk-burn-readout', series.map(x), (i) => `${new Date(series[i].t).toLocaleDateString(loc, day)} — ${nf(series[i].v, 0)} $QAXE`);
  }

  // ---------- the QuaiAxe fee loop (buybacks, each with its half-burn) ----------
  let feeRows = FEED && Array.isArray(FEED.buys) ? FEED.buys.filter((r) => r && weiString(r.qaxe) != null).map((r) => ({ ...r })) : [];
  const freshRowTx = new Set();
  const FL_LABELS = { pending: I18N['tracker.fl.pending'], buy: I18N['tracker.fl.tx.buy'], burn: I18N['tracker.fl.tx.burn'] };
  function drawFeeBars(wrap, rows) {
    const big = (w) => Number(BigInt(w) / 10n ** 14n) / 1e4;
    const max = rows.reduce((m, r) => Math.max(m, big(r.qaxe)), 0) || 1;
    const slot = (CW - PAD * 2) / rows.length;
    const bw = Math.min(64, slot * 0.6);
    const cx = (i) => PAD + slot * (i + 0.5);
    const h = (v) => (v / max) * (CH - PAD * 2);
    const bars = rows.map((r, i) => {
      const left = (cx(i) - bw / 2).toFixed(1);
      const total = h(big(r.qaxe));
      const base = CH - PAD;
      if (weiString(r.burned) == null) return `<rect class="trk-bar-pending" x="${left}" y="${(base - total).toFixed(1)}" width="${bw.toFixed(1)}" height="${total.toFixed(1)}"/>`;
      const burned = h(big(r.burned));
      return `<rect class="trk-bar-burned" x="${left}" y="${(base - burned).toFixed(1)}" width="${bw.toFixed(1)}" height="${burned.toFixed(1)}"/>` +
        `<rect class="trk-bar-held" x="${left}" y="${(base - total).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, total - burned).toFixed(1)}"/>`;
    }).join('');
    const svg = mountChart(wrap, gridLines() + bars, [
      yLabel(0, formatWei((BigInt(Math.round(max * 1e4)) * 10n ** 14n).toString(), 0, lang)), yLabel(1, '0'),
      xLabel((PAD / CW * 100).toFixed(2), utcDate(rows[0].ts), '0'), xLabel(((CW - PAD) / CW * 100).toFixed(2), utcDate(rows[rows.length - 1].ts), '-100%'),
    ]);
    bindReadout(svg, 'trk-fl-readout', rows.map((r, i) => cx(i)), (i) => {
      const r = rows[i];
      const burned = weiString(r.burned);
      const held = burned == null ? null : (BigInt(r.qaxe) - BigInt(burned)).toString();
      return `${utcDate(r.ts)} — ${formatWei(r.qaxe, 0, lang)} $QAXE · ${I18N['tracker.fl.chart.burned']} ${burned == null ? '—' : formatWei(burned, 0, lang)} · ${I18N['tracker.fl.chart.held']} ${held == null ? '—' : formatWei(held, 0, lang)}`;
    });
  }
  function paintFeeLoop() {
    const body = $('trk-fl-body');
    if (!body) return;
    const rows = feeRows.slice().sort((a, b) => a.b - b.b);
    body.innerHTML = rows.length
      ? rows.map((r) => {
        const html = feeLoopRowHtml(r, { lang, labels: FL_LABELS });
        return freshRowTx.has(r.tx) ? html.replace('<tr class="trk-row">', '<tr class="trk-row trk-tick">') : html;
      }).join('')
      : `<tr><td colspan="6">${I18N['tracker.fl.empty']}</td></tr>`;
    freshRowTx.clear();
    const sum = summarizeFeedLoop(rows);
    setText('trk-fl-runs', String(sum.runs));
    setText('trk-fl-quai', sum.runs ? formatWei(sum.quai, 2, lang) : '—');
    setText('trk-fl-bought', sum.runs ? formatWei(sum.qaxe, 0, lang) : '—');
    setText('trk-fl-burned', sum.runs ? formatWei(sum.burned, 0, lang) : '—');
    setText('trk-fl-held', sum.runs ? formatWei(sum.held, 0, lang) : '—');
    const wrap = $('trk-fl-chart');
    if (!wrap) return;
    if (!rows.length) { chartMessage('trk-fl-chart', 'trk-fl-chart-status', 'trk-fl-readout', I18N['tracker.fl.chart.empty']); return; }
    setText('trk-fl-chart-status', '');
    drawFeeBars(wrap, rows);
  }

  // ---------- live chain feed: log filters, polling and the WebSocket ----------
  const pad = (a) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
  const ZERO_TOPIC = pad(`0x${'0'.repeat(40)}`);
  // Every address the RPC sees goes through checksumAddress() first (it refuses any other spelling).
  const CHAIN = FEED ? {
    vault: checksumAddress(CONFIG.vault), token: checksumAddress(CONFIG.qaxeToken), treasury: checksumAddress(FEED.treasury),
    sources: (Array.isArray(FEED.sources) ? FEED.sources : []).map((s) => checksumAddress(s)),
  } : null;
  const feedReady = !!(CHAIN && CHAIN.vault && CHAIN.token && CHAIN.treasury && CHAIN.sources.length && CHAIN.sources.every(Boolean) && Number.isSafeInteger(FEED.block));
  let scanned = feedReady ? FEED.block : 0;
  let scanning = false;
  const seenLogs = new Set();
  const liveTx = new Set();
  const liveBurns = [];
  const blockTimes = new Map();
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

  const sweepFilter = () => ({ address: CHAIN.vault, topics: [FEED_TOPICS.swept] });
  const buyFilter = () => ({ address: CHAIN.token, topics: [FEED_TOPICS.transfer, CHAIN.sources.map(pad), pad(CHAIN.treasury)] });
  const burnFilter = () => ({ address: CHAIN.token, topics: [FEED_TOPICS.transfer, pad(CHAIN.treasury), ZERO_TOPIC] });

  let liveHead = { n: null, at: 0 };
  async function chainHead() {
    if (liveHead.n != null && pageNow() - liveHead.at < 20000) return liveHead.n;
    const r = await rpcCall('quai_blockNumber', []);
    if (typeof r !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(r)) return null;
    return Number(BigInt(r));
  }
  async function blockTime(b) {
    if (blockTimes.has(b)) return blockTimes.get(b);
    const header = await rpcCall('quai_getHeaderByNumber', [hexq(b)]);
    const ts = header && header.woHeader && typeof header.woHeader.timestamp === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(header.woHeader.timestamp) ? Number(BigInt(header.woHeader.timestamp)) : null;
    blockTimes.set(b, ts);
    return ts;
  }
  const fresh = (log) => {
    const key = `${log && log.transactionHash}:${log && log.logIndex}`;
    if (seenLogs.has(key)) return false;
    seenLogs.add(key);
    return true;
  };

  let ingestChain = Promise.resolve();
  function ingest(batch) {
    ingestChain = ingestChain.then(() => ingestNow(batch)).catch(() => {});
    return ingestChain;
  }
  async function ingestNow({ swept = [], buys = [], burns = [] }) {
    let sweptNew = false, rowsChanged = false;
    for (const log of swept) {
      const d = decodeSwept(log);
      if (!d || !same(log.address, CHAIN.vault) || !fresh(log) || sweepRows.some((r) => r.tx === d.tx && r.burned === d.burned)) continue;
      const ts = await blockTime(d.b);
      sweepRows.push({ b: d.b, tx: d.tx, ts, burned: d.burned, quai: d.quai });
      queueEvent('sweep', I18N['tracker.feed.sweep'].replace('{n}', formatWei(d.burned, 0, lang)), txUrl(d.tx), ts == null ? NaN : ts * 1000);
      sweptNew = true;
    }
    for (const log of buys) {
      const d = decodeTransferLog(log);
      if (!d || !same(log.address, CHAIN.token) || !same(d.to, CHAIN.treasury) || !CHAIN.sources.some((s) => same(s, d.from)) || !fresh(log)) continue;
      const known = feeRows.find((r) => r.tx === d.tx);
      if (known && !liveTx.has(d.tx)) continue; // the snapshot already holds this transaction, with its QUAI leg
      if (known) { known.qaxe = (BigInt(known.qaxe) + BigInt(d.amount)).toString(); rowsChanged = true; continue; }
      const ts = await blockTime(d.b);
      feeRows = mergeRows(feeRows, [{ tx: d.tx, b: d.b, ts, quai: null, qaxe: d.amount, burned: null, burnTx: null }]);
      liveTx.add(d.tx);
      freshRowTx.add(d.tx);
      queueEvent('buy', I18N['tracker.feed.buy'].replace('{n}', formatWei(d.amount, 0, lang)), txUrl(d.tx), ts == null ? NaN : ts * 1000);
      rowsChanged = true;
    }
    for (const log of burns) {
      const d = decodeTransferLog(log);
      if (!d || !same(log.address, CHAIN.token) || !same(d.from, CHAIN.treasury) || d.to !== `0x${'0'.repeat(40)}` || !fresh(log)) continue;
      if (feeRows.some((r) => r.burnTx === d.tx)) continue; // already paired in the snapshot
      const ts = await blockTime(d.b);
      liveBurns.push({ b: d.b, tx: d.tx, qaxe: d.amount });
      queueEvent('feeburn', I18N['tracker.feed.feeburn'].replace('{n}', formatWei(d.amount, 0, lang)), txUrl(d.tx), ts == null ? NaN : ts * 1000);
      rowsChanged = true;
    }
    if (rowsChanged) { feeRows = pairBurns(feeRows, liveBurns); paintFeeLoop(); }
    if (sweptNew) { paintBurnTile(await readVault()); }
    renderFeed();
  }

  // Poll the chain for blocks after the cursor, a few chunks per cycle, one read at a time. A failed read keeps the cursor.
  async function scanFeed() {
    if (!feedReady || scanning) return;
    scanning = true;
    try {
      const head = await chainHead();
      if (head == null) return;
      let chunks = 0;
      while (scanned < head && chunks < MAX_CHUNKS) {
        const from = scanned + 1;
        const to = Math.min(head, from + LOG_SPAN);
        const range = { fromBlock: hexq(from), toBlock: hexq(to) };
        const out = [];
        for (const filter of [sweepFilter(), buyFilter(), burnFilter()]) {
          const logs = await rpcCall('eth_getLogs', [{ ...filter, ...range }]);
          if (!Array.isArray(logs)) return;
          out.push(logs);
        }
        await ingest({ swept: out[0], buys: out[1], burns: out[2] });
        scanned = to;
        chunks += 1;
      }
    } finally {
      scanning = false;
    }
  }

  // The WebSocket: the same three log filters plus new heads. Polling stays on as the fallback and the reconciliation.
  let sock = null, sockOpen = false, sockTimer = null, sockBackoff = 5000, sockStopped = false;
  const subKinds = new Map();
  function setConn(open) {
    sockOpen = open;
    const chip = $('trk-conn');
    if (!chip) return;
    chip.textContent = open ? I18N['tracker.conn.live'] : I18N['tracker.conn.poll'];
    chip.className = open ? 'tag trk-conn live' : 'tag trk-conn';
  }
  function onSocketMessage(ev) {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (typeof m.id === 'number' && typeof m.result === 'string') { subKinds.set(m.result, m.id); return; }
    if (m.method !== 'quai_subscription' || !m.params || typeof m.params !== 'object') return;
    const kind = subKinds.get(m.params.subscription);
    const result = m.params.result;
    if (!result || typeof result !== 'object') return;
    if (kind === 1) {
      const n = result.woHeader && typeof result.woHeader.number === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(result.woHeader.number) ? Number(BigInt(result.woHeader.number)) : null;
      if (n != null) liveHead = { n, at: pageNow() };
    } else if (kind === 2) ingest({ swept: [result] });
    else if (kind === 3) ingest({ buys: [result] });
    else if (kind === 4) ingest({ burns: [result] });
  }
  function openLive() {
    if (!feedReady || typeof WebSocket !== 'function' || sock || document.hidden) return;
    let s = null;
    try { s = new WebSocket(WSS); } catch (e) { return; }
    sock = s;
    s.onopen = () => {
      sockBackoff = 5000;
      subKinds.clear();
      const subs = [['newHeads'], ['logs', sweepFilter()], ['logs', buyFilter()], ['logs', burnFilter()]];
      subs.forEach((params, i) => s.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'quai_subscribe', params })));
      setConn(true);
    };
    s.onmessage = onSocketMessage;
    s.onerror = () => {};
    s.onclose = () => {
      if (sock === s) sock = null;
      setConn(false);
      if (sockStopped || document.hidden) return;
      sockTimer = setTimeout(() => { sockTimer = null; openLive(); }, sockBackoff);
      sockBackoff = Math.min(sockBackoff * 2, 60000);
    };
  }
  function closeLive() {
    sockStopped = true;
    if (sockTimer) { clearTimeout(sockTimer); sockTimer = null; }
    const s = sock;
    sock = null;
    if (s) { try { s.close(); } catch (e) { /* already closed */ } }
    setConn(false);
  }

  // ---------- section 06: check your own address ----------
  const checkInput = $('trk-check-addr'), checkGo = $('trk-check-go'), checkErr = $('trk-check-err'), checkReset = $('trk-check-reset');
  function switchTo(list, shown) {
    addresses = list;
    seeded = false;
    knownWs.clear();
    wsList = [];
    stripItems = [];
    ws24h = null;
    setText('trk-check-addr-out', shown);
    if (checkReset) checkReset.hidden = list.join() === DEFAULT_ADDRESSES.join();
    refreshAll();
  }
  if (checkReset) checkReset.hidden = true;
  if (checkGo) {
    checkGo.addEventListener('click', () => {
      // quai_getBalance only accepts the checksummed spelling, so a pasted lowercase address is fixed here first;
      // a mixed-case address with the wrong casing, or anything that is not 0x + 40 hex, is refused.
      const v = checksumAddress(checkInput.value);
      if (!v) { checkErr.textContent = I18N['tracker.check.err']; return; }
      checkErr.textContent = '';
      switchTo([v], v);
    });
  }
  if (checkReset) checkReset.addEventListener('click', () => { checkErr.textContent = ''; switchTo(DEFAULT_ADDRESSES.slice(), DEFAULT_ADDRESSES[0] || '—'); });
  setText('trk-check-addr-out', addresses[0] || '—');

  // ---------- range tabs ----------
  function paintTabs(prefix, ranges, current) {
    for (const r of ranges) { const b = $(`${prefix}-${r}`); if (b) b.setAttribute('aria-pressed', r === current ? 'true' : 'false'); }
  }
  function bindTabs(prefix, ranges, get, set, reload) {
    for (const r of ranges) {
      const b = $(`${prefix}-${r}`);
      if (!b) continue;
      b.addEventListener('click', () => {
        if (!isTrackerRange(r) || get() === r) return undefined;
        set(r);
        paintTabs(prefix, ranges, r);
        return reload(currentSnapshot());
      });
    }
  }
  bindTabs('trk-hr-tabs', ['1h', '24h', '7d'], () => hrRange, (r) => { hrRange = r; }, (snap) => refreshHashrate(scoped('hr', snap)).catch(() => hashrateFailed()));
  bindTabs('trk-ws-tabs', ['24h', '7d'], () => wsRange, (r) => { wsRange = r; }, (snap) => refreshShares(scoped('ws', snap)).catch(() => sharesFailed()));
  paintTabs('trk-hr-tabs', ['1h', '24h', '7d'], hrRange);
  paintTabs('trk-ws-tabs', ['24h', '7d'], wsRange);

  function hashrateFailed() {
    chartMessage('trk-chart', 'trk-chart-status', 'trk-chart-readout', I18N['tracker.unavailable']);
  }
  function sharesFailed() {
    chartMessage('trk-luck-chart', 'trk-luck-status', 'trk-luck-readout', I18N['tracker.unavailable']);
  }

  // ---------- share and embed ----------
  const copyBtn = $('trk-embed-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const box = $('trk-embed-code');
      const text = box ? String(box.value || box.textContent || '') : '';
      let ok = false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') { await navigator.clipboard.writeText(text); ok = true; }
      } catch (e) { ok = false; }
      if (!ok && box) {
        try { box.select(); ok = !!(document.execCommand && document.execCommand('copy')); } catch (e) { ok = false; }
      }
      setText('trk-embed-status', ok ? I18N['tracker.share.copied'] : '');
    });
  }
  const shareBtn = $('trk-share-link');
  if (shareBtn) {
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    shareBtn.hidden = !canShare;
    if (canShare) shareBtn.addEventListener('click', () => { Promise.resolve(navigator.share({ title: 'QuaiAxe', url: location.href })).catch(() => {}); });
  }

  // ---------- polling: a 30 s cycle and a 10 s poll while visible, paused while hidden ----------
  function refreshAll() {
    refreshGeneration += 1;
    const snapshot = currentSnapshot();
    refreshMiners(snapshot).catch(() => {
      if (!snapshot.current()) return;
      minersUnavailable();
    });
    refreshWorkshares(snapshot).then((earliest) => paintRewards(snapshot, earliest)).catch(() => {
      if (!snapshot.current()) return;
      for (const id of ['trk-ws-24h', 'trk-p-ws', 'trk-luck-avg', 'trk-locked', 'trk-unlocked', 'trk-burned', 'trk-p-burn']) setText(id, I18N['tracker.unavailable']);
      setText('trk-nextunlock', I18N['tracker.rewards.nextunlock.none']);
    });
    refreshHashrate(scoped('hr', snapshot)).catch(() => { if (snapshot.current()) hashrateFailed(); });
    refreshShares(scoped('ws', snapshot)).catch(() => { if (snapshot.current()) sharesFailed(); });
    scanFeed().catch(() => {});
  }
  function fastTick() {
    if (document.hidden) return;
    fastWorkshares(currentSnapshot()).catch(() => {});
    if (feedReady && !sockOpen) scanFeed().catch(() => {});
  }
  let timer = null, fastTimer = null;
  function startPolling() {
    if (timer) return;
    sockStopped = false;
    refreshAll();
    timer = setInterval(refreshAll, SLOW_MS);
    fastTimer = setInterval(fastTick, FAST_MS);
    openLive();
    setText('trk-live-tag', I18N['tracker.updated']);
  }
  function stopPolling() {
    if (!timer) return;
    clearInterval(timer);
    clearInterval(fastTimer);
    timer = null;
    fastTimer = null;
    closeLive();
    setText('trk-live-tag', I18N['tracker.paused']);
  }
  document.addEventListener('visibilitychange', () => { document.hidden ? stopPolling() : startPolling(); });
  setConn(false);
  renderFeed();
  paintFeeLoop();
  paintBurnChart();
  if (!document.hidden) startPolling();
}
