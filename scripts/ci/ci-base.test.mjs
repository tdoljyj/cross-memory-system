// CI_BASE_SHA has one rule (scripts/ci/ci-base.mjs) and every required job gets it the same way (task 6cd46765; design
// FABLE-mainpush-same-tree-20261123 §B, FABLE-dispatch-base-20261122 §2.2; #1292 run 45366103042).
//
// The end-to-end cases run each job's own train-base step, as written in the workflow and in its own shell, in a real Git
// checkout, then read CI_BASE_SHA the way the job's suite step does (its own env expression, else what earlier steps wrote
// to GITHUB_ENV), and hand it to the consumer that refused #1292: merge-admission-r9-reregister.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCiBase, writeCiBase } from './ci-base.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = ['clued-required-tests.yml', 'clued-required-tests-windows.yml', 'hosted-required.yml'];
const workflowText = (file) => readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8').replaceAll('\r\n', '\n');

// ---- reading the workflows as text (no YAML dependency: this runs before any install) ----
function jobsOf(text) {
  const start = text.indexOf('\njobs:\n');
  const out = new Map();
  const body = text.slice(start + '\njobs:\n'.length);
  const re = /^ {2}([a-z][a-z0-9-]*):\n/gm;
  const heads = [...body.matchAll(re)];
  heads.forEach((m, i) => out.set(m[1], body.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : body.length)));
  return out;
}
function stepsOf(job) {
  const at = job.indexOf('\n    steps:\n');
  if (at < 0) return [];
  const lines = job.slice(at + '\n    steps:\n'.length).split('\n');
  const steps = [];
  for (const line of lines) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length && (line.startsWith(' '.repeat(8)) || line === '')) steps.at(-1).push(line);
    else if (steps.length && /^ {6}#/.test(line)) continue;
    else if (line && !line.startsWith(' '.repeat(6))) break;
  }
  return steps.map((block) => {
    const text = block.join('\n');
    const field = (key) => new RegExp(`^ {6}(?:- | {2})${key}: (.+)$`, 'm').exec(text)?.[1] ?? null;
    const env = {};
    const envAt = block.findIndex((l) => l === '        env:');
    if (envAt >= 0) for (const l of block.slice(envAt + 1)) { const m = /^ {10}([A-Z_][A-Z0-9_]*): (.*)$/.exec(l); if (!m) { if (/^ {10}#/.test(l)) continue; break; } env[m[1]] = m[2]; }
    let run = null;
    const runAt = block.findIndex((l) => /^ {6}(?:- | {2})run: /.test(l));
    if (runAt >= 0) {
      const first = block[runAt].replace(/^ {6}(?:- | {2})run: /, '');
      if (first === '|') {
        const body = [];
        for (const l of block.slice(runAt + 1)) { if (l.trim() && !l.startsWith(' '.repeat(10))) break; body.push(l.slice(10)); }
        run = body.join('\n').trimEnd() + '\n';
      } else run = first;
    }
    return { text, name: field('name'), id: field('id'), shell: field('shell'), uses: field('uses'), env, run };
  });
}
const onEvents = (text) => {
  const on = /\non:\n((?: {2}.*\n|\n)*)/.exec(text)?.[1] ?? '';
  return [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
};
const SUITE_STEP = /ci-required-selection\.mjs"? --run(?:-selected)? |"\$SELECTOR" --run /;
// Every job, in the three workflows, with a step that runs suites through the selector: CI_BASE_SHA's consumers.
function consumerJobs() {
  const out = [];
  for (const file of WORKFLOWS) {
    const text = workflowText(file);
    for (const [id, job] of jobsOf(text)) {
      const steps = stepsOf(job);
      const consumers = steps.filter((s) => s.run && SUITE_STEP.test(s.run));
      if (consumers.length) out.push({ file, id, steps, consumers, events: onEvents(text) });
    }
  }
  return out;
}

// ---- GitHub's expression subset these steps use: ${{ a || b.c || 'x' }} over a context ----
function evaluate(value, context) {
  const one = (expression) => {
    for (const operand of expression.split('||').map((o) => o.trim())) {
      if (/^'.*'$/.test(operand)) return operand.slice(1, -1);
      assert.match(operand, /^[a-z_]+(\.[a-zA-Z0-9_-]+)+$/, `expression operand not understood: ${value}`);
      const v = operand.split('.').reduce((at, key) => (at == null ? null : at[key] ?? null), context);
      if (v) return String(v);
    }
    return '';
  };
  return value.trim().replace(/^"(.*)"$/, '$1').replace(/\$\{\{ (.+?) \}\}/g,(_, expression) => one(expression));
}

// ---- running a step in its own shell ----
function shellCommand(shell) {
  if (shell === 'powershell') return process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']] : null;
  if (process.platform !== 'win32') return ['bash', []];
  // Never the bash on PATH under Windows (it may be WSL's): Git for Windows' own bash, or none.
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const bash = exec && path.resolve(exec, '..', '..', '..', 'bin', 'bash.exe');
  return bash && existsSync(bash) ? [bash, []] : null;
}
const readKv = (file) => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
function runStep(step, { cwd, github, temp }) {
  const command = shellCommand(step.shell ?? 'bash');
  const tag = Math.random().toString(16).slice(2);
  const files = { output: path.join(temp, `out-${tag}`), env: path.join(temp, `env-${tag}`), event: path.join(temp, `event-${tag}.json`),
    script: path.join(temp, `step-${tag}.${step.shell === 'powershell' ? 'ps1' : 'sh'}`) };
  writeFileSync(files.output, ''); writeFileSync(files.env, ''); writeFileSync(files.event, JSON.stringify(github.event));
  writeFileSync(files.script, step.run);
  const context = { github, runner: { temp } };
  const stepEnv = Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, evaluate(v, context)]));
  const r = spawnSync(command[0], [...command[1], files.script], { cwd, encoding: 'utf8', env: { ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    GITHUB_EVENT_NAME: github.event_name, GITHUB_SHA: github.sha, GITHUB_REF: github.ref, GITHUB_EVENT_PATH: files.event,
    GITHUB_OUTPUT: files.output, GITHUB_ENV: files.env, CI_BASE_SHA: '', ...stepEnv } });
  return { status: r.status, outputs: readKv(files.output), env: readKv(files.env), log: `${r.stdout}${r.stderr}` };
}
// The CI_BASE_SHA a job's suite step runs with: every step before it that writes GITHUB_ENV (the train-base step), then the
// suite step's own env (GitHub gives a step's env precedence over GITHUB_ENV).
function baseSeenBy(job, { cwd, github, temp }) {
  const trainBase = job.steps.find((s) => s.id === 'train-base');
  assert.ok(trainBase, `${job.file} ${job.id}: no train-base step`);
  const ran = runStep(trainBase, { cwd, github, temp });
  assert.equal(ran.status, 0, `${job.file} ${job.id} train-base: ${ran.log}`);
  const context = { github, steps: { 'train-base': { outputs: ran.outputs } }, env: ran.env };
  return job.consumers.map((step) => (Object.hasOwn(step.env, 'CI_BASE_SHA') ? evaluate(step.env.CI_BASE_SHA, context) : ran.env.CI_BASE_SHA ?? ''));
}

