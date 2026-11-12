// local-verify runs side by side (defect 791484c2): a lock per shared thing instead of one
// for the whole cache, a queue with positions, room for one more run judged from free
// memory, CPU and disk (the system drive against the CI watchdog's levels), and three
// different changes verified at the same time with the results they have alone.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST_KEEPS, VM_KEEPS, acquireNamedLock, admitRun, beginRun, dataRoot, ensureAppDependencies, missingDependencies, killCommand, leaveUmbrella, linuxScript, listRuns, pruneDependencyStores, pruneWorktrees,
  refreshUmbrella, roomForOneMore, sampleResources, sweepRunRefs, withLock, worktree, worktreeLock } from './local-verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'ci', 'local-verify.mjs');
const tempHome = (t, name = 'lv-conc') => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};
const quiet = { log: () => {}, wait: () => {} };

test('locks are per name: one name waits for its holder, another is free; nowait says so; a dead holder is taken over', (t) => {
  const dir = tempHome(t);
  const a = acquireNamedLock(dir, 'dependencies-aaaa', { ...quiet, pid: 11, alive: () => true });
  const b = acquireNamedLock(dir, 'dependencies-bbbb', { ...quiet, pid: 12, alive: () => true }); // another name: no wait
  assert.equal(acquireNamedLock(dir, 'dependencies-aaaa', { ...quiet, pid: 13, alive: () => true, nowait: true }), null, 'held: nowait gives up');
  let waits = 0;
  acquireNamedLock(dir, 'dependencies-aaaa', { ...quiet, pid: 14, alive: () => true, wait: () => { waits += 1; a(); } })(); // waits until the holder lets go
  assert.equal(waits, 1);
  assert.ok(fs.existsSync(path.join(dir, 'dependencies-bbbb.lock')), "the other name's lock was not touched");
  const dead = acquireNamedLock(dir, 'x', { ...quiet, pid: 15 });
  dead.refresh();
  const takenOver = acquireNamedLock(dir, 'x', { ...quiet, pid: 16, alive: (pid) => pid !== 15 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'x.lock'), 'utf8')).pid, 16);
  takenOver();
  b();
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.lock')), [], 'no lock or leftover stays');
  // withLock releases when fn throws
  assert.throws(() => withLock(tempHome(t), 'y', () => { throw new Error('boom'); }), /boom/);
});

test('the registry holds the runs that live: ended runs go, runs of dead processes are dropped', (t) => {
  const home = tempHome(t);
  const a = beginRun(home, { pid: process.pid, now: () => 1000 });
  const b = beginRun(home, { pid: 99999999, now: () => 2000 });
  assert.deepEqual(listRuns(home, { alive: (pid) => pid === process.pid }).map((run) => run.id), [a.run.id], 'the dead process is gone');
  assert.equal(fs.readdirSync(path.join(home, 'runs')).length, 1, 'and its file removed');
  a.update({ state: 'running', deps: ['k'] });
  assert.deepEqual(listRuns(home).map((run) => [run.state, run.deps]), [['running', ['k']]]);
  a.end();
  assert.deepEqual([...listRuns(home)], []);
  b.end();
});

test('room for one more run: the first always starts; then free memory, idle CPU, disk and the CI watchdog level decide', () => {
  const plenty = { freeMemGb: 40, idleCores: 20, dataFreeGb: 500, systemFreeGb: 120 };
  assert.deepEqual(roomForOneMore({ running: 0 }, { freeMemGb: 0, idleCores: 0, dataFreeGb: 0, systemFreeGb: 0 }).ok, true, 'nothing running: always');
  assert.equal(roomForOneMore({ running: 1 }, plenty).ok, true);
  const kinds = (running, sample, extra = {}) => roomForOneMore({ running, ...extra }, sample, { resume: 60, keeps: HOST_KEEPS }).lacks.map((lack) => lack.kind);
  assert.deepEqual(kinds(1, { ...plenty, freeMemGb: 15 }), ['memory'], 'a run takes 6 GB and 10 GB stay free: 16 needed');
  assert.deepEqual(kinds(1, { ...plenty, freeMemGb: 16 }), []);
  assert.deepEqual(kinds(1, { ...plenty, idleCores: 7 }), ['cpu']);
  assert.deepEqual(kinds(1, { ...plenty, dataFreeGb: 12 }), ['disk']);
  // the system drive: the watchdog clears its C: alert at 60 GB (the resume level of this fixture)
  assert.deepEqual(kinds(1, { ...plenty, systemFreeGb: 62.9 }), ['system-disk']);
  assert.deepEqual(kinds(1, { ...plenty, systemFreeGb: 63 }), []);
  assert.deepEqual(kinds(1, { ...plenty, systemFreeGb: 40 }), ['system-disk']);
  assert.deepEqual(roomForOneMore({ running: 1 }, { ...plenty, systemFreeGb: 40 }, { resume: 0 }).lacks, [], 'the check is off with resume level 0');
  assert.deepEqual(kinds(1, { ...plenty, systemFreeGb: null, dataFreeGb: null }), [], 'a drive that cannot be asked does not hold a run back');
  // runs that only just started have not yet taken what they will take
  assert.deepEqual(kinds(2, { ...plenty, freeMemGb: 27 }, { ramping: 2 }), ['memory'], '27 free, 12 of it about to go: 15 left, 16 needed');
  assert.deepEqual(kinds(2, { ...plenty, freeMemGb: 28 }, { ramping: 2 }), [], '16 left');
  assert.deepEqual(kinds(2, { ...plenty, freeMemGb: 30 }, { ramping: 0 }), []);
  assert.deepEqual(kinds(4, plenty), ['runs'], 'at most 4 at a time');
  // in the distribution (one VM with the CI runners') less memory stays free than on the host
  const twelve = { ...plenty, freeMemGb: 12 };
  assert.equal(roomForOneMore({ running: 1 }, twelve, { keeps: VM_KEEPS }).ok, true);
  assert.equal(roomForOneMore({ running: 1 }, twelve, { keeps: HOST_KEEPS }).ok, false);
  const limited = roomForOneMore({ running: 2 }, plenty, { maxRuns: 2, keeps: HOST_KEEPS });
  assert.match(limited.lacks[0].text, /2 runs are running, the limit is 2/);
});

