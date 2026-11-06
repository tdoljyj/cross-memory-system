// Read-only: the shadow review before the merge train is switched on (DESIGN §41.9 step 3, §22.2 item 5; Task 67b41719).
//   node train-shadow-review.mjs --receipts <resident state\receipts> [--shadow <train-shadow folder or its export>]
//     [--status <status.json>] [--pulls <pulls.json>] [--queue-markers <markers.json>] [--since <iso>] [--now <iso>]
//     [--nodes <expected node count, default 2>] [--accept-abandoned <sweep start, ISO> (repeatable)] [--json] [--no-verify]
// It reads the resident's receipt chain (train-run, batch-*, ...), the stage-10 shadow records (state\v2\train-shadow: readable by
// clued-control and Administrators only, so run elevated or point --shadow at an export) and optional exports of public facts, and prints
// ONE page for the Owner: whether the shadow observation gate of Task 67b41719 is met (each condition 满足 / 不满足 / 数据不够, with its
// evidence), the statistics the design asks for, and what is missing. Nothing is written, moved, repaired or switched; the only effect is the
// text on stdout. A condition whose data is absent or unreadable is 数据不够 (or 不满足), never 满足.
//
// Gate (Owner Decision 21072374, 2026-11-01): at least 1 hour AND at least 3 real front PRs of shadow observation by a Source whose full
// sweep works; the full sweep completes and repeats; no abnormal stop. The window starts at --since (the install of that Source).
// The Owner's reading of "repeats" (Clued Decision 合并列车开车口径, 2026-11-06): at least MIN_FULL_SWEEPS completed full sweeps inside the
// window, and every sweep that was abandoned or replaced inside it is explained by slow pacing (it ran out the fullSweepMaxMs clock) and not
// by an error (a failed segment or any other abandonment reason). An abandonment that the records cannot tie to the clock is NOT explained.
// The same Decision: the GitHub recompute delay is not required before the train starts (still printed when it can be computed), the
// second place's wait is the queue_marker residence (--queue-markers), the 6-hour full-sweep cap stays as it is.
//
// --accept-abandoned  records the Owner's ruling that ONE abandoned full sweep, named by its start time as the page prints it, is acceptable (an
//                     incomplete read that failed closed). Only a sweep that was abandoned and is not already explained by the clock is affected;
//                     the page shows the ruling next to the sweep, and a start time that matches nothing is reported, not ignored.
// --pulls    JSON { "<pr>": { "mergedAt": iso } }                       (gh api repos/<repo>/pulls/<pr> --jq '{mergedAt: .merged_at}')
// --queue-markers JSON [ { "leftQueuedAt": iso, "headLeftAt": iso } ]   (merge_measurement_events_v1, kind queue_marker, payload; read-only SQL)
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReceiptChain } from '../src/receipts.mjs';

export const REVIEW_CONTRACT = 'clued.independent-ci.train-shadow-review/1';
export const MIN_WINDOW_MS = 3_600_000;
export const MIN_FRONT_PRS = 3;
export const MIN_FULL_SWEEPS = 2;
export const FULL_SWEEP_MAX_MS = 21_600_000;   // the resident's policy default fullSweepMaxMs (6 hours); the records do not carry it
const EXPIRY_REASONS = new Set(['TRAIN_FULL_SWEEP_EXPIRED']);
export const OWNER_RULING = 'Owner 2026-11-06 裁定可接受';
export const NODE_STALE_MS = 1_800_000; // three heartbeat intervals (DESIGN §41.6a)
const RECEIPT_NAME = /^(\d{8})-([a-z0-9-]{1,48})\.json$/;
const SHADOW_NAME = /^(\d{13})-([0-9a-f]{16}-[0-9a-f]{12})\.json$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA40 = /^[0-9a-f]{40}$/, SHA64 = /^[0-9a-f]{64}$/;
// A front PR that really was the front: the decisions after "the holder's PR is runnable" (train-facts.mjs WOULD_DO). FRONT_NOT_RUNNABLE
// (closed, draft, not on main), FRONT_AMBIGUOUS and FRONT_NOT_BOUND name a holder but not a PR that went through the front.
const FRONT_DECISIONS = new Set(['FRONT_NEEDS_MAIN_MERGE', 'FRONT_TEST_MERGE_NOT_READY', 'FRONT_GREEN_WAIT_MERGE', 'OPEN_FRONT_BATCH']);
const SWEEP_KINDS = new Set(['none', 'incremental', 'full-segment']), SWEEP_STATES = new Set(['none', 'running', 'complete', 'abandoned']);
export const MET = '满足', NOT_MET = '不满足', INSUFFICIENT = '数据不够';

const ms = v => (typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const iso = t => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const sorted = a => [...a].sort((x, y) => x - y);
const median = a => { if (!a.length) return null; const s = sorted(a), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v, d = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const minutes = t => (t === null || !Number.isFinite(t) ? null : round(t / 60_000, 1));
const countBy = (items, key) => { const out = {}; for (const i of items) { const k = String(key(i)); out[k] = (out[k] ?? 0) + 1; } return out; };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : null);
const text = v => String(v).replaceAll('|', '/').replaceAll('\n', ' ');
const fail = (code, detail) => { throw Object.assign(new Error(code), { code, ...(detail ? { detail } : {}) }); };

async function listJson(dir, pattern) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return entries.filter(e => e.isFile() && pattern.test(e.name)).map(e => e.name).sort();
}

