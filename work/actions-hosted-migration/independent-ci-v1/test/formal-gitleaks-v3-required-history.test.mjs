// Offline unit tests for worker/formal-gitleaks-v3/required-history/prepare.mjs:
// the registered '/input' manifest cwd, the pinned reviewed-commit extraction,
// reviewed commits as pack tips, the fail-closed missing reviewed commit, and the
// exact accepted gitleaks.yml pin set (main and the frozen PR-B commit).
// No network, Docker, Host path or credential. Fixtures live under os.tmpdir().
// The trusted workflow bytes come from test/fixtures/trusted-workflows.json, never
// from the working tree, so these tests hold on a head carrying either version.
// This legacy Source keeps its old 726/helper bytes from its immutable source,
// independently of the active Source v4 successor's config and helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JOB_CONTRACT, jobId } from '../src/queue.mjs';
import { IMAGE, SCAN_ARGS, SOURCE_PINS, WORKFLOW_PATH, WORKFLOW_SHA256S, REVIEWED_COMMITS, prepareRequiredHistory, reviewedCommitsFromConfig }
  from '../worker/formal-gitleaks-v3/required-history/prepare.mjs';
import { workflowBytes } from './fixtures/trusted-workflows.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const LEGACY_SOURCE = 'f6ae29eda25c5ffa6131662e60251492e0878aa2';
function legacySource(relative) {
  const result = spawnSync('git', ['-C', ROOT, 'show', `${LEGACY_SOURCE}:${relative}`], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `legacy Source object missing: ${relative}`);
  assert.equal(sha256(result.stdout), SOURCE_PINS[relative], `legacy Source pin: ${relative}`);
  return result.stdout;
}
const CONFIG = legacySource('.gitleaks.toml');
const REVIEWED = reviewedCommitsFromConfig(CONFIG);

// prepare.mjs refuses a hard-linked Git executable; Git for Windows hard-links
// cmd/ and mingw64/bin/git.exe, so the test uses its single-link libexec copy.
const GIT = ['C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\git.exe', '/usr/bin/git']
  .find(file => { try { const s = fs.lstatSync(file); return s.isFile() && s.nlink === 1; } catch { return false; } }) ?? null;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Clued CI test', GIT_AUTHOR_EMAIL: 'ci-test@example.invalid', GIT_COMMITTER_NAME: 'Clued CI test',
  GIT_COMMITTER_EMAIL: 'ci-test@example.invalid', GIT_AUTHOR_DATE: '2026-10-20T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T00:00:00Z' };
function git(args, { input, maxBuffer = 1 << 30 } = {}) {
  const r = spawnSync(GIT, args, { input, env: GIT_ENV, maxBuffer });
  if (r.status !== 0) throw new Error(`git ${args[0]} ${args[1] ?? ''} failed: ${String(r.stderr).slice(0, 300)}`);
  return r.stdout;
}
const text = (args, options) => git(args, options).toString('utf8').trim();

