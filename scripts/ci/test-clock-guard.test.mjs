// The real-clock guard and the debt list (Clued Task 11092b8b; FABLE-no-real-clock-20261122 §5, FABLE-defect-remediation-plan
// -20261124 §3.4). Each guard case writes a small checkout (a test file, maybe code under test and a debt list) and runs it
// with node --test and the guard preloaded the way the entry will (clockGuardEnv), as a real child process.
// This file is test code under the guard itself: it reads no clock and waits on no timer, and the fixture texts that name
// what the static scan refuses are split so the scan does not find them here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import {
  DEBT_FILE, GUARD_PATH, clockGuardEnv, debtVerdict, parseDebt, recordVerdict, scanSource, testFileKind,
} from './test-clock-scan.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD_URL = pathToFileURL(GUARD_PATH).href;
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function checkout(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clock-guard-'));
  made.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}
// node --test on one file of the checkout, the guard preloaded as the entry preloads it.
function runGuarded(root, file) {
  const record = path.join(root, 'clock-record.jsonl');
  const env = { ...process.env, ...clockGuardEnv({ root, record }) };
  delete env.NODE_TEST_CONTEXT; // the fixture's run is a run of its own, not a child of this one
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], { cwd: root, env, encoding: 'utf8' });
  const text = existsSync(record) ? readFileSync(record, 'utf8') : '';
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, record: recordVerdict(text, { suite: 'fixture' }) };
}
const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";

test('a new test that reads Date.now() fails through the guard, at its line, with the four ways out', () => {
  const root = checkout({ 'test/now.test.mjs': `${header}test('reads the clock', () => {\n  assert.ok(Date.now() > 0);\n});\n` });
  const run = runGuarded(root, 'test/now.test.mjs');
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /REAL_CLOCK_IN_TEST: Date\.now\(\) at test\/now\.test\.mjs:4/);
  assert.match(run.output, /a moment {6}-> a constant/);
  assert.match(run.output, /a real event {2}-> until\(probe/);
  assert.deepEqual(run.record.refused.map(({ api, file, line }) => ({ api, file, line })), [{ api: 'Date.now()', file: 'test/now.test.mjs', line: 4 }]);
  assert.match(run.record.lines.join('\n'), /^fixture: 1 real-clock use in test code\n {2}test\/now\.test\.mjs:4 Date\.now\(\)$/);
});

test('a test that gives spawnSync or execSync a timeout fails through the guard (§3.4)', () => {
  const root = checkout({ 'test/child-limit.test.mjs': `${header}import { spawnSync, execSync } from 'node:child_process';
test('spawnSync with a limit', () => {
  spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
});
test('execSync with a limit', () => {
  execSync('node -e 0', { timeout: 60000 });
});
test('spawnSync without a limit', () => {
  assert.equal(spawnSync(process.execPath, ['-e', '0']).status, 0);
});
` });
  const run = runGuarded(root, 'test/child-limit.test.mjs');
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /REAL_CLOCK_IN_TEST: spawnSync\(\{ timeout \}\) at test\/child-limit\.test\.mjs:5/);
  assert.deepEqual(run.record.refused.map((entry) => `${entry.api} ${entry.line}`), ['spawnSync({ timeout }) 5', 'execSync({ timeout }) 8']);
  assert.match(run.output, /pass 1/);
});

