// 纯离线：GitHub 读取全部由录制路由替代，不发网络请求。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ghReader } from './retrigger-counter.mjs';
import { MAIN_RULESET_ID, PAIRS, compare, main } from './shadow-compare.mjs';

const FRAMEWORK_PINS = { 'ci-suites': 15368, 'clued-cloud-tests': 15368, 'migration-verify': 15368, 'ci-suites-windows': 15368,
  gitleaks: 5368905, trivy: 5368905, 'contract-placement': 5368905, 'kooyumi-work-admission': 5368905,
  'kooyumi-admission-verified': 5368905, 'kooyumi-merge-slot': 5368905 };
const HOSTED = { 'ci-suites': 'hosted-ci-suites', 'clued-cloud-tests': 'hosted-clued-cloud-tests', 'migration-verify': 'hosted-migration-verify',
  'ci-suites-windows': 'hosted-ci-suites-windows', gitleaks: 'hosted-gitleaks', trivy: 'hosted-trivy', 'contract-placement': 'hosted-contract-placement' };
const ruleset = (pins = FRAMEWORK_PINS) => ({ id: MAIN_RULESET_ID, rules: [{ type: 'deletion' }, { type: 'required_status_checks', parameters: {
  strict_required_status_checks_policy: true, required_status_checks: Object.entries(pins).map(([context, integration_id]) => ({ context, integration_id })) } }] });
const RULESET_ROUTE = `/rulesets/${MAIN_RULESET_ID}`;
const checksRoute = (sha, page = 1) => `/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`;
const sha = n => n.toString(16).padStart(40, '0');

let nextId = 1000;
function run(name, app, conclusion = 'success', { status = 'completed', started = '2026-11-23T01:00:00Z', completed = '2026-11-23T01:10:00Z', title = null, id } = {}) {
  return { id: id ?? nextId++, name, app: { id: app }, status, conclusion: status === 'completed' ? conclusion : null,
    started_at: started, completed_at: status === 'completed' ? completed : null, output: { title } };
}
// 一个 head 上两边八项全绿，另带无关检查；override(name, side) 返回 undefined 表示缺这一条，返回数组表示替换。
function greenRuns({ started = '2026-11-23T01:00:00Z', completed = '2026-11-23T01:10:00Z', hostedCompleted = '2026-11-23T01:12:00Z', override = () => null } = {}) {
  const runs = [run('admission-gate', 15368), run('kooyumi-merge-slot', 5368905)];
  for (const check of [...Object.keys(HOSTED), 'kooyumi-admission-verified']) {
    const sides = {
      framework: [run(check, FRAMEWORK_PINS[check], 'success', { started, completed })],
      hosted: [check === 'kooyumi-admission-verified' ? run(check, 5164952, 'success', { started, completed: hostedCompleted })
        : run(HOSTED[check], 15368, 'success', { started, completed: hostedCompleted })],
    };
    for (const side of ['framework', 'hosted']) {
      const replaced = override(check, side);
      if (replaced === undefined) continue;
      runs.push(...(replaced ?? sides[side]));
    }
  }
  return runs;
}
const page = runs => ({ total_count: runs.length, check_runs: runs });
function api(routes) {
  const calls = [];
  return { calls, async get(route) {
    calls.push(route);
    assert.ok(Object.hasOwn(routes, route), `未录制 API 请求：${route}`);
    if (routes[route]?.error) throw new Error(routes[route].error);
    return structuredClone(routes[route]);
  } };
}
const headRoutes = (entries, rs = ruleset()) => ({ [RULESET_ROUTE]: rs, ...Object.fromEntries(entries.map(([s, runs]) => [checksRoute(s), page(runs)])) });
const pairOf = (head, check) => head.pairs.find(p => p.check === check);
const NOW = '2026-12-10T00:00:00+08:00';

