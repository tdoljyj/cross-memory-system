import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration, scanEffectKeyV2, subjectOfV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../src/batch-claim-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2, notOnDuty, refusalSafeToRerun } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { createFixtureControlPublisherV2, createProductionControlPublisherV2, queueWindow, QUEUE_POLL_MS, QUEUE_WAIT_FINAL_REASONS, STAGE8_CHECK_MS } from '../src/independent-control-checks-v2/publisher.mjs';
import { outcomeFailureCode, outcomeFacts } from '../src/resident-v2/stage-fact.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { protectedFactsFromVerify } from '../runtime/one-shot-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult, FAR_FUTURE } from './resident-v2-fixtures.mjs';
import { requiredCheckFailure } from '../src/independent-control-checks-v2/train-rules.mjs';
import { createFullAdmissionPortV2 } from '../src/full-admission-v2.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const jobsFor = (attempt = 1, testSha = HEAD) => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt });
const claim = (o = {}) => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000), ...o });

test('required failures use exact head, pinned App and latest rerun across supported providers', () => {
  const rules = branchRules();
  rules[2].parameters.required_status_checks.push({ context: 'ci-suites', integration_id: 15368 });
  const check = (id, patch = {}) => ({ id, head_sha: HEAD, name: 'ci-suites', app: { id: 15368 }, status: 'completed', conclusion: 'failure', ...patch });
  const run = checks => requiredCheckFailure(rules, { complete: true, checks }, HEAD, 5368905);
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) assert.deepEqual(run([check(1, { conclusion })]), ['ci-suites']);
  for (const conclusion of ['success', 'neutral', 'skipped']) assert.deepEqual(run([check(1, { conclusion })]), []);
  assert.deepEqual(run([check(1), check(2, { status: 'in_progress', conclusion: null })]), []);
  assert.deepEqual(run([check(2, { conclusion: 'success' }), check(1)]), []);
  assert.deepEqual(run([check(1, { app: { id: 999 } }), check(2, { name: 'optional' })]), []);
  assert.throws(() => run([check(1, { head_sha: BASE })]), /REQUIRED_CHECKS_UNREADABLE/);
  assert.throws(() => requiredCheckFailure(rules, { complete: false, checks: [] }, HEAD, 5368905), /REQUIRED_CHECKS_UNREADABLE/);
  for (const integration_id of [null, -1, 999]) {
    rules[2].parameters.required_status_checks.push({ context: 'unknown-or-legacy-ci', integration_id });
    assert.throws(() => run([]), /REQUIRED_CHECKS_UNREADABLE/, 'an unsupported required provider must never be assumed clear');
    assert.deepEqual(run([check(1)]), ['ci-suites'], 'known failures take priority over unrelated unsupported contexts');
    rules[2].parameters.required_status_checks.pop();
  }
});

test('failed required checks neither join nor extend, and an already queued claim returns its slot', async t => {
  for (const entered of [false, true]) {
    const jobs = jobsFor(), c = claim(), github = fakeGithub();
    github.state.rules[2].parameters.required_status_checks.push({ context: 'ci-suites', integration_id: 15368 });
    github.checks.push({ id: 1, head_sha: HEAD, name: 'ci-suites', app: { id: 15368 }, status: 'completed', conclusion: 'failure' });
    const calls = [], time = Date.now();
    const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
    const adm = fakeAdmission((job, packet, opts) => {
      opts.scheduling?.({ mergeQueue: { entered, state: entered ? 'head' : null, position: entered ? 1 : null }, claimExpiresAt: iso(time + 60_000) });
      return admitted(job, c, packet, { mergeQueueHead: entered, observedAt: time });
    });
    const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time,
      claimAssist: { joinQueue: async () => calls.push('join'), extendLease: async () => calls.push('extend') },
      slotNative: { returnSlot: async args => { calls.push(['return', args]); return { onDuty: true, returned: true }; } } });
    const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
    assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', 'REQUIRED_CHECK_FAILED', 0]);
    assert.deepEqual(calls, entered ? [['return', { pr: 888 }]] : []);
    assert.equal(r.scheduling.mergeQueue.entered, false);
    assert.equal(github.checks.length, 1, 'no control checks were published');
  }
});

