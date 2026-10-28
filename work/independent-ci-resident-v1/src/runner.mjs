// Child-process runner shared by the service and the companion: fixed argv, no shell, a minimal
// fixed environment, bounded output. A child that outlives its timeout is never killed (the
// existing CI's rule: never kill an unknown process tree); the caller is told it timed out and the
// runner stays "busy" until the child exits, so no new work starts on top of it.
import { pinnedNodeProfile } from './node-profile.mjs';
import { spawn } from 'node:child_process';

export const FIXED_ENV = Object.freeze({ SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', OS: 'Windows_NT' });
// The service passes its own temp directory on top of FIXED_ENV (see service-main.mjs): without TEMP/TMP a
// child of a profile-less service account resolves the temp path to C:\Windows (GetTempPath), where Windows
// PowerShell's Add-Type (archive-windows-spool.ps1) cannot write.
export function serviceEnv(tempDir, node, nodeProfileSha256) {
  if (typeof tempDir !== 'string' || !/^[A-Za-z]:\\/.test(tempDir) || /[\0;"]/.test(tempDir)) throw new Error('SERVICE_TEMP_DIR_REFUSED');
  return Object.freeze({ ...FIXED_ENV, COMPUTERNAME: pinnedNodeProfile(node, nodeProfileSha256).hostname, TEMP: tempDir, TMP: tempDir });
}
// USERPROFILE / LOCALAPPDATA, which run-batch.ps1:12 sets to the Owner's profile today, are left out
// on purpose: the service account must not resolve anything from a user profile (Source v2 review).
const MAX_OUTPUT = 4 * 1024 * 1024;

export class Runner {
  constructor({ env = FIXED_ENV, spawnImpl = spawn } = {}) {
    this.env = { ...env };
    this.spawnImpl = spawnImpl;
    this.outstanding = new Set();
  }

  get busy() { return this.outstanding.size > 0; }

  run(argv, { timeoutMs }) {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string' && !a.includes('\0'))) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', refused: 'RUNNER_ARGV_REFUSED' });
    }
    if (this.busy) return Promise.resolve({ code: null, stdout: '', stderr: '', refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' });
    return new Promise(resolve => {
      const child = this.spawnImpl(argv[0], argv.slice(1), { shell: false, windowsHide: true, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.outstanding.add(child);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const take = (which, chunk) => {
        if (which === 'out' && stdout.length < MAX_OUTPUT) stdout += chunk;
        if (which === 'err' && stderr.length < MAX_OUTPUT) stderr += chunk;
      };
      child.stdout?.setEncoding('utf8').on('data', c => take('out', c));
      child.stderr?.setEncoding('utf8').on('data', c => take('err', c));
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ code: null, stdout, stderr, timedOut: true }); } }, timeoutMs);
      child.on('error', () => { this.outstanding.delete(child); clearTimeout(timer); if (!settled) { settled = true; resolve({ code: null, stdout, stderr, refused: 'RUNNER_SPAWN_FAILED' }); } });
      child.on('close', code => { this.outstanding.delete(child); clearTimeout(timer); if (!settled) { settled = true; resolve({ code, stdout, stderr }); } });
    });
  }
}
