// The environment every suite child gets: the selector's (ci-required-selection.mjs) and local-verify's one source. Only
// node: imports, so local-verify --linux can carry it with its own copy.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Clued Task fe8a2cbf (ruling 11-19, layer B): every suite command, whatever its language, runs with the test marker
// CLUED_UNDER_TEST=1, so the installed request tools refuse a test aimed at the fixed production root (node --test adds
// NODE_TEST_CONTEXT on its own; Python and PowerShell suites have only this one). The caller's env is not changed.
// Clued Task 2ee162c2 (ruling 11-20 §2, a stopgap, not the root fix): the same children get a fake identity, so code under
// test that calls the real gh or git finds no real credential by default. A token in the environment comes before any stored
// gh login; gh's configuration directory is an empty directory; git's global configuration is a file holding only a test
// identity, the system configuration (where the credential helper is) is off, and git never prompts. It does not stop code
// that reads a token file by its absolute path.
export const FAKE_GITHUB_TOKEN = 'clued-test-fake-token-not-a-credential';
export const TEST_GIT_IDENTITY = { name: 'Clued Test', email: 'clued-test@example.invalid' };
export function fakeIdentityEnv(dir, run) {
  const token = FAKE_GITHUB_TOKEN;
  return { GH_TOKEN: token, GITHUB_TOKEN: token, GH_ENTERPRISE_TOKEN: token, GITHUB_ENTERPRISE_TOKEN: token,
    GH_CONFIG_DIR: path.join(dir, 'gh'), GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    CLUED_TEST_IDENTITY_DIR: dir, CLUED_TEST_IDENTITY_RUN: run };
}
// One directory per run, under the run's temporary directory: the command line makes it before any child starts; a
// process below it (the suite slot worker, a selector a test starts) reuses the one it inherits, so a child killed on a
// timeout leaves nothing behind. Reused only when it is the one the env names and still as made (Codex review of 2ee162c2,
// medium 4): its name, a run file holding the run's random id, the git file exactly as written, gh's directory there and
// empty. Anything else (a stale value, another run's, one a suite changed) is not used and a new one is made. Every
// directory a process makes is removed when it exits; the clean-up is in place before the first is made.
const PREFIX = 'clued-test-identity-';
const GITCONFIG = `[user]\n\tname = ${TEST_GIT_IDENTITY.name}\n\temail = ${TEST_GIT_IDENTITY.email}\n`;
function untouched(dir, run) {
  try {
    return typeof dir === 'string' && typeof run === 'string' && run.length === 36 && path.basename(dir).startsWith(PREFIX)
      && readFileSync(path.join(dir, 'run'), 'utf8') === run && readFileSync(path.join(dir, 'gitconfig'), 'utf8') === GITCONFIG
      && statSync(path.join(dir, 'gh')).isDirectory() && readdirSync(path.join(dir, 'gh')).length === 0;
  } catch {
    return false;
  }
}
const made = new Set();
let current = null;
export function testIdentity(env = process.env) {
  if (untouched(env.CLUED_TEST_IDENTITY_DIR, env.CLUED_TEST_IDENTITY_RUN)) return { dir: env.CLUED_TEST_IDENTITY_DIR, run: env.CLUED_TEST_IDENTITY_RUN };
  if (current && untouched(current.dir, current.run)) return current;
  if (made.size === 0) process.once('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
  const dir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), PREFIX));
  made.add(dir);
  const run = randomUUID();
  mkdirSync(path.join(dir, 'gh'));
  writeFileSync(path.join(dir, 'gitconfig'), GITCONFIG);
  writeFileSync(path.join(dir, 'run'), run);
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
export const keptVariables = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => KEEP_VARIABLE.test(name)));
export function testEnv(env) {
  const { dir, run } = testIdentity(env);
  return { ...keptVariables(env), ...fakeIdentityEnv(dir, run), CLUED_UNDER_TEST: '1' };
}
