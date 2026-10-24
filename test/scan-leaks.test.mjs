// Tests for scripts/scan-leaks.mjs. Every hostile sample is assembled from fragments at run time, so this
// file contains nothing the scanner would flag and the self-scan test below can run over the whole tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { brotliCompressSync } from 'node:zlib';

import {
  ALLOWED_ADDRESSES, ALLOWED_EMAILS, ALLOWED_HOSTS, imageMetadata, normalise, scanBuffer, scanFiles, scanName, scanText, scanTree, woff2Bytes,
} from '../scripts/scan-leaks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'scan-leaks.mjs');

const code = (...codes) => String.fromCharCode(...codes);
const BACKSLASH = code(92);
const ZWSP = code(0x200b); // zero-width space
const RLO = code(0x202e); // right-to-left override
const SHY = code(0xad); // soft hyphen
const BOM = code(0xfeff); // byte order mark
const rep = (s, n) => s.repeat(n);
const HEX64 = rep('a1b2c3d4', 8);
const at = (a, b) => `${a}@${b}`;
const url = (host, rest = '') => ['https', '://', host, rest].join('');
const folder = (...parts) => parts.join('/');
const WORDS12 = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'].join(' ');

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'scan-leaks-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  return root;
}
const scan = (files, options) => scanTree(makeTree(files), options);
const reasons = (files, options) => scan(files, options).map((h) => h.why);

// ---- hostile samples: [label, file name, content, part of the reason that must appear] ----
const HOSTILE = [
  ['GitHub token', 'a.js', `const t = "${'ghp_' + rep('A', 30)}";`, /GitHub/],
  ['GitHub fine-grained token', 'a.md', `token ${'github_pat_' + rep('A', 30)}`, /GitHub fine-grained/],
  ['npm token', 'a.txt', 'npm_' + rep('b', 30), /npm/],
  ['API key, mixed case', 'k.txt', 'Sk-Ant-' + rep('Z', 16), /API key/],
  ['AWS access key id in a map file', 'a.map', `{"x":"${'AKIA' + 'ABCDEFGHIJKLMNOP'}"}`, /AWS/],
  ['Cloudflare token', 'd.sh', 'export CF=' + 'cfat_' + rep('a', 30), /Cloudflare/],
  ['Slack token', 'e.txt', 'xoxb-' + '123456789012', /Slack/],
  ['Google API key', 'f.txt', 'AIza' + rep('B', 35), /Google/],
  ['JWT', 'g.txt', ['eyJ' + rep('a', 12), 'eyJ' + rep('b', 12), rep('c', 12)].join('.'), /JWT/],
  ['PEM private key header', 'h.txt', '-----BEGIN ' + 'RSA PRIVATE KEY' + '-----', /private key block/],
  ['npm auth config', 'i.log', '//registry.example/:_auth' + 'Token=abc', /npm auth/],
  ['bearer token', 'j.txt', 'Authorization: Bearer ' + rep('t', 24), /bearer/],
  ['Telegram bot token', 'k2.txt', '123456789:' + rep('A', 35), /Telegram/],
  ['chat webhook URL', 'l.txt', url('hooks.slack.com', '/services/T000/B000/xyz'), /webhook/],
  ['push topic URL', 'm.txt', 'ntfy.sh' + '/mytopic1234', /push topic/],
  ['URL with embedded credentials', 'n.txt', ['https', '://', 'user', ':', 'secret', '@', 'example.org', '/x'].join(''), /embedded credentials/],
  ['64-hex private key next to a key word', 'o.JS', `const privateKey = "0x${HEX64}";`, /64-hex/],
  ['64-hex key before the key word', 'o2.js', `0x${HEX64} // the seed`, /64-hex/],
  ['seed phrase', 'p.md', `my seed phrase: ${WORDS12}`, /seed-phrase/],
  ['quoted lone seed phrase', 'p2.md', `"${WORDS12}"`, /seed-phrase/],
  ['Windows user folder, forward slashes', 'q.txt', 'C:' + folder('', 'Users', 'someone', 'work'), /Windows user folder/],
  ['Windows user folder, JSON-escaped', 'q2.json', `"C:${BACKSLASH}${BACKSLASH}Users${BACKSLASH}${BACKSLASH}someone"`, /Windows user folder/],
  ['Windows user folder through WSL', 'q3.txt', folder('', 'mnt', 'c', 'Users', 'someone'), /WSL/],
  ['macOS user folder', 'r.txt', 'cd ' + folder('', 'Users', 'someone', 'code'), /macOS/],
  ['Linux user folder', 's.txt', 'cd ' + folder('', 'home', 'someone', 'code'), /Linux/],
  ['Windows application data', 't.txt', 'AppData' + BACKSLASH + 'Local', /application data/],
  ['Windows environment variable path', 'u.txt', '%USER' + 'PROFILE%', /environment variable/],
  ['attribution trailer', 'v.txt', 'Co-Authored-By' + ': Someone', /attribution/],
  ['assistant session trailer', 'w.txt', 'Claude-Session' + ': abc', /session/],
  ['assistant session link', 'w2.txt', url('claude.ai', '/code/session_abc'), /session link/],
  ['hidden zero-width character', 'x.txt', 'plain' + ZWSP + 'text', /hidden or bidirectional/],
  ['bidirectional override', 'x2.txt', 'plain' + RLO + 'text', /hidden or bidirectional/],
  ['token split by a zero-width space', 'y.txt', 'gh' + ZWSP + 'p_' + rep('A', 30), /GitHub/],
  ['token spelled with full-width look-alikes', 'z.txt', code(0xff47, 0xff48, 0xff50, 0xff3f) + rep('A', 30), /GitHub/],
  ['address that is not on the allowlist', 'aa.txt', '0x' + rep('ab', 20), /address/],
  ['URL host that is not on the allowlist', 'bb.txt', url('evil.example', '/x'), /host/],
  ['IP host that is not on the allowlist', 'bb2.txt', ['http', '://', '10.1.2.3:8080/'].join(''), /host/],
  ['email that is not on the allowlist', 'cc.txt', at('someone', 'example.org'), /email/],
];
for (const [label, name, body, want] of HOSTILE) {
  test(`hostile sample is caught: ${label}`, () => {
    const found = reasons({ [name]: body });
    assert.ok(found.some((r) => want.test(r)), `expected a finding matching ${want}, got ${JSON.stringify(found)}`);
  });
}

