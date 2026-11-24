// The real database checks of the required migration-verify (PLAN-g4-red-merged-20261125 §2.2, Task 4432ee9b): the three
// checks only clued-g4-database.yml ran, on one isolated Supabase database, as the last command of production-schema
// (ci-required-selection.mjs). It runs from apps/clued-cloud:
//
//   node ../../scripts/ci/clued-real-database.mjs [--observe] <backup test files...>
//
// 1. Starts the database as clued-g4-fresh-start.mjs isolates it: the host's start lock (FD 9 of prepare, start and verify),
//    --prepare, `supabase db start` (the database alone, not the whole local stack), --verify, which applies the migration
//    chain through clued-local-migrate.mjs as production does. The database alone is a hard prerequisite (ruling 11-25 B2):
//    should it not pass, the plan goes back to planning; the start is not widened to the whole local stack.
// 2. The checks, each printing one line "real-database: <check> ran: ..." once it has run: plpgsql_check lint and the
//    pgTAP files, as clued-g4-database.yml runs them (Supabase CLI 2.115.0), and the PostgreSQL 17 backup coverage test
//    (the files named on the command line) on the same image digest.
// 3. --cleanup, whatever failed, and the checkout's config.toml restored. On a GitHub-hosted runner (RUNNER_ENVIRONMENT
//    exactly github-hosted, which test-env.mjs passes) neither: the machine is thrown away after the job (p90 §3.6). Any
//    other value, or none, cleans: slower at worst, nothing left on a self-hosted node.
//
// Nothing that did not run passes: before it exits, the run checks that all three checks said they ran, and fails when
// one did not, whatever else passed. A failure of the host (no Docker, the image not pulled after 3 attempts, the start
// lock not taken, the stack not started, cleanup) starts with real_database_infrastructure:, a failing check without.
// --observe (the first merge, §2.2 step 4): everything runs and is reported the same, the failures as one ::warning instead
// of one ::error, and the run exits 0. Every run, passed or failed, observed or not, gives one ::notice with each check's
// exit status, the seconds of the start, the checks, the cleanup and the run, and the runner kind (ruling 11-25 #4): what
// the observation reads, from a green job too. There is no step summary, as the selector never passes its variable.
//
// Under the selector a suite command gets only the variables test-env.mjs passes (no GITHUB_RUN_ID, GITHUB_SHA or
// RUNNER_TEMP), so this run gives clued-g4-fresh-start.mjs an identity of its own: a random run number (the project
// clued-g4-<n>-1 and its port block), the checkout's HEAD and a temporary directory for its marker.
import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INFRASTRUCTURE = 'real_database_infrastructure:';
const FAILURE = 'real_database:';
export const CHECKS = Object.freeze(['lint', 'pgtap', 'backup']);
// The commands of clued-g4-database.yml, word for word, but the start: the database alone.
export const START = 'supabase db start';
export const LINT = 'supabase db lint --local --schema public,clued_private --level error --fail-on error';
export const PGTAP = 'supabase test db supabase/tests/m1_runtime_contracts.test.sql supabase/tests/m1_legacy_mapping.test.sql --local';
// The PostgreSQL 17 image of clued-g4-database.yml's backup step: one digest, from Docker Hub or its ECR mirror.
const DIGEST = 'sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929';
export const BACKUP_IMAGES = Object.freeze([`postgres@${DIGEST}`, `public.ecr.aws/docker/library/postgres@${DIGEST}`]);
export const PULL_ATTEMPTS = 3;
const LOCK_SECONDS = 300;
const SOCKET = 'unix:///var/run/docker.sock';
const CONFIG = 'apps/clued-cloud/supabase/config.toml';
const FRESH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clued-g4-fresh-start.mjs');

const supabase = (command, env) => ['npx', '--yes', ...(env.HOME ? ['--cache', path.join(env.HOME, '.npm')] : []), '--prefer-offline',
  '--fetch-retries=5', '--package=supabase@2.115.0', '--package=@supabase/cli-linux-x64@2.115.0', ...command.split(' ')];

// The checks, in order. Each returns the exit status of what it ran, or null when it could not run (and says why).
export const CHECK_STEPS = Object.freeze([
  { id: 'lint', run: ({ exec, env }) => exec(supabase(LINT, env)) },
  { id: 'pgtap', run: ({ exec, env }) => exec(supabase(PGTAP, env)) },
  { id: 'backup', run: ({ exec, runtime, env, cwd, tests, infrastructure }) => {
    if (tests.length === 0) return null;
    const image = backupImage(runtime, { cwd, env }, infrastructure);
    if (!image) return null;
    return exec(['node', 'scripts/run-tests.mjs', '--test', ...tests], { CLUED_BACKUP_TEST_IMAGE: image });
  } },
]);

