// Resident executor state machine (runs inside the CluedCIResident service).
//
// One tick: crash recovery first (always), then the Owner's own requests (re-arm, resume) from the
// admin-only owner directory, then HALT / PAUSE, then bounded untrusted triggers. The oldest
// candidate is pre-checked without any secret or network access, reserved in the ledger and driven
// through the installed Source's eight fixed stages. Live authority (GitHub PR facts, KooYomi
// admission, Owner grants, merge queue) is decided inside the stages by the existing reviewed helpers
// that run as clued-control; this module never sees a secret.
//
// Order of one batch (PR-A, free-minutes design S19):
//   reserve -> derive -> companion bundle -> stage 1 (admission) -> markStarted (burns the head) ->
//   15-relay-wait (t0, batch) -> hosted wait (bounded, hosted-wait.mjs#decide over the companion's untrusted
//   hints; NON-BLOCKING: while it says WAIT the tick returns WAITING, and every later tick re-evaluates it
//   from the stored t0 only after recovery, the Owner's requests, HALT and PAUSE, so the emergency stop is
//   never delayed by a wait and the service loop keeps the instance lock fresh) -> 20-plan-intent ->
//   stage R (hosted relay, only when there are relay candidates) -> 25-plan ->
//   [Linux workspace preparation] -> execution + publication stages of the LOCAL_REQUIRED roles only ->
//   stage 8 -> close (success-path archive) -> COMPLETED
// Before markStarted nothing touched Linux, no scanner ran and no success check was published, so a
// bundle failure or a stage-1 "not admitted" releases the reservation instead of burning the head.
// A batch whose heavy roles were all relayed still burns its head (markStarted) and never touches WSL.
// Stage R: RELAY_PUBLICATION_UNCERTAIN (or any plan row that is not a clean RELAYED / LOCAL_REQUIRED) is
// UNKNOWN and HALTs; such a role is never run locally afterwards. A role is run locally only from 25-plan.
// An ON_GITHUB row (primary/standby C4: the role's check is already on GitHub, unknown to this node) ends the batch
// cleanly as ROLE_ALREADY_ON_GITHUB, with no 25-plan and no local stage; so does stage 1's HEAD_PUBLISHED_ON_GITHUB,
// after which the head is recorded as executed.
//
// Failure handling (Owner Decision 0d84ddbb item 4): a failure with a complete cleanup proof is
// archived (rename only) and the executor moves on; the head is never re-run automatically, with ONE
// exception (Owner Decision 1b5d3687, attempts.mjs): an allow-listed clean transient failure before any
// role was published schedules attempt 2 of the same head once (its own batch and head key).
// Anything else latches HALT and leaves the scene untouched until the Owner's re-arm, which the
// service itself carries out (the elevated Owner step only writes a request; it never moves files).
//
// Owner abort (DESIGN §6.5): the Owner may ask, through the same admin-only owner directory, to abort the current
// batch. It is honoured only at safe points: at a tick start for a batch that waits for hosted signals, before each
// step of a batch, and while a scanner-issuer stage (2, 4, 6; it publishes no check) runs, which is then asked to stop
// through its own stop path (broker -> SERVICE_CONTROL_STOP -> the helper drains its own job). Then quiescence on both
// hosts, a rename-only archive and FAILED_CLEAN OWNER_ABORTED; when quiescence cannot be proven, HALT as always.
// An abort never publishes, retracts or re-runs anything, and never kills a process.
//
// Resident quota redesign v0.6 + §9, phase 1 (Task 12ada80e):
//   - executed heads independent of the Source (executed-heads.mjs): no batch runs before the first start's backfill
//     finished, a head that may have published under ANY Source is never admitted again, and the executor records
//     a head right before the first stage that can publish (R, 3, 5, 7 or 8);
//   - the stage outcome (diagnostic, scheduling facts, safeToRerun) and the broker's no-launch fact travel with a stage
//     failure, and the machine-readable failure table (classify.mjs#decideFailure) decides release or burn: a stage-1
//     failure is released only on the outcome's own safeToRerun flag or the broker's no-launch answer;
//   - a status board (status.mjs) shows the state, the batch in flight, the pending triggers and recent outcomes.
//
// Resident quota redesign phase 2, step 1 (design v0.5 §4.1-§4.7, DESIGN §17, Task 6451a55d):
//   - triggers are read into the executor's own run queue (queue.mjs, one row per PR, its own arrival sequence,
//     supersession, new triggers) and the queue decides which row runs next: a due attempt 2, then due waits and poked
//     rows, then first come, first served; a row that is only deferred, or ignored, never blocks the rows behind it;
//   - a release goes to the tail and is retried on the row's own back-off; a wait backs off and has its own budget; a
//     head released too often stops; every daily budget is derived from the ledger (ledger.mjs#usage);
//   - the circuit breaker (breaker.mjs) is fed one event per batch end and asked before every start;
//   - a batch whose PR got a newer commit is released before stage 1 (SUPERSEDED, nothing burned), and after stage 1
//     ended at a safe point outside the Linux preparation only when a live read of the PR confirms it
//     (SUPERSEDED_AT_SAFE_POINT: the Owner abort's quiescence and rename-only archive, the head burned, never an
//     attempt 2). When stage 1 or the bundle proves the batch head is no longer the PR's head, one live read may restore
//     a superseded, unburned commit as the PR's current one. A live read only ever stops or re-queues.
//
// Phase 2, step 2 (parking; design v0.5 §4.3, §4.8, §4.9; Owner decision e1e19e2e item 4; DESIGN §18):
//   - a batch rests at parking point A (the hosted wait) or B (after the last role stage and the close archive on both
//     hosts, before stage 8) with nothing of it running and Linux empty; other batches run meanwhile. A tick runs at most
//     one Linux exclusive zone (workspace preparation to the last Linux stage), and never parks inside one;
//   - at B, stage 8 runs as tries: one check (Source v2 STAGE8_CHECK_MS) that, when the claim is not at the merge-queue
//     head yet, ends with zero side effects and a named reason; the batch parks again and is tried on its own back-off
//     (10, 20, 40, 80, 120 minutes, 1 minute when its claim is first in the queue) for at most park.stage8MaxTries tries
//     and park.maxMs. Main moving (RESIDENT_BASE_MOVED) or the tries running out end it neutrally (its head published
//     stages 3, 5 and 7: a new commit runs the PR again);
//   - at most park.maxParked batches rest at A or at B in the queue's first two places; others at B are bounded by
//     park.maxParkedOutsideTop2 and beyond that end as PARKED_OVER_CAPACITY;
//   - the Owner's drain request (tools/rearm-tool.mjs request-drain) ends every parked batch on the Owner abort's path,
//     so a reinstall finds no open batch (with the Owner abort's guards: no unarchived scene, no drift, recovery done).
//
// The intake pause (primary/standby design v0.4 §5.4 step 1, §9 C6; Task 6444f88a; intake-pause.mjs, DESIGN §20): while
// any holder's hold is in force (at most two hours, from the user-writable requests\ like PAUSE) no batch starts from the
// queue (no row, no attempt 2); triggers are still read, and a batch in flight or at a parking point goes on. It is
// neither PAUSE (which also stops the parked batches) nor the drain (which ends them); all three may be in force at once.
//
// The node mode (primary/standby C3; Task 17b703a0; DESIGN §29): ACTIVE, STANDBY or UNCERTAIN (this.roleProbeMode). A start and an
// Owner re-arm begin UNCERTAIN with a role probe due at once; the probe (stage 11, DESIGN C2) says held -> ACTIVE, not-held ->
// STANDBY, uncertain -> the mode stays. Stage 1's NODE_ROLE_NOT_HELD goes to STANDBY too. While the mode is not ACTIVE the
// schedule starts nothing (no row, no attempt 2, no waiting-retry; DEFERRED NODE_STANDBY / NODE_ROLE_UNCERTAIN, a quiet
// result so the probe still runs): triggers are still read, and a batch in flight or at a parking point goes on, its live
// admission deciding. A failure that may mean the role is gone makes the next probe due at once (roleProbe.urgent).
//
// Stage 10, the merge train in shadow mode (quota redesign phase 2, step 3c-1; design v0.5 §5.5, §4.7; Owner decision
// 2eea28a1; train.mjs, DESIGN §22.3): with train.enabled 'shadow', a tick that ran nothing (the queue idle or only
// deferred, never under an intake pause, PAUSE or HALT) runs one read-only train maintenance when it is due. It writes
// nothing but its own shadow record (Source v2), so a failure whose cleanup is proven and whose outcome shows no side
// effect is only a 'train-run' receipt and never feeds the breaker. Anything else HALTs, like any stage: an unproven
// cleanup, a reported side effect, a failure that is not allow-listed as clean. Stage 10 has no ledger entry: its
// 'train-run-intent' receipt stands for one, so an intent that no 'train-run' receipt closed (a crash or a stop in the
// middle) HALTs as TRAIN_STAGE_INTERRUPTED at the next start, and a receipt chain that cannot be read holds every batch.
//
// The in-place upgrade channel (Task 018da927, DESIGN §34): the upgrader's resume (UPGRADE_RESUME_CONTRACT, owner\ only, a CAS on
// PAUSED.json, receipt 'upgrade-resumed'); every tick the versions of both sides (status /7) and the version-skew intake hold
// while they disagree (consistent === false only; lifted when they agree again; an unknown answer changes nothing).
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Ledger, MAX_TRIES, QUOTA_TIER_EVALUATION, batchKey, headKey } from './ledger.mjs';
import { ABORTABLE_IN_FLIGHT, BRIDGE_ABANDONED_UNPUBLISHED, NOT_ADMITTED_CODES, OWNER_ABORTED, UNEXECUTED_REASON_RULES, abortStageEndingClean, archiveReason, decideFailure, failureRow,
  proofComplete, scannerAbandonEligible } from './classify.mjs';
import { parseTrigger } from './trigger.mjs';
import { POSITIONS, breakerGate, breakerOf, breakerRecord, breakerView, positionOf } from './breaker.mjs';
import { batchBudgetMs } from './policy.mjs';
import { attempt2Decision, attempt2Subject } from './attempts.mjs';
import { decide, parseHint, HEAVY_ROLES, RELAY_ROLES } from './hosted-wait.mjs';
import { relayPlanFromRows } from './classify.mjs';
import { RELAY_STAGE, ROLE_STAGES } from './policy.mjs';
import { RELAY_RECEIPTS } from './receipts.mjs';
import { CODE, HEX64, ResidentError, check, digest, exactKeys, parseBoundedJson, sha256 } from './canonical.mjs';
import { UPGRADE_RESUME_CONTRACT, validateUpgradeResume } from './upgrade-mailbox.mjs';
import { INTAKE_PAUSE_CONTRACT, INTAKE_PAUSE_MAX_MINUTES, INTAKE_RESUME_CONTRACT, IntakePause, UNCONFIRMED_HOLDER } from './intake-pause.mjs';
import { TRAIN_STAGE } from './policy.mjs';
import { classifyFailure } from './classify.mjs';
import { trainDue, trainSummary } from './train.mjs';
import { RoleProbe, validateRoleProbeFact } from './role-probe.mjs';
import { NODE_MODES } from './status.mjs';
import { RevocationMaintenanceBook,validateRevocationFacts,validateRevocationQualification,
  REVOCATION_RUN_MS,REVOCATION_HELPER_MARGIN_MS,REVOCATION_RUN_ID } from './revocation-maintenance.mjs';

export const PAUSE_CONTRACT = 'clued.independent-ci.resident-pause/1';
export const REARM_CONTRACT = 'clued.independent-ci.resident-owner-rearm/1';
export const DRAIN_CONTRACT = 'clued.independent-ci.resident-owner-drain-parked/1';
export const RESUME_CONTRACT = 'clued.independent-ci.resident-owner-resume/1';
export const ABORT_CONTRACT = 'clued.independent-ci.resident-owner-abort/1';
// In-place upgrade channel (Task 018da927, DESIGN §34; frozen observation surface A11): the upgrader (CluedCIUpgrader, LocalSystem)
// lifts the PAUSE it set for an upgrade through the admin-only owner\ directory, by the exact PAUSED.json bytes it saw. Taken from
// owner\ only (never from the user-writable requests\, where its contract is no pause and is rejected); its receipt is
// 'upgrade-resumed'. Later resident versions must keep accepting it.
export { UPGRADE_RESUME_CONTRACT };
export const UPGRADE_RESUMED_BY = 'CluedCIUpgrader';
// The executor's own intake hold while the two sides run different versions (A10): holder version-skew, two hours, renewed when
// less than 90 minutes are left, lifted when the versions agree again. An unknown answer (null) neither adds nor lifts it.
export const VERSION_SKEW_HOLDER = 'version-skew';
export const VERSION_SKEW_RENEW_BELOW_MS = 90 * 60_000;
export const UPGRADE_VERSION_SKEW = 'UPGRADE_VERSION_SKEW';
// The precheck's global deferral while the sides disagree (before any reservation; nothing burned, nothing counted).
export const VERSION_SKEW = 'VERSION_SKEW';
export const OWNER_ABORT_ARCHIVE_REASON = 'owner-aborted';
// Poll of the owner directory while a scanner-issuer stage runs, and the bounded re-check of quiescence after an abort.
export const ABORT_POLL_MS = 5_000;
export const ABORT_QUIESCENCE_ATTEMPTS = 9;
export const ABORT_QUIESCENCE_POLL_MS = 20_000;
export const ABORT_QUIESCENCE_WAIT_MS = 5 * 60_000;
const OWNER_SCAN_MAX = 32;
const DAY = 86_400_000;
const codeOf = error => (error instanceof ResidentError && CODE.test(error.code)) ? error.code : 'RESIDENT_EXECUTOR_EXCEPTION';
const validCode = code => (typeof code === 'string' && CODE.test(code)) ? code : 'FAILURE_CODE_INVALID';
// DESIGN §33 (the first HALT of 2026-10-29 said only UNEXECUTED_CLOSE_UNCONFIRMED): the Windows archive's own code when it did not
// verify (engine-windows.mjs archiveWindows, closeBatch, archiveFailure answer `archiveCode`), a fixed code or nothing. An archive
// check that fails carries it on the refusal as `windowsArchiveCode`; the HALT facts, the FAILED_UNKNOWN terminal facts and the
// batch-terminal receipt then name it, so the next HALT says why the archive did not verify. Codes only, never text or paths.
const archiveCodeOf = answer => (answer && answer.verified !== true && typeof answer.archiveCode === 'string' && CODE.test(answer.archiveCode)) ? answer.archiveCode : null;
function archiveCheck(ok, code, windows) {
  if (ok) return;
  const error = new ResidentError(code);
  const archive = archiveCodeOf(windows);
  if (archive) error.windowsArchiveCode = archive;
  throw error;
}
const archiveFacts = error => (typeof error?.windowsArchiveCode === 'string' && CODE.test(error.windowsArchiveCode)) ? { windowsArchiveCode: error.windowsArchiveCode } : {};
const TRAIN_RUN_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
// The schedule results that ran nothing, after which stage 10 may run (an intake pause holds it as well).
const TRAIN_QUIET_STATES = Object.freeze(['IDLE', 'DEFERRED']);
const TRAIN_HELD_REASONS = Object.freeze(['INTAKE_PAUSED', 'INTAKE_PAUSE_UNCONFIRMED']);
// Primary/standby C3 (DESIGN §29): why the schedule starts nothing while the node mode is not ACTIVE. These results are quiet (the
// role probe and stage 10 may run) and, like an intake pause, leave a batch resting at parking point A as the tick's result.
export const NODE_DEFERRALS = Object.freeze({ STANDBY: 'NODE_STANDBY', UNCERTAIN: 'NODE_ROLE_UNCERTAIN' });
// Endings after stage 1 that may mean the node lost its role (a live admission or a publisher refused): the next quiet tick
// probes at once. The Source maps a refused live admission after stage 1 to BATCH_CLAIM_CHANGED and a refused publisher to
// PUBLICATION_BLOCKED; the not-admitted codes are listed because PR_NOT_OPEN_OR_CHANGED can come at any stage.
export const ROLE_LOST_SUSPECT_CODES = Object.freeze([...NOT_ADMITTED_CODES, 'PUBLICATION_BLOCKED', 'BATCH_CLAIM_CHANGED']);
// The generic helper's own fixed margin after a stage's cap (FormalPublicBoundaryV2.cs), whatever limits.stageMarginMs says.
const TRAIN_HELPER_MARGIN_MS = 180_000;
// Stage 10 never touches Linux: its proof is the Windows half only.
const TRAIN_LINUX_PROOF = Object.freeze({ linuxUnitsInactive: true, containersZero: true });
const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const NONCE = /^[0-9a-f]{12,32}$/;

// clued.independent-ci.resident-owner-abort/1: the exact batch key and the SHA-256 of the latest ledger record of that
// batch the Owner reviewed (Ledger.latestRecord), with the same time, nonce and reason bounds as a re-arm.
export function validateAbortRequest(v) {
  exactKeys(v, ['contract', 'batchKey', 'ledgerEntrySha256', 'reason', 'by', 'requestedAt', 'nonce'], 'OWNER_REQUEST_REFUSED');
  check(v.contract === ABORT_CONTRACT && HEX64.test(v.batchKey) && HEX64.test(v.ledgerEntrySha256) && SID.test(v.by) && NONCE.test(v.nonce)
    && !Number.isNaN(Date.parse(v.requestedAt)) && typeof v.reason === 'string' && v.reason.length > 0 && v.reason.length <= 200, 'OWNER_REQUEST_REFUSED');
  return v;
}

// The accepted request as the ledger's 80-owner-abort records it.
const adopted = a => ({ requestSha256: a.requestSha256, by: a.by, reason: a.reason });

// A step failure travels as a value, so the failure path runs exactly once, outside the step loop. result: the stage
// result it came from (its bound outcome and the broker's no-launch fact decide a release, classify.mjs#decideFailure; the
// bridge facts of a scanner-issuer stage decide an abandonment, DESIGN §27).
class StepFailure {
  constructor(stageNumber, code, proof, phase, relayedRoles = 0, result = null) {
    Object.assign(this, { stageNumber, code: validCode(code), proof: proof ?? {}, phase, relayedRoles, outcome: result?.outcome ?? null, brokerNoLaunch: result?.brokerNoLaunch === true,
      bridge: bridgeFacts(result?.bridge) });
  }
}

// The bridge facts of a scanner-issuer stage (engine-windows.mjs#invoke, DESIGN §26) as the executor keeps them: codes, one
// broker request id and one flag, each re-checked; anything else is null (no facts, so never an abandonment).
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function bridgeFacts(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const code = v => (v === null ? null : typeof v === 'string' && CODE.test(v) ? v : undefined);
  const f = { pumpCode: code(b.pumpCode ?? null), stopRequestId: b.stopRequestId === null || b.stopRequestId === undefined ? null : (UUID_RE.test(b.stopRequestId) ? b.stopRequestId : undefined),
    stopCode: code(b.stopCode ?? null), stageCode: code(b.stageCode ?? null), pumpQuiet: b.pumpQuiet === true };
  return Object.values(f).includes(undefined) ? null : f;
}
// The pre-stage memory gate's facts (engine-windows.mjs#memoryGate, DESIGN §32) as the stage-terminal receipt records them: counts,
// the ring order and the outcome only, each re-checked (anything else is null).
const nonNegative = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
function memoryGateFacts(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  return { checks: nonNegative(g.checks), order: nonNegative(g.order), blocks: nonNegative(g.blocks), waitedMs: nonNegative(g.waitedMs), ready: [true, false].includes(g.ready) ? g.ready : null, refused: g.refused === true };
}
// Scanner abandonment (DESIGN §27): the fixed archive reason segment and the terminal basis.
export const SCANNER_ABANDON_ARCHIVE_REASON = 'scanner-abandoned';

// The stages before which the executor records the head as "may have published" (executed-heads.mjs): every stage that
// can publish a role or control check.
export const PUBLICATION_STAGES = Object.freeze([3, 5, 7, 8, RELAY_STAGE]);
// A backfill that keeps failing transiently (not a refused source) HALTs after this long (an antivirus or backup lock
// of a few minutes only defers it).
export const BACKFILL_PENDING_MAX_MS = 30 * 60_000;
const NO_STATUS = Object.freeze({ update() {}, setState() {}, setCurrent() {}, outcome() {}, setPending() {} });

