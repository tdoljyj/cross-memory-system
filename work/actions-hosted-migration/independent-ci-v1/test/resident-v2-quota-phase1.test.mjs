// Resident quota redesign v0.6 + §9, phase 1 (Task 12ada80e), the Source v2 side:
//   - the batch claim record's identity no longer includes createdAt (§1, §9 item 3), and the control consumer is
//     unaffected (it re-derives the jobs from the record's own fields; job ids exclude createdAt);
//   - the merge-queue entry fact (§9 item 4, queue-facts.mjs);
//   - GitHub 5xx, 429 and transport failures are GITHUB_TRANSIENT_UNAVAILABLE, 403 is not (§2);
//   - the stage fact carries the bound outcome's diagnostic, scheduling facts and safe-to-re-run flag, and the broker's
//     "no launch, state restored" refusal (§9 items 1, 2, 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { batchJobsV2, batchRefV2 } from '../src/job-v2.mjs';
import { recordBatchClaim, readBatchClaim, validateBatchClaimRecord } from '../src/batch-claim-v2.mjs';
import { controlJobsFor } from '../src/independent-control-checks-v2/consumer.mjs';
import { CONTROL_CHECKS_V2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { mergeQueueEntryV2 } from '../src/independent-control-checks-v2/queue-facts.mjs';
import { sanitizeSchedulingV2, sanitizeAdmissionDiagnosticV2 } from '../src/admission-facts-v2.mjs';
import { parseStageOutcome } from '../../../independent-ci-resident-v1/src/engine-windows.mjs';
import { outcomeFailureCode, outcomeFacts, buildStageFact, githubTransientReason, BROKER_NO_LAUNCH_CODES } from '../src/resident-v2/stage-fact.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { NOW, HEAD, BASE, iso, hex, tempDir } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const base = (o = {}) => ({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(NOW), attempt: 1, ...o });

test('batch claim: a later batch of the same content and attempt (another createdAt) reads the same record', async t => {
  const dir = await tempDir(t);
  const first = batchJobsV2(base()), later = batchJobsV2(base({ createdAt: iso(NOW + 3_600_000) }));
  assert.equal(batchRefV2(first['work-admission']), batchRefV2(later['work-admission']), 'same record key: createdAt is not identity');
  const c = { claimId: randomUUID(), fence: 2, epoch: 1, expiresAt: iso(NOW + 3600_000) };
  assert.equal((await recordBatchClaim(dir, first['work-admission'], c, iso(NOW))).created, true);
  // before phase 1 this was BATCH_CLAIM_RECORD_INVALID: re-running the same commit always failed at stage 1
  assert.deepEqual(await readBatchClaim(dir, later.gitleaks), { claimId: c.claimId, fence: 2, epoch: 1 });
  assert.equal((await recordBatchClaim(dir, later['work-admission'], c, iso(NOW + 3_600_000))).created, false);
  await assert.rejects(recordBatchClaim(dir, later['work-admission'], { ...c, fence: 3 }, iso(NOW)), { code: 'BATCH_CLAIM_CHANGED' });
  // the record keeps the first createdAt as a fact; the rest of the identity is still compared
  const file = path.join(dir, `${batchRefV2(first['work-admission'])}.json`);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(record.createdAt, iso(NOW));
  assert.throws(() => validateBatchClaimRecord(record, batchJobsV2(base({ attempt: 2 }))['work-admission']), { code: 'BATCH_CLAIM_RECORD_INVALID' });
  assert.throws(() => validateBatchClaimRecord({ ...record, createdAt: 'yesterday' }, later['work-admission']), { code: 'BATCH_CLAIM_RECORD_INVALID' });
});

test('control consumer (audit, §9 item 3): unaffected, it re-derives the jobs from the record and ids exclude createdAt', async t => {
  const dir = await tempDir(t);
  const jobs = batchJobsV2(base());
  const c = { claimId: randomUUID(), fence: 2, epoch: 1, expiresAt: iso(NOW + 3600_000) };
  await recordBatchClaim(dir, jobs['work-admission'], c, iso(NOW));
  const record = JSON.parse(await fs.readFile(path.join(dir, `${batchRefV2(jobs['work-admission'])}.json`), 'utf8'));
  const name = CONTROL_CHECKS_V2['control-admission'].name;
  const found = controlJobsFor([record], { repository: REPO, headSha: HEAD, name }, 'd'.repeat(64));
  assert.equal(found.length, 1);
  // the same control job id a later batch (another createdAt) derives
  assert.equal(found[0].job.id, batchJobsV2(base({ createdAt: iso(NOW + 999_000) }))['control-admission'].id);
  assert.deepEqual(found[0].claim, { claimId: c.claimId, fence: 2, epoch: 1 });
});

test('merge-queue entry fact: in the queue (head, waiting), not in it (none, lapsed, out), unknown when malformed', () => {
  const job = { repo: REPO };
  const q = (state, position = 3) => ({ merge_queue: [{ ref: `merge:${REPO}:main`, state, position }] });
  assert.deepEqual(mergeQueueEntryV2(q('head', 1), job), { entered: true, state: 'head', position: 1 });
  assert.deepEqual(mergeQueueEntryV2(q('waiting'), job), { entered: true, state: 'waiting', position: 3 });
  for (const s of ['lapsed', 'out']) assert.deepEqual(mergeQueueEntryV2(q(s), job), { entered: false, state: s, position: 3 });
  // Native's view answers {state:'none'} (no position) for a claim with the ref but no entry in that queue
  assert.deepEqual(mergeQueueEntryV2({ merge_queue: [{ ref: 'merge:tdoljyj/cross-memory-system:main', length: 2, head: null, state: 'none' }] }, job), { entered: false, state: 'none', position: null });
  assert.deepEqual(mergeQueueEntryV2({ merge_queue: [] }, job), { entered: false, state: null, position: null });
  assert.deepEqual(mergeQueueEntryV2({ merge_queue: null }, job), { entered: false, state: null, position: null });
  assert.deepEqual(mergeQueueEntryV2({ merge_queue: [{ ref: 'merge:other/repo:main', state: 'head' }] }, job), { entered: false, state: null, position: null });
  assert.equal(mergeQueueEntryV2(q('nowhere'), job), null);
  assert.equal(mergeQueueEntryV2({ merge_queue: [q('head').merge_queue[0], q('waiting').merge_queue[0]] }, job), null);
  assert.equal(mergeQueueEntryV2(null, job), null);
  assert.deepEqual(mergeQueueEntryV2(q('waiting', -4), job), { entered: true, state: 'waiting', position: null });
  assert.deepEqual(sanitizeSchedulingV2({ ciRetryAfter: '2026-10-22T12:00:00Z', mergeQueue: { entered: true, state: 'waiting', position: 2, extra: 1 } }),
    { ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: null });
  assert.equal(sanitizeSchedulingV2('x'), null);
});

test('GitHub 5xx, 429 and transport failures are GITHUB_TRANSIENT_UNAVAILABLE; 403 and other answers are not', () => {
  const blocked = reason => ({ status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false });
  for (const r of ['github_http_500', 'github_http_502', 'github_http_503', 'github_http_504', 'github_http_429', 'github_transport_unconfirmed']) {
    assert.equal(githubTransientReason(r), true, r);
    for (const stage of [1, 2, 3, 5, 7, 8]) assert.equal(outcomeFailureCode(blocked(r), stage), 'GITHUB_TRANSIENT_UNAVAILABLE', `${r}@${stage}`);
  }
  for (const r of ['github_http_403', 'github_http_404', 'github_http_422', 'github_http_5000', 'github_http_50', 'github_response_invalid']) {
    assert.equal(githubTransientReason(r), false, r);
    assert.equal(outcomeFailureCode(blocked(r), 1), 'STAGE_CHILD_REFUSED', r);
    assert.equal(outcomeFailureCode(blocked(r), 3), 'PUBLICATION_BLOCKED', r);
  }
  // only a clean BLOCKED with zero side effects: a write that may have reached GitHub is never transient
  assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason: 'github_http_503', sideEffects: 1, mayHavePublished: true }, 3), 'PUBLICATION_UNCERTAIN');
  assert.equal(outcomeFailureCode({ status: 'UNCERTAIN', reason: 'github_transport_unconfirmed', sideEffects: 1, mayHavePublished: true }, 3), 'PUBLICATION_UNCERTAIN');
});

