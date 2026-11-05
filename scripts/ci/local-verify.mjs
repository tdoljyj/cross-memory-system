// Local verification before a push (defect 66b7bf56, Owner Decision ecef33d5).
//
// Runs the suites the required checks (clued-required-tests.yml) would run for
// this change, the way they run them, on Windows and in CluedDev-Linux, and
// reports only the failures the change brings: a suite that fails is run again
// on main, and each failing command is compared with the same command there.
//
//   node scripts/ci/local-verify.mjs [--base <commit>] [--committed] [--suite <id>]...
//                                    [--linux | --linux-only] [--no-fetch] [--fresh-base]
//
//   --base        the main commit to verify against; default: GitHub's main,
//                 fetched first (--no-fetch uses the last fetched copy).
//   --committed   verify HEAD only; by default the working tree's changes and
//                 new files that are not ignored are included (listed first;
//                 they are also copied into the Linux clone).
//   --suite       run only these suites (default: what the selection picks).
//   --linux       also run in CluedDev-Linux (set up by
//                 setup-clued-dev-linux.ps1), at the same time as the Windows
//                 run; --linux-only runs only there.
//   --fresh-base  run main's suites again instead of reusing their results.
//   (--candidate, with --suite, is internal: the Windows run hands the Linux
//   run its commit and suites.)
//
// What runs is what CI runs for the pull request: the change merged into main
// (CI tests refs/pull/N/merge), with the selection, known-failure list and
// reporter of main's scripts/ci/ci-required-selection.mjs, CI_BASE_SHA set to
// main, and the suites picked from the files the change itself touches. Each
// suite runs in a clean worktree; unlike CI, every command of a failing suite
// still runs, so each one can be compared. The application's dependencies come
// from its lockfile (npm ci --ignore-scripts, plus the embedded PostgreSQL
// rebuild migration-verify does), installed once per lockfile and reused. The
// commands get a plain environment (PATH, home, temp and locale variables,
// proxies), not the caller's tokens; CI and GITHUB_ACTIONS are not set. Like
// CI's full checkout, the Linux clone has GitHub's branches (as origin/*), its
// tags and an origin remote: some tests read commits only a branch other than
// main still holds. On Windows the worktrees see this repository's own refs.
// One run at a time per cache (a lock, taken after the change is snapshotted,
// so a queued run verifies what was there when it started). Logs, worktrees,
// results of main and the dependency cache (about 10 GB) live under
// <data drive>:\clued-dev\cache\clued-local-verify on Windows: the first drive
// after the system drive that exists, or CLUED_DEV_ROOT (the same root
// setup-clued-dev-linux.ps1 installs CluedDev-Linux under) or, for this
// directory alone, CLUED_LOCAL_VERIFY_HOME; ~/.cache/clued-local-verify where
// there is no other drive. Never on the system drive when another exists: the CI
// host's watchdog pauses the runners when it runs short (defect 2102f7e1). The
// location is always a real path, links resolved. A run warns when the system
// drive is below the watchdog's resume level.
//
// A command that runs Node's test runner and ran no test is a failure, never a
// pass (an entry point that exits 0 without running anything looks the same as
// a green run).
//
// Exit 0: no new failure. Exit 1: a new failure, or one it could not compare
// with main. Exit 2: the run itself could not be set up.
import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY = 'tdoljyj/cross-memory-system';
export const DISTRIBUTION = 'CluedDev-Linux';
export const CHECKS = ['ci-suites', 'clued-cloud-tests', 'migration-verify'];
// The Node version clued-required-tests.yml sets up.
export const CI_NODE = '24.19.0';
const CACHE_VERSION = 4;
// The C: free space (GB) at which the CI host's watchdog (the one installed as
// C:clued-ciwatchdog-clued-ci.ps1) stops the Linux runners, and at which it
// starts them again. CLUED_CI_RESUME_FREE_GB overrides the second (0: no check).
export const CI_HOST_SUSPEND_FREE_GB = 50;
export const CI_HOST_RESUME_FREE_GB = 65;
const SELECTOR = 'scripts/ci/ci-required-selection.mjs';
const SELECTOR_FILES = [SELECTOR, 'scripts/ci/ci-known-failures.json', 'scripts/ci/ci-test-failures-reporter.mjs'];
const APP = 'apps/clued-cloud';
const NEEDS_APP_DEPENDENCIES = new Set(['clued-cloud', 'production-schema']);
// GitHub's branches and tags, fetched under these prefixes (the repository's
// own branches and tags stay as they are).
const GITHUB_BRANCHES = 'refs/local-verify/github/';
const GITHUB_TAGS = 'refs/local-verify/tags/';
const MAIN_REF = `${GITHUB_BRANCHES}main`;
const LINUX_HOME = '.cache/clued-local-verify';
// Where a Linux run takes a bundle's refs in, for as long as it reads them.
const INCOMING = 'refs/local-verify/incoming/';
const RESULT_MARK = 'LOCAL_VERIFY_RESULT ';
const KEEP_WORKTREES = 8;
const KEEP_DEPENDENCY_STORES = 3;
const COMMAND_TIMEOUT_MS = 45 * 60_000; // the workflow's longest job limit
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LINUX_TIMEOUT_MS = 180 * 60_000;
// A lock older than any run is stale even if its process number is in use again.
const LOCK_MAX_AGE_MS = 6 * 60 * 60_000;
// An unreadable lock is stale only once it is clearly not being written.
const UNREADABLE_LOCK_MS = 30_000;
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const IDENTITY = { GIT_AUTHOR_NAME: 'local-verify', GIT_AUTHOR_EMAIL: 'local-verify@localhost',
  GIT_COMMITTER_NAME: 'local-verify', GIT_COMMITTER_EMAIL: 'local-verify@localhost' };

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const nul = (text) => text.split('\0').filter(Boolean);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function git(args, { cwd, env = process.env, allowFail = false, raw = false, timeout, input } = {}) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout, input });
  if (result.error && !allowFail) throw result.error;
  if (allowFail) return result;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return raw ? result.stdout : result.stdout.trim();
}

