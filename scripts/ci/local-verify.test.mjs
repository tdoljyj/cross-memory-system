// Tests of local-verify.mjs's own logic (run through
// apps/clued-cloud/tests/local-dev-tools.test.mjs). The suites it runs are
// the selection's; these check how it starts them, snapshots and merges the
// change, hands commits to the Linux clone and compares a failure with main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as selection from './ci-required-selection.mjs';
import { acquireLock, bundleFor, cacheHome, changedFiles, compareCommand, compareSuite, dataRoot, dependencyKey, fixedDrives, githubRefs,
  killCommand, linkDependencies, linuxScript, mainResultsFile, mergedCandidate, newestMain, npmCommand, parseArgs, present,
  readCached, readResults, realpathLoose, refUpdates, residentBusy, RESIDENT_STATUS, runCommands, selectAffected, snapshot, startLinux, systemDriveNotes, testEnvironment, testsRun,
  toWslPath, verifySuites, watchdogLevels, windowsPathOf, withFailureReport, worktree, worktreePath, writeCached, YIELD_TIMEOUT_MS, yieldToResident } from './local-verify.mjs';

// A repository in a temporary directory, isolated from the user's git configuration.
function repository(t, name = 'repo') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `local-verify-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // an empty file (git on Windows does not accept os.devNull here)
  const config = `${dir}.gitconfig`;
  fs.writeFileSync(config, '');
  t.after(() => fs.rmSync(config, { force: true }));
  const isolated = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...isolated };
  const git = (...args) => {
    const input = typeof args.at(-1) === 'object' ? args.pop().input : undefined;
    const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', input });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (files, message = 'c') => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(dir, file));
      else fs.writeFileSync(path.join(dir, file), text);
    }
    git('add', '--all');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  // the module's own git calls read these too
  for (const [key, value] of Object.entries(isolated)) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  return { dir, git, commit };
}

test('options: values inline or next, platforms, fetch and fresh main results; missing values and unknown options refused', () => {
  assert.deepEqual(parseArgs([]), { base: null, candidate: null, committed: false, suites: [], affected: false, here: true, linux: false, fetch: true, freshBase: false, yield: true });
  assert.equal(parseArgs(['--no-yield']).yield, false);
  assert.throws(() => parseArgs(['--no-yield=1']), /--no-yield takes no value/);
  const o = parseArgs(['--base=abc', '--suite', 'clued-cloud', '--suite=resident-node', '--linux', '--no-fetch', '--committed', '--fresh-base']);
  assert.deepEqual([o.base, o.suites, o.here, o.linux, o.fetch, o.committed, o.freshBase],
    ['abc', ['clued-cloud', 'resident-node'], true, true, false, true, true]);
  assert.deepEqual([parseArgs(['--linux-only']).here, parseArgs(['--linux-only']).linux], [false, true]);
  assert.throws(() => parseArgs(['--base']), /--base needs a value/);
  assert.throws(() => parseArgs(['--base=']), /--base needs a value/);
  assert.throws(() => parseArgs(['--suite', '--linux']), /--suite needs a value/);
  assert.throws(() => parseArgs(['--linux=yes']), /--linux takes no value/);
  assert.throws(() => parseArgs(['--fast']), /unknown option: --fast/);
  assert.equal(parseArgs(['--affected']).affected, true);
  const both = parseArgs(['--affected', '--linux-only', '--committed']);
  assert.deepEqual([both.affected, both.here, both.linux], [true, false, true]);
  assert.throws(() => parseArgs(['--affected=1']), /--affected takes no value/);
  assert.throws(() => parseArgs(['--affected', '--suite', 'offline-drill']), /--affected selects the suites itself/);
  assert.throws(() => parseArgs(['--suite=offline-drill', '--affected']), /--affected selects the suites itself/);
  assert.throws(() => parseArgs(['--affected', '--candidate', 'abc']), /--affected is not for --candidate/);
});

// Defect e0a5630d: a run waits before each suite while the resident CI on this host runs a batch (same WSL VM, same CPU).
test('the resident is busy only while a fresh status page names a batch that is not resting at A; idle, stale, missing or unreadable is not busy', () => {
  const T = Date.parse('2026-11-06T02:20:00Z');
  const page = (o) => () => JSON.stringify({ writtenAt: new Date(T - 15_000).toISOString(), executor: { state: 'RUNNING' }, ...o });
  const busy = (readText, now = () => T) => residentBusy({ readText, now });
  assert.equal(busy(page({ current: null, executor: { state: 'IDLE' } })), null);
  assert.equal(busy(page({})), null);
  assert.equal(busy(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }), null, 'no resident on this machine');
  assert.equal(busy(() => '{"current": {"pr": 1'), null, 'a torn write');
  assert.equal(busy(page({ current: { pr: 1007, headSha: 'd'.repeat(40), stage: 2 } })), 'PR #1007 (stage 2)');
  assert.equal(busy(page({ current: { pr: 1007, stage: null } })), 'PR #1007');
  assert.equal(busy(page({ current: {} })), 'a batch');
  assert.equal(busy(page({ current: 'x' })), null);
  assert.equal(busy(page({ current: { pr: 1007, stage: null, phase: 'relay-wait' }, executor: { state: 'WAITING' } })), null, 'a batch resting at A (a hosted relay) runs nothing here');
  assert.equal(busy(page({ current: { pr: 1007, stage: 2, phase: 'stage' }, executor: { state: 'WAITING' } })), 'PR #1007 (stage 2)',
    'a batch going on from A runs its stages while the page still says WAITING from the tick before');
  assert.equal(busy(page({ current: { pr: 1007, stage: 2, phase: 'retry-wait' } })), 'PR #1007 (stage 2)', 'about to run stage 2 again');
  assert.equal(busy(page({ current: { pr: 1007, stage: 2 } }), () => T + 5 * 60_000), null, 'a page not rewritten for five minutes: the service is not running');
  assert.equal(busy(page({ current: { pr: 1007, stage: 2 } }), () => T + 4 * 60_000), 'PR #1007 (stage 2)');
  assert.equal(busy(page({ current: { pr: 1007, stage: 2 }, writtenAt: undefined })), null, 'no time on the page');
  let asked;
  residentBusy({ readText: (file) => { asked = file; return '{}'; } });
  assert.equal(asked, RESIDENT_STATUS);
  assert.equal(RESIDENT_STATUS, process.platform === 'win32' ? 'C:\\ProgramData\\CluedIndependentCI\\resident\\state\\status.json'
    : '/mnt/c/ProgramData/CluedIndependentCI/resident/state/status.json');
});

test('yielding: waits while the resident runs, says why, keeps the run alive, goes on when it is idle or the wait is used up', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, wait: (ms) => { t += ms; } };
  };
  // idle: no wait, no line
  let lines = [];
  assert.equal(yieldToResident('windows: x', { busy: () => null, log: (l) => lines.push(l), wait: () => assert.fail('no wait') }), 0);
  assert.deepEqual(lines, []);
  // busy for three looks, then idle
  let c = clock();
  let looks = 0, alive = 0;
  lines = [];
  assert.equal(yieldToResident('linux: ci-suites', { ...c, busy: () => (++looks <= 3 ? 'PR #1007 (stage 2)' : null), log: (l) => lines.push(l), keepAlive: () => { alive += 1; } }), 3 * 30_000);
  assert.equal(alive, 3, 'the run stays alive while it waits');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^local-verify: linux: ci-suites: waiting: the resident CI runs PR #1007 \(stage 2\) on this host .*up to 90 min more, --no-yield skips this$/);
  assert.match(lines[1], /the resident CI is idle after 90 s; going on$/);
  // busy past the bound: goes on, says so; a line every five minutes meanwhile
  c = clock();
  lines = [];
  assert.equal(yieldToResident('windows: clued-cloud', { ...c, busy: () => 'PR #1', log: (l) => lines.push(l) }), YIELD_TIMEOUT_MS);
  assert.equal(lines.filter((l) => l.includes('waiting:')).length, YIELD_TIMEOUT_MS / (5 * 60_000));
  assert.match(lines.at(-1), /still runs PR #1; this run's 90 min of waiting for it are used up; going on$/);
  // what is left of the run's wait is kept exactly; none left: no wait at all
  c = clock();
  assert.equal(yieldToResident('x', { ...c, busy: () => 'PR #1', log: () => {}, timeoutMs: 45_000 }), 45_000);
  lines = [];
  assert.equal(yieldToResident('x', { busy: () => 'PR #1', log: (l) => lines.push(l), wait: () => assert.fail('no wait'), timeoutMs: 0 }), 0);
  assert.equal(lines.length, 1);
});

test('each suite first yields to the resident, from one wait for the whole run; --no-yield (null) never asks', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-yield-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const args = { root: home, home, selector: { readKnownFailures: () => ({}) }, main: 'b'.repeat(40), dir: path.join(home, 'missing'), suites: ['one', 'two', 'three'],
    logs: home, freshBase: false, run: { run: { pid: process.pid }, touch: () => {} }, platform: 'windows', temp: home };
  const asked = [];
  const results = verifySuites({ ...args, yieldTo: (label, o) => { asked.push([label, o.timeoutMs, typeof o.keepAlive]); return 20 * 60_000; } });
  assert.deepEqual(asked, [['windows: one', YIELD_TIMEOUT_MS, 'function'], ['windows: two', YIELD_TIMEOUT_MS - 20 * 60_000, 'function'],
    ['windows: three', YIELD_TIMEOUT_MS - 40 * 60_000, 'function']]);
  assert.equal(results.length, 3, 'every suite still gets its verdict (here: the worktree is missing)');
  assert.equal(verifySuites({ ...args, yieldTo: null }).length, 3);
});

test('Windows starts npm through its CLI next to node.exe (npm.cmd needs a shell); elsewhere npm itself', () => {
  const execPath = 'C:\\nodejs\\node.exe';
  const cli = 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(npmCommand({ platform: 'win32', execPath, exists: (file) => file === cli }), [execPath, cli]);
  assert.throws(() => npmCommand({ platform: 'win32', execPath, exists: () => false }), /npm's CLI is not next to/);
  assert.deepEqual(npmCommand({ platform: 'linux', execPath: '/usr/local/bin/node', exists: () => false }), ['npm']);
});

test('Node test commands get a failure report: a known-failure command where runSuite adds it, a plain one only for `node --test`', () => {
  const add = { reporterUrl: 'file:///r.mjs', file: '/tmp/c0.jsonl' };
  const reporter = ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=file:///r.mjs', '--test-reporter-destination=/tmp/c0.jsonl'];
  assert.deepEqual(withFailureReport('node', ['--test', 'a.test.mjs'], add), { args: ['--test', ...reporter, 'a.test.mjs'], report: '/tmp/c0.jsonl' });
  assert.deepEqual(withFailureReport('node', ['scripts/run-tests.mjs', '--test', 'x.test.mjs'], { ...add, known: true }),
    { args: ['scripts/run-tests.mjs', '--test', ...reporter, 'x.test.mjs'], report: '/tmp/c0.jsonl' });
  for (const [program, args, known] of [['npm', ['run', 'lint'], false], ['python', ['-m', 'unittest'], false], ['node', ['drill.mjs'], false],
    ['node', ['scripts/run-tests.mjs', '--test', 'x.test.mjs'], false], ['node', ['--test', '--test-reporter=tap', 'a.test.mjs'], false]]) {
    assert.deepEqual(withFailureReport(program, args, { ...add, known }), { args, report: null }, `${program} ${args.join(' ')}`);
  }
});

test('paths, keys and the environment the commands get', () => {
  assert.equal(toWslPath('C:\\w\\repo\\.git'), '/mnt/c/w/repo/.git');
  assert.equal(toWslPath('D:/x/y/'), '/mnt/d/x/y');
  assert.throws(() => toWslPath('/home/dev'), /not a drive path/);
  assert.equal(windowsPathOf('/home/dev/logs/a.log'), '\\\\wsl.localhost\\CluedDev-Linux\\home\\dev\\logs\\a.log');
  assert.equal(windowsPathOf('C:\\logs\\a.log'), 'C:\\logs\\a.log');
  assert.equal(cacheHome({ CLUED_LOCAL_VERIFY_HOME: '/x' }, '/home/dev'), path.resolve('/x'));
  assert.equal(cacheHome({ LOCALAPPDATA: '/appdata' }, '/home/me', { platform: 'linux' }), path.resolve('/home/me', '.cache', 'clued-local-verify'), 'never under AppData');
  const packageJson = JSON.stringify({ name: 'a', scripts: { test: 'x' }, dependencies: { b: '1.0.0' } });
  const key = dependencyKey({ lock: 'lock', packageJson, nodeVersion: 'v24.19.0', platform: 'win32' });
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(dependencyKey({ lock: 'lock', packageJson: JSON.stringify({ name: 'a', scripts: { test: 'y' }, dependencies: { b: '1.0.0' } }), nodeVersion: 'v24.1.0', platform: 'win32' }), key,
    'scripts and the Node minor version do not change the install');
  for (const changed of [{ lock: 'lock2' }, { packageJson: JSON.stringify({ name: 'a', dependencies: { b: '2.0.0' } }) }, { npmrc: 'registry=x' },
    { nodeVersion: 'v22.22.0' }, { platform: 'linux' }]) {
    assert.notEqual(dependencyKey({ lock: 'lock', packageJson, nodeVersion: 'v24.19.0', platform: 'win32', ...changed }), key, JSON.stringify(changed));
  }
  const env = testEnvironment({ Path: 'C:\\bin', HOME: '/h', TEMP: '/t', LC_ALL: 'C', HTTPS_PROXY: 'p', GITHUB_TOKEN: 'secret', SUPABASE_URL: 's',
    CLUED_HOME: 'c', NODE_OPTIONS: '--x', CI: 'true' }, { CI_BASE_SHA: 'm' }, 'linux');
  assert.deepEqual(env, { Path: 'C:\\bin', HOME: '/h', TEMP: '/t', LC_ALL: 'C', HTTPS_PROXY: 'p', CI_BASE_SHA: 'm' });
  assert.deepEqual(testEnvironment({ TEMP: '/t' }, {}, 'win32'), { TEMP: '/t', PYTHONUTF8: '1' }, "Windows Python in UTF-8 mode, like the runners' locale");
});

test("the Linux run takes objects only from this side's bundle (no GitHub login there), sets origin/* and tags exactly, and runs this side's copy", () => {
  const candidate = 'a'.repeat(40), main = 'b'.repeat(40);
  const script = linuxScript({ bundle: "/mnt/c/L/it's.bundle", refs: '/mnt/c/L/run.refs', tool: '/mnt/c/L/tool.mjs', run: 'run-7', candidate, main,
    suites: ['clued-cloud', "x'y"], freshBase: true });
  assert.match(script, /^set -e\n/);
  assert.ok(script.includes('remote add origin https://github.com/tdoljyj/cross-memory-system.git'), 'an origin remote, as in CI');
  assert.ok(!/fetch[^\n]*github\.com/.test(script), 'nothing is fetched from GitHub in the distribution');
  assert.ok(script.includes(`bundle verify -q '/mnt/c/L/it'\\''s.bundle'`));
  assert.ok(script.includes(`fetch -q --no-tags '/mnt/c/L/it'\\''s.bundle' '+refs/*:refs/local-verify/incoming/run-7/*'`), 'all of the bundle is kept, under refs of this run');
  assert.ok(script.includes(`for-each-ref --format='delete %(refname)' refs/local-verify/incoming/run-7/ | git -C "$repo" update-ref --stdin`),
    'and its refs dropped once the real ones are set');
  assert.ok(script.includes(`done < '/mnt/c/L/run.refs' | git -C "$repo" update-ref --stdin`), 'the refs of this run\'s view are applied through a filter that never moves a ref back');
  assert.ok(script.includes('merge-base --is-ancestor "$sha" "$cur"'), 'the clone may be ahead of this run\'s view: a ref moves only forward');
  assert.ok(script.includes('flock -w 900 9') && script.includes('flock -u 9; exec 9>&-'), 'runs take turns while they change the clone, and let go before the tests');
  assert.ok(script.indexOf('trap ') < script.indexOf('flock -w'), 'the clean-up is set before anything is created');
  assert.ok(script.includes('refs/local-verify/run-7/ refs/local-verify/incoming/run-7/'), 'and removes the refs of this run only');
  assert.ok(script.includes(`for commit in ${candidate} ${main}; do`));
  assert.ok(script.includes(`cp '/mnt/c/L/tool.mjs' "$tool/local-verify.mjs"`), 'the same tool on both sides, whatever the change holds');
  assert.ok(script.endsWith(`--candidate ${candidate} --base ${main} --no-fetch --fresh-base --suite 'clued-cloud' --suite 'x'\\''y'`));
  assert.ok(linuxScript({ bundle: null, refs: '/r', tool: '/t', run: 'r', candidate, main, suites: ['a'], noYield: true }).endsWith("--no-fetch --no-yield --suite 'a'"),
    'the Linux side skips the wait for the resident too when asked');
  const without = linuxScript({ bundle: null, refs: '/r', tool: '/t', run: 'r', candidate, main, suites: [] });
  assert.ok(!without.includes('bundle') && without.includes("done < '/r' | git"), 'refs are set even when no bundle is needed');
  assert.deepEqual(readResults('noise\nLOCAL_VERIFY_RESULT [{"suite":"a"}]\nLOCAL_VERIFY_RESULT [{"suite":"b"}]\r\ntail'), [{ suite: 'b' }]);
  assert.equal(readResults('no result'), null);
});

