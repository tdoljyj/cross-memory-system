// hosted-ci-suites-windows-duration 的计算（任务 3435f8bf 块 4，PLAN-hosted-windows-speed-20261123 §4 V4）。
// 夹具 fixtures/hosted-run-45201050943-jobs.json 是运行 45201050943 的 jobs API 原样记录（gh api .../runs/45201050943/jobs，
// 2026-11-24 读取）：分片之前的单作业 hosted-ci-suites-windows，北京 23:04:17–23:27:22，23.1 分钟，应红。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LIMIT_MS, main, readJobs, verdict, windowsSpan } from './hosted-windows-duration.mjs';

const RUN_45201050943 = JSON.parse(readFileSync(new URL('./fixtures/hosted-run-45201050943-jobs.json', import.meta.url), 'utf8'));

const job = (name, start, end, extra = {}) => ({ name, status: 'completed', conclusion: 'success',
  started_at: start, completed_at: end, ...extra });
const at = minute => new Date(Date.UTC(2026, 10, 24, 2, 0, 0) + minute * 60_000).toISOString().replace('.000Z', 'Z');

test('V4：运行 45201050943 的作业记录量出 23.1 分钟，超过 10 分钟，红', () => {
  const span = windowsSpan(RUN_45201050943.jobs);
  assert.ok(span, '应量到 hosted-ci-suites-windows');
  assert.deepEqual(span.jobs.map(j => j.name), ['hosted-ci-suites-windows'], '分片之前只量同名单作业，不量其他六项');
  assert.equal(span.ms, (23 * 60 + 5) * 1000);
  const result = verdict(span);
  assert.equal(result.exit, 1);
  assert.match(result.annotation, /^::error title=hosted-ci-suites-windows-duration::从最早开始到最晚结束 23\.1 分钟（上限 10\.0 分钟），超限/);
  assert.match(result.summary, /23\.1 分钟（上限 10\.0 分钟）：\*\*超限\*\*/);
  assert.match(result.summary, /\| hosted-ci-suites-windows \| success \| 2026-11-23T23:04:17\+08:00 \| 2026-11-23T23:27:22\+08:00 \| 23\.1 分钟 \|/);
});

test('分片时量各片最早开始到最晚结束；同名汇总作业、时长作业和其他作业都不计入', () => {
  const jobs = [
    job('hosted-ci-suites-windows-shard-1', at(0), at(7)),
    job('hosted-ci-suites-windows-shard-2', at(0.5), at(8.5)),
    job('hosted-ci-suites-windows-shard-3', at(1), at(6)),
    job('hosted-ci-suites-windows-shard-4', at(0.2), at(5)),
    // 汇总作业读记录时可能已结束：它晚于各片，计入就会多出这段。
    job('hosted-ci-suites-windows', at(9), at(25)),
    job('hosted-ci-suites-windows-duration', at(9), null, { status: 'in_progress', conclusion: null }),
    job('hosted-ci-suites', at(0), at(30)),
  ];
  const span = windowsSpan(jobs);
  assert.deepEqual(span.jobs.map(j => j.name), [1, 2, 3, 4].map(n => `hosted-ci-suites-windows-shard-${n}`));
  assert.equal(span.ms, 8.5 * 60_000);
  const result = verdict(span);
  assert.equal(result.exit, 0);
  assert.match(result.summary, /8\.5 分钟（上限 10\.0 分钟）：\*\*未超\*\*/);
});

test('有一片晚开（排队）把墙钟拉过 10 分钟即红；正好 10 分钟不红', () => {
  const late = [job('hosted-ci-suites-windows-shard-1', at(0), at(6)), job('hosted-ci-suites-windows-shard-2', at(5), at(10.5))];
  assert.equal(verdict(windowsSpan(late)).exit, 1);
  const edge = [job('hosted-ci-suites-windows-shard-1', at(0), at(10))];
  assert.equal(windowsSpan(edge).ms, LIMIT_MS);
  assert.equal(verdict(windowsSpan(edge)).exit, 0);
});

