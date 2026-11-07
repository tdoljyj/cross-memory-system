// The companion's own start-up checks for M5 (DESIGN §65.4.2, §65.6; Owner decision on the companion's GitHub token):
//   1. it never runs with an elevated token (COMPANION_ELEVATED_TOKEN_REFUSED): the task might be set to "highest privileges";
//   2. its gh login is its own (COMPANION_GH_CONFIG_*): GH_CONFIG_DIR and HOME are the dedicated directories the supervisor sets,
//      the gh hosts file there holds a fine-grained token (insecure storage, so it never overwrites the Owner's keyring entry), and the
//      git configuration there points git's credential helper at that gh login. Anything else fails closed: the companion does not
//      start, sends no heartbeat, and the service only defers;
//   3. it records the facts of its own session for the Owner's read-only probe (windows/probe-companion-headless.ps1): the WSL
//      instance it sees (boot_id) and whether the distribution's docker.service is active. Best effort, never blocks the start.
// None of these reads or prints a secret: the hosts file is checked for its shape only (a fine-grained token's prefix), and the
// value never leaves this function.
import fs from 'node:fs/promises';
import path from 'node:path';
import { check } from './canonical.mjs';

export const WHOAMI_EXE = 'C:\\Windows\\System32\\whoami.exe';
export const whoamiGroupsArgv = () => [WHOAMI_EXE, '/groups', '/fo', 'csv', '/nh'];
// The token's integrity level from `whoami /groups /fo csv /nh` (SIDs are not translated): S-1-16-8192 medium (a filtered, unelevated
// token), S-1-16-12288 high (elevated), S-1-16-16384 system. -> true (elevated), false, or null (no label: unreadable).
export function tokenElevated(text) {
  const levels = [...String(text ?? '').matchAll(/"S-1-16-(\d{1,6})"/g)].map(m => Number(m[1]));
  if (levels.length !== 1) return null;
  return levels[0] >= 12288;
}
export async function assertNotElevated(run) {
  const r = await run(whoamiGroupsArgv(), { timeoutMs: 30_000 });
  check(r && r.code === 0, 'COMPANION_TOKEN_UNREADABLE');
  const elevated = tokenElevated(r.stdout);
  check(elevated !== null, 'COMPANION_TOKEN_UNREADABLE');
  check(elevated === false, 'COMPANION_ELEVATED_TOKEN_REFUSED');
}

