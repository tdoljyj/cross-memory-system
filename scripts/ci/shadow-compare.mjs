// 只读、零 npm 依赖。脚手架期影子对比：同一 head 上托管七项与独立 CI 对应检查逐项比结论
// （FABLE-hosted-ci-bootstrap-20261122 §1.5、§1.6；框架 v1 §2.3，S6 退出判据从这里读）。
// 不建新存储：GitHub 的 check-runs 就是记录。读取只走 retrigger-counter 的 ghReader（gh api GET）。
// 读不到、缺一边、没结论都判“未知”，从不判一致。只输出一行 JSON；不一致不改退出码（观察工具，不挡任何路径）。
// head 的角色从 PR 字段定（FABLE-shadow-superseded-20261122，丙）：当前（open PR 的 head）缺检查或未完成判“在跑”；
// 最终（已合入 PR 的 head）严格口径；被取代（PR 的其他提交、关闭未合入 PR 的 head）两侧都有红/绿终态才比，
// 比不了判“跳过”。“在跑”“跳过”都不计入、不打断连续一致。读取失败、#292 读不到或没钉住不分角色判未知。
//
//   node scripts/ci/shadow-compare.mjs --prs <起>-[<止>]      PR 范围内每个 PR 的每个被测 head
//   node scripts/ci/shadow-compare.mjs --head <sha> [--head <sha>]...
import { ghReader } from './retrigger-counter.mjs';

const REPO = 'tdoljyj/cross-memory-system';
// main write policy（#292）：框架侧每项检查由哪个来源发，从规则集本身读（它改钉，这里跟着变）。
export const MAIN_RULESET_ID = 24182890;
// 托管侧七项 hosted- 钉 GitHub Actions。准入不比：脚手架规则集钉的 kooyumi-work-admission 与框架同源（App 5368905），
// 没有第二边（FABLE-s6-exit-shorten-20261122 §0）。
const ACTIONS_APP_ID = 15368;
export const PAIRS = Object.freeze(['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows', 'gitleaks', 'trivy', 'contract-placement']
  .map(check => ({ check, hosted: { name: `hosted-${check}`, app: ACTIONS_APP_ID } })));
// 与 train-rules 一致：success、neutral、skipped 算过。cancelled、stale 等不是结论。
const PASS = new Set(['success', 'neutral', 'skipped']);
const FAIL = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
// S6 退出判据（FABLE-s6-exit-shorten-20261122 §3 与补答，Decision efe2cee6）：连续 30 个 head、首尾相隔不少于 72 小时、逐项一致，
// 其间出自不少于 10 个已合入 PR、至少 1 个非 Owner 推送的 head、至少 1 个 head 上同一项两边都红。
export const STREAK = Object.freeze({ heads: 30, hours: 72, mergedPrs: 10, nonOwnerPushedHeads: 1, bothRedHeads: 1 });
const LAST = 20;
const SHA = /^[0-9a-f]{40}$/;
const PAGE = 100;