test('the machine is looked at: idle cores from the CPU times, memory and disk as asked', () => {
  const cpu = (idle, busy) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
  const looks = [[cpu(0, 0), cpu(0, 0), cpu(0, 0), cpu(0, 0)], [cpu(300, 100), cpu(400, 0), cpu(400, 0), cpu(100, 300)]];
  const sample = sampleResources('/x', { cpus: () => looks.shift(), freemem: () => 20 * 1024 ** 3, free: (dir) => (dir === '/x' ? 321 : 45),
    platform: 'win32', env: { SystemDrive: 'C:' }, wait: () => {} });
  assert.equal(sample.idleCores.toFixed(2), '4.00'.replace('4.00', (4 * 1200 / 1600).toFixed(2)), 'a quarter of the CPU time busy: 3 of 4 cores idle');
  assert.equal(sample.freeMemGb, 20);
  assert.equal(sample.dataFreeGb, 321);
  assert.equal(sample.systemFreeGb, 45);
  const linux = sampleResources('/x', { cpus: () => [cpu(1, 1)], freemem: () => 1, free: () => 5, platform: 'linux', env: {}, wait: () => {} });
  assert.equal(linux.systemFreeGb, null, 'no system drive to guard on Linux');
});

// A clock and a machine the test drives: every wait takes 4 s (the queue says nothing about waits under 3 s).
function machine(t) {
  const home = tempHome(t);
  const state = { time: 1_000_000, sample: { freeMemGb: 40, idleCores: 20, dataFreeGb: 500, systemFreeGb: 120 }, lines: [], hooks: [] };
  const options = {
    now: () => state.time,
    alive: () => true,
    sample: () => state.sample,
    log: (line) => state.lines.push(line),
    wait: () => { state.time += 4000; state.hooks.shift()?.(); },
    env: {},
    limits: { keeps: HOST_KEEPS }, // the numbers of a Windows host, wherever the test runs
  };
  return { home, state, options };
}

test('the queue: first in line starts when there is room, the others wait and say their position; a place that opens goes to the first', (t) => {
  const { home, state, options } = machine(t);
  const run = (n) => beginRun(home, { pid: process.pid, now: () => state.time + n });
  const a = run(0);
  admitRun(home, a, options);
  assert.equal(a.run.state, 'running', 'the first run always starts');
  assert.deepEqual(state.lines, []);
  const b = run(1);
  const c = run(2);
  state.sample = { ...state.sample, freeMemGb: 12 }; // no room for another
  // c is behind b: after its second look it has waited long enough to say where it stands
  let looks = 0;
  const cOptions = { ...options, wait: () => { state.time += 4000; looks += 1; if (looks === 2) throw new Error('c waits'); } };
  assert.throws(() => admitRun(home, c, cOptions), /c waits/);
  assert.equal(state.lines.length, 1);
  assert.match(state.lines[0], /^local-verify: queued, position 2 \(1 running\): 1 run queued ahead$/);
  // b is first but has no room; after its second look the machine has room again
  state.hooks.push(() => {}, () => { state.sample = { ...state.sample, freeMemGb: 40 }; });
  admitRun(home, b, options);
  assert.equal(b.run.state, 'running', 'room again: the first in line starts');
  assert.match(state.lines[1], /^local-verify: queued, position 1 \(1 running\): memory: 12\.0 GB free, 6 of it about to be taken by runs just started, 16 GB needed/);
  assert.match(state.lines.at(-1), /started after \d+ s in the queue/);
  // c is next
  state.sample = { ...state.sample, freeMemGb: 40 };
  admitRun(home, c, options);
  assert.equal(c.run.state, 'running');
  assert.equal(listRuns(home, options).filter((r) => r.state === 'running').length, 3);
  for (const handle of [a, b, c]) handle.end();
});

