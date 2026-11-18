import { createHash } from 'node:crypto';

export const DAY_MS = 86400000;
export const BUDGETS = Object.freeze({
  DAILY_BATCH_LIMIT: ['limits.maxBatchesPer24h', 'node', 'started'],
  DAILY_EVALUATION_LIMIT: ['limits.maxEvaluationsPer24h', 'node', 'evaluations'],
  WAITING_BUDGET_EXHAUSTED: ['limits.waitingRetriesPer24h', 'node', 'waitingRetries'],
  PR_DAILY_BATCH_LIMIT: ['limits.perPrBatchesPer24h', 'pr', 'startedByPr'],
  REEVALUATION_CAP: ['limits.reevaluationsPerPrHeadPer24h', 'pr-head', 'reevaluations'],
  RELEASE_CAP_REACHED: ['limits.releasesPerHeadPer24h', 'head', 'releasesByHead'],
  NETWORK_RELEASE_CAP_REACHED: ['breaker.network.releasesPerHeadPer24h', 'head', 'networkReleasesByHead'],
  STAGE8_RETRY_BUDGET_EXHAUSTED: ['park.stage8RetriesPer24h', 'pr', 'stage8Retries'],
  QUEUE_DEPTH_EXCEEDED: ['limits.queueDepth', 'node', 'live'],
  PARKING_FULL: ['park.maxParked', 'node', 'inside'],
  PARKED_OVER_CAPACITY: ['park.maxParkedOutsideTop2', 'node', 'outside'],
  STAGE8_TRY_LIMIT: ['park.stage8MaxTries', 'batch', 'tries'],
  TRAIN_DAILY_LIMIT: ['train.maintenanceMaxPerDay', 'node', 'runs'],
  CI_BUDGET_EXHAUSTED: ['native.CI_BUDGET_EXHAUSTED', 'native', 'unknown'],
  TASK_CI_HEAD_CAP_REACHED: ['native.TASK_CI_HEAD_CAP_REACHED', 'native', 'unknown'],
  CLAIM_HEAD_CAP_REACHED: ['native.CLAIM_HEAD_CAP_REACHED', 'native', 'unknown'],
});

export function parseBudget(b) {
  if (!b || !Object.values(BUDGETS).some(([key, scope]) => b.policyKey === key && b.scope === scope)
      || !(b.scope === 'native' && b.used === null || Number.isSafeInteger(b.used) && b.used >= 0)
      || !(b.scope === 'native' && b.limit === null || Number.isSafeInteger(b.limit) && b.limit >= 0)) return null;
  return { policyKey: b.policyKey, scope: b.scope, used: b.used, limit: b.limit,
    resetsAt: Number.isSafeInteger(b.resetsAt) && b.resetsAt > 0 ? b.resetsAt : null,
    ...(b.recovery === 'capacity' || b.recovery === 'batch' ? { recovery: b.recovery } : {}) };
}

export function boundedNotice({ code, subject = {}, used, limit, now, resetsAt = null, recovery = 'capacity', episode = null }) {
  const [policyKey, scope] = BUDGETS[code];
  const identity = scope === 'node' ? 'node' : `${subject.pr}:${subject.headSha}`;
  const window = episode ?? resetsAt ?? Math.floor(now / DAY_MS);
  return { key: `budget:${createHash('sha256').update(`${policyKey}:${identity}:${window}`).digest('hex')}`, kind: 'budget', code,
    pr: scope === 'node' ? null : subject.pr, headSha: scope === 'node' ? null : subject.headSha, at: now, until: resetsAt,
    budget: { policyKey, scope, used, limit, resetsAt, ...(recovery ? { recovery } : {}) } };
}

