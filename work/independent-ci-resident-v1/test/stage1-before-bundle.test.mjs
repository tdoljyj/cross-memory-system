// FABLE-ci-10min-20261119 §3.2 P1c (T2): an ordinary batch runs its stage 1 (the admission check, the hosted jobs' gate) before its
// bundle, so the check is out a bundle's time earlier (45-105 s in the field; #1172: 104 s). The bundle still comes before the head is
// burned: a bundle failure releases the reservation as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ResidentExecutor } from '../src/executor.mjs';
import { RunQueue } from '../src/queue.mjs';
import { headKey } from '../src/ledger.mjs';
import { BASE, CI_SOURCE, HEAD, WINDOWS_CLEAN, executorFixture, fakeEngine, notAdmitted, triggerBytes } from './helpers.mjs';
import { batchJobsV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../../actions-hosted-migration/independent-ci-v1/src/batch-claim-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/formal-work-admission-check-v2/publisher.mjs';
import { outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { tempDir, admittedFacts } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';

const BUNDLE_MS = 90_000;
// The companion's bundle, slowed to BUNDLE_MS of the fixture clock; what the receipts said when it started and when it ended.
function slowBundle(f, answer = { ok: true }) {
  const seen = [];
  f.companion.buildBundle = async () => {
    f.companion.calls.push(['bundle']);
    const startedAt = f.clock();
    f.advance(BUNDLE_MS);
    seen.push({ startedAt, endedAt: f.clock(), stage1: (await f.receipts.latest(['stage-terminal'], 50)).map(e => e.value).filter(v => v.body.stage === 1) });
    return answer;
  };
  return seen;
}

test('P1c: a bundle the stand-in drags out 90 s: stage 1\'s receipt is written before the bundle ends (before the fix: after it)', async t => {
  const f = await executorFixture(t);
  const seen = slowBundle(f);
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.equal(seen.length, 1, 'one bundle');
  const [b] = seen;
  assert.equal(b.stage1.length, 1, 'stage 1 had ended when the bundle started');
  assert.equal(b.stage1[0].body.ok, true);
  assert.ok(Date.parse(b.stage1[0].at) <= b.startedAt && b.startedAt + BUNDLE_MS === b.endedAt,
    `stage 1 receipt at ${b.stage1[0].at}, bundle ${new Date(b.startedAt).toISOString()}..${new Date(b.endedAt).toISOString()}`);
  const stages = f.engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
  assert.deepEqual(stages, [1, 2, 3, 4, 5, 6, 7, 8], 'the rest of the batch as before');
});

test('P1c: a bundle that fails after stage 1 releases the reservation (not executed, the head not burned), as a bundle failure did before', async t => {
  const f = await executorFixture(t);
  const seen = slowBundle(f, { ok: false });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(seen.length, 1);
  assert.deepEqual([r.state, r.failureCode], ['NOT_EXECUTED', 'BUNDLE_UNAVAILABLE']);
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'stage').map(c => c[1]), [1], 'stage 1 ran, nothing after it');
  assert.equal((await f.receipts.latest(['batch-started'], 10)).length, 0, 'the head was never burned');
  assert.equal((await f.receipts.latest(['batch-unexecuted'], 10)).length, 1);
});

test('P1c: stage 1 not admitted: no bundle is built for nothing', async t => {
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 1: notAdmitted() } }) });
  const seen = slowBundle(f);
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'NOT_ADMITTED');
  assert.equal(seen.length, 0, 'the refusal came before any bundle');
});

// ---- FABLE-ci-10min §8.2: stage 1 published, the bundle failed, the batch was released: the same head's retry ----
// The real Source v2 work-admission publisher answers stage 1 (no stand-in decides it): a fresh publisher per stage run, as each stage is
// its own process, over the node's persistent Source state (state\v2\batch-claims, state\v2\effects-work-admission), of which the
// resident's close archives nothing. Only GitHub and Native are fakes (the publisher's own fixture ports). The job's createdAt is the
// derivation time, as engine-windows.mjs#derive writes it.
const MIN = 60_000;
const REPO = 'tdoljyj/cross-memory-system';
function githubWorld() {
  const checks = []; let next = 1000;
  return { fixture: true, checks,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async readAppChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head && c.app.id === 5368905).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}
