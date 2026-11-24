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
async function run(t, { argv = [BACKUP_TEST], fail = {}, images = [true, false], pulls = 0, platform = 'linux', steps } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'real-database-test-'));
  const work = mkdtempSync(path.join(os.tmpdir(), 'real-database-work-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  mkdirSync(path.join(root, path.dirname(CONFIG)), { recursive: true });
  writeFileSync(path.join(root, CONFIG), SOURCE);
  const calls = [];
  const lines = [];
  const summaries = [];
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
    summary: (text) => summaries.push(text),
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
  const code = await realDatabase({ argv, env: { PATH: '/usr/bin', HOME: '/home/runner' }, cwd: path.join(root, 'apps/clued-cloud'),
    runtime, ...(steps ? { steps } : {}) });
  const order = calls.map(({ step: name }) => name);
  return { code, calls, order, lines, out: lines.join('\n'), summary: summaries.join(''), root, config: readFileSync(path.join(root, CONFIG), 'utf8') };
}

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
  assert.match(result.out, /^::error title=real database::real_database: lint failed \(exit 1\)$/m);
  assert.ok(result.order.includes('pgtap') && result.order.includes('backup'));
  assert.equal(result.order.at(-1), 'cleanup');
});

test('--observe: the same failure is a warning and a summary line, and the run exits 0', async (t) => {
  const result = await run(t, { argv: ['--observe', BACKUP_TEST], fail: { lint: 1 } });
  assert.equal(result.code, 0);
  assert.match(result.out, /^::warning title=real database \(observe\)::real_database: lint failed \(exit 1\)$/m);
  assert.doesNotMatch(result.out, /::error/);
  assert.match(result.summary, /real database \(observe\): failed/);
  assert.match(result.summary, /- lint: ran, exit 1/);
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
  assert.match(observed.out, /^::warning title=real database \(observe\)::real_database: lint did not run$/m);
});

test('no Docker: an infrastructure failure, nothing started, nothing to clean', async (t) => {
  const result = await run(t, { fail: { docker: 1 } });
  assert.equal(result.code, 1);
  assert.match(result.out, new RegExp(`::error title=real database::${INFRASTRUCTURE} `));
  assert.deepEqual(result.order, ['docker']);
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

test('after any failure past prepare, --cleanup still runs and the config is restored', async (t) => {
  for (const failing of ['start', 'verify', 'lint', 'pgtap', 'backup']) {
    const result = await run(t, { fail: { [failing]: 1 } });
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
