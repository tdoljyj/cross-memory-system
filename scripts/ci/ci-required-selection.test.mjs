import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  FILE_LIMIT, REPORTER_PATH, SELECT_ALL, SUITES, SUITE_COMMANDS, changedFiles, expandArgv, globToRegExp, knownFailureVerdict, knownKey,
  knownEntriesFromReport, listPullRequestFiles, outputLines, readKnownFailures, readReport, resolveCommand, runSuite, selectSuites,
  PLATFORMS, SUITE_PLATFORMS, hostPlatform, runSelected, suitePlatforms,
} from './ci-required-selection.mjs';
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
        if (file === 'powershell.exe' && args.includes('-Command') && ++calls <= Number(process.env.SLOT_FIXTURE_PROBE_ERROR)) {
          throw Object.assign(new Error('synthetic identity probe timeout'), { code: 'ETIMEDOUT' });
        }
        return original(file, args, options);
      };
      syncBuiltinESMExports();
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
  return function start(name, { waitMs = 25_000, holdMs = 35_000, ci, tree = false, probeErrors = 0 } = {}) {
    const root = path.join(dir, name);
    const scripts = path.join(root, 'scripts', 'ci');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(path.join(root, 'descendant.mjs'), `
      import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync('descendant.pid', String(process.pid));
      const poll = setInterval(() => { if (existsSync('release')) clearInterval(poll); }, 20);
      setTimeout(() => clearInterval(poll), 35_000).unref();
    `);
    writeFileSync(path.join(scripts, 'retrigger-counter.test.mjs'), `
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
    `);
    const env = { ...process.env, SLOT_FIXTURE_QUEUE: queue, SLOT_FIXTURE_WAIT: String(waitMs),
      SLOT_FIXTURE_HOLD: String(holdMs), SLOT_FIXTURE_PROBE_ERROR: String(probeErrors || '') };
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    delete env.NODE_TEST_CONTEXT;
    if (ci) env[ci] = 'true';
    const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, selector,
      '--run', 'retrigger-counter', '--root', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const done = once(child, 'close');
    const run = { child, done, output: () => output, ready: () => existsSync(path.join(root, 'ready')),
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
  assert.equal(run.ready(), false, 'a third local --run must wait before starting its suite');
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
    const waiting = start('waiting', { probeErrors: 2 });
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

test('GitHub Actions and generic CI --run bypass an occupied local queue', async (t) => {
  const start = slotFixture(t);
  const holders = await fillSuiteSlots(start);
  await waitForQueuedSuite(start('local'), holders);
  for (const ci of ['GITHUB_ACTIONS', 'CI']) {
    const run = start(ci, { ci });
    await waitForSlotFixture(run, run.ready);
    run.release();
    assert.deepEqual(await run.done, [0, null]);
    assert.doesNotMatch(run.output(), /queue position/);
  }
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
      const argv = expandArgv(command.argv, { cwd, base: 'abc', report: '/tmp/r.json', listUnit: () => ['tests/a.test.mjs'] });
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
    assert.equal(runSuite('production-schema', { root: ROOT, env: {}, spawn, log }), 0);
    assert.deepEqual(calls.slice(-2).map((argv) => argv.filter((arg) => arg.startsWith('--test-concurrency'))),
      [[`--test-concurrency=${concurrency}`], [`--test-concurrency=${concurrency}`]]);
  });
}

test('outputs name every suite of the check', () => {
  const lines = outputLines('ci-suites', { suites: ['offline-drill'] });
  assert.equal(lines[0], 'suites=["offline-drill"]');
  assert.ok(lines.includes('run_offline_drill=true'));
  assert.ok(lines.includes('run_resident_node=false'));
  assert.equal(lines.length, 1 + Object.keys(SUITES['ci-suites']).length);
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
  assert.equal(runSuite('components', { root: ROOT, env: { CI_BASE_SHA: 'b' }, spawn, log }), 3);
  assert.equal(calls.length, 2);
  assert.equal(runSuite('selection', { root: ROOT, env: {}, spawn: () => ({ error: new Error('ENOENT') }), log }), 1);
  assert.equal(runSuite('production-schema', { root: ROOT, env: {}, spawn: () => ({ status: 0 }), log }), 0);
  assert.throws(() => runSuite('nope', { root: ROOT, spawn, log }), /unknown suite/);
});

// A real run through the reporter: the failure shapes round 2 found masked.
// The fixture is its own test run, not part of this one (as run-tests.mjs does).
const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };
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
  assert.equal(runSuite('admission-self-tests', { root: ROOT, env, spawn, known, log: (line) => lines.push(line),
    readReportFile: report([{ type: 'fail', file: abs(entry.file), path: entry.path, fingerprint: entry.fingerprint }, summary]) }), 0);
  assert.ok(seen.includes(`--test-reporter=${pathToFileURL(REPORTER_PATH).href}`));
  assert.ok(seen.some((arg) => arg.startsWith('--test-reporter-destination=') && arg.endsWith('failures.jsonl')));
  assert.ok(lines.some((line) => line.startsWith('::warning title=admission-self-tests known failure::scripts/ci/x.test.mjs :: old a')));
  assert.equal(runSuite('admission-self-tests', { root: ROOT, env, spawn, known, log,
    readReportFile: report([{ type: 'fail', file: abs(entry.file), path: entry.path, fingerprint: entry.fingerprint },
      { type: 'fail', file: abs('scripts/ci/x.test.mjs'), path: ['b'], fingerprint: 'b'.repeat(16) }, summary]) }), 1);
  assert.equal(runSuite('admission-self-tests', { root: ROOT, env, spawn, known, log, readReportFile: () => '' }), 1, 'no report fails');
  assert.equal(runSuite('admission-self-tests', { root: ROOT, env, spawn: () => ({ status: null, signal: 'SIGKILL' }), known, log,
    readReportFile: report([summary]) }), 128, 'a killed run fails');
});

