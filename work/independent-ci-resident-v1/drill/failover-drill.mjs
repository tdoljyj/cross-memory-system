#!/usr/bin/env node
// 第 18 代故障转移演练的编排入口（任务 04f9b91b；方案 D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 4、6、7 节，
// 定案 D:/w/tmp/PLAN-failover-drill-gen18-addendum-20261124.md 第 1 节第 1、2、10 条与第 2 节 E3，独立复核 M3）。DESK 前台跑。
//
//   node work/independent-ci-resident-v1/drill/failover-drill.mjs sql --turing <binding> --desk <binding> --since <ISO 时刻>
//     打印一条只读快照 SQL。DESK 用 Supabase MCP 执行它，把返回原样存成一个文件（--snap 读它）。
//   node work/independent-ci-resident-v1/drill/failover-drill.mjs gate --drill-id <id> --snap <快照> --status-turing <file> --status-desk <file>
//        --turing <binding> --desk <binding> --source <64 位十六进制> --shadow-prs <起点>- [--release <放行文件>] [--out-dir D:/w/tmp]
//     核 A0–A7、I1–I5。I1、I2、I3、I5 本入口自己现读（gh、shadow-compare、Get-VM，都只读），不从文件取。
//     快照与两台 status.json 距此刻超过 2 分钟判未判定。给了 --release 且全过才写放行文件（内容只有演练编号）；不给只判不写（预演）。
//   node work/independent-ci-resident-v1/drill/failover-drill.mjs verdict --drill-id <id> --snap <快照> [--snap <快照>...] --cut <结果文件>
//        --status-turing <file> --status-desk <file> --turing <binding> --desk <binding> [--out-dir D:/w/tmp]
//     按 B1–B11 出结论。各快照拼成判定输入：回执按 id 去重，当班答复取并集，每个快照一条 { at, exclusion, steadySince }。
// gate、verdict 把结论写成 <out-dir>/failover-drill-<id>-<gate|verdict>.json。退出码：0 PASS，1 FAIL，3 未判定，2 用法错。
// 读取失败按网络抖动重试（3 次，间隔 5 秒）；仍读不到的一项判“未判定”，不放行、不判 PASS。本入口不连库、不推送、不碰节点。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { drillVerdict, gateVerdict } from './failover-drill-verdict.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXIT = { PASS: 0, FAIL: 1, UNDETERMINED: 3 };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const SOURCE = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 快照：一条只读 SQL，一次返回放行前与演练后要的全部库读数（定案第 2 条）。只调 stable 函数与 select。
// owner 从 TURING 的绑定行上取；page 与 public.clued_resident_failover_v1 的函数体逐项对应（迁移 20261031090000 第 1320–1362 行，
// 少 connections、bindings，判定用不到）；steady_since 出自 ci_node_liveness_v1（迁移 20261115120000）。
export function snapshotSql({ turing, desk, since } = {}) {
  if (typeof turing !== 'string' || !UUID.test(turing)) throw new UsageError(`TURING 绑定号不是 UUID：${turing}`);
  if (typeof desk !== 'string' || !UUID.test(desk)) throw new UsageError(`DESK 绑定号不是 UUID：${desk}`);
  if (turing === desk) throw new UsageError('TURING 与 DESK 的绑定号相同');
  if (typeof since !== 'string' || !ISO.test(since) || !Number.isFinite(Date.parse(since))) throw new UsageError(`起点不是 ISO 时刻：${since}`);
  const T = `'${turing}'::uuid`, D = `'${desk}'::uuid`, S = `'${since}'::timestamptz`;
  return `with o as (select b.user_id as owner from public.clued_agent_bindings b where b.id=${T}),
tl as (select l.steady_since,l.last_heartbeat_at,l.reported_source_sha256
  from o join clued_private.ci_nodes_v1 n on n.user_id=o.owner and n.binding_id=${T} and n.state not in ('retired','revoked')
  join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id order by l.last_heartbeat_at desc limit 1)
select jsonb_build_object(
  'server_time',clock_timestamp(),'turing',${T},'desk',${D},'since',${S},
  'page',jsonb_build_object('status','ok','observed_at',clock_timestamp(),
    'setting',clued_private.ci_failover_setting_view_v1(o.owner),
    'rules',clued_private.ci_failover_rules_v1(),
    'members',clued_private.ci_failover_list_view_v1(o.owner,clued_private.ci_failover_member_ids_v1(o.owner)),
    'holders',clued_private.binding_role_holders_v1(o.owner,'ci-admission','{}'::uuid[]),
    'nodes',clued_private.ci_failover_nodes_v1(o.owner),
    'watchdog',clued_private.ci_failover_watchdog_view_v1(),
    'alerts',coalesce((select jsonb_agg(jsonb_build_object('receipt_id',r.id,'created_at',r.created_at,
        'receipt_kind',r.metadata->'receipt_kind','reason',r.metadata->'reason','holder',r.metadata->'holder',
        'target',r.metadata->'target','from_binding_id',r.metadata->'from_binding_id',
        'to_binding_id',r.metadata->'to_binding_id','trigger',r.metadata->'trigger',
        'effective_at',r.metadata->'effective_at') order by r.created_at desc,r.id)
      from (select * from public.clued_audit_receipts x where x.user_id=o.owner
          and x.created_at>clock_timestamp()-interval '7 days'
          and (x.operation='ci_admission_failover_alert'
            or (x.operation='binding_role_handover' and x.metadata->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER'))
        order by x.created_at desc,x.id limit 20) r),'[]'::jsonb)),
  'turing_liveness',(select jsonb_build_object('steady_since',tl.steady_since,'last_heartbeat_at',tl.last_heartbeat_at) from tl),
  'receipts',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'created_at',r.created_at,'operation',r.operation,
        'metadata',r.metadata-'candidates'-'nodes') order by r.created_at,r.id)
      from public.clued_audit_receipts r where r.user_id=o.owner and r.created_at>=${S}
        and (r.operation='ci_admission_failover_alert'
          or (r.operation='binding_role_handover' and r.metadata->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER'))),'[]'::jsonb),
  'duty_answers',coalesce((select jsonb_agg(jsonb_build_object('binding_id',a.binding_id,'at',a.at) order by a.at)
      from clued_private.ci_duty_answers_v1 a where a.user_id=o.owner and a.binding_id in (${T},${D}) and a.at>=${S}),'[]'::jsonb),
  'exclusion',clued_private.ci_failover_exclusion_v1(o.owner,${T},now()),
  'candidates',clued_private.ci_failover_candidates_v1(o.owner,${T},(select tl.reported_source_sha256 from tl),null,now())
) as snapshot from o;`;
}

