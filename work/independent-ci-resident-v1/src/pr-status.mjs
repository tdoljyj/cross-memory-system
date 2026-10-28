// The executor's status on the PR page, and Windows notifications for the big events (resident quota redesign v0.6
// + §9, phase 1, item 7; Owner Decision 38936534). Runs in the companion (the Owner's own session and gh login).
//
// PR page: ONE commit status per open PR's current head, context PR_STATUS_CONTEXT. It is information only:
//   - a commit status, never a comment (a comment would move the PR's updated time and make the poller propose again);
//   - a context that is never a required check: what decides is a live read of main's rules before any write (a
//     context that appears among the required checks is never written, and the Owner is told once; without that read
//     nothing is written). This repository protects main with rulesets only: classic branch protection answers 404
//     (2026-10-22), so the rules read sees every required check. The fixed name (a " (info only)" suffix) only makes a
//     collision unlikely; a matrix job could still be named like that;
//   - written only when its state or text changes for that head (the last write per head is kept locally), at most
//     MAX_POSTS_PER_PASS per pass; a generic "proposed" text never replaces anything already written for that head; a
//     head whose write failed is left alone for POST_RETRY_MS.
// Every call is short (ADVISORY_TIMEOUT_MS) and a pass stops starting calls after PASS_BUDGET_MS. The companion runs all
// of this in its advisory lane, with its own Runner (companion-main.mjs), so it never delays the mailbox. A call that
// timed out leaves its child running and the Runner busy: the pass ends there (stalled), and nothing it could not do is
// recorded as done or as failed (independent re-review, MINOR-B). The notifications go first: they are local and must
// not wait behind a slow GitHub.
// Notifications: a Windows toast in the Owner's session, once per event key (kept locally): the executor HALTed, its
// status stopped moving (STATUS_STALE_MS), a PR head waited more than an hour (once per PR, head and reason), the
// status context collides with a required check.
// Texts are fixed templates over stable codes, numbers and times; nothing from a PR or a remote service is shown.
// Phase 2, step 1 (design v0.5 §4.10): the run queue's view says where a PR stands: its place and an estimated start, a
// wait or a back-off and when it is tried again, a stop and what makes it run again; the breaker; and the executor's
// notices (a new trigger, a stopped row, the waits' budget, the daily batch limit, the breaker) become notifications.
// Primary/standby C5 (DESIGN §23, node-duty.mjs): the context is the node's own, resident-queue/<node> (info only), written
// only on the commits the node queued or ran, its text starting with a fixed duty word (当班, 双活停机, 停摆, 已交班) or a
// result; duty texts are written again every DUTY_REFRESH_MS; a STANDBY writes reminders under resident-standby only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX40, canonicalJson, check } from './canonical.mjs';
import { STATUS_STALE_MS } from './status.mjs';
import { withTrainLine } from './train.mjs';
import { DEFAULT_NODE, DUTY_REFRESH_MS, NODE_NAME, NodeDuty, REFRESH_MAX_POSTS, STANDBY_CONTEXT, TAKEOVER_TIME_TEXT, freshMemory, nodeContext, pruneMemory, validMemory } from './node-duty.mjs';

// The context of a single node named DEFAULT_NODE (every node writes its own, node-duty.mjs#nodeContext).
export const PR_STATUS_CONTEXT = nodeContext(DEFAULT_NODE);
export const MAX_POSTS_PER_PASS = 20;
export const MAX_TOASTS_PER_PASS = 5;
export const WAIT_NOTIFY_MS = 3_600_000;
export const REQUIRED_CACHE_MS = 30 * 60_000;
export const ADVISORY_TIMEOUT_MS = 15_000;
export const PASS_BUDGET_MS = 60_000;
export const POST_RETRY_MS = 10 * 60_000;
// A call that did not run (the Runner is still busy with an earlier child) or did not finish in time.
export const stalledCall = r => r?.timedOut === true || r?.refused === 'RUNNER_BUSY_WITH_UNFINISHED_CHILD';
const DESCRIPTION_MAX = 140;
const STORE_CONTRACT = 'clued.independent-ci.companion-pr-status-store/1';
const KEEP_MS = 14 * 86_400_000;

