// Stage 1 of Source v2: the Native work-admission control check (kooyumi-work-admission). Port of
// formal-work-admission-check-v1/publisher.mjs with these changes only (DESIGN S6, S13):
//   - job contract /2 (no claim in the job; attempt 1 or 2 is part of the id);
//   - the claim is the one Native admits for the PR trailer NOW (full-admission-v2); this stage records it
//     as the batch claim (batch-claim-v2.mjs) that every later stage must observe again;
//   - effect key and external_id carry the observed claim GENERATION (claim id, fence, epoch): one
//     check per (job, generation); a renewal is the same generation;
//   - a refused evaluation leaves only a diagnostic record under a fresh key, never a not_sent record
//     under the real effect key, so a later admitted evaluation of the same content is not wedged;
//   - the journal and observation log live in state\v2\effects-work-admission, never in the spool (S13).
// It is a control check, not a scanner result, ticket, Receipt or qualification.
//
// Resident quota redesign v0.6 §1 and §9 (phase 1): a BLOCKED result says whether the head is SAFE TO RE-RUN. The
// resident releases a stage-1 failure (no burned head) only on this flag, never by inferring it from a reason code.
// It is true only when the refusal came from inside the admission boundary (changed paths, full admission, fact
// checks) of the FIRST admission of this batch (no batch claim recorded yet, so nothing local or remote was written
// under the real effect key) and the reason is not a deterministic fault of the PR itself (DETERMINISTIC_*: the PR
// changed or closed, too many files, a removed or invalid policy file, a protected change not up to date with main),
// which would fail the same way again.
// Results also carry the scheduling facts Native reported (ci_retry_after, merge-queue entry) when it was reached.
//
// Resident primary/standby design v0.4 §6.2 (C4, Task c2af8d17): before Native is asked and before this check is
// published, the head's complete check-run inventory of this App is read on GitHub (published-on-github-v2.mjs). A head
// that already carries a role or control check, published by another node, another Source install or another batch,
// ends with HEAD_PUBLISHED_ON_GITHUB: nothing evaluated, nothing published, never reaching the Task's CI meter, never safe
// to re-run (a new commit runs the PR again). So does this very job's own kooyumi-work-admission (same job id and attempt)
// published by another node or install: a node taking over after the active one ran stage 1 would otherwise post a second
// check of the same identity and HALT on the read-back. A batch that already recorded its claim is this node's own and
// keeps its path. A read that is not complete refuses (fail closed).
//
// Merge train (DESIGN §41.2, §41.4, §41.8; trainMode = the installed policy's train.enabled, train-mode.mjs):
//   - a train front job (S != H) while the train is not on: TRAIN_FRONT_JOB_WITHOUT_TRAIN before anything is read or written;
//   - with the train on, after this check settled for a front job: the second touch running of the front batch (§41.4), only
//     while the holders read in this run show this batch claim as the one front holder of this PR, with the sweep proof's
//     slotHardCapMinutes; it never changes the ending, what happened is logged and returned;
//   - the binding binds the merge slot by state, ref and tip only, never its until or the claim lease (Decision b30b1b79
//     item 3): a renewal, keepalive or touch between the two observations no longer voids the publication;
//   - a front job's HEAD_PUBLISHED_ON_GITHUB counts only the role checks of its own front subject's jobs (external ids carry the
//     job id, which covers S; job-v2.mjs#frontJobIdsV2): the non-front run H normally has first does not refuse it (§41.4).
import { prepareNativePublication, nativePublicationNoPostProof } from '../../../../../scripts/ci/clued-independent-publication-port.mjs';
import { randomUUID } from 'node:crypto';
import { digest } from '../proof.mjs';
import { freshStamp } from '../clock-skew.mjs';
import { validateJobV2, subjectOfV2, admissionEffectKeyV2, admissionExternalIdV2, claimGeneration, MAX_ATTEMPT_V2, isTrainFrontJobV2, frontJobIdsV2 } from '../job-v2.mjs';
import { TRAIN_MODES, TRAIN_MODE_DEFAULT, trainFrontRefused, trainFrontRefusal } from '../independent-control-checks-v2/train-rules.mjs';
import { fullAdmissionFailureV2, admittedFactsMatchJobV2 } from '../full-admission-v2.mjs';
import { HEAD_PUBLISHED_ON_GITHUB, PUBLISHED_ROLE_CHECK_NAMES, ofJobIds, readPublishedChecks } from '../published-on-github-v2.mjs';
import { scanStartSubjectLine } from '../scan-start-v1/subject.mjs';
import { withdrawalTitle, withdrawalNote, verificationUnavailable, admissionVerificationRetryable } from '../withdrawal-text.mjs';

