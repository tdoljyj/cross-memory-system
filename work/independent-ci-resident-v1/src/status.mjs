// The resident's status snapshot (resident quota redesign v0.6 + §9, phase 1, item 7; Owner Decision 38936534).
//
// state\status.json is a VIEW, never evidence (the ledger and the receipt chain are): the executor keeps one in-memory
// board, and the service writes it WHOLE (temporary file + rename, never appended or patched) on a timer, so writtenAt
// moves even while a stage runs for 45 minutes and only a status that stops moving means a stopped executor (v0.6 §7
// minor 2). changedAt moves only when the content changes. The companion (Owner session, read-only on state\) turns it
// into the PR page status and the Windows notifications (pr-status.mjs); Agents may read it too.
// Content: fixed shapes, stable codes, PR numbers and commit SHAs only (no free text from a PR or a remote service).
// Contract /2 (phase 2, step 1: design v0.5 §4.10): `pending` is the run queue's view (queue.mjs#view: every row with
// its state, reason, position, next try and an ESTIMATED start), plus the queue's generation, the breaker and the
// notices the companion turns into notifications (one per key).
// Contract /3 (primary/standby C6, DESIGN §20): `intakePause`, the intake pause's holds in force (null when none): the
// latest end and each holder's name, start and end (intake-pause.mjs#view). No reason text: that comes from a user session.
// Contract /4 (primary/standby C5, DESIGN §23): `node`, null until the node profile and the node mode (C1, C3) fill it:
// { name, mode: ACTIVE | STANDBY | UNCERTAIN, probe: null | { at, result: held | not-held | uncertain, failures,
// failingSince } }. The companion reads null as one ACTIVE node (node-duty.mjs#nodeOf).
// Contract /5 (quota phase 2 step 3c-1, DESIGN §22.3): `train`, stage 10's mode (policy train.enabled) and the newest
// run's summary (train.mjs#trainSummary; null before the first one). The companion's ruleset backstop reads the mode.
// Contract /6 (primary/standby C3, DESIGN §29): `node` is filled by the executor from the start (null only for an engine that
// cannot probe the role) and gains `source`, the first 12 hex digits of the installed ciSourceManifestSha256:
// { name, source, mode, probe }. The mode is the executor's own (ACTIVE | STANDBY | UNCERTAIN); the reader below accepts /5 and /6,
// so a companion that is installed before its executor has restarted still reads the old file.
// Contract /7 (in-place upgrade channel, Task 018da927, DESIGN §34): a new top-level key `versions`, what this node runs on both
// sides and the upgrade in flight: { generation, windows: { packageManifestSha256, residentManifestSha256, ciSourceManifestSha256,
// policySha256 }, linux: null | { observedAt, generation, ciSourceManifestSha256, manifestSha256, pinsOk }, consistent: true | false |
// null, upgrade: null | { opId, state, phase, since, code, confirmUrl } } (readVersions below), and five notice kinds (version-skew and
// the upgrade's own four). The reader accepts /5 and /6 (no `versions`: read as null) and /7, so a companion installed or switched before its
// executor restarted still reads the old file, and the old companion of a rolled-back generation reads /6 as it always did.
// Step 3c-2b (DESIGN §41.7, §41.3, §41.6; still /7: only `train` grows): `train` may carry `sweep` (train.mjs#trainSweepView: the
// newest sweep and when this node last completed a full sweep since it became eligible for on-mode duty), `revokeHead` (the
// Owner's revoke-head request and its result), `onSince` and `notOnDuty` (on, but this node is not ACTIVE). Each key is written
// only when it has a value, so a reader before 3c-2b and the train shapes of today stay as they were. A notice kind `train-owner`
// carries stage 10's decisions the Owner must hear of (a PAUSE for a landed tree that differs, another node's Source).
// Defect 15894c2a (still /8: only `train` grows, written only when it has a value): `train.nodes`, the nodes the newest on-mode run
// compared in its §41.6 Source check (train.mjs#trainNodesView), for the NON-elevated upgrade precheck (rollout/precheck.mjs).
import fs from 'node:fs/promises';
import path from 'node:path';
import { CODE, HEX40, HEX64, canonicalJson, check, exactKeys, parseBoundedJson } from './canonical.mjs';
import { readBounded } from './store.mjs';
import { HOLDER, INTAKE_HOLDS_MAX } from './intake-pause.mjs';
import { parseRevokeHead, parseTrainLast, parseTrainNodes, parseTrainSweep } from './train.mjs';
import { NODE_NAME, NODE_SOURCE } from './node-duty.mjs';
import { StageTimings, parseTiming } from './stage-timing.mjs';
import { parseSelfcheckView, readSelfcheck, selfcheckNotice, selfcheckView } from './selfcheck.mjs';
import { GENERATION_CURRENT_CONTRACT, LINUX_VERSION_FACTS_CONTRACT, UPGRADE_OP_STATES, UPGRADE_STATUS_CONTRACT, VERSION_FACTS_FILE,
  consistent as versionsConsistent } from './upgrade-mailbox.mjs';