// ---- a checkout of this repository's own HEAD with GitHub's #1292 shape around it ----
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=', ...args],
    { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const repoShallow = () => git(ROOT, 'rev-parse', '--is-shallow-repository') === 'true';
// A = this checkout's HEAD (a main commit as far as the change is concerned); the branch H forks at A; main moves on to B;
// GitHub's candidate M = merge(B, H), first parent B. The event still says base.sha = A, as #1292's did (43e2c3baa while the
// candidate b4752987d held b404f735a). Same tree everywhere: only the history differs, so every registry stays valid.
function prShape(t, { checkout = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clued-ci-base-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'candidate'), temp = path.join(dir, 'temp');
  mkdirSync(repo); mkdirSync(temp);
  git(repo, 'init', '-q');
  const objects = path.resolve(ROOT, git(ROOT, 'rev-parse', '--git-common-dir'), 'objects');
  appendFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), `${objects}\n`);
  const A = git(ROOT, 'rev-parse', 'HEAD'), tree = git(ROOT, 'rev-parse', 'HEAD^{tree}');
  const H = git(repo, 'commit-tree', tree, '-p', A, '-m', 'the pull request head');
  const B = git(repo, 'commit-tree', tree, '-p', A, '-m', 'main moved on (#1258)');
  const M = git(repo, 'commit-tree', tree, '-p', B, '-p', H, '-m', `Merge ${H} into ${B}`);
  git(repo, 'update-ref', 'refs/remotes/origin/main', B);
  git(repo, 'update-ref', 'refs/remotes/pull/1292/merge', M);
  if (checkout) git(repo, 'checkout', '-q', '--detach', M); else git(repo, 'update-ref', '--no-deref', 'HEAD', M);
  const pr = { event_name: 'pull_request', sha: M, ref: 'refs/pull/1292/merge',
    event: { number: 1292, pull_request: { number: 1292, base: { ref: 'main', sha: A }, head: { ref: 'claude/r1', sha: H } } } };
  return { repo, temp, A, H, B, M, pr };
}

