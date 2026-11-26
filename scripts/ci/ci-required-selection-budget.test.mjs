import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { executeSuite, expandArgv, SUITE_COMMANDS } from './ci-required-selection.mjs';
import reporter, { metronomeWorkload } from './ci-test-failures-reporter.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('B1: the reporter ends a stream that spans a tick with its metronome median', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  async function* events() {
    yield { type: 'test:start', data: { nesting: 0, name: 'example' } };
    t.mock.timers.tick(5_100);
    yield { type: 'test:pass', data: { nesting: 0, name: 'example', details: { duration_ms: 5100 } } };
    yield { type: 'test:summary', data: { success: true } };
  }
  const rows = [];
  for await (const line of reporter(events())) rows.push(JSON.parse(line));
  assert.deepEqual(rows.map(({ type }) => type), ['pass', 'summary', 'metronome']);
  assert.ok(rows.at(-1).n >= 1);
  assert.ok(rows.at(-1).median_ms > 0);
  t.diagnostic(`metronome median ${rows.at(-1).median_ms.toFixed(2)} ms`);
});

test('B2: an unsharded command reports seconds for all its files and the metronome median', () => {
  const files = SUITE_COMMANDS.selection[0].argv.slice(2);
  const report = files.map((file, index) => ({ type: 'end', nesting: 0, wallFile: path.join(ROOT, file), ms: (index + 1) * 1000 }));
  report.push({ type: 'summary', success: true }, { type: 'metronome', n: 3, median_ms: 20.5 });
  const lines = [];
  assert.equal(executeSuite('selection', {
    root: ROOT, env: {}, log: (line) => lines.push(line),
    spawn: () => ({ status: 0 }), readReportFile: () => report.map((row) => JSON.stringify(row)).join('\n'),
  }), 0);
  const timing = lines.filter((line) => line.startsWith('selection: file-seconds '));
  assert.equal(timing.length, 1, 'a non-sharded run has one file-seconds line');
  const match = /^selection: file-seconds (\{.*\}) metronome 20\.5$/.exec(timing[0]);
  assert.ok(match, timing[0]);
  assert.deepEqual(JSON.parse(match[1]), Object.fromEntries(files.map((file, index) => [file, index + 1])));
});

test('B3: {tests:} puts untimed files first, then heaviest first, and falls back to alphabetical order', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-budget-order-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const suite = SUITE_COMMANDS['resident-node'][0];
  const cwd = path.join(temp, suite.cwd);
  mkdirSync(path.join(cwd, 'test'), { recursive: true });
  mkdirSync(path.join(cwd, 'rollout/test'), { recursive: true });
  const alphabetical = ['test/a-light.test.mjs', 'test/b-new.test.mjs', 'test/c-tied.test.mjs', 'test/d-new.test.mjs',
    'test/e-tied.test.mjs', 'rollout/test/z-heavy.test.mjs'];
  for (const file of alphabetical) {
    writeFileSync(path.join(cwd, file), `import { appendFileSync } from 'node:fs';
import test from 'node:test';
appendFileSync('order.log', ${JSON.stringify(`${file}\n`)});
test('fixture', () => {});
test('fixture [needs:non-elevated]', () => { throw new Error('must be skipped'); });\n`);
  }
  const shardSecondsFile = path.join(temp, 'table.json');
  const expand = () => expandArgv(suite.argv, { cwd, root: temp, shardSecondsFile }).slice(2);
  writeFileSync(shardSecondsFile, JSON.stringify({ [`${suite.cwd}/${alphabetical[0]}`]: 3, [`${suite.cwd}/${alphabetical[2]}`]: 10,
    [`${suite.cwd}/${alphabetical[4]}`]: 10, [`${suite.cwd}/${alphabetical[5]}`]: 50 }));
  const expected = [alphabetical[1], alphabetical[3], alphabetical[5], alphabetical[2], alphabetical[4], alphabetical[0]];
  assert.deepEqual(expand(), expected);
  const env = { ...process.env, RUNNER_TEMP: temp, CLUED_CI_HOST_LACKS: 'non-elevated' };
  const lines = [];
  assert.equal(executeSuite('resident-node', { root: temp, env, shardSecondsFile, log: (line) => lines.push(line),
    shard: { index: 1, total: 1, lane: true, concurrency: 1 } }), 0, lines.join('\n'));
  assert.deepEqual(readFileSync(path.join(cwd, 'order.log'), 'utf8').trimEnd().split('\n'), expected);
  const timing = lines.find((line) => line.startsWith('resident-node: file-seconds '));
  const match = /^resident-node: file-seconds (\{.*\}) metronome \S+$/.exec(timing);
  assert.ok(match, timing);
  assert.deepEqual(Object.keys(JSON.parse(match[1])), alphabetical.toSorted().map((file) => `${suite.cwd}/${file}`));
  writeFileSync(shardSecondsFile, '{"a.test.mjs": -1}');
  assert.deepEqual(expand(), alphabetical.toSorted());
});

