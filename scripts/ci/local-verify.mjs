// Local verification: an optional check of one's own change, not a condition
// of a push (defect 66b7bf56, Owner Decision ecef33d5; resident ADR 0032).
// The gate is CI, which runs the same selection once on Linux and once on
// Windows; #1092 was verified here, on Windows alone, and failed on Linux.
// This tool selects without a platform (selectSuites(check, files)), so it
// runs the union of what CI runs on either side; which suite CI runs where is
// SUITE_PLATFORMS in ci-required-selection.mjs and nowhere else.
//
// Runs the suites the required checks (clued-required-tests.yml) would run for
// this change, the way they run them, on Windows and (--linux) in CluedDev-Linux, and
// reports only the failures the change brings: a suite that fails is run again
// on main, and each failing command is compared with the same command there.
//
//   node scripts/ci/local-verify.mjs --affected [--base <commit>] [--committed] [--linux-only]
//                                    [--no-fetch] [--fresh-base] [--no-yield]
//   node scripts/ci/local-verify.mjs [--base <commit>] [--committed] [--suite <id>]...
//                                    [--linux | --linux-only] [--no-fetch] [--fresh-base] [--no-yield]
//
//   --affected    the way to look before a push, when one wants to (task 70e5f450: a hand-picked
//                 --suite list missed offline-drill for #1015). It is the default
//                 selection plus --linux (on Windows), and it refuses --suite and --candidate,
//                 so the suites cannot be hand-picked: the files the branch
//                 changes against main select them with the required checks' own
//                 selectSuites (ci-required-selection.mjs of main, or of --base; the
//                 call the "Select suites" step of ci-suites makes), and only those
//                 run, on Windows and in CluedDev-Linux (on a non-Windows host, here
//                 alone; on Windows without CluedDev-Linux the Linux result is
//                 "could not compare" and, when a suite is selected, the exit status 1). It prints the line CI
//                 logs for each check ("ci-suites: selected by changed paths;
//                 suites: ...") and, for each suite, the changed files that picked
//                 it (a default run prints the same). --linux-only keeps the run
//                 to the Linux side.
//   --base        the main commit to verify against; default: GitHub's main,
//                 fetched first (--no-fetch uses the last fetched copy).
//   --committed   verify HEAD only; by default the working tree's changes and
//                 new files that are not ignored are included (listed first;
//                 they are also copied into the Linux clone).
//   --suite       run only these suites (default: what the selection picks,
//                 on Windows alone unless --linux).
//   --linux       also run in CluedDev-Linux (set up by
//                 setup-clued-dev-linux.ps1), at the same time as the Windows
//                 run; --linux-only runs only there.
//   --fresh-base  run main's suites again instead of reusing their results.
//   --no-yield    do not wait for the resident independent CI (see below).
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
// Runs go side by side (defect 791484c2). Each run is queued after the change is
// snapshotted (so it verifies what was there when it started) and starts when it
// is first in line and the machine has room for one more: free memory, idle CPU,
// free disk, the system drive counted against the CI watchdog's levels. At most
// CLUED_LOCAL_VERIFY_MAX_RUNS run (default 4); the first run always starts;
// CLUED_LOCAL_VERIFY_RESOURCES=off leaves only that limit, as the tests do. A
// waiting run prints its position.
// A run stopped without cleaning up (a killed process) is noticed by its process
// number and, while queued, by not having been touched for two minutes. run.lock
// keeps naming a run that lives (a run names itself again between suites if the
// one it named has stopped), so copies of this tool that still take the whole
// cache wait for all of them.
// The shared things have a lock each: the installation of the dependencies of a
// lockfile, main's results, main's worktree, the repository's worktree list and
// fetches. A change is verified in a worktree of its own and with a temporary
// directory of its own (TEMP, TMP, TMPDIR for the tests) under the cache.
// Logs, worktrees, results of main and the dependency cache (about 10 GB) live
// under <data drive>:\clued-dev\cache\clued-local-verify on Windows: the first
// fixed drive after the system drive (as setup-clued-dev-linux.ps1 picks), or
// CLUED_DEV_ROOT (the same root setup-clued-dev-linux.ps1 installs CluedDev-Linux
// under) or, for this directory alone, CLUED_LOCAL_VERIFY_HOME;
// ~/.cache/clued-local-verify where there is no other drive. Never on the system
// drive when another exists: the CI host's watchdog pauses the runners when it
// runs short (defect 2102f7e1). The location is always a real path, links
// resolved. On a CI host (a machine in scripts/ci/self-hosted/node-profiles.json)
// a run warns when the system drive is below the level at which the installed
// watchdog starts the runners again.
// On a host with the resident independent CI (DESK), a run waits before each
// suite, on both sides, while the resident runs a batch (its status.json has
// `current` set): they share the one WSL2 VM and the CPU, and a loaded host
// made the resident's stage-2 relay give up (defect e0a5630d). The wait is
// bounded (90 minutes in all for each side of a run, then it goes on and says
// so) and prints why; --no-yield skips it. A run waits in its place (it keeps
// its slot), so runs queued behind it wait too.
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
import { install as installDeps, npmCommand, runNpm } from './ci-deps.mjs';

export const REPOSITORY = 'tdoljyj/cross-memory-system';
export const DISTRIBUTION = 'CluedDev-Linux';
// The Node version clued-required-tests.yml sets up.
export const CI_NODE = '24.19.0';
const CACHE_VERSION = 5; // 5: tests run with a temporary directory of their own (a failure message may name its drive)
const SELECTOR = 'scripts/ci/ci-required-selection.mjs';
const SELECTOR_FILES = [SELECTOR, 'scripts/ci/ci-known-failures.json', 'scripts/ci/ci-test-failures-reporter.mjs'];
const APP = 'apps/clued-cloud';
// mechanical-outputs links the store into its throwaway worktree (component-version-integration.py): it never installs here.
const NEEDS_APP_DEPENDENCIES = new Set(['clued-cloud', 'production-schema', 'mechanical-outputs']);
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
  const options = { base: null, candidate: null, committed: false, suites: [], affected: false, here: true, linux: false, fetch: true, freshBase: false, yield: true };
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
    else if (arg === '--affected') options.affected = true;
    else if (arg === '--linux') options.linux = true;
    else if (arg === '--linux-only') Object.assign(options, { linux: true, here: false });
    else if (arg === '--no-fetch') options.fetch = false;
    else if (arg === '--fresh-base') options.freshBase = true;
    else if (arg === '--no-yield') options.yield = false;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.affected && options.suites.length) throw new Error('--affected selects the suites itself; drop --suite');
  if (options.affected && options.candidate) throw new Error('--candidate is internal (the Linux hand-over); --affected cannot be combined with it');
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

// The fixed (internal) drives, "C:" and so on: what setup-clued-dev-linux.ps1
// picks its data drive from too (an optical drive, a USB stick or a network drive
// is not a place for 10 GB of cache). Empty when they cannot be listed.
export function fixedDrives({ run = spawnSync, exists = fs.existsSync } = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const listed = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID"], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const drives = listed.status === 0 ? String(listed.stdout).split(/\r?\n/).map((line) => line.trim().toUpperCase()).filter((drive) => /^[A-Z]:$/.test(drive)) : [];
    if (drives.length) return drives;
  }
  // cannot be listed: the drives that exist (an optical or removable one may be among them), never a silent switch
  // of the cache to the home directory, which would have its own locks and registry
  const guessed = [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:`).filter((drive) => exists(`${drive}\\`));
  guessed.guessed = true;
  return guessed;
}

// Where the developer tools keep their large files on Windows: CLUED_DEV_ROOT,
// else \clued-dev on the first fixed drive after the system drive (D: to Z:, as
// the setup script does); null elsewhere and where there is no other drive.
export function dataRoot(env = process.env, { platform = process.platform, fixed = fixedDrives, systemDrive = env.SystemDrive || 'C:', exists = fs.existsSync } = {}) {
  if (env.CLUED_DEV_ROOT) return path.resolve(env.CLUED_DEV_ROOT);
  if (platform !== 'win32') return null;
  const drives = fixed();
  const candidates = [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:`)
    .filter((drive) => drive.toLowerCase() !== systemDrive.toLowerCase() && drives.includes(drive));
  // drives that were only guessed (the listing failed) may include an optical or a removable one: the one that
  // already has the data directory wins, so the cache does not move
  const chosen = drives.guessed ? (candidates.find((drive) => exists(`${drive}\\clued-dev`)) ?? candidates[0]) : candidates[0];
  return chosen ? path.win32.join(`${chosen}\\`, 'clued-dev') : null;
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

