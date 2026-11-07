// Stage timings in the status (optimisation plan P1, Clued bf57ff10; status contract /8): the segments of a batch accumulate from the
// calls the executor already makes, the median and P90 are what they say, the records survive a restart through status.json, the
// companion's relay times travel through the mailbox, and the PR page line stays inside its length.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StatusBoard, StatusFile, STATUS_MAX_BYTES, parseStatus } from '../src/status.mjs';
import { median, p90, parseRelayTiming, parseTiming, statsOf, RELAY_TIMING_CONTRACT, TIMING_DONE_MAX } from '../src/stage-timing.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { describe, timingText, fmtDuration } from '../src/pr-status.mjs';
import { executorFixture, fakeCompanion, fakeEngine, tempRoot, triggerBytes } from './helpers.mjs';

const T0 = Date.parse('2026-11-07T08:00:00Z');
const SEC = 1000, MIN = 60_000;
const H = n => String(n).repeat(40).slice(0, 40);
const rt = (n, ms, maxMs = ms, rounds = []) => ({ handoffs: { n, ms, maxMs }, rounds });

// A board with a clock the test moves.
const clocked = () => { const c = { now: T0 }; const board = new StatusBoard({ clock: () => c.now }); return { c, board, at: ms => { c.now += ms; } }; };
const cur = (n, stage, phase, extra = {}) => ({ key: 'a'.repeat(64), pr: 7, headSha: H(n), baseSha: 'f'.repeat(40), attempt: 1, stage, phase, since: new Date(T0).toISOString(), ...extra });
const snap = b => parseStatus(Buffer.from(JSON.stringify(b.snapshot())));

test('median and P90: the middle value (mean of the two middle ones), and the nearest rank', () => {
  assert.equal(median([]), null);
  assert.equal(p90([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 10]), 3, '(2 + 3) / 2 rounds to 3');
  assert.equal(median([1, 2]), 2, '1.5 rounds up');
  const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
  assert.equal(p90(ten), 900, 'ceil(0.9 * 10) = the 9th');
  assert.equal(p90([...ten, 1100]), 1000, 'ceil(0.9 * 11) = the 10th of 11');
  assert.equal(p90([7]), 7);
});

test('segments accumulate: prep up to the bundle, each stage run, retries and waits; the rest at A is not counted', () => {
  const { board, at } = clocked();
  board.setCurrent(cur(1, 0, 'derive')); at(5 * SEC);
  board.setCurrent(cur(1, 0, 'bundle')); at(25 * SEC);
  board.setCurrent(cur(1, 1, 'stage')); at(40 * SEC);
  board.stageDone(1); at(3 * SEC); // the work between stages is nobody's stage
  board.setCurrent(cur(1, null, 'relay-wait')); at(10 * MIN);
  board.setCurrent(cur(1, 0, 'workspace')); at(20 * SEC);
  board.setCurrent(cur(1, 2, 'stage')); at(2 * MIN);
  board.stageDone(2); at(SEC);
  board.setCurrent(cur(1, 2, 'retry-wait')); at(60 * SEC);
  board.setCurrent(cur(1, 2, 'stage')); at(90 * SEC);
  const mid = snap(board).timing.current;
  assert.equal(mid.stage, 2);
  assert.equal(mid.prepMs, 30 * SEC, 'reservation -> the bundle is built');
  assert.deepEqual(mid.prep, { derive: 5 * SEC, bundle: 25 * SEC, workspace: 20 * SEC });
  assert.deepEqual(mid.stages['1'], { ms: 40 * SEC, runs: 1, waitMs: 0 });
  assert.deepEqual(mid.stages['2'], { ms: 2 * MIN, runs: 1, waitMs: 60 * SEC }, 'the open run is not in it yet');
  assert.equal(mid.activeMs, 5 * SEC + 25 * SEC + 40 * SEC + 20 * SEC + 2 * MIN + 60 * SEC);
  assert.equal(mid.openedAt, T0 + 5 * SEC + 25 * SEC + 40 * SEC + 3 * SEC + 10 * MIN + 20 * SEC + 2 * MIN + SEC + 60 * SEC);
  at(0);
  board.stageDone(2);
  board.outcome({ pr: 7, headSha: H(1), attempt: 1, outcome: 'FAILED_CLEAN', code: 'STAGE_X' });
  const t = snap(board).timing;
  assert.equal(t.current, null, 'a finished batch is no batch in flight');
  assert.equal(t.last.outcome, 'FAILED_CLEAN');
  assert.deepEqual(t.last.stages['2'], { ms: 2 * MIN + 90 * SEC, runs: 2, waitMs: 60 * SEC }, 'a run again adds up');
  assert.equal(t.last.spanMs, 5 * SEC + 25 * SEC + 40 * SEC + 3 * SEC + 10 * MIN + 20 * SEC + 2 * MIN + SEC + 60 * SEC + 90 * SEC, 'the span keeps the rests');
});

