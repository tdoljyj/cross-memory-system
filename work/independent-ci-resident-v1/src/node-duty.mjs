// PR statuses describe this node's work and health. Native work authority is
// established separately; other nodes' GitHub statuses are never consulted here.
import { CODE } from './canonical.mjs';

const MIN = 60_000;
// The node profile's rule (clued.independent-ci.node-profile/1 nodeName, C1): at most 32 characters, no '-' at the end.
export const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// status.json `node.source` (contract /6, C3): the first 12 hex digits of the installed CI Source's ciSourceManifestSha256.
export const NODE_SOURCE = /^[0-9a-f]{12}$/;
export const LEGACY_CONTEXT = 'resident-queue (info only)';
// The shared standby context of before Task 9cac75be A2 (never written again; each node now writes its own).
export const LEGACY_STANDBY_CONTEXT = 'resident-standby (info only)';
export const nodeContext = name => `resident-queue/${name} (info only)`;
export const standbyContext = name => `resident-standby/${name} (info only)`;
// Own status refresh and handover history are for display.
export const DUTY_WINDOW_MS = 30 * MIN;
export const DUTY_REFRESH_MS = 14 * MIN;
// GitHub keeps at most 1000 statuses per context and commit: a long wait stops being refreshed before that (review m8).
export const REFRESH_MAX_POSTS = 900;
export const RETIRED_DUAL_ACTIVE_HOLDER = 'dual-active';
export const WORD = Object.freeze({ ON: '当班', STALLED: '停摆', HANDED: '已交班' });
const MODES = ['ACTIVE', 'STANDBY', 'UNCERTAIN'];
const LIVE = new Set(['QUEUED', 'PARKED', 'WAITING', 'BACKOFF']);
const hhmm = ms => new Date(ms).toISOString().slice(11, 16) + 'Z';
const iso = ms => new Date(ms).toISOString();
const clip = s => (s.length <= 140 ? s : `${s.slice(0, 139)}…`);

// status.json `node` (parsed by status.mjs) and the companion's own name -> { name, mode, probe, known }, or null when
// neither names a node (fail closed: never a default name).
export function nodeOf(status, fallbackName = null) {
  const n = status?.node;
  const fallback = NODE_NAME.test(fallbackName ?? '') ? fallbackName : null;
  const name = n && NODE_NAME.test(n.name ?? '') ? n.name : fallback;
  if (!name) return null;
  if (!n) return { name, mode: 'ACTIVE', probe: null, known: false };
  return { name, mode: MODES.includes(n.mode) ? n.mode : 'UNCERTAIN', probe: n.probe ?? null, known: true };
}

// The stall code when this node is not on duty now (null: on duty). The commit condition is the caller's.
export function stallCode(status, node, now, staleMs) {
  if (!status) return 'STATUS_UNREADABLE';
  if (now - status.writtenAt > staleMs) return 'STATUS_STALE';
  if (status.halt) return CODE.test(status.halt.code ?? '') ? status.halt.code : 'HALTED';
  if (status.executor?.state === 'STOPPED') return 'EXECUTOR_STOPPED';
  if (status.executor?.state === 'STARTING') return 'EXECUTOR_STARTING';
  if (status.paused) return 'PAUSED';
  if (operationalIntakePause(status.intakePause)) return 'INTAKE_PAUSED';
  if (status.breaker?.state === 'open') return 'BREAKER_OPEN';
  if (node.mode === 'UNCERTAIN') return 'NODE_ROLE_UNCERTAIN';
  return null;
}

const STALL_TEXT = Object.freeze({
  STATUS_UNREADABLE: () => '读不到执行器状态', STATUS_STALE: s => `执行器状态自 ${hhmm(s.writtenAt)} 起未更新，可能已停止`, EXECUTOR_STOPPED: () => '执行器已停止',
  EXECUTOR_STARTING: () => '执行器启动中', PAUSED: () => '执行器已暂停，等 Owner 恢复',
  INTAKE_PAUSED: s => {
    const until = operationalIntakePause(s.intakePause)?.until;
    return `暂停接新中${until ? `，最晚 ${hhmm(until)} 恢复` : ''}`;
  },
  BREAKER_OPEN: s => `执行器熔断中${s.breaker?.nextTrialAt ? `，约 ${hhmm(s.breaker.nextTrialAt)} 试跑` : ''}`,
  NODE_ROLE_UNCERTAIN: () => '本节点角色探测不确定', NODE_RESTARTED: () => '本节点重启，等执行器恢复' });
