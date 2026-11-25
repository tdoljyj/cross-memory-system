import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  FILE_LIMIT, REPORTER_PATH, SELECT_ALL, SUITES, SUITE_COMMANDS, changedFiles, expandArgv, globToRegExp, knownFailureVerdict, knownKey,
  knownEntriesFromReport, listPullRequestFiles, outputLines, readKnownFailures, readReport, resolveCommand, executeSuite, selectSuites,
  unitTestFiles,
  PLATFORMS, SUITE_PLATFORMS, hostPlatform, runSelected, suitePlatforms,
} from './ci-required-selection.mjs';
import * as selection from './ci-required-selection.mjs';
import reporterStream, { failureFingerprint, normalizeFailure } from './ci-test-failures-reporter.mjs';

// What a copy of the selector needs beside it: the modules it imports (test-env since Task 2ee162c2, the real-clock scan,
// guard and their shared imports since Task 11092b8b).
const SELECTOR_IMPORTS = ['test-env.mjs', 'test-clock-scan.mjs', 'test-clock-guard.mjs', 'test-clock-imports.mjs'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const log = () => {};

// Launch the real CLI in separate processes and use a different checkout for
// each suite. Inject the queue location and short timing budgets.
function slotFixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clued-suite-slots-test-'));
  const children = [];
  const selector = path.join(ROOT, 'scripts/ci/ci-required-selection.mjs');
  const slotModule = pathToFileURL(path.join(ROOT, 'scripts/ci/local-suite-slots.mjs')).href;
  const loader = path.join(dir, 'loader.mjs');
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    if (process.env.SLOT_FIXTURE_PROBE_ERROR) {
      const original = childProcess.execFileSync;
      let calls = 0;
      childProcess.execFileSync = (file, args, options) => {
        if (file === 'powershell.exe' && args.includes('-Command') && ++calls > Number(process.env.SLOT_FIXTURE_PROBE_AFTER)
          && calls <= Number(process.env.SLOT_FIXTURE_PROBE_AFTER) + Number(process.env.SLOT_FIXTURE_PROBE_ERROR)) {
          throw Object.assign(new Error('synthetic identity probe timeout'), { code: 'ETIMEDOUT' });
        }
        return original(file, args, options);
      };
      syncBuiltinESMExports();
    }
    if (process.env.SLOT_FIXTURE_EVENT) {
      globalThis.fetch = async () => ({
        ok: true, json: async () => [{ filename: 'fixture/wrangler.jsonc' }],
      });
    }
    registerHooks({ resolve(specifier, context, next) {
      if (specifier !== './local-suite-slots.mjs') return next(specifier, context);
      const source = \`import { withLocalSuiteSlot as acquire } from \${JSON.stringify(${JSON.stringify(slotModule)})};
        export const withLocalSuiteSlot = (id, run) => acquire(id, run, {
          directory: \${JSON.stringify(process.env.SLOT_FIXTURE_QUEUE)}, waitMs: Number(process.env.SLOT_FIXTURE_WAIT),
          holdMs: Number(process.env.SLOT_FIXTURE_HOLD), probeMs: 200,
        });\`;
      return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    }});
  `);
  const queue = path.join(dir, 'shared-queue');
  mkdirSync(queue);
  t.after(async () => {
    for (const child of children) child.release();
    await Promise.all(children.map(({ done }) => done));
    for (const { descendant } of children) {
      const deadline = performance.now() + 5_000;
      while (pidAlive(descendant()) && performance.now() < deadline) await delay(20);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return function start(name, {
    waitMs = 25_000, holdMs = 35_000, ci, tree = false, probeErrors = 0, probeAfter = 0, suite = 'retrigger-counter', mode = '--run', body = null, named = null, extraFiles = {},
    extraEnv = {},
  } = {}) {
    const root = path.join(dir, name);
    const scripts = path.join(root, 'scripts', 'ci');
    mkdirSync(scripts, { recursive: true });
    // A checkout with scripts/ci has its selector (requiredCommands); this one adds no command to any suite.
    writeFileSync(path.join(scripts, 'ci-required-selection.mjs'), 'export const SUITE_COMMANDS = {};\n');
    writeFileSync(path.join(root, 'descendant.mjs'), `
      import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync('descendant.pid', String(process.pid));
      const poll = setInterval(() => { if (existsSync('release')) clearInterval(poll); }, 20);
      setTimeout(() => clearInterval(poll), 35_000).unref();
    `);
    const probe = `
      import { spawnSync } from 'node:child_process';
      import { existsSync, writeFileSync } from 'node:fs';
      if (${tree}) {
        const launched = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
          'import subprocess, sys; subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
          process.execPath, 'descendant.mjs']);
        if (launched.error || launched.status !== 0) throw new Error('cannot launch fixture descendant');
      }
      writeFileSync('ready', '');
      const poll = setInterval(() => { if (existsSync('release')) clearInterval(poll); }, 20);
      setTimeout(() => { clearInterval(poll); process.exitCode = 1; }, 35_000).unref();
    `;
    writeFileSync(path.join(scripts, 'retrigger-counter.test.mjs'), body ?? probe);
    // The probe waits for real events on real timers: on the checkout's debt list, which the guard the entry preloads reads
    // (Task 11092b8b).
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(path.join(root, 'config', 'test-clock-debt.txt'), 'scripts/ci/retrigger-counter.test.mjs\n');
    let tool = selector;
    let target = suite;
    if (mode === '--write-known') {
      const tools = path.join(root, 'tools');
      mkdirSync(tools);
      for (const file of ['ci-required-selection.mjs', ...SELECTOR_IMPORTS, 'ci-test-failures-reporter.mjs',
        'local-suite-slot-guard.mjs', 'local-suite-slots.mjs', 'local-suite-slot-job.ps1']) {
        copyFileSync(path.join(ROOT, 'scripts', 'ci', file), path.join(tools, file));
      }
      writeFileSync(path.join(tools, 'ci-known-failures.json'), '{}');
      tool = path.join(tools, 'ci-required-selection.mjs');
      target = 'admission-self-tests';
      const files = SUITE_COMMANDS[target][0].argv.slice(2);
      for (const [index, file] of files.entries()) {
        const destination = path.join(root, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, index === 0 ? probe : '');
      }
    }
    writeFileSync(path.join(scripts, 'check-pinned-registries.mjs'), 'process.exitCode = 75;\n');
    const env = { ...process.env, SLOT_FIXTURE_QUEUE: queue, SLOT_FIXTURE_WAIT: String(waitMs),
      SLOT_FIXTURE_HOLD: String(holdMs), SLOT_FIXTURE_PROBE_ERROR: String(probeErrors || ''), SLOT_FIXTURE_PROBE_AFTER: String(probeAfter) };
    // A CI job always has a base commit (ciBaseRefusal); none of these commands compares with it.
    env.CI_BASE_SHA ||= 'f'.repeat(40);
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    delete env.NODE_TEST_CONTEXT;
    if (ci) env[ci] = 'true';
    Object.assign(env, extraEnv);
    if (mode === '--run-selected') {
      writeFileSync(path.join(scripts, 'check-cron-budget.test.mjs'), probe);
      writeFileSync(path.join(root, 'config', 'test-clock-debt.txt'),
        'scripts/ci/check-cron-budget.test.mjs\nscripts/ci/retrigger-counter.test.mjs\n');
      writeFileSync(path.join(scripts, 'check-cron-budget.mjs'), '');
      target = 'ci-suites';
      const event = path.join(root, 'event.json');
      writeFileSync(event, '{"pull_request":{"number":1}}');
      Object.assign(env, { SLOT_FIXTURE_EVENT: '1', GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'fixture/repo', GITHUB_TOKEN: 'fixture' });
    }
    for (const [file, text] of Object.entries(extraFiles)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    const namedFiles = mode === '--run-files' ? (named ?? ['scripts/ci/retrigger-counter.test.mjs']) : [];
    const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, tool,
      mode, target, ...namedFiles, '--root', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const done = once(child, 'close');
    const run = { child, done, root, output: () => output, ready: () => existsSync(path.join(root, 'ready')),
      descendant: () => existsSync(path.join(root, 'descendant.pid')) ? Number(readFileSync(path.join(root, 'descendant.pid'))) : 0,
      release: () => writeFileSync(path.join(root, 'release'), '') };
    children.push(run);
    return run;
  };
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForSlotFixture(run, condition) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline && run.child.exitCode === null && run.child.signalCode === null) {
    if (condition()) return;
    await delay(20);
  }
  assert.ok(condition(), `fixture never reached the expected state: ${run.output()}`);
}

async function fillSuiteSlots(start) {
  const first = start('first');
  const second = start('second');
  await waitForSlotFixture(first, first.ready);
  await waitForSlotFixture(second, second.ready);
  return [first, second];
}

async function waitForQueuedSuite(run, holders) {
  await waitForSlotFixture(run, () => run.ready() || /queue position 1/.test(run.output()));
  assert.equal(run.ready(), false, 'a third local invocation must wait before starting its suite');
  for (const holder of holders) assert.match(run.output(), new RegExp(`retrigger-counter \\(PID ${holder.child.pid}\\)`));
}

test('third local --run queues and prints the position and holders until normal exit frees a slot', async (t) => {
  const start = slotFixture(t);
  const holders = await fillSuiteSlots(start);
  const waiting = start('waiting');
  await waitForQueuedSuite(waiting, holders);
  holders[0].release();
  assert.deepEqual(await holders[0].done, [0, null]);
  await waitForSlotFixture(waiting, waiting.ready);
  waiting.release();
  assert.deepEqual(await waiting.done, [0, null]);
});

for (const mode of ['--run-selected', '--write-known']) {
  test(`M3: local ${mode} queues until a slot is available`, async (t) => {
    const start = slotFixture(t);
    const holders = await fillSuiteSlots(start);
    const waiting = start('waiting', { mode });
    await waitForQueuedSuite(waiting, holders);
    holders[0].release();
    await waitForSlotFixture(waiting, waiting.ready);
    waiting.release();
    assert.deepEqual(await waiting.done, [0, null]);
  });

  test(`M3: GitHub Actions ${mode} bypasses an occupied local queue`, async (t) => {
    const start = slotFixture(t);
    await fillSuiteSlots(start);
    // The fixture is a minimal checkout for the selected suite; other tests exercise full-plan lanes.
    const run = start('actions', { mode, ci: 'GITHUB_ACTIONS', extraEnv: { CI_SELECTED_LANES: '1' } });
    await waitForSlotFixture(run, run.ready);
    run.release();
    assert.deepEqual(await run.done, [0, null]);
    assert.doesNotMatch(run.output(), /queue position/);
  });
}

test('local --run reclaims a slot after the holder is killed', async (t) => {
  const start = slotFixture(t);
  const holders = await fillSuiteSlots(start);
  const waiting = start('waiting');
  await waitForQueuedSuite(waiting, holders);
  assert.equal(holders[0].child.kill('SIGKILL'), true);
  // The synthetic suite child can outlive its CLI, so let it close its own pipes.
  holders[0].release();
  assert.equal((await holders[0].done)[1], 'SIGKILL');
  await waitForSlotFixture(waiting, waiting.ready);
  waiting.release();
  assert.deepEqual(await waiting.done, [0, null]);
});

test('M1: killing only the entry drains its Python-launched descendant before admitting the waiter', async (t) => {
  const start = slotFixture(t);
  const holder = start('tree', { tree: true });
  const other = start('other');
  await waitForSlotFixture(holder, holder.descendant);
  await waitForSlotFixture(other, other.ready);
  const waiting = start('waiting');
  await waitForQueuedSuite(waiting, [holder, other]);
  assert.equal(holder.child.kill('SIGKILL'), true);
  await waitForSlotFixture(waiting, waiting.ready);
  assert.equal(pidAlive(holder.descendant()), false, 'a suite was admitted while the killed holder still had a live descendant');
  waiting.release();
  assert.deepEqual(await waiting.done, [0, null]);
});

test('M2: a Windows identity-probe timeout keeps a waiting suite queued until a slot is free',
  { skip: process.platform !== 'win32' }, async (t) => {
    const start = slotFixture(t);
    const holders = await fillSuiteSlots(start);
    const waiting = start('waiting', { probeErrors: 2, probeAfter: 1 });
    await waitForSlotFixture(waiting, () => /synthetic identity probe timeout/.test(waiting.output()));
    assert.ok(!waiting.ready(), 'a failed probe cannot grant a slot');
    await waitForQueuedSuite(waiting, holders);
    holders[0].release();
    await waitForSlotFixture(waiting, waiting.ready);
    waiting.release();
    assert.deepEqual(await waiting.done, [0, null]);
  });

test('M2: persistent identity-probe failure waits for the queue deadline and reports the cause',
  { skip: process.platform !== 'win32' }, async (t) => {
    const start = slotFixture(t);
    const waiting = start('waiting', { probeErrors: 1000, waitMs: 1_500 });
    await waitForSlotFixture(waiting, () => /synthetic identity probe timeout/.test(waiting.output()));
    assert.equal(waiting.child.exitCode, null, 'the probe error must not exit before the queue deadline');
    assert.deepEqual(await waiting.done, [75, null]);
    assert.ok(!waiting.ready());
    assert.match(waiting.output(), /LOCAL_SUITE_SLOT_TIMEOUT.*synthetic identity probe timeout/);
  });

test('L2: a held slot expires, reports the owner, and drains its descendants before admission', async (t) => {
  const start = slotFixture(t);
  const holder = start('hung', { holdMs: 6_000, tree: true });
  const other = start('other');
  await waitForSlotFixture(holder, holder.descendant);
  await waitForSlotFixture(other, other.ready);
  const waiting = start('waiting');
  await waitForQueuedSuite(waiting, [holder, other]);
  await waitForSlotFixture(waiting, waiting.ready);
  assert.equal(pidAlive(holder.descendant()), false);
  assert.deepEqual(await holder.done, [75, null]);
  assert.match(holder.output(), new RegExp(`LOCAL_SUITE_HOLD_TIMEOUT.*retrigger-counter.*PID ${holder.child.pid}`));
  waiting.release();
  assert.deepEqual(await waiting.done, [0, null]);
});

test('only GitHub Actions --run bypasses an occupied local queue', async (t) => {
  const start = slotFixture(t);
  const holders = await fillSuiteSlots(start);
  await waitForQueuedSuite(start('CI', { ci: 'CI' }), holders);
  const run = start('GITHUB_ACTIONS', { ci: 'GITHUB_ACTIONS' });
  await waitForSlotFixture(run, run.ready);
  run.release();
  assert.deepEqual(await run.done, [0, null]);
  assert.doesNotMatch(run.output(), /queue position/);
});

test('L1: local --run times out without starting its suite and returns a dedicated exit code', async (t) => {
  const start = slotFixture(t);
  await fillSuiteSlots(start);
  const waiting = start('waiting', { waitMs: 5_000 });
  await waitForSlotFixture(waiting, () => waiting.ready() || /LOCAL_SUITE_SLOT_TIMEOUT/.test(waiting.output()));
  assert.equal(waiting.ready(), false, 'a timed-out invocation must never start the suite');
  assert.deepEqual(await waiting.done, [75, null]);
  assert.match(waiting.output(), /LOCAL_SUITE_SLOT_TIMEOUT.*queue position 1/);
});

test('L1: selector help distinguishes suite failure from a local slot timeout', () => {
  const help = spawnSync(process.execPath, ['scripts/ci/ci-required-selection.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /1 .*suite fail/i);
  assert.match(help.stdout, /75 .*local suite.*timeout/i);
});

test('a command that exits 75 is still a suite failure rather than a slot timeout', async (t) => {
  const run = slotFixture(t)('failed-command', { suite: 'pinned-registries' });
  assert.deepEqual(await run.done, [1, null]);
  assert.match(run.output(), /exited 75/);
});

for (const file of ['apps/clued-cloud/tests/fixtures/ci-connection-self-v1.json',
  'apps/clued-cloud/supabase/migrations/20261118100000_ci_connection_self_v1.sql',
  'apps/clued-cloud/tests/ci-connection-self-db.test.mjs']) {
  test('单改连接自查合同仍选中 Windows 节点断言 '+file, () => {
    assert.ok(selectSuites('ci-suites',[file],'win32').suites.includes('source-v2-node'));
  });
}

test('G3 required-tests exposes pr/head dispatch and keeps all three self-hosted checks gated on that head', async () => {
  const text = readFileSync(path.join(ROOT, '.github/workflows/clued-required-tests.yml'), 'utf8');
  const { gateFindings } = await import('./clued-work-admission.mjs');
  assert.deepEqual(gateFindings(text, text), [], 'registered gate and every heavy-job condition remain enforced');
  assert.match(text, /^  workflow_dispatch:\n    inputs:\n      pr:/m);
  assert.match(text, /^      head:\n/m);
  for (const name of ['clued-cloud-tests', 'ci-suites', 'migration-verify']) {
    const job = text.slice(text.indexOf(`\n  ${name}:\n`) + 1).split(/\n  [a-z][a-z-]+:\n/)[0];
    assert.match(job, /github.event_name == 'workflow_dispatch'/);
    assert.match(job, /needs.admission-gate.outputs.admitted == 'true'/);
    assert.match(job, /runs-on: \[self-hosted, Linux/);
    assert.match(job, /github.event.repository.default_branch/);
  }
});

// S1b (ported from the Codex draft of 11-18, D:/w/tmp/speed-s1b): the trusted checkouts are sparse.
// Its own import keeps this block apart from the import list other selector changes edit.
import { KNOWN_FAILURES_PATH } from './ci-required-selection.mjs';

const requiredWorkflowJobs = () => ['clued-required-tests.yml', 'clued-required-tests-windows.yml']
  .flatMap((file) => [...readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')
    .replaceAll('\r\n', '\n').matchAll(/^  ([a-z][a-z-]+):\n((?:.*\n)*?)(?=^  [a-z][a-z-]+:\n|(?![\s\S]))/gm)]
    .filter(([, id]) => ['clued-cloud-tests', 'ci-suites', 'migration-verify', 'ci-suites-windows'].includes(id)));

test('all four trusted checkouts use the same sparse directories and cover their runtime files', () => {
  const jobs = requiredWorkflowJobs();
  assert.equal(jobs.length, 4);
  for (const [, id, job] of jobs) {
    const trusted = /\n      - name: Check out the trusted base[^\n]*\n([\s\S]*?)(?=\n      - )/.exec(job);
    assert.ok(trusted, `${id}: trusted checkout step`);
    const checkout = trusted[1];
    const sparse = /^ {10}sparse-checkout: \|\n((?: {12}[^\n]+(?:\n|$))+)/m.exec(checkout);
    assert.ok(sparse, `${id}: trusted checkout must declare sparse-checkout`);
    assert.equal(sparse[1].trimEnd(), '            scripts/ci\n            config\n            .github', `${id}: sparse directory list`);
    const directories = sparse[1].trim().split(/\s+/);
    const action = /uses: \.\/trusted\/([^\s]+)/.exec(job);
    assert.ok(action, `${id}: temporary storage action must come from the trusted tree`);
    const actionFile = `${action[1]}/action.yml`;
    const actionSource = readFileSync(path.join(ROOT, actionFile), 'utf8');
    const actionScripts = [...actionSource.matchAll(/\$(?:env:)?GITHUB_ACTION_PATH\/([\w./-]+)/g)]
      .map(([, file]) => `${action[1]}/${file}`);
    const files = [
      ...closure([path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), REPORTER_PATH]),
      path.relative(ROOT, KNOWN_FAILURES_PATH).split(path.sep).join('/'),
      'config/clued-mechanical-files.json', actionFile, ...actionScripts,
    ];
    for (const file of files) {
      assert.ok(existsSync(path.join(ROOT, file)), `${id}: runtime file ${file} exists`);
      assert.ok(directories.some((directory) => file.startsWith(`${directory}/`)), `${id}: sparse checkout includes ${file}`);
    }
  }
});

test('Linux required jobs fail before invoking the selector when the trusted copy is missing', () => {
  for (const [, id, job] of requiredWorkflowJobs().filter(([, id]) => id !== 'ci-suites-windows')) {
    assert.doesNotMatch(job, /candidate\/scripts\/ci\/ci-required-selection\.mjs/, id);
    assert.match(job, /selector=trusted\/scripts\/ci\/ci-required-selection\.mjs\n +if \[ ! -f "\$selector" \]; then\n(?: +[^\n]+\n)*? +exit 1\n +fi\n/, id);
  }
});

// train-base reads origin/main on every event (scripts/ci/ci-base.mjs is loaded from main), so no candidate checkout of a
// job with train-base may be shallow (task 6cd46765).
test('the migration candidate checkout fetches full history', () => {
  const migration = requiredWorkflowJobs().find(([, id]) => id === 'migration-verify');
  assert.ok(migration);
  assert.match(migration[2], /\n      - name: Check out the candidate\n(?:(?!      - )[^\n]*\n)*? {10}fetch-depth: 0\n/);
});

// A lost-run dispatch (git merge-base origin/main <head>) and a staging push (the chain root T) both walk main's history in
// train-base, so the candidate checkout must hold it; a depth-2 clone has no origin/main and the step fails. Only the
// other events may stay shallow. The expression is evaluated, not matched, so any job that adds train-base is covered.
test('every Linux required job with train-base checks the candidate out with full history for a dispatch and a staging push', () => {
  const text = readFileSync(path.join(ROOT, '.github/workflows/clued-required-tests.yml'), 'utf8').replaceAll('\r\n', '\n');
  const jobs = [...text.matchAll(/^  ([a-z][a-z-]+):\n((?:.*\n)*?)(?=^  [a-z][a-z-]+:\n|(?![\s\S]))/gm)]
    .filter(([, , job]) => job.includes('        id: train-base\n'));
  assert.deepEqual(jobs.map(([, id]) => id), ['clued-cloud-tests', 'ci-suites', 'migration-verify', 'gitleaks', 'trivy', 'contract-placement']);
  const depthFor = (value, eventName, ref) => {
    const expression = /^\$\{\{ (.+) \}\}$/.exec(value);
    if (!expression) return value;
    const js = expression[1].replaceAll('github.event_name', JSON.stringify(eventName)).replaceAll('github.ref', JSON.stringify(ref));
    assert.match(js, /^[\s"'a-z0-9_/.=&|()-]+$/i, value);
    return String(Function(`return (${js});`)());
  };
  for (const [, id, job] of jobs) {
    const checkout = /\n      - name: Check out the candidate\n((?:(?!      - )[^\n]*\n)*)/.exec(job);
    assert.ok(checkout, `${id}: candidate checkout step`);
    const depth = /^ {10}fetch-depth: (.+)$/m.exec(checkout[1]);
    assert.ok(depth, `${id}: candidate checkout declares fetch-depth`);
    assert.equal(depthFor(depth[1], 'workflow_dispatch', 'refs/heads/claude/some-branch'), '0', `${id}: lost-run dispatch`);
    assert.equal(depthFor(depth[1], 'push', 'refs/heads/clued-train/staging'), '0', `${id}: staging push`);
    assert.equal(depthFor(depth[1], 'pull_request', 'refs/pull/9/merge'), '0', `${id}: pull request (ci-base.mjs is read from origin/main)`);
    assert.equal(depthFor(depth[1], 'push', 'refs/heads/main'), '0', `${id}: main push`);
  }
});

test('glob patterns match across and within segments', () => {
  assert.ok(globToRegExp('work/independent-ci-resident-v1/**').test('work/independent-ci-resident-v1/src/executor.mjs'));
  assert.ok(globToRegExp('apps/clued-cloud/scripts/production-schema-*.mjs').test('apps/clued-cloud/scripts/production-schema-drift.mjs'));
  assert.ok(!globToRegExp('apps/clued-cloud/scripts/production-schema-*.mjs').test('apps/clued-cloud/scripts/x/production-schema-drift.mjs'));
  assert.ok(!globToRegExp('scripts/hooks/**').test('scripts/hooksx/a.py'));
  assert.ok(!globToRegExp('VERSION').test('VERSION.md'));
  assert.ok(globToRegExp('**').test('docs/README.md'));
});

test('every selectable suite has commands, every command directory and named test file exists', () => {
  const ids = Object.values(SUITES).flatMap((suites) => Object.keys(suites));
  assert.deepEqual([...ids].sort(), Object.keys(SUITE_COMMANDS).sort());
  for (const [id, commands] of Object.entries(SUITE_COMMANDS)) {
    for (const command of commands) {
      const cwd = path.join(ROOT, command.cwd);
      assert.ok(existsSync(cwd), `${id}: ${command.cwd}`);
      const argv = expandArgv(command.argv, { cwd, root: ROOT, base: 'abc', report: '/tmp/r.json', listUnit: () => ['tests/a.test.mjs'] });
      for (const arg of argv.filter((value) => /\.(?:mjs|py)$/.test(value) && !value.includes('*') && value !== 'tests/a.test.mjs')) {
        assert.ok(existsSync(path.join(cwd, arg)), `${id}: ${arg}`);
      }
      if (command.known) assert.ok(command.argv.includes('--test'), `${id}: a known-failure command runs node --test`);
    }
  }
});

test('unknown changed files select every suite', () => {
  for (const check of Object.keys(SUITES)) {
    assert.deepEqual(selectSuites(check, null).suites, Object.keys(SUITES[check]));
  }
});

test('a change to the selection, the known failures or the required-check workflow selects every suite', () => {
  for (const file of ['scripts/ci/ci-required-selection.mjs', 'scripts/ci/ci-known-failures.json',
    '.github/workflows/clued-required-tests.yml', '.github/actions/ci-temporary-storage/action.yml']) {
    assert.ok(SELECT_ALL.some((pattern) => globToRegExp(pattern).test(file)), file);
    assert.deepEqual(selectSuites('ci-suites', ['README.md', file]).suites, Object.keys(SUITES['ci-suites']), file);
    assert.deepEqual(selectSuites('migration-verify', [file]).suites, ['production-schema'], file);
  }
});

test('resident, Source v2 and CI-script changes run the resident and Source v2 suites', () => {
  const both = ['resident-node', 'resident-python', 'reinstall-python', 'offline-drill', 'source-v2-node', 'source-v2-python'];
  for (const file of ['work/independent-ci-resident-v1/src/executor.mjs', 'work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs',
    'scripts/ci/clued-independent-publication-port.mjs', '.gitleaks.toml']) {
    const { suites } = selectSuites('ci-suites', [file]);
    for (const id of both) assert.ok(suites.includes(id), `${file}: ${id}`);
  }
  assert.ok(selectSuites('ci-suites', ['scripts/ci/clued-work-admission.mjs']).suites.includes('admission-self-tests'));
});

test('the reinstall Python tests run for reinstall, resident and Source v2 changes (task e0f07515)', () => {
  for (const file of ['work/independent-ci-resident-v1/reinstall/launcher/template.ps1', 'work/independent-ci-resident-v1/reinstall/launcher/generate.py',
    'work/independent-ci-resident-v1/windows/install-resident.ps1', 'work/independent-ci-resident-v1/linux/uninstall-resident-linux.sh',
    'work/independent-ci-resident-v1/rollout/x.json', 'work/actions-hosted-migration/independent-ci-v1/src/resident-v2/record.mjs']) {
    assert.ok(selectSuites('ci-suites', [file]).suites.includes('reinstall-python'), file);
  }
  assert.ok(!selectSuites('ci-suites', ['README.md']).suites.includes('reinstall-python'));
  assert.deepEqual(SUITE_COMMANDS['reinstall-python'].map((c) => c.cwd), ['work/independent-ci-resident-v1/reinstall']);
  assert.ok(SUITE_COMMANDS['reinstall-python'][0].argv.join(' ').endsWith('-m unittest discover -s test -p test_*.py'));
});

// Review M3 (rounds 1 and 2): a Node suite must run when any file its code
// reaches through relative imports changes, transitively, from every file the
// suite runs.
function relativeImports(file) {
  const out = [];
  for (const match of readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (existsSync(target) && /\.(?:mjs|js|cjs)$/.test(target)) out.push(target);
  }
  return out;
}

function closure(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...relativeImports(file));
  }
  return [...seen].map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
    .filter((file) => !file.startsWith('..') && !file.includes('node_modules/'));
}

const filesUnder = (dir) => {
  const out = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(file); } else if (/\.(?:mjs|js|cjs)$/.test(entry.name)) out.push(file);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
};

test('every Node suite runs when any file its tests reach through imports changes, transitively', () => {
  const entries = {
    'resident-node': filesUnder('work/independent-ci-resident-v1'),
    'offline-drill': filesUnder('work/independent-ci-resident-v1'),
    'source-v2-node': filesUnder('work/actions-hosted-migration/independent-ci-v1'),
    'admission-self-tests': SUITE_COMMANDS['admission-self-tests'][0].argv.filter((arg) => arg.endsWith('.mjs'))
      .map((file) => path.join(ROOT, file)),
  };
  for (const [id, files] of Object.entries(entries)) {
    const reached = closure(files);
    assert.ok(reached.length > files.length, id);
    for (const file of reached) {
      assert.ok(selectSuites('ci-suites', [file]).suites.includes(id), `${id} reaches ${file}, which does not select it`);
    }
  }
  // The examples the round-2 review found.
  assert.ok(selectSuites('ci-suites', ['scripts/runner/clued-runner-job-started.mjs']).suites.includes('resident-node'));
  assert.ok(selectSuites('ci-suites', ['work/actions-hosted-migration/independent-ci-v1/src/proof.mjs']).suites.includes('admission-self-tests'));
});

test('any workflow change runs the runner budget policy, the admission self-tests, the pinned-registry and the dependency-entry checks', () => {
  assert.deepEqual(selectSuites('ci-suites', ['.github/workflows/trivy.yml']).suites, ['runner-budget-policy', 'admission-self-tests', 'pinned-registries', 'mechanical-outputs', 'ci-deps-entry']);
});

test('a generator, the generated-file list or any file it names runs the mechanical-outputs audit', () => {
  const policy = JSON.parse(readFileSync(new URL('../../config/clued-mechanical-files.json', import.meta.url), 'utf8'));
  for (const file of ['config/clued-mechanical-files.json', 'scripts/ci/clued-merge-reconcile-source-build.mjs',
    'apps/clued-cloud/scripts/generate-agent-contract.mjs', ...policy.marker_paths, ...policy.mechanical_paths.map(p => p.replace(/\*\*$/, 'x.ts'))]) {
    assert.ok(selectSuites('ci-suites', [file]).suites.includes('mechanical-outputs'), file);
  }
  assert.equal(selectSuites('ci-suites', ['docs/README.md']).suites.includes('mechanical-outputs'), false);
  assert.deepEqual(SUITE_COMMANDS['mechanical-outputs'].at(-1).argv.slice(1), ['scripts/ci/component-version-integration.py', '--audit', '--base', '{base}']);
  assert.ok(SUITE_COMMANDS['mechanical-outputs'].every(c => !c.argv.includes('npm')), 'never installs into the checkout (its node_modules may be a shared store)');
});

test('a change to a file a pinned registry holds runs the pinned-registry check', () => {
  for (const file of ['config/merge-admission-policy.json', 'scripts/ci/merge-admission-source-producer.mjs', 'scripts/runner/clued-runner-job-started.mjs',
    '.github/workflows/clued-merge-executor.yml', '.github/actions/ci-temporary-storage/setup.mjs', 'apps/clued-cloud/package-lock.json',
    'apps/clued-cloud/app/supabase-public-config.ts', 'config/clued-components.json', 'scripts/clued_components.py',
    'protocol/agent/agent-contract.md', 'apps/clued-cloud/worker/generated/pdf-cmaps.ts', 'apps/clued-cloud/scripts/generate-pdf-cmaps.mjs',
    'apps/clued-cloud/app/imprints/imprint-suggestions.ts', 'apps/clued-cloud/supabase/migrations/20261016124233_imprint_auto_domains_v1.sql',
    'scripts/build_claude_code_plugin.py', 'skills/clued/SKILL.md', 'integrations/claude-code/clued/skills/clued/SKILL.md']) {
    assert.ok(selectSuites('ci-suites', [file]).suites.includes('pinned-registries'), file);
  }
  assert.equal(selectSuites('ci-suites', ['docs/README.md']).suites.includes('pinned-registries'), false);
  assert.deepEqual(SUITE_COMMANDS['pinned-registries'][0].argv, ['node', 'scripts/ci/check-pinned-registries.mjs', '--base', '{base}']);
});

// Task 700f2b68 (PLAN-main-red-real-repo-20261124 §4.3, PR-A): a check that compares with the base gets it from the command
// table's --base {base}. The coverage check runs as a command of its own in clued-cloud (the suite every change runs), the
// schema drift check takes the base the same way; each runs once, also when a plan is split into shards.
const COVERAGE_CHECK = ['node', 'scripts/ci/check-tests-covered.mjs', '--base', '{base}'];
// Task 11092b8b (PLAN-main-red-ci-base-sha-20261124 §4): the real-clock debt list only shrinks against the same base, checked
// by a command of its own after the coverage check, last in clued-cloud.
const CLOCK_CHECK = ['node', 'scripts/ci/test-clock-scan.mjs', '--check', '--base', '{base}'];
const takesBase = (id) => SUITE_COMMANDS[id].filter((command) => command.argv.includes('{base}'));
const packedCommand = (command, argv, total, seconds) => selection.packShards([{ id: 'fixture', command, argv }], { total, seconds })[0];
test('the coverage, real-clock debt and schema drift checks take the base from the command table, once each, also under --shard', () => {
  assert.deepEqual(takesBase('clued-cloud').map(({ cwd, argv }) => ({ cwd, argv })), [{ cwd: '.', argv: COVERAGE_CHECK }, { cwd: '.', argv: CLOCK_CHECK }]);
  assert.deepEqual(SUITE_COMMANDS['clued-cloud'].slice(-2).map(({ argv }) => argv), [COVERAGE_CHECK, CLOCK_CHECK], 'last, after the coverage check');
  const drift = takesBase('production-schema');
  assert.equal(drift.length, 1, 'one schema drift command takes the base');
  assert.deepEqual(drift[0].argv.slice(0, 5), ['node', 'scripts/production-schema-drift.mjs', 'check', '--base', '{base}']);
  const base = 'b'.repeat(40);
  for (const command of [...takesBase('clued-cloud'), ...drift]) {
    const options = { cwd: path.join(ROOT, command.cwd), root: ROOT, report: 'r.json' };
    const argv = expandArgv(command.argv, { ...options, base });
    assert.equal(argv[argv.indexOf('--base') + 1], base, argv.join(' '));
    assert.throws(() => expandArgv(command.argv, options), /CI_BASE_SHA is required/, 'no base: the suite fails, it never guesses');
    for (const total of [1, 2, 3, 4]) {
      const step = packedCommand(command, argv, total);
      const parts = Array.from({ length: total }, (_, at) => selection.shardPart(step, at + 1));
      assert.equal(parts.filter(({ argv }) => argv).length, 1, `${argv.join(' ')}: one of ${total}`);
    }
  }
});

test('the suite run hands the job base to the checks: clued-cloud and production-schema start them with --base CI_BASE_SHA', () => {
  const base = 'c'.repeat(40);
  const summary = JSON.stringify({ type: 'summary', counts: {}, success: true });
  for (const [id, script] of [['clued-cloud', 'scripts/ci/check-tests-covered.mjs'], ['clued-cloud', 'scripts/ci/test-clock-scan.mjs'],
    ['production-schema', 'scripts/production-schema-drift.mjs']]) {
    const calls = [];
    const spawn = (command, args) => { calls.push(args); return { status: 0 }; };
    assert.equal(executeSuite(id, { root: ROOT, env: { CI_BASE_SHA: base, RUNNER_TEMP: os.tmpdir() }, spawn, log, platform: 'linux',
      known: { 'clued-cloud': [] }, readReportFile: () => summary }), 0, id);
    const checks = calls.filter((args) => args.includes(script));
    assert.equal(checks.length, 1, `${id} runs ${script} once`);
    assert.equal(checks[0][checks[0].indexOf('--base') + 1], base, `${id}: ${checks[0].join(' ')}`);
  }
});

// Task 700f2b68 (PLAN-main-red-ci-base-sha-20261124 §3.1): a suite whose trusted commands take {base} and has no base
// stops before its first command, and says how to set one locally. Before, it ran every command up to the one that took
// the base (clued-cloud: lint, typecheck, build and every unit test) and only then threw.
test('a suite whose trusted commands take {base} starts no command without a base and names the local setting', () => {
  const suites = Object.keys(SUITE_COMMANDS).filter((id) => SUITE_COMMANDS[id].some((command) => command.argv.includes('{base}')));
  assert.ok(['clued-cloud', 'production-schema', 'components', 'pinned-registries'].every((id) => suites.includes(id)), suites.join(', '));
  for (const id of suites) {
    for (const env of [{}, { CI_BASE_SHA: '' }, { CI_BASE_SHA: '0'.repeat(40) }]) {
      const calls = [];
      const lines = [];
      const spawn = (command, args) => { calls.push(args); return { status: 0 }; };
      let status;
      try {
        status = executeSuite(id, { root: ROOT, env: { ...env, RUNNER_TEMP: os.tmpdir() }, spawn, platform: 'linux',
          log: (line) => lines.push(String(line)) });
      } catch (error) {
        status = `threw ${error.message}`;
      }
      const what = `${id} ${JSON.stringify(env)}`;
      assert.equal(calls.length, 0, `${what}: started ${calls.map((args) => args.join(' ')).join('; ')}`);
      assert.equal(status, 2, what);
      assert.match(lines.join('\n'), /CI_BASE_SHA is required for this suite/, what);
      assert.match(lines.join('\n'), /CI_BASE_SHA=\$\(git merge-base HEAD origin\/main\)/, what);
    }
  }
});

test('compute panel changes select the panel tests; the retired cache maintenance suite is gone', () => {
  for (const file of ['scripts/ci/self-hosted/compute_panel.py', 'tests/test_compute_panel.py', '.github/workflows/clued-compute-panel.yml']) {
    assert.ok(selectSuites('ci-suites', [file]).suites.includes('compute-panel'), file);
  }
  assert.ok(SUITE_COMMANDS['compute-panel'].some(c => c.argv.includes('tests/test_compute_panel.py')));
  assert.equal('resource-maintenance' in SUITE_COMMANDS, false);
  assert.equal(Object.values(SUITES).some(suites => 'resource-maintenance' in suites), false);
});

test('node governance changes select its suite; the standard also selects the resident suites that hold its archive numbers', () => {
  for (const file of ['scripts/ci/self-hosted/node-governance/render.ps1', 'scripts/ci/self-hosted/node-governance/linux-sweep.sh', 'scripts/ci/self-hosted/node-profiles.json',
    'config/node-governance-standard.json', 'work/independent-ci-resident-v1/src/host-capacity.mjs']) {
    assert.ok(selectSuites('ci-suites', [file]).suites.includes('node-governance'), file);
  }
  for (const suite of ['resident-node', 'resident-python']) assert.ok(selectSuites('ci-suites', ['config/node-governance-standard.json']).suites.includes(suite), suite);
  assert.ok(SUITE_COMMANDS['node-governance'].some(c => c.argv.includes('{tests:scripts/ci/self-hosted/node-governance}')));
});

// IntegrationRuntime v0.1.8 §13.2 P2 (c): 250,000 fixed-seed random facts in CI. The file's default count is the CI
// obligation; clued-connection-authorization.yml ran it until it was disabled (2026-10-17) and then nothing did.
test('the Integration Runtime 250,000-sample property test runs in a required check, selected by its own paths', () => {
  const file = 'apps/clued-cloud/tests/integration-runtime-derivation-db.test.mjs';
  const runs = Object.entries(SUITE_COMMANDS).filter(([, commands]) => commands.some(({ cwd, argv }) =>
    argv.some((arg) => path.posix.join(cwd, arg) === file)));
  assert.deepEqual(runs.map(([id]) => id), ['production-schema']);
  assert.deepEqual(suitePlatforms('production-schema'), ['linux']);
  for (const changed of [file, 'apps/clued-cloud/tests/fixtures/integration-runtime/golden-vectors.v1.json',
    'apps/clued-cloud/tests/cluster-cleanup.mjs', 'apps/clued-cloud/supabase/migrations/20260926000000_integration_runtime_registry_derivation.sql']) {
    assert.deepEqual(selectSuites('migration-verify', [changed], 'linux').suites, ['production-schema'], changed);
  }
  for (const unrelated of ['apps/clued-cloud/tests/integration-runtime-worker.test.mjs', 'apps/clued-cloud/app/main.tsx',
    'development/contracts/integration-runtime/IntegrationRuntime.v0.1.8.md', 'docs/README.md']) {
    assert.deepEqual(selectSuites('migration-verify', [unrelated], 'linux').suites, [], unrelated);
  }
});

// The database tests clued-connection-authorization.yml ran, which nothing ran after it was disabled (2026-10-17).
const productionSchemaFiles = () => SUITE_COMMANDS['production-schema'].flatMap(({ cwd, argv }) =>
  argv.filter((arg) => arg.endsWith('.test.mjs')).map((arg) => path.posix.join(cwd, arg)));
test('the database tests of the retired connection-authorization workflow run in production-schema, selected by what they read', () => {
  const moved = ['authorization-end-to-end', 'connection-authorization-db', 'context-v2-terminal-restore-db', 'projection-refresh-pipeline-db',
    'work-claims-acceptance-db', 'work-claims-continuation-db', 'db-security-hygiene-db', 'information-flow-candidate-store-db',
    'information-flow-context-db', 'record-update-field-merge-db', 'mtpe-universal-intake-db', 'project-invitations-db',
    'authorization-migration-chain', 'model-domain-bootstrap-db', 'resource-center-authority-db', 'dataset-split-native-grant-correction-db']
    .map((name) => `apps/clued-cloud/tests/${name}.test.mjs`);
  const files = productionSchemaFiles();
  for (const file of moved) {
    assert.ok(files.includes(file), `${file} runs in production-schema`);
    assert.ok(existsSync(path.join(ROOT, file)), `${file} exists`);
    assert.deepEqual(selectSuites('migration-verify', [file], 'linux').suites, ['production-schema'], file);
  }
  for (const input of ['apps/clued-cloud/worker/continuity.ts', 'apps/clued-cloud/tests/resource-center-oauth-db.fixture.mjs',
    'kernel/host/resource-center-online-tool-host.mjs', 'scripts/phase2-qualification/minimum-context-compiler/compiler.mjs',
    'development/contracts/information-flow/vendored/m0a/x.json']) {
    assert.deepEqual(selectSuites('migration-verify', [input], 'linux').suites, ['production-schema'], input);
  }
  for (const unrelated of ['apps/clued-cloud/app/main.tsx', 'apps/clued-cloud/tests/home-project-create.test.mjs', 'kernel/domain/attempt-fsm.mjs']) {
    assert.deepEqual(selectSuites('migration-verify', [unrelated], 'linux').suites, [], unrelated);
  }
});

// A database test is selected by the files it imports: every repository file a moved database test reaches through a
// relative import (helpers, bundled worker code, kernel modules) must select production-schema.
test('every file a moved database test imports selects production-schema', () => {
  const specifiers = (source) => [...source.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1] ?? match[2]).filter((spec) => spec.startsWith('.'));
  const seen = new Set();
  const roots = [...SUITE_COMMANDS['production-schema'].find(({ argv }) => argv.includes('--test-force-exit')).argv.filter((arg) => arg.endsWith('.test.mjs')).map((arg) => `apps/clued-cloud/${arg}`),
    'apps/clued-cloud/tests/integration-runtime-derivation-db.test.mjs', 'apps/clued-cloud/tests/db-security-hygiene-db.test.mjs'];
  const pending = roots.map((file) => path.join(ROOT, file));
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    assert.deepEqual(selectSuites('migration-verify', [relative], 'linux').suites, ['production-schema'], relative);
    if (/\.(?:m?js|ts)$/.test(file)) pending.push(...specifiers(readFileSync(file, 'utf8')).map((spec) => path.resolve(path.dirname(file), spec)));
  }
  assert.ok(roots.length > 60 && seen.size > roots.length);
});

// PLAN-g4-red-merged-20261125 §2.2 (Task 4432ee9b): the checks only clued-g4-database.yml ran (plpgsql_check lint, pgTAP,
// PostgreSQL 17 backup coverage) run in production-schema, the suite of the required migration-verify, as one command on a
// real Supabase database, last; first with --observe. The files it runs and starts from select it.
const REAL_DATABASE = { cwd: 'apps/clued-cloud',
  argv: ['node', '../../scripts/ci/clued-real-database.mjs', '--observe', 'tests/production-backup-scope-db.test.mjs'] };
test('production-schema runs the real database checks last, selected by the files they run and start from', () => {
  assert.deepEqual(SUITE_COMMANDS['production-schema'].at(-1), REAL_DATABASE);
  for (const file of ['apps/clued-cloud/scripts/verify-production-backup-scope.mjs', 'apps/clued-cloud/tests/production-backup-scope-db.test.mjs',
    'scripts/ci/clued-real-database.mjs', 'scripts/ci/clued-real-database.test.mjs', 'scripts/ci/clued-g4-fresh-start.mjs',
    'scripts/ci/clued-local-migrate.mjs', 'apps/clued-cloud/supabase/tests/m1_runtime_contracts.test.sql']) {
    assert.ok(existsSync(path.join(ROOT, file)), `${file} exists`);
    assert.deepEqual(selectSuites('migration-verify', [file], 'linux').suites, ['production-schema'], file);
  }
});

// A script command's test file operands are files the command runs: coverage (check-tests-covered.mjs) counts them as run
// and --run-files runs the whole command for one. Any other second operand still leaves the command unplannable.
test('a node script command takes its script and its test file operands, nothing else', () => {
  const named = new Set(['apps/clued-cloud/tests/production-backup-scope-db.test.mjs', 'scripts/ci/clued-real-database.mjs']);
  const result = selection.filterCommand(REAL_DATABASE, REAL_DATABASE.argv, named);
  assert.deepEqual(result.accepts, ['scripts/ci/clued-real-database.mjs', 'apps/clued-cloud/tests/production-backup-scope-db.test.mjs']);
  assert.deepEqual(result.runs, [REAL_DATABASE.argv]);
  assert.deepEqual(result.matched, ['scripts/ci/clued-real-database.mjs', 'apps/clued-cloud/tests/production-backup-scope-db.test.mjs']);
  const drift = { cwd: 'apps/clued-cloud', argv: ['node', 'scripts/production-schema-drift.mjs', 'check', '--report', 'r.json'] };
  assert.deepEqual(selection.filterCommand(drift, drift.argv, new Set(['apps/clued-cloud/scripts/production-schema-drift.mjs'])),
    { runs: [], matched: [], accepts: [] });
  const one = { cwd: '.', argv: ['node', 'scripts/ci/check-cron-budget.mjs'] };
  assert.deepEqual(selection.filterCommand(one, one.argv, new Set(['scripts/ci/check-cron-budget.mjs'])),
    { runs: [one.argv], matched: ['scripts/ci/check-cron-budget.mjs'], accepts: ['scripts/ci/check-cron-budget.mjs'] });
});

// Every database test, like every other test file, runs in a required suite or is listed in ci-uncovered-tests.json with its
// kind, reason and Task: check-tests-covered.mjs (its test runs in clued-cloud) checks it; the database exemptions moved there.

test('a migration selects the production-schema check; ordinary documentation selects only the application check', (t) => {
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/supabase/migrations/20261101000000_x.sql']).suites,
    ['production-schema']);
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/supabase/ledger/production-history.json']).suites,
    ['production-schema']);
  // Invariant DB tests on the migrated database: run with every migration change and with their own tests.
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/tests/ci-scan-start-native-db.test.mjs']).suites,
    ['production-schema']);
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/tests/storage-runtime-authority-db.test.mjs']).suites,
    ['production-schema']);
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/tests/work-claims-pr-end-release-db.test.mjs']).suites,
    ['production-schema']);
  for (const file of ['ci-connection-self-db.test.mjs', 'fixtures/ci-connection-self-v1.json']) {
    assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/tests/' + file]).suites, ['production-schema']);
  }
  const scanStart = SUITE_COMMANDS['production-schema'].find(({ argv }) => argv[1] === '--test' && argv.includes('{db-concurrency}'));
  assert.equal(scanStart.cwd, 'apps/clued-cloud');
  t.mock.method(os, 'availableParallelism', () => 16);
  assert.deepEqual(expandArgv(scanStart.argv, { cwd: scanStart.cwd }), ['node', '--test', '--test-concurrency=4',
    'tests/ci-scan-start-native-db.test.mjs', 'tests/ci-scan-start-batch-key-db.test.mjs', 'tests/ci-node-binding-rebind-db.test.mjs',
    'tests/ci-connection-self-db.test.mjs', 'tests/binding-role-single-reader-db.test.mjs',
    'tests/integration-runtime-derivation-db.test.mjs', 'tests/db-security-hygiene-db.test.mjs', 'tests/storage-runtime-authority-db.test.mjs', 'tests/work-claims-pr-end-release-db.test.mjs']);
  const docs = selectSuites('migration-verify', ['docs/README.md']);
  assert.deepEqual(docs.suites, []);
  assert.match(docs.reason, /no file this check covers changed/);
  assert.deepEqual(selectSuites('ci-suites', ['docs/README.md', 'apps/clued-cloud/worker/index.ts']).suites, []);
  assert.deepEqual(selectSuites('clued-cloud-tests', ['docs/README.md']).suites, ['clued-cloud']);
  assert.deepEqual(selectSuites('clued-cloud-tests', []).suites, []);
});