test('失败、取消的片照样计时；跳过的片和没有时间的片不计入，并写明', () => {
  const jobs = [
    job('hosted-ci-suites-windows-shard-1', at(0), at(4), { conclusion: 'failure' }),
    job('hosted-ci-suites-windows-shard-2', at(0), at(12), { conclusion: 'cancelled' }),
    job('hosted-ci-suites-windows-shard-3', at(0), at(0), { conclusion: 'skipped' }),
    job('hosted-ci-suites-windows-shard-4', null, null, { conclusion: 'cancelled' }),
  ];
  const span = windowsSpan(jobs);
  assert.equal(span.ms, 12 * 60_000);
  assert.equal(span.untimed, 1);
  const result = verdict(span);
  assert.equal(result.exit, 1);
  assert.match(result.summary, /1 个作业没有开始或结束时间，不计入/);
  assert.match(result.summary, /\| hosted-ci-suites-windows-shard-4 \| cancelled \| — \| — \| 没有开始或结束时间 \|/);
});

test('没有可量的作业（全部跳过或没跑）不判，退出 0', () => {
  for (const jobs of [[], [job('hosted-ci-suites', at(0), at(1))],
    [job('hosted-ci-suites-windows-shard-1', at(0), at(0), { conclusion: 'skipped' })]]) {
    assert.equal(windowsSpan(jobs), null);
    const result = verdict(null);
    assert.equal(result.exit, 0);
    assert.match(result.annotation, /^::notice /);
  }
  assert.throws(() => windowsSpan(undefined), /不是数组/);
});

const ENV = { GITHUB_API_URL: 'https://api.example', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_TOKEN: 't' };
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('readJobs 读本次尝试的作业、逐页读完，条数对不上即抛错', async () => {
  const urls = [];
  const page1 = Array.from({ length: 100 }, (_, i) => job(`j${i}`, at(0), at(1)));
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer t');
    return reply(url.endsWith('page=1') ? { total_count: 101, jobs: page1 } : { total_count: 101, jobs: [job('last', at(0), at(1))] });
  };
  const jobs = await readJobs({ env: ENV, fetchImpl });
  assert.equal(jobs.length, 101);
  assert.deepEqual(urls, [1, 2].map(p => `https://api.example/repos/o/r/actions/runs/42/attempts/2/jobs?per_page=100&page=${p}`));
  await assert.rejects(readJobs({ env: ENV, fetchImpl: async () => reply({ total_count: 3, jobs: [job('a', at(0), at(1))] }) }), /不完整/);
  await assert.rejects(readJobs({ env: ENV, fetchImpl: async () => reply({}, 403) }), /403/);
  await assert.rejects(readJobs({ env: { ...ENV, GITHUB_TOKEN: '' } }), /GITHUB_TOKEN/);
  await assert.rejects(readJobs({ env: { ...ENV, GITHUB_RUN_ID: '42/../1' } }), /GITHUB_RUN_ID/);
});

test('main：超限退出 1 并写 step summary；读不到记录只告警、退出 0', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hosted-windows-duration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = path.join(dir, 'summary.md');
  const lines = [];
  const code = await main({ env: { ...ENV, GITHUB_STEP_SUMMARY: summary }, log: line => lines.push(line),
    fetchImpl: async () => reply(RUN_45201050943) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /::error title=hosted-ci-suites-windows-duration::.*23\.1 分钟/);
  assert.match(readFileSync(summary, 'utf8'), /\*\*超限\*\*/);
  const warned = [];
  assert.equal(await main({ env: ENV, log: line => warned.push(line), fetchImpl: async () => { throw new Error('network down'); } }), 0);
  assert.match(warned.join('\n'), /^::warning title=hosted-ci-suites-windows-duration::读不到本次运行的作业记录（network down）/);
});
