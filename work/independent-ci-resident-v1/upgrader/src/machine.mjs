// The upgrade state machine (spec B1). Pure decision over the ops journal + injected ports.
//
//   ACCEPT -> GRANT -> HOLD -> [DRAIN -> PAUSE -> STAGE-W -> STAGE-L]* -> STOP -> SWITCH-L -> SWITCH-W -> START -> VERIFY -> RESUME -> RETENTION
//   a rollback-class failure from STOP on:  ROLLBACK-STOP -> ROLLBACK-SWITCH-W -> [ROLLBACK-SWITCH-L] -> ROLLBACK-START -> ROLLBACK-VERIFY -> KEEP-PAUSED-NOTIFY
//   an aborted Linux switch (quiescence, host facts):  the same rollback steps, then RESUME (outcome REFUSED)
//   a deferral (HALT, drain timeout, pause unconfirmed, companion missing before the switch) ends the bracketed cycle with no
//   lasting side effect; the next cycle starts drainRetryMinutes later, at most deferMaxHours after the Grant was consumed.
//
// decide() is a pure function of the journal and two facts (the clock, whether the resident is HALTED); it names the next
// step, a wait or the end. step() acts on it: it writes the step's intent, acts through the ports, observes, and writes the
// result. The journal is the only state, so a restart anywhere (intent written, result not) reads it again: the open step
// is re-observed (journal.mjs Journal.recover) and either recorded as replayed, redone, finished item by item, or refused as
// UPGRADE_JOURNAL_INCONSISTENT. Every effect is idempotent per item, and every byte the upgrade leaves behind (the generation
// files, receipt, current.json) is computed from the journal's own records, so a resumed run ends byte for byte where an
// uninterrupted one does.
//
// Ports (all injected; see resident-ports.mjs, windows-port.mjs, linux-port.mjs, grant-client.mjs):
//   door.consume({ opId, resource, note })
//   resident.{ hold, liftHold, requestPause, pauseRequestPending, withdrawPause, pauseState, halted, openBatches, status,
//              receiptHead, receiptsSince, trainOpen, brokerPending, companionHeartbeat, requestUpgradeResume }
//   windows.{ readScm, compile, stopServices, switchScm, registerCompanionTask, restartCompanion, startServices, verify }
//   linux.{ stage, switch, rollback, verify, readFacts }
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentError, digest, isoNow, sha256 } from '../../src/canonical.mjs';
import { exists, readBounded } from '../../src/store.mjs';
import { GENERATION_CURRENT_CONTRACT, consistent, parseGenerationCurrent, validateGenerationCurrent } from '../../src/upgrade-mailbox.mjs';
import { U, categoryOf, outcomeOf, ownCode } from './codes.mjs';
import { Journal, RETRY_SLOTS, jsonBytes, observation, seqFor, writeBytesNew } from './journal.mjs';
import { ALL_SLOTS, GENERATED_SLOTS, RECEIPT_SLOT, buildPlan, validatePlan } from './plan.mjs';
import { readPackageOnce } from './package.mjs';
import { validateUpgradeRequest } from './request.mjs';
import { Generations, fileSha } from './generations.mjs';
import { pauseRequestBytes } from './resident-ports.mjs';

const MIN = 60_000, HOUR = 3_600_000;
export const POLL = Object.freeze({ drain: 60_000, pause: 15_000, verify: 15_000, halted: 5 * MIN, transient: MIN, grantSwitchMs: 10 * MIN });
export const HEARTBEAT_FRESH_MS = 60_000;
export const GRANT_DOOR_GIVE_UP_MS = 24 * HOUR;
// A rollback that cannot reach the companion (the Owner is not logged on, the host restarted) waits this long, the node
// stopped or paused, before it ends ROLLBACK_FAILED with UPGRADE_ROLLBACK_COMPANION_UNAVAILABLE.
export const ROLLBACK_WAIT_MAX_MS = 24 * HOUR;
const ROLE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const HEX = /^[0-9a-f]{64}$/;
export const RECEIPT_CONTRACT_V6 = 'clued.independent-ci.resident-install-receipt/6';
const ABORT_AT_SWITCH = new Set([U.LINUX_QUIESCENCE_UNCONFIRMED, U.LINUX_HOST_FACTS_CHANGED]);
const LINUX_STAGE_CODES = new Set([U.LINUX_STAGE_REFUSED, U.LINUX_HOST_FACTS_CHANGED]);
// The receipt fields /5 names after the files the install compiled (install-resident.ps1 'service-hosts', 'broker-config').
const COMPILED_RECEIPT_KEYS = Object.freeze({ 'bin\\ResidentServiceHost.exe': 'ResidentServiceHostSha256', 'bin\\SwapBroker.exe': 'SwapBrokerSha256',
  'bin\\CluedCompanionJobHost.exe': 'companionJobHostSha256', 'helpers\\controller-formal-generic-v2.exe': 'genericHelperSha256', 'config\\broker.json': 'brokerConfigSha256' });

// ---- the pure part ----

const entryOf = (j, step) => j.steps.find(s => s.step === step) ?? null;
const all = (j, step) => j.steps.filter(s => s.step === step);
const lastOkPause = j => all(j, 'pause').filter(p => p.result?.ok).pop() ?? null;
// When the Grant was consumed (the start of the deferral bound, spec: at most 24 h after it): the door's own time when it gives
// one, else the time the upgrader saw the consumption; a use that was only replayed (seen again after a restart) counts from
// the grant step's intent, the earliest it can have been.
export function grantConsumedAt(entry) {
  const d = entry.result.detail ?? {};
  if (typeof d.consumedAt === 'string' && Number.isFinite(Date.parse(d.consumedAt))) return Date.parse(d.consumedAt);
  return Date.parse(entry.intent.at);
}
export const staged = j => j.steps.some(s => s.step === 'stage-windows');

