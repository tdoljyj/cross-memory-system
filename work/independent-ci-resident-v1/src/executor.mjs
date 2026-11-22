import { boundedNotice, budgetNotice } from './budget-alert.mjs';
// Resident executor state machine (runs inside the CluedCIResident service).
//
// One tick: crash recovery first (always), then the Owner's own requests (re-arm, resume) from the
// admin-only owner directory, then HALT / PAUSE, then bounded untrusted triggers. The oldest
// candidate is pre-checked without any secret or network access, reserved in the ledger and driven
// through the installed Source's eight fixed stages. Live authority (GitHub PR facts, KooYomi
// admission, Owner grants, merge queue) is decided inside the stages by the existing reviewed helpers
// that run as clued-control; this module never sees a secret.
//
// Order of one batch:
//   reserve -> derive -> companion bundle -> stage 1 (admission) -> markStarted (burns the head) ->
//   15-relay-wait (t0, batch; the record keeps its historic name) -> 20-plan-intent -> 25-plan (every heavy role local) ->
//   [Linux workspace preparation] -> execution + publication stages of the heavy roles ->
//   stage 8 -> close (success-path archive) -> COMPLETED
// Before markStarted nothing touched Linux, no scanner ran and no success check was published, so a
// bundle failure or a stage-1 "not admitted" releases the reservation instead of burning the head.
// The hosted relay (stage R, the hosted wait and its hints, the relay qualification hold) is removed (Owner 2026-11-14,
// DESIGN §76): it was never switched on. The plan records keep their fields (candidates [], relayed [], every role local with
// RELAY_DISABLED), byte for byte what relay.enabled = false wrote, so every reader of older ledger entries stays as it was.
// Stage 1's HEAD_PUBLISHED_ON_GITHUB ends the batch cleanly, after which the head is recorded as executed.
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
//   - a batch whose PR got a newer commit is released before stage 1 (SUPERSEDED, nothing burned). After stage 1 one rule decides
//     (DESIGN §72, ADR 0027): a batch stands only while its PR is open, the PR's head is the batch's head and this node holds
//     ci-admission; at every safe point outside the Linux preparation, and on every tick for a batch resting at A or B (under PAUSE
//     too), one that is known not to stand ends one way (SUPERSEDED_AT_SAFE_POINT: the Owner abort's quiescence and rename-only
//     archive, the head burned, never an attempt 2). When stage 1 or the bundle proves the batch head is no longer the PR's head, one
//     live read may restore a superseded, unburned commit as the PR's current one. A live read only ever stops or re-queues.
//
// Phase 2, step 2 (parking; design v0.5 §4.3, §4.8, §4.9; Owner decision e1e19e2e item 4; DESIGN §18):
//   - a batch rests at parking point A (the hosted wait) or B (after the last role stage and the close archive on both
//     hosts, before stage 8) with nothing of it running and Linux empty; other batches run meanwhile. A tick runs at most
//     one Linux exclusive zone (workspace preparation to the last Linux stage), and never parks inside one;
//   - at B, stage 8 runs as tries: one check (Source v2 STAGE8_CHECK_MS) that, when the claim is not at the merge-queue
//     head yet, ends with zero side effects and a named reason; the batch parks again and is tried on its own back-off
//     (10, 20, 40, 80, 120 minutes, 1 minute when its claim is first in the queue) for at most park.stage8MaxTries tries
//     and park.maxMs. At either budget it sleeps until a change; main moving (RESIDENT_BASE_MOVED) ends that base;
//   - at most park.maxParked batches rest at A or at B in the queue's first two places; others at B are bounded by
//     park.maxParkedOutsideTop2. Sleeping batches take no places; excess active batches release at the safe point;
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
// result so the probe still runs): triggers are still read; a batch at a parking point of a STANDBY node no longer stands and ends by
// the rule of DESIGN §72 (UNCERTAIN is no answer: it waits). A failure that may mean the role is gone makes the next probe due at once
// (roleProbe.urgent).
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
//
// The merge train on (step 3c-2b, DESIGN §41; policy /8, train.mjs). With train.enabled 'shadow' (or a /7 policy) nothing below
// changes what runs. With 'on':
//   - stage 10 runs only on an ACTIVE node (STANDBY and UNCERTAIN: the status says NOT_ON_DUTY), in mode 'on'; under PAUSE (and
//     an intake pause) in mode 'revoke-only', right before the tick returns PAUSED; never under HALT. Its train run (/2) carries
//     the installed train settings, onSince (when this node became eligible: the change to on, or STANDBY -> ACTIVE,
//     whichever is later, kept across restarts and UNCERTAIN spells by receipt 'train-duty'; a new one is due at once), the front
//     outcome to report (frontOutcome: a front batch that finally failed for the PR itself, failure table deterministic-pr, no
//     attempt 2; carried until stage 10 reports it) and an accepted revoke-head request; under an intake pause it runs revoke-only
//     whatever the queue holds;
//   - its facts /2 may report side effects: a normal ending; a requestPause latches PAUSE (and tells the Owner); a confirmed
//     OPEN_FRONT_BATCH is the ONLY producer of a subject with S (queue.mjs#offerFront, at most FRONT_BATCHES_PER_HEAD per head);
//     TRAIN_SOURCE_MISMATCH and TRAIN_SOURCE_UNREADABLE defer every new batch, and so does an eligible node until a run says its
//     full sweep in on mode is complete since this onSince (the take-over sweep comes before any publication: parked batches wait
//     too); a front batch's automatic attempt 2 is one of its head's two front batches; with nonFrontRuns false only the front
//     subject runs; the front rows of a duty that ended (STANDBY, train not on) are dropped;
//   - localPlan keeps every role of a subject with S local (RELAY_TRAIN_FRONT_LOCAL) before writing 20-plan-intent;
//   - HALT, PAUSE and the intake pause are written into the status board in the same tick they are latched or lifted.
// requests\ also carries the "立即探测" and "撤车头" requests (resident-requests.mjs).
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EARLIER_BOOT_MARGIN_MS, uptimeMs } from './instance-lock.mjs';
import { Ledger, MAX_TRIES, QUOTA_TIER_EVALUATION, UNCAPPED_RELEASES, batchKey, headKey } from './ledger.mjs';
import { CLAIM_REASONS, RELEASE_BACKOFF_MS } from './queue.mjs';
import { ABORTABLE_IN_FLIGHT, BRIDGE_ABANDONED_UNPUBLISHED, EXECUTOR_RESTARTED_UNPUBLISHED, NOT_ADMITTED_CODES, OWNER_ABORTED, UNEXECUTED_REASON_RULES, abortStageEndingClean, archiveReason, decideFailure, failureRow,
  networkFailure, proofComplete, scannerAbandonEligible } from './classify.mjs';
import { BUNDLE_NETWORK_UNAVAILABLE, RESIDENT_BASE_MOVED, TRAIN_BATCH_MEMBER_MOVED } from './companion.mjs';
import { parseTrigger } from './trigger.mjs';
import { POSITIONS, breakerGate, breakerOf, breakerProbe, breakerRecord, breakerRelease, breakerView, positionOf } from './breaker.mjs';
import { batchBudgetMs } from './policy.mjs';
import { attempt2Decision, attempt2Subject } from './attempts.mjs';
import { EXECUTION_RETRY_STAGES, RELAY_TRAIN_FRONT_LOCAL, STAGE2_RETRY_KEEPS_ABANDONED, executionRetryable, noLaunchRetryable, STAGE1_TRANSIENT_RELEASE_CODES } from './classify.mjs';
import { HEAVY_ROLES, RELAY_STAGE, ROLE_STAGES, trainSettings, trainSweepMode, trainLandingMode } from './policy.mjs';
import { PROBE_REQUEST_CONTRACT, RESIDENT_REQUEST_CONTRACTS, REQUEST_MAX_AGE_MS, validateResidentRequest } from './resident-requests.mjs';
import { ALERT_RECEIPT } from './retention.mjs';
import { NODE_RESOURCE_HOLDER } from './host-capacity.mjs';
import { stageHeadScans } from './head-scans.mjs';
import { CODE, HEX40, HEX64, ResidentError, canonicalJson, check, digest, exactKeys, parseBoundedJson, sha256 } from './canonical.mjs';
import { UPGRADE_RESUME_CONTRACT, validateUpgradeResume } from './upgrade-mailbox.mjs';
import { ARCHIVE_LINUX_REQUEST_MS, CHECK_REFS_REQUEST_MS, PREPARE_WORKSPACES_REQUEST_MS, REBUILD_BUNDLE_REQUEST_MS } from './mailbox.mjs';
import { INTAKE_PAUSE_CONTRACT, INTAKE_PAUSE_MAX_MINUTES, INTAKE_RESUME_CONTRACT, IntakePause, UNCONFIRMED_HOLDER } from './intake-pause.mjs';
import { TRAIN_STAGE } from './policy.mjs';
import { classifyFailure } from './classify.mjs';
import { FRONT_BATCHES_PER_HEAD, TRAIN_OWNER_NOTICE_DECISIONS, TRAIN_SCHEDULE_DEFERRALS, chainOfFront, openFrontBatchOf, strictCoverageMatches, strictFrontReadinessMatches, TRAIN_RECHECK_DECISIONS, trainDue, trainFrontRecheckNext, trainIdleExtraDue, trainNodesView, trainRunInput, trainRunMode, trainSummary, trainSweepView, claimBindingObservationOf } from './train.mjs';
import { ROLE_PROBE_CODES, RoleProbe, roleBookFact, validateRoleProbeFact } from './role-probe.mjs';
import { NODE_MODES, leaseShort } from './status.mjs';
import { RevocationMaintenanceBook,validateRevocationFacts,validateRevocationQualification,
  REVOCATION_RUN_MS,REVOCATION_HELPER_MARGIN_MS,REVOCATION_RUN_ID } from './revocation-maintenance.mjs';

export const PAUSE_CONTRACT = 'clued.independent-ci.resident-pause/1';
// Defect 8f8240ff: the service's between-batches step (archive retention, which may delete) runs beside the loop; while it runs the
// loop says so in tick({ betweenBatchesRunning }) and no new batch opens (DEFERRED with this reason), as when the loop waited for it.
// Pause, stop and the Owner's requests are served meanwhile.
export const BETWEEN_BATCHES_RUNNING = 'BETWEEN_BATCHES_RUNNING';
export const REARM_CONTRACT = 'clued.independent-ci.resident-owner-rearm/1';
export const DRAIN_CONTRACT = 'clued.independent-ci.resident-owner-drain-parked/1';
export const RESUME_CONTRACT = 'clued.independent-ci.resident-owner-resume/1';
export const ABORT_CONTRACT = 'clued.independent-ci.resident-owner-abort/1';
// Generation 10 (DESIGN 53.4): the Owner's early release of an open breaker (rearm-resident.ps1 -Request ReleaseBreaker -Reason ...).
export const BREAKER_RELEASE_CONTRACT = 'clued.independent-ci.resident-owner-breaker-release/1';
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
// The disk/memory guard's own intake hold (nodeResourceRefresh): 30 minutes, renewed below 20 left, so a node that stops beating
// leaves at most a short hold behind for the server's take-over to respect.
export { NODE_RESOURCE_HOLDER };
export const NODE_RESOURCE_HOLD_MINUTES = 30;
export const NODE_RESOURCE_RENEW_BELOW_MS = 20 * 60_000;
export const OWNER_ABORT_ARCHIVE_REASON = 'owner-aborted';
// Poll of the owner directory while a scanner-issuer stage runs, and the bounded re-check of quiescence after an abort.
export const ABORT_POLL_MS = 5_000;
export const ABORT_QUIESCENCE_ATTEMPTS = 9;
export const ABORT_QUIESCENCE_POLL_MS = 20_000;
export const ABORT_QUIESCENCE_WAIT_MS = 5 * 60_000;
// DESIGN §71: the same re-check after a reboot, longer (the companion and WSL come up after the service), and its fixed archive reason.
export const RESTART_QUIESCENCE_WAIT_MS = 15 * 60_000;
export const RESTART_QUIESCENCE_ATTEMPTS = 45;
export const RESTART_ARCHIVE_REASON = 'restarted-unpublished';
// DESIGN §71: was the executor lock last held in an earlier boot? Read by the service right before it takes the lock over, with the
// instance lock's own rule (instance-lock.mjs: the holder's, or its own liveness record's, uptime more than EARLIER_BOOT_MARGIN_MS above
// this boot's; that module is part of the upgrader's frozen copy and stays unchanged). One-way: no lock or anything unreadable is false.
export async function lockHeldInEarlierBoot(stateRoot, { uptime = uptimeMs } = {}) {
  const read = async name => { try { return JSON.parse(await fs.readFile(path.join(stateRoot, 'executor.lock', name), 'utf8')); } catch { return null; } };
  const at = r => (Number.isSafeInteger(r?.uptimeMs) && r.uptimeMs >= 0 ? r.uptimeMs : -1);
  const holder = await read('holder.json'), alive = await read('alive.json');
  const recorded = Math.max(at(holder), holder && alive?.token === holder.token ? at(alive) : -1);
  return recorded > uptime() + EARLIER_BOOT_MARGIN_MS;
}
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
// How often the tick's report reads the daily budgets when no scheduling pass did (reportLimits).
export const LIMITS_REFRESH_MS = 60_000;
// The global deferrals of a scheduling pass (precheck, trainGate) that hold every row: kept on the status (queue.hold) from the pass
// that met one until a pass that got past it or until batch work starts (atStage: a new batch, one going on from A, a stage-8 try),
// also while a batch only rests at A (review rounds 25 and 26).
export const SCHEDULE_HOLDS = Object.freeze(['COMPANION_NOT_READY', VERSION_SKEW, ...TRAIN_SCHEDULE_DEFERRALS]);
const TRAIN_HELD_REASONS = Object.freeze(['INTAKE_PAUSED', 'INTAKE_PAUSE_UNCONFIRMED']);
// The train on: the newest front-batch receipts read back at a start (per head, whatever their age; review R3 MINOR 11).
const FRONT_RECOVER_RECEIPTS = 512;
// The train on with nonFrontRuns false (policy /8, DESIGN §41.9 item 6): every row but the front's waits, shown with this reason.
export const TRAIN_NON_FRONT_DEFERRED = 'TRAIN_NON_FRONT_RUNS_OFF';
// Defect a8910e41: the head this duty's take-over binding run bound runs no ordinary batch while the duty lasts, shown with this reason.
export const TRAIN_FRONT_BOUND_DEFERRED = 'TRAIN_FRONT_BOUND_HEAD';
// Generation 19 field defect (DESIGN §62.4): the clean end of a take-over binding run right after its stage 1 (the queue head's claim is
// bound to its PR now; the front batch is stage 10's to open). Resident-side, never Source-mirrored.
export const TRAIN_FRONT_CLAIM_BOUND = 'TRAIN_FRONT_CLAIM_BOUND';
// Task ad19ef19 (DESIGN §62.5): the clean end of an ordinary batch (no S) resting at a parking point when stage 10 opens the front batch
// of the same PR and head. In train on its stage 8 can never publish the merge slot (trainHeadDecision wants a front job), yet its row
// kept the PR busy, so the front batch was refused (TRAIN_FRONT_PR_BUSY) while stage 10 had already counted it and touched running.
export const TRAIN_FRONT_TAKES_OVER = 'TRAIN_FRONT_TAKES_OVER';
const FRONT_BIND_ASKED_MAX = 512;
const FRONT_BIND_ASKED_PER_HEAD = 2;
// Generation 22 field defect (PR #1029): a front batch's stage 8 needs the strict proof stage 10 wrote (sweepFreshMs); one with less than
// this left right before stage 8 (or none any more) is refreshed by a stage-10 run first (stage8Try).
export const FRONT_PROOF_MARGIN_MS = 3 * 60_000;
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
      refsNoAnswer: result?.refsNoAnswer === true,
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
// DESIGN 51: the scanner publisher stages and how long the resident waits before it runs one again after it ended clean without writing
// anything because GitHub / Native were passingly unavailable (1 run + 3 repeats, at most 7 minutes more, inside the stage's own limit).
export const PUBLICATION_RETRY_STAGES = Object.freeze([3, 5, 7]);
export const PUBLICATION_RETRY_MS = Object.freeze([30_000, 90_000, 300_000]);
// Generation 11 (DESIGN 54; stage 2: generation 14, DESIGN 59): the waits before an execution stage (2, 4, 6) runs again in the same batch (classify.mjs#executionRetryable);
// two runs again at most, each its own stage run with its own cap.
export const EXECUTION_RETRY_MS = Object.freeze([60_000, 300_000]);
// Generation 13 (DESIGN §57.3, Task 3e2e12d7): the waits before the second bundle of a batch resumed from parking point A is built again
// after a network failure (the Source moves the failed gen-2\ aside); two builds again at most, then the batch ends as before.
export const REBUNDLE_NETWORK_RETRY_MS = Object.freeze([60_000, 300_000]);
// What a run again needs before its wait: the bounded quiescence proof and the two archives (each at its own request bound).
const EXECUTION_RETRY_PREPARE_MS = ABORT_QUIESCENCE_WAIT_MS + 2 * ARCHIVE_LINUX_REQUEST_MS;
// The refs gate's facts (DESIGN 55) for a stage-terminal receipt: only when it asked more than once or stopped asking; checked shapes only.
const refsGateFacts = r => {
  const g = r?.refsGate;
  if (!g || !Number.isSafeInteger(g.asks) || g.asks < 1 || g.asks > 3) return {};
  const refused = typeof g.waitRefused === 'string' && /^[a-z-]{1,20}$/.test(g.waitRefused) ? g.waitRefused : null;
  return g.asks > 1 || refused ? { refsGate: { asks: g.asks, waitRefused: refused } } : {};
};
// An archive directory (either host) named for exactly this reason: failed-<batch>-<reason>-<12 hex nonce>, with or without a path.
const archiveNamedFor = (directory, reason) => typeof directory === 'string'
  && new RegExp(`(?:^|[\\\\/])failed-[0-9a-z]+-${reason}-[0-9a-f]{12}$`).test(directory);
// Only the entry's own flag decides (never a code): a clean BLOCKED with zero side effects that published nothing, on a runner that read back
// as the original and a Windows tree at zero.
// Generation 28 (docs/adr/0015, defect 664cc8eb): or a withdrawal for unavailability only (PUBLICATION_REVOKED whose entry says republishSafe: the
// check was withdrawn and the withdrawal read back, because GitHub or Native could not be read to confirm it, with no change of the
// authorization observed). The next run of the stage publishes the role again under a new identity, completely re-proven (Source
// staged-check-publisher-v2.mjs, republication); the same back-off and the same three repeats bound it.
export const publicationRetryable = (number, r) => PUBLICATION_RETRY_STAGES.includes(number) && r?.ok === false && r.proof?.windowsTreeZero === true
  && r.proof?.serviceOriginalStopped === true && ((r.outcome?.status === 'BLOCKED' && r.outcome.sideEffects === 0 && r.outcome.mayHavePublished === false
  && r.outcome.safeToRerun === true) || (r.code === 'PUBLICATION_REVOKED' && r.outcome?.status === 'REVOKED' && r.outcome.republishSafe === true));
// A backfill that keeps failing transiently (not a refused source) HALTs after this long (an antivirus or backup lock
// of a few minutes only defers it).
export const BACKFILL_PENDING_MAX_MS = 30 * 60_000;
const NO_STATUS = Object.freeze({ update() {}, setState() {}, setCurrent() {}, outcome() {}, setPending() {} });