export function parseArgs(argv) {
  const options = { base: null, candidate: null, committed: false, suites: [], here: true, linux: false, fetch: true, freshBase: false };
  const valued = { '--base': 'base', '--candidate': 'candidate', '--suite': 'suites' };
  for (let i = 0; i < argv.length; i += 1) {
    const [arg, inline] = argv[i].startsWith('--') && argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    if (valued[arg]) {
      let value = inline;
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
        i += 1;
      }
      if (value === '') throw new Error(`${arg} needs a value`);
      if (arg === '--suite') options.suites.push(value);
      else options[valued[arg]] = value;
    } else if (inline !== undefined) throw new Error(`${arg} takes no value`);
    else if (arg === '--committed') options.committed = true;
    else if (arg === '--linux') options.linux = true;
    else if (arg === '--linux-only') Object.assign(options, { linux: true, here: false });
    else if (arg === '--no-fetch') options.fetch = false;
    else if (arg === '--fresh-base') options.freshBase = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

// The path with every link (junction, symlink) in it resolved, also when its
// last parts do not exist yet (those are kept as they are).
export function realpathLoose(target) {
  const wanted = path.resolve(target);
  const tail = [];
  for (let current = wanted; ;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return wanted;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// Where the developer tools keep their large files on Windows: CLUED_DEV_ROOT,
// else clued-dev on the first drive after the system drive that exists; null
// elsewhere and where there is no other drive.
export function dataRoot(env = process.env, { platform = process.platform, exists = fs.existsSync, systemDrive = env.SystemDrive || 'C:' } = {}) {
  if (env.CLUED_DEV_ROOT) return path.resolve(env.CLUED_DEV_ROOT);
  if (platform !== 'win32') return null;
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:`;
    if (drive.toLowerCase() !== systemDrive.toLowerCase() && exists(`${drive}\\`)) return path.win32.join(`${drive}\\`, 'clued-dev');
  }
  return null;
}

// Not %LOCALAPPDATA%: a packaged Windows app's processes see AppData redirected
// into the package, so a link made there points elsewhere for the cmd.exe that
// npm starts (tsc "not found"). On the data drive when there is one (see the
// top of this file), else under the home directory. A real path: Node resolves
// links in a script's own path, so a path through a link would not match it.
export function cacheHome(env = process.env, home = os.homedir(), options = {}) {
  if (env.CLUED_LOCAL_VERIFY_HOME) return realpathLoose(env.CLUED_LOCAL_VERIFY_HOME);
  const root = dataRoot(env, options);
  return realpathLoose(root ? path.join(root, 'cache', 'clued-local-verify') : path.join(home, '.cache', 'clued-local-verify'));
}

export function freeGb(dir, statfs = fs.statfsSync) {
  const stats = statfs(dir);
  return (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
}

// What a run should tell the user about the system drive (Windows): its free
// space below the watchdog's resume level, or the cache on it. Null when there
// is nothing to say.
export function systemDriveNotes(home, { env = process.env, platform = process.platform, free = freeGb } = {}) {
  if (platform !== 'win32') return [];
  const drive = `${env.SystemDrive || 'C:'}\\`;
  const notes = [];
  const resume = env.CLUED_CI_RESUME_FREE_GB === undefined ? CI_HOST_RESUME_FREE_GB : Number(env.CLUED_CI_RESUME_FREE_GB);
  try {
    const gb = free(drive);
    if (Number.isFinite(resume) && resume > 0 && gb < resume) {
      notes.push(`${drive} has ${gb.toFixed(1)} GB free, below ${resume} GB: the CI host's watchdog stops the self-hosted runners below ${CI_HOST_SUSPEND_FREE_GB} GB and starts them again at ${resume} GB; free space there first`);
    }
  } catch { /* the drive cannot be asked: nothing to say */ }
  if (path.win32.parse(home).root.toLowerCase() === drive.toLowerCase()) {
    notes.push(`the cache ${home} is on ${drive} and grows to about 10 GB; set CLUED_DEV_ROOT (or CLUED_LOCAL_VERIFY_HOME) to a directory on another drive`);
  }
  return notes;
}

// C:\a\b (or C:/a/b) as the distribution sees it: /mnt/c/a/b.
export function toWslPath(file) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(file);
  if (!match) throw new Error(`not a drive path: ${file}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`.replace(/\/+$/, '');
}

// A file in the distribution as Windows opens it.
export function windowsPathOf(file) {
  return file.startsWith('/') ? `\\\\wsl.localhost\\${DISTRIBUTION}${file.replace(/\//g, '\\')}` : file;
}

// On Windows `npm` is npm.cmd, which Node does not start without a shell
// (the ENOENT the selection's runSuite reports there); npm's own CLI next to
// node.exe starts directly.
export function npmCommand({ platform = process.platform, execPath = process.execPath, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return ['npm'];
  const cli = path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!exists(cli)) throw new Error(`npm's CLI is not next to ${execPath}`);
  return [execPath, cli];
}

// The failure report of a Node test command. A command with known failures
// gets the reporter as runSuite adds it (after --test, wherever it is); a plain
// `node --test` command gets the same reporter, so it too can be compared test
// by test. Other commands have no report.
export function withFailureReport(program, args, { known = false, reporterUrl, file }) {
  if (program !== 'node') return { args, report: null };
  const index = args.indexOf('--test');
  if (index < 0 || (!known && index !== 0) || args.some((arg) => arg.startsWith('--test-reporter'))) return { args, report: null };
  return {
    args: [...args.slice(0, index + 1), '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${reporterUrl}`, `--test-reporter-destination=${file}`, ...args.slice(index + 1)],
    report: file,
  };
}

// What decides the application's installed dependencies: the lockfile, the
// dependency fields of package.json (npm ci refuses a lockfile out of step with
// them), .npmrc, the Node major version and the platform.
export function dependencyKey({ lock, packageJson, npmrc = '', nodeVersion = process.version, platform = process.platform }) {
  const manifest = JSON.parse(packageJson);
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'engines']
    .map((field) => [field, manifest[field] ?? null]);
  return sha256(JSON.stringify({ lock: sha256(lock), fields, npmrc: String(npmrc), node: nodeVersion.split('.')[0], platform })).slice(0, 16);
}

// The variables the suites' commands get: what a program needs to run, find
// its tools, temp and home directories, and the network, not the caller's
// tokens or Clued settings (CI's jobs have none of them either).
const KEEP_VARIABLE = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|USERNAME|USER|LOGNAME|SHELL|TERM|LANG|LANGUAGE|LC_[A-Z]+|TZ|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
// On Windows Python's own UTF-8 mode stands in for the runners' UTF-8 locale.
export function testEnvironment(env, extra = {}, platform = process.platform) {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => KEEP_VARIABLE.test(name))),
    ...(platform === 'win32' ? { PYTHONUTF8: '1' } : {}), ...extra };
}

