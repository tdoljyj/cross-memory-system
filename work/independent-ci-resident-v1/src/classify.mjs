// Failure classification. The executor only continues after a failure it can prove is clean;
// anything it does not recognise, or anything without a complete cleanup proof, is UNKNOWN and
// latches HALT. The tables are allow-lists: a new or misspelled code falls through to UNKNOWN.
//
// Source v2 (DESIGN S11): the stage codes below MIRROR the stable failure catalogue of the installed
// Source (actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs); a test keeps the
// two identical. The resident never imports the Source at run time (it is a separate pinned layer).
import { readFileSync } from 'node:fs';
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
  'RELAY_STAGE_REFUSED',
  // Stage 8 not ready (phase 2, step 2): parked and tried again; final only when main moved or the tries ran out.
  'RESIDENT_MERGE_QUEUE_NOT_JOINED', 'RESIDENT_BASE_MOVED',
  // Phase 2, step 3a: main's live branch rules, GitHub's test merge, the green ledger (parked and tried again), and a
  // test merge of exactly [T, H] that is not the tested tree (final for the head).
  'RULESET_UNREADABLE', 'STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_NOT_READY', 'GREEN_LEDGER_UNAVAILABLE',
  'TRAIN_TEST_MERGE_TREE_DIFFERS',
  // App 5368905 already published on this head, found on GitHub (primary/standby design v0.4 §6.2, C4): at stage 1
  // before Native was asked, or before a role's first publication that this node knew nothing of. A new commit is needed.
  'HEAD_PUBLISHED_ON_GITHUB', 'ROLE_ALREADY_ON_GITHUB']);
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

