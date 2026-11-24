#!/usr/bin/env node
// 第 18 代故障转移演练的编排入口（任务 04f9b91b，D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 4、6、7 节）。DESK 前台跑。
//
//   node work/independent-ci-resident-v1/drill/failover-drill.mjs gate --drill-id <id> --in <gate.json> --release <放行文件> --shadow-prs <起点>- [--out-dir D:/w/tmp]
//     核 A1–A7、I1–I6，全过才写放行文件（内容只有演练编号）。I1、I2、I3、I5 本入口自己读（gh、shadow-compare、Get-VM，都只读）；
//     页（clued_resident_failover_v1）、两台 status.json、候选（A5）、DESK 推送队列（I6）由 DESK 读好写进 --in（字段见
//     failover-drill-verdict.mjs 开头）。--in 里已有的 idle 项不再读。
//   node work/independent-ci-resident-v1/drill/failover-drill.mjs verdict --drill-id <id> --in <drill.json> [--out-dir D:/w/tmp]
//     按 B1–B11 出结论。
// 两个子命令都把结论写成 <out-dir>/failover-drill-<id>-<gate|verdict>.json。退出码：0 PASS，1 FAIL，3 未判定，2 用法错。
// 读取失败按网络抖动重试（3 次，间隔 5 秒）；仍读不到的一项判“未判定”，不放行、不判 PASS。本入口不写库、不推送、不碰节点。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { drillVerdict, gateVerdict } from './failover-drill-verdict.mjs';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXIT = { PASS: 0, FAIL: 1, UNDETERMINED: 3 };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

async function retry(fn, { tries = 3, gapMs = 5000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(gapMs); }
  }
  throw last;
}
const json = async (file, args, opts = {}) => JSON.parse((await run(file, args, { cwd: REPO_ROOT, maxBuffer: 64 << 20, windowsHide: true, ...opts })).stdout);

// The four idle reads the entry makes itself. Each one that still fails is left out (its check is then undetermined) and named in `readErrors`.
export async function collectIdle({ shadowPrs, readers = defaultReaders(), retryOpts } = {}) {
  const idle = {}, readErrors = {};
  const plan = {
    runsInProgress: () => readers.runs('in_progress'),
    runsQueued: () => readers.runs('queued'),
    prs: () => readers.prs(),
    shadow: () => readers.shadow(shadowPrs),
    vms: () => readers.vms(),
  };
  for (const [key, read] of Object.entries(plan)) {
    try { idle[key] = await retry(read, retryOpts); } catch (e) { readErrors[key] = String(e?.message ?? e).slice(0, 300); }
  }
  return { idle, readErrors };
}

export function defaultReaders() {
  return {
    runs: status => json('gh', ['run', 'list', '--status', status, '--limit', '5', '--json', 'databaseId,name,status,createdAt']),
    prs: () => json('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,isDraft,statusCheckRollup']),
    shadow: async prs => {
      if (!prs) throw new Error('没给 --shadow-prs');
      const { stdout } = await run(process.execPath, ['scripts/ci/shadow-compare.mjs', '--prs', prs], { cwd: REPO_ROOT, maxBuffer: 64 << 20, windowsHide: true });
      const out = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      if (out?.status === 'error') throw new Error(out.error);
      return out;
    },
    // Get-VM 只读；State 写成名字（Running、Off…）。
    vms: async () => {
      const cmd = "ConvertTo-Json -Compress -InputObject @(Get-VM -ErrorAction Stop | ForEach-Object { [ordered]@{ Name = $_.Name; State = [string]$_.State } })";
      const v = await json(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd]);
      return Array.isArray(v) ? v : [];
    },
  };
}

async function readJson(file) { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
async function writeNew(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const beijing = () => new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) + '（北京）';

export async function main(argv, { readers, write = line => process.stdout.write(`${line}\n`) } = {}) {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { 'drill-id': { type: 'string' }, in: { type: 'string' }, release: { type: 'string' },
    'shadow-prs': { type: 'string' }, 'out-dir': { type: 'string', default: 'D:/w/tmp' } } });
  const id = values['drill-id'];
  if (!['gate', 'verdict'].includes(cmd) || !ID.test(id ?? '') || !values.in || (cmd === 'gate' && !values.release)) {
    write('usage: failover-drill.mjs gate --drill-id <id> --in <gate.json> --release <file> --shadow-prs <N>- [--out-dir <dir>] | verdict --drill-id <id> --in <drill.json> [--out-dir <dir>]');
    return 2;
  }
  const input = await readJson(values.in);
  let result;
  if (cmd === 'gate') {
    const given = input.idle ?? {};
    const { idle, readErrors } = await collectIdle({ shadowPrs: values['shadow-prs'], readers: readers ?? defaultReaders() });
    const merged = { ...idle, ...given };
    result = { ...gateVerdict({ ...input, idle: merged }), drillId: id, at: new Date().toISOString(), atBeijing: beijing(), readErrors, idle: merged };
    if (result.verdict === 'PASS') {
      await writeNew(values.release, id);
      result.releaseFile = values.release;
    }
  } else {
    result = { ...drillVerdict(input), drillId: id, at: new Date().toISOString(), atBeijing: beijing() };
  }
  const out = path.join(values['out-dir'], `failover-drill-${id}-${cmd}.json`);
  await writeNew(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const [k, c] of Object.entries(result.checks)) write(`${k} ${c.ok === true ? '过' : c.ok === false ? '不过' : '未判定'}：${c.why}`);
  write(`${cmd === 'gate' ? '放行' : '演练'}结论：${result.verdict}${result.releaseFile ? `，已写放行文件 ${result.releaseFile}` : ''}；${out}`);
  return EXIT[result.verdict];
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 2; });
}