export function decide(j, { now, halted }, t) {
  if (j.terminal) return { kind: 'done' };
  const open = j.steps.find(s => s.result === null);
  if (open) return { kind: 'continue', entry: open };
  const done = step => entryOf(j, step)?.result ?? null;
  const term = (code, extra = {}) => ({ kind: 'terminal', outcome: outcomeOf(code), code, ...extra });
  const next = (step, attempt = 0, args = {}) => ({ kind: 'step', step, seq: seqFor(step, attempt), attempt: attempt + 1, args });
  const wait = (code, untilMs) => ({ kind: 'wait', state: 'DEFERRED', code, untilMs });
  if (j.steps.some(s => s.result?.code === U.JOURNAL_INCONSISTENT)) return term(U.JOURNAL_INCONSISTENT);

  const accept = done('accept');
  if (!accept) return next('accept');
  if (!accept.ok) return term(accept.code);
  if (j.cancel && !staged(j)) return term(U.CANCELLED, { cleanup: true });
  const grant = done('grant');
  if (!grant) return next('grant');
  if (!grant.ok) return term(grant.code);
  const staleAt = grantConsumedAt(entryOf(j, 'grant')) + t.deferMaxHours * HOUR;
  const hold = done('hold');
  if (!hold) {
    if (now >= staleAt) return term(U.GRANT_STALE, { cleanup: true });
    if (halted) return wait(U.RESIDENT_HALTED, Math.min(now + POLL.halted, staleAt));
    return next('hold');
  }
  if (!hold.ok) return term(hold.code, { cleanup: true });

  // The cycles: drain c -> pause -> stage-windows -> stage-linux, each later step marked with its cycle.
  const drains = all(j, 'drain');
  const startCycle = c => {
    if (now >= staleAt) return term(U.GRANT_STALE, { cleanup: true });
    if (c >= RETRY_SLOTS.drain) return term(U.RETRIES_EXHAUSTED, { cleanup: true });
    if (halted) return wait(U.RESIDENT_HALTED, Math.min(now + POLL.halted, staleAt));
    return next('drain', c, { cycle: c });
  };
  if (drains.length === 0) return startCycle(0);
  const c = drains.length - 1;
  const inCycle = step => all(j, step).find(s => s.intent.args.cycle === c) ?? null;
  const chain = [drains[c], inCycle('pause'), inCycle('stage-windows'), inCycle('stage-linux')];
  const tail = chain.filter(Boolean).pop();
  if (!tail.result.ok) {
    if (categoryOf(tail.result.code) === 'deferred') {
      if (now >= staleAt) return term(U.GRANT_STALE, { cleanup: true });
      const retryAt = Date.parse(tail.result.at) + t.drainRetryMinutes * MIN;
      if (now < retryAt) return wait(tail.result.code, Math.min(retryAt, staleAt));
      return startCycle(c + 1);
    }
    return term(tail.result.code, { cleanup: true });
  }
  for (const [i, step] of [[1, 'pause'], [2, 'stage-windows'], [3, 'stage-linux']]) {
    if (chain[i]) continue;
    const used = all(j, step).length;
    if (used >= RETRY_SLOTS[step]) return term(U.RETRIES_EXHAUSTED, { cleanup: true });
    return next(step, used, { cycle: c });
  }

  // From STOP on, one way forward and one way back.
  for (const step of ['stop', 'switch-linux', 'switch-windows', 'start', 'verify']) {
    const r = done(step);
    if (!r) return next(step);
    if (!r.ok) return rollbackNext(j, r.code, { done, term, next });
  }
  const resume = done('resume');
  if (!resume) return next('resume', 0, { mode: 'forward' });
  if (!done('retention')) return next('retention');
  return { kind: 'terminal', outcome: resume.detail.pausedBy === 'other' ? 'SUCCEEDED_STILL_PAUSED' : 'SUCCEEDED', code: null, success: true };
}

function rollbackNext(j, failCode, { done, term, next }) {
  const aborted = categoryOf(failCode) === 'aborted';
  const chain = ['rollback-stop', 'rollback-switch-windows'];
  // Whenever switch-linux ran, its rollback runs too (idempotent: after a refusal that moved nothing it only records it).
  if (j.steps.some(s => s.step === 'switch-linux')) chain.push('rollback-switch-linux');
  chain.push('rollback-start', 'rollback-verify', aborted ? 'resume' : 'keep-paused-notify');
  for (const step of chain) {
    const r = done(step);
    if (!r) return next(step, 0, step === 'resume' ? { mode: 'aborted' } : {});
    if (!r.ok) return term(r.code === U.ROLLBACK_COMPANION_UNAVAILABLE ? r.code : U.ROLLBACK_FAILED);
  }
  return { kind: 'terminal', outcome: aborted ? 'REFUSED' : 'ROLLED_BACK_PAUSED', code: failCode };
}

// The state the status shows for an operation that has not ended.
export function stateOf(step) {
  if (step === 'grant') return 'WAITING_GRANT';
  if (step === 'drain') return 'WAITING_DRAIN';
  if (step && (step.startsWith('rollback-') || step === 'keep-paused-notify')) return 'ROLLING_BACK';
  return 'RUNNING';
}

// ---- the acting part ----

const failed = code => ({ ok: false, code });
const okd = (detail = {}) => ({ ok: true, detail });
const waitFor = (ms, view = {}) => ({ wait: ms, view });
const iso = ms => new Date(ms).toISOString();

