// 只读、零 npm 依赖。脚手架期影子对比：同一 head 上托管七项与独立 CI 对应检查逐项比结论
// （FABLE-hosted-ci-bootstrap-20261122 §1.5、§1.6；框架 v1 §2.3，S6 退出判据从这里读）。
// 不建新存储：GitHub 的 check-runs 就是记录。读取只走 retrigger-counter 的 ghReader（gh api GET）。
// 读不到、缺一边、没结论都判“未知”，从不判一致。只输出一行 JSON；不一致不改退出码（观察工具，不挡任何路径）。
// head 的角色从 PR 字段定（FABLE-shadow-superseded-20261122，丙）：当前（open PR 的 head）缺检查或未完成判“在跑”；
// 最终（已合入 PR 的 head）严格口径；被取代（PR 的其他提交、关闭未合入 PR 的 head）两侧都有红/绿终态才比，
// 比不了判“跳过”。“在跑”“跳过”都不计入、不打断连续一致。读取失败、#292 读不到或没钉住不分角色判未知。
// 同一次运行里先有检查被取消、这条红检查之后才开始的，这一侧无结论（FABLE-shadow-superseded-head-20261124 §R2）。
// 按树读（框架修订 7，Decision ff9a7f17；FABLE-s6-merge-before-shadow-20261124 §2 甲）：最终 head 上框架侧缺某项时，
// 从该 PR 的合入提交 M 读同名、同来源的那条，条件是 M 有两个父提交、第二个父提交就是这个 head、两者同一棵树；
// head 上有的（不论什么状态）不被替换，读不到或不满足维持“未知”并写明原因。该项带 frameworkFrom，汇总写按树读了几个 head。
// 刚合入（同上 §8）：最终 head 框架侧结论未出（缺检查且按树读前提成立，或未完成；托管侧已完成）、距合入不满
// MERGED_PENDING_MINUTES 分钟判“在跑”，满了回到“未知”；连续段内有这样的 head，判据一律“未达”。
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
// S6 退出判据（FABLE-s6-exit-shorten-20261122 §3 与补答；Decision 67cea8f4 起不再要求首尾相隔 72 小时，只看计数与三项覆盖）：连续 30 个 head、逐项一致，
// 其间出自不少于 10 个已合入 PR、至少 1 个非 Owner 推送的 head、至少 1 个 head 上同一项两边都红。
export const STREAK = Object.freeze({ heads: 30, mergedPrs: 10, nonOwnerPushedHeads: 1, bothRedHeads: 1 });
// 已合入 PR 的最终 head 框架结论未出时判“在跑”的窗口，从 PR 的 merged_at 起算（FABLE-s6-merge-before-shadow-20261124 §8）：
// 门作业超时 15 分钟 + 最长作业超时 45 分钟（clued-required-tests.yml:72、244）+ 实测 M 上框架最晚开始 17 分钟 = 77，取整到 90；
// 也是实测最慢（合入后 42.8 分钟跑完）的两倍。满了仍没结论（如 M 的推送运行排队时被顶掉）回到“未知”。
export const MERGED_PENDING_MINUTES = 90;
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

// 这条检查开始时，它所在的运行（check suite）里是否已有检查被取消（§R2）。块 4 起汇总作业 if: always()，运行被并发取消后
// 它照样在 needs 结束之后才开始、读到 cancelled 就失败；GitHub 取消运行时正在跑的作业记 cancelled 不记 failure，
// 所以取消之前就开始的红是它自己跑出来的，照常比较。按开始时间比（不按完成时间）；cancelled 只认同名检查里最新的一条
// （重跑时 suite 不变，旧尝试的 cancelled 不算）。只用已读到的 check-runs，缺 suite 或开始时间就不算。
function startedAfterCancel(runs, latest) {
  const suite = latest.check_suite?.id, started = Date.parse(latest.started_at ?? '');
  if (!Number.isSafeInteger(suite) || !Number.isFinite(started)) return false;
  const newest = new Map();
  for (const r of runs) if (r?.check_suite?.id === suite && !(newest.get(r.name)?.id > r.id)) newest.set(r.name, r);
  return [...newest.values()].some(r => r.conclusion === 'cancelled' && Date.parse(r.completed_at ?? '') <= started);
}

