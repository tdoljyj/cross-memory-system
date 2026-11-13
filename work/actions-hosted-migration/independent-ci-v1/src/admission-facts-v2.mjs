// Pure validation of complete Native admission facts of contract /2 (DESIGN S6). Split out of
// full-admission-v2.mjs so that the Linux side (bridge v4 protocol, scanner adapters) can validate the
// facts it receives without loading the Windows-only evaluator (scripts/ci/clued-work-admission.mjs).
// No I/O. full-admission-v2.mjs re-exports everything here unchanged.
import { digest } from './proof.mjs';
import { freshStamp, retainedServerAnswerCurrent } from './clock-skew.mjs';
import { sameClaimGeneration } from './job-v2.mjs';
import { normalizeTerminalAdmission } from '../../../../scripts/ci/clued-pr-task-binding.mjs';
import { mergeQueueEntryV2, MERGE_QUEUE_STATES } from './independent-control-checks-v2/queue-facts.mjs';

export const FULL_ADMISSION_CONTRACT_V2 = 'clued.independent-ci.full-admission/2';
// /2 retains its frozen staged+unguarded meaning. Active facts use a separate
// contract so an old bridge or publisher cannot silently accept new authority.
export const FULL_ADMISSION_CONTRACT_V3 = 'clued.independent-ci.full-admission/3';
export const ADMISSION_ENGINE = 'scripts/ci/clued-work-admission.mjs#evaluate';
const sha = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const at = value => typeof value === 'string' ? Date.parse(value) : NaN;

// ---- the rejection diagnostic of a BLOCKED admission (fixed enums only; full-admission-v2.mjs builds it) ----
// Native and evaluator reasons are reduced to these codes; anything else is 'unknown_reason'.
export const REASON_CODES = Object.freeze(['claim_trailer_missing', 'claim_not_found', 'claim_not_current', 'fence_superseded',
  'pr_task_binding_unbound', 'pr_task_binding_no_live_claim', 'pr_task_binding_handover_pending',
  'pr_task_binding_head_not_authorized', 'pr_task_binding_conflict',
  'copy_not_adopted', 'claim_bound_to_other_pr', 'claim_head_cap_reached', 'task_ci_head_cap_reached', 'work_claim_conflict',
  'path_outside_write_set', 'paths_outside_write_set', 'head_budget_exhausted', 'ci_budget_exhausted', 'merge_slot_required',
  'merge_slot_missing', 'owner_grant_required', 'owner_grant_missing', 'owner_grant_revoked', 'owner_grant_expired',
  'admission_binding_required', 'authorization_revoked_or_expired', 'binding_not_authorized', 'resource_action_not_authorized',
  'evaluation_not_completed', 'workflow_change_not_authorized', 'workflow_missing_admission_gate', 'work_claim_execution_epoch_stale']);
export const REASON_PREFIXES = Object.freeze({ 'changed_files_truncated:': 'changed_files_truncated', 'claim_base_unknown:': 'claim_base_unknown',
  'workflow_gate:': 'workflow_gate', 'policy_file_removed:': 'policy_file_removed', 'policy_file_invalid:': 'policy_file_invalid',
  'protected_change_not_up_to_date:': 'protected_change_not_up_to_date', 'owner_review_required (': 'owner_review_required',
  'owner_review_unavailable:': 'owner_review_unavailable', 'workflow runs unavailable:': 'workflow_runs_unavailable' });
export const DIAGNOSTIC_CODES = Object.freeze([...new Set([...REASON_CODES, ...Object.values(REASON_PREFIXES), 'unknown_reason'])]);
const REASON_SET = new Set(REASON_CODES), DIAGNOSTIC_SET = new Set(DIAGNOSTIC_CODES);
export const DIAGNOSTIC_PHASES = Object.freeze(['mode', 'principal', 'observer', 'pull_request', 'claim_reference', 'evaluate', 'post_evaluate', 'post_pull_request', 'native', 'changed_paths']);
const ISSUER_TRANSIENT_ADMISSIONS = new Set(['full_admission_observation_expired', 'full_admission_unavailable']);
export const verdict = value => ['ADMITTED', 'REJECTED', 'ERROR', 'PR_NOT_OPEN', 'NOT_APPLICABLE'].includes(value) ? value : 'UNKNOWN';
export const ownerKind = value => ['granted', 'pending', 'transient', 'rpc_unavailable', 'refused'].includes(value) ? value : 'UNKNOWN';
export const reasonCodes = values => [...new Set((Array.isArray(values) ? values.slice(0, 64) : []).map(value => {
  if (REASON_SET.has(value)) return value;
  return typeof value === 'string' ? Object.entries(REASON_PREFIXES).find(([prefix]) => value.startsWith(prefix))?.[1] ?? 'unknown_reason' : 'unknown_reason';
}))].sort();

