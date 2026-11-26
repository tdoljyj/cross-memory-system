// The intake pause (resident primary/standby design v0.4 §5.4 step 1, §9 C6; Task 6444f88a; DESIGN §20): any Owner
// session may hold new batches for at most two hours; a batch in flight or at a parking point goes on; the latest word
// of each holder counts; the status shows it; it is neither PAUSE nor the drain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { INTAKE_PAUSE_CONTRACT, INTAKE_PAUSE_FILE, INTAKE_PAUSE_MAX_MS, INTAKE_RESUME_CONTRACT, INTAKE_HOLDS_MAX, IntakePause, UNREADABLE_HOLDER,
  intakePauseRequest, intakeResumeRequest, readIntakePause, validateIntakeRequest } from '../src/intake-pause.mjs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { INTAKE_PAUSE_UNCONFIRMED_MAX_MS, PAUSE_CONTRACT } from '../src/executor.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { describe as prPage } from '../src/pr-status.mjs';
import { batchKey } from '../src/ledger.mjs';
import { RunQueue } from '../src/queue.mjs';
import { until } from '../../../scripts/ci/test-clock-guard.mjs';
import { drainRequest, inspect, resumeRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, holdAtA, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';
import { TRAIN_CONTROL_TIMING, TRAIN_FAILURE, TRAIN_PROTOCOL_VERSION } from '../../actions-hosted-migration/independent-ci-v1/src/merge-train-v2-contract.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-23T05:00:00Z');
const SHA = n => String(n).repeat(64).slice(0, 64);
const iso = ms => new Date(ms).toISOString();

async function store(t, now = T0) {
  const dir = await tempRoot(t);
  let time = now;
  const clock = () => time;
  const p = await IntakePause.open(dir, clock);
  return { dir, p, clock, advance: ms => { time += ms; } };
}
// apply + save, as the executor does.
async function take(s, request, sha = SHA(1)) {
  const { data, result } = s.p.apply(request, sha);
  await s.p.save(data);
  return result;
}
const codeOf = fn => { try { fn(); return null; } catch (e) { return e.code; } };
const OWNER = 'S-1-5-21-1-2-3-1001';
const H = n => String(n).repeat(40).slice(0, 40);
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d+-|\.json$/g, ''));
const pick = r => [r.state, r.reason ?? null];
const json = v => Buffer.from(JSON.stringify(v));
function trainPolicy(protocolVersion) {
  const base = rawPolicy();
  return { ...base, contract: POLICY_CONTRACT_V8, train: { ...base.train, ...TRAIN_DEFAULTS, protocolVersion } };
}
// Stage 8 not ready (park.test.mjs): the batch rests at parking point B; then stage 8 succeeds.
const notReady = code => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null } }, safeToRerun: false } });
function stage8Engine(answers) {
  const engine = fakeEngine();
  const base = engine.runStage;
  let i = 0;
  engine.runStage = async (batch, stage, o) => (stage.number === 8 && i < answers.length ? (engine.calls.push(['stage', 8]), answers[i++]) : base(batch, stage, o));
  return engine;
}

test('train v2: persistent dual-active and delayed renewal are retired, while Owner pause, HALT and an old B batch survive', async t => {
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
  const a = await executorFixture(t, { engine, now: T0 });
  await a.drop(triggerBytes());
  assert.equal((await a.exec.tick()).state, 'PARKED');
  const aState = await IntakePause.open(a.ledger.root, a.clock);
  const b = await executorFixture(t, { now: T0 });
  const bState = await IntakePause.open(b.ledger.root, b.clock);
  for (const p of [aState, bState]) {
    await p.save(p.apply(intakePauseRequest({ holder: 'dual-active', reason: 'legacy lock' }, () => T0), SHA(1)).data);
    await p.save(p.apply(intakePauseRequest({ reason: 'Owner maintenance' }, () => T0), SHA(2)).data);
  }
  await b.ledger.halt('RECOVERY_UNCONFIRMED', {});
  // Service restarts with two independent journals from the previous package.
  const restartedA = await executorFixture(t, { engine, now: T0 + MIN, root: a.root });
  const restartedB = await executorFixture(t, { now: T0 + MIN, root: b.root });
  for (const f of [restartedA, restartedB]) {
    await f.drop(json(intakePauseRequest({ holder: 'dual-active', reason: 'late legacy renewal' }, f.clock)), 'requests');
    await f.exec.tick();
    const state = await readIntakePause(f.ledger.root, f.clock);
    assert.deepEqual(state.holds.map(h => h.holder), ['owner']);
    assert.ok((await receiptTypes(f)).includes('intake-pause-ended'));
  }
  assert.equal((await restartedB.ledger.halted()).value.code, 'RECOVERY_UNCONFIRMED');
  restartedA.advance(10 * MIN);
  assert.equal((await restartedA.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8, 8]);
  assert.equal((await restartedA.ledger.state(batchKey(subject()))).outcome, 'COMPLETED');
  assert.equal((await readIntakePause(restartedA.ledger.root, restartedA.clock)).view.holders[0].holder, 'owner');
});

