import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// Run-level estimates used by local-verify.
export const RUN_NEEDS = { memGb: 6, cores: 4, dataGb: 3, systemGb: 3 };
export const HOST_KEEPS = { memGb: 10, cores: 4, dataGb: 10 };
// Fallback until same-host suite peaks are available: GitHub's standard
// Windows runner for private repositories has 8 GB RAM and 2 vCPUs.
const SUITE_NEEDS = { memGiB: 8, cores: 2 };
export const CPU_SAMPLE_MS = 500;
export const RESIDENT_STATUS_WINDOWS = 'C:\\ProgramData\\CluedIndependentCI\\resident\\state\\status.json';
export const RESIDENT_STALE_MS = 5 * 60_000; // the service publishes every 15 seconds

export function cpuTimeDeltas(before, after) {
  const total = (list) => list.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
  const idle = (list) => list.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  return { span: total(after) - total(before), idleSpan: idle(after) - idle(before) };
}

const exec = promisify(execFile);
const GIB = 1024 ** 3;
const profiles = new URL('./self-hosted/node-profiles.json', import.meta.url);
const ps = (command, signal, timeout) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(command, 'utf16le').toString('base64')],
  { windowsHide: true, signal, timeout });
const wsl = (args, signal, timeout) => exec('wsl.exe', args, { windowsHide: true, signal, timeout, encoding: 'buffer' });

function residentStatus(file, required) {
  try {
    const status = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const age = Date.now() - Date.parse(status?.writtenAt);
    if (!(age >= 0 && age <= RESIDENT_STALE_MS) || !Object.hasOwn(status, 'current')) return 'resident CI status is stale or invalid';
    if (status.current === null || status.current?.phase === 'relay-wait') return null;
    return typeof status.current?.phase === 'string' ? 'resident CI is running a local batch' : 'resident CI status is invalid';
  } catch (error) {
    return error.code === 'ENOENT' && !required ? null : 'resident CI status is unavailable';
  }
}

async function linuxStatus(distros, residentDistro, signal, timeout) {
  if (!distros.size && !residentDistro) return null;
  try {
    const list = async (options) => {
      const { stdout } = await wsl(['--list', ...options, '--quiet'], signal, timeout);
      const text = stdout.toString(stdout.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
      return new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    };
    const registered = await list([]);
    const running = await list(['--running']);
    const hidden = [...distros].find((distro) => !registered.has(distro));
    // The service's distro may belong to a different Windows account. Its
    // resident status page is the signal for that path when WSL cannot list it.
    const configured = [...new Set([...distros, residentDistro])].filter((distro) => running.has(distro));
    const results = [];
    for (const distro of configured) {
      try {
        await wsl(['-d', distro, '--exec', 'pgrep', '-x', 'Runner.Worker'], signal, timeout);
        results.push(`${distro} Runner.Worker is running`);
      } catch (error) {
        if (error.code === 1 && error.stderr?.length === 0 && error.stdout?.length === 0) continue;
        results.push(`${distro} Runner.Worker status is unavailable`);
      }
    }
    if (hidden) results.push(`${hidden} registration is not visible`);
    return results.join('; ') || null;
  } catch {
    return 'production WSL status is unavailable';
  }
}

export function windowsSuiteCapacity({ timeout }) {
  const { hosts, capacity_profiles: capacities } = JSON.parse(readFileSync(profiles, 'utf8'));
  const host = hosts.find(({ hostname, state }) => hostname.toLowerCase() === os.hostname().toLowerCase() && state !== 'retired');
  const residentDistro = host?.governance?.resident_distro;
  const distros = new Set([host?.linux_runner, ...(host?.additional_linux_runners ?? [])]
    .filter((runner) => runner?.distro && runner.state !== 'retired').map(({ distro }) => distro));
  const logical = os.availableParallelism();
  const hostCores = host ? HOST_KEEPS.cores : 0;
  // Scale the two reservations together with room for ordinary CPU activity,
  // including on hosts with one logical processor.
  const cpuScale = Math.min(1, logical / (SUITE_NEEDS.cores + hostCores + 1));
  const needs = { physical: SUITE_NEEDS.memGiB * GIB, commit: SUITE_NEEDS.memGiB * GIB, cpu: SUITE_NEEDS.cores * cpuScale };
  const keepMem = host ? capacities[host.capacity_profile].resume_free_memory_gb * GIB : 0;
  const keepCpu = hostCores * cpuScale;
  return {
    needs,
    async production(signal) {
      // Finish the slower WSL checks before sampling the Windows worker.
      const linux = await linuxStatus(distros, residentDistro, signal, timeout);
      const resident = residentStatus(RESIDENT_STATUS_WINDOWS, Boolean(residentDistro));
      const windows = await ps("[Diagnostics.Process]::GetProcessesByName('Runner.Worker').Length", signal, timeout)
        .then(({ stdout }) => /^0\s*$/.test(stdout) ? null : /^\d+\s*$/.test(stdout)
          ? 'Windows Runner.Worker is running' : 'Windows Runner.Worker status is unavailable',
        () => 'Windows Runner.Worker status is unavailable');
      return [windows, linux, resident].filter(Boolean).join('; ') || null;
    },
    async sample(signal) {
      const before = os.cpus();
      await delay(CPU_SAMPLE_MS, undefined, { signal });
      const after = os.cpus();
      const { span, idleSpan } = cpuTimeDeltas(before, after);
      const memory = await ps(`$ErrorActionPreference = 'Stop'; $mem = Get-CimInstance Win32_PerfRawData_PerfOS_Memory;
        "$($mem.AvailableBytes) $($mem.CommittedBytes) $($mem.CommitLimit)"`, signal, timeout);
      const [physical, committed, limit] = memory.stdout.trim().split(/\s+/).map(Number);
      const validCpu = before.length === after.length && Number.isFinite(span) && span > 0 && idleSpan >= 0 && idleSpan <= span;
      if (![physical, committed, limit].every(Number.isSafeInteger) || physical < 0 || committed <= 0 || limit < committed || !validCpu) {
        throw new Error('invalid host resource counters');
      }
      return { physical: physical - keepMem, commit: limit - committed - keepMem, cpu: logical * idleSpan / span - keepCpu };
    },
  };
}

export function suiteCapacityShortfalls(needs, sample, holders) {
  // No reliable per-tree attribution is available in this sample. Keep the
  // full reservation for each holder, including legacy tickets, until drain.
  const labels = { physical: 'physical memory', commit: 'commit headroom', cpu: 'CPU' };
  return Object.keys(labels).filter((key) => !Number.isFinite(sample[key]) || sample[key] - holders * needs[key] < needs[key])
    .map((key) => labels[key]);
}