test('a batch that rests (parked at B) and comes back keeps one record: stage 8 tries add up', () => {
  const { board, at } = clocked();
  board.setCurrent(cur(2, 7, 'stage')); at(30 * SEC); board.stageDone(7);
  board.setCurrent(null); at(20 * MIN); // parked: the executor has no batch in flight
  board.setCurrent(cur(2, 8, 'stage')); at(10 * SEC); board.stageDone(8); board.setCurrent(null);
  at(15 * MIN);
  board.setCurrent(cur(2, 8, 'stage')); at(12 * SEC); board.stageDone(8);
  board.outcome({ pr: 7, headSha: H(2), attempt: 1, outcome: 'COMPLETED', pushedAt: T0 - 5 * MIN });
  const last = snap(board).timing.last;
  assert.deepEqual(last.stages['8'], { ms: 22 * SEC, runs: 2, waitMs: 0 }, 'both tries');
  assert.equal(last.activeMs, 52 * SEC);
  assert.equal(last.pushToGreenMs, 5 * MIN + 30 * SEC + 20 * MIN + 10 * SEC + 15 * MIN + 12 * SEC, 'first sighting of the head -> the end of stage 8');
  assert.equal(snap(board).timing.stats.n, 1);
});

test('an outcome of a head that never had a batch adds nothing; a sighting after the end is no sighting', () => {
  const { board } = clocked();
  assert.equal(board.outcome({ pr: 7, headSha: H(3), attempt: 1, outcome: 'IGNORED', code: 'PR_CLOSED' }), true, 'the recent list still takes it');
  assert.equal(snap(board).timing.last, null);
  board.setCurrent(cur(3, 1, 'stage'));
  board.outcome({ pr: 7, headSha: H(3), attempt: 1, outcome: 'COMPLETED', pushedAt: T0 + 99 * MIN });
  assert.equal(snap(board).timing.last.pushToGreenMs, null);
});

