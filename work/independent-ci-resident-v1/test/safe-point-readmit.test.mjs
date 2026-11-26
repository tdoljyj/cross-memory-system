import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BETWEEN_BATCHES_RUNNING, ResidentExecutor, SUPERSEDED_AT_SAFE_POINT } from '../src/executor.mjs';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { RunQueue } from '../src/queue.mjs';
import { intakePauseRequest, intakeResumeRequest } from '../src/intake-pause.mjs';
import { upgradeResumeRequest } from '../src/upgrade-mailbox.mjs';
import { describe } from '../src/pr-status.mjs';
import { batchJobsV2, batchRefV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { NO_SWEEP, trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS, validatePolicy } from '../src/policy.mjs';
import { executorFixture, fakeEngine, fakeCompanion, holdAtA, notAdmitted, rawPolicy, triggerBytes, withTimeout, HEAD, BASE, SOURCE, WINDOWS_CLEAN } from './helpers.mjs';

const MIN = 60_000;
const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 };
const key = batchKey(subject);
const blocked = { ok: false, code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', proof: WINDOWS_CLEAN,
  outcome: { status: 'BLOCKED', reason: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', sideEffects: 0, mayHavePublished: false,
    scheduling: { mergeQueue: { entered: true, position: 1 } }, safeToRerun: false } };

async function fixture(t) {
  let ready = false, f;
  const engine = fakeEngine(), run = engine.runStage;
  const derive = engine.derive;
  engine.derive = async (...args) => ({ ...await derive(...args), ciSourceManifestSha256: f.exec.policy.ciSourceManifestSha256 });
  engine.runStage = async (batch, stage, opts) => stage.number === 8 && !ready
    ? (engine.calls.push(['stage', 8]), blocked) : run(batch, stage, opts);
  f = await executorFixture(t, { engine, companion: fakeCompanion({ pull: n => ({ number: n, state: 'open', headSha: HEAD }) }, () => f.clock()) });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(key)));
  return { ...f, ready: () => { ready = true; } };
}

async function drain(f) {
  f.exec.versions = async () => ({ view: { consistent: true, upgrade: { state: 'WAITING_DRAIN' } } });
  await f.drop(Buffer.from(JSON.stringify(intakePauseRequest({ holder: 'resident-upgrade', reason: 'upgrade' }, f.clock))), 'requests');
  await f.exec.tick();
  const ended = await f.ledger.state(f.key ?? key);
  assert.equal(ended.terminal.facts.failureCode, SUPERSEDED_AT_SAFE_POINT);
  assert.equal(ended.terminal.facts.basis, 'upgrade-drain');
  assert.equal((await f.ledger.open()).length, 0, 'the upgrader can drain');
}

async function release(f) {
  f.advance(1); // resume must be newer than the pause, as in the real upgrader
  await f.drop(Buffer.from(JSON.stringify(intakeResumeRequest({ holder: 'resident-upgrade', reason: 'upgraded' }, f.clock))), 'requests');
  f.exec.versions = async () => ({ view: { consistent: true, upgrade: { state: 'IDLE' } } });
  f.ready();
}

const count = (f, n) => f.engine.calls.filter(c => c[0] === 'stage' && c[1] === n).length;
const finish = async f => { for (let i = 0; i < 8; i++) { f.advance(10 * MIN); await f.exec.tick(); } };

test('upgrade drain: same head is automatically readmitted once, without a push or repeating completed scans', async t => {
  const f = await fixture(t);
  const scans = [2, 3, 4, 5, 6, 7].map(n => count(f, n));
  await drain(f);
  const before = count(f, 8);
  for (let i = 0; i < 3; i++) { f.advance(MIN); await f.exec.tick(); }
  assert.equal(count(f, 8), before, 'the drain hold prevents readmission');
  await release(f);
  await finish(f);
  assert.equal(f.exec.queue.row(884).state, 'DONE');
  assert.equal(count(f, 8), before + 1, 'one successful continuation only');
  assert.equal((await f.ledger.usage(f.clock() - 86_400_000)).startedByPr.get(884), 1, 'the archived flow end spends no PR quota; its completed continuation spends one');
  assert.deepEqual([2, 3, 4, 5, 6, 7].map(n => count(f, n)), scans);
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
});

