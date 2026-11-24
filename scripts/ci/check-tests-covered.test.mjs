import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SPECIFIER_PATTERNS } from '../../apps/clued-cloud/scripts/select-tests.mjs';
import { coverage, isTestFile, TABLE_PATH, trackedFiles } from './check-tests-covered.mjs';
import { CI_SCRIPT_TEST_DIRS, IMPORT_PATTERNS, SUITES, SUITE_COMMANDS, ciScriptTests, planFiles } from './ci-required-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASK = '700f2b68-b355-4edb-95c1-be97f04ea8de';
const RUNNER = 'node:' + 'test';

// A throwaway checkout: files (path -> text), its own suite commands and table; tracked defaults to every file.
// The base the lists are measured against defaults to the same table, the same files and no known failures.
function fixture(t, files, { commands = { unit: [{ cwd: '.', argv: ['node', '--test', '{tests:t}'] }] }, table = { tests: [] }, tracked,
  known = {}, baseline = { base: 'base', table, known: {}, files: tracked ?? Object.keys(files) } } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tests-covered-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return coverage({ root, tracked: tracked ?? Object.keys(files), table, known, baseline, commands, listUnit: () => [] });
}
const entry = (file, extra = {}) => ({ path: file, kind: 'unsorted', task: TASK, reason: '从没在必需检查里跑过，红绿未知，等下一批分拣', ...extra });

test('test files are named *.test.{mjs,js,cjs,ts}, test_*.py or *_test.py', () => {
  for (const file of ['a.test.mjs', 'x/a.test.js', 'x/a.test.cjs', 'x/a.test.ts', 'tests/test_a.py', 'x/a_test.py']) assert.ok(isTestFile(file), file);
  for (const file of ['a.mjs', 'x/a.case.mjs', 'x/test-a.mjs', 'x/test_a.cjs', 'x/a.test.py', 'x/latest_a.py.txt']) assert.ok(!isTestFile(file), file);
});

// FABLE-defect-remediation-plan-20261124 §3.6 steps 1-4 (搁161, 搁48): the full set is every file named as a test, the
// PowerShell ones too, and both lists only shrink against the base.
test('PowerShell tests are test files too: test-*.ps1 and *.Tests.ps1', () => {
  for (const file of ['test-x.ps1', 'a/test-x.ps1', 'a/b/x.Tests.ps1']) assert.ok(isTestFile(file), file);
  for (const file of ['a/x-test.ps1', 'a/latest-x.ps1', 'a/test-x.psm1', 'a/x.Tests.ps1.txt']) assert.ok(!isTestFile(file), file);
});

test('a test file no suite runs fails wherever it is and whatever it is written in, until listed', (t) => {
  const files = { 't/a.test.mjs': '', 'test-x.ps1': '', 'tools/x.Tests.ps1': '', 'tests/sub/y-db.test.mjs': '' };
  assert.deepEqual(fixture(t, files).problems.map((problem) => problem.split(':')[0]), ['test-x.ps1', 'tools/x.Tests.ps1', 'tests/sub/y-db.test.mjs']);
  const table = { tests: [entry('test-x.ps1'), entry('tools/x.Tests.ps1'), entry('tests/sub/y-db.test.mjs')] };
  assert.deepEqual(fixture(t, files, { table }).problems, []);
});

test('a new test-x.ps1 in the repository fails the check: no suite command takes a PowerShell file', () => {
  const { problems } = coverage({ root: ROOT, tracked: [...trackedFiles(ROOT), 'scripts/ci/test-x.ps1'] });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /^scripts\/ci\/test-x\.ps1: no required suite runs it and scripts\/ci\/ci-uncovered-tests\.json does not list it/);
});

