// One limit at the entry (FABLE-flaky-four-replan-20261124 §2; PLAN-ci-p90-next-20261125 补充裁定; task 3435f8bf): every
// command a suite runs is ended at COMMAND_TIMEOUT_MS (SIGKILL) and fails; for a node --test command with the trusted
// reporter the entry then names each file and test that began and did not end (the reporter's begin/end lines, from Node's
// test:dequeue/test:complete). The command line stays as it is. The limit is injected small here; the suite runs in a child
// process with a guard of its own, so a run that never returns fails the test instead of hanging it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as selection from './ci-required-selection.mjs';
import reporter from './ci-test-failures-reporter.mjs';

const { SUITE_COMMANDS, commandArgv, executeSuite, knownFailureVerdict, readReport, shardSecondsOf } = selection;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELECTION = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ci-required-selection.mjs')).href;
// The limit for a node --test command (it starts Node and the test files) and for any other command.
const TEST_MS = 10_000;
const COMMAND_MS = 1500;
// How long the guard waits for the suite to return; a fixture that hangs ends itself later, so nothing outlives the test long.
const GUARD_MS = 60_000;
const HANG_MS = 90_000;
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
const { suite, root, commandTimeoutMs } = JSON.parse(json);
process.exitCode = executeSuite(suite, { root, commandTimeoutMs });`;
function guarded(root, suite, limit) {
  const out = path.join(root, 'tmp', 'suite.log');
  const fd = openSync(out, 'w');
  const started = performance.now();
  let result;
  try {
    result = spawnSync(process.execPath, ['--input-type=module', '-e', GUARD, SELECTION,
      JSON.stringify({ suite, root, commandTimeoutMs: limit })],
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

test('1: a test that never settles, its file kept alive, fails the command at its limit and is named as begun, not ended', (t) => {
  const root = fixture(t, {
    [`${SOURCE_DIR}/quick.test.mjs`]: "import test from 'node:test';\ntest('quick one', () => {});\n",
    [`${SOURCE_DIR}/stuck.test.mjs`]: `import test from 'node:test';\n${HANG_EXIT}`
      + "test('never settles', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n",
  });
  const { status, text } = guarded(root, 'source-v2-node', TEST_MS);
  assert.equal(status, 1, text);
  assert.match(text, /::error::source-v2-node: .* 超过 .*被终止/);
  assert.match(text, /::error title=source-v2-node 开始了没结束::.*stuck\.test\.mjs :: never settles/);
  assert.match(text, /quick one/);
});

// A file blocked in a synchronous call: the entry guarantees only the file's own line (the parent sends its begin), not the
// tests that ended before the block; what the blocked process had not written to its pipe never reaches the entry.
test('2: a test whose spawnSync never returns blocks its file; the command fails at its limit, the file named', (t) => {
  const root = fixture(t, {
    [`${SOURCE_DIR}/blocked.test.mjs`]: "import test from 'node:test';\nimport { spawnSync } from 'node:child_process';\nimport os from 'node:os';\n"
      + "test('first done', () => {});\ntest('second done', () => {});\n"
      + `test('blocked in spawnSync', () => { spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, ${HANG_MS})'], { cwd: os.tmpdir() }); });\n`,
  });
  const { status, text, elapsed } = guarded(root, 'source-v2-node', TEST_MS);
  assert.equal(status, 1, text);
  assert.match(text, /::error title=source-v2-node 开始了没结束::.*blocked\.test\.mjs/);
  assert.ok(elapsed < TEST_MS + 20_000, `returned after ${Math.round(elapsed)} ms`);
});

