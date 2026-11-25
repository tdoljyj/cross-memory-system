// Lanes (FABLE-ci-duration-node-side-20261124, 做法 2; task 3435f8bf): a CI job without --shard runs the n parts --shard
// would make of its plan at once, in one job, each lane its suites in order. These tests drive the real runSelected.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as selection from './ci-required-selection.mjs';

const { SUITE_COMMANDS, executeSuite, readShardSeconds, runSelected, selectSuites } = selection;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const quiet = () => {};
const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; for (const name of ['GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) delete env[name]; return env; };

test('lanes: a plan with clued-cloud build runs serially on the shared checkout', async () => {
  const ran = [];
  const status = await runSelected(['clued-cloud'], { root: ROOT, env: { GITHUB_ACTIONS: 'true' }, cores: 28, log: quiet,
    run: (id) => { ran.push(id); return 0; }, runPart: () => assert.fail('a shared build cannot run concurrently') });
  assert.equal(status, 0);
  assert.deepEqual(ran, ['clued-cloud']);
});

// The units a recorded command list runs (as the --shard property test counts them): each test file operand of a listing
// command, every other command whole. The reporter switches are not part of the plan; neither is the lane's concurrency.
function unitsOf(calls) {
  const units = [];
  for (const { cwd, argv: raw } of calls) {
    const argv = raw.filter((arg) => !arg.startsWith('--test-reporter') && !arg.startsWith('--test-concurrency'));
    const testAt = argv.indexOf('--test');
    const unittestAt = argv.findIndex((arg, i) => arg === 'unittest' && argv[i - 1] === '-m');
    const anchor = testAt >= 0 ? testAt : unittestAt >= 0 && argv[unittestAt + 1] !== 'discover' ? unittestAt : -1;
    const operands = anchor < 0 ? [] : argv.filter((arg, i) => i > anchor && !arg.startsWith('-'));
    if (operands.length === 0) {
      units.push({ key: JSON.stringify([cwd, argv]), file: null });
      continue;
    }
    for (const file of operands) units.push({ key: JSON.stringify([cwd, file]), file: path.posix.join(cwd, file) });
  }
  return units;
}

// executeSuite in this process with a recording spawn: the real plan of each suite, nothing started.
function recordingSuite(calls, lane = null) {
  return (id, { root, env, shard } = {}) => {
    const lines = [];
    const status = executeSuite(id, {
      root, env, log: (text) => lines.push(String(text)), platform: 'linux', known: {},
      readReportFile: () => JSON.stringify({ type: 'summary', counts: {}, success: true }),
      spawn: (command, args, options) => {
        calls.push({ id, lane: lane ?? shard?.index ?? 0, cwd: path.relative(root, options.cwd).replaceAll('\\', '/'), argv: [command, ...args] });
        return { status: 0, stdout: Buffer.from('') };
      },
      ...(shard ? { shard } : {}),
    });
    return { status, lines };
  };
}

test('lanes: the Windows ci-suites plan in 3 lanes runs each unit once, a file in one lane, the longest lane within the design bound', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-lanes-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { GITHUB_ACTIONS: 'true', CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp };
  const suites = selectSuites('ci-suites', null, 'win32').suites;
  // Today's plan, serial (one suite after another, no lanes): what the lanes must run between them.
  const serial = [];
  assert.equal(await runSelected(suites, { root: ROOT, env: { CI_BASE_SHA: env.CI_BASE_SHA, RUNNER_TEMP: temp }, log: quiet,
    run: (id, options) => recordingSuite(serial)(id, options).status }), 0);
  // DESK's Windows runner: 28 logical cores, so 3 lanes, each node --test at floor(27 / 3) = 9.
  const calls = [];
  const parts = [];
  const serialRun = [];
  const status = await runSelected(suites, { root: ROOT, env, log: quiet, cores: 28,
    run: (id) => { serialRun.push(id); return 0; },
    runPart: async (id, { root, env: partEnv, lane }) => {
      parts.push({ id, lane: { ...lane } });
      const tally = { units: 0, ran: 0 };
      const { status: partStatus, lines } = recordingSuite(calls, lane.index)(id, { root, env: partEnv,
        shard: { index: lane.index, total: lane.total, tally, lane: true, concurrency: lane.concurrency } });
      return { status: partStatus, output: lines.join('\n'), tally };
    } });
  assert.equal(status, 0);
  assert.deepEqual(serialRun, [], 'a 28-core CI job does not run its suites one after another');
  assert.deepEqual(parts.filter((part) => part.lane.index === 1).map((part) => part.id), suites, 'each lane takes the suites in order');
  assert.equal(parts.length, suites.length * 3, 'every suite has a part in each of 3 lanes');
  assert.ok(parts.every((part) => part.lane.total === 3 && part.lane.concurrency === 9), JSON.stringify(parts[0]));

  const planUnits = unitsOf(serial);
  const laneUnits = [1, 2, 3].map((index) => unitsOf(calls.filter((call) => call.lane === index)));
  // Every unit once: the lanes together are the plan; no file is in two lanes.
  assert.deepEqual(laneUnits.flat().map((unit) => unit.key).sort(), planUnits.map((unit) => unit.key).sort(), 'the 3 lanes run the plan, each unit once');
  const fileLane = new Map();
  laneUnits.forEach((units, at) => units.filter((unit) => unit.file).forEach((unit) => {
    assert.ok(!fileLane.has(unit.file), `${unit.file} is in lanes ${fileLane.get(unit.file)} and ${at + 1}`);
    fileLane.set(unit.file, at + 1);
  }));
  assert.ok(fileLane.size > 100, `the plan's test files are all in a lane (${fileLane.size})`);
  // Each lane's node --test runs at its share of the cores.
  const nodeTests = calls.filter((call) => call.argv[0] === 'node' && call.argv[1] === '--test');
  assert.ok(nodeTests.length > 0 && nodeTests.every((call) => call.argv.includes('--test-concurrency=9')), 'node --test runs at --test-concurrency=9 in a lane');
  // The bound the design gives (FABLE-ci-duration-node-side §2 做法 2): on DESK 13.8 minutes, 1.1 of them preparation, the
  // longest lane about 5.5 of the 12.7 the suites took one after another; by the table's seconds, the longest lane holds at
  // most 5.5 / 12.7 of the plan's.
  const { table } = readShardSeconds();
  const seconds = (units) => units.reduce((sum, unit) => sum + (unit.file ? table.get(unit.file) ?? 0 : 0), 0);
  const total = seconds(planUnits);
  const loads = laneUnits.map(seconds);
  t.diagnostic(`table seconds: plan ${total}, lanes ${loads.join(' / ')}`);
  assert.ok(total > 1000, `the table covers the plan (${total} s)`);
  assert.ok(Math.max(...loads) <= (5.5 / 12.7) * total, `longest lane ${Math.max(...loads)} s of ${total} s (bound ${Math.round((5.5 / 12.7) * total)})`);
  // The commands that run whole (drill, unittest discover, validators) are spread too, not all in one lane.
  const whole = laneUnits.map((units) => units.filter((unit) => !unit.file).length);
  assert.ok(Math.max(...whole) < whole.reduce((a, b) => a + b, 0), `whole commands per lane ${whole}`);
});

// A part that runs its suite's units for this lane (unit u of a suite goes to lane (u mod n) + 1), each a real process
// that sleeps, recording when each started and ended.
function sleepingParts(plan, record, { failing = null } = {}) {
  return async (id, { lane }) => {
    const output = [];
    let status = 0;
    for (const [unit, ms] of plan[id].entries()) {
      if (unit % lane.total !== lane.index - 1) continue;
      const started = performance.now();
      const child = spawn(process.execPath, ['-e', `setTimeout(() => process.exit(${failing === `${id}/${unit}` ? 1 : 0}), ${ms})`], { stdio: 'ignore' });
      const code = await new Promise((resolve) => child.on('close', resolve));
      record.push({ id, unit, lane: lane.index, started, ended: performance.now() });
      output.push(`${id} unit ${unit} line 1`, `${id} unit ${unit} line 2`);
      if (code !== 0) status = code;
    }
    return { status, output: output.join('\n'), tally: { units: plan[id].length, ran: output.length / 2 } };
  };
}

test('lanes: two lanes run at once, each unit once, in less time than the units take one after another', async () => {
  const plan = { a: [600, 600], b: [600, 600], c: [600, 600] };
  const record = [];
  const lines = [];
  const started = performance.now();
  const status = await runSelected(Object.keys(plan), { root: ROOT, env: { GITHUB_ACTIONS: 'true' }, cores: 8, log: quiet,
    summary: (text) => lines.push(text), run: () => assert.fail('8 cores in a CI job run in lanes'), runPart: sleepingParts(plan, record) });
  const wall = performance.now() - started;
  assert.equal(status, 0);
  assert.deepEqual(record.map(({ id, unit }) => `${id}/${unit}`).sort(), ['a/0', 'a/1', 'b/0', 'b/1', 'c/0', 'c/1'], 'every unit once');
  const sum = record.reduce((total, unit) => total + (unit.ended - unit.started), 0);
  // Measured: printed so the run's log keeps it (结果文件的实测墙钟).
  console.log(`lanes wall clock: ${Math.round(wall)} ms for ${Math.round(sum)} ms of units (${(wall / sum * 100).toFixed(0)}%)`);
  assert.ok(wall < 0.75 * sum, `two lanes took ${Math.round(wall)} ms, the units ${Math.round(sum)} ms one after another`);
  const overlap = record.some((one) => record.some((other) => other.lane !== one.lane && other.started < one.ended && one.started < other.ended));
  assert.ok(overlap, 'units of different lanes ran at the same time');
  assert.deepEqual(lines, ['- `a`: passed\n', '- `b`: passed\n', '- `c`: passed\n'], 'the summary is written as without lanes');
});

test('lanes: a failing unit fails the step, every other suite still runs and is in the summary, each part printed whole', async () => {
  const plan = { a: [50, 50], b: [50, 50], c: [50] };
  const record = [];
  const lines = [];
  const logged = [];
  const status = await runSelected(Object.keys(plan), { root: ROOT, env: { GITHUB_ACTIONS: 'true' }, cores: 8, log: (text) => logged.push(String(text)),
    summary: (text) => lines.push(text), run: () => assert.fail('lanes'), runPart: sleepingParts(plan, record, { failing: 'b/1' }) });
  assert.equal(status, 1);
  assert.deepEqual(record.map(({ id, unit }) => `${id}/${unit}`).sort(), ['a/0', 'a/1', 'b/0', 'b/1', 'c/0'], 'a failure does not stop the other units');
  assert.deepEqual(lines, ['- `a`: passed\n', '- `b`: **failed**\n', '- `c`: passed\n']);
  assert.ok(logged.some((line) => /^::error title=\w+ suites::failed: b$/.test(line)), logged.join('\n'));
  // One log call per part: its own lines together, never split by another lane's.
  for (const { id, unit } of record) {
    const block = logged.filter((line) => line.includes(`${id} unit ${unit} line 1`));
    assert.equal(block.length, 1);
    assert.ok(block[0].includes(`${id} unit ${unit} line 1\n${id} unit ${unit} line 2`), block[0]);
  }
  // A part that throws fails its suite; the rest still run.
  const thrown = [];
  assert.equal(await runSelected(['x', 'y'], { root: ROOT, env: { GITHUB_ACTIONS: 'true' }, cores: 8, log: quiet, summary: (text) => thrown.push(text),
    runPart: async (id) => { if (id === 'x') throw new Error('cannot start'); return { status: 0, output: '', tally: null }; } }), 1);
  assert.deepEqual(thrown, ['- `x`: **failed**\n', '- `y`: passed\n']);
});

test('lanes: n is max(1, min(3, floor(cores / 4))) in a CI job; CI_SELECTED_LANES only lowers it; --shard, a local run and 4 cores run serially as today', async () => {
  const { laneCount, laneTestConcurrency, LANES_MAX, LANES_VARIABLE } = selection;
  assert.equal(LANES_MAX, 3);
  assert.equal(LANES_VARIABLE, 'CI_SELECTED_LANES');
  const ci = { GITHUB_ACTIONS: 'true' };
  for (const [cores, n] of [[1, 1], [4, 1], [7, 1], [8, 2], [11, 2], [12, 3], [28, 3], [64, 3]]) assert.equal(laneCount({ cores, env: ci }), n, `${cores} cores`);
  assert.equal(laneCount({ cores: 28, env: {} }), 1, 'outside a CI job the local suite slots run one suite at a time');
  assert.equal(laneCount({ cores: 28, env: ci, shard: { index: 1, total: 4 } }), 1, '--shard is the hosted split; no lanes in it');
  assert.equal(laneCount({ cores: 28, env: { ...ci, CI_SELECTED_LANES: '2' } }), 2);
  assert.equal(laneCount({ cores: 28, env: { ...ci, CI_SELECTED_LANES: '1' } }), 1);
  assert.equal(laneCount({ cores: 8, env: { ...ci, CI_SELECTED_LANES: '9' } }), 2, 'never above the machine\'s');
  for (const bad of ['0', '-1', 'two', '1.5']) assert.equal(laneCount({ cores: 28, env: { ...ci, CI_SELECTED_LANES: bad } }), 1, `${bad}: serial`);
  assert.equal(laneTestConcurrency(28, 3), 9);
  assert.equal(laneTestConcurrency(8, 2), 3);
  assert.equal(laneTestConcurrency(4, 3), 2);
  // A 4-core CI job (a hosted machine): today's run, suite after suite, with today's options; no part starts.
  const env = { GITHUB_ACTIONS: 'true' };
  const ran = [];
  const lines = [];
  assert.equal(await runSelected(['resident-node', 'offline-drill', 'selection'], { root: ROOT, env, cores: 4, log: quiet, summary: (text) => lines.push(text),
    run: (id, options) => { ran.push([id, options]); return id === 'offline-drill' ? 1 : 0; }, runPart: () => assert.fail('no lanes on 4 cores') }), 1);
  assert.deepEqual(ran, ['resident-node', 'offline-drill', 'selection'].map((id) => [id, { root: ROOT, env, log: quiet }]));
  assert.deepEqual(lines, ['- `resident-node`: passed\n', '- `offline-drill`: **failed**\n', '- `selection`: passed\n']);
});

test('lanes: the part process runs its suite\'s share through runSuite and hands back its output whole and its result', async (t) => {
  // A checkout whose selector adds two suites of its own (as a pull request may): one passes, one fails. Each command runs
  // whole, so one of the 2 lanes runs it; the other lane's part runs nothing and passes.
  const root = mkdtempSync(path.join(os.tmpdir(), 'clued-lanes-part-'));
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-lanes-temp-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true }); });
  mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'ci', 'ci-required-selection.mjs'), `export const SUITE_COMMANDS = ${JSON.stringify({
    'lane-ok': [{ cwd: '.', argv: ['node', 'ok.mjs'] }], 'lane-bad': [{ cwd: '.', argv: ['node', 'bad.mjs'] }] })};\n`);
  writeFileSync(path.join(root, 'ok.mjs'), "console.log('lane-ok ran');\n");
  writeFileSync(path.join(root, 'bad.mjs'), "console.log('lane-bad ran'); process.exit(3);\n");
  const logged = [];
  const lines = [];
  const status = await runSelected(['lane-ok', 'lane-bad'], { root, env: { ...childEnv(), GITHUB_ACTIONS: 'true', RUNNER_TEMP: temp }, cores: 8,
    log: (text) => logged.push(String(text)), summary: (text) => lines.push(text), run: () => assert.fail('lanes') });
  assert.equal(status, 1, logged.join('\n'));
  assert.deepEqual(lines, ['- `lane-ok`: passed\n', '- `lane-bad`: **failed**\n'], logged.join('\n'));
  const okBlocks = logged.filter((line) => line.includes('lane-ok ran'));
  assert.equal(okBlocks.length, 1, logged.join('\n'));
  assert.match(okBlocks[0], /^lane-ok: 道 [12]\/2 用时 [\d.]+ 秒，passed\n[\s\S]*::group::lane-ok: \(\.\) node ok\.mjs[\s\S]*lane-ok ran/);
  assert.ok(logged.some((line) => /^lane-bad: 道 [12]\/2 用时 [\d.]+ 秒，failed \(3\)\n[\s\S]*lane-bad ran/.test(line)), logged.join('\n'));
  assert.equal(logged.filter((line) => /^lane-(ok|bad): 道 [12]\/2 用时 /.test(line)).length, 4, 'a part of each suite in each lane');
  assert.ok(!logged.some((line) => line.includes('输出未收')), 'a part whose pipe closed with its process has no drain notice');
});

