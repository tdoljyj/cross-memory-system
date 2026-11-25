// The poller's own lane (f79929d9, PR 乙 of D:/w/tmp/PLAN-native-admission-latency-20261124.md §1.3, §9): the Poller and the
// companion's lanes as main() assembles them (companion-main.mjs#advisoryLanes, run by its own `lane`), a fake clock and fake
// Runners: every gh read of the poll must reach the poll lane's own Runner (the advisory one answers none of them). Finding a new
// PR head never waits for the advisory lane: a retention notice that never returns or an advisory Runner held by a child that
// never ended delays only that lane. The poll comes every POLL_EVERY_MS (15 s); an unchanged minute is only 304s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { advisoryLanes, lane } from '../src/companion-main.mjs';
import { Inbox } from '../src/inbox.mjs';
import { heldHintOf, PrStatusReporter } from '../src/pr-status.mjs';
import { Runner } from '../src/runner.mjs';
import { restPolls } from './gh-rest-stub.mjs';
import { rulesReply } from './helpers.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const MAIN = 'd'.repeat(40);
// GitHub's merge base of a head and main: a push-landed trigger (poller.mjs#pass) carries it as its baseSha, a github-merge one carries MAIN.
const MERGE_BASE = 'f'.repeat(40);
const T0 = Date.parse('2026-11-24T04:00:00.000Z');
const never = () => new Promise(() => {});

// A fake clock with fake timers: sleep and setTimeout advance only when runUntil moves the clock. Between two timers every
// pending promise and every tracked write (the inbox drop is real file I/O) is let finish.
function fakeTime(start) {
  let now = start, seq = 0;
  const timers = new Map(), io = new Set();
  const schedule = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  const cancel = id => { timers.delete(id); };
  const sleep = ms => new Promise(r => schedule(r, ms));
  const track = p => { io.add(p); p.then(() => io.delete(p), () => io.delete(p)); return p; };
  const settle = async () => {
    for (let round = 0; round < 50; round += 1) {
      await new Promise(r => setImmediate(r));
      if (io.size) { await Promise.allSettled([...io]); round = 0; }
    }
  };
  async function runUntil(t) {
    for (;;) {
      await settle();
      let next = null;
      for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next || next[1].at > t) { now = Math.max(now, t); return; }
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
  }
  return { clock: () => now, schedule, cancel, sleep, track, runUntil };
}

const pull = (number, head) => ({ number, headRefOid: head, baseRefOid: MAIN, isDraft: false, body: '', updatedAt: '2026-11-24T04:00:00Z' });

// The parts of main() the poller and the two lanes are built from, all fakes but the inbox.
async function companionParts(t, ft, { advisory, retentionStep = async () => ({}),
  readStatus = async () => ({ queue: { generation: 'g1' }, pending: [] }), behindBy = 0 } = {}) {
  const dir = await fs.mkdtemp(path.join(process.env.TEMP || os.tmpdir(), 'poll-lane-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inboxDir = path.join(dir, 'inbox');
  await fs.mkdir(inboxDir);
  const pulls = [];
  const gh = { calls: [], compares: 0, statuses: [], main: MAIN, behindBy };
  const stub = restPolls(async argv => {
    if (argv.some(a => a.includes('/compare/'))) { gh.compares += 1; return { code: 0, stdout: JSON.stringify({ behind_by: gh.behindBy, base: gh.main, merge_base: MERGE_BASE }) }; }
    return { code: 9, stdout: '' };
  }, { main: () => gh.main, pulls: () => pulls });
  const pollRunner = { get busy() { return false; }, run: async (argv, o) => {
    gh.calls.push(argv);
    const r = await stub(argv, o);
    gh.statuses.push(/^HTTP\/[0-9.]+ ([0-9]{3})/.exec(r.stdout ?? '')?.[1] ?? 'other');
    return r;
  } };
  const statusReads = { n: 0 };
  const countedRead = () => { statusReads.n += 1; return readStatus(); };
  const parts = {
    // An advisory Runner that answers no gh read: a poll wired to it finds nothing.
    advisory: advisory ?? { get busy() { return false; }, run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    pollRunner, repo: REPO, ghExe: 'C:\\gh.exe', clock: ft.clock,
    writeTrigger: v => ft.track(Inbox.drop(inboxDir, v, ft.clock)),
    readStatus: countedRead,
    renewKeyCheck: async () => {},
    retentionNotifier: { step: retentionStep },
    pruneOldBundles: async () => [],
    backstop: async () => {},
    reporter: { pass: async () => ({ posted: 0 }) },
    schedule: ft.schedule, cancel: ft.cancel,
  };
  const triggers = async () => {
    const names = (await fs.readdir(inboxDir)).filter(n => n.endsWith('.json')).sort();
    return Promise.all(names.map(async n => JSON.parse(await fs.readFile(path.join(inboxDir, n), 'utf8'))));
  };
  return { parts, pulls, gh, triggers, statusReads };
}

// Every lane advisoryLanes returns, run by companion-main's own `lane` on the fake clock (as main() runs them).
function startLanes(parts, ft) {
  let stopped = false;
  const { poller, lanes: specs } = advisoryLanes(parts);
  const lanes = specs.map(spec => lane({ ...spec, sleep: ft.sleep, stop: () => stopped }));
  return { poller, lanes, stop: () => { stopped = true; } };
}

test('H-1: a newly held head is reported within 10 s of the poll with unchanged executor status', async t => {
  const ft = fakeTime(T0);
  t.mock.method(Date, 'now', ft.clock);
  // The first report runs at +9 s, six seconds before the poll lane's next pass.
  const status = { queue: { generation: 'g1' }, pending: [] };
  const c = await companionParts(t, ft, { behindBy: 3, readStatus: async () => status,
    retentionStep: async () => { if (ft.clock() === T0) await ft.sleep(9_000); } });
  const writes = [];
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: c.parts.ghExe, clock: ft.clock, notifications: false,
    store: { data: { posted: {}, notified: {} }, save: async () => {} },
    run: async argv => {
      if (argv.some(a => a.includes('/rules/branches/main'))) return rulesReply(['kooyumi-work-admission']);
      if (argv.includes('POST')) writes.push(argv);
      return { code: 0, stdout: '{}' };
    } });
  const pass = t.mock.method(reporter, 'pass');
  c.parts.reporter = reporter;
  const run = startLanes(c.parts, ft);
  t.after(run.stop);
  await ft.runUntil(T0 + 9_000);
  assert.equal(pass.mock.callCount(), 1);
  assert.equal(writes.length, 0);

  const head = 'a'.repeat(40);
  c.pulls.push(pull(1306, head));
  await ft.runUntil(T0 + 15_000);
  assert.deepEqual(run.poller.lastPass.pulls.map(p => [p.pr, p.headSha, p.hint]), [[1306, head, 'merge-main']]);

  await ft.runUntil(T0 + 25_000);
  assert.equal(pass.mock.callCount(), 2, 'reporter.pass runs again within 10 s of the poll');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes(`repos/${REPO}/statuses/${head}`));
  assert.ok(writes[0].includes('state=pending'));
  assert.equal(heldHintOf(writes[0].find(a => a.startsWith('description=')).slice('description='.length)), 'merge-main');
});