// Contract /8 (optimisation plan P1, Clued bf57ff10): a new top-level key `timing` (stage-timing.mjs): the newest finished batch's segment
// times (`last`), the batch in flight so far (`current`), the median and P90 of each segment over the newest 20 finished batches
// (`stats`), the day's push-to-first-green figures (`pushToGreen`), stage 10's rounds (`train`), and `done` / `open`, the records the
// service reads back on start (restore) so a restart keeps them. Every existing field keeps its meaning. The reader accepts /5 to /8;
// a /8 file read by a companion of before /8 is refused as any unknown contract is (the same order as /6 -> /7: companion first).
export const STATUS_CONTRACT = 'clued.independent-ci.resident-status/8';
export const STATUS_CONTRACT_V7 = 'clued.independent-ci.resident-status/7';
export const STATUS_CONTRACT_V6 = 'clued.independent-ci.resident-status/6';
// What the reader accepts: /5 and /6 (the same top-level keys; the executor before the upgrade channel), /7 and /8.
export const STATUS_CONTRACTS_READABLE = Object.freeze(['clued.independent-ci.resident-status/5', STATUS_CONTRACT_V6, STATUS_CONTRACT_V7, STATUS_CONTRACT]);
export const STATUS_FILE = 'status.json';
export const STATUS_REFRESH_MS = 15_000;
// The companion's reading: a status not rewritten for this long means the executor (or its service) stopped.
export const STATUS_STALE_MS = 5 * 60_000;
export const STATUS_MAX_BYTES = 256 * 1024;
export const EXECUTOR_STATES = Object.freeze(['STARTING', 'IDLE', 'RUNNING', 'WAITING', 'PARKED', 'DEFERRED', 'HALTED', 'PAUSED', 'BACKFILL_PENDING', 'STOPPED',
  'COMPLETED', 'FAILED_CLEAN', 'NOT_ADMITTED', 'NOT_EXECUTED', 'IGNORED']);
export const RECENT_OUTCOMES = Object.freeze(['COMPLETED', 'FAILED_CLEAN', 'FAILED_UNKNOWN', 'NOT_ADMITTED', 'NOT_EXECUTED', 'IGNORED']);
const RECENT_MAX = 50, PENDING_MAX = 100, NOTICES_MAX = 50;
export const ROW_STATES = Object.freeze(['QUEUED', 'RUNNING', 'PARKED', 'WAITING', 'BACKOFF', 'STOPPED', 'DONE']);
export const NOTICE_KINDS = Object.freeze(['new-trigger', 'stopped', 'waiting-budget', 'batch-limit', 'breaker-open', 'queue-full', 'queue-unsaved', 'stage8-budget',
  // Phase 2, step 3a: main's branch rules do not hold it for a green, or a test merge is not the tested tree.
  'stage8-rules', 'role-probe-uncertain', 'role-probe-connection', 'role-probe-interrupted',
  // Status /7 (DESIGN §34): the two sides run different versions; the upgrade waits for the Owner's page approval, is deferred,
  // was rolled back (the node stays paused), or its rollback failed (the Owner must act).
  'version-skew', 'upgrade-grant-pending', 'upgrade-deferred', 'upgrade-rolled-back', 'upgrade-rollback-failed',
  // Task 4a: the node's own self-check (selfcheck.mjs) ran and failed.
  'selfcheck-failed',
  // Step 3c-2b: stage 10's decisions for the Owner (code: the decision).
  'train-owner',
  // Generation 12 (DESIGN §56.3): the claim of a running or parked batch is about to end (or has ended); its holder must renew.
  'lease-short',
  // M5 (ADR 0022 §4.5): no companion heartbeat 10 minutes after the service started (the notifier shows it at log-on).
  'companion-absent']);