// The image by its digest: a cached copy first, then up to PULL_ATTEMPTS pulls (each Docker Hub, then the mirror).
function backupImage(runtime, options, infrastructure) {
  for (const image of BACKUP_IMAGES) {
    if (runtime.capture(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], options).status === 0) return image;
  }
  for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt += 1) {
    for (const image of BACKUP_IMAGES) {
      if (runtime.run(['docker', 'pull', image], options).status === 0) return image;
    }
  }
  infrastructure(`the PostgreSQL 17 image ${DIGEST} was not pulled in ${PULL_ATTEMPTS} attempts`);
  return null;
}

const lockStdio = (fd) => ['ignore', 'inherit', 'inherit', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', fd];
export const defaultRuntime = () => ({
  platform: process.platform,
  capture: (argv, { cwd, env }) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
  },
  run: (argv, { cwd, env, lock }) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, env, stdio: lock === undefined ? ['ignore', 'inherit', 'inherit'] : lockStdio(lock) });
    if (result.error) console.log(`real-database: ${argv[0]} did not start: ${result.error.message}`);
    return { status: result.error ? null : result.status };
  },
  openLock: (file) => openSync(file, 'a', 0o600),
  closeLock: (fd) => closeSync(fd),
  tempDir: () => mkdtempSync(path.join(os.tmpdir(), 'clued-real-database-')),
  runId: () => randomInt(1, 2 ** 31),
  log: (line) => console.log(line),
  now: () => performance.now(),
});

const exitText = (status) => (status === null ? 'did not start' : `exit ${status}`);