test('train v2: durable first-queue handoff releases new and recovered ordinary batches without another stage 8', async t => {
  for (const recovered of [false, true]) {
    const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
    const f = await executorFixture(t, { engine, now: T0, policy: recovered ? rawPolicy() : trainPolicy(TRAIN_PROTOCOL_VERSION) });
    await f.drop(triggerBytes());
    if (recovered) assert.equal((await f.exec.tick()).state, 'PARKED');
    const requests = [];
    engine.handoffTrainWork = async ({ key, subject }) => {
      requests.push({ key, subject });
      return { protocol_version: TRAIN_PROTOCOL_VERSION, key, receiptId: 'b7abb84e-43e9-438b-ac4f-664f4b217b76' };
    };
    const running = recovered ? await executorFixture(t, { engine, now: T0 + MIN, root: f.root, policy: trainPolicy(TRAIN_PROTOCOL_VERSION) }) : f;
    assert.equal((await running.exec.tick()).state, 'COMPLETED');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].subject.headSha, HEAD);
    assert.deepEqual(stagesRun(engine), recovered ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 6, 7]);
    assert.equal((await running.ledger.state(batchKey(subject()))).outcome, 'COMPLETED');
    assert.ok((await receiptTypes(running)).includes('train-work-handed-off'));
  }
});

test('train v2: missing or wrong handoff keeps the archive, lets another PR run and never calls stage 8', async t => {
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
  const expected = batchKey(subject());
  let valid = false, originalLookups = 0;
  engine.handoffTrainWork = async ({ key, subject }) => {
    if (subject.pr === 884) {
      originalLookups += 1;
      if (!valid && originalLookups === 1) throw new Error('read unavailable');
      if (!valid) key = SHA(9);
    }
    return { protocol_version: TRAIN_PROTOCOL_VERSION, key, receiptId: 'b7abb84e-43e9-438b-ac4f-664f4b217b76' };
  };
  const f = await executorFixture(t, { engine, now: T0, policy: trainPolicy(TRAIN_PROTOCOL_VERSION) });
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['PARKED', TRAIN_FAILURE.EFFECT_UNKNOWN.resident]);
  assert.equal(f.queue.row(884).state, 'PARKED');
  f.advance(TRAIN_CONTROL_TIMING.recheckMs);
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(originalLookups, 2);
  assert.equal((await f.ledger.state(expected)).outcome ?? null, null);
  assert.equal(f.queue.row(900).state, 'DONE');
  assert.equal(stagesRun(engine).includes(8), false);
  valid = true;
  const windowsQuiescence = engine.windowsQuiescence;
  engine.windowsQuiescence = async () => ({ ...WINDOWS_CLEAN, windowsTreeZero: false });
  f.advance(TRAIN_CONTROL_TIMING.recheckMs);
  await f.exec.tick();
  assert.equal(originalLookups, 2, 'a busy process cannot hand off the archived batch');
  assert.equal((await f.ledger.state(expected)).outcome ?? null, null);
  engine.windowsQuiescence = windowsQuiescence;
  f.advance(TRAIN_CONTROL_TIMING.recheckMs);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal((await f.ledger.state(expected)).outcome, 'COMPLETED');
});

test('片 5 审查 1：选择协议 2 但缺少交接端口时，恢复旧 B 批不得再跑第 8 段', async t => {
  const stage8Calls = async protocolVersion => {
    const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
    const old = await executorFixture(t, { engine, now: T0 });
    await old.drop(triggerBytes());
    assert.equal((await old.exec.tick()).state, 'PARKED');
    engine.calls.length = 0;
    const running = await executorFixture(t, { engine, now: T0 + 11 * MIN, root: old.root, policy: trainPolicy(protocolVersion) });
    await running.exec.tick();
    return stagesRun(engine).filter(stage => stage === 8).length;
  };
  assert.equal(await stage8Calls(1), 1);
  assert.equal(await stage8Calls(TRAIN_PROTOCOL_VERSION), 0);
});