// ---- comparing with main ----
const summary = { type: 'summary' };
const fail = (name, fingerprint = 'f'.repeat(16), file = 'tests/a.test.mjs') => ({ type: 'fail', file, path: [name], fingerprint });
const pass = (name) => ({ type: 'pass', file: 'tests/a.test.mjs', path: [name] });
const report = (...events) => ({ events, summary: events.find((event) => event.type === 'summary') ?? null, corrupt: false });
const command = (status, rep = null, extra = {}) => ({ status, report: rep, known: null, error: null, ...extra });
const verdict = (head, base, known = []) => compareCommand(head, base, { selector: selection, known }).verdict;

test('a failing command against the same command on main: new, already failing there, or not comparable', () => {
  assert.equal(verdict(command(0), command(1)), 'pass');
  assert.equal(verdict(command(1), command(0)), 'new', 'main passes it');
  assert.equal(verdict(command(1), command(1)), 'unknown', 'both fail without test-by-test results: never counted as already failing');
  assert.equal(verdict(command(1, report(fail('t'), summary)), command(1)), 'unknown', 'only one side has a report');
  assert.equal(verdict(command(1), undefined), 'unknown', 'main did not get that far');
  assert.equal(verdict(command(null, null, { error: 'spawn ENOENT' }), command(0)), 'unknown');
  assert.equal(verdict(command(1), command(null, null, { error: 'timeout' })), 'unknown');
  const main = command(1, report(fail('old'), pass('t'), summary));
  assert.equal(verdict(command(1, report(fail('old'), pass('t'), summary)), main), 'base');
  assert.equal(verdict(command(1, report(fail('old'), fail('t'), summary)), main), 'new');
  assert.equal(verdict(command(1, report(fail('old', 'e'.repeat(16)), summary)), main), 'new', 'the same test failing for another reason is new');
  assert.equal(verdict(command(1, report(fail('listed'), summary), { known: 'k' }), command(0, report(pass('listed'), summary)), [{ ...fail('listed'), reason: 'known' }]), 'pass',
    'a known failure of the list passes, as in CI');
  assert.equal(verdict(command(0, report(fail('after'), summary)), main), 'pass', 'a command without a known-failure list passes on its exit status, as in CI');
  assert.equal(verdict(command(1, report(fail('old'))), main), 'new', 'a run without its summary did not finish');
  const run = command(1, report(fail('<run>', 'a'.repeat(16), null), summary));
  assert.equal(verdict(run, command(1, report(fail('<run>', 'a'.repeat(16), null), summary))), 'new', 'a run-level failure never matches');
  const detail = compareCommand(command(1, report(fail('t'), summary)), command(0, report(pass('t'), summary)), { selector: selection }).detail;
  assert.equal(detail, 'passes on main: tests/a.test.mjs :: t');
});