test('对比的是托管八项：七项 hosted- 钉 Actions，准入同名钉 App 5164952', () => {
  assert.deepEqual(PAIRS.map(p => [p.check, p.hosted.name, p.hosted.app]), [
    ...Object.entries(HOSTED).map(([check, hosted]) => [check, hosted, 15368]), ['kooyumi-admission-verified', 'kooyumi-admission-verified', 5164952]]);
});

test('两边八项结论相同判一致，记完成时刻差，框架侧来源从 #292 读', async () => {
  const s = sha(1);
  const report = await compare({ heads: [s], api: api(headRoutes([[s, greenRuns()]])), now: NOW });
  assert.equal(report.heads.length, 1);
  const [head] = report.heads;
  assert.equal(head.verdict, '一致');
  assert.equal(head.pairs.length, 8);
  for (const pair of head.pairs) {
    assert.equal(pair.verdict, '一致', pair.check);
    assert.equal(pair.completionDeltaSeconds, 120);
    assert.equal(pair.frameworkReruns, 0);
  }
  assert.equal(pairOf(head, 'gitleaks').framework.app, 5368905);
  assert.equal(pairOf(head, 'ci-suites').framework.app, 15368);
  assert.equal(head.at, '2026-11-23T09:00:00+08:00');
  assert.deepEqual(report.summary.counts, { 一致: 1, 不一致: 0, 未知: 0, 在跑: 0, 跳过: 0 });
});

test('结论不一致必须报出并归因：框架红托管绿、托管红框架绿', async () => {
  const s = sha(2);
  const runs = greenRuns({ override: (check, side) => {
    if (check === 'ci-suites' && side === 'framework') return [run('ci-suites', 15368, 'failure', { title: 'ci-suites: 2 failed' })];
    if (check === 'trivy' && side === 'hosted') return [run('hosted-trivy', 15368, 'failure', { title: 'CVE found' })];
    return null;
  } });
  const report = await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW });
  const [head] = report.heads;
  assert.equal(head.verdict, '不一致');
  assert.equal(pairOf(head, 'ci-suites').verdict, '不一致');
  assert.equal(pairOf(head, 'ci-suites').reason, '框架红、托管绿：ci-suites: 2 failed');
  assert.equal(pairOf(head, 'trivy').verdict, '不一致');
  assert.equal(pairOf(head, 'trivy').reason, '托管红、框架绿：CVE found');
  assert.equal(pairOf(head, 'gitleaks').verdict, '一致');
  assert.equal(report.summary.counts.不一致, 1);
  assert.equal(report.summary.hostedGreenFrameworkRedLast20, 1);
  assert.equal(report.summary.streak.heads, 0);
  assert.match(report.summary.line, /不一致：0{7} ci-suites 框架红、托管绿/);
});

// 最终 head（已合入 PR 的 head）按严格口径判；prRoutes 在下方定义，调用时已就绪。
const finalHead = async (s, runs) => (await compare({ prs: { from: 1900, to: 1900 },
  api: api(prRoutes([{ number: 1900, state: 'closed', merged: true, commits: [{ sha: s }] }], { [s]: runs })), now: NOW })).heads[0];

test('一边缺检查：最终 head 判未知；当前 head 判在跑；都不判一致', async () => {
  const s = sha(3);
  const runs = greenRuns({ override: (check, side) => (check === 'trivy' && side === 'hosted') || (check === 'gitleaks' && side === 'framework') ? undefined : null });
  const [current] = (await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW })).heads;
  assert.equal(current.verdict, '在跑');
  assert.equal(pairOf(current, 'trivy').reason, '托管缺检查');
  const head = await finalHead(s, runs);
  assert.equal(head.role, 'final');
  assert.equal(head.verdict, '未知');
  assert.equal(pairOf(head, 'trivy').verdict, '未知');
  assert.equal(pairOf(head, 'trivy').reason, '托管缺检查');
  assert.equal(pairOf(head, 'gitleaks').verdict, '未知');
  assert.equal(pairOf(head, 'gitleaks').reason, '框架缺检查');
});