test('stage fact: the bound outcome carries diagnostic, scheduling and the safe-to-re-run flag; nothing is inferred', () => {
  const o = { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false, safeToRerun: true,
    diagnostic: { reasonCodes: ['task_ci_head_cap_reached', 'some remote text'], nativeReasonCodes: ['task_ci_head_cap_reached'], ciRetryAfter: '2026-10-22T12:00:00Z' },
    scheduling: { ciRetryAfter: '2026-10-22T12:00:00Z', mergeQueue: { entered: false, state: null, position: null } } };
  const f = outcomeFacts(o);
  assert.equal(f.safeToRerun, true);
  assert.deepEqual(f.diagnostic.reasonCodes, ['task_ci_head_cap_reached', 'unknown_reason']);
  assert.equal(f.diagnostic.ciRetryAfter, '2026-10-22T12:00:00.000Z');
  assert.deepEqual(f.scheduling, { ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: { entered: false, state: null, position: null } });
  // the flag never survives side effects or a status other than BLOCKED
  assert.equal(outcomeFacts({ ...o, sideEffects: 1, mayHavePublished: true }).safeToRerun, false);
  assert.equal(outcomeFacts({ ...o, status: 'UNCERTAIN' }).safeToRerun, false);
  assert.equal(outcomeFacts({ ...o, safeToRerun: 'yes' }).safeToRerun, false);
  assert.deepEqual([outcomeFacts({ ...o, diagnostic: null, scheduling: null }).diagnostic, outcomeFacts({ ...o, scheduling: 'x' }).scheduling], [null, null]);
});