const fail = message => { throw new Error(message); };
const beijing = value => {
  const n = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(n) ? new Date(n + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+08:00') : null;
};
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function limited(api, maxRequests) {
  let requests = 0;
  return route => {
    if (++requests > maxRequests) fail('达到 API 读取上限');
    return api.get(route);
  };
}

async function paged(get, route, key, maxPages = 50) {
  const all = [];
  let expected;
  for (let page = 1; page <= maxPages; page++) {
    const body = await get(`${route}${route.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`);
    const rows = key ? body?.[key] : body;
    if (!Array.isArray(rows) || rows.length > PAGE) fail(`列表不完整：${route}`);
    if (key) {
      if (!Number.isSafeInteger(body.total_count) || (expected ?? body.total_count) !== body.total_count) fail(`列表不完整：${route}`);
      expected = body.total_count;
    }
    all.push(...rows);
    if (rows.length < PAGE) {
      if (expected !== undefined && all.length !== expected) fail(`列表不完整：${route}`);
      return all;
    }
  }
  fail(`达到分页上限：${route}`);
}

// #292 的必需检查 → 来源 App；读不懂就返回 null（框架侧全部未知）。
async function readPins(get) {
  try {
    const body = await get(`/rulesets/${MAIN_RULESET_ID}`);
    if (!plain(body) || !Array.isArray(body.rules)) return null;
    const pins = new Map();
    for (const rule of body.rules) {
      if (rule?.type !== 'required_status_checks') continue;
      const list = rule.parameters?.required_status_checks;
      if (!Array.isArray(list)) return null;
      for (const c of list) if (typeof c?.context === 'string' && Number.isSafeInteger(c.integration_id)) pins.set(c.context, c.integration_id);
    }
    return pins.size > 0 ? pins : null;
  } catch {
    return null;
  }
}

function side(runs, name, app) {
  const mine = runs.filter(r => r?.name === name && r?.app?.id === app).sort((a, b) => a.id - b.id);
  const latest = mine.at(-1);
  if (!latest) return null;
  return { name, app, runs: mine.length, status: latest.status, conclusion: latest.conclusion ?? null,
    completedAt: beijing(latest.completed_at), title: latest.output?.title ?? null, completedMs: Date.parse(latest.completed_at ?? '') };
}
const shown = s => s && (({ completedMs, ...rest }) => rest)(s);

// head 的角色：当前 > 最终 > 被取代（同一提交在几个 PR 里取最严的一个）。
export const ROLES = Object.freeze({ current: 3, final: 2, superseded: 1 });

function judge(pair, runs, pins, role) {
  const base = { check: pair.check };
  if (pins === null) return { ...base, verdict: '未知', reason: '#292 读不到，框架侧来源不明' };
  const app = pins.get(pair.check);
  if (app === undefined) return { ...base, verdict: '未知', reason: `${pair.check} 未在 #292 钉住来源` };
  const framework = side(runs, pair.check, app), hosted = side(runs, pair.hosted.name, pair.hosted.app);
  const out = { ...base, framework: shown(framework), hosted: shown(hosted), frameworkReruns: framework ? framework.runs - 1 : null };
  // 比不了的一项：被取代判跳过，当前判在跑（无结论除外：当前 head 上没有新推送去取消它），最终判未知。
  const unjudgeable = (reason, { pending }) => role === 'superseded' ? { ...out, verdict: '跳过', reason: `${reason}，已被取代` }
    : role === 'current' && pending ? { ...out, verdict: '在跑', reason }
      : { ...out, verdict: '未知', reason };
  if (!framework || !hosted) return unjudgeable(!framework && !hosted ? '两边都缺检查' : !framework ? '框架缺检查' : '托管缺检查', { pending: true });
  for (const [label, s] of [['框架', framework], ['托管', hosted]]) {
    if (s.status !== 'completed') return unjudgeable(`${label}未完成（${s.status}）`, { pending: true });
  }
  const cls = s => PASS.has(s.conclusion) ? '绿' : FAIL.has(s.conclusion) ? '红' : null;
  for (const [label, s] of [['框架', framework], ['托管', hosted]]) {
    if (cls(s) === null) return unjudgeable(`${label}无结论（${s.conclusion}）`, { pending: false });
  }
  out.completionDeltaSeconds = Number.isFinite(framework.completedMs) && Number.isFinite(hosted.completedMs)
    ? Math.round((hosted.completedMs - framework.completedMs) / 1000) : null;
  if (cls(framework) === cls(hosted)) return { ...out, verdict: '一致', reason: null };
  const red = cls(framework) === '红' ? framework : hosted;
  const direction = red === framework ? '框架红、托管绿' : '托管红、框架绿';
  return { ...out, verdict: '不一致', direction, reason: red.title ? `${direction}：${red.title}` : direction };
}

const NAMES = new Set(PAIRS.flatMap(p => [p.check, p.hosted.name]));

// 一个候选 head：读 check-runs；一条检查都没有的（多提交推送的中间提交）返回 null。只要跑过任何检查就算 head：
// 对比检查一条都没出（如工作流改坏、作业名成了表达式原文）正是要报的“未知”，不能当中间提交跳过。
async function judgeHead(get, pins, { sha, prs, role, committedAt }) {
  let runs;
  try {
    runs = await paged(get, `/commits/${sha}/check-runs?filter=all`, 'check_runs');
  } catch (error) {
    const reason = `读取失败：${error.message}`;
    return { sha, prs, at: beijing(committedAt), atMs: Date.parse(committedAt ?? ''), verdict: '未知',
      pairs: PAIRS.map(p => ({ check: p.check, verdict: '未知', reason })) };
  }
  if (runs.length === 0) return null;
  const ours = runs.filter(r => NAMES.has(r?.name));
  const starts = (ours.length ? ours : runs).map(r => Date.parse(r?.started_at ?? '')).filter(Number.isFinite);
  const atMs = starts.length ? Math.min(...starts) : Date.parse(committedAt ?? '');
  const pairs = PAIRS.map(p => judge(p, runs, pins, role));
  const has = v => pairs.some(p => p.verdict === v);
  // 不一致 > 未知 > 在跑 > 跳过 > 一致：七项都比了且都一致才是一致 head。
  const verdict = has('不一致') ? '不一致' : has('未知') ? '未知' : has('在跑') ? '在跑' : has('跳过') ? '跳过' : '一致';
  return { sha, prs, role, at: beijing(atMs), atMs, verdict, pairs };
}

async function candidatesOfPrs(get, { from, to }) {
  const pulls = [];
  for (let page = 1; page <= 50; page++) {
    const rows = await get(`/pulls?state=all&sort=created&direction=desc&per_page=${PAGE}&page=${page}`);
    if (!Array.isArray(rows) || rows.length > PAGE) fail('PR 列表不完整');
    pulls.push(...rows.filter(p => Number.isSafeInteger(p?.number) && p.number >= from && (to === null || p.number <= to)));
    if (rows.length < PAGE || rows.some(p => p?.number < from)) break;
    if (page === 50) fail('PR 列表达到分页上限');
  }
  const out = [];
  for (const pull of pulls.sort((a, b) => a.number - b.number)) {
    const head = pull.head?.sha;
    // 当前：open PR 的 head；最终：已合入 PR 的 head；其余（PR 的其他提交、关闭未合入 PR 的 head）是被取代。
    const roleOf = sha => sha !== head ? 'superseded' : pull.state === 'open' ? 'current' : pull.merged_at ? 'final' : 'superseded';
    // 已合入 PR 的最终 head 记下 PR 号（判据 X1）。
    const facts = sha => ({ prs: [pull.number], role: roleOf(sha), mergedPrs: roleOf(sha) === 'final' ? [pull.number] : [] });
    try {
      const commits = await paged(get, `/pulls/${pull.number}/commits`, null, 3);
      for (const c of commits) if (SHA.test(c?.sha ?? '')) out.push({ sha: c.sha, ...facts(c.sha), committedAt: c.commit?.committer?.date });
    } catch (error) {
      if (!SHA.test(head ?? '')) continue;
      out.push({ sha: head, ...facts(head), committedAt: null, readError: `读取失败：${error.message}` });
    }
  }
  // 同一提交出现在两个 PR 里只比一次，角色取最严的一个。
  const bySha = new Map();
  for (const c of out) {
    const seen = bySha.get(c.sha);
    if (seen) {
      const union = key => [...new Set([...seen[key], ...c[key]])];
      seen.prs = union('prs').sort((a, b) => a - b);
      seen.mergedPrs = union('mergedPrs').sort((a, b) => a - b);
      if (ROLES[c.role] > ROLES[seen.role]) seen.role = c.role;
      seen.readError ??= c.readError;
    } else bySha.set(c.sha, { ...c });
  }
  return [...bySha.values()];
}

// 判据 X2：head 的推送者 = 这个 head 上 pull_request 事件运行的 actor.login（FABLE-s6-exit-shorten-20261122 补答）。
// 不看 PR 作者、不看提交作者：合 main 机器人推的 head 算非 Owner；Owner 名下代理推的读回是 Owner。读不到返回 null，不算非 Owner。
async function pushersOf(get, sha) {
  try {
    const runs = await paged(get, `/actions/runs?head_sha=${sha}&event=pull_request`, 'workflow_runs');
    return [...new Set(runs.filter(r => r?.event === 'pull_request' && typeof r.actor?.login === 'string' && r.actor.login !== '')
      .map(r => r.actor.login))];
  } catch {
    return null;
  }
}

function summarize(heads, nowMs, owner) {
  const counts = { 一致: 0, 不一致: 0, 未知: 0, 在跑: 0, 跳过: 0 };
  for (const h of heads) counts[h.verdict]++;
  // 连续一致：从最新往回数，“在跑”“跳过”不计也不打断，其余非一致即断。跨度从这一段第一个一致 head 起算。
  const decided = heads.filter(h => h.verdict !== '在跑' && h.verdict !== '跳过');
  let n = 0;
  while (n < decided.length && decided[decided.length - 1 - n].verdict === '一致') n++;
  const run = decided.slice(decided.length - n);
  const firstMs = run[0]?.atMs, lastMs = run.at(-1)?.atMs;
  const spanMs = n > 0 && Number.isFinite(firstMs) && Number.isFinite(lastMs) ? lastMs - firstMs : 0;
  const mergedPrs = new Set(run.flatMap(h => h.mergedPrs ?? [])).size;
  const nonOwnerPushedHeads = run.filter(h => (h.pushers ?? []).some(login => login !== owner)).length;
  const bothRedHeads = run.filter(h => h.pairs.some(p => p.verdict === '一致' && FAIL.has(p.framework?.conclusion) && FAIL.has(p.hosted?.conclusion))).length;
  const unmet = [
    n < STREAK.heads && `连续一致不足 ${STREAK.heads} 个 head`,
    spanMs < STREAK.hours * 3600_000 && `首尾相隔不足 ${STREAK.hours} 小时`,
    mergedPrs < STREAK.mergedPrs && `已合入 PR 不足 ${STREAK.mergedPrs} 个`,
    nonOwnerPushedHeads < STREAK.nonOwnerPushedHeads && '没有非 Owner 推送的 head',
    bothRedHeads < STREAK.bothRedHeads && '没有两边同红的 head',
  ].filter(Boolean);
  const hours = Math.round(spanMs / 360_000) / 10, days = Math.round(spanMs / 8640_000) / 10;
  const rule = `连续 ${STREAK.heads} 个 head、首尾相隔不少于 ${STREAK.hours} 小时，七项逐项一致；出自不少于 ${STREAK.mergedPrs} 个已合入 PR，`
    + `含至少 ${STREAK.nonOwnerPushedHeads} 个非 Owner 推送的 head、至少 ${STREAK.bothRedHeads} 个两边同红的 head`;
  const streak = { heads: n, hours, days, from: run[0]?.at ?? null, to: run.at(-1)?.at ?? null, mergedPrs, nonOwnerPushedHeads, bothRedHeads,
    met: unmet.length === 0, unmet, rule };
  const hostedGreenFrameworkRedLast20 = decided.slice(-LAST).flatMap(h => h.pairs).filter(p => p.direction === '框架红、托管绿').length;
  const mismatches = heads.flatMap(h => h.pairs.filter(p => p.verdict === '不一致').map(p => `${h.sha.slice(0, 7)} ${p.check} ${p.direction}`));
  const line = `影子对比 ${beijing(nowMs)}：${heads.length} 个 head，一致 ${counts.一致}、不一致 ${counts.不一致}、未知 ${counts.未知}、在跑 ${counts.在跑}、跳过 ${counts.跳过}；`
    + `连续一致 ${n} 个 head / ${hours} 小时，已合入 PR ${mergedPrs} 个、非 Owner 推送 ${nonOwnerPushedHeads} 个、两边同红 ${bothRedHeads} 个`
    + `（判据：${streak.met ? '已达' : `未达，${unmet.join('、')}`}）`
    + (mismatches.length ? `；不一致：${mismatches.join('；')}` : '');
  return { counts, streak, hostedGreenFrameworkRedLast20, line };
}

export async function compare({ repo = REPO, prs = null, heads = null, api = ghReader({ repo }), now = new Date().toISOString(), maxRequests = 5000 } = {}) {
  const get = limited(api, maxRequests);
  const pins = await readPins(get);
  const candidates = prs ? await candidatesOfPrs(get, prs)
    // 直接给的 head 视作当前 head：还没完成的判在跑。
    : heads.map(sha => ({ sha, prs: [], mergedPrs: [], role: 'current', committedAt: null }));
  const judged = [];
  for (const c of candidates) {
    if (c.readError) {
      judged.push({ sha: c.sha, prs: c.prs, mergedPrs: c.mergedPrs, role: c.role, at: null, atMs: NaN, verdict: '未知',
        pairs: PAIRS.map(p => ({ check: p.check, verdict: '未知', reason: c.readError })) });
      continue;
    }
    const head = await judgeHead(get, pins, c);
    if (!head) continue;
    // 推送者只对一致 head 读（连续一致段只由它们组成）。
    judged.push({ ...head, mergedPrs: c.mergedPrs, ...(head.verdict === '一致' ? { pushers: await pushersOf(get, c.sha) } : {}) });
  }
  // 按时间排（读不到时间的排最后，照样打断连续一致）；直接给 head 时保持给定顺序。
  if (prs) judged.sort((a, b) => (Number.isFinite(a.atMs) ? a.atMs : Infinity) - (Number.isFinite(b.atMs) ? b.atMs : Infinity) || a.sha.localeCompare(b.sha));
  const summary = summarize(judged, Date.parse(now), repo.split('/')[0]);
  return { status: 'ok', repo, generatedAt: beijing(now), ruleset: { id: MAIN_RULESET_ID, readable: pins !== null },
    pairs: PAIRS.map(p => ({ check: p.check, hosted: p.hosted.name, hostedApp: p.hosted.app })),
    heads: judged.map(({ atMs, ...h }) => h), summary };
}

function parse(argv) {
  const heads = [];
  let prs = null;
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--head' && SHA.test(value ?? '')) { heads.push(value); i++; continue; }
    if (flag === '--prs' && /^\d+-\d*$/.test(value ?? '') && prs === null) {
      const [from, to] = value.split('-');
      prs = { from: Number(from), to: to === '' ? null : Number(to) };
      if (prs.to !== null && prs.to < prs.from) fail('--prs 起号不能大于止号');
      i++; continue;
    }
    fail(`参数无效：${flag}`);
  }
  if ((prs === null) === (heads.length === 0)) fail('用法：--prs <起>-[<止>] 或 --head <40 位 sha>（可重复），二选一');
  return { prs, heads: prs ? null : heads };
}

export async function main(argv, { api, write = line => process.stdout.write(`${line}\n`), now } = {}) {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    write(JSON.stringify({ status: 'error', error: error.message }));
    return 2;
  }
  try {
    write(JSON.stringify(await compare({ ...options, ...(api ? { api } : {}), ...(now ? { now } : {}) })));
    return 0;
  } catch (error) {
    write(JSON.stringify({ status: 'error', error: error.message }));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