// FABLE 11-19 §4.1 (8), the #1176 incident: stage 8 sees a required check fail while the claim is queued and gives back its merge
// slot. That is only a slot: the same claim's next attempt (the check rerun passed) goes on exactly as an attempt that never failed.
// The offline Native has the semantics of 20261119001000 ('slot-only'); with the production function before it ('pr-end': every
// return ended the PR binding and released the claim) the second attempt is refused, which is the incident itself.
// A model test (review 1): stage 8 did not change, so it does not fail before the fix; the semantics it models are proved on the real
// database by work-claims-pr-end-release-db (#1166 and L1-3: a return ends no binding and releases no claim).
const STAGE8_RETURN_SEMANTICS = 'slot-only';
async function stage8AfterReturn(t, semantics, { fail = true } = {}) {
  const c = claim(), github = fakeGithub(), time = Date.now();
  github.state.rules[2].parameters.required_status_checks.push({ context: 'ci-suites', integration_id: 15368 });
  github.checks.push({ id: 1, head_sha: HEAD, name: 'ci-suites', app: { id: 15368 }, status: 'completed', conclusion: fail ? 'failure' : 'success' });
  const native = { status: 'ACTIVE', queued: true, returns: [] };
  native.returnSlot = async ({ pr }) => {
    native.returns.push(pr); native.queued = false;
    if (semantics === 'pr-end') native.status = 'RELEASED';
    return { onDuty: true, returned: true, claims: [c.claimId] };
  };
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const publisher = () => createFixtureControlPublisherV2({ github, journal, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time,
    claimAssist: { joinQueue: async () => { native.queued = true; }, extendLease: async () => {} }, slotNative: native,
    admission: fakeAdmission((job, packet, opts) => {
      if (native.status !== 'ACTIVE') return blocked('full_admission_rejected');
      opts.scheduling?.({ mergeQueue: { entered: native.queued, state: native.queued ? 'head' : null, position: native.queued ? 1 : null }, claimExpiresAt: iso(time + 60_000) });
      return admitted(job, c, packet, { mergeQueueHead: native.queued, observedAt: time });
    }) });
  const one = jobsFor(1), two = jobsFor(2);
  const first = fail ? await publisher().publishPair([one['control-admission'], one['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS }) : {};
  if (fail) github.checks.push({ id: 2, head_sha: HEAD, name: 'ci-suites', app: { id: 15368 }, status: 'completed', conclusion: 'success' });
  native.queued = true; // the holder's claim joins its queue again (renew with the merge-slot trigger)
  const second = await publisher().publishPair([two['control-admission'], two['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  return { first: [first.status, first.reason], second: [second.status, second.reason], returns: native.returns, claim: native.status };
}
test('#1176: a stage-8 required check failure gives back only the merge slot; the same claim\'s next attempt goes on', async t => {
  const never = await stage8AfterReturn(t, STAGE8_RETURN_SEMANTICS, { fail: false });
  const after = await stage8AfterReturn(t, STAGE8_RETURN_SEMANTICS);
  assert.deepEqual(after.first, ['BLOCKED', 'REQUIRED_CHECK_FAILED']);
  assert.deepEqual(after.returns, [888]);
  assert.equal(after.claim, 'ACTIVE', 'giving back the merge slot leaves the claim live');
  assert.notEqual(after.second[1], 'full_admission_rejected');
  assert.notEqual(after.second[1], 'BATCH_CLAIM_CHANGED');
  assert.deepEqual(after.second, never.second, 'the second attempt goes on as one that never failed');
});

// A complete admitted v2 observation for `job` under `observed` (shape of full-admission-v2 facts).
const SLOT_UNTIL = FAR_FUTURE; // Native's merge-slot deadline does not move between observations
function admitted(job, observed, packet, { mergeQueueHead = false, slotUntil = SLOT_UNTIL, batchClaim = null, observedAt = Date.now() } = {}) {
  const facts = { contract: 'clued.independent-ci.full-admission/2', status: 'ADMITTED', admitted: true, completeAdmission: true, evaluator: 'scripts/ci/clued-work-admission.mjs#evaluate',
    domain: 'fixture', repository: REPO, scope: 'project:x', prRef: `${REPO}#${job.pr}`, headSha: job.headSha, baseSha: job.baseSha, jobId: job.id, role: job.role, attempt: job.attempt,
    claimId: observed.claimId, fence: observed.fence, epoch: observed.epoch, observedClaim: { ...observed }, batchClaimBound: batchClaim ? claimGeneration(batchClaim) : null,
    sourceManifestSha256: job.sourceManifestSha256, executionPolicy: 'staged', guarded: false, executionHandoverPending: false, mergeQueueHead,
    mode: { state: 'normal', layer: 'code', policyVersion: 1 }, mergeSlot: { state: 'held', ref: `merge:${REPO}:main`, tip: job.baseSha, until: iso(slotUntil) },
    ownerReview: null, workflowGateFindings: [], observedAt: iso(observedAt), claimExpiresAt: observed.expiresAt, modeProofRef: 'mode', observationRef: 'obs',
    packetSha256: digest(packet), evaluationSha256: digest('evaluation') };
  return { ...facts, observationSha256: digest(facts) };
}
const blocked = reason => ({ contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false, reason });

// Phase 2, step 3a: main's live branch rules and GitHub's test merge of the PR. By default the six checks are pinned to
// 5368905, strict is on, and the test merge is exactly [BASE, HEAD] with HEAD's own tree (HEAD contains BASE).
const SIX = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const TREE = 'c'.repeat(40), TEST_MERGE = 'd'.repeat(40), LANDED = 'e'.repeat(40);
const branchRules = ({ strict = true, pinned = 5368905, methods = ['merge', 'squash', 'rebase'], names = SIX } = {}) => [
  { type: 'deletion', rulesetId: 24182890, parameters: null },
  { type: 'pull_request', rulesetId: 24182890, parameters: { allowed_merge_methods: methods, required_approving_review_count: 0 } },
  { type: 'required_status_checks', rulesetId: 24182890, parameters: { strict_required_status_checks_policy: strict, required_status_checks: names.map(context => ({ context, integration_id: pinned })) } }];
function fakeGithub(o = {}) {
  const checks = []; let next = 100;
  const state = { rules: branchRules(), rulesError: null, pull: { state: 'open', merged: false, mergeable: true, merge_commit_sha: TEST_MERGE },
    commits: { [HEAD]: { sha: HEAD, tree: TREE, parents: [BASE] }, [TEST_MERGE]: { sha: TEST_MERGE, tree: TREE, parents: [BASE, HEAD] } }, onCreate: null, ...o };
  return { fixture: true, checks, state,
    async readChangedPaths(job) {
      if (state.pull.state !== 'open') throw Object.assign(new Error('pr_subject_changed'), { code: 'pr_subject_changed' });
      return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] };
    },
    async readPullRequest(n) { return { number: n, ...structuredClone(state.pull), head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: state.prBase ?? BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readBranchRules(branch) { if (state.rulesError) throw Object.assign(new Error(state.rulesError), { code: state.rulesError }); return { complete: true, branch, rules: structuredClone(state.rules) }; },
    async readGitCommit(sha) { if (!state.commits[sha]) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' }); return structuredClone(state.commits[sha]); },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); state.onCreate?.(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}
// GitHub's auto-merge, a moment after the merge-slot green: the PR is merged as `landed` (parents and tree).
const autoMergeOnGreen = (github, landed = { sha: LANDED, tree: TREE, parents: [BASE, HEAD] }) => {
  github.state.onCreate = c => { if (c.name === 'kooyumi-merge-slot') { github.state.pull = { state: 'closed', merged: true, mergeable: null, merge_commit_sha: landed.sha }; github.state.commits[landed.sha] = landed; } };
};
// A green ledger in memory (green-ledger.mjs has its own test); `fail` makes the intent unrecordable.
const memoryLedger = ({ fail = false } = {}) => ({ records: [], async append(r) { if (fail) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); this.records.push(structuredClone({ phase: r.phase, headSha: r.job.headSha, checkRunId: r.checkRunId, testTree: r.testTree, detail: r.detail })); } });
// admission.evaluatePr: answers from a script (function of call count and options).
function fakeAdmission(answer) { let calls = 0; return { fixture: true, get calls() { return calls; }, async evaluatePr(job, packet, options) { calls++; return answer(job, packet, options ?? {}, calls); } }; }

async function batchClaimsAt(t) {
  const dir = await tempDir(t);
  return { dir, read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } }, record: (j, c, at) => recordBatchClaim(dir, j, c, at) };
}

test('work admission v2: first admission records the batch claim and publishes once; a repeat only re-verifies', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub(), bc = await batchClaimsAt(t);
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const admission = fakeAdmission((job, packet) => admitted(job, c, packet));
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims: bc });
  const r = await pub.publish(jobs['work-admission']);
  assert.equal(r.status, 'SETTLED');
  assert.equal(r.sideEffects, 1);
  assert.deepEqual(await bc.read(jobs.gitleaks), claimGeneration(c));
  assert.match(github.checks[0].external_id, new RegExp(`:v2:${jobs['work-admission'].id}:a1:c${c.claimId.slice(0, 8)}:f3:e1$`));
  const again = await pub.publish(jobs['work-admission']);
  assert.equal(again.status, 'SETTLED');
  assert.equal(again.sideEffects, 0);
  assert.equal(github.checks.length, 1);
  // attempt 2 of the same head is a new job id, a new batch, a new check
  const two = jobsFor(2);
  assert.equal((await pub.publish(two['work-admission'])).status, 'SETTLED');
  assert.equal(github.checks.length, 2);
});

test('work admission v2: a refused evaluation never wedges a later admitted evaluation of the same content', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub(), bc = await batchClaimsAt(t);
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let admit = false;
  const admission = fakeAdmission((job, packet) => admit ? admitted(job, c, packet) : blocked('full_admission_rejected'));
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims: bc });
  const no = await pub.publish(jobs['work-admission']);
  assert.deepEqual([no.status, no.reason, no.sideEffects], ['BLOCKED', 'full_admission_rejected', 0]);
  assert.equal(await bc.read(jobs['work-admission']), null);
  admit = true;
  assert.equal((await pub.publish(jobs['work-admission'])).status, 'SETTLED');
});

test('work admission v2: a settled check whose batch claim generation moved is revoked, never re-posted', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub(), bc = await batchClaimsAt(t);
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let current = c;
  const admission = fakeAdmission((job, packet) => admitted(job, current, packet));
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims: bc });
  assert.equal((await pub.publish(jobs['work-admission'])).status, 'SETTLED');
  current = { ...c, fence: 4 }; // takeover
  const r = await pub.publish(jobs['work-admission']);
  assert.equal(r.status, 'REVOKED');
  assert.equal(github.checks[0].conclusion, 'failure');
  assert.equal(github.checks.length, 1);
});

test('control pair v2 (S8): read-only queue wait, then exactly two publications', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now(), sleeps = 0;
  const admission = fakeAdmission((job, packet, opts, n) => admitted(job, c, packet, { mergeQueueHead: n > 2, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 }));
  const pub = createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { sleeps++; time += ms; } });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + 10 * QUEUE_POLL_MS });
  assert.equal(r.status, 'SETTLED');
  assert.equal(sleeps, 2);
  assert.deepEqual(github.checks.map(x => x.name), ['kooyumi-admission-verified', 'kooyumi-merge-slot']);
});