// Only a display of admission's decision. Read/notification failure must never widen or replace a gate.
export async function budgetNotice({ code, subject, policy, ledger, usage, now }) {
  const [policyKey, scope, field] = BUDGETS[code];
  const limit = policyKey.split('.').reduce((o, k) => o?.[k], policy);
  const mapKey = scope === 'pr' ? subject.pr : scope === 'pr-head' ? `${subject.pr}:${subject.headSha}` : subject.headSha;
  const used = usage[field] instanceof Map ? usage[field].get(mapKey) ?? 0 : usage[field];
  let resetsAt = null;
  try {
    const measured = usage.budgetTimes ? usage : await ledger.usage(now - DAY_MS, { budgetTimes: true, separateNetwork: !!policy.breaker.network,
      stage8Pr: code === 'STAGE8_RETRY_BUDGET_EXHAUSTED' ? subject.pr : null });
    const timeKey = field === 'startedByPr' ? `pr:${subject.pr}` : field === 'reevaluations' ? `reevaluation:${mapKey}`
      : field === 'releasesByHead' ? `release:${mapKey}` : field === 'networkReleasesByHead' ? `network:${mapKey}` : field;
    const times = measured.budgetTimes.get(timeKey) ?? [];
    if (limit > 0 && times.length >= used && times.every(Number.isFinite)) resetsAt = Math.min(...times) + DAY_MS;
  } catch { /* advisory: keep the refusal, report unknown expiration */ }
  const identity = scope === 'node' ? 'node' : scope === 'pr' ? `pr:${subject.pr}` : scope === 'pr-head' ? `pr:${subject.pr}:${subject.headSha}` : subject.headSha;
  const window = resetsAt ?? `unknown:${Math.floor(now / DAY_MS)}`;
  const key = `budget:${createHash('sha256').update(`${policyKey}:${identity}:${window}`).digest('hex')}`;
  const kinds = { STAGE8_RETRY_BUDGET_EXHAUSTED: 'stage8-budget', WAITING_BUDGET_EXHAUSTED: 'waiting-budget', DAILY_BATCH_LIMIT: 'batch-limit' };
  return { key, kind: kinds[code] ?? 'budget', code,
    pr: scope === 'node' ? null : subject.pr, headSha: scope === 'pr' || scope === 'node' ? null : subject.headSha,
    at: now, until: resetsAt, budget: { policyKey, scope, used, limit, resetsAt } };
}

export function budgetText(b) {
  const scope = { node: '全节点', pr: '每 PR', 'pr-head': '每 PR 提交', head: '每 head', batch: '每批次', native: '服务端额度，精确范围未返回' }[b.scope];
  const recovery = b.recovery === 'capacity' ? '席位释放后恢复（无固定过期时刻）' : b.recovery === 'batch' ? '本批不自动恢复，需新批次并重新准入' : '恢复时刻未知（无可核验过期记录或额度为零）';
  return `${b.policyKey}（${scope}）${b.used ?? '未知'}/${b.limit ?? '未知'}；${b.resetsAt ? `最早 ${new Date(b.resetsAt).toISOString()} 恢复` : recovery}`;
}

export function budgetForPull(status, pull, now) {
  const row = status.pending?.find(r => r.pr === pull.pr && r.headSha === pull.headSha);
  if (status.recent?.some(r => r.pr === pull.pr && r.headSha === pull.headSha && r.outcome === 'COMPLETED')) return null;
  return status.notices?.find(n => n.budget && n.at <= now && now - n.at <= DAY_MS
    && (row?.state !== 'PARKED' || ['STAGE8_RETRY_BUDGET_EXHAUSTED', 'STAGE8_TRY_LIMIT', 'TRAIN_DAILY_LIMIT'].includes(n.code))
    && (n.pr !== null || ['QUEUED', 'PARKED', 'WAITING', 'BACKOFF'].includes(row?.state) || n.code === 'QUEUE_DEPTH_EXCEEDED' && !row)
    && (n.code !== 'WAITING_BUDGET_EXHAUSTED' || row?.state === 'WAITING' || row?.deferred === n.code)
    && (n.code !== 'DAILY_EVALUATION_LIMIT' || row?.state !== 'WAITING')
    && (n.code !== 'PARKING_FULL' && n.code !== 'PARKED_OVER_CAPACITY' || status.queue?.parkingFull === true)
    && (n.code !== 'QUEUE_DEPTH_EXCEEDED' || status.queue?.live >= status.queue?.depth)
    && (n.code !== 'TRAIN_DAILY_LIMIT' || row?.state === 'PARKED' && row?.deferred === 'TRAIN_SINGLE_GREEN_NOT_PROVEN')
    && (n.budget.resetsAt === null || n.budget.resetsAt >= now)
    && (n.budget.scope === 'head' || n.pr === null || n.pr === pull.pr) && (n.headSha === null || n.headSha === pull.headSha))?.budget ?? null;
}
