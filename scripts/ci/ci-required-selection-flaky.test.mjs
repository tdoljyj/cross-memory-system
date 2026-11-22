// A test that fails once and passes when its file runs alone again is let through in the job (Task 11092b8b;
// FABLE-flaky-no-new-commit-20261122 §2): executeSuite runs the failing tests' files alone twice and passes the command only
// when both runs pass every one of them, with a flaky warning per test; anything else stays red. These run the real
// `node --test` in a throwaway git checkout (a base commit, the suite's test directory); a counter file beside each test file
// says which run it is (the suite environment drops variables, so the count cannot come from one).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeSuite } from './ci-required-selection.mjs';
import { failureFingerprint } from './ci-test-failures-reporter.mjs';

const SUITE = 'source-v2-node';
const DIR = 'work/actions-hosted-migration/independent-ci-v1/test';
const ADMISSION_FILES = ['scripts/ci/clued-work-admission.test.mjs', 'scripts/ci/merge-admission-policy.test.mjs',
  'scripts/ci/merge-admission-policy-file.test.mjs', 'scripts/ci/clued-release-grant.test.mjs', 'scripts/ci/clued-release-door.test.mjs',
  'scripts/runner/clued-runner-job-started.test.mjs', 'scripts/runner/clued-runner-hook-loader.test.mjs', 'scripts/runner/install-hook-loader.test.mjs',
  'scripts/ci/clued-merge-slot-ci.test.mjs', 'scripts/ci/clued-front-main-merge.test.mjs'];

