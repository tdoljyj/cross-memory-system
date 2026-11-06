// The merge train on the resident side (quota redesign phase 2, step 3c-1; design v0.5 §5.5 "运行时机", §4.3, §4.7;
// DESIGN §22.3; Owner decision 2eea28a1). Pure: when stage 10 is due, and what of its facts the status snapshot and
// the PR page show. In shadow mode nothing here changes what the executor runs or publishes.
//
// Stage 10 is due when train.enabled is not 'off', no batch is running, the last run is at least
// train.maintenanceEveryMs ago and fewer than train.maintenanceMaxPerDay ran in the last 24 hours. In step 3c-1 the
// executor also holds it under PAUSE and an intake pause (its PAUSE stops everything but reading triggers); design §4.3
// lets a pause stop only new greens, which step 3c-2 takes up with the sweeps that must run during one. A run counts
// whatever its ending. A clean failure (cleanup proven, no side effect, a clean ending) is tried again at the next due
// time and never feeds the breaker; any other ending HALTs, like any stage (executor.mjs#trainMaintenance).
//
// Step 3c-2b (DESIGN §41.3-41.7; policy /8): the run mode is 'shadow' (every node, reading only), 'on' (ACTIVE only) or
// 'revoke-only' (ACTIVE only, under PAUSE while on; never under HALT); trainRunMode decides it. Train facts /2 add the
// decision, the sweep, what was done, a PAUSE request and the one source of a front batch's S (openFrontBatch); in on and
// revoke-only a run with side effects is a normal ending. A run is due at once (urgent) when the node just became eligible
// for on-mode duty (the take-over sweep comes before any batch).
import { fail } from './canonical.mjs';

export const TRAIN_FACTS_CONTRACT = 'clued.independent-ci.train-facts/1';
export const TRAIN_FACTS_CONTRACT_V2 = 'clued.independent-ci.train-facts/2';
export const WOULD_DO = Object.freeze(['NOT_ON_DUTY', 'NO_FRONT', 'FRONT_AMBIGUOUS', 'FRONT_NOT_BOUND', 'FRONT_NOT_RUNNABLE', 'FRONT_NEEDS_MAIN_MERGE',
  'FRONT_TEST_MERGE_NOT_READY', 'FRONT_GREEN_WAIT_MERGE', 'OPEN_FRONT_BATCH']);
export const RUN_MODES = Object.freeze(['shadow', 'on', 'revoke-only']);
export const DECISIONS = Object.freeze([...WOULD_DO, 'TRAIN_REVOKE_UNCONFIRMED', 'TRAIN_SWEEP_INCOMPLETE', 'TRAIN_TAKEOVER_SWEEP_PENDING', 'TRAIN_SOURCE_MISMATCH',
  'TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_FRONT_BUDGET_SHORT', 'TRAIN_FRONT_ATTEMPTS_USED', 'FRONT_ADOPTED', 'FRONT_RETURNED', 'FRONT_FAILED_REPORTED', 'REVOKE_ONLY_DONE',
  'TRAIN_SOURCE_UNREADABLE', 'TRAIN_FRONT_BATCH_RUNNING']);