test('mock timers, code under test, node_modules and arguments to Date pass', () => {
  const root = checkout({
    'src/clocked.mjs': "export const stamp = () => [Date.now(), new Date().toISOString(), performance.now()];\nexport const later = () => new Promise((r) => setTimeout(r, 1));\n",
    'node_modules/lib/index.mjs': 'export const libNow = () => Date.now();\n',
    'test/clean.test.mjs': `${header}import { stamp, later } from '../src/clocked.mjs';
import { libNow } from '../node_modules/lib/index.mjs';
test('mocked time', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  assert.equal(Date.now(), 1000);
  let fired = false;
  setTimeout(() => { fired = true; }, 50);
  t.mock.timers.tick(50);
  assert.equal(fired, true);
  t.mock.timers.reset();
  assert.throws(() => Date.now(), { code: 'REAL_CLOCK_IN_TEST' });
});
test('code under test reads the clock and waits', async () => {
  assert.equal(stamp().length, 3);
  await later();
  assert.ok(libNow() > 0);
});
test('dates from a value', () => {
  assert.equal(new Date(5).getTime(), 5);
  assert.ok(new Date(0) instanceof Date);
  assert.equal(Date.UTC(2020, 0, 1), 1577836800000);
  assert.equal(Date.parse('1970-01-01T00:00:00Z'), 0);
});
test('subtests and hooks', async (t) => {
  await t.test('inner', () => assert.ok(true));
});
` });
  const run = runGuarded(root, 'test/clean.test.mjs');
  assert.equal(run.status, 0, run.output);
  // The one read after reset is refused and recorded: the record fails the command even though the test passed.
  assert.deepEqual(run.record.refused.map((entry) => entry.api), ['Date.now()']);
});

test('waiting on a real timer fails; until() for the real event passes', () => {
  const root = checkout({
    'test/wait.test.mjs': `${header}import { setTimeout as delay } from 'node:timers/promises';
test('global timer', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});
test('timers/promises', async () => {
  await delay(5);
});
`,
    'test/until.test.mjs': `${header}import { spawn } from 'node:child_process';
import { until } from ${JSON.stringify(GUARD_URL)};
test('until a child exits', async () => {
  const child = spawn(process.execPath, ['-e', '0']);
  let code = null;
  child.on('exit', (value) => { code = value; });
  await until(() => code !== null, 'the child to exit');
  assert.equal(code, 0);
  assert.equal(await until(Promise.resolve('done'), 'a promise'), 'done');
});
`,
  });
  const wait = runGuarded(root, 'test/wait.test.mjs');
  assert.notEqual(wait.status, 0, wait.output);
  assert.deepEqual(wait.record.refused.map((entry) => entry.api), ['setTimeout', 'timers/promises.setTimeout']);
  rmSync(path.join(root, 'clock-record.jsonl'));
  const ok = runGuarded(root, 'test/until.test.mjs');
  assert.equal(ok.status, 0, ok.output);
  assert.deepEqual(ok.record.refused, []);
});

test('a refusal the test swallows still fails the command through the record', () => {
  const root = checkout({ 'test/swallow.test.mjs': `${header}test('swallows', () => {\n  try { Date.now(); } catch { /* hidden */ }\n});\n` });
  const run = runGuarded(root, 'test/swallow.test.mjs');
  assert.equal(run.status, 0, run.output);
  assert.equal(run.record.refused.length, 1);
  assert.equal(run.record.refused[0].file, 'test/swallow.test.mjs');
});

test('a node child the test starts gets the guard too', () => {
  const root = checkout({
    'test/helpers/child.mjs': 'process.stdout.write(String(Date.now()));\n',
    'test/spawns.test.mjs': `${header}import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('child reads the clock', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/child.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
`,
  });
  const run = runGuarded(root, 'test/spawns.test.mjs');
  assert.notEqual(run.status, 0, run.output);
  assert.deepEqual(run.record.refused.map((entry) => `${entry.file} ${entry.api}`), ['test/helpers/child.mjs Date.now()']);
});

