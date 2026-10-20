// Failure classification. The executor only continues after a failure it can prove is clean;
// anything it does not recognise, or anything without a complete cleanup proof, is UNKNOWN and
// latches HALT. The tables are allow-lists: a new or misspelled code falls through to UNKNOWN.
//
// Source v2 (DESIGN S11): the stage codes below MIRROR the stable failure catalogue of the installed
// Source (actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs); a test keeps the
// two identical. The resident never imports the Source at run time (it is a separate pinned layer).
import { CODE, check } from './canonical.mjs';

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
  'NATIVE_POLICY_UNSUPPORTED', 'PUBLICATION_BLOCKED', 'PUBLICATION_REVOKED', 'EVIDENCE_REFUSED', 'WORKSPACE_PREPARATION_REFUSED']);
// Never clean (listed for the cross-check and the reader; anything not allow-listed is UNKNOWN anyway).
export const UNKNOWN_CODES = Object.freeze(['BROKER_RESPONSE_UNCONFIRMED', 'STAGE_HELPER_NOT_STOPPED_IN_TIME', 'STAGE_ORIGINAL_NOT_RESTORED',
  'BROKER_CONFIGURATION_CONFLICT', 'NATIVE_RECEIPT_UNCONFIRMED', 'STAGE_CHILD_TREE_UNCONFIRMED', 'STAGE_OUTCOME_MISSING', 'PUBLICATION_UNCERTAIN',
  'RECONCILIATION_REQUIRED', 'EVIDENCE_IDENTITY_CONFLICT', 'ADMISSION_CONFIGURATION_REFUSED', 'BROKER_UNCONFIRMED', 'BROKER_BUSY']);
// Resident-side codes that end a stage cleanly before or around the Source stage (companion pump, the v1
// one-shot states kept for an unchanged reading of older receipts).
const RESIDENT_CLEAN = Object.freeze(['FULL_NEXT_STAGE_AUTHORITY_WINDOW_REQUIRED', 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED', 'FIXED_PUBLIC_CHILD_REFUSED',
  'ACTUAL_ISSUE_NOT_PUBLISHED', 'ISSUE_TRANSFER_UNCONFIRMED', 'FORMAL_BRIDGE_STAGE_DEADLINE']);

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

// stageNumber: 1..8, or 0 for the workspace preparation between stage 1 and stage 2.
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

// The archive reason segment is derived from the stable code, never taken from untrusted text.
export function archiveReason(code) {
  check(typeof code === 'string' && CODE.test(code), 'ARCHIVE_REASON_CODE_INVALID');
  return code.toLowerCase().replace(/_/g, '-').slice(0, 40).replace(/-+$/, '');
}