test('同名不同来源不算数：准入只认各自的 App，hosted- 只认 Actions', async () => {
  const s = sha(4);
  const runs = greenRuns({ override: (check, side) => {
    // 托管准入不在：5164952 没发；常驻 5368905 发的同名检查不能顶替托管那一边。
    if (check === 'kooyumi-admission-verified' && side === 'hosted') return undefined;
    // 托管 gitleaks 由别的 App 发：不是托管检查。
    if (check === 'gitleaks' && side === 'hosted') return [run('hosted-gitleaks', 5368905)];
    return null;
  } });
  const head = await finalHead(s, runs);
  assert.equal(pairOf(head, 'kooyumi-admission-verified').reason, '托管缺检查');
  assert.equal(pairOf(head, 'gitleaks').reason, '托管缺检查');
  assert.equal(head.verdict, '未知');
});

test('托管准入红、框架准入绿：同名两条按来源分开比', async () => {
  const s = sha(5);
  const runs = greenRuns({ override: (check, side) => check === 'kooyumi-admission-verified' && side === 'hosted'
    ? [run('kooyumi-admission-verified', 5164952, 'failure', { title: 'Grant missing' })] : null });
  const [head] = (await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW })).heads;
  assert.equal(pairOf(head, 'kooyumi-admission-verified').verdict, '不一致');
  assert.equal(pairOf(head, 'kooyumi-admission-verified').framework.conclusion, 'success');
  assert.equal(pairOf(head, 'kooyumi-admission-verified').hosted.conclusion, 'failure');
});

test('读 check-runs 失败判未知（读取失败），不判一致', async () => {
  const s = sha(6);
  const report = await compare({ heads: [s], api: api({ [RULESET_ROUTE]: ruleset(), [checksRoute(s)]: { error: 'gh GET 失败（退出码 1）' } }), now: NOW });
  const [head] = report.heads;
  assert.equal(head.verdict, '未知');
  assert.ok(head.pairs.every(p => p.verdict === '未知' && p.reason.startsWith('读取失败')), JSON.stringify(head.pairs));
  assert.equal(report.summary.counts.一致, 0);
});

test('#292 读不到时框架侧来源不明，全部判未知', async () => {
  const s = sha(7);
  const report = await compare({ heads: [s], api: api({ [RULESET_ROUTE]: { error: 'gh GET 失败（退出码 1）' }, [checksRoute(s)]: page(greenRuns()) }), now: NOW });
  assert.equal(report.ruleset.readable, false);
  assert.ok(report.heads[0].pairs.every(p => p.verdict === '未知' && p.reason === '#292 读不到，框架侧来源不明'));
});

test('#292 里没钉的检查判未知', async () => {
  const s = sha(8);
  const pins = { ...FRAMEWORK_PINS };
  delete pins.trivy;
  const [head] = (await compare({ heads: [s], api: api(headRoutes([[s, greenRuns()]], ruleset(pins))), now: NOW })).heads;
  assert.equal(pairOf(head, 'trivy').verdict, '未知');
  assert.equal(pairOf(head, 'trivy').reason, 'trivy 未在 #292 钉住来源');
  assert.equal(pairOf(head, 'gitleaks').verdict, '一致');
});

test('分页不完整判读取失败', async () => {
  const s = sha(9);
  const routes = { [RULESET_ROUTE]: ruleset(), [checksRoute(s)]: { total_count: 150, check_runs: greenRuns() } };
  const [head] = (await compare({ heads: [s], api: api(routes), now: NOW })).heads;
  assert.equal(head.verdict, '未知');
  assert.match(pairOf(head, 'ci-suites').reason, /^读取失败/);
});

