// The node's duty on the PR page, the take-over check and the dual-active lock (resident primary/standby design v0.4
// §5.2, §5.3, §8.2, §9 C5; Task ade5df89; DESIGN §23). Runs in the companion (the Owner's own session and gh login),
// inside the PR page reporter (pr-status.mjs); everything here is advisory: the service-side ci-admission role and the
// GitHub read-back (C4) are what keep two nodes from publishing, never this.
//
// Each node writes its own commit status, context `resident-queue/<node> (info only)`, and only on the commits it queued
// or ran (its status.json current, pending and recent). The description starts with a fixed word:
//   - 当班 (on duty): the node is ACTIVE, its status is fresh (STATUS_STALE_MS), the executor is neither STOPPED nor
//     STARTING, there is no HALT, PAUSE, intake pause (C6) or open breaker, and the commit is queued or running;
//   - 双活停机 (dual-active stop): the node holds the dual-active lock (below); it blocks a take-over like 当班;
//   - 停摆（CODE） (stalled): one of the 当班 conditions fails, with its fixed code;
//   - 已交班 (handed over): written over the node's own 当班 and 双活停机 of the last DUTY_WINDOW_MS when it is STANDBY;
//   - anything else is a result text (已完成, 失败, 未准入, ...) and never counts as on duty.
// The duty statuses are written again every DUTY_REFRESH_MS even when unchanged, so "written within DUTY_WINDOW_MS"
// means "still alive" to the other node. A STANDBY node writes nothing under its queue context; it may write one
// reminder per (PR, commit, reason) under STANDBY_CONTEXT when the node on duty does not pick a PR up (§5.3).
//
// The node's name and mode come from status.json `node` (C1/C3 fill it). Absent (null): one node, ACTIVE, named by
// the companion's configuration (default DEFAULT_NODE), and no take-over check: the behaviour of a single node.
//
// Take-over check (§5.2): every time the node's role probe confirms the role (status.json node.probe), the companion
// reads the open PR heads' statuses. Another node's 当班 or 双活停机 written within DUTY_WINDOW_MS, by the Owner's own
// account and in the exact template, locks this node: it holds the executor's intake pause (C6, holder `dual-active`,
// renewed while locked, so it never runs out under a lock) and writes 双活停机 on its own queued commits. The lock is
// released only (review N1) when this node's probe finds it no longer holds the role (STANDBY: it writes 已交班), when
// the other node wrote 已交班 on a commit where it was seen on duty, or when the Owner resets it (an intake resume of
// holder `dual-active`, tools/rearm-tool.mjs). Two locked nodes never release each other.
import { CODE, HEX40 } from './canonical.mjs';
import { intakePauseRequest, intakeResumeRequest } from './intake-pause.mjs';

const MIN = 60_000;
// The node profile's rule (clued.independent-ci.node-profile/1 nodeName, C1): at most 32 characters, no '-' at the end.
export const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const DEFAULT_NODE = 'turing';
export const LEGACY_CONTEXT = 'resident-queue (info only)';
export const STANDBY_CONTEXT = 'resident-standby (info only)';
export const nodeContext = name => `resident-queue/${name} (info only)`;
const NODE_CONTEXT = /^resident-queue\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?) \(info only\)$/;
// Another node's duty status counts for this long after it was written; a node rewrites its own well inside it.
export const DUTY_WINDOW_MS = 30 * MIN;
export const DUTY_REFRESH_MS = 14 * MIN;
// §5.3: a head no node picked up within this long, or a node on duty stalled for this long, is reported by a STANDBY.
export const UNCLAIMED_MS = 30 * MIN;
export const STALL_NOTICE_MS = 10 * MIN;
// The dual-active hold (C6): renewed when less than this is left; never written more often than HOLD_WRITE_MS.
export const HOLDER_DUAL = 'dual-active';
export const HOLD_MINUTES = 120;
export const HOLD_RENEW_BELOW_MS = 90 * MIN;
export const HOLD_WRITE_MS = 5 * MIN;
// A released lock's partner statuses are read again at most this often.
export const RELEASE_READ_MS = 5 * MIN;
export const ADMISSION_APP_ID = 5368905;
export const ADMISSION_CHECK = 'kooyumi-work-admission';
export const WORD = Object.freeze({ ON: '当班', DUAL: '双活停机', STALLED: '停摆', HANDED: '已交班' });
const MODES = ['ACTIVE', 'STANDBY', 'UNCERTAIN'];
const LIVE = new Set(['QUEUED', 'PARKED', 'WAITING', 'BACKOFF']);
const hhmm = ms => new Date(ms).toISOString().slice(11, 16) + 'Z';