function side(runs, name, app) {
  const mine = runs.filter(r => r?.name === name && r?.app?.id === app).sort((a, b) => a.id - b.id);
  const latest = mine.at(-1);
  if (!latest) return null;
  return { name, app, runs: mine.length, status: latest.status, conclusion: latest.conclusion ?? null,
    completedAt: beijing(latest.completed_at), title: latest.output?.title ?? null, completedMs: Date.parse(latest.completed_at ?? ''),
    afterCancel: startedAfterCancel(runs, latest) };
}
const shown = s => s && (({ completedMs, afterCancel, ...rest }) => rest)(s);

// head 的角色：当前 > 最终 > 被取代（同一提交在几个 PR 里取最严的一个）。
export const ROLES = Object.freeze({ current: 3, final: 2, superseded: 1 });

// merged：按树读到的合入提交 { sha, tree, runs }，只给最终 head；没有就是 null。mergedAt、nowMs：刚合入的窗口（§8）。
function judge(pair, runs, pins, role, merged = null, mergedAt = null, nowMs = NaN) {
  const base = { check: pair.check };
  if (pins === null) return { ...base, verdict: '未知', reason: '#292 读不到，框架侧来源不明' };
  const app = pins.get(pair.check);
  if (app === undefined) return { ...base, verdict: '未知', reason: `${pair.check} 未在 #292 钉住来源` };
  const own = side(runs, pair.check, app), hosted = side(runs, pair.hosted.name, pair.hosted.app);
  // head 上没有这条才从 M 读；M 上同名同来源的那条照样按它自己运行里的取消判（side 只看 M 的 check-runs）。
  const fromMerge = !own && merged ? side(merged.runs, pair.check, app) : null;
  const framework = own ?? fromMerge;
  const out = { ...base, framework: shown(framework), hosted: shown(hosted), frameworkReruns: framework ? framework.runs - 1 : null,
    ...(fromMerge ? { frameworkFrom: { sha: merged.sha, tree: merged.tree } } : {}) };
  // 比不了的一项：被取代判跳过，当前判在跑（无结论除外：当前 head 上没有新推送去取消它），最终判未知；
  // 最终 head 只有框架侧结论未出（frameworkPending）且距合入不满窗口时判在跑，满了原因写明超窗（§8）。
  const unjudgeable = (reason, { pending, frameworkPending = false }) => {
    if (role === 'superseded') return { ...out, verdict: '跳过', reason: `${reason}，已被取代` };
    if (role === 'current' && pending) return { ...out, verdict: '在跑', reason };
    if (role === 'final' && frameworkPending) {
      const elapsed = nowMs - Date.parse(mergedAt ?? '');
      if (elapsed >= 0 && elapsed < MERGED_PENDING_MINUTES * 60_000) {
        return { ...out, verdict: '在跑', reason: `已合入 ${Math.floor(elapsed / 60_000)} 分钟，框架结论未出（${reason}）` };
      }
      if (elapsed >= MERGED_PENDING_MINUTES * 60_000) {
        return { ...out, verdict: '未知', reason: `合入已超过 ${MERGED_PENDING_MINUTES} 分钟，框架仍无结论（${reason}）` };
      }
    }
    return { ...out, verdict: '未知', reason };
  };
  // 框架侧缺检查只在按树读前提成立（读到了 M 的检查）、托管侧在时算结论未出。
  if (!framework || !hosted) return unjudgeable(!framework && !hosted ? '两边都缺检查' : !framework ? '框架缺检查' : '托管缺检查',
    { pending: true, frameworkPending: !framework && !!hosted && merged !== null });
  for (const [label, s] of [['框架', framework], ['托管', hosted]]) {
    // 框架侧未完成（不论读自 head 还是 M）且托管侧已完成，算框架结论未出。
    if (s.status !== 'completed') return unjudgeable(`${label}未完成（${s.status}）`, { pending: true, frameworkPending: label === '框架' && hosted.status === 'completed' });
  }
  const cls = s => PASS.has(s.conclusion) ? '绿' : FAIL.has(s.conclusion) ? '红' : null;
  for (const [label, s] of [['框架', framework], ['托管', hosted]]) {
    if (cls(s) === null) return unjudgeable(`${label}无结论（${s.conclusion}）`, { pending: false });
  }
  for (const [label, s] of [['框架', framework], ['托管', hosted]]) {
    if (cls(s) === '红' && s.afterCancel) return unjudgeable(`${label}无结论（同一运行中先有取消，本检查之后才开始）`, { pending: false });
  }
  out.completionDeltaSeconds = Number.isFinite(framework.completedMs) && Number.isFinite(hosted.completedMs)
    ? Math.round((hosted.completedMs - framework.completedMs) / 1000) : null;
  if (cls(framework) === cls(hosted)) return { ...out, verdict: '一致', reason: null };
  const red = cls(framework) === '红' ? framework : hosted;
  const direction = red === framework ? '框架红、托管绿' : '托管红、框架绿';
  return { ...out, verdict: '不一致', direction, reason: red.title ? `${direction}：${red.title}` : direction };
}