test('statistics over the newest 20 finished batches: per segment median and P90; only measured segments count; push to green is the day\'s', () => {
  const { board, c, at } = clocked();
  for (let i = 1; i <= 25; i += 1) {
    const h = H(1).slice(0, 38) + String(i).padStart(2, '0');
    board.setCurrent({ ...cur(1, 0, 'bundle'), headSha: h }); at(i * SEC);
    board.setCurrent({ ...cur(1, 2, 'stage'), headSha: h }); at(i * 10 * SEC); board.stageDone(2);
    if (i % 2 === 0) { board.setCurrent({ ...cur(1, 4, 'stage'), headSha: h }); at(i * SEC); board.stageDone(4); }
    board.outcome({ pr: 7, headSha: h, attempt: 1, outcome: 'COMPLETED', pushedAt: c.now - i * MIN });
  }
  const t = snap(board).timing;
  assert.equal(t.stats.n, 20);
  // the newest 20 are batches 6..25
  const s2 = Array.from({ length: 20 }, (_, k) => (k + 6) * 10 * SEC);
  assert.equal(t.stats.segments['2'].n, 20);
  assert.equal(t.stats.segments['2'].medianMs, median(s2));
  assert.equal(t.stats.segments['2'].p90Ms, s2[17], 'the 18th of 20');
  const s4 = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24].map(i => i * SEC);
  assert.deepEqual([t.stats.segments['4'].n, t.stats.segments['4'].medianMs, t.stats.segments['4'].p90Ms], [10, median(s4), s4[8]]);
  assert.deepEqual([t.stats.segments['3'].n, t.stats.segments['3'].medianMs], [0, null], 'a stage that never ran has no figures');
  assert.equal(t.stats.segments.prep.n, 20);
  assert.equal(t.stats.segments.active.n, 20);
  // push to green: the day's 25 batches waited i minutes (+ the run itself)
  assert.equal(t.pushToGreen.day, '2026-11-07');
  assert.equal(t.pushToGreen.n, 25);
  assert.ok(t.pushToGreen.maxMs >= t.pushToGreen.p90Ms && t.pushToGreen.p90Ms >= t.pushToGreen.medianMs);
  assert.equal(t.pushToGreen.maxMs, 25 * MIN);
  assert.equal(board.timing.done.length, 25);
  assert.equal(statsOf(board.timing.done).n, 20);
  // the day rolls over: yesterday's batches are not today's
  c.now += 24 * 60 * MIN;
  const next = snap(board).timing.pushToGreen;
  assert.deepEqual([next.day, next.n, next.medianMs], ['2026-11-08', 0, null]);
});

test('a scanner stage\'s relay times attach to the stage: handoffs add up, rounds append, a bad record is ignored', () => {
  const { board, at } = clocked();
  board.setCurrent(cur(4, 2, 'stage')); at(MIN);
  board.stageRelay(2, rt(7, 9_000, 4_000, [1200, 800, 1500]));
  board.stageDone(2);
  board.setCurrent(cur(4, 2, 'stage')); at(MIN);
  board.stageRelay(2, rt(3, 3_000, 2_500, [900]));
  board.stageRelay(2, { handoffs: { n: -1, ms: 1, maxMs: 1 }, rounds: [] });
  board.stageRelay(2, 'x');
  board.stageDone(2);
  board.outcome({ pr: 7, headSha: H(4), attempt: 1, outcome: 'FAILED_CLEAN' });
  assert.deepEqual(snap(board).timing.last.stages['2'].relay, rt(10, 12_000, 4_000, [1200, 800, 1500, 900]));
});

