import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { groupExists } from './local-suite-slot-guard.mjs';
import { deferTestSignalExit } from './test-env.mjs';

const SLOT_LIMIT = 2;
const WAIT_MS = 20 * 60_000;
const HOLD_MS = 20 * 60_000;
const POLL_MS = 1_000;
const PROBE_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const WINDOWS_GUARD_TIMEOUT_MS = 30_000; // Windows service startup default.
const REQUEST = /^clued-local-suite-v1-(\d+)-([a-f\d]+)-[a-f\d-]{36}$/;
const TICKET = /^ticket-(\d+)-([a-z][a-z\d-]*)$/;
const GROUP = /^group-([1-9]\d{0,9})$/;
const WINDOWS = process.platform === 'win32';
const WORKER = fileURLToPath(new URL('./local-suite-slot-guard.mjs', import.meta.url));
const JOB_SCRIPT = fileURLToPath(new URL('./local-suite-slot-job.ps1', import.meta.url));
const HOST_PS = ['-NoProfile', '-NonInteractive'];
const JOB_ARGS = [...HOST_PS, '-ExecutionPolicy', 'Bypass', '-File', JOB_SCRIPT];
export const LOCAL_INTERRUPTED_EXIT = 130;

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

function probeWindowsJobs(requests, deadline) {
  if (requests.length === 0 || performance.now() >= deadline) return new Map();
  // This is only needed when a guarded owner died without a drain receipt.
  const output = execFileSync('powershell.exe', [...JOB_ARGS, '-Probe'], {
    env: { ...process.env, CLUED_LOCAL_SUITE_JOB_PROBE: JSON.stringify(requests) },
    encoding: 'utf8', timeout: probeBudget(deadline), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Map(output.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(' ')));
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
    const granted = names.includes('granted');
    live.push({ ...request, ticket: ticket ? Number(ticket[1]) : null, suite: ticket?.[2],
      holding: names.includes('holding'), granted, drained: names.includes('drained') });
  }
  return live;
}