test('a suite is its worst command, every command compared', () => {
  const same = command(1, report(fail('old'), summary));
  assert.deepEqual(compareSuite([command(0), same], [command(0), same], { selector: selection }),
    { verdict: 'base', detail: 'command 2: base (1 failing test(s), all failing on main too)' });
  const suite = compareSuite([command(1), command(0), command(1, report(fail('t'), summary))], [command(1), command(0), command(0)], { selector: selection });
  assert.equal(suite.verdict, 'new', 'a new failure after a command that also fails on main');
  assert.match(suite.detail, /^command 1: unknown .*; command 3: new \(passes on main: tests\/a\.test\.mjs :: t\)$/);
  assert.deepEqual(compareSuite([command(0), command(0)], null, { selector: selection }), { verdict: 'pass' });
  const known = compareSuite([command(1, report(fail('k'), summary), { known: 'suite' })], null,
    { selector: selection, knownLists: { suite: [{ ...fail('k'), reason: 'r' }] } });
  assert.deepEqual(known, { verdict: 'pass' }, "the command's own known-failure list applies");
});

test('runCommands starts every command, also after a failure, with the report, a signal as 128 and a start failure as null', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selector = { ...selection, reporterUrl: 'file:///r.mjs', SUITE_COMMANDS: { s: [
    { cwd: '.', argv: ['npm', 'run', 'lint'] },
    { cwd: '.', argv: ['node', '--test', 'a.test.mjs'] },
    { cwd: '.', known: 's', argv: ['node', 'run.mjs', '--test', 'b.test.mjs'] },
    { cwd: '.', argv: ['python', '-m', 'x'] },
  ] } };
  const calls = [];
  const spawn = (file, args) => {
    calls.push([file, args]);
    const destination = args.find((arg) => arg.startsWith('--test-reporter-destination=') && arg.endsWith('.jsonl'));
    if (destination) fs.writeFileSync(destination.split('=')[1], `${JSON.stringify(fail('t'))}\n${JSON.stringify(summary)}\n`);
    return [{ status: 1 }, { status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn python ENOENT') }][calls.length - 1];
  };
  const killed = [];
  const results = runCommands(selector, 's', root, 'm'.repeat(40), path.join(root, 'log.txt'), { spawn, kill: (dir) => killed.push(dir) });
  assert.equal(calls.length, 4, 'every command ran');
  assert.deepEqual(killed, [root, root], 'what a stopped or unstartable command left is ended');
  assert.deepEqual(results.map((result) => [result.status, result.report !== null, result.known]), [[1, false, null], [1, true, null], [128, true, 's'], [null, false, null]]);
  assert.equal(results[1].report.events[0].type, 'fail');
  assert.equal(calls[1][0], process.execPath, 'node is the running Node, not whatever PATH finds');
  assert.match(results[3].error, /ENOENT/);
  assert.match(fs.readFileSync(path.join(root, 'log.txt'), 'utf8'), /::group::s: \(\.\) npm run lint/);
  // a known-failure command that exits 0 without its report did not finish, as runSuite judges it
  const silent = runCommands({ ...selector, SUITE_COMMANDS: { k: [{ cwd: '.', known: 'k', argv: ['node', 'run.mjs', '--test', 'b.test.mjs'] }] } },
    'k', root, 'm'.repeat(40), path.join(root, 'log2.txt'), { spawn: () => ({ status: 0 }), kill: () => {} });
  assert.deepEqual(silent[0].report, { events: [], summary: null, corrupt: false });
  assert.notEqual(compareSuite(silent, null, { selector: selection, knownLists: { k: [] } }).verdict, 'pass');
});

test('the processes a stopped command left are found by their command line: either slash and any case on Windows', () => {
  const [file, args, env] = killCommand('C:\\w\\wt', 'win32');
  assert.equal(file, 'powershell.exe');
  assert.deepEqual(env, { LOCAL_VERIFY_DIR: 'C:\\w\\wt' });
  assert.match(args.at(-1), /OrdinalIgnoreCase.*OrdinalIgnoreCase/);
  assert.match(args.at(-1), /Replace\(\[char\]92, \[char\]47\)/);
  assert.match(args.at(-1), /ProcessId -ne \$PID/, 'never itself');
  assert.deepEqual(killCommand('/home/dev/wt.1', 'linux'), ['pkill', ['-e', '-f', '--', '/home/dev/wt\\.1/'], {}]);
});

test('snapshot: HEAD with tracked changes and new files that are not ignored, leaving the index and working tree alone', (t) => {
  const { dir, git, commit } = repository(t);
  const head = commit({ '.gitignore': 'ignored.txt\n', 'kept.txt': 'one\n', 'gone.txt': 'x\n' });
  assert.deepEqual(snapshot(dir, false), { commit: head, included: [] }, 'a clean tree is HEAD itself');
  fs.writeFileSync(path.join(dir, 'kept.txt'), 'two\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'local\n');
  git('add', 'new.txt'); // staged and unstaged changes alike
  const status = git('status', '--porcelain');
  const { commit: snap, included } = snapshot(dir, false);
  assert.deepEqual(included, ['gone.txt', 'kept.txt', 'new.txt']);
  assert.equal(git('rev-parse', `${snap}^`), head);
  assert.deepEqual(git('ls-tree', '--name-only', snap).split('\n'), ['.gitignore', 'kept.txt', 'new.txt']);
  assert.equal(git('show', `${snap}:kept.txt`), 'two');
  assert.equal(git('status', '--porcelain'), status, 'the index and working tree are as they were');
  assert.equal(git('rev-parse', 'HEAD'), head, 'the branch did not move');
  assert.deepEqual(snapshot(dir, true), { commit: head, included: [] }, '--committed verifies HEAD only');
});

test('the change merged into main as CI tests it, and the files the change itself touches', (t) => {
  const { dir, git, commit } = repository(t);
  const base = commit({ 'a.txt': 'a\n', 'old.txt': 'o\n' });
  git('checkout', '-q', '-b', 'change');
  const change = commit({ 'old.txt': null, 'renamed.txt': 'o\n', 'b.txt': 'b\n' });
  assert.equal(mergedCandidate(dir, change, base), change, 'a change that already contains main is tested as it is');
  git('checkout', '-q', 'main');
  const main = commit({ 'c.txt': 'c\n' });
  const merged = mergedCandidate(dir, change, main);
  assert.deepEqual(git('rev-list', '--parents', '-n', '1', merged).split(' ').slice(1), [main, change]);
  assert.deepEqual(git('ls-tree', '--name-only', merged).split('\n'), ['a.txt', 'b.txt', 'c.txt', 'renamed.txt']);
  assert.deepEqual(changedFiles(dir, change, main, 3000), ['b.txt', 'old.txt', 'renamed.txt'], "main's own files are not the change's; a rename counts twice");
  assert.equal(changedFiles(dir, change, main, 3), null, "at GitHub's listing limit everything is selected");
  const conflict = commit({ 'b.txt': 'other\n' });
  assert.throws(() => mergedCandidate(dir, change, conflict), /does not merge cleanly into main/);
});

test("bundles hand the Linux clone the objects it lacks, its origin/* and tags are set exactly, however many refs it has", (t) => {
  const source = repository(t, 'source');
  const clone = repository(t, 'clone');
  const file = (name) => path.join(clone.dir, '..', `${path.basename(clone.dir)}-${name}.bundle`);
  t.after(() => { for (const name of ['1', '2', '3', '4']) fs.rmSync(file(name), { force: true }); });
  const cloneRefs = () => new Map(clone.git('for-each-ref', '--format=%(objectname) %(refname)').split('\n').filter(Boolean)
    .map((line) => line.split(' ').reverse()));
  const has = () => present(source.dir, [...new Set(cloneRefs().values())]);
  // what linuxScript does with a bundle and the refs file
  const take = (bundle) => {
    if (bundle) clone.git('fetch', '-q', '--no-tags', bundle, '+refs/*:refs/local-verify/incoming/*');
    const updates = refUpdates(githubRefs(source.dir), cloneRefs());
    if (updates) clone.git('update-ref', '--stdin', { input: updates });
    for (const sha of [candidate, main]) clone.git('cat-file', '-e', `${sha}^{commit}`);
    clone.git('update-ref', 'refs/local-verify/candidate', candidate);
    clone.git('update-ref', 'refs/local-verify/base', main);
    const incoming = clone.git('for-each-ref', '--format=delete %(refname)', 'refs/local-verify/incoming/');
    if (incoming) clone.git('update-ref', '--stdin', { input: `${incoming}\n` });
  };
  let main = source.commit({ 'a.txt': '1\n' });
  // a commit only another GitHub branch holds, and a tag, as fetched from GitHub
  source.git('checkout', '-q', '-b', 'other');
  const elsewhere = source.commit({ 'z.txt': 'z\n' });
  source.git('update-ref', 'refs/local-verify/github/elsewhere', elsewhere);
  source.git('update-ref', 'refs/local-verify/tags/v1', elsewhere);
  source.git('checkout', '-q', 'main');
  let candidate = source.commit({ 'a.txt': '2\n' });
  take(bundleFor(source.dir, { run: 'r1', candidate, main, has: [], file: file('1') }));
  assert.deepEqual([clone.git('rev-parse', 'refs/remotes/origin/elsewhere'), clone.git('rev-parse', 'refs/tags/v1')], [elsewhere, elsewhere],
    "GitHub's other branches and tags come along, as in CI's full checkout");
  assert.deepEqual(source.git('for-each-ref', 'refs/local-verify/r1/'), '', 'the run refs are gone afterwards');
  // new refs on commits the clone already has, and a branch GitHub no longer has: no bundle, refs exact all the same
  source.git('update-ref', 'refs/local-verify/github/merged', main);
  source.git('update-ref', 'refs/local-verify/tags/v0', main);
  source.git('update-ref', '-d', 'refs/local-verify/github/elsewhere');
  const none = bundleFor(source.dir, { run: 'r2', candidate, main, has: has(), file: file('2') });
  assert.equal(none, null, 'no new objects: nothing to bundle');
  take(none);
  assert.equal(clone.git('rev-parse', 'refs/remotes/origin/merged'), main);
  assert.equal(clone.git('rev-parse', 'refs/tags/v0'), main);
  assert.equal(clone.git('for-each-ref', 'refs/remotes/origin/elsewhere'), '', 'a branch GitHub deleted is deleted');
  assert.equal(refUpdates(githubRefs(source.dir), cloneRefs()), '', 'nothing left to change');
  candidate = source.commit({ 'a.txt': '3\n' }); // only the candidate is new: main is left out of the bundle
  take(bundleFor(source.dir, { run: 'r3', candidate, main, has: has(), file: file('3') }));
  source.git('checkout', '-q', '-b', 'side', main); // only main is new now: the candidate is left out
  main = source.commit({ 'b.txt': 'b\n' });
  take(bundleFor(source.dir, { run: 'r4', candidate, main, has: has(), file: file('4') }));
  assert.equal(clone.git('rev-parse', 'refs/local-verify/base'), main);
  // an annotated tag made on a commit the clone already has: no new commit, but its tag object must come along
  source.git('tag', '-a', '-m', 'release', 'release-1', main);
  source.git('update-ref', 'refs/local-verify/tags/release-1', source.git('rev-parse', 'refs/tags/release-1'));
  take(bundleFor(source.dir, { run: 'r5', candidate, main, has: has(), file: file('1') }));
  assert.equal(clone.git('cat-file', '-t', 'refs/tags/release-1'), 'tag');
  assert.equal(clone.git('rev-parse', 'refs/tags/release-1^{commit}'), main);
  // a clone with more refs than a Windows command line could list: 1200 distinct commits it has, one it lacks
  const stream = Array.from({ length: 1200 }, (_, index) => [
    `commit refs/heads/many`, `mark :${index + 1}`, 'committer t <t@t> 1700000000 +0000', 'data <<END', String(index), 'END',
    ...(index ? [`from :${index}`] : []), `M 644 inline many.txt`, 'data <<END', String(index), 'END', ''].join('\n')).join('\n');
  source.git('fast-import', '--quiet', { input: `${stream}\n` });
  const many = source.git('rev-list', 'refs/heads/many').split('\n');
  assert.equal(many.length, 1200);
  assert.deepEqual(present(source.dir, [...many, 'f'.repeat(40)]), many, 'one git call answers for all of them; missing ones are left out');
  const lacking = source.commit({ 'a.txt': '4\n' });
  const bundle = bundleFor(source.dir, { run: 'r6', candidate: lacking, main, has: [...many, ...has()], file: file('2') });
  assert.ok(bundle, 'a bundle is made with 1200+ commits excluded on stdin');
  assert.match(source.git('bundle', 'list-heads', bundle), /refs\/local-verify\/r6\/candidate/);
});

test('the dependency link: made, kept, replaced when stale or broken, never over a real directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b'), link = path.join(dir, 'node_modules');
  for (const target of [a, b]) fs.mkdirSync(target);
  fs.writeFileSync(path.join(a, 'mark'), 'a');
  linkDependencies(link, a);
  assert.equal(fs.realpathSync(link), fs.realpathSync(a));
  linkDependencies(link, a);
  linkDependencies(link, b);
  assert.equal(fs.realpathSync(link), fs.realpathSync(b), 'a stale link is replaced');
  assert.equal(fs.readFileSync(path.join(a, 'mark'), 'utf8'), 'a', "the old target's files stay");
  fs.rmSync(b, { recursive: true });
  linkDependencies(link, a);
  assert.equal(fs.realpathSync(link), fs.realpathSync(a), 'a broken link is replaced');
  fs.unlinkSync(link);
  fs.mkdirSync(link);
  fs.writeFileSync(path.join(link, 'installed'), 'x');
  linkDependencies(link, a);
  assert.equal(fs.realpathSync(link), fs.realpathSync(a), 'a directory installed in the worktree itself is replaced');
  assert.equal(fs.readFileSync(path.join(a, 'mark'), 'utf8'), 'a');
});

