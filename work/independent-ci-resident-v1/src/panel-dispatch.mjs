// The compute panel's five-minute trigger (Task b42419de, Decision 7eb98011, Note 9477974e; DESIGN §43). GitHub drops most
// schedule events for this repository (about 1.5% of the */5 runs of clued-compute-panel.yml fired), so the node that holds
// ci-admission starts the workflow itself with workflow_dispatch on main every five minutes; the GitHub cron stays as the
// fallback. Runs in the companion (the Owner's own session and gh login), in a lane of its own; everything here is advisory:
// a missed or doubled dispatch costs one panel refresh, never a check result (the panel is no PR check).
//
// Credential: none of its own. The same `gh` login as every other companion call (poller, pr-head, the take-over comment);
// no token is read, nothing is put into GitHub. The one write is `POST repos/<repo>/actions/workflows/<file>/dispatches ref=main`
// (the workflow takes no inputs), with a fixed argv; the one extra read is the workflow's last runs (also the cross-node guard).
//
// Who dispatches: this node's status.json says node.mode ACTIVE (the role probe found the ci-admission role here), the snapshot is
// fresh. Before every dispatch the workflow's own run
// list on GitHub is read, and a run on main younger than MIN_GAP_MS (any event: a dispatch of another node, a schedule event)
// counts as this slot's dispatch, so two nodes that are both ACTIVE for a moment do not dispatch twice (a race inside one read
// interval can, and the workflow's concurrency group then cancels one of the two runs). Two things shrink that window further: the
// list is read once more right before the POST, and every node waits a small node-specific time (staggerMs, from its name) when it
// takes the duty and when it follows a run it did not make, so two nodes do not wake up on the same run + five minutes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { check } from './canonical.mjs';
import { parseIncluded } from './poller.mjs';
import { NODE_NAME } from './node-duty.mjs';

const MIN = 60_000;
// The repository the panel workflow lives in. Pinned here, not read from the configuration: the dispatcher only ever starts this workflow of this repository.
export const PANEL_REPO = 'tdoljyj/cross-memory-system';
export const PANEL_WORKFLOW = 'clued-compute-panel.yml';
export const PANEL_REF = 'main';
// Nominal cadence (the workflow's own cron is */5; Decision 7eb98011).
export const DISPATCH_EVERY_MS = 5 * MIN;
// A run of the workflow on main younger than this holds the slot: no dispatch (cross-node and cron guard).
export const MIN_GAP_MS = 4 * MIN;
// A status.json older than this does not prove the role (the executor's own STATUS_STALE_MS).
export const STATUS_FRESH_MS = 5 * MIN;
// After a failed attempt (runs unreadable, dispatch refused, dispatch accepted but no run appeared): 1, 2, 4, 8, then 15 minutes.
export const BACKOFF_MS = Object.freeze([1 * MIN, 2 * MIN, 4 * MIN, 8 * MIN, 15 * MIN]);
export const FAILURES_NOTIFY = 3;
// On duty and no run of the workflow on main for this long: one notification per spell, whatever the cause.
export const STALL_NOTIFY_MS = 15 * MIN;
// Hard ceiling, kept across restarts: never more dispatches than this in an hour (a bug must not flood the pool).
export const MAX_PER_HOUR = 20;
// A dispatch counts as effective when a run of the workflow created after it (minus this slack) is in the list.
export const VERIFY_SLACK_MS = MIN;
export const RUNS_TIMEOUT_MS = 20_000;
export const DISPATCH_TIMEOUT_MS = 30_000;
// Node-specific wait (0 to 57 s in 3 s steps, from the node's name) so that two nodes that are on duty at once do not dispatch in the same second.
export const STAGGER_STEP_MS = 3_000;
export const STAGGER_STEPS = 20;
export const DUTY_LOG_KEPT = 10;
export const STATE_CONTRACT = 'clued.independent-ci.panel-dispatch-state/1';
const STATE_TICK_WRITE_MS = MIN;
const NOTIFIED_KEPT = 50;
const RUNS_PER_PAGE = 5;
// 0 .. 57 s, the same for the same name on every start.
export function staggerMs(nodeName) {
  return createHash('sha256').update(String(nodeName), 'utf8').digest()[0] % STAGGER_STEPS * STAGGER_STEP_MS;
}
// Failures that retrying does not cure: the notification does not wait for FAILURES_NOTIFY.
const NEEDS_OWNER = new Set(['DISPATCH_FORBIDDEN', 'DISPATCH_NOT_FOUND', 'DISPATCH_REJECTED']);