// The levels of free space on the system drive (GB) at which the node's governance task (node governance v1) turns a
// drive red (suspend) and back (resume): the standard's absolute levels (config/node-governance-standard.json red_gb /
// recover_gb; the share levels only make them stricter on large drives). Only a machine that is a CI host (its entry in
// scripts/ci/self-hosted/node-profiles.json, by host name) has any. CLUED_CI_RESUME_FREE_GB sets the resume level (0: none).
// Null for any other machine: nothing is guarded there.
export function watchdogLevels({ hostname = os.hostname(), env = process.env, readText = (file) => fs.readFileSync(file, 'utf8'),
  profilesFile = fileURLToPath(new URL('./self-hosted/node-profiles.json', import.meta.url)),
  standardFile = fileURLToPath(new URL('../../config/node-governance-standard.json', import.meta.url)) } = {}) {
  let levels = null;
  try {
    const profiles = JSON.parse(readText(profilesFile));
    const host = profiles.hosts.find((entry) => String(entry.hostname).toLowerCase() === String(hostname).toLowerCase()) ?? null;
    if (host) {
      const disk = JSON.parse(readText(standardFile)).disk;
      levels = { suspend: disk.red_gb, resume: disk.recover_gb };
    }
  } catch { /* not in a checkout of this repository */ }
  if (env.CLUED_CI_RESUME_FREE_GB !== undefined && Number.isFinite(Number(env.CLUED_CI_RESUME_FREE_GB))) {
    levels = { suspend: levels?.suspend ?? null, resume: Number(env.CLUED_CI_RESUME_FREE_GB) };
  }
  return levels;
}