// One run at a time per cache: worktrees, results of main and the dependency
// store are shared. The lock appears with its content at once (written aside,
// then hard-linked into place). A lock whose process is gone, older than any
// run, or unreadable for longer than a write takes, is taken over: renamed
// away first (only one waiter can), then checked to be the one seen stale, so
// two waiters never both hold it. It is removed on exit only while it is
// still this run's; refresh() renews its age between suites.
export function acquireLock(home, { pid = process.pid, now = Date.now, wait = sleep, alive = processAlive, log = console.log } = {}) {
  const file = path.join(home, 'run.lock');
  const token = `${pid}-${now()}-${Math.random().toString(16).slice(2)}`;
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(name, 'utf8'));
    } catch {
      return null;
    }
  };
  const aside = () => {
    const temporary = `${file}.${token}.new`;
    fs.writeFileSync(temporary, JSON.stringify({ pid, token, started: now() }));
    return temporary;
  };
  let announced = false;
  for (;;) {
    const temporary = aside();
    try {
      fs.linkSync(temporary, file);
      fs.rmSync(temporary, { force: true });
      const release = () => {
        if (read(file)?.token === token) fs.rmSync(file, { force: true });
      };
      // Read, then replace: not one step, but only this run writes its own lock
      // while it lives, and a failure only loses one renewal.
      release.refresh = () => {
        if (read(file)?.token !== token) return;
        let renewed = null;
        try {
          renewed = aside();
          renameRetrying(renewed, file);
        } catch (error) {
          if (renewed) fs.rmSync(renewed, { force: true });
          log(`local-verify: could not renew the run lock: ${error.message}`);
        }
      };
      process.once('exit', release);
      // what a run that stopped between writing and placing its lock, or
      // between taking over a stale lock and removing it, left
      for (const name of fs.readdirSync(home)) {
        const leftover = path.join(home, name);
        if (/^run\.lock\..+$/.test(name) && !name.includes(token)) {
          try {
            if (now() - fs.statSync(leftover).mtimeMs > UNREADABLE_LOCK_MS) fs.rmSync(leftover, { force: true });
          } catch { /* gone */ }
        }
      }
      return release;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (error.code !== 'EEXIST') throw error;
    }
    const held = read(file);
    let stale;
    if (held) {
      stale = !alive(held.pid) || now() - held.started > LOCK_MAX_AGE_MS;
    } else {
      try {
        stale = now() - fs.statSync(file).mtimeMs > UNREADABLE_LOCK_MS;
      } catch {
        continue; // gone meanwhile
      }
    }
    if (!stale) {
      if (!announced) log(`local-verify: another run (process ${held?.pid ?? 'unknown'}) is using ${home}; waiting for it`);
      announced = true;
      wait(5000);
      continue;
    }
    const moved = `${file}.${token}`;
    try {
      fs.renameSync(file, moved);
    } catch {
      continue; // another waiter took it first
    }
    const taken = read(moved);
    if (taken?.token !== held?.token) {
      // a fresh lock replaced the stale one meanwhile: give it back
      try {
        fs.linkSync(moved, file);
      } catch {
        log(`local-verify: the lock of process ${taken?.pid ?? 'unknown'} was replaced while being handed back`);
      }
    }
    fs.rmSync(moved, { force: true });
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// main: --base, else GitHub's main. GitHub's branches and tags are fetched
// either way (the Linux clone gets them); without a login or network the last
// fetched copy is used, else origin's main.
function resolveMain(root, options) {
  if (options.fetch) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    let fetched = false;
    for (let attempt = 1; attempt <= 3 && !fetched; attempt += 1) {
      fetched = git(['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'fetch', '--quiet', '--no-tags',
        '--prune', `https://github.com/${REPOSITORY}.git`, `+refs/heads/*:${GITHUB_BRANCHES}*`, `+refs/tags/*:${GITHUB_TAGS}*`],
        { cwd: root, env, allowFail: true, timeout: 10 * 60_000 }).status === 0;
      if (!fetched && attempt < 3) sleep(5000 * attempt);
    }
    if (!fetched) console.log(`local-verify: could not fetch GitHub's branches (network, or git has no login for https://github.com/${REPOSITORY}); using the last fetched copy`);
  }
  if (options.base) return git(['rev-parse', '--verify', `${options.base}^{commit}`], { cwd: root });
  return newestMain(root, [MAIN_REF, 'refs/remotes/origin/main']);
}

// The newest of the copies of main this repository has: the one the others
// lead to (refs that disagree keep the first).
export function newestMain(root, refs) {
  const found = refs.map((ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, allowFail: true }))
    .filter((result) => result.status === 0).map((result) => result.stdout.trim());
  if (!found.length) throw new Error('no copy of main here; fetch it, or pass --base <commit>');
  return found.reduce((newest, other) => (
    git(['merge-base', '--is-ancestor', newest, other], { cwd: root, allowFail: true }).status === 0 ? other : newest));
}