test('3: a command other than node --test that never exits fails at its limit, with the suite and the command', (t) => {
  const root = fixture(t, { [`${RESIDENT}/drill/offline-drill.mjs`]: `${HANG_EXIT}setInterval(() => {}, 1000);\n` });
  const { status, text, elapsed } = guarded(root, 'offline-drill', COMMAND_MS);
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
      known: {}, readReportFile: () => '', commandTimeoutMs: COMMAND_MS, ...(shard ? { shard } : {}),
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

test('4: every command keeps its command line byte for byte and runs with the limit, killed with SIGKILL', () => {
  const limited = (call) => {
    assert.equal(call.options.timeout, COMMAND_MS, call.argv.join(' '));
    assert.equal(call.options.killSignal, 'SIGKILL', call.argv.join(' '));
  };
  // production-schema: node --test commands, the run-tests wrapper and a check script, each as the suite table has it.
  const calls = recorded('production-schema');
  const commands = SUITE_COMMANDS['production-schema'];
  assert.equal(calls.length, commands.length);
  commands.forEach((command, i) => {
    const original = expanded('production-schema', command).map((arg) => (arg.includes('production-schema-report') ? '{report}' : arg));
    const argv = withoutReporter(calls[i].argv).map((arg) => (arg.includes('production-schema-report') ? '{report}' : arg));
    assert.deepEqual(argv, original);
    limited(calls[i]);
  });
  // A host that lacks a capability and a lane keep their switches, and nothing else is added; under --shard as without.
  const lane = recorded('selection', { env: { CLUED_CI_HOST_LACKS: 'non-elevated' }, shard: { index: 1, total: 1, lane: true, concurrency: 3 } });
  assert.equal(lane.length, 1);
  const original = expanded('selection', SUITE_COMMANDS.selection[0]);
  assert.deepEqual(withoutReporter(lane[0].argv), [...original.slice(0, 2), '--test-skip-pattern=\\[needs:(?:non-elevated)\\]',
    '--test-concurrency=3', ...original.slice(2)]);
  limited(lane[0]);
  const shard = recorded('selection', { shard: { index: 1, total: 1 } });
  assert.deepEqual(withoutReporter(shard[0].argv), original);
  limited(shard[0]);
});

async function reported(events) {
  let text = '';
  for await (const line of reporter((async function* source() { yield* events; }()))) text += line;
  return text;
}

test('5: the reporter writes begin and end lines; unfinishedTests counts them; the verdicts read past them', async () => {
  const fileA = path.join(ROOT, 'a.test.mjs');
  const fileB = path.join(ROOT, 'b.test.mjs');
  const event = (type, data) => ({ type, data });
  const text = await reported([
    event('test:dequeue', { file: fileA, nesting: 0, name: fileA }),
    event('test:dequeue', { file: fileA, nesting: 0, name: 'done' }),
    event('test:start', { file: fileA, nesting: 0, name: 'done' }),
    event('test:pass', { file: fileA, nesting: 0, name: 'done', details: { duration_ms: 5 } }),
    event('test:complete', { file: fileA, nesting: 0, name: 'done' }),
    event('test:dequeue', { file: fileA, nesting: 0, name: 'hangs' }),
    event('test:dequeue', { file: fileB, nesting: 0, name: 'twice' }),
    event('test:complete', { file: fileB, nesting: 0, name: 'twice' }),
    event('test:dequeue', { file: fileB, nesting: 0, name: 'twice' }),
    event('test:dequeue', { nesting: 0, name: 'no file' }),
  ]);
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.filter((line) => line.type === 'begin' || line.type === 'end').slice(0, 3), [
    { type: 'begin', file: fileA, nesting: 0, name: fileA },
    { type: 'begin', file: fileA, nesting: 0, name: 'done' },
    { type: 'end', file: fileA, nesting: 0, name: 'done' },
  ]);
  assert.deepEqual(lines.at(-1), { type: 'begin', file: null, nesting: 0, name: 'no file' });
  assert.equal(typeof selection.unfinishedTests, 'function', 'unfinishedTests is exported');
  // A file begun and not ended, a test begun and not ended, a test begun twice and ended once; a cut-off last line is ignored.
  assert.deepEqual(selection.unfinishedTests(`${text}{"type":"beg`, ROOT), [
    { file: 'a.test.mjs', nesting: 0, name: fileA },
    { file: 'a.test.mjs', nesting: 0, name: 'hangs' },
    { file: 'b.test.mjs', nesting: 0, name: 'twice' },
    { file: null, nesting: 0, name: 'no file' },
  ]);
  // What decides a command reads the same with and without the begin and end lines.
  const failing = await reported([
    event('test:dequeue', { file: fileA, nesting: 0, name: 'broken' }),
    event('test:fail', { file: fileA, nesting: 0, name: 'broken', details: { duration_ms: 7, error: new Error('broken') } }),
    event('test:complete', { file: fileA, nesting: 0, name: 'broken' }),
    event('test:summary', { counts: { tests: 1, failed: 1 }, success: false }),
  ]);
  const bare = failing.split('\n').filter((line) => !/"type":"(?:begin|end)"/.test(line)).join('\n');
  assert.notEqual(bare, failing, 'the run has begin and end lines');
  const known = [{ ...JSON.parse(bare.split('\n')[0]), file: 'a.test.mjs' }];
  for (const list of [[], known]) {
    assert.deepEqual(knownFailureVerdict({ status: 1, report: readReport(failing, ROOT), known: list }),
      knownFailureVerdict({ status: 1, report: readReport(bare, ROOT), known: list }));
  }
  const files = new Set(['a.test.mjs']);
  assert.deepEqual(shardSecondsOf(readReport(failing, ROOT), files), shardSecondsOf(readReport(bare, ROOT), files));
});