export const STAGE_NAMES = Object.freeze({ 0: '准备', 1: '准入', 2: 'gitleaks 扫描', 3: 'gitleaks 发布', 4: 'trivy 扫描', 5: 'trivy 发布', 6: 'contract-placement 扫描',
  7: 'contract-placement 发布', 8: '准入复核与合并位', 9: '托管转发' });
const DEFERRED_TEXT = Object.freeze({ DAILY_BATCH_LIMIT: '今日执行批次额度已满，明天继续', DAILY_EVALUATION_LIMIT: '今日评估额度已满', UNEXECUTED_COOLDOWN: '冷却中（10 分钟）',
  COMPANION_NOT_READY: '等 companion 就绪', PR_DAILY_BATCH_LIMIT: '本 PR 今日批次已满', WAITING_BUDGET_EXHAUSTED: '今日等待重试额度已满，明天继续',
  REEVALUATION_CAP: '本提交今日重新评估次数已满', BREAKER_OPEN: '执行器熔断中' });
// Why a row waits (failure-table class waiting), in the words of the PR page.
const WAIT_TEXT = Object.freeze({ OWNER_REVIEW_REQUIRED: '等 Owner 批准受保护改动', TASK_CI_HEAD_CAP_REACHED: 'Task 的 24 小时 CI 额度已满',
  WAITING_BUDGET_EXHAUSTED: '今日等待重试额度已满（明天继续）' });
// Phase 2, step 3a: a batch parked before stage 8 because of main's live rules, GitHub's test merge or the green ledger.
const PARKED_TEXT = Object.freeze({ RULESET_UNREADABLE: '已测通：读不到 main 的规则，或必需检查不再钉在本执行器上',
  STRICT_OFF_WITHOUT_TRAIN: '已测通：main 的 strict 已关而列车未开，暂不发合并位（已通知 Owner）',
  MERGE_METHODS_NOT_MERGE_ONLY: '已测通：strict 已关，但合并方式不只有 merge，暂不发合并位（已通知 Owner）',
  TRAIN_TEST_MERGE_NOT_READY: '已测通：等 GitHub 算好试合并', GREEN_LEDGER_UNAVAILABLE: '已测通：本机绿色台账暂时写不进' });
// The Windows notification of each stage-8 rules notice (step 3a).
const STAGE8_RULES_TEXT = Object.freeze({
  STRICT_OFF_WITHOUT_TRAIN: () => ({ title: 'main 的 strict 已关，第 8 段停发合并位', body: '列车没有开，常驻执行器不再发合并位。请把 main 规则集的 strict 改回开，或按上线顺序开车。' }),
  MERGE_METHODS_NOT_MERGE_ONLY: () => ({ title: '合并方式不只有 merge，第 8 段停发合并位', body: 'strict 已关时，main 只能允许 merge 方式合入。请在规则集里只留 merge，或把 strict 改回开。' }),
  TRAIN_TEST_MERGE_TREE_DIFFERS: (pr, head) => ({ title: `PR #${pr} 的试合并与测过的树不同`, body: `提交 ${head}：GitHub 对 main 与此提交的试合并不是测过的树，没有发合并位。请推新提交，并检查原因。` }) });
const LIVE = new Set(['QUEUED', 'PARKED', 'WAITING', 'BACKOFF']);
const hhmm = ms => new Date(ms).toISOString().slice(11, 16) + 'Z';
const clip = s => s.length <= DESCRIPTION_MAX ? s : `${s.slice(0, DESCRIPTION_MAX - 1)}…`;

// The fixed shape of the context (a " (info only)" suffix); whether it is free is decided by contextFree.
export function contextShapeSafe(context) { return typeof context === 'string' && / \(info only\)$/.test(context) && context.length <= 100; }
// True only when the context collides with none of the required checks (case-insensitive, trimmed).
export function contextFree(context, required) {
  if (!contextShapeSafe(context) || !Array.isArray(required)) return false;
  const c = context.trim().toLowerCase();
  return !required.some(r => typeof r === 'string' && r.trim().toLowerCase() === c);
}

