// The environment every suite child gets: the selector's (ci-required-selection.mjs) and local-verify's one source. Only
// node: imports, so local-verify --linux can carry it with its own copy.
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
// The version of this environment: the hash of this file, so a result made under another (local-verify's cache of main's
// results) is not taken for one made under this, whoever changes it.
export const TEST_ENV_VERSION = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
export const FAKE_GITHUB_TOKEN = 'clued-test-fake-token-not-a-credential';
export const TEST_GIT_IDENTITY = { name: 'Clued Test', email: 'clued-test@example.invalid' };
export function fakeIdentityEnv(dir, run) {
  const token = FAKE_GITHUB_TOKEN;
  return { GH_TOKEN: token, GITHUB_TOKEN: token, GH_ENTERPRISE_TOKEN: token, GITHUB_ENTERPRISE_TOKEN: token,
    GH_CONFIG_DIR: path.join(dir, 'gh'), GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
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
    return made?.run === run && Number.isInteger(made.pid) && running(made.pid)
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
    return Number.isInteger(maker?.pid) && maker.pid > 0 && !running(maker.pid);
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
  writeFileSync(path.join(dir, 'run'), JSON.stringify({ run, pid: process.pid }));
  current = { dir, run };
  return current;
}
// The variables a suite's commands get from the caller (ruling 11-20 "补：测试身份根修" §3; the one list, local-verify.mjs reads
// it too): what a program needs to run, find its tools, its temporary, home and toolchain directories and the network, and
// the run's own context. Nothing else is passed: a token, a credential-bearing setting (GIT_CONFIG_COUNT, an assistant's
// variables) or a Clued setting the caller has stays out, a new one too.
export const KEEP_VARIABLE = new RegExp(`^(${[
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
].join('|')})$`, 'i');
// A proxy URL can carry a user name and password (Codex review of 2ee162c2, medium 5): such a variable is not passed, nor one
// that cannot be read as a URL and has an @ in it.
const PROXY = /^(HTTPS?|ALL)_PROXY$/i;
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
  return { ...keptVariables(env), ...fakeIdentityEnv(dir, run), CLUED_UNDER_TEST: '1' };
}