// What a run should tell the user about the system drive (Windows, on a CI host):
// its free space below the watchdog's resume level, or the cache on it. Empty when
// there is nothing to say.
export function systemDriveNotes(home, { env = process.env, platform = process.platform, free = freeGb, levels = watchdogLevels({ env }) } = {}) {
  if (platform !== 'win32' || !levels) return [];
  const drive = `${env.SystemDrive || 'C:'}\\`;
  const notes = [];
  const resume = levels.resume;
  try {
    const gb = free(drive);
    if (Number.isFinite(resume) && resume > 0 && gb < resume) {
      notes.push(`${drive} has ${gb.toFixed(1)} GB free, below ${resume} GB: the CI host's watchdog raises its low-space alert${levels.suspend ? ` below ${levels.suspend} GB` : ''} and clears it at ${resume} GB (the resident CI's disk is there); free space there first`);
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

// npm as Windows starts it (npm.cmd needs a shell; npm's own CLI next to node.exe does not): ci-deps.mjs.
export { npmCommand };

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

// A lock is a file that appears with its content at once (written aside, then
// hard-linked into place). A lock whose process is gone, older than any run, or
// unreadable for longer than a write takes, is taken over: renamed away first
// (only one waiter can), then checked to be the one seen stale, so two waiters
// never both hold it. It is removed on exit only while it is still its holder's;
// refresh() renews its age. Named locks live in <home>/locks; the shared state
// (worktrees, dependency stores, results of main) is guarded by one lock per
// thing, not one for the whole cache (defect 791484c2).
const heldAtExit = new Set();
let exitHooked = false;
function releaseAtExit(release) {
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => { for (const held of [...heldAtExit]) held(); });
  }
  heldAtExit.add(release);
  return () => heldAtExit.delete(release);
}

export function acquireNamedLock(dir, name, { pid = process.pid, now = Date.now, wait = sleep, alive = processAlive, log = console.log,
  what = dir, pollMs = 5000, nowait = false, extra = {}, maxAgeMs = LOCK_MAX_AGE_MS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.lock`);
  const token = `${pid}-${now()}-${Math.random().toString(16).slice(2)}`;
  const read = (target) => {
    try {
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      return null;
    }
  };
  const aside = () => {
    const temporary = `${file}.${token}.new`;
    fs.writeFileSync(temporary, JSON.stringify({ pid, token, started: now(), ...extra }));
    return temporary;
  };
  const leftovers = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.lock\\..+$`);
  let announced = false;
  for (;;) {
    const temporary = aside();
    try {
      fs.linkSync(temporary, file);
      fs.rmSync(temporary, { force: true });
      let forget = () => {};
      const release = () => {
        forget();
        if (read(file)?.token === token) fs.rmSync(file, { force: true });
      };
      // Read, then replace: not one step, but only the holder writes its own lock
      // while it lives, and a failure only loses one renewal.
      release.refresh = () => {
        if (read(file)?.token !== token) return;
        let renewed = null;
        try {
          renewed = aside();
          renameRetrying(renewed, file);
        } catch (error) {
          if (renewed) fs.rmSync(renewed, { force: true });
          log(`local-verify: could not renew the lock ${name}: ${error.message}`);
        }
      };
      release.token = token;
      forget = releaseAtExit(release);
      // what a holder that stopped between writing and placing its lock, or
      // between taking over a stale lock and removing it, left
      for (const entry of fs.readdirSync(dir)) {
        if (!leftovers.test(entry) || entry.includes(token)) continue;
        const leftover = path.join(dir, entry);
        try {
          if (entry.endsWith('.new')) {
            if (now() - fs.statSync(leftover).mtimeMs > UNREADABLE_LOCK_MS) fs.rmSync(leftover, { force: true });
          } else if (!alive(Number(/\.lock\.(\d+)-/.exec(entry)?.[1]))) {
            fs.rmSync(leftover, { force: true }); // a lock a process took over (renamed away), then stopped
          }
        } catch { /* gone */ }
      }
      return release;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (error.code !== 'EEXIST') throw error;
    }
    const held = read(file);
    let stale;
    if (held) {
      stale = !alive(held.pid) || now() - held.started > maxAgeMs;
    } else {
      try {
        stale = now() - fs.statSync(file).mtimeMs > UNREADABLE_LOCK_MS;
      } catch {
        continue; // gone meanwhile
      }
    }
    // a second look: the lock seen stale may have been taken over and replaced since
    if (stale && held && read(file)?.token !== held.token) continue;
    if (!stale) {
      if (nowait) return null;
      if (!announced) log(`local-verify: another run (process ${held?.pid ?? 'unknown'}) is using ${what}; waiting for it`);
      announced = true;
      wait(pollMs);
      continue;
    }
    const moved = `${file}.${token}`;
    try {
      fs.renameSync(file, moved);
    } catch {
      wait(50); // another waiter took it first (or the file is held for a moment): not a tight loop
      continue;
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

// The whole-cache lock of earlier versions of this tool (still taken, as
// run.lock, by copies that have not been updated: see takeUmbrella). This
// version only uses it through the tests of the lock itself.
export function acquireLock(home, options = {}) {
  return acquireNamedLock(home, 'run', { what: home, ...options });
}

const lockDirOf = (home) => path.join(home, 'locks');
// How long a holder may hold a lock before it counts as stale even though its
// process number is in use (the number of a stopped process is soon reused).
const lockMaxAge = (name) => (name === 'admission' ? 2 * 60_000 : name.startsWith('git-') ? 10 * 60_000 : name.startsWith('selector-') ? 5 * 60_000
  : name.startsWith('fetch-') ? 35 * 60_000 : LOCK_MAX_AGE_MS);
// fn() while holding the named lock of the cache.
export function withLock(home, name, fn, options = {}) {
  const release = acquireNamedLock(lockDirOf(home), name, { what: name, pollMs: 250, maxAgeMs: lockMaxAge(name), ...options }); // short holds are common: look often
  try {
    return fn(release);
  } finally {
    release();
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

// ---- several runs at once (defect 791484c2) ----
//
// Every run registers itself in <home>/runs/<id>.json (queued, then running;
// removed when it ends; a file whose process is gone is dropped). A run starts
// when it is first in the queue and the machine has room for one more: free
// memory, idle CPU and free disk, the system drive counted against the level at
// which the CI host's watchdog clears its C: alert. The first run always starts.
// A run that has to wait says its position.
export const RUN_NEEDS = { memGb: 6, cores: 4, dataGb: 3, systemGb: 3 }; // one more run: Windows and Linux side, embedded PostgreSQL, builds
export const HOST_KEEPS = { memGb: 10, cores: 4, dataGb: 10 }; // what the CI runners and the user keep (the watchdog resumes at 10 GB of memory)
// In the Linux distribution (one VM with the CI runners' distribution, 28 GB here) the watchdog stops the runners at 6 GB free memory.
export const VM_KEEPS = { memGb: 6, cores: 4, dataGb: 5 };
export const MAX_RUNS = 4;
const RAMP_MS = 120_000; // a run just started has not yet taken what it will take
const QUEUE_POLL_MS = 1000;
const QUEUE_GRACE_MS = 3000; // a wait this short is not worth a line
const QUEUE_REPORT_MS = 60_000;
const GIB = 1024 ** 3;

const runsDirOf = (home) => path.join(home, 'runs');

// The runs that are alive: files of runs whose process is gone, or that were not
// renewed for longer than any run lasts, are removed.
// A queued run is looked after every second, so one not touched for two minutes is gone (whatever its process number now is).
const QUEUED_STALE_MS = 2 * 60_000;
export function listRuns(home, { alive = processAlive, now = Date.now, wait = sleep } = {}) {
  const dir = runsDirOf(home);
  const runs = [];
  runs.unreadable = 0; // records that could not be read (being replaced): what looks at the list to remove things must not act on it
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch { /* none yet */ }
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith('.json.tmp')) {
      try {
        if (now() - fs.statSync(file).mtimeMs > 10 * 60_000) fs.rmSync(file, { force: true }); // a write that stopped half way
      } catch { /* gone */ }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    let run = null;
    for (let attempt = 1; attempt <= 3 && run === null; attempt += 1) {
      try {
        run = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') {
          run = undefined;
        } else if (attempt < 3) {
          wait(20); // Windows may refuse a read for a moment while the record is replaced
        }
      }
    }
    if (run === undefined) continue; // gone
    if (run === null) {
      let age = 0;
      try {
        age = now() - fs.statSync(file).mtimeMs;
      } catch { continue; }
      if (age > 10 * 60_000) fs.rmSync(file, { force: true }); // garbled (a power loss), not being written
      else runs.unreadable += 1;
      continue;
    }
    let stale = !alive(run.pid);
    try {
      stale = stale || now() - fs.statSync(file).mtimeMs > (run.state === 'queued' ? QUEUED_STALE_MS : LOCK_MAX_AGE_MS);
    } catch {
      continue; // gone meanwhile
    }
    if (stale) fs.rmSync(file, { force: true });
    else runs.push(run);
  }
  return runs;
}

// This run, in the registry. handle.update({...}) changes its record, touch()
// shows that it lives, end() removes it (also at exit).
export function beginRun(home, { pid = process.pid, now = Date.now, label = '' } = {}) {
  const id = `${pid}-${Math.random().toString(16).slice(2).padEnd(6, '0').slice(0, 6)}`;
  const run = { id, pid, state: 'queued', queuedAt: now(), label, deps: [], worktrees: [] };
  fs.mkdirSync(runsDirOf(home), { recursive: true });
  const file = path.join(runsDirOf(home), `${id}.json`);
  const write = () => {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(run));
    renameRetrying(temporary, file);
  };
  write();
  let forget = () => {};
  const handle = {
    run,
    update(patch) {
      Object.assign(run, patch);
      write();
    },
    touch() {
      try {
        fs.utimesSync(file, new Date(), new Date());
      } catch {
        write(); // the file was dropped as stale meanwhile
      }
    },
    end() {
      forget();
      fs.rmSync(file, { force: true });
    },
  };
  forget = releaseAtExit(handle.end);
  return handle;
}

// Idle CPU cores (two looks at the CPU times, a moment apart), free memory and
// free disk (the cache's drive, and the system drive where the watchdog guards it).
export function sampleResources(home, { cpus = os.cpus, freemem = os.freemem, free = freeGb, platform = process.platform, env = process.env, wait = sleep } = {}) {
  const total = (list) => list.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
  const idle = (list) => list.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const before = cpus();
  wait(500);
  const after = cpus();
  const span = total(after) - total(before);
  const idleCores = span > 0 ? (after.length * (idle(after) - idle(before))) / span : after.length;
  let systemFreeGb = null;
  if (platform === 'win32') {
    try {
      systemFreeGb = free(`${env.SystemDrive || 'C:'}\\`);
    } catch { /* not askable */ }
  }
  let dataFreeGb = null;
  try {
    dataFreeGb = free(home);
  } catch { /* not askable */ }
  return { freeMemGb: freemem() / GIB, idleCores, dataFreeGb, systemFreeGb };
}

// Room for one more run, given those running (and how many of them only just
// started: what they will take is not yet seen in the free numbers).
export function roomForOneMore({ running, ramping = 0 }, sample, { maxRuns = MAX_RUNS, needs = RUN_NEEDS, keeps = process.platform === 'win32' ? HOST_KEEPS : VM_KEEPS, resume = 0 } = {}) {
  if (running === 0) return { ok: true, lacks: [] };
  const lacks = [];
  if (running >= maxRuns) lacks.push({ kind: 'runs', text: `${running} runs are running, the limit is ${maxRuns}` });
  const short = (kind, label, free, need, keep, unit = 'GB') => {
    const ahead = ramping * need; // taken soon by the runs that only just started
    if (free - ahead - keep < need) {
      lacks.push({ kind, text: `${label}: ${free.toFixed(1)} ${unit} free${ahead ? `, ${ahead} of it about to be taken by runs just started` : ''}, ${need + keep} ${unit} needed (one more run takes ${need}, ${keep} stay free)` });
    }
  };
  short('memory', 'memory', sample.freeMemGb, needs.memGb, keeps.memGb);
  short('cpu', 'CPU', sample.idleCores, needs.cores, keeps.cores, 'idle cores');
  if (sample.dataFreeGb !== null) short('disk', 'disk of the cache', sample.dataFreeGb, needs.dataGb, keeps.dataGb);
  if (sample.systemFreeGb !== null && resume > 0) {
    short('system-disk', "the system drive (the CI watchdog clears its C: alert at its level)", sample.systemFreeGb, needs.systemGb, resume);
  }
  return { ok: lacks.length === 0, lacks };
}

// How many GB of the system drive the watchdog wants kept free (0 on a machine that is no CI host).
export const resumeLevelGb = (env = process.env, levels = watchdogLevels({ env })) => levels?.resume ?? 0;
export const maxRunsOf = (env = process.env) => (Number.isInteger(Number(env.CLUED_LOCAL_VERIFY_MAX_RUNS)) && Number(env.CLUED_LOCAL_VERIFY_MAX_RUNS) > 0
  ? Number(env.CLUED_LOCAL_VERIFY_MAX_RUNS) : MAX_RUNS);

// Earlier versions of this tool take one run.lock for a whole run and wait for
// each other's. While a run of this version lives, run.lock names one of them as
// its holder (concurrent: true), so such a copy keeps waiting instead of working
// on the shared state; this version joins a lock of its own kind and waits for
// one of an older copy. Called with the admission lock held.
function umbrellaState(home, { alive, now }) {
  const file = path.join(home, 'run.lock');
  let held = null;
  try {
    held = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* none, or unreadable */ }
  if (!held) {
    let age = null;
    try {
      age = now() - fs.statSync(file).mtimeMs;
    } catch { /* none */ }
    // unreadable for longer than a write takes: stale, as in acquireNamedLock
    return age === null || age > UNREADABLE_LOCK_MS ? { file, free: true } : { file, old: { pid: null } };
  }
  if (!alive(held.pid) || now() - held.started > LOCK_MAX_AGE_MS) return { file, free: true };
  return held.concurrent ? { file, joined: held } : { file, old: held };
}
// Makes run.lock name this process, or finds it already named by a run of this
// version; refuses when a live older copy holds it. A stale lock is renamed away
// first (and handed back if it was replaced meanwhile), then the new one is
// linked into place, which fails if anyone placed one in the meantime.
function takeUmbrella(home, { alive, now }) {
  const file = path.join(home, 'run.lock');
  try {
    for (const name of fs.readdirSync(home)) {
      const pid = /^run\.lock\.(\d+)\.(?:stale|umbrella)$/.exec(name)?.[1];
      if (pid !== undefined && !alive(Number(pid))) fs.rmSync(path.join(home, name), { force: true }); // left by a process that stopped
    }
  } catch { /* none */ }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const state = umbrellaState(home, { alive, now });
    if (state.joined) return { ok: true };
    if (state.old) return { ok: false, old: state.old };
    const moved = `${file}.${process.pid}.stale`;
    try {
      fs.renameSync(file, moved);
      let taken = null;
      try {
        taken = JSON.parse(fs.readFileSync(moved, 'utf8'));
      } catch { /* unreadable: stale */ }
      if (taken && alive(taken.pid) && now() - taken.started <= LOCK_MAX_AGE_MS) {
        try {
          fs.linkSync(moved, file); // a live lock was placed since we looked: give it back
        } catch { /* placed again meanwhile */ }
        fs.rmSync(moved, { force: true });
        continue;
      }
      fs.rmSync(moved, { force: true });
    } catch { /* none to move away */ }
    const temporary = writeUmbrella(file, process.pid, now);
    try {
      fs.linkSync(temporary, file);
      return { ok: true };
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error; // someone placed one (or swept ours) in this instant: look again
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return { ok: false, old: { pid: null } };
}
function writeUmbrella(file, pid, now) {
  const temporary = `${file}.${pid}.umbrella`;
  fs.writeFileSync(temporary, JSON.stringify({ pid, token: `umbrella-${pid}-${now()}`, started: now(), concurrent: true }));
  return temporary;
}

// Waits (printing its place in the queue) until this run may start, then marks
// it running. One short lock serialises the decisions of waiting runs.
export function admitRun(home, handle, { now = Date.now, wait = sleep, alive = processAlive, log = console.log,
  limits = {}, env = process.env, sample = env.CLUED_LOCAL_VERIFY_RESOURCES === 'off'
    ? () => ({ freeMemGb: Infinity, idleCores: Infinity, dataFreeGb: null, systemFreeGb: null }) // only the limit on runs applies (tests)
    : () => sampleResources(home) } = {}) {
  let reported = { key: '', at: 0 };
  for (;;) {
    let outcome;
    withLock(home, 'admission', () => {
      const runs = listRuns(home, { alive, now });
      const mine = runs.find((run) => run.id === handle.run.id);
      if (!mine) {
        handle.update({}); // dropped as stale: put back
        outcome = { ok: false, retry: true };
        return;
      }
      const queued = runs.filter((run) => run.state === 'queued').sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : 1));
      const position = queued.findIndex((run) => run.id === handle.run.id) + 1;
      const running = runs.filter((run) => run.state === 'running');
      let lacks = [];
      if (position > 1) {
        lacks.push({ kind: 'queue', text: `${position - 1} run${position > 2 ? 's' : ''} queued ahead` });
      } else {
        const ramping = running.filter((run) => now() - run.admittedAt < RAMP_MS).length;
        lacks = roomForOneMore({ running: running.length, ramping }, running.length === 0 ? {} : sample(),
          { maxRuns: maxRunsOf(env), resume: resumeLevelGb(env), ...limits }).lacks;
        if (lacks.length === 0) {
          // run.lock names this run (or a run of this version) before it starts, so an older copy waits
          const took = takeUmbrella(home, { alive, now });
          if (!took.ok) lacks.push({ kind: 'older', text: `an older copy of this tool is running (process ${took.old.pid ?? 'unknown'})` });
        }
      }
      outcome = { ok: lacks.length === 0, position, running: running.length, lacks };
      if (outcome.ok) handle.update({ state: 'running', admittedAt: now() });
    }, { pollMs: 200, log: () => {}, what: 'the admission lock' });
    if (outcome.ok) {
      if (reported.at) log(`local-verify: started after ${Math.round((now() - handle.run.queuedAt) / 1000)} s in the queue`);
      return;
    }
    if (!outcome.retry && now() - handle.run.queuedAt >= QUEUE_GRACE_MS) {
      const key = `${outcome.position}/${outcome.running}/${outcome.lacks.map((lack) => lack.kind).join(',')}`;
      if (key !== reported.key || now() - reported.at >= QUEUE_REPORT_MS) {
        log(`local-verify: queued, position ${outcome.position} (${outcome.running} running): ${outcome.lacks.map((lack) => lack.text).join('; ')}`);
        reported = { key, at: now() };
      }
    }
    handle.touch();
    wait(QUEUE_POLL_MS);
  }
}

// This run is done: if run.lock names this process, it passes to another run that
// is running (an older copy must not start while one lives), else it goes.
export function leaveUmbrella(home, handle, { alive = processAlive, now = Date.now } = {}) {
  try {
    withLock(home, 'admission', () => {
      const file = path.join(home, 'run.lock');
      let held = null;
      try {
        held = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { return; }
      if (!held?.concurrent || held.pid !== handle.run.pid) return;
      const successor = listRuns(home, { alive, now }).find((run) => run.state === 'running' && run.id !== handle.run.id);
      if (!successor) {
        fs.rmSync(file, { force: true });
        return;
      }
      const temporary = writeUmbrella(file, successor.pid, now);
      renameRetrying(temporary, file);
    }, { pollMs: 200, log: () => {}, what: 'the admission lock' });
  } catch { /* the registry entry still tells the others */ }
}

// Keeps run.lock young while this run is the process it names, and names a run
// that lives when the one it named is gone (stopped without handing it on: an
// older copy would take it while runs of this version still work).
export function refreshUmbrella(home, handle, { alive = processAlive, now = Date.now } = {}) {
  try {
    withLock(home, 'admission', () => {
      const state = umbrellaState(home, { alive, now });
      if (state.joined && state.joined.pid === handle.run.pid) renameRetrying(writeUmbrella(state.file, handle.run.pid, now), state.file);
      else if (state.free) takeUmbrella(home, { alive, now });
    }, { pollMs: 200, log: () => {}, what: 'the admission lock' });
  } catch { /* the next look again */ }
}

// The resident independent CI's status page (defect e0a5630d), as either side of a run sees it.
const RESIDENT_STATUS_WINDOWS = 'C:\\ProgramData\\CluedIndependentCI\\resident\\state\\status.json';
export const RESIDENT_STATUS = process.platform === 'win32' ? RESIDENT_STATUS_WINDOWS : toWslPath(RESIDENT_STATUS_WINDOWS);
export const YIELD_TIMEOUT_MS = 90 * 60_000; // all the waits of one side of a run together; longer than a resident batch normally runs
const YIELD_POLL_MS = 30_000;
const YIELD_REPORT_MS = 5 * 60_000;
const RESIDENT_STALE_MS = 5 * 60_000; // the service rewrites its status page every 15 s; a stopped one leaves its last page

// What the resident runs now, or null. Busy: its status page names a batch
// (`current`) that is not resting at parking point A (phase 'relay-wait': it
// only waits for a hosted relay, nothing of it runs here), and the page is
// fresh. Idle, stale, not installed here or unreadable: null (nothing to yield
// to that can be seen). The Linux side compares the WSL clock with the page's
// Windows time: a WSL clock more than five minutes ahead (after the host slept)
// makes it see the page as stale and not wait; accepted (the Windows side still waits).
export function residentBusy({ file = RESIDENT_STATUS, readText = (name) => fs.readFileSync(name, 'utf8'), now = Date.now } = {}) {
  let status;
  try {
    status = JSON.parse(readText(file));
  } catch {
    return null;
  }
  const current = status?.current;
  if (!current || typeof current !== 'object' || current.phase === 'relay-wait') return null;
  if (!(now() - Date.parse(status.writtenAt) <= RESIDENT_STALE_MS)) return null;
  const pr = Number.isSafeInteger(current.pr) ? `PR #${current.pr}` : 'a batch';
  return Number.isSafeInteger(current.stage) ? `${pr} (stage ${current.stage})` : pr;
}

// Wait while the resident runs a batch, at most timeoutMs (what is left of
// the run's YIELD_TIMEOUT_MS); returns how long it waited.
export function yieldToResident(label, { busy = residentBusy, wait = sleep, now = Date.now, log = console.log, keepAlive = () => {},
  timeoutMs = YIELD_TIMEOUT_MS, pollMs = YIELD_POLL_MS } = {}) {
  let what = busy();
  if (!what) return 0;
  const start = now();
  let reported = -Infinity;
  for (;;) {
    const waited = now() - start;
    if (waited >= timeoutMs) {
      log(`local-verify: ${label}: the resident CI still runs ${what}; this run's ${Math.round(YIELD_TIMEOUT_MS / 60_000)} min of waiting for it are used up; going on`);
      return waited;
    }
    if (now() - reported >= YIELD_REPORT_MS) {
      log(`local-verify: ${label}: waiting: the resident CI runs ${what} on this host (same WSL VM and CPU); up to ${Math.ceil((timeoutMs - waited) / 60_000)} min more, --no-yield skips this`);
      reported = now();
    }
    keepAlive();
    wait(Math.min(pollMs, timeoutMs - waited));
    what = busy();
    if (!what) {
      log(`local-verify: ${label}: the resident CI is idle after ${Math.round((now() - start) / 1000)} s; going on`);
      return now() - start;
    }
  }
}

// main: --base, else GitHub's main. GitHub's branches and tags are fetched
// either way (the Linux clone gets them); without a login or network the last
// fetched copy is used, else origin's main.
// The fetches of one repository take turns (two writing the same refs at once fail on ref locks).
function resolveMain(root, options, home) {
  if (options.fetch) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    let fetched = false;
    for (let attempt = 1; attempt <= 3 && !fetched; attempt += 1) {
      fetched = withLock(home, `fetch-${repositoryKey(root)}`, () => git(['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'fetch', '--quiet', '--no-tags',
        '--prune', `https://github.com/${REPOSITORY}.git`, `+refs/heads/*:${GITHUB_BRANCHES}*`, `+refs/tags/*:${GITHUB_TAGS}*`],
        { cwd: root, env, allowFail: true, timeout: 10 * 60_000 }).status === 0, { what: "GitHub's branches being fetched" });
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

// What the required checks run for these changed files (null: unknown): each
// check of the selection, through its own selectSuites, the call the workflow's
// "Select suites" step makes (node ci-required-selection.mjs --check <check>);
// no list of checks, suites or paths is kept here (only the format of the log
// line is). `lines` are what CI logs for each check, then, for each selected
// suite, the changed files that picked it (found by asking the same selection
// about each file alone), the first of each top-level directory (a file in the
// root counts as its own) first. A change to the selection or the workflow picks
// every suite, so it shows under all of them.
export function selectAffected(selector, files, { show = 3 } = {}) {
  const selections = Object.keys(selector.SUITES).map((check) => ({ check, ...selector.selectSuites(check, files) }));
  const lines = [];
  for (const { check, reason, suites } of selections) {
    lines.push(`${check}: ${reason}; suites: ${suites.join(', ') || 'none'}`);
    if (files === null || suites.length === 0) continue;
    const each = files.map((file) => ({ file, picks: selector.selectSuites(check, [file]).suites }));
    for (const id of suites) {
      const hits = each.filter((entry) => entry.picks.includes(id)).map((entry) => entry.file);
      const directories = new Set();
      const firsts = hits.filter((file) => !directories.has(file.split('/')[0]) && directories.add(file.split('/')[0]));
      const leading = new Set(firsts);
      const shown = [...firsts, ...hits.filter((file) => !leading.has(file))].slice(0, show);
      lines.push(`  ${id}: ${shown.join(', ')}${hits.length > shown.length ? `, ... (${hits.length - shown.length} more)` : ''}`);
    }
  }
  return { suites: selections.flatMap((entry) => entry.suites), selections, lines };
}

// The suites a change needs: the files it touches against main, selected.
export function chooseSuites(root, change, main, selector) {
  const files = changedFiles(root, change, main, selector.FILE_LIMIT);
  return { files, ...selectAffected(selector, files) };
}

// --affected adds the Linux side wherever there is one (it is reached from Windows).
export const runsLinux = (options, platform = process.platform) => options.linux || (options.affected && platform === 'win32');

// main's selection, known-failure list and reporter, as the workflow uses them.
async function loadSelector(root, main, home) {
  const dir = path.join(home, 'selectors', main);
  if (!fs.existsSync(path.join(dir, 'complete'))) {
    // written once, by whichever run gets there first; the others find it complete
    withLock(home, `selector-${main.slice(0, 16)}`, () => {
      if (fs.existsSync(path.join(dir, 'complete'))) return;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (const file of SELECTOR_FILES) {
        const result = spawnSync('git', ['show', `${main}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
        if (result.status !== 0) throw new Error(`main ${main.slice(0, 12)} has no ${file}`);
        fs.writeFileSync(path.join(dir, path.basename(file)), result.stdout);
      }
      fs.writeFileSync(path.join(dir, 'complete'), '');
    }, { what: `the selection files of main ${main.slice(0, 12)}` });
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
const repositoryKey = (root) => sha256(commonDir(root) ?? root).slice(0, 8);
// Named per repository too: the cache is per user, and a worktree of another
// clone would not see this clone's commits. A worktree with an owner (a run's id)
// is that run's alone; one without (main's, for the baseline) is shared and
// used only while holding its lock (worktreeLock).
export function worktreePath(root, commit, home, owner = null) {
  return path.join(home, 'worktrees', `${commit.slice(0, 16)}-${repositoryKey(root)}${owner ? `-r${owner}` : ''}`);
}
export const worktreeLock = (dir) => `worktree-${path.basename(dir)}`;
export function worktree(root, commit, home, { owner = null } = {}) {
  const dir = worktreePath(root, commit, home, owner);
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
    // --force also takes over this path when git still lists it but it is gone;
    // the repository's worktree list is written by one run at a time
    withLock(home, `git-${repositoryKey(root)}`, () => git(['worktree', 'add', '--quiet', '--detach', '--force', dir, commit], { cwd: root }),
      { what: 'the repository (adding a worktree)' });
  }
  cleanWorktree(dir);
  fs.utimesSync(dir, new Date(), new Date());
  return dir;
}

// A run's own worktree is removed when the run is done.
export function dropWorktree(root, dir, home) {
  try {
    removeLink(path.join(dir, APP, 'node_modules'));
  } catch { /* none */ }
  withLock(home, `git-${repositoryKey(root)}`, () => git(['worktree', 'remove', '--force', dir], { cwd: root, allowFail: true }),
    { what: 'the repository (removing a worktree)' });
  fs.rmSync(dir, { recursive: true, force: true });
}

// The runs' own worktrees whose run is gone, and all but the newest of the shared
// ones that nobody holds; only this cache's own.
const mtimeOf = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0; // gone: another run removed it
  }
};
export function pruneWorktrees(root, home, { alive = processAlive, now = Date.now } = {}) {
  const dir = path.join(home, 'worktrees');
  if (!fs.existsSync(dir)) return;
  const runs = listRuns(home, { alive, now });
  if (runs.unreadable) return; // a run's record is being replaced: its worktree may look unowned
  const live = new Set(runs.map((run) => run.id));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch { return; }
  const entries = names.map((name) => path.join(dir, name));
  const owned = (entry) => /-r(\d+-[0-9a-f]{6})$/.exec(entry)?.[1] ?? null;
  // the temporary directories of runs that are gone
  const temp = path.join(home, 't');
  try {
    for (const name of fs.readdirSync(temp)) {
      if (live.has(name)) continue;
      try {
        fs.rmSync(path.join(temp, name), { recursive: true, force: true });
      } catch { /* held by something a test left: the next run tries again */ }
    }
  } catch { /* none */ }
  const gone = [
    ...entries.filter((entry) => owned(entry) && !live.has(owned(entry))),
    ...entries.filter((entry) => !owned(entry)).sort((a, b) => mtimeOf(b) - mtimeOf(a)).slice(KEEP_WORKTREES),
  ];
  for (const old of gone) {
    // a shared worktree is only taken from someone who is not using it
    const release = owned(old) ? () => {} : acquireNamedLock(lockDirOf(home), worktreeLock(old), { nowait: true });
    if (release === null) continue;
    try {
      dropWorktree(root, old, home);
    } catch { /* in use by something we cannot see: the next run tries again */ } finally {
      release();
    }
  }
  // git's own list of worktrees that are gone
  withLock(home, `git-${repositoryKey(root)}`, () => git(['worktree', 'prune'], { cwd: root, allowFail: true }), { what: 'the repository (pruning worktrees)' });
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

function rebuildPackage(npm, name, cwd, log) {
  log(`local-verify: rebuilding ${name}`);
  if (npm(['rebuild', name], cwd).status !== 0) throw new Error(`rebuilding ${name} failed`);
}

// What a dependency store lacks: every package its lockfile installs on every
// platform (not optional, not a link) needs its package.json. The complete
// mark alone proves nothing (2026-11-12 03:56Z: a store marked complete was
// empty after a suite ran npm ci through the worktree's link to it).
export function missingDependencies(ready, { limit = 5 } = {}) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(ready, 'package-lock.json'), 'utf8')); } catch { return ['package-lock.json']; }
  if (!fs.existsSync(path.join(ready, 'node_modules'))) return ['node_modules'];
  const missing = [];
  for (const [name, entry] of Object.entries(lock?.packages ?? {})) {
    if (!name.startsWith('node_modules/') || entry?.optional || entry?.link) continue;
    if (!fs.existsSync(path.join(ready, name, 'package.json'))) missing.push(name);
    if (missing.length >= limit) break;
  }
  return missing;
}

// The application's node_modules for this lockfile, installed once (npm ci
// --ignore-scripts, as the workflow does; the embedded PostgreSQL package is
// rebuilt as migration-verify does) and linked into the worktree. One lock per
// dependency key: runs that need the same one wait for the first to finish it
// (the store is then only read), runs that need another install at the same time.
// A store a live run uses is never removed (the run's record names it, written
// while the key's lock is still held).
export function ensureAppDependencies(dir, home, { rebuild, log = console.log, run = null, npm = runNpm }) {
  const app = path.join(dir, APP);
  const read = (file) => (fs.existsSync(path.join(app, file)) ? fs.readFileSync(path.join(app, file)) : null);
  if (!read('package.json') || !read('package-lock.json')) throw new Error(`${APP} has no package.json or package-lock.json`);
  const key = dependencyKey({ lock: read('package-lock.json'), packageJson: read('package.json'), npmrc: read('.npmrc') ?? '' });
  const store = path.join(home, 'node_modules');
  const ready = path.join(store, key);
  const platformPackage = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  fs.mkdirSync(store, { recursive: true });
  withLock(home, `dependencies-${key}`, () => {
    for (const name of fs.readdirSync(store)) {
      // what a run that stopped mid-install or mid-delete left of this key (nobody else installs it now)
      if ((name.startsWith(`${key}-`) && /^[0-9a-f]{16}-.{6}$/.test(name)) || name === `${key}.deleting`) fs.rmSync(path.join(store, name), { recursive: true, force: true });
    }
    const lacking = fs.existsSync(path.join(ready, 'complete')) ? missingDependencies(ready) : [];
    if (lacking.length) {
      // marked complete but not: set aside like a pruned store, then installed again
      log(`local-verify: the ${APP} dependency store ${key} is marked complete but lacks ${lacking.join(', ')}; installing it again`);
      renameRetrying(ready, `${ready}.deleting`);
      fs.rmSync(`${ready}.deleting`, { recursive: true, force: true });
    }
    if (!fs.existsSync(path.join(ready, 'complete'))) {
      const temporary = fs.mkdtempSync(path.join(store, `${key}-`));
      for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
        if (fs.existsSync(path.join(app, file))) fs.copyFileSync(path.join(app, file), path.join(temporary, file));
      }
      try {
        // as CI does (ci-deps.mjs): offline from the npm cache, which is prepared (the only networked step) when it lacks a package
        log(`local-verify: installing ${APP} dependencies (${key})`);
        installDeps(temporary, { cache: path.join(home, 'npm-cache'), run: npm, log });
        // the embedded PostgreSQL package is rebuilt before the store is complete: once complete it is only read
        // (a rebuild in place would replace binaries that another run's tests are running)
        if (fs.existsSync(path.join(temporary, 'node_modules', platformPackage))) {
          rebuildPackage(npm, platformPackage, temporary, log);
          fs.writeFileSync(path.join(temporary, 'rebuilt'), '');
        }
        const absent = missingDependencies(temporary);
        if (absent.length) throw new Error(`installing ${APP} dependencies (${key}) left out ${absent.join(', ')}: cannot verify`);
        fs.writeFileSync(path.join(temporary, 'complete'), '');
        renameRetrying(temporary, ready);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
    // a store an earlier version of this tool installed has not been rebuilt: that one is rebuilt in place, once
    if (rebuild && !fs.existsSync(path.join(ready, 'rebuilt')) && fs.existsSync(path.join(ready, 'node_modules', platformPackage))) {
      rebuildPackage(npm, platformPackage, ready, log);
      fs.writeFileSync(path.join(ready, 'rebuilt'), '');
    }
    fs.utimesSync(ready, new Date(), new Date());
    if (run && !run.run.deps.includes(key)) run.update({ deps: [...run.run.deps, key] });
  }, { what: `the ${APP} dependencies ${key} being installed`, log });
  pruneDependencyStores(home, { keep: key });
  linkDependencies(path.join(app, 'node_modules'), path.join(ready, 'node_modules'));
  return key;
}

// All but the newest stores go, except those a live run uses or holds the lock of.
export function pruneDependencyStores(home, { keep = null, alive = processAlive, now = Date.now } = {}) {
  const store = path.join(home, 'node_modules');
  const runs = listRuns(home, { alive, now });
  if (runs.unreadable) return; // a run's record is being replaced: its store may look unused
  let names = [];
  try {
    names = fs.readdirSync(store);
  } catch { return; }
  const stores = names.filter((name) => /^[0-9a-f]{16}$/.test(name)).sort((a, b) => mtimeOf(path.join(store, b)) - mtimeOf(path.join(store, a)));
  const leftovers = names.filter((name) => /^[0-9a-f]{16}\.deleting$/.test(name)).map((name) => name.slice(0, 16));
  for (const key of [...stores.slice(KEEP_DEPENDENCY_STORES), ...leftovers]) {
    if (key === keep) continue;
    const release = acquireNamedLock(lockDirOf(home), `dependencies-${key}`, { nowait: true });
    if (release === null) continue; // being installed or just taken by a run
    try {
      // looked at with the lock held: a run records its store before it lets go of the lock
      const again = listRuns(home, { alive, now });
      if (again.unreadable || again.some((run) => run.deps?.includes(key))) continue;
      const old = path.join(store, key);
      // renamed first, so a half-deleted store never looks complete
      if (fs.existsSync(old)) renameRetrying(old, `${old}.deleting`);
      fs.rmSync(`${old}.deleting`, { recursive: true, force: true });
    } catch { /* in use by something we cannot see: the next run tries again */ } finally {
      release();
    }
  }
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

// How many tests a Node test report shows: the run's own count (skipped and todo
// tests included: a command whose tests are all skipped on this platform did get to
// its tests), else the events.
export function testsRun(report) {
  const counts = report?.summary?.counts;
  if (counts && Number.isFinite(counts.tests)) return counts.tests;
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
      '($_.CommandLine.IndexOf($d + [char]92, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf($e + [char]47, [StringComparison]::OrdinalIgnoreCase) -ge 0) } |',
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }'].join(' ')],
    { LOCAL_VERIFY_DIR: dir }];
  }
  return ['pkill', ['-e', '-f', '--', `${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`], {}];
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
  // A module that cannot be loaded (on either side) says nothing about the
  // change: never "fails on main too", always "cannot verify".
  const missing = [head, base].flatMap((result) => (result?.report?.events ?? []).filter((event) => event.type === 'fail' && event.missing_dependency))
    .map((event) => `${event.missing_dependency} in ${event.file ?? '<run>'}`);
  if (missing.length) return { verdict: 'unknown', detail: `a dependency is missing (${[...new Set(missing)].slice(0, 3).join('; ')}): cannot verify` };
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
// main's results are computed once per result (a lock named after it: runs that
// need the same one wait and read it) in main's shared worktree, which one
// computation uses at a time. Lock order: results, then worktree, then dependencies.
function mainResults(selector, id, { root, main, home, logFile, env, freshBase, run = null, log = console.log }) {
  const cache = mainResultsFile(home, { main, id, python: pythonVersion(),
    dependencies: NEEDS_APP_DEPENDENCIES.has(id) ? dependencyKeyAt(root, main) : null });
  const cached = freshBase ? null : readCached(cache);
  if (cached) return cached;
  return withLock(home, `main-${path.basename(cache, '.json')}`, () => {
    const meanwhile = freshBase ? null : readCached(cache); // another run computed it while this one waited
    if (meanwhile) return meanwhile;
    return withLock(home, worktreeLock(worktreePath(root, main, home)), () => {
      const dir = worktree(root, main, home);
      if (NEEDS_APP_DEPENDENCIES.has(id)) ensureAppDependencies(dir, home, { rebuild: id === 'production-schema', run });
      const results = runCommands(selector, id, dir, main, logFile, { env });
      writeCached(cache, results);
      return results;
    }, { what: `the worktree of main ${main.slice(0, 12)}`, log });
  }, { what: `main's results for ${id}`, log });
}

const platformName = () => (process.platform === 'win32' ? 'windows' : 'linux');

// The change is verified in a worktree of its own, removed afterwards: other runs
// of the same commit, or of main, never share it.
function verifyHere({ root, home, selector, main, candidate, suites, logs, freshBase, run, yieldTo }) {
  const platform = platformName();
  if (process.version !== `v${CI_NODE}`) console.log(`local-verify: ${platform}: Node ${process.version} here, CI uses v${CI_NODE}`);
  try {
    pruneWorktrees(root, home);
  } catch { /* housekeeping: not the run's business */ }
  const dir = worktree(root, candidate, home, { owner: run.run.id });
  // a temporary directory of its own: runs side by side must not see each other's (some tests list it)
  const temp = path.join(home, 't', run.run.id);
  fs.mkdirSync(temp, { recursive: true });
  run.update({ worktrees: [...run.run.worktrees, dir] });
  try {
    return verifySuites({ root, home, selector, main, dir, suites, logs, freshBase, run, platform, temp, yieldTo });
  } finally {
    try {
      dropWorktree(root, dir, home);
    } catch { /* the next run's prune takes it */ }
    try {
      killUnder(temp); // an embedded PostgreSQL a test left holds files there
      fs.rmSync(temp, { recursive: true, force: true });
    } catch { /* the next run's prune takes it: a failure here must not replace the verdicts */ }
  }
}

// yieldTo: yieldToResident, or null (--no-yield).
export function verifySuites({ root, home, selector, main, dir, suites, logs, freshBase, run, platform, temp, yieldTo }) {
  const env = testEnvironment(process.env, { CI_BASE_SHA: main, TEMP: temp, TMP: temp, TMPDIR: temp });
  const knownLists = selector.readKnownFailures();
  const results = [];
  let yieldLeft = YIELD_TIMEOUT_MS;
  for (const id of suites) {
    const log = path.join(logs, `${platform}-${id}.log`);
    console.log(`local-verify: ${platform}: ${id} ...`);
    let outcome;
    try {
      if (yieldTo) yieldLeft -= yieldTo(`${platform}: ${id}`, { timeoutMs: Math.max(0, yieldLeft), keepAlive: () => { run.touch(); refreshUmbrella(home, run); } });
      run.touch();
      refreshUmbrella(home, run);
      cleanWorktree(dir);
      if (NEEDS_APP_DEPENDENCIES.has(id)) ensureAppDependencies(dir, home, { rebuild: id === 'production-schema', run });
      const head = runCommands(selector, id, dir, main, log, { env });
      outcome = compareSuite(head, null, { selector, knownLists });
      if (outcome.verdict !== 'pass') {
        console.log(`local-verify: ${platform}: ${id} failed; running it on main ${main.slice(0, 12)} to compare`);
        const theirs = mainResults(selector, id, { root, main, home, logFile: path.join(logs, `${platform}-${id}.main.log`), env, freshBase, run });
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
// have it) against that clone. Runs at the same time share the clone: they take
// turns (flock) while they change its refs, and each uses refs of its own.
export function linuxScript({ bundle, refs, tool, run, candidate, main, suites, freshBase = false, noYield = false }) {
  return [
    'set -e',
    `repo="$HOME/${LINUX_HOME}/repo"`,
    'mkdir -p "$repo"',
    // whatever happens, this run's refs go and its temporary directory; set first
    `trap 'rm -rf "\${tool:-/nonexistent-local-verify}"; git -C "$repo" for-each-ref --format="delete %(refname)" refs/local-verify/${run}/ ${INCOMING}${run}/ 2>/dev/null | git -C "$repo" update-ref --stdin 2>/dev/null' EXIT`,
    `exec 9>"$HOME/${LINUX_HOME}/repo.lock"; flock -w 900 9`,
    '[ -d "$repo/.git" ] || git init -q "$repo"',
    `git -C "$repo" remote get-url origin >/dev/null 2>&1 || git -C "$repo" remote add origin https://github.com/${REPOSITORY}.git`,
    // refs of runs that stopped without their clean-up (the time is in the name, a day is far longer than a run)
    "now=$(date +%s)000; for ref in $(git -C \"$repo\" for-each-ref --format='%(refname)' refs/local-verify/); do case $ref in refs/local-verify/run-*-*/*) t=${ref#refs/local-verify/run-*-}; t=${t%%/*}; [ $((now - t)) -gt 86400000 ] && echo \"delete $ref\" || true;; esac; done | git -C \"$repo\" update-ref --stdin",
    ...(bundle ? [
      `git -C "$repo" bundle verify -q ${quote(bundle)} >/dev/null`,
      // every ref the bundle carries, so all its objects are kept (a fetch keeps
      // only what the refs it takes reach); dropped once the real refs are set
      `git -C "$repo" fetch -q --no-tags ${quote(bundle)} '+refs/*:${INCOMING}${run}/*'`,
    ] : []),
    // the clone may be ahead of this run's view of GitHub (another run fetched later): a ref moves only forward
    'while read -r op ref sha; do',
    '  if [ "$op" = update ]; then cur=$(git -C "$repo" rev-parse -q --verify "$ref^{commit}" 2>/dev/null || true); if [ -n "$cur" ] && [ "$cur" != "$sha" ] && git -C "$repo" merge-base --is-ancestor "$sha" "$cur" 2>/dev/null; then continue; fi; fi',
    '  if [ -n "$sha" ]; then echo "$op $ref $sha"; else echo "$op $ref"; fi',
    `done < ${quote(refs)} | git -C "$repo" update-ref --stdin`,
    `for commit in ${candidate} ${main}; do git -C "$repo" cat-file -e "$commit^{commit}" || { echo "local-verify: $commit is not in the clone" >&2; exit 3; }; done`,
    `git -C "$repo" update-ref refs/local-verify/${run}/candidate ${candidate}`,
    `git -C "$repo" update-ref refs/local-verify/${run}/base ${main}`,
    `git -C "$repo" for-each-ref --format='delete %(refname)' ${INCOMING}${run}/ | git -C "$repo" update-ref --stdin`,
    'flock -u 9; exec 9>&-',
    'tool=$(mktemp -d)',
    `cp ${quote(tool)} "$tool/local-verify.mjs"`,
    'cd "$repo"',
    `node "$tool/local-verify.mjs" --candidate ${candidate} --base ${main} --no-fetch${freshBase ? ' --fresh-base' : ''}${noYield ? ' --no-yield' : ''}${suites.map((id) => ` --suite ${quote(id)}`).join('')}`,
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
// Refs a Windows run set in this repository for its bundle and a stopped process did not remove: of a process
// that is gone, or older than a day (the name has the time).
export function sweepRunRefs(root, { alive = processAlive, now = Date.now } = {}) {
  const listed = git(['for-each-ref', '--format=%(refname)', 'refs/local-verify/'], { cwd: root, allowFail: true });
  if (listed.status !== 0) return;
  for (const ref of String(listed.stdout).split('\n')) {
    const match = /^refs\/local-verify\/run-(\d+)(?:-(\d+))?\//.exec(ref);
    if (!match) continue;
    const old = match[2] !== undefined && now() - Number(match[2]) > 86_400_000;
    if (old || !alive(Number(match[1]))) git(['update-ref', '-d', ref], { cwd: root, allowFail: true });
  }
}
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

function startLinuxRun({ root, home, candidate, main, suites, logs, freshBase, noYield = false, distribution = DISTRIBUTION }) {
  const names = wsl(['--list', '--quiet']);
  if (!String(names.stdout ?? '').split(/\r?\n/).map((name) => name.replace(/\0/g, '').trim()).includes(distribution)) {
    throw new Error(`${distribution} is not installed; run scripts/ci/setup-clued-dev-linux.ps1`);
  }
  const run = `run-${process.pid}-${Date.now()}`; // the time lets a clean-up tell an old run's refs
  const clone = linuxRefs(root, distribution);
  const bundle = bundleFor(root, { run, candidate, main, has: clone.has, file: path.join(home, 'bundles', `${run}.bundle`) });
  const refsFile = path.join(home, 'bundles', `${run}.refs`);
  fs.mkdirSync(path.dirname(refsFile), { recursive: true });
  fs.writeFileSync(refsFile, refUpdates(githubRefs(root), clone.refs));
  const toolFile = path.join(home, 'bundles', `${run}.local-verify.mjs`);
  fs.copyFileSync(fileURLToPath(import.meta.url), toolFile);
  const logFile = path.join(logs, 'linux.log');
  const fd = fs.openSync(logFile, 'w');
  console.log(`local-verify: linux: running in ${distribution} (log ${logFile}; it may wait there for a place, the log says so)`);
  const script = linuxScript({ bundle: bundle && toWslPath(bundle), refs: toWslPath(refsFile), tool: toWslPath(toolFile), run, candidate, main,
    suites, freshBase, noYield });
  const child = spawnAsync('wsl.exe', ['-d', distribution, '--cd', '~', '--exec', '/bin/bash', '-lc', script],
    { stdio: ['ignore', fd, fd], windowsHide: true });
  // the Linux side may also wait for the resident (yieldToResident), at most YIELD_TIMEOUT_MS in all
  const timer = setTimeout(() => child.kill(), LINUX_TIMEOUT_MS + (noYield ? 0 : YIELD_TIMEOUT_MS));
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
  options.linux = runsLinux(options);
  if (options.affected && !options.linux) console.log('local-verify: --affected: this host has no CluedDev-Linux side to add; this side only');
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
  // other runs may be working: wait for a place (printing the position), never for
  // the whole cache
  const run = beginRun(home, { label: options.candidate ? `linux ${options.candidate.slice(0, 12)}` : '' });
  try {
    admitRun(home, run);
    return await verifyChange({ options, root, home, change, run });
  } finally {
    leaveUmbrella(home, run);
    run.end();
  }
}

async function verifyChange({ options, root, home, change, run }) {
  // refs earlier versions of this file left in the user's repository (in the
  // Linux clone, candidate and base are the ones linuxScript just set)
  if (!options.candidate) {
    for (const ref of ['refs/local-verify/github-main', 'refs/local-verify/candidate', 'refs/local-verify/base']) {
      git(['update-ref', '-d', ref], { cwd: root, allowFail: true });
    }
    sweepRunRefs(root);
  }
  // a Linux hand-over reads the refs fetched here
  const mainCommit = resolveMain(root, options, home);
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
  // bundles of runs that are gone (another run's are in use)
  if (fs.existsSync(path.join(home, 'bundles'))) {
    for (const name of fs.readdirSync(path.join(home, 'bundles'))) {
      const owner = /^run-(\d+)[-.]/.exec(name)?.[1];
      if (owner === undefined || !processAlive(Number(owner))) fs.rmSync(path.join(home, 'bundles', name), { force: true });
    }
  }
  const selector = await loadSelector(root, mainCommit, home);
  if (!suites.length && change) {
    const chosen = chooseSuites(root, change.commit, mainCommit, selector);
    suites = chosen.suites;
    console.log(`local-verify: ${chosen.files === null ? 'more files than GitHub lists' : `${chosen.files.length} changed file(s)`}`);
    for (const line of chosen.lines) console.log(`  ${line}`);
    console.log(`local-verify: suites: ${suites.join(', ') || 'none'}`);
    if (!suites.length) console.log('local-verify: nothing to verify: no changed file selects a suite');
  }
  for (const id of suites) if (!selector.SUITE_COMMANDS[id]) throw new Error(`unknown suite: ${id}`);
  const logs = path.join(home, 'logs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${candidate.slice(0, 12)}-${run.run.id}`);
  fs.mkdirSync(logs, { recursive: true });
  const linux = options.linux && suites.length
    ? startLinux({ root, home, candidate, main: mainCommit, suites, logs, freshBase: options.freshBase, noYield: !options.yield })
    : null;
  const results = options.here ? verifyHere({ root, home, selector, main: mainCommit, candidate, suites, logs, freshBase: options.freshBase, run,
    yieldTo: options.yield ? yieldToResident : null }) : [];
  if (linux) results.push(...await linux);
  console.log('\nlocal-verify summary');
  for (const result of results) {
    console.log(`  ${result.platform.padEnd(8)} ${result.suite.padEnd(22)} ${VERDICT_LABEL[result.verdict]}${result.detail ? `: ${result.detail}` : ''}`);
    if (result.verdict !== 'pass') console.log(`  ${''.padEnd(31)} log: ${result.log}`);
  }
  console.log(`${RESULT_MARK}${JSON.stringify(results)}`);
  return results.some((result) => result.verdict === 'new' || result.verdict === 'unknown') ? 1 : 0;
}

// import.meta.main exists from Node 22.18; on an older Node it is undefined, and a
// guard that read that as "not the entry point" would exit 0 having done nothing.
if (import.meta.main ?? (process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)))) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`local-verify: ${error.message}`);
    process.exitCode = 2;
  }
}