test('stage fact: the broker refused before any start with the original restored = no launch; BUSY and UNCONFIRMED never', () => {
  const broker = o => ({ contract: 'x', requestId: randomUUID(), ok: false, code: 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED', started: false, startCallIssued: false, helperPid: null,
    stoppedInTime: false, restored: true, accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false, ...o });
  const fact = b => buildStageFact({ stage: 1, nonce: hex(16), plan: { stage: 1 }, planSha256: 'a'.repeat(64), workManifestSha256: 'b'.repeat(64), broker: b });
  assert.deepEqual(BROKER_NO_LAUNCH_CODES, ['BROKER_RUNNER_NOT_ORIGINAL_STOPPED', 'BROKER_REQUEST_EXPIRED', 'BROKER_REQUEST_REFUSED']);
  for (const code of ['BROKER_RUNNER_NOT_ORIGINAL_STOPPED', 'BROKER_REQUEST_EXPIRED', 'BROKER_REQUEST_SHAPE']) {
    const f = fact(broker({ code }));
    assert.equal(f.broker_no_launch, true, code);
    assert.equal(f.scm_start_call_issued, false);
  }
  for (const code of ['BROKER_BUSY', 'BROKER_UNCONFIRMED']) assert.equal(fact(broker({ code })).broker_no_launch, false, code);
  assert.equal(fact(broker({ restored: false })).broker_no_launch, false, 'not restored');
  assert.equal(fact(broker({ stableAfter: false })).broker_no_launch, false, 'configuration moved');
  assert.equal(fact(broker({ started: true, startCallIssued: true, helperPid: 7, stoppedInTime: true })).broker_no_launch, false, 'it launched');
  assert.equal(buildStageFact({ stage: 1, nonce: hex(16), workManifestSha256: 'b'.repeat(64), preflightCode: 'STAGE_PACKAGE_REFUSED' }).broker_no_launch, false, 'the broker said nothing');
});

test('entry outcome: safeToRerun only on a clean BLOCKED with zero side effects; scheduling and diagnostic sanitized', async t => {
  const receiptsRoot = await tempDir(t, 'clued-v2-outcome-');
  const plan = { stage: 1, entryRole: 'work-admission' };
  const write = result => writeOutcome({ receiptsRoot, nonce: hex(16), plan, jobIds: [], result });
  const ok = await write({ status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, safeToRerun: true, admissionDiagnostic: { reasonCodes: ['owner_grant_required'] },
    scheduling: { ciRetryAfter: null, mergeQueue: { entered: true, state: 'waiting', position: 2 } } });
  assert.deepEqual([ok.safeToRerun, ok.mayHavePublished, ok.scheduling.mergeQueue, ok.diagnostic.reasonCodes], [true, false, { entered: true, state: 'waiting', position: 2 }, ['owner_grant_required']]);
  assert.equal((await write({ status: 'BLOCKED', reason: 'x', sideEffects: 1, safeToRerun: true })).safeToRerun, false);
  assert.equal((await write({ status: 'UNCERTAIN', reason: 'x', sideEffects: 0, safeToRerun: true })).safeToRerun, false);
  const none = await write({ status: 'SETTLED', sideEffects: 1 });
  assert.deepEqual([none.safeToRerun, none.scheduling, none.diagnostic], [false, null, null]);
});