// companion.json `panelDispatch`: absent = on (the Decision); { enabled: false } is the switch. Nothing else is configurable.
export function validatePanelDispatchConfig(c) {
  if (c === undefined || c === null) return Object.freeze({ enabled: true });
  check(typeof c === 'object' && !Array.isArray(c) && Object.keys(c).every(k => k === 'enabled') && (c.enabled === undefined || typeof c.enabled === 'boolean'),
    'COMPANION_PANEL_DISPATCH_CONFIG_INVALID');
  return Object.freeze({ enabled: c.enabled !== false });
}

function argvCheck(ghExe, repo) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\/.test(ghExe) && repo === PANEL_REPO, 'PANEL_DISPATCH_ARGS_INVALID');
}
// --include: the status line and headers come first; the Date header is GitHub's clock, which ages the runs without trusting this machine's.
export function runsArgv(ghExe, repo) {
  argvCheck(ghExe, repo);
  return [ghExe, 'api', '--include', '--method', 'GET', `repos/${repo}/actions/workflows/${PANEL_WORKFLOW}/runs?branch=${PANEL_REF}&per_page=${RUNS_PER_PAGE}`];
}
export function dispatchArgv(ghExe, repo) {
  argvCheck(ghExe, repo);
  return [ghExe, 'api', '--method', 'POST', `repos/${repo}/actions/workflows/${PANEL_WORKFLOW}/dispatches`, '-f', `ref=${PANEL_REF}`];
}

// `gh api --include` of the runs route -> { serverNow (ms), runs: [{ id, event, status, createdAt (ms) }] newest first }, or null when it is not that.
export function parseRuns(stdout, localNow) {
  const p = parseIncluded(stdout);
  if (!p || p.status !== 200) return null;
  let v;
  try { v = JSON.parse(p.body); } catch { return null; }
  if (!v || !Array.isArray(v.workflow_runs) || v.workflow_runs.length > 100) return null;
  const runs = [];
  for (const r of v.workflow_runs) {
    const createdAt = Date.parse(r?.created_at ?? '');
    if (!Number.isSafeInteger(r?.id) || r.id <= 0 || typeof r.event !== 'string' || typeof r.status !== 'string' || !Number.isFinite(createdAt)) return null;
    runs.push({ id: r.id, event: r.event, status: r.status, createdAt });
  }
  runs.sort((a, b) => b.createdAt - a.createdAt);
  const head = p.body === '' ? stdout : stdout.slice(0, stdout.search(/\r?\n\r?\n/));
  const d = /^date:\s*(.+?)\s*$/im.exec(head);
  const server = d ? Date.parse(d[1]) : NaN;
  return { serverNow: Number.isFinite(server) ? server : localNow, runs };
}

// The reason this node is not the one to dispatch now, or null when it is. nodeName: this node's pinned name.
export function dutyOf(status, nodeName, now) {
  if (!status) return 'STATUS_UNREADABLE';
  if (!(now - status.writtenAt <= STATUS_FRESH_MS)) return 'STATUS_STALE';
  if (!status.node) return 'NODE_UNKNOWN';
  if (status.node.name !== nodeName) return 'NODE_NAME_MISMATCH';
  if (status.node.mode === 'UNCERTAIN') return 'NODE_ROLE_UNCERTAIN';
  if (status.node.mode !== 'ACTIVE') return 'NOT_ACTIVE';
  return null;
}

// The v2 port owns the shared reservation and settlement. It calls send once,
// only after reserving this exact effect. No answer can fall back to a POST.
export async function dispatchByTrainEffect({ trainProtocolVersion = 1, dispatchTrainEffect }, effect, send) {
  if (trainProtocolVersion === 1) return { sent: true, reply: await send() };
  if (trainProtocolVersion !== 2 || typeof dispatchTrainEffect !== 'function') return { sent: false };
  let open = true, sent = false, reply;
  try {
    await dispatchTrainEffect(Object.freeze({ ...effect, subject: Object.freeze(effect.subject) }), async () => {
      check(open && !sent, 'TRAIN_AUXILIARY_DISPATCH_ALREADY_USED');
      sent = true;
      reply = await send();
      return reply;
    });
  } finally { open = false; }
  return { sent, reply };
}

