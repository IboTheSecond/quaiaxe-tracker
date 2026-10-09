// src/page.mjs - the whole page. The tracker body below is the same markup quaiaxe.com serves at /tracker (a
// test in the upstream repository keeps the two identical), inside a one-page shell: a header with the live block
// height and the EN/TR switch, and a footer. The Content-Security-Policy the page must run under is defined here
// too, next to the markup it constrains, and written both as an HTTP header (dist/_headers) and as a <meta> tag.
// Node reads this file at build time; nothing in it reaches the browser.
import { readFileSync } from 'node:fs';

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
/** A stat tile using the `.plate` grid. */
function tile(lang, tagText, id, subKey) {
  return `<div><span class="tag hot">${tagText}</span><h3 class="mono" id="${id}">—</h3><p>${t(subKey, lang)}</p></div>`;
}

/**
 * JSON for a <script type="application/json"> data block. JSON.stringify leaves "<" alone, so a value
 * holding "</script>" or "<!--" would end or confuse the block. The JSON escape for U+003C (written
 * out in the replace below) is the same character to JSON.parse and can never be markup.
 */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderTracker(lang, config) {
  const i18nKeys = [
    'tracker.updated', 'tracker.paused', 'tracker.unavailable', 'tracker.loading',
    'tracker.miners.online.label', 'tracker.miners.total.label',
    'tracker.hashrate.sha.label', 'tracker.hashrate.scrypt.label', 'tracker.hashrate.kawpow.label',
    'tracker.shares.valid.label', 'tracker.shares.stale.label', 'tracker.shares.invalid.label',
    'tracker.table.empty', 'tracker.status.online', 'tracker.status.offline',
    'tracker.workshares.count24h', 'tracker.workshares.luck.avg', 'tracker.workshares.luck.best',
    'tracker.workshares.table.empty', 'tracker.workshares.viewblock',
    'tracker.chart.empty',
    'tracker.rewards.locked.label', 'tracker.rewards.unlocked.label', 'tracker.rewards.nextunlock.label',
    'tracker.rewards.nextunlock.basis', 'tracker.rewards.nextunlock.none', 'tracker.rewards.burned.label',
    'tracker.check.err', 'tracker.check.showing', 'tracker.check.default',
    'home.band.burned.loading',
  ];
  const i18n = Object.fromEntries(i18nKeys.map((k) => [k, t(k, lang)]));
  return `
  <script type="application/json" id="trk-i18n">${jsonForScript(i18n)}</script>
  <script type="application/json" id="trk-config">${jsonForScript({ trackedAddresses: config.trackedAddresses || [], stratumxApi: config.stratumxApi, rpc: config.rpc, vault: config.vault, qaxeToken: config.qaxeToken })}</script>
  <header class="page-head">
    <span class="tag hot">${t('tracker.eyebrow', lang)}</span>
    <h1>${t('tracker.h1', lang)}</h1>
    <p class="lede">${t('tracker.lede', lang)}</p>
    <div class="tag" id="trk-live-tag">${t('tracker.updated', lang)}</div>
  </header>

  <section class="sec" aria-labelledby="trk-miners-h">
    <header class="sec-head rv">
      <span class="idx">01</span>
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

  <section class="sec" aria-labelledby="trk-ws-h">
    <header class="sec-head rv">
      <span class="idx">02</span>
      <h2 id="trk-ws-h">${t('tracker.workshares.h2', lang)}</h2>
      <p>${t('tracker.workshares.p', lang)}</p>
    </header>
    <div class="plate rv">
      ${tile(lang, t('tracker.workshares.count24h', lang), 'trk-ws-24h', 'tracker.workshares.count24h')}
      ${tile(lang, t('tracker.workshares.luck.avg', lang), 'trk-luck-avg', 'tracker.workshares.luck.avg')}
      ${tile(lang, t('tracker.workshares.luck.best', lang), 'trk-luck-best', 'tracker.workshares.luck.best')}
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

  <section class="sec" aria-labelledby="trk-chart-h">
    <header class="sec-head rv">
      <span class="idx">03</span>
      <h2 id="trk-chart-h">${t('tracker.chart.h2', lang)}</h2>
    </header>
    <div class="chart rv" id="trk-chart" role="img" aria-label="${t('tracker.chart.aria', lang)}">
      <p class="note" id="trk-chart-status">${t('tracker.loading', lang)}</p>
    </div>
    <p class="tag" id="trk-chart-readout">&nbsp;</p>
  </section>

  <section class="sec" aria-labelledby="trk-rewards-h">
    <header class="sec-head rv">
      <span class="idx">04</span>
      <h2 id="trk-rewards-h">${t('tracker.rewards.h2', lang)}</h2>
    </header>
    <div class="plate rv">
      ${tile(lang, t('tracker.rewards.locked.label', lang), 'trk-locked', 'tracker.rewards.locked.sub')}
      ${tile(lang, t('tracker.rewards.unlocked.label', lang), 'trk-unlocked', 'tracker.rewards.unlocked.sub')}
      ${tile(lang, t('tracker.rewards.nextunlock.label', lang), 'trk-nextunlock', 'tracker.rewards.nextunlock.basis')}
      ${tile(lang, t('tracker.rewards.burned.label', lang), 'trk-burned', 'home.band.burned.loading')}
    </div>
    <p class="note"><a href="https://quaiscan.io/address/${config.vault || ''}" target="_blank" rel="noopener">${t('tracker.rewards.burned.link', lang)}</a></p>
  </section>

  <section class="sec" aria-labelledby="trk-check-h">
    <header class="sec-head rv">
      <span class="idx">05</span>
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
  </section>
`;
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

/**
 * The CSP: scripts, styles, fonts and everything else from this origin only, and fetches to exactly the two hosts
 * the page reads (the Quai RPC and the pool API, from the config). `meta: true` leaves out frame-ancestors, which
 * a <meta> tag cannot carry.
 */
export function contentSecurityPolicy(config, { meta = false } = {}) {
  const connect = ["'self'", ...new Set([originOf(config.rpc), originOf(config.stratumxApi)])];
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