for (const recovered of [true, false]) {
  test(`片 5 审查 4：${recovered ? '旧' : '新'} B 批的读回越过截止信号后释放执行器`, async t => {
    const engine = stage8Engine(Array.from({ length: 2 }, () => notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')));
    const policy = trainPolicy(TRAIN_PROTOCOL_VERSION);
    const old = await executorFixture(t, { engine, now: T0, policy: recovered ? rawPolicy() : policy });
    await old.drop(triggerBytes());
    const second = triggerBytes({ pr: 900, headSha: H(4) });
    if (recovered) {
      assert.equal((await old.exec.tick()).state, 'PARKED');
      await old.drop(second);
      assert.equal((await old.exec.tick()).state, 'PARKED');
    }
    engine.calls.length = 0;
    const f = recovered ? await executorFixture(t, { engine, now: T0 + MIN, root: old.root, policy }) : old;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let firstRead = null, firstResult = null;
    const late = Promise.withResolvers();
    const reply = key => ({ protocol_version: TRAIN_PROTOCOL_VERSION, key, receiptId: 'b7abb84e-43e9-438b-ac4f-664f4b217b76' });
    engine.handoffTrainWork = async ({ key, subject, signal }) => {
      if (subject.pr !== 884) return reply(key);
      firstRead = { key, signal };
      return late.promise;
    };
    const tick = f.exec.tick().then(result => { firstResult = result; return result; });
    try {
      await until(() => firstRead, '第一个 PR 开始交接读回');
      t.mock.timers.tick(TRAIN_CONTROL_TIMING.recheckMs);
      assert.equal(firstRead.signal?.aborted, true, '截止时取消挂起的读回');
      await until(() => firstResult, '交接截止后首个 tick 返回待核对');
      assert.deepEqual(pick(firstResult), ['PARKED', TRAIN_FAILURE.EFFECT_UNKNOWN.resident]);
      assert.equal(f.queue.row(884).parked?.reason, TRAIN_FAILURE.EFFECT_UNKNOWN.resident);
      if (recovered) f.advance(TRAIN_CONTROL_TIMING.recheckMs); // 第一个批也已到重试时间，仍应先处理从未读回的批。
      else await f.drop(second);
      assert.equal((await f.exec.tick()).state, 'COMPLETED');
      assert.equal(f.queue.row(900).state, 'DONE');
      assert.equal(stagesRun(engine).includes(8), false);
    } finally {
      late.resolve(reply(batchKey(subject())));
      await tick;
    }
    assert.equal((await f.ledger.state(firstRead.key)).outcome ?? null, null, '超时后的迟到回执不得结清');
  });
}

for (const result of ['HEAD_LEASE_HELD', 'HEAD_LEASE_COMPLETED']) {
  test(`片 5 审查 5：${result} 已归档但队列仍为 RUNNING 时恢复原结算`, async t => {
    const engine = fakeEngine();
    const code = TRAIN_FAILURE[result];
    const held = result === 'HEAD_LEASE_HELD';
    const retryAt = T0 + TRAIN_CONTROL_TIMING.leaseMs;
    engine.runStage = async (_batch, request) => {
      engine.calls.push(['stage', request.number]);
      return { ok: false, code: code.resident, proof: WINDOWS_CLEAN,
        outcome: { status: 'BLOCKED', reason: code.native, sideEffects: 0, mayHavePublished: false,
          scheduling: { ciRetryAfter: held ? iso(retryAt) : null } } };
    };
    const first = await executorFixture(t, { engine, now: T0 });
    const release = first.ledger.releaseUnexecuted.bind(first.ledger);
    first.ledger.releaseUnexecuted = async (...args) => {
      const archived = await release(...args);
      first.exec.persistQueue = async () => {}; // 丢失归档后的队列落盘。
      return archived;
    };
    await first.drop(triggerBytes());
    const ended = await first.exec.tick();
    if (held) assert.equal(ended.failureCode, code.resident);
    else assert.equal(ended.state, 'COMPLETED');
    const restarted = await executorFixture(t, { engine, now: T0 + 15_000, root: first.root });
    assert.equal(restarted.queue.row(884).state, 'RUNNING');
    await restarted.exec.tick();
    const queueOnDisk = await RunQueue.open(path.join(first.root, 'state', 'queue'), restarted.clock);
    assert.equal(queueOnDisk.row(884).state, held ? 'BACKOFF' : 'DONE');
    if (held) assert.equal(queueOnDisk.row(884).nextAt, retryAt);
    else {
      assert.equal(restarted.queue.row(884).running, null);
      restarted.advance(11 * MIN);
      await restarted.exec.tick();
    }
    assert.deepEqual(stagesRun(engine), [1], '没有多跑一遍第 1 段');
  });
}

test('train v2: shared head lease held defers to server time and completed settles without budget or role changes', async t => {
  const engine = fakeEngine();
  const stage = engine.runStage;
  const retryAfter = T0 + TRAIN_CONTROL_TIMING.leaseMs;
  let code = TRAIN_FAILURE.HEAD_LEASE_HELD;
  engine.runStage = async (batch, request, opts) => {
    if (request.number !== 1) return stage(batch, request, opts);
    engine.calls.push(['stage', 1]);
    return { ok: false, code: code.resident, proof: WINDOWS_CLEAN,
      outcome: { status: 'BLOCKED', reason: code.native, sideEffects: 0, mayHavePublished: false,
        scheduling: { ciRetryAfter: code === TRAIN_FAILURE.HEAD_LEASE_HELD ? iso(retryAfter) : null } } };
  };
  const f = await executorFixture(t, { engine, now: T0 });
  const mode = f.exec.nodeMode();
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).failureCode, code.resident);
  assert.equal(f.queue.row(884).nextAt, retryAfter);
  f.advance(TRAIN_CONTROL_TIMING.leaseMs - 1);
  await f.exec.tick();
  assert.deepEqual(stagesRun(engine), [1]);
  code = TRAIN_FAILURE.HEAD_LEASE_COMPLETED;
  f.advance(1);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(f.queue.row(884).state, 'DONE');
  assert.deepEqual(stagesRun(engine), [1, 1]);
  assert.equal(await f.executedHeads.published(subject()), false);
  assert.equal(await f.ledger.halted(), null);
  assert.equal(f.exec.nodeMode(), mode);
  const usage = await f.ledger.usage(T0 - 1);
  assert.deepEqual([usage.started, usage.evaluations, usage.waitingRetries, usage.releasesByHead.size], [0, 0, 0, 0]);
});

