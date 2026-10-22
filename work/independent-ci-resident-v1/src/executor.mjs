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
import path from 'node:path';
import { Ledger, batchKey, headKey } from './ledger.mjs';
import { ABORTABLE_IN_FLIGHT, OWNER_ABORTED, abortStageEndingClean, archiveReason, decideFailure, proofComplete } from './classify.mjs';
import { coalesce, parseTrigger } from './trigger.mjs';
import { batchBudgetMs } from './policy.mjs';
import { attempt2Decision, attempt2Subject } from './attempts.mjs';
import { decide, parseHint, HEAVY_ROLES, RELAY_ROLES } from './hosted-wait.mjs';
import { relayPlanFromRows } from './classify.mjs';
import { RELAY_STAGE, ROLE_STAGES } from './policy.mjs';
import { RELAY_RECEIPTS } from './receipts.mjs';
import { CODE, HEX64, ResidentError, check, exactKeys, parseBoundedJson, sha256 } from './canonical.mjs';

export const PAUSE_CONTRACT = 'clued.independent-ci.resident-pause/1';
export const REARM_CONTRACT = 'clued.independent-ci.resident-owner-rearm/1';
export const RESUME_CONTRACT = 'clued.independent-ci.resident-owner-resume/1';
export const ABORT_CONTRACT = 'clued.independent-ci.resident-owner-abort/1';
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
// result it came from (its bound outcome and the broker's no-launch fact decide a release, classify.mjs#decideFailure).
class StepFailure {
  constructor(stageNumber, code, proof, phase, relayedRoles = 0, result = null) {
    Object.assign(this, { stageNumber, code: validCode(code), proof: proof ?? {}, phase, relayedRoles, outcome: result?.outcome ?? null, brokerNoLaunch: result?.brokerNoLaunch === true });
  }
}

// The stages before which the executor records the head as "may have published" (executed-heads.mjs): every stage that
// can publish a role or control check.
export const PUBLICATION_STAGES = Object.freeze([3, 5, 7, 8, RELAY_STAGE]);
export const BACKFILL_MAX_PENDING = 10;
const NO_STATUS = Object.freeze({ update() {}, setState() {}, setCurrent() {}, outcome() {}, setPending() {} });

// The stage-terminal receipt's summary of a stage outcome: codes and flags only.
const outcomeSummary = r => {
  const o = r?.outcome;
  if (!o && r?.brokerNoLaunch !== true) return null;
  return { status: o?.status ?? null, reason: o?.reason ?? null, sideEffects: o?.sideEffects ?? null, safeToRerun: o?.safeToRerun === true, brokerNoLaunch: r?.brokerNoLaunch === true,
    reasonCodes: o?.diagnostic?.reasonCodes ?? [], nativeReasonCodes: o?.diagnostic?.nativeReasonCodes ?? [], ciRetryAfter: o?.scheduling?.ciRetryAfter ?? o?.diagnostic?.ciRetryAfter ?? null,
    mergeQueue: o?.scheduling?.mergeQueue ?? o?.diagnostic?.mergeQueue ?? null };
};

