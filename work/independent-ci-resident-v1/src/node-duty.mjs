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
//   - 已交班 (handed over): when the node is STANDBY, written once on every commit where it wrote 当班 or 双活停机 in the
//     last DUTY_WINDOW_MS; a result written there since stays readable after the word (已交班：<result>);
//   - anything else is a result text (已完成, 失败, 未准入, ...) and never counts as on duty.
// The duty statuses are written again every DUTY_REFRESH_MS even when unchanged, so "written within DUTY_WINDOW_MS"
// means "still alive" to the other node. A STANDBY node writes nothing under its queue context except 已交班; it may
// write one reminder per (PR, commit, reason) under its own standbyContext(<node>) when the node on duty does not pick a PR
// up (§5.3).
// What another node wrote counts by its LATEST status on a commit, whatever that says: a result after 当班 is no duty.
//
// The node's name and mode come from status.json `node` (C1/C3 fill it; `source` is for the people who read it). Absent (null): one node, ACTIVE, named by
// the companion's configuration (its pinned node profile), and no take-over check: the behaviour of a single node. No name at all
// fails closed: the pass writes nothing (Task 9cac75be A3: there is no default node; any number of nodes, never two).
//
// Take-over check (§5.2): every time the node's role probe confirms the role (status.json node.probe), the companion
// reads the open PR heads' statuses, at most TAKEOVER_READS_PER_PASS a pass (generation 12: a new probe does not restart a check in
// progress, and while the node stays ACTIVE a new one starts at most every TAKEOVER_RECHECK_MS, DESIGN §23.4 and §56.2). Another node's 当班 or 双活停机 written
// within DUTY_WINDOW_MS, by the Owner's own account and in the exact template, locks this node: it holds the
// executor's intake pause (C6, holder `dual-active`, renewed while locked, so it never runs out under a lock) and
// writes 双活停机 on its own queued commits. The lock is released only (review N1) when this node's probe finds it no
// longer holds the role (STANDBY: it writes 已交班), when EVERY node seen on duty has handed over (已交班 on a commit where it
// was seen) or aged out (none of those commits shows it on duty within DUTY_WINDOW_MS; Task 9cac75be A1: any number of
// nodes), or when the Owner resets it (an intake resume of holder `dual-active`, tools/rearm-tool.mjs, seen twice a minute
// apart, never while the executor cannot read its intake state). Two locked nodes never release each other.
import { CODE, HEX40 } from './canonical.mjs';
import { intakePauseRequest, intakeResumeRequest } from './intake-pause.mjs';

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
// A lock keeps at most this many nodes seen on duty, and this many commits per node.
export const LOCK_NODES_MAX = 16;
export const LOCK_HEADS_MAX = 20;
const NODE_CONTEXT = /^resident-queue\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?) \(info only\)$/;
// Another node's duty status counts for this long after it was written; a node rewrites its own well inside it.
export const DUTY_WINDOW_MS = 30 * MIN;
export const DUTY_REFRESH_MS = 14 * MIN;
// GitHub keeps at most 1000 statuses per context and commit: a long wait stops being refreshed before that (review m8).
export const REFRESH_MAX_POSTS = 900;
// §5.3: a head no node picked up within this long, or a node on duty stalled for this long, is reported by a STANDBY.
export const UNCLAIMED_MS = 30 * MIN;
export const STALL_NOTICE_MS = 10 * MIN;
// The dual-active hold (C6): renewed when less than this is left; never written more often than HOLD_WRITE_MS, or
// HOLD_STALE_WRITE_MS while the executor's status is stale (nobody would read the requests).
export const HOLDER_DUAL = 'dual-active';
export const HOLD_MINUTES = 120;
export const HOLD_RENEW_BELOW_MS = 90 * MIN;
export const HOLD_WRITE_MS = 5 * MIN;
export const HOLD_STALE_WRITE_MS = 60 * MIN;
// An Owner reset is the dual-active hold gone before its end, seen twice at least this far apart.
export const RESET_CONFIRM_MS = MIN;
// Holders the executor shows when it cannot read its own intake state: then a missing hold is no Owner reset.
const UNSURE_HOLDERS = ['unconfirmed', 'unreadable'];
// A lock's partner statuses are read again at most this often; a STANDBY reads a head at most this often.
export const RELEASE_READ_MS = 5 * MIN;
// The take-over check reads at most this many heads a pass (review M4), and after a failed read waits this long.
export const TAKEOVER_READS_PER_PASS = 10;
// A check in progress is not restarted by the probes that come meanwhile (it ends when read through, or is dropped when the role is not
// confirmed any more or a lock is set), and a new one starts at most this often while the node stays ACTIVE (generation 12, review
// rounds 27 and 28: the queue watch confirms the role every 30 s; restarting on each would never read past the first
// TAKEOVER_READS_PER_PASS heads). A node that just became ACTIVE (also from UNCERTAIN), whose executor started again, or whose last check
// was dropped, starts its check at once.
export const TAKEOVER_RECHECK_MS = 15 * MIN;
export const READ_RETRY_MS = 5 * MIN;
// A head the take-over check cannot read this many times in a row is passed over (counted as nobody on duty there), so
// one unreadable head never keeps the check from ending (re-review of C5).
export const READ_GIVE_UP = 3;
export const ADMISSION_APP_ID = 5368905;
export const ADMISSION_CHECK = 'kooyumi-work-admission';
export const WORD = Object.freeze({ ON: '当班', DUAL: '双活停机', STALLED: '停摆', HANDED: '已交班' });
const MODES = ['ACTIVE', 'STANDBY', 'UNCERTAIN'];
const LOCK_REASONS = ['dual-active', 'takeover-refused'];
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
// other: one node's name, or the names of every node seen on duty.
export const dualText = other => ({ state: 'error', kind: 'dual',
  description: clip(`${WORD.DUAL}：另一节点 ${[other].flat().join('、')} 也在当班，本节点已停止取新触发；请在 KooYomi 收回其中一个的 ci-admission`) });
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