export async function realDatabase({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), runtime: given = {},
  steps = CHECK_STEPS } = {}) {
  const runtime = { ...defaultRuntime(), ...given };
  const unknown = argv.filter((arg) => arg.startsWith('-') && arg !== '--observe');
  if (unknown.length > 0) {
    runtime.log(`real-database: unknown switch ${unknown.join(' ')}; usage: clued-real-database.mjs [--observe] <backup test files...>`);
    return 2;
  }
  const observe = argv.includes('--observe');
  const tests = argv.filter((arg) => !arg.startsWith('-'));
  const failures = [];
  const infrastructure = (message) => failures.push(`${INFRASTRUCTURE} ${message}`);
  const ran = new Map();
  const started = runtime.now();
  const seconds = (from, to = runtime.now()) => ((to - from) / 1000).toFixed(1);
  const hosted = env.RUNNER_ENVIRONMENT === 'github-hosted';
  // When the start (prepare to verify) and the checks began and ended: the notice's seconds.
  const at = { start: null, started: null, checks: null, checked: null };
  let cleanupSeconds = 'none';
  let lock;
  let config = null;
  let marker = null;
  let root = null;
  let work = null;
  let child = null;
  let keep = false;
  // Each early return ends the run here; the cleanup and the verdict below come after it whatever happened.
  const startAndCheck = () => {
    if (runtime.platform !== 'linux') {
      infrastructure(`runs on Linux with the local Docker daemon only (this host: ${runtime.platform})`);
      return;
    }
    const git = (...args) => runtime.capture(['git', ...args], { cwd, env });
    const top = git('rev-parse', '--show-toplevel');
    const head = git('rev-parse', 'HEAD');
    if (top.status !== 0 || head.status !== 0) {
      infrastructure('the checkout is not a Git work tree');
      return;
    }
    root = top.stdout.trim();
    const id = runtime.runId();
    work = runtime.tempDir();
    child = { ...env, GITHUB_RUN_ID: String(id), GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head.stdout.trim(),
      GITHUB_REPOSITORY: 'clued/real-database', RUNNER_TEMP: work, GITHUB_ENV: path.join(work, 'github-env'),
      CLUED_G4_FRESH_PROJECT: `clued-g4-${id}-1`, DOCKER_HOST: SOCKET, DOCKER_CONTEXT: 'default', CLUED_G4_START_LOCK_FD: '9' };
    const options = { cwd, env: child };
    const exec = (argv, extra = {}, more = {}) => runtime.run(argv, { cwd, env: { ...child, ...extra }, ...more }).status;
    const fresh = (mode) => exec(['node', FRESH, mode], {}, { lock });

    const docker = runtime.capture(['docker', '--host', SOCKET, 'info', '--format', '{{json .ID}}'], options);
    if (docker.status !== 0) {
      infrastructure(`Docker is not available on ${SOCKET} (docker info ${exitText(docker.status)})`);
      return;
    }
    const lockPath = runtime.capture(['node', FRESH, '--lock-path'], options);
    if (lockPath.status !== 0 || !lockPath.stdout.trim()) {
      infrastructure(`clued-g4-fresh-start.mjs --lock-path ${exitText(lockPath.status)}`);
      return;
    }
    lock = runtime.openLock(lockPath.stdout.trim());
    const flock = runtime.run(['flock', '--exclusive', '--timeout', String(LOCK_SECONDS), '9'], { ...options, lock });
    if (flock.status !== 0) {
      infrastructure(`the Docker start lock was not taken in ${LOCK_SECONDS} s (flock ${exitText(flock.status)})`);
      return;
    }
    config = readFileSync(path.join(root, CONFIG), 'utf8');
    marker = path.join(work, `clued-g4-fresh-${id}-1.json`);
    let from = runtime.now();
    at.start = from;
    const prepare = fresh('--prepare');
    if (prepare !== 0) {
      infrastructure(`clued-g4-fresh-start.mjs --prepare ${exitText(prepare)}`);
      return;
    }
    const start = exec(supabase(START, child), {}, { lock });
    if (start !== 0) {
      infrastructure(`${START} ${exitText(start)}`);
      return;
    }
    runtime.log(`real-database: database started in ${seconds(from)} s`);
    from = runtime.now();
    const verify = fresh('--verify');
    at.started = runtime.now();
    if (verify !== 0) {
      failures.push(`${FAILURE} the migration chain did not apply on the real database (clued-g4-fresh-start.mjs --verify ${exitText(verify)})`);
      return;
    }
    runtime.log(`real-database: migration chain applied and verified in ${seconds(from)} s`);
    runtime.closeLock(lock);
    lock = undefined;
    at.checks = runtime.now();
    for (const step of steps) {
      from = runtime.now();
      const status = step.run({ exec, runtime, env: child, cwd, tests, infrastructure });
      if (status === null || status === undefined) continue;
      ran.set(step.id, status);
      runtime.log(`real-database: ${step.id} ran: ${exitText(status)} (${seconds(from)} s)`);
      if (status !== 0) failures.push(`${FAILURE} ${step.id} failed (${exitText(status)})`);
    }
    at.checked = runtime.now();
  };
  try {
    startAndCheck();
  } catch (error) {
    infrastructure(`the run stopped: ${error.message}`);
  } finally {
    const stopped = runtime.now();
    at.started ??= at.start === null ? null : stopped;
    at.checked ??= at.checks === null ? null : stopped;
    if (lock !== undefined) runtime.closeLock(lock);
    if (marker && existsSync(marker) && hosted) {
      cleanupSeconds = 'skipped';
      runtime.log('real-database: a GitHub-hosted runner, thrown away after the job: no cleanup');
    } else if (marker && existsSync(marker)) {
      const from = runtime.now();
      const cleanup = runtime.run(['node', FRESH, '--cleanup'], { cwd, env: child });
      cleanupSeconds = seconds(from);
      if (cleanup.status === 0) runtime.log(`real-database: cleaned up in ${cleanupSeconds} s`);
      else {
        keep = true;
        infrastructure(`clued-g4-fresh-start.mjs --cleanup ${exitText(cleanup.status)}; what is left is in ${marker}`);
      }
    }
    if (config !== null && !hosted) writeFileSync(path.join(root, CONFIG), config);
    // The marker of a failed cleanup says what is left; otherwise nothing of this run stays behind.
    if (work && !keep) rmSync(work, { recursive: true, force: true });
  }
  const span = (from, to) => (from === null ? 'none' : seconds(from, to));
  const times = { start: span(at.start, at.started), checks: span(at.checks, at.checked), cleanup: cleanupSeconds,
    total: seconds(started) };
  return verdict({ ran, failures, observe, runtime, times, runner: hosted ? 'github-hosted' : 'self-hosted' });
}

// An annotation's message is one line: the workflow command escapes (%, CR, LF).
const message = (text) => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

// The one verdict: the failures, and each of CHECKS that did not say it ran. Always one notice; the problems, if any, in
// one warning (observed) or error, so a step shows them all (at most 10 of each kind are shown).
function verdict({ ran, failures, observe, runtime, times, runner }) {
  const problems = [...failures, ...CHECKS.filter((check) => !ran.has(check)).map((check) => `${FAILURE} ${check} did not run`)];
  const statuses = CHECKS.map((check) => `${check}=${ran.has(check) ? ran.get(check) : 'none'}`).join(' ');
  runtime.log(`::notice title=real database::${statuses} start=${times.start} checks=${times.checks} ` +
    `cleanup=${times.cleanup} total=${times.total} runner=${runner}`);
  if (problems.length > 0) {
    const title = observe ? 'real database (observe)' : 'real database';
    runtime.log(`::${observe ? 'warning' : 'error'} title=${title}::${message(problems.join('; '))}`);
  }
  return problems.length === 0 || observe ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const code = await realDatabase();
  process.exitCode = Number.isInteger(code) ? code : 1;
}
