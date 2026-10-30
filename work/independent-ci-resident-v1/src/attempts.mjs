// The one automatic attempt 2 (Owner decision 1b5d3687). Pure decision; the executor carries it out.
//
// Attempt 2 of a head happens automatically, once, only when attempt 1 ended
//   - FAILED_CLEAN (complete cleanup proof on both hosts, scene archived),
//   - with an allow-listed clean TRANSIENT code (classify.mjs#TRANSIENT_CODES: Native admission or GitHub
//     temporarily unavailable, a bridge transport timeout, a push between the bundle and the scan, an
//     archive precondition not met yet),
//   - before any role check was published: the failed stage is 1 (work admission; its own check is
//     attempt-scoped, and attempt 2 re-proves it under new job ids) or 2 (the first scanner execution),
//     or the workspace preparation between them. From stage 3 on a scanner/control role has published
//     (or may have), so nothing is ever retried there; nor after stage R (9) relayed any role, nor after a
//     failure of stage R itself (it publishes).
// Never retried: UNKNOWN (any HALT), any publication that may exist, evidence-identity conflicts, gate
// refusals (not admitted, claim moved, scanner findings, admission refused), an attempt 2 itself.
// The attempt number is part of every job identity (job contract v2), so attempt 2 never collides with
// anything attempt 1 created, and attempt 1's settled job ids are never run again.
// Besides the transient codes, the resident allow-list ATTEMPT2_RESIDENT_CODES (Owner decision eaa7d5e4, design r3 §3.6 O-2):
// a stage-2 FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED (DESIGN §27; the scanner issuer was proven to have published nothing)
// also gets the one attempt 2, at stage 2 only; so does a stage-2 LINUX_MEMORY_NOT_READY (DESIGN §32: the memory gate refused the stage
// before it was invoked). It lives in classify.mjs, whose failure table check needs it at load time.
import { ATTEMPT2_RESIDENT_CODES, isTransient } from './classify.mjs';

export { ATTEMPT2_RESIDENT_CODES };
export const ATTEMPT2_CONTRACT = 'clued.independent-ci.resident-attempt2/1';
// Stages after which no role check has been published yet (0 = workspace preparation).
export const ATTEMPT2_STAGES = Object.freeze([0, 1, 2]);
const residentCode = failure => typeof failure?.code === 'string' && Object.hasOwn(ATTEMPT2_RESIDENT_CODES, failure.code);

export function attempt2Decision({ policy, subject, outcome, failure }) {
  const no = reason => ({ eligible: false, reason });
  if (policy?.automaticAttempt2?.enabled !== true) return no('ATTEMPT2_DISABLED');
  if (subject?.attempt !== 1) return no('ATTEMPT2_ONLY_AFTER_ATTEMPT1');
  if (outcome !== 'FAILED_CLEAN') return no('ATTEMPT2_REQUIRES_CLEAN_FAILURE');
  if (!isTransient(failure?.code) && !residentCode(failure)) return no('ATTEMPT2_REQUIRES_TRANSIENT_CODE');
  if (residentCode(failure) && !ATTEMPT2_RESIDENT_CODES[failure.code].includes(failure.stageNumber)) return no('ATTEMPT2_ROLE_MAY_BE_PUBLISHED');
  if (!ATTEMPT2_STAGES.includes(failure?.stageNumber)) return no('ATTEMPT2_ROLE_MAY_BE_PUBLISHED');
  if (failure.stageNumber === 0 && failure.phase !== 'workspace') return no('ATTEMPT2_ROLE_MAY_BE_PUBLISHED');
  // Stage R (PR-A): a role relayed in attempt 1 is published; nothing after it is ever retried. Stage R itself
  // (number 9) is never in ATTEMPT2_STAGES.
  if (failure.relayedRoles !== undefined && failure.relayedRoles !== 0) return no('ATTEMPT2_ROLE_MAY_BE_PUBLISHED');
  return { eligible: true, reason: null };
}

export const attempt2Subject = subject => ({ ...subject, attempt: 2 });