test('readmission survives restart and a lost queue, and still waits for matching Sources', async t => {
  const f = await fixture(t);
  await drain(f);
  await release(f);
  const dir = f.exec.queue.dir;
  await fs.rename(f.exec.queue.file, `${f.exec.queue.file}.lost`);
  // Restart with real persisted ledger; no trigger is written again.
  f.exec = new ResidentExecutor({ ...f.ports, queue: await RunQueue.open(dir, f.clock) });
  f.exec.versions = async () => ({ view: { consistent: false } });
  const before = count(f, 8);
  await finish(f);
  assert.equal(count(f, 8), before);
  f.exec.versions = async () => ({ view: { consistent: true } });
  await finish(f);
  assert.equal(f.exec.queue.row(884).state, 'DONE');
  assert.equal(count(f, 8), before + 1);
});

test('升级排空期间合入的队首 PR 在恢复首个安全 tick 收终，列车恢复后准入下一 PR', async t => {
  const f = await fixture(t);
  await drain(f);
  assert.equal((await f.ledger.pendingFlowEnds()).length, 1);
  await f.ledger.pause({ reason: 'upgrade', requestSha256: 'a'.repeat(64) });

  const nextPr = 885, nextHead = '4'.repeat(40), claimId = '0a1b2c3d-0000-4000-8000-0000000000aa';
  const entered = Promise.withResolvers(), finishRevoke = Promise.withResolvers();
  const modes = [];
  let merged = false, slotTakenAt = null;
  const companion = fakeCompanion({ pull: pr => ({ number: pr, state: pr === subject.pr && merged ? 'merged' : 'open',
    headSha: pr === nextPr ? nextHead : HEAD }) }, f.clock);
  const run = f.engine.runStage;
  f.engine.runStage = async (batch, stage, opts) => {
    const result = await run(batch, stage, opts);
    // 第 1 段沿用夹具的授权成功答复，只有第 8 段返回入列事实后，第 10 段才读到槽位。
    if (stage.number === 8 && result.outcome?.scheduling?.mergeQueue?.entered) slotTakenAt = new Date(f.clock()).toISOString();
    return result;
  };
  f.engine.runTrainStage = async mode => {
    modes.push(mode);
    if (mode === 'revoke-only') {
      entered.resolve();
      await finishRevoke.promise;
    }
    const at = new Date(f.clock()).toISOString();
    const holder = slotTakenAt && { pr: nextPr, claimId, takenAt: slotTakenAt,
      mergeSlotUntil: new Date(Date.parse(slotTakenAt) + 45 * MIN).toISOString(), ciState: 'running' };
    const front = holder ? { state: 'open', baseRef: 'main', headSha: nextHead, draft: false, mergeable: true, headContainsMain: true, green: false } : null;
    return { ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: WINDOWS_CLEAN,
      outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: 0, mayHavePublished: false, safeToRerun: false },
      train: trainFacts({ mode, at, onDuty: true, holders: holder ? [holder] : [], mainSha: BASE, rules: null, front, revoke: [],
        ledger: null, decision: mode === 'revoke-only' ? 'REVOKE_ONLY_DONE' : null,
        sweep: { ...NO_SWEEP, kind: 'full-segment', complete: true,
          fullSweep: { state: 'complete', startedAt: at, completedAt: at, sinceOn: mode === 'on', reason: null } } }) };
  };
  const policy = validatePolicy(rawPolicy({ contract: POLICY_CONTRACT_V8, train: { ...TRAIN_DEFAULTS, enabled: 'on', nonFrontRuns: true,
    maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, sweep: 'audit' } }));
  const queue = await RunQueue.open(f.queue.dir, f.clock);
  f.exec = new ResidentExecutor({ ...f.ports, queue, policy, companion });
  f.exec.versions = async () => ({ view: { consistent: true, upgrade: { state: 'IDLE' } } });
  const receipts = async type => (await f.receipts.latest([type], 20)).map(r => r.value.body);
  const before = [count(f, 1), count(f, 8)];
  const pausedTick = f.exec.tick();
  try {
    await withTimeout(entered.promise, 'revoke-only stage 10');
    assert.deepEqual(companion.calls, [], '硬暂停期间不会核对待续跑行');
    merged = true;
    await f.drop(triggerBytes({ pr: nextPr, headSha: nextHead }));
    assert.equal((await f.exec.tick()).reason, 'EXECUTOR_TICK_BUSY', '第 10 段在途，不能并行核对');
    assert.deepEqual(companion.calls, []);
  } finally {
    finishRevoke.resolve();
    assert.equal((await pausedTick).state, 'PAUSED');
  }
  assert.deepEqual(modes, ['revoke-only']);
  assert.equal((await receipts('train-run')).at(-1).wouldDo, 'NO_FRONT');

  f.advance(MIN);
  const paused = await f.ledger.paused();
  await f.drop(JSON.stringify(upgradeResumeRequest({ pausedSha256: paused.sha256, opId: claimId, generation: 3 }, f.clock)), 'owner');
  assert.equal((await f.exec.tick({ betweenBatchesRunning: true })).reason, BETWEEN_BATCHES_RUNNING);
  assert.equal(await f.ledger.paused(), null);
  assert.deepEqual(companion.calls, [], '批间维护在途时不占 companion 通道');
  assert.equal(queue.view(f.clock(), { etaBatchMs: MIN }).find(r => r.pr === subject.pr).position, 1);

  f.advance(MIN);
  const held = await f.exec.tick();
  assert.deepEqual([held.state, held.reason], ['DEFERRED', 'INTAKE_PAUSED']);
  assert.deepEqual([queue.row(subject.pr).state, queue.row(subject.pr).reason], ['DONE', 'PR_CLOSED'], '首个安全 tick 已收终，即使接单 hold 仍在');
  assert.equal(queue.view(f.clock(), { etaBatchMs: MIN }).find(r => r.pr === subject.pr).position, null);
  assert.deepEqual(await f.ledger.pendingFlowEnds(), []);
  assert.deepEqual(companion.calls, [['pr-head', subject.pr]]);
  assert.deepEqual((await receipts('batch-reserved')).map(r => r.subject.pr), [subject.pr]);
  assert.deepEqual([count(f, 1), count(f, 8)], before);
  assert.equal(queue.row(nextPr).state, 'QUEUED');
  assert.deepEqual((await receipts('queue-pr-closed')).map(r => [r.pr, r.state]), [[subject.pr, 'merged']]);

  f.advance(MIN);
  await f.drop(JSON.stringify(intakeResumeRequest({ holder: 'resident-upgrade', reason: 'upgraded' }, f.clock)), 'requests');
  await f.exec.tick();
  assert.deepEqual(modes, ['revoke-only', 'on'], '解除最后一个 hold 的首轮立即恢复 on');
  assert.deepEqual((await receipts('train-run-intent')).map(r => r.runMode), ['revoke-only', 'on']);
  f.advance(MIN);
  await f.exec.tick();
  const reservations = await receipts('batch-reserved');
  assert.deepEqual(reservations.map(r => r.subject.pr), [subject.pr, nextPr]);
  assert.ok((await receipts('stage-terminal')).some(r => r.key === reservations[1].key && r.stage === 1 && r.ok));
  f.advance(MIN);
  await f.exec.tick();
  assert.deepEqual([f.exec.trainLast.front?.pr, f.exec.trainLast.front?.headSha], [nextPr, nextHead], '常规 CI 入列后，下一次 on 读到 B 为车头');
  const persisted = await RunQueue.open(queue.dir, f.clock);
  assert.equal(persisted.view(f.clock(), { etaBatchMs: MIN }).find(r => r.pr === subject.pr).position, null);
  assert.deepEqual(await f.ledger.pendingFlowEnds(), []);
});