test('the request shapes: a holder, 1 to 120 minutes, a reason, its own time and nonce; nothing else', () => {
  const ok = intakePauseRequest({ holder: 'owner', minutes: 120, reason: 'switch to company-01' }, () => T0);
  assert.equal(ok.contract, INTAKE_PAUSE_CONTRACT);
  assert.equal(validateIntakeRequest(ok).requestedAtMs, T0);
  assert.equal(intakeResumeRequest({ holder: 'dual-active', reason: 'lock released' }, () => T0).contract, INTAKE_RESUME_CONTRACT);
  for (const [name, v] of [
    ['121 minutes', { ...ok, minutes: 121 }], ['0 minutes', { ...ok, minutes: 0 }], ['fractional', { ...ok, minutes: 1.5 }], ['text minutes', { ...ok, minutes: '60' }],
    ['holder with capitals', { ...ok, holder: 'Owner' }], ['holder too long', { ...ok, holder: 'a'.repeat(33) }], ['no reason', { ...ok, reason: '' }],
    ['reason too long', { ...ok, reason: 'x'.repeat(201) }], ['bad nonce', { ...ok, nonce: 'zz' }], ['bad time', { ...ok, requestedAt: 'soon' }],
    ['extra key', { ...ok, by: 'S-1-5-21-1-2-3-1001' }], ['resume with minutes', { ...ok, contract: INTAKE_RESUME_CONTRACT }],
    ['another contract', { ...ok, contract: 'clued.independent-ci.resident-pause/1' }], ['null', null], ['array', []],
  ]) assert.equal(codeOf(() => validateIntakeRequest(v)), 'INTAKE_REQUEST_REFUSED', name);
  assert.throws(() => intakePauseRequest({ minutes: 121, reason: 'r' }), { code: 'INTAKE_REQUEST_REFUSED' }, 'the tool refuses what the executor would');
});

test('a hold lasts the requested minutes, at most two hours from the executor clock, and runs out by itself', async t => {
  const s = await store(t);
  assert.equal(s.p.view(), null);
  const r = await take(s, intakePauseRequest({ minutes: 30, reason: 'maintenance' }, s.clock));
  assert.deepEqual(r, { kind: 'intake-paused', holder: 'owner', until: iso(T0 + 30 * MIN), renewed: false });
  assert.deepEqual(s.p.view(), { until: iso(T0 + 30 * MIN), holders: [{ holder: 'owner', since: iso(T0), until: iso(T0 + 30 * MIN) }] });
  // a request dated ahead (inside the skew) still ends two hours from the executor's clock at the latest
  const ahead = { ...intakePauseRequest({ holder: 'other', minutes: 120, reason: 'r' }, () => T0 + 4 * MIN) };
  assert.equal((await take(s, ahead, SHA(2))).until, iso(T0 + INTAKE_PAUSE_MAX_MS));
  s.advance(30 * MIN);
  assert.deepEqual(s.p.view().holders.map(h => h.holder), ['other'], 'the owner hold ran out at its until');
  const ran = s.p.settle();
  assert.deepEqual(ran.ended, [{ holder: 'owner', since: iso(T0), until: iso(T0 + 30 * MIN) }]);
  await s.p.save(ran.data);
  assert.equal(s.p.settle(), null, 'marked once');
  s.advance(90 * MIN);
  assert.equal(s.p.view(), null, 'nothing outlives two hours');
  // persisted: a restarted service reads the same state
  const again = await IntakePause.open(s.dir, s.clock);
  assert.deepEqual(again.data, s.p.data);
});

test('stale, future-dated and superseded requests change nothing', async t => {
  const s = await store(t);
  assert.equal(codeOf(() => s.p.apply(intakePauseRequest({ minutes: 60, reason: 'r' }, () => T0 - 61 * MIN), SHA(1))), 'INTAKE_PAUSE_REQUEST_EXPIRED');
  assert.equal(codeOf(() => s.p.apply(intakePauseRequest({ minutes: 60, reason: 'r' }, () => T0 + 6 * MIN), SHA(1))), 'INTAKE_REQUEST_CLOCK_SKEW');
  await take(s, intakePauseRequest({ minutes: 60, reason: 'newer' }, () => T0 - MIN));
  // an older word of the same holder (an out-of-order file, a replayed copy) is refused
  assert.equal(codeOf(() => s.p.apply(intakePauseRequest({ minutes: 120, reason: 'older' }, () => T0 - 2 * MIN), SHA(2))), 'INTAKE_REQUEST_SUPERSEDED');
  const same = intakeResumeRequest({ reason: 'r' }, () => T0 - MIN);
  assert.equal(codeOf(() => s.p.apply(same, SHA(3))), 'INTAKE_REQUEST_SUPERSEDED', 'the same instant is not later');
  // after a resume, an older pause request read late cannot revive the hold
  await take(s, intakeResumeRequest({ reason: 'done' }, s.clock), SHA(4));
  assert.equal(codeOf(() => s.p.apply(intakePauseRequest({ minutes: 60, reason: 'late file' }, () => T0 - 30_000), SHA(5))), 'INTAKE_REQUEST_SUPERSEDED');
  assert.equal(s.p.view(), null);
});

