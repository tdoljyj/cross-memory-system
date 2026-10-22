import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration, scanEffectKeyV2, subjectOfV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../src/batch-claim-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { createFixtureControlPublisherV2, queueWindow, QUEUE_POLL_MS, STAGE8_CHECK_MS } from '../src/independent-control-checks-v2/publisher.mjs';
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

function fakeGithub() {
  const checks = []; let next = 100;
  return { fixture: true, checks,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}
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