test('runCommands starts each command as runSuite would: same cwd, command line and known-failure reporter', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const main = 'b'.repeat(40);
  // runSuite's reporter, so both sides name the same file
  const selector = { ...selection, reporterUrl: pathToFileURL(selection.REPORTER_PATH).href };
  const record = (calls) => (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    const destination = args.find((arg) => arg.startsWith('--test-reporter-destination=') && arg.endsWith('.jsonl'));
    if (destination) fs.writeFileSync(destination.slice('--test-reporter-destination='.length), `${JSON.stringify(summary)}\n`);
    return { status: 0, stdout: Buffer.from('') };
  };
  const npm = npmCommand();
  // what each side starts, without the reporter options and temporary paths that differ by design
  const plain = ({ file, args, cwd }) => {
    let command = [file, ...args];
    if (npm.length === 2 && file === npm[0] && args[0] === npm[1]) command = ['npm', ...args.slice(1)];
    else if (file === process.execPath) command = ['node', ...args];
    return { cwd, command: command.filter((arg) => !arg.startsWith('--test-reporter')).map((arg) => (/-report\.json$/.test(arg) ? '{report}' : arg)),
      reported: args.some((arg) => arg.startsWith(`--test-reporter=${selector.reporterUrl}`)) };
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-same-'));
  try {
    for (const id of Object.keys(selection.SUITE_COMMANDS)) {
      const theirs = [];
      const status = selection.runSuite(id, { root, spawn: record(theirs), log: () => {}, env: { ...process.env, CI_BASE_SHA: main, RUNNER_TEMP: scratch } });
      assert.equal(status, 0, id);
      const ours = [];
      runCommands(selector, id, root, main, path.join(scratch, `${id}.log`), { spawn: record(ours) });
      assert.deepEqual(ours.map(plain).map(({ cwd, command }) => ({ cwd, command })), theirs.map(plain).map(({ cwd, command }) => ({ cwd, command })), id);
      selection.SUITE_COMMANDS[id].forEach((command, index) => {
        if (command.known) assert.ok(plain(ours[index]).reported && plain(theirs[index]).reported, `${id} ${index}: known-failure reporter on both`);
      });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the run lock: taken, waited for while its run is alive, taken over when stale, released only by its own run', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-lock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'run.lock');
  const quiet = { log: () => {} };
  const release = acquireLock(home, { ...quiet, pid: 11 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 11);
  release();
  assert.equal(fs.existsSync(file), false);
  // alive: waits until it is gone
  fs.writeFileSync(file, JSON.stringify({ pid: 22, token: 'held', started: Date.now() }));
  let waits = 0;
  acquireLock(home, { ...quiet, pid: 12, alive: () => true, wait: () => { waits += 1; fs.rmSync(file); } })();
  assert.equal(waits, 1);
  // gone, older than any run, or unreadable: taken over
  for (const [held, alive] of [[{ pid: 33, token: 'dead', started: Date.now() }, () => false],
    [{ pid: 34, token: 'old', started: Date.now() - 7 * 60 * 60_000 }, () => true], ['not json', () => true]]) {
    fs.writeFileSync(file, typeof held === 'string' ? held : JSON.stringify(held));
    if (typeof held === 'string') fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const mine = acquireLock(home, { ...quiet, pid: 13, alive, wait: () => assert.fail('a stale lock is not waited for') });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 13);
    // another run's lock is never removed by this one's release
    fs.writeFileSync(file, JSON.stringify({ pid: 44, token: 'theirs', started: Date.now() }));
    mine();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'theirs');
    fs.rmSync(file);
  }
  // an unreadable lock still being written is waited for, not taken
  fs.writeFileSync(file, '');
  let waited = 0;
  acquireLock(home, { ...quiet, pid: 14, wait: () => { waited += 1; fs.rmSync(file); } })();
  assert.equal(waited, 1);
  // a lock written but never placed by a run that stopped is cleared by the next one
  // (and a stale lock taken over but not yet removed)
  for (const leftover of [`${file}.x-1-2.new`, `${file}.x-3-4`]) {
    fs.writeFileSync(leftover, '{}');
    fs.utimesSync(leftover, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  }
  acquireLock(home, { ...quiet, pid: 16 })();
  assert.deepEqual(fs.readdirSync(home), [], 'both cleared');
  // a long run renews its lock's age
  let clock = Date.now();
  const long = acquireLock(home, { ...quiet, pid: 15, now: () => clock });
  clock += 5 * 60 * 60_000;
  long.refresh();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).started, clock);
  long();
  assert.deepEqual(fs.readdirSync(home), [], 'nothing left behind');
});

