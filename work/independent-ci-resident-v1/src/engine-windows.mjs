// Windows engine for the resident executor: derive one batch from the installed Source v2 and run
// its eight fixed stages through the Source v2 stage invoker (resident-v2/invoke-stage.mjs: sealed stage
// directory, swap-broker request, generic helper, native receipt + entry outcome -> one stage fact).
//
// The pure parsers below are unit-tested. Every v2 entry point is checked first and its absence fails
// closed with SOURCE_V2_REQUIRED. Contracts used (DESIGN §7):
//   derive-batch.mjs --subject-json --batch-key --batch-id --out  -> RESIDENT_BATCH_DERIVED (S4)
//   invoke-stage.mjs --batch-dir --stage --work-manifest-sha256 --batch-key -> stage fact /2 (S1, S11, S12)
//   archive-windows-spool.ps1 -BatchKey -Reason -> {verified, directory, moved, code} (S14)
//   companion check-refs before the first local Linux stage (S9, lesson b29) and the v4 bridge pump for
//   stages 2, 4, 6 (S7)
// Owner abort (DESIGN §6.5): requestStop() asks a running scanner-issuer stage to stop through its own stop path
// (a pump cancel for the companion and a broker stop request bound to the in-flight swap); nothing here kills.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CODE, HEX64, check, fail, parseBoundedJson, sha256, canonicalJson } from './canonical.mjs';
import { exists, readBounded, writeNew, ensureDir } from './store.mjs';
import { ABORTABLE_IN_FLIGHT, EXECUTION_RETRY_STAGES, LINUX_MEMORY_NOT_READY } from './classify.mjs';
import { pinnedNodeProfile, validateNodeProfile } from './node-profile.mjs';
import { validateRoleProbeFact } from './role-probe.mjs';
import { RELAY_TIMEOUT_MS } from './companion.mjs';
import { powershellArgv } from './powershell-argv.mjs';
import { ARCHIVE_LINUX_REQUEST_MS, CHECK_REFS_REQUEST_MS } from './mailbox.mjs';
import { REVOCATION_STAGE, REVOCATION_RUN_MS, REVOCATION_PENDING_STATE, REVOCATION_RUN_ID,
  validateRevocationFacts,validateRevocationQualification } from './revocation-maintenance.mjs';
import { RUN_MODES, TRAIN_RUN_INPUT_FIELDS, chainOfFront, validateTrainRunInput } from './train.mjs';
// Rule 41ab823a (DESIGN §75): stage 1's headScans, in the shape head-scans.mjs checks (re-exported for the tests that cross-check it).
import { HEAD_SCAN_EXTERNAL_ID, HEAD_SCAN_ROLES, stageHeadScans } from './head-scans.mjs';
export { HEAD_SCAN_EXTERNAL_ID, HEAD_SCAN_ROLES, stageHeadScans };

// How long a failed read of the installed Source's watch support waits before it is read again (queueWatchSupported).
export const QUEUE_WATCH_SUPPORT_RETRY_MS = 5 * 60_000;
// The installed train mode stages 1 and 8 read (INTERFACES §6: 'off', 'shadow' or 'on'; 'off' for anything else). The one
// place the resident names it: service-main.mjs gives it to the engine (port trainMode), which passes it to the invoker as
// --train-mode for those two stages only; the invoker writes it create-only as train-mode.json into the stage directory
// (Source v2 invoke-stage.mjs#prepareStageDirectory, train-mode.mjs#stageTrainModeText). No file is 'off'.
export function installedTrainMode(policy) { return ['off', 'shadow', 'on'].includes(policy?.train?.enabled) ? policy.train.enabled : 'off'; }
export const TRAIN_MODE_STAGES = Object.freeze([1, 8]);
// ADR 0018: stages 8 and 10 learn the installed train.landing and train.batchMax through train-landing.json (Source v2 train-landing.mjs).
// The invoker gets --train-landing only when it is not the default (github-merge, 1): no file is github-merge.
export const TRAIN_LANDING_STAGES = Object.freeze([8, 10]);

export const ORIGINAL_BINARY = '"C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"';
// /3 (quota phase 2 step 3b): also names the tested commit S (testSha); S = H except for a train front batch, whose
// subject names its own S (step 3c-2).
export const DESCRIPTOR_CONTRACT = 'clued.independent-ci.resident-batch-descriptor/3';
// ADR 0019: a train front batch of several PRs (S is their cumulative merge on T) is described as /4: /3's fields plus S's tree
// (testTree) and the members [{pr, headSha}] in merge order, the front first. Its job ids are /3's (S names the whole chain).
// Written only for a batch whose stage 10 named members, and stage 10 names members only when this engine told it the installed
// components take /4 (batchChainSupported).
export const DESCRIPTOR_CHAIN_CONTRACT = 'clued.independent-ci.resident-batch-descriptor/4';
// The literals batchChainSupported looks for in the installed Source v2 (resident-v2/): the bundle and the workspace preparation take
// /4, and the invoker takes the stage-10 argument ':chain' (Source v2 invoke-stage.mjs#parseLandingArg).
export const BATCH_CHAIN_SOURCE_MARKERS = Object.freeze([
  ['build-bundle.ps1', "$ChainContract='clued.independent-ci.resident-batch-descriptor/4'"],
  ['prepare-workspaces.py', "DESCRIPTOR_CHAIN_CONTRACT = 'clued.independent-ci.resident-batch-descriptor/4'"],
  ['invoke-stage.mjs', "export const TRAIN_LANDING_CHAIN_ARG = 'chain';"],
]);
export const TRAIN_LANDING_CHAIN_SUFFIX = ':chain';
// The codes the companion's bridge pump can end with (companion.mjs#pump); a stage's companion answer is taken
// only from this list, and none of them is an attempt-2 transient code.
export const PUMP_CODES = Object.freeze(['ACTUAL_ISSUE_NOT_PUBLISHED', 'ISSUE_TRANSFER_UNCONFIRMED', 'LINUX_WORKER_START_UNCONFIRMED', 'FORMAL_BRIDGE_STAGE_DEADLINE',
  'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED', 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED', 'FORMAL_WORKER_TERMINAL_UNCONFIRMED', 'RELAY_REFUSED_NO_RETRY', 'RELAY_PARTIAL_RECORD_PRESERVED',
  'COMPANION_PUMP_UNCONFIRMED', 'COMPANION_REQUEST_EXPIRED', 'COMPANION_HANDLER_UNCONFIRMED', 'COMPANION_PUMP_CANCELLED',
  // DESIGN §26: the worker ran and ended with no record left (signal B), never started (signal C), and the engine's own code
  // for a companion whose heartbeat stopped while the stage ran (signal D).
  'LINUX_WORKER_ENDED_WITHOUT_RECORD', 'LINUX_WORKER_NOT_STARTED', 'COMPANION_HEARTBEAT_LOST']);
// The pump answers after which it relays nothing more for its stage (DESIGN §26 signal A). Not FORMAL_WORKER_TERMINAL_UNCONFIRMED
// (the result or blocked record was moved already) and not COMPANION_PUMP_CANCELLED (only a cancel ends a pump so).
export const PUMP_DEAD_CODES = Object.freeze(['RELAY_REFUSED_NO_RETRY', 'RELAY_PARTIAL_RECORD_PRESERVED', 'ISSUE_TRANSFER_UNCONFIRMED', 'LINUX_WORKER_START_UNCONFIRMED',
  'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED', 'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED', 'LINUX_WORKER_ENDED_WITHOUT_RECORD', 'LINUX_WORKER_NOT_STARTED',
  'COMPANION_PUMP_UNCONFIRMED', 'COMPANION_HANDLER_UNCONFIRMED', 'COMPANION_REQUEST_EXPIRED']);