test('a position is reported when it changes or after a minute, not at every look', (t) => {
  const { home, state, options } = machine(t);
  const a = beginRun(home, { pid: process.pid, now: () => state.time });
  admitRun(home, a, options);
  const b = beginRun(home, { pid: process.pid, now: () => state.time });
  state.sample = { ...state.sample, freeMemGb: 1 };
  let looks = 0;
  options.wait = () => { state.time += 4000; looks += 1; if (looks === 40) state.sample = { ...state.sample, freeMemGb: 40 }; };
  admitRun(home, b, options);
  const queued = state.lines.filter((line) => line.includes('queued, position'));
  assert.ok(looks >= 40 && queued.length >= 2 && queued.length <= 4, `${queued.length} reports in ${looks} looks (40 x 4 s = 160 s)`);
  a.end();
  b.end();
});

test('a run waits for an older copy of the tool (run.lock held without the concurrent mark) and, once running, holds run.lock itself', (t) => {
  const { home, state, options } = machine(t);
  const lock = path.join(home, 'run.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 4242, token: 't', started: state.time }));
  const a = beginRun(home, { pid: process.pid, now: () => state.time });
  state.hooks.push(() => {}, () => fs.rmSync(lock)); // the older copy finishes after the second look
  admitRun(home, a, options);
  assert.match(state.lines[0], /position 1 \(0 running\): an older copy of this tool is running \(process 4242\)/);
  const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.deepEqual([held.pid, held.concurrent], [process.pid, true], 'run.lock names this run, so older copies keep waiting');
  // a second run joins it; the first passes it on when it leaves
  const b = beginRun(home, { pid: process.pid + 1000, now: () => state.time });
  admitRun(home, b, options);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid, 'joined, not replaced');
  refreshUmbrella(home, a, { now: () => state.time + 5 });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).started, state.time + 5, 'kept young while it is named');
  leaveUmbrella(home, a, options);
  a.end();
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid + 1000, 'handed to the run that still runs');
  leaveUmbrella(home, b, options);
  b.end();
  assert.equal(fs.existsSync(lock), false, 'the last run removes it');
  // a lock of a dead older copy is stale
  fs.writeFileSync(lock, JSON.stringify({ pid: 4242, token: 't', started: state.time }));
  const c = beginRun(home, { pid: process.pid, now: () => state.time });
  admitRun(home, c, { ...options, alive: (pid) => pid !== 4242, wait: () => { throw new Error('no wait'); } });
  assert.equal(c.run.state, 'running');
  c.end();
});

test('a dependency store a live run uses is not removed, the others past the newest three are; a store being installed is left alone', (t) => {
  const home = tempHome(t);
  const store = path.join(home, 'node_modules');
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => letter.repeat(16));
  keys.forEach((key, index) => {
    fs.mkdirSync(path.join(store, key), { recursive: true });
    fs.writeFileSync(path.join(store, key, 'complete'), '');
    const when = new Date(Date.now() - (keys.length - index) * 60_000);
    fs.utimesSync(path.join(store, key), when, when);
  });
  const user = beginRun(home);
  user.update({ state: 'running', deps: [keys[0]] }); // the oldest: in use
  const installing = acquireNamedLock(path.join(home, 'locks'), `dependencies-${keys[1]}`, quiet); // the second oldest: being installed
  pruneDependencyStores(home);
  assert.deepEqual(fs.readdirSync(store).sort(), [keys[0], keys[1], keys[3], keys[4], keys[5]].sort(), 'only the unused, unheld old store is gone');
  installing();
  user.end();
  pruneDependencyStores(home);
  assert.deepEqual(fs.readdirSync(store).sort(), [keys[3], keys[4], keys[5]], 'the newest three stay');
});