// ---- 1. #1292: a pull request whose head merged main before main moved on ----
test('#1292 shape: every job that runs suites gets the candidate\'s own main parent, and r9 no longer refuses it', { skip: repoShallow() && 'shallow checkout' }, async (t) => {
  const shape = prShape(t, { checkout: true });
  const reregister = await import(pathToFileURL(path.join(ROOT, 'scripts', 'ci', 'merge-admission-r9-reregister.mjs')).href);
  const seen = new Map();
  for (const job of consumerJobs()) {
    const trainBase = job.steps.find((s) => s.id === 'train-base');
    if (!shellCommand(trainBase?.shell ?? 'bash')) { t.diagnostic(`${job.file} ${job.id}: no ${trainBase.shell} here`); continue; }
    for (const base of baseSeenBy(job, { cwd: shape.repo, github: shape.pr, temp: shape.temp })) seen.set(`${job.file} ${job.id}`, base);
  }
  assert.ok(seen.size >= 7, [...seen.keys()].join(', '));
  // Every job's outcome first, then one assertion: the failure lists them all (before the fix: ci-suites refused with
  // #1292's own R9_REREGISTER_BASE_BEHIND at base.sha, the jobs without a CI_BASE_SHA expression with no base at all).
  const problems = [];
  for (const [where, base] of seen) {
    let p = null;
    try { p = reregister.plan(shape.repo, { base }); } catch (e) { problems.push(`${where}: CI_BASE_SHA='${base}': ${e.message.split('\n')[0]}`); continue; }
    if (base !== shape.B) problems.push(`${where}: CI_BASE_SHA='${base}', not the merge's first parent ${shape.B}`);
    else if (!p.upToDate) problems.push(`${where}: r9 is stale on this candidate (pinned-registries says how to regenerate it)`);
  }
  assert.deepEqual(problems, []);
  // The refusal itself, for the record: the event's base.sha is what #1292's run used.
  assert.throws(() => reregister.plan(shape.repo, { base: shape.A }), /R9_REREGISTER_BASE_BEHIND/);
});

// ---- 2. task 6cd46765's old case: a lost-run dispatch handed some suite steps no CI_BASE_SHA ----
test('lost-run dispatch: every suite step of a workflow that can be dispatched gets git merge-base origin/main <head>', { skip: repoShallow() && 'shallow checkout' }, (t) => {
  const shape = prShape(t);
  // The head is the branch itself, behind main (B): its base is its fork point A, never main's newest commit.
  const github = { event_name: 'workflow_dispatch', sha: shape.H, ref: 'refs/heads/claude/r1', event: { inputs: { pr: '1292', head: shape.H } } };
  let checked = 0;
  const problems = [];
  for (const job of consumerJobs().filter((j) => j.events.includes('workflow_dispatch'))) {
    const trainBase = job.steps.find((s) => s.id === 'train-base');
    if (!shellCommand(trainBase?.shell ?? 'bash')) continue;
    for (const base of baseSeenBy(job, { cwd: shape.repo, github, temp: shape.temp })) {
      if (base !== shape.A) problems.push(`${job.file} ${job.id}: CI_BASE_SHA under dispatch is '${base}'`);
      checked++;
    }
  }
  assert.ok(checked >= 3, `dispatchable suite steps checked: ${checked}`);
  assert.deepEqual(problems, []);
});