export class Machine {
  // root: the resident root (C:\ProgramData\CluedIndependentCI\resident); opId: the operation; config: upgrader.json.
  constructor({ root, opId, config, clock = Date.now, pid = process.pid, ports, generations = null, readPackage = readPackageOnce, sleep = null }) {
    this.root = root;
    this.opId = opId;
    this.config = config;
    this.t = config.timeouts;
    this.clock = clock;
    this.pid = pid;
    this.door = ports.door;
    this.resident = ports.resident;
    this.windows = ports.windows;
    this.linux = ports.linux;
    this.gens = generations ?? new Generations(root);
    this.readPackage = readPackage;
    this.opsRoot = path.join(root, 'upgrade', 'ops');
    this.journal = Journal.open(this.opsRoot, opId, { clock, pid });
    this.view = {};
  }

  // One move: a decision and at most one step's worth of action. { done, wait, view }. Exceptions other than the journal's
  // own refusals propagate: the caller tries again later (as after a crash).
  async step() {
    const j = await this.journal.load();
    const now = this.clock();
    let halted = false;
    try { halted = await this.resident.halted(); } catch { halted = false; }
    const d = decide(j, { now, halted }, this.t);
    if (d.kind === 'done') return { done: true, terminal: j.terminal };
    if (d.kind === 'wait') {
      this.view = { state: d.state, code: d.code, nextTryAt: iso(d.untilMs) };
      return { done: false, wait: Math.max(0, d.untilMs - now) };
    }
    if (d.kind === 'terminal') {
      if (d.cleanup) await this.cleanup(j, {});
      const generation = d.success ? j.plan.toGeneration : (j.plan?.fromGeneration ?? (await this.currentGeneration()));
      const grantId = entryOf(j, 'grant')?.result?.detail?.grantId ?? null;
      const terminal = await this.journal.terminal({ outcome: d.outcome, code: d.code, generation, grantId });
      return { done: true, terminal };
    }
    if (d.kind === 'continue') {
      const intent = d.entry.intent;
      if (j.cancel && !staged(j) && ['grant', 'hold', 'drain', 'pause'].includes(intent.step)) {
        await this.cleanup(j, {});
        await this.journal.result(intent, { ok: false, code: U.CANCELLED });
        return { done: false, wait: 0 };
      }
      return this.resume(j, intent);
    }
    const def = STEPS[d.step];
    const prepared = def.prepare ? await def.prepare(this, j, d) : {};
    const intent = await this.journal.intent({ seq: d.seq, step: d.step, attempt: d.attempt, args: { ...d.args, ...(prepared.args ?? {}) },
      before: prepared.before ?? {}, planned: prepared.planned ?? {} });
    j.steps.push({ seq: intent.seq, step: intent.step, intent, result: null });
    return this.act(j, intent);
  }

  // An open step found on (re)start or while it waits.
  async resume(j, intent) {
    const def = STEPS[intent.step];
    if (def.observe) {
      const after = await def.observe(this, j, intent);
      const how = Journal.recover({ before: intent.before, planned: intent.planned, after });
      if (how === 'replay' && def.replayable) {
        await this.journal.result(intent, { ok: true, after, replayed: true });
        return { done: false, wait: 0 };
      }
      if (how === 'inconsistent') {
        await this.journal.result(intent, { ok: false, code: U.JOURNAL_INCONSISTENT, after });
        return { done: false, wait: 0 };
      }
    }
    return this.act(j, intent);
  }

  async act(j, intent) {
    const def = STEPS[intent.step];
    let out;
    try {
      out = await def.run(this, j, intent);
    } catch (error) {
      // The journal's own refusals end the step; anything else leaves it open for the next try.
      if (error instanceof ResidentError && (error.code === U.JOURNAL_INCONSISTENT || error.code === U.ROLLBACK_FAILED)) out = failed(error.code);
      else throw error;
    }
    if (out.wait !== undefined) {
      this.view = { state: stateOf(intent.step), phase: intent.step, ...out.view };
      return { done: false, wait: out.wait };
    }
    const after = def.observe ? await def.observe(this, j, intent) : {};
    await this.journal.result(intent, { ok: out.ok, code: out.ok ? null : out.code, after, detail: out.detail ?? {} });
    this.view = {};
    return { done: false, wait: 0 };
  }

  // ---- shared helpers ----

  planOf(j) { return validatePlan(j.plan); }
  applyArgs(j, extra = {}) { return { opId: this.opId, planSha256: j.planSha256, ...extra }; }
  opFile(name) { return path.join(this.opsRoot, this.opId, name); }

  async currentGeneration() {
    try { return parseGenerationCurrent(await readBounded(this.gens.currentFile, 8192, 'GENERATION_CURRENT_REFUSED')).generation; } catch { return 0; }
  }

  async readCurrent() {
    try { return parseGenerationCurrent(await readBounded(this.gens.currentFile, 8192, 'GENERATION_CURRENT_REFUSED')); } catch { return null; }
  }

  // Everything ACCEPT reads of the node: current.json, the install receipt, the live slots and content-addressed directories.
  async nodeState() {
    const bytes = await readBounded(this.gens.currentFile, 8192, U.CHANNEL_CHANGE_NEEDS_REINSTALL);
    const generation = parseGenerationCurrent(bytes);
    const receiptBytes = await readBounded(this.gens.live(RECEIPT_SLOT), 1024 * 1024, U.CHANNEL_CHANGE_NEEDS_REINSTALL);
    const inv = await this.gens.inventory(ALL_SLOTS);
    return { generation, generationSha256: sha256(bytes), receipt: JSON.parse(receiptBytes.toString('utf8')), receiptSha256: sha256(receiptBytes), live: inv.live, dirs: inv.dirs };
  }

  async computePlan(j) {
    try {
      const request = validateUpgradeRequest(j.request);
      check(request.requestId === this.opId, U.REQUEST_REFUSED, 'opId');
      const node = await this.nodeState();
      const pkg = await this.readPackage(request.packageDirectory, request.packageManifestSha256);
      return buildPlan(node, pkg.manifest, { request, packageFiles: pkg.bytesByPath, opId: this.opId, config: this.config, requestSha256: j.requestSha256 });
    } catch (error) {
      if (error instanceof ResidentError && error.code.startsWith('UPGRADE_')) return { failure: ownCode(error.code, U.REQUEST_REFUSED) };
      if (error instanceof ResidentError) return { failure: U.REQUEST_REFUSED };
      throw error;
    }
  }

