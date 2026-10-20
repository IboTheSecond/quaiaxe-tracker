// scripts/build.mjs: what dist/ contains, that it is the same every time, that a bad config stops the build
// without touching a good dist/, and that nothing in the output can reach a host the config does not name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, loadConfig, validateConfig } from '../scripts/build.mjs';
import { headersFile } from '../src/page.mjs';
import { scanTree } from '../scripts/scan-leaks.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const CONFIG = JSON.parse(read('config.example.json'));
const https = (rest) => ['https', '://', rest].join('');
const freshDir = (name) => join(mkdtempSync(join(tmpdir(), `tracker-${name}-`)), 'dist');

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) listFiles(p, base, out); else out.push(p.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}
const digest = (dir) => {
  const h = createHash('sha256');
  for (const f of listFiles(dir)) h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
  return h.digest('hex');
};
/** A throwaway copy of the project (not dist, node_modules or .git), optionally changed by `edit(root)`. */
function copyProject(edit) {
  const root = mkdtempSync(join(tmpdir(), 'tracker-root-'));
  cpSync(ROOT, root, { recursive: true, filter: (src) => !/[\\/](?:dist|node_modules|\.git)(?:[\\/]|$)/.test(src) });
  if (edit) edit(root);
  return root;
}
const writeConfig = (root, config, name = 'config.json') => writeFileSync(join(root, name), `${JSON.stringify(config, null, 2)}\n`);

const FONTS = readdirSync(join(ROOT, 'fonts')).sort();
const EXPECTED = [
  '404.html', '_headers', 'assets/lib/tracker-lib.js', 'assets/page.js', 'assets/tracker.css', 'assets/tracker.js', 'index.html',
  ...FONTS.map((f) => `fonts/${f}`), 'tr/index.html',
].sort();

test('dist/ holds exactly the two pages, a 404 page, the headers file, the assets and the fonts', async () => {
  const outDir = freshDir('files');
  const result = await build({ outDir });
  assert.deepEqual(listFiles(outDir), EXPECTED);
  assert.deepEqual(result.files, EXPECTED);
  assert.equal(FONTS.filter((f) => f.endsWith('.woff2')).length, 16);
  assert.equal(FONTS.filter((f) => f.startsWith('LICENSE')).length, 3, 'the font licences ship with the fonts');
});
test('the build is deterministic: two builds are byte for byte the same', async () => {
  const a = freshDir('a');
  const b = freshDir('b');
  await build({ outDir: a });
  await build({ outDir: b });
  assert.equal(digest(a), digest(b));
});
test('the assets are the repository files, byte for byte', async () => {
  const outDir = freshDir('assets');
  await build({ outDir });
  for (const [from, to] of [['assets/tracker.js', 'assets/tracker.js'], ['assets/page.js', 'assets/page.js'], ['assets/tracker.css', 'assets/tracker.css'], ['src/lib/tracker-lib.js', 'assets/lib/tracker-lib.js']]) {
    assert.ok(readFileSync(join(ROOT, from)).equals(readFileSync(join(outDir, to))), `${to} differs from ${from}`);
  }
});
test('both pages carry the config the page script reads, and _headers is built from the same config', async () => {
  const outDir = freshDir('config');
  await build({ outDir });
  assert.equal(read('config.example.json') === JSON.stringify(CONFIG, null, 2) + '\n', true, 'config.example.json is written the way the exporter writes it');
  for (const [file, lang] of [['index.html', 'en'], ['tr/index.html', 'tr']]) {
    const html = readFileSync(join(outDir, file), 'utf8');
    assert.ok(html.includes(`<html lang="${lang}">`));
    const block = html.match(/<script type="application\/json" id="trk-config">(.*?)<\/script>/)[1];
    assert.deepEqual(JSON.parse(block), CONFIG);
  }
  assert.equal(readFileSync(join(outDir, '_headers'), 'utf8'), headersFile(CONFIG));
});
test('config.json, when present, replaces config.example.json everywhere: the page data, the policy and the headers', async () => {
  const mine = { ...CONFIG, rpc: https('node.example:8545/cyprus1'), stratumxApi: https('pool.example/api'), trackedAddresses: [CONFIG.vault] };
  const root = copyProject((r) => writeConfig(r, mine));
  const outDir = freshDir('mine');
  await build({ root, outDir });
  const html = readFileSync(join(outDir, 'index.html'), 'utf8');
  assert.deepEqual(JSON.parse(html.match(/id="trk-config">(.*?)<\/script>/)[1]), mine);
  assert.ok(html.includes(`connect-src 'self' ${https('node.example:8545')} ${https('pool.example')};`));
  for (const url of [CONFIG.rpc, CONFIG.stratumxApi]) assert.ok(!html.includes(new URL(url).hostname), `${new URL(url).hostname} of the example config is left in the page`);
  assert.equal(readFileSync(join(outDir, '_headers'), 'utf8'), headersFile(mine));
});

