// 非必需检查 hosted-ci-suites-windows-duration（任务 3435f8bf 块 4；PLAN-hosted-windows-speed-20261123 §3.2、§4 V4）。
// 只读、零 npm 依赖。读本次运行（本次尝试）的作业记录，算托管 Windows 套件从最早开始到最晚结束的墙钟：超过 10 分钟红，
// 各作业时长写进 step summary。不进任何规则集：只显红、不挡合入，也不在影子比对的七项里（shadow-compare.mjs PAIRS）。
// 读不到作业记录是辅助功能出错，只告警、不判（看板规则“辅助功能出错只能不做”）。
//
// 量哪些作业：分片 hosted-ci-suites-windows-shard-<n>（跳过的不算）。一片都没有时量同名单作业 hosted-ci-suites-windows：
// 那是分片之前的运行（V4 的夹具 45201050943 就是这种）。分片时不量同名的汇总作业：它与本作业同时起跑，本作业读记录时
// 它可能还没结束，计不计入全看先后，数字就不稳；它只做一次判断，几秒钟。
//
//   node scripts/ci/hosted-windows-duration.mjs
//     读 GITHUB_API_URL、GITHUB_REPOSITORY、GITHUB_RUN_ID、GITHUB_RUN_ATTEMPT、GITHUB_TOKEN（actions: read），
//     写 GITHUB_STEP_SUMMARY。退出 0：未超或量不了；退出 1：超过上限。
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMIT_MS = 10 * 60_000;
export const WHOLE = 'hosted-ci-suites-windows';
const SHARD = /^hosted-ci-suites-windows-shard-\d+$/;
const PAGE = 100;
const MAX_PAGES = 10;

const beijing = n => new Date(n + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+08:00');
const minutes = ms => (ms / 60_000).toFixed(1);

// 本次运行的作业记录（GitHub jobs API 的 jobs 数组）-> 量到的墙钟；没有可量的作业时 null。
export function windowsSpan(jobs) {
  if (!Array.isArray(jobs)) throw new Error('作业记录不是数组');
  const shards = jobs.filter(job => SHARD.test(job?.name ?? ''));
  const measured = (shards.length > 0 ? shards : jobs.filter(job => job?.name === WHOLE))
    .filter(job => job.conclusion !== 'skipped')
    .map(job => ({ name: job.name, conclusion: job.conclusion ?? job.status ?? null,
      start: Date.parse(job.started_at ?? ''), end: Date.parse(job.completed_at ?? '') }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const timed = measured.filter(job => Number.isFinite(job.start) && Number.isFinite(job.end) && job.end >= job.start);
  if (timed.length === 0) return null;
  const start = Math.min(...timed.map(job => job.start));
  const end = Math.max(...timed.map(job => job.end));
  return { start, end, ms: end - start, jobs: measured, untimed: measured.length - timed.length };
}

// 墙钟 -> 退出码、注释行（::error/::notice）和 step summary 的 Markdown。
export function verdict(span, limit = LIMIT_MS) {
  if (!span) {
    return { exit: 0, annotation: `::notice title=${WHOLE}-duration::没有可量的 Windows 套件作业（全部跳过或没有开始与结束时间），不判时长`,
      summary: `### ${WHOLE} 墙钟\n\n没有可量的作业，不判。\n` };
  }
  const over = span.ms > limit;
  const head = `从最早开始到最晚结束 ${minutes(span.ms)} 分钟（上限 ${minutes(limit)} 分钟）`;
  const rows = span.jobs.map(job => {
    const timed = Number.isFinite(job.start) && Number.isFinite(job.end) && job.end >= job.start;
    return `| ${job.name} | ${job.conclusion ?? ''} | ${timed ? beijing(job.start) : '—'} | ${timed ? beijing(job.end) : '—'} | ${timed ? `${minutes(job.end - job.start)} 分钟` : '没有开始或结束时间'} |`;
  });
  const summary = [`### ${WHOLE} 墙钟`, '', `${head}：**${over ? '超限' : '未超'}**`, '',
    '| 作业 | 结论 | 开始（北京） | 结束（北京） | 时长 |', '|---|---|---|---|---|', ...rows,
    ...(span.untimed > 0 ? ['', `${span.untimed} 个作业没有开始或结束时间，不计入。`] : []), ''].join('\n');
  return { exit: over ? 1 : 0, summary,
    annotation: over ? `::error title=${WHOLE}-duration::${head}，超限（非必需检查，不挡合入）` : `${head}，未超` };
}

// 本次尝试的全部作业；读不到或分页不完整时抛错。
export async function readJobs({ env, fetchImpl = fetch }) {
  const { GITHUB_API_URL: api = 'https://api.github.com', GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run,
    GITHUB_RUN_ATTEMPT: attempt = '1', GITHUB_TOKEN: token } = env;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !/^\d+$/.test(run ?? '') || !/^\d+$/.test(attempt)) {
    throw new Error('缺 GITHUB_REPOSITORY、GITHUB_RUN_ID 或 GITHUB_RUN_ATTEMPT');
  }
  if (!token) throw new Error('缺 GITHUB_TOKEN');
  const jobs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchImpl(`${api}/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=${PAGE}&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!response.ok) throw new Error(`jobs API 返回 ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.jobs) || !Number.isSafeInteger(body.total_count)) throw new Error('jobs API 返回的不是作业列表');
    jobs.push(...body.jobs);
    if (body.jobs.length < PAGE) {
      if (jobs.length !== body.total_count) throw new Error(`作业列表不完整：${jobs.length}/${body.total_count}`);
      return jobs;
    }
  }
  throw new Error('作业列表超过分页上限');
}

export async function main({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  let jobs;
  try {
    jobs = await readJobs({ env, fetchImpl });
  } catch (error) {
    log(`::warning title=${WHOLE}-duration::读不到本次运行的作业记录（${error.message}），不判时长`);
    return 0;
  }
  const result = verdict(windowsSpan(jobs));
  log(result.annotation);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.summary}\n`);
  return result.exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