// HALT codes, STATUS_STALE and a stopped executor need the Owner; the others clear by themselves.
const STALL_ERROR = new Set(['STATUS_UNREADABLE', 'STATUS_STALE', 'EXECUTOR_STOPPED']);

export function stalledText(code, status) {
  const text = STALL_TEXT[code] ? STALL_TEXT[code](status ?? {}) : '执行器已停机，等 Owner 复位';
  return { state: (STALL_TEXT[code] && !STALL_ERROR.has(code)) ? 'pending' : 'error', description: `${WORD.STALLED}（${code}）：${text}`, kind: 'stalled' };
}
// 已交班 over a duty text; over a result written since, the result stays readable after the word (review NIT 2, M3).
export function handedText(last = null) {
  if (last && last.kind === 'result' && typeof last.description === 'string') return { state: last.state, kind: 'handed', description: clip(`${WORD.HANDED}：${last.description}`) };
  return { state: 'pending', kind: 'handed', description: `${WORD.HANDED}：本节点已不当班，这个提交由当班节点处理` };
}

// Whether a head is this node's own queued or running commit (it rests in status current or a live pending row).
export function ownLive(status, pull) {
  const mine = x => x && x.pr === pull.pr && x.headSha === pull.headSha;
  return mine(status?.current) || (status?.pending ?? []).some(r => mine(r) && LIVE.has(r.state));
}
// Whether the node ran or queued the head at all (its recent outcomes and stopped rows too).
export function ownAny(status, pull) {
  const mine = x => x && x.pr === pull.pr && x.headSha === pull.headSha;
  return ownLive(status, pull) || (status?.pending ?? []).some(mine) || (status?.recent ?? []).some(mine);
}

// Task 63c3c879, ADR 0028: a reminder a STANDBY left pending under its standbyContext before ADR 0028 ends as success (GitHub counts a
// pending status, even one no rule requires, as an unfinished check: mergeStateStatus UNSTABLE, PR #1027).
export const STANDBY_DONE_TEXT = Object.freeze({ state: 'success', description: '备用提醒已取消（ADR 0028）' });
// What ends a HALT row (want(): kind 'halted') once the reset is seen: a result row, no duty word, none of the words the panel reads
// as progress, HALT or stall (compute_panel.py#resident_latest, #resident_stall).
export const HALT_CLEARED_TEXT = Object.freeze({ state: 'success', description: '执行器已复位', kind: 'reset' });

const DUAL_CLEARED_TEXT = Object.freeze({ state: 'success', description: '已清理旧双活暂停状态', kind: 'reset' });

export const freshMemory = () => ({ mode: null, handover: {}, standby: {} });
const KEPT_MS = 86_400_000;
const bag = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function validMemory(raw) {
  const m = freshMemory();
  if (!raw || typeof raw !== 'object') return m;
  if (['ACTIVE', 'STANDBY'].includes(raw.mode)) m.mode = raw.mode;
  for (const key of ['handover', 'standby']) m[key] = bag(raw[key]);
  return m;
}

// Status from a previous package may still include the retired holder. Unknown
// holder data remains a hold, and removing the retired holder cannot extend one.
export function operationalIntakePause(pause) {
  if (!pause || !Array.isArray(pause.holders) || !pause.holders.some(h => h?.holder === RETIRED_DUAL_ACTIVE_HOLDER)) return pause;
  const holders = pause.holders.filter(h => h?.holder !== RETIRED_DUAL_ACTIVE_HOLDER);
  if (holders.length === 0) return null;
  const until = holders.every(h => Number.isFinite(h?.until)) ? Math.max(...holders.map(h => h.until)) : null;
  return { until, holders };
}