// A dead pump, or a lost heartbeat, leaves the issuer this long to take a record the pump moved just before; then the stage is
// asked to stop through its own stop path (bridgeStop). The observer looks every BRIDGE_POLL_MS.
export const BRIDGE_STOP_GRACE_MS = 60_000;
export const BRIDGE_POLL_MS = 5_000;
// Signal D: no heartbeat for this long while the stage runs (the companion's timer beats every 10 s).
export const PUMP_HEARTBEAT_STALE_MS = 120_000;
// Pump quiet (c18eac1d generalised): after a stage that ended without success, the cancelled pump's answer is awaited this long.
export const PUMP_QUIET_MS = RELAY_TIMEOUT_MS + 60_000;
// The stage code of a scanner-issuer stage the bridge stop ended (STOP_SENT, its Windows tree drained).
export const BRIDGE_STAGE_STOPPED_PUMP_LOST = 'BRIDGE_STAGE_STOPPED_PUMP_LOST';
// The pre-stage memory gate (DESIGN §32, Task 25851665), right before a scanner stage (2, 4, 6) is invoked, so before its issue
// exists: the companion's memory-ready facts (one wsl.exe per check). Ready: at least MEMORY_GATE_MIN_BLOCKS free blocks of the
// hv_sock ring order, memguard's own LOW_BLOCKS (linux/host-tuning/clued-wsl-memguard): six channels for each wsl.exe, and about
// ten wsl.exe calls a stage cannot do without in its first minutes. A low reading waits for memguard (it runs every 60 s and
// compacts below the same number; its back-off and cache drop are 5 minutes), looking again every MEMORY_GATE_POLL_MS, for at
// most MEMORY_GATE_WAIT_MS / MEMORY_GATE_CHECKS; still low then: LINUX_MEMORY_NOT_READY, the stage never invoked. A reading
// that cannot be had proves nothing: without an earlier low reading the stage runs at once, as before the gate.
export const MEMORY_GATE_MIN_BLOCKS = 64;
export const MEMORY_GATE_POLL_MS = 60_000;
export const MEMORY_GATE_WAIT_MS = 6 * 60_000;
export const MEMORY_GATE_CHECKS = 7;
export const MEMORY_READ_TIMEOUT_MS = 60_000;
const memoryFacts = m => m && typeof m === 'object' && Number.isSafeInteger(m.order) && m.order >= 0 && m.order <= 10 && Number.isSafeInteger(m.blocks) && m.blocks >= 0 ? m : null;
// The broker request the Source v2 invoker writes (resident-v2/broker-protocol.mjs) and the stop request the
// resident may write next to it for an Owner abort (windows/SwapBroker.cs, StopRequest).
export const BROKER_REQUEST_CONTRACT = 'clued.independent-ci.swap-broker-request/2';
export const BROKER_STOP_CONTRACT = 'clued.independent-ci.swap-broker-stop/1';
export const BROKER_STOP_RECEIPT_CONTRACT = 'clued.independent-ci.swap-broker-stop-receipt/1';
const NONCE32 = /^[0-9a-f]{32}$/;
const SWAP_REQUEST = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$/;

// The in-flight swap of one stage: a broker request the broker has taken (<id>.taken) and not answered yet, whose
// stage and config pin (the plan hash of exactly this batch's stage package) are the given ones. Exactly one, or null.
export async function findInflightSwap(brokerRoot, stage, configSha256) {
  check(ABORTABLE_IN_FLIGHT.includes(stage) && HEX64.test(configSha256 ?? ''), 'OWNER_ABORT_STOP_TARGET_INVALID');
  const requests = path.join(brokerRoot, 'requests'), responses = path.join(brokerRoot, 'responses');
  const found = [];
  for (const name of (await fs.readdir(requests)).sort()) {
    const id = SWAP_REQUEST.exec(name)?.[1];
    if (!id) continue;
    if (await exists(path.join(responses, `${id}.json`)) || !(await exists(path.join(responses, `${id}.taken`)))) continue;
    let v;
    try { v = parseBoundedJson(await readBounded(path.join(requests, name), 4096, 'BROKER_REQUEST_REFUSED'), 4096, 'BROKER_REQUEST_REFUSED'); } catch { continue; }
    if (v.contract === BROKER_REQUEST_CONTRACT && v.stage === stage && v.configSha256 === configSha256 && NONCE32.test(v.nonce ?? '')) found.push({ requestId: id, nonce: v.nonce, stage, configSha256 });
  }
  return found.length === 1 ? found[0] : null;
}

const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];

// The terminal fact the Source v2 stage invoker prints (stage-fact.mjs#buildStageFact keeps the v1 field
// names that run-batch.ps1:92 checked; contract /2 adds the bound entry outcome).
export const STAGE_FACT_CONTRACT = 'clued.independent-ci.resident-stage-fact/2';

// The bound entry outcome as the stage fact carries it (resident quota redesign v0.6 §9 phase 1, item 4; Source
// stage-fact.mjs#outcomeFacts): status, reason, side effects, the admission diagnostic (reasonCodes, nativeReasonCodes,
// ...), the scheduling facts (ci_retry_after, merge-queue entry) and the entry's own safeToRerun flag. Re-validated
// here to a fixed shape: anything that does not fit is dropped (null), never guessed, so a malformed outcome can only
// lose a release, never gain one. Only diagnostics and scheduling: no free text crosses into the ledger or status.
const ENUM = /^[A-Za-z_]{1,40}$/, DCODE = /^[a-z][a-z0-9_]{0,63}$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
// Mirror the Source diagnostic allow-list; these fields never authorize admission, retry or cleanup.
const ADMISSION_PHASES = new Set(['mode', 'principal', 'observer', 'pull_request', 'claim_reference', 'evaluate', 'post_evaluate', 'post_pull_request', 'native', 'changed_paths']);
const ISSUER_TRANSIENT_ADMISSIONS = new Set(['full_admission_observation_expired', 'full_admission_unavailable']);
const OWNER_REVIEW_KINDS = new Set(['granted', 'pending', 'transient', 'rpc_unavailable', 'refused', 'UNKNOWN']);
export const QUEUE_STATES = Object.freeze(['head', 'waiting', 'lapsed', 'out', 'none']);   // the Source's MERGE_QUEUE_STATES
const isoOrNull = v => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
function queueEntry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join('|') !== 'entered|position|state' || typeof v.entered !== 'boolean') return null;
  const state = QUEUE_STATES.includes(v.state) ? v.state : null;
  return { entered: v.entered && (state === 'head' || state === 'waiting'), state, position: Number.isSafeInteger(v.position) && v.position > 0 && v.position <= 10_000 ? v.position : null };
}
const codeList = v => Array.isArray(v) ? [...new Set(v.slice(0, 64).filter(x => typeof x === 'string' && DCODE.test(x)))].sort() : [];
export function parseStageOutcome(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.status !== 'string' || !/^[A-Z][A-Z_]{1,60}$/.test(o.status) || !(o.reason === null || (typeof o.reason === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(o.reason)))
    || !Number.isSafeInteger(o.sideEffects) || o.sideEffects < 0 || typeof o.mayHavePublished !== 'boolean') return null;
  const d = o.diagnostic && typeof o.diagnostic === 'object' && !Array.isArray(o.diagnostic) ? o.diagnostic : null;
  const s = o.scheduling && typeof o.scheduling === 'object' && !Array.isArray(o.scheduling) ? o.scheduling : null;
  const diagnostic = d ? { verdict: ENUM.test(d.verdict ?? '') ? d.verdict : 'UNKNOWN', nativeVerdict: ENUM.test(d.nativeVerdict ?? '') ? d.nativeVerdict : 'UNKNOWN',
    reasonCodes: codeList(d.reasonCodes), nativeReasonCodes: codeList(d.nativeReasonCodes), ciRetryAfter: isoOrNull(d.ciRetryAfter), mergeQueue: queueEntry(d.mergeQueue) } : null;
  if (diagnostic) {
    if (OWNER_REVIEW_KINDS.has(d.ownerReviewKind)) diagnostic.ownerReviewKind = d.ownerReviewKind;
    if (ADMISSION_PHASES.has(d.phase)) diagnostic.phase = d.phase;
    // transport (generation 10): Source full-admission-v2.mjs#transportFault, kept so classify.mjs#networkFailure can tell the line from
    // any other fault of a NATIVE_ADMISSION_UNAVAILABLE.
    for (const field of ['workflowGateFindingsPresent', 'modeFresh', 'recorderFresh', 'transport']) if (typeof d[field] === 'boolean') diagnostic[field] = d[field];
    if (ISSUER_TRANSIENT_ADMISSIONS.has(d.transientAdmission)) {
      diagnostic.transientAdmission = d.transientAdmission;
      if (Number.isSafeInteger(d.evaluations) && d.evaluations >= 1 && d.evaluations <= 4) diagnostic.evaluations = d.evaluations;
    }
  }
  return {
    status: o.status, reason: o.reason, sideEffects: o.sideEffects, mayHavePublished: o.mayHavePublished,
    diagnostic,
    // claimExpiresAt (generation 12, DESIGN §56.3): the claim's lease end Native reported, for the renewal reminder only.
    scheduling: s ? { ciRetryAfter: isoOrNull(s.ciRetryAfter), mergeQueue: queueEntry(s.mergeQueue), claimExpiresAt: isoOrNull(s.claimExpiresAt) } : null,
    // the flag holds only on a clean BLOCKED with zero side effects that may not have published
    safeToRerun: o.safeToRerun === true && o.status === 'BLOCKED' && o.sideEffects === 0 && o.mayHavePublished === false,
    // Generation 28 (docs/adr/0015): the scanner publisher's "withdrawn for unavailability only, a republication may follow", only on REVOKED.
    ...(o.republishSafe === true && o.status === 'REVOKED' ? { republishSafe: true } : {}),
    // Rule 41ab823a (DESIGN §75): only on a settled stage 1 of a front batch (executor.mjs#frontScansReused reads it).
    ...(o.status === 'SETTLED' && stageHeadScans(o.headScans) ? { headScans: stageHeadScans(o.headScans) } : {}),
    // Stage 1 settled on a PR that merged meanwhile (Source publisher settledMerged): only the boolean, only on SETTLED
    // (executor.mjs reads it after stage 1: that stage was no live read of an open PR).
    ...(o.status === 'SETTLED' && o.settledMerged === true ? { settledMerged: true } : {}),
  };
}