// Generation 12 (DESIGN §56.3): how long the claim's lease must still run. A running batch needs what an average batch has left
// (LEASE_BATCH_ESTIMATE_MS from its start, an estimate only) and LEASE_MARGIN_MS for stage 8 and the merge; a batch parked at B
// needs LEASE_MARGIN_MS. Only a reminder: the admission of every stage checks the lease itself, and a renewal never voids a batch
// (the batch claim compares claim id, fence and epoch, not the lease end). expiresAt is Native's time, compared with this host's
// clock: the margin is far wider than the clock tolerance (DESIGN §47).
export const LEASE_MARGIN_MS = 30 * 60_000;
export const LEASE_BATCH_ESTIMATE_MS = 22 * 60_000;
// -> 'expired' | 'short' | null. running: the batch is in flight (since: its start, ms); else it rests at a parking point.
export function leaseShort({ expiresAt, now, running = false, since = null }) {
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now)) return null;
  if (expiresAt <= now) return 'expired';
  const left = running && Number.isSafeInteger(since) ? Math.max(0, since + LEASE_BATCH_ESTIMATE_MS - now) : 0;
  return expiresAt - now < left + LEASE_MARGIN_MS ? 'short' : null;
}
export const BREAKER_STATES = Object.freeze(['closed', 'open', 'half-open']);
export const NODE_MODES = Object.freeze(['ACTIVE', 'STANDBY', 'UNCERTAIN']);
export const PROBE_RESULTS = Object.freeze(['held', 'not-held', 'uncertain']);
const iso = ms => new Date(ms).toISOString();
const isoOrNull = v => (Number.isSafeInteger(v) && v > 0) ? iso(v) : (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? iso(Date.parse(v)) : null);
const codeOrNull = v => typeof v === 'string' && CODE.test(v) ? v : null;
const key12 = key => (typeof key === 'string' && HEX64.test(key)) ? key.slice(0, 12) : null;

export class StatusBoard {
  constructor({ clock = Date.now, pid = process.pid } = {}) {
    this.clock = clock;
    this.pid = pid;
    this.timing = new StageTimings({ clock });
    this.timingJson = null;
    this.content = { executor: { state: 'STARTING', since: iso(clock()), reason: null }, halt: null, paused: false, intakePause: null, node: null, backfill: { complete: false, published: null, unreadable: null },
      current: null, pending: [], recent: [], limits: null, queue: null, breaker: null, notices: [], train: { enabled: 'off', last: null }, versions: null };
    this.changedAt = iso(clock());
  }

  // Status /7: the versions view (readVersions); anything that does not fit is shown as nothing (null).
  setVersions(v) {
    return this.update({ versions: parseVersions(v) });
  }

  // Stage timings (stage-timing.mjs): the recorder is fed by the calls the executor already makes; changedAt moves when the written view does.
  restoreTiming(v) { return this.timing.restore(v); }
  stageDone(stage) { this.timing.stageDone(stage); this.touchTiming(); }
  stageRelay(stage, relayTiming) { this.timing.stageRelay(stage, relayTiming); this.touchTiming(); }
  noteTrain(facts) { if (this.timing.noteTrain(facts)) this.touchTiming(); }
  touchTiming() {
    const json = canonicalJson(this.timing.view());
    if (json === this.timingJson) return false;
    this.timingJson = json;
    this.changedAt = iso(this.clock());
    return true;
  }

  update(patch) {
    const next = { ...this.content, ...patch };
    if (canonicalJson(next) === canonicalJson(this.content)) return false;
    this.content = next;
    this.changedAt = iso(this.clock());
    return true;
  }

  // The executor's node (C3): its name, the Source it runs, its mode. The last probe stays as it was.
  setNode(name, source, mode) {
    if (!NODE_NAME.test(name ?? '') || !NODE_MODES.includes(mode)) return false;
    const node = this.content.node;
    return this.update({ node: { name, source: key12(source), mode, probe: node?.probe ?? null } });
  }

  // Observation only: a probe reply never changes the mode here (the executor does, through setNode). With no mode set it is UNCERTAIN.
  setRoleProbe(name, probe) {
    if (!NODE_NAME.test(name ?? '')) return false;
    const node = this.content.node;
    return this.update({ node: { name, source: node?.source ?? null, mode: node?.mode ?? 'UNCERTAIN', probe } });
  }

  // The executor's resting state after a tick; `since` moves only when the state or its reason changes.
  setState(state, reason = null) {
    check(EXECUTOR_STATES.includes(state), 'STATUS_STATE_INVALID');
    const r = typeof reason === 'string' && CODE.test(reason) ? reason : null;
    const e = this.content.executor;
    if (e.state === state && e.reason === r) return false;
    return this.update({ executor: { state, since: iso(this.clock()), reason: r, ...(e.companion ? { companion: e.companion } : {}) } });
  }

  // M5 (ADR 0022 §4.5): executor.companion.firstBeatAfterServiceStartMs (companion-presence.mjs). Inside `executor`, whose reader
  // takes only the keys it knows, so a reader of an earlier generation still accepts the file (a new top-level key would refuse it).
  setCompanion(view) {
    const ms = Number.isSafeInteger(view?.firstBeatAfterServiceStartMs) && view.firstBeatAfterServiceStartMs >= 0 ? view.firstBeatAfterServiceStartMs : null;
    const e = this.content.executor;
    if (e.companion && e.companion.firstBeatAfterServiceStartMs === ms) return false;
    return this.update({ executor: { ...e, companion: { firstBeatAfterServiceStartMs: ms } } });
  }