test('分页：第二页的检查也读进来', async () => {
  const s = sha(10);
  const filler = Array.from({ length: 100 }, () => run('runner-heartbeat / x', 15368));
  const all = [...filler, ...greenRuns()];
  const routes = { [RULESET_ROUTE]: ruleset(), [checksRoute(s, 1)]: { total_count: all.length, check_runs: all.slice(0, 100) },
    [checksRoute(s, 2)]: { total_count: all.length, check_runs: all.slice(100) } };
  const [head] = (await compare({ heads: [s], api: api(routes), now: NOW })).heads;
  assert.equal(head.verdict, '一致');
});

test('重跑：取最新一条，记框架侧重跑次数', async () => {
  const s = sha(11);
  const runs = greenRuns({ override: (check, side) => check === 'clued-cloud-tests' && side === 'framework'
    ? [run('clued-cloud-tests', 15368, 'failure', { id: 50 }), run('clued-cloud-tests', 15368, 'success', { id: 60 })] : null });
  const [head] = (await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW })).heads;
  const pair = pairOf(head, 'clued-cloud-tests');
  assert.equal(pair.verdict, '一致');
  assert.equal(pair.frameworkReruns, 1);
  assert.equal(pair.framework.runs, 2);
});

test('取消判未知（没有结论）', async () => {
  const s = sha(12);
  const runs = greenRuns({ override: (check, side) => check === 'migration-verify' && side === 'hosted' ? [run('hosted-migration-verify', 15368, 'cancelled')] : null });
  const [head] = (await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW })).heads;
  assert.equal(pairOf(head, 'migration-verify').verdict, '未知');
  assert.equal(pairOf(head, 'migration-verify').reason, '托管无结论（cancelled）');
});

test('还在跑：当前 head 判在跑，不是当前 head 判未知', async () => {
  const s = sha(13);
  const runs = greenRuns({ override: (check, side) => check === 'ci-suites-windows' && side === 'hosted' ? [run('hosted-ci-suites-windows', 15368, null, { status: 'in_progress' })] : null });
  const current = (await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW })).heads[0];
  assert.equal(current.verdict, '在跑');
  assert.equal(pairOf(current, 'ci-suites-windows').verdict, '在跑');
});

// PR 范围：列 PR、读每个 PR 的提交，没有任何对比检查的中间提交不算 head。
function prRoutes(prs, checks, rs = ruleset()) {
  const routes = { [RULESET_ROUTE]: rs };
  routes['/pulls?state=all&sort=created&direction=desc&per_page=100&page=1'] = prs.map(p => ({ number: p.number, state: p.state,
    merged_at: p.merged ? '2026-11-26T00:00:00Z' : null, head: { sha: p.commits.at(-1).sha } }));
  for (const p of prs) routes[`/pulls/${p.number}/commits?per_page=100&page=1`] = p.commits.map(c => ({ sha: c.sha, commit: { committer: { date: c.date } } }));
  for (const [s, runs] of Object.entries(checks)) routes[checksRoute(s)] = page(runs);
  return routes;
}

