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
import fs from 'node:fs/promises';
import path from 'node:path';
import { CODE, HEX40, HEX64, canonicalJson, check, exactKeys, parseBoundedJson } from './canonical.mjs';
import { readBounded } from './store.mjs';
import { HOLDER, INTAKE_HOLDS_MAX } from './intake-pause.mjs';
import { parseTrainLast } from './train.mjs';
import { NODE_NAME, NODE_SOURCE } from './node-duty.mjs';

export const STATUS_CONTRACT = 'clued.independent-ci.resident-status/6';
// What the reader accepts: /5 and /6 have the same top-level keys (/6 only adds node.source), so the install window, in which the
// new companion may read the old executor's last snapshot, shows what that executor wrote instead of "unreadable".
export const STATUS_CONTRACTS_READABLE = Object.freeze(['clued.independent-ci.resident-status/5', STATUS_CONTRACT]);
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
  'stage8-rules', 'role-probe-uncertain', 'role-probe-connection']);
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
    this.content = { executor: { state: 'STARTING', since: iso(clock()), reason: null }, halt: null, paused: false, intakePause: null, node: null, backfill: { complete: false, published: null, unreadable: null },
      current: null, pending: [], recent: [], limits: null, queue: null, breaker: null, notices: [], train: { enabled: 'off', last: null } };
    this.changedAt = iso(clock());
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
    return this.update({ executor: { state, since: iso(this.clock()), reason: r } });
  }

  // The batch in flight (null when none). stage: the stage number running now (0 = bundle/workspace, 9 = stage R).
  setCurrent(current) {
    if (!current) return this.update({ current: null });
    const c = { key: key12(current.key), pr: current.pr, headSha: current.headSha, baseSha: current.baseSha, attempt: current.attempt,
      stage: Number.isSafeInteger(current.stage) ? current.stage : null, phase: typeof current.phase === 'string' ? current.phase.slice(0, 40) : null,
      since: current.since ?? iso(this.clock()), stageSince: iso(this.clock()) };
    return this.update({ current: c });
  }

  // The newest outcome per (PR, head, attempt), newest first, bounded.
  outcome({ pr, headSha, attempt = 1, outcome, code = null, klass = null, retry = null, key = null }) {
    if (!Number.isSafeInteger(pr) || !HEX40.test(headSha ?? '') || !RECENT_OUTCOMES.includes(outcome)) return false;
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
      queuePosition: Number.isSafeInteger(p.queuePosition) ? p.queuePosition : null })) });
  }

  snapshot() {
    return { contract: STATUS_CONTRACT, writtenAt: iso(this.clock()), changedAt: this.changedAt, pid: this.pid, ...this.content };
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
export function startStatusTimer({ board, file, intervalMs = STATUS_REFRESH_MS, schedule = globalThis.setInterval, cancel = globalThis.clearInterval }) {
  let busy = false;
  const flush = async () => {
    if (busy) return false;
    busy = true;
    try { await file.write(board.snapshot()); return true; } catch { return false; } finally { busy = false; }
  };
  const handle = schedule(() => flush(), intervalMs);
  handle?.unref?.();
  return { flush, stop: () => cancel(handle) };
}

// ---- the companion's reading (untrusted bytes in the resident's state, read-only for the Owner) ----
const TOP = ['contract', 'writtenAt', 'changedAt', 'pid', 'executor', 'halt', 'paused', 'intakePause', 'node', 'backfill', 'current', 'pending', 'recent', 'limits', 'queue', 'breaker', 'notices', 'train'];
const ms = v => (typeof v === 'string' && Number.isFinite(Date.parse(v))) ? Date.parse(v) : (Number.isSafeInteger(v) && v > 0 ? v : null);
export function parseStatus(bytes) {
  const v = parseBoundedJson(bytes, STATUS_MAX_BYTES, 'STATUS_REFUSED');
  exactKeys(v, TOP, 'STATUS_REFUSED');
  check(STATUS_CONTRACTS_READABLE.includes(v.contract) && Number.isFinite(Date.parse(v.writtenAt)) && Number.isFinite(Date.parse(v.changedAt)), 'STATUS_REFUSED');
  check(v.executor && EXECUTOR_STATES.includes(v.executor.state), 'STATUS_REFUSED');
  const head = h => typeof h === 'string' && HEX40.test(h);
  return {
    writtenAt: Date.parse(v.writtenAt), changedAt: Date.parse(v.changedAt),
    executor: { state: v.executor.state, since: Date.parse(v.executor.since) || null, reason: typeof v.executor.reason === 'string' && CODE.test(v.executor.reason) ? v.executor.reason : null },
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
      ? { pr: v.current.pr, headSha: v.current.headSha, attempt: v.current.attempt, stage: Number.isSafeInteger(v.current.stage) ? v.current.stage : null, since: Date.parse(v.current.since) || null } : null,
    pending: Array.isArray(v.pending) ? v.pending.filter(p => Number.isSafeInteger(p?.pr) && head(p.headSha)).slice(0, PENDING_MAX)
      .map(p => ({ pr: p.pr, headSha: p.headSha, state: ROW_STATES.includes(p.state) ? p.state : 'QUEUED', position: Number.isSafeInteger(p.position) ? p.position : null,
        deferred: codeOrNull(p.deferred), since: ms(p.since), nextAt: ms(p.nextAt), eta: ms(p.eta), level: Number.isSafeInteger(p.level) ? p.level : 0,
        stopKind: ['burned', 'release-cap'].includes(p.stopKind) ? p.stopKind : null, queuePosition: Number.isSafeInteger(p.queuePosition) ? p.queuePosition : null })) : [],
    recent: Array.isArray(v.recent) ? v.recent.filter(r => Number.isSafeInteger(r?.pr) && head(r.headSha) && RECENT_OUTCOMES.includes(r.outcome)).slice(0, RECENT_MAX)
      .map(r => ({ pr: r.pr, headSha: r.headSha, attempt: r.attempt, outcome: r.outcome, code: typeof r.code === 'string' && CODE.test(r.code) ? r.code : null,
        class: typeof r.class === 'string' && /^[a-z0-9-]{1,40}$/.test(r.class) ? r.class : null, retry: typeof r.retry === 'string' && /^[a-z0-9-]{1,40}$/.test(r.retry) ? r.retry : null,
        at: Date.parse(r.at) || null })) : [],
    limits: v.limits && Number.isSafeInteger(v.limits.batches24h) ? { batches24h: v.limits.batches24h, maxBatches: v.limits.maxBatches, evaluations24h: v.limits.evaluations24h, maxEvaluations: v.limits.maxEvaluations } : null,
    queue: v.queue && /^[0-9a-f]{12}$/.test(v.queue.generation ?? '') ? { generation: v.queue.generation, live: Number.isSafeInteger(v.queue.live) ? v.queue.live : null, parkingFull: v.queue.parkingFull === true } : null,
    breaker: v.breaker && BREAKER_STATES.includes(v.breaker.state) ? { state: v.breaker.state, nextTrialAt: ms(v.breaker.nextTrialAt), openedAt: ms(v.breaker.openedAt) } : null,
    notices: Array.isArray(v.notices) ? v.notices.filter(n => n && NOTICE_KINDS.includes(n.kind) && typeof n.key === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(n.key)).slice(0, NOTICES_MAX)
      .map(n => ({ key: n.key, kind: n.kind, pr: Number.isSafeInteger(n.pr) ? n.pr : null, headSha: head(n.headSha) ? n.headSha : null, code: codeOrNull(n.code), at: ms(n.at), until: ms(n.until) })) : [],
    train: { enabled: ['off', 'shadow', 'on'].includes(v.train?.enabled) ? v.train.enabled : null, last: parseTrainLast(v.train?.last) },
  };
}

// One bounded read (the writer may rename a new snapshot in at any moment: a read that loses that race fails and the
// next pass reads again).
export async function readStatus(root) {
  return parseStatus(await readBounded(path.join(root, 'state', STATUS_FILE), STATUS_MAX_BYTES, 'STATUS_REFUSED'));
}
