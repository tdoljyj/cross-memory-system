import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration, scanEffectKeyV2, subjectOfV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../src/batch-claim-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { createFixtureControlPublisherV2, createProductionControlPublisherV2, queueWindow, QUEUE_POLL_MS, QUEUE_WAIT_FINAL_REASONS, STAGE8_CHECK_MS } from '../src/independent-control-checks-v2/publisher.mjs';
import { outcomeFailureCode } from '../src/resident-v2/stage-fact.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { protectedFactsFromVerify } from '../runtime/one-shot-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const jobsFor = (attempt = 1) => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt });
const claim = (o = {}) => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000), ...o });

// A complete admitted v2 observation for `job` under `observed` (shape of full-admission-v2 facts).
const SLOT_UNTIL = Date.now() + 3600_000; // Native's merge-slot deadline does not move between observations
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
    async readPullRequest(n) { return { number: n, ...structuredClone(state.pull), head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
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

test('one-shot v2: the protected observation must name exactly the batch claim generation', () => {
  const jobs = jobsFor(), c = claim(), now = Date.now();
  const config = { scope: 'project:x', ciPrincipalBindingId: randomUUID() };
  const accepted = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, randomUUID()]));
  const body = { status: 'ok', verdict: 'ADMITTED', execution_policy: 'staged', current_fence: 3, execution_epoch: 1, paths_outside_write_set: [], verified_at: iso(now - 1000),
    claim: { claim_id: c.claimId, fence: 3, execution_epoch: 1, context_key: 'project:x', status: 'ACTIVE', lease_key_required: false, execution_handover_pending: false, expires_at: c.expiresAt } };
  const f = protectedFactsFromVerify({ job: jobs.gitleaks, batchClaim: claimGeneration(c), body, status: 200, config, accepted, now });
  assert.deepEqual(f.claim, claimGeneration(c));
  assert.throws(() => protectedFactsFromVerify({ job: jobs.gitleaks, batchClaim: { ...claimGeneration(c), fence: 4 }, body, status: 200, config, accepted, now }), { code: 'native_claim_observation_refused' });
  assert.throws(() => protectedFactsFromVerify({ job: jobs.gitleaks, batchClaim: claimGeneration(c), body: { ...body, claim: { ...body.claim, lease_key_required: true } }, status: 200, config, accepted, now }), { code: 'native_claim_observation_refused' });
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
const pairRun = async (t, { github = fakeGithub(), greenLedger = memoryLedger(), window = STAGE8_CHECK_MS } = {}) => {
  const jobs = jobsFor(), c = claim();
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
  // (the ruleset disabled), or a read that fails: unreadable, waited out inside the window, nothing written
  for (const github of [fakeGithub({ rules: branchRules({ pinned: 5164952 }) }), fakeGithub({ rules: branchRules({ names: SIX.slice(1) }) }),
    fakeGithub({ rules: [] }), fakeGithub({ rulesError: 'github_http_403' })]) {
    const u = await pairRun(t, { github });
    assert.deepEqual([u.r.status, u.r.reason, u.r.sideEffects, u.github.checks.length, u.greenLedger.records.length, u.r.polls > 1], ['BLOCKED', 'RULESET_UNREADABLE', 0, 0, 0, true]);
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
