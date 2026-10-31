import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FILE_LIMIT, SELECT_ALL, SUITES, SUITE_COMMANDS, changedFiles, expandArgv, globToRegExp, junitCases,
  knownFailureVerdict, listPullRequestFiles, outputLines, readKnownFailures, runSuite, selectSuites,
} from './ci-required-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const log = () => {};

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
  const both = ['resident-node', 'resident-python', 'offline-drill', 'source-v2-node', 'source-v2-python'];
  for (const file of ['work/independent-ci-resident-v1/src/executor.mjs', 'work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs',
    'scripts/ci/clued-independent-publication-port.mjs', '.gitleaks.toml']) {
    const { suites } = selectSuites('ci-suites', [file]);
    for (const id of both) assert.ok(suites.includes(id), `${file}: ${id}`);
  }
  assert.ok(selectSuites('ci-suites', ['scripts/ci/clued-work-admission.mjs']).suites.includes('admission-self-tests'));
});

// Review M3: a suite must run when a file its code imports changes.
function outsideImports(dir) {
  const out = new Set();
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(file); continue; }
      if (!/\.(?:mjs|js|cjs)$/.test(entry.name)) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        const relative = path.relative(ROOT, target).split(path.sep).join('/');
        if (!relative.startsWith(`${dir}/`) && existsSync(target)) out.add(relative);
      }
    }
  };
  walk(path.join(ROOT, dir));
  return [...out];
}

test('the resident and Source v2 suites cover every file their code imports from outside', () => {
  for (const [dir, ids] of [['work/independent-ci-resident-v1', ['resident-node', 'offline-drill']],
    ['work/actions-hosted-migration/independent-ci-v1', ['source-v2-node']]]) {
    const imports = outsideImports(dir);
    assert.ok(imports.length > 0, dir);
    for (const file of imports) {
      const { suites } = selectSuites('ci-suites', [file]);
      for (const id of ids) assert.ok(suites.includes(id), `${dir} imports ${file}, which does not select ${id}`);
    }
  }
});

test('any workflow change runs the runner budget policy and the admission self-tests', () => {
  assert.deepEqual(selectSuites('ci-suites', ['.github/workflows/trivy.yml']).suites, ['runner-budget-policy', 'admission-self-tests']);
});

test('a migration selects the production-schema check; ordinary documentation selects only the application check', () => {
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/supabase/migrations/20261101000000_x.sql']).suites,
    ['production-schema']);
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/supabase/ledger/production-history.json']).suites,
    ['production-schema']);
  const docs = selectSuites('migration-verify', ['docs/README.md']);
  assert.deepEqual(docs.suites, []);
  assert.match(docs.reason, /no file this check covers changed/);
  assert.deepEqual(selectSuites('ci-suites', ['docs/README.md', 'apps/clued-cloud/worker/index.ts']).suites, []);
  assert.deepEqual(selectSuites('clued-cloud-tests', ['docs/README.md']).suites, ['clued-cloud']);
  assert.deepEqual(selectSuites('clued-cloud-tests', []).suites, []);
});

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

const xml = (cases) => `<?xml version="1.0"?>\n<testsuites>\n${cases.map(([name, failed]) =>
  `\t<testcase name="${name}" time="0.1" classname="test" file="x"${failed ? ' failure="boom">\n\t\t<failure message="boom"/>\n\t</testcase>' : '/>'}`).join('\n')}\n</testsuites>\n`;

test('JUnit cases are read with their decoded names; a suite element is not a case', () => {
  const cases = junitCases(`<testsuites><testsuite name="parent" failures="1"><testcase name="main&amp;apos;s &amp;quot;x&amp;quot; &lt;y>" failure="e"><failure/></testcase>
    <testcase name="ok"/></testsuite></testsuites>`);
  assert.deepEqual(cases, [{ name: 'main\'s "x" <y>', failed: true }, { name: 'ok', failed: false }]);
});

test('known failures: only listed tests may fail, a crash or an empty report fails, fixed ones are reported', () => {
  const known = { 'old a': 'r', 'old b': 'r', 'gone': 'r' };
  const pass = knownFailureVerdict({ status: 1, cases: junitCases(xml([['old a', true], ['old b', false], ['new', false]])), known });
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.expected, ['old a']);
  assert.deepEqual(pass.fixed, ['old b']);
  assert.deepEqual(pass.missing, ['gone']);
  const fail = knownFailureVerdict({ status: 1, cases: junitCases(xml([['old a', true], ['new', true]])), known });
  assert.equal(fail.ok, false);
  assert.deepEqual(fail.unexpected, ['new']);
  assert.equal(knownFailureVerdict({ status: 1, cases: junitCases(xml([['old a', false]])), known }).ok, false,
    'a nonzero exit no failing case explains (a crash outside a test) fails');
  assert.equal(knownFailureVerdict({ status: 0, cases: [], known }).ok, false, 'a run that reported nothing fails');
});

test('a known-failure command adds the JUnit reporter, warns on known failures and fails on a new one', () => {
  const known = { 'admission-self-tests': { 'old a': 'reason' } };
  const lines = [];
  let seen;
  const spawn = (command, args) => { seen = args; return { status: 1 }; };
  assert.equal(runSuite('admission-self-tests', { root: ROOT, env: { RUNNER_TEMP: os.tmpdir() }, spawn, known,
    readJunit: () => xml([['old a', true], ['b', false]]), log: (line) => lines.push(line) }), 0);
  assert.ok(seen.includes('--test-reporter=junit'));
  assert.ok(seen.some((arg) => arg.startsWith('--test-reporter-destination=') && arg.endsWith('junit.xml')));
  assert.ok(lines.some((line) => line.startsWith('::warning title=admission-self-tests known failure::old a')));
  assert.equal(runSuite('admission-self-tests', { root: ROOT, env: { RUNNER_TEMP: os.tmpdir() }, spawn, known,
    readJunit: () => xml([['old a', true], ['b', true]]), log }), 1);
  assert.equal(runSuite('admission-self-tests', { root: ROOT, env: { RUNNER_TEMP: os.tmpdir() }, spawn, known,
    readJunit: () => '', log }), 1, 'no report fails');
});

test('the application suite gates lint, ledger, typecheck and build before the unit tests', () => {
  const calls = [];
  const spawn = (command, args) => { calls.push(args.join(' ')); return { status: args.includes('typecheck') ? 2 : 0 }; };
  assert.equal(runSuite('clued-cloud', { root: ROOT, env: {}, spawn, log }), 2);
  assert.deepEqual(calls, ['run lint', 'run ledger:verify', 'run typecheck']);
});

test('the committed known-failure list names a reason for every test', () => {
  const data = readKnownFailures();
  assert.deepEqual(Object.keys(data).sort(), ['admission-self-tests', 'clued-cloud']);
  for (const id of Object.keys(data)) assert.ok(SUITE_COMMANDS[id].some((command) => command.known === id), id);
  const file = path.join(os.tmpdir(), `known-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ x: { t: ' ' } }));
  assert.throws(() => readKnownFailures(file), /without a reason/);
});
