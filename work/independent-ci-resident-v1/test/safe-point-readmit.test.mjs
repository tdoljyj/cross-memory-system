import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor, SUPERSEDED_AT_SAFE_POINT } from '../src/executor.mjs';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { RunQueue } from '../src/queue.mjs';
import { intakePauseRequest, intakeResumeRequest } from '../src/intake-pause.mjs';
import { describe } from '../src/pr-status.mjs';
import { batchJobsV2, batchRefV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { NO_SWEEP, trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { executorFixture, fakeEngine, fakeCompanion, holdAtA, notAdmitted, rawPolicy, triggerBytes, HEAD, BASE, SOURCE, WINDOWS_CLEAN } from './helpers.mjs';

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