// status.json `node` (parsed by status.mjs) and the companion's own name -> { name, mode, probe, known }.
export function nodeOf(status, fallbackName = DEFAULT_NODE) {
  const n = status?.node;
  if (!n) return { name: fallbackName, mode: 'ACTIVE', probe: null, known: false };
  return { name: NODE_NAME.test(n.name ?? '') ? n.name : fallbackName, mode: MODES.includes(n.mode) ? n.mode : 'UNCERTAIN', probe: n.probe ?? null, known: true };
}

// The stall code when this node is not on duty now (null: on duty). The commit condition is the caller's.
export function stallCode(status, node, now, staleMs) {
  if (!status) return 'STATUS_UNREADABLE';
  if (now - status.writtenAt > staleMs) return 'STATUS_STALE';
  if (status.halt) return CODE.test(status.halt.code ?? '') ? status.halt.code : 'HALTED';
  if (status.executor?.state === 'STOPPED') return 'EXECUTOR_STOPPED';
  if (status.executor?.state === 'STARTING') return 'EXECUTOR_STARTING';
  if (status.paused) return 'PAUSED';
  if (status.intakePause) return 'INTAKE_PAUSED';
  if (status.breaker?.state === 'open') return 'BREAKER_OPEN';
  if (node.mode === 'UNCERTAIN') return 'NODE_ROLE_UNCERTAIN';
  return null;
}

const STALL_TEXT = Object.freeze({
  STATUS_UNREADABLE: () => '读不到执行器状态', STATUS_STALE: s => `执行器状态自 ${hhmm(s.writtenAt)} 起未更新，可能已停止`, EXECUTOR_STOPPED: () => '执行器已停止',
  EXECUTOR_STARTING: () => '执行器启动中', PAUSED: () => '执行器已暂停，等 Owner 恢复',
  INTAKE_PAUSED: s => `暂停接新中${s.intakePause?.until ? `，最晚 ${hhmm(s.intakePause.until)} 恢复` : ''}`,
  BREAKER_OPEN: s => `执行器熔断中${s.breaker?.nextTrialAt ? `，约 ${hhmm(s.breaker.nextTrialAt)} 试跑` : ''}`,
  NODE_ROLE_UNCERTAIN: () => '本节点角色探测不确定', NODE_RESTARTED: () => '本节点重启，等执行器恢复' });
// HALT codes, STATUS_STALE and a stopped executor need the Owner; the others clear by themselves.
const STALL_ERROR = new Set(['STATUS_UNREADABLE', 'STATUS_STALE', 'EXECUTOR_STOPPED']);

export function stalledText(code, status) {
  const text = STALL_TEXT[code] ? STALL_TEXT[code](status ?? {}) : '执行器已停机，等 Owner 复位';
  return { state: (STALL_TEXT[code] && !STALL_ERROR.has(code)) ? 'pending' : 'error', description: `${WORD.STALLED}（${code}）：${text}`, kind: 'stalled' };
}
export const dualText = other => ({ state: 'error', kind: 'dual',
  description: `${WORD.DUAL}：另一节点 ${other} 也在当班，本节点已停止取新触发；请在 KooYomi 收回其中一个的 ci-admission` });
export const handedText = () => ({ state: 'pending', kind: 'handed', description: `${WORD.HANDED}：本节点已不当班，这个提交由当班节点处理` });

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