// One commit status as GitHub lists it -> { node, word, code, at } when the Owner's account wrote it under a node's queue
// context; word is null when the text is not in a duty template (a result, a hint: never on duty). null: another
// writer or another context, which never counts at all.
const TEMPLATE = /^(当班|双活停机|已交班)：.+$|^停摆（([A-Z][A-Z0-9_]{1,79})）：.+$/su;
export function parseDutyStatus(s, ownerLogin) {
  if (!s || typeof ownerLogin !== 'string' || ownerLogin.length === 0 || s.login !== ownerLogin) return null;
  const c = NODE_CONTEXT.exec(s.context ?? '');
  const at = Date.parse(s.created_at ?? '');
  if (!c || !Number.isFinite(at)) return null;
  const m = typeof s.description === 'string' && s.description.length <= 140 ? TEMPLATE.exec(s.description) : null;
  if (!m) return { node: c[1], word: null, code: null, at };
  return { node: c[1], word: m[1] ?? WORD.STALLED, code: m[2] ?? null, at };
}

// A head's statuses (newest first, as GitHub lists them) -> every other node's LATEST status there, whatever it says
// (review M1), with the start of its latest run of 停摆 (for §5.3 rule 2).
export function othersOnHead(list, ownName, ownerLogin) {
  const out = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    const d = parseDutyStatus(s, ownerLogin);
    if (!d || d.node === ownName) continue;
    const seen = out.get(d.node);
    if (!seen) { out.set(d.node, { ...d, stalledSince: d.word === WORD.STALLED ? d.at : null, open: d.word === WORD.STALLED }); continue; }
    // Older entries of the same node: extend the latest run of 停摆 back while it lasts; anything else ends it.
    if (seen.open && d.word === WORD.STALLED) seen.stalledSince = d.at; else seen.open = false;
  }
  for (const v of out.values()) delete v.open;
  return out;
}