test('a debt-list file is recorded and let through; sleep() needs an allowlist entry', () => {
  const root = checkout({
    [DEBT_FILE]: 'test/old.test.mjs\n',
    'scripts/ci/test-clock-allow.json': JSON.stringify([{ file: 'test/allowed.test.mjs', kind: 'sleep', count: 1, reason: 'r', ruling: 'x' }]),
    'test/old.test.mjs': `${header}test('old', () => {\n  assert.ok(Date.now() > 0);\n});\n`,
    'test/sleeps.test.mjs': `${header}import { sleep } from ${JSON.stringify(GUARD_URL)};\ntest('sleeps', async () => {\n  await sleep(1, 'why');\n});\n`,
    'test/allowed.test.mjs': `${header}import { sleep } from ${JSON.stringify(GUARD_URL)};\ntest('sleeps', async () => {\n  await sleep(1, 'why');\n});\n`,
  });
  const old = runGuarded(root, 'test/old.test.mjs');
  assert.equal(old.status, 0, old.output);
  assert.deepEqual(old.record.refused, []);
  assert.deepEqual(old.record.debt.map((entry) => `${entry.file}:${entry.line}`), ['test/old.test.mjs:4']);
  rmSync(path.join(root, 'clock-record.jsonl'));
  const sleeps = runGuarded(root, 'test/sleeps.test.mjs');
  assert.notEqual(sleeps.status, 0, sleeps.output);
  assert.deepEqual(sleeps.record.refused.map((entry) => entry.api), ['sleep() without an allowlist entry']);
  rmSync(path.join(root, 'clock-record.jsonl'));
  const allowed = runGuarded(root, 'test/allowed.test.mjs');
  assert.equal(allowed.status, 0, allowed.output);
  assert.deepEqual(allowed.record.refused, []);
});

// A git checkout with one commit (the base), for the debt list's comparisons.
function repository(files) {
  const root = checkout(files);
  const git = (...args) => {
    const out = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, base: git('rev-parse', 'HEAD') };
}
const write = (root, name, text) => {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), text);
};

test('the debt list only shrinks: a new line, more hits, a gone or clean file each fail', () => {
  const listed = `${header}test('x', () => {\n  assert.ok(Date.now());\n});\n`;
  const { root, base } = repository({
    [DEBT_FILE]: 'test/a.test.mjs\ntest/b.test.mjs\ntest/c.test.mjs\n',
    'test/a.test.mjs': listed, 'test/b.test.mjs': listed, 'test/c.test.mjs': listed, 'test/d.test.mjs': `${header}test('x', () => {});\n`,
  });
  assert.deepEqual(debtVerdict({ root, base }).problems, []);
  // A line the base list does not have.
  write(root, DEBT_FILE, 'test/a.test.mjs\ntest/b.test.mjs\ntest/c.test.mjs\ntest/d.test.mjs\n');
  assert.deepEqual(debtVerdict({ root, base }).problems, [`test/d.test.mjs: test-clock debt grew (the base commit's ${DEBT_FILE} does not list it); fix the test instead`]);
  write(root, DEBT_FILE, 'test/a.test.mjs\ntest/b.test.mjs\ntest/c.test.mjs\n');
  // More hits in a listed file; a listed file with none left; a listed file gone.
  write(root, 'test/a.test.mjs', `${listed}test('y', () => {\n  assert.ok(new Date());\n});\n`);
  write(root, 'test/b.test.mjs', `${header}test('x', (t) => {\n  assert.ok(true);\n});\n`);
  rmSync(path.join(root, 'test/c.test.mjs'));
  assert.deepEqual(debtVerdict({ root, base }).problems, [
    'test/a.test.mjs: real-clock uses grew from 1 to 2; a listed file only sheds them',
    `test/b.test.mjs: no real-clock use left; remove the line from ${DEBT_FILE}`,
    `test/c.test.mjs: listed in ${DEBT_FILE} but not a test file here; remove the line`,
  ]);
  // A base commit git cannot read is a failure, not a pass.
  assert.match(debtVerdict({ root, base: '0123456789abcdef0123456789abcdef01234567' }).problems[0], /base commit .* cannot be read/);
  // Unsorted or repeated lines.
  assert.deepEqual(parseDebt('b\na\n').problems, [`${DEBT_FILE}: keep the lines sorted`]);
  assert.deepEqual(parseDebt('a\na\n').problems, [`${DEBT_FILE}: a file is listed twice`]);
});