test('H-2: a change in behindBy alone waits for the minute report', async t => {
  const ft = fakeTime(T0);
  t.mock.method(Date, 'now', ft.clock);
  const c = await companionParts(t, ft, { behindBy: 3 });
  c.pulls.push(pull(1307, 'b'.repeat(40)));
  const { poller, lanes: [poll, report] } = advisoryLanes(c.parts);
  const pass = t.mock.method(c.parts.reporter, 'pass');
  await poll.work();
  await report.work();
  assert.equal(pass.mock.callCount(), 1);
  assert.equal(pass.mock.calls[0].arguments[0].pulls[0].behindBy, 3);

  await ft.runUntil(T0 + 15_000);
  c.gh.main = 'e'.repeat(40);
  c.gh.behindBy = 4;
  await poll.work();
  assert.equal(poller.lastPass.pulls[0].behindBy, 4);
  await report.work();
  assert.equal(pass.mock.callCount(), 1);

  await ft.runUntil(T0 + 60_001);
  await report.work();
  assert.equal(pass.mock.callCount(), 2);
  assert.equal(pass.mock.calls[1].arguments[0].pulls[0].behindBy, 4);
});

test('H-3: an empty lastPass and a failed poll leave the regular reports running', async t => {
  const ft = fakeTime(T0);
  t.mock.method(Date, 'now', ft.clock);
  const c = await companionParts(t, ft, { behindBy: 3 });
  const { poller, lanes: [poll, report] } = advisoryLanes(c.parts);
  const pass = t.mock.method(c.parts.reporter, 'pass');
  assert.equal(poller.lastPass, null);
  await report.work();
  assert.equal(pass.mock.callCount(), 1);
  assert.deepEqual(pass.mock.calls[0].arguments[0].pulls, []);

  await ft.runUntil(T0 + 15_000);
  c.pulls.push(pull(1308, 'c'.repeat(40)));
  await poll.work();
  const lastPass = poller.lastPass;
  assert.equal(lastPass.pulls[0].hint, 'merge-main');

  await ft.runUntil(T0 + 30_000);
  const fail = t.mock.method(c.parts.pollRunner, 'run', async () => ({ code: 1, stdout: '' }));
  await poll.work();
  assert.ok(fail.mock.callCount() > 0);
  assert.equal(poller.lastPass, lastPass);
  await report.work();
  assert.equal(pass.mock.callCount(), 1, 'a failed poll does not trigger a report for the cached heads');

  await ft.runUntil(T0 + 60_001);
  await report.work();
  assert.equal(pass.mock.callCount(), 2);
  assert.deepEqual(pass.mock.calls[1].arguments[0].pulls, lastPass.pulls);
});

