// Task cb5017b6 (FABLE-c2-review-rulings-20261121, "补：与缺口 A 的关系" ruling 2): the candidate's suite table and command
// lists are read by the candidate's own rules. A suite a pull request adds runs whole in that pull request's required check;
// the commands are compared after each side expanded its own, so a new placeholder, or a changed expansion under an
// unchanged command line, runs only the test files it adds. Each test runs the trusted selector as the workflow does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as selection from './ci-required-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), 'utf8');
// What the selector imports from beside it: a copy of it runs only with them (the real-clock guard since Task 11092b8b).
const SELECTOR_IMPORTS = ['test-env.mjs', 'test-clock-scan.mjs', 'test-clock-guard.mjs'];
const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; for (const name of ['GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) delete env[name]; return env; };
const groupLines = (out) => out.split(/\r?\n/).filter((line) => line.startsWith('::group::'));

// A checkout whose selector is this one with `tail` appended (source text run inside the module). `at` puts it at that path
// (a job's workspace has it at candidate/).
function checkout(t, tail = '', files = {}, at = null) {
  const root = at ?? mkdtempSync(path.join(os.tmpdir(), 'ci-candidate-suite-'));
  if (at) mkdirSync(at, { recursive: true });
  else t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'scripts/ci');
  mkdirSync(dir, { recursive: true });
  for (const name of SELECTOR_IMPORTS) copyFileSync(path.join(ROOT, 'scripts/ci', name), path.join(dir, name));
  writeFileSync(path.join(dir, 'ci-required-selection.mjs'), `${SOURCE}\n${tail}\n`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return { root, selector: path.join(dir, 'ci-required-selection.mjs') };
}
const passing = (label) => `import test from 'node:test';\ntest('${label}', () => { console.log('${label} executed'); });\n`;
const failing = (label) => `import test from 'node:test';\ntest('${label}', () => { console.log('${label} executed'); throw new Error('${label} red'); });\n`;

// The trusted selector on the candidate checkout, in Actions (no local slot), with the base commit a CI job always has
// (ciBaseRefusal): a fixed one, not the outer environment's, so CI and a local run take the same path.
const cli = (selector, args, env = {}, cwd = undefined) => spawnSync(process.execPath, [selector, ...args],
  { cwd, env: { ...childEnv(), GITHUB_ACTIONS: 'true', CI_BASE_SHA: 'f'.repeat(40), ...env }, encoding: 'utf8' });
const NEW_SUITE = (platforms) => `SUITES['ci-suites']['brand-new'] = ['scripts/ci/brand-new/**'];
SUITE_COMMANDS['brand-new'] = [{ cwd: '.', known: 'retrigger-counter', argv: ['node', '--test', '{tests:scripts/ci/brand-new}'] }];
${platforms ? `SUITE_PLATFORMS['brand-new'] = { platforms: ${JSON.stringify(platforms)}, reason: 'test' };` : ''}`;

// How the two ci-suites jobs call the selector, read from the workflows: the arguments after the selector.
const workflowCall = (file, pattern) => {
  const match = pattern.exec(readFileSync(path.join(ROOT, file), 'utf8'));
  assert.ok(match, `${file}: the selector call this test follows is not there`);
  return match[1].trim().split(/\s+/);
};
const LINUX_SELECT = () => workflowCall('.github/workflows/clued-required-tests.yml', /\n {10}node "\$selector" (--check ci-suites[^\n]*)\n/);
const WINDOWS_RUN = () => workflowCall('.github/workflows/clued-required-tests-windows.yml',
  /\n {10}& node trusted\/scripts\/ci\/ci-required-selection\.mjs (--run-selected ci-suites[^\n]*)\n/);

test('a suite the pull request adds runs whole in ci-suites-windows; the Linux select step does not read it yet (PR L)', (t) => {
  const trusted = path.join(ROOT, 'scripts/ci/ci-required-selection.mjs');
  // A job's workspace: the candidate at candidate/, the selector called with the workflow's own arguments from there.
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'ci-candidate-workspace-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const red = checkout(t, NEW_SUITE(), {
    'scripts/ci/brand-new/a.test.mjs': passing('new suite a'), 'scripts/ci/brand-new/b.test.mjs': failing('new suite b') },
  path.join(workspace, 'candidate'));

  // Linux (clued-required-tests.yml, ci-suites): the select step, called as the workflow calls it.
  const output = path.join(workspace, 'github-output');
  const checked = cli(trusted, LINUX_SELECT(), { GITHUB_OUTPUT: output }, workspace);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const suites = JSON.parse(/^suites=(.*)$/m.exec(readFileSync(output, 'utf8'))[1]);
  // Known gap (FABLE-new-suite-run-points-20261121 §1): the Linux select step passes no --root, so it reads no candidate
  // suite table and a suite the pull request adds does not run on Linux. PR L adds --root candidate to that line; then this
  // assertion fails: turn it into the selected one below (includes 'brand-new', after the trusted suites).
  assert.equal(suites.includes('brand-new'), false, `PR L landed? the Linux select step now selects the new suite: ${suites.join(' ')}`);

  // Windows (clued-required-tests-windows.yml, ci-suites-windows): --run-selected with the workflow's arguments selects as
  // selectWithCandidate does (its main calls exactly that), then runs each selected suite as --run does.
  const [mode, check, ...rest] = WINDOWS_RUN();
  assert.deepEqual([mode, check, ...rest], ['--run-selected', 'ci-suites', '--root', 'candidate']);
  const root = path.resolve(workspace, rest[1]);
  const { selection: windows, error } = selection.selectWithCandidate(check, null, 'win32', root);
  assert.equal(error, null);
  assert.equal(windows.suites.at(-1), 'brand-new', `the new suite is selected after the trusted ones: ${windows.suites.join(' ')}`);
  assert.match(windows.reason, /the candidate adds brand-new: each runs whole/);
  const run = cli(trusted, ['--run', 'brand-new', '--root', rest[1]], {}, workspace);
  assert.notEqual(run.status, 0, `the failing test of the new suite must fail it\n${run.stdout}${run.stderr}`);
  assert.deepEqual(groupLines(run.stdout),
    ['::group::brand-new: (.) node --test scripts/ci/brand-new/a.test.mjs scripts/ci/brand-new/b.test.mjs']);
  assert.match(run.stdout, /new suite a executed/);
  assert.match(run.stdout, /new suite b executed/);
  assert.doesNotMatch(run.stdout, /test-reporter/, 'no known-failure reporter: the candidate attaches no policy');
  const green = checkout(t, NEW_SUITE(), { 'scripts/ci/brand-new/a.test.mjs': passing('new suite a') });
  const passed = cli(trusted, ['--run', 'brand-new', '--root', green.root]);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /new suite a executed/);
});

