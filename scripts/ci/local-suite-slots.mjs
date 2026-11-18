import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { groupExists } from './local-suite-slot-guard.mjs';

const SLOT_LIMIT = 2;
const WAIT_MS = 20 * 60_000;
const HOLD_MS = 20 * 60_000;
const POLL_MS = 1_000;
const PROBE_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const REQUEST = /^clued-local-suite-v1-(\d+)-([a-f\d]+)-[a-f\d-]{36}$/;
const TICKET = /^ticket-(\d+)-([a-z][a-z\d-]*)$/;
const GROUP = /^group-([1-9]\d{0,9})$/;
const WINDOWS = process.platform === 'win32';
const WORKER = fileURLToPath(new URL('./local-suite-slot-guard.mjs', import.meta.url));
const JOB_SCRIPT = fileURLToPath(new URL('./local-suite-slot-job.ps1', import.meta.url));
const HOST_PS = ['-NoProfile', '-NonInteractive'];
const JOB_ARGS = [...HOST_PS, '-ExecutionPolicy', 'Bypass', '-File', JOB_SCRIPT];

function sharedDirectory() {
  // Independent of the checkout, suite name and user-specific temp settings.
  return process.platform === 'win32' ? path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents') : '/tmp';
}

// A null identity proves the PID is gone. An unavailable identity never
// proves that a live owner is stale, for example across Windows accounts.
function unixProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function processStarts(pids, timeout) {
  if (pids.length === 0) return new Map();
  if (WINDOWS) {
    const command = `foreach ($id in ${pids.join(',')}) {
      try {
        $p = [System.Diagnostics.Process]::GetProcessById($id)
        if ($p.HasExited) { "$id gone" } else { "$id $($p.StartTime.ToUniversalTime().ToFileTimeUtc())" }
      } catch [System.ArgumentException] { "$id gone" }
        catch { "$id unknown" }
    }`;
    const output = execFileSync('powershell.exe', [...HOST_PS, '-Command', command],
      { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Map(output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, start] = line.split(' ');
      return [Number(pid), start === 'gone' ? null : /^\d+$/.test(start) ? start : undefined];
    }));
  }
  if (process.platform === 'linux') {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().replaceAll('-', '');
    return new Map(pids.map((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return [pid, fields[0] === 'Z' ? null : `${boot}${fields[19]}`];
      } catch (error) {
        if (error.code === 'ENOENT') return [pid, unixProcessExists(pid) ? undefined : null];
        if (error.code === 'EACCES' || error.code === 'EPERM') return [pid, undefined];
        throw error;
      }
    }));
  }
  return new Map(pids.map((pid) => {
    if (!unixProcessExists(pid)) return [pid, null];
    try {
      const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout }).trim();
      const instant = Date.parse(`${start} UTC`);
      return [pid, Number.isFinite(instant) ? String(instant) : undefined];
    } catch {
      return [pid, undefined];
    }
  }));
}

function requestEntries(directory, self) {
  const requests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = entry.isDirectory() && REQUEST.exec(entry.name);
    const pid = Number(match?.[1]);
    if (pid > 0 && pid <= 0x7fffffff && entry.name !== self) requests.push({ name: entry.name, pid, start: match[2] });
  }
  return requests;
}

function probeBudget(deadline) {
  return Math.max(1, Math.min(PROBE_TIMEOUT_MS, Math.ceil(deadline - performance.now())));
}

function probeFailure(error) {
  return error.message.replace(/\s+/g, ' ').slice(0, 300);
}

function windowsJobsGone(requests, deadline) {
  if (requests.length === 0 || performance.now() >= deadline) return new Set();
  // This is only needed when a guarded owner died without a drain receipt.
  const output = execFileSync('powershell.exe', [...JOB_ARGS, '-Probe'], {
    env: { ...process.env, CLUED_LOCAL_SUITE_JOB_PROBE: JSON.stringify(requests) },
    encoding: 'utf8', timeout: probeBudget(deadline), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Set(output.trim().split(/\r?\n/));
}

function reap(requestPath) {
  // Requests have unique names. A sticky /tmp may deny cross-user cleanup
  // even after the owner and its tree have exited.
  try { rmSync(requestPath, { recursive: true, force: true }); } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
  }
}

function requestTickets(directory, requests, stale, jobsGone) {
  const live = [];
  for (const request of requests) {
    const requestPath = path.join(directory, request.name);
    let names;
    try { names = readdirSync(requestPath); } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        // Another user may still be between mkdir and chmod.
        live.push({ ...request, ticket: null });
        continue;
      }
      throw error;
    }
    if (stale.has(request.name)) {
      const group = names.map((entry) => GROUP.exec(entry)).find(Boolean);
      // Read these markers after proving the entry stale. If it gave the
      // guard permission, the tree's lifetime needs independent proof.
      const treeGone = !names.includes('granted') || names.includes('drained')
        || (WINDOWS ? jobsGone.has(request.name) : group && !groupExists(Number(group[1])));
      if (treeGone) {
        reap(requestPath);
        continue;
      }
    }
    const ticket = names.map((name) => TICKET.exec(name)).find(Boolean);
    live.push({ ...request, ticket: ticket ? Number(ticket[1]) : null, suite: ticket?.[2], holding: names.includes('holding') });
  }
  return live;
}