test('接单 hold 后的普通队列也收终，每 tick 核一行，同一行十分钟内不重读', async t => {
  const readPrs = [];
  let readSecond = pr => ({ number: pr, state: 'open', headSha: HEAD });
  let draftClosed = false;
  const f = await executorFixture(t, { companion: fakeCompanion({ pull: pr => {
    readPrs.push(pr);
    if (pr === 885) return readSecond(pr);
    if (pr === 887) return { number: pr, state: draftClosed ? 'closed' : 'open', draft: !draftClosed, headSha: '4'.repeat(40) };
    return { number: pr, state: 'merged', headSha: HEAD };
  } }) });
  await f.drop(JSON.stringify(intakePauseRequest({ holder: 'resident-upgrade', reason: 'upgrade' }, f.clock)), 'requests');
  for (const pr of [884, 885]) await f.drop(triggerBytes({ pr }));

  await f.exec.tick();
  assert.deepEqual(readPrs, [884], '同一个 tick 只核第一行');
  assert.equal(f.queue.row(885).state, 'QUEUED');
  f.advance(MIN);
  await f.exec.tick();
  assert.deepEqual(readPrs, [884, 885]);
  assert.deepEqual([f.queue.row(884).state, f.queue.row(884).reason], ['DONE', 'PR_CLOSED']);
  assert.equal(f.queue.row(885).state, 'QUEUED');

  readSecond = () => ({ number: 884, state: 'closed', headSha: HEAD });
  f.advance(10 * MIN - 1);
  await f.exec.tick();
  assert.deepEqual(readPrs, [884, 885], '第二行距离上次核对不足十分钟');
  f.advance(1);
  await f.exec.tick();
  assert.deepEqual(readPrs, [884, 885, 885]);
  assert.equal(f.queue.row(885).state, 'QUEUED', '其他 PR 的关闭答复不能影响本行');
  readSecond = pr => ({ number: pr, state: 'unknown', headSha: HEAD });
  f.advance(10 * MIN);
  assert.equal((await f.exec.tick()).reason, 'INTAKE_PAUSED');
  assert.equal(f.queue.row(885).state, 'QUEUED', '未确认的状态不能收终');
  readSecond = () => { throw new Error('pr-head timed out'); };
  f.advance(10 * MIN);
  assert.equal((await f.exec.tick()).reason, 'INTAKE_PAUSED', '读取失败后仍经过正常排程关');
  assert.equal(f.queue.row(885).state, 'QUEUED');
  readSecond = pr => ({ number: pr, state: 'closed', headSha: HEAD });
  f.advance(10 * MIN);
  await f.exec.tick();
  assert.deepEqual([f.queue.row(885).state, f.queue.row(885).reason], ['DONE', 'PR_CLOSED']);

  await f.drop(JSON.stringify(intakeResumeRequest({ holder: 'resident-upgrade', reason: 'upgraded' }, f.clock)), 'requests');
  await f.drop(triggerBytes({ pr: 886 }));
  await f.drop(triggerBytes({ pr: 887, headSha: '4'.repeat(40) }));
  await f.exec.tick();
  assert.deepEqual(readPrs.slice(-2), [886, 887], '提前核对收终 886，正常排程在预留前读取 887');
  assert.ok(f.queue.held(887), '草稿由原有排程路径 hold');
  draftClosed = true;
  f.advance(10 * MIN - 1);
  await f.exec.tick();
  assert.equal(readPrs.filter(pr => pr === 887).length, 1, '预留前的读取也计入十分钟间隔');
  f.advance(1);
  await f.exec.tick();
  const draft = f.queue.view(f.clock(), { etaBatchMs: MIN }).find(r => r.pr === 887);
  assert.deepEqual([draft.state, draft.reason, draft.position], ['DONE', 'PR_CLOSED', null]);
});