// Every receipt: the open segment in receipts\ and the sealed months in receipts\archive\<segment>\ (DESIGN §41.7). Files whose name fits
// but whose content does not are counted (and shown on the page), never fatal; a seq seen twice keeps the first.
export async function loadReceipts(dir) {
  const roots = [dir];
  try { for (const s of (await fs.readdir(path.join(dir, 'archive'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) roots.push(path.join(dir, 'archive', s)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bySeq = new Map();
  let unreadable = 0;
  for (const root of roots) {
    const names = await listJson(root, RECEIPT_NAME);
    if (names === null) { if (root === dir) return { receipts: [], unreadable: 0, missing: true }; continue; }
    for (const name of names) {
      const m = RECEIPT_NAME.exec(name);
      try {
        const value = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
        if (!plain(value) || value.seq !== Number(m[1]) || value.type !== m[2] || ms(value.at) === null) { unreadable += 1; continue; }
        if (!bySeq.has(value.seq)) bySeq.set(value.seq, { seq: value.seq, type: value.type, at: ms(value.at), body: plain(value.body) ? value.body : {} });
      } catch { unreadable += 1; }
    }
  }
  return { receipts: [...bySeq.values()].sort((a, b) => a.seq - b.seq), unreadable, missing: false };
}

// The facts of one shadow record reduced to the typed fields this tool reads; anything of the wrong type becomes null / absent, so a
// damaged record can neither crash the report nor add up as garbage. Facts /1 (no sweep, no nodes) and /2 are both fine.
export function sanitizeFacts(f) {
  const sweep = plain(f.sweep) && SWEEP_KINDS.has(f.sweep.kind) ? { kind: f.sweep.kind, complete: typeof f.sweep.complete === 'boolean' ? f.sweep.complete : null, calls: int(f.sweep.calls) ?? 0, ms: int(f.sweep.ms) ?? 0,
    fullSweep: plain(f.sweep.fullSweep) ? { state: SWEEP_STATES.has(f.sweep.fullSweep.state) ? f.sweep.fullSweep.state : 'none', startedAt: ms(f.sweep.fullSweep.startedAt) === null ? null : f.sweep.fullSweep.startedAt,
      completedAt: ms(f.sweep.fullSweep.completedAt) === null ? null : f.sweep.fullSweep.completedAt, reason: str(f.sweep.fullSweep.reason, 80) } : null } : null;
  const front = plain(f.front) ? { pr: int(f.front.pr), headSha: SHA40.test(f.front.headSha ?? '') ? f.front.headSha : null, green: typeof f.front.green === 'boolean' ? f.front.green : null,
    testMergeParentsOk: typeof f.front.testMergeParentsOk === 'boolean' ? f.front.testMergeParentsOk : null } : null;
  return { contract: str(f.contract, 80), mode: str(f.mode, 20), mainSha: SHA40.test(f.mainSha ?? '') ? f.mainSha : null, wouldDo: str(f.wouldDo, 80), rulesReason: str(f.rulesReason, 80), front, sweep,
    wouldRevokeCount: int(f.wouldRevokeCount),
    wouldRevoke: Array.isArray(f.wouldRevoke) ? f.wouldRevoke.filter(w => plain(w) && SHA40.test(w.headSha ?? '') && Number.isSafeInteger(w.checkRunId) && w.checkRunId > 0)
      .map(w => ({ headSha: w.headSha, checkRunId: w.checkRunId, pr: int(w.pr), phase: str(w.phase, 40) })) : [],
    nodes: Array.isArray(f.nodes) ? f.nodes.filter(plain).slice(0, 64).map(n => ({ node: str(n.node), sourceManifestSha256: SHA64.test(n.sourceManifestSha256 ?? '') ? n.sourceManifestSha256 : null,
      state: str(n.state, 40), lastHeartbeatAt: ms(n.lastHeartbeatAt) === null ? null : n.lastHeartbeatAt })) : null };
}

// The shadow records ({ runId, facts }, one create-only file per stage-10 run). A *.tmp file (a write in flight) is ignored by the name.
export async function loadShadow(dir) {
  const names = await listJson(dir, SHADOW_NAME);
  if (names === null) return { records: [], unreadable: 0, missing: true };
  const records = [];
  let unreadable = 0;
  for (const name of names) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      const at = plain(value?.facts) ? ms(value.facts.at) : null;
      if (!plain(value?.facts) || typeof value.runId !== 'string' || at === null || !String(value.facts.contract ?? '').startsWith('clued.independent-ci.train-facts/')) { unreadable += 1; continue; }
      records.push({ runId: value.runId, at, facts: sanitizeFacts(value.facts) });
    } catch { unreadable += 1; }
  }
  return { records: records.sort((a, b) => a.at - b.at), unreadable, missing: false };
}

async function readJson(file, name, shape) {
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('INPUT_UNREADABLE', name); }
  if (shape === 'object' ? !plain(value) : !Array.isArray(value)) fail('INPUT_SHAPE_INVALID', name);
  return value;
}

// ---- statistics (pure) ----------------------------------------------------------------------------------------------------------

function windowStats(trainRuns, since, now) {
  const inWin = trainRuns.filter(r => (since === null || r.at >= since) && r.at <= now && (r.body.mode ?? 'shadow') === 'shadow');
  const duty = inWin.filter(r => r.body.wouldDo !== 'NOT_ON_DUTY');   // a standby node's runs observe nothing
  const times = duty.map(r => r.at).sort((a, b) => a - b);
  const first = times[0] ?? null, last = times.at(-1) ?? null;
  const gaps = times.slice(1).map((t, i) => t - times[i]);   // dropouts are normal (the run is skipped while a batch runs); shown, not gated
  const fronts = new Map();
  for (const r of inWin) if (Number.isSafeInteger(r.body.frontPr) && FRONT_DECISIONS.has(r.body.wouldDo)) fronts.set(r.body.frontPr, [...(fronts.get(r.body.frontPr) ?? []), r.at]);
  return { inWin, runs: inWin.length, dutyRuns: duty.length, firstRunAt: first, lastRunAt: last, observedMs: first === null ? 0 : last - Math.max(first, since ?? first),
    maxGapMs: gaps.reduce((m, g) => Math.max(m, g), 0),
    frontPrs: [...fronts.keys()].sort((a, b) => a - b), frontLast: Object.fromEntries([...fronts].map(([pr, at]) => [pr, at.reduce((m, t) => Math.max(m, t), 0)])), frontRuns: Object.fromEntries([...fronts].map(([pr, at]) => [pr, at.length])),
    wouldDo: countBy(inWin, r => r.body.wouldDo ?? 'null'), failures: inWin.filter(r => r.body.ok === false) };
}

function wouldRevokeStats(runs, shadowRuns) {
  const counts = runs.map(r => r.body.wouldRevokeCount).filter(Number.isSafeInteger);
  const unique = new Map();
  let capped = false;
  for (const s of shadowRuns) {
    for (const w of s.facts.wouldRevoke) unique.set(`${w.headSha}:${w.checkRunId}`, w);
    if (s.facts.wouldRevokeCount !== null && s.facts.wouldRevokeCount > s.facts.wouldRevoke.length) capped = true;   // the record lists at most 20
  }
  return { runs: counts.length, perRun: countBy(counts.map(c => ({ c })), x => x.c), max: counts.reduce((m, c) => Math.max(m, c), 0) || (counts.length ? 0 : null), latest: counts.at(-1) ?? null,
    nonZeroRuns: counts.filter(c => c > 0).length, uniqueGreens: shadowRuns.length ? [...unique.values()].sort((a, b) => a.checkRunId - b.checkRunId) : null, uniqueGreensCapped: capped };
}

// Batches from the receipts: reserved (key -> pr, head, attempt) joined with the terminal / unexecuted receipt of the same key.
// First run of a head = its attempt-1 batch (looked up over ALL receipts, so --since cannot turn an attempt 2 into a first run). A head
// counts for the front only if it was reserved before its PR was last seen at the front: the receipts carry no front head, so a head
// pushed after the PR left the front is not mistaken for a front run (an approximation, stated on the page).
function batchStats(receipts, since, now, window) {
  const reservedAll = new Map();
  for (const r of receipts) {
    const s = r.body?.subject;
    if (r.type === 'batch-reserved' && r.at <= now && plain(s) && Number.isSafeInteger(s.pr) && SHA40.test(s.headSha ?? '') && typeof r.body.key === 'string') reservedAll.set(r.body.key, { at: r.at, pr: s.pr, headSha: s.headSha, attempt: s.attempt });
  }
  const outcome = new Map();
  for (const r of receipts) {
    if (typeof r.body?.key !== 'string') continue;
    if (r.at > now) continue;
    if (r.type === 'batch-terminal') outcome.set(r.body.key, { outcome: str(r.body.outcome, 40) ?? 'UNKNOWN', code: str(r.body.failureCode, 80) });
    else if (r.type === 'batch-unexecuted' && !outcome.has(r.body.key)) outcome.set(r.body.key, { outcome: 'UNEXECUTED', code: str(r.body.failureCode, 80) });
  }
  const inWin = [...reservedAll.values()].filter(b => since === null || b.at >= since);
  const heads = new Map();
  for (const b of inWin) heads.set(b.pr, new Set([...(heads.get(b.pr) ?? []), b.headSha]));
  const firstOfHead = new Map();
  for (const [key, b] of reservedAll) {
    if (b.attempt !== 1 || !(b.pr in window.frontLast) || b.at > window.frontLast[b.pr]) continue;
    const k = `${b.pr}:${b.headSha}`;
    if (!firstOfHead.has(k) || firstOfHead.get(k).at > b.at) firstOfHead.set(k, { ...b, key });
  }
  // UNEXECUTED (the batch never ran) and SUPERSEDED_AT_SAFE_POINT (the head was replaced) say nothing about the head's own first run.
  const classify = key => {
    const o = outcome.get(key);
    if (!o) return 'PENDING';
    if (o.outcome === 'COMPLETED') return 'PASS';
    if (o.outcome === 'UNEXECUTED' || o.code === 'SUPERSEDED_AT_SAFE_POINT') return 'NOT_RUN';
    return 'FAIL';
  };
  const frontFirsts = [...firstOfHead.values()].filter(b => since === null || b.at >= since).map(b => ({ pr: b.pr, headSha: b.headSha, result: classify(b.key), outcome: outcome.get(b.key)?.code ?? outcome.get(b.key)?.outcome ?? null }));
  const decided = frontFirsts.filter(b => b.result === 'PASS' || b.result === 'FAIL');
  const failed = decided.filter(b => b.result === 'FAIL').length;
  const headCounts = [...heads.values()].map(s => s.size);
  const frontHeads = new Map();   // like the first-run join: only heads reserved before the PR's last front run
  for (const b of inWin) if (b.pr in window.frontLast && b.at <= window.frontLast[b.pr]) frontHeads.set(b.pr, new Set([...(frontHeads.get(b.pr) ?? []), b.headSha]));
  const frontHeadCounts = [...frontHeads.values()].map(s => s.size);
  const maxOf = a => a.reduce((m, v) => Math.max(m, v), 0);
  return { batches: inWin.length, prs: heads.size, headsPerPr: { mean: round(mean(headCounts)), max: headCounts.length ? maxOf(headCounts) : null },
    headsPerFrontPr: { mean: round(mean(frontHeadCounts)), max: frontHeadCounts.length ? maxOf(frontHeadCounts) : null },
    frontFirstRun: { heads: frontFirsts.length, notRun: frontFirsts.filter(b => b.result === 'NOT_RUN').length, decided: decided.length, failed,
      rate: decided.length ? round(failed / decided.length, 3) : null, detail: frontFirsts } };
}

// Front green to merge: the start of the last unbroken run of FRONT_GREEN_WAIT_MERGE for a PR (a re-green after a new head restarts it) to
// GitHub's merge time. The 10-minute run cadence means the green is seen up to one interval late, so the gap is a lower bound.
function greenToMerge(runs, pulls) {
  const green = new Map();
  let prevGreen = null;   // any run that is not this PR's green (no front, another PR, not green) ends the streak
  for (const r of [...runs].sort((a, b) => a.at - b.at)) {
    const pr = r.body.frontPr;
    if (Number.isSafeInteger(pr) && r.body.wouldDo === 'FRONT_GREEN_WAIT_MERGE') { if (prevGreen !== pr) green.set(pr, r.at); prevGreen = pr; } else prevGreen = null;
  }
  const greenSeen = [...green.keys()].sort((a, b) => a - b);
  if (!greenSeen.length) return { samples: [], greenSeen, unmerged: 0, note: 'no front was seen green in the window' };
  if (!pulls) return { samples: null, greenSeen, note: 'pull merge times not supplied (--pulls)' };
  const samples = [];
  for (const [pr, at] of green) { const merged = ms(pulls[String(pr)]?.mergedAt); if (merged !== null && merged >= at) samples.push({ pr, greenSeenAt: iso(at), mergedAt: iso(merged), gapMin: minutes(merged - at) }); }
  const gaps = samples.map(s => s.gapMin);
  return { samples, greenSeen, unmerged: greenSeen.length - samples.length, median: median(gaps), max: gaps.reduce((m, g) => Math.max(m, g), 0) || (gaps.length ? 0 : null),
    note: 'lower bound: the green is seen up to one run interval late; PRs merged before the first run that saw them green have no sample' };
}

function queueResidence(markers, since, now) {
  if (!Array.isArray(markers)) return null;
  const waits = [];
  let dropped = 0;
  for (const m of markers) {
    const left = plain(m) ? ms(m.headLeftAt) : null, queued = plain(m) ? ms(m.leftQueuedAt) : null;
    if (left === null || queued === null || left < queued) { dropped += 1; continue; }
    if ((since !== null && left < since) || left > now) continue;
    waits.push(left - queued);
  }
  return { samples: waits.length, dropped, medianMin: minutes(median(waits)), maxMin: minutes(waits.length ? waits.reduce((m, w) => Math.max(m, w), 0) : null) };
}

// GitHub's recompute delay: main moved (mainSha differs from the previous run's) while a front is bound; how long until the front's test
// merge is [main, head] again (testMergeParentsOk). Resolution is the run interval.
function recomputeDelay(shadowRuns) {
  const samples = [];
  let prev = null, pending = null;
  for (const s of shadowRuns) {
    const f = s.facts, front = f.front;
    if (pending && (!front || front.pr !== pending.pr || front.headSha !== pending.headSha)) pending = null;
    if (prev && f.mainSha && prev.facts.mainSha && f.mainSha !== prev.facts.mainSha && front?.headSha && front.green !== true) pending = { pr: front.pr, headSha: front.headSha, since: s.at };
    if (pending && front?.testMergeParentsOk === true) { samples.push({ pr: pending.pr, delayMin: minutes(s.at - pending.since) }); pending = null; }
    prev = s;
  }
  const d = samples.map(x => x.delayMin);
  return { samples: samples.length, medianMin: median(d), maxMin: d.length ? d.reduce((m, v) => Math.max(m, v), 0) : null };
}

function sweepStats(shadowRuns, since, status, now, accepted = []) {
  const runs = shadowRuns.filter(s => s.facts.sweep?.kind === 'full-segment' && s.facts.sweep.fullSweep && (since === null || s.at >= since));
  const byStart = new Map();
  for (const s of runs) {
    const fsw = s.facts.sweep.fullSweep, key = fsw.startedAt ?? `run:${s.runId}`;
    const e = byStart.get(key) ?? { startedAt: fsw.startedAt, segments: 0, calls: 0, activeMs: 0, state: 'running', completedAt: null, reason: null, stalled: false };
    e.segments += 1; e.calls = Math.min(Number.MAX_SAFE_INTEGER, e.calls + s.facts.sweep.calls); e.activeMs = Math.min(Number.MAX_SAFE_INTEGER, e.activeMs + s.facts.sweep.ms);
    // a run of a still-running sweep whose sweep did not complete (the incremental part failed), or that does not say: the sweep may be stuck, not slow
    if (fsw.state === 'running' && s.facts.sweep.complete !== true) e.stalled = true;
    if (fsw.state === 'complete' || fsw.state === 'abandoned') { e.state = fsw.state; e.completedAt = fsw.completedAt ?? iso(s.at); e.reason = fsw.reason; e.endAt = s.at; }
    byStart.set(key, e);
  }
  // The resident abandons an expired shadow sweep and starts the next one in the same run, so the records may never show "abandoned":
  // a sweep still 'running' when a later one began was replaced without finishing.
  const list = [...byStart.values()];
  list.forEach((e, i) => { if (e.state === 'running' && i < list.length - 1) { e.state = 'abandoned'; e.reason = 'REPLACED_WITHOUT_FINISHING'; } });
  // Why a sweep was abandoned: EXPIRED = it ran out the fullSweepMaxMs clock (slow pacing: the sweep needs a fixed number of segments and
  // too few runs happened in time) and none of its runs reported a failed sweep; anything else (a failed segment, an early replacement, a
  // sweep that was stuck on errors, ...) is not explained by the clock. The resident expires a sweep only when it is OLDER than the cap.
  list.forEach((e, i) => {
    if (e.state !== 'abandoned') return;
    const next = list[i + 1], end = EXPIRY_REASONS.has(e.reason) ? (e.endAt ?? null) : e.reason === 'REPLACED_WITHOUT_FINISHING' && next ? ms(next.startedAt) : null;
    const span = end !== null && ms(e.startedAt) !== null ? end - ms(e.startedAt) : null;
    e.cause = !e.stalled && span !== null && span > FULL_SWEEP_MAX_MS ? 'EXPIRED' : 'NOT_EXPLAINED';
  });
  // The last sweep still running past the cap (plus three run intervals: the resident replaces an expired sweep at its next run): no run has
  // abandoned it, so the sweeping has stopped, which is not slow pacing either. Needs a --now that is really "now" (or the time of the copy).
  const tail = list[list.length - 1];
  if (tail?.state === 'running' && ms(tail.startedAt) !== null && now - ms(tail.startedAt) > FULL_SWEEP_MAX_MS + NODE_STALE_MS) { tail.state = 'abandoned'; tail.reason = 'RUNNING_PAST_CAP'; tail.cause = 'NOT_EXPLAINED'; }
  // the Owner's ruling on a named abandonment (the wording of the page: Owner 2026-11-06 裁定可接受)
  const acceptSet = new Set(accepted);
  list.forEach(e => { if (e.state === 'abandoned' && e.cause === 'NOT_EXPLAINED' && acceptSet.has(ms(e.startedAt))) e.cause = 'ACCEPTED'; });
  const sweeps = list.map(e => ({ ...e, wallMin: e.state === 'complete' && ms(e.completedAt) !== null && ms(e.startedAt) !== null ? minutes(ms(e.completedAt) - ms(e.startedAt)) : null, activeMin: minutes(e.activeMs) }));
  const live = status?.train?.last?.sweep?.fullSweep ?? null, liveDone = ms(status?.train?.sweep?.fullCompletedAt);
  return { fromShadow: runs.length > 0, sweeps, completed: sweeps.filter(s => s.state === 'complete').length, abandoned: sweeps.filter(s => s.state === 'abandoned').length,
    abandonedReasons: countBy(sweeps.filter(s => s.state === 'abandoned'), s => s.reason ?? 'none'),
    abandonedExpired: sweeps.filter(s => s.state === 'abandoned' && s.cause === 'EXPIRED').length,
    abandonedAccepted: sweeps.filter(s => s.state === 'abandoned' && s.cause === 'ACCEPTED').map(s => ({ startedAt: s.startedAt, reason: s.reason ?? 'none' })),
    acceptedUnmatched: [...acceptSet].filter(t => !sweeps.some(s => s.cause === 'ACCEPTED' && ms(s.startedAt) === t)).map(iso),
    abandonedNotExplained: sweeps.filter(s => s.state === 'abandoned' && s.cause !== 'EXPIRED' && s.cause !== 'ACCEPTED').map(s => ({ startedAt: s.startedAt, reason: s.reason ?? 'none', stalled: s.stalled })), running: sweeps.filter(s => s.state === 'running').length,
    statusFile: status ? { shadow: (str(status.train?.last?.mode, 20) ?? 'shadow') === 'shadow' && str(status.train?.enabled, 20) === 'shadow', state: str(live?.state, 20), startedAt: str(live?.startedAt, 40), lastCompletedAt: iso(liveDone) } : null };
}

function nodeStats(shadowRuns, now) {
  const last = [...shadowRuns].reverse().find(s => Array.isArray(s.facts.nodes));
  if (!last) return null;
  const nodes = last.facts.nodes.map(n => ({ node: n.node, source: n.sourceManifestSha256 ? n.sourceManifestSha256.slice(0, 12) : null, state: n.state, lastHeartbeatAt: n.lastHeartbeatAt,
    ageMin: n.lastHeartbeatAt === null ? null : minutes(Math.max(0, now - ms(n.lastHeartbeatAt))) }));
  const heard = nodes.filter((n, i) => n.node !== null && nodes.findIndex(m => m.node === n.node) === i);   // one entry per node name
  return { at: iso(last.at), nodes, heard: heard.length, stale: heard.filter(n => n.ageMin === null || n.ageMin * 60_000 > NODE_STALE_MS).map(n => n.node),
    sources: [...new Set(heard.filter(n => n.source).map(n => n.source))], withoutSource: heard.filter(n => !n.source).map(n => n.node) };
}

function anomalies(receipts, window, since, now) {
  const inRange = receipts.filter(r => (since === null || r.at >= since) && r.at <= now);
  const byKind = Object.fromEntries(['halt', 'breaker-opened', 'service-stop', 'service-stop-prior-boot', 'bridge-pump-lost'].map(k => [k, inRange.filter(r => r.type === k).length]));
  // an intent no train-run closes (stage 10 died or was stopped); only the newest intent of all may simply still be running
  const intents = receipts.filter(r => r.type === 'train-run-intent'), newest = intents.at(-1);
  const closed = new Set(receipts.filter(r => r.type === 'train-run').map(r => r.body.intentSeq));
  const interrupted = inRange.filter(r => r.type === 'train-run-intent' && !closed.has(r.seq) && !(r === newest && now - r.at < 3_600_000)).length;
  const interruptedRuns = window.failures.filter(r => r.body.failureCode === 'TRAIN_STAGE_INTERRUPTED').length;
  return { receiptsByKind: byKind, stage10Failures: window.failures.map(r => ({ at: iso(r.at), code: str(r.body.failureCode, 80) })), intentsWithoutClose: interrupted, interruptedRuns };
}

// ---- the gate -------------------------------------------------------------------------------------------------------------------

function gate({ since, window, sweep, anomaly, stats, nodes, shadowSweepRuns, chain, unreadable, expectNodes }) {
  const rows = [];
  const add = (id, label, verdict, evidence) => rows.push({ id, text: label, verdict, evidence });
  add('GC', '回执链完整、输入文件都读得出', chain.status === 'broken' || unreadable.receipts + unreadable.shadow > 0 ? NOT_MET : chain.status === 'ok' ? MET : INSUFFICIENT,
    `回执链：${chain.text}；读不出的回执 ${unreadable.receipts} 个、影子记录 ${unreadable.shadow} 个`);
  if (since === null) add('G0', '观察窗口起点（修复后 Source 的安装时刻）已确定', INSUFFICIENT, '没有给 --since；窗口起点要由安装记录确定，以下按全部可读回执计，仅供参考');
  add('G1', '影子观察不少于 1 小时（只数本节点当班的运行）', window.dutyRuns === 0 ? INSUFFICIENT : window.observedMs >= MIN_WINDOW_MS ? MET : NOT_MET,
    `${window.runs} 次第 10 段运行（当班 ${window.dutyRuns} 次），${iso(window.firstRunAt)} → ${iso(window.lastRunAt)}，共 ${minutes(window.observedMs)} 分钟（运行之间最长间隔 ${minutes(window.maxGapMs)} 分钟，只显示不判定）`);
  add('G2', `至少 ${MIN_FRONT_PRS} 个真实队首 PR 经过（第 10 段判定到“车头可运行”及之后）`, window.dutyRuns === 0 ? INSUFFICIENT : window.frontPrs.length >= MIN_FRONT_PRS ? MET : NOT_MET,
    `${window.frontPrs.length} 个：${window.frontPrs.map(p => `#${p}`).join(' ') || '无'}`);
  const statusDone = since !== null && sweep.statusFile?.shadow && sweep.statusFile.lastCompletedAt && ms(sweep.statusFile.lastCompletedAt) >= since;
  const done = sweep.completed;
  add('G3', '完整全量扫描至少完成 1 次', done >= 1 ? MET : statusDone && !shadowSweepRuns ? MET : shadowSweepRuns && sweep.abandoned > 0 && sweep.running === 0 ? NOT_MET : INSUFFICIENT,
    shadowSweepRuns ? `影子记录里完成 ${done} 次、放弃 ${sweep.abandoned} 次、进行中 ${sweep.running} 次` : `没有全量扫描的影子记录；状态文件：${sweep.statusFile ? `${sweep.statusFile.state ?? '?'}，上次完成 ${sweep.statusFile.lastCompletedAt ?? '无'}（状态文件只记最近一次）` : '未提供'}`);
  const unexplained = sweep.abandonedNotExplained;
  add('G4', `全量扫描重复执行（窗口内完成 ≥ ${MIN_FULL_SWEEPS} 次，每次放弃或被替换都能解释为跑满 ${FULL_SWEEP_MAX_MS / 3_600_000} 小时上限的节奏慢，而不是错误）——Owner 口径`,
    !shadowSweepRuns ? INSUFFICIENT : done >= MIN_FULL_SWEEPS ? (unexplained.length === 0 ? MET : NOT_MET) : INSUFFICIENT,
    shadowSweepRuns ? `完成 ${done} 次；放弃/被替换 ${sweep.abandoned} 次${sweep.abandoned ? `，其中 ${sweep.abandonedExpired} 次是跑满上限（节奏慢）、${sweep.abandonedAccepted.length ? `${sweep.abandonedAccepted.length} 次按 ${OWNER_RULING}（${sweep.abandonedAccepted.map(u => `${u.startedAt} ${u.reason}`).join('；')}）、` : ''}${unexplained.length} 次记录里看不出是节奏慢${unexplained.length ? `：${unexplained.map(u => `${u.startedAt ?? '起点未知'} ${u.reason}${u.stalled ? '（期间有运行没扫完，可能卡在错误上）' : ''}`).join('；')}` : ''}` : ''}${sweep.acceptedUnmatched.length ? `；注意：裁定里的起点 ${sweep.acceptedUnmatched.join('、')} 在窗口内没有对应的放弃记录，没有生效` : ''}${done < MIN_FULL_SWEEPS ? `；窗口内还要再完成 ${MIN_FULL_SWEEPS - done} 次（一轮扫描最长 ${FULL_SWEEP_MAX_MS / 3_600_000} 小时，完成后隔 ${FULL_SWEEP_MAX_MS / 3_600_000} 小时才再开一轮）` : ''}` : '没有影子记录，数不出完成次数');
  const halted = anomaly.receiptsByKind.halt + anomaly.receiptsByKind['service-stop-prior-boot'] + anomaly.intentsWithoutClose + anomaly.interruptedRuns;
  add('G5', '窗口内第 10 段没有 HALT / 中断', window.runs === 0 ? INSUFFICIENT : halted === 0 ? MET : NOT_MET,
    `HALT ${anomaly.receiptsByKind.halt}，断电/崩溃后的停机记录 ${anomaly.receiptsByKind['service-stop-prior-boot']}，未收尾 ${anomaly.intentsWithoutClose}，被中断 ${anomaly.interruptedRuns}（另：批次熔断 ${anomaly.receiptsByKind['breaker-opened']} 次、服务停止 ${anomaly.receiptsByKind['service-stop']} 次，属批次管线，仅供参考）；第 10 段失败 ${anomaly.stage10Failures.length} 次${anomaly.stage10Failures.length ? `（${anomaly.stage10Failures.map(f => f.code).join(',')}）` : ''}`);
  const missing = [];
  if (stats.firstRunFailure.decided === 0) missing.push('车头首次运行失败率');
  if (stats.headsPerPr.mean === null) missing.push('每个 PR 的 head 数');
  if (stats.wouldRevoke.runs === 0) missing.push('会撤销个数');
  if (!stats.greenToMerge.samples?.length) missing.push('车头变绿到合入的空档');
  if (!sweep.sweeps.some(s => s.wallMin !== null)) missing.push('全量扫描时长（要影子记录）');
  // The GitHub recompute delay is not required before the train starts (Owner Decision, 2026-11-06): printed when it can be computed.
  if (!stats.queueResidence?.samples) missing.push('第 2 位的等待（影子记录不含第二位，用 --queue-markers 的排队停留代替）');
  add('G6', '设计 §22.2 第 5 条的各项统计都能算出（GitHub 重算延迟开车前不要求）', missing.length ? INSUFFICIENT : MET, `${missing.length ? `算不出：${missing.join('、')}` : '全部算出'}${stats.recompute.samples ? '' : '；GitHub 重算延迟没有样本，Owner 已定开车前不要求'}`);
  if (nodes && nodes.heard > 0) {
    add('G7', `每个常驻节点的心跳正常（30 分钟内），且看到 ${expectNodes} 个节点`, nodes.stale.length ? NOT_MET : nodes.heard < expectNodes ? INSUFFICIENT : MET,
      `${nodes.nodes.map(n => `${n.node ?? '无'}: ${n.ageMin ?? '?'} 分钟前`).join('；')}`);
    add('G8', '开车前各节点同一个 Source（影子阶段可以不同）', nodes.heard < expectNodes || nodes.withoutSource.length ? INSUFFICIENT : nodes.sources.length <= 1 ? MET : NOT_MET,
      `Source：${nodes.sources.join(' / ') || '无'}${nodes.withoutSource.length ? `；没报 Source：${nodes.withoutSource.join(',')}` : ''}`);
  } else add('G7', '每个常驻节点的心跳正常（30 分钟内）、Source 一致', INSUFFICIENT, '影子记录里没有可用的 nodes 视图；用生产库 ci_node_liveness_v1 核对');
  return rows;
}

export function review({ receipts, shadow = [], status = null, pulls = null, markers = null, since = null, now = Date.now(), chain = { status: null, text: '未核验' }, unreadable = {}, expectNodes = 2, acceptAbandoned = [] }) {
  const bad = { receipts: unreadable.receipts ?? 0, shadow: unreadable.shadow ?? 0 };
  // the exported API may be handed unsorted or partial input: order by time, give every receipt a body
  const records = shadow.map(s => ({ ...s, facts: sanitizeFacts(plain(s.facts) ? s.facts : {}) })).filter(s => s.facts.mode === 'shadow' || s.facts.mode === null).sort((a, b) => a.at - b.at);
  receipts = [...receipts].map(r => (plain(r.body) ? r : { ...r, body: {} })).sort((a, b) => a.seq - b.seq);
  const trainRuns = receipts.filter(r => r.type === 'train-run');
  const window = windowStats(trainRuns, since, now);
  const batch = batchStats(receipts, since, now, window);
  const shadowWin = records.filter(s => (since === null || s.at >= since) && s.at <= now);
  const sweep = sweepStats(shadowWin, since, status, now, acceptAbandoned);
  const anomaly = anomalies(receipts, window, since, now);
  const stats = { wouldRevoke: wouldRevokeStats(window.inWin, shadowWin), firstRunFailure: batch.frontFirstRun, headsPerPr: batch.headsPerPr, headsPerFrontPr: batch.headsPerFrontPr,
    greenToMerge: greenToMerge(window.inWin, pulls), queueResidence: queueResidence(markers, since, now), recompute: recomputeDelay(shadowWin),
    secondPlaceWait: { available: false, note: '影子记录只有“当前车头”，不含第 2 位；用 queue_marker 的排队停留代替' } };
  const nodes = nodeStats(shadowWin, now);
  const gates = gate({ since, window, sweep, anomaly, stats, nodes, shadowSweepRuns: sweep.fromShadow, chain, unreadable: bad, expectNodes });
  const blocking = gates.filter(g => g.verdict !== MET);
  return { contract: REVIEW_CONTRACT, generatedAt: iso(now), since: iso(since), chain: chain.text, inputs: { receipts: receipts.length, trainRuns: trainRuns.length, shadowRecords: shadow.length, unreadable: bad },
    window: { runs: window.runs, dutyRuns: window.dutyRuns, firstRunAt: iso(window.firstRunAt), lastRunAt: iso(window.lastRunAt), observedMin: minutes(window.observedMs), frontPrs: window.frontPrs, frontRuns: window.frontRuns, wouldDo: window.wouldDo },
    stats, sweep, nodes, anomaly, batches: { count: batch.batches, prs: batch.prs }, gates, canEnterTrainOn: blocking.length === 0, blocking: blocking.map(g => g.id) };
}

// ---- the page -------------------------------------------------------------------------------------------------------------------

export function renderPage(r) {
  const L = [];
  L.push(`# 影子审查（合并列车开车前）— ${r.generatedAt}`, '');
  L.push(`**结论：${r.canEnterTrainOn ? '影子观察条件全部满足，可以请 Owner 复核后进入 a3701d3d 开车。' : `还不能进入 a3701d3d 开车：${r.blocking.length} 项未满足或数据不够（${r.blocking.join('、')}）。`}**`, '');
  L.push(`窗口起点：${r.since ?? '未指定'}；回执 ${r.inputs.receipts} 条（第 10 段运行 ${r.inputs.trainRuns} 次），影子记录 ${r.inputs.shadowRecords} 条；回执链：${r.chain}。`);
  if (r.inputs.unreadable.receipts + r.inputs.unreadable.shadow > 0) L.push('', `**警告：有 ${r.inputs.unreadable.receipts} 个回执、${r.inputs.unreadable.shadow} 个影子记录读不出，下面的数字缺了它们。**`);
  L.push('', '| 条件 | 判定 | 证据 |', '|---|---|---|');
  for (const g of r.gates) L.push(`| ${g.id} ${text(g.text)} | ${g.verdict} | ${text(g.evidence)} |`);
  const s = r.stats;
  L.push('', '## 统计');
  L.push(`- 会撤销个数：${s.wouldRevoke.runs} 次运行，最近 ${s.wouldRevoke.latest ?? '无'}、最大 ${s.wouldRevoke.max ?? '无'}，非零 ${s.wouldRevoke.nonZeroRuns} 次${s.wouldRevoke.uniqueGreens ? `；不同的旧绿 ${s.wouldRevoke.uniqueGreens.length} 个${s.wouldRevoke.uniqueGreensCapped ? '（每条记录最多列 20 个，实际可能更多）' : ''}` : '；影子记录缺，数不出不同的旧绿'}`);
  const f = s.firstRunFailure;
  L.push(`- 车头首次运行失败率：${f.rate === null ? '数据不够' : `${f.failed}/${f.decided} = ${(f.rate * 100).toFixed(1)}%`}（队首 PR 的 head 共 ${f.heads} 个；没跑起来或被取代 ${f.notRun} 个不计，未出结果 ${f.heads - f.decided - f.notRun} 个；近似：回执不带车头 head，按“在 PR 最后一次当车头之前预留的 attempt 1”算）`);
  L.push(`- 每个 PR 平均 head 数：全部 ${s.headsPerPr.mean ?? '无'}（最多 ${s.headsPerPr.max ?? '无'}）；队首 PR ${s.headsPerFrontPr.mean ?? '无'}（最多 ${s.headsPerFrontPr.max ?? '无'}）`);
  const g = s.greenToMerge;
  L.push(`- 车头变绿到合入：${g.samples?.length ? `${g.samples.length} 个样本（另 ${g.unmerged} 个没有样本），中位数 ${g.median} 分钟，最大 ${g.max} 分钟（${g.note}）` : `数据不够（${g.note}）`}`);
  L.push(`- 第 2 位的等待：数据不够（${s.secondPlaceWait.note}）${s.queueResidence ? `；排队停留 ${s.queueResidence.samples} 个样本${s.queueResidence.dropped ? `（${s.queueResidence.dropped} 条不可用）` : ''}，中位数 ${s.queueResidence.medianMin} 分钟，最大 ${s.queueResidence.maxMin} 分钟` : ''}`);
  L.push(`- GitHub 重算延迟：${s.recompute.samples ? `${s.recompute.samples} 个样本，中位数 ${s.recompute.medianMin} 分钟，最大 ${s.recompute.maxMin} 分钟（精度为一次运行间隔约 10 分钟）` : '没有样本（需要影子记录里 main 移动时有队首的样本；开车前不要求）'}`);
  const w = r.sweep;
  L.push(`- 全量扫描：${w.fromShadow ? `完成 ${w.completed}、放弃/被替换 ${w.abandoned}、进行中 ${w.running}` : '没有影子记录，时长和调用数算不出'}${w.sweeps.filter(x => x.state === 'complete').map(x => `；一次：墙钟 ${x.wallMin} 分钟、运行 ${x.activeMin} 分钟、${x.segments} 段、${x.calls} 次调用`).join('')}`);
  if (w.abandonedAccepted.length || w.acceptedUnmatched.length) L.push(`- ${OWNER_RULING}的全量扫描放弃：${w.abandonedAccepted.map(u => `${u.startedAt} ${u.reason}`).join('；') || '无'}${w.acceptedUnmatched.length ? `；没有对应记录、未生效的起点：${w.acceptedUnmatched.join('、')}` : ''}`);
  L.push(`- 第 10 段结局：${Object.entries(r.window.wouldDo).map(([k, v]) => `${k} ${v}`).join('，') || '无'}`);
  if (r.nodes) L.push(`- 节点（${r.nodes.at}）：${r.nodes.nodes.map(n => `${n.node ?? '无'}（Source ${n.source ?? '无'}，${n.state ?? '?'}，${n.ageMin ?? '?'} 分钟前）`).join('；')}`);
  L.push('', '说明：只读工具，不改任何数据、不开任何开关；不满足/数据不够的项不会被当作满足。a3701d3d 还需要 Owner 批准（train=on）。');
  return `${L.join('\n')}\n`;
}

// ---- command line ---------------------------------------------------------------------------------------------------------------

const VALUE_FLAGS = ['--receipts', '--shadow', '--status', '--pulls', '--queue-markers', '--since', '--now', '--nodes', '--accept-abandoned'];
function parseArgs(argv) {
  const opts = { json: false, verify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json' || a === '--no-verify') { opts[a === '--json' ? 'json' : 'verify'] = a === '--json'; continue; }
    if (!VALUE_FLAGS.includes(a)) fail('ARGUMENT_UNKNOWN', a);
    const v = argv[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) fail('ARGUMENT_VALUE_MISSING', a);
    if (a === '--accept-abandoned') { (opts['accept-abandoned'] ??= []).push(v); i += 1; continue; }
    if (Object.hasOwn(opts, a.slice(2))) fail('ARGUMENT_DUPLICATE', a);
    opts[a.slice(2)] = v; i += 1;
  }
  if (!opts.receipts) fail('RECEIPTS_REQUIRED');
  for (const k of ['since', 'now']) if (opts[k] !== undefined && ms(opts[k]) === null) fail('TIME_INVALID', `--${k} (ISO 8601 with Z or an offset)`);
  if (opts.since !== undefined && opts.now !== undefined && ms(opts.since) > ms(opts.now)) fail('SINCE_AFTER_NOW');
  for (const t of opts['accept-abandoned'] ?? []) if (ms(t) === null) fail('TIME_INVALID', '--accept-abandoned (ISO 8601 with Z or an offset)');
  if (opts.nodes !== undefined && !/^[1-9]\d?$/.test(opts.nodes)) fail('NODES_INVALID', '--nodes');
  return opts;
}

export async function run(argv, { clock = Date.now } = {}) {
  const opts = parseArgs(argv);
  const { receipts, unreadable: badReceipts, missing } = await loadReceipts(path.resolve(opts.receipts));
  if (missing) fail('RECEIPTS_MISSING');
  const shadowLoaded = opts.shadow ? await loadShadow(path.resolve(opts.shadow)) : { records: [], unreadable: 0, missing: false };
  if (opts.shadow && shadowLoaded.missing) fail('SHADOW_MISSING_OR_UNREADABLE');
  let chain = { status: null, text: '未核验（--no-verify）' };
  if (opts.verify) {
    try { const h = await new ReceiptChain(path.resolve(opts.receipts), clock).verifyAll(); chain = { status: 'ok', text: `完整（序号 ${h.seq}）` }; } catch (error) { chain = { status: 'broken', text: `核验失败（${error.code ?? 'UNREADABLE'}）` }; }
  }
  const report = review({ receipts, shadow: shadowLoaded.records, status: opts.status ? await readJson(opts.status, '--status', 'object') : null, pulls: opts.pulls ? await readJson(opts.pulls, '--pulls', 'object') : null,
    markers: opts['queue-markers'] ? await readJson(opts['queue-markers'], '--queue-markers', 'array') : null, since: opts.since ? ms(opts.since) : null, now: opts.now ? ms(opts.now) : clock(), chain,
    unreadable: { receipts: badReceipts, shadow: shadowLoaded.unreadable }, expectNodes: opts.nodes ? Number(opts.nodes) : 2, acceptAbandoned: (opts['accept-abandoned'] ?? []).map(ms) });
  return opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderPage(report);
}

const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  try {
    process.stdout.write(await run(process.argv.slice(2)));
  } catch (error) {
    console.error(JSON.stringify({ status: 'REFUSED', code: error.code ?? 'UNREADABLE', ...(error.detail ? { detail: error.detail } : {}) }));
    process.exitCode = 1;
  }
}
