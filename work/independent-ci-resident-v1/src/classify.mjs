// Failure classification. The executor only continues after a failure it can prove is clean;
// anything it does not recognise, or anything without a complete cleanup proof, is UNKNOWN and
// latches HALT. The tables are allow-lists: a new or misspelled code falls through to UNKNOWN.
//
// Source v2 (DESIGN S11): the stage codes below MIRROR the stable failure catalogue of the installed
// Source (actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs); a test keeps the
// two identical. The resident never imports the Source at run time (it is a separate pinned layer).
import { readFileSync } from 'node:fs';
import { CODE, check } from './canonical.mjs';

// Stage 1 only: Native said no. Nothing was published, nothing executed.
// NODE_ROLE_NOT_HELD (primary/standby C3, DESIGN §29): the last one, the answer "this node holds no ci-admission role".
export const NOT_ADMITTED_CODES = Object.freeze(['NATIVE_NOT_ADMITTED', 'OWNER_REVIEW_REQUIRED', 'PROTECTED_CHANGE_NOT_UP_TO_DATE', 'PATHS_OUTSIDE_WRITE_SET',
  'CLAIM_NOT_CURRENT', 'TASK_CI_HEAD_CAP_REACHED', 'CLAIM_HEAD_CAP_REACHED', 'CI_BUDGET_EXHAUSTED', 'WORKFLOW_CHANGE_NOT_AUTHORIZED', 'PR_NOT_OPEN_OR_CHANGED',
  'NODE_ROLE_NOT_HELD']);
