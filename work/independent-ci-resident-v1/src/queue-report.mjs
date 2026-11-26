import { HEX40, digest } from './canonical.mjs';
import { nodeOf, ownAny, stallCode, stalledText } from './node-duty.mjs';
import { STAGE_NAMES, events, holdText } from './pr-status.mjs';
import { STATUS_STALE_MS } from './status.mjs';

const MINUTE_MS = 60_000;
export const NO_PROGRESS_MS = 15 * MINUTE_MS;
export const TRAIN_STALE_MS = 25 * MINUTE_MS;
export const PAUSE_ESCALATION_MS = 30 * MINUTE_MS;
const STAGE_WITHOUT_STATS_MS = 45 * MINUTE_MS;
const KEEPALIVE_MS = 10 * MINUTE_MS;
const UNAVAILABLE_MS = 60 * MINUTE_MS;
const LIVE = new Set(['QUEUED', 'PARKED', 'WAITING', 'BACKOFF']);
const TRANSIENT = new Set(['PAUSED', 'INTAKE_PAUSED', 'EXECUTOR_STARTING', 'BREAKER_OPEN', 'NODE_ROLE_UNCERTAIN']);
const UNSUPPORTED = new Set(['heartbeat_connection_only', 'work_claim_action_invalid', 'work_claim_ci_command_invalid', 'unknown_action']);
const MAX_VIEW_BYTES = 32 * 1024;
const MAX_ROWS = 30;
const ALERTS_MAX = 10;
const MAX_TEXT_LENGTH = 200;
const SCOPE = /^(?:global|project:[a-f0-9-]{36})$/;

const liveRows = status => (status?.pending ?? []).filter(row => LIVE.has(row.state));
const unqueuedPulls = (status, pulls) => pulls.filter(pull => pull.eligible === true && pull.draft !== true
  && Number.isSafeInteger(pull.pr) && pull.pr > 0 && HEX40.test(pull.headSha ?? '') && !ownAny(status, pull));

// Queue rows are in the executor's queue order, with an explicit runnable position where one is known.
export function queueFront(status) {
  const rows = liveRows(status);
  return rows.find(row => row.position === 1) ?? rows[0] ?? status?.current ?? null;
}

const expired = (since, now, limit) => Number.isFinite(since) && now - since > limit;
const minutes = (since, now) => Math.floor((now - since) / MINUTE_MS);
const stageName = stage => stage === null ? '等待托管信号' : STAGE_NAMES[stage] ?? null;

// For reports and commit statuses, a new minute by itself is no change to what is holding the queue.
export const stableStallText = text => text.replace(/已 \d+ 分钟/g, '已若干分钟');

export function queueStall(status, pulls = [], now, staleMs = STATUS_STALE_MS) {
  const node = nodeOf(status, 'unknown');
  const code = stallCode(status, node, now, staleMs);
  const running = status?.current;
  const rows = liveRows(status);
  const unqueued = unqueuedPulls(status, pulls);
  const hasWork = !!running || rows.length > 0 || unqueued.length > 0;
  const executorSince = status?.executor?.since ?? null;
  if (code) {
    let since = executorSince;
    if (code === 'STATUS_STALE') since = status.writtenAt;
    else if (status?.halt) since = status.halt.at ?? executorSince;
    else if (code === 'INTAKE_PAUSED') {
      const starts = (status.intakePause.holders ?? []).map(h => h.since).filter(Number.isFinite);
      if (starts.length) since = Math.min(...starts);
    }
    const transient = !status?.halt && TRANSIENT.has(code);
    const escalated = hasWork && Number.isFinite(since) && now - since >= PAUSE_ESCALATION_MS;
    return { code, level: transient && !escalated ? 'yellow' : 'red', since, text: stalledText(code, status).description };
  }
  if (running) {
    const p90 = status.timing?.stats?.segments?.[running.stage === 0 ? 'prep' : running.stage]?.p90Ms;
    const limit = Number.isFinite(p90) ? Math.max(2 * p90, NO_PROGRESS_MS) : STAGE_WITHOUT_STATS_MS;
    const { stageSince: since, stage, pr } = running;
    if (expired(since, now, limit)) {
      const label = stage == null ? '等待托管信号' : `第 ${stage} 段（${stageName(stage) ?? '?'}）`;
      return { code: 'FRONT_STAGE_OVERDUE', level: 'red', since, text: `PR #${pr} ${label}已 ${minutes(since, now)} 分钟没有前进` };
    }
  } else if (hasWork) {
    const since = status.recent?.[0]?.at ?? executorSince;
    if (expired(since, now, NO_PROGRESS_MS)) {
      const front = queueFront(status);
      const count = new Set([...rows, ...unqueued].map(row => row.pr)).size;
      const text = front ? `有 ${count} 个 PR 在等，但已 ${minutes(since, now)} 分钟没有任何批次开跑；队首 PR #${front.pr}：${holdText(status, front, now)}`
        : `有 ${count} 个开放 PR 未入队，已 ${minutes(since, now)} 分钟没有任何批次开跑`;
      return { code: 'NO_PROGRESS', level: 'red', since, text };
    }
  }
  const last = status.train?.last;
  if (status.train?.enabled !== 'on' || node.mode !== 'ACTIVE') return null;
  const since = last?.at ?? null;
  if (hasWork && expired(since, now, TRAIN_STALE_MS)) {
    return { code: 'TRAIN_STALE', level: 'red', since, text: `合并列车已 ${minutes(since, now)} 分钟没有跑第 10 段` };
  }
  if (last?.mode !== 'on') {
    return { code: 'TRAIN_NOT_ON', level: 'yellow', since, text: last ? '合并列车上次运行时未处于正式模式' : '合并列车尚无运行记录' };
  }
  return null;
}