export function parseStageFact(text, expectedManifestSha256) {
  const f = parseBoundedJson(Buffer.from(text, 'utf8'), 1024 * 1024, 'STAGE_FACT_REFUSED');
  if (f.contract !== undefined && f.contract !== STAGE_FACT_CONTRACT) return { ok: false, code: 'STAGE_TERMINAL_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: false }, nativeReceiptSha256: null, outcome: null, brokerNoLaunch: false };
  const restored = f.original_binary_restored === true && f.complete_original_readback === true;
  const treeZero = f.tree_cleanup_confirmed === true && f.tree_active_processes === 0 && f.root_exit_confirmed === true;
  const outcome = parseStageOutcome(f.outcome);
  let revocation = null, maintenancePending = false;
  if (f.stage === REVOCATION_STAGE && f.contract === STAGE_FACT_CONTRACT) {
    try {
      const facts = validateRevocationFacts(f.revocation);
      check(f.maintenancePending === !facts.complete && f.failure_code === null && outcome !== null
        && outcome.status === (facts.complete ? 'REVOCATION_MAINTENANCE' : 'PENDING')
        && f.state === (facts.complete ? 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION' : REVOCATION_PENDING_STATE)
        && HEX64.test(f.native_receipt_sha256 ?? ''),'REVOCATION_FACTS_REFUSED');
      revocation = facts;maintenancePending = !facts.complete;
    } catch { /* an unbound maintenance result is never a successful stage */ }
  }
  const terminalState = f.state === 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION'
    || f.stage === REVOCATION_STAGE && f.state === REVOCATION_PENDING_STATE;
  const ok = terminalState && (f.stage !== REVOCATION_STAGE || revocation !== null) && restored && treeZero
    && f.manifest_sha256 === expectedManifestSha256 && f.scm_start_call_issued === true && f.configuration_conflict_detected === false;
  const code = ok ? null : (typeof f.failure_code === 'string' && CODE.test(f.failure_code) ? f.failure_code : (typeof f.state === 'string' && CODE.test(f.state) ? f.state : 'STAGE_TERMINAL_UNCONFIRMED'));
  // Stage 10 only: the train facts as the Source wrote them; the executor keeps only what train.mjs#trainSummary reads.
  const train = f.train && typeof f.train === 'object' && !Array.isArray(f.train) ? f.train : null;
  // The broker refused before any start and re-read the original (stage-fact.mjs BROKER_NO_LAUNCH_CODES): one of the
  // two ways a stage-1 failure may be released (classify.mjs#decideFailure); only with the fact's own readback.
  const brokerNoLaunch = !ok && f.broker_no_launch === true && f.scm_start_call_issued === false && restored && treeZero && f.configuration_conflict_detected === false;
  let roleProbe = null;
  if (f.stage === 11 && ok) { try { roleProbe = validateRoleProbeFact(f.roleProbe); } catch { /* no fact */ } }
  return { ok, code,
    proof: { windowsTreeZero: treeZero, serviceOriginalStopped: restored }, nativeReceiptSha256: HEX64.test(f.native_receipt_sha256 ?? '') ? f.native_receipt_sha256 : null, train, roleProbe,
    ...(f.stage === REVOCATION_STAGE ? { revocation,maintenancePending } : {}),
    outcome, brokerNoLaunch };
}

// Independent SCM readback (sc.exe qc / queryex), so "original and stopped" never rests on the
// stage's own report alone. The account must still be .\clued-control (the broker never changes it).
export function parseScQc(text) {
  const bin = /BINARY_PATH_NAME\s*:\s*(.+)\r?$/m.exec(text)?.[1]?.trim() ?? null;
  const start = /START_TYPE\s*:\s*(\d+)/.exec(text)?.[1] ?? null;
  const account = /SERVICE_START_NAME\s*:\s*(.+)\r?$/m.exec(text)?.[1]?.trim() ?? null;
  return { binary: bin, startType: start === null ? null : Number(start), account };
}
export function parseScQueryex(text) {
  const state = /STATE\s*:\s*(\d+)/.exec(text)?.[1] ?? null;
  const pid = /PID\s*:\s*(\d+)/.exec(text)?.[1] ?? null;
  return { state: state === null ? null : Number(state), pid: pid === null ? null : Number(pid) };
}
export const originalStopped = (qc, q, node) => {
  validateNodeProfile(node);
  const account = String(qc.account ?? '').toLowerCase();
  return qc.binary === ORIGINAL_BINARY && qc.startType === 3 && ['.\\clued-control', `${node.hostname.toLowerCase()}\\clued-control`].includes(account) && q.state === 1 && q.pid === 0;
};

// The code of a Windows archive that did not verify (DESIGN §33): the tool's own `code` when it is a fixed code (CODE), else the
// runner's refusal, a timeout, or WINDOWS_ARCHIVE_UNCONFIRMED. Never the tool's free text, its stderr, or a path.
export function windowsArchiveCode(r, v) {
  if (typeof v?.code === 'string' && CODE.test(v.code)) return v.code;
  if (typeof r?.refused === 'string' && CODE.test(r.refused)) return r.refused;
  if (r?.timedOut === true) return 'WINDOWS_ARCHIVE_TIMED_OUT';
  return 'WINDOWS_ARCHIVE_UNCONFIRMED';
}

// Generation 11 (DESIGN 55): the waits before the refs gate is asked again after an answer that says only that the line gave none
// (REMOTE_REFS_NO_ANSWER, companion.mjs). Nothing of the stage has run; an Owner abort ends the wait at once (gateSleep), and after each
// wait the executor's own check (runStage opts.stillAllowed: no HALT, no drift, the authority still holds) must pass.
export const REFS_GATE_RETRY_MS = Object.freeze([60_000, 300_000]);

export class WindowsEngine {
  // ports: { run (Runner.run), busy() (Runner.busy), companionMailbox, sleep, clock,
  //          paths: { sourceRoot, workRoot, outboxRoot, nodeExe, powershellExe, scExe },
  //          trainMode (installedTrainMode(policy); absent: stages 1 and 8 get no train-mode.json, i.e. 'off'),
  //          trainLanding (policy.mjs#installedTrainLanding; absent or the default: no train-landing.json, i.e. github-merge) }
  constructor({ node, nodeProfileSha256, ...ports }) {
    this.node = pinnedNodeProfile(node, nodeProfileSha256);
    this.nodeProfileSha256 = nodeProfileSha256;
    Object.assign(this, ports);
    check(this.trainMode === undefined || ['off', 'shadow', 'on'].includes(this.trainMode), 'RESIDENT_TRAIN_MODE_INVALID');
    check(this.trainLanding === undefined || (['github-merge', 'push'].includes(this.trainLanding?.landing) && Number.isSafeInteger(this.trainLanding.batchMax)
      && this.trainLanding.batchMax >= 1 && this.trainLanding.batchMax <= 4), 'RESIDENT_TRAIN_MODE_INVALID');
  }

  v2(name) { return path.join(this.paths.sourceRoot, ...V2, name); }

  // The invoker's --train-mode for stages 1 and 8 (DESIGN §41.2); nothing for any other stage.
  trainModeArgs(number) {
    const landing = this.trainLanding !== undefined && TRAIN_LANDING_STAGES.includes(number) && (this.trainLanding.landing !== 'github-merge' || this.trainLanding.batchMax !== 1)
      ? ['--train-landing', `${this.trainLanding.landing}:${this.trainLanding.batchMax}`] : [];
    return [...(this.trainMode !== undefined && TRAIN_MODE_STAGES.includes(number) ? ['--train-mode', this.trainMode] : []), ...landing];
  }

  // The config pin the invoker sends the broker for this stage: the plan hash recorded in the stage package's work
  // manifest, read only after the manifest's own bytes matched the pin derived with the batch.
  async stagePlanSha256(batch, number) {
    const row = batch.stages?.[number - 1];
    check(row && row.number === number && HEX64.test(row.workManifestSha256 ?? ''), 'RESIDENT_STAGE_ROW_INVALID');
    const bytes = await readBounded(path.join(batch.dir, `stage-${String(number).padStart(2, '0')}`, 'work-manifest.json'), 65536, 'OWNER_ABORT_STAGE_PACKAGE_REFUSED');
    check(sha256(bytes) === row.workManifestSha256, 'OWNER_ABORT_STAGE_PACKAGE_REFUSED');
    const planSha256 = parseBoundedJson(bytes, 65536, 'OWNER_ABORT_STAGE_PACKAGE_REFUSED').planSha256;
    check(HEX64.test(planSha256 ?? ''), 'OWNER_ABORT_STAGE_PACKAGE_REFUSED');
    return planSha256;
  }

  // Owner abort of a running scanner-issuer stage. Idempotent; the executor calls it again on every poll until it
  // answers done or the stage has ended. Each effect is create-only, bound to this batch's stage, and tried on its own:
  //   - the stage is not invoked at all if it has not been yet (invoke() checks this flag);
  //   - first a stop request next to the in-flight broker request: the broker sends the runner service one
  //     SERVICE_CONTROL_STOP, which the helper handles (STOP_REQUESTED) by draining its own job object, and records
  //     what it did in its own receipt (stopOutcome);
  //   - only once that receipt says STOP_SENT, or the stage's invoke-stage call has returned with a stage fact (the broker
  //     answered, whatever its code; the invoker refused the stage before asking the broker; or it gave up waiting for the
  //     answer, past the broker's and the pump's own deadlines): the issuer no longer waits for anything the pump could
  //     bring. Then the companion's bridge pump for the stage is cancelled (it stops relaying, never stops the worker). Before that the pump, and its blocked hand-over,
  //     run exactly as without an abort, so a stop that does not reach the helper leaves the stage no worse off
  //     (independent reviews, M4 and second review MINOR 2).
  async requestStop(batch, number) {
    check(ABORTABLE_IN_FLIGHT.includes(number) && batch && typeof batch.batchId === 'string', 'OWNER_ABORT_STOP_TARGET_INVALID');
    this.abortRequested = { batchId: batch.batchId, stage: number };
    this.gateWake?.();
    const mine = s => s && s.batchId === batch.batchId && s.stage === number;
    const stop = await this.stageStop(batch, number);
    const out = { broker: stop.requestId !== null, requestId: stop.requestId, stopCode: stop.stopCode, pump: false, done: false };
    const pump = this.inflight;
    const pumpInFlight = mine(pump);
    if (pumpInFlight && (out.stopCode === 'STOP_SENT' || pump.windowsEnded === true)) {
      try { out.pump = await this.companionMailbox.cancel(await pump.request, 'owner-abort'); } catch { out.pump = false; }
    }
    // Done once nothing is left to do: the pump of a stage still in flight is cancelled, or, with no pump in flight, the
    // broker has settled the stop request. Until then the executor asks again on its next poll.
    out.done = pumpInFlight ? out.pump : out.stopCode !== null;
    return out;
  }

  // The stop path of a running scanner-issuer stage, shared by the Owner abort (requestStop) and the bridge stop (bridgeStop,
  // DESIGN §26): the one in-flight swap of this batch's stage gets its broker stop request (create-only: one already there is
  // the same stop, so an abort and a bridge stop together leave one file), which is remembered, and the broker's receipt is read.
  // Nothing else: no pump cancel, no ledger record, no process ended here. { requestId, stopCode }, both null until found.
  async stageStop(batch, number) {
    check(ABORTABLE_IN_FLIGHT.includes(number) && batch && typeof batch.batchId === 'string', 'OWNER_ABORT_STOP_TARGET_INVALID');
    const mine = s => s && s.batchId === batch.batchId && s.stage === number;
    let requestId = mine(this.stageStopFor) ? this.stageStopFor.requestId : null;
    if (!requestId) {
      try {
        const swap = await findInflightSwap(this.paths.brokerRoot, number, await this.stagePlanSha256(batch, number));
        if (swap) {
          try {
            await writeNew(path.join(this.paths.brokerRoot, 'requests', `${swap.requestId}.stop`), { contract: BROKER_STOP_CONTRACT, ...swap });
          } catch (error) {
            if (error.code !== 'CREATE_ONLY_TARGET_EXISTS') throw error;
          }
          // Remembered: once the broker answers the swap it is no longer "in flight", but its stop receipt stays readable.
          this.stageStopFor = { batchId: batch.batchId, stage: number, requestId: swap.requestId };
          requestId = swap.requestId;
        }
      } catch { /* not found or not written yet: the next poll tries again */ }
    }
    return { requestId, stopCode: requestId ? await this.stopOutcome(requestId) : null };
  }

  // DESIGN §26: the pump of a running scanner-issuer stage is dead (signal A) or its companion's heartbeat stopped (signal D),
  // and the stage still runs after the grace: it is asked to stop through its own stop path. Never 80-owner-abort, never the
  // abort flag (a stage asked so is still invoked as usual), never a kill. Idempotent, like requestStop.
  async bridgeStop(batch, number) {
    return this.stageStop(batch, number);
  }

  // What the pump observer of this batch's running stage has seen (DESIGN §26), for the executor's receipts; null otherwise.
  bridgeState(batch, number) {
    const b = this.bridge;
    if (!b || b.batchId !== batch?.batchId || b.stage !== number) return null;
    return { pumpCode: b.state.pumpCode, stopRequestId: b.state.stop?.requestId ?? null, stopCode: b.state.stop?.stopCode ?? null };
  }

  // The pump observer (DESIGN §26), while a scanner-issuer stage runs: the stage's relay-stage answer and the companion's
  // heartbeat, every BRIDGE_POLL_MS.
  //   A: the pump answered with a PUMP_DEAD_CODES code (an answer outside PUMP_CODES counts as COMPANION_PUMP_UNCONFIRMED);
  //   D: no answer, and no heartbeat newer than PUMP_HEARTBEAT_STALE_MS (counted from the stage's start at the earliest): first
  //      the pump's cancel (heartbeat-lost) is written, so a companion restarted by its scheduled task answers
  //      COMPANION_PUMP_CANCELLED instead of running a second pump; only once it is written is D taken.
  // BRIDGE_STOP_GRACE_MS after A or D, with the stage still running, bridgeStop() on every poll until the broker's receipt is
  // read. Only mailbox and broker files: the service runner is busy with the stage, and nothing here runs a process.
  observePump(batch, number, relay) {
    const mb = this.companionMailbox;
    const state = { answer: null, pumpCode: null, lostAt: null, stop: null };
    if (!ABORTABLE_IN_FLIGHT.includes(number) || typeof mb?.poll !== 'function' || typeof mb.heartbeat !== 'function') return { state, stop: async () => {} };
    this.bridge = { batchId: batch.batchId, stage: number, state };
    let stopped = false, wake;
    const stopSignal = new Promise(resolve => { wake = resolve; });
    let beatAt = this.clock();
    const running = (async () => {
      let request;
      try { request = await relay; } catch { return; }
      while (!stopped) {
        try {
          if (state.answer === null) state.answer = (await mb.poll(request)) ?? null;
          if (state.lostAt === null) {
            const a = state.answer;
            if (a && a.ok !== true) {
              const code = PUMP_CODES.includes(a.code) ? a.code : 'COMPANION_PUMP_UNCONFIRMED';
              if (PUMP_DEAD_CODES.includes(code)) Object.assign(state, { pumpCode: code, lostAt: this.clock() });
            } else if (!a) {
              let hb = null;
              try { hb = await mb.heartbeat(); } catch { hb = null; }
              if (Number.isSafeInteger(hb?.at) && hb.at > beatAt) beatAt = hb.at;
              if (this.clock() - beatAt > PUMP_HEARTBEAT_STALE_MS && typeof mb.cancel === 'function') {
                await mb.cancel(request, 'heartbeat-lost');
                Object.assign(state, { pumpCode: 'COMPANION_HEARTBEAT_LOST', lostAt: this.clock() });
              }
            }
          }
          if (state.lostAt !== null && this.clock() - state.lostAt >= BRIDGE_STOP_GRACE_MS && !(state.stop?.requestId && state.stop.stopCode)) {
            state.stop = await this.bridgeStop(batch, number);
          }
        } catch { /* a failed look is no signal; the next poll looks again */ }
        await Promise.race([this.sleep(BRIDGE_POLL_MS), stopSignal]);
        await new Promise(resolve => setImmediate(resolve)); // never a busy loop, whatever the sleep port does
      }
    })();
    return { state, stop: async () => { stopped = true; wake(); await running; } };
  }

  // The broker's create-only receipt of one stop request (SwapBroker.cs TryOwnerStop): its code, or null when there is
  // none yet or it does not read as exactly that receipt.
  async stopOutcome(requestId) {
    try {
      const file = path.join(this.paths.brokerRoot, 'responses', `${requestId}.stop.json`);
      if (!(await exists(file))) return null;
      const v = parseBoundedJson(await readBounded(file, 4096, 'BROKER_STOP_RECEIPT_REFUSED'), 4096, 'BROKER_STOP_RECEIPT_REFUSED');
      return v?.contract === BROKER_STOP_RECEIPT_CONTRACT && v.requestId === requestId && typeof v.code === 'string' && CODE.test(v.code) ? v.code : null;
    } catch { return null; }
  }

  stopRequested(batch, number) { return this.abortRequested?.batchId === batch.batchId && this.abortRequested.stage === number; }
  async requireV2(name) { const p = this.v2(name); try { await fs.access(p); } catch { fail('SOURCE_V2_REQUIRED'); } return p; }
  // Generation 12 (DESIGN §56.2): whether the installed Source knows the queue watch (role-probe-run/2, --watch-pr) on its whole path:
  // the Node job maker and validator (role-probe-run.mjs, which invoke-stage and the entry use) and the session-0 helper's own job check
  // (windows/FormalPublicBoundaryV2.cs). An older Source refuses the job, which would leave a role probe without a fact (a HALT), so the
  // executor watches only when both say yes. A definite answer (both read, or a file missing) is kept for the engine's life (the
  // installed Source does not change under a running service); a read that failed otherwise (a file held by an antivirus or a backup)
  // is no for now and read again after QUEUE_WATCH_SUPPORT_RETRY_MS (review round 33, MINOR 1).
  // ADR 0019: whether a batch of several PRs can run on this node, i.e. whether every installed component that reads a descriptor
  // takes /4: (1) the installed Source v2 (its build-bundle.ps1, which the companion runs, prepare-workspaces.py, which Linux root runs
  // from the same Source commit, and invoke-stage.mjs, which must take ':chain') carries BATCH_CHAIN_SOURCE_MARKERS; (2) the Linux side
  // runs this very generation: the versions view (status.mjs#versionsView, upgrade-mailbox.mjs#consistent) says the two sides are
  // consistent (same generation, Source and Linux manifest, pins ok, facts fresh) and the Linux side's Source is this one. The Linux
  // archive tool of the same generation takes /4 (clued-ci-resident-linux DESCRIPTOR_CHAIN_CONTRACT) and this engine writes it. Anything
  // that cannot be read, or no versions port, is no: stage 10 then composes one PR per batch (fail closed). It reads the build-bundle.ps1
  // under paths.sourceRoot: the companion's bundleScript points into the same <root>\source\<ciSourceManifestSha256>\ (companion.mjs
  // COMPANION_PATH_KEYS, DESIGN §33); a companion left on an older Source refuses /4 (DESCRIPTOR_REFUSED), never accepts it. The Source half is kept
  // like queueWatchSupported's (a definite answer for the engine's life, a failed read retried after QUEUE_WATCH_SUPPORT_RETRY_MS); the
  // versions half is read fresh every time.
  async batchChainSupported() {
    if (typeof this.versions !== 'function') return false;
    if (this.batchChainSourceKnown === undefined) {
      const now = typeof this.clock === 'function' ? this.clock() : Date.now();
      if (Number.isFinite(this.batchChainReadFailedAt) && now >= this.batchChainReadFailedAt && now - this.batchChainReadFailedAt < QUEUE_WATCH_SUPPORT_RETRY_MS) return false;
      try {
        let all = true;
        for (const [name, marker] of BATCH_CHAIN_SOURCE_MARKERS) if (!(await fs.readFile(this.v2(name), 'utf8')).includes(marker)) all = false;
        this.batchChainSourceKnown = all;
      } catch (error) {
        if (error?.code === 'ENOENT') this.batchChainSourceKnown = false;
        else { this.batchChainReadFailedAt = now; return false; }
      }
    }
    if (this.batchChainSourceKnown !== true) return false;
    let v = null;
    try { v = await this.versions(); } catch { return false; }
    return v?.consistent === true && /^[0-9a-f]{64}$/.test(v.windows?.ciSourceManifestSha256 ?? '') && v.linux?.ciSourceManifestSha256 === v.windows.ciSourceManifestSha256;
  }

  // The invoker's arguments for a stage: trainModeArgs, and for stage 10 in push mode with batchMax > 1 the ':chain' suffix when
  // batchChainSupported says yes (ADR 0019; without it stage 10 composes one PR per batch, as before).
  async stageArgs(number) {
    const args = this.trainModeArgs(number);
    if (number !== 10 || this.trainLanding?.landing !== 'push' || !(this.trainLanding.batchMax > 1)) return args;
    const i = args.indexOf('--train-landing');
    let chain = false;
    try { chain = i >= 0 && typeof args[i + 1] === 'string' && (await this.batchChainSupported()) === true; } catch { chain = false; }
    return chain ? [...args.slice(0, i + 1), `${args[i + 1]}${TRAIN_LANDING_CHAIN_SUFFIX}`, ...args.slice(i + 2)] : args;
  }

  async queueWatchSupported() {
    if (this.queueWatchKnown !== undefined) return this.queueWatchKnown;
    const now = typeof this.clock === 'function' ? this.clock() : Date.now();
    if (Number.isFinite(this.queueWatchReadFailedAt) && now >= this.queueWatchReadFailedAt && now - this.queueWatchReadFailedAt < QUEUE_WATCH_SUPPORT_RETRY_MS) return false;
    try {
      const js = await fs.readFile(this.v2('role-probe-run.mjs'), 'utf8'), cs = await fs.readFile(this.v2(path.join('windows', 'FormalPublicBoundaryV2.cs')), 'utf8');
      this.queueWatchKnown = js.includes("'clued.independent-ci.role-probe-run/2'") && cs.includes('RoleProbeRunV2="clued.independent-ci.role-probe-run/2"');
    } catch (error) {
      if (error?.code === 'ENOENT') this.queueWatchKnown = false;
      else { this.queueWatchReadFailedAt = now; return false; }
    }
    return this.queueWatchKnown;
  }

  async scReadback() {
    const qc = parseScQc((await this.run([this.paths.scExe, 'qc', this.node.runnerService], { timeoutMs: 15_000 })).stdout);
    const q = parseScQueryex((await this.run([this.paths.scExe, 'queryex', this.node.runnerService], { timeoutMs: 15_000 })).stdout);
    return originalStopped(qc, q, this.node);
  }

  // chain (ADR 0019, optional): chainOfFront's {members, testTree} of a front batch of several PRs; the descriptor is then /4.
  async derive(subject, key, chain = null) {
    const entry = await this.requireV2('derive-batch.mjs');
    const batchId = `${key.slice(0, 16)}-${randomBytes(6).toString('hex')}`;
    const out = path.join(this.paths.workRoot, batchId);
    // The jobs' createdAt (job contract v2) is the derivation time; it is not part of any id or key. A train front
    // batch's subject also names its tested commit S (step 3c-2), which joins the batch key on both sides.
    const v2 = { repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, sourceManifestSha256: subject.sourceManifestSha256,
      attempt: subject.attempt, createdAt: new Date(this.clock()).toISOString(), ...(Object.hasOwn(subject, 'testSha') ? { testSha: subject.testSha } : {}) };
    const r = await this.run([this.paths.nodeExe, entry, '--subject-json', JSON.stringify(v2), '--batch-key', key, '--batch-id', batchId, '--out', out], { timeoutMs: 10 * 60_000 });
    check(r.code === 0, 'RESIDENT_DERIVATION_REFUSED');
    const v = parseBoundedJson(Buffer.from(r.stdout, 'utf8'), 1024 * 1024, 'RESIDENT_DERIVATION_REFUSED');
    check(v.status === 'RESIDENT_BATCH_DERIVED' && v.batchKey === key && v.batchId === batchId && HEX64.test(v.packageSha256) && HEX64.test(v.ciSourceManifestSha256 ?? '')
      && /^[0-9a-f]{40}$/.test(v.sourceCommit ?? '') && HEX64.test(v.gitleaksTomlSha256 ?? '') && Array.isArray(v.stages) && v.stages.length === 8
      // the tested commit S: the head itself, or the train front batch's own S, as the derivation reports it
      && v.testSha === (Object.hasOwn(subject, 'testSha') ? subject.testSha : subject.headSha), 'RESIDENT_DERIVATION_REFUSED');
    const linuxJobIds = v.stages.filter(s => [2, 4, 6].includes(s.number)).map(s => s.jobId);
    check(linuxJobIds.length === 3 && linuxJobIds.every(j => HEX64.test(j)), 'RESIDENT_DERIVATION_REFUSED');
    // Public descriptor (/3, or /4 for a batch of several PRs) for the companion's bundle and ws-prep, and (through /mnt/c, read-only)
    // the Linux units: everything they re-derive job ids from, nothing they could execute.
    const c = chain === null ? null : chainOfFront(subject, { ...chain, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: v.testSha });
    check(chain === null || c !== null, 'RESIDENT_DERIVATION_REFUSED');
    const dir = path.join(this.paths.outboxRoot, batchId);
    await ensureDir(dir);
    await writeNew(path.join(dir, 'descriptor.json'), { contract: c ? DESCRIPTOR_CHAIN_CONTRACT : DESCRIPTOR_CONTRACT, batchId, batchKey: key, repo: subject.repo, pr: subject.pr,
      headSha: subject.headSha, baseSha: subject.baseSha, testSha: v.testSha, ...(c ? { testTree: c.testTree, members: c.members } : {}), attempt: subject.attempt,
      ciSourceManifestSha256: v.ciSourceManifestSha256, sourceCommit: v.sourceCommit, gitleaksTomlSha256: v.gitleaksTomlSha256, linuxJobIds, createdAt: v2.createdAt });
    return { batchId, key, dir: out, packageSha256: v.packageSha256, stages: v.stages, ciSourceManifestSha256: v.ciSourceManifestSha256 };
  }

  // Windows half of a protocol archive through the Source v2 handle-based tool (never Node path
  // renames on the Owner-writable spool, see archive.mjs header).
  // The answer carries `archiveCode` (DESIGN §33): null when the archive verified; otherwise the tool's own refusal code (it prints its
  // verdict with that code also when it exits 2), or the engine's own fixed code when the tool said none (windowsArchiveCode).
  async archiveWindows(batch, reason) {
    const tool = await this.requireV2('archive-windows-spool.ps1');
    const r = await this.run(powershellArgv(this.paths.powershellExe, '-File', tool, '-BatchKey', batch.key, '-Reason', reason, '-ExpectedNodeProfileSha256', this.nodeProfileSha256), { timeoutMs: 120_000 });
    let v = null;
    if (r.code === 0) v = parseBoundedJson(Buffer.from(r.stdout, 'utf8'), 65536, 'WINDOWS_ARCHIVE_UNCONFIRMED');
    else if (r.code !== null) { try { v = parseBoundedJson(Buffer.from(r.stdout ?? '', 'utf8'), 65536, 'WINDOWS_ARCHIVE_UNCONFIRMED'); } catch { v = null; } }
    const verified = r.code === 0 && v?.verified === true;
    return { verified, directory: typeof v?.directory === 'string' ? v.directory : null, moved: v?.moved ?? null, archiveCode: verified ? null : windowsArchiveCode(r, v) };
  }

  async archiveLinux(batch, reason) {
    const answer = await this.companionMailbox.await(await this.companionMailbox.send('archive-linux', { batchId: batch.batchId, reason }, ARCHIVE_LINUX_REQUEST_MS), this.sleep);
    return { verified: answer?.ok === true && answer.verified === true, directory: answer?.directory ?? null };
  }

  // Stage 10 (quota phase 2 step 3c-1, DESIGN §22.1): one train run outside any batch. Its package is derived into a
  // new work\train\<runId> directory (create-only), then it runs like any Windows-only stage. The run key and id are
  // fresh random values (the derivation checks their shape); the fact carries the train facts.
  // Step 3c-2b (train-run job /2, /3 since DESIGN §65, /4 since R3 batch 2 (frontFailed), INTERFACES §2): input is the resident's part of the job (train.mjs#trainRunInput: mode, the
  // installed train settings, onSince, frontOutcome, revokeHeadRequestId, sweep); everything but the mode goes as one JSON object in
  // --train-params (Source v2 train-run.mjs#TRAIN_RUN_PARAMS, in that order); the derivation adds the record's repo and Source,
  // the run id and createdAt (makeTrainRun). Modes on and revoke-only need it; a call without it is a shadow run of step
  // 3c-1's argv (which a /2 derivation refuses: the executor always passes it).
  async runTrainStage(mode, input = null) {
    let job = null;
    if (input !== null) { try { job = validateTrainRunInput(input); } catch { job = null; } }
    check(input === null ? mode === 'shadow' : job !== null && job.mode === mode && RUN_MODES.includes(mode), 'RESIDENT_TRAIN_MODE_INVALID');
    const params = job ? Object.fromEntries(TRAIN_RUN_INPUT_FIELDS.filter(k => k !== 'mode').map(k => [k, job[k]])) : null;
    const entry = await this.requireV2('derive-batch.mjs');
    const key = randomBytes(32).toString('hex');
    const runId = `${key.slice(0, 16)}-${randomBytes(6).toString('hex')}`;
    const root = path.join(this.paths.workRoot, 'train');
    await ensureDir(root);
    const out = path.join(root, runId);
    const d = await this.run([this.paths.nodeExe, entry, '--train-run', runId, '--train-key', key, '--mode', mode, ...(params ? ['--train-params', JSON.stringify(params)] : []), '--out', out],
      { timeoutMs: 5 * 60_000 });
    let row = null;
    if (d.code === 0) {
      const v = parseBoundedJson(Buffer.from(d.stdout, 'utf8'), 65536, 'RESIDENT_DERIVATION_REFUSED');
      if (v.status === 'RESIDENT_TRAIN_RUN_DERIVED' && v.runKey === key && v.runId === runId && v.mode === mode && v.stage?.number === 10
        && HEX64.test(v.stage.workManifestSha256 ?? '') && HEX64.test(v.stage.jobId ?? '') && Number.isSafeInteger(v.stage.runMilliseconds)) row = v.stage;
    }
    // Nothing was requested from the broker yet: a refused derivation is a clean stage-10 refusal.
    if (!row) return { ok: false, code: 'TRAIN_STAGE_REFUSED', proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() }, train: null, runId };
    return { ...(await this.invoke({ batchId: runId, key, dir: out }, { number: 10, runMilliseconds: row.runMilliseconds, linuxWorker: false }, row)), runId };
  }

  // C2 never derives a PR/batch, starts Linux or contacts the companion. The installed invoker creates
  // one stage-11 plan and asks the same serialized broker; independent SCM readback remains mandatory.
  // watchPr (generation 12, DESIGN §56.2): the queue watch's PR; the intent is then /2 and the invoker gets --watch-pr.
  async runRoleProbe({ watchPr = null } = {}) {
    const entry = await this.requireV2('invoke-stage.mjs');
    const runKey = randomBytes(32).toString('hex'), runId = `${runKey.slice(0, 16)}-${randomBytes(6).toString('hex')}`;
    const watch = Number.isSafeInteger(watchPr) && watchPr > 0 && watchPr < 10_000_000_000 ? watchPr : null;
    const manifest = sha256(Buffer.from(canonicalJson(watch === null
      ? { contract: 'clued.independent-ci.role-probe-intent/1', runKey, runId, nodeProfileSha256: this.nodeProfileSha256 }
      : { contract: 'clued.independent-ci.role-probe-intent/2', runKey, runId, nodeProfileSha256: this.nodeProfileSha256, watchPr: watch })));
    if (this.busy?.() === true || this.inflight) return { ok: false, code: 'ROLE_PROBE_BUSY', deferred: true, proof: null, roleProbe: null };
    // A live original runner is not ours to stop: do not even request a swap.
    if (!(await this.scReadback())) return { ok: false, code: 'ROLE_PROBE_BUSY', deferred: true, proof: null, roleProbe: null };
    const r = await this.run([this.paths.nodeExe, entry, '--role-probe', runKey, '--probe-id', runId, '--node-profile-sha256', this.nodeProfileSha256,
      ...(watch === null ? [] : ['--watch-pr', String(watch)])], { timeoutMs: 420_000 });
    if (r.timedOut || r.code === null) return { ok: false, code: 'STAGE_INVOKER_TERMINAL_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: false }, roleProbe: null };
    const fact = parseStageFact(r.stdout, manifest), stopped = await this.scReadback();
    return { ...fact, proof: { ...fact.proof, serviceOriginalStopped: fact.proof.serviceOriginalStopped && stopped }, runId };
  }

  async revocationMaintenanceQualification() {
    try {
      const entry=await this.requireV2('invoke-stage.mjs');
      const r=await this.run([this.paths.nodeExe,entry,'--revocation-maintenance-qualification','--node-profile-sha256',this.nodeProfileSha256],{timeoutMs:15_000});
      if(r.code!==0||r.timedOut)return null;
      const reply=parseBoundedJson(Buffer.from(r.stdout,'utf8'),16384,'REVOCATION_QUALIFICATION_REFUSED');
      if(reply.qualified!==true||!HEX64.test(reply.sourceManifestSha256??''))return null;
      return validateRevocationQualification(reply.qualification,{sourceManifestSha256:reply.sourceManifestSha256,now:this.clock()});
    }catch{return null;}
  }

  // Intent key/id belong to the executor's durable receipt, not to a PR or a
  // batch. A busy helper or live runner is never stopped by this method.
  async runRevocationMaintenance({runKey,runId}) {
    check(HEX64.test(runKey??'')&&REVOCATION_RUN_ID.test(runId??'')&&runId.startsWith(runKey.slice(0,16)),'REVOCATION_RUN_REFUSED');
    if(this.busy?.()===true||this.inflight)return {ok:false,code:'REVOCATION_MAINTENANCE_BUSY',deferred:true,proof:null};
    if(!(await this.revocationMaintenanceQualification()))return {ok:false,code:'REVOCATION_MAINTENANCE_NOT_QUALIFIED',deferred:true,proof:null};
    if(!(await this.scReadback()))return {ok:false,code:'REVOCATION_MAINTENANCE_BUSY',deferred:true,proof:null};
    const entry=await this.requireV2('invoke-stage.mjs');
    const manifest=sha256(Buffer.from(canonicalJson({contract:'clued.independent-ci.revocation-maintenance-intent/1',runKey,runId,nodeProfileSha256:this.nodeProfileSha256})));
    const r=await this.run([this.paths.nodeExe,entry,'--revocation-maintenance','--run-key',runKey,'--run-id',runId,
      '--node-profile-sha256',this.nodeProfileSha256],{timeoutMs:REVOCATION_RUN_MS+360_000});
    if(r.timedOut||r.code===null)return {ok:false,code:'STAGE_INVOKER_TERMINAL_UNCONFIRMED',proof:{windowsTreeZero:false,serviceOriginalStopped:false},runId};
    const fact=parseStageFact(r.stdout,manifest),stopped=await this.scReadback();
    return {...fact,ok:fact.ok&&stopped,proof:{...fact.proof,serviceOriginalStopped:fact.proof.serviceOriginalStopped&&stopped},runId};
  }

  // opts.betweenRoles: archive the previous local Linux role's protocol records first (stages 4 and 6
  //   only, the protocol-only Linux scopes); opts.firstLinux: the "no push since the bundle" gate before
  //   the first local scanner stage. Without opts the fixed v0.6 order applies (4/6 archive, 2 gate).
  async runStage(batch, stage, opts = null) {
    const row = batch.stages[stage.number - 1];
    check(row && row.number === stage.number && HEX64.test(row.workManifestSha256) && HEX64.test(row.jobId), 'RESIDENT_STAGE_ROW_INVALID');
    const betweenRoles = opts ? opts.betweenRoles === true : [4, 6].includes(stage.number);
    const firstLinux = opts ? opts.firstLinux === true : stage.number === 2;
    check(!betweenRoles || [4, 6].includes(stage.number), 'RESIDENT_BETWEEN_ROLES_STAGE_INVALID');
    check(!firstLinux || [2, 4, 6].includes(stage.number), 'RESIDENT_FIRST_LINUX_STAGE_INVALID');
    // DESIGN 54 (stage 2: DESIGN 59): a run again of an execution stage in the same batch (1 or 2). It never archives between roles (the retry-stage archive
    // took the run's records); the batch's first Linux stage keeps its refs gate and version check (firstLinux) on a run again too.
    const again = opts?.again ?? 0;
    check(again === 0 || (EXECUTION_RETRY_STAGES.includes(stage.number) && [1, 2].includes(again) && !betweenRoles), 'RESIDENT_STAGE_AGAIN_INVALID');
    // Before the second and third Linux role, archive the previous role's protocol records on both
    // hosts, exactly as run-batch.ps1:81 does today; otherwise a stale issue.ready would be relayed.
    if (betweenRoles) {
      const reason = `between-roles-${stage.number}`;
      const w = await this.archiveWindows(batch, reason);
      const l = await this.archiveLinux(batch, reason);
      if (w.verified !== true || l.verified !== true) return { ok: false, code: 'BETWEEN_ROLES_ARCHIVE_UNCONFIRMED', proof: {} };
    }
    // DESIGN §34 (in-place upgrade channel): the first Linux stage runs only while the two sides do not disagree on their versions.
    // versions (optional port) -> status.mjs view; consistent false is UPGRADE_VERSION_SKEW, a clean refusal before anything of the
    // stage ran (Windows proof only; the failure path adds Linux quiescence). Unknown (null) or no port: the stage runs as before
    // (the executor's version-skew hold already keeps new batches from starting while they disagree).
    if (firstLinux && typeof this.versions === 'function') {
      let consistent = null;
      try { consistent = (await this.versions())?.consistent ?? null; } catch { consistent = null; }
      if (consistent === false) return { ok: false, code: 'UPGRADE_VERSION_SKEW', proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() } };
    }
    // Lesson b29: no push between the bundle and the first scanner stage. A moved ref is a clean,
    // transient refusal before anything ran (eligible for the automatic attempt 2).
    if (firstLinux) {
      const askRefs = async () => this.companionMailbox.await(await this.companionMailbox.send('check-refs', { batchId: batch.batchId }, CHECK_REFS_REQUEST_MS), this.sleep);
      let refs = await askRefs();
      // What the gate did (DESIGN 55), carried with the stage's result for its receipt: how often it asked, and why it stopped asking
      // before the line answered (the executor's check: halt, drift, authority), never both a refusal and the line.
      const gate = { asks: 1, waitRefused: null };
      const aborted = async () => ({ ok: false, code: 'OWNER_ABORT_REQUESTED', proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() }, refsGate: gate });
      for (let again = 0; again < REFS_GATE_RETRY_MS.length && refs?.ok !== true && refs?.code === 'REMOTE_REFS_NO_ANSWER'; again++) {
        if (this.stopRequested(batch, stage.number)) return aborted();
        await this.gateSleep(REFS_GATE_RETRY_MS[again]);
        if (this.stopRequested(batch, stage.number)) return aborted();
        if (typeof opts?.stillAllowed === 'function') {
          let verdict;
          try { verdict = await opts.stillAllowed(); } catch { verdict = 'error'; }
          if (verdict !== true) { gate.waitRefused = typeof verdict === 'string' && /^[a-z-]{1,20}$/.test(verdict) ? verdict : 'refused'; break; }
        }
        refs = await askRefs();
        gate.asks += 1;
      }
      if (refs?.ok !== true) {
        // Only an explicit "refs moved" answer is the transient REMOTE_REFS_CHANGED_SINCE_BUNDLE; no answer or
        // anything else is REFS_GATE_UNCONFIRMED, clean but final: never an attempt-2 code (PR-A review MINOR 5).
        const code = refs?.code === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' ? 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' : 'REFS_GATE_UNCONFIRMED';
        // Generation 11 (MINOR-9): the line and nothing else is told to the breaker as a network ending (classify.mjs#networkFailure).
        return { ok: false, code, proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() }, refsGate: gate,
          ...(refs?.code === 'REMOTE_REFS_NO_ANSWER' && gate.waitRefused === null ? { refsNoAnswer: true } : {}) };
      }
      if (gate.asks > 1) return { ...(await this.invoke(batch, again ? { ...stage, again } : stage, row)), refsGate: gate };
    }
    return this.invoke(batch, again ? { ...stage, again } : stage, row);
  }

  // The pre-stage memory gate (DESIGN §32). { checks, order, blocks, low, ready, waitedMs, refused }: ready true (a reading at or
  // above the threshold), false (refused: a low reading and none ready within the bound, or an Owner abort while waiting) or null
  // (no reading could be had and none was low: the stage runs as before). Never more than MEMORY_GATE_CHECKS reads, never longer
  // than MEMORY_GATE_WAIT_MS plus one read; a read that fails is only "no reading", never a refusal or a HALT by itself.
  async memoryGate(batch, number) {
    const started = this.clock();
    const gate = { checks: 0, order: null, blocks: null, low: false, ready: null, waitedMs: 0, refused: false };
    const end = ready => Object.assign(gate, { ready, refused: ready === false, waitedMs: this.clock() - started });
    for (;;) {
      gate.checks += 1;
      let answer = null;
      try { answer = await this.companionMailbox.await(await this.companionMailbox.send('memory-ready', { batchId: batch.batchId }, MEMORY_READ_TIMEOUT_MS), this.sleep); } catch { answer = null; }
      const m = answer?.ok === true ? memoryFacts(answer.memory) : null;
      if (m) Object.assign(gate, { order: m.order, blocks: m.blocks });
      if (m && m.blocks >= MEMORY_GATE_MIN_BLOCKS) return end(true);
      if (m) gate.low = true;
      if (!gate.low) return end(null);
      if (gate.checks >= MEMORY_GATE_CHECKS || this.clock() - started >= MEMORY_GATE_WAIT_MS || this.stopRequested(batch, number)) return end(false);
      await this.gateSleep(MEMORY_GATE_POLL_MS);
      // An Owner abort asked while the gate slept is seen at once, before another wsl.exe read (review n1 of the C3 fixes).
      if (this.stopRequested(batch, number)) return end(false);
    }
  }

  // The gate's sleep between two reads: it ends early when an Owner abort is asked (requestStop wakes it), so an abort is not seen
  // up to MEMORY_GATE_POLL_MS late. The timer itself is left to run out.
  async gateSleep(ms) {
    let wake;
    const woken = new Promise(resolve => { wake = resolve; });
    this.gateWake = wake;
    try { await Promise.race([this.sleep(ms), woken]); } finally { if (this.gateWake === wake) this.gateWake = null; }
  }

  async invoke(batch, stage, row) {
    const invoke = await this.requireV2('invoke-stage.mjs');
    // Owner abort: a stage asked to stop before it was invoked is never invoked (nothing ran, the runner is untouched).
    if (this.stopRequested(batch, stage.number)) return { ok: false, code: 'OWNER_ABORT_REQUESTED', proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() } };
    if (!stage.linuxWorker) return this.invokeStage(batch, stage, row, invoke);
    // DESIGN §32: a scanner stage is invoked only on a memory reading that is not low (or on none at all); its facts travel with
    // the result. Refused: nothing of the stage ran, no issue exists, no pump was asked for.
    const memoryGate = await this.memoryGate(batch, stage.number);
    if (this.stopRequested(batch, stage.number)) return { ok: false, code: 'OWNER_ABORT_REQUESTED', proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() }, memoryGate };
    if (memoryGate.refused) return { ok: false, code: LINUX_MEMORY_NOT_READY, proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() }, memoryGate };
    return { ...(await this.invokeStage(batch, stage, row, invoke)), memoryGate };
  }

  async invokeStage(batch, stage, row, invoke) {
    // Generation 11 (DESIGN 54, review B2): a stage run again in the same batch is a new swap; the stop remembered for the run before
    // (stageStop) is not this run's, so it is forgotten here and a stop of this run finds and writes its own.
    if (this.stageStopFor?.batchId === batch.batchId && this.stageStopFor.stage === stage.number) this.stageStopFor = null;
    const relay = stage.linuxWorker
      ? this.companionMailbox.send('relay-stage', { batchId: batch.batchId, stage: stage.number, jobId: row.jobId, ...(stage.again ? { again: stage.again } : {}) }, stage.runMilliseconds + 120_000)
      : null;
    this.inflight = relay ? { batchId: batch.batchId, stage: stage.number, request: relay } : null;
    // DESIGN §26: while a scanner-issuer stage runs, its pump and the companion's heartbeat are watched (and the stage is
    // stopped through its own stop path when the pump is lost), next to the stage, never blocking it.
    const observer = relay ? this.observePump(batch, stage.number, relay) : null;
    try {
      let r;
      try {
        r = await this.run([this.paths.nodeExe, invoke, '--batch-dir', batch.dir, '--stage', String(stage.number), '--work-manifest-sha256', row.workManifestSha256,
          '--batch-key', batch.key, ...(await this.stageArgs(stage.number))], { timeoutMs: stage.runMilliseconds + 360_000 });
      } finally {
        await observer?.stop();
      }
      if (r.timedOut || r.code === null) return { ok: false, code: 'STAGE_INVOKER_TERMINAL_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: false } };
      // The invoke-stage child has returned with a stage fact: the broker answered (whatever its code), the invoker refused
      // the stage before asking the broker, or it gave up waiting for the answer (past the broker's and the pump's own
      // deadlines). In every case the issuer no longer waits for the pump, which from here on can only make the stage
      // wait (requestStop).
      if (this.inflight) this.inflight.windowsEnded = true;
      const fact = parseStageFact(r.stdout, row.workManifestSha256);
      const scOk = await this.scReadback();
      const proof = { ...fact.proof, serviceOriginalStopped: fact.proof.serviceOriginalStopped && scOk };
      let bridge = null, relayTiming = null;
      if (relay) {
        const request = await relay;
        const seen = observer.state;
        // An Owner abort of this stage wins over everything the bridge did: its own path cancels the pump and decides.
        const ownerAbort = this.stopRequested(batch, stage.number);
        const heartbeatLost = seen.pumpCode === 'COMPANION_HEARTBEAT_LOST';
        let answer = seen.answer;
        if (!answer) {
          if (heartbeatLost) {
            // The companion is taken for dead (its pump is cancelled already): one look, no wait.
            try { answer = (await this.companionMailbox.poll(request)) ?? null; } catch { answer = null; }
          } else if (fact.ok || ownerAbort) {
            answer = await this.companionMailbox.await(request, this.sleep);
          } else {
            // Pump quiet (DESIGN §26, c18eac1d generalised): the stage ended without success while its pump still runs. The
            // pump is cancelled (stage-ended) and its answer awaited at most PUMP_QUIET_MS: one relay call it may be inside,
            // plus the job host's margin. No answer by then: the pump is not quiet, and nothing is decided on it.
            try { await this.companionMailbox.cancel?.(request, 'stage-ended'); } catch { /* the bounded wait still runs */ }
            const deadline = Date.parse(request.deadline);
            const until = Math.min(Number.isFinite(deadline) ? deadline : Infinity, this.clock() + PUMP_QUIET_MS);
            answer = await this.companionMailbox.await({ ...request, deadline: new Date(until).toISOString() }, this.sleep);
          }
        }
        const stopRequestId = seen.stop?.requestId ?? null;
        let stopCode = seen.stop?.stopCode ?? null;
        if (stopRequestId) stopCode = (await this.stopOutcome(stopRequestId)) ?? stopCode;
        // The companion's relay times of this pump (status /8, a view): read once the pump has answered; absent or unreadable is null.
        if (answer && typeof this.companionMailbox.timing === 'function') { try { relayTiming = (await this.companionMailbox.timing(request)) ?? null; } catch { relayTiming = null; } }
        const answerCode = answer && answer.ok !== true ? (PUMP_CODES.includes(answer.code) ? answer.code : 'COMPANION_PUMP_UNCONFIRMED') : null;
        // The bridge facts the executor records with the stage (stage-terminal) and decides an abandonment on (DESIGN §27).
        bridge = { pumpCode: seen.pumpCode ?? answerCode, stopRequestId, stopCode, stageCode: fact.ok ? null : (fact.code ?? 'STAGE_TERMINAL_UNCONFIRMED'), pumpQuiet: !!answer };
        // The Windows stage succeeded but the companion did not confirm the pump: take only an allow-listed pump
        // code (none of them transient), never a free-form one (PR-A review MINOR 6). That ending is the pump's, not
        // the entry's: no outcome travels with it.
        if (fact.ok && answer?.ok !== true) return { ok: false, code: heartbeatLost ? 'COMPANION_HEARTBEAT_LOST' : (answerCode ?? 'COMPANION_PUMP_UNCONFIRMED'), proof, outcome: null, brokerNoLaunch: false, bridge };
        // The bridge stop ended the stage: the broker sent the stop (its receipt says STOP_SENT) and the helper's tree is
        // drained (stage-fact.mjs tree facts), and the issuer bound no outcome (a stopped stage reads STAGE_OUTCOME_MISSING).
        // A bound outcome keeps its own code whatever the stop did (r3 review MAJOR 1): a never-clean outcome code must not
        // become an abandonable ending, and a clean one must not be put through the quiescence proof.
        if (!fact.ok && !ownerAbort && stopRequestId && stopCode === 'STOP_SENT' && fact.proof.windowsTreeZero === true
          && fact.code === 'STAGE_OUTCOME_MISSING' && fact.outcome == null) {
          return { ok: false, code: BRIDGE_STAGE_STOPPED_PUMP_LOST, proof, factsSha256: fact.nativeReceiptSha256, outcome: null, brokerNoLaunch: false, bridge };
        }
      }
      const ok = fact.ok && scOk;
      // The stage outcome (diagnostic, scheduling facts, safeToRerun) travels to the executor (v0.6 §9 phase 1). The
      // broker's no-launch fact counts only with this engine's own sc.exe readback of the original, stopped runner.
      return { ok, code: ok ? null : (fact.code ?? 'SCM_READBACK_NOT_ORIGINAL'), proof, factsSha256: fact.nativeReceiptSha256,
        train: stage.number === 10 ? fact.train : null, outcome: fact.outcome, brokerNoLaunch: fact.brokerNoLaunch === true && scOk,
        ...(bridge ? { bridge } : {}), ...(relayTiming ? { relayTiming } : {}) };
    } finally {
      this.inflight = null;
      this.bridge = null;
    }
  }

  // Windows quiescence: SCM shows the original binary, Manual, STOPPED, pid 0 under clued-control,
  // and this service has no child process still running (the runner never kills; busy = unknown).
  async windowsQuiescence() {
    const scOk = await this.scReadback();
    const idle = this.busy() === false;
    return { windowsTreeZero: idle, serviceOriginalStopped: scOk };
  }

  // opts.linux false: no local Linux role ran (every heavy role relayed), so WSL is not touched at all.
  async closeBatch(batch, opts = null) {
    const w = await this.archiveWindows(batch, 'success-close');
    const l = opts?.linux === false ? { verified: true } : await this.archiveLinux(batch, 'success-close');
    return { verified: w.verified === true && l.verified === true, archived: w.moved, archiveCode: w.verified === true ? null : (w.archiveCode ?? null) };
  }

  async archiveFailure(batch, reason) {
    if (!batch) return { verified: true, directory: 'archive-nothing-derived' };
    return this.archiveWindows(batch, reason);
  }
}