for (const [cpus, concurrency] of [[16, 4], [4, 2], [64, 4], [15, 3]]) {
  test(`production-schema runs both database test commands at concurrency ${concurrency} with ${cpus} CPUs`, (t) => {
    t.mock.method(os, 'availableParallelism', () => cpus);
    const calls = [];
    const spawn = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0 };
    };
    assert.equal(executeSuite('production-schema', { root: ROOT, env: { CI_BASE_SHA: 'b' }, spawn, log }), 0);
    assert.deepEqual(calls.filter((argv) => argv.includes('{db-concurrency}') || argv.some((arg) => arg.startsWith('--test-concurrency')))
      .map((argv) => argv.filter((arg) => arg.startsWith('--test-concurrency'))),
      [[`--test-concurrency=${concurrency}`], [`--test-concurrency=${concurrency}`]]);
  });
}

// FABLE-ci-10min-20261119 7.3: the unit tests run at the database tests' concurrency in a hosted job (GITHUB_ACTIONS) and at
// run-tests.mjs's default 2 elsewhere, as the local limits assume.
for (const [actions, cpus, concurrency] of [[true, 16, 4], [false, 16, 2], [true, 4, 2]]) {
  test(`clued-cloud runs its unit tests at concurrency ${concurrency} with ${cpus} CPUs ${actions ? 'in a hosted job' : 'outside Actions'}`, (t) => {
    t.mock.method(os, 'availableParallelism', () => cpus);
    const unit = SUITE_COMMANDS['clued-cloud'].find((command) => command.known === 'clued-cloud');
    assert.deepEqual(unit.argv.slice(0, 3), ['node', 'scripts/run-tests.mjs', '--test']);
    const argv = selection.commandArgv(unit, { cwd: path.join(ROOT, unit.cwd), root: ROOT, hosted: actions,
      listUnit: () => ['tests/u.test.mjs'] });
    assert.deepEqual(argv.filter((arg) => arg.startsWith('--test-concurrency')), [`--test-concurrency=${concurrency}`]);
    assert.equal(selection.testConcurrency(cpus), Math.max(2, Math.min(4, Math.floor(cpus / 4))));
  });
}
test('the candidate expands {unit-concurrency} as the trusted side does in a hosted job: the command adds nothing', (t) => {
  // The candidate's child has no GITHUB_ACTIONS (test-env.mjs): the trusted side passes the job's kind and core count.
  t.mock.method(os, 'availableParallelism', () => 16);
  const { root, dir, change } = candidateSelector(t);
  writeFileSync(path.join(dir, 'retrigger-counter.test.mjs'), '');
  const command = { cwd: '.', argv: ['node', '--test', '{unit-concurrency}', 'scripts/ci/retrigger-counter.test.mjs'] };
  change('retrigger-counter', [command]);
  assert.deepEqual([...selection.requiredCommands('retrigger-counter', root, { baseline: [command], env: { GITHUB_ACTIONS: 'true' } })], [command]);
  assert.deepEqual(expandArgv(command.argv, { cwd: root, hosted: true }).slice(2, 3), ['--test-concurrency=4']);
});

test('outputs name every suite of the check', () => {
  const lines = outputLines('ci-suites', { suites: ['offline-drill'] });
  assert.equal(lines[0], 'suites=["offline-drill"]');
  assert.equal(lines[1], 'app_deps=[]');
  assert.ok(lines.includes('run_offline_drill=true'));
  assert.ok(lines.includes('run_resident_node=false'));
  assert.equal(lines.length, 2 + Object.keys(SUITES['ci-suites']).length);
  assert.ok(outputLines('ci-suites', { suites: ['offline-drill', 'pinned-registries'] }).includes('app_deps=["apps/clued-cloud"]'));
});

// Clued Task 10399304: a suite the selection says needs an application's dependencies (SUITE_APP_DEPENDENCIES) is run only
// by a job that installs them first and tells the suite so (APP_DEPS_MARKER). Every workflow GitHub runs is read, so a new
// suite with such a need, or a suite moved to another job or workflow, cannot run where nothing installs what it needs.
// The step runs in every run (no if:): a required primary's registered steps must all succeed in the execution proof
// (clued-gated-proof.mjs), so a step that is skipped when no selected suite needs dependencies would make every such run
// unqualified. It decides from the selection's app_deps itself, with exactly the reviewed script below.
const APP_DEPS_STEP = 'Install the application dependencies the selected suites need';
const appDepsEnv = (id) => 'APP_DEPS: ${{ steps.' + id + '.outputs.app_deps }}';
const APP_DEPS_RUN = [
  `apps=$(node -e 'for (const a of JSON.parse(process.env.APP_DEPS || "[]")) console.log(a)')`,
  'if [ -z "$apps" ]; then',
  '  echo "No selected suite needs application dependencies; nothing installed."',
  '  exit 0',
  'fi',
  'for app in $apps; do',
  '  node trusted/scripts/ci/ci-deps.mjs install "candidate/$app"',
  'done',
  `echo "${selection.APP_DEPS_MARKER}=1" >> "$GITHUB_ENV"`,
].join('\n');
function workflowJobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 1);
  const parts = body.split(/\n {2}([a-z][a-z0-9_-]*):\n/);
  const jobs = [];
  for (let i = 1; i < parts.length; i += 2) {
    const job = parts[i + 1];
    // runs-on is a self-hosted label list ([self-hosted, Windows, ...]) or one GitHub-hosted image label (windows-2025,
    // ubuntu-24.04): a hosted Windows image is a Windows job too, so it is held to the Windows suites only.
    const runsOn = /\n {4}runs-on: (.+)/.exec(`\n${job}`)?.[1].trim() ?? '';
    const labels = (/^\[([^\]]+)\]/.exec(runsOn)?.[1] ?? runsOn).split(',').map((label) => label.trim())
      .map((label) => (/^windows-/i.test(label) ? 'Windows' : label));
    const steps = job.split(/\n {6}- /).slice(1).map((step) => {
      const run = /(?:^|\n) {8}run: \|\n((?: {10}.*\n?| *\n)+)/.exec(step)?.[1].replace(/^ {10}/gm, '').trimEnd()
        ?? /(?:^|\n) {8}run: (.+)/.exec(step)?.[1];
      return { text: step, name: /^name: (.+)/.exec(step)?.[1] ?? null, id: /(?:^|\n) {8}id: (\S+)/.exec(step)?.[1] ?? null,
        condition: /(?:^|\n) {8}if: (.+)/.exec(step)?.[1] ?? null, run };
    });
    jobs.push({ name: parts[i], platform: labels.includes('Windows') ? 'win32' : 'linux', text: job, steps });
  }
  return jobs;
}
function appDependencyFindings(file, text) {
  const findings = [];
  for (const job of workflowJobs(text)) {
    const suites = new Set();
    for (const [, check] of job.text.matchAll(/ --(?:check|run-selected) ([a-z][a-z-]*)\b/g)) {
      for (const id of Object.keys(SUITES[check] ?? {})) if (suitePlatforms(id).includes(job.platform)) suites.add(id);
    }
    for (const [, id] of job.text.matchAll(/ --run ([a-z][a-z-]*)\b/g)) if (SUITE_COMMANDS[id]) suites.add(id);
    const apps = selection.appDependencies([...suites]);
    if (apps.length === 0) continue;
    const where = `${file} ${job.name}`;
    const install = job.steps.findIndex((step) => step.name === APP_DEPS_STEP);
    const run = job.steps.findIndex((step) => / --run(-selected)? /.test(step.run ?? ''));
    // The step that writes app_deps: the selection's --check, with an id its output is read by.
    const select = job.steps.findIndex((step) => / --check [a-z][a-z-]*\b/.test(step.run ?? '') && step.id);
    const needing = [...suites].filter((id) => selection.SUITE_APP_DEPENDENCIES[id]).join(', ');
    if (install < 0) {
      findings.push(`${where}: can run ${needing}, which need ${apps.join(', ')}, and has no step "${APP_DEPS_STEP}"`);
      continue;
    }
    const step = job.steps[install];
    if (step.condition !== null) findings.push(`${where}: "${APP_DEPS_STEP}" has a condition (${step.condition}); it must run every time`);
    if (select < 0) {
      findings.push(`${where}: has no step with an id that selects the suites with --check, so nothing writes app_deps`);
      continue;
    }
    const selectId = job.steps[select].id;
    if (!step.text.includes(`\n        env:\n          ${appDepsEnv(selectId)}\n`)) findings.push(`${where}: "${APP_DEPS_STEP}" does not read the selection's app_deps`);
    if (step.run !== APP_DEPS_RUN) findings.push(`${where}: "${APP_DEPS_STEP}" is not the reviewed script`);
    if (install < select) findings.push(`${where}: "${APP_DEPS_STEP}" does not come after the step that selects the suites (${selectId})`);
    if (run < 0 || install > run) findings.push(`${where}: "${APP_DEPS_STEP}" does not come before the step that runs the suites`);
  }
  return findings;
}
const workflowFiles = () => readdirSync(path.join(ROOT, '.github', 'workflows')).filter((name) => /\.ya?ml$/.test(name)).sort()
  .map((name) => `.github/workflows/${name}`);