test('a run has a worktree of its own, removed afterwards; a dead run\'s is pruned, a live run\'s and a held shared one are not', (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-conc-repo-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const config = `${repo}.gitconfig`;
  fs.writeFileSync(config, '');
  t.after(() => fs.rmSync(config, { force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    const before = process.env[key];
    process.env[key] = env[key];
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git('add', '--all');
  git('commit', '-q', '-m', 'c');
  const commit = git('rev-parse', 'HEAD');
  const home = tempHome(t);
  const mine = beginRun(home);
  const other = beginRun(home, { pid: process.pid, now: () => 5 });
  const own = worktree(repo, commit, home, { owner: mine.run.id });
  const alsoOwn = worktree(repo, commit, home, { owner: other.run.id });
  const shared = worktree(repo, commit, home);
  assert.equal(new Set([own, alsoOwn, shared]).size, 3, 'the same commit: a worktree for each run, one shared');
  assert.ok(fs.existsSync(path.join(own, 'a.txt')));
  // a run of a process that is gone
  const ghost = worktree(repo, commit, home, { owner: '99999999-abcdef' });
  const release = acquireNamedLock(path.join(home, 'locks'), worktreeLock(shared), quiet);
  pruneWorktrees(repo, home, { alive: (pid) => pid === process.pid });
  assert.ok(fs.existsSync(own) && fs.existsSync(alsoOwn), 'live runs keep theirs');
  assert.ok(!fs.existsSync(ghost), "a dead run's is removed");
  assert.ok(fs.existsSync(shared), 'the shared one is kept (and was held)');
  release();
  mine.end();
  other.end();
  pruneWorktrees(repo, home, { alive: () => true });
  assert.ok(!fs.existsSync(own) && !fs.existsSync(alsoOwn), 'once their runs are gone');
  assert.ok(fs.existsSync(shared), 'one shared worktree is within the newest few');
  assert.equal(git('worktree', 'list').split('\n').length, 2, "git's list has the repository and the shared worktree only");
});

test('embedded PostgreSQL tests choose a free port and a fresh temporary directory themselves, so runs side by side do not share them', () => {
  const tests = path.join(ROOT, 'apps', 'clued-cloud', 'tests');
  const files = fs.readdirSync(tests).filter((name) => /\.(mjs|js)$/.test(name)).map((name) => path.join(tests, name));
  let servers = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('new EmbeddedPostgres(')) continue;
    servers += 1;
    assert.doesNotMatch(text, /new EmbeddedPostgres\([^)]*port:\s*\d/, `${path.basename(file)}: a fixed port`);
    assert.doesNotMatch(text, /\bport:\s*[1-9]\d{2,4}\b/, `${path.basename(file)}: a fixed port`);
    assert.match(text, /mkdtemp/, `${path.basename(file)}: the data directory is made with mkdtemp`);
  }
  assert.ok(servers > 20, `${servers} files start embedded PostgreSQL`);
});

// ---- three changes at the same time ----

// A repository whose main has a stand-in selection (one suite, "probe") and three changes on top of it.
function probeRepository(t, { seconds }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-conc-probe-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const config = path.join(base, 'gitconfig');
  fs.writeFileSync(config, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const selection = pathToFileURL(path.join(ROOT, 'scripts', 'ci', 'ci-required-selection.mjs')).href;
  const reporter = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'ci-test-failures-reporter.mjs'), 'utf8');
  const stamps = path.join(base, 'stamps');
  fs.mkdirSync(stamps);
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'ci-required-selection.mjs'), [
    `export * from '${selection}';`,
    "export const SUITE_COMMANDS = { probe: [{ cwd: '.', argv: ['node', 'probe.mjs'] }] };",
    "export const selectSuites = (check) => ({ suites: check === 'ci-suites' ? ['probe'] : [] });",
    'export const FILE_LIMIT = 3000;',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'ci-known-failures.json'), '{}');
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'ci-test-failures-reporter.mjs'), reporter);
  // the probe: records when it ran, sleeps, passes unless the change says otherwise
  fs.writeFileSync(path.join(repo, 'probe.mjs'), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `const stamps = ${JSON.stringify(stamps)};`,
    "const verdict = fs.existsSync('fail-this-change') ? 1 : 0;",
    "const id = fs.existsSync('change.txt') ? fs.readFileSync('change.txt', 'utf8').trim() : 'main';",
    'const start = Date.now();',
    `await new Promise((resolve) => setTimeout(resolve, ${seconds * 1000}));`,
    "fs.writeFileSync(path.join(stamps, `${id}-${process.pid}.json`), JSON.stringify({ id, start, end: Date.now(), cwd: process.cwd(), temp: process.env.TEMP ?? process.env.TMPDIR }));",
    'process.exit(verdict);',
  ].join('\n'));
  git(repo, 'add', '--all');
  git(repo, 'commit', '-q', '-m', 'main');
  const main = git(repo, 'rev-parse', 'HEAD');
  const changes = [];
  for (const [name, failing] of [['one', false], ['two', true], ['three', true]]) {
    const dir = path.join(base, `change-${name}`);
    git(repo, 'worktree', 'add', '-q', '-b', `change-${name}`, dir, main);
    fs.writeFileSync(path.join(dir, 'change.txt'), `${name}\n`);
    if (failing) fs.writeFileSync(path.join(dir, 'fail-this-change'), '');
    git(dir, 'add', '--all');
    git(dir, 'commit', '-q', '-m', name);
    changes.push({ name, dir });
  }
  return { base, repo, main, changes, stamps, env: { ...env, CLUED_LOCAL_VERIFY_RESOURCES: 'off' } };
}

function runTool({ dir, main, env, home, extra = {} }) {
  const child = spawn(process.execPath, [TOOL, '--committed', '--no-fetch', '--no-yield', '--base', main], { cwd: dir, windowsHide: true,
    env: { ...env, CLUED_LOCAL_VERIFY_HOME: home, ...extra } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => child.on('close', (code) => {
    const line = output.split(/\r?\n/).reverse().find((candidate) => candidate.startsWith('LOCAL_VERIFY_RESULT '));
    resolve({ code, output, results: line ? JSON.parse(line.slice('LOCAL_VERIFY_RESULT '.length)).map(({ platform, suite, verdict, detail }) => ({ platform, suite, verdict, detail })) : null });
  }));
}

const stampsOf = (dir) => fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));

