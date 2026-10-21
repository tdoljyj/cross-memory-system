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
//   hosted wait (bounded, hosted-wait.mjs#decide over the companion's untrusted hints) -> 20-plan-intent ->
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
import path from 'node:path';
import { batchKey, headKey } from './ledger.mjs';
import { archiveReason, classifyFailure } from './classify.mjs';
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
const DAY = 86_400_000;
const codeOf = error => (error instanceof ResidentError && CODE.test(error.code)) ? error.code : 'RESIDENT_EXECUTOR_EXCEPTION';
const validCode = code => (typeof code === 'string' && CODE.test(code)) ? code : 'FAILURE_CODE_INVALID';
const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const NONCE = /^[0-9a-f]{12,32}$/;

// A step failure travels as a value, so the failure path runs exactly once, outside the step loop.
class StepFailure {
  constructor(stageNumber, code, proof, phase, relayedRoles = 0) { Object.assign(this, { stageNumber, code: validCode(code), proof: proof ?? {}, phase, relayedRoles }); }
}

export class ResidentExecutor {
  // ports: { policy, ledger, receipts, inbox, requests, owner, engine, companion, sourceIntegrity, clock, sleep? }
  //   owner: an Inbox over the admin-only owner directory (only Administrators can create files there).
  //   sleep: the bounded hosted wait's pause (tests and the drill advance a fake clock with it).
  constructor(ports) {
    for (const k of ['policy', 'ledger', 'receipts', 'inbox', 'requests', 'owner', 'engine', 'companion', 'sourceIntegrity', 'clock']) check(ports[k], 'EXECUTOR_PORT_MISSING', k);
    Object.assign(this, { sleep: ms => new Promise(r => setTimeout(r, ms)) }, ports);
    this.ownerReadFailures = new Map();
  }

  receipt(type, body) { return this.receipts.append(type, body); }

  async haltWith(code, facts) {
    if (await this.ledger.halt(code, facts)) await this.receipt('halt', { failureCode: code, facts });
  }