// Stage R rows for exactly the candidates (in order) -> { relayed: [row], local: [row], onGithub: row | null }, or null
// when the rows are not a plan the executor acts on. A plan is every row a clean RELAYED / LOCAL_REQUIRED row, or such
// rows, then one ON_GITHUB row (ROLE_ALREADY_ON_GITHUB: App 5368905 already published that role on the head and this node
// knew nothing of it; C4), then only NOT_PROCESSED rows or never-relayable LOCAL_REQUIRED rows (mirror of the Source's
// relay-plan.mjs#relayPlanEnding). Anything else (HALT, NOT_PROCESSED without ON_GITHUB before it, an unknown reason, a
// missing field) is null.
export function relayPlanFromRows(rows, candidates) {
  if (!Array.isArray(rows) || !Array.isArray(candidates) || rows.length !== candidates.length || rows.length === 0) return null;
  const relayed = [], local = []; let onGithub = null;
  for (const [i, r] of rows.entries()) {
    if (r === null || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== RELAY_ROW_FIELDS.length || !RELAY_ROW_FIELDS.every(k => Object.hasOwn(r, k))) return null;
    if (r.role !== candidates[i]) return null;
    const nothing = r.checkRunId === null && r.externalId === null && r.attestationSha256 === null;
    const localRow = r.outcome === 'LOCAL_REQUIRED' && RELAY_LOCAL_REASONS.includes(r.reason) && ['relay-local-fallback', 'relay-billing-refused'].includes(r.receipt) && nothing;
    if (onGithub) {
      if (r.outcome === 'NOT_PROCESSED' && r.reason === null && r.receipt === null && nothing) continue;
      if (localRow && r.reason === 'RELAY_ROLE_NOT_RELAYABLE') { local.push(r); continue; }
      return null;
    }
    if (r.outcome === 'RELAYED' && r.reason === null && r.receipt === 'relay-attested' && Number.isSafeInteger(r.checkRunId) && r.checkRunId > 0
      && typeof r.externalId === 'string' && EXTERNAL.test(r.externalId) && r.externalId.split(':')[2] === r.role && HEX64.test(r.attestationSha256 ?? '')) relayed.push(r);
    else if (localRow) local.push(r);
    else if (r.outcome === 'ON_GITHUB' && r.reason === 'ROLE_ALREADY_ON_GITHUB' && r.receipt === null && nothing) onGithub = r;
    else return null;
  }
  return { relayed, local, onGithub };
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
// How such a stage may end once it was asked to stop for an abort: any ending that is clean anyway, a stage that was
// not invoked because the abort came first, the bridge pump cancelled after the stop was sent, or the stopped entry's
// missing outcome (STAGE_OUTCOME_MISSING: UNKNOWN in every other path). The last one only when the broker's own
// receipt says STOP_SENT: the stop control reached the running helper, whose only answer to it is STOP_REQUESTED
// (independent review, M2). A scanner-issuer publishes no check, and both hosts must still prove quiescence.
// Always together with the Windows half of the cleanup proof (helper tree drained, original binary restored).
export const OWNER_ABORT_STAGE_ENDINGS = Object.freeze([...TRANSIENT_CODES, ...CLEAN_FINAL_CODES, ...RESIDENT_CLEAN,
  'STAGE_OUTCOME_MISSING', 'OWNER_ABORT_REQUESTED', 'COMPANION_PUMP_CANCELLED']);
const ABORT_ENDINGS = new Set(OWNER_ABORT_STAGE_ENDINGS);
export function abortStageEndingClean(result, { stopSent = false } = {}) {
  if (!result || result.ok === true) return !!result;
  if (result.code === 'STAGE_OUTCOME_MISSING' && stopSent !== true) return false;
  return typeof result.code === 'string' && ABORT_ENDINGS.has(result.code)
    && result.proof?.windowsTreeZero === true && result.proof?.serviceOriginalStopped === true;
}

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
export const FAILURE_CLASSES_V1 = Object.freeze(['not-admitted', 'waiting', 'deterministic-pr', 'unmapped-stage-1', 'transient', 'environment', 'clean-final', 'queue', 'abort', 'unknown']);
export const DISPOSITIONS = Object.freeze(['release', 'release-if-safe', 'burn', 'halt']);
export const RETRY_RULES = Object.freeze(['new-trigger', 'attempt2', 'new-commit', 'owner-rearm']);
const ROW_KEYS = ['code', 'stages', 'phase', 'reasons', 'reasonCodesAny', 'reasonCodesWithin', 'class', 'disposition', 'retry', 'breaker', 'note'];
const LOWER = /^[a-z][a-z0-9_]{0,63}$/, REASON = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
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
      // the one automatic attempt 2 only follows a transient code, and every transient code may select it
      && ((r.retry === 'attempt2') === TRANSIENT.has(r.code)), 'FAILURE_TABLE_INVALID', r?.code);
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
//     waits' own budget (waitingRetriesPer24h a day, every PR together), any other release by the head's release cap
//     (releasesPerHeadPer24h counted releases in 24 hours, then STOPPED; an environment release while the breaker is
//     not closed is not counted), a supersession by nothing (nothing about the PR was decided).
export const UNEXECUTED_REASON_RULES = Object.freeze({
  NOT_ADMITTED: Object.freeze({ cooldown: true, cap: Object.freeze({ waiting: 'waitingRetriesPer24h', other: 'releasesPerHeadPer24h' }), evidence: 'stage-1 outcome safeToRerun' }),
  BUNDLE_UNAVAILABLE: Object.freeze({ cooldown: true, cap: Object.freeze({ waiting: null, other: 'releasesPerHeadPer24h' }), evidence: 'bundle failed before stage 1' }),
  BROKER_NOT_LAUNCHED: Object.freeze({ cooldown: true, cap: Object.freeze({ waiting: null, other: 'releasesPerHeadPer24h' }), evidence: 'broker refused before any launch, original restored' }),
  SUPERSEDED: Object.freeze({ cooldown: false, cap: Object.freeze({ waiting: null, other: null }), evidence: 'a newer commit of the PR arrived before stage 1' }),
});

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
  const deterministic = diagnosticCodes(outcome?.diagnostic).some(c => DETERMINISTIC_REASON_CODES.includes(c));
  // What the deterministic code makes of a release-if-safe row is what the ledger and the status record.
  if (deterministic && row.disposition === 'release-if-safe') row = Object.freeze({ ...row, class: 'deterministic-pr', disposition: 'burn', retry: 'new-commit', breaker: 'neutral' });
  if (started !== true && row.disposition === 'release-if-safe' && windows) {
    if (outcome?.safeToRerun === true) return { klass: 'NOT_ADMITTED', basis: 'stage-1-safe-to-rerun', row, release: 'NOT_ADMITTED' };
    if (brokerNoLaunch === true) return { klass: 'NOT_ADMITTED', basis: 'stage-1-broker-not-launched', row, release: 'BROKER_NOT_LAUNCHED' };
  }
  if (!proofComplete(proof)) return { klass: 'UNKNOWN', basis: 'cleanup-proof-incomplete', row, release: null };
  return { klass: 'CLEAN', basis: row.class === 'transient' ? 'transient-cleanup-proof-complete' : 'cleanup-proof-complete', row, release: null };
}