// Scheduling facts (resident quota redesign v0.6 §9 phase 1, item 4): Native's ci_retry_after (when the Task's CI
// head cap is reached) and whether the claim is in the merge queue at all (queue-facts.mjs#mergeQueueEntryV2).
// They steer the resident's scheduling and the PR page; they are never admission authority.
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
export const isoOrNull = value => typeof value === 'string' && value.length <= 40 && ISO_TIME.test(value) && Number.isFinite(Date.parse(value))
  ? new Date(Date.parse(value)).toISOString() : null;
// Generation 12 (resident DESIGN 56.3): claimExpiresAt, the claim's lease end as Native reported it, so the resident can tell the
// holder to renew before the lease ends under a running or parked batch. Display only: the admission itself still checks the lease.
export function schedulingFactsV2(outcome, native, repo) {
  return { ciRetryAfter: isoOrNull(outcome?.ci_retry_after ?? native?.ci_retry_after ?? null), mergeQueue: mergeQueueEntryV2(native?.claim, { repo }),
    claimExpiresAt: isoOrNull(native?.claim?.expires_at ?? null) };
}
function mergeQueueFact(value) {
  if (!plain(value) || Object.keys(value).sort().join('|') !== 'entered|position|state' || typeof value.entered !== 'boolean') return null;
  const state = MERGE_QUEUE_STATES.includes(value.state) ? value.state : null;
  const position = Number.isSafeInteger(value.position) && value.position > 0 && value.position <= 10_000 ? value.position : null;
  return { entered: value.entered && (state === 'head' || state === 'waiting'), state, position };
}
// The one sanitizer of scheduling facts for every consumer (diagnostic, entry outcome, stage fact): fixed shape or null.
export function sanitizeSchedulingV2(value) {
  if (!plain(value)) return null;
  return { ciRetryAfter: isoOrNull(value.ciRetryAfter), mergeQueue: mergeQueueFact(value.mergeQueue), claimExpiresAt: isoOrNull(value.claimExpiresAt) };
}
// The one sanitizer of a rejection diagnostic (publisher result, entry outcome, stage fact). null when it is not
// an object. Verdicts, the owner-review kind and the two code lists are always present; the rest only when valid.
export function sanitizeAdmissionDiagnosticV2(d) {
  if (!plain(d)) return null;
  const diagnostic = { verdict: verdict(d.verdict), nativeVerdict: verdict(d.nativeVerdict), ownerReviewKind: ownerKind(d.ownerReviewKind) };
  for (const field of ['reasonCodes', 'nativeReasonCodes']) diagnostic[field] = [...new Set((Array.isArray(d[field]) ? d[field].slice(0, 64) : []).map(value => DIAGNOSTIC_SET.has(value) ? value : 'unknown_reason'))].sort();
  // transport (generation 10, resident DESIGN 53.6): full_admission_unavailable caught a network failure, a timeout or a GitHub/Native
  // 500/502/503/504, not any other exception of the evaluation (a refused credential, a 401/403, an evaluator fault).
  for (const field of ['workflowGateFindingsPresent', 'modeFresh', 'recorderFresh', 'transport']) if (typeof d[field] === 'boolean') diagnostic[field] = d[field];
  if (DIAGNOSTIC_PHASES.includes(d.phase)) diagnostic.phase = d.phase;
  // Issuer retry context is diagnostic only: one round has at most four evaluations.
  if (ISSUER_TRANSIENT_ADMISSIONS.has(d.transientAdmission)) {
    diagnostic.transientAdmission = d.transientAdmission;
    if (Number.isSafeInteger(d.evaluations) && d.evaluations >= 1 && d.evaluations <= 4) diagnostic.evaluations = d.evaluations;
  }
  if (Object.hasOwn(d, 'ciRetryAfter') || Object.hasOwn(d, 'mergeQueue')) {
    const { ciRetryAfter, mergeQueue } = sanitizeSchedulingV2({ ciRetryAfter: d.ciRetryAfter, mergeQueue: d.mergeQueue });
    Object.assign(diagnostic, { ciRetryAfter, mergeQueue });
  }
  return diagnostic;
}

