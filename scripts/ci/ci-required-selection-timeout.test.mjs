// One limit at the entry (FABLE-flaky-four-replan-20261124 §2; PLAN-ci-p90-next-20261125 补充裁定; task 3435f8bf): every
// command a suite runs is ended at COMMAND_TIMEOUT_MS (SIGKILL) and fails; for a node --test command with the trusted
// reporter the entry then names each file and test that began and did not end (the reporter's begin/end lines, from Node's
// test:dequeue/test:complete). The command line stays as it is. The limit is injected small here; the suite runs in a child
// process; the entry's own limit ends a run that never returns (a test may not give a child a time limit of its own).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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
const { suite, root, commandTimeoutMs, shard, rerunMinTimeoutMs } = JSON.parse(json);
process.exitCode = executeSuite(suite, { root, commandTimeoutMs, shard, rerunMinTimeoutMs,
  ...(rerunMinTimeoutMs ? { rerunMaxElapsedMs: rerunMinTimeoutMs / 2 } : {}) });`;
function guarded(root, suite, limit, shard = null, base, rerunMinTimeoutMs) {
  const out = path.join(root, 'tmp', 'suite.log');
  const fd = openSync(out, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, ['--input-type=module', '-e', GUARD, SELECTION,
      JSON.stringify({ suite, root, commandTimeoutMs: limit, shard, rerunMinTimeoutMs })],
    { cwd: root, env: { ...suiteEnv(root), ...(base ? { CI_BASE_SHA: base } : {}) }, stdio: ['ignore', fd, fd], windowsHide: true });
  } finally {
    closeSync(fd);
  }
  const text = readFileSync(out, 'utf8');
  return { status: result.status, text };
}

const HANG_EXIT = `setTimeout(() => process.exit(3), ${HANG_MS});\n`;

test('1: a test that never settles, its file kept alive, fails the command at its limit and is named as begun, not ended', (t) => {
  const root = fixture(t, {
    [`${SOURCE_DIR}/quick.test.mjs`]: "import test from 'node:test';\ntest('quick one', () => {});\n",
    [`${SOURCE_DIR}/stuck.test.mjs`]: `import test from 'node:test';\nimport net from 'node:net';\n`
      // An open server keeps the file alive without a timer (a test file may not use one); the entry's limit ends it.
      + "test('never settles', async () => { net.createServer().listen(0); await new Promise(() => {}); });\n",
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
  const { status, text } = guarded(root, 'source-v2-node', TEST_MS);
  assert.equal(status, 1, text);
  assert.match(text, /::error title=source-v2-node 开始了没结束::.*blocked\.test\.mjs/);
});

test('3: a command other than node --test that never exits fails at its limit, with the suite and the command', (t) => {
  const root = fixture(t, { [`${RESIDENT}/drill/offline-drill.mjs`]: `${HANG_EXIT}setInterval(() => {}, 1000);\n` });
  const { status, text } = guarded(root, 'offline-drill', COMMAND_MS);
  assert.equal(status, 1, text);
  assert.match(text, /::error::offline-drill: node drill\/offline-drill\.mjs 超过 .*被终止/);
});

const ONE_LANE = { index: 1, total: 1, lane: true, concurrency: 1 };
const residentFixture = (t, testFiles, support = {}) => fixture(t, Object.fromEntries(
  Object.entries({ ...testFiles, ...support }).map(([file, content]) => [`${RESIDENT}/${file}`, content])));
const quick = (name) => `import test from 'node:test';\ntest('${name}', () => {});\n`;

test('resident-node: a single slot finishes healthy files whose total time exceeds one command limit', (t) => {
  const files = ['test/a.test.mjs', 'test/b.test.mjs', 'rollout/test/c.test.mjs', 'rollout/test/d.test.mjs'];
  const root = residentFixture(t, Object.fromEntries(files.map((file) => [file,
    `import { wait } from '${file.startsWith('rollout') ? '../' : ''}../hold.mjs';\nawait wait();\n${quick(file)}`])), {
    // This is work done by the fixture, not a wait or a timeout in the test's orchestration.
    'hold.mjs': 'export const wait = () => new Promise((resolve) => setTimeout(resolve, 900));\n',
  });
  const { status, text } = guarded(root, 'resident-node', 2500, ONE_LANE);
  assert.equal(status, 0, text);
  for (const file of files) assert.match(text, new RegExp(`✔ ${file.replaceAll('.', '\\.')}`));
});

test('resident-node: a stuck file times out by name, drains its descendants and never qualifies for a retry', async (t) => {
  const connect = (port, stop = false) => new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('error', reject);
    socket.once('connect', () => {
      if (stop) socket.end('stop');
      else socket.destroy();
      resolve();
    });
  });
  const root = residentFixture(t, {
    'rollout/test/a-done.test.mjs': quick('file already completed'),
    'test/z-stuck.test.mjs': `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { quitEventually } from '../fixture-time.mjs';