const SHRINKS = 'clued.ci-uncovered-tests/2';
test('the uncovered table only shrinks against the base: an entry the base does not list fails, one removed passes', (t) => {
  const files = { 't/a.test.mjs': '', 'u/b.test.mjs': '', 'u/c.test.mjs': '' };
  const baseline = { base: 'b1', table: { schema: SHRINKS, tests: [entry('u/b.test.mjs')] }, known: {}, files: [...Object.keys(files), 'old/d.test.mjs'] };
  assert.deepEqual(fixture(t, files, { table: { schema: SHRINKS, tests: [entry('u/b.test.mjs'), entry('u/c.test.mjs')] }, baseline }).problems,
    ['u/c.test.mjs: the base (b1) does not list it; scripts/ci/ci-uncovered-tests.json only shrinks: make a required suite run it']);
  // A pattern is an entry like any other.
  assert.deepEqual(fixture(t, { ...files, 'old/d.test.mjs': '' }, { table: { schema: SHRINKS, tests: [entry('u/b.test.mjs'), entry('u/c.test.mjs'),
    entry('old/**', { kind: 'archive' })] }, baseline: { ...baseline, table: { schema: SHRINKS, tests: [entry('u/b.test.mjs'), entry('u/c.test.mjs')] } } }).problems,
  ['old/**: the base (b1) does not list it; scripts/ci/ci-uncovered-tests.json only shrinks: make a required suite run it']);
  // Removed (the file is gone, or now runs): passes. Sorting an entry (kind, reason) is no growth.
  const both = { ...baseline, table: { schema: SHRINKS, tests: [entry('u/b.test.mjs'), entry('u/c.test.mjs')] } };
  assert.deepEqual(fixture(t, files, { tracked: ['t/a.test.mjs', 'u/c.test.mjs'], table: { schema: SHRINKS, tests: [entry('u/c.test.mjs')] },
    baseline: both }).problems, []);
  assert.deepEqual(fixture(t, { ...files, 't/b.test.mjs': '' }, { tracked: ['t/a.test.mjs', 't/b.test.mjs', 'u/c.test.mjs'],
    table: { schema: SHRINKS, tests: [entry('u/c.test.mjs', { kind: 'environment' })] }, baseline: both }).problems, []);
  // Once the base has the rule, the candidate keeps it.
  assert.deepEqual(fixture(t, files, { table: { schema: 'clued.ci-uncovered-tests/1', tests: [entry('u/b.test.mjs'), entry('u/c.test.mjs')] },
    baseline: both }).problems, ['scripts/ci/ci-uncovered-tests.json: schema must stay clued.ci-uncovered-tests/2, as at the base (b1): the list only shrinks']);
  // The change that brings the rule lists today's gaps: its base has no rule yet.
  assert.deepEqual(fixture(t, files, { table: { schema: SHRINKS, tests: [entry('u/b.test.mjs'), entry('u/c.test.mjs')] },
    baseline: { base: 'b0', table: { schema: 'clued.ci-uncovered-tests/1', tests: [] }, known: {} } }).problems, []);
});

test('an archive pattern is sealed: a test file the base does not have fails even where the pattern matches it', (t) => {
  const files = { 't/a.test.mjs': '', 'old/b.test.mjs': '', 'old/sub/c.test.mjs': '' };
  const table = { schema: SHRINKS, tests: [entry('old/**', { kind: 'archive' })] };
  const baseline = { base: 'b1', table, known: {}, files: ['t/a.test.mjs', 'old/b.test.mjs'] };
  const sealed = 'old/sub/c.test.mjs: the base (b1) does not have it; the archive old/** is sealed and takes no new test: make a required suite run it';
  assert.deepEqual(fixture(t, files, { table, baseline }).problems, [sealed]);
  // No bootstrap: sealed whatever schema the base's table has.
  assert.deepEqual(fixture(t, files, { table, baseline: { ...baseline, table: { tests: table.tests } } }).problems, [sealed]);
  // A file the base had stays exempt.
  assert.deepEqual(fixture(t, files, { table, baseline: { ...baseline, files: Object.keys(files) } }).problems, []);
});

