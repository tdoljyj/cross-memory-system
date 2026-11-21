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
const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; for (const name of ['GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) delete env[name]; return env; };
const groupLines = (out) => out.split(/\r?\n/).filter((line) => line.startsWith('::group::'));

// A checkout whose selector is this one with `tail` appended (source text run inside the module).
function checkout(t, tail = '', files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-candidate-suite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'scripts/ci');
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(ROOT, 'scripts/ci/test-env.mjs'), path.join(dir, 'test-env.mjs'));
  writeFileSync(path.join(dir, 'ci-required-selection.mjs'), `${SOURCE}\n${tail}\n`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return { root, selector: path.join(dir, 'ci-required-selection.mjs') };
}
const passing = (label) => `import test from 'node:test';\ntest('${label}', () => { console.log('${label} executed'); });\n`;
const failing = (label) => `import test from 'node:test';\ntest('${label}', () => { console.log('${label} executed'); throw new Error('${label} red'); });\n`;

// The trusted selector on the candidate checkout, in Actions (no local slot).
const cli = (selector, args, env = {}) => spawnSync(process.execPath, [selector, ...args],
  { env: { ...childEnv(), GITHUB_ACTIONS: 'true', ...env }, encoding: 'utf8' });
const NEW_SUITE = (platforms) => `SUITES['ci-suites']['brand-new'] = ['scripts/ci/brand-new/**'];
SUITE_COMMANDS['brand-new'] = [{ cwd: '.', known: 'retrigger-counter', argv: ['node', '--test', '{tests:scripts/ci/brand-new}'] }];
${platforms ? `SUITE_PLATFORMS['brand-new'] = { platforms: ${JSON.stringify(platforms)}, reason: 'test' };` : ''}`;

test('a suite the pull request adds is selected by --check (the selection --run-selected makes too) and runs whole through --run', (t) => {
  const trusted = path.join(ROOT, 'scripts/ci/ci-required-selection.mjs');
  const red = checkout(t, NEW_SUITE(), {
    'scripts/ci/brand-new/a.test.mjs': passing('new suite a'), 'scripts/ci/brand-new/b.test.mjs': failing('new suite b') });
  // --check, as the select step runs it, lists the new suite (on every platform: the candidate declares none).
  const output = path.join(red.root, 'github-output');
  const checked = cli(trusted, ['--check', 'ci-suites', '--root', red.root], { GITHUB_OUTPUT: output });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const suites = JSON.parse(/^suites=(.*)$/m.exec(readFileSync(output, 'utf8'))[1]);
  assert.ok(suites.includes('brand-new'), `the new suite must be selected: ${suites.join(' ')}`);
  assert.equal(suites.at(-1), 'brand-new', 'after the trusted suites');
  assert.match(checked.stdout, /brand-new/);
  // --run, as the run step and --run-selected run each suite: the candidate's commands, whole, with no known-failure allowance.
  const run = cli(trusted, ['--run', 'brand-new', '--root', red.root]);
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

test('a new suite follows the candidate platform table; an unknown suite and a bad suite name still fail', (t) => {
  const linuxOnly = checkout(t, NEW_SUITE(['linux']));
  assert.deepEqual(selection.candidateSuites('ci-suites', linuxOnly.root, { platform: 'linux' }).map(({ id }) => id), ['brand-new']);
  assert.deepEqual(selection.candidateSuites('ci-suites', linuxOnly.root, { platform: 'win32' }), []);
  assert.deepEqual(selection.candidateSuites('ci-suites', linuxOnly.root).map(({ id }) => id), ['brand-new']);
  // The trusted selector itself adds nothing, and a suite neither side knows is still unknown.
  assert.deepEqual(selection.candidateSuites('ci-suites', ROOT), []);
  assert.throws(() => [...selection.requiredCommands('no-such-suite', ROOT)], /unknown suite/);
  assert.throws(() => [...selection.requiredCommands('no-such-suite', linuxOnly.root)], /unknown suite/);
  // Its name goes into the job's output and a shell loop: only plain suite names.
  const bad = checkout(t, "SUITES['ci-suites']['x y\\nsuites=[]'] = ['**'];");
  assert.throws(() => selection.candidateSuites('ci-suites', bad.root), /invalid candidate suite name/);
  const output = path.join(bad.root, 'github-output');
  const checked = cli(path.join(ROOT, 'scripts/ci/ci-required-selection.mjs'), ['--check', 'ci-suites', '--root', bad.root], { GITHUB_OUTPUT: output });
  assert.notEqual(checked.status, 0, 'a candidate suite table that cannot be read fails the check');
  assert.doesNotMatch(readFileSync(output, 'utf8'), /x y/);
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
  copyFileSync(path.join(ROOT, 'scripts/ci/test-env.mjs'), path.join(dir, 'scripts/ci/test-env.mjs'));
  const trusted = path.join(dir, 'scripts/ci/ci-required-selection.mjs');
  writeFileSync(trusted, SOURCE.replace(command, own));
  const tail = `const ownExpand = expandArgv;
expandArgv = (argv, options) => ownExpand(argv, options).flatMap((arg) => (arg === 'scripts/ci/rc/a.test.mjs' ? [arg, 'scripts/ci/rc-more/b.test.mjs'] : [arg]));`;
  const candidate = mkdtempSync(path.join(os.tmpdir(), 'ci-candidate-expand-'));
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  mkdirSync(path.join(candidate, 'scripts/ci/rc'), { recursive: true });
  mkdirSync(path.join(candidate, 'scripts/ci/rc-more'), { recursive: true });
  copyFileSync(path.join(ROOT, 'scripts/ci/test-env.mjs'), path.join(candidate, 'scripts/ci/test-env.mjs'));
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