// Shared validation of admitted v2 facts for every consumer (publishers, bridge, adapters).
export const ADMISSION_FIELDS_V2 = Object.freeze(['contract', 'status', 'admitted', 'completeAdmission', 'evaluator', 'domain', 'repository', 'scope',
  'prRef', 'headSha', 'baseSha', 'jobId', 'role', 'attempt', 'claimId', 'fence', 'epoch', 'observedClaim', 'batchClaimBound', 'sourceManifestSha256',
  'executionPolicy', 'guarded', 'executionHandoverPending', 'mergeQueueHead', 'mode', 'mergeSlot', 'ownerReview', 'workflowGateFindings', 'observedAt',
  'claimExpiresAt', 'modeProofRef', 'observationRef', 'packetSha256', 'evaluationSha256', 'observationSha256']);
export const ADMISSION_FIELDS_V3 = Object.freeze([...ADMISSION_FIELDS_V2, 'publicationRequired', 'headAuthorizationId']);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// The execution guard in force (field 2026-11-13, PR #1086): a claim that requires a lease key (one handed over on the page keeps it) is
// guarded only once Native's execution policy is active; while it is staged, Native admits it without any key or head authorization, like
// any other claim. A value that is not a boolean stays as it is (refused by supportedNativeExecution).
export function effectiveGuard(policy, leaseKeyRequired) {
  return typeof leaseKeyRequired === 'boolean' ? policy === 'active' && leaseKeyRequired : leaseKeyRequired;
}
export function supportedNativeExecution(policy, guarded) {
  return policy === 'staged' && guarded === false || policy === 'active' && typeof guarded === 'boolean';
}
function executionFactsValid(facts) {
  if (facts.contract === FULL_ADMISSION_CONTRACT_V2) return facts.executionPolicy === 'staged' && facts.guarded === false;
  return facts.contract === FULL_ADMISSION_CONTRACT_V3 && facts.executionPolicy === 'active' && typeof facts.guarded === 'boolean'
    && facts.publicationRequired === true && (facts.guarded ? typeof facts.headAuthorizationId === 'string' && uuid.test(facts.headAuthorizationId) : facts.headAuthorizationId === null);
}
const fieldsFor = facts => [...(facts?.contract === FULL_ADMISSION_CONTRACT_V3 ? ADMISSION_FIELDS_V3 : ADMISSION_FIELDS_V2),
  ...(Object.hasOwn(facts ?? {}, 'terminalAdmission') ? ['terminalAdmission'] : [])];
export function admittedFactsMatchJobV2(facts, job, now, { batchClaim = null } = {}) {
  const serverCurrent = retainedServerAnswerCurrent(facts);
  if (!plain(facts) || !executionFactsValid(facts) || Object.keys(facts).sort().join('|') !== [...fieldsFor(facts)].sort().join('|')
    || facts.status !== 'ADMITTED' || facts.admitted !== true || facts.completeAdmission !== true
    || facts.evaluator !== ADMISSION_ENGINE || facts.repository !== job.repo || facts.prRef !== `${job.repo}#${job.pr}` || facts.headSha !== job.headSha
    || facts.baseSha !== job.baseSha || facts.jobId !== job.id || facts.role !== job.role || facts.attempt !== job.attempt
    || facts.sourceManifestSha256 !== job.sourceManifestSha256
    || facts.executionHandoverPending !== false || !plain(facts.observedClaim) || facts.observedClaim.claimId !== facts.claimId
    || facts.observedClaim.fence !== facts.fence || facts.observedClaim.epoch !== facts.epoch || facts.observedClaim.expiresAt !== facts.claimExpiresAt
    || !(serverCurrent === null ? freshStamp(at(facts.observedAt), now) && at(facts.claimExpiresAt) > now : serverCurrent)) return false;
  try { if (Object.hasOwn(facts, 'terminalAdmission')) normalizeTerminalAdmission(facts.terminalAdmission, facts.observedClaim); }
  catch { return false; }
  if (batchClaim && !sameClaimGeneration(facts.observedClaim, batchClaim)) return false;
  const { observationSha256, ...body } = facts;
  return sha.test(observationSha256 ?? '') && digest(body) === observationSha256;
}