const git = (root, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Clued Test', '-c', 'user.email=clued-test@example.invalid', '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

// A test file whose tests named in `fails` throw on the runs listed for each (1 is the suite's own run).
const COUNTER = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const counter = new URL(import.meta.url.replace(/\\.test\\.mjs$/, '.count'));
const run = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(run));
`;
function testFile(tests, { header = '' } = {}) {
  return `import test from 'node:test';\n${COUNTER}${header}${Object.entries(tests).map(([name, spec]) => {
    if (typeof spec === 'string') return spec;
    const runs = spec === true ? 'true' : `${JSON.stringify(spec)}.includes(run)`;
    return `test(${JSON.stringify(name)}, () => { if (${runs}) throw new Error(${JSON.stringify(`${name} failed`)}); });\n`;
  }).join('')}`;
}

// A git checkout with the files committed as the base; `changed` is committed on top (HEAD).
function checkout(t, files, { changed = {} } = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-flaky-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (entries) => {
    for (const [file, text] of Object.entries(entries)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
  };
  git(root, 'init', '-q');
  write(files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  if (Object.keys(changed).length > 0) {
    write(changed);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'change');
  }
  // The counters are made by the runs, after the commits.
  writeFileSync(path.join(root, '.git', 'info', 'exclude'), '*.count\n');
  return { root, base, runsOf: (file) => {
    const counter = path.join(root, file.replace(/\.test\.mjs$/, '.count'));
    return existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  } };
}

function run(root, base, options = {}) {
  const lines = [];
  const calls = [];
  const env = { ...process.env, RUNNER_TEMP: root, ...(base === undefined ? {} : { CI_BASE_SHA: base }) };
  delete env.NODE_TEST_CONTEXT;
  delete env.GITHUB_STEP_SUMMARY;
  if (base === undefined) delete env.CI_BASE_SHA;
  const spawn = (command, args, opts) => { calls.push(args); return spawnSync(command, args, opts); };
  const status = executeSuite(options.suite ?? SUITE, { root, env, spawn, log: (line) => lines.push(String(line)), ...options });
  return { status, lines, calls, out: lines.join('\n') };
}

const FLAKY = `${DIR}/flaky.test.mjs`;
const STEADY = `${DIR}/steady.test.mjs`;
const suite = (flaky, steady = { 'steady one': [] }) => ({ [FLAKY]: testFile(flaky), [STEADY]: testFile(steady) });

test('A: a test that fails once and passes when the command runs again in full passes the command, with a flaky warning', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ 'flaky one': [1], 'flaky two': [] }));
  const { status, lines, calls, out } = run(root, base);
  assert.equal(status, 0, out);
  assert.equal(calls.length, 2, 'the suite run and one run of the same command');
  assert.ok(calls[1].some((arg) => arg.endsWith('flaky.test.mjs')) && calls[1].some((arg) => arg.endsWith('steady.test.mjs')), calls[1].join(' '));
  assert.equal(runsOf(FLAKY), 2);
  assert.equal(runsOf(STEADY), 2, 'the other file runs again too');
  const warnings = lines.filter((line) => line.startsWith(`::warning title=${SUITE} flaky::`));
  assert.equal(warnings.length, 1, out);
  assert.match(warnings[0], new RegExp(`::${FLAKY.replaceAll('.', '\\.')} :: flaky one fingerprint=[0-9a-f]{16}$`));
});

test('B: a test that fails every time stays red; the second run alone is not started after the first fails', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ 'always': true }));
  const { status, calls, out } = run(root, base);
  assert.equal(status, 1, out);
  assert.equal(calls.length, 2, out);
  assert.equal(runsOf(FLAKY), 2);
  assert.match(out, /单独再跑仍失败/);
  assert.doesNotMatch(out, /flaky::/);
});

test('C: a failing test file the change edited is not run again', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ 'flaky one': [] }), { changed: { [FLAKY]: testFile({ 'flaky one': [1], 'new one': [] }) } });
  const { status, calls, out } = run(root, base);
  assert.equal(status, 1, out);
  assert.equal(calls.length, 1, out);
  assert.match(out, /not run alone again: .*flaky\.test\.mjs differs from the base commit/);
  assert.equal(runsOf(FLAKY), 1);
});

test('D: four failing tests are not run again', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ f1: [1], f2: [1], f3: [1], f4: [1] }));
  const { status, calls, out } = run(root, base);
  assert.equal(status, 1, out);
  assert.equal(calls.length, 1, out);
  assert.match(out, /not run alone again: 4 failing tests/);
  assert.equal(runsOf(FLAKY), 1);
});

test('E: when the run again passes the failed test but another test of the same command fails, the command stays red', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ 'flaky one': [1] }, { 'steady one': [2] }));
  const { status, calls, out } = run(root, base);
  assert.equal(status, 1, out);
  assert.equal(calls.length, 2, out);
  assert.equal(runsOf(FLAKY), 2);
  assert.equal(runsOf(STEADY), 2);
  assert.doesNotMatch(out, /flaky::/);
});

test('F: a runner that is killed (no summary in the report) is not run again', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ 'kills the runner':
    "test('kills the runner', () => { if (run === 1) process.kill(process.ppid, 'SIGKILL'); });\n" }));
  const { status, calls, out } = run(root, base);
  assert.notEqual(status, 0, out);
  assert.equal(calls.length, 1, out);
  assert.match(out, /not run alone again: (the test runner exited|the test report has no summary)/);
  assert.equal(runsOf(FLAKY), 1);
});

test('G: without CI_BASE_SHA, or with a base git cannot read, nothing is run again', (t) => {
  for (const base of [undefined, 'f'.repeat(40)]) {
    const { root, runsOf } = checkout(t, suite({ 'flaky one': [1] }));
    const { status, calls, out } = run(root, base);
    assert.equal(status, 1, `${base}: ${out}`);
    assert.equal(calls.length, 1, `${base}: ${out}`);
    assert.match(out, base ? /not run alone again: .* is not in the base commit/ : /not run alone again: CI_BASE_SHA is not a commit/);
    assert.equal(runsOf(FLAKY), 1);
  }
});

test('H: an error while planning the run alone leaves the command red and is not thrown', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ 'flaky one': [1] }));
  let result;
  assert.doesNotThrow(() => { result = run(root, base, { planRerun: () => { throw new Error('planning broke'); } }); });
  assert.equal(result.status, 1, result.out);
  assert.equal(result.calls.length, 1, result.out);
  assert.match(result.out, /not run alone again: planning broke/);
  assert.equal(runsOf(FLAKY), 1);
});

test('I: a run alone in which the failed test is skipped does not count as a pass', (t) => {
  const { root, base } = checkout(t, suite({ 'skipped later':
    "test('skipped later', { skip: run > 1 }, () => { throw new Error('first run fails'); });\ntest('other', () => {});\n" }));
  const { status, calls, out } = run(root, base);
  assert.equal(status, 1, out);
  assert.equal(calls.length, 2, 'it ran alone once and stopped');
  assert.match(out, /单独再跑仍失败\): .*skipped later did not pass/);
  assert.doesNotMatch(out, /flaky::/);
});

test('J: with a known-failure list, a failure off the list that passes alone passes; a listed one still only warns', (t) => {
  const [first, ...rest] = ADMISSION_FILES;
  const files = Object.fromEntries(rest.map((file) => [file, "import test from 'node:test';\ntest('fine', () => {});\n"]));
  files[first] = testFile({ 'known broken': true, 'flaky one': [1] });
  // The checkout has scripts/ci: a selector that adds nothing to the suite.
  files['scripts/ci/ci-required-selection.mjs'] = 'export const SUITE_COMMANDS = {};\n';
  const { root, base, runsOf } = checkout(t, files);
  const fingerprint = failureFingerprint({ failureType: 'testCodeFailure', cause: new Error('known broken failed') });
  const known = { 'admission-self-tests': [{ file: first, path: ['known broken'], fingerprint, reason: 'listed' }] };
  const { status, lines, calls, out } = run(root, base, { suite: 'admission-self-tests', known });
  assert.equal(status, 0, out);
  assert.equal(calls.length, 3, out);
  assert.equal(runsOf(first), 3);
  assert.ok(lines.some((line) => line === `::warning title=admission-self-tests known failure::${first} :: known broken`), out);
  assert.ok(lines.some((line) => line.startsWith(`::warning title=admission-self-tests flaky::${first} :: flaky one fingerprint=`)), out);
});

test('K: under --run-files a failure is returned as it is and nothing is run again', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ 'flaky one': [1] }));
  const { status, calls, out } = run(root, base, { files: [FLAKY] });
  assert.equal(status, 1, out);
  assert.equal(calls.length, 1, out);
  assert.doesNotMatch(out, /run alone again/);
  assert.equal(runsOf(FLAKY), 1);
});

// L (FABLE-flaky-fingerprint-20261122 §7.1): a failure another file of the same run makes every time, which the file alone
// never shows. The first file marks; the second fails when it sees the mark (it waits for it, so the order of the two in the
// run does not matter) and removes it. Alone it waits in vain and passes.
const MARKS = `${DIR}/a-marks.test.mjs`;
const SEES_MARK = `${DIR}/b-sees-mark.test.mjs`;
test('L: a test another file of the same command makes fail every time stays red, though it passes alone', (t) => {
  const { root, base } = checkout(t, {
    [MARKS]: `import test from 'node:test';
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./l.mark', import.meta.url), 'a');
test('marks', () => {});
`,
    [SEES_MARK]: `import test from 'node:test';
