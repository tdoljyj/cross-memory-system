// Offline end-to-end control flow. GitHub/Native are explicit fixture ports;
// enumeration, stores, Resident gate and publisher are the real implementations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, jobOf, sha, iso, T, H, S, TREE, CLAIM, SOURCE, REPO, NOW } from './train-strict-fixtures.mjs';
import { tempDir, admittedFacts } from './resident-v2-fixtures.mjs';
import { batchJobsV2, claimGeneration } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { createFixtureControlPublisherV2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { mergedAsTested } from '../src/independent-control-checks-v2/train-rules.mjs';
import { executorFixture, rawPolicy } from '../../../independent-ci-resident-v1/test/helpers.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../../../independent-ci-resident-v1/src/policy.mjs';
import { trainSummary } from '../../../independent-ci-resident-v1/src/train.mjs';

const scenarios = [];
async function scenario(t, { strictFlip = false, staleGeneration = false } = {}) {
  const e = await setup(t, { strict: true, fullDone: false, tick: 1 });
  const timeline = [], mark = (event, details = {}) => timeline.push({ event, at: iso(e.now), elapsedMs: e.now - NOW, ...details });
  // These checks represent a PR whose tests have already finished and waits at B.
  for (const [i, name] of ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement'].entries()) e.gh.green(10 + i, H, { name });
  e.gh.world.behindHeads = new Set();
  for (let i = 1; i <= 25; i++) {
    const head = sha(0x9000 + i); e.gh.world.behindHeads.add(head);
    e.gh.pull(i, { head, state: 'closed', commits: [head] }); e.gh.green(100 + i, head);
  }
  const eligible = sha(0xa001);
  e.gh.pull(100, { head: eligible, state: 'closed', commits: [eligible] }); e.gh.green(200, eligible);
  mark('tested-pr-waiting-at-B', { pr: 910, headSha: H, testedSha: S });
  const job = jobOf({ onSince: iso(NOW) });
  const run = await e.run(job), facts = run.facts;
  mark('source-maintenance-completed', { decision: facts.decision, coverage: facts.sweep.strictCoverage?.state,
    fullState: facts.sweep.fullSweep.state, fullSinceOn: facts.sweep.fullSweep.sinceOn,
    highLevelPortCalls: facts.sweep.calls, confirmedRevocations: facts.sweep.revoked });
  assert.equal(facts.sweep.strictCoverage?.state, 'ready');
  assert.equal(facts.sweep.fullSweep.sinceOn, false);
  assert.equal((await e.store.latestProof()).fullSweepSinceOn, false, 'old readers keep waiting');
  assert.equal(e.gh.world.checks.get(200).conclusion, 'failure', 'closed eligible old head actually revoked');
  assert.ok(facts.openFrontBatch, JSON.stringify(facts));
  const train = { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 600_000, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS,
    frontBatchBudgetMs: job.frontBatchBudgetMs, slotHardCapMinutes: job.slotHardCapMinutes,
    sweepFreshMs: job.sweepFreshMs, fullSweepMaxMs: job.fullSweepMaxMs, sweep: 'gate' };
  const resident = await executorFixture(t, { now: NOW, policy: rawPolicy({ contract: POLICY_CONTRACT_V8, train, sourceManifestSha256: SOURCE }) });
  resident.advance(e.now - NOW);
  const summary = trainSummary(facts); assert.ok(summary);
  await resident.exec.trainActed(summary, { mode: 'on', input: { onSince: iso(NOW) }, frontOutcome: null, frontCleared: false, revokeHead: null });
  assert.equal(resident.exec.trainTakeoverDone, false);
  assert.equal(resident.exec.trainGate(facts.openFrontBatch), null, 'actual enqueued S can pass limited gate');
  assert.ok(resident.exec.trainGate({ ...facts.openFrontBatch, testSha: sha(0xffff) }), 'another row stays held');
  mark('resident-resumed-exact-front', { frontReadyMode: resident.exec.trainStatus().frontReadyMode, fullPending: true });

  if (strictFlip) e.gh.world.strict = false;
  const batch = { claimId: CLAIM, fence: 3, epoch: 1, expiresAt: iso(e.now + 3600_000) };
  const current = staleGeneration ? { ...batch, fence: 4, epoch: 2 } : batch;
  const jobs = batchJobsV2({ repo: REPO, pr: 910, headSha: H, baseSha: T, testSha: S,
    sourceManifestSha256: SOURCE, createdAt: iso(e.now), attempt: 1 });
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const publisher = createFixtureControlPublisherV2({ github: e.gh, journal, trainMode: 'on', batchClaim: claimGeneration(batch),
    slotNative: e.native.port, sweepStore: e.store, greenLedger: e.ledger,
    pullsUpdatedSince: cursor => e.gh.readPullsUpdatedSince(cursor),
    admission: { async evaluatePr(job, packet, options) { return admittedFacts(job, current, packet,
      { domain: 'fixture', mergeQueueHead: true, batchClaim: options?.batchClaim, observedAt: e.now, slotUntil: e.now + 600_000 }); } },
    assertLive() {}, record() {}, authority: {}, clock: e.clock, sleep: e.sleep });
  const result = await publisher.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: e.now + 90_000 });
  mark('stage8-publication', { status: result.status, reason: result.reason ?? null });
  if (strictFlip || staleGeneration) {
    assert.equal(result.status, 'BLOCKED');
    assert.equal([...e.gh.world.checks.values()].some(c => c.head_sha === H && c.name === 'kooyumi-merge-slot' && c.conclusion === 'success'), false);
  } else {
    assert.equal(result.status, 'SETTLED', JSON.stringify(result));
    const slot = [...e.gh.world.checks.values()].find(c => c.head_sha === H && c.name === 'kooyumi-merge-slot' && c.conclusion === 'success');
    assert.ok(slot, 'real publisher created the front green');
    const mergeSha = sha(0xb001), merge = { sha: mergeSha, tree: TREE, parents: [T, H] };
    e.gh.world.pulls.get(910).merged = true; e.gh.world.pulls.get(910).state = 'closed'; e.gh.world.pulls.get(910).mergeCommitSha = mergeSha;
    e.gh.world.commits.set(mergeSha, merge);
    assert.equal(mergedAsTested({ pull: await e.gh.readPullRequest(910), mergeCommit: merge, job: jobs['control-merge-slot'], testTree: TREE }), true);
    mark('fixture-merged-as-tested', { mergeSha });
  }
  const report = { scenario: strictFlip ? 'live-strict-off' : staleGeneration ? 'old-batch-new-generation' : 'start-with-tested-waiting-pr',
    classification: 'OFFLINE_REAL_IMPLEMENTATIONS_WITH_FIXTURE_GITHUB_NATIVE', timeline, elapsedMs: e.now - NOW,
    highLevelPortCalls: e.gh.world.calls.length, httpRequests: null,
    limits: ['fixture network latency only; not a production completion bound', 'port calls are not HTTP or GraphQL cost', 'full sweep remains incomplete'] };
  scenarios.push(report);
}

test('generation16 offline: tested waiting PR -> real coverage -> exact Resident front -> Stage8 green -> merge', t => scenario(t));
test('generation16 offline: live strict off rejects the same limited certificate', t => scenario(t, { strictFlip: true }));
test('generation16 offline: old batch is rejected after claim generation changes', t => scenario(t, { staleGeneration: true }));
test.after(async () => {
  if (process.env.GEN16_OFFLINE_REPORT) await fs.writeFile(process.env.GEN16_OFFLINE_REPORT, JSON.stringify({ scenarios }, null, 2) + '\n');
});
