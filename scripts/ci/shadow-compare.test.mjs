// 纯离线：GitHub 读取全部由录制路由替代，不发网络请求。
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghReader } from './retrigger-counter.mjs';
import { MAIN_RULESET_ID, PAIRS, compare, main } from './shadow-compare.mjs';
import * as shadow from './shadow-compare.mjs';

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
// suite：所在的 check suite（同一次运行）；不给就不带 check_suite。
function run(name, app, conclusion = 'success', { status = 'completed', started = '2026-11-23T01:00:00Z', completed = '2026-11-23T01:10:00Z', title = null, id, suite } = {}) {
  return { id: id ?? nextId++, name, app: { id: app }, status, conclusion: status === 'completed' ? conclusion : null,
    started_at: started, completed_at: status === 'completed' ? completed : null, output: { title }, ...(suite ? { check_suite: { id: suite } } : {}) };
}
// 一个 head 上两边七项全绿，另带无关检查（含两边的准入，它们不在比对里）；override(name, side) 返回 undefined 表示缺这一条，返回数组表示替换。
// 无关检查与对比检查同时开始；准入（kooyumi-work-admission）开始后 admissionMinutes 分钟完成（null：没有这条）。
const plusMinutes = (t, minutes) => new Date(Date.parse(t) + minutes * 60_000).toISOString().replace('.000Z', 'Z');
function greenRuns({ started = '2026-11-23T01:00:00Z', completed = '2026-11-23T01:10:00Z', hostedCompleted = '2026-11-23T01:12:00Z', admissionMinutes = 1,
  override = () => null } = {}) {
  const at = { started, completed: started };
  const runs = [run('admission-gate', 15368, 'success', at), run('kooyumi-merge-slot', 5368905, 'success', at),
    ...(admissionMinutes === null ? [] : [run('kooyumi-work-admission', 5368905, 'success', { started, completed: plusMinutes(started, admissionMinutes) })]),
    run('kooyumi-main-merge', 5164952, 'success', at)];
  for (const check of Object.keys(HOSTED)) {
    const sides = {
      framework: [run(check, FRAMEWORK_PINS[check], 'success', { started, completed })],
      hosted: [run(HOSTED[check], 15368, 'success', { started, completed: hostedCompleted })],
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

test('对比的是托管七项：hosted- 钉 Actions；准入与框架同源，不比', () => {
  assert.deepEqual(PAIRS.map(p => [p.check, p.hosted.name, p.hosted.app]), Object.entries(HOSTED).map(([check, hosted]) => [check, hosted, 15368]));
  assert.ok(!PAIRS.some(p => /admission/.test(p.check)));
});

test('两边七项结论相同判一致，记完成时刻差，框架侧来源从 #292 读', async () => {
  const s = sha(1);
  const report = await compare({ heads: [s], api: api(headRoutes([[s, greenRuns()]])), now: NOW });
  assert.equal(report.heads.length, 1);
  const [head] = report.heads;
  assert.equal(head.verdict, '一致');
  assert.equal(head.pairs.length, 7);
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

test('同名不同来源不算数：hosted- 只认 Actions', async () => {
  const s = sha(4);
  // 托管 gitleaks 由别的 App 发：不是托管检查。
  const runs = greenRuns({ override: (check, side) => check === 'gitleaks' && side === 'hosted' ? [run('hosted-gitleaks', 5368905)] : null });
  const head = await finalHead(s, runs);
  assert.equal(pairOf(head, 'gitleaks').reason, '托管缺检查');
  assert.equal(head.verdict, '未知');
});

test('准入不在比对里：5164952 只发 kooyumi-main-merge、准入红或缺都不影响一致（第八对已删）', async () => {
  const s = sha(5);
  const runs = [...greenRuns(), run('kooyumi-admission-verified', 5164952, 'failure', { title: 'Grant missing' })];
  const head = await finalHead(s, runs);
  assert.equal(head.verdict, '一致');
  assert.equal(pairOf(head, 'kooyumi-admission-verified'), undefined);
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
    merged_at: p.merged ? '2026-11-26T00:00:00Z' : null, head: { sha: p.commits.at(-1).sha }, user: { login: p.user ?? 'tdoljyj' } }));
  for (const p of prs) routes[`/pulls/${p.number}/commits?per_page=100&page=1`] = p.commits.map(c => ({ sha: c.sha,
    author: { login: c.author ?? 'tdoljyj' }, commit: { committer: { date: c.date } } }));
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
const runsAt = (t, override, admissionMinutes = 1) => greenRuns({ started: t, completed: t, hostedCompleted: t, admissionMinutes, ...(override ? { override } : {}) });
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

test('U2 被取代 head 框架七项全缺但有别的检查：判跳过，不判未知', async () => {
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
  const pendingCurrent = (check, side) => side === 'framework' ? undefined : [run(HOSTED[check], 15368, null, { status: 'queued', started: at(23, 3) })];
  const routes = prRoutes([
    { number: 1631, state: 'open', commits: [{ sha: p }, { sha: q }] },
    { number: 1630, state: 'closed', merged: true, commits: [{ sha: m }] },
  ], { [m]: runsAt(at(23)), [p]: runsAt(at(23, 2)), [q]: runsAt(at(23, 3), pendingCurrent) });
  const report = await compare({ prs: { from: 1630, to: 1631 }, api: api(routes), now: NOW });
  assert.deepEqual(verdicts(report), ['一致', '一致', '在跑']);
  assert.equal(pairOf(report.heads[2], 'ci-suites').verdict, '在跑');
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

test('U6 30 个一致 head 跨 7 天以上、中间夹着跳过的 head：跳过不打断，summary.line 含跳过数；全出自一个 open PR，判据未达', async () => {
  const commits = [], checks = {};
  for (let i = 0; i < 34; i++) {
    const s = sha(300 + i), t = new Date(Date.parse(at(23)) + i * 6 * 3600_000).toISOString().replace('.000Z', 'Z');
    commits.push({ sha: s });
    checks[s] = runsAt(t, i % 8 === 4 ? frameworkCancelled('trivy', t) : undefined);
  }
  const routes = prRoutes([{ number: 1650, state: 'open', commits }], checks);
  const report = await compare({ prs: { from: 1650, to: 1650 }, api: api(withCleanBypass(routes, NOW)), now: NOW });
  assert.equal(report.summary.counts.跳过, 4);
  assert.equal(report.summary.counts.一致, 30);
  assert.equal(report.summary.streak.heads, 30);
  assert.equal(report.summary.streak.met, false);
  assert.deepEqual(report.summary.streak.unmet, ['已合入 PR 不足 10 个', '没有非 Owner 推送的 head', '没有两边同红的 head']);
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

test('U9 被取代 head 七项都比了而且一致：计入连续计数', async () => {
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

// 同一运行里先有取消、红检查之后才开始：这一侧无结论（FABLE-shadow-superseded-head-20261124 §R2）。
// 现场夹具是 gh api GET /commits/<sha>/check-runs?filter=all 原样抓下的（2026-11-24 04:34 北京时间），同一次运行的检查共用一个 suite。
// 抓取时 #292 把七项都钉在 15368（Actions），回放按这个钉。
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).check_runs;
const LIVE_PINS = { ...FRAMEWORK_PINS, gitleaks: 15368, trivy: 15368, 'contract-placement': 15368 };
const H68 = '68a6c5ea27c4a513be02edd5b28e52a9dd7b00f2', H148 = '148bd3019e4cda3fceacf0d4226b735557957340';
const H68_SECOND_RUN = 122140218620; // 68a6c5e 第二次托管运行：gitleaks 16:05:51 真失败，16:10:57 起其余被取消
const FAIL_CONCLUSION = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const bothRed = head => head.pairs.filter(p => p.verdict === '一致' && FAIL_CONCLUSION.has(p.framework?.conclusion) && FAIL_CONCLUSION.has(p.hosted?.conclusion)).map(p => p.check);
// 被取代 head 回放：同一 PR 里后面再跟一个没有检查的提交，让它成为被取代的 head。
async function superseded(number, s, runs, pins = LIVE_PINS) {
  const tail = sha(number);
  const report = await compare({ prs: { from: number, to: number },
    api: api(prRoutes([{ number, state: 'open', commits: [{ sha: s }, { sha: tail }] }], { [s]: runs, [tail]: [] }, ruleset(pins))), now: NOW });
  assert.equal(report.heads.length, 1);
  assert.equal(report.heads[0].role, 'superseded');
  return report.heads[0];
}
// 块 4 的形状：68a6c5e 第二次托管运行里 Windows 四片 16:10:57 被取消，汇总 hosted-ci-suites-windows 16:11:05 开始、读到 cancelled 失败。
function block4Shape(frameworkWindows = 'success') {
  const runs = fixture('shadow-head-68a6c5e.json').filter(r => !(r.name === 'hosted-ci-suites-windows' && r.check_suite.id === H68_SECOND_RUN));
  const base = { app: { id: 15368 }, status: 'completed', output: { title: null }, check_suite: { id: H68_SECOND_RUN } };
  for (const i of [1, 2, 3, 4]) runs.push({ ...base, id: 137561774600 + i, name: `hosted-ci-suites-windows-shard-${i}`, conclusion: 'cancelled',
    started_at: '2026-11-23T08:05:31Z', completed_at: '2026-11-23T08:10:57Z' });
  runs.push({ ...base, id: 137563990000, name: 'hosted-ci-suites-windows', conclusion: 'failure', started_at: '2026-11-23T08:11:05Z', completed_at: '2026-11-23T08:11:10Z' });
  return runs.map(r => r.name === 'ci-suites-windows' && r.app.id === 15368 ? { ...r, conclusion: frameworkWindows } : r);
}

test('C1 现场回归：取消之前已真失败的托管检查照常比较（68a6c5e gitleaks、148bd30 ci-suites 与 clued-cloud-tests 两边同红）', async () => {
  const h68 = await superseded(1253, H68, fixture('shadow-head-68a6c5e.json'));
  // 结论与修复前全量回放（shadow-superseded-review/old-all.json）逐项相同。
  assert.deepEqual(h68.pairs.map(p => [p.check, p.verdict]), [['ci-suites', '跳过'], ['clued-cloud-tests', '跳过'], ['migration-verify', '一致'],
    ['ci-suites-windows', '跳过'], ['gitleaks', '一致'], ['trivy', '不一致'], ['contract-placement', '一致']]);
  assert.deepEqual(bothRed(h68), ['gitleaks']);
  assert.equal(pairOf(h68, 'ci-suites').reason, '托管无结论（cancelled），已被取代');
  const h148 = await superseded(1251, H148, fixture('shadow-head-148bd30.json'));
  assert.deepEqual(h148.pairs.map(p => [p.check, p.verdict]), [['ci-suites', '一致'], ['clued-cloud-tests', '一致'], ['migration-verify', '一致'],
    ['ci-suites-windows', '跳过'], ['gitleaks', '一致'], ['trivy', '不一致'], ['contract-placement', '一致']]);
  assert.deepEqual(bothRed(h148), ['ci-suites', 'clued-cloud-tests']);
});

test('C2 块 4 形状：运行取消后才开始的汇总红判跳过；同一运行里取消前已真失败的 gitleaks 仍判一致', async () => {
  const head = await superseded(1253, H68, block4Shape());
  const windows = pairOf(head, 'ci-suites-windows');
  assert.equal(windows.verdict, '跳过');
  assert.equal(windows.reason, '托管无结论（同一运行中先有取消，本检查之后才开始），已被取代');
  assert.equal(pairOf(head, 'gitleaks').verdict, '一致');
  // 这一 head 仍因现场 trivy（框架红、托管绿）判不一致；Windows 这一对不在不一致里。
  assert.deepEqual(head.pairs.filter(p => p.verdict === '不一致').map(p => p.check), ['trivy']);
});

test('C3 块 4 形状、框架 Windows 也红：不虚记两边同红，同红只来自 gitleaks', async () => {
  const head = await superseded(1253, H68, block4Shape('failure'));
  assert.equal(pairOf(head, 'ci-suites-windows').verdict, '跳过');
  assert.deepEqual(bothRed(head), ['gitleaks']);
});

test('C4 先真失败、后被取消：作业级取消发生在托管 trivy 跑的途中，trivy 之后才红，照常比较判不一致', async () => {
  const suite = 7001;
  const runs = greenRuns({ override: (check, side) => check === 'trivy' && side === 'hosted' ? [
    run('hosted-ci-suites-windows-shard-2', 15368, 'cancelled', { started: '2026-11-23T08:05:31Z', completed: '2026-11-23T08:07:00Z', suite }),
    run('hosted-trivy', 15368, 'failure', { started: '2026-11-23T08:05:32Z', completed: '2026-11-23T08:08:00Z', suite, title: 'CVE found' })] : null });
  const head = await superseded(1750, sha(461), runs, FRAMEWORK_PINS);
  assert.equal(pairOf(head, 'trivy').verdict, '不一致');
  assert.equal(pairOf(head, 'trivy').direction, '托管红、框架绿');
  assert.equal(head.verdict, '不一致');
});

test('C5 重跑：同名旧分片 cancelled、新分片 success，汇总之后才红：cancelled 只认同名最新，照常比较', async () => {
  const suite = 7002;
  const runs = greenRuns({ override: (check, side) => check === 'ci-suites-windows' && side === 'hosted' ? [
    run('hosted-ci-suites-windows-shard-1', 15368, 'cancelled', { id: 100, started: '2026-11-23T08:05:31Z', completed: '2026-11-23T08:10:57Z', suite }),
    run('hosted-ci-suites-windows-shard-1', 15368, 'success', { id: 200, started: '2026-11-23T08:20:00Z', completed: '2026-11-23T08:30:00Z', suite }),
    run('hosted-ci-suites-windows', 15368, 'failure', { id: 300, started: '2026-11-23T08:31:00Z', completed: '2026-11-23T08:31:10Z', suite })] : null });
  const head = await superseded(1760, sha(471), runs, FRAMEWORK_PINS);
  assert.equal(pairOf(head, 'ci-suites-windows').verdict, '不一致');
  assert.equal(pairOf(head, 'ci-suites-windows').direction, '托管红、框架绿');
});

test('C6 不读 /check-suites：判据只用已读到的 check-runs', async () => {
  const source = readFileSync(new URL('./shadow-compare.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /check-suites/);
  const stub = api(prRoutes([{ number: 1253, state: 'open', commits: [{ sha: H68 }, { sha: sha(1253) }] }], { [H68]: block4Shape(), [sha(1253)]: [] }, ruleset(LIVE_PINS)));
  await compare({ prs: { from: 1253, to: 1253 }, api: stub, now: NOW });
  assert.deepEqual(stub.calls.filter(c => !c.startsWith('/commits/') && !c.startsWith('/pulls') && c !== RULESET_ROUTE), []);
});

test('C7 两侧对称：框架侧取消后才开始的红在最终 head 判未知，写明原因', async () => {
  const suite = 7003;
  const runs = greenRuns({ override: (check, side) => check === 'ci-suites-windows' && side === 'framework' ? [
    run('ci-suites-windows-shard-1', 15368, 'cancelled', { started: '2026-11-23T08:05:31Z', completed: '2026-11-23T08:10:57Z', suite }),
    run('ci-suites-windows', 15368, 'failure', { started: '2026-11-23T08:11:05Z', completed: '2026-11-23T08:11:10Z', suite })] : null });
  const head = await finalHead(sha(481), runs);
  assert.equal(pairOf(head, 'ci-suites-windows').verdict, '未知');
  assert.equal(pairOf(head, 'ci-suites-windows').reason, '框架无结论（同一运行中先有取消，本检查之后才开始）');
});

// 连续一致的计数（判据全文见下方 S6 用例）。
async function streakOf(verdicts, spanHours) {
  const entries = verdicts.map((v, i) => {
    const t = new Date(Date.parse('2026-11-23T00:00:00Z') + Math.round(i * spanHours * 3600_000 / (verdicts.length - 1))).toISOString().replace('.000Z', 'Z');
    const runs = greenRuns({ started: t, completed: t, hostedCompleted: t,
      override: (check, side) => v === 'bad' && check === 'gitleaks' && side === 'framework' ? [run('gitleaks', 5368905, 'failure', { started: t, completed: t })] : null });
    return [sha(1000 + i), runs];
  });
  return (await compare({ heads: entries.map(e => e[0]), api: api(headRoutes(entries)), now: NOW })).summary.streak;
}

test('直接给的 head 不属于已合入 PR：30 个一致跨 8 天也不算达成', async () => {
  const streak = await streakOf(Array(30).fill('ok'), 8 * 24);
  assert.equal(streak.heads, 30);
  assert.equal(streak.days, 8);
  assert.equal(streak.hours, 192);
  assert.equal(streak.mergedPrs, 0);
  assert.equal(streak.met, false);
});

test('中间一个不一致：连续计数从它之后重新算', async () => {
  const verdicts = Array(40).fill('ok');
  verdicts[15] = 'bad';
  const streak = await streakOf(verdicts, 10 * 24);
  assert.equal(streak.heads, 24);
  assert.equal(streak.met, false);
});

// S6 新退出判据（FABLE-s6-exit-shorten-20261122 §3 与补答，Decision efe2cee6）：连续 30 个 head、逐项一致（Decision 67cea8f4 起不再要求首尾相隔 72 小时）；
// 出自 ≥10 个已合入 PR；≥1 个非 Owner 推送的 head（pull_request 运行的 actor.login）；≥1 个 head 上同一项两边都红。
// 同一组 head 序列，每次只拿掉一条。默认：30 个 head 按时间平均铺开，每 3 个一个 PR（1800…1809，最后一个是已合入 PR 的最终 head），
// 第 16 个 head 由合 main 机器人推送，其余由 tdoljyj 推送（另带一次机器人的 workflow_dispatch，不算推送）；第 8 个 head 的 gitleaks 两边都红。
const BOT = 'clued-admission[bot]';
const pushesRoute = s => `/actions/runs?head_sha=${s}&event=pull_request&per_page=100&page=1`;
const pushes = (...logins) => {
  const runs = [...logins.map(login => ({ event: 'pull_request', actor: { login } })), { event: 'workflow_dispatch', actor: { login: BOT } }];
  return { total_count: runs.length, workflow_runs: runs };
};
const exitStreak = async options => (await exitReport(options)).summary.streak;
// race：在第 15、16 个 head 之间插一个刚合入、框架结论未出的最终 head（§8 P4，addRace 在下方定义），now 随之给定。
async function exitReport({ heads = 30, spanHours = 72, unmerged = [], dependabot = false, botCommit = false, bothRed = true, lead = null,
  pushers = { 15: BOT }, leadPusher = 'tdoljyj', pushError = [], race = null, now = NOW, noAdmission = [] } = {}) {
  const t0 = Date.parse('2026-11-23T00:00:00Z');
  const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
  const prs = [], checks = {};
  for (let i = 0; i < heads; i++) {
    const s = sha(5000 + i), t = iso(t0 + Math.round(i * spanHours * 3600_000 / (heads - 1))), number = 1800 + Math.floor(i / 3);
    let pr = prs.find(p => p.number === number);
    if (!pr) prs.push(pr = { number, state: 'closed', merged: !unmerged.includes(number), user: number === 1805 && dependabot ? 'dependabot[bot]' : 'tdoljyj', commits: [] });
    pr.commits.push({ sha: s, author: botCommit && i === 13 ? 'kooyumi-app[bot]' : 'tdoljyj' });
    checks[s] = runsAt(t, bothRed && i === 7 ? (check, side) => check === 'gitleaks'
      ? [run(side === 'framework' ? 'gitleaks' : 'hosted-gitleaks', side === 'framework' ? 5368905 : 15368, 'failure', { started: t, completed: t })] : null : undefined,
      noAdmission.includes(i) ? null : 1);
  }
  // lead：在序列之前 leadHours 小时放一个不一致的 head（单独一个已合入 PR）。
  if (lead !== null) {
    const s = sha(4999), t = iso(t0 - lead * 3600_000);
    prs.push({ number: 1799, state: 'closed', merged: true, user: 'tdoljyj', commits: [{ sha: s }] });
    checks[s] = runsAt(t, frameworkRed('trivy', t));
  }
  const routes = prRoutes(prs.sort((a, b) => b.number - a.number), checks);
  for (let i = 0; i < heads; i++) routes[pushesRoute(sha(5000 + i))] = pushError.includes(i) ? { error: 'gh GET 失败（退出码 1）' } : pushes(pushers[i] ?? 'tdoljyj');
  if (lead !== null) routes[pushesRoute(sha(4999))] = pushes(leadPusher);
  if (race) addRace(routes, { number: 1850, t: iso(t0 + Math.round(14.5 * spanHours * 3600_000 / (heads - 1))), ...race });
  return compare({ prs: { from: 1799, to: 1899 }, api: api(withCleanBypass(routes, now)), now });
}

test('S6-a 30 个一致、跨满 72 小时、10 个已合入 PR、含一个机器人推送且判一致的 head、有同红：达成', async () => {
  const streak = await exitStreak();
  assert.equal(streak.heads, 30);
  assert.equal(streak.hours, 72);
  assert.equal(streak.mergedPrs, 10);
  assert.equal(streak.nonOwnerPushedHeads, 1);
  assert.equal(streak.bothRedHeads, 1);
  assert.deepEqual(streak.unmet, []);
  assert.equal(streak.met, true);
});

test('S6-b 同一序列只跨 10 小时：照样达成（Decision 67cea8f4 去掉 72 小时下限；hours 只作信息）', async () => {
  const streak = await exitStreak({ spanHours: 10 });
  assert.equal(streak.heads, 30);
  assert.equal(streak.hours, 10);
  assert.deepEqual(streak.unmet, []);
  assert.equal(streak.met, true);
  assert.ok(!streak.rule.includes('小时'));
});

test('S6-j 只跨 10 小时、只有 29 个 head：不算达成，未达项只有 head 数，不含小时字样', async () => {
  const streak = await exitStreak({ heads: 29, spanHours: 10 });
  assert.equal(streak.met, false);
  assert.deepEqual(streak.unmet, ['连续一致不足 30 个 head']);
  assert.ok(!streak.unmet.join('').includes('小时'));
});

test('S6-k 只跨 10 小时、没有两边同红的 head：不算达成，未达项只有同红，不含小时字样', async () => {
  const streak = await exitStreak({ spanHours: 10, bothRed: false });
  assert.equal(streak.met, false);
  assert.deepEqual(streak.unmet, ['没有两边同红的 head']);
  assert.ok(!streak.unmet.join('').includes('小时'));
});

test('S6-c 只有 29 个 head、跨 8 天：不算达成', async () => {
  const streak = await exitStreak({ heads: 29, spanHours: 8 * 24 });
  assert.equal(streak.heads, 29);
  assert.equal(streak.met, false);
  assert.deepEqual(streak.unmet, ['连续一致不足 30 个 head']);
});

test('S6-d 同一序列 PR 1809 关闭未合入：已合入 PR 只有 9 个，不算达成', async () => {
  const streak = await exitStreak({ spanHours: 8 * 24, unmerged: [1809] });
  assert.equal(streak.heads, 30);
  assert.equal(streak.mergedPrs, 9);
  assert.equal(streak.met, false);
  assert.deepEqual(streak.unmet, ['已合入 PR 不足 10 个']);
});

test('S6-e 同一序列只有 tdoljyj 推送：不算达成；PR 作者是 dependabot、提交作者是机器人都不顶替推送者', async () => {
  const streak = await exitStreak({ spanHours: 8 * 24, pushers: {}, dependabot: true, botCommit: true });
  assert.equal(streak.heads, 30);
  assert.equal(streak.nonOwnerPushedHeads, 0);
  assert.equal(streak.met, false);
  assert.deepEqual(streak.unmet, ['没有非 Owner 推送的 head']);
});

test('S6-h 机器人推送的 head 判不一致、不在连续一致段里：不算达成', async () => {
  const streak = await exitStreak({ spanHours: 8 * 24, pushers: {}, lead: 5, leadPusher: BOT });
  assert.equal(streak.heads, 30);
  assert.equal(streak.nonOwnerPushedHeads, 0);
  assert.equal(streak.met, false);
  assert.deepEqual(streak.unmet, ['没有非 Owner 推送的 head']);
});

test('S6-i 机器人推送的 head 推送者读不到：不算非 Owner 推送，不算达成', async () => {
  const streak = await exitStreak({ spanHours: 8 * 24, pushError: [15] });
  assert.equal(streak.heads, 30);
  assert.equal(streak.nonOwnerPushedHeads, 0);
  assert.equal(streak.met, false);
  assert.deepEqual(streak.unmet, ['没有非 Owner 推送的 head']);
});

test('S6-f 同一序列没有两边同红的 head：不算达成', async () => {
  const streak = await exitStreak({ spanHours: 8 * 24, bothRed: false });
  assert.equal(streak.bothRedHeads, 0);
  assert.equal(streak.met, false);
  assert.deepEqual(streak.unmet, ['没有两边同红的 head']);
});

test('S6-g 天数从第一个一致 head 起算：前面 5 小时的不一致 head 不算进跨度', async () => {
  const streak = await exitStreak({ spanHours: 71, lead: 5 });
  assert.equal(streak.heads, 30);
  assert.equal(streak.hours, 71);
  assert.equal(streak.from, '2026-11-23T08:00:00+08:00');
  assert.deepEqual(streak.unmet, []);
  assert.equal(streak.met, true);
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

// 按树读（修订 7，D:/w/tmp/FABLE-s6-merge-before-shadow-20261124.md §2 甲、§4）：已合入 PR 的最终 head 上框架侧缺某项检查时，
// 从该 PR 的合入提交 M 读同名、同来源的检查；条件是 M 有两个父提交、第二个父提交就是这个 head、两者同一棵树。head 上有的不被替换。
const gitRoute = s => `/git/commits/${s}`;
const tree = n => `7${n.toString(16).padStart(39, '0')}`;
// M 上只有框架七项（main 推送那一轮），override 同 greenRuns。
const frameworkOnly = (t, override = () => null) => runsAt(t, (check, side) => side === 'hosted' ? undefined : override(check, side));
// 一个已合入 PR：head 上托管七项全绿、框架七项全缺（合入跑赢框架），M 上框架七项由 mRuns 给。
function mergedRace({ number = 2000, headRuns, mRuns, mergeTree, parents, mergeSha } = {}) {
  const t = at(24), head = sha(number), merge = sha(number + 1), headTree = tree(number);
  const routes = prRoutes([{ number, state: 'closed', merged: true, commits: [{ sha: head }] }],
    { [head]: headRuns ?? runsAt(t, (check, side) => side === 'framework' ? undefined : null), [merge]: mRuns ?? frameworkOnly(t) });
  routes['/pulls?state=all&sort=created&direction=desc&per_page=100&page=1'][0].merge_commit_sha = mergeSha === undefined ? merge : mergeSha;
  routes[gitRoute(head)] = { sha: head, tree: { sha: headTree }, parents: [{ sha: sha(number + 2) }] };
  routes[gitRoute(merge)] = { sha: merge, tree: { sha: mergeTree ?? headTree }, parents: (parents ?? [sha(number + 2), head]).map(p => ({ sha: p })) };
  return { routes, head, merge, headTree, number };
}
const raceReport = async options => {
  const { routes, merge, headTree, number } = mergedRace(options);
  const stub = api(routes);
  const report = await compare({ prs: { from: number, to: number }, api: stub, now: NOW });
  return { report, head: report.heads[0], calls: stub.calls, merge, headTree };
};

test('T1 最终 head 框架七项缺、合入提交同树七项全绿：七项一致，逐项带 frameworkFrom，汇总写按树读个数', async () => {
  const { head, merge, headTree, report } = await raceReport();
  assert.equal(head.role, 'final');
  assert.equal(head.verdict, '一致');
  for (const p of head.pairs) {
    assert.equal(p.verdict, '一致', p.check);
    assert.deepEqual(p.frameworkFrom, { sha: merge, tree: headTree }, p.check);
  }
  assert.equal(report.summary.streak.heads, 1);
  assert.equal(report.summary.streak.mergedPrs, 1);
  assert.equal(report.summary.frameworkByTreeHeads, 1);
  assert.match(report.summary.line, /其中框架侧按树读 1 个 head/);
});

test('T2 head 上有的框架检查以 head 为准：head 红、M 绿仍判不一致；head 上 cancelled、M 绿仍判未知；只补缺的那几项', async () => {
  const t = at(24);
  const red = await raceReport({ headRuns: runsAt(t, (check, side) => side === 'framework'
    ? check === 'ci-suites-windows' ? [run(check, FRAMEWORK_PINS[check], 'failure', { started: t, completed: t, title: 'windows red' })] : undefined : null) });
  assert.equal(red.head.verdict, '不一致');
  const win = pairOf(red.head, 'ci-suites-windows');
  assert.equal(win.direction, '框架红、托管绿');
  assert.equal(win.frameworkFrom, undefined);
  assert.equal(pairOf(red.head, 'trivy').frameworkFrom.sha, red.merge);
  const cancelled = await raceReport({ headRuns: runsAt(t, (check, side) => side === 'framework'
    ? check === 'trivy' ? [run(check, FRAMEWORK_PINS[check], 'cancelled', { started: t, completed: t })] : undefined : null) });
  assert.equal(cancelled.head.verdict, '未知');
  assert.equal(pairOf(cancelled.head, 'trivy').reason, '框架无结论（cancelled）');
  assert.equal(pairOf(cancelled.head, 'trivy').frameworkFrom, undefined);
  assert.equal(pairOf(cancelled.head, 'gitleaks').frameworkFrom.sha, cancelled.merge);
});

test('T3 M 上那一项 cancelled、缺、in_progress：判未知，不判一致', async () => {
  const t = at(24);
  const cases = [
    ['cancelled', [run('trivy', FRAMEWORK_PINS.trivy, 'cancelled', { started: t, completed: t })], '框架无结论（cancelled）'],
    // 缺、in_progress 是框架结论未出：NOW 在合入后两周，超过 §8 的 90 分钟窗口，原因写明超窗。
    ['缺', undefined, '合入已超过 90 分钟，框架仍无结论（框架缺检查）'],
    ['in_progress', [run('trivy', FRAMEWORK_PINS.trivy, null, { status: 'in_progress', started: t })], '合入已超过 90 分钟，框架仍无结论（框架未完成（in_progress））'],
  ];
  for (const [label, replaced, reason] of cases) {
    const { head } = await raceReport({ mRuns: frameworkOnly(t, check => check === 'trivy' ? replaced : null) });
    assert.equal(head.verdict, '未知', label);
    assert.equal(pairOf(head, 'trivy').verdict, '未知', label);
    assert.equal(pairOf(head, 'trivy').reason, reason, label);
    assert.equal(pairOf(head, 'gitleaks').verdict, '一致', label);
  }
});

test('T4 M 上同名但不是 #292 钉的来源：不算数，判未知', async () => {
  const t = at(24);
  const { head } = await raceReport({ mRuns: frameworkOnly(t, check => check === 'gitleaks' ? [run('gitleaks', 15368, 'success', { started: t, completed: t })] : null) });
  assert.equal(pairOf(head, 'gitleaks').verdict, '未知');
  assert.equal(pairOf(head, 'gitleaks').reason, '合入已超过 90 分钟，框架仍无结论（框架缺检查）');
});

test('T5 树不同、第二个父提交不是 head、不是两父合并、没有合入提交：判未知写明原因，不读 M 的检查', async () => {
  const cases = [
    [{ mergeTree: tree(9999) }, /^树不同/],
    [{ parents: [sha(2002), sha(2003)] }, /第二个父提交不是这个 head/],
    [{ parents: [sha(2000)] }, /不是两父合并/],
    [{ mergeSha: null }, /没有合入提交/],
  ];
  for (const [options, reason] of cases) {
    const { head, calls, merge } = await raceReport(options);
    assert.equal(head.verdict, '未知');
    assert.ok(head.pairs.every(p => p.reason === '框架缺检查' && p.frameworkFrom === undefined));
    assert.match(head.frameworkByTree?.reason ?? '', reason, JSON.stringify(options));
    assert.ok(!calls.includes(checksRoute(merge)), `不该读 M 的检查：${JSON.stringify(options)}`);
  }
});

test('T6 读合入提交失败：判未知写明读取失败', async () => {
  const { routes, merge } = mergedRace();
  routes[gitRoute(merge)] = { error: 'gh GET 失败（退出码 1）' };
  const report = await compare({ prs: { from: 2000, to: 2000 }, api: api(routes), now: NOW });
  assert.equal(report.heads[0].verdict, '未知');
  assert.match(report.heads[0].frameworkByTree?.reason ?? '', /^读取失败/);
});

test('T7 M 上一项红、托管绿：判不一致（框架红、托管绿），偏严不偏松', async () => {
  const t = at(24);
  const { head, merge } = await raceReport({ mRuns: frameworkOnly(t, check => check === 'migration-verify'
    ? [run('migration-verify', FRAMEWORK_PINS['migration-verify'], 'failure', { started: t, completed: t, title: 'm red' })] : null) });
  assert.equal(head.verdict, '不一致');
  assert.equal(pairOf(head, 'migration-verify').direction, '框架红、托管绿');
  assert.equal(pairOf(head, 'migration-verify').frameworkFrom?.sha, merge);
});

test('T8 只走最终 head：open PR 的当前 head、被取代的 head、关闭未合入的 head 不读合入提交；head 框架齐全也不读', async () => {
  const t = at(24), missing = runsAt(t, (check, side) => side === 'framework' ? undefined : null);
  const [cur, sup, closed, full] = [sha(2101), sha(2102), sha(2103), sha(2104)];
  const routes = prRoutes([
    { number: 2103, state: 'closed', merged: true, commits: [{ sha: full }] },
    { number: 2102, state: 'closed', commits: [{ sha: closed }] },
    { number: 2101, state: 'open', commits: [{ sha: sup }, { sha: cur }] },
  ], { [cur]: missing, [sup]: missing, [closed]: missing, [full]: runsAt(t) });
  for (const row of routes['/pulls?state=all&sort=created&direction=desc&per_page=100&page=1']) row.merge_commit_sha = sha(row.number + 500);
  const stub = api(routes);
  const report = await compare({ prs: { from: 2101, to: 2103 }, api: stub, now: NOW });
  assert.deepEqual(report.heads.map(h => [h.sha, h.role, h.verdict]).sort(),
    [[cur, 'current', '在跑'], [sup, 'superseded', '跳过'], [closed, 'superseded', '跳过'], [full, 'final', '一致']].sort());
  const merges = [2101, 2102, 2103].map(n => sha(n + 500));
  assert.ok(!stub.calls.some(r => r.startsWith('/git/') || merges.some(m => r.includes(m))), stub.calls.join('\n'));
  assert.ok(report.heads.every(h => h.frameworkByTree === undefined && h.pairs.every(p => p.frameworkFrom === undefined)));
});

// 现场回放 #1252–#1279（fixtures/shadow-prs-1252-1279.json：2026-11-24 12:39 北京时间 gh api GET 只读录制，
// 录制脚本与裁剪规则见夹具 source 字段；裁剪前后用修复前脚本回放，输出逐字节相同）。
const LIVE = JSON.parse(readFileSync(new URL('./fixtures/shadow-prs-1252-1279.json', import.meta.url), 'utf8')).routes;
const replay = async (from, to) => {
  const stub = api(LIVE);
  return { report: await compare({ prs: { from, to }, api: stub, now: NOW }), calls: stub.calls };
};
// 9 个合入跑赢框架的最终 head → 各自的合入提交（设计 §1 事实表）。
const RACED = {
  1254: ['ba9f70bd07a6df29145482bfbdf817918a852e46', '133782fc16896deba72e8645ef2af188c0e0cfde'],
  1256: ['f2b652ae3e9ac7394b664aafc1d26f4261a32927', 'c53ef9b24d7db6f9970bf747fab36df839e6ea2d'],
  1262: ['977d200694b735573e3181a96176667fa1cfe0bd', '2490af4e9cd7e7feaca9779e2a45e9d129a0fcb1'],
  1265: ['2a142d79e4aa4645ae29bf28e09802ad4066e8fc', '6bce4036bbdfc5531dbe276cf950570b41fd675c'],
  1266: ['1822d10959b659979d8076fea017298866e09952', '2ac16e6dbee2bfb5cf64107323a149040bbc6d53'],
  1271: ['7a59b7965338ae23ea92ea8ffc02a9e8aff2c6fe', '837399edae4e12bb574f2da4fae665bb9cb27a35'],
  1272: ['bca9a006cb1661eb4799f00890b39651cfafc321', '7e6363af619f49b1558161f00c6b74d90db248cf'],
  1276: ['12169d162b868919bbd15dd57ebf50091a887d4c', '356cab45bbfc47932c79d5c246bf175a3f9109e0'],
  1277: ['1fa3d4e098a04112171878acbf90362a1c7deb6d', '4ba9f63024831728317e1a3ec9a69b8f50a01be2'],
};

test('R1 现场回放 #1252–#1279：9 个合入跑赢框架的最终 head 按树读判一致，连续一致不少于 15 个 head、10 个已合入 PR（修复前 2、2）', async () => {
  const { report } = await replay(1252, 1279);
  for (const [number, [head, merge]] of Object.entries(RACED)) {
    const h = report.heads.find(x => x.sha === head);
    assert.equal(h?.role, 'final', `#${number}`);
    assert.equal(h.verdict, '一致', `#${number}`);
    assert.ok(h.pairs.some(p => p.frameworkFrom?.sha === merge), `#${number} 应带 frameworkFrom`);
    assert.ok(h.pairs.every(p => p.frameworkFrom === undefined || p.frameworkFrom.sha === merge), `#${number}`);
  }
  assert.ok(report.summary.streak.heads >= 15, `连续一致 ${report.summary.streak.heads}`);
  assert.ok(report.summary.streak.mergedPrs >= 10, `已合入 PR ${report.summary.streak.mergedPrs}`);
  assert.equal(report.summary.frameworkByTreeHeads, 9);
});

test('R2 单 head：#1272 bca9a00 → 7e6363a，树 6a03233，七项逐项一致；head 上已有的 Windows 用 head 的，其余六项从合入提交读', async () => {
  const [head, merge] = RACED[1272];
  const { report } = await replay(1272, 1272);
  const h = report.heads.find(x => x.sha === head);
  assert.equal(h.verdict, '一致');
  assert.deepEqual(h.pairs.map(p => [p.check, p.verdict]), PAIRS.map(p => [p.check, '一致']));
  assert.equal(pairOf(h, 'ci-suites-windows').frameworkFrom, undefined);
  for (const p of h.pairs.filter(p => p.check !== 'ci-suites-windows')) {
    assert.equal(p.frameworkFrom?.sha, merge, p.check);
    assert.match(p.frameworkFrom.tree, /^6a03233/, p.check);
  }
  assert.equal(h.frameworkByTree.sha, merge);
});

test('R3 防掩盖：#1264 21025a8 head 上框架 Windows 红、合入提交上绿，仍判不一致，不读合入提交', async () => {
  const { report, calls } = await replay(1264, 1264);
  const h = report.heads.find(x => x.sha === '21025a8a27a6eac07f2876df169ff13a29403630');
  assert.equal(h.verdict, '不一致');
  assert.equal(pairOf(h, 'ci-suites-windows').direction, '框架红、托管绿');
  assert.ok(h.pairs.every(p => p.frameworkFrom === undefined));
  assert.ok(!calls.some(r => r.includes('196bd4ce048d4d8e5e010048541a836b81feb2ba')));
});

// 刚合入、框架结论未出（D:/w/tmp/FABLE-s6-merge-before-shadow-20261124.md §8）：已合入 PR 的最终 head 框架侧缺检查（按树读前提成立）
// 或未完成、托管侧已完成，距合入不满 90 分钟判在跑（不计入、不打断）；满 90 分钟或窗口内已能确定没有结论的照旧判未知；
// 连续段内有这样的在跑 head 时判据一律未达。
const PULLS = '/pulls?state=all&sort=created&direction=desc&per_page=100&page=1';
const MERGED_AT = '2026-11-26T00:00:00Z'; // prRoutes 给已合入 PR 的 merged_at
const afterMerge = minutes => new Date(Date.parse(MERGED_AT) + minutes * 60_000).toISOString();
// #1281 13:07 现场形状：M 上六项 success、ci-suites-windows in_progress。
const windowsRunning = t => frameworkOnly(t, check => check === 'ci-suites-windows'
  ? [run(check, FRAMEWORK_PINS[check], null, { status: 'in_progress', started: t })] : null);
// 把一个合入跑赢框架的已合入 PR 加进已有路由（同 mergedRace）：head 上托管七项全绿、框架七项默认全缺，M 上框架七项由 mRuns 给。
function addRace(routes, { number, t = at(24), headRuns, mRuns, mError, mergeTree, parents, mergedAt = MERGED_AT }) {
  const head = sha(number), merge = sha(number + 1), headTree = tree(number);
  routes[PULLS].push({ number, state: 'closed', merged_at: mergedAt, merge_commit_sha: merge, head: { sha: head }, user: { login: 'tdoljyj' } });
  routes[`/pulls/${number}/commits?per_page=100&page=1`] = [{ sha: head, author: { login: 'tdoljyj' }, commit: { committer: {} } }];
  routes[checksRoute(head)] = page(headRuns ?? runsAt(t, (check, side) => side === 'framework' ? undefined : null));
  routes[checksRoute(merge)] = mError ? { error: mError } : page(mRuns ?? windowsRunning(t));
  routes[gitRoute(head)] = { sha: head, tree: { sha: headTree }, parents: [{ sha: sha(number + 2) }] };
  routes[gitRoute(merge)] = { sha: merge, tree: { sha: mergeTree ?? headTree }, parents: (parents ?? [sha(number + 2), head]).map(p => ({ sha: p })) };
  return { head, merge };
}
// 前面 lead 个一致 head（已合入 PR 2999 的提交，时间在前），后面是刚合入的 PR 3000；now 为合入后 minutes 分钟。
async function justMerged({ minutes, lead = 0, ...race } = {}) {
  const leads = Array.from({ length: lead }, (_, i) => sha(2990 + i));
  const routes = prRoutes(lead ? [{ number: 2999, state: 'closed', merged: true, commits: leads.map(s => ({ sha: s })) }] : [],
    Object.fromEntries(leads.map((s, i) => [s, runsAt(at(23, i + 1))])));
  const { head, merge } = addRace(routes, { number: 3000, ...race });
  const stub = api(routes);
  const report = await compare({ prs: { from: 2999, to: 3000 }, api: stub, now: afterMerge(minutes) });
  return { report, head: report.heads.find(h => h.sha === head), merge, calls: stub.calls };
}
const p3Runs = t => runsAt(t, (check, side) => check === 'ci-suites-windows' && side === 'framework'
  ? [run(check, FRAMEWORK_PINS[check], null, { status: 'in_progress', started: t })] : null);
const SHAPES = { P1: {}, P2: { mRuns: [run('kooyumi-main-merge', 5164952, 'success', { started: at(24) })] }, P3: { headRuns: p3Runs(at(24)) } };

test('P1 #1281 现场形状：head 上框架七项全缺，M 同树六项 success、Windows in_progress，合入后 9 分钟：判在跑，不打断连续段，判据未达', async () => {
  const { report, head } = await justMerged({ minutes: 9, lead: 2 });
  assert.equal(head.role, 'final');
  assert.equal(head.verdict, '在跑');
  const win = pairOf(head, 'ci-suites-windows');
  assert.equal(win.verdict, '在跑');
  assert.equal(win.reason, '已合入 9 分钟，框架结论未出（框架未完成（in_progress））');
  assert.equal(pairOf(head, 'gitleaks').verdict, '一致');
  assert.equal(report.summary.counts.在跑, 1);
  assert.equal(report.summary.streak.heads, 2);
  assert.equal(report.summary.pendingMergedHeads, 1);
  assert.equal(report.summary.streak.met, false);
  assert.ok(report.summary.streak.unmet.includes('连续段内有 1 个已合入 head 的框架结论未出'), JSON.stringify(report.summary.streak.unmet));
  assert.match(report.summary.line, /已合入未出结论 1 个/);
});

test('P2 M 上一条框架检查都还没有（合入后 1 分钟，只有无关检查）：七项判在跑', async () => {
  const { report, head, merge } = await justMerged({ minutes: 1, lead: 2, ...SHAPES.P2 });
  assert.equal(head.verdict, '在跑');
  assert.ok(head.pairs.every(p => p.verdict === '在跑' && p.reason === '已合入 1 分钟，框架结论未出（框架缺检查）'), JSON.stringify(head.pairs));
  assert.equal(head.frameworkByTree.sha, merge);
  assert.equal(report.summary.streak.heads, 2);
  assert.equal(report.summary.pendingMergedHeads, 1);
});

test('P3 #1274 形状：head 自己的框架 Windows in_progress，不读 M，合入后 10 分钟：判在跑', async () => {
  const { report, head, merge, calls } = await justMerged({ minutes: 10, lead: 2, ...SHAPES.P3 });
  assert.equal(head.verdict, '在跑');
  assert.equal(pairOf(head, 'ci-suites-windows').reason, '已合入 10 分钟，框架结论未出（框架未完成（in_progress））');
  assert.ok(!calls.includes(gitRoute(merge)) && !calls.includes(checksRoute(merge)), calls.join('\n'));
  assert.equal(head.frameworkByTree, undefined);
  assert.equal(report.summary.streak.heads, 2);
  assert.equal(report.summary.pendingMergedHeads, 1);
});

test('P4 30 个一致 head、覆盖项全满足，中间夹一个 P1 形状的 head：连续 30 个，判据未达，只差“框架结论未出”', async () => {
  const report = await exitReport({ race: {}, now: afterMerge(9) });
  assert.equal(report.heads.find(h => h.sha === sha(1850))?.verdict, '在跑');
  assert.equal(report.summary.streak.heads, 30);
  assert.equal(report.summary.pendingMergedHeads, 1);
  assert.equal(report.summary.streak.met, false);
  assert.deepEqual(report.summary.streak.unmet, ['连续段内有 1 个已合入 head 的框架结论未出']);
  assert.match(report.summary.line, /判据：未达，连续段内有 1 个已合入 head 的框架结论未出/);
});

test('P5 封顶：P1、P2、P3 合入后 90、91 分钟：判未知，连续 0', async () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    for (const minutes of [90, 91]) {
      const { report, head } = await justMerged({ minutes, lead: 2, ...shape });
      const label = `${name} +${minutes}`;
      assert.equal(head.verdict, '未知', label);
      assert.ok(!head.pairs.some(p => p.verdict === '在跑'), label);
      assert.equal(report.summary.streak.heads, 0, label);
      assert.ok(!(report.summary.pendingMergedHeads > 0), label);
    }
  }
});

test('P5b 封顶原因与边界：满 90 分钟原因写“合入已超过 90 分钟”；89 分钟仍判在跑', async () => {
  const cases = { P1: ['ci-suites-windows', '框架未完成（in_progress）'], P2: ['trivy', '框架缺检查'], P3: ['ci-suites-windows', '框架未完成（in_progress）'] };
  for (const [name, [check, original]] of Object.entries(cases)) {
    const { head } = await justMerged({ minutes: 91, ...SHAPES[name] });
    assert.equal(pairOf(head, check).reason, `合入已超过 90 分钟，框架仍无结论（${original}）`, name);
    const inside = await justMerged({ minutes: 89, ...SHAPES[name] });
    assert.equal(inside.head.verdict, '在跑', name);
    assert.equal(pairOf(inside.head, check).reason, `已合入 89 分钟，框架结论未出（${original}）`, name);
  }
});

test('P6 窗口内也不放过：合入后 9 分钟，能确定没有结论或前提不成立的逐个判未知', async () => {
  const t = at(24);
  const hostedOverride = replaced => runsAt(t, (check, side) => side === 'framework' ? undefined : check === 'trivy' ? replaced : null);
  const cases = [
    ['M 一项 cancelled', { mRuns: frameworkOnly(t, check => check === 'trivy' ? [run(check, FRAMEWORK_PINS[check], 'cancelled', { started: t, completed: t })]
      : check === 'ci-suites-windows' ? [run(check, FRAMEWORK_PINS[check], null, { status: 'in_progress', started: t })] : null) }, 'trivy', '框架无结论（cancelled）'],
    ['M 树不同', { mergeTree: tree(9999) }, 'trivy', '框架缺检查'],
    ['第二父不是 head', { parents: [sha(3002), sha(3003)] }, 'trivy', '框架缺检查'],
    ['M 不是两父合并', { parents: [sha(3002)] }, 'trivy', '框架缺检查'],
    ['M 的 check-runs 读取失败', { mError: 'gh GET 失败（退出码 1）' }, 'trivy', '框架缺检查'],
    ['merged_at 读不到（不可解析）', { mergedAt: 'not-a-date' }, 'ci-suites-windows', '框架未完成（in_progress）'],
    ['托管一项缺', { headRuns: hostedOverride(undefined) }, 'trivy', '托管缺检查'],
    ['托管一项 in_progress', { headRuns: hostedOverride([run('hosted-trivy', 15368, null, { status: 'in_progress', started: t })]) }, 'trivy', '托管未完成（in_progress）'],
    // §9 补一条：M 上 trivy 整项缺（其余同 P1），托管 trivy 未完成，不算框架结论未出。
    ['M 缺一项、托管这一项 in_progress', { mRuns: frameworkOnly(t, check => check === 'trivy' ? undefined
      : check === 'ci-suites-windows' ? [run(check, FRAMEWORK_PINS[check], null, { status: 'in_progress', started: t })] : null),
    headRuns: hostedOverride([run('hosted-trivy', 15368, null, { status: 'in_progress', started: t })]) }, 'trivy', '框架缺检查'],
    ['now 早于 merged_at', { minutes: -5 }, 'ci-suites-windows', '框架未完成（in_progress）'],
  ];
  for (const [label, options, check, reason] of cases) {
    const { report, head } = await justMerged({ minutes: 9, lead: 2, ...options });
    assert.equal(head.role, 'final', label);
    assert.equal(head.verdict, '未知', label);
    assert.equal(pairOf(head, check).verdict, '未知', label);
    assert.equal(pairOf(head, check).reason, reason, label);
    assert.equal(report.summary.streak.heads, 0, label);
    assert.ok(!(report.summary.pendingMergedHeads > 0), label);
  }
});

test('P6b 框架侧缺、托管侧 in_progress（M 上还没有框架检查，合入后 9 分钟）：托管未完成不算框架结论未出，判未知', async () => {
  const t = at(24);
  const headRuns = runsAt(t, (check, side) => side === 'framework' ? undefined
    : check === 'trivy' ? [run('hosted-trivy', 15368, null, { status: 'in_progress', started: t })] : null);
  const { report, head } = await justMerged({ minutes: 9, lead: 2, ...SHAPES.P2, headRuns });
  assert.equal(head.role, 'final');
  assert.equal(head.verdict, '未知');
  assert.equal(pairOf(head, 'trivy').verdict, '未知');
  assert.equal(pairOf(head, 'trivy').reason, '框架缺检查');
  assert.equal(report.summary.streak.heads, 0);
  assert.ok(!(report.summary.pendingMergedHeads > 0));
});

test('P7 自愈：框架跑完后再读按真实结果判（合入后 120 分钟）', async () => {
  const t = at(24);
  const green = await justMerged({ minutes: 120, lead: 2, mRuns: frameworkOnly(t) });
  assert.equal(green.head.verdict, '一致');
  assert.ok(green.head.pairs.every(p => p.verdict === '一致' && p.frameworkFrom?.sha === green.merge), JSON.stringify(green.head.pairs));
  assert.equal(green.report.summary.streak.heads, 3);
  const red = await justMerged({ minutes: 120, lead: 2, mRuns: frameworkOnly(t, check => check === 'ci-suites-windows'
    ? [run(check, FRAMEWORK_PINS[check], 'failure', { started: t, completed: t, title: 'windows red' })] : null) });
  assert.equal(red.head.verdict, '不一致');
  assert.equal(pairOf(red.head, 'ci-suites-windows').direction, '框架红、托管绿');
  assert.equal(pairOf(red.head, 'ci-suites-windows').frameworkFrom?.sha, red.merge);
  assert.equal(red.report.summary.streak.heads, 0);
  const own = await justMerged({ minutes: 120, lead: 2, headRuns: runsAt(t) });
  assert.equal(own.head.verdict, '一致');
  assert.equal(own.report.summary.streak.heads, 3);
});

// 准入时延（PLAN-native-admission-latency-20261124 §4 PR 丙；框架 v1 §2.3“准入 p90 ≤3 分钟”）：推送 = head 全部 check-run 最早的
// started_at；准入 = App 5368905 的 kooyumi-work-admission 最新一条的 completed_at，没有记无穷；p90 最近秩（第 ⌈0.9n⌉ 小）。
// 判据只看连续一致段那批 head；诊断两行（与自托管 ci-suites-windows 重叠 ≥2 分钟分组、超过 3 分钟清单）不进判据。
// 查因 26 个最终 head 的推送→准入（分钟，D:/agent-temp/s6plan/probe.txt；夹具补了它们的准入检查与最早一条检查）。
const PROBE26 = { 1252: 9.7, 1253: 12.7, 1254: 31.5, 1255: 6.4, 1256: 63.1, 1257: 6.4, 1259: 3.9, 1261: 4.3, 1262: 23, 1263: 4.7, 1264: 8.8,
  1265: 23.6, 1266: 20.5, 1267: 7.5, 1268: 3.2, 1269: 7.7, 1270: 7, 1271: 17.9, 1272: 6.3, 1273: 5.4, 1274: 11, 1275: 8.5, 1276: 8.5,
  1277: 16.2, 1278: 4.2, 1279: 7 };

test('A1 现场回放（修复前必红）：查因 26 个最终 head 推送→准入与 probe 逐个相同，p90 23.6 分钟判未达；重叠 17 个 p90 31.5，不重叠 9 个 p90 9.7', async () => {
  assert.equal(typeof shadow.admissionLatency, 'function', 'shadow-compare 没有准入时延');
  const { report } = await replay(1252, 1279);
  const finals = report.heads.filter(h => h.role === 'final');
  assert.deepEqual(Object.fromEntries(finals.map(h => [h.prs.at(-1), h.admission?.minutes])), PROBE26);
  const a = shadow.admissionLatency(finals);
  assert.equal(a.heads, 26);
  assert.equal(a.p90Minutes, 23.6);
  assert.equal(a.met, false);
  // 口径是“任一台自托管 Windows runner”，check-runs 不带 runner 名：与查因只算 TURING 的 14/12（不重叠 p90 8.5）不同，
  // 与查因 jobs.jsonl 按两台 Windows runner 重算的 17/9（p90 9.7）相同。
  assert.deepEqual([a.overlap.heads, a.overlap.p90Minutes, a.nonOverlap.heads, a.nonOverlap.p90Minutes], [17, 31.5, 9, 9.7]);
  assert.equal(a.over.length, 26);
  assert.match(a.line, /准入 p90 23\.6 分钟（26 个 head，判据 ≤3 分钟：未达）/);
});

test('A2 现场回放：判据只算连续一致段那 15 个 head（#1265–#1278），p90 20.5 分钟，S6 判据写明准入未达', async () => {
  const { report } = await replay(1252, 1279);
  const { streak, admission } = report.summary;
  assert.equal(streak.heads, 15);
  assert.equal(admission.heads, 15);
  assert.equal(admission.p90Minutes, 20.5);
  assert.equal(admission.met, false);
  assert.ok(streak.unmet.includes('准入 p90 20.5 分钟超过 3 分钟'), JSON.stringify(streak.unmet));
  assert.match(report.summary.line, /准入 p90 20\.5 分钟（15 个 head，判据 ≤3 分钟：未达）；诊断（不进判据）：与 ci-suites-windows 重叠 ≥2 分钟 \d+ 个/);
  assert.match(streak.rule, /准入 p90 ≤3 分钟/);
});

test('A3 无准入记无穷：30 个一致 head 里 3 个没有准入仍达成（第 27 小是 1 分钟），4 个就未达', async () => {
  const three = await exitReport({ noAdmission: [3, 9, 20] });
  assert.equal(three.summary.admission.p90Minutes, 1);
  assert.equal(three.summary.streak.met, true);
  assert.deepEqual(three.summary.admission.over.map(o => o.minutes), [null, null, null]);
  const four = await exitReport({ noAdmission: [3, 9, 20, 28] });
  assert.equal(four.summary.admission.p90Minutes, null);
  assert.equal(four.summary.admission.unadmitted, 4);
  assert.equal(four.summary.streak.met, false);
  assert.deepEqual(four.summary.streak.unmet, ['准入 p90 无穷（4 个 head 没有准入）超过 3 分钟']);
});

test('A4 3 分钟整算达标、超过才算；重叠按自托管 ci-suites-windows（托管的 hosted- 不算），合计满 2 分钟才归重叠组', async () => {
  const [h1, h2, h3] = [sha(701), sha(702), sha(703)];
  const at = (t, minutes, override) => greenRuns({ started: t, completed: t, hostedCompleted: t, admissionMinutes: minutes, ...(override ? { override } : {}) });
  const runs1 = at('2026-11-23T10:00:00Z', 5, (check, side) => check === 'ci-suites-windows' ? [side === 'framework'
    ? run('ci-suites-windows', 15368, 'success', { started: '2026-11-23T10:06:00Z', completed: '2026-11-23T10:30:00Z' })
    : run('hosted-ci-suites-windows', 15368, 'success', { started: '2026-11-23T10:06:00Z', completed: '2026-11-23T10:50:00Z' })] : null);
  const runs2 = at('2026-11-23T10:10:00Z', 3);
  const runs3 = at('2026-11-23T10:28:01Z', 6);
  const report = await compare({ heads: [h1, h2, h3], api: api(headRoutes([[h1, runs1], [h2, runs2], [h3, runs3]])), now: NOW });
  assert.deepEqual(report.heads.map(h => [h.admission.minutes, h.admission.windowsOverlapSeconds]), [[5, 0], [3, 180], [6, 119]]);
  assert.equal(report.heads[0].admission.pushedAt, '2026-11-23T18:00:00+08:00');
  assert.equal(report.heads[0].admission.admittedAt, '2026-11-23T18:05:00+08:00');
  const a = report.summary.admission;
  assert.equal(a.heads, 3);
  assert.equal(a.p90Minutes, 6);
  assert.deepEqual([a.overlap.heads, a.overlap.p90Minutes, a.nonOverlap.heads, a.nonOverlap.p90Minutes], [1, 3, 2, 6]);
  assert.deepEqual(a.over.map(o => [o.sha, o.minutes]), [[h1, 5], [h3, 6]]);
  assert.ok(report.summary.streak.unmet.includes('准入 p90 6 分钟超过 3 分钟'));
  const fast = shadow.admissionLatency([report.heads[1]]);
  assert.equal(fast.met, true);
  assert.deepEqual(fast.over, []);
});

test('A5 只用已读的 check-runs：除绕过取证外，准入时延不多发 API 请求', async () => {
  const s = sha(711);
  const associated = `/commits/${s}/pulls?per_page=100&page=1`;
  const stub = api({ ...headRoutes([[s, greenRuns()]]), [pushesRoute(s)]: pushes('tdoljyj'), [associated]: [],
    ...filteredActivityRoutes('main', [creation(1, 'main', s, bypassAt())]), [updatedPullsRoute]: [], [allRunsRoute(s)]: workflowRuns() });
  const report = await compare({ heads: [s], api: stub, now: NOW });
  assert.equal(report.heads[0].admission.minutes, 1);
  assert.equal(report.summary.bypass.state, '已判');
  assert.deepEqual(stub.calls, [RULESET_ROUTE, checksRoute(s), pushesRoute(s), associated,
    ...activityTypes.map(type => filteredActivityRoute('main', type)), updatedPullsRoute, allRunsRoute(s)]);
});

// S6 手工绕过：API 和 Git 均采用注入端口。空列表均来自已录制的完整读取。
const bypassFacts = JSON.parse(readFileSync(new URL('./fixtures/shadow-compare/bypass-1328-1325.json', import.meta.url), 'utf8'));
const bypassAt = (time = '02:30:00') => `2026-11-25T${time}Z`;
const bypassNow = bypassAt('05:00:00');
const human = { login: 'tdoljyj', type: 'User' };
const robot = { login: BOT, type: 'Bot' };
const branchRef = number => `topic/${number}`;
const activityRoute = branch => `/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=100`;
const activityTypes = ['push', 'force_push', 'branch_creation'];
const filteredActivityRoute = (branch, type, period = '') => `${activityRoute(branch)}${period ? `&time_period=${period}` : ''}&activity_type=${type}`;
const filteredActivityRoutes = (branch, rows, period) => Object.fromEntries(activityTypes.map(type =>
  [filteredActivityRoute(branch, type, period), rows.filter(row => row.activity_type === type)]));
const updatedPullsRoute = '/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1';
const branchPullsRoute = branch => `/pulls?state=all&head=${encodeURIComponent(`tdoljyj:${branch}`)}&per_page=100&page=1`;
const issueEventsRoute = pr => `/issues/${pr}/events?per_page=100&page=1`;
const allRunsRoute = s => `/actions/runs?head_sha=${s}&per_page=100&page=1`;
const statusesRoute = s => `/commits/${s}/statuses?per_page=100&page=1`;
const workflowRuns = (...workflow_runs) => ({ total_count: workflow_runs.length, workflow_runs });
const bypassPull = (number, head, overrides = {}) => ({
  number, state: 'open', created_at: bypassAt('02:00:00'), updated_at: bypassAt('04:30:00'), closed_at: null, merged_at: null,
  head: { sha: head, ref: branchRef(number), repo: { full_name: 'tdoljyj/cross-memory-system' } }, ...overrides,
});
const activity = (id, branch, before, after, timestamp, { actor = human, type = 'push' } = {}) =>
  ({ id, ref: `refs/heads/${branch}`, activity_type: type, before, after, timestamp, actor });
const creation = (id, branch, head, at) => activity(id, branch, sha(0), head, at, { type: 'branch_creation' });
const bypassCommit = (s, t, parents) => ({ sha: s, commit: { tree: { sha: t } }, parents: parents.map(sha => ({ sha })) });
const createdAtOf = (pushes, head) => pushes.find(p => p.after === head)?.timestamp;
const noMerge = () => assert.fail('不应调用 merge-tree');

// 原有连续段与准入用例补齐活动证据，让旧断言仍考察已判时的独立判据。
function withCleanBypass(routes, now) {
  const pulls = routes[PULLS], updated = [];
  let id = 0;
  for (const pull of pulls) {
    const branch = branchRef(pull.number);
    const commits = routes[`/pulls/${pull.number}/commits?per_page=100&page=1`];
    const pushes = commits.map((c, i) => {
      const checks = routes[checksRoute(c.sha)].check_runs;
      const at = checks.map(r => r.started_at).filter(Boolean).sort()[0];
      routes[allRunsRoute(c.sha)] = workflowRuns();
      return i === 0 ? creation(++id, branch, c.sha, at)
        : activity(++id, branch, commits[i - 1].sha, c.sha, at, { actor: robot });
    });
    pull.head = bypassPull(pull.number, pull.head.sha).head;
    Object.assign(pull, { created_at: pushes[0].timestamp, updated_at: now, closed_at: pull.state === 'closed' ? now : null });
    Object.assign(routes, filteredActivityRoutes(branch, pushes));
    routes[issueEventsRoute(pull.number)] = [];
    updated.push(pull);
  }
  routes[updatedPullsRoute] = updated;
  for (const period of ['', 'day', 'week']) Object.assign(routes, filteredActivityRoutes('main', [], period));
  return routes;
}

function bypassReplay({ pulls, picked, pushes, commits = [], routes: extra = {}, git = noMerge, now = bypassNow,
  from = Math.min(...picked.map(p => p.number)), to = null }) {
  const routes = prRoutes(picked.map(({ number, state, merged_at, heads }) => ({
    number, state, merged: Boolean(merged_at), commits: heads.map(sha => ({ sha, date: createdAtOf(pushes, sha) })),
  })), Object.fromEntries(picked.flatMap(p => p.heads.map(s => [s, createdAtOf(pushes, s)
    ? greenRuns({ started: plusMinutes(createdAtOf(pushes, s), 5) }) : []]))));
  routes[PULLS] = picked;
  routes[updatedPullsRoute] = [...pulls].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  for (const period of ['', 'day', 'week']) Object.assign(routes, filteredActivityRoutes('main', [], period));
  for (const p of pulls) {
    const ref = p.head.ref;
    Object.assign(routes, filteredActivityRoutes(ref, pushes.filter(row => row.ref === `refs/heads/${ref}`)));
    routes[branchPullsRoute(ref)] = pulls.filter(x => x.head.ref === ref);
    routes[issueEventsRoute(p.number)] = [];
  }
  for (const row of pushes) routes[allRunsRoute(row.after)] = workflowRuns();
  for (const c of commits) routes[`/commits/${c.sha}`] = c;
  const stub = api({ ...routes, ...extra });
  return { stub, now, git, from, to, compare: () => compare({ prs: { from, to }, api: stub, git, now }) };
}

const [bBase, bMerge, bLater, bMain, bTree] = [88001, 88002, 88003, 88004, 88005].map(sha);
const bypassBranch = branchRef(1329);
function mergeReplay({ pushAt = bypassAt('03:41:00'), pushed = true, creationInstead = false,
  actor = human, git = () => ({ status: 0, tree: bTree }), olderPr = false, routes = {} } = {}) {
  const candidate = bypassPull(1329, bLater);
  const older = bypassPull(1325, bMerge);
  const receiving = olderPr ? older : candidate;
  const ref = receiving.head.ref;
  const pushes = [
    creation(1, bypassBranch, bBase, bypassAt('02:20:00')),
    ...(pushed ? [creationInstead ? creation(2, ref, bMerge, pushAt) : activity(2, ref, bBase, bMerge, pushAt, { actor })] : []),
    activity(3, bypassBranch, bBase, bLater, bypassAt('04:00:00'), { actor: robot }),
  ];
  const picked = [{ ...candidate, heads: [bBase, ...(pushed && !olderPr ? [bMerge] : []), bLater] }];
  return bypassReplay({ pulls: olderPr ? [candidate, older] : [candidate], picked, pushes,
    commits: [bypassCommit(bMerge, bTree, [bBase, bMain])], git,
    routes: { [`/compare/${bMain}...main`]: { status: 'ahead' }, ...routes }, from: 1329 });
}

function replay1328(from = 1328) {
  const { pulls, activity: pushes, commit, middle } = bypassFacts;
  const picked = pulls.filter(p => p.number >= from).map(p => ({
    ...p, heads: [...pushes.filter(row => row.ref === `refs/heads/${p.head.ref}`).map(row => row.after),
      ...(p.number === 1328 ? [middle] : [])],
  }));
  return bypassReplay({ pulls, picked, pushes, commits: [commit] });
}

test('B01 #1328 回放：带新提交、机器人与从未成为 tip 的合并', async () => {
  const replay = replay1328();
  const { summary: { bypass } } = await replay.compare();
  assert.equal(bypass?.state, '已判');
  assert.deepEqual(bypass.events, []);
  assert.match(bypass.ignored.find(e => e.head === bypassFacts.commit.sha)?.why ?? '', /带新提交/);
  assert.match(bypass.ignored.find(e => e.head === bypassFacts.pulls[0].head.sha)?.why ?? '', /机器人/);
  assert.ok(!replay.stub.calls.some(route => route === allRunsRoute(bypassFacts.middle) || route === `/commits/${bypassFacts.middle}`));
});

test('B02 已开 PR 纯追平：Z1 按真实推送时刻截断连续段', async () => {
  const { summary: { bypass, streak } } = await mergeReplay().compare();
  assert.equal(streak.heads, 1);
  assert.equal(bypass.state, '已判');
  assert.deepEqual(bypass.events.map(e => [e.kind, e.head, e.pr]), [['Z1', bMerge, 1329]]);
  assert.deepEqual(streak.cutBy, bypass.events[0]);
  assert.equal(streak.from, '2026-11-25T12:00:00+08:00');
  assert.match(streak.unmet.join(''), /手工绕过 1/);
});

test('B03 #1325 推送被拒：本机和账本的提交没有远端活动', async () => {
  const previous = process.env.BYPASS_LEDGER;
  process.env.BYPASS_LEDGER = fileURLToPath(new URL('./fixtures/shadow-compare/bypass-1328-1325.json', import.meta.url));
  try {
    const replay = replay1328(1325);
    const { summary: { bypass, streak } } = await replay.compare();
    assert.equal(bypass?.state, '已判');
    assert.deepEqual(bypass.events, []);
    assert.equal(streak.cutBy, null);
    assert.ok(!replay.stub.calls.some(route => route.includes(bypassFacts.entries[0].head)));
  } finally {
    if (previous === undefined) delete process.env.BYPASS_LEDGER;
    else process.env.BYPASS_LEDGER = previous;
  }
});

test('B04 开 PR 前合 main：创建分支或 PR 创建前推送是交活', async () => {
  for (const creationInstead of [true, false]) {
    const replay = mergeReplay({ creationInstead, pushAt: bypassAt('01:50:00'), git: noMerge });
    const { summary: { bypass } } = await replay.compare();
    assert.equal(bypass?.state, '已判');
    assert.deepEqual(bypass.events, []);
    assert.match(bypass.ignored.find(e => e.head === bMerge)?.why ?? '', /建分支|没有打开的 PR/);
  }
});

test('B05 真冲突或结果树不同：判交活', async () => {
  for (const [git, why] of [[() => ({ status: 1 }), /冲突/], [() => ({ status: 0, tree: sha(9900) }), /树不同/]]) {
    const { summary: { bypass } } = await mergeReplay({ git }).compare();
    assert.equal(bypass?.state, '已判');
    assert.deepEqual(bypass.events, []);
    assert.match(bypass.ignored.find(e => e.head === bMerge)?.why ?? '', why);
  }
});

test('B06 机器人 update-branch：按 pusher 判机器人', async () => {
  const replay = mergeReplay({ actor: robot, git: noMerge,
    routes: { [`/commits/${bMerge}`]: { ...bypassCommit(bMerge, bTree, [bBase, bMain]), committer: { login: 'web-flow', type: 'User' } } } });
  const { summary: { bypass } } = await replay.compare();
  assert.equal(bypass?.state, '已判');
  assert.deepEqual(bypass.events, []);
  assert.match(bypass.ignored.find(e => e.head === bMerge)?.why ?? '', /机器人/);
});

test('B07 人工空提交与同树 force_push：Z3 自身不进入连续段', async () => {
  for (const [type, parent] of [['push', bBase], ['force_push', sha(9901)]]) {
    const p = bypassPull(1329, bMerge);
    const pushes = [creation(1, bypassBranch, bBase, bypassAt('02:20:00')),
      activity(2, bypassBranch, bBase, bMerge, bypassAt('02:40:00'), { type })];
    const replay = bypassReplay({ pulls: [p], picked: [{ ...p, heads: [bBase, bMerge] }], pushes,
      commits: [bypassCommit(bMerge, bTree, [parent]), bypassCommit(bBase, bTree, [])] });
    const { summary: { bypass, streak } } = await replay.compare();
    assert.equal(bypass?.state, '已判');
    assert.deepEqual(bypass.events.map(e => [e.kind, e.head]), [['Z3', bMerge]]);
    assert.deepEqual(streak.cutBy, bypass.events[0]);
    assert.equal(streak.heads, 0);
  }
});

const hint = (description, at) => ({ id: 91, context: 'resident-queue/turing (info only)', description, created_at: at });
function rerunReplay({ attempt = bypassFacts.attempt, dispatches = [], statuses = [] } = {}) {
  const head = (attempt ?? dispatches[0]).head_sha;
  const at = '2026-11-24T10:20:00Z';
  const p = bypassPull(1327, head, { created_at: at });
  return bypassReplay({ pulls: [p], picked: [{ ...p, heads: [head] }], pushes: [creation(1, p.head.ref, head, at)],
    routes: { [allRunsRoute(head)]: workflowRuns(...(attempt ? [attempt] : []), ...dispatches), [statusesRoute(head)]: statuses,
      ...(attempt ? { [`/actions/runs/${attempt.id}/attempts/2`]: attempt } : {}) } });
}
const dispatchRun = (id, t) => ({ id, head_sha: bypassFacts.attempt.head_sha, head_branch: branchRef(1327), event: 'workflow_dispatch',
  run_attempt: 1, run_started_at: t, created_at: t, triggering_actor: human, path: '.github/workflows/clued-required-tests.yml' });

test('B08a 真实 attempt 45366274471/2：triggering_actor 是人，计 Z2', async () => {
  const { summary: { bypass } } = await rerunReplay().compare();
  assert.equal(bypass?.state, '已判');
  assert.deepEqual(bypass.events.map(e => [e.kind, e.actor]), [['Z2', human.login]]);
});

test('B08b 同一 attempt 有唯一补跑状态：系统补跑', async () => {
  const statuses = [hint('已自动补跑一次必需测试', '2026-11-24T10:24:14Z')];
  const { summary: { bypass } } = await rerunReplay({ statuses }).compare();
  assert.equal(bypass?.state, '已判');
  assert.deepEqual(bypass.events, []);
  assert.ok(bypass.ignored.some(e => /自动补跑/.test(e.why)));
});

test('B08c workflow_dispatch 有补发状态抵扣，无状态计 Z2', async () => {
  const dispatches = [dispatchRun(4601, '2026-11-24T10:22:00Z')];
  for (const statuses of [[hint('必需测试没有运行，已自动补发一次', '2026-11-24T10:22:10Z')], []]) {
    const { summary: { bypass } } = await rerunReplay({ attempt: null, dispatches, statuses }).compare();
    assert.equal(bypass?.state, '已判');
    assert.deepEqual(bypass.events.map(e => e.kind), statuses.length ? [] : ['Z2']);
  }
});

test('B08d 一条提示对上两次运行：两次都计 Z2 并写明对不唯一', async () => {
  const dispatches = [dispatchRun(4601, '2026-11-24T10:22:00Z')];
  const statuses = [hint('已自动补跑一次必需测试', '2026-11-24T10:24:14Z')];
  const { summary: { bypass } } = await rerunReplay({ dispatches, statuses }).compare();
  assert.equal(bypass?.state, '已判');
  assert.equal(bypass.events.length, 2);
  assert.ok(bypass.events.every(e => e.kind === 'Z2' && e.basis.includes('对不唯一')));
});

test('B09 人工 reopened：断开连续段', async () => {
  const p = bypassPull(1329, bLater);
  const pushes = [creation(1, bypassBranch, bBase, bypassAt('02:20:00')),
    activity(2, bypassBranch, bBase, bLater, bypassAt('04:00:00'), { actor: robot })];
  const events = [{ id: 800, event: 'closed', actor: human, created_at: bypassAt('02:50:00') },
    { id: 801, event: 'reopened', actor: human, created_at: bypassAt('03:30:00') }];
  const replay = bypassReplay({ pulls: [p], picked: [{ ...p, heads: [bBase, bLater] }], pushes,
    routes: { [issueEventsRoute(1329)]: events } });
  const { summary: { bypass, streak } } = await replay.compare();
  assert.equal(bypass?.state, '已判');
  assert.deepEqual(bypass.events.map(e => [e.kind, e.pr]), [['重开', 1329]]);
  assert.deepEqual(streak.cutBy, bypass.events[0]);
  assert.equal(streak.heads, 1);
});

test('B10 --prs 1329- 仍覆盖窗口内更新的 #1325', async () => {
  const { summary: { bypass }, heads } = await mergeReplay({ olderPr: true }).compare();
  assert.equal(bypass?.state, '已判');
  assert.ok(heads.every(h => h.prs.includes(1329)));
  assert.deepEqual(bypass.events.map(e => [e.kind, e.pr]), [['Z1', 1325]]);
});

test('B11 活动读取失败、满页或 Git 缺对象：未判，结果和退出码仍可用', async () => {
  const cases = [
    { routes: { [filteredActivityRoute(bypassBranch, 'push')]: { error: '活动读取失败' } }, why: /活动读取失败/ },
    { routes: { [filteredActivityRoute(bypassBranch, 'branch_creation')]: Array.from({ length: 100 }, (_, id) => creation(id + 1, bypassBranch, bBase, bypassAt('02:20:00'))) }, why: /100 条/ },
    { git: () => ({ status: 128, missing: bMain }), why: /本机缺 .*fetch 后重跑可改判/ },
  ];
  const lines = [];
  const check = async replay => {
    const status = await main(['--prs', '1329-'], { api: replay.stub, git: replay.git, write: line => lines.push(line), now: replay.now });
    const parsed = JSON.parse(lines.pop());
    return { status, parsed };
  };
  const complete = await check(mergeReplay());
  assert.equal(complete.status, 0);
  for (const { why, ...options } of cases) {
    const { status, parsed: { heads, summary: { bypass, streak } } } = await check(mergeReplay(options));
    assert.equal(status, complete.status);
    assert.deepEqual(heads, complete.parsed.heads);
    assert.equal(bypass?.state, '未判');
    assert.match(bypass.reason, why);
    assert.equal(streak.met, false);
    assert.match(streak.unmet.join(''), /手工绕过未判：/);
  }
});

test('B12 --prs 1321- 目标回放：与账本拒推样本逐条核对', async () => {
  const replay = replay1328(1321);
  const lines = [];
  const status = await main(['--prs', '1321-'], { api: replay.stub, git: replay.git, now: replay.now, write: line => lines.push(line) });
  assert.equal(status, 0);
  const { summary: { bypass, line } } = JSON.parse(lines[0]);
  assert.equal(bypass?.state, '已判');
  assert.match(bypass.ignored.find(e => e.head === bypassFacts.commit.sha)?.why ?? '', /带新提交/);
  assert.match(line, /手工绕过 0/);
  assert.deepEqual(bypass.events, []);
  for (const row of bypassFacts.entries) {
    assert.ok(!bypassFacts.activity.some(p => p.after.startsWith(row.head)));
    assert.ok(!bypass.ignored.some(e => e.head.startsWith(row.head)));
  }
});

const dispatchFacts = JSON.parse(readFileSync(new URL('./fixtures/shadow-compare/dispatch-provenance.json', import.meta.url), 'utf8'));

test('B13 #1321 真实常驻补发：当班状态 59831881659 唯一对上运行 45532586038', async () => {
  const { push, run, statuses } = dispatchFacts.companion;
  const p = bypassPull(1321, push.after, { head: { ...bypassPull(1321, push.after).head, ref: run.head_branch } });
  const replay = bypassReplay({ pulls: [p], picked: [{ ...p, heads: [push.after] }], pushes: [push],
    routes: { [allRunsRoute(push.after)]: workflowRuns(run), [statusesRoute(push.after)]: statuses } });
  const { summary: { bypass } } = await replay.compare();
  assert.equal(bypass.state, '已判');
  assert.deepEqual(bypass.events, []);
  assert.match(bypass.ignored.find(e => e.kind === 'Z2')?.why ?? '', /59831881659.*45532586038.*已自动补发/);
});

test('B14 车头 dispatch：合入活动不扩 Z2 head 集，真实 push head 上无唯一状态则计 Z2', async () => {
  const { mainActivity, activity: pushes, run, statuses } = dispatchFacts.front;
  const head = pushes.at(-1).after, branch = pushes[0].ref.slice('refs/heads/'.length);
  const p = bypassPull(1256, head, {
    created_at: '2026-11-23T08:34:36Z', updated_at: '2026-11-23T09:40:38Z',
    head: { ...bypassPull(1256, head).head, ref: branch },
  });
  for (const isPush of [false, true]) {
    const row = isPush ? { ...mainActivity, actor: robot, activity_type: 'push' } : mainActivity;
    const replay = bypassReplay({ pulls: [p], picked: [{ ...p, heads: pushes.map(e => e.after) }], pushes,
      now: '2026-11-23T10:00:00Z',
      routes: { ...filteredActivityRoutes('main', [row], 'day'),
        [allRunsRoute(run.head_sha)]: workflowRuns(run), [statusesRoute(run.head_sha)]: statuses } });
    const { summary: { bypass } } = await replay.compare();
    assert.equal(bypass.state, '已判');
    assert.deepEqual(bypass.events.map(e => [e.kind, e.evidence.runId]), isPush ? [['Z2', run.id]] : []);
    assert.equal(replay.stub.calls.includes(allRunsRoute(run.head_sha)), isPush);
    assert.ok(bypass.ignored.some(e => e.head === head && e.why.includes('机器人')));
  }
});

function activityWindowReplay(hours, period, mainRows, unfiltered = []) {
  const start = bypassAt('02:20:00');
  const now = new Date(Date.parse(start) + hours * 3600_000).toISOString();
  const p = bypassPull(1329, bBase);
  return bypassReplay({ pulls: [p], picked: [{ ...p, heads: [bBase] }],
    pushes: [creation(1, bypassBranch, bBase, start), ...mainRows], now, routes: {
      [`${activityRoute('main')}${period ? `&time_period=${period}` : ''}`]: unfiltered,
      ...filteredActivityRoutes('main', mainRows, period),
    } });
}

for (const [hours, period] of [[22.9, 'day'], [23, 'week'], [166.9, 'week'], [167, '']]) {
  test(`B16 ${hours} 小时窗口：main 与候选分支按活动类型过滤`, async () => {
    const replay = activityWindowReplay(hours, period, []);
    const { summary: { bypass } } = await replay.compare();
    assert.equal(bypass.state, '已判', bypass.reason);
    const calls = replay.stub.calls.filter(route => route.startsWith('/activity?'));
    assert.deepEqual(calls.sort(), [
      ...activityTypes.map(type => filteredActivityRoute('main', type, period)),
      ...activityTypes.map(type => filteredActivityRoute(bypassBranch, type)),
    ].sort());
  });
}

test('B17 一周 main 原始页 100 条 pr_merge：过滤后读到 push 并完成判定', async () => {
  const merges = Array.from({ length: 100 }, (_, i) => activity(i + 2, 'main', bBase, sha(i + 1),
    bypassAt('02:30:00'), { actor: robot, type: 'pr_merge' }));
  const push = activity(102, 'main', bBase, bMain, bypassAt('02:40:00'), { actor: robot });
  const replay = activityWindowReplay(166.9, 'week', [push], merges);
  const { summary: { bypass } } = await replay.compare();
  assert.equal(bypass.state, '已判', bypass.reason);
  assert.deepEqual(bypass.events, []);
  assert.ok(bypass.ignored.some(e => e.head === bMain && e.why === '机器人推送'));
});

test('B18 main 过滤后的 force_push 单页满 100 条：未判', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => activity(i + 2, 'main', bBase, sha(i + 1),
    bypassAt('02:30:00'), { actor: robot, type: 'force_push' }));
  const { summary: { bypass } } = await activityWindowReplay(23, 'week', rows).compare();
  assert.equal(bypass.state, '未判');
  assert.match(bypass.reason, /main.*force_push.*100 条/);
});

test('B19 窗口内更新的同仓 PR 分支没有 tip 活动证据：未判', async () => {
  const p = bypassPull(1329, bBase);
  const replay = bypassReplay({ pulls: [p, bypassPull(1325, bLater)], picked: [{ ...p, heads: [bBase] }],
    pushes: [creation(1, bypassBranch, bBase, bypassAt('02:20:00'))] });
  const { summary: { bypass } } = await replay.compare();
  assert.equal(bypass.state, '未判');
  assert.match(bypass.reason, /topic\/1325.*缺.*活动/);
});

test('B20 #1307 同秒常驻补发结果不确定：唯一对上 45503124414 并抵扣 Z2', async () => {
  const { push, runs, statuses } = JSON.parse(readFileSync(new URL('./fixtures/shadow-compare/dispatch-1307.json', import.meta.url), 'utf8'));
  const p = bypassPull(1307, push.after, { created_at: '2026-11-24T22:00:00Z', updated_at: '2026-11-24T23:00:00Z' });
  p.head.ref = push.ref.slice('refs/heads/'.length);
  const replay = bypassReplay({ pulls: [p], picked: [{ ...p, heads: [push.after] }], pushes: [push],
    now: '2026-11-24T23:00:00Z', routes: { [allRunsRoute(push.after)]: runs, [statusesRoute(push.after)]: statuses } });
  const { summary: { bypass } } = await replay.compare();
  assert.equal(bypass.state, '已判', bypass.reason);
  assert.deepEqual(bypass.events, []);
  assert.match(bypass.ignored.find(e => e.kind === 'Z2')?.why ?? '', /59818221959.*45503124414.*自动补发结果不确定/);
});

test('B21 07:38 回放：补发三秒后 head 被取代，运行标记独立证明自动补发', async () => {
  const oldHead = `25c4ed286${'0'.repeat(31)}`, newHead = `6bafd6489${'0'.repeat(31)}`;
  const p = bypassPull(1323, newHead, { created_at: '2026-11-24T23:00:00Z', updated_at: '2026-11-24T23:38:14Z' });
  const title = 'clued-resident-dispatch/v1 turing 3f9b8957-8ee6-4d70-b45c-75679e476714';
  const run = { ...dispatchRun(4602, '2026-11-24T23:38:11Z'), head_sha: oldHead, head_branch: p.head.ref,
    status: 'completed', conclusion: 'cancelled', updated_at: '2026-11-24T23:38:27Z', display_title: title };
  const pushes = [creation(1, p.head.ref, oldHead, '2026-11-24T23:16:00Z'),
    activity(2, p.head.ref, oldHead, newHead, '2026-11-24T23:38:14Z', { actor: robot })];
  const replay = (run, routes = {}) => bypassReplay({ pulls: [p], picked: [{ ...p, heads: [oldHead, newHead] }], pushes,
    now: '2026-11-25T00:00:00Z', routes: { [allRunsRoute(oldHead)]: workflowRuns(run), ...routes } });
  const staleStatus = [hint('当班：等必需测试', '2026-11-24T23:35:33Z')];
  const withStatus = replay(run, { [statusesRoute(oldHead)]: staleStatus });
  for (const sample of [withStatus, replay(run)]) {
    const { summary: { bypass } } = await sample.compare();
    assert.equal(bypass.state, '已判', bypass.reason);
    assert.deepEqual(bypass.events, []);
    assert.match(bypass.ignored.find(e => e.kind === 'Z2')?.why ?? '', /4602:1.*自动补发.*turing.*3f9b8957/);
    assert.ok(!sample.stub.calls.includes(statusesRoute(oldHead)));
  }

  const attempt2 = { ...run, path: `${run.path}@refs/heads/${p.head.ref}`, run_attempt: 2,
    run_started_at: '2026-11-24T23:39:00Z' };
  const decide = async (run, routes = {}) => (await replay(run, { [statusesRoute(oldHead)]: staleStatus, ...routes }).compare()).summary.bypass;
  for (const manual of [{ ...run, display_title: 'clued-required-tests' }, { ...run, display_title: `${title} extra` },
    { ...run, display_title: 'clued-resident-dispatch/v1 turing' }, { ...run, path: '.github/workflows/other.yml' }]) {
    const bypass = await decide(manual);
    assert.equal(bypass.state, '已判', bypass.reason);
    assert.deepEqual(bypass.events.map(e => [e.kind, e.evidence.attempt]), [['Z2', 1]]);
  }
  const rerun = await decide(attempt2, { [`/actions/runs/${run.id}/attempts/1`]: run, [`/actions/runs/${run.id}/attempts/2`]: attempt2 });
  assert.equal(rerun.state, '已判', rerun.reason);
  assert.deepEqual(rerun.events.map(e => [e.kind, e.evidence.attempt]), [['Z2', 2]]);
  assert.match(rerun.ignored.find(e => e.kind === 'Z2')?.why ?? '', /4602:1.*自动补发/);
});

test('B15 实际 merge-tree：重做结果与 Git 合并同树，原对象库、工作树和 ref 未写入', async t => {
  const { localMergeTree } = await import('./bypass-events.mjs');
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-merge-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const shellGit = (...args) => spawnSync('git', ['-c', 'user.name=Shadow Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const git = (...args) => {
    const r = shellGit(...args);
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    return r.stdout.trim();
  };
  git('init', '--initial-branch=main');
  git('commit', '--allow-empty', '-m', 'Base');
  git('checkout', '-b', 'topic');
  writeFileSync(join(cwd, 'topic.txt'), 'topic\n');
  git('add', 'topic.txt');
  git('commit', '-m', 'Topic');
  const topic = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  writeFileSync(join(cwd, 'main.txt'), 'main\n');
  git('add', 'main.txt');
  git('commit', '-m', 'Main');
  const main = git('rev-parse', 'HEAD');

  const out = localMergeTree(topic, main, { cwd });
  assert.equal(out.status, 0);
  assert.notEqual(shellGit('cat-file', '-e', out.tree).status, 0);
  assert.equal(git('rev-parse', 'HEAD'), main);
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(localMergeTree(topic, sha(99), { cwd }), { missing: sha(99) });

  git('checkout', 'topic');
  git('merge', '--no-edit', 'main');
  assert.equal(git('rev-parse', 'HEAD^{tree}'), out.tree);
});