const failure = (file, name, fingerprint = '0123456789abcdef') => ({ file, path: [name], fingerprint, reason: 'fails on main' });
test('the known-failure list only shrinks against the base: a new entry, or a listed test failing for a new reason, fails', (t) => {
  const files = { 't/a.test.mjs': '' };
  const known = { unit: [failure('t/a.test.mjs', 'one'), failure('t/a.test.mjs', 'two')] };
  const baseline = { base: 'b1', table: { tests: [] }, known };
  assert.deepEqual(fixture(t, files, { known, baseline }).problems, []);
  assert.deepEqual(fixture(t, files, { known: { unit: [failure('t/a.test.mjs', 'two')], other: [] }, baseline }).problems, []);
  assert.deepEqual(fixture(t, files, { known: { unit: [...known.unit, failure('t/a.test.mjs', 'three'), failure('t/a.test.mjs', 'one', 'fedcba9876543210')],
    other: [failure('t/a.test.mjs', 'one')] }, baseline }).problems, [
    'scripts/ci/ci-known-failures.json: unit: t/a.test.mjs :: three :: 0123456789abcdef: the base (b1) does not list it; the list only shrinks: fix the test',
    'scripts/ci/ci-known-failures.json: unit: t/a.test.mjs :: one :: fedcba9876543210: the base (b1) does not list it; the list only shrinks: fix the test',
    'scripts/ci/ci-known-failures.json: other: t/a.test.mjs :: one :: 0123456789abcdef: the base (b1) does not list it; the list only shrinks: fix the test',
  ]);
});

test('the repository as committed: every test file runs in a required suite or is listed with its kind, reason and Task', () => {
  const result = coverage({ root: ROOT });
  assert.deepEqual(result.problems, []);
  assert.ok(result.counts.tests > 900 && result.counts.runs > 600, JSON.stringify(result.counts));
});

// PLAN-g4-red-merged-20261125 §2.2 (Task 4432ee9b): the PostgreSQL 17 backup coverage test runs in production-schema (the
// real database command of migration-verify names it), so its entry (Task 5ba48256: production-schema had no Docker image)
// is gone; listed again, the table says it runs and the entry must go.
test('the PostgreSQL 17 backup coverage test runs in production-schema and is not listed as uncovered', () => {
  const file = 'apps/clued-cloud/tests/production-backup-scope-db.test.mjs';
  const table = JSON.parse(readFileSync(path.join(ROOT, TABLE_PATH), 'utf8'));
  assert.deepEqual(table.tests.filter((listed) => listed.path === file), []);
  table.tests.push(entry(file, { kind: 'environment' }));
  const { problems } = coverage({ root: ROOT, table, baseline: null });
  assert.deepEqual(problems, [`${file}: runs in a required suite (production-schema); remove the entry`]);
});

test('a new test file no suite runs and the table does not list fails the check, naming the file', () => {
  const tracked = [...trackedFiles(ROOT), 'scripts/ci/brand-new-orphan.test.mjs', 'tests/test_brand_new_orphan.py'];
  const { problems } = coverage({ root: ROOT, tracked });
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /^scripts\/ci\/brand-new-orphan\.test\.mjs: no required suite runs it and scripts\/ci\/ci-uncovered-tests\.json does not list it \(other tests of scripts\/ci run in /);
  assert.match(problems[1], /^tests\/test_brand_new_orphan\.py: no required suite runs it/);
});

test('a listed file that no longer exists, or that now runs, fails: remove the entry', () => {
  const table = JSON.parse(readFileSync(path.join(ROOT, TABLE_PATH), 'utf8'));
  table.tests.push(entry('scripts/ci/long-gone.test.mjs'), entry('scripts/ci/ci-required-selection.test.mjs'));
  const { problems } = coverage({ root: ROOT, table, baseline: null }); // the base is not this test: once main has the shrinking rule it would also report growth
  assert.deepEqual(problems, ['scripts/ci/long-gone.test.mjs: no such tracked file; remove the entry',
    'scripts/ci/ci-required-selection.test.mjs: runs in a required suite (selection, clued-cloud); remove the entry']);
});

