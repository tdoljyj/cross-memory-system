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