// Pure: what the PR page should say for one open PR head, or null (write nothing). weak: a generic text that never
// replaces what was already written for that head.
export function describe({ pull, status, now, staleMs = STATUS_STALE_MS }) {
  if (!pull || !HEX40.test(pull.headSha ?? '')) return null;
  if (!pull.eligible) {
    if (pull.hint === 'merge-main') return { state: 'failure', description: clip(`落后 main ${pull.behindBy} 个提交：请合入最新 main 并推送`) };
    if (pull.hint === 'push-any-commit') return { state: 'failure', description: '已包含 main，但 PR 的基准还是旧的：推一个任意提交即可' };
    return null;
  }
  if (!status) return null;
  if (now - status.writtenAt > staleMs) return { state: 'error', description: `执行器状态自 ${hhmm(status.writtenAt)} 起未更新，可能已停止` };
  const mine = x => x && x.pr === pull.pr && x.headSha === pull.headSha;
  if (mine(status.current)) {
    const stage = status.current.stage;
    return { state: 'pending', description: stage === null ? '运行中：等待托管信号' : `运行中：第 ${stage} 段（${STAGE_NAMES[stage] ?? '?'}）` };
  }
  // The run queue (phase 2): a row that waits for its turn or its next try says so; nothing runs while HALTed or paused.
  const row = status.pending.find(mine);
  if (row && LIVE.has(row.state)) {
    if (status.halt) return { state: 'error', description: clip(`执行器已停机（${status.halt.code}），等 Owner 复位`) };
    if (status.paused) return { state: 'pending', description: '执行器已暂停，等 Owner 恢复' };
    if (!status.backfill.complete) return { state: 'pending', description: '执行器启动中：回填已执行记录', weak: true };
    const code = row.deferred ?? '?';
    const at = row.nextAt ? `约 ${hhmm(row.nextAt)} ` : '';
    // Parked before stage 8 (phase 2, step 2): its checks are published; it waits for the merge queue.
    if (row.state === 'PARKED') {
      if (row.deferred === 'RESIDENT_MERGE_QUEUE_NOT_JOINED') return { state: 'pending', description: clip(`已测通：现在加入合并队列，${at}再查第 8 段`) };
      if (PARKED_TEXT[row.deferred]) return { state: 'pending', description: clip(`${PARKED_TEXT[row.deferred]}，${at}再查第 8 段`) };
      // Without a place the Source did not learn whether the claim is in the queue (review of step 2, m13).
      if (!row.queuePosition) return { state: 'pending', description: clip(`已测通：等合并队列，${at}再查第 8 段`) };
      return { state: 'pending', description: clip(`已测通，在合并队列第 ${row.queuePosition} 位：等成为队首，${at}再查第 8 段`) };
    }
    if (row.state === 'WAITING') return { state: 'pending', description: clip(`${WAIT_TEXT[row.deferred] ?? `等待中（${code}）`}：${at}自动重试，批准或修正后编辑 PR 可提前`) };
    if (row.state === 'BACKOFF') return { state: 'pending', description: clip(`未准入或未执行（${code}）：${at}自动重试（第 ${row.level} 次），修正后编辑 PR 可提前`) };
    // The intake pause (primary/standby C6): no new batch starts until it ends (the executor's first gate, before the
    // parking places and the breaker); no estimate that assumes a free executor.
    if (status.intakePause) return { state: 'pending', description: clip(`排队第 ${row.position ?? '?'} 位：暂停接新中${status.intakePause.until ? `，最晚 ${hhmm(status.intakePause.until)} 恢复` : ''}`) };
    if (status.breaker?.state === 'open') return { state: 'pending', description: clip(`排队第 ${row.position ?? '?'} 位：执行器熔断中${status.breaker.nextTrialAt ? `，约 ${hhmm(status.breaker.nextTrialAt)} 试跑` : ''}`) };
    // No new batch while the parking places are full (phase 2, step 2; review m8): no estimate that assumes a free executor.
    if (status.queue?.parkingFull === true) return { state: 'pending', description: clip(`排队第 ${row.position ?? '?'} 位：停靠的批次已满，等它们结束`) };
    const why = row.deferred ? `：${DEFERRED_TEXT[row.deferred] ?? row.deferred}` : '';
    return { state: 'pending', description: clip(`排队第 ${row.position ?? '?'} 位${why}${row.eta && !row.deferred ? `，预计 ${hhmm(row.eta)} 开始` : ''}`) };
  }
  if (row && row.state === 'STOPPED' && row.stopKind === 'release-cap') {
    return { state: 'failure', description: clip(`24 小时内已多次未准入或未执行（${row.deferred ?? '?'}）：请修正后推新提交`) };
  }
  const recent = status.recent.find(mine);
  if (recent) {
    const code = recent.code ?? '?';
    switch (recent.outcome) {
      case 'COMPLETED': return { state: 'success', description: '已完成：常驻执行器跑完八段，检查已发布' };
      case 'FAILED_CLEAN':
        if (recent.code === 'RESIDENT_BASE_MOVED') return { state: 'failure', description: 'main 已移动：请合入最新 main 并推新提交' };
        if (recent.code === 'TRAIN_TEST_MERGE_TREE_DIFFERS') return { state: 'failure', description: '试合并与测过的树不同，未发合并位：请推新提交（已通知 Owner）' };
        // Primary/standby C4: App 5368905 had already published on this head (another node or install).
        if (recent.code === 'HEAD_PUBLISHED_ON_GITHUB' || recent.code === 'ROLE_ALREADY_ON_GITHUB') return { state: 'failure', description: '这个提交已有检查，请推新提交' };
        return recent.retry === 'attempt2'
        ? { state: 'pending', description: clip(`暂时失败（${code}），将自动第二次尝试`) }
        : { state: 'failure', description: clip(`失败（${code}）：此提交不再运行，请推新提交`) };
      case 'FAILED_UNKNOWN': return { state: 'error', description: clip(`执行器停机（${code}），等 Owner 复位`) };
      case 'NOT_ADMITTED':
        if (recent.code === 'OWNER_REVIEW_REQUIRED') return { state: 'pending', description: '等 Owner 批准受保护改动，批准后编辑 PR 可提前重试' };
        if (recent.code === 'TASK_CI_HEAD_CAP_REACHED') return { state: 'pending', description: 'Task 的 24 小时 CI 额度已满，稍后自动重试' };
        if (recent.class === 'waiting') return { state: 'pending', description: clip(`等待中（${code}），稍后自动重试`) };
        return { state: 'failure', description: clip(`未准入（${code}）：修正后编辑 PR 再试`) };
      case 'NOT_EXECUTED': return recent.code === 'BATCH_SUPERSEDED' ? null : { state: 'pending', description: clip(`未执行（${code}），稍后自动重试`) };
      case 'IGNORED':
        if (recent.code === 'UNEXECUTED_DAILY_CAP') return { state: 'failure', description: '此提交今日评估次数已满：请推新提交' };
        // An executed head proposed again: what was written for it stays.
        return null;
      default: return null;
    }
  }
  if (row && row.state === 'STOPPED') return { state: 'failure', description: clip(`此提交不再运行（${row.deferred ?? '?'}）：请推新提交`) };
  if (status.halt) return { state: 'error', description: clip(`执行器已停机（${status.halt.code}），等 Owner 复位`) };
  if (status.paused) return { state: 'pending', description: '执行器已暂停，等 Owner 恢复' };
  if (!status.backfill.complete) return { state: 'pending', description: '执行器启动中：回填已执行记录', weak: true };
  return { state: 'pending', description: '已提议，等待执行器读取', weak: true };
}

