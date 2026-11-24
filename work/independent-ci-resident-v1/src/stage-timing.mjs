// Stage timings in the resident's status (optimisation plan P1, Clued bf57ff10; status contract /8).
//
// A VIEW, never evidence (like status.json itself): the status board feeds this recorder from the calls the executor already makes
// (setCurrent at every stage / phase change, stageDone at every stage-terminal receipt, stageRelay with a scanner stage's relay
// facts, outcome, noteTrain), and the recorder turns them into millisecond sums per batch:
//   prep           reservation (current.since) -> the batch is derived (prepMs: what the admission, stage 1, waits for; Task f79929d9: no
//                  longer the bundle), and derive / bundle / workspace separately. prep.bundle is there only for a batch that built one:
//                  after stage 1, right before its workspaces, a batch with a local role (rebundle: older records only);
//   stages[n]      ms: the sum of every run of stage n (retries and stage-8 tries add up), runs, waitMs (retry waits);
//                  relay (stages with a Linux worker only): handoffs { n, ms, maxMs } = the companion's relay calls (issue, challenge,
//                  response, result) and rounds = each admission challenge round's ms (challenge sighted -> response sent);
//   activeMs       the sum of all of it (a batch that rests at A or B does not count its rest); spanMs: start -> end, rests included.
// Stage 10 runs outside batches: train.rounds (ms of each run and, when its sweep facts allow, the sweep's share scanMs).
// pushToGreen: for each COMPLETED batch, the queue row's first sighting of the head (the push, as far as the resident can see it)
// -> the end of stage 8; the day's figures are those whose end falls in the current UTC day.
//
// Persistence: the board writes `done` (newest finished batches) and `open` (batches that rest, not finished) into status.json; the
// service reads them back on start (restore), so a restart loses at most the interval that was open.
// Statistics: over the newest STATS_N finished batches; median = middle value (mean of the two middle ones, rounded); P90 = nearest
// rank (the ceil(0.9 n)-th smallest). Only values that were measured enter (a batch that never ran stage 4 adds nothing to stage 4).
import { CODE, HEX40 } from './canonical.mjs';

export const TIMING_DONE_MAX = 40;
export const TIMING_OPEN_MAX = 20;
export const TIMING_STATS_N = 20;
export const TRAIN_ROUNDS_MAX = 20;
export const RELAY_ROUNDS_MAX = 16;
export const DONE_BYTES_MAX = 80_000;
export const OPEN_MAX_AGE_MS = 3 * 86_400_000;
export const STAGE_KEYS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
export const PREP_KEYS = Object.freeze(['derive', 'bundle', 'workspace', 'rebundle']);
export const RELAY_MODES = Object.freeze(['SendIssue', 'ReceiveChallenge', 'SendResponse', 'ReceiveResult', 'ReceiveBlocked']);
export const RELAY_TIMING_CONTRACT = 'clued.independent-ci.relay-timing/1';
const MS_MAX = 7 * 86_400_000;

const isMs = v => Number.isSafeInteger(v) && v >= 0 && v <= MS_MAX;
const msOrNull = v => (isMs(v) ? v : null);
const iso = ms => new Date(ms).toISOString();
const isoOrNull = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? iso(Date.parse(v)) : null);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const dayOf = ms => iso(ms).slice(0, 10);

// ---- statistics ----
export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}
export function p90(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length === 0 ? null : v[Math.ceil(0.9 * v.length) - 1];
}
const figures = values => ({ n: values.length, medianMs: median(values), p90Ms: p90(values) });