// ---- 3. one rule, one entry: the workflows ----
const LOADER_SOURCE = "git('show', 'origin/main:scripts/ci/ci-base.mjs')";
test('every job that resolves a base does it with the one ci-base.mjs step, before the trusted checkout; no step sets CI_BASE_SHA', () => {
  const bodies = new Set();
  let jobs = 0;
  for (const file of WORKFLOWS) {
    const text = workflowText(file);
    assert.doesNotMatch(text, /^\s+CI_BASE_SHA:/m, `${file}: a step sets CI_BASE_SHA itself`);
    assert.doesNotMatch(text, /git rev-parse "\$\(?\$?\{?(?:env:)?STAGING_SHA\)?\}?\^1"|stagingBaseFromCheckout\(process\.env/, `${file}: an inline base rule`);
    for (const [id, job] of jobsOf(text)) {
      const steps = stepsOf(job);
      const at = steps.findIndex((s) => s.id === 'train-base');
      if (at < 0) continue;
      jobs++;
      const step = steps[at];
      assert.ok(step.run.includes(LOADER_SOURCE), `${file} ${id}: train-base does not load ci-base.mjs from main`);
      // The same node command in bash and PowerShell; only the shell's own first and last lines differ.
      bodies.add(step.run.replace(/^(set -euo pipefail|\$ErrorActionPreference = 'Stop')\n/, '').replace(/exit \$LASTEXITCODE\n$/, ''));
      assert.deepEqual(Object.keys(step.env).filter((k) => !['TMPDIR', 'TMP', 'TEMP', 'PYTHONPYCACHEPREFIX', 'WRANGLER_LOG_PATH'].includes(k)), [],
        `${file} ${id}: train-base reads GitHub's own variables, nothing passed in`);
      const trusted = steps.findIndex((s) => /^ {10}path: trusted$/m.test(s.text));
      if (trusted >= 0) assert.ok(at < trusted, `${file} ${id}: train-base runs before the trusted checkout`);
      for (const s of steps) if (/--base "\$[A-Z_]+"/.test(s.run ?? '') && /check_contract_placement/.test(s.run)) {
        assert.match(s.run, /--base "\$CI_BASE_SHA"/, `${file} ${id}: contract placement compares with CI_BASE_SHA`);
      }
    }
  }
  assert.equal(jobs, 13, 'six Linux, one Windows, six hosted');
  assert.equal(bodies.size, 1, `one loader text:\n${[...bodies].join('\n---\n')}`);
  for (const { file, id, steps } of consumerJobs()) assert.ok(steps.some((s) => s.id === 'train-base'), `${file} ${id} runs suites without train-base`);
});

// ---- 4. the rule, event by event ----
function ruleRepo(t, { withHook = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clued-ci-base-rule-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'work');
  if (withHook) {
    mkdirSync(path.join(dir, 'scripts', 'runner'), { recursive: true });
    copyFileSync(path.join(ROOT, 'scripts', 'runner', 'clued-runner-job-started.mjs'), path.join(dir, 'scripts', 'runner', 'clued-runner-job-started.mjs'));
  }
  writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'T');
  const T = git(dir, 'rev-parse', 'HEAD'), tree = git(dir, 'rev-parse', 'HEAD^{tree}');
  let n = 0;
  const commit = (...parents) => git(dir, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', `c${++n}`);
  git(dir, 'update-ref', 'refs/remotes/origin/main', T);
  return { dir, T, commit };
}
const resolve = (r, eventName, ref, sha, event = {}) => resolveCiBase({ eventName, ref, sha, event, cwd: r.dir });

test('pull_request: the first parent of GitHub\'s merge, whatever the event\'s base.sha says', async (t) => {
  const r = ruleRepo(t, { withHook: false });
  const H = r.commit(r.T), B = r.commit(r.T), M = r.commit(B, H);
  const event = { pull_request: { base: { sha: r.T }, head: { sha: H } } };
  assert.deepEqual(await resolve(r, 'pull_request', 'refs/pull/9/merge', M, event), { ci_base: B });
  // Not GitHub's merge of that head: refused, never a guess.
  await assert.rejects(resolve(r, 'pull_request', 'refs/pull/9/merge', M, { pull_request: { head: { sha: B } } }), /not GitHub's merge/);
  await assert.rejects(resolve(r, 'pull_request', 'refs/pull/9/merge', H, event), /not GitHub's merge/);
  await assert.rejects(resolve(r, 'pull_request', 'refs/pull/9/merge', M, {}), /not GitHub's merge/);
});

test('push to main: the previous tip, which must be an ancestor (a merge commit\'s S^1, a train fast-forward\'s T)', async (t) => {
  const r = ruleRepo(t, { withHook: false });
  const H = r.commit(r.T), merge = r.commit(r.T, H);
  assert.deepEqual(await resolve(r, 'push', 'refs/heads/main', merge, { before: r.T }), { ci_base: r.T });
  const H2 = r.commit(r.T), S = r.commit(r.commit(r.T, H), H2); // a two-member S fast-forwarded onto main
  assert.deepEqual(await resolve(r, 'push', 'refs/heads/main', S, { before: r.T }), { ci_base: r.T });
  // none, the all-zero of a new branch, S itself, a commit off S's history, one this checkout does not have
  for (const before of [undefined, '0'.repeat(40), S, merge, r.commit(r.T), 'f'.repeat(40)]) {
    await assert.rejects(resolve(r, 'push', 'refs/heads/main', S, { before }), /push refs\/heads\/main/, String(before));
  }
});

test('push to staging: T, the root of the member chain, also the trusted ref', async (t) => {
  const r = ruleRepo(t);
  const H1 = r.commit(r.T), H2 = r.commit(r.T), one = r.commit(r.T, H1), two = r.commit(one, H2);
  assert.deepEqual(await resolve(r, 'push', 'refs/heads/clued-train/staging', two), { sha: r.T, ci_base: r.T });
  assert.deepEqual(await resolve(r, 'push', 'refs/heads/clued-train/staging', one), { sha: r.T, ci_base: r.T });
  await assert.rejects(resolve(r, 'push', 'refs/heads/clued-train/staging', r.commit(r.commit(), H1)), /staging/);
});

test('workflow_dispatch: git merge-base origin/main <head>, never main\'s newest commit', async (t) => {
  const r = ruleRepo(t, { withHook: false });
  const H = r.commit(r.T), M2 = r.commit(r.T);
  git(r.dir, 'update-ref', 'refs/remotes/origin/main', M2);
  assert.deepEqual(await resolve(r, 'workflow_dispatch', 'refs/heads/b', H), { ci_base: r.T });
  assert.deepEqual(await resolve(r, 'workflow_dispatch', 'refs/heads/b', r.commit(H, M2)), { ci_base: M2 });
  await assert.rejects(resolve(r, 'workflow_dispatch', 'refs/heads/b', r.commit(r.commit())), /no history in common/);
});

test('an event nobody gave a base fails instead of handing the suites an empty CI_BASE_SHA', async (t) => {
  const r = ruleRepo(t, { withHook: false });
  for (const [eventName, ref] of [['schedule', 'refs/heads/main'], ['merge_group', 'refs/heads/gh-readonly-queue/main/x'],
    ['repository_dispatch', 'refs/heads/main'], ['', 'refs/heads/main'], ['push', 'refs/heads/claude/x'], ['push', 'refs/tags/v1']]) {
    await assert.rejects(resolve(r, eventName, ref, r.T, { before: r.T }), /No CI base is defined/, `${eventName} ${ref}`);
  }
  await assert.rejects(resolve(r, 'workflow_dispatch', 'refs/heads/b', 'HEAD'), /GITHUB_SHA is not a commit id/);
});

test('writeCiBase writes the outputs and CI_BASE_SHA, or fails the step with the reason', async (t) => {
  const r = ruleRepo(t);
  const H1 = r.commit(r.T), S = r.commit(r.T, H1);
  const output = path.join(r.dir, 'out'), envFile = path.join(r.dir, 'env');
  writeFileSync(output, ''); writeFileSync(envFile, '');
  const logs = [];
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/clued-train/staging', GITHUB_SHA: S, GITHUB_OUTPUT: output, GITHUB_ENV: envFile };
  assert.equal(await writeCiBase(env, { cwd: r.dir, log: (l) => logs.push(l) }), 0);
  assert.deepEqual(readKv(output), { sha: r.T, ci_base: r.T });
  assert.deepEqual(readKv(envFile), { CI_BASE_SHA: r.T });
  const saved = process.exitCode;
  try {
    assert.equal(await writeCiBase({ ...env, GITHUB_EVENT_NAME: 'schedule' }, { cwd: r.dir, log: (l) => logs.push(l) }), 1);
  } finally { process.exitCode = saved; }
  assert.match(logs.at(-1), /^::error title=CI base::No CI base is defined for the schedule event/);
  assert.deepEqual(readKv(envFile), { CI_BASE_SHA: r.T }, 'nothing written on failure');
});

// The change that adds ci-base.mjs runs before main has it: the step then uses the candidate's copy and says so. Once main
// has the file, main's copy is used and the candidate's is never read.
test('the step loads ci-base.mjs from origin/main; the candidate copy only while main has none', { skip: !shellCommand('bash') && 'no bash' }, (t) => {
  const r = ruleRepo(t, { withHook: false });
  const H = r.commit(r.T), B = r.commit(r.T), M = r.commit(B, H);
  const step = stepsOf(jobsOf(workflowText('clued-required-tests.yml')).get('ci-suites')).find((s) => s.id === 'train-base');
  const github = { event_name: 'pull_request', sha: M, ref: 'refs/pull/9/merge', event: { pull_request: { base: { sha: r.T }, head: { sha: H } } } };
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-ci-base-temp-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  git(r.dir, 'update-ref', 'refs/remotes/origin/main', B);
  // main without the file, the candidate working tree with a copy that marks itself
  mkdirSync(path.join(r.dir, 'scripts', 'ci'), { recursive: true });
  const marked = readFileSync(path.join(ROOT, 'scripts', 'ci', 'ci-base.mjs'), 'utf8').replace('log(`CI_BASE_SHA=', 'log(`candidate copy: CI_BASE_SHA=');
  writeFileSync(path.join(r.dir, 'scripts', 'ci', 'ci-base.mjs'), marked);
  const bootstrap = runStep(step, { cwd: r.dir, github, temp });
  assert.equal(bootstrap.status, 0, bootstrap.log);
  assert.match(bootstrap.log, /::warning title=CI base::main has no scripts\/ci\/ci-base\.mjs yet/);
  assert.match(bootstrap.log, /candidate copy: CI_BASE_SHA=/);
  assert.deepEqual(bootstrap.env, { CI_BASE_SHA: B });
  // main with the file: main's copy, not the candidate's
  const withFile = git(r.dir, 'hash-object', '-w', path.join(ROOT, 'scripts', 'ci', 'ci-base.mjs'));
  const ciTree = spawnSync('git', ['mktree'], { cwd: r.dir, encoding: 'utf8', input: `100644 blob ${withFile}\tci-base.mjs\n` }).stdout.trim();
  const scriptsTree = spawnSync('git', ['mktree'], { cwd: r.dir, encoding: 'utf8', input: `040000 tree ${ciTree}\tci\n` }).stdout.trim();
  const rootTree = spawnSync('git', ['mktree'], { cwd: r.dir, encoding: 'utf8', input: `040000 tree ${scriptsTree}\tscripts\n` }).stdout.trim();
  const B2 = git(r.dir, 'commit-tree', rootTree, '-p', B, '-m', 'main gets ci-base.mjs'), M2 = git(r.dir, 'commit-tree', rootTree, '-p', B2, '-p', H, '-m', 'merge');
  git(r.dir, 'update-ref', 'refs/remotes/origin/main', B2);
  const loaded = runStep(step, { cwd: r.dir, github: { ...github, sha: M2 }, temp });
  assert.equal(loaded.status, 0, loaded.log);
  assert.doesNotMatch(loaded.log, /candidate copy|::warning/);
  assert.deepEqual(loaded.env, { CI_BASE_SHA: B2 });
  // no origin/main at all: the step fails, it does not fall back
  git(r.dir, 'update-ref', '-d', 'refs/remotes/origin/main');
  const none = runStep(step, { cwd: r.dir, github, temp });
  assert.notEqual(none.status, 0, none.log);
  assert.deepEqual(none.env, {});
});
