import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FILE_LIMIT, REPORTER_PATH, SELECT_ALL, SUITES, SUITE_COMMANDS, changedFiles, expandArgv, globToRegExp, knownFailureVerdict, knownKey,
  knownEntriesFromReport, listPullRequestFiles, outputLines, readKnownFailures, readReport, runSuite, selectSuites,
} from './ci-required-selection.mjs';
import { failureFingerprint, normalizeFailure } from './ci-test-failures-reporter.mjs';

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
  assert.equal(runSuite('clued-cloud', { root: ROOT, env: {}, spawn, log }), 2);
  assert.deepEqual(calls, ['run lint', 'run ledger:verify', 'run typecheck']);
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

test('regenerated entries keep listed reasons and leave new failures without one', () => {
  const report = readReport([
    { type: 'fail', file: 'x.test.mjs', path: ['old'], fingerprint: '2'.repeat(16) },
    { type: 'fail', file: 'x.test.mjs', path: ['new'], fingerprint: '3'.repeat(16) },
    { type: 'summary', counts: {}, success: false },
  ].map((event) => JSON.stringify(event)).join('\n'), '');
  const entries = knownEntriesFromReport(report, [{ file: 'x.test.mjs', path: ['old'], fingerprint: '1'.repeat(16), reason: 'kept' }]);
  assert.deepEqual(entries.map((entry) => [entry.path[0], entry.fingerprint[0], entry.reason]), [['new', '3', ''], ['old', '2', 'kept']]);
});