test('independent holders never cancel each other; renewals extend and a resume ends one', async t => {
  const s = await store(t);
  await take(s, intakePauseRequest({ holder: 'owner', minutes: 120, reason: 'planned switch' }, s.clock));
  s.advance(MIN);
  await take(s, intakePauseRequest({ holder: 'version-skew', minutes: 120, reason: 'different versions' }, s.clock), SHA(2));
  s.advance(MIN);
  assert.deepEqual(await take(s, intakeResumeRequest({ holder: 'version-skew', reason: 'versions match' }, s.clock), SHA(3)), { kind: 'intake-resumed', holder: 'version-skew', held: true });
  assert.deepEqual(s.p.view().holders.map(h => h.holder), ['owner'], 'the Owner pause stays');
  // Renewing the same holder changes its end but keeps its start.
  s.advance(MIN);
  await take(s, intakePauseRequest({ holder: 'version-skew', minutes: 120, reason: 'versions differ again' }, s.clock), SHA(4));
  s.advance(100 * MIN);
  const renewed = await take(s, intakePauseRequest({ holder: 'version-skew', minutes: 120, reason: 'renewal' }, s.clock), SHA(5));
  assert.equal(renewed.renewed, true);
  const dual = s.p.view().holders.find(h => h.holder === 'version-skew');
  assert.deepEqual([dual.since, dual.until], [iso(T0 + 3 * MIN), iso(T0 + 103 * MIN + INTAKE_PAUSE_MAX_MS)]);
  // a resume of a holder with nothing in force is accepted and says so
  assert.deepEqual(await take(s, intakeResumeRequest({ holder: 'nobody', reason: 'r' }, s.clock), SHA(6)), { kind: 'intake-resumed', holder: 'nobody', held: false });
});

test('at most eight holders: a new holder takes the place of the oldest ended one; resumes never take a place (review M2)', async t => {
  const s = await store(t);
  for (let i = 0; i < INTAKE_HOLDS_MAX; i++) await take(s, intakePauseRequest({ holder: `h${i}`, minutes: 1 + i, reason: 'r' }, s.clock), SHA(i % 10));
  assert.equal(codeOf(() => s.p.apply(intakePauseRequest({ holder: 'one-more', minutes: 1, reason: 'r' }, s.clock), SHA(9))), 'INTAKE_PAUSE_HOLDERS_FULL', 'eight in force: they hold anyway');
  s.advance(90_000);
  await s.p.save(s.p.settle().data);
  assert.deepEqual(s.p.data.holds.filter(h => h.ended === 'expired').map(h => h.holder), ['h0'], 'h0 ended (1 minute)');
  await take(s, intakePauseRequest({ holder: 'one-more', minutes: 1, reason: 'r' }, s.clock), SHA(9));
  assert.deepEqual(s.p.data.holds.map(h => h.holder).sort(), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'one-more']);
  s.advance(INTAKE_PAUSE_MAX_MS);
  await s.p.save(s.p.settle().data);
  await take(s, intakePauseRequest({ holder: 'later', minutes: 1, reason: 'r' }, s.clock), SHA(8));
  assert.deepEqual(s.p.data.holds.map(h => h.holder), ['later'], 'ended holds older than two hours are dropped');
  // Resumes of holders never seen leave room for a new pause.
  const r = await store(t);
  for (let i = 0; i < 2 * INTAKE_HOLDS_MAX; i++) await take(r, intakeResumeRequest({ holder: `junk${i}`, reason: 'r' }, r.clock), SHA(i % 10));
  assert.equal(r.p.data.holds.length, 0);
  assert.equal((await take(r, intakePauseRequest({ holder: 'version-skew', reason: 'different versions' }, r.clock), SHA(1))).kind, 'intake-paused');
});

test('a clock that went back never stretches a hold beyond two hours', async t => {
  const s = await store(t);
  await take(s, intakePauseRequest({ minutes: 120, reason: 'r' }, s.clock));
  s.advance(-24 * 60 * MIN);
  assert.equal(s.p.view().until, iso(s.clock() + INTAKE_PAUSE_MAX_MS), 'counted from now');
  const next = s.p.settle();
  assert.deepEqual(next.ended, []);
  await s.p.save(next.data);
  assert.equal(s.p.data.holds[0].until, iso(s.clock() + INTAKE_PAUSE_MAX_MS), 'and written so');
});

test('a state file that does not validate is kept aside and holds for two hours (fail safe, bounded); the Owner may lift it', async t => {
  const dir = await tempRoot(t);
  const clock = () => T0;
  await fs.writeFile(path.join(dir, INTAKE_PAUSE_FILE), '{"contract":');
  const p = await IntakePause.open(dir, clock);
  assert.match(p.unreadable.keptAs, /^INTAKE-PAUSE\.unreadable-.*\.json$/);
  assert.equal((await fs.readFile(path.join(dir, p.unreadable.keptAs), 'utf8')), '{"contract":', 'kept, never deleted');
  assert.deepEqual(p.view(), { until: iso(T0 + INTAKE_PAUSE_MAX_MS), holders: [{ holder: UNREADABLE_HOLDER, since: iso(T0), until: iso(T0 + INTAKE_PAUSE_MAX_MS) }] });
  const reopened = await IntakePause.open(dir, clock);
  assert.equal(reopened.unreadable, null, 'the replacement is a valid state');
  const { data } = reopened.apply(intakeResumeRequest({ holder: UNREADABLE_HOLDER, reason: 'checked' }, () => T0 + 1), SHA(1), T0 + 1);
  await reopened.save(data);
  assert.equal(reopened.view(T0 + 1), null);
  assert.deepEqual((await readIntakePause(dir, clock)).view, null);
  await fs.writeFile(path.join(dir, INTAKE_PAUSE_FILE), JSON.stringify({ contract: 'x', holds: [] }));
  assert.deepEqual(await readIntakePause(dir, clock), { view: null, holds: null, unreadable: true, code: 'INTAKE_PAUSE_STATE_INVALID' }, 'the read-only tool never moves anything');
  assert.equal((await fs.readdir(dir)).filter(n => n.startsWith('INTAKE-PAUSE.unreadable-')).length, 1);
});