  // The batch in flight (null when none). stage: the stage number running now (0 = bundle/workspace, 9 = stage R).
  setCurrent(current) {
    if (!current) { this.timing.setCurrent(null); this.touchTiming(); return this.update({ current: null }); }
    const c = { key: key12(current.key), pr: current.pr, headSha: current.headSha, baseSha: current.baseSha, attempt: current.attempt,
      stage: Number.isSafeInteger(current.stage) ? current.stage : null, phase: typeof current.phase === 'string' ? current.phase.slice(0, 40) : null,
      since: current.since ?? iso(this.clock()), stageSince: iso(this.clock()), claimExpiresAt: isoOrNull(current.claimExpiresAt ?? null),
      leaseFrom: isoOrNull(current.leaseFrom ?? null) };
    this.timing.setCurrent({ pr: c.pr, headSha: c.headSha, attempt: c.attempt, stage: c.stage, phase: c.phase, since: c.since });
    this.touchTiming();
    return this.update({ current: c });
  }

  // The newest outcome per (PR, head, attempt), newest first, bounded.
  outcome({ pr, headSha, attempt = 1, outcome, code = null, klass = null, retry = null, key = null, pushedAt = null }) {
    if (!Number.isSafeInteger(pr) || !HEX40.test(headSha ?? '') || !RECENT_OUTCOMES.includes(outcome)) return false;
    if (this.timing.finish({ pr, headSha, attempt, outcome, code, pushedAt })) this.touchTiming();
    const entry = { pr, headSha, attempt, outcome, code: typeof code === 'string' && CODE.test(code) ? code : null,
      class: typeof klass === 'string' && /^[a-z0-9-]{1,40}$/.test(klass) ? klass : null, retry: typeof retry === 'string' && /^[a-z0-9-]{1,40}$/.test(retry) ? retry : null,
      key: key12(key), at: iso(this.clock()) };
    const rest = this.content.recent.filter(r => !(r.pr === pr && r.headSha === headSha && r.attempt === attempt));
    return this.update({ recent: [entry, ...rest].slice(0, RECENT_MAX) });
  }

  // The run queue's rows (queue.mjs#view). position: the place among the rows that may run now (null for a row that waits,
  // stopped or is done); eta: an estimate only.
  setPending(list) {
    return this.update({ pending: list.slice(0, PENDING_MAX).map((p, i) => ({ pr: p.pr, headSha: p.headSha, baseSha: p.baseSha,
      state: ROW_STATES.includes(p.state) ? p.state : 'QUEUED', position: Number.isSafeInteger(p.position) ? p.position : (p.state === undefined ? i + 1 : null),
      deferred: codeOrNull(p.reason ?? p.deferred), since: isoOrNull(p.firstAt ?? p.since), nextAt: isoOrNull(p.nextAt), eta: isoOrNull(p.eta),
      level: Number.isSafeInteger(p.level) ? p.level : 0, origin: typeof p.origin === 'string' && /^[a-z0-9-]{1,20}$/.test(p.origin) ? p.origin : null,
      stopKind: ['burned', 'release-cap'].includes(p.stopKind) ? p.stopKind : null,
      queuePosition: Number.isSafeInteger(p.queuePosition) ? p.queuePosition : null, claimExpiresAt: isoOrNull(p.claimExpiresAt ?? null), watched: p.watched === true, network: p.network === true,
      heldBy: codeOrNull(p.heldBy ?? null) })) });
  }

  snapshot() {
    return { contract: STATUS_CONTRACT, writtenAt: iso(this.clock()), changedAt: this.changedAt, pid: this.pid, ...this.content, timing: this.timing.view() };
  }
}

// Whole-file replacement: a reader sees the previous snapshot or the next one, never a mix.
export class StatusFile {
  constructor(file) { this.file = file; }
  async write(snapshot) {
    const bytes = Buffer.from(canonicalJson(snapshot) + '\n', 'utf8');
    check(bytes.length <= STATUS_MAX_BYTES, 'STATUS_TOO_LARGE');
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, this.file);
    return bytes.length;
  }
}

// The service's timer: rewrites the whole snapshot every intervalMs (writtenAt always moves), never two writes at once,
// never an exception out of the timer. flush() writes now (start, stop, a state change the caller wants out early).
// Generation 10 (DESIGN 53.5): a flush asked while a write is under way is not dropped: the running write writes the snapshot once more
// when it is done (the board may have changed in between), so an early flush never waits for the next 15 seconds.
export function startStatusTimer({ board, file, intervalMs = STATUS_REFRESH_MS, schedule = globalThis.setInterval, cancel = globalThis.clearInterval }) {
  let busy = false, again = false;
  const flush = async () => {
    if (busy) { again = true; return false; }
    busy = true;
    try {
      let ok = true;
      do { again = false; try { await file.write(board.snapshot()); } catch { ok = false; } } while (again);
      return ok;
    } finally { busy = false; }
  };
  const handle = schedule(() => flush(), intervalMs);
  handle?.unref?.();
  return { flush, stop: () => cancel(handle) };
}