// Clean transient: an outside, passing condition. The only codes the one automatic attempt 2 may follow
// (attempts.mjs; Owner decision 1b5d3687).
// NATIVE_ADMISSION_UNAVAILABLE also covers explicit protected-observation exhaustion, but only after the Source
// proved BLOCKED/zero effects/no possible publication. It does not widen attempts.mjs's stage 0/1/2 boundary.
// ADMISSION_VERIFICATION_UNAVAILABLE (generation 10, DESIGN 53.6): stage 1 withdrew its own admission check because it could not be
// verified (GitHub or Native unreadable after the bounded re-reads); attempt 2 re-proves it under new job ids instead of a burned head.
// HEAD_INTERRUPTED_ON_GITHUB (DESIGN §78, field defect PR #1110): stage 1 found only this attempt's own admission check on the head, from
// a run interrupted by a failover before any role or control check: nothing of the head ran, so attempt 2 runs it, no new commit.
// ADMISSION_AUTHORIZATION_CHANGED (DESIGN §79, field PR #1123): stage 1 withdrew its own admission check because the authorization read
// after the write differed from the one before it; nothing of the head ran, so attempt 2 admits it again from a fresh read, no new commit.
export const TRANSIENT_CODES = Object.freeze(['NATIVE_ADMISSION_UNAVAILABLE', 'GITHUB_TRANSIENT_UNAVAILABLE', 'BRIDGE_TRANSPORT_TIMEOUT',
  'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 'ARCHIVE_PRECONDITION_NOT_MET', 'ADMISSION_VERIFICATION_UNAVAILABLE', 'HEAD_INTERRUPTED_ON_GITHUB', 'ADMISSION_AUTHORIZATION_CHANGED']);
// Why the roles of a train front batch (a subject with testSha) stay local: a relay reason, not a failure (§41.4, §38.8 m1);
// listed with the codes so every table knows it.
export const RELAY_TRAIN_FRONT_LOCAL = 'RELAY_TRAIN_FRONT_LOCAL';
// The merge train's clean codes (INTERFACES §5, in that order; Source v2 stage-fact.mjs#TRAIN_CODES lists the same).
export const TRAIN_CLEAN_CODES = Object.freeze(['TRAIN_FRONT_JOB_WITHOUT_TRAIN', 'TRAIN_SINGLE_GREEN_NOT_PROVEN', 'TRAIN_TEST_COMMIT_GONE', 'TRAIN_REVOKE_UNCONFIRMED',
  'TRAIN_SWEEP_INCOMPLETE', 'TRAIN_TAKEOVER_SWEEP_PENDING', 'TRAIN_SOURCE_MISMATCH', 'TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_FRONT_BUDGET_SHORT', 'TRAIN_FRONT_ATTEMPTS_USED',
  RELAY_TRAIN_FRONT_LOCAL,
  // Stages 1 and 8: a train front job whose stage directory's train-mode.json exists but is unusable: never burned (stage 1
  // releases the head, stage 8 parks it).
  'TRAIN_MODE_UNREADABLE',
  // Stage 8 in push mode (ADR 0018; Source v2 train-landing.mjs).
  'TRAIN_LANDING_CHECKS_PENDING', 'TRAIN_LANDING_RULES_MISSING', 'TRAIN_LANDING_REFUSED', 'TRAIN_LANDING_CHECK_FAILED', 'TRAIN_BATCH_CHANGED', 'TRAIN_BATCH_WITHOUT_PUSH']);
// Clean, but final for this head and attempt.
export const CLEAN_FINAL_CODES = Object.freeze(['STAGE_PACKAGE_REFUSED', 'STAGE_INPUT_RESULT_MISSING', 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED', 'BROKER_REQUEST_EXPIRED',
  'BROKER_REQUEST_REFUSED', 'STAGE_CHILD_REFUSED', 'STAGE_CHILD_TIMEOUT', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 'BATCH_CLAIM_CHANGED',
  'NATIVE_POLICY_UNSUPPORTED', 'PUBLICATION_BLOCKED', 'PUBLICATION_REVOKED', 'EVIDENCE_REFUSED', 'WORKSPACE_PREPARATION_REFUSED',
  'RELAY_STAGE_REFUSED',
  // Stage 8 not ready: bounded retries, then sleeping until a change. A moved base is final for this base.
  'RESIDENT_MERGE_QUEUE_NOT_JOINED', 'RESIDENT_BASE_MOVED', 'REQUIRED_CHECK_FAILED', 'REQUIRED_CHECKS_UNREADABLE',
  // Phase 2, step 3a: main's live branch rules, GitHub's test merge, the green ledger (parked and tried again), and a
  // test merge of exactly [T, H] that is not the tested tree (final for the head).
  'RULESET_UNREADABLE', 'STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_NOT_READY', 'GREEN_LEDGER_UNAVAILABLE',
  'TRAIN_TEST_MERGE_TREE_DIFFERS',
  // Task bd07449b: main's rules were not read (parked, read again within minutes); RULESET_UNREADABLE is rules read and not this App's six.
  'RULESET_READ_FAILED',
  // App 5368905 already published on this head, found on GitHub (primary/standby design v0.4 §6.2, C4): at stage 1
  // before Native was asked, or before a role's first publication that this node knew nothing of. A new commit is needed.
  'HEAD_PUBLISHED_ON_GITHUB', 'ROLE_ALREADY_ON_GITHUB',
  // Merge train on (DESIGN §41.2-41.4, step 3c-2b): zero side effects, a clean ending. Stages 1 and 8 refuse a front job while
  // the train is not on; stage 8 finds the single green not proven or S gone; the rest are stage 10's decisions.
  ...TRAIN_CLEAN_CODES]);
// Never clean (listed for the cross-check and the reader; anything not allow-listed is UNKNOWN anyway).
export const UNKNOWN_CODES = Object.freeze(['BROKER_RESPONSE_UNCONFIRMED', 'STAGE_HELPER_NOT_STOPPED_IN_TIME', 'STAGE_ORIGINAL_NOT_RESTORED',
  'BROKER_CONFIGURATION_CONFLICT', 'NATIVE_RECEIPT_UNCONFIRMED', 'STAGE_CHILD_TREE_UNCONFIRMED', 'STAGE_OUTCOME_MISSING', 'PUBLICATION_UNCERTAIN',
  'RECONCILIATION_REQUIRED', 'EVIDENCE_IDENTITY_CONFLICT', 'ADMISSION_CONFIGURATION_REFUSED', 'BROKER_UNCONFIRMED', 'BROKER_BUSY',
  // Stage R (S21): a relay publication that may exist unsettled, a role held on the head by the other path, a
  // relay plan that does not validate. The role is never run locally afterwards; the head burns and HALTs.
  'RELAY_PUBLICATION_UNCERTAIN', 'ROLE_ALREADY_PUBLISHED_ON_HEAD', 'RELAY_PLAN_UNCONFIRMED']);

// Resident-side codes that end a stage cleanly before or around the Source stage (companion pump, the v1
// one-shot states kept for an unchanged reading of older receipts).
// REFS_GATE_UNCONFIRMED: the refs gate before the first local scanner got no explicit answer; nothing ran; clean
// but final (never the transient REMOTE_REFS_CHANGED_SINCE_BUNDLE, PR-A review MINOR 5).
// LINUX_MEMORY_NOT_READY (DESIGN §32, Task 25851665): the pre-stage memory gate refused a scanner stage before it was invoked
// (the VM showed too few free hv_sock-sized blocks for the whole bounded wait); nothing of the stage ran.
export const LINUX_MEMORY_NOT_READY = 'LINUX_MEMORY_NOT_READY';
const RESIDENT_CLEAN = Object.freeze(['ACTUAL_ISSUE_NOT_PUBLISHED', 'ISSUE_TRANSFER_UNCONFIRMED',
  'FORMAL_BRIDGE_STAGE_DEADLINE', 'REFS_GATE_UNCONFIRMED', LINUX_MEMORY_NOT_READY]);

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
// How such a stage may end once it was asked to stop for an abort: any ending that is clean anyway, a stage that was
// not invoked because the abort came first, the bridge pump cancelled after the stop was sent, or the stopped entry's
// missing outcome (STAGE_OUTCOME_MISSING: UNKNOWN in every other path). The last one only when the broker's own
// receipt says STOP_SENT: the stop control reached the running helper, whose only answer to it is STOP_REQUESTED
// (independent review, M2). A scanner-issuer publishes no check, and both hosts must still prove quiescence.
// Always together with the Windows half of the cleanup proof (helper tree drained, original binary restored).
// DESIGN §26: the bridge stop's own code joins them under the same STOP_SENT rule. The engine keeps a stage's own code once an
// abort asked it to stop, but an abort accepted in the instant a bridge stop ended the stage must not turn into a HALT: the
// stage ended through the same reviewed stop path, and both hosts must still prove quiescence.
export const OWNER_ABORT_STAGE_ENDINGS = Object.freeze([...TRANSIENT_CODES, ...CLEAN_FINAL_CODES, ...RESIDENT_CLEAN,
  'STAGE_OUTCOME_MISSING', 'OWNER_ABORT_REQUESTED', 'COMPANION_PUMP_CANCELLED', 'BRIDGE_STAGE_STOPPED_PUMP_LOST']);
const ABORT_ENDINGS = new Set(OWNER_ABORT_STAGE_ENDINGS);
export function abortStageEndingClean(result, { stopSent = false } = {}) {
  if (!result || result.ok === true) return !!result;
  if (['STAGE_OUTCOME_MISSING', 'BRIDGE_STAGE_STOPPED_PUMP_LOST'].includes(result.code) && stopSent !== true) return false;
  return typeof result.code === 'string' && ABORT_ENDINGS.has(result.code)
    && result.proof?.windowsTreeZero === true && result.proof?.serviceOriginalStopped === true;
}

// ---- the scanner abandonment (DESIGN §27; design r3 part three, Task d2974298) ----
// Resident-side lists, never mirrored from the Source: a stage-2/4/6 ending that would HALT is closed FAILED_CLEAN
// BRIDGE_ABANDONED_UNPUBLISHED when the Owner abort's quiescence proof holds. That stage's only Windows process is the scanner
// issuer, which has no way to write a check; the Linux worker holds no GitHub credential; a signed result becomes a check only
// through stage 3, 5 or 7 of the same batch, which the executor never runs after fail(). So "nothing was published" rests on
// those structural facts and on Windows facts the companion cannot forge (the broker's STOP_SENT, the helper's drained tree,
// the service's own SCM readback); the Linux half of the proof only decides whether the next batch may start.
export const BRIDGE_ABANDONED_UNPUBLISHED = 'BRIDGE_ABANDONED_UNPUBLISHED';
export const SCANNER_ABANDON_STAGES = Object.freeze([2, 4, 6]);
// The endings it may close: the issuer's own UNCERTAIN; a stopped stage's missing outcome or the bridge stop's own code (both
// only with the broker's STOP_SENT, the abort's M2 rule); and the pump codes of a stage that succeeded while its pump was not
// confirmed (engine-windows.mjs#invoke).
export const SCANNER_ABANDON_ENDINGS = Object.freeze(['PUBLICATION_UNCERTAIN', 'STAGE_OUTCOME_MISSING', 'BRIDGE_STAGE_STOPPED_PUMP_LOST',
  'RELAY_REFUSED_NO_RETRY', 'RELAY_PARTIAL_RECORD_PRESERVED', 'COMPANION_PUMP_UNCONFIRMED', 'FORMAL_WORKER_TERMINAL_UNCONFIRMED', 'LINUX_WORKER_ENDED_WITHOUT_RECORD']);
const ABANDON_NEEDS_STOP_SENT = Object.freeze(['STAGE_OUTCOME_MISSING', 'BRIDGE_STAGE_STOPPED_PUMP_LOST']);
// Pump codes after which no Linux quiescence proof can be had (the companion did not handle the request, or is gone): checked
// first, whatever the stage code; these stages HALT at once.
export const PUMP_CODES_UNPROVABLE = Object.freeze(['COMPANION_HEARTBEAT_LOST', 'COMPANION_REQUEST_EXPIRED', 'COMPANION_HANDLER_UNCONFIRMED']);
// The pure part of the eligibility (DESIGN §27.2, design §3.3 items 1-5): stage, pump code first, ending, the Windows half of
// the stage's own proof, and a quiet pump. The executor adds the rest (no HALT, no drift, not the Owner abort's path).
// bridge: the engine's bridge facts { pumpCode, stopRequestId, stopCode, stageCode, pumpQuiet } (engine-windows.mjs#invoke).
export function scannerAbandonEligible({ stage, phase = 'stage', code, bridge = null, proof = null } = {}) {
  const no = reason => ({ eligible: false, reason });
  if (!SCANNER_ABANDON_STAGES.includes(stage) || phase !== 'stage') return no('ABANDON_STAGE_NOT_SCANNER_ISSUER');
  if (!bridge || typeof bridge !== 'object') return no('ABANDON_BRIDGE_FACTS_MISSING');
  if (bridge.pumpCode !== null && (typeof bridge.pumpCode !== 'string' || PUMP_CODES_UNPROVABLE.includes(bridge.pumpCode))) return no('ABANDON_PUMP_UNPROVABLE');
  if (!SCANNER_ABANDON_ENDINGS.includes(code)) return no('ABANDON_ENDING_NOT_LISTED');
  if (ABANDON_NEEDS_STOP_SENT.includes(code) && bridge.stopCode !== 'STOP_SENT') return no('ABANDON_STOP_NOT_SENT');
  if (proof?.windowsTreeZero !== true || proof?.serviceOriginalStopped !== true) return no('ABANDON_WINDOWS_PROOF_INCOMPLETE');
  if (bridge.pumpQuiet !== true) return no('ABANDON_PUMP_NOT_QUIET');
  return { eligible: true, reason: null };
}
// Owner decision eaa7d5e4 (design r3 §3.6 option O-2): the one automatic attempt 2 also follows these resident codes, at these
// stages only (attempts.mjs). Here, not in attempts.mjs, because the failure table's own check below needs it while this module
// loads (attempts.mjs imports this module).
// DESIGN §32: a stage-2 refusal of the memory gate (nothing of stage 2 ran, nothing was published) takes the same one attempt 2.
// DESIGN §71: a batch an earlier boot left open, proven to have published nothing and quiet on both hosts, is closed with this code
// at stage 1 (it had not started) or 2 (it had, and no publication stage had begun) and takes the same one attempt 2.
export const EXECUTOR_RESTARTED_UNPUBLISHED = 'EXECUTOR_RESTARTED_UNPUBLISHED';
export const ATTEMPT2_RESIDENT_CODES = Object.freeze({ [BRIDGE_ABANDONED_UNPUBLISHED]: Object.freeze([2]), [LINUX_MEMORY_NOT_READY]: Object.freeze([2]),
  [EXECUTOR_RESTARTED_UNPUBLISHED]: Object.freeze([1, 2]), REFS_GATE_UNCONFIRMED: Object.freeze([2]), UPGRADE_VERSION_SKEW: Object.freeze([2]) });
const residentAttempt2 = (code, stages) => Object.hasOwn(ATTEMPT2_RESIDENT_CODES, code) && Array.isArray(stages) && stages.every(s => ATTEMPT2_RESIDENT_CODES[code].includes(s));

// The archive reason segment is derived from the stable code, never taken from untrusted text.
export function archiveReason(code) {
  check(typeof code === 'string' && CODE.test(code), 'ARCHIVE_REASON_CODE_INVALID');
  return code.toLowerCase().replace(/_/g, '-').slice(0, 40).replace(/-+$/, '');
}

// ---- the machine-readable failure table (resident quota redesign v0.6 + §9, phase 1; failure-table.json) ----
// (stage, phase, code, outcome reason, diagnostic reason codes) -> (class, release or burn, retry rule, breaker).
// Loaded once from the installed resident layer (its bytes are pinned by the resident manifest like every other
// file) and validated here; a table that does not validate stops the module from loading (fail closed).
export const FAILURE_TABLE_CONTRACT = 'clued.independent-ci.resident-failure-table/1';
// 'node-role' (primary/standby C3, DESIGN §29): this node holds no ci-admission role. It says nothing about the PR: the release
// is counted neither as an evaluation nor towards the head's release cap (ledger.mjs#usage), and the executor goes to STANDBY.
export const FAILURE_CLASSES_V1 = Object.freeze(['not-admitted', 'node-role', 'waiting', 'deterministic-pr', 'unmapped-stage-1', 'transient', 'environment', 'clean-final', 'queue', 'abort', 'unknown']);
export const DISPOSITIONS = Object.freeze(['release', 'release-if-safe', 'park', 'safe-point-release', 'burn', 'halt']);
export const RETRY_RULES = Object.freeze(['new-trigger', 'attempt2', 'same-batch', 'continuation', 'park', 'new-commit', 'owner-rearm']);
const ROW_KEYS = ['code', 'stages', 'phase', 'reasons', 'reasonCodesAny', 'reasonCodesWithin', 'class', 'disposition', 'retry', 'breaker', 'note'];
const LOWER = /^[a-z][a-z0-9_]{0,63}$/, REASON = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
// Stage 1 of these two transient codes is released (not burned into attempt 2) when the entry proves it wrote nothing: DESIGN 49.
export const STAGE1_TRANSIENT_RELEASE_CODES = Object.freeze(['GITHUB_TRANSIENT_UNAVAILABLE', 'NATIVE_ADMISSION_UNAVAILABLE']);
const stage1TransientRelease = r => STAGE1_TRANSIENT_RELEASE_CODES.includes(r.code) && Array.isArray(r.stages) && r.stages.length === 1 && r.stages[0] === 1
  && r.disposition === 'release-if-safe' && r.retry === 'new-trigger';
export function validateFailureTable(t) {
  check(t && t.contract === FAILURE_TABLE_CONTRACT && Array.isArray(t.rows) && t.rows.length > 0, 'FAILURE_TABLE_INVALID');
  for (const r of t.rows) {
    check(r && typeof r === 'object' && Object.keys(r).every(k => ROW_KEYS.includes(k)) && CODE.test(r.code ?? '')
      && (r.stages === 'any' || (Array.isArray(r.stages) && r.stages.length > 0 && r.stages.every(s => Number.isSafeInteger(s) && s >= 0 && s <= 9)))
      && (r.phase === undefined || ['stage', 'bundle', 'workspace'].includes(r.phase))
      && (r.reasons === undefined || (Array.isArray(r.reasons) && r.reasons.length > 0 && r.reasons.every(x => REASON.test(x))))
      && ['reasonCodesAny', 'reasonCodesWithin'].every(k => r[k] === undefined || (Array.isArray(r[k]) && r[k].length > 0 && r[k].every(x => LOWER.test(x))))
      && [r.reasons, r.reasonCodesAny, r.reasonCodesWithin].filter(x => x !== undefined).length <= 1
      && FAILURE_CLASSES_V1.includes(r.class) && DISPOSITIONS.includes(r.disposition) && RETRY_RULES.includes(r.retry) && ['counts', 'neutral'].includes(r.breaker)
      && typeof r.note === 'string' && r.note.length > 0 && r.note.length <= 300
      // a halt is UNKNOWN and an unknown class halts; nothing else may halt or be unknown
      && ((r.disposition === 'halt') === (r.class === 'unknown')) && ((r.disposition === 'halt') === (r.retry === 'owner-rearm'))
      // releases exist only before 10-started: stage 1 (or the bundle, stage 0)
      && (!r.disposition.startsWith('release') || (Array.isArray(r.stages) && r.stages.every(s => s <= 1)))
      // the one automatic attempt 2 only follows a transient code, and every transient code may select it; besides, a resident
      // code of ATTEMPT2_RESIDENT_CODES may, on a row of exactly its listed stages (Owner decision eaa7d5e4)
      // (one exception: the stage-1 release of GITHUB_TRANSIENT_UNAVAILABLE and NATIVE_ADMISSION_UNAVAILABLE, which write nothing: STAGE1_TRANSIENT_RELEASE)
      && (TRANSIENT.has(r.code) ? (r.retry === 'attempt2' || stage1TransientRelease(r)) : (r.retry !== 'attempt2' || residentAttempt2(r.code, r.stages))), 'FAILURE_TABLE_INVALID', r?.code);
  }
  return t;
}
export const FAILURE_TABLE = Object.freeze(validateFailureTable(JSON.parse(readFileSync(new URL('./failure-table.json', import.meta.url), 'utf8'))));

const diagnosticCodes = d => [...new Set([...(Array.isArray(d?.reasonCodes) ? d.reasonCodes : []), ...(Array.isArray(d?.nativeReasonCodes) ? d.nativeReasonCodes : [])])];
// The one row a failure is decided by, or null (no row: unknown, HALT). See the table's "match" text.
export function failureRow({ code, stage, phase = 'stage', reason = null, diagnostic = null }) {
  const codes = diagnosticCodes(diagnostic);
  let best = null, bestScore = -1;
  for (const r of FAILURE_TABLE.rows) {
    if (r.code !== code || (r.stages !== 'any' && !r.stages.includes(stage)) || (r.phase !== undefined && r.phase !== phase)) continue;
    let score;
    if (r.reasons) { if (!r.reasons.includes(reason)) continue; score = 6; }
    else if (r.reasonCodesAny) { if (!codes.some(c => r.reasonCodesAny.includes(c))) continue; score = 4; }
    else if (r.reasonCodesWithin) { if (codes.length === 0 || !codes.every(c => r.reasonCodesWithin.includes(c))) continue; score = 2; }
    else score = 0;
    if (r.stages !== 'any') score += 1;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// The release reasons a reservation can be closed with (ledger.mjs#UNEXECUTED_REASONS), and which guards apply to the
// same head afterwards (v0.6 §7 minor 6; phase 2, design v0.5 §4.4, §4.5):
//   cooldown: the 10-minute cool-down of the batch key (policy.limits.unexecutedCooldownMs) before it is reserved again;
//   cap: the budget that bounds its retries now that the run queue retries on its own (queue.mjs). Phase 1's daily cap
//     per key (unexecutedMaxPer24h) is gone with policy /4: a wait (failure-table class waiting) is bounded by the
//     waits' own budget (waitingRetriesPer24h a day, every PR together); admission refusals spend evaluations only,
//     not either release cap. Other releases are bounded by the head's release cap
//     (releasesPerHeadPer24h counted releases in 24 hours, then STOPPED; an environment release while the breaker is
//     not closed is not counted), a supersession by nothing (nothing about the PR was decided). Generation 10 (DESIGN 53.3), only
//     under a policy with breaker.network (/9): a release that networkFailure below says was the network counts towards its own cap
//     instead (breaker.network.releasesPerHeadPer24h, every 10 minutes: queue.mjs#NETWORK_BACKOFF_MS), never towards this one.
export const UNEXECUTED_REASON_RULES = Object.freeze({
  NOT_ADMITTED: Object.freeze({ cooldown: true, cap: Object.freeze({ waiting: 'waitingRetriesPer24h', other: null }), evidence: 'stage-1 outcome safeToRerun' }),
  BUNDLE_UNAVAILABLE: Object.freeze({ cooldown: true, cap: Object.freeze({ waiting: null, other: 'releasesPerHeadPer24h' }), evidence: 'bundle failed before stage 1' }),
  BROKER_NOT_LAUNCHED: Object.freeze({ cooldown: true, cap: Object.freeze({ waiting: null, other: 'releasesPerHeadPer24h' }), evidence: 'broker refused before any launch, original restored' }),
  SUPERSEDED: Object.freeze({ cooldown: false, cap: Object.freeze({ waiting: null, other: null }), evidence: 'a newer commit of the PR arrived before stage 1' }),
  // Defect a8910e41: the take-over binding run's own end after stage 1 (DESIGN §62.4); nothing against the PR, so no release cap.
  TRAIN_FRONT_BOUND: Object.freeze({ cooldown: true, cap: Object.freeze({ waiting: null, other: null }), evidence: 'the take-over binding run ended on purpose after its stage 1' }),
});

// Generation 10 (DESIGN 53.3, 53.4): whether an ending was the line to GitHub or Native and nothing else, from the most specific fact
// there is (never from the class alone: BUNDLE_UNAVAILABLE, BROKER_* and NATIVE_ADMISSION_UNAVAILABLE also stand for faults that would
// repeat). Used for the network release cap and the network cause of the breaker.
//   - BUNDLE_UNAVAILABLE: the companion said a GitHub step of build-bundle.ps1 failed in git (companion.mjs#bundleNetworkRefusal);
//   - PARKED_BUNDLE_TOO_OLD: the same of the second bundle (-Rebundle), after the executor's own waits (generation 13);
//   - GITHUB_TRANSIENT_UNAVAILABLE: GitHub answered 500/502/503/504 or did not answer (not 429: a rate limit is no outage);
//   - NATIVE_ADMISSION_UNAVAILABLE: the explicit Native read exhaustion; an observation incomplete or too old on a slow line (the mode
//     or the observer could not be read in time, the observation expired before it was used: the same reasons the Source reads again
//     after the write, withdrawal-text.mjs ADMISSION_REREAD_REASONS, so the two sides of the write agree); or a full_admission_unavailable
//     whose diagnostic says it caught a transport fault (Source full-admission-v2.mjs#transportFault); a credential refused or an
//     evaluator fault inside it is not;
//   - ADMISSION_VERIFICATION_UNAVAILABLE: the Source maps only a passing cause to it (withdrawal-text.mjs#admissionVerificationRetryable).
// Generation 13 (DESIGN §57.2): two of the publisher's passing pre-write reasons are the line too: the facts observed once more after the
// admission got no answer (the same Native read exhaustion, renamed), and the admission answer aged before the write (only the few
// fixed-size reads after the admission were slow). publication_window_short_before_write is not: it says the boundary before the write
// was long, which a slow complete admission alone can make, again and again (review round 4, MINOR 1).
export const NETWORK_NATIVE_REASONS = Object.freeze(['native_claim_observation_unavailable', 'full_admission_mode_unknown', 'full_admission_observer_unknown', 'full_admission_observation_expired',
  'protected_facts_reobservation_unavailable', 'native_admission_aged_before_write']);
export const NETWORK_GITHUB_REASONS = Object.freeze(['github_http_500', 'github_http_502', 'github_http_503', 'github_http_504', 'github_transport_unconfirmed']);
export function networkFailure({ code, outcome = null, bundleNetwork = false, refsNoAnswer = false }) {
  switch (code) {
    // Generation 11 (DESIGN 55): the refs gate got no answer from the line, also after its two waits (engine-windows.mjs#runStage).
    case 'REFS_GATE_UNCONFIRMED': return refsNoAnswer === true;
    case 'BUNDLE_UNAVAILABLE': return bundleNetwork === true;
    // Generation 13 (DESIGN §57.3): the second bundle of a batch resumed from parking point A, still refused by the line after its waits.
    case 'PARKED_BUNDLE_TOO_OLD': return bundleNetwork === true;
    case 'GITHUB_TRANSIENT_UNAVAILABLE': return NETWORK_GITHUB_REASONS.includes(outcome?.reason);
    case 'NATIVE_ADMISSION_UNAVAILABLE': return NETWORK_NATIVE_REASONS.includes(outcome?.reason) || (outcome?.reason === 'full_admission_unavailable' && outcome?.diagnostic?.transport === true);
    case 'ADMISSION_VERIFICATION_UNAVAILABLE': return true;
    default: return false;
  }
}

// Generation 11 (DESIGN 54): the execution stages 4 and 6 (and 2, abandoned only: DESIGN 59) run again IN THE SAME BATCH after an ending that says nothing about the PR and
// is proven to have published nothing; stage 3 already published, so an attempt 2 is impossible (DESIGN 53.12), and a new commit is
// what this replaces. The stage's own publication (5 or 7) has not run: it runs once, after the run that succeeds, on that run's signed
// result. Two kinds of ending qualify:
//   - abandoned: the scanner-abandonment proof of DESIGN 27 holds (scannerAbandonEligible: an allow-listed ending, the pump code
//     provable, STOP_SENT where needed, the Windows half of the proof, a quiet pump), e.g. LINUX_WORKER_ENDED_WITHOUT_RECORD;
//   - clean: a BLOCKED outcome with zero side effects that may not have published, the Windows half of the proof, and a reason that is
//     the environment (EXECUTION_RETRY_BLOCKED_REASONS: the Linux side refused its preparation, a callback deadline, the remote refs
//     or GitHub / Native unreadable; full_admission_unavailable only with its transport flag), or the memory gate's refusal before the
//     stage was invoked. A refusal about the PR (it changed or closed, refs moved, not admitted) is never retried.
// The executor adds: no HALT, no drift, a two-host quiescence proof and a verified retry-stage-N archive before each run again.
// Generation 14 (DESIGN 59, defect e0a5630d): stage 2 (gitleaks) runs again too, on the abandoned basis ONLY: a relay that a busy host
// (a slow or hung wsl.exe) made the pump refuse, proven by the same DESIGN 27 facts to have published nothing (stage 3 has not run).
// Its other endings keep their own path (the memory gate and the clean refusals: the one attempt 2 of DESIGN 32 / O-2, or as before).
export const EXECUTION_RETRY_STAGES = Object.freeze([2, 4, 6]);
// A run again of stage 2 that the first Linux stage's own gates refused before anything of it ran (the refs gate without an answer, the
// version skew: both burn the head) ends the batch on the abandoned run it follows, as before this generation (BRIDGE_ABANDONED_UNPUBLISHED
// and the one attempt 2): a run again never ends a batch worse than not running again (independent review of the drill fix, MINOR 1).
export const STAGE2_RETRY_KEEPS_ABANDONED = Object.freeze(['REFS_GATE_UNCONFIRMED', 'UPGRADE_VERSION_SKEW']);
export const EXECUTION_RETRY_BLOCKED_REASONS = Object.freeze(['LINUX_PREPARATION_REFUSED', 'BRIDGE_CALLBACK_DEADLINE', 'REMOTE_REFS_UNAVAILABLE',
  ...NETWORK_GITHUB_REASONS, ...NETWORK_NATIVE_REASONS]);
export function noLaunchRetryable(stage, result) {
  return result.brokerNoLaunch === true && result.proof?.windowsTreeZero === true
    && result.proof?.serviceOriginalStopped === true
    && failureRow({ stage, code: result.code })?.retry === 'same-batch';
}

export function executionRetryable({ stage, code, outcome = null, bridge = null, proof = null, retry = 0 } = {}) {
  const no = reason => ({ retry: false, basis: null, reason });
  if (!EXECUTION_RETRY_STAGES.includes(stage)) return no('EXECUTION_RETRY_STAGE_NOT_LISTED');
  if (proof?.windowsTreeZero !== true || proof?.serviceOriginalStopped !== true) return no('EXECUTION_RETRY_WINDOWS_PROOF_INCOMPLETE');
  if (code === 'STAGE_CHILD_TIMEOUT') return retry === 0 && bridge?.pumpQuiet !== false
    ? { retry: true, basis: 'child-timeout', reason: null } : no('EXECUTION_RETRY_TIMEOUT_LIMIT');
  if (['ACTUAL_ISSUE_NOT_PUBLISHED', 'ISSUE_TRANSFER_UNCONFIRMED', 'FORMAL_BRIDGE_STAGE_DEADLINE'].includes(code)
      && bridge?.pumpQuiet === true && !PUMP_CODES_UNPROVABLE.includes(bridge.pumpCode))
    return { retry: true, basis: 'bridge-transfer-refused', reason: null };
  const abandoned = scannerAbandonEligible({ stage, code, bridge, proof }).eligible;
  if (stage === 2 && !abandoned) return no('EXECUTION_RETRY_STAGE2_NOT_ABANDONED');
  if (code === LINUX_MEMORY_NOT_READY) return { retry: true, basis: 'memory-gate', reason: null };
  if (abandoned) return { retry: true, basis: 'abandoned-unpublished', reason: null };
  const o = outcome;
  if (o?.status !== 'BLOCKED' || o.sideEffects !== 0 || o.mayHavePublished !== false) return no('EXECUTION_RETRY_NOT_A_CLEAN_REFUSAL');
  const transport = o.reason === 'full_admission_unavailable' && o.diagnostic?.transport === true;
  if (!EXECUTION_RETRY_BLOCKED_REASONS.includes(o.reason) && !transport) return no('EXECUTION_RETRY_REASON_NOT_ENVIRONMENT');
  return { retry: true, basis: 'clean-refusal', reason: null };
}

// The failure decision of the executor (phase 1). release: the unexecuted reason to close the reservation with, or
// null. A release needs the table's release-if-safe row, an entry that did not reach 10-started, the Windows half of
// the cleanup proof, and EITHER the bound stage outcome's own safeToRerun flag (v0.6 §9 phase 1, items 1 and 2; never
// inferred from a code) OR the broker's "no launch, original restored" refusal. Everything else is burned: CLEAN with a
// complete two-host proof, else UNKNOWN; a halt row or no row at all is UNKNOWN. A diagnostic that carries a
// deterministic PR code (DETERMINISTIC_REASON_CODES) never releases, whichever code it was reduced to (independent
// review of phase 1, MINOR 1): the Source's flag already says so, and the resident does not rely on that alone.
export const DETERMINISTIC_REASON_CODES = Object.freeze([...new Set(FAILURE_TABLE.rows.filter(r => r.class === 'deterministic-pr' && r.reasonCodesAny).flatMap(r => r.reasonCodesAny))]);
export function decideFailure({ code, stage, phase = 'stage', outcome = null, brokerNoLaunch = false, proof, started }) {
  let row = typeof code === 'string' && CODE.test(code) ? failureRow({ code, stage, phase, reason: outcome?.reason ?? null, diagnostic: outcome?.diagnostic ?? null }) : null;
  if (!row || row.disposition === 'halt') return { klass: 'UNKNOWN', basis: row ? 'failure-table-halt' : 'not-an-allow-listed-clean-failure', row, release: null };
  const windows = proof?.windowsTreeZero === true && proof?.serviceOriginalStopped === true;
  const zeroEffect = outcome?.status === 'BLOCKED' && outcome.sideEffects === 0 && outcome.mayHavePublished === false;
  if (!zeroEffect && (row.disposition === 'park' && stage === 8 || code === 'STAGE_CHILD_TIMEOUT' && [1, 3, 5, 7, 8].includes(stage)))
    return { klass: 'UNKNOWN', basis: 'publication-not-proven-absent', row, release: null };
  const deterministic = diagnosticCodes(outcome?.diagnostic).some(c => DETERMINISTIC_REASON_CODES.includes(c));
  // What the deterministic code makes of a release-if-safe row is what the ledger and the status record. Except a node that
  // holds no role (DESIGN §29): it decided nothing about the PR, so no reason beside it can burn the head.
  if (deterministic && row.disposition === 'release-if-safe' && row.class !== 'node-role') row = Object.freeze({ ...row, class: 'deterministic-pr', disposition: 'burn', retry: 'new-commit', breaker: 'neutral' });
  // A stage-1 row of disposition release (today only TRAIN_MODE_UNREADABLE; BUNDLE_UNAVAILABLE is released before this, at the
  // bundle): released on a bound BLOCKED outcome with zero side effects that published nothing, whatever its safeToRerun says.
  if (started !== true && stage === 1 && row.disposition === 'release' && windows && zeroEffect && !deterministic)
    return { klass: 'NOT_ADMITTED', basis: 'stage-1-zero-side-effects', row, release: 'NOT_ADMITTED' };
  if (started !== true && row.disposition === 'release-if-safe' && windows) {
    if (outcome?.safeToRerun === true) return { klass: 'NOT_ADMITTED', basis: 'stage-1-safe-to-rerun', row, release: 'NOT_ADMITTED' };
    if (brokerNoLaunch === true) return { klass: 'NOT_ADMITTED', basis: 'stage-1-broker-not-launched', row, release: 'BROKER_NOT_LAUNCHED' };
  }
  if (!proofComplete(proof)) return { klass: 'UNKNOWN', basis: 'cleanup-proof-incomplete', row, release: null };
  return { klass: 'CLEAN', basis: row.class === 'transient' ? 'transient-cleanup-proof-complete' : 'cleanup-proof-complete', row, release: null };
}