// Another node on duty on this head now (its latest status is 当班 or 双活停机 and was written within DUTY_WINDOW_MS).
export function onDutyElsewhere(others, now) {
  return allOnDutyElsewhere(others, now)[0] ?? null;
}
// Every other node on duty on this head now (review R3 M4: with three or more nodes two others may be on duty on one head).
export function allOnDutyElsewhere(others, now) {
  return [...others.values()].filter(d => (d.word === WORD.ON || d.word === WORD.DUAL) && now - d.at <= DUTY_WINDOW_MS);
}

// §5.3, for a STANDBY node: why a head should be picked up and is not, or null. firstSeenAt: when this companion first saw
// the head open; admitted: whether App 5368905 published kooyumi-work-admission on it (null: unknown).
//   - stalled: the node on duty wrote 停摆 there for STALL_NOTICE_MS;
//   - stale: its latest word there is 当班 or 双活停机, older than DUTY_WINDOW_MS (it stopped refreshing: a node that died
//     mid-batch, after its admission check; review m9);
//   - unclaimed: no admission check and nobody on duty there for UNCLAIMED_MS since this companion saw the head.
export function unclaimedReason({ others, firstSeenAt, admitted, now }) {
  for (const d of others.values()) {
    if (d.word === WORD.STALLED && d.stalledSince !== null && now - d.stalledSince >= STALL_NOTICE_MS && now - d.at <= DUTY_WINDOW_MS) return { reason: 'stalled', node: d.node, since: d.stalledSince, code: d.code };
    if ((d.word === WORD.ON || d.word === WORD.DUAL) && now - d.at > DUTY_WINDOW_MS) return { reason: 'stale', node: d.node, since: d.at, code: null };
  }
  if (admitted !== false || !Number.isFinite(firstSeenAt) || now - firstSeenAt < UNCLAIMED_MS) return null;
  if (onDutyElsewhere(others, now)) return null;
  return { reason: 'unclaimed', node: null, since: firstSeenAt, code: null };
}