test('three different changes verified at the same time finish side by side with the results each has alone', { timeout: 240_000 }, async (t) => {
  const seconds = 12;
  // alone, one after the other, each with a cache of its own
  const solo = probeRepository(t, { seconds: 0 }); // the duration does not change a verdict
  const alone = {};
  for (const { name, dir } of solo.changes) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(solo.base, 'home-')));
    alone[name] = await runTool({ dir, main: solo.main, env: solo.env, home });
    assert.ok(alone[name].results, alone[name].output);
  }
  assert.deepEqual(alone.one.results.map((r) => r.verdict), ['pass']);
  assert.deepEqual(alone.two.results.map((r) => r.verdict), ['new'], 'the failing change fails against a passing main');
  assert.deepEqual(alone.three.results.map((r) => r.verdict), ['new']);
  assert.deepEqual([alone.one.code, alone.two.code, alone.three.code], [0, 1, 1]);

  // together, one cache
  const together = probeRepository(t, { seconds });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(together.base, 'home-')));
  const outcomes = await Promise.all(together.changes.map(({ dir }) => runTool({ dir, main: together.main, env: together.env, home,
    extra: { CLUED_LOCAL_VERIFY_MAX_RUNS: '3' } })));
  const names = together.changes.map((change) => change.name);
  names.forEach((name, index) => {
    assert.ok(outcomes[index].results, outcomes[index].output);
    assert.deepEqual(outcomes[index].results, alone[name].results, `${name}: the same result as alone`);
    assert.equal(outcomes[index].code, alone[name].code, `${name}: the same exit code as alone`);
  });
  // the probes of the three changes ran at the same time: every one started before any one ended
  const ran = stampsOf(together.stamps).filter((stamp) => stamp.id !== 'main');
  assert.equal(ran.length, 3);
  const timeline = JSON.stringify(ran.map((stamp) => [stamp.id, stamp.start - Math.min(...ran.map((x) => x.start)), stamp.end - Math.min(...ran.map((x) => x.start))]));
  const waited = outcomes.map((outcome) => outcome.output.split('\n').filter((line) => /queued|started after|another run/.test(line)).join(' | ')).join(' // ');
  assert.ok(Math.max(...ran.map((stamp) => stamp.start)) < Math.min(...ran.map((stamp) => stamp.end)), `the three probes overlap in time: ${timeline} ${waited}`);
  assert.equal(new Set(ran.map((stamp) => stamp.cwd)).size, 3, 'each in a worktree of its own');
  // main's baseline, which both failing changes need, was computed once, in main's shared worktree
  assert.equal(stampsOf(together.stamps).filter((stamp) => stamp.id === 'main').length, 1);
  // nothing is left: no run, no lock, no worktree of a run, no stale file
  assert.deepEqual(fs.readdirSync(path.join(home, 'runs')), []);
  assert.deepEqual(fs.readdirSync(path.join(home, 'locks')).filter((name) => name.includes('.lock')), []);
  assert.equal(fs.existsSync(path.join(home, 'run.lock')), false);
  assert.deepEqual(fs.readdirSync(path.join(home, 'worktrees')).filter((name) => /-r\d+-[0-9a-f]{6}$/.test(name)), []);
});

test('more runs than the limit queue, say their position, and go one after the other', { timeout: 240_000 }, async (t) => {
  const seconds = 5;
  const repo = probeRepository(t, { seconds });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(repo.base, 'home-')));
  const outcomes = await Promise.all(repo.changes.map(({ dir }) => runTool({ dir, main: repo.main, env: repo.env, home,
    extra: { CLUED_LOCAL_VERIFY_MAX_RUNS: '1' } })));
  outcomes.forEach((outcome) => assert.ok(outcome.results, outcome.output));
  const positions = outcomes.flatMap((outcome) => [...outcome.output.matchAll(/queued, position (\d+) \(1 running\)/g)].map((match) => Number(match[1])));
  assert.ok(positions.includes(1) && positions.includes(2), `positions seen: ${positions.join(',')}`);
  const ran = stampsOf(repo.stamps).filter((stamp) => stamp.id !== 'main').sort((a, b) => a.start - b.start);
  assert.equal(ran.length, 3);
  ran.slice(1).forEach((stamp, index) => assert.ok(stamp.start >= ran[index].end - 50, 'one at a time'));
});

// ---- what the independent review asked to be proven ----

// A child process that increments a counter file under a named lock, many times; it records when it held the lock.
const lockChild = (dir, id, rounds) => [
  `import fs from 'node:fs';`,
  `import { withLock } from ${JSON.stringify(pathToFileURL(TOOL).href)};`,
  `const home = ${JSON.stringify(dir)};`,
  `for (let i = 0; i < ${rounds}; i += 1) {`,
  `  withLock(home, 'shared', () => {`,
  `    const file = home + '/counter.txt';`,
  `    const before = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0);`,
  `    const start = Date.now();`,
  `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);`,
  `    fs.writeFileSync(file, String(before + 1));`,
  `    fs.appendFileSync(home + '/holds.jsonl', JSON.stringify({ id: ${JSON.stringify(id)}, start, end: Date.now() }) + '\\n');`,
  `  }, { log: () => {} });`,
  `}`,
].join('\n');

test('several processes take turns on one lock: no update is lost and no two holds overlap, also when the lock they find is stale', async (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  // left by a process that stopped while holding it
  fs.writeFileSync(path.join(home, 'locks', 'shared.lock'), JSON.stringify({ pid: 99999999, token: 'dead', started: Date.now() }));
  const children = [1, 2, 3, 4].map((id) => {
    const file = path.join(home, `child-${id}.mjs`);
    fs.writeFileSync(file, lockChild(home, id, 15));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('close', (code) => resolve({ code, output }));
    });
  });
  const outcomes = await Promise.all(children);
  outcomes.forEach((outcome) => assert.equal(outcome.code, 0, outcome.output));
  assert.equal(Number(fs.readFileSync(path.join(home, 'counter.txt'), 'utf8')), 60, 'every increment counted: the lock excluded');
  const holds = fs.readFileSync(path.join(home, 'holds.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).sort((a, b) => a.start - b.start);
  assert.equal(holds.length, 60);
  holds.slice(1).forEach((hold, index) => assert.ok(hold.start >= holds[index].end, 'one holder at a time'));
  assert.deepEqual(fs.readdirSync(path.join(home, 'locks')), [], 'no lock and no leftover stays');
});