const emptyState = () => ({ contract: STATE_CONTRACT, lastDispatchAt: null, pendingAt: null, sent: [], notified: {}, tickAt: null, duty: null, dutyLog: [], lastRunAt: null, failures: 0, lastCode: null });
const time = v => (Number.isSafeInteger(v) && v > 0 ? v : null);

// The dispatcher's own memory in the Owner's profile (like the heartbeat's): when it last dispatched (a restart must not dispatch at
// once again), the dispatches of the last hour (the ceiling), the notifications already shown, and its own pulse for people to read.
export class PanelDispatchState {
  constructor(file) { this.file = file; this.data = emptyState(); }
  static async open(file) {
    const s = new PanelDispatchState(file);
    try {
      const v = JSON.parse(await fs.readFile(file, 'utf8'));
      if (v?.contract === STATE_CONTRACT) {
        s.data = { ...emptyState(), lastDispatchAt: time(v.lastDispatchAt), pendingAt: time(v.pendingAt), sent: Array.isArray(v.sent) ? v.sent.filter(t => time(t)).slice(-MAX_PER_HOUR) : [],
          notified: v.notified && typeof v.notified === 'object' && !Array.isArray(v.notified) ? v.notified : {},
          dutyLog: Array.isArray(v.dutyLog) ? v.dutyLog.filter(e => time(e?.at) && typeof e.on === 'boolean').slice(-DUTY_LOG_KEPT) : [] };
      }
    } catch { /* fresh memory */ }
    return s;
  }
  async save() {
    const keys = Object.keys(this.data.notified);
    if (keys.length > NOTIFIED_KEPT) for (const k of keys.sort((a, b) => this.data.notified[a] - this.data.notified[b]).slice(0, keys.length - NOTIFIED_KEPT)) delete this.data.notified[k];
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data));
    await fs.rename(tmp, this.file);
  }
}

const TEXT = Object.freeze({
  DISPATCH_FORBIDDEN: 'GitHub 拒绝了触发（401/403）：gh 登录没有 Actions 写权限，或触到了速率限制。',
  DISPATCH_NOT_FOUND: 'GitHub 答 404：gh 登录看不到这个 workflow，或没有触发它的权限（私有仓库对无权限的写也答 404）。',
  DISPATCH_REJECTED: 'GitHub 答 422：main 上的 workflow 不接受 workflow_dispatch（被改过？）。',
  DISPATCH_TIMEOUT: '触发请求超时。', DISPATCH_FAILED: '触发请求失败。', RUNS_UNREADABLE: '读不到 workflow 的运行列表。',
  DISPATCH_NO_RUN: 'GitHub 收下了触发（204），但约 5 分钟后 main 上没有新的运行。' });

export class PanelDispatcher {
  // ports: { nodeName, repo, ghExe, run(argv, { timeoutMs }), clock, readStatus() -> status (throws when unreadable),
  //   notify(key, title, body) (one Windows toast), state (PanelDispatchState) }
  constructor(ports) {
    Object.assign(this, ports);
    check(NODE_NAME.test(this.nodeName ?? ''), 'PANEL_DISPATCH_NODE_REQUIRED');
    argvCheck(this.ghExe, this.repo);
    this.failures = 0; this.spellSince = null; this.onDutySince = null; this.stallSpell = null; this.alarmedAt = null;
    this.lastRunSeenAt = null; this.lastTickWriteAt = 0; this.capUntil = 0; this.stagger = staggerMs(this.nodeName);
    this.nextAt = (this.state.data.lastDispatchAt ?? 0) + DISPATCH_EVERY_MS;
  }

  async say(key, title, body) {
    try {
      const n = this.state.data.notified;
      if (n[key]) return;
      n[key] = this.clock();
      await this.state.save();
      await this.notify(key, title, body);
    } catch { /* advisory */ }
  }

  async persist(now, force = false) {
    const d = this.state.data;
    if (!force && now - this.lastTickWriteAt < STATE_TICK_WRITE_MS) return;
    this.lastTickWriteAt = now;
    d.tickAt = now; d.failures = this.failures;
    try { await this.state.save(); } catch { /* the pulse is for people; the loop goes on */ }
  }