test('control pair v2 (S8): real full admission recognizes a multi-PR Native head and refuses nonmembers before publication', async t => {
  for (const [label, refs, scalar, ready] of [
    ['multi-PR higher member', [`${REPO}#887`, `${REPO}#888`], null, true],
    ['nonmember', [`${REPO}#887`, `${REPO}#889`], null, false],
    ['duplicate', [`${REPO}#888`, `${REPO}#888`], null, false],
    ['malformed extra member', [`${REPO}#888`, `${REPO}#0`], null, false],
    ['contradictory scalar', [`${REPO}#887`, `${REPO}#888`], `${REPO}#888`, false],
  ]) {
    const jobs = jobsFor(), c = claim(), github = fakeGithub(), now = Date.now(), scope = `project:${randomUUID()}`, task = randomUUID();
    const prRef = `${REPO}#888`, policyText = '{"policy":"fixture"}';
    const config = { domain: 'fixture', repository: REPO, scope, workspace: os.tmpdir(), sourceManifestSha256: 'd'.repeat(64),
      evaluatorSha256: digest('EVALUATOR'), policyText, policySha256: digest(policyText), ciPrincipalBindingId: randomUUID(),
      ciPrincipalQualificationRef: 'qualification-ref', publishableKey: 'sb_publishable_fixture', supabaseUrl: 'https://fixture.supabase.co' };
    const binding = { status: 'ok', binding_status: 'bound', reason: null, repository: REPO, pr_number: 888, pr_ref: prRef,
      head_sha: HEAD, base_sha: BASE, target_branch: 'main', scope, task_id: task,
      claim: { claim_id: c.claimId, task_id: task, context_key: scope, fence: c.fence, execution_epoch: c.epoch,
        lease_version: 1, expires_at: c.expiresAt, status: 'ACTIVE', execution_handover_pending: false },
      head_authorization_id: null, auto_bound: false, receipt_id: null };
    let evaluations = 0;
    const admission = createFullAdmissionPortV2({ protectedConfig: config, clock: () => now,
      tokenProvider: async () => ({ githubToken: 'gh-fixture', ciAdmissionToken: ['clued', 'bnd', 'fixture123'].join('_'),
        ciPrincipalBindingId: config.ciPrincipalBindingId, ciPrincipalQualificationRef: config.ciPrincipalQualificationRef }),
      modeProvider: async () => ({ complete: true, repository: REPO, variable: 'CLUED_MERGE_ADMISSION_STATE', source: 'github-repository-variables', exists: false, observedAt: iso(now), proofRef: 'mode' }),
      recorderProvider: async () => ({ kind: 'independent-controller', domain: 'fixture', observedAt: iso(now), observationRef: 'obs', recorder: { newId: randomUUID, record() {} } }),
      fetchImpl: async url => {
        assert.equal(new URL(url).pathname, `/repos/${REPO}/pulls/888`);
        return { ok: true, status: 200, json: () => github.readPullRequest(888) };
      },
      fixtureHooks: { evaluatorReader: () => 'EVALUATOR', evaluateImpl: async ({ observation_recorder }) => {
        evaluations++;
        const native = { status: 'ok', verdict: 'ADMITTED', execution_authorized: true, execution_policy: 'staged', current_fence: c.fence, execution_epoch: c.epoch,
          pr_ref: prRef, head_sha: HEAD, base_sha: BASE, verified_at: iso(now), paths_outside_write_set: [],
          claim: { ...binding.claim, bound_pr: prRef, lease_key_required: false, merge_slot_until: iso(now + 600_000),
            merge_queue: [{ ref: `merge:${REPO}:main`, state: 'head', position: 1, ahead: [],
              head: { claim_id: c.claimId, bound_pr: scalar, bound_prs: refs, since: iso(now - 1000), until: iso(now + 600_000) } }] } };
        observation_recorder.record('claim_verification', { result: { payload: native } });
        return { admitted: true, verdict: 'ADMITTED', head_sha: HEAD, base_sha: BASE, pr_ref: prRef, claim_id: c.claimId,
          task_id: task, claim_binding: binding, scope, changed_paths: ['a.txt'], admission_mode: { state: 'normal', layer: 'code', policy_version: 1 },
          merge_slot: { state: 'held', ref: `merge:${REPO}:main`, tip: BASE, until: iso(now + 600_000) }, owner_review: null, workflow_gate_findings: [] };
      } },
    });
    const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
    const pub = createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => now });
    const result = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: now + 1 });
    assert.ok(evaluations > 0, 'the actual full-admission evaluator path ran: ' + JSON.stringify(result));
    if (ready) {
      assert.equal(result.status, 'SETTLED', label + ': ' + JSON.stringify(result));
      assert.deepEqual(github.checks.map(check => check.name), ['kooyumi-admission-verified', 'kooyumi-merge-slot']);
    } else {
      assert.deepEqual([result.status, result.reason, result.sideEffects, github.checks.length], ['BLOCKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 0, 0], label);
    }
  }
});

test('control pair v2 (S8): no queue head within the window ends cleanly with nothing published', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const never = fakeAdmission((job, packet) => admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 }));
  const pub = createFixtureControlPublisherV2({ github, journal, admission: never, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + 3 * QUEUE_POLL_MS });
  assert.deepEqual([r.status, r.reason, r.sideEffects, github.checks.length], ['BLOCKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 0, 0]);
  const moved = fakeAdmission(() => blocked('full_admission_claim_changed'));
  const pub2 = createFixtureControlPublisherV2({ github, journal, admission: moved, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
  const r2 = await pub2.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + 3 * QUEUE_POLL_MS });
  assert.deepEqual([r2.status, r2.reason, github.checks.length], ['BLOCKED', 'full_admission_claim_changed', 0]);
  // the window: merge slot 45 min, claim lease, validUntil and the stage cap minus publication reserve
  const s = Date.now();
  assert.equal(queueWindow({ startedAt: s, claimExpiresAt: iso(s + 3600_000), validUntil: null, stageDeadline: s + 45 * 60_000 }), s + 38 * 60_000);
  assert.equal(queueWindow({ startedAt: s, claimExpiresAt: iso(s + 600_000), validUntil: null, stageDeadline: s + 45 * 60_000 }), s + 600_000);
});

test('scanner publisher v2: content key across claims, settled once, evidence conflict revokes', async t => {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const jobs = jobsFor(), job = jobs.trivy, c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const refs = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, record.accepted[k]]));
  let observedClaim = c;
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
    publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: observedClaim.expiresAt, claim: claimGeneration(observedClaim) }; } };
  const admission = fakeAdmission((j, packet, opts) => admitted(j, observedClaim, packet, { batchClaim: opts.batchClaim }));
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const make = () => createStagedCheckPublisherV2({ nativeAdmission: admission, authority, github, journal, signers, configuredChecks: record.config.checks,
    readChangedPaths: j => github.readChangedPaths(j), protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs },
    batchClaim: claimGeneration(c), domain: 'fixture' });
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  const r = await make().publish({ job, envelope });
  assert.equal(r.status, 'SETTLED', JSON.stringify(r));
  assert.equal(r.effectKey, scanEffectKeyV2(job, record.config.checks.trivy));
  assert.match(github.checks[0].external_id, /^independent-ci:staged:v2:[0-9a-f]{64}:a1$/);
  // a renewal (same generation, new expires_at) changes nothing; the settled effect is only re-verified
  observedClaim = { ...c, expiresAt: iso(Date.now() + 7200_000) };
  const again = await make().publish({ job, envelope });
  assert.deepEqual([again.status, again.sideEffects, github.checks.length], ['SETTLED', 0, 1]);
  // a different signed result for the same content+attempt is an evidence-identity conflict: revoke
  const other = signResult(job, signer, { conclusion: 'failure', finishedAt: Date.now() - 500, startedAt: Date.now() - 4000, domain: 'fixture' });
  const conflict = await make().publish({ job, envelope: other });
  assert.equal(conflict.status, 'REVOKED');
  assert.equal(conflict.reason, 'evidence_identity_conflict');
});

// §38.8 n2 (review R1 m7): the PR base.sha read before and after one staged publication is bound; a change between them
// voids it (authorization_binding_changed), nothing is written.
test('scanner publisher v2: a PR base.sha that moves between the two reads of one publication voids it', async t => {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  // a train front batch (S != H): its base.sha is read as a fact, so only the binding catches a move (an S = H batch is
  // already refused by the subject check, github_subject_changed)
  const job = jobsFor(1, '9'.repeat(40)).trivy, c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const refs = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, record.accepted[k]]));
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
    publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: c.expiresAt, claim: claimGeneration(c) }; } };
  const admission = fakeAdmission((j, packet, opts) => admitted(j, c, packet, { batchClaim: opts.batchClaim }));
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const read = github.readPullRequest.bind(github);
  let reads = 0, moveAt = Infinity;
  github.readPullRequest = async n => { const p = await read(n); reads++; return reads >= moveAt ? { ...p, base: { ...p.base, sha: 'f'.repeat(40) } } : p; };
  const make = () => createStagedCheckPublisherV2({ nativeAdmission: admission, authority, github, journal, signers, configuredChecks: record.config.checks,
    readChangedPaths: j => github.readChangedPaths(j), protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs },
    batchClaim: claimGeneration(c), domain: 'fixture' });
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  // count the reads of one clean publication, then move base.sha at its last (the "after") read
  const probe = await createStagedCheckPublisherV2({ nativeAdmission: admission, authority, github: fakeGithub(), journal: await EffectJournal.open(path.join(await tempDir(t), 'effects')), signers,
    configuredChecks: record.config.checks, readChangedPaths: j => github.readChangedPaths(j), protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs },
    batchClaim: claimGeneration(c), domain: 'fixture' }).publish({ job, envelope });
  assert.equal(probe.status, 'SETTLED');
  reads = 0; moveAt = 2;
  const r = await make().publish({ job, envelope });
  assert.notEqual(r.status, 'SETTLED');
  assert.equal(r.reason, 'authorization_binding_changed', JSON.stringify(r));
  assert.ok(github.checks.every(x => x.conclusion !== 'success'), 'no success stands');
});