test('a short lock held by a process whose number is in use is stale after its own limit: the admission lock after two minutes', (t) => {
  const home = tempHome(t);
  const locks = path.join(home, 'locks');
  fs.mkdirSync(locks, { recursive: true });
  const old = Date.now() - 3 * 60_000;
  fs.writeFileSync(path.join(locks, 'admission.lock'), JSON.stringify({ pid: process.pid, token: 'old', started: old }));
  fs.writeFileSync(path.join(locks, 'dependencies-aaaa.lock'), JSON.stringify({ pid: process.pid, token: 'old', started: old }));
  let took = false;
  withLock(home, 'admission', () => { took = true; }, { log: () => {}, wait: () => { throw new Error('waited'); } });
  assert.equal(took, true, 'taken over: a process that is alive but holds the admission lock for minutes is not working on it');
  // the same age on a lock that is held for long on purpose is not stale
  assert.throws(() => withLock(home, 'dependencies-aaaa', () => {}, { log: () => {}, wait: () => { throw new Error('waited'); } }), /waited/);
});

test('an older copy of the tool that places its lock while a run decides is not pushed aside; a lock named by a stopped run is taken over by one that lives', (t) => {
  const { home, state, options } = machine(t);
  const lock = path.join(home, 'run.lock');
  const a = beginRun(home, { pid: process.pid, now: () => state.time });
  // a running run is there, so the sample is taken: during it the older copy places its lock
  const first = beginRun(home, { pid: process.pid + 7, now: () => state.time - 10 });
  first.update({ state: 'running', admittedAt: state.time - 100_000 });
  options.sample = () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: 4242, token: 'older', started: state.time }));
    return state.sample;
  };
  state.hooks.push(() => {}, () => {});
  let looks = 0;
  options.wait = () => { state.time += 4000; looks += 1; if (looks === 2) throw new Error('stop'); };
  assert.throws(() => admitRun(home, a, options), /stop/);
  assert.equal(a.run.state, 'queued', 'it did not start');
  assert.match(state.lines[0], /an older copy of this tool is running \(process 4242\)/);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'older', "the older copy's lock is still its own");
  // run.lock names a run that was stopped without handing it on: a run that lives names itself
  fs.writeFileSync(lock, JSON.stringify({ pid: 4243, token: 'u', started: state.time, concurrent: true }));
  refreshUmbrella(home, first, { alive: (pid) => pid !== 4243, now: () => state.time });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid, 'it names the process that took it');
  a.end();
  first.end();
});

test('runs whose record cannot be read are not taken for gone: nothing a run may be using is removed meanwhile', (t) => {
  const home = tempHome(t);
  const store = path.join(home, 'node_modules');
  const keys = ['a', 'b', 'c', 'd', 'e'].map((letter) => letter.repeat(16));
  keys.forEach((key, index) => {
    fs.mkdirSync(path.join(store, key), { recursive: true });
    const when = new Date(Date.now() - (keys.length - index) * 60_000);
    fs.utimesSync(path.join(store, key), when, when);
  });
  const run = beginRun(home);
  fs.writeFileSync(path.join(home, 'runs', '1-abcdef.json'), '{"id":"1-abcdef","pid":'); // being written
  const listed = listRuns(home, { wait: () => {} });
  assert.equal(listed.unreadable, 1);
  assert.equal(listed.length, 1);
  pruneDependencyStores(home);
  assert.equal(fs.readdirSync(store).length, 5, 'nothing is pruned while a record cannot be read');
  fs.rmSync(path.join(home, 'runs', '1-abcdef.json'));
  pruneDependencyStores(home);
  assert.equal(fs.readdirSync(store).length, 3, 'and the usual rule once all can');
  run.end();
});

