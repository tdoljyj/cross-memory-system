// 只用 GitHub 对象和 Git 的本地对象库。读不全时由调用方将整项标为未判。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionRerunner, REDISPATCH_KIND, residentDispatchMark } from '../../work/independent-ci-resident-v1/src/admission-rerun.mjs';
import { matchCompanionStatuses } from './retrigger-counter.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ZERO = '0'.repeat(40);
const MAIN = 'main';
const REF = 'refs/heads/';
const PAGE = 100;
const HOUR = 3600_000;
const PUSH = new Set(['push', 'force_push']);
const TIP_TYPES = [...PUSH, 'branch_creation'];
const positive = n => Number.isSafeInteger(n) && n > 0;
const fail = message => { throw new Error(message); };
const stamp = (value, label) => {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) fail(`${label}缺有效时间`);
  return time;
};
const beijing = ms => new Date(ms + 8 * HOUR).toISOString().replace(/(?:\.000)?Z$/, '+08:00');
const validSha = value => typeof value === 'string' && SHA.test(value) && value !== ZERO;
const actorKind = actor => {
  if (typeof actor?.login !== 'string' || !actor.login) return 'unknown';
  if (actor.type === 'Bot' || /\[bot\]$/i.test(actor.login)) return 'bot';
  return actor.type === 'User' ? 'human' : 'unknown';
};