// ---- the executor ----

test('any Owner session holds new batches: the trigger is queued, nothing starts; the hold runs out by itself and the queue runs', async t => {
  const board = new StatusBoard({ clock: () => T0 });
  const f = await executorFixture(t, { now: T0, status: board });
  await f.drop(json(intakePauseRequest({ minutes: 30, reason: 'planned switch to company-01' }, f.clock)), 'requests');
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  assert.equal(f.engine.calls.length, 0, 'no stage, no bundle');
  assert.equal(f.queue.row(884).state, 'QUEUED', 'the trigger is read, not lost');
  assert.deepEqual(board.snapshot().intakePause, { until: iso(T0 + 30 * MIN), holders: [{ holder: 'owner', since: iso(T0), until: iso(T0 + 30 * MIN) }] });
  assert.deepEqual([board.snapshot().executor.state, board.snapshot().executor.reason], ['DEFERRED', 'INTAKE_PAUSED']);
  assert.ok((await receiptTypes(f)).includes('intake-paused'));
  f.advance(29 * MIN);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  f.advance(MIN);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'at its until the queue runs again, no Owner step needed');
  assert.equal(board.snapshot().intakePause, null);
  assert.equal((await receiptTypes(f)).filter(x => x === 'intake-pause-ended').length, 1);
});

test('nothing in flight or parked is touched: a batch at parking point B runs its stage-8 try under the hold; a new PR waits', async t => {
  const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]);
  const f = await executorFixture(t, { engine, now: T0 });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(json(intakePauseRequest({ reason: 'maintenance' }, f.clock)), 'requests');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  f.advance(10 * MIN);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'the parked batch finished: its try is no new batch');
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8, 8]);
  assert.equal((await f.ledger.state(batchKey(subject()))).outcome, 'COMPLETED');
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  assert.equal(f.queue.row(900).state, 'QUEUED');
  assert.equal(await f.executedHeads.published(subject({ pr: 900, headSha: H(4) })), false, 'PR 900 never started');
});

test('it is neither PAUSE nor the drain: all three hold at once and each keeps its own rules', async t => {
  const board = new StatusBoard({ clock: () => T0 });
  const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]), now: T0, status: board });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(json(intakePauseRequest({ reason: 'planned switch' }, f.clock)), 'requests');
  await f.drop(json({ contract: PAUSE_CONTRACT, reason: 'emergency stop' }), 'requests');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'PAUSED', 'PAUSE stays the stronger stop');
  assert.equal(board.snapshot().paused, true);
  assert.notEqual(board.snapshot().intakePause, null, 'both shown');
  // an intake resume is no PAUSE resume
  f.advance(MIN);
  await f.drop(json(intakeResumeRequest({ reason: 'not a pause resume' }, f.clock)), 'requests');
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  f.advance(MIN);
  await f.drop(json(intakePauseRequest({ reason: 'hold again' }, f.clock)), 'requests');
  await writeOwnerRequest(path.join(f.root, 'owner'), resumeRequest({ expectedPausedSha256: (await f.ledger.paused()).sha256, by: OWNER }), f.clock);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED'], 'the Owner resume clears PAUSE, not the intake pause');
  // the drain still ends the parked batch while the intake pause holds; the hold stays
  f.advance(MIN);
  await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  assert.equal((await f.ledger.state(batchKey(subject()))).terminal.facts.failureCode, 'OWNER_ABORTED');
  assert.equal((await f.ledger.open()).length, 0);
  assert.equal(f.queue.row(900).state, 'QUEUED');
});

test('each holder lifts only its own hold; the Owner and version-skew pauses both have to end', async t => {
  const f = await executorFixture(t, { now: T0 });
  await f.drop(json(intakePauseRequest({ holder: 'owner', reason: 'planned switch' }, f.clock)), 'requests');
  await f.drop(json(intakePauseRequest({ holder: 'version-skew', reason: 'version mismatch' }, f.clock)), 'requests');
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  f.advance(MIN);
  await f.drop(json(intakeResumeRequest({ holder: 'owner', reason: 'switch done' }, f.clock)), 'requests');
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED'], 'the Owner resume leaves the version-skew hold');
  await f.drop(json(intakeResumeRequest({ holder: 'version-skew', reason: 'versions match' }, f.clock)), 'requests');
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  const types = await receiptTypes(f);
  assert.deepEqual([types.filter(x => x === 'intake-paused').length, types.filter(x => x === 'intake-resumed').length], [2, 2]);
});

test('refused requests leave a receipt and change nothing; the requests are archived as rejected', async t => {
  const f = await executorFixture(t, { now: T0 });
  await f.drop(json(intakePauseRequest({ minutes: 60, reason: 'written long ago' }, () => T0 - 3 * 60 * MIN)), 'requests');
  await f.drop(json({ ...intakePauseRequest({ reason: 'r' }, f.clock), minutes: 500 }), 'requests');
  await f.drop(json({ ...intakeResumeRequest({ reason: 'r' }, f.clock), by: OWNER }), 'requests');
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal((await receiptTypes(f)).filter(x => x === 'intake-request-refused').length, 3);
  assert.equal((await fs.readdir(path.join(f.root, 'state', 'requests-archive', 'rejected'))).length, 3);
});

