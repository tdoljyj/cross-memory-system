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
//   derive-batch.mjs --relay-roles --batch-dir --batch-key --batch-id -> RESIDENT_RELAY_STAGE_DERIVED (stage R)
//   invoke-stage.mjs --stage 9 -> stage fact /2 with the per-role relay rows (free-minutes design S19)
// Owner abort (DESIGN §6.5): requestStop() asks a running scanner-issuer stage to stop through its own stop path
// (a pump cancel for the companion and a broker stop request bound to the in-flight swap); nothing here kills.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CODE, HEX64, check, fail, parseBoundedJson, sha256 } from './canonical.mjs';
import { exists, readBounded, writeNew, ensureDir } from './store.mjs';
import { ABORTABLE_IN_FLIGHT } from './classify.mjs';

export const RUNNER_SERVICE = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02';
export const ORIGINAL_BINARY = '"C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"';
// /3 (quota phase 2 step 3b): also names the tested commit S (testSha); S = H until step 3c's train front batch.
export const DESCRIPTOR_CONTRACT = 'clued.independent-ci.resident-batch-descriptor/3';
// The codes the companion's bridge pump can end with (companion.mjs#pump); a stage's companion answer is taken
// only from this list, and none of them is an attempt-2 transient code.
export const PUMP_CODES = Object.freeze(['ACTUAL_ISSUE_NOT_PUBLISHED', 'ISSUE_TRANSFER_UNCONFIRMED', 'LINUX_WORKER_START_UNCONFIRMED', 'FORMAL_BRIDGE_STAGE_DEADLINE',
  'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED', 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED', 'FORMAL_WORKER_TERMINAL_UNCONFIRMED', 'RELAY_REFUSED_NO_RETRY',
  'COMPANION_PUMP_UNCONFIRMED', 'COMPANION_REQUEST_EXPIRED', 'COMPANION_HANDLER_UNCONFIRMED', 'COMPANION_PUMP_CANCELLED']);
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
  return {
    status: o.status, reason: o.reason, sideEffects: o.sideEffects, mayHavePublished: o.mayHavePublished,
    diagnostic: d ? { verdict: ENUM.test(d.verdict ?? '') ? d.verdict : 'UNKNOWN', nativeVerdict: ENUM.test(d.nativeVerdict ?? '') ? d.nativeVerdict : 'UNKNOWN',
      reasonCodes: codeList(d.reasonCodes), nativeReasonCodes: codeList(d.nativeReasonCodes), ciRetryAfter: isoOrNull(d.ciRetryAfter), mergeQueue: queueEntry(d.mergeQueue) } : null,
    scheduling: s ? { ciRetryAfter: isoOrNull(s.ciRetryAfter), mergeQueue: queueEntry(s.mergeQueue) } : null,
    // the flag holds only on a clean BLOCKED with zero side effects that may not have published
    safeToRerun: o.safeToRerun === true && o.status === 'BLOCKED' && o.sideEffects === 0 && o.mayHavePublished === false,
  };
}