test('lanes: a process a test leaves behind holding the output pipe does not hold the lane: the part ends after the drain', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clued-lanes-orphan-'));
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-lanes-temp-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true }); });
  mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'ci', 'ci-required-selection.mjs'), `export const SUITE_COMMANDS = ${JSON.stringify({
    'lane-orphan': [{ cwd: '.', argv: ['node', 'orphan.mjs'] }] })};\n`);
  // It leaves a process that inherits its output and lives 15 s (it ends by itself), and exits 0 at once.
  writeFileSync(path.join(root, 'orphan.mjs'), [
    "import { spawn } from 'node:child_process';",
    "import os from 'node:os';",
    // Its directory is not the checkout's, which this test removes (Windows keeps a process's directory).
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { cwd: os.tmpdir(), stdio: 'inherit', detached: true }).unref();",
    "console.log('orphan left');", ''].join('\n'));
  const logged = [];
  const started = performance.now();
  const status = await runSelected(['lane-orphan'], { root, env: { ...childEnv(), GITHUB_ACTIONS: 'true', RUNNER_TEMP: temp }, cores: 8,
    log: (text) => logged.push(String(text)), run: () => assert.fail('lanes'),
    runPart: (id, options) => selection.runLanePart(id, { ...options, drainMs: 500 }) });
  const wall = performance.now() - started;
  assert.equal(status, 0, logged.join('\n'));
  assert.ok(wall < 10_000, `the lanes ended after ${Math.round(wall)} ms, not when the left process did`);
  assert.ok(logged.some((line) => line.includes('orphan left')), logged.join('\n'));
  // The part ended by the drain says so (review M2): passed, and what the left process writes later is not in the log.
  const drained = logged.filter((line) => line.includes('留下的进程仍占输出管道'));
  assert.equal(drained.length, 1, logged.join('\n'));
  assert.match(drained[0], /^lane-orphan: 道 [12]\/2 用时 [\d.]+ 秒，passed\n[\s\S]*orphan left[\s\S]*\n::notice title=lane-orphan::道 [12]\/2：子进程已退出，留下的进程仍占输出管道，500 毫秒后收尾，之后的输出未收$/);
  assert.equal(selection.LANE_DRAIN_MS, 5_000);
});