test('one-shot v2: the protected observation must name exactly the batch claim generation', () => {
  const jobs = jobsFor(), c = claim(), now = Date.now();
  const config = { scope: 'project:x', ciPrincipalBindingId: randomUUID() };
  const accepted = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, randomUUID()]));
  const body = { status: 'ok', verdict: 'ADMITTED', execution_policy: 'staged', current_fence: 3, execution_epoch: 1, paths_outside_write_set: [], verified_at: iso(now - 1000),
    claim: { claim_id: c.claimId, fence: 3, execution_epoch: 1, context_key: 'project:x', status: 'ACTIVE', lease_key_required: false, execution_handover_pending: false, expires_at: c.expiresAt } };
  const timing = { sentMono: 0, nowMono: 1000 };
  const f = protectedFactsFromVerify({ job: jobs.gitleaks, batchClaim: claimGeneration(c), body, status: 200, config, accepted, ...timing });
  assert.deepEqual(f.claim, claimGeneration(c));
  assert.throws(() => protectedFactsFromVerify({ job: jobs.gitleaks, batchClaim: { ...claimGeneration(c), fence: 4 }, body, status: 200, config, accepted, ...timing }), { code: 'native_claim_observation_refused' });
  // Field 2026-11-13 (PR #1086): a handed-over claim (lease key required) runs while Native's policy is staged, with no guard in force.
  assert.equal(protectedFactsFromVerify({ job: jobs.gitleaks, batchClaim: claimGeneration(c), body: { ...body, claim: { ...body.claim, lease_key_required: true } }, status: 200, config, accepted, ...timing }).guarded, false);
  assert.throws(() => protectedFactsFromVerify({ job: jobs.gitleaks, batchClaim: claimGeneration(c), body: { ...body, claim: { ...body.claim, lease_key_required: 'yes' } }, status: 200, config, accepted, ...timing }), { code: 'native_claim_observation_refused' });
  assert.throws(() => protectedFactsFromVerify({ job: jobs.gitleaks, batchClaim: claimGeneration(c), body, status: 200, config, accepted }),
    error => error.code === 'native_claim_observation_refused' && error.checks.includes('round_trip_age'), 'missing monotonic evidence must fail closed');
});

// Resident quota redesign v0.6 §1 / §9 phase 1: the resident releases a stage-1 failure only on the entry's own
// "safe to re-run" flag. It holds only for a refusal inside the first admission's boundary (nothing written under the
// real effect key, no batch claim recorded) that is not a deterministic fault of the PR itself.
test('work admission v2: safeToRerun only for a first-admission boundary refusal that is not a deterministic PR fault', async t => {
  const jobs = jobsFor(), c = claim();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const told = { ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: { entered: false, state: null, position: null } };
  const run = async ({ answer, github = fakeGithub(), bc = null }) => {
    const claims = bc ?? await batchClaimsAt(t);
    const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission: fakeAdmission(answer), assertLive() {}, record() {}, authority: {}, batchClaims: claims });
    return pub.publish(jobs['work-admission']);
  };
  const rejected = { ...blocked('full_admission_rejected'), diagnostic: { reasonCodes: ['owner_grant_required'], nativeReasonCodes: [] } };
  const r = await run({ answer: (job, packet, opts) => { opts.scheduling?.(told); return rejected; } });
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun], ['BLOCKED', 'full_admission_rejected', 0, true]);
  assert.deepEqual(r.scheduling, told, 'the scheduling facts Native reported travel with the result');
  assert.deepEqual(r.admissionDiagnostic.reasonCodes, ['owner_grant_required']);
  // deterministic faults of the PR: never safe to re-run, also inside the boundary
  assert.equal((await run({ answer: () => blocked('full_admission_subject_changed') })).safeToRerun, false);
  assert.equal((await run({ answer: () => ({ ...blocked('full_admission_rejected'), diagnostic: { reasonCodes: ['changed_files_truncated'] } }) })).safeToRerun, false);
  // not up to date with main: also deterministic, even together with a waiting reason
  assert.equal((await run({ answer: () => ({ ...blocked('full_admission_rejected'), diagnostic: { reasonCodes: ['owner_review_required', 'protected_change_not_up_to_date'] } }) })).safeToRerun, false);
  // Primary/standby C3: a node that holds no ci-admission role (Native's admission_binding_required) decides nothing about the
  // PR, so a deterministic reason that comes with it never makes the refusal unsafe to re-run: nothing was written (first
  // evaluation, no batch claim, sideEffects 0), and the stage names it NODE_ROLE_NOT_HELD
  for (const reasonCodes of [['admission_binding_required'], ['admission_binding_required', 'protected_change_not_up_to_date'], ['changed_files_truncated', 'admission_binding_required'],
    ['policy_file_removed', 'admission_binding_required', 'owner_review_required']]) {
    const x = await run({ answer: () => ({ ...blocked('full_admission_rejected'), diagnostic: { reasonCodes } }) });
    assert.deepEqual([x.status, x.reason, x.sideEffects, x.safeToRerun], ['BLOCKED', 'full_admission_rejected', 0, true], reasonCodes.join());
    // through the entry's real outcome record and the stage fact's view of it
    const written = await writeOutcome({ receiptsRoot: await tempDir(t, 'clued-no-role-'), nonce: randomUUID().replace(/-/g, ''), plan: { stage: 1, entryRole: 'work-admission' }, jobIds: [], result: x });
    const facts = outcomeFacts(written);
    assert.deepEqual([facts.safeToRerun, facts.sideEffects, facts.mayHavePublished, facts.diagnostic.reasonCodes.includes('admission_binding_required')], [true, 0, false, true], reasonCodes.join());
    assert.equal(outcomeFailureCode(written, 1), 'NODE_ROLE_NOT_HELD', reasonCodes.join());
    assert.equal(outcomeFailureCode(written, 3), 'BATCH_CLAIM_CHANGED', 'after stage 1 it keeps its old code');
  }
  // only the rejection of the first evaluation says it; no other reason, and not past the boundary or with a claim recorded
  assert.deepEqual([notOnDuty('full_admission_rejected', { reasonCodes: ['admission_binding_required'] }), notOnDuty('full_admission_rejected', { nativeReasonCodes: ['admission_binding_required'] }),
    notOnDuty('pr_subject_changed', { reasonCodes: ['admission_binding_required'] }), notOnDuty('full_admission_rejected', { reasonCodes: ['binding_not_authorized'] }), notOnDuty('full_admission_rejected', null)], [true, true, false, false, false]);
  const d = { reasonCodes: ['admission_binding_required', 'protected_change_not_up_to_date'] };
  assert.deepEqual([refusalSafeToRerun({ step: 'boundary', claimed: null, reason: 'full_admission_rejected', diagnostic: d }), refusalSafeToRerun({ step: 'admitted', claimed: null, reason: 'full_admission_rejected', diagnostic: d }),
    refusalSafeToRerun({ step: 'boundary', claimed: c, reason: 'full_admission_rejected', diagnostic: d }), refusalSafeToRerun({ step: 'boundary', claimed: null, reason: 'pr_subject_changed', diagnostic: d })], [true, false, false, false]);
  for (const code of ['pr_files_page_limit', 'pr_subject_changed', 'invalid_pr_files']) {
    const github = { ...fakeGithub(), async readChangedPaths() { throw Object.assign(new Error(code), { code }); } };
    const x = await run({ answer: () => rejected, github });
    assert.deepEqual([x.status, x.reason, x.safeToRerun], ['BLOCKED', code, false], code);
  }
  // a transient GitHub answer inside the boundary is safe to re-run (the resident decides what to do with it)
  const flaky = { ...fakeGithub(), async readChangedPaths() { throw Object.assign(new Error('github_http_503'), { code: 'github_http_503' }); } };
  assert.deepEqual([(await run({ answer: () => rejected, github: flaky })).reason, (await run({ answer: () => rejected, github: flaky })).safeToRerun], ['github_http_503', true]);
  // a batch claim already recorded for this content: not the first admission, never safe
  const bc = await batchClaimsAt(t);
  await bc.record(jobs['work-admission'], c, iso(Date.now()));
  assert.equal((await run({ answer: () => rejected, bc })).safeToRerun, false);
  // admitted, then the batch claim record failed: past the boundary, never safe
  const broken = { read: async () => null, record: async () => { throw Object.assign(new Error('BATCH_CLAIM_DIRECTORY_INVALID'), { code: 'BATCH_CLAIM_DIRECTORY_INVALID' }); } };
  const after = await run({ answer: (job, packet) => admitted(job, c, packet), bc: broken });
  assert.deepEqual([after.status, after.reason, after.safeToRerun], ['BLOCKED', 'BATCH_CLAIM_DIRECTORY_INVALID', false]);
  // a settled first admission carries the scheduling facts too
  const ok = await run({ answer: (job, packet, opts) => { opts.scheduling?.(told); return admitted(job, c, packet); } });
  assert.deepEqual([ok.status, ok.scheduling], ['SETTLED', told]);
});