export function parseStageFact(text, expectedManifestSha256) {
  const f = parseBoundedJson(Buffer.from(text, 'utf8'), 1024 * 1024, 'STAGE_FACT_REFUSED');
  if (f.contract !== undefined && f.contract !== STAGE_FACT_CONTRACT) return { ok: false, code: 'STAGE_TERMINAL_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: false }, nativeReceiptSha256: null, outcome: null, brokerNoLaunch: false };
  const restored = f.original_binary_restored === true && f.complete_original_readback === true;
  const treeZero = f.tree_cleanup_confirmed === true && f.tree_active_processes === 0 && f.root_exit_confirmed === true;
  const ok = f.state === 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION' && restored && treeZero
    && f.manifest_sha256 === expectedManifestSha256 && f.scm_start_call_issued === true && f.configuration_conflict_detected === false;
  const code = ok ? null : (typeof f.failure_code === 'string' && CODE.test(f.failure_code) ? f.failure_code : (typeof f.state === 'string' && CODE.test(f.state) ? f.state : 'STAGE_TERMINAL_UNCONFIRMED'));
  // Stage R only: the relay rows as the Source wrote them; the executor validates them (classify.mjs).
  const relay = Array.isArray(f.relay) ? f.relay : null;
  // The broker refused before any start and re-read the original (stage-fact.mjs BROKER_NO_LAUNCH_CODES): one of the
  // two ways a stage-1 failure may be released (classify.mjs#decideFailure); only with the fact's own readback.
  const brokerNoLaunch = !ok && f.broker_no_launch === true && f.scm_start_call_issued === false && restored && treeZero && f.configuration_conflict_detected === false;
  return { ok, code, proof: { windowsTreeZero: treeZero, serviceOriginalStopped: restored }, nativeReceiptSha256: HEX64.test(f.native_receipt_sha256 ?? '') ? f.native_receipt_sha256 : null, relay,
    outcome: parseStageOutcome(f.outcome), brokerNoLaunch };
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
export const originalStopped = (qc, q) => qc.binary === ORIGINAL_BINARY && qc.startType === 3 && /^(\.|TURING)\\clued-control$/i.test(qc.account ?? '') && q.state === 1 && q.pid === 0;

export class WindowsEngine {
  // ports: { run (Runner.run), busy() (Runner.busy), companionMailbox, sleep, clock,
  //          paths: { sourceRoot, workRoot, outboxRoot, nodeExe, powershellExe, scExe } }
  constructor(ports) { Object.assign(this, ports); }

  v2(name) { return path.join(this.paths.sourceRoot, ...V2, name); }

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
    const mine = s => s && s.batchId === batch.batchId && s.stage === number;
    const out = { broker: false, requestId: mine(this.abortStop) ? this.abortStop.requestId : null, stopCode: null, pump: false, done: false };
    if (!out.requestId) {
      try {
        const swap = await findInflightSwap(this.paths.brokerRoot, number, await this.stagePlanSha256(batch, number));
        if (swap) {
          try {
            await writeNew(path.join(this.paths.brokerRoot, 'requests', `${swap.requestId}.stop`), { contract: BROKER_STOP_CONTRACT, ...swap });
          } catch (error) {
            if (error.code !== 'CREATE_ONLY_TARGET_EXISTS') throw error;
          }
          // Remembered: once the broker answers the swap it is no longer "in flight", but its stop receipt stays readable.
          this.abortStop = { batchId: batch.batchId, stage: number, requestId: swap.requestId };
          out.requestId = swap.requestId;
        }
      } catch { /* not found or not written yet: the next poll tries again */ }
    }
    out.broker = out.requestId !== null;
    if (out.requestId) out.stopCode = await this.stopOutcome(out.requestId);
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

  async scReadback() {
    const qc = parseScQc((await this.run([this.paths.scExe, 'qc', RUNNER_SERVICE], { timeoutMs: 15_000 })).stdout);
    const q = parseScQueryex((await this.run([this.paths.scExe, 'queryex', RUNNER_SERVICE], { timeoutMs: 15_000 })).stdout);
    return originalStopped(qc, q);
  }

  async derive(subject, key) {
    const entry = await this.requireV2('derive-batch.mjs');
    const batchId = `${key.slice(0, 16)}-${randomBytes(6).toString('hex')}`;
    const out = path.join(this.paths.workRoot, batchId);
    // The jobs' createdAt (job contract v2) is the derivation time; it is not part of any id or key.
    const v2 = { repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, sourceManifestSha256: subject.sourceManifestSha256,
      attempt: subject.attempt, createdAt: new Date(this.clock()).toISOString() };
    const r = await this.run([this.paths.nodeExe, entry, '--subject-json', JSON.stringify(v2), '--batch-key', key, '--batch-id', batchId, '--out', out], { timeoutMs: 10 * 60_000 });
    check(r.code === 0, 'RESIDENT_DERIVATION_REFUSED');
    const v = parseBoundedJson(Buffer.from(r.stdout, 'utf8'), 1024 * 1024, 'RESIDENT_DERIVATION_REFUSED');
    check(v.status === 'RESIDENT_BATCH_DERIVED' && v.batchKey === key && v.batchId === batchId && HEX64.test(v.packageSha256) && HEX64.test(v.ciSourceManifestSha256 ?? '')
      && /^[0-9a-f]{40}$/.test(v.sourceCommit ?? '') && HEX64.test(v.gitleaksTomlSha256 ?? '') && Array.isArray(v.stages) && v.stages.length === 8
      // the tested commit S comes from the derivation alone; until step 3c it is the head itself
      && v.testSha === subject.headSha, 'RESIDENT_DERIVATION_REFUSED');
    const linuxJobIds = v.stages.filter(s => [2, 4, 6].includes(s.number)).map(s => s.jobId);
    check(linuxJobIds.length === 3 && linuxJobIds.every(j => HEX64.test(j)), 'RESIDENT_DERIVATION_REFUSED');
    // Public descriptor (/3) for the companion's bundle and ws-prep, and (through /mnt/c, read-only) the
    // Linux units: everything they re-derive job ids from, nothing they could execute.
    const dir = path.join(this.paths.outboxRoot, batchId);
    await ensureDir(dir);
    await writeNew(path.join(dir, 'descriptor.json'), { contract: DESCRIPTOR_CONTRACT, batchId, batchKey: key, repo: subject.repo, pr: subject.pr,
      headSha: subject.headSha, baseSha: subject.baseSha, testSha: v.testSha, attempt: subject.attempt, ciSourceManifestSha256: v.ciSourceManifestSha256, sourceCommit: v.sourceCommit,
      gitleaksTomlSha256: v.gitleaksTomlSha256, linuxJobIds, createdAt: v2.createdAt });
    return { batchId, key, dir: out, packageSha256: v.packageSha256, stages: v.stages, ciSourceManifestSha256: v.ciSourceManifestSha256 };
  }

  // Windows half of a protocol archive through the Source v2 handle-based tool (never Node path
  // renames on the Owner-writable spool, see archive.mjs header).
  async archiveWindows(batch, reason) {
    const tool = await this.requireV2('archive-windows-spool.ps1');
    const r = await this.run([this.paths.powershellExe, '-NoProfile', '-NonInteractive', '-File', tool, '-BatchKey', batch.key, '-Reason', reason], { timeoutMs: 120_000 });
    const v = r.code === 0 ? parseBoundedJson(Buffer.from(r.stdout, 'utf8'), 65536, 'WINDOWS_ARCHIVE_UNCONFIRMED') : null;
    return { verified: v?.verified === true, directory: typeof v?.directory === 'string' ? v.directory : null, moved: v?.moved ?? null };
  }

  async archiveLinux(batch, reason) {
    const answer = await this.companionMailbox.await(await this.companionMailbox.send('archive-linux', { batchId: batch.batchId, reason }, 6 * 60_000), this.sleep);
    return { verified: answer?.ok === true && answer.verified === true, directory: answer?.directory ?? null };
  }

  // Stage R: derive its package for exactly the relay candidates (create-only, next to the batch), then run
  // it like any stage (no Linux, no bridge pump). The fact carries the per-role rows.
  async runRelayStage(batch, roles) {
    check(Array.isArray(roles) && roles.length > 0 && roles.every(r => ['gitleaks', 'trivy'].includes(r)), 'RESIDENT_RELAY_ROLES_INVALID');
    const entry = await this.requireV2('derive-batch.mjs');
    const d = await this.run([this.paths.nodeExe, entry, '--relay-roles', roles.join(','), '--batch-dir', batch.dir, '--batch-key', batch.key, '--batch-id', batch.batchId], { timeoutMs: 5 * 60_000 });
    let row = null;
    if (d.code === 0) {
      const v = parseBoundedJson(Buffer.from(d.stdout, 'utf8'), 65536, 'RESIDENT_DERIVATION_REFUSED');
      if (v.status === 'RESIDENT_RELAY_STAGE_DERIVED' && v.batchKey === batch.key && v.batchId === batch.batchId && v.stage?.number === 9
        && HEX64.test(v.stage.workManifestSha256 ?? '') && Array.isArray(v.stage.jobIds) && v.stage.jobIds.length === roles.length && v.stage.jobIds.every(j => HEX64.test(j))) row = v.stage;
    }
    // Nothing was requested from the broker yet: a refused derivation is a clean stage-R refusal.
    if (!row) return { ok: false, code: 'RELAY_STAGE_REFUSED', proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() }, relay: null };
    batch.relayRow = row;
    return this.invoke(batch, { number: 9, runMilliseconds: row.runMilliseconds, linuxWorker: false }, row);
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
    // Before the second and third Linux role, archive the previous role's protocol records on both
    // hosts, exactly as run-batch.ps1:81 does today; otherwise a stale issue.ready would be relayed.
    if (betweenRoles) {
      const reason = `between-roles-${stage.number}`;
      const w = await this.archiveWindows(batch, reason);
      const l = await this.archiveLinux(batch, reason);
      if (w.verified !== true || l.verified !== true) return { ok: false, code: 'BETWEEN_ROLES_ARCHIVE_UNCONFIRMED', proof: {} };
    }
    // Lesson b29: no push between the bundle and the first scanner stage. A moved ref is a clean,
    // transient refusal before anything ran (eligible for the automatic attempt 2).
    if (firstLinux) {
      const refs = await this.companionMailbox.await(await this.companionMailbox.send('check-refs', { batchId: batch.batchId }, 6 * 60_000), this.sleep);
      if (refs?.ok !== true) {
        // Only an explicit "refs moved" answer is the transient REMOTE_REFS_CHANGED_SINCE_BUNDLE; no answer or
        // anything else is REFS_GATE_UNCONFIRMED, clean but final: never an attempt-2 code (PR-A review MINOR 5).
        const code = refs?.code === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' ? 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' : 'REFS_GATE_UNCONFIRMED';
        return { ok: false, code, proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() } };
      }
    }
    return this.invoke(batch, stage, row);
  }

  async invoke(batch, stage, row) {
    const invoke = await this.requireV2('invoke-stage.mjs');
    // Owner abort: a stage asked to stop before it was invoked is never invoked (nothing ran, the runner is untouched).
    if (this.stopRequested(batch, stage.number)) return { ok: false, code: 'OWNER_ABORT_REQUESTED', proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() } };
    const relay = stage.linuxWorker
      ? this.companionMailbox.send('relay-stage', { batchId: batch.batchId, stage: stage.number, jobId: row.jobId }, stage.runMilliseconds + 120_000)
      : null;
    this.inflight = relay ? { batchId: batch.batchId, stage: stage.number, request: relay } : null;
    try {
      const r = await this.run([this.paths.nodeExe, invoke, '--batch-dir', batch.dir, '--stage', String(stage.number), '--work-manifest-sha256', row.workManifestSha256,
        '--batch-key', batch.key], { timeoutMs: stage.runMilliseconds + 360_000 });
      if (r.timedOut || r.code === null) return { ok: false, code: 'STAGE_INVOKER_TERMINAL_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: false } };
      // The invoke-stage child has returned with a stage fact: the broker answered (whatever its code), the invoker refused
      // the stage before asking the broker, or it gave up waiting for the answer (past the broker's and the pump's own
      // deadlines). In every case the issuer no longer waits for the pump, which from here on can only make the stage
      // wait (requestStop).
      if (this.inflight) this.inflight.windowsEnded = true;
      const fact = parseStageFact(r.stdout, row.workManifestSha256);
      const scOk = await this.scReadback();
      if (relay) {
        const answer = await this.companionMailbox.await(await relay, this.sleep);
        // The Windows stage succeeded but the companion did not confirm the pump: take only an allow-listed pump
        // code (none of them transient), never a free-form one (PR-A review MINOR 6). That ending is the pump's, not
        // the entry's: no outcome travels with it.
        if (fact.ok && answer?.ok !== true) return { ok: false, code: PUMP_CODES.includes(answer?.code) ? answer.code : 'COMPANION_PUMP_UNCONFIRMED', proof: { ...fact.proof, serviceOriginalStopped: fact.proof.serviceOriginalStopped && scOk }, outcome: null, brokerNoLaunch: false };
      }
      const ok = fact.ok && scOk;
      // The stage outcome (diagnostic, scheduling facts, safeToRerun) travels to the executor (v0.6 §9 phase 1). The
      // broker's no-launch fact counts only with this engine's own sc.exe readback of the original, stopped runner.
      return { ok, code: ok ? null : (fact.code ?? 'SCM_READBACK_NOT_ORIGINAL'), proof: { ...fact.proof, serviceOriginalStopped: fact.proof.serviceOriginalStopped && scOk }, factsSha256: fact.nativeReceiptSha256,
        relay: stage.number === 9 ? fact.relay : null, outcome: fact.outcome, brokerNoLaunch: fact.brokerNoLaunch === true && scOk };
    } finally {
      this.inflight = null;
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
    return { verified: w.verified === true && l.verified === true, archived: w.moved };
  }

  async archiveFailure(batch, reason) {
    if (!batch) return { verified: true, directory: 'archive-nothing-derived' };
    return this.archiveWindows(batch, reason);
  }
}
