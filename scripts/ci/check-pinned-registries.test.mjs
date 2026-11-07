import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkAll, exitCode, render, resolveBase } from './check-pinned-registries.mjs';
import { PINNED_REGISTRY_PATHS, globToRegExp } from './ci-required-selection.mjs';
import { SOURCE_FILE, hash, sourceClosure } from './clued-merge-reconcile-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const CLI = path.join(here, 'check-pinned-registries.mjs');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir, message) => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message); };
const cli = (root, ...args) => spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
const matches = (file) => PINNED_REGISTRY_PATHS.some((p) => globToRegExp(p).test(file));

const R9 = 'scripts/ci/merge-admission-r9-source.json';

// The committed tree (git archive HEAD) in a temporary git repository of its own, so a pinned file can be
// changed without touching this checkout. Only committed files are in it. A fresh repository, not a clone:
// the R9 helper refuses a shallow one.
function copyOfThisCheckout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-registries-'));
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repo, maxBuffer: 1 << 30 });
  const unpacked = spawnSync('tar', ['-x', '-C', dir], { input: tar });
  assert.equal(unpacked.status, 0, String(unpacked.stderr));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  commit(dir, 'main');
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const byId = (report, id) => report.results.find((r) => r.id === id);

// What the build script does to the registry (the bytes of every closure file), without needing yaml.
function refreshReconcile(dir) {
  const file = path.join(dir, SOURCE_FILE), source = JSON.parse(fs.readFileSync(file, 'utf8'));
  source.files = Object.fromEntries(sourceClosure(dir).map((name) => [name, hash(fs.readFileSync(path.join(dir, name)))]));
  fs.writeFileSync(file, JSON.stringify(source, null, 2) + '\n');
}
// A registered copy: this checkout's files with the reconcile registry brought up to date for the files this
// change adds, committed as the base.
// The copy is built once (it holds the whole committed tree); each test starts from its committed state again.
let shared = null;
function registeredCopy() {
  if (shared === null) { shared = copyOfThisCheckout(); refreshReconcile(shared); commit(shared, 'registered'); }
  git(shared, 'reset', '-q', '--hard'); git(shared, 'clean', '-fdq');
  return shared;
}
test.after(() => { if (shared !== null) cleanup(shared); });

test('every file the R9 and reconcile registries pin is covered by the selection patterns', () => {
  const r9 = JSON.parse(fs.readFileSync(path.join(repo, R9), 'utf8'));
  const pinned = new Set([R9, r9.publisher_role.workflow_path, r9.admission_source.script_path, r9.admission_source.workflow_path,
    r9.admission_source.reverify_workflow_path, r9.admission_source.policy_path,
    'scripts/ci/clued-gated-proof-profiles.json', 'scripts/ci/clued-gated-proof-role-specs.json',
    ...r9.natural_producers.flatMap((d) => Object.keys(d.source_blobs)), ...sourceClosure(repo), SOURCE_FILE]);
  for (const file of pinned) assert.ok(matches(file), `${file} is pinned by a registry but selects no pinned-registries check`);
});

test('an up to date tree passes', () => {
  const dir = registeredCopy();
  try {
    const r = cli(dir, '--base', 'HEAD');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ok\s+r9/); assert.match(r.stdout, /ok\s+reconcile/); assert.match(r.stdout, /ok\s+components/);
    assert.match(r.stdout, /all pinned registries are up to date/);
  } finally { /* the shared copy is reset by the next test */ }
});