// ---- the companion's reading (untrusted bytes in the resident's state, read-only for the Owner) ----
const TOP_V6 = ['contract', 'writtenAt', 'changedAt', 'pid', 'executor', 'halt', 'paused', 'intakePause', 'node', 'backfill', 'current', 'pending', 'recent', 'limits', 'queue', 'breaker', 'notices', 'train'];
const TOP_V7 = [...TOP_V6, 'versions'];
const TOP = [...TOP_V7, 'timing'];
const ms = v => (typeof v === 'string' && Number.isFinite(Date.parse(v))) ? Date.parse(v) : (Number.isSafeInteger(v) && v > 0 ? v : null);
export function parseStatus(bytes) {
  const v = parseBoundedJson(bytes, STATUS_MAX_BYTES, 'STATUS_REFUSED');
  check(v && typeof v === 'object' && STATUS_CONTRACTS_READABLE.includes(v.contract), 'STATUS_REFUSED');
  exactKeys(v, v.contract === STATUS_CONTRACT ? TOP : v.contract === STATUS_CONTRACT_V7 ? TOP_V7 : TOP_V6, 'STATUS_REFUSED');
  check(Number.isFinite(Date.parse(v.writtenAt)) && Number.isFinite(Date.parse(v.changedAt)), 'STATUS_REFUSED');
  check(v.executor && EXECUTOR_STATES.includes(v.executor.state), 'STATUS_REFUSED');
  const head = h => typeof h === 'string' && HEX40.test(h);
  return {
    writtenAt: Date.parse(v.writtenAt), changedAt: Date.parse(v.changedAt), pid: Number.isSafeInteger(v.pid) && v.pid > 0 ? v.pid : null,
    executor: { state: v.executor.state, since: Date.parse(v.executor.since) || null, reason: typeof v.executor.reason === 'string' && CODE.test(v.executor.reason) ? v.executor.reason : null,
      companion: { firstBeatAfterServiceStartMs: Number.isSafeInteger(v.executor.companion?.firstBeatAfterServiceStartMs) && v.executor.companion.firstBeatAfterServiceStartMs >= 0 ? v.executor.companion.firstBeatAfterServiceStartMs : null } },
    halt: v.halt && typeof v.halt.code === 'string' && CODE.test(v.halt.code) ? { code: v.halt.code, at: Date.parse(v.halt.at) || null } : null,
    paused: v.paused === true,
    // A hold whose end the reader cannot read is still a hold (the companion then shows it without an end).
    intakePause: v.intakePause && typeof v.intakePause === 'object' && !Array.isArray(v.intakePause)
      ? { until: ms(v.intakePause.until), holders: Array.isArray(v.intakePause.holders) ? v.intakePause.holders.filter(h => typeof h?.holder === 'string' && HOLDER.test(h.holder))
        .slice(0, INTAKE_HOLDS_MAX).map(h => ({ holder: h.holder, since: ms(h.since), until: ms(h.until) })) : [] } : null,
    // The node (C1, C3); null: one node. A name that does not fit is no node: the companion falls back to its own. source: /6 only.
    node: v.node && typeof v.node === 'object' && NODE_NAME.test(v.node.name ?? '')
      ? { name: v.node.name, source: NODE_SOURCE.test(v.node.source ?? '') ? v.node.source : null, mode: NODE_MODES.includes(v.node.mode) ? v.node.mode : 'UNCERTAIN',
        probe: v.node.probe && typeof v.node.probe === 'object' ? { at: ms(v.node.probe.at), result: PROBE_RESULTS.includes(v.node.probe.result) ? v.node.probe.result : 'uncertain',
          failures: Number.isSafeInteger(v.node.probe.failures) && v.node.probe.failures >= 0 ? v.node.probe.failures : 0, failingSince: ms(v.node.probe.failingSince) } : null } : null,
    backfill: { complete: v.backfill?.complete === true },
    current: v.current && Number.isSafeInteger(v.current.pr) && head(v.current.headSha)
      ? { pr: v.current.pr, headSha: v.current.headSha, attempt: v.current.attempt, stage: Number.isSafeInteger(v.current.stage) ? v.current.stage : null, since: Date.parse(v.current.since) || null,
        claimExpiresAt: ms(v.current.claimExpiresAt), leaseFrom: ms(v.current.leaseFrom) } : null,
    pending: Array.isArray(v.pending) ? v.pending.filter(p => Number.isSafeInteger(p?.pr) && head(p.headSha)).slice(0, PENDING_MAX)
      .map(p => ({ pr: p.pr, headSha: p.headSha, state: ROW_STATES.includes(p.state) ? p.state : 'QUEUED', position: Number.isSafeInteger(p.position) ? p.position : null,
        deferred: codeOrNull(p.deferred), since: ms(p.since), nextAt: ms(p.nextAt), eta: ms(p.eta), level: Number.isSafeInteger(p.level) ? p.level : 0,
        stopKind: ['burned', 'release-cap'].includes(p.stopKind) ? p.stopKind : null, queuePosition: Number.isSafeInteger(p.queuePosition) ? p.queuePosition : null,
        claimExpiresAt: ms(p.claimExpiresAt), watched: p.watched === true, network: p.network === true, heldBy: codeOrNull(p.heldBy ?? null) })) : [],
    recent: Array.isArray(v.recent) ? v.recent.filter(r => Number.isSafeInteger(r?.pr) && head(r.headSha) && RECENT_OUTCOMES.includes(r.outcome)).slice(0, RECENT_MAX)
      .map(r => ({ pr: r.pr, headSha: r.headSha, attempt: r.attempt, outcome: r.outcome, code: typeof r.code === 'string' && CODE.test(r.code) ? r.code : null,
        class: typeof r.class === 'string' && /^[a-z0-9-]{1,40}$/.test(r.class) ? r.class : null, retry: typeof r.retry === 'string' && /^[a-z0-9-]{1,40}$/.test(r.retry) ? r.retry : null,
        at: Date.parse(r.at) || null })) : [],
    limits: v.limits && Number.isSafeInteger(v.limits.batches24h) ? { batches24h: v.limits.batches24h, maxBatches: v.limits.maxBatches, evaluations24h: v.limits.evaluations24h, maxEvaluations: v.limits.maxEvaluations } : null,
    queue: v.queue && /^[0-9a-f]{12}$/.test(v.queue.generation ?? '') ? { generation: v.queue.generation, live: Number.isSafeInteger(v.queue.live) ? v.queue.live : null, parkingFull: v.queue.parkingFull === true,
      hold: codeOrNull(v.queue.hold ?? null) } : null,
    breaker: v.breaker && BREAKER_STATES.includes(v.breaker.state) ? { state: v.breaker.state, nextTrialAt: ms(v.breaker.nextTrialAt), openedAt: ms(v.breaker.openedAt),
      cause: v.breaker.cause === 'network' ? 'network' : null } : null,
    notices: Array.isArray(v.notices) ? v.notices.filter(n => n && NOTICE_KINDS.includes(n.kind) && typeof n.key === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(n.key)).slice(0, NOTICES_MAX)
      .map(n => ({ key: n.key, kind: n.kind, pr: Number.isSafeInteger(n.pr) ? n.pr : null, headSha: head(n.headSha) ? n.headSha : null, code: codeOrNull(n.code), at: ms(n.at), until: ms(n.until) })) : [],
    train: trainOf(v.train),
    // /7 only; /6 has none. Read with the same rules as written (parseVersions), so what does not fit is null, never a refusal.
    versions: v.contract === STATUS_CONTRACT || v.contract === STATUS_CONTRACT_V7 ? parseVersions(v.versions) : null,
    // /8 only; older files have none. What does not fit is null, never a refusal (a view of times, nothing decides on it).
    timing: v.contract === STATUS_CONTRACT ? parseTiming(v.timing) : null,
  };
}