export function standbyText(u, ownName, now) {
  const who = u.node ? `当班节点 ${u.node} ` : '当班节点';
  const minutes = Math.max(1, Math.round((now - u.since) / MIN));
  const why = u.reason === 'stalled' ? `已停摆 ${minutes} 分钟（${u.code ?? '?'}）` : u.reason === 'stale' ? `的状态已 ${minutes} 分钟没刷新` : `已 ${minutes} 分钟没接手`;
  return { state: 'pending', description: clip(`${who}${why}；需要切换请在 KooYomi 把 ci-admission 移交给 ${ownName}`) };
}
// Task 63c3c879 (DESIGN §23.3): the end of a reminder this node left pending under its standbyContext. GitHub counts a pending status, even
// one no rule requires, as an unfinished check (mergeStateStatus UNSTABLE, PR #1027), so once the reminder is moot it ends as success:
//   handled: the node on duty took the head up (its 当班/双活停机 there, or App 5368905's admission check on it);
//   active: this node holds ci-admission now (it runs the PR itself);
//   ineligible: no resident runs this PR (a draft, another base, a fork).
export function standbyDoneText(why, ownName) {
  if (why === 'active') return { state: 'success', description: clip(`${ownName} 已接班，备用提醒结束`) };
  return { state: 'success', description: clip(`备用节点 ${ownName}，不参与本 PR${why === 'handled' ? '：当班节点已接手' : ''}`) };
}
// Review N2: the take-over time, idle and busy apart (never "45 minutes at most"); shown in the reminder's notification.
export const TAKEOVER_TIME_TEXT = '移交后：对方空闲或停摆时，本节点下一次角色探测（通常 15 分钟内）就接班；对方还在跑批时，要等它发现没有角色、写“已交班”之后。';

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
//   mode: the last definite mode seen (ACTIVE or STANDBY); probeAt: the probe whose take-over check ran; lock: null or
//   { since, reason, other (the first node seen), others: [{ node, heads, cleared }] (every node seen on duty, the commits
//   it was seen on, whether it handed over or aged out), heads (all of them), holdAt (last hold request written), holdUntil
//   (the hold's end as status.json last showed it), releaseReadAt, resetSeenAt }; handover: { head: since } heads owed an 已交班; seen: { 'pr:head': first
//   seen open }; reminded: { key: at }; toasts: { key: { title, body, at } } notifications still to show; standby: { head: { pr, at } } the
//   reminders written under standbyContext and not ended yet (Task 63c3c879).
export const freshMemory = () => ({ mode: null, probeAt: null, lock: null, handover: {}, seen: {}, reminded: {}, toasts: {}, standby: {} });
const KEPT_MS = 86_400_000;
const num = v => (Number.isSafeInteger(v) ? v : null);
const bag = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// A stored memory as the reporter may use it. A lock that does not have the shape is kept as a lock (fail safe: holding
// is the safe side) with what can be read of it (review m7); everything else that does not fit starts fresh.
export function validMemory(raw, now) {
  const m = freshMemory();
  if (!raw || typeof raw !== 'object') return m;
  if (['ACTIVE', 'STANDBY'].includes(raw.mode)) m.mode = raw.mode;
  m.probeAt = num(raw.probeAt);
  for (const k of ['handover', 'seen', 'reminded', 'toasts', 'standby']) m[k] = bag(raw[k]);
  // A memory of before Task 63c3c879 has no standby bag: the reminders it still remembers (reminded, kept a day) are taken as not ended.
  if (raw.standby === undefined) {
    for (const [k, at] of Object.entries(m.reminded)) {
      const r = /^standby:([1-9][0-9]*):([0-9a-f]{40}):[a-z]+$/.exec(k);
      if (r && Number.isSafeInteger(Number(r[1]))) m.standby[r[2]] = { pr: Number(r[1]), at };
    }
  }
  if (raw.lock && typeof raw.lock === 'object') {
    const l = raw.lock;
    const other = NODE_NAME.test(l.other ?? '') ? l.other : 'unknown';
    const heads = Array.isArray(l.heads) ? l.heads.filter(h => HEX40.test(h ?? '')).slice(0, LOCK_HEADS_MAX) : [];
    // A lock of before A1 names one node: it stands for every head. A node entry that does not fit stays as 'unknown' (never
    // released by a partner: fail safe).
    const others = Array.isArray(l.others) && l.others.length > 0
      ? l.others.slice(0, LOCK_NODES_MAX).map(o => ({ node: NODE_NAME.test(o?.node ?? '') ? o.node : 'unknown',
        heads: Array.isArray(o?.heads) ? o.heads.filter(h => HEX40.test(h ?? '')).slice(0, LOCK_HEADS_MAX) : [], cleared: o?.cleared === true }))
      : [{ node: other, heads, cleared: false }];
    m.lock = { since: num(l.since) ?? now, reason: LOCK_REASONS.includes(l.reason) ? l.reason : 'dual-active', other, others, heads, holdAt: num(l.holdAt), holdUntil: num(l.holdUntil),
      releaseReadAt: num(l.releaseReadAt), resetSeenAt: num(l.resetSeenAt) };
  }
  return m;
}

// The nodes a take-over check found on duty ([{ node, headSha }]) as a lock's `others`, first seen first.
export function lockOthers(found) {
  const by = new Map();
  for (const f of found) {
    if (!by.has(f.node)) { if (by.size >= LOCK_NODES_MAX) continue; by.set(f.node, { node: f.node, heads: [], cleared: false }); }
    const o = by.get(f.node);
    if (!o.heads.includes(f.headSha) && o.heads.length < LOCK_HEADS_MAX) o.heads.push(f.headSha);
  }
  return [...by.values()];
}
const pending = lock => lock.others.filter(o => !o.cleared).map(o => o.node);
export function pruneMemory(m, now) {
  for (const b of [m.seen, m.reminded]) for (const [k, v] of Object.entries(b)) if (!(now - Date.parse(v) < KEPT_MS)) delete b[k];
  for (const [k, v] of Object.entries(m.standby ?? {})) if (!(now - Date.parse(v?.at) < KEPT_MS)) delete m.standby[k];
  for (const [k, v] of Object.entries(m.toasts)) if (!(now - Date.parse(v?.at) < KEPT_MS)) delete m.toasts[k];
  for (const [k, v] of Object.entries(m.handover)) if (!(now - Date.parse(v) < KEPT_MS)) delete m.handover[k];
}