test('every job of any workflow that can run a suite needing application dependencies installs them first, every time, and sets the marker', () => {
  const findings = workflowFiles().flatMap((file) => appDependencyFindings(file, readFileSync(path.join(ROOT, file), 'utf8')));
  assert.deepEqual(findings, []);
  // The guard sees the jobs, and each way to break the step is a finding.
  const file = '.github/workflows/clued-required-tests.yml';
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const step = `      - name: ${APP_DEPS_STEP}\n`;
  assert.ok(text.includes(step));
  const broken = (edit) => appDependencyFindings('w', edit(text)).map((finding) => finding.split(': ').slice(1).join(': '));
  assert.deepEqual(broken((t) => t.replace(APP_DEPS_STEP, 'Install something')), [`can run pinned-registries, which need apps/clued-cloud, and has no step "${APP_DEPS_STEP}"`]);
  assert.deepEqual(broken((t) => t.replace(step, `${step}        if: steps.select.outputs.app_deps == '[]'\n`)),
    [`"${APP_DEPS_STEP}" has a condition (steps.select.outputs.app_deps == '[]'); it must run every time`]);
  assert.deepEqual(broken((t) => t.replace(`${selection.APP_DEPS_MARKER}=1`, 'X=1')), [`"${APP_DEPS_STEP}" is not the reviewed script`]);
  assert.deepEqual(broken((t) => t.replace(appDepsEnv('select'), 'APP_DEPS: "[]"')), [`"${APP_DEPS_STEP}" does not read the selection's app_deps`]);
  assert.deepEqual(broken((t) => t.replace('APP_DEPS: ${{ steps.select.outputs.app_deps }}', 'APP_DEPS: ${{ steps.other.outputs.app_deps }}')),
    [`"${APP_DEPS_STEP}" does not read the selection's app_deps`]);
  // Moved before the step that selects (its app_deps output does not exist yet there), it never installs (Codex re-review).
  const start = text.indexOf(step), end = text.indexOf('\n      - ', start + step.length) + 1;
  const selectAt = text.indexOf('      - name: Select suites\n', text.indexOf('\n  ci-suites:\n'));
  assert.ok(start > selectAt && selectAt > 0);
  const moved = text.slice(0, selectAt) + text.slice(start, end) + text.slice(selectAt, start) + text.slice(end);
  assert.deepEqual(appDependencyFindings('w', moved).map((finding) => finding.split(': ').slice(1).join(': ')),
    [`"${APP_DEPS_STEP}" does not come after the step that selects the suites (select)`]);
  // A third workflow that runs such a suite is read too.
  const third = 'name: third\non:\n  pull_request:\njobs:\n  other:\n    runs-on: [self-hosted, Linux]\n    steps:\n'
    + '      - name: Run\n        run: node trusted/scripts/ci/ci-required-selection.mjs --run pinned-registries --root candidate\n';
  assert.deepEqual(appDependencyFindings('third.yml', third), [`third.yml other: can run pinned-registries, which need apps/clued-cloud, and has no step "${APP_DEPS_STEP}"`]);
  // A job on a GitHub-hosted image label is classified by that label: windows-2025 runs only the Windows suites (none needs
  // the application dependencies), ubuntu-24.04 runs the Linux ones and is held to the step (Task 04f9b91b).
  const hosted = (label) => 'name: hosted\non:\n  pull_request:\njobs:\n  suites:\n    runs-on: ' + label + '\n    steps:\n'
    + '      - name: Run\n        run: node trusted/scripts/ci/ci-required-selection.mjs --run-selected ci-suites --root candidate\n';
  assert.deepEqual(appDependencyFindings('hosted.yml', hosted('windows-2025')), []);
  assert.deepEqual(appDependencyFindings('hosted.yml', hosted('[self-hosted, Windows, X64]')), []);
  assert.deepEqual(appDependencyFindings('hosted.yml', hosted('ubuntu-24.04')), [`hosted.yml suites: can run pinned-registries, which need apps/clued-cloud, and has no step "${APP_DEPS_STEP}"`]);
  // The marker reaches the suites' processes through the environment the selection gives them.
  assert.equal(selection.testEnv({ [selection.APP_DEPS_MARKER]: '1' })[selection.APP_DEPS_MARKER], '1');
});

// The execution proof requires every registered step of a required primary to succeed (clued-gated-proof.mjs); only
// migration-verify's steps have an independent applicability branch there. A conditional step anywhere else must have a
// condition that holds in every run, or a run that legitimately skips it is never qualified (Codex review of 10399304, high 2).
test('the required primaries have no conditional step that a run can skip, except where the execution proof expects it', () => {
  const file = '.github/workflows/clued-required-tests.yml';
  const jobs = workflowJobs(readFileSync(path.join(ROOT, file), 'utf8'));
  // clued-cloud-tests selects clued-cloud for every change, so its run_clued_cloud condition always holds.
  // These two jobs name their one suite in the workflow (its dependencies, timeout and the execution proof's conditional
  // steps) and run no other: a new suite goes to ci-suites (FABLE-new-suite-run-points-20261121 §2).
  assert.deepEqual(SUITES['clued-cloud-tests'], { 'clued-cloud': ['**'] },
    'the clued-cloud-tests job names its suite in the workflow and runs no other: add a new suite to ci-suites');
  assert.deepEqual(Object.keys(SUITES['migration-verify']), ['production-schema'],
    'the migration-verify job names its suite in the workflow and runs no other: add a new suite to ci-suites');
  const expected = {
    'clued-cloud-tests': { 'Install from lockfile': "steps.select.outputs.run_clued_cloud == 'true'",
      'Lint, ledger, typecheck, build and unit tests': "steps.select.outputs.run_clued_cloud == 'true'" },
    'ci-suites': {},
    'migration-verify': { 'Install from lockfile': "steps.select.outputs.run_production_schema == 'true'",
      'Verify migrations on the production schema': "steps.select.outputs.run_production_schema == 'true'",
      'Not affected': "steps.select.outputs.run_production_schema != 'true'" },
  };
  const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, Object.fromEntries(jobs.find((job) => job.name === name)
    .steps.filter((step) => step.run !== undefined && step.condition !== null).map((step) => [step.name, step.condition]))]));
  assert.deepEqual(actual, expected);
});

test('a missing application dependency fails when the job provided them and is skipped, saying why, when it did not', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'app-deps-'));
  try {
    const needs = ['apps/clued-cloud/node_modules/typescript/package.json'];
    const { APP_DEPS_MARKER: marker, appDependencyGap } = selection;
    const missing = appDependencyGap(root, needs, {});
    assert.equal(missing.fail, false);
    assert.equal(missing.reason, `${needs[0]} is missing: this run did not provide the application dependencies (${marker} is not set)`);
    assert.equal(appDependencyGap(root, needs, { [marker]: '1' }).fail, true);
    mkdirSync(path.join(root, 'apps/clued-cloud/node_modules/typescript'), { recursive: true });
    writeFileSync(path.join(root, needs[0]), '{}');
    assert.equal(appDependencyGap(root, needs, { [marker]: '1' }), null);
    assert.equal(appDependencyGap(root, needs, {}), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const page = (names, extra = {}) => ({ ok: true, json: async () => names.map((filename) => ({ filename, ...extra })) });

test('the file listing pages, keeps renamed files under both names and fails closed', async () => {
  const pages = [Array.from({ length: 100 }, (_, i) => `a/${i}`), ['b/x']];
  const calls = [];
  const files = await listPullRequestFiles({ repository: 'o/r', number: 7, token: 't', fetchImpl: async (url) => {
    calls.push(url);
    return pages.length > 1 ? page(pages.shift()) : page(pages.shift(), { previous_filename: 'b/old' });
  } });
  assert.equal(files.length, 102);
  assert.ok(files.includes('b/old'));
  assert.match(calls[0], /pulls\/7\/files\?per_page=100&page=1$/);
  assert.equal(await listPullRequestFiles({ repository: 'o/r', number: 7, token: 't', fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await listPullRequestFiles({ repository: 'o/r', number: 7, token: 't',
    fetchImpl: async () => ({ ok: true, json: async () => [{ filename: 3 }] }) }), null);
  const full = await listPullRequestFiles({ repository: 'o/r', number: 7, token: 't',
    fetchImpl: async () => page(Array.from({ length: 100 }, (_, i) => `c/${i}`)) });
  assert.equal(full, null, `a listing at the ${FILE_LIMIT}-file limit may be incomplete`);
});

test('changed files are unknown without a pull request, a token or a readable listing', async () => {
  const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
  assert.equal(await changedFiles({ event: {}, env }), null);
  assert.equal(await changedFiles({ event: { pull_request: { number: 1 } }, env: {} }), null);
  assert.equal(await changedFiles({ event: { pull_request: { number: 1 } }, env, fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.deepEqual(await changedFiles({ event: { pull_request: { number: 1 } }, env, fetchImpl: async () => page(['x']) }), ['x']);
});

// Task 3435f8bf (FABLE-ci-one-round-20261124 3.1): a pull request head behind main's live tip cannot merge under strict,
// so hosted-required selects nothing for it. The real CLI in a child process, fetch replaced by a loader: the files listing
// selects suites, the compare answers as BEHIND_FIXTURE_COMPARE says (behind, tip or error).
const BEHIND_HEAD = 'a'.repeat(40);
const STALE_BASE = 'b'.repeat(40);
const BEHIND_LINE = 'head 落后 main 3 个提交：strict 下合不进去，不跑；合入 main 后的 head 会跑';

function selectAs(t, workflow, compare) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clued-behind-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loader = path.join(dir, 'loader.mjs');
  writeFileSync(loader, `import { appendFileSync } from 'node:fs';
    const mode = process.env.BEHIND_FIXTURE_COMPARE;
    globalThis.fetch = async (url) => {
      appendFileSync(process.env.BEHIND_FIXTURE_LOG, url + '\\n');
      if (/\\/pulls\\/1\\/files\\?/.test(url)) return { ok: true, json: async () => [{ filename: 'scripts/ci/retrigger-counter.mjs' }] };
      if (/\\/compare\\//.test(url)) {
        if (mode === 'error') return { ok: false, status: 500, json: async () => ({ message: 'fixture error' }) };
        return { ok: true, json: async () => ({ status: mode === 'behind' ? 'diverged' : 'ahead', ahead_by: 2, behind_by: mode === 'behind' ? 3 : 0 }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
  `);
  const event = path.join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { number: 1, head: { sha: BEHIND_HEAD }, base: { ref: 'main', sha: STALE_BASE } } }));
  const files = Object.fromEntries(['output', 'summary', 'requests'].map((name) => [name, path.join(dir, name)]));
  for (const file of Object.values(files)) writeFileSync(file, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GITHUB_|CI$|NODE_TEST_CONTEXT$)/.test(key)));
  Object.assign(env, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'fixture/repo', GITHUB_TOKEN: 'fixture',
    GITHUB_WORKFLOW: workflow, GITHUB_OUTPUT: files.output, GITHUB_STEP_SUMMARY: files.summary,
    BEHIND_FIXTURE_COMPARE: compare, BEHIND_FIXTURE_LOG: files.requests });
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(loader).href, path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'),
    '--check', 'ci-suites'], { cwd: ROOT, env, encoding: 'utf8' });
  const read = (file) => readFileSync(file, 'utf8');
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, output: read(files.output), summary: read(files.summary),
    requests: read(files.requests).split('\n').filter(Boolean) };
}

// Today's selection, the reference the two "as before" cases are held to: a workflow the rule does not apply to (the
// self-hosted side keeps selecting by files until the shadow comparison can tell such a skip from a run) never asks.
function selectionBefore(t) {
  const before = selectAs(t, 'clued-required-tests', 'behind');
  assert.equal(before.status, 0, before.stderr);
  assert.ok(!before.requests.some((url) => url.includes('/compare/')), `the self-hosted side asks for no compare: ${before.requests}`);
  assert.match(before.output, /^suites=\["retrigger-counter",/m, 'the fixture listing selects suites');
  return before;
}

test('hosted-required: a pull request head behind main selects nothing, says why in the log and the summary', (t) => {
  const behind = selectAs(t, 'hosted-required', 'behind');
  assert.equal(behind.status, 0, behind.stderr);
  assert.ok(behind.stdout.includes(BEHIND_LINE), `the log names why nothing runs:\n${behind.stdout}`);
  assert.ok(behind.summary.includes(BEHIND_LINE), `the job summary names why nothing runs:\n${behind.summary}`);
  assert.match(behind.summary, /none \(not affected\)/);
  assert.match(behind.output, /^suites=\[\]$/m);
  assert.match(behind.output, /^app_deps=\[\]$/m);
  assert.deepEqual(behind.output.split('\n').filter((line) => line.startsWith('run_') && !line.endsWith('=false')), [],
    'every suite output is false, so each job takes its existing not-affected path');
  const compare = behind.requests.filter((url) => url.includes('/compare/'));
  assert.deepEqual(compare, [`https://api.github.com/repos/fixture/repo/compare/main...${BEHIND_HEAD}`],
    "main's tip is read live (the branch), never the event's base.sha, which may be old");
});

test("hosted-required: a head that contains main's tip selects exactly as before", (t) => {
  const before = selectionBefore(t);
  const tip = selectAs(t, 'hosted-required', 'tip');
  assert.equal(tip.status, 0, tip.stderr);
  assert.ok(tip.requests.some((url) => url.includes('/compare/')), 'the hosted side asks');
  for (const key of ['stdout', 'output', 'summary']) assert.equal(tip[key], before[key], key);
});

test('hosted-required: a compare that fails selects exactly as before', (t) => {
  const before = selectionBefore(t);
  const failed = selectAs(t, 'hosted-required', 'error');
  assert.equal(failed.status, 0, failed.stderr);
  assert.ok(failed.requests.some((url) => url.includes('/compare/')), 'the hosted side asks');
  for (const key of ['stdout', 'output', 'summary']) assert.equal(failed[key], before[key], key);
});

test('behind main counts only a clear behind_by above 0 on a hosted-required pull request; anything unread runs as before', async () => {
  const { behindMain } = selection;
  const event = { pull_request: { number: 1, head: { sha: BEHIND_HEAD }, base: { ref: 'main', sha: STALE_BASE } } };
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_WORKFLOW: 'hosted-required', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' };
  const answer = (body) => async () => ({ ok: true, json: async () => body });
  assert.equal(await behindMain({ event, env, fetchImpl: answer({ behind_by: 4 }) }), 4);
  for (const [why, body] of [['not behind', { behind_by: 0 }], ['no behind_by', {}], ['a string', { behind_by: '4' }],
    ['negative', { behind_by: -1 }], ['a fraction', { behind_by: 1.5 }], ['not an object', null]]) {
    assert.equal(await behindMain({ event, env, fetchImpl: answer(body) }), null, why);
  }
  assert.equal(await behindMain({ event, env, fetchImpl: async () => ({ ok: false, status: 404 }) }), null, 'an error status');
  assert.equal(await behindMain({ event, env, fetchImpl: async () => { throw new Error('timeout'); } }), null, 'a throw (timeout, offline)');
  assert.equal(await behindMain({ event, env, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('not json'); } }) }), null);
  const never = async () => { throw new Error('must not ask'); };
  assert.equal(await behindMain({ event, env: { ...env, GITHUB_EVENT_NAME: 'push' }, fetchImpl: never }), null, 'a push runs as before');
  assert.equal(await behindMain({ event, env: { ...env, GITHUB_WORKFLOW: 'clued-required-tests' }, fetchImpl: never }), null, 'only hosted-required');
  assert.equal(await behindMain({ event, env: { ...env, GITHUB_TOKEN: '' }, fetchImpl: never }), null, 'no token');
  assert.equal(await behindMain({ event: { pull_request: { ...event.pull_request, head: { sha: 'HEAD' } } }, env, fetchImpl: never }), null,
    'a head that is not a commit id');
  assert.equal(await behindMain({ event: { pull_request: { ...event.pull_request, base: { sha: STALE_BASE } } }, env, fetchImpl: never }), null,
    'no base branch');
});

test('expansions refuse empty test lists and a missing or all-zero base commit', () => {
  const argv = expandArgv(['node', '--test', '{tests:test}'], { cwd: path.join(ROOT, 'work/independent-ci-resident-v1') });
  assert.ok(argv.length > 10);
  assert.ok(argv.slice(2).every((arg) => /^test\/[^/]+\.test\.mjs$/.test(arg)));
  assert.deepEqual(argv.slice(2), [...argv.slice(2)].sort());
  assert.throws(() => expandArgv(['{unit-tests}'], { cwd: ROOT, listUnit: () => [] }), /no unit test files/);
  assert.throws(() => expandArgv(['{tests:docs}'], { cwd: ROOT }), /no test files/);
  assert.throws(() => expandArgv(['{base}'], { cwd: ROOT }), /CI_BASE_SHA is required/);
  assert.throws(() => expandArgv(['{base}'], { cwd: ROOT, base: '0'.repeat(40) }), /CI_BASE_SHA is required/);
  assert.deepEqual(expandArgv(['{base}', '{report}'], { cwd: ROOT, base: 'b', report: 'r' }), ['b', 'r']);
  // defect 15894c2a review M1: the upgrade precheck and rollout tools' tests run in the resident suites
  const resident = expandArgv(SUITE_COMMANDS['resident-node'][0].argv, { cwd: path.join(ROOT, 'work/independent-ci-resident-v1') });
  assert.ok(resident.includes('rollout/test/precheck.test.mjs') && resident.includes('rollout/test/rollout.test.mjs') && resident.includes('test/train-on.test.mjs'));
  assert.ok(SUITE_COMMANDS['resident-python'].some((c) => c.argv.join(' ').includes('-s rollout/test -p test_*.py')));
  const unit = expandArgv(['{unit-tests}'], { cwd: path.join(ROOT, 'apps/clued-cloud') });
  assert.ok(unit.includes('tests/production-schema-drift.test.mjs'));
});

test('a suite stops at its first failing command and reports a command that did not start', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push([command, options.cwd]);
    return { status: calls.length === 1 ? 0 : 3 };
  };
  assert.equal(executeSuite('components', { root: ROOT, env: { CI_BASE_SHA: 'b' }, spawn, log }), 3);
  assert.equal(calls.length, 2);
  assert.equal(executeSuite('selection', { root: ROOT, env: {}, spawn: () => ({ error: new Error('ENOENT') }), log }), 1);
  assert.equal(executeSuite('production-schema', { root: ROOT, env: { CI_BASE_SHA: 'b' }, spawn: () => ({ status: 0 }), log }), 0);
  assert.throws(() => executeSuite('nope', { root: ROOT, spawn, log }), /unknown suite/);
});

// Clued Task fe8a2cbf (ruling 11-19, layer B): every suite command runs with CLUED_UNDER_TEST=1, Python and PowerShell
// suites too, so the installed request tools can tell a test from the operator; the caller's env object is not changed.
test('every suite command runs with the test marker CLUED_UNDER_TEST=1', () => {
  const seen = [];
  const spawn = (command, args, options) => {
    seen.push(options.env.CLUED_UNDER_TEST);
    return { status: 0 };
  };
  const env = { CI_BASE_SHA: 'b', KEEP: 'x' };
  assert.equal(executeSuite('components', { root: ROOT, env, spawn, log }), 0);
  assert.equal(executeSuite('resident-python', { root: ROOT, env: { CLUED_UNDER_TEST: '' }, spawn, log }), 0);
  assert.ok(seen.length >= 3);
  assert.deepEqual([...new Set(seen)], ['1']);
  assert.deepEqual(env, { CI_BASE_SHA: 'b', KEEP: 'x' });
});

// Codex review 5: the marker is in the environment before ANY child starts, the unit-test listing included.
test('the marker is set before any child process: the run flags mark the environment, and the unit-test listing carries it', () => {
  for (const flag of ['--run', '--run-selected', '--write-known']) {
    const env = {};
    selection.markTestRun(['x', flag, 'suite'], env);
    assert.equal(env.CLUED_UNDER_TEST, '1', flag);
  }
  const plain = {};
  selection.markTestRun(['--check', 'ci-suites'], plain);
  assert.deepEqual(plain, {}, '--check runs no suite and is left as it is');
  let seen;
  const files = selection.unitTestFiles(ROOT, (command, args, options) => { seen = options.env?.CLUED_UNDER_TEST; return { status: 0, stdout: 'tests/a.test.mjs\n' }; });
  assert.deepEqual(files, ['tests/a.test.mjs']);
  assert.equal(seen, '1');
});

// Clued Task 2ee162c2 (ruling 11-20 §2): a suite child runs under a fake identity, whatever the caller's is. The probe is a
// real child process given the env the selector builds; it reads the GitHub token variables, lists gh's configuration
// directory and asks the real git which global and system settings it sees.
const IDENTITY_PROBE = `
const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const git = spawnSync('git', ['config', '--list', '--show-scope'], { encoding: 'utf8', cwd: require('node:os').tmpdir() });
const scoped = git.stdout.split('\\n').filter(Boolean).map((line) => line.split('\\t'));
console.log(JSON.stringify({
  tokens: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].map((name) => process.env[name]),
  gh: readdirSync(process.env.GH_CONFIG_DIR), git: git.status, prompt: process.env.GIT_TERMINAL_PROMPT,
  global: scoped.filter(([scope]) => scope === 'global').map(([, entry]) => entry),
  system: scoped.filter(([scope]) => scope === 'system').map(([, entry]) => entry),
  command: scoped.filter(([scope]) => scope === 'command').map(([, entry]) => entry),
  leaked: ['GITHUB_PAT_TOKEN', 'ANTHROPIC_API_KEY', 'CLUED_HOME', 'GIT_CONFIG_COUNT'].filter((name) => name in process.env),
  kept: ['CI_BASE_SHA', 'PYTHONDONTWRITEBYTECODE', 'CLUED_CI_APP_DEPS'].map((name) => process.env[name]),
  clock: ['NODE_OPTIONS', 'CLUED_CLOCK_ROOT'].map((name) => process.env[name]), record: Boolean(process.env.CLUED_CLOCK_RECORD),
}));`;
test('suite children get only the listed variables and a fake identity: fake GitHub tokens, an empty gh configuration, a git global configuration with only the test identity, no system configuration', (t) => {
  // The caller's identity, as a run on the Owner's own account inherits it.
  const owner = mkdtempSync(path.join(os.tmpdir(), 'owner-identity-'));
  t.after(() => rmSync(owner, { recursive: true, force: true }));
  mkdirSync(path.join(owner, 'gh'));
  writeFileSync(path.join(owner, 'gh', 'hosts.yml'), 'github.com:\n    user: owner\n');
  writeFileSync(path.join(owner, 'gitconfig'), '[user]\n\tname = Owner\n\temail = owner@example.com\n[credential]\n\thelper = owner-helper\n');
  const env = { ...process.env, GH_TOKEN: 'owner-token', GITHUB_TOKEN: 'owner-token', GH_ENTERPRISE_TOKEN: 'owner-token',
    GITHUB_ENTERPRISE_TOKEN: 'owner-token', GH_CONFIG_DIR: path.join(owner, 'gh'), GIT_CONFIG_GLOBAL: path.join(owner, 'gitconfig'), CI_BASE_SHA: 'b',
    // Not listed, so not passed (ruling 11-20 "补：测试身份根修" §3): another token, an assistant's key, a Clued setting, git's
    // command-line configuration (a credential helper here), a Node option.
    GITHUB_PAT_TOKEN: 'owner-pat', ANTHROPIC_API_KEY: 'owner-key', CLUED_HOME: owner, GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'owner-helper', NODE_OPTIONS: '--no-warnings', PYTHONDONTWRITEBYTECODE: '1',
    // The job's marker that it installed the application dependencies (#1197): a test reads it to fail rather than skip.
    CLUED_CI_APP_DEPS: '1' };
  delete env.GIT_CONFIG_NOSYSTEM;
  delete env.GIT_TERMINAL_PROMPT;
  const before = { ...env };
  const seen = [];
  const spawn = (command, args, options) => {
    const probe = spawnSync(process.execPath, ['-e', IDENTITY_PROBE], { cwd: options.cwd, env: options.env, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    seen.push(JSON.parse(probe.stdout));
    return { status: 0 };
  };
  assert.equal(executeSuite('node-governance', { root: ROOT, env, spawn, log }), 0);
  assert.equal(executeSuite('resident-python', { root: ROOT, env, spawn, log }), 0);
  assert.ok(seen.length >= 4);
  const fake = selection.FAKE_GITHUB_TOKEN;
  for (const child of seen) {
    assert.deepEqual(child.leaked, [], 'only the listed variables are passed');
    assert.deepEqual(child.tokens.filter((token) => token === 'owner-token'), [], "the caller's GitHub tokens are not passed");
    assert.match(String(fake), /fake/, 'the fake token says what it is');
    assert.deepEqual(child.tokens, [fake, fake, fake, fake]);
    assert.deepEqual(child.gh, [], 'gh finds no stored login');
    assert.equal(child.git, 0);
    assert.deepEqual(child.global, [`user.name=${selection.TEST_GIT_IDENTITY?.name}`, `user.email=${selection.TEST_GIT_IDENTITY?.email}`]);
    assert.deepEqual(child.system, [], 'no system configuration (its credential helper) is read');
    assert.deepEqual(child.command, [], "no configuration from the caller's environment");
    assert.deepEqual(child.kept, ['b', '1', '1'], 'the listed ones are');
    assert.equal(child.prompt, '0');
    // Task 11092b8b (FABLE-no-real-clock-20261122 §2.1, §7.8): the caller's NODE_OPTIONS is not passed; the one a child
    // gets preloads the real-clock guard of this checkout, with the checkout and a record of its own.
    assert.deepEqual(child.clock, [`--import=${pathToFileURL(path.join(ROOT, 'scripts/ci/test-clock-guard.mjs')).href}`, path.resolve(ROOT)]);
    assert.equal(child.record, true);
  }
  assert.deepEqual(env, before, "the caller's env is not changed");
});

// Codex review of 2ee162c2, high 2 and medium 3: in Actions the selector starts suites itself. The job's token the workflow
// gives the step stays with the selector (it lists the PR's files) and never reaches a suite child; the runner's
// RUNNER_TRACKING_ID does, so the runner still finds and ends what a suite leaves running when the job ends.
test("under Actions a suite child gets the fake token, not the job's, and keeps the runner's orphan-process marker", () => {
  const seen = [];
  const spawn = (command, args, options) => { seen.push(options.env); return { status: 0 }; };
  const env = { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'job-token', RUNNER_TRACKING_ID: 'github_1234', CI_BASE_SHA: 'b', PATH: '/bin' };
  assert.equal(executeSuite('retrigger-counter', { root: ROOT, env, spawn, log }), 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].GITHUB_TOKEN, selection.FAKE_GITHUB_TOKEN);
  assert.equal(seen[0].RUNNER_TRACKING_ID, 'github_1234');
  assert.equal(seen[0].GITHUB_ACTIONS, undefined, 'a test runs the same in Actions and locally');
});

// Task 4432ee9b (ruling 11-25 B1): the real database command of production-schema reads the runner's kind to skip its
// cleanup on a GitHub-hosted runner; a suite child gets RUNNER_ENVIRONMENT as the runner gives it.
test("a suite child keeps the runner's kind, RUNNER_ENVIRONMENT", () => {
  const seen = [];
  const spawn = (command, args, options) => { seen.push(options.env); return { status: 0 }; };
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', CI_BASE_SHA: 'b', PATH: '/bin' };
  assert.equal(executeSuite('retrigger-counter', { root: ROOT, env, spawn, log }), 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].RUNNER_ENVIRONMENT, 'github-hosted');
});

