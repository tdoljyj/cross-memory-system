import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHECK_IDS, GENERATED, COMPONENTS_FIX, checkAll, exitCode, render, resolveBase } from './check-pinned-registries.mjs';
import { PINNED_REGISTRY_PATHS, globToRegExp } from './ci-required-selection.mjs';
import { SOURCE_FILE, sourceClosure } from './clued-merge-reconcile-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const CLI = path.join(here, 'check-pinned-registries.mjs');

test('component remediation uses the automatic clean-candidate integrator instead of manual version edits', () => {
  assert.match(COMPONENTS_FIX, /component-version-integration\.py/);
  assert.match(COMPONENTS_FIX, /--base.*--expect-head.*--write/);
  assert.doesNotMatch(COMPONENTS_FIX, /clued_components\.py bump/);
});

test('unobservable control Source version pins fail closed even in CI', () => {
  assert.equal(exitCode([{ id: 'control-source-pins', status: 'unchecked', reason: 'trusted base unavailable' }], { GITHUB_ACTIONS: 'true' }), 1);
  assert.equal(exitCode([{ id: 'control-source-pins', status: 'stale' }], { GITHUB_ACTIONS: 'true' }), 1);
  assert.equal(exitCode([{ id: 'control-source-pins', status: 'ok' }], { GITHUB_ACTIONS: 'true' }), 0);
});

test('a change to the mechanical policy always selects pinned registries', () => {
  assert.ok(PINNED_REGISTRY_PATHS.some(pattern => globToRegExp(pattern).test('config/clued-mechanical-files.json')),
    'the selector integration must register config/clued-mechanical-files.json');
});

test('the single generated-file list must parse and tampering fails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-mechanical-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const file = path.join(root, 'config/clued-mechanical-files.json');
  fs.copyFileSync(path.join(repo, 'config/clued-mechanical-files.json'), file);
  const run = () => checkAll({ root, only: ['mechanical-policy'], knownMainRefs: () => [] });
  let report = await run();
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, 'ok');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"marker_paths": [', '"marker_paths": ["../escape",'));
  report = await run();
  assert.equal(report.results[0].status, 'stale');
  assert.equal(exitCode(report.results, {}), 1);
  assert.match(render(report), /invalid scoped mechanical-file policy/);
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir, message) => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message); };
const cli = (root, ...args) => spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
// The checks that need no installed dependencies; pdf-cmaps and imprint-rules are "could not check" without npm ci.
const NO_DEPS = ['r9', 'reconcile', 'components', 'agent-contract', 'plugin'].flatMap((id) => ['--only', id]);
const matches = (file) => PINNED_REGISTRY_PATHS.some((p) => globToRegExp(p).test(file));

const R9 = 'scripts/ci/merge-admission-r9-source.json';
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

function unpackFixture(tar, dir, executable = 'tar') {
  const args = ['-xf', '-'];
  // Windows bsdtar needs the Git archive's filename encoding on non-UTF-8 systems.
  if (process.platform === 'win32' && /^bsdtar\b/.test(execFileSync(executable, ['--version'], { encoding: 'utf8' }))) {
    args.push('--options', 'hdrcharset=UTF-8');
  }
  // Let the OS set the directory so tar never has to parse a Windows drive path.
  const unpacked = spawnSync(executable, args, { cwd: dir, input: tar });
  assert.ifError(unpacked.error);
  assert.equal(unpacked.status, 0, String(unpacked.stderr));
}

test('a Git archive unpacks into a fixture under TEMP', async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-archive-source-'));
  t.after(() => cleanup(source));
  const file = '归档夹具.txt';
  git(source, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(source, file), 'fixture');
  commit(source, 'archive fixture');
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: source });
  const check = (subtest, executable) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-archive-'));
    subtest.after(() => cleanup(dir));
    unpackFixture(tar, dir, executable);
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), 'fixture');
  };
  await t.test('tar from PATH', subtest => check(subtest, 'tar'));
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const windowsTar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
    if (fs.existsSync(windowsTar)) {
      await t.test('Windows system bsdtar', subtest => check(subtest, windowsTar));
    }
  }
});