test('resident-node: a free slot takes the next file while an earlier slot is still busy', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-budget-slots-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const suite = SUITE_COMMANDS['resident-node'][0];
  const cwd = path.join(temp, suite.cwd);
  mkdirSync(path.join(cwd, 'test'), { recursive: true });
  mkdirSync(path.join(cwd, 'rollout/test'), { recursive: true });
  const guard = new URL('./test-clock-guard.mjs', import.meta.url).href;
  const files = ['rollout/test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/d.test.mjs'];
  for (const [index, file] of files.entries()) {
    writeFileSync(path.join(cwd, file), `import { appendFileSync, readFileSync } from 'node:fs';
import { until } from ${JSON.stringify(guard)};
import test from 'node:test';
test('slot ${index}', async () => {
  appendFileSync('slots.log', 'start ${index}\\n');
  const next = ${[1, 2, null, null][index]};
  if (next !== null) await until(() => readFileSync('slots.log', 'utf8').includes('start ' + next + '\\n'), 'next slot');
  appendFileSync('slots.log', 'end ${index}\\n');
});\n`);
  }
  const lines = [];
  assert.equal(executeSuite('resident-node', { root: temp, env: { ...process.env, RUNNER_TEMP: temp },
    log: (line) => lines.push(line), commandTimeoutMs: 10_000, shard: { index: 1, total: 1, lane: true, concurrency: 2 } }), 0, lines.join('\n'));
  const events = readFileSync(path.join(cwd, 'slots.log'), 'utf8').trimEnd().split('\n');
  assert.deepEqual(events.toSorted(), files.flatMap((_, index) => [`start ${index}`, `end ${index}`]).sort());
  assert.ok(events.indexOf('start 2') < events.indexOf('end 1'), events.join('\n'));
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.startsWith('start') ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(peak, 2, events.join('\n'));
});

test('B4: the metronome workload does not use native hash acceleration', (t) => {
  const createHash = t.mock.method(crypto, 'createHash', () => {
    throw new Error('the metronome must not call crypto.createHash');
  });
  try {
    syncBuiltinESMExports();
    assert.doesNotThrow(() => metronomeWorkload());
  } finally {
    createHash.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Windows ci-suites-windows 作业上限覆盖两遍实测耗时并留出 25% 余量', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/clued-required-tests-windows.yml', import.meta.url), 'utf8');
  const job = workflow.split(/^  (?=[\w-]+:)/m).find((block) => block.startsWith('ci-suites-windows:'));
  assert.ok(job, '缺少 ci-suites-windows 作业');
  const timeout = /^    timeout-minutes:[ \t]*(\d+)[ \t]*\r?$/m.exec(job);
  assert.ok(timeout, '缺少 ci-suites-windows 作业级 timeout-minutes');

  // GitHub 运行 139578654649 中各套件第一遍的实测秒数。
  const firstPassSeconds = { 'node-governance': 54, 'resident-node': 942, 'resident-python': 162,
    'offline-drill': 58, 'source-v2-node': 186 };
  const minimumSeconds = 2 * Object.values(firstPassSeconds).reduce((total, seconds) => total + seconds, 0) * 1.25;
  const timeoutSeconds = Number(timeout[1]) * 60;
  assert.ok(timeoutSeconds >= minimumSeconds,
    `ci-suites-windows 的上限 ${timeoutSeconds} 秒低于双遍预算 ${minimumSeconds} 秒`);
});
