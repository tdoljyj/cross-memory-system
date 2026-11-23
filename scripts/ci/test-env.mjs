// The environment every suite child gets: the selector's (ci-required-selection.mjs) and local-verify's one source. Only
// node: imports, so local-verify --linux can carry it with its own copy.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    // Windows PowerShell's module analysis cache location: the hosted windows image keeps a warmed cache there (runner-images
    // Configure-PowerShell.ps1); without it every 5.1 process spends about 20 s analysing the modules again. A path, not a
    // credential.
    'PSModuleAnalysisCachePath',
    // The job installed the application dependencies a selected suite declares (ci-required-selection APP_DEPS_MARKER): a
    // test that needs them fails rather than skips when this is set and they are missing. A marker, not a credential.
    'CLUED_CI_APP_DEPS',
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
export function fakeIdentityEnv(dir) {
  const { fakeToken, fakeTokenNames, git } = TEST_ENV_RULES;
  return { ...Object.fromEntries(fakeTokenNames.map((name) => [name, fakeToken])),
    GH_CONFIG_DIR: path.join(dir, 'gh'), GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: git.GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT: git.GIT_TERMINAL_PROMPT,
    CLUED_TEST_IDENTITY_DIR: dir };
}
// The identity directory (ruling 11-20 "补：止血 PR 第四轮" §1, §2): one per run, randomly named under the run's temporary
// directory; the command line makes it before any child starts and hands its place to the children in the environment
// (CLUED_TEST_IDENTITY_DIR), with no ownership check: it holds no credential. It is removed when the process that made it
// ends (normally, failing or interrupted); one a killed run left goes when a later run starts and finds it older than two
// days, by name and time only (a run is bounded at twenty-odd minutes; a CI job at hours). A clean-up failure is one
// printed line and never stops the run.
const PREFIX = 'clued-test-identity-';
const STALE_MS = 2 * 24 * 60 * 60 * 1000;
const GITCONFIG = `[user]\n\tname = ${TEST_GIT_IDENTITY.name}\n\temail = ${TEST_GIT_IDENTITY.email}\n`;
let own = null;
function removeStale(base) {
  const failed = [];
  for (const name of readdirSync(base).filter((entry) => entry.startsWith(PREFIX))) {
    try {
      if (Date.now() - statSync(path.join(base, name)).mtimeMs > STALE_MS) rmSync(path.join(base, name), { recursive: true, force: true });
    } catch {
      failed.push(name);
    }
  }
  if (failed.length) console.error(`test identity: could not remove ${failed.length} old director${failed.length === 1 ? 'y' : 'ies'} under ${base}`);
}
function removeOwn() {
  try {
    rmSync(own, { recursive: true, force: true });
  } catch (error) {
    console.error(`test identity: could not remove ${own}: ${error.message}`);
  }
}
// This process's own directory, made once (it throws when it cannot be made: the run does not start).
export function ownIdentityDir(env = process.env) {
  if (own) return own;
  const base = path.resolve(env.RUNNER_TEMP || os.tmpdir());
  try {
    removeStale(base);
  } catch (error) {
    console.error(`test identity: could not look for old directories under ${base}: ${error.message}`);
  }
  const dir = realpathSync.native(mkdtempSync(path.join(base, PREFIX)));
  own = dir;
  process.once('exit', removeOwn);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGBREAK', 149]]) {
    process.once(signal, () => process.exit(code));
  }
  mkdirSync(path.join(dir, 'gh'));
  writeFileSync(path.join(dir, 'gitconfig'), GITCONFIG);
  return dir;
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
// A child's environment: the run's identity directory from the environment, or this process's own when it has none.
export function testEnv(env) {
  const dir = env.CLUED_TEST_IDENTITY_DIR || ownIdentityDir(env);
  return { ...keptVariables(env), ...fakeIdentityEnv(dir), ...TEST_ENV_RULES.marker };
}
// local-verify's environment: a directory of its own, its additions for the platform, and the run values it may set (any
// other name is refused).
export function localVerifyEnv(env, values = {}, platform = process.platform) {
  const { localVerify } = TEST_ENV_RULES;
  const unknown = Object.keys(values).filter((name) => !localVerify.values.includes(name));
  if (unknown.length) throw new Error(`${unknown.join(', ')}: not a value local-verify sets (TEST_ENV_RULES.localVerify.values)`);
  return { ...testEnv({ ...env, CLUED_TEST_IDENTITY_DIR: ownIdentityDir(env) }), ...(platform === 'win32' ? localVerify.win32 : {}), ...values };
}
