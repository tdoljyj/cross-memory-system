import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { coverage, isTestFile, TABLE_PATH, trackedFiles } from './check-tests-covered.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASK = '700f2b68-b355-4edb-95c1-be97f04ea8de';
const RUNNER = 'node:' + 'test';

// A throwaway checkout: files (path -> text), its own suite commands and table; tracked defaults to every file.
function fixture(t, files, { commands = { unit: [{ cwd: '.', argv: ['node', '--test', '{tests:t}'] }] }, table = { tests: [] }, tracked } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tests-covered-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return coverage({ root, tracked: tracked ?? Object.keys(files), table, commands, listUnit: () => [] });
}
const entry = (file, extra = {}) => ({ path: file, kind: 'unsorted', task: TASK, reason: '从没在必需检查里跑过，红绿未知，等下一批分拣', ...extra });

test('test files are named *.test.{mjs,js,cjs,ts}, test_*.py or *_test.py', () => {
  for (const file of ['a.test.mjs', 'x/a.test.js', 'x/a.test.cjs', 'x/a.test.ts', 'tests/test_a.py', 'x/a_test.py']) assert.ok(isTestFile(file), file);
  for (const file of ['a.mjs', 'x/a.case.mjs', 'x/test-a.mjs', 'x/test_a.cjs', 'x/a.test.py', 'x/latest_a.py.txt']) assert.ok(!isTestFile(file), file);
});

test('the repository as committed: every test file runs in a required suite or is listed with its kind, reason and Task', () => {
  const result = coverage({ root: ROOT });
  assert.deepEqual(result.problems, []);
  assert.ok(result.counts.tests > 900 && result.counts.runs > 600, JSON.stringify(result.counts));
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
  const { problems } = coverage({ root: ROOT, table });
  assert.deepEqual(problems, ['scripts/ci/long-gone.test.mjs: no such tracked file; remove the entry',
    'scripts/ci/ci-required-selection.test.mjs: runs in a required suite (selection); remove the entry']);
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
    "import '../x/helper.mjs';", ''].join('\n'), 'x/helper.mjs': "import './f.test.mjs';\n" };
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) files[`x/${name}.test.mjs`] = '';
  const uncovered = fixture(t, files).problems.map((problem) => problem.split(':')[0]);
  assert.deepEqual(uncovered, ['x/c.test.mjs', 'x/d.test.mjs', 'x/e.test.mjs', 'x/f.test.mjs']);
});

test('Python tests count by the selection\'s own reading: discover, file operands and module names', (t) => {
  const commands = { py: [{ cwd: 'r', argv: ['python3', '-I', '-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'] },
    { cwd: '.', argv: ['python3', '-m', 'unittest', 'tests.test_mod', 'scripts/test_path.py'] },
    { cwd: '.', argv: ['python3', '-I', 'tests/test_script.py'] }] };
  const files = { 'r/test/test_a.py': '', 'r/test/helper_test.py': '', 'tests/test_mod.py': '', 'scripts/test_path.py': '', 'tests/test_script.py': '',
    'tests/test_other.py': '' };
  assert.deepEqual(fixture(t, files, { commands }).problems.map((problem) => problem.split(':')[0]), ['r/test/helper_test.py', 'tests/test_other.py']);
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