test('a retention notice that never returns: a new PR head is in the inbox within 15 s (fake clock) and one poll', async t => {
  const ft = fakeTime(T0);
  const c = await companionParts(t, ft, { retentionStep: never });
  const run = startLanes(c.parts, ft);
  await ft.runUntil(T0 + 1_000);
  const head = 'a'.repeat(40);
  c.pulls.push(pull(1301, head));
  const openedAt = ft.clock();
  await ft.runUntil(openedAt + 15_000);
  const landed = await c.triggers();
  assert.deepEqual(landed.map(v => [v.pr, v.headSha, v.baseSha]), [[1301, head, MAIN]], 'the trigger is in the inbox although the advisory lane is stuck');
  run.stop();
});

test('the advisory Runner held by a child that never ended (RUNNER_BUSY_WITH_UNFINISHED_CHILD): the poll goes on', async t => {
  const ft = fakeTime(T0);
  const hung = [];
  const advisory = new Runner({ spawnImpl: () => { const handlers = {}; const c = { stdout: null, stderr: null, on: (e, f) => { handlers[e] = f; } }; hung.push(c); return c; } });
  const first = advisory.run(['C:\\gh.exe', 'api', 'x'], { timeoutMs: 1 });
  assert.equal((await first).timedOut, true);
  assert.equal(advisory.busy, true, 'the child has not ended');
  assert.equal((await advisory.run(['C:\\gh.exe', 'api', 'y'], { timeoutMs: 1 })).refused, 'RUNNER_BUSY_WITH_UNFINISHED_CHILD');
  const c = await companionParts(t, ft, { advisory });
  const run = startLanes(c.parts, ft);
  await ft.runUntil(T0 + 1_000);
  const head = 'b'.repeat(40);
  c.pulls.push(pull(1302, head));
  await ft.runUntil(ft.clock() + 15_000);
  assert.deepEqual((await c.triggers()).map(v => [v.pr, v.headSha]), [[1302, head]]);
  assert.equal(hung.length, 1, 'nothing else was started on the busy advisory Runner');
  assert.ok(c.gh.calls.length > 0, 'the poll\'s reads went to the poll lane\'s own Runner');
  run.stop();
});

test('an unchanged minute: four polls, only 304s, no trigger written, no compare', async t => {
  const ft = fakeTime(T0);
  const c = await companionParts(t, ft);
  c.pulls.push(pull(1303, 'c'.repeat(40)));
  const run = startLanes(c.parts, ft);
  await ft.runUntil(T0);
  assert.deepEqual([c.gh.statuses, c.gh.compares, (await c.triggers()).length], [['200', '200', 'other'], 1, 1], 'the first pass: two fresh reads, one compare, one trigger');
  c.gh.statuses.length = 0;
  const comparesBefore = c.gh.compares;
  await ft.runUntil(T0 + 60_000);
  assert.deepEqual(c.gh.statuses, Array(8).fill('304'), 'every 15 s two conditional reads, each a 304');
  assert.equal(c.gh.compares, comparesBefore, 'no compare: the (main, head) answer is cached');
  assert.equal((await c.triggers()).length, 1, 'nothing proposed again');
  run.stop();
});

test('a status read that never returns: the poll goes on after 5 s with the generation unknown and github-merge landing', async t => {
  const ft = fakeTime(T0);
  // The advisory lane is stuck at its retention notice, so every status read counted here is the poll lane's.
  const c = await companionParts(t, ft, { readStatus: never, retentionStep: never });
  const run = startLanes(c.parts, ft);
  await ft.runUntil(T0 + 6_000);
  assert.equal(c.statusReads.n, 1, 'one poll pass reads status.json exactly once (the landing mode comes from that same read)');
  const head = 'e'.repeat(40);
  c.pulls.push(pull(1304, head));
  await ft.runUntil(ft.clock() + 15_000 + 5_000);
  assert.deepEqual((await c.triggers()).map(v => [v.pr, v.headSha, v.baseSha]), [[1304, head, MAIN]],
    'proposed with main as its base: no push stamp while the status is unknown');
  await ft.runUntil(ft.clock() + 2 * (15_000 + 5_000));
  assert.equal(c.statusReads.n, 1, 'a read still outstanding is waited on again, never a second one on top of it');
  run.stop();
});

test('a status that says push: the trigger carries the merge base, from the pass\'s one status read', async t => {
  const ft = fakeTime(T0);
  const c = await companionParts(t, ft, { retentionStep: never,
    readStatus: async () => ({ queue: { generation: 'g1' }, pending: [], train: { batchRoute: 'push' } }) });
  const head = '1'.repeat(40);
  c.pulls.push(pull(1305, head));
  const run = startLanes(c.parts, ft);
  await ft.runUntil(T0);
  assert.equal(c.statusReads.n, 1, 'one poll pass, one status read');
  assert.deepEqual((await c.triggers()).map(v => [v.pr, v.headSha, v.baseSha]), [[1305, head, MERGE_BASE]]);
  run.stop();
});
