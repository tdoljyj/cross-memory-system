// The real database command of production-schema (PLAN-g4-red-merged-20261125 §2.2, §4 T2; Task 4432ee9b), with its
// command boundaries replaced: Docker, flock, the Supabase CLI, clued-g4-fresh-start.mjs and the backup test answer
// from a table, as clued-g4-fresh-start.test.mjs replaces docker. What it guards: nothing that did not run counts as
// passed, an infrastructure failure is told apart, and the database is cleaned up whatever failed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BACKUP_IMAGES, CHECKS, CHECK_STEPS, INFRASTRUCTURE, LINT, PGTAP, START, realDatabase } from './clued-real-database.mjs';

const CONFIG = 'apps/clued-cloud/supabase/config.toml';
const SOURCE = 'project_id = "clued-cloud"\n';
const BACKUP_TEST = 'tests/production-backup-scope-db.test.mjs';

// One run against fakes. fail: step -> exit status; images: which of BACKUP_IMAGES are present; pulls: how many pulls
// fail before one succeeds (Infinity: all).
async function run(t, { argv = [BACKUP_TEST], fail = {}, images = [true, false], pulls = 0, platform = 'linux', steps, env = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'real-database-test-'));
  const work = mkdtempSync(path.join(os.tmpdir(), 'real-database-work-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  mkdirSync(path.join(root, path.dirname(CONFIG)), { recursive: true });
  writeFileSync(path.join(root, CONFIG), SOURCE);
  const calls = [];
  const lines = [];
  let pulled = 0;
  const step = (argv) => {
    const text = argv.join(' ');
    if (argv[0] === 'flock') return 'flock';
    if (/clued-g4-fresh-start\.mjs$/.test(argv[1] ?? '')) return argv[2].slice(2);
    if (text.endsWith(START)) return 'start';
    if (text.endsWith(LINT)) return 'lint';
    if (text.endsWith(PGTAP)) return 'pgtap';
    if (argv[0] === 'docker' && argv.includes('pull')) return 'pull';
    if (argv[0] === 'docker' && argv.includes('image')) return 'image';
    if (argv[0] === 'docker' && argv.includes('info')) return 'docker';
    if (argv[1] === 'scripts/run-tests.mjs') return 'backup';
    throw new Error(`unexpected command: ${text}`);
  };
  const runtime = {
    platform,
    tempDir: () => work,
    runId: () => 4242,
    log: (line) => lines.push(line),
    openLock: (file) => { calls.push({ step: 'open', file }); return 99; },
    closeLock: (fd) => calls.push({ step: 'close', fd }),
    capture: (argv, options) => {
      if (argv[0] === 'git') return { status: 0, stdout: argv.includes('--show-toplevel') ? `${root}\n` : `${'a'.repeat(40)}\n` };
      const name = step(argv);
      calls.push({ step: name, argv, options });
      if (name === 'image') return { status: images[BACKUP_IMAGES.indexOf(argv.at(-1))] ? 0 : 1, stdout: '' };
      return { status: fail[name] ?? 0, stdout: name === 'lock-path' ? '/tmp/clued-g4-docker-x.lock\n' : '"daemon"\n' };
    },
    run: (argv, options) => {
      const name = step(argv);
      calls.push({ step: name, argv, options });
      if (name === 'pull') return { status: pulled++ < pulls ? 1 : 0 };
      if (name === 'prepare' && fail.prepare === undefined) {
        // As prepare does: the marker, then this run's ports in the checkout's config.
        writeFileSync(path.join(options.env.RUNNER_TEMP, `clued-g4-fresh-${options.env.GITHUB_RUN_ID}-1.json`), '{}\n');
        writeFileSync(path.join(root, CONFIG), 'project_id = "clued-g4-4242-1"\n');
      }
      return { status: fail[name] ?? 0 };
    },
  };
  const code = await realDatabase({ argv, env: { PATH: '/usr/bin', HOME: '/home/runner', ...env }, cwd: path.join(root, 'apps/clued-cloud'),
    runtime, ...(steps ? { steps } : {}) });
  const order = calls.map(({ step: name }) => name);
  const annotations = (kind) => lines.filter((line) => line.startsWith(`::${kind} `));
  return { code, calls, order, lines, out: lines.join('\n'), notices: annotations('notice'), warnings: annotations('warning'),
    errors: annotations('error'), root, config: readFileSync(path.join(root, CONFIG), 'utf8') };
}

// The one notice every run gives (ruling 11-25 #4): each check's exit status (none: it did not run), the seconds of the
// start, the checks, the cleanup (skipped on a GitHub-hosted runner, none when there was nothing to clean) and the run,
// and the runner kind.
const SECONDS = String.raw`\d+\.\d`;
const notice = ({ lint = '0', pgtap = '0', backup = '0', start = SECONDS, checks = SECONDS, cleanup = SECONDS, runner = 'self-hosted' } = {}) =>
  new RegExp(`^::notice title=real database::lint=${lint} pgtap=${pgtap} backup=${backup} start=${start} checks=${checks} ` +
    `cleanup=${cleanup} total=${SECONDS} runner=${runner}$`);

test('a passing run: lock, prepare, start, verify, the three checks each say they ran, cleanup; exit 0', async (t) => {
  const result = await run(t);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(result.order, ['docker', 'lock-path', 'open', 'flock', 'prepare', 'start', 'verify', 'close',
    'lint', 'pgtap', 'image', 'backup', 'cleanup']);
  for (const check of CHECKS) assert.match(result.out, new RegExp(`^real-database: ${check} ran: exit 0`, 'm'), check);
  // The start lock (FD 9 of prepare, start and verify) is the open file description flock took.
  for (const call of result.calls.filter(({ step }) => ['flock', 'prepare', 'start', 'verify'].includes(step))) {
    assert.equal(call.options.lock, 99, call.step);
  }
  const prepare = result.calls.find(({ step }) => step === 'prepare');
  assert.equal(prepare.options.env.CLUED_G4_START_LOCK_FD, '9');
  assert.equal(prepare.options.env.GITHUB_SHA, 'a'.repeat(40));
  assert.equal(prepare.options.env.CLUED_G4_FRESH_PROJECT, 'clued-g4-4242-1');
  const backup = result.calls.find(({ step }) => step === 'backup');
  assert.equal(backup.options.env.CLUED_BACKUP_TEST_IMAGE, BACKUP_IMAGES[0]);
  assert.deepEqual(backup.argv.slice(-2), ['--test', BACKUP_TEST]);
  assert.equal(result.config, SOURCE, 'the checkout config is restored');
  assert.doesNotMatch(result.out, /::(?:error|warning)/);
  assert.equal(result.notices.length, 1, result.out);
  assert.match(result.notices[0], notice());
});

test('the commands are the Supabase CLI 2.115.0 ones of clued-g4-database.yml, the database started alone', async (t) => {
  const result = await run(t);
  const lint = result.calls.find(({ step }) => step === 'lint').argv;
  assert.deepEqual(lint.slice(0, 2), ['npx', '--yes']);
  assert.ok(lint.includes('--package=supabase@2.115.0') && lint.includes('--package=@supabase/cli-linux-x64@2.115.0'));
  assert.equal(START, 'supabase db start');
  assert.equal(LINT, 'supabase db lint --local --schema public,clued_private --level error --fail-on error');
  assert.equal(PGTAP, 'supabase test db supabase/tests/m1_runtime_contracts.test.sql supabase/tests/m1_legacy_mapping.test.sql --local');
});

test('a failing lint fails the run; the other checks still run and the database is cleaned up', async (t) => {
  const result = await run(t, { fail: { lint: 1 } });
  assert.equal(result.code, 1);
  assert.match(result.out, /^real-database: lint ran: exit 1/m);
  assert.equal(result.errors.length, 1, result.out);
  assert.match(result.errors[0], /^::error title=real database::real_database: lint failed \(exit 1\)$/);
  assert.equal(result.notices.length, 1, result.out);
  assert.match(result.notices[0], notice({ lint: '1' }));
  assert.ok(result.order.includes('pgtap') && result.order.includes('backup'));
  assert.equal(result.order.at(-1), 'cleanup');
});

test('--observe: the same failure is one warning beside the one notice, and the run exits 0', async (t) => {
  const result = await run(t, { argv: ['--observe', BACKUP_TEST], fail: { lint: 1, backup: 3 } });
  assert.equal(result.code, 0);
  // All the problems in one warning: a step shows at most 10 of each kind, this run gives 2 annotations.
  assert.equal(result.warnings.length, 1, result.out);
  assert.match(result.warnings[0], /^::warning title=real database \(observe\)::real_database: lint failed \(exit 1\); real_database: backup failed \(exit 3\)$/);
  assert.equal(result.errors.length, 0, result.out);
  assert.equal(result.notices.length, 1, result.out);
  assert.match(result.notices[0], notice({ lint: '1', backup: '3' }));
  // A passing observed run: the notice only.
  const passed = await run(t, { argv: ['--observe', BACKUP_TEST] });
  assert.deepEqual([passed.notices.length, passed.warnings.length, passed.errors.length], [1, 0, 0], passed.out);
});

test('a check that did not run fails the run, whatever else passed: nothing that did not run counts', async (t) => {
  const result = await run(t, { steps: CHECK_STEPS.filter(({ id }) => id !== 'pgtap') });
  assert.equal(result.code, 1);
  assert.match(result.out, /real_database: pgtap did not run/);
  // Started and verified, then nothing: all three are missing.
  const none = await run(t, { steps: [] });
  assert.equal(none.code, 1);
  for (const check of CHECKS) assert.match(none.out, new RegExp(`real_database: ${check} did not run`));
  // No backup test named: the backup check did not run.
  const unnamed = await run(t, { argv: [] });
  assert.equal(unnamed.code, 1);
  assert.match(unnamed.out, /real_database: backup did not run/);
  // Observed, the same is said as a warning.
  const observed = await run(t, { argv: ['--observe'], steps: [] });
  assert.equal(observed.code, 0);
  assert.equal(observed.warnings.length, 1, observed.out);
  assert.match(observed.warnings[0], /^::warning title=real database \(observe\)::real_database: lint did not run; real_database: pgtap did not run; real_database: backup did not run$/);
  assert.match(observed.notices[0], notice({ lint: 'none', pgtap: 'none', backup: 'none' }));
});

test('no Docker: an infrastructure failure, nothing started, nothing to clean', async (t) => {
  const result = await run(t, { fail: { docker: 1 } });
  assert.equal(result.code, 1);
  assert.match(result.out, new RegExp(`::error title=real database::${INFRASTRUCTURE} `));
  assert.deepEqual(result.order, ['docker']);
  assert.equal(result.notices.length, 1, result.out);
  assert.match(result.notices[0], notice({ lint: 'none', pgtap: 'none', backup: 'none', start: 'none', checks: 'none', cleanup: 'none' }));
  const windows = await run(t, { platform: 'win32' });
  assert.equal(windows.code, 1);
  assert.match(windows.out, new RegExp(INFRASTRUCTURE));
  assert.deepEqual(windows.order, []);
});

test('the start lock not taken in time: an infrastructure failure before prepare', async (t) => {
  const result = await run(t, { fail: { flock: 1 } });
  assert.equal(result.code, 1);
  assert.match(result.out, new RegExp(`${INFRASTRUCTURE} .*lock`));
  assert.ok(!result.order.includes('prepare'));
  assert.ok(result.order.includes('close'));
});

test('the backup image pulled three times without success: an infrastructure failure; backup did not run; cleanup ran', async (t) => {
  const result = await run(t, { images: [false, false], pulls: Infinity });
  assert.equal(result.code, 1);
  assert.match(result.out, new RegExp(`${INFRASTRUCTURE} .*3 attempts`));
  assert.match(result.out, /real_database: backup did not run/);
  assert.equal(result.calls.filter(({ step, argv }) => step === 'pull' && argv.at(-1) === BACKUP_IMAGES[0]).length, 3);
  assert.ok(!result.order.includes('backup'));
  assert.equal(result.order.at(-1), 'cleanup');
  // A pull that fails once and then succeeds is no failure.
  const retried = await run(t, { images: [false, false], pulls: 1 });
  assert.equal(retried.code, 0, retried.out);
  // A cached fallback image is used without a pull.
  const fallback = await run(t, { images: [false, true] });
  assert.equal(fallback.code, 0);
  assert.ok(!fallback.order.includes('pull'));
  assert.equal(fallback.calls.find(({ step }) => step === 'backup').options.env.CLUED_BACKUP_TEST_IMAGE, BACKUP_IMAGES[1]);
});

test('on a self-hosted runner, after any failure past prepare, --cleanup still runs and the config is restored', async (t) => {
  for (const failing of ['start', 'verify', 'lint', 'pgtap', 'backup']) {
    const result = await run(t, { fail: { [failing]: 1 }, env: { RUNNER_ENVIRONMENT: 'self-hosted' } });
    assert.equal(result.code, 1, failing);
    assert.equal(result.order.at(-1), 'cleanup', failing);
    assert.equal(result.config, SOURCE, failing);
  }
  // A start that fails is infrastructure; a chain that does not apply is the change's own failure.
  assert.match((await run(t, { fail: { start: 1 } })).out, new RegExp(`${INFRASTRUCTURE} .*supabase db start`));
  const verify = await run(t, { fail: { verify: 1 } });
  assert.doesNotMatch(verify.out, new RegExp(INFRASTRUCTURE));
  assert.match(verify.out, /real_database: the migration chain did not apply/);
  // A prepare that failed before its marker leaves nothing to clean.
  const prepare = await run(t, { fail: { prepare: 1 } });
  assert.equal(prepare.code, 1);
  assert.ok(!prepare.order.includes('cleanup'));
});

test('a cleanup that fails fails the run as infrastructure', async (t) => {
  const result = await run(t, { fail: { cleanup: 1 } });
  assert.equal(result.code, 1);
  assert.match(result.out, new RegExp(`${INFRASTRUCTURE} .*cleanup`));
  assert.ok(existsSync(result.root));
});

test('an unknown switch is refused before anything runs', async (t) => {
  const result = await run(t, { argv: ['--obsrve'] });
  assert.equal(result.code, 2);
  assert.deepEqual(result.order, []);
});

// p90 §3.6 (ruling 11-25 B1): a GitHub-hosted runner is thrown away after the job, so its database is not cleaned up nor
// its config restored. Only that exact value skips them: any other, or none (the selector did not pass it), cleans.
test('on a GitHub-hosted runner the run does not clean up, and says so; the three checks still say they ran', async (t) => {
  const hosted = { RUNNER_ENVIRONMENT: 'github-hosted' };
  const result = await run(t, { env: hosted });
  assert.equal(result.code, 0, result.out);
  assert.ok(!result.order.includes('cleanup'), result.order.join(' '));
  for (const check of CHECKS) assert.match(result.out, new RegExp(`^real-database: ${check} ran: exit 0`, 'm'), check);
  assert.equal(result.notices.length, 1, result.out);
  assert.match(result.notices[0], notice({ cleanup: 'skipped', runner: 'github-hosted' }));
  assert.equal(result.config, 'project_id = "clued-g4-4242-1"\n', 'the config of a hosted runner is left as prepare wrote it');
  // A failure on a hosted runner: still no cleanup.
  const failed = await run(t, { env: hosted, fail: { lint: 1 } });
  assert.equal(failed.code, 1);
  assert.ok(!failed.order.includes('cleanup'));
});

test('without RUNNER_ENVIRONMENT, or with any other value, the run cleans up as on a self-hosted runner', async (t) => {
  for (const env of [{}, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_ENVIRONMENT: 'GitHub-Hosted' }, { RUNNER_ENVIRONMENT: '' }]) {
    const result = await run(t, { env });
    assert.equal(result.code, 0, result.out);
    assert.equal(result.order.at(-1), 'cleanup', JSON.stringify(env));
    assert.equal(result.config, SOURCE, JSON.stringify(env));
    assert.match(result.notices[0], notice(), JSON.stringify(env));
  }
});

// Ruling 11-25 B2: the database started alone is a hard prerequisite. Should it not pass, the plan goes back to planning;
// the start command is not changed to the whole local stack.
test('the start is the database alone, and the script writes no step summary', () => {
  assert.equal(START, 'supabase db start');
  const source = readFileSync(new URL('./clued-real-database.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /'supabase start'/);
  assert.doesNotMatch(source, /GITHUB_STEP_SUMMARY|summary\s*[:(]/, 'no step summary: the selector never passes its variable');
});