// DESK 把 MCP 的返回原样存盘：[{ snapshot: {...} }]；也收 { snapshot }、快照本身，snapshot 是 JSON 文本也行。
export function readSnapshot(text) {
  let v = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  if (Array.isArray(v)) { if (v.length !== 1) throw new Error(`快照文件应有 1 行，读到 ${v.length} 行`); v = v[0]; }
  if (v && typeof v === 'object' && 'snapshot' in v) v = v.snapshot;
  if (typeof v === 'string') v = JSON.parse(v);
  if (!v || typeof v !== 'object' || typeof v.server_time !== 'string' || !v.page || typeof v.page !== 'object') throw new Error('不是快照（缺 server_time 或 page）');
  return v;
}
const checkPair = (snap, turing, desk, file) => {
  if (snap.turing !== turing || snap.desk !== desk) throw new UsageError(`${file} 是为别的绑定号读的快照（${snap.turing} / ${snap.desk}）`);
};

export function gateInputFrom({ snapshot, statusTuring, statusDesk, turing, desk, source, idle, now, finishedAt }) {
  return { now, finishedAt, turing, desk, source, snapshotAt: snapshot?.server_time, page: snapshot?.page, candidates: snapshot?.candidates,
    statusTuring, statusDesk, idle };
}

export function drillInputFrom({ snapshots = [], cut, statusTuring, statusDesk, turing, desk }) {
  const list = [...snapshots].sort((a, b) => Date.parse(a.server_time) - Date.parse(b.server_time));
  let receipts, dutyAnswers;
  const seenReceipt = new Set(), seenAnswer = new Set();
  for (const s of list) {
    if (Array.isArray(s.receipts)) {
      receipts ??= [];
      for (const r of s.receipts) { const k = r?.id ?? JSON.stringify(r); if (!seenReceipt.has(k)) { seenReceipt.add(k); receipts.push(r); } }
    }
    if (Array.isArray(s.duty_answers)) {
      dutyAnswers ??= [];
      for (const a of s.duty_answers) { const k = `${a?.binding_id}@${a?.at}`; if (!seenAnswer.has(k)) { seenAnswer.add(k); dutyAnswers.push(a); } }
    }
  }
  return { turing, desk, cut, statusTuring, statusDesk, receipts, dutyAnswers,
    pages: list.map(s => s.page).filter(Boolean),
    // exclusion 字段缺失记 undefined（没读到），与 null（读到了、已恢复）分开（复审 B9）
    exclusions: list.map(s => ({ at: s.server_time, exclusion: Object.hasOwn(s, 'exclusion') ? s.exclusion : undefined,
      steadySince: s.turing_liveness?.steady_since ?? null })) };
}

