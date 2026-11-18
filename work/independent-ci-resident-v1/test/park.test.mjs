// Parking (resident quota redesign phase 2, step 2: design v0.5 §4.3, §4.8, §4.9; Owner decision e1e19e2e item 4):
// the close archive before stage 8, stage 8 as tries at parking point B, the back-off, the end when main moved or the
// tries ran out, the slots, crashes, the Owner abort and drain, nudges, the stage-8 budget and the breaker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor, PARK_HEAD_RETRY_MS, PARK_HEAD_STREAK_MS, STAGE8_NOT_READY_CODES, STAGE8_TRANSIENT_MAX_TRIES, STAGE8_TRANSIENT_PARK_CODES, STAGE8_TRANSIENT_RETRY_MS } from '../src/executor.mjs';
import { STAGE8_NOT_READY_REASONS, STAGE8_FINAL_REASONS } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';
import { outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { POSITIONS, closedBreaker } from '../src/breaker.mjs';
import { describe as prPage, events as notificationEvents } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { Ledger, batchKey, headKey } from '../src/ledger.mjs';
import { Poller } from '../src/poller.mjs';
import { drainRequest, abortRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { restAnswer } from './gh-rest-stub.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, holdAtA, rawPolicy, triggerBytes } from './helpers.mjs';

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
function stage8Engine(answers, only = null, script = {}) {
  const engine = fakeEngine(script);
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

test('the tries are bounded: the last not-ready answer leaves the batch asleep and neutral', async t => {
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
  const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: 2 } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  f.advance(10 * MIN);
  const end = await f.exec.tick();
  assert.deepEqual([end.state, end.reason, end.until], ['PARKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', null]);
  assert.equal(f.queue.breaker?.state ?? 'closed', 'closed', 'neutral');
});

test('failed required checks sleep after the retry budget and a check change resumes the same batch', async t => {
  const engine = stage8Engine(Array.from({ length: 13 }, () => notReady('REQUIRED_CHECK_FAILED')), KEY);
  const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: 13 } }) });
  await f.drop(triggerBytes());
  for (let i = 0; i < 13; i++) {
    const result = await f.exec.tick();
    assert.equal(result.state, 'PARKED');
    if (i < 12) f.advance(result.until - f.clock());
  }
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
  assert.equal((await f.exec.parkedCounts()).outside, 0);
  let conclusion = 'failure', events = 0;
  const poller = new Poller({ repo: subject().repo, ghExe: 'gh', clock: f.clock,
    run: async argv => restAnswer(argv, { total_count: 1, check_runs: [{ id: 1, name: 'migration-verify', status: 'completed', conclusion }] }),
    writeTrigger: async trigger => { events++; await f.drop(Buffer.from(JSON.stringify(trigger))); } });
  poller.lastPass = { mainSha: BASE, pulls: [{ pr: 884, headSha: HEAD }] };
  const pending = f.queue.view(f.clock(), { etaBatchMs: 20 * MIN });
  await poller.parkedPass(pending);
  assert.equal(events, 0, 'the unchanged failed check is a baseline, not a wake');
  f.advance(180 * MIN);
  await f.exec.tick();
  assert.equal(stagesRun(engine).filter(stage => stage === 8).length, 13);
  conclusion = 'success';
  await poller.parkedPass(pending);
  await poller.parkedPass(pending);
  assert.equal(events, 1);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, ...Array(14).fill(8)]);
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
  await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
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
  const overEngine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
  const derive = overEngine.derive;
  overEngine.derive = async (...args) => ({ ...await derive(...args), ciSourceManifestSha256: policy.ciSourceManifestSha256 });
  const policy = rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 0 } });
  const g = await executorFixture(t, { engine: overEngine,
    companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: HEAD }) }),
    policy });
  await g.drop(triggerBytes());
  const over = await g.exec.tick();
  assert.deepEqual([over.state, over.failureCode], ['FAILED_CLEAN', 'PARKED_OVER_CAPACITY']);
  await g.exec.tick();
  assert.equal(stagesRun(g.engine).length, 8, 'the same head observes its release back-off');
  g.advance(10 * MIN);
  assert.equal((await g.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(g.engine), [1, 2, 3, 4, 5, 6, 7, 8, 8]);
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

test('#1144: 100 historical retries across PRs cannot block the front PR after restart', async t => {
  const f = await executorFixture(t, { now: Date.parse('2026-11-17T01:23:32.000Z'),
    engine: stage8Engine([notReady('TRAIN_SINGLE_GREEN_NOT_PROVEN', { entered: true, state: 'head', position: 1 })]) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  // Report: #1142 35, #1143 36, other PRs 24, the current front 5 = 100.
  for (const [pr, retries] of [[1142, 35], [1143, 36], [1130, 24], [884, 5]]) {
    const s = subject({ pr, headSha: pr.toString(16).padStart(40, '0') }), key = batchKey(s);
    await f.ledger.reserve(key, s);
    await f.ledger.markStarted(key, { batchId: 'history' });
    await f.ledger.beginWait(key, { t0: f.clock(), batch: { batchId: 'history' } });
    await f.ledger.writePlanIntent(key, {});
    await f.ledger.writePlan(key, { relayed: [] });
    await f.ledger.park(key, { batch: { batchId: 'history' } });
    for (let i = 0; i <= retries; i++) {
      const n = await f.ledger.beginTry(key, { batchId: 'history' });
      await f.ledger.endTry(key, n, { code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', nextAt: isoAt(f.clock()), position: 1 });
    }
    await f.ledger.terminal(key, 'COMPLETED', {});
  }
  assert.equal((await f.ledger.usage(f.clock() - 86_400_000)).stage8Retries, 100);
  assert.equal((await f.ledger.usage(f.clock() - 86_400_000, { stage8Pr: 884 })).stage8Retries, 5);
  f.advance(MIN);
  const restarted = new ResidentExecutor(f.ports);
  assert.equal((await restarted.tick()).state, 'COMPLETED', 'the front still has 95 of its own retries');
});

const isoAt = at => new Date(at).toISOString();

// scope-isolation: park.stage8RetriesPer24h
test('#1144: an exhausted PR does not block another due parked PR; its own limit still holds', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]),
    policy: rawPolicy({ park: { ...rawPolicy().park, stage8RetriesPer24h: 1 } }) });
  await f.drop(triggerBytes()); assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) })); assert.equal((await f.exec.tick()).state, 'PARKED');
  const n = await f.ledger.beginTry(KEY, { batchId: 'historical-retry' });
  await f.ledger.endTry(KEY, n, { code: 'RESIDENT_MERGE_QUEUE_NOT_JOINED', nextAt: isoAt(f.clock()), position: null });
  f.advance(10 * MIN);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'skip the exhausted first PR and try the second');
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'the exhausted PR still waits');
  assert.equal((await f.ledger.state(batchKey(subject({ pr: 900, headSha: H(4) })))).outcome, 'COMPLETED');
  const budget = f.queue.notices.find(n => n.code === 'STAGE8_RETRY_BUDGET_EXHAUSTED' && n.pr === 884)?.budget;
  assert.deepEqual(budget, { policyKey: 'park.stage8RetriesPer24h', scope: 'pr', used: 1, limit: 1, resetsAt: f.clock() - 10 * MIN + 24 * 60 * MIN });
  const notice = notificationEvents({ status: { pending: [], notices: f.queue.notices }, now: f.clock() }).find(n => /第 8 段重试额度/.test(n.title));
  assert.match(notice.title, /PR #884/);
});

