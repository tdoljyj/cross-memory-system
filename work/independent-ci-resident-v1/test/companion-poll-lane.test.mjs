// The poller's own lane (f79929d9, PR 乙 of D:/w/tmp/PLAN-native-admission-latency-20261124.md §1.3): the companion's lanes as
// main() assembles them (companion-main.mjs#advisoryLanes, run by its own `lane`), a fake clock and fake Runners. Finding a new
// PR head never waits for the advisory lane: a retention notice that never returns or an advisory Runner held by a child that
// never ended delays only that lane. The poll comes every POLL_EVERY_MS (15 s); an unchanged minute is only 304s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { advisoryLanes, lane } from '../src/companion-main.mjs';
import { Poller } from '../src/poller.mjs';
import { Inbox } from '../src/inbox.mjs';
import { Runner } from '../src/runner.mjs';
import { restPolls } from './gh-rest-stub.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const MAIN = 'd'.repeat(40);
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

// The parts of main() the advisory and poll lanes are built from, all fakes but the Poller and the inbox.
async function companionParts(t, ft, { advisory, retentionStep = async () => ({}), readStatus = async () => ({ queue: { generation: 'g1' }, pending: [] }) } = {}) {
  const dir = await fs.mkdtemp(path.join(process.env.TEMP || os.tmpdir(), 'poll-lane-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inboxDir = path.join(dir, 'inbox');
  await fs.mkdir(inboxDir);
  const pulls = [];
  const gh = { calls: [], compares: 0, statuses: [] };
  const stub = restPolls(async argv => {
    if (argv.some(a => a.includes('/compare/'))) { gh.compares += 1; return { code: 0, stdout: JSON.stringify({ behind_by: 0, base: MAIN }) }; }
    return { code: 9, stdout: '' };
  }, { main: () => MAIN, pulls: () => pulls });
  const pollRunner = { get busy() { return false; }, run: async (argv, o) => {
    gh.calls.push(argv);
    const r = await stub(argv, o);
    gh.statuses.push(/^HTTP\/[0-9.]+ ([0-9]{3})/.exec(r.stdout ?? '')?.[1] ?? 'other');
    return r;
  } };
  const poller = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: (a, o) => pollRunner.run(a, o), clock: ft.clock,
    writeTrigger: v => ft.track(Inbox.drop(inboxDir, v, ft.clock)) });
  const statusReads = { n: 0 };
  const parts = {
    advisory: advisory ?? { get busy() { return false; }, run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    pollRunner, poller,
    readStatus: () => { statusReads.n += 1; return readStatus(); },
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
  return { parts, pulls, gh, poller, triggers, statusReads };
}

// Every lane advisoryLanes returns, run by companion-main's own `lane` on the fake clock (as main() runs them).
function startLanes(parts, ft) {
  let stopped = false;
  const lanes = advisoryLanes(parts).map(spec => lane({ ...spec, sleep: ft.sleep, stop: () => stopped }));
  return { lanes, stop: () => { stopped = true; } };
}

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

test('a status read that never returns: the poll goes on after 5 s with the generation unknown', async t => {
  const ft = fakeTime(T0);
  const c = await companionParts(t, ft, { readStatus: never });
  const run = startLanes(c.parts, ft);
  await ft.runUntil(T0 + 6_000);
  const head = 'e'.repeat(40);
  c.pulls.push(pull(1304, head));
  await ft.runUntil(ft.clock() + 15_000 + 5_000);
  assert.deepEqual((await c.triggers()).map(v => [v.pr, v.headSha]), [[1304, head]]);
  assert.equal(c.statusReads.n, 1, 'a read still outstanding is waited on again, never a second one on top of it');
  run.stop();
});