test('restart: the finished and the resting batches and the stage-10 rounds come back from status.json; what does not fit is dropped', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, 'status.json');
  const a = clocked();
  a.board.setCurrent(cur(5, 2, 'stage')); a.at(50 * SEC); a.board.stageDone(2);
  a.board.outcome({ pr: 7, headSha: H(5), attempt: 1, outcome: 'COMPLETED', pushedAt: T0 - MIN });
  a.board.setCurrent(cur(6, 7, 'stage')); a.at(30 * SEC); a.board.stageDone(7); a.board.setCurrent(null); // rests at B
  a.board.noteTrain({ startedAt: T0 + 2 * MIN, endedAt: T0 + 5 * MIN, mode: 'on', sweep: { fullSweep: { state: 'complete', startedAt: new Date(T0 + 3 * MIN).toISOString(), completedAt: new Date(T0 + 4 * MIN).toISOString() } } });
  await new StatusFile(file).write(a.board.snapshot());
  const before = parseStatus(await fs.readFile(file)).timing;

  const b = clocked();
  assert.equal(b.board.restoreTiming(JSON.parse(await fs.readFile(file, 'utf8')).timing), true);
  b.c.now = a.c.now + 5 * MIN; // the service was down a while
  await new StatusFile(file).write(b.board.snapshot());
  const after = parseStatus(await fs.readFile(file)).timing;
  assert.deepEqual(after.last, before.last, 'the newest finished batch is still there');
  assert.deepEqual(after.stats, before.stats);
  assert.deepEqual(after.train, before.train);
  // the resting batch continues in the same record
  b.board.setCurrent(cur(6, 8, 'stage')); b.at(10 * SEC); b.board.stageDone(8);
  b.board.outcome({ pr: 7, headSha: H(6), attempt: 1, outcome: 'COMPLETED' });
  const resumed = snap(b.board).timing.last;
  assert.deepEqual([resumed.stages['7'].ms, resumed.stages['8'].ms, resumed.activeMs], [30 * SEC, 10 * SEC, 40 * SEC]);
  // garbage in the file: nothing is restored, nothing throws
  for (const bad of [null, 'x', [], { done: 'x', open: [{ pr: 'x' }], train: { rounds: [{ ms: -1 }] } }, { done: [{ pr: 7, headSha: 'nope', startedAt: 'x' }] }]) {
    const c = clocked();
    c.board.restoreTiming(bad);
    assert.deepEqual([c.board.timing.done.length, c.board.timing.open.size, c.board.timing.rounds.length], [0, 0, 0], JSON.stringify(bad));
  }
  // a snapshot that holds many large finished batches stays one bounded file
  const big = clocked();
  for (let i = 0; i < TIMING_DONE_MAX + 10; i += 1) {
    const h = H(1).slice(0, 36) + String(i).padStart(4, '0');
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8]) { big.board.setCurrent({ ...cur(1, s, 'stage'), headSha: h }); big.at(SEC); big.board.stageRelay(s, rt(40, 4000, 500, Array(16).fill(1000))); big.board.stageDone(s); }
    big.board.outcome({ pr: 7, headSha: h, attempt: 1, outcome: 'COMPLETED', pushedAt: big.c.now - MIN });
  }
  const bytes = Buffer.byteLength(JSON.stringify(big.board.snapshot()));
  assert.ok(bytes < STATUS_MAX_BYTES / 2, `${bytes} bytes`);
  assert.equal(snap(big.board).timing.stats.n, 20);
});

test('stage 10: each run\'s length and the scan share of its sweep; statistics over the rounds', () => {
  const { board } = clocked();
  const run = (i, sweep) => board.noteTrain({ startedAt: T0 + i * 10 * MIN, endedAt: T0 + i * 10 * MIN + (i + 1) * MIN, mode: 'on', sweep });
  run(0, null);
  run(1, { fullSweep: { state: 'complete', startedAt: new Date(T0 + 5 * MIN).toISOString(), completedAt: new Date(T0 + 10 * MIN + 30 * SEC).toISOString() } });
  run(2, { fullSweep: { state: 'running', startedAt: new Date(T0 + 20 * MIN + 30 * SEC).toISOString(), completedAt: null } });
  run(3, { fullSweep: { state: 'none', startedAt: null, completedAt: null } });
  board.noteTrain({ startedAt: 5, endedAt: 1 });
  // newest first: [ms, scanMs]
  assert.deepEqual(board.timing.rounds.map(r => [r.ms, r.scanMs]), [[4 * MIN, null], [3 * MIN, 150 * SEC], [2 * MIN, 30 * SEC], [MIN, null]]);
  const tr = snap(board).timing.train;
  assert.deepEqual([tr.n, tr.medianMs, tr.p90Ms], [4, Math.round(2.5 * MIN), 4 * MIN]);
  assert.deepEqual([tr.scan.n, tr.scan.medianMs], [2, 90 * SEC]);
  assert.equal(tr.last.ms, 4 * MIN);
});

