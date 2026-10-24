#!/usr/bin/env node
// scan-leaks.mjs - checks a source tree (and a built dist/) for things that must never be published.
//
//   node scripts/scan-leaks.mjs [dir ...]      default: . and dist
//
// Exit code 0 = clean, 1 = findings, 2 = the scan itself could not run.
//
// What it looks for, in every file whatever its extension, after Unicode NFKC normalisation with
// zero-width and bidirectional control characters removed (so a split or look-alike spelling cannot hide):
//   - token and key shapes (GitHub, npm, cloud, chat and payment providers, JWTs, PEM private keys, bearer
//     tokens, webhook and topic URLs), a 64-hex private key next to a key word, seed-phrase word runs
//   - personal paths (Windows, macOS and Linux user folders) and attribution or session trailers
//   - any 0x address, URL host or email address that is not on the allowlists below
//   - secret-looking file names, binary files that are not fonts or clean images, image metadata, and the
//     text inside .woff2 fonts
//
// A finding is a file and a reason, never the text that matched, so a run log cannot leak what it found.
// Symbolic links stop the run. Node built-ins only.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- allowlists: the only addresses, hosts and emails that may appear in this repository ----
// Keys are lower case. Each value says why the entry is here. Adding one is a reviewed change.
export const ALLOWED_ADDRESSES = new Map([
  ['0x000e8fa7cfa09827f0a0786ce3e96ac5e4e9f46c', 'burn vault contract; the burn tile reads its totalTokensBurned()'],
  ['0x0035187a7660f595d93cd53a4d16c635d6cffc8f', 'QAXE token contract'],
  ['0x004d0221ffe03f529f7d9fccc9d72a9aa0ccfd2e', 'default tracked deposit address (zero payout, full burn); public by design'],
  ['0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic address used by the tests'],
]);
export const ALLOWED_HOSTS = new Map([
  ['backend.stratumx.org', 'pool API the page reads'],
  ['rpc.quai.network', 'Quai Cyprus-1 JSON-RPC the page reads'],
  ['quaiscan.io', 'explorer links; never fetched by the page'],
  ['127.0.0.1', 'local development server'],
  ['localhost', 'local development server'],
  ['github.com', 'repository, security advisory and release links'],
  ['scripts.sil.org', 'SIL Open Font License text shipped with the fonts'],
  ['openfontlicense.org', 'SIL Open Font License text shipped with the fonts'],
]);
export const ALLOWED_EMAILS = new Map([
  ['dev@hartiibiome.com', 'security and outside contact'],
]);

// ---- normalisation ----
// Soft hyphen, zero-width and bidirectional control characters, and the byte order mark. Built from code points
// so this file itself contains none of them.
const HIDDEN_RANGES = [[0x00ad, 0x00ad], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]];
const HIDDEN_CLASS = HIDDEN_RANGES.map(([from, to]) => String.fromCharCode(from) + (to > from ? `-${String.fromCharCode(to)}` : '')).join('');
const HIDDEN = new RegExp(`[${HIDDEN_CLASS}]`);
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'g');
export function normalise(text) {
  return text.normalize('NFKC').replace(HIDDEN_ALL, '').normalize('NFKC');
}

