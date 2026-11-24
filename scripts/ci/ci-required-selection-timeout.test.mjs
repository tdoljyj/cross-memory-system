// One limit at the entry (FABLE-flaky-four-replan-20261124 §2; task 3435f8bf): every node --test command a suite runs gets
// Node's own --test-timeout (each test and each test file), every other command a limit on the whole command, so a test or
// command that hangs fails with its name instead of waiting for the job's limit. The limits are injected small here; the
// suite runs in a child process with a guard of its own, so a run that never returns fails the test instead of hanging it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUITE_COMMANDS, commandArgv, executeSuite } from './ci-required-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELECTION = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ci-required-selection.mjs')).href;
const TEST_MS = 2000;
const COMMAND_MS = 1500;
// How long the guard waits for the suite to return; a fixture that hangs ends itself later, so nothing outlives the test long.
const GUARD_MS = 30_000;
const HANG_MS = 45_000;
const SOURCE_DIR = 'work/actions-hosted-migration/independent-ci-v1/test';
const RESIDENT = 'work/independent-ci-resident-v1';

function fixture(t, files) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-entry-cap-')));
  // A fixture process the run left may still hold the directory; removing it never decides a test.
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 10 }); } catch { /* left behind */ } });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  mkdirSync(path.join(root, 'tmp'));
  return root;
}

const suiteEnv = (root) => {
  const env = { ...process.env, RUNNER_TEMP: path.join(root, 'tmp') };
  for (const name of ['NODE_TEST_CONTEXT', 'GITHUB_STEP_SUMMARY', 'CI_BASE_SHA', 'CLUED_CI_HOST_LACKS']) delete env[name];
  return env;
};

// executeSuite(suite) in a child process; its output (and that of every command it starts) goes to a file, so a process the
// run leaves behind cannot keep the guard waiting on a pipe.
const GUARD = `const [url, json] = process.argv.slice(1);
const { executeSuite } = await import(url);
const { suite, root, testTimeoutMs, commandTimeoutMs } = JSON.parse(json);
process.exitCode = executeSuite(suite, { root, testTimeoutMs, commandTimeoutMs });`;
function guarded(root, suite) {
  const out = path.join(root, 'tmp', 'suite.log');
  const fd = openSync(out, 'w');
  const started = performance.now();
  let result;
  try {
    result = spawnSync(process.execPath, ['--input-type=module', '-e', GUARD, SELECTION,
      JSON.stringify({ suite, root, testTimeoutMs: TEST_MS, commandTimeoutMs: COMMAND_MS })],
    { cwd: root, env: suiteEnv(root), stdio: ['ignore', fd, fd], timeout: GUARD_MS, windowsHide: true });
  } finally {
    closeSync(fd);
  }
  const elapsed = performance.now() - started;
  const text = readFileSync(out, 'utf8');
  assert.notEqual(result.error?.code, 'ETIMEDOUT', `the suite did not return within ${GUARD_MS} ms:\n${text}`);
  return { status: result.status, text, elapsed };
}

const HANG_EXIT = `setTimeout(() => process.exit(3), ${HANG_MS});\n`;

test('1: a test that never finishes fails its command, named, with "timed out"', (t) => {
  const root = fixture(t, {
    [`${SOURCE_DIR}/quick.test.mjs`]: "import test from 'node:test';\ntest('quick one', () => {});\n",
    [`${SOURCE_DIR}/stuck.test.mjs`]: `import test from 'node:test';\n${HANG_EXIT}`
      + "test('never settles', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n",
  });
  const { status, text } = guarded(root, 'source-v2-node');
  assert.equal(status, 1, text);
  assert.match(text, /never settles/);
  assert.match(text, /timed out/);
  assert.match(text, /quick one/);
});

test('2: a test whose spawnSync never returns blocks its file; the file fails, named, with the tests before it', (t) => {
  const root = fixture(t, {
    [`${SOURCE_DIR}/blocked.test.mjs`]: "import test from 'node:test';\nimport { spawnSync } from 'node:child_process';\nimport os from 'node:os';\n"
      + "test('first done', () => {});\ntest('second done', () => {});\n"
      + `test('blocked in spawnSync', () => { spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, ${HANG_MS})'], { cwd: os.tmpdir() }); });\n`,
  });
  const { status, text, elapsed } = guarded(root, 'source-v2-node');
  assert.equal(status, 1, text);
  assert.match(text, /blocked\.test\.mjs/);
  assert.match(text, /first done/);
  assert.match(text, /second done/);
  assert.ok(elapsed < 10 * TEST_MS, `returned after ${Math.round(elapsed)} ms`);
});