test('PR 范围：没有任何检查的中间提交不算 head；有检查但名字都不对的最终 head 判未知，不漏掉；被取代 head 的未完成判跳过', async () => {
  const a = sha(21), b = sha(22), c = sha(23), d = sha(24), e = sha(25), f = sha(26);
  const pending = greenRuns({ started: '2026-11-24T01:00:00Z', completed: '2026-11-24T01:10:00Z', hostedCompleted: '2026-11-24T01:12:00Z',
    override: (check, side) => check === 'trivy' && side === 'framework' ? [run('trivy', 5368905, null, { status: 'queued', started: '2026-11-24T01:00:00Z' })] : null });
  const routes = prRoutes([
    { number: 1302, state: 'open', commits: [{ sha: c, date: '2026-11-24T01:00:00Z' }, { sha: d, date: '2026-11-25T01:00:00Z' }] },
    { number: 1301, state: 'closed', commits: [{ sha: a, date: '2026-11-23T00:00:00Z' }, { sha: b, date: '2026-11-23T00:30:00Z' }] },
    { number: 1300, state: 'closed', merged: true, commits: [{ sha: e, date: '2026-11-22T00:00:00Z' }, { sha: f, date: '2026-11-22T01:00:00Z' }] },
  ], { [a]: [], [b]: greenRuns(), [c]: pending,
    [d]: greenRuns({ started: '2026-11-25T01:00:00Z', completed: '2026-11-25T01:10:00Z', hostedCompleted: '2026-11-25T01:12:00Z' }),
    // 工作流改坏、作业名成了表达式原文（#1230 实况）：这一 head 真跑过，必须报出来。
    [e]: [], [f]: [run("needs.admission-gate.outputs.admitted == 'true' && 'ci-suites' || 'ci-suites-skipped'", 15368, 'success', { started: '2026-11-22T01:00:00Z' })] });
  routes['/pulls?state=all&sort=created&direction=desc&per_page=100&page=1'].unshift({ number: 1303, state: 'open', head: { sha: sha(99) } });
  const report = await compare({ prs: { from: 1300, to: 1302 }, api: api(routes), now: NOW });
  assert.deepEqual(report.heads.map(h => [h.sha, h.prs, h.verdict]), [[f, [1300], '未知'], [b, [1301], '一致'], [c, [1302], '跳过'], [d, [1302], '一致']]);
  assert.ok(report.heads[0].pairs.every(p => p.reason === '两边都缺检查'));
  assert.equal(report.heads[0].at, '2026-11-22T09:00:00+08:00');
  assert.equal(pairOf(report.heads[2], 'trivy').verdict, '跳过');
  assert.equal(pairOf(report.heads[2], 'trivy').reason, '框架未完成（queued），已被取代');
  assert.equal(pairOf(report.heads[2], 'ci-suites').verdict, '一致');
  assert.equal(report.summary.counts.跳过, 1);
});

test('PR 提交列表读不到：当前 head 判未知，不漏掉', async () => {
  const s = sha(31);
  const routes = { [RULESET_ROUTE]: ruleset(), '/pulls?state=all&sort=created&direction=desc&per_page=100&page=1': [{ number: 1400, state: 'open', head: { sha: s } }],
    '/pulls/1400/commits?per_page=100&page=1': { error: 'gh GET 失败（退出码 1）' } };
  const report = await compare({ prs: { from: 1400, to: 1400 }, api: api(routes), now: NOW });
  assert.equal(report.heads.length, 1);
  assert.equal(report.heads[0].verdict, '未知');
  assert.match(report.heads[0].pairs[0].reason, /^读取失败/);
});