test('an unreadable state holds (fail safe, two hours at most, with a receipt) and the Owner may lift it; an I/O error holds one tick', async t => {
  const f = await executorFixture(t, { now: T0 });
  await fs.writeFile(path.join(f.root, 'state', INTAKE_PAUSE_FILE), 'not json');
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  assert.ok((await receiptTypes(f)).includes('intake-pause-unreadable'));
  f.advance(MIN);
  await f.drop(json(intakeResumeRequest({ holder: UNREADABLE_HOLDER, reason: 'looked at the kept copy' }, f.clock)), 'requests');
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  // an I/O error reading the state: no batch this tick, nothing else changes
  const g = await executorFixture(t, { now: T0 });
  g.exec.intakePause = { settle() { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } };
  await g.drop(triggerBytes());
  assert.deepEqual(pick(await g.exec.tick()), ['DEFERRED', 'INTAKE_PAUSE_UNCONFIRMED']);
  assert.equal(g.engine.calls.length, 0);
  g.exec.intakePause = null;
  assert.equal((await g.exec.tick()).state, 'COMPLETED', 'read again the next tick');
});

test('status.json /3 carries the holds and the PR page says the queue waits for the intake pause', () => {
  const now = T0;
  const b = new StatusBoard({ clock: () => now });
  b.update({ backfill: { complete: true, published: 0, unreadable: 0 }, intakePause: { until: iso(now + 90 * MIN), holders: [{ holder: 'owner', since: iso(now), until: iso(now + 90 * MIN) }] } });
  b.setPending([{ pr: 7, headSha: H(7), baseSha: BASE, eta: now + 20 * MIN }]);
  const status = parseStatus(Buffer.from(JSON.stringify(b.snapshot())));
  assert.deepEqual(status.intakePause, { until: now + 90 * MIN, holders: [{ holder: 'owner', since: now, until: now + 90 * MIN }] });
  const page = prPage({ pull: { pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }, status, now });
  assert.deepEqual(page, { state: 'pending', description: '排队第 1 位：暂停接新中，最晚 06:30Z 恢复' });
  // a reader keeps a hold whose times it cannot read, and drops holder names that do not fit
  const odd = parseStatus(Buffer.from(JSON.stringify({ ...b.snapshot(), intakePause: { until: 'later', holders: [{ holder: 'Owner!', until: 1 }, { holder: 'ok', since: null, until: null }] } })));
  assert.deepEqual(odd.intakePause, { until: null, holders: [{ holder: 'ok', since: null, until: null }] });
  assert.equal(parseStatus(Buffer.from(JSON.stringify({ ...b.snapshot(), intakePause: null }))).intakePause, null);
  const { intakePause, ...without } = b.snapshot();
  assert.throws(() => parseStatus(Buffer.from(JSON.stringify(without))), { code: 'STATUS_REFUSED' }, 'a /3 snapshot always has the key');
});

test('the Owner tool writes the requests into requests\\ (no elevation) and inspect shows the holds', async t => {
  const f = await executorFixture(t, { now: T0 });
  const file = await writeOwnerRequest(path.join(f.root, 'requests'), intakePauseRequest({ minutes: 45, reason: 'upgrade' }, f.clock), f.clock);
  assert.equal(path.dirname(file), path.join(f.root, 'requests'));
  await f.exec.tick();
  const seen = await inspect({ ledger: f.ledger, receipts: f.receipts, intake: await readIntakePause(path.join(f.root, 'state'), f.clock) });
  assert.deepEqual(seen.intakePause.view, { until: iso(T0 + 45 * MIN), holders: [{ holder: 'owner', since: iso(T0), until: iso(T0 + 45 * MIN) }] });
  assert.equal(seen.paused, false, 'not a PAUSE');
});

// ---- independent review of C6: the gaps and the fixes ----

test('a batch waiting at parking point A goes on under the hold and stays the status\'s current batch (review minor 3)', async t => {
  const W0 = Date.parse('2026-10-20T12:00:00Z');
  const board = new StatusBoard({ clock: () => W0 });
  const f = await executorFixture(t, { status: board });
  const atA = holdAtA(f.exec);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  await f.drop(json(intakePauseRequest({ reason: 'planned switch' }, f.clock)), 'requests');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'WAITING', 'the wait, not the deferral');
  assert.equal(board.snapshot().current?.pr, 884, 'a planned switch sees the batch at A');
  assert.notEqual(board.snapshot().intakePause, null);
  atA.release();
  f.advance(MIN);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'the batch at A ran to its end under the hold');
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  assert.equal(await f.executedHeads.published(subject({ pr: 900, headSha: H(4) })), false);
});

test('a due attempt 2 is a new batch: it waits for the hold to end', async t => {
  let n = 0;
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(batch, stage, o));
  const f = await executorFixture(t, { engine, now: T0 });
  await f.drop(triggerBytes());
  assert.ok((await f.exec.tick()).attempt2);
  await f.drop(json(intakePauseRequest({ minutes: 30, reason: 'hold' }, f.clock)), 'requests');
  f.advance(10 * MIN);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSED']);
  assert.equal(stagesRun(engine).filter(x => x === 1).length, 1, 'attempt 2 did not start');
  f.advance(20 * MIN);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'attempt 2 after the hold');
});

