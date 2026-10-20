// scripts/serve.mjs: the local server that `npm start` runs. It must listen on this machine only, send the
// headers from dist/_headers, serve nothing outside dist/, and log nothing.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../scripts/build.mjs';
import { headersFor, parseHeadersFile, start } from '../scripts/serve.mjs';
import { contentSecurityPolicy } from '../src/page.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
const dist = join(mkdtempSync(join(tmpdir(), 'tracker-serve-')), 'dist');
await build({ outDir: dist });
writeFileSync(join(dirname(dist), 'canary.txt'), 'OUTSIDE-DIST-CANARY'); // next to dist/, so a way out would find it
const { server, port } = await start({ root: dist, port: 0 });
after(() => server.close());

/** One raw request. `path` is sent exactly as given (no normalisation by the client). */
function get(path, { method = 'GET', host = `127.0.0.1:${port}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const file = (name) => readFileSync(join(dist, name));

test('the server listens on this machine only', () => {
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(server.address().family, 'IPv4');
});
test('GET / serves the English page with the headers from _headers', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.ok(r.body.equals(file('index.html')));
  assert.equal(r.headers['content-security-policy'], contentSecurityPolicy(CONFIG));
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(Number(r.headers['content-length']), r.body.length);
});
test('GET /tr/ serves the Turkish page and /tr redirects to it', async () => {
  const page = await get('/tr/');
  assert.equal(page.status, 200);
  assert.ok(page.body.equals(file('tr/index.html')));
  const redirect = await get('/tr');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/tr/');
  assert.equal((await get('/tr?x=1')).headers.location, '/tr/?x=1');
});
test('the assets have the right content types, and a query string is ignored', async () => {
  assert.equal((await get('/assets/tracker.css?v=1.0.0')).headers['content-type'], 'text/css; charset=utf-8');
  assert.equal((await get('/assets/tracker.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get('/assets/lib/tracker-lib.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get('/?x=1')).status, 200);
});
test('a font gets the long cache header on top of the headers every file gets', async () => {
  const name = readdirSync(join(dist, 'fonts')).find((n) => n.endsWith('.woff2'));
  const r = await get(`/fonts/${name}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'font/woff2');
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(r.headers['content-security-policy'], contentSecurityPolicy(CONFIG));
  assert.ok(r.body.equals(file(`fonts/${name}`)));
});

test('the headers file is configuration, not content: it is never served', async () => {
  const r = await get('/_headers');
  assert.equal(r.status, 404);
  assert.ok(r.body.equals(file('404.html')), 'a request for _headers gets the 404 page');
  assert.ok(!r.body.toString().includes('/fonts/*'), 'the headers file text was served');
});
test('an unknown path gets the 404 page with a 404 status and the same headers', async () => {
  const r = await get('/no/such/page');
  assert.equal(r.status, 404);
  assert.ok(r.body.equals(file('404.html')));
  assert.equal(r.headers['content-security-policy'], contentSecurityPolicy(CONFIG));
  assert.equal((await get('/index.html/')).status, 404, 'a file with a trailing slash is not a folder');
});

const TRAVERSAL = [
  '/../canary.txt', '/..%2fcanary.txt', '/%2e%2e/canary.txt', '/%2e%2e%2fcanary.txt', '/assets/../../canary.txt',
  '/assets/%2e%2e%2f%2e%2e%2fcanary.txt', '/..%5ccanary.txt', '/assets/..%5c..%5ccanary.txt', '/%252e%252e%252fcanary.txt',
  '/index.html%00.txt', '/assets/tracker.css%00', '//canary.txt', '/\\canary.txt', '/C:/Windows/win.ini', '/assets/tracker.css::$DATA',
];
for (const path of TRAVERSAL) {
  test(`no way out of dist/: ${path}`, async () => {
    const r = await get(path);
    assert.ok([400, 404].includes(r.status), `status ${r.status}`);
    assert.ok(!r.body.toString().includes('OUTSIDE-DIST-CANARY'), 'served a file from outside dist/');
    assert.ok(!r.body.toString().includes('[fonts]'), 'served a system file');
  });
}

test('only GET and HEAD are served; HEAD sends the headers and no body', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await get('/', { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET, HEAD');
  }
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), file('index.html').length);
});
test('a request for another host name is refused (DNS rebinding), localhost and 127.0.0.1 are fine', async () => {
  assert.equal((await get('/', { host: 'evil.example' })).status, 421);
  assert.equal((await get('/', { host: `evil.example:${port}` })).status, 421);
  assert.equal((await get('/', { host: `localhost:${port}` })).status, 200);
  assert.equal((await get('/', { host: `127.0.0.1:${port}` })).status, 200);
});

// ---- the headers file parser ----
test('a header named in two matching blocks is sent once, the values joined with a comma', () => {
  const rules = parseHeadersFile(['/*', '  X-One: a', '  X-Two: only', '', '/area/*', '  X-One: b', ''].join('\n'));
  assert.deepEqual([...headersFor(rules, '/area/x.txt')].map(([k, v]) => `${k}: ${v}`), ['X-One: a, b', 'X-Two: only']);
  assert.deepEqual([...headersFor(rules, '/elsewhere')].map(([k, v]) => `${k}: ${v}`), ['X-One: a', 'X-Two: only']);
});
test('a patterns star matches any run of characters, including slashes; other characters are literal', () => {
  const rules = parseHeadersFile(['/a.b/*', '  X-A: 1', '/exact', '  X-B: 2', ''].join('\n'));
  assert.equal(headersFor(rules, '/a.b/deep/er').size, 1);
  assert.equal(headersFor(rules, '/aXb/deep').size, 0, 'the dot is a dot, not any character');
  assert.equal(headersFor(rules, '/exact').size, 1);
  assert.equal(headersFor(rules, '/exactly').size, 0);
});

// ---- starting ----
test('start() refuses a folder with no build in it, and says what to run', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'tracker-empty-'));
  await assert.rejects(start({ root: empty, port: 0 }), /npm run build/);
});

// ---- the command line ----
test('command line: prints the address once, sits on 127.0.0.1, and logs nothing for requests', async () => {
  // run the real script against a built dist/: copy the project (not dist, node_modules or .git), then build there
  const root = mkdtempSync(join(tmpdir(), 'tracker-cli-'));
  cpSync(ROOT, root, { recursive: true, filter: (src) => !/[\\/](?:dist|node_modules|\.git)(?:[\\/]|$)/.test(src) });
  await build({ root, outDir: join(root, 'dist') });
  const child = spawn(process.execPath, ['scripts/serve.mjs', '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no address printed: ${out}`)), 15000);
      const tick = setInterval(() => {
        const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) { clearInterval(tick); clearTimeout(timer); resolve(m[0]); }
      }, 50);
    });
    const before = out;
    const r = await fetch(url);
    assert.equal(r.status, 200);
    await fetch(`${url}no/such/thing`);
    await new Promise((r2) => setTimeout(r2, 300));
    assert.equal(out, before, 'the server printed something for a request');
  } finally { child.kill(); }
});