async function runGuard(suite, { root, env, timeoutExit }, requestPath, holdMs) {
  const context = { suite, root, requestPath, holdMs, timeoutExit, owner: process.pid, worker: WORKER, node: process.execPath };
  const deadline = performance.now() + holdMs;
  const child = spawn(WINDOWS ? 'powershell.exe' : process.execPath, WINDOWS ? JOB_ARGS : [WORKER, 'guard'], {
    detached: !WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, CLUED_LOCAL_SUITE_GUARD: JSON.stringify(context) },
  });
  child.stdin.on('error', () => {}); // A guard that failed to start can close its pipe first.
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  await once(child, 'spawn');
  const exited = once(child, 'close');
  for (;;) {
    const ready = WINDOWS ? existsSync(path.join(requestPath, 'ready')) : readdirSync(requestPath).some((name) => GROUP.test(name));
    if (ready) break;
    if (performance.now() >= deadline) {
      child.kill('SIGKILL');
      console.error(`LOCAL_SUITE_HOLD_TIMEOUT: ${suite} (PID ${process.pid}) held a slot before the process guard became ready`);
      await exited;
      return timeoutExit;
    }
    const exit = await Promise.race([exited, delay(50)]);
    if (exit) throw new Error(`process guard for ${suite} exited (${exit[0] ?? exit[1]}) before it was ready`);
  }
  // The guard publishes its lifetime witness before any test can start.
  writeFileSync(path.join(requestPath, 'granted'), '');
  child.stdin.write(Buffer.of(1));
  const [code, signal] = await exited;
  child.stdin.end();
  if (!existsSync(path.join(requestPath, 'drained'))) {
    throw new Error(`process guard for ${suite} exited (${code ?? signal}) without confirming its process tree stopped`);
  }
  return code ?? 1;
}

function waitTimeout(suite, waitMs, reason, timeoutExit) {
  console.error(`LOCAL_SUITE_SLOT_TIMEOUT: ${suite} waited ${(waitMs / 60_000).toFixed(2)} minutes; ${reason}; suite did not start, retry later`);
  return timeoutExit;
}

export async function withLocalSuiteSlot(suite, run, {
  directory = sharedDirectory(), waitMs = WAIT_MS, holdMs = HOLD_MS, probeMs = PROBE_MS,
} = {}) {
  const deadline = performance.now() + waitMs;
  let start;
  let lastMessage;
  const announce = (message) => {
    if (message !== lastMessage) console.log(`local suite ${suite}: ${message}`);
    lastMessage = message;
  };
  while (!start) {
    let reason = `cannot determine start time for local suite PID ${process.pid}`;
    try {
      start = processStarts([process.pid], probeBudget(deadline)).get(process.pid);
    } catch (error) {
      reason += ` (${probeFailure(error)})`;
    }
    if (start && /^[a-f\d]+$/.test(start)) break;
    start = null;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return waitTimeout(suite, waitMs, reason, run.timeoutExit);
    announce(reason);
    await delay(Math.min(probeMs, remaining));
  }
  const name = `clued-local-suite-v1-${process.pid}-${start}-${randomUUID()}`;
  const requestPath = path.join(directory, name);
  // Open the bakery algorithm's choosing phase with an atomic mkdir. A
  // contender checks all published tickets before choosing its own, and
  // cannot enter while another contender is still choosing. The first
  // SLOT_LIMIT live tickets may run, with the unique request name breaking ties.
  mkdirSync(requestPath, { mode: 0o755 });
  try {
    if (!WINDOWS) chmodSync(requestPath, 0o755);
    let requests = requestEntries(directory, name);
    let stale = new Set();
    let jobsGone = new Set();
    const ticket = 1 + Math.max(0, ...requestTickets(directory, requests, stale, jobsGone).map((request) => request.ticket ?? 0));
    writeFileSync(path.join(requestPath, `ticket-${ticket}-${suite}`), '');
    let nextProbe = 0;
    let probeReason;
    for (;;) {
      requests = requestEntries(directory, name);
      if (requests.length > 0 && performance.now() >= nextProbe && performance.now() < deadline) {
        try {
          const starts = processStarts([...new Set(requests.map(({ pid }) => pid))], probeBudget(deadline));
          stale = new Set(requests.filter(({ pid, start: previous }) =>
            starts.get(pid) !== undefined && starts.get(pid) !== previous).map(({ name: request }) => request));
          probeReason = requests.some(({ pid }) => starts.get(pid) === undefined) ? 'some process identities are unknown' : undefined;
          if (WINDOWS) {
            jobsGone = windowsJobsGone([...stale].filter((request) => {
              const location = path.join(directory, request);
              return existsSync(path.join(location, 'granted')) && !existsSync(path.join(location, 'drained'));
            }), deadline);
          }
        } catch (error) {
          probeReason = probeFailure(error);
        }
        nextProbe = performance.now() + probeMs;
      }
      const live = requestTickets(directory, requests, stale, jobsGone);
      const ahead = live.filter((request) => request.ticket !== null
        && (request.ticket < ticket || (request.ticket === ticket && request.name < name))).length;
      const remaining = deadline - performance.now();
      if (ahead < SLOT_LIMIT && !live.some((request) => request.ticket === null) && remaining > 0) {
        writeFileSync(path.join(requestPath, 'holding'), '');
        return await runGuard(suite, run, requestPath, holdMs);
      }
      const holders = live.filter(({ holding }) => holding).map(({ suite, pid }) => `${suite} (PID ${pid})`);
      const message = `queue position ${Math.max(1, ahead - SLOT_LIMIT + 1)}; holders: ${holders.join(', ') || 'none'}`
        + (probeReason ? `; process probe: ${probeReason}` : '');
      if (remaining <= 0) return waitTimeout(suite, waitMs, message, run.timeoutExit);
      announce(message);
      await delay(Math.min(POLL_MS, remaining));
    }
  } finally {
    if (!existsSync(path.join(requestPath, 'granted')) || existsSync(path.join(requestPath, 'drained'))) reap(requestPath);
  }
}
