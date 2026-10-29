// Stable stage facts and failure codes (DESIGN S11). Every way a stage can end maps to ONE stable
// upper-case code; the resident's classify.mjs allow-lists them (a code that is not listed there is
// UNKNOWN and HALTs). Inputs are the broker response (SYSTEM), the generic helper's native receipt
// (clued-control) and the node entry's outcome record (clued-control, bound to the receipt by hash).
// Pure.
import { canonical } from '../proof.mjs';
import { hash } from './prepare-record.mjs';
import { HEX64, OUTCOME_CONTRACT, RELAY_STAGE_NUMBER, TRAIN_STAGE_NUMBER } from './layout.mjs';
import { validateTrainFacts } from '../independent-control-checks-v2/train-facts.mjs';
import { roleProbeFact } from './role-probe-run.mjs';
import { validateRevocationFacts } from './revocation-run.mjs';
import { RELAY_HALT_CODES, relayPlanEnding, validateRelayPlanRows } from '../hosted-relay-v1/relay-plan.mjs';
import { sanitizeAdmissionDiagnosticV2, sanitizeSchedulingV2 } from '../admission-facts-v2.mjs';
import { HEAD_PUBLISHED_ON_GITHUB, ROLE_ALREADY_ON_GITHUB, ROLE_ALREADY_ON_GITHUB_REASON } from '../published-on-github-v2.mjs';

export const STAGE_FACT_CONTRACT = 'clued.independent-ci.resident-stage-fact/2';
export const NATIVE_RECEIPT_CONTRACT_V2 = 'clued.independent-ci.windows-formal-entry-receipt/2';
export const SUCCESS_STATE = 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION';

// ---- catalogue (mirrored, and cross-checked by a test, in independent-ci-resident-v1/src/classify.mjs) ----
// Stage 1 only: Native said no. Nothing was published, nothing executed.
export const NOT_ADMITTED_CODES = Object.freeze(['NATIVE_NOT_ADMITTED', 'OWNER_REVIEW_REQUIRED', 'PROTECTED_CHANGE_NOT_UP_TO_DATE', 'PATHS_OUTSIDE_WRITE_SET',
  'CLAIM_NOT_CURRENT', 'TASK_CI_HEAD_CAP_REACHED', 'CLAIM_HEAD_CAP_REACHED', 'CI_BUDGET_EXHAUSTED', 'WORKFLOW_CHANGE_NOT_AUTHORIZED', 'PR_NOT_OPEN_OR_CHANGED',
  // Primary/standby C3 (resident DESIGN §29): the server says this node holds no ci-admission role (admission_binding_required).
  // Nothing is decided about the PR; the resident goes to STANDBY and releases the reservation.
  'NODE_ROLE_NOT_HELD']);
