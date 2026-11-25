// FABLE-cicd-simplify-20261122 3.1 (R1): the required gitleaks job and scripts/ci/gitleaks-range.sh. A secret written
// while resolving a merge conflict is a finding (--remerge-diff); an octopus merge is refused; a scan that did not finish
// (gitleaks 8.30.1 prints ERR and still exits 0) fails; the three scans run beside the tests, not after them.
//
// A stub gitleaks (git log -p over the same log options, ERR and exit 0 when git fails, as 8.30.1 does) runs everywhere;
// the pinned 8.30.1 binary runs too where it is installed (GITLEAKS, or the Windows hosts' D:/w/tools copy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'gitleaks-range.sh');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'clued-required-tests.yml');
const fwd = (p) => p.replace(/\\/g, '/');
const NODE = fwd(process.execPath);
// Matched by the repository's generic-api-key rule (FABLE-gitleaks-merge-commit-20261122, measured); assembled at
// run time so this file itself never carries the finding the commit and push scanners would block.
const LIT = ['const k = { policy', "Key: 'park.stage8Retries", "Per24h' };\n"].join('');

// Never the bash on PATH under Windows (it may be WSL's): Git for Windows' own bash.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const bash = exec && path.resolve(exec, '..', '..', '..', 'bin', 'bash.exe');
  return bash && existsSync(bash) ? bash : null;
}
const BASH = findBash();
const GITLEAKS = [process.env.GITLEAKS, 'D:/w/tools/gitleaks-8.30.1/gitleaks.exe'].find((p) => p && existsSync(p)) || null;
const noBash = BASH ? false : 'Git for Windows bash not found';
const noGitleaks = !BASH ? noBash : (GITLEAKS ? false : 'pinned gitleaks 8.30.1 binary not installed here');