test('an install authority ending soon closes a parked batch neutrally instead of a HALT', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]), policy: rawPolicy({ validUntil: '2026-10-21T02:00:00Z' }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  // 11.5 hours later (inside park.maxMs) the install authority ends within one batch budget
  f.advance(Date.parse('2026-10-20T23:30:00Z') - f.clock());
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
  const f = await executorFixture(t);
  const atA = holdAtA(f.exec);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(101 * MIN);
  atA.release();
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PARKED_BUNDLE_TOO_OLD']);
  assert.deepEqual(stagesRun(f.engine), [1], 'no workspace preparation or local Linux scan');
  assert.ok(!f.companion.calls.some(c => c[0] === 'wsprep'));
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  assert.equal(f.queue.row(884).state, 'STOPPED');
});

test('a newer commit of a parked PR ends the parked batch once a live read confirms it; the newer commit runs next', async t => {
  // a live read that still sees the parked head: the batch stays parked (the trigger only brought its next try forward)
  const g = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY),
    companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: HEAD }) }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'PARKED');
  await g.drop(triggerBytes({ headSha: H(7) }));
  assert.deepEqual([(await g.exec.tick()).state, g.queue.row(884).state, (await g.ledger.state(KEY)).state], ['PARKED', 'PARKED', 'STARTED']);
  // a live read that confirms the push: ended at its safe point at once, published, then the newer commit runs
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY),
    companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: H(7) }) }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ headSha: H(7) }));
  const ended = await f.exec.tick();
  assert.deepEqual([ended.state, ended.failureCode, ended.safePoint], ['FAILED_CLEAN', 'SUPERSEDED_AT_SAFE_POINT', 'parked']);
  assert.equal((await f.ledger.state(KEY)).terminal.facts.stage, 8, 'stages 3, 5 and 7 published');
  assert.equal(await f.executedHeads.published(subject()), true);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(f.queue.row(884).current.headSha, H(7));
  assert.equal(f.queue.row(884).state, 'DONE');
});

// ---- the independent review of step 2 ----
const bodies = async (f, type) => {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
};
const UNCERTAIN = { ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, outcome: { status: 'UNCERTAIN', reason: 'x', sideEffects: 1, mayHavePublished: true, diagnostic: null, scheduling: null, safeToRerun: false } };
const K900 = batchKey(subject({ pr: 900, headSha: H(4) }));

test('review M1, m10: the drain keeps the Owner abort guards (another scene, drift, a failed recovery, a stale request)', async t => {
  // PR 884 parks; PR 900 then fails stage 3 uncertain: FAILED_UNKNOWN, HALT, its scene unarchived
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY);
  const at8 = engine.runStage;
  engine.runStage = async (batch, stage, o) => (batch.key === K900 && stage.number === 3 ? (engine.calls.push(['stage', 3]), UNCERTAIN) : at8(batch, stage, o));
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.ok((await f.ledger.unarchivedScenes()) > 0);
  f.advance(1);
  await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
  await f.exec.tick();
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_DRAIN_UNARCHIVED_SCENE_PRESENT']);
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'the parked batch is untouched; nothing was archived over the scene');
  assert.equal(engine.calls.filter(c => c[0] === 'archive-windows').length, 0);
  // drifted installed bytes
  const g = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'PARKED');
  const drifted = new ResidentExecutor({ ...g.ports, sourceIntegrity: async () => ({ ok: false }) });
  g.advance(1);
  await writeOwnerRequest(path.join(g.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, g.clock), g.clock);
  await drifted.tick();
  assert.deepEqual((await bodies(g, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_DRAIN_SOURCE_DRIFT']);
  assert.ok(Ledger.parkedAt(await g.ledger.state(KEY)));
  // a request written more than an hour before the service reads it
  const h = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
  await h.drop(triggerBytes());
  assert.equal((await h.exec.tick()).state, 'PARKED');
  const written = h.clock();
  h.advance(61 * MIN);
  await writeOwnerRequest(path.join(h.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, () => written), h.clock);
  await h.exec.tick();
  assert.ok((await bodies(h, 'owner-request-refused')).some(b => b.failureCode === 'OWNER_DRAIN_REQUEST_STALE'));
  // recovery failed this tick: refused too
  const k = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
  await k.drop(triggerBytes());
  assert.equal((await k.exec.tick()).state, 'PARKED');
  k.exec.recover = async () => { throw new Error('disk'); };
  k.advance(1);
  await writeOwnerRequest(path.join(k.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, k.clock), k.clock);
  await k.exec.tick();
  assert.ok((await bodies(k, 'owner-request-refused')).some(b => b.failureCode === 'OWNER_DRAIN_RECOVERY_UNCONFIRMED'));
});

test('review M1: the drain ends a batch waiting at parking point A (not published) the same way', async t => {
  const f = await executorFixture(t);
  holdAtA(f.exec);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(1);
  await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
  await f.exec.tick();
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode, s.terminal.facts.safePoint, s.abort.safePoint], ['FAILED_CLEAN', 'OWNER_ABORTED', 'waiting', 'waiting']);
  assert.equal(await f.executedHeads.published(subject()), false);
  assert.deepEqual((await bodies(f, 'owner-request')).map(b => [b.kind, b.remaining]), [['drain', 0]]);
});