test('status /8: the reader returns what fits and null for what does not, never a refusal', () => {
  const { board, at } = clocked();
  board.setCurrent(cur(7, 2, 'stage')); at(MIN);
  const raw = JSON.parse(JSON.stringify(board.snapshot()));
  assert.equal(raw.contract, 'clued.independent-ci.resident-status/8');
  for (const bad of [null, 'x', 5, []]) assert.equal(parseTiming(bad), null);
  const odd = parseTiming({ current: 'x', last: 'x', stats: 7, pushToGreen: 'x', train: 1 });
  assert.deepEqual([odd.current, odd.last, odd.pushToGreen, odd.train], [null, null, null, null]);
  const t = parseStatus(Buffer.from(JSON.stringify({ ...raw, timing: { ...raw.timing, stats: { window: 20, n: 1, segments: { 2: { n: 1, medianMs: -5, p90Ms: 'x' } } } } }))).timing;
  assert.deepEqual(t.stats.segments['2'], { n: 1, medianMs: null, p90Ms: null });
  assert.equal(parseStatus(Buffer.from(JSON.stringify({ ...raw, timing: 'x' }))).timing, null);
  // times are read as milliseconds
  const ok = parseStatus(Buffer.from(JSON.stringify(raw))).timing;
  assert.equal(ok.current.startedAt, T0);
  assert.equal(ok.current.openedAt, T0);
});

test('relay times: the companion\'s record is read back by the service, leniently; a torn or foreign one is nothing', async t => {
  const box = await Mailbox.open(await tempRoot(t), () => T0);
  const request = await box.send('relay-stage', { batchId: 'b'.repeat(16) + '-' + '0'.repeat(12), stage: 2, jobId: 'c'.repeat(64) }, 60_000);
  assert.equal(await box.timing(request), null, 'no record yet');
  const handoffs = [{ mode: 'SendIssue', seq: 0, ms: 1500 }, { mode: 'ReceiveChallenge', seq: 1, ms: 700 }, { mode: 'SendResponse', seq: 1, ms: 900 }, { mode: 'ReceiveResult', seq: 0, ms: 600 }];
  await box.writeTiming(request, { handoffs, rounds: [{ seq: 1, ms: 4200 }] });
  assert.deepEqual(await box.timing(request), rt(4, 3700, 1500, [4200]));
  await assert.rejects(box.writeTiming(request, { handoffs, rounds: [] }), { code: 'CREATE_ONLY_TARGET_EXISTS' }, 'create-only');
  await fs.writeFile(path.join(box.responses, `${request.requestId}.timing.json`), '{"contract":'); // torn
  assert.equal(await box.timing(request), null);
  assert.equal(parseRelayTiming({ contract: RELAY_TIMING_CONTRACT, handoffs: [{ mode: 'Bogus', ms: 1 }, { mode: 'SendIssue', ms: -1 }, { mode: 'SendIssue', ms: 5 }], rounds: [{ ms: 'x' }, { ms: 9 }] }).handoffs.n, 1);
  assert.equal(parseRelayTiming({ contract: 'other', handoffs: [], rounds: [] }), null);
});