test('findings carry a file and a reason, never the matched bytes', () => {
  const token = 'ghp_' + rep('Q', 30);
  const mail = at('someone', 'example.org');
  const found = scan({ 'sample.js': `${JSON.stringify({ token, mail })}` });
  assert.ok(found.length >= 2);
  const text = JSON.stringify(found);
  for (const secret of [token, token.slice(4, 14), mail, 'someone']) assert.ok(!text.includes(secret), 'a finding leaked the matched text');
  for (const f of found) assert.deepEqual(Object.keys(f).sort(), ['file', 'why']);
});

// ---- controls: things that must NOT trip ----
test('controls: a transaction hash, allowlisted values, prose and non-ASCII text are clean', () => {
  const [address] = [...ALLOWED_ADDRESSES.keys()];
  const [host] = [...ALLOWED_HOSTS.keys()];
  const [email] = [...ALLOWED_EMAILS.keys()];
  assert.deepEqual(scan({
    'tx.js': `const txHash = "0x${HEX64}";`,
    'addr.json': JSON.stringify({ a: address, b: address.toUpperCase().replace('0X', '0x') }),
    'link.md': `see ${url(host, '/path')} and mail ${email}`,
    'prose.md': ['send the quick brown foxes', 'over the lazy sleepy dogs', 'and then eat some more tasty food today'].join(' '), // 18 plain words, no seed-phrase context
    'tr.json': '{"t":"Canlı izleyin — yanıyor → ’ …"}',
    'words.md': 'a task-based-processing-pipeline-with-long-hyphenated-name and risk-adjusted-return-calculations',
    'ci.yml': `uses: actions/checkout@${rep('0123456789', 4)} # pinned`,
    'src/keystore.js': 'export const x = 1;',
  }), []);
});

test('an address inside a longer hex string is not read as an address', () => {
  assert.deepEqual(scanText('x', `0x${HEX64}`), []);
  assert.deepEqual(scanText('x', `0x${'ab'.repeat(21)}`), []);
});