test('main: the newest copy; main results kept per main, platform, suite, versions and dependencies, unreadable ones run again', (t) => {
  const { dir, git, commit } = repository(t);
  const a = commit({ 'a.txt': '1\n' });
  const b = commit({ 'a.txt': '2\n' });
  git('update-ref', 'refs/x/a', a);
  git('update-ref', 'refs/x/b', b);
  assert.equal(newestMain(dir, ['refs/x/a', 'refs/x/b']), b);
  assert.equal(newestMain(dir, ['refs/x/b', 'refs/x/a']), b);
  assert.equal(newestMain(dir, ['refs/x/missing', 'refs/x/a']), a);
  assert.throws(() => newestMain(dir, ['refs/x/missing']), /no copy of main here/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-cache-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const at = { main: a, id: 'clued-cloud', platform: 'linux', node: 'v24.19.0', python: 'Python 3.12.3', dependencies: 'd' };
  const file = mainResultsFile(home, at);
  for (const changed of [{ main: b }, { id: 'components' }, { platform: 'win32' }, { node: 'v24.21.0' }, { python: 'Python 3.13.0' }, { dependencies: null }]) {
    assert.notEqual(mainResultsFile(home, { ...at, ...changed }), file, JSON.stringify(changed));
  }
  assert.equal(readCached(file), null);
  writeCached(file, [{ status: 0 }]);
  assert.deepEqual(readCached(file), [{ status: 0 }]);
  fs.writeFileSync(file, '[{"status":');
  assert.equal(readCached(file), null, 'a half-written file is run again');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], 'no temporary file left');
});

