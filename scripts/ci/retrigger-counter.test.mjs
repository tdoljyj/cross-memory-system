import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collect, ghReader, main } from './retrigger-counter.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/retrigger-counter/api.json', import.meta.url)));
const options = { repo: 'tdoljyj/cross-memory-system', since: '2026-11-16T08:00:00+08:00', until: '2026-11-17T08:00:00+08:00', automationActors: ['clued-companion'] };
function api(overrides = {}) {
  const routes = { ...structuredClone(fixture), ...overrides };
  const calls = [];
  return { calls, async get(route) {
    calls.push(route);
    assert.ok(Object.hasOwn(routes, route), `未录制 API 请求：${route}`);
    if (routes[route]?.error) throw new Error(routes[route].error);
    return structuredClone(routes[route]);
  } };
}
const CLI = fileURLToPath(new URL('./retrigger-counter.mjs', import.meta.url)); // 不依赖运行时的工作目录
const bucket = (manual, automatic, unknown = 0) => ({ manual, automatic, unknown, total: manual + automatic + unknown });

test('录制响应：按 attempt 时间统计，Owner 身份的 companion 提示只抵扣一次，提交跨 PR 去重', async () => {
  const report = await collect({ ...options, api: api() });
  assert.deepEqual(report.counts.reruns, bucket(1, 2));
  assert.deepEqual(report.counts.empty_commits, bucket(1, 1));
  assert.deepEqual(report.counts.main_merges, bucket(1, 1));
  assert.deepEqual(report.counts.reopens, bucket(2, 1));
  assert.equal(report.window.since, options.since);
  assert.equal(report.window.until, options.until);
  assert.ok(report.events.some(e => e.kind === 'reruns' && e.id === '10:2' && e.basis === 'companion-status'));
  assert.ok(!report.events.some(e => e.id === '10:4')); // until 是开区间
  assert.equal(report.prs.length, 2);
});

test('提示不能跨 workflow、head 或时间误抵扣；身份缺失必须列未知', async () => {
  const mock = api({
    '/commits/h/statuses?per_page=100&page=1': [
      { id: 1, context: 'unrelated', description: '已自动补跑一次必需测试', created_at: '2026-11-16T01:01:00Z' },
    ],
    '/actions/runs/10/attempts/3': { id: 10, run_attempt: 3, head_sha: 'h', run_started_at: '2026-11-16T03:00:00Z', triggering_actor: null },
  });
  const report = await collect({ ...options, api: mock });
  assert.deepEqual(report.counts.reruns, bucket(1, 1, 1));
});

test('API 失败、计数截断和分页失控不得输出成功的零计数', async () => {
  await assert.rejects(collect({ ...options, api: api({ '/actions/runs?per_page=100&page=1': { error: 'HTTP 403' } }) }), /403/);
  await assert.rejects(collect({ ...options, api: api({ '/actions/runs?per_page=100&page=1': { total_count: 1001, workflow_runs: [] } }) }), /不完整/);
  await assert.rejects(collect({ ...options, maxPages: 1, api: api({ '/actions/runs?per_page=100&page=1': { total_count: 101, workflow_runs: Array(100).fill(fixture['/actions/runs?per_page=100&page=1'].workflow_runs[0]) } }) }), /分页/);
});

test('gh 传输只发显式 GET，参数无 shell；CLI 成功与失败都只输出一行 JSON', async () => {
  const calls = [];
  const reader = ghReader({ repo: options.repo, spawn: (exe, argv, opts) => {
    calls.push({ exe, argv, opts }); return { status: 0, stdout: '{"ok":true}' };
  } });
  assert.deepEqual(await reader.get('/actions/runs?per_page=100&page=1'), { ok: true });
  assert.deepEqual(calls[0].argv.slice(0, 3), ['api', '--method', 'GET']);
  assert.equal(calls[0].opts.shell, false);
  const lines = [];
  assert.equal(await main(['--since', options.since, '--until', options.until, '--automation-actor', 'clued-companion'], { api: api(), write: s => lines.push(s) }), 0);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).status, 'ok');
  const bad = [];
  assert.equal(await main(['--since', '2026-11-16', '--until', options.until], { api: api(), write: s => bad.push(s) }), 1);
  assert.equal(JSON.parse(bad[0]).status, 'error');
  assert.equal(bad.length, 1);
});