// Owner Decision 6f1fb753 (Task 576231fa): the admission inside a bridge v4 callback response is fresh when the
// Windows issuer issued that response, like the issue's own admission (protocol.mjs validateResponse); the response
// then only has to arrive inside its own window. A relay call that took 30 s (PR #915 stage 4, 2026-10-23) refused
// a response the issuer had answered in 10 s. The Linux worker notes the issuance and expiry of exactly the facts
// object it hands an adapter; while that response is valid, and never past the claim, the 30 s bound below is measured
// from its issuance. Facts that did not come out of a validated response (every Windows caller) keep `now`.
const bridgeResponseTimes = new WeakMap();
export function noteBridgeResponseTimes(facts, response) {
  const issuedAt = at(response?.issuedAt), expiresAt = Math.min(at(response?.expiresAt), at(facts?.claimExpiresAt));
  if (plain(facts) && Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) && issuedAt < expiresAt) bridgeResponseTimes.set(facts, { issuedAt, expiresAt });
  return facts;
}
export function admissionReferenceTime(facts, now) {
  const t = plain(facts) ? bridgeResponseTimes.get(facts) : undefined;
  return t && Number.isSafeInteger(now) && t.issuedAt <= now && now < t.expiresAt ? t.issuedAt : now;
}
// The same for the refs snapshot of a bridge v4 remote-refs response (Task 576231fa; protocol.mjs validateResponse
// measures its 30 s at the response's issuedAt). The Linux worker notes the issuance and expiry of exactly the snapshot
// object it hands the gitleaks adapter; while that response is valid, a check of the snapshot's freshness
// (validateRemoteSnapshot) measures from the issuance when it asks remoteRefsReferenceTime. Any other object keeps `now`.
const bridgeRefsTimes = new WeakMap();
export function noteBridgeRefsTimes(refs, response) {
  const issuedAt = at(response?.issuedAt), expiresAt = at(response?.expiresAt);
  if (plain(refs) && Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) && issuedAt < expiresAt) bridgeRefsTimes.set(refs, { issuedAt, expiresAt });
  return refs;
}
export function remoteRefsReferenceTime(refs, now) {
  const t = plain(refs) ? bridgeRefsTimes.get(refs) : undefined;
  return t && Number.isSafeInteger(now) && t.issuedAt <= now && now < t.expiresAt ? t.issuedAt : now;
}

// The one admission check of the Linux scanner adapters and the bridge v4 protocol (replaces the three
// per-adapter v1 validateAdmission copies). A scanner stage's admission is always made under the batch
// claim recorded by stage 1, so batchClaimBound is required and must name the observed claim; a caller
// that already holds the run's generation passes it as batchClaim (renewal = same generation).
export function validateFormalAdmissionV2(job, a, now = Date.now(), { batchClaim = null } = {}) {
  const generation = v => plain(v) && Object.keys(v).sort().join('|') === 'claimId|epoch|fence';
  if (!plain(a) || Object.keys(a).sort().join('|') !== [...fieldsFor(a)].sort().join('|') || a.domain !== 'production'
    || !generation(a.batchClaimBound) || !sameClaimGeneration(a.observedClaim, a.batchClaimBound)
    || !admittedFactsMatchJobV2(a, job, admissionReferenceTime(a, now), { batchClaim })) {
    throw Object.assign(new Error('FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED'), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' });
  }
  return a;
}
