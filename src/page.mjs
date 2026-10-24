// src/page.mjs - the whole page. The tracker body below is the same markup quaiaxe.com serves at /tracker (a
// test in the upstream repository keeps the two identical), inside a one-page shell: a header with the live block
// height and the EN/TR switch, and a footer. The Content-Security-Policy the page must run under is defined here
// too, next to the markup it constrains, and written both as an HTTP header (dist/_headers) and as a <meta> tag.
// Node reads this file at build time; nothing in it reaches the browser.
import { readFileSync } from 'node:fs';

import { feeLoopRowHtml, escapeHtml, safeTelegramUrl, summarizeFeedLoop, formatWei } from './lib/tracker-lib.js';

const STRINGS = JSON.parse(readFileSync(new URL('./strings.json', import.meta.url), 'utf8'));
export const LANGS = ['en', 'tr'];

/** Looks a string up and throws loudly on a missing key or language, so a gap fails the build instead of the page. */
export function t(key, lang) {
  const entry = STRINGS[key];
  if (!entry) throw new Error(`strings.json: missing key "${key}"`);
  const value = entry[lang];
  if (value == null || value === '') throw new Error(`strings.json: key "${key}" has no ${lang} value`);
  return value;
}
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------------------------------------------
// the tracker body
// ---------------------------------------------------------------------------------------------------------------
/** A stat tile using the existing `.plate` grid — same visual language as home's "spec plate". */
function tile(lang, tagText, id, subKey) {
  return `<div><span class="tag hot">${tagText}</span><h3 class="mono" id="${id}">—</h3><p>${t(subKey, lang)}</p></div>`;
}

/** A tile whose figure is already known when the page is built (the fee-loop totals, from the committed snapshot). */
function figureTile(lang, labelKey, id, subKey, text) {
  return `<div><span class="tag hot">${t(labelKey, lang)}</span><h3 class="mono" id="${id}">${text}</h3><p>${t(subKey, lang)}</p></div>`;
}

/**
 * JSON for a <script type="application/json"> data block. JSON.stringify leaves "<" alone, so a value
 * holding "</script>" or "<!--" would end or confuse the block. The JSON escape for U+003C (written
 * out in the replace below) is the same character to JSON.parse and can never be markup.
 */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const RANGES = ['1h', '24h', '7d'];
const STRIP_CELLS = 48;

function tabs(lang, id, ranges, pressed) {
  return `<div class="trk-tabs" role="group" aria-label="${t('tracker.range.aria', lang)}" id="${id}">` +
    ranges.map((r) => `<button type="button" id="${id}-${r}" data-range="${r}" aria-pressed="${r === pressed}">${t(`tracker.range.${r}`, lang)}</button>`).join('') +
    '</div>';
}

/**
 * The /tracker body. `extra` is optional and only the quaiaxe.com build passes it:
 *   feed     - the build-time fee-loop and mining-sweep data (src/lib/tracker-feed.js); adds the data block, the mining burn
 *              chart and the fee-loop section.
 *   embedUrl - the absolute address of this language's /tracker/embed/ page; adds the share and embed section.
 *   card     - { url, asOf } of the share card image.
 * Without `extra` (the open-source tracker) the page is the live miner view alone and the script shows no fee-loop data.
 */
