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
export const TRAIN_FACTS_CONTRACT = 'clued.independent-ci.train-facts/1';
export const WOULD_DO = Object.freeze(['NOT_ON_DUTY', 'NO_FRONT', 'FRONT_AMBIGUOUS', 'FRONT_NOT_BOUND', 'FRONT_NOT_RUNNABLE', 'FRONT_NEEDS_MAIN_MERGE',
  'FRONT_TEST_MERGE_NOT_READY', 'FRONT_GREEN_WAIT_MERGE', 'OPEN_FRONT_BATCH']);
const DAY = 24 * 3600_000;
const SHA = /^[0-9a-f]{40}$/;

export function trainDue({ train, now, runs = [], busy }) {
  if (!train || train.enabled === 'off' || busy) return false;
  const recent = runs.filter(at => at > now - DAY);
  if (recent.length >= train.maintenanceMaxPerDay) return false;
  const last = recent.length ? Math.max(...recent) : null;
  return last === null || now - last >= train.maintenanceEveryMs;
}

// The part of stage 10's facts the resident keeps (status snapshot, PR page). Anything that does not look like train
// facts is null ("facts unconfirmed").
export function trainSummary(f) {
  if (!f || f.contract !== TRAIN_FACTS_CONTRACT || f.mode !== 'shadow' || !WOULD_DO.includes(f.wouldDo) || typeof f.at !== 'string') return null;
  const front = f.front && Number.isSafeInteger(f.front.pr) ? { pr: f.front.pr, headSha: SHA.test(f.front.headSha ?? '') ? f.front.headSha : null } : null;
  return Object.freeze({ at: f.at, mode: f.mode, wouldDo: f.wouldDo, onDuty: f.onDuty === true, front, mainSha: SHA.test(f.mainSha ?? '') ? f.mainSha : null,
    strict: typeof f.rules?.strict === 'boolean' ? f.rules.strict : null, wouldRevokeCount: Number.isSafeInteger(f.wouldRevokeCount) ? f.wouldRevokeCount : 0 });
}

// The PR page line on the front PR (info only: in shadow mode the train does nothing).
const TEXT = {
  FRONT_NOT_RUNNABLE: '车头 PR 现在不能跑（草稿、已关闭或不是合到 main）',
  FRONT_NEEDS_MAIN_MERGE: '开车后会请作者先把 main 合进分支（冲突，或 strict 开着而 head 落后）',
  FRONT_TEST_MERGE_NOT_READY: '开车后会等 GitHub 算好试合并',
  FRONT_GREEN_WAIT_MERGE: '车头六项已绿，等合并',
  OPEN_FRONT_BATCH: '开车后会在 GitHub 的试合并提交上跑车头批次',
};
export function trainPageLine(summary, pr) {
  if (!summary || summary.front?.pr !== pr || !TEXT[summary.wouldDo]) return null;
  return `列车影子（只记录，不执行）：你是合并队列车头。${TEXT[summary.wouldDo]}。`;
}

// The status reader's copy of a summary (untrusted bytes in state\status.json): the same fields with `at` in ms, or null.
export function parseTrainLast(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l) || l.mode !== 'shadow' || !WOULD_DO.includes(l.wouldDo) || !Number.isFinite(Date.parse(l.at))) return null;
  return Object.freeze({ at: Date.parse(l.at), mode: l.mode, wouldDo: l.wouldDo, onDuty: l.onDuty === true,
    front: l.front && Number.isSafeInteger(l.front.pr) ? { pr: l.front.pr, headSha: SHA.test(l.front.headSha ?? '') ? l.front.headSha : null } : null,
    mainSha: SHA.test(l.mainSha ?? '') ? l.mainSha : null, strict: typeof l.strict === 'boolean' ? l.strict : null,
    wouldRevokeCount: Number.isSafeInteger(l.wouldRevokeCount) && l.wouldRevokeCount >= 0 ? l.wouldRevokeCount : 0 });
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