export function pruneMemory(m, now) {
  for (const [k, v] of Object.entries(m.standby ?? {})) if (!(now - Date.parse(v?.at) < KEPT_MS)) delete m.standby[k];
  for (const [k, v] of Object.entries(m.handover)) if (!(now - Date.parse(v) < KEPT_MS)) delete m.handover[k];
}

export class NodeDuty {
  constructor({ memory, fallbackName, staleMs }) {
    Object.assign(this, { memory, fallbackName, staleMs });
    this.restarted = true;
    this.restartOwed = null;
  }

  prepare({ status, now, posted = {} }) {
    const m = this.memory;
    const node = this.node = nodeOf(status, this.fallbackName);
    // No node name anywhere: the pass writes nothing (pr-status.mjs#pass: a duty that cannot be worked out).
    if (!node) throw new Error('NODE_NAME_REQUIRED');
    const own = nodeContext(node.name);
    const events = [];
    // Role changes count between definite modes only: an UNCERTAIN in between changes nothing (review m3).
    const definite = node.known && node.mode !== 'UNCERTAIN';
    if (definite && m.mode && m.mode !== node.mode) {
      events.push(node.mode === 'ACTIVE'
        ? { key: `role:ACTIVE:${node.probe?.at ?? now}`, title: `${node.name} 已持有 ci-admission`, body: '本节点的角色探测确认持有 ci-admission，转为当班（ACTIVE）。' }
        : { key: `role:STANDBY:${node.probe?.at ?? now}`, title: `${node.name} 已不持有 ci-admission`, body: '本节点的角色探测确认已没有 ci-admission，转为待命（STANDBY），不再取新触发。' });
    }
    if (node.known && Number.isSafeInteger(node.probe?.failures) && node.probe.failures >= 3) {
      events.push({ key: `probe-failing:${node.probe.failingSince ?? iso(now).slice(0, 10)}`, title: `${node.name} 的角色探测连续失败`, body: `已连续 ${node.probe.failures} 次不确定，节点保持原模式。` });
    }
    // STANDBY: every own commit with a recent 当班 in the last DUTY_WINDOW_MS is owed one 已交班, until written (m5).
    // ACTIVE again: nothing is owed any more (re-review: never 已交班 over a 当班 of the same pass).
    if (definite && node.mode === 'ACTIVE') m.handover = {};
    if (node.known && node.mode === 'STANDBY') {
      for (const [head, last] of Object.entries(posted)) {
        if (last?.context === own && !['handed', 'dual'].includes(last.kind) && now - Date.parse(last.dutyAt) <= DUTY_WINDOW_MS) m.handover[head] ??= iso(now);
      }
    }
    if (definite) m.mode = node.mode;
    return { node, context: own, events };
  }

  // What this node writes on one open PR head under its own context, or null. base: pr-status.mjs#describe's text.
  want(pull, status, now, base) {
    const node = this.node;
    if (!node || node.mode === 'STANDBY') return null;
    // Review NIT 3: the "behind main" hint stays, on the node that would run the PR (not a duty word, so no other node
    // ever reads it as on duty); a STANDBY writes none.
    if (!pull.eligible) return base ? { ...base, kind: 'hint' } : null;
    if (!status) return null;
    if (ownLive(status, pull)) {
      const code = stallCode(status, node, now, this.staleMs);
      if (code) return stalledText(code, status);
      return base ? { state: base.state, description: `${WORD.ON}：${base.description}`, kind: 'duty', ...(base.weak ? { weak: true } : {}) } : null;
    }
    if (ownAny(status, pull) && base && !base.weak) return { ...base, kind: 'result' };
    // Field defect 2026-11-23: a HALT is executor-wide, so the node says it on every eligible open PR head, also one it never queued
    // (the PRs that ended the HALT are merged; without this the open ones carried nothing and the panel read the node as idle). The
    // text is pr-status.mjs#describe's own (执行器已停机（码），等 Owner 复位): no duty word, so no other node reads it as on duty, it
    // is owed no 已交班 and is not refreshed. A stale status is not a HALT known now: nothing, as before.
    if (status.halt && now - status.writtenAt <= this.staleMs && base?.state === 'error') return { ...base, kind: 'halted' };
    return null;
  }