// One commit status as GitHub lists it -> { node, word, code, at } when it is a resident queue status in the exact
// template written by the Owner's account; null otherwise (another writer, another context, another shape).
const TEMPLATE = /^(当班|双活停机|已交班)：.+$|^停摆（([A-Z][A-Z0-9_]{1,79})）：.+$/su;
export function parseDutyStatus(s, ownerLogin) {
  if (!s || typeof ownerLogin !== 'string' || ownerLogin.length === 0 || s.login !== ownerLogin) return null;
  const c = NODE_CONTEXT.exec(s.context ?? '');
  const at = Date.parse(s.created_at ?? '');
  if (!c || !Number.isFinite(at) || typeof s.description !== 'string' || s.description.length > 140) return null;
  const m = TEMPLATE.exec(s.description);
  if (!m) return null;
  return { node: c[1], word: m[1] ?? WORD.STALLED, code: m[2] ?? null, at };
}

// A head's statuses (newest first, as GitHub lists them) -> the latest duty status of every other node, with the start of
// its latest run of 停摆 (for §5.3 rule 2).
export function othersOnHead(list, ownName, ownerLogin) {
  const out = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    const d = parseDutyStatus(s, ownerLogin);
    if (!d || d.node === ownName) continue;
    const seen = out.get(d.node);
    if (!seen) { out.set(d.node, { ...d, stalledSince: d.word === WORD.STALLED ? d.at : null, open: d.word === WORD.STALLED }); continue; }
    // Older entries of the same node: extend the latest run of 停摆 back while it lasts.
    if (seen.open && d.word === WORD.STALLED) seen.stalledSince = d.at; else seen.open = false;
  }
  for (const v of out.values()) delete v.open;
  return out;
}

// Another node on duty on this head now (its latest status is 当班 or 双活停机 and was written within DUTY_WINDOW_MS).
export function onDutyElsewhere(others, now) {
  for (const d of others.values()) if ((d.word === WORD.ON || d.word === WORD.DUAL) && now - d.at <= DUTY_WINDOW_MS) return d;
  return null;
}

// §5.3, for a STANDBY node: why a head should be picked up and is not, or null. firstSeenAt: when this companion first saw
// the head open; admitted: whether App 5368905 published kooyumi-work-admission on it (null: unknown).
export function unclaimedReason({ others, firstSeenAt, admitted, now }) {
  for (const d of others.values()) {
    if (d.word === WORD.STALLED && d.stalledSince !== null && now - d.stalledSince >= STALL_NOTICE_MS && now - d.at <= DUTY_WINDOW_MS) return { reason: 'stalled', node: d.node, since: d.stalledSince, code: d.code };
  }
  if (admitted !== false || !Number.isFinite(firstSeenAt) || now - firstSeenAt < UNCLAIMED_MS) return null;
  if (onDutyElsewhere(others, now)) return null;
  return { reason: 'unclaimed', node: null, since: firstSeenAt, code: null };
}

export function standbyText(u, ownName, now) {
  const who = u.node ? `当班节点 ${u.node} ` : '当班节点';
  const minutes = Math.max(1, Math.round((now - u.since) / MIN));
  const why = u.reason === 'stalled' ? `已停摆 ${minutes} 分钟（${u.code ?? '?'}）` : `已 ${minutes} 分钟没接手`;
  return { state: 'pending', description: `${who}${why}；需要切换请在 KooYomi 把 ci-admission 移交给 ${ownName}`.slice(0, 140) };
}

// The read helpers' argv (fixed; every variable part matched first).
export function statusesArgv(ghExe, repo, headSha) {
  if (!HEX40.test(headSha ?? '')) throw new Error('head');
  return [ghExe, 'api', '--method', 'GET', `repos/${repo}/commits/${headSha}/statuses?per_page=100`, '--jq', '[.[] | {context, state, description, created_at, login: .creator.login}]'];
}
export function admissionArgv(ghExe, repo, headSha) {
  if (!HEX40.test(headSha ?? '')) throw new Error('head');
  return [ghExe, 'api', '--method', 'GET', `repos/${repo}/commits/${headSha}/check-runs?app_id=${ADMISSION_APP_ID}&check_name=${ADMISSION_CHECK}&filter=all&per_page=1`, '--jq', '.total_count'];
}
export const loginArgv = ghExe => [ghExe, 'api', '--method', 'GET', 'user', '--jq', '.login'];

