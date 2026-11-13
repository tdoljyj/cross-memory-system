// The service's own use of the executor lock (DESK 2026-11-14 01:38:38, upgrade op 17a31df9; ADR 0032). Generation 2's first
// start, seven seconds after generation 1 ended, left with exit 4 before it took the lock and the upgrade rolled back: the lock
// (instance-lock.mjs) counts any live pid as its holder, and that node hands a freed pid to another process within seconds.
// instance-lock.mjs and store.mjs are part of the frozen upgrade channel (the upgrader imports them), so they stay byte for byte
// as they are; what changes is what the service passes in and how it calls:
//   - the holder counts only while its pid still names this root's service-main and that process started no later than the
//     holder record was written. Whatever got the pid afterwards started later, and telling that needs no right to open the
//     process. This process's own pid is never an earlier holder. A process that cannot be read at all, or a node that cannot be
//     opened and is old enough, keeps the lock's rule: refused, never two executors;
//   - a takeover whose rename fails for a moment (a scanner or indexer holding a file inside the old lock) is tried again. A
//     failed rename changed nothing, so the whole acquisition is simply repeated.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireInstanceLock, processAlive } from './instance-lock.mjs';

const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function execFileText(file, args) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try { child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
    // A cold PowerShell start on a busy node can take tens of seconds; unread means refused, so allow it a minute.
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 60_000);
    child.stdout.on('data', d => { if (out.length < 65536) out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

// What Windows says about one pid: { name, executablePath, commandLine, creationMs }; all null when it is gone; null when the
// query itself failed (unreadable). The name and the start time come from the system's process list and are there for every
// process; the path and the command line are null for a process this token may not open (another account's).
export function readWin32Process(pid, { run = execFileText } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return run(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' | Select-Object Name,ExecutablePath,CommandLine,@{n='CreationMs';e={[DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress`])
    .then(text => {
      if (text === null) return null;
      if (text.trim() === '') return { name: null, executablePath: null, commandLine: null, creationMs: null };
      try {
        const v = JSON.parse(text);
        return { name: v?.Name ?? null, executablePath: v?.ExecutablePath ?? null, commandLine: v?.CommandLine ?? null,
          creationMs: Number.isSafeInteger(v?.CreationMs) ? v.CreationMs : null };
      } catch { return null; }
    });
}

// `holder` is the lock's holder.json ({ pid, at, ... }) or null when it could not be read (then only the process itself tells).
export async function residentProcessAlive(pid, holder, root, { alive = processAlive, readProcess = readWin32Process, self = process.pid } = {}) {
  if (pid === self || !(await alive(pid))) return false;
  const p = await readProcess(pid);
  if (p === null) return true;
  const lockedAt = Date.parse(holder?.at);
  if (Number.isSafeInteger(p.creationMs) && Number.isFinite(lockedAt) && p.creationMs > lockedAt) return false;
  if (typeof p.name === 'string' && p.name.toLowerCase() !== 'node.exe') return false;
  if (typeof p.executablePath !== 'string' || typeof p.commandLine !== 'string') return typeof p.name === 'string';
  return p.executablePath.toLowerCase() === path.join(root, 'runtime', 'node.exe').toLowerCase()
    && p.commandLine.includes('service-main.mjs') && p.commandLine.includes('--root');
}

const RENAME_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const TAKEOVER_RETRY_MS = Object.freeze([20, 50, 100, 250, 500]);

// The executor lock for the service. The lock asks about the holder by pid only, so the holder record is read here, at the moment
// it asks (the lock directory is still in place then: the takeover comes after the answer).
export async function acquireResidentLock(stateRoot, root, { clock = Date.now, alive, readProcess, self, acquire = acquireInstanceLock,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const holderOf = async pid => {
    try { const h = JSON.parse(await fs.readFile(path.join(stateRoot, 'executor.lock', 'holder.json'), 'utf8')); return h?.pid === pid ? h : null; } catch { return null; }
  };
  const ports = Object.fromEntries(Object.entries({ alive, readProcess, self }).filter(([, v]) => v !== undefined));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await acquire(stateRoot, { alive: async pid => residentProcessAlive(pid, await holderOf(pid), root, ports), clock });
    } catch (error) {
      if (!RENAME_TRANSIENT.has(error?.code) || attempt >= TAKEOVER_RETRY_MS.length) throw error;
      await sleep(TAKEOVER_RETRY_MS[attempt]);
    }
  }
}
