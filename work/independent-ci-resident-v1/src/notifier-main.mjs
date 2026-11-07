// The notifier (ADR 0022 §4.3, M5): scheduled task "\Clued\CluedCIResidentNotifier", the Owner's interactive token, not elevated, at
// log-on; conhost --headless node notifier-main.mjs --root <root>. It stores no password, so the upgrade channel registers it again
// with every generation. It is the only part of the companion that needs a desktop:
//   - every 5 s it shows what the companion queued (notify-queue.mjs) and deletes it;
//   - at log-on and every 5 minutes it looks at the companion itself: the companion task's last result (a refused password logon),
//     the companion's heartbeat, the supervisor's restarts, and the service's `companion-absent` notice. Each finding is shown once per
//     key and again at most every hour while it lasts.
// It never asks for a password: its texts give a code and a runbook section only.
//
//   node notifier-main.mjs --root C:\ProgramData\CluedIndependentCI\resident
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { check } from './canonical.mjs';
import { toastArgv } from './pr-status.mjs';
import { readStatus } from './status.mjs';
import { NotifyQueue, companionFindings, notifyQueueDir } from './notify-queue.mjs';

export const DRAIN_EVERY_MS = 5_000;
export const CHECK_EVERY_MS = 5 * 60_000;
export const REPEAT_AFTER_MS = 60 * 60_000;
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const COMPANION_TASK = '\\Clued\\CluedCIResidentCompanion';
// The companion task's State and LastTaskResult through the Task Scheduler's COM API (the Owner has read on the task: ADR 0022 §4.1).
// A fixed script: no value of the notifier reaches it.
export const TASK_FACTS_SCRIPT = "$ErrorActionPreference='Stop';$s=New-Object -ComObject 'Schedule.Service';$s.Connect();"
  + "$t=$s.GetFolder('\\Clued').GetTask('CluedCIResidentCompanion');"
  + "[Console]::Out.Write((@{state=[int]$t.State;lastTaskResult=[long]$t.LastTaskResult} | ConvertTo-Json -Compress))";
export const taskFactsArgv = () => [POWERSHELL_EXE, '-NoProfile', '-NonInteractive', '-Command', TASK_FACTS_SCRIPT];

export function parseTaskFacts(text) {
  try {
    const v = JSON.parse(String(text ?? ''));
    if (!Number.isInteger(v?.state) || !Number.isInteger(v?.lastTaskResult)) return null;
    return { state: v.state, lastTaskResult: v.lastTaskResult };
  } catch { return null; }
}

// Shows each finding once per key, and again only after REPEAT_AFTER_MS while it lasts; a finding that went away may come back at once.
export class FindingMemory {
  constructor() { this.shown = new Map(); }
  due(findings, now) {
    const keys = new Set(findings.map(f => f.key));
    for (const k of [...this.shown.keys()]) if (!keys.has(k)) this.shown.delete(k);
    const out = findings.filter(f => !this.shown.has(f.key) || now - this.shown.get(f.key) >= REPEAT_AFTER_MS);
    for (const f of out) this.shown.set(f.key, now);
    return out;
  }
}

// The service's own notice that no heartbeat came within 10 minutes of its start (status.mjs, companion-absent).
export function absentNotices(status) {
  return (status?.notices ?? []).filter(n => n.kind === 'companion-absent')
    .map(n => ({ key: `notice:${n.key}`, title: 'Clued：服务启动后 companion 没有出现', body: '常驻服务启动 10 分钟后仍没有 companion 的心跳，节点不会接新批次。见运维手册 M5 第 5 节“排查”。' }));
}

function runText(argv, timeoutMs = 60_000) {
  return new Promise(resolve => {
    let out = '', child;
    try { child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 65536) out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

export async function readJsonBounded(file, max = 65536) {
  try { const b = await fs.readFile(file); return b.length <= max ? JSON.parse(b.toString('utf8')) : null; } catch { return null; }
}

// One check: the findings to show now. ports: { readTask, readHeartbeat, readExits, readStatus, clock, memory }.
export async function checkOnce({ readTask, readHeartbeat, readExits, readStatus: status, clock, memory }) {
  const now = clock();
  let task = null, heartbeatAt = null, exits = [], st = null;
  try { task = await readTask(); } catch { task = null; }
  try { heartbeatAt = await readHeartbeat(); } catch { heartbeatAt = null; }
  try { exits = await readExits(); } catch { exits = []; }
  try { st = await status(); } catch { st = null; }
  return memory.due([...companionFindings({ task, heartbeatAt, exits, now }), ...absentNotices(st)], now);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { root: { type: 'string' } } });
  check(typeof values.root === 'string' && path.isAbsolute(values.root), 'NOTIFIER_ARGS_REQUIRED');
  const cfg = JSON.parse(await fs.readFile(path.join(values.root, 'config', 'companion.json'), 'utf8'));
  const profile = cfg?.companion?.node?.ownerProfileDirectory;
  check(typeof profile === 'string' && /^C:\\Users\\[^\\]+$/.test(profile) && process.env.USERPROFILE?.toLowerCase() === profile.toLowerCase(), 'NOTIFIER_PROFILE_MISMATCH');
  const queue = new NotifyQueue({ dir: notifyQueueDir(profile) });
  const show = async (title, body) => { await runText(toastArgv(POWERSHELL_EXE, title, body), 15_000); };
  const memory = new FindingMemory();
  const local = path.join(profile, 'AppData', 'Local', 'CluedIndependentCI');
  const ports = {
    readTask: async () => parseTaskFacts(await runText(taskFactsArgv())),
    readHeartbeat: async () => { const v = await readJsonBounded(path.join(values.root, 'mailbox', 'responses', 'heartbeat.json'), 512); return Number.isSafeInteger(v?.at) ? v.at : null; },
    readExits: async () => { const v = await readJsonBounded(path.join(local, 'supervisor.json')); return Array.isArray(v?.exits) ? v.exits.slice(-50) : []; },
    readStatus: () => readStatus(values.root), clock: Date.now, memory,
  };
  let lastCheck = 0;
  for (;;) {
    try { await queue.drain(show); } catch { /* next pass */ }
    if (Date.now() - lastCheck >= CHECK_EVERY_MS) {
      lastCheck = Date.now();
      try { for (const f of await checkOnce(ports)) await show(f.title, f.body); } catch { /* next check */ }
    }
    await sleep(DRAIN_EVERY_MS);
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch(() => { process.exit(4); });
}