test('a file in a directory a suite collects runs; the same file elsewhere is uncovered until listed', (t) => {
  const files = { 't/a.test.mjs': '', 'u/b.test.mjs': '', 'u/c.test.mjs': '' };
  assert.deepEqual(fixture(t, files, { table: { tests: [entry('u/c.test.mjs')] } }).problems,
    ['u/b.test.mjs: no required suite runs it and scripts/ci/ci-uncovered-tests.json does not list it']);
  assert.deepEqual(fixture(t, files, { table: { tests: [entry('u/b.test.mjs'), entry('u/c.test.mjs')] } }).problems, []);
  const result = fixture(t, files, { table: { tests: [entry('u/b.test.mjs'), entry('u/c.test.mjs')] } });
  assert.deepEqual(result.collects, ['t/*.test.mjs -> unit']);
  assert.deepEqual(result.counts, { tests: 3, runs: 1, exempt: 2, misnamed: 0 });
});

test('coverage by import counts top-level static imports of test files only', (t) => {
  const files = { 't/root.test.mjs': ["import '../x/a.test.mjs';", "import { x } from\n  '../x/b.test.mjs';", "// import '../x/c.test.mjs';",
    "/*\nimport '../x/d.test.mjs';\n*/", "const s = \"import '../x/e.test.mjs'\";", "if (x) await import('../x/e.test.mjs');",
    "import '../x/helper.mjs';", 'const t = `', "import '../x/g.test.mjs';", '`;', "import type { T } from '../x/h.test.ts';",
    "import type * as N from '../x/i.test.ts';", "import type D from '../x/j.test.ts';", "import type from '../x/k.test.mjs';", ''].join('\n'),
  'x/helper.mjs': "import './f.test.mjs';\n" };
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'k']) files[`x/${name}.test.mjs`] = '';
  for (const name of ['h', 'i', 'j']) files[`x/${name}.test.ts`] = '';
  const uncovered = fixture(t, files).problems.map((problem) => problem.split(':')[0]);
  // A template string's lines are text, and `import type` is erased before the module runs (`import type from` imports
  // a default export named type).
  assert.deepEqual(uncovered, ['x/c.test.mjs', 'x/d.test.mjs', 'x/e.test.mjs', 'x/f.test.mjs', 'x/g.test.mjs', 'x/h.test.ts', 'x/i.test.ts',
    'x/j.test.ts']);
});

test('Python tests count by the selection\'s own reading: discover, file operands and module names', (t) => {
  const commands = { py: [{ cwd: 'r', argv: ['python3', '-I', '-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'] },
    { cwd: '.', argv: ['python3', '-m', 'unittest', 'tests.test_mod', 'scripts/test_path.py'] },
    { cwd: '.', argv: ['python3', '-I', 'tests/test_script.py'] }] };
  const files = { 'r/test/test_a.py': '', 'r/test/helper_test.py': '', 'tests/test_mod.py': '', 'scripts/test_path.py': '', 'tests/test_script.py': '',
    'tests/test_other.py': '', 'r/test/sub/test_nested.py': '' };
  // discover here takes the start directory's own files: a file in a subdirectory without __init__.py is never imported,
  // and counting it would pass a test that does not run.
  assert.deepEqual(fixture(t, files, { commands }).problems.map((problem) => problem.split(':')[0]),
    ['r/test/helper_test.py', 'tests/test_other.py', 'r/test/sub/test_nested.py']);
});

