import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FILE_LIMIT, QUARANTINED, SUITES, SUITE_COMMANDS, UNIT_QUARANTINE, changedFiles, expandArgv, globToRegExp, listPullRequestFiles, outputLines,
  runSuite, selectSuites,
} from './ci-required-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every selectable suite has commands, every command directory and named test file exists', () => {
  const ids = Object.values(SUITES).flatMap((suites) => Object.keys(suites));
  assert.deepEqual([...ids].sort(), Object.keys(SUITE_COMMANDS).sort());
  for (const [id, commands] of Object.entries(SUITE_COMMANDS)) {
    for (const command of commands) {
      const cwd = path.join(ROOT, command.cwd);
      assert.ok(existsSync(cwd), `${id}: ${command.cwd}`);
      const argv = expandArgv(command.argv, { cwd, base: 'abc', report: '/tmp/r.json' });
      for (const arg of argv.filter((value) => /\.(?:mjs|py)$/.test(value) && !value.includes('*'))) {
        assert.ok(existsSync(path.join(cwd, arg)), `${id}: ${arg}`);
      }
    }
  }
});

test('{tests:dir} expands to that directory\'s test files, {base} needs a base commit', () => {
  const argv = expandArgv(['node', '--test', '{tests:test}'], { cwd: path.join(ROOT, 'work/independent-ci-resident-v1') });
  assert.ok(argv.length > 10);
  assert.ok(argv.slice(2).every((arg) => /^test\/[^/]+\.test\.mjs$/.test(arg)));
  assert.deepEqual(argv.slice(2), [...argv.slice(2)].sort());
  assert.throws(() => expandArgv(['{base}'], { cwd: ROOT }), /CI_BASE_SHA is required/);
  assert.deepEqual(expandArgv(['{base}', '{report}'], { cwd: ROOT, base: 'b', report: 'r' }), ['b', 'r']);
});

test('a suite stops at its first failing command and reports a command that did not start', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push([command, options.cwd]);
    return { status: calls.length === 1 ? 0 : 3 };
  };
  const log = () => {};
  assert.equal(runSuite('components', { root: ROOT, env: { CI_BASE_SHA: 'b' }, spawn, log }), 3);
  assert.equal(calls.length, 2);
  assert.equal(runSuite('selection', { root: ROOT, env: {}, spawn: () => ({ error: new Error('ENOENT') }), log }), 1);
  assert.equal(runSuite('production-schema', { root: ROOT, env: {}, spawn: () => ({ status: 0 }), log }), 0);
  assert.throws(() => runSuite('nope', { root: ROOT, spawn, log }), /unknown suite/);
});

test('quarantined unit files run apart from the gating unit files, and only files that exist', () => {
  const listUnit = () => ['tests/a.test.mjs', 'tests/ci-proof-profiles.test.mjs', 'tests/z.test.mjs'];
  assert.deepEqual(expandArgv(['{unit-tests}'], { cwd: ROOT, listUnit }), ['tests/a.test.mjs', 'tests/z.test.mjs']);
  assert.deepEqual(expandArgv(['{unit-quarantine}'], { cwd: ROOT, listUnit }), ['tests/ci-proof-profiles.test.mjs']);
  const actual = expandArgv(['{unit-tests}'], { cwd: path.join(ROOT, 'apps/clued-cloud') });
  assert.ok(actual.includes('tests/production-schema-drift.test.mjs'));
  for (const file of Object.keys(UNIT_QUARANTINE)) {
    assert.ok(existsSync(path.join(ROOT, 'apps/clued-cloud', file)), file);
    assert.equal(actual.includes(file), false, file);
  }
});

test('a failing quarantined command warns and the suite goes on; the gating unit command still fails it', () => {
  const lines = [];
  const statuses = { '{unit-quarantine}': 1 };
  const spawn = (command, args) => ({ status: args.includes('tests/ci-proof-profiles.test.mjs') ? statuses['{unit-quarantine}'] : 0 });
  assert.equal(runSuite('clued-cloud', { root: ROOT, env: {}, spawn, log: (line) => lines.push(line) }), 0);
  assert.ok(lines.some((line) => line.startsWith('::warning title=clued-cloud (quarantined)::')));
  const failing = (command, args) => ({ status: args.includes('lint') ? 2 : 0 });
  assert.equal(runSuite('clued-cloud', { root: ROOT, env: {}, spawn: failing, log: () => {} }), 2);
});