const NAMES = new Set(PAIRS.flatMap(p => [p.check, p.hosted.name]));

// 按树读的前提（修订 7）：M 有两个父提交、第二个父提交就是 head、两者树哈希相同；满足才读 M 的 check-runs。
// 至多多 3 次读取（M、head 的 git commit 与 M 的检查，检查过 100 条才分页）。任何一步不满足或读不到返回 { sha, reason }。
async function mergedTree(get, head, merge) {
  if (!SHA.test(merge ?? '')) return { sha: merge ?? null, reason: 'PR 没有合入提交（merge_commit_sha 读不到）' };
  try {
    const m = await get(`/git/commits/${merge}`);
    const parents = Array.isArray(m?.parents) ? m.parents.map(p => p?.sha) : [];
    if (parents.length !== 2) return { sha: merge, reason: `合入提交不是两父合并（${parents.length} 个父提交）` };
    if (parents[1] !== head) return { sha: merge, reason: '合入提交的第二个父提交不是这个 head' };
    const tree = m?.tree?.sha, headTree = (await get(`/git/commits/${head}`))?.tree?.sha;
    if (!SHA.test(tree ?? '') || tree !== headTree) return { sha: merge, reason: `树不同（head ${headTree ?? '读不到'}，合入提交 ${tree ?? '读不到'}）` };
    return { sha: merge, tree, runs: await paged(get, `/commits/${merge}/check-runs?filter=all`, 'check_runs') };
  } catch (error) {
    return { sha: merge, reason: `读取失败：${error.message}` };
  }
}