test('entries need a known kind, a reason of 20 characters and a Clued Task; only archive may be a pattern', (t) => {
  const files = { 't/a.test.mjs': '', 'u/b.test.mjs': '', 'u/c.test.mjs': '', 'u/d.test.mjs': '', 'v/e.test.mjs': '' };
  const table = { tests: [entry('u/b.test.mjs', { kind: 'later' }), entry('u/c.test.mjs', { reason: 'x' }), entry('u/d.test.mjs', { task: '5ba48256' }),
    entry('v/*.test.mjs'), entry('v/e.test.mjs', { kind: 'other-workflow' })] };
  assert.deepEqual(fixture(t, files, { table }).problems, [
    'u/b.test.mjs: kind must be one of environment, stale-or-suspect, other-workflow, unsorted, archive',
    'u/c.test.mjs: reason of at least 20 characters',
    'u/d.test.mjs: task must be a Clued Task id',
    'v/*.test.mjs: only an archive entry may be a pattern; list unsorted files one by one',
    'v/e.test.mjs: an other-workflow entry names its workflow file (.github/workflows/<name>.yml)',
  ]);
  assert.deepEqual(fixture(t, { ...files, 'x/y.test.mjs': '' }, { table: { tests: [entry('u/b.test.mjs'), entry('u/b.test.mjs'),
    entry('u/c.test.mjs'), entry('u/d.test.mjs'), entry('v/**', { kind: 'archive' }), entry('x/**', { kind: 'archive' })] } }).problems,
  ['u/b.test.mjs: listed twice']);
});

test('an archive pattern that matches no test file, or matches one that runs, fails', (t) => {
  const files = { 't/a.test.mjs': '', 'old/b.test.mjs': '' };
  assert.deepEqual(fixture(t, files, { table: { tests: [entry('old/**', { kind: 'archive' }), entry('gone/**', { kind: 'archive' })] } }).problems,
    ['gone/**: matches no test file; remove the entry']);
  assert.deepEqual(fixture(t, files, { table: { tests: [entry('**/*.test.mjs', { kind: 'archive' })] } }).problems,
    ['**/*.test.mjs: matches t/a.test.mjs, which runs in a required suite (unit); narrow the entry',
      'old/b.test.mjs: no required suite runs it and scripts/ci/ci-uncovered-tests.json does not list it']);
});