test('review M2: a supersession at parking point B never closes a breaker a Linux place opened', async t => {
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY);
  const at8 = engine.runStage;
  const failing = new Set([batchKey(subject({ pr: 901, headSha: H(3) })), batchKey(subject({ pr: 902, headSha: H(6) })), batchKey(subject({ pr: 903, headSha: H(8) }))]);
  engine.runStage = async (batch, stage, o) => (failing.has(batch.key) && stage.number === 2 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN }) : at8(batch, stage, o));
  const f = await executorFixture(t, { engine, companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: pr === 884 ? H(7) : null }) }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  for (const [n, h] of [[1, 3], [2, 6], [3, 8]]) { await f.drop(triggerBytes({ pr: 900 + n, headSha: H(h) })); assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN'); }
  assert.equal(f.queue.breaker.state, 'open');
  await f.drop(triggerBytes({ headSha: H(7) }));
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'SUPERSEDED_AT_SAFE_POINT']);
  assert.equal(f.queue.breaker.state, 'open', 'the stage-8 place is Windows-only');
});

test('review m2: the Owner abort of a batch at B records safe point parked from its first record', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const latest = await f.ledger.latestRecord(KEY);
  await writeOwnerRequest(path.join(f.root, 'owner'), abortRequest({ batchKey: KEY, expectedLedgerEntrySha256: latest.sha256, reason: 'stuck', by: OWNER }), f.clock);
  await f.exec.tick();
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.abort.safePoint, s.terminal.facts.safePoint], ['parked', 'parked']);
  assert.deepEqual((await bodies(f, 'owner-abort-accepted')).map(b => b.safePoint), ['parked']);
});

test('review m3, m13, m8: the PR page never calls an untested commit tested, nor claims a queue place it does not know', async t => {
  // a newer commit of a parked PR, the live read unanswered: the batch stays at B, the newer commit is not shown parked
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ headSha: H(7) }));
  await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
  const row = f.queue.view(f.clock(), { etaBatchMs: 20 * MIN }).find(r => r.pr === 884);
  assert.deepEqual([row.headSha, row.state, row.queuePosition], [H(7), 'RUNNING', null]);
  const now = Date.parse('2026-10-22T09:00:00Z');
  const board = fn => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
  const pull = { pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 };
  const newer = prPage({ pull, status: board(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'RUNNING' }])), now });
  assert.ok(newer === null || (newer.weak === true && !/已测通/.test(newer.description)), JSON.stringify(newer));
  // a parked row without a place: waiting for the merge queue, no claim that it is in it
  const parked = prPage({ pull, status: board(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'PARKED', deferred: 'RESIDENT_QUEUE_HEAD_NOT_REACHED', nextAt: now + 10 * MIN }])), now });
  assert.match(parked.description, /^已测通：等合并队列/);
  const placed = prPage({ pull, status: board(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'PARKED', deferred: 'RESIDENT_QUEUE_HEAD_NOT_REACHED', queuePosition: 2, nextAt: now + 10 * MIN }])), now });
  assert.match(placed.description, /在合并队列第 2 位/);
  // the parking places full: no estimate that assumes a free executor
  const full = prPage({ pull, status: board(b => { b.update({ queue: { generation: 'abcdefabcdef', live: 2, depth: 100, parkingFull: true } }); b.setPending([{ pr: 6, headSha: H(6), baseSha: BASE }, { pr: 7, headSha: H(7), baseSha: BASE, eta: now + 20 * MIN }]); }), now });
  assert.equal(full.description, '排队第 2 位：停靠的批次已满，等它们结束');
});

test('park.maxMs puts a zero-effect parked batch to sleep even when no try is allowed', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, stage8RetriesPer24h: 0 } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  f.advance(23 * 60 * MIN);
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'no retry budget: it only rests');
  await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
  f.advance(60 * MIN);
  await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
  assert.equal(f.exec.parkedDueAt(await f.ledger.state(KEY)), Infinity);
  assert.equal(stagesRun(f.engine).filter(n => n === 8).length, 1, 'no stage ran to go to sleep');
  assert.equal(await f.ledger.halted(), null);
});

test('review m5: tries first in the merge queue come a minute apart for 15 minutes and never use up the try cap', async t => {
  const head = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 });
  const f = await executorFixture(t, { engine: stage8Engine(Array.from({ length: 40 }, () => head), KEY) });
  await f.drop(triggerBytes());
  let r = await f.exec.tick();
  const start = f.clock();
  let tries = 1;
  while (f.clock() - start < PARK_HEAD_STREAK_MS) {
    assert.equal(r.until - f.clock(), PARK_HEAD_RETRY_MS, `try ${tries}`);
    f.advance(PARK_HEAD_RETRY_MS);
    r = await f.exec.tick();
    tries += 1;
    assert.equal(r.state, 'PARKED', `try ${tries}`);
  }
  assert.ok(tries > rawPolicy().park.stage8MaxTries, 'more head tries than the cap, still parked');
  assert.ok(r.until - f.clock() > PARK_HEAD_RETRY_MS, 'after 15 minutes the back-off applies again');
  assert.equal((await f.ledger.usage(f.clock() - 24 * 60 * MIN)).stage8Retries, tries - 1, 'every try after the first is a stage-8 retry');
});