test('control pair v2: a queue wait that does not reach the head carries the latest scheduling facts', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const told = { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null } };
  const never = fakeAdmission((job, packet, opts) => { opts.scheduling?.(told); return admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 }); });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: never, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + 2 * QUEUE_POLL_MS });
  // phase 2, step 2: not in the merge queue at all is its own not-ready reason (the resident parks and retries)
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.scheduling], ['BLOCKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 0, told]);
});

test('control pair v2 (phase 2, step 2): one run only checks; main moved ends it at once; nothing is ever written', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now(), polls = 0;
  const waiting = { ciRetryAfter: null, mergeQueue: { entered: true, state: 'waiting', position: 2 } };
  const inQueue = fakeAdmission((job, packet, opts) => { polls++; opts.scheduling?.(waiting); return admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 }); });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: inQueue, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
  const s = time;
  const waitUntil = queueWindow({ startedAt: s, claimExpiresAt: iso(s + 3600_000), validUntil: null, stageDeadline: s + 45 * 60_000, checkMs: STAGE8_CHECK_MS });
  assert.equal(waitUntil, s + STAGE8_CHECK_MS);
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil });
  assert.deepEqual([r.status, r.reason, r.sideEffects, github.checks.length, polls], ['BLOCKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 0, 0, 4]);
  // main moved under the batch: no wait helps (strict), the run ends at the first observation
  const moved = fakeAdmission((job, packet) => {
    const { observationSha256, ...f } = admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 });
    const g = { ...f, mergeSlot: { ...f.mergeSlot, state: 'not_needed', tip: '9'.repeat(40) } };
    return { ...g, observationSha256: digest(g) };
  });
  const pub2 = createFixtureControlPublisherV2({ github, journal, admission: moved, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
  const r2 = await pub2.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  assert.deepEqual([r2.status, r2.reason, r2.sideEffects, r2.polls, github.checks.length], ['BLOCKED', 'RESIDENT_BASE_MOVED', 0, 1, 0]);
});

test('control pair v2 (phase 2, step 2, review M3, m6): an answer no wait can change ends the run at once with its final code', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const runWith = async answer => {
    let polls = 0;
    const pub = createFixtureControlPublisherV2({ github, journal, admission: fakeAdmission(() => { polls++; return answer(); }), assertLive() {}, record() {}, authority: {},
      batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
    const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
    return { ...r, calls: polls };
  };
  const finals = { full_admission_subject_changed: 'PR_NOT_OPEN_OR_CHANGED',
    full_admission_native_unsupported: 'NATIVE_POLICY_UNSUPPORTED', full_admission_claim_changed: 'BATCH_CLAIM_CHANGED', full_admission_claim_missing: 'BATCH_CLAIM_CHANGED' };
  for (const [reason, code] of Object.entries(finals)) {
    assert.ok(QUEUE_WAIT_FINAL_REASONS.includes(reason), reason);
    const r = await runWith(() => blocked(reason));
    assert.deepEqual([r.status, r.reason, r.sideEffects, r.polls, r.calls, github.checks.length], ['BLOCKED', reason, 0, 1, 1, 0], reason);
    assert.equal(outcomeFailureCode({ status: r.status, reason: r.reason, sideEffects: 0, mayHavePublished: false }, 8), code, reason);
  }
  // a protected change Native rejects as not up to date is main moving under the batch
  const behind = await runWith(() => ({ ...blocked('full_admission_rejected'), diagnostic: { reasonCodes: ['protected_change_not_up_to_date'], nativeReasonCodes: [] } }));
  assert.deepEqual([behind.status, behind.reason, behind.polls], ['BLOCKED', 'RESIDENT_BASE_MOVED', 1]);
  assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason: 'RESIDENT_BASE_MOVED', sideEffects: 0, mayHavePublished: false }, 8), 'RESIDENT_BASE_MOVED');
  // any other rejection stays the batch claim's (final as before)
  const other = await runWith(() => ({ ...blocked('full_admission_rejected'), diagnostic: { reasonCodes: ['owner_grant_required'], nativeReasonCodes: [] } }));
  assert.deepEqual([other.reason, outcomeFailureCode({ status: 'BLOCKED', reason: other.reason, sideEffects: 0, mayHavePublished: false }, 8)], ['full_admission_rejected', 'BATCH_CLAIM_CHANGED']);
  // a transient answer, and an inactive or stale claim verification (a renewal can fix it; re-review m17), are still
  // waited out inside the window and end not ready
  for (const reason of ['full_admission_unavailable', 'full_admission_native_changed']) {
    const waited = await runWith(() => blocked(reason));
    assert.deepEqual([waited.reason, waited.calls > 1, QUEUE_WAIT_FINAL_REASONS.includes(reason)], ['RESIDENT_QUEUE_HEAD_NOT_REACHED', true, false], reason);
  }
});

// ---- phase 2, step 3a (design v0.5 §5.3 rules 3, 5, 7; §5.4 item 4) ----
const pairRun = async (t, { github = fakeGithub(), greenLedger = memoryLedger(), window = STAGE8_CHECK_MS, testSha = HEAD } = {}) => {
  const jobs = jobsFor(1, testSha), c = claim();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now(), calls = 0;
  const admission = fakeAdmission((job, packet, opts) => { calls++; return admitted(job, c, packet, { mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 }); });
  const pub = createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), greenLedger,
    clock: () => time, sleep: async ms => { time += ms; } });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + window });
  return { r, github, greenLedger, journal, calls, jobs };
};
const stage8Code = r => outcomeFailureCode({ status: r.status, reason: r.reason, sideEffects: r.sideEffects, mayHavePublished: false }, 8);

test('control pair v2 (step 3a): live branch rules decide before anything is written', async t => {
  // strict off and no train: no green at all, at once, and nothing ledgered
  const off = await pairRun(t, { github: fakeGithub({ rules: branchRules({ strict: false }) }) });
  assert.deepEqual([off.r.status, off.r.reason, off.r.sideEffects, off.github.checks.length, off.greenLedger.records.length, off.r.polls], ['BLOCKED', 'STRICT_OFF_WITHOUT_TRAIN', 0, 0, 0, 1]);
  assert.equal(stage8Code(off.r), 'STRICT_OFF_WITHOUT_TRAIN');
  // a required check pinned to another integration (a disaster-recovery switch), one missing, no required checks at all
  // (the ruleset disabled), or a read that fails: unreadable, no queue writes or publication
  for (const github of [fakeGithub({ rules: branchRules({ pinned: 5164952 }) }), fakeGithub({ rules: branchRules({ names: SIX.slice(1) }) }),
    fakeGithub({ rules: [] }), fakeGithub({ rulesError: 'github_http_403' })]) {
    const u = await pairRun(t, { github });
    assert.deepEqual([u.r.status, u.r.reason, u.r.sideEffects, u.github.checks.length, u.greenLedger.records.length, u.r.polls], ['BLOCKED', 'RULESET_UNREADABLE', 0, 0, 0, 1]);
    assert.equal(stage8Code(u.r), 'RULESET_UNREADABLE');
  }
  // the rules as they are today (strict on, all six pinned): the pair is written
  const ok = await pairRun(t);
  assert.equal(ok.r.status, 'SETTLED');
  assert.deepEqual(ok.github.checks.map(x => [x.name, x.conclusion]), [['kooyumi-admission-verified', 'success'], ['kooyumi-merge-slot', 'success']]);
});