// The committed tree (git archive HEAD) in a temporary git repository of its own, so a pinned file can be
// changed without touching this checkout. Only committed files are in it. A fresh repository, not a clone:
// the R9 helper refuses a shallow one.
function copyOfThisCheckout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-registries-'));
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repo, maxBuffer: 1 << 30 });
  unpackFixture(tar, dir);
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  commit(dir, 'main');
  return dir;
}
const byId = (report, id) => report.results.find((r) => r.id === id);

// The copy is built once (it holds the whole committed tree); each test starts from its committed state again.
let shared = null;
function registeredCopy() {
  if (shared === null) shared = copyOfThisCheckout();
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
    const r = cli(dir, '--base', 'HEAD', ...NO_DEPS);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ok\s+r9/); assert.match(r.stdout, /ok\s+reconcile/); assert.match(r.stdout, /ok\s+components/);
    assert.match(r.stdout, /ok\s+agent-contract/); assert.match(r.stdout, /ok\s+plugin/);
    assert.match(r.stdout, /all pinned registries are up to date/);
  } finally { /* the shared copy is reset by the next test */ }
});

test('the R9 registration still requires its own historical pins', () => {
  const dir = registeredCopy();
  fs.appendFileSync(path.join(dir, 'scripts/ci/merge-admission-source-producer.mjs'), '\n// changed after registration\n');
  const before = cli(dir, '--base', 'HEAD', ...NO_DEPS);
  assert.equal(before.status, 1, before.stdout + before.stderr);
  assert.match(before.stdout, /STALE\s+r9/);
  assert.match(before.stdout, /regenerate: node scripts\/ci\/merge-admission-r9-reregister\.mjs --write --base HEAD/);
  assert.match(before.stdout, /ok\s+reconcile/);
  assert.match(before.stdout, /1 registry is stale/);
  const fix = spawnSync(process.execPath, ['scripts/ci/merge-admission-r9-reregister.mjs', '--write', '--base', 'HEAD'],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(fix.status, 0, fix.stdout + fix.stderr);
  const after = cli(dir, '--base', 'HEAD', ...NO_DEPS);
  assert.equal(after.status, 0, after.stdout + after.stderr);
});

test('a stored closure table cannot pass the registration check', () => {
  const dir = registeredCopy(), file = path.join(dir, SOURCE_FILE);
  const registration = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...registration, files: {} }));
  const result = cli(dir, '--base', 'HEAD', '--only', 'reconcile');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /STALE\s+reconcile/);
  assert.match(result.stdout, /MERGE_RECONCILE_SOURCE_UNQUALIFIED/);
});