// 一个候选 head：读 check-runs；一条检查都没有的（多提交推送的中间提交）返回 null。只要跑过任何检查就算 head：
// 对比检查一条都没出（如工作流改坏、作业名成了表达式原文）正是要报的“未知”，不能当中间提交跳过。
async function judgeHead(get, pins, { sha, prs, role, committedAt, mergeCommit, mergedAt }, nowMs) {
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
  // 只有最终 head、而且框架侧真缺某项（#292 钉了来源、head 上没有这条）时才按树读。
  const lacks = role === 'final' && pins !== null && PAIRS.some(p => pins.has(p.check) && !side(runs, p.check, pins.get(p.check)));
  const byTree = lacks ? await mergedTree(get, sha, mergeCommit) : null;
  const pairs = PAIRS.map(p => judge(p, runs, pins, role, byTree?.runs ? byTree : null, mergedAt, nowMs));
  const has = v => pairs.some(p => p.verdict === v);
  // 不一致 > 未知 > 在跑 > 跳过 > 一致：七项都比了且都一致才是一致 head。
  const verdict = has('不一致') ? '不一致' : has('未知') ? '未知' : has('在跑') ? '在跑' : has('跳过') ? '跳过' : '一致';
  return { sha, prs, role, at: beijing(atMs), atMs, verdict, pairs,
    ...(byTree ? { frameworkByTree: byTree.runs ? { sha: byTree.sha, tree: byTree.tree } : { sha: byTree.sha, reason: byTree.reason } } : {}) };
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
    // 已合入 PR 的最终 head 记下 PR 号（判据 X1）、合入提交（按树读）与合入时刻（刚合入的窗口，§8）。
    const facts = sha => ({ prs: [pull.number], role: roleOf(sha), mergedPrs: roleOf(sha) === 'final' ? [pull.number] : [],
      mergeCommit: roleOf(sha) === 'final' ? pull.merge_commit_sha ?? null : null,
      mergedAt: roleOf(sha) === 'final' ? pull.merged_at : null });
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
      seen.mergeCommit ??= c.mergeCommit;
      seen.mergedAt ??= c.mergedAt;
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
  // 连续段内（时间不早于段首；没有连续段时从最后一个已判定 head 起）框架结论未出的已合入 head（§8）：它们稍后可能变成不一致，
  // 有一个判据就不算达成。open PR 当前 head 的在跑不算。读不到时间的照算（偏严）。
  const segmentMs = n > 0 ? firstMs : decided.at(-1)?.atMs;
  const pendingMergedHeads = heads.filter(h => h.role === 'final' && h.verdict === '在跑' && !(h.atMs < segmentMs)).length;
  const unmet = [
    n < STREAK.heads && `连续一致不足 ${STREAK.heads} 个 head`,
    mergedPrs < STREAK.mergedPrs && `已合入 PR 不足 ${STREAK.mergedPrs} 个`,
    nonOwnerPushedHeads < STREAK.nonOwnerPushedHeads && '没有非 Owner 推送的 head',
    bothRedHeads < STREAK.bothRedHeads && '没有两边同红的 head',
    pendingMergedHeads > 0 && `连续段内有 ${pendingMergedHeads} 个已合入 head 的框架结论未出`,
  ].filter(Boolean);
  const hours = Math.round(spanMs / 360_000) / 10, days = Math.round(spanMs / 8640_000) / 10;
  const rule = `连续 ${STREAK.heads} 个 head、七项逐项一致；出自不少于 ${STREAK.mergedPrs} 个已合入 PR，`
    + `含至少 ${STREAK.nonOwnerPushedHeads} 个非 Owner 推送的 head、至少 ${STREAK.bothRedHeads} 个两边同红的 head`;
  const streak = { heads: n, hours, days, from: run[0]?.at ?? null, to: run.at(-1)?.at ?? null, mergedPrs, nonOwnerPushedHeads, bothRedHeads,
    met: unmet.length === 0, unmet, rule };
  const hostedGreenFrameworkRedLast20 = decided.slice(-LAST).flatMap(h => h.pairs).filter(p => p.direction === '框架红、托管绿').length;
  // 框架侧有项是从合入提交按树读的 head 数（修订 7）：让读的人一眼看到有多少不是 head 自己的结果。
  const frameworkByTreeHeads = heads.filter(h => h.pairs.some(p => p.frameworkFrom)).length;
  const mismatches = heads.flatMap(h => h.pairs.filter(p => p.verdict === '不一致').map(p => `${h.sha.slice(0, 7)} ${p.check} ${p.direction}`));
  const line = `影子对比 ${beijing(nowMs)}：${heads.length} 个 head（其中框架侧按树读 ${frameworkByTreeHeads} 个 head），一致 ${counts.一致}、不一致 ${counts.不一致}、未知 ${counts.未知}、在跑 ${counts.在跑}、跳过 ${counts.跳过}；`
    + `连续一致 ${n} 个 head / ${hours} 小时，已合入 PR ${mergedPrs} 个、非 Owner 推送 ${nonOwnerPushedHeads} 个、两边同红 ${bothRedHeads} 个、已合入未出结论 ${pendingMergedHeads} 个`
    + `（判据：${streak.met ? '已达' : `未达，${unmet.join('、')}`}）`
    + (mismatches.length ? `；不一致：${mismatches.join('；')}` : '');
  return { counts, streak, hostedGreenFrameworkRedLast20, frameworkByTreeHeads, pendingMergedHeads, line };
}

export async function compare({ repo = REPO, prs = null, heads = null, api = ghReader({ repo }), now = new Date().toISOString(), maxRequests = 5000 } = {}) {
  const get = limited(api, maxRequests);
  const pins = await readPins(get);
  const candidates = prs ? await candidatesOfPrs(get, prs)
    // 直接给的 head 视作当前 head：还没完成的判在跑。
    : heads.map(sha => ({ sha, prs: [], mergedPrs: [], role: 'current', committedAt: null }));
  const judged = [], nowMs = Date.parse(now);
  for (const c of candidates) {
    if (c.readError) {
      judged.push({ sha: c.sha, prs: c.prs, mergedPrs: c.mergedPrs, role: c.role, at: null, atMs: NaN, verdict: '未知',
        pairs: PAIRS.map(p => ({ check: p.check, verdict: '未知', reason: c.readError })) });
      continue;
    }
    const head = await judgeHead(get, pins, c, nowMs);
    if (!head) continue;
    // 推送者只对一致 head 读（连续一致段只由它们组成）。
    judged.push({ ...head, mergedPrs: c.mergedPrs, ...(head.verdict === '一致' ? { pushers: await pushersOf(get, c.sha) } : {}) });
  }
  // 按时间排（读不到时间的排最后，照样打断连续一致）；直接给 head 时保持给定顺序。
  if (prs) judged.sort((a, b) => (Number.isFinite(a.atMs) ? a.atMs : Infinity) - (Number.isFinite(b.atMs) ? b.atMs : Infinity) || a.sha.localeCompare(b.sha));
  const summary = summarize(judged, nowMs, repo.split('/')[0]);
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
