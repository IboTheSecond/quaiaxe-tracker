#!/usr/bin/env node
/**
 * scripts/run-tests.mjs — `npm test` entry point.
 *
 * `node --test test/` (directory-form discovery) throws MODULE_NOT_FOUND on this Windows/Node 24
 * setup instead of walking the folder for `*.test.mjs` files, even though the directory and test
 * files exist (verified: the exact-file form `node --test test/a.test.mjs test/b.test.mjs` runs
 * fine). This enumerates test/*.test.mjs explicitly and hands the resolved file list to `node
 * --test`, so the script stays portable instead of depending on that directory-discovery behavior.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_DIR = path.join(ROOT, 'test');

const entries = await readdir(TEST_DIR);
const files = entries
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(TEST_DIR, f));

if (!files.length) {
  console.error(`run-tests: no test/*.test.mjs files found under ${TEST_DIR}`);
  process.exit(1);
}

// build.test replaces dist/ atomically. On Windows, another test file reading dist/ at the
// same time keeps directory handles open and makes that rename fail with EPERM.
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: ROOT, stdio: 'inherit' });
child.on('error', (err) => {
  console.error('run-tests: failed to launch node --test:', err);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code != null ? code : (signal ? 1 : 1));
});