test('review m7: a re-read of a seen trigger nudges nothing; a new main tip nudges once', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const tries = async () => (await f.ledger.state(KEY)).tries.length;
  await f.drop(triggerBytes());   // the same trigger again: seen
  await f.exec.tick();
  assert.equal(await tries(), 1);
  // an Agent's trigger (no prUpdatedAt) names any base: no nudge
  await f.drop(triggerBytes({ pr: 902, headSha: H(8), baseSha: H(9) }));
  await f.exec.tick();
  assert.equal(await tries(), 1);
  // main moved: the poller's trigger of another PR carries the new tip
  await f.drop(triggerBytes({ pr: 900, headSha: H(4), baseSha: H(5), prUpdatedAt: '2026-10-20T11:00:00.000Z', contract: 'clued.independent-ci.resident-trigger/2' }));
  const moved = await f.exec.tick();
  assert.deepEqual([moved.state, await tries()], ['PARKED', 2]);
  // the same tip again later: no second nudge for it
  f.advance(6 * MIN);
  await f.drop(triggerBytes({ pr: 901, headSha: H(6), baseSha: H(5), prUpdatedAt: '2026-10-20T11:00:00.000Z', contract: 'clued.independent-ci.resident-trigger/2' }));
  await f.exec.tick();
  assert.equal(await tries(), 2);
});

test('review m9, m11, m12: no new batch while the outside bound is full or a trial rests at A; a breaker feed never ends a parked batch', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 1 } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.deepEqual([(await f.exec.tick()).reason, f.engine.calls.filter(c => c[0] === 'derive').length], ['PARKING_FULL', 1]);
  // a half-open breaker starts no trial while a batch rests at parking point A
  const g = await executorFixture(t);
  holdAtA(g.exec);
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  g.queue.breaker = { ...closedBreaker(), state: 'open', level: 0, openedAt: g.clock(), nextTrialAt: g.clock() - 1, failingPos: POSITIONS[2], failingWindowsOnly: false, exclude: [] };
  await g.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await g.exec.tick()).reason, 'BREAKER_TRIAL_PENDING');
  // a breaker feed that throws when the batch parks never turns the batch at rest into a crash
  const h = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
  h.exec.feedBreaker = async () => { throw new Error('receipt store full'); };
  await h.drop(triggerBytes());
  assert.equal((await h.exec.tick()).state, 'PARKED');
  assert.equal(await h.ledger.halted(), null);
});

// ---- the confirmatory re-review of step 2 ----
test('the 99th stage-8 try ends automatic retries; a later event still runs try 100', async t => {
  const head = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 });
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), head], KEY) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  // 97 more tries at the queue's first place (they do not count towards the cap), as the ledger records them
  for (let n = 2; n <= 98; n++) {
    await f.ledger.beginTry(KEY, { batchId: 'x' });
    await f.ledger.endTry(KEY, n, { code: 'RESIDENT_QUEUE_HEAD_NOT_REACHED', nextAt: new Date(f.clock()).toISOString(), position: 1, entered: true });
  }
  f.advance(10 * MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.reason, r.until], ['PARKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', null]);
  assert.equal((await f.ledger.state(KEY)).tries.length, 99);
  await f.exec.nudgeParked([{ t: { ...subject(), prUpdatedAt: null }, seen: false }], f.clock());
  assert.deepEqual([(await f.exec.tick()).state, (await f.ledger.state(KEY)).tries.length], ['COMPLETED', 100]);
  assert.equal(await f.ledger.halted(), null);
});

test('re-review m16: drifted bytes end a parked batch UNKNOWN with a HALT, never through the archive tools', async t => {
  for (const ending of ['supersede', 'authority']) {
    const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY);
    const f = await executorFixture(t, { engine, policy: rawPolicy(ending === 'authority' ? { validUntil: '2026-10-21T02:00:00Z' } : {}),
      companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: H(7) }) }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    const drifted = new ResidentExecutor({ ...f.ports, sourceIntegrity: async () => ({ ok: false }) });
    if (ending === 'supersede') await f.drop(triggerBytes({ headSha: H(7) }));
    if (ending === 'authority') f.advance(Date.parse('2026-10-20T23:30:00Z') - f.clock());
    const r = await drifted.tick();
    assert.equal(r.state, 'HALTED', ending);
    assert.equal((await f.ledger.halted()).value.code, 'RESIDENT_SOURCE_DRIFT', ending);
    assert.equal(engine.calls.filter(c => c[0] === 'archive-windows').length, 0, ending);
  }
});