test('a new suite follows the candidate platform table; an unknown, an empty and a badly named suite fail', (t) => {
  const linuxOnly = checkout(t, NEW_SUITE(['linux']));
  assert.deepEqual(selection.candidateSuites('ci-suites', linuxOnly.root, { platform: 'linux' }).map(({ id }) => id), ['brand-new']);
  assert.deepEqual(selection.candidateSuites('ci-suites', linuxOnly.root, { platform: 'win32' }), []);
  assert.deepEqual(selection.candidateSuites('ci-suites', linuxOnly.root).map(({ id }) => id), ['brand-new']);
  // The trusted selector itself adds nothing, and a suite neither side knows is still unknown.
  assert.deepEqual(selection.candidateSuites('ci-suites', ROOT), []);
  assert.throws(() => [...selection.requiredCommands('no-such-suite', ROOT)], /unknown suite/);
  assert.throws(() => [...selection.requiredCommands('no-such-suite', linuxOnly.root)], /unknown suite/);
  // A new suite with no command would pass having run nothing (review finding 2).
  const empty = checkout(t, "SUITES['ci-suites']['empty-new'] = ['**'];\nSUITE_COMMANDS['empty-new'] = [];");
  assert.throws(() => [...selection.requiredCommands('empty-new', empty.root)], /has no command/);
  const ran = cli(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), ['--run', 'empty-new', '--root', empty.root]);
  assert.notEqual(ran.status, 0, ran.stdout + ran.stderr);
  // Its name goes into the job's output and a shell loop: only plain suite names.
  const bad = checkout(t, "SUITES['ci-suites']['x y\\nsuites=[]'] = ['**'];");
  assert.throws(() => selection.candidateSuites('ci-suites', bad.root), /invalid candidate suite name/);
  const output = path.join(bad.root, 'github-output');
  const checked = cli(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), ['--check', 'ci-suites', '--root', bad.root], { GITHUB_OUTPUT: output });
  assert.notEqual(checked.status, 0, 'a candidate suite table that cannot be read fails the check');
  assert.doesNotMatch(readFileSync(output, 'utf8'), /x y/);
});