// Generation 10: the back-off between the bounded re-reads of the verification after the write (reverified below): 100 s of waiting at
// most, on top of the per-request read retry (read-retry.mjs) inside each verification. No wait starts later than VERIFY_WAIT_WINDOW_MS
// after the first verification began, nor when it would leave less than VERIFY_REVOKE_RESERVE_MS before the stage's own deadline
// (deadlineAt): the withdrawal (an identity read, the PATCH, a read-back, each at most 30 s) must still fit. So the last verification
// starts at most 3 minutes after the write and the whole ending stays well inside stage 1's 15-minute cap.
export const VERIFY_REREAD_DELAYS_MS = Object.freeze([10_000, 30_000, 60_000]);
export const VERIFY_WAIT_WINDOW_MS = 180_000;
export const VERIFY_REVOKE_RESERVE_MS = 120_000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const ROLE = 'work-admission', CHECK_NAME = 'kooyumi-work-admission', APP_ID = 5368905, REPO = 'tdoljyj/cross-memory-system';
const DEFINITION = Object.freeze({ name: CHECK_NAME, appId: APP_ID });
const ACTION = 'native-work-admission-check/2';
const PREFIX = 'independent-ci:native-work-admission';
const HASH = /^[a-f0-9]{64}$/, fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
// An uncoded exception is never a transport fact (PR-A review MINOR 5).
const safe = e => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'WORK_ADMISSION_OPERATION_UNCONFIRMED';
const diagnosticOf = e => fullAdmissionFailureV2({ contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false, reason: e?.code, diagnostic: e?.admissionDiagnostic })?.admissionDiagnostic;
// Deterministic faults of the PR (mirrored in independent-ci-resident-v1/src/failure-table.json, test-pinned): the
// boundary reasons of the changed-paths read and of full admission, and the Native/evaluator diagnostic codes.
export const DETERMINISTIC_PR_REASONS = Object.freeze(['invalid_pr_subject', 'pr_subject_changed', 'pr_files_changed', 'incomplete_pr_files', 'invalid_pr_files',
  'pr_files_page_limit', 'COMPLETE_CURRENT_PATHS_REQUIRED', 'full_admission_subject_changed', 'full_admission_subject_invalid']);
export const DETERMINISTIC_PR_REASON_CODES = Object.freeze(['changed_files_truncated', 'policy_file_removed', 'policy_file_invalid', 'protected_change_not_up_to_date']);
export function deterministicPrFault(reason, diagnostic) {
  return DETERMINISTIC_PR_REASONS.includes(reason)
    || [...(diagnostic?.reasonCodes ?? []), ...(diagnostic?.nativeReasonCodes ?? [])].some(c => DETERMINISTIC_PR_REASON_CODES.includes(c));
}
// Primary/standby C3 (resident DESIGN §29): Native's rejection reason admission_binding_required says this node holds no
// ci-admission role. Only the rejection of the first evaluation carries it (full_admission_rejected with the diagnostic), so
// nothing was written under the real effect key, no batch claim was recorded and nothing was published (sideEffects 0). A
// node that is not on duty decides nothing about the PR: no deterministic reason beside it may make the refusal unsafe to re-run.
export const NOT_ON_DUTY_REASON_CODE = 'admission_binding_required';
export function notOnDuty(reason, diagnostic) {
  return reason === 'full_admission_rejected' && [...(diagnostic?.reasonCodes ?? []), ...(diagnostic?.nativeReasonCodes ?? [])].includes(NOT_ON_DUTY_REASON_CODE);
}
// The entry's own "safe to re-run" flag of a refusal (the resident releases a stage-1 failure only on it): inside the first
// evaluation's boundary (step), with no batch claim recorded, and either a node that is not on duty or not a deterministic PR fault.
// A GitHub read that outlived the bounded read retry (read-retry.mjs) before anything was recorded or written (the published-on-github
// read-back, the first step) is as safe to re-run as the first evaluation's boundary: nothing exists to reconcile (DESIGN 49).
export const refusalSafeToRerun = ({ step, claimed, reason, diagnostic }) => claimed === null
  && ((step === 'boundary' && (notOnDuty(reason, diagnostic) || !deterministicPrFault(reason, diagnostic))) || (['published-on-github', 'probe'].includes(step) && verificationUnavailable(reason)));
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const fixedJob = job => { validateJobV2(job); check(job.repo === REPO && job.role === ROLE && job.attempt >= 1 && job.attempt <= MAX_ATTEMPT_V2, 'FIXED_WORK_ADMISSION_JOB_REQUIRED'); return freeze(structuredClone(job)); };
function identity(c, job, externalId) { return Number.isSafeInteger(c?.id) && c.id > 0 && c.app?.id === APP_ID && c.name === CHECK_NAME && c.head_sha === job.headSha && c.external_id === externalId; }