test('worktrees: one per commit and repository, cleaned on reuse, made again when broken', (t) => {
  const { dir, commit } = repository(t);
  const other = repository(t, 'other');
  const first = commit({ '.gitignore': 'out/\n', 'a.txt': '1\n' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-worktrees-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const wt = worktree(dir, first, home);
  assert.equal(wt, worktreePath(dir, first, home));
  assert.notEqual(worktreePath(other.dir, first, home), wt, 'another clone has worktrees of its own');
  fs.writeFileSync(path.join(wt, 'stray.txt'), 'x');
  fs.mkdirSync(path.join(wt, 'out'));
  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
  assert.equal(worktree(dir, first, home), wt);
  assert.deepEqual(fs.readdirSync(wt).sort(), ['.git', '.gitignore', 'a.txt'], 'untracked and ignored files are gone');
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), '1\n');
  fs.rmSync(path.join(wt, '.git'));
  assert.equal(worktree(dir, first, home), wt, 'a broken worktree is made again');
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), '1\n');
});

test('a Linux run that cannot start is one row that could not compare; it never stops the Windows run', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-linux-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rows = await startLinux({ root: home, home, candidate: 'a'.repeat(40), main: 'b'.repeat(40), suites: ['x'], logs: home,
    distribution: 'NoSuchDistribution-local-verify-test' });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].platform, rows[0].verdict], ['linux', 'unknown']);
  assert.match(rows[0].detail, /NoSuchDistribution-local-verify-test is not installed/);
});

// ---- where the cache lives, and what a run says about the system drive (defect 2102f7e1) ----
test('the cache is on the data drive, not under the home directory on the system drive, and always a real path', (t) => {
  const win = { platform: 'win32', systemDrive: 'C:' };
  assert.equal(dataRoot({}, { ...win, fixed: () => ['C:', 'D:'] }), path.win32.join('D:\\', 'clued-dev'));
  assert.equal(dataRoot({}, { ...win, fixed: () => ['C:', 'E:'] }), path.win32.join('E:\\', 'clued-dev'), 'the system drive is never the data drive');
  assert.equal(dataRoot({}, { ...win, fixed: () => ['C:'] }), null, 'no other drive: the home directory');
  assert.equal(dataRoot({ SystemDrive: 'D:' }, { platform: 'win32', fixed: () => ['D:', 'E:'] }), path.win32.join('E:\\', 'clued-dev'), 'another system drive letter');
  assert.equal(dataRoot({ CLUED_DEV_ROOT: path.resolve('/dev-root') }, { ...win, fixed: () => ['D:'] }), path.resolve('/dev-root'), 'CLUED_DEV_ROOT decides');
  assert.equal(dataRoot({}, { platform: 'linux', fixed: () => ['D:'] }), null, 'on Linux the distribution keeps its own home');
  assert.equal(dataRoot({}, { ...win, fixed: () => ['C:', 'F:', 'D:'] }), path.win32.join('D:\\', 'clued-dev'), 'drives in letter order');
  assert.equal(dataRoot({}, { ...win, fixed: () => [] }), null, 'drives that cannot be listed: the home directory');
  assert.equal(cacheHome({ CLUED_DEV_ROOT: path.resolve('/dev-root') }, '/home/me'), path.resolve('/dev-root', 'cache', 'clued-local-verify'));
  assert.equal(cacheHome({ CLUED_DEV_ROOT: path.resolve('/dev-root'), CLUED_LOCAL_VERIFY_HOME: path.resolve('/own') }, '/home/me'), path.resolve('/own'), 'the cache variable is the more specific one');
  // a link in the way is resolved: Node resolves it in a script's own path, so a path through it would never match
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-link-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(cacheHome({ CLUED_LOCAL_VERIFY_HOME: path.join(dir, 'link', 'cache') }, '/h'), path.join(real, 'cache'), 'through a link, the directory does not exist yet');
  fs.mkdirSync(path.join(real, 'cache'));
  assert.equal(cacheHome({ CLUED_LOCAL_VERIFY_HOME: path.join(dir, 'link', 'cache') }, '/h'), path.join(real, 'cache'), 'through a link, it exists');
  assert.equal(realpathLoose(path.join(dir, 'link', 'a', 'b')), path.join(real, 'a', 'b'));
});