async function scratch(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `clued-gitleaks-v3-${label}-`));
  t.after(async () => {
    // prepare.mjs seals the prepared repository read-only; reopen it for removal.
    const open = async p => { const s = await fsp.lstat(p); await fsp.chmod(p, s.isDirectory() ? 0o700 : 0o600);
      if (s.isDirectory()) for (const name of await fsp.readdir(p)) await open(path.join(p, name)); };
    await open(directory).catch(() => {}); await fsp.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
const MAIN_WORKFLOW = workflowBytes('main', WORKFLOW_PATH);
async function trustedSource(directory, workflow = MAIN_WORKFLOW) {
  const source = path.join(directory, 'source');
  for (const relative of Object.keys(SOURCE_PINS)) {
    const target = path.join(source, ...relative.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, legacySource(relative));
  }
  const target = path.join(source, ...WORKFLOW_PATH.split('/'));
  await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, workflow);
  return source;
}
function manifestBytes({ cwd = '/input', workflowPins = [sha256(MAIN_WORKFLOW)] } = {}) {
  return Buffer.from(JSON.stringify({ schema: 'independent-ci.sources.v1', repo: 'tdoljyj/cross-memory-system', sourceSha: 'c'.repeat(40),
    roles: { gitleaks: { containerCommand: { image: IMAGE, scanner: 'gitleaks', executable: '/usr/bin/gitleaks', cwd, args: [...SCAN_ARGS] },
      sourceFiles: [...Object.entries(SOURCE_PINS).map(([file, hash]) => ({ path: file, sha256: hash })),
        ...workflowPins.map(hash => ({ path: WORKFLOW_PATH, sha256: hash }))] } } }));
}
function gitleaksJob(headSha, baseSha, sourceManifestSha256) {
  const job = { contract: JOB_CONTRACT, id: '', repo: 'tdoljyj/cross-memory-system', pr: 884, headSha, baseSha,
    claimId: '11111111-1111-1111-1111-111111111111', fence: 1, epoch: 1, role: 'gitleaks', sourceManifestSha256,
    createdAt: new Date().toISOString(), attempt: 1 };
  job.id = jobId(job); return job;
}
const snapshot = (job, refs) => ({ contract: 'clued.independent-ci.remote-heads-tags/1', repository: job.repo, complete: true,
  observedAt: new Date().toISOString(), refs });
function bareStore(directory) {
  const store = path.join(directory, 'store.git');
  git(['init', '--bare', '--quiet', '--template=', store]);
  return store;
}
async function run({ directory, store, head, base, refs, cwd, workflow, workflowPins }) {
  const bytes = manifestBytes({ cwd, workflowPins }), manifestSha = sha256(bytes), job = gitleaksJob(head, base, manifestSha);
  return prepareRequiredHistory({ job, sourceManifestBytes: bytes, expectedSourceManifestSha256: manifestSha,
    trustedSourceDirectory: await trustedSource(directory, workflow), gitDirectory: store, remoteSnapshot: snapshot(job, refs ?? [{ name: 'refs/heads/main', objectSha: base }]),
    outputDirectory: path.join(directory, 'history'), gitExecutable: GIT, expectedGitSha256: GIT ? sha256(fs.readFileSync(GIT)) : '0'.repeat(64) });
}

test('the pinned .gitleaks.toml yields exactly the pinned reviewed commit set', () => {
  assert.equal(sha256(CONFIG), SOURCE_PINS['.gitleaks.toml']);
  assert.equal(REVIEWED.length, REVIEWED_COMMITS.commits);
  assert.equal(REVIEWED.length, 100);
  assert.deepEqual([...REVIEWED], [...REVIEWED].sort());
  assert.ok(REVIEWED.every(sha => /^[a-f0-9]{40}$/.test(sha)));
  // Same reading as reviewed_gitleaks.py: every fingerprint commit, distinct.
  const lines = CONFIG.toString('utf8').split('\n').filter(line => line.startsWith('# clued-reviewed-finding: '));
  assert.equal(lines.length, 726);
  assert.deepEqual([...REVIEWED], [...new Set(lines.map(line => JSON.parse(line.slice(26)).fingerprint.split(':', 1)[0]))].sort());
});

test('reviewed record extraction fails closed on any parse ambiguity or set change', () => {
  const original = CONFIG.toString('utf8');
  const record = original.split('\n').find(line => line.startsWith('# clued-reviewed-finding: '));
  const ambiguous = [
    original.replaceAll('\n', '\r\n'),
    original.slice(0, -1),
    original.replace(record, record.replace('{"fingerprint"', '{"extra":1,"fingerprint"')),
    original.replace(record, record.slice(0, -1)),
    original.replace(record, record.replace(/"fingerprint":"([a-f0-9]{40})/, (_, sha) => `"fingerprint":"${sha.slice(0, 12)}`)),
    original.replace('# clued-reviewed-count: 726\n', '# clued-reviewed-count: 726\n# clued-reviewed-count: 726\n'),
    original.replace('# clued-reviewed-count: 726', '# clued-reviewed-count: +726'),
    original.replace(record + '\n', ''),
    original.replace(record, record + '\n' + record),
    original + 'x\u00e9\n',
  ];
  for (const value of ambiguous) assert.throws(() => reviewedCommitsFromConfig(Buffer.from(value)), { code: 'REVIEWED_RECORDS_AMBIGUOUS' });
  assert.throws(() => reviewedCommitsFromConfig(Buffer.from([0xff, 0x0a])), { code: 'REVIEWED_RECORDS_AMBIGUOUS' });
  assert.throws(() => reviewedCommitsFromConfig(CONFIG, { ...REVIEWED_COMMITS, sha256: '0'.repeat(64) }), { code: 'REVIEWED_COMMIT_SET_CHANGED' });
  assert.throws(() => reviewedCommitsFromConfig(CONFIG, { ...REVIEWED_COMMITS, commits: 72 }), { code: 'REVIEWED_COMMIT_SET_CHANGED' });
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const small = ['title = "x"', '# clued-reviewed-count: 3', `# clued-reviewed-finding: {"fingerprint":"${b}:p:r:1","kinds":["K"]}`,
    `# clued-reviewed-finding: {"fingerprint":"${a}:p:r:2","kinds":["K"]}`, `# clued-reviewed-finding: {"fingerprint":"${b}:q:r:1","kinds":["K"]}`, ''].join('\n');
  assert.deepEqual([...reviewedCommitsFromConfig(Buffer.from(small), { findings: 3, commits: 2, sha256: sha256(`${a}\n${b}\n`) })], [a, b]);
});

test('the registered manifest cwd /input is accepted and the old /repo registration is refused', { skip: !GIT && 'no single-link git executable' }, async t => {
  const directory = await scratch(t, 'cwd'), store = bareStore(directory);
  const tree = text(['--git-dir=' + store, 'mktree'], { input: '' });
  const base = text(['--git-dir=' + store, 'commit-tree', tree, '-m', 'synthetic base']);
  const head = text(['--git-dir=' + store, 'commit-tree', tree, '-p', base, '-m', 'synthetic head']);
  await assert.rejects(run({ directory, store, head, base, cwd: '/repo' }), { code: 'REQUIRED_HISTORY_SOURCE_NOT_REGISTERED' });
  assert.equal(fs.existsSync(path.join(directory, 'history')), false);
  // '/input' passes registration and the pinned-source checks and reaches the
  // reviewed-commit store check, which this synthetic store cannot satisfy.
  await assert.rejects(run({ directory, store, head, base, cwd: '/input' }), { code: 'REVIEWED_COMMIT_NOT_IN_STORE' });
});

test('a reviewed commit missing from the object store fails closed before any pack is written', { skip: !GIT && 'no single-link git executable' }, async t => {
  const directory = await scratch(t, 'missing'), store = bareStore(directory);
  const tree = text(['--git-dir=' + store, 'mktree'], { input: '' });
  const base = text(['--git-dir=' + store, 'commit-tree', tree, '-m', 'synthetic base']);
  const head = text(['--git-dir=' + store, 'commit-tree', tree, '-p', base, '-m', 'synthetic head']);
  await assert.rejects(run({ directory, store, head, base }), { code: 'REVIEWED_COMMIT_NOT_IN_STORE' });
  const packDirectory = path.join(directory, 'history', 'repo', '.git', 'objects', 'pack');
  assert.deepEqual(fs.readdirSync(packDirectory), []);
  assert.equal(fs.existsSync(path.join(directory, 'history', 'input.json')), false);
});

test('exactly the two reviewed gitleaks.yml versions are trusted; a swapped, tampered, undeclared or duplicated pin is refused', { skip: !GIT && 'no single-link git executable' }, async t => {
  const directory = await scratch(t, 'workflow'), store = bareStore(directory);
  const tree = text(['--git-dir=' + store, 'mktree'], { input: '' });
  const base = text(['--git-dir=' + store, 'commit-tree', tree, '-m', 'synthetic base']);
  const head = text(['--git-dir=' + store, 'commit-tree', tree, '-p', base, '-m', 'synthetic head']);
  const attempt = async (label, options) => run({ directory: await fsp.mkdtemp(path.join(directory, `${label}-`)), store, head, base, ...options });
  const main = workflowBytes('main', WORKFLOW_PATH), prB = workflowBytes('pr-b', WORKFLOW_PATH);
  assert.deepEqual([...WORKFLOW_SHA256S], [sha256(main), sha256(prB)]);
  assert.equal(Object.hasOwn(SOURCE_PINS, WORKFLOW_PATH), false);
  // Either reviewed version passes every pinned-source check and stops at this synthetic store's reviewed-commit check.
  for (const [label, bytes] of [['main', main], ['pr-b', prB]]) {
    await assert.rejects(attempt(label, { workflow: bytes, workflowPins: [sha256(bytes)] }), { code: 'REVIEWED_COMMIT_NOT_IN_STORE' }, label);
  }
  const tampered = Buffer.concat([prB, Buffer.from('# tampered\n')]);
  const refused = [
    ['swapped', { workflow: prB, workflowPins: [sha256(main)] }, 'TRUSTED_REVIEW_SOURCE_CHANGED'],
    ['tampered-declared', { workflow: tampered, workflowPins: [sha256(tampered)] }, 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED'],
    ['tampered-file', { workflow: tampered, workflowPins: [sha256(prB)] }, 'TRUSTED_REVIEW_SOURCE_CHANGED'],
    ['undeclared', { workflow: main, workflowPins: [] }, 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED'],
    ['duplicated', { workflow: main, workflowPins: [sha256(main), sha256(prB)] }, 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED'],
  ];
  for (const [label, options, code] of refused) {
    const before = new Set(fs.readdirSync(directory));
    await assert.rejects(attempt(label, options), { code }, label);
    // Refused before any output: the run directory holds only its trusted source.
    const created = fs.readdirSync(directory).filter(name => !before.has(name));
    assert.equal(created.length, 1, label); assert.deepEqual(fs.readdirSync(path.join(directory, created[0])), ['source'], label);
  }
});

const localHistory = (() => {
  if (!GIT) return false;
  const r = spawnSync(GIT, ['-C', ROOT, 'cat-file', '--batch-check=%(objecttype)'], { input: REVIEWED.join('\n') + '\n', env: GIT_ENV });
  return r.status === 0 && String(r.stdout).trim().split('\n').every(type => type === 'commit') && String(r.stdout).trim().split('\n').length === REVIEWED.length;
})();

test('reviewed commits unreachable from the refs and head are packed as tips, never as refs', { skip: !localHistory && 'reviewed commits not in the local history', timeout: 600000 }, async t => {
  const directory = await scratch(t, 'tips'), store = bareStore(directory);
  // Store = closure of the reviewed commits, copied from the local repository only.
  const pack = git(['-C', ROOT, 'pack-objects', '--revs', '--stdout', '--quiet'], { input: REVIEWED.join('\n') + '\n' });
  git(['--git-dir=' + store, 'index-pack', '--stdin', '--strict'], { input: pack });
  const [head, base] = [REVIEWED[0], REVIEWED[1]];
  const prepared = await run({ directory, store, head, base });
  assert.equal(prepared.reviewedCommitCount, 100);
  assert.equal(prepared.reviewedCommitsSha256, REVIEWED_COMMITS.sha256);
  assert.equal(prepared.refScope, 'fresh-remote-heads-tags-plus-current-head');
  const dotgit = path.join(prepared.repository, '.git');
  assert.equal(fs.existsSync(path.join(dotgit, 'objects', 'info', 'alternates')), false);
  // Without any alternate: every reviewed commit is a commit in the prepared repository.
  const types = text(['--git-dir=' + dotgit, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: REVIEWED.join('\n') + '\n' });
  assert.equal(types, REVIEWED.map(sha => `${sha} commit`).join('\n'));
  // At least one reviewed commit is reachable from neither the remote refs nor head.
  const fromRefsAndHead = new Set(text(['--git-dir=' + dotgit, 'rev-list', head, base]).split('\n'));
  assert.ok(REVIEWED.filter(sha => !fromRefsAndHead.has(sha)).length > 0);
  // The scanned ref set is unchanged: exactly the remote snapshot refs.
  assert.equal(text(['--git-dir=' + dotgit, 'for-each-ref', '--format=%(refname) %(objectname)']), `refs/heads/main ${base}`);
  assert.equal(fs.readFileSync(path.join(prepared.repository, '.gitleaks.toml')).equals(CONFIG), true);
});
