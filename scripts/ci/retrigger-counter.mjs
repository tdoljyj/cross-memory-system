// 只读、零 npm 依赖。口径与证据边界见 retrigger-counter.md。
import { spawnSync } from 'node:child_process';

const REPO = 'tdoljyj/cross-memory-system';
const KINDS = ['reruns', 'empty_commits', 'main_merges', 'reopens'];
const REQUIRED = '.github/workflows/clued-required-tests.yml';
const AUTO_TEXT = '已自动补跑一次必需测试';
const fail = message => { throw new Error(message); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const nonempty = s => typeof s === 'string' && s.length > 0;
const stamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`时间须为带时区的 ISO 8601：${value}`);
  return Date.parse(value);
};
const beijing = n => new Date(n + 8 * 3600_000).toISOString().replace('.000Z', '+08:00');
const bucket = () => ({ manual: 0, automatic: 0, unknown: 0, total: 0 });
const counts = () => Object.fromEntries(KINDS.map(k => [k, bucket()]));

export function ghReader({ repo = REPO, spawn = spawnSync } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('仓库名无效');
  return { async get(route) {
    if (!/^\/(?:[A-Za-z0-9_./?&=%:+-]*)$/.test(route) || route.split(/[/?]/).some(p => p === '.' || p === '..')) fail('拒绝 API 路径');
    const r = spawn('gh', ['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28', `repos/${repo}${route === '/' ? '' : route}`],
    { encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    // 不回显 gh stderr，避免把本机认证诊断带进报告。
    if (r.error || r.status !== 0) fail(`gh GET ${route} 失败（退出码 ${r.status ?? '未启动'}）`);
    try { return JSON.parse(r.stdout); } catch { fail(`gh GET ${route} 返回非 JSON`); }
  } };
}

// 按 head 匹配常驻状态。同一提示前 15 分钟内有多个候选时保留歧义证据。
export function matchCompanionStatuses(attempts, statuses, { matchesWorkflow, matchesDescription }) {
  const hints = statuses.filter(s => /^resident-queue\/[^/]+ \(info only\)$/.test(s.context ?? '') &&
    typeof s.description === 'string' && matchesDescription(s.description))
    .map(status => ({ status, at: stamp(status.created_at) })).sort((a, b) => a.at - b.at);
  const candidates = attempts.filter(a => matchesWorkflow(a.workflow)).map(attempt => ({
    id: `${attempt.id}:${attempt.run_attempt}`, at: stamp(attempt.run_started_at),
  }));
  const companion = new Map(), ambiguous = new Map();
  // 同一提示会随面板刷新再次发布，所以只认该 head 上最早的提示。
  const first = hints[0];
  if (first) {
    const eligible = candidates.filter(a => a.at <= first.at && first.at - a.at <= 15 * 60_000);
    const result = eligible.length === 1 ? companion : ambiguous;
    for (const a of eligible) result.set(a.id, first.status);
  }
  return { companion, ambiguous };
}

export async function collect({ repo = REPO, since, until, automationActors = [], api = ghReader({ repo }), maxPages = 1000, maxRequests = 20_000 } = {}) {
  const start = stamp(since), end = stamp(until);
  if (start >= end) fail('since 必须早于 until');
  if (!positive(maxPages) || !positive(maxRequests)) fail('读取上限无效');
  const inWindow = t => { const n = stamp(t); return n >= start && n < end; };
  const automatic = new Set(automationActors.map(s => s.toLowerCase()));
  let requests = 0;
  const cache = new Map();
  async function get(route) {
    if (!cache.has(route)) {
      if (++requests > maxRequests) fail('达到 API 读取上限，结果不完整');
      cache.set(route, await api.get(route));
    }
    return cache.get(route);
  }
  async function paged(route, key, stopAfterPage) {
    const all = [];
    let expected;
    for (let page = 1; page <= maxPages; page++) {
      const body = await get(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = key ? body?.[key] : body;
      if (!Array.isArray(rows) || rows.length > 100) fail(`API 列表不完整：${route}`);
      if (key) {
        if (!Number.isSafeInteger(body.total_count) || body.total_count < 0) fail(`API total_count 无效：${route}`);
        expected ??= body.total_count;
        if (body.total_count !== expected) fail(`读取期间列表发生变化：${route}`);
      }
      all.push(...rows);
      if (rows.length < 100) {
        if (expected !== undefined && all.length !== expected) fail(`API 列表不完整：${route}`);
        return all;
      }
      if (stopAfterPage?.(rows)) return all;
    }
    fail(`达到分页上限，结果不完整：${route}`);
  }
  function actorKind(actor) {
    if (!actor || !nonempty(actor.login)) return 'unknown';
    if (actor.type === 'Bot' || /\[bot\]$/i.test(actor.login) || automatic.has(actor.login.toLowerCase())) return 'automatic';
    return actor.type === 'User' ? 'manual' : 'unknown';
  }
  const events = new Map();
  function add(kind, id, at, actor, prs = [], basis = 'actor') {
    const key = `${kind}:${id}`;
    const existing = events.get(key);
    if (existing) { existing.prs = [...new Set([...existing.prs, ...prs])].sort((a, b) => a - b); return; }
    events.set(key, { kind, id: String(id), at: beijing(stamp(at)), classification: actorKind(actor),
      actor: actor?.login ?? null, prs: [...new Set(prs)].sort((a, b) => a - b), basis });
  }

  const metadata = await get('/');
  const branch = metadata?.default_branch;
  if (!nonempty(branch)) fail('仓库没有 default_branch');
  // 不按 created 过滤：窗口之前创建的运行也可能在窗口内 rerun。
  const runs = await paged('/actions/runs', 'workflow_runs');
  const attempts = [];
  for (const run of runs) {
    if (!positive(run.id) || !positive(run.run_attempt) || !nonempty(run.head_sha)) fail('运行响应缺少身份或 attempt');
    if (run.run_attempt === 1 || stamp(run.updated_at) < start) continue;
    for (let n = 2; n <= run.run_attempt; n++) {
      const a = await get(`/actions/runs/${run.id}/attempts/${n}`);
      if (a?.id !== run.id || a.run_attempt !== n || a.head_sha !== run.head_sha) fail('attempt 响应与运行不一致');
      stamp(a.run_started_at);
      attempts.push({ ...a, workflow: run.path, prs: (run.pull_requests ?? []).map(p => p.number).filter(positive) });
    }
  }
  // Owner 身份同时供 companion 使用。每个 head 的最早成功提示至多归因一次。
  // 只接受固定 info context；提示前 15 分钟内唯一一个 required-tests attempt 才能匹配。
  // 历史 attempt 也参与匹配，旧提示不会抵扣本窗口的新人工 rerun。
  const companion = new Set(), ambiguous = new Set();
  for (const head of new Set(attempts.filter(a => a.workflow === REQUIRED && actorKind(a.triggering_actor) !== 'automatic').map(a => a.head_sha))) {
    const statuses = await paged(`/commits/${encodeURIComponent(head)}/statuses`);
    const matches = matchCompanionStatuses(attempts.filter(a => a.head_sha === head), statuses, {
      matchesWorkflow: workflow => workflow === REQUIRED,
      matchesDescription: description => description.includes(AUTO_TEXT),
    });
    for (const id of matches.companion.keys()) companion.add(id);
    for (const id of matches.ambiguous.keys()) ambiguous.add(id);
  }
  for (const a of attempts) {
    if (!inWindow(a.run_started_at)) continue;
    const id = `${a.id}:${a.run_attempt}`;
    add('reruns', id, a.run_started_at, a.triggering_actor, a.prs);
    const e = events.get(`reruns:${id}`);
    if (companion.has(id)) { e.classification = 'automatic'; e.basis = 'companion-status'; }
    else if (ambiguous.has(id) && e.classification !== 'automatic') { e.classification = 'unknown'; e.basis = 'ambiguous-companion-status'; }
  }

  const prs = [];
  // pulls API 没有 since；按 updated 逆序，读到窗口前即结束，不扫描全库 PR 历史。
  const pulls = await paged('/pulls?state=all&sort=updated&direction=desc', undefined,
    rows => stamp(rows.at(-1).updated_at) < start);
  const commits = new Map();
  function remember(c, pr) {
    if (!nonempty(c?.sha) || !Array.isArray(c.parents) || !nonempty(c.commit?.tree?.sha)) fail('提交响应不完整');
    if (!inWindow(c.commit?.committer?.date)) return;
    const entry = commits.get(c.sha) ?? { commit: c, prs: [] };
    if (pr && !entry.prs.includes(pr)) entry.prs.push(pr);
    commits.set(c.sha, entry);
  }
  for (const p of pulls) {
    if (!positive(p.number)) fail('PR 编号无效');
    if (stamp(p.updated_at) < start) continue;
    const pr = await get(`/pulls/${p.number}`);
    if (pr.number !== p.number || !Number.isSafeInteger(pr.commits) || pr.commits < 0 || pr.commits > 250) fail(`PR #${p.number} 提交列表不完整或超过 API 的 250 条限制`);
    const pc = await paged(`/pulls/${p.number}/commits`);
    if (pc.length !== pr.commits) fail(`PR #${p.number} 提交列表不完整`);
    for (const c of pc) remember(c, p.number);
    const timeline = await paged(`/issues/${p.number}/timeline`);
    let closed = false;
    for (const e of timeline) {
      if (e.event === 'closed') closed = true;
      if (e.event === 'reopened') {
        if (!positive(e.id)) fail('重开事件缺少 ID');
        if (!closed) fail(`PR #${p.number} 重开缺少关闭证据`);
        if (inWindow(e.created_at)) add('reopens', e.id, e.created_at, e.actor, [p.number]);
        closed = false;
      }
    }
    prs.push(p.number);
  }
  // 还覆盖当前所有分支上未进入 PR 的空提交；PR API 补已删分支的历史。
  const branches = await paged('/branches');
  for (const b of branches) {
    if (!nonempty(b.commit?.sha)) fail('分支响应缺少 SHA');
    const query = new URLSearchParams({ sha: b.commit.sha, since: new Date(start).toISOString(), until: new Date(end).toISOString() });
    for (const c of await paged(`/commits?${query}`)) remember(c);
  }
  for (const { commit: c, prs: linked } of commits.values()) {
    const actor = c.committer?.login === 'web-flow' ? c.author : c.committer ?? c.author;
    const at = c.commit.committer.date;
    if (c.parents.length === 1) {
      const parent = await get(`/commits/${encodeURIComponent(c.parents[0].sha)}`);
      if (!nonempty(parent?.commit?.tree?.sha)) fail('父提交缺少 tree');
      if (parent.commit.tree.sha === c.commit.tree.sha) add('empty_commits', c.sha, at, actor, linked, 'same-tree');
    }
    // 不把普通 merge/将 feature 合入 main 计为合 main；同时核第二父提交确为默认分支祖先。
    const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mergeMain = new RegExp(`^Merge (?:branch '${escaped}'|remote-tracking branch '(?:origin/)?${escaped}')(?: into .+)?(?:\\n|$)`);
    if (linked.length && c.parents.length === 2 && mergeMain.test(c.commit.message)) {
      const comparison = await get(`/compare/${encodeURIComponent(c.parents[1].sha)}...${encodeURIComponent(branch)}`);
      if (!['ahead', 'behind', 'identical', 'diverged'].includes(comparison?.status)) fail('合 main 祖先校验响应无效');
      if (['ahead', 'identical'].includes(comparison.status)) add('main_merges', c.sha, at, actor, linked, 'merge-message-and-second-parent');
    }
  }
  const result = { schema_version: 1, status: 'ok', repo, window: { since: beijing(start), until: beijing(end), bounds: '[since,until)' },
    counts: counts(), prs: [], events: [...events.values()].sort((a, b) => stamp(a.at) - stamp(b.at) || a.id.localeCompare(b.id)),
    coverage: { actions: 'GitHub 保留的全部运行及逐次 attempt', commits: '当前分支和窗口内更新 PR 中仍可读取的提交',
      attribution: 'Bot/配置身份，或 companion status 唯一匹配；其余 User 计人工，缺失或歧义计未知', requests } };
  function tally(target, e) { target[e.kind][e.classification]++; target[e.kind].total++; }
  for (const e of result.events) tally(result.counts, e);
  for (const number of [...new Set([...prs, ...result.events.flatMap(e => e.prs)])].sort((a, b) => a - b)) {
    const c = counts();
    for (const e of result.events.filter(e => e.prs.includes(number))) tally(c, e);
    result.prs.push({ number, counts: c });
  }
  return result;
}

export async function main(argv, { api, write = line => process.stdout.write(`${line}\n`) } = {}) {
  try {
    const options = { automationActors: [] };
    for (let i = 0; i < argv.length; i += 2) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail(`参数缺少值：${argv[i]}`);
      if (argv[i] === '--automation-actor') options.automationActors.push(value);
      else if (['--repo', '--since', '--until'].includes(argv[i])) options[argv[i].slice(2)] = value;
      else fail(`未知参数：${argv[i]}`);
    }
    write(JSON.stringify(await collect({ ...options, ...(api ? { api } : {}) })));
    return 0;
  } catch (e) {
    write(JSON.stringify({ schema_version: 1, status: 'error', error: e.message }));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