test('3: a command other than node --test that never exits fails at its limit, with the suite and the command', (t) => {
  const root = fixture(t, { [`${RESIDENT}/drill/offline-drill.mjs`]: `${HANG_EXIT}setInterval(() => {}, 1000);\n` });
  const { status, text, elapsed } = guarded(root, 'offline-drill');
  assert.equal(status, 1, text);
  assert.match(text, /::error::offline-drill: node drill\/offline-drill\.mjs 超过 .*被终止/);
  assert.ok(elapsed < 10 * COMMAND_MS + 5000, `returned after ${Math.round(elapsed)} ms`);
});

// The argv each command is started with, nothing started.
function recorded(id, { env = {}, shard = null, root = ROOT } = {}) {
  const calls = [];
  const temp = mkdtempSync(path.join(os.tmpdir(), 'ci-entry-cap-argv-'));
  try {
    const status = executeSuite(id, { root, env: { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp, ...env }, log: () => {}, platform: 'linux',
      known: {}, readReportFile: () => '', testTimeoutMs: TEST_MS, commandTimeoutMs: COMMAND_MS, ...(shard ? { shard } : {}),
      spawn: (command, args, options) => { calls.push({ argv: [command, ...args], options }); return { status: 0, stdout: Buffer.from('') }; } });
    assert.equal(status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return calls;
}
const withoutReporter = (argv) => argv.filter((arg) => !arg.startsWith('--test-reporter'));
const expanded = (id, command) => commandArgv(command, { cwd: path.join(ROOT, command.cwd), root: ROOT, base: 'a'.repeat(40),
  report: '{report}', hosted: false });

test('4: a command gains only --test-timeout (node --test, and the run-tests wrapper after its --test); any other only a limit', () => {
  const timeout = `--test-timeout=${TEST_MS}`;
  // production-schema: node --test commands, the run-tests wrapper and a check script, each as the suite table has it.
  const calls = recorded('production-schema');
  const commands = SUITE_COMMANDS['production-schema'];
  assert.equal(calls.length, commands.length);
  commands.forEach((command, i) => {
    const original = expanded('production-schema', command).map((arg) => (arg.includes('production-schema-report') ? '{report}' : arg));
    const argv = withoutReporter(calls[i].argv).map((arg) => (arg.includes('production-schema-report') ? '{report}' : arg));
    if (original[1] === '--test') {
      assert.deepEqual(argv, [...original.slice(0, 2), timeout, ...original.slice(2)]);
      assert.equal(calls[i].options.timeout, undefined, 'node --test has Node\'s limits, not one on the whole command');
    } else if (original[1] === 'scripts/run-tests.mjs') {
      assert.equal(original[2], '--test');
      assert.deepEqual(argv, [...original.slice(0, 3), timeout, ...original.slice(3)]);
      assert.equal(calls[i].options.timeout, undefined);
    } else {
      assert.deepEqual(argv, original);
      assert.equal(calls[i].options.timeout, COMMAND_MS);
    }
  });
  // A host that lacks a capability and a lane keep their switches; the limit comes with them, under --shard as without.
  const lane = recorded('selection', { env: { CLUED_CI_HOST_LACKS: 'non-elevated' }, shard: { index: 1, total: 1, lane: true, concurrency: 3 } });
  assert.equal(lane.length, 1);
  const original = expanded('selection', SUITE_COMMANDS.selection[0]);
  assert.deepEqual(withoutReporter(lane[0].argv), [...original.slice(0, 2), '--test-skip-pattern=\\[needs:(?:non-elevated)\\]',
    '--test-concurrency=3', timeout, ...original.slice(2)]);
  const shard = recorded('selection', { shard: { index: 1, total: 1 } });
  assert.deepEqual(withoutReporter(shard[0].argv), [...original.slice(0, 2), timeout, ...original.slice(2)]);
});