// ---- the companion's side (pr-status.mjs#PrStatusReporter calls it once per pass) ----

// The duty memory, kept by the reporter in its LocalStore (the Owner's profile). Lost memory only means one more check.
//   mode: the mode last seen; probeAt: the probe whose take-over check ran; lock: null or { since, reason
//   ('dual-active' | 'takeover-refused'), other, heads, holdAt (last hold request written), holdUntil (the hold's end
//   as status.json last showed it), releaseReadAt }; seen: { 'pr:head': first seen open }; reminded: { key: at }.
export const freshMemory = () => ({ mode: null, probeAt: null, lock: null, seen: {}, reminded: {} });
const KEPT_MS = 86_400_000;
export function pruneMemory(m, now) {
  for (const bag of [m.seen, m.reminded]) for (const [k, v] of Object.entries(bag)) if (!(now - Date.parse(v) < KEPT_MS)) delete bag[k];
}

export class NodeDuty {
  // ports: { repo, ghExe, run(argv, { timeoutMs }), clock, memory (freshMemory shape, kept by the caller), fallbackName,
  //   writeRequest(value) -> Promise (creates one file in the resident's requests\; null: no lock can be held),
  //   timeoutMs, inBudget() -> bool, staleMs }
  constructor(ports) {
    Object.assign(this, ports);
    this.restarted = true; // the first pass after the companion started (the node may have restarted)
    this.login = null;
    this.readAt = new Map(); // head -> { at, others, admitted }: a STANDBY reads a head at most every RELEASE_READ_MS
  }

  // The Owner's GitHub login (the companion runs under it); null when unknown (nobody else's status then counts).
  async ownerLogin() {
    if (this.login) return this.login;
    const r = await this.run(loginArgv(this.ghExe), { timeoutMs: this.timeoutMs });
    const login = r.code === 0 ? String(r.stdout).trim() : '';
    this.login = /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null;
    return this.login;
  }

  // The other nodes' latest duty status on a head (othersOnHead), or null when it cannot be read now.
  async others(headSha) {
    const login = await this.ownerLogin();
    if (!login) return null;
    const r = await this.run(statusesArgv(this.ghExe, this.repo, headSha), { timeoutMs: this.timeoutMs });
    if (r.code !== 0) return null;
    let list;
    try { list = JSON.parse(r.stdout); } catch { return null; }
    return Array.isArray(list) ? othersOnHead(list, this.node.name, login) : null;
  }

  // Whether App 5368905 published kooyumi-work-admission on the head (null: unknown).
  async admitted(headSha) {
    const r = await this.run(admissionArgv(this.ghExe, this.repo, headSha), { timeoutMs: this.timeoutMs });
    const n = r.code === 0 ? Number(String(r.stdout).trim()) : NaN;
    return Number.isSafeInteger(n) ? n > 0 : null;
  }