  async fail(now, code) {
    const d = this.state.data;
    this.failures += 1; this.spellSince ??= now; d.lastCode = code;
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1];
    this.nextAt = now + wait;
    if (this.failures >= FAILURES_NOTIFY || NEEDS_OWNER.has(code)) {
      this.alarmedAt ??= now;
      await this.say(`panel-dispatch-failing:${this.spellSince}`, '算力面板的 5 分钟触发失败',
        `${TEXT[code] ?? code}（已连续 ${this.failures} 次，${Math.round(wait / MIN)} 分钟后重试）。GitHub 的 cron 仍在兜底，但约 6 小时才跑一次。`);
    }
    await this.persist(now, true);
    return { dispatched: false, failed: code, failures: this.failures, retryInMs: wait };
  }

  // One look, every lane tick: not on duty -> nothing; on duty and due -> read the runs, then dispatch at most once.
  async step() {
    const now = this.clock();
    const d = this.state.data;
    let status = null;
    try { status = await this.readStatus(); } catch { status = null; }
    const off = dutyOf(status, this.nodeName, now);
    // The pulse says how the duty is now; the log keeps the last few changes (why a five-minute slot was missed).
    if (d.duty?.on !== (off === null) || d.duty?.reason !== off) {
      d.dutyLog.push({ at: now, on: off === null, reason: off });
      d.dutyLog = d.dutyLog.slice(-DUTY_LOG_KEPT);
      this.lastTickWriteAt = 0;
    }
    d.duty = { on: off === null, reason: off };
    if (off) {
      // Not the node on duty: a spell of its own is over; the next duty starts fresh (a failed spell is the next node's business).
      this.onDutySince = null; this.failures = 0; this.spellSince = null; this.stallSpell = null; this.alarmedAt = null;
      await this.persist(now);
      return { skipped: 'NOT_ON_DUTY', reason: off };
    }
    if (this.onDutySince === null) {
      // Taking the duty: this node's own small wait first, so that a node that took over while the other still is ACTIVE does not start in the same second.
      this.onDutySince = now;
      this.nextAt = Math.max(this.nextAt, now + this.stagger);
    }
    // A clock that moved back (a resync) must not park the next attempt far in the future.
    if (this.nextAt - now > BACKOFF_MS[BACKOFF_MS.length - 1]) this.nextAt = now;
    await this.stallCheck(now);
    if (now < this.capUntil && this.capUntil - now <= 60 * MIN) { await this.persist(now); return { skipped: 'HOURLY_CAP', untilMs: this.capUntil - now }; }
    if (now < this.nextAt) { await this.persist(now); return { skipped: 'NOT_DUE', inMs: this.nextAt - now }; }

    // A dispatch time in the future belongs to a clock that has since been set back: it does not count (it would hold the ceiling for as long as the clock was off).
    d.sent = d.sent.filter(t => t <= now && now - t < 60 * MIN);
    if (d.sent.length >= MAX_PER_HOUR) {
      // Its own deadline, apart from nextAt (the clock guard above is for nextAt); not looked at again, nor the state written again, before it.
      this.capUntil = d.sent[0] + 60 * MIN;
      await this.persist(now, true);
      return { skipped: 'HOURLY_CAP', untilMs: this.capUntil - now };
    }

    const r = await this.run(runsArgv(this.ghExe, this.repo), { timeoutMs: RUNS_TIMEOUT_MS });
    const read = r.code === 0 && !r.timedOut && !r.refused ? parseRuns(r.stdout, now) : null;
    if (!read) return this.fail(now, 'RUNS_UNREADABLE');
    // GitHub's clock for the runs' ages: this machine's clock may be off (DESK's was, Decision 1100a0ed). seenAt: the newest run on this machine's timeline.
    const age = run => Math.max(0, read.serverNow - run.createdAt);
    const newest = read.runs[0] ?? null;
    if (newest) this.lastRunSeenAt = Math.max(this.lastRunSeenAt ?? 0, now - age(newest));
    d.lastRunAt = this.lastRunSeenAt;
    await this.recovered(now);

    // The previous dispatch must have produced a run (the same list that guards against doubling).
    if (d.pendingAt !== null) {
      const effective = read.runs.some(x => now - age(x) >= d.pendingAt - VERIFY_SLACK_MS);
      if (effective) { d.pendingAt = null; this.failures = 0; this.spellSince = null; d.lastCode = null; } else {
        d.pendingAt = null;
        return this.fail(now, 'DISPATCH_NO_RUN');
      }
    }
    if (newest && age(newest) < MIN_GAP_MS) {
      // That run is this slot's dispatch (ours, another node's, or the cron's): the next slot is five minutes after it.
      this.nextAt = now + (DISPATCH_EVERY_MS - age(newest)) + this.stagger;
      await this.persist(now, true);
      return { skipped: 'RECENT_RUN', ageMs: age(newest), event: newest.event };
    }

    // Once more right before the POST: another node's dispatch made since the first read (a read takes up to seconds) holds the slot.
    const again = await this.run(runsArgv(this.ghExe, this.repo), { timeoutMs: RUNS_TIMEOUT_MS });
    const second = again.code === 0 && !again.timedOut && !again.refused ? parseRuns(again.stdout, now) : null;
    if (!second) return this.fail(now, 'RUNS_UNREADABLE');
    const latest = second.runs[0] ?? null;
    const latestAge = latest ? Math.max(0, second.serverNow - latest.createdAt) : null;
    if (latest && latestAge < MIN_GAP_MS) {
      this.nextAt = now + (DISPATCH_EVERY_MS - latestAge) + this.stagger;
      await this.persist(now, true);
      return { skipped: 'RECENT_RUN', ageMs: latestAge, event: latest.event, recheck: true };
    }

    let dispatch;
    try {
      dispatch = await dispatchByTrainEffect(this,
        { repo: this.repo, ref: PANEL_REF, subject: [PANEL_WORKFLOW, latest?.id ?? 0] },
        () => this.run(dispatchArgv(this.ghExe, this.repo), { timeoutMs: DISPATCH_TIMEOUT_MS }));
    } catch { return this.fail(now, 'DISPATCH_FAILED'); }
    if (!dispatch.sent) {
      this.nextAt = now + DISPATCH_EVERY_MS;
      return { skipped: 'SHARED_EFFECT_HELD' };
    }
    const w = dispatch.reply;
    if (w.code === 0 && !w.timedOut && !w.refused) {
      d.lastDispatchAt = now; d.pendingAt = now; d.sent.push(now);
      this.nextAt = now + DISPATCH_EVERY_MS;
      await this.persist(now, true);
      return { dispatched: true, at: now };
    }
    // Only the HTTP status is looked at; nothing gh printed is kept or shown.
    const text = `${w.stderr ?? ''}${w.stdout ?? ''}`;
    const code = w.timedOut ? 'DISPATCH_TIMEOUT' : /HTTP (401|403)\b/.test(text) ? 'DISPATCH_FORBIDDEN' : /HTTP 404\b/.test(text) ? 'DISPATCH_NOT_FOUND'
      : /HTTP 422\b/.test(text) ? 'DISPATCH_REJECTED' : 'DISPATCH_FAILED';
    return this.fail(now, code);
  }

  // On duty for STALL_NOTIFY_MS without a run of the workflow on main (whatever the reason): one notification per spell.
  async stallCheck(now) {
    const fresh = Math.max(this.onDutySince, this.lastRunSeenAt ?? 0);
    if (now - fresh <= STALL_NOTIFY_MS) { this.stallSpell = null; return; }
    this.stallSpell ??= fresh;
    this.alarmedAt ??= now;
    await this.say(`panel-dispatch-stalled:${this.stallSpell}`, '算力面板超过 15 分钟没有新运行',
      `本节点当班，但 ${Math.round((now - fresh) / MIN)} 分钟内 main 上没有 ${PANEL_WORKFLOW} 的运行（最近一次：${this.state.data.lastCode ?? '无失败记录'}）。面板的离线和告警数据可能已过期。`);
  }

  // After an alarm: the first run newer than it is the recovery, said once.
  async recovered(now) {
    if (this.alarmedAt === null || this.lastRunSeenAt === null || this.lastRunSeenAt < this.alarmedAt) return;
    const key = `panel-dispatch-recovered:${this.alarmedAt}`;
    this.alarmedAt = null; this.stallSpell = null;
    await this.say(key, '算力面板的 5 分钟触发已恢复', 'main 上又有了新的 clued-compute-panel 运行。');
  }
}