// Phase 2, step 1 (DESIGN §17).
export const SUPERSEDED_AT_SAFE_POINT = 'SUPERSEDED_AT_SAFE_POINT';
export const SUPERSEDED_ARCHIVE_REASON = 'superseded';
// The status code of a reservation released for a newer commit before stage 1 (release reason SUPERSEDED).
export const BATCH_SUPERSEDED = 'BATCH_SUPERSEDED';
// What one batch usually takes (design v0.5 §1: 17.5 to 24 minutes): only the status board's estimate.
export const ETA_BATCH_MS = 22 * 60_000;
// Queue rows looked at in one tick (an ignored or deferred row does not end the tick; this bounds the work).
export const ROWS_PER_TICK = 16;
// Endings after which the batch head may no longer be the PR's head (falsification, queue.mjs#restore): stage 1 saw the
// PR changed or closed, the refs moved since the bundle, or the bundle failed.
export const FALSIFYING_CODES = Object.freeze(['PR_NOT_OPEN_OR_CHANGED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 'BUNDLE_UNAVAILABLE']);
export const FALSIFYING_REASONS = Object.freeze(['pr_subject_changed', 'pr_files_changed']);
// A batch that waits for hosted signals is resumed every tick: its supersession live read (and the receipt of a missing
// answer) happens at most this often (independent review of step 1, m9).
export const SUPERSEDE_LIVE_READ_MS = 10 * 60_000;
// Ticks in a row the queue could not be written before the Owner is told (re-review N2).
export const QUEUE_SAVE_ALARM = 3;
// Phase 2, step 2: stage 8 not ready, with zero side effects (Source v2 publisher STAGE8_NOT_READY_REASONS).
export const STAGE8_NOT_READY_CODES = Object.freeze(['RESIDENT_BASE_MOVED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED',
  // Phase 2, step 3a: main's live branch rules, GitHub's test merge, the green ledger (all before any journal write).
  'RULESET_UNREADABLE', 'STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_NOT_READY', 'GREEN_LEDGER_UNAVAILABLE']);
// Stage-8 answers the Owner must hear about (step 3a): main's rules do not hold it for a green, or GitHub's merge of exactly
// [T, H] is not what was tested.
export const STAGE8_OWNER_NOTICE_CODES = Object.freeze(['STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_TREE_DIFFERS']);
export const PARK_RETRY_MS = Object.freeze([10 * 60_000, 20 * 60_000, 40 * 60_000, 80 * 60_000, 120 * 60_000]);
// DESIGN §28 (design r3 4a, PR #930): a stage-8 try that ended BLOCKED with zero side effects on a transient admission or GitHub
// failure parks the batch at B again instead of burning a head whose stages 1-7 passed. Fixed here, not in the policy (no
// policy contract change): at most STAGE8_TRANSIENT_MAX_TRIES such parks, after 1, 3 and 10 minutes; the next one ends the batch
// through fail() as before. They count towards park.stage8MaxTries, park.maxMs and park.stage8RetriesPer24h like any try.
export const STAGE8_TRANSIENT_PARK_CODES = Object.freeze(['NATIVE_ADMISSION_UNAVAILABLE', 'GITHUB_TRANSIENT_UNAVAILABLE']);
export const STAGE8_TRANSIENT_MAX_TRIES = 3;
export const STAGE8_TRANSIENT_RETRY_MS = Object.freeze([60_000, 3 * 60_000, 10 * 60_000]);
// A parked batch whose claim was first in the queue at its last try is tried again this soon; a nudge (a trigger that
// says main moved or the PR changed) makes a try due at most this often.
export const PARK_HEAD_RETRY_MS = 60_000;
export const PARK_NUDGE_MS = 5 * 60_000;
// Tries at the merge queue's first place come a minute apart for at most this long in a row; then the back-off applies
// again. They never count towards park.stage8MaxTries (independent review of step 2, m5).
export const PARK_HEAD_STREAK_MS = 15 * 60_000;
// A drain request older than this is refused: the Owner decided on the parked batches of that moment (review m10).
export const DRAIN_MAX_AGE_MS = 60 * 60_000;
// Primary/standby C6: an intake pause state that cannot be read or written holds new batches; for longer than this in a
// row it HALTs (like a backfill that keeps failing). An intake request that could not be applied in this many ticks is
// refused, so it never keeps a PAUSE behind it out of the per-tick read (independent review of C6, M1).
export const INTAKE_PAUSE_UNCONFIRMED_MAX_MS = 30 * 60_000;
export const INTAKE_REQUEST_TRIES = 3;
// The oldest bundle a batch takes into the workspace preparation (which accepts at most 2 hours), measured from the
// reservation, which comes before the bundle (design v0.5 §4.3 item 3).
export const BUNDLE_MAX_AGE_AT_WORKSPACE_MS = 100 * 60_000;
// Task 4012c1b9 (DESIGN §37): a batch whose workspace comes this long after its reservation (it waited at parking point A)
// first gets its second and last bundle (build-bundle.ps1 -Rebundle): fresh refs for stage 2's refs gate, and a bundle the
// workspace preparation accepts. The refs must still be the batch's (REMOTE_REFS_CHANGED_SINCE_BUNDLE, a clean transient
// ending); any other refusal ends it as before (PARKED_BUNDLE_TOO_OLD). A batch that never waited is not touched.
export const REBUNDLE_AFTER_MS = 30 * 60_000;
// The status row reason of a batch that rests at parking point A (the hosted wait).
export const PARKED_A_REASON = 'PARKED_A';
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

// The stage-terminal receipt's summary of a stage outcome: codes and flags only.
const outcomeSummary = r => {
  const o = r?.outcome;
  if (!o && r?.brokerNoLaunch !== true) return null;
  return { status: o?.status ?? null, reason: o?.reason ?? null, sideEffects: o?.sideEffects ?? null, safeToRerun: o?.safeToRerun === true, brokerNoLaunch: r?.brokerNoLaunch === true,
    reasonCodes: o?.diagnostic?.reasonCodes ?? [], nativeReasonCodes: o?.diagnostic?.nativeReasonCodes ?? [], ciRetryAfter: o?.scheduling?.ciRetryAfter ?? o?.diagnostic?.ciRetryAfter ?? null,
    mergeQueue: o?.scheduling?.mergeQueue ?? o?.diagnostic?.mergeQueue ?? null };
};

// The ports every executor needs (service-main.mjs builds them; a test checks the service entry passes each one).
export const EXECUTOR_PORTS = Object.freeze(['policy', 'ledger', 'receipts', 'inbox', 'requests', 'owner', 'engine', 'companion', 'sourceIntegrity', 'clock', 'executedHeads', 'queue']);

export class ResidentExecutor {
  // ports: { policy, ledger, receipts, inbox, requests, owner, engine, companion, sourceIntegrity, clock, executedHeads, queue }
  //   owner: an Inbox over the admin-only owner directory (only Administrators can create files there).
  //   executedHeads: executed-heads.mjs#ExecutedHeads (Source-independent "may have published" heads and the backfill).
  //   sleep (optional): the wait between abort polls and quiescence re-checks.
  //   status (optional): status.mjs#StatusBoard (a view; nothing the executor decides ever reads it).
  //   intakePause (optional): intake-pause.mjs#IntakePause; opened from the ledger's state directory when not given.
  //   versions (optional): async () -> { view, notices } (status.mjs#readVersionState; DESIGN §34): status /7 `versions`, the
  //     upgrade notices and the version-skew hold. Without it the executor shows no versions and holds nothing for them.
  constructor(ports) {
    //   queue: queue.mjs#RunQueue (the run queue and the breaker's state; a view the ledger always overrules).
    for (const k of EXECUTOR_PORTS) check(ports[k], 'EXECUTOR_PORT_MISSING', k);
    Object.assign(this, ports);
    this.sleep ??= ms => new Promise(r => setTimeout(r, ms));
    this.status ??= NO_STATUS;
    this.ownerReadFailures = new Map();
    this.intakeRequestFailures = new Map();
    this.deferralReceipts = new Set(); // `${reason}:${day}` of the global deferrals already receipted (deferral())
    this.roleProbe = new RoleProbe();
    this.roleProbeNotices = [];
    this.revocationBook = new RevocationMaintenanceBook();
    // C3: every start begins UNCERTAIN (behaves like STANDBY) with the probe due at once; nothing is taken from before the start.
    this.roleProbeMode = 'UNCERTAIN';
    this.roleProbe.markUrgent();
    this.reportNode();
  }

  // ---- the node mode (primary/standby C3; DESIGN §29) ----

  // The mode only exists for an engine that can probe the role (the real Windows engine does). Without it the executor is the
  // single node it always was: no gate, no status node, no mode changes.
  probing() { return typeof this.engine.runRoleProbe === 'function'; }

  // An unknown value is UNCERTAIN: fail safe.
  nodeMode() { return NODE_MODES.includes(this.roleProbeMode) ? this.roleProbeMode : 'UNCERTAIN'; }

  reportNode() {
    if (this.probing()) this.report(s => s.setNode?.(this.policy.node.nodeName, this.policy.ciSourceManifestSha256, this.nodeMode()));
  }

  // The mode is in force before its receipt is written (the receipt is the record, not a condition).
  async setNodeMode(to, why) {
    const from = this.nodeMode();
    if (!this.probing() || from === to) return false;
    this.roleProbeMode = to;
    this.reportNode();
    try { await this.receipt('node-mode', { from, to, why }); } catch { /* see above */ }
    return true;
  }

  // The same beginning as a start (an Owner re-arm cleared a HALT): UNCERTAIN, probe due at once.
  async nodeRestart(why) {
    this.roleProbe.markUrgent();
    await this.setNodeMode('UNCERTAIN', why);
  }

  // null while this node may start batches; otherwise the deferral the schedule returns.
  nodeGate() {
    if (!this.probing()) return null;
    const mode = this.nodeMode();
    return mode === 'ACTIVE' ? null : { state: 'DEFERRED', reason: mode === 'STANDBY' ? NODE_DEFERRALS.STANDBY : NODE_DEFERRALS.UNCERTAIN };
  }

  receipt(type, body) { return this.receipts.append(type, body); }

  // The status board is a view: a failure to update it never changes what the executor does.
  report(fn) { try { fn(this.status); } catch { /* advisory */ } }
  reportOutcome(subject, outcome, { code = null, row = null, key = null } = {}) {
    this.report(s => s.outcome({ pr: subject?.pr, headSha: subject?.headSha, attempt: subject?.attempt ?? 1, outcome, code, klass: row?.class ?? null, retry: row?.retry ?? null, key }));
  }

  async haltWith(code, facts) {
    if (await this.ledger.halt(code, facts)) await this.receipt('halt', { failureCode: code, facts });
  }

  // Crash recovery runs at the start of every tick, halted or not. At that point this single-threaded
  // loop has no batch in flight, so any open entry was left by a crash or an aborted tick: its
  // processes may still exist, so it is UNKNOWN and HALT is latched (once).
  async recover() {
    // A batch that only waits for hosted signals runs nothing: it is resumed by tick(), never a crash scene.
    const open = await this.ledger.crashed();
    // A stage R that began (20-plan-intent) without its 25-plan may have begun a relay key: UNKNOWN, HALT. An entry
    // with an accepted Owner abort and no terminal was interrupted in the middle of the abort: UNKNOWN, HALT.
    // An entry with the executor's own 81-self-abort and no terminal was interrupted in the middle of that end (phase 2).
    const codeFor = entry => (entry.planIntent && !entry.plan ? 'RELAY_STAGE_INTERRUPTED' : entry.abort ? 'OWNER_ABORT_INTERRUPTED' : entry.selfAbort ? 'SUPERSEDE_INTERRUPTED' : 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH');
    // HALT is latched BEFORE any terminal or quarantine write, so no crash point can leave a closed
    // failure without a HALT (N1).
    const haltCode = ['RELAY_STAGE_INTERRUPTED', 'OWNER_ABORT_INTERRUPTED', 'SUPERSEDE_INTERRUPTED'].find(c => open.some(e => codeFor(e) === c)) ?? 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH';
    if (open.length > 0) await this.haltWith(haltCode, { keys: open.map(e => e.key) });
    for (const entry of open) {
      let closed = false;
      const failureCode = codeFor(entry);
      if (entry.state !== 'UNREADABLE') {
        try {
          await this.ledger.burnHead(entry.key, { failureCode });
          await this.ledger.terminal(entry.key, 'FAILED_UNKNOWN', { failureCode, state: entry.state });
          closed = true;
        } catch (error) {
          // Only a content problem (the terminal record exists but cannot be read, or cannot be
          // written because a torn one is in the way) leads to quarantine; anything transient
          // propagates and is retried by the next tick under RECOVERY_UNCONFIRMED.
          if (!(error instanceof ResidentError)) throw error;
        }
      }
      if (closed) {
        await this.receipt('batch-terminal', { key: entry.key, outcome: 'FAILED_UNKNOWN', failureCode });
      } else {
        // Moved, intact, out of the way so the ledger is never wedged (review M6e); its head is burned
        // and re-arm must still archive its scene before HALT can clear.
        const kept = await this.ledger.quarantine(entry.key, { failureCode: 'LEDGER_ENTRY_UNREADABLE', state: entry.state });
        await this.receipt('batch-quarantined', { key: entry.key, failureCode: 'LEDGER_ENTRY_UNREADABLE', kept: path.basename(kept) });
      }
    }
  }

  // Owner requests. Their authority is the directory ACL (only Administrators, i.e. the Owner's
  // elevated token, can create files in it); each request names the exact HALT / PAUSE bytes the Owner
  // reviewed, so a stale or replayed request fails the compare-and-swap. Processed requests are
  // remembered by digest and never acted on twice.
  async takeOwnerRequests() {
    for (const entry of await this.owner.read(8, 2048)) {
      if (!entry.bytes) {
        // A read can fail transiently (the elevated writer may still hold its CreateNew handle), so
        // the name is used up only after three failed reads in this process.
        const n = (this.ownerReadFailures.get(entry.name) ?? 0) + 1;
        this.ownerReadFailures.set(entry.name, n);
        if (n < 3) continue;
        await this.receipt('owner-request-refused', { failureCode: entry.refused ?? 'OWNER_REQUEST_REFUSED', name: entry.name });
        await this.owner.remember(entry.name, null);
        continue;
      }
      const requestSha256 = sha256(entry.bytes);
      if (await this.owner.seen(requestSha256)) {
        await this.receipt('owner-request-duplicate', { requestSha256, name: entry.name });
        await this.owner.remember(entry.name, requestSha256);
        continue;
      }
      let outcome, abortKey = null;
      try {
        const v = parseBoundedJson(entry.bytes, 2048, 'OWNER_REQUEST_REFUSED');
        // Every request carries its own time and nonce, so a retry after a refusal is a new request.
        if (v.contract === RESUME_CONTRACT) {
          exactKeys(v, ['contract', 'pausedSha256', 'by', 'requestedAt', 'nonce'], 'OWNER_REQUEST_REFUSED');
          check(HEX64.test(v.pausedSha256) && SID.test(v.by) && NONCE.test(v.nonce) && !Number.isNaN(Date.parse(v.requestedAt)), 'OWNER_REQUEST_REFUSED');
          await this.ledger.resume(v.pausedSha256, v.by);
          outcome = { kind: 'resume' };
        } else if (v.contract === UPGRADE_RESUME_CONTRACT) {
          // The upgrader's resume (DESIGN §34): the same compare-and-swap on the PAUSED.json bytes, its own receipt.
          validateUpgradeResume(v);
          await this.ledger.resume(v.pausedSha256, UPGRADE_RESUMED_BY);
          outcome = { kind: 'upgrade-resume', pausedSha256: v.pausedSha256, opId: v.opId, generation: v.generation };
        } else if (v.contract === REARM_CONTRACT) {
          exactKeys(v, ['contract', 'haltSha256', 'reason', 'by', 'requestedAt', 'nonce'], 'OWNER_REQUEST_REFUSED');
          check(HEX64.test(v.haltSha256) && SID.test(v.by) && NONCE.test(v.nonce) && !Number.isNaN(Date.parse(v.requestedAt))
            && typeof v.reason === 'string' && v.reason.length > 0 && v.reason.length <= 200, 'OWNER_REQUEST_REFUSED');
          outcome = { kind: 'rearm', ...(await this.rearm(v)) };
        } else if (v.contract === ABORT_CONTRACT) {
          abortKey = validateAbortRequest(v).batchKey;
          outcome = { kind: 'abort', ...(await this.abortAtTickStart(v, requestSha256, entry.name)) };
        } else if (v.contract === DRAIN_CONTRACT) {
          exactKeys(v, ['contract', 'reason', 'by', 'requestedAt', 'nonce'], 'OWNER_REQUEST_REFUSED');
          check(SID.test(v.by) && NONCE.test(v.nonce) && !Number.isNaN(Date.parse(v.requestedAt)) && typeof v.reason === 'string' && v.reason.length > 0 && v.reason.length <= 200, 'OWNER_REQUEST_REFUSED');
          outcome = { kind: 'drain', ...(await this.drainParked(v, requestSha256, entry.name)) };
        } else {
          check(false, 'OWNER_REQUEST_REFUSED');
        }
        // A concluded abort has its terminal record and batch receipts; a failed summary receipt is no refusal of it.
        if (outcome.kind === 'abort') { try { await this.receipt('owner-request', { requestSha256, ...outcome }); } catch { /* see above */ } }
        else if (outcome.kind === 'upgrade-resume') { const { kind, ...facts } = outcome; await this.receipt('upgrade-resumed', { requestSha256, ...facts }); }
        else await this.receipt('owner-request', { requestSha256, ...outcome });
      } catch (error) {
        // An abort whose acceptance names this very request in 80-owner-abort but was not concluded cleanly is no
        // refusal: the entry is still open (the gate below HALTs this tick and the next tick's recovery closes the
        // batch), or it is closed UNKNOWN (half-way acceptance; OWNER_ABORT_INTERRUPTED after a restart). Only its own
        // clean conclusion, FAILED_CLEAN OWNER_ABORTED, is settled.
        let accepted = false;
        try {
          const s = abortKey !== null ? await this.ledger.state(abortKey) : null;
          accepted = s?.abort?.requestSha256 === requestSha256
            && !(s.state === 'TERMINAL' && s.outcome === 'FAILED_CLEAN' && s.terminal?.facts?.failureCode === OWNER_ABORTED);
        } catch { accepted = false; }
        await this.receipt(accepted ? 'owner-abort-unconfirmed' : 'owner-request-refused', { requestSha256, failureCode: codeOf(error), ...archiveFacts(error) });
      }
      await this.owner.remember(entry.name, requestSha256);
    }
  }

  // Re-arm, performed by the service itself with its own limited rights: prove quiescence on both
  // hosts now, archive what the halted batch left (rename only), then clear HALT by CAS.
  async rearm({ haltSha256, reason, by }) {
    const halt = await this.ledger.halted();
    check(halt && halt.sha256 === haltSha256, 'HALT_CHANGED_SINCE_REVIEW');
    const windows = await this.engine.windowsQuiescence(null);
    const linux = await this.companion.linuxQuiescence(null);
    check(windows.windowsTreeZero === true && windows.serviceOriginalStopped === true && linux.linuxUnitsInactive === true && linux.containersZero === true, 'REARM_REQUIRES_QUIESCENCE_ON_BOTH_HOSTS');
    // Archive the scene of EVERY failed-unknown batch not archived yet, wherever the HALT came from
    // (a stage, recovery after a crash, a loop exception), not only a key named in the HALT facts
    // (review M6c). Each one is marked so a later re-arm does not repeat it; a repeat is harmless
    // anyway (the Windows tool finds nothing; the Linux tool returns the earlier verified result).
    // The archive reason is FIXED (never derived from a failure code): a code that happened to start
    // with "between-roles" would otherwise select the protocol-only Linux scope (third review, MAJOR 1).
    const code = 'rearm-unknown-failure';
    const archived = [];
    for (const q of await this.ledger.quarantinedUnarchived()) {
      const batch = { key: q.key, batchId: q.batchId };
      const w = await this.engine.archiveFailure(batch, 'rearm-quarantine');
      archiveCheck(w && w.verified === true, 'REARM_WINDOWS_ARCHIVE_UNCONFIRMED', w);
      const l = await this.companion.archiveLinux(batch, 'rearm-quarantine');
      check(l && l.verified === true, 'REARM_LINUX_ARCHIVE_UNCONFIRMED');
      await this.ledger.markQuarantineArchived(q.marker, { windows: w.directory, linux: l.directory, haltSha256 });
      archived.push(q.key);
    }
    for (const entry of await this.ledger.unknownUnarchived()) {
      const batch = { key: entry.key, batchId: entry.started?.facts?.batchId ?? entry.terminal?.facts?.batchId ?? null };
      const w = await this.engine.archiveFailure(batch, code);
      archiveCheck(w && w.verified === true, 'REARM_WINDOWS_ARCHIVE_UNCONFIRMED', w);
      let l = null;
      if (batch.batchId) {
        l = await this.companion.archiveLinux(batch, code);
        check(l && l.verified === true, 'REARM_LINUX_ARCHIVE_UNCONFIRMED');
      }
      await this.ledger.markArchived(entry.key, { windows: w.directory, linux: l?.directory ?? null, haltSha256 });
      archived.push(entry.key);
    }
    const kept = await this.ledger.clearHalt(haltSha256, { by, reason, archived });
    // C3: a HALT may have been the end of anything; the role is asked again before this node takes a trigger.
    await this.nodeRestart('rearm');
    return { haltSha256, archived, haltKeptAs: path.basename(kept) };
  }

  // ---- Owner abort (DESIGN §6.5) ----

  // Phase 2, step 2: the Owner's drain request (before a reinstall: the uninstall refuses an open batch). Every batch at a
  // parking point ends on the Owner abort's path, one by one, each with its own 80-owner-abort naming this request.
  // The Owner abort's guards hold for every entry (independent review of step 2, M1): recovery done, the installed bytes
  // unchanged, and no unarchived scene of another batch (the owner-aborted archive is full scope on both hosts). It stops
  // at the first ending that is not a clean OWNER_ABORTED.
  async drainParked(v, requestSha256, name) {
    check(this.recoveredThisTick !== false, 'OWNER_DRAIN_RECOVERY_UNCONFIRMED');
    const age = this.clock() - Date.parse(v.requestedAt);
    check(age >= -5 * 60_000 && age <= DRAIN_MAX_AGE_MS, 'OWNER_DRAIN_REQUEST_STALE');
    const integrity = await this.sourceIntegrity();
    check(integrity && integrity.ok === true && integrity.sourceManifestSha256 === this.policy.sourceManifestSha256
      && integrity.residentManifestSha256 === this.policy.residentManifestSha256, 'OWNER_DRAIN_SOURCE_DRIFT');
    const ended = [], entries = await this.ledger.parkedEntries();
    let stoppedBy = null, unconfirmed = null;
    for (const e of entries) {
      if ((await this.ledger.unarchivedScenes()) > 0) {
        check(ended.length > 0, 'OWNER_DRAIN_UNARCHIVED_SCENE_PRESENT');
        stoppedBy = 'OWNER_DRAIN_UNARCHIVED_SCENE_PRESENT';
        break;
      }
      const batch = Ledger.parkedAt(e) ? e.parked.batch : e.wait.batch;
      const safePoint = Ledger.parkedAt(e) ? 'parked' : 'waiting';
      let request;
      try {
        request = await this.acceptAbort(e.key, { name, requestSha256, value: { by: v.by, reason: v.reason, ledgerEntrySha256: null } }, safePoint, null);
      } catch (error) {
        if (!(await this.ledger.state(e.key)).abort) {
          // Nothing accepted for this entry: a refusal when it is the first, else the drain stops and says what it ended
          // (re-review of step 2, N9).
          if (ended.length === 0) throw error;
          stoppedBy = codeOf(error);
          break;
        }
        let r;
        try {
          r = await this.unknown(e.key, codeOf(error), 'owner-drain-unconfirmed', batch, { safePoint, stage: null, requestSha256, ...archiveFacts(error) });
        } catch (inner) {
          // After an earlier entry ended, a failure here is no refusal of the request: the drain stops and says what it
          // ended and which entry is unconfirmed (still open, or ended without its summary). This tick stops HALTed either
          // way: by the code written first on the way, or at the OWNER_ABORT_UNCONFIRMED gate after the Owner's requests
          // (final check of step 2, n6).
          if (ended.length === 0) throw inner;
          stoppedBy = codeOf(inner); unconfirmed = e.key;
          break;
        }
        ended.push({ key: e.key, outcome: r.state, failureCode: r.failureCode });
        break;
      }
      let r;
      try {
        r = await this.afterBatch(e.reserved.subject, e.reserved.origin ?? 'queued', await this.ownerAbort(e.key, batch, { safePoint, request }));
      } catch (error) {
        // The same for the Owner abort's own path on a later entry (n6).
        if (ended.length === 0) throw error;
        stoppedBy = codeOf(error); unconfirmed = e.key;
        break;
      }
      ended.push({ key: e.key, outcome: r.state, failureCode: r.failureCode });
      if (!(r.state === 'FAILED_CLEAN' && r.failureCode === OWNER_ABORTED)) break;
    }
    return { ended, remaining: entries.length - ended.length, stoppedBy, ...(unconfirmed ? { unconfirmed } : {}) };
  }

  // Safe point P0, a tick start: nothing of this executor runs, so the only open entries recovery leaves are batches at a
  // parking point (A, the hosted wait; B, before stage 8). Any other target is refused and recorded.
  async abortAtTickStart(v, requestSha256, name) {
    const s = await this.ledger.state(v.batchKey);
    check(['RESERVED', 'STARTED'].includes(s.state), 'OWNER_ABORT_BATCH_NOT_OPEN');
    check(!s.abort, 'OWNER_ABORT_ALREADY_ACCEPTED');
    check(Ledger.resumable(s), 'OWNER_ABORT_NOT_AT_SAFE_POINT');
    // The owner-aborted archive is a full-scope one on both hosts: it must never take another batch's unarchived
    // scene with it. Such a scene keeps the executor halted; the Owner re-arms first (review M6).
    check((await this.ledger.unarchivedScenes()) === 0, 'OWNER_ABORT_UNARCHIVED_SCENE_PRESENT');
    // The archive tools run from the installed Source: never from drifted bytes (a HALT may be a RESIDENT_SOURCE_DRIFT).
    const integrity = await this.sourceIntegrity();
    check(integrity && integrity.ok === true && integrity.sourceManifestSha256 === this.policy.sourceManifestSha256
      && integrity.residentManifestSha256 === this.policy.residentManifestSha256, 'OWNER_ABORT_SOURCE_DRIFT');
    const latest = await this.ledger.latestRecord(v.batchKey);
    check(latest && latest.sha256 === v.ledgerEntrySha256, 'OWNER_ABORT_LEDGER_CHANGED_SINCE_REVIEW');
    let request;
    try {
      request = await this.acceptAbort(v.batchKey, { name, requestSha256, value: v }, Ledger.parkedAt(s) ? 'parked' : 'waiting', null);
    } catch (error) {
      // Nothing accepted: a plain refusal. Accepted half-way (80-owner-abort written): UNKNOWN, HALT now (review M1).
      if (!(await this.ledger.state(v.batchKey)).abort) throw error;
      const r = await this.unknown(v.batchKey, codeOf(error), 'owner-abort-unconfirmed', Ledger.parkedAt(s) ? s.parked.batch : s.wait.batch, { safePoint: Ledger.parkedAt(s) ? 'parked' : 'waiting', stage: null, requestSha256, ...archiveFacts(error) });
      return { key: v.batchKey, outcome: r.state, failureCode: r.failureCode };
    }
    const parkedB = Ledger.parkedAt(s);
    const r = await this.afterBatch(s.reserved.subject, s.reserved.origin ?? 'queued',
      await this.ownerAbort(v.batchKey, parkedB ? s.parked.batch : s.wait.batch, { safePoint: parkedB ? 'parked' : 'waiting', request }));
    return { key: v.batchKey, outcome: r.state, failureCode: r.failureCode };
  }

  // The Owner's abort of THIS batch, looked for at a safe point inside a tick. Other Owner requests, and aborts of
  // other batches, stay for the next tick's takeOwnerRequests. A malformed or stale abort of this batch is refused
  // and recorded here. A read failure is "no abort yet": the next safe point looks again.
  async pendingAbort(key) {
    let entries;
    try { entries = await this.owner.read(OWNER_SCAN_MAX, 2048); } catch { return null; }
    for (const entry of entries) {
      if (!entry.bytes) continue;
      let v;
      try { v = parseBoundedJson(entry.bytes, 2048, 'OWNER_REQUEST_REFUSED'); } catch { continue; }
      if (v?.contract !== ABORT_CONTRACT || v.batchKey !== key) continue;
      const requestSha256 = sha256(entry.bytes);
      try {
        const s = await this.ledger.state(key);
        // A torn record (for example a half-written 80-owner-abort): nothing to decide here; the stage's end handles it.
        if (s.state === 'UNREADABLE') return null;
        // Accepted before (an interrupted acceptance in this tick): the same request continues; any other is refused.
        if (s.abort) { check(s.abort.requestSha256 === requestSha256, 'OWNER_ABORT_ALREADY_ACCEPTED'); return { name: entry.name, requestSha256, value: v }; }
        if (await this.owner.seen(requestSha256)) continue; // a copy of a handled request: the next tick records the duplicate
        validateAbortRequest(v);
        const latest = await this.ledger.latestRecord(key);
        check(latest && latest.sha256 === v.ledgerEntrySha256, 'OWNER_ABORT_LEDGER_CHANGED_SINCE_REVIEW');
        return { name: entry.name, requestSha256, value: v };
      } catch (error) {
        try {
          await this.receipt('owner-request-refused', { requestSha256, failureCode: codeOf(error) });
          await this.owner.remember(entry.name, requestSha256);
        } catch { /* the next tick settles it */ }
      }
    }
    return null;
  }

  // 80-owner-abort first (create-only): from here on the batch is never resumed or continued.
  async acceptAbort(key, { name, requestSha256, value }, safePoint, stage) {
    const s = await this.ledger.state(key);
    if (!s.abort) await this.ledger.beginOwnerAbort(key, { requestSha256, ledgerEntrySha256: value.ledgerEntrySha256 ?? null, by: value.by, reason: value.reason, safePoint, stage });
    await this.owner.remember(name, requestSha256);
    await this.receipt('owner-abort-accepted', { key, requestSha256, safePoint, stage });
    return { requestSha256, by: value.by, reason: value.reason };
  }

  // Safe point P1, between steps of a batch: nothing of it runs. Returns the batch outcome, or null to go on.
  async abortIfRequested(key, batch, safePoint) {
    const found = await this.pendingAbort(key);
    if (!found) return null;
    let request;
    try {
      request = await this.acceptAbort(key, found, safePoint, null);
    } catch (error) {
      return this.unknown(key, codeOf(error), 'owner-abort-unconfirmed', batch, { safePoint, stage: null, requestSha256: found.requestSha256, ...archiveFacts(error) });
    }
    return this.concludeAbort(key, batch, { safePoint, request });
  }

  async concludeAbort(key, batch, opts) {
    const r = await this.ownerAbort(key, batch, opts);
    try { await this.receipt('owner-request', { requestSha256: opts.request.requestSha256, kind: 'abort', key, outcome: r.state, failureCode: r.failureCode }); } catch { /* the terminal record and receipt are written */ }
    return r;
  }

  // Safe point P2: a scanner-issuer stage runs while the owner directory is polled. An accepted abort asks the engine
  // to stop the stage (again on every poll until the broker stop is written); the stage then ends through its own
  // stop path and the caller concludes the abort. Every other stage runs as before, to its own end.
  async runStageWatched(key, batch, number, opts) {
    const stage = this.stage(number);
    if (!ABORTABLE_IN_FLIGHT.includes(number) || typeof this.engine.requestStop !== 'function') return { result: await this.engine.runStage(batch, stage, opts), abort: null };
    const watch = this.watchAbort(key, batch, number);
    let result;
    try {
      result = await this.engine.runStage(batch, stage, opts);
    } finally {
      await watch.stop();
    }
    if (watch.state.stop?.broker === true && !watch.state.stopReceipt) {
      try { await this.receipt('owner-abort-stop-requested', { key, stage: number, requestId: watch.state.stop.requestId }); } catch { /* the broker's receipt and the terminal facts remain */ }
    }
    // What the pump observer saw (DESIGN §26), when the poll did not record it while the stage ran.
    try { await this.bridgeReceipts(key, number, bridgeFacts(result?.bridge), watch.state); } catch { /* the stage-terminal receipt carries the same facts */ }
    let abort = watch.state.accepted;
    let unconfirmed = false;
    if (!abort) {
      // An acceptance that wrote 80-owner-abort but not its receipt still aborts: the batch never continues past it.
      // One that left a torn 80-owner-abort (an unreadable entry) is unconfirmed: UNKNOWN, never a publishing stage after
      // it (second independent review, MINOR 1).
      const s = await this.ledger.state(key);
      if (s.abort) abort = adopted(s.abort);
      else if (s.state === 'UNREADABLE') unconfirmed = true;
    }
    // What the broker did with the stop request (its own create-only receipt): only STOP_SENT proves the stage ended
    // through the stop path, which is what admits a missing entry outcome (review M2).
    let stopCode = watch.state.stop?.stopCode ?? null;
    const requestId = watch.state.stop?.requestId ?? null;
    if (abort && requestId && typeof this.engine.stopOutcome === 'function') {
      try { stopCode = (await this.engine.stopOutcome(requestId)) ?? stopCode; } catch { /* unknown: not STOP_SENT */ }
    }
    return { result, abort, stopCode, unconfirmed };
  }

  watchAbort(key, batch, number) {
    const state = { accepted: null, stop: null };
    let stopped = false, wake;
    const stopSignal = new Promise(resolve => { wake = resolve; });
    const running = (async () => {
      while (!stopped) {
        await Promise.race([this.sleep(ABORT_POLL_MS), stopSignal]);
        if (stopped) return;
        try {
          if (!state.accepted) {
            // An acceptance that wrote 80-owner-abort but failed afterwards (its request is already remembered, so the
            // owner directory no longer offers it) is taken from the ledger (review M5).
            const s = await this.ledger.state(key);
            if (s.abort) state.accepted = adopted(s.abort);
            else {
              const found = await this.pendingAbort(key);
              if (found) state.accepted = await this.acceptAbort(key, found, `in-stage-${number}`, number);
            }
          }
          if (state.accepted && state.stop?.done !== true) {
            state.stop = await this.engine.requestStop(batch, number);
          }
          if (state.stop?.broker === true && !state.stopReceipt) {
            await this.receipt('owner-abort-stop-requested', { key, stage: number, requestId: state.stop.requestId });
            state.stopReceipt = true;
          }
          await this.bridgeReceipts(key, number, this.engine.bridgeState?.(batch, number) ?? null, state);
        } catch { /* a failed poll never ends the stage; the next poll tries again */ }
      }
    })();
    return { state, stop: async () => { stopped = true; wake(); await running; } };
  }

  // DESIGN §26: the pump observer's findings, each recorded once: the pump was lost (signal A or D), and the bridge stop was
  // written next to the in-flight swap. Records only; the stage's own ending decides.
  async bridgeReceipts(key, stage, b, state) {
    if (!b) return;
    if (b.pumpCode && !state.bridgePumpLost) {
      await this.receipt('bridge-pump-lost', { key, stage, failureCode: b.pumpCode });
      state.bridgePumpLost = true;
    }
    if (b.stopRequestId && !state.bridgeStop) {
      await this.receipt('bridge-stop-requested', { key, stage, requestId: b.stopRequestId, failureCode: b.pumpCode ?? null });
      state.bridgeStop = true;
    }
  }

  // Quiescence after an abort: the same fresh two-host proof as any failure, re-checked for a bounded time (the Linux
  // worker of a stopped issuer may need its own short way out). Never longer than ABORT_QUIESCENCE_WAIT_MS.
  async abortQuiescence(batch, stageProof) {
    const until = this.clock() + ABORT_QUIESCENCE_WAIT_MS;
    for (let attempt = 1; ; attempt += 1) {
      const proof = await this.proofFor(batch, stageProof);
      if (proofComplete(proof) || attempt >= ABORT_QUIESCENCE_ATTEMPTS || this.clock() >= until) return proof;
      await this.sleep(ABORT_QUIESCENCE_POLL_MS);
    }
  }

  // The abort itself. A stage that was running must have ended through its stop path (or on its own) with an allow-
  // listed ending and the Windows half of the cleanup proof; then quiescence on both hosts, a rename-only archive with
  // the fixed reason owner-aborted, and FAILED_CLEAN OWNER_ABORTED (the head stays burned, never an attempt 2).
  // Anything unproven is UNKNOWN exactly as today: HALT, burned head, the scene left for the Owner's re-arm.
  async ownerAbort(key, batch, { safePoint, stage = null, result = null, request, stopCode = null }) {
    const context = { safePoint, stage, stopCode: typeof stopCode === 'string' && CODE.test(stopCode) ? stopCode : null, requestSha256: request?.requestSha256 ?? null };
    try {
      if (result && !abortStageEndingClean(result, { stopSent: stopCode === 'STOP_SENT' })) return await this.unknown(key, validCode(result.code ?? 'OWNER_ABORT_STAGE_UNCONFIRMED'), 'owner-abort-stage-not-stopped-cleanly', batch, context);
      const closed = await this.provenCleanEnd(key, batch, { stageProof: result?.proof ?? {}, reason: OWNER_ABORT_ARCHIVE_REASON, failureCode: OWNER_ABORTED, burn: true,
        facts: (windows, linux) => ({ failureCode: OWNER_ABORTED, basis: 'owner-abort-quiescence-proven', safePoint, stage,
          stageCode: result && result.ok !== true ? validCode(result.code) : null, stopCode: typeof stopCode === 'string' && CODE.test(stopCode) ? stopCode : null,
          batchId: batch?.batchId ?? null, windows, linux, requestSha256: request.requestSha256 }),
        receipt: { safePoint } });
      if (!closed) return await this.unknown(key, 'OWNER_ABORT_QUIESCENCE_UNPROVEN', 'owner-abort-quiescence-unproven', batch, context);
      try { this.reportOutcome((await this.ledger.state(key)).reserved?.subject, 'FAILED_CLEAN', { code: OWNER_ABORTED, key }); } catch { /* advisory */ }
      return { state: 'FAILED_CLEAN', key, failureCode: OWNER_ABORTED, safePoint, settle: { kind: 'burned', code: OWNER_ABORTED, klass: 'abort', breaker: 'neutral', pos: null } };
    } catch (error) {
      return this.unknown(key, codeOf(error), 'owner-abort-unconfirmed', batch, { ...context, ...archiveFacts(error) });
    }
  }

  // The proven clean end the Owner abort and the scanner abandonment share (DESIGN §6.5, §27): quiescence on both hosts within
  // the abort's bounded re-check, the head burned (unless the caller already did), a rename-only archive on both hosts with a
  // fixed reason, then the FAILED_CLEAN terminal record and its batch-terminal receipt. null: quiescence unproven, nothing
  // written (the caller HALTs with its own code). An archive or record that cannot be confirmed throws (the caller HALTs).
  // A crash anywhere in it leaves STARTED without a terminal: the next tick's recovery HALTs.
  async provenCleanEnd(key, batch, { stageProof, reason, failureCode, burn, facts, receipt }) {
    const proof = await this.abortQuiescence(batch, stageProof);
    if (!proofComplete(proof)) return null;
    if (burn) await this.ledger.burnHead(key, { failureCode });
    const windows = await this.engine.archiveFailure(batch, reason);
    const linux = await this.companion.archiveLinux(batch, reason);
    archiveCheck(windows && windows.verified === true && linux && linux.verified === true, 'FAILURE_ARCHIVE_UNCONFIRMED', windows);
    await this.ledger.terminal(key, 'FAILED_CLEAN', facts(windows.directory, linux.directory));
    await this.receipt('batch-terminal', { key, outcome: 'FAILED_CLEAN', failureCode, ...receipt });
    return { windows: windows.directory, linux: linux.directory };
  }

  // Pause requests may come from the user session: stopping is always allowed, resuming is not.
  // A pause takes effect between batches; a running batch is never interrupted or killed.
  // The same directory carries the intake pause's requests (pause or resume of one holder, takeIntakeRequest).
  async takePauseRequests() {
    for (const entry of await this.requests.read(this.policy.limits.inboxMaxFiles, 1024)) {
      let disposition = 'rejected';
      if (entry.bytes) {
        try {
          const v = parseBoundedJson(entry.bytes, 1024, 'PAUSE_REQUEST_REFUSED');
          if ([INTAKE_PAUSE_CONTRACT, INTAKE_RESUME_CONTRACT].includes(v?.contract)) {
            disposition = await this.takeIntakeRequest(v, sha256(entry.bytes));
          } else {
            exactKeys(v, ['contract', 'reason'], 'PAUSE_REQUEST_REFUSED');
            const ok = v.contract === PAUSE_CONTRACT && typeof v.reason === 'string' && v.reason.length <= 200;
            if (ok && await this.ledger.pause({ reason: v.reason, requestSha256: sha256(entry.bytes) })) await this.receipt('paused', { reason: v.reason, requestSha256: sha256(entry.bytes) });
            disposition = ok ? 'processed' : 'rejected';
          }
        } catch { disposition = 'rejected'; }
      }
      // null: an intake request whose state could not be read or written stays and is read again next tick, at most
      // INTAKE_REQUEST_TRIES times; then it is refused with a receipt.
      if (disposition !== null) this.intakeRequestFailures.delete(entry.name);
      else {
        const n = (this.intakeRequestFailures.get(entry.name) ?? 0) + 1;
        this.intakeRequestFailures.set(entry.name, n);
        if (n < INTAKE_REQUEST_TRIES) continue;
        this.intakeRequestFailures.delete(entry.name);
        try { await this.receipt('intake-request-refused', { requestSha256: sha256(entry.bytes), failureCode: 'INTAKE_PAUSE_UNCONFIRMED' }); } catch { /* refused anyway */ }
        disposition = 'rejected';
      }
      await this.requests.dispose(entry.name, disposition);
    }
  }

  // ---- the intake pause (primary/standby C6; intake-pause.mjs, DESIGN §20) ----

  // Opened once, from the ledger's state directory unless a port gave it. A state file that did not validate was kept
  // aside and holds for two hours; its receipt is written here.
  async intakeHolds() {
    if (this.intakePause) return this.intakePause;
    const p = await IntakePause.open(this.ledger.root, this.clock);
    this.intakePause = p;
    if (p.unreadable) { try { await this.receipt('intake-pause-unreadable', { keptAs: p.unreadable.keptAs, until: p.data.holds[0].until }); } catch { /* the hold is in force */ } }
    return p;
  }

  // Settles the state (holds that ran out are marked, one receipt each; an end too far ahead is capped) and returns the
  // status board's view (null: nothing held). An I/O error starts or continues a spell of trouble (intakeTrouble) and is
  // thrown. A read error's spell ends with the next good read; a write error's only with the next good write (a state
  // that can be read but not written cannot take the Owner's hold), so while one lasts every refresh writes the state
  // again as a probe (independent re-review of C6, new major). A receipt that cannot be written never undoes a state
  // already written.
  async intakeRefresh() {
    let p, next;
    try { p = await this.intakeHolds(); next = p.settle(this.clock()); } catch (error) { await this.intakeTrouble(error, 'read'); throw error; }
    if (!next && this.intakeTroubleSince != null && this.intakeTroubleKind === 'write') next = { data: p.data, ended: [] };
    if (next) {
      try { await p.save(next.data); } catch (error) { await this.intakeTrouble(error, 'write'); throw error; }
      this.intakeTroubleSince = null;
      for (const h of next.ended) { try { await this.receipt('intake-pause-ended', { holder: h.holder, since: h.since, until: h.until, ending: 'expired' }); } catch { /* see above */ } }
    } else if (this.intakeTroubleKind === 'read') this.intakeTroubleSince = null;
    return p.view(this.clock());
  }

  // A spell of trouble with the intake pause state: no new batch (fail safe), the status shows a hold of
  // UNCONFIRMED_HOLDER (so nothing reads the node as on duty), one receipt per spell, and a spell of
  // INTAKE_PAUSE_UNCONFIRMED_MAX_MS HALTs, from the gate only (mayHalt), so nothing else of that tick runs after the HALT
  // (re-review, new minor). error: the error that starts or continues it (kind 'read' or 'write'); null only asks where
  // the spell stands. Returns { view, halted }.
  async intakeTrouble(error, kind = 'read', { mayHalt = false } = {}) {
    const now = this.clock();
    const code = error instanceof ResidentError && CODE.test(error.code) ? error.code : 'INTAKE_PAUSE_STATE_UNAVAILABLE';
    if (error && this.intakeTroubleSince == null) {
      this.intakeTroubleSince = now;
      this.intakeTroubleKind = kind;
      try { await this.receipt('intake-pause-unconfirmed', { failureCode: code, kind }); } catch { /* the gate holds anyway */ }
    } else if (error && kind === 'write') this.intakeTroubleKind = 'write';
    const since = new Date(this.intakeTroubleSince).toISOString();
    let halted = false;
    if (mayHalt && now - this.intakeTroubleSince >= INTAKE_PAUSE_UNCONFIRMED_MAX_MS) {
      try { await this.haltWith('INTAKE_PAUSE_STATE_UNAVAILABLE', { phase: 'intake-pause', failureCode: code, since }); halted = true; } catch { /* the gate holds anyway */ }
    }
    return { view: { until: null, holders: [{ holder: UNCONFIRMED_HOLDER, since, until: null }] }, halted };
  }

  // One intake request: 'processed' (applied, with its receipt), 'rejected' (refused, with its receipt), or null when the
  // state could not be read or written (the request is read again next tick; one that did take effect is then refused
  // as superseded, never applied twice).
  async takeIntakeRequest(v, requestSha256) {
    try { await this.intakeRefresh(); } catch { return null; }
    let next;
    try {
      next = this.intakePause.apply(v, requestSha256, this.clock());
    } catch (error) {
      await this.receipt('intake-request-refused', { requestSha256, failureCode: codeOf(error) });
      return 'rejected';
    }
    try { await this.intakePause.save(next.data); } catch (error) { await this.intakeTrouble(error, 'write'); return null; }
    this.intakeTroubleSince = null; // a good write ends any spell
    const { kind, ...facts } = next.result;
    // Applied: a receipt that cannot be written does not make it a refusal (independent review of C6, minor 6).
    try { await this.receipt(kind, { requestSha256, ...facts, reason: v.reason }); } catch { /* the request took effect */ }
    return 'processed';
  }

  // null: a new batch may start. Otherwise the deferral: a hold in force, or a state that cannot be read now (fail safe,
  // bounded by intakeTrouble's HALT).
  async intakeGate() {
    let view = null;
    try { view = await this.intakeRefresh(); } catch { /* a spell of trouble: below */ }
    if (this.intakeTroubleSince != null) {
      const t = await this.intakeTrouble(null, 'read', { mayHalt: true });
      return t.halted ? { state: 'HALTED', failureCode: 'INTAKE_PAUSE_STATE_UNAVAILABLE' } : { state: 'DEFERRED', reason: 'INTAKE_PAUSE_UNCONFIRMED' };
    }
    return view ? { state: 'DEFERRED', reason: 'INTAKE_PAUSED', until: Date.parse(view.until) } : null;
  }

  async tick() {
    if (this.tickBusy) return { state: 'DEFERRED', reason: 'EXECUTOR_TICK_BUSY' };
    this.tickBusy = true;
    try { const result = await this.tickInner(); await this.reportTick(result); return result; }
    finally { this.tickBusy = false; }
  }

  // The status board after a tick: the resting state, HALT and PAUSE as the ledger has them now, and the intake pause's
  // holds (also while halted or paused: a hold runs out by its clock whatever the executor does).
  async reportTick(result) {
    try {
      const halt = await this.ledger.halted();
      const paused = await this.ledger.paused();
      let intake;
      try { intake = { intakePause: await this.intakeRefresh() }; } catch { intake = {}; }
      if (this.intakeTroubleSince != null) intake = { intakePause: (await this.intakeTrouble(null)).view };
      const state = ['IDLE', 'RUNNING', 'WAITING', 'PARKED', 'DEFERRED', 'HALTED', 'PAUSED', 'BACKFILL_PENDING', 'COMPLETED', 'FAILED_CLEAN', 'NOT_ADMITTED', 'NOT_EXECUTED', 'IGNORED'].includes(result?.state) ? result.state : 'IDLE';
      this.report(s => {
        s.setState(halt ? 'HALTED' : state, halt ? (halt.value?.code ?? null) : (result?.reason ?? result?.failureCode ?? null));
        s.update({ halt: halt ? { code: CODE.test(halt.value?.code ?? '') ? halt.value.code : 'HALT_RECORD_UNREADABLE', at: halt.value?.at ?? null } : null, paused: !!paused, ...intake, train: { enabled: this.policy.train.enabled, last: this.trainLast ?? null } });
        if (!['WAITING'].includes(result?.state)) s.setCurrent(null);
      });
      if (typeof this.versions === 'function') this.report(s => s.setVersions?.(this.versionState?.view ?? null));
      this.reportQueue();
      this.reportNode();
    } catch { /* advisory */ }
  }

  // ---- the versions of both sides and the version-skew hold (in-place upgrade channel, Task 018da927, DESIGN §34) ----

  // Once a tick, right after the Owner's requests: the versions port (service-main.mjs: status.mjs#readVersionState over
  // upgrade\current.json, upgrade\mailbox\responses\version-facts.json and upgrade\status.json) gives { view, notices } for the
  // status board, and the view's consistent decides the hold. Without the port (a test, an engine of its own) nothing changes.
  async versionsRefresh() {
    if (typeof this.versions !== 'function') return null;
    let state = null;
    try { state = await this.versions(); } catch { state = null; }
    this.versionState = state && typeof state === 'object' ? { view: state.view ?? null, notices: Array.isArray(state.notices) ? state.notices : [] } : null;
    try { await this.versionSkewHold(this.versionState?.view?.consistent ?? null); } catch { /* the next tick tries again; the engine's gate still holds */ }
    return this.versionState;
  }

  // The precheck's gate (DESIGN §34.5): true only when a fresh read says the sides disagree; a read that fails is unknown.
  async versionSkewNow() {
    if (typeof this.versions !== 'function') return false;
    try { return (await this.versions())?.view?.consistent === false; } catch { return false; }
  }

  // consistent false: hold new batches (holder version-skew, two hours, renewed below 90 minutes left); true: lift that hold;
  // null (unknown: no current.json, facts older than 15 minutes, unreadable): leave it as it is. The hold is the executor's own
  // word in the intake pause (intake-pause.mjs#apply), so PAUSE, HALT and the other holders are untouched and the Owner may
  // still lift it by hand (it then comes back on the next tick while the versions still disagree). Returns the receipt kind written.
  async versionSkewHold(consistent) {
    if (consistent !== true && consistent !== false) return null;
    try { await this.intakeRefresh(); } catch { return null; }
    const p = this.intakePause, now = this.clock();
    const hold = p.active(now).find(h => h.holder === VERSION_SKEW_HOLDER) ?? null;
    const word = { holder: VERSION_SKEW_HOLDER, requestedAt: new Date(now).toISOString(), nonce: randomBytes(8).toString('hex') };
    let request;
    if (consistent === false) {
      if (hold && Date.parse(hold.until) - now >= VERSION_SKEW_RENEW_BELOW_MS) return null;
      request = { contract: INTAKE_PAUSE_CONTRACT, ...word, minutes: INTAKE_PAUSE_MAX_MINUTES, reason: UPGRADE_VERSION_SKEW };
    } else {
      if (!hold) return null;
      request = { contract: INTAKE_RESUME_CONTRACT, ...word, reason: 'VERSIONS_CONSISTENT' };
    }
    const requestSha256 = digest(request);
    const next = p.apply(request, requestSha256, now);
    try { await p.save(next.data); } catch (error) { await this.intakeTrouble(error, 'write'); return null; }
    this.intakeTroubleSince = null;
    const { kind, ...facts } = next.result;
    try { await this.receipt(kind, { requestSha256, ...facts, reason: request.reason }); } catch { /* the hold took effect */ }
    return kind;
  }

  // Resident quota redesign v0.6 §9 phase 1, items 6 and 7: on the first start of an install, before any batch, every
  // earlier ledger (this state and the state the install carried forward) is read into the Source-independent executed
  // heads. Done once (BACKFILL-COMPLETE.json). A refused source (manifest missing or malformed, a carried file missing
  // or changed) HALTs: no batch may run without it. A transient I/O error only defers it to the next tick, for at most
  // BACKFILL_PENDING_MAX_MS since the first failure in a row; then it HALTs too (independent review of phase 1, MINOR 6:
  // a lasting EPERM must not keep rereading every carried file forever).
  async ensureBackfill() {
    let marker;
    try {
      if (await this.executedHeads.backfilled()) return null;
      this.report(s => s.update({ backfill: { complete: false, published: null, unreadable: null } }));
      marker = await this.executedHeads.backfill();
    } catch (error) {
      this.backfillPendingSince ??= this.clock();
      if (!(error instanceof ResidentError) && this.clock() - this.backfillPendingSince < BACKFILL_PENDING_MAX_MS) return { state: 'BACKFILL_PENDING' };
      const code = error instanceof ResidentError ? codeOf(error) : 'EXECUTED_HEADS_BACKFILL_UNAVAILABLE';
      await this.haltWith(code, { phase: 'executed-heads-backfill', pendingSince: new Date(this.backfillPendingSince).toISOString() });
      this.backfillPendingSince = null;
      return { state: 'HALTED', failureCode: code };
    }
    this.backfillPendingSince = null;
    await this.receipt('executed-heads-backfilled', { published: marker.published, unreadable: marker.unreadable,
      sources: marker.sources.map(s => ({ name: s.name, heads: s.heads, published: s.published, unreadable: s.unreadable })) });
    this.report(s => s.update({ backfill: { complete: true, published: marker.published, unreadable: marker.unreadable } }));
    return null;
  }

  async tickInner() {
    let recovered = true;
    try {
      await this.recover();
    } catch {
      // Recovery itself failed: fail safe, but still read the Owner's requests below (review M6e).
      recovered = false;
      try { await this.ledger.halt('RECOVERY_UNCONFIRMED', {}); } catch { /* reported by the loop */ }
    }
    this.recoveredThisTick = recovered;
    await this.takeOwnerRequests();
    // DESIGN §34: the versions of both sides, and the version-skew hold, before anything is scheduled.
    await this.versionsRefresh();
    // The run queue follows the ledger for any row a crash or an earlier tick left marked running (a view: also while
    // halted, so the status shows what the ledger says).
    try { await this.reconcileQueue(); } catch { /* the next tick */ }
    // An Owner abort whose acceptance failed half-way would leave an open entry that is no resumable wait: nothing else
    // runs in this tick, and the next tick's recovery closes it FAILED_UNKNOWN (independent review of v0.8, M1).
    const stuck = recovered ? await this.ledger.crashed() : [];
    if (stuck.length > 0) {
      await this.haltWith('OWNER_ABORT_UNCONFIRMED', { keys: stuck.map(e => e.key) });
      return { state: 'HALTED' };
    }
    // A stage-10 run that a crash or a stop interrupted (once per process; DESIGN §22.3). Looked at before the HALT check,
    // so one found while halted is closed at once and the Owner's re-arm clears a single HALT (review of 3c-1, round 2).
    const train = recovered ? await this.trainRecover() : null;
    const probe = recovered ? await this.roleProbeRecover() : null;
    const revocationRecovery = recovered ? await this.revocationMaintenanceRecover() : null;
    if (revocationRecovery) return revocationRecovery;
    // Qualified safety maintenance may revoke old work while CI is halted or
    // paused. It neither clears that latch nor starts a PR/batch, and its
    // pre-broker engine guards still require the actual helper/SCM to be idle.
    if (recovered) {
      const originalHalt=await this.ledger.halted();
      const maintenance=await this.revocationMaintenance({halted:!!originalHalt});
      if(maintenance)return originalHalt?{...maintenance,state:'HALTED',failureCode:originalHalt.value?.code??null}:maintenance;
    }
    // Even if the HALT itself could not be written, an unconfirmed recovery never runs a candidate,
    // and neither does a ledger with an unarchived failed-unknown or quarantined scene (N1).
    if (!recovered || await this.ledger.halted()) return train?.state === 'HALTED' ? train : { state: 'HALTED' };
    if ((await this.ledger.unarchivedScenes()) > 0) {
      await this.haltWith('UNARCHIVED_FAILURE_SCENE', {});
      return { state: 'HALTED' };
    }
    // A held stage 10 (its receipt chain could not be read yet): no batch either.
    if (train) return train;
    if (probe) return probe;
    // No batch of any kind (a resumed wait, an attempt 2, a new trigger) before the executed-heads backfill finished.
    const backfill = await this.ensureBackfill();
    if (backfill) return backfill;
    await this.takePauseRequests();
    if (await this.ledger.paused()) return { state: 'PAUSED' };
    // Triggers go into the run queue first (phase 2, step 1); the queue then follows the ledger for any row a crash left
    // marked running.
    await this.intake();
    // Batches at a parking point go first (design v0.5 §4.3 step 3): each one waiting for hosted signals is evaluated
    // once (and continues to its end when it may), a parked one whose stage-8 try is due runs that try. They are
    // re-evaluated only here, after recovery, the Owner's requests, HALT and PAUSE. Then the queue.
    const { acted, waiting } = await this.resumeParked();
    if (acted) return acted;
    // Nothing else to do: the tick rests in the hosted wait (the status keeps showing it).
    const r = await this.schedule();
    // A batch resting at parking point A stays the tick's result (and the status's current batch) while only the intake
    // pause holds the new ones (independent review of C6, minor 3).
    const result = waiting && (r.state === 'IDLE' || [...TRAIN_HELD_REASONS, ...Object.values(NODE_DEFERRALS)].includes(r.reason)) ? waiting : r;
    // Stage 10 only after a schedule that ran nothing (a batch resting at a parking point runs nothing either). The role probe
    // also while a batch rests at A, when it may be run at a parking point (probeAtParking, DESIGN §29.2 item 5).
    if ((!waiting || this.probeAtParking()) && TRAIN_QUIET_STATES.includes(r.state) && !TRAIN_HELD_REASONS.includes(r.reason)) {
      const probeResult = await this.roleProbeMaintenance();
      if (probeResult) return probeResult;
    }
    if (TRAIN_QUIET_STATES.includes(r.state) && !TRAIN_HELD_REASONS.includes(r.reason)) return (await this.trainMaintenance()) ?? result;
    return result;
  }

  // C2 recovery is independent of CI accounting. An interrupted swap still HALTs; it never authorizes
  // a second swap or clears any head/scene. A bad public receipt cannot become a fresh role observation.
  async roleProbeRecover() {
    if (this.roleProbeRecovered || typeof this.engine.runRoleProbe !== 'function') return null;
    try {
      const rows = await this.receipts.latest(['role-probe-intent', 'role-probe-result'], 2), last = rows.at(-1);
      if (last?.type === 'role-probe-intent') {
        await this.haltWith('ROLE_PROBE_INTERRUPTED', { intentSeq: last.seq });
        await this.receipt('role-probe-result', { intentSeq: last.seq, deferred: false, ok: false, fact: null, state: this.roleProbe.snapshot() });
        return { state: 'HALTED', failureCode: 'ROLE_PROBE_INTERRUPTED' };
      }
      if (last) {
        check(rows.length === 2 && rows[0].type === 'role-probe-intent' && last.value.body.intentSeq === rows[0].seq, 'ROLE_PROBE_BOOK_REFUSED');
        this.roleProbe.restore(last.value.body.state);
      }
      this.roleProbeRecovered = true;
    } catch {
      await this.haltWith('ROLE_PROBE_RECEIPTS_UNCONFIRMED', {});
      return { state: 'HALTED', failureCode: 'ROLE_PROBE_RECEIPTS_UNCONFIRMED' };
    }
    return null;
  }

  // Whether the role probe may run while batches rest at a parking point (A or B). Nothing of such a batch runs: no process, no
  // broker request, Linux empty; ticks are serial, so the probe's swap cannot meet a stage of this executor. C2 still kept the
  // periodic probe of an ACTIVE node away from every open batch (a parked one may rest for a day); but a node that is not ACTIVE
  // must be able to leave UNCERTAIN, and an urgent probe (the role may be gone) must not wait for the parked batches to end:
  // after a restart or a re-arm the batches parked before it would otherwise keep the node UNCERTAIN for park.maxMs.
  probeAtParking() { return this.probing() && (this.nodeMode() !== 'ACTIVE' || this.roleProbe.urgent === true); }

  async roleProbeMaintenance() {
    if (typeof this.engine.runRoleProbe !== 'function' || this.roleProbeRunning) return null;
    // C3 owns the mode and all its transitions (DESIGN §29); status (advisory) is never an input. UNCERTAIN has STANDBY's
    // 15-minute interval, and `urgent` (a start, a re-arm, a failure that may mean the role is gone) is due at once.
    const mode = this.nodeMode(), now = this.clock();
    // Idle: no HALT, no PAUSE and no batch open; entries at a parking point do not count when probeAtParking() says so.
    const open = await this.ledger.open();
    const idle = !(await this.ledger.halted()) && !(await this.ledger.paused()) && (this.probeAtParking() ? open.every(e => Ledger.resumable(e)) : open.length === 0);
    if (!this.roleProbe.due({ now, mode: mode === 'ACTIVE' ? 'ACTIVE' : 'STANDBY', idle })) return null;
    if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < now + 240_000) return null;
    const drift = await this.driftCode();
    if (drift) { await this.haltWith(drift, { phase: 'role-probe' }); return { state: 'HALTED', failureCode: drift }; }
    this.roleProbeRunning = true;
    try {
      const intent = await this.receipt('role-probe-intent', { mode, urgent: this.roleProbe.urgent === true });
      let r;
      try { r = await this.engine.runRoleProbe(); } catch { r = null; }
      // Only the engine's pre-broker busy guard is a deferral, not a role fact. BROKER_BUSY after a
      // request is not whitelisted here and retains the original unknown/HALT behavior.
      const deferred = r?.deferred === true && r.code === 'ROLE_PROBE_BUSY';
      let fact = null;
      if (r?.ok === true && r.proof?.windowsTreeZero === true && r.proof?.serviceOriginalStopped === true
        && r.outcome?.status === 'BLOCKED' && r.outcome.sideEffects === 0 && r.outcome.mayHavePublished === false) {
        try { const f = validateRoleProbeFact(r.roleProbe); if (r.outcome.reason === f.code) fact = f; } catch { /* no fact */ }
      }
      if (!deferred && !fact) await this.haltWith('ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED', { intentSeq: intent.seq, failureCode: r?.code ?? null });
      if (fact) {
        const observation = this.roleProbe.observe(fact, this.clock());
        this.roleProbeNotices.push(...observation.notices);
        this.roleProbeNotices = this.roleProbeNotices.slice(-10);
        this.report(s => s.setRoleProbe?.(this.policy.node.nodeName, observation.probe));
        // not-held is the safe direction and takes effect first; held only after the result is recorded. uncertain changes nothing.
        if (fact.result === 'not-held') await this.setNodeMode('STANDBY', 'probe-not-held');
      }
      await this.receipt('role-probe-result', { intentSeq: intent.seq, deferred, ok: !!fact, fact, state: this.roleProbe.snapshot() });
      if (fact?.result === 'held') await this.setNodeMode('ACTIVE', 'probe-held');
      return !deferred && !fact ? { state: 'HALTED', failureCode: 'ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED' } : null;
    } finally { this.roleProbeRunning = false; }
  }

  async revocationMaintenanceRecover() {
    if(typeof this.engine.runRevocationMaintenance!=='function')return null;
    if(this.revocationRecovered)return this.revocationBook.blocked?{state:'HALTED',failureCode:'REVOCATION_MAINTENANCE_INTERRUPTED'}:null;
    try{
      const rows=await this.receipts.latest(['revocation-maintenance-intent','revocation-maintenance-result'],2),last=rows.at(-1);
      if(last?.type==='revocation-maintenance-intent'){
        this.revocationBook.blocked=true;
        await this.haltWith('REVOCATION_MAINTENANCE_INTERRUPTED',{intentSeq:last.seq});
        // Leave the actual intent open. No new helper is dispatched until a
        // separately authorized recovery proves and closes the old execution.
        return {state:'HALTED',failureCode:'REVOCATION_MAINTENANCE_INTERRUPTED'};
      }
      if(last){
        const intent=rows[0]?.value?.body,result=last.value?.body;
        check(rows.length===2&&rows[0].type==='revocation-maintenance-intent'&&result?.intentSeq===rows[0].seq
          &&HEX64.test(intent?.runKey??'')&&REVOCATION_RUN_ID.test(intent?.runId??'')&&intent.runId.startsWith(intent.runKey.slice(0,16))
          &&result.runId===intent.runId,'REVOCATION_BOOK_REFUSED');
        this.revocationBook.restore(result.state);
        check(this.revocationBook.lastRunId===intent.runId,'REVOCATION_BOOK_REFUSED');
      }
      this.revocationRecovered=true;
      if(this.revocationBook.blocked){
        await this.haltWith('REVOCATION_MAINTENANCE_INTERRUPTED',{});
        return {state:'HALTED',failureCode:'REVOCATION_MAINTENANCE_INTERRUPTED'};
      }
      return null;
    }catch{
      this.revocationBook.blocked=true;
      await this.haltWith('REVOCATION_MAINTENANCE_RECEIPTS_UNCONFIRMED',{});
      return {state:'HALTED',failureCode:'REVOCATION_MAINTENANCE_RECEIPTS_UNCONFIRMED'};
    }
  }

  async revocationMaintenance({halted}) {
    if(!this.revocationRecovered||this.revocationBook.blocked||typeof this.engine.runRevocationMaintenance!=='function'
      ||typeof this.engine.revocationMaintenanceQualification!=='function'||!this.revocationBook.due(this.clock()))return null;
    const now=this.clock();let qualification;
    try{
      qualification=validateRevocationQualification(await this.engine.revocationMaintenanceQualification(),{
        sourceManifestSha256:this.policy.ciSourceManifestSha256,now});
    }catch{return null;} // No exact Source qualification: retain the existing CI/HALT behavior.
    if(halted&&!qualification.allowWhileHalted)return null;
    if(this.policy.validUntil!==null&&Date.parse(this.policy.validUntil)<=now+REVOCATION_RUN_MS+REVOCATION_HELPER_MARGIN_MS)return null;
    const drift=await this.driftCode();
    if(drift){await this.haltWith(drift,{phase:'revocation-maintenance'});return {state:'HALTED',failureCode:drift};}
    const runKey=randomBytes(32).toString('hex'),runId=`${runKey.slice(0,16)}-${randomBytes(6).toString('hex')}`;
    let intent;
    try{intent=await this.receipt('revocation-maintenance-intent',{runKey,runId,qualificationRef:qualification.qualificationRef,
      sourceManifestSha256:qualification.sourceManifestSha256,halted});}
    catch{
      this.revocationBook.blocked=true;this.revocationRecovered=false;
      await this.haltWith('REVOCATION_MAINTENANCE_RECEIPTS_UNCONFIRMED',{});
      return {state:'HALTED',failureCode:'REVOCATION_MAINTENANCE_RECEIPTS_UNCONFIRMED'};
    }
    let result;
    try{result=await this.engine.runRevocationMaintenance({runKey,runId});}catch{result=null;}
    const deferred=result?.deferred===true&&['REVOCATION_MAINTENANCE_BUSY','REVOCATION_MAINTENANCE_NOT_QUALIFIED'].includes(result.code);
    const proven=result?.proof?.windowsTreeZero===true&&result.proof.serviceOriginalStopped===true;
    let facts=null;
    if(!deferred&&result?.ok===true&&proven&&result.runId===runId){
      try{
        facts=validateRevocationFacts(result.revocation);
        check(result.maintenancePending===!facts.complete&&result.outcome?.status===(facts.complete?'REVOCATION_MAINTENANCE':'PENDING')
          &&Number.isSafeInteger(result.outcome.sideEffects)&&result.outcome.sideEffects>=0&&typeof result.outcome.mayHavePublished==='boolean',
        'REVOCATION_FACTS_REFUSED');
      }catch{facts=null;}
    }
    const blocked=!deferred&&!facts;
    if(blocked)await this.haltWith('REVOCATION_MAINTENANCE_CLEANUP_OR_FACT_UNCONFIRMED',{intentSeq:intent.seq,failureCode:validCode(result?.code)});
    const state=this.revocationBook.observe({now:this.clock(),runId,pending:facts?.complete===false,deferred,blocked});
    try{await this.receipt('revocation-maintenance-result',{intentSeq:intent.seq,runId,deferred,ok:!!facts,
      failureCode:blocked?'REVOCATION_MAINTENANCE_CLEANUP_OR_FACT_UNCONFIRMED':null,facts,state});}
    catch{
      this.revocationBook.blocked=true;this.revocationRecovered=false;
      await this.haltWith('REVOCATION_MAINTENANCE_RECEIPTS_UNCONFIRMED',{intentSeq:intent.seq});
      return {state:'HALTED',failureCode:'REVOCATION_MAINTENANCE_RECEIPTS_UNCONFIRMED'};
    }
    if(blocked)return {state:'HALTED',failureCode:'REVOCATION_MAINTENANCE_CLEANUP_OR_FACT_UNCONFIRMED'};
    return {state:deferred||facts?.complete===false?'DEFERRED':'IDLE',reason:deferred?result.code:
      facts.complete?'REVOCATION_MAINTENANCE_COMPLETED':'REVOCATION_MAINTENANCE_PENDING',maintenancePending:facts?.complete===false};
  }

  // ---- stage 10: train maintenance (phase 2, step 3c-1; DESIGN §22.3) ----

  // Once per process, from the receipt chain: the start times of the newest train runs ('train-run-intent'), and an
  // interrupted run (the newest of the two types is an intent: no 'train-run' receipt closed it). The HALT is latched
  // before the closing receipt, so no crash point leaves the interruption without it. A chain that cannot be read holds
  // every batch (the interruption cannot be ruled out): a transient error for at most BACKFILL_PENDING_MAX_MS since the
  // first failure in a row, a refusal at once; then it HALTs (TRAIN_RECEIPTS_UNREADABLE).
  async trainRecover() {
    if (this.trainRuns) return null;
    const max = this.policy.train.maintenanceMaxPerDay;
    let rows;
    try {
      rows = await this.receipts.latest(['train-run-intent', 'train-run'], 2 * max + 1);
    } catch (error) {
      this.trainBookPendingSince ??= this.clock();
      if (!(error instanceof ResidentError) && this.clock() - this.trainBookPendingSince < BACKFILL_PENDING_MAX_MS) return { state: 'DEFERRED', reason: 'TRAIN_RECEIPTS_PENDING' };
      await this.haltWith('TRAIN_RECEIPTS_UNREADABLE', { phase: 'train-maintenance', failureCode: codeOf(error), pendingSince: new Date(this.trainBookPendingSince).toISOString() });
      this.trainBookPendingSince = null;
      return { state: 'HALTED', failureCode: 'TRAIN_RECEIPTS_UNREADABLE' };
    }
    this.trainBookPendingSince = null;
    const last = rows[rows.length - 1];
    if (last?.type === 'train-run-intent') {
      await this.haltWith('TRAIN_STAGE_INTERRUPTED', { phase: 'train-maintenance', intentSeq: last.seq });
      // The HALT holds; a closing receipt that cannot be written now is written by the next start (round 3, NIT 2).
      try {
        await this.receipt('train-run', { intentSeq: last.seq, runId: null, mode: last.value.body?.mode ?? null, ok: false, failureCode: 'TRAIN_STAGE_INTERRUPTED',
          wouldDo: null, frontPr: null, mainSha: null, wouldRevokeCount: null });
      } catch { /* see above */ }
    }
    this.trainRuns = rows.filter(e => e.type === 'train-run-intent').map(e => Date.parse(e.value.at)).filter(Number.isFinite);
    return last?.type === 'train-run-intent' ? { state: 'HALTED', failureCode: 'TRAIN_STAGE_INTERRUPTED' } : null;
  }

  // One train run when it is due (train.mjs#trainDue): not under an intake pause (also with an empty queue, which ends
  // schedule() before its gate; independent review of 3c-1, M1), within the install's authority with the helper's own
  // margin, never below the helper's fixed one (the start-of-batch rule for this one stage; review m2, round 2 NIT 4), from
  // the installed bytes. Returns a HALTED result,
  // or null for any other ending. A failure is clean only with the Windows proof complete, no side effect in a bound
  // outcome, and either an allow-listed clean code (classify.mjs), the engine's own refusal before the broker, or a bound
  // outcome that says so: BLOCKED, or TRAIN_FACTS that ran into the cap after writing it (review m3; round 2, NIT 3).
  async trainMaintenance() {
    const train = this.policy.train;
    if (!this.trainRuns || train.enabled === 'off') return null;
    const now = this.clock();
    this.trainRuns = this.trainRuns.filter(at => at > now - DAY);
    if (!trainDue({ train, now, runs: this.trainRuns, busy: false })) return null;
    const held = await this.intakeGate();
    if (held) return held.state === 'HALTED' ? held : null;
    if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < now + this.policy.stageRunMilliseconds[TRAIN_STAGE - 1] + Math.max(this.policy.limits.stageMarginMs, TRAIN_HELPER_MARGIN_MS)) return null;
    const drift = await this.driftCode();
    if (drift) {
      await this.haltWith(drift, { phase: 'train-maintenance' });
      return { state: 'HALTED', failureCode: drift };
    }
    const intent = await this.receipt('train-run-intent', { mode: train.enabled });
    this.trainRuns.push(now);
    this.report(s => s.setState('RUNNING', 'TRAIN_MAINTENANCE'));
    let r;
    try { r = await this.engine.runTrainStage(train.enabled); } catch (error) { r = { ok: false, code: codeOf(error), proof: null }; }
    const proven = r?.proof?.windowsTreeZero === true && r?.proof?.serviceOriginalStopped === true;
    const o = r?.outcome ?? null;
    const quiet = o === null || (o.sideEffects === 0 && o.mayHavePublished === false);
    const summary = r?.ok === true && quiet ? trainSummary(r.train) : null;
    const failureCode = summary ? null : (r?.ok === true ? 'TRAIN_FACTS_UNCONFIRMED' : validCode(r?.code));
    const clean = proven && quiet && (r?.ok === true || failureCode === 'TRAIN_STAGE_REFUSED' || (o !== null && ['BLOCKED', 'TRAIN_FACTS'].includes(o.status))
      || classifyFailure(failureCode, { ...r.proof, ...TRAIN_LINUX_PROOF }, TRAIN_STAGE).klass === 'CLEAN');
    const haltCode = !proven ? 'TRAIN_STAGE_CLEANUP_UNCONFIRMED' : 'TRAIN_STAGE_OUTCOME_UNCONFIRMED';
    if (!clean) await this.haltWith(haltCode, { phase: 'train-maintenance', intentSeq: intent.seq, failureCode, sideEffects: o?.sideEffects ?? null });
    await this.receipt('train-run', { intentSeq: intent.seq, runId: TRAIN_RUN_ID.test(r?.runId ?? '') ? r.runId : null, mode: train.enabled, ok: summary !== null, failureCode,
      wouldDo: summary?.wouldDo ?? null, frontPr: summary?.front?.pr ?? null, mainSha: summary?.mainSha ?? null, wouldRevokeCount: summary?.wouldRevokeCount ?? null });
    if (summary) this.trainLast = summary;
    return clean ? null : { state: 'HALTED', failureCode: haltCode };
  }

  // ---- parking (phase 2, step 2; DESIGN §18) ----

  // The newest stage-8 try of a parked entry (its 72 record), or null before the first one ended.
  static lastTry(entry) { return entry.tries?.length ? entry.tries[entry.tries.length - 1].ended : null; }

  // A parked batch counts towards park.maxParked when it waits at A, or when its claim was in the merge queue's first two
  // places at its last try (design v0.5 §4.7, review M4); the others are bounded by park.maxParkedOutsideTop2. A batch parked by
  // a transient stage-8 ending (DESIGN §28) has no true place (null): it counts by its assumed place (independent review r3,
  // NIT 2), so it never pushes other batches over the outside bound.
  async parkedCounts(entries = null) {
    const all = entries ?? await this.ledger.parkedEntries();
    let inside = 0, outside = 0;
    for (const e of all) {
      if (Ledger.waitingAt(e)) { inside += 1; continue; }
      const last = ResidentExecutor.lastTry(e);
      const p = Number.isSafeInteger(last?.position) ? last.position : (last?.transient === true ? last.assumedPosition : null);
      if (Number.isSafeInteger(p) && p <= 2) inside += 1; else outside += 1;
    }
    return { inside, outside };
  }

  // When the next stage-8 try of a parked entry is due (a nudge brings it forward, at most every PARK_NUDGE_MS).
  parkedDueAt(e) {
    const last = ResidentExecutor.lastTry(e);
    const at = last ? Date.parse(last.nextAt) : Date.parse(e.parked.at);
    const nudged = this.parkNudges?.get(e.key);
    return Number.isFinite(nudged) ? Math.min(at, nudged) : at;
  }

  // { acted: the result of a parked batch that moved on (it continued, ended, or ran a stage-8 try), waiting: the last
  // still-waiting result when one only waits }.
  async resumeParked() {
    const entries = await this.ledger.parkedEntries();
    // Every batch resting at parking point A, for the status page (Task 4012c1b9, review N4 of step 2): several may wait at
    // once, each shown on its own row as PARKED_A, not only the one in `current`.
    this.parkedA = new Set(entries.filter(x => Ledger.waitingAt(x)).map(x => `${x.reserved?.subject?.pr}:${x.reserved?.subject?.headSha}`));
    // Whether new batches wait for the parking places: shown on the status of every tick, not only one that deferred
    // (re-review of step 2, m8).
    const counts = await this.parkedCounts(entries);
    const outsideMax = this.policy.park.maxParkedOutsideTop2;
    this.parkingFull = counts.inside >= this.policy.park.maxParked || (outsideMax > 0 && counts.outside >= outsideMax);
    if (entries.length === 0) return { acted: null, waiting: null };
    let waiting = null;
    for (const e of entries.filter(x => Ledger.waitingAt(x))) {
      const r = await this.resumeWaiting(e);
      if (r?.state !== 'WAITING') return { acted: r, waiting: null };
      waiting = r;
    }
    // A batch parked at B whose PR got a newer commit ends at its safe point once one live read confirms it (DESIGN 17.4):
    // the newer commit never waits for the parked batch's tries.
    for (const e of entries.filter(x => Ledger.parkedAt(x))) {
      const r = await this.supersededParked(e);
      if (r) return { acted: r, waiting };
    }
    const now = this.clock();
    // park.maxMs holds without a try too (while the retry budget is used up or nothing is due; review m4): the batch ends
    // with its last not-ready code, no stage runs.
    const expired = entries.find(x => Ledger.parkedAt(x) && now - Date.parse(x.parked.at) >= this.policy.park.maxMs);
    if (expired) return { acted: await this.endParkedB(expired, ResidentExecutor.lastTry(expired)?.code ?? 'RESIDENT_QUEUE_HEAD_NOT_REACHED'), waiting };
    const due = entries.filter(x => Ledger.parkedAt(x) && this.parkedDueAt(x) <= now).sort((a, b) => this.parkedDueAt(a) - this.parkedDueAt(b));
    if (due.length === 0) return { acted: null, waiting };
    const usage = await this.ledger.usage(now - DAY);
    if (usage.stage8Retries >= this.policy.park.stage8RetriesPer24h) {
      this.queue.notice({ key: `stage8-budget:${dayKey(now)}`, kind: 'stage8-budget', pr: null, headSha: null, code: 'STAGE8_RETRY_BUDGET_EXHAUSTED' });
      return { acted: null, waiting };
    }
    return { acted: await this.resumeParkedB(due[0]), waiting };
  }

  // A batch parked at B, superseded by a newer commit of its PR (the queue's order, then one live read): ended as
  // SUPERSEDED_AT_SAFE_POINT. Its head published stages 3, 5 and 7 (the terminal says stage 8). null: it stays parked.
  async supersededParked(entry) {
    const { key } = entry, batch = entry.parked.batch, subject = entry.reserved.subject;
    if (!this.newerCommitQueued(subject)) return null;
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: entry.reserved.reservedAt ?? null };
    let outcome;
    try {
      outcome = await this.supersededAfterStart(key, subject, batch, 'parked', POSITIONS[8], 8);
    } catch (error) {
      outcome = await this.unknown(key, codeOf(error), 'executor-exception', batch, archiveFacts(error));
    }
    return outcome ? this.afterBatch(subject, entry.reserved.origin ?? 'queued', outcome) : null;
  }

  // A batch parked at B ends without a try (its time ran out): a Windows-only stage-8 ending, nothing ran.
  async endParkedB(entry, code) {
    const { key } = entry, batch = entry.parked.batch, subject = entry.reserved.subject;
    this.parkNudges?.delete(key);
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: entry.reserved.reservedAt ?? null };
    let outcome;
    try {
      const drift = await this.driftCode();
      outcome = drift ? await this.unknown(key, drift, 'resume-start-checks', batch)
        : await this.fail(key, batch, Object.assign(new StepFailure(8, code, {}, 'stage', entry.plan?.relayed?.length ?? 0), { windowsOnly: true }));
    } catch (error) {
      outcome = await this.unknown(key, codeOf(error), 'executor-exception', batch, archiveFacts(error));
    }
    return this.afterBatch(subject, entry.reserved.origin ?? 'queued', outcome);
  }

  // One stage-8 try of a batch parked at B.
  async resumeParkedB(entry) {
    const { key } = entry, batch = entry.parked.batch, subject = entry.reserved.subject, origin = entry.reserved.origin ?? 'queued';
    this.parkNudges?.delete(key);
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: entry.reserved.reservedAt ?? null };
    let outcome;
    try {
      const drift = await this.driftCode();
      if (drift) return this.afterBatch(subject, origin, await this.unknown(key, drift, 'resume-start-checks', batch));
      // An install authority that ends within one batch budget closes a parked batch neutrally, never a HALT (§4.8).
      if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < this.clock() + batchBudgetMs(this.policy)) {
        outcome = Object.assign(new StepFailure(8, 'PARKED_AUTHORITY_EXPIRING', { windowsTreeZero: true }, 'stage', entry.plan?.relayed?.length ?? 0), { windowsOnly: true });
      } else {
        const startCode = await this.batchStartChecks(subject);
        if (startCode) return this.afterBatch(subject, origin, await this.unknown(key, startCode, 'resume-start-checks', batch));
        outcome = await this.stage8Try(key, subject, batch);
      }
      if (outcome instanceof StepFailure) outcome = await this.fail(key, batch, outcome);
    } catch (error) {
      outcome = await this.unknown(key, codeOf(error), 'executor-exception', batch, archiveFacts(error));
    }
    return this.afterBatch(subject, origin, outcome);
  }

  // Stage 8 as one try. Settled: COMPLETED. Not ready with zero side effects, and neither main moved nor the tries or the
  // time ran out: the try is recorded and the batch rests at B again (PARKED). Anything else: a stage failure as before.
  async stage8Try(key, subject, batch) {
    const s = await this.ledger.state(key);
    const windowsOnly = f => Object.assign(f, { windowsOnly: true }); // only stage 8 ran here (breaker, review m2)
    const unrecorded = await this.beforePublication(key, subject, 8);
    if (unrecorded) { unrecorded.relayedRoles = s.plan?.relayed?.length ?? 0; return windowsOnly(unrecorded); }
    const n = await this.ledger.beginTry(key, { batchId: batch.batchId });
    this.atStage(8, 'stage');
    const control = await this.engine.runStage(batch, this.stage(8), { betweenRoles: false, firstLinux: false });
    await this.receipt('stage-terminal', { key, stage: 8, ok: control.ok === true, failureCode: control.ok ? null : validCode(control.code), factsSha256: control.factsSha256 ?? null, outcome: outcomeSummary(control), try: n });
    const relayed = s.plan?.relayed?.length ?? 0;
    if (control.ok === true) {
      await this.ledger.terminal(key, 'COMPLETED', { batchId: batch.batchId, closed: s.parked.closed ?? null, relayed: s.plan.relayed.map(r => r.role), local: s.parked.local ?? [], tries: n });
      await this.receipt('batch-terminal', { key, outcome: 'COMPLETED' });
      this.reportOutcome(subject, 'COMPLETED', { key });
      // Only stage 8 ran in this step: a Windows-only ending for the breaker (the parking itself told it about the rest).
      return { state: 'COMPLETED', key, relayed: s.plan.relayed.map(r => r.role), local: s.parked.local ?? [], tries: n,
        settle: { kind: 'completed', code: null, klass: null, breaker: 'neutral', pos: POSITIONS.END, linux: false } };
    }
    const o = control.outcome;
    const zero = !!o && o.status === 'BLOCKED' && o.sideEffects === 0 && o.mayHavePublished === false
      && control.proof?.windowsTreeZero === true && control.proof?.serviceOriginalStopped === true;
    const now = this.clock();
    // Step 3a: a rule change on main, or a test merge that is not the tested tree, is the Owner's to know (once a day per
    // code for the rules, once per head for the tree).
    if (STAGE8_OWNER_NOTICE_CODES.includes(control.code)) {
      const perHead = control.code === 'TRAIN_TEST_MERGE_TREE_DIFFERS';
      this.queue.notice({ key: perHead ? `stage8:${control.code}:${subject.pr}:${subject.headSha}` : `stage8:${control.code}:${dayKey(now)}`, kind: 'stage8-rules',
        pr: perHead ? subject.pr : null, headSha: perHead ? subject.headSha : null, code: control.code });
    }
    const queueFact = o?.scheduling?.mergeQueue ?? o?.diagnostic?.mergeQueue ?? null;
    const position = queueFact?.entered === true && Number.isSafeInteger(queueFact.position) ? queueFact.position : null;
    // Tries that found the claim first in the merge queue do not count towards the cap (review m5); a run of them comes a
    // minute apart for PARK_HEAD_STREAK_MS, then on the back-off.
    const before = (s.tries ?? []).filter(t => t.ended);
    const counted = before.filter(t => t.ended.position !== 1).length + (position === 1 ? 0 : 1);
    let streakFrom = now;
    for (let i = before.length - 1; i >= 0 && before[i].ended.position === 1; i--) streakFrom = Date.parse(before[i].ended.at) || streakFrom;
    // The ledger takes at most MAX_TRIES tries: the last one is final whatever the answer (re-review of step 2, m15).
    const final = control.code === 'RESIDENT_BASE_MOVED' || counted >= this.policy.park.stage8MaxTries || n >= MAX_TRIES || now - Date.parse(s.parked.at) >= this.policy.park.maxMs;
    if (zero && STAGE8_NOT_READY_CODES.includes(control.code) && !final) {
      // The back-off follows the counted tries: after a run at the queue's first place the next try is not 2 hours away
      // (re-review N6).
      const backoff = PARK_RETRY_MS[Math.min(Math.max(counted - 1, 0), PARK_RETRY_MS.length - 1)];
      const nextAt = now + (position === 1 && now - streakFrom < PARK_HEAD_STREAK_MS ? PARK_HEAD_RETRY_MS : backoff);
      // Over capacity outside the queue's first two places: end it now rather than hold a slot (§4.9, review n-m9).
      const counts = await this.parkedCounts();
      if (!(Number.isSafeInteger(position) && position <= 2) && counts.outside >= this.policy.park.maxParkedOutsideTop2) {
        await this.ledger.endTry(key, n, { code: control.code, nextAt: new Date(now).toISOString(), position, entered: queueFact?.entered ?? null, ending: 'PARKED_OVER_CAPACITY' });
        return windowsOnly(new StepFailure(8, 'PARKED_OVER_CAPACITY', control.proof, 'stage', relayed));
      }
      await this.ledger.endTry(key, n, { code: control.code, nextAt: new Date(nextAt).toISOString(), position, entered: queueFact?.entered ?? null });
      await this.receipt('stage8-not-ready', { key, try: n, failureCode: control.code, nextAt: new Date(nextAt).toISOString(), position });
      return { state: 'PARKED', key, reason: control.code, until: nextAt, position, tries: n,
        settle: { kind: 'parked', code: control.code, klass: 'queue', breaker: 'neutral', pos: POSITIONS[8], linux: false, nextAt, position } };
    }
    // DESIGN §28: a transient zero-effect ending parks again, at most STAGE8_TRANSIENT_MAX_TRIES times (the next one burns as
    // before). The try records its true place (null when the outcome named none), so it counts towards stage8MaxTries and never
    // as a try at the queue's head; assumedPosition (the last try's place, else 1: the Source reaches this boundary only once the
    // claim was judged at the head) only exempts it from the outside bound and is what the status shows. Its own back-off.
    const transientParks = before.filter(t => t.ended.transient === true).length;
    if (zero && STAGE8_TRANSIENT_PARK_CODES.includes(control.code) && !final && transientParks < STAGE8_TRANSIENT_MAX_TRIES) {
      const last = before.length ? before[before.length - 1].ended : null;
      const assumedPosition = Number.isSafeInteger(position) ? position : Number.isSafeInteger(last?.position) ? last.position
        : Number.isSafeInteger(last?.assumedPosition) ? last.assumedPosition : 1;
      const nextAt = now + STAGE8_TRANSIENT_RETRY_MS[transientParks];
      await this.ledger.endTry(key, n, { code: control.code, nextAt: new Date(nextAt).toISOString(), position, entered: queueFact?.entered ?? null, transient: true, assumedPosition });
      await this.receipt('stage8-transient-parked', { key, try: n, failureCode: control.code, nextAt: new Date(nextAt).toISOString(), position, assumedPosition, park: transientParks + 1 });
      return { state: 'PARKED', key, reason: control.code, until: nextAt, position: assumedPosition, tries: n,
        settle: { kind: 'parked', code: control.code, klass: 'transient', breaker: 'neutral', pos: POSITIONS[8], linux: false, nextAt, position: assumedPosition } };
    }
    return windowsOnly(new StepFailure(8, control.code, control.proof, 'stage', relayed, control));
  }

  // ---- the run queue (phase 2, step 1; queue.mjs) ----

  // A failure to write the queue never changes what a batch did: the queue is a view the ledger overrules. true: written
  // (or nothing to write).
  async persistQueue() { try { await this.queue.save(); return true; } catch { return false; } }

  // The status board's queue, breaker and notices (a view; nothing the executor decides reads it).
  reportQueue() {
    this.report(s => {
      const b = breakerOf(this.queue.breaker);
      s.update({ queue: { generation: this.queue.generation, live: this.queue.live().length, depth: this.policy.limits.queueDepth, parkingFull: this.parkingFull === true }, breaker: breakerView(b),
        notices: [...(this.versionState?.notices ?? []), ...this.roleProbeNotices, ...this.queue.notices].slice(0, 50) });
      const parkedA = this.parkedA ?? new Set();
      s.setPending(this.queue.view(this.clock(), { etaBatchMs: ETA_BATCH_MS })
        .map(r => r.state === 'RUNNING' && parkedA.has(`${r.pr}:${r.headSha}`) ? { ...r, reason: PARKED_A_REASON } : r));
    });
  }

  // Every trigger in the inbox (bounded per tick) is read into the queue, which numbers it on arrival and decides what
  // it changes (queue.mjs#offer). The queue is written before the triggers are consumed: a crash in between only reads
  // them again, and a second reading of the same trigger changes nothing.
  async intake() {
    const now = this.clock();
    const done = [], nudges = [];
    for (const entry of await this.inbox.read(this.policy.limits.inboxMaxFiles, 1024)) {
      const bytesSha256 = entry.bytes ? sha256(entry.bytes) : null;
      if (!entry.bytes) { done.push({ name: entry.name, disposition: 'rejected', receipt: ['trigger-rejected', { failureCode: entry.refused, bytesSha256 }] }); continue; }
      let t;
      try { t = parseTrigger(entry.bytes, this.policy); } catch (error) {
        done.push({ name: entry.name, disposition: 'rejected', receipt: ['trigger-rejected', { failureCode: codeOf(error), bytesSha256 }] });
        continue;
      }
      const r = this.queue.offer(t, now, { depth: this.policy.limits.queueDepth, cooldownMs: this.policy.limits.unexecutedCooldownMs });
      if (r.action === 'refused') {
        this.queue.notice({ key: `queue-full:${dayKey(now)}`, kind: 'queue-full', pr: null, headSha: null, code: r.code });
        done.push({ name: entry.name, disposition: 'rejected', receipt: ['trigger-refused', { failureCode: r.code, pr: t.pr, headSha: t.headSha, bytesSha256 }] });
        continue;
      }
      if (r.action === 'new-trigger') this.queue.notice({ key: `poke:${t.pr}:${t.headSha}`, kind: 'new-trigger', pr: t.pr, headSha: t.headSha, code: null });
      nudges.push({ t, seen: r.action === 'seen' });
      done.push({ name: entry.name, disposition: r.action === 'seen' ? 'ignored' : 'processed',
        receipt: ['trigger-queued', { pr: t.pr, headSha: t.headSha, baseSha: t.baseSha, action: r.action, seq: r.seq ?? null, bytesSha256 }] });
    }
    await this.nudgeParked(nudges, now);
    if (this.queue.rebuilt && !this.queueRebuiltReported) {
      await this.receipt('queue-rebuilt', { keptAs: this.queue.rebuilt.keptAs, generation: this.queue.generation });
      this.queueRebuiltReported = true;
    }
    if (done.length === 0) return;
    // Consumed only once the queue holding them is on disk: otherwise they stay in the inbox and are read again (a second
    // reading changes nothing; independent review m6). Triggers refused before the queue saw them never wait for it, and
    // a queue that cannot be written for QUEUE_SAVE_ALARM ticks in a row is told once (re-review N2).
    const saved = await this.persistQueue();
    if (!saved) {
      this.queueSaveFailures = (this.queueSaveFailures ?? 0) + 1;
      if (this.queueSaveFailures === QUEUE_SAVE_ALARM) {
        this.queue.notice({ key: `queue-unsaved:${dayKey(now)}`, kind: 'queue-unsaved', pr: null, headSha: null, code: 'QUEUE_SAVE_UNCONFIRMED' });
        try { await this.receipt('queue-save-failed', { failureCode: 'QUEUE_SAVE_UNCONFIRMED', ticks: this.queueSaveFailures }); } catch { /* the notice stays */ }
      }
    } else this.queueSaveFailures = 0;
    for (const d of done) {
      if (!saved && d.disposition !== 'rejected') continue;
      await this.inbox.dispose(d.name, d.disposition);
      await this.receipt(...d.receipt);
    }
  }

  // Phase 2, step 2: a trigger with a main tip this parked batch has not been nudged for (main moved), or a new trigger of
  // the parked batch's own PR (its author edited the PR after joining the merge queue), makes that batch's next stage-8
  // try due now, at most every PARK_NUDGE_MS. A re-read of a trigger already seen nudges for neither its PR nor an old
  // base (independent review of step 2, m7). Only a hint: the try itself reads main and the queue; it never stops anything.
  async nudgeParked(triggers, now) {
    if (triggers.length === 0) return;
    let entries;
    try { entries = (await this.ledger.parkedEntries()).filter(e => Ledger.parkedAt(e)); } catch { return; }
    this.parkNudges ??= new Map();
    this.parkNudgedAt ??= new Map();
    this.parkNudgeBase ??= new Map();
    for (const e of entries) {
      const s = e.reserved.subject;
      // The main tip comes from the poller (its triggers carry prUpdatedAt); an Agent's trigger may name any base. Each tip
      // nudges a batch once (re-review of step 2, m7: alternating stale bases nudged every 5 minutes).
      const nudged = this.parkNudgeBase.get(e.key) ?? [];
      const moved = triggers.find(({ t }) => t.prUpdatedAt !== null && t.baseSha !== s.baseSha && !nudged.includes(t.baseSha));
      const edited = triggers.some(({ t, seen }) => t.pr === s.pr && !seen);
      if (!moved && !edited) continue;
      if (now - (this.parkNudgedAt.get(e.key) ?? -Infinity) < PARK_NUDGE_MS) continue;
      if (moved) this.parkNudgeBase.set(e.key, [...nudged, moved.t.baseSha].slice(-32));
      this.parkNudgedAt.set(e.key, now);
      this.parkNudges.set(e.key, now);
    }
  }

  // A row the queue still shows running, while no batch of this executor runs (a tick start), follows the ledger: a
  // resumable wait stays running, an ended batch settles, a reservation that is gone (released) is queued again.
  async reconcileQueue() {
    let changed = false;
    for (const row of this.queue.data.rows.filter(r => r.running)) {
      const { headSha, key } = row.running;
      let s;
      try { s = await this.ledger.state(key); } catch { continue; }
      if (['RESERVED', 'STARTED', 'INCOMPLETE', 'UNREADABLE'].includes(s.state)) continue;
      const kind = s.state === 'TERMINAL' ? (s.outcome === 'COMPLETED' ? 'completed' : 'burned') : 'released';
      // Released (moved to ledger-unexecuted): its own record says whether it was a wait.
      const release = kind === 'released' ? (await this.ledger.unexecutedRecords(key, 0).catch(() => [])).at(-1) ?? null : null;
      this.queue.settle(row.pr, headSha, { kind, code: s.terminal?.facts?.failureCode ?? null, klass: s.terminal?.facts?.class ?? release?.klass ?? null, reason: release?.reason ?? 'RECONCILED' }, this.clock());
      changed = true;
    }
    if (changed) await this.persistQueue();
  }

  // One scheduling pass (design v0.5 §4.3; v0.6 §7 minor 4): a due attempt 2 first, then the queue's due waits and
  // poked rows, then first come, first served. A row that is only deferred for itself, or ignored, never blocks the
  // rows behind it; a global deferral (the daily limits, the companion, the breaker) ends the pass.
  async schedule() {
    const now = this.clock();
    this.queue.compact(now);
    const b = breakerOf(this.queue.breaker);
    this.queue.breaker = b;
    const attempts = (await this.ledger.pendingAttempts2()).filter(a => a.notBefore <= now);
    const rows = this.queue.candidates(now);
    this.reportQueue();
    if (attempts.length === 0 && rows.length === 0) { await this.persistQueue(); return { state: 'IDLE' }; }
    // The node gate (C3, DESIGN §29): no new batch of any kind unless this node is ACTIVE, and before the intake pause, so a node
    // that is not ACTIVE shows why and still runs the role probe. Triggers were read already; a batch in flight went on.
    const notActive = this.nodeGate();
    if (notActive) { await this.persistQueue(); return notActive; }
    // The intake pause (C6, DESIGN §20): no new batch of any kind while a hold is in force. The batches in flight and at a
    // parking point were already resumed by tickInner; nothing of theirs waits for this gate.
    const held = await this.intakeGate();
    if (held) { await this.persistQueue(); return held; }
    // No new batch while park.maxParked batches rest at A or in the queue's first two places at B: a new one could not
    // park (design v0.5 §4.7). A due attempt 2 is a batch too.
    // Nor while the bound outside those places is full: a new batch would run its whole zone and end PARKED_OVER_CAPACITY
    // at its first try (independent review of step 2, m9). A bound of 0 parks nothing outside them and blocks nothing.
    const entries = await this.ledger.parkedEntries();
    const counts = await this.parkedCounts(entries);
    const outsideMax = this.policy.park.maxParkedOutsideTop2;
    if (counts.inside >= this.policy.park.maxParked || (outsideMax > 0 && counts.outside >= outsideMax)) {
      await this.persistQueue();
      return { state: 'DEFERRED', reason: 'PARKING_FULL' };
    }
    const gate = breakerGate(b, now);
    if (!gate.allow) {
      await this.persistQueue();
      this.reportQueue();
      return { state: 'DEFERRED', reason: 'BREAKER_OPEN', until: gate.until };
    }
    // One trial at a time: while a batch rests at parking point A, a half-open breaker starts none (review m11).
    if (gate.trial && entries.some(e => Ledger.waitingAt(e))) {
      await this.persistQueue();
      return { state: 'DEFERRED', reason: 'BREAKER_TRIAL_PENDING' };
    }
    let list = [...attempts.map(a => ({ pr: a.subject.pr, attempt2: a })), ...rows.map(c => ({ pr: c.pr, row: c }))];
    // A trial never picks the rows that just failed, unless nothing else is there (it never locks for good).
    if (gate.trial) {
      const others = list.filter(x => !gate.exclude.includes(x.pr));
      if (others.length > 0) list = others;
    }
    this.tickUsage = await this.ledger.usage(now - DAY);
    const u = this.tickUsage, l = this.policy.limits;
    this.report(s => s.update({ limits: { batches24h: u.started, maxBatches: l.maxBatchesPer24h, evaluations24h: u.evaluations, maxEvaluations: l.maxEvaluationsPer24h,
      waitingRetries24h: u.waitingRetries, maxWaitingRetries: l.waitingRetriesPer24h } }));
    let last = null, evaluationsFull = null;
    for (const item of list.slice(0, ROWS_PER_TICK)) {
      // A full evaluation budget stops only what it bounds: the due waits behind it still run (independent review m1).
      if (evaluationsFull && item.row?.origin !== 'waiting-retry') continue;
      const r = item.attempt2 ? await this.runAttempt2(item.attempt2, u) : await this.runRow(item.row, u);
      if (r.state === 'DEFERRED' && r.reason === 'DAILY_EVALUATION_LIMIT') { evaluationsFull = r; continue; }
      if (r.next === true) { last ??= r; continue; }
      await this.persistQueue();
      this.reportQueue();
      return r;
    }
    if (evaluationsFull) last = evaluationsFull;
    await this.persistQueue();
    this.reportQueue();
    return last ?? { state: 'IDLE' };
  }

  // Pre-checks that need no secret and no network. Anything that fails here leaves the ledger untouched.
  //   usage: ledger.mjs#usage for the last 24 hours; origin: how the queue picked the subject (queue.mjs#ORIGINS).
  // A deferral with perRow waits for this row only; any other one ends the scheduling pass.
  async precheck(key, hk, subject, { attempt1Key = null, usage, origin = 'queued' } = {}) {
    const now = this.clock();
    const l = this.policy.limits;
    if (await this.ledger.headBurned(hk)) return { ignore: 'HEAD_ALREADY_EXECUTED_NO_RETRY' };
    // A head that may have published a check under ANY Source or attempt (executed-heads.mjs) never runs again: a new
    // Source would otherwise run it as new and stop at ROLE_ALREADY_PUBLISHED_ON_HEAD (2026-10-22, Note 1550fef8). The
    // one exception: attempt 2 of the same head, when the only record is attempt 1's own "before stage R" one (stage R
    // relayed nothing, or attempt 2 would never have been scheduled). attempt 1's own ledger must say so too.
    if (await this.executedHeads.published(subject)
      && !(attempt1Key && await this.executedHeads.onlyRelayRecordOf(subject, attempt1Key, RELAY_STAGE) && await this.relayedNothing(attempt1Key))) return { ignore: 'HEAD_ALREADY_PUBLISHED_NO_RETRY' };
    if ((await this.ledger.state(key)).state !== 'ABSENT') return { ignore: 'CONTENT_ALREADY_EXECUTED_NO_RETRY' };
    // DESIGN §34.5: while the two sides run different versions (consistent false, read now) nothing is reserved: a global
    // deferral, the PR pays nothing for the node's skew. Unknown (null) or no versions port: as before.
    if (await this.versionSkewNow()) return { defer: VERSION_SKEW };
    // The 10-minute cool-down of the batch key after a release it applies to (classify.mjs#UNEXECUTED_REASON_RULES).
    const recent = (await this.ledger.unexecutedRecords(key, now - DAY)).filter(r => UNEXECUTED_REASON_RULES[r.reason]?.cooldown !== false);
    if (recent.length > 0 && now - Math.max(...recent.map(r => r.at)) < l.unexecutedCooldownMs) return { defer: 'UNEXECUTED_COOLDOWN', perRow: true, until: Math.max(...recent.map(r => r.at)) + l.unexecutedCooldownMs };
    // The daily budgets (policy /4), all from the ledger: executions, evaluations (not for a wait: it has its own
    // budget), the waits' budget, the new-trigger re-evaluations of this PR commit, the PR's own executions.
    if (usage.started >= l.maxBatchesPer24h) return { defer: 'DAILY_BATCH_LIMIT', notice: { key: `batch-limit:${dayKey(now)}`, kind: 'batch-limit', pr: null, headSha: null, code: 'DAILY_BATCH_LIMIT' } };
    if (origin !== 'waiting-retry' && usage.evaluations >= l.maxEvaluationsPer24h) return { defer: 'DAILY_EVALUATION_LIMIT' };
    if (origin === 'waiting-retry' && usage.waitingRetries >= l.waitingRetriesPer24h) {
      return { defer: 'WAITING_BUDGET_EXHAUSTED', perRow: true, notice: { key: `waiting-budget:${dayKey(now)}`, kind: 'waiting-budget', pr: null, headSha: null, code: 'WAITING_BUDGET_EXHAUSTED' } };
    }
    if (origin === 'new-trigger' && (usage.reevaluations.get(`${subject.pr}:${subject.headSha}`) ?? 0) >= l.reevaluationsPerPrHeadPer24h) return { defer: 'REEVALUATION_CAP', perRow: true, dropPoke: true };
    if ((usage.startedByPr.get(subject.pr) ?? 0) >= l.perPrBatchesPer24h) return { defer: 'PR_DAILY_BATCH_LIMIT', perRow: true };
    // The head's release cap (design v0.5 §4.5: at most releasesPerHeadPer24h releases a day) from the ledger, so a queue
    // that started over never forgets it (independent review m4). A wait, a new trigger and attempt 2 are not bound by it.
    if (['queued', 'backoff-retry', 'restored'].includes(origin) && (usage.releasesByHead.get(subject.headSha) ?? 0) >= l.releasesPerHeadPer24h) return { stop: 'RELEASE_CAP_REACHED' };
    const startCode = await this.batchStartChecks(null);
    if (startCode) return { halt: startCode };
    const beat = await this.companion.heartbeat();
    if (!beat || typeof beat.at !== 'number' || now - beat.at > this.policy.companion.heartbeatMaxAgeMs) return { defer: 'COMPANION_NOT_READY' };
    return {};
  }

  // The start-of-batch authority checks, run before a reservation and again on every resume of a waiting batch
  // (PR-A review MAJOR 3): the install's validUntil, the installed Source and resident bytes against the
  // policy, and (for a batch) the batch subject's Source against the installed one. Returns a HALT code or null.
  // The installed bytes, checked before an ending that runs the archive tools without the start checks (independent
  // re-review of step 2, m16): drift is never archived over; the batch ends UNKNOWN with a HALT instead.
  async driftCode() {
    const integrity = await this.sourceIntegrity();
    return integrity && integrity.ok === true && integrity.sourceManifestSha256 === this.policy.sourceManifestSha256
      && integrity.residentManifestSha256 === this.policy.residentManifestSha256 ? null : 'RESIDENT_SOURCE_DRIFT';
  }

  async batchStartChecks(subject) {
    if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < this.clock() + batchBudgetMs(this.policy)) return 'RESIDENT_INSTALL_AUTHORITY_EXPIRING';
    const integrity = await this.sourceIntegrity();
    if (!integrity || integrity.ok !== true || integrity.sourceManifestSha256 !== this.policy.sourceManifestSha256
      || integrity.residentManifestSha256 !== this.policy.residentManifestSha256) return 'RESIDENT_SOURCE_DRIFT';
    if (subject && subject.sourceManifestSha256 !== this.policy.sourceManifestSha256) return 'RESIDENT_SOURCE_DRIFT';
    return null;
  }

  // A precheck's deferral: the row's own one is shown on it and the pass goes on; a global one ends the pass.
  async deferral(pre, key, pr) {
    if (pre.notice) this.queue.notice(pre.notice);
    if (pre.perRow) { this.queue.defer(pr, pre.defer, this.clock(), { dropPoke: pre.dropPoke === true, until: pre.until ?? null }); return { state: 'DEFERRED', key, reason: pre.defer, next: true }; }
    // A global deferral (a full daily budget, the companion not ready) holds the whole queue; one receipt per reason and
    // UTC day says so (Task 12ada80e, from c0ff5167: the executor standing still was visible nowhere but the status page).
    const day = `${pre.defer}:${dayKey(this.clock())}`;
    if (!this.deferralReceipts.has(day)) {
      this.deferralReceipts.add(day);
      const u = this.tickUsage;
      try { await this.receipt('batch-deferred', { key, failureCode: pre.defer, usage: u ? { started: u.started, evaluations: u.evaluations, lowRiskBurns: u.lowRiskBurns } : null }); }
      catch { this.deferralReceipts.delete(day); }
    }
    return { state: 'DEFERRED', key, reason: pre.defer };
  }

  // One queue row: its current commit as attempt 1.
  async runRow(c, usage) {
    const subject = { repo: this.policy.repo, pr: c.pr, headSha: c.headSha, baseSha: c.baseSha, sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1 };
    const key = batchKey(subject);
    const hk = headKey(subject);
    const pre = await this.precheck(key, hk, subject, { usage, origin: c.origin });
    if (pre.ignore) {
      this.queue.settle(c.pr, c.headSha, { kind: 'ignored', code: pre.ignore, klass: null }, this.clock());
      await this.receipt('trigger-ignored', { key, failureCode: pre.ignore, origin: c.origin });
      this.reportOutcome(subject, 'IGNORED', { code: pre.ignore, key });
      return { state: 'IGNORED', key, reason: pre.ignore, next: true };
    }
    if (pre.halt) { await this.haltWith(pre.halt, { key }); return { state: 'HALTED', key, failureCode: pre.halt }; }
    if (pre.defer) return this.deferral(pre, key, c.pr);
    if (pre.stop) {
      if (this.queue.stopAtCap(c.pr, c.headSha, pre.stop, this.clock())) this.queue.notice({ key: `stopped:${c.pr}:${c.headSha}:${pre.stop}`, kind: 'stopped', pr: c.pr, headSha: c.headSha, code: pre.stop });
      return { state: 'DEFERRED', key, reason: pre.stop, next: true };
    }

    await this.ledger.reserve(key, subject, { origin: c.origin });
    await this.receipt('batch-reserved', { key, headKey: hk, subject, origin: c.origin });
    this.queue.begin(c.pr, c.headSha, key, c.origin, this.clock());
    await this.persistQueue();
    // t0 of the hosted wait: the row is reserved in this very tick.
    return this.driveReserved(key, subject, this.clock(), c.origin);
  }

  // attempt 1 ended FAILED_CLEAN at stage 0, 1 or 2 (attempts.mjs#ATTEMPT2_STAGES) with a recorded plan that relayed no role.
  async relayedNothing(key1) {
    try {
      const s = await this.ledger.state(key1);
      return s.state === 'TERMINAL' && s.outcome === 'FAILED_CLEAN' && [0, 1, 2].includes(s.terminal?.facts?.stage)
        && Array.isArray(s.plan?.relayed) && s.plan.relayed.length === 0;
    } catch { return false; }
  }

  // Is a newer commit of this subject's PR in the queue (it arrived while the subject ran, or after attempt 1)?
  newerCommitQueued(subject) {
    const r = this.queue.row(subject.pr);
    return !!r?.current && r.current.headSha !== subject.headSha;
  }

  // One live read of the PR (the companion's pr-head): null when there is no answer. Never authority to run anything.
  async livePull(pr, batch = null) {
    try { return (await this.companion.prHead?.(pr, batch)) ?? null; } catch { return null; }
  }

  // The scheduled attempt 2: same pre-checks under its own keys; the intent is closed if they refuse it
  // for good, kept when they only defer it. Phase 2: an attempt 2 whose PR got a newer commit is voided when one live
  // read confirms the PR's head moved on (v0.6 §3).
  async runAttempt2({ key1, key2, subject }, usage) {
    // Bound to the installed Source (PR-A review MAJOR 2): an intent from before a reinstall is closed, never run.
    if (subject.sourceManifestSha256 !== this.policy.sourceManifestSha256) {
      await this.ledger.closeAttempt2(key1, { failureCode: 'ATTEMPT2_SOURCE_CHANGED' });
      await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: 'ATTEMPT2_SOURCE_CHANGED' });
      return { state: 'IGNORED', key: key2, reason: 'ATTEMPT2_SOURCE_CHANGED', next: true };
    }
    if (this.newerCommitQueued(subject)) {
      const live = await this.livePull(subject.pr);
      if (live && (live.state !== 'open' || live.headSha !== subject.headSha)) {
        await this.ledger.closeAttempt2(key1, { failureCode: 'ATTEMPT2_SUPERSEDED', liveHeadSha: live.headSha, liveState: live.state });
        await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: 'ATTEMPT2_SUPERSEDED' });
        return { state: 'IGNORED', key: key2, reason: 'ATTEMPT2_SUPERSEDED', next: true };
      }
      // Disproved (the PR's head is still attempt 1's): the newer commit in the queue goes back to superseded. No answer:
      // attempt 2 runs and stage 1 decides; nothing but a confirming live read ever voids it (v0.6 §3; review M2).
      if (live && this.queue.keepCurrent(subject.pr, subject.headSha, subject.baseSha, this.clock())) {
        await this.persistQueue();
        await this.receipt('supersede-disproved', { key: key2, pr: subject.pr, safePoint: 'before-attempt-2' });
      }
    }
    const hk = headKey(subject);
    const pre = await this.precheck(key2, hk, subject, { attempt1Key: key1, usage, origin: 'attempt2' });
    if (pre.ignore) {
      await this.ledger.closeAttempt2(key1, { failureCode: pre.ignore });
      await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: pre.ignore });
      return { state: 'IGNORED', key: key2, reason: pre.ignore, next: true };
    }
    if (pre.halt) { await this.haltWith(pre.halt, { key: key2 }); return { state: 'HALTED', key: key2, failureCode: pre.halt }; }
    // A deferred attempt 2 never blocks the rows behind it (PR-A review MINOR 9): a global deferral stops them anyway.
    if (pre.defer) { if (pre.notice) this.queue.notice(pre.notice); return { state: 'DEFERRED', key: key2, reason: pre.defer, next: true }; }
    // Consumed create-only before the reservation: whatever attempt 2 ends with, it never runs again.
    await this.ledger.consumeAttempt2(key1, { key2 });
    await this.ledger.reserve(key2, subject, { origin: 'attempt2' });
    await this.receipt('batch-reserved', { key: key2, headKey: hk, subject, attempt1: key1, origin: 'attempt2' });
    // The row of attempt 1's head shows attempt 2 running (when that head is still the PR's current one in the queue).
    const row = this.queue.row(subject.pr);
    if (row?.current?.headSha === subject.headSha && !row.running) { this.queue.begin(subject.pr, subject.headSha, key2, 'attempt2', this.clock()); await this.persistQueue(); }
    return this.driveReserved(key2, subject, this.clock(), 'attempt2');
  }

  async driveReserved(key, subject, t0, origin = 'queued') {
    let batch = null;
    let outcome;
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: new Date(this.clock()).toISOString() };
    this.atStage(0, 'derive');
    try {
      outcome = await this.drive(key, subject, t0, b => { batch = b; });
      if (outcome instanceof StepFailure) outcome = await this.fail(key, batch, outcome);
    } catch (error) {
      // An exception in the executor itself (or a port) is never classified as clean.
      outcome = await this.unknown(key, codeOf(error), 'executor-exception', null, archiveFacts(error));
    }
    return this.afterBatch(subject, origin, outcome);
  }

  // A batch ended (anything but WAITING): its queue row settles, the breaker gets one event, and an ending that may
  // have falsified the batch head asks the companion once for the PR's real head (queue.mjs#restore). All of it is a
  // view: a failure here never changes what the batch did or how it ended.
  // The breaker's event for one ending (also the parking after stage 7, which is no batch end).
  async feedBreaker(subject, s) {
    if (!s || !Number.isSafeInteger(s.pos)) return;
    const now = this.clock();
    const b = breakerOf(this.queue.breaker);
    this.queue.breaker = b;
    // Windows-only: the ending never reached the Linux preparation (a stage-1 or stage-R ending, a completed batch whose
    // roles were all relayed, a stage-8 try); it never closes a breaker a Linux place opened (design v0.5 §4.6; review m2).
    const windowsOnly = typeof s.windowsOnly === 'boolean' ? s.windowsOnly : ['completed', 'parked'].includes(s.kind) ? s.linux !== true : s.pos < POSITIONS.workspace;
    const t = breakerRecord(b, { pos: s.pos, completed: s.kind === 'completed', counts: s.breaker === 'counts', neutral: s.breaker !== 'counts', windowsOnly,
      pr: subject.pr, code: s.code ?? null }, this.policy, now);
    if (t === 'opened' || t === 'reopened') {
      this.queue.notice({ key: `breaker:${b.openedAt}`, kind: 'breaker-open', pr: null, headSha: null, code: s.code ?? null, until: b.nextTrialAt });
      await this.receipt('breaker-opened', { failureCode: s.code ?? null, failingPos: b.failingPos, level: b.level, nextTrialAt: new Date(b.nextTrialAt).toISOString(), reopened: t === 'reopened' });
    } else if (t === 'closed') {
      const lifted = this.queue.liftEnvironmentStops(now);
      await this.receipt('breaker-closed', { pr: subject.pr, lifted });
    }
  }

  async afterBatch(subject, origin, result) {
    if (!result || result.state === 'WAITING') return result;
    if (result.state === 'PARKED') {
      try {
        this.queue.park(subject.pr, subject.headSha, { reason: result.reason, nextAt: result.until, position: result.position ?? null }, this.clock());
        await this.feedBreaker(subject, result.settle);
        await this.persistQueue();
      } catch { /* a view */ }
      this.reportQueue();
      return result;
    }
    const now = this.clock();
    const s = result.settle ?? null;
    try {
      const environment = ['environment', 'transient'].includes(s?.klass);
      const b = breakerOf(this.queue.breaker);
      this.queue.breaker = b;
      // This release counts towards the head's cap unless it is a wait, a supersession, or an environment fault while
      // the breaker is not closed (ledger.mjs#usage counts the same way; the tick's usage is from before this batch).
      const counted = s?.kind === 'released' && s.klass !== 'waiting' && s.klass !== 'node-role' && s.reason !== 'SUPERSEDED' && !(environment && s.breakerState !== 'closed');
      const releases24h = (this.tickUsage?.releasesByHead.get(subject.headSha) ?? 0) + (counted ? 1 : 0);
      const ciRetryAfter = typeof s?.ciRetryAfter === 'string' && Number.isFinite(Date.parse(s.ciRetryAfter)) ? Date.parse(s.ciRetryAfter) : null;
      const settled = this.queue.settle(subject.pr, subject.headSha, s ? { kind: s.kind, code: s.code ?? null, klass: s.klass ?? null, reason: s.reason ?? null, ciRetryAfter,
        releases24h, releaseCap: this.policy.limits.releasesPerHeadPer24h } : { kind: 'burned', code: result.failureCode ?? null, klass: 'unknown' }, now);
      if (settled === 'stopped') {
        this.queue.notice({ key: `stopped:${subject.pr}:${subject.headSha}:${s.code}`, kind: 'stopped', pr: subject.pr, headSha: subject.headSha, code: s.code ?? null });
        await this.receipt('queue-row-stopped', { pr: subject.pr, headSha: subject.headSha, failureCode: s.code ?? null, releases24h });
      }
      // A batch that rested at B told the breaker about stages 1-7 when it parked: its end is a stage-8 ending.
      await this.feedBreaker(subject, s);
      if (s && (FALSIFYING_CODES.includes(s.code) || (s.code === 'STAGE_CHILD_REFUSED' && FALSIFYING_REASONS.includes(s.outcomeReason)))) await this.falsified(subject);
      await this.persistQueue();
    } catch { /* the queue and the breaker are a view; the next batch end writes them again */ }
    this.reportQueue();
    return result;
  }

  // The batch head may no longer be the PR's head: one live read. A closed PR leaves the queue; a head the companion
  // sees that this PR had superseded, and that is not burned, becomes the PR's current commit again (v0.6 §9 phase 2
  // item 5: the head actually seen, not the newest one).
  async falsified(subject) {
    const live = await this.livePull(subject.pr);
    if (!live) return;
    if (live.state !== 'open') {
      if (this.queue.closePr(subject.pr, this.clock())) await this.receipt('queue-pr-closed', { pr: subject.pr, state: live.state });
      return;
    }
    if (live.headSha === subject.headSha) return;
    const row = this.queue.row(subject.pr);
    const was = row?.superseded.find(c => c.headSha === live.headSha);
    if (!was) return;
    const candidate = { repo: this.policy.repo, pr: subject.pr, headSha: was.headSha, baseSha: was.baseSha, sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1 };
    const burned = (await this.ledger.headBurned(headKey(candidate))) || (await this.executedHeads.published(candidate));
    if (this.queue.restore(subject.pr, live.headSha, this.clock(), { burned })) await this.receipt('queue-restored', { pr: subject.pr, headSha: live.headSha, falsified: subject.headSha });
  }

  // The status board's batch in flight (this.current is set when a batch is reserved or resumed).
  atStage(stage, phase) { if (this.current) this.report(s => s.setCurrent({ ...this.current, stage, phase })); }

  stage(number) { return this.policy.stages.find(s => s.number === number); }

  // Right before a stage that can publish a check: the head is recorded as "may have published" for every Source and
  // attempt (executed-heads.mjs). Create-only and idempotent; a record that cannot be written stops the batch before
  // that stage (a clean, final failure: nothing of the stage ran).
  async beforePublication(key, subject, number) {
    if (!PUBLICATION_STAGES.includes(number)) return null;
    try {
      await this.executedHeads.record(subject, { key, origin: 'publication', basis: `before-stage-${number}`, stage: number });
      return null;
    } catch (error) {
      return new StepFailure(number, 'EXECUTED_HEAD_RECORD_UNCONFIRMED', { windowsTreeZero: true }, 'stage');
    }
  }

  // Primary/standby design v0.4 §6.2 (C4): stage 1 found this head already published on GitHub (HEAD_PUBLISHED_ON_GITHUB,
  // by another node or install). It is recorded as "may have published" for every Source and attempt, so it is never
  // admitted again; a record that cannot be written ends the batch as EXECUTED_HEAD_RECORD_UNCONFIRMED instead.
  async recordPublishedOnGithub(key, subject) {
    try {
      await this.executedHeads.record(subject, { key, origin: 'publication', basis: 'head-published-on-github', stage: 1 });
      return null;
    } catch (error) {
      return new StepFailure(1, 'EXECUTED_HEAD_RECORD_UNCONFIRMED', { windowsTreeZero: true }, 'stage');
    }
  }

  async drive(key, subject, t0, keepBatch) {
    const batch = await this.engine.derive(subject, key);
    keepBatch(batch);
    await this.receipt('batch-derived', { key, batchId: batch.batchId, packageSha256: batch.packageSha256 });

    // The bundle comes first: it needs only the Owner's own read credential, has no Windows or Linux
    // effect and publishes nothing, so its failure can release the reservation.
    this.atStage(0, 'bundle');
    const bundle = await this.companion.buildBundle(batch);
    if (!bundle || bundle.ok !== true) return Object.assign(new StepFailure(0, 'BUNDLE_UNAVAILABLE', {}, 'bundle'), { companionJobTree: bundle?.jobTree ?? null });
    const early = await this.abortIfRequested(key, batch, 'before-stage-1');
    if (early) return early;
    // Phase 2: a newer commit of the PR arrived while the bundle was built. Nothing of this batch ran: released, not
    // burned (design v0.5 §4.2; v0.6 §3: before stage 1 the arrival order alone may decide).
    const superseded = await this.supersededBeforeStart(key, subject, batch);
    if (superseded) return superseded;

    this.atStage(1, 'stage');
    const first = await this.engine.runStage(batch, this.stage(1), { betweenRoles: false, firstLinux: false });
    await this.receipt('stage-terminal', { key, stage: 1, ok: first.ok === true, failureCode: first.ok ? null : validCode(first.code), factsSha256: first.factsSha256 ?? null, outcome: outcomeSummary(first) });
    if (first.ok !== true) {
      if (first.code === 'HEAD_PUBLISHED_ON_GITHUB') {
        const unrecorded = await this.recordPublishedOnGithub(key, subject);
        if (unrecorded) return unrecorded;
      }
      return new StepFailure(1, first.code, first.proof, 'stage', 0, first);
    }

    // Admitted and published: from here on this head is burned (also when every heavy role is relayed).
    await this.ledger.markStarted(key, { batchId: batch.batchId });
    await this.receipt('batch-started', { key });
    // The wait's anchor (t0) and the derived batch, durable before the first wait evaluation: a later tick,
    // or a restarted service, continues from here without deriving or running stage 1 again.
    await this.ledger.beginWait(key, { t0, batch });
    const outcome = await this.continueBatch(key, subject, batch, t0);
    if (outcome?.state === 'WAITING') await this.receipt('relay-waiting', { key, until: outcome.until, reason: outcome.reason });
    return outcome;
  }

  // One evaluation of a waiting batch; WAITING again, or the rest of the batch (or its failure).
  async resumeWaiting(entry) {
    const { key } = entry, { t0, batch } = entry.wait, subject = entry.reserved.subject;
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: entry.reserved.reservedAt ?? null };
    this.atStage(null, 'relay-wait');
    let outcome;
    try {
      // An install authority that ends within one batch budget closes a batch at parking point A neutrally, as at B
      // (design v0.5 §4.8; independent review of step 2, m1). Only stage 1 ran: nothing was published.
      if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < this.clock() + batchBudgetMs(this.policy)) {
        const drift = await this.driftCode();
        if (drift) return this.afterBatch(subject, entry.reserved.origin ?? 'queued', await this.unknown(key, drift, 'resume-start-checks', batch));
        const f = await this.fail(key, batch, Object.assign(new StepFailure(1, 'PARKED_AUTHORITY_EXPIRING', { windowsTreeZero: true }, 'stage', 0), { windowsOnly: true }));
        return this.afterBatch(subject, entry.reserved.origin ?? 'queued', f);
      }
      // Every resume re-runs the start-of-batch checks; any drift fails closed (UNKNOWN, HALT).
      const startCode = await this.batchStartChecks(subject);
      if (startCode) return this.afterBatch(subject, entry.reserved.origin ?? 'queued', await this.unknown(key, startCode, 'resume-start-checks', batch));
      outcome = await this.continueBatch(key, subject, batch, t0, { resumed: true });
      if (outcome instanceof StepFailure) outcome = await this.fail(key, batch, outcome);
    } catch (error) {
      outcome = await this.unknown(key, codeOf(error), 'executor-exception', batch, archiveFacts(error));
    }
    return this.afterBatch(subject, entry.reserved.origin ?? 'queued', outcome);
  }

  // Everything after 15-relay-wait: one wait evaluation, then (unless still waiting) 20-plan-intent,
  // stage R, 25-plan, the local roles, stage 8 and the close.
  //   resumed: this call resumes a batch that rested at parking point A in an earlier tick (resumeWaiting), never the
  //   batch's own first pass (DESIGN §37: only a batch that waited is re-bundled; independent review M1).
  async continueBatch(key, subject, batch, t0, { resumed = false } = {}) {
    let aborted = await this.abortIfRequested(key, batch, 'before-relay-plan');
    if (aborted) return aborted;
    if ((aborted = await this.supersededAfterStart(key, subject, batch, 'before-relay-plan', POSITIONS[1]))) return aborted;
    const plan = await this.relayPlan(key, subject, batch, t0);
    if (plan instanceof StepFailure || plan.waiting) return plan.waiting ? { state: 'WAITING', key, until: plan.until, reason: plan.reason } : plan;
    const relayed = plan.relayed.length;

    // Only LOCAL_REQUIRED roles run locally, in the fixed role order; the protocol records of the previous
    // local Linux role are archived before the next one (between-roles-4 / -6 only where needed).
    const localRoles = HEAVY_ROLES.filter(r => plan.local.some(l => l.role === r));
    if (localRoles.length > 0) {
      if ((aborted = await this.abortIfRequested(key, batch, 'before-workspace'))) return aborted;
      if ((aborted = await this.supersededAfterStart(key, subject, batch, 'before-workspace', plan.candidates.length > 0 ? POSITIONS[RELAY_STAGE] : POSITIONS[1]))) return aborted;
      // A batch resumed from parking point A gets its second bundle before the workspace (Task 4012c1b9, DESIGN §37). When
      // that is refused, it ends here, nothing of it on Linux: refs no longer the batch's as the clean transient
      // REMOTE_REFS_CHANGED_SINCE_BUNDLE, anything else as before (PARKED_BUNDLE_TOO_OLD). A batch that never waited, or a
      // companion without the re-bundle port, keeps the old rule: a bundle older than 100 minutes ends the batch here.
      const reservedAt = Date.parse((await this.ledger.state(key)).reserved?.reservedAt ?? '');
      const rebundle = resumed && typeof this.companion.rebuildBundle === 'function' && Number.isFinite(reservedAt) && this.clock() - reservedAt > REBUNDLE_AFTER_MS;
      if (!rebundle) {
        if (Number.isFinite(reservedAt) && this.clock() - reservedAt > BUNDLE_MAX_AGE_AT_WORKSPACE_MS) return new StepFailure(0, 'PARKED_BUNDLE_TOO_OLD', {}, 'workspace', relayed);
      } else {
        this.atStage(0, 'rebundle');
        const rb = await this.companion.rebuildBundle(batch);
        const code = rb?.ok === true ? null : (rb?.code === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' ? 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' : 'PARKED_BUNDLE_TOO_OLD');
        await this.receipt('batch-rebundled', { key, failureCode: code, ageMinutes: Math.floor((this.clock() - reservedAt) / 60_000), companionJobTree: rb?.jobTree ?? null });
        if (code) return new StepFailure(0, code, {}, 'workspace', relayed);
      }
      this.atStage(0, 'workspace');
      const prep = await this.companion.prepareWorkspaces(batch);
      if (!prep || prep.ok !== true) return new StepFailure(0, prep?.code ?? 'WORKSPACE_PREPARATION_UNCONFIRMED', {}, 'workspace', relayed);
    }
    for (const [index, role] of localRoles.entries()) {
      for (const number of ROLE_STAGES[role]) {
        if ((aborted = await this.abortIfRequested(key, batch, `before-stage-${number}`))) return aborted;
        const unrecorded = await this.beforePublication(key, subject, number);
        if (unrecorded) { unrecorded.relayedRoles = relayed; return unrecorded; }
        this.atStage(number, 'stage');
        const execution = number === ROLE_STAGES[role][0];
        const { result: r, abort, stopCode, unconfirmed } = await this.runStageWatched(key, batch, number, { betweenRoles: execution && index > 0, firstLinux: execution && index === 0 });
        await this.receipt('stage-terminal', { key, stage: number, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), factsSha256: r.factsSha256 ?? null, outcome: outcomeSummary(r),
          ...(r.bridge ? { bridge: bridgeFacts(r.bridge) } : {}), ...(r.memoryGate ? { memoryGate: memoryGateFacts(r.memoryGate) } : {}) });
        if (unconfirmed) return this.unknown(key, 'OWNER_ABORT_UNCONFIRMED', 'owner-abort-unconfirmed', batch, { safePoint: `in-stage-${number}`, stage: number });
        if (abort) return this.concludeAbort(key, batch, { safePoint: `in-stage-${number}`, stage: number, result: r, request: abort, stopCode });
        if (r.ok !== true) return new StepFailure(number, r.code, r.proof, 'stage', relayed, r);
      }
    }
    await this.lateHostedResults(key, subject, plan);
    if ((aborted = await this.abortIfRequested(key, batch, 'before-stage-8'))) return aborted;
    // Phase 2, step 2: the close archive on both hosts ends the Linux exclusive zone; then the batch rests at parking
    // point B and stage 8 runs as tries (the first one right away). Stage 8 touches only Windows.
    const closed = await this.engine.closeBatch(batch, { linux: localRoles.length > 0 });
    archiveCheck(closed && closed.verified === true, 'SUCCESS_PATH_ARCHIVE_UNCONFIRMED', closed);
    await this.ledger.park(key, { batch, closed: closed.archived ?? null, local: localRoles });
    await this.receipt('batch-parked', { key, local: localRoles, relayed: plan.relayed.map(r => r.role) });
    // Everything up to stage 7 passed (Linux too when a role ran locally): the breaker learns it now. A view: a failure
    // here never changes the batch, which already rests at B (independent review of step 2, m12).
    try { await this.feedBreaker(subject, { pos: POSITIONS[7], breaker: 'neutral', linux: localRoles.length > 0, kind: 'parked', code: null }); } catch { /* a view */ }
    return this.stage8Try(key, subject, batch);
  }

  // The latest companion hint for this head, parsed; anything malformed is "no hint" (it can only make the
  // batch wait less or relay less, never more).
  async hint(subject) {
    let bytes = null;
    try { bytes = await this.companion.hostedHint?.(subject); } catch { bytes = null; }
    if (!bytes) return { hint: null, refused: false };
    try { return { hint: parseHint(bytes, subject), refused: false, sha256: sha256(bytes) }; } catch { return { hint: null, refused: true }; }
  }

  // One hosted-wait evaluation -> { waiting, until } | 20-plan-intent -> stage R (only with candidates) ->
  // 25-plan. Returns the plan { relayed: [row], local: [{ role, reason, receipt }] } or a StepFailure.
  async relayPlan(key, subject, batch, t0) {
    const relay = this.policy.relay;
    const seen = relay.enabled === true ? await this.hint(subject) : { hint: null, refused: false };
    const decision = decide({ relay, t0, now: Math.max(this.clock(), t0), hint: seen.hint });
    if (decision.action === 'WAIT') return { waiting: true, until: decision.until, reason: decision.reason };
    const candidates = decision.relayCandidates;
    await this.ledger.writePlanIntent(key, { candidates, local: decision.local, reasons: decision.reasons, reason: decision.reason, waitedMs: Math.max(0, this.clock() - t0),
      hintSha256: seen.sha256 ?? null, hintRefused: seen.refused });
    await this.receipt('relay-plan-intent', { key, candidates, reason: decision.reason, waitedMs: Math.max(0, this.clock() - t0), hintRefused: seen.refused });
    // Roles the resident never sent to stage R stay local with the resident's own scheduling reason.
    const scheduled = decision.local.map(role => ({ role, reason: decision.reasons[role],
      receipt: decision.reasons[role] === 'RELAY_HINT_BILLING_REFUSED' ? 'relay-billing-refused' : 'relay-local-fallback', source: 'resident' }));
    let relayed = [], attested = [];
    if (candidates.length > 0) {
      const unrecorded = await this.beforePublication(key, subject, RELAY_STAGE);
      if (unrecorded) return unrecorded;
      this.atStage(RELAY_STAGE, 'stage');
      const r = await this.engine.runRelayStage(batch, candidates);
      await this.receipt('stage-terminal', { key, stage: RELAY_STAGE, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), factsSha256: r.factsSha256 ?? null, outcome: outcomeSummary(r) });
      if (r.ok !== true) return new StepFailure(RELAY_STAGE, r.code, r.proof, 'stage', 0, r);
      const rows = relayPlanFromRows(r.relay, candidates);
      if (!rows) return new StepFailure(RELAY_STAGE, 'RELAY_PLAN_UNCONFIRMED', r.proof, 'stage', 0);
      // C4: a role already on GitHub that this node knew nothing of ends the batch cleanly: no 25-plan and no local stage
      // for any role (the head was recorded as executed before stage R). A role relayed before it keeps its receipt.
      if (rows.onGithub) {
        for (const x of rows.relayed) await this.receipt(RELAY_RECEIPTS.attested, { key, role: x.role, checkRunId: x.checkRunId, externalId: x.externalId, attestationSha256: x.attestationSha256 });
        return new StepFailure(RELAY_STAGE, 'ROLE_ALREADY_ON_GITHUB', r.proof, 'stage', rows.relayed.length, r);
      }
      relayed = rows.relayed;
      attested = rows.local.map(row => ({ role: row.role, reason: row.reason, receipt: row.receipt, source: 'stage-r', detail: row.detail }));
    }
    const local = [...attested, ...scheduled].sort((a, b) => HEAVY_ROLES.indexOf(a.role) - HEAVY_ROLES.indexOf(b.role));
    const plan = { candidates, relayed: relayed.map(r => ({ role: r.role, checkRunId: r.checkRunId, externalId: r.externalId, attestationSha256: r.attestationSha256 })), local };
    await this.ledger.writePlan(key, plan);
    for (const r of plan.relayed) await this.receipt(RELAY_RECEIPTS.attested, { key, role: r.role, checkRunId: r.checkRunId, externalId: r.externalId, attestationSha256: r.attestationSha256 });
    if (relay.enabled === true) for (const l of local) await this.receipt(l.receipt === 'relay-billing-refused' ? RELAY_RECEIPTS.billingRefused : RELAY_RECEIPTS.localFallback, { key, role: l.role, reason: l.reason, source: l.source });
    return plan;
  }

  // A hosted run that finished after the local path started is never relayed (design §7.4): it is only
  // recorded, once per role, as relay-late-ignored.
  async lateHostedResults(key, subject, plan) {
    if (this.policy.relay.enabled !== true) return;
    const { hint } = await this.hint(subject);
    if (!hint) return;
    for (const l of plan.local) if (RELAY_ROLES.includes(l.role) && hint.roles[l.role]?.state === 'SUCCESS') await this.receipt(RELAY_RECEIPTS.lateIgnored, { key, role: l.role, reason: l.reason });
  }

  // The cleanup proof is always gathered fresh at failure time from both hosts (Windows from the
  // engine: SCM readback, the stage's own process-tree fact, no child still running; Linux from the
  // root tool's own output). It is never defaulted.
  async proofFor(batch, stageProof) {
    const windows = await this.engine.windowsQuiescence(batch);
    const linux = await this.companion.linuxQuiescence(batch);
    return {
      // A stage proof field that is present must be true; an absent one (no stage ran) adds nothing.
      windowsTreeZero: windows.windowsTreeZero === true && (!('windowsTreeZero' in stageProof) || stageProof.windowsTreeZero === true),
      serviceOriginalStopped: windows.serviceOriginalStopped === true && (!('serviceOriginalStopped' in stageProof) || stageProof.serviceOriginalStopped === true),
      linuxUnitsInactive: linux.linuxUnitsInactive === true,
      containersZero: linux.containersZero === true,
    };
  }

  // The failure table's facts a terminal or unexecuted record keeps (codes only, no free text).
  static failureFacts(failure, row) {
    const o = failure.outcome;
    return { class: row?.class ?? null, retry: row?.retry ?? null, breaker: row?.breaker ?? null, reason: o?.reason ?? null,
      reasonCodes: o?.diagnostic?.reasonCodes ?? null, nativeReasonCodes: o?.diagnostic?.nativeReasonCodes ?? null,
      ciRetryAfter: o?.scheduling?.ciRetryAfter ?? o?.diagnostic?.ciRetryAfter ?? null, safeToRerun: o?.safeToRerun === true, brokerNoLaunch: failure.brokerNoLaunch === true };
  }

  async fail(key, batch, failure) {
    const subjectOf = async () => { try { return (await this.ledger.state(key)).reserved?.subject ?? null; } catch { return null; } };
    // What the run queue and the breaker learn from this ending (afterBatch).
    const pos = positionOf(failure.stageNumber, failure.phase);
    const breakerState = breakerOf(this.queue.breaker).state;
    try {
      const started = (await this.ledger.state(key)).state === 'STARTED';
      if (!started && failure.phase === 'bundle') {
        // Nothing of this batch reached Linux yet (DESIGN §24): the close archives Windows only and asks the companion for
        // nothing, so a companion still busy with, or done with, the failed bundle cannot turn this release into a HALT.
        await this.closeOrThrow(batch, { linux: false });
        await this.ledger.releaseUnexecuted(key, 'BUNDLE_UNAVAILABLE', { failureCode: failure.code, class: 'environment', breaker: 'counts', breakerState });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code, companionJobTree: failure.companionJobTree ?? null });
        this.reportOutcome(this.current, 'NOT_EXECUTED', { code: failure.code, key });
        return { state: 'NOT_EXECUTED', key, failureCode: failure.code,
          settle: { kind: 'released', reason: 'BUNDLE_UNAVAILABLE', code: failure.code, klass: 'environment', breaker: 'counts', breakerState, pos } };
      }
      const proof = await this.proofFor(batch, failure.proof);
      // The failure table (classify.mjs#decideFailure): a stage-1 failure is released only on the outcome's own
      // safeToRerun flag or the broker's "no launch, original restored" answer; every other failure burns the head.
      const { klass, basis, row, release } = decideFailure({ code: failure.code, stage: failure.stageNumber, phase: failure.phase, outcome: failure.outcome,
        brokerNoLaunch: failure.brokerNoLaunch, proof, started });
      const facts = ResidentExecutor.failureFacts(failure, row);
      // C3 (DESIGN §29): stage 1 said this node holds no role (NODE_ROLE_NOT_HELD, or the older Source's NATIVE_NOT_ADMITTED with
      // admission_binding_required): STANDBY, whatever else the ending is. A later live refusal may mean the same: probe at once.
      if (row?.class === 'node-role') await this.setNodeMode('STANDBY', 'role-not-held');
      else if (failure.stageNumber !== 1 && ROLE_LOST_SUSPECT_CODES.includes(failure.code)) this.roleProbe.markUrgent();
      const settle = { code: failure.code, klass: row?.class ?? 'unknown', breaker: row?.breaker ?? 'counts', breakerState, pos, ciRetryAfter: facts.ciRetryAfter, outcomeReason: facts.reason,
        ...(typeof failure.windowsOnly === 'boolean' ? { windowsOnly: failure.windowsOnly } : {}) };
      if (!started && release) {
        await this.closeOrThrow(batch);
        await this.ledger.releaseUnexecuted(key, release, { failureCode: failure.code, basis, ...facts, breakerState });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code, release, class: facts.class });
        // C3 (DESIGN §29.10): attempt 2 is consumed before its reservation; a node-role release decided nothing about the PR, so the
        // same attempt 2 is given back (its key is the same: never an attempt 3). A failure here only loses attempt 2 (the safe side).
        if (row?.class === 'node-role' && this.current?.key === key && this.current.attempt === 2) await this.reopenAttempt2(key);
        this.reportOutcome(await subjectOf() ?? this.current, release === 'NOT_ADMITTED' ? 'NOT_ADMITTED' : 'NOT_EXECUTED', { code: failure.code, row, key });
        return { state: release === 'NOT_ADMITTED' ? 'NOT_ADMITTED' : 'NOT_EXECUTED', key, failureCode: failure.code, release, settle: { ...settle, kind: 'released', reason: release } };
      }
      // Every other failure burns the head, also before 10-started (stage 1 may have published). Risk tier (Task 12ada80e,
      // DESIGN §36): a stage-1 ending that proves it published nothing (clean on both hosts, bound outcome with zero side
      // effects and mayHavePublished false) still burns the head, but uses the evaluation budget, not the execution one.
      const lowRisk = !started && failure.stageNumber === 1 && klass === 'CLEAN' && failure.outcome?.sideEffects === 0 && failure.outcome?.mayHavePublished === false;
      await this.ledger.burnHead(key, { failureCode: failure.code, ...(lowRisk ? { quotaTier: QUOTA_TIER_EVALUATION } : {}) });
      // DESIGN §27: a scanner-issuer stage that would HALT is closed clean when its abandonment can be proven.
      if (klass !== 'CLEAN' && await this.scannerAbandonable(key, failure)) return await this.abandonScannerStage(key, batch, failure, settle);
      if (klass === 'CLEAN') {
        const reason = archiveReason(failure.code);
        const windows = await this.engine.archiveFailure(batch, reason);
        const linux = await this.companion.archiveLinux(batch, reason);
        archiveCheck(windows && windows.verified === true && linux && linux.verified === true, 'FAILURE_ARCHIVE_UNCONFIRMED', windows);
        await this.ledger.terminal(key, 'FAILED_CLEAN', { failureCode: failure.code, basis, stage: failure.stageNumber, batchId: batch?.batchId ?? null, windows: windows.directory, linux: linux.directory, ...facts });
        await this.receipt('batch-terminal', { key, outcome: 'FAILED_CLEAN', failureCode: failure.code, class: facts.class });
        const subject = (await this.ledger.state(key)).reserved?.subject;
        this.reportOutcome(subject, 'FAILED_CLEAN', { code: failure.code, row, key });
        const key2 = await this.attempt2IfEligible(key, subject, failure);
        return { state: 'FAILED_CLEAN', key, failureCode: failure.code, ...(key2 ? { attempt2: key2 } : {}), settle: { ...settle, kind: 'burned' } };
      }
      return { ...(await this.unknown(key, failure.code, basis, batch, { stage: failure.stageNumber, ...facts })), settle: { ...settle, kind: 'burned', klass: 'unknown' } };
    } catch (error) {
      return this.unknown(key, codeOf(error), 'failure-handling-unconfirmed', batch, archiveFacts(error));
    }
  }

  // The attempt-2 intent of this attempt-2 batch (key2), given back after a node-role release. Never throws.
  async reopenAttempt2(key2) {
    try {
      const c = this.current;
      const key1 = batchKey({ repo: this.policy.repo, pr: c.pr, headSha: c.headSha, baseSha: c.baseSha, sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1 });
      await this.ledger.reopenAttempt2(key1, { key2, failureCode: 'NODE_ROLE_NOT_HELD' });
      await this.receipt('attempt2-reopened', { key: key2, attempt1: key1 });
    } catch { /* attempt 2 stays spent */ }
  }

  // The one automatic attempt 2 after a FAILED_CLEAN (attempts.mjs): its intent and receipt, or null when not eligible.
  async attempt2IfEligible(key, subject, failure) {
    const decision = attempt2Decision({ policy: this.policy, subject, outcome: 'FAILED_CLEAN', failure });
    if (!decision.eligible) return null;
    const key2 = await this.ledger.scheduleAttempt2(key, attempt2Subject(subject), { failureCode: failure.code, stage: failure.stageNumber },
      this.clock() + this.policy.automaticAttempt2.delayMs);
    try {
      await this.receipt('attempt2-scheduled', { key, attempt2: key2, failureCode: failure.code, stage: failure.stageNumber });
    } catch (error) {
      // An intent without its receipt is cancelled before the HALT, so no re-arm can ever run it (MINOR 7).
      await this.ledger.closeAttempt2(key, { failureCode: 'ATTEMPT2_RECEIPT_UNCONFIRMED' });
      throw error;
    }
    return key2;
  }

  // ---- the scanner abandonment (DESIGN §27; design r3 part three, Task d2974298) ----

  // Eligibility: the pure rule (classify.mjs#scannerAbandonEligible: stage 2, 4 or 6, the pump code first, an allow-listed
  // ending, the Windows half of the stage's own proof, a quiet pump), then the executor's own: no HALT latched (read through the
  // ledger exactly as the tick start reads it; the abandonment itself never writes or clears HALT.json), no drift of the
  // installed bytes, and an entry that is STARTED and on no abort path. Any doubt is "no": the failure HALTs as before.
  async scannerAbandonable(key, failure) {
    try {
      if (!scannerAbandonEligible({ stage: failure.stageNumber, phase: failure.phase, code: failure.code, bridge: failure.bridge, proof: failure.proof }).eligible) return false;
      if (await this.ledger.halted()) return false;
      if (await this.driftCode()) return false;
      const s = await this.ledger.state(key);
      return s.state === 'STARTED' && !s.abort && !s.selfAbort;
    } catch { return false; }
  }

  // The abandonment (DESIGN §27, the Owner abort's path): quiescence on both hosts (at most ABORT_QUIESCENCE_ATTEMPTS looks
  // within ABORT_QUIESCENCE_WAIT_MS), the rename-only archive with the fixed reason scanner-abandoned, and FAILED_CLEAN
  // BRIDGE_ABANDONED_UNPUBLISHED with the numeric stage (executed-heads.mjs#mayHavePublished: stage 2 = not published). The head
  // was burned by fail() already. Unproven quiescence: UNKNOWN with the original code, HALT; an unconfirmed archive or record:
  // UNKNOWN, HALT. Then the failure table's row (breaker counts) and, at stage 2 only, the one attempt 2 (Owner decision eaa7d5e4).
  async abandonScannerStage(key, batch, failure, settle) {
    const b = failure.bridge;
    const row = failureRow({ code: BRIDGE_ABANDONED_UNPUBLISHED, stage: failure.stageNumber });
    const context = { stage: failure.stageNumber, originalCode: failure.code, pumpCode: b.pumpCode, stopCode: b.stopCode };
    try {
      check(row && row.disposition === 'burn', 'FAILURE_TABLE_ROW_MISSING');
      const facts = (windows, linux) => ({ failureCode: BRIDGE_ABANDONED_UNPUBLISHED, basis: 'scanner-abandon-quiescence-proven', originalCode: failure.code,
        outcomeReason: failure.outcome?.reason ?? null, pumpCode: b.pumpCode, stopCode: b.stopCode, stageCode: b.stageCode, stage: failure.stageNumber,
        batchId: batch?.batchId ?? null, windows, linux, class: row.class, retry: row.retry, breaker: row.breaker });
      const closed = await this.provenCleanEnd(key, batch, { stageProof: failure.proof, reason: SCANNER_ABANDON_ARCHIVE_REASON, failureCode: BRIDGE_ABANDONED_UNPUBLISHED,
        burn: false, facts, receipt: { class: row.class, originalCode: failure.code } });
      if (!closed) return { ...(await this.unknown(key, failure.code, 'scanner-abandon-quiescence-unproven', batch, context)), settle: { ...settle, kind: 'burned', klass: 'unknown' } };
      const subject = (await this.ledger.state(key)).reserved?.subject;
      this.reportOutcome(subject, 'FAILED_CLEAN', { code: BRIDGE_ABANDONED_UNPUBLISHED, row, key });
      const end = { ...settle, code: BRIDGE_ABANDONED_UNPUBLISHED, klass: row.class, breaker: row.breaker, kind: 'burned' };
      const key2 = await this.attempt2IfEligible(key, subject, { ...failure, code: BRIDGE_ABANDONED_UNPUBLISHED });
      return { state: 'FAILED_CLEAN', key, failureCode: BRIDGE_ABANDONED_UNPUBLISHED, originalCode: failure.code, ...(key2 ? { attempt2: key2 } : {}), settle: end };
    } catch (error) {
      return { ...(await this.unknown(key, codeOf(error), 'scanner-abandon-unconfirmed', batch, { ...context, ...archiveFacts(error) })), settle: { ...settle, kind: 'burned', klass: 'unknown' } };
    }
  }

  // ---- supersession of a running batch (phase 2, step 1; design v0.5 §4.2; DESIGN §17.4) ----

  // The inbox is read again at a safe point, so a newer commit that arrived while this batch ran is in the queue.
  async newerCommitArrived(subject) {
    try { await this.intake(); } catch { /* the next tick reads it */ }
    return this.newerCommitQueued(subject);
  }

  // Before stage 1 (nothing ran, nothing was asked of the broker): the arrival order alone decides; released as
  // SUPERSEDED, the head unburned (it goes back to the row's superseded commits and may be restored).
  async supersededBeforeStart(key, subject, batch) {
    // attempt 2 is never released by the arrival order: runAttempt2 asked the PR live before it was reserved (review M2).
    if (subject.attempt !== 1 || !(await this.newerCommitArrived(subject))) return null;
    await this.closeOrThrow(batch, { linux: false }); // before stage 1: nothing on Linux (DESIGN §24)
    await this.ledger.releaseUnexecuted(key, 'SUPERSEDED', { failureCode: BATCH_SUPERSEDED, basis: 'newer-commit-before-stage-1', class: 'superseded', breaker: 'neutral' });
    await this.receipt('batch-superseded', { key, pr: subject.pr, headSha: subject.headSha, safePoint: 'before-stage-1' });
    this.reportOutcome(subject, 'NOT_EXECUTED', { code: BATCH_SUPERSEDED, key });
    return { state: 'NOT_EXECUTED', key, failureCode: BATCH_SUPERSEDED, release: 'SUPERSEDED',
      settle: { kind: 'released', reason: 'SUPERSEDED', code: BATCH_SUPERSEDED, klass: 'superseded', breaker: 'neutral', pos: POSITIONS.bundle } };
  }

  // After stage 1, only at a safe point outside the Linux preparation (before stage R's plan, before the workspace):
  // the order is not enough, one live read must confirm the PR's head moved on (or the PR closed). No answer: the batch
  // goes on. The live head IS this batch's head: the newer commit in the queue is disproved and the batch goes on.
  async supersededAfterStart(key, subject, batch, safePoint, pos, stage = 1) {
    if (!(await this.newerCommitArrived(subject))) return null;
    this.liveReadAt ??= new Map();
    const throttle = `${key}:${this.queue.row(subject.pr)?.current?.headSha ?? ''}`;
    if (this.clock() - (this.liveReadAt.get(throttle) ?? -Infinity) < SUPERSEDE_LIVE_READ_MS) return null;
    this.liveReadAt.set(throttle, this.clock());
    if (this.liveReadAt.size > 64) this.liveReadAt.delete(this.liveReadAt.keys().next().value);
    const live = await this.livePull(subject.pr, batch);
    if (!live) { await this.receipt('supersede-unconfirmed', { key, pr: subject.pr, safePoint }); return null; }
    if (live.state === 'open' && live.headSha === subject.headSha) {
      this.queue.keepRunning(subject.pr, subject.headSha, this.clock());
      await this.persistQueue();
      await this.receipt('supersede-disproved', { key, pr: subject.pr, safePoint });
      return null;
    }
    return this.supersededEnd(key, subject, batch, { safePoint, pos, live, stage });
  }

  // The executor's own end of a batch, on the Owner abort's path (DESIGN §6.5): nothing of this batch runs at a safe
  // point, so quiescence on both hosts, the head burned, a rename-only archive with the fixed reason superseded, and
  // FAILED_CLEAN SUPERSEDED_AT_SAFE_POINT (neutral for the breaker, never an attempt 2). Unproven: UNKNOWN, HALT.
  async supersededEnd(key, subject, batch, { safePoint, pos, live, stage = 1 }) {
    const context = { safePoint, stage: null };
    try {
      // Never archive from drifted bytes (re-review of step 2, m16).
      const drift = await this.driftCode();
      if (drift) return await this.unknown(key, drift, 'superseded-source-drift', batch, context);
      // First the create-only record: a crash from here on is a crash scene (SUPERSEDE_INTERRUPTED), never a wait that a
      // restart would resume on a half-archived scene (independent review of step 1, M1).
      await this.ledger.beginSelfAbort(key, { safePoint, liveHeadSha: live.headSha, liveState: live.state });
      await this.receipt('batch-self-abort', { key, pr: subject.pr, safePoint });
      const proof = await this.abortQuiescence(batch, {});
      if (!proofComplete(proof)) return await this.unknown(key, 'SUPERSEDE_QUIESCENCE_UNPROVEN', 'superseded-quiescence-unproven', batch, context);
      await this.ledger.burnHead(key, { failureCode: SUPERSEDED_AT_SAFE_POINT });
      const windows = await this.engine.archiveFailure(batch, SUPERSEDED_ARCHIVE_REASON);
      const linux = await this.companion.archiveLinux(batch, SUPERSEDED_ARCHIVE_REASON);
      archiveCheck(windows && windows.verified === true && linux && linux.verified === true, 'FAILURE_ARCHIVE_UNCONFIRMED', windows);
      // stage: the last stage that ran (executed-heads.mjs#mayHavePublished): 1 before the workspace (nothing after stage 1
      // published, unless stage R relayed a role, which its plan says); 8 at parking point B (stages 3, 5 and 7 published).
      await this.ledger.terminal(key, 'FAILED_CLEAN', { failureCode: SUPERSEDED_AT_SAFE_POINT, basis: 'superseded-live-read', safePoint, stage, batchId: batch?.batchId ?? null,
        windows: windows.directory, linux: linux.directory, class: 'clean-final', retry: 'new-commit', breaker: 'neutral', liveHeadSha: live.headSha, liveState: live.state });
      await this.receipt('batch-terminal', { key, outcome: 'FAILED_CLEAN', failureCode: SUPERSEDED_AT_SAFE_POINT, safePoint });
      this.reportOutcome(subject, 'FAILED_CLEAN', { code: SUPERSEDED_AT_SAFE_POINT, key });
      // At B only Windows was touched since the parking told the breaker about stages 1-7 (review of step 2, M2).
      return { state: 'FAILED_CLEAN', key, failureCode: SUPERSEDED_AT_SAFE_POINT, safePoint,
        settle: { kind: 'burned', code: SUPERSEDED_AT_SAFE_POINT, klass: 'clean-final', breaker: 'neutral', pos, ...(stage === 8 ? { windowsOnly: true } : {}) } };
    } catch (error) {
      return this.unknown(key, codeOf(error), 'superseded-end-unconfirmed', batch, { ...context, ...archiveFacts(error) });
    }
  }

  // opts.linux false: the batch never reached Linux (released before stage 1), so only Windows is archived.
  async closeOrThrow(batch, opts = null) {
    const closed = await this.engine.closeBatch(batch, opts);
    archiveCheck(closed && closed.verified === true, 'UNEXECUTED_CLOSE_UNCONFIRMED', closed);
  }

  // extra: further facts of the terminal record (an Owner abort's safe point, stage and stop code).
  // DESIGN §33: extra.windowsArchiveCode (the Windows archive's own refusal, archiveFacts) is written to the HALT facts, the terminal
  // record (it rides in extra) and the batch-terminal receipt: only when it is a fixed code.
  async unknown(key, failureCode, basis, batch = null, extra = {}) {
    const archive = archiveFacts(extra);
    await this.haltWith(failureCode, { key, basis, ...archive }); // HALT first: no crash point leaves a closed unknown without it (N1)
    const s = await this.ledger.state(key);
    if (['RESERVED', 'STARTED', 'INCOMPLETE'].includes(s.state)) {
      await this.ledger.burnHead(key, { failureCode });
      await this.ledger.terminal(key, 'FAILED_UNKNOWN', { ...extra, failureCode, basis, batchId: batch?.batchId ?? s.started?.facts?.batchId ?? null });
    }
    await this.receipt('batch-terminal', { key, outcome: 'FAILED_UNKNOWN', failureCode, ...archive });
    await this.haltWith(failureCode, { key, basis, ...archive });
    this.reportOutcome(s.reserved?.subject ?? this.current, 'FAILED_UNKNOWN', { code: failureCode, key });
    return { state: 'HALTED', key, failureCode };
  }
}