// ---- shape rules: [pattern, reason]. Case matters only where the shape is case sensitive. ----
const SHAPE_RULES = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'secret-looking token (GitHub)'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'secret-looking token (GitHub fine-grained)'],
  [/\bnpm_[A-Za-z0-9]{20,}/, 'secret-looking token (npm)'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/i, 'secret-looking token (API key)'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/i, 'secret-looking token (payment provider)'],
  [/(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/, 'secret-looking token (AWS access key id)'],
  [/\bcfk_[A-Za-z0-9]{10,}/i, 'secret-looking token (Cloudflare key)'],
  [/\bcfat_[\w-]{16,}/i, 'secret-looking token (Cloudflare API token)'],
  [/\bglpat-[\w-]{20,}/i, 'secret-looking token (GitLab)'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/i, 'secret-looking token (Slack)'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'secret-looking token (Google API key)'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'secret-looking token (JWT)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, 'private key block'],
  [/_auth[T]oken/i, 'npm auth configuration'], // [T] keeps this line from matching itself
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, 'bearer token'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, 'secret-looking token (Telegram bot)'],
  [/hooks\.slack\.com\/services\//i, 'chat webhook URL'],
  [/discord(?:app)?\.com\/api\/webhooks\//i, 'chat webhook URL'],
  [/\bntfy\.sh\/[A-Za-z0-9_-]{4,}/i, 'push topic URL'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i, 'URL with embedded credentials'],
  [/[A-Za-z]:[\\/]+Users[\\/]/i, 'personal path (Windows user folder)'],
  [/\/mnt\/[a-z]\/Users\//i, 'personal path (Windows user folder through WSL)'],
  [/(?:^|[\s"'`(=:,[])\/Users\/[^/\s"'`]+\//, 'personal path (macOS user folder)'],
  [/(?:^|[\s"'`(=:,[])\/home\/[^/\s"'`]+\//, 'personal path (Linux user folder)'],
  [/\bAppData[\\/]+(?:Local|Roaming|LocalLow)\b/i, 'personal path (Windows application data)'],
  [/%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%/i, 'personal path (Windows environment variable)'],
  [/\bCo-Authored-By\s*:/i, 'attribution trailer'],
  [/\bClaude-Session\s*:/i, 'assistant session trailer'],
  [/claude\.ai\/code\/session/i, 'assistant session link'],
];
const KEY_NEAR_HEX = /(?:private|secret|seed|mnemonic|passphrase)[^\n]{0,48}?(?<![0-9a-f])(?:0x)?[0-9a-f]{64}(?![0-9a-f])/i;
const HEX_NEAR_KEY = /(?<![0-9a-f])(?:0x)?[0-9a-f]{64}(?![0-9a-f])[^\n]{0,48}?(?:private|secret|seed|mnemonic|passphrase)/i;
const MNEMONIC_CONTEXT = /mnemonic|seed|recovery|backup[ -]?phrase|secret[ -]?phrase/i;
const ADDRESS_RE = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
const URL_HOST_RE = /\b(?:https?|wss?):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// 12/15/18/21/24 consecutive 3-8 letter lower-case words. Prose is full of such runs, so a run only counts when
// it is a quoted string on its own, or a seed-phrase word sits within 120 characters before it.
function hasMnemonicRun(text) {
  for (const m of text.matchAll(/(?:[a-z]{3,8} ){11,23}[a-z]{3,8}/g)) {
    if (![12, 15, 18, 21, 24].includes(m[0].split(' ').length)) continue;
    const before = text.slice(Math.max(0, m.index - 120), m.index);
    const after = text[m.index + m[0].length] || '';
    if ((/["'`]$/.test(before) && /["'`]/.test(after)) || MNEMONIC_CONTEXT.test(before)) return true;
  }
  return false;
}

function dedupe(hits) {
  const seen = new Set();
  return hits.filter((h) => {
    const key = `${h.file}\0${h.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Checks one text. `mode: 'shapes'` runs the token, key, path and trailer rules only and skips the address, host
 * and email allowlists. It is for text pulled out of a font (which legitimately carries its designer's links and
 * contact details) and for git commit and tag text (which carries the commit identity's email).
 * @returns {{file: string, why: string}[]}
 */
export function scanText(file, raw, { mode = 'text', binary = false } = {}) {
  const hits = [];
  const add = (why) => hits.push({ file, why });
  if (!binary && HIDDEN.test(raw)) add('hidden or bidirectional control character'); // random bytes of a font are not text
  const text = normalise(raw);
  for (const [re, why] of SHAPE_RULES) if (re.test(text)) add(why);
  if (KEY_NEAR_HEX.test(text) || HEX_NEAR_KEY.test(text)) add('64-hex private key next to a key word');
  if (hasMnemonicRun(text)) add('seed-phrase-like word run');
  if (mode === 'shapes') return dedupe(hits);
  for (const m of text.matchAll(ADDRESS_RE)) {
    if (!ALLOWED_ADDRESSES.has(m[0].toLowerCase())) { add('0x address that is not on the allowlist'); break; }
  }
  for (const m of text.matchAll(URL_HOST_RE)) {
    if (!ALLOWED_HOSTS.has(m[1].toLowerCase().replace(/\.$/, ''))) { add('URL host that is not on the allowlist'); break; }
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!ALLOWED_EMAILS.has(m[0].toLowerCase())) { add('email address that is not on the allowlist'); break; }
  }
  return dedupe(hits);
}

// ---- file names ----
const FORBIDDEN_NAME = /^\.env(?:\.|$)|^\.npmrc$|^\.yarnrc(?:\.yml)?$|^\.pypirc$|^\.netrc$|^\.git-credentials$|^\.dev\.vars$|^\.credentials|\.(?:pem|key|p12|pfx|tgz|keystore|jks|sqlite3?)$|^id_(?:rsa|ed25519|ecdsa|dsa)$|^(?:[\w-]*secrets?|credentials|push\.json)(?:\.|$)/i;
const FORBIDDEN_DIR = /^(?:\.wrangler|\.ssh|\.aws|\.gnupg|secrets)$/i;
/**
 * The path as it may be printed. A path segment that is itself a secret-looking token (or that the caller's
 * `redact` hook rejects) is shown as [redacted], keeping a short plain extension, so a finding about a file
 * name never repeats the name.
 */
export function displayName(rel, redact = null) {
  const keepExtension = (part) => {
    const ext = extname(part);
    return /^\.[A-Za-z0-9]{1,8}$/.test(ext) && !scanText('', ext, { mode: 'shapes' }).length ? ext : '';
  };
  return rel.split('/').map((part) => (scanText(part, part, { mode: 'shapes' }).length || (redact && redact(part)) ? `[redacted]${keepExtension(part)}` : part)).join('/');
}
export function scanName(rel, shown = displayName(rel)) {
  const hits = [];
  const parts = rel.split('/');
  if (FORBIDDEN_NAME.test(parts[parts.length - 1])) hits.push({ file: shown, why: 'secret-looking file name' });
  if (parts.slice(0, -1).some((p) => FORBIDDEN_DIR.test(p))) hits.push({ file: shown, why: 'secret-looking folder name' });
  for (const h of scanText(shown, rel)) hits.push({ file: shown, why: `${h.why} (in the path)` });
  return dedupe(hits);
}

// ---- images ----
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const PNG_SAFE = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT', 'cICP']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function gifMetadata(buf) {
  if (buf.length < 13) return 'image metadata (truncated GIF)';
  let pos = 13;
  if (buf[10] & 0x80) pos += 3 * (1 << ((buf[10] & 7) + 1));
  const skipSubBlocks = () => {
    while (pos < buf.length && buf[pos] !== 0) pos += buf[pos] + 1;
    pos += 1;
  };
  while (pos < buf.length) {
    const kind = buf[pos];
    if (kind === 0x3b) return null;
    if (kind === 0x21) {
      const label = buf[pos + 1];
      if (label === 0xfe || label === 0x01) return 'image metadata (GIF extension)';
      if (label === 0xff && buf.toString('latin1', pos + 3, pos + 14) !== 'NETSCAPE2.0') return 'image metadata (GIF extension)';
      pos += 2;
      skipSubBlocks();
    } else if (kind === 0x2c) {
      const packed = buf[pos + 9];
      pos += 10;
      if (packed & 0x80) pos += 3 * (1 << ((packed & 7) + 1));
      pos += 1; // LZW minimum code size
      skipSubBlocks();
    } else return 'image metadata (unreadable GIF)';
  }
  return 'image metadata (truncated GIF)';
}

/** Reason an image carries metadata (text, EXIF, XMP, timestamps, comments), or null when it is clean. */
export function imageMetadata(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let pos = 8;
    while (pos + 12 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      if (!PNG_SAFE.has(type)) return 'image metadata (PNG chunk)';
      if (type === 'IEND') return null;
      pos += 12 + len;
    }
    return 'image metadata (truncated PNG)';
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 <= buf.length) {
      if (buf[pos] !== 0xff) return 'image metadata (unreadable JPEG)';
      const marker = buf[pos + 1];
      if (marker === 0xda) return null; // start of scan: only image data follows
      if (marker === 0xe1 || marker === 0xfe || (marker >= 0xe3 && marker <= 0xef)) return 'image metadata (JPEG segment)';
      pos += 2 + buf.readUInt16BE(pos + 2);
    }
    return 'image metadata (unreadable JPEG)';
  }
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const type = buf.toString('latin1', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (type === 'EXIF' || type === 'XMP ' || type === 'ICCP') return 'image metadata (WebP chunk)';
      pos += 8 + size + (size & 1);
    }
    return null;
  }
  if (buf.length > 6 && /^GIF8[79]a/.test(buf.toString('latin1', 0, 6))) return gifMetadata(buf);
  return 'unreadable image file';
}

// ---- fonts ----
// A .woff2 font stores its tables brotli-compressed, so the raw bytes hide the name table (designer, licence
// URL, and anything else someone put there). This reads the table directory, decompresses the table stream and
// the optional metadata block, and returns the bytes so they can be scanned like text.
function readBase128(buf, cursor) {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buf[cursor.at];
    cursor.at += 1;
    if (byte === undefined) throw new Error('truncated');
    if (i === 0 && byte === 0x80) throw new Error('bad number');
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error('bad number');
}
export function woff2Bytes(buf) {
  if (buf.length < 48 || buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a woff2 file');
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  const metaOffset = buf.readUInt32BE(28);
  const metaLength = buf.readUInt32BE(32);
  const cursor = { at: 48 };
  for (let t = 0; t < numTables; t += 1) {
    const flags = buf[cursor.at];
    cursor.at += 1;
    const index = flags & 0x3f;
    let tag = '';
    if (index === 0x3f) { tag = buf.toString('latin1', cursor.at, cursor.at + 4); cursor.at += 4; }
    const glyfOrLoca = index === 10 || index === 11 || tag === 'glyf' || tag === 'loca';
    const version = flags >> 6;
    readBase128(buf, cursor); // original length
    if (glyfOrLoca ? version === 0 : version !== 0) readBase128(buf, cursor); // transformed length
  }
  const tables = brotliDecompressSync(buf.subarray(cursor.at, cursor.at + compressedSize));
  const meta = metaLength ? brotliDecompressSync(buf.subarray(metaOffset, metaOffset + metaLength)) : Buffer.alloc(0);
  return Buffer.concat([tables, meta]);
}
/** The decoded font bytes as one searchable string: as stored, and with NULs removed so UTF-16 names read as ASCII. */
function woff2Text(buf) {
  const raw = woff2Bytes(buf).toString('latin1');
  return `${raw}\n${raw.replace(/\0/g, '')}`;
}

// ---- one file's bytes ----
export function isBinary(buf) { return buf.subarray(0, 8192).includes(0); }

/**
 * Findings for one file's bytes. The extension of `rel` decides how the bytes are read; findings carry `shown`.
 * `inspect.text(file, text)` and `inspect.bytes(file, buf)` add caller-specific checks.
 */
export function scanBuffer(rel, buf, inspect = {}, shown = displayName(rel, inspect.redact)) {
  const hits = [];
  const ext = extname(rel).toLowerCase();
  if (ext === '.woff2' || isBinary(buf)) {
    if (inspect.bytes) hits.push(...inspect.bytes(shown, buf));
    if (ext === '.woff2') {
      let text = null;
      try { text = woff2Text(buf); } catch { hits.push({ file: shown, why: 'unreadable font file' }); }
      if (text !== null) {
        const inside = (found) => found.map((h) => ({ file: shown, why: `${h.why} (inside the font)` }));
        hits.push(...inside(scanText(shown, text, { mode: 'shapes', binary: true })));
        if (inspect.text) hits.push(...inside(inspect.text(shown, text)));
      }
    } else if (IMAGE_EXT.has(ext)) {
      const why = imageMetadata(buf);
      if (why) hits.push({ file: shown, why });
    } else {
      hits.push({ file: shown, why: 'binary file that is not a font or an image' });
    }
    return dedupe(hits);
  }
  const text = buf.toString('utf8');
  hits.push(...scanText(shown, text));
  if (inspect.text) hits.push(...inspect.text(shown, text));
  if (inspect.bytes) hits.push(...inspect.bytes(shown, buf));
  return dedupe(hits);
}

// ---- trees ----
/** Every regular file under `root`, as [relative posix path, absolute path]. A symbolic link or junction throws. */
function walk(root, skipDirs, skipPaths) {
  const files = [];
  const visit = (dir, relDir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`the tree contains a symbolic link (${rel})`);
      if (st.isDirectory()) {
        if (skipDirs.includes(name) || skipPaths.includes(rel)) continue;
        visit(abs, rel);
      } else if (st.isFile()) files.push([rel, abs]);
      else throw new Error(`the tree contains something that is not a regular file (${rel})`);
    }
  };
  if (lstatSync(root).isSymbolicLink()) throw new Error('the tree root is a symbolic link');
  visit(root, '');
  return files;
}

function checkFile(rel, buf, inspect) {
  const shown = displayName(rel, inspect.redact);
  const hits = [...scanName(rel, shown)];
  if (inspect.path) hits.push(...inspect.path(rel).map((h) => ({ file: shown, why: h.why })));
  hits.push(...scanBuffer(rel, buf, inspect, shown));
  return hits;
}

/**
 * Scans a directory. `skipPaths` are relative paths (posix) to leave out, for a folder scanned on its own.
 * `inspect` adds caller-specific checks (the exporter adds its private list this way).
 */
export function scanTree(dir, { skipDirs = ['.git', 'node_modules'], skipPaths = [], inspect = {} } = {}) {
  const root = resolve(dir);
  const hits = [];
  for (const [rel, abs] of walk(root, skipDirs, skipPaths)) hits.push(...checkFile(rel, readFileSync(abs), inspect));
  return dedupe(hits);
}

/** Same checks for files already in memory: Map of relative posix path -> Buffer. */
export function scanFiles(files, { inspect = {} } = {}) {
  const hits = [];
  for (const [rel, buf] of files) hits.push(...checkFile(rel, buf, inspect));
  return dedupe(hits);
}

// ---- command line ----
function main(args) {
  const roots = args.length ? args : ['.', 'dist'];
  const findings = [];
  try {
    const absRoots = roots.map((r) => resolve(r));
    roots.forEach((root, i) => {
      if (!existsSync(absRoots[i])) throw new Error(`${root} does not exist${root === 'dist' ? ' (run npm run build first)' : ''}`);
      const nested = absRoots.filter((r) => r !== absRoots[i] && r.startsWith(absRoots[i] + sep)).map((r) => relative(absRoots[i], r).split(sep).join('/'));
      const label = relative(process.cwd(), absRoots[i]).split(sep).join('/');
      for (const f of scanTree(absRoots[i], { skipPaths: nested })) findings.push({ file: label ? `${label}/${f.file}` : f.file, why: f.why });
    });
  } catch (error) {
    console.error(`scan-leaks: ${error.message}`);
    process.exit(2);
  }
  if (findings.length) {
    console.error(`scan-leaks: ${findings.length} finding(s)`);
    for (const f of findings.slice(0, 200)) console.error(`  ${f.file}: ${f.why}`);
    process.exit(1);
  }
  console.log(`scan-leaks: clean (${roots.join(', ')})`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