test('re-review m8, N6, N9: parking full is on every status; the back-off after a head run; a drain stopped part-way says so', async t => {
  // parking full stays visible on a tick that ran a parked try (the executor state is PARKED then)
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY),
    policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 1 } }), status: new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  f.advance(10 * MIN);
  assert.equal((await f.exec.tick()).state, 'PARKED');
  assert.equal(parseStatus(Buffer.from(JSON.stringify(f.ports.status.snapshot()))).queue.parkingFull, true);
  // N6: after 15 minutes at the queue's first place the next try follows the counted tries (10 minutes), not 2 hours
  const head = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 });
  const g = await executorFixture(t, { engine: stage8Engine(Array.from({ length: 30 }, () => head), KEY) });
  await g.drop(triggerBytes());
  let r = await g.exec.tick();
  while (r.until - g.clock() === PARK_HEAD_RETRY_MS) { g.advance(PARK_HEAD_RETRY_MS); r = await g.exec.tick(); }
  assert.equal(r.until - g.clock(), 10 * MIN);
  // N9: the second entry's acceptance fails before anything was written: the first one stays ended and reported
  const h = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]) });
  await h.drop(triggerBytes());
  assert.equal((await h.exec.tick()).state, 'PARKED');
  await h.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await h.exec.tick()).state, 'PARKED');
  const begin = h.ledger.beginOwnerAbort.bind(h.ledger);
  let calls = 0;
  h.ledger.beginOwnerAbort = async (...a) => { if (++calls === 2) throw Object.assign(new Error('disk'), { code: 'LEDGER_WRITE_FAILED' }); return begin(...a); };
  h.advance(1);
  await writeOwnerRequest(path.join(h.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, h.clock), h.clock);
  await h.exec.tick();
  const done = (await bodies(h, 'owner-request')).find(b => b.kind === 'drain');
  assert.deepEqual([done.ended.length, done.remaining, typeof done.stoppedBy], [1, 1, 'string']);
  assert.equal((await bodies(h, 'owner-request-refused')).length, 0);
});

// ---- the final check of step 2 (test gaps n1, n2) ----
test('final check n1: drifted bytes at an expiring authority end a batch waiting at A with a HALT, no archive', async t => {
  const f = await executorFixture(t);
  holdAtA(f.exec);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  const later = new ResidentExecutor({ ...f.ports, policy: validatePolicy(rawPolicy({ validUntil: new Date(f.clock() + 60_000).toISOString() })),
    sourceIntegrity: async () => ({ ok: false }) });
  const r = await later.tick();
  assert.equal(r.state, 'HALTED');
  assert.equal((await f.ledger.halted()).value.code, 'RESIDENT_SOURCE_DRIFT');
  assert.equal(f.engine.calls.filter(c => c[0] === 'archive-windows').length, 0);
});

test('final check n2: alternating main tips nudge once each, not every 5 minutes', async t => {
  const answers = Array.from({ length: 6 }, () => notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'));
  const f = await executorFixture(t, { engine: stage8Engine(answers, KEY) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const tries = async () => (await f.ledger.state(KEY)).tries.length;
  const poller = (pr, base) => triggerBytes({ contract: 'clued.independent-ci.resident-trigger/2', pr, headSha: H(pr % 10 === 0 ? 3 : pr % 10), baseSha: base, prUpdatedAt: '2026-10-20T11:00:00.000Z' });
  const seen = [];
  for (const [i, base] of [H(5), H(6), H(5), H(6)].entries()) {
    f.advance(6 * MIN);
    await f.drop(poller(901 + i, base));
    await f.exec.tick();
    seen.push(await tries());
  }
  // X and Y nudge once each (tries 2 and 3); X and Y again nudge nothing (no try is due by its back-off yet)
  assert.deepEqual(seen, [2, 3, 3, 3]);
});

// ---- Task 867250db: stage 10 reads the merge queue's head; a batch parked for that PR is tried at once ----

const shadowPolicy = () => rawPolicy({ train: { enabled: 'shadow', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200 } });
// Stage 10 facts whose merge-queue head (holders[0]) is `front`.
const trainWithFront = front => () => ({ ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
  train: { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: '2026-10-23T05:00:00.000Z', onDuty: true, mainSha: null, rules: null,
    front: front ? { claimId: 'c', ...front } : null, wouldDo: front ? 'FRONT_TEST_MERGE_NOT_READY' : 'NO_FRONT', wouldRevoke: [], wouldRevokeCount: 0 } });
const hintFixture = async (t, front) => {
  const answers = [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 })];
  const f = await executorFixture(t, { policy: shadowPolicy(), engine: stage8Engine(answers, KEY, { train: trainWithFront(front) }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  return { f, tries: async () => (await f.ledger.state(KEY)).tries.length };
};

test('867250db: stage 10 sees the parked PR at the merge queue head: its stage-8 try is due now, not after the 10-minute back-off', async t => {
  const { f, tries } = await hintFixture(t, { pr: 884, headSha: HEAD });
  f.advance(2 * MIN);
  assert.equal((await f.exec.tick()).state, 'IDLE', 'this tick runs stage 10 (the batch itself rests)');
  assert.equal(f.engine.calls.filter(c => c[0] === 'stage' && c[1] === 10).length, 1);
  assert.equal(await tries(), 1);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.position, await tries()], ['PARKED', 1, 2], 'tried two minutes after the first try; the claim is first: the one-minute cadence follows');
  assert.equal(r.until - f.clock(), PARK_HEAD_RETRY_MS);
});

test('867250db: no hint for another PR, another head or an empty queue: the back-off stands', async t => {
  for (const front of [null, { pr: 900, headSha: HEAD }, { pr: 884, headSha: H(7) }, { pr: 884, headSha: null }]) {
    const { f, tries } = await hintFixture(t, front);
    f.advance(2 * MIN);
    await f.exec.tick();
    await f.exec.tick();
    assert.equal(await tries(), 1, JSON.stringify(front));
    f.advance(8 * MIN);
    await f.exec.tick();
    assert.equal(await tries(), 2, `${JSON.stringify(front)}: its 10-minute back-off`);
  }
});

test('867250db: no tight loop: one hint never makes a try less than PARK_HEAD_RETRY_MS after the last try ended', async t => {
  const { f, tries } = await hintFixture(t, { pr: 884, headSha: HEAD });
  f.advance(10_000);
  await f.exec.tick(); // stage 10 hints 10 seconds after the first try
  await f.exec.tick();
  await f.exec.tick();
  assert.equal(await tries(), 1, 'not yet');
  f.advance(PARK_HEAD_RETRY_MS - 10_000 - 1);
  await f.exec.tick();
  assert.equal(await tries(), 1, 'one millisecond short');
  f.advance(1);
  await f.exec.tick();
  assert.equal(await tries(), 2);
  // the hint is spent by the try: another stage 10 run is 10 minutes away, so nothing else is due before the claim's minute cadence
  assert.equal((await f.ledger.state(KEY)).tries[1].ended.position, 1);
});

test('final check n6: a later entry failing after its acceptance stops the drain with what it ended, then HALTs', async t => {
  // the Owner abort's own path fails on the second entry (accepted, not concluded), or so does its UNKNOWN ending
  for (const where of ['owner-abort', 'unknown']) {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    assert.equal((await f.exec.tick()).state, 'PARKED');
    const disk = () => Object.assign(new Error('disk'), { code: 'LEDGER_WRITE_FAILED' });
    let calls = 0;
    if (where === 'owner-abort') {
      const ownerAbort = f.exec.ownerAbort.bind(f.exec);
      f.exec.ownerAbort = async (...a) => { if (++calls === 2) throw disk(); return ownerAbort(...a); };
    } else {
      const accept = f.exec.acceptAbort.bind(f.exec);
      f.exec.acceptAbort = async (...a) => { const r = await accept(...a); if (++calls === 2) throw disk(); return r; };
      f.exec.unknown = async () => { throw disk(); };
    }
    f.advance(1);
    await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
    assert.equal((await f.exec.tick()).state, 'HALTED', where);
    const done = (await bodies(f, 'owner-request')).find(b => b.kind === 'drain');
    assert.ok(done, where);
    assert.deepEqual([done.ended.length, done.ended[0].failureCode, done.remaining, done.stoppedBy, done.unconfirmed.length], [1, 'OWNER_ABORTED', 1, 'RESIDENT_EXECUTOR_EXCEPTION', 64], where);
    assert.equal((await bodies(f, 'owner-request-refused')).length, 0, where);
    assert.equal((await f.ledger.halted()).value.code, 'OWNER_ABORT_UNCONFIRMED', where);
    assert.deepEqual((await f.ledger.crashed()).map(e => e.key), [done.unconfirmed], where);
  }
});

// ---- phase 2, step 3a (design v0.5 §5.3 rules 3, 5, 7): stage 8's live branch rules, test merge and green ledger ----
test('step 3a: the stage-8 code lists of the publisher, the stage fact and the executor agree (review N1)', () => {
  assert.deepEqual([...STAGE8_NOT_READY_CODES].sort(), [...STAGE8_NOT_READY_REASONS].sort());
  // every not-ready answer and every final answer of stage 8 reaches the resident under its own code
  for (const code of [...STAGE8_NOT_READY_REASONS, ...STAGE8_FINAL_REASONS])
    assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false }, 8), code, code);
  assert.ok(STAGE8_FINAL_REASONS.every(code => !STAGE8_NOT_READY_CODES.includes(code)));
});