// Pure: the notification events now (a stable key each; the reporter shows each key once).
export function events({ status, statusError = false, now, pulls = [], startedAt = now, staleMs = STATUS_STALE_MS, collision = false }) {
  const out = [];
  if (collision) out.push({ key: 'context-collision', title: 'PR 页面状态名与必需检查重名', body: `“${typeof collision === 'string' ? collision : PR_STATUS_CONTEXT}”出现在 main 的必需检查里，已停止写 PR 页面状态。请检查 main 的规则。` });
  if (!status) {
    if (statusError && now - startedAt > staleMs) out.push({ key: 'status-unreadable', title: '读不到常驻执行器状态', body: 'state\\status.json 读不到或格式不对，执行器可能没有运行。' });
    return out;
  }
  if (now - status.writtenAt > staleMs) out.push({ key: `stale:${status.writtenAt}`, title: '常驻执行器可能已停止', body: `状态自 ${hhmm(status.writtenAt)} 起未更新（超过 ${Math.round(staleMs / 60_000)} 分钟）。` });
  if (status.halt) out.push({ key: `halt:${status.halt.code}:${status.halt.at ?? ''}`, title: '常驻执行器已停机（HALT）', body: `原因：${status.halt.code}。需要 Owner 复位（rearm）后才会继续。` });
  for (const p of status.pending) {
    if (!LIVE.has(p.state ?? 'QUEUED') || !p.since || now - p.since <= WAIT_NOTIFY_MS) continue;
    const reason = p.deferred ?? p.state ?? 'QUEUED';
    out.push({ key: `wait:${p.pr}:${p.headSha}:${reason}`, title: `PR #${p.pr} 排队超过 1 小时`, body: `提交 ${p.headSha.slice(0, 8)}：${DEFERRED_TEXT[p.deferred] ?? WAIT_TEXT[p.deferred] ?? (p.deferred ? `等待中（${p.deferred}）` : '前面还有批次')}。` });
  }
  // The executor's own notices (queue.mjs#notice), each key once.
  for (const n of status.notices ?? []) {
    const head = n.headSha ? n.headSha.slice(0, 8) : '';
    switch (n.kind) {
      case 'new-trigger': out.push({ key: `notice:${n.key}`, title: `PR #${n.pr} 收到新触发`, body: `提交 ${head} 等待中的重试已提前，冷却 10 分钟后重新评估。` }); break;
      case 'stopped': out.push({ key: `notice:${n.key}`, title: `PR #${n.pr} 已停住`, body: `提交 ${head}：24 小时内多次未准入或未执行（${n.code ?? '?'}）。请修正后推新提交。` }); break;
      case 'stage8-budget': out.push({ key: `notice:${n.key}`, title: '今日第 8 段重试额度已用完', body: '停靠批次的第 8 段重试今天已用完，明天继续。' }); break;
      // Phase 2, step 3a: why stage 8 writes no merge-slot green.
      case 'stage8-rules': out.push({ key: `notice:${n.key}`, ...(STAGE8_RULES_TEXT[n.code] ? STAGE8_RULES_TEXT[n.code](n.pr, head) : { title: '第 8 段不发合并位', body: n.code ?? '?' }) }); break;
      case 'queue-unsaved': out.push({ key: `notice:${n.key}`, title: '常驻执行器写不进排队表', body: `连续多次写不进 state\\queue\\queue.json（${n.code ?? '?'}），新的触发留在收件箱里没有处理。` }); break;
      case 'waiting-budget': out.push({ key: `notice:${n.key}`, title: '今日等待重试额度已用完', body: '等待类的自动重试今天已用完，等待中的 PR 明天继续，状态见 PR 页面。' }); break;
      case 'batch-limit': out.push({ key: `notice:${n.key}`, title: '今日执行批次额度已满', body: '常驻执行器今天的执行批次已满，排队的 PR 明天继续，不会丢弃。' }); break;
      case 'queue-full': out.push({ key: `notice:${n.key}`, title: '常驻执行器排队表已满', body: '活着的排队行已达上限，新的 PR 暂不排队；排队的 PR 跑完或停住后再提议。' }); break;
      case 'breaker-open': out.push({ key: `notice:${n.key}`, title: '常驻执行器熔断', body: `连续出现环境故障（${n.code ?? '?'}），暂停开新批次${n.until ? `，约 ${hhmm(n.until)} 试跑一批` : ''}。` }); break;
      default: break;
    }
  }
  return out;
}

