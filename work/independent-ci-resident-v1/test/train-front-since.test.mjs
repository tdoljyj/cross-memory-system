// Replay #1144 with real Stage 10, durable stores and Stage 8; offline Native/GitHub ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup, jobOf, iso, T, H, S, CLAIM, SOURCE, REPO } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { tempDir, admittedFacts } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { batchJobsV2, claimGeneration } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { createFixtureControlPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';
import { strictFrontHeadDecision } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-rules.mjs';

const OLD = '2026-11-17T01:20:39.631Z', NEW = '2026-11-17T01:21:39.958Z';
async function world(t) {
  const e = await setup(t, { strict: true, fullDone: false, tick: 1,
    native: { holder: { takenAt: OLD, mergeSlotUntil: '2026-11-17T01:30:00.000Z' } } });
  e.now = Date.parse('2026-11-17T01:21:38.528Z');
  e.native.port.nodesStatus = async () => ({ deployed: true, onDuty: true, dropped: 0,
    nodes: [{ node: { name: 'turing', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(e.now) } }] });
  e.round = () => e.run(jobOf({ createdAt: iso(e.now), onSince: '2026-11-17T01:00:00.000Z' }));
  return e;
}
async function publish(t, e, { generation = false, testSha = S } = {}) {
  for (const [i, name] of ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement'].entries()) e.gh.green(10 + i, H, { name });
  const batch = { claimId: CLAIM, fence: 3, epoch: 1, expiresAt: iso(e.now + 3600_000) };
  const current = generation ? { ...batch, fence: 4, epoch: 2 } : batch;
  const jobs = batchJobsV2({ repo: REPO, pr: 910, headSha: H, baseSha: T, testSha,
    sourceManifestSha256: SOURCE, createdAt: iso(e.now), attempt: 1 });
  const p = createFixtureControlPublisherV2({ github: e.gh, journal: await EffectJournal.open(path.join(await tempDir(t), 'effects')),
    trainMode: 'on', batchClaim: claimGeneration(batch), slotNative: e.native.port, sweepStore: e.store, greenLedger: e.ledger,
    pullsUpdatedSince: cursor => e.gh.readPullsUpdatedSince(cursor),
    admission: { async evaluatePr(job, packet, options) {
      const { observationSha256, ...facts } = admittedFacts(job, current, packet,
        { domain: 'fixture', mergeQueueHead: true, batchClaim: options?.batchClaim, observedAt: e.now, slotUntil: e.now + 600_000 });
      return { ...facts, observationSha256: digest(facts) };
    } }, assertLive() {}, record() {}, authority: {}, clock: e.clock, sleep: e.sleep });
  return p.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: e.now + 90_000 });
}

test('#1144: running front reanchors its exact tested batch after Native rewrites takenAt', async t => {
  const e = await world(t);
  assert.ok((await e.round()).facts.openFrontBatch);
  assert.equal((await e.store.frontBatches({ pr: 910, headSha: H }))[0].since, OLD);
  e.now = Date.parse(NEW);
  e.native.holder = { ...e.native.holder, takenAt: NEW };
  assert.notEqual((await publish(t, e)).status, 'SETTLED', 'old proof cannot authorize a new front timestamp');
  e.now += 600_000;
  const refreshed = await e.round();
  assert.equal(refreshed.facts.decision, 'TRAIN_FRONT_BATCH_RUNNING');
  assert.equal(refreshed.facts.openFrontBatch, null, 'no duplicate execution');
  const fronts = await e.store.frontBatches({ pr: 910, headSha: H });
  assert.deepEqual(fronts.map(f => [f.since, f.attempt, f.testSha]), [[NEW, 1, S]]);
  assert.equal((await publish(t, e)).status, 'SETTLED', 'fresh proof and refreshed record settle the same S');
});

test('#1144: touch read-back records the new timestamp; repeated refreshes spend no front attempts', async t => {
  const e = await world(t), touch = e.native.port.touch;
  e.native.port.touch = async input => {
    const result = await touch(input);
    if (input.ciState === 'running') { e.now = Date.parse(NEW); e.native.holder = { ...e.native.holder, takenAt: NEW }; }
    return result;
  };
  assert.equal((await e.round()).facts.openFrontBatch?.since, NEW, 'record the post-touch holder');
  assert.notEqual((await publish(t, e)).status, 'SETTLED', 'pre-touch certificate remains invalid');
  for (let i = 0; i < 3; i++) {
    e.now += 600_000;
    e.native.holder = { ...e.native.holder, takenAt: iso(e.now - 1000) };
    assert.equal((await e.round()).facts.decision, 'TRAIN_FRONT_BATCH_RUNNING');
    assert.equal((await e.store.frontBatches({ pr: 910, headSha: H })).length, 1);
  }
  assert.equal((await publish(t, e)).status, 'SETTLED');
});