export class NodeDuty {
  // ports: { repo, ghExe, run(argv, { timeoutMs }), clock, memory (freshMemory shape, kept by the caller), fallbackName,
  //   writeRequest(value) -> Promise (creates one file in the resident's requests\; null: no lock can be held),
  //   timeoutMs, inBudget() -> bool, staleMs }
  constructor(ports) {
    Object.assign(this, ports);
    this.restarted = true; // the first passes after the companion started, until the restart writes are done (NIT 4)
    this.login = null;
    this.check = null; // the take-over check in progress: { probeAt, wasActive, heads, idx, found, retryAt, fails }
    this.checkStartedAt = null; // when the last check that may still count for TAKEOVER_RECHECK_MS started (generation 12)
    this.executorPid = null; // the executor's pid in the last status seen: another one starts the spacing over
    this.restartOwed = null; // the heads owed 停摆（NODE_RESTARTED）, fixed at the first pass after the start
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

  // The other nodes' latest status on a head (othersOnHead), or null when it cannot be read now.
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

  // One pass, after the status notifications and before the PR page texts: the node, what it owes (已交班), the lock
  // (take-over check, releases, the hold) and the events to show. posted: the reporter's memory of its own writes.
  async prepare({ status, pulls, now, posted = {} }) {
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
    // STANDBY: every own commit with 当班 or 双活停机 in the last DUTY_WINDOW_MS is owed one 已交班, until written (m5).
    // ACTIVE again: nothing is owed any more (re-review: never 已交班 over a 当班 of the same pass).
    if (definite && node.mode === 'ACTIVE') m.handover = {};
    if (node.known && node.mode === 'STANDBY') {
      for (const [head, last] of Object.entries(posted)) {
        if (last?.context === own && last.kind !== 'handed' && now - Date.parse(last.dutyAt) <= DUTY_WINDOW_MS) m.handover[head] ??= iso(now);
      }
    }
    if (m.lock) await this.release({ status, node, now, events });
    // The take-over check: on a probe that confirms the role, while not locked, at most every TAKEOVER_RECHECK_MS while the node stays
    // ACTIVE; TAKEOVER_READS_PER_PASS heads a pass.
    // The spacing holds only while the node stays ACTIVE under the same executor: a node seen in any other mode (UNCERTAIN too, which
    // memory.mode does not keep) or an executor that started again (another pid) checks at its next confirmation, as in generation 11
    // (review round 29, MINOR 2).
    if (node.known && node.mode !== 'ACTIVE') this.checkStartedAt = null;
    if (Number.isSafeInteger(status?.pid)) { if (this.executorPid != null && status.pid !== this.executorPid) this.checkStartedAt = null; this.executorPid = status.pid; }
    const probeHeld = !m.lock && node.known && node.mode === 'ACTIVE' && node.probe?.result === 'held' && node.probe.at;
    // A check dropped before its end (the role not confirmed any more, a lock) does not count for the spacing (review round 28, NIT 2).
    if (!probeHeld) { if (this.check) this.checkStartedAt = null; this.check = null; }
    else if (node.probe.at !== m.probeAt && !this.check
      && (m.mode !== 'ACTIVE' || !(Number.isFinite(this.checkStartedAt) && now >= this.checkStartedAt && now - this.checkStartedAt < TAKEOVER_RECHECK_MS))) {
      // wasActive: the mode before this probe, for the lock's reason (re-review: a check may end passes later).
      this.checkStartedAt = now;
      this.check = { probeAt: node.probe.at, wasActive: m.mode === 'ACTIVE', heads: [...new Set(pulls.map(p => p.headSha))], idx: 0, found: [], retryAt: 0, fails: 0 };
    }
    if (this.check && now >= this.check.retryAt && await this.continueCheck(now)) {
      const { found, wasActive } = this.check;
      m.probeAt = this.check.probeAt;
      this.check = null;
      if (found.length > 0 && this.writeRequest) {
        const reason = wasActive ? 'dual-active' : 'takeover-refused';
        const others = lockOthers(found);
        m.lock = { since: now, reason, other: others[0].node, others, heads: [...new Set(found.map(f => f.headSha))].slice(0, LOCK_HEADS_MAX), holdAt: null, holdUntil: null,
          releaseReadAt: now, resetSeenAt: null };
        const names = others.map(o => o.node).join('、');
        // Review M3: under a lock the next probe does not take over; the texts say what releases it.
        const release = `${names} 都收回角色、写“已交班”（或 30 分钟不再当班）后，本节点自动解除；本节点被收回则转为待命。也可以用 rearm-tool request-intake-resume --holder dual-active 复位。`;
        events.push(reason === 'dual-active'
          ? { key: `dual:${now}`, title: '多个节点同时当班：本节点双活停机', body: `另一节点 ${names} 也在当班，本节点已停止取新触发。请在 KooYomi 只留一个节点的 ci-admission。${release}` }
          : { key: `takeover-refused:${now}`, title: '另一节点还在当班：本节点不接班', body: `本节点已持有 ci-admission，但 ${names} 30 分钟内还在当班，本节点已停止取新触发。请在 KooYomi 只留一个节点的 ci-admission。${release}` });
      }
    }
    if (m.lock) await this.keepHold(status, now);
    if (definite) m.mode = node.mode;
    // Notifications owed from earlier passes (a reminder whose toast could not be shown then; review m6).
    for (const [key, t] of Object.entries(m.toasts)) events.push({ key, title: t.title, body: t.body });
    return { node, context: own, lock: m.lock, events };
  }

  // Reads the next heads of the take-over check. true: every head is read (check.found is the answer); false: not yet
  // (out of reads or time for this pass, or a read failed: then not before READ_RETRY_MS).
  async continueCheck(now) {
    const c = this.check;
    for (let n = 0; c.idx < c.heads.length; n++) {
      if (n >= TAKEOVER_READS_PER_PASS || !this.inBudget()) return false;
      // Without the Owner's login nothing can be read: the check waits, no head is counted as failed.
      if (!(await this.ownerLogin())) { c.retryAt = now + READ_RETRY_MS; return false; }
      const others = await this.others(c.heads[c.idx]);
      if (others === null) {
        c.fails += 1;
        if (c.fails < READ_GIVE_UP) { c.retryAt = now + READ_RETRY_MS; return false; }
        c.fails = 0; c.idx += 1; // passed over: the check is an aid, never a guarantee (DESIGN §23.4)
        continue;
      }
      c.fails = 0;
      for (const d of allOnDutyElsewhere(others, now)) c.found.push({ node: d.node, headSha: c.heads[c.idx] });
      c.idx += 1;
    }
    return true;
  }

  // The three releases of a lock (review N1): this node's probe found it no longer holds the role; every node seen on duty
  // is cleared, each by an 已交班 on a head where it was seen, or by none of those heads showing it on duty within
  // DUTY_WINDOW_MS any more (aged out; Task 9cac75be A1); the Owner reset it (the dual-active hold gone before its end, after
  // the executor read our last request, while it can read its intake state, seen twice RESET_CONFIRM_MS apart: review M2).
  async release({ status, node, now, events }) {
    const lock = this.memory.lock;
    if (node.known && node.mode === 'STANDBY') return this.unlock('role-lost', now, events);
    const holders = status?.intakePause?.holders ?? [];
    const held = holders.find(h => h.holder === HOLDER_DUAL);
    const fresh = status && now - status.writtenAt <= this.staleMs;
    const gone = fresh && !held && !holders.some(h => UNSURE_HOLDERS.includes(h.holder)) && lock.holdAt !== null && status.writtenAt > lock.holdAt + 60_000
      && Number.isFinite(lock.holdUntil) && lock.holdUntil > now;
    if (!gone) lock.resetSeenAt = null;
    else if (lock.resetSeenAt === null) lock.resetSeenAt = now;
    else if (now - lock.resetSeenAt >= RESET_CONFIRM_MS) return this.unlock('owner-reset', now, events);
    if (now - (lock.releaseReadAt ?? 0) < RELEASE_READ_MS) return;
    // Set before the reads: a head that cannot be read is tried again in RELEASE_READ_MS, not every pass (review M4).
    lock.releaseReadAt = now;
    const reads = new Map();
    // Every node is read again each time, a cleared one too: a node that aged out and then writes 当班 again on a head it was
    // seen on (its role back, or a late refresh) holds the lock again; the age-out bound is DUTY_WINDOW_MS, the window every
    // duty status counts for (onDutyElsewhere, unclaimedReason's 'stale').
    for (const o of lock.others) {
      let handed = false, seenOnDuty = false;
      for (const head of o.heads) {
        if (!this.inBudget()) return;
        if (!reads.has(head)) {
          const others = await this.others(head);
          if (others === null) return;
          reads.set(head, others);
        }
        const d = reads.get(head).get(o.node);
        if (d?.word === WORD.HANDED) { handed = true; break; }
        if (d && (d.word === WORD.ON || d.word === WORD.DUAL) && now - d.at <= DUTY_WINDOW_MS) seenOnDuty = true;
      }
      // A node with no head to look at (a lock kept from a shape that did not fit) is never cleared by a partner read.
      o.cleared = handed || (!seenOnDuty && o.heads.length > 0);
    }
    if (pending(lock).length === 0) return this.unlock('partner-handed-over', now, events);
  }

  async unlock(why, now, events) {
    const lock = this.memory.lock;
    // The Owner's own resume already lifted the hold; otherwise this node lifts its own (never another holder's).
    if (why !== 'owner-reset') await this.writeRequest(intakeResumeRequest({ holder: HOLDER_DUAL, reason: `dual-active lock released: ${why}` }, this.clock));
    this.memory.lock = null;
    const text = { 'role-lost': '本节点已不持有 ci-admission', 'partner-handed-over': `${lock.others.map(o => o.node).join('、')} 已交班或不再当班`, 'owner-reset': 'Owner 已复位' }[why];
    events.push({ key: `unlock:${lock.since}`, title: '双活停机已解除', body: `${text}，本节点恢复取新触发。` });
  }

  // The executor's intake pause (C6) held by holder dual-active while locked: renewed when less than HOLD_RENEW_BELOW_MS
  // is left, never more often than HOLD_WRITE_MS (HOLD_STALE_WRITE_MS while the status is stale), and never while an
  // Owner reset is being confirmed.
  async keepHold(status, now) {
    const lock = this.memory.lock;
    if (lock.resetSeenAt !== null) return;
    const held = (status?.intakePause?.holders ?? []).find(h => h.holder === HOLDER_DUAL);
    if (held && Number.isFinite(held.until)) lock.holdUntil = held.until;
    if (held && Number.isFinite(held.until) && held.until - now > HOLD_RENEW_BELOW_MS) return;
    const every = status && now - status.writtenAt <= this.staleMs ? HOLD_WRITE_MS : HOLD_STALE_WRITE_MS;
    if (lock.holdAt !== null && now - lock.holdAt < every) return;
    await this.writeRequest(intakePauseRequest({ holder: HOLDER_DUAL, minutes: HOLD_MINUTES, reason: `dual-active lock: another node (${pending(lock).join(', ') || lock.other}) on duty`.slice(0, 200) }, this.clock));
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
      if (this.memory.lock) return dualText(pending(this.memory.lock).length ? pending(this.memory.lock) : this.memory.lock.other);
      const code = stallCode(status, node, now, this.staleMs);
      if (code) return stalledText(code, status);
      return base ? { state: base.state, description: `${WORD.ON}：${base.description}`, kind: 'duty', ...(base.weak ? { weak: true } : {}) } : null;
    }
    if (ownAny(status, pull) && base && !base.weak) return { ...base, kind: 'result' };
    return null;
  }