// The commit to verify: HEAD, or HEAD with the working tree's changes and its
// new files that are not ignored, written through a copy of the index (the
// working tree, the index and the branch stay as they are).
export function snapshot(root, committed) {
  const head = git(['rev-parse', 'HEAD'], { cwd: root });
  if (committed) return { commit: head, included: [] };
  const included = [...new Set([...nul(git(['diff', '--name-only', '--no-renames', '-z', 'HEAD'], { cwd: root, raw: true })),
    ...nul(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, raw: true }))])].sort();
  if (included.length === 0) return { commit: head, included };
  const index = path.join(os.tmpdir(), `clued-local-verify-index-${process.pid}`);
  const env = { ...process.env, ...IDENTITY, GIT_INDEX_FILE: index };
  try {
    const real = path.resolve(root, git(['rev-parse', '--git-path', 'index'], { cwd: root }));
    if (fs.existsSync(real)) fs.copyFileSync(real, index);
    else git(['read-tree', 'HEAD'], { cwd: root, env });
    git(['add', '--all', '--', '.'], { cwd: root, env });
    const tree = git(['write-tree'], { cwd: root, env });
    return { commit: git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', head, '-m', 'local-verify snapshot'], { cwd: root, env }), included };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

// The change merged into main, as CI tests it (refs/pull/N/merge); the change
// itself when it already contains main.
export function mergedCandidate(root, change, main) {
  if (git(['merge-base', '--is-ancestor', main, change], { cwd: root, allowFail: true }).status === 0) return change;
  const merged = git(['merge-tree', '--write-tree', main, change], { cwd: root, allowFail: true });
  if (merged.status === 1) throw new Error(`the change does not merge cleanly into main ${main.slice(0, 12)} (CI could not test it either); merge main first`);
  if (merged.status !== 0) throw new Error(`git merge-tree failed (it needs git 2.38 or later): ${String(merged.stderr || merged.error?.message).trim()}`);
  const tree = merged.stdout.split('\n')[0].trim();
  return git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', main, '-p', change, '-m', 'local-verify merge'],
    { cwd: root, env: { ...process.env, ...IDENTITY } });
}

// The files the change touches, as the pull request lists them (three-dot: from
// where it left main; a rename under both names); null at GitHub's listing
// limit, where CI selects everything.
export function changedFiles(root, change, main, limit) {
  const from = git(['merge-base', main, change], { cwd: root });
  const files = nul(git(['diff', '--name-only', '--no-renames', '-z', from, change], { cwd: root, raw: true }));
  return files.length >= limit ? null : files;
}

// main's selection, known-failure list and reporter, as the workflow uses them.
async function loadSelector(root, main, home) {
  const dir = path.join(home, 'selectors', main);
  if (!fs.existsSync(path.join(dir, 'complete'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const file of SELECTOR_FILES) {
      const result = spawnSync('git', ['show', `${main}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (result.status !== 0) throw new Error(`main ${main.slice(0, 12)} has no ${file}`);
      fs.writeFileSync(path.join(dir, path.basename(file)), result.stdout);
    }
    fs.writeFileSync(path.join(dir, 'complete'), '');
  }
  const selector = await import(pathToFileURL(path.join(dir, path.basename(SELECTOR))).href);
  return { ...selector, reporterUrl: pathToFileURL(path.join(dir, 'ci-test-failures-reporter.mjs')).href };
}

function removeLink(link) {
  if (!fs.lstatSync(link).isSymbolicLink()) {
    // installed in place by something that ran in this worktree: not ours to keep
    fs.rmSync(link, { recursive: true, force: true });
    return;
  }
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link); // a Windows junction; its target stays
  }
}

// The worktree's dependency link points at target, replacing a stale or broken
// link, or a directory something installed in the worktree itself.
export function linkDependencies(link, target, platform = process.platform) {
  let present = true;
  try {
    fs.lstatSync(link);
  } catch {
    present = false;
  }
  if (present) {
    let current = null;
    try {
      current = fs.realpathSync(link);
    } catch { /* dangling */ }
    if (current !== null && current === fs.realpathSync(target)) return;
    removeLink(link);
  }
  fs.symlinkSync(target, link, platform === 'win32' ? 'junction' : 'dir');
}

// A worktree of commit with nothing but its files (and the dependency link):
// reused for the same commit, made again when it is broken.
function cleanWorktree(dir) {
  git(['clean', '-ffdqx', '-e', `/${APP}/node_modules`], { cwd: dir });
}
const commonDir = (dir) => {
  const found = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, allowFail: true });
  if (found.status !== 0) return null;
  try {
    return fs.realpathSync(found.stdout.trim());
  } catch {
    return null;
  }
};
// Named per repository too: the cache is per user, and a worktree of another
// clone would not see this clone's commits.
export function worktreePath(root, commit, home) {
  return path.join(home, 'worktrees', `${commit.slice(0, 16)}-${sha256(commonDir(root) ?? root).slice(0, 8)}`);
}
export function worktree(root, commit, home) {
  const dir = worktreePath(root, commit, home);
  const own = fs.existsSync(path.join(dir, '.git')) ? commonDir(dir) : null;
  const valid = own !== null && own === commonDir(root);
  if (valid) {
    git(['checkout', '--quiet', '--detach', '--force', commit], { cwd: dir });
  } else {
    const link = path.join(dir, APP, 'node_modules');
    try {
      removeLink(link);
    } catch { /* none */ }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // --force also takes over this path when git still lists it but it is gone
    git(['worktree', 'add', '--quiet', '--detach', '--force', dir, commit], { cwd: root });
  }
  cleanWorktree(dir);
  fs.utimesSync(dir, new Date(), new Date());
  return dir;
}

// Keeps the newest worktrees and the ones in use; only this cache's own.
function pruneWorktrees(root, home, inUse) {
  const dir = path.join(home, 'worktrees');
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir).map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const old of entries.slice(KEEP_WORKTREES).filter((entry) => !inUse.includes(entry))) {
    try {
      removeLink(path.join(old, APP, 'node_modules'));
    } catch { /* none */ }
    git(['worktree', 'remove', '--force', old], { cwd: root, allowFail: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
}

function renameRetrying(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
      sleep(2000 * attempt);
    }
  }
}

function npmSync(args, cwd, label, log) {
  const [npm, ...prefix] = npmCommand();
  // The network may drop connections (Owner: assume a flaky network); each
  // attempt reuses what the npm cache already holds.
  let status = 1;
  for (let attempt = 1; attempt <= 5 && status !== 0; attempt += 1) {
    log(`local-verify: ${label} (attempt ${attempt})`);
    status = spawnSync(npm, [...prefix, ...args], { cwd, stdio: 'inherit', windowsHide: true, timeout: INSTALL_TIMEOUT_MS }).status;
    if (status !== 0 && attempt < 5) sleep(10_000 * attempt);
  }
  if (status !== 0) throw new Error(`${label} failed`);
}

// The application's node_modules for this lockfile, installed once (npm ci
// --ignore-scripts, as the workflow does; the embedded PostgreSQL package is
// rebuilt as migration-verify does) and linked into the worktree.
function ensureAppDependencies(dir, home, { rebuild, log = console.log }) {
  const app = path.join(dir, APP);
  const read = (file) => (fs.existsSync(path.join(app, file)) ? fs.readFileSync(path.join(app, file)) : null);
  if (!read('package.json') || !read('package-lock.json')) throw new Error(`${APP} has no package.json or package-lock.json`);
  const key = dependencyKey({ lock: read('package-lock.json'), packageJson: read('package.json'), npmrc: read('.npmrc') ?? '' });
  const store = path.join(home, 'node_modules');
  const ready = path.join(store, key);
  fs.mkdirSync(store, { recursive: true });
  for (const name of fs.readdirSync(store)) {
    // what a run that stopped mid-install or mid-delete left (one run at a time holds the lock)
    if (/^[0-9a-f]{16}-.{6}$/.test(name) || name.endsWith('.deleting')) fs.rmSync(path.join(store, name), { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(ready, 'complete'))) {
    const temporary = fs.mkdtempSync(path.join(store, `${key}-`));
    for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
      if (fs.existsSync(path.join(app, file))) fs.copyFileSync(path.join(app, file), path.join(temporary, file));
    }
    try {
      npmSync(['ci', '--ignore-scripts', '--cache', path.join(home, 'npm-cache'), '--prefer-offline', '--fetch-retries=5',
        '--fetch-timeout=60000', '--no-audit', '--no-fund'], temporary, `installing ${APP} dependencies (${key})`, log);
      fs.writeFileSync(path.join(temporary, 'complete'), '');
      renameRetrying(temporary, ready);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  const platformPackage = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  if (rebuild && !fs.existsSync(path.join(ready, 'rebuilt')) && fs.existsSync(path.join(ready, 'node_modules', platformPackage))) {
    npmSync(['rebuild', platformPackage], ready, `rebuilding ${platformPackage}`, log);
    fs.writeFileSync(path.join(ready, 'rebuilt'), '');
  }
  fs.utimesSync(ready, new Date(), new Date());
  const stores = fs.readdirSync(store).filter((name) => /^[0-9a-f]{16}$/.test(name)).map((name) => path.join(store, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const old of stores.slice(KEEP_DEPENDENCY_STORES)) {
    // renamed first, so a half-deleted store never looks complete
    renameRetrying(old, `${old}.deleting`);
    fs.rmSync(`${old}.deleting`, { recursive: true, force: true });
  }
  linkDependencies(path.join(app, 'node_modules'), path.join(ready, 'node_modules'));
  return key;
}

// The dependency key of the application at a commit, read without a worktree.
function dependencyKeyAt(root, commit) {
  const show = (file) => {
    const result = spawnSync('git', ['show', `${commit}:${APP}/${file}`], { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return result.status === 0 ? result.stdout : null;
  };
  const packageJson = show('package.json');
  const lock = show('package-lock.json');
  return packageJson && lock ? dependencyKey({ lock, packageJson, npmrc: show('.npmrc') ?? '' }) : null;
}

const unitTestFilesWith = (cwd) => () => {
  const listed = spawnSync(process.execPath, ['scripts/select-tests.mjs', 'unit', '--list'], { cwd, encoding: 'utf8', windowsHide: true });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') throw new Error('select-tests --list failed');
  return listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
};

// Every command of one suite, as runSuite would start it (main's command
// lines and known-failure reporter), with all output in logFile. Unlike
// runSuite it goes on after a failure, so each command can be compared with
// main. Each result: the exit status (128 for a signal, null when it could not
// start), the command's test report (read as runSuite reads it, files relative
// to root) and its known-failure key.
export function runCommands(selector, id, root, main, logFile, { spawn = spawnSync, env = process.env, kill = killUnder } = {}) {
  const fd = fs.openSync(logFile, 'w');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `clued-local-verify-${id}-`));
  const log = (line) => fs.writeSync(fd, `${line}\n`);
  const results = [];
  try {
    for (const [index, command] of selector.SUITE_COMMANDS[id].entries()) {
      const cwd = path.join(root, command.cwd);
      const known = command.known ?? null;
      try {
        const [program, ...args] = selector.expandArgv(command.argv, { cwd, base: main, report: path.join(temporary, `${id}-report.json`),
          listUnit: unitTestFilesWith(cwd) });
        const reported = withFailureReport(program, args, { known: Boolean(known), reporterUrl: selector.reporterUrl,
          file: path.join(temporary, `command-${index}.jsonl`) });
        const [file, ...prefix] = program === 'npm' ? npmCommand() : program === 'node' ? [process.execPath] : [program];
        log(`::group::${id}: (${command.cwd}) ${[program, ...reported.args].join(' ')}`);
        const result = spawn(file, [...prefix, ...reported.args], { cwd, env, stdio: ['ignore', fd, fd], windowsHide: true, timeout: COMMAND_TIMEOUT_MS });
        log('::endgroup::');
        const status = result.error ? null : result.signal ? 128 : result.status;
        // as runSuite: a known-failure command without its report has an empty one
        // (no summary: the run did not finish)
        const text = !reported.report ? null
          : fs.existsSync(reported.report) ? fs.readFileSync(reported.report, 'utf8') : known ? '' : null;
        const error = result.error?.message ?? (result.signal ? `stopped by ${result.signal}` : null);
        if (error) {
          log(`local-verify: ${id}: command ${index + 1}: ${error}`);
          // a timeout ends only the command itself; what it started could hold files
          kill(root, { log });
        }
        const parsed = text === null ? null : selector.readReport(text, root);
        // a command that got the reporter is one that runs tests: the report says how many ran
        results.push({ status, report: parsed, known, error, tests: reported.report ? testsRun(parsed ?? selector.readReport('', root)) : null });
      } catch (error) {
        log(`local-verify: ${id}: command ${index + 1}: ${error.message}`);
        results.push({ status: null, report: null, known, error: error.message });
      }
    }
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return results;
}

// How many tests a Node test report shows as run (passed or failed; skipped
// and todo ones do not count): the run's own summary, else the events.
export function testsRun(report) {
  const counts = report?.summary?.counts;
  if (counts && Number.isFinite(counts.passed) && Number.isFinite(counts.failed)) return counts.passed + counts.failed;
  return (report?.events ?? []).filter((event) => event.type === 'pass' || event.type === 'fail').length;
}

// How to end the processes still running from dir (their command line names
// it, with either slash, any case on Windows): what a timed-out command
// started and the timeout did not end.
export function killCommand(dir, platform = process.platform) {
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      '$d = $env:LOCAL_VERIFY_DIR; $e = $d.Replace([char]92, [char]47)',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and',
      '($_.CommandLine.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf($e, [StringComparison]::OrdinalIgnoreCase) -ge 0) } |',
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }'].join(' ')],
    { LOCAL_VERIFY_DIR: dir }];
  }
  return ['pkill', ['-e', '-f', '--', dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], {}];
}
export function killUnder(dir, { log = () => {}, platform = process.platform } = {}) {
  const [file, args, env] = killCommand(dir, platform);
  const found = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 60_000 });
  const ended = String(found.stdout ?? '').trim();
  if (ended) log(`local-verify: ended processes left under ${dir}: ${ended.split(/\s+/).join(', ')}`);
}

// A run-level failure (file null) never matches another run's.
const failEntries = (report) => report.events.filter((event) => event.type === 'fail' && event.file !== null && event.file !== undefined)
  .map((event) => ({ file: event.file, path: event.path, fingerprint: event.fingerprint, reason: 'fails on main too' }));
const label = (entry) => `${entry.file} :: ${entry.path.join(' > ')}`;

// One command's result against the same command on main: pass, new, base
// (failing there the same way) or unknown. A failure that main has too counts
// as already there only when both sides have test-by-test reports to match.
export function compareCommand(head, base, { selector, known = [] }) {
  if (head.status === null) return { verdict: 'unknown', detail: `did not run: ${head.error}` };
  // as in CI: a command with known failures passes on its report, any other on its exit status
  const passed = (result) => (result.known && result.report
    ? selector.knownFailureVerdict({ status: result.status, report: result.report, known }).ok
    : result.status === 0);
  // exit 0 but not one test run (no report, or one without a test): a script that ended without running them, say so
  // (defects 2102f7e1, d7e9d4b4) instead of "did not finish" or a pass
  if (head.tests === 0 && head.status === 0) return { verdict: 'new', detail: 'ran no tests (a command that runs no test is not a pass)' };
  if (passed(head)) return { verdict: 'pass' };
  const failing = () => {
    const names = head.report ? failEntries(head.report).map(label) : [];
    return names.length ? `: ${names.join('; ')}` : '';
  };
  if (!base || base.status === null) return { verdict: 'unknown', detail: `did not run on main${base?.error ? `: ${base.error}` : ''}` };
  if (passed(base)) return { verdict: 'new', detail: `passes on main${failing()}` };
  if (!head.report || !base.report) return { verdict: 'unknown', detail: 'fails on main too, without test-by-test results to compare; read both logs' };
  const verdict = selector.knownFailureVerdict({ status: head.status, report: head.report, known: [...known, ...failEntries(base.report)] });
  if (verdict.ok) return { verdict: 'base', detail: `${verdict.expected.length} failing test(s), all failing on main too` };
  return { verdict: 'new', detail: [...verdict.problems, ...verdict.unexpected.map(label)].join('; ') };
}

const SEVERITY = ['pass', 'base', 'unknown', 'new'];

// A suite's verdict: its worst command, with what each failing command says.
export function compareSuite(head, base, { selector, knownLists = {} }) {
  const commands = head.map((result, index) => ({ index, ...compareCommand(result, base?.[index], { selector, known: knownLists[result.known] ?? [] }) }));
  const worst = commands.reduce((a, b) => (SEVERITY.indexOf(b.verdict) > SEVERITY.indexOf(a.verdict) ? b : a), { verdict: 'pass' });
  const details = commands.filter((command) => command.verdict !== 'pass').map((command) => `command ${command.index + 1}: ${command.verdict}${command.detail ? ` (${command.detail})` : ''}`);
  return { verdict: worst.verdict, ...(details.length ? { detail: details.join('; ') } : {}) };
}

const pythonVersion = () => String(spawnSync(PYTHON, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout ?? '').trim();

// main's results are kept per main commit, platform, suite, tool version, Node
// and Python versions and main's own dependencies (--fresh-base runs them again).
export function mainResultsFile(home, { main, id, platform = process.platform, node = process.version, python, dependencies }) {
  const key = sha256(JSON.stringify({ version: CACHE_VERSION, main, platform, id, node, python, dependencies })).slice(0, 16);
  return path.join(home, 'main-results', `${main.slice(0, 16)}-${id}-${key}.json`);
}
export function readCached(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // none yet, or unreadable: run main again
  }
}
export function writeCached(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  renameRetrying(temporary, file);
}
function mainResults(selector, id, { root, main, home, logFile, env, freshBase }) {
  const cache = mainResultsFile(home, { main, id, python: pythonVersion(),
    dependencies: NEEDS_APP_DEPENDENCIES.has(id) ? dependencyKeyAt(root, main) : null });
  const cached = freshBase ? null : readCached(cache);
  if (cached) return cached;
  const dir = worktree(root, main, home);
  if (NEEDS_APP_DEPENDENCIES.has(id)) ensureAppDependencies(dir, home, { rebuild: id === 'production-schema' });
  const results = runCommands(selector, id, dir, main, logFile, { env });
  writeCached(cache, results);
  return results;
}

const platformName = () => (process.platform === 'win32' ? 'windows' : 'linux');

function verifyHere({ root, home, selector, main, candidate, suites, logs, freshBase, lock }) {
  const platform = platformName();
  if (process.version !== `v${CI_NODE}`) console.log(`local-verify: ${platform}: Node ${process.version} here, CI uses v${CI_NODE}`);
  const dir = worktree(root, candidate, home);
  pruneWorktrees(root, home, [dir, worktreePath(root, main, home)]);
  const env = testEnvironment(process.env, { CI_BASE_SHA: main });
  const knownLists = selector.readKnownFailures();
  const results = [];
  for (const id of suites) {
    const log = path.join(logs, `${platform}-${id}.log`);
    console.log(`local-verify: ${platform}: ${id} ...`);
    let outcome;
    try {
      lock?.refresh();
      cleanWorktree(dir);
      if (NEEDS_APP_DEPENDENCIES.has(id)) ensureAppDependencies(dir, home, { rebuild: id === 'production-schema' });
      const head = runCommands(selector, id, dir, main, log, { env });
      outcome = compareSuite(head, null, { selector, knownLists });
      if (outcome.verdict !== 'pass') {
        console.log(`local-verify: ${platform}: ${id} failed; running it on main ${main.slice(0, 12)} to compare`);
        const theirs = mainResults(selector, id, { root, main, home, logFile: path.join(logs, `${platform}-${id}.main.log`), env, freshBase });
        outcome = compareSuite(head, theirs, { selector, knownLists });
      }
    } catch (error) {
      outcome = { verdict: 'unknown', detail: error.message };
    }
    results.push({ platform, suite: id, ...outcome, log });
    console.log(`local-verify: ${platform}: ${id}: ${outcome.verdict}${outcome.detail ? ` (${outcome.detail})` : ''}`);
  }
  return results;
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// The distribution keeps its own clone and gets commits only from bundles this
// side writes: it has no GitHub login (the repository is private), and this
// repository may borrow objects through alternates with Windows paths, which
// git there cannot follow. The bundle brings objects; GitHub's branches and
// tags are then set exactly from `refs` (update-ref --stdin lines, deletions
// too), whether or not a bundle was needed. It runs the same copy of this file
// as this side (which needs nothing but Node; the change under test may not
// have it) against that clone.
export function linuxScript({ bundle, refs, tool, run, candidate, main, suites, freshBase = false }) {
  return [
    'set -e',
    `repo="$HOME/${LINUX_HOME}/repo"`,
    'mkdir -p "$repo"; [ -d "$repo/.git" ] || git init -q "$repo"',
    `git -C "$repo" remote get-url origin >/dev/null 2>&1 || git -C "$repo" remote add origin https://github.com/${REPOSITORY}.git`,
    ...(bundle ? [
      `git -C "$repo" bundle verify -q ${quote(bundle)} >/dev/null`,
      // every ref the bundle carries, so all its objects are kept (a fetch keeps
      // only what the refs it takes reach); dropped once the real refs are set
      `git -C "$repo" fetch -q --no-tags ${quote(bundle)} '+refs/*:${INCOMING}*'`,
    ] : []),
    `git -C "$repo" update-ref --stdin < ${quote(refs)}`,
    `for commit in ${candidate} ${main}; do git -C "$repo" cat-file -e "$commit^{commit}" || { echo "local-verify: $commit is not in the clone" >&2; exit 3; }; done`,
    `git -C "$repo" update-ref refs/local-verify/candidate ${candidate}`,
    `git -C "$repo" update-ref refs/local-verify/base ${main}`,
    `git -C "$repo" for-each-ref --format='delete %(refname)' ${INCOMING} | git -C "$repo" update-ref --stdin`,
    'tool=$(mktemp -d); trap \'rm -rf "$tool"\' EXIT',
    `cp ${quote(tool)} "$tool/local-verify.mjs"`,
    'cd "$repo"',
    `node "$tool/local-verify.mjs" --candidate ${candidate} --base ${main} --no-fetch${freshBase ? ' --fresh-base' : ''}${suites.map((id) => ` --suite ${quote(id)}`).join('')}`,
  ].join('\n');
}

export function readResults(text) {
  const line = String(text).split(/\r?\n/).reverse().find((candidate) => candidate.startsWith(RESULT_MARK));
  return line ? JSON.parse(line.slice(RESULT_MARK.length)) : null;
}

const wsl = (args, options = {}) => spawnSync('wsl.exe', args, { encoding: 'utf8', windowsHide: true, ...options,
  env: { ...process.env, WSL_UTF8: '1' } });

// The distribution's clone: every ref with what it points at, and the objects
// among those that this repository has too (the bundle can build on them).
function linuxRefs(root, distribution) {
  const listed = wsl(['-d', distribution, '--exec', '/bin/sh', '-c',
    `git -C "$HOME/${LINUX_HOME}/repo" for-each-ref --format='%(objectname) %(refname)' 2>/dev/null || true`]);
  const refs = new Map();
  for (const line of String(listed.stdout ?? '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{40}) (refs\/\S+)$/.exec(line.trim());
    if (match) refs.set(match[2], match[1]);
  }
  return { refs, has: present(root, [...new Set(refs.values())]) };
}

// The types of the objects of `shas` this repository has (missing ones are
// left out), asked in one git call.
function objectTypes(root, shas) {
  const types = new Map();
  if (!shas.length) return types;
  const answered = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd: root, input: `${shas.join('\n')}\n` }).split('\n');
  shas.forEach((sha, index) => {
    const [name, type] = (answered[index] ?? '').trim().split(' ');
    if (name === sha) types.set(sha, type);
  });
  return types;
}

// The commits and tags of `shas` this repository has: what a bundle can build on.
export function present(root, shas) {
  const types = objectTypes(root, shas);
  return shas.filter((sha) => types.get(sha) === 'commit' || types.get(sha) === 'tag');
}

// GitHub's branches and tags as last fetched here, under the names CI's
// checkout gives them (origin/*, tags).
export function githubRefs(root) {
  const refs = new Map();
  const listed = git(['for-each-ref', '--format=%(objectname) %(refname)', GITHUB_BRANCHES, GITHUB_TAGS], { cwd: root });
  for (const line of listed.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split(' ');
    refs.set(ref.startsWith(GITHUB_BRANCHES) ? `refs/remotes/origin/${ref.slice(GITHUB_BRANCHES.length)}` : `refs/tags/${ref.slice(GITHUB_TAGS.length)}`, sha);
  }
  return refs;
}

// update-ref --stdin lines that make the clone's origin/* and tags exactly
// `wanted`: new and moved refs set, refs GitHub no longer has deleted.
export function refUpdates(wanted, have) {
  const lines = [];
  for (const [ref, sha] of wanted) if (have.get(ref) !== sha) lines.push(`update ${ref} ${sha}`);
  for (const ref of have.keys()) {
    if ((ref.startsWith('refs/remotes/origin/') || ref.startsWith('refs/tags/')) && !wanted.has(ref)) lines.push(`delete ${ref}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// A bundle of the objects a clone that has `has` lacks: the candidate and
// main under refs/local-verify/<run>/{candidate,base}, and GitHub's branches
// and tags as last fetched; null when it lacks none. The first one carries the
// whole history. What the clone has goes in on stdin, however many refs it has.
export function bundleFor(root, { run, candidate, main, has, file }) {
  const github = [`--glob=${GITHUB_BRANCHES}*`, `--glob=${GITHUB_TAGS}*`];
  const exclude = has.map((sha) => `^${sha}\n`).join('');
  const missing = Number(git(['rev-list', '--count', candidate, main, ...github, '--stdin'], { cwd: root, input: exclude }));
  // an annotated tag made on a commit the clone has: no new commit, but a new tag object
  const known = new Set(has);
  const tagObjects = [...objectTypes(root, [...new Set(githubRefs(root).values())].filter((sha) => !known.has(sha)))]
    .filter(([, type]) => type === 'tag');
  if (missing === 0 && !tagObjects.length) return null;
  const refs = [`refs/local-verify/${run}/candidate`, `refs/local-verify/${run}/base`];
  git(['update-ref', refs[0], candidate], { cwd: root });
  git(['update-ref', refs[1], main], { cwd: root });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    git(['bundle', 'create', '--quiet', file, ...refs, ...github, '--stdin'], { cwd: root, input: exclude });
  } finally {
    for (const ref of refs) git(['update-ref', '-d', ref], { cwd: root, allowFail: true });
  }
  return file;
}

// The Linux run, or one unknown row saying why it could not start; it never
// stops the Windows run.
export function startLinux(options) {
  try {
    return startLinuxRun(options);
  } catch (error) {
    return Promise.resolve([{ platform: 'linux', suite: '(run)', verdict: 'unknown', detail: error.message, log: options.logs }]);
  }
}

function startLinuxRun({ root, home, candidate, main, suites, logs, freshBase, distribution = DISTRIBUTION }) {
  const names = wsl(['--list', '--quiet']);
  if (!String(names.stdout ?? '').split(/\r?\n/).map((name) => name.replace(/\0/g, '').trim()).includes(distribution)) {
    throw new Error(`${distribution} is not installed; run scripts/ci/setup-clued-dev-linux.ps1`);
  }
  const run = `run-${process.pid}`;
  const clone = linuxRefs(root, distribution);
  const bundle = bundleFor(root, { run, candidate, main, has: clone.has, file: path.join(home, 'bundles', `${run}.bundle`) });
  const refsFile = path.join(home, 'bundles', `${run}.refs`);
  fs.mkdirSync(path.dirname(refsFile), { recursive: true });
  fs.writeFileSync(refsFile, refUpdates(githubRefs(root), clone.refs));
  const toolFile = path.join(home, 'bundles', `${run}.local-verify.mjs`);
  fs.copyFileSync(fileURLToPath(import.meta.url), toolFile);
  const logFile = path.join(logs, 'linux.log');
  const fd = fs.openSync(logFile, 'w');
  console.log(`local-verify: linux: running in ${distribution} (log ${logFile})`);
  const script = linuxScript({ bundle: bundle && toWslPath(bundle), refs: toWslPath(refsFile), tool: toWslPath(toolFile), run, candidate, main,
    suites, freshBase });
  const child = spawnAsync('wsl.exe', ['-d', distribution, '--cd', '~', '--exec', '/bin/bash', '-lc', script],
    { stdio: ['ignore', fd, fd], windowsHide: true });
  const timer = setTimeout(() => child.kill(), LINUX_TIMEOUT_MS);
  return new Promise((resolve) => {
    let done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.closeSync(fd);
      if (bundle) fs.rmSync(bundle, { force: true });
      fs.rmSync(refsFile, { force: true });
      fs.rmSync(toolFile, { force: true });
      const results = readResults(fs.readFileSync(logFile, 'utf8'))?.map((result) => ({ ...result, log: windowsPathOf(result.log) }));
      resolve(results ?? [{ platform: 'linux', suite: '(run)', verdict: 'unknown', detail: error ?? `exited ${code} without results`, log: logFile }]);
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });
}

const VERDICT_LABEL = { pass: 'PASS', base: 'ALREADY FAILING ON MAIN', new: 'NEW FAILURE', unknown: 'COULD NOT COMPARE' };

async function main(argv) {
  const options = parseArgs(argv);
  if (options.linux && process.platform !== 'win32') throw new Error('--linux runs from Windows; here the run already is on Linux');
  const root = git(['rev-parse', '--show-toplevel']);
  const home = cacheHome();
  fs.mkdirSync(home, { recursive: true });
  for (const note of systemDriveNotes(home)) console.log(`local-verify: WARNING: ${note}`);
  if (options.candidate && !options.suites.length) throw new Error('--candidate needs --suite');
  // the change as it is now, before any wait for another run
  const change = options.candidate ? null : snapshot(root, options.committed);
  if (change?.included.length) {
    console.log(`local-verify: includes ${change.included.length} uncommitted file(s): ${change.included.slice(0, 20).join(', ')}${change.included.length > 20 ? ', ...' : ''}`);
  }
  const lock = acquireLock(home);
  // refs earlier versions of this file left in the user's repository (in the
  // Linux clone, candidate and base are the ones linuxScript just set)
  if (!options.candidate) {
    for (const ref of ['refs/local-verify/github-main', 'refs/local-verify/candidate', 'refs/local-verify/base']) {
      git(['update-ref', '-d', ref], { cwd: root, allowFail: true });
    }
  }
  // fetched under the lock: a Linux hand-over reads the same refs
  const mainCommit = resolveMain(root, options);
  let candidate;
  let suites = options.suites;
  if (options.candidate) {
    candidate = git(['rev-parse', '--verify', `${options.candidate}^{commit}`], { cwd: root });
  } else {
    candidate = mergedCandidate(root, change.commit, mainCommit);
    console.log(candidate === change.commit
      ? `local-verify: change ${candidate.slice(0, 12)} already contains main ${mainCommit.slice(0, 12)}`
      : `local-verify: change ${change.commit.slice(0, 12)} merged into main ${mainCommit.slice(0, 12)}: ${candidate.slice(0, 12)}`);
  }
  // what earlier versions or stopped runs left behind
  fs.rmSync(path.join(home, 'baselines'), { recursive: true, force: true });
  if (fs.existsSync(path.join(home, 'bundles'))) {
    for (const name of fs.readdirSync(path.join(home, 'bundles'))) fs.rmSync(path.join(home, 'bundles', name), { force: true });
  }
  const selector = await loadSelector(root, mainCommit, home);
  if (!suites.length && change) {
    const files = changedFiles(root, change.commit, mainCommit, selector.FILE_LIMIT);
    suites = CHECKS.flatMap((check) => selector.selectSuites(check, files).suites);
    console.log(`local-verify: ${files === null ? 'more files than GitHub lists' : `${files.length} changed file(s)`}; suites: ${suites.join(', ') || 'none'}`);
  }
  for (const id of suites) if (!selector.SUITE_COMMANDS[id]) throw new Error(`unknown suite: ${id}`);
  const logs = path.join(home, 'logs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${candidate.slice(0, 12)}`);
  fs.mkdirSync(logs, { recursive: true });
  const linux = options.linux && suites.length
    ? startLinux({ root, home, candidate, main: mainCommit, suites, logs, freshBase: options.freshBase })
    : null;
  const results = options.here ? verifyHere({ root, home, selector, main: mainCommit, candidate, suites, logs, freshBase: options.freshBase, lock }) : [];
  if (linux) results.push(...await linux);
  console.log('\nlocal-verify summary');
  for (const result of results) {
    console.log(`  ${result.platform.padEnd(8)} ${result.suite.padEnd(22)} ${VERDICT_LABEL[result.verdict]}${result.detail ? `: ${result.detail}` : ''}`);
    if (result.verdict !== 'pass') console.log(`  ${''.padEnd(31)} log: ${result.log}`);
  }
  console.log(`${RESULT_MARK}${JSON.stringify(results)}`);
  return results.some((result) => result.verdict === 'new' || result.verdict === 'unknown') ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`local-verify: ${error.message}`);
    process.exitCode = 2;
  }
}