const TMP = mkdtempSync(path.join(os.tmpdir(), 'gitleaks-range-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
const GLOBAL = path.join(TMP, 'gitconfig');
writeFileSync(GLOBAL, '[user]\n\tname = t\n\temail = t@invalid\n[commit]\n\tgpgSign = false\n[core]\n\thooksPath =\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
for (const key of Object.keys(ENV)) if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key)) delete ENV[key];

// The stub: git log -p -U0 over the given log options; a failed git log is ERR and exit 0 (8.30.1); an added line with the
// literal's shape is a finding, exit 1.
const STUB = path.join(TMP, 'gitleaks-stub.mjs');
writeFileSync(STUB, `import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2);
const src = a[a.indexOf('git') + 1];
const opts = (a.find((x) => x.startsWith('--log-opts=')) || '--log-opts=').slice(11).split(/\\s+/).filter(Boolean);
const r = spawnSync('git', ['-C', src, 'log', '-p', '-U0', '--no-color', ...opts], { encoding: 'utf8' });
if (r.status !== 0) { console.log('3:04PM \\x1b[31mERR\\x1b[0m [git] ' + (r.stderr || '').trim()); console.log('3:04PM INF 0 commits scanned.'); console.log('3:04PM INF no leaks found'); process.exit(0); }
if (/^\\+.*policyKey: '/m.test(r.stdout)) { console.log('Finding: policyKey: REDACTED'); console.log('3:04PM WRN leaks found: 1'); process.exit(1); }
console.log('3:04PM INF no leaks found');
`);

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
let serial = 0;
function repo() {
  const dir = path.join(TMP, `r${serial++}`);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}
function commit(dir, files, message) {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
const parents = (dir, sha) => git(dir, 'log', '-1', '--format=%P', sha).split(' ').length;

// main moves k.js to 2, the branch to 3, the branch merges main and its author resolves the conflict with `resolution`.
function conflictMerge(resolution) {
  const dir = repo();
  commit(dir, { 'src/k.js': 'const k = 1;\n' }, 'base');
  git(dir, 'checkout', '-q', '-b', 'work');
  commit(dir, { 'src/k.js': 'const k = 3;\n' }, 'branch change');
  git(dir, 'checkout', '-q', 'main');
  const base = commit(dir, { 'src/k.js': 'const k = 2;\n' }, 'main moves');
  git(dir, 'checkout', '-q', 'work');
  const merge = spawnSync('git', ['merge', '--no-edit', 'main'], { cwd: dir, encoding: 'utf8', env: ENV });
  assert.notEqual(merge.status, 0, 'precondition: the merge conflicts');
  writeFileSync(path.join(dir, 'src/k.js'), resolution);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-edit');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.equal(parents(dir, head), 2, 'precondition: a two-parent merge');
  return { dir, base, head };
}
// main gains a historical finding in its own file; the branch merges main without a conflict.
function cleanMergeOverMainFinding() {
  const dir = repo();
  commit(dir, { 'src/a.txt': 'a\n' }, 'base');
  git(dir, 'checkout', '-q', '-b', 'work');
  commit(dir, { 'src/b.txt': 'b\n' }, 'branch change');
  git(dir, 'checkout', '-q', 'main');
  const base = commit(dir, { 'src/main-k.js': LIT }, 'main finding');
  git(dir, 'checkout', '-q', 'work');
  git(dir, 'merge', '-q', '--no-edit', 'main');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}
function octopusMerge() {
  const dir = repo();
  const base = commit(dir, { 'src/a.txt': 'a\n' }, 'base');
  for (const side of ['x', 'y']) {
    git(dir, 'checkout', '-q', '-b', `side-${side}`, base);
    commit(dir, { [`src/${side}.txt`]: `${side}\n` }, side);
  }
  git(dir, 'checkout', '-q', '-b', 'work', base);
  commit(dir, { 'src/b.txt': 'b\n' }, 'branch change');
  git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'side-x', 'side-y');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.equal(parents(dir, head), 3, 'precondition: an octopus merge');
  return { dir, base, head };
}
function plainCommits(files) {
  const dir = repo();
  const base = commit(dir, { 'src/a.txt': 'a\n' }, 'base');
  return { dir, base, head: commit(dir, files, 'change') };
}

const stubCommand = (dir) => [NODE, fwd(STUB), 'git', fwd(dir)];
const realCommand = (dir) => [fwd(GITLEAKS), 'git', fwd(dir), '--config', fwd(path.join(ROOT, '.gitleaks.toml')), '--redact', '--no-banner', '--exit-code', '1'];
function range({ dir, base, head }, command, env = {}) {
  const r = spawnSync(BASH, [fwd(SCRIPT), fwd(dir), base, head, '--', ...command], { encoding: 'utf8', env: { ...ENV, ...env }, timeout: 240000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
// The pre-R1 command: gitleaks over the range's log, without --remerge-diff and without reading its output.
function plainGitleaks({ dir, base, head }, command, env = {}) {
  const [bin, ...args] = command;
  return spawnSync(bin, [...args, `--log-opts=${base}..${head}`], { encoding: 'utf8', env: { ...ENV, ...env }, timeout: 240000 }).status;
}
const BOGUS_LOG = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'log.date', GIT_CONFIG_VALUE_0: 'bogus' };

for (const [kind, command, skip] of [['stub', stubCommand, noBash], ['gitleaks 8.30.1', realCommand, noGitleaks]]) {
  test(`${kind}: a secret written while resolving a merge conflict is a finding (the pre-R1 scan misses it)`, { skip }, () => {
    const c = conflictMerge(LIT);
    assert.equal(plainGitleaks(c, command(c.dir)), 0, 'precondition: without --remerge-diff the resolved line is not scanned');
    const r = range(c, command(c.dir));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /gitleaks exited 1/);
    assert.doesNotMatch(r.out, /no finding/);
  });

  test(`${kind}: a clean merge of main passes; main's own historical finding is not reported again`, { skip }, () => {
    const c = cleanMergeOverMainFinding();
    assert.equal(plainGitleaks({ ...c, base: `${c.base}~1`, head: c.base }, command(c.dir)), 1, 'precondition: main\'s finding is recognized');
    const r = range(c, command(c.dir));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /scanned, no finding/);
  });

  test(`${kind}: a conflict resolved by keeping main's side unchanged passes (kept lines are context)`, { skip }, () => {
    const c = conflictMerge('const k = 2;\n');
    const r = range(c, command(c.dir));
    assert.equal(r.code, 0, r.out);
  });

  test(`${kind}: a scan that did not finish (git log fails, gitleaks prints ERR and exits 0) fails`, { skip }, () => {
    const c = plainCommits({ 'src/b.txt': 'b\n' });
    assert.equal(plainGitleaks(c, command(c.dir), BOGUS_LOG), 0, 'precondition: gitleaks exits 0 having scanned nothing');
    const r = range(c, command(c.dir), BOGUS_LOG);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /logged an error/);
  });

  test(`${kind}: a secret in an ordinary commit is a finding`, { skip }, () => {
    const c = plainCommits({ 'src/k.js': LIT });
    const r = range(c, command(c.dir));
    assert.equal(r.code, 1, r.out);
  });
}

