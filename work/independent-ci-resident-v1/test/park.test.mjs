// Parking (resident quota redesign phase 2, step 2: design v0.5 §4.3, §4.8, §4.9; Owner decision e1e19e2e item 4):
// the close archive before stage 8, stage 8 as tries at parking point B, the back-off, the end when main moved or the
// tries ran out, the slots, crashes, the Owner abort and drain, nudges, the stage-8 budget and the breaker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor, PARK_HEAD_RETRY_MS } from '../src/executor.mjs';
import { Ledger, batchKey, headKey } from '../src/ledger.mjs';
import { drainRequest, abortRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, HEAD, RELAY_ON, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const OWNER = 'S-1-5-21-1-2-3-1001';
const H = n => String(n).repeat(40).slice(0, 40);
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d+-|\.json$/g, ''));
// Stage 8 not ready, as the Source reports it: BLOCKED, zero side effects, the scheduling facts.
const notReady = (code, mergeQueue = { entered: false, state: null, position: null }) => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue }, safeToRerun: false } });
// An engine whose stage 8 answers from a list (then success); every other stage succeeds. With `only` (a batch key) the
// list answers that batch alone.
function stage8Engine(answers, only = null) {
  const engine = fakeEngine();
  const base = engine.runStage;
  let i = 0;
  engine.runStage = async (batch, stage, o) => (stage.number === 8 && i < answers.length && (only === null || batch.key === only)
    ? (engine.calls.push(['stage', 8]), answers[i++]) : base(batch, stage, o));
  return engine;
}

test('stage 8 not ready parks the batch at B after the close archive; tries back off 10, 20 minutes, then it completes', async t => {
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 3 })], KEY);
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.deepEqual([first.state, first.reason, first.tries], ['PARKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 1]);
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  const closeAt = engine.calls.findIndex(c => c[0] === 'close'), stage8At = engine.calls.findIndex(c => c[0] === 'stage' && c[1] === 8);
  assert.ok(closeAt >= 0 && closeAt < stage8At, 'the close archive on both hosts comes before stage 8 (the Linux zone ended)');
  const s = await f.ledger.state(KEY);
  assert.ok(Ledger.parkedAt(s));
  assert.deepEqual(s.tries.map(x => [x.n, x.ended.code]), [[1, 'RESIDENT_MERGE_QUEUE_NOT_JOINED']]);
  assert.equal(await f.executedHeads.published(subject()), true, 'recorded before stage 8 (stages 3, 5, 7 published)');
  assert.deepEqual([f.queue.row(884).state, f.queue.row(884).reason], ['PARKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED']);
  // the executor is not held: another PR runs meanwhile
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  f.advance(10 * MIN);
  const second = await f.exec.tick();
  assert.deepEqual([second.state, second.reason, second.position], ['PARKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 3]);
  f.advance(19 * MIN);
  assert.equal((await f.exec.tick()).state, 'IDLE', 'its 20-minute back-off');
  f.advance(MIN);
  const third = await f.exec.tick();
  assert.deepEqual([third.state, third.tries], ['COMPLETED', 3]);
  assert.equal((await f.ledger.state(KEY)).outcome, 'COMPLETED');
  assert.equal(f.queue.row(884).state, 'DONE');
  assert.equal((await receiptTypes(f)).filter(x => x === 'stage8-not-ready').length, 2);
});

test('a claim first in the merge queue is tried again in a minute; main moving ends the batch at once, never an attempt 2', async t => {
  const engine = stage8Engine([notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 }), notReady('RESIDENT_BASE_MOVED')]);
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.until - f.clock(), PARK_HEAD_RETRY_MS);
  f.advance(PARK_HEAD_RETRY_MS);
  const moved = await f.exec.tick();
  assert.deepEqual([moved.state, moved.failureCode], ['FAILED_CLEAN', 'RESIDENT_BASE_MOVED']);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  assert.equal(f.queue.row(884).state, 'STOPPED');
});

test('the tries and the time are bounded: the last not-ready answer ends the batch neutrally', async t => {
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
  const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: 2 } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  f.advance(10 * MIN);
  const end = await f.exec.tick();
  assert.deepEqual([end.state, end.failureCode], ['FAILED_CLEAN', 'RESIDENT_MERGE_QUEUE_NOT_JOINED']);
  assert.equal(f.queue.breaker?.state ?? 'closed', 'closed', 'neutral');
});

test('a stage-8 ending that may have written anything is no try: it is classified as before (UNKNOWN halts)', async t => {
  const engine = stage8Engine([{ ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, outcome: { status: 'UNCERTAIN', reason: 'x', sideEffects: 1, mayHavePublished: true, diagnostic: null, scheduling: null, safeToRerun: false } }]);
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_UNKNOWN');
});