test('park.maxMs frees the parking place and a PR event wakes the same batch', async t => {
  const f = await fixture(t);
  f.advance(f.exec.policy.park.maxMs + MIN);
  await f.exec.tick();
  assert.equal((await f.ledger.open()).length, 1);
  assert.deepEqual(await f.exec.parkedCounts(), { inside: 0, outside: 0 });
  f.ready();
  const before = count(f, 8);
  await f.drop(triggerBytes({ contract: 'clued.independent-ci.resident-trigger/2', prUpdatedAt: new Date(f.clock()).toISOString() }));
  await finish(f);
  assert.equal(f.exec.queue.row(884).state, 'DONE');
  assert.equal(count(f, 8), before + 1);
  assert.equal(count(f, 3), 1);
});

test('a real stage-8 failure after readmission still burns the head and never runs again', async t => {
  const f = await fixture(t);
  await drain(f);
  await release(f);
  const run = f.engine.runStage;
  f.engine.runStage = async (batch, stage, opts) => stage.number === 8
    ? (f.engine.calls.push(['stage', 8]), { ok: false, code: 'TRAIN_TEST_MERGE_TREE_DIFFERS', proof: WINDOWS_CLEAN }) : run(batch, stage, opts);
  const before = count(f, 8);
  await finish(f);
  assert.equal(count(f, 8), before + 1);
  assert.equal(f.exec.queue.row(884).state, 'STOPPED');
});