// ---- the companion's relay record (companion.mjs#pump -> mailbox.mjs#writeTiming; the service reads it back leniently) ----
// File shape: { contract, requestId, handoffs: [{ mode, seq, ms }], rounds: [{ seq, ms }] } -> { handoffs: { n, ms, maxMs }, rounds: [ms...] } | null.
export function parseRelayTiming(v) {
  if (!plain(v) || v.contract !== RELAY_TIMING_CONTRACT || !Array.isArray(v.handoffs) || !Array.isArray(v.rounds)) return null;
  const hs = v.handoffs.slice(0, 400).filter(h => plain(h) && RELAY_MODES.includes(h.mode) && isMs(h.ms));
  const rs = v.rounds.slice(0, RELAY_ROUNDS_MAX).filter(r => plain(r) && isMs(r.ms));
  return { handoffs: { n: hs.length, ms: hs.reduce((a, h) => a + h.ms, 0), maxMs: hs.reduce((a, h) => Math.max(a, h.ms), 0) }, rounds: rs.map(r => r.ms) };
}
const relayOf = v => {
  if (!plain(v) || !plain(v.handoffs) || !Array.isArray(v.rounds)) return null;
  const { n, ms, maxMs } = v.handoffs;
  if (![n, ms, maxMs].every(isMs)) return null;
  return { handoffs: { n, ms, maxMs }, rounds: v.rounds.slice(0, RELAY_ROUNDS_MAX).filter(isMs) };
};

// ---- one batch's record ----
const stageOf = v => {
  if (!plain(v) || !isMs(v.ms) || !isMs(v.runs)) return null;
  const s = { ms: v.ms, runs: v.runs, waitMs: isMs(v.waitMs) ? v.waitMs : 0 };
  const relay = relayOf(v.relay);
  if (relay) s.relay = relay;
  return s;
};
export function parseRecord(v) {
  if (!plain(v) || !Number.isSafeInteger(v.pr) || v.pr <= 0 || !HEX40.test(v.headSha ?? '') || !Number.isSafeInteger(v.attempt) || v.attempt < 0) return null;
  const startedAt = isoOrNull(v.startedAt);
  if (!startedAt) return null;
  const stages = {};
  for (const k of STAGE_KEYS) { const s = stageOf(v.stages?.[k]); if (s) stages[k] = s; }
  const prep = {};
  for (const k of [...PREP_KEYS, 'waitMs', 'other']) if (isMs(v.prep?.[k])) prep[k] = v.prep[k];
  return { pr: v.pr, headSha: v.headSha, attempt: v.attempt, startedAt, endedAt: isoOrNull(v.endedAt),
    outcome: typeof v.outcome === 'string' && /^[A-Z_]{1,24}$/.test(v.outcome) ? v.outcome : null, code: typeof v.code === 'string' && CODE.test(v.code) ? v.code : null,
    prepMs: msOrNull(v.prepMs), activeMs: isMs(v.activeMs) ? v.activeMs : 0, spanMs: msOrNull(v.spanMs), pushToGreenMs: msOrNull(v.pushToGreenMs), prep, stages };
}
const idOf = r => `${r.pr}:${r.headSha}:${r.attempt}`;
const blank = (c, now) => ({ pr: c.pr, headSha: c.headSha, attempt: Number.isSafeInteger(c.attempt) ? c.attempt : 1,
  startedAt: isoOrNull(c.since) ?? iso(now), endedAt: null, outcome: null, code: null, prepMs: null, activeMs: 0, spanMs: null, pushToGreenMs: null, prep: {}, stages: {} });

// ---- the statistics of the newest finished batches ----
export function statsOf(done, n = TIMING_STATS_N) {
  const w = done.slice(0, n);
  const col = pick => w.map(pick).filter(Number.isFinite);
  const segments = { prep: figures(col(r => r.prepMs ?? NaN)) };
  for (const k of STAGE_KEYS) segments[k] = figures(col(r => r.stages[k]?.ms ?? NaN));
  const completed = w.filter(r => r.outcome === 'COMPLETED');
  segments.active = figures(completed.map(r => r.activeMs));
  return { window: n, n: w.length, segments };
}
export function pushToGreenOf(done, now) {
  const day = dayOf(now);
  const v = done.filter(r => r.outcome === 'COMPLETED' && r.pushToGreenMs !== null && r.endedAt && dayOf(Date.parse(r.endedAt)) === day).map(r => r.pushToGreenMs);
  return v.length === 0 ? { day, n: 0, medianMs: null, p90Ms: null, maxMs: null } : { day, ...figures(v), maxMs: Math.max(...v) };
}

