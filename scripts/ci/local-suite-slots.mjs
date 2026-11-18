import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SLOT_LIMIT = 2;
const WAIT_MS = 20 * 60_000;
const POLL_MS = 1_000;
const REQUEST = /^clued-local-suite-v1-(\d+)-([a-f\d]+)-[a-f\d-]{36}$/;
const TICKET = /^ticket-(\d+)-([a-z][a-z\d-]*)$/;

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

function processStarts(pids) {
  if (pids.length === 0) return new Map();
  if (process.platform === 'win32') {
    const command = `foreach ($id in ${pids.join(',')}) {
      try {
        $p = [System.Diagnostics.Process]::GetProcessById($id)
        if ($p.HasExited) { "$id gone" } else { "$id $($p.StartTime.ToUniversalTime().ToFileTimeUtc())" }
      } catch [System.ArgumentException] { "$id gone" }
        catch { "$id unknown" }
    }`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true });
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
        { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 5_000 }).trim();
      const instant = Date.parse(`${start} UTC`);
      return [pid, Number.isFinite(instant) ? String(instant) : undefined];
    } catch {
      return [pid, undefined];
    }
  }));
}

function requestTickets(directory, self) {
  const requests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = entry.isDirectory() && REQUEST.exec(entry.name);
    const pid = Number(match?.[1]);
    if (pid > 0 && pid <= 0x7fffffff && entry.name !== self) requests.push({ name: entry.name, pid, start: match[2] });
  }
  const starts = processStarts([...new Set(requests.map(({ pid }) => pid))]);
  const live = [];
  for (const request of requests) {
    const requestPath = path.join(directory, request.name);
    const start = starts.get(request.pid);
    if (start !== undefined && start !== request.start) {
      // The path includes a UUID and is never reused, so two reapers cannot
      // remove a different owner. A sticky /tmp may deny cross-user cleanup.
      try { rmSync(requestPath, { recursive: true, force: true }); } catch (error) {
        if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
      }
      continue;
    }
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
    const ticket = names.map((name) => TICKET.exec(name)).find(Boolean);
    live.push({ ...request, ticket: ticket ? Number(ticket[1]) : null, suite: ticket?.[2], holding: names.includes('holding') });
  }
  return live;
}

export async function withLocalSuiteSlot(suite, run, { directory = sharedDirectory(), waitMs = WAIT_MS } = {}) {
  const deadline = performance.now() + waitMs;
  const start = processStarts([process.pid]).get(process.pid);
  if (!start || !/^[a-f\d]+$/.test(start)) throw new Error(`cannot determine start time for local suite PID ${process.pid}`);
  const name = `clued-local-suite-v1-${process.pid}-${start}-${randomUUID()}`;
  const requestPath = path.join(directory, name);
  // Open the bakery algorithm's choosing phase with an atomic mkdir. A
  // contender checks all published tickets before choosing its own, and
  // cannot enter while another contender is still choosing. The first
  // SLOT_LIMIT live tickets may run, with the unique request name breaking ties.
  mkdirSync(requestPath, { mode: 0o755 });
  try {
    if (process.platform !== 'win32') chmodSync(requestPath, 0o755);
    const ticket = 1 + Math.max(0, ...requestTickets(directory, name).map((request) => request.ticket ?? 0));
    writeFileSync(path.join(requestPath, `ticket-${ticket}-${suite}`), '');
    let lastMessage;
    for (;;) {
      const live = requestTickets(directory, name);
      const ahead = live.filter((request) => request.ticket !== null
        && (request.ticket < ticket || (request.ticket === ticket && request.name < name))).length;
      const remaining = deadline - performance.now();
      if (ahead < SLOT_LIMIT && !live.some((request) => request.ticket === null) && remaining > 0) {
        writeFileSync(path.join(requestPath, 'holding'), '');
        return await run();
      }
      const holders = live.filter(({ holding }) => holding).map(({ suite, pid }) => `${suite} (PID ${pid})`);
      const message = `queue position ${Math.max(1, ahead - SLOT_LIMIT + 1)}; holders: ${holders.join(', ') || 'none'}`;
      if (remaining <= 0) throw new Error(`LOCAL_SUITE_SLOT_TIMEOUT: ${suite} waited ${waitMs} ms; ${message}`);
      if (message !== lastMessage) console.log(`local suite ${suite}: ${message}`);
      lastMessage = message;
      await delay(Math.min(POLL_MS, remaining));
    }
  } finally {
    rmSync(requestPath, { recursive: true, force: true });
  }
}