test('what ends processes under a worktree does not reach a sibling worktree whose name starts with it', () => {
  const [, [, , , pattern]] = killCommand('/cache/worktrees/abc-1234', 'linux');
  assert.ok(new RegExp(pattern).test('node /cache/worktrees/abc-1234/apps/x.mjs'));
  assert.ok(!new RegExp(pattern).test('node /cache/worktrees/abc-1234-rXYZ-abcdef/apps/x.mjs'), "a run's own worktree of the same commit is not this one");
  const win = killCommand('D:\\cache\\worktrees\\abc-1234', 'win32')[1].at(-1);
  assert.match(win, /IndexOf\(\$d \+ \[char\]92/);
  assert.match(win, /IndexOf\(\$e \+ \[char\]47/);
});

test('the Linux script is valid bash and its lock keeps two runs apart (where flock exists)', (t) => {
  if (process.platform !== 'linux') return t.skip('Linux only: elsewhere "bash" may be the launcher of a distribution, or a bash without flock'); // checked in the distribution by local-verify --linux
  const bash = spawnSync('bash', ['-c', 'command -v flock'], { encoding: 'utf8', windowsHide: true });
  const script = linuxScript({ bundle: '/b/it.bundle', refs: '/b/run.refs', tool: '/b/tool.mjs', run: 'run-1', candidate: 'a'.repeat(40), main: 'b'.repeat(40), suites: ['x'] });
  const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8', windowsHide: true });
  if (syntax.error) return t.skip('no bash');
  assert.equal(syntax.status, 0, syntax.stderr);
  if (bash.status !== 0) return t.skip('no flock here (the distribution has it)');
  const home = tempHome(t);
  const lock = path.join(home, 'repo.lock');
  const body = (id) => `exec 9>"${lock.replace(/\\/g, '/')}"; flock -w 20 9; echo "${id} in $(date +%s%N)"; sleep 1; echo "${id} out $(date +%s%N)"; flock -u 9; exec 9>&-`;
  const run = (id) => new Promise((resolve) => {
    const child = spawn('bash', ['-c', body(id)], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(out.trim().split('\n').map((line) => { const [who, what, at] = line.split(' '); return { who, what, at: BigInt(at) }; })));
  });
  return Promise.all([run('a'), run('b')]).then(([a, b]) => {
    const [first, second] = a[0].at < b[0].at ? [a, b] : [b, a];
    assert.ok(second[0].at >= first[1].at, 'the second came in after the first went out');
  });
});

test('the probes of side-by-side runs see a temporary directory of their own', { timeout: 120_000 }, async (t) => {
  const repo = probeRepository(t, { seconds: 3 });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(repo.base, 'home-')));
  const outcomes = await Promise.all(repo.changes.slice(0, 2).map(({ dir }) => runTool({ dir, main: repo.main, env: repo.env, home,
    extra: { CLUED_LOCAL_VERIFY_MAX_RUNS: '2' } })));
  outcomes.forEach((outcome) => assert.ok(outcome.results, outcome.output));
  const temps = stampsOf(repo.stamps).filter((stamp) => stamp.id !== 'main').map((stamp) => stamp.temp);
  assert.equal(new Set(temps).size, 2);
  temps.forEach((temp) => assert.ok(temp.startsWith(path.join(home, 't') + path.sep), `${temp} is under the cache's own temporary directories`));
  assert.deepEqual(fs.existsSync(path.join(home, 't')) ? fs.readdirSync(path.join(home, 't')) : [], [], 'removed when the runs end');
});

// ---- the second review ----

test('a new dependency store is rebuilt before it is complete and then only read; an old one without the mark is rebuilt in place, once', (t) => {
  const home = tempHome(t);
  const dir = tempHome(t, 'lv-conc-wt');
  const app = path.join(dir, 'apps', 'clued-cloud');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'a', dependencies: { b: '1.0.0' } }));
  fs.writeFileSync(path.join(app, 'package-lock.json'), '{"lockfileVersion":3}');
  const platformPackage = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const calls = [];
  const npm = (args, cwd) => {
    calls.push([args[0], cwd, args.includes('--offline')]);
    if (args[0] === 'ci') fs.mkdirSync(path.join(cwd, 'node_modules', platformPackage), { recursive: true });
    return { status: 0, output: '' };
  };
  const key = ensureAppDependencies(dir, home, { rebuild: false, npm, log: () => {} });
  const ready = path.join(home, 'node_modules', key);
  // ci-deps.mjs: the npm cache is filled and proved offline in a scratch copy, then the store is installed offline
  assert.deepEqual(calls.map(([what, , offline]) => `${what}${offline ? ' offline' : ''}`), ['ci', 'ci offline', 'ci offline', 'rebuild'],
    'installed and rebuilt, for every suite');
  assert.equal(calls[2][1], calls[3][1], 'in the same temporary directory');
  assert.notEqual(calls[3][1], ready, 'not in the store other runs read');
  assert.equal(calls[0][1], calls[1][1], 'the cache is proved in its own scratch copy');
  assert.notEqual(calls[0][1], calls[2][1]);
  assert.ok(fs.existsSync(path.join(ready, 'complete')) && fs.existsSync(path.join(ready, 'rebuilt')));
  assert.equal(fs.realpathSync(path.join(app, 'node_modules')), fs.realpathSync(path.join(ready, 'node_modules')), 'linked into the worktree');
  calls.length = 0;
  ensureAppDependencies(dir, home, { rebuild: true, npm, log: () => {} });
  assert.deepEqual(calls, [], 'a second run reads the store: nothing is installed or rebuilt');
  // a store an earlier version made: no mark
  fs.rmSync(path.join(ready, 'rebuilt'));
  ensureAppDependencies(dir, home, { rebuild: false, npm, log: () => {} });
  assert.deepEqual(calls, [], 'a suite that does not need the rebuild leaves it alone');
  ensureAppDependencies(dir, home, { rebuild: true, npm, log: () => {} });
  assert.deepEqual(calls, [['rebuild', ready, false]], 'rebuilt in place once');
  ensureAppDependencies(dir, home, { rebuild: true, npm, log: () => {} });
  assert.equal(calls.length, 1, 'and marked');
});