test('the application check runs for every change', () => {
  assert.deepEqual(selectSuites('clued-cloud-tests', ['docs/README.md']).suites, ['clued-cloud']);
  assert.deepEqual(selectSuites('clued-cloud-tests', []).suites, []);
});

test('a quarantined suite reports its failure as a warning and does not fail the check', () => {
  const lines = [];
  assert.ok(QUARANTINED['admission-self-tests'].length > 20);
  assert.equal(runSuite('admission-self-tests', { root: ROOT, env: {}, spawn: () => ({ status: 1 }), log: (line) => lines.push(line) }), 0);
  assert.ok(lines.some((line) => line.startsWith('::warning title=admission-self-tests (quarantined)::')));
  for (const id of Object.keys(QUARANTINED)) assert.ok(SUITE_COMMANDS[id], id);
});

test('glob patterns match across and within segments', () => {
  assert.ok(globToRegExp('work/independent-ci-resident-v1/**').test('work/independent-ci-resident-v1/src/executor.mjs'));
  assert.ok(globToRegExp('apps/clued-cloud/scripts/production-schema-*.mjs').test('apps/clued-cloud/scripts/production-schema-drift.mjs'));
  assert.ok(!globToRegExp('apps/clued-cloud/scripts/production-schema-*.mjs').test('apps/clued-cloud/scripts/x/production-schema-drift.mjs'));
  assert.ok(!globToRegExp('scripts/hooks/**').test('scripts/hooksx/a.py'));
  assert.ok(!globToRegExp('VERSION').test('VERSION.md'));
});

test('unknown changed files select every suite', () => {
  for (const check of Object.keys(SUITES)) {
    assert.deepEqual(selectSuites(check, null).suites, Object.keys(SUITES[check]));
  }
});

test('a change to the selection or a required-check workflow selects every suite', () => {
  for (const file of ['scripts/ci/ci-required-selection.mjs', '.github/workflows/clued-ci-suites.yml',
    '.github/workflows/clued-migration-verify.yml', '.github/actions/ci-temporary-storage/action.yml']) {
    assert.deepEqual(selectSuites('ci-suites', ['README.md', file]).suites, Object.keys(SUITES['ci-suites']), file);
    assert.deepEqual(selectSuites('migration-verify', [file]).suites, ['production-schema'], file);
  }
});

test('resident changes select the resident suites and the offline drill only', () => {
  const { suites } = selectSuites('ci-suites', ['work/independent-ci-resident-v1/src/executor.mjs']);
  assert.deepEqual(suites, ['resident-node', 'resident-python', 'offline-drill']);
});

test('Source v2 changes select the Source v2 suites and the offline drill', () => {
  const { suites } = selectSuites('ci-suites', ['work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs']);
  assert.deepEqual(suites, ['offline-drill', 'source-v2-node', 'source-v2-python']);
});

test('any workflow change runs the runner budget policy', () => {
  assert.deepEqual(selectSuites('ci-suites', ['.github/workflows/trivy.yml']).suites, ['runner-budget-policy']);
});

test('a migration selects the production-schema check; ordinary documentation selects nothing', () => {
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/supabase/migrations/20261101000000_x.sql']).suites,
    ['production-schema']);
  assert.deepEqual(selectSuites('migration-verify', ['apps/clued-cloud/supabase/ledger/production-history.json']).suites,
    ['production-schema']);
  const docs = selectSuites('migration-verify', ['docs/README.md']);
  assert.deepEqual(docs.suites, []);
  assert.match(docs.reason, /no file this check covers changed/);
  assert.deepEqual(selectSuites('ci-suites', ['docs/README.md', 'apps/clued-cloud/worker/index.ts']).suites, []);
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
