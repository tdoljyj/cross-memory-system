import test from 'node:test';
import assert from 'node:assert/strict';
import { drill, probe } from './merge-train-rollout-db.test.mjs';
import { makeJobV2 } from '../../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { createFixtureControlPublisherV2 } from '../../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';
import { createSharedTrainPorts } from '../../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-shared-ports.mjs';

const APP = 5368905, MAIN_RS = 24182890, FF_RS = 27500001;

test('列车 v2：两个节点同时看到新 PR，A 停止推进后 B 通过签名网关接手同一批', async t => {
  const d = await drill(t);
  const [a, b] = await Promise.all([d.addNode('stage8-a'), d.addNode('stage8-b')]);
  await d.enableV2();
  const subject = d.head();
  await d.authorize(subject);
  assert.deepEqual(await Promise.all([a, b].map(node => probe(d, node).then(value => value.on_duty))), [true, true]);
  const staged = await d.joinAndStage(a, subject);
  const held = await d.command(a, 'batch_acquire', { batchId: staged.batchId });
  const reserved = await d.command(a, 'landing_prepare', { batchId: staged.batchId, generation: held.generation,
    generationRefOid: staged.generationRefOid, successorRefOid: d.sha('abandoned landing marker'),
    requiredRunsSha256: staged.requiredRunsSha256, evidence_digest: d.digest('reserved before takeover') });
  assert.equal(reserved.state, 'reserved', JSON.stringify(reserved));
  const { config, transport } = await d.protectedTransport(b);
  const front = staged.members[0];
  const expected = { pr: front.pr, headSha: front.headSha, baseSha: staged.baseSha, testSha: staged.testSha };
  let refs = { mainSha: staged.baseSha, stagingSha: staged.testSha, generationRefOid: staged.generationRefOid };
  let green = false;
  const rules = [
    { type: 'required_status_checks', rulesetId: MAIN_RS, parameters: { strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'kooyumi-train-landed', integration_id: APP },
        ...staged.runs.map(run => ({ context: run.checkName, integration_id: run.appId }))] } },
    { type: 'non_fast_forward', rulesetId: FF_RS }, { type: 'deletion', rulesetId: FF_RS },
  ];
  const gh = {
    async readBranchRules(branch) { return { branch, complete: true, rules }; },
    async readRuleset(id) { return { id, currentUserCanBypass: id === MAIN_RS ? 'always' : 'never' }; },
    async readRuleBypass(id) { return id === FF_RS ? [] : [{ actor_id: APP, actor_type: 'Integration', bypass_mode: 'always' }]; },
    async readGitCommit(sha) { return { sha, tree: staged.treeSha, parents: [staged.baseSha, front.headSha] }; },
    async readPullRequest(number) {
      return { number, state: 'open', draft: false, merged: false, head: { sha: front.headSha, repo: { full_name: config.repository } },
        base: { ref: 'main', sha: staged.baseSha, repo: { full_name: config.repository } } };
    },
    async readChecks(sha) {
      assert.equal(sha, staged.testSha);
      return { complete: true, checks: staged.runs.map(run => ({ id: run.checkRunId, name: run.checkName,
        app: { id: run.appId }, head_sha: sha, status: green ? 'completed' : 'in_progress', conclusion: green ? 'success' : null })) };
    },
    async readTrainRun({ runId, testSha, attempt, workflow }) {
      const run = staged.runs.find(row => row.runId === runId && row.testSha === testSha && row.attempt === attempt && row.workflow === workflow);
      assert.ok(run);
      return { jobs: [{ name: run.checkName, checkRunId: run.checkRunId, status: 'completed', conclusion: 'success' }] };
    },
  };
  const port = {
    async readTrainRefs() { return refs; },
    async createGenerationMarker({ effectId }) { return d.sha(effectId); },
    async landIntent(intent) {
      return d.github.write('main CAS', () => {
        assert.deepEqual([intent.baseSha, intent.testSha, intent.generationRefOid], [refs.mainSha, refs.stagingSha, refs.generationRefOid]);
        refs = { ...refs, mainSha: intent.testSha, generationRefOid: intent.landedRefOid };
        return refs;
      }, value => ['mainUpdates', value.mainSha, b.id]);
    },
  };
  const shared = createSharedTrainPorts({ transport, config, github: gh, landing: port, clock: d.clock.now });
  assert.equal(await shared.readBatch(expected), null, 'A 仍持有本代，B 未获写权');
  assert.equal(await shared.readBatch({ ...expected, headSha: d.sha('unrelated') }), null);
  await d.db.admin.query(`update clued_private.ci_train_batches_v2 set expires_at=clock_timestamp()-interval '1 millisecond'
    where batch_id=$1 and generation=$2`, [staged.batchId, held.generation]);
  const jobs = ['control-admission', 'control-merge-slot'].map(role => makeJobV2({ ...expected, repo: config.repository, role,
    sourceManifestSha256: d.source, createdAt: new Date(d.clock.now()).toISOString(), attempt: 1 }));
  const publisher = createFixtureControlPublisherV2({ github: gh, journal: {}, admission: {}, assertLive() {}, record() {},
    trainV2: shared, landing: port, trainMode: 'on', trainLanding: { landing: 'push' }, clock: d.clock.now });
  try {
    const waiting = await publisher.publishPair(jobs, { waitUntil: d.clock.now() + 30_000 });
    assert.equal(waiting.reason, 'TRAIN_LANDING_CHECKS_PENDING', JSON.stringify(waiting));
  } finally { await shared.release(); }
  assert.equal(d.github.totals().mainUpdates, 0);
  const former = await d.one(d.db.admin, 'select state,observation from clued_private.ci_train_landing_v2 where effect_key=$1',
    [reserved.effect_key]);
  assert.deepEqual(former, { state: 'revoked', observation: null });
  const oldSend = await d.command(a, 'landing_send', { batchId: staged.batchId, generation: held.generation, effect_key: reserved.effect_key });
  assert.equal(oldSend.error_code, 'ci_work_lease_stale', JSON.stringify(oldSend));
  d.github.emit('checks-completed', staged.testSha);
  await d.github.deliver('checks-completed', async testSha => { assert.equal(testSha, staged.testSha); green = true; });
  d.github.arm('main CAS', { loseReply: true });
  try {
    const result = await publisher.publishPair(jobs, { waitUntil: d.clock.now() + 30_000 });
    assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  } finally { await shared.release(); }
  const landed = await d.command(b, 'batch_acquire', { batchId: staged.batchId });
  assert.ok(landed.generation > held.generation);
  assert.equal(landed.state, 'landed');
  await shared.reconcileBatch(landed);
  const done = await d.command(b, 'batch_read', { batchId: staged.batchId });
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.requiredRuns, staged.requiredRuns);
  assert.deepEqual(d.github.totals().stagingUpdates, 1);
  assert.deepEqual(d.github.effects().filter(effect => effect.kind === 'mainUpdates').map(effect => [effect.subject, effect.node]), [[staged.testSha, b.id]]);
});