export function factsValid(job, packet, facts, domain, now, batchClaim) {
  check(packet?.complete === true && packet.pr === job.pr && packet.headSha === job.headSha && packet.baseSha === job.baseSha && Array.isArray(packet.paths)
    && packet.paths.length > 0 && packet.paths.length <= 3000 && new Set(packet.paths).size === packet.paths.length, 'COMPLETE_CURRENT_PATHS_REQUIRED');
  const rejection = fullAdmissionFailureV2(facts);
  if (rejection) throw Object.assign(new Error(rejection.reason), { code: rejection.reason, ...(rejection.admissionDiagnostic ? { admissionDiagnostic: rejection.admissionDiagnostic } : {}) });
  check(facts?.domain === domain && facts.observationOnly !== true && admittedFactsMatchJobV2(facts, job, now, { batchClaim }), 'ACTUAL_COMPLETE_NATIVE_ADMISSION_REQUIRED');
  check(facts.packetSha256 === digest(packet), 'NATIVE_CHECK_SUBJECT_CHANGED');
  check(plain(facts.mode) && ['normal', 'efficiency', 'frozen'].includes(facts.mode.state) && ['docs', 'code', 'protected'].includes(facts.mode.layer) && plain(facts.mergeSlot)
    && (facts.ownerReview === null || plain(facts.ownerReview)) && Array.isArray(facts.workflowGateFindings) && facts.workflowGateFindings.length === 0, 'COMPLETE_NATIVE_GATES_REQUIRED');
  check(typeof facts.modeProofRef === 'string' && facts.modeProofRef.length > 0 && typeof facts.observationRef === 'string' && facts.observationRef.length > 0 && HASH.test(facts.evaluationSha256 ?? ''), 'FRESH_NATIVE_OBSERVATION_REQUIRED');
  return facts;
}
const fresh = (f, now) => freshStamp(Date.parse(f.observedAt), now) && Date.parse(f.claimExpiresAt) > now;
function binding(job, packet, facts, authority) {
  return digest({ subject: subjectOfV2(job), claim: claimGeneration(facts.observedClaim), pathsSha256: digest(packet.paths), scope: facts.scope, executionPolicy: facts.executionPolicy,
    ...(facts.publicationRequired ? { guarded: facts.guarded, publicationRequired: true, headAuthorizationId: facts.headAuthorizationId } : {}),
    mode: facts.mode, mergeSlot: { state: facts.mergeSlot.state, ref: facts.mergeSlot.ref, tip: facts.mergeSlot.tip }, ownerReview: facts.ownerReview,
    workflowGateFindings: facts.workflowGateFindings, authority, definition: DEFINITION });
}