test('a crash inside a stage-8 try is a crash scene; a crash at rest is not', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  // a restart at rest: the parked batch is resumed, nothing halts
  const fresh = new ResidentExecutor(f.ports);
  assert.equal((await fresh.tick()).state, 'IDLE');
  assert.equal(await f.ledger.halted(), null);
  // a try that began and never ended (the process died in stage 8)
  await f.ledger.beginTry(KEY, { batchId: 'x' });
  const again = new ResidentExecutor(f.ports);
  assert.equal((await again.tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_UNKNOWN');
});

test('the Owner aborts a parked batch at a tick start, and a drain ends every parked batch (before a reinstall)', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const latest = await f.ledger.latestRecord(KEY);
  assert.equal(latest.name, '72-tried-01.json');
  await writeOwnerRequest(path.join(f.root, 'owner'), abortRequest({ batchKey: KEY, expectedLedgerEntrySha256: latest.sha256, reason: 'stuck', by: OWNER }), f.clock);
  await f.exec.tick();
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode, s.terminal.facts.safePoint], ['FAILED_CLEAN', 'OWNER_ABORTED', 'parked']);
  // drain: the other parked batch ends too; nothing is open afterwards, so the uninstall is allowed
  f.advance(1);
  await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }), f.clock);
  await f.exec.tick();
  assert.equal((await f.ledger.open()).length, 0);
  assert.equal((await f.ledger.state(batchKey(subject({ pr: 900, headSha: H(4) })))).terminal.facts.failureCode, 'OWNER_ABORTED');
  assert.equal(await f.executedHeads.published(subject({ pr: 900, headSha: H(4) })), true);
});

test('the parking slots: at most maxParked batches rest in the first places; outside them the bound ends a batch', async t => {
  const second = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 2 });
  const f = await executorFixture(t, { engine: stage8Engine([second]), policy: rawPolicy({ park: { ...rawPolicy().park, maxParked: 1 } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.deepEqual(await f.exec.tick(), { state: 'DEFERRED', reason: 'PARKING_FULL' });
  const g = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]), policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 0 } }) });
  await g.drop(triggerBytes());
  const over = await g.exec.tick();
  assert.deepEqual([over.state, over.failureCode], ['FAILED_CLEAN', 'PARKED_OVER_CAPACITY']);
});

test('a nudge (main moved, or the parked PR changed) brings the next try forward; the stage-8 budget bounds the tries', async t => {
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_BASE_MOVED')]);
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4), baseSha: H(9) })); // the poller saw another main tip
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'RESIDENT_BASE_MOVED'], 'tried at once, not after 10 minutes');
  const g = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]),
    policy: rawPolicy({ park: { ...rawPolicy().park, stage8RetriesPer24h: 0 } }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'PARKED', 'the first try is no retry');
  g.advance(10 * MIN);
  assert.equal((await g.exec.tick()).state, 'IDLE');
  assert.ok(g.queue.notices.some(n => n.kind === 'stage8-budget'));
});

test('an install authority ending soon closes a parked batch neutrally instead of a HALT', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]), policy: rawPolicy({ validUntil: '2026-10-22T12:00:00Z' }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  f.advance(10 * MIN);
  // the same policy object, its validUntil now within a batch budget (2026-10-20 + 10 min + ~3 h < 2026-10-22? no): shift the clock
  f.advance(Date.parse('2026-10-22T09:00:00Z') - f.clock());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PARKED_AUTHORITY_EXPIRING']);
  assert.equal(await f.ledger.halted(), null);
});

test('the breaker: parking after stage 7 is a pass of every stage before it; a stage-8 try is Windows-only', async t => {
  const burn = { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN };
  const engine = fakeEngine();
  const base = engine.runStage;
  let failStage2 = 3, stage8 = [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')];
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 2 && failStage2 > 0) { failStage2 -= 1; engine.calls.push(['stage', 2]); return burn; }
    if (stage.number === 8 && stage8.length) { engine.calls.push(['stage', 8]); return stage8.shift(); }
    return base(batch, stage, o);
  };
  const f = await executorFixture(t, { engine });
  for (const n of [1, 2, 3, 4]) await f.drop(triggerBytes({ pr: n, headSha: H(n) }));
  for (let i = 0; i < 3; i++) await f.exec.tick();
  assert.equal(f.queue.breaker.state, 'open');
  f.advance(30 * MIN);
  const trial = await f.exec.tick();
  assert.equal(trial.state, 'PARKED', 'the trial got past stage 2 and parked');
  assert.equal(f.queue.breaker.state, 'closed', 'getting past stage 7 closes a stage-2 breaker');
});

test('parking point A: a batch resumed with a bundle older than 100 minutes ends before the workspace, nothing on Linux', async t => {
  const f = await executorFixture(t, { policy: rawPolicy({ relay: RELAY_ON }), companion: fakeCompanion({ hint: () => null }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  // other batches held the executor (or it was off): the wait expired long ago, the bundle is too old now
  f.advance(101 * MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PARKED_BUNDLE_TOO_OLD']);
  assert.deepEqual(stagesRun(f.engine), [1], 'no workspace preparation, no Linux stage');
  assert.equal(f.queue.row(884).state, 'STOPPED');
});