// ---- The companion's own gh login ----
// <profile>\AppData\Local\CluedIndependentCI\companion-gh\{gh,home}: gh's configuration (GH_CONFIG_DIR) and git's home (HOME, so git
// reads home\.gitconfig as its global file). build-bundle.ps1 removes every GIT_* variable from git's environment, so HOME is the
// variable that carries the git configuration to it; gh reads GH_CONFIG_DIR.
export const companionGhRoot = profileDir => path.join(profileDir, 'AppData', 'Local', 'CluedIndependentCI', 'companion-gh');
export const companionGhConfigDir = profileDir => path.join(companionGhRoot(profileDir), 'gh');
export const companionHomeDir = profileDir => path.join(companionGhRoot(profileDir), 'home');
const forward = p => p.replace(/\\/g, '/');
// home\.gitconfig, exactly (windows/companion-gh-login.ps1 writes the same text): the Owner's own global file is included first, so
// every other setting stays what it is, then every credential helper is reset and the one helper is gh with this configuration.
export function companionGitConfig(profileDir, ghExe) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\[^"'\n\r;]+\\gh\.exe$/i.test(ghExe), 'COMPANION_GH_EXE_INVALID');
  const helper = `!'${forward(ghExe)}' auth git-credential`;
  return ['[include]', `\tpath = ${forward(path.join(profileDir, '.gitconfig'))}`,
    '[credential]', '\thelper =', `\thelper = ${helper}`,
    '[credential "https://github.com"]', '\thelper =', `\thelper = ${helper}`, ''].join('\n');
}
const sameDir = (a, b) => typeof a === 'string' && typeof b === 'string' && path.normalize(a).replace(/\\+$/, '').toLowerCase() === path.normalize(b).replace(/\\+$/, '').toLowerCase();
// gh's hosts.yml with insecure storage: a github.com entry with an oauth_token. A fine-grained personal access token starts with
// github_pat_; the Owner decided the companion uses one, limited to this repository.
export function hostsFileShape(text) {
  const t = String(text ?? '');
  if (!/^github\.com:\s*$/m.test(t)) return 'COMPANION_GH_HOST_MISSING';
  const m = /^\s+oauth_token:\s*(\S+)\s*$/m.exec(t);
  if (!m) return 'COMPANION_GH_TOKEN_NOT_STORED_IN_CONFIG';
  if (!/^github_pat_[A-Za-z0-9_]{20,255}$/.test(m[1])) return 'COMPANION_GH_TOKEN_NOT_FINE_GRAINED';
  return null;
}
async function regularFile(p, max, fsImpl) {
  const st = await fsImpl.lstat(p);
  check(st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= max, 'COMPANION_GH_CONFIG_UNREADABLE');
  return fsImpl.readFile(p, 'utf8');
}
// Throws a COMPANION_GH_* / COMPANION_GIT_* code unless the companion's gh login is its own; returns { ghConfigDir, homeDir }.
export async function assertGhIsolation({ env, profileDir, ghExe, fsImpl = fs }) {
  const ghConfigDir = companionGhConfigDir(profileDir), homeDir = companionHomeDir(profileDir);
  check(sameDir(env.GH_CONFIG_DIR, ghConfigDir), 'COMPANION_GH_CONFIG_DIR_REQUIRED');
  check(sameDir(env.HOME, homeDir), 'COMPANION_GH_HOME_REQUIRED');
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) check(!(k in env), 'COMPANION_GH_ENV_REFUSED');
  for (const dir of [companionGhRoot(profileDir), ghConfigDir, homeDir]) {
    let st;
    try { st = await fsImpl.lstat(dir); } catch { throw Object.assign(new Error('COMPANION_GH_CONFIG_UNREADABLE'), { code: 'COMPANION_GH_CONFIG_UNREADABLE' }); }
    check(st.isDirectory() && !st.isSymbolicLink(), 'COMPANION_GH_CONFIG_UNREADABLE');
  }
  let hosts, gitconfig;
  try { hosts = await regularFile(path.join(ghConfigDir, 'hosts.yml'), 65536, fsImpl); } catch { throw Object.assign(new Error('COMPANION_GH_CONFIG_UNREADABLE'), { code: 'COMPANION_GH_CONFIG_UNREADABLE' }); }
  const shape = hostsFileShape(hosts);
  hosts = null;
  check(shape === null, shape ?? 'COMPANION_GH_CONFIG_UNREADABLE');
  try { gitconfig = await regularFile(path.join(homeDir, '.gitconfig'), 4096, fsImpl); } catch { throw Object.assign(new Error('COMPANION_GIT_CONFIG_UNREADABLE'), { code: 'COMPANION_GIT_CONFIG_UNREADABLE' }); }
  check(gitconfig.replace(/\r\n/g, '\n') === companionGitConfig(profileDir, ghExe), 'COMPANION_GIT_CONFIG_MISMATCH');
  return { ghConfigDir, homeDir };
}

// ---- The session facts for the probe (Q1, Q2 of DESIGN §65.6) ----
export const SESSION_FACTS_CONTRACT = 'clued.independent-ci.companion-session/1';
export const SESSION_FACTS_FILE = 'companion-session.json';
export const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// wsl(...) is the companion's root argv builder (companion.mjs argv); run(argv, opts) -> { code, stdout }.
export async function sessionFacts({ wsl, run, clock = Date.now, pid = process.pid }) {
  const out = { contract: SESSION_FACTS_CONTRACT, at: new Date(clock()).toISOString(), pid, bootId: null, wslExitCode: null, docker: null };
  try {
    const b = await run(wsl('/usr/bin/cat', '/proc/sys/kernel/random/boot_id'), { timeoutMs: 120_000 });
    out.wslExitCode = Number.isSafeInteger(b?.code) ? b.code : null;
    const id = String(b?.stdout ?? '').trim();
    out.bootId = b?.code === 0 && BOOT_ID.test(id) ? id : null;
  } catch { /* stays null */ }
  try {
    const d = await run(wsl('/usr/bin/systemctl', 'is-active', 'docker.service'), { timeoutMs: 60_000 });
    const s = String(d?.stdout ?? '').trim();
    out.docker = /^[a-z-]{1,20}$/.test(s) ? s : null;
  } catch { /* stays null */ }
  return out;
}
export async function writeSessionFacts(dir, facts, fsImpl = fs) {
  await fsImpl.mkdir(dir, { recursive: true });
  const file = path.join(dir, SESSION_FACTS_FILE), tmp = `${file}.${process.pid}.tmp`;
  await fsImpl.writeFile(tmp, JSON.stringify(facts));
  await fsImpl.rename(tmp, file);
}