// The Windows toast: a fixed PowerShell script, the texts passed as Base64 (no quoting of the texts at all).
export function toastArgv(powershellExe, title, body) {
  check(typeof powershellExe === 'string' && /^[A-Z]:\\/.test(powershellExe), 'TOAST_POWERSHELL_INVALID');
  const b64 = s => Buffer.from(String(s).slice(0, 400), 'utf8').toString('base64');
  const script = "$ErrorActionPreference='Stop';"
    + `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}'));`
    + `$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(body)}'));`
    + '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];'
    + '[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime];'
    + '$x=New-Object Windows.Data.Xml.Dom.XmlDocument;'
    + "$x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>'+[Security.SecurityElement]::Escape($t)+'</text><text>'+[Security.SecurityElement]::Escape($b)+'</text></binding></visual></toast>');"
    + "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))";
  return [powershellExe, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

// The reporter's own memory (the Owner's profile, never the resident's state): the last write per head, and which
// notification keys were shown. Lost memory only means one more write or one more toast.
export class LocalStore {
  constructor(file, clock) { this.file = file; this.clock = clock; this.data = { contract: STORE_CONTRACT, posted: {}, notified: {}, node: freshMemory() }; }
  static async open(file, clock = Date.now) {
    const s = new LocalStore(file, clock);
    try {
      const v = JSON.parse(await fs.readFile(file, 'utf8'));
      if (v?.contract === STORE_CONTRACT && v.posted && typeof v.posted === 'object' && v.notified && typeof v.notified === 'object') {
        // The node memory (C5) is optional: a store written before it starts with a fresh one (one more check, no lock);
        // a lock that does not have the shape stays a lock (node-duty.mjs#validMemory).
        s.data = { contract: STORE_CONTRACT, posted: v.posted, notified: v.notified, node: validMemory(v.node, clock()) };
      }
    } catch { /* fresh memory */ }
    return s;
  }
  prune() {
    pruneMemory(this.data.node, this.clock());
    const cut = this.clock() - KEEP_MS;
    for (const bag of [this.data.posted, this.data.notified]) {
      for (const [k, v] of Object.entries(bag)) if (!(Date.parse(v?.at) > cut)) delete bag[k];
      const keys = Object.keys(bag);
      if (keys.length > 500) for (const k of keys.sort((a, b) => Date.parse(bag[a].at) - Date.parse(bag[b].at)).slice(0, keys.length - 500)) delete bag[k];
    }
  }
  async save() {
    this.prune();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, canonicalJson(this.data));
    await fs.rename(tmp, this.file);
  }
}

export class PrStatusReporter {
  // ports: { repo, ghExe, powershellExe, run(argv,{timeoutMs}), clock, store (LocalStore), prStatus (bool), notifications (bool),
  //   node (this node's name while status.json names none; default DEFAULT_NODE), writeRequest(value) (one file into the
  //   resident's requests\, for the dual-active hold; without it no lock is held) }
  constructor(ports) {
    Object.assign(this, ports);
    this.node ??= DEFAULT_NODE;
    check(NODE_NAME.test(this.node) && contextShapeSafe(nodeContext(this.node)) && contextShapeSafe(STANDBY_CONTEXT), 'PR_STATUS_CONTEXT_UNSAFE');
    this.required = null; this.requiredAt = 0; this.collision = false; this.startedAt = this.clock(); this.failed = new Map();
    this.store.data.node ??= freshMemory();
    // Every read the duty makes goes through call(): a stalled call ends the pass like any other.
    this.duty = new NodeDuty({ repo: this.repo, ghExe: this.ghExe, run: (a, o) => this.call(a, o), clock: this.clock, memory: this.store.data.node, fallbackName: this.node,
      writeRequest: this.writeRequest ?? null, timeoutMs: ADVISORY_TIMEOUT_MS, inBudget: () => this.inBudget(), staleMs: STATUS_STALE_MS });
  }

  async call(argv, o) {
    const r = await this.run(argv, o);
    if (stalledCall(r)) this.stalled = true;
    return r;
  }
  inBudget() { return !this.stalled && this.clock() - this.passStartedAt < PASS_BUDGET_MS; }

  // main's required status checks (rulesets), read with the Owner's gh login; null when unknown.
  async requiredContexts() {
    if (this.required && this.clock() - this.requiredAt < REQUIRED_CACHE_MS) return this.required;
    const r = await this.call([this.ghExe, 'api', '--method', 'GET', '--paginate', `repos/${this.repo}/rules/branches/main`,
      '--jq', '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'], { timeoutMs: ADVISORY_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const list = String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (list.length === 0) return null; // main always requires checks: an empty answer is no answer
    this.required = list; this.requiredAt = this.clock();
    return list;
  }

  async post(headSha, want, context) {
    check(HEX40.test(headSha) && ['pending', 'success', 'failure', 'error'].includes(want.state) && typeof want.description === 'string' && contextShapeSafe(context), 'PR_STATUS_INVALID');
    const r = await this.call([this.ghExe, 'api', '--method', 'POST', `repos/${this.repo}/statuses/${headSha}`, '-f', `state=${want.state}`, '-f', `context=${context}`,
      '-f', `description=${clip(want.description)}`], { timeoutMs: ADVISORY_TIMEOUT_MS });
    return r.code === 0;
  }

  // A toast that never started keeps its key for the next pass. Shown, refused or still running (timed out): the key is
  // used up, so a toast is never shown twice or retried every minute.
  async toast(e, now) {
    const r = await this.run(toastArgv(this.powershellExe, e.title, e.body), { timeoutMs: ADVISORY_TIMEOUT_MS });
    if (r?.refused === 'RUNNER_BUSY_WITH_UNFINISHED_CHILD') { this.stalled = true; return false; }
    this.store.data.notified[e.key] = { at: new Date(now).toISOString() };
    delete this.store.data.node.toasts[e.key];
    this.dirty = true;
    if (stalledCall(r)) this.stalled = true;
    return r.code === 0;
  }

  // Up to MAX_TOASTS_PER_PASS toasts of `list`, each key once; returns how many were shown.
  async showAll(list, now, shown) {
    if (this.notifications === false) return shown;
    for (const e of list) {
      if (shown >= MAX_TOASTS_PER_PASS || !this.inBudget()) break;
      if (this.store.data.notified[e.key]) { delete this.store.data.node.toasts[e.key]; continue; }
      if (await this.toast(e, now)) shown += 1;
      if (this.stalled) break;
    }
    return shown;
  }

  // One pass: the status notifications (local, never behind a slow GitHub), the node's duty (the take-over check and the
  // dual-active lock) and its notifications, then the PR page status of every open PR head the poller looked at, then
  // the duty's own writes (已交班, a restart, the STANDBY reminders).
  async pass({ pulls = [], status = null, statusError = false }) {
    const now = this.clock();
    this.passStartedAt = now;
    this.stalled = false;
    let posted = 0;
    for (const [head, at] of this.failed) if (now - at >= POST_RETRY_MS) this.failed.delete(head);
    const memoryBefore = canonicalJson(this.store.data.node);
    let toasts = await this.showAll(events({ status, statusError, now, pulls, startedAt: this.startedAt, collision: this.collision }), now, 0);
    // A pass whose duty could not be worked out writes nothing on the PR page (never under a fallback name: review m1).
    let prep = null;
    if (!this.stalled) { try { prep = await this.duty.prepare({ status, pulls, now, posted: this.store.data.posted }); } catch { prep = null; } }
    if (prep) toasts = await this.showAll(prep.events, now, toasts);
    if (prep && this.prStatus !== false && pulls.length > 0 && !this.stalled) {
      const context = prep.context;
      const required = await this.requiredContexts();
      // Both contexts this node may write are checked against main's rules; either one there stops every write.
      if (!this.stalled) this.collision = (Array.isArray(required) ? [context, STANDBY_CONTEXT].find(c => !contextFree(c, required)) : undefined) ?? false;
      if (Array.isArray(required) && !this.collision && !this.stalled) {
        const described = new Set();
        const write = async (headSha, want, ctx, key) => {
          if (posted >= MAX_POSTS_PER_PASS || !this.inBudget() || this.failed.has(key)) return false;
          const ok = await this.post(headSha, want, ctx);
          if (ok) posted += 1; else if (!this.stalled) this.failed.set(key, now);
          return ok;
        };
        // What was written per head under this node's context: dutyAt is the last 当班 or 双活停机 (what an 已交班 is owed
        // for); n counts the writes (GitHub keeps at most 1000 per context and commit).
        const remember = (headSha, want) => {
          const last = this.store.data.posted[headSha];
          const mine = last?.context === context;
          this.store.data.posted[headSha] = { state: want.state, description: clip(want.description), at: new Date(now).toISOString(), context, kind: want.kind ?? null,
            dutyAt: ['duty', 'dual'].includes(want.kind) ? new Date(now).toISOString() : (mine ? last.dutyAt ?? null : null), n: (mine ? last.n ?? 0 : 0) + 1 };
        };
        for (const pull of pulls) {
          if (posted >= MAX_POSTS_PER_PASS || !this.inBudget()) break;
          const want = this.duty.want(pull, status, now, withTrainLine(describe({ pull, status, now }), status?.train?.last ?? null, pull, now, DESCRIPTION_MAX));
          if (!want) continue;
          described.add(pull.headSha);
          const last = this.store.data.posted[pull.headSha];
          const mine = last && last.context === context;
          const same = mine && last.state === want.state && last.description === clip(want.description);
          // A weak text never replaces another text; the same weak duty text is still refreshed (re-review).
          if (want.weak && mine && !same) continue;
          // NIT 4: a duty text is written again every DUTY_REFRESH_MS even when unchanged ("still alive" for the other node),
          // up to REFRESH_MAX_POSTS writes per head.
          const due = same && ['duty', 'dual', 'stalled'].includes(want.kind) && now - Date.parse(last.at) >= DUTY_REFRESH_MS && (last.n ?? 0) < REFRESH_MAX_POSTS;
          if (same && !due) continue;
          if (await write(pull.headSha, want, context, pull.headSha)) remember(pull.headSha, want);
          if (this.stalled) break;
        }
        let extra = [];
        if (!this.stalled) { try { extra = await this.duty.extra({ posted: this.store.data.posted, described, pulls, now }); } catch { extra = []; } }
        for (const x of extra) {
          const ok = !this.stalled && await write(x.headSha, x.want, x.context, `${x.context}|${x.headSha}`);
          if (!ok) continue;
          if (x.restart) this.duty.restartOwed?.delete(x.headSha);
          if (x.context === context) remember(x.headSha, x.want);
          if (x.handover) delete this.store.data.node.handover[x.headSha];
          if (!x.remind) continue;
          // §5.3: written once and shown once per (PR, head, reason); a toast that cannot be shown now is owed (m6).
          this.store.data.node.reminded[x.remind.key] = new Date(now).toISOString();
          const toast = { key: x.remind.key, title: `PR #${x.remind.pr}：当班节点没接手`, body: `${x.want.description}。${TAKEOVER_TIME_TEXT}` };
          if (this.notifications !== false && !this.store.data.notified[toast.key]) {
            this.store.data.node.toasts[toast.key] = { title: toast.title, body: toast.body, at: new Date(now).toISOString() };
            toasts = await this.showAll([toast], now, toasts);
          }
        }
        if (this.duty.restartOwed?.size === 0) this.duty.restarted = false;
      }
    }
    if (canonicalJson(this.store.data.node) !== memoryBefore) this.dirty = true;
    if (posted > 0 || toasts > 0 || this.dirty) { try { await this.store.save(); this.dirty = false; } catch { this.dirty = true; } }
    return { posted, toasts, collision: this.collision !== false, stalled: this.stalled };
  }
}

// companion.json "status" (optional): { prStatus, notifications, node } (both on unless set false; node: this node's name
// while status.json names none, default DEFAULT_NODE).
export function validateStatusConfig(s) {
  if (s === undefined || s === null) return Object.freeze({ prStatus: true, notifications: true, node: DEFAULT_NODE });
  check(typeof s === 'object' && Object.keys(s).every(k => ['prStatus', 'notifications', 'node'].includes(k))
    && ['prStatus', 'notifications'].every(k => s[k] === undefined || typeof s[k] === 'boolean') && (s.node === undefined || NODE_NAME.test(s.node)), 'COMPANION_STATUS_CONFIG_INVALID');
  return Object.freeze({ prStatus: s.prStatus !== false, notifications: s.notifications !== false, node: s.node ?? DEFAULT_NODE });
}