export function renderTracker(lang, config, extra = {}) {
  const { feed = null, embedUrl = null, card = null } = extra;
  const i18nKeys = [
    'tracker.updated', 'tracker.paused', 'tracker.unavailable', 'tracker.loading',
    'tracker.miners.online.label', 'tracker.miners.total.label',
    'tracker.hashrate.sha.label', 'tracker.hashrate.scrypt.label', 'tracker.hashrate.kawpow.label',
    'tracker.shares.valid.label', 'tracker.shares.stale.label', 'tracker.shares.invalid.label',
    'tracker.table.empty', 'tracker.status.online', 'tracker.status.offline',
    'tracker.workshares.count24h', 'tracker.workshares.luck.avg', 'tracker.workshares.luck.best',
    'tracker.workshares.table.empty', 'tracker.workshares.viewblock',
    'tracker.chart.empty', 'tracker.chart.readout.hint',
    'tracker.rewards.locked.label', 'tracker.rewards.unlocked.label', 'tracker.rewards.nextunlock.label',
    'tracker.rewards.nextunlock.basis', 'tracker.rewards.nextunlock.none', 'tracker.rewards.burned.label',
    'tracker.check.err', 'tracker.check.showing', 'tracker.check.default',
    'tracker.conn.live', 'tracker.conn.poll',
    'tracker.feed.empty', 'tracker.feed.kind.ws', 'tracker.feed.kind.sweep', 'tracker.feed.kind.buy', 'tracker.feed.kind.feeburn',
    'tracker.feed.ws', 'tracker.feed.sweep', 'tracker.feed.buy', 'tracker.feed.feeburn',
    'tracker.top.empty', 'tracker.luck.empty', 'tracker.schedule.empty',
    'tracker.burnchart.empty', 'tracker.fl.empty', 'tracker.fl.chart.empty', 'tracker.fl.chart.burned', 'tracker.fl.chart.held',
    'tracker.fl.pending', 'tracker.fl.tx.buy', 'tracker.fl.tx.burn',
    'tracker.share.copied',
    'home.band.burned.loading',
  ];
  const i18n = Object.fromEntries(i18nKeys.map((k) => [k, t(k, lang)]));
  const telegram = safeTelegramUrl(config.trackerBotUrl);
  // Section numbers are filled in document order at the end (the optional sections are built before the ones around them).
  const idx = () => '__IDX__';
  const dataBlock = feed ? `\n  <script type="application/json" id="trk-data">${jsonForScript({ feed })}</script>` : '';

  const summary = feed ? summarizeFeedLoop(feed.buys) : null;
  const flRows = feed && feed.buys.length
    ? feed.buys.map((r) => feeLoopRowHtml(r, { lang, labels: { pending: t('tracker.fl.pending', lang), buy: t('tracker.fl.tx.buy', lang), burn: t('tracker.fl.tx.burn', lang) } })).join('')
    : `<tr><td colspan="6">${t('tracker.fl.empty', lang)}</td></tr>`;

  const burnChart = feed ? `
    <div class="trk-sub rv">
      <h3 class="trk-h3">${t('tracker.burnchart.h3', lang)}</h3>
      <p class="note">${t('tracker.burnchart.p', lang)}</p>
      <div class="chart" id="trk-burn-chart" role="img" aria-label="${t('tracker.burnchart.aria', lang)}">
        <p class="note" id="trk-burn-status">${t('tracker.loading', lang)}</p>
      </div>
      <p class="tag trk-readout" id="trk-burn-readout">&nbsp;</p>
    </div>` : '';

  const feeLoop = feed ? `
  <section class="sec" id="trk-fl" aria-labelledby="trk-fl-h">
    <header class="sec-head rv">
      <span class="idx">${idx()}</span>
      <h2 id="trk-fl-h">${t('tracker.fl.h2', lang)}</h2>
      <p>${t('tracker.fl.p', lang)}</p>
    </header>
    <div class="trk-split rv" role="img" aria-label="${t('tracker.fl.split.aria', lang)}">
      <span class="trk-seg trk-seg-direct">50%</span><span class="trk-seg trk-seg-buyback">25%</span><span class="trk-seg trk-seg-hartii">25%</span>
    </div>
    <ul class="trk-legend rv">
      <li><i class="trk-seg-direct"></i>${t('tracker.fl.split.direct', lang)}</li>
      <li><i class="trk-seg-buyback"></i>${t('tracker.fl.split.buyback', lang)}</li>
      <li><i class="trk-seg-hartii"></i>${t('tracker.fl.split.hartii', lang)}</li>
    </ul>
    <div class="plate trk-plate-5 rv">
      ${figureTile(lang, 'tracker.fl.runs.label', 'trk-fl-runs', 'tracker.fl.runs.sub', String(summary.runs))}
      ${figureTile(lang, 'tracker.fl.quai.label', 'trk-fl-quai', 'tracker.fl.quai.sub', summary.runs ? formatWei(summary.quai, 2, lang) : '—')}
      ${figureTile(lang, 'tracker.fl.bought.label', 'trk-fl-bought', 'tracker.fl.bought.sub', summary.runs ? formatWei(summary.qaxe, 0, lang) : '—')}
      ${figureTile(lang, 'tracker.fl.burned.label', 'trk-fl-burned', 'tracker.fl.burned.sub', summary.runs ? formatWei(summary.burned, 0, lang) : '—')}
      ${figureTile(lang, 'tracker.fl.held.label', 'trk-fl-held', 'tracker.fl.held.sub', summary.runs ? formatWei(summary.held, 0, lang) : '—')}
    </div>
    <div class="dtable rv trk-gap">
      <table>
        <thead><tr>
          <th>${t('tracker.fl.col.date', lang)}</th>
          <th>${t('tracker.fl.col.quai', lang)}</th>
          <th>${t('tracker.fl.col.bought', lang)}</th>
          <th>${t('tracker.fl.col.burned', lang)}</th>
          <th>${t('tracker.fl.col.held', lang)}</th>
          <th>${t('tracker.fl.col.tx', lang)}</th>
        </tr></thead>
        <tbody id="trk-fl-body">${flRows}</tbody>
      </table>
    </div>
    <div class="trk-sub rv">
      <h3 class="trk-h3">${t('tracker.fl.chart.h3', lang)}</h3>
      <div class="chart" id="trk-fl-chart" role="img" aria-label="${t('tracker.fl.chart.aria', lang)}">
        <p class="note" id="trk-fl-chart-status">${t('tracker.loading', lang)}</p>
      </div>
      <p class="tag trk-readout" id="trk-fl-readout">&nbsp;</p>
    </div>
    <p class="note">${t('tracker.fl.note', lang)}</p>
    <p class="note"><a href="${lang === 'tr' ? '/tr' : ''}/supply/buyback/">${t('tracker.fl.link', lang)}</a></p>
  </section>
` : '';

  const embedSnippet = embedUrl
    ? `<iframe src="${embedUrl}" title="${t('tracker.embed.iframe.title', lang)}" width="480" height="300" loading="lazy" referrerpolicy="no-referrer"></iframe>`
    : '';
  const share = embedUrl ? `
  <section class="sec" id="trk-share" aria-labelledby="trk-share-h">
    <header class="sec-head rv">
      <span class="idx">${idx()}</span>
      <h2 id="trk-share-h">${t('tracker.share.h2', lang)}</h2>
      <p>${t('tracker.share.p', lang)}</p>
    </header>
    <div class="trk-share rv">
      <figure class="trk-card">
        <img src="${escapeHtml(card ? card.url : '/og-tracker.png')}" width="1200" height="630" loading="lazy" alt="${t('tracker.share.card.alt', lang)}">
        ${card && card.asOf ? `<figcaption class="note">${t('tracker.share.card.asof', lang).replace('{date}', escapeHtml(card.asOf))}</figcaption>` : ''}
      </figure>
      <div class="trk-embed">
        <div class="cta">
          <a class="btn" href="${escapeHtml(card ? card.url : '/og-tracker.png')}" download="quaiaxe-tracker.png">${t('tracker.share.card.download', lang)}</a>
          <button type="button" class="btn" id="trk-share-link" hidden>${t('tracker.share.link', lang)}</button>
        </div>
        <h3 class="trk-h3">${t('tracker.embed.h3', lang)}</h3>
        <p class="note">${t('tracker.embed.p', lang)}</p>
        <label class="tag" for="trk-embed-code">${t('tracker.embed.label', lang)}</label>
        <textarea id="trk-embed-code" class="trk-code" readonly rows="4" spellcheck="false">${escapeHtml(embedSnippet)}</textarea>
        <div class="cta">
          <button type="button" class="btn btn-hot" id="trk-embed-copy">${t('tracker.embed.copy', lang)}</button>
          <span class="tag" id="trk-embed-status" role="status"></span>
        </div>
      </div>
    </div>
  </section>
` : '';

  let n = 0;
  const body = `
  <script type="application/json" id="trk-i18n">${jsonForScript(i18n)}</script>
  <script type="application/json" id="trk-config">${jsonForScript({ trackedAddresses: config.trackedAddresses || [], stratumxApi: config.stratumxApi, rpc: config.rpc, vault: config.vault, qaxeToken: config.qaxeToken })}</script>${dataBlock}
  <header class="page-head trk-head">
    <div class="trk-head-copy">
      <span class="tag hot">${t('tracker.eyebrow', lang)}</span>
      <h1>${t('tracker.h1', lang)}</h1>
      <p class="lede">${t('tracker.lede', lang)}</p>
      <div class="trk-live">
        <span class="tag" id="trk-live-tag">${t('tracker.updated', lang)}</span>
        <span class="tag trk-conn" id="trk-conn">${t('tracker.conn.poll', lang)}</span>
      </div>
      ${telegram ? `<div class="cta"><a class="btn btn-hot" href="${escapeHtml(telegram)}" target="_blank" rel="noopener">${t('tracker.telegram.cta', lang)}</a></div>` : ''}
    </div>
    <div class="trk-proof rv">
      <div><span class="tag hot">${t('tracker.proof.burn.label', lang)}</span><h3 class="mono trk-fig trk-fig-hot" id="trk-p-burn">—</h3><p>${t('tracker.proof.burn.sub', lang)}</p></div>
      <div><span class="tag hot">${t('tracker.proof.hr.label', lang)}</span><h3 class="mono trk-fig" id="trk-p-hr">—</h3><p>${t('tracker.proof.hr.sub', lang)}</p></div>
      <div><span class="tag hot">${t('tracker.proof.ws.label', lang)}</span><h3 class="mono trk-fig" id="trk-p-ws">—</h3><p>${t('tracker.proof.ws.sub', lang)}</p></div>
    </div>
  </header>

  <div class="trk-strip-wrap rv">
    <div class="trk-strip" id="trk-strip" role="img" aria-label="${t('tracker.strip.aria', lang)}">${'<i></i>'.repeat(STRIP_CELLS)}</div>
    <p class="tag trk-strip-cap">${t('tracker.strip.cap', lang)}</p>
  </div>

  <section class="sec trk-sec-tight" id="trk-feed-sec" aria-labelledby="trk-feed-h">
    <header class="sec-head rv">
      <span class="idx">LIVE</span>
      <h2 id="trk-feed-h">${t('tracker.feed.h2', lang)}</h2>
      <p>${t('tracker.feed.p', lang)}</p>
    </header>
    <ol class="trk-feed rv" id="trk-feed" aria-live="off"><li class="trk-feed-empty" id="trk-feed-empty">${t('tracker.feed.empty', lang)}</li></ol>
  </section>

  <section class="sec" aria-labelledby="trk-miners-h">
    <header class="sec-head rv">
      <span class="idx">${idx()}</span>
      <h2 id="trk-miners-h">${t('tracker.miners.h2', lang)}</h2>
    </header>
    <div class="plate rv" id="trk-miner-stats">
      ${tile(lang, t('tracker.miners.online.label', lang), 'trk-online', 'tracker.miners.total.label')}
      ${tile(lang, t('tracker.hashrate.sha.label', lang), 'trk-hr-sha', 'tracker.hashrate.sha.label')}
      ${tile(lang, t('tracker.hashrate.scrypt.label', lang), 'trk-hr-scrypt', 'tracker.hashrate.scrypt.label')}
      ${tile(lang, t('tracker.hashrate.kawpow.label', lang), 'trk-hr-kawpow', 'tracker.hashrate.kawpow.label')}
    </div>
    <div class="plate rv trk-plate-next">
      ${tile(lang, t('tracker.shares.valid.label', lang), 'trk-sh-valid', 'tracker.shares.valid.label')}
      ${tile(lang, t('tracker.shares.stale.label', lang), 'trk-sh-stale', 'tracker.shares.stale.label')}
      ${tile(lang, t('tracker.shares.invalid.label', lang), 'trk-sh-invalid', 'tracker.shares.invalid.label')}
      ${tile(lang, t('tracker.miners.total.label', lang), 'trk-total', 'tracker.miners.online.label')}
    </div>
    <div class="trk-sub rv">
      <h3 class="trk-h3">${t('tracker.top.h2', lang)}</h3>
      <p class="note">${t('tracker.top.p', lang)}</p>
      <div class="dtable trk-gap">
        <table>
          <thead><tr>
            <th>${t('tracker.top.rank', lang)}</th>
            <th>${t('tracker.top.rig', lang)}</th>
            <th>${t('tracker.top.miner', lang)}</th>
            <th>${t('tracker.table.algorithm', lang)}</th>
            <th>${t('tracker.table.hashrate', lang)}</th>
            <th>${t('tracker.top.share', lang)}</th>
          </tr></thead>
          <tbody id="trk-top-body"><tr><td colspan="6">${t('tracker.loading', lang)}</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="dtable rv trk-gap">
      <table>
        <thead><tr>
          <th>${t('tracker.table.worker', lang)}</th>
          <th>${t('tracker.table.algorithm', lang)}</th>
          <th>${t('tracker.table.hashrate', lang)}</th>
          <th>${t('tracker.table.shares', lang)}</th>
          <th>${t('tracker.table.lastshare', lang)}</th>
          <th>${t('tracker.table.status', lang)}</th>
        </tr></thead>
        <tbody id="trk-workers-body"><tr><td colspan="6">${t('tracker.loading', lang)}</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="sec" aria-labelledby="trk-chart-h">
    <header class="sec-head rv">
      <span class="idx">${idx()}</span>
      <h2 id="trk-chart-h">${t('tracker.chart.h2', lang)}</h2>
    </header>
    ${tabs(lang, 'trk-hr-tabs', RANGES, '24h')}
    <div class="chart rv" id="trk-chart" role="img" aria-label="${t('tracker.chart.aria', lang)}">
      <p class="note" id="trk-chart-status">${t('tracker.loading', lang)}</p>
    </div>
    <p class="tag trk-readout" id="trk-chart-readout">&nbsp;</p>
  </section>

  <section class="sec" aria-labelledby="trk-ws-h">
    <header class="sec-head rv">
      <span class="idx">${idx()}</span>
      <h2 id="trk-ws-h">${t('tracker.workshares.h2', lang)}</h2>
      <p>${t('tracker.workshares.p', lang)}</p>
    </header>
    <div class="plate rv">
      ${tile(lang, t('tracker.workshares.count24h', lang), 'trk-ws-24h', 'tracker.workshares.count24h')}
      ${tile(lang, t('tracker.workshares.luck.avg', lang), 'trk-luck-avg', 'tracker.workshares.luck.avg')}
      ${tile(lang, t('tracker.workshares.luck.best', lang), 'trk-luck-best', 'tracker.workshares.luck.best')}
    </div>
    <div class="trk-sub rv">
      <h3 class="trk-h3">${t('tracker.luck.h3', lang)}</h3>
      <p class="note">${t('tracker.luck.p', lang)}</p>
      ${tabs(lang, 'trk-ws-tabs', ['24h', '7d'], '24h')}
      <div class="chart" id="trk-luck-chart" role="img" aria-label="${t('tracker.luck.aria', lang)}">
        <p class="note" id="trk-luck-status">${t('tracker.loading', lang)}</p>
      </div>
      <p class="tag trk-readout" id="trk-luck-readout">&nbsp;</p>
    </div>
    <div class="dtable rv trk-gap">
      <table>
        <thead><tr>
          <th>${t('tracker.workshares.table.height', lang)}</th>
          <th>${t('tracker.workshares.table.time', lang)}</th>
          <th>${t('tracker.workshares.table.worker', lang)}</th>
          <th>${t('tracker.workshares.table.algorithm', lang)}</th>
        </tr></thead>
        <tbody id="trk-ws-body"><tr><td colspan="4">${t('tracker.loading', lang)}</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="sec" aria-labelledby="trk-rewards-h">
    <header class="sec-head rv">
      <span class="idx">${idx()}</span>
      <h2 id="trk-rewards-h">${t('tracker.rewards.h2', lang)}</h2>
    </header>
    <div class="plate rv">
      ${tile(lang, t('tracker.rewards.locked.label', lang), 'trk-locked', 'tracker.rewards.locked.sub')}
      ${tile(lang, t('tracker.rewards.unlocked.label', lang), 'trk-unlocked', 'tracker.rewards.unlocked.sub')}
      ${tile(lang, t('tracker.rewards.nextunlock.label', lang), 'trk-nextunlock', 'tracker.rewards.nextunlock.basis')}
      ${tile(lang, t('tracker.rewards.burned.label', lang), 'trk-burned', 'home.band.burned.loading')}
    </div>
    <p class="note"><a href="https://quaiscan.io/address/${config.vault || ''}" target="_blank" rel="noopener">${t('tracker.rewards.burned.link', lang)}</a></p>
    <div class="trk-sub rv">
      <h3 class="trk-h3">${t('tracker.schedule.h3', lang)}</h3>
      <p class="note">${t('tracker.schedule.p', lang)}</p>
      <div class="dtable trk-gap">
        <table>
          <thead><tr>
            <th>${t('tracker.schedule.day', lang)}</th>
            <th>${t('tracker.schedule.count', lang)}</th>
            <th>${t('tracker.schedule.unlock', lang)}</th>
          </tr></thead>
          <tbody id="trk-schedule-body"><tr><td colspan="3">${t('tracker.loading', lang)}</td></tr></tbody>
        </table>
      </div>
    </div>${burnChart}
  </section>
${feeLoop}
  <section class="sec" aria-labelledby="trk-check-h">
    <header class="sec-head rv">
      <span class="idx">${idx()}</span>
      <h2 id="trk-check-h">${t('tracker.check.h2', lang)}</h2>
      <p>${t('tracker.check.p', lang)}</p>
    </header>
    <div class="rig rv">
      <div class="field">
        <label for="trk-check-addr">${t('tracker.check.label', lang)}</label>
        <input id="trk-check-addr" type="text" spellcheck="false" autocomplete="off" placeholder="${t('tracker.check.placeholder', lang)}">
        <div class="err" id="trk-check-err" role="alert"></div>
      </div>
      <button type="button" class="btn btn-hot" id="trk-check-go">${t('tracker.check.go', lang)}</button>
    </div>
    <p class="tag trk-showing" id="trk-check-showing">${t('tracker.check.showing', lang)} <b id="trk-check-addr-out">—</b></p>
    <p class="trk-showing"><button type="button" class="btn" id="trk-check-reset" hidden>${t('tracker.check.reset', lang)}</button></p>
  </section>
${share}`;
  return body.replace(/__IDX__/g, () => String(++n).padStart(2, '0'));
}