test('step 3a: the new not-ready answers park the batch and are tried again; the rules ones tell the Owner once a day', async t => {
  for (const code of ['REQUIRED_CHECK_FAILED', 'REQUIRED_CHECKS_UNREADABLE', 'RULESET_UNREADABLE', 'STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_NOT_READY', 'GREEN_LEDGER_UNAVAILABLE', 'TRAIN_MODE_UNREADABLE']) {
    const f = await executorFixture(t, { engine: stage8Engine([notReady(code), notReady(code)], KEY) });
    await f.drop(triggerBytes());
    const first = await f.exec.tick();
    assert.deepEqual([first.state, first.reason, first.tries], ['PARKED', code, 1], code);
    assert.deepEqual([f.queue.row(884).state, f.queue.row(884).reason], ['PARKED', code], code);
    const notices = f.queue.notices.filter(n => n.kind === 'stage8-rules');
    const toldOwner = ['STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY'].includes(code);
    assert.equal(notices.length, toldOwner ? 1 : 0, code);
    f.advance(10 * MIN);
    const second = await f.exec.tick();
    assert.deepEqual([second.state, second.tries], ['PARKED', 2], code);
    assert.equal(f.queue.notices.filter(n => n.kind === 'stage8-rules').length, toldOwner ? 1 : 0, `${code}: the same notice key the same day`);
    f.advance(20 * MIN);
    assert.equal((await f.exec.tick()).state, 'COMPLETED', code);
  }
});

test('step 3a: a test merge that is not the tested tree ends the parked batch neutrally, never an attempt 2, and tells the Owner', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([notReady('TRAIN_TEST_MERGE_TREE_DIFFERS')], KEY) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'TRAIN_TEST_MERGE_TREE_DIFFERS']);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  assert.equal(f.queue.breaker?.state ?? 'closed', 'closed');
  assert.equal(f.queue.row(884).state, 'STOPPED');
  const n = f.queue.notices.filter(x => x.kind === 'stage8-rules');
  assert.deepEqual(n.map(x => [x.code, x.pr, x.headSha]), [['TRAIN_TEST_MERGE_TREE_DIFFERS', 884, HEAD]]);
  // the stage-fact catalogue and the failure table agree it is a clean final code of the head
  assert.equal(await f.executedHeads.published(subject()), true, 'its roles were published before stage 8');
});

