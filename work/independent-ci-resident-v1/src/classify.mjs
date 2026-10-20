// Failure classification. The executor only continues after a failure it can prove is clean;
// anything it does not recognise, or anything without a complete cleanup proof, is UNKNOWN and
// latches HALT. The tables are allow-lists: a new or misspelled code falls through to UNKNOWN.
import { CODE, check } from './canonical.mjs';

// Native admission said no. Only at stage 1 is this a plain evaluation result (no scanner ran);
// at any later stage it ends an execution and is treated like any other stage failure.
const NOT_ADMITTED = new Set([
  'NATIVE_NOT_ADMITTED',
  'OWNER_REVIEW_REQUIRED',
  'PROTECTED_CHANGE_NOT_UP_TO_DATE',
  'PATHS_OUTSIDE_WRITE_SET',
  'CLAIM_NOT_CURRENT',
  'TASK_CI_HEAD_CAP_REACHED',
]);

// Stage endings that are clean only together with a complete cleanup proof: service back to the
// Stopped/Manual original, Windows process tree 0, Linux units inactive with empty cgroups and no
// container carrying the batch nonce. The proof is checked here, not assumed from the code.
const CLEAN_WITH_PROOF = new Set([
  ...NOT_ADMITTED,
  'FULL_NEXT_STAGE_AUTHORITY_WINDOW_REQUIRED',
  'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED',
  'FIXED_PUBLIC_CHILD_REFUSED',
  'ACTUAL_ISSUE_NOT_PUBLISHED',
  'ISSUE_TRANSFER_UNCONFIRMED',
  'FORMAL_BRIDGE_STAGE_DEADLINE',
  'RESIDENT_QUEUE_HEAD_NOT_REACHED',
  'WORKSPACE_PREPARATION_REFUSED',
]);

export const FAILURE_CLASSES = Object.freeze(['NOT_ADMITTED', 'CLEAN', 'UNKNOWN']);

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
      ? { klass: 'CLEAN', basis: 'cleanup-proof-complete' }
      : { klass: 'UNKNOWN', basis: 'cleanup-proof-incomplete' };
  }
  return { klass: 'UNKNOWN', basis: 'not-an-allow-listed-clean-failure' };
}

// The archive reason segment is derived from the stable code, never taken from untrusted text.
export function archiveReason(code) {
  check(typeof code === 'string' && CODE.test(code), 'ARCHIVE_REASON_CODE_INVALID');
  return code.toLowerCase().replace(/_/g, '-').slice(0, 40).replace(/-+$/, '');
}
