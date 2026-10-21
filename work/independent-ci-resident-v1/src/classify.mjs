// Failure classification. The executor only continues after a failure it can prove is clean;
// anything it does not recognise, or anything without a complete cleanup proof, is UNKNOWN and
// latches HALT. The tables are allow-lists: a new or misspelled code falls through to UNKNOWN.
//
// Source v2 (DESIGN S11): the stage codes below MIRROR the stable failure catalogue of the installed
// Source (actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs); a test keeps the
// two identical. The resident never imports the Source at run time (it is a separate pinned layer).
import { CODE, HEX64, check } from './canonical.mjs';

// Stage 1 only: Native said no. Nothing was published, nothing executed.
export const NOT_ADMITTED_CODES = Object.freeze(['NATIVE_NOT_ADMITTED', 'OWNER_REVIEW_REQUIRED', 'PROTECTED_CHANGE_NOT_UP_TO_DATE', 'PATHS_OUTSIDE_WRITE_SET',
  'CLAIM_NOT_CURRENT', 'TASK_CI_HEAD_CAP_REACHED', 'CLAIM_HEAD_CAP_REACHED', 'CI_BUDGET_EXHAUSTED', 'WORKFLOW_CHANGE_NOT_AUTHORIZED', 'PR_NOT_OPEN_OR_CHANGED']);