// merge-tree --write-tree 会产生对象。把新对象放进临时库，工作树、索引、ref 和原对象库只读。
export function localMergeTree(before, parent, { cwd = process.cwd() } = {}) {
  if (!validSha(before) || !validSha(parent)) fail('merge-tree 收到无效提交');
  const opts = { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true };
  const git = (args, env = process.env) => spawnSync('git', ['--no-lazy-fetch', '--no-replace-objects', ...args], { ...opts, env });
  const objects = git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  if (objects.error || objects.status !== 0 || !objects.stdout.trim()) fail('本机 Git 或对象库不可用，无法重做合并');
  for (const sha of [before, parent]) {
    const object = git(['cat-file', '-t', sha]);
    if (object.error) fail('本机 Git 不可用，无法读取合并对象');
    if (object.status !== 0) return { missing: sha };
    if (object.stdout.trim() !== 'commit') fail(`本机对象 ${sha} 不是提交`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'shadow-merge-'));
  try {
    const result = git(['merge-tree', '--write-tree', before, parent], {
      ...process.env, GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects.stdout.trim().replaceAll('\\', '/')),
    });
    const tree = result.stdout?.split(/\r?\n/, 1)[0];
    if (!result.error && [0, 1].includes(result.status) && validSha(tree)) return { status: result.status, tree };
    const missing = result.stderr?.match(/(?:missing|unable to read|could not (?:read|parse)|bad object)[^\r\n]*?([0-9a-f]{40})/i)?.[1];
    if (missing) return { missing };
    fail(`本机 Git 无法重做合并 ${before} + ${parent}（退出 ${result.status ?? '未完成'}）`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function classifyPush(push, { commitOf, prsOfBranch, isOnMain, mergeTree }) {
  const { activity_type: kind, after: head, before, actor, ref, timestamp } = push;
  const at = beijing(stamp(timestamp, '活动')), branch = ref.slice(REF.length);
  const ignored = why => ({ kind, at, head, why });
  if (kind === 'branch_creation') return ignored('交活：创建分支');
  if (!PUSH.has(kind)) return null;
  const identity = actorKind(actor);
  if (identity === 'bot') return ignored('机器人推送');
  if (identity !== 'human') fail(`活动 ${push.id} 缺推送者身份`);
  if (head === before) return ignored('交活：远端 tip 没有移动');

  const { parents, tree } = await commitOf(head);
  const evidence = { activityId: push.id, before, parents, tree };
  const event = (kind, pr, basis) => ({ kind, at, pr, branch, head, actor: actor.login, basis, evidence });
  if ((kind === 'force_push' || (parents.length === 1 && parents[0] === before)) && (await commitOf(before)).tree === tree) {
    return event('Z3', (await prsOfBranch(branch, timestamp))[0]?.number ?? null,
      kind === 'force_push' ? '强推前后同树' : '单父提交与推送前同树');
  }
  if (parents[0] !== before) return ignored('交活：推送带新提交，第一父不是推送前的 tip');
  if (parents.length !== 2) return ignored('交活：推送带新代码，未见纯追平合并');

  const prs = await prsOfBranch(branch, timestamp);
  if (!prs.length) return ignored('交活：推送时该分支没有打开的 PR');
  if (!(await isOnMain(parents[1]))) return ignored('交活：第二父不在 main 上');
  const result = await mergeTree(before, parents[1]);
  if (result?.missing) fail(`本机缺 ${result.missing}，fetch 后重跑可改判`);
  if (result?.status === 1) return ignored('交活：重做合并有冲突');
  if (result?.status !== 0 || !validSha(result.tree)) fail(`本机 Git 未能核定 ${before} 与 ${parents[1]} 的合并树`);
  if (result.tree !== tree) return ignored('交活：重做合并的树不同');
  return event('Z1', prs[0].number, '推送时 PR 已打开，两父纯追平 main，重做合并无冲突且同树');
}

async function pages(get, route, { key, stop, maxPages = 50 } = {}) {
  const all = [];
  let total;
  for (let page = 1; page <= maxPages; page++) {
    const body = await get(`${route}${route.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`);
    const rows = key ? body?.[key] : body;
    if (!Array.isArray(rows) || rows.length > PAGE) fail(`列表不完整：${route}`);
    if (key) {
      if (!Number.isSafeInteger(body.total_count) || body.total_count < 0 || (total ?? body.total_count) !== body.total_count) {
        fail(`列表计数不完整或变化：${route}`);
      }
      total = body.total_count;
      if (total >= maxPages * PAGE) fail(`列表达到读取上限：${route}`);
    }
    all.push(...rows);
    if (rows.length < PAGE || (key && all.length === total)) {
      if (key && all.length !== total) fail(`列表不完整：${route}`);
      return all;
    }
    if (stop?.(rows)) return all;
  }
  fail(`达到分页上限：${route}`);
}

// 给 API 移动的 day/week 下界留一小时余量。一页 100 条依然未判。
const activityPeriod = (start, end) => end - start < 23 * HOUR ? 'day' : end - start < 167 * HOUR ? 'week' : null;

async function readActivity(get, branch, period) {
  const activity = [];
  const seen = new Set();
  // 服务端按类型筛选，避免 pr_merge 占满 main 的首屏。
  for (const type of TIP_TYPES) {
    const query = new URLSearchParams({ ref: REF + branch, per_page: PAGE,
      ...(period ? { time_period: period } : {}), activity_type: type });
    const rows = await get(`/activity?${query}`);
    const label = `${branch} 的 ${type} 活动记录`;
    if (!Array.isArray(rows) || rows.length > PAGE) fail(`${label}不完整`);
    if (rows.length === PAGE) fail(`${label}满 100 条，无法读全游标分页`);
    for (const row of rows) {
      if (row?.ref !== REF + branch || row.activity_type !== type || !positive(row.id) || seen.has(row.id)) fail(`${label}不完整`);
      seen.add(row.id);
      const time = stamp(row.timestamp, label);
      if (!validSha(row.after) || (PUSH.has(type) && !validSha(row.before))) fail(`${label}缺 before 或 after`);
      activity.push({ ...row, branch, time });
    }
  }
  return activity;
}

function uniqueIds(rows, label, idOf = row => row?.id) {
  const seen = new Set();
  for (const row of rows) {
    const id = idOf(row);
    if (!positive(id) || seen.has(id)) fail(`${label}缺少唯一编号`);
    seen.add(id);
  }
}

const prBranch = (pull, repo) => pull.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase() ? pull.head.ref : null;
const isLifecycle = e => ['closed', 'merged', 'reopened'].includes(e.event);

function openAt(pull, events, at) {
  if (stamp(pull.created_at, `PR #${pull.number}`) >= at) return false;
  const transitions = events.filter(isLifecycle).map(e => ({ event: e.event, at: stamp(e.created_at, `PR #${pull.number} 事件`) }));
  if (pull.closed_at) transitions.push({ event: 'closed', at: stamp(pull.closed_at, `PR #${pull.number} 关闭`) });
  if ((pull.state === 'closed' && !pull.closed_at) || !['open', 'closed'].includes(pull.state)) fail(`PR #${pull.number} 缺关闭状态`);
  const latest = transitions.filter(e => e.at < at || (e.at === at && e.event !== 'reopened'))
    .sort((a, b) => b.at - a.at)[0];
  return !latest || latest.event === 'reopened';
}

// 用内存回执让常驻状态生成器渲染两种补发结果不确定的原文。
const uncertainDispatchLines = new Set([false, true].map(skipped => new AdmissionRerunner({ state: {
  data: { heads: {}, records: {} }, record: () => ({ kind: REDISPATCH_KIND, outcome: 'unknown', skipped }),
} }).line(ZERO)));
const companionLine = description => description.replace(/^(?:当班|双活停机|已交班|停摆（[A-Z0-9_]+）)：/, '').split('；', 1)[0];

function companionDescription(description) {
  const line = companionLine(description);
  return uncertainDispatchLines.has(line) || /^(?:已自动补跑|(?:必需测试(?:没有运行|被跳过（推送者非 Owner）)，)?已自动补发)/.test(line);
}

async function runsOnHead(get, head) {
  const runs = await pages(get, `/actions/runs?head_sha=${head}`, { key: 'workflow_runs', maxPages: 10 });
  uniqueIds(runs, `${head} 的运行`);
  const candidates = [];
  for (const run of runs) {
    if (run.head_sha !== head || !positive(run.run_attempt) || typeof run.event !== 'string' || !run.event) fail(`${head} 的运行响应不完整`);
    const first = run.event === 'workflow_dispatch' ? 1 : 2;
    for (let n = first; n <= run.run_attempt; n++) {
      // dispatch 首次启动与后续重跑是两个动作；列表只有最新 attempt 时，连第 1 次也重新读。
      const a = n === 1 && run.run_attempt === 1 ? run : await get(`/actions/runs/${run.id}/attempts/${n}`);
      if (a?.id !== run.id || a.head_sha !== head || a.run_attempt !== n) fail(`运行 ${run.id} 的 attempt ${n} 响应不完整`);
      const time = stamp(a.run_started_at, `运行 ${run.id} 的 attempt ${n}`);
      candidates.push({ ...a, event: run.event, display_title: run.display_title,
        workflow: run.path, branch: run.head_branch, prs: run.pull_requests, time });
    }
  }
  return candidates;
}

async function readReruns(get, head, pushes, prsByBranch, inWindow, end) {
  const candidates = await runsOnHead(get, head);
  const events = [], ignored = [];
  const manual = candidates.filter(a => {
    if (!inWindow(a.time)) return false;
    const identity = actorKind(a.triggering_actor);
    if (identity === 'unknown') fail(`运行 ${a.id} 的 attempt ${a.run_attempt} 缺 triggering_actor`);
    if (identity !== 'human') return false;
    const mark = residentDispatchMark(a);
    if (!mark) return true;
    ignored.push({ kind: 'Z2', at: beijing(a.time), head,
      why: `运行 ${a.id}:${a.run_attempt} 标记为常驻自动补发（节点 ${mark.node}，编号 ${mark.id}）` });
    return false;
  });
  if (!manual.length) return { events, ignored };
  const statuses = await pages(get, `/commits/${head}/statuses`);
  uniqueIds(statuses, `${head} 的提交状态`);
  // 已标记的运行仍参与时间匹配，避免它的状态被误归给临近的手工运行。
  const { companion, ambiguous } = matchCompanionStatuses(candidates, statuses.filter(s => stamp(s.created_at, '状态') <= end), {
    matchesWorkflow: () => true, matchesDescription: companionDescription,
  });
  for (const a of manual) {
    const id = `${a.id}:${a.run_attempt}`, at = beijing(a.time);
    const doubt = ambiguous.get(id), status = companion.get(id);
    if (status && !doubt && (a.run_attempt === 1 || !uncertainDispatchLines.has(companionLine(status.description)))) {
      ignored.push({ kind: 'Z2', at, head, why: `常驻状态 ${status.id} 唯一对上运行 ${id}：${status.description}` });
      continue;
    }
    const push = pushes.filter(p => p.time <= a.time && (!a.branch || p.branch === a.branch)).at(-1);
    const branch = a.branch ?? push?.branch ?? null;
    const pr = a.prs?.find(p => positive(p.number))?.number ??
      prsByBranch.get(branch)?.find(p => stamp(p.created_at, `PR #${p.number}`) < a.time)?.number ?? null;
    const basis = `${a.run_attempt === 1 ? 'workflow_dispatch' : '工作流重跑'} 的 triggering_actor 为 User`
      + (doubt ? '，常驻状态对不唯一' : '');
    events.push({ kind: 'Z2', at, pr, branch, head, actor: a.triggering_actor.login, basis,
      evidence: { runId: a.id, attempt: a.run_attempt, workflow: a.workflow ?? null, ...(doubt ? { statusId: doubt.id } : {}) } });
  }
  return { events, ignored };
}

export async function collectBypass({ get, git = localMergeTree, since, now, heads, repo = 'tdoljyj/cross-memory-system' }) {
  let start = null, end = null;
  const events = [], ignored = [], pushedAt = new Map();
  let reason = null;
  try {
    end = stamp(now, '窗口终点');
    if (since != null) start = stamp(since, '窗口起点');
    if (heads.some(h => h.readError)) fail('候选 PR 的提交列表不完整');
    if (!heads.length) fail('没有候选 head，无法核定推送窗口');
    const branches = new Map();
    for (const head of heads) {
      const refs = head.branches ?? (await pages(get, `/commits/${head.sha}/pulls`)).map(p => prBranch(p, repo)).filter(Boolean);
      if (head.branches && !refs.length) fail(`候选 head ${head.sha} 缺同仓 PR 分支`);
      branches.set(head.sha, new Set(refs.length ? refs : [MAIN]));
    }
    const activity = new Map();
    const readBranch = async (branch, period) => {
      if (!activity.has(branch)) activity.set(branch, await readActivity(get, branch, period));
      return activity.get(branch);
    };
    for (const branch of new Set([...branches.values()].flatMap(refs => [...refs]))) await readBranch(branch);
    for (const push of [...activity.values()].flat()) {
      if (push.time > end || (start !== null && push.time < start) || !branches.get(push.after)?.has(push.branch)) continue;
      // 同一 SHA 若再次成为 tip，按它首次进入所选 PR 分支的时刻计这个 head。
      pushedAt.set(push.after, Math.min(push.time, pushedAt.get(push.after) ?? Infinity));
    }
    if (start === null) {
      if (!pushedAt.size) fail('活动记录缺候选 head 的推送证据，无法核定窗口');
      start = Math.min(...pushedAt.values());
    }
    if (start > end) fail('推送窗口起点晚于终点');
    const missingHead = heads.find(h => h.role !== 'superseded' && !pushedAt.has(h.sha));
    if (missingHead) fail(`活动记录缺当前或最终 head ${missingHead.sha} 的推送证据`);

    const inWindow = time => time >= start && time <= end;
    const updated = p => stamp(p?.updated_at, `PR #${p?.number ?? '?'} 更新`);
    const pulls = await pages(get, '/pulls?state=all&sort=updated&direction=desc', { stop: rows => updated(rows.at(-1)) < start });
    uniqueIds(pulls, '更新 PR 列表', p => p?.number);
    const prsByBranch = new Map();
    for (const [i, pull] of pulls.entries()) {
      if (i > 0 && updated(pull) > updated(pulls[i - 1])) fail('更新 PR 列表未按时间倒序');
      if (updated(pull) < start) continue;
      const branch = prBranch(pull, repo);
      if (!branch) continue;
      if (!prsByBranch.has(branch)) prsByBranch.set(branch, []);
      prsByBranch.get(branch).push(pull);
      if (branch !== MAIN && !(await readBranch(branch)).length) fail(`${branch} 的窗口内更新 PR #${pull.number} 缺 tip 活动证据`);
    }
    await readBranch(MAIN, activityPeriod(start, end));
    const pushes = [...activity.values()].flat().filter(p => inWindow(p.time)).sort((a, b) => a.time - b.time || a.id - b.id);
    const commitOf = async sha => {
      const commit = await get(`/commits/${sha}`);
      const tree = commit?.commit?.tree?.sha;
      const parents = commit?.parents?.map?.(p => p?.sha);
      if (commit?.sha !== sha || !validSha(tree) || !Array.isArray(parents) || !parents.every(validSha)) fail(`提交 ${sha} 缺父提交或树`);
      return { parents, tree };
    };
    const issueEvents = async pr => {
      const rows = await pages(get, `/issues/${pr}/events`);
      uniqueIds(rows, `PR #${pr} 事件`);
      if (rows.some(e => typeof e.event !== 'string' || !e.event)) fail(`PR #${pr} 缺事件类型`);
      return rows;
    };
    const prsOfBranch = async (branch, timestamp) => {
      const at = stamp(timestamp, '推送');
      const owner = repo.split('/')[0];
      const rows = await pages(get, `/pulls?${new URLSearchParams({ state: 'all', head: `${owner}:${branch}` })}`);
      uniqueIds(rows, `${branch} 的 PR 列表`, p => p?.number);
      const open = [];
      for (const pull of rows) {
        if (prBranch(pull, repo) !== branch || stamp(pull.created_at, `PR #${pull.number}`) >= at) continue;
        if (openAt(pull, await issueEvents(pull.number), at)) open.push(pull);
      }
      return open.sort((a, b) => a.number - b.number);
    };
    const ports = { commitOf, prsOfBranch, mergeTree: git, async isOnMain(sha) {
      const response = await get(`/compare/${sha}...main`);
      if (!['ahead', 'identical', 'behind', 'diverged'].includes(response?.status)) fail(`提交 ${sha} 的 main 祖先关系读不到`);
      return ['ahead', 'identical'].includes(response.status);
    } };
    // Z2 的取证范围是本窗口已读分支上实际推送或创建过的 tip。
    const tips = new Map();
    for (const push of pushes) {
      const result = await classifyPush(push, ports);
      if (result) (result.basis ? events : ignored).push(result);
      if (!tips.has(push.after)) tips.set(push.after, []);
      tips.get(push.after).push(push);
    }
    for (const [head, pushes] of tips) {
      const runs = await readReruns(get, head, pushes, prsByBranch, inWindow, end);
      events.push(...runs.events);
      ignored.push(...runs.ignored);
    }
    for (const pull of pulls.filter(p => updated(p) >= start)) {
      for (const e of (await issueEvents(pull.number)).filter(e => e.event === 'reopened')) {
        const at = stamp(e.created_at, `PR #${pull.number} 重开`);
        if (!inWindow(at)) continue;
        const identity = actorKind(e.actor);
        if (identity === 'unknown') fail(`PR #${pull.number} 的重开事件缺操作者身份`);
        if (identity === 'bot') {
          ignored.push({ kind: '重开', at: beijing(at), head: null, why: `机器人重开 PR #${pull.number}` });
          continue;
        }
        events.push({ kind: '重开', at: beijing(at), pr: pull.number, branch: pull.head?.ref ?? null, head: null, actor: e.actor.login,
          basis: 'GitHub issue reopened 事件的 actor 为 User', evidence: { issueEventId: e.id } });
      }
    }
  } catch (error) {
    reason = error?.message || String(error);
  }
  const order = (a, b) => Date.parse(a.at) - Date.parse(b.at);
  events.sort(order);
  ignored.sort(order);
  return { bypass: { state: reason === null ? '已判' : '未判', from: start === null ? null : beijing(start),
    to: end === null ? null : beijing(end), events, ignored, reason }, pushedAt };
}
