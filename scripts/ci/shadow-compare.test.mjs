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
  for (const check of [...Object.keys(HOSTED), 'kooyumi-work-admission']) {
    const sides = {
      framework: [run(check, FRAMEWORK_PINS[check], 'success', { started, completed })],
      hosted: [check === 'kooyumi-work-admission' ? run(check, 5164952, 'success', { started, completed: hostedCompleted })
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
    ...Object.entries(HOSTED).map(([check, hosted]) => [check, hosted, 15368]), ['kooyumi-work-admission', 'kooyumi-work-admission', 5164952]]);
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
  assert.deepEqual(report.summary.counts, { 一致: 1, 不一致: 0, 未知: 0, 在跑: 0 });
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

test('一边缺检查判未知，不判一致', async () => {
  const s = sha(3);
  const runs = greenRuns({ override: (check, side) => (check === 'trivy' && side === 'hosted') || (check === 'gitleaks' && side === 'framework') ? undefined : null });
  const [head] = (await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW })).heads;
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
    if (check === 'kooyumi-work-admission' && side === 'hosted') return undefined;
    // 托管 gitleaks 由别的 App 发：不是托管检查。
    if (check === 'gitleaks' && side === 'hosted') return [run('hosted-gitleaks', 5368905)];
    return null;
  } });
  const [head] = (await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW })).heads;
  assert.equal(pairOf(head, 'kooyumi-work-admission').reason, '托管缺检查');
  assert.equal(pairOf(head, 'gitleaks').reason, '托管缺检查');
  assert.equal(head.verdict, '未知');
});

test('托管准入红、框架准入绿：同名两条按来源分开比', async () => {
  const s = sha(5);
  const runs = greenRuns({ override: (check, side) => check === 'kooyumi-work-admission' && side === 'hosted'
    ? [run('kooyumi-work-admission', 5164952, 'failure', { title: 'Grant missing' })] : null });
  const [head] = (await compare({ heads: [s], api: api(headRoutes([[s, runs]])), now: NOW })).heads;
  assert.equal(pairOf(head, 'kooyumi-work-admission').verdict, '不一致');
  assert.equal(pairOf(head, 'kooyumi-work-admission').framework.conclusion, 'success');
  assert.equal(pairOf(head, 'kooyumi-work-admission').hosted.conclusion, 'failure');
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
  routes['/pulls?state=all&sort=created&direction=desc&per_page=100&page=1'] = prs.map(p => ({ number: p.number, state: p.state, head: { sha: p.commits.at(-1).sha } }));
  for (const p of prs) routes[`/pulls/${p.number}/commits?per_page=100&page=1`] = p.commits.map(c => ({ sha: c.sha, commit: { committer: { date: c.date } } }));
  for (const [s, runs] of Object.entries(checks)) routes[checksRoute(s)] = page(runs);
  return routes;
}

test('PR 范围：没有任何检查的中间提交不算 head；有检查但名字都不对的 head 判未知，不漏掉；不是当前 head 的未完成判未知', async () => {
  const a = sha(21), b = sha(22), c = sha(23), d = sha(24), e = sha(25), f = sha(26);
  const pending = greenRuns({ started: '2026-11-24T01:00:00Z', completed: '2026-11-24T01:10:00Z', hostedCompleted: '2026-11-24T01:12:00Z',
    override: (check, side) => check === 'trivy' && side === 'framework' ? [run('trivy', 5368905, null, { status: 'queued', started: '2026-11-24T01:00:00Z' })] : null });
  const routes = prRoutes([
    { number: 1302, state: 'open', commits: [{ sha: c, date: '2026-11-24T01:00:00Z' }, { sha: d, date: '2026-11-25T01:00:00Z' }] },
    { number: 1301, state: 'closed', commits: [{ sha: a, date: '2026-11-23T00:00:00Z' }, { sha: b, date: '2026-11-23T00:30:00Z' }] },
    { number: 1300, state: 'closed', commits: [{ sha: e, date: '2026-11-22T00:00:00Z' }, { sha: f, date: '2026-11-22T01:00:00Z' }] },
  ], { [a]: [], [b]: greenRuns(), [c]: pending,
    [d]: greenRuns({ started: '2026-11-25T01:00:00Z', completed: '2026-11-25T01:10:00Z', hostedCompleted: '2026-11-25T01:12:00Z' }),
    // 工作流改坏、作业名成了表达式原文（#1230 实况）：这一 head 真跑过，必须报出来。
    [e]: [], [f]: [run("needs.admission-gate.outputs.admitted == 'true' && 'ci-suites' || 'ci-suites-skipped'", 15368, 'success', { started: '2026-11-22T01:00:00Z' })] });
  routes['/pulls?state=all&sort=created&direction=desc&per_page=100&page=1'].unshift({ number: 1303, state: 'open', head: { sha: sha(99) } });
  const report = await compare({ prs: { from: 1300, to: 1302 }, api: api(routes), now: NOW });
  assert.deepEqual(report.heads.map(h => [h.sha, h.prs, h.verdict]), [[f, [1300], '未知'], [b, [1301], '一致'], [c, [1302], '未知'], [d, [1302], '一致']]);
  assert.ok(report.heads[0].pairs.every(p => p.reason === '两边都缺检查'));
  assert.equal(report.heads[0].at, '2026-11-22T09:00:00+08:00');
  assert.equal(pairOf(report.heads[2], 'trivy').reason, '框架未完成（queued），已不是 PR 的当前 head');
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