test('a run says when the system drive is below the CI watchdog resume level, or holds the cache', () => {
  const win = { platform: 'win32', env: { SystemDrive: 'C:' }, levels: { suspend: 50, resume: 60 } };
  const data = 'D:\\clued-dev\\cache';
  const [low] = systemDriveNotes(data, { ...win, free: () => 49.8 });
  assert.match(low, /^C:\\ has 49\.8 GB free, below 60 GB: .*below 50 GB .*starts them again at 60 GB/);
  assert.equal(systemDriveNotes(data, { ...win, free: () => 59.9 }).length, 1, 'between the two levels the watchdog is still holding the runners');
  assert.deepEqual(systemDriveNotes(data, { ...win, free: () => 60 }), []);
  assert.deepEqual(systemDriveNotes(data, { platform: 'win32', env: { SystemDrive: 'C:' }, levels: { suspend: 50, resume: 0 }, free: () => 1 }), [], 'switched off');
  assert.deepEqual(systemDriveNotes(data, { platform: 'win32', env: { SystemDrive: 'C:' }, levels: null, free: () => 1 }), [], 'not a CI host: nothing is guarded');
  assert.match(systemDriveNotes(data, { platform: 'win32', env: { SystemDrive: 'C:' }, levels: { suspend: 50, resume: 60 }, free: () => 55 })[0], /below 60 GB/);
  assert.deepEqual(systemDriveNotes(data, { ...win, free: () => { throw new Error('no such drive'); } }), [], 'a drive that cannot be asked is not a warning');
  const [cache] = systemDriveNotes('C:\\Users\\me\\.cache\\clued-local-verify', { ...win, free: () => 200 });
  assert.match(cache, /the cache C:\\Users\\me\\\.cache\\clued-local-verify is on C:\\ .*CLUED_DEV_ROOT/);
  assert.deepEqual(systemDriveNotes('/home/me/.cache', { platform: 'linux', env: {}, free: () => 1, levels: { suspend: 50, resume: 60 } }), []);
});

test('the watchdog levels come from where they live: the installed script wins over the profile, a machine that is no CI host has none', () => {
  const profiles = JSON.stringify({ hosts: [{ hostname: 'Desk-A', capacity_profile: 'big', watchdog_path: 'C:\\w\\watchdog.ps1' }, { hostname: 'Desk-B', capacity_profile: 'big' }],
    capacity_profiles: { big: { suspend_c_free_gb: 50, resume_c_free_gb: 60 } } });
  const read = (installed) => (file) => {
    if (file.endsWith('node-profiles.json')) return profiles;
    if (installed !== null && file === 'C:\\w\\watchdog.ps1') return installed;
    throw new Error('ENOENT');
  };
  const at = (hostname, installed, env = {}) => watchdogLevels({ hostname, env, readText: read(installed), profilesFile: 'x/node-profiles.json' });
  assert.deepEqual(at('desk-a', null), { suspend: 50, resume: 60 }, "the profile's, host names compared in any case");
  assert.deepEqual(at('Desk-A', '[int]$SuspendDisk=50, [int]$ResumeDisk=65, [double]$SuspendMem=6.0'), { suspend: 50, resume: 65 }, 'the installed watchdog (an older one) is what runs');
  assert.deepEqual(at('Desk-A', '$suspendDisk=40; $resumeDisk=70; $interval=60'), { suspend: 40, resume: 70 }, 'a rendered one too');
  assert.deepEqual(at('Desk-A', 'no levels in here'), { suspend: 50, resume: 60 });
  assert.deepEqual(at('Desk-A', '$suspendDisk=42.5; $resumeDisk=66.5;'), { suspend: 42.5, resume: 66.5 }, 'levels with decimals');
  assert.deepEqual(at('Desk-B', null), { suspend: 50, resume: 60 }, 'a host without an installed script path: the profile');
  assert.equal(at('Somebody-Else', null), null, 'not a CI host');
  assert.deepEqual(at('Somebody-Else', null, { CLUED_CI_RESUME_FREE_GB: '90' }), { suspend: null, resume: 90 }, 'the variable names a level for any machine');
  assert.deepEqual(at('Desk-A', null, { CLUED_CI_RESUME_FREE_GB: '0' }).resume, 0);
  assert.equal(watchdogLevels({ hostname: 'x', env: {}, readText: () => { throw new Error('no profiles'); } }), null, 'outside a checkout');
});

test('fixed drives are asked of Windows once and read as drive letters', () => {
  const seen = [];
  const run = (file, args) => { seen.push([file, args.at(-1)]); return { status: 0, stdout: 'C:\r\nd:\r\n\r\n' }; };
  assert.deepEqual(fixedDrives({ run }), ['C:', 'D:']);
  assert.match(seen[0][1], /DriveType=3/, 'fixed drives only (not optical, removable or network ones)');
  assert.deepEqual([...fixedDrives({ run: () => ({ status: 1, stdout: '' }), exists: (drive) => drive === 'C:\\' || drive === 'E:\\' })], ['C:', 'E:'], 'not listable: the drives that exist, not a switch to the home directory');
  let tries = 0;
  assert.deepEqual(fixedDrives({ run: () => { tries += 1; return tries === 1 ? { status: 1, stdout: '' } : { status: 0, stdout: 'D:\r\n' }; } }), ['D:'], 'asked again once');
});

test('a command that runs Node tests and runs none is a failure, never a pass', (t) => {
  const counts = (passed, failed = 0) => ({ type: 'summary', counts: { passed, failed, tests: passed + failed + 2, skipped: 2 } });
  assert.equal(testsRun(report(counts(0))), 2, 'tests that are all skipped here were got to');
  assert.equal(testsRun(report({ type: 'summary', counts: { passed: 0, failed: 0, tests: 0, skipped: 0 } })), 0);
  assert.equal(testsRun(report(counts(3, 1))), 6, "the run's own count");
  assert.equal(testsRun(report(pass('a'), fail('b'), summary)), 2, 'a summary without counts: the events');
  assert.equal(testsRun(report()), 0);
  const none = command(0, report(counts(0)), { tests: 0 });
  const result = compareCommand(none, null, { selector: selection });
  assert.equal(result.verdict, 'new');
  assert.match(result.detail, /ran no tests/);
  assert.equal(compareCommand(command(0, report(counts(5)), { tests: 5 }), null, { selector: selection }).verdict, 'pass');
  assert.equal(compareCommand(command(0, null, { tests: null }), null, { selector: selection }).verdict, 'pass', 'a command without a test report (lint, build) passes on its exit status');
  assert.equal(compareSuite([command(0), none], null, { selector: selection }).verdict, 'new');
  // a known-failure command that exits 0 without any report: told apart from a run that did not finish
  const silentKnown = compareCommand(command(0, report(), { tests: 0, known: 'k' }), null, { selector: selection, known: [] });
  assert.equal(silentKnown.verdict, 'new');
  assert.match(silentKnown.detail, /ran no tests/);
  assert.match(compareCommand(command(1, report(), { tests: 0, known: 'k' }), command(1, report(), { known: 'k' }), { selector: selection, known: [] }).detail ?? '', /^(?!ran no tests)/, 'a crash is not reported as a silent run');
  // as started: exit 0 and no report, whether or not the command has known failures
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-verify-none-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selector = { ...selection, reporterUrl: 'file:///r.mjs', SUITE_COMMANDS: { s: [
    { cwd: '.', argv: ['node', '--test', 'a.test.mjs'] },
    { cwd: '.', known: 's', argv: ['node', 'run.mjs', '--test', 'b.test.mjs'] },
    { cwd: '.', argv: ['npm', 'run', 'lint'] },
  ] } };
  const results = runCommands(selector, 's', root, 'm'.repeat(40), path.join(root, 'log.txt'), { spawn: () => ({ status: 0 }), kill: () => {} });
  assert.deepEqual(results.map((entry) => entry.tests), [0, 0, null]);
  assert.equal(compareSuite(results, null, { selector: selection, knownLists: { s: [] } }).verdict, 'new');
  // and with a report that ran tests
  const ran = runCommands(selector, 's', root, 'm'.repeat(40), path.join(root, 'log2.txt'), {
    spawn: (file, args) => {
      const destination = args.find((arg) => arg.startsWith('--test-reporter-destination=') && arg.endsWith('.jsonl'));
      if (destination) fs.writeFileSync(destination.split('=')[1], `${JSON.stringify(pass('t'))}\n${JSON.stringify(counts(1))}\n`);
      return { status: 0 };
    },
    kill: () => {} });
  assert.deepEqual(ran.map((entry) => entry.tests), [3, 3, null]);
  assert.equal(compareSuite(ran, null, { selector: selection, knownLists: { s: [] } }).verdict, 'pass');
});

