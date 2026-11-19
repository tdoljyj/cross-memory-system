// The environment every suite child gets: the selector's (ci-required-selection.mjs) and local-verify's one source. Only
// node: imports, so local-verify --linux can carry it with its own copy.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
export function fakeIdentityEnv(dir) {
  const token = FAKE_GITHUB_TOKEN;
  return { GH_TOKEN: token, GITHUB_TOKEN: token, GH_ENTERPRISE_TOKEN: token, GITHUB_ENTERPRISE_TOKEN: token,
    GH_CONFIG_DIR: path.join(dir, 'gh'), GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    CLUED_TEST_IDENTITY_DIR: dir };
}
// One directory per run, under the run's temporary directory: the command line makes it before any child starts and removes
// it when it exits; a process below it (the suite slot worker, a selector a test starts) reuses the one it inherits, so a
// child killed on a timeout leaves nothing behind.
let identityDir = null;
export function testIdentityDir(env = process.env) {
  const inherited = env.CLUED_TEST_IDENTITY_DIR;
  if (inherited && existsSync(path.join(inherited, 'gitconfig'))) return inherited;
  if (identityDir && existsSync(identityDir)) return identityDir;
  const dir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'clued-test-identity-'));
  mkdirSync(path.join(dir, 'gh'));
  writeFileSync(path.join(dir, 'gitconfig'), `[user]\n\tname = ${TEST_GIT_IDENTITY.name}\n\temail = ${TEST_GIT_IDENTITY.email}\n`);
  if (!identityDir) process.once('exit', () => rmSync(identityDir, { recursive: true, force: true }));
  identityDir = dir;
  return dir;
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
export const testEnv = (env) => ({ ...keptVariables(env), ...fakeIdentityEnv(testIdentityDir(env)), CLUED_UNDER_TEST: '1' });