test('never settles', async () => {
  const middle = spawnSync(process.execPath, ['middle.mjs'], { stdio: 'ignore' });
  assert.equal(middle.status, 0);
  const port = Number(readFileSync('descendant.port', 'utf8'));
  await new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
  writeFileSync('middle-exited-and-listening', '');
  quitEventually();
  await new Promise(() => {});
});`,
  }, {
    'fixture-time.mjs': 'export const quitEventually = () => setTimeout(() => process.exit(3), 20_000);',
    'middle.mjs': `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const portFile = process.argv[2] ?? 'descendant.port';
const child = spawn(process.execPath, ['listener.mjs', portFile], {
  detached: process.platform === 'win32', stdio: 'ignore',
});
child.unref();
const expire = setTimeout(() => process.exit(3), 5000);
const poll = setInterval(() => {
  if (!existsSync(portFile)) return;
  clearInterval(poll);
  clearTimeout(expire);
}, 10);`,
    'listener.mjs': `import net from 'node:net';
import { writeFileSync } from 'node:fs';
const server = net.createServer((socket) => {
  if (process.argv[2] === 'control.port') socket.once('data', () => { clearTimeout(expire); server.close(); });
});
server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));
const expire = setTimeout(() => server.close(), 20_000);`,
  });
  const cwd = path.join(root, RESIDENT);
  const decoy = path.join(cwd, 'control.port');
  const ready = spawnSync(process.execPath, ['middle.mjs', 'control.port'], { cwd, env: suiteEnv(root), windowsHide: true });
  assert.equal(ready.status, 0, String(ready.stderr));
  const controlPort = Number(readFileSync(decoy, 'utf8'));
  await connect(controlPort);
  try {
    const { status, text } = guarded(root, 'resident-node', 5000, ONE_LANE);
    assert.equal(status, 1, text);
    assert.match(text, /::error::resident-node: .*z-stuck\.test\.mjs 超过 5 秒被终止/);
    assert.match(text, /✔ file already completed/);
    assert.ok(existsSync(path.join(cwd, 'middle-exited-and-listening')), 'middle exited and grandchild accepted a connection before timeout');
    assert.doesNotMatch(text, /(?:超过 .*被终止|开始了没结束).*a-done|a-done[^\n]*超过|again in full/);
    await connect(controlPort);
    const port = Number(readFileSync(path.join(cwd, 'descendant.port'), 'utf8'));
    await assert.rejects(connect(port), { code: 'ECONNREFUSED' });
  } finally {
    await connect(controlPort, true);
  }
});

test('resident-node: a normal assertion failure still fails the suite', (t) => {
  const root = residentFixture(t, {
    'test/a.test.mjs': quick('healthy file'),
    'rollout/test/b.test.mjs': "import test from 'node:test';\ntest('ordinary failure', () => { throw Error('fixture red'); });",
  });
  const { status, text } = guarded(root, 'resident-node', TEST_MS, ONE_LANE);
  assert.equal(status, 1, text);
  assert.match(text, /fixture red/);
  assert.doesNotMatch(text, /超过 .*被终止/);
});

test('resident-node: a reused PID in a stale process snapshot is never signalled', (t) => {
  const root = fixture(t, {
    'probe.mjs': `import { EventEmitter } from 'node:events';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
const selector = process.argv[2];
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const child = new EventEmitter();
child.pid = 300;
child.stdin = new EventEmitter();
child.stdin.write = () => {};
child.stdin.end = () => queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
const sentToReusedPid = [];
// Exercise the POSIX pool on either host without issuing real signals. PID 301 from the old
// PPID snapshot has already been reused by a member of another group when the probe returns.
Object.defineProperty(process, 'platform', { value: 'linux' });
process.kill = (pid, signal) => {
  if (pid === 301 && signal !== 0) sentToReusedPid.push(signal);
  if (pid === 300 && signal === 'SIGKILL') child.emit('exit', null, signal);
  return true;
};
childProcess.spawn = () => {
  queueMicrotask(() => child.emit('spawn'));
  return child;
};
childProcess.spawnSync = (_command, args) => ({ status: 0,
  stdout: args.includes('ppid=') ? '301 300\\n' : '300 Z\\n301 S\\n' });