// ---------------------------------------------------------------------------
async function retry(fn, { tries = 3, gapMs = 5000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(gapMs); }
  }
  throw last;
}

// The four idle reads the entry makes itself, never taken from a file (review M3). Each one that still fails is left out
// (its check is then undetermined) and named in `readErrors`.
export async function collectIdle({ shadowPrs, readers = defaultReaders(), sleep } = {}) {
  const idle = {}, readErrors = {};
  const plan = {
    runsInProgress: () => readers.runs('in_progress'),
    runsQueued: () => readers.runs('queued'),
    prs: () => readers.prs(),
    shadow: () => readers.shadow(shadowPrs),
    vms: () => readers.vms(),
  };
  for (const [key, read] of Object.entries(plan)) {
    try { idle[key] = await retry(read, sleep ? { sleep } : {}); } catch (e) { readErrors[key] = String(e?.message ?? e).slice(0, 300); }
  }
  return { idle, readErrors };
}

// 每条现读都有超时（补充三 S1）：gh 与 Get-VM 60 秒，影子对比 100 秒；超时即抛，按读不到处理（重试后仍不成，该项未判定）。
export const READ_TIMEOUT_MS = { gh: 60_000, vms: 60_000, shadow: 100_000 };
export function defaultReaders({ exec = promisify(execFile) } = {}) {
  const run = (file, args, timeout) => exec(file, args, { cwd: REPO_ROOT, maxBuffer: 64 << 20, windowsHide: true, timeout });
  const json = async (file, args, timeout) => JSON.parse((await run(file, args, timeout)).stdout);
  return {
    // event 用来只数 PR 与 push 触发的运行（定案 E3）；定时任务多，取 50 行
    runs: status => json('gh', ['run', 'list', '--status', status, '--limit', '50', '--json', 'databaseId,name,status,createdAt,event'], READ_TIMEOUT_MS.gh),
    prs: () => json('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,isDraft,statusCheckRollup'], READ_TIMEOUT_MS.gh),
    shadow: async prs => {
      if (!prs) throw new Error('没给 --shadow-prs');
      const { stdout } = await run(process.execPath, ['scripts/ci/shadow-compare.mjs', '--prs', prs], READ_TIMEOUT_MS.shadow);
      const out = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      if (out?.status === 'error') throw new Error(out.error);
      return out;
    },
    // Get-VM 只读；State 写成名字（Running、Off…）。
    vms: async () => {
      const cmd = "ConvertTo-Json -Compress -InputObject @(Get-VM -ErrorAction Stop | ForEach-Object { [ordered]@{ Name = $_.Name; State = [string]$_.State } })";
      const v = await json(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], READ_TIMEOUT_MS.vms);
      return Array.isArray(v) ? v : [];
    },
  };
}

async function readText(file) { return (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''); }
async function readJson(file) { return JSON.parse(await readText(file)); }
async function writeNew(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}
const beijing = at => new Date(at + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) + '（北京）';

const USAGE = [
  'usage: failover-drill.mjs sql --turing <binding> --desk <binding> --since <ISO>',
  '       failover-drill.mjs gate --drill-id <id> --snap <file> --status-turing <file> --status-desk <file> --turing <binding> --desk <binding> --source <sha256> --shadow-prs <N>- [--release <file>] [--out-dir <dir>]',
  '       failover-drill.mjs verdict --drill-id <id> --snap <file> [--snap <file>...] --cut <file> --status-turing <file> --status-desk <file> --turing <binding> --desk <binding> [--out-dir <dir>]',
].join('\n');