  // Writes beyond the per-head texts: [{ headSha, context, want, handover?, restart?, remind? }]. posted: the reporter's
  // memory (head -> { context, kind, at, dutyAt }); described: the heads given a text in this pass.
  //   - 已交班 on every head owed one (prepare), until it is written;
  //   - after the companion started: an open head whose 当班 or 双活停机 of the last DUTY_WINDOW_MS was not described again
  //     gets 停摆（NODE_RESTARTED） (NIT 4); the reporter ends the restart once those are written (m4);
  //   - STANDBY, §5.3: one reminder per (PR, head, reason) under its own standbyContext(<node>);
  //   - Task 63c3c879: a reminder of this node still pending ends as success (standbyDoneText, standbyDone: the head) once it is moot:
  //     this node is ACTIVE, or (STANDBY) the PR is not eligible or the node on duty took the head up. A head no longer open is forgotten.
  async extra({ posted, described, pulls, now }) {
    const node = this.node, own = nodeContext(node.name), out = [], m = this.memory;
    for (const headSha of Object.keys(m.handover)) {
      if (!described.has(headSha)) out.push({ headSha, context: own, want: handedText(posted[headSha]?.context === own ? posted[headSha] : null), handover: true });
    }
    if (this.restarted && node.mode !== 'STANDBY') {
      const open = new Set(pulls.map(p => p.headSha));
      // Fixed at the first pass: a later pass only retries those (re-review: a head merely not described later is no
      // restart's business).
      this.restartOwed ??= new Set(Object.entries(posted).filter(([, last]) => last?.context === own && ['duty', 'dual'].includes(last.kind)
        && now - Date.parse(last.at) <= DUTY_WINDOW_MS).map(([h]) => h));
      for (const headSha of [...this.restartOwed]) {
        if (!open.has(headSha) || described.has(headSha)) { this.restartOwed.delete(headSha); continue; }
        out.push({ headSha, context: own, want: stalledText('NODE_RESTARTED', null), restart: true });
      }
      if (this.restartOwed.size === 0) this.restarted = false;
    }
    m.standby ??= {};
    const open = new Set(pulls.map(p => p.headSha));
    for (const headSha of Object.keys(m.standby)) if (!open.has(headSha)) delete m.standby[headSha];
    const done = (headSha, why) => ({ headSha, context: standbyContext(node.name), want: standbyDoneText(why, node.name), standbyDone: headSha });
    if (node.mode === 'ACTIVE') for (const headSha of Object.keys(m.standby)) out.push(done(headSha, 'active'));
    if (node.mode !== 'STANDBY') return out;
    let reads = 0;
    for (const p of pulls) {
      if (!p.eligible) { if (m.standby[p.headSha]) out.push(done(p.headSha, 'ineligible')); continue; }
      const seenKey = `${p.pr}:${p.headSha}`;
      m.seen[seenKey] ??= iso(now);
      const firstSeenAt = Date.parse(m.seen[seenKey]);
      let r = this.readAt.get(p.headSha);
      if (!r || now - r.at >= RELEASE_READ_MS) {
        if (reads >= TAKEOVER_READS_PER_PASS || !this.inBudget()) break;
        reads += 1;
        const others = await this.others(p.headSha);
        if (others === null) break;
        const admitted = now - firstSeenAt >= UNCLAIMED_MS ? await this.admitted(p.headSha) : null;
        r = { at: now, others, admitted };
        this.readAt.set(p.headSha, r);
      }
      const u = unclaimedReason({ others: r.others, firstSeenAt, admitted: r.admitted, now });
      // Ended only on a positive sign that the node on duty has it (never on an unknown read).
      if (!u && m.standby[p.headSha] && (r.admitted === true || onDutyElsewhere(r.others, now))) { out.push(done(p.headSha, 'handled')); continue; }
      if (!u) continue;
      const key = `standby:${p.pr}:${p.headSha}:${u.reason}`;
      if (m.reminded[key]) continue;
      out.push({ headSha: p.headSha, context: standbyContext(node.name), want: standbyText(u, node.name, now), remind: { key, pr: p.pr } });
    }
    if (this.readAt.size > 256) for (const k of [...this.readAt.keys()].slice(0, this.readAt.size - 256)) this.readAt.delete(k);
    return out;
  }
}