test('an octopus merge is refused before gitleaks runs (--remerge-diff skips it)', { skip: noBash }, () => {
  const c = octopusMerge();
  const r = range(c, [NODE, '-e', 'console.log("SCANNER RAN")', '--']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /octopus merge [0-9a-f]{40}/);
  assert.doesNotMatch(r.out, /SCANNER RAN/);
});

test('a range that is not two commits of the repository, or a short command line, is refused', { skip: noBash }, () => {
  const c = plainCommits({ 'src/b.txt': 'b\n' });
  for (const [base, head, re] of [
    ['main', c.head, /not a full commit id/],
    ['0'.repeat(40), c.head, /not a full commit id/],
    [c.base, 'f'.repeat(40), /is not in/],
  ]) {
    const r = range({ ...c, base, head }, stubCommand(c.dir));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re);
  }
  const r = spawnSync(BASH, [fwd(SCRIPT), fwd(c.dir), c.base, c.head], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/);
});

test('a scanner that exits non-zero for any reason fails the range', { skip: noBash }, () => {
  const c = plainCommits({ 'src/b.txt': 'b\n' });
  const r = range(c, [NODE, '-e', 'process.exit(2)', '--']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gitleaks exited 2/);
});

// ---- the workflow ----
const yaml = createRequire(path.join(ROOT, 'apps', 'clued-cloud', 'package.json'))('yaml');
const workflow = () => yaml.parse(readFileSync(WORKFLOW, 'utf8'));
const SCANS = ['gitleaks', 'trivy', 'contract-placement'];
const TESTS = ['clued-cloud-tests', 'ci-suites', 'migration-verify'];
const POOL = ['self-hosted', 'Linux', 'X64', 'clued', 'pool-general', 'trust-internal'];
const step = (job, name) => {
  const found = job.steps.find((s) => s.name === name);
  assert.ok(found, `step ${name}`);
  return found;
};

test('the three scans are jobs of the required workflow beside the tests: each needs only the gate, nothing needs them', () => {
  const { jobs } = workflow();
  const reference = jobs['clued-cloud-tests'];
  for (const id of SCANS) {
    const job = jobs[id];
    assert.ok(job, `job ${id}`);
    assert.equal(job.needs, 'admission-gate', id);
    assert.equal(job.if, reference.if, `${id} runs under the test jobs' condition`);
    assert.equal(job.name, reference.name.replace(/'clued-cloud-tests(-skipped)?'/g, `'${id}$1'`), id);
    assert.equal(job.concurrency, undefined, `${id} has no concurrency group of its own`);
    assert.deepEqual(job['runs-on'], id === 'contract-placement' ? POOL : [...POOL, 'cap-docker-linux'], id);
    assert.ok(job['timeout-minutes'] <= 25, id);
  }
  for (const [id, job] of Object.entries(jobs)) {
    const needs = [job.needs ?? []].flat();
    assert.ok(!needs.some((n) => SCANS.includes(n)), `${id} does not wait for a scan`);
    if (TESTS.includes(id)) assert.deepEqual(needs, ['admission-gate'], id);
  }
});

test('the gitleaks job runs the trusted range script over the change, from a fresh copy of its history', () => {
  const { jobs } = workflow();
  const job = jobs.gitleaks;
  const checkout = step(job, 'Check out the candidate');
  assert.equal(checkout.with['fetch-depth'], 0);
  const trusted = job.steps.find((s) => s.with?.path === 'trusted');
  assert.equal(trusted.with.ref, jobs['clued-cloud-tests'].steps.find((s) => s.with?.path === 'trusted').with.ref);
  const scan = step(job, 'Scan the changed range with Gitleaks 8.30.1').run;
  assert.match(scan, /bash trusted\/scripts\/ci\/gitleaks-range\.sh "\$scan\/repo" "\$BASE" "\$HEAD" -- \\\n/);
  assert.match(scan, /--network=none/);
  assert.match(scan, /--pull=never/);
  assert.match(scan, /ghcr\.io\/gitleaks\/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f/);
  assert.doesNotMatch(scan, /--log-opts|--gitleaks-ignore-path/, 'the script appends the log options; no ignore file');
  // contract-placement no longer shares this range: it compares the candidate with CI_BASE_SHA (scripts/ci/ci-base.mjs),
  // the merge's own first parent; the range's pull_request base is the head's old merge base (task 6cd46765, #1292).
  assert.equal(jobs['contract-placement'].steps.some((s) => s.id === 'range'), false);
  assert.match(step(jobs['contract-placement'], 'Enforce placement and one-time production gate').run, /--base "\$CI_BASE_SHA" --head "\$CANDIDATE"/);
});