function parse(cmd, rest) {
  const options = {
    sql: { turing: { type: 'string' }, desk: { type: 'string' }, since: { type: 'string' } },
    gate: { 'drill-id': { type: 'string' }, snap: { type: 'string' }, 'status-turing': { type: 'string' }, 'status-desk': { type: 'string' },
      turing: { type: 'string' }, desk: { type: 'string' }, source: { type: 'string' }, 'shadow-prs': { type: 'string' },
      release: { type: 'string' }, 'out-dir': { type: 'string', default: 'D:/w/tmp' } },
    verdict: { 'drill-id': { type: 'string' }, snap: { type: 'string', multiple: true }, cut: { type: 'string' },
      'status-turing': { type: 'string' }, 'status-desk': { type: 'string' }, turing: { type: 'string' }, desk: { type: 'string' },
      'out-dir': { type: 'string', default: 'D:/w/tmp' } },
  }[cmd];
  if (!options) throw new UsageError(`未知子命令 ${cmd ?? ''}`);
  let values;
  try { ({ values } = parseArgs({ args: rest, options, strict: true })); } catch (e) { throw new UsageError(e.message); }
  if (cmd === 'sql') return values;
  if (!ID.test(values['drill-id'] ?? '')) throw new UsageError('--drill-id 不合格');
  for (const k of ['turing', 'desk']) if (!UUID.test(values[k] ?? '')) throw new UsageError(`--${k} 不是 UUID`);
  if (values.turing === values.desk) throw new UsageError('--turing 与 --desk 相同');
  for (const k of ['snap', 'status-turing', 'status-desk', ...(cmd === 'verdict' ? ['cut'] : [])]) {
    if (!values[k] || (Array.isArray(values[k]) && !values[k].length)) throw new UsageError(`缺 --${k}`);
  }
  if (cmd === 'gate' && !SOURCE.test(values.source ?? '')) throw new UsageError('--source 必须是 64 位小写十六进制');
  return values;
}

export async function main(argv, { readers, now = () => Date.now(), sleep, write = line => process.stdout.write(`${line}\n`) } = {}) {
  const [cmd, ...rest] = argv;
  let values;
  try {
    values = parse(cmd, rest);
    if (cmd === 'sql') { write(snapshotSql(values)); return 0; }
  } catch (e) {
    if (e instanceof UsageError) { write(`${e.message}\n${USAGE}`); return 2; }
    throw e;
  }
  const id = values['drill-id'], { turing, desk } = values;
  let result;
  try {
    if (cmd === 'gate') {
      // 跑门的时刻在读文件与现读之前取：读数要比它新，且不晚于它 2 分钟；现读结束再取一次，距跑门超过 2 分钟也不放行（补充三 S1）。
      const at = now();
      const snapshot = readSnapshot(await readText(values.snap));
      checkPair(snapshot, turing, desk, values.snap);
      const [statusTuring, statusDesk] = [await readJson(values['status-turing']), await readJson(values['status-desk'])];
      const { idle, readErrors } = await collectIdle({ shadowPrs: values['shadow-prs'], readers: readers ?? defaultReaders(), sleep });
      const finishedAt = now();
      result = { ...gateVerdict(gateInputFrom({ snapshot, statusTuring, statusDesk, turing, desk, source: values.source, idle, now: at, finishedAt })),
        drillId: id, at: new Date(at).toISOString(), atBeijing: beijing(at), finishedAt: new Date(finishedAt).toISOString(), readErrors, idle };
      if (result.verdict === 'PASS' && values.release) {
        await writeNew(values.release, id);
        result.releaseFile = values.release;
      }
    } else {
      const snapshots = [];
      for (const file of values.snap) { const s = readSnapshot(await readText(file)); checkPair(s, turing, desk, file); snapshots.push(s); }
      const input = drillInputFrom({ snapshots, cut: await readJson(values.cut), statusTuring: await readJson(values['status-turing']),
        statusDesk: await readJson(values['status-desk']), turing, desk });
      const at = now();
      result = { ...drillVerdict(input), drillId: id, at: new Date(at).toISOString(), atBeijing: beijing(at), snapshots: values.snap };
    }
  } catch (e) {
    if (e instanceof UsageError) { write(`${e.message}\n${USAGE}`); return 2; }
    throw e;
  }
  const out = path.join(values['out-dir'], `failover-drill-${id}-${cmd}.json`);
  await writeNew(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const [k, c] of Object.entries(result.checks)) write(`${k} ${c.ok === true ? '过' : c.ok === false ? '不过' : '未判定'}：${c.why}`);
  write(`${cmd === 'gate' ? '放行' : '演练'}结论：${result.verdict}${result.releaseFile ? `，已写放行文件 ${result.releaseFile}` : cmd === 'gate' && result.verdict === 'PASS' ? '（没给 --release，只判不写）' : ''}；${out}`);
  return EXIT[result.verdict];
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 2; });
}