// Stage 10's decisions after which the executor starts no new batch (DESIGN §41.6: no publication of any stage before the
// take-over sweep; no on-mode duty while another node runs another Source, or while the nodes' Sources cannot be read).
export const TRAIN_SCHEDULE_DEFERRALS = Object.freeze(['TRAIN_TAKEOVER_SWEEP_PENDING', 'TRAIN_SOURCE_MISMATCH', 'TRAIN_SOURCE_UNREADABLE']);
// The decisions the Owner hears of (a notice, one per key).
export const TRAIN_OWNER_NOTICE_DECISIONS = Object.freeze(['TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_SOURCE_MISMATCH']);
export const REQUEST_PAUSE_CODES = Object.freeze(['TRAIN_LANDED_TREE_MISMATCH']);
// Front batches per head (DESIGN §41.4: attempt 2 and both kinds of re-open count).
export const FRONT_BATCHES_PER_HEAD = 2;
const SWEEP_KINDS = ['none', 'incremental', 'full-segment'];
const FULL_STATES = ['none', 'running', 'complete', 'abandoned'];
const FULL_SCOPES = ['all', 'current']; // generation 15 (DESIGN 60)
const SWEEP_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const codeOrNull = v => (typeof v === 'string' && SWEEP_CODE.test(v) ? v : null);
const DAY = 24 * 3600_000;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const CLAIM = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[A-Za-z0-9_-]{1,80}$/;
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const isoOrNull = v => (typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The mode of the next stage-10 run, or null (none), with why: train.enabled 'off' runs nothing; 'shadow' runs shadow on
// every node; 'on' runs only on an ACTIVE node (STANDBY and UNCERTAIN: NOT_ON_DUTY), 'on' normally, 'revoke-only' under
// PAUSE (DESIGN §41.3) or an intake pause; HALT runs nothing (the caller never asks then).
// Shadow keeps step 3c-1's rule: held by PAUSE and an intake pause.
export function trainRunMode({ enabled, active, paused = false, intakeHeld = false }) {
  if (enabled === 'shadow') return { mode: paused || intakeHeld ? null : 'shadow', notOnDuty: false };
  if (enabled !== 'on') return { mode: null, notOnDuty: false };
  if (!active) return { mode: null, notOnDuty: true };
  return { mode: paused || intakeHeld ? 'revoke-only' : 'on', notOnDuty: false };
}

export function trainDue({ train, now, runs = [], busy, urgent = false }) {
  if (!train || train.enabled === 'off' || busy) return false;
  const recent = runs.filter(at => at > now - DAY);
  if (recent.length >= train.maintenanceMaxPerDay) return false;
  const last = recent.length ? Math.max(...recent) : null;
  return last === null || urgent === true || now - last >= train.maintenanceEveryMs;
}

// The resident's part of the train-run job /2 (INTERFACES §2): every field the derivation does not take from the install
// record (contract, id, repo, runId, sourceManifestSha256 and createdAt are the derivation's), in the job's order. settings:
// policy.mjs#trainSettings; onSince: ms or null (null in shadow); frontOutcome: { pr, headSha, testSha, attempt, code } or null
// (mode on only); revokeHeadRequestId: uuid or null (on and revoke-only).
export const TRAIN_RUN_INPUT_FIELDS = Object.freeze(['mode', 'slotHardCapMinutes', 'frontBatchBudgetMs', 'sweepFreshMs', 'fullSweepMaxMs', 'onSince',
  'frontPr', 'frontHeadSha', 'frontTestSha', 'frontAttempt', 'frontCode', 'revokeHeadRequestId']);
const FRONT_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
export function trainRunInput({ mode, settings, onSince = null, frontOutcome = null, revokeHeadRequestId = null }) {
  const on = mode === 'on', acting = mode !== 'shadow';
  const f = on ? frontOutcome : null;
  const input = { mode, slotHardCapMinutes: settings.slotHardCapMinutes, frontBatchBudgetMs: settings.frontBatchBudgetMs, sweepFreshMs: settings.sweepFreshMs,
    fullSweepMaxMs: settings.fullSweepMaxMs, onSince: acting && Number.isSafeInteger(onSince) ? new Date(onSince).toISOString() : null,
    frontPr: f?.pr ?? null, frontHeadSha: f?.headSha ?? null, frontTestSha: f?.testSha ?? null, frontAttempt: f?.attempt ?? null, frontCode: f?.code ?? null,
    revokeHeadRequestId: acting ? revokeHeadRequestId : null };
  return validateTrainRunInput(input);
}
// The same rules as the job /2 (train-run.mjs#validateTrainRun, C# ValidateTrainRun) for the resident's part of it.
export function validateTrainRunInput(v) {
  const flat = [v?.frontPr, v?.frontHeadSha, v?.frontTestSha, v?.frontAttempt, v?.frontCode];
  const int = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
  const ok = plain(v) && Object.keys(v).length === TRAIN_RUN_INPUT_FIELDS.length && TRAIN_RUN_INPUT_FIELDS.every(k => Object.hasOwn(v, k)) && RUN_MODES.includes(v.mode)
    && int(v.slotHardCapMinutes, 60, 180) && int(v.frontBatchBudgetMs, 60_000, 10_800_000) && int(v.sweepFreshMs, 60_000, 3_600_000) && int(v.fullSweepMaxMs, 600_000, 86_400_000)
    && (v.onSince === null ? v.mode === 'shadow' : isoOrNull(v.onSince) !== null && v.mode !== 'shadow')
    && (flat.every(x => x === null) || (v.mode === 'on' && Number.isSafeInteger(v.frontPr) && v.frontPr > 0 && SHA.test(v.frontHeadSha ?? '') && SHA.test(v.frontTestSha ?? '')
      && v.frontTestSha !== v.frontHeadSha && [1, 2].includes(v.frontAttempt) && FRONT_CODE.test(v.frontCode ?? '')))
    && (v.revokeHeadRequestId === null || (v.mode !== 'shadow' && UUID.test(v.revokeHeadRequestId)));
  if (!ok) fail('TRAIN_RUN_INPUT_INVALID');
  return Object.freeze({ ...v });
}

// facts /2 openFrontBatch -> the frozen front of a batch with S, or null when it does not fit (never a guess).
export function openFrontBatchOf(o) {
  if (!plain(o)) return null;
  const ok = Number.isSafeInteger(o.pr) && o.pr > 0 && SHA.test(o.headSha ?? '') && SHA.test(o.baseSha ?? '') && SHA.test(o.testSha ?? '') && SHA.test(o.testTree ?? '')
    && o.testSha !== o.headSha && typeof o.claimId === 'string' && CLAIM.test(o.claimId) && isoOrNull(o.since) !== null && [1, 2].includes(o.attempt);
  return ok ? Object.freeze({ pr: o.pr, headSha: o.headSha, baseSha: o.baseSha, testSha: o.testSha, testTree: o.testTree, claimId: o.claimId, since: o.since, attempt: o.attempt }) : null;
}

// facts /2 sweep -> the summary's copy, or null.
export function sweepOf(s) {
  if (!plain(s) || !SWEEP_KINDS.includes(s.kind) || typeof s.complete !== 'boolean' || !plain(s.fullSweep) || !FULL_STATES.includes(s.fullSweep.state)) return null;
  return Object.freeze({ kind: s.kind, complete: s.complete, revoked: count(s.revoked) ?? 0, unconfirmed: count(s.unconfirmed) ?? 0, wouldRevokeCount: count(s.wouldRevokeCount) ?? 0,
    fullSweep: Object.freeze({ state: s.fullSweep.state, startedAt: isoOrNull(s.fullSweep.startedAt), completedAt: isoOrNull(s.fullSweep.completedAt), sinceOn: s.fullSweep.sinceOn === true,
      // generation 15 (DESIGN 60): 'all' (every pull and commit) or 'current' (open pulls whole, closed unmerged heads), why, and a pending rewrite of main
      scope: FULL_SCOPES.includes(s.fullSweep.scope) ? s.fullSweep.scope : null, scopeReason: codeOrNull(s.fullSweep.scopeReason), mainRewritten: s.fullSweep.mainRewritten === true }),
    proofWritten: s.proofWritten === true });
}

const actionsOf = a => (plain(a) ? Object.freeze({ touchedRunning: a.touchedRunning === true, adopted: a.adopted === true, returned: a.returned === true, failedReported: a.failedReported === true,
  keptAlive: count(a.keptAlive) ?? 0, watermarkReported: a.watermarkReported === true,
  revokeHead: plain(a.revokeHead) && UUID.test(a.revokeHead.requestId ?? '') ? Object.freeze({ requestId: a.revokeHead.requestId, done: a.revokeHead.done === true }) : null }) : null);

// The part of stage 10's facts the resident keeps (status snapshot, PR page). Anything that does not look like train
// facts is null ("facts unconfirmed"). Facts /1 are shadow only and keep the /1 summary; facts /2 add the decision, the sweep,
// what was done, the PAUSE request and the front batch. In on and revoke-only a /2 run must name a decision and, when it says
// OPEN_FRONT_BATCH in mode on, a front batch that fits; a requestPause the executor does not know is no summary either (it
// would be a PAUSE the executor cannot latch: fail closed).
export function trainSummary(f) {
  if (!f || ![TRAIN_FACTS_CONTRACT, TRAIN_FACTS_CONTRACT_V2].includes(f.contract) || !WOULD_DO.includes(f.wouldDo) || typeof f.at !== 'string') return null;
  const v2 = f.contract === TRAIN_FACTS_CONTRACT_V2;
  if (v2 ? !RUN_MODES.includes(f.mode) : f.mode !== 'shadow') return null;
  const front = f.front && Number.isSafeInteger(f.front.pr) ? { pr: f.front.pr, headSha: SHA.test(f.front.headSha ?? '') ? f.front.headSha : null } : null;
  const base = { at: f.at, mode: f.mode, wouldDo: f.wouldDo, onDuty: f.onDuty === true, front, mainSha: SHA.test(f.mainSha ?? '') ? f.mainSha : null,
    strict: typeof f.rules?.strict === 'boolean' ? f.rules.strict : null, wouldRevokeCount: Number.isSafeInteger(f.wouldRevokeCount) ? f.wouldRevokeCount : 0 };
  if (!v2) return Object.freeze(base);
  const decision = DECISIONS.includes(f.decision) ? f.decision : null;
  const acting = f.mode !== 'shadow';
  if (acting && decision === null) return null;
  if (f.requestPause !== undefined && f.requestPause !== null && !REQUEST_PAUSE_CODES.includes(f.requestPause)) return null;
  const openFrontBatch = f.mode === 'on' && decision === 'OPEN_FRONT_BATCH' ? openFrontBatchOf(f.openFrontBatch) : null;
  if (f.mode === 'on' && decision === 'OPEN_FRONT_BATCH' && !openFrontBatch) return null;
  return Object.freeze({ ...base, decision, sweep: sweepOf(f.sweep), actions: actionsOf(f.actions), requestPause: acting ? (f.requestPause ?? null) : null, openFrontBatch });
}

// The PR page line on the front PR (info only: in shadow mode the train does nothing).
const TEXT = {
  FRONT_NOT_RUNNABLE: '车头 PR 现在不能跑（草稿、已关闭或不是合到 main）',
  FRONT_NEEDS_MAIN_MERGE: '开车后会请作者先把 main 合进分支（冲突，或 strict 开着而 head 落后）',
  FRONT_TEST_MERGE_NOT_READY: '开车后会等 GitHub 算好试合并',
  FRONT_GREEN_WAIT_MERGE: '车头六项已绿，等合并',
  OPEN_FRONT_BATCH: '开车后会在 GitHub 的试合并提交上跑车头批次',
};
// The train on (DESIGN §41.2-41.4): stage 10's decision on the front PR, in words.
const ON_TEXT = {
  FRONT_NOT_RUNNABLE: '车头 PR 现在不能跑（草稿、已关闭或不是合到 main）',
  FRONT_NEEDS_MAIN_MERGE: '请先把 main 合进分支再推送（冲突，或 head 不含 main 尖端）',
  FRONT_TEST_MERGE_NOT_READY: '等 GitHub 算好试合并',
  FRONT_GREEN_WAIT_MERGE: '车头六项已绿，等合并',
  OPEN_FRONT_BATCH: '车头批次已开，在 GitHub 的试合并提交上跑',
  TRAIN_FRONT_BUDGET_SHORT: '位子剩余时间不够跑一批：请让位子过期后重新入队',
  TRAIN_FRONT_ATTEMPTS_USED: '这个 head 的两次车头批次已用完：请推新提交',
  TRAIN_SWEEP_INCOMPLETE: '清扫未完成，暂不发绿',
  TRAIN_REVOKE_UNCONFIRMED: '有撤销未确认，暂不发绿',
  TRAIN_TAKEOVER_SWEEP_PENDING: '接班清扫未完成，暂不发绿',
  TRAIN_LANDED_TREE_MISMATCH: '落地的树与测过的不同，已停车，等 Owner',
  TRAIN_FRONT_BATCH_RUNNING: '车头批次进行中',
  TRAIN_SOURCE_UNREADABLE: '读不到各常驻节点的 Source，暂不开车',
};
export function trainPageLine(summary, pr) {
  if (!summary || summary.front?.pr !== pr) return null;
  if (summary.mode === 'shadow') return TEXT[summary.wouldDo] ? `列车影子（只记录，不执行）：你是合并队列车头。${TEXT[summary.wouldDo]}。` : null;
  const text = ON_TEXT[summary.decision] ?? null;
  return text ? `合并列车：你是车头。${text}。` : null;
}

// The status reader's copy of a summary (untrusted bytes in state\status.json): the same fields with `at` in ms, or null.
// A /2 summary (it has `decision`) keeps its decision, sweep and PAUSE request; the front batch and the actions stay with the
// executor (the companion never acts on them).
export function parseTrainLast(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l) || !RUN_MODES.includes(l.mode) || !WOULD_DO.includes(l.wouldDo) || !Number.isFinite(Date.parse(l.at))) return null;
  const v2 = Object.hasOwn(l, 'decision');
  if (!v2 && l.mode !== 'shadow') return null;
  const base = { at: Date.parse(l.at), mode: l.mode, wouldDo: l.wouldDo, onDuty: l.onDuty === true,
    front: l.front && Number.isSafeInteger(l.front.pr) ? { pr: l.front.pr, headSha: SHA.test(l.front.headSha ?? '') ? l.front.headSha : null } : null,
    mainSha: SHA.test(l.mainSha ?? '') ? l.mainSha : null, strict: typeof l.strict === 'boolean' ? l.strict : null,
    wouldRevokeCount: Number.isSafeInteger(l.wouldRevokeCount) && l.wouldRevokeCount >= 0 ? l.wouldRevokeCount : 0 };
  if (!v2) return Object.freeze(base);
  return Object.freeze({ ...base, decision: DECISIONS.includes(l.decision) ? l.decision : null, sweep: sweepOf(l.sweep),
    requestPause: REQUEST_PAUSE_CODES.includes(l.requestPause) ? l.requestPause : null });
}

