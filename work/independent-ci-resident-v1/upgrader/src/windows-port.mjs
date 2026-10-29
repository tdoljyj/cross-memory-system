// The Windows half: every change outside the upgrader's own files goes through the frozen upgrade-apply.ps1
// (upgrader\<manifestSha>\windows\upgrade-apply.ps1, spec B2), run by the in-box Windows PowerShell with fixed arguments.
// The script reads only ops\<opId>\010-accept.plan.json, checked against -PlanSha256; no path, command line or free
// string is ever passed. Each action prints one line of JSON ({ ok, code, ... }) and exits 0 only on success.
//
// Actions and what the upgrader expects back (besides ok/code):
//   ReadScm                  { resident: { state, binPath }, broker: { state, binPath }, runner: { state, originalBinary },
//                              companionTask: { path, arguments } }     state: 'running' | 'stopped' | other text
//   Compile                  writes upgrade\staged\<pkgSha>\compiled\{bin\*.exe, helpers\*.exe, config\broker.json} (idempotent)
//   StopServices             resident first (it ends by itself), then the broker
//   SwitchScm -Generation N  binPaths of generation N (N = toGeneration: from the plan; otherwise generations\gN\generation.json)
//   RegisterCompanionTask -Generation N   only the task's Arguments
//   RestartCompanion | StartServices
//   Verify -Generation N [-ExpectPausedSha256 <sha>]   verify-resident.ps1's checks for generation N
import { spawn } from 'node:child_process';
import path from 'node:path';
import { CODE, HEX64, UUID, check } from '../../src/canonical.mjs';

export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const ACTIONS = Object.freeze(['ReadScm', 'Compile', 'StopServices', 'SwitchScm', 'RegisterCompanionTask', 'RestartCompanion', 'StartServices', 'Verify']);
export const ACTION_TIMEOUT_MS = Object.freeze({ ReadScm: 60_000, Compile: 600_000, StopServices: 300_000, SwitchScm: 120_000, RegisterCompanionTask: 120_000,
  RestartCompanion: 120_000, StartServices: 300_000, Verify: 600_000 });
const OUTPUT_MAX = 64 * 1024;

// The argv for one action: fixed names, values checked by shape.
export function applyArgs(scriptPath, action, { opId, planSha256, generation = null, expectPausedSha256 = null }) {
  check(ACTIONS.includes(action) && UUID.test(opId ?? '') && HEX64.test(planSha256 ?? ''), 'UPGRADE_APPLY_ARGS_REFUSED', action);
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action', action, '-OpId', opId, '-PlanSha256', planSha256];
  if (generation !== null) { check(Number.isSafeInteger(generation) && generation >= 1, 'UPGRADE_APPLY_ARGS_REFUSED', 'generation'); argv.push('-Generation', String(generation)); }
  if (expectPausedSha256 !== null) { check(HEX64.test(expectPausedSha256), 'UPGRADE_APPLY_ARGS_REFUSED', 'paused'); argv.push('-ExpectPausedSha256', expectPausedSha256); }
  return argv;
}

// The last line of stdout as one JSON object; ok only with exit 0 and ok:true.
export function parseApplyOutput(exit, stdout) {
  let v = null;
  try { v = JSON.parse(String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''); } catch { v = null; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'UPGRADE_APPLY_OUTPUT_REFUSED' };
  const ok = exit === 0 && v.ok === true;
  return { ...v, ok, code: ok ? null : (typeof v.code === 'string' && CODE.test(v.code) ? v.code : 'UPGRADE_APPLY_FAILED') };
}

function run(file, argv, timeoutMs) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try { child = spawn(file, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } }); } catch { resolve({ exit: null, stdout: '' }); return; }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', d => { if (out.length < OUTPUT_MAX) out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve({ exit: null, stdout: out }); });
    child.on('close', code => { clearTimeout(timer); resolve({ exit: code, stdout: out }); });
  });
}

export class WindowsPort {
  // upgraderDir: upgrader\<manifestSha> (its windows\upgrade-apply.ps1 is the frozen copy).
  constructor({ upgraderDir, powershell = POWERSHELL, runImpl = run }) {
    this.script = path.join(upgraderDir, 'windows', 'upgrade-apply.ps1');
    this.powershell = powershell;
    this.runImpl = runImpl;
  }

  async apply(action, args) {
    const { exit, stdout } = await this.runImpl(this.powershell, applyArgs(this.script, action, args), ACTION_TIMEOUT_MS[action]);
    return parseApplyOutput(exit, stdout);
  }

  readScm(a) { return this.apply('ReadScm', a); }
  compile(a) { return this.apply('Compile', a); }
  stopServices(a) { return this.apply('StopServices', a); }
  switchScm(a) { return this.apply('SwitchScm', a); }
  registerCompanionTask(a) { return this.apply('RegisterCompanionTask', a); }
  restartCompanion(a) { return this.apply('RestartCompanion', a); }
  startServices(a) { return this.apply('StartServices', a); }
  verify(a) { return this.apply('Verify', a); }
}