test('the application suite gates lint, ledger, typecheck and build before the unit tests', () => {
  const calls = [];
  const spawn = (command, args) => { calls.push(args.join(' ')); return { status: args.includes('typecheck') ? 2 : 0 }; };
  assert.equal(runSuite('clued-cloud', { root: ROOT, env: {}, spawn, log, platform: 'linux' }), 2);
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
  runSuite('clued-cloud', { root: ROOT, env: {}, platform: 'win32', log, spawn: (command, args) => { calls.push([command, ...args]); return { status: 1 }; } });
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

test('a platform step runs every selected suite, names each result, fails when any suite fails and passes when nothing is selected', () => {
  const ran = [];
  const lines = [];
  const run = (id) => { ran.push(id); return id === 'offline-drill' ? 3 : 0; };
  assert.equal(runSelected(['resident-node', 'offline-drill', 'selection'], { root: ROOT, env: {}, run, log, summary: (text) => lines.push(text) }), 1);
  assert.deepEqual(ran, ['resident-node', 'offline-drill', 'selection'], 'a failure does not hide the suites after it');
  assert.deepEqual(lines, ['- `resident-node`: passed\n', '- `offline-drill`: **failed**\n', '- `selection`: passed\n']);
  assert.equal(runSelected(['resident-node'], { root: ROOT, env: {}, run, log }), 0);
  assert.equal(runSelected([], { root: ROOT, env: {}, run: () => assert.fail('nothing to run'), log }), 0);
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

test('a change that breaks only on Windows fails ci-suites-windows and passes the Linux side, through the same selection and commands', (t) => {
  const job = windowsJob();
  assert.deepEqual(job, { published: 'ci-suites-windows', platform: 'win32', check: 'ci-suites', root: 'candidate' });
  const candidate = mkdtempSync(path.join(os.tmpdir(), 'ci-both-platforms-'));
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  mkdirSync(path.join(candidate, 'scripts', 'ci'), { recursive: true });
  mkdirSync(path.join(candidate, 'tools'));
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
  const status = runSelected(selectSuites(job.check, files, hostPlatform()).suites, { root: candidate, env: childEnv(), log,
    run: (id, options) => runSuite(id, { ...options, spawn: quiet }), summary: (text) => lines.push(text) });
  if (process.platform === 'win32') {
    assert.equal(hostPlatform(), job.platform, 'this host is the platform of the ci-suites-windows job');
    assert.equal(status, 1, 'ci-suites-windows fails: this is the failure a Linux-only CI never saw');
    assert.deepEqual(lines, ['- `powershell-count`: **failed**\n']);
  } else {
    assert.equal(status, 0, 'the same change is green on Linux');
    assert.deepEqual(lines, ['- `powershell-count`: passed\n']);
  }
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
  assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}\n {10}path: trusted\n/);
  assert.match(job, /\n {10}& node trusted\/scripts\/ci\/ci-required-selection\.mjs --run-selected ci-suites --root candidate\n {10}exit \$LASTEXITCODE\n/);
  assert.equal(job.match(/\brun: /g).length, 1, 'one command: nothing else can pass or fail the job');
  assert.doesNotMatch(job, /continue-on-error|setup-node|npm /);
});