test('control pair v2 (step 3a): the test merge must be exactly [T, H] with the tested tree', async t => {
  // still computing, not mergeable, or no test merge yet: waited out, then not ready
  for (const pull of [{ state: 'open', merged: false, mergeable: null, merge_commit_sha: null }, { state: 'open', merged: false, mergeable: false, merge_commit_sha: TEST_MERGE },
    { state: 'open', merged: false, mergeable: true, merge_commit_sha: null }]) {
    const w = await pairRun(t, { github: fakeGithub({ pull }) });
    assert.deepEqual([w.r.reason, w.r.sideEffects, w.github.checks.length, w.r.polls > 1], ['TRAIN_TEST_MERGE_NOT_READY', 0, 0, true]);
    assert.equal(stage8Code(w.r), 'TRAIN_TEST_MERGE_NOT_READY');
  }
  // on stale parents (GitHub not yet recomputed): not ready
  const stale = fakeGithub(); stale.state.commits[TEST_MERGE] = { sha: TEST_MERGE, tree: TREE, parents: ['9'.repeat(40), HEAD] };
  assert.equal((await pairRun(t, { github: stale })).r.reason, 'TRAIN_TEST_MERGE_NOT_READY');
  // GitHub recomputes in the window: the next poll writes
  const late = fakeGithub({ pull: { state: 'open', merged: false, mergeable: null, merge_commit_sha: null } });
  const real = late.readBranchRules.bind(late); let reads = 0;
  late.readBranchRules = async b => { if (++reads === 2) late.state.pull = { state: 'open', merged: false, mergeable: true, merge_commit_sha: TEST_MERGE }; return real(b); };
  assert.equal((await pairRun(t, { github: late })).r.status, 'SETTLED');
  // the right parents but another tree: final at once, nothing written
  const other = fakeGithub(); other.state.commits[TEST_MERGE] = { sha: TEST_MERGE, tree: '7'.repeat(40), parents: [BASE, HEAD] };
  const d = await pairRun(t, { github: other });
  assert.deepEqual([d.r.status, d.r.reason, d.r.sideEffects, d.r.polls, d.github.checks.length], ['BLOCKED', 'TRAIN_TEST_MERGE_TREE_DIFFERS', 0, 1, 0]);
  assert.equal(stage8Code(d.r), 'TRAIN_TEST_MERGE_TREE_DIFFERS');
  // a regenerated test merge (new SHA, same parents and tree) is the same test merge
  const regen = fakeGithub({ pull: { state: 'open', merged: false, mergeable: true, merge_commit_sha: '6'.repeat(40) } });
  regen.state.commits['6'.repeat(40)] = { sha: '6'.repeat(40), tree: TREE, parents: [BASE, HEAD] };
  assert.equal((await pairRun(t, { github: regen })).r.status, 'SETTLED');
});

test('control pair v2 (step 3a): the merge-slot green is ledgered before the pair; no ledger, no green', async t => {
  const ok = await pairRun(t);
  assert.deepEqual(ok.greenLedger.records.map(r => [r.phase, r.headSha, r.testTree]), [['intent', HEAD, TREE], ['posted', HEAD, TREE], ['settled', HEAD, TREE]]);
  const slot = ok.github.checks.find(x => x.name === 'kooyumi-merge-slot');
  assert.deepEqual(ok.greenLedger.records.slice(1).map(r => r.checkRunId), [slot.id, slot.id]);
  assert.equal(ok.greenLedger.records[0].checkRunId, null);
  const none = await pairRun(t, { greenLedger: memoryLedger({ fail: true }) });
  assert.deepEqual([none.r.status, none.r.reason, none.r.sideEffects, none.github.checks.length], ['BLOCKED', 'GREEN_LEDGER_UNAVAILABLE', 0, 0]);
  assert.equal(stage8Code(none.r), 'GREEN_LEDGER_UNAVAILABLE');
  // the production publisher can be built without one (the merge-gate consumer only reads: review M1), but it never
  // writes a green without one: no ledger (it could not be opened: review M2) parks like a failing one
  const reader = createProductionControlPublisherV2({ github: fakeGithub(), journal: ok.journal, admission: fakeAdmission(() => null), assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(claim()) });
  assert.equal(typeof reader.consume, 'function');
  assert.throws(() => createProductionControlPublisherV2({ github: fakeGithub(), journal: ok.journal, admission: fakeAdmission(() => null), assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(claim()), greenLedger: {} }),
    e => e.code === 'CONTROL_PUBLISHER_CONFIGURATION_REFUSED');
  const jobs = jobsFor(), c = claim(), github = fakeGithub(), journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const productionFacts = f => { const { observationSha256, ...facts } = f; return { ...facts, domain: 'production', observationSha256: digest({ ...facts, domain: 'production' }) }; };
  const admission = fakeAdmission((job, packet, opts) => productionFacts(admitted(job, c, packet, { mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 })));
  const production = createProductionControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
  const parked = await production.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  assert.deepEqual([parked.status, parked.reason, parked.sideEffects, github.checks.length], ['BLOCKED', 'GREEN_LEDGER_UNAVAILABLE', 0, 0]);
});

test('control pair v2 (step 3a): a PR GitHub merged as tested right after the green is success, never revoked', async t => {
  const github = fakeGithub(); autoMergeOnGreen(github);
  const m = await pairRun(t, { github });
  assert.deepEqual([m.r.status, m.r.results[1].settledMerged, m.r.sideEffects], ['SETTLED', true, 2]);
  assert.deepEqual(m.github.checks.map(x => [x.name, x.conclusion]), [['kooyumi-admission-verified', 'success'], ['kooyumi-merge-slot', 'success']]);
  assert.deepEqual(m.greenLedger.records.map(r => r.phase), ['intent', 'posted', 'merged']);
  assert.equal(m.greenLedger.records[2].detail, LANDED);
  const settled = await m.journal.read(m.r.results[1].effectKey);
  assert.deepEqual([settled.state, settled.details.settledMerged], ['settled', LANDED]);
  // merged on another tree, on other parents, or squashed (one parent): not what was tested, the green is revoked as before
  const squash = { sha: LANDED, tree: TREE, parents: [BASE] };
  for (const landed of [{ sha: LANDED, tree: '7'.repeat(40), parents: [BASE, HEAD] }, { sha: LANDED, tree: TREE, parents: ['9'.repeat(40), HEAD] }, squash]) {
    const g = fakeGithub(); autoMergeOnGreen(g, landed);
    const x = await pairRun(t, { github: g });
    assert.equal(x.r.status, 'REVOKED');
    assert.equal(x.github.checks.find(c => c.name === 'kooyumi-merge-slot').conclusion, 'failure');
    assert.deepEqual(x.greenLedger.records.map(r => r.phase), ['intent', 'posted', 'revoked']);
  }
  // the same when the after-write boundary still answered (it read before the merge) and only GitHub's own answer
  // shows the squash: whichever read sees the merge first, the result is the same (review M3)
  const raced = fakeGithub(); autoMergeOnGreen(raced, squash);
  const answer = raced.readChangedPaths.bind(raced);
  raced.readChangedPaths = async job => { const now = raced.state.pull; raced.state.pull = { ...now, state: 'open' }; try { return await answer(job); } finally { raced.state.pull = now; } };
  const y = await pairRun(t, { github: raced });
  assert.equal(y.r.status, 'REVOKED');
  assert.equal(y.github.checks.find(c => c.name === 'kooyumi-merge-slot').conclusion, 'failure');
  // merged as tested, but the readback of the green fails (here a newer judgement of the same check): never settled on
  // an unconfirmed check, nothing ledgered as merged (review M4)
  const unread = fakeGithub(); autoMergeOnGreen(unread);
  const create = unread.state.onCreate;
  unread.state.onCreate = c => { create(c); if (c.name === 'kooyumi-merge-slot') unread.checks.push({ ...structuredClone(c), id: c.id + 50 }); };
  const z = await pairRun(t, { github: unread });
  assert.notEqual(z.r.status, 'SETTLED');
  assert.ok(!z.greenLedger.records.some(r => r.phase === 'merged'));
});