test('step 3a: the PR page and the notifications say why stage 8 writes no green', async () => {
  const now = Date.parse('2026-10-23T09:00:00Z');
  const board = fn => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
  const pull = { pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 };
  const parkedAs = code => prPage({ pull, status: board(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'PARKED', deferred: code, nextAt: now + 10 * MIN }])), now });
  assert.match(parkedAs('STRICT_OFF_WITHOUT_TRAIN').description, /^已测通：main 的 strict 已关而列车未开.*再查第 8 段$/);
  assert.match(parkedAs('RULESET_UNREADABLE').description, /^已测通：读不到 main 的规则/);
  assert.match(parkedAs('TRAIN_TEST_MERGE_NOT_READY').description, /^已测通：等 GitHub 算好试合并/);
  assert.match(parkedAs('MERGE_METHODS_NOT_MERGE_ONLY').description, /合并方式不只有 merge/);
  assert.match(parkedAs('GREEN_LEDGER_UNAVAILABLE').description, /绿色台账/);
  assert.match(parkedAs('TRAIN_MODE_UNREADABLE').description, /^已测通：读不到本机的列车模式/);
  const ended = prPage({ pull, status: board(b => b.outcome({ pr: 7, headSha: H(7), outcome: 'FAILED_CLEAN', code: 'TRAIN_TEST_MERGE_TREE_DIFFERS', klass: 'clean-final', retry: 'new-commit' })), now });
  assert.deepEqual([ended.state, /请推新提交/.test(ended.description)], ['failure', true]);
  const told = notificationEvents({ status: board(b => b.update({ notices: [
    { key: 'stage8:STRICT_OFF_WITHOUT_TRAIN:2026-10-23', kind: 'stage8-rules', pr: null, headSha: null, code: 'STRICT_OFF_WITHOUT_TRAIN' },
    { key: `stage8:TRAIN_TEST_MERGE_TREE_DIFFERS:7:${H(7)}`, kind: 'stage8-rules', pr: 7, headSha: H(7), code: 'TRAIN_TEST_MERGE_TREE_DIFFERS' }] })), now });
  assert.deepEqual(told.map(e => e.title), ['main 的 strict 已关，第 8 段停发合并位', 'PR #7 的试合并与测过的树不同']);
  assert.match(told[1].body, new RegExp(H(7).slice(0, 8)));
});

// ---- DESIGN §28 (design r3 4a, PR #930): a transient zero-effect stage-8 ending parks again, 3 times at most ----
// PR #930 (2026-10-28, batch 5bc215cb attempt 2): stages 1-7 passed, the first stage-8 try ended 35 s later BLOCKED
// full_admission_unavailable with zero side effects and no merge-queue facts; it was burned. Now it parks a minute.
const unavailable = (code = 'NATIVE_ADMISSION_UNAVAILABLE', o = {}) => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: 'full_admission_unavailable', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false, ...o } });

test('4a: zero-effect NATIVE_ADMISSION_UNAVAILABLE parks at B after 1, 3 and 10 minutes; the 4th one burns the head as before', async t => {
  assert.deepEqual([...STAGE8_TRANSIENT_PARK_CODES], ['NATIVE_ADMISSION_UNAVAILABLE', 'GITHUB_TRANSIENT_UNAVAILABLE']);
  assert.deepEqual([STAGE8_TRANSIENT_MAX_TRIES, ...STAGE8_TRANSIENT_RETRY_MS], [3, MIN, 3 * MIN, 10 * MIN]);
  const f = await executorFixture(t, { engine: stage8Engine([unavailable(), unavailable('GITHUB_TRANSIENT_UNAVAILABLE'), unavailable(), unavailable()], KEY) });
  await f.drop(triggerBytes());
  const gaps = [];
  let r = await f.exec.tick();
  for (const gap of STAGE8_TRANSIENT_RETRY_MS) {
    assert.equal(r.state, 'PARKED');
    gaps.push(r.until - f.clock());
    f.advance(gap - 1);
    assert.equal((await f.exec.tick()).state, 'IDLE', 'not before its own back-off');
    f.advance(1);
    r = await f.exec.tick();
  }
  assert.deepEqual(gaps, [MIN, 3 * MIN, 10 * MIN]);
  assert.deepEqual([r.state, r.failureCode, r.attempt2], ['FAILED_CLEAN', 'NATIVE_ADMISSION_UNAVAILABLE', undefined], 'the fourth: fail() as before, the head burned');
  const s = await f.ledger.state(KEY);
  assert.deepEqual(s.tries.map(x => [x.ended?.transient ?? false, x.ended?.position ?? null, x.ended?.assumedPosition ?? null]),
    [[true, null, 1], [true, null, 1], [true, null, 1], [false, null, null]], 'the true place (null) is recorded; the assumed one beside it');
  assert.equal((await receiptTypes(f)).filter(x => x === 'stage8-transient-parked').length, 3);
  assert.equal(f.queue.breaker?.state ?? 'closed', 'closed');
  assert.equal(await f.ledger.halted(), null);
});

test('4a: the #930 replay: unavailable once, parked a minute, then COMPLETED on the same batch', async t => {
  const engine = stage8Engine([unavailable()], KEY);
  const f = await executorFixture(t, { engine, status: new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') }) });
  await f.drop(triggerBytes());
  const parked = await f.exec.tick();
  assert.deepEqual([parked.state, parked.reason, parked.position, parked.until - f.clock()], ['PARKED', 'NATIVE_ADMISSION_UNAVAILABLE', 1, MIN]);
  assert.deepEqual([f.queue.row(884).state, f.queue.row(884).parked.position], ['PARKED', 1], 'the status shows the assumed place');
  f.advance(MIN);
  const done = await f.exec.tick();
  assert.deepEqual([done.state, done.tries], ['COMPLETED', 2]);
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8, 8], 'stages 1-7 ran once; no new head');
});

