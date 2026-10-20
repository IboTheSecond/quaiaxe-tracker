// The repository's own promises, kept as tests: no dependencies of any kind, a licence, a security contact, docs
// that name every network call the code makes, and a CI workflow that cannot be talked into doing more than it should.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const COMMIT_MAILBOX = ['dev', 'hartiilabs.com'].join('@'); // the git identity's mailbox; it receives no mail and is never a contact
const CONTACT = ['dev', 'hartiibiome.com'].join('@');

test('README source release matches package.json', () => {
  assert.ok(read('README.md').includes(`Source release: ${pkg.version}.`));
});

// ---------------------------------------------------------------------------------------------------------------
// no dependencies
// ---------------------------------------------------------------------------------------------------------------
test('package.json: private, MIT, ES modules, Node 24, and no dependency of any kind', () => {
  assert.equal(pkg.private, true, 'a published package would copy this repository to a registry');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=24');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions', 'workspaces', 'packageManager']) {
    assert.equal(pkg[key], undefined, `package.json has ${key}`);
  }
  for (const key of ['main', 'bin', 'exports', 'files']) assert.equal(pkg[key], undefined, `this is not an installable package: ${key}`);
});
test('package.json: four scripts, none of them a lifecycle hook that would run on install', () => {
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['build', 'scan', 'start', 'test']);
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs');
  assert.equal(pkg.scripts.scan, 'node scripts/scan-leaks.mjs . dist');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prebuild', 'postbuild', 'pretest', 'posttest', 'prestart', 'poststart']) {
    assert.equal(pkg.scripts[hook], undefined, hook);
  }
});
test('no lockfile, no installed packages, no npm configuration', () => {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', '.npmrc', '.yarnrc', '.yarnrc.yml', 'node_modules']) {
    assert.ok(!existsSync(join(ROOT, name)), `${name} exists`);
  }
});
function sourceFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (['.git', 'node_modules', 'dist', 'fonts'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out); else if (/\.(?:mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
test('every import in the code and the tests is a Node built-in or a file of this repository', () => {
  const files = sourceFiles();
  assert.ok(files.length >= 12, 'found the sources');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const specs = [
      ...text.matchAll(/^\s*import\s[^'"\n]*?from\s*['"]([^'"]+)['"]/gm),
      ...text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/assets/');
      assert.ok(ok, `${file.slice(ROOT.length + 1)} imports "${spec}", which is not a built-in or a local file`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// the licence and the documents
// ---------------------------------------------------------------------------------------------------------------
test('LICENSE is MIT, held by Hartii Labs, and the font licences are present', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Hartii Labs\n/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  for (const f of ['LICENSE-big-shoulders-display.txt', 'LICENSE-ibm-plex-sans.txt', 'LICENSE-jetbrains-mono.txt']) assert.ok(existsSync(join(ROOT, 'fonts', f)), f);
});
test('SECURITY.md: private reporting on GitHub plus the one contact address, never the commit identity mailbox', () => {
  const text = read('SECURITY.md');
  assert.match(text, /Report a vulnerability/);
  assert.ok(text.includes(CONTACT));
  assert.ok(!text.includes(COMMIT_MAILBOX));
});
test('CONTRIBUTING.md says what this repository is: a generated copy, issues yes, pull requests no', () => {
  const text = read('CONTRIBUTING.md');
  assert.match(text, /generated/i);
  assert.match(text, /issues?\b/i);
  assert.match(text, /pull requests?/i);
  assert.ok(!text.includes(COMMIT_MAILBOX));
});
test('README.md has the five sections a reader needs, and the independence line', () => {
  const text = read('README.md');
  for (const heading of ['## What it shows', '## Network calls', '## Run it', '## Privacy', '## Limits']) assert.ok(text.includes(`\n${heading}\n`), `README has no "${heading}"`);
  assert.match(text, /independent[^.]*not affiliated with or endorsed by StratumX, Quai Network or Quaiscan/i);
  assert.ok(!text.includes(COMMIT_MAILBOX));
});
test('README.md names every request the code can make, and every host', () => {
  const readme = read('README.md');
  const code = `${read('assets/tracker.js')}\n${read('assets/page.js')}`;
  const calls = [
    ['/miners/batch', /\/miners\/batch/], ['/pool/blocks', /\/pool\/blocks/], ['/pool/shares', /\/pool\/shares/], ['/miner/hashrate/history', /\/miner\/hashrate\/history/],
    ['quai_getLockedBalance', /quai_getLockedBalance/], ['quai_getBalance', /quai_getBalance/], ['eth_call', /eth_call/], ['quai_blockNumber', /quai_blockNumber/],
  ];
  for (const [name, re] of calls) {
    assert.match(code, re, `the code no longer makes ${name}: update the README and this list`);
    assert.ok(readme.includes(name), `README does not mention ${name}`);
  }
  assert.equal([...code.matchAll(/fetch\(/g)].length, 2, 'a new fetch() call needs a README entry: update this count with it');
  const cfg = JSON.parse(read('config.example.json'));
  for (const url of [cfg.rpc, cfg.stratumxApi]) assert.ok(readme.includes(new URL(url).hostname), `README does not name ${new URL(url).hostname}`);
  assert.ok(readme.includes('0xd157e301'), 'README names the burn vault selector the page reads');
});
test('.gitignore keeps the build output, a personal config and secrets out; .gitattributes forces LF', () => {
  const ignore = read('.gitignore').split('\n');
  for (const line of ['dist/', 'config.json', 'node_modules/', '.env', '.env.*']) assert.ok(ignore.includes(line), `.gitignore lacks ${line}`);
  const attributes = read('.gitattributes');
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.woff2 binary$/m);
});

// ---------------------------------------------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------------------------------------------
const workflowText = () => read('.github/workflows/ci.yml');
test('CI: a read-only token, no secrets, and no trigger that runs forks\' code with more rights', () => {
  const workflow = workflowText();
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|secrets\.|id-token|write/i);
  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n/m);
  assert.equal([...workflow.matchAll(/persist-credentials: false/g)].length, [...workflow.matchAll(/uses: actions\/checkout@/g)].length, 'every checkout drops its credentials');
});
test('CI: every action is pinned by a full commit SHA, with the release in a comment', () => {
  const workflow = workflowText();
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 3);
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref} is not pinned by a full SHA`);
    assert.match(rest, /# v\d+\.\d+\.\d+/, `${ref} has no release comment`);
  }
});
test('CI: the tests run on Ubuntu and Windows with Node 24, then the build and the leak scan', () => {
  const workflow = workflowText();
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /node-version: 24\b/);
  const steps = [...workflow.matchAll(/run: (npm [^\n]+)/g)].map((m) => m[1]);
  assert.deepEqual(steps.slice(0, 3), ['npm test', 'npm run build', 'npm run scan']);
  assert.doesNotMatch(workflow, /npm (?:install|ci)\b/, 'there is nothing to install');
});
test('CI: gitleaks is downloaded at a pinned version and checked against a pinned checksum before it runs', () => {
  const workflow = workflowText();
  assert.match(workflow, /GITLEAKS_VERSION: \d+\.\d+\.\d+/);
  assert.match(workflow, /GITLEAKS_SHA256: [0-9a-f]{64}\b/);
  assert.match(workflow, /sha256sum -c/);
  assert.ok(workflow.indexOf('sha256sum -c') < workflow.indexOf('gitleaks git'), 'the checksum is checked before the binary runs');
  assert.match(workflow, /releases\/download\/v\$\{GITLEAKS_VERSION\}\//);
  assert.match(workflow, /fetch-depth: 0/);
});
test('Dependabot watches the GitHub Actions the workflow uses', () => {
  const text = read('.github/dependabot.yml');
  assert.match(text, /^version: 2$/m);
  assert.match(text, /package-ecosystem: github-actions/);
  assert.match(text, /directory: \//);
  assert.doesNotMatch(text, /package-ecosystem: npm/, 'there are no npm packages to watch');
});