// Task 3435f8bf: the hosted windows image points PSModuleAnalysisCachePath at a warmed Windows PowerShell module analysis
// cache; a suite child without it rebuilds the cache, about 20 s more for every powershell.exe. It is passed as given, in any
// case of its name.
test('a suite child keeps the PowerShell module analysis cache path, in any case of its name', () => {
  const cache = 'C:\PSModuleAnalysisCachePath\ModuleAnalysisCache';
  for (const name of ['PSModuleAnalysisCachePath', 'psmoduleanalysiscachepath', 'PSMODULEANALYSISCACHEPATH']) {
    const seen = [];
    const spawn = (command, args, options) => { seen.push(options.env); return { status: 0 }; };
    assert.equal(executeSuite('retrigger-counter', { root: ROOT, env: { [name]: cache, CI_BASE_SHA: 'b', PATH: '/bin' }, spawn, log }), 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][name], cache, `${name} reaches the suite child unchanged`);
  }
});

// Codex review of 2ee162c2, medium 5: a proxy URL may carry a user name and password; such a variable is not passed.
test('a proxy variable whose URL carries a user name or password is not passed; one without is', () => {
  const kept = selection.keptVariables({ HTTPS_PROXY: 'http://user:secret@proxy:8080', http_proxy: 'http://proxy:3128',
    ALL_PROXY: 'socks5://user@proxy:1080', https_proxy: 'user:pw@proxy:8080', all_proxy: 'http://%zz@proxy', NO_PROXY: 'localhost',
    HTTP_PROXY: 'proxy.local:8080' });
  assert.deepEqual(kept, { http_proxy: 'http://proxy:3128', NO_PROXY: 'localhost', HTTP_PROXY: 'proxy.local:8080' });
});

// Fable ruling 11-20 "补：止血 PR 第四轮": one identity directory per run, randomly named under the run's temporary
// directory, its place handed to the children in the environment, removed when the run ends, and no ownership check.
const IDENTITY_SELECTOR = JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs')).href);
const runIdentity = (temp, { fail = false } = {}) => {
  const nested = `import(${IDENTITY_SELECTOR}).then(({ testEnv }) => console.log(testEnv(process.env).GH_CONFIG_DIR));`;
  const script = `import(${IDENTITY_SELECTOR}).then(({ markTestRun, testEnv }) => {
    const env = { ...process.env, RUNNER_TEMP: process.argv[1] };
    markTestRun(['--run', 'selection'], env);
    const child = testEnv(env);
    const inner = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(nested)}], { env: child, encoding: 'utf8' });
    console.log(JSON.stringify({ made: env.CLUED_TEST_IDENTITY_DIR, gh: child.GH_CONFIG_DIR, git: child.GIT_CONFIG_GLOBAL, nested: inner.stdout.trim(),
      there: require('node:fs').existsSync(env.CLUED_TEST_IDENTITY_DIR) }));
    if (${fail}) process.exitCode = 1;
  });`;
  const fresh = { ...process.env };
  delete fresh.CLUED_TEST_IDENTITY_DIR;
  const run = spawnSync(process.execPath, ['-e', script, temp], { env: fresh, encoding: 'utf8' });
  assert.equal(run.status, fail ? 1 : 0, run.stderr);
  return JSON.parse(run.stdout);
};
test('each run makes its own identity directory under the run temporary directory, hands it to its children, and removes it when it ends', (t) => {
  const temp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'identity-run-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const first = runIdentity(temp);
  assert.equal(path.dirname(first.made), temp);
  assert.ok(path.basename(first.made).startsWith('clued-test-identity-'));
  assert.ok(first.there);
  assert.deepEqual([path.dirname(first.gh), path.dirname(first.git), path.dirname(first.nested)], [first.made, first.made, first.made],
    'the children get the run\'s directory through the environment');
  const failed = runIdentity(temp, { fail: true });
  assert.notEqual(failed.made, first.made, 'every run has a directory of its own');
  assert.deepEqual(readdirSync(temp), [], 'removed when the run ends, failed or not');
});

test('a run removes identity directories older than two days and keeps newer ones and other names', (t) => {
  const temp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'identity-old-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const day = 24 * 60 * 60 * 1000;
  const at = { 'clued-test-identity-old': 3, 'clued-test-identity-recent': 1, 'other-old': 3 };
  for (const [name, days] of Object.entries(at)) {
    mkdirSync(path.join(temp, name));
    const when = new Date(Date.now() - days * day);
    utimesSync(path.join(temp, name), when, when);
  }
  runIdentity(temp);
  assert.deepEqual(readdirSync(temp).sort(), ['clued-test-identity-recent', 'other-old']);
});

test('a run whose identity directory cannot be made does not start', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'identity-fail-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const notADirectory = path.join(temp, 'file');
  writeFileSync(notADirectory, '');
  const fresh = { ...process.env, RUNNER_TEMP: notADirectory };
  delete fresh.CLUED_TEST_IDENTITY_DIR;
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), '--run', 'retrigger-counter', '--root', ROOT],
    { env: fresh, encoding: 'utf8' });
  assert.equal(run.status, selection.TEST_IDENTITY_EXIT, run.stderr);
  assert.match(run.stderr, /test identity/);
  assert.doesNotMatch(run.stdout, /::group::/, 'no suite command started');
});

// Codex review 4: the required checks start the TRUSTED BASE's selector, which may predate the marker: every workflow step that
// runs suites through it sets CLUED_UNDER_TEST itself.
test('every workflow step that runs suites through the selector sets CLUED_UNDER_TEST', () => {
  let steps = 0;
  for (const name of readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
    for (const step of text.split(/\n(?=\s*- (?:name|uses|id):)/)) {
      if (!/ci-required-selection\.mjs --run|"\$SELECTOR" --run/.test(step)) continue;
      steps += 1;
      assert.match(step, /\n\s+CLUED_UNDER_TEST: "1"\n/, `${name}: ${step.trim().split('\n')[0]}`);
    }
  }
  assert.ok(steps >= 4, `found ${steps} steps`);
});

// A real run through the reporter: the failure shapes round 2 found masked.
// The fixture is its own test run, not part of this one (as run-tests.mjs does).
const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };

// A candidate checkout whose selector is the trusted one, optionally with the suite's command list replaced.
function candidateSelector(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-pr-commands-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'scripts/ci');
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), 'utf8');
  for (const name of SELECTOR_IMPORTS) copyFileSync(path.join(ROOT, 'scripts/ci', name), path.join(dir, name));
  const change = (id, commands) => writeFileSync(path.join(dir, 'ci-required-selection.mjs'),
    commands === undefined ? source : `${source}\nSUITE_COMMANDS[${JSON.stringify(id)}] = ${JSON.stringify(commands)};\n`);
  change();
  return { root, dir, change };
}

// Gap A (FABLE r8 B2): a command a pull request adds to a suite runs in that pull request's required check.
test('the trusted CLI runs a command added by this PR and its failure fails the suite', (t) => {
  const { root, dir, change } = candidateSelector(t);
  const trusted = path.join(ROOT, 'scripts/ci/ci-required-selection.mjs');
  // As in the required check: the trusted base's selector on the candidate checkout, in Actions (no local slot).
  const run = () => spawnSync(process.execPath, [trusted, '--run', 'retrigger-counter', '--root', root],
    { env: { ...childEnv(), GITHUB_ACTIONS: 'true', CI_BASE_SHA: 'f'.repeat(40) }, encoding: 'utf8' });
  writeFileSync(path.join(dir, 'retrigger-counter.test.mjs'), "console.log('baseline executed');\n");
  const unchanged = run();
  assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
  assert.match(unchanged.stdout, /baseline executed/);

  const failing = { cwd: 'scripts/ci', argv: ['node', '-e', "console.log('addition executed'); process.exit(23)"] };
  // The new command comes first in the candidate. The baseline still runs first, and once.
  change('retrigger-counter', [failing, ...SUITE_COMMANDS['retrigger-counter']]);
  writeFileSync(path.join(dir, 'ci-known-failures.json'), 'invalid candidate quarantine');
  const added = run();
  assert.equal(added.status, 23, added.stdout + added.stderr);
  assert.match(added.stdout, /baseline executed[\s\S]*\naddition executed\r?\n/);
  assert.equal(added.stdout.split('baseline executed').length - 1, 1);

  // A replacement cannot drop the original command either.
  change('retrigger-counter', [failing]);
  const replaced = run();
  assert.equal(replaced.status, 23, replaced.stdout + replaced.stderr);
  assert.match(replaced.stdout, /baseline executed[\s\S]*\naddition executed\r?\n/);
  change('retrigger-counter', []);
  const removed = run();
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  const groups = (out) => out.split(/\r?\n/).filter((line) => line.startsWith('::group::'));
  assert.deepEqual(groups(removed.stdout), groups(unchanged.stdout));
  assert.match(removed.stdout, /baseline executed/);

  writeFileSync(path.join(dir, 'ci-required-selection.mjs'), 'throw new Error("invalid selector");');
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /baseline executed/);
  assert.match(invalid.stderr, /invalid selector/);
});

test('candidate commands: no known-failure allowance, nothing outside the checkout, the targeted entry takes them', (t) => {
  const { root, dir, change } = candidateSelector(t);
  const baseline = SUITE_COMMANDS['retrigger-counter'];
  const extra = { cwd: '.', argv: ['node', '--test', 'scripts/ci/retrigger-counter-extra.test.mjs'], known: 'retrigger-counter' };
  change('retrigger-counter', [...baseline, extra]);
  assert.deepEqual([...selection.requiredCommands('retrigger-counter', root)], [...baseline, { cwd: extra.cwd, argv: extra.argv, expanded: true }]);
  // --run-files plans a test file only the candidate's added command runs, with the command CI runs for it.
  writeFileSync(path.join(dir, 'retrigger-counter.test.mjs'), '');
  writeFileSync(path.join(dir, 'retrigger-counter-extra.test.mjs'), '');
  const { steps } = selection.planFiles('retrigger-counter', { root, files: ['scripts/ci/retrigger-counter-extra.test.mjs'], env: {} });
  assert.deepEqual(steps.map((step) => step.argv), [extra.argv]);
  assert.equal(steps[0].command.known, undefined);
  change('retrigger-counter', [{ cwd: '..', argv: ['node', '-e', ''] }]);
  assert.throws(() => [...selection.requiredCommands('retrigger-counter', root)], /outside the checkout/);
  change('retrigger-counter', [{ cwd: '.', argv: [] }]);
  assert.throws(() => [...selection.requiredCommands('retrigger-counter', root)], /invalid candidate command/);
  // A checkout without scripts/ci adds nothing.
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual([...selection.requiredCommands('retrigger-counter', root)], baseline);
});

// As the required check runs: the trusted selector (given) on the candidate checkout, in Actions (no local slot).
const runCandidate = (root, id = 'retrigger-counter', trusted = path.join(ROOT, 'scripts/ci/ci-required-selection.mjs')) =>
  spawnSync(process.execPath, [trusted, '--run', id, '--root', root], { env: { ...childEnv(), GITHUB_ACTIONS: 'true', CI_BASE_SHA: 'f'.repeat(40) }, encoding: 'utf8' });
const groupLines = (out) => out.split(/\r?\n/).filter((line) => line.startsWith('::group::'));

// Gap A review finding 1: the selector's bytes say nothing about the modules it imports, so a candidate selector at another
// path is read even when it is byte for byte the trusted one.
test('a command added by a module the candidate selector imports runs although the selector itself is unchanged', (t) => {
  const checkout = (added) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ci-pr-import-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'scripts/ci');
    mkdirSync(dir, { recursive: true });
    for (const name of SELECTOR_IMPORTS) copyFileSync(path.join(ROOT, 'scripts/ci', name), path.join(dir, name));
    writeFileSync(path.join(dir, 'ci-required-selection.mjs'), `${readFileSync(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), 'utf8')}
import { ADDED } from './suite-additions.mjs';
SUITE_COMMANDS['retrigger-counter'].push(...ADDED);
`);
    writeFileSync(path.join(dir, 'suite-additions.mjs'), `export const ADDED = ${JSON.stringify(added)};\n`);
    writeFileSync(path.join(dir, 'retrigger-counter.test.mjs'), "console.log('baseline executed');\n");
    return root;
  };
  const trusted = checkout([]);
  const candidate = checkout([{ cwd: 'scripts/ci', argv: ['node', '-e', "console.log('import addition executed')"] }]);
  assert.equal(readFileSync(path.join(trusted, 'scripts/ci/ci-required-selection.mjs'), 'utf8'),
    readFileSync(path.join(candidate, 'scripts/ci/ci-required-selection.mjs'), 'utf8'));
  const run = runCandidate(candidate, 'retrigger-counter', path.join(trusted, 'scripts/ci/ci-required-selection.mjs'));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /baseline executed[\s\S]*\nimport addition executed\r?\n/);
});

// Gap A review finding 2: a checkout with scripts/ci but no selector moved or deleted it; what the change adds to the suite
// cannot be read, so the suite fails (after the trusted commands ran).
test('a candidate with scripts/ci but no selector fails the suite after its trusted commands ran', (t) => {
  const { root, dir } = candidateSelector(t);
  rmSync(path.join(dir, 'ci-required-selection.mjs'));
  assert.throws(() => [...selection.requiredCommands('retrigger-counter', root)], /no ci-required-selection\.mjs/);
  writeFileSync(path.join(dir, 'retrigger-counter.test.mjs'), "console.log('baseline executed');\n");
  const run = runCandidate(root);
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /baseline executed/);
  assert.match(run.stdout + run.stderr, /no ci-required-selection\.mjs/);
});

// Gap A review finding 4: a test file added to a trusted command's explicit list runs alone, planned as --run-files plans it,
// after the trusted command ran as it is.
test('a test file added to a trusted command list runs alone after the trusted command', (t) => {
  const { root, dir, change } = candidateSelector(t);
  writeFileSync(path.join(dir, 'retrigger-counter.test.mjs'), "console.log('baseline executed');\n");
  writeFileSync(path.join(dir, 'retrigger-counter-new.test.mjs'), "console.log('new file executed');\n");
  const [trusted] = SUITE_COMMANDS['retrigger-counter'];
  change('retrigger-counter', [{ ...trusted, argv: ['node', '--test', 'scripts/ci/retrigger-counter-new.test.mjs', ...trusted.argv.slice(2)] }]);
  const run = runCandidate(root);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(groupLines(run.stdout), ['::group::retrigger-counter: (.) node --test scripts/ci/retrigger-counter.test.mjs',
    '::group::retrigger-counter: (.) node --test scripts/ci/retrigger-counter-new.test.mjs']);
  assert.equal(run.stdout.split('baseline executed').length - 1, 1);
  assert.equal(run.stdout.split('new file executed').length - 1, 1);
});

test('an added test file runs without the trusted allowance, which still covers the old files; an added switch runs the whole command', (t) => {
  const { root, change } = candidateSelector(t);
  const [trusted] = SUITE_COMMANDS['admission-self-tests'];
  const added = 'scripts/ci/added.test.mjs';
  const old = trusted.argv[2];
  const middle = [...trusted.argv.slice(0, 4), added, ...trusted.argv.slice(4)];
  change('admission-self-tests', [{ ...trusted, argv: middle }]);
  const known = { 'admission-self-tests': [{ file: old, path: ['old'], fingerprint: 'a'.repeat(16), reason: 'r' }] };
  const report = [{ type: 'fail', file: path.join(root, old), path: ['old'], fingerprint: 'a'.repeat(16) },
    { type: 'summary', counts: {}, success: false }].map((event) => JSON.stringify(event)).join('\n');
  // The trusted command fails on its known failure only; the added file fails or passes.
  const suite = (addedStatus) => {
    const calls = [];
    const spawn = (command, args) => { calls.push([command, ...args]); return { status: args.includes(added) ? addedStatus : 1 }; };
    const status = executeSuite('admission-self-tests', { root, env: { RUNNER_TEMP: os.tmpdir() }, spawn, known, log: () => {}, readReportFile: () => report });
    return { status, calls };
  };
  const failing = suite(1);
  assert.equal(failing.status, 1, 'the added file has no allowance');
  assert.equal(failing.calls.length, 2);
  assert.deepEqual(failing.calls[0].filter((arg) => !arg.startsWith('--test-reporter')), trusted.argv, 'the trusted command as it is');
  assert.deepEqual(failing.calls[1], ['node', '--test', added], 'then only the added file, without the reporter of the allowance');
  const passing = suite(0);
  assert.equal(passing.status, 0, 'the old known failure stays allowed');
  assert.deepEqual(passing.calls[1], ['node', '--test', added]);
  // --run-files plans the added file with the command CI runs for it.
  writeFileSync(path.join(root, added), '');
  assert.deepEqual(selection.planFiles('admission-self-tests', { root, files: [added], env: {} }).steps.map((step) => step.argv), [['node', '--test', added]]);
  // Guard: a switch added as well cannot be planned as files only, so the whole command is added, as before.
  const switched = [...middle.slice(0, 2), '--test-only', ...middle.slice(2)];
  change('admission-self-tests', [{ ...trusted, argv: switched }]);
  assert.deepEqual([...selection.requiredCommands('admission-self-tests', root)], [trusted, { cwd: trusted.cwd, argv: switched, expanded: true }]);
  assert.deepEqual(suite(0).calls[1], switched);
});

// Gap A L1 (FABLE-ci-gap-a-L1 §3): after the anchor (--test, -m unittest) a switch without = may take the next element as
// its value. Dropping the other file operands would drop that value too, so such a command cannot be planned: a test file
// added to it runs with the whole command, and --run-files refuses it. Only switches known to take no value plan files.
const L1_SHAPES = [
  ['node', '--test', '--test-name-pattern', 'foo', 'scripts/ci/a.test.mjs', 'scripts/ci/b.test.mjs'],
  ['node', '--test', '--import', './setup.mjs', 'scripts/ci/a.test.mjs', 'scripts/ci/b.test.mjs'],
  ['python', '-m', 'unittest', '-k', 'foo', 'scripts/ci/test_a.py', 'scripts/ci/test_b.py'],
];

test('L1: a test file added to a command whose switch takes a separate value runs with the whole command, and fails', (t) => {
  const trustedCommand = { cwd: '.', argv: ['node', '--test', '--test-name-pattern', 'foo', 'scripts/ci/a.test.mjs'] };
  const candidateCommand = { cwd: '.', argv: [...trustedCommand.argv, 'scripts/ci/b.test.mjs'] };
  // The trusted selector runs as the CLI, before a line appended to it would: its list is edited in place.
  const trusted = candidateSelector(t);
  const entry = "'retrigger-counter': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/retrigger-counter.test.mjs'] }],";
  const source = readFileSync(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), 'utf8');
  assert.ok(source.includes(entry));
  writeFileSync(path.join(trusted.dir, 'ci-required-selection.mjs'),
    source.replace(entry, `'retrigger-counter': [${JSON.stringify(trustedCommand)}],`));
  const candidate = candidateSelector(t);
  candidate.change('retrigger-counter', [candidateCommand]);
  writeFileSync(path.join(candidate.dir, 'a.test.mjs'), "import test from 'node:test';\ntest('foo passes', () => {});\n");
  writeFileSync(path.join(candidate.dir, 'b.test.mjs'),
    "import test from 'node:test';\ntest('foo fails', () => { throw new Error('b foo executed'); });\n");
  const run = runCandidate(candidate.root, 'retrigger-counter', path.join(trusted.dir, 'ci-required-selection.mjs'));
  assert.notEqual(run.status, 0, `the failing added test must fail the suite
${run.stdout}${run.stderr}`);
  assert.deepEqual(groupLines(run.stdout), [`::group::retrigger-counter: (.) ${trustedCommand.argv.join(' ')}`,
    `::group::retrigger-counter: (.) ${candidateCommand.argv.join(' ')}`]);
  assert.match(run.stdout, /b foo executed/);
  assert.deepEqual([...selection.requiredCommands('retrigger-counter', candidate.root, { baseline: [trustedCommand] })],
    [trustedCommand, { ...candidateCommand, expanded: true }], 'the added command carries no files: it runs whole');
});

test('L1: filterCommand plans nothing for a switch that takes a separate value, and --run-files refuses the file', (t) => {
  const { root, dir, change } = candidateSelector(t);
  for (const name of ['retrigger-counter.test.mjs', 'a.test.mjs', 'b.test.mjs', 'test_a.py', 'test_b.py']) writeFileSync(path.join(dir, name), '');
  for (const argv of L1_SHAPES) {
    const named = new Set([argv.at(-1)]);
    assert.deepEqual(selection.filterCommand({ cwd: '.' }, argv, named), { runs: [], matched: [], accepts: [] }, argv.join(' '));
    change('retrigger-counter', [...SUITE_COMMANDS['retrigger-counter'], { cwd: '.', argv }]);
    assert.throws(() => selection.planFiles('retrigger-counter', { root, files: [argv.at(-1)], env: {} }),
      (error) => error instanceof selection.RunFilesError && /does not run/.test(error.message), argv.join(' '));
  }
});

test('L1 guard: the --test-force-exit command of production-schema and a --switch=value still plan the named file only', (t) => {
  const command = SUITE_COMMANDS['production-schema'].find(({ argv }) => argv.includes('--test-force-exit'));
  const [first, second] = command.argv.slice(command.argv.indexOf('--test-force-exit') + 1);
  const expanded = command.argv.map((arg) => (arg === '{db-concurrency}' ? '--test-concurrency=4' : arg));
  const forceExit = selection.filterCommand(command, expanded, new Set([path.posix.join(command.cwd, second)]));
  assert.deepEqual(forceExit.runs, [['node', 'scripts/run-tests.mjs', '--test', '--test-concurrency=4', '--test-force-exit', second]]);
  assert.ok(forceExit.accepts.includes(path.posix.join(command.cwd, first)));
  const equals = ['node', '--test', '--test-name-pattern=foo', 'scripts/ci/a.test.mjs', 'scripts/ci/b.test.mjs'];
  assert.deepEqual(selection.filterCommand({ cwd: '.' }, equals, new Set(['scripts/ci/b.test.mjs'])).runs,
    [['node', '--test', '--test-name-pattern=foo', 'scripts/ci/b.test.mjs']]);
  // A file added to that command still runs alone (each side expands its own {db-concurrency}, as the run sees it).
  const { root, change } = candidateSelector(t);
  const added = 'tests/added-authorization-db.test.mjs';
  const argv = [...command.argv, added];
  change('production-schema', [{ ...command, argv }]);
  const ran = expandArgv(argv, { cwd: path.join(root, command.cwd) });
  assert.deepEqual([...selection.requiredCommands('production-schema', root, { baseline: [command] })],
    [command, { cwd: command.cwd, argv: ran, expanded: true, files: [path.posix.join(command.cwd, added)] }]);
  assert.deepEqual(selection.commandArgv({ cwd: command.cwd, argv: ran, expanded: true, files: [path.posix.join(command.cwd, added)] }, {}),
    ran.filter((arg) => !command.argv.slice(command.argv.indexOf('--test-force-exit') + 1).includes(arg)));
});
function runFixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-reporter-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  const out = path.join(dir, 'failures.jsonl');
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${pathToFileURL(REPORTER_PATH).href}`,
    `--test-reporter-destination=${out}`, ...Object.keys(files)], { cwd: dir, encoding: 'utf8', env: childEnv() });
  const report = readReport(existsSync(out) ? readFileSync(out, 'utf8') : '', dir);
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, report };
}

const FIXTURE = {
  'a.test.mjs': `import test, { describe, it, after } from 'node:test';
test('known one', () => { throw new Error('old reason 12 at /tmp/x/y.mjs'); });
test('parent', async (t) => { await t.test('child ok', () => {}); throw new Error('parent after subtests'); });
describe('suite', () => { after(() => { throw new Error('hook'); }); it('inner ok', () => {}); });
test('only child fails', async (t) => { await t.test('child', () => { throw new Error('child'); }); });
test('late rejection', () => { setTimeout(() => Promise.reject(new Error('late boom')), 1); });
test('todo fails', { todo: true }, () => { throw new Error('todo'); });
`,
  'b.test.mjs': `import test from 'node:test';
