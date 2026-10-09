#!/usr/bin/env node
// scripts/build.mjs - builds dist/, the folder you publish: the page in English at / and in Turkish at /tr/, a 404
// page, a _headers file with the Content-Security-Policy, the three assets, the one library the page script
// imports, and the fonts. It reads config.json if you made one, otherwise config.example.json. Plain files in and
// out: no bundler, no network, no dependencies, and the same bytes every time.
//
//   node scripts/build.mjs
//
// The build happens in a scratch folder next to dist/ and replaces dist/ only when it succeeded, so a bad config
// leaves the last good dist/ as it was.
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LANGS, headersFile, renderNotFound, renderPage } from '../src/page.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEYS = ['trackedAddresses', 'stratumxApi', 'rpc', 'vault', 'qaxeToken'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Throws an Error starting with `label: ` when the config is not exactly the five keys the page reads, well formed. */
export function validateConfig(config, label = 'config') {
  const fail = (why) => new Error(`${label}: ${why}`);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('must be a JSON object');
  for (const key of Object.keys(config)) if (!KEYS.includes(key)) throw fail(`unknown key "${key}" (the page reads ${KEYS.join(', ')})`);
  for (const key of KEYS) if (!(key in config)) throw fail(`${key} is missing`);
  const list = config.trackedAddresses;
  if (!Array.isArray(list) || !list.length || !list.every((a) => typeof a === 'string' && ADDRESS.test(a))) {
    throw fail('trackedAddresses must be a non-empty list of 0x addresses (0x and 40 hex digits)');
  }
  for (const key of ['vault', 'qaxeToken']) if (typeof config[key] !== 'string' || !ADDRESS.test(config[key])) throw fail(`${key} must be a 0x address`);
  for (const key of ['rpc', 'stratumxApi']) {
    let u = null;
    try { u = new URL(config[key]); } catch { /* reported below */ }
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw fail(`${key} must be a plain https URL`);
  }
}

/** config.json when it exists, else config.example.json. Returns the validated config and the file it came from. */
export async function loadConfig(root = ROOT) {
  const file = existsSync(join(root, 'config.json')) ? 'config.json' : 'config.example.json';
  let config;
  try { config = JSON.parse(await readFile(join(root, file), 'utf8')); } catch { throw new Error(`${file}: is missing or not valid JSON`); }
  validateConfig(config, file);
  return { config, file };
}

async function loadVersion(root) {
  let version;
  try { version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version; } catch { throw new Error('package.json: is missing or not valid JSON'); }
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('package.json: "version" must be x.y.z');
  return version;
}

async function listFiles(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(path, base, out);
    else out.push(path.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}

/** Builds `outDir` (default dist/ under `root`). Returns the folder and the sorted list of files in it. */
export async function build({ root = ROOT, outDir = join(root, 'dist') } = {}) {
  const { config } = await loadConfig(root);
  const version = await loadVersion(root);
  const scratch = `${outDir}.building-${process.pid}`;
  await rm(scratch, { recursive: true, force: true });
  try {
    await mkdir(scratch, { recursive: true });
    for (const lang of LANGS) {
      const dir = lang === 'en' ? scratch : join(scratch, lang);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'index.html'), renderPage({ lang, config, version }), 'utf8');
    }
    await writeFile(join(scratch, '404.html'), renderNotFound({ config, version }), 'utf8');
    await writeFile(join(scratch, '_headers'), headersFile(config), 'utf8');
    await mkdir(join(scratch, 'assets', 'lib'), { recursive: true });
    for (const name of ['tracker.css', 'page.js', 'tracker.js']) await cp(join(root, 'assets', name), join(scratch, 'assets', name));
    await cp(join(root, 'src', 'lib', 'tracker-lib.js'), join(scratch, 'assets', 'lib', 'tracker-lib.js'));
    await cp(join(root, 'fonts'), join(scratch, 'fonts'), { recursive: true });
    const files = await listFiles(scratch);
    await rm(outDir, { recursive: true, force: true });
    await rename(scratch, outDir);
    return { outDir, files };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().then(
    (result) => console.log(`built ${result.files.length} files into dist/`),
    (error) => { console.error(`build failed: ${error.message}`); process.exitCode = 1; },
  );
}