  // Writes beyond the per-head texts: [{ headSha, context, want, handover?, restart?, standbyDone? }]. posted: the reporter's
  // memory (head -> { context, kind, at, dutyAt }); described: the heads given a text in this pass.
  //   - 已交班 on every head owed one (prepare), until it is written;
  //   - after the companion started: an open head whose 当班 of the last DUTY_WINDOW_MS was not described again
  //     gets 停摆（NODE_RESTARTED） (NIT 4); the reporter ends the restart once those are written (m4);
  //   - after a reset: the HALT rows this node left end as HALT_CLEARED_TEXT (status: this pass's status.json, or null);
  //   - ADR 0028: a reminder this node left pending under its standbyContext before ends as success (STANDBY_DONE_TEXT, standbyDone: the
  //     head); a head no longer open is forgotten.
  async extra({ posted, described, pulls, now, status = null }) {
    const node = this.node, own = nodeContext(node.name), out = [], m = this.memory;
    for (const headSha of Object.keys(m.handover)) {
      if (!described.has(headSha)) out.push({ headSha, context: own, want: handedText(posted[headSha]?.context === own ? posted[headSha] : null), handover: true });
    }
    if (this.restarted && node.mode !== 'STANDBY') {
      const open = new Set(pulls.map(p => p.headSha));
      // Fixed at the first pass: a later pass only retries those (re-review: a head merely not described later is no
      // restart's business).
      this.restartOwed ??= new Set(Object.entries(posted).filter(([, last]) => last?.context === own && last.kind === 'duty'
        && now - Date.parse(last.at) <= DUTY_WINDOW_MS).map(([h]) => h));
      for (const headSha of [...this.restartOwed]) {
        if (!open.has(headSha) || described.has(headSha)) { this.restartOwed.delete(headSha); continue; }
        out.push({ headSha, context: own, want: stalledText('NODE_RESTARTED', null), restart: true });
      }
      if (this.restartOwed.size === 0) this.restarted = false;
    }
    // ADR 0028: a reminder left pending before is ended once, while its head is still open; a closed one is forgotten.
    m.standby ??= {};
    const open = new Set(pulls.map(p => p.headSha));
    for (const [headSha, last] of Object.entries(posted)) {
      if (last?.context === own && last.kind === 'dual' && open.has(headSha) && !described.has(headSha)
        && !Object.hasOwn(m.handover, headSha)) out.push({ headSha, context: own, want: DUAL_CLEARED_TEXT });
    }
    // The HALT rows are owed their end (FABLE-resident-halt-merge-race-followup-20261123 §2), in every mode: once a fresh status
    // carries no halt, each one this node left on a still-open head that this pass did not describe again (and that is owed no
    // 已交班 above) is rewritten once as HALT_CLEARED_TEXT. A node still on duty never describes a PR it did not queue, and a STANDBY
    // describes none, so without this the error row stayed until the PR closed: the panel read the node as HALTed and the PR as
    // stalled. A stale or unreadable status is no reset known now: nothing.
    if (status && !status.halt && now - status.writtenAt <= this.staleMs) {
      for (const [headSha, last] of Object.entries(posted)) {
        if (last?.context === own && last.kind === 'halted' && open.has(headSha) && !described.has(headSha) && !Object.hasOwn(m.handover, headSha)) out.push({ headSha, context: own, want: HALT_CLEARED_TEXT });
      }
    }
    for (const headSha of Object.keys(m.standby)) {
      if (!open.has(headSha)) delete m.standby[headSha];
      else out.push({ headSha, context: standbyContext(node.name), want: STANDBY_DONE_TEXT, standbyDone: headSha });
    }
    return out;
  }
}