// ---- the recorder ----
export class StageTimings {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.open = new Map();   // id -> record, batches not finished (running, or resting at A / B)
    this.done = [];          // finished records, newest first
    this.cur = null;         // { id, stage, phase, from }: the interval that is open now (none between a stage's end and the next stage)
    this.flight = null;      // id of the batch in flight (board.current), whatever the interval
    this.rounds = [];        // stage 10: newest first
  }

  // The batch in flight (board.setCurrent): a new stage or phase closes the interval before it and opens the next; null closes it.
  setCurrent(c) {
    const now = this.clock();
    if (!c || !Number.isSafeInteger(c.pr) || !HEX40.test(c.headSha ?? '')) { this.close(now); this.flight = null; return; }
    const id = idOf({ pr: c.pr, headSha: c.headSha, attempt: Number.isSafeInteger(c.attempt) ? c.attempt : 1 });
    const stage = Number.isSafeInteger(c.stage) ? c.stage : null, phase = typeof c.phase === 'string' ? c.phase : null;
    if (this.cur && this.cur.id === id && this.cur.stage === stage && this.cur.phase === phase) return;
    this.close(now);
    if (!this.open.has(id)) { this.open.set(id, blank(c, now)); this.prune(now); }
    this.flight = id;
    this.cur = { id, stage, phase, from: now };
  }

  // Adds the open interval's length to its batch and leaves the batch open (no interval is open afterwards).
  close(now) {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    const r = this.open.get(c.id);
    if (!r) return;
    const dt = Math.max(0, now - c.from);
    if (c.phase === 'relay-wait' || c.phase === null) return; // the batch rests: nothing runs
    if (c.phase === 'stage' && c.stage !== null && c.stage >= 1 && c.stage <= 9) {
      const s = (r.stages[String(c.stage)] ??= { ms: 0, runs: 0, waitMs: 0 });
      s.ms += dt; s.runs += 1;
    } else if (c.phase === 'retry-wait') {
      if (c.stage !== null && c.stage >= 1 && c.stage <= 9) (r.stages[String(c.stage)] ??= { ms: 0, runs: 0, waitMs: 0 }).waitMs += dt;
      else r.prep.waitMs = (r.prep.waitMs ?? 0) + dt;
    } else {
      const k = PREP_KEYS.includes(c.phase) ? c.phase : 'other';
      r.prep[k] = (r.prep[k] ?? 0) + dt;
      if (c.phase === 'derive' && r.prepMs === null) r.prepMs = Math.max(0, now - Date.parse(r.startedAt));
    }
    r.activeMs += dt;
  }

  // A stage-terminal receipt was written: the stage's own interval ends here, not at the next stage (the work between stages is not the stage's).
  stageDone(stage) {
    if (this.cur && this.cur.phase === 'stage' && this.cur.stage === stage) this.close(this.clock());
  }

  // A scanner stage's relay facts (engine-windows.mjs#invokeStage -> result.relayTiming): attached to the stage of the batch in flight.
  stageRelay(stage, relayTiming) {
    const relay = relayOf(relayTiming);
    const r = this.flight ? this.open.get(this.flight) : null;
    if (!relay || !r || !Number.isSafeInteger(stage) || stage < 1 || stage > 9) return;
    const s = (r.stages[String(stage)] ??= { ms: 0, runs: 0, waitMs: 0 });
    // Runs add up like the stage's time: handoffs sum, rounds append (newest bounded).
    const old = s.relay;
    s.relay = old ? { handoffs: { n: old.handoffs.n + relay.handoffs.n, ms: old.handoffs.ms + relay.handoffs.ms, maxMs: Math.max(old.handoffs.maxMs, relay.handoffs.maxMs) },
      rounds: [...old.rounds, ...relay.rounds].slice(-RELAY_ROUNDS_MAX) } : relay;
  }

  // A terminal outcome of a batch (board.outcome). Outcomes of a head that never had a batch here (IGNORED before reserving) add nothing.
  // pushedAt: the head's first sighting (ms), for COMPLETED only.
  finish({ pr, headSha, attempt, outcome, code = null, pushedAt = null }) {
    const now = this.clock();
    const id = idOf({ pr, headSha, attempt: Number.isSafeInteger(attempt) ? attempt : 1 });
    if (this.cur?.id === id) this.close(now);
    const r = this.open.get(id);
    if (!r) return false;
    this.open.delete(id);
    if (this.flight === id) this.flight = null;
    r.outcome = outcome; r.code = typeof code === 'string' && CODE.test(code) ? code : null; r.endedAt = iso(now);
    r.spanMs = Math.max(0, now - Date.parse(r.startedAt));
    if (outcome === 'COMPLETED' && Number.isFinite(pushedAt) && pushedAt <= now) r.pushToGreenMs = now - pushedAt;
    this.done = [r, ...this.done.filter(d => idOf(d) !== id)].slice(0, TIMING_DONE_MAX);
    return true;
  }

  // One stage-10 run: its length, and (from the run's sweep facts, when the sweep's span overlaps the run) the share spent scanning.
  noteTrain({ startedAt, endedAt, mode = null, sweep = null }) {
    if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endedAt) || endedAt < startedAt) return false;
    const f = sweep?.fullSweep ?? null;
    const from = Date.parse(f?.startedAt ?? ''), to = f?.completedAt ? Date.parse(f.completedAt) : (f?.state === 'running' ? endedAt : NaN);
    const scanMs = Number.isFinite(from) && Number.isFinite(to) && to >= startedAt ? Math.max(0, Math.min(to, endedAt) - Math.max(from, startedAt)) : null;
    this.rounds = [{ at: iso(endedAt), ms: endedAt - startedAt, scanMs: msOrNull(scanMs), mode: ['shadow', 'on', 'revoke-only'].includes(mode) ? mode : null }, ...this.rounds].slice(0, TRAIN_ROUNDS_MAX);
    return true;
  }

  // Batches that never ended (a crash, a file moved) do not stay forever.
  prune(now) {
    for (const [id, r] of this.open) if (now - Date.parse(r.startedAt) > OPEN_MAX_AGE_MS && this.flight !== id) this.open.delete(id);
    while (this.open.size > TIMING_OPEN_MAX) this.open.delete(this.open.keys().next().value);
  }

  // The written view: `done` and `open` are what restore() reads back; the rest is for readers (parseTiming).
  view() {
    const now = this.clock();
    const live = [...this.open.entries()];
    const cur = this.flight ? this.open.get(this.flight) : null;
    const iv = this.cur && this.cur.id === this.flight && this.cur.phase !== 'relay-wait' && this.cur.phase !== null ? this.cur : null;
    const current = cur ? { pr: cur.pr, headSha: cur.headSha, attempt: cur.attempt, startedAt: cur.startedAt, openedAt: iv ? iso(iv.from) : null,
      stage: this.cur?.stage ?? null, phase: this.cur?.phase ?? null, activeMs: cur.activeMs, prepMs: cur.prepMs, prep: cur.prep, stages: cur.stages } : null;
    const rounds = this.rounds;
    return { last: this.done[0] ?? null, current, stats: statsOf(this.done), pushToGreen: pushToGreenOf(this.done, now),
      train: { n: rounds.length, ...figures(rounds.map(r => r.ms)), scan: figures(rounds.map(r => r.scanMs).filter(Number.isFinite)), last: rounds[0] ?? null, rounds: rounds.slice(0, 10) },
      done: this.boundedDone(), open: live.map(([, r]) => r).slice(-TIMING_OPEN_MAX) };
  }

  // The snapshot is one bounded file (status.mjs STATUS_MAX_BYTES): if the finished records grow past DONE_BYTES_MAX the oldest are left out of the view.
  boundedDone() {
    let done = this.done;
    while (done.length > 10 && JSON.stringify(done).length > DONE_BYTES_MAX) done = done.slice(0, done.length - 5);
    return done;
  }

  // The service's start: the previous snapshot's done / open / train rounds, each re-checked; whatever does not fit is dropped.
  restore(v) {
    if (!plain(v)) return false;
    const done = (Array.isArray(v.done) ? v.done : []).slice(0, TIMING_DONE_MAX).map(parseRecord).filter(r => r && r.endedAt);
    this.done = done;
    this.open = new Map((Array.isArray(v.open) ? v.open : []).slice(-TIMING_OPEN_MAX).map(parseRecord).filter(Boolean).map(r => [idOf(r), r]));
    this.rounds = (Array.isArray(v.train?.rounds) ? v.train.rounds : []).slice(0, TRAIN_ROUNDS_MAX).filter(r => plain(r) && isMs(r.ms) && isoOrNull(r.at))
      .map(r => ({ at: iso(Date.parse(r.at)), ms: r.ms, scanMs: msOrNull(r.scanMs), mode: ['shadow', 'on', 'revoke-only'].includes(r.mode) ? r.mode : null }));
    this.cur = null; this.flight = null;
    return true;
  }
}