// Clean transient: an outside, passing condition (network, GitHub 5xx, a push between bundle and
// scan, a precondition not yet met). Eligible for the one automatic attempt 2 when nothing was
// published (Owner decision 1b5d3687; the resident decides eligibility, see attempts.mjs).
export const TRANSIENT_CODES = Object.freeze(['NATIVE_ADMISSION_UNAVAILABLE', 'GITHUB_TRANSIENT_UNAVAILABLE', 'BRIDGE_TRANSPORT_TIMEOUT',
  'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 'ARCHIVE_PRECONDITION_NOT_MET']);
// Clean, but final for this head and attempt (never retried automatically).
export const CLEAN_FINAL_CODES = Object.freeze(['STAGE_PACKAGE_REFUSED', 'STAGE_INPUT_RESULT_MISSING', 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED', 'BROKER_REQUEST_EXPIRED',
  'BROKER_REQUEST_REFUSED', 'STAGE_HELPER_PREFLIGHT_REFUSED', 'STAGE_CHILD_REFUSED', 'STAGE_CHILD_TIMEOUT', 'RESIDENT_QUEUE_HEAD_NOT_REACHED', 'BATCH_CLAIM_CHANGED',
  'NATIVE_POLICY_UNSUPPORTED', 'PUBLICATION_BLOCKED', 'PUBLICATION_REVOKED', 'EVIDENCE_REFUSED', 'WORKSPACE_PREPARATION_REFUSED',
  // Stage R refused before anything was observed or written (relay not configured, input invalid).
  'RELAY_STAGE_REFUSED',
  // Stage 8 not ready (phase 2, step 2; publisher.mjs STAGE8_NOT_READY_REASONS): the resident parks and retries.
  'RESIDENT_MERGE_QUEUE_NOT_JOINED', 'RESIDENT_BASE_MOVED',
  // Phase 2, step 3a (train-rules.mjs, green-ledger.mjs): main's live branch rules, GitHub's test merge, the green ledger;
  // all before any journal write. The last one is final for the head (STAGE8_FINAL_REASONS).
  'RULESET_UNREADABLE', 'STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_NOT_READY', 'GREEN_LEDGER_UNAVAILABLE',
  'TRAIN_TEST_MERGE_TREE_DIFFERS',
  // App 5368905 already published on this head (primary/standby design v0.4 §6.2, C4; published-on-github-v2.mjs):
  // stage 1 found a role or control check before Native was asked, or a role this node knew nothing of was already
  // there before its first publication (stage R: an ON_GITHUB plan row). Nothing was published for that role (an earlier
  // stage of the batch may have published its own); a new commit is needed.
  HEAD_PUBLISHED_ON_GITHUB, ROLE_ALREADY_ON_GITHUB]);
// The stage-8 answers that travel as their own code (publisher.mjs STAGE8_NOT_READY_REASONS and STAGE8_FINAL_REASONS).
const STAGE8_OWN_CODES = new Set(['RESIDENT_QUEUE_HEAD_NOT_REACHED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 'RESIDENT_BASE_MOVED', 'RULESET_UNREADABLE', 'STRICT_OFF_WITHOUT_TRAIN',
  'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_NOT_READY', 'GREEN_LEDGER_UNAVAILABLE', 'TRAIN_TEST_MERGE_TREE_DIFFERS']);
// Never clean: something may still run, or a publication may exist unsettled, or an identity conflicts.
export const UNKNOWN_CODES = Object.freeze(['BROKER_RESPONSE_UNCONFIRMED', 'STAGE_HELPER_NOT_STOPPED_IN_TIME', 'STAGE_ORIGINAL_NOT_RESTORED',
  'BROKER_CONFIGURATION_CONFLICT', 'NATIVE_RECEIPT_UNCONFIRMED', 'STAGE_CHILD_TREE_UNCONFIRMED', 'STAGE_OUTCOME_MISSING', 'PUBLICATION_UNCERTAIN',
  'RECONCILIATION_REQUIRED', 'EVIDENCE_IDENTITY_CONFLICT', 'ADMISSION_CONFIGURATION_REFUSED', 'BROKER_UNCONFIRMED',
  // Another controller tool held the mutation mutex: an unexpected concurrent effect the Owner must see.
  'BROKER_BUSY',
  // Stage R (free-minutes design §7.3, S21): a relay publication that may exist unsettled, a role already
  // held on the head by the other path, or a relay plan that does not validate. Never local afterwards.
  'RELAY_PUBLICATION_UNCERTAIN', 'ROLE_ALREADY_PUBLISHED_ON_HEAD', 'RELAY_PLAN_UNCONFIRMED']);

const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const DIAG = Object.freeze({ owner_review_required: 'OWNER_REVIEW_REQUIRED', owner_review_unavailable: 'NATIVE_ADMISSION_UNAVAILABLE',
  owner_grant_required: 'OWNER_REVIEW_REQUIRED', owner_grant_missing: 'OWNER_REVIEW_REQUIRED', owner_grant_revoked: 'OWNER_REVIEW_REQUIRED', owner_grant_expired: 'OWNER_REVIEW_REQUIRED',
  protected_change_not_up_to_date: 'PROTECTED_CHANGE_NOT_UP_TO_DATE', path_outside_write_set: 'PATHS_OUTSIDE_WRITE_SET', paths_outside_write_set: 'PATHS_OUTSIDE_WRITE_SET',
  claim_trailer_missing: 'CLAIM_NOT_CURRENT', claim_not_found: 'CLAIM_NOT_CURRENT', claim_not_current: 'CLAIM_NOT_CURRENT', fence_superseded: 'CLAIM_NOT_CURRENT',
  claim_bound_to_other_pr: 'CLAIM_NOT_CURRENT', work_claim_execution_epoch_stale: 'CLAIM_NOT_CURRENT', task_ci_head_cap_reached: 'TASK_CI_HEAD_CAP_REACHED',
  claim_head_cap_reached: 'CLAIM_HEAD_CAP_REACHED', ci_budget_exhausted: 'CI_BUDGET_EXHAUSTED', head_budget_exhausted: 'CI_BUDGET_EXHAUSTED',
  workflow_change_not_authorized: 'WORKFLOW_CHANGE_NOT_AUTHORIZED', workflow_runs_unavailable: 'NATIVE_ADMISSION_UNAVAILABLE',
  admission_binding_required: 'NODE_ROLE_NOT_HELD' });
// Explicit transport facts only (PR-A review MINOR 5): the publishers' defaults for an uncoded exception
// (publication_operation_unconfirmed, *_OPERATION_UNCONFIRMED; before PR-A publication_observation_unconfirmed
// and NATIVE_CHECK_UNCONFIRMED) are never transient, so they can never select the automatic attempt 2.
const TRANSPORT_REASONS = new Set(['full_admission_unavailable', 'full_admission_mode_unknown', 'full_admission_observer_unknown', 'full_admission_observation_expired',
  'NATIVE_ADMISSION_UNAVAILABLE', 'github_transient_unavailable', 'GITHUB_TRANSIENT_UNAVAILABLE', 'COMPLETE_CHECK_INVENTORY_REQUIRED', 'REMOTE_REFS_UNAVAILABLE']);
// GitHub answered 5xx or 429, or the request never got an answer (github.mjs: github_http_<status>,
// github_transport_unconfirmed): GITHUB_TRANSIENT_UNAVAILABLE (resident quota redesign v0.6 §2, phase 1). Only on a
// BLOCKED outcome with zero side effects (outcomeFailureCode checks that first), so a write that may have reached
// GitHub is never transient. 403 is ambiguous (permission, secondary rate limit, a refused App) and is NOT mapped.
export const githubTransientReason = r => r === 'github_transport_unconfirmed' || /^github_http_(?:429|5[0-9]{2})$/.test(r ?? '');
const BRIDGE_TIMEOUTS = new Set(['BRIDGE_RESULT_DEADLINE', 'FORMAL_BRIDGE_STAGE_DEADLINE', 'ACTUAL_ISSUE_NOT_PUBLISHED', 'ISSUE_TRANSFER_UNCONFIRMED',
  'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED', 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED', 'BRIDGE_CALLBACK_DEADLINE']);
const CONFIG_REASONS = new Set(['full_admission_not_configured', 'full_admission_subject_invalid', 'full_admission_source_changed', 'full_admission_clock_invalid',
  'full_admission_principal_unknown', 'full_admission_incomplete']);

// Native diagnostic -> the one not-admitted code (first match in a fixed priority order). A head that is not up to
// date with main can never pass whatever else Native says, so that code comes first (independent review of the quota
// redesign phase 1, MINOR 1: with owner_review_required it must not become a waiting code). One thing comes before even that
// (primary/standby C3): admission_binding_required, "this node holds no ci-admission role". A node that is not on duty says
// nothing about the PR, so no other reason may turn that answer into a burned or PR-specific one.
export function notAdmittedCode(diagnostic) {
  const codes = Array.isArray(diagnostic?.reasonCodes) ? [...diagnostic.reasonCodes, ...(diagnostic.nativeReasonCodes ?? [])] : [];
  for (const c of ['admission_binding_required', 'protected_change_not_up_to_date', 'owner_review_required', 'owner_grant_required', 'owner_grant_missing', 'owner_grant_revoked', 'owner_grant_expired',
    'path_outside_write_set', 'paths_outside_write_set', 'claim_trailer_missing', 'claim_not_found', 'claim_not_current', 'fence_superseded', 'claim_bound_to_other_pr',
    'work_claim_execution_epoch_stale', 'task_ci_head_cap_reached', 'claim_head_cap_reached', 'ci_budget_exhausted', 'head_budget_exhausted',
    'workflow_change_not_authorized', 'workflow_runs_unavailable', 'owner_review_unavailable']) if (codes.includes(c)) return DIAG[c];
  return 'NATIVE_NOT_ADMITTED';
}

// Entry outcome -> stable code. stageNumber matters only for "claim changed" (stage 1: never admitted;
// later: the batch claim moved under a running batch).
export function outcomeFailureCode(outcome, stageNumber) {
  if (!plain(outcome)) return 'STAGE_OUTCOME_MISSING';
  if (outcome.status === 'UNCERTAIN') return stageNumber === RELAY_STAGE_NUMBER && RELAY_HALT_CODES.includes(outcome.reason) ? outcome.reason : 'PUBLICATION_UNCERTAIN';
  if (outcome.status === 'RECONCILIATION_REQUIRED') return 'RECONCILIATION_REQUIRED';
  if (outcome.status === 'REVOKED') return 'PUBLICATION_REVOKED';
  if (outcome.status !== 'BLOCKED') return 'PUBLICATION_UNCERTAIN';
  if (outcome.sideEffects !== 0 || outcome.mayHavePublished !== false) return 'PUBLICATION_UNCERTAIN';
  const r = outcome.reason;
  // Only the bounded, explicit Native read exhaustion is transient. The status/effect guards above exclude
  // any sent or uncertain publication; refusal and unconfirmed replies keep their existing final semantics.
  if (r === 'native_claim_observation_unavailable') return 'NATIVE_ADMISSION_UNAVAILABLE';
  if (r === 'evidence_identity_conflict' || r === 'EVIDENCE_IDENTITY_CONFLICT') return 'EVIDENCE_IDENTITY_CONFLICT';
  // K(head, role) is held by the other path: a role on this head was (or may have been) published by it. Never
  // clean, on any stage (DESIGN §6.3; PR-A review MINOR 4).
  if (r === 'role_already_published_on_head' || r === 'ROLE_ALREADY_PUBLISHED_ON_HEAD') return 'ROLE_ALREADY_PUBLISHED_ON_HEAD';
  // On GitHub but unknown to this node (C4): clean, final, only on this clean BLOCKED with zero side effects (stage 1's
  // read-back is the only one that ends a head as HEAD_PUBLISHED_ON_GITHUB).
  if (r === HEAD_PUBLISHED_ON_GITHUB && stageNumber === 1) return HEAD_PUBLISHED_ON_GITHUB;
  if (r === ROLE_ALREADY_ON_GITHUB_REASON || r === ROLE_ALREADY_ON_GITHUB) return ROLE_ALREADY_ON_GITHUB;
  if (r === 'RESIDENT_QUEUE_HEAD_NOT_REACHED' || r === 'RESIDENT_MERGE_QUEUE_NOT_JOINED' || r === 'RESIDENT_BASE_MOVED') return r;
  if (stageNumber === 8 && STAGE8_OWN_CODES.has(r)) return r;
  if (r === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE') return 'REMOTE_REFS_CHANGED_SINCE_BUNDLE';
  if (BRIDGE_TIMEOUTS.has(r)) return 'BRIDGE_TRANSPORT_TIMEOUT';
  if (TRANSPORT_REASONS.has(r)) return r.startsWith('full_admission_') || r === 'NATIVE_ADMISSION_UNAVAILABLE' ? 'NATIVE_ADMISSION_UNAVAILABLE' : 'GITHUB_TRANSIENT_UNAVAILABLE';
  if (githubTransientReason(r)) return 'GITHUB_TRANSIENT_UNAVAILABLE';
  if (CONFIG_REASONS.has(r)) return 'ADMISSION_CONFIGURATION_REFUSED';
  if (r === 'full_admission_rejected') return stageNumber === 1 ? notAdmittedCode(outcome.diagnostic) : 'BATCH_CLAIM_CHANGED';
  if (r === 'full_admission_claim_missing' || r === 'full_admission_native_changed') return stageNumber === 1 ? 'CLAIM_NOT_CURRENT' : 'BATCH_CLAIM_CHANGED';
  if (r === 'full_admission_claim_changed' || r === 'BATCH_CLAIM_CHANGED' || r === 'BATCH_CLAIM_MISSING') return stageNumber === 1 ? 'CLAIM_NOT_CURRENT' : 'BATCH_CLAIM_CHANGED';
  if (r === 'full_admission_subject_changed') return 'PR_NOT_OPEN_OR_CHANGED';
  if (r === 'full_admission_native_unsupported' || r === 'native_policy_changed') return 'NATIVE_POLICY_UNSUPPORTED';
  if (r === 'execution_proof_refused') return 'EVIDENCE_REFUSED';
  // A refused installed registry (for example one built before the isolation rules) is a clean stage-R refusal.
  if (stageNumber === RELAY_STAGE_NUMBER && (r === 'RELAY_STAGE_NOT_CONFIGURED' || r === 'RELAY_STAGE_INPUT_INVALID' || /^RELAY_REGISTRY_[A-Z_]+$/.test(r ?? ''))) return 'RELAY_STAGE_REFUSED';
  return stageNumber === 1 || stageNumber === 2 || stageNumber === 4 || stageNumber === 6 ? 'STAGE_CHILD_REFUSED' : 'PUBLICATION_BLOCKED';
}

const BOOLS = ['stdout_captured', 'private_bytes_read_by_helper', 'host_qualification', 'ci_principal_qualification', 'tree_cleanup_confirmed', 'root_exit_confirmed', 'timed_out', 'stop_requested'];
// Mirror of v1 invoke-functions.ps1#Read-FormalNativeReceipt, for the v2 receipt.
export function validateNativeReceiptV2(n, { nonce, plan, planSha256, controllerSid, helperPid }) {
  if (!plain(n) || n.contract !== NATIVE_RECEIPT_CONTRACT_V2 || n.nonce !== nonce || !BOOLS.every(k => typeof n[k] === 'boolean')) return { ok: false, code: 'NATIVE_RECEIPT_UNCONFIRMED' };
  if (n.actual_sid !== controllerSid || n.session_id !== 0 || n.service_pid !== helperPid || n.entry_role !== plan.entryRole || n.stage !== plan.stage
    || n.entry_sha256 !== plan.entrySha256 || n.config_sha256 !== planSha256 || n.acceptance_sha256 !== plan.acceptanceSha256
    || n.source_manifest_sha256 !== plan.sourceManifestSha256 || n.stdout_captured || n.private_bytes_read_by_helper || n.host_qualification || n.ci_principal_qualification
    || !(n.outcome_sha256 === null || HEX64.test(n.outcome_sha256 ?? ''))) return { ok: false, code: 'NATIVE_RECEIPT_UNCONFIRMED' };
  const treeZero = n.tree_cleanup_confirmed === true && n.root_exit_confirmed === true && n.tree_active_processes === 0 && n.tree_cleanup_failure_code === null;
  if (!treeZero) return { ok: false, code: 'STAGE_CHILD_TREE_UNCONFIRMED', treeZero: false };
  const completed = n.state === 'FIXED_CHILD_COMPLETED' && n.failure_code === null && n.node_exit_code === 0 && !n.timed_out && !n.stop_requested;
  return { ok: completed, code: completed ? null : n.timed_out ? 'STAGE_CHILD_TIMEOUT' : null, treeZero: true };
}

export function validateOutcome(o, { nonce, plan }) {
  // A refusal before the stage inputs were read (runEntry: arguments parsed, then held record, own Source root or
  // inputs refused) carries no stage or role, but it is bound by nonce and by the helper's receipt and the body
  // never ran: nothing was issued or published. It counts as that clean refusal, never as a missing outcome
  // (UNKNOWN), and only in exactly that shape (PR #889 stage 3, 2026-10-21).
  if (plain(o) && o.contract === OUTCOME_CONTRACT && o.nonce === nonce && o.stage === null && o.entryRole === null && o.status === 'BLOCKED'
    && o.sideEffects === 0 && o.mayHavePublished === false && Array.isArray(o.jobIds) && o.jobIds.length === 0 && typeof o.reason === 'string') return o;
  if (!plain(o) || o.contract !== OUTCOME_CONTRACT || o.nonce !== nonce || o.stage !== plan.stage || o.entryRole !== plan.entryRole
    || typeof o.status !== 'string' || !(o.reason === null || typeof o.reason === 'string') || !Number.isSafeInteger(o.sideEffects) || o.sideEffects < 0
    || typeof o.mayHavePublished !== 'boolean') return null;
  return o;
}

// The bound entry outcome as the stage fact carries it to the resident (resident quota redesign v0.6 §9 phase 1,
// item 4): status, reason, side effects, the sanitized admission diagnostic (reasonCodes, nativeReasonCodes, ...),
// the scheduling facts (ci_retry_after, merge-queue entry) and the entry's own "safe to re-run" flag, which holds
// only on a clean BLOCKED with zero side effects that may not have published.
export function outcomeFacts(o) {
  return { status: o.status, reason: o.reason, sideEffects: o.sideEffects, mayHavePublished: o.mayHavePublished,
    diagnostic: sanitizeAdmissionDiagnosticV2(o.diagnostic), scheduling: sanitizeSchedulingV2(o.scheduling),
    safeToRerun: o.safeToRerun === true && o.status === 'BLOCKED' && o.sideEffects === 0 && o.mayHavePublished === false };
}
// The broker's refusals that it gives before any start, with the runner re-read as the original (no launch, state
// restored): the second way a stage may be released (v0.6 §9 phase 1, item 2). BROKER_BUSY and BROKER_UNCONFIRMED
// never qualify (an unexpected concurrent controller, or no confirmed reading).
export const BROKER_NO_LAUNCH_CODES = Object.freeze(['BROKER_RUNNER_NOT_ORIGINAL_STOPPED', 'BROKER_REQUEST_EXPIRED', 'BROKER_REQUEST_REFUSED']);
const trainFactsOrNull = f => { try { return validateTrainFacts(f); } catch { return null; } };

// The one stage fact the resident engine parses (engine-windows.mjs#parseStageFact keeps v1 names).
export function buildStageFact({ stage, nonce, plan, planSha256, workManifestSha256, broker, receipt, receiptBytes, outcome, outcomeBytes, controllerSid, preflightCode = null, expectedJobIds = null }) {
  const fact = { contract: STAGE_FACT_CONTRACT, stage, nonce, manifest_sha256: workManifestSha256, state: 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED',
    failure_code: null, scm_start_call_issued: false, original_binary_restored: false, complete_original_readback: false, configuration_conflict_detected: false,
    tree_cleanup_confirmed: false, tree_active_processes: null, root_exit_confirmed: false, native_receipt_sha256: null, outcome: null, relay: null, train: null, broker_no_launch: false };
  const done = code => ({ ...fact, failure_code: code });
  if (preflightCode) {
    // Nothing was requested from the broker: no service change, no child; the original is untouched.
    return { ...done(preflightCode), original_binary_restored: true, complete_original_readback: true, tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true };
  }
  if (!broker) return done('BROKER_RESPONSE_UNCONFIRMED');
  Object.assign(fact, { scm_start_call_issued: broker.startCallIssued, original_binary_restored: broker.restored, complete_original_readback: broker.restored && broker.stableAfter && broker.accountUnchanged,
    configuration_conflict_detected: broker.configurationConflict });
  if (broker.configurationConflict) return done('BROKER_CONFIGURATION_CONFLICT');
  if (!broker.startCallIssued) {
    // Refused before any start: the runner stayed on its original binary (the broker re-read it).
    const code = broker.code === 'BROKER_BUSY' ? 'BROKER_BUSY' : broker.code === 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED' ? 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED'
      : broker.code === 'BROKER_REQUEST_EXPIRED' ? 'BROKER_REQUEST_EXPIRED' : broker.code === 'BROKER_UNCONFIRMED' ? 'BROKER_UNCONFIRMED' : 'BROKER_REQUEST_REFUSED';
    const noLaunch = BROKER_NO_LAUNCH_CODES.includes(code) && broker.started === false && broker.helperPid === null
      && broker.restored === true && broker.stableAfter === true && broker.accountUnchanged === true;
    return { ...done(code), tree_cleanup_confirmed: broker.restored, tree_active_processes: broker.restored ? 0 : null, root_exit_confirmed: broker.restored, broker_no_launch: noLaunch };
  }
  if (!broker.stoppedInTime) return done('STAGE_HELPER_NOT_STOPPED_IN_TIME');
  if (!broker.restored || !broker.stableAfter || !broker.accountUnchanged) return done('STAGE_ORIGINAL_NOT_RESTORED');
  if (!receipt) {
    // The helper stopped without a receipt: its preflight refused before any child (FormalSession0V2
    // writes a receipt only once its boundary validated). No child means a zero tree.
    return { ...done(broker.started && broker.helperPid ? 'STAGE_HELPER_PREFLIGHT_REFUSED' : 'NATIVE_RECEIPT_UNCONFIRMED'),
      tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true };
  }
  const n = validateNativeReceiptV2(receipt, { nonce, plan, planSha256, controllerSid, helperPid: broker.helperPid });
  fact.native_receipt_sha256 = hash(receiptBytes);
  if (n.treeZero) Object.assign(fact, { tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true });
  if (!n.treeZero) return done(n.code);
  const boundOutcome = receipt.outcome_sha256 && outcomeBytes && hash(outcomeBytes) === receipt.outcome_sha256 ? validateOutcome(outcome, { nonce, plan }) : null;
  fact.outcome = boundOutcome ? outcomeFacts(boundOutcome) : null;
  // Stage R: the relay plan rows travel with the fact (the resident writes them into 25-plan), on success
  // and on a HALT alike; rows that do not validate never pass as a completed relay stage.
  const relayRows = plan.stage === RELAY_STAGE_NUMBER && boundOutcome ? validateRelayPlanRows(outcome.relay) : null;
  if (plan.stage === RELAY_STAGE_NUMBER) fact.relay = relayRows;
  // Stage 10 (quota phase 2 step 3c-1, DESIGN §22.1): the train facts travel with the fact, validated again; a run is a
  // success only as TRAIN_FACTS with zero side effects and facts that validate. Anything else is the existing
  // STAGE_OUTCOME_MISSING; the executor decides from the proof and the bound outcome whether that ending is clean
  // (executor.mjs#trainMaintenance).
  const trainFacts = plan.stage === TRAIN_STAGE_NUMBER && boundOutcome ? trainFactsOrNull(outcome.train) : null;
  if (plan.stage === TRAIN_STAGE_NUMBER) fact.train = trainFacts;
  if (n.ok) {
    if (plan.stage === 12) {
      let revocation = null;
      try { revocation = validateRevocationFacts(boundOutcome?.revocation); } catch { /* unconfirmed */ }
      const pending = boundOutcome?.status === 'PENDING';
      if (!boundOutcome || boundOutcome.entryRole !== 'revocation-maintenance' || !revocation
        || !['REVOCATION_MAINTENANCE','PENDING'].includes(boundOutcome.status)
        || revocation.complete === pending || !Array.isArray(boundOutcome.jobIds) || boundOutcome.jobIds.length !== 1
        || !Array.isArray(expectedJobIds) || expectedJobIds.length !== 1 || boundOutcome.jobIds[0] !== expectedJobIds[0]) return done('STAGE_OUTCOME_MISSING');
      // Negative effects are real effects. Neither their count nor pending work
      // may be disguised as a zero-effect role probe or shadow observation.
      return { ...fact, state: pending ? 'REVOCATION_MAINTENANCE_PENDING_ORIGINAL_STOPPED_NO_QUALIFICATION' : SUCCESS_STATE,
        revocation, maintenancePending: pending };
    }
    // Stage 11: only a zero-effect bound outcome from this exact role/job can assert a role observation.
    // A generic pre-input refusal (null stage/role/jobs) remains unconfirmed and cannot become held.
    if (plan.stage === 11) {
      const probe = boundOutcome && boundOutcome.stage === 11 && boundOutcome.entryRole === 'role-probe'
        && Array.isArray(boundOutcome.jobIds) && boundOutcome.jobIds.length === 1 && HEX64.test(boundOutcome.jobIds[0] ?? '')
        && Array.isArray(expectedJobIds) && expectedJobIds.length === 1 && boundOutcome.jobIds[0] === expectedJobIds[0]
        && boundOutcome.status === 'BLOCKED' && boundOutcome.sideEffects === 0 && boundOutcome.mayHavePublished === false
        ? roleProbeFact(boundOutcome.reason) : null;
      if (!probe) return done('STAGE_OUTCOME_MISSING');
      return { ...fact, state: SUCCESS_STATE, roleProbe: probe };
    }
    if (plan.stage === TRAIN_STAGE_NUMBER) {
      if (!boundOutcome || boundOutcome.status !== 'TRAIN_FACTS' || boundOutcome.sideEffects !== 0 || boundOutcome.mayHavePublished !== false || !trainFacts) return done('STAGE_OUTCOME_MISSING');
      return { ...fact, state: SUCCESS_STATE };
    }
    if (plan.stage === RELAY_STAGE_NUMBER) {
      if (!boundOutcome || boundOutcome.status !== 'RELAY_COMPLETE') return done('STAGE_OUTCOME_MISSING');
      // A complete plan (every row RELAYED or LOCAL_REQUIRED) with no reason, or one ending ON_GITHUB (C4) with exactly that reason.
      const ending = relayRows ? relayPlanEnding(relayRows) : null;
      if (!ending || boundOutcome.reason !== (ending === 'ON_GITHUB' ? ROLE_ALREADY_ON_GITHUB : null)) return done('RELAY_PLAN_UNCONFIRMED');
      return { ...fact, state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION' };
    }
    if (!boundOutcome || !['SETTLED', 'ISSUED_RESULT_RECEIVED'].includes(boundOutcome.status)) return done('STAGE_OUTCOME_MISSING');
    return { ...fact, state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION' };
  }
  if (n.code === 'STAGE_CHILD_TIMEOUT') return done(boundOutcome ? outcomeFailureCode(boundOutcome, plan.stage) : 'STAGE_CHILD_TIMEOUT');
  return done(outcomeFailureCode(boundOutcome, plan.stage));
}

export const ALL_STAGE_CODES = Object.freeze([...new Set([...NOT_ADMITTED_CODES, ...TRANSIENT_CODES, ...CLEAN_FINAL_CODES, ...UNKNOWN_CODES])]);
export const factDigest = fact => hash(canonical(fact));