  // A rollback step that needs the companion and does not get it: wait (ROLLING_BACK, node stopped or paused) up to
  // ROLLBACK_WAIT_MAX_MS from the step's intent, then end with the code that says why.
  rollbackWait(intent) {
    const left = Date.parse(intent.at) + ROLLBACK_WAIT_MAX_MS - this.clock();
    if (left <= 0) return failed(U.ROLLBACK_COMPANION_UNAVAILABLE);
    return waitFor(Math.min(POLL.transient, left), { code: U.ROLLBACK_COMPANION_UNAVAILABLE });
  }

  heartbeatFresh(hb, now, since = 0) { return hb !== null && hb >= since && now - hb <= HEARTBEAT_FRESH_MS && hb - now <= HEARTBEAT_FRESH_MS; }

  async markerOnce(name, bytes) {
    const file = this.opFile(name);
    if (await exists(file)) return false;
    await writeBytesNew(file, bytes);
    return true;
  }

  // Back out of everything before STOP: the pause request (withdrawn, or the resident's pause lifted with upgrade-resume),
  // the intake hold, and on an abort the staged package. Idempotent.
  async cleanup(j, { withdrawStaged = false } = {}) {
    const pauses = all(j, 'pause');
    for (const p of pauses) {
      const name = p.intent.args.requestName;
      await this.resident.withdrawPause(name, this.opFile(`${String(p.seq).padStart(3, '0')}-pause.withdrawn.json`));
    }
    const ps = await this.resident.pauseState();
    if (ps && pauses.some(p => p.intent.args.requestSha256 === ps.requestSha256)) {
      if (await this.markerOnce(`resume-requested-${ps.sha256.slice(0, 16)}.json`, jsonBytes({ pausedSha256: ps.sha256 }))) {
        await this.resident.requestUpgradeResume({ pausedSha256: ps.sha256, opId: this.opId, generation: j.plan.fromGeneration });
      }
    }
    if (entryOf(j, 'hold')?.result?.ok) await this.resident.liftHold(this.opId);
    if (withdrawStaged && j.plan) {
      const from = this.gens.staged(j.plan.packageManifestSha256);
      const to = this.opFile('staged-withdrawn');
      if ((await exists(from)) && !(await exists(to))) await fs.rename(from, to);
    }
  }

  // The verify conditions (spec B1) for generation `generation`, then upgrade-apply Verify and linux-upgrade-verify.
  async verifyPoll(j, intent, { generation, policySha256, stopStep, startStep, codes, companionWaitMs = 0 }) {
    const now = this.clock();
    const deadline = Date.parse(intent.at) + this.t.verifyMaxMs;
    const stop = entryOf(j, stopStep).intent;
    const startAt = Date.parse(entryOf(j, startStep).intent.at);
    const stopAt = Date.parse(stop.at);
    const current = await this.readCurrent();
    const facts = await this.linux.readFacts();
    const factsFresh = facts && Date.parse(facts.observedAt) >= stopAt;
    const cons = factsFresh ? consistent(current, facts, now) : null;
    const receipts = await this.resident.receiptsSince(stop.args.stopSeq);
    const st = await this.resident.status();
    const scm = await this.windows.readScm(this.applyArgs(j));
    const hb = await this.resident.companionHeartbeat();
    const conditions = {
      serviceStart: receipts.some(r => r.type === 'service-start' && r.body?.policySha256 === policySha256 && r.seq > stop.args.stopSeq),
      status: !!st && st.writtenAt !== null && st.writtenAt > startAt && st.executorState !== null && st.executorState !== 'STARTING',
      probe: !!st && st.probeAt !== null && st.probeAt >= startAt,
      train: !(await this.resident.trainOpen()),
      runner: scm.ok === true && scm.runner?.originalBinary === true && scm.runner?.state === 'stopped',
      broker: (await this.resident.brokerPending()) === 0,
      companion: this.heartbeatFresh(hb, now, startAt),
      versions: cons === true && current?.generation === generation,
    };
    const waiting = Object.keys(conditions).filter(k => !conditions[k]);
    if (waiting.length === 0) {
      const ps = await this.resident.pauseState();
      const w = await this.windows.verify(this.applyArgs(j, { generation, expectPausedSha256: ps?.sha256 ?? null }));
      if (!w.ok) return { ok: false, code: codes.fail, detail: { cause: 'windows', windowsCode: w.code ?? null } };
      const l = await this.linux.verify({ opId: this.opId, generation }, intent.seq);
      if (!l.ok && l.code === U.COMPANION_UNAVAILABLE && codes.companion && now < Date.parse(intent.at) + companionWaitMs) return waitFor(POLL.transient, { code: codes.companion, waiting: 'linux-verify' });
      if (!l.ok) return { ok: false, code: codes.fail, detail: { cause: 'linux', linuxCode: l.code ?? null } };
      return okd({ generation });
    }
    // Waiting only for the companion (its heartbeat, its version facts): a rollback waits up to companionWaitMs for it.
    // Versions count as waiting for the companion only while there are no fresh facts; facts that disagree (or another
    // generation) are not something the companion's return can mend.
    const onlyCompanion = waiting.every(k => k === 'companion' || (k === 'versions' && cons === null));
    if (now >= deadline && onlyCompanion && codes.companion && now < Date.parse(intent.at) + companionWaitMs) return waitFor(POLL.transient, { code: codes.companion, waiting: waiting[0] });
    if (now >= deadline) return { ok: false, code: onlyCompanion && codes.companion ? codes.companion : (cons === false ? codes.skew : codes.timeout), detail: { waiting: waiting[0] } };
    return waitFor(Math.min(POLL.verify, deadline - now), { code: null, waiting: waiting[0] });
  }