// The job's own steps (range, copy, scan) run against a pull request whose conflict resolution adds a secret, with a
// stand-in docker that runs the stub on the mounted copy.
// MSYS_NO_PATHCONV: Git for Windows' bash would rewrite the container path /repo into a Windows path for the stand-in.
function bashStep(script, { cwd, env }) {
  const r = spawnSync(BASH, ['-e', '-c', script], { cwd, encoding: 'utf8', env: { ...ENV, MSYS_NO_PATHCONV: '1', ...env }, timeout: 240000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function pullRequestWorkspace(resolution) {
  const c = conflictMerge(resolution);
  const ws = path.join(TMP, `ws${serial++}`);
  const temp = path.join(ws, '_temp');
  mkdirSync(path.join(ws, 'trusted', 'scripts', 'ci'), { recursive: true });
  mkdirSync(temp);
  git(TMP, 'clone', '-q', '--no-local', c.dir, path.join(ws, 'candidate'));
  const candidate = path.join(ws, 'candidate');
  // GitHub's merge of the head into the base: the run's commit, with the head as its second parent.
  git(candidate, 'checkout', '-q', '--detach', c.base);
  git(candidate, 'merge', '-q', '--no-ff', '--no-edit', c.head);
  const sha = git(candidate, 'rev-parse', 'HEAD');
  copyFileSync(path.join(ROOT, '.gitleaks.toml'), path.join(ws, 'trusted', '.gitleaks.toml'));
  copyFileSync(SCRIPT, path.join(ws, 'trusted', 'scripts', 'ci', 'gitleaks-range.sh'));
  const bin = path.join(TMP, `bin${serial++}`);
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'fake-docker.mjs'), `import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2);
if (a[0] === 'image' || a[0] === 'pull') process.exit(0);
if (a[0] !== 'run') process.exit(9);
for (const f of ['--network=none', '--read-only', '--pull=never', '--cap-drop=ALL']) if (!a.includes(f)) { console.error('fake docker: missing ' + f); process.exit(9); }
const mount = a.find((x) => /dst=\\/repo,/.test(x)) || '';
const src = /src=([^,]+)/.exec(mount)[1];
const image = a.indexOf('/usr/bin/gitleaks') + 1;
const args = a.slice(image + 1).map((x) => x === '/repo' ? src : x);
const r = spawnSync(process.execPath, [${JSON.stringify(fwd(STUB))}, ...args], { stdio: 'inherit' });
process.exit(r.status);
`);
  const docker = path.join(bin, 'docker');
  writeFileSync(docker, `#!/usr/bin/env bash\nexec "${NODE}" "${fwd(path.join(bin, 'fake-docker.mjs'))}" "$@"\n`);
  chmodSync(docker, 0o755);
  const output = path.join(temp, 'output');
  writeFileSync(output, '');
  const env = { GITHUB_WORKSPACE: fwd(ws), RUNNER_TEMP: fwd(temp), GITHUB_SHA: sha, GITHUB_OUTPUT: fwd(output), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  return { c, ws, candidate, env, output };
}
function runJob(resolution) {
  const job = workflow().jobs.gitleaks;
  const w = pullRequestWorkspace(resolution);
  const rangeStep = step(job, 'Resolve the changed range');
  assert.deepEqual(Object.keys(rangeStep.env).sort(), ['EVENT_NAME', 'PR_BASE', 'PR_HEAD', 'PUSH_BASE']);
  let r = bashStep(rangeStep.run, { cwd: w.candidate, env: { ...w.env, EVENT_NAME: 'pull_request', PR_BASE: w.c.base, PR_HEAD: w.c.head, PUSH_BASE: '' } });
  assert.equal(r.code, 0, r.out);
  const out = Object.fromEntries(readFileSync(w.output, 'utf8').trim().split('\n').map((l) => l.split('=')));
  assert.deepEqual(out, { base: w.c.base, head: w.c.head });
  const range = { BASE: out.base, HEAD: out.head };
  r = bashStep(step(job, 'Copy the changed history into a fresh Git directory').run, { cwd: w.ws, env: { ...w.env, ...range } });
  assert.equal(r.code, 0, r.out);
  return bashStep(step(job, 'Scan the changed range with Gitleaks 8.30.1').run, { cwd: w.ws, env: { ...w.env, ...range } });
}

test('the gitleaks job blocks a pull request whose merge resolves a conflict with a secret', { skip: noBash }, () => {
  const r = runJob(LIT);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /gitleaks exited 1/);
});

test('the gitleaks job passes a pull request whose merge resolves the conflict cleanly', { skip: noBash }, () => {
  const r = runJob('const k = 4;\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /scanned, no finding/);
});