test('control pair v2 (step 3a): an open PR whose test merge definitely changed right after the green loses it', async t => {
  const github = fakeGithub();
  github.state.onCreate = c => { if (c.name === 'kooyumi-merge-slot') github.state.commits[TEST_MERGE] = { sha: TEST_MERGE, tree: '7'.repeat(40), parents: [BASE, HEAD] }; };
  const x = await pairRun(t, { github });
  assert.equal(x.r.status, 'REVOKED');
  assert.equal(x.github.checks.find(c => c.name === 'kooyumi-merge-slot').conclusion, 'failure');
  // an after-write read that fails proves nothing: the green stands (the Native boundary decided, as before 3a)
  const flaky = fakeGithub();
  flaky.state.onCreate = c => { if (c.name === 'kooyumi-merge-slot') flaky.readPullRequest = async () => { throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); }; };
  assert.equal((await pairRun(t, { github: flaky })).r.status, 'SETTLED');
  // GitHub still computing (mergeable null) on other parents proves nothing either: the green stands (review M4)
  const computing = fakeGithub();
  computing.state.onCreate = c => { if (c.name === 'kooyumi-merge-slot') { computing.state.pull = { ...computing.state.pull, mergeable: null }; computing.state.commits[TEST_MERGE] = { sha: TEST_MERGE, tree: TREE, parents: ['9'.repeat(40), HEAD] }; } };
  assert.equal((await pairRun(t, { github: computing })).r.status, 'SETTLED');
});

// Step 3c-2a (design v0.5 §5.2, §5.7; DESIGN §21.3): a train front batch tests GitHub's test merge S of [T, H]. Stage 8
// compares the test merge with S's own tree (not H's), and the PR's base.sha (which GitHub moves only on a push) is
// read as a fact, never compared with T; a batch that tests the head keeps both checks exactly as before.
// Step 3c-2b (DESIGN §41.2, §38.8 m3): such a batch is accepted only with the train on (train-single-green.test.mjs has the
// green on S's tree, with the train on); with the train off it is refused before anything is read or written.
test('control pair v2 (step 3c-2a): a train front batch needs the train; a batch that tests the head keeps its checks', async t => {
  const S_TREE = '5'.repeat(40);
  const front = () => {
    const g = fakeGithub({ prBase: '9'.repeat(40) });
    g.state.commits[TEST_MERGE] = { sha: TEST_MERGE, tree: S_TREE, parents: [BASE, HEAD] };
    return g;
  };
  const off = await pairRun(t, { github: front(), testSha: TEST_MERGE });
  assert.deepEqual([off.r.status, off.r.reason, off.r.sideEffects, off.calls, off.github.checks.length, off.greenLedger.records.length], ['BLOCKED', 'TRAIN_FRONT_JOB_WITHOUT_TRAIN', 0, 0, 0, 0]);
  assert.equal(stage8Code(off.r), 'TRAIN_FRONT_JOB_WITHOUT_TRAIN');
  // the same GitHub for a batch that tests the head: H's tree is not the test merge's, so nothing is written
  const head = await pairRun(t, { github: front() });
  assert.deepEqual([head.r.status, head.r.reason, head.github.checks.length], ['BLOCKED', 'TRAIN_TEST_MERGE_TREE_DIFFERS', 0]);
});

test('scanner publisher v2 (step 3c-2a, bc982192): the PR base.sha is a fact for every batch', async t => {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const refs = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, record.accepted[k]]));
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const run = async (job, github) => {
    const c = claim();
    const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
    const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
      publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: c.expiresAt, claim: claimGeneration(c) }; } };
    const admission = fakeAdmission((j, packet, opts) => admitted(j, c, packet, { batchClaim: opts.batchClaim }));
    const pub = createStagedCheckPublisherV2({ nativeAdmission: admission, authority, github, journal, signers, configuredChecks: record.config.checks,
      readChangedPaths: j => github.readChangedPaths(j), protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs },
      batchClaim: claimGeneration(c), domain: 'fixture' });
    return pub.publish({ job, envelope: signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' }) });
  };
  const moved = () => fakeGithub({ prBase: '9'.repeat(40) });
  const front = await run(jobsFor(1, TEST_MERGE).trivy, moved());
  assert.equal(front.status, 'SETTLED', JSON.stringify(front));
  const head = await run(jobsFor().trivy, moved());
  assert.equal(head.status, 'SETTLED', JSON.stringify(head));
  assert.equal((await run(jobsFor().trivy, fakeGithub())).status, 'SETTLED');
});

// Generation 12 (resident DESIGN 56.4): a claim outside the merge queue is put in it once per run with the CI identity, and a short lease
// is extended once; neither is a side effect of the stage, and a failure changes nothing of the not-ready answer.
test('control pair v2 (generation 12): not in the queue -> one join; a short lease -> one extension; still a clean not-ready run', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now(), joined = false;
  const calls = [], records = [];
  const claimAssist = {
    joinQueue: async a => { calls.push(['join', a]); joined = true; return { ok: true, joined: true, reason: null }; },
    extendLease: async a => { calls.push(['extend', a]); return { ok: true, extended: true, reason: null }; },
  };
  const facts = () => ({ ciRetryAfter: null, mergeQueue: joined ? { entered: true, state: 'waiting', position: 2 } : { entered: false, state: null, position: null },
    claimExpiresAt: iso(time + 20 * 60_000) });
  const adm = fakeAdmission((job, packet, opts) => { opts.scheduling?.(facts()); return admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 }); });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record: (k, d) => records.push([k, d]), authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  assert.deepEqual([r.status, r.reason, r.sideEffects, github.checks.length], ['BLOCKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 0, 0], 'joined: now it waits behind another claim');
  assert.deepEqual(calls.map(x => x[0]), ['extend', 'join'], 'each once per run');
  assert.deepEqual(calls[1][1], { pr: 888, headSha: HEAD });
  assert.equal(calls[0][1].minutes, 180);
  assert.ok(records.some(([k, d]) => k === 'native_queue_join' && d.joined === true));

  // the door does not know the actions yet / the network is cut: the answer is what it was without them
  for (const answer of [{ ok: false, code: 'CLAIM_ASSIST_NOT_DEPLOYED' }, { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' }]) {
    joined = false;
    const failing = { joinQueue: async () => answer, extendLease: async () => answer };
    const pub2 = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
      clock: () => time, sleep: async ms => { time += ms; }, claimAssist: failing });
    const r2 = await pub2.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
    assert.deepEqual([r2.status, r2.reason, r2.sideEffects, github.checks.length], ['BLOCKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 0, 0], answer.code);
  }
});

test('control pair v2 (generation 12, review round 2): the reported lease end is what Native answered; main moved -> no join; a log that throws changes nothing', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const extended = iso(time + 150 * 60_000);
  const calls = [];
  const claimAssist = {
    joinQueue: async () => { calls.push('join'); return { ok: true, joined: false, reason: 'head_not_admitted' }; },
    extendLease: async () => { calls.push('extend'); return { ok: true, extended: true, expiresAt: extended, reason: null }; },
  };
  const short = () => ({ ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null }, claimExpiresAt: iso(time + 20 * 60_000) });
  // one observation only (the window ends after the first poll): the answer carries the extended end, not the one seen before it
  const adm = fakeAdmission((job, packet, opts) => { opts.scheduling?.(short()); return admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 }); });
  // the new records (the join's and the extension's) throw, as a full observation log would
  const throwing = kind => { if (['native_queue_join', 'native_lease_extend'].includes(kind)) throw new Error('OBSERVATION_LOG_BOUNDARY'); };
  const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record: throwing, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + QUEUE_POLL_MS - 1 });
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 0], 'a throwing log is still a clean not-ready run');
  assert.equal(r.scheduling.claimExpiresAt, extended);
  assert.deepEqual(calls, ['extend', 'join']);

  // main moved under the batch: it ends at once, and its claim never takes a place in the queue
  calls.length = 0;
  const moved = fakeAdmission((job, packet, opts) => {
    opts.scheduling?.(short());
    const { observationSha256, ...f } = admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 });
    const g = { ...f, mergeSlot: { ...f.mergeSlot, state: 'not_needed', tip: '9'.repeat(40) } };
    return { ...g, observationSha256: digest(g) };
  });
  const pub2 = createFixtureControlPublisherV2({ github, journal, admission: moved, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  const r2 = await pub2.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  assert.deepEqual([r2.status, r2.reason, r2.sideEffects], ['BLOCKED', 'RESIDENT_BASE_MOVED', 0]);
  assert.deepEqual(calls, [], 'no join and no extension for a batch that cannot merge');
});