  // One pass, before the PR page texts: the node, the lock (take-over check, releases, the hold) and the events to show.
  async prepare({ status, pulls, now }) {
    const m = this.memory;
    const node = this.node = nodeOf(status, this.fallbackName);
    const events = [];
    if (node.known && m.mode && m.mode !== node.mode && ['ACTIVE', 'STANDBY'].includes(node.mode)) {
      events.push(node.mode === 'ACTIVE'
        ? { key: `role:ACTIVE:${node.probe?.at ?? now}`, title: `${node.name} 已持有 ci-admission`, body: '本节点的角色探测确认持有 ci-admission，转为当班（ACTIVE）。' }
        : { key: `role:STANDBY:${node.probe?.at ?? now}`, title: `${node.name} 已不持有 ci-admission`, body: '本节点的角色探测确认已没有 ci-admission，转为待命（STANDBY），不再取新触发。' });
    }
    if (node.known && Number.isSafeInteger(node.probe?.failures) && node.probe.failures >= 3) {
      events.push({ key: `probe-failing:${node.probe.failingSince ?? node.probe.at ?? ''}`, title: `${node.name} 的角色探测连续失败`, body: `已连续 ${node.probe.failures} 次不确定，节点保持原模式。` });
    }
    if (m.lock) await this.release({ status, node, now, events });
    // The take-over check: every probe that confirms the role, while not locked. A check that cannot finish now (a read
    // failed, the pass ran out of time) runs again in the next pass.
    if (!m.lock && node.known && node.mode === 'ACTIVE' && node.probe?.result === 'held' && node.probe.at && node.probe.at !== m.probeAt) {
      const found = await this.takeoverCheck(pulls, now);
      if (found !== null) {
        m.probeAt = node.probe.at;
        if (found.length > 0 && this.writeRequest) {
          const reason = m.mode === 'ACTIVE' ? 'dual-active' : 'takeover-refused';
          m.lock = { since: now, reason, other: found[0].node, heads: [...new Set(found.map(f => f.headSha))].slice(0, 20), holdAt: null, holdUntil: null, releaseReadAt: now };
          events.push(reason === 'dual-active'
            ? { key: `dual:${now}`, title: '两个节点同时当班：本节点双活停机', body: `另一节点 ${found[0].node} 也在当班。本节点已停止取新触发。请在 KooYomi 收回其中一个的 ci-admission。` }
            // Review N2: the take-over time, idle and busy apart (never "45 minutes at most").
            : { key: `takeover-refused:${now}`, title: '另一节点还在当班：本节点不接班', body: `本节点已持有 ci-admission，但 ${found[0].node} 30 分钟内还在当班，本节点已停止取新触发。请在 KooYomi 收回其中一个的 ci-admission：对方空闲或停摆时，本节点下一次探测就接班；对方还在跑批时，要等它发现没有角色、写“已交班”之后。` });
        }
      }
    }
    if (m.lock) await this.keepHold(status, now);
    if (node.known) m.mode = node.mode;
    return { node, context: nodeContext(node.name), lock: m.lock, events };
  }

  // [{ node, headSha }] of the open heads where another node is on duty now; null when not every head could be read.
  async takeoverCheck(pulls, now) {
    const found = [];
    for (const p of pulls) {
      if (!this.inBudget()) return null;
      const others = await this.others(p.headSha);
      if (others === null) return null;
      const d = onDutyElsewhere(others, now);
      if (d) found.push({ node: d.node, headSha: p.headSha });
    }
    return found;
  }

  // The three releases of a lock (review N1): this node's probe found it no longer holds the role; the other node wrote
  // 已交班 on a head where it was seen on duty; the Owner reset it (an intake resume of holder dual-active).
  async release({ status, node, now, events }) {
    const lock = this.memory.lock;
    if (node.known && node.mode === 'STANDBY') return this.unlock('role-lost', now, events);
    const held = (status?.intakePause?.holders ?? []).find(h => h.holder === HOLDER_DUAL);
    const freshStatus = status && now - status.writtenAt <= this.staleMs;
    if (freshStatus && !held && lock.holdAt !== null && status.writtenAt > lock.holdAt + 60_000 && Number.isFinite(lock.holdUntil) && lock.holdUntil > now) {
      return this.unlock('owner-reset', now, events);
    }
    if (now - (lock.releaseReadAt ?? 0) < RELEASE_READ_MS) return;
    for (const head of lock.heads) {
      if (!this.inBudget()) return;
      const others = await this.others(head);
      if (others === null) return;
      if (others.get(lock.other)?.word === WORD.HANDED) return this.unlock('partner-handed-over', now, events);
    }
    lock.releaseReadAt = now;
  }

  async unlock(why, now, events) {
    const lock = this.memory.lock;
    // The Owner's own resume already lifted the hold; otherwise this node lifts its own (never another holder's).
    if (why !== 'owner-reset') await this.writeRequest(intakeResumeRequest({ holder: HOLDER_DUAL, reason: `dual-active lock released: ${why}` }, this.clock));
    this.memory.lock = null;
    const text = { 'role-lost': '本节点已不持有 ci-admission', 'partner-handed-over': `${lock.other} 已交班`, 'owner-reset': 'Owner 已复位' }[why];
    events.push({ key: `unlock:${lock.since}`, title: '双活停机已解除', body: `${text}，本节点恢复取新触发。` });
  }