test('executor: a whole batch\'s segments reach the status; the stage-terminal receipt ends a stage; stage 8 closes the batch with push to green', async t => {
  const ref = {};
  const board = new StatusBoard({ clock: () => ref.f?.clock() ?? T0 });
  const engine = fakeEngine();
  const run = engine.runStage;
  const took = { 1: 40 * SEC, 2: 3 * MIN, 3: 20 * SEC, 4: 4 * MIN, 5: 30 * SEC, 6: 2 * MIN, 7: 25 * SEC, 8: 15 * SEC };
  engine.runStage = async (batch, stage, o) => {
    const base = await run(batch, stage, o);
    ref.f.advance(took[stage.number]);
    return stage.number === 2 ? { ...base, relayTiming: rt(6, 5_000, 2_000, [1_500, 900]) } : base;
  };
  const companion = fakeCompanion({}, () => ref.f.clock());
  const bundle = companion.buildBundle;
  companion.buildBundle = async b => { ref.f.advance(12 * SEC); return bundle(b); };
  ref.f = await executorFixture(t, { engine, companion, status: board, now: T0 });
  await ref.f.drop(triggerBytes());
  const tick = await ref.f.exec.tick();
  const last = snap(board).timing.last;
  assert.equal(tick.state, 'COMPLETED');
  assert.equal(last.outcome, 'COMPLETED');
  assert.equal(last.stages['8'].ms, took[8]);
  assert.ok(last, `a batch was recorded (tick: ${tick.state})`);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.equal(last.stages[String(n)].ms, took[n], `stage ${n}`);
  assert.deepEqual(last.stages['2'].relay, rt(6, 5_000, 2_000, [1_500, 900]));
  assert.equal(last.prep.bundle, 12 * SEC);
  assert.equal(last.prepMs, 12 * SEC + (last.prep.derive ?? 0));
  assert.equal(last.activeMs, last.prepMs + (last.prep.workspace ?? 0) + Object.keys(last.stages).reduce((a, k) => a + last.stages[k].ms, 0));
  assert.equal(last.pushToGreenMs, 12 * SEC + Object.values(took).reduce((a, b) => a + b, 0), 'first sighting of the head -> the end of stage 8');
});

test('PR page: the running line shows the time so far and a short table; the lease reminder and the length limit are kept', () => {
  const now = T0 + 12 * MIN + 5 * SEC;
  const base = { writtenAt: now, executor: { state: 'RUNNING' }, backfill: { complete: true }, pending: [], recent: [], halt: null, paused: false, queue: null,
    current: { pr: 7, headSha: H(7), attempt: 1, stage: 4, since: T0, claimExpiresAt: null, leaseFrom: null } };
  const timing = { pr: 7, headSha: H(7), attempt: 1, startedAt: T0, openedAt: now - 3 * MIN, stage: 4, activeMs: 9 * MIN + 5 * SEC, prepMs: 2 * MIN,
    prep: {}, stages: { 1: { ms: 40 * SEC, runs: 1, waitMs: 0 }, 2: { ms: 5 * MIN, runs: 1, waitMs: 0 }, 3: { ms: 20 * SEC, runs: 1, waitMs: 0 } } };
  const pull = { pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 };
  const d = status => describe({ pull, now, status }).description;
  assert.equal(d({ ...base, timing: { current: timing } }), '运行中：第 4 段（trivy 扫描）；已跑 12分；备 2分 1:40秒 2:5分 3:20秒');
  assert.equal(d(base), '运行中：第 4 段（trivy 扫描）', 'no timing, no change');
  assert.equal(d({ ...base, timing: { current: { ...timing, headSha: H(8) } } }), '运行中：第 4 段（trivy 扫描）', 'another batch\'s timing is not shown');
  // a short lease: the reminder stays whole and last
  const lease = { ...base, current: { ...base.current, claimExpiresAt: now + 10 * MIN } };
  const withLease = d({ ...lease, timing: { current: timing } });
  assert.match(withLease, /；认领约 \d\d:\d\dZ 到期，请现在续租（已续租可忽略）$/);
  assert.ok(withLease.length <= 140);
  // every combination stays inside 140 characters and keeps the base text and the lease reminder whole
  const long = { current: { ...timing, stages: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => [k, { ms: 3_700_000, runs: 1, waitMs: 0 }])) } };
  for (const stage of [1, 2, 4, 6, 8]) for (const exp of [null, now + MIN, now - MIN]) {
    const text = d({ ...base, current: { ...base.current, stage, claimExpiresAt: exp }, timing: long });
    assert.ok(text.length <= 140, `${stage} ${exp}: ${text.length}`);
    assert.ok(text.startsWith(`运行中：第 ${stage} 段`));
    if (exp !== null) assert.match(text, /（已续租可忽略）$/);
  }
  assert.equal(timingText({ ...base, timing: { current: timing } }, now, 7), '', 'no room, no line');
  assert.equal(timingText({ ...base, current: { ...base.current, stage: null }, timing: { current: timing } }, now, 100), '', 'resting at A');
  assert.deepEqual([fmtDuration(0), fmtDuration(59_400), fmtDuration(60_000), fmtDuration(5 * MIN + 29 * SEC), fmtDuration(3_600_000 + 5 * MIN)], ['0秒', '59秒', '1分', '5分', '1时05分']);
});

