#!/usr/bin/env node
// scripts/serve.mjs - the local server `npm start` runs: dist/ on http://127.0.0.1:8080/ (this machine only).
//
//   node scripts/serve.mjs [--port N]       (or PORT=N)
//
// It sends the headers from dist/_headers, so what you test here is what a host that reads that file (Cloudflare
// Pages, Netlify) will send. It serves files from dist/ and nothing else, never _headers itself, refuses other
// host names (so a web page cannot reach it by DNS rebinding), answers only GET and HEAD, and logs nothing.
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `_headers` text -> [{ pattern, headers: [[name, value], ...] }] in file order. */
export function parseHeadersFile(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { rules.push({ pattern: line.trim(), headers: [] }); continue; }
    const colon = line.indexOf(':');
    rules.at(-1).headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = (pattern, path) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(path);

/** Headers for a path: every matching block applies, and a name that appears twice is sent once, values joined with a comma. */
export function headersFor(rules, path) {
  const merged = new Map();
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      merged.set(key, merged.has(key) ? { name: merged.get(key).name, value: `${merged.get(key).value}, ${value}` } : { name, value });
    }
  }
  return new Map([...merged.values()].map((h) => [h.name, h.value]));
}

/** The static file for a request path inside `base`, or null. Nothing outside `base` can be reached. */
function resolveFile(base, pathname) {
  const segments = pathname.split('/').slice(1);
  const folderLike = segments[segments.length - 1] === '';
  if (folderLike) segments.pop();
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0') || s.includes('\\') || s.includes(':'))) return null;
  const target = join(base, ...segments, ...(folderLike ? ['index.html'] : []));
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (segments.length === 1 && segments[0] === '_headers') return null;
  let st;
  try { st = lstatSync(target); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  if (st.isFile()) return { path: target, size: st.size };
  if (st.isDirectory() && !folderLike && existsSync(join(target, 'index.html'))) return { redirect: `${pathname}/` };
  return null;
}

/** An http.Server (not listening yet) for the built folder `root`. Throws if root has no _headers file. */
export function createServer({ root }) {
  const base = resolve(root);
  const rules = parseHeadersFile(readFileSync(join(base, '_headers'), 'utf8'));
  const notFoundPage = existsSync(join(base, '404.html')) ? readFileSync(join(base, '404.html')) : Buffer.from('Not found\n');
  return createHttpServer((req, res) => {
    const reply = (status, body, extra = {}, path = '/') => {
      const headers = { ...Object.fromEntries(headersFor(rules, path)), ...extra };
      if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(host)) return reply(421, 'Misdirected request\n', { 'Content-Type': TYPES['.txt'] });
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'Method not allowed\n', { Allow: 'GET, HEAD', 'Content-Type': TYPES['.txt'] });
    if (!req.url || !req.url.startsWith('/')) return reply(400, 'Bad request\n', { 'Content-Type': TYPES['.txt'] });
    const cut = req.url.indexOf('?');
    const rawPath = cut < 0 ? req.url : req.url.slice(0, cut);
    const query = cut < 0 ? '' : req.url.slice(cut);
    let pathname;
    try { pathname = decodeURIComponent(rawPath); } catch { return reply(400, 'Bad request\n', { 'Content-Type': TYPES['.txt'] }); }
    const found = resolveFile(base, pathname);
    if (!found) return reply(404, notFoundPage, { 'Content-Type': TYPES['.html'] }, pathname);
    if (found.redirect) return reply(308, '', { Location: `${found.redirect}${query}` }, pathname);
    const headers = { ...Object.fromEntries(headersFor(rules, pathname)), 'Content-Type': TYPES[extname(found.path).toLowerCase()] || 'application/octet-stream', 'Content-Length': found.size };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return createReadStream(found.path).pipe(res);
  });
}

/** Starts the server on 127.0.0.1. Resolves to { server, port, url }. */
export function start({ root = join(ROOT, 'dist'), port = 0 } = {}) {
  return new Promise((resolveStart, reject) => {
    if (!existsSync(join(root, '_headers'))) { reject(new Error('dist/ has no build in it (run npm run build first)')); return; }
    const server = createServer({ root });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolveStart({ server, port: actual, url: `http://127.0.0.1:${actual}/` });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf('--port');
  const port = Number(flag > 0 ? process.argv[flag + 1] : (process.env.PORT ?? 8080));
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('serve: the port must be a number from 0 to 65535'); process.exit(2); }
  start({ port }).then(
    ({ url }) => console.log(`serving dist/ at ${url} (this machine only; Ctrl+C stops it)`),
    (error) => {
      console.error(error.code === 'EADDRINUSE' ? `serve: port ${port} is in use; try --port ${port + 1}` : `serve: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