  // The install receipt /6 of the new generation: every field of the previous one, then what this upgrade changed.
  receiptOf(j, intent, prev, prevSha, scm, newShas, rolesOf = null) {
    const plan = j.plan;
    const grant = entryOf(j, 'grant').result;
    const out = { ...prev, contract: RECEIPT_CONTRACT_V6, generation: plan.toGeneration, packageManifestSha256: plan.packageManifestSha256,
      windowsLayout: plan.target.windowsLayout, stateCompat: plan.target.stateCompat, policySha256: plan.target.policySha256,
      companionConfigSha256: plan.target.companionConfigSha256, sourceManifestSha256: plan.target.sourceManifestSha256,
      residentManifestSha256: plan.target.residentManifestSha256, ciSourceManifestSha256: plan.target.ciSourceManifestSha256,
      residentBinaryPath: scm.resident.binPath, brokerBinaryPath: scm.broker.binPath,
      companionTaskAction: { path: scm.companionTask.path, arguments: scm.companionTask.arguments },
      linux: { generation: plan.toGeneration, manifestSha256: plan.target.linux.manifestSha256, ciSourceManifestSha256: plan.target.ciSourceManifestSha256,
        qualificationsSha256: rolesOf ?? prev.linux?.qualificationsSha256 ?? {} },
      upgrader: prev.upgrader ?? null, writtenBy: 'CluedCIUpgrader', inheritedFrom: prevSha,
      upgrade: { opId: this.opId, requestId: j.request.requestId, grantId: grant.detail.grantId, grantReceiptId: grant.detail.receiptId, decisionRef: plan.acceptanceDecisionRef,
        fromGeneration: plan.fromGeneration, startedAt: grant.at, completedAt: intent.at } };
    for (const [slot, key] of Object.entries(COMPILED_RECEIPT_KEYS)) if (newShas[slot]) out[key] = newShas[slot];
    return out;
  }

  currentOf(j, intent, receiptSha256) {
    const plan = j.plan;
    return validateGenerationCurrent({ contract: GENERATION_CURRENT_CONTRACT, generation: plan.toGeneration, packageManifestSha256: plan.packageManifestSha256,
      residentManifestSha256: plan.target.residentManifestSha256, ciSourceManifestSha256: plan.target.ciSourceManifestSha256, policySha256: plan.target.policySha256,
      installReceiptSha256: receiptSha256, stateCompat: plan.target.stateCompat,
      linux: { generation: plan.toGeneration, manifestSha256: plan.target.linux.manifestSha256, ciSourceManifestSha256: plan.target.ciSourceManifestSha256 },
      opId: this.opId, at: intent.at });
  }

  // The objects switch-windows touches, as one map (journal before/planned/after).
  async switchObservation(j) {
    const plan = j.plan, n = plan.fromGeneration;
    const o = {};
    for (const s of plan.slots) {
      o[`live:${s.target}`] = observation(await fileSha(this.gens.live(s.target)));
      o[`kept:${s.target}`] = observation(await fileSha(this.gens.kept(n, s.target)));
    }
    for (const d of plan.dirs) o[`dir:${d.kind}`] = observation(await fileSha(path.join(this.root, d.kind, d.sha256)));
    o.current = observation(await fileSha(this.gens.currentFile));
    o.keptCurrent = observation(await fileSha(this.gens.keptCurrent(n)));
    o.record = observation(await fileSha(this.gens.recordFile(plan.toGeneration)));
    return o;
  }

  async restoreObservation(j) {
    const o = {};
    for (const s of j.plan.slots) o[`live:${s.target}`] = observation(await fileSha(this.gens.live(s.target)));
    o.current = observation(await fileSha(this.gens.currentFile));
    return o;
  }
}

function check(condition, code, detail) { if (!condition) throw new ResidentError(code, detail); }

// ---- the steps ----

