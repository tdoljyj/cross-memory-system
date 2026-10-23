// Child-process runner shared by the service and the companion: fixed argv, no shell, a minimal
// fixed environment, bounded output. A child that outlives its timeout is never killed (the
// existing CI's rule: never kill an unknown process tree); the caller is told it timed out and the
// runner stays "busy" until the child exits, so no new work starts on top of it.
//
// The companion's runners take a job host instead (DESIGN §24, Task 8e1f07d3): every child is started by
// bin\CluedCompanionJobHost.exe (windows/CompanionJobHost.cs), which creates it suspended inside a job object of its own
// and, once the child has exited or outlived its time limit, terminates and drains exactly that job. The tree it ends is
// therefore never unknown, and a timed-out child no longer keeps the companion busy. The service's runner keeps the rule
// above unchanged: its Windows proofs (windowsTreeZero) rest on it.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const FIXED_ENV = Object.freeze({ SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', OS: 'Windows_NT', COMPUTERNAME: 'TURING' });
// The service passes its own temp directory on top of FIXED_ENV (see service-main.mjs): without TEMP/TMP a
// child of a profile-less service account resolves the temp path to C:\Windows (GetTempPath), where Windows
// PowerShell's Add-Type (archive-windows-spool.ps1) cannot write.
export function serviceEnv(tempDir) {
  if (typeof tempDir !== 'string' || !/^[A-Za-z]:\\/.test(tempDir) || /[\0;"]/.test(tempDir)) throw new Error('SERVICE_TEMP_DIR_REFUSED');
  return Object.freeze({ ...FIXED_ENV, TEMP: tempDir, TMP: tempDir });
}
// USERPROFILE / LOCALAPPDATA, which run-batch.ps1:12 sets to the Owner's profile today, are left out
// on purpose: the service account must not resolve anything from a user profile (Source v2 review).
const MAX_OUTPUT = 4 * 1024 * 1024;

// The job host: its own limit bounds the child (CompanionJobHost.cs MinTimeout/MaxTimeout); the runner waits that long
// plus JOB_HOST_GRACE_MS (the host's drain takes at most 30 s) before it ends the host itself. Ending the host closes its
// job object, and the kernel ends every process still in it (KILL_ON_JOB_CLOSE): still only the tree that host started.
export const JOB_HOST_EXE = 'CluedCompanionJobHost.exe'; // in the resident root's bin directory, compiled at install
export const JOB_HOST_REPORT_CONTRACT = 'clued.independent-ci.companion-job-host-report/1';
export const JOB_HOST_GRACE_MS = 60_000;
export const JOB_HOST_MIN_TIMEOUT_MS = 1000;
export const JOB_HOST_MAX_TIMEOUT_MS = 3_600_000;
const REPORT_TAIL = 4096;
const REPORT_KEYS = ['contract', 'started', 'failure', 'childPid', 'timedOut', 'exitCode', 'leftover', 'activeProcesses', 'totalProcesses', 'treeZero'];
const count = v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff);

// The host's report: the last line on its stderr, for exactly this nonce, in exactly the host's shape. null otherwise.
export function parseJobHostReport(stderrTail, nonce) {
  const lines = String(stderrTail).replace(/\r?\n$/, '').split(/\r?\n/);
  const m = /^clued-job-host ([0-9a-f]{32}) (\{.*\})$/.exec(lines[lines.length - 1] ?? '');
  if (!m || m[1] !== nonce) return null;
  let v;
  try { v = JSON.parse(m[2]); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join('|') !== [...REPORT_KEYS].sort().join('|')) return null;
  if (v.contract !== JOB_HOST_REPORT_CONTRACT || typeof v.started !== 'boolean' || typeof v.timedOut !== 'boolean' || typeof v.treeZero !== 'boolean') return null;
  if (!(v.failure === null || (typeof v.failure === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(v.failure)))) return null;
  if (!['childPid', 'exitCode', 'leftover', 'activeProcesses', 'totalProcesses'].every(k => count(v[k]))) return null;
  return v;
}
// The report line is the host's, not the child's: it is taken off the stderr the caller sees.
const withoutReport = (stderr, nonce) => stderr.replace(new RegExp(`\\r?\\n?clued-job-host ${nonce} \\{[^\\n]*\\}\\r?\\n?$`), '');

export class Runner {
  // jobHost: the absolute path of the installed job host (companion only), or null for the service's direct children.
  constructor({ env = FIXED_ENV, spawnImpl = spawn, jobHost = null, nonce = () => randomBytes(16).toString('hex') } = {}) {
    if (jobHost !== null && (typeof jobHost !== 'string' || !/^[A-Za-z]:\\/.test(jobHost) || /[\0"]/.test(jobHost))) throw new Error('RUNNER_JOB_HOST_REFUSED');
    this.env = { ...env };
    this.spawnImpl = spawnImpl;
    this.jobHost = jobHost;
    this.nonce = nonce;
    this.outstanding = new Set();
  }

  get busy() { return this.outstanding.size > 0; }

  run(argv, { timeoutMs }) {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string' && !a.includes('\0'))) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', refused: 'RUNNER_ARGV_REFUSED' });
    }
    if (this.busy) return Promise.resolve({ code: null, stdout: '', stderr: '', refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' });
    if (this.jobHost !== null) return this.hosted(argv, timeoutMs);
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

  // One child under the job host. The answer adds `tree` when the child did not simply end on its own: 'zero' = the host
  // terminated its job and saw no process of it left; 'unconfirmed' = it could not show that (the job still closed with
  // the host). The runner is busy exactly while the host runs.
  hosted(argv, timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < JOB_HOST_MIN_TIMEOUT_MS || timeoutMs > JOB_HOST_MAX_TIMEOUT_MS) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', refused: 'RUNNER_TIMEOUT_REFUSED' });
    }
    const nonce = this.nonce();
    return new Promise(resolve => {
      const child = this.spawnImpl(this.jobHost, [nonce, String(timeoutMs), ...argv], { shell: false, windowsHide: true, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.outstanding.add(child);
      let stdout = '';
      let stderr = '';
      let tail = '';
      let settled = false;
      const take = (which, chunk) => {
        if (which === 'out' && stdout.length < MAX_OUTPUT) stdout += chunk;
        if (which === 'err') { if (stderr.length < MAX_OUTPUT) stderr += chunk; tail = (tail + chunk).slice(-REPORT_TAIL); }
      };
      child.stdout?.setEncoding('utf8').on('data', c => take('out', c));
      child.stderr?.setEncoding('utf8').on('data', c => take('err', c));
      const settle = v => { if (!settled) { settled = true; resolve(v); } };
      // The host outstayed its own limit and drain: end the host (only it; its job goes with it) and stay busy until it is gone.
      const guard = setTimeout(() => {
        settle({ code: null, stdout, stderr, timedOut: true, tree: 'unconfirmed' });
        try { child.kill(); } catch { /* the close event still ends the busy state */ }
      }, timeoutMs + JOB_HOST_GRACE_MS);
      // 'error' without a pid: the host never started. With a pid (for example a refused kill) the host may still run: the
      // runner stays busy until its close event.
      child.on('error', () => {
        if (child.pid !== undefined) return;
        this.outstanding.delete(child); clearTimeout(guard); settle({ code: null, stdout, stderr, refused: 'RUNNER_SPAWN_FAILED' });
      });
      child.on('close', code => {
        this.outstanding.delete(child);
        clearTimeout(guard);
        const report = parseJobHostReport(tail, nonce);
        const err = withoutReport(stderr, nonce);
        // No report: whether a child ran is unknown (its job closed with the host). A report without a started child: none
        // ran, unless the host created one it then could not show ended (never resumed, but not seen gone either).
        if (!report) return settle({ code: null, stdout, stderr: err, refused: 'JOB_HOST_UNCONFIRMED', tree: 'unconfirmed' });
        if (report.started !== true) return settle({ code: null, stdout, stderr: err, refused: 'JOB_HOST_UNCONFIRMED', ...(report.treeZero ? {} : { tree: 'unconfirmed' }) });
        const tree = report.treeZero ? 'zero' : 'unconfirmed';
        if (report.timedOut) return settle({ code: null, stdout, stderr: err, timedOut: true, tree });
        // Ended on its own: its exit code, as the host saw it and passed it on. A leftover the host could not drain is said.
        if (report.failure !== null || report.exitCode === null || report.exitCode !== code) return settle({ code: null, stdout, stderr: err, refused: 'JOB_HOST_UNCONFIRMED', tree });
        settle({ code: report.exitCode, stdout, stderr: err, ...(report.treeZero ? {} : { tree }) });
      });
    });
  }
}