// ---------------------------------------------------------------------------------------------------------------
// the policy the page runs under
// ---------------------------------------------------------------------------------------------------------------
/** The https origin (scheme, host, port) of a configured URL. Throws, naming the problem, on anything else. */
export function originOf(url) {
  let u = null;
  try { u = new URL(String(url)); } catch { /* reported below */ }
  if (!u) throw new Error(`config: ${JSON.stringify(url)} is not a URL`);
  if (u.protocol !== 'https:') throw new Error(`config: ${JSON.stringify(url)} must be an https URL`);
  return u.origin;
}

/** The secure WebSocket origin of the same host and port as an https config URL (the live feed uses the RPC's socket). */
export function wssOrigin(url) {
  return originOf(url).replace(/^https:/, 'wss:');
}

/**
 * The CSP: scripts, styles, fonts and everything else from this origin only, and fetches to exactly what the page reads
 * (the Quai RPC, its WebSocket for the live feed, and the pool API, from the config). `meta: true` leaves out frame-ancestors, which
 * a <meta> tag cannot carry.
 */
export function contentSecurityPolicy(config, { meta = false } = {}) {
  const connect = ["'self'", ...new Set([originOf(config.rpc), wssOrigin(config.rpc), originOf(config.stratumxApi)])];
  const directives = [
    "default-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (!meta) directives.push("frame-ancestors 'none'");
  return directives.join('; ');
}

/** The text of dist/_headers (Cloudflare Pages and Netlify format). */
export function headersFile(config) {
  return [
    '/*',
    `  Content-Security-Policy: ${contentSecurityPolicy(config)}`,
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '',
    '/fonts/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------------------------------------------
/** One complete HTML document. `version` is package.json's version; it goes in a meta tag and the asset URLs. */
export function renderPage({ lang, config, version }) {
  if (!LANGS.includes(lang)) throw new Error(`unknown language "${lang}"`);
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`version "${version}" is not x.y.z`);
  const title = escapeText(t('tracker.title', lang));
  const description = escapeAttr(t('tracker.description', lang));
  const asset = (path) => `${path}?v=${version}`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(contentSecurityPolicy(config, { meta: true }))}">
<meta name="referrer" content="no-referrer">
<meta name="application-version" content="${version}">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="theme-color" content="#0D0908">
<link rel="icon" href="data:,">
<link rel="alternate" hreflang="en" href="/">
<link rel="alternate" hreflang="tr" href="/tr/">
<link rel="preload" as="font" type="font/woff2" href="/fonts/big-shoulders-display-latin-900-normal.woff2" crossorigin>
<link rel="preload" as="font" type="font/woff2" href="/fonts/ibm-plex-sans-latin-400-normal.woff2" crossorigin>
<link rel="stylesheet" href="${asset('/assets/tracker.css')}">
</head>
<body>
<header class="top">
  <div class="wrap bar">
    <a class="skip-link" href="#main">${t('nav.skip', lang)}</a>
    <div class="brand">
      <a class="brand-mark" href="${lang === 'tr' ? '/tr/' : '/'}" aria-label="QuaiAxe"><span class="brand-word" lang="en">QuaiAxe</span></a>
    </div>
    <span class="sp"></span>
    <span class="chain" title="Quai Cyprus-1">
      <span class="beat" id="beat" aria-hidden="true"></span>
      <span>${t('nav.chain.block', lang)}</span>
      <b class="mono" id="height">—</b>
    </span>
    <div class="lang" role="group" aria-label="${t('nav.lang.switch.aria', lang)}">
      <a href="/" hreflang="en" aria-pressed="${lang === 'en'}">EN</a>
      <a href="/tr/" hreflang="tr" aria-pressed="${lang === 'tr'}">TR</a>
    </div>
  </div>
</header>
<main id="main">
<div class="wrap">
${renderTracker(lang, config)}
</div>
</main>
<footer class="foot">
  <div class="wrap">
    <p class="note">${t('footer.disclaimer', lang)}</p>
  </div>
</footer>
<script src="${asset('/assets/page.js')}"></script>
<script type="module" src="${asset('/assets/tracker.js')}"></script>
</body>
</html>
`;
}

/** The 404 page: no script, the same policy, a way back. */
export function renderNotFound({ config, version }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(contentSecurityPolicy(config, { meta: true }))}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>404 — not found</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/assets/tracker.css?v=${version}">
</head>
<body>
<main id="main">
<div class="wrap">
  <header class="page-head">
    <span class="tag hot">404</span>
    <h1>Not found</h1>
    <p class="lede">There is nothing at this address. <a href="/">Back to the tracker</a>.</p>
  </header>
</div>
</main>
</body>
</html>
`;
}