test('a new installed generation with the same CI Source resumes B, while a new CI Source goes through admission and scans once', async t => {
  for (const newCi of [false, true]) {
    const f = await fixture(t);
    await drain(f);
    await release(f);
    const source = '9'.repeat(64);
    f.exec.policy = { ...f.exec.policy, sourceManifestSha256: source,
      ...(newCi ? { ciSourceManifestSha256: '8'.repeat(64) } : {}) };
    f.exec.sourceIntegrity = async () => ({ ok: true, sourceManifestSha256: source, residentManifestSha256: f.exec.policy.residentManifestSha256 });
    await finish(f);
    assert.equal(f.exec.queue.row(884).state, 'DONE');
    assert.equal(count(f, 3), newCi ? 2 : 1);
    assert.equal((await f.ledger.state(batchKey({ ...subject, sourceManifestSha256: source })) ).outcome, 'COMPLETED');
    assert.equal((await f.ledger.pendingFlowEnds()).length, 0);
  }
});

test('the unscanned A safe point is admitted afresh, without attempt 2', async t => {
  const f = await executorFixture(t, { companion: fakeCompanion({ pull: n => ({ number: n, state: 'open', headSha: HEAD }) }) });
  f.companion.heartbeat = async () => ({ at: f.clock() });
  const a = holdAtA(f.exec);
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.ok(Ledger.waitingAt(await f.ledger.state(key)));
  await drain(f);
  f.ready = () => a.release();
  await release(f);
  await finish(f);
  assert.equal(f.exec.queue.row(884).state, 'DONE');
  assert.equal(count(f, 1), 2);
  assert.equal(count(f, 3), 1);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
});

test('flow history keeps stage-8 daily retry accounting, and an unrelated publication cannot be consumed', async t => {
  const f = await fixture(t);
  f.advance(MIN);
  await f.exec.tick();
  const before = await f.ledger.usage(f.clock() - 86_400_000);
  await drain(f);
  await release(f);
  await f.executedHeads.record(subject, { key: 'f'.repeat(64), origin: 'publication', basis: 'unrelated', stage: 3 });
  await finish(f);
  assert.equal(count(f, 3), 1);
  assert.equal(f.exec.queue.row(884).state, 'STOPPED');
  const after = await f.ledger.usage(f.clock() - 86_400_000);
  assert.equal(after.stage8Retries, before.stage8Retries);
  assert.equal((await f.ledger.pendingFlowEnds()).length, 0, 'an unrelated publication permanently retires this continuation');
  assert.equal(await f.ledger.halted(), null);
});