// ---- the reader's copy (status.mjs#parseStatus): ms for times, null for what does not fit; never a refusal ----
const figOf = f => (plain(f) ? { n: isMs(f.n) ? f.n : 0, medianMs: msOrNull(f.medianMs), p90Ms: msOrNull(f.p90Ms) } : { n: 0, medianMs: null, p90Ms: null });
const timeOf = v => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };
const recordView = r => {
  const p = parseRecord(r);
  return p ? { ...p, startedAt: Date.parse(p.startedAt), endedAt: p.endedAt ? Date.parse(p.endedAt) : null } : null;
};
export function parseTiming(t) {
  if (!plain(t)) return null;
  const segments = {};
  for (const k of ['prep', ...STAGE_KEYS, 'active']) segments[k] = figOf(t.stats?.segments?.[k]);
  const cur = t.current;
  const current = plain(cur) && Number.isSafeInteger(cur.pr) && HEX40.test(cur.headSha ?? '') ? (() => {
    const p = parseRecord({ ...cur, startedAt: cur.startedAt });
    return p ? { pr: p.pr, headSha: p.headSha, attempt: p.attempt, startedAt: Date.parse(p.startedAt), openedAt: timeOf(cur.openedAt), activeMs: p.activeMs, prepMs: p.prepMs, prep: p.prep, stages: p.stages,
      stage: Number.isSafeInteger(cur.stage) ? cur.stage : null } : null;
  })() : null;
  const tr = t.train, last = plain(tr?.last) && isMs(tr.last.ms) && timeOf(tr.last.at) !== null ? { at: timeOf(tr.last.at), ms: tr.last.ms, scanMs: msOrNull(tr.last.scanMs) } : null;
  const g = t.pushToGreen;
  return {
    last: recordView(t.last), current,
    stats: { window: isMs(t.stats?.window) ? t.stats.window : TIMING_STATS_N, n: isMs(t.stats?.n) ? t.stats.n : 0, segments },
    pushToGreen: plain(g) && /^\d{4}-\d{2}-\d{2}$/.test(g.day ?? '') ? { day: g.day, ...figOf(g), maxMs: msOrNull(g.maxMs) } : null,
    train: plain(tr) ? { ...figOf(tr), scan: figOf(tr.scan), last } : null,
  };
}
