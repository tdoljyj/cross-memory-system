// The environment every suite child gets: the selector's (ci-required-selection.mjs) and local-verify's one source. Only
// node: imports, so local-verify --linux can carry it with its own copy.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Clued Task fe8a2cbf (ruling 11-19, layer B): every suite command, whatever its language, runs with the test marker
// CLUED_UNDER_TEST=1, so the installed request tools refuse a test aimed at the fixed production root (node --test adds
// NODE_TEST_CONTEXT on its own; Python and PowerShell suites have only this one). The caller's env is not changed.
// Clued Task 2ee162c2 (ruling 11-20 §2, a stopgap, not the root fix): the same children get a fake identity, so code under
// test that calls the real gh or git finds no real credential by default. A token in the environment comes before any stored
// gh login; gh's configuration directory is an empty directory; git's global configuration is a file holding only a test
// identity, the system configuration (where the credential helper is) is off, and git never prompts. It does not stop code
// that reads a token file by its absolute path.
// Every rule that shapes a suite child's environment is in this file: the variables passed on from the caller, the proxy
// rule, the fake identity, the test marker and what local-verify adds. Its version (TEST_ENV_VERSION) is the hash of this
// whole file (Fable ruling 11-20 "补：止血 PR 第四轮" §3), so any change here, wherever, is another version and a result
// made under another environment (local-verify's cache of main's results) is not taken for one made under this.
export const TEST_ENV_VERSION = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
export const TEST_ENV_RULES = Object.freeze({
  // The variables a suite's commands get from the caller (ruling 11-20 "补：测试身份根修" §3): what a program needs to run,
  // find its tools, its temporary, home and toolchain directories and the network, and the run's own context. Nothing else
  // is passed: a token, a credential-bearing setting (GIT_CONFIG_COUNT, an assistant's variables) or a Clued setting the
  // caller has stays out, a new one too. Names, matched whole and in any case.
  keep: Object.freeze([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES\\(X86\\)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES\\(X86\\)',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USER', 'LOGNAME',
    'SHELL', 'TERM', 'LANG', 'LANGUAGE', 'LC_[A-Z]+', 'TZ',
    'HTTPS?_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    // CI's job storage (ci-temporary-storage) and toolchain settings, and the run's base commit.
    'PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX', 'PYTHONUTF8', 'PYTHONIOENCODING', 'WRANGLER_LOG_PATH', 'PROMPTFOO_CONFIG_DIR',
    'CLUED_CI_NPM_CACHE', 'CI_BASE_SHA',
    // The Actions runner marks every process of a job with RUNNER_TRACKING_ID and, when the job ends, ends the ones still
    // carrying it; without it what a suite leaves running would outlive the job on a self-hosted node. Not a credential.
    'RUNNER_TRACKING_ID',
  ]),
  // A proxy URL can carry a user name and password (Codex review of 2ee162c2, medium 5): such a variable is not passed, nor
  // one that cannot be read as a URL and has an @ in it.
  proxy: '^(HTTPS?|ALL)_PROXY$',
  fakeToken: 'clued-test-fake-token-not-a-credential',
  fakeTokenNames: Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']),
  git: Object.freeze({ name: 'Clued Test', email: 'clued-test@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }),
  marker: Object.freeze({ CLUED_UNDER_TEST: '1' }),
  // local-verify's additions by platform (on Windows Python's own UTF-8 mode stands in for the runners' UTF-8 locale), and
  // the only run values it may set.
  localVerify: Object.freeze({ win32: Object.freeze({ PYTHONUTF8: '1' }), values: Object.freeze(['CI_BASE_SHA', 'TEMP', 'TMP', 'TMPDIR']) }),
});
export const FAKE_GITHUB_TOKEN = TEST_ENV_RULES.fakeToken;
export const TEST_GIT_IDENTITY = { name: TEST_ENV_RULES.git.name, email: TEST_ENV_RULES.git.email };
export function fakeIdentityEnv(dir, run) {
  const { fakeToken, fakeTokenNames, git } = TEST_ENV_RULES;
  return { ...Object.fromEntries(fakeTokenNames.map((name) => [name, fakeToken])),
    GH_CONFIG_DIR: path.join(dir, 'gh'), GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: git.GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT: git.GIT_TERMINAL_PROMPT,
    CLUED_TEST_IDENTITY_DIR: dir, CLUED_TEST_IDENTITY_RUN: run };
}
// One directory per run, under the run's temporary directory. A command line (markTestRun) always makes its own, before any
// child starts; a process below it (the suite slot worker, a test calling the selector) takes the one it inherits, so a
// child killed on a timeout leaves nothing behind. Taken only when it is the run's (Codex reviews of 2ee162c2, medium 4 and
// second review medium 1): an absolute path to a real directory (no link) with this code's name, a run record naming the
// run id the env carries (a random id that only reaches the run's own children) and the process that made it, still
// running; the git file exactly as written and gh's directory empty. Anything else (a stale value, a killed run's, one a
// suite changed) is not taken and a new one is made. Checked again for every child. Every directory a process makes is
// removed when it exits; the clean-up is in place before the first is made.
const PREFIX = 'clued-test-identity-';
const GITCONFIG = `[user]\n\tname = ${TEST_GIT_IDENTITY.name}\n\temail = ${TEST_GIT_IDENTITY.email}\n`;
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
// A process is its id and its start time (Codex third review of 2ee162c2, low 1: an id can be reused). The start time as
// the system keeps it: the start field of /proc/<pid>/stat on Linux, the process's start ticks on Windows; null when it
// cannot be read. Read once per process and id.
const starts = new Map();
export function startOf(pid) {
  if (!starts.has(pid)) {
    let start = null;
    try {
      if (process.platform === 'linux') {
        start = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] ?? null;
      } else if (process.platform === 'win32') {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
        start = result.status === 0 && /^\d+$/.test(result.stdout.trim()) ? result.stdout.trim() : null;
      }
    } catch {
      start = null;
    }
    starts.set(pid, start);
  }
  return starts.get(pid);
}
// The maker is known to be running: its id is in use by a process with its start time.
const makerRunning = (maker) => Number.isInteger(maker?.pid) && maker.pid > 0 && running(maker.pid)
  && typeof maker.started === 'string' && startOf(maker.pid) === maker.started;
// The maker is known to have exited: its id is free, or in use by a process started at another time.
const makerExited = (maker) => Number.isInteger(maker?.pid) && maker.pid > 0 && typeof maker.started === 'string'
  && (!running(maker.pid) || (startOf(maker.pid) !== null && startOf(maker.pid) !== maker.started));
function record(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'run'), 'utf8'));
  } catch {
    return null;
  }
}
// The full canonical path (Codex third review of 2ee162c2, medium 1): absolute with a drive on Windows, already resolved, and
// its own real path through every ancestor (no link, junction or short name on the way), so the path checked is the path
// the children use, whatever their working directory.
function canonical(dir) {
  try {
    return typeof dir === 'string' && path.isAbsolute(dir) && (process.platform !== 'win32' || /^[A-Za-z]:\\/.test(dir))
      && path.resolve(dir) === dir && realpathSync.native(dir) === dir;
  } catch {
    return false;
  }
}
function taken(dir, run) {
  try {
    if (!canonical(dir) || typeof run !== 'string' || !path.basename(dir).startsWith(PREFIX)) return false;
    const [self, gh, git, file] = [dir, path.join(dir, 'gh'), path.join(dir, 'gitconfig'), path.join(dir, 'run')].map((entry) => lstatSync(entry));
    if (!self.isDirectory() || !gh.isDirectory() || !git.isFile() || !file.isFile()) return false;
    const made = record(dir);
    return made?.run === run && makerRunning(made)
      && readFileSync(path.join(dir, 'gitconfig'), 'utf8') === GITCONFIG && readdirSync(path.join(dir, 'gh')).length === 0;
  } catch {
    return false;
  }
}
// The exit clean-up tries every directory: one that cannot be removed does not stop the others (it returns those).
export function removeEach(dirs, remove = (dir) => rmSync(dir, { recursive: true, force: true })) {
  const failed = [];
  for (const dir of dirs) {
    try {
      remove(dir);
    } catch {
      failed.push(dir);
    }
  }
  return failed;
}
const made = new Set();
let current = null;
// What a killed run left (Codex second review of 2ee162c2, low 1): before making its directory a process removes, in the
// same temporary area, the identity directories whose run has ended. Only one it can tell is a run's (Codex third review,
// medium 3): a real directory (no link) whose run record is a regular file naming its maker, and that maker has exited.
// Anything else with the name (no record yet, a record without a maker, an unreadable one, another kind of entry) is left.
function ended(dir) {
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(path.join(dir, 'run')).isFile()) return false;
    const maker = JSON.parse(readFileSync(path.join(dir, 'run'), 'utf8'));
    return makerExited(maker);
  } catch {
    return false;
  }
}
function sweep(base) {
  let names;
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.startsWith(PREFIX))) {
    const dir = path.join(base, name);
    try {
      if (!made.has(dir) && ended(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // the next run tries again
    }
  }
}
// own: a command line's own directory, never an inherited one.
export function testIdentity(env = process.env, { own = false } = {}) {
  if (!own && taken(env.CLUED_TEST_IDENTITY_DIR, env.CLUED_TEST_IDENTITY_RUN)) return { dir: env.CLUED_TEST_IDENTITY_DIR, run: env.CLUED_TEST_IDENTITY_RUN };
  if (current && taken(current.dir, current.run)) return current;
  if (made.size === 0) process.once('exit', () => removeEach(made));
  const base = path.resolve(env.RUNNER_TEMP || os.tmpdir());
  sweep(base);
  const dir = realpathSync.native(mkdtempSync(path.join(base, PREFIX)));
  made.add(dir);
  const run = randomUUID();
  mkdirSync(path.join(dir, 'gh'));
  writeFileSync(path.join(dir, 'gitconfig'), GITCONFIG);
  writeFileSync(path.join(dir, 'run'), JSON.stringify({ run, pid: process.pid, started: startOf(process.pid) }));
  current = { dir, run };
  return current;
}
export const KEEP_VARIABLE = new RegExp(`^(${TEST_ENV_RULES.keep.join('|')})$`, 'i');
const PROXY = new RegExp(TEST_ENV_RULES.proxy, 'i');
function credentialFree(value) {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    return !url.username && !url.password;
  } catch {
    return !String(value).includes('@');
  }
}
export const keptVariables = (env) => Object.fromEntries(Object.entries(env)
  .filter(([name, value]) => KEEP_VARIABLE.test(name) && (!PROXY.test(name) || credentialFree(value))));
export function testEnv(env, { own = false } = {}) {
  const { dir, run } = testIdentity(env, { own });
  return { ...keptVariables(env), ...fakeIdentityEnv(dir, run), ...TEST_ENV_RULES.marker };
}
// local-verify's environment: its own command line's (a directory of its own), its additions for the platform, and the run
// values it may set (any other name is refused).
export function localVerifyEnv(env, values = {}, platform = process.platform) {
  const { localVerify } = TEST_ENV_RULES;
  const unknown = Object.keys(values).filter((name) => !localVerify.values.includes(name));
  if (unknown.length) throw new Error(`${unknown.join(', ')}: not a value local-verify sets (TEST_ENV_RULES.localVerify.values)`);
  return { ...testEnv(env, { own: true }), ...(platform === 'win32' ? localVerify.win32 : {}), ...values };
}