// What the trusted ci-deps.mjs installs (review finding 4): an application of the checkout with its lockfile, nothing else.
test("a new suite's application dependency is apps/<name> with a package-lock.json", (t) => {
  const withApp = (app) => checkout(t, `${NEW_SUITE()}\nSUITE_APP_DEPENDENCIES['brand-new'] = ${JSON.stringify(app)};`,
    { 'apps/x/package-lock.json': '{}\n', 'tools/y/package-lock.json': '{}\n' }).root;
  assert.deepEqual(selection.candidateSuites('ci-suites', withApp('apps/x')), [{ id: 'brand-new', app: 'apps/x' }]);
  const { selection: selected } = selection.selectWithCandidate('ci-suites', null, 'linux', withApp('apps/x'));
  assert.match(selection.outputLines('ci-suites', selected).find((line) => line.startsWith('app_deps=')), /"apps\/x"/);
  for (const app of ['apps/none', 'tools/y', 'apps/../tools/y', 'apps/x/', '/apps/x']) {
    assert.throws(() => selection.candidateSuites('ci-suites', withApp(app)), /invalid candidate application dependency/, app);
  }
});

// Ruling §3: only expanding commands may start a process; reading the suite tables may not.
test('reading the candidate suite table may not start a process; expanding its commands may', (t) => {
  const spawning = checkout(t, "{ const started = spawnSync(process.execPath, ['-e', '']); if (started.error) throw started.error; }");
  assert.throws(() => selection.candidateSuites('ci-suites', spawning.root), /cannot read the suites the candidate adds/);
  assert.deepEqual([...selection.requiredCommands('retrigger-counter', spawning.root)], SUITE_COMMANDS_OF('retrigger-counter'));
});
const SUITE_COMMANDS_OF = (id) => selection.SUITE_COMMANDS[id];

// Review finding 7: the real shape of C2's change. The trusted command lists the application's unit tests ({unit-tests},
// a process the candidate's own expansion starts under the permission model) with a known-failure allowance; the candidate
// appends a placeholder that adds a CI-script test outside the command's directory (../../scripts/...).
test('a test file the candidate adds after {unit-tests} runs alone, without the allowance, and fails the suite', (t) => {
  const entry = "'retrigger-counter': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/retrigger-counter.test.mjs'] }],";
  assert.ok(SOURCE.includes(entry));
  const unit = "'retrigger-counter': [{ cwd: 'apps/x', known: 'retrigger-counter', argv: ['node', '--test', '{unit-tests}'] }],";
  const trustedDir = mkdtempSync(path.join(os.tmpdir(), 'ci-trusted-unit-'));
  t.after(() => rmSync(trustedDir, { recursive: true, force: true }));
  mkdirSync(path.join(trustedDir, 'scripts/ci'), { recursive: true });
  for (const name of [...SELECTOR_IMPORTS, 'ci-test-failures-reporter.mjs']) {
    copyFileSync(path.join(ROOT, 'scripts/ci', name), path.join(trustedDir, 'scripts/ci', name));
  }
  writeFileSync(path.join(trustedDir, 'scripts/ci/ci-known-failures.json'), '{}\n');
  const trusted = path.join(trustedDir, 'scripts/ci/ci-required-selection.mjs');
  writeFileSync(trusted, SOURCE.replace(entry, unit));
  const candidate = checkout(t, `const ownExpand = expandArgv;
expandArgv = (argv, options) => ownExpand(argv.flatMap((arg) => (arg === '{ci-new}' ? ['../../scripts/ci/n.test.mjs'] : [arg])), options);
SUITE_COMMANDS['retrigger-counter'] = [{ cwd: 'apps/x', known: 'retrigger-counter', argv: ['node', '--test', '{unit-tests}', '{ci-new}'] }];`, {
    'apps/x/scripts/select-tests.mjs': "console.log('tests/a.test.mjs\\ntests/b.test.mjs');\n",
    'apps/x/tests/a.test.mjs': passing('unit a'), 'apps/x/tests/b.test.mjs': passing('unit b'),
    'scripts/ci/n.test.mjs': failing('ci script n') });
  const run = cli(trusted, ['--run', 'retrigger-counter', '--root', candidate.root]);
  assert.notEqual(run.status, 0, `the failing added file must fail the suite\n${run.stdout}${run.stderr}`);
  const groups = groupLines(run.stdout);
  assert.equal(groups.length, 2, groups.join('\n'));
  assert.match(groups[0], /^::group::retrigger-counter: \(apps\/x\) node --test --test-reporter=spec .* tests\/a\.test\.mjs tests\/b\.test\.mjs$/);
  assert.equal(groups[1], '::group::retrigger-counter: (apps/x) node --test ../../scripts/ci/n.test.mjs', 'only the added file, no reporter');
  assert.equal(run.stdout.split('unit a executed').length - 1, 1, 'the unit tests run once, in the trusted command');
  assert.equal(run.stdout.split('ci script n executed').length - 1, 1);
});