// status is the bounded, parsed status.json view. Rebuild each object so new board fields are private by default.
export function queueReport({ status, pulls = [], now }) {
  const stall = queueStall(status, pulls, now);
  const { node, versions, executor, halt, intakePause, breaker, current, train } = status ?? {};
  const upgrade = versions?.upgrade, selfcheck = versions?.selfcheck, last = train?.last;
  const view = {
    contract: 'clued.merge-queue-node-view/1',
    node: {
      name: node?.name ?? null, mode: node?.mode ?? (status ? 'ACTIVE' : null), source: node?.source ?? null,
      generation: versions?.generation ?? null, consistent: versions?.consistent ?? null,
      upgrade: upgrade ? { state: upgrade.state ?? null, phase: upgrade.phase ?? null, since: upgrade.since ?? null, code: upgrade.code ?? null } : null,
      selfcheck: selfcheck ? { result: selfcheck.result, observedAt: selfcheck.observedAt } : null,
    },
    executor: executor ? { state: executor.state, reason: executor.reason ?? null, since: executor.since ?? null } : null,
    halt: halt ? { code: halt.code, at: halt.at ?? null } : null,
    paused: status?.paused === true,
    intakePause: intakePause ? { until: intakePause.until ?? null,
      holders: (intakePause.holders ?? []).map(({ holder, since, until }) => ({ holder, since, until })) } : null,
    breaker: breaker ? { state: breaker.state, nextTrialAt: breaker.nextTrialAt ?? null } : null,
    queueHold: status?.queue?.hold ?? null,
    current: current ? { pr: current.pr, headSha: current.headSha, stage: current.stage, stageName: stageName(current.stage),
      since: current.since ?? null, stageSince: current.stageSince ?? null } : null,
    pending: liveRows(status).slice(0, MAX_ROWS).map(row => ({
      pr: row.pr, headSha: row.headSha, state: row.state, position: row.position ?? null, deferred: row.deferred ?? null,
      since: row.since ?? null, nextAt: row.nextAt ?? null, holdText: holdText(status, row, now).slice(0, MAX_TEXT_LENGTH),
    })),
    unqueued: unqueuedPulls(status, pulls).slice(0, MAX_ROWS).map(({ pr, headSha }) => ({ pr, headSha })),
    train: { enabled: train?.enabled ?? null, last: last ? {
      at: last.at, mode: last.mode, front: last.front ? { pr: last.front.pr } : null,
      wouldDo: last.wouldDo ?? null, decision: last.decision ?? null, onDuty: last.onDuty === true,
    } : null },
    alerts: events({ status, now, pulls, stall }).slice(0, ALERTS_MAX).map(e => e.title.slice(0, MAX_TEXT_LENGTH)),
    stall: stall ? { ...stall, text: stall.text.slice(0, MAX_TEXT_LENGTH) } : null,
  };
  if (Buffer.byteLength(JSON.stringify(view), 'utf8') > MAX_VIEW_BYTES) throw new Error('QUEUE_REPORT_TOO_LARGE');
  return view;
}

export class QueueReporter {
  constructor({ scope, nodeName, transport, readToken, clock = Date.now }) {
    this.scope = SCOPE.test(scope ?? '') ? scope : 'global';
    this.nodeName = nodeName;
    this.transport = transport;
    this.readToken = readToken;
    this.clock = clock;
    this.last = null;
    this.unavailableUntil = 0;
  }

  async step({ status, pulls = [] }) {
    const now = this.clock();
    if (now < this.unavailableUntil) return false;
    try {
      const view = queueReport({ status, pulls, now });
      view.node.name ??= this.nodeName ?? null;
      const key = digest(view.stall ? { ...view, stall: { ...view.stall, text: stableStallText(view.stall.text) } } : view);
      const same = key === this.last?.key;
      if (same && now - this.last.at < KEEPALIVE_MS) return false;
      const token = await this.readToken();
      if (!token) return false;
      // The server computes its own digest. Repeat the successful view verbatim for a keepalive.
      const sent = same ? this.last.view : view;
      const reply = await this.transport({ payload: { action: 'ci_queue_report', scope: this.scope, view: sent } }, { token });
      if (UNSUPPORTED.has(reply?.data?.error_code) || UNSUPPORTED.has(reply?.data?.message)) {
        this.unavailableUntil = this.clock() + UNAVAILABLE_MS;
      }
      if (reply?.status !== 200 || reply.data?.status !== 'ok') return false;
      this.last = { key, view: sent, at: this.clock() };
      return true;
    } catch { return false; }
  }
}