// Clean transient: an outside, passing condition. The only codes the one automatic attempt 2 may follow
// (attempts.mjs; Owner decision 1b5d3687).
export const TRANSIENT_CODES = Object.freeze(['NATIVE_ADMISSION_UNAVAILABLE', 'GITHUB_TRANSIENT_UNAVAILABLE', 'BRIDGE_TRANSPORT_TIMEOUT',
  'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 'ARCHIVE_PRECONDITION_NOT_MET']);
// Clean, but final for this head and attempt.
export const CLEAN_FINAL_CODES = Object.freeze(['STAGE_PACKAGE_REFUSED', 'STAGE_INPUT_RESULT_MISSING', 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED', 'BROKER_REQUEST_EXPIRED',
  'BROKER_REQUEST_REFUSED', 'STAGE_HELPER_PREFLIGHT_REFUSED', 'STAGE_CHILD_REFUSED', 'STAGE_CHILD_TIMEOUT', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 'BATCH_CLAIM_CHANGED',
  'NATIVE_POLICY_UNSUPPORTED', 'PUBLICATION_BLOCKED', 'PUBLICATION_REVOKED', 'EVIDENCE_REFUSED', 'WORKSPACE_PREPARATION_REFUSED',
  'RELAY_STAGE_REFUSED']);
// Never clean (listed for the cross-check and the reader; anything not allow-listed is UNKNOWN anyway).
export const UNKNOWN_CODES = Object.freeze(['BROKER_RESPONSE_UNCONFIRMED', 'STAGE_HELPER_NOT_STOPPED_IN_TIME', 'STAGE_ORIGINAL_NOT_RESTORED',
  'BROKER_CONFIGURATION_CONFLICT', 'NATIVE_RECEIPT_UNCONFIRMED', 'STAGE_CHILD_TREE_UNCONFIRMED', 'STAGE_OUTCOME_MISSING', 'PUBLICATION_UNCERTAIN',
  'RECONCILIATION_REQUIRED', 'EVIDENCE_IDENTITY_CONFLICT', 'ADMISSION_CONFIGURATION_REFUSED', 'BROKER_UNCONFIRMED', 'BROKER_BUSY',
  // Stage R (S21): a relay publication that may exist unsettled, a role held on the head by the other path, a
  // relay plan that does not validate. The role is never run locally afterwards; the head burns and HALTs.
  'RELAY_PUBLICATION_UNCERTAIN', 'ROLE_ALREADY_PUBLISHED_ON_HEAD', 'RELAY_PLAN_UNCONFIRMED']);

// ---- stage R plan rows (mirror of hosted-relay-v1/stage.mjs LOCAL_REASONS and relay-plan.mjs) ----
// Why a relay candidate stays local: every RELAY_NOT_ATTESTED_* reason of stage R, and RELAY_ROLE_NOT_RELAYABLE.
// A LOCAL_REQUIRED row with any other reason is not a plan the executor acts on (RELAY_PLAN_UNCONFIRMED).
export const RELAY_LOCAL_REASONS = Object.freeze(['RELAY_ROLE_NOT_RELAYABLE', 'RELAY_NOT_ATTESTED_BILLING_REFUSED', 'RELAY_NOT_ATTESTED_HOSTED_NOT_SUCCESS',
  'RELAY_NOT_ATTESTED_PENDING', 'RELAY_NOT_ATTESTED_ABSENT', 'RELAY_NOT_ATTESTED_NOT_ELIGIBLE', 'RELAY_NOT_ATTESTED_ATTESTATION_FAILED',
  'RELAY_NOT_ATTESTED_OBSERVATION_UNCONFIRMED', 'RELAY_NOT_ATTESTED_NOT_CONFIRMED', 'RELAY_NOT_ATTESTED_NOT_ADMITTED']);
export const RELAY_ROW_FIELDS = Object.freeze(['role', 'outcome', 'reason', 'receipt', 'checkRunId', 'externalId', 'attestationSha256', 'detail']);
const EXTERNAL = /^independent-ci:relay:(gitleaks|trivy):[a-f0-9]{12}:run[1-9][0-9]{0,19}:a[1-9][0-9]{0,3}$/;

// Stage R rows for exactly the candidates (in order) -> { relayed: [row], local: [row] }, or null when any row
// is not a clean RELAYED / LOCAL_REQUIRED row (HALT, NOT_PROCESSED, an unknown reason, a missing field).
export function relayPlanFromRows(rows, candidates) {
  if (!Array.isArray(rows) || !Array.isArray(candidates) || rows.length !== candidates.length || rows.length === 0) return null;
  const relayed = [], local = [];
  for (const [i, r] of rows.entries()) {
    if (r === null || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== RELAY_ROW_FIELDS.length || !RELAY_ROW_FIELDS.every(k => Object.hasOwn(r, k))) return null;
    if (r.role !== candidates[i]) return null;
    if (r.outcome === 'RELAYED' && r.reason === null && r.receipt === 'relay-attested' && Number.isSafeInteger(r.checkRunId) && r.checkRunId > 0
      && typeof r.externalId === 'string' && EXTERNAL.test(r.externalId) && r.externalId.split(':')[2] === r.role && HEX64.test(r.attestationSha256 ?? '')) relayed.push(r);
    else if (r.outcome === 'LOCAL_REQUIRED' && RELAY_LOCAL_REASONS.includes(r.reason) && ['relay-local-fallback', 'relay-billing-refused'].includes(r.receipt)
      && r.checkRunId === null && r.externalId === null && r.attestationSha256 === null) local.push(r);
    else return null;
  }
  return { relayed, local };
}
// Resident-side codes that end a stage cleanly before or around the Source stage (companion pump, the v1
// one-shot states kept for an unchanged reading of older receipts).
// REFS_GATE_UNCONFIRMED: the refs gate before the first local scanner got no explicit answer; nothing ran; clean
// but final (never the transient REMOTE_REFS_CHANGED_SINCE_BUNDLE, PR-A review MINOR 5).
const RESIDENT_CLEAN = Object.freeze(['FULL_NEXT_STAGE_AUTHORITY_WINDOW_REQUIRED', 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED', 'FIXED_PUBLIC_CHILD_REFUSED',
  'ACTUAL_ISSUE_NOT_PUBLISHED', 'ISSUE_TRANSFER_UNCONFIRMED', 'FORMAL_BRIDGE_STAGE_DEADLINE', 'REFS_GATE_UNCONFIRMED']);

const NOT_ADMITTED = new Set(NOT_ADMITTED_CODES);
const TRANSIENT = new Set(TRANSIENT_CODES);
// Stage endings that are clean only together with a complete cleanup proof: service back to the
// Stopped/Manual original, Windows process tree 0, Linux units inactive with empty cgroups and no
// container carrying the batch nonce. The proof is checked here, not assumed from the code.
const CLEAN_WITH_PROOF = new Set([...NOT_ADMITTED_CODES, ...TRANSIENT_CODES, ...CLEAN_FINAL_CODES, ...RESIDENT_CLEAN]);

export const FAILURE_CLASSES = Object.freeze(['NOT_ADMITTED', 'CLEAN', 'UNKNOWN']);
export const isTransient = code => TRANSIENT.has(code);

export const proofComplete = proof => !!proof && proof.windowsTreeZero === true && proof.serviceOriginalStopped === true
  && proof.linuxUnitsInactive === true && proof.containersZero === true;

// stageNumber: 1..8, 9 for stage R (hosted relay), or 0 for the workspace preparation before the first local Linux stage.
export function classifyFailure(code, proof, stageNumber) {
  if (typeof code !== 'string' || !CODE.test(code)) return { klass: 'UNKNOWN', basis: 'unrecognised-failure-code' };
  if (stageNumber === 1 && NOT_ADMITTED.has(code) && proof && proof.windowsTreeZero === true && proof.serviceOriginalStopped === true) {
    return { klass: 'NOT_ADMITTED', basis: 'stage-1-evaluation' };
  }
  if (CLEAN_WITH_PROOF.has(code)) {
    return proofComplete(proof)
      ? { klass: 'CLEAN', basis: TRANSIENT.has(code) ? 'transient-cleanup-proof-complete' : 'cleanup-proof-complete' }
      : { klass: 'UNKNOWN', basis: 'cleanup-proof-incomplete' };
  }
  return { klass: 'UNKNOWN', basis: 'not-an-allow-listed-clean-failure' };
}

// ---- Owner abort (DESIGN §6.5) ----
// The only stages an Owner abort stops while they run: the scanner-issuer stages (entry role scanner-issuer in the
// Source layout), which publish no check. Every other stage runs to its own end; the abort takes the next safe point.
export const ABORTABLE_IN_FLIGHT = Object.freeze([2, 4, 6]);
export const OWNER_ABORTED = 'OWNER_ABORTED';
// How such a stage may end once it was asked to stop for an abort: any ending that is clean anyway, the stopped
// entry's missing outcome (STAGE_OUTCOME_MISSING: the helper drained its own job before the entry wrote it; UNKNOWN
// in every other path), a stage that was not invoked because the abort came first, or the cancelled bridge pump.
// Always together with the Windows half of the cleanup proof (helper tree drained, original binary restored).
export const OWNER_ABORT_STAGE_ENDINGS = Object.freeze([...TRANSIENT_CODES, ...CLEAN_FINAL_CODES, ...RESIDENT_CLEAN,
  'STAGE_OUTCOME_MISSING', 'OWNER_ABORT_REQUESTED', 'COMPANION_PUMP_CANCELLED']);
const ABORT_ENDINGS = new Set(OWNER_ABORT_STAGE_ENDINGS);
export function abortStageEndingClean(result) {
  if (!result || result.ok === true) return !!result;
  return typeof result.code === 'string' && ABORT_ENDINGS.has(result.code)
    && result.proof?.windowsTreeZero === true && result.proof?.serviceOriginalStopped === true;
}

// The archive reason segment is derived from the stable code, never taken from untrusted text.
export function archiveReason(code) {
  check(typeof code === 'string' && CODE.test(code), 'ARCHIVE_REASON_CODE_INVALID');
  return code.toLowerCase().replace(/_/g, '-').slice(0, 40).replace(/-+$/, '');
}
