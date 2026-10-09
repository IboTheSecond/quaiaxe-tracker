/**
 * assets/tracker.js — the /tracker page. Live workers + hashrate + shares from StratumX's public
 * pool API, workshares from the Quai chain (as reported by StratumX), a 24h hashrate line chart,
 * locked/unlocked QUAI read straight from rpc.quai.network in the visitor's browser, and the
 * mining burn figure (QaxeBurnVault.totalTokensBurned(), read on-chain; never a combined burn total). Every section fails gracefully to an
 * "unavailable" state per source — nothing here is ever invented. Polls every 30s while the tab is
 * visible, and pauses while it is hidden.
 */
import { formatHashrate, agoParts, isAddressShape, safeBlockHeight, safeCount } from '/assets/lib/tracker-lib.js';

const $ = (id) => document.getElementById(id);
const i18nEl = $('trk-i18n');
const configEl = $('trk-config');
if (i18nEl && configEl) {
  const I18N = JSON.parse(i18nEl.textContent);
  const CONFIG = JSON.parse(configEl.textContent);
  const isTr = document.documentElement.lang === 'tr';
  const loc = isTr ? 'tr-TR' : 'en-US';
  const nf = (n, d) => Number(n).toLocaleString(loc, { minimumFractionDigits: d, maximumFractionDigits: d });
  const API = CONFIG.stratumxApi || 'https://backend.stratumx.org/api';
  const RPC = CONFIG.rpc || 'https://rpc.quai.network/cyprus1';

  let addresses = (CONFIG.trackedAddresses || []).slice();

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

  // ---------- section 01: live miners ----------
  async function refreshMiners() {
    const j = await getJSON(`${API}/miners/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses }),
    });
    if (!j || !j.stats) {
      setText('trk-online', I18N['tracker.unavailable']);
      setText('trk-total', I18N['tracker.unavailable']);
      const body = $('trk-workers-body');
      if (body) body.innerHTML = `<tr><td colspan="6">${I18N['tracker.unavailable']}</td></tr>`;
      return;
    }
    const s = j.stats;
    setText('trk-online', String(s.workersConnected ?? '—'));
    setText('trk-total', String(s.workersTotal ?? '—'));
    setText('trk-hr-sha', formatHashrate(s.hashrateSha));
    setText('trk-hr-scrypt', formatHashrate(s.hashrateScrypt));
    setText('trk-hr-kawpow', formatHashrate(s.hashrateKawpow));
    setText('trk-sh-valid', String(s.sharesValid ?? '—'));
    setText('trk-sh-stale', String(s.sharesStale ?? '—'));
    setText('trk-sh-invalid', String(s.sharesInvalid ?? '—'));

    const workers = Array.isArray(j.workers) ? j.workers : [];
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
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- section 02: workshares ----------
  let earliestShareMs = null;
  async function refreshWorkshares() {
    const addrParam = addresses.join(',');
    const [blocks24h, blocks7d, shares] = await Promise.all([
      getJSON(`${API}/pool/blocks?addresses=${encodeURIComponent(addrParam)}&period=24h`),
      getJSON(`${API}/pool/blocks?addresses=${encodeURIComponent(addrParam)}&period=7d`),
      getJSON(`${API}/pool/shares?addresses=${encodeURIComponent(addrParam)}&period=24h`),
    ]);

    setText('trk-ws-24h', Array.isArray(blocks24h) ? String(blocks24h.length) : I18N['tracker.unavailable']);

    // 7-day workshare count. (StratumX's averageLuck averages every tiny share, not workshares, so it
    // read as a misleading "0.9%" — replaced 2026-09-27.)
    setText('trk-luck-avg', Array.isArray(blocks7d) ? String(blocks7d.length) : I18N['tracker.unavailable']);
    if (shares) {
      setText('trk-luck-best', shares.bestShareLuck != null ? `${nf(shares.bestShareLuck, 1)}%` : '—');
    } else {
      setText('trk-luck-best', I18N['tracker.unavailable']);
    }

    // Start from "no estimate" on every pass. A failed fetch or an empty list must not leave the previous
    // address's (or the previous cycle's) earliest workshare behind to drive the "next unlock" tile.
    earliestShareMs = null;
    const body = $('trk-ws-body');
    if (body) {
      if (!Array.isArray(blocks7d)) {
        body.innerHTML = `<tr><td colspan="4">${I18N['tracker.unavailable']}</td></tr>`;
      } else if (!blocks7d.length) {
        body.innerHTML = `<tr><td colspan="4">${I18N['tracker.workshares.table.empty']}</td></tr>`;
      } else {
        const sorted = blocks7d.slice().sort((a, b) => Date.parse(b.foundAt) - Date.parse(a.foundAt));
        earliestShareMs = sorted.length ? Date.parse(sorted[sorted.length - 1].foundAt) : null;
        body.innerHTML = sorted.slice(0, 50).map((b) => {
          const nick = (b.worker || '').split('.').slice(1).join('.') || b.worker || '—';
          const time = new Date(b.foundAt).toLocaleString(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          // b.height is a third-party API field (StratumX). Coerce to a plain non-negative integer
          // before it ever reaches an href or innerHTML — a malformed/hostile value collapses to
          // 0 rather than being interpolated as markup (e.g. into the href, which escapeHtml alone
          // would not make safe against a javascript: or data: URL).
          const height = safeBlockHeight(b.height);
          return `<tr><td><a href="https://quaiscan.io/block/${height}" target="_blank" rel="noopener">${height} ${escapeHtml(I18N['tracker.workshares.viewblock'])}</a></td>` +
            `<td>${escapeHtml(time)}</td><td>${escapeHtml(nick)}</td><td>${escapeHtml(String(b.algorithm || '—'))}</td></tr>`;
        }).join('');
      }
    }
    // paintRewards() is not called here: refreshAll() runs it once, after this resolves and
    // earliestShareMs is set. A second call would read every balance and the burn vault twice per cycle.
  }

  // ---------- section 03: 24h hashrate chart ----------
  async function refreshChart() {
    const j = await getJSON(`${API}/miner/hashrate/history?addresses=${encodeURIComponent(addresses.join(','))}&period=24h`);
    const wrap = $('trk-chart');
    const status = $('trk-chart-status');
    if (!wrap) return;
    const points = j && Array.isArray(j.points) ? j.points : null;
    if (!points || !points.length) {
      if (status) status.textContent = I18N['tracker.chart.empty'];
      wrap.querySelectorAll('svg').forEach((n) => n.remove());
      return;
    }
    if (status) status.textContent = '';
    drawChart(wrap, points);
  }

  function drawChart(wrap, points) {
    const W = 960, H = 220, PAD = 28;
    const values = points.map((p) => Number(p.hashrate) || 0);
    const max = Math.max(1, ...values);
    const min = 0;
    const x = (i) => PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
    const y = (v) => H - PAD - ((v - min) / (max - min || 1)) * (H - PAD * 2);
    const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${path} L${x(values.length - 1).toFixed(1)},${(H - PAD).toFixed(1)} L${x(0).toFixed(1)},${(H - PAD).toFixed(1)} Z`;
    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const gy = (PAD + f * (H - PAD * 2)).toFixed(1);
      return `<line x1="${PAD}" y1="${gy}" x2="${W - PAD}" y2="${gy}" stroke="var(--line)" stroke-width="1"/>`;
    }).join('');
    const dots = points.map((p, i) => `<circle data-i="${i}" cx="${x(i).toFixed(1)}" cy="${y(values[i]).toFixed(1)}" r="9" fill="transparent"/>`).join('');
    // Axis labels as HTML over the stretched SVG (text inside a preserveAspectRatio="none" SVG would
    // distort): hashrate at max / half / 0 on the left, start / middle / end time along the bottom.
    // Their look is in site.css (.chart .lab). Only the computed position is set here, through the
    // CSSOM (el.style.top = ...), which the page's style-src 'self' allows; an inline style attribute it would not.
    const tfmt = (p) => new Date(p.timestamp).toLocaleString(loc, { hour: '2-digit', minute: '2-digit' });
    const label = (cls, text, pos) => {
      const n = document.createElement('span');
      n.className = `lab ${cls}`;
      n.textContent = text;
      Object.assign(n.style, pos);
      return n;
    };
    const yLab = (f, v) => label('lab-y', formatHashrate(v), { top: `calc(${((PAD + f * (H - PAD * 2)) / H * 100).toFixed(2)}% - 8px)` });
    const mid = points[Math.floor((points.length - 1) / 2)];
    const xLab = (pct, p, align) => label('lab-x', tfmt(p), { left: `${pct}%`, transform: `translateX(${align})` });
    wrap.style.position = 'relative';
    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="presentation">` +
      gridLines +
      `<path d="${area}" fill="rgba(255,74,28,.12)" stroke="none"/>` +
      `<path d="${path}" fill="none" stroke="var(--ember)" stroke-width="2"/>` +
      dots +
      `</svg>`;
    [
      yLab(0, max), yLab(0.5, max / 2), yLab(1, 0),
      xLab((PAD / W * 100).toFixed(2), points[0], '0'), xLab(50, mid, '-50%'), xLab(((W - PAD) / W * 100).toFixed(2), points[points.length - 1], '-100%'),
    ].forEach((n) => wrap.appendChild(n));
    const svg = wrap.querySelector('svg');
    const readout = $('trk-chart-readout');
    if (svg && readout) {
      svg.addEventListener('pointermove', (ev) => {
        const rect = svg.getBoundingClientRect();
        const rx = (ev.clientX - rect.left) / rect.width * W;
        let nearest = 0, best = Infinity;
        points.forEach((p, i) => { const d = Math.abs(x(i) - rx); if (d < best) { best = d; nearest = i; } });
        const p = points[nearest];
        const time = new Date(p.timestamp).toLocaleString(loc, { hour: '2-digit', minute: '2-digit' });
        readout.textContent = `${time} — ${formatHashrate(p.hashrate)}`;
      });
      svg.addEventListener('pointerleave', () => { readout.textContent = ' '; });
    }
  }

  // ---------- section 04: rewards & burn ----------
  async function paintRewards() {
    if (!addresses.length) return;
    const primary = addresses[0];
    const [lockedResults, unlockedResults] = await Promise.all([
      Promise.all(addresses.map((a) => rpcCall('quai_getLockedBalance', [a]))),
      Promise.all(addresses.map((a) => rpcCall('quai_getBalance', [a, 'latest']))),
    ]);
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

    // Burned by mining: the burn vault's own counter, read on-chain (totalTokensBurned()). Not the token's total burn.
    const burnedHex = CONFIG.vault ? await rpcCall('eth_call', [{ to: CONFIG.vault, data: '0xd157e301' }, 'latest']) : null;
    if (burnedHex) {
      setText('trk-burned', nf(Number(BigInt(burnedHex)) / 1e18, 0));
    } else {
      setText('trk-burned', I18N['tracker.unavailable']);
    }
  }

  // ---------- section 05: check your own address ----------
  const checkInput = $('trk-check-addr'), checkGo = $('trk-check-go'), checkErr = $('trk-check-err');
  if (checkGo) {
    checkGo.addEventListener('click', () => {
      const v = (checkInput.value || '').trim();
      if (!isAddressShape(v)) { checkErr.textContent = I18N['tracker.check.err']; return; }
      checkErr.textContent = '';
      addresses = [v];
      setText('trk-check-addr-out', v);
      refreshAll();
    });
  }
  setText('trk-check-addr-out', addresses[0] || '—');

  // ---------- polling: every 30s while visible, paused while hidden ----------
  function refreshAll() {
    refreshMiners();
    refreshWorkshares().then(paintRewards);
    refreshChart();
  }
  let timer = null;
  function startPolling() {
    if (timer) return;
    refreshAll();
    timer = setInterval(refreshAll, 30000);
    setText('trk-live-tag', I18N['tracker.updated']);
  }
  function stopPolling() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    setText('trk-live-tag', I18N['tracker.paused']);
  }
  document.addEventListener('visibilitychange', () => { document.hidden ? stopPolling() : startPolling(); });
  if (!document.hidden) startPolling();
}