test('a stale component manifest is reported with the integration command; a stored digest is refused', () => {
  const dir = registeredCopy();
  try {
    const file = path.join(dir, 'config/clued-components.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(manifest.components.every((c) => !('content_sha256' in c)), 'no component stores a digest');
    manifest.components[0].content_sha256 = '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    let r = cli(dir, '--base', 'HEAD', '--only', 'components');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /STALE\s+components\s+\(config\/clued-components\.json\)/);
    assert.match(r.stdout, /stores content_sha256/);
    assert.match(r.stdout, /component-version-integration\.py/); assert.doesNotMatch(r.stdout, /clued_components\.py update/);
    // --only must still run/report only the component check.
    assert.doesNotMatch(r.stdout, /^\s*(?:ok|STALE|UNCHECKED)\s+(?:r9|reconcile)\b/m);
    assert.match(r.stdout, /1 registry is stale/);
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
  const core = full.results.filter((r) => r.status === 'unchecked' && ['r9', 'components'].includes(r.id));
  if (core.length) return t.skip(core.map((r) => `${r.id}: ${r.reason}`).join('; '));
  // pdf-cmaps and imprint-rules are "could not check" without npm ci; anything that was checked must be current.
  assert.deepEqual(full.results.filter((r) => r.status === 'stale').map((r) => r.id), [], render(full));
  assert.deepEqual(full.results.map((r) => r.id), CHECK_IDS);
});

// Generated files. Each has a generator with --check and a CI test that fails when the committed output is old.
test('every generated file is listed with a --check command, a fix and an id --only accepts', () => {
  assert.deepEqual(GENERATED.map((g) => g.id), ['agent-contract', 'plugin', 'pdf-cmaps', 'imprint-rules']);
  for (const g of GENERATED) {
    assert.ok(CHECK_IDS.includes(g.id)); assert.ok(g.cmd.includes('--check')); assert.ok(g.fix && g.registry);
    const script = g.cmd.find((a) => /\.(mjs|py)$/.test(a)); assert.ok(fs.existsSync(path.join(repo, script)), script);
  }
});

test('a changed agent contract makes the generated worker modules stale; the printed command fixes it', () => {
  const dir = registeredCopy();
  try {
    fs.appendFileSync(path.join(dir, 'protocol/agent/agent-contract.md'), '\nA sentence added after generation.\n');
    let r = cli(dir, '--base', 'HEAD', '--only', 'agent-contract');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /STALE\s+agent-contract/); assert.match(r.stdout, /agent-contract\.ts is out of date/);
    assert.match(r.stdout, /regenerate: node apps\/clued-cloud\/scripts\/generate-agent-contract\.mjs\n/);
    const fix = spawnSync(process.execPath, ['apps/clued-cloud/scripts/generate-agent-contract.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(fix.status, 0, fix.stdout + fix.stderr);
    r = cli(dir, '--base', 'HEAD', '--only', 'agent-contract'); assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { /* the shared copy is reset by the next test */ }
});

test('a changed skill makes the plugin copies stale; the printed command fixes it', () => {
  const dir = registeredCopy();
  try {
    const skill = git(dir, 'ls-files', 'skills/clued').split('\n').find((f) => f.endsWith('.md'));
    fs.appendFileSync(path.join(dir, skill), '\nChanged after the plugin was built.\n');
    let r = cli(dir, '--base', 'HEAD', '--only', 'plugin');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /STALE\s+plugin\s+\(integrations\/claude-code\/clued\/\)/); assert.match(r.stdout, /regenerate: python3? scripts\/build_claude_code_plugin\.py\n/);
    const x = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/build_claude_code_plugin.py'], { cwd: dir, encoding: 'utf8' });
    assert.equal(x.status, 0, x.stdout + x.stderr);
    r = cli(dir, '--base', 'HEAD', '--only', 'plugin'); assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { /* the shared copy is reset by the next test */ }
});

test('generators that need npm ci are "could not check" without it, and stale when their --check fails', () => {
  const dir = registeredCopy();
  try {
    let r = cli(dir, '--base', 'HEAD', '--only', 'pdf-cmaps', '--only', 'imprint-rules');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /UNCHECKED\s+pdf-cmaps/); assert.match(r.stdout, /UNCHECKED\s+imprint-rules/); assert.match(r.stdout, /npm ci/);
    // With the dependency present, the generator's own verdict counts. The generators are replaced by stubs
    // here (the real ones need the whole dependency tree); the exit status is what the check reads.
    for (const [pkg, script, status] of [['pdfjs-dist', 'generate-pdf-cmaps', 1], ['typescript', 'generate-imprint-domain-rules', 0]]) {
      fs.mkdirSync(path.join(dir, 'apps/clued-cloud/node_modules', pkg), { recursive: true });
      fs.writeFileSync(path.join(dir, 'apps/clued-cloud/node_modules', pkg, 'package.json'), '{}');
      fs.writeFileSync(path.join(dir, `apps/clued-cloud/scripts/${script}.mjs`), `console.error('stub says out of date'); process.exit(process.argv.includes('--check') ? ${status} : 0);\n`);
    }
    r = cli(dir, '--base', 'HEAD', '--only', 'pdf-cmaps', '--only', 'imprint-rules');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /STALE\s+pdf-cmaps/); assert.match(r.stdout, /stub says out of date/); assert.match(r.stdout, /ok\s+imprint-rules/);
    assert.match(r.stdout, /fix sequence[\s\S]*generate-pdf-cmaps\.mjs\n/);
  } finally { fs.rmSync(path.join(dir, 'apps/clued-cloud/node_modules'), { recursive: true, force: true }); }
});

// Regression (main 4b1cc800): a pins change passed against the old main but
// failed as soon as it became the base. A committed checkout is checked as its own base too.
test('control-source-pins also checks the committed checkout as its own trusted base', async () => {
  const head = git(repo, 'rev-parse', 'HEAD');
  const report = await checkAll({ root: repo, base: head, only: ['control-source-pins'], knownMainRefs: () => [] });
  const clean = git(repo, 'status', '--porcelain', '--untracked-files=no') === '';
  if (clean) assert.equal(report.results[0].status, 'ok', render(report));
});