// ---- config validation ----
test('a config with a missing key, an extra key, a non-https URL, a bad address or no address is refused, naming the file', async () => {
  const bad = [
    [{ ...CONFIG, rpc: undefined }, /rpc/],
    [{ ...CONFIG, extra: 1 }, /unknown key "extra"/],
    [{ ...CONFIG, rpc: ['http', '://', 'rpc.example/x'].join('') }, /rpc.*https/],
    [{ ...CONFIG, stratumxApi: https(['user:pw', 'pool.example/api'].join('@')) }, /stratumxApi/],
    [{ ...CONFIG, vault: '0x1234' }, /vault/],
    [{ ...CONFIG, qaxeToken: undefined }, /qaxeToken/],
    [{ ...CONFIG, trackedAddresses: [] }, /trackedAddresses/],
    [{ ...CONFIG, trackedAddresses: ['not an address'] }, /trackedAddresses/],
    [{ ...CONFIG, trackedAddresses: 'single' }, /trackedAddresses/],
  ];
  for (const [config, want] of bad) {
    assert.throws(() => validateConfig(config, 'config.json'), (e) => /^config\.json: /.test(e.message) && want.test(e.message), JSON.stringify(config));
    const root = copyProject((r) => writeConfig(r, config));
    await assert.rejects(build({ root, outDir: freshDir('bad') }), want);
  }
  assert.doesNotThrow(() => validateConfig(CONFIG, 'config.example.json'));
});
test('a config.json that is not JSON stops the build, naming the file', async () => {
  const root = copyProject((r) => writeFileSync(join(r, 'config.json'), '{ nope'));
  await assert.rejects(loadConfig(root), /^Error: config\.json: /);
});
test('a package.json without an x.y.z version stops the build', async () => {
  const root = copyProject((r) => writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'x', version: 'one' })));
  await assert.rejects(build({ root, outDir: freshDir('ver') }), /version/);
});

// ---- the output ----
test('every asset and font the output refers to exists in dist/, and every font in dist/ is used', async () => {
  const outDir = freshDir('refs');
  await build({ outDir });
  const have = new Set(listFiles(outDir));
  const refs = new Set();
  for (const file of ['index.html', 'tr/index.html', '404.html']) {
    for (const m of readFileSync(join(outDir, file), 'utf8').matchAll(/\b(?:href|src)="(\/[^"?#]*)/g)) refs.add(m[1]);
  }
  for (const m of readFileSync(join(outDir, 'assets/tracker.css'), 'utf8').matchAll(/url\((\/[^)]+)\)/g)) refs.add(m[1]);
  refs.add(readFileSync(join(outDir, 'assets/tracker.js'), 'utf8').match(/from '(\/assets\/lib\/tracker-lib\.js)'/)[1]);
  for (const r of refs) {
    if (r === '/' || r === '/tr/') continue;
    assert.ok(have.has(r.slice(1)), `${r} is referenced but not in dist/`);
  }
  for (const f of FONTS.filter((n) => n.endsWith('.woff2'))) assert.ok(refs.has(`/fonts/${f}`), `fonts/${f} ships but is never used`);
});
test('the shipped scripts keep nothing in the browser and run no dynamic code', async () => {
  const outDir = freshDir('privacy');
  await build({ outDir });
  for (const f of ['assets/tracker.js', 'assets/page.js', 'assets/lib/tracker-lib.js']) {
    const src = readFileSync(join(outDir, f), 'utf8');
    assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie|\bcaches\b|serviceWorker|sendBeacon|WebSocket|XMLHttpRequest|importScripts/, `${f} stores or sends something it should not`);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(|document\.write\s*\(|setTimeout\s*\(\s*['"`]/, `${f} runs dynamic code`);
  }
});
test('the only hosts anywhere in the output are the pool, the RPC and the explorer links', async () => {
  const outDir = freshDir('hosts');
  await build({ outDir });
  const hosts = new Set();
  for (const f of listFiles(outDir).filter((n) => !n.startsWith('fonts/'))) {
    for (const m of readFileSync(join(outDir, f), 'utf8').matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)) hosts.add(m[1].toLowerCase());
  }
  assert.deepEqual([...hosts].sort(), [new URL(CONFIG.stratumxApi).hostname, 'quaiscan.io', new URL(CONFIG.rpc).hostname].sort());
});
test('the built output passes the leak scan, including the address and host allowlists', async () => {
  const outDir = freshDir('scan');
  await build({ outDir });
  assert.deepEqual(scanTree(outDir), []);
});
test('the 404 page runs no script and carries the same policy', async () => {
  const outDir = freshDir('404');
  await build({ outDir });
  const html = readFileSync(join(outDir, '404.html'), 'utf8');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src /);
  assert.match(html, /404/);
});

// ---- a failed build leaves a good dist/ alone ----
test('a failed build leaves the previous dist/ as it was, and no scratch folder behind', async () => {
  const root = copyProject();
  const outDir = join(root, 'dist');
  await build({ root, outDir });
  const before = digest(outDir);
  writeFileSync(join(root, 'config.json'), '{ nope');
  await assert.rejects(build({ root, outDir }));
  assert.equal(digest(outDir), before);
  assert.deepEqual(readdirSync(root).filter((n) => n.includes('building')), []);
});

// ---- the command line ----
test('command line: builds into dist/ and exits 0; a bad config exits 1 with a message on stderr', () => {
  const root = copyProject();
  const ok = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /built \d+ files into dist/);
  assert.ok(existsSync(join(root, 'dist', 'index.html')));
  writeFileSync(join(root, 'config.json'), '{ nope');
  const bad = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /config\.json/);
  rmSync(root, { recursive: true, force: true });
});