test('review M1: requests that cannot be applied are refused after three tries, so a PAUSE behind them is read', async t => {
  const f = await executorFixture(t, { now: T0 });
  await f.exec.tick();
  const real = f.exec.intakePause ?? await f.exec.intakeHolds();
  real.save = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  for (let i = 0; i < 16; i++) { f.advance(1000); await f.drop(json(intakePauseRequest({ holder: 'owner', reason: `renewal ${i}` }, f.clock)), 'requests'); }
  await f.drop(json({ contract: PAUSE_CONTRACT, reason: 'emergency stop' }), 'requests');
  const states = [];
  for (let i = 0; i < 4; i++) states.push((await f.exec.tick()).state);
  assert.equal(states.at(-1), 'PAUSED', `the PAUSE was read (${states.join(', ')})`);
  assert.equal((await receiptTypes(f)).filter(x => x === 'intake-request-refused').length, 16);
  assert.equal((await receiptTypes(f)).filter(x => x === 'intake-pause-unconfirmed').length, 1, 'one receipt per spell');
});

test('re-review: a short write failure ends with the next good write (the state is written again as a probe), never a HALT', async t => {
  const f = await executorFixture(t, { now: T0 });
  await f.exec.tick();
  const real = f.exec.intakePause ?? await f.exec.intakeHolds();
  const save = real.save.bind(real);
  let failing = true;
  real.save = async d => { if (failing) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return save(d); };
  await f.drop(json(intakePauseRequest({ reason: 'locked by a virus scan' }, f.clock)), 'requests');
  await f.drop(triggerBytes());
  for (let i = 0; i < 3; i++) assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSE_UNCONFIRMED']);
  assert.ok((await receiptTypes(f)).includes('intake-request-refused'), 'refused after three tries');
  failing = false;
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'the probe write worked: the spell ended, no HALT');
  assert.equal(await f.ledger.halted(), null);
});

test('review minor 4: a state that stays unreadable shows a hold on the status, has one receipt, and HALTs after 30 minutes', async t => {
  const board = new StatusBoard({ clock: () => T0 });
  const f = await executorFixture(t, { now: T0, status: board });
  f.exec.intakePause = { settle() { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } };
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSE_UNCONFIRMED']);
  assert.deepEqual(board.snapshot().intakePause, { until: null, holders: [{ holder: 'unconfirmed', since: iso(T0), until: null }] }, 'never read as on duty');
  f.advance(INTAKE_PAUSE_UNCONFIRMED_MAX_MS - 1);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'INTAKE_PAUSE_UNCONFIRMED']);
  f.advance(1);
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal((await f.ledger.halted()).value.code, 'INTAKE_PAUSE_STATE_UNAVAILABLE');
  assert.equal((await receiptTypes(f)).filter(x => x === 'intake-pause-unconfirmed').length, 1);
  assert.equal(f.engine.calls.length, 0);
  assert.throws(() => validateIntakeRequest({ ...intakePauseRequest({ reason: 'r' }), holder: 'unconfirmed' }), { code: 'INTAKE_REQUEST_REFUSED' }, 'a reserved name');
});

test('a hold runs out by its clock while the executor is PAUSEd, and the status says so', async t => {
  const board = new StatusBoard({ clock: () => T0 });
  const f = await executorFixture(t, { now: T0, status: board });
  await f.drop(json(intakePauseRequest({ minutes: 30, reason: 'r' }, f.clock)), 'requests');
  await f.exec.tick();
  await f.drop(json({ contract: PAUSE_CONTRACT, reason: 'stop' }), 'requests');
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.notEqual(board.snapshot().intakePause, null);
  f.advance(31 * MIN);
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.equal(board.snapshot().intakePause, null);
  assert.ok((await receiptTypes(f)).includes('intake-pause-ended'));
});

test('the command line: --minutes takes 1 to 120 whole minutes; the request goes into requests\\', async t => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'requests'));
  const tool = fileURLToPath(new URL('../tools/rearm-tool.mjs', import.meta.url));
  const run = async (...args) => { try { const r = await promisify(execFile)(process.execPath, [tool, ...args]); return { code: 0, out: JSON.parse(r.stdout) }; } catch (e) { return { code: e.code, out: JSON.parse(e.stdout) }; } };
  const ok = await run('request-intake-pause', '--root', root, '--reason', 'upgrade', '--minutes', '45');
  assert.equal(ok.out.status, 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES');
  const files = await fs.readdir(path.join(root, 'requests'));
  const v = JSON.parse(await fs.readFile(path.join(root, 'requests', files[0]), 'utf8'));
  assert.deepEqual([v.contract, v.holder, v.minutes], [INTAKE_PAUSE_CONTRACT, 'owner', 45]);
  for (const m of ['1.5', '121', '0', 'x']) assert.deepEqual(await run('request-intake-pause', '--root', root, '--reason', 'r', '--minutes', m), { code: 1, out: { status: 'REFUSED', code: 'INTAKE_REQUEST_REFUSED' } }, m);
  assert.equal((await run('request-intake-resume', '--root', root, '--reason', 'done', '--holder', 'owner')).out.status, 'INTAKE_RESUME_REQUESTED');
  for (const command of ['request-intake-pause', 'request-intake-resume'])
    assert.deepEqual(await run(command, '--root', root, '--reason', 'legacy', '--holder', 'dual-active'), { code: 1, out: { status: 'REFUSED', code: 'INTAKE_HOLDER_RETIRED' } });
  assert.equal((await fs.readdir(path.join(root, 'requests'))).length, 2);
});