export class ResidentExecutor {
  // ports: { policy, ledger, receipts, inbox, requests, owner, engine, companion, sourceIntegrity, clock, executedHeads }
  //   owner: an Inbox over the admin-only owner directory (only Administrators can create files there).
  //   executedHeads: executed-heads.mjs#ExecutedHeads (Source-independent "may have published" heads and the backfill).
  //   sleep (optional): the wait between abort polls and quiescence re-checks.
  //   status (optional): status.mjs#StatusBoard (a view; nothing the executor decides ever reads it).
  constructor(ports) {
    for (const k of ['policy', 'ledger', 'receipts', 'inbox', 'requests', 'owner', 'engine', 'companion', 'sourceIntegrity', 'clock', 'executedHeads']) check(ports[k], 'EXECUTOR_PORT_MISSING', k);
    Object.assign(this, ports);
    this.sleep ??= ms => new Promise(r => setTimeout(r, ms));
    this.status ??= NO_STATUS;
    this.ownerReadFailures = new Map();
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
    const codeFor = entry => (entry.planIntent && !entry.plan ? 'RELAY_STAGE_INTERRUPTED' : entry.abort ? 'OWNER_ABORT_INTERRUPTED' : 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH');
    // HALT is latched BEFORE any terminal or quarantine write, so no crash point can leave a closed
    // failure without a HALT (N1).
    const haltCode = ['RELAY_STAGE_INTERRUPTED', 'OWNER_ABORT_INTERRUPTED'].find(c => open.some(e => codeFor(e) === c)) ?? 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH';
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
        } else if (v.contract === REARM_CONTRACT) {
          exactKeys(v, ['contract', 'haltSha256', 'reason', 'by', 'requestedAt', 'nonce'], 'OWNER_REQUEST_REFUSED');
          check(HEX64.test(v.haltSha256) && SID.test(v.by) && NONCE.test(v.nonce) && !Number.isNaN(Date.parse(v.requestedAt))
            && typeof v.reason === 'string' && v.reason.length > 0 && v.reason.length <= 200, 'OWNER_REQUEST_REFUSED');
          outcome = { kind: 'rearm', ...(await this.rearm(v)) };
        } else if (v.contract === ABORT_CONTRACT) {
          abortKey = validateAbortRequest(v).batchKey;
          outcome = { kind: 'abort', ...(await this.abortAtTickStart(v, requestSha256, entry.name)) };
        } else {
          check(false, 'OWNER_REQUEST_REFUSED');
        }
        // A concluded abort has its terminal record and batch receipts; a failed summary receipt is no refusal of it.
        if (outcome.kind === 'abort') { try { await this.receipt('owner-request', { requestSha256, ...outcome }); } catch { /* see above */ } }
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
        await this.receipt(accepted ? 'owner-abort-unconfirmed' : 'owner-request-refused', { requestSha256, failureCode: codeOf(error) });
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
      check(w && w.verified === true, 'REARM_WINDOWS_ARCHIVE_UNCONFIRMED');
      const l = await this.companion.archiveLinux(batch, 'rearm-quarantine');
      check(l && l.verified === true, 'REARM_LINUX_ARCHIVE_UNCONFIRMED');
      await this.ledger.markQuarantineArchived(q.marker, { windows: w.directory, linux: l.directory, haltSha256 });
      archived.push(q.key);
    }
    for (const entry of await this.ledger.unknownUnarchived()) {
      const batch = { key: entry.key, batchId: entry.started?.facts?.batchId ?? entry.terminal?.facts?.batchId ?? null };
      const w = await this.engine.archiveFailure(batch, code);
      check(w && w.verified === true, 'REARM_WINDOWS_ARCHIVE_UNCONFIRMED');
      let l = null;
      if (batch.batchId) {
        l = await this.companion.archiveLinux(batch, code);
        check(l && l.verified === true, 'REARM_LINUX_ARCHIVE_UNCONFIRMED');
      }
      await this.ledger.markArchived(entry.key, { windows: w.directory, linux: l?.directory ?? null, haltSha256 });
      archived.push(entry.key);
    }
    const kept = await this.ledger.clearHalt(haltSha256, { by, reason, archived });
    return { haltSha256, archived, haltKeptAs: path.basename(kept) };
  }

  // ---- Owner abort (DESIGN §6.5) ----

  // Safe point P0, a tick start: nothing of this executor runs, so the only open entry recovery leaves is a batch
  // waiting for hosted signals. Any other target is refused and recorded.
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
      request = await this.acceptAbort(v.batchKey, { name, requestSha256, value: v }, 'waiting', null);
    } catch (error) {
      // Nothing accepted: a plain refusal. Accepted half-way (80-owner-abort written): UNKNOWN, HALT now (review M1).
      if (!(await this.ledger.state(v.batchKey)).abort) throw error;
      const r = await this.unknown(v.batchKey, codeOf(error), 'owner-abort-unconfirmed', s.wait.batch, { safePoint: 'waiting', stage: null, requestSha256 });
      return { key: v.batchKey, outcome: r.state, failureCode: r.failureCode };
    }
    const r = await this.ownerAbort(v.batchKey, s.wait.batch, { safePoint: 'waiting', request });
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
    if (!s.abort) await this.ledger.beginOwnerAbort(key, { requestSha256, ledgerEntrySha256: value.ledgerEntrySha256, by: value.by, reason: value.reason, safePoint, stage });
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
      return this.unknown(key, codeOf(error), 'owner-abort-unconfirmed', batch, { safePoint, stage: null, requestSha256: found.requestSha256 });
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
        } catch { /* a failed poll never ends the stage; the next poll tries again */ }
      }
    })();
    return { state, stop: async () => { stopped = true; wake(); await running; } };
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
      const proof = await this.abortQuiescence(batch, result?.proof ?? {});
      if (!proofComplete(proof)) return await this.unknown(key, 'OWNER_ABORT_QUIESCENCE_UNPROVEN', 'owner-abort-quiescence-unproven', batch, context);
      await this.ledger.burnHead(key, { failureCode: OWNER_ABORTED });
      const windows = await this.engine.archiveFailure(batch, OWNER_ABORT_ARCHIVE_REASON);
      const linux = await this.companion.archiveLinux(batch, OWNER_ABORT_ARCHIVE_REASON);
      check(windows && windows.verified === true && linux && linux.verified === true, 'FAILURE_ARCHIVE_UNCONFIRMED');
      await this.ledger.terminal(key, 'FAILED_CLEAN', { failureCode: OWNER_ABORTED, basis: 'owner-abort-quiescence-proven', safePoint, stage,
        stageCode: result && result.ok !== true ? validCode(result.code) : null, stopCode: typeof stopCode === 'string' && CODE.test(stopCode) ? stopCode : null,
        batchId: batch?.batchId ?? null, windows: windows.directory, linux: linux.directory, requestSha256: request.requestSha256 });
      await this.receipt('batch-terminal', { key, outcome: 'FAILED_CLEAN', failureCode: OWNER_ABORTED, safePoint });
      try { this.reportOutcome((await this.ledger.state(key)).reserved?.subject, 'FAILED_CLEAN', { code: OWNER_ABORTED, key }); } catch { /* advisory */ }
      return { state: 'FAILED_CLEAN', key, failureCode: OWNER_ABORTED, safePoint };
    } catch (error) {
      return this.unknown(key, codeOf(error), 'owner-abort-unconfirmed', batch, context);
    }
  }

  // Pause requests may come from the user session: stopping is always allowed, resuming is not.
  // A pause takes effect between batches; a running batch is never interrupted or killed.
  async takePauseRequests() {
    for (const entry of await this.requests.read(this.policy.limits.inboxMaxFiles, 1024)) {
      let ok = false;
      if (entry.bytes) {
        try {
          const v = parseBoundedJson(entry.bytes, 1024, 'PAUSE_REQUEST_REFUSED');
          exactKeys(v, ['contract', 'reason'], 'PAUSE_REQUEST_REFUSED');
          ok = v.contract === PAUSE_CONTRACT && typeof v.reason === 'string' && v.reason.length <= 200;
          if (ok && await this.ledger.pause({ reason: v.reason, requestSha256: sha256(entry.bytes) })) await this.receipt('paused', { reason: v.reason, requestSha256: sha256(entry.bytes) });
        } catch { ok = false; }
      }
      await this.requests.dispose(entry.name, ok ? 'processed' : 'rejected');
    }
  }

  async tick() {
    const result = await this.tickInner();
    await this.reportTick(result);
    return result;
  }

  // The status board after a tick: the resting state, HALT and PAUSE as the ledger has them now.
  async reportTick(result) {
    try {
      const halt = await this.ledger.halted();
      const paused = await this.ledger.paused();
      const state = ['IDLE', 'RUNNING', 'WAITING', 'DEFERRED', 'HALTED', 'PAUSED', 'BACKFILL_PENDING', 'COMPLETED', 'FAILED_CLEAN', 'NOT_ADMITTED', 'NOT_EXECUTED', 'IGNORED'].includes(result?.state) ? result.state : 'IDLE';
      this.report(s => {
        s.setState(halt ? 'HALTED' : state, halt ? (halt.value?.code ?? null) : (result?.reason ?? result?.failureCode ?? null));
        s.update({ halt: halt ? { code: CODE.test(halt.value?.code ?? '') ? halt.value.code : 'HALT_RECORD_UNREADABLE', at: halt.value?.at ?? null } : null, paused: !!paused });
        if (!['WAITING'].includes(result?.state)) s.setCurrent(null);
      });
    } catch { /* advisory */ }
  }

  // Resident quota redesign v0.6 §9 phase 1, items 6 and 7: on the first start of an install, before any batch, every
  // earlier ledger (this state and the state the install carried forward) is read into the Source-independent executed
  // heads. Done once (BACKFILL-COMPLETE.json). A refused source (manifest missing or malformed, a carried file missing
  // or changed) HALTs: no batch may run without it. A transient I/O error only defers it to the next tick, at most
  // BACKFILL_MAX_PENDING ticks in a row; then it HALTs too (independent review of phase 1, MINOR 6: a lasting EPERM
  // must not keep rereading every carried file forever).
  async ensureBackfill() {
    let marker;
    try {
      if (await this.executedHeads.backfilled()) return null;
      this.report(s => s.update({ backfill: { complete: false, published: null, unreadable: null } }));
      marker = await this.executedHeads.backfill();
    } catch (error) {
      const pending = !(error instanceof ResidentError) && (this.backfillPending = (this.backfillPending ?? 0) + 1) < BACKFILL_MAX_PENDING;
      if (pending) return { state: 'BACKFILL_PENDING' };
      const code = error instanceof ResidentError ? codeOf(error) : 'EXECUTED_HEADS_BACKFILL_UNAVAILABLE';
      await this.haltWith(code, { phase: 'executed-heads-backfill', attempts: this.backfillPending ?? 0 });
      this.backfillPending = 0;
      return { state: 'HALTED', failureCode: code };
    }
    this.backfillPending = 0;
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
    await this.takeOwnerRequests();
    // An Owner abort whose acceptance failed half-way would leave an open entry that is no resumable wait: nothing else
    // runs in this tick, and the next tick's recovery closes it FAILED_UNKNOWN (independent review of v0.8, M1).
    const stuck = recovered ? await this.ledger.crashed() : [];
    if (stuck.length > 0) {
      await this.haltWith('OWNER_ABORT_UNCONFIRMED', { keys: stuck.map(e => e.key) });
      return { state: 'HALTED' };
    }
    // Even if the HALT itself could not be written, an unconfirmed recovery never runs a candidate,
    // and neither does a ledger with an unarchived failed-unknown or quarantined scene (N1).
    if (!recovered || await this.ledger.halted()) return { state: 'HALTED' };
    if ((await this.ledger.unarchivedScenes()) > 0) {
      await this.haltWith('UNARCHIVED_FAILURE_SCENE', {});
      return { state: 'HALTED' };
    }
    // No batch of any kind (a resumed wait, an attempt 2, a new trigger) before the executed-heads backfill finished.
    const backfill = await this.ensureBackfill();
    if (backfill) return backfill;
    await this.takePauseRequests();
    if (await this.ledger.paused()) return { state: 'PAUSED' };
    // A batch waiting for hosted signals goes first (serial: nothing else starts while it waits). It is
    // re-evaluated only here, after recovery, the Owner's requests, HALT and PAUSE.
    const waiting = await this.ledger.waiting();
    if (waiting) return this.resumeWaiting(waiting);
    // A due attempt 2 goes before new triggers (it is the same head, already reserved once). One that is only
    // deferred never blocks other PRs' triggers (PR-A review MINOR 9).
    let deferred = null;
    for (const due of (await this.ledger.pendingAttempts2()).filter(a => a.notBefore <= this.clock())) {
      const r = await this.runAttempt2(due);
      if (r.state !== 'DEFERRED') return r;
      deferred ??= r;
    }
    const candidates = await this.nextCandidates();
    // The status board's pending list: the triggers in the order they run, with the reason each waits (if known).
    const pending = candidates.map(c => ({ pr: c.trigger.pr, headSha: c.trigger.headSha, baseSha: c.trigger.baseSha, since: c.since ?? null, deferred: null }));
    const show = () => this.report(s => s.setPending(pending.filter(p => !p.done)));
    show();
    if (candidates.length === 0) return deferred ?? { state: 'IDLE' };
    let last;
    for (const [i, c] of candidates.entries()) {
      last = await this.runCandidate(c);
      if (last.state === 'DEFERRED') pending[i].deferred = last.reason; else pending[i].done = true;
      // A head waiting out its own cool-down must not block the PRs behind it.
      if (!(last.state === 'DEFERRED' && last.reason === 'UNEXECUTED_COOLDOWN')) {
        if (last.state === 'DEFERRED') for (const p of pending.slice(i + 1)) p.deferred ??= last.reason;
        show();
        return last;
      }
    }
    show();
    return last;
  }

  async nextCandidates() {
    const parsed = [];
    for (const entry of await this.inbox.read(this.policy.limits.inboxMaxFiles, 1024)) {
      const bytesSha256 = entry.bytes ? sha256(entry.bytes) : null;
      if (!entry.bytes) {
        await this.inbox.dispose(entry.name, 'rejected');
        await this.receipt('trigger-rejected', { failureCode: entry.refused, bytesSha256 });
        continue;
      }
      try {
        parsed.push({ name: entry.name, bytesSha256, trigger: parseTrigger(entry.bytes, this.policy) });
      } catch (error) {
        await this.inbox.dispose(entry.name, 'rejected');
        await this.receipt('trigger-rejected', { failureCode: codeOf(error), bytesSha256 });
      }
    }
    // Oldest first; duplicates of one (pr, head, base) are handled together.
    const all = coalesce(parsed, this.policy.limits.inboxMaxFiles);
    for (const c of all) {
      c.bytesSha256 = parsed.filter(p => c.names.includes(p.name)).map(p => p.bytesSha256);
      // When the first trigger of it arrived (the inbox name's time prefix; display only, never a decision).
      const at = Math.min(...c.names.map(n => Number(/^(\d{13})-/.exec(n)?.[1] ?? NaN)).filter(Number.isFinite));
      c.since = Number.isFinite(at) ? new Date(at).toISOString() : null;
    }
    return all;
  }

  async disposeAll(names, disposition) { for (const n of names) await this.inbox.dispose(n, disposition); }

  // Pre-checks that need no secret and no network. Anything that fails here leaves the ledger untouched.
  async precheck(key, hk, subject, { attempt1Key = null } = {}) {
    const now = this.clock();
    if (await this.ledger.headBurned(hk)) return { ignore: 'HEAD_ALREADY_EXECUTED_NO_RETRY' };
    // A head that may have published a check under ANY Source or attempt (executed-heads.mjs) never runs again: a new
    // Source would otherwise run it as new and stop at ROLE_ALREADY_PUBLISHED_ON_HEAD (2026-10-22, Note 1550fef8). The
    // one exception: attempt 2 of the same head, when the only record is attempt 1's own "before stage R" one (stage R
    // relayed nothing, or attempt 2 would never have been scheduled).
    if (await this.executedHeads.published(subject)
      && !(attempt1Key && await this.executedHeads.onlyRelayRecordOf(subject, attempt1Key, RELAY_STAGE))) return { ignore: 'HEAD_ALREADY_PUBLISHED_NO_RETRY' };
    if ((await this.ledger.state(key)).state !== 'ABSENT') return { ignore: 'CONTENT_ALREADY_EXECUTED_NO_RETRY' };
    const recent = await this.ledger.unexecutedSince(key, now - DAY);
    if (recent.length > 0 && recent.length >= this.policy.limits.unexecutedMaxPer24h) return { ignore: 'UNEXECUTED_DAILY_CAP' };
    if (recent.length > 0 && now - Math.max(...recent) < this.policy.limits.unexecutedCooldownMs) return { defer: 'UNEXECUTED_COOLDOWN' };
    const batches24h = await this.ledger.startedSince(now - DAY), evaluations24h = await this.ledger.evaluationsSince(now - DAY);
    this.report(s => s.update({ limits: { batches24h, maxBatches: this.policy.limits.maxBatchesPer24h, evaluations24h, maxEvaluations: this.policy.limits.maxEvaluationsPer24h } }));
    if (batches24h >= this.policy.limits.maxBatchesPer24h) return { defer: 'DAILY_BATCH_LIMIT' };
    if (evaluations24h >= this.policy.limits.maxEvaluationsPer24h) return { defer: 'DAILY_EVALUATION_LIMIT' };
    const startCode = await this.batchStartChecks(null);
    if (startCode) return { halt: startCode };
    const beat = await this.companion.heartbeat();
    if (!beat || typeof beat.at !== 'number' || now - beat.at > this.policy.companion.heartbeatMaxAgeMs) return { defer: 'COMPANION_NOT_READY' };
    return {};
  }

  // The start-of-batch authority checks, run before a reservation and again on every resume of a waiting batch
  // (PR-A review MAJOR 3): the install's validUntil, the installed Source and resident bytes against the
  // policy, and (for a batch) the batch subject's Source against the installed one. Returns a HALT code or null.
  async batchStartChecks(subject) {
    if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < this.clock() + batchBudgetMs(this.policy)) return 'RESIDENT_INSTALL_AUTHORITY_EXPIRING';
    const integrity = await this.sourceIntegrity();
    if (!integrity || integrity.ok !== true || integrity.sourceManifestSha256 !== this.policy.sourceManifestSha256
      || integrity.residentManifestSha256 !== this.policy.residentManifestSha256) return 'RESIDENT_SOURCE_DRIFT';
    if (subject && subject.sourceManifestSha256 !== this.policy.sourceManifestSha256) return 'RESIDENT_SOURCE_DRIFT';
    return null;
  }

  async runCandidate({ trigger, names, bytesSha256 }) {
    const subject = { ...trigger, sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1 };
    const key = batchKey(subject);
    const hk = headKey(subject);
    const pre = await this.precheck(key, hk, subject);
    if (pre.ignore) {
      await this.disposeAll(names, 'ignored');
      await this.receipt('trigger-ignored', { key, failureCode: pre.ignore, bytesSha256 });
      this.reportOutcome(subject, 'IGNORED', { code: pre.ignore, key });
      return { state: 'IGNORED', key, reason: pre.ignore };
    }
    if (pre.halt) { await this.haltWith(pre.halt, { key }); return { state: 'HALTED', key, failureCode: pre.halt }; }
    if (pre.defer) return { state: 'DEFERRED', key, reason: pre.defer };

    await this.ledger.reserve(key, subject);
    await this.receipt('batch-reserved', { key, headKey: hk, subject, bytesSha256 });
    await this.disposeAll(names, 'processed');
    // t0 of the hosted wait: the trigger is first read and consumed in this very tick.
    return this.driveReserved(key, subject, this.clock());
  }

  // The scheduled attempt 2: same pre-checks under its own keys; the intent is closed if they refuse it
  // for good, kept when they only defer it.
  async runAttempt2({ key1, key2, subject }) {
    // Bound to the installed Source (PR-A review MAJOR 2): an intent from before a reinstall is closed, never run.
    if (subject.sourceManifestSha256 !== this.policy.sourceManifestSha256) {
      await this.ledger.closeAttempt2(key1, { failureCode: 'ATTEMPT2_SOURCE_CHANGED' });
      await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: 'ATTEMPT2_SOURCE_CHANGED' });
      return { state: 'IGNORED', key: key2, reason: 'ATTEMPT2_SOURCE_CHANGED' };
    }
    const hk = headKey(subject);
    const pre = await this.precheck(key2, hk, subject, { attempt1Key: key1 });
    if (pre.ignore) {
      await this.ledger.closeAttempt2(key1, { failureCode: pre.ignore });
      await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: pre.ignore });
      return { state: 'IGNORED', key: key2, reason: pre.ignore };
    }
    if (pre.halt) { await this.haltWith(pre.halt, { key: key2 }); return { state: 'HALTED', key: key2, failureCode: pre.halt }; }
    if (pre.defer) return { state: 'DEFERRED', key: key2, reason: pre.defer };
    // Consumed create-only before the reservation: whatever attempt 2 ends with, it never runs again.
    await this.ledger.consumeAttempt2(key1, { key2 });
    await this.ledger.reserve(key2, subject);
    await this.receipt('batch-reserved', { key: key2, headKey: hk, subject, attempt1: key1 });
    return this.driveReserved(key2, subject, this.clock());
  }

  async driveReserved(key, subject, t0) {
    let batch = null;
    let outcome;
    this.current = { key, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, since: new Date(this.clock()).toISOString() };
    this.atStage(0, 'derive');
    try {
      outcome = await this.drive(key, subject, t0, b => { batch = b; });
    } catch (error) {
      // An exception in the executor itself (or a port) is never classified as clean.
      return this.unknown(key, codeOf(error), 'executor-exception');
    }
    if (outcome instanceof StepFailure) return this.fail(key, batch, outcome);
    return outcome;
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

  async drive(key, subject, t0, keepBatch) {
    const batch = await this.engine.derive(subject, key);
    keepBatch(batch);
    await this.receipt('batch-derived', { key, batchId: batch.batchId, packageSha256: batch.packageSha256 });

    // The bundle comes first: it needs only the Owner's own read credential, has no Windows or Linux
    // effect and publishes nothing, so its failure can release the reservation.
    this.atStage(0, 'bundle');
    const bundle = await this.companion.buildBundle(batch);
    if (!bundle || bundle.ok !== true) return new StepFailure(0, 'BUNDLE_UNAVAILABLE', {}, 'bundle');
    const early = await this.abortIfRequested(key, batch, 'before-stage-1');
    if (early) return early;

    this.atStage(1, 'stage');
    const first = await this.engine.runStage(batch, this.stage(1), { betweenRoles: false, firstLinux: false });
    await this.receipt('stage-terminal', { key, stage: 1, ok: first.ok === true, failureCode: first.ok ? null : validCode(first.code), factsSha256: first.factsSha256 ?? null, outcome: outcomeSummary(first) });
    if (first.ok !== true) return new StepFailure(1, first.code, first.proof, 'stage', 0, first);

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
      // Every resume re-runs the start-of-batch checks; any drift fails closed (UNKNOWN, HALT).
      const startCode = await this.batchStartChecks(subject);
      if (startCode) return this.unknown(key, startCode, 'resume-start-checks', batch);
      outcome = await this.continueBatch(key, subject, batch, t0);
    } catch (error) {
      return this.unknown(key, codeOf(error), 'executor-exception', batch);
    }
    if (outcome instanceof StepFailure) return this.fail(key, batch, outcome);
    return outcome;
  }

  // Everything after 15-relay-wait: one wait evaluation, then (unless still waiting) 20-plan-intent,
  // stage R, 25-plan, the local roles, stage 8 and the close.
  async continueBatch(key, subject, batch, t0) {
    let aborted = await this.abortIfRequested(key, batch, 'before-relay-plan');
    if (aborted) return aborted;
    const plan = await this.relayPlan(key, subject, batch, t0);
    if (plan instanceof StepFailure || plan.waiting) return plan.waiting ? { state: 'WAITING', key, until: plan.until, reason: plan.reason } : plan;
    const relayed = plan.relayed.length;

    // Only LOCAL_REQUIRED roles run locally, in the fixed role order; the protocol records of the previous
    // local Linux role are archived before the next one (between-roles-4 / -6 only where needed).
    const localRoles = HEAVY_ROLES.filter(r => plan.local.some(l => l.role === r));
    if (localRoles.length > 0) {
      if ((aborted = await this.abortIfRequested(key, batch, 'before-workspace'))) return aborted;
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
        await this.receipt('stage-terminal', { key, stage: number, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), factsSha256: r.factsSha256 ?? null, outcome: outcomeSummary(r) });
        if (unconfirmed) return this.unknown(key, 'OWNER_ABORT_UNCONFIRMED', 'owner-abort-unconfirmed', batch, { safePoint: `in-stage-${number}`, stage: number });
        if (abort) return this.concludeAbort(key, batch, { safePoint: `in-stage-${number}`, stage: number, result: r, request: abort, stopCode });
        if (r.ok !== true) return new StepFailure(number, r.code, r.proof, 'stage', relayed, r);
      }
    }
    await this.lateHostedResults(key, subject, plan);
    if ((aborted = await this.abortIfRequested(key, batch, 'before-stage-8'))) return aborted;
    const unrecorded = await this.beforePublication(key, subject, 8);
    if (unrecorded) { unrecorded.relayedRoles = relayed; return unrecorded; }
    this.atStage(8, 'stage');
    const control = await this.engine.runStage(batch, this.stage(8), { betweenRoles: false, firstLinux: false });
    await this.receipt('stage-terminal', { key, stage: 8, ok: control.ok === true, failureCode: control.ok ? null : validCode(control.code), factsSha256: control.factsSha256 ?? null, outcome: outcomeSummary(control) });
    if (control.ok !== true) return new StepFailure(8, control.code, control.proof, 'stage', relayed, control);

    const closed = await this.engine.closeBatch(batch, { linux: localRoles.length > 0 });
    check(closed && closed.verified === true, 'SUCCESS_PATH_ARCHIVE_UNCONFIRMED');
    await this.ledger.terminal(key, 'COMPLETED', { batchId: batch.batchId, closed: closed.archived ?? null, relayed: plan.relayed.map(r => r.role), local: localRoles });
    await this.receipt('batch-terminal', { key, outcome: 'COMPLETED' });
    this.reportOutcome(subject, 'COMPLETED', { key });
    return { state: 'COMPLETED', key, relayed: plan.relayed.map(r => r.role), local: localRoles };
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
    try {
      const started = (await this.ledger.state(key)).state === 'STARTED';
      if (!started && failure.phase === 'bundle') {
        await this.closeOrThrow(batch);
        await this.ledger.releaseUnexecuted(key, 'BUNDLE_UNAVAILABLE', { failureCode: failure.code });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code });
        this.reportOutcome(this.current, 'NOT_EXECUTED', { code: failure.code, key });
        return { state: 'NOT_EXECUTED', key, failureCode: failure.code };
      }
      const proof = await this.proofFor(batch, failure.proof);
      // The failure table (classify.mjs#decideFailure): a stage-1 failure is released only on the outcome's own
      // safeToRerun flag or the broker's "no launch, original restored" answer; every other failure burns the head.
      const { klass, basis, row, release } = decideFailure({ code: failure.code, stage: failure.stageNumber, phase: failure.phase, outcome: failure.outcome,
        brokerNoLaunch: failure.brokerNoLaunch, proof, started });
      const facts = ResidentExecutor.failureFacts(failure, row);
      if (!started && release) {
        await this.closeOrThrow(batch);
        await this.ledger.releaseUnexecuted(key, release, { failureCode: failure.code, basis, ...facts });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code, release, class: facts.class });
        this.reportOutcome(await subjectOf() ?? this.current, release === 'NOT_ADMITTED' ? 'NOT_ADMITTED' : 'NOT_EXECUTED', { code: failure.code, row, key });
        return { state: release === 'NOT_ADMITTED' ? 'NOT_ADMITTED' : 'NOT_EXECUTED', key, failureCode: failure.code, release };
      }
      // Every other failure burns the head, also before 10-started (stage 1 may have published).
      await this.ledger.burnHead(key, { failureCode: failure.code });
      if (klass === 'CLEAN') {
        const reason = archiveReason(failure.code);
        const windows = await this.engine.archiveFailure(batch, reason);
        const linux = await this.companion.archiveLinux(batch, reason);
        check(windows && windows.verified === true && linux && linux.verified === true, 'FAILURE_ARCHIVE_UNCONFIRMED');
        await this.ledger.terminal(key, 'FAILED_CLEAN', { failureCode: failure.code, basis, stage: failure.stageNumber, batchId: batch?.batchId ?? null, windows: windows.directory, linux: linux.directory, ...facts });
        await this.receipt('batch-terminal', { key, outcome: 'FAILED_CLEAN', failureCode: failure.code, class: facts.class });
        const subject = (await this.ledger.state(key)).reserved?.subject;
        this.reportOutcome(subject, 'FAILED_CLEAN', { code: failure.code, row, key });
        const decision = attempt2Decision({ policy: this.policy, subject, outcome: 'FAILED_CLEAN', failure });
        if (decision.eligible) {
          const key2 = await this.ledger.scheduleAttempt2(key, attempt2Subject(subject), { failureCode: failure.code, stage: failure.stageNumber },
            this.clock() + this.policy.automaticAttempt2.delayMs);
          try {
            await this.receipt('attempt2-scheduled', { key, attempt2: key2, failureCode: failure.code, stage: failure.stageNumber });
          } catch (error) {
            // An intent without its receipt is cancelled before the HALT, so no re-arm can ever run it (MINOR 7).
            await this.ledger.closeAttempt2(key, { failureCode: 'ATTEMPT2_RECEIPT_UNCONFIRMED' });
            throw error;
          }
          return { state: 'FAILED_CLEAN', key, failureCode: failure.code, attempt2: key2 };
        }
        return { state: 'FAILED_CLEAN', key, failureCode: failure.code };
      }
      return await this.unknown(key, failure.code, basis, batch, { stage: failure.stageNumber, ...facts });
    } catch (error) {
      return this.unknown(key, codeOf(error), 'failure-handling-unconfirmed', batch);
    }
  }

  async closeOrThrow(batch) {
    const closed = await this.engine.closeBatch(batch);
    check(closed && closed.verified === true, 'UNEXECUTED_CLOSE_UNCONFIRMED');
  }

  // extra: further facts of the terminal record (an Owner abort's safe point, stage and stop code).
  async unknown(key, failureCode, basis, batch = null, extra = {}) {
    await this.haltWith(failureCode, { key, basis }); // HALT first: no crash point leaves a closed unknown without it (N1)
    const s = await this.ledger.state(key);
    if (['RESERVED', 'STARTED', 'INCOMPLETE'].includes(s.state)) {
      await this.ledger.burnHead(key, { failureCode });
      await this.ledger.terminal(key, 'FAILED_UNKNOWN', { ...extra, failureCode, basis, batchId: batch?.batchId ?? s.started?.facts?.batchId ?? null });
    }
    await this.receipt('batch-terminal', { key, outcome: 'FAILED_UNKNOWN', failureCode });
    await this.haltWith(failureCode, { key, basis });
    this.reportOutcome(s.reserved?.subject ?? this.current, 'FAILED_UNKNOWN', { code: failureCode, key });
    return { state: 'HALTED', key, failureCode };
  }
}