syncBuiltinESMExports();
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== selector) return result;
  return { ...result, source: Buffer.from(result.source).toString() + '\\nexport { runResidentPool };' };
} });
const { runResidentPool } = await import(selector);
await runResidentPool('input.json');
console.log(JSON.stringify(sentToReusedPid));`,
    'input.json': JSON.stringify({ command: 'node', options: [], files: ['mock.test.mjs'], concurrency: 1, timeout: 30 }),
  });
  const run = spawnSync(process.execPath, ['probe.mjs', SELECTION], { cwd: root, env: suiteEnv(root), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [], 'a reused PID outside the file group received a signal');
});

for (const slow of [false, true]) test(`resident-node: ${slow ? 'an eligible retry has a whole-run deadline' : 'an eligible retry runs the entire allocated list'}`, (t) => {
  const work = (relative) => slow ? `import os from 'node:os';
import path from 'node:path';
import { work } from '${relative}/fixture-time.mjs';
if (path.basename(path.dirname(os.tmpdir())).startsWith('resident-node-again-')) {
  console.log('retry started', import.meta.filename);
  await work();
}
` : '';
  const root = residentFixture(t, {
    'test/a.test.mjs': `${work('..')}import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
test('flaky fixture', () => {
  if (existsSync('ran-once')) return;
  writeFileSync('ran-once', '');
  throw Error('fixture fails once');
});`,
    'rollout/test/b.test.mjs': work('../..') + quick('healthy fixture runs again'),
    ...(slow ? { 'test/c.test.mjs': work('..') + quick('third healthy fixture') } : {}),
  }, { 'fixture-time.mjs': 'export const work = () => new Promise((resolve) => setTimeout(resolve, 5100));' });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env: suiteEnv(root), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('add', RESIDENT);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline');
  const { status, text } = guarded(root, 'resident-node', TEST_MS, ONE_LANE, git('rev-parse', 'HEAD'), slow ? 12_000 : undefined);
  if (slow) {
    assert.match(text, /run again in full \(timeout 12 s\)/);
    assert.equal(status, 1, text);
    assert.match(text, /整遍复验超过 12 秒/);
    assert.doesNotMatch(text, /flaky::|\(flaky\): the command passes/);
    return;
  }
  assert.equal(status, 0, text);
  assert.match(text, /flaky::.*flaky fixture/);
  assert.equal(text.split('✔ healthy fixture runs again').length - 1, 2, text);
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
  const lifecycle = lines.filter((line) => line.type === 'begin' || line.type === 'end');
  assert.deepEqual(lifecycle.slice(0, 3), [
    { type: 'begin', file: fileA, nesting: 0, name: fileA },
    { type: 'begin', file: fileA, nesting: 0, name: 'done' },
    { type: 'end', file: fileA, nesting: 0, name: 'done' },
  ]);
  assert.deepEqual(lifecycle.at(-1), { type: 'begin', file: null, nesting: 0, name: 'no file' });
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

test('6: file wall clock includes module load and child exit, attributed to the test file', (t) => {
  const file = 'parent.test.mjs';
  const root = fixture(t, { [file]: `
    import { spawnSync } from 'node:child_process';
    import test from 'node:test';
    const child = () => {
      const result = spawnSync(process.execPath, ['-e', '']);
      if (result.status !== 0) throw new Error('child failed');
    };
    child();
    test('rollout/fleet/test/other.test.mjs', child);
  ` });
  const out = path.join(root, 'report.jsonl');
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${pathToFileURL(selection.REPORTER_PATH).href}`,
    `--test-reporter-destination=${out}`, file], { cwd: root, env: suiteEnv(root), encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const raw = readFileSync(out, 'utf8');
  const report = readReport(raw, root);
  const top = report.events.filter((event) => event.type === 'pass');
  assert.equal(top.length, 1);
  assert.equal(top[0].file, file);
  const wall = report.events.find((event) => event.wallFile === file);
  assert.ok(wall?.ms > top[0].ms, `file wall clock includes the module load: ${raw}`);
  assert.deepEqual(shardSecondsOf(report, new Set([file])), { [file]: Math.round(wall.ms / 100) / 10 });
});