// The candidate expands its own placeholders: a placeholder the trusted selector does not know (C2's {ci-script-tests}) is
// a list of test files added to a trusted command, so only those files run, once, after the trusted command.
test('a placeholder only the candidate knows runs just the test files it adds, and their failure fails the suite', (t) => {
  const trusted = path.join(ROOT, 'scripts/ci/ci-required-selection.mjs');
  const tail = `const ownExpand = expandArgv;
expandArgv = (argv, options) => {
  // As C2's {ci-script-tests}: the candidate's rule may need the checkout root.
  if (!options.root) throw new Error('{extra-tests} needs the checkout root');
  return ownExpand(argv.flatMap((arg) => (arg === '{extra-tests}' ? ['scripts/ci/extra-new.test.mjs'] : [arg])), options);
};
SUITE_COMMANDS['retrigger-counter'] = [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/retrigger-counter.test.mjs', '{extra-tests}'] }];`;
  const candidate = checkout(t, tail, {
    'scripts/ci/retrigger-counter.test.mjs': passing('baseline'), 'scripts/ci/extra-new.test.mjs': failing('extra file') });
  const run = cli(trusted, ['--run', 'retrigger-counter', '--root', candidate.root]);
  assert.notEqual(run.status, 0, `the failing added file must fail the suite\n${run.stdout}${run.stderr}`);
  assert.deepEqual(groupLines(run.stdout), ['::group::retrigger-counter: (.) node --test scripts/ci/retrigger-counter.test.mjs',
    '::group::retrigger-counter: (.) node --test scripts/ci/extra-new.test.mjs']);
  assert.equal(run.stdout.split('baseline executed').length - 1, 1, 'the trusted file runs once');
  assert.match(run.stdout, /extra file executed/);
});

// A pull request that changes only how a placeholder expands (the command lines are byte for byte the trusted ones) adds
// the files the new rule adds; gap A compared the command lines and saw no change.
test('a changed expansion under an unchanged command line runs the test files it adds', (t) => {
  const command = "'retrigger-counter': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/retrigger-counter.test.mjs'] }],";
  assert.ok(SOURCE.includes(command));
  const own = "'retrigger-counter': [{ cwd: '.', argv: ['node', '--test', '{tests:scripts/ci/rc}'] }],";
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-trusted-expand-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'scripts/ci'), { recursive: true });
  for (const name of SELECTOR_IMPORTS) copyFileSync(path.join(ROOT, 'scripts/ci', name), path.join(dir, 'scripts/ci', name));
  const trusted = path.join(dir, 'scripts/ci/ci-required-selection.mjs');
  writeFileSync(trusted, SOURCE.replace(command, own));
  const tail = `const ownExpand = expandArgv;
expandArgv = (argv, options) => ownExpand(argv, options).flatMap((arg) => (arg === 'scripts/ci/rc/a.test.mjs' ? [arg, 'scripts/ci/rc-more/b.test.mjs'] : [arg]));`;
  const candidate = mkdtempSync(path.join(os.tmpdir(), 'ci-candidate-expand-'));
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  mkdirSync(path.join(candidate, 'scripts/ci/rc'), { recursive: true });
  mkdirSync(path.join(candidate, 'scripts/ci/rc-more'), { recursive: true });
  for (const name of SELECTOR_IMPORTS) copyFileSync(path.join(ROOT, 'scripts/ci', name), path.join(candidate, 'scripts/ci', name));
  writeFileSync(path.join(candidate, 'scripts/ci/ci-required-selection.mjs'), `${SOURCE.replace(command, own)}\n${tail}\n`);
  writeFileSync(path.join(candidate, 'scripts/ci/rc/a.test.mjs'), passing('baseline'));
  writeFileSync(path.join(candidate, 'scripts/ci/rc-more/b.test.mjs'), failing('rule addition'));
  const run = cli(trusted, ['--run', 'retrigger-counter', '--root', candidate]);
  assert.notEqual(run.status, 0, `the file the new rule adds must run and fail the suite\n${run.stdout}${run.stderr}`);
  assert.deepEqual(groupLines(run.stdout), ['::group::retrigger-counter: (.) node --test scripts/ci/rc/a.test.mjs',
    '::group::retrigger-counter: (.) node --test scripts/ci/rc-more/b.test.mjs']);
  assert.match(run.stdout, /rule addition executed/);
  // The same rule on both sides: nothing more runs. (The CLI runs at the end of the file: the rule goes in before it.)
  const marker = '\nconst real = (file) => {';
  assert.equal(SOURCE.split(marker).length, 2);
  writeFileSync(trusted, SOURCE.replace(command, own).replace(marker, `\n${tail}${marker}`));
  writeFileSync(path.join(candidate, 'scripts/ci/rc-more/b.test.mjs'), passing('rule addition'));
  const same = cli(trusted, ['--run', 'retrigger-counter', '--root', candidate]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.deepEqual(groupLines(same.stdout),
    ['::group::retrigger-counter: (.) node --test scripts/ci/rc/a.test.mjs scripts/ci/rc-more/b.test.mjs']);
});