// Phase 2, step 1 (DESIGN §17).
export const SUPERSEDED_AT_SAFE_POINT = 'SUPERSEDED_AT_SAFE_POINT';
export const SUPERSEDED_ARCHIVE_REASON = 'superseded';
// DESIGN §72 (4): the upgrader's intake hold (upgrader/src/resident-ports.mjs HOLDER_UPGRADE, frozen surface A11; the resident package
// cannot import the upgrader's files, a test pins the two equal) and the basis of a resting batch ended for its drain.
export const UPGRADE_HOLDER = 'resident-upgrade';
export const UPGRADE_DRAIN_BASIS = 'upgrade-drain';
// The status code of a reservation released for a newer commit before stage 1 (release reason SUPERSEDED).
export const BATCH_SUPERSEDED = 'BATCH_SUPERSEDED';
// The code of a new-trigger notice whose protected observation found changed claim/authorization conditions after a refusal (recheckClaims; field defect
// 2026-11-08, PR #1039): the PR page says the head is evaluated again now, not after the cool-down.
export const CLAIM_CHANGED = 'CLAIM_CHANGED';
// What one batch usually takes (design v0.5 §1: 17.5 to 24 minutes): only the status board's estimate.
export const ETA_BATCH_MS = 22 * 60_000;
// Queue rows looked at in one tick (an ignored or deferred row does not end the tick; this bounds the work).
export const ROWS_PER_TICK = 16;
// Endings after which the batch head may no longer be the PR's head (falsification, queue.mjs#restore): stage 1 saw the
// PR changed or closed, the refs moved since the bundle, or the bundle failed.
export const FALSIFYING_CODES = Object.freeze(['PR_NOT_OPEN_OR_CHANGED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 'BUNDLE_UNAVAILABLE']);
export const FALSIFYING_REASONS = Object.freeze(['pr_subject_changed', 'pr_files_changed']);
// The rule's live read of a batch's PR (DESIGN §72) happens at most this often per batch and named head (independent review of step
// 1, m9): a resting batch's own cadence, and the bound on a hint that names the same head again.
export const SUPERSEDE_LIVE_READ_MS = 10 * 60_000;
// Ticks in a row the queue could not be written before the Owner is told (re-review N2).
export const QUEUE_SAVE_ALARM = 3;
// Phase 2, step 2: stage 8 not ready, with zero side effects (Source v2 publisher STAGE8_NOT_READY_REASONS).
export const STAGE8_NOT_READY_CODES = Object.freeze(['RESIDENT_BASE_MOVED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED',
  'REQUIRED_CHECK_FAILED', 'REQUIRED_CHECKS_UNREADABLE',
  // Phase 2, step 3a: main's live branch rules, GitHub's test merge, the green ledger (all before any journal write).
  'RULESET_UNREADABLE', 'STRICT_OFF_WITHOUT_TRAIN', 'MERGE_METHODS_NOT_MERGE_ONLY', 'TRAIN_TEST_MERGE_NOT_READY', 'GREEN_LEDGER_UNAVAILABLE',
  // Step 3c-2b (DESIGN §41.2): the single green is not proven; the batch rests at B until the next stage 10. The stage
  // directory's train mode could not be read for a front job: it rests at B too.
  'TRAIN_SINGLE_GREEN_NOT_PROVEN', 'TRAIN_MODE_UNREADABLE',
  // ADR 0018 (push): S's other-App checks still running, main's rules not yet set, the fast-forward refused while main is still T.
  'TRAIN_LANDING_CHECKS_PENDING', 'TRAIN_LANDING_RULES_MISSING', 'TRAIN_LANDING_REFUSED']);
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
// Generation 12 (DESIGN §56.2): the queue watch of batches parked at B for the merge queue.
// QUEUE_WATCH_MS: the least gap between the end of any role probe (a watch or not) and the next watch, so a tick runs at most one
// swap for the two. Each batch is watched again after QUEUE_WATCH_RAMP_MS[i].every while it has rested at B less than .until
// (30 s for its first 30 minutes, then 2 minutes up to 2 hours, then 5 minutes), and after a watch that gave no definite answer
// (uncertain, or deferred while the runner was busy) after at least QUEUE_WATCH_FAIL_MS[failures in a row - 1].
export const QUEUE_WATCH_MS = 30_000;
export const QUEUE_WATCH_RAMP_MS = Object.freeze([{ until: 30 * 60_000, every: 30_000 }, { until: 2 * 60 * 60_000, every: 2 * 60_000 }, { until: Infinity, every: 5 * 60_000 }]);
export const QUEUE_WATCH_FAIL_MS = Object.freeze([30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000]);
export const QUEUE_WATCH_MAX_PER_DAY = 1440;
export const QUEUE_WATCH_VIEW_MS = 90_000;
export const QUEUE_WATCH_CODES = Object.freeze(['RESIDENT_MERGE_QUEUE_NOT_JOINED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED']);
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
// Rule 41ab823a: at most this many front batches' stage-1 scan facts are kept between their stage 1 and their plan (normally one).
export const FRONT_HEAD_SCANS_KEPT = 8;
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

// The stage-terminal receipt's summary of a stage outcome: codes and flags only.
const outcomeSummary = r => {
  const o = r?.outcome;
  if (!o && r?.brokerNoLaunch !== true) return null;
  return { status: o?.status ?? null, reason: o?.reason ?? null, sideEffects: o?.sideEffects ?? null, safeToRerun: o?.safeToRerun === true, brokerNoLaunch: r?.brokerNoLaunch === true,
    ...(o?.republishSafe === true ? { republishSafe: true } : {}),
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
  //   statusFlush (optional): async () -> writes status.json now (service-main.mjs: the status timer's flush). Generation 10 (DESIGN
  //     53.5): called when a batch is claimed and when a breaker trial starts, so the board never shows the breaker open after its
  //     trial began. Without it the status timer writes within its 15 seconds as before.
  //   companionPresence (optional): companion-presence.mjs#CompanionPresence (M5, ADR 0022 §4.5): its companion-absent notice joins the
  //     status notices. A view only.
  //   lockFromEarlierBoot (optional): true only when this start took over an executor lock held in an earlier boot
  //     (lockHeldInEarlierBoot, read by service-main.mjs right before acquireInstanceLock). DESIGN §71: only then can recovery
  //     know that no process of a batch left open still runs on Windows. Absent or false: every open batch is a crash scene.
  constructor(ports) {
    //   queue: queue.mjs#RunQueue (the run queue and the breaker's state; a view the ledger always overrules).
    for (const k of EXECUTOR_PORTS) check(ports[k], 'EXECUTOR_PORT_MISSING', k);
    Object.assign(this, ports);
    this.sleep ??= ms => new Promise(r => setTimeout(r, ms));
    this.status ??= NO_STATUS;
    this.statusFlush ??= null;
    this.nodeStatus ??= null; // optional disk/memory guard port (nodeResourceRefresh)
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
    // The train on (DESIGN §41): when this node became eligible for on-mode duty (null: it is not), whether its take-over sweep is
    // done, the newest sweep (status), the accepted revoke-head request, the front outcome owed to stage 10, the front batches
    // per head ('pr:head' -> [{ testSha, attempt }]) and per batch key (front attempt).
    this.trainOnSince = null;
    this.trainTakeoverDone = false;
    this.trainUrgent = false;
    // FABLE-keep-train-replan §3.4: a head got its admission while the train was idle; the next stage-10 run goes before batch work.
    this.trainAdmitOwed = false;
    this.trainFrontOwed = new Map(); // reconstructed from parked stage-8 tries, never from a status view
    // Defect b0426896: the mode of this duty's newest stage-10 run (trainResumeOwed).
    this.trainLastMode = null;
    this.trainSweep = null;
    // Defect 15894c2a: the nodes the newest on-mode run compared (train.mjs#trainNodesView), the status view's train.nodes.
    this.trainNodes = null;
    this.revokeHead = null;
    this.trainFrontOutcome = null;
    this.frontBatches = new Map();
    this.frontKeys = new Map();
    this.frontBindings = new Map();
    // Rule 41ab823a (DESIGN §75, Fable 2026-11-19): what a front batch's own stage 1 read on GitHub about the scans H already carries
    // (batch key -> [{ role, externalId }]), used once by its plan (frontScansReused). Memory only: lost on a restart, the batch scans.
    this.frontHeadScans = new Map();
    // Field defect PR #1035: the newest front batch offerFront refused only because the PR's row was busy (enqueueFront, trainActed).
    this.frontRetry = null;
    this.trainStrictReadiness = null;
    this.trainStrictFrontReadiness = null;
    // DESIGN §62.4: the take-over binding runs (batch key -> { pr, headSha }; kept across a restart by receipt 'train-front-bind') and
    // the held heads stage 10 was already asked about once.
    this.frontBindKeys = new Map();
    this.frontBindAsked = new Map(); // `${pr}:${headSha}` -> times stage 10 was made urgent for this head (at most FRONT_BIND_ASKED_PER_HEAD)
    // Defect a8910e41: the heads ('pr:headSha' -> when, ms) whose binding run ended TRAIN_FRONT_CLAIM_BOUND (receipt 'train-front-bound').
    // The binding run is released, not burned; this marker only holds within the duty it was set in (trainFrontBound).
    this.frontBound = new Map();
    this.trainExtraRuns = [];
    this.trainProgressConsumed = null;
    // The duty kept across restarts (receipt 'train-duty', review R3 M2): the restored one until this node is eligible again, and
    // the last one written.
    this.trainDutyCandidate = null;
    this.trainDutyKey = null;
    this.trainEligibility();
  }

  // ---- the train on: eligibility (DESIGN §41.6) ----

  // Only an ACTIVE node (an engine that cannot probe is the single node it always was) with train.enabled 'on' is eligible. onSince
  // is the change to on or the latest STANDBY -> ACTIVE (INTERFACES §2), whichever is later: a policy only changes with a
  // reinstall, which restarts the service, and the duty is kept across a restart while the policy is the same and the node did
  // not pass through STANDBY (review R3 M2, R2 M2: receipt 'train-duty', trainDutyRecover). UNCERTAIN (every start, a re-arm)
  // holds the duty, it does not end it: only STANDBY (the role went to another node) or a policy that is not on does. Becoming
  // eligible makes stage 10 due at once and holds new batches until its take-over sweep is done.
  trainEligible() { return this.policy.train.enabled === 'on' && (!this.probing() || this.nodeMode() === 'ACTIVE'); }
  trainEligibility() {
    if (!this.trainEligible()) {
      const on = this.policy.train.enabled === 'on';
      if (!on || this.nodeMode() === 'STANDBY') {
        this.trainOnSince = null; this.trainTakeoverDone = false; this.trainDutyCandidate = null; this.trainStrictReadiness = null; this.trainStrictFrontReadiness = null;
        this.trainProgressReady = false; this.trainAdmitOwed = false;
        if (this.trainSweep?.fullSinceOn === true) this.trainSweep = Object.freeze({ ...this.trainSweep, fullSinceOn: false });
        // A front row (S) belongs to the duty that ended (or to an install whose train is not on any more): it never runs
        // (review R3 MINOR 5).
        this.dropFrontRows(on ? 'TRAIN_NOT_ON_DUTY' : 'TRAIN_NOT_ON');
        this.frontRetry = null;
      }
      return;
    }
    if (this.trainOnSince !== null) return;
    this.trainUrgent = true;
    this.trainLastMode = null;
    const c = this.trainDutyCandidate;
    this.trainDutyCandidate = null;
    if (c) { this.trainOnSince = c.onSince; if (c.sweep) this.trainSweep = c.sweep; this.trainTakeoverDone = c.takeoverDone || this.trainOpenWithoutSweep(); return; }
    this.trainOnSince = this.clock();
    this.trainTakeoverDone = this.trainOpenWithoutSweep();
    this.trainProgressReady = false;
  }

  // DESIGN §65 (strict-permanent mode, Owner decision 9e2511fe): the policy's train.sweep. Only 'gate' makes the take-over full sweep a
  // condition of new batches; with 'audit' or 'off' strict stays on for good (GitHub merges H only when it contains main's tip T, and
  // merge(T, H) then has H's tree: what was tested is what lands), so the take-over is "done" from the start of the duty
  // (trainTakeoverDone then means "the take-over gate is open", not "a full sweep completed"; stage 10 never reports fullSweepSinceOn in
  // that mode, so stage 8 still greens only on the live-strict current-front proof). A rewritten main still holds new batches until a
  // round of scope all completes (§60.2). A policy change is a reinstall: a new policy digest never restores this duty (trainDutyRecover).
  trainSweepGates() { return trainSweepMode(this.policy.train) === 'gate'; }
  trainOpenWithoutSweep() { return !this.trainSweepGates() && this.trainSweep?.fullAllPending !== 'TRAIN_MAIN_REWRITTEN'; }
  // Whether a completed take-over full sweep (gate mode) covers this node's greens; the strict current-front proof then is not needed.
  trainFullCovers() { return this.trainTakeoverDone && this.trainSweepGates(); }

  // Defect b0426896 (field: after an upgrade's restart the first on run came a full maintenanceEveryMs after the resume): stage 10 is
  // owed an on-mode run at once once no pause holds any more, while this node is eligible and the newest stage-10 run of this duty was
  // revoke-only (the run under PAUSE or an intake pause spent the urgency the new eligibility had set). That is also "no on-mode run
  // yet in this duty": the urgency is only ever spent by a run, and in train on every run is on or revoke-only; a new duty (or a new
  // process) starts urgent anyway. Only the cadence is waived (trainDue's urgent): the daily cap, the intake gate, the run mode and
  // every batch gate stay as they are.
  trainResumeOwed() {
    return this.policy.train.enabled === 'on' && this.trainEligible() && this.trainOnSince !== null && this.trainLastMode === 'revoke-only';
  }

  // PR #1142: ordinary stage 8 cannot prove the train's green. Give its newly proven queue head one stage-10
  // turn before other batch work. The ledger keeps both the request and its settlement across process restarts.
  async trainFrontOpenOwed() {
    const entries = (await this.ledger.parkedEntries()).filter(e => Ledger.frontOpenOwed(e));
    this.trainFrontOwed = new Map(entries.map(e => [e.key, e.reserved.subject]));
    return this.trainEligible() && this.trainTakeoverDone && entries.some(e => {
      const s = e.reserved.subject, row = this.queue.row(s.pr);
      return row?.running?.key === e.key && row.running.headSha === s.headSha
        && ![row.current, row.running].some(r => Object.hasOwn(r ?? {}, 'testSha'));
    });
  }

  // P1b: train on, this node on duty past the take-over, and the newest on-mode stage 10 of this process named a bound front (PR and head).
  // Only orders a due run before the batch work; the cadence is unchanged. A parked batch that stage 8 found first in the merge queue is the
  // front-open debt's (trainFrontOpenOwed: on the ledger, settled by one real decision); its stage-8 fact alone is never asked again, or a
  // debt that stage 10 settled (the front left: NO_FRONT) would put stage 10 ahead of every busy tick once due.
  trainFrontWaits() {
    if (this.policy.train.enabled !== 'on' || !this.trainEligible() || !this.trainTakeoverDone) return false;
    const l = this.trainLast;
    return l?.mode === 'on' && Number.isSafeInteger(l.front?.pr) && HEX40.test(l.front?.headSha ?? '');
  }

  // Whether the take-over sweep still holds this node (eligible, not done): new batches and parked ones wait (review R3 MINOR 6).
  trainTakeoverPending() { return this.trainEligible() && !this.trainTakeoverDone; }

  // Only an S already bound by this node's enqueue receipt can use the limited scheduling exception. A PR/H match alone
  // would accidentally revive an old claim or tenure. Restart restores those bindings, but always refreshes readiness first.
  trainStrictFront(subject, { at = this.clock() } = {}) {
    if (!subject || !HEX40.test(subject.testSha ?? '') || !this.trainEligible()) return false;
    const front = this.frontBindings.get(`${subject.pr}:${subject.testSha}`);
    if (!front || front.headSha !== subject.headSha || front.baseSha !== subject.baseSha) return false;
    const context = { now: at, repo: this.policy.repo,
      // Stage 10 binds its observations to the CI Source it runs (the install record's source-manifest.json), never to the
      // resident's own Windows Source manifest (generation 21 field defect: the two always differ, so no front was ever admitted).
      sourceManifestSha256: this.policy.ciSourceManifestSha256, settingsDigest: digest(trainSettings(this.policy.train)),
      onSince: this.trainOnSince === null ? null : new Date(this.trainOnSince).toISOString(), front, sweepFreshMs: trainSettings(this.policy.train).sweepFreshMs };
    return strictCoverageMatches(this.trainStrictReadiness, context) || strictFrontReadinessMatches(this.trainStrictFrontReadiness, context);
  }

  // Generation 19 field defect (DESIGN §62.4): during the take-over sweep the merge queue's head claim may be bound to no PR (only an
  // admission stage 1 binds it, and the gate held every batch), so stage 10 could never name a front, write the strict current-front
  // observation or open a front batch. The one exception: the attempt-1 subject (no S) of exactly the PR and head that this duty's
  // newest stage 10 named as the unbound head claim's PR (frontBind: strict confirmed in that run, every node on this Source, healthy
  // store, nothing pending or unconfirmed, main not rewritten), within sweepFreshMs of that run. That run goes as far as stage 1 only
  // (frontBindEnd): it publishes the admission check and binds the claim through Native's verify; no scan or merge-slot check.
  trainFrontBind(subject) {
    if (!subject || Object.hasOwn(subject, 'testSha') || !HEX40.test(subject.headSha ?? '') || (subject.attempt !== undefined && subject.attempt !== 1)) return false;
    if (!this.trainEligible() || this.trainTakeoverDone || this.trainOnSince === null || this.trainSweep?.fullAllPending === 'TRAIN_MAIN_REWRITTEN') return false;
    // Defect a8910e41: a head bound once in this duty is never bound again in it.
    if (this.trainFrontBound(subject)) return false;
    const l = this.trainLast, b = l?.frontBind, at = Date.parse(l?.at ?? ''), now = this.clock();
    if (!b || l.mode !== 'on' || l.onDuty !== true || l.strict !== true || l.decision !== 'TRAIN_TAKEOVER_SWEEP_PENDING') return false;
    if (!(at >= this.trainOnSince) || !(now >= at) || now - at >= trainSettings(this.policy.train).sweepFreshMs) return false;
    return b.pr === subject.pr && b.headSha === subject.headSha;
  }

  // Defect a8910e41: whether this subject without S is a head this duty's binding run bound already (the marker is set when that run
  // ended TRAIN_FRONT_CLAIM_BOUND, at or after this duty's onSince). It then runs no ordinary batch and no second binding run while the
  // duty lasts; a new duty (STANDBY and back, a restart that starts a new take-over), shadow or off: the head is like any other.
  trainFrontBound(subject) {
    if (!subject || Object.hasOwn(subject, 'testSha') || !this.trainEligible() || this.trainOnSince === null) return false;
    const at = this.frontBound.get(`${subject.pr}:${subject.headSha}`);
    return Number.isFinite(at) && at >= this.trainOnSince;
  }

  // A held head stage 10 has not been asked about while it says the queue head is unbound: stage 10 is due at once, once per head
  // (bounded by the daily cap like every urgent run), so the binding run need not wait for the next routine run.
  trainAskFrontBind(rows) {
    const l = this.trainLast;
    // NO_FRONT (empty queue at the last run) counts like FRONT_NOT_BOUND: a new head must not wait out the cadence (task 60f83aa3).
    // During the take-over the head is asked on arrival (the binding run is stage 10's to name). After it, the arrival is too early (the
    // head's ordinary batch has not bound the claim yet): trainAskAfterBind asks once stage 1 has.
    if (!this.trainEligible() || this.trainTakeoverDone || l?.mode !== 'on' || !['FRONT_NOT_BOUND', 'NO_FRONT'].includes(l.wouldDo) || l.strict !== true) return;
    for (const r of rows) {
      if (Object.hasOwn(r, 'testSha') || this.trainFrontBind(r)) continue;
      if (!this.frontBindAsked.has(`${r.pr}:${r.headSha}`)) this.frontBindAskedNote(`${r.pr}:${r.headSha}`);
    }
  }

  // Counts one urgent stage-10 request for a head; false (and no urgency) once the head used FRONT_BIND_ASKED_PER_HEAD of them.
  frontBindAskedNote(k) {
    const n = this.frontBindAsked.get(k) ?? 0;
    if (n >= FRONT_BIND_ASKED_PER_HEAD) return false;
    if (n === 0 && this.frontBindAsked.size >= FRONT_BIND_ASKED_MAX) this.frontBindAsked.clear();
    this.frontBindAsked.set(k, n + 1);
    this.trainUrgent = true;
    return true;
  }

  // After the take-over: the ordinary batch of a head without S passed its stage 1 (the admission binds the claim), so stage 10 can now
  // name the front: due at once, once per head here (two per head with the arrival ask), under the daily cap like every urgent run.
  // FABLE-keep-train-replan §3.4: with the train idle (the newest run named no bound front, so trainFrontWaits does not order it) that run
  // also goes before the next batch work (trainAdmitOwed), or another PR's ordinary batch in the next tick ran first and the grouping
  // waited for it, longer than the cadence. A running batch is not cut into (the order is read at the tick's start only).
  trainAskAfterBind(subject) {
    if (this.policy.train.enabled !== 'on' || !this.trainEligible() || !this.trainTakeoverDone || !subject || Object.hasOwn(subject, 'testSha')) return;
    if (this.frontBindAskedNote(`${subject.pr}:${subject.headSha}`) && !this.trainFrontWaits()) this.trainAdmitOwed = true;
  }

  // DESIGN §62.6 (the residue of §62.5): after the take-over, train on, a head's ordinary batch (no S, attempt 1) whose stage 1 Native
  // answered with the claim first in the merge queue gives way right after that stage 1: in train on only the front batch (H, S) can get
  // the merge slot, and stage 10 opens it once the claim is bound (stage 1 just bound it), so stages 2-7 of the ordinary batch (13-15
  // minutes in the field) would be thrown away. Only with the newest on-mode stage-10 run on duty and reading strict true, and main not
  // rewritten. A head not first in the queue (or with no queue fact: Native not reached, an older Source) runs on as before; shadow and
  // off never get here. The queue fact only schedules: stage 8's live strict/holder/claim checks of the front batch are unchanged.
  trainFrontYield(subject, first) {
    if (this.policy.train.enabled !== 'on' || !this.trainEligible() || !this.trainTakeoverDone || this.trainOnSince === null) return false;
    if (!subject || Object.hasOwn(subject, 'testSha') || (subject.attempt ?? 1) !== 1 || this.trainSweep?.fullAllPending === 'TRAIN_MAIN_REWRITTEN') return false;
    const l = this.trainLast;
    if (l?.mode !== 'on' || l.onDuty !== true || l.strict !== true) return false;
    const q = first?.outcome?.status === 'SETTLED' ? first.outcome.scheduling?.mergeQueue : null;
    return q?.entered === true && q.state === 'head' && (q.position === 1 || q.position === null);
  }

  // The binding run's clean end right after its stage 1 (also when resumed after a restart): Windows only ran. Defect a8910e41: the
  // reservation is released (fail: TRAIN_FRONT_BOUND), the head is not burned, so it runs again once this duty is over (shadow, off,
  // another duty); within the duty the marker frontBound holds it (no second binding run, no ordinary batch). The front batch (H, S)
  // has its own head key. Stage 10 is due at once.
  frontBindEnd(key) {
    this.frontBindKeys.delete(key);
    this.trainUrgent = true;
    return Object.assign(new StepFailure(1, TRAIN_FRONT_CLAIM_BOUND, { windowsTreeZero: true }, 'stage', 0), { windowsOnly: true });
  }

  // The front rows (S) of the run queue that are not running are dropped (queue.mjs#dropFronts; a view, persisted with the queue).
  dropFrontRows(code) { try { this.queue.dropFronts?.(code, this.clock()); } catch { /* a view */ } }

  // The policy as the duty record names it (the same validated policy gives the same digest).
  trainPolicyDigest() { return digest(this.policy); }

  // The duty, written when it changes (policy on only: off and shadow write nothing new). Best effort: a duty that was not written
  // is a new eligibility after the next restart (a fresh take-over sweep, the safe side).
  async trainDutySave() {
    if (this.policy.train.enabled !== 'on') return;
    const onSince = this.trainOnSince === null ? null : new Date(this.trainOnSince).toISOString();
    const sweep = this.trainSweep && this.trainSweep.onSince === onSince ? this.trainSweep : null;
    const key = JSON.stringify([onSince, this.trainTakeoverDone, sweep?.fullCompletedAt ?? null, sweep?.fullSinceOn === true, this.trainStrictReadiness, this.trainStrictFrontReadiness]);
    if (key === this.trainDutyKey) return;
    try {
      await this.receipt('train-duty', { policyDigest: this.trainPolicyDigest(), onSince, takeoverDone: onSince !== null && this.trainTakeoverDone === true, sweep: onSince === null ? null : sweep,
        strictCoverage: this.trainStrictReadiness, strictFrontReadiness: this.trainStrictFrontReadiness });
      this.trainDutyKey = key;
    } catch { /* see above */ }
  }

  // Once per process (trainRecover, policy on): the newest 'train-duty' receipt, when it names this policy and an onSince, and no
  // 'node-mode' receipt after it says STANDBY. Applied at once when this node is eligible already (an engine that cannot probe);
  // otherwise kept for the next UNCERTAIN -> ACTIVE. Anything unreadable restores nothing (a new take-over: the safe side).
  async trainDutyRecover() {
    try {
      const rows = await this.receipts.latest(['train-duty', 'node-mode'], 64);
      const at = rows.findLastIndex(e => e.type === 'train-duty');
      const b = at >= 0 ? rows[at].value.body : null;
      const onSince = Date.parse(b?.onSince ?? '');
      if (!b || b.policyDigest !== this.trainPolicyDigest() || !Number.isFinite(onSince) || rows.slice(at + 1).some(e => e.value.body?.to === 'STANDBY')) return;
      // A node that ran no stage 10 for longer than a full sweep may have lost and regained the role meanwhile (another node
      // held it, then the Owner handed it back): nothing is restored, a new take-over sweep runs (round-2 review MINOR 1).
      const ran = (await this.receipts.latest(['train-run', 'train-run-intent'], 1)).map(e => Date.parse(e.value.at)).find(Number.isFinite);
      if (!(this.clock() - ran <= this.policy.train.fullSweepMaxMs)) return;
      const s = b.sweep;
      const sweep = s && typeof s === 'object' && !Array.isArray(s) && s.onSince === b.onSince && typeof s.fullSinceOn === 'boolean' ? Object.freeze({ ...s }) : null;
      const c = { onSince, takeoverDone: b.takeoverDone === true, sweep };
      if (this.trainEligible() && this.trainOnSince !== null) { this.trainOnSince = c.onSince; if (sweep) this.trainSweep = sweep; this.trainTakeoverDone = c.takeoverDone || this.trainOpenWithoutSweep(); }
      else this.trainDutyCandidate = c;
      this.trainDutyKey = JSON.stringify([b.onSince, c.takeoverDone, sweep?.fullCompletedAt ?? null, sweep?.fullSinceOn === true]);
    } catch { /* see above */ }
  }

  // null while new batches may start; otherwise the deferral stage 10 decided (DESIGN §41.6: no publication of any stage before
  // the take-over sweep; none while another node runs another Source).
  trainGate(subject = null) {
    if (!this.trainEligible()) return null;
    const refreshKey = [this.trainStrictReadiness, this.trainStrictFrontReadiness].filter(Boolean).map(r => {
      const window = this.clock() < Date.parse(r.writtenAt) ? 'future' : this.clock() >= Date.parse(r.expiresAt) ? 'expired' : null;
      return window ? `${r.proofRef}:${window}` : null;
    }).filter(Boolean).join('|') || null;
    if (refreshKey && this.trainExpiredProof !== refreshKey) {
      // A single refresh request per expired observation. A failed/unchanged refresh never creates a tick loop.
      this.trainExpiredProof = refreshKey;
      this.trainUrgent = true;
    }
    const decision = this.trainLast?.mode === 'on' ? this.trainLast.decision : null;
    // Source skew and unreadability still hold every row, even one whose previous strict proof has not expired.
    if (['TRAIN_SOURCE_MISMATCH', 'TRAIN_SOURCE_UNREADABLE'].includes(decision)) return { state: 'DEFERRED', reason: decision };
    if (this.trainSweep?.fullAllPending !== 'TRAIN_MAIN_REWRITTEN' && this.trainStrictFront(subject)) return null;
    if (this.trainFrontBind(subject)) return null;
    if (!this.trainTakeoverDone) return { state: 'DEFERRED', reason: TRAIN_SCHEDULE_DEFERRALS.includes(decision) ? decision : 'TRAIN_TAKEOVER_SWEEP_PENDING' };
    return TRAIN_SCHEDULE_DEFERRALS.includes(decision) ? { state: 'DEFERRED', reason: decision } : null;
  }

  // HALT, PAUSE and the intake pause go into the status board in the tick they are latched (DESIGN §41.6a: the companion's
  // heartbeat reports them at once); the tick's own report (reportTick) then confirms them from the ledger.
  reportLatch(patch) { this.report(s => s.update(patch)); }
  // HALT and PAUSE as the ledger has them now, set or lifted (reportTick and the start of a tick, after the Owner's requests).
  async reportLedgerLatches() {
    try {
      const halt = await this.ledger.halted(), paused = await this.ledger.paused();
      this.reportLatch({ halt: halt ? { code: CODE.test(halt.value?.code ?? '') ? halt.value.code : 'HALT_RECORD_UNREADABLE', at: halt.value?.at ?? null } : null, paused: !!paused });
    } catch { /* advisory: the tick's own report confirms it */ }
  }

  // ---- the node mode (primary/standby C3; DESIGN §29) ----

  // The mode only exists for an engine that can probe the role (the real Windows engine does). Without it the executor is the
  // single node it always was: no gate, no status node, no mode changes.
  probing() { return typeof this.engine.runRoleProbe === 'function'; }

  // An unknown value is UNCERTAIN: fail safe.
  nodeMode() { return !this.handoverProbePending && NODE_MODES.includes(this.roleProbeMode) ? this.roleProbeMode : 'UNCERTAIN'; }

  // 收回接单资格。下一次串行 tick 再复核角色，避免让班前已发出的探针用旧应答重新开批。
  requestHandoverProbe() { this.handoverProbePending = true; }

  renewalMode() {
    const role = this.nodeMode();
    return role === 'STANDBY' && this.roleProbe.last?.result !== 'not-held' ? 'UNCERTAIN' : role;
  }

  reportNode() {
    if (this.probing()) this.report(s => s.setNode?.(this.policy.node.nodeName, this.policy.ciSourceManifestSha256, this.nodeMode()));
  }

  // The mode is in force before its receipt is written (the receipt is the record, not a condition).
  async setNodeMode(to, why) {
    const from = this.nodeMode();
    if (!this.probing() || this.handoverProbePending || from === to) return false;
    this.roleProbeMode = to;
    this.reportNode();
    this.trainEligibility();
    await this.trainDutySave();
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

  // Stage timings (stage-timing.mjs): a stage-terminal receipt ends that stage's interval on the status board (the work between stages is not the stage's).
  receipt(type, body) {
    if (type === 'stage-terminal') this.report(s => s.stageDone?.(body?.stage));
    return this.receipts.append(type, body);
  }

  // Generation 11 (DESIGN 54): before an execution stage runs again in the same batch. No HALT and no drift; the installed authority
  // covers the wait, this stage again and every stage after it; quiescence on both hosts (the abort's bounded proof: the failed run's
  // worker and containers are gone); then the failed run's records are archived rename-only under retry-stage-N-K (K: this try, so each
  // run again is its own archive instance, never a replay of the one before) on both hosts (Windows: the bridge protocol records; Linux:
  // the protocol records, the role slot and the run directories, never the workspaces, which the run again needs), each archive named
  // for exactly this reason; then one receipt. false: not proven, the batch ends as before, with an execution-retry-refused receipt
  // naming the step and any archive already made.
  async prepareExecutionRetry(key, batch, number, r, again, basis) {
    const reason = `retry-stage-${number}-${again + 1}`;
    let step = 'halt', windows = null, linux = null;
    const refused = async () => {
      try { await this.receipt('execution-retry-refused', { key, stage: number, try: again + 1, basis, step, failureCode: validCode(r.code), windows, linux }); } catch { /* the refusal stands */ }
      return false;
    };
    try {
      if (await this.ledger.halted()) return refused();
      step = 'drift';
      if (await this.driftCode()) return refused();
      step = 'authority';
      if (!this.executionRetryFitsAuthority(number, again)) return refused();
      step = 'quiescence';
      const proof = await this.abortQuiescence(batch, r.proof ?? {});
      if (!proofComplete(proof)) return refused();
      step = 'archive-windows';
      const w = await this.engine.archiveFailure(batch, reason);
      if (w?.verified !== true || !archiveNamedFor(w.directory, reason)) return refused();
      windows = w.directory;
      step = 'archive-linux';
      const l = await this.companion.archiveLinux(batch, reason);
      if (l?.verified !== true || !archiveNamedFor(l.directory, reason)) return refused();
      linux = l.directory;
      step = 'receipt';
      await this.receipt('execution-retry', { key, stage: number, try: again + 1, afterMs: EXECUTION_RETRY_MS[again], basis, failureCode: validCode(r.code),
        reason: r.outcome?.reason ?? null, archive: reason, windows, linux });
      return true;
    } catch { return refused(); }
  }

  // The installed authority (policy validUntil) must still hold when the run again and every later stage of the batch are done at their
  // caps: each stage from this one on (cap plus margin), and, before the wait (afterWait false), the wait itself and what precedes it
  // (EXECUTION_RETRY_PREPARE_MS: the quiescence proof and the two archives at their bounds). After the wait only the stages are left.
  // Unknown expiry (null): no bound.
  executionRetryFitsAuthority(number, again, { afterWait = false, extraMs = 0 } = {}) {
    if (this.policy.validUntil === null) return true;
    const rest = this.policy.stages.filter(s => s.number >= number && s.number !== RELAY_STAGE && s.number !== TRAIN_STAGE)
      .reduce((sum, s) => sum + s.runMilliseconds + this.policy.limits.stageMarginMs, 0);
    return Date.parse(this.policy.validUntil) >= this.clock() + (afterWait ? 0 : EXECUTION_RETRY_MS[again] + EXECUTION_RETRY_PREPARE_MS) + extraMs + rest;
  }

  // After a wait of the refs gate (DESIGN 55): still no HALT, no drift, and the authority still covers this stage and the rest.
  // true, or why not ('halt', 'drift', 'authority', 'error'); the authority also covers the next request (`nextMs`: the refs read,
  // CHECK_REFS_REQUEST_MS, or a rebuild of the bundle and the workspaces after a network wait).
  async gateWaitStillAllowed(key, number, nextMs = CHECK_REFS_REQUEST_MS) {
    try {
      if (await this.ledger.halted()) return 'halt';
      if (await this.driftCode()) return 'drift';
      if (!this.executionRetryFitsAuthority(number, 0, { afterWait: true, extraMs: nextMs })) return 'authority';
      return true;
    } catch { return 'error'; }
  }

  // After the wait, before the run again: still no HALT, no drift, and the authority still covers it.
  async executionRetryStillAllowed(key, number, again) {
    let step = 'after-wait-halt';
    try {
      if (!(await this.ledger.halted())) {
        step = 'after-wait-drift';
        if (!(await this.driftCode())) {
          step = 'after-wait-authority';
          if (this.executionRetryFitsAuthority(number, again, { afterWait: true })) return true;
        }
      }
    } catch { /* not proven */ }
    try { await this.receipt('execution-retry-refused', { key, stage: number, try: again + 1, step }); } catch { /* the refusal stands */ }
    return false;
  }

  async waitForStageRetry(key, number, again, code, basis) {
    if (!this.executionRetryFitsAuthority(number, again) || !(await this.executionRetryStillAllowed(key, number, again))) return false;
    await this.receipt('execution-retry', { key, stage: number, try: again + 1, failureCode: code, basis, afterMs: EXECUTION_RETRY_MS[again] });
    await this.retryWait(key, EXECUTION_RETRY_MS[again]);
    return this.executionRetryStillAllowed(key, number, again);
  }

  async runWindowsStageWithRetry(key, batch, number) {
    const run = () => this.engine.runStage(batch, this.stage(number), { betweenRoles: false, firstLinux: false });
    let result = await run();
    for (let again = 0; again < EXECUTION_RETRY_MS.length && result.ok !== true && noLaunchRetryable(number, result); again++) {
      if (!(await this.waitForStageRetry(key, number, again, validCode(result.code), 'preflight-no-child'))) break;
      const aborted = number === 1 ? await this.abortIfRequested(key, batch, 'before-stage-1') : null;
      if (aborted) return { aborted };
      result = await run();
    }
    return { result };
  }
  // Generation 10 (DESIGN 53.5): status.json written now, not at the timer's next beat. A failure changes nothing (the timer still runs).
  async flushStatus() { try { await this.statusFlush?.(); } catch { /* advisory */ } }

  // Generation 10 (DESIGN 53.4): a read-only probe (the role probe, a stage-10 run) told the breaker whether the outside answered. Only an
  // open breaker of cause network listens (breaker.mjs#breakerProbe); enough probes in a row bring its trial forward to now. A view: a
  // failure here changes nothing the probe did.
  async noteBreakerProbe(ok, probe) {
    try {
      const b = breakerOf(this.queue.breaker);
      this.queue.breaker = b;
      if (b.state !== 'open') return null;
      const now = this.clock(), before = b.nextTrialAt;
      const t = breakerProbe(b, ok, this.policy, now, { github: probe === 'train-run' });
      if (t === 'early-trial') {
        // The outside answers again: rows a network release or the network cap holds back are due now (else the trial may find no
        // candidate, and the rows would wait out their own 10 minutes or a stop that only a closing breaker lifts). Only the network
        // cap's stops: any other environment stop still waits for the breaker to close.
        const { lifted, woke } = this.wakeAfterNetwork(now, { all: false });
        await this.receipt('breaker-early-trial', { probe, level: b.level, cause: b.cause ?? null, previousNextTrialAt: new Date(before).toISOString(), nextTrialAt: new Date(b.nextTrialAt).toISOString(), lifted, woke });
      }
      await this.persistQueue();
      this.reportQueue();
      return t;
    } catch { return null; }
  }

  // An open breaker's trial is due now. While closed, the same authenticated Owner request can release only unexecuted environment
  // cap stops after the fault was repaired. Neither path clears execution history or bypasses the ordinary scheduling prechecks.
  async releaseBreaker({ reason, by }) {
    const b = breakerOf(this.queue.breaker);
    if (b.state === 'closed') {
      check(this.queue.breaker === b, 'BREAKER_NOT_OPEN');
      const subjectOf = row => ({ repo: this.policy.repo, pr: row.pr, headSha: row.current.headSha, baseSha: row.current.baseSha,
        sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1,
        ...(Object.hasOwn(row.current, 'testSha') ? { testSha: row.current.testSha } : {}) });
      const candidates = this.queue.data.rows.filter(row => row.state === 'STOPPED' && row.stopKind === 'release-cap'
        && row.stopClass === 'environment' && row.current && !row.running);
      check(candidates.length > 0, 'BREAKER_NOT_OPEN');
      const eligible = new Map(), skipped = [];
      // Finish every authoritative read before changing the view: an unavailable ledger/index never grants a wake-up.
      for (const row of candidates) {
        const subject = subjectOf(row), key = batchKey(subject);
        const code = await this.ledger.headBurned(headKey(subject)) ? 'HEAD_ALREADY_EXECUTED_NO_RETRY'
          : await this.executedHeads.published(subject) ? 'HEAD_ALREADY_PUBLISHED_NO_RETRY'
            : (await this.ledger.state(key)).state !== 'ABSENT' ? 'CONTENT_ALREADY_EXECUTED_NO_RETRY' : null;
        if (code) skipped.push({ pr: subject.pr, headSha: subject.headSha, code });
        else eligible.set(row, key);
      }
      check(this.queue.breaker === b && b.state === 'closed', 'BREAKER_STATE_CHANGED');
      const lifted = this.queue.liftEnvironmentStops(this.clock(), { eligible: row => !row.running
        && eligible.get(row) === batchKey(subjectOf(row)) });
      await this.persistQueue();
      this.reportQueue();
      await this.flushStatus();
      return { by, reason, mode: 'closed-environment-recovery', level: b.level, cause: b.cause ?? null,
        openedAt: Number.isSafeInteger(b.openedAt) ? new Date(b.openedAt).toISOString() : null,
        previousNextTrialAt: null, nextTrialAt: null, lifted, woke: [], skipped };
    }
    this.queue.breaker = b;
    const r = breakerRelease(b, this.clock());
    check(r.released === true, r.code ?? 'BREAKER_NOT_OPEN');
    // The Owner says the fault is gone: every environment stop is lifted, as a closing breaker does (DESIGN 53.4, 53.8).
    const { lifted, woke } = this.wakeAfterNetwork(this.clock(), { all: true });
    // Like every breaker change the queue file is a view: the release is in force in memory now; a file that cannot be written now
    // is written by the next batch end (the trial itself), never a reason to refuse what already took effect.
    await this.persistQueue();
    this.reportQueue();
    await this.flushStatus();
    return { by, reason, level: r.level, cause: r.cause, openedAt: Number.isSafeInteger(r.openedAt) ? new Date(r.openedAt).toISOString() : null,
      previousNextTrialAt: new Date(r.previousNextTrialAt).toISOString(), nextTrialAt: new Date(b.nextTrialAt).toISOString(), lifted, woke };
  }

  // Generation 10: the policy's breaker.network (contract /9), or null.
  networkPolicy() { return this.policy.breaker?.network ?? null; }

  // Generation 10 (DESIGN 53.4): stops lifted (all: every environment stop, the Owner's release; else only the network cap's, the probes),
  // network back-offs due now (queue.mjs). A view.
  wakeAfterNetwork(now, { all }) {
    let lifted = [], woke = [];
    try { lifted = all ? this.queue.liftEnvironmentStops(now) : this.queue.liftNetworkStops(now); woke = this.queue.wakeNetworkRows(now); } catch { /* a view */ }
    return { lifted, woke };
  }

  // The status board is a view: a failure to update it never changes what the executor does.
  report(fn) { try { fn(this.status); } catch { /* advisory */ } }
  reportOutcome(subject, outcome, { code = null, row = null, key = null, retry = row?.retry ?? null } = {}) {
    this.report(s => s.outcome({ pr: subject?.pr, headSha: subject?.headSha, attempt: subject?.attempt ?? 1, outcome, code, klass: row?.class ?? null, retry, key,
      pushedAt: outcome === 'COMPLETED' ? this.firstSeenAt(subject) : null }));
  }
  // The head's first sighting by the queue (ms), the push as far as the resident sees it (status timing: push to first green).
  firstSeenAt(subject) {
    try { const c = this.queue.row(subject.pr)?.current; return c?.headSha === subject.headSha && Number.isSafeInteger(c.firstAt) ? c.firstAt : null; } catch { return null; }
  }

  async haltWith(code, facts) {
    if (await this.ledger.halt(code, facts)) {
      this.reportLatch({ halt: { code: CODE.test(code ?? '') ? code : 'HALT_RECORD_UNREADABLE', at: new Date(this.clock()).toISOString() } });
      await this.receipt('halt', { failureCode: code, facts });
    }
  }

  // Crash recovery runs at the start of every tick, halted or not. At that point this single-threaded
  // loop has no batch in flight, so any open entry was left by a crash or an aborted tick: its
  // processes may still exist, so it is UNKNOWN and HALT is latched (once). The one exception (DESIGN §71): a batch an earlier boot
  // left open, proven unpublished and quiet on both hosts, is closed FAILED_CLEAN and runs again as its attempt 2.
  async recover() {
    // A batch that only waits for hosted signals runs nothing: it is resumed by tick(), never a crash scene.
    let open = await this.ledger.crashed();
    // A stage R that began (20-plan-intent) without its 25-plan may have begun a relay key: UNKNOWN, HALT. An entry
    // with an accepted Owner abort and no terminal was interrupted in the middle of the abort: UNKNOWN, HALT.
    // An entry with the executor's own 81-self-abort and no terminal was interrupted in the middle of that end (phase 2).
    const codeFor = entry => (entry.planIntent && !entry.plan ? 'RELAY_STAGE_INTERRUPTED' : entry.abort ? 'OWNER_ABORT_INTERRUPTED' : entry.selfAbort ? 'SUPERSEDE_INTERRUPTED' : 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH');
    // DESIGN §71: the entries open at this process's first recovery after it took over a lock from an earlier boot were left by that
    // boot (no executor ran in this one before this process). When every open entry is such a plain interrupted batch, each one proven
    // unpublished and quiet is closed FAILED_CLEAN with its attempt 2; whatever is left goes the old way below.
    this.priorBootKeys ??= new Set(this.lockFromEarlierBoot === true ? open.map(e => e.key) : []);
    if (open.length > 0 && open.every(e => this.priorBootKeys.has(e.key) && codeFor(e) === 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH')) {
      for (const entry of open) await this.restartedUnpublished(entry);
      open = await this.ledger.crashed();
    }
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

  // DESIGN §71: one batch an earlier boot left open. Closed FAILED_CLEAN EXECUTOR_RESTARTED_UNPUBLISHED (stage 1 when it had not
  // started, else 2), with the head's one attempt 2, only when it is proven to have published nothing: a plain interrupted entry (not
  // parked, no abort or self-abort, no stage R without its plan), no relayed role, no "may have published" record of its head but its
  // own "before stage R" one when its plan relayed nothing (stages R, 3, 5, 7 and 8 each write one first: executed-heads.mjs), no HALT,
  // the installed bytes unchanged, and quiescence on both hosts, re-checked for up to RESTART_QUIESCENCE_WAIT_MS. Windows processes of
  // the earlier boot are gone (the caller only passes such entries). Linux is archived only after 10-started (before it nothing of the
  // batch reaches Linux, DESIGN §24.4). Anything not proven writes nothing here, and the caller's old path closes it UNKNOWN with a HALT.
  // A failure after the terminal record was written is thrown (recovery unconfirmed, HALT): the old path cannot close it again.
  async restartedUnpublished(entry) {
    const { key } = entry, subject = entry.reserved?.subject, code = EXECUTOR_RESTARTED_UNPUBLISHED;
    const stage = entry.state === 'STARTED' ? 2 : 1;
    let row = null, closed = null;
    try {
      if (!['RESERVED', 'STARTED'].includes(entry.state) || !subject || entry.parked || entry.abort || entry.selfAbort || (entry.planIntent && !entry.plan)) return;
      if (entry.plan && (!Array.isArray(entry.plan.relayed) || entry.plan.relayed.length > 0)) return;
      if (await this.executedHeads.published(subject) && !(entry.plan && await this.executedHeads.onlyRelayRecordOf(subject, key, RELAY_STAGE))) return;
      if (await this.ledger.halted() || await this.driftCode()) return;
      row = failureRow({ code, stage });
      if (row?.disposition !== 'burn') return;
      const batch = { key, batchId: entry.started?.facts?.batchId ?? null };
      if (entry.state === 'STARTED' && batch.batchId === null) return;
      closed = await this.provenCleanEnd(key, batch, { stageProof: {}, reason: RESTART_ARCHIVE_REASON, failureCode: code, burn: true, linux: entry.state === 'STARTED',
        quiescence: { waitMs: RESTART_QUIESCENCE_WAIT_MS, attempts: RESTART_QUIESCENCE_ATTEMPTS },
        facts: (windows, linux) => ({ failureCode: code, basis: 'restart-earlier-boot-unpublished', stage, state: entry.state, batchId: batch.batchId, windows, linux,
          class: row.class, retry: row.retry, breaker: row.breaker }),
        receipt: { class: row.class, stage } });
    } catch (error) {
      if ((await this.ledger.state(key)).state === 'TERMINAL') throw error;
      return;
    }
    if (!closed) return;
    this.reportOutcome(subject, 'FAILED_CLEAN', { code, row, key });
    await this.attempt2IfEligible(key, subject, { code, stageNumber: stage, phase: 'stage', relayedRoles: 0 });
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
      let outcome, abortKey = null, releaseFacts = null;
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
        } else if (v.contract === BREAKER_RELEASE_CONTRACT) {
          exactKeys(v, ['contract', 'reason', 'by', 'requestedAt', 'nonce'], 'OWNER_REQUEST_REFUSED');
          check(SID.test(v.by) && NONCE.test(v.nonce) && !Number.isNaN(Date.parse(v.requestedAt)) && typeof v.reason === 'string' && v.reason.length > 0 && v.reason.length <= 200, 'OWNER_REQUEST_REFUSED');
          // A validated request keeps its reason in the receipts also when the service refuses it (BREAKER_NOT_OPEN).
          releaseFacts = { kind: 'breaker-release', by: v.by, reason: v.reason };
          outcome = { kind: 'breaker-release', ...(await this.releaseBreaker(v)) };
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
        await this.receipt(accepted ? 'owner-abort-unconfirmed' : 'owner-request-refused', { requestSha256, failureCode: codeOf(error), ...archiveFacts(error), ...(releaseFacts ?? {}) });
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
    const run = await this.runStageWatchedInner(key, batch, number, opts);
    if (run?.result?.relayTiming) this.report(s => s.stageRelay?.(number, run.result.relayTiming)); // the companion's relay times of this run, for the status
    return run;
  }
  async runStageWatchedInner(key, batch, number, opts) {
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

  // A retry's wait (publication, execution, a rebuild of the bundle) ends early when an Owner abort of this batch is filed: the poll
  // looks every ABORT_POLL_MS, and the caller concludes the abort at its safe point right after the wait, as before, instead of waiting
  // out up to 5 minutes (generation 13, review round 1). The poll is pendingAbort, the same read as watchAbort's: it may record a request
  // it refuses (owner-request-refused), never accepts one; a failed poll waits on.
  async retryWait(key, ms) {
    let done = false, wake;
    const woken = new Promise(resolve => { wake = resolve; });
    const poll = (async () => {
      while (!done) {
        await Promise.race([this.sleep(ABORT_POLL_MS), woken]);
        if (done) return;
        try { if (await this.pendingAbort(key)) { wake(); return; } } catch { /* the next poll looks again */ }
      }
    })();
    try { await Promise.race([this.sleep(ms), woken]); } finally { done = true; wake(); await poll; }
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
  // worker of a stopped issuer may need its own short way out). Never longer than ABORT_QUIESCENCE_WAIT_MS (or the caller's bound:
  // RESTART_QUIESCENCE_WAIT_MS after a reboot, DESIGN §71).
  async abortQuiescence(batch, stageProof, { waitMs = ABORT_QUIESCENCE_WAIT_MS, attempts = ABORT_QUIESCENCE_ATTEMPTS } = {}) {
    const until = this.clock() + waitMs;
    for (let attempt = 1; ; attempt += 1) {
      const proof = await this.proofFor(batch, stageProof);
      if (proofComplete(proof) || attempt >= attempts || this.clock() >= until) return proof;
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
  //   linux false: the batch never reached Linux (before 10-started, DESIGN §71): its quiescence is still proven, nothing is archived there.
  //   quiescence: the re-check's bounds (abortQuiescence).
  async provenCleanEnd(key, batch, { stageProof, reason, failureCode, burn, facts, receipt, linux: onLinux = true, quiescence = {} }) {
    const proof = await this.abortQuiescence(batch, stageProof, quiescence);
    if (!proofComplete(proof)) return null;
    if (burn) await this.ledger.burnHead(key, { failureCode });
    const windows = await this.engine.archiveFailure(batch, reason);
    const linux = onLinux ? await this.companion.archiveLinux(batch, reason) : { verified: true, directory: null };
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
      let pauseRequested = false;
      if (entry.bytes) {
        try {
          const v = parseBoundedJson(entry.bytes, 1024, 'PAUSE_REQUEST_REFUSED');
          if ([INTAKE_PAUSE_CONTRACT, INTAKE_RESUME_CONTRACT].includes(v?.contract)) {
            disposition = await this.takeIntakeRequest(v, sha256(entry.bytes));
          } else if (RESIDENT_REQUEST_CONTRACTS.includes(v?.contract)) {
            disposition = await this.takeResidentRequest(v, sha256(entry.bytes), entry.name);
          } else {
            exactKeys(v, ['contract', 'reason'], 'PAUSE_REQUEST_REFUSED');
            const ok = v.contract === PAUSE_CONTRACT && typeof v.reason === 'string' && v.reason.length <= 200;
            pauseRequested = ok;
            if (ok && await this.ledger.pause({ reason: v.reason, requestSha256: sha256(entry.bytes) })) {
              this.reportLatch({ paused: true });
              await this.receipt('paused', { reason: v.reason, requestSha256: sha256(entry.bytes) });
            }
            disposition = ok ? 'processed' : 'rejected';
          }
        } catch {
          // Keep a valid stop pending and leave this tick before any scheduling. The service loop
          // records its failure and exits; rejecting the request here could start the waiting batch.
          if (pauseRequested) throw new ResidentError('PAUSE_PERSISTENCE_UNCONFIRMED');
          disposition = 'rejected';
        }
      }
      // 'keep': an accepted revoke-head request stays in requests\ until stage 10 reports it done or it is an hour old.
      if (disposition === 'keep') { this.intakeRequestFailures.delete(entry.name); continue; }
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

  // The "立即探测" and "撤车头" requests (resident-requests.mjs; DESIGN §41.8, §41.3): 'processed', 'rejected' or 'keep', each
  // with its receipt. A probe request only marks the probe urgent and is archived by rename. A revoke-head request is accepted
  // only while the train is on; it is then the next on or revoke-only run's revokeHeadRequestId until it is done or an hour old,
  // and durable meanwhile: its file stays in requests\ ('keep'; the Owner's session can only add files there), read again every
  // tick (no new receipt) and after a restart (accepted again), and is archived only when stage 10 reports it done (trainActed:
  // 'revoke-head-done' first, so a restart in between never runs it twice), when it expired (refused as expired on the next read)
  // or when a newer one replaces it.
  async takeResidentRequest(v, requestSha256, name = null) {
    let r;
    try { r = validateResidentRequest(v, this.clock()); } catch (error) {
      if (this.revokeHead && v?.requestId === this.revokeHead.requestId) { this.reportRevokeHead({ requestId: this.revokeHead.requestId, state: 'expired', code: null }); this.revokeHead = null; }
      try { await this.receipt('resident-request-refused', { requestSha256, contract: v.contract, failureCode: codeOf(error) }); } catch { /* refused anyway */ }
      return 'rejected';
    }
    if (r.contract === PROBE_REQUEST_CONTRACT) {
      this.roleProbe.markUrgent();
      try { await this.receipt('probe-requested', { requestSha256, requestId: r.requestId, reason: r.reason }); } catch { /* the probe is urgent anyway */ }
      return 'processed';
    }
    if (this.policy.train.enabled !== 'on') {
      try { await this.receipt('resident-request-refused', { requestSha256, contract: r.contract, requestId: r.requestId, failureCode: 'REVOKE_HEAD_TRAIN_NOT_ON' }); } catch { /* refused anyway */ }
      this.reportRevokeHead({ requestId: r.requestId, state: 'refused', code: 'REVOKE_HEAD_TRAIN_NOT_ON' });
      return 'rejected';
    }
    if (this.revokeHead?.requestId === r.requestId) { this.revokeHead.name = name; return 'keep'; }
    if (await this.revokeHeadDone(r.requestId)) return 'processed';
    // A newer request replaces the one in force (requests\ is read oldest first): the older file is archived.
    if (this.revokeHead?.name && this.revokeHead.name !== name) {
      try { await this.requests.dispose(this.revokeHead.name, 'processed'); } catch { /* read again next tick, superseded again */ }
    }
    this.revokeHead = { requestId: r.requestId, requestedAt: r.requestedAt, name };
    this.trainUrgent = true;
    this.reportRevokeHead({ requestId: r.requestId, state: 'accepted', code: null });
    try { await this.receipt('revoke-head-requested', { requestSha256, requestId: r.requestId, reason: r.reason }); } catch { /* accepted: it is in force */ }
    return name === null ? 'processed' : 'keep';
  }

  // Whether stage 10 already reported this revoke-head request done (receipt 'revoke-head-done'); unreadable: not done.
  async revokeHeadDone(requestId) {
    if (this.revokeHeadDoneIds?.has(requestId)) return true;
    try { return (await this.receipts.latest(['revoke-head-done'], 16)).some(e => e.value.body?.requestId === requestId); } catch { return false; }
  }

  // The revoke-head request as the status board shows it (train.revokeHead).
  reportRevokeHead({ requestId, state, code = null }) {
    this.revokeHeadView = { requestId, state, at: new Date(this.clock()).toISOString(), code };
    this.report(s => s.update({ train: this.trainStatus() }));
  }

  // The accepted revoke-head request still in force (an hour from its writing), or null; an expired one is shown as such.
  revokeHeadInForce() {
    if (!this.revokeHead) return null;
    if (this.clock() - this.revokeHead.requestedAt > REQUEST_MAX_AGE_MS) {
      this.reportRevokeHead({ requestId: this.revokeHead.requestId, state: 'expired', code: null });
      this.revokeHead = null;
      return null;
    }
    return this.revokeHead;
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
    try { this.reportLatch({ intakePause: this.intakePause.view(this.clock()) }); } catch { /* a view */ }
    const { kind, ...facts } = next.result;
    // Applied: a receipt that cannot be written does not make it a refusal (independent review of C6, minor 6).
    try { await this.receipt(kind, { requestSha256, ...facts, reason: v.reason }); } catch { /* the request took effect */ }
    return 'processed';
  }

  // null: a new batch may start. Otherwise the deferral: a hold in force, or a state that cannot be read now (fail safe,
  // bounded by intakeTrouble's HALT).
  // The disk/memory guard (node governance v1; 2026-11-15). Optional port nodeStatus() -> host-capacity.mjs#createNodeResourceReader
  // (none: no guard): { ok, red, reason }. Red holds new batches through the executor's own word in the intake pause (holder
  // node-resource), as the version-skew hold does: a short hold, renewed while red, lifted once the reading is green again (its
  // hysteresis is the reader's). So the status board, the PR page and the node heartbeat (INTAKE_PAUSED: the server routes no
  // ci-admission to this node) all say it; a batch in flight goes on; never HALT. A reading that fails leaves the hold as it is
  // (it runs out by itself) and raises one alert a day in the retention notice channel: the guard failing can only do nothing.
  async nodeResourceRefresh() {
    if (typeof this.nodeStatus !== 'function') return null;
    let s = null;
    try { s = await this.nodeStatus(); } catch { s = null; }
    if (!s?.ok || typeof s.red !== 'boolean') {
      const day = dayKey(this.clock());
      if (this.nodeStatusNotice !== day) {
        this.nodeStatusNotice = day;
        try { await this.receipts.append(ALERT_RECEIPT, { spool: 'disk', code: 'NODE_STATUS_UNREADABLE', action: 'owner-review-retention', deletesAnything: false }); } catch { /* a notice only */ }
      }
      return null;
    }
    try {
      return await this.ownIntakeHold(NODE_RESOURCE_HOLDER, s.red, { minutes: NODE_RESOURCE_HOLD_MINUTES, renewBelowMs: NODE_RESOURCE_RENEW_BELOW_MS,
        reason: CODE.test(s.reason ?? '') ? s.reason : 'NODE_RESOURCE_RED', liftReason: 'NODE_RESOURCE_RECOVERED' });
    } catch { return null; }
  }

  async intakeGate() {
    let view = null;
    try { view = await this.intakeRefresh(); } catch { /* a spell of trouble: below */ }
    if (this.intakeTroubleSince != null) {
      const t = await this.intakeTrouble(null, 'read', { mayHalt: true });
      return t.halted ? { state: 'HALTED', failureCode: 'INTAKE_PAUSE_STATE_UNAVAILABLE' } : { state: 'DEFERRED', reason: 'INTAKE_PAUSE_UNCONFIRMED' };
    }
    return view ? { state: 'DEFERRED', reason: 'INTAKE_PAUSED', until: Date.parse(view.until) } : null;
  }

  async tick({ betweenBatchesRunning = false } = {}) {
    if (this.tickBusy) return { state: 'DEFERRED', reason: 'EXECUTOR_TICK_BUSY' };
    this.tickBusy = true;
    this.betweenBatchesRunning = betweenBatchesRunning === true;
    this.tickSeq = (this.tickSeq ?? 0) + 1;
    this.tickBatchDue = false;
    try {
      if (this.handoverProbePending) {
        this.handoverProbePending = false;
        await this.nodeRestart('renewal-handover');
      }
      let result = await this.tickInner();
      // Stage 10 just named a batch to open now (OPEN_FRONT_BATCH queued, or a front-bind pending): the loop must not rest 15 s first.
      // The state stays the resting one for the status board; `immediate` only tells the service loop to sleep the short interval.
      if (this.tickBatchDue === true && result && typeof result === 'object') result = { ...result, immediate: true };
      await this.reportTick(result);
      return result;
    }
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
        s.update({ halt: halt ? { code: CODE.test(halt.value?.code ?? '') ? halt.value.code : 'HALT_RECORD_UNREADABLE', at: halt.value?.at ?? null } : null, paused: !!paused, ...intake, train: this.trainStatus() });
        if (!['WAITING'].includes(result?.state)) s.setCurrent(null);
      });
      if (typeof this.versions === 'function') this.report(s => s.setVersions?.(this.versionState?.view ?? null));
      await this.refreshLimits();
      // A watch view renewed by this tick and not ended by batch work in it (atStage) holds to the tick's end, however long the watch
      // and the stage-10 run after it took (review round 27, MINOR 1): the status written now says watched.
      if (Number.isFinite(this.queueWatchViewAt) && this.queueWatchViewTick === this.tickSeq && this.clock() >= this.queueWatchViewAt) this.queueWatchViewAt = this.clock();
      this.reportQueue();
      this.reportNode();
    } catch { /* advisory */ }
  }

  // The daily budgets on the status (the PR page names a used-up one as a gate of the whole queue). Written by every scheduling pass
  // that reads them, and at most once a minute by the tick's report otherwise (review round 24, NIT 3): budgets free up as the 24-hour
  // window moves on also while no row reaches that pass (a deferral holds the only one).
  reportLimits(u, now) {
    const l = this.policy.limits;
    this.limitsReportedAt = now;
    this.report(s => s.update({ limits: { batches24h: u.started, maxBatches: l.maxBatchesPer24h, evaluations24h: u.evaluations, maxEvaluations: l.maxEvaluationsPer24h,
      waitingRetries24h: u.waitingRetries, maxWaitingRetries: l.waitingRetriesPer24h } }));
  }
  async refreshLimits() {
    const now = this.clock();
    if (Number.isFinite(this.limitsReportedAt) && now >= this.limitsReportedAt && now - this.limitsReportedAt < LIMITS_REFRESH_MS) return;
    try { this.reportLimits(await this.ledger.usage(now - DAY, { separateNetwork: this.networkPolicy() !== null, budgetTimes: true }), now); } catch { /* a view: the next tick tries again */ }
  }

  // The status board's `train` (status.mjs): the mode and the newest summary as in step 3c-1; the sweep, the revoke-head request,
  // onSince and NOT_ON_DUTY only when they have a value.
  trainStatus() {
    const t = { enabled: this.policy.train.enabled, last: this.trainLast ?? null };
    if (this.policy.train.enabled === 'on') {
      const r = this.trainStrictFrontReadiness ?? this.trainStrictReadiness;
      const front = r?.front ? [...this.frontBindings.values()].find(f => this.trainStrictFront(f) && !this.trainGate(f)) : null;
      t.frontReadyMode = front ? this.trainStrictFrontReadiness ? 'strict-current-front' : 'strict-coverage'
        : this.trainEligible() && this.trainTakeoverDone && !this.trainGate() ? this.trainSweepGates() ? 'full-sweep' : 'strict-permanent' : 'blocked';
      t.fullPending = !this.trainTakeoverDone;
      // DESIGN §65: the companion's backstop reads it (strict off in strict-permanent mode: PAUSE at once, no grace).
      t.sweepMode = trainSweepMode(this.policy.train);
      t.landing = trainLandingMode(this.policy.train); // ADR 0018
      t.backgroundAllPending = r?.backgroundAllPending != null || this.trainSweep?.fullAllPending != null;
      t.maintenanceExtraUsed = this.trainExtraRuns.filter(at => at > this.clock() - DAY).length;
      t.maintenanceExtraLimit = Math.max(0, this.policy.train.maintenanceMaxPerDay - Math.ceil(DAY / this.policy.train.maintenanceEveryMs));
    }
    if (this.trainSweep) t.sweep = this.trainSweep;
    if (this.trainNodes) t.nodes = this.trainNodes;
    if (this.revokeHeadView) t.revokeHead = this.revokeHeadView;
    if (this.trainOnSince !== null) t.onSince = new Date(this.trainOnSince).toISOString();
    if (this.policy.train.enabled === 'on' && !this.trainEligible()) t.notOnDuty = true;
    return t;
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
    return this.ownIntakeHold(VERSION_SKEW_HOLDER, consistent === false, { minutes: INTAKE_PAUSE_MAX_MINUTES, renewBelowMs: VERSION_SKEW_RENEW_BELOW_MS,
      reason: UPGRADE_VERSION_SKEW, liftReason: 'VERSIONS_CONSISTENT' });
  }

  // The executor's own hold in the intake pause (intake-pause.mjs#apply): on adds it (or renews it below renewBelowMs left), off
  // lifts it. PAUSE, HALT and the other holders are untouched; the Owner may lift it by hand (it comes back on the next tick while
  // its cause lasts). Returns the receipt kind written, or null.
  async ownIntakeHold(holder, on, { minutes, renewBelowMs, reason, liftReason }) {
    try { await this.intakeRefresh(); } catch { return null; }
    const p = this.intakePause, now = this.clock();
    const hold = p.active(now).find(h => h.holder === holder) ?? null;
    const word = { holder, requestedAt: new Date(now).toISOString(), nonce: randomBytes(8).toString('hex') };
    let request;
    if (on) {
      if (hold && Date.parse(hold.until) - now >= renewBelowMs) return null;
      request = { contract: INTAKE_PAUSE_CONTRACT, ...word, minutes, reason };
    } else {
      if (!hold) return null;
      request = { contract: INTAKE_RESUME_CONTRACT, ...word, reason: liftReason };
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
      if (await this.executedHeads.backfilled()) {
        // Defect 39e8ba4f: a backfill done by an earlier start is complete for the status board too (once per process), with the
        // marker's counts when it gives them (anything else is null: a count is never guessed).
        if (!this.backfillReported) {
          let m = null;
          try { m = await this.executedHeads.readMarker?.(); } catch { m = null; }
          const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
          this.report(s => s.update({ backfill: { complete: true, published: count(m?.published), unreadable: count(m?.unreadable) } }));
          this.backfillReported = true;
        }
        return null;
      }
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
    this.backfillReported = true;
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
    // Field defect 2026-11-13 (PR #1085): a latch the Owner lifted (resume, re-arm) reaches the status in this tick, before any batch
    // it lets run; otherwise the status kept PAUSE until the tick's end (reportTick), after the whole batch.
    await this.reportLedgerLatches();
    // DESIGN §34: the versions of both sides, and the version-skew hold, before anything is scheduled.
    await this.versionsRefresh();
    // The disk/memory guard's hold (holder node-resource), before anything is scheduled.
    await this.nodeResourceRefresh();
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
    // Defect 8f8240ff (review MAJOR 2): none of the maintenance runs (revocation, role probe, queue watch, stage 10) while the
    // between-batches step runs beside the loop: they start children, and archive retention deletes only with no child running (§35.3).
    if (recovered && !this.betweenBatchesRunning) {
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
    // DESIGN §41.3: under PAUSE while the train is on, stage 10 runs revoke-only (an ACTIVE node, its own cadence) before the tick
    // returns PAUSED; a HALT it latches is the tick's result. Off and shadow: nothing runs, as before.
    if (await this.ledger.paused()) {
      if (this.betweenBatchesRunning) return { state: 'PAUSED' };
      // DESIGN §72: PAUSE stops every try and every start, never the rule: a batch that no longer stands ends here too (it publishes
      // nothing), so a paused node off duty has no open batch (the reinstall's W1 and the uninstall rely on it).
      const ended = await this.endNotStanding();
      if (ended) return ended;
      // The upgrader keeps its pause until VERIFY has seen a post-start role observation. Run only that
      // read-only maintenance under its exact pause; never intake, schedule or lift the pause here.
      const probed = await this.roleProbeMaintenance({ upgradePaused: true });
      if (probed?.state === 'HALTED') return probed;
      const revoked = this.policy.train.enabled === 'on' ? await this.trainMaintenance({ paused: true }) : null;
      return revoked?.state === 'HALTED' ? revoked : { state: 'PAUSED' };
    }
    // Triggers go into the run queue first (phase 2, step 1); the queue then follows the ledger for any row a crash left
    // marked running.
    await this.intake();
    // DESIGN §72: the rule first, with this tick's triggers: a resting batch that no longer stands ends before anything tries it.
    const ended = await this.endNotStanding();
    if (ended) return ended;
    await this.requeueFlowEnds();
    // Field 2026-11-13 (PR #1085): the stage-10 run a lifted pause owes (trainResumeOwed, defect b0426896) comes before any batch work,
    // so the schedule and the front's yield after stage 1 (§62.6) read the train as it is now, never the revoke-only run under the pause;
    // otherwise the queue head's ordinary batch scanned H and the front batch scanned the same tree again on S.
    // PR #1142: a tested ordinary head at B gets the same priority, once, so a busy queue cannot starve its front batch.
    // FABLE-ci-10min §3.2 P1b (field 2026-11-19 06:39, #1171): a due stage-10 run also goes first while a front is bound; otherwise a trigger
    // of another PR in the same tick reserved its ordinary batch first and held stage 10 for 14-24 minutes.
    // FABLE-keep-train-replan §3.4: so does the run a head's admission asked for while the train was idle (trainAdmitOwed).
    if (!this.betweenBatchesRunning && (this.trainResumeOwed() || this.trainAdmitOwed || await this.trainFrontOpenOwed() || this.trainFrontWaits())) {
      const owed = await this.trainMaintenance({ routineOnly: true });
      if (owed) return owed;
    }
    // Batches at a parking point go first (design v0.5 §4.3 step 3): each one waiting for hosted signals is evaluated
    // once (and continues to its end when it may), a parked one whose stage-8 try is due runs that try. They are
    // re-evaluated only here, after recovery, the Owner's requests, HALT and PAUSE. Then the queue.
    // The train on: a parked batch waits for the take-over sweep too (no publication of any stage before it; review R3 MINOR 6).
    const { acted, waiting } = await this.resumeParked({ hold: this.trainTakeoverPending() });
    if (acted) return acted;
    // Nothing else to do: the tick rests in the hosted wait (the status keeps showing it).
    const r = await this.schedule();
    this.scheduleHold = r?.state === 'DEFERRED' && SCHEDULE_HOLDS.includes(r.reason) ? r.reason : null;
    // A batch resting at parking point A stays the tick's result (and the status's current batch) while only the intake
    // pause holds the new ones (independent review of C6, minor 3).
    const result = waiting && (r.state === 'IDLE' || [...TRAIN_HELD_REASONS, ...Object.values(NODE_DEFERRALS), ...TRAIN_SCHEDULE_DEFERRALS].includes(r.reason)) ? waiting : r;
    if (this.betweenBatchesRunning) return waiting ?? r;
    // Stage 10 only after a schedule that ran nothing (a batch resting at a parking point runs nothing either). The role probe
    // also while a batch rests at A, when it may be run at a parking point (probeAtParking, DESIGN §29.2 item 5).
    if ((!waiting || this.probeAtParking()) && TRAIN_QUIET_STATES.includes(r.state) && !TRAIN_HELD_REASONS.includes(r.reason)) {
      const probeResult = await this.roleProbeMaintenance();
      if (probeResult) return probeResult;
    }
    // Generation 12 (DESIGN §56.2): the queue watch, also only after a schedule that ran nothing.
    if (TRAIN_QUIET_STATES.includes(r.state) && !TRAIN_HELD_REASONS.includes(r.reason)) {
      const watched = await this.queueWatchMaintenance();
      if (watched) return watched;
    }
    if (TRAIN_QUIET_STATES.includes(r.state) && !TRAIN_HELD_REASONS.includes(r.reason)) return (await this.trainMaintenance()) ?? result;
    // The train on: under an intake pause stage 10 runs revoke-only whatever the queue holds (trainMaintenance reads the hold
    // itself; review R3 MINOR 4). Off and shadow: held, as before.
    if (this.policy.train.enabled === 'on' && TRAIN_HELD_REASONS.includes(r.reason)) return (await this.trainMaintenance()) ?? result;
    return result;
  }

  // C2 recovery is independent of CI accounting. An interrupted swap still HALTs; it never authorizes
  // a second swap or clears any head/scene. A bad public receipt cannot become a fresh role observation.
  // Generation 13 (DESIGN §57.1, Owner Decision 2907d858): a probe interrupted by a restart or a power cut (its intent without a result)
  // is recovered by itself while fewer than policy roleProbe.interruptedMax (/10; 1, i.e. HALT at once, under /9 and earlier) were
  // interrupted in a row and the Windows side is quiet as a re-arm requires it (windowsQuiescence: no swap of THIS process in flight,
  // the original runner service stopped): the intent is closed as interrupted, the role book is the one of the last probe that ended
  // (nothing of the interrupted one is used), and the probe is due at once, with the role judged afresh. Otherwise, as before,
  // ROLE_PROBE_INTERRUPTED HALTs for the Owner. A restarted process cannot see what the crashed one left running; a leftover swap that
  // still holds the broker makes that fresh probe end BROKER_BUSY, which HALTs (ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED) before any role
  // is judged. An earlier start that HALTed for this intent and crashed before its result is closed as halted, never recovered.
  async roleProbeRecover() {
    if (this.roleProbeRecovered || typeof this.engine.runRoleProbe !== 'function') return null;
    try {
      const max = this.policy.roleProbe?.interruptedMax ?? 1;
      const rows = await this.receipts.latest(['role-probe-intent', 'role-probe-result'], 2 * max + 2), last = rows.at(-1);
      if (last?.type === 'role-probe-intent') {
        const paired = i => i >= 1 && rows[i].type === 'role-probe-result' && rows[i - 1].type === 'role-probe-intent' && rows[i].value.body.intentSeq === rows[i - 1].seq;
        // The role book of the last probe that ended, carried by every closing result since (review round 1, NIT): restored before any
        // of them is written, so a halted interruption keeps it too and a later recovery never starts from an empty book.
        if (paired(rows.length - 2)) this.roleProbe.restore(rows.at(-2).value.body.state);
        // An earlier start that already HALTed for this very intent and crashed before its closing result (review round 1, MINOR 1):
        // close it as it was decided, halted, with no notice. Never re-decided: the node is HALTed, not recovered.
        const halt = await this.ledger.halted();
        if (halt?.value?.code === 'ROLE_PROBE_INTERRUPTED' && halt.value.facts?.intentSeq === last.seq) {
          await this.receipt('role-probe-result', { intentSeq: last.seq, deferred: false, ok: false, fact: null, interrupted: true, halted: true, state: this.roleProbe.snapshot() });
          return { state: 'HALTED', failureCode: 'ROLE_PROBE_INTERRUPTED' };
        }
        // The interruptions in a row: this one and every earlier intent closed as interrupted and not HALTed, back to a probe that ended.
        let interruptions = 1;
        for (let i = rows.length - 2; paired(i) && rows[i].value.body.interrupted === true && rows[i].value.body.halted !== true; i -= 2) interruptions += 1;
        let quiet = null;
        if (interruptions < max) { try { quiet = await this.engine.windowsQuiescence(null); } catch { quiet = null; } }
        if (!(interruptions < max && quiet?.windowsTreeZero === true && quiet?.serviceOriginalStopped === true)) {
          await this.haltWith('ROLE_PROBE_INTERRUPTED', { intentSeq: last.seq, interruptions, interruptedMax: max,
            windowsQuiet: quiet ? quiet.windowsTreeZero === true && quiet.serviceOriginalStopped === true : null });
          await this.receipt('role-probe-result', { intentSeq: last.seq, deferred: false, ok: false, fact: null, interrupted: true, halted: true, state: this.roleProbe.snapshot() });
          return { state: 'HALTED', failureCode: 'ROLE_PROBE_INTERRUPTED' };
        }
        this.roleProbe.markUrgent();
        await this.receipt('role-probe-result', { intentSeq: last.seq, deferred: false, ok: false, fact: null, interrupted: true, halted: false, interruptions,
          state: this.roleProbe.snapshot() });
        // "Recovered by itself" is told only to a node that is not HALTed for something else: there the HALT is what the Owner sees
        // (review round 2, NIT).
        if (!halt) {
          this.roleProbeNotices.push({ kind: 'role-probe-interrupted', key: `role-probe-interrupted:${last.seq}`, code: 'ROLE_PROBE_INTERRUPTED', at: new Date(this.clock()).toISOString() });
          this.roleProbeNotices = this.roleProbeNotices.slice(-10);
        }
        this.roleProbeRecovered = true;
        return null;
      }
      if (last) {
        check(rows.length >= 2 && rows.at(-2).type === 'role-probe-intent' && last.value.body.intentSeq === rows.at(-2).seq, 'ROLE_PROBE_BOOK_REFUSED');
        this.roleProbe.restore(last.value.body.state);
        // A recovery whose fresh probe never ran (the executor stopped again right after closing the interruption): that probe is
        // still due at once; the snapshot does not keep it (review round 2, NIT).
        if (last.value.body.interrupted === true && last.value.body.halted !== true) this.roleProbe.markUrgent();
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

  // watch (generation 12, DESIGN §56.2): { key, pr, lastEnd } of a batch parked at B for the merge queue (lastEnd: when its last
  // stage-8 try ended). The probe then also asks whether that PR's claim holds the merge slot; it runs on the watch's own cadence
  // (queueWatchMaintenance), never under a pause, and only while every open batch rests at a parking point. Everything else is the
  // role probe's: receipts, the node mode on a definite answer, the HALT when no fact is confirmed. An uncertain watch answer is not
  // counted in the role book's uncertain count (a watch runs far more often than the periodic probe, which keeps its own), but it is a
  // failed probe for the breaker like any other. A clock that went back since the last observation never reaches the role book.
  async roleProbeMaintenance({ upgradePaused = false, watch = null } = {}) {
    if (typeof this.engine.runRoleProbe !== 'function' || this.roleProbeRunning) return null;
    // C3 owns the mode and all its transitions (DESIGN §29); status (advisory) is never an input. UNCERTAIN has STANDBY's
    // one-minute interval, an idle ACTIVE node five minutes, an uncertain answer backs off (role-probe.mjs, ADR 0026), and `urgent`
    // (a start, a re-arm, a failure that may mean the role is gone) is due at once.
    const mode = this.nodeMode(), now = this.clock();
    // A paused upgrade is quiet only with no open batch at all. Match both the fixed request shape and
    // its original bytes' digest; an ordinary/unknown/torn pause still prevents the probe.
    const open = await this.ledger.open();
    const pause = await this.ledger.paused(), source = pause?.value?.source;
    const upgradePause = upgradePaused === true && typeof source?.reason === 'string'
      && /^resident-upgrade [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12} [1-9][0-9]{0,2}$/.test(source.reason)
      && source.requestSha256 === sha256(Buffer.from(canonicalJson({ contract: PAUSE_CONTRACT, reason: source.reason }) + '\n'));
    const idle = !(await this.ledger.halted()) && (watch ? !pause && open.every(e => Ledger.resumable(e)) : pause ? upgradePause && open.length === 0
      : (this.probeAtParking() ? open.every(e => Ledger.resumable(e)) : open.length === 0));
    if (watch ? !idle || (this.roleProbe.last !== null && now < this.roleProbe.last.at) : !this.roleProbe.due({ now, mode: mode === 'ACTIVE' || mode === 'UNCERTAIN' ? mode : 'STANDBY', idle })) return null;
    if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < now + 240_000) return null;
    const drift = await this.driftCode();
    if (drift) { await this.haltWith(drift, { phase: watch ? 'queue-watch' : 'role-probe' }); return { state: 'HALTED', failureCode: drift }; }
    this.roleProbeRunning = true;
    try {
      const intent = await this.receipt('role-probe-intent', { mode, urgent: this.roleProbe.urgent === true, ...(watch ? { watchPr: watch.pr } : {}) });
      let r;
      try { r = await (watch ? this.engine.runRoleProbe({ watchPr: watch.pr }) : this.engine.runRoleProbe()); } catch { r = null; }
      // Only the engine's pre-broker busy guard is a deferral, not a role fact. BROKER_BUSY after a
      // request is not whitelisted here and retains the original unknown/HALT behavior.
      const deferred = r?.deferred === true && r.code === 'ROLE_PROBE_BUSY';
      // A watch counts towards QUEUE_WATCH_MAX_PER_DAY once the engine got past its busy guard (a swap was asked for).
      if (watch && !deferred) { const day = dayKey(now); if (this.queueWatchDay?.day !== day) this.queueWatchDay = { day, n: 0 }; this.queueWatchDay.n += 1; }
      let fact = null;
      if (r?.ok === true && r.proof?.windowsTreeZero === true && r.proof?.serviceOriginalStopped === true
        && r.outcome?.status === 'BLOCKED' && r.outcome.sideEffects === 0 && r.outcome.mayHavePublished === false) {
        try { const f = validateRoleProbeFact(r.roleProbe); if (r.outcome.reason === f.code) fact = f; } catch { /* no fact */ }
      }
      // Only a watch can name its PR as the slot holder; a probe without one that says so is no fact.
      if (fact?.code === ROLE_PROBE_CODES.watchedHead && !watch) fact = null;
      // The probe's child ran past its window and the helper killed it (STAGE_CHILD_TIMEOUT, FIXED_CHILD_TIMEOUT) with the tree proven
      // zero and the original runner read back stopped: nothing runs and nothing was published, only the role is unknown. That is an
      // uncertain answer (DESIGN §29.2, §56.2), never a HALT (TURING 2026-11-15 08:13Z). Any other ending without a fact HALTs as before.
      if (!deferred && !fact && r?.code === 'STAGE_CHILD_TIMEOUT' && r.proof?.windowsTreeZero === true && r.proof?.serviceOriginalStopped === true) {
        fact = Object.freeze({ result: 'uncertain', code: ROLE_PROBE_CODES.uncertain });
      }
      const watchedHead = !!watch && fact?.code === ROLE_PROBE_CODES.watchedHead;
      if (!deferred && !fact) await this.haltWith('ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED', { intentSeq: intent.seq, failureCode: r?.code ?? null });
      const observedAt = this.clock();
      const observe = fact && (!watch || (fact.result !== 'uncertain' && (this.roleProbe.last === null || observedAt >= this.roleProbe.last.at)));
      if (observe) {
        const observation = this.roleProbe.observe(roleBookFact(fact), observedAt);
        this.roleProbeNotices.push(...observation.notices);
        this.roleProbeNotices = this.roleProbeNotices.slice(-10);
        this.report(s => s.setRoleProbe?.(this.policy.node.nodeName, observation.probe));
      }
      // not-held is the safe direction and takes effect first (also from a watch whose answer the role book could not take, review
      // round 4 NIT 8); held only after the result is recorded and observed. uncertain changes nothing.
      if (fact?.result === 'not-held') await this.setNodeMode('STANDBY', 'probe-not-held');
      await this.receipt('role-probe-result', { intentSeq: intent.seq, deferred, ok: !!fact, fact, state: this.roleProbe.snapshot(),
        ...(watch ? { watch: { pr: watch.pr, head: watchedHead } } : {}) });
      // Generation 10: only a definite answer (held, not-held) shows that Native could be reached; an uncertain fact is also what a probe
      // whose own reads failed returns (merge-slot-native.mjs), so it counts as a failed probe, like no fact at all.
      // Every answered probe tells the breaker whether Native was reached, a watch too: an uncertain watch breaks a run of good probes
      // (review round 5, MINOR 2); it only stays out of the role book's uncertain count (no Owner notice for a short flap).
      if (!deferred) await this.noteBreakerProbe(fact?.result === 'held' || fact?.result === 'not-held', 'role-probe');
      if (fact?.result === 'held' && observe) await this.setNodeMode('ACTIVE', 'probe-held');
      if (watch) this.watchAnswered(watch, deferred || !fact || fact.result === 'uncertain' ? 'unknown' : watchedHead ? 'head' : 'not-head');
      return !deferred && !fact ? { state: 'HALTED', failureCode: 'ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED' } : null;
    } finally { this.roleProbeRunning = false; this.roleProbeEndedAt = this.clock(); }
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
    const intents = rows.filter(e => e.type === 'train-run-intent');
    this.trainExtraRuns = intents.filter(e => e.value.body?.idleProgressExtra === true).map(e => Date.parse(e.value.at)).filter(Number.isFinite);
    this.trainProgressConsumed = intents.findLast(e => e.value.body?.idleProgressExtra === true)?.value.body.progressKey ?? null;
    if (this.policy.train.enabled === 'on') { await this.trainFrontRecover(rows); await this.trainDutyRecover(); }
    return last?.type === 'train-run-intent' ? { state: 'HALTED', failureCode: 'TRAIN_STAGE_INTERRUPTED' } : null;
  }

  // Train on: the front batches per head, whatever their age (a head keeps its count for good: review R3 MINOR 11; the newest
  // FRONT_RECOVER_RECEIPTS, so a restart never opens a third one for a head; stage 10 counts them itself too, train facts attempt),
  // and a front outcome no on-mode run has cleared yet (receipt 'train-front-outcome' with no later ok 'train-run' naming its seq
  // with frontOutcomeCleared: stage 10 reported it, or reporting it became moot; review R3 MINOR 3), at most a day old. Best
  // effort: a chain that cannot be read here keeps what is in memory.
  async trainFrontRecover(runs) {
    try {
      for (const e of await this.receipts.latest(['train-front-enqueued'], FRONT_RECOVER_RECEIPTS)) {
        const b = e.value.body;
        if (!Number.isSafeInteger(b?.pr) || typeof b.headSha !== 'string') continue;
        const list = this.frontBatches.get(`${b.pr}:${b.headSha}`) ?? [];
        // ADR 0019: a batch of several PRs (its receipt names members) is not one of the front's own attempts.
        if (!list.some(x => x.testSha === b.testSha && x.attempt === b.attempt)) list.push({ testSha: b.testSha, attempt: b.attempt, solo: !Array.isArray(b.members) });
        this.frontBatches.set(`${b.pr}:${b.headSha}`, list);
        if (HEX64.test(b.key ?? '')) this.frontKeys.set(b.key, b.attempt);
        const front = openFrontBatchOf(b);
        if (front) this.frontBindings.set(`${front.pr}:${front.testSha}`, front);
      }
      for (const e of await this.receipts.latest(['train-front-bind'], FRONT_RECOVER_RECEIPTS)) {
        const b = e.value.body;
        if (HEX64.test(b?.key ?? '') && Number.isSafeInteger(b.pr) && HEX40.test(b.headSha ?? '')) this.frontBindKeys.set(b.key, { pr: b.pr, headSha: b.headSha });
      }
      for (const e of await this.receipts.latest(['train-front-bound'], FRONT_RECOVER_RECEIPTS)) {
        const b = e.value.body, at = Date.parse(e.value.at);
        if (Number.isSafeInteger(b?.pr) && HEX40.test(b.headSha ?? '') && Number.isFinite(at)) this.frontBound.set(`${b.pr}:${b.headSha}`, at);
      }
      const [fo] = await this.receipts.latest(['train-front-outcome'], 1);
      const cleared = runs.some(e => e.type === 'train-run' && e.value.body?.frontOutcomeSeq === fo?.seq && e.value.body?.ok === true && e.value.body?.frontOutcomeCleared !== false);
      if (fo && !cleared && Date.parse(fo.value.at) > this.clock() - DAY) this.trainFrontOutcome = { ...fo.value.body.frontOutcome, seq: fo.seq, at: Date.parse(fo.value.at) };
    } catch { /* see above */ }
  }

  // A front batch (subject with S) that ended FAILED_CLEAN for the PR itself (failure table deterministic-pr) with no attempt 2:
  // owed to the next on-mode stage 10 as frontOutcome (DESIGN §41.4 "touch failed"), which reports failed on the slot.
  async noteFrontOutcome(subject, key, code) {
    const attempt = this.frontKeys.get(key) ?? null;
    if (!Object.hasOwn(subject ?? {}, 'testSha') || ![1, 2].includes(attempt) || !CODE.test(code ?? '')) return;
    const frontOutcome = { pr: subject.pr, headSha: subject.headSha, testSha: subject.testSha, attempt, code };
    try {
      const r = await this.receipt('train-front-outcome', { key, frontOutcome });
      this.trainFrontOutcome = { ...frontOutcome, seq: r.seq, at: this.clock() };
      this.trainUrgent = true;
    } catch { /* not reported: the slot runs out by its running clock */ }
  }

  // A confirmed OPEN_FRONT_BATCH (mode on): the front subject with S into the run queue, the one producer of S. At most
  // FRONT_BATCHES_PER_HEAD per head, never the same (S, attempt) twice. ADR 0019 (review blocker 1): only the front's batches ALONE
  // count, as stage 10 counts them (train-maintenance.mjs#openFront, ADR 0018 §3): a batch of several PRs that failed is bisected, and its
  // smaller batches, down to the front alone, must still reach the run queue. Each of those is its own S (never the same S twice).
  async enqueueFront(front) {
    const headKey = `${front.pr}:${front.headSha}`;
    const list = this.frontBatches.get(headKey) ?? [];
    const solo = !front.members;
    if (list.some(x => x.testSha === front.testSha && x.attempt === front.attempt)) return null;
    if (solo && list.filter(x => x.solo !== false).length >= FRONT_BATCHES_PER_HEAD) {
      try { await this.receipt('train-front-refused', { pr: front.pr, headSha: front.headSha, testSha: front.testSha, attempt: front.attempt, failureCode: 'TRAIN_FRONT_ATTEMPTS_USED' }); } catch { /* refused anyway */ }
      return null;
    }
    await this.endOrdinaryForFront(front);
    await this.endSupersededForFront(front);
    const offered = this.queue.offerFront({ pr: front.pr, headSha: front.headSha, baseSha: front.baseSha, testSha: front.testSha, attempt: front.attempt }, this.clock(),
      { depth: this.policy.limits.queueDepth });
    if (offered.action !== 'front') {
      // Field defect PR #1035: stage 10 counted this front batch and touched running, so it says TRAIN_FRONT_BATCH_RUNNING from now on and
      // never offers it again. A front refused only because the row was busy is kept and offered again (trainActed) once a later stage-10
      // run, still naming this head on this main, finds the row free.
      this.frontRetry = offered.action === 'busy' ? front : null;
      try { await this.receipt('train-front-refused', { pr: front.pr, headSha: front.headSha, testSha: front.testSha, attempt: front.attempt, failureCode: offered.code ?? 'TRAIN_FRONT_PR_BUSY' }); } catch { /* see above */ }
      return null;
    }
    list.push({ testSha: front.testSha, attempt: front.attempt, solo });
    this.frontBatches.set(headKey, list);
    if (this.frontRetry?.pr === front.pr) this.frontRetry = null;
    const subject = { repo: this.policy.repo, pr: front.pr, headSha: front.headSha, baseSha: front.baseSha, sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1, testSha: front.testSha };
    const key = batchKey(subject);
    this.frontKeys.set(key, front.attempt);
    await this.persistQueue();
    await this.receipt('train-front-enqueued', { key, pr: front.pr, headSha: front.headSha, baseSha: front.baseSha, testSha: front.testSha, testTree: front.testTree,
      attempt: front.attempt, claimId: front.claimId, since: front.since, ...(front.members ? { members: front.members } : {}), ...(front.headTree ? { headTree: front.headTree } : {}),
      ...(front.baseInHead === true ? { baseInHead: true } : {}) });
    this.frontBindings.set(`${front.pr}:${front.testSha}`, front);
    return key;
  }

  // Task ad19ef19 (DESIGN §62.5): the PR's ordinary batch (attempt 1 or 2, no S) of the front's head that rests at parking point A (after
  // stage 1) or B (after stage 7) ends cleanly now, as TRAIN_FRONT_TAKES_OVER, so the front batch is not refused as busy. Its stage 8 could
  // never publish the merge slot in train on (only a front job can); the front batch (H, S) has its own head key. A batch that is not
  // resting at a parking point (none is while stage 10 runs) or of another head is left alone: offerFront decides as before.
  async endOrdinaryForFront(front) {
    const run = this.queue.row(front.pr)?.running;
    if (!run || Object.hasOwn(run, 'testSha') || run.headSha !== front.headSha) return;
    let entry;
    try { entry = (await this.ledger.parkedEntries()).find(e => e.key === run.key); } catch { return; }
    const s = entry?.reserved?.subject;
    if (!s || Object.hasOwn(s, 'testSha') || s.pr !== front.pr || s.headSha !== front.headSha) return;
    let ended = null;
    if (Ledger.parkedAt(entry)) ended = await this.endParkedB(entry, TRAIN_FRONT_TAKES_OVER);
    else if (Ledger.waitingAt(entry)) ended = await this.endWaitingA(entry, TRAIN_FRONT_TAKES_OVER);
    if (ended) { try { await this.receipt('train-front-takes-over', { key: entry.key, pr: s.pr, headSha: s.headSha, testSha: front.testSha, outcome: ended.state ?? null }); } catch { /* a view */ } }
  }

  // Field defect PR #1035 (2026-11-07): stage 10 read the PR's new head on GitHub before the poller's trigger reached the queue, while the
  // row still ran the older head's batch parked at B, so offerFront refused the new head's front batch as busy. The front naming another
  // head is a hint to the rule (DESIGN §72): the parked batch's live read is due now, and the batch ends there when its head is no longer
  // the PR's; the front batch is then offered as usual. No live answer, or the PR still at the parked head: offerFront decides as before.
  async endSupersededForFront(front) {
    const run = this.queue.row(front.pr)?.running;
    if (!run || run.headSha === front.headSha) return;
    let entry;
    try { entry = (await this.ledger.parkedEntries()).find(e => e.key === run.key && Ledger.parkedAt(e)); } catch { return; }
    const s = entry?.reserved?.subject;
    if (!s || s.pr !== front.pr || s.headSha === front.headSha) return;
    const outcome = await this.endParkedIfNotStanding(entry, front.headSha);
    if (!outcome) return;
    try { await this.receipt('train-front-supersedes', { key: entry.key, pr: s.pr, headSha: s.headSha, frontHeadSha: front.headSha, testSha: front.testSha, outcome: outcome?.state ?? null }); }
    catch { /* a view */ }
  }

  // One train run when it is due (train.mjs#trainDue): not under an intake pause (also with an empty queue, which ends
  // schedule() before its gate; independent review of 3c-1, M1), within the install's authority with the helper's own
  // margin, never below the helper's fixed one (the start-of-batch rule for this one stage; review m2, round 2 NIT 4), from
  // the installed bytes. Returns a HALTED result,
  // or null for any other ending. A failure is clean only with the Windows proof complete, no side effect in a bound
  // outcome, and either an allow-listed clean code (classify.mjs), the engine's own refusal before the broker, or a bound
  // outcome that says so: BLOCKED, or TRAIN_FACTS that ran into the cap after writing it (review m3; round 2, NIT 3).
  // The train on (DESIGN §41): the run mode is train.mjs#trainRunMode's (on, or revoke-only under PAUSE and an intake pause;
  // only on an ACTIVE node); there a bound TRAIN_FACTS outcome with side effects and facts /2 that validate in that mode is a
  // normal ending; any other ending with a side effect HALTs as before. paused: called from the PAUSE path of the tick.
  // routineOnly: a call ahead of the batch work (tick, P1b) runs only a routine or urgent run, never an idle-progress extra.
  async trainMaintenance({ paused = false, routineOnly = false } = {}) {
    const train = this.policy.train;
    const observationOnly = train.enabled === 'off' && !paused && this.queue.claimChecks().length > 0;
    if (!this.trainRuns || (train.enabled === 'off' && !observationOnly)) return null;
    const cadence = observationOnly ? { ...train, enabled: 'shadow' } : train;
    const now = this.clock();
    if (Number.isSafeInteger(this.tickSeq) && this.trainMaintenanceTick === this.tickSeq) return null;
    this.trainRuns = this.trainRuns.filter(at => at > now - DAY);
    const active = !this.probing() || this.nodeMode() === 'ACTIVE';
    if (train.enabled === 'on' && !active) return null; // NOT_ON_DUTY (trainStatus)
    // Defect b0426896: the first tick that reaches stage 10 with no pause in force after a revoke-only run (the PAUSE was lifted by
    // upgrade-resumed or the Owner, the last intake hold by intake-resumed or its clock) makes the on-mode run due at once. Under an
    // intake hold nothing changes (revoke-only keeps its cadence); the read is the same intake gate the run itself reads below.
    if (!paused && this.trainUrgent !== true && (this.trainResumeOwed() || await this.trainFrontOpenOwed())) {
      const held = await this.intakeGate();
      if (held?.state === 'HALTED') return held;
      if (held === null) this.trainUrgent = true;
    }
    const urgent = train.enabled === 'on' && this.trainUrgent === true;
    const recheck = train.enabled === 'on' && this.trainLast?.mode === 'on'
      && (TRAIN_RECHECK_DECISIONS.includes(this.trainLast.decision) || this.trainFrontRecheck?.due === true);
    if (this.trainRuns.length >= train.maintenanceMaxPerDay) this.queue.notice(boundedNotice({ code: 'TRAIN_DAILY_LIMIT', used: this.trainRuns.length,
      limit: train.maintenanceMaxPerDay, now, resetsAt: this.trainRuns.length ? Math.min(...this.trainRuns) + DAY : null, recovery: null }));
    const routineDue = trainDue({ train: cadence, now, runs: this.trainRuns, busy: false, urgent, recheck });
    let idleProgressExtra = false;
    // DESIGN §65: in strict-permanent mode a full round is a background audit, never hurried, unless a rewritten main waits for it.
    if (!routineDue && !paused && !routineOnly && train.enabled === 'on' && this.trainProgressReady === true && (this.trainSweepGates() || this.trainSweep?.fullAllPending === 'TRAIN_MAIN_REWRITTEN')) {
      const frontWork = this.queue.candidates(now).some(row => Object.hasOwn(row, 'testSha') && !this.trainGate(row))
        || (await this.ledger.parkedEntries()).some(e => Object.hasOwn(e.reserved?.subject ?? {}, 'testSha')
          && Ledger.parkedAt(e) && this.parkedDueAt(e) <= now && !this.trainGate(e.reserved?.subject));
      idleProgressExtra = trainIdleExtraDue({ train, now, runs: this.trainRuns, extraRuns: this.trainExtraRuns, urgent: urgent || this.trainUrgent === true, frontWork,
        progress: this.trainLast?.sweep?.progress, providerBudget: this.trainLast?.sweep?.providerBudget, consumed: this.trainProgressConsumed });
    }
    if (!routineDue && !idleProgressExtra) return null;
    let intakeHeld = false;
    if (!paused) {
      const held = await this.intakeGate();
      if (held?.state === 'HALTED') return held;
      intakeHeld = held !== null;
    }
    const { mode } = trainRunMode({ enabled: cadence.enabled, active, paused, intakeHeld });
    if (!mode) return null;
    if (idleProgressExtra && mode !== 'on') return null;
    if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < now + this.policy.stageRunMilliseconds[TRAIN_STAGE - 1] + Math.max(this.policy.limits.stageMarginMs, TRAIN_HELPER_MARGIN_MS)) return null;
    const drift = await this.driftCode();
    if (drift) {
      await this.haltWith(drift, { phase: 'train-maintenance' });
      return { state: 'HALTED', failureCode: drift };
    }
    const acting = mode !== 'shadow';
    const frontOpenDebts = mode === 'on' ? (await this.ledger.parkedEntries()).filter(e => Ledger.frontOpenOwed(e)) : [];
    const revokeHead = acting ? this.revokeHeadInForce() : null;
    const frontOutcome = mode === 'on' ? this.trainFrontOutcome : null;
    const input = trainRunInput({ mode, settings: trainSettings(train), sweep: trainSweepMode(train), onSince: mode === 'shadow' ? null : this.trainOnSince, revokeHeadRequestId: revokeHead?.requestId ?? null,
      frontOutcome: frontOutcome ? { pr: frontOutcome.pr, headSha: frontOutcome.headSha, testSha: frontOutcome.testSha, attempt: frontOutcome.attempt, code: frontOutcome.code } : null });
    const progress = this.trainLast?.sweep?.progress;
    const progressKey = idleProgressExtra ? `${progress.roundId}:${progress.token}` : null;
    const intent = await this.receipt('train-run-intent', acting ? { mode: train.enabled, runMode: mode, input,
      ...(idleProgressExtra ? { idleProgressExtra: true, progressKey } : {}) } : { mode: train.enabled });
    this.trainMaintenanceTick = this.tickSeq;
    this.trainRuns.push(now);
    if (idleProgressExtra) { this.trainExtraRuns.push(now); this.trainProgressConsumed = progressKey; }
    this.trainUrgent = false;
    this.trainAdmitOwed = false;
    this.trainLastMode = mode;
    this.report(s => s.setState('RUNNING', 'TRAIN_MAINTENANCE'));
    let r;
    const trainFrom = this.clock();
    try { r = await this.engine.runTrainStage(mode, input); } catch (error) { r = { ok: false, code: codeOf(error), proof: null }; }
    const proven = r?.proof?.windowsTreeZero === true && r?.proof?.serviceOriginalStopped === true;
    const o = r?.outcome ?? null;
    const quiet = o === null || (o.sideEffects === 0 && o.mayHavePublished === false);
    // On and revoke-only: revocations, touch, adopt, return, keepalive and the watermark are this stage's own work.
    const effects = acting && r?.ok === true && o?.status === 'TRAIN_FACTS' && Number.isSafeInteger(o.sideEffects) && o.sideEffects >= 0;
    const facts = r?.ok === true && (quiet || effects) ? trainSummary(r.train) : null;
    const summary = facts && facts.mode === mode ? facts : null;
    // A view for the upgrade precheck only (defect 15894c2a); a run that read no nodes keeps the older list, whose `at` ages.
    const nodesView = summary ? trainNodesView(r.train, this.policy.ciSourceManifestSha256) : null;
    if (nodesView) this.trainNodes = nodesView;
    this.report(s => s.noteTrain?.({ startedAt: trainFrom, endedAt: this.clock(), mode, sweep: summary?.sweep ?? null }));
    const failureCode = summary ? null : (r?.ok === true ? 'TRAIN_FACTS_UNCONFIRMED' : validCode(r?.code));
    const clean = proven && ((quiet && (r?.ok === true || failureCode === 'TRAIN_STAGE_REFUSED' || (o !== null && ['BLOCKED', 'TRAIN_FACTS'].includes(o.status))
      || classifyFailure(failureCode, { ...r.proof, ...TRAIN_LINUX_PROOF }, TRAIN_STAGE).klass === 'CLEAN')) || (effects && summary !== null));
    const haltCode = !proven ? 'TRAIN_STAGE_CLEANUP_UNCONFIRMED' : 'TRAIN_STAGE_OUTCOME_UNCONFIRMED';
    if (!clean || !summary) this.claimBindingObservations = new Map();
    if (!clean) await this.haltWith(haltCode, { phase: 'train-maintenance', intentSeq: intent.seq, failureCode, sideEffects: o?.sideEffects ?? null });
    const base = { intentSeq: intent.seq, runId: TRAIN_RUN_ID.test(r?.runId ?? '') ? r.runId : null, mode: train.enabled, ok: summary !== null, failureCode,
      wouldDo: summary?.wouldDo ?? null, frontPr: summary?.front?.pr ?? null, mainSha: summary?.mainSha ?? null, wouldRevokeCount: summary?.wouldRevokeCount ?? null };
    // The front outcome is cleared only when stage 10 reported failed, or reporting it became moot (the front is another PR or
    // head, or none), or the slot ran out by itself (slotHardCapMinutes after it was noted); otherwise the next run carries it again
    // (review R3 MINOR 3: a take-over sweep, a lost duty or a touch that failed reports nothing).
    const frontCleared = frontOutcome && summary && clean ? (summary.actions?.failedReported === true || summary.front?.pr !== frontOutcome.pr
      || summary.front?.headSha !== frontOutcome.headSha || !(now - (frontOutcome.at ?? now) < trainSettings(train).slotHardCapMinutes * 60_000)) : false;
    await this.receipt('train-run', acting ? { ...base, runMode: mode, decision: summary?.decision ?? null, sideEffects: Number.isSafeInteger(o?.sideEffects) ? o.sideEffects : null,
      requestPause: summary?.requestPause ?? null, frontOutcomeSeq: frontOutcome?.seq ?? null, ...(frontOutcome ? { frontOutcomeCleared: frontCleared } : {}),
      revokeHeadRequestId: input.revokeHeadRequestId } : base);
    if (summary) {
      if (clean) {
        this.claimBindingObservations = new Map();
        for (const candidate of summary.claimBindings ?? []) {
          const b = claimBindingObservationOf(candidate), at = Date.parse(b?.observedAt ?? '');
          if (b && b.repository === this.policy.repo && b.targetBranch === this.policy.baseBranch
            && b.sourceManifestSha256 === this.policy.ciSourceManifestSha256 && at <= this.clock() && this.clock() - at <= 30_000)
            this.claimBindingObservations.set(`${b.pr}:${b.headSha}:${b.baseSha}`, b);
        }
        await this.recheckClaims(this.clock());
        await this.persistQueue();
      }
      this.trainLast = summary;
      this.trainSweep = trainSweepView({ summary, previous: this.trainSweep, onSince: this.trainOnSince === null ? null : new Date(this.trainOnSince).toISOString() });
      if (acting && clean) await this.trainActed(summary, { mode, input, frontOutcome, frontCleared, revokeHead });
      // A real on-mode decision (including no front, a changed front or a refusal) spends this request once.
      // No settlement on a cadence/cap refusal, revoke-only run, failed read or unconfirmed cleanup/facts.
      // Enqueue first: a settlement write must never prevent the front Source already opened from reaching the queue.
      // A successful take-over closed the ordinary entry, which itself retires the debt without another record.
      if (mode === 'on' && clean) for (const e of frontOpenDebts) {
        await this.ledger.settleFrontOpen(e.key, { intentSeq: intent.seq, decision: summary.decision, frontPr: summary.front?.pr ?? null });
        this.trainFrontOwed.delete(e.key);
      }
      // Any mode: stage 10 read the merge queue's head. A batch parked at B for that PR gets its next try without waiting out its back-off.
      if (clean) {
        const front = summary.front;
        const identity = front?.pr ? `${front.pr}:${front.headSha ?? ''}:${summary.mainSha ?? ''}` : null;
        const changed = identity !== this.lastParkFront;
        this.lastParkFront = identity;
        if (front?.pr) await this.hintParkedHead(front, { changed });
      }
    }
    // P1a: the fast look of a bound front that did not open (train.mjs#trainFrontRecheckNext); any other run ends the current one.
    this.trainFrontRecheck = trainFrontRecheckNext(this.trainFrontRecheck ?? null, mode === 'on' && clean ? summary : null);
    if (acting && (!summary || !clean)) {
      this.trainStrictReadiness = null; this.trainStrictFrontReadiness = null;
      // DESIGN §62.4: a binding observation never outlives a stage-10 run that could not confirm it again.
      if (this.trainLast?.frontBind) { const { frontBind, ...rest } = this.trainLast; this.trainLast = Object.freeze(rest); }
    }
    this.trainProgressReady = mode === 'on' && clean && summary?.sweep?.unconfirmed === 0 && !summary.requestPause
      && !['TRAIN_REVOKE_UNCONFIRMED', 'TRAIN_SOURCE_MISMATCH', 'TRAIN_SOURCE_UNREADABLE'].includes(summary?.decision);
    await this.trainDutySave();
    // Generation 10: stage 10 reached GitHub only when its summary names main's commit (a run that is not on duty reads nothing).
    if (clean) await this.noteBreakerProbe(HEX40.test(summary?.mainSha ?? ''), 'train-run');
    return clean ? null : { state: 'HALTED', failureCode: haltCode };
  }

  // What the executor does with an on or revoke-only run's facts /2 (DESIGN §41.3, §41.4, §41.6).
  async trainActed(summary, { mode, input, frontOutcome, frontCleared, revokeHead }) {
    if (frontCleared && this.trainFrontOutcome?.seq === frontOutcome.seq) this.trainFrontOutcome = null;
    // The take-over is done only on a positive signal (review R3 M3): this node's full sweep in on mode is complete and began after
    // this very onSince (facts /2 sweep.fullSweep: state complete, sinceOn), never from a decision that is merely no deferral.
    const full = summary.sweep?.fullSweep;
    const onSince = this.trainOnSince === null ? null : new Date(this.trainOnSince).toISOString();
    // Generation 15 (DESIGN 60.2): main was rewritten: the take-over is not done until the round of scope all completes (the line below
    // sets it again then), so no batch starts meanwhile whatever else a run decides (an incomplete sweep, an unconfirmed revocation).
    if (full?.allPending === 'TRAIN_MAIN_REWRITTEN') this.trainTakeoverDone = false;
    if (!this.trainTakeoverDone && onSince !== null && input.onSince === onSince && full?.state === 'complete' && full.sinceOn === true) this.trainTakeoverDone = true;
    // DESIGN §65: in strict-permanent mode only the rewritten main holds the gate; it opens again once the round of scope all completed.
    if (!this.trainTakeoverDone && !this.trainSweepGates() && full?.allPending !== 'TRAIN_MAIN_REWRITTEN') this.trainTakeoverDone = true;
    const coverage = summary.sweep?.strictCoverage;
    this.trainStrictReadiness = mode === 'on' && input.onSince === onSince && summary.onDuty && summary.strict === true && summary.sweep?.complete === true
      && summary.sweep.proofWritten === true && summary.sweep.unconfirmed === 0 && full?.allPending !== 'TRAIN_MAIN_REWRITTEN'
      && coverage?.state === 'ready' && coverage.mainSha === summary.mainSha ? coverage : null;
    const currentFront = summary.sweep?.strictFrontReadiness;
    this.trainStrictFrontReadiness = mode === 'on' && input.onSince === onSince && summary.onDuty && summary.strict === true
      && summary.sweep?.unconfirmed === 0 && full?.allPending !== 'TRAIN_MAIN_REWRITTEN'
      && currentFront?.state === 'ready' && currentFront.mainSha === summary.mainSha ? currentFront : null;
    // #1144: Stage 10 refreshed the running batch's durable timestamp together with this round's proof.
    // Update only the scheduling view of the same claim/H/T/S; Stage 8 independently reads the durable batch
    // and live holder again. After restart the next round reconstructs this view from the original receipt.
    if (summary.decision === 'TRAIN_FRONT_BATCH_RUNNING' && this.trainStrictFrontReadiness) {
      const r = this.trainStrictFrontReadiness;
      for (const [key, f] of this.frontBindings) {
        if (f.pr === r.front.pr && f.headSha === r.front.headSha && f.claimId === r.front.claimId && f.baseSha === r.mainSha) {
          const updated = { ...f, since: r.front.since };
          const context = { now: this.clock(), repo: this.policy.repo, sourceManifestSha256: this.policy.ciSourceManifestSha256,
            settingsDigest: digest(trainSettings(this.policy.train)), onSince, front: updated, sweepFreshMs: trainSettings(this.policy.train).sweepFreshMs };
          if (strictFrontReadinessMatches(r, context)) this.frontBindings.set(key, updated);
        }
      }
    }
    const rh = summary.actions?.revokeHead;
    if (revokeHead && rh?.requestId === revokeHead.requestId) {
      this.reportRevokeHead({ requestId: rh.requestId, state: rh.done ? 'done' : 'not-done', code: rh.done ? null : summary.decision });
      // Done: the receipt first, then the request's file is archived (a restart in between finds the receipt: never twice).
      if (rh.done) {
        (this.revokeHeadDoneIds ??= new Set()).add(rh.requestId);
        let recorded = true;
        try { await this.receipt('revoke-head-done', { requestId: rh.requestId, decision: summary.decision }); } catch { recorded = false; }
        if (recorded && revokeHead.name) { try { await this.requests.dispose(revokeHead.name, 'processed'); } catch { /* archived when it expires */ } }
        if (this.revokeHead?.requestId === rh.requestId) this.revokeHead = null;
      }
    }
    if (TRAIN_OWNER_NOTICE_DECISIONS.includes(summary.decision)) {
      this.queue.notice({ key: `train-owner:${summary.decision}:${summary.front?.pr ?? 'x'}:${dayKey(this.clock())}`, kind: 'train-owner', pr: summary.front?.pr ?? null,
        headSha: summary.front?.headSha ?? null, code: summary.decision });
      try { await this.persistQueue(); } catch { /* a view */ }
    }
    // A landed tree that is not the tested one (v0.2 §3.3 item 2): PAUSE, latched here; stage 10 never writes resident requests.
    if (summary.requestPause) {
      const source = { reason: `train-maintenance: ${summary.requestPause}`, requestSha256: sha256(Buffer.from(`train-run:${summary.at}:${summary.requestPause}`)) };
      if (await this.ledger.pause(source)) {
        this.reportLatch({ paused: true });
        await this.receipt('paused', source);
      }
    }
    if (mode === 'on' && summary.openFrontBatch && await this.enqueueFront(summary.openFrontBatch) !== null) this.tickBatchDue = true;
    // A front-bind to run (frontBind on the summary): the binding run is due in the next tick, not after a resting sleep.
    if (mode === 'on' && summary.frontBind) this.tickBatchDue = true;
    // TRAIN_FRONT_BATCH_RUNNING: this node's front batch still runs and stage 10 refreshed its sweep proof; nothing to enqueue,
    // but a front batch of that head parked at B gets its next stage-8 try now (parkedDueAt), within the usual try budgets.
    if (mode === 'on' && summary.decision === 'TRAIN_FRONT_BATCH_RUNNING' && summary.front?.pr) await this.nudgeFrontParked(summary.front);
    // Field defect PR #1035: the front batch stage 10 still counts as running was refused as busy and never ran: offer it again (the run that
    // just refreshed its strict observation names the same head on the same main).
    const retry = this.frontRetry;
    if (mode === 'on' && retry && summary.decision === 'TRAIN_FRONT_BATCH_RUNNING' && summary.front?.pr === retry.pr && summary.front.headSha === retry.headSha
      && summary.mainSha === retry.baseSha) {
      this.frontRetry = null;
      if (await this.enqueueFront(retry) !== null) { this.tickBatchDue = true; try { await this.receipt('train-front-reoffered', { pr: retry.pr, headSha: retry.headSha, testSha: retry.testSha, attempt: retry.attempt }); } catch { /* a view */ } }
    }
  }

  async nudgeFrontParked(front) {
    let entries;
    try { entries = (await this.ledger.parkedEntries()).filter(e => Ledger.parkedAt(e)); } catch { return; }
    this.parkNudges ??= new Map();
    for (const e of entries) {
      const s = e.reserved?.subject;
      if (s && !this.parkedAsleep(e) && Object.hasOwn(s, 'testSha') && s.pr === front.pr && (!front.headSha || s.headSha === front.headSha)) this.parkNudges.set(e.key, this.clock());
    }
  }

  // ---- parking (phase 2, step 2; DESIGN §18) ----

  // Generation 12 (DESIGN §56.2): the queue watch. A batch parked at B whose last try found its claim outside the merge queue
  // (RESIDENT_MERGE_QUEUE_NOT_JOINED) or behind another claim (RESIDENT_QUEUE_HEAD_NOT_REACHED) waits up to two hours for its
  // next try (PARK_RETRY_MS), although stage 8 can pass as soon as the claim holds the merge slot: the holder joins the queue,
  // the claim ahead merges. Every QUEUE_WATCH_MS, on a tick that ran nothing and on an ACTIVE node, one role probe watches one
  // such batch's PR (the batches take turns, each on its own cadence: QUEUE_WATCH_RAMP_MS, QUEUE_WATCH_FAIL_MS); when the slot holder
  // becomes bound to that PR, the batch's try is due now (watchAnswered). Only the change from not holding the slot to holding it
  // brings a try forward: a holders answer that keeps saying "head" while stage 8 says not ready (the two read different things)
  // leaves the batch on its own back-off, so the watch can never burn a head faster than before.
  // A watch writes nothing to GitHub or Native (only its own role-probe receipts) and is never a try: it counts towards no try budget.
  // QUEUE_WATCH_MAX_PER_DAY bounds the probes; a batch whose try is due within QUEUE_WATCH_MS anyway, or that is out of tries for the
  // day, is not watched.
  // A try at the queue's first place comes PARK_HEAD_RETRY_MS after the last one only during its streak (PARK_HEAD_STREAK_MS); once the
  // back-off applies again (its next try is further away) that batch is watched like the others. view: the rows the PR page may call
  // watched (whatever their next try's time).
  queueWatchCandidates(entries, now, { view = false } = {}) {
    return entries.filter(e => {
      if (!Ledger.parkedAt(e)) return false;
      const last = ResidentExecutor.lastTry(e), pr = e.reserved?.subject?.pr;
      const streak = last?.position === 1 && !(Date.parse(last.nextAt) - Date.parse(last.at) > PARK_HEAD_RETRY_MS);
      return last && last.transient !== true && QUEUE_WATCH_CODES.includes(last.code) && !streak && Number.isSafeInteger(pr) && pr > 0
        && (view || this.parkedDueAt(e) > now + QUEUE_WATCH_MS) && now - Date.parse(e.parked.at) < this.policy.park.maxMs;
    });
  }

  // When batch e may be watched again: its own cadence after its last watch (none yet: now).
  queueWatchDueAt(e) {
    const book = this.queueWatchBook?.get(e.key);
    if (!book) return -Infinity;
    const age = book.at - Date.parse(e.parked.at);
    const every = QUEUE_WATCH_RAMP_MS.find(r => age < r.until).every;
    return book.at + Math.max(every, book.failures > 0 ? QUEUE_WATCH_FAIL_MS[Math.min(book.failures, QUEUE_WATCH_FAIL_MS.length) - 1] : 0);
  }

  async queueWatchMaintenance() {
    if (typeof this.engine.runRoleProbe !== 'function' || this.roleProbeRunning) return null;
    const now = this.clock(), day = dayKey(now);
    const off = () => { this.queueWatchView = new Set(); return null; };
    if (this.nodeMode() !== 'ACTIVE') return off();
    // Never under an intake pause (in force, or its state unreadable), whatever the queue holds, like the role probe it is a run of
    // (DESIGN §56.2; review round 20, NIT 1): before, a pause held it only on a tick whose schedule had a due row. Nor while the train's
    // take-over sweep holds the parked batches (resumeParked hold): a try could not follow the watch.
    if (this.intakeTroubleSince != null || this.intakePause?.view(now) || this.trainTakeoverPending()) return off();
    if (this.queueWatchDay?.day !== day) this.queueWatchDay = { day, n: 0 };
    if (this.queueWatchDay.n >= QUEUE_WATCH_MAX_PER_DAY) return off();
    // The status view first, on every quiet tick (review round 3, MINOR 6): a slow probe never lets it lapse while watches go on.
    let entries;
    try { entries = await this.ledger.parkedEntries(); } catch { return null; }
    let candidates = this.queueWatchCandidates(entries, now), shown = this.queueWatchCandidates(entries, now, { view: true });
    this.queueWatchBook ??= new Map();
    for (const k of [...this.queueWatchBook.keys()]) if (!entries.some(e => e.key === k && Ledger.parkedAt(e))) this.queueWatchBook.delete(k);
    if (shown.length === 0) return off();
    // Only with a Source that knows the watch (engine-windows.mjs#queueWatchSupported); an engine without the check never watches.
    try { if (typeof this.engine.queueWatchSupported !== 'function' || (await this.engine.queueWatchSupported()) !== true) return off(); } catch { return off(); }
    // A different PR cannot exhaust this watch's follow-up retry. Cache each PR's budget for one watch cadence.
    this.queueWatchBudgets ??= new Map();
    const prs = new Set([...candidates, ...shown].map(e => e.reserved.subject.pr));
    for (const pr of this.queueWatchBudgets.keys()) if (!prs.has(pr)) this.queueWatchBudgets.delete(pr);
    for (const pr of prs) {
      const old = this.queueWatchBudgets.get(pr);
      if (old && now >= old.at && now - old.at < QUEUE_WATCH_MS) continue;
      let ok = false;
      try { ok = (await this.ledger.usage(now - DAY, { stage8Pr: pr, budgetTimes: true })).stage8Retries < this.policy.park.stage8RetriesPer24h; } catch { /* no proven budget */ }
      this.queueWatchBudgets.set(pr, { at: now, ok });
    }
    const affordable = e => this.queueWatchBudgets.get(e.reserved.subject.pr)?.ok === true;
    candidates = candidates.filter(affordable); shown = shown.filter(affordable);
    if (shown.length === 0) return off();
    // The status: these rows are watched (the PR page says the try follows the slot within minutes), as of now (queueWatchViewAt: a view
    // not renewed by a quiet tick within QUEUE_WATCH_VIEW_MS, as while another batch runs, says nothing).
    this.queueWatchView = new Set(shown.map(e => `${e.reserved.subject.pr}:${e.reserved.subject.headSha}`));
    this.queueWatchViewAt = now;
    this.queueWatchViewTick = this.tickSeq;
    // A clock that went back since the last probe or observation: no watch until it has caught up (the role book refuses it).
    if ([this.roleProbeEndedAt, this.roleProbe.last?.at].some(at => Number.isFinite(at) && now < at)) return null;
    // One swap per QUEUE_WATCH_MS at most, counted from the end of the last role probe (a watch or not).
    if (Number.isFinite(this.roleProbeEndedAt) && now - this.roleProbeEndedAt < QUEUE_WATCH_MS) return null;
    // A watch that could not start (not idle, the install authority ending) is not tried again on every quiet tick.
    if (Number.isFinite(this.queueWatchTriedAt) && now >= this.queueWatchTriedAt && now - this.queueWatchTriedAt < QUEUE_WATCH_MS) return null;
    const due = candidates.filter(e => this.queueWatchDueAt(e) <= now).sort((a, b) => this.queueWatchDueAt(a) - this.queueWatchDueAt(b) || a.key.localeCompare(b.key));
    if (due.length === 0) return null;
    const pick = due[0];
    this.queueWatchTriedAt = now;
    return this.roleProbeMaintenance({ watch: { key: pick.key, pr: pick.reserved.subject.pr, lastEnd: Date.parse(ResidentExecutor.lastTry(pick)?.at ?? '') } });
  }

  // A watch answered for batch watch.key: 'head' (its PR's claim holds the merge slot), 'not-head', or 'unknown' (uncertain,
  // deferred or no fact). Only a change to 'head' from anything else brings the batch's try forward: due now, never sooner than
  // PARK_HEAD_RETRY_MS after its last try ended.
  watchAnswered({ key, lastEnd }, answer) {
    this.queueWatchBook ??= new Map();
    const before = this.queueWatchBook.get(key);
    const now = this.clock();
    this.queueWatchBook.set(key, { at: now, answer: answer === 'unknown' ? (before?.answer ?? null) : answer,
      failures: answer === 'unknown' ? (before?.failures ?? 0) + 1 : 0 });
    if (answer !== 'head' || before?.answer === 'head') return;
    const due = Math.max(now, Number.isFinite(lastEnd) ? lastEnd + PARK_HEAD_RETRY_MS : now);
    this.parkNudges ??= new Map();
    this.parkNudges.set(key, Math.min(this.parkNudges.get(key) ?? due, due));
  }

  // Stage 10 (shadow or on) read the merge queue's head: front = { pr, headSha }. A batch parked at B for exactly that PR and head
  // may be the claim that just became first, so its next stage-8 try is due now instead of after a back-off of up to two hours
  // (Task 867250db). Only a hint: the try itself reads the queue, and counts as any try. Never twice within PARK_HEAD_RETRY_MS of
  // the last try's end for one batch, so a front that stays put cannot make a tight loop.
  async hintParkedHead(front, { changed = true } = {}) {
    let entries;
    try { entries = (await this.ledger.parkedEntries()).filter(e => Ledger.parkedAt(e)); } catch { return; }
    const now = this.clock();
    for (const e of entries) {
      const s = e.reserved?.subject;
      if (!s || s.pr !== front.pr || !front.headSha || s.headSha !== front.headSha || (!changed && this.parkedAsleep(e))) continue;
      const lastEnd = Date.parse(ResidentExecutor.lastTry(e)?.at ?? '');
      const due = Math.max(now, Number.isFinite(lastEnd) ? lastEnd + PARK_HEAD_RETRY_MS : now);
      this.parkNudges ??= new Map();
      this.parkNudges.set(e.key, Math.min(this.parkNudges.get(e.key) ?? due, due));
    }
  }

  // The newest stage-8 try of a parked entry (its 72 record), or null before the first one ended.
  static lastTry(entry) { return entry.tries?.length ? entry.tries[entry.tries.length - 1].ended : null; }

  parkedAsleep(entry) {
    const last = ResidentExecutor.lastTry(entry);
    return last?.sleeping === true || (this.clock() - Date.parse(entry.parked.at) >= this.policy.park.maxMs
      && failureRow({ stage: 8, code: last?.code })?.disposition === 'park');
  }

  // A parked batch counts towards park.maxParked when it waits at A, or when its claim was in the merge queue's first two
  // places at its last try (design v0.5 §4.7, review M4); the others are bounded by park.maxParkedOutsideTop2. A batch parked by
  // a transient stage-8 ending (DESIGN §28) has no true place (null): it counts by its assumed place (independent review r3,
  // NIT 2), so it never pushes other batches over the outside bound.
  async parkedCounts(entries = null) {
    const all = entries ?? await this.ledger.parkedEntries();
    let inside = 0, outside = 0;
    for (const e of all) {
      if (Ledger.waitingAt(e)) { inside += 1; continue; }
      if (this.parkedAsleep(e)) continue;
      const last = ResidentExecutor.lastTry(e);
      const p = Number.isSafeInteger(last?.position) ? last.position : (last?.transient === true ? last.assumedPosition : null);
      if (Number.isSafeInteger(p) && p <= 2) inside += 1; else outside += 1;
    }
    return { inside, outside };
  }

  // When the next stage-8 try of a parked entry is due (a nudge brings it forward, at most every PARK_NUDGE_MS).
  parkedDueAt(e) {
    const last = ResidentExecutor.lastTry(e);
    if (this.parkedAsleep(e)) return this.parkNudges?.get(e.key) ?? Infinity;
    const at = last ? Date.parse(last.nextAt) : Date.parse(e.parked.at);
    const nudged = this.parkNudges?.get(e.key);
    return Number.isFinite(nudged) ? Math.min(at, nudged) : at;
  }

  // { acted: the result of a parked batch that moved on (it continued, ended, or ran a stage-8 try), waiting: the last
  // still-waiting result when one only waits }.
  // hold: evaluate nothing (the train on's take-over sweep is pending); the status still shows them.
  async resumeParked({ hold = false } = {}) {
    let entries = await this.ledger.parkedEntries();
    // Generation 12 (DESIGN §56.3): after a restart, a parked batch's lease end comes back from its newest record (the last stage-8
    // try's, else the parking record at B, else the wait record at A), before anything below may return.
    // The newest record that has the field decides, also when it says none (null).
    const newestLease = e => [ResidentExecutor.lastTry(e), e.parked, e.wait].find(x => x && Object.hasOwn(x, 'claimExpiresAt'))?.claimExpiresAt ?? null;
    for (const e of entries) {
      const s = e.reserved?.subject, at = Date.parse(newestLease(e) ?? '');
      if (s && Number.isFinite(at) && !this.claimLeases?.has(`${s.pr}:${s.headSha}`)) { this.claimLeases ??= new Map(); this.claimLeases.set(`${s.pr}:${s.headSha}`, { expiresAt: at }); }
    }
    // Every batch resting at parking point A, for the status page (Task 4012c1b9, review N4 of step 2): several may wait at
    // once, each shown on its own row as PARKED_A, not only the one in `current`.
    this.parkedA = new Set(entries.filter(x => Ledger.waitingAt(x)).map(x => `${x.reserved?.subject?.pr}:${x.reserved?.subject?.headSha}`));
    // Whether new batches wait for the parking places: shown on the status of every tick, not only one that deferred
    // (re-review of step 2, m8).
    const counts = await this.parkedCounts(entries);
    const outsideMax = this.policy.park.maxParkedOutsideTop2;
    this.parkingFull = counts.inside >= this.policy.park.maxParked || (outsideMax > 0 && counts.outside >= outsideMax);
    // A batch that no longer stands (its PR closed, a newer head, this node off duty) was ended by the rule before this (endNotStanding,
    // DESIGN §72), whatever the train gate below says: field defect PR #1035 needs no step of its own here.
    if (hold) entries = entries.filter(e => this.frontBindKeys.has(e.key) || (this.trainStrictFront(e.reserved?.subject) && !this.trainGate(e.reserved?.subject)));
    if (entries.length === 0) return { acted: null, waiting: null };
    let waiting = null;
    for (const e of entries.filter(x => Ledger.waitingAt(x))) {
      const r = await this.resumeWaiting(e);
      if (r?.state !== 'WAITING') return { acted: r, waiting: null };
      waiting = r;
    }
    const now = this.clock();
    let sleepViewChanged = false;
    for (const e of entries.filter(x => Ledger.parkedAt(x) && this.parkedAsleep(x))) {
      const { pr, headSha } = e.reserved.subject;
      const row = this.queue.row(pr), last = ResidentExecutor.lastTry(e);
      if (row?.parked?.nextAt != null)
        sleepViewChanged = this.queue.park(pr, headSha, { reason: last.code, nextAt: null, position: last.position }, now) || sleepViewChanged;
    }
    if (sleepViewChanged) await this.persistQueue();
    // Transient parks and batches with no settled not-ready answer retain the old age backstop.
    const expired = entries.find(x => Ledger.parkedAt(x) && !this.parkedAsleep(x) && now - Date.parse(x.parked.at) >= this.policy.park.maxMs);
    if (expired) {
      const last = ResidentExecutor.lastTry(expired);
      return { acted: await this.endParkedB(expired, last?.code ?? 'RESIDENT_QUEUE_HEAD_NOT_REACHED'), waiting };
    }
    const due = entries.filter(x => Ledger.parkedAt(x) && this.parkedDueAt(x) <= now).sort((a, b) => this.parkedDueAt(a) - this.parkedDueAt(b));
    if (due.length === 0) return { acted: null, waiting };
    for (const e of due) {
      const pr = e.reserved.subject.pr;
      const usage = await this.ledger.usage(now - DAY, { stage8Pr: pr, budgetTimes: true });
      if (usage.stage8Retries < this.policy.park.stage8RetriesPer24h) return { acted: await this.resumeParkedB(e), waiting };
      this.queue.notice(await this.quotaNotice('STAGE8_RETRY_BUDGET_EXHAUSTED', e.reserved.subject, usage));
    }
    return { acted: null, waiting };
  }

  // A batch parked at B ends without a try: its time ran out (park.maxMs, the backstop outside the rule of DESIGN §72: a batch that
  // stands, or whose PR cannot be read, holds a parking place at most this long), or stage 10's front batch takes over its head. A
  // Windows-only stage-8 ending, nothing ran.
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

  // A batch resting at parking point A ends without going on (only stage 1 ran: nothing else was published), as the install authority's
  // end closes it there (resumeWaiting).
  async endWaitingA(entry, code) {
    const { key } = entry, { batch } = entry.wait, subject = entry.reserved.subject;
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: entry.reserved.reservedAt ?? null };
    let outcome;
    try {
      const drift = await this.driftCode();
      outcome = drift ? await this.unknown(key, drift, 'resume-start-checks', batch)
        : await this.fail(key, batch, Object.assign(new StepFailure(1, code, { windowsTreeZero: true }, 'stage', 0), { windowsOnly: true }));
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
  // Generation 22 field defect (PR #1029: proof written 08:19:59, front batch 08:20:24, stage 7 ended 08:35:09, stage 8 refused with
  // TRAIN_SINGLE_GREEN_NOT_PROVEN, the retry after stage 10's refresh succeeded 08:39:37): whether this front batch (S) rests on a strict
  // proof (the take-over fast track: its scheduling went through trainStrictFront) that will not last through its stage 8: less than
  // FRONT_PROOF_MARGIN_MS left, or none. Never widens the proof: it only asks stage 10 for a fresh one before the try.
  frontProofShort(subject) {
    // DESIGN §65: in strict-permanent mode every front batch rests on the strict current-front proof, before and after the take-over.
    if (!subject || !Object.hasOwn(subject, 'testSha') || !this.trainEligible() || this.trainFullCovers()) return false;
    const front = this.frontBindings.get(`${subject.pr}:${subject.testSha}`);
    if (!front || front.headSha !== subject.headSha) return false;
    const named = [this.trainStrictReadiness, this.trainStrictFrontReadiness].some(r => r?.front?.pr === subject.pr && r.front.headSha === subject.headSha);
    return named && !this.trainStrictFront(subject, { at: this.clock() + FRONT_PROOF_MARGIN_MS });
  }

  async stage8Try(key, subject, batch) {
    // Generation 22: the batch rests at parking point B (the Linux zone is closed, nothing of it runs), where stage 10 may run as it does
    // after a schedule that ran nothing: a front batch whose strict proof would run out first gets it refreshed now (urgent: only the
    // cadence is waived; the daily cap, one run per tick and every gate of trainMaintenance hold), so its first try is not refused.
    // A HALT that run latched leaves the batch at B (due at once after the re-arm), with no try.
    if (this.policy.train.enabled === 'on' && this.frontProofShort(subject)) {
      this.trainUrgent = true;
      try { await this.receipt('train-front-proof-refresh', { key, pr: subject.pr, headSha: subject.headSha, testSha: subject.testSha }); } catch { /* a view */ }
      const refreshed = await this.trainMaintenance();
      if (refreshed?.state === 'HALTED') return { state: 'PARKED', key, reason: refreshed.failureCode ?? 'TRAIN_STAGE_HALTED', until: this.clock(), position: null, tries: 0, settle: null };
    }
    const s = await this.ledger.state(key);
    const windowsOnly = f => Object.assign(f, { windowsOnly: true }); // only stage 8 ran here (breaker, review m2)
    const unrecorded = await this.beforePublication(key, subject, 8);
    if (unrecorded) { unrecorded.relayedRoles = s.plan?.relayed?.length ?? 0; return windowsOnly(unrecorded); }
    const n = await this.ledger.beginTry(key, { batchId: batch.batchId });
    this.atStage(8, 'stage');
    const { result: control, aborted } = await this.runWindowsStageWithRetry(key, batch, 8);
    if (aborted) return aborted;
    this.noteLease(subject, control);
    await this.receipt('stage-terminal', { key, stage: 8, ok: control.ok === true, failureCode: control.ok ? null : validCode(control.code), factsSha256: control.factsSha256 ?? null, outcome: outcomeSummary(control), try: n });
    const relayed = s.plan?.relayed?.length ?? 0;
    if (control.ok === true) {
      await this.ledger.terminal(key, 'COMPLETED', { batchId: batch.batchId, closed: s.parked.closed ?? null, relayed: s.plan.relayed.map(r => r.role), local: s.parked.local ?? [], tries: n });
      await this.receipt('batch-terminal', { key, outcome: 'COMPLETED' });
      this.reportOutcome(subject, 'COMPLETED', { key });
      // ADR 0018 §6: in push mode a front batch that completed stage 8 has landed main; stage 10 adopts its members right away
      // (urgent, under the daily cap like every urgent run) instead of at the next routine run.
      if (subject?.testSha && subject.testSha !== subject.headSha && trainLandingMode(this.policy.train) === 'push' && this.policy.train.enabled === 'on') this.trainUrgent = true;
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
    const park = zero && failureRow({ stage: 8, code: control.code })?.disposition === 'park';
    const tryLimit = counted >= this.policy.park.stage8MaxTries;
    if (zero && tryLimit && (park || STAGE8_NOT_READY_CODES.includes(control.code)))
      this.queue.notice(boundedNotice({ code: 'STAGE8_TRY_LIMIT', subject, used: counted, limit: this.policy.park.stage8MaxTries,
        now, recovery: park ? 'park-event' : 'batch', episode: key }));
    // The absolute retry cap also covers the uncounted head tries. Event-driven tries may follow it.
    const final = control.code === 'RESIDENT_BASE_MOVED' || tryLimit || n >= MAX_TRIES || now - Date.parse(s.parked.at) >= this.policy.park.maxMs;
    if (park) {
      const sleeping = final;
      // The back-off follows the counted tries: after a run at the queue's first place the next try is not 2 hours away
      // (re-review N6).
      const backoff = PARK_RETRY_MS[Math.min(Math.max(counted - 1, 0), PARK_RETRY_MS.length - 1)];
      const nextAt = sleeping ? null : now + (position === 1 && now - streakFrom < PARK_HEAD_STREAK_MS ? PARK_HEAD_RETRY_MS : backoff);
      // Over capacity outside the queue's first two places: end it now rather than hold a slot (§4.9, review n-m9).
      const counts = await this.parkedCounts();
      if (!sleeping && !(Number.isSafeInteger(position) && position <= 2) && counts.outside >= this.policy.park.maxParkedOutsideTop2) {
        this.queue.notice(boundedNotice({ code: 'PARKED_OVER_CAPACITY', used: counts.outside, limit: this.policy.park.maxParkedOutsideTop2, now }));
        await this.ledger.endTry(key, n, { code: control.code, nextAt: new Date(now).toISOString(), position, entered: queueFact?.entered ?? null, ending: 'PARKED_OVER_CAPACITY' });
        return this.supersededEnd(key, subject, batch, { safePoint: 'parked', pos: POSITIONS[8], stage: 8, basis: 'park-over-capacity' });
      }
      await this.ledger.endTry(key, n, { code: control.code, nextAt: sleeping ? null : new Date(nextAt).toISOString(), position, entered: queueFact?.entered ?? null,
        ...(sleeping ? { sleeping: true } : {}),
        ...(this.parkEvents?.has(key) ? { parkEvent: this.parkEvents.get(key) } : {}),
        claimExpiresAt: this.leaseOf(subject),
        ...(this.policy.train.enabled === 'on' && !Object.hasOwn(subject, 'testSha') && control.code === 'TRAIN_SINGLE_GREEN_NOT_PROVEN' && position === 1
          ? { frontOpenOwed: true } : {}) });
      if (Ledger.frontOpenOwed(await this.ledger.state(key))) {
        this.trainFrontOwed.set(key, subject);
        this.trainUrgent = true;
      }
      await this.receipt('stage8-not-ready', { key, try: n, failureCode: control.code, nextAt: sleeping ? null : new Date(nextAt).toISOString(), position });
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
      await this.ledger.endTry(key, n, { code: control.code, nextAt: new Date(nextAt).toISOString(), position, entered: queueFact?.entered ?? null, transient: true, assumedPosition,
        claimExpiresAt: this.leaseOf(subject) });
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
  // inFlight: this.current is the batch running now (atStage), so its lease is kept whatever its PR's row shows (this.current outlives
  // its batch, so only a caller that knows says so).
  reportQueue({ inFlight = false } = {}) {
    this.report(s => {
      const b = breakerOf(this.queue.breaker);
      const parkedA = this.parkedA ?? new Set();
      const now = this.clock(), view = this.queue.view(now, { etaBatchMs: ETA_BATCH_MS });
      // Leases of batches no longer live in the queue (done or stopped) and not in flight are forgotten.
      // (this.current keeps the last batch after it ended, so only the queue's own rows say what is live.)
      const live = new Set(view.filter(r => !['DONE', 'STOPPED'].includes(r.state)).map(r => `${r.pr}:${r.headSha}`));
      if (inFlight && this.current && Number.isSafeInteger(this.current.pr)) live.add(`${this.current.pr}:${this.current.headSha}`);
      for (const k of [...(this.claimLeases?.keys() ?? [])]) if (!live.has(k)) this.claimLeases.delete(k);
      const atA = r => r.state === 'RUNNING' && parkedA.has(`${r.pr}:${r.headSha}`);
      const isCurrent = r => this.current && r.pr === this.current.pr && r.headSha === this.current.headSha;
      // A batch at parking point A still has its whole run ahead (since: now); one at B needs only stage 8 and the merge.
      this.leaseNotices([...view.filter(r => r.state === 'PARKED').map(r => ({ pr: r.pr, headSha: r.headSha, running: false })),
        ...view.filter(r => atA(r)).map(r => ({ pr: r.pr, headSha: r.headSha, running: true, since: now })),
        // The batch in flight, only from atStage (inFlight): this.current outlives its batch, and a released batch is not running
        // (review round 17, MINOR 2).
        ...(inFlight && this.current && live.has(`${this.current.pr}:${this.current.headSha}`) && !view.some(r => isCurrent(r) && (r.state === 'PARKED' || atA(r)))
          // A batch resting at A ('relay-wait') counts from now, like every batch at A (review round 18, NIT 1).
          ? [{ pr: this.current.pr, headSha: this.current.headSha, running: true,
            since: this.current.phase === 'relay-wait' ? now : (Date.parse(this.current.leaseFrom ?? this.current.since ?? '') || null) }] : [])], now);
      // The notices after leaseNotices, so a new lease-short notice is in this report (review round 2, NIT 12).
      s.update({ queue: { generation: this.queue.generation, live: this.queue.live().length, depth: this.policy.limits.queueDepth, parkingFull: this.parkingFull === true,
        hold: this.scheduleHold ?? null }, breaker: breakerView(b),
        notices: [...(this.versionState?.notices ?? []), ...(this.companionPresence?.notices(now) ?? []), ...this.roleProbeNotices, ...this.queue.notices].slice(0, 50) });
      const watchedNow = Number.isFinite(this.queueWatchViewAt) && now >= this.queueWatchViewAt && now - this.queueWatchViewAt <= QUEUE_WATCH_VIEW_MS;
      s.setPending(view.map(r => ({ ...(atA(r) ? { ...r, reason: PARKED_A_REASON } : r), claimExpiresAt: this.leaseOf(r),
        frontOpenOwed: r.state === 'PARKED' && this.trainEligible() && this.trainTakeoverDone
          && [...this.trainFrontOwed.values()].some(o => o.pr === r.pr && o.headSha === r.headSha),
        watched: watchedNow && r.state === 'PARKED' && this.queueWatchView?.has(`${r.pr}:${r.headSha}`) === true })));
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
      // An observed change only wakes a bound parked batch. It never admits a new one.
      if (t.parkEvent) {
        nudges.push({ t, seen: false });
        done.push({ name: entry.name, disposition: 'processed', receipt: ['park-event', { pr: t.pr, headSha: t.headSha, event: t.parkEvent }] });
        continue;
      }
      const previousPrUpdate = this.queue.row(t.pr)?.prUpdatedAt;
      const r = this.queue.offer(t, now, { depth: this.policy.limits.queueDepth, cooldownMs: this.policy.limits.unexecutedCooldownMs });
      if (r.action === 'refused') {
        this.queue.notice(boundedNotice({ code: 'QUEUE_DEPTH_EXCEEDED', used: this.queue.live().length, limit: this.policy.limits.queueDepth, now }));
        done.push({ name: entry.name, disposition: 'rejected', receipt: ['trigger-refused', { failureCode: r.code, pr: t.pr, headSha: t.headSha, bytesSha256 }] });
        continue;
      }
      if (r.action === 'new-trigger') this.queue.notice({ key: `poke:${t.pr}:${t.headSha}`, kind: 'new-trigger', pr: t.pr, headSha: t.headSha, code: null });
      // A new edit can wake the running head at B even when the queue has already seen that head.
      const prEdited = t.prUpdatedAt !== null && this.queue.row(t.pr)?.prUpdatedAt !== previousPrUpdate;
      nudges.push({ t, seen: r.action === 'seen' && !prEdited });
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
    this.parkEvents ??= new Map();
    for (const e of entries) {
      const s = e.reserved.subject;
      // The main tip comes from the poller (its triggers carry prUpdatedAt); an Agent's trigger may name any base. Each tip
      // nudges a batch once (re-review of step 2, m7: alternating stale bases nudged every 5 minutes).
      const nudged = this.parkNudgeBase.get(e.key) ?? [];
      const moved = triggers.find(({ t }) => t.prUpdatedAt !== null && t.baseSha !== s.baseSha && !nudged.includes(t.baseSha));
      const edited = triggers.some(({ t, seen }) => !t.parkEvent && t.pr === s.pr && !seen);
      const event = triggers.findLast(({ t }) => t.parkEvent && t.pr === s.pr && t.headSha === s.headSha && t.baseSha === s.baseSha);
      const changed = event && event.t.parkEvent !== (this.parkEvents.get(e.key) ?? ResidentExecutor.lastTry(e)?.parkEvent);
      if (!moved && !edited && !changed) continue;
      const due = Math.max(now, (this.parkNudgedAt.get(e.key) ?? -Infinity) + PARK_NUDGE_MS);
      if (due > now && !changed) continue;
      if (moved) this.parkNudgeBase.set(e.key, [...nudged, moved.t.baseSha].slice(-32));
      if (changed) this.parkEvents.set(e.key, event.t.parkEvent);
      this.parkNudgedAt.set(e.key, due);
      this.parkNudges.set(e.key, Math.min(this.parkNudges.get(e.key) ?? due, due));
    }
    const open = new Set(entries.map(e => e.key));
    for (const key of this.parkEvents.keys()) if (!open.has(key)) this.parkEvents.delete(key);
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
      const kind = Ledger.flowEnd(s) ? 'readmit' : s.state === 'TERMINAL' ? (s.outcome === 'COMPLETED' ? 'completed' : 'burned') : 'released';
      // Released (moved to ledger-unexecuted): its own record says whether it was a wait.
      const release = kind === 'released' ? (await this.ledger.unexecutedRecords(key, 0).catch(() => [])).at(-1) ?? null : null;
      this.queue.settle(row.pr, headSha, { kind, code: s.terminal?.facts?.failureCode ?? null, klass: s.terminal?.facts?.class ?? release?.klass ?? null, reason: release?.reason ?? 'RECONCILED' }, this.clock());
      changed = true;
    }
    if (changed) await this.persistQueue();
  }

  async requeueFlowEnds() {
    for (const flow of await this.ledger.pendingFlowEnds()) {
      this.queue.readmit(flow.reserved.subject, this.clock(), { depth: this.policy.limits.queueDepth, cooldownMs: this.policy.limits.unexecutedCooldownMs });
    }
    await this.persistQueue();
  }

  // One scheduling pass (design v0.5 §4.3; v0.6 §7 minor 4): a due attempt 2 first, then the queue's due waits and
  // poked rows, then first come, first served. A row that is only deferred for itself, or ignored, never blocks the
  // rows behind it; a global deferral (the daily limits, the companion, the breaker) ends the pass.
  async schedule() {
    // Defect 8f8240ff (review MAJOR 1): held first, before anything here asks the companion (recheckClaims' pr-head): its one mailbox
    // lane may be busy with the step's Linux prune, and each such request would wait for its own deadline.
    if (this.betweenBatchesRunning) { await this.persistQueue(); return { state: 'DEFERRED', reason: BETWEEN_BATCHES_RUNNING }; }
    const now = this.clock();
    this.queue.compact(now);
    const b = breakerOf(this.queue.breaker);
    this.queue.breaker = b;
    let attempts = (await this.ledger.pendingAttempts2()).filter(a => a.notBefore <= now);
    await this.recheckClaims(now);
    let rows = this.queue.candidates(now);
    this.reportQueue();
    if (attempts.length === 0 && rows.length === 0) { await this.persistQueue(); return { state: 'IDLE' }; }
    // The node gate (C3, DESIGN §29): no new batch of any kind unless this node is ACTIVE, and before the intake pause, so a node
    // that is not ACTIVE shows why and still runs the role probe. Triggers were read already; a batch in flight went on.
    const notActive = this.nodeGate();
    if (notActive) { await this.persistQueue(); return notActive; }
    // The train on (DESIGN §41.6): no new batch before the take-over sweep, nor while stage 10 says another node runs another
    // Source. A quiet result: stage 10 runs in this very tick.
    const trainHeld = this.trainGate();
    if (trainHeld) {
      this.trainAskFrontBind(rows);
      rows = rows.filter(row => !this.trainGate(row));
      attempts = attempts.filter(a => !this.trainGate(a.subject));
      if (attempts.length === 0 && rows.length === 0) { await this.persistQueue(); return trainHeld; }
    }
    // Defect a8910e41: the head this duty's binding run bound waits while the duty lasts (its front batch (H, S) is stage 10's to open;
    // in train on its ordinary stage 8 could never get the merge slot anyway). Its row stays, so it runs again once the duty is over.
    if (this.frontBound.size > 0 && this.trainEligible()) {
      for (const c of rows.filter(c => this.trainFrontBound(c))) this.queue.defer(c.pr, TRAIN_FRONT_BOUND_DEFERRED, now);
      rows = rows.filter(c => !this.trainFrontBound(c));
      attempts = attempts.filter(a => !this.trainFrontBound(a.subject));
      if (attempts.length === 0 && rows.length === 0) { await this.persistQueue(); this.reportQueue(); return { state: 'DEFERRED', reason: TRAIN_FRONT_BOUND_DEFERRED }; }
    }
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
      const inside = counts.inside >= this.policy.park.maxParked;
      this.queue.notice(boundedNotice({ code: inside ? 'PARKING_FULL' : 'PARKED_OVER_CAPACITY', used: inside ? counts.inside : counts.outside,
        limit: inside ? this.policy.park.maxParked : outsideMax, now }));
      await this.persistQueue();
      return { state: 'DEFERRED', reason: 'PARKING_FULL' };
    }
    const gate = breakerGate(b, now);
    if (!gate.allow) {
      await this.persistQueue();
      this.reportQueue();
      return { state: 'DEFERRED', reason: 'BREAKER_OPEN', until: gate.until };
    }
    // Generation 10 (DESIGN 53.5): the gate moved an open breaker whose trial time came to half-open: the board says so at once (before:
    // it kept "open, trial at <a time already past>" until the batch ended).
    if (gate.trial) { await this.persistQueue(); this.reportQueue(); await this.flushStatus(); }
    // One trial at a time: while a batch rests at parking point A, a half-open breaker starts none (review m11).
    if (gate.trial && (await this.parkedCounts(entries.filter(e => Ledger.waitingAt(e)))).inside > 0) {
      await this.persistQueue();
      return { state: 'DEFERRED', reason: 'BREAKER_TRIAL_PENDING' };
    }
    // The train on with nonFrontRuns false (policy /8; review R3 M6): only the front subject (S, from on-mode stage 10) is
    // scheduled; every other row waits, shown with TRAIN_NON_FRONT_RUNS_OFF, and so does an attempt 2 of a subject without S.
    // nonFrontRuns true (and off, shadow): every row, as today.
    // Task 7100ff62 (DESIGN §62.4): the take-over binding run (the queue head's PR, attempt 1, no S) is the front's own prelude, not a
    // non-front run: it runs here too, or the claim is never bound and the front waits for the full sweep again. No other row does.
    if (this.policy.train.enabled === 'on' && this.policy.train.nonFrontRuns === false) {
      const front = c => Object.hasOwn(c, 'testSha') || this.trainFrontBind(c);
      for (const c of rows.filter(c => !front(c))) this.queue.defer(c.pr, TRAIN_NON_FRONT_DEFERRED, now);
      rows = rows.filter(front);
      attempts = attempts.filter(a => front(a.subject));
      if (attempts.length === 0 && rows.length === 0) { await this.persistQueue(); this.reportQueue(); return { state: 'DEFERRED', reason: TRAIN_NON_FRONT_DEFERRED }; }
    }
    let list = [...attempts.map(a => ({ pr: a.subject.pr, attempt2: a })), ...rows.map(c => ({ pr: c.pr, row: c }))];
    // A trial never picks the rows that just failed, unless nothing else is there (it never locks for good).
    if (gate.trial) {
      const others = list.filter(x => !gate.exclude.includes(x.pr));
      if (others.length > 0) list = others;
    }
    this.tickUsage = await this.ledger.usage(now - DAY, { separateNetwork: this.networkPolicy() !== null, budgetTimes: true });
    const u = this.tickUsage;
    this.reportLimits(u, now);
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

  // Fresh exact-subject data from a clean protected Stage10 may wake a claim
  // wait. Native stage1 still admits it; all existing head/budget caps remain.
  async recheckClaims(now) {
    for (const { pr, headSha, baseSha } of this.queue.claimChecks()) {
      const live = this.currentClaimBinding({ pr, headSha, baseSha });
      if (!this.queue.claimChanged(pr, live, now)) continue;
      this.queue.notice({ key: `poke-claim:${pr}:${headSha}:${now}`, kind: 'new-trigger', pr, headSha, code: CLAIM_CHANGED });
      try { await this.receipt('queue-claim-changed', { pr, headSha }); } catch { /* the queue row and the notice show it */ }
    }
  }

  currentClaimBinding(subject) {
    const b = this.claimBindingObservations?.get(`${subject.pr}:${subject.headSha}:${subject.baseSha}`);
    const at = Date.parse(b?.observedAt ?? '');
    return b && at <= this.clock() && this.clock() - at <= 30_000 ? b : null;
  }

  // Pre-checks that need no secret and no network. Anything that fails here leaves the ledger untouched.
  //   usage: ledger.mjs#usage for the last 24 hours; origin: how the queue picked the subject (queue.mjs#ORIGINS).
  //   claimChanged: the queue observed changed Native claim/authorization conditions after a refusal: no cool-down.
  // A deferral with perRow waits for this row only; any other one ends the scheduling pass.
  async precheck(key, hk, subject, { attempt1Key = null, usage, origin = 'queued', claimChanged = false, flow = null } = {}) {
    const now = this.clock();
    const l = this.policy.limits;
    if (await this.ledger.headBurned(hk) && !(flow && await this.ledger.flowOwnsHead(hk, flow))) return { ignore: 'HEAD_ALREADY_EXECUTED_NO_RETRY' };
    // A head that may have published a check under ANY Source or attempt (executed-heads.mjs) never runs again: a new
    // Source would otherwise run it as new and stop at ROLE_ALREADY_PUBLISHED_ON_HEAD (2026-10-22, Note 1550fef8). The
    // one exception: attempt 2 of the same head, when the only record is attempt 1's own "before stage R" one (stage R
    // relayed nothing, or attempt 2 would never have been scheduled). attempt 1's own ledger must say so too.
    if (await this.executedHeads.published(subject)
      && !(flow && await this.executedHeads.onlyRecordsOf(subject, [flow.key, ...(flow.reserved.flowKeys ?? [])]))
      && !(attempt1Key && await this.executedHeads.onlyRelayRecordOf(subject, attempt1Key, RELAY_STAGE) && await this.relayedNothing(attempt1Key))) return { ignore: 'HEAD_ALREADY_PUBLISHED_NO_RETRY' };
    if ((await this.ledger.state(key)).state !== 'ABSENT') return { ignore: 'CONTENT_ALREADY_EXECUTED_NO_RETRY' };
    // DESIGN §34.5: while the two sides run different versions (consistent false, read now) nothing is reserved: a global
    // deferral, the PR pays nothing for the node's skew. Unknown (null) or no versions port: as before.
    if (await this.versionSkewNow()) return { defer: VERSION_SKEW };
    // The 10-minute cool-down of the batch key after a release it applies to (classify.mjs#UNEXECUTED_REASON_RULES). Not for a new
    // trigger whose PR now names another claim after a claim refusal (field defect 2026-11-08, PR #1039: the refusal was safeToRerun,
    // nothing ran, and the fix it asked for is in; the re-evaluation cap below still bounds how often).
    const recent = claimChanged && origin === 'new-trigger' ? []
      : (await this.ledger.unexecutedRecords(key, now - DAY)).filter(r => UNEXECUTED_REASON_RULES[r.reason]?.cooldown !== false);
    if (recent.length > 0 && now - Math.max(...recent.map(r => r.at)) < l.unexecutedCooldownMs) return { defer: 'UNEXECUTED_COOLDOWN', perRow: true, until: Math.max(...recent.map(r => r.at)) + l.unexecutedCooldownMs };
    // The daily budgets (policy /4), all from the ledger: executions, evaluations (not for a wait: it has its own
    // budget), the waits' budget, the new-trigger re-evaluations of this PR commit, the PR's own executions.
    const quota = async (code, result) => ({ ...result, notice: await this.quotaNotice(code, subject, usage) });
    if (usage.started >= l.maxBatchesPer24h) return quota('DAILY_BATCH_LIMIT', { defer: 'DAILY_BATCH_LIMIT' });
    if (origin !== 'waiting-retry' && usage.evaluations >= l.maxEvaluationsPer24h) return quota('DAILY_EVALUATION_LIMIT', { defer: 'DAILY_EVALUATION_LIMIT' });
    if (origin === 'waiting-retry' && usage.waitingRetries >= l.waitingRetriesPer24h) return quota('WAITING_BUDGET_EXHAUSTED', { defer: 'WAITING_BUDGET_EXHAUSTED', perRow: true });
    if (origin === 'new-trigger' && (usage.reevaluations.get(`${subject.pr}:${subject.headSha}`) ?? 0) >= l.reevaluationsPerPrHeadPer24h) return quota('REEVALUATION_CAP', { defer: 'REEVALUATION_CAP', perRow: true, dropPoke: true });
    // Only terminal PR verdicts spend this cap; system endings still spend the independent global budgets above.
    if ((usage.startedByPr.get(subject.pr) ?? 0) >= l.perPrBatchesPer24h) return quota('PR_DAILY_BATCH_LIMIT', { defer: 'PR_DAILY_BATCH_LIMIT', perRow: true });
    // These stops retain their existing release-cap semantics; the notice grants no retry.
    if (['queued', 'backoff-retry', 'restored'].includes(origin) && (usage.releasesByHead.get(subject.headSha) ?? 0) >= l.releasesPerHeadPer24h) return quota('RELEASE_CAP_REACHED', { stop: 'RELEASE_CAP_REACHED' });
    const net = this.networkPolicy();
    if (net && ['queued', 'backoff-retry', 'restored'].includes(origin) && (usage.networkReleasesByHead?.get(subject.headSha) ?? 0) >= net.releasesPerHeadPer24h) return quota('NETWORK_RELEASE_CAP_REACHED', { stop: 'NETWORK_RELEASE_CAP_REACHED', stopClass: 'environment' });
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

  async quotaNotice(code, subject, usage) {
    return budgetNotice({ code, subject, usage, policy: this.policy, ledger: this.ledger, now: this.clock() });
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
    // A train front commit carries S (queue.mjs#offerFront, only from on-mode stage 10): its subject names it (step 3c-2b).
    const subject = { repo: this.policy.repo, pr: c.pr, headSha: c.headSha, baseSha: c.baseSha, sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1,
      ...(Object.hasOwn(c, 'testSha') ? { testSha: c.testSha } : {}) };
    const flow = (await this.ledger.pendingFlowEnds()).find(s => {
      const old = s.reserved.subject;
      return old.repo === subject.repo && old.pr === subject.pr && old.headSha === subject.headSha && old.baseSha === subject.baseSha
        && old.testSha === subject.testSha;
    }) ?? null;
    if (flow) subject.attempt = flow.reserved.subject.attempt;
    const resumeStage8 = !!flow?.parked && flow.parked.batch.ciSourceManifestSha256 === this.policy.ciSourceManifestSha256;
    if (flow?.terminal?.facts?.basis === 'park-over-capacity') {
      if (!resumeStage8 || flow.reserved.subject.sourceManifestSha256 !== subject.sourceManifestSha256) {
        await this.ledger.retireFlow(flow, 'source-changed');
        return this.deferral({ defer: 'PARKED_OVER_CAPACITY', perRow: true }, flow.key, c.pr);
      }
      const released = usage.releasesByHead.get(subject.headSha) ?? 0;
      if (released >= this.policy.limits.releasesPerHeadPer24h)
        return this.deferral({ defer: 'PARKED_OVER_CAPACITY', perRow: true, until: Date.parse(flow.terminal.at) + DAY }, flow.key, c.pr);
      const backoff = RELEASE_BACKOFF_MS[Math.min(Math.max(0, released - 1), RELEASE_BACKOFF_MS.length - 1)];
      const due = Date.parse(flow.terminal.at) + backoff;
      if (this.clock() < due) return this.deferral({ defer: 'PARKED_OVER_CAPACITY', perRow: true, until: due }, flow.key, c.pr);
    }
    if (Object.hasOwn(c, 'testSha') && [1, 2].includes(c.frontAttempt)) this.frontKeys.set(batchKey(subject), c.frontAttempt);
    const key = batchKey(subject);
    const hk = headKey(subject);
    const pre = await this.precheck(key, hk, subject, { usage, origin: c.origin, claimChanged: c.claimChanged === true, flow });
    if (pre.ignore) {
      if (flow) await this.ledger.retireFlow(flow, pre.ignore);
      this.queue.settle(c.pr, c.headSha, { kind: 'ignored', code: pre.ignore, klass: null }, this.clock());
      await this.receipt('trigger-ignored', { key, failureCode: pre.ignore, origin: c.origin });
      this.reportOutcome(subject, 'IGNORED', { code: pre.ignore, key });
      return { state: 'IGNORED', key, reason: pre.ignore, next: true };
    }
    if (pre.halt) { await this.haltWith(pre.halt, { key }); return { state: 'HALTED', key, failureCode: pre.halt }; }
    if (pre.defer) return this.deferral(pre, key, c.pr);
    if (pre.stop) {
      if (pre.notice) this.queue.notice(pre.notice);
      if (this.queue.stopAtCap(c.pr, c.headSha, pre.stop, this.clock(), pre.stopClass ?? null)) this.queue.notice({ key: `stopped:${c.pr}:${c.headSha}:${pre.stop}`, kind: 'stopped', pr: c.pr, headSha: c.headSha, code: pre.stop });
      return { state: 'DEFERRED', key, reason: pre.stop, next: true };
    }
    if (resumeStage8) {
      const usage = await this.ledger.usage(this.clock() - DAY, { stage8Pr: subject.pr, budgetTimes: true });
      if (usage.stage8Retries >= this.policy.park.stage8RetriesPer24h) return this.deferral({ defer: 'STAGE8_RETRY_BUDGET_EXHAUSTED', perRow: true,
        notice: await this.quotaNotice('STAGE8_RETRY_BUDGET_EXHAUSTED', subject, usage) }, key, c.pr);
    }
    // A merged or closed PR leaves the queue before it is reserved (one live read), not only after a batch of it failed
    // (falsified): on 2026-11-03 merged PR 984 stayed first in the queue and breaker trials ran merged heads again
    // (rule 41ab823a). No answer is never a fact: the row runs as before.
    const live = await this.livePull(c.pr);
    if (live && live.state !== 'open') {
      if (flow) await this.ledger.retireFlow(flow, 'pr-closed');
      if (this.queue.closePr(c.pr, this.clock())) await this.receipt('queue-pr-closed', { pr: c.pr, state: live.state, before: 'reserve' });
      this.reportOutcome(subject, 'IGNORED', { code: 'PR_CLOSED', key });
      return { state: 'IGNORED', key, reason: 'PR_CLOSED', next: true };
    }
    if (flow && (!live || live.headSha !== subject.headSha)) {
      if (live) await this.ledger.retireFlow(flow, 'head-moved');
      return this.deferral({ defer: 'FLOW_HEAD_UNCONFIRMED', perRow: true }, key, c.pr);
    }

    // DESIGN §62.4: a take-over binding run is recorded before it is reserved (a restart ends it after stage 1 too).
    if (this.trainFrontBind(subject)) {
      await this.receipt('train-front-bind', { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, claimId: this.trainLast.frontBind.claimId });
      this.frontBindKeys.set(key, { pr: subject.pr, headSha: subject.headSha });
    } else this.frontBindKeys.delete(key); // an earlier binding run of this key that was released: this run is an ordinary one
    await this.ledger.reserve(key, subject, { origin: c.origin, flow, resumeStage8 });
    await this.receipt('batch-reserved', { key, headKey: hk, subject, origin: c.origin });
    // Keep only a protected Native observation for any later claim wait.
    this.queue.begin(c.pr, c.headSha, key, c.origin, this.clock(), { binding: this.currentClaimBinding(c) });
    await this.persistQueue();
    if (resumeStage8) {
      // Re-derive only the control package for this installed Source. Already published role checks stay consumed;
      // stage 8 revalidates the live authority, H/S, required checks and train proof itself. No scanner is re-entered.
      try {
        const front = Object.hasOwn(subject, 'testSha') ? this.frontBindings.get(`${subject.pr}:${subject.testSha}`) : null;
        const chain = front?.members ? chainOfFront(subject, front) : null;
        const batch = chain ? await this.engine.derive(subject, key, chain) : await this.engine.derive(subject, key);
        await this.ledger.markStarted(key, { batchId: batch.batchId });
        await this.ledger.beginWait(key, { t0: this.clock(), batch });
        const at = new Date(this.clock()).toISOString();
        await this.ledger.writePlanIntent(key, { ...flow.planIntent, key, at });
        await this.ledger.writePlan(key, { ...flow.plan, key, at });
        await this.ledger.park(key, { ...flow.parked, key, batch, at });
        await this.receipt('batch-readmitted', { key, from: flow.flowFrom, safePoint: 'parked' });
        return this.resumeParkedB({ key, ...(await this.ledger.state(key)) });
      } catch (error) {
        return this.afterBatch(subject, c.origin, await this.unknown(key, codeOf(error), 'flow-readmission-unconfirmed', null));
      }
    }
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
  // for good, kept when they only defer it, and when one live read shows the PR closed or its head moved on (DESIGN §72).
  async runAttempt2({ key1, key2, subject }, usage) {
    // Bound to the installed Source (PR-A review MAJOR 2): an intent from before a reinstall is closed, never run.
    if (subject.sourceManifestSha256 !== this.policy.sourceManifestSha256) {
      await this.ledger.closeAttempt2(key1, { failureCode: 'ATTEMPT2_SOURCE_CHANGED' });
      await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: 'ATTEMPT2_SOURCE_CHANGED' });
      return { state: 'IGNORED', key: key2, reason: 'ATTEMPT2_SOURCE_CHANGED', next: true };
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
    // The rule of DESIGN §72 before attempt 2 exists (rule 41ab823a, v0.6 §3): one live read after the precheck, as in runRow. A closed PR,
    // or one whose head is no longer attempt 1's, never runs attempt 2; a newer commit in the queue that the read disproves goes back to
    // superseded. No answer is never a fact: attempt 2 runs and stage 1 decides.
    const live = await this.livePull(subject.pr);
    if (live && live.state !== 'open') {
      await this.ledger.closeAttempt2(key1, { failureCode: 'ATTEMPT2_PR_CLOSED', liveState: live.state });
      if (this.queue.closePr(subject.pr, this.clock())) await this.receipt('queue-pr-closed', { pr: subject.pr, state: live.state, before: 'attempt2' });
      await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: 'ATTEMPT2_PR_CLOSED' });
      return { state: 'IGNORED', key: key2, reason: 'ATTEMPT2_PR_CLOSED', next: true };
    }
    if (live && live.headSha !== subject.headSha) {
      await this.ledger.closeAttempt2(key1, { failureCode: 'ATTEMPT2_SUPERSEDED', liveHeadSha: live.headSha, liveState: live.state });
      await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: 'ATTEMPT2_SUPERSEDED' });
      return { state: 'IGNORED', key: key2, reason: 'ATTEMPT2_SUPERSEDED', next: true };
    }
    if (live && this.newerCommitQueued(subject) && this.queue.keepCurrent(subject.pr, subject.headSha, subject.baseSha, this.clock())) {
      await this.persistQueue();
      await this.receipt('supersede-disproved', { key: key2, pr: subject.pr, safePoint: 'before-attempt-2' });
    }
    // Consumed create-only before the reservation: whatever attempt 2 ends with, it never runs again.
    await this.ledger.consumeAttempt2(key1, { key2 });
    await this.ledger.reserve(key2, subject, { origin: 'attempt2' });
    await this.receipt('batch-reserved', { key: key2, headKey: hk, subject, attempt1: key1, origin: 'attempt2' });
    // The row of attempt 1's head shows attempt 2 running (when that head is still the PR's current one in the queue).
    const row = this.queue.row(subject.pr);
    if (row?.current?.headSha === subject.headSha && !row.running) { this.queue.begin(subject.pr, subject.headSha, key2, 'attempt2', this.clock(), { binding: this.currentClaimBinding(subject) }); await this.persistQueue(); }
    return this.driveReserved(key2, subject, this.clock(), 'attempt2');
  }

  async driveReserved(key, subject, t0, origin = 'queued') {
    let batch = null;
    let outcome;
    // A new batch learns its lease from its own stage 1 (DESIGN §56.3): an end kept from an earlier attempt of this head (a refused stage 1
    // that released the batch) may be long stale, and is forgotten before the batch shows as running (review round 19, MINOR 1).
    this.claimLeases?.delete(`${subject.pr}:${subject.headSha}`);
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: new Date(this.clock()).toISOString() };
    this.atStage(0, 'derive');
    // Generation 10 (DESIGN 53.5): the claimed batch, its queue row RUNNING and the executor RUNNING are on the board now, not after the
    // batch (the companion posts the PR page from it; companion-main.mjs posts again as soon as it sees the change).
    this.report(s => s.setState('RUNNING', null));
    this.reportQueue();
    await this.flushStatus();
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
      pr: subject.pr, code: s.code ?? null, network: s.network === true }, this.policy, now);
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
    if (['CI_BUDGET_EXHAUSTED', 'TASK_CI_HEAD_CAP_REACHED', 'CLAIM_HEAD_CAP_REACHED'].includes(s?.code)) {
      const retryAt = Date.parse(s.ciRetryAfter ?? '');
      this.queue.notice(boundedNotice({ code: s.code, subject, used: null, limit: null, now,
        resetsAt: Number.isFinite(retryAt) ? retryAt : null, recovery: null }));
    }
    try {
      const environment = ['environment', 'transient'].includes(s?.klass);
      const b = breakerOf(this.queue.breaker);
      this.queue.breaker = b;
      // Generation 10 (DESIGN 53.3): under a policy with breaker.network a release that was the line counts towards the network cap
      // only (and backs off a flat 10 minutes), never towards the head's release cap.
      const network = s?.kind === 'released' && s.klass !== 'waiting' && s.network === true && this.networkPolicy() !== null;
      // This release counts towards the head's cap unless it is a wait, an admission refusal, a supersession, a network release (above), or an environment
      // fault while the breaker is not closed (ledger.mjs#usage counts the same way; the tick's usage is from before this batch).
      const counted = s?.kind === 'released' && s.klass !== 'waiting' && s.klass !== 'node-role' && !UNCAPPED_RELEASES.includes(s.reason) && !CLAIM_REASONS.includes(s.code) && !network && !(environment && s.breakerState !== 'closed');
      const releases24h = (this.tickUsage?.releasesByHead.get(subject.headSha) ?? 0) + (counted ? 1 : 0);
      // Preserve network backoff and breaker classification, but a stage-1 refusal spends no network release either.
      const networkReleases24h = (this.tickUsage?.networkReleasesByHead?.get(subject.headSha) ?? 0) + (network && !UNCAPPED_RELEASES.includes(s.reason) ? 1 : 0);
      const ciRetryAfter = typeof s?.ciRetryAfter === 'string' && Number.isFinite(Date.parse(s.ciRetryAfter)) ? Date.parse(s.ciRetryAfter) : null;
      const settled = this.queue.settle(subject.pr, subject.headSha, s ? { kind: s.kind, code: s.code ?? null, klass: s.klass ?? null, reason: s.reason ?? null, ciRetryAfter, outcomeReason: s.outcomeReason ?? null,
        reasonCodes: s.reasonCodes ?? null, releases24h, releaseCap: this.policy.limits.releasesPerHeadPer24h, network, networkReleases24h, networkCap: this.networkPolicy()?.releasesPerHeadPer24h ?? null }
        : { kind: 'burned', code: result.failureCode ?? null, klass: 'unknown' }, now);
      // ADR 0019 (review 2): the S of a batch whose member moved on is never tried again (stage 10 offers the next one).
      if (s?.dropFront === true && Object.hasOwn(subject, 'testSha')) this.queue.dropFronts(s.code ?? TRAIN_BATCH_MEMBER_MOVED, now);
      // Main is no longer this base: the other rows waiting on it stop too, without a bundle each (queue.mjs#stopBase).
      if (s?.code === RESIDENT_BASE_MOVED && s.kind === 'ignored') this.queue.stopBase(subject.baseSha, RESIDENT_BASE_MOVED, now);
      if (settled === 'stopped') {
        const capCode = network && networkReleases24h >= this.networkPolicy()?.releasesPerHeadPer24h ? 'NETWORK_RELEASE_CAP_REACHED'
          : counted && releases24h >= this.policy.limits.releasesPerHeadPer24h ? 'RELEASE_CAP_REACHED' : null;
        if (['RELEASE_CAP_REACHED', 'NETWORK_RELEASE_CAP_REACHED'].includes(capCode)) {
          const usage = await this.ledger.usage(now - DAY, { separateNetwork: this.networkPolicy() !== null, budgetTimes: true });
          this.queue.notice(await this.quotaNotice(capCode, subject, usage));
        }
        this.queue.notice({ key: `stopped:${subject.pr}:${subject.headSha}:${s.code}`, kind: 'stopped', pr: subject.pr, headSha: subject.headSha, code: s.code ?? null });
        await this.receipt('queue-row-stopped', { pr: subject.pr, headSha: subject.headSha, failureCode: s.code ?? null, releases24h, ...(network ? { networkReleases24h } : {}) });
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
  // Generation 12 (review rounds 13-15): the queue's rows are written again at every stage, so the running batch's lease notice is
  // evaluated after stage 1 recorded its lease (DESIGN §56.3); the batch in flight keeps its lease even when its PR's row shows another
  // commit (inFlight). Every phase but 'relay-wait' is batch work during which no watch can run (a new batch, one going on from A, a
  // stage-8 try, an attempt 2): the watch view lapses at once (DESIGN §56.2). 'relay-wait' is a batch still resting at A, evaluated on
  // quiet ticks where watches go on, so it leaves the view alone; the batch's next phase (rebundle, workspace, a stage) ends it.
  // A batch that goes on from A leaves the A set at once (review round 17, MINOR 3): its row is RUNNING again, and its lease is judged
  // from now (leaseFrom), the same on the PR page and in the Owner notice, as a batch with its whole run ahead.
  atStage(stage, phase) {
    if (!this.current) return;
    this.current.phase = phase;
    if (phase !== 'relay-wait') {
      this.queueWatchViewAt = null;
      // Batch work (a new batch, one going on from A, a stage-8 try, attempt 2): the queue rows wait for it now, not for a global
      // deferral an earlier pass met; the next pass judges that again (review round 26, MINOR 1).
      this.scheduleHold = null;
      const key = `${this.current.pr}:${this.current.headSha}`;
      if (this.parkedA?.has(key)) { this.parkedA.delete(key); this.current.leaseFrom = new Date(this.clock()).toISOString(); }
    }
    this.report(s => s.setCurrent({ ...this.current, stage, phase, claimExpiresAt: this.leaseOf(this.current) }));
    this.reportQueue({ inFlight: true });
  }

  // ---- the claim's lease (generation 12, DESIGN §56.3) ----
  // The newest lease end Native reported for a batch's claim (stage 1 and each stage-8 try carry it), by PR and head. A view only:
  // the status page and the PR page remind the holder to renew; nothing the executor decides reads it.
  // An outcome whose scheduling facts came from Native (an object) but name no lease end (claimExpiresAt null: Native named none, or
  // the CI's extension answered none, claim-assist-native.mjs#leaseAfter) forgets the stored end rather than show a stale one; an
  // outcome without scheduling facts (Native not reached) changes nothing.
  noteLease(subject, r) {
    const s = r?.outcome?.scheduling;
    if (!subject || !Number.isSafeInteger(subject.pr) || !s || typeof s !== 'object') return;
    const at = Date.parse(s.claimExpiresAt ?? '');
    this.claimLeases ??= new Map();
    if (Number.isFinite(at)) this.claimLeases.set(`${subject.pr}:${subject.headSha}`, { expiresAt: at });
    else this.claimLeases.delete(`${subject.pr}:${subject.headSha}`);
  }
  leaseOf(subject) {
    const l = subject ? this.claimLeases?.get(`${subject.pr}:${subject.headSha}`) : null;
    return l ? new Date(l.expiresAt).toISOString() : null;
  }
  // A lease that ends before the batch can finish is the Owner's to hear about once per lease end (the holder sees the PR page).
  leaseNotices(rows, now) {
    for (const r of rows) {
      const l = this.claimLeases?.get(`${r.pr}:${r.headSha}`);
      const short = l ? leaseShort({ expiresAt: l.expiresAt, now, running: r.running === true, since: r.since }) : null;
      const key = short ? `lease-short:${r.pr}:${r.headSha.slice(0, 12)}:${l.expiresAt}:${short}` : null;
      if (key && !this.queue.notices.some(n => n.key === key)) this.queue.notice({ key, kind: 'lease-short', pr: r.pr, headSha: r.headSha, code: short === 'expired' ? 'CLAIM_LEASE_EXPIRED' : 'CLAIM_LEASE_SHORT', at: now, until: l.expiresAt });
    }
  }

  stage(number) { return this.policy.stages.find(s => s.number === number); }

  // Right before a stage that can publish a check: the head is recorded as "may have published" for every Source and
  // attempt (executed-heads.mjs). Create-only and idempotent; a record that cannot be written stops the batch before
  // that stage (a clean, final failure: nothing of the stage ran).
  async beforePublication(key, subject, number) {
    if (!PUBLICATION_STAGES.includes(number)) return null;
    const code = 'EXECUTED_HEAD_RECORD_UNCONFIRMED';
    for (let again = 0; ; again++) {
      try {
        await this.executedHeads.record(subject, { key, origin: 'publication', basis: `before-stage-${number}`, stage: number });
        return null;
      } catch {
        if (again >= EXECUTION_RETRY_MS.length || !(await this.waitForStageRetry(key, number, again, code, 'publication-not-invoked')))
          return new StepFailure(number, code, { windowsTreeZero: true }, 'stage');
      }
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
    // ADR 0019: a front batch of several PRs (its binding from stage 10 names the members) is described as /4; every other batch as /3.
    const front = Object.hasOwn(subject, 'testSha') ? this.frontBindings.get(`${subject.pr}:${subject.testSha}`) : null;
    const chain = front?.members ? chainOfFront(subject, front) : null;
    // Members that do not fit this subject (never expected: the binding is keyed by PR and S): said so, and the batch goes on as /3,
    // which both tools refuse for a chain S (fail closed, review suggestion 5), so the reason is on record before the bundle fails.
    if (front?.members && !chain) { try { await this.receipt('train-front-chain-unbound', { key, pr: subject.pr, headSha: subject.headSha, testSha: subject.testSha }); } catch { /* a view */ } }
    const batch = chain ? await this.engine.derive(subject, key, chain) : await this.engine.derive(subject, key);
    keepBatch(batch);
    await this.receipt('batch-derived', { key, batchId: batch.batchId, packageSha256: batch.packageSha256 });

    // The bundle comes first: it needs only the Owner's own read credential, has no Windows or Linux
    // effect and publishes nothing, so its failure can release the reservation.
    this.atStage(0, 'bundle');
    const bundle = await this.companion.buildBundle(batch);
    // ADR 0019 (review 2): a member of a batch of several PRs moved on (companion.mjs#BUNDLE_MEMBER_MOVED_REASONS): its own code.
    // Field defect 2026-11-14: main is no longer this subject's base (the bundle checked GitHub's refs): its own code, never the breaker.
    const bundleCode = bundle?.code === TRAIN_BATCH_MEMBER_MOVED && Object.hasOwn(subject, 'testSha') ? TRAIN_BATCH_MEMBER_MOVED
      : bundle?.code === RESIDENT_BASE_MOVED ? RESIDENT_BASE_MOVED : 'BUNDLE_UNAVAILABLE';
    if (!bundle || bundle.ok !== true) return Object.assign(new StepFailure(0, bundleCode, {}, 'bundle'), { companionJobTree: bundle?.jobTree ?? null,
      // Generation 10 (DESIGN 53.3): the companion's own word that a GitHub step failed in git (companion.mjs#bundleNetworkRefusal).
      bundleNetwork: bundle?.code === BUNDLE_NETWORK_UNAVAILABLE });
    const early = await this.abortIfRequested(key, batch, 'before-stage-1');
    if (early) return early;
    // Phase 2: a newer commit of the PR arrived while the bundle was built. Nothing of this batch ran: released, not
    // burned (design v0.5 §4.2; v0.6 §3: before stage 1 the arrival order alone may decide).
    const superseded = await this.supersededBeforeStart(key, subject, batch);
    if (superseded) return superseded;

    this.atStage(1, 'stage');
    const { result: first, aborted } = await this.runWindowsStageWithRetry(key, batch, 1);
    if (aborted) return aborted;
    await this.receipt('stage-terminal', { key, stage: 1, ok: first.ok === true, failureCode: first.ok ? null : validCode(first.code), factsSha256: first.factsSha256 ?? null, outcome: outcomeSummary(first) });
    this.noteLease(subject, first);
    if (first.ok !== true) {
      if (first.code === 'HEAD_PUBLISHED_ON_GITHUB') {
        const unrecorded = await this.recordPublishedOnGithub(key, subject);
        if (unrecorded) return unrecorded;
      }
      return new StepFailure(1, first.code, first.proof, 'stage', 0, first);
    }
    // Rule 41ab823a (DESIGN §75): stage 1 of a front batch names the scans H already carries on GitHub (head-scans.mjs#stageHeadScans); a
    // stage 1 that named none leaves no older fact of this key behind.
    if (Object.hasOwn(subject, 'testSha')) {
      const scans = stageHeadScans(first.outcome?.headScans);
      if (scans) {
        this.frontHeadScans.set(key, scans);
        while (this.frontHeadScans.size > FRONT_HEAD_SCANS_KEPT) this.frontHeadScans.delete(this.frontHeadScans.keys().next().value);
      } else this.frontHeadScans.delete(key);
    }
    // Defect a8910e41 (DESIGN §62.4): the take-over binding run ends right here, before markStarted would burn the head: only stage 1
    // ran (it may run again on this head, as every stage-1 release), and fail() releases the reservation (TRAIN_FRONT_BOUND). A binding
    // run that an older version left STARTED still ends in continueBatch, burned as before.
    if (this.frontBindKeys.has(key)) return this.frontBindEnd(key);
    this.trainAskAfterBind(subject);
    // DESIGN §62.6: in steady state the queue head's ordinary batch gives way right here (its stages 2-7 would only be thrown away when
    // stage 10 opens the front batch (H, S)); it ends the binding run's way: released, not burned, frontBound holds the head.
    if (this.trainFrontYield(subject, first)) {
      try { await this.receipt('train-front-yield', { key, pr: subject.pr, headSha: subject.headSha, mergeQueue: first.outcome.scheduling.mergeQueue }); } catch { /* a view */ }
      return this.frontBindEnd(key);
    }

    // Admitted and published: from here on this head is burned.
    await this.ledger.markStarted(key, { batchId: batch.batchId });
    await this.receipt('batch-started', { key });
    // Stage 1's admission just read the PR open at this head: the batch's first live read of the rule (DESIGN §72).
    this.liveReadDue(key);
    // The wait's anchor (t0) and the derived batch, durable before the first wait evaluation: a later tick,
    // or a restarted service, continues from here without deriving or running stage 1 again.
    await this.ledger.beginWait(key, { t0, batch, claimExpiresAt: this.leaseOf(subject) });
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

  // Everything after 15-relay-wait: 20-plan-intent, 25-plan, the local roles, stage 8 and the close.
  //   resumed: this call resumes a batch that rested at parking point A in an earlier tick (resumeWaiting), never the
  //   batch's own first pass (DESIGN §37: only a batch that waited is re-bundled; independent review M1).
  async continueBatch(key, subject, batch, t0, { resumed = false } = {}) {
    let aborted = await this.abortIfRequested(key, batch, 'before-relay-plan');
    if (aborted) return aborted;
    if (this.frontBindKeys.has(key)) return this.frontBindEnd(key);
    if ((aborted = await this.endIfNotStanding(key, subject, batch, 'before-relay-plan', POSITIONS[1]))) return aborted;
    const plan = await this.localPlan(key, subject, t0);
    const relayed = 0;

    // Only LOCAL_REQUIRED roles run locally, in the fixed role order; the protocol records of the previous
    // local Linux role are archived before the next one (between-roles-4 / -6 only where needed).
    const localRoles = HEAVY_ROLES.filter(r => plan.local.some(l => l.role === r));
    if (localRoles.length > 0) {
      if ((aborted = await this.abortIfRequested(key, batch, 'before-workspace'))) return aborted;
      if ((aborted = await this.endIfNotStanding(key, subject, batch, 'before-workspace', POSITIONS[1]))) return aborted;
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
        let rb = await this.companion.rebuildBundle(batch);
        // Generation 13 (DESIGN §57.3): a network step that failed is built again after REBUNDLE_NETWORK_RETRY_MS, each wait and rebuild
        // allowed like an execution retry (review round 1, MINOR 3): no HALT, no Source drift, and the installed authority still covering
        // the wait (before it), the rebuild and the workspaces after it at their bounds and every stage of the batch from the first local
        // one at its cap.
        const firstLocal = ROLE_STAGES[localRoles[0]][0], rebuildMs = REBUILD_BUNDLE_REQUEST_MS + PREPARE_WORKSPACES_REQUEST_MS;
        for (let again = 0; again < REBUNDLE_NETWORK_RETRY_MS.length && rb?.ok !== true && rb?.code === BUNDLE_NETWORK_UNAVAILABLE; again++) {
          const wait = REBUNDLE_NETWORK_RETRY_MS[again];
          if (!this.executionRetryFitsAuthority(firstLocal, 0, { afterWait: true, extraMs: wait + rebuildMs })) {
            await this.receipt('rebundle-retry-refused', { key, try: again + 1, step: 'before-wait-authority' });
            break;
          }
          await this.receipt('rebundle-retry', { key, try: again + 1, afterMs: wait, failureCode: BUNDLE_NETWORK_UNAVAILABLE, companionJobTree: rb?.jobTree ?? null });
          this.atStage(0, 'retry-wait');
          await this.retryWait(key, wait);
          if ((aborted = await this.abortIfRequested(key, batch, 'before-workspace'))) return aborted;
          const still = await this.gateWaitStillAllowed(key, firstLocal, rebuildMs);
          if (still !== true) {
            await this.receipt('rebundle-retry-refused', { key, try: again + 1, step: `after-wait-${still}` });
            break;
          }
          this.atStage(0, 'rebundle');
          rb = await this.companion.rebuildBundle(batch);
        }
        const code = rb?.ok === true ? null : (rb?.code === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' ? 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' : 'PARKED_BUNDLE_TOO_OLD');
        // The line to GitHub, and nothing else, as for the first bundle (DESIGN 53.3; review round 1, MINOR 6): the ending keeps it.
        const bundleNetwork = code === 'PARKED_BUNDLE_TOO_OLD' && rb?.code === BUNDLE_NETWORK_UNAVAILABLE;
        await this.receipt('batch-rebundled', { key, failureCode: code, ageMinutes: Math.floor((this.clock() - reservedAt) / 60_000), companionJobTree: rb?.jobTree ?? null,
          ...(bundleNetwork ? { network: true } : {}) });
        if (code) return Object.assign(new StepFailure(0, code, {}, 'workspace', relayed), { bundleNetwork });
      }
      this.atStage(0, 'workspace');
      let prep = await this.companion.prepareWorkspaces(batch);
      for (let again = 0; again < EXECUTION_RETRY_MS.length && prep?.ok !== true && prep?.code === 'WORKSPACE_PREPARATION_REFUSED'; again++) {
        if (prep.proof?.linuxUnitsInactive !== true || prep.proof?.containersZero !== true
          || !(await this.prepareExecutionRetry(key, batch, 0, prep, again, 'workspace-refused'))) break;
        await this.retryWait(key, EXECUTION_RETRY_MS[again]);
        if ((aborted = await this.abortIfRequested(key, batch, 'before-workspace'))) return aborted;
        if (!(await this.executionRetryStillAllowed(key, 0, again))) break;
        prep = await this.companion.prepareWorkspaces(batch);
      }
      if (!prep || prep.ok !== true) return new StepFailure(0, prep?.code ?? 'WORKSPACE_PREPARATION_UNCONFIRMED', {}, 'workspace', relayed);
    }
    for (const [index, role] of localRoles.entries()) {
      for (const number of ROLE_STAGES[role]) {
        if ((aborted = await this.abortIfRequested(key, batch, `before-stage-${number}`))) return aborted;
        const unrecorded = await this.beforePublication(key, subject, number);
        if (unrecorded) { unrecorded.relayedRoles = relayed; return unrecorded; }
        this.atStage(number, 'stage');
        const execution = number === ROLE_STAGES[role][0];
        // stillAllowed: after each wait of the refs gate (DESIGN 55), no HALT, no drift, the authority still covers this stage and the rest.
        let run = await this.runStageWatched(key, batch, number, { betweenRoles: execution && index > 0, firstLinux: execution && index === 0,
          ...(execution && index === 0 ? { stillAllowed: () => this.gateWaitStillAllowed(key, number) } : {}) });
        let { result: r, abort, stopCode, unconfirmed } = run;
        await this.receipt('stage-terminal', { key, stage: number, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), factsSha256: r.factsSha256 ?? null, outcome: outcomeSummary(r),
          ...(r.bridge ? { bridge: bridgeFacts(r.bridge) } : {}), ...(r.memoryGate ? { memoryGate: memoryGateFacts(r.memoryGate) } : {}), ...refsGateFacts(r) });
        // DESIGN 51 (C): a publisher stage (3, 5, 7) that ended before it wrote anything, because a source it reads was passingly unavailable and
        // its entry says so (outcome.safeToRerun), is run again with the same signed result (still in the spool), after a bounded back-off.
        // Nothing is parked and nothing re-scanned; the Source starts from a clean journal (nothing was recorded) and re-proves everything.
        // Generation 28 (docs/adr/0015): the same for a stage whose check was withdrawn for unavailability only (outcome.republishSafe): the
        // withdrawal is on record, and the Source's next run publishes a republication under a new identity, re-proving everything first.
        for (let again = 0; again < PUBLICATION_RETRY_MS.length && publicationRetryable(number, r) && !abort && !unconfirmed; again++) {
          await this.receipt('publication-retry', { key, stage: number, try: again + 1, afterMs: PUBLICATION_RETRY_MS[again], failureCode: validCode(r.code), reason: r.outcome?.reason ?? null });
          await this.retryWait(key, PUBLICATION_RETRY_MS[again]);
          if ((aborted = await this.abortIfRequested(key, batch, `before-stage-${number}`))) return aborted;
          this.atStage(number, 'stage');
          run = await this.runStageWatched(key, batch, number, { betweenRoles: false, firstLinux: false });
          ({ result: r, abort, stopCode, unconfirmed } = run);
          await this.receipt('stage-terminal', { key, stage: number, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), factsSha256: r.factsSha256 ?? null, outcome: outcomeSummary(r),
            ...(r.bridge ? { bridge: bridgeFacts(r.bridge) } : {}), retry: again + 1 });
        }
        // Generation 11 (DESIGN 54): an execution stage (4, 6; stage 2 abandoned only, DESIGN 59) that ended with an environment fault proven to have published nothing
        // runs again in this batch, after a two-host quiescence proof and a retry-stage-N archive; its publication stage runs once,
        // afterwards. Anything not proven ends as before (the failure path below).
        for (let again = 0; again < EXECUTION_RETRY_MS.length && r.ok !== true && !abort && !unconfirmed; again++) {
          const noLaunch = noLaunchRetryable(number, r) && (!execution || r.bridge?.pumpQuiet !== false);
          const missingResult = !execution && r.code === 'STAGE_INPUT_RESULT_MISSING' && r.outcome == null
            && r.proof?.windowsTreeZero === true && r.proof?.serviceOriginalStopped === true;
          const retryStage = missingResult ? number - 1 : number;
          const verdict = executionRetryable({ stage: number, code: validCode(r.code), outcome: r.outcome ?? null,
            bridge: r.bridge ? bridgeFacts(r.bridge) : null, proof: r.proof, retry: again });
          if (!noLaunch && !missingResult && !verdict.retry) break;
          if (noLaunch && !execution) {
            if (!(await this.waitForStageRetry(key, number, again, validCode(r.code), 'preflight-no-child'))) break;
          } else {
            const basis = noLaunch ? 'preflight-no-child' : missingResult ? 'missing-signed-result' : verdict.basis;
            if (!(await this.prepareExecutionRetry(key, batch, retryStage, r, again, basis))) break;
            this.atStage(retryStage, 'retry-wait');
            await this.retryWait(key, EXECUTION_RETRY_MS[again]);
            if (!(await this.executionRetryStillAllowed(key, retryStage, again))) break;
          }
          const abandoned = r;
          if ((aborted = await this.abortIfRequested(key, batch, `before-stage-${retryStage}`))) return aborted;
          this.atStage(retryStage, 'stage');
          // A run again of the batch's first Linux stage passes the refs gate and the version check again (firstLinux); it never
          // archives between roles (the retry-stage archive took the run's records).
          const firstLinux = EXECUTION_RETRY_STAGES.includes(retryStage) && index === 0;
          run = await this.runStageWatched(key, batch, retryStage, { betweenRoles: false, firstLinux,
            ...(EXECUTION_RETRY_STAGES.includes(retryStage) ? { again: again + 1 } : {}),
            ...(firstLinux ? { stillAllowed: () => this.gateWaitStillAllowed(key, retryStage) } : {}) });
          ({ result: r, abort, stopCode, unconfirmed } = run);
          if (missingResult) {
            await this.receipt('stage-terminal', { key, stage: retryStage, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), outcome: outcomeSummary(r), executionRetry: again + 1 });
            if (unconfirmed) return this.unknown(key, 'OWNER_ABORT_UNCONFIRMED', 'owner-abort-unconfirmed', batch, { safePoint: `in-stage-${retryStage}`, stage: retryStage });
            if (abort) return this.concludeAbort(key, batch, { safePoint: `in-stage-${retryStage}`, stage: retryStage, result: r, request: abort, stopCode });
            if (r.ok !== true) return new StepFailure(retryStage, r.code, r.proof, 'stage', relayed, r);
            if ((aborted = await this.abortIfRequested(key, batch, `before-stage-${number}`))) return aborted;
            this.atStage(number, 'stage');
            ({ result: r, abort, stopCode, unconfirmed } = await this.runStageWatched(key, batch, number, { betweenRoles: false, firstLinux: false }));
          }
          await this.receipt('stage-terminal', { key, stage: number, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), factsSha256: r.factsSha256 ?? null, outcome: outcomeSummary(r),
            ...(r.bridge ? { bridge: bridgeFacts(r.bridge) } : {}), ...(r.memoryGate ? { memoryGate: memoryGateFacts(r.memoryGate) } : {}), ...refsGateFacts(r), executionRetry: again + 1 });
          // DESIGN 59.1: stage 2's own gates refused the run again before it ran: the batch ends on the abandoned run, as without it. The
          // receipt names the substitution (and a refs gate without an answer: the ending is counted as environment, as before generation 14).
          if (number === 2 && verdict.basis === 'abandoned-unpublished' && r.ok !== true && !abort && !unconfirmed && STAGE2_RETRY_KEEPS_ABANDONED.includes(validCode(r.code))) {
            try {
              await this.receipt('execution-retry-refused', { key, stage: number, try: again + 1, step: 'gate', failureCode: validCode(r.code), kept: 'abandoned',
                ...(r.refsNoAnswer === true ? { refsNoAnswer: true } : {}) });
            } catch { /* the batch still ends on the abandoned run */ }
            r = abandoned;
            break;
          }
        }
        if (unconfirmed) return this.unknown(key, 'OWNER_ABORT_UNCONFIRMED', 'owner-abort-unconfirmed', batch, { safePoint: `in-stage-${number}`, stage: number });
        if (abort) return this.concludeAbort(key, batch, { safePoint: `in-stage-${number}`, stage: number, result: r, request: abort, stopCode });
        if (r.ok !== true) return new StepFailure(number, r.code, r.proof, 'stage', relayed, r);
      }
    }
    if ((aborted = await this.abortIfRequested(key, batch, 'before-stage-8'))) return aborted;
    // Phase 2, step 2: the close archive on both hosts ends the Linux exclusive zone; then the batch rests at parking
    // point B and stage 8 runs as tries (the first one right away). Stage 8 touches only Windows.
    const closed = await this.engine.closeBatch(batch, { linux: localRoles.length > 0 });
    archiveCheck(closed && closed.verified === true, 'SUCCESS_PATH_ARCHIVE_UNCONFIRMED', closed);
    await this.ledger.park(key, { batch, closed: closed.archived ?? null, local: localRoles, claimExpiresAt: this.leaseOf(subject) });
    await this.receipt('batch-parked', { key, local: localRoles, relayed: plan.relayed.map(r => r.role) });
    // Everything up to stage 7 passed (Linux too when a role ran locally): the breaker learns it now. A view: a failure
    // here never changes the batch, which already rests at B (independent review of step 2, m12).
    try { await this.feedBreaker(subject, { pos: POSITIONS[7], breaker: 'neutral', linux: localRoles.length > 0, kind: 'parked', code: null }); } catch { /* a view */ }
    return this.stage8Try(key, subject, batch);
  }

  // Rule 41ab823a, DESIGN §75 (Fable 2026-11-19, field #1170): which scans of this front batch (a subject with S) need not run, because
  // H already carries them on GitHub. The evidence is what this batch's own stage 1 read there (frontHeadScans: App 5368905's newest
  // check of each scan name on H, completed and successful, a scanner publication whose summary says it tested H itself; Source
  // published-on-github-v2.mjs#headScansOf), the very checks the merge gate reads, never this node's ledger: an ordinary batch that
  // was archived (upgrade drain, park age or capacity), lost with a reinstall or run on another node still counts. Its Source is not a
  // condition (as executed-heads: a check published on H stays valid under any Source). A front of one member only, whose S has H's own
  // tree (stage 10's headTree) and whose T is in H (stage 10's own compare of exactly this (T, H): baseInHead), on this batch's H and T,
  // so S holds nothing H does not. Each such role is reused once: [{ role, from: the check's external id }] (the
  // external id carries a job id, a one-way digest: the batch key cannot be read from it), in role order. Anything that does not fit, or
  // no evidence (stage 1 named none, or a restart lost it): reuses nothing, the front batch scans as before.
  frontScansReused(key, subject) {
    const scans = stageHeadScans(this.frontHeadScans.get(key));
    this.frontHeadScans.delete(key);
    const front = this.frontBindings.get(`${subject.pr}:${subject.testSha}`);
    if (!scans || !front || front.members || front.headSha !== subject.headSha || front.baseSha !== subject.baseSha || !HEX40.test(front.testTree ?? '')
      || front.headTree !== front.testTree || front.baseInHead !== true) return [];
    return HEAVY_ROLES.flatMap(role => scans.filter(x => x.role === role).map(x => ({ role, from: x.externalId })));
  }

  // 20-plan-intent -> 25-plan: every heavy role is local (the hosted relay is removed, DESIGN §76). The records are written exactly as
  // relay.enabled = false wrote them (reason RELAY_DISABLED, no candidates, nothing relayed), so older readers keep their meaning.
  // Returns the plan { candidates: [], relayed: [], local: [{ role, reason, receipt, source }] }.
  async localPlan(key, subject, t0) {
    // A train front batch (a subject with S, §41.4, §38.8 m1): every role stays local with its own reason.
    const front = Object.hasOwn(subject, 'testSha');
    // Rule 41ab823a (DESIGN §75): a scan whose check H already carries on GitHub (read by this batch's stage 1) is not run again on the front.
    const reused = front ? this.frontScansReused(key, subject) : [];
    const roles = front ? HEAVY_ROLES.filter(r => !reused.some(x => x.role === r)) : [...HEAVY_ROLES];
    const reason = front ? RELAY_TRAIN_FRONT_LOCAL : 'RELAY_DISABLED';
    const reasons = Object.fromEntries(roles.map(r => [r, reason]));
    await this.ledger.writePlanIntent(key, { candidates: [], local: roles, reasons, reason, waitedMs: Math.max(0, this.clock() - t0), hintSha256: null, hintRefused: false, ...(reused.length ? { reused } : {}) });
    if (reused.length) await this.receipt('train-front-scans-reused', { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.testSha, reused });
    await this.receipt('relay-plan-intent', { key, candidates: [], reason, waitedMs: Math.max(0, this.clock() - t0), hintRefused: false });
    const plan = { candidates: [], relayed: [], local: roles.map(role => ({ role, reason, receipt: 'relay-local-fallback', source: 'resident' })), ...(reused.length ? { reused } : {}) };
    await this.ledger.writePlan(key, plan);
    return plan;
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
    return { class: row?.class ?? null, retry: row?.retry === 'same-batch' ? 'continuation' : row?.retry ?? null, breaker: row?.breaker ?? null, reason: o?.reason ?? null,
      reasonCodes: o?.diagnostic?.reasonCodes ?? null, nativeReasonCodes: o?.diagnostic?.nativeReasonCodes ?? null,
      ciRetryAfter: o?.scheduling?.ciRetryAfter ?? o?.diagnostic?.ciRetryAfter ?? null, safeToRerun: o?.safeToRerun === true, brokerNoLaunch: failure.brokerNoLaunch === true,
      // Generation 10 (DESIGN 53.3): the ending was the line and nothing else (classify.mjs#networkFailure).
      network: networkFailure({ code: failure.code, outcome: o, refsNoAnswer: failure.refsNoAnswer === true, bundleNetwork: failure.bundleNetwork === true }) };
  }

  async fail(key, batch, failure) {
    const subjectOf = async () => { try { return (await this.ledger.state(key)).reserved?.subject ?? null; } catch { return null; } };
    // What the run queue and the breaker learn from this ending (afterBatch).
    const pos = positionOf(failure.stageNumber, failure.phase);
    const breakerState = breakerOf(this.queue.breaker).state;
    try {
      const started = (await this.ledger.state(key)).state === 'STARTED';
      if (!started && failure.phase === 'bundle' && failure.code === TRAIN_BATCH_MEMBER_MOVED) {
        // ADR 0019 (review 2): a member of the batch moved on after stage 10 composed it. Nothing about the front, the line or this
        // node was decided: released like a supersession (no release cap, no breaker), and this S is dropped from the run queue
        // (settle dropFront: it can never pass again); stage 10 composes the next batch from the members' current heads.
        await this.closeOrThrow(batch, { linux: false });
        await this.ledger.releaseUnexecuted(key, 'SUPERSEDED', { failureCode: failure.code, basis: 'train-batch-member-moved-before-stage-1', class: 'superseded', breaker: 'neutral' });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code, release: 'SUPERSEDED', companionJobTree: failure.companionJobTree ?? null, network: false });
        this.reportOutcome(this.current, 'NOT_EXECUTED', { code: failure.code, key });
        return { state: 'NOT_EXECUTED', key, failureCode: failure.code, release: 'SUPERSEDED',
          settle: { kind: 'released', reason: 'SUPERSEDED', code: failure.code, klass: 'superseded', breaker: 'neutral', breakerState, pos, dropFront: true } };
      }
      if (!started && failure.phase === 'bundle' && failure.code === RESIDENT_BASE_MOVED) {
        // Field defect 2026-11-14 (TURING, PRs #594/#942: three of these opened the breaker and held every other PR for an hour): the
        // bundle found GitHub's main is no longer this subject's base. Nothing ran; the fact is about this subject alone, which can
        // never pass with that base. Released like a supersession (no release cap, no breaker) and the row stops (settle ignored:
        // only a new commit, the PR brought up to main, runs it again; a front S is dropped). A real environment fault stays below.
        await this.closeOrThrow(batch, { linux: false });
        await this.ledger.releaseUnexecuted(key, 'SUPERSEDED', { failureCode: failure.code, basis: 'main-moved-before-stage-1', class: 'superseded', breaker: 'neutral' });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code, release: 'SUPERSEDED', companionJobTree: failure.companionJobTree ?? null, network: false });
        this.reportOutcome(this.current, 'NOT_EXECUTED', { code: failure.code, key });
        return { state: 'NOT_EXECUTED', key, failureCode: failure.code, release: 'SUPERSEDED',
          settle: { kind: 'ignored', reason: 'SUPERSEDED', code: failure.code, klass: 'superseded', breaker: 'neutral', breakerState, pos, dropFront: true } };
      }
      if (!started && failure.phase === 'bundle') {
        // Nothing of this batch reached Linux yet (DESIGN §24): the close archives Windows only and asks the companion for
        // nothing, so a companion still busy with, or done with, the failed bundle cannot turn this release into a HALT.
        await this.closeOrThrow(batch, { linux: false });
        const network = networkFailure({ code: failure.code, bundleNetwork: failure.bundleNetwork === true });
        await this.ledger.releaseUnexecuted(key, 'BUNDLE_UNAVAILABLE', { failureCode: failure.code, class: 'environment', breaker: 'counts', breakerState, network });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code, companionJobTree: failure.companionJobTree ?? null, network });
        this.reportOutcome(this.current, 'NOT_EXECUTED', { code: failure.code, key });
        return { state: 'NOT_EXECUTED', key, failureCode: failure.code,
          settle: { kind: 'released', reason: 'BUNDLE_UNAVAILABLE', code: failure.code, klass: 'environment', breaker: 'counts', breakerState, pos, network } };
      }
      const proof = await this.proofFor(batch, failure.proof);
      // Defect a8910e41 (DESIGN §62.4): the take-over binding run's own end after stage 1 is released, never burned, once the Windows
      // side is proven quiet (as every stage-1 release): its head may run again when this duty is over (frontBound holds it within the
      // duty). Without that proof it goes the table's way below (burned when clean, else UNKNOWN), as before.
      if (!started && failure.code === TRAIN_FRONT_CLAIM_BOUND && failure.stageNumber === 1 && proof.windowsTreeZero === true && proof.serviceOriginalStopped === true) {
        const row = failureRow({ code: failure.code, stage: 1 });
        const facts = ResidentExecutor.failureFacts(failure, row);
        const subject = await subjectOf() ?? this.current;
        await this.closeOrThrow(batch);
        await this.ledger.releaseUnexecuted(key, 'TRAIN_FRONT_BOUND', { failureCode: failure.code, basis: 'train-front-bind-stage-1', ...facts, breakerState });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code, release: 'TRAIN_FRONT_BOUND', class: facts.class });
        if (Number.isSafeInteger(subject?.pr) && HEX40.test(subject?.headSha ?? '')) {
          this.frontBound.set(`${subject.pr}:${subject.headSha}`, this.clock());
          // Best effort: a marker that was not written is lost at a restart, and the head is then like any other head of the duty.
          try { await this.receipt('train-front-bound', { key, pr: subject.pr, headSha: subject.headSha }); } catch { /* see above */ }
        }
        this.reportOutcome(subject, 'NOT_EXECUTED', { code: failure.code, row, key });
        return { state: 'NOT_EXECUTED', key, failureCode: failure.code, release: 'TRAIN_FRONT_BOUND',
          settle: { kind: 'released', reason: 'TRAIN_FRONT_BOUND', code: failure.code, klass: row?.class ?? 'queue', breaker: row?.breaker ?? 'neutral', breakerState, pos,
            outcomeReason: null, network: false, windowsOnly: true } };
      }
      // The failure table (classify.mjs#decideFailure): a stage-1 failure is released only on the outcome's own
      // safeToRerun flag or the broker's "no launch, original restored" answer; every other failure burns the head.
      const { klass, basis, row, release } = decideFailure({ code: failure.code, stage: failure.stageNumber, phase: failure.phase, outcome: failure.outcome,
        brokerNoLaunch: failure.brokerNoLaunch, proof, started });
      const facts = ResidentExecutor.failureFacts(failure, row);
      // C3 (DESIGN §29): stage 1 said this node holds no role (NODE_ROLE_NOT_HELD, or the older Source's NATIVE_NOT_ADMITTED with
      // admission_binding_required): STANDBY, whatever else the ending is. A later live refusal may mean the same: probe at once.
      if (row?.class === 'node-role') await this.setNodeMode('STANDBY', 'role-not-held');
      else if (failure.stageNumber !== 1 && ROLE_LOST_SUSPECT_CODES.includes(failure.code)) this.roleProbe.markUrgent();
      const settle = { code: failure.code, klass: row?.class ?? 'unknown', breaker: row?.breaker ?? 'counts', breakerState, pos, ciRetryAfter: facts.ciRetryAfter, outcomeReason: facts.reason, network: facts.network,
        // Task 0ca0479d: the stage fact's reason codes, for the PR page only (queue.mjs#reasonCodeList).
        reasonCodes: [facts.reasonCodes, facts.nativeReasonCodes].flatMap(c => (Array.isArray(c) ? c : [])),
        ...(typeof failure.windowsOnly === 'boolean' ? { windowsOnly: failure.windowsOnly } : {}) };
      if (!started && release) {
        await this.closeOrThrow(batch);
        await this.ledger.releaseUnexecuted(key, release, { failureCode: failure.code, basis, ...facts, breakerState });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code, release, class: facts.class });
        // C3 (DESIGN §29.10): attempt 2 is consumed before its reservation; a node-role release decided nothing about the PR, so the
        // same attempt 2 is given back (its key is the same: never an attempt 3). A failure here only loses attempt 2 (the safe side).
        // The stage-1 release of a passing GitHub / Native fault (nothing written, DESIGN 49) gives it back the same way: the fault says
        // nothing about the PR, and attempt 2 is the head's only automatic second chance.
        if ((row?.class === 'node-role' || STAGE1_TRANSIENT_RELEASE_CODES.includes(failure.code)) && this.current?.key === key && this.current.attempt === 2) await this.reopenAttempt2(key, failure.code);
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
        this.reportOutcome(subject, 'FAILED_CLEAN', { code: failure.code, row, key, retry: facts.retry });
        const key2 = await this.attempt2IfEligible(key, subject, failure);
        // DESIGN §41.4 "touch failed": a front batch that finally failed for the PR itself is owed to the next on-mode stage 10.
        if (!key2 && row?.class === 'deterministic-pr') await this.noteFrontOutcome(subject, key, failure.code);
        return { state: 'FAILED_CLEAN', key, failureCode: failure.code, ...(key2 ? { attempt2: key2 } : {}), settle: { ...settle, kind: 'burned' } };
      }
      return { ...(await this.unknown(key, failure.code, basis, batch, { stage: failure.stageNumber, ...facts })), settle: { ...settle, kind: 'burned', klass: 'unknown' } };
    } catch (error) {
      return this.unknown(key, codeOf(error), 'failure-handling-unconfirmed', batch, archiveFacts(error));
    }
  }

  // The attempt-2 intent of this attempt-2 batch (key2), given back after a node-role release. Never throws.
  async reopenAttempt2(key2, failureCode = 'NODE_ROLE_NOT_HELD') {
    try {
      const c = this.current;
      const key1 = batchKey({ repo: this.policy.repo, pr: c.pr, headSha: c.headSha, baseSha: c.baseSha, sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1 });
      await this.ledger.reopenAttempt2(key1, { key2, failureCode });
      await this.receipt('attempt2-reopened', { key: key2, attempt1: key1 });
    } catch { /* attempt 2 stays spent */ }
  }

  // The one automatic attempt 2 after a FAILED_CLEAN (attempts.mjs): its intent and receipt, or null when not eligible.
  // A front batch (subject with S, DESIGN §41.4; review R3 M5): its attempt 2 is one of the head's FRONT_BATCHES_PER_HEAD front
  // batches (none when they are used up: then it is not eligible), counted in frontBatches and frontKeys and receipted as a
  // 'train-front-enqueued' (auto) so a restart counts it, and a final deterministic-pr failure of it is reported as touch failed.
  async attempt2IfEligible(key, subject, failure) {
    const decision = attempt2Decision({ policy: this.policy, subject, outcome: 'FAILED_CLEAN', failure });
    if (!decision.eligible) return null;
    const front = Object.hasOwn(subject ?? {}, 'testSha');
    const headKey = front ? `${subject.pr}:${subject.headSha}` : null;
    const list = front ? (this.frontBatches.get(headKey) ?? []) : null;
    // ADR 0019: a batch of several PRs (its binding names members) is not one of the front's own attempts; its attempt 2 is the same
    // members and S again (descriptor /4 from the same binding) and does not use one up either.
    const members = front ? this.frontBindings.get(`${subject.pr}:${subject.testSha}`)?.members ?? null : null;
    const solo = !members;
    // This very batch counts even when its own record was lost (its front attempt, at least 1).
    const used = front ? Math.max(list.filter(x => x.solo !== false).length, this.frontKeys.get(key) ?? 1) : 0;
    if (front && solo && used >= FRONT_BATCHES_PER_HEAD) return null;
    const key2 = await this.ledger.scheduleAttempt2(key, attempt2Subject(subject), { failureCode: failure.code, stage: failure.stageNumber },
      this.clock() + this.policy.automaticAttempt2.delayMs);
    try {
      await this.receipt('attempt2-scheduled', { key, attempt2: key2, failureCode: failure.code, stage: failure.stageNumber });
    } catch (error) {
      // An intent without its receipt is cancelled before the HALT, so no re-arm can ever run it (MINOR 7).
      await this.ledger.closeAttempt2(key, { failureCode: 'ATTEMPT2_RECEIPT_UNCONFIRMED' });
      throw error;
    }
    if (front) {
      const attempt = solo ? used + 1 : Math.min((this.frontKeys.get(key) ?? 1) + 1, FRONT_BATCHES_PER_HEAD);
      list.push({ testSha: subject.testSha, attempt, auto: true, solo });
      this.frontBatches.set(headKey, list);
      this.frontKeys.set(key2, attempt);
      try {
        await this.receipt('train-front-enqueued', { key: key2, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.testSha, testTree: null,
          attempt, claimId: null, since: null, auto: true, ...(members ? { members } : {}) });
      } catch { /* counted in memory; stage 10 counts the head's front batches itself */ }
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

  // ---- the one rule of a batch's life (DESIGN §72, ADR 0027; it replaces the supersession specials of §17.4, §65.9) ----
  //
  // A batch stands only while all three hold: (1) its PR is open, (2) the PR's head is the batch's head, (3) this node holds ci-admission.
  // standing() says at a safe point whether one of them is known to be false: null (the batch stands, or nothing says otherwise) or the
  // fact that ends it, { basis: 'not-on-duty' | 'pr-closed' | 'head-moved', live }. Its inputs are the ones the resident already has:
  //   (3) the node mode: STANDBY (the role probe, or stage 1, said not held). UNCERTAIN is no answer; an engine without the probe has no
  //       mode (a single node: always on duty). The end proves quiescence through the companion, so only with its fresh heartbeat;
  //   (1), (2) one live read of the PR through the companion's pr-head (DESIGN §17.5), due once every SUPERSEDE_LIVE_READ_MS per batch
  //       and at once when the run queue (a newer commit) or stage 10 (the front) names another head of the PR (hint). Stage 1 is a read
  //       too: markStarted counts as this batch's first one. No answer never ends a batch.
  // A batch RESTING at a parking point (A or B) also stands only while (4) no upgrade of this node waits for it (endParkedIfNotStanding,
  // upgradeDraining). Field 2026-11-16 (#1130): the frozen upgrader drains until no ledger entry lacks 90-terminal.json
  // (upgrader/src/resident-ports.mjs#openBatches), while a front batch at B could not pass stage 8 before this node ran the Source the
  // standby already ran (TRAIN_SINGLE_GREEN_NOT_PROVEN at the queue's first place, tries that never count): each waited for the other
  // until the drain ran out, every retry again. A resting batch waits on things outside this node, and the Source that started it is
  // leaving, so it ends here, as the Owner's drain ends every parked batch before a reinstall; a batch in flight finishes as before.
  // Every ending goes the one way, supersededEnd(): quiescence on both hosts, the head burned, a rename-only archive, FAILED_CLEAN
  // SUPERSEDED_AT_SAFE_POINT (neutral, never an attempt 2); anything unproven is UNKNOWN and HALTs. Nothing is published or retracted.
  async standing(key, subject, batch, { hint = null, safePoint = null } = {}) {
    if (this.probing() && this.nodeMode() === 'STANDBY') return (await this.companionFresh()) ? { basis: 'not-on-duty', live: null } : null;
    const queued = this.queue.row(subject.pr)?.current?.headSha ?? null;
    const newer = HEX40.test(queued ?? '') && queued !== subject.headSha ? queued : null;
    const named = HEX40.test(hint ?? '') && hint !== subject.headSha ? hint : newer;
    if (!this.liveReadDue(key, named)) return null;
    const live = await this.livePull(subject.pr, batch);
    if (!live) {
      if (named) await this.receipt('supersede-unconfirmed', { key, pr: subject.pr, safePoint });
      return null;
    }
    if (live.state === 'open' && live.headSha === subject.headSha) {
      // The newer commit in the queue is disproved: it goes back to superseded, this batch's head is current again.
      if (newer && this.queue.keepRunning(subject.pr, subject.headSha, this.clock())) {
        await this.persistQueue();
        await this.receipt('supersede-disproved', { key, pr: subject.pr, safePoint });
      }
      return null;
    }
    return { basis: live.state !== 'open' ? 'pr-closed' : 'head-moved', live };
  }

  // One live read per batch and named head every SUPERSEDE_LIVE_READ_MS (named null: the batch's own cadence). true: due, and taken now.
  liveReadDue(key, named = null) {
    this.liveReadAt ??= new Map();
    const id = `${key}:${named ?? ''}`, now = this.clock();
    if (now - (this.liveReadAt.get(id) ?? -Infinity) < SUPERSEDE_LIVE_READ_MS) return false;
    this.liveReadAt.delete(id);
    this.liveReadAt.set(id, now);
    if (this.liveReadAt.size > 64) this.liveReadAt.delete(this.liveReadAt.keys().next().value);
    return true;
  }

  // The end proves quiescence through the companion: only with its fresh heartbeat.
  async companionFresh() {
    let beat = null;
    try { beat = await this.companion.heartbeat?.(); } catch { beat = null; }
    return typeof beat?.at === 'number' && this.clock() - beat.at <= this.policy.companion.heartbeatMaxAgeMs;
  }

  // (4) for a resting batch: this node's upgrader waits for the drain. Both of its own words, read this tick: upgrade\status.json says its
  // op is WAITING_DRAIN (the versions port; the upgrader, not the Owner's session, writes it), and its intake hold is in force (renewed
  // while it drains, lifted when the drain runs out, at most two hours: a status it left behind ends nothing). Not read: null.
  async upgradeDraining() {
    if (this.versionState?.view?.upgrade?.state !== 'WAITING_DRAIN') return null;
    let view = null;
    try { view = await this.intakeRefresh(); } catch { return null; }
    if (!(view?.holders ?? []).some(h => h.holder === UPGRADE_HOLDER)) return null;
    return (await this.companionFresh()) ? { basis: UPGRADE_DRAIN_BASIS, live: null } : null;
  }

  // A batch in flight, at a safe point outside the Linux preparation (before stage R's plan, before the workspace): the inbox is read
  // again first, so a newer commit that arrived while it ran is a hint. null: it goes on.
  async endIfNotStanding(key, subject, batch, safePoint, pos, stage = 1) {
    try { await this.intake(); } catch { /* the next tick reads it */ }
    const fact = await this.standing(key, subject, batch, { safePoint });
    return fact ? this.supersededEnd(key, subject, batch, { safePoint, pos, stage, ...fact }) : null;
  }

  // A batch resting at parking point A ('waiting') or B ('parked'), held to the rule on every tick (endNotStanding) and when stage 10
  // names another head of its PR (hint). null: it stays.
  async endParkedIfNotStanding(entry, hint = null) {
    const { key } = entry, subject = entry.reserved.subject, atB = Ledger.parkedAt(entry);
    if (!atB && !Ledger.waitingAt(entry)) return null;
    const batch = atB ? entry.parked.batch : entry.wait.batch, safePoint = atB ? 'parked' : 'waiting';
    const fact = (await this.upgradeDraining()) ?? await this.standing(key, subject, batch, { hint, safePoint });
    if (!fact) return null;
    this.parkNudges?.delete(key);
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: entry.reserved.reservedAt ?? null };
    let outcome;
    try {
      outcome = await this.supersededEnd(key, subject, batch, { safePoint, pos: atB ? POSITIONS[8] : POSITIONS[1], stage: atB ? 8 : 1, ...fact });
    } catch (error) {
      outcome = await this.unknown(key, codeOf(error), 'executor-exception', batch, archiveFacts(error));
    }
    return this.afterBatch(subject, entry.reserved.origin ?? 'queued', outcome);
  }

  // Every tick (after recovery, HALT and the backfill; under PAUSE too, before the tick rests there): the first resting batch that no
  // longer stands is ended. One per tick; the next tick takes the next one.
  async endNotStanding() {
    let entries;
    try { entries = await this.ledger.parkedEntries(); } catch { return null; }
    for (const e of entries) {
      const r = await this.endParkedIfNotStanding(e);
      if (r) return r;
    }
    return null;
  }

  // The executor's own end of a batch that no longer stands (DESIGN §72), on the Owner abort's path (DESIGN §6.5): nothing of this batch
  // runs at a safe point, so quiescence on both hosts, the head burned, a rename-only archive with the fixed reason superseded, and
  // FAILED_CLEAN SUPERSEDED_AT_SAFE_POINT (neutral for the breaker, never an attempt 2). Unproven: UNKNOWN, HALT.
  //   basis: which part of the rule failed ('pr-closed', 'head-moved', 'not-on-duty', 'upgrade-drain'); live: the PR read that showed it (null
  //   for duty and the drain).
  async supersededEnd(key, subject, batch, { safePoint, pos, basis, live = null, stage = 1 }) {
    const context = { safePoint, stage: null };
    try {
      // Never archive from drifted bytes (re-review of step 2, m16).
      const drift = await this.driftCode();
      if (drift) return await this.unknown(key, drift, 'superseded-source-drift', batch, context);
      // First the create-only record: a crash from here on is a crash scene (SUPERSEDE_INTERRUPTED), never a wait that a
      // restart would resume on a half-archived scene (independent review of step 1, M1).
      await this.ledger.beginSelfAbort(key, { safePoint, basis, liveHeadSha: live?.headSha ?? null, liveState: live?.state ?? null });
      await this.receipt('batch-self-abort', { key, pr: subject.pr, safePoint, basis });
      const proof = await this.abortQuiescence(batch, {});
      if (!proofComplete(proof)) return await this.unknown(key, 'SUPERSEDE_QUIESCENCE_UNPROVEN', 'superseded-quiescence-unproven', batch, context);
      const capacity = basis === 'park-over-capacity';
      const failureCode = capacity ? 'PARKED_OVER_CAPACITY' : SUPERSEDED_AT_SAFE_POINT;
      const klass = capacity ? 'queue' : 'clean-final';
      await this.ledger.burnHead(key, { failureCode });
      const windows = await this.engine.archiveFailure(batch, SUPERSEDED_ARCHIVE_REASON);
      const linux = await this.companion.archiveLinux(batch, SUPERSEDED_ARCHIVE_REASON);
      archiveCheck(windows && windows.verified === true && linux && linux.verified === true, 'FAILURE_ARCHIVE_UNCONFIRMED', windows);
      // stage: the last stage that ran (executed-heads.mjs#mayHavePublished): 1 before the workspace (nothing after stage 1
      // published, unless stage R relayed a role, which its plan says); 8 at parking point B (stages 3, 5 and 7 published).
      const readmit = capacity || ['upgrade-drain', 'park-max-age'].includes(basis);
      const retry = capacity ? 'new-trigger' : readmit ? 'safe-point' : 'new-commit';
      await this.ledger.terminal(key, 'FAILED_CLEAN', { failureCode, basis, safePoint, stage, batchId: batch?.batchId ?? null,
        windows: windows.directory, linux: linux.directory, class: klass, retry, breaker: 'neutral', liveHeadSha: live?.headSha ?? null, liveState: live?.state ?? null });
      await this.receipt('batch-terminal', { key, outcome: 'FAILED_CLEAN', failureCode, safePoint, basis });
      this.reportOutcome(subject, 'FAILED_CLEAN', { code: failureCode, key, retry });
      // At B only Windows was touched since the parking told the breaker about stages 1-7 (review of step 2, M2).
      return { state: 'FAILED_CLEAN', key, failureCode, safePoint,
        settle: { kind: readmit ? 'readmit' : 'burned', code: failureCode, klass, breaker: 'neutral', pos, ...(stage === 8 ? { windowsOnly: true } : {}) } };
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