// `train` as the reader returns it: the mode and the newest summary always; sweep, revokeHead, onSince and notOnDuty only
// when the snapshot has a value for them.
function trainOf(t) {
  const out = { enabled: ['off', 'shadow', 'on'].includes(t?.enabled) ? t.enabled : null, last: parseTrainLast(t?.last) };
  const sweep = parseTrainSweep(t?.sweep), revokeHead = parseRevokeHead(t?.revokeHead), onSince = ms(t?.onSince);
  if (sweep) out.sweep = sweep;
  // Defect 15894c2a: the nodes the newest on-mode run compared (train.mjs#trainNodesView); read by the upgrade precheck.
  const nodes = parseTrainNodes(t?.nodes);
  if (nodes) out.nodes = nodes;
  if (revokeHead) out.revokeHead = revokeHead;
  if (onSince) out.onSince = onSince;
  if (t?.notOnDuty === true) out.notOnDuty = true;
  // Generation 16: readiness is narrower than a completed full sweep. These are
  // display facts only; the executor and Source independently check authority.
  if (['blocked', 'strict-coverage', 'strict-current-front', 'full-sweep', 'strict-permanent'].includes(t?.frontReadyMode)) out.frontReadyMode = t.frontReadyMode;
  // DESIGN §65: the policy's train.sweep (strict-permanent mode is 'audit' or 'off'); the companion's ruleset backstop reads it.
  if (['gate', 'audit', 'off'].includes(t?.sweepMode)) out.sweepMode = t.sweepMode;
  // ADR 0018: the policy's train.landing (github-merge: GitHub merges after the merge-slot green; push: the train lands main itself).
  if (['github-merge', 'push'].includes(t?.landing)) out.landing = t.landing;
  for (const k of ['fullPending', 'backgroundAllPending']) if (typeof t?.[k] === 'boolean') out[k] = t[k];
  for (const k of ['maintenanceExtraUsed', 'maintenanceExtraLimit'])
    if (Number.isSafeInteger(t?.[k]) && t[k] >= 0 && t[k] <= 200) out[k] = t[k];
  return out;
}