test('known one', () => { throw new Error('old reason 12 at /tmp/x/y.mjs'); });
`,
};

test('the reporter records every failure with its file, nesting path and fingerprint, and the run summary', () => {
  const { status, report } = runFixture(FIXTURE);
  assert.equal(status, 1);
  assert.ok(report.summary, 'the run summary is recorded');
  const fails = report.events.filter((event) => event.type === 'fail').map((event) => `${event.file} :: ${event.path.join(' > ')}`).sort();
  assert.deepEqual(fails, ['a.test.mjs :: <async activity after the test ended> > late rejection', 'a.test.mjs :: known one',
    'a.test.mjs :: only child fails > child', 'a.test.mjs :: parent', 'a.test.mjs :: suite', 'b.test.mjs :: known one'],
    'a parent throwing after its subtests, a failing hook and an error after a test ended are failures; a parent failing only through a subtest and a todo test are not');
  const hook = report.events.find((event) => event.type === 'fail' && event.path[0] === 'suite');
  assert.equal(hook.failure_type, 'hookFailed');
  const [a, b] = report.events.filter((event) => event.type === 'fail' && event.path[0] === 'known one');
  assert.equal(a.fingerprint, b.fingerprint, 'paths and numbers do not change a fingerprint');
  assert.ok(report.events.some((event) => event.type === 'pass' && event.path.join(' > ') === 'suite > inner ok'));
});

test('known failures match on file, path and fingerprint: new reasons, new tests, same names elsewhere and masked shapes fail', () => {
  const { status, report } = runFixture(FIXTURE);
  const known = report.events.filter((event) => event.type === 'fail').map((event) => ({ ...event, reason: 'fixture' }));
  assert.equal(knownFailureVerdict({ status, report, known }).ok, true, 'every failure listed');
  const withoutHook = known.filter((entry) => entry.path[0] !== 'suite');
  const hook = knownFailureVerdict({ status, report, known: withoutHook });
  assert.equal(hook.ok, false, 'an unlisted hook failure is new even while other known failures exist');
  assert.deepEqual(hook.unexpected.map((entry) => entry.path.join(' > ')), ['suite']);
  const otherFile = knownFailureVerdict({ status, report, known: known.filter((entry) => entry.file !== 'b.test.mjs') });
  assert.deepEqual(otherFile.unexpected.map((entry) => entry.file), ['b.test.mjs'], 'the same name in another file is a new failure');
  const newReason = known.map((entry) => (entry.path[0] === 'parent' ? { ...entry, fingerprint: '0'.repeat(16) } : entry));
  assert.deepEqual(knownFailureVerdict({ status, report, known: newReason }).unexpected.map((entry) => entry.path[0]), ['parent'],
    'a known test failing for another reason is a new failure');
});

test('a run is not trusted without its summary, after a signal, or with an exit no failure explains', () => {
  const known = [{ file: 'x.test.mjs', path: ['old'], fingerprint: '1'.repeat(16), reason: 'r' }];
  const fail = { type: 'fail', file: 'x.test.mjs', path: ['old'], fingerprint: '1'.repeat(16) };
  const summary = { type: 'summary', counts: {}, success: false };
  const verdict = (status, events) => knownFailureVerdict({ status, report: { events, summary: events.find((e) => e.type === 'summary') ?? null }, known });
  assert.equal(verdict(1, [fail, summary]).ok, true);
  assert.equal(verdict(1, [fail]).ok, false, 'no summary: the run did not finish');
  assert.equal(verdict(129, [fail, summary]).ok, false, 'a signal or timeout');
  assert.equal(verdict(1, [summary]).ok, false, 'a nonzero exit with no failure');
  assert.equal(verdict(0, [fail, summary]).ok, false, 'failures with a zero exit');
  const passed = verdict(0, [{ type: 'pass', file: 'x.test.mjs', path: ['old'] }, summary]);
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.fixed.map((entry) => entry.path[0]), ['old']);
  assert.deepEqual(verdict(0, [summary]).missing.map((entry) => entry.path[0]), ['old']);
  assert.equal(readReport('{"type":"summary"}\nnot json\n', '').corrupt, true);
});

test('a known-failure command adds the trusted reporter, warns on known failures and fails on a new one', () => {
  const entry = { file: 'scripts/ci/x.test.mjs', path: ['old a'], fingerprint: 'a'.repeat(16), reason: 'reason' };
  const known = { 'admission-self-tests': [entry] };
  const lines = [];
  let seen;
  const spawn = (command, args) => { seen = args; return { status: 1 }; };
  const report = (events) => () => events.map((event) => JSON.stringify(event)).join('\n');
  const abs = (file) => path.join(ROOT, file);
  const summary = { type: 'summary', counts: {}, success: false };
  const env = { RUNNER_TEMP: os.tmpdir() };
  assert.equal(executeSuite('admission-self-tests', { root: ROOT, env, spawn, known, log: (line) => lines.push(line),
    readReportFile: report([{ type: 'fail', file: abs(entry.file), path: entry.path, fingerprint: entry.fingerprint }, summary]) }), 0);
  assert.ok(seen.includes(`--test-reporter=${pathToFileURL(REPORTER_PATH).href}`));
  assert.ok(seen.some((arg) => arg.startsWith('--test-reporter-destination=') && arg.endsWith('failures.jsonl')));
  assert.ok(lines.some((line) => line.startsWith('::warning title=admission-self-tests known failure::scripts/ci/x.test.mjs :: old a')));
  assert.equal(executeSuite('admission-self-tests', { root: ROOT, env, spawn, known, log,
    readReportFile: report([{ type: 'fail', file: abs(entry.file), path: entry.path, fingerprint: entry.fingerprint },
      { type: 'fail', file: abs('scripts/ci/x.test.mjs'), path: ['b'], fingerprint: 'b'.repeat(16) }, summary]) }), 1);
  assert.equal(executeSuite('admission-self-tests', { root: ROOT, env, spawn, known, log, readReportFile: () => '' }), 1, 'no report fails');
  assert.equal(executeSuite('admission-self-tests', { root: ROOT, env, spawn: () => ({ status: null, signal: 'SIGKILL' }), known, log,
    readReportFile: report([summary]) }), 128, 'a killed run fails');
});

test('the application suite gates lint, ledger, typecheck and build before the unit tests', () => {
  const calls = [];
  const spawn = (command, args) => { calls.push(args.join(' ')); return { status: args.includes('typecheck') ? 2 : 0 }; };
  assert.equal(executeSuite('clued-cloud', { root: ROOT, env: { CI_BASE_SHA: 'b' }, spawn, log, platform: 'linux' }), 2);
  assert.deepEqual(calls, ['run lint', 'run ledger:verify', 'run typecheck']);
});

test('same-node rebind database regression runs only in the migration check', () => {
  const file = 'tests/ci-node-binding-rebind-db.test.mjs';
  assert.ok(!SUITE_COMMANDS['clued-cloud'].some(c => c.argv.includes(file)));
  assert.ok(SUITE_COMMANDS['production-schema'].some(c => c.argv.includes(file)));
});

test('on Windows the entry starts npm and npx through node, not the .cmd shim; elsewhere the command is unchanged', () => {
  const node = 'C:\\nodejs\\node.exe';
  const entry = (name) => `C:\\nodejs\\node_modules\\npm\\bin\\${name}`;
  const win = { platform: 'win32', nodePath: node, exists: () => true };
  assert.deepEqual(resolveCommand(['npm', 'run', 'lint'], win), [node, entry('npm-cli.js'), 'run', 'lint']);
  assert.equal(resolveCommand(['npx', 'x'], win)[1], entry('npx-cli.js'));
  assert.deepEqual(resolveCommand(['node', '--test'], win), ['node', '--test']);
  assert.deepEqual(resolveCommand(['npm', 'run', 'lint'], { ...win, exists: () => false }), ['npm', 'run', 'lint']);
  assert.deepEqual(resolveCommand(['npm', 'run', 'lint'], { ...win, platform: 'linux' }), ['npm', 'run', 'lint']);
  const calls = [];
  executeSuite('clued-cloud', { root: ROOT, env: { CI_BASE_SHA: 'b' }, platform: 'win32', log, spawn: (command, args) => { calls.push([command, ...args]); return { status: 1 }; } });
  assert.equal(calls.length, 1);
  if (process.platform === 'win32') {
    assert.equal(calls[0][0], process.execPath, 'the first step starts npm via node');
    const probe = spawnSync(calls[0][0], [calls[0][1], '--version'], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
  }
});

test('the committed known-failure list is well formed, one entry per failure, each with a reason', () => {
  const data = readKnownFailures();
  assert.deepEqual(Object.keys(data).sort(), ['admission-self-tests', 'clued-cloud']);
  for (const [id, entries] of Object.entries(data)) {
    assert.ok(SUITE_COMMANDS[id].some((command) => command.known === id), id);
    assert.equal(new Set(entries.map(knownKey)).size, entries.length, `${id}: duplicate entries`);
    for (const entry of entries) assert.ok(existsSync(path.join(ROOT, entry.file)), `${id}: ${entry.file}`);
  }
  const file = path.join(os.tmpdir(), `known-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ x: [{ file: 'a', path: ['t'], fingerprint: '0'.repeat(16), reason: ' ' }] }));
  assert.throws(() => readKnownFailures(file), /without a reason/);
  writeFileSync(file, JSON.stringify({ x: { t: 'old name-keyed form' } }));
  assert.throws(() => readKnownFailures(file), /must be a list/);
});

test('the reporter normalizes paths, digests, positions, durations and long numbers, and keeps small numbers', () => {
  assert.equal(normalizeFailure('expected 3 got 4 in C:\\Users\\x\\Temp\\run-1\\a.mjs and /tmp/clued-test-run-AB12/b.mjs sha 0123abcd4567'),
    'expected 3 got 4 in <path> and <path> sha <hex>');
  assert.equal(normalizeFailure('at a.test.mjs:3:17 took 12.5ms at 2026-11-01T01:02:03.456Z port 54321'),
    'at a.test.mjs:<line> took <ms> at <time> port <n>');
  assert.notEqual(normalizeFailure('23 !== 22'), normalizeFailure('24 !== 22'), 'a different small value is a different failure');
  const a = failureFingerprint({ failureType: 'testCodeFailure', cause: new Error('x at /tmp/1/a') });
  assert.equal(a, failureFingerprint({ failureType: 'testCodeFailure', cause: new Error('x at /home/runner/9/b') }));
  assert.notEqual(a, failureFingerprint({ failureType: 'hookFailed', cause: new Error('x at /tmp/1/a') }));
  assert.notEqual(a, failureFingerprint({ failureType: 'testCodeFailure', cause: new Error('y at /tmp/1/a') }));
});

test('the same failure in another run directory has the same fingerprint (escaped paths, mkdtemp suffixes)', () => {
  // local-verify 2026-11-12: tar printed the run's temporary path escaped; the random parts differed per run.
  const a = String.raw`tar: D\:\\clued-dev\\cache\\clued-local-verify\t(936-5fddb5\\clued-test-run-Igplk1\\pinned-registries-XnxP57: Cannot open: No such file or directory`;
  const b = String.raw`tar: D\:\\clued-dev\\cache\\clued-local-verify\t(328-91a698\\clued-test-run-Qw3rty\\pinned-registries-ab12CD: Cannot open: No such file or directory`;
  assert.equal(normalizeFailure(a), normalizeFailure(b));
  assert.equal(normalizeFailure('mkdtemp gave clued-m5b-argv-a1B2c3 then failed'), normalizeFailure('mkdtemp gave clued-m5b-argv-Zz9yX8 then failed'));
  assert.notEqual(normalizeFailure('admission-status is wrong'), normalizeFailure('admission-states is wrong'), 'an ordinary word stays');
});

test('an error after a test ended is a new failure even when its file has a known failure (round 3)', () => {
  const { status, report } = runFixture({ 'a.test.mjs': `import test from 'node:test';
test('known', () => { throw new Error('old'); });
test('late', () => { setTimeout(() => { throw new Error('late throw'); }, 1); });
` });
  const known = report.events.filter((event) => event.type === 'fail' && event.path[0] === 'known').map((event) => ({ ...event, reason: 'r' }));
  assert.equal(known.length, 1);
  const verdict = knownFailureVerdict({ status, report, known });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.unexpected.map((entry) => entry.path.join(' > ')), ['<async activity after the test ended> > late']);
});

test('report files are matched by real path when the checkout sits behind a link', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-real-'));
  const target = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  mkdirSync(path.join(target, 'tests'), { recursive: true });
  symlinkSync(target, link, 'junction');
  const line = JSON.stringify({ type: 'fail', file: path.join(target, 'tests', 'a.test.mjs'), path: ['t'], fingerprint: 'f'.repeat(16) });
  writeFileSync(path.join(target, 'tests', 'a.test.mjs'), '');
  assert.equal(readReport(line, link).events[0].file, 'tests/a.test.mjs');
  rmSync(dir, { recursive: true, force: true });
});

test('regenerated entries keep the reason of the same failure only; --keep keeps listed entries too', () => {
  const report = readReport([
    { type: 'fail', file: 'x.test.mjs', path: ['old'], fingerprint: '2'.repeat(16) },
    { type: 'fail', file: 'x.test.mjs', path: ['new'], fingerprint: '3'.repeat(16) },
    { type: 'summary', counts: {}, success: false },
  ].map((event) => JSON.stringify(event)).join('\n'), '');
  const entries = knownEntriesFromReport(report, [{ file: 'x.test.mjs', path: ['old'], fingerprint: '1'.repeat(16), reason: 'kept' }]);
  assert.deepEqual(entries.map((entry) => [entry.path[0], entry.fingerprint[0], entry.reason]), [['new', '3', ''], ['old', '2', '']],
    'a changed fingerprint drops the old reason');
  const same = knownEntriesFromReport(report, [{ file: 'x.test.mjs', path: ['old'], fingerprint: '2'.repeat(16), reason: 'kept' }]);
  assert.equal(same.find((entry) => entry.path[0] === 'old').reason, 'kept');
  const kept = knownEntriesFromReport(report, [{ file: 'x.test.mjs', path: ['future'], fingerprint: '4'.repeat(16), reason: 'coming change' }], { keep: true });
  assert.deepEqual(kept.map((entry) => entry.path[0]), ['future', 'new', 'old']);
});

test('a PowerShell script anywhere selects the bare-pipeline .Count scan, and other files do not', () => {
  for (const file of ['a.ps1', 'work/x/windows/new-script.ps1', 'scripts/ci/check-powershell-count.mjs']) {
    assert.ok(selectSuites('ci-suites', [file]).suites.includes('powershell-count'), file);
  }
  assert.equal(selectSuites('ci-suites', ['docs/README.md']).suites.includes('powershell-count'), false);
});

test('run-files: a unittest module name counts as its file, so the components tests can be named by path', () => {
  const { calls, spawn } = spawnRecorder();
  assert.equal(executeSuite('components', { root: ROOT, env: {}, spawn, log, files: ['tests/test_clued_version_check.py'] }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-3), ['-m', 'unittest', 'tests.test_clued_version_check']);
});

// Both platforms (resident ADR 0032): the same selection runs once on Linux and once on Windows.
test('the platform table names real suites with a reason, every suite runs somewhere, and an unnamed suite runs on both', () => {
  const ids = Object.values(SUITES).flatMap((suites) => Object.keys(suites));
  for (const [id, entry] of Object.entries(SUITE_PLATFORMS)) {
    assert.ok(ids.includes(id), `${id} is a suite`);
    assert.ok(entry.platforms.length > 0 && entry.platforms.length < PLATFORMS.length && entry.platforms.every((p) => PLATFORMS.includes(p)),
      `${id}: an entry narrows a suite to some platform (a suite on both has no entry)`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 10, `${id}: says why`);
  }
  for (const id of ids) assert.ok(suitePlatforms(id).length > 0, id);
  assert.deepEqual(suitePlatforms('resident-node'), PLATFORMS);
  assert.equal(hostPlatform('win32'), 'win32');
  assert.equal(hostPlatform('linux'), 'linux');
  assert.equal(hostPlatform('darwin'), 'linux', 'a developer machine that is not Windows selects as the Linux pool does');
});

test('each platform is selected only the suites declared for it, by changed paths, when all are selected and when the files are unknown', () => {
  const windowsCode = ['resident-node', 'resident-python', 'offline-drill', 'source-v2-node', 'source-v2-python'];
  for (const files of [['work/independent-ci-resident-v1/src/executor.mjs'], ['scripts/ci/ci-required-selection.mjs'], null]) {
    const all = selectSuites('ci-suites', files).suites;
    const linux = selectSuites('ci-suites', files, 'linux').suites;
    const windows = selectSuites('ci-suites', files, 'win32').suites;
    assert.deepEqual(linux, all.filter((id) => suitePlatforms(id).includes('linux')));
    assert.deepEqual(windows, all.filter((id) => suitePlatforms(id).includes('win32')));
    assert.deepEqual([...new Set([...linux, ...windows])].sort(), [...all].sort(), 'no selected suite is dropped by both');
    // The code that runs on Windows in production is tested on Windows and on Linux.
    for (const id of windowsCode) assert.ok(windows.includes(id) && linux.includes(id), `${id} on both`);
  }
  // A suite of one platform only: the other side selects nothing and runs nothing.
  assert.deepEqual(selectSuites('clued-cloud-tests', ['docs/README.md'], 'linux').suites, ['clued-cloud']);
  assert.deepEqual(selectSuites('clued-cloud-tests', ['docs/README.md'], 'win32').suites, []);
  assert.deepEqual(selectSuites('migration-verify', null, 'win32').suites, []);
  assert.match(selectSuites('clued-cloud-tests', ['docs/README.md'], 'win32').reason, /no file this check covers changed/);
  assert.throws(() => selectSuites('ci-suites', null, 'darwin'), /unknown platform/);
});

test('a platform step runs every selected suite, names each result, fails when any suite fails and passes when nothing is selected', async () => {
  const ran = [];
  const lines = [];
  const run = (id) => { ran.push(id); return id === 'offline-drill' ? 3 : 0; };
  assert.equal(await runSelected(['resident-node', 'offline-drill', 'selection'], { root: ROOT, env: {}, run, log, summary: (text) => lines.push(text) }), 1);
  assert.deepEqual(ran, ['resident-node', 'offline-drill', 'selection'], 'a failure does not hide the suites after it');
  assert.deepEqual(lines, ['- `resident-node`: passed\n', '- `offline-drill`: **failed**\n', '- `selection`: passed\n']);
  const afterError = [];
  assert.equal(await runSelected(['a', 'b'], { root: ROOT, env: {}, run: async (id) => {
    afterError.push(id);
    if (id === 'a') throw new Error('invalid candidate selector');
    return 0;
  }, log }), 1);
  assert.deepEqual(afterError, ['a', 'b'], 'a suite that throws fails and does not hide the suites after it');
  assert.equal(await runSelected(['resident-node'], { root: ROOT, env: {}, run, log }), 0);
  assert.equal(await runSelected([], { root: ROOT, env: {}, run: () => assert.fail('nothing to run'), log }), 0);
});

// End to end (defect board row 14; #1092 was the mirror case, green on Windows and broken on Linux): a change that
// is wrong on Windows only. The checkout below is the candidate; the selection and the commands are this (trusted)
// file's, as in the job. The tool splits its own path on "/" to find its name, which a Windows path never contains.
// The job is read from the workflow GitHub runs (.github/workflows): before step 2 of ADR 0032 there was no such
// workflow, so nothing published ci-suites-windows and this test could not find the job.
const WINDOWS_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'clued-required-tests-windows.yml');
function windowsJob() {
  const text = readFileSync(WINDOWS_WORKFLOW, 'utf8');
  const job = text.slice(text.indexOf('\n  ci-suites-windows:\n') + 1);
  const published = /&& '([a-z-]+)' \|\| '[a-z-]+-skipped' \}\}\n/.exec(job)[1];
  const labels = /\n {4}runs-on: \[([^\]]+)\]\n/.exec(job)[1].split(',').map((label) => label.trim());
  const [, check, root] = /\n {10}& node trusted\/scripts\/ci\/ci-required-selection\.mjs --run-selected (\S+) --root (\S+)\n {10}exit \$LASTEXITCODE\n/.exec(job);
  return { published, platform: labels.includes('Windows') ? 'win32' : 'linux', check, root };
}

test('a change that breaks only on Windows fails ci-suites-windows and passes the Linux side, through the same selection and commands', async (t) => {
  const job = windowsJob();
  assert.deepEqual(job, { published: 'ci-suites-windows', platform: 'win32', check: 'ci-suites', root: 'candidate' });
  const candidate = mkdtempSync(path.join(os.tmpdir(), 'ci-both-platforms-'));
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  mkdirSync(path.join(candidate, 'scripts', 'ci'), { recursive: true });
  mkdirSync(path.join(candidate, 'tools'));
  // A checkout with scripts/ci carries its selector (requiredCommands reads it once the trusted commands pass); this
  // change leaves the suite's commands as they are.
  writeFileSync(path.join(candidate, 'scripts', 'ci', 'ci-required-selection.mjs'),
    `export const SUITE_COMMANDS = ${JSON.stringify({ 'powershell-count': SUITE_COMMANDS['powershell-count'] })};\n`);
  writeFileSync(path.join(candidate, 'tools', 'setup.ps1'), 'Write-Output "changed"\n');
  writeFileSync(path.join(candidate, 'scripts', 'ci', 'check-powershell-count.mjs'),
    "const name = process.argv[1].split('/').pop();\nif (name === 'check-powershell-count.mjs') console.log('scanned');\n");
  writeFileSync(path.join(candidate, 'scripts', 'ci', 'check-powershell-count.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "import { fileURLToPath } from 'node:url';",
    "test('the scan runs and says so', () => {",
    "  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-powershell-count.mjs');",
    "  const result = spawnSync(process.execPath, [tool], { encoding: 'utf8' });",
    '  assert.equal(result.status, 0);',
    "  assert.equal(result.stdout.trim(), 'scanned', 'the tool did nothing and exited 0');",
    '});',
    ''].join('\n'));
  // What the pull request changes selects the same suite on both platforms.
  const files = ['tools/setup.ps1'];
  for (const platform of PLATFORMS) assert.deepEqual(selectSuites('ci-suites', files, platform).suites, ['powershell-count'], platform);
  // The workflow's job runs this check for its runner's platform; the failing suite is in what it selects.
  assert.deepEqual(selectSuites(job.check, files, job.platform).suites, ['powershell-count']);
  // The step of the job on this host: the real commands, in the candidate checkout.
  const quiet = (command, args, options) => spawnSync(command, args, { ...options, stdio: 'pipe' });
  const lines = [];
  const logged = [];
  const status = await runSelected(selectSuites(job.check, files, hostPlatform()).suites, { root: candidate, env: childEnv(),
    log: (text) => logged.push(String(text)),
    run: (id, options) => executeSuite(id, { ...options, spawn: quiet }), summary: (text) => lines.push(text) });
  // The suite's own commands decide, never an error before they run (e.g. a candidate selector that cannot be read).
  assert.ok(!logged.some((line) => line.startsWith('::error title=powershell-count::')), logged.join('\n'));
  if (process.platform === 'win32') {
    assert.equal(hostPlatform(), job.platform, 'this host is the platform of the ci-suites-windows job');
    assert.equal(status, 1, 'ci-suites-windows fails: this is the failure a Linux-only CI never saw');
    assert.ok(logged.some((line) => /^powershell-count: node --test .*check-powershell-count\.test\.mjs exited 1$/.test(line)),
      `the change's own test is what fails:\n${logged.join('\n')}`);
    assert.deepEqual(lines, ['- `powershell-count`: **failed**\n']);
  } else {
    assert.equal(status, 0, `the same change is green on Linux:\n${logged.join('\n')}`);
    assert.deepEqual(lines, ['- `powershell-count`: passed\n']);
  }
  // Fixed for both platforms, the same change is green on this host too: every trusted command passes, so the
  // candidate's own command list is read as well (this is the path the Linux side takes above).
  writeFileSync(path.join(candidate, 'scripts', 'ci', 'check-powershell-count.mjs'),
    "import path from 'node:path';\nconst name = path.basename(process.argv[1]);\nif (name === 'check-powershell-count.mjs') console.log('scanned');\n");
  const fixedLines = [];
  const fixedLog = [];
  const fixed = await runSelected(selectSuites(job.check, files, hostPlatform()).suites, { root: candidate, env: childEnv(),
    log: (text) => fixedLog.push(String(text)),
    run: (id, options) => executeSuite(id, { ...options, spawn: quiet }), summary: (text) => fixedLines.push(text) });
  assert.equal(fixed, 0, `the fixed change is green on ${process.platform}:\n${fixedLog.join('\n')}`);
  assert.deepEqual(fixedLines, ['- `powershell-count`: passed\n']);
});

// The Windows job is the selection's own entry point and nothing else, on a self-hosted Windows runner, behind the
// same gate job as clued-required-tests.yml, and its name is the check's name only when it runs.
test('the Windows job of the workflow selects and runs with the trusted selection on a self-hosted Windows runner', () => {
  const live = readFileSync(path.join(ROOT, '.github', 'workflows', 'clued-required-tests.yml'), 'utf8');
  assert.ok(!existsSync(path.join(ROOT, 'work', 'ci-required-tests-v1', 'clued-required-tests-windows.candidate.yml')), 'one copy: the workflow');
  const text = readFileSync(WINDOWS_WORKFLOW, 'utf8');
  const between = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to));
  assert.equal(between(text, '  admission-gate:\n', '  # One step selects'), between(live, '  admission-gate:\n', '  clued-cloud-tests:\n'),
    'the registered gate job is that of clued-required-tests.yml, byte for byte; only Linux has lost-run dispatch');
  const job = text.slice(text.indexOf('  ci-suites-windows:\n'));
  assert.match(job, /&& 'ci-suites-windows' \|\| 'ci-suites-windows-skipped' \}\}\n {4}needs: admission-gate\n/);
  const labels = /\n {4}runs-on: \[([^\]]+)\]\n/.exec(job)[1].split(',').map((label) => label.trim());
  for (const label of ['self-hosted', 'Windows', 'trust-internal', 'cap-node24', 'cap-python312']) assert.ok(labels.includes(label), label);
  assert.ok(!labels.includes('Linux') && !/ubuntu|windows-latest/.test(job), 'no Linux route and no GitHub-hosted runner');
  assert.match(job, /\n {10}& node trusted\/scripts\/ci\/ci-required-selection\.mjs --run-selected ci-suites --root candidate\n {10}exit \$LASTEXITCODE\n/);
  // Two commands: the push baseline (git only, before any trusted code loads) and the selection's own entry point.
  assert.deepEqual([...job.matchAll(/\n {6}- name: (.+)\n(?:(?! {6}- ).*\n)*? {8}run: /g)].map((m) => m[1]),
    ['Resolve push baseline before loading trusted commands', 'Select and run the suites declared for Windows'],
    'nothing else can pass or fail the job');
  assert.doesNotMatch(job, /continue-on-error|setup-node|npm /);
});