test('实际 CLI 错误出口是一行可解析 JSON，且不启动 gh', () => {
  const r = spawnSync(process.execPath, [CLI, '--unknown'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(r.stdout).status, 'error');
});

test('实际 CLI 从录制 gh GET 响应输出完整计数，且没有额外标准输出', () => {
  // 通过 file URL 读录制数据；只在测试子进程替换 gh，生产 CLI 不提供假数据旁路。
  const source = `import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {readFileSync} from 'node:fs';
    const fixture=JSON.parse(readFileSync(new URL(${JSON.stringify(new URL('./fixtures/retrigger-counter/api.json', import.meta.url).href)}),'utf8'));
    cp.spawnSync=(exe,argv)=>{
      if(exe!=='gh'||argv[0]!=='api'||argv[1]!=='--method'||argv[2]!=='GET')throw Error('非只读调用');
      const route=argv.at(-1).replace('repos/tdoljyj/cross-memory-system','')||'/';
      if(!Object.hasOwn(fixture,route))throw Error('未录制 '+route);
      return {status:0,stdout:JSON.stringify(fixture[route])};
    };syncBuiltinESMExports();`;
  const r = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(source)}`,
    CLI, '--since', options.since, '--until', options.until, '--automation-actor', 'clued-companion'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(r.stdout).counts.reruns, bucket(1, 2));
});

test('跨页完整读取：旧 run 的新 attempt、第二页 PR 时间线均不遗漏', async () => {
  const initial = fixture['/actions/runs?per_page=100&page=1'];
  const timeline = fixture['/issues/1/timeline?per_page=100&page=1'];
  const mock = api({
    '/actions/runs?per_page=100&page=1': { total_count: 102, workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, run_attempt: 1, head_sha: 'old' })) },
    '/actions/runs?per_page=100&page=2': { ...initial, total_count: 102 },
    '/issues/1/timeline?per_page=100&page=1': Array.from({ length: 100 }, (_, i) => ({ id: 5000 + i, event: 'commented' })),
    '/issues/1/timeline?per_page=100&page=2': timeline,
  });
  const report = await collect({ ...options, api: mock });
  assert.deepEqual(report.counts.reruns, bucket(1, 2));
  assert.deepEqual(report.counts.reopens, bucket(2, 1));
  assert.ok(mock.calls.includes('/actions/runs?per_page=100&page=2'));
});

test('旧 status 只匹配窗口前的 attempt；多个候选则未知，不猜自动', async () => {
  const old = api({
    '/actions/runs/10/attempts/2': { ...fixture['/actions/runs/10/attempts/2'], run_started_at: '2026-11-15T23:00:00Z' },
    '/commits/h/statuses?per_page=100&page=1': [{ context: 'resident-queue/TURING (info only)', description: '已自动补跑一次必需测试', created_at: '2026-11-15T23:01:00Z' }],
  });
  assert.deepEqual((await collect({ ...options, api: old })).counts.reruns, bucket(1, 1));
  const ambiguous = api({
    '/actions/runs/10/attempts/3': { ...fixture['/actions/runs/10/attempts/3'], run_started_at: '2026-11-16T01:00:30Z' },
  });
  assert.deepEqual((await collect({ ...options, api: ambiguous })).counts.reruns, bucket(0, 1, 2));
});

test('非 main 的第二父提交、真正有内容的提交不计；大 PR 和缺失时间拒绝', async () => {
  const changed = api({ '/commits/p0': { commit: { tree: { sha: 'different' } } }, '/compare/base...main': { status: 'diverged' } });
  const report = await collect({ ...options, api: changed });
  assert.deepEqual(report.counts.empty_commits, bucket(0, 0));
  assert.deepEqual(report.counts.main_merges, bucket(0, 0));
  await assert.rejects(collect({ ...options, api: api({ '/pulls/1': { number: 1, commits: 251 } }) }), /250/);
  await assert.rejects(collect({ ...options, api: api({ '/actions/runs/10/attempts/2': { ...fixture['/actions/runs/10/attempts/2'], run_started_at: null } }) }), /时间/);
});

test('PR 按更新时间越过窗口后停止列页，零事件窗口保留真实零值', async () => {
  const mock = api({
    '/actions/runs?per_page=100&page=1': { total_count: 0, workflow_runs: [] },
    '/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1': Array.from({ length: 100 }, (_, i) => ({ number: i + 1, updated_at: '2026-11-15T00:00:00Z' })),
    '/branches?per_page=100&page=1': [],
  });
  const report = await collect({ ...options, api: mock });
  for (const c of Object.values(report.counts)) assert.deepEqual(c, bucket(0, 0));
  assert.equal(mock.calls.some(route => route.includes('page=2')), false);
});