test('a safe-point continuation still obeys the stage-8 daily retry cap', async t => {
  const f = await fixture(t);
  await drain(f);
  await release(f);
  f.exec.policy = { ...f.exec.policy, park: { ...f.exec.policy.park, stage8RetriesPer24h: 0 } };
  const before = count(f, 8);
  await finish(f);
  assert.equal(count(f, 8), before);
  assert.equal((await f.ledger.open()).length, 0);
  f.exec.policy = { ...f.exec.policy, park: { ...f.exec.policy.park, stage8RetriesPer24h: 100 } };
  await finish(f);
  assert.equal(f.exec.queue.row(884).state, 'DONE');
  assert.equal((await f.ledger.usage(f.clock() - 86_400_000)).stage8Retries, 1);
});

test('unknown cleanup stays HALTed, and a moved head never consumes the continuation', async t => {
  const f = await fixture(t);
  f.companion.archiveLinux = async () => ({ verified: false });
  f.exec.versions = async () => ({ view: { consistent: true, upgrade: { state: 'WAITING_DRAIN' } } });
  await f.drop(Buffer.from(JSON.stringify(intakePauseRequest({ holder: 'resident-upgrade', reason: 'upgrade' }, f.clock))), 'requests');
  await f.exec.tick();
  assert.ok(await f.ledger.halted());
  assert.equal((await f.ledger.pendingFlowEnds()).length, 0);

  const g = await fixture(t);
  await drain(g);
  await release(g);
  g.companion.prHead = async n => ({ number: n, state: 'open', headSha: '4'.repeat(40) });
  const before = count(g, 8);
  await finish(g);
  assert.equal(count(g, 8), before);
  assert.equal((await g.ledger.pendingFlowEnds()).length, 0);
});

test('the PR page describes a flow ending as automatic continuation, with or without the queue snapshot', () => {
  const now = Date.now();
  const base = { writtenAt: now, current: null, pending: [], recent: [{ pr: 884, headSha: HEAD,
    outcome: 'FAILED_CLEAN', code: SUPERSEDED_AT_SAFE_POINT, retry: 'safe-point' }] };
  const pull = { pr: 884, headSha: HEAD, eligible: true };
  assert.match(describe({ pull, status: base, now }).description, /不用推新提交/);
  assert.equal(describe({ pull, status: base, now }).state, 'pending');
  const queued = { ...base, backfill: { complete: true }, pending: [{ pr: 884, headSha: HEAD, state: 'QUEUED', deferred: 'SAFE_POINT_READMISSION' }] };
  assert.match(describe({ pull, status: queued, now }).description, /不用推新提交/);
  base.recent[0].retry = 'new-commit';
  assert.equal(describe({ pull, status: base, now }).state, 'failure');
});

test('real Source job identities: B can reuse its sticky claim and checks only under the same CI Source and S', () => {
  const jobs = (ci, testSha = HEAD) => batchJobsV2({ repo: subject.repo, pr: subject.pr, headSha: HEAD, baseSha: BASE,
    testSha, sourceManifestSha256: ci, attempt: 1, createdAt: '2026-11-16T06:00:00Z' });
  for (const s of [HEAD, '5'.repeat(40)]) {
    const a = jobs('e'.repeat(64), s), b = jobs('e'.repeat(64), s), next = jobs('8'.repeat(64), s);
    assert.equal(batchRefV2(a['control-merge-slot']), batchRefV2(b['control-merge-slot']));
    assert.equal(a.gitleaks.id, b.gitleaks.id);
    assert.notEqual(batchRefV2(a['control-merge-slot']), batchRefV2(next['control-merge-slot']));
    assert.notEqual(a.gitleaks.id, next.gitleaks.id);
  }
  assert.notEqual(batchRefV2(jobs('e'.repeat(64))['control-merge-slot']), batchRefV2(jobs('e'.repeat(64), '5'.repeat(40))['control-merge-slot']));
});