async function realStageOne(t) {
  const github = githubWorld(), claimsDir = await tempDir(t), effectsDir = path.join(await tempDir(t), 'effects');
  const claim = { claimId: '0a1b2c3d-0000-4000-8000-0000000000aa', fence: 3, epoch: 1, expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() };
  const batchClaims = { read: async j => { try { return await readBatchClaim(claimsDir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } },
    record: (j, c, at) => recordBatchClaim(claimsDir, j, c, at) };
  const admission = { fixture: true, async evaluatePr(job, packet) { return admittedFacts(job, claim, packet, { domain: 'fixture' }); } };
  const results = [];
  // Stage 1 of a batch, as the entry runs it and the stage fact carries its ending to the resident (stage-inputs.mjs#writeOutcome,
  // stage-fact.mjs#outcomeFailureCode).
  const run = async subject => {
    const job = batchJobsV2({ repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.headSha,
      sourceManifestSha256: CI_SOURCE, createdAt: subject.derivedAt, attempt: subject.attempt })['work-admission'];
    const pub = createFixtureWorkAdmissionPublisherV2({ github, journal: await EffectJournal.open(effectsDir), admission, assertLive() {}, record() {}, authority: {}, batchClaims });
    const r = await pub.publish(job);
    results.push({ jobId: job.id, status: r.status, reason: r.reason ?? null, sideEffects: r.sideEffects });
    const outcome = { status: r.status, reason: r.reason ?? null, sideEffects: r.sideEffects, mayHavePublished: !(r.status === 'BLOCKED' && r.sideEffects === 0),
      diagnostic: null, scheduling: null, safeToRerun: r.safeToRerun === true };
    return r.status === 'SETTLED' ? { ok: true, factsSha256: 'd'.repeat(64), proof: WINDOWS_CLEAN, outcome }
      : { ok: false, code: outcomeFailureCode(outcome, 1), proof: WINDOWS_CLEAN, outcome };
  };
  return { github, results, run };
}
function engineWith(stageOne) {
  const engine = fakeEngine(), subjects = new Map(), derive = engine.derive, runStage = engine.runStage;
  engine.derive = async (subject, key, ...rest) => { subjects.set(key, { ...subject, derivedAt: new Date(Date.now() - 1000).toISOString() }); return derive(subject, key, ...rest); };
  engine.runStage = async (batch, stage, o) => {
    if (stage.number !== 1) return runStage(batch, stage, o);
    engine.calls.push(['stage', 1]);
    return stageOne.run(subjects.get(batch.key));
  };
  return engine;
}

for (const restart of [true, false]) test(`§8.2 P1c end to end (real publisher): stage 1 settled, the bundle failed, released; the same head's retry passes stage 1 and goes on to stage 2 (restart ${restart})`, async t => {
  const stageOne = await realStageOne(t);
  const f = await executorFixture(t, { engine: engineWith(stageOne) });
  let bundles = 0;
  f.companion.buildBundle = async () => { f.companion.calls.push(['bundle']); return ++bundles === 1 ? { ok: false } : { ok: true }; };
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.deepEqual([first.state, first.failureCode], ['NOT_EXECUTED', 'BUNDLE_UNAVAILABLE']);
  assert.deepEqual(stageOne.results.map(r => [r.status, r.sideEffects]), [['SETTLED', 1]], 'stage 1 published the admission check');
  assert.equal(stageOne.github.checks.filter(c => c.name === 'kooyumi-work-admission').length, 1);
  const subject = { repo: REPO, pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: f.exec.policy.sourceManifestSha256, attempt: 1 };
  assert.equal(await f.ledger.headBurned(headKey(subject)), false, 'released, the head not burned');
  // The service restarts: a new executor over the same state (the run queue read back from its file); or the same executor goes on.
  const exec = restart ? new ResidentExecutor({ ...f.ports, queue: await RunQueue.open(path.join(f.root, 'state', 'queue'), f.clock) }) : f.exec;
  let second = null;
  for (let m = 0; m < 45 && second?.state !== 'COMPLETED' && second?.state !== 'HALTED'; m++) { f.advance(MIN); second = await exec.tick(); }
  t.diagnostic(`stage-1 runs ${JSON.stringify(stageOne.results)}; checks ${stageOne.github.checks.length}`);
  assert.equal(stageOne.results.length, 2, 'stage 1 ran again on the same head');
  assert.deepEqual([stageOne.results[1].status, stageOne.results[1].reason], ['SETTLED', null], 'the retry passes stage 1 (no HEAD_INTERRUPTED_ON_GITHUB / HEAD_PUBLISHED_ON_GITHUB)');
  assert.ok(f.engine.calls.some(c => c[0] === 'stage' && c[1] === 2), 'and goes on to stage 2');
  assert.equal(second.state, 'COMPLETED', JSON.stringify(second));
});