test('control pair v2 (generation 12, Decision 207c0cd0 v4): an observation whose admission did not pass never joins or extends', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const calls = [];
  const claimAssist = { joinQueue: async () => { calls.push('join'); return { ok: true, joined: true }; }, extendLease: async () => { calls.push('extend'); return { ok: true, extended: true }; } };
  // Native is reached and tells the scheduling facts (not in the queue, a short lease), but the admission does not pass (not final)
  const notAdmitted = fakeAdmission((job, packet, opts) => { opts.scheduling?.({ ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null }, claimExpiresAt: iso(time + 5 * 60_000) });
    return blocked('full_admission_unavailable'); });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: notAdmitted, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  assert.deepEqual([r.status, r.sideEffects], ['BLOCKED', 0]);
  assert.deepEqual(calls, [], 'nothing without a passed admission in this run');
});

test('control pair v2 (generation 12, review round 11): a join on the last poll is followed by one more observation, which re-verifies the head', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now(), joined = false, observations = 0;
  const claimAssist = { joinQueue: async () => { joined = true; return { ok: true, joined: true, reason: null }; }, extendLease: async () => ({ ok: true, extended: false, reason: 'already_extended' }) };
  const adm = fakeAdmission((job, packet, opts) => {
    observations++;
    opts.scheduling?.({ ciRetryAfter: null, mergeQueue: joined ? { entered: true, state: 'waiting', position: 2 } : { entered: false, state: null, position: null }, claimExpiresAt: iso(time + 4 * 3600_000) });
    return admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 });
  });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  // a window that ends after the first poll
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + QUEUE_POLL_MS - 1 });
  assert.equal(observations, 2, 'one more observation after the join, although the window was over');
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.scheduling.mergeQueue.entered], ['BLOCKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 0, true]);
  // a join that did not join (already queued, refused, not deployed) adds no observation
  observations = 0; joined = false;
  const pub2 = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist: { joinQueue: async () => ({ ok: false, code: 'CLAIM_ASSIST_NOT_DEPLOYED' }), extendLease: async () => ({ ok: false, code: 'CLAIM_ASSIST_NOT_DEPLOYED' }) } });
  await pub2.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + QUEUE_POLL_MS - 1 });
  assert.equal(observations, 1);
});

test('control pair v2 (generation 12, review round 12): a head that holds the slot on the observation after the join publishes as usual, after the window', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now(), joined = false;
  const claimAssist = { joinQueue: async () => { joined = true; time += 40_000; return { ok: true, joined: true, reason: null }; }, extendLease: async () => ({ ok: true, extended: false, reason: 'already_extended' }) };
  const adm = fakeAdmission((job, packet, opts) => {
    opts.scheduling?.({ ciRetryAfter: null, mergeQueue: joined ? { entered: true, state: 'head', position: 1 } : { entered: false, state: null, position: null }, claimExpiresAt: iso(time + 4 * 3600_000) });
    return admitted(job, c, packet, { mergeQueueHead: joined, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 });
  });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  const start = time;
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: start + QUEUE_POLL_MS - 1 });
  assert.equal(r.status, 'SETTLED');
  assert.ok(time > start + QUEUE_POLL_MS - 1, 'published after the window');
  assert.deepEqual(github.checks.map(x => x.name), ['kooyumi-admission-verified', 'kooyumi-merge-slot']);
});

test('control pair v2 (generation 12, review round 19): a claim already at the queue head still gets its short lease extended once, and publishes', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const calls = [];
  const claimAssist = {
    joinQueue: async () => { calls.push('join'); return { ok: true, joined: true, reason: null }; },
    extendLease: async a => { calls.push(['extend', a.minutes]); return { ok: true, extended: true, expiresAt: iso(time + 180 * 60_000), reason: null }; },
  };
  const adm = fakeAdmission((job, packet, opts) => {
    opts.scheduling?.({ ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: iso(time + 20 * 60_000) });
    return admitted(job, c, packet, { mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 });
  });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  assert.equal(r.status, 'SETTLED');
  assert.deepEqual(calls, [['extend', 180]], 'extended once on the ready path; no join for a claim already in the queue');
  assert.deepEqual(github.checks.map(x => x.name), ['kooyumi-admission-verified', 'kooyumi-merge-slot']);
});

test('control pair v2 (generation 12, review round 20): a ready try that meets a transient fault after the extension reports the new lease end, without a queue place', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const extended = iso(time + 180 * 60_000);
  const claimAssist = {
    joinQueue: async () => ({ ok: true, joined: true, reason: null }),
    extendLease: async () => ({ ok: true, extended: true, expiresAt: extended, reason: null }),
  };
  const adm = fakeAdmission((job, packet, opts, n) => {
    opts.scheduling?.({ ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: iso(time + 20 * 60_000) });
    if (n > 1) throw Object.assign(new Error('native_claim_observation_unavailable'), { code: 'native_claim_observation_unavailable' });
    return admitted(job, c, packet, { mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 });
  });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', 'native_claim_observation_unavailable', 0]);
  assert.deepEqual(r.scheduling, { ciRetryAfter: null, mergeQueue: null, claimExpiresAt: extended });
  assert.equal(github.checks.length, 0);
});

test('control pair v2 (generation 12, review round 24): a join followed by a failed observation is reported in the queue at an unknown place, not as not joined', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now(), joined = false;
  const claimAssist = { joinQueue: async () => { joined = true; return { ok: true, joined: true, reason: null }; }, extendLease: async () => ({ ok: true, extended: false, reason: 'already_extended' }) };
  const adm = fakeAdmission((job, packet, opts) => {
    if (joined) throw Object.assign(new Error('native_claim_observation_unavailable'), { code: 'native_claim_observation_unavailable' });
    opts.scheduling?.({ ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null }, claimExpiresAt: iso(time + 4 * 3600_000) });
    return admitted(job, c, packet, { mergeQueueHead: false, observedAt: time, slotUntil: time + 600_000 });
  });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, claimAssist });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + QUEUE_POLL_MS - 1 });
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 0]);
  assert.deepEqual(r.scheduling.mergeQueue, { entered: true, state: 'waiting', position: null });
});

test('control pair v2 (generation 12, review rounds 27 and 28): an unwritable green ledger after a ready head answers the whole facts (the queue place too) with the extended lease end', async t => {
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const exp = iso(time + 20 * 60_000), extended = iso(time + 180 * 60_000);
  const adm = fakeAdmission((job, packet, opts) => {
    opts.scheduling?.({ ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: exp });
    return admitted(job, c, packet, { mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 });
  });
  const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
    clock: () => time, sleep: async ms => { time += ms; }, greenLedger: memoryLedger({ fail: true }),
    claimAssist: { joinQueue: async () => ({ ok: true, joined: false, reason: 'already_queued' }), extendLease: async () => ({ ok: true, extended: true, expiresAt: extended, reason: null }) } });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  assert.deepEqual([r.status, r.reason, r.sideEffects, github.checks.length], ['BLOCKED', 'GREEN_LEDGER_UNAVAILABLE', 0, 0]);
  assert.deepEqual(r.scheduling, { ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: extended });
});

test('control pair v2 (generation 12, review round 29): a queue head the rules or the train hold still gets its short lease extended once', async t => {
  for (const [name, github, trainMode, reason] of [
    ['rules', fakeGithub({ rules: branchRules({ strict: false }) }), 'off', 'STRICT_OFF_WITHOUT_TRAIN'],
    ['train', fakeGithub({ rules: branchRules({ strict: false, methods: ['merge'] }) }), 'on', 'TRAIN_SINGLE_GREEN_NOT_PROVEN']]) {
    const jobs = jobsFor(), c = claim();
    const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
    let time = Date.now();
    const calls = [], extended = iso(time + 180 * 60_000);
    const claimAssist = { joinQueue: async () => { calls.push('join'); return { ok: true, joined: true }; },
      extendLease: async () => { calls.push('extend'); return { ok: true, extended: true, expiresAt: extended, reason: null }; } };
    const adm = fakeAdmission((job, packet, opts) => {
      opts.scheduling?.({ ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: iso(time + 20 * 60_000) });
      return admitted(job, c, packet, { mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 });
    });
    const pub = createFixtureControlPublisherV2({ github, journal, admission: adm, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
      clock: () => time, sleep: async ms => { time += ms; }, claimAssist, trainMode, greenLedger: memoryLedger() });
    const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
    assert.deepEqual([r.status, r.reason, r.sideEffects, github.checks.length], ['BLOCKED', reason, 0, 0], name);
    assert.deepEqual(calls, ['extend'], name);
    assert.equal(r.scheduling.claimExpiresAt, extended, name);
  }
});