test('#1130 front batch: stage 10 offers H/S once; drain ends it; the identical H/S continues without a second offer or push', async t => {
  let f, ready = false, offered = false;
  const T0 = Date.parse('2026-10-20T12:00:00Z'), S = '5'.repeat(40);
  const front = { pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: '6'.repeat(40),
    claimId: '0a1b2c3d-0000-4000-8000-0000000000aa', since: new Date(T0 - MIN).toISOString(), attempt: 1 };
  const engine = fakeEngine({ train: mode => {
    const offer = mode === 'on' && !offered;
    if (offer) offered = true;
    return { ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: WINDOWS_CLEAN,
      outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: offer ? 1 : 0, mayHavePublished: offer, safeToRerun: false },
      train: trainFacts({ mode, at: new Date(f.clock()).toISOString(), onDuty: true, holders: [], mainSha: BASE, rules: null,
        front: null, revoke: [], ledger: null, sweep: { ...NO_SWEEP, kind: 'full-segment', complete: true,
          fullSweep: { state: 'complete', startedAt: new Date(T0).toISOString(), completedAt: new Date(f.clock()).toISOString(), sinceOn: true, reason: null } },
        ...(offer ? { decision: 'OPEN_FRONT_BATCH', openFrontBatch: front } : {}) }) };
  } });
  const run = engine.runStage, derive = engine.derive;
  engine.runStage = async (batch, stage, opts) => stage.number === 8 && !ready
    ? (engine.calls.push(['stage', 8]), blocked) : run(batch, stage, opts);
  engine.derive = async (...args) => ({ ...await derive(...args), ciSourceManifestSha256: f.exec.policy.ciSourceManifestSha256 });
  f = await executorFixture(t, { engine, now: T0,
    policy: rawPolicy({ contract: POLICY_CONTRACT_V8, train: { ...TRAIN_DEFAULTS, enabled: 'on', nonFrontRuns: true,
      maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, sweep: 'gate' } }),
    companion: fakeCompanion({ pull: n => ({ number: n, state: 'open', headSha: HEAD }) }, () => f.clock()) });
  f.key = batchKey({ ...subject, testSha: S });
  f.ready = () => { ready = true; };
  await f.exec.tick();
  f.advance(MIN);
  await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(f.key)));
  await drain(f);
  await release(f);
  await finish(f);
  assert.equal(f.exec.queue.row(884).state, 'DONE');
  assert.equal(f.exec.queue.row(884).current.testSha, S);
  assert.equal(count(f, 3), 1);
  assert.equal(count(f, 8), 2);
  assert.equal((await f.receipts.latest(['train-front-enqueued'], 10)).length, 1);
});

