// The page itself (src/page.mjs): no inline style, no inline script, data blocks nothing can break out of, the
// policy in the document, the burn tile that counts mining burns only, and a stylesheet rule for every class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGS, contentSecurityPolicy, jsonForScript, renderPage, renderTracker, t } from '../src/page.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const CONFIG = JSON.parse(read('config.example.json'));
const CSS = read('assets/tracker.css');
const TRACKER_JS = read('assets/tracker.js');
const VERSION = JSON.parse(read('package.json')).version;
const page = (lang, config = CONFIG) => renderPage({ lang, config, version: VERSION });
const INLINE_STYLE = /\sstyle\s*=|<style[\s>]/i;
const https = (rest) => ['https', '://', rest].join('');

for (const lang of LANGS) {
  test(`the ${lang} document is complete and carries its language, title, description and version`, () => {
    const html = page(lang);
    assert.match(html, /^<!doctype html>\n<html lang="/);
    assert.ok(html.includes(`<html lang="${lang}">`));
    assert.ok(html.includes(`<title>${t('tracker.title', lang)}</title>`));
    assert.ok(html.includes(`<meta name="description" content="${t('tracker.description', lang)}">`));
    assert.ok(html.includes(`<meta name="application-version" content="${VERSION}">`));
    assert.doesNotMatch(html, /undefined|\[object|NaN/);
    assert.ok(html.includes(t('footer.disclaimer', lang)), 'the footer carries the disclaimer');
    assert.ok(html.includes(t('nav.skip', lang)), 'the skip link is there');
  });
  test(`the ${lang} page has no inline style, no inline event handler and no inline script code`, () => {
    const html = page(lang);
    assert.ok(!INLINE_STYLE.test(html), 'inline style');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handler');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const inline = scripts.filter((s) => !/\bsrc=/.test(s[1]));
    assert.deepEqual(inline.map((s) => (s[1].match(/id="([^"]+)"/) || [])[1]), ['trk-i18n', 'trk-config'], 'only the two JSON data blocks are inline');
    for (const s of inline) assert.match(s[1], /type="application\/json"/);
    const external = scripts.filter((s) => /\bsrc=/.test(s[1])).map((s) => s[1].match(/src="([^"]+)"/)[1]);
    assert.deepEqual(external, [`/assets/page.js?v=${VERSION}`, `/assets/tracker.js?v=${VERSION}`]);
  });
  test(`the ${lang} page links only to this origin, to quaiscan.io and to the language twin`, () => {
    const html = page(lang);
    for (const m of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
      const url = m[1];
      assert.ok(url.startsWith('/') || url.startsWith('#') || url === 'data:,' || url.startsWith(https('quaiscan.io/')), `unexpected link target ${url}`);
    }
    const rels = [...html.matchAll(/target="_blank"[^>]*>/g)];
    for (const r of rels) assert.match(r[0], /rel="noopener"/);
  });
  test(`the ${lang} page keeps every id unique`, () => {
    const ids = [...page(lang).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
  });
}

test('the policy in the document is the same policy the headers carry, and it comes before any script or stylesheet', () => {
  const html = page('en');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
  assert.ok(meta, 'no CSP meta tag');
  assert.equal(meta[1], contentSecurityPolicy(CONFIG, { meta: true }));
  assert.ok(html.indexOf(meta[0]) < html.indexOf('<link rel="stylesheet"'));
  assert.ok(html.indexOf(meta[0]) < html.indexOf('<script'));
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
});
test('the language switch points at the two pages and marks the current one', () => {
  const en = page('en');
  const tr = page('tr');
  assert.match(en, /<a href="\/" hreflang="en" aria-pressed="true">EN<\/a>\s*<a href="\/tr\/" hreflang="tr" aria-pressed="false">TR<\/a>/);
  assert.match(tr, /<a href="\/" hreflang="en" aria-pressed="false">EN<\/a>\s*<a href="\/tr\/" hreflang="tr" aria-pressed="true">TR<\/a>/);
  for (const html of [en, tr]) {
    assert.ok(html.includes('<link rel="alternate" hreflang="en" href="/">'));
    assert.ok(html.includes('<link rel="alternate" hreflang="tr" href="/tr/">'));
  }
});
test('renderPage refuses an unknown language or a version that is not x.y.z', () => {
  assert.throws(() => renderPage({ lang: 'de', config: CONFIG, version: VERSION }), /language/);
  for (const version of ['1.0', 'v1.0.0', '', undefined, '1.0.0"><script>']) assert.throws(() => renderPage({ lang: 'en', config: CONFIG, version }), /version/);
});

// ---- the data blocks ----
test('jsonForScript escapes every < so a value can never close or open a script element', () => {
  const hostile = { a: '</script><script>alert(1)</script>', b: '<!--', c: ['<', '<<'], d: 'plain & "quoted"' };
  const out = jsonForScript(hostile);
  assert.ok(!out.includes('<'), 'a raw < is left in the output');
  assert.deepEqual(JSON.parse(out), hostile, 'the escaped text parses back to the same value');
  assert.equal(jsonForScript({ n: 1, s: 'x' }), '{"n":1,"s":"x"}', 'ordinary data is untouched');
});
test('both data blocks hold only escaped JSON, even when a config value tries to break out', () => {
  const hostile = { ...CONFIG, stratumxApi: `${https('api.example/')}</script><script>alert(1)</script>`, rpc: `${https('rpc.example/')}<!--` };
  const html = renderTracker('en', hostile);
  assert.equal((html.match(/<script/gi) || []).length, 2, 'a config value injected a script tag');
  const blocks = [...html.matchAll(/<script type="application\/json" id="(trk-[a-z0-9-]+)">([\s\S]*?)<\/script>/g)];
  assert.deepEqual(blocks.map((b) => b[1]), ['trk-i18n', 'trk-config']);
  for (const [, id, body] of blocks) assert.ok(!body.includes('<'), `#${id} holds a raw <`);
  const cfg = JSON.parse(blocks[1][2]);
  assert.equal(cfg.stratumxApi, hostile.stratumxApi, 'the value survives the round trip');
  assert.deepEqual(Object.keys(cfg).sort(), ['qaxeToken', 'rpc', 'stratumxApi', 'trackedAddresses', 'vault'], 'the page script reads exactly these keys');
});

// ---- the burn tile ----
test('the burn tile is the mining figure only: named as mining in both languages, read from the vault, never a token-wide total', () => {
  for (const lang of LANGS) assert.match(t('tracker.rewards.burned.label', lang), /mining|madencilik/i);
  assert.match(TRACKER_JS, /rpcCall\('eth_call', \[\{ to: CONFIG\.vault, data: '0xd157e301' \}, 'latest'\]\)/, 'the tile reads totalTokensBurned() on the vault');
  assert.doesNotMatch(TRACKER_JS, /api\/token\/|burnedWei|totalSupply|0x18160ddd/, 'no token-wide burn figure on the tracker');
  const html = renderTracker('en', CONFIG);
  assert.ok(html.includes(`https://quaiscan.io/address/${CONFIG.vault}`), 'the vault link');
});

// ---- the stylesheet ----
test('every class the page uses has a rule in tracker.css, and so do the chart labels the script creates', () => {
  const used = new Set();
  for (const lang of LANGS) for (const m of page(lang).matchAll(/\bclass="([^"]*)"/g)) for (const c of m[1].split(/\s+/).filter(Boolean)) used.add(c);
  assert.ok(used.has('trk-gap') && used.has('plate') && used.has('chain'));
  const missing = [...used].filter((c) => !new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(CSS));
  assert.deepEqual(missing, []);
  for (const c of ['lab', 'lab-x', 'lab-y']) assert.ok(new RegExp(`\\.chart \\.${c}(?![A-Za-z0-9_-])`).test(CSS), `no rule for .chart .${c}`);
  for (const c of ['in', 'live', 'on', 'off']) assert.ok(new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(CSS), `no rule for the class the scripts add: .${c}`);
});
test('the stylesheet carries no inline-style workarounds and references only files that ship', () => {
  assert.doesNotMatch(CSS, /@import|expression\(|javascript:/i);
  const urls = [...CSS.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, ''));
  assert.ok(urls.length >= 16);
  for (const u of urls) assert.match(u, /^\/fonts\/[a-z0-9-]+\.woff2$/, u);
});