// D6 N1: ci-suites-windows is a required check on main, and the train lands only when every required check
// succeeded on S. The Windows workflow therefore runs on the train App's push to clued-train/staging under its
// own name, exactly as clued-required-tests.yml does (ADR 0018 §8; ADR 0032 "counted the same way").
test('bors staging, Windows side: the train App push to clued-train/staging publishes ci-suites-windows', () => {
  const text = readFileSync(WINDOWS_WORKFLOW, 'utf8');
  assert.match(text, /\n {2}push:\n {4}branches: \[main, clued-train\/staging\]\n/);
  assert.match(text, /group:.*github\.ref == 'refs\/heads\/clued-train\/staging' && github\.sha/);
  assert.match(text, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
  const job = text.slice(text.indexOf('\n  ci-suites-windows:\n') + 1);
  const expr = field => job.match(new RegExp(`^    ${field}: >-\\n([\\s\\S]*?)(?=^    [a-z])`, 'm'))[1]
    .trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll('needs.admission-gate', "needs['admission-gate']");
  const evaluate = (field, change = {}, admitted = 'true') => Function('github', 'needs', `return (${expr(field)});`)(
    { event_name: 'push', ref: 'refs/heads/clued-train/staging', actor: 'clued-ci-checks-turing-20261018[bot]',
      repository: 'o/r', repository_owner: 'o', event: { pull_request: { base: {}, head: { repo: {} } } }, ...change },
    { 'admission-gate': { outputs: { admitted } } });
  for (const [change, admitted, allowed] of [[{}, 'true', true], [{ actor: 'owner' }, 'true', false],
    [{ ref: 'refs/heads/clued-train/staging.tmp' }, 'true', false], [{ event_name: 'schedule' }, 'true', false],
    [{}, 'false', false], [{ ref: 'refs/heads/main' }, 'true', true], [{ ref: 'refs/heads/main', actor: 'o' }, 'true', true]]) {
    assert.equal(Boolean(evaluate('if', change, admitted)), allowed, JSON.stringify([change, admitted]));
    assert.equal(evaluate('name', change, admitted), allowed ? 'ci-suites-windows' : 'ci-suites-windows-skipped');
  }
});

test('bors staging, Windows side: T is resolved on main before the trusted selection loads, and is the base', () => {
  const text = readFileSync(WINDOWS_WORKFLOW, 'utf8');
  assert.doesNotMatch(text, /github\.event\.before/);
  const job = text.slice(text.indexOf('\n  ci-suites-windows:\n') + 1);
  const candidate = job.indexOf('path: candidate');
  const resolver = job.indexOf('id: train-base');
  const trusted = job.indexOf('path: trusted');
  assert.ok(candidate > 0 && candidate < resolver && resolver < trusted, 'candidate, then the baseline, then trusted');
  assert.match(job.slice(0, resolver), /fetch-depth: 0/);
  const verification = job.slice(resolver, trusted);
  assert.match(verification, /\n {8}shell: powershell\n/);
  // The one rule, scripts/ci/ci-base.mjs, read from main (behaviour: the tests below and ci-base.test.mjs); the step exits
  // with its status.
  assert.match(verification, /git\('show', 'origin\/main:scripts\/ci\/ci-base\.mjs'\)/);
  assert.match(verification, /process\.exitCode = await writeCiBase\(\);"\n {10}exit \$LASTEXITCODE\n/);
  assert.match(job, /ref: \$\{\{ steps\.train-base\.outputs\.sha \|\| github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}\n {10}path: trusted\n/);
  // CI_BASE_SHA comes from the GITHUB_ENV train-base writes; a step env would override it.
  assert.doesNotMatch(job, /^ +CI_BASE_SHA:/m);
});

// A batch of N members is S = merge(...merge(T, H1)..., HN) (ADR 0019 §3): S^1 is an intermediate train merge, not on
// main, and only T, the root of the member chain, is a trusted base. Each required job's push-baseline step runs here as
// it does on the runner: its own script, its own shell, a real Git checkout whose origin/main is T and holds this
// change's scripts/ci/ci-base.mjs and runner hook (the step loads both from main).
const LINUX_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'clued-required-tests.yml');
const BASELINE_JOBS = [[LINUX_WORKFLOW, 'clued-cloud-tests'], [LINUX_WORKFLOW, 'ci-suites'], [LINUX_WORKFLOW, 'migration-verify'],
  [LINUX_WORKFLOW, 'gitleaks'], [LINUX_WORKFLOW, 'trivy'], [LINUX_WORKFLOW, 'contract-placement'],
  [WINDOWS_WORKFLOW, 'ci-suites-windows']];
function baselineStep(file, id) {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(`\n  ${id}:\n`);
  assert.ok(start > 0, `${path.basename(file)} has job ${id}`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const job = end < 0 ? rest : rest.slice(0, end + 1);
  const step = job.slice(job.indexOf('        id: train-base\n'));
  const shell = /\n {8}shell: (bash|powershell)\n/.exec(step)[1];
  const lines = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length).split('\n');
  const body = [];
  for (const line of lines) { if (line.trim() && !line.startsWith(' '.repeat(10))) break; body.push(line.slice(10)); }
  return { shell, script: body.join('\n').trimEnd() + '\n' };
}
// Never the bash on PATH under Windows (it may be WSL's): Git for Windows' own bash, or none.
function shellCommand(shell) {
  if (shell === 'powershell') return process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']] : null;
  if (process.platform !== 'win32') return ['bash', []];
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const bash = exec && path.resolve(exec, '..', '..', '..', 'bin', 'bash.exe');
  return bash && existsSync(bash) ? [bash, []] : null;
}
function trainCheckout(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clued-train-base-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=', ...args],
      { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'work');
  mkdirSync(path.join(dir, 'scripts', 'runner'), { recursive: true });
  copyFileSync(path.join(ROOT, 'scripts', 'runner', 'clued-runner-job-started.mjs'), path.join(dir, 'scripts', 'runner', 'clued-runner-job-started.mjs'));
  mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
  copyFileSync(path.join(ROOT, 'scripts', 'ci', 'ci-base.mjs'), path.join(dir, 'scripts', 'ci', 'ci-base.mjs'));
  git('add', '-A');
  git('commit', '-q', '-m', 'T');
  const T = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  // Each commit its own object: same tree, parents and second would otherwise give the same SHA (H1 = H2).
  let made = 0;
  const commit = (...parents) => git('commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', `c${++made}`);
  const [H1, H2, H3, X] = [commit(T), commit(T), commit(T), commit()];
  git('update-ref', 'refs/remotes/origin/main', T);
  const one = commit(T, H1), two = commit(one, H2), three = commit(two, H3);
  return { dir, T, H1, H2, one, two, three, commit, git, offMain: commit(commit(X, H1), H2), single: commit(commit(T), H2) };
}
// The step reads GitHub's own variables: EVENT_NAME, PUSH_REF and STAGING_SHA here are github.event_name, github.ref and
// github.sha; event is the payload at GITHUB_EVENT_PATH. Returns its outputs and what it wrote to GITHUB_ENV.
function runBaseline(t, { shell, script }, repo, { EVENT_NAME, PUSH_REF, STAGING_SHA, event = {} }) {
  const command = shellCommand(shell);
  const tag = Math.random().toString(16).slice(2);
  const output = path.join(repo, `output-${tag}`), envFile = path.join(repo, `env-${tag}`), eventFile = path.join(repo, `event-${tag}.json`);
  const file = path.join(repo, `step-${tag}.${shell === 'bash' ? 'sh' : 'ps1'}`);
  writeFileSync(output, '');
  writeFileSync(envFile, '');
  writeFileSync(eventFile, JSON.stringify(event));
  writeFileSync(file, script);
  const r = spawnSync(command[0], [...command[1], file], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_ENV: envFile,
      GITHUB_EVENT_PATH: eventFile, GITHUB_EVENT_NAME: EVENT_NAME, GITHUB_REF: PUSH_REF, GITHUB_SHA: STAGING_SHA, CI_BASE_SHA: '' } });
  const kv = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').filter(Boolean).map((line) => line.split('=')));
  return { status: r.status, outputs: kv(output), env: kv(envFile), log: r.stdout + r.stderr };
}
const STAGING = { EVENT_NAME: 'push', PUSH_REF: 'refs/heads/clued-train/staging' };
// The suites each Linux required job runs that take {base}: ci-suites the selected ones, clued-cloud-tests and
// migration-verify their one suite (the coverage check and the schema drift check, task 700f2b68).
const BASE_SUITES_OF_JOB = { 'ci-suites': ['components', 'pinned-registries', 'mechanical-outputs', 'ci-deps-entry'],
  'clued-cloud-tests': ['clued-cloud'], 'migration-verify': ['production-schema'] };
for (const [file, id] of BASELINE_JOBS) {
  const label = `${path.basename(file)} ${id}`;
  const step = baselineStep(file, id);
  const skip = shellCommand(step.shell) ? false : `no ${step.shell} for this platform`;
  test(`bors staging, ${label}: the trusted base of a multi-member S is the chain root T, never S^1`, { skip }, (t) => {
    const repo = trainCheckout(t);
    for (const s of [repo.two, repo.three]) {
      const r = runBaseline(t, step, repo.dir, { ...STAGING, STAGING_SHA: s });
      assert.equal(r.status, 0, r.log);
      assert.deepEqual(r.outputs, { sha: repo.T, ci_base: repo.T }, r.log);
    }
  });
  test(`bors staging, ${label}: a one-member S keeps T = S^1; a main push measures from before, a pull request from its merge's first parent`, { skip }, (t) => {
    const repo = trainCheckout(t);
    const one = runBaseline(t, step, repo.dir, { ...STAGING, STAGING_SHA: repo.one });
    assert.equal(one.status, 0, one.log);
    assert.deepEqual(one.outputs, { sha: repo.T, ci_base: repo.T }, one.log);
    assert.deepEqual(one.env, { CI_BASE_SHA: repo.T }, one.log);
    const main = runBaseline(t, step, repo.dir, { EVENT_NAME: 'push', PUSH_REF: 'refs/heads/main', STAGING_SHA: repo.one, event: { before: repo.T } });
    assert.equal(main.status, 0, main.log);
    assert.deepEqual(main.outputs, { ci_base: repo.T }, main.log);
    assert.deepEqual(main.env, { CI_BASE_SHA: repo.T }, main.log);
    const pr = runBaseline(t, step, repo.dir, { EVENT_NAME: 'pull_request', PUSH_REF: 'refs/pull/9/merge', STAGING_SHA: repo.one,
      event: { pull_request: { base: { sha: repo.T }, head: { sha: repo.H1 } } } });
    assert.equal(pr.status, 0, pr.log);
    assert.deepEqual(pr.outputs, { ci_base: repo.T }, pr.log);
    assert.deepEqual(pr.env, { CI_BASE_SHA: repo.T }, pr.log);
  });
  test(`bors staging, ${label}: a chain that does not reach main through train merges gives no trusted base`, { skip }, (t) => {
    const repo = trainCheckout(t);
    // Rooted off main; a non-merge step; a non-merge S on main (git drops the repeated parent: the old S^1 check let it
    // through); a member head already on main; S itself on main.
    for (const s of [repo.offMain, repo.single, repo.commit(repo.T, repo.T), repo.commit(repo.one, repo.T), repo.T]) {
      const r = runBaseline(t, step, repo.dir, { ...STAGING, STAGING_SHA: s });
      assert.notEqual(r.status, 0, `${s}: ${r.log}`);
      assert.equal(r.outputs.sha, undefined, r.log);
    }
  });
  // Task 6cd46765 (FABLE-dispatch-base-20261122 §2.2, §4): a lost-run dispatch tests the PR branch head itself, not a
  // merge with main, so its CI_BASE_SHA is the main commit the head is based on, git merge-base origin/main <head>: always
  // an ancestor of the head, unlike main's newest commit once main has moved on. The trusted checkout keeps main (sha=
  // stays unset). The Windows job gets the same branch with its own dispatch trigger (PR-2).
  if (file !== LINUX_WORKFLOW) continue;
  const DISPATCH = { EVENT_NAME: 'workflow_dispatch', PUSH_REF: 'refs/heads/claude/some-branch' };
  // origin/main moves T -> M2; the branch H1 forked at T; the train App's merge of main into it gives caughtUp.
  const dispatchCheckout = (t) => {
    const repo = trainCheckout(t);
    const M2 = repo.commit(repo.T);
    repo.git('update-ref', 'refs/remotes/origin/main', M2);
    return { ...repo, M2, caughtUp: repo.commit(repo.H1, M2), behind: repo.commit(repo.H1) };
  };
  const isAncestor = (repo, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo.dir }).status === 0;
  test(`lost-run dispatch, ${label}: a head that just merged main is measured against that main commit, origin/main`, { skip }, (t) => {
    const repo = dispatchCheckout(t);
    const r = runBaseline(t, step, repo.dir, { ...DISPATCH, STAGING_SHA: repo.caughtUp });
    assert.equal(r.status, 0, r.log);
    assert.deepEqual(r.outputs, { ci_base: repo.M2 }, r.log);
  });
  test(`lost-run dispatch, ${label}: a head behind main is measured against its fork point, never main's newest commit`, { skip }, (t) => {
    const repo = dispatchCheckout(t);
    for (const head of [repo.H1, repo.behind]) {
      const r = runBaseline(t, step, repo.dir, { ...DISPATCH, STAGING_SHA: head });
      assert.equal(r.status, 0, r.log);
      assert.deepEqual(r.outputs, { ci_base: repo.T }, r.log);
      assert.ok(isAncestor(repo, r.outputs.ci_base, head), 'the base is an ancestor of the tested head');
      assert.ok(!isAncestor(repo, repo.M2, head), 'main has moved past the head: main\'s newest commit would not be');
    }
  });
  test(`lost-run dispatch, ${label}: a head with no history in common with main, or an event without a base, fails the step`, { skip }, (t) => {
    const repo = dispatchCheckout(t);
    const unrelated = runBaseline(t, step, repo.dir, { ...DISPATCH, STAGING_SHA: repo.commit(repo.commit()) });
    assert.notEqual(unrelated.status, 0, unrelated.log);
    assert.deepEqual(unrelated.outputs, {}, unrelated.log);
    // A later trigger that nobody gave a base must fail here, not hand the suites an empty CI_BASE_SHA.
    for (const EVENT_NAME of ['schedule', 'merge_group', 'repository_dispatch', '']) {
      const r = runBaseline(t, step, repo.dir, { EVENT_NAME, PUSH_REF: 'refs/heads/main', STAGING_SHA: repo.caughtUp });
      assert.notEqual(r.status, 0, `${EVENT_NAME}: ${r.log}`);
      assert.deepEqual(r.outputs, {}, `${EVENT_NAME}: ${r.log}`);
    }
    // GitHub's merge of the head H1 into main M2: the base is M2, the merge's first parent, whatever base.sha says.
    const pr = runBaseline(t, step, repo.dir, { EVENT_NAME: 'pull_request', PUSH_REF: 'refs/pull/9/merge', STAGING_SHA: repo.commit(repo.M2, repo.H1),
      event: { pull_request: { base: { sha: repo.T }, head: { sha: repo.H1 } } } });
    assert.equal(pr.status, 0, pr.log);
    assert.deepEqual(pr.outputs, { ci_base: repo.M2 }, pr.log);
  });
  const baseSuites = BASE_SUITES_OF_JOB[id];
  if (!baseSuites) continue;
  // The consumer, end to end: what the step wrote to GITHUB_ENV (that no step sets CI_BASE_SHA itself is checked once, in
  // ci-base.test.mjs), then the selector expanding every command of the job's suites that take {base}. Before the
  // dispatch fix this threw 'CI_BASE_SHA is required for this suite', as in the run's log.
  test(`lost-run dispatch, ${label}: the suites that compare with a base get the merge-base commit`, { skip }, (t) => {
    const repo = dispatchCheckout(t);
    for (const [head, expected] of [[repo.caughtUp, repo.M2], [repo.behind, repo.T]]) {
      const r = runBaseline(t, step, repo.dir, { ...DISPATCH, STAGING_SHA: head });
      assert.equal(r.status, 0, r.log);
      const base = r.env.CI_BASE_SHA ?? '';
      for (const suite of baseSuites) {
        let compared = 0;
        for (const command of SUITE_COMMANDS[suite]) {
          const argv = expandArgv(command.argv, { cwd: path.join(ROOT, command.cwd), root: ROOT, base, report: path.join(repo.dir, 'r.json') });
          const at = argv.indexOf('--base');
          if (at < 0) continue;
          assert.equal(argv[at + 1], expected, `${suite}: ${argv.join(' ')}`);
          compared++;
        }
        // clued-cloud: the coverage check and the real-clock debt check (Task 11092b8b); the others: one command each.
        const expectedCount = suite === 'clued-cloud' ? 2 : 1;
        assert.equal(compared, expectedCount, `${suite} compares with the base ${expectedCount} time(s)`);
      }
      assert.equal(base, expected, r.log);
      assert.ok(isAncestor(repo, base, head), 'the suites compare the head with one of its own ancestors');
    }
  });
}

// T2 (Task 11092b8b, PLAN-mainpush-flaky-rerun-20261124 §3): in a CI job (GITHUB_ACTIONS=true) a step that runs suites without a base commit is wired wrong: the
// selector starts nothing and fails, naming CI_BASE_SHA, so the change that drops the line fails in its own pull request.
// The selector here is this one with a ci-suites table of one suite whose command only leaves a file behind.
test('in a CI job, --run and --run-selected without a base commit start no command and name CI_BASE_SHA', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-no-base-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tools = path.join(dir, 'tools');
  mkdirSync(tools);
  for (const name of SELECTOR_IMPORTS) copyFileSync(path.join(ROOT, 'scripts/ci', name), path.join(tools, name));
  const tail = `for (const key of Object.keys(SUITES['ci-suites'])) delete SUITES['ci-suites'][key];
SUITES['ci-suites']['retrigger-counter'] = ['**'];
delete SUITE_PLATFORMS['retrigger-counter'];
SUITE_COMMANDS['retrigger-counter'] = [{ cwd: '.', argv: ['node', '-e', "require('node:fs').writeFileSync('started', '')"] }];`;
  const selector = path.join(tools, 'ci-required-selection.mjs');
  writeFileSync(selector, `${readFileSync(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), 'utf8')}\n${tail}\n`);
  const root = path.join(dir, 'checkout');
  mkdirSync(root);
  const started = path.join(root, 'started');
  const run = (args, base) => {
    const env = { ...process.env, GITHUB_ACTIONS: 'true' };
    for (const name of ['NODE_TEST_CONTEXT', 'CI_BASE_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY',
      'CLUED_CI_HOST_LACKS']) delete env[name];
    if (base !== undefined) env.CI_BASE_SHA = base;
    return spawnSync(process.execPath, [selector, ...args, '--root', root], { env, encoding: 'utf8', timeout: 60_000 });
  };
  for (const args of [['--run', 'retrigger-counter'], ['--run-selected', 'ci-suites']]) {
    // The fixture sees a command start: with a base the command runs.
    const wired = run(args, 'a'.repeat(40));
    assert.equal(wired.status, 0, `${args.join(' ')}: ${wired.stdout}${wired.stderr}`);
    assert.ok(existsSync(started), `${args.join(' ')} with a base runs the command`);
    rmSync(started);
    for (const base of [undefined, '', '0'.repeat(40), 'unset']) {
      const r = run(args, base);
      const where = `${args.join(' ')}, CI_BASE_SHA=${JSON.stringify(base)}: ${r.stdout}${r.stderr}`;
      assert.notEqual(r.status, 0, where);
      assert.equal(existsSync(started), false, `no command starts\n${where}`);
      assert.match(r.stdout + r.stderr, /CI_BASE_SHA/, where);
    }
  }
});

// T3 (same plan as T2): outside a CI job nothing changes: a local --run without a base runs its suite (and a failed command is then
// not run again: ci-required-selection-flaky.test.mjs G).
test('a local --run without a base commit runs its suite', async (t) => {
  const start = slotFixture(t);
  const run = start('local-no-base', { body: "console.log('ran without a base');\n", extraEnv: { CI_BASE_SHA: undefined } });
  assert.deepEqual(await run.done, [0, null], run.output());
  assert.match(run.output(), /ran without a base/);
});

// The release door flow test runs the release workflow's steps and the grant script against a database, so a change to
// either runs it (FABLE-release-identity-autonomous-20261119 §3.1 tests 8 to 12).
test('the release workflow and its grant script select the release door flow database test', () => {
  for (const file of ['.github/workflows/clued-cloud-production-release.yml', 'scripts/ci/clued-release-door.mjs',
    'apps/clued-cloud/tests/production-release-door-flow-db.test.mjs', 'apps/clued-cloud/tests/release-door-psql-fixture.mjs']) {
    assert.deepEqual(selectSuites('migration-verify', [file], 'linux').suites, ['production-schema'], file);
  }
  assert.ok(SUITE_COMMANDS['production-schema'].find(({ argv }) => argv.includes('--test-force-exit')).argv.includes('tests/production-release-door-flow-db.test.mjs'));
});

// --run-files: point-in-time reproduction of named test files through the same suite command.
const RESIDENT_DIR = 'work/independent-ci-resident-v1';
const spawnRecorder = (status = 0) => {
  const calls = [];
  const spawn = (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); return { status }; };
  return { calls, spawn };
};
const spawnForbidden = () => { throw new Error('no command may start'); };

test('run-files 1: resident-node runs only the named file with the CI command shape', () => {
  const all = readdirSync(path.join(ROOT, RESIDENT_DIR, 'test')).filter((name) => name.endsWith('.test.mjs')).sort();
  assert.ok(all.length > 1);
  const { calls, spawn } = spawnRecorder();
  assert.equal(executeSuite('resident-node', { root: ROOT, env: {}, spawn, log, files: [`${RESIDENT_DIR}/test/${all[0]}`] }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--test', `test/${all[0]}`]);
  assert.equal(calls[0].cwd, path.join(ROOT, RESIDENT_DIR));
});

test('run-files 2: a file the suite does not run is refused with the accepted range, nothing starts', () => {
  const lines = [];
  assert.equal(executeSuite('resident-node', { root: ROOT, env: {}, spawn: spawnForbidden, log: (line) => lines.push(line),
    files: ['scripts/ci/ci-required-selection.test.mjs'] }), 2);
  assert.match(lines.join('\n'), /scripts\/ci\/ci-required-selection\.test\.mjs/);
  assert.match(lines.join('\n'), new RegExp(`${RESIDENT_DIR}/test/`));
});

test('run-files 3: a file that does not exist is refused, nothing starts', () => {
  const lines = [];
  assert.equal(executeSuite('resident-node', { root: ROOT, env: {}, spawn: spawnForbidden, log: (line) => lines.push(line),
    files: [`${RESIDENT_DIR}/test/no-such-file.test.mjs`] }), 2);
  assert.match(lines.join('\n'), /no-such-file\.test\.mjs/);
  assert.equal(executeSuite('resident-node', { root: ROOT, env: {}, spawn: spawnForbidden, log, files: [] }), 2, 'no files named');
  assert.equal(executeSuite('resident-node', { root: ROOT, env: {}, spawn: spawnForbidden, log, files: ['../outside.test.mjs'] }), 2);
});

test('run-files 4: resident-python discovers the named file only and skips the other directory', () => {
  const named = readdirSync(path.join(ROOT, RESIDENT_DIR, 'test')).find((name) => /^test_.*\.py$/.test(name));
  const { calls, spawn } = spawnRecorder();
  assert.equal(executeSuite('resident-python', { root: ROOT, env: {}, spawn, log, files: [`${RESIDENT_DIR}/test/${named}`] }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-5), ['discover', '-s', 'test', '-p', named]);
  assert.equal(calls[0].cwd, path.join(ROOT, RESIDENT_DIR));
});

test('run-files 5: validators, lint, typecheck and build are skipped; the test runner flags stay', () => {
  const governance = readdirSync(path.join(ROOT, 'scripts/ci/self-hosted/node-governance')).find((name) => name.endsWith('.test.mjs'));
  const node = spawnRecorder();
  assert.equal(executeSuite('node-governance', { root: ROOT, env: {}, spawn: node.spawn, log,
    files: [`scripts/ci/self-hosted/node-governance/${governance}`] }), 0);
  assert.equal(node.calls.length, 1);
  assert.ok(!node.calls.some((call) => call.args.some((arg) => /validate_node_profiles/.test(arg))));

  const unit = unitTestFiles(path.join(ROOT, 'apps/clued-cloud'))[0];
  const cloud = spawnRecorder();
  assert.equal(executeSuite('clued-cloud', { root: ROOT, env: {}, spawn: cloud.spawn, log, platform: 'linux',
    readReportFile: () => JSON.stringify({ type: 'summary', counts: {}, success: true }), files: [`apps/clued-cloud/${unit}`] }), 0);
  assert.equal(cloud.calls.length, 1);
  assert.ok(cloud.calls[0].args.includes(unit));
  assert.ok(!cloud.calls.some((call) => ['lint', 'typecheck', 'build', 'ledger:verify'].some((word) => call.args.includes(word))));

  const guarded = SUITE_COMMANDS['production-schema'].find((command) => command.argv.includes('--test-force-exit')).argv.at(-1);
  const schema = spawnRecorder();
  assert.equal(executeSuite('production-schema', { root: ROOT, env: {}, spawn: schema.spawn, log, files: [`apps/clued-cloud/${guarded}`] }), 0);
  const kept = schema.calls.find((call) => call.args.includes(guarded));
  assert.ok(kept.args.includes('--test-force-exit'));
  assert.ok(kept.args.some((arg) => arg.startsWith('--test-concurrency=')));
  assert.ok(!kept.args.includes('tests/production-schema-drift.test.mjs'));
});

test('run-files 6: known failures count only for the named files', () => {
  const a = 'scripts/ci/clued-work-admission.test.mjs';
  const b = 'scripts/ci/merge-admission-policy.test.mjs';
  const entry = (file) => ({ file, path: ['old'], fingerprint: '2'.repeat(16), reason: 'r' });
  const known = { 'admission-self-tests': [entry(a), entry(b)] };
  const summary = { type: 'summary', counts: {}, success: true };
  const report = (events) => () => events.map((event) => JSON.stringify(event)).join('\n');
  const abs = (file) => path.join(ROOT, file);
  const lines = [];
  const first = spawnRecorder(0);
  assert.equal(executeSuite('admission-self-tests', { root: ROOT, env: { RUNNER_TEMP: os.tmpdir() }, spawn: first.spawn, known, files: [a],
    log: (line) => lines.push(line), readReportFile: report([{ type: 'pass', file: abs(a), path: ['old'] }, summary]) }), 0);
  assert.ok(first.calls[0].args.includes(a) && !first.calls[0].args.includes(b));
  assert.ok(!lines.some((line) => line.includes(b)), 'the entry of the file that did not run is not reported');
  const second = spawnRecorder(1);
  assert.equal(executeSuite('admission-self-tests', { root: ROOT, env: { RUNNER_TEMP: os.tmpdir() }, spawn: second.spawn, known, files: [a], log,
    readReportFile: report([{ type: 'fail', file: abs(a), path: ['new one'], fingerprint: '3'.repeat(16) }, summary]) }), 1);
});

test('run-files 7: command line refuses GitHub Actions and a missing file list and documents itself', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/ci/ci-required-selection.mjs', ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env } });
  const ci = run(['--run-files', 'retrigger-counter', 'scripts/ci/retrigger-counter.test.mjs'], { GITHUB_ACTIONS: 'true' });
  assert.equal(ci.status, 2);
  assert.match(ci.stdout + ci.stderr, /GITHUB_ACTIONS/);
  const none = run(['--run-files', 'retrigger-counter']);
  assert.equal(none.status, 2);
  assert.match(none.stdout + none.stderr, /run-files/);
  assert.equal(run(['--run-files', 'no-such-suite', 'x.test.mjs']).status, 2);
  const help = run(['--help']);
  assert.match(help.stdout, /--run-files <suite> <file>/);
});

test('run-files 8: a targeted run takes a slot and queues behind two holders', async (t) => {
  const start = slotFixture(t);
  const holders = await fillSuiteSlots(start);
  const waiting = start('waiting', { mode: '--run-files' });
  await waitForQueuedSuite(waiting, holders);
  holders[0].release();
  await waitForSlotFixture(waiting, waiting.ready);
  waiting.release();
  assert.deepEqual(await waiting.done, [0, null]);
  assert.match(waiting.output(), /run-files retrigger-counter: 1 .*0/);
});

test('run-files 9: the named test file decides the exit code in a real run', async (t) => {
  const start = slotFixture(t);
  const red = start('red', { mode: '--run-files', body: 'throw new Error("fails before the fix");\n' });
  assert.deepEqual(await red.done, [1, null]);
  assert.match(red.output(), /scripts\/ci\/retrigger-counter\.test\.mjs/);
  assert.match(red.output(), /不是套件结论/);
  const green = start('green', { mode: '--run-files', body: 'process.exitCode = 0;\n' });
  assert.deepEqual(await green.done, [0, null]);
  assert.match(green.output(), /不是套件结论/);
});

test('run-files 10: only the named file of a multi-file suite reaches the worker and runs', async (t) => {
  const start = slotFixture(t);
  const marker = (name) => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(name)}, '');
`;
  const run = start('multi', { mode: '--run-files', suite: 'ci-deps-entry', named: ['scripts/ci/ci-deps.test.mjs'],
    extraFiles: { 'scripts/ci/ci-deps.test.mjs': marker('ran-named'), 'scripts/ci/check-ci-deps-entry.test.mjs': marker('ran-other') } });
  assert.deepEqual(await run.done, [0, null]);
  assert.ok(existsSync(path.join(run.root, 'ran-named')), 'the named file ran');
  assert.ok(!existsSync(path.join(run.root, 'ran-other')), 'the other file of the suite did not run');
});

// R2 review (11-21): a database test named for a local targeted run, in a fresh worktree, failed on its first import
// (ERR_MODULE_NOT_FOUND): nothing gave the checkout the application's dependencies, which CI installs in the job and
// local-verify links from its store. The entry links them from that same store before the run.
test('run-files 11: a local run links the application dependencies a fresh checkout lacks before its database test runs', async (t) => {
  const start = slotFixture(t);
  const home = mkdtempSync(path.join(os.tmpdir(), 'clued-run-files-deps-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const packageJson = JSON.stringify({ name: 'fixture-app', private: true, dependencies: { 'fixture-dep': '1.0.0' } });
  const lock = JSON.stringify({ name: 'fixture-app', lockfileVersion: 3, packages: { '': {}, 'node_modules/fixture-dep': { version: '1.0.0' } } });
  const { dependencyKey } = await import('./local-verify.mjs');
  // A store local-verify installed for this lockfile: complete, nothing to install or rebuild.
  const ready = path.join(home, 'node_modules', dependencyKey({ lock: Buffer.from(lock), packageJson: Buffer.from(packageJson) }));
  const dep = path.join(ready, 'node_modules', 'fixture-dep');
  mkdirSync(dep, { recursive: true });
  writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0', main: 'index.js' }));
  writeFileSync(path.join(dep, 'index.js'), 'module.exports = 42;\n');
  writeFileSync(path.join(ready, 'package-lock.json'), lock);
  writeFileSync(path.join(ready, 'complete'), '');
  const file = 'apps/clued-cloud/tests/ci-scan-start-native-db.test.mjs';
  const run = start('deps', { mode: '--run-files', suite: 'production-schema', named: [file], extraEnv: { CLUED_LOCAL_VERIFY_HOME: home },
    extraFiles: { 'apps/clued-cloud/package.json': packageJson, 'apps/clued-cloud/package-lock.json': lock,
      [file]: "import assert from 'node:assert/strict';\nimport value from 'fixture-dep';\nassert.equal(value, 42);\n" } });
  assert.deepEqual(await run.done, [0, null], run.output());
  assert.equal(realpathSync(path.join(run.root, 'apps/clued-cloud/node_modules')), realpathSync(path.join(ready, 'node_modules')));
});

// R2 review (11-21): database tests named to clued-cloud were refused with a list of what clued-cloud runs, and
// migration-verify was refused as an unknown suite; production-schema runs them, and nothing said so.
test('run-files 12: a refused file names the suite that runs it or why none does; a check name names its suites', async () => {
  const lines = [];
  const db = 'apps/clued-cloud/tests/storage-semantic-recovery-db.test.mjs';
  const uncovered = 'apps/clued-cloud/tests/work-claims-handover-execution-db.test.mjs';
  assert.equal(await selection.runSuite('clued-cloud', { root: ROOT, env: {}, log: (line) => lines.push(line), files: [db, uncovered] }), 2);
  const text = lines.join('\n');
  assert.match(text, new RegExp(`--run-files production-schema ${db}`));
  assert.match(text, /work-claims-handover-execution-db\.test\.mjs: no required suite runs it \(scripts\/ci\/ci-uncovered-tests\.json/);
  const check = spawnSync(process.execPath, ['scripts/ci/ci-required-selection.mjs', '--run-files', 'migration-verify', db],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(check.status, 2);
  assert.match(check.stdout + check.stderr, /migration-verify is a required check, not a suite; its suites: production-schema/);
});

// 11-22, 11-24 (task 0d2fb345): the entry, named a file clued-cloud refuses, printed nothing and exited 13 ("unsettled
// top-level await"). The refusal loads check-tests-covered.mjs, which imports this module, while the entry awaited main at
// top level: each waited for the other. run-files 12 calls runSuite in this process and never saw it; here the entry runs
// as a process. The refused file a running test imports (main-entry-realpath.test.mjs, imported by local-dev-tools.test.mjs,
// which clued-cloud runs) was also said to run in no suite.
test('run-files 13: the entry refuses with its reason and exit 2 a file no suite runs and one only a running test imports', () => {
  const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { tests } = JSON.parse(readFileSync(path.join(ROOT, 'scripts/ci/ci-uncovered-tests.json'), 'utf8'));
  const uncovered = tests.find((entry) => !entry.path.includes('*') && entry.path.endsWith('.test.mjs') && existsSync(path.join(ROOT, entry.path))).path;
  const imported = 'scripts/ci/main-entry-realpath.test.mjs';
  const importer = 'apps/clued-cloud/tests/local-dev-tools.test.mjs';
  assert.match(readFileSync(path.join(ROOT, importer), 'utf8'), /import '\.\.\/\.\.\/\.\.\/scripts\/ci\/main-entry-realpath\.test\.mjs';/);
  const run = spawnSync(process.execPath, ['scripts/ci/ci-required-selection.mjs', '--run-files', 'clued-cloud', uncovered, imported],
    { cwd: ROOT, encoding: 'utf8', input: '', timeout: 120_000, env: { ...process.env, GITHUB_ACTIONS: '' } });
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 2, output);
  assert.doesNotMatch(output, /unsettled top-level await/);
  assert.match(output, new RegExp(`^run-files clued-cloud: suite clued-cloud does not run: ${quote(uncovered)}, ${quote(imported)}$`, 'm'));
  assert.match(output, new RegExp(`^${quote(uncovered)}: no required suite runs it \\(scripts/ci/ci-uncovered-tests\\.json: `, 'm'));
  assert.match(output, new RegExp(`^${quote(imported)} runs in clued-cloud imported by ${quote(importer)}: --run-files clued-cloud ${quote(importer)}$`, 'm'));
});

// What the entry awaits may never settle (a module cycle, a promise nothing resolves): Node then ends the process with the
// event loop empty. The entry says so and exits 1, not 13 or 0 with nothing said; a result or an error still decides the exit.
test('the entry reports an exit before its run settled, and exits with the run\'s result or error otherwise', () => {
  const entry = pathToFileURL(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs')).href;
  const run = (body) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { runEntry } from ${JSON.stringify(entry)};\n${body}`],
    { encoding: 'utf8', input: '', timeout: 60_000, env: { ...process.env, GITHUB_ACTIONS: '' } });
  const hung = run('runEntry(() => new Promise(() => {}));');
  assert.equal(hung.status, 1, hung.stdout + hung.stderr);
  assert.match(hung.stderr, /^ci-required-selection: ended before the run finished: a step it awaited never settled/m);
  const refused = run('runEntry(async () => 2);');
  assert.deepEqual([refused.status, refused.stderr], [2, '']);
  const failed = run("runEntry(async () => { throw new Error('no such checkout'); });");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^ci-required-selection: no such checkout$/m);
});

