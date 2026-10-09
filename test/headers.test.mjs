// The Content-Security-Policy and the other response headers (src/page.mjs): scripts, styles, fonts and
// everything else from this origin only; fetches to exactly the two hosts in the config; no referrer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentSecurityPolicy, headersFile, originOf } from '../src/page.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
const https = (rest) => ['https', '://', rest].join('');

/** `_headers` text -> [{ path, headers: [[name, value], ...] }] in file order. */
function parseHeaders(text) {
  const blocks = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { blocks.push({ path: line.trim(), headers: [] }); continue; }
    const i = line.indexOf(':');
    blocks.at(-1).headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return blocks;
}
const header = (block, name) => block.headers.filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
/** CSP text -> { directive: [sources] } */
const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map(([name, ...src]) => [name, src]));

test('originOf keeps scheme, host and port and drops the path', () => {
  assert.equal(originOf(CONFIG.rpc), new URL(CONFIG.rpc).origin);
  assert.equal(originOf(https('node.example:8545/x?y=1#z')), https('node.example:8545'));
});
test('originOf refuses anything that is not an https URL, so a config typo fails the build instead of the policy', () => {
  for (const bad of [['http', '://', 'rpc.example'].join(''), 'rpc.example', '', undefined, null, 42, 'javascript:alert(1)', ['https', '://'].join('')]) {
    assert.throws(() => originOf(bad), /config|https/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the policy: everything from this origin, fetches to the two configured hosts, no inline style, no eval', () => {
  const d = directives(contentSecurityPolicy(CONFIG));
  assert.deepEqual(d['default-src'], ["'self'"]);
  assert.deepEqual(d['connect-src'], ["'self'", originOf(CONFIG.rpc), originOf(CONFIG.stratumxApi)]);
  assert.deepEqual(d['img-src'], ["'self'", 'data:']);
  assert.deepEqual(d['font-src'], ["'self'"]);
  assert.deepEqual(d['style-src'], ["'self'"]);
  assert.deepEqual(d['script-src'], ["'self'"]);
  assert.deepEqual(d['base-uri'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'none'"]);
  assert.deepEqual(d['frame-ancestors'], ["'none'"]);
  assert.doesNotMatch(contentSecurityPolicy(CONFIG), /unsafe-eval|unsafe-inline|\*/);
});
test('the meta-tag form is the same policy without frame-ancestors, which a meta tag cannot carry', () => {
  const full = directives(contentSecurityPolicy(CONFIG));
  const meta = directives(contentSecurityPolicy(CONFIG, { meta: true }));
  delete full['frame-ancestors'];
  assert.deepEqual(meta, full);
});
test('the pool and the RPC on one host give one connect-src entry', () => {
  const same = { ...CONFIG, rpc: https('chain.example/rpc'), stratumxApi: https('chain.example/api') };
  assert.deepEqual(directives(contentSecurityPolicy(same))['connect-src'], ["'self'", https('chain.example')]);
});
test('connect-src follows the config: a self-hoster who points at their own node gets that node, not ours', () => {
  const mine = { ...CONFIG, rpc: https('node.example:8545/cyprus1'), stratumxApi: https('pool.example/api') };
  assert.deepEqual(directives(contentSecurityPolicy(mine))['connect-src'], ["'self'", https('node.example:8545'), https('pool.example')]);
  assert.doesNotMatch(headersFile(mine), /quai\.network|stratumx/);
});
test('a config with a missing or non-https host fails instead of widening the policy', () => {
  for (const key of ['rpc', 'stratumxApi']) {
    assert.throws(() => contentSecurityPolicy({ ...CONFIG, [key]: undefined }), /config/, `${key} missing`);
    assert.throws(() => contentSecurityPolicy({ ...CONFIG, [key]: ['http', '://', 'insecure.example'].join('') }), /https/, `${key} over http`);
  }
});

test('_headers: the policy, no referrer, nosniff, and long caching for the fonts only', () => {
  const blocks = parseHeaders(headersFile(CONFIG));
  assert.deepEqual(blocks.map((b) => b.path), ['/*', '/fonts/*']);
  assert.deepEqual(header(blocks[0], 'Content-Security-Policy'), [contentSecurityPolicy(CONFIG)]);
  assert.deepEqual(header(blocks[0], 'Referrer-Policy'), ['no-referrer']);
  assert.deepEqual(header(blocks[0], 'X-Content-Type-Options'), ['nosniff']);
  assert.deepEqual(header(blocks[0], 'Cache-Control'), [], 'a host that joins same-name headers must not see two Cache-Control values');
  assert.deepEqual(header(blocks[1], 'Cache-Control'), ['public, max-age=31536000, immutable']);
});