test('issuer diagnostics: transient exhaustion keeps only bounded enums, counts and phases', () => {
  for (const transientAdmission of ['full_admission_unavailable', 'full_admission_observation_expired']) {
    const clean = sanitizeAdmissionDiagnosticV2({ transientAdmission, evaluations: 4, phase: 'changed_paths',
      rawBody: 'sensitive-details-must-not-survive', changedPaths: ['private/file'], arbitrary: true });
    assert.equal(clean.transientAdmission, transientAdmission);
    assert.equal(clean.evaluations, 4);
    assert.equal(clean.phase, 'changed_paths');
    assert.deepEqual(sanitizeAdmissionDiagnosticV2(clean), clean, 'the second Source sanitizer is idempotent');
    for (const key of ['rawBody', 'changedPaths', 'arbitrary']) assert.equal(Object.hasOwn(clean, key), false);
    for (const evaluations of [0, -1, 5, 1.5, '4', null, Infinity, Number.MAX_SAFE_INTEGER]) {
      assert.equal(Object.hasOwn(sanitizeAdmissionDiagnosticV2({ transientAdmission, evaluations }), 'evaluations'), false);
    }
  }
  const forged = sanitizeAdmissionDiagnosticV2({ transientAdmission: 'full_admission_rejected', evaluations: 4, phase: 'private_phase' });
  for (const key of ['transientAdmission', 'evaluations', 'phase']) assert.equal(Object.hasOwn(forged, key), false);
});

test('issuer diagnostics: actual entry JSON survives both Source and resident filters without changing failure semantics', async t => {
  const receiptsRoot = await tempDir(t, 'clued-issuer-diagnostic-');
  const raw = { verdict: 'REJECTED', nativeVerdict: 'REJECTED', ownerReviewKind: 'refused', reasonCodes: ['owner_grant_required'],
    nativeReasonCodes: ['path_outside_write_set'], phase: 'changed_paths', transientAdmission: 'full_admission_unavailable', evaluations: 4,
    workflowGateFindingsPresent: true, modeFresh: false, recorderFresh: true, transport: true, rawBody: 'sensitive-details-must-not-survive' };
  const written = await writeOutcome({ receiptsRoot, nonce: hex(16), plan: { stage: 4, entryRole: 'scanner-issuer' }, jobIds: [],
    result: { status: 'UNCERTAIN', reason: 'full_admission_rejected', sideEffects: 1, admissionDiagnostic: raw, safeToRerun: true } });
  const file = path.join(receiptsRoot, `outcome-${written.nonce}.json`);
  const actual = JSON.parse(await fs.readFile(file, 'utf8'));
  const resident = parseStageOutcome(outcomeFacts(actual));
  for (const key of ['verdict', 'nativeVerdict', 'ownerReviewKind', 'reasonCodes', 'nativeReasonCodes', 'phase', 'transientAdmission', 'evaluations',
    'workflowGateFindingsPresent', 'modeFresh', 'recorderFresh', 'transport']) assert.deepEqual(resident.diagnostic[key], raw[key], key);
  assert.equal(JSON.stringify(actual).includes(raw.rawBody), false);
  assert.deepEqual([resident.status, resident.reason, resident.sideEffects, resident.mayHavePublished, resident.safeToRerun],
    ['UNCERTAIN', 'full_admission_rejected', 1, true, false]);
  assert.equal(outcomeFailureCode(actual, 4), 'PUBLICATION_UNCERTAIN');
  assert.equal(outcomeFailureCode(actual, 4), outcomeFailureCode({ ...actual, diagnostic: null }, 4));
});