test('#1144: refreshed proof still refuses a different claim generation or tested commit', async t => {
  for (const changed of ['generation', 'testSha', 'claim', 'head', 'main', 'tree']) await t.test(changed, async t => {
    const e = await world(t); await e.round();
    e.now += 600_000; e.native.holder = { ...e.native.holder, takenAt: NEW };
    await e.round();
    const claim = { claimId: CLAIM, fence: 3, epoch: 1, expiresAt: iso(e.now + 3600_000) };
    const front = (await e.store.frontBatches({ pr: 910, headSha: H }))[0];
    const args = { job: batchJobsV2({ repo: REPO, pr: 910, headSha: H, baseSha: T, testSha: S,
      sourceManifestSha256: SOURCE, createdAt: iso(e.now), attempt: 1 })['control-merge-slot'],
      holders: await e.native.port.holders(), frontProof: await e.store.latestStrictFrontProof(), proof: await e.store.latestProof(),
      fullState: await e.store.readFullSweepStrict(), front, ledger: await e.ledger.list(), now: e.now,
      liveRules: { strict: true, requiredPinned: true }, liveMainSha: T, observedClaim: claimGeneration(claim), batchClaim: claimGeneration(claim),
      testTree: front.testTree, nativeMode: 'normal', sourceHealthy: true, storeHealthy: true };
    assert.equal(strictFrontHeadDecision(args), null, 'the repaired exact subject is proven');
    if (changed === 'claim') args.holders.holders = [{ ...e.native.holder, claimId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }];
    if (changed === 'head') args.job = { ...args.job, headSha: '9'.repeat(40) };
    if (changed === 'main') args.liveMainSha = '9'.repeat(40);
    if (changed === 'tree') args.testTree = '9'.repeat(40);
    if (changed === 'testSha') args.job = { ...args.job, testSha: '8'.repeat(40) };
    if (changed === 'generation') args.observedClaim = { ...args.observedClaim, fence: 4, epoch: 2 };
    assert.equal(strictFrontHeadDecision(args), 'TRAIN_SINGLE_GREEN_NOT_PROVEN');
  });
});

test('#1144: an unconfirmed timestamp refresh never replaces the durable tested record', async t => {
  for (const failure of ['race', 'write']) await t.test(failure, async t => {
    const e = await world(t); await e.round();
    e.now += 600_000; e.native.holder = { ...e.native.holder, takenAt: NEW };
    if (failure === 'write') e.store.appendFrontBatch = async () => { throw Error('disk-full'); };
    else {
      const holders = e.native.port.holders;
      let reads = 0;
      e.native.port.holders = async () => {
        const result = await holders();
        if (++reads > 1) return { ...result, holders: [{ ...e.native.holder, takenAt: iso(e.now) }] };
        return result;
      };
    }
    const r = await e.round();
    assert.equal(r.facts.decision, 'TRAIN_FRONT_BUDGET_SHORT');
    assert.equal(r.facts.openFrontBatch, null);
    assert.equal((await e.store.frontBatches({ pr: 910, headSha: H }))[0].since, OLD);
  });
});

test('#1144: a regenerated merge with the same tree never replaces the original tested S', async t => {
  const e = await world(t); await e.round();
  const replacement = '9'.repeat(40), original = e.gh.world.commits.get(S);
  e.gh.world.commits.set(replacement, { ...original, sha: replacement });
  e.gh.world.pulls.get(910).mergeCommitSha = replacement;
  e.now += 600_000; e.native.holder = { ...e.native.holder, takenAt: NEW };
  assert.equal((await e.round()).facts.decision, 'TRAIN_FRONT_BATCH_RUNNING');
  const [record] = await e.store.frontBatches({ pr: 910, headSha: H });
  assert.deepEqual([record.since, record.testSha, record.testTree, record.attempt], [NEW, S, original.tree, 1]);
  assert.notEqual((await publish(t, e, { testSha: replacement })).status, 'SETTLED');
});