test('lanes: each part logs a start line as it starts, before its block; a job cancelled while a part runs names it by that line', async () => {
  const logged = [];
  let release;
  const hung = new Promise((resolve) => { release = resolve; });
  const atStart = [];
  const until = async (done) => {
    const limit = performance.now() + 5_000;
    while (!done()) {
      assert.ok(performance.now() < limit, logged.join('\n'));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  // Lane 2's part of b does not end until released: as a part still running when the job is cancelled at its limit.
  const running = runSelected(['a', 'b', 'c'], { root: ROOT, env: { GITHUB_ACTIONS: 'true' }, cores: 8, log: (text) => logged.push(String(text)),
    run: () => assert.fail('lanes'),
    runPart: async (id, { lane }) => {
      atStart.push(`${id} ${lane.index} ${logged.includes(`${id}: 道 ${lane.index}/2 开始`)}`);
      if (id === 'b' && lane.index === 2) await hung;
      return { status: 0, output: `${id} lane ${lane.index} output`, tally: null };
    } });
  await until(() => logged.some((line) => line.startsWith('c: 道 1/2 用时 ')));
  // What a cancel now leaves in the log: the parts that started and have no block are the one still running.
  const started = logged.filter((line) => / 开始$/.test(line)).map((line) => line.replace(/ 开始$/, ''));
  const ended = logged.filter((line) => / 用时 /.test(line)).map((line) => line.split(' 用时 ')[0]);
  assert.deepEqual(started.filter((part) => !ended.includes(part)), ['b: 道 2/2'], logged.join('\n'));
  release();
  assert.equal(await running, 0);
  assert.deepEqual(atStart.sort(), ['a 1 true', 'a 2 true', 'b 1 true', 'b 2 true', 'c 1 true', 'c 2 true'], 'the start line is out before the part runs');
  for (const id of ['a', 'b', 'c']) {
    for (const index of [1, 2]) {
      const start = logged.indexOf(`${id}: 道 ${index}/2 开始`);
      const blocks = logged.map((line, at) => [line, at]).filter(([line]) => line.startsWith(`${id}: 道 ${index}/2 用时 `));
      assert.equal(blocks.length, 1, `${id} ${index}: ${logged.join('\n')}`);
      assert.ok(start >= 0 && start < blocks[0][1], `${id} lane ${index}: start line at ${start}, its block at ${blocks[0][1]}`);
      assert.equal(logged.filter((line) => line === `${id}: 道 ${index}/2 开始`).length, 1);
    }
  }
});