// batchClaims: { read(job) -> generation | null (missing), record(job, observedClaim, observedAt) }.
// Train on only: slotNative (merge-slot-native.mjs: holders, touch) and sweepStore (train-sweep-store.mjs: latestProof).
// trainModeUnreadable: train-mode.json was there but unusable (train-mode.mjs#readStageTrainModeFact): a front job parks.
function engine({ github, journal, admission, assertLive, record, authority, batchClaims, trainMode = TRAIN_MODE_DEFAULT, trainModeUnreadable = false, slotNative = null, sweepStore = null, scanStartRegistrySha256 = null,
  clock = Date.now, sleep = wait, verifyRereadDelaysMs = VERIFY_REREAD_DELAYS_MS, deadlineAt = () => null }, production) {
  const domain = production ? 'production' : 'fixture';
  check(TRAIN_MODES.includes(trainMode), 'WORK_ADMISSION_PUBLISHER_CONFIGURATION_REFUSED');
  check(typeof sleep === 'function' && typeof deadlineAt === 'function' && Array.isArray(verifyRereadDelaysMs) && verifyRereadDelaysMs.length <= 6
    && verifyRereadDelaysMs.every(ms => Number.isSafeInteger(ms) && ms > 0 && ms <= 120_000), 'WORK_ADMISSION_PUBLISHER_CONFIGURATION_REFUSED');
  // Generation 10 (resident DESIGN 53.6, Task 125a5162 item 6): a verification of THIS batch's own check that could not be done
  // could not be done for a passing cause (withdrawal-text.mjs#admissionVerificationRetryable: GitHub unreadable, Native or GitHub
  // unreachable inside the evaluation, an observation incomplete or too old on a slow line) is done again after a bounded back-off,
  // every time the whole verification from the start (a fresh after-boundary through Native and GitHub, the binding compared with the
  // one before the write, the read-back, the freshness). Any other refusal (an authorization that changed, a read-back that disagrees,
  // a credential refused) is final at once, as before. When the re-reads are used up, or the time window or the stage's deadline leaves
  // no room for another wait, the check is withdrawn as before ("verification unavailable"); the resident reads that ending at stage 1
  // as the transient ADMISSION_VERIFICATION_UNAVAILABLE (stage-fact.mjs) and schedules the head's one automatic attempt 2 instead of
  // burning it for good. assertLive (the held record's lease and the process) is asked before and after every wait; when it refuses,
  // the withdrawal cannot run either and the ending is UNCERTAIN for the reconciliation, exactly as for any lost lease.
  async function reverified(job, step) {
    const began = clock();
    for (let n = 0; ; n++) {
      try { return await step(); } catch (e) {
        const cause = safe(e), now = clock(), delay = verifyRereadDelaysMs[n], deadline = deadlineAt();
        if (!admissionVerificationRetryable(cause, diagnosticOf(e)) || delay === undefined || now + delay - began > VERIFY_WAIT_WINDOW_MS
          || (Number.isFinite(deadline) && now + delay + VERIFY_REVOKE_RESERVE_MS >= deadline)) throw e;
        try { record('native_check_verify_retry', { jobId: job.id, attempt: n + 1, delayMs: delay, cause }); } catch { /* best-effort */ }
        assertLive(); await sleep(delay); assertLive();
      }
    }
  }
  const unverified = (cause, diagnostic) => verificationUnavailable(cause) || admissionVerificationRetryable(cause, diagnostic);
  // §41.4 touch running, second of the two: the holders and the proof read now; any failing read or unmet condition skips it.
  async function touchRunning(job) {
    let out;
    try {
      const claimed = await batchClaims.read(job), h = await slotNative.holders(), proof = await sweepStore.latestProof();
      const one = h?.onDuty === true && h.holders.length === 1 ? h.holders[0] : null;
      out = claimed && one?.claimId === claimed.claimId && one.pr === job.pr && one.boundPr === `${job.repo}#${job.pr}` && proof?.pr === job.pr && proof.headSha === job.headSha
        && proof.claimId === claimed.claimId && Number.isSafeInteger(proof.slotHardCapMinutes)
        ? await slotNative.touch({ pr: job.pr, headSha: job.headSha, ciState: 'running', hardCapMinutes: proof.slotHardCapMinutes })
        : { onDuty: h?.onDuty ?? null, touched: false, code: h?.onDuty === false ? 'NODE_ROLE_NOT_HELD' : 'TRAIN_TOUCH_NOT_FRONT' };
    } catch (e) { out = { onDuty: null, touched: false, code: safe(e) }; }
    const result = { ciState: 'running', onDuty: out.onDuty, touched: out.touched === true, until: out.until ?? null, code: out.code ?? (out.onDuty === false ? 'NODE_ROLE_NOT_HELD' : null) };
    try { record('native_train_touch', { jobId: job.id, ...result }); } catch { /* best-effort */ }
    return result;
  }
  // The admission boundary in two steps, so a refusal can be told apart from a failure after the facts were admitted.
  async function evaluate(job, batchClaim, scheduling = null) {
    assertLive(); const packet = await github.readChangedPaths(job), facts = await admission.evaluatePr(job, packet, { batchClaim, ...(scheduling ? { scheduling } : {}) }); assertLive();
    factsValid(job, packet, facts, domain, clock(), batchClaim);
    return { packet, facts };
  }
  function bound(job, { packet, facts }) {
    record('native_check_boundary', { jobId: job.id, nativeObservationSha256: facts.observationSha256, packetSha256: digest(packet) });
    return { facts, packet, bindingSha256: binding(job, packet, facts, authority) };
  }
  async function boundary(job, batchClaim) { return bound(job, await evaluate(job, batchClaim)); }
  async function inventory(job, externalId) {
    const list = await github.readChecks(job.headSha);
    check(list?.complete === true && Array.isArray(list.checks) && list.checks.length <= 10000 && new Set(list.checks.map(c => c?.id)).size === list.checks.length
      && list.checks.every(c => Number.isSafeInteger(c?.id) && c.id > 0 && c.head_sha === job.headSha), 'COMPLETE_CHECK_INVENTORY_REQUIRED');
    return list.checks.filter(c => identity(c, job, externalId));
  }
  async function readback(job, externalId, id, conclusion) { const m = await inventory(job, externalId); check(m.length === 1 && m[0].id === id && m[0].status === 'completed' && m[0].conclusion === conclusion, 'NATIVE_CHECK_READBACK_UNCONFIRMED'); return m[0]; }
  async function transition(key, phase, next, details) { try { return await journal.transition(key, phase, next, details); } catch { return null; } }
  async function revoke({ job, key, externalId, known, phase, cause, sideEffects, admissionDiagnostic }) {
    const revKey = digest({ action: 'native-work-admission-revoke/2', effectKey: key, checkRunId: known.id }); let revPhase = 'intent', logged = false;
    try { const m = await inventory(job, externalId); check(m.length === 1 && m[0].id === known.id, 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED'); }
    catch { return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED', effectKey: key, sideEffects, productionAuthorized: false }; }
    try {
      const intent = await journal.begin(revKey, { checkRunId: known.id, appId: APP_ID, name: CHECK_NAME, headSha: job.headSha, externalId });
      if (intent.existing) return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_RECONCILIATION_REQUIRED', effectKey: key, sideEffects, productionAuthorized: false };
      await journal.transition(revKey, 'intent', 'authorized'); revPhase = 'authorized'; await journal.transition(revKey, 'authorized', 'sent'); revPhase = 'sent'; logged = true;
    } catch { if (phase !== 'sent') return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_JOURNAL_UNCONFIRMED', effectKey: key, sideEffects, productionAuthorized: false }; }
    try {
      assertLive(); sideEffects++;
      const unavailable = unverified(cause, admissionDiagnostic);
      const patched = await github.revokeCheck(known.id, { status: 'completed', conclusion: 'failure', output: { title: withdrawalTitle('Work admission', cause, unavailable), summary: `Reconcile Native admission check ${key}; ${cause}.${withdrawalNote(cause, unavailable)} No Native ticket or Receipt is asserted.` } });
      check(identity(patched, job, externalId) && patched.status === 'completed' && patched.conclusion === 'failure', 'NEGATIVE_COMPENSATION_UNCONFIRMED'); await readback(job, externalId, known.id, 'failure');
      if (logged) await journal.transition(revKey, 'sent', 'settled', { checkRunId: known.id, conclusion: 'failure' });
      const current = await journal.read(key); check(['sent', 'uncertain', 'settled'].includes(current?.state), 'NEGATIVE_COMPENSATION_STATE_UNCONFIRMED');
      await journal.transition(key, current.state, 'revoked', { checkRunId: known.id, externalId, reason: cause, ...(admissionDiagnostic ? { admissionDiagnostic } : {}) });
      record('native_check_revoked', { effectKey: key, checkRunId: known.id, cause });
      return { status: 'REVOKED', reason: cause, ...(admissionDiagnostic ? { admissionDiagnostic } : {}), effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: false };
    } catch {
      if (revPhase === 'sent') await transition(revKey, 'sent', 'uncertain', { checkRunId: known.id, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' });
      if (phase === 'sent') await transition(key, 'sent', 'uncertain', { checkRunId: known.id, externalId, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' });
      return { status: 'UNCERTAIN', effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: false, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' };
    }
  }
  async function publishOnce(input) {
    let job, key = null, externalId = null, previous = null, before, claimed = null, scheduling = null;
    // 'boundary' while the first evaluation runs; a refusal there with no batch claim recorded is safe to re-run.
    let step = 'start';
    try {
      job = fixedJob(input);
      // A claim recorded earlier for this exact batch names the one effect to reconcile.
      claimed = await batchClaims.read(job);
      if (claimed) {
        key = admissionEffectKeyV2(ACTION, job, claimed, DEFINITION); externalId = admissionExternalIdV2(PREFIX, job, claimed);
        previous = await journal.read(key);
        if (previous && previous.state !== 'settled') return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
      } else {
        // C4: GitHub is the shared record of what was published on this head, by any node or install.
        step = 'published-on-github';
        assertLive();
        const sameJob = `${PREFIX}:v2:${job.id}:a${job.attempt}:`;
        // §41.4: a train front batch is its own identity (H, S): only the role checks of its own jobs count, never a non-front run of H.
        const front = frontJobIdsV2(job);
        const published = [...new Set((await readPublishedChecks(github, job.headSha, APP_ID))
          .filter(c => (PUBLISHED_ROLE_CHECK_NAMES.includes(c.name) && (front === null || ofJobIds(c, front)))
            || (c.name === CHECK_NAME && typeof c.external_id === 'string' && c.external_id.startsWith(sameJob)))
          .map(c => c.name))].sort();
        if (published.length) throw Object.assign(new Error(HEAD_PUBLISHED_ON_GITHUB), { code: HEAD_PUBLISHED_ON_GITHUB, publishedChecks: published });
      }
      step = 'boundary';
      const evaluated = await evaluate(job, claimed, facts => { scheduling = facts; });
      // DESIGN 51 (B): GitHub must answer once more before the batch claim is recorded or anything is written; if it cannot (after the
      // bounded read retry) the refusal is clean and safe to re-run, with no claim and no journal record.
      step = 'probe';
      await github.readPullRequest(job.pr);
      check((await github.readChecks(job.headSha))?.complete === true, 'COMPLETE_CHECK_INVENTORY_REQUIRED');
      step = 'admitted';
      before = bound(job, evaluated);
      if (!claimed) {
        // First admission of this batch: the observed generation becomes the sticky batch claim.
        await batchClaims.record(job, before.facts.observedClaim, before.facts.observedAt);
        claimed = claimGeneration(before.facts.observedClaim);
        key = admissionEffectKeyV2(ACTION, job, claimed, DEFINITION); externalId = admissionExternalIdV2(PREFIX, job, claimed);
        previous = await journal.read(key);
        if (previous && previous.state !== 'settled') return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
      }
      if (previous) { await reverified(job, () => readback(job, externalId, previous.details.checkRunId, 'success')); return { status: 'SETTLED', effectKey: key, checkRunId: previous.details.checkRunId, sideEffects: 0, productionAuthorized: production, scheduling }; }
    } catch (e) {
      if (previous?.state === 'settled' && Number.isSafeInteger(previous.details?.checkRunId) && previous.details.checkRunId > 0)
        return revoke({ job, key, externalId, known: { id: previous.details.checkRunId }, phase: 'settled', cause: safe(e), sideEffects: 0, admissionDiagnostic: diagnosticOf(e) });
      // A refused evaluation gets a durable diagnostic record under a FRESH key only: it never blocks
      // a later, admitted evaluation of the same content and claim. Never POST or replay.
      if (job) {
        try {
          const diag = digest({ action: 'native-work-admission-blocked/2', jobId: job.id, evaluationRef: randomUUID() });
          await journal.begin(diag, { subject: subjectOfV2(job), definition: DEFINITION, observationKind: 'blocked-native-admission-control', diagnosticOnly: true });
          await journal.transition(diag, 'intent', 'not_sent', { reason: safe(e), ...(diagnosticOf(e) ? { admissionDiagnostic: diagnosticOf(e) } : {}),
            ...(e?.publishedChecks ? { publishedChecks: e.publishedChecks } : {}) });
        } catch { /* diagnostic only */ }
      }
      const reason = safe(e), admissionDiagnostic = diagnosticOf(e);
      return { status: 'BLOCKED', reason, ...(admissionDiagnostic ? { admissionDiagnostic } : {}), ...(e?.publishedChecks ? { publishedChecks: e.publishedChecks } : {}),
        sideEffects: 0, productionAuthorized: false, safeToRerun: refusalSafeToRerun({ step, claimed, reason, diagnostic: admissionDiagnostic }), scheduling };
    }
    let phase = 'intent', sent = false, known = null, sideEffects = 0;
    try {
      const intent = await journal.begin(key, { subject: subjectOfV2(job), claim: claimed, definition: DEFINITION, externalId, observationKind: 'actual-native-admission-control',
        nativeObservationSha256: before.facts.observationSha256, bindingSha256: before.bindingSha256, compensation: 'known-success-one-bounded-negative-patch' });
      if (intent.existing) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects, productionAuthorized: false };
      await journal.transition(key, 'intent', 'authorized', { nativeObservationSha256: before.facts.observationSha256 }); phase = 'authorized';
      assertLive(); check(fresh(before.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_BEFORE_WRITE');
      const payload = { name: CHECK_NAME, head_sha: job.headSha, status: 'completed', conclusion: 'success', external_id: externalId,
        output: { title: 'Work claim and complete Native admission verified', summary: `Independent Native control check for ${REPO}#${job.pr} (attempt ${job.attempt}); observation sha256 ${before.facts.observationSha256}. ${before.facts.publicationRequired ? 'This observation is not scanner execution or qualification. The protected publisher attaches its Native Receipt.' : 'This is not a scanner execution, Native publication ticket, Receipt or qualification.'}`
          + (production || scanStartRegistrySha256 !== null ? '\n' + scanStartSubjectLine(job, before.facts, scanStartRegistrySha256, clock()) : '') } };
      const nativeHandle = await prepareNativePublication(github, { facts: before.facts, packet: before.packet, payload });
      await journal.transition(key, 'authorized', 'sent', { externalId, nativeObservationSha256: before.facts.observationSha256 }); phase = 'sent'; sent = true; sideEffects++;
      const posted = await github.createCheck(payload, nativeHandle);
      check(identity(posted, job, externalId) && posted.status === 'completed' && posted.conclusion === 'success', 'NATIVE_CHECK_IDENTITY_UNCONFIRMED'); known = posted;
      const after = await reverified(job, async () => {
        const a = await boundary(job, claimed); check(a.bindingSha256 === before.bindingSha256, 'NATIVE_AUTHORIZATION_BINDING_CHANGED');
        await readback(job, externalId, known.id, 'success'); assertLive(); check(fresh(a.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE');
        return a;
      });
      await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: 'success', nativeObservationBeforeSha256: before.facts.observationSha256, nativeObservationAfterSha256: after.facts.observationSha256, bindingSha256: after.bindingSha256 });
      record('native_check_settled', { effectKey: key, checkRunId: known.id, beforeSha256: before.facts.observationSha256, afterSha256: after.facts.observationSha256 });
      return { status: 'SETTLED', effectKey: key, checkRunId: known.id, nativeObservationBeforeSha256: before.facts.observationSha256, nativeObservationAfterSha256: after.facts.observationSha256, sideEffects, productionAuthorized: production, scheduling };
    } catch (e) {
      if (sent && !known && sideEffects === 1 && nativePublicationNoPostProof(e)?.notSent === true) {
        await transition(key, phase, 'revoked', { reason: 'native_publication_not_sent', notSent: true, externalId });
        return { status: 'BLOCKED', effectKey: key, reason: 'native_publication_not_sent', sideEffects: 0, productionAuthorized: false };
      }
      if (sent && !known) { try { const m = await inventory(job, externalId); if (m.length === 1) known = m[0]; } catch { /* read-only discovery cannot prove a missing POST */ } }
      if (sent && known) return revoke({ job, key, externalId, known, phase, cause: safe(e), sideEffects, admissionDiagnostic: diagnosticOf(e) });
      await transition(key, phase, sent ? 'uncertain' : 'not_sent', { reason: safe(e), externalId });
      return { status: sent ? 'UNCERTAIN' : 'BLOCKED', effectKey: key, reason: safe(e), sideEffects, productionAuthorized: false };
    }
  }
  return Object.freeze({ fixture: !production, async publish(input) {
    let front = false;
    try { front = isTrainFrontJobV2(fixedJob(input)); } catch { /* publishOnce refuses it */ }
    if (front && trainFrontRefused(input, trainMode))
      return { status: 'BLOCKED', reason: trainFrontRefusal(trainModeUnreadable), sideEffects: 0, productionAuthorized: false, safeToRerun: false, scheduling: null };
    const result = await publishOnce(input);
    return front && trainMode === 'on' && result.status === 'SETTLED' ? { ...result, trainTouch: await touchRunning(input) } : result;
  } });
}
export function createFixtureWorkAdmissionPublisherV2(dependencies) { return engine(dependencies, false); }
export function createProductionWorkAdmissionPublisherV2(dependencies) { return engine(dependencies, true); }