test('changing a pinned file names the stale registries and the commands that fix them; regenerating clears them', () => {
  const dir = registeredCopy();
  try {
    // Pinned by the R9 registry and part of the reconcile closure.
    fs.appendFileSync(path.join(dir, 'scripts/ci/merge-admission-source-producer.mjs'), '\n// changed after registration\n');

    let r = cli(dir, '--base', 'HEAD');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /STALE\s+r9\s+\(scripts\/ci\/merge-admission-r9-source\.json\)/);
    assert.match(r.stdout, /regenerate: node scripts\/ci\/merge-admission-r9-reregister\.mjs --write --base HEAD/);
    assert.match(r.stdout, /STALE\s+reconcile\s+\(scripts\/ci\/clued-merge-reconcile-source\.json\)/);
    assert.match(r.stdout, /bytes differ from the registry: scripts\/ci\/merge-admission-source-producer\.mjs/);
    assert.match(r.stdout, /regenerate: node scripts\/ci\/clued-merge-reconcile-source-build\.mjs/);
    assert.match(r.stdout, /ok\s+components/);
    assert.match(r.stdout, /2 registries are stale/);
    assert.match(r.stdout, /fix sequence/);
    assert.match(r.stdout, /clued-merge-reconcile-source-build\.mjs[\s\S]*clued_components\.py update[\s\S]*generate-agent-contract\.mjs[\s\S]*check-pinned-registries\.mjs/);

    r = cli(dir, '--base', 'HEAD', '--only', 'components'); assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /r9|reconcile/);

    // The printed commands, in the printed order. The reconcile build script needs yaml, which is not
    // installed everywhere; its effect on the registry is applied directly.
    const fix = spawnSync(process.execPath, [path.join(dir, 'scripts/ci/merge-admission-r9-reregister.mjs'), '--write', '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    assert.equal(fix.status, 0, fix.stdout + fix.stderr);
    r = cli(dir, '--base', 'HEAD');
    assert.equal(r.status, 1); assert.match(r.stdout, /ok\s+r9/); assert.match(r.stdout, /STALE\s+reconcile/);
    refreshReconcile(dir);
    // The reconcile registry is itself a file of the script.merge-reconciliation component, so the registries
    // chase each other: regenerating it makes the component digest stale, and the check says so.
    r = cli(dir, '--base', 'HEAD');
    assert.equal(r.status, 1, r.stdout); assert.match(r.stdout, /ok\s+reconcile/); assert.match(r.stdout, /STALE\s+components/);
    const update = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/clued_components.py', 'update'], { cwd: dir, encoding: 'utf8' });
    assert.equal(update.status, 0, update.stdout + update.stderr);
    r = cli(dir, '--base', 'HEAD');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { /* the shared copy is reset by the next test */ }
});

test('a new or removed file under a locked directory makes the reconcile registry stale', () => {
  const dir = registeredCopy();
  try {
    fs.writeFileSync(path.join(dir, 'scripts/ci/brand-new-helper.mjs'), 'export {};\n');
    fs.rmSync(path.join(dir, 'scripts/ci/clued-push-reuse.mjs'));
    const r = cli(dir, '--base', 'HEAD', '--only', 'reconcile');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /not registered \(new file\): scripts\/ci\/brand-new-helper\.mjs/);
    assert.match(r.stdout, /registered but gone: scripts\/ci\/clued-push-reuse\.mjs/);
  } finally { /* the shared copy is reset by the next test */ }
});

test('a stale component manifest is reported with its bump and update commands', () => {
  const dir = registeredCopy();
  try {
    const file = path.join(dir, 'config/clued-components.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const withDigest = manifest.components.find((c) => c.content_sha256);
    assert.ok(withDigest, 'the manifest has a component with a digest');
    withDigest.content_sha256 = '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    const r = cli(dir, '--base', 'HEAD', '--only', 'components');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /STALE\s+components\s+\(config\/clued-components\.json\)/);
    assert.match(r.stdout, /clued_components\.py bump/); assert.match(r.stdout, /clued_components\.py update/);
  } finally { /* the shared copy is reset by the next test */ }
});

test('an unusable base is "could not check", not a pass; under GitHub Actions it only warns', async () => {
  const dir = registeredCopy();
  try {
    const report = await checkAll({ root: dir, base: 'no-such-ref', only: ['r9', 'components'], env: {} });
    assert.equal(byId(report, 'r9').status, 'unchecked'); assert.equal(byId(report, 'components').status, 'unchecked');
    assert.equal(exitCode(report.results, {}), 2);
    assert.equal(exitCode(report.results, { GITHUB_ACTIONS: 'true' }), 0);
    assert.equal(exitCode([{ status: 'stale' }, { status: 'unchecked' }], { GITHUB_ACTIONS: 'true' }), 1, 'stale always fails');
    assert.match(render(report), /could not be checked/);
  } finally { /* the shared copy is reset by the next test */ }
});

test('resolveBase prefers an explicit value, then CI_BASE_SHA, then CLUED_R9_BASE, ignoring all zeros', () => {
  assert.equal(resolveBase(repo, 'abc', { CI_BASE_SHA: 'def' }), 'abc');
  assert.equal(resolveBase(repo, null, { CI_BASE_SHA: 'def', CLUED_R9_BASE: 'x' }), 'def');
  assert.equal(resolveBase(repo, null, { CI_BASE_SHA: '0000', CLUED_R9_BASE: 'x' }), 'x');
  assert.equal(resolveBase(repo, null, {}, () => []), null);
});

test('this checkout has no stale pinned registry (needs full history and a resolvable main)', async (t) => {
  const reconcile = await checkAll({ root: repo, only: ['reconcile'] });
  assert.equal(byId(reconcile, 'reconcile').status, 'ok', render(reconcile));
  const full = await checkAll({ root: repo });
  const unchecked = full.results.filter((r) => r.status === 'unchecked');
  if (unchecked.length) return t.skip(unchecked.map((r) => `${r.id}: ${r.reason}`).join('; '));
  assert.deepEqual(full.results.map((r) => r.status), ['ok', 'ok', 'ok'], render(full));
});