  // Crash recovery runs at the start of every tick, halted or not. At that point this single-threaded
  // loop has no batch in flight, so any open entry was left by a crash or an aborted tick: its
  // processes may still exist, so it is UNKNOWN and HALT is latched (once).
  async recover() {
    const open = await this.ledger.open();
    // A stage R that began (20-plan-intent) without its 25-plan may have begun a relay key: UNKNOWN, HALT.
    const codeFor = entry => (entry.planIntent && !entry.plan ? 'RELAY_STAGE_INTERRUPTED' : 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH');
    // HALT is latched BEFORE any terminal or quarantine write, so no crash point can leave a closed
    // failure without a HALT (N1).
    if (open.length > 0) await this.haltWith(open.some(e => codeFor(e) === 'RELAY_STAGE_INTERRUPTED') ? 'RELAY_STAGE_INTERRUPTED' : 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH', { keys: open.map(e => e.key) });
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
      let outcome;
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
        } else {
          check(false, 'OWNER_REQUEST_REFUSED');
        }
        await this.receipt('owner-request', { requestSha256, ...outcome });
      } catch (error) {
        await this.receipt('owner-request-refused', { requestSha256, failureCode: codeOf(error) });
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
    let recovered = true;
    try {
      await this.recover();
    } catch {
      // Recovery itself failed: fail safe, but still read the Owner's requests below (review M6e).
      recovered = false;
      try { await this.ledger.halt('RECOVERY_UNCONFIRMED', {}); } catch { /* reported by the loop */ }
    }
    await this.takeOwnerRequests();
    // Even if the HALT itself could not be written, an unconfirmed recovery never runs a candidate,
    // and neither does a ledger with an unarchived failed-unknown or quarantined scene (N1).
    if (!recovered || await this.ledger.halted()) return { state: 'HALTED' };
    if ((await this.ledger.unarchivedScenes()) > 0) {
      await this.haltWith('UNARCHIVED_FAILURE_SCENE', {});
      return { state: 'HALTED' };
    }
    await this.takePauseRequests();
    if (await this.ledger.paused()) return { state: 'PAUSED' };
    // A due attempt 2 goes before new triggers (it is the same head, already reserved once).
    const due = (await this.ledger.pendingAttempts2()).find(a => a.notBefore <= this.clock());
    if (due) return this.runAttempt2(due);
    const candidates = await this.nextCandidates();
    if (candidates.length === 0) return { state: 'IDLE' };
    let last;
    for (const c of candidates) {
      last = await this.runCandidate(c);
      // A head waiting out its own cool-down must not block the PRs behind it.
      if (!(last.state === 'DEFERRED' && last.reason === 'UNEXECUTED_COOLDOWN')) return last;
    }
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
    for (const c of all) c.bytesSha256 = parsed.filter(p => c.names.includes(p.name)).map(p => p.bytesSha256);
    return all;
  }

  async disposeAll(names, disposition) { for (const n of names) await this.inbox.dispose(n, disposition); }

  // Pre-checks that need no secret and no network. Anything that fails here leaves the ledger untouched.
  async precheck(key, hk) {
    const now = this.clock();
    if (await this.ledger.headBurned(hk)) return { ignore: 'HEAD_ALREADY_EXECUTED_NO_RETRY' };
    if ((await this.ledger.state(key)).state !== 'ABSENT') return { ignore: 'CONTENT_ALREADY_EXECUTED_NO_RETRY' };
    const recent = await this.ledger.unexecutedSince(key, now - DAY);
    if (recent.length > 0 && recent.length >= this.policy.limits.unexecutedMaxPer24h) return { ignore: 'UNEXECUTED_DAILY_CAP' };
    if (recent.length > 0 && now - Math.max(...recent) < this.policy.limits.unexecutedCooldownMs) return { defer: 'UNEXECUTED_COOLDOWN' };
    if ((await this.ledger.startedSince(now - DAY)) >= this.policy.limits.maxBatchesPer24h) return { defer: 'DAILY_BATCH_LIMIT' };
    if ((await this.ledger.evaluationsSince(now - DAY)) >= this.policy.limits.maxEvaluationsPer24h) return { defer: 'DAILY_EVALUATION_LIMIT' };
    if (this.policy.validUntil !== null && Date.parse(this.policy.validUntil) < now + batchBudgetMs(this.policy)) return { halt: 'RESIDENT_INSTALL_AUTHORITY_EXPIRING' };
    const integrity = await this.sourceIntegrity();
    if (!integrity || integrity.ok !== true || integrity.sourceManifestSha256 !== this.policy.sourceManifestSha256
      || integrity.residentManifestSha256 !== this.policy.residentManifestSha256) return { halt: 'RESIDENT_SOURCE_DRIFT' };
    const beat = await this.companion.heartbeat();
    if (!beat || typeof beat.at !== 'number' || now - beat.at > this.policy.companion.heartbeatMaxAgeMs) return { defer: 'COMPANION_NOT_READY' };
    return {};
  }

  async runCandidate({ trigger, names, bytesSha256 }) {
    const subject = { ...trigger, sourceManifestSha256: this.policy.sourceManifestSha256, attempt: 1 };
    const key = batchKey(subject);
    const hk = headKey(subject);
    const pre = await this.precheck(key, hk);
    if (pre.ignore) {
      await this.disposeAll(names, 'ignored');
      await this.receipt('trigger-ignored', { key, failureCode: pre.ignore, bytesSha256 });
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
    const hk = headKey(subject);
    const pre = await this.precheck(key2, hk);
    if (pre.ignore) {
      await this.ledger.closeAttempt2(key1, { failureCode: pre.ignore });
      await this.receipt('attempt2-ignored', { key: key2, attempt1: key1, failureCode: pre.ignore });
      return { state: 'IGNORED', key: key2, reason: pre.ignore };
    }
    if (pre.halt) { await this.haltWith(pre.halt, { key: key2 }); return { state: 'HALTED', key: key2, failureCode: pre.halt }; }
    if (pre.defer) return { state: 'DEFERRED', key: key2, reason: pre.defer };
    await this.ledger.reserve(key2, subject);
    await this.receipt('batch-reserved', { key: key2, headKey: hk, subject, attempt1: key1 });
    return this.driveReserved(key2, subject, this.clock());
  }

  async driveReserved(key, subject, t0) {
    let batch = null;
    let outcome;
    try {
      outcome = await this.drive(key, subject, t0, b => { batch = b; });
    } catch (error) {
      // An exception in the executor itself (or a port) is never classified as clean.
      return this.unknown(key, codeOf(error), 'executor-exception');
    }
    if (outcome instanceof StepFailure) return this.fail(key, batch, outcome);
    return outcome;
  }

  stage(number) { return this.policy.stages.find(s => s.number === number); }

  async drive(key, subject, t0, keepBatch) {
    const batch = await this.engine.derive(subject, key);
    keepBatch(batch);
    await this.receipt('batch-derived', { key, batchId: batch.batchId, packageSha256: batch.packageSha256 });

    // The bundle comes first: it needs only the Owner's own read credential, has no Windows or Linux
    // effect and publishes nothing, so its failure can release the reservation.
    const bundle = await this.companion.buildBundle(batch);
    if (!bundle || bundle.ok !== true) return new StepFailure(0, 'BUNDLE_UNAVAILABLE', {}, 'bundle');

    const first = await this.engine.runStage(batch, this.stage(1), { betweenRoles: false, firstLinux: false });
    await this.receipt('stage-terminal', { key, stage: 1, ok: first.ok === true, failureCode: first.ok ? null : validCode(first.code), factsSha256: first.factsSha256 ?? null });
    if (first.ok !== true) return new StepFailure(1, first.code, first.proof, 'stage');

    // Admitted and published: from here on this head is burned (also when every heavy role is relayed).
    await this.ledger.markStarted(key, { batchId: batch.batchId });
    await this.receipt('batch-started', { key });

    const plan = await this.relayPlan(key, subject, batch, t0);
    if (plan instanceof StepFailure) return plan;
    const relayed = plan.relayed.length;

    // Only LOCAL_REQUIRED roles run locally, in the fixed role order; the protocol records of the previous
    // local Linux role are archived before the next one (between-roles-4 / -6 only where needed).
    const localRoles = HEAVY_ROLES.filter(r => plan.local.some(l => l.role === r));
    if (localRoles.length > 0) {
      const prep = await this.companion.prepareWorkspaces(batch);
      if (!prep || prep.ok !== true) return new StepFailure(0, prep?.code ?? 'WORKSPACE_PREPARATION_UNCONFIRMED', {}, 'workspace', relayed);
    }
    for (const [index, role] of localRoles.entries()) {
      for (const number of ROLE_STAGES[role]) {
        const execution = number === ROLE_STAGES[role][0];
        const r = await this.engine.runStage(batch, this.stage(number), { betweenRoles: execution && index > 0, firstLinux: execution && index === 0 });
        await this.receipt('stage-terminal', { key, stage: number, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), factsSha256: r.factsSha256 ?? null });
        if (r.ok !== true) return new StepFailure(number, r.code, r.proof, 'stage', relayed);
      }
    }
    await this.lateHostedResults(key, subject, plan);
    const control = await this.engine.runStage(batch, this.stage(8), { betweenRoles: false, firstLinux: false });
    await this.receipt('stage-terminal', { key, stage: 8, ok: control.ok === true, failureCode: control.ok ? null : validCode(control.code), factsSha256: control.factsSha256 ?? null });
    if (control.ok !== true) return new StepFailure(8, control.code, control.proof, 'stage', relayed);

    const closed = await this.engine.closeBatch(batch, { linux: localRoles.length > 0 });
    check(closed && closed.verified === true, 'SUCCESS_PATH_ARCHIVE_UNCONFIRMED');
    await this.ledger.terminal(key, 'COMPLETED', { batchId: batch.batchId, closed: closed.archived ?? null, relayed: plan.relayed.map(r => r.role), local: localRoles });
    await this.receipt('batch-terminal', { key, outcome: 'COMPLETED' });
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

  // Hosted wait -> 20-plan-intent -> stage R (only with candidates) -> 25-plan. Returns the plan
  // { relayed: [row], local: [{ role, reason, receipt }] } or a StepFailure.
  async relayPlan(key, subject, batch, t0) {
    const relay = this.policy.relay;
    let decision, seen = { hint: null, refused: false };
    for (;;) {
      if (relay.enabled === true) seen = await this.hint(subject);
      decision = decide({ relay, t0, now: Math.max(this.clock(), t0), hint: seen.hint });
      if (decision.action !== 'WAIT') break;
      await this.sleep(Math.max(1, Math.min(decision.until - this.clock(), relay.wait.pollMs)));
    }
    const candidates = decision.relayCandidates;
    await this.ledger.writePlanIntent(key, { candidates, local: decision.local, reasons: decision.reasons, reason: decision.reason, waitedMs: Math.max(0, this.clock() - t0),
      hintSha256: seen.sha256 ?? null, hintRefused: seen.refused });
    await this.receipt('relay-plan-intent', { key, candidates, reason: decision.reason, waitedMs: Math.max(0, this.clock() - t0), hintRefused: seen.refused });
    // Roles the resident never sent to stage R stay local with the resident's own scheduling reason.
    const scheduled = decision.local.map(role => ({ role, reason: decision.reasons[role],
      receipt: decision.reasons[role] === 'RELAY_HINT_BILLING_REFUSED' ? 'relay-billing-refused' : 'relay-local-fallback', source: 'resident' }));
    let relayed = [], attested = [];
    if (candidates.length > 0) {
      const r = await this.engine.runRelayStage(batch, candidates);
      await this.receipt('stage-terminal', { key, stage: RELAY_STAGE, ok: r.ok === true, failureCode: r.ok ? null : validCode(r.code), factsSha256: r.factsSha256 ?? null });
      if (r.ok !== true) return new StepFailure(RELAY_STAGE, r.code, r.proof, 'stage', 0);
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

  async fail(key, batch, failure) {
    try {
      const started = (await this.ledger.state(key)).state === 'STARTED';
      if (!started && failure.phase === 'bundle') {
        await this.closeOrThrow(batch);
        await this.ledger.releaseUnexecuted(key, 'BUNDLE_UNAVAILABLE', { failureCode: failure.code });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code });
        return { state: 'NOT_EXECUTED', key, failureCode: failure.code };
      }
      const proof = await this.proofFor(batch, failure.proof);
      const { klass, basis } = classifyFailure(failure.code, proof, failure.stageNumber);
      if (!started && klass === 'NOT_ADMITTED') {
        await this.closeOrThrow(batch);
        await this.ledger.releaseUnexecuted(key, 'NOT_ADMITTED', { failureCode: failure.code });
        await this.receipt('batch-unexecuted', { key, failureCode: failure.code });
        return { state: 'NOT_ADMITTED', key, failureCode: failure.code };
      }
      // Every other failure burns the head, also before 10-started (stage 1 may have published).
      await this.ledger.burnHead(key, { failureCode: failure.code });
      if (klass === 'CLEAN') {
        const reason = archiveReason(failure.code);
        const windows = await this.engine.archiveFailure(batch, reason);
        const linux = await this.companion.archiveLinux(batch, reason);
        check(windows && windows.verified === true && linux && linux.verified === true, 'FAILURE_ARCHIVE_UNCONFIRMED');
        await this.ledger.terminal(key, 'FAILED_CLEAN', { failureCode: failure.code, basis, stage: failure.stageNumber, batchId: batch?.batchId ?? null, windows: windows.directory, linux: linux.directory });
        await this.receipt('batch-terminal', { key, outcome: 'FAILED_CLEAN', failureCode: failure.code });
        const subject = (await this.ledger.state(key)).reserved?.subject;
        const decision = attempt2Decision({ policy: this.policy, subject, outcome: 'FAILED_CLEAN', failure });
        if (decision.eligible) {
          const key2 = await this.ledger.scheduleAttempt2(key, attempt2Subject(subject), { failureCode: failure.code, stage: failure.stageNumber },
            this.clock() + this.policy.automaticAttempt2.delayMs);
          await this.receipt('attempt2-scheduled', { key, attempt2: key2, failureCode: failure.code, stage: failure.stageNumber });
          return { state: 'FAILED_CLEAN', key, failureCode: failure.code, attempt2: key2 };
        }
        return { state: 'FAILED_CLEAN', key, failureCode: failure.code };
      }
      return await this.unknown(key, failure.code, basis, batch);
    } catch (error) {
      return this.unknown(key, codeOf(error), 'failure-handling-unconfirmed', batch);
    }
  }

  async closeOrThrow(batch) {
    const closed = await this.engine.closeBatch(batch);
    check(closed && closed.verified === true, 'UNEXECUTED_CLOSE_UNCONFIRMED');
  }

  async unknown(key, failureCode, basis, batch = null) {
    await this.haltWith(failureCode, { key, basis }); // HALT first: no crash point leaves a closed unknown without it (N1)
    const s = await this.ledger.state(key);
    if (['RESERVED', 'STARTED', 'INCOMPLETE'].includes(s.state)) {
      await this.ledger.burnHead(key, { failureCode });
      await this.ledger.terminal(key, 'FAILED_UNKNOWN', { failureCode, basis, batchId: batch?.batchId ?? s.started?.facts?.batchId ?? null });
    }
    await this.receipt('batch-terminal', { key, outcome: 'FAILED_UNKNOWN', failureCode });
    await this.haltWith(failureCode, { key, basis });
    return { state: 'HALTED', key, failureCode };
  }
}