// 被取代 head（丙，FABLE-shadow-superseded-20261122）：两侧都有红/绿终态就照常比，比不了判跳过（不计数、不打断）。
// 当前 head 缺检查或未完成判在跑；最终 head（已合入 PR 的 head）保持严格口径。
const at = (day, hour = 1) => `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const runsAt = (t, override) => greenRuns({ started: t, completed: t, hostedCompleted: t, ...(override ? { override } : {}) });
const frameworkCancelled = (name, t) => (check, side) => check === name && side === 'framework'
  ? [run(name, FRAMEWORK_PINS[name], 'cancelled', { started: t, completed: t })] : null;
const frameworkRed = (name, t) => (check, side) => check === name && side === 'framework'
  ? [run(name, FRAMEWORK_PINS[name], 'failure', { started: t, completed: t, title: `${name} red` })] : null;
const verdicts = report => report.heads.map(h => h.verdict);

test('U1 被取代 head 框架项 cancelled：判跳过，连续计数不断', async () => {
  const [a, b, y, z] = [sha(201), sha(202), sha(203), sha(204)];
  const routes = prRoutes([{ number: 1600, state: 'open', commits: [{ sha: a }, { sha: b }, { sha: y }, { sha: z }] }],
    { [a]: runsAt(at(23)), [b]: runsAt(at(23, 2)), [y]: runsAt(at(23, 3), frameworkCancelled('ci-suites', at(23, 3))), [z]: runsAt(at(23, 4)) });
  const report = await compare({ prs: { from: 1600, to: 1600 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['一致', '一致', '跳过', '一致']);
  assert.equal(pairOf(report.heads[2], 'ci-suites').verdict, '跳过');
  assert.equal(pairOf(report.heads[2], 'ci-suites').reason, '框架无结论（cancelled），已被取代');
  assert.equal(report.summary.streak.heads, 3);
  assert.equal(report.summary.counts.跳过, 1);
});

test('U2 被取代 head 框架八项全缺但有别的检查：判跳过，不判未知', async () => {
  const [x, y] = [sha(211), sha(212)];
  const routes = prRoutes([{ number: 1610, state: 'open', commits: [{ sha: x }, { sha: y }] }],
    { [x]: runsAt(at(23), (_check, side) => side === 'framework' ? undefined : null), [y]: runsAt(at(23, 2)) });
  const report = await compare({ prs: { from: 1610, to: 1610 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['跳过', '一致']);
  assert.ok(report.heads[0].pairs.every(p => p.verdict === '跳过' && p.reason === '框架缺检查，已被取代'), JSON.stringify(report.heads[0].pairs));
  assert.equal(report.summary.streak.heads, 1);
});

test('U3 被取代 head 框架项 queued：判跳过', async () => {
  const [x, y] = [sha(221), sha(222)];
  const routes = prRoutes([{ number: 1620, state: 'open', commits: [{ sha: x }, { sha: y }] }],
    { [x]: runsAt(at(23), (check, side) => check === 'trivy' && side === 'framework' ? [run('trivy', 5368905, null, { status: 'queued', started: at(23) })] : null),
      [y]: runsAt(at(23, 2)) });
  const report = await compare({ prs: { from: 1620, to: 1620 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['跳过', '一致']);
  assert.equal(pairOf(report.heads[0], 'trivy').reason, '框架未完成（queued），已被取代');
});

test('U4 open PR 当前 head 框架七项未出、准入已出：判在跑，前面的连续计数保留（#1230 实况）', async () => {
  const [m, p, q] = [sha(231), sha(232), sha(233)];
  const pendingCurrent = (check, side) => {
    if (check === 'kooyumi-admission-verified') return null;
    return side === 'framework' ? undefined : [run(HOSTED[check], 15368, null, { status: 'queued', started: at(23, 3) })];
  };
  const routes = prRoutes([
    { number: 1631, state: 'open', commits: [{ sha: p }, { sha: q }] },
    { number: 1630, state: 'closed', merged: true, commits: [{ sha: m }] },
  ], { [m]: runsAt(at(23)), [p]: runsAt(at(23, 2)), [q]: runsAt(at(23, 3), pendingCurrent) });
  const report = await compare({ prs: { from: 1630, to: 1631 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['一致', '一致', '在跑']);
  assert.equal(pairOf(report.heads[2], 'ci-suites').verdict, '在跑');
  assert.equal(pairOf(report.heads[2], 'kooyumi-admission-verified').verdict, '一致');
  assert.equal(report.summary.streak.heads, 2);
});

test('U5 已关闭未合入 PR 的最后一个 head 框架缺检查：判跳过', async () => {
  const x = sha(241);
  const routes = prRoutes([{ number: 1640, state: 'closed', commits: [{ sha: x }] }],
    { [x]: runsAt(at(23), (check, side) => check === 'gitleaks' && side === 'framework' ? undefined : null) });
  const report = await compare({ prs: { from: 1640, to: 1640 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['跳过']);
  assert.equal(pairOf(report.heads[0], 'gitleaks').reason, '框架缺检查，已被取代');
});

test('U6 30 个一致 head 跨 7 天以上、中间夹着跳过的 head：达标，summary.line 含跳过数', async () => {
  const commits = [], checks = {};
  for (let i = 0; i < 34; i++) {
    const s = sha(300 + i), t = new Date(Date.parse(at(23)) + i * 6 * 3600_000).toISOString().replace('.000Z', 'Z');
    commits.push({ sha: s });
    checks[s] = runsAt(t, i % 8 === 4 ? frameworkCancelled('trivy', t) : undefined);
  }
  const report = await compare({ prs: { from: 1650, to: 1650 }, api: api(prRoutes([{ number: 1650, state: 'open', commits }], checks)), now: NOW });
  assert.equal(report.summary.counts.跳过, 4);
  assert.equal(report.summary.counts.一致, 30);
  assert.equal(report.summary.streak.heads, 30);
  assert.equal(report.summary.streak.met, true);
  assert.match(report.summary.line, /跳过 4/);
});

test('U7 被取代 head 两侧都有终态而且不一致：判不一致并打断计数', async () => {
  const [a, x, y] = [sha(251), sha(252), sha(253)];
  const routes = prRoutes([{ number: 1660, state: 'open', commits: [{ sha: a }, { sha: x }, { sha: y }] }],
    { [a]: runsAt(at(23)), [x]: runsAt(at(23, 2), frameworkRed('gitleaks', at(23, 2))), [y]: runsAt(at(23, 3)) });
  const report = await compare({ prs: { from: 1660, to: 1660 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['一致', '不一致', '一致']);
  assert.equal(pairOf(report.heads[1], 'gitleaks').direction, '框架红、托管绿');
  assert.equal(report.summary.streak.heads, 1);
});

test('U8 被取代 head 一项比出不一致、另一项 cancelled：整个 head 判不一致，不判跳过', async () => {
  const [x, y] = [sha(261), sha(262)];
  const t = at(23);
  const override = (check, side) => frameworkRed('gitleaks', t)(check, side) ?? frameworkCancelled('trivy', t)(check, side);
  const routes = prRoutes([{ number: 1670, state: 'open', commits: [{ sha: x }, { sha: y }] }], { [x]: runsAt(t, override), [y]: runsAt(at(23, 2)) });
  const report = await compare({ prs: { from: 1670, to: 1670 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['不一致', '一致']);
  assert.equal(pairOf(report.heads[0], 'trivy').verdict, '跳过');
});

test('U9 被取代 head 八项都比了而且一致：计入连续计数', async () => {
  const [x, y] = [sha(271), sha(272)];
  const routes = prRoutes([{ number: 1680, state: 'open', commits: [{ sha: x }, { sha: y }] }], { [x]: runsAt(at(23)), [y]: runsAt(at(23, 2)) });
  const report = await compare({ prs: { from: 1680, to: 1680 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['一致', '一致']);
  assert.equal(report.summary.streak.heads, 2);
});

test('U10 已合入 PR 的最终 head 框架项 cancelled 或缺检查：仍判未知并打断计数', async () => {
  const [a, f1, b, f2, c] = [sha(281), sha(282), sha(283), sha(284), sha(285)];
  const routes = prRoutes([
    { number: 1692, state: 'open', commits: [{ sha: c }] },
    { number: 1691, state: 'closed', merged: true, commits: [{ sha: b }, { sha: f2 }] },
    { number: 1690, state: 'closed', merged: true, commits: [{ sha: a }, { sha: f1 }] },
  ], { [a]: runsAt(at(23)), [f1]: runsAt(at(23, 2), frameworkCancelled('ci-suites', at(23, 2))), [b]: runsAt(at(23, 3)),
    [f2]: runsAt(at(23, 4), (check, side) => check === 'trivy' && side === 'framework' ? undefined : null), [c]: runsAt(at(23, 5)) });
  const report = await compare({ prs: { from: 1690, to: 1692 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['一致', '未知', '一致', '未知', '一致']);
  assert.equal(pairOf(report.heads[1], 'ci-suites').reason, '框架无结论（cancelled）');
  assert.equal(pairOf(report.heads[3], 'trivy').reason, '框架缺检查');
  assert.equal(report.summary.streak.heads, 1);
});

test('U11 同一 sha 在 PR A 里被取代、在 PR B 里是当前：按当前判，未完成判在跑', async () => {
  const [s, later] = [sha(291), sha(292)];
  const routes = prRoutes([
    { number: 1701, state: 'open', commits: [{ sha: s }] },
    { number: 1700, state: 'open', commits: [{ sha: s }, { sha: later }] },
  ], { [s]: runsAt(at(23), (check, side) => check === 'trivy' && side === 'framework'
    ? [run('trivy', 5368905, null, { status: 'in_progress', started: at(23) })] : null),
  [later]: runsAt(at(23, 2)) });
  const report = await compare({ prs: { from: 1700, to: 1701 }, api: api(routes), now: NOW });
  const head = report.heads.find(h => h.sha === s);
  assert.deepEqual(head.prs, [1700, 1701]);
  assert.equal(head.verdict, '在跑');
  assert.equal(pairOf(head, 'trivy').verdict, '在跑');
});

// 连续一致：S6 退出判据（连续 30 个 head 且不少于 7 天）。
async function streakOf(verdicts, spanHours) {
  const entries = verdicts.map((v, i) => {
    const t = new Date(Date.parse('2026-11-23T00:00:00Z') + Math.round(i * spanHours * 3600_000 / (verdicts.length - 1))).toISOString().replace('.000Z', 'Z');
    const runs = greenRuns({ started: t, completed: t, hostedCompleted: t,
      override: (check, side) => v === 'bad' && check === 'gitleaks' && side === 'framework' ? [run('gitleaks', 5368905, 'failure', { started: t, completed: t })] : null });
    return [sha(1000 + i), runs];
  });
  return (await compare({ heads: entries.map(e => e[0]), api: api(headRoutes(entries)), now: NOW })).summary.streak;
}

test('连续 30 个一致且跨 7 天以上：达标', async () => {
  const streak = await streakOf(Array(30).fill('ok'), 8 * 24);
  assert.equal(streak.heads, 30);
  assert.equal(streak.met, true);
  assert.equal(streak.days, 8);
});

test('30 个一致但不满 7 天：未达标', async () => {
  const streak = await streakOf(Array(30).fill('ok'), 6 * 24);
  assert.equal(streak.heads, 30);
  assert.equal(streak.met, false);
});

test('中间一个不一致：连续计数从它之后重新算', async () => {
  const verdicts = Array(40).fill('ok');
  verdicts[15] = 'bad';
  const streak = await streakOf(verdicts, 10 * 24);
  assert.equal(streak.heads, 24);
  assert.equal(streak.met, false);
});

test('命令行：参数错退出 2；正常一行 JSON 退出 0；读不到 PR 列表输出 error 退出 1', async () => {
  const lines = [];
  const write = line => lines.push(line);
  assert.equal(await main(['--bogus'], { api: api({}), write }), 2);
  assert.equal(JSON.parse(lines.pop()).status, 'error');
  assert.equal(await main([], { api: api({}), write }), 2);
  lines.length = 0;
  const s = sha(41);
  assert.equal(await main(['--head', s], { api: api(headRoutes([[s, greenRuns()]])), write, now: NOW }), 0);
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.equal(report.status, 'ok');
  assert.equal(report.heads[0].verdict, '一致');
  lines.length = 0;
  assert.equal(await main(['--prs', '1500-'], { api: api({ [RULESET_ROUTE]: ruleset(), '/pulls?state=all&sort=created&direction=desc&per_page=100&page=1': { error: 'x' } }), write, now: NOW }), 1);
  assert.equal(JSON.parse(lines[0]).status, 'error');
});

test('只读：默认读取走 retrigger-counter 的 ghReader，不另开 GitHub 入口', () => {
  const source = readFileSync(new URL('./shadow-compare.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ ghReader \} from '\.\/retrigger-counter\.mjs'/);
  assert.doesNotMatch(source, /child_process|fetch\(|--method|POST|PATCH|PUT|DELETE/);
  assert.equal(typeof ghReader, 'function');
});
