// The merge train on the resident side (quota redesign phase 2, step 3c-1; design v0.5 §5.5 "运行时机", §4.3, §4.7;
// DESIGN §22.3; Owner decision 2eea28a1). Pure: when stage 10 is due, and what of its facts the status snapshot and
// the PR page show. In shadow mode nothing here changes what the executor runs or publishes.
//
// Stage 10 is due when train.enabled is not 'off', no batch is running, the last run is at least
// train.maintenanceEveryMs ago and fewer than train.maintenanceMaxPerDay ran in the last 24 hours. A pause request
// does not stop it (design §4.3: a pause stops new greens; stage 10 in shadow writes nothing). A failed run counts
// like any other and is simply tried again at the next due time: it has no side effects, so it never feeds the
// breaker and never HALTs.
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