// 11-21 17:03: four suite entries on the machine at once (a clued-cloud run, then three resident-node runs within a
// minute) were read as four running suites. Their logs show two holders and two queued. Entries that start together
// hold at most two slots; the others wait and say so, and one starts per freed slot.
test('four local runs started together hold at most two slots; the other two queue', async (t) => {
  const start = slotFixture(t);
  const runs = ['a', 'b', 'c', 'd'].map((name) => start(name));
  const ready = () => runs.filter((run) => run.ready());
  await waitForSlotFixture(runs[0], () => ready().length >= 2);
  const waiting = runs.filter((run) => !run.ready());
  for (const run of waiting) await waitForSlotFixture(run, () => run.ready() || /queue position [12]/.test(run.output()));
  assert.equal(ready().length, 2, runs.map((run) => run.output()).join('\n'));
  const [first] = ready();
  first.release();
  assert.deepEqual(await first.done, [0, null]);
  await waitForSlotFixture(waiting[0], () => ready().length >= 3);
  await delay(1_000);
  assert.equal(ready().length, 3, 'one freed slot starts exactly one waiting run');
});

// Task 04f9b91b (FABLE-hosted-windows-suites §2.3): a host says what it lacks (CLUED_CI_HOST_LACKS, set by the hosted
// workflow only), a test says what it needs in its own name ([needs:<capability>]); the entry adds Node's skip pattern for
// those names to every node --test command, so neither side lists the other. A run of the real Node test runner on a
// fixture pins the behaviour: a marked test and every subtest under it, and a marked subtest of an unmarked parent, do not
// run; everything else does. Without the variable the commands are unchanged; an unknown capability runs nothing.
const HOST_LACKS_FIXTURE = `import test from 'node:test';
import { appendFileSync } from 'node:fs';
const ran = (name) => appendFileSync(process.env.HOST_LACKS_RAN, name + '\\n');
test('marked parent [needs:non-elevated]', async (t) => { ran('marked parent'); await t.test('child of the marked parent', () => ran('child of the marked parent')); });
test('unmarked parent', async (t) => {
  ran('unmarked parent');
  await t.test('marked child [needs:non-elevated]', () => ran('marked child'));
  await t.test('unmarked child', () => ran('unmarked child'));
});
test('needs non-elevated in words only, no marker', () => ran('words only'));
`;

function hostLacksArgv(env, id = 'retrigger-counter') {
  const calls = [];
  const lines = [];
  const status = executeSuite(id, { root: ROOT, env: { CI_BASE_SHA: 'b', ...env }, log: (line) => lines.push(String(line)),
    // The trusted reporter the entry adds for the run again in full (its directory differs each run) is not what these compare.
    spawn: (command, args) => { calls.push([command, ...args].filter((arg) => !arg.startsWith('--test-reporter'))); return { status: 0 }; } });
  return { status, calls, lines };
}

function testsThatRan(t, switches) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clued-host-lacks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'host-lacks-fixture.test.mjs');
  const ranFile = path.join(dir, 'ran.txt');
  writeFileSync(file, HOST_LACKS_FIXTURE);
  writeFileSync(ranFile, '');
  const env = { ...process.env, HOST_LACKS_RAN: ranFile };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...switches, file], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return readFileSync(ranFile, 'utf8').split('\n').filter(Boolean).sort();
}

test('CLUED_CI_HOST_LACKS=non-elevated: the [needs:non-elevated] tests and their subtests do not run; the others do', (t) => {
  const plain = hostLacksArgv({});
  assert.equal(plain.status, 0);
  const lacking = hostLacksArgv({ CLUED_CI_HOST_LACKS: 'non-elevated' });
  assert.equal(lacking.status, 0, lacking.lines.join('\n'));
  assert.equal(lacking.calls.length, plain.calls.length);
  const [argv] = lacking.calls;
  const testAt = argv.indexOf('--test');
  assert.ok(testAt > 0, argv.join(' '));
  const switches = argv.filter((arg) => arg.startsWith('--test-skip-pattern'));
  assert.equal(switches.length, 1, `one skip pattern after --test: ${argv.join(' ')}`);
  assert.equal(argv[testAt + 1], switches[0], 'the skip pattern follows --test (before any test file)');
  assert.deepEqual(argv.filter((arg) => !switches.includes(arg)), plain.calls[0], 'nothing else changes');
  assert.ok(lacking.lines.some((line) => line.includes('non-elevated') && line.includes('[needs:non-elevated]')),
    `the log says what does not run here:\n${lacking.lines.join('\n')}`);
  // The real Node test runner, with the switch the entry gave: a marked test is not run, nor anything under it.
  assert.deepEqual(testsThatRan(t, switches), ['unmarked child', 'unmarked parent', 'words only']);
  // The same fixture without it runs everything: the marker alone skips nothing.
  assert.deepEqual(testsThatRan(t, []), ['child of the marked parent', 'marked child', 'marked parent', 'unmarked child', 'unmarked parent', 'words only']);
});

test('CLUED_CI_HOST_LACKS reaches every node --test command of a suite, the resident one included; unset or empty changes none', () => {
  const plain = hostLacksArgv({}, 'resident-node');
  const empty = hostLacksArgv({ CLUED_CI_HOST_LACKS: '' }, 'resident-node');
  assert.deepEqual(empty.calls, plain.calls, 'an empty value is no capability missing');
  assert.ok(plain.calls.length > 0 && plain.calls.every((argv) => !argv.some((arg) => arg.startsWith('--test-skip-pattern'))));
  const lacking = hostLacksArgv({ CLUED_CI_HOST_LACKS: 'non-elevated' }, 'resident-node');
  assert.equal(lacking.calls.length, plain.calls.length);
  for (const argv of lacking.calls) assert.equal(argv.filter((arg) => arg.startsWith('--test-skip-pattern')).length, 1, argv.slice(0, 4).join(' '));
});

test('a CLUED_CI_HOST_LACKS value the entry does not know runs nothing (exit 2) and names the known ones', async () => {
  for (const value of ['tpm', 'non-elevated,tpm', 'Non-Elevated']) {
    const { status, calls, lines } = hostLacksArgv({ CLUED_CI_HOST_LACKS: value });
    assert.equal(status, 2, `${value}: ${lines.join('\n')}`);
    assert.deepEqual(calls, [], `${value}: no command starts`);
    assert.ok(lines.some((line) => line.includes('CLUED_CI_HOST_LACKS') && line.includes('non-elevated')), lines.join('\n'));
  }
  // The job step (--run-selected) refuses before any suite, and says so in the step summary.
  const ran = [];
  const summary = [];
  const status = await runSelected(['retrigger-counter'], { root: ROOT, env: { CLUED_CI_HOST_LACKS: 'tpm' }, log,
    run: async (id) => { ran.push(id); return 0; }, summary: (text) => summary.push(text) });
  assert.equal(status, 2);
  assert.deepEqual(ran, []);
  assert.match(summary.join(''), /CLUED_CI_HOST_LACKS/);
  // A known value: the summary says what does not run on this host, and the suites run.
  const okSummary = [];
  assert.equal(await runSelected(['retrigger-counter'], { root: ROOT, env: { CLUED_CI_HOST_LACKS: 'non-elevated' }, log,
    run: async () => 0, summary: (text) => okSummary.push(text) }), 0);
  assert.match(okSummary.join(''), /\[needs:non-elevated\]/);
});

// --shard i/n (PLAN-hosted-windows-speed-20261123 block 3, V2). Every suite this file has runs through the real runSelected
// and executeSuite with a recording spawn: the shards of each n together run the unsharded plan's units, each exactly once
// (a test file operand of a listing command, or a whole command), in its order; 1/1 runs today's plan command for command.
const shardRecord = (calls) => (command, args, options) => {
  // The reporter's destination is a fresh temporary directory per command: not part of the plan.
  calls.push({ cwd: path.relative(ROOT, options.cwd).replaceAll('\\', '/'),
    argv: [command, ...args].filter((arg) => !arg.startsWith('--test-reporter')) });
  return { status: 0 };
};
const isBuild = ({ argv }) => argv.join(' ') === 'npm run build';
function shardUnits(calls) {
  const units = [];
  for (const { cwd, argv } of calls.filter((call) => !isBuild(call))) {
    const testAt = argv.indexOf('--test');
    const unittestAt = argv.findIndex((arg, i) => arg === 'unittest' && argv[i - 1] === '-m');
    const anchor = testAt >= 0 ? testAt : unittestAt >= 0 && argv[unittestAt + 1] !== 'discover' ? unittestAt : -1;
    const operands = anchor < 0 ? [] : argv.filter((arg, i) => i > anchor && !arg.startsWith('-'));
    if (operands.length === 0) {
      units.push(JSON.stringify([cwd, argv]));
      continue;
    }
    const switches = argv.filter((arg, i) => i <= anchor || arg.startsWith('-'));
    for (const file of operands) units.push(JSON.stringify([cwd, switches, file]));
  }
  return units;
}
async function shardRun(suites, shard, env, options = {}) {
  const calls = [];
  const run = (id, options) => executeSuite(id, { ...options, spawn: shardRecord(calls), platform: 'linux', known: {},
    readReportFile: () => JSON.stringify({ type: 'summary', counts: {}, success: true }) });
  assert.equal(await runSelected(suites, { root: ROOT, env, log, run, ...(shard ? { shard } : {}), ...options }), 0);
  return calls;
}

test('--shard: heavy files in different commands stay below the modeled shard limit', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-binpack-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const id = 'retrigger-counter';
  const original = SUITE_COMMANDS[id];
  t.after(() => { SUITE_COMMANDS[id] = original; });
  SUITE_COMMANDS[id] = [
    { cwd: '.', argv: ['node', '--test', 'first.test.mjs', 'light.test.mjs'] },
    { cwd: '.', argv: ['node', '--test', 'second.test.mjs'] },
  ];
  const weights = { 'first.test.mjs': 100, 'second.test.mjs': 100, 'light.test.mjs': 1 };
  const shardSecondsFile = path.join(temp, 'table.json');
  writeFileSync(shardSecondsFile, JSON.stringify(weights));
  const loads = [];
  for (const index of [1, 2]) {
    const calls = [];
    const run = (suite, options) => executeSuite(suite, { ...options, platform: 'linux', known: {},
      shardSecondsFile, spawn: shardRecord(calls) });
    assert.equal(await runSelected([id], { root: ROOT, env: { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp }, log, run,
      check: 'ci-suites', platform: 'linux', shardSecondsFile, shard: { index, total: 2 } }), 0);
    loads.push(calls.flatMap(({ argv }) => argv).reduce((sum, arg) => sum + (weights[arg] ?? 0), 0));
  }
  assert.deepEqual(loads.sort((a, b) => a - b), [100, 101]);
});

test('--shard: both clued-cloud shards build before their tests', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-cloud-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp };
  for (const index of [1, 2]) {
    const calls = await shardRun(['clued-cloud'], { index, total: 2 }, env, { check: 'clued-cloud-tests', platform: 'linux' });
    const build = calls.findIndex(isBuild);
    const tests = calls.findIndex(({ argv }) => argv.includes('scripts/run-tests.mjs'));
    assert.ok(build >= 0 && build < tests, `shard ${index}: build at ${build}, unit tests at ${tests}`);
    assert.equal(calls.filter(isBuild).length, 1, `shard ${index} builds once`);
  }
});

async function assertShardsRunPlanOnce(suites, totals, env, options = {}) {
  const plan = await shardRun(suites, null, env);
  const planUnits = shardUnits(plan);
  for (const total of totals) {
    const shards = [];
    for (let index = 1; index <= total; index += 1) shards.push(await shardRun(suites, { index, total }, env, options));
    if (total === 1) assert.deepEqual(shards[0], plan, `1/1 runs today's plan command for command (${suites.join(' ')})`);
    const units = shards.map(shardUnits);
    // Each unit once: no shard leaves one out, no two shards run the same one.
    assert.deepEqual(units.flat().sort(), [...planUnits].sort(), `the ${total} shards of ${suites.join(' ')} run the plan's units once`);
    for (const part of units) {
      let at = 0;
      for (const unit of part) {
        while (at < planUnits.length && planUnits[at] !== unit) at += 1;
        assert.ok(at < planUnits.length, `a shard runs ${unit} out of the plan's order`);
        at += 1;
      }
    }
    if (options.check && planUnits.length >= total * 4) {
      const sizes = units.map((part) => part.length);
      assert.ok(Math.min(...sizes) > 0, `every one of ${total} shards runs something: ${sizes}`);
    }
  }
}

test('--shard i/n: the shards together run every unit of the plan once, in its order; 1/1 is the plan as it runs today', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp };
  const all = Object.keys(SUITE_COMMANDS);
  // Any selection: every suite, one suite, and orders that put the listing suites at other places.
  const selections = [all, ['resident-node'], [...all].reverse(), all.filter((id, i) => i % 3 !== 1),
    ['offline-drill', 'selection', 'retrigger-counter']];
  for (const suites of selections) await assertShardsRunPlanOnce(suites, [1, 2, 3, 4, 7], env);
});

const hostedPlans = [['migration-verify', 'linux', 4], ['ci-suites', 'linux', 4], ['ci-suites', 'win32', 7], ['clued-cloud-tests', 'linux', 2]];
test('--shard: the hosted plans at their matrix counts run every partitioned unit once', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp };
  for (const [check, platform, total] of hostedPlans) {
    const { suites } = selectSuites(check, null, platform);
    assert.ok(suites.length > 0, `${check} on ${platform} selects something`);
    if (check === 'migration-verify') assert.deepEqual(suites, ['production-schema']);
    await assertShardsRunPlanOnce(suites, [total], env, { check, platform });
  }
});

test('--shard: a listing command runs its shard\'s files with its own switches; its known failures are those files\'', () => {
  const command = { cwd: 'apps/clued-cloud', known: 'clued-cloud', argv: [] };
  const argv = ['node', 'scripts/run-tests.mjs', '--test', '--test-concurrency=2', 'tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs'];
  const only = (file) => ['node', 'scripts/run-tests.mjs', '--test', '--test-concurrency=2', file];
  const listed = new Set(['apps/clued-cloud/tests/a.test.mjs', 'apps/clued-cloud/tests/b.test.mjs', 'apps/clued-cloud/tests/c.test.mjs']);
  assert.deepEqual(selection.shardPart(packedCommand(command, argv, 2), 2),
    { argv: only('tests/b.test.mjs'), units: 3, files: new Set(['apps/clued-cloud/tests/b.test.mjs']), listed });
  const step = packedCommand(command, argv, 4);
  assert.deepEqual(selection.shardPart(step, 4), { argv: null, units: 3, files: null });
  // Not a list of test files: the command is one unit.
  const discover = ['python', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'];
  const whole = packedCommand({ cwd: '.', argv: discover }, discover, 3);
  assert.deepEqual(selection.shardPart(whole, 1), { argv: discover, units: 1, files: null });
  assert.deepEqual(selection.shardPart(whole, 2), { argv: null, units: 1, files: null });

  // The heavier first file takes the first shard, the second file takes the second shard.
  const [first, second] = SUITE_COMMANDS['admission-self-tests'][0].argv.slice(2);
  const firstShard = 1;
  const known = { 'admission-self-tests': [{ file: first, path: ['a'], fingerprint: 'a'.repeat(16), reason: 'r' },
    { file: second, path: ['b'], fingerprint: 'b'.repeat(16), reason: 'r' }] };
  // Its own table, not the repository's: the first file the heaviest and the second the next, so by the packing rule (heaviest first
  // into the lightest shard) they are in different shards whatever seconds the real table has.
  const tableDir = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-seconds-'));
  const shardSecondsFile = path.join(tableDir, 'ci-shard-seconds.json');
  writeFileSync(shardSecondsFile, JSON.stringify({ [first]: 1000, [second]: 999 }));
  const summary = { type: 'summary', counts: {}, success: false };
  const shardOf = (index, events, status) => {
    const lines = [];
    let ran;
    const code = executeSuite('admission-self-tests', { root: ROOT, env: { RUNNER_TEMP: os.tmpdir() }, known, log: (line) => lines.push(line),
      spawn: (command, args) => { ran = args; return { status }; }, shard: { index, total: 2 }, shardSecondsFile,
      readReportFile: () => [...events, summary].map((event) => JSON.stringify(event)).join('\n') });
    return { code, lines: lines.join('\n'), ran };
  };
  const one = shardOf(firstShard, [], 0);
  assert.equal(one.code, 0);
  assert.ok(one.ran.includes(first) && !one.ran.includes(second));
  assert.match(one.lines, new RegExp(`known failure no longer runs::${first} :: a`));
  assert.doesNotMatch(one.lines, new RegExp(second), 'the other shard\'s known failure is not this shard\'s');
  const two = shardOf(3 - firstShard, [{ type: 'fail', file: path.join(ROOT, second), path: ['b'], fingerprint: 'b'.repeat(16) }], 1);
  assert.equal(two.code, 0);
  assert.ok(two.ran.includes(second) && !two.ran.includes(first));
  assert.match(two.lines, new RegExp(`known failure::${second} :: b`));
  assert.doesNotMatch(two.lines, new RegExp(`${first} :: a`), 'the other shard\'s known failure is not this shard\'s');
  rmSync(tableDir, { recursive: true, force: true });
});

test('--shard takes i/n with 1 <= i <= n, splits --run-selected only and runs only in a CI job', async () => {
  assert.deepEqual(selection.parseShard('2/4'), { index: 2, total: 4 });
  assert.deepEqual(selection.parseShard('1/1'), { index: 1, total: 1 });
  for (const bad of ['0/4', '5/4', '1/0', '04/4', '1', '1/2/3', 'a/b', '', undefined]) {
    assert.throws(() => selection.parseShard(bad), /--shard takes i\/n/, String(bad));
  }
  const lines = [];
  const shard = { index: 1, total: 2 };
  assert.equal(await selection.runSuite('retrigger-counter', { root: ROOT, env: {}, log: (line) => lines.push(line), shard }), 2);
  assert.match(lines.join('\n'), /--shard runs only in a CI job/);
  assert.throws(() => executeSuite('retrigger-counter', { root: ROOT, env: {}, log, files: ['scripts/ci/retrigger-counter.test.mjs'], shard }),
    /--shard splits a suite run/);
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), ...args],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  for (const [args, message] of [[['--run-selected', 'ci-suites', '--shard', '3/2'], /--shard takes i\/n/],
    [['--run', 'retrigger-counter', '--shard', '1/2'], /--shard goes with --run-selected only/],
    [['--run-selected', 'ci-suites', '--shard', '1/2'], /--shard runs only in a CI job/]]) {
    const result = cli(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, message);
  }
});

// Review of f574bab16 (REVIEW-hosted-speed-b3-20261124). Each shard selects on its own: one whose list of changed files
// cannot be read runs every suite, the others the real selection. A suite's units go to the same shards whatever else a
// shard selected, so each unit of the real selection still runs exactly once (H1: 39 of 157 files left out, 39 twice).
async function shardRunById(suites, shard, env, { fail = () => false, summary = () => {}, check, platform } = {}) {
  const calls = [];
  const run = (id, options) => executeSuite(id, { ...options, platform: 'linux', known: {},
    spawn: (command, args, opts) => {
      const call = { id, cwd: path.relative(ROOT, opts.cwd).replaceAll('\\', '/'),
        argv: [command, ...args].filter((arg) => !arg.startsWith('--test-reporter')) };
      calls.push(call);
      return { status: fail(call) ? 1 : 0 };
    },
    readReportFile: () => JSON.stringify({ type: 'summary', counts: {}, success: true }) });
  const status = await runSelected(suites, { root: ROOT, env, log, run, summary, check, platform, ...(shard ? { shard } : {}) });
  return { status, calls };
}
const unitsOf = (calls) => shardUnits(calls.map(({ cwd, argv }) => ({ cwd, argv })));

test('--shard: shards that select differently (one runs every suite) still run each unit of the real selection once', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp };
  for (const [check, platform, total] of hostedPlans.filter(([name]) => name !== 'migration-verify')) {
    const all = selectSuites(check, null, platform).suites;
    const selections = check === 'clued-cloud-tests' ? [all] : [['resident-node'], all.filter((id) => ['selection', 'source-v2-node'].includes(id))];
    const options = { check, platform };
    for (const real of selections) {
      const plan = unitsOf((await shardRunById(real, null, env)).calls);
      const expected = await Promise.all(Array.from({ length: total }, (_, at) => shardRunById(real, { index: at + 1, total }, env, options)));
      for (let fallback = 1; fallback <= total; fallback += 1) {
        const { status, calls } = await shardRunById(all, { index: fallback, total }, env, options);
        assert.equal(status, 0);
        const fallbackCalls = calls.filter((call) => real.includes(call.id));
        assert.deepEqual(fallbackCalls, expected[fallback - 1].calls, 'selection does not change the assigned commands');
        const ran = expected.flatMap(({ calls }, at) => at + 1 === fallback ? fallbackCalls : calls);
        assert.deepEqual(unitsOf(ran).sort(), [...plan].sort(),
          `${real.join(' ')}, ${total} shards, shard ${fallback} runs every suite: each unit of the selection once`);
      }
    }
  }
});

test('--shard: a python -m unittest command with an operand that is not a file runs whole, in one shard', () => {
  const argv = ['python', '-m', 'unittest', 'tests/test_a.py', 'tests'];
  for (const total of [2, 3]) {
    const packed = packedCommand({ cwd: '.', argv }, argv, total);
    const parts = Array.from({ length: total }, (_, at) => selection.shardPart(packed, at + 1));
    const runs = parts.filter((part) => part.argv);
    assert.equal(runs.length, 1, `one of ${total} shards runs it`);
    assert.deepEqual(runs[0].argv, argv, 'the package operand is not dropped');
    assert.ok(parts.every((part) => part.units === 1));
  }
  // Every operand a file: split by file as before.
  const files = ['python', '-m', 'unittest', 'tests/test_a.py', 'tests.test_b'];
  assert.deepEqual(selection.shardPart(packedCommand({ cwd: '.', argv: files }, files, 2), 2).argv, ['python', '-m', 'unittest', 'tests.test_b']);
});