// FABLE-r3-batch2-gate R3 (item 1): a front's second batch (frontAttempt 2, offered again by stage 10 for the same H/S) is its own
// batch: it never takes over the pending flow end of the first batch, and its subject and key carry attempt 2.
test('R3 front batch 2 of the same H/S: own attempt-2 subject and key, never the pending flow end of front batch 1', async t => {
  let f, offered = false;
  const T0 = Date.parse('2026-10-20T12:00:00Z'), S = '5'.repeat(40);
  const front = { pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, testTree: '6'.repeat(40),
    claimId: '0a1b2c3d-0000-4000-8000-0000000000aa', since: new Date(T0 - MIN).toISOString(), attempt: 1 };
  const engine = fakeEngine({ train: mode => {
    const offer = mode === 'on' && !offered;
    if (offer) offered = true;
    return { ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: WINDOWS_CLEAN,
      outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: offer ? 1 : 0, mayHavePublished: offer, safeToRerun: false },
      train: trainFacts({ mode, at: new Date(f.clock()).toISOString(), onDuty: true, holders: [], mainSha: BASE, rules: null,
        front: null, revoke: [], ledger: null, sweep: { ...NO_SWEEP, kind: 'full-segment', complete: true,
          fullSweep: { state: 'complete', startedAt: new Date(T0).toISOString(), completedAt: new Date(f.clock()).toISOString(), sinceOn: true, reason: null } },
        ...(offer ? { decision: 'OPEN_FRONT_BATCH', openFrontBatch: front } : {}) }) };
  } });
  const run = engine.runStage, derive = engine.derive;
  engine.runStage = async (batch, stage, opts) => stage.number === 8 ? (engine.calls.push(['stage', 8]), blocked) : run(batch, stage, opts);
  engine.derive = async (...args) => ({ ...await derive(...args), ciSourceManifestSha256: f.exec.policy.ciSourceManifestSha256 });
  f = await executorFixture(t, { engine, now: T0,
    policy: rawPolicy({ contract: POLICY_CONTRACT_V8, train: { ...TRAIN_DEFAULTS, enabled: 'on', nonFrontRuns: true,
      maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, sweep: 'gate' } }),
    companion: fakeCompanion({ pull: n => ({ number: n, state: 'open', headSha: HEAD }) }, () => f.clock()) });
  f.key = batchKey({ ...subject, testSha: S });
  await f.exec.tick();
  f.advance(MIN);
  await f.exec.tick();
  await drain(f);
  assert.equal((await f.ledger.pendingFlowEnds()).length, 1, 'front batch 1 left a pending flow end');
  const seen = [];
  f.exec.precheck = async (k, hk, s, opts) => { seen.push({ k, s: { ...s }, flow: opts.flow }); return { defer: 'R3_CAPTURED', perRow: true }; };
  await f.exec.runRow({ pr: 884, headSha: HEAD, baseSha: BASE, testSha: S, frontAttempt: 2, origin: 'queued' }, { releasesByHead: new Map() });
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].s.attempt, seen[0].s.testSha, seen[0].flow], [2, S, null], 'attempt 2, its own S, no flow of batch 1');
  assert.equal(seen[0].k, batchKey({ ...subject, testSha: S, attempt: 2 }));
  assert.notEqual(seen[0].k, f.key);
  assert.equal((await f.ledger.pendingFlowEnds()).length, 1, 'the flow end of batch 1 is left for batch 1');
});

test('legacy upgrade-drain terminal and STOPPED/burned queue row are recovered without editing the PR', async t => {
  const f = await fixture(t);
  await drain(f);
  const file = path.join(f.ledger.dir(key), '90-terminal.json');
  const terminal = JSON.parse(await fs.readFile(file, 'utf8'));
  terminal.facts.retry = 'new-commit';
  await fs.writeFile(file, JSON.stringify(terminal));
  f.exec.queue.settle(884, HEAD, { kind: 'burned', code: SUPERSEDED_AT_SAFE_POINT, klass: 'clean-final' }, f.clock());
  await f.exec.queue.save();
  await release(f);
  await finish(f);
  assert.equal(f.exec.queue.row(884).state, 'DONE');
  assert.equal(count(f, 3), 1);
  assert.equal(count(f, 8), 2);
});

test('a fresh-Source admission refusal consumes its flow predecessor even when the reservation is released', async t => {
  const f = await fixture(t);
  await drain(f);
  await release(f);
  const source = '9'.repeat(64);
  f.exec.policy = { ...f.exec.policy, sourceManifestSha256: source, ciSourceManifestSha256: '8'.repeat(64) };
  f.exec.sourceIntegrity = async () => ({ ok: true, sourceManifestSha256: source, residentManifestSha256: f.exec.policy.residentManifestSha256 });
  const run = f.engine.runStage;
  f.engine.runStage = async (batch, stage, opts) => stage.number === 1
    ? (f.engine.calls.push(['stage', 1]), notAdmitted()) : run(batch, stage, opts);
  await finish(f);
  assert.equal(count(f, 1), 2, 'the rejected flow readmission never gets a second qualification');
  assert.equal(count(f, 3), 1);
  assert.equal((await f.ledger.pendingFlowEnds()).length, 0);
});