test('what has no preload is read statically: PowerShell, Python, SQL sleep, node:test timeout', () => {
  // The texts are split so this file does not carry them.
  const ps = ['Start', 'Sleep'].join('-');
  const py = ['time', 'sleep(1)'].join('.');
  const sql = ['pg', 'sleep(1)'].join('_');
  const option = `{ time${''}out: 5000 }`;
  const { root, base } = repository({ [DEBT_FILE]: '', 'test/clean.test.mjs': `${header}test('x', () => {});\n` });
  assert.deepEqual(debtVerdict({ root, base }).problems, []);
  write(root, 'test/ps.test.mjs', `${header}const script = '${ps} -Seconds 2';\n`);
  write(root, 'test/test_wait.py', `import time\n${py}\n`);
  write(root, 'test/db.test.mjs', `${header}const q = 'select ${sql}';\n`);
  write(root, 'test/limit.test.mjs', `${header}test('slow', ${option}, () => {});\n`);
  write(root, 'windows/test-thing.ps1', `${ps} 1\n`);
  const problems = debtVerdict({ root, base }).problems;
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.match(problems.join('\n'), /test\/db\.test\.mjs:3: pg.sleep/);
  assert.match(problems.join('\n'), /test\/limit\.test\.mjs:3: node:test's \{ timeout \}/);
  assert.match(problems.join('\n'), /test\/ps\.test\.mjs:3: PowerShell/);
  assert.match(problems.join('\n'), /test\/test_wait\.py:2: Python/);
  assert.match(problems.join('\n'), /windows\/test-thing\.ps1:1: PowerShell/);
  // A comment line is not a use.
  assert.deepEqual(scanSource(`// ${ps}\n/*\n ${sql}\n*/\n`, 'js'), {});
});

test('the allowlist names a file, a kind and the exact count', () => {
  const sleeper = `${header}import { sleep } from '../scripts/ci/test-clock-guard.mjs';\ntest('x', async () => { await sleep(1, 'a'); await sleep(1, 'b'); });\n`;
  const entry = (count) => JSON.stringify([{ file: 'test/s.test.mjs', kind: 'sleep', count, reason: 'measures a real delay', ruling: 'FABLE x' }]);
  const { root } = repository({ [DEBT_FILE]: '', 'test/s.test.mjs': sleeper, 'scripts/ci/test-clock-allow.json': entry(2) });
  assert.deepEqual(debtVerdict({ root }).problems, []);
  write(root, 'scripts/ci/test-clock-allow.json', entry(1));
  assert.match(debtVerdict({ root }).problems.join('\n'), /the entry says 1, the file has 2/);
  write(root, 'scripts/ci/test-clock-allow.json', JSON.stringify([{ file: 'test/s.test.mjs', kind: 'wallclock', count: 1, reason: 'r', ruling: 'x' }]));
  assert.match(debtVerdict({ root }).problems.join('\n'), /an entry is \{ file, kind/);
});

test('the guard environment and what counts as test code', () => {
  const env = clockGuardEnv({ root: REPO, record: path.join(REPO, 'r.jsonl') });
  assert.equal(env.NODE_OPTIONS, `--import=${GUARD_URL}`);
  assert.equal(env.CLUED_CLOCK_ROOT, REPO);
  assert.equal(testFileKind('apps/x/tests/a.mjs'), 'js');
  assert.equal(testFileKind('scripts/ci/x.test.mjs'), 'js');
  assert.equal(testFileKind('apps/x/src/a.mjs'), null);
  assert.equal(testFileKind('a/node_modules/b/test/c.js'), null);
  assert.equal(testFileKind('reinstall/test/test_locks.py'), 'py');
  assert.equal(testFileKind('windows/test-m5b.ps1'), 'ps');
  assert.equal(testFileKind('windows/install.ps1'), null);
});

test('the repository as it is: the debt list, the allowlist and the static rules hold', () => {
  const { problems, debt } = debtVerdict({ root: REPO });
  assert.deepEqual(problems, []);
  assert.ok(debt.length > 0);
});