const STEPS = {
  accept: {
    replayable: true,
    async prepare(m, j) {
      const p = await m.computePlan(j);
      m.accepted = p;
      return p.failure ? { args: {} } : { before: { plan: observation(null) }, planned: { plan: { sha256: p.planSha256 } }, args: {} };
    },
    observe: async (m, j, intent) => (intent.planned.plan ? { plan: observation(await fileSha(m.opFile('010-accept.plan.json'))) } : {}),
    async run(m, j, intent) {
      const p = m.accepted ?? await m.computePlan(j);
      m.accepted = null;
      if (p.failure) return failed(p.failure);
      if (!intent.planned.plan || p.planSha256 !== intent.planned.plan.sha256) return failed(U.PACKAGE_CHANGED);
      if (!(await exists(m.opFile('010-accept.plan.json')))) await m.journal.writePlan(p.planBytes);
      return okd({ toGeneration: p.plan.toGeneration });
    },
  },

  grant: {
    async run(m, j, intent) {
      const plan = m.planOf(j);
      const now = m.clock();
      const r = await m.door.consume({ opId: m.opId, resource: plan.grantResource, note: typeof j.request.note === 'string' ? j.request.note : null });
      const since = now - Date.parse(intent.at);
      if (r.kind === 'consumed') {
        const consumedAt = r.grant.consumedAt ?? (r.grant.replayed ? intent.at : new Date(now).toISOString());
        return okd({ grantId: r.grant.grantId, receiptId: r.grant.receiptId, replayed: r.grant.replayed, use: r.grant.use, consumedAt });
      }
      if (r.kind === 'refused') return failed(r.code);
      if (r.kind === 'pending') {
        return waitFor(since < POLL.grantSwitchMs ? m.t.grantPollMs[0] : m.t.grantPollMs[1],
          { code: null, grant: { requestId: r.requestId, confirmUrl: r.confirmUrl, status: r.status, grantId: null } });
      }
      if (since >= GRANT_DOOR_GIVE_UP_MS) return failed(U.GRANT_DOOR_UNAVAILABLE);
      return waitFor(m.t.grantPollMs[1], { code: U.GRANT_DOOR_UNAVAILABLE });
    },
  },

  hold: {
    async run(m) {
      await m.resident.hold(m.opId);
      return okd();
    },
  },

  drain: {
    async run(m, j, intent) {
      const plan = m.planOf(j);
      const now = m.clock();
      const staleAt = grantConsumedAt(entryOf(j, 'grant')) + m.t.deferMaxHours * HOUR;
      if (now >= staleAt) { await m.resident.liftHold(m.opId); return failed(U.GRANT_STALE); }
      if (await m.resident.halted()) { await m.resident.liftHold(m.opId); return failed(U.RESIDENT_HALTED); }
      await m.resident.hold(m.opId);
      const open = await m.resident.openBatches();
      const companion = m.heartbeatFresh(await m.resident.companionHeartbeat(), now);
      if (open === 0 && companion) return okd({ openBatches: 0 });
      const deadline = Date.parse(intent.at) + plan.drainMaxMinutes * MIN;
      if (now >= deadline) {
        await m.resident.liftHold(m.opId);
        return { ok: false, code: open > 0 ? U.DRAIN_TIMEOUT : U.COMPANION_UNAVAILABLE, detail: { openBatches: open } };
      }
      return waitFor(Math.min(POLL.drain, deadline - now), { code: null, drain: { openBatches: open, deadline: iso(deadline), nextTryAt: null } });
    },
  },

  pause: {
    async prepare(m, j, d) {
      const name = `${String(m.clock()).padStart(13, '0')}-${sha256(`${m.opId}:${d.seq}`).slice(0, 12)}.json`;
      return { args: { requestName: name, requestSha256: sha256(pauseRequestBytes(m.opId, d.seq)) } };
    },
    async run(m, j, intent) {
      const plan = m.planOf(j);
      const { requestName: name, requestSha256: ours } = intent.args;
      const seq3 = String(intent.seq).padStart(3, '0');
      // A HALT before the pause is confirmed: no pause for an upgrade now (deferred, the request withdrawn or lifted).
      if (await m.resident.halted()) { await m.cleanup(j, {}); return failed(U.RESIDENT_HALTED); }
      const marker = m.opFile(`${seq3}-pause.request.json`);
      const bytes = pauseRequestBytes(m.opId, intent.seq);
      if (!(await exists(marker))) {
        if (!(await m.resident.pauseRequestPending(name))) await m.resident.requestPause(name, bytes);
        await m.markerOnce(`${seq3}-pause.request.json`, bytes);
      }
      const now = m.clock();
      const ps = await m.resident.pauseState();
      const open = await m.resident.openBatches();
      const st = await m.resident.status();
      const quiet = open === 0 && !!st && st.current === false && !(await m.resident.trainOpen());
      // 1. PAUSED, nothing open, nothing current, no open stage 10 run.
      if (ps && quiet) return okd({ pausedBy: ps.requestSha256 === ours ? 'upgrade' : 'other', pausedSha256: ps.sha256, via: 'paused' });
      // 2. The service is stopped and this request still waits in requests\ (it pauses the service when it starts).
      if (!ps && open === 0 && (await m.resident.pauseRequestPending(name))) {
        const scm = await m.windows.readScm(m.applyArgs(j));
        if (scm.ok && scm.resident?.state === 'stopped') return okd({ pausedBy: 'upgrade', pausedSha256: null, via: 'stopped-pending' });
      }
      if (now >= Date.parse(intent.at) + m.t.pauseConfirmMs) {
        await m.resident.withdrawPause(name, m.opFile(`${seq3}-pause.withdrawn.json`));
        if (ps && ps.requestSha256 === ours && (await m.markerOnce(`resume-requested-${ps.sha256.slice(0, 16)}.json`, jsonBytes({ pausedSha256: ps.sha256 })))) {
          await m.resident.requestUpgradeResume({ pausedSha256: ps.sha256, opId: m.opId, generation: plan.fromGeneration });
        }
        await m.resident.liftHold(m.opId);
        return failed(U.PAUSE_UNCONFIRMED);
      }
      return waitFor(POLL.pause, { code: null, pausedBy: ps ? (ps.requestSha256 === ours ? 'upgrade' : 'other') : null });
    },
  },

  'stage-windows': {
    async run(m, j) {
      const plan = m.planOf(j);
      const abort = async () => { await m.cleanup(j, { withdrawStaged: true }); return failed(U.WINDOWS_STAGE_REFUSED); };
      if (await m.resident.halted()) { await m.cleanup(j, {}); return failed(U.RESIDENT_HALTED); }
      let pkg;
      try { pkg = await m.readPackage(plan.packageDirectory, plan.packageManifestSha256); } catch (error) {
        if (error instanceof ResidentError) return abort();
        throw error;
      }
      const dir = m.gens.staged(plan.packageManifestSha256);
      const files = [['package-manifest.json', pkg.manifestBytes], ...pkg.bytesByPath.entries()];
      for (const [rel, bytes] of files) {
        const file = path.join(dir, ...rel.split('/'));
        const have = await fileSha(file);
        if (have === sha256(bytes)) continue;
        if (have !== null) return abort();
        await fs.mkdir(path.dirname(file), { recursive: true });
        await writeBytesNew(file, bytes);
      }
      const c = await m.windows.compile(m.applyArgs(j));
      if (!c.ok) return abort();
      for (const slot of GENERATED_SLOTS) {
        const s = await fileSha(m.gens.stagedSource(plan, { kind: 'generated', target: slot }));
        if (typeof s !== 'string' || s.length !== 64) return abort();
      }
      return okd({ files: files.length });
    },
  },

  'stage-linux': {
    async run(m, j, intent) {
      const plan = m.planOf(j);
      if (await m.resident.halted()) { await m.cleanup(j, {}); return failed(U.RESIDENT_HALTED); }
      const r = await m.linux.stage({ opId: m.opId, packageManifestSha256: plan.packageManifestSha256, generation: plan.toGeneration,
        linuxManifestSha256: plan.target.linux.manifestSha256 }, intent.seq);
      if (r.ok) {
        // The roles the stage derived and signed: the new install receipt's linux.qualificationsSha256 (one file, written once).
        const roles = r.result?.roles;
        if (roles && typeof roles === 'object' && !Array.isArray(roles)) {
          const q = {};
          for (const [role, v] of Object.entries(roles)) if (ROLE_NAME.test(role) && HEX.test(v?.qualificationSha256 ?? '')) q[role] = v.qualificationSha256;
          await m.markerOnce(`${String(intent.seq).padStart(3, '0')}-stage-linux.roles.json`, jsonBytes(q));
        }
        return okd();
      }
      if (r.code === U.COMPANION_UNAVAILABLE) { await m.cleanup(j, {}); return failed(U.COMPANION_UNAVAILABLE); }
      const code = LINUX_STAGE_CODES.has(r.code) ? r.code : U.LINUX_STAGE_REFUSED;
      await m.cleanup(j, { withdrawStaged: true });
      return failed(code);
    },
  },

  stop: {
    prepare: async m => ({ args: { stopSeq: await m.resident.receiptHead() } }),
    async run(m, j) {
      const r = await m.windows.stopServices(m.applyArgs(j));
      return r.ok ? okd() : failed(U.SWITCH_FAILED);
    },
  },

  'switch-linux': {
    async run(m, j, intent) {
      const plan = m.planOf(j);
      const r = await m.linux.switch({ opId: m.opId, fromGeneration: plan.fromGeneration, toGeneration: plan.toGeneration, linuxManifestSha256: plan.target.linux.manifestSha256 }, intent.seq);
      if (r.ok) return okd();
      return failed(ABORT_AT_SWITCH.has(r.code) ? r.code : U.SWITCH_FAILED);
    },
  },

  'switch-windows': {
    replayable: true,
    async prepare(m, j) {
      const plan = m.planOf(j);
      const newShas = {};
      for (const s of plan.slots) {
        if (s.kind === 'package') newShas[s.target] = s.sha256;
        else if (s.kind === 'generated') newShas[s.target] = await fileSha(m.gens.stagedSource(plan, s));
      }
      const before = await m.switchObservation(j);
      const planned = {};
      for (const s of plan.slots) {
        planned[`live:${s.target}`] = { sha256: s.kind === 'receipt' ? null : newShas[s.target] };
        planned[`kept:${s.target}`] = { sha256: s.oldSha256 };
      }
      for (const d of plan.dirs) planned[`dir:${d.kind}`] = { sha256: 'directory' };
      planned.current = { sha256: null };
      planned.keptCurrent = { sha256: plan.current.fileSha256 };
      planned.record = { sha256: null };
      return { before, planned, args: { newShas } };
    },
    observe: (m, j) => m.switchObservation(j),
    async run(m, j, intent) {
      const plan = m.planOf(j);
      const n = plan.fromGeneration, n1 = plan.toGeneration;
      const { newShas } = intent.args;
      const files = plan.slots.filter(s => s.kind !== 'receipt');
      await m.gens.snapshot(n, plan, files);
      await m.gens.place(n1, plan, s => newShas[s.target]);
      const a = m.applyArgs(j, { generation: n1 });
      if (!(await m.windows.switchScm(a)).ok) return failed(U.SWITCH_FAILED);
      if (!(await m.windows.registerCompanionTask(a)).ok) return failed(U.SWITCH_FAILED);
      const scm = await m.windows.readScm(m.applyArgs(j));
      if (!scm.ok || typeof scm.resident?.binPath !== 'string' || typeof scm.broker?.binPath !== 'string' || typeof scm.companionTask?.arguments !== 'string') return failed(U.SWITCH_FAILED);
      await m.gens.writeOnce(m.gens.recordFile(n1), jsonBytes({ generation: n1, packageManifestSha256: plan.packageManifestSha256, residentBinPath: scm.resident.binPath,
        brokerBinPath: scm.broker.binPath, companionTaskArguments: scm.companionTask.arguments, filesSha256: digest(newShas) }));
      const receiptSlot = plan.slots.find(s => s.kind === 'receipt');
      await m.gens.snapshotItem(n, receiptSlot);
      const prevBytes = await fs.readFile(m.gens.kept(n, RECEIPT_SLOT));
      const stageL = all(j, 'stage-linux').filter(s => s.result?.ok).pop();
      let rolesOf = null;
      try { rolesOf = JSON.parse(await fs.readFile(m.opFile(`${String(stageL.seq).padStart(3, '0')}-stage-linux.roles.json`), 'utf8')); } catch { rolesOf = null; }
      const receiptBytes = jsonBytes(m.receiptOf(j, intent, JSON.parse(prevBytes.toString('utf8')), sha256(prevBytes), scm, newShas, rolesOf));
      await m.gens.writeOnce(m.gens.live(RECEIPT_SLOT), receiptBytes);
      await m.gens.switchCurrent(n, jsonBytes(m.currentOf(j, intent, sha256(receiptBytes))));
      return okd({ generation: n1 });
    },
  },

  start: {
    async run(m, j) {
      if (!(await m.windows.startServices(m.applyArgs(j))).ok) return failed(U.START_FAILED);
      if (!(await m.windows.restartCompanion(m.applyArgs(j))).ok) return failed(U.START_FAILED);
      return okd();
    },
  },

  verify: {
    run: (m, j, intent) => m.verifyPoll(j, intent, { generation: j.plan.toGeneration, policySha256: j.plan.target.policySha256, stopStep: 'stop', startStep: 'start',
      codes: { fail: U.VERIFY_FAILED, timeout: U.VERIFY_TIMEOUT, skew: U.VERSION_SKEW } }),
  },

  resume: {
    async run(m, j, intent) {
      const plan = m.planOf(j);
      const generation = intent.args.mode === 'forward' ? plan.toGeneration : plan.fromGeneration;
      const p = lastOkPause(j);
      let pausedBy = p?.result.detail.pausedBy ?? 'upgrade';
      let resumed = false;
      if (pausedBy !== 'other' && p) {
        const ps = await m.resident.pauseState();
        if (ps && ps.requestSha256 === p.intent.args.requestSha256) {
          if (await m.markerOnce(`resume-requested-${ps.sha256.slice(0, 16)}.json`, jsonBytes({ pausedSha256: ps.sha256 }))) {
            await m.resident.requestUpgradeResume({ pausedSha256: ps.sha256, opId: m.opId, generation });
          }
          resumed = true;
        } else if (await m.resident.withdrawPause(p.intent.args.requestName, m.opFile(`${String(p.seq).padStart(3, '0')}-pause.withdrawn.json`))) {
          resumed = true;
        } else if (ps) {
          pausedBy = 'other';
        }
      }
      await m.resident.liftHold(m.opId);
      if (intent.args.mode === 'aborted') await m.cleanup(j, { withdrawStaged: true });
      return okd({ pausedBy, resumed });
    },
  },

  retention: {
    async run(m, j, intent) {
      const archived = await m.gens.retain(m.config.keepGenerations, j.plan.toGeneration);
      // The Linux half keeps its own three (linux-upgrade-retain); its failure is recorded, the upgrade is done either way.
      const l = await m.linux.retain({ opId: m.opId, generation: j.plan.toGeneration }, intent.seq);
      return okd({ archived: archived.length, linuxRetain: l.ok ? 'ok' : (l.code ?? 'failed') });
    },
  },

  'rollback-stop': {
    prepare: async m => ({ args: { stopSeq: await m.resident.receiptHead() } }),
    async run(m, j) { return (await m.windows.stopServices(m.applyArgs(j))).ok ? okd() : failed(U.ROLLBACK_FAILED); },
  },

  'rollback-switch-windows': {
    async prepare(m, j) {
      const planned = {};
      for (const s of j.plan.slots) planned[`live:${s.target}`] = { sha256: s.oldSha256 };
      planned.current = { sha256: j.plan.current.fileSha256 };
      return { before: await m.restoreObservation(j), planned, args: {} };
    },
    observe: (m, j) => m.restoreObservation(j),
    async run(m, j, intent) {
      const plan = m.planOf(j);
      // A re-run after a reboot during the wait finds the services started again (delayed-auto): stopped first (idempotent).
      if (!(await m.windows.stopServices(m.applyArgs(j))).ok) return failed(U.ROLLBACK_FAILED);
      await m.gens.restore(plan.fromGeneration, plan);
      await m.gens.restoreCurrent(plan.fromGeneration, plan.toGeneration, plan.current.fileSha256);
      const a = m.applyArgs(j, { generation: plan.fromGeneration });
      if (!(await m.windows.switchScm(a)).ok) return failed(U.ROLLBACK_FAILED);
      if (!(await m.windows.registerCompanionTask(a)).ok) return failed(U.ROLLBACK_FAILED);
      // The companion of N comes back before the Linux half is switched back (it carries that request). Not there (the Owner
      // is not logged on): a bounded wait, the node stopped.
      if (!(await m.windows.restartCompanion(m.applyArgs(j))).ok) return m.rollbackWait(intent);
      // The rolled-back generation's number is free again; its files stay in archive\.
      await m.gens.retire(plan.toGeneration, m.opId.slice(0, 8));
      return okd({ generation: plan.fromGeneration });
    },
  },

  'rollback-switch-linux': {
    async run(m, j, intent) {
      const plan = m.planOf(j);
      // The node stays stopped while the Linux half goes back, a reboot during the wait included.
      if (!(await m.windows.stopServices(m.applyArgs(j))).ok) return failed(U.ROLLBACK_FAILED);
      const r = await m.linux.rollback({ opId: m.opId, fromGeneration: plan.toGeneration, toGeneration: plan.fromGeneration }, intent.seq);
      if (r.ok) return okd();
      if (r.code === U.COMPANION_UNAVAILABLE) return m.rollbackWait(intent);
      return failed(U.ROLLBACK_FAILED);
    },
  },

  'rollback-start': {
    async run(m, j) { return (await m.windows.startServices(m.applyArgs(j))).ok ? okd() : failed(U.ROLLBACK_FAILED); },
  },

  'rollback-verify': {
    run: (m, j, intent) => m.verifyPoll(j, intent, { generation: j.plan.fromGeneration, policySha256: j.plan.current.policySha256, stopStep: 'rollback-stop',
      startStep: 'rollback-start', codes: { fail: U.ROLLBACK_FAILED, timeout: U.ROLLBACK_FAILED, skew: U.ROLLBACK_FAILED, companion: U.ROLLBACK_COMPANION_UNAVAILABLE },
      companionWaitMs: ROLLBACK_WAIT_MAX_MS }),
  },

  'keep-paused-notify': {
    async run(m) {
      // The node stays paused (the pause is not lifted); only the intake hold goes. The status says ROLLED_BACK_PAUSED and the
      // resident turns it into the upgrade-rolled-back notice.
      await m.resident.liftHold(m.opId);
      return okd();
    },
  },
};

export { STEPS };