// The status snapshot's `train.sweep` (DESIGN §41.7): when this node last completed a full sweep, whether that was after it
// became eligible for on-mode duty (the change to on or the take-over), and the newest run's sweep result. null before any.
export function trainSweepView({ summary, previous = null, onSince = null }) {
  const s = summary?.sweep;
  if (!s) return previous;
  const completedAt = s.fullSweep.state === 'complete' && s.fullSweep.completedAt ? s.fullSweep.completedAt : (previous?.fullCompletedAt ?? null);
  const sinceOn = s.fullSweep.state === 'complete' ? s.fullSweep.sinceOn === true : (previous?.fullSinceOn === true && previous?.onSince === onSince);
  return Object.freeze({ at: summary.at, mode: summary.mode, kind: s.kind, complete: s.complete, revoked: s.revoked, unconfirmed: s.unconfirmed, fullState: s.fullSweep.state,
    fullCompletedAt: completedAt, fullSinceOn: sinceOn && summary.mode !== 'shadow', onSince,
    fullScope: s.fullSweep.scope ?? null, fullScopeReason: s.fullSweep.scopeReason ?? null, mainRewritten: s.fullSweep.mainRewritten === true });
}
// The status reader's copy of train.sweep, or null.
export function parseTrainSweep(v) {
  if (!plain(v) || !RUN_MODES.includes(v.mode) || !SWEEP_KINDS.includes(v.kind) || typeof v.complete !== 'boolean' || !FULL_STATES.includes(v.fullState) || !Number.isFinite(Date.parse(v.at))) return null;
  return Object.freeze({ at: Date.parse(v.at), mode: v.mode, kind: v.kind, complete: v.complete, revoked: count(v.revoked) ?? 0, unconfirmed: count(v.unconfirmed) ?? 0, fullState: v.fullState,
    fullCompletedAt: Number.isFinite(Date.parse(v.fullCompletedAt)) ? Date.parse(v.fullCompletedAt) : null, fullSinceOn: v.fullSinceOn === true,
    onSince: Number.isFinite(Date.parse(v.onSince)) ? Date.parse(v.onSince) : null,
    fullScope: FULL_SCOPES.includes(v.fullScope) ? v.fullScope : null, fullScopeReason: codeOrNull(v.fullScopeReason), mainRewritten: v.mainRewritten === true });
}
// The status reader's copy of train.revokeHead (DESIGN §41.3: the Owner's "撤车头" request and its result), or null.
export function parseRevokeHead(v) {
  if (!plain(v) || !UUID.test(v.requestId ?? '') || !['accepted', 'done', 'not-done', 'refused', 'expired'].includes(v.state) || !Number.isFinite(Date.parse(v.at))) return null;
  return Object.freeze({ requestId: v.requestId, state: v.state, at: Date.parse(v.at), code: typeof v.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(v.code) ? v.code : null });
}

// The PR page (pr-status.mjs): the front PR's own description, with the shadow line appended when the newest run (at most
// TRAIN_PAGE_MAX_AGE_MS old) saw this very head at the front. Never on a failure or an error, never instead of the
// executor's own words.
export const TRAIN_PAGE_MAX_AGE_MS = 30 * 60_000;
export function withTrainLine(want, last, pull, now, max = 140) {
  if (!want || ['failure', 'error'].includes(want.state) || !last || now - last.at > TRAIN_PAGE_MAX_AGE_MS || !last.front?.headSha || last.front.headSha !== pull?.headSha) return want;
  const line = trainPageLine(last, pull.pr);
  if (!line) return want;
  const d = `${want.description}；${line}`;
  return { ...want, description: d.length <= max ? d : `${d.slice(0, max - 1)}…` };
}