test('a store marked complete but lacking packages is installed again; an install that still lacks them refuses', (t) => {
  const home = tempHome(t);
  const dir = tempHome(t, 'lv-conc-wt');
  const app = path.join(dir, 'apps', 'clued-cloud');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'a', dependencies: { b: '1.0.0' } }));
  fs.writeFileSync(path.join(app, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {},
    'node_modules/b': { version: '1.0.0' }, 'node_modules/only-elsewhere': { version: '1.0.0', optional: true } } }));
  const installs = [];
  let installs_b = true;
  const npm = (args, cwd) => {
    if (args[0] !== 'ci' || !args.includes('--offline') || path.basename(cwd).startsWith('ci-deps-')) return { status: 0, output: '' };
    installs.push(cwd);
    fs.mkdirSync(path.join(cwd, 'node_modules', installs_b ? 'b' : 'c'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'node_modules', installs_b ? 'b' : 'c', 'package.json'), '{}');
    return { status: 0, output: '' };
  };
  const key = ensureAppDependencies(dir, home, { rebuild: false, npm, log: () => {} });
  const ready = path.join(home, 'node_modules', key);
  assert.equal(installs.length, 1);
  assert.deepEqual(missingDependencies(ready), [], 'an optional package of another platform is not required');
  // emptied through a link, the mark left behind (2026-11-12 03:56Z)
  fs.rmSync(path.join(ready, 'node_modules', 'b'), { recursive: true });
  assert.deepEqual(missingDependencies(ready), ['node_modules/b']);
  const said = [];
  ensureAppDependencies(dir, home, { rebuild: false, npm, log: (line) => said.push(line) });
  assert.equal(installs.length, 2, 'installed again instead of trusting the mark');
  assert.match(said.join('\n'), /marked complete but lacks node_modules\/b/);
  assert.deepEqual(missingDependencies(ready), []);
  fs.rmSync(path.join(ready, 'node_modules', 'b'), { recursive: true });
  installs_b = false;
  assert.throws(() => ensureAppDependencies(dir, home, { rebuild: false, npm, log: () => {} }), /left out node_modules\/b: cannot verify/);
  assert.equal(fs.existsSync(path.join(ready, 'complete')), false, 'nothing incomplete is marked complete');
});

test('housekeeping: the temporary directory of a dead run goes, a garbled record goes after a while, a fresh unreadable one only makes pruning wait', (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, 't', '99999999-abcdef'), { recursive: true });
  fs.mkdirSync(path.join(home, 'worktrees'), { recursive: true });
  const repo = tempHome(t, 'lv-conc-norepo');
  // a record garbled long ago (a power loss) is removed; a fresh unreadable one only makes pruning wait
  const runs = path.join(home, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, '1-aaaaaa.json'), '');
  fs.writeFileSync(path.join(runs, '2-bbbbbb.json'), '');
  const old = new Date(Date.now() - 20 * 60_000);
  fs.utimesSync(path.join(runs, '1-aaaaaa.json'), old, old);
  const listed = listRuns(home, { wait: () => {} });
  assert.equal(listed.unreadable, 1, 'the fresh one');
  assert.deepEqual(fs.readdirSync(runs), ['2-bbbbbb.json'], 'the old one is gone');
  fs.rmSync(path.join(runs, '2-bbbbbb.json'));
  pruneWorktrees(repo, home, { alive: () => true });
  assert.deepEqual(fs.readdirSync(path.join(home, 't')), [], "a dead run's temporary directory is removed");
});

test('the cache stays where it is when the drives could only be guessed; data drives are named once; run refs of runs that are gone are swept', (t) => {
  const win = { platform: 'win32', systemDrive: 'C:' };
  const guessed = ['C:', 'D:', 'E:'];
  guessed.guessed = true;
  assert.equal(dataRoot({}, { ...win, fixed: () => guessed, exists: (dir) => dir === 'E:\\clued-dev' }), path.win32.join('E:\\', 'clued-dev'), 'where the data directory already is');
  assert.equal(dataRoot({}, { ...win, fixed: () => guessed, exists: () => false }), path.win32.join('D:\\', 'clued-dev'), 'else the first');
  // refs a Windows run set for its bundle
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-conc-refs-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const config = `${repo}.gitconfig`;
  fs.writeFileSync(config, '');
  t.after(() => fs.rmSync(config, { force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    const before = process.env[key];
    process.env[key] = env[key];
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'c');
  const head = git('rev-parse', 'HEAD');
  const now = 1_800_000_000_000;
  for (const name of ['run-111', 'run-222-' + now, 'run-333-' + (now - 2 * 86_400_000), 'run-444-' + now, 'incoming/other']) git('update-ref', `refs/local-verify/${name}/candidate`, head);
  sweepRunRefs(repo, { alive: (pid) => pid !== 111 && pid !== 444, now: () => now + 1000 });
  assert.deepEqual(git('for-each-ref', '--format=%(refname)', 'refs/local-verify/').split('\n').sort(), [
    'refs/local-verify/incoming/other/candidate',
    'refs/local-verify/run-222-' + now + '/candidate',
  ], 'gone: 111 (dead), 333 (a day old), 444 (dead); kept: 222 (alive and fresh) and what is not a run\'s');
});