test('--shard: the summary tells a suite this shard ran no unit of from one it ran and passed', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp };
  const texts = [];
  for (let index = 1; index <= 2; index += 1) {
    const lines = [];
    const { status, calls } = await shardRunById(['retrigger-counter'], { index, total: 2 }, env, { summary: (text) => lines.push(text) });
    assert.equal(status, 0);
    texts.push({ ran: calls.length, text: lines.join('') });
  }
  const idle = texts.find((part) => part.ran === 0);
  const busy = texts.find((part) => part.ran === 1);
  assert.ok(idle && busy, 'retrigger-counter is one unit: one shard runs it');
  assert.doesNotMatch(idle.text, /retrigger-counter`: passed/);
  assert.match(idle.text, /retrigger-counter`: not run in this shard \(0 of 1 units?\b/);
  assert.match(busy.text, /retrigger-counter`: passed \(1 of 1 units? in this shard\)/);
});

test('--shard: a known failure of a file no longer in its command is reported by exactly one shard, as without --shard', () => {
  const [first] = SUITE_COMMANDS['admission-self-tests'][0].argv.slice(2);
  const gone = 'scripts/ci/gone-from-the-command.test.mjs';
  const known = { 'admission-self-tests': [{ file: gone, path: ['g'], fingerprint: 'c'.repeat(16), reason: 'r' },
    { file: first, path: ['a'], fingerprint: 'a'.repeat(16), reason: 'r' }] };
  const warned = (shard) => {
    const lines = [];
    const code = executeSuite('admission-self-tests', { root: ROOT, env: { RUNNER_TEMP: os.tmpdir() }, known, log: (line) => lines.push(line),
      spawn: () => ({ status: 0 }), ...(shard ? { shard } : {}),
      readReportFile: () => JSON.stringify({ type: 'summary', counts: {}, success: true }) });
    assert.equal(code, 0);
    return lines.filter((line) => line.includes(`known failure no longer runs::${gone}`)).length;
  };
  assert.equal(warned(null), 1);
  for (const total of [1, 2, 3]) {
    let count = 0;
    for (let index = 1; index <= total; index += 1) count += warned({ index, total });
    assert.equal(count, 1, `${total} shards: one warning`);
  }
});

test('--shard is written --shard i/n, once: --shard=i/n and a second --shard exit 2', () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), ...args],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_EVENT_NAME: '', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } });
  for (const [args, message] of [[['--check', 'ci-suites', '--shard=1/2'], /--shard takes i\/n as its own argument/],
    [['--check', 'ci-suites', '--shard', '1/2', '--shard', '2/2'], /--shard is given once/],
    [['--run-selected', 'ci-suites', '--shard', '1/2', '--shard', '2/2'], /--shard is given once/]]) {
    const result = cli(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, message);
  }
});

test('--shard: the changed files are those of the event\'s head; any doubt runs every suite (null)', async () => {
  const event = { pull_request: { number: 7, head: { sha: 'b'.repeat(40) } } };
  const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
  const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });
  const fetcher = (head, { files = 200 } = {}) => async (url) => {
    if (/\/pulls\/7\/files/.test(url)) return files === 'throw' ? Promise.reject(new Error('reset')) : reply(files, [{ filename: 'a.mjs' }]);
    if (/\/pulls\/7$/.test(url)) return head === 'throw' ? Promise.reject(new Error('reset')) : reply(head ? 200 : 502, { head: { sha: head } });
    throw new Error(url);
  };
  assert.deepEqual(await selection.shardChangedFiles({ event, env, fetchImpl: fetcher('b'.repeat(40)) }), ['a.mjs']);
  assert.equal(await selection.shardChangedFiles({ event, env, fetchImpl: fetcher('c'.repeat(40)) }), null, 'a newer push');
  assert.equal(await selection.shardChangedFiles({ event, env, fetchImpl: fetcher(null) }), null, 'the head cannot be read');
  assert.equal(await selection.shardChangedFiles({ event, env, fetchImpl: fetcher('throw') }), null);
  assert.equal(await selection.shardChangedFiles({ event, env, fetchImpl: fetcher('b'.repeat(40), { files: 502 }) }), null);
  assert.equal(await selection.shardChangedFiles({ event: { pull_request: { number: 7 } }, env, fetchImpl: fetcher('b'.repeat(40)) }), null);
});

// L5: a shard that stops early, and a command the pull request adds.
test('--shard: a shard that stops at a failure stops only that suite there; every other assignment is unchanged', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: temp };
  const suites = ['components', 'retrigger-counter', 'selection'];
  const total = 3;
  const clean = [];
  for (let index = 1; index <= total; index += 1) clean.push((await shardRunById(suites, { index, total }, env)).calls);
  const stopping = clean.findIndex((calls) => calls.filter((call) => call.id === 'components').length >= 2);
  assert.ok(stopping >= 0, 'a shard runs two components commands');
  const target = JSON.stringify(clean[stopping].find((call) => call.id === 'components'));
  for (let index = 1; index <= total; index += 1) {
    const { status, calls } = await shardRunById(suites, { index, total }, env, { fail: (call) => JSON.stringify(call) === target });
    if (index - 1 !== stopping) {
      assert.equal(status, 0);
      assert.deepEqual(calls, clean[index - 1]);
      continue;
    }
    assert.equal(status, 1, 'the stopped shard fails');
    assert.deepEqual(calls.filter((call) => call.id === 'components').map((call) => JSON.stringify(call)), [target]);
    assert.deepEqual(calls.filter((call) => call.id !== 'components'), clean[index - 1].filter((call) => call.id !== 'components'),
      'the next suites run their own units as before');
  }
});

test('--shard: the test files and the command a pull request adds to a suite are split as the trusted ones are', async (t) => {
  const { root, change } = candidateSelector(t);
  const baseline = SUITE_COMMANDS['retrigger-counter'];
  change('retrigger-counter', [{ cwd: '.', argv: [...baseline[0].argv, 'scripts/ci/extra-a.test.mjs', 'scripts/ci/extra-b.test.mjs',
    'scripts/ci/extra-c.test.mjs'] }, { cwd: 'scripts/ci', argv: ['node', '-e', 'process.exit(0)'] }]);
  const commands = [...selection.requiredCommands('retrigger-counter', root)];
  assert.ok(commands.some((command) => command.files) && commands.some((command) => command.expanded), 'both kinds of addition');
  const env = { CI_BASE_SHA: 'a'.repeat(40), RUNNER_TEMP: root };
  const record = (calls) => (command, args, opts) => {
    calls.push({ cwd: path.relative(root, opts.cwd).replaceAll('\\', '/'), argv: [command, ...args].filter((arg) => !arg.startsWith('--test-reporter')) });
    return { status: 0 };
  };
  const plan = [];
  assert.equal(executeSuite('retrigger-counter', { root, env, log, spawn: record(plan), platform: 'linux', known: {} }), 0);
  assert.equal(plan.length, 3);
  for (const total of [1, 2, 3, 4]) {
    const ran = [];
    for (let index = 1; index <= total; index += 1) {
      assert.equal(executeSuite('retrigger-counter', { root, env, log, spawn: record(ran), platform: 'linux', known: {}, shard: { index, total } }), 0);
    }
    if (total === 1) assert.deepEqual(ran, plan);
    assert.deepEqual(shardUnits(ran).sort(), shardUnits(plan).sort(), `${total} shards`);
  }
});

test('a candidate addition uses spare load without moving any trusted unit', () => {
  const step = (file, expanded = false) => {
    const argv = ['node', '--test', file];
    return { id: 'fixture', command: { cwd: '.', argv, expanded }, argv };
  };
  const trusted = [step('first.test.mjs'), step('second.test.mjs')];
  const added = step('added.test.mjs', true);
  const seconds = new Map([['first.test.mjs', 11], ['second.test.mjs', 8], ['added.test.mjs', 100]]);
  const options = { total: 2, seconds };
  const plan = selection.packShards(trusted, options);
  const combined = selection.packShards([...trusted, added], options);
  assert.deepEqual(combined.slice(0, 2), plan);
  assert.equal(combined[2].units[0].shard, 2);
});

// The table only moves files between shards: each file still runs in exactly one.
const bySeconds = (files, total, seconds = {}) => {
  const argv = ['node', '--test', '--test-concurrency=2', ...files];
  const step = packedCommand({ cwd: '.', argv }, argv, total, new Map(Object.entries(seconds)));
  const parts = [];
  for (let index = 1; index <= total; index += 1) {
    const part = selection.shardPart(step, index);
    assert.equal(part.units, files.length);
    parts.push({ argv: part.argv, files: part.files ? [...part.files] : [] });
  }
  return parts;
};

test('--shard by seconds: two heavy files whose numbers agree mod n land in different shards (block 5 root cause)', () => {
  const files = 'abcdefgh'.split('').map((letter) => `t/${letter}.test.mjs`);
  const weights = [100, 1, 1, 1, 100, 1, 1, 1];
  const seconds = Object.fromEntries(files.map((file, i) => [file, weights[i]]));
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = bySeconds(files, 4, seconds);
  const loads = parts.map((part) => part.files.reduce((total, file) => total + seconds[file], 0));
  const heavy = parts.find((part) => part.files.includes(files[0]));
  assert.ok(!heavy.files.includes(files[4]), `the two 100-second files share a shard (${loads})`);
  assert.ok(Math.max(...loads) <= Math.max(1.15 * (sum / 4), Math.max(...weights)), `shards ${loads}`);
});

test('--shard by seconds: any table, any n, the shards split the command\'s files: disjoint, all of them, in order', () => {
  let seed = 0x3435f8bf;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  for (let trial = 0; trial < 300; trial += 1) {
    const count = 1 + Math.floor(random() * 24);
    const files = Array.from({ length: count }, (_, i) => `d${i % 3}/f${String(i).padStart(2, '0')}.test.mjs`);
    // Empty, keys missing, ties, huge values, values that are no seconds at all (they weigh 1), keys of other commands.
    const seconds = {};
    const kind = trial % 4;
    for (const file of files) {
      if (kind === 0 || random() < 0.3) continue;
      seconds[file] = kind === 1 ? pick([3, 3, 7]) : kind === 2 ? pick([3, 50, 1e9, Number.MAX_SAFE_INTEGER]) : pick([4, 0, -5, 2.5, '9', null, 12]);
    }
    seconds['elsewhere/x.test.mjs'] = 999;
    const total = 1 + (trial % 8);
    const parts = bySeconds(files, total, seconds);
    const ran = parts.flatMap((part) => part.files);
    assert.deepEqual([...ran].sort(), [...files].sort(), `trial ${trial}: every file once`);
    for (const part of parts) {
      assert.deepEqual(part.files, files.filter((file) => part.files.includes(file)), `trial ${trial}: a shard keeps the command's order`);
      if (part.files.length === 0) assert.equal(part.argv, null);
      else assert.deepEqual(part.argv, ['node', '--test', '--test-concurrency=2', ...part.files], `trial ${trial}: its own switches`);
    }
    if (total === 1) assert.deepEqual(parts[0].argv, ['node', '--test', '--test-concurrency=2', ...files], 'n = 1: the command as it is');
  }
});

test('--shard by seconds: ties follow plan order and use the lowest numbered lightest shard', () => {
  for (let count = 1; count <= 12; count += 1) {
    const files = Array.from({ length: count }, (_, i) => `t/f${String(i).padStart(2, '0')}.test.mjs`);
    for (let total = 1; total <= 8; total += 1) {
      for (const seconds of [undefined, {}, { 'elsewhere/x.test.mjs': 300 }]) {
        const parts = bySeconds(files, total, seconds);
        parts.forEach((part, i) => assert.deepEqual(part.files, files.filter((file, unit) => unit % total === i),
          `${count} files, ${total} shards, table ${JSON.stringify(seconds)}`));
      }
    }
  }
});

test('--shard by seconds: the checked-in table spreads resident-node over 4 shards (heaviest within 1.15 of the mean or one file)', () => {
  const { table, problem } = selection.readShardSeconds();
  assert.equal(problem, null, 'the checked-in table reads');
  const [command] = SUITE_COMMANDS['resident-node'];
  const argv = expandArgv(command.argv, { cwd: path.join(ROOT, command.cwd), root: ROOT, base: 'a'.repeat(40), report: '' });
  const step = packedCommand(command, argv, 4, table);
  const loads = [];
  const ran = [];
  let listed = null;
  for (let index = 1; index <= 4; index += 1) {
    const part = selection.shardPart(step, index);
    listed ??= part.listed;
    const mine = part.files ? [...part.files] : [];
    ran.push(...mine);
    loads.push(mine.reduce((total, file) => total + (table.get(file) ?? 0), 0));
  }
  assert.ok(listed && listed.size > 100, 'resident-node lists its files');
  assert.deepEqual(ran.sort(), [...listed].sort(), 'every resident-node file once');
  const weights = [...listed].map((file) => table.get(file) ?? 0);
  const bound = Math.max(1.15 * (weights.reduce((a, b) => a + b, 0) / 4), ...weights);
  assert.ok(Math.max(...loads) <= bound, `table seconds per shard ${loads}, bound ${bound}`);
});

test('ci-shard-seconds.json is the writer\'s output: repository path -> whole seconds >= 3, keys sorted', () => {
  const text = readFileSync(selection.SHARD_SECONDS_PATH, 'utf8');
  const data = JSON.parse(text);
  assert.ok(data && typeof data === 'object' && !Array.isArray(data));
  const keys = Object.keys(data);
  assert.deepEqual(keys, [...keys].sort(), 'keys sorted');
  for (const [file, seconds] of Object.entries(data)) {
    assert.match(file, /^(?!\/)[^\\]+$/, `${file}: a repository path with forward slashes`);
    assert.ok(Number.isSafeInteger(seconds) && seconds >= 3, `${file}: ${seconds}`);
  }
  assert.equal(text, `${JSON.stringify(data, null, 2)}\n`, 'written as --write-shard-seconds writes it');
  // It is read only by --shard: neither every-suite selection nor the local selector files name it.
  assert.ok(!SELECT_ALL.includes('scripts/ci/ci-shard-seconds.json'));
  assert.ok(SUITES['ci-suites'].selection.includes('scripts/ci/ci-shard-seconds.json'), 'a change to the table runs its tests');
});

test('--shard by seconds: a missing or broken table is an empty one, with a notice; the shard still runs', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-seconds-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(temp, name); writeFileSync(file, text); return file; };
  const bad = [path.join(temp, 'missing.json'), write('corrupt.json', '{"a":'), write('array.json', '[1]'), write('null.json', 'null'),
    write('negative.json', '{"t/a.test.mjs":-3}'), write('fraction.json', '{"t/a.test.mjs":3.5}'), write('text.json', '{"t/a.test.mjs":"9"}'),
    write('backslash.json', JSON.stringify({ 't\\a.test.mjs': 9 })), write('absolute.json', '{"/t/a.test.mjs":9}')];
  for (const file of bad) {
    const { table, problem } = selection.readShardSeconds(file);
    assert.equal(table.size, 0, file);
    assert.ok(problem, `${file}: says why`);
  }
  assert.deepEqual([...selection.readShardSeconds(write('good.json', '{"t/a.test.mjs":9}')).table], [['t/a.test.mjs', 9]]);
  for (const file of bad.slice(0, 2)) {
    const lines = [];
    let ran = null;
    const code = executeSuite('retrigger-counter', { root: ROOT, env: { RUNNER_TEMP: temp }, log: (line) => lines.push(line), platform: 'linux',
      known: {}, spawn: (command, args) => { ran = args; return { status: 0 }; }, shard: { index: 1, total: 1 }, shardSecondsFile: file,
      readReportFile: () => JSON.stringify({ type: 'summary', counts: {}, success: true }) });
    assert.equal(code, 0);
    assert.ok(ran.includes('scripts/ci/retrigger-counter.test.mjs'));
    assert.match(lines.join('\n'), /::notice title=retrigger-counter shard seconds::/);
    assert.match(lines.join('\n'), /按秒数分片，表里命中 0 \/ 本命令 1 个文件/);
  }
});

test('--shard by seconds: a listing command says how much of the table it hit and logs each of its files\' seconds', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-seconds-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const files = SUITE_COMMANDS['admission-self-tests'][0].argv.slice(2);
  const table = path.join(temp, 'table.json');
  writeFileSync(table, `${JSON.stringify({ [files[0]]: 40, [files[1]]: 7, 'elsewhere/x.test.mjs': 5 })}\n`);
  const at = (file) => path.join(ROOT, file);
  const events = [{ type: 'pass', file: at(files[0]), path: ['a'], ms: 1500 }, { type: 'pass', file: at(files[0]), path: ['a', 'inner'] },
    { type: 'fail', file: at(files[1]), path: ['b'], fingerprint: 'b'.repeat(16), ms: 2049 }, { type: 'pass', file: at(files[0]), path: ['c'], ms: 250 },
    { type: 'summary', counts: {}, success: false }];
  const known = { 'admission-self-tests': [{ file: files[1], path: ['b'], fingerprint: 'b'.repeat(16), reason: 'r' }] };
  const lines = [];
  const code = executeSuite('admission-self-tests', { root: ROOT, env: { RUNNER_TEMP: temp }, known, log: (line) => lines.push(line),
    platform: 'linux', spawn: () => ({ status: 1 }), shard: { index: 1, total: 1 }, shardSecondsFile: table,
    readReportFile: () => events.map((event) => JSON.stringify(event)).join('\n') });
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.match(text, new RegExp(`admission-self-tests: 按秒数分片，表里命中 2 / 本命令 ${files.length} 个文件`));
  const logged = lines.filter((line) => line.startsWith('admission-self-tests: shard-seconds '));
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0].slice('admission-self-tests: shard-seconds '.length)), { [files[0]]: 1.8, [files[1]]: 2 });
  // The suite's first line names the table it read, so the shards' logs show they read the same one.
  assert.match(lines[0], /^admission-self-tests: shard 1\/1; 按秒数分片，表 3 条（[0-9a-f]{12}）$/);
});

test('--write-shard-seconds: the median of each file\'s samples in the shard logs, under 3 seconds dropped, keys sorted', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-seconds-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const one = path.join(temp, 'shard-1.log');
  const two = path.join(temp, 'shard-2.log');
  writeFileSync(one, ['2026-11-24T02:00:00.0000000Z resident-node: shard 1/4, units numbered from 3; 按秒数分片，表 0 条（e3b0c44298fc）',
    '2026-11-24T02:03:00.0000000Z resident-node: shard-seconds {"w/z.test.mjs":10,"w/b.test.mjs":2,"w/d.test.mjs":4}',
    'some other line: shard-seconds are fun', '2026-11-24T02:04:00.0000000Z selection: shard-seconds {"s/c.test.mjs":3.4}'].join('\r\n'));
  writeFileSync(two, ['resident-node: shard-seconds {"w/z.test.mjs":30,"w/b.test.mjs":2.9,"w/d.test.mjs":5}',
    'resident-node: shard-seconds {"w/z.test.mjs":20}'].join('\n'));
  const out = path.join(temp, 'table.json');
  writeFileSync(out, '{"old/gone.test.mjs":50}\n');
  const expected = '{\n  "s/c.test.mjs": 3,\n  "w/d.test.mjs": 5,\n  "w/z.test.mjs": 20\n}\n';
  const lines = [];
  assert.equal(selection.writeShardSeconds([one, two], { file: out, log: (line) => lines.push(line) }), 0);
  assert.equal(readFileSync(out, 'utf8'), expected);
  assert.match(lines.join('\n'), /3 keys written/);
  // Nothing to write from (no shard-seconds line, an unreadable log, no log): the table stays as it was.
  const none = path.join(temp, 'none.log');
  writeFileSync(none, 'resident-node: shard 1/4\n');
  for (const logs of [[none], [one, path.join(temp, 'missing.log')], []]) {
    assert.notEqual(selection.writeShardSeconds(logs, { file: out, log: () => {} }), 0, logs.join(' '));
    assert.equal(readFileSync(out, 'utf8'), expected);
  }
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), '--write-shard-seconds'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(cli.status, 2, `${cli.stdout}${cli.stderr}`);
  assert.match(cli.stderr, /--write-shard-seconds <log>/);
});

test('the reporter gives a top-level test its whole milliseconds (ms), a nested one none', async () => {
  const file = path.join(ROOT, 'x.test.mjs');
  async function* source() {
    yield { type: 'test:start', data: { file, nesting: 0, name: 'top' } };
    yield { type: 'test:start', data: { file, nesting: 1, name: 'inner' } };
    yield { type: 'test:pass', data: { file, nesting: 1, name: 'inner', details: { duration_ms: 12.6 } } };
    yield { type: 'test:pass', data: { file, nesting: 0, name: 'top', details: { duration_ms: 1234.4 } } };
    yield { type: 'test:start', data: { file, nesting: 0, name: 'bad' } };
    yield { type: 'test:fail', data: { file, nesting: 0, name: 'bad', details: { duration_ms: 99.5, error: new Error('x') } } };
    yield { type: 'test:start', data: { file, nesting: 0, name: 'skipped' } };
    yield { type: 'test:pass', data: { file, nesting: 0, name: 'skipped', skip: true, details: { duration_ms: 0.2 } } };
  }
  const lines = [];
  for await (const line of reporterStream(source())) lines.push(JSON.parse(line));
  assert.deepEqual(lines.map(({ path: at, ms }) => [at.join(' > '), ms]),
    [['top > inner', undefined], ['top', 1234], ['bad', 100], ['skipped', 0]]);
});

test('the reporter uses the file wall clock ahead of the sum of its tests', async () => {
  const file = path.join(ROOT, 'shard-timing.test.mjs');
  const source = [
    { type: 'test:pass', data: { file, nesting: 0, name: 'case', details: { duration_ms: 1000 } } },
    { type: 'test:complete', data: { file, nesting: 0, name: 'case', details: { duration_ms: 1000 } } },
    { type: 'test:complete', data: { nesting: 0, name: file, details: { duration_ms: 5000 } } },
  ];
  const lines = [];
  for await (const line of reporterStream(source)) lines.push(line);
  const report = readReport(lines.join(''), ROOT);
  assert.equal(selection.shardSecondsOf(report, new Set(['shard-timing.test.mjs']))['shard-timing.test.mjs'], 5);
  assert.equal(JSON.parse(lines.at(-1)).ms, 5000);
});

test('--write-shard-seconds takes the median of three whole-command samples', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-shard-whole-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const key = 'runner-budget-policy (.) python3 scripts/ci/validate_runner_budget_policy.py';
  const logs = [8, 40, 12].map((seconds, index) => {
    const file = path.join(temp, `round-${index}.log`);
    writeFileSync(file, `runner-budget-policy: whole-seconds ${JSON.stringify({ [key]: seconds })}\n`);
    return file;
  });
  const file = path.join(temp, 'table.json');
  assert.equal(selection.writeShardSeconds(logs, { file, log }), 0);
  const { table } = selection.readShardSeconds(file);
  assert.deepEqual([...table], [[key, 12]]);
  const files = ['node', '--test', 'a.test.mjs', 'b.test.mjs'];
  const whole = ['python3', 'scripts/ci/validate_runner_budget_policy.py'];
  const steps = [{ id: 'fixture', command: { cwd: '.', argv: files }, argv: files },
    { id: 'runner-budget-policy', command: { cwd: '.', argv: whole }, argv: whole }];
  const weights = new Map([['a.test.mjs', 9], ['b.test.mjs', 8], ...table]);
  const packed = selection.packShards(steps, { total: 2, seconds: weights });
  assert.equal(packed[1].units[0].weight, 12);
  assert.deepEqual(packed.map(({ units }) => units.map(({ shard }) => shard)), [[2, 2], [1]]);
});

// --run-prepush (task 3435f8bf, FABLE-ci-one-round-20261124 §3.7 ruling 1): the push entry runs these few static checks on
// the tree the push would merge into main. One list, the runner budget suite's commands by reference, never a copy.
test('PREPUSH_COMMANDS: every file a command names exists, and its runner budget part is the suite\'s own command objects', () => {
  const { PREPUSH_COMMANDS } = selection;
  assert.ok(Array.isArray(PREPUSH_COMMANDS) && PREPUSH_COMMANDS.length > 0, 'PREPUSH_COMMANDS is exported');
  for (const command of PREPUSH_COMMANDS) {
    for (const arg of command.argv.filter((item) => /\.(?:mjs|py)$/.test(item))) {
      assert.ok(existsSync(path.join(ROOT, command.cwd, arg)), `${arg} (cwd ${command.cwd}) exists`);
    }
  }
  assert.deepEqual(PREPUSH_COMMANDS[0], { cwd: '.', argv: ['node', '--test', 'scripts/ci/main-entry-realpath.test.mjs'] });
  const budget = SUITE_COMMANDS['runner-budget-policy'];
  assert.equal(PREPUSH_COMMANDS.length, 1 + budget.length);
  budget.forEach((command, index) => assert.equal(PREPUSH_COMMANDS[1 + index], command, 'the same object, not a copy'));
});

test('runPrepush: 0 when all pass; 1 naming the failed tests of a red command; 3 for a timeout; no slot, no dependencies', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-prepush-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const commands = [{ cwd: '.', argv: ['node', '--test', 'a.test.mjs'] }, { cwd: '.', argv: ['python', 'b.py'], quiet: true }];
  const run = (outcome) => {
    const calls = [];
    const lines = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const destination = args.find((arg) => arg.startsWith('--test-reporter-destination=') && !arg.endsWith('=stdout'));
      const result = outcome(args, destination?.slice('--test-reporter-destination='.length));
      return { status: 0, signal: null, stdout: Buffer.from(''), ...result };
    };
    const status = selection.runPrepush(temp, { env: { CLUED_TEST_IDENTITY_DIR: temp }, spawn, log: (line) => lines.push(String(line)), commands });
    return { status, calls, text: lines.join('\n') };
  };
  const green = run(() => ({}));
  assert.equal(green.status, 0, green.text);
  assert.equal(green.calls.length, 2);
  for (const call of green.calls) assert.equal(call.options.timeout, selection.PREPUSH_TIMEOUT_MS);
  assert.equal(selection.PREPUSH_TIMEOUT_MS, 120_000);

  const red = run((args, report) => {
    if (!report) return { status: 1 };
    writeFileSync(report, `${JSON.stringify({ type: 'fail', file: path.join(temp, 'a.test.mjs'), path: ['entry guard', 'listed file'], fingerprint: '0123456789abcdef' })}\n`);
    return { status: 1 };
  });
  assert.equal(red.status, 1, red.text);
  assert.match(red.text, /a\.test\.mjs :: entry guard > listed file/);
  assert.match(red.text, /python b\.py/, 'the second red command is named too');
  assert.match(red.text, /--run-prepush --root/, 'the command that reproduces it');

  const hung = run((args) => (args.includes('b.py') ? { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync python ETIMEDOUT'), { code: 'ETIMEDOUT' }) } : {}));
  assert.equal(hung.status, selection.PREPUSH_ERROR_EXIT, hung.text);
  assert.equal(selection.PREPUSH_ERROR_EXIT, 3);
});

test('--run-prepush marks its environment as a test run, and needs --root', () => {
  const env = {};
  selection.markTestRun(['--run-prepush', '--root', '.'], env);
  assert.equal(env.CLUED_UNDER_TEST, '1');
  const missing = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), '--run-prepush'], { encoding: 'utf8' });
  assert.equal(missing.status, 2, `${missing.stdout}${missing.stderr}`);
  assert.match(missing.stderr, /--run-prepush --root <tree>/);
});

// Review of 3435f8bf: a red command is a clear red even when a later one times out, does not start, cannot be expanded
// or throws; and an exception inside the run is "did not run" (3), never the red exit 1 the push entry refuses on.
test('runPrepush: an earlier red stays 1 when a later command times out, does not start, cannot be expanded or throws; a throw alone is 3', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-prepush-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const run = (commands, outcome) => {
    const lines = [];
    const spawn = (command, args) => ({ status: 0, signal: null, stdout: Buffer.from(''), ...outcome(args) });
    let status;
    try {
      status = selection.runPrepush(temp, { env: { CLUED_TEST_IDENTITY_DIR: temp }, spawn, log: (line) => lines.push(String(line)), commands });
    } catch (error) {
      status = `threw: ${error.message}`;
    }
    return { status, text: lines.join('\n') };
  };
  const first = { cwd: '.', argv: ['python', 'a.py'] };
  const second = { cwd: '.', argv: ['python', 'b.py'] };
  const timedOut = { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync python ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
  const noStart = { status: null, signal: null, error: Object.assign(new Error('spawnSync python ENOENT'), { code: 'ENOENT' }) };
  for (const [name, later] of [['timed out', timedOut], ['did not start', noStart]]) {
    const result = run([first, second], (args) => (args.includes('a.py') ? { status: 1 } : later));
    assert.equal(result.status, 1, `${name}: ${result.text}`);
    assert.match(result.text, /prepush 红：\(\.\) python a\.py 退出 1/, name);
    assert.match(result.text, /b\.py/, `${name}: the command that did not run is named too`);
  }
  const unexpanded = run([first, { cwd: '.', argv: ['node', 'x.mjs', '{base}'] }], (args) => (args.includes('a.py') ? { status: 1 } : {}));
  assert.equal(unexpanded.status, 1, unexpanded.text);
  const thrower = (args) => { if (args.includes('b.py')) throw new Error('EBUSY: resource busy or locked'); return args.includes('a.py') ? { status: 1 } : {}; };
  const redThenThrow = run([first, second], thrower);
  assert.equal(redThenThrow.status, 1, redThenThrow.text);
  const throwOnly = run([second], thrower);
  assert.equal(throwOnly.status, selection.PREPUSH_ERROR_EXIT, throwOnly.text);
  assert.doesNotMatch(throwOnly.text, /prepush 红：/);
});