  // The executor's intake pause (C6) held by holder dual-active while locked: renewed when less than HOLD_RENEW_BELOW_MS
  // is left, never more often than HOLD_WRITE_MS.
  async keepHold(status, now) {
    const lock = this.memory.lock;
    const held = (status?.intakePause?.holders ?? []).find(h => h.holder === HOLDER_DUAL);
    if (held && Number.isFinite(held.until)) lock.holdUntil = held.until;
    if (held && Number.isFinite(held.until) && held.until - now > HOLD_RENEW_BELOW_MS) return;
    if (lock.holdAt !== null && now - lock.holdAt < HOLD_WRITE_MS) return;
    await this.writeRequest(intakePauseRequest({ holder: HOLDER_DUAL, minutes: HOLD_MINUTES, reason: `dual-active lock: another node (${lock.other}) on duty` }, this.clock));
    lock.holdAt = now;
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
      if (this.memory.lock) return dualText(this.memory.lock.other);
      const code = stallCode(status, node, now, this.staleMs);
      if (code) return stalledText(code, status);
      return base ? { state: base.state, description: `${WORD.ON}：${base.description}`, kind: 'duty' } : null;
    }
    if (ownAny(status, pull) && base && !base.weak) return { ...base, kind: 'result' };
    return null;
  }

  // Writes beyond the per-head texts: [{ headSha, context, want, remind? }]. posted: the reporter's memory (head ->
  // { context, kind, at }); described: the heads given a text in this pass.
  //   - STANDBY: the node's own 当班 and 双活停机 of the last DUTY_WINDOW_MS become 已交班 (review NIT 2: results stay);
  //   - the first pass after the companion started: those not described again become 停摆（NODE_RESTARTED） (NIT 4);
  //   - STANDBY, §5.3: one reminder per (PR, head, reason) under STANDBY_CONTEXT.
  async extra({ posted, described, pulls, now }) {
    const node = this.node, own = nodeContext(node.name), out = [];
    for (const [headSha, last] of Object.entries(posted)) {
      if (last?.context !== own || !['duty', 'dual'].includes(last.kind) || !(now - Date.parse(last.at) <= DUTY_WINDOW_MS)) continue;
      if (node.mode === 'STANDBY') out.push({ headSha, context: own, want: handedText() });
      else if (this.restarted && !described.has(headSha)) out.push({ headSha, context: own, want: stalledText('NODE_RESTARTED', null) });
    }
    this.restarted = false;
    if (node.mode !== 'STANDBY') return out;
    const m = this.memory;
    for (const p of pulls) {
      if (!p.eligible) continue;
      const seenKey = `${p.pr}:${p.headSha}`;
      m.seen[seenKey] ??= new Date(now).toISOString();
      const firstSeenAt = Date.parse(m.seen[seenKey]);
      if (now - firstSeenAt < STALL_NOTICE_MS) continue;
      let r = this.readAt.get(p.headSha);
      if (!r || now - r.at >= RELEASE_READ_MS) {
        if (!this.inBudget()) break;
        const others = await this.others(p.headSha);
        if (others === null) break;
        const admitted = now - firstSeenAt >= UNCLAIMED_MS ? await this.admitted(p.headSha) : null;
        r = { at: now, others, admitted };
        this.readAt.set(p.headSha, r);
      }
      const u = unclaimedReason({ others: r.others, firstSeenAt, admitted: r.admitted, now });
      if (!u) continue;
      const key = `standby:${p.pr}:${p.headSha}:${u.reason}`;
      if (m.reminded[key]) continue;
      out.push({ headSha: p.headSha, context: STANDBY_CONTEXT, want: standbyText(u, node.name, now), remind: { key, pr: p.pr } });
    }
    if (this.readAt.size > 256) for (const k of [...this.readAt.keys()].slice(0, this.readAt.size - 256)) this.readAt.delete(k);
    return out;
  }
}