async function runGuard(suite, { root, env, timeoutExit, work }, requestPath, holdMs) {
  const context = { suite, root, work, requestPath, holdMs, timeoutExit, deadlineAt: Date.now() + holdMs,
    owner: process.pid, worker: WORKER, node: process.execPath };
  const deadline = performance.now() + holdMs;
  const child = spawn(process.execPath, [WORKER, 'guard'], {
    detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, CLUED_LOCAL_SUITE_GUARD: JSON.stringify(context) },
  });
  child.stdin.on('error', () => {}); // A guard that failed to start can close its pipe first.
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  await once(child, 'spawn');
  const exited = once(child, 'close');
  for (;;) {
    const ready = readdirSync(requestPath).some((name) => GROUP.test(name));
    if (performance.now() >= deadline) {
      child.kill('SIGKILL');
      console.error(`LOCAL_SUITE_HOLD_TIMEOUT: ${suite} (PID ${process.pid}) held a slot before the process guard became ready`);
      await exited;
      return timeoutExit;
    }
    if (ready) break;
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

async function runWindowsGuard(suite, { root, env, timeoutExit, work, beforeStart }, requestPath, recheck, signal, guardTimeoutMs) {
  const context = { suite, root, work, requestPath, timeoutExit, worker: WORKER, node: process.execPath };
  const readyDeadline = performance.now() + guardTimeoutMs;
  const child = spawn('powershell.exe', JOB_ARGS, {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, CLUED_LOCAL_SUITE_GUARD: JSON.stringify(context) },
  });
  child.stdin.on('error', () => {});
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  await once(child, 'spawn');
  const exited = once(child, 'close').catch((error) => [null, probeFailure(error)]);
  const { promise: cancelled, resolve: notifyCancelled } = Promise.withResolvers();
  const cancel = () => {
    child.stdin.end();
    notifyCancelled();
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  let granted = false;
  let forced = false;
  const waitForExit = async (timeoutMs) => {
    const timer = new AbortController();
    try { return await Promise.race([exited, delay(timeoutMs, null, { signal: timer.signal })]); }
    finally { timer.abort(); }
  };
  const terminateGuard = async () => {
    forced = true;
    // This is the PowerShell child we started. Its Job owns the suite tree.
    child.kill();
    for (const stream of child.stdio) stream.destroy();
    child.unref();
    await waitForExit(PROBE_TIMEOUT_MS);
  };
  const finishGuard = async () => {
    child.stdin.end();
    const result = await waitForExit(guardTimeoutMs);
    if (result) return result;
    await terminateGuard();
    throw new Error(`process guard for ${suite} drain timed out after ${guardTimeoutMs} ms`);
  };
  try {
    while (!signal.aborted) {
      const remaining = readyDeadline - performance.now();
      if (remaining <= 0) {
        await terminateGuard();
        throw new Error(`process guard for ${suite} ready timed out after ${guardTimeoutMs} ms`);
      }
      if (existsSync(path.join(requestPath, 'ready'))) break;
      const exit = await Promise.race([exited, cancelled, delay(Math.min(50, remaining))]);
      if (exit && !signal.aborted) throw new Error(`process guard for ${suite} exited (${exit[0] ?? exit[1]}) before it was ready`);
    }
    if (signal.aborted) return LOCAL_INTERRUPTED_EXIT;
    await beforeStart?.();
    const blocked = await recheck();
    if (signal.aborted) return LOCAL_INTERRUPTED_EXIT;
    if (blocked) return blocked; // Keep the ticket, release only the pending reservation.
    writeFileSync(path.join(requestPath, 'granted'), '');
    granted = true;
    child.stdin.write(Buffer.of(1));
    const [code, termination] = await Promise.race([exited, cancelled]) ?? await finishGuard();
    if (!existsSync(path.join(requestPath, 'drained'))) {
      throw new Error(`process guard for ${suite} exited (${code ?? termination}) without confirming its process tree stopped`);
    }
    return signal.aborted ? LOCAL_INTERRUPTED_EXIT : code ?? 2;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (granted) child.stdin.end();
    else if (!forced) {
      if (signal.aborted) await terminateGuard();
      else await finishGuard();
    }
  }
}

function waitTimeout(suite, waitMs, reason, timeoutExit) {
  console.error(`LOCAL_SUITE_SLOT_TIMEOUT: ${suite} waited ${(waitMs / 60_000).toFixed(2)} minutes; ${reason}; suite did not start, retry later`);
  return timeoutExit;
}

export async function withLocalSuiteSlot(suite, command, options = {}) {
  if (!WINDOWS) return queueSuite(suite, command, options);
  const stop = new AbortController();
  const cancel = () => stop.abort();
  const signals = ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP'];
  for (const name of signals) process.on(name, cancel);
  const restoreSignalExit = deferTestSignalExit();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  try {
    return await queueSuite(suite, command, { ...options, signal });
  } finally {
    restoreSignalExit();
    for (const name of signals) process.off(name, cancel);
  }
}

async function queueSuite(suite, command, { directory = sharedDirectory(), waitMs = WAIT_MS, holdMs = HOLD_MS,
  probeMs = PROBE_MS, guardTimeoutMs = WINDOWS_GUARD_TIMEOUT_MS, capacity, signal } = {}) {
  const deadline = WINDOWS ? Infinity : performance.now() + waitMs;
  const wait = async (ms) => {
    try { await delay(ms, undefined, { signal }); } catch (error) { if (!signal?.aborted) throw error; }
  };
  let shortfalls;
  if (WINDOWS) {
    const { windowsSuiteCapacity, suiteCapacityShortfalls } = await import('./local-suite-capacity.mjs');
    capacity ??= windowsSuiteCapacity({ timeout: PROBE_TIMEOUT_MS });
    shortfalls = suiteCapacityShortfalls;
  }
  let start;
  let lastMessage;
  const announce = (message) => {
    if (message !== lastMessage) console.log(`local suite ${suite}: ${message}`);
    lastMessage = message;
  };
  while (!start) {
    if (signal?.aborted) return LOCAL_INTERRUPTED_EXIT;
    let reason = `cannot determine start time for local suite PID ${process.pid}`;
    try {
      start = processStarts([process.pid], probeBudget(deadline)).get(process.pid);
    } catch (error) {
      reason += ` (${probeFailure(error)})`;
    }
    if (start && /^[a-f\d]+$/.test(start)) break;
    start = null;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return waitTimeout(suite, waitMs, reason, command.timeoutExit);
    announce(reason);
    await wait(Math.min(probeMs, remaining));
  }
  const name = `clued-local-suite-v1-${process.pid}-${start}-${randomUUID()}`;
  const requestPath = path.join(directory, name);
  let jobGone = false;
  // Open the bakery algorithm's choosing phase with an atomic mkdir. A
  // contender checks all published tickets before choosing its own, and
  // cannot enter while another contender is still choosing. The unique
  // request name breaks ties between tickets chosen concurrently.
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
      if (signal?.aborted) return LOCAL_INTERRUPTED_EXIT;
      requests = requestEntries(directory, name);
      if (requests.length > 0 && performance.now() >= nextProbe && performance.now() < deadline) {
        try {
          const starts = processStarts([...new Set(requests.map(({ pid }) => pid))], probeBudget(deadline));
          stale = new Set(requests.filter(({ pid, start: previous }) =>
            starts.get(pid) !== undefined && starts.get(pid) !== previous).map(({ name: request }) => request));
          probeReason = requests.some(({ pid }) => starts.get(pid) === undefined) ? 'some process identities are unknown' : undefined;
          if (WINDOWS) {
            const pending = [...stale].filter((request) => {
              const location = path.join(directory, request);
              return existsSync(path.join(location, 'granted')) && !existsSync(path.join(location, 'drained'));
            });
            const jobs = probeWindowsJobs(pending, deadline);
            jobsGone = new Set(pending.filter((request) => jobs.get(request) === 'gone'));
            const unknown = pending.find((request) => !['gone', 'live'].includes(jobs.get(request)));
            if (unknown) {
              const code = jobs.get(unknown)?.replace('unknown-', '');
              const reason = code ? `Windows job status unknown (error ${code})` : 'Windows job status unavailable';
              probeReason = [probeReason, reason].filter(Boolean).join('; ');
            }
          }
        } catch (error) {
          probeReason = probeFailure(error);
        }
        nextProbe = performance.now() + probeMs;
      }
      const live = requestTickets(directory, requests, stale, jobsGone);
      const earlier = (request) => request.ticket !== null
        && (request.ticket < ticket || (request.ticket === ticket && request.name < name));
      const ahead = live.filter((request) => earlier(request) && (!WINDOWS || !request.granted)).length;
      const choosing = live.some((request) => request.ticket === null);
      const remaining = deadline - performance.now();
      const holding = path.join(requestPath, 'holding');
      if (!WINDOWS && ahead < SLOT_LIMIT && !choosing && remaining > 0) {
        writeFileSync(holding, '');
        return await runGuard(suite, command, requestPath, holdMs);
      }
      const holders = live.filter(({ holding }) => holding).map(({ suite, pid }) => `${suite} (PID ${pid})`);
      const position = WINDOWS ? ahead + 1 : Math.max(1, ahead - SLOT_LIMIT + 1);
      const message = `queue position ${position}; holders: ${holders.join(', ') || 'none'}`
        + (probeReason ? `; process probe: ${probeReason}` : '');
      if (WINDOWS && ahead === 0 && !choosing) {
        // A later ticket cannot become a holder before this one is granted.
        const reservations = live.filter((request) => request.holding && !request.drained).length;
        const checkResources = async () => {
          try {
            const sample = await capacity.sample(signal);
            const lacks = shortfalls(capacity.needs, sample, reservations);
            return lacks.length ? `resources: ${lacks.join(', ')}; production: idle` : null;
          } catch (error) {
            return `resource sample unavailable (${probeFailure(error)}); production: idle`;
          }
        };
        const checkProduction = async () => {
          const production = await capacity.production(signal);
          return production ? `production: ${production}` : null;
        };
        const productionBlock = await checkProduction();
        if (signal.aborted) return LOCAL_INTERRUPTED_EXIT;
        let blocked = productionBlock ?? await checkResources();
        if (signal.aborted) return LOCAL_INTERRUPTED_EXIT;
        if (!blocked) {
          // Only the first unreserved ticket can decide. Publish the reservation
          // before a later ticket can sample and use the same headroom.
          writeFileSync(holding, '');
          const recheck = async () => {
            // Complete a fresh serial round after readiness, sampling the
            // production paths last so they are closest to permission.
            const resourceBlock = await checkResources();
            if (signal.aborted) return null;
            return await checkProduction() ?? resourceBlock;
          };
          const result = await runWindowsGuard(suite, command, requestPath, recheck, signal, guardTimeoutMs);
          if (typeof result === 'number') return result;
          rmSync(path.join(requestPath, 'ready'), { force: true });
          rmSync(holding);
          blocked = result;
        }
        announce(`${message}; ${blocked}`);
        await wait(probeMs);
        continue;
      }
      if (remaining <= 0) return waitTimeout(suite, waitMs, message, command.timeoutExit);
      announce(message);
      await wait(Math.min(POLL_MS, remaining));
    }
  } catch (error) {
    if (WINDOWS && existsSync(path.join(requestPath, 'granted')) && !existsSync(path.join(requestPath, 'drained'))) {
      try {
        jobGone = probeWindowsJobs([name], performance.now() + PROBE_TIMEOUT_MS).get(name) === 'gone';
      } catch {
        // Keep the reservation for stale-owner recovery if the Job is unknown.
      }
      error.unconfirmedSuiteTree = !jobGone;
    }
    if (WINDOWS && signal.aborted) error.exitCode = LOCAL_INTERRUPTED_EXIT;
    throw error;
  } finally {
    if (jobGone || !existsSync(path.join(requestPath, 'granted')) || existsSync(path.join(requestPath, 'drained'))) {
      if (WINDOWS) {
        try { await rm(requestPath, { recursive: true, force: true, maxRetries: 5 }); } catch (error) {
          if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
          console.error(`local suite ${suite}: could not remove its finished ticket (${probeFailure(error)})`);
        }
      } else reap(requestPath);
    }
  }
}
