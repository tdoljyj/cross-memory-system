import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AdmissionRerunner, AdmissionRerunState } from '../src/admission-rerun.mjs';
import { executorFixture, fakeEngine, triggerBytes, CI_SOURCE, WINDOWS_CLEAN } from './helpers.mjs';
import { setup, iso, T, S, TREE, CLAIM, REPO, NOW } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { admittedFacts } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { batchJobsV2, claimGeneration } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { createFixtureControlPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';
import { writeOutcome } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-inputs.mjs';
import { outcomeFacts, outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';

const PR = 1159, HEAD = 'be149834bd809e697d9ec41f22302cbc72e7eae6', RUN = 44277214142, MIGRATION = 134709790262;
const WORKFLOW = 100;

test('E9: #1159 recovers from parking B on the same head with one rerun and no push', async t => {
  const e = await setup(t, { strict: true });
  const github = e.gh;
  github.pull(PR, { head: HEAD, mergeCommitSha: S });
  github.world.commits.set(HEAD, { sha: HEAD, tree: TREE, parents: [T] });
  github.world.commits.set(S, { sha: S, tree: TREE, parents: [T, HEAD] });
  const nativeAdmission = { name: 'kooyumi-work-admission', summary: `Independent Native control check for ${REPO}#${PR}` };
  github.green(10, HEAD, nativeAdmission);
  github.world.checks.get(10).external_id = `independent-ci:native-work-admission:${'3'.repeat(64)}:f3:e1:a1`;
  for (const [id, name] of [[134709790258, 'clued-cloud-tests'], [134709790321, 'ci-suites'], [MIGRATION, 'migration-verify']]) {
    github.green(id, HEAD, { name, app: 15368, conclusion: id === MIGRATION ? 'cancelled' : 'success' });
  }
  const rules = github.readBranchRules;
  github.readBranchRules = async () => {
    const result = await rules();
    result.rules[1].parameters.required_status_checks.push(...['clued-cloud-tests', 'ci-suites', 'migration-verify']
      .map(context => ({ context, integration_id: 15368 })));
    return result;
  };
  const pull = github.readPullRequest;
  github.readPullRequest = async pr => {
    const p = await pull(pr);
    p.head.repo = p.base.repo = { full_name: REPO };
    return p;
  };
  const actions = { id: RUN, workflow_id: WORKFLOW, head_sha: HEAD, event: 'pull_request', status: 'completed', run_attempt: 1, pull_requests: [{ number: PR }] };
  const mutations = [], pushes = [];
  const gh = {
    repo: REPO,
    async get(route) {
      if (route === `/pulls/${PR}`) return github.readPullRequest(PR);
      if (route === `/actions/runs/${RUN}`) return { ...actions };
      if (route.startsWith(`/actions/workflows/${WORKFLOW}/runs?`)) return { total_count: 0, workflow_runs: [] };
      assert.fail(route);
    },
    async paged(route) {
      if (route === '/rules/branches/main') return (await github.readBranchRules()).rules;
      if (route === `/commits/${HEAD}/check-runs?filter=all`) return (await github.readChecks(HEAD)).checks;
      if (route === `/actions/runs?head_sha=${HEAD}`) return [{ ...actions }];
      if (route === `/commits/${HEAD}/pulls`) return [await github.readPullRequest(PR)];
      if (route === `/commits/${HEAD}/check-runs?check_name=kooyumi-work-admission&filter=all`) return [github.world.checks.get(10)];
      if (route === `/check-runs/${MIGRATION}/annotations`) return [{ message: 'The job has exceeded the maximum execution time of 30m0s' }];
      const attempt = /^\/actions\/runs\/44277214142\/attempts\/([12])\/jobs$/.exec(route)?.[1];
      assert.ok(attempt, route);
      return [[134708288469, 'admission-gate'], [134709790258, 'clued-cloud-tests'], [MIGRATION, 'migration-verify'], [134709790321, 'ci-suites']]
        .map(([id, name]) => {
          const conclusion = id === MIGRATION && attempt === '1' ? 'cancelled' : 'success';
          return { id, name, head_sha: HEAD, status: 'completed', conclusion, completed_at: '2026-11-18T10:08:17Z',
            steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Verify migrations', conclusion }] };
        });
    },
    async text(route) {
      assert.equal(route, `/actions/jobs/${MIGRATION}/logs`);
      return 'Running migration verification\nThe operation was canceled.';
    },
    async rerun(runId) {
      mutations.push(['rerun', runId, actions.run_attempt + 1]);
      actions.run_attempt += 1;
      actions.status = 'queued';
      return { outcome: 'sent' };
    },
    async dispatch(ref) {
      mutations.push(['dispatch', ref]);
      return { outcome: 'sent' };
    },
  };
  const engine = fakeEngine();
  const runStage = engine.runStage;
  const f = await executorFixture(t, { engine, now: NOW });
  const claim = { claimId: CLAIM, fence: 3, epoch: 1, expiresAt: iso(NOW + 3_600_000) };
  const journal = await EffectJournal.open(path.join(f.root, 'effects'));
  const jobs = batchJobsV2({ repo: REPO, pr: PR, headSha: HEAD, baseSha: T, testSha: HEAD, sourceManifestSha256: CI_SOURCE, createdAt: iso(NOW), attempt: 1 });
  const publisher = createFixtureControlPublisherV2({
    github, journal, trainMode: 'off', batchClaim: claimGeneration(claim), clock: f.clock, slotNative: e.native.port,
    landing: { async fastForwardMain(sha) { pushes.push(sha); return { status: 200 }; } },
    assertLive() {}, record() {}, authority: {},
    admission: { async evaluatePr(job, packet, options) {
      const { observationSha256, ...facts } = admittedFacts(job, claim, packet, { domain: 'fixture', mergeQueueHead: true,
        batchClaim: options.batchClaim, observedAt: f.clock(), slotUntil: f.clock() + 600_000 });
      return { ...facts, observationSha256: digest(facts) };
    } },
  });
  engine.runStage = async (batch, stage, options) => {
    const ok = await runStage(batch, stage, options);
    if (stage.number !== 8) return ok;
    const pair = [jobs['control-admission'], jobs['control-merge-slot']];
    const result = await publisher.publishPair(pair, { waitUntil: f.clock() + 90_000 });
    const outcome = await writeOutcome({ receiptsRoot: path.join(f.root, 'source-outcomes'), nonce: String(actions.run_attempt).repeat(32),
      plan: { stage: 8, entryRole: 'control-publisher' }, jobIds: pair.map(j => j.id), result, clock: f.clock });
    return outcome.status === 'SETTLED' ? ok : { ok: false, code: outcomeFailureCode(outcome, 8), outcome: outcomeFacts(outcome), proof: WINDOWS_CLEAN };
  };

  await f.drop(triggerBytes({ pr: PR, headSha: HEAD, baseSha: T }));
  const parked = await f.exec.tick();
  assert.deepEqual([parked.state, parked.reason], ['PARKED', 'REQUIRED_CHECK_FAILED'], JSON.stringify({ parked, calls: engine.calls }));
  assert.equal(f.queue.row(PR).state, 'PARKED');
  const state = await AdmissionRerunState.open(path.join(f.root, 'rerun.json'), f.clock);
  const lane = new AdmissionRerunner({ gh, state, clock: f.clock, notify: async () => {},
    readStatus: async () => ({ node: { mode: 'ACTIVE' }, writtenAt: f.clock(), pending: [{ pr: PR, headSha: HEAD, state: f.queue.row(PR).state }] }),
    pulls: () => [{ pr: PR, headSha: HEAD }],
  });
  assert.equal((await lane.step()).acted, 1, 'the lane recovers the timed-out run without a new head');
  assert.deepEqual(mutations, [['rerun', RUN, 2]]);
  actions.status = 'completed';
  github.green(134709790330, HEAD, { name: 'migration-verify', app: 15368 });
  f.advance(parked.until - f.clock());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  await lane.step();
  assert.equal((await github.readPullRequest(PR)).head.sha, HEAD);
  assert.ok((await github.readChecks(HEAD)).checks.some(c => c.name === 'kooyumi-merge-slot' && c.conclusion === 'success'));
  assert.equal(github.world.main, T);
  assert.deepEqual(pushes, [], 'no push');
  assert.deepEqual(mutations, [['rerun', RUN, 2]]);
  assert.equal(engine.calls.filter(([kind, n]) => kind === 'stage' && n === 8).length, 2);
  assert.deepEqual(engine.calls.filter(([kind, n]) => kind === 'stage' && n >= 2 && n <= 7).map(([, n]) => n), [2, 3, 4, 5, 6, 7]);
});