// The files `git diff --name-only 9100ee93cdfc16ce86fad7a4f28a644629b0b25f f95ec14a7ea7fdb14dcb574551baa1b97d2671e9`
// lists (#1015). The change touched the resident engine and the offline drill's
// inputs; a hand-picked suite list left out offline-drill and CI failed there (task 70e5f450).
const PR_1015_FILES = [
  'apps/clued-cloud/worker/generated/components.ts',
  'config/clued-components.json',
  'scripts/ci/clued-independent-publication-port.mjs',
  'scripts/ci/local-verify-concurrency.test.mjs',
  'scripts/ci/local-verify.mjs',
  'scripts/ci/local-verify.test.mjs',
  'work/independent-ci-resident-v1/DESIGN.md',
  'work/independent-ci-resident-v1/linux/bin/clued-ci-resident-linux',
  'work/independent-ci-resident-v1/src/classify.mjs',
  'work/independent-ci-resident-v1/src/engine-windows.mjs',
  'work/independent-ci-resident-v1/src/executor.mjs',
  'work/independent-ci-resident-v1/src/mailbox.mjs',
  'work/independent-ci-resident-v1/test/execution-retry.test.mjs',
  'work/independent-ci-resident-v1/test/scanner-abandon.test.mjs',
  'work/independent-ci-resident-v1/test/test_linux_tool.py',
];
const forCheck = (picked, check) => picked.selections.find((entry) => entry.check === check);

test('--affected selects exactly what the ci-suites job selects, from the selection it imports', () => {
  const picked = selectAffected(selection, PR_1015_FILES);
  assert.deepEqual(forCheck(picked, 'ci-suites').suites, selection.selectSuites('ci-suites', PR_1015_FILES).suites, 'the same call the workflow makes');
  assert.deepEqual(forCheck(picked, 'ci-suites').suites,
    ['resident-node', 'resident-python', 'offline-drill', 'source-v2-node', 'source-v2-python', 'components', 'admission-self-tests']);
  assert.equal(forCheck(picked, 'ci-suites').reason, 'selected by changed paths');
  assert.deepEqual(picked.selections.map((entry) => entry.check), ['ci-suites', 'clued-cloud-tests', 'migration-verify']);
  assert.deepEqual(picked.suites, [...forCheck(picked, 'ci-suites').suites, 'clued-cloud'], "the application's tests run for every change; no schema file changed");
  // the line CI logs for the check, then why each suite is in
  assert.equal(picked.lines[0],
    'ci-suites: selected by changed paths; suites: resident-node, resident-python, offline-drill, source-v2-node, source-v2-python, components, admission-self-tests');
  assert.ok(picked.lines.includes('  offline-drill: scripts/ci/clued-independent-publication-port.mjs, scripts/ci/local-verify-concurrency.test.mjs, '
    + 'scripts/ci/local-verify.mjs, ... (13 files)'));
  assert.ok(picked.lines.includes('  components: config/clued-components.json'));
  for (const id of Object.keys(selection.SUITES['ci-suites'])) {
    assert.equal(picked.lines.some((line) => line.startsWith(`  ${id}: `)), forCheck(picked, 'ci-suites').suites.includes(id), `${id} is explained exactly when it is selected`);
  }
});

test('--affected: a change only to the application selects no ci-suites suite, and the selection decides what else', () => {
  const files = ['apps/clued-cloud/src/lib/example.ts'];
  const picked = selectAffected(selection, files);
  assert.deepEqual(forCheck(picked, 'ci-suites').suites, selection.selectSuites('ci-suites', files).suites);
  assert.deepEqual(forCheck(picked, 'ci-suites').suites, []);
  assert.deepEqual(picked.suites, ['clued-cloud']);
  assert.equal(picked.lines[0], 'ci-suites: no file this check covers changed; suites: none');
  // the schema files add the schema check
  assert.deepEqual(selectAffected(selection, ['apps/clued-cloud/package.json']).suites, ['clued-cloud', 'production-schema']);
  // a change to the selection itself selects every suite of every check, files unknown too, with no per-file reasons for the unknown
  assert.equal(selectAffected(selection, ['scripts/ci/ci-required-selection.mjs']).selections[0].suites.length, Object.keys(selection.SUITES['ci-suites']).length);
  const unknown = selectAffected(selection, null);
  assert.equal(unknown.selections[0].reason, 'changed files unknown: every suite runs');
  assert.equal(unknown.suites.length, Object.values(selection.SUITES).flatMap((suites) => Object.keys(suites)).length);
  assert.ok(unknown.lines.every((line) => !line.startsWith('  ')));
});

test('--affected asks the selection it is given and holds no list of its own', () => {
  const asked = [];
  const selector = { selectSuites: (check, files) => {
    asked.push([check, files]);
    return { suites: check === 'ci-suites' && files?.[0] === 'a' ? ['x'] : [], reason: 'because' };
  } };
  const picked = selectAffected(selector, ['a', 'b']);
  assert.deepEqual(picked.suites, ['x']);
  assert.deepEqual(picked.lines, ['ci-suites: because; suites: x', '  x: a', 'clued-cloud-tests: because; suites: none', 'migration-verify: because; suites: none']);
  assert.deepEqual(asked[0], ['ci-suites', ['a', 'b']]);
});

test('--affected: the branch against main, as the pull request lists it, picks the suites', (t) => {
  const { dir, git, commit } = repository(t);
  commit({ 'README.md': 'x' });
  git('switch', '-q', '-c', 'branch');
  fs.mkdirSync(path.join(dir, 'apps/clued-cloud/src'), { recursive: true });
  commit({ 'apps/clued-cloud/src/a.ts': 'a' });
  const application = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(dir, 'work/independent-ci-resident-v1/drill'), { recursive: true });
  commit({ 'work/independent-ci-resident-v1/drill/offline-drill.mjs': 'd' });
  const drill = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  commit({ VERSION: 'main moved' });
  const main = git('rev-parse', 'HEAD');
  const picked = (head) => selectAffected(selection, changedFiles(dir, head, main, selection.FILE_LIMIT)).suites;
  assert.deepEqual(picked(application), ['clued-cloud'], "main's own commits are not the branch's");
  assert.deepEqual(picked(drill), ['resident-node', 'resident-python', 'offline-drill', 'source-v2-node', 'source-v2-python', 'admission-self-tests', 'clued-cloud']);
});