// ---- status /7 `versions` (in-place upgrade channel, Task 018da927, DESIGN §34) ----
// Files the executor reads every tick (each one leniently: a file that is missing, torn or of another shape is "unknown", never an
// error and never a HALT; the view only shows and the version-skew hold only acts on consistent === false):
//   upgrade\current.json                             the generation the upgrader (or the install's generation-1 step) last made current;
//   upgrade\mailbox\responses\version-facts.json     the Linux side's facts, written by the companion (upgrade-mailbox.mjs /1);
//   upgrade\status.json                              the upgrader's own status (clued.independent-ci.resident-upgrade-status/1).
export const UPGRADE_STATES = UPGRADE_OP_STATES;
export const VERSION_FILE_MAX_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PHASE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// The Owner's confirm page (confirmOrigin + confirm_path, A2): https only, no credentials, no spaces or quotes, bounded.
export const CONFIRM_URL = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?\/[A-Za-z0-9._~\/?=&%#-]{0,400}$/;
const generationOf = v => (Number.isSafeInteger(v) && v >= 1 ? v : null);
const hexOrNull = v => (typeof v === 'string' && HEX64.test(v) ? v : null);
const isoMs = v => { const t = ms(v); return t === null ? null : iso(t); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The view as the board keeps it and the reader returns it: every field re-checked, null for what does not fit.
export function parseVersions(v) {
  if (!plain(v) || !plain(v.windows) || !HEX64.test(v.windows.residentManifestSha256 ?? '') || !HEX64.test(v.windows.ciSourceManifestSha256 ?? '')) return null;
  const l = plain(v.linux) ? v.linux : null;
  const u = plain(v.upgrade) && UUID.test(v.upgrade.opId ?? '') && UPGRADE_STATES.includes(v.upgrade.state) ? v.upgrade : null;
  return {
    generation: generationOf(v.generation),
    windows: { packageManifestSha256: hexOrNull(v.windows.packageManifestSha256), residentManifestSha256: v.windows.residentManifestSha256,
      ciSourceManifestSha256: v.windows.ciSourceManifestSha256, policySha256: hexOrNull(v.windows.policySha256) },
    linux: l ? { observedAt: isoMs(l.observedAt), generation: generationOf(l.generation), ciSourceManifestSha256: hexOrNull(l.ciSourceManifestSha256),
      manifestSha256: hexOrNull(l.manifestSha256), pinsOk: l.pinsOk === true } : null,
    consistent: [true, false].includes(v.consistent) ? v.consistent : null,
    // Task 4a: the node's self-check (selfcheck.mjs); null before the first one. Only shown, nothing decides on it.
    selfcheck: parseSelfcheckView(v.selfcheck),
    upgrade: u ? { opId: u.opId, state: u.state, phase: typeof u.phase === 'string' && PHASE.test(u.phase) ? u.phase : null, since: isoMs(u.since),
      code: codeOrNull(u.code), confirmUrl: typeof u.confirmUrl === 'string' && CONFIRM_URL.test(u.confirmUrl) ? u.confirmUrl : null } : null,
  };
}

async function readJsonLenient(file) {
  try { return JSON.parse((await readBounded(file, VERSION_FILE_MAX_BYTES, 'VERSION_FILE_REFUSED')).toString('utf8')); } catch { return null; }
}

// The three files of one root as raw values (null for a file that cannot be read now).
export async function readVersionInputs(root) {
  const upgrade = path.join(root, 'upgrade');
  const [current, facts, status] = await Promise.all([readJsonLenient(path.join(upgrade, 'current.json')),
    readJsonLenient(path.join(upgrade, 'mailbox', 'responses', VERSION_FACTS_FILE)), readJsonLenient(path.join(upgrade, 'status.json'))]);
  const selfcheck = await readSelfcheck(path.join(upgrade, 'mailbox', 'responses'));
  return { selfcheck, current: plain(current) && current.contract === GENERATION_CURRENT_CONTRACT ? current : null,
    facts: plain(facts) && facts.contract === LINUX_VERSION_FACTS_CONTRACT ? facts : null,
    status: plain(status) && status.contract === UPGRADE_STATUS_CONTRACT ? status : null };
}

// The view from the raw values. windows: what this executor runs (its policy and the policy's own hash), never taken from a file.
// consistent: upgrade-mailbox.mjs#consistent (B1, frozen /1); without a current.json (a node installed before the channel, or
// one whose current.json cannot be read now) nothing is compared and it is null: the version-skew hold never acts on "unknown".
export function versionsView({ current, facts, status, selfcheck = null }, { policy, policySha256 = null, now = Date.now() }) {
  let agreed = null;
  if (current && facts) { try { const c = versionsConsistent(current, facts, now); agreed = [true, false].includes(c) ? c : null; } catch { agreed = null; } }
  const op = plain(status?.op) ? status.op : null;
  return parseVersions({
    generation: current?.generation ?? null,
    windows: { packageManifestSha256: current?.packageManifestSha256 ?? null, residentManifestSha256: policy.residentManifestSha256,
      ciSourceManifestSha256: policy.ciSourceManifestSha256, policySha256 },
    linux: facts ? { observedAt: facts.observedAt, generation: facts.generation, ciSourceManifestSha256: facts.ciSourceManifestSha256, manifestSha256: facts.manifestSha256, pinsOk: facts.pinsOk } : null,
    consistent: agreed,
    selfcheck: selfcheckView(selfcheck, now),
    upgrade: op ? { opId: op.opId, state: op.state, phase: op.phase, since: op.phaseSince, code: op.code, confirmUrl: op.grant?.confirmUrl ?? null } : null,
  });
}

// The executor's port (service-main.mjs): { view, notices } of one root, read now. The engine's gate before the first Linux stage
// uses the view only.
export async function readVersionState({ root, policy, policySha256 = null, clock = Date.now }) {
  const inputs = await readVersionInputs(root);
  const view = versionsView(inputs, { policy, policySha256, now: clock() });
  return { view, notices: versionNotices(view, inputs.status) };
}

// The upgrade's notices (one key per fact, so the companion shows each once): the two sides disagree; the op in upgrade\status.json
// waits for the Owner's page approval or is deferred; an op (current or among the recent ones) ended rolled back or with a failed
// rollback. No free text: codes, generations and the op id only.
export function versionNotices(view, upgradeStatus = null) {
  const out = [];
  if (!view) return out;
  const failed = selfcheckNotice(view.selfcheck);
  if (failed) out.push(failed);
  if (view.consistent === false) out.push({ key: `version-skew:w${view.generation ?? 'x'}:l${view.linux?.generation ?? 'x'}`, kind: 'version-skew', pr: null, headSha: null, code: 'UPGRADE_VERSION_SKEW', at: view.linux?.observedAt ?? null, until: null });
  const u = view.upgrade;
  if (u?.state === 'WAITING_GRANT') out.push({ key: `upgrade-grant-pending:${u.opId}`, kind: 'upgrade-grant-pending', pr: null, headSha: null, code: null, at: u.since, until: null });
  if (u?.state === 'DEFERRED') out.push({ key: `upgrade-deferred:${u.opId}:${u.code ?? 'x'}`, kind: 'upgrade-deferred', pr: null, headSha: null, code: u.code, at: u.since, until: null });
  const ended = [];
  if (u && ['ROLLED_BACK_PAUSED', 'ROLLBACK_FAILED'].includes(u.state)) ended.push({ opId: u.opId, outcome: u.state, code: u.code, at: u.since });
  for (const r of Array.isArray(upgradeStatus?.recent) ? upgradeStatus.recent.slice(0, 10) : []) {
    if (plain(r) && UUID.test(r.opId ?? '') && ['ROLLED_BACK_PAUSED', 'ROLLBACK_FAILED'].includes(r.outcome)) ended.push({ opId: r.opId, outcome: r.outcome, code: codeOrNull(r.code), at: isoMs(r.at) });
  }
  const seen = new Set();
  for (const e of ended) {
    const kind = e.outcome === 'ROLLED_BACK_PAUSED' ? 'upgrade-rolled-back' : 'upgrade-rollback-failed';
    const key = `${kind}:${e.opId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind, pr: null, headSha: null, code: e.code, at: e.at, until: null });
  }
  return out;
}

// One bounded read (the writer may rename a new snapshot in at any moment: a read that loses that race fails and the
// next pass reads again).
export async function readStatus(root) {
  return parseStatus(await readBounded(path.join(root, 'state', STATUS_FILE), STATUS_MAX_BYTES, 'STATUS_REFUSED'));
}
