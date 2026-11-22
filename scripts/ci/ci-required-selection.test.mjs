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
import { failureFingerprint, normalizeFailure } from './ci-test-failures-reporter.mjs';

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
    let tool = selector;
    let target = suite;
    if (mode === '--write-known') {
      const tools = path.join(root, 'tools');
      mkdirSync(tools);
      for (const file of ['ci-required-selection.mjs', 'test-env.mjs', 'ci-test-failures-reporter.mjs',
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
    env.CI_BASE_SHA ||= 'fixture-base';
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    delete env.NODE_TEST_CONTEXT;
    if (ci) env[ci] = 'true';
    Object.assign(env, extraEnv);
    if (mode === '--run-selected') {
      writeFileSync(path.join(scripts, 'check-cron-budget.test.mjs'), probe);
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
    const run = start('actions', { mode, ci: 'GITHUB_ACTIONS' });
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
  const roots = [...SUITE_COMMANDS['production-schema'].at(-1).argv.filter((arg) => arg.endsWith('.test.mjs')).map((arg) => `apps/clued-cloud/${arg}`),
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
  const scanStart = SUITE_COMMANDS['production-schema'].at(-2);
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
    assert.equal(executeSuite('production-schema', { root: ROOT, env: {}, spawn, log }), 0);
    assert.deepEqual(calls.slice(-2).map((argv) => argv.filter((arg) => arg.startsWith('--test-concurrency'))),
      [[`--test-concurrency=${concurrency}`], [`--test-concurrency=${concurrency}`]]);
  });
}

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
  assert.equal(executeSuite('production-schema', { root: ROOT, env: {}, spawn: () => ({ status: 0 }), log }), 0);
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
  leaked: ['GITHUB_PAT_TOKEN', 'ANTHROPIC_API_KEY', 'CLUED_HOME', 'GIT_CONFIG_COUNT', 'NODE_OPTIONS'].filter((name) => name in process.env),
  kept: ['CI_BASE_SHA', 'PYTHONDONTWRITEBYTECODE', 'CLUED_CI_APP_DEPS'].map((name) => process.env[name]),
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
  copyFileSync(path.join(ROOT, 'scripts/ci/test-env.mjs'), path.join(dir, 'test-env.mjs'));
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
    { env: { ...childEnv(), GITHUB_ACTIONS: 'true' }, encoding: 'utf8' });
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
  spawnSync(process.execPath, [trusted, '--run', id, '--root', root], { env: { ...childEnv(), GITHUB_ACTIONS: 'true' }, encoding: 'utf8' });
const groupLines = (out) => out.split(/\r?\n/).filter((line) => line.startsWith('::group::'));

// Gap A review finding 1: the selector's bytes say nothing about the modules it imports, so a candidate selector at another
// path is read even when it is byte for byte the trusted one.
test('a command added by a module the candidate selector imports runs although the selector itself is unchanged', (t) => {
  const checkout = (added) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ci-pr-import-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'scripts/ci');
    mkdirSync(dir, { recursive: true });
    copyFileSync(path.join(ROOT, 'scripts/ci/test-env.mjs'), path.join(dir, 'test-env.mjs'));
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
  assert.equal(executeSuite('clued-cloud', { root: ROOT, env: {}, spawn, log, platform: 'linux' }), 2);
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
  executeSuite('clued-cloud', { root: ROOT, env: {}, platform: 'win32', log, spawn: (command, args) => { calls.push([command, ...args]); return { status: 1 }; } });
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
  assert.match(verification, /git rev-parse "\$\(\$env:STAGING_SHA\)\^1"/);
  // On staging, the runner hook's chain walk read from main (behaviour: the multi-member tests below).
  assert.match(verification, /execFileSync\('git', \['show', 'origin\/main:scripts\/runner\/clued-runner-job-started\.mjs'\]\)/);
  assert.ok(verification.indexOf('stagingBaseFromCheckout(process.env.STAGING_SHA)') < verification.indexOf('$env:GITHUB_OUTPUT'));
  assert.match(job, /ref: \$\{\{ steps\.train-base\.outputs\.sha \|\| github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}\n {10}path: trusted\n/);
  assert.match(job, /CI_BASE_SHA: \$\{\{ steps\.train-base\.outputs\.sha \|\| github\.event\.pull_request\.base\.sha \|\| steps\.train-base\.outputs\.ci_base \}\}\n/);
});

// A batch of N members is S = merge(...merge(T, H1)..., HN) (ADR 0019 §3): S^1 is an intermediate train merge, not on
// main, and only T, the root of the member chain, is a trusted base. Each required job's push-baseline step runs here as
// it does on the runner: its own script, its own shell, a real Git checkout whose origin/main is T and holds this
// change's runner hook (the step's walk is the hook's, read from main).
const LINUX_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'clued-required-tests.yml');
const BASELINE_JOBS = [[LINUX_WORKFLOW, 'clued-cloud-tests'], [LINUX_WORKFLOW, 'ci-suites'], [LINUX_WORKFLOW, 'migration-verify'],
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
function runBaseline(t, { shell, script }, repo, env) {
  const command = shellCommand(shell);
  const output = path.join(repo, `output-${Math.random().toString(16).slice(2)}`);
  const file = path.join(repo, `step-${Math.random().toString(16).slice(2)}.${shell === 'bash' ? 'sh' : 'ps1'}`);
  writeFileSync(output, '');
  writeFileSync(file, script);
  const r = spawnSync(command[0], [...command[1], file], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: output, ...env } });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => line.split('=')));
  return { status: r.status, outputs, log: r.stdout + r.stderr };
}
const STAGING = { EVENT_NAME: 'push', PUSH_REF: 'refs/heads/clued-train/staging' };
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
  test(`bors staging, ${label}: a one-member S keeps T = S^1; main pushes and pull requests are unchanged`, { skip }, (t) => {
    const repo = trainCheckout(t);
    const one = runBaseline(t, step, repo.dir, { ...STAGING, STAGING_SHA: repo.one });
    assert.equal(one.status, 0, one.log);
    assert.deepEqual(one.outputs, { sha: repo.T, ci_base: repo.T }, one.log);
    const main = runBaseline(t, step, repo.dir, { EVENT_NAME: 'push', PUSH_REF: 'refs/heads/main', STAGING_SHA: repo.one });
    assert.equal(main.status, 0, main.log);
    assert.deepEqual(main.outputs, { ci_base: repo.T }, main.log);
    const pr = runBaseline(t, step, repo.dir, { EVENT_NAME: 'pull_request', PUSH_REF: 'refs/pull/9/merge', STAGING_SHA: repo.one });
    assert.equal(pr.status, 0, pr.log);
    assert.deepEqual(pr.outputs, {}, pr.log);
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
    const pr = runBaseline(t, step, repo.dir, { EVENT_NAME: 'pull_request', PUSH_REF: 'refs/pull/9/merge', STAGING_SHA: repo.caughtUp });
    assert.equal(pr.status, 0, pr.log);
    assert.deepEqual(pr.outputs, {}, pr.log);
  });
  if (id !== 'ci-suites') continue;
  // The consumer, end to end: the step's outputs, the job's own CI_BASE_SHA expression (GitHub's ||, a missing property
  // is null; under dispatch there is no pull_request), then the selector expanding every command of the four suites
  // that take {base}. Before the fix this threw 'CI_BASE_SHA is required for this suite', as in the run's log.
  test(`lost-run dispatch, ${label}: the suites that compare with a base get the merge-base commit`, { skip }, (t) => {
    const repo = dispatchCheckout(t);
    const text = readFileSync(file, 'utf8');
    const job = text.slice(text.indexOf(`\n  ${id}:\n`) + 1);
    const expression = /\n {10}CI_BASE_SHA: \$\{\{ (.+?) \}\}\n/.exec(job.slice(job.indexOf('- name: Run the selected suites\n')))[1];
    const operands = expression.split('||').map((operand) => operand.trim());
    assert.ok(operands.every((operand) => /^[a-z_]+(\.[a-z_-]+)+$/.test(operand)), expression);
    for (const [head, expected] of [[repo.caughtUp, repo.M2], [repo.behind, repo.T]]) {
      const r = runBaseline(t, step, repo.dir, { ...DISPATCH, STAGING_SHA: head });
      assert.equal(r.status, 0, r.log);
      const context = { steps: { 'train-base': { outputs: r.outputs } },
        github: { event_name: 'workflow_dispatch', event: { inputs: { pr: '9', head } } } };
      const value = (operand) => operand.split('.').reduce((at, key) => (at == null ? null : at[key] ?? null), context);
      const base = operands.map(value).find(Boolean) ?? '';
      for (const suite of ['components', 'pinned-registries', 'mechanical-outputs', 'ci-deps-entry']) {
        let compared = 0;
        for (const command of SUITE_COMMANDS[suite]) {
          const argv = expandArgv(command.argv, { cwd: path.join(ROOT, command.cwd), root: ROOT, base, report: path.join(repo.dir, 'r.json') });
          const at = argv.indexOf('--base');
          if (at < 0) continue;
          assert.equal(argv[at + 1], expected, `${suite}: ${argv.join(' ')}`);
          compared++;
        }
        assert.equal(compared, 1, `${suite} compares with the base once`);
      }
      assert.equal(base, expected, expression);
      assert.ok(isAncestor(repo, base, head), 'the suites compare the head with one of its own ancestors');
    }
  });
}

// The release door flow test runs the release workflow's steps and the grant script against a database, so a change to
// either runs it (FABLE-release-identity-autonomous-20261119 §3.1 tests 8 to 12).
test('the release workflow and its grant script select the release door flow database test', () => {
  for (const file of ['.github/workflows/clued-cloud-production-release.yml', 'scripts/ci/clued-release-door.mjs',
    'apps/clued-cloud/tests/production-release-door-flow-db.test.mjs', 'apps/clued-cloud/tests/release-door-psql-fixture.mjs']) {
    assert.deepEqual(selectSuites('migration-verify', [file], 'linux').suites, ['production-schema'], file);
  }
  assert.ok(SUITE_COMMANDS['production-schema'].at(-1).argv.includes('tests/production-release-door-flow-db.test.mjs'));
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