test('allowlists: every entry is lower case and says why it is there', () => {
  for (const [address, why] of ALLOWED_ADDRESSES) { assert.match(address, /^0x[0-9a-f]{40}$/); assert.ok(why.length > 10); }
  for (const [host, why] of ALLOWED_HOSTS) { assert.equal(host, host.toLowerCase()); assert.ok(why.length > 10); }
  for (const [email, why] of ALLOWED_EMAILS) { assert.equal(email, email.toLowerCase()); assert.ok(why.length > 10); }
  assert.ok(!ALLOWED_EMAILS.has(at('dev', 'hartiilabs.com')), 'the commit identity mailbox cannot receive mail and is never a contact');
});

test('normalise removes zero-width characters and folds full-width look-alikes', () => {
  assert.equal(normalise('a' + ZWSP + 'b' + SHY + 'c' + BOM + 'd'), 'abcd');
  assert.equal(normalise(code(0xff21, 0xff22)), 'AB');
});

// ---- file names ----
test('secret-looking file names are denied by name even with clean content', () => {
  const names = ['.env', '.env.production', '.env.example', '.npmrc', 'x.pem', 'x.KEY', 'x.p12', 'x.pfx', 'pkg-1.0.0.tgz', 'id_rsa', 'id_ed25519',
    'my_secrets.md', 'team-secret.txt', 'SECRETS', 'credentials.json', '.dev.vars', 'push.json', '.netrc', '.git-credentials', 'wallet.keystore', 'release.jks', 'x.sqlite', '.pypirc'];
  for (const n of names) assert.ok(reasons({ [n]: 'clean' }).includes('secret-looking file name'), n);
});
test('secret-looking folder names are denied', () => {
  for (const d of ['.wrangler', '.ssh', '.aws', 'secrets']) assert.ok(reasons({ [`${d}/a.txt`]: 'clean' }).includes('secret-looking folder name'), d);
});
test('a token or personal path inside a file name is found, says so, and is never printed', () => {
  const found = scanName('docs/' + 'ghp_' + rep('A', 30) + '.md');
  assert.ok(found.some((h) => /GitHub.*in the path/.test(h.why)), JSON.stringify(found));
  assert.ok(found.every((h) => h.file === 'docs/[redacted].md'), JSON.stringify(found));
});
test('findings for a file whose name holds a secret show the name as [redacted], in every kind of finding', () => {
  const name = 'ghp_' + rep('Q', 30);
  const found = scan({ [`dir/${name}.js`]: `const x = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}";`, [`${name}.woff2`]: Buffer.from([0, 1, 2]) });
  assert.deepEqual(found.map((h) => h.file).filter((f, i, all) => all.indexOf(f) === i).sort(), ['[redacted].woff2', 'dir/[redacted].js']);
  assert.ok(found.some((h) => h.file === 'dir/[redacted].js' && /AWS/.test(h.why)));
  assert.ok(found.some((h) => h.file === '[redacted].woff2' && /unreadable font file/.test(h.why)), 'the extension still decides how the bytes are read');
  assert.ok(!JSON.stringify(found).includes(name.slice(4, 14)));
});
test('inspect.redact lets the caller hide names of its own: those files are shown as [redacted] too', () => {
  const found = scan({ 'keep/private-thing.txt': 'MARKER' }, { inspect: { redact: (segment) => segment.startsWith('private-'), text: (file, text) => (text.includes('MARKER') ? [{ file, why: 'custom text rule' }] : []) } });
  assert.deepEqual(found, [{ file: 'keep/[redacted].txt', why: 'custom text rule' }]);
});
test('the command line never prints a secret that sits in a file name', () => {
  const name = 'ghp_' + rep('Q', 30);
  const dir = makeTree({ [`${name}.txt`]: 'x' });
  const r = cli([dir], dir);
  assert.equal(r.code, 1);
  assert.ok(!(r.out + r.err).includes(name.slice(4, 14)), r.err);
  assert.match(r.err, /\[redacted\]\.txt: secret-looking token \(GitHub\) \(in the path\)/);
});

// ---- links ----
test('a symbolic link or junction stops the scan instead of being followed', () => {
  const root = makeTree({ 'a.txt': 'x' });
  const outside = makeTree({ 'secret.txt': 'SYNTHETIC_EXTERNAL_CONTENT' });
  symlinkSync(outside, join(root, 'linked'), 'junction');
  assert.throws(() => scanTree(root), /symbolic link/);
});

// ---- binary files ----
test('a binary file that is not a font or an image is flagged', () => {
  assert.ok(reasons({ 'blob.bin': Buffer.from([0, 1, 2, 3, 0, 255]) }).includes('binary file that is not a font or an image'));
});