// The companion's pump measures its relay calls and the admission challenge rounds, and leaves the record before it answers.
test('companion pump: relay calls and challenge rounds are recorded before the answer; a pump that cannot write the record still answers', async t => {
  const { COMPANION_CONFIG_CONTRACT, Companion, validateCompanionConfig } = await import('../src/companion.mjs');
  const { TEST_NODE, TEST_NODE_SHA } = await import('./helpers.mjs');
  const BS = String.fromCharCode(92), win = (...p) => p.join(BS);
  const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: win('C:', 'Windows', 'System32', 'wsl.exe'),
    powershellExe: win('C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), relayScript: win('C:', 'ProgramData', 'CluedIndependentCI', 'resident', 'source', 'x', 'relay-public.ps1'),
    bundleScript: win('C:', 'ProgramData', 'CluedIndependentCI', 'resident', 'source', 'x', 'build-bundle.ps1'), windowsSpool: win('C:', 'ProgramData', 'CluedIndependentCI', 'formal-spool'),
    distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
  const OK = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
  const NONE = { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
  const cost = { SendIssue: 1500, ReceiveChallenge: 700, SendResponse: 900, ReceiveResult: 600 };
  const pump = async (failWrite = false) => {
    let now = T0, answered = false;
    const box = await Mailbox.open(await tempRoot(t), () => now);
    if (failWrite) box.writeTiming = async () => { throw new Error('disk'); };
    const run = async a => {
      const m = a.includes('-Mode') ? a[a.indexOf('-Mode') + 1] : null;
      if (m) {
        if (m === 'ReceiveChallenge' && answered) return NONE;
        if (m === 'ReceiveResult' && !answered) return NONE;
        if (!(m in cost)) return NONE;
        now += cost[m];
        if (m === 'SendResponse') answered = true;
        return OK;
      }
      if (a.some(x => x.startsWith('--property=ActiveState'))) return { code: 0, stdout: 'ActiveState=active\nInvocationID=ab\nExecMainStartTimestampMonotonic=5\n' };
      if (a.includes('/usr/bin/ls')) return { code: 0, stdout: answered ? 'result.ready.json\n' : 'challenge-01.ready.json\n' };
      if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
      return { code: 0, stdout: '' };
    };
    // the unit reads inactive once the result is relayed, so the pump ends
    const c = new Companion({ cfg, mailbox: box, run: async a => { const r = await run(a); return a.some(x => x.startsWith('--property=ActiveState')) && answered ? { code: 0, stdout: 'ActiveState=inactive\nInvocationID=ab\nExecMainStartTimestampMonotonic=5\n' } : r; },
      fileExists: async () => true, sleep: async ms => { now += ms; }, clock: () => now });
    const req = await box.send('relay-stage', { batchId: '0123456789abcdef-0123456789ab', stage: 2, jobId: 'e'.repeat(64) }, 45 * 60_000);
    await c.step();
    return { answer: await box.poll(req), timing: await box.timing(req) };
  };
  const good = await pump();
  assert.equal(good.answer.ok, true);
  assert.deepEqual(good.timing, rt(4, 3700, 1500, [1600]), 'issue, challenge, response, result; one round = challenge taken -> response sent');
  const lost = await pump(true);
  assert.equal(lost.answer.ok, true, 'the answer does not depend on the record');
  assert.equal(lost.timing, null);
});