import { existsSync, rmSync } from 'node:fs';
const mark = new URL('./l.mark', import.meta.url);
test('sees no mark', async () => {
  const until = Date.now() + 20_000;
  while (!existsSync(mark) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  if (existsSync(mark)) {
    rmSync(mark);
    throw new Error('another file of the run marked it');
  }
});
`,
  });
  const { status, calls, out } = run(root, base);
  assert.equal(status, 1, out);
  assert.equal(calls.length, 2, out);
  assert.match(out, /整条再跑仍失败/);
  assert.doesNotMatch(out, /flaky::/);
});

test('M: a command whose run took longer than the limit is not run again', (t) => {
  const { root, base, runsOf } = checkout(t, suite({ 'flaky one': [1] }));
  const { status, calls, out } = run(root, base, { rerunMaxElapsedMs: 0 });
  assert.equal(status, 1, out);
  assert.equal(calls.length, 1, out);
  assert.match(out, /not run again in full: the run took \d+ ms \(more than 0 ms\)/);
  assert.equal(runsOf(FLAKY), 1);
});

test('N: what the first run left in its temporary directory does not make the run again pass', (t) => {
  const left = `ci-flaky-n-${randomUUID()}`;
  t.after(() => rmSync(path.join(os.tmpdir(), left), { force: true }));
  const { root, base, runsOf } = checkout(t, suite({ 'needs what the first run left': `import os from 'node:os';
import path from 'node:path';
import { writeFileSync as write } from 'node:fs';
test('needs what the first run left', () => {
  const file = path.join(os.tmpdir(), ${JSON.stringify(left)});
  if (run === 1) {
    write(file, '');
    throw new Error('the first run fails');
  }
  if (!existsSync(file)) throw new Error('nothing left behind');
});
` }));
  const { status, calls, out } = run(root, base);
  assert.equal(status, 1, out);
  assert.equal(calls.length, 2, out);
  assert.equal(runsOf(FLAKY), 2);
  assert.match(out, /整条再跑仍失败/);
  assert.doesNotMatch(out, /flaky::/);
});