const base128 = (n) => {
  const out = [];
  do { out.unshift(n % 128); n = Math.floor(n / 128); } while (n);
  return Buffer.from(out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b)));
};
/** A minimal WOFF2: one untransformed 'name' table holding `tableData`, optional brotli metadata block. */
function woff2(tableData, meta = null) {
  const compressed = brotliCompressSync(tableData);
  const dir = Buffer.concat([Buffer.from([0x3f]), Buffer.from('name', 'latin1'), base128(tableData.length)]);
  const body = Buffer.concat([dir, compressed]);
  const metaBlock = meta ? brotliCompressSync(meta) : Buffer.alloc(0);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + body.length + metaBlock.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(tableData.length, 16);
  header.writeUInt32BE(compressed.length, 20);
  if (meta) { header.writeUInt32BE(48 + body.length, 28); header.writeUInt32BE(metaBlock.length, 32); header.writeUInt32BE(meta.length, 36); }
  return Buffer.concat([header, body, metaBlock]);
}
const TOKEN = 'ghp_' + rep('A', 30);

test('woff2Bytes reads the compressed tables and the metadata block back', () => {
  const bytes = woff2Bytes(woff2(Buffer.from('table-bytes', 'latin1'), Buffer.from('meta-bytes', 'latin1')));
  assert.equal(bytes.toString('latin1'), 'table-bytesmeta-bytes');
});
test('a clean font passes; text hidden inside the compressed tables is found', () => {
  assert.deepEqual(scanBuffer('f.woff2', woff2(Buffer.from('Copyright The Font Authors', 'latin1'))), []);
  const latin = scanBuffer('f.woff2', woff2(Buffer.from(`note ${TOKEN}`, 'latin1')));
  assert.ok(latin.some((h) => /GitHub.*inside the font/.test(h.why)), JSON.stringify(latin));
  const utf16 = scanBuffer('f.woff2', woff2(Buffer.from(TOKEN, 'utf16le').swap16()));
  assert.ok(utf16.some((h) => /GitHub.*inside the font/.test(h.why)), 'a UTF-16 name-table string must be found too');
  const meta = scanBuffer('f.woff2', woff2(Buffer.from('x', 'latin1'), Buffer.from(`<meta>${'C:' + folder('', 'Users', 'someone')}</meta>`, 'latin1')));
  assert.ok(meta.some((h) => /Windows user folder.*inside the font/.test(h.why)), JSON.stringify(meta));
});
test('the bytes inside a font are binary data: a soft-hyphen byte or a byte-order-mark pattern in them is not a hidden character', () => {
  const noisy = Buffer.concat([Buffer.from([0xad, 0xfe, 0xff, 0xe2, 0x80, 0x8b, 0xef, 0xbb, 0xbf, 0x00, 0xad]), Buffer.from('Copyright The Font Authors', 'latin1')]);
  assert.deepEqual(scanBuffer('f.woff2', woff2(noisy)), []);
});
test('a font carries its designer links and contact details without tripping the allowlists', () => {
  assert.deepEqual(scanBuffer('f.woff2', woff2(Buffer.from(`by ${at('designer', 'foundry.example')} ${url('foundry.example', '/license')}`, 'latin1'))), []);
});
test('a broken font is reported, not skipped', () => {
  assert.ok(reasons({ 'f.woff2': Buffer.from('wOF2-not-really-a-font-at-all-and-too-short') }).includes('unreadable font file'));
  assert.ok(reasons({ 'g.woff2': Buffer.concat([Buffer.from('XXXX'), Buffer.alloc(80)]) }).includes('unreadable font file'));
});
const FONT_DIR = join(ROOT, 'fonts');
test('every shipped font is clean, including the text inside it', { skip: !existsSync(FONT_DIR) && 'no fonts/ folder in this tree' }, () => {
  const fonts = readdirSync(FONT_DIR).filter((n) => n.endsWith('.woff2'));
  assert.ok(fonts.length > 0);
  for (const n of fonts) assert.deepEqual(scanBuffer(`fonts/${n}`, readFileSync(join(FONT_DIR, n))), [], n);
});