test('an other-workflow entry needs a workflow file with a pull_request trigger that names the test', (t) => {
  const workflow = (on, run) => `name: x\non:\n${on}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;
  const files = { 't/a.test.mjs': '', 'tests/test_b.py': '', 'tests/test_c.py': '', 'tests/test_d.py': '', 'tests/test_e.py': '',
    '.github/workflows/ok.yml': workflow('  pull_request:\n    paths: [x]', 'python -m unittest tests.test_b tests.test_e'),
    '.github/workflows/push.yml': workflow('  push:', 'python tests/test_c.py'),
    '.github/workflows/other.yml': workflow('  pull_request:', 'python tests/test_x.py') };
  const ow = (file, name) => entry(file, { kind: 'other-workflow', workflow: name });
  assert.deepEqual(fixture(t, files, { table: { tests: [ow('tests/test_b.py', 'ok.yml'), ow('tests/test_c.py', 'push.yml'),
    ow('tests/test_d.py', 'other.yml'), ow('tests/test_e.py', 'missing.yml')] } }).problems, [
    'tests/test_c.py: workflow push.yml has no pull_request trigger',
    'tests/test_d.py: workflow other.yml does not name this test',
    'tests/test_e.py: workflow .github/workflows/missing.yml does not exist',
  ]);
});

test('a file that imports a test runner under another name fails unless a test imports it, a suite runs it, or it is listed', (t) => {
  const files = { 't/a.test.mjs': "import './x.case.mjs';\n", 't/x.case.mjs': `import test from '${RUNNER}';\n`,
    'u/orphan.mjs': `import test from '${RUNNER}';\n`, 'u/plain.mjs': "import fs from 'node:fs';\n",
    'u/test_old.cjs': `const test = require('${RUNNER}');\n`, 'u/case.test.py': 'import unittest\nclass T(unittest.TestCase):\n    pass\n',
    'tool/run.py': 'import unittest\nclass T(unittest.TestCase):\n    pass\n' };
  const commands = { unit: [{ cwd: '.', argv: ['node', '--test', '{tests:t}'] }, { cwd: '.', argv: ['python3', 'tool/run.py'] }] };
  const misnamed = (problem) => problem.endsWith('rename it (*.test.mjs, test_*.py) or list it');
  const found = fixture(t, files, { commands }).problems;
  assert.deepEqual(found.filter(misnamed).map((problem) => problem.split(':')[0]), ['u/orphan.mjs', 'u/test_old.cjs', 'u/case.test.py']);
  assert.equal(found.length, 3);
  assert.deepEqual(fixture(t, files, { commands, table: { tests: [entry('u/orphan.mjs'), entry('u/test_old.cjs'), entry('u/case.test.py')] } }).problems, []);
  assert.ok(fixture(t, files, { commands, table: { tests: [entry('u/plain.mjs')] } }).problems
    .includes('u/plain.mjs: neither a test file nor a file that imports a test runner; remove the entry'));
});

test('the CI-script tests run each in clued-cloud, which every change runs: the check\'s own test among them', () => {
  assert.deepEqual(SUITES['clued-cloud-tests']['clued-cloud'], ['**']);
  const { steps } = planFiles('clued-cloud', { root: ROOT, files: ['scripts/ci/check-tests-covered.test.mjs'], env: {} });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command.known, 'clued-cloud');
  assert.deepEqual(steps[0].argv.filter((arg) => arg.endsWith('.test.mjs')), ['../../scripts/ci/check-tests-covered.test.mjs']);
  // No test-coverage suite any more: the check runs through this test.
  assert.ok(!Object.hasOwn(SUITE_COMMANDS, 'test-coverage'));
});

test('{ci-script-tests}: the tests directly in the script directories, less what a unit test imports and the admission self-tests', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-script-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const admission = SUITE_COMMANDS['admission-self-tests'].flatMap((command) => command.argv.filter((arg) => arg.endsWith('.test.mjs'))
    .map((arg) => path.posix.join(command.cwd, arg)));
  assert.ok(admission.length > 0);
  const files = { 'app/tests/u.test.mjs': "import '../../scripts/ci/imported.test.mjs';\nconst m = await import('../../scripts/ci/dynamic.test.mjs');\n",
    'scripts/ci/imported.test.mjs': "import './through.test.mjs';\n", 'scripts/ci/through.test.mjs': '', 'scripts/ci/dynamic.test.mjs': '',
    'scripts/ci/a.test.mjs': '', 'scripts/ci/self-hosted/b.test.mjs': '', 'scripts/runner/c.test.mjs': '', 'scripts/d.test.mjs': '',
    'scripts/ci/nested/e.test.mjs': '', 'scripts/ci/f.mjs': '', 'other/g.test.mjs': '' };
  for (const file of admission) files[file] = '';
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  assert.deepEqual(CI_SCRIPT_TEST_DIRS, ['scripts', 'scripts/ci', 'scripts/ci/self-hosted', 'scripts/runner']);
  assert.deepEqual(ciScriptTests(root, path.join(root, 'app'), ['tests/u.test.mjs']),
    ['../scripts/ci/a.test.mjs', '../scripts/ci/self-hosted/b.test.mjs', '../scripts/d.test.mjs', '../scripts/runner/c.test.mjs']);
  // Imports are read as the application's own test classification reads them.
  assert.deepEqual(IMPORT_PATTERNS.map(String), SPECIFIER_PATTERNS.map(String));
});

// A throwaway git checkout with a test file in every directory a suite command collects, so every command expands.
function cliCheckout(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tests-covered-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, text = '') => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  for (const commands of Object.values(SUITE_COMMANDS)) {
    for (const command of commands) {
      for (const arg of command.argv) {
        const dir = /^\{tests:(.+)\}$/.exec(arg)?.[1];
        if (dir) put(path.posix.join(command.cwd, dir, 'a.test.mjs'));
        if (arg === '{unit-tests}') {
          for (const script of ['select-tests.mjs', 'run-tests.mjs']) {
            put(path.posix.join(command.cwd, 'scripts', script), readFileSync(path.join(ROOT, 'apps/clued-cloud/scripts', script), 'utf8'));
          }
          put(path.posix.join(command.cwd, 'tests/u.test.mjs'));
        }
        if (arg === '{ci-script-tests}') put('scripts/ci/s.test.mjs');
      }
    }
  }
  put('scripts/ci/ci-known-failures.json', '{}\n');
  const git = (...args) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  const add = () => assert.equal(git('add', '-A').status, 0);
  // The base is the checkout's first commit: what it holds after add() and commit().
  let base = null;
  const commit = () => {
    add();
    assert.equal(git('commit', '-q', '-m', 'base').status, 0);
    base = git('rev-parse', 'HEAD').stdout.trim();
  };
  return { put, add, commit, run: (at = base) => spawnSync(process.execPath,
    [path.join(ROOT, 'scripts/ci/check-tests-covered.mjs'), '--root', root, ...(at ? ['--base', at] : [])], { encoding: 'utf8' }) };
}

test('the command line exits 0 when every test file is covered, 1 naming the file when one is not', (t) => {
  const { put, add, commit, run } = cliCheckout(t);
  commit();
  const green = run();
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /^tests covered: \d+ test files, \d+ run in a required suite, 0 listed/);
  put('orphan/lost.test.mjs');
  add();
  const red = run();
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stderr, /^TESTS_NOT_COVERED: 1 problem\(s\)\norphan\/lost\.test\.mjs: no required suite runs it/);
});

test('the command line reads the lists at --base from git: an entry added since fails; a base it cannot read fails', (t) => {
  const { put, add, commit, run } = cliCheckout(t);
  const table = (...files) => `${JSON.stringify({ schema: SHRINKS, tests: files.map((file) => entry(file)) }, null, 2)}\n`;
  put('orphan/old.test.mjs');
  put(TABLE_PATH, table('orphan/old.test.mjs'));
  commit();
  assert.equal(run().status, 0, run().stderr);
  put('orphan/new.test.mjs');
  put(TABLE_PATH, table('orphan/old.test.mjs', 'orphan/new.test.mjs'));
  put('scripts/ci/ci-known-failures.json', `${JSON.stringify({ unit: [failure('orphan/old.test.mjs', 'one')] })}\n`);
  add();
  const red = run();
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stderr, /^orphan\/new\.test\.mjs: the base \([0-9a-f]{40}\) does not list it; scripts\/ci\/ci-uncovered-tests\.json only shrinks/m);
  assert.match(red.stderr, /^scripts\/ci\/ci-known-failures\.json: unit: orphan\/old\.test\.mjs :: one :: 0123456789abcdef: the base \([0-9a-f]{40}\) does not list it/m);
  const unreadable = run('0123456789abcdef0123456789abcdef01234567');
  assert.equal(unreadable.status, 1, unreadable.stdout);
  assert.match(unreadable.stderr, /^scripts\/ci\/ci-uncovered-tests\.json, scripts\/ci\/ci-known-failures\.json: cannot read the base 0123456789abcdef0123456789abcdef01234567/m);
});

test('the command line seals archive patterns against the base: a new test file under one fails, the archived ones pass', (t) => {
  const { put, add, commit, run } = cliCheckout(t);
  put('old/kept.test.mjs');
  put(TABLE_PATH, `${JSON.stringify({ schema: SHRINKS, tests: [entry('old/**', { kind: 'archive' })] }, null, 2)}\n`);
  commit();
  const green = run();
  assert.equal(green.status, 0, green.stderr);
  put('old/deeper/brand-new.test.mjs');
  add();
  const red = run();
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stderr, /^TESTS_NOT_COVERED: 1 problem\(s\)\nold\/deeper\/brand-new\.test\.mjs: the base \([0-9a-f]{40}\) does not have it; the archive old\/\*\* is sealed/);
});