test('4a: a null place keeps the last try place (or 1), is never PARKED_OVER_CAPACITY, and counts by its assumed place (review r3 NIT 2)', async t => {
  // its last try was third in the queue: that place is assumed
  const third = notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 3 });
  const f = await executorFixture(t, { engine: stage8Engine([third, unavailable()], KEY) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).position, 3);
  f.advance(10 * MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.position], ['PARKED', 3]);
  const last = ResidentExecutor.lastTry(await f.ledger.state(KEY));
  assert.deepEqual([last.position, last.assumedPosition], [null, 3]);
  // with no room outside the queue's first two places at all, a transient park is exempt: never PARKED_OVER_CAPACITY
  const g = await executorFixture(t, { engine: stage8Engine([unavailable()], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 0 } }) });
  await g.drop(triggerBytes());
  assert.deepEqual([(await g.exec.tick()).state], ['PARKED']);
  // and it counts as inside (assumed place 1): another batch not ready outside the first places is not pushed over the bound
  const e = stage8Engine([unavailable()], KEY);
  const base = e.runStage;
  e.runStage = async (b, s, o) => (s.number === 8 && b.key !== KEY ? (e.calls.push(['stage', 8]), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')) : base(b, s, o));
  const h = await executorFixture(t, { engine: e, policy: rawPolicy({ park: { ...rawPolicy().park, maxParkedOutsideTop2: 1 } }) });
  await h.drop(triggerBytes());
  assert.equal((await h.exec.tick()).state, 'PARKED');
  assert.deepEqual(await h.exec.parkedCounts(), { inside: 1, outside: 0 });
  await h.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  const other = await h.exec.tick();
  assert.deepEqual([other.state, other.reason], ['PARKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED'], 'parked, not PARKED_OVER_CAPACITY');
});

test('4a: side effects, a possible publication or UNCERTAIN never park; the try cap and park.maxMs still end it first', async t => {
  for (const o of [{ sideEffects: 1 }, { mayHavePublished: true }]) {
    const f = await executorFixture(t, { engine: stage8Engine([unavailable('NATIVE_ADMISSION_UNAVAILABLE', o)], KEY) });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.notEqual(r.state, 'PARKED', JSON.stringify(o));
  }
  const u = await executorFixture(t, { engine: stage8Engine([{ ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, outcome: { status: 'UNCERTAIN', reason: 'full_admission_unavailable', sideEffects: 1, mayHavePublished: true, diagnostic: null, scheduling: null, safeToRerun: false } }], KEY) });
  await u.drop(triggerBytes());
  assert.equal((await u.exec.tick()).state, 'HALTED');
  // the Windows half missing: no park
  const w = await executorFixture(t, { engine: stage8Engine([{ ...unavailable(), proof: { windowsTreeZero: false, serviceOriginalStopped: true } }], KEY) });
  await w.drop(triggerBytes());
  assert.notEqual((await w.exec.tick()).state, 'PARKED');
  // park.stage8MaxTries reached first
  const cap = await executorFixture(t, { engine: stage8Engine([unavailable(), unavailable()], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: 2 } }) });
  await cap.drop(triggerBytes());
  assert.equal((await cap.exec.tick()).state, 'PARKED');
  cap.advance(MIN);
  assert.deepEqual([(await cap.exec.tick()).failureCode], ['NATIVE_ADMISSION_UNAVAILABLE']);
  // park.maxMs reached first: the batch ends without another try
  const old = await executorFixture(t, { engine: stage8Engine([unavailable(), unavailable()], KEY), policy: rawPolicy({ park: { ...rawPolicy().park, maxMs: 60 * MIN } }) });
  await old.drop(triggerBytes());
  assert.equal((await old.exec.tick()).state, 'PARKED');
  old.advance(60 * MIN);
  const end = await old.exec.tick();
  assert.deepEqual([end.state, end.failureCode], ['FAILED_CLEAN', 'NATIVE_ADMISSION_UNAVAILABLE']);
  assert.equal(stagesRun(old.engine).filter(n => n === 8).length, 1);
});

test('4a: the next try finds an unsettled journal entry (RECONCILIATION_REQUIRED): HALT; a changed claim: BATCH_CLAIM_CHANGED', async t => {
  const f = await executorFixture(t, { engine: stage8Engine([unavailable(), { ok: false, code: 'RECONCILIATION_REQUIRED', proof: WINDOWS_CLEAN,
    outcome: { status: 'RECONCILIATION_REQUIRED', reason: 'journal_unsettled', sideEffects: 0, mayHavePublished: true, diagnostic: null, scheduling: null, safeToRerun: false } }], KEY) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, (await f.ledger.halted()).value.code], ['HALTED', 'RECONCILIATION_REQUIRED']);
  const g = await executorFixture(t, { engine: stage8Engine([unavailable(), { ok: false, code: 'BATCH_CLAIM_CHANGED', proof: WINDOWS_CLEAN,
    outcome: { status: 'BLOCKED', reason: 'batch_claim_changed', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false } }], KEY) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'PARKED');
  g.advance(MIN);
  const c = await g.exec.tick();
  assert.deepEqual([c.state, c.failureCode, c.attempt2], ['FAILED_CLEAN', 'BATCH_CLAIM_CHANGED', undefined]);
});

// Generation 12, review round 28: the green ledger's not-ready answer of a queue head keeps the queue place (publisher.mjs), so the
// head is tried again in 60 s and the try is not counted, as in generation 11.
test('review round 28: GREEN_LEDGER_UNAVAILABLE at the queue head parks for the 60-second head retry, uncounted', async t => {
  const { PARK_HEAD_RETRY_MS: HEAD_MS } = await import('../src/executor.mjs');
  const helpers = await import('./helpers.mjs');
  const answer = { ok: false, code: 'GREEN_LEDGER_UNAVAILABLE', proof: helpers.WINDOWS_CLEAN, brokerNoLaunch: false,
    outcome: { status: 'BLOCKED', reason: 'GREEN_LEDGER_UNAVAILABLE', sideEffects: 0, mayHavePublished: false, diagnostic: null,
      scheduling: { ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: null }, safeToRerun: false } };
  const engine = helpers.fakeEngine({});
  const base = engine.runStage;
  let i = 0;
  engine.runStage = async (b, s, o) => (s.number === 8 && i++ === 0 ? answer : base(b, s, o));
  const f = await helpers.executorFixture(t, { engine });
  await f.drop(helpers.triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'PARKED');
  assert.equal(r.until - f.clock(), HEAD_MS);
  const [entry] = await f.ledger.parkedEntries();
  assert.equal(ResidentExecutor.lastTry(entry).position, 1);
});