// ---- image metadata ----
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const pngChunk = (type, data = Buffer.alloc(0)) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (...extra) => Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13)), ...extra, pngChunk('IDAT', Buffer.from([1, 2, 3])), pngChunk('IEND')]);
const seg = (marker, payload) => { const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2); return Buffer.concat([Buffer.from([0xff, marker]), len, payload]); };
const jpeg = (...extra) => Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF', 'latin1')), ...extra, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])]);
const riffChunk = (type, data) => { const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, Buffer.alloc(data.length & 1)]); };
const webp = (...chunks) => { const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]); const h = Buffer.alloc(8); h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
const gif = (...blocks) => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0, 0, 0]), ...blocks, Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b])]);

test('clean images pass', () => {
  assert.equal(imageMetadata(png()), null);
  assert.equal(imageMetadata(jpeg()), null);
  assert.equal(imageMetadata(webp(riffChunk('VP8 ', Buffer.from([1, 2, 3])))), null);
  assert.equal(imageMetadata(gif()), null);
  assert.equal(imageMetadata(gif(Buffer.from([0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0]))), null);
  assert.deepEqual(scanBuffer('a.png', png()), []);
});
test('image metadata is flagged: PNG text and time chunks, JPEG EXIF and comments, WebP EXIF, GIF comments', () => {
  for (const type of ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']) assert.match(imageMetadata(png(pngChunk(type, Buffer.from('k\0v')))), /PNG chunk/, type);
  assert.match(imageMetadata(jpeg(seg(0xe1, Buffer.from('Exif\0\0', 'latin1')))), /JPEG/);
  assert.match(imageMetadata(jpeg(seg(0xfe, Buffer.from('a comment')))), /JPEG/);
  assert.match(imageMetadata(webp(riffChunk('VP8 ', Buffer.from([1, 2, 3])), riffChunk('EXIF', Buffer.from('Exif')))), /WebP/);
  assert.match(imageMetadata(gif(Buffer.from([0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0]))), /GIF/);
  assert.ok(reasons({ 'a.png': png(pngChunk('tEXt', Buffer.from('Author\0someone'))) }).includes('image metadata (PNG chunk)'));
});
test('an image file that is not really an image is flagged', () => {
  assert.equal(imageMetadata(Buffer.from('not an image at all')), 'unreadable image file');
});

// ---- caller-supplied checks (the exporter adds its private list this way) ----
test('inspect hooks add file-name, text and byte checks', () => {
  const inspect = {
    path: (rel) => (rel.includes('badname') ? [{ file: rel, why: 'custom path rule' }] : []),
    text: (file, text) => (text.includes('MARKER') ? [{ file, why: 'custom text rule' }] : []),
    bytes: (file, buf) => (buf.includes(Buffer.from('BYTES')) ? [{ file, why: 'custom byte rule' }] : []),
  };
  const found = reasons({ 'badname.txt': 'MARKER and BYTES' }, { inspect });
  assert.deepEqual([...found].sort(), ['custom byte rule', 'custom path rule', 'custom text rule']);
  const mem = scanFiles(new Map([['badname.txt', Buffer.from('MARKER and BYTES')]]), { inspect });
  assert.deepEqual(mem.map((h) => h.why).sort(), ['custom byte rule', 'custom path rule', 'custom text rule']);
});

// ---- the whole tree ----
test('this repository passes its own scan', () => {
  assert.deepEqual(scanTree(ROOT, { skipPaths: ['dist'] }), []);
});

// ---- command line ----
function cli(args, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
test('command line: exit 0 on a clean folder', () => {
  const dir = makeTree({ 'a.txt': 'hello' });
  const r = cli([dir], dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /clean/);
});
test('command line: exit 1 lists file and reason, never the matched text', () => {
  const dir = makeTree({ 'src/a.js': `const t = "${TOKEN}";` });
  const r = cli([dir], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /1 finding/);
  assert.match(r.err, /src\/a\.js: secret-looking token \(GitHub\)/);
  assert.ok(!(r.out + r.err).includes(TOKEN.slice(4, 14)));
});
test('command line: exit 2 when a folder is missing, and the default asks for a build', () => {
  const dir = makeTree({ 'a.txt': 'hello' });
  assert.equal(cli([join(dir, 'nope')], dir).code, 2);
  const r = cli([], dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /npm run build/);
});
test('command line: a folder scanned on its own is not scanned twice through its parent', () => {
  const dir = makeTree({ 'a.txt': 'hello', 'dist/b.js': `const t = "${TOKEN}";` });
  const r = cli(['.', 'dist'], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /1 finding/);
  assert.match(r.err, /dist\/b\.js/);
});
