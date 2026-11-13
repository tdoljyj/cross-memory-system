// The compute panel's five-minute trigger (DESIGN §43, Decision 7eb98011): who dispatches, the fixed argv, the cross-node guard
// through GitHub's own run list, the backoff, the notifications, the ceiling, and a clock that is off. A fake GitHub stands in for gh;
// nothing here runs a workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { BACKOFF_MS, DISPATCH_EVERY_MS, DUTY_LOG_KEPT, MAX_PER_HOUR, MIN_GAP_MS, PANEL_REF, PANEL_REPO, PANEL_WORKFLOW, PanelDispatchState, PanelDispatcher, STAGGER_STEPS, STAGGER_STEP_MS,
  STALL_NOTIFY_MS, dispatchArgv, dutyOf, parseRuns, runsArgv, staggerMs, validatePanelDispatchConfig } from '../src/panel-dispatch.mjs';
import { PANEL_DISPATCH_LANE_EVERY_MS } from '../src/companion-main.mjs';
import { tempRoot } from './helpers.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-04T10:00:00Z');
const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe', REPO = 'tdoljyj/cross-memory-system';
const status = (o = {}, at = T0) => ({ writtenAt: at - 10_000, intakePause: null, node: { name: 'node-a', mode: 'ACTIVE', probe: { at: at - 5 * MIN, result: 'held' } }, ...o });

// One GitHub for any number of nodes: the workflow's run list, GitHub's clock (which may differ from the node's), the calls it saw.
function github({ skew = 0, runs = [], failRuns = false, dispatchFails = null, dispatchMakesRun = true } = {}) {
  const g = { now: T0, skew, runs: [...runs], calls: [], failRuns, dispatchFails, dispatchMakesRun, nextId: 1000 };
  const included = (code, body, extra = '') => `HTTP/2.0 ${code} OK\r\ndate: ${new Date(g.now).toUTCString()}\r\ncontent-type: application/json\r\n${extra}\r\n${body}`;
  g.reads = 0; g.beforeRead = null;
  g.run = async (argv) => {
    g.calls.push(argv);
    if (argv[1] === 'api' && argv.includes('--include') && argv.includes('GET')) {
      g.reads += 1;
      if (g.beforeRead) g.beforeRead(g.reads);
      if (g.failRuns) return { code: 1, stdout: '', stderr: 'gh: Bad gateway (HTTP 502)' };
      return { code: 0, stdout: included(200, JSON.stringify({ total_count: g.runs.length, workflow_runs: g.runs.map(r => ({ id: r.id, event: r.event, status: r.status ?? 'completed', created_at: new Date(r.at).toISOString() })) })), stderr: '' };
    }
    if (argv[1] === 'api' && argv.includes('POST')) {
      if (g.dispatchFails) return g.dispatchFails;
      if (g.dispatchMakesRun) g.runs.unshift({ id: g.nextId += 1, event: 'workflow_dispatch', at: g.now });
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected argv' };
  };
  g.posts = () => g.calls.filter(a => a.includes('POST'));
  g.advance = ms => { g.now += ms; };
  return g;
}

// One node: its own clock (= GitHub's plus the node's skew), status, memory file and notifications.
async function node(t, g, o = {}) {
  const file = o.file ?? path.join(await tempRoot(t), 'panel.json');
  const notes = [];
  let st = o.status ?? ((now) => status({}, now));
  const d = new PanelDispatcher({ nodeName: o.name ?? 'node-a', repo: REPO, ghExe: GH, clock: () => g.now + (o.skew ?? 0), run: g.run,
    readStatus: async () => (typeof st === 'function' ? st(g.now + (o.skew ?? 0)) : st), notify: async (key, title, body) => { notes.push({ key, title, body }); }, state: await PanelDispatchState.open(file) });
  d.stagger = o.stagger ?? 0; // the stagger has tests of its own; the others look at the rest without it
  return { d, notes, file, setStatus: s => { st = s; }, g };
}

test('companion.json panelDispatch: absent = on, enabled false = off, anything else refused', () => {
  assert.equal(validatePanelDispatchConfig(undefined).enabled, true);
  assert.equal(validatePanelDispatchConfig(null).enabled, true);
  assert.equal(validatePanelDispatchConfig({}).enabled, true);
  assert.equal(validatePanelDispatchConfig({ enabled: false }).enabled, false);
  for (const bad of [{ enabled: 'no' }, { enabled: true, workflow: 'x.yml' }, { ref: 'dev' }, [], 'on', 1]) assert.throws(() => validatePanelDispatchConfig(bad), /COMPANION_PANEL_DISPATCH_CONFIG_INVALID/);
});

test('the argv is fixed: the panel workflow on main, no input, one POST; a bad gh path or repository is refused', () => {
  assert.deepEqual(dispatchArgv(GH, REPO), [GH, 'api', '--method', 'POST', `repos/${REPO}/actions/workflows/clued-compute-panel.yml/dispatches`, '-f', 'ref=main']);
  assert.deepEqual(runsArgv(GH, REPO), [GH, 'api', '--include', '--method', 'GET', `repos/${REPO}/actions/workflows/clued-compute-panel.yml/runs?branch=main&per_page=5`]);
  assert.deepEqual([PANEL_WORKFLOW, PANEL_REF], ['clued-compute-panel.yml', 'main']);
  assert.equal(PANEL_REPO, REPO);
  for (const [gh, repo] of [['gh', REPO], [GH, 'no-slash'], [GH, 'a/b/../c x'], [GH, ''], [GH, 'tdoljyj/other-repo'], [GH, 'someone-else/cross-memory-system'], [GH, `${REPO}x`], [GH, `${REPO}/`], [GH, REPO.toUpperCase()]]) {
    assert.throws(() => dispatchArgv(gh, repo), /PANEL_DISPATCH_ARGS_INVALID/);
    assert.throws(() => runsArgv(gh, repo), /PANEL_DISPATCH_ARGS_INVALID/);
  }
});

test('the runs answer: newest first, GitHub\'s Date header as the clock, anything off the shape is no answer', () => {
  const body = JSON.stringify({ workflow_runs: [{ id: 1, event: 'schedule', status: 'completed', created_at: '2026-11-04T09:00:00Z' }, { id: 2, event: 'workflow_dispatch', status: 'queued', created_at: '2026-11-04T09:30:00Z' }] });
  const ok = parseRuns(`HTTP/2.0 200 OK\r\nDate: Wed, 04 Nov 2026 09:31:00 GMT\r\n\r\n${body}`, 5);
  assert.deepEqual(ok.runs.map(r => [r.id, r.event]), [[2, 'workflow_dispatch'], [1, 'schedule']]);
  assert.equal(ok.serverNow, Date.parse('2026-11-04T09:31:00Z'));
  assert.equal(parseRuns(`HTTP/2.0 200 OK\r\n\r\n${body}`, 5).serverNow, 5, 'no Date header: the local clock');
  assert.equal(parseRuns(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ workflow_runs: [] })}`, 5).runs.length, 0);
  for (const bad of [`HTTP/2.0 304 Not Modified\r\n\r\n`, `HTTP/2.0 200 OK\r\n\r\nnot json`, `HTTP/2.0 200 OK\r\n\r\n{}`, `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ workflow_runs: [{ id: 'x', event: 'e', status: 's', created_at: '2026-11-04T09:00:00Z' }] })}`,
    `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ workflow_runs: [{ id: 3, event: 'e', status: 's', created_at: 'yesterday' }] })}`, '', null]) assert.equal(parseRuns(bad, 5), null);
});

test('who is on duty: ACTIVE, a fresh snapshot, its own name, no dual-active hold; every other state is a named reason', () => {
  assert.equal(dutyOf(status(), 'node-a', T0), null);
  const cases = [[null, 'STATUS_UNREADABLE'], [status({}, T0 - 6 * MIN), 'STATUS_STALE'], [status({ node: null }), 'NODE_UNKNOWN'], [status({ node: { name: 'node-b', mode: 'ACTIVE' } }), 'NODE_NAME_MISMATCH'],
    [status({ node: { name: 'node-a', mode: 'STANDBY' } }), 'NOT_ACTIVE'], [status({ node: { name: 'node-a', mode: 'UNCERTAIN' } }), 'NODE_ROLE_UNCERTAIN'],
    [status({ intakePause: { until: T0 + MIN, holders: [{ holder: 'dual-active', until: T0 + MIN }] } }), 'DUAL_ACTIVE_HOLD']];
  for (const [s, why] of cases) assert.equal(dutyOf(s, 'node-a', T0), why, why);
  // a HALT, a PAUSE or another intake pause does not stop the panel: it must keep showing exactly those outages
  assert.equal(dutyOf(status({ halt: { code: 'X_Y' }, paused: true, intakePause: { until: T0 + MIN, holders: [{ holder: 'owner' }] } }), 'node-a', T0), null);
});

test('not on duty: not one call to GitHub (standby, stale snapshot, dual-active hold, unreadable status)', async t => {
  const g = github();
  const n = await node(t, g, { status: now => status({ node: { name: 'node-a', mode: 'STANDBY' } }, now) });
  for (let i = 0; i < 5; i += 1) { assert.deepEqual(await n.d.step(), { skipped: 'NOT_ON_DUTY', reason: 'NOT_ACTIVE' }); g.advance(DISPATCH_EVERY_MS); }
  n.setStatus(null); assert.equal((await n.d.step()).reason, 'STATUS_UNREADABLE');
  n.setStatus(() => { throw new Error('unreadable'); }); assert.equal((await n.d.step()).reason, 'STATUS_UNREADABLE');
  n.setStatus(status({}, g.now - 10 * MIN)); assert.equal((await n.d.step()).reason, 'STATUS_STALE');
  n.setStatus(status({ intakePause: { until: g.now + MIN, holders: [{ holder: 'dual-active' }] } }, g.now)); assert.equal((await n.d.step()).reason, 'DUAL_ACTIVE_HOLD');
  assert.equal(g.calls.length, 0);
});

test('on duty: a dispatch every five minutes, each confirmed by the next read; the lane looks twice a minute', async t => {
  assert.equal(PANEL_DISPATCH_LANE_EVERY_MS, 30_000);
  const g = github({ runs: [{ id: 1, event: 'schedule', at: T0 - 6 * 3_600_000 }] });
  const n = await node(t, g);
  assert.deepEqual(await n.d.step(), { dispatched: true, at: T0 });
  assert.deepEqual(g.posts(), [dispatchArgv(GH, REPO)]);
  for (let i = 0; i < 9; i += 1) { g.advance(30_000); assert.equal((await n.d.step()).skipped, 'NOT_DUE'); }
  assert.equal(g.posts().length, 1, 'not before the five minutes are over');
  g.advance(30_000);
  assert.equal((await n.d.step()).dispatched, true, 'the earlier dispatch produced a run: the next goes');
  assert.equal(g.posts().length, 2);
  for (let i = 0; i < 6; i += 1) { g.advance(DISPATCH_EVERY_MS); assert.equal((await n.d.step()).dispatched, true); }
  assert.equal(g.posts().length, 8);
  assert.deepEqual(n.notes, []);
  assert.equal(n.d.failures, 0);
});

test('a run younger than four minutes holds the slot, whoever made it: the cron, or the other node', async t => {
  const g = github({ runs: [{ id: 1, event: 'schedule', at: T0 - 90_000 }] });
  const a = await node(t, g);
  const r = await a.d.step();
  assert.deepEqual([r.skipped, r.event, r.ageMs], ['RECENT_RUN', 'schedule', 90_000]);
  assert.equal(g.posts().length, 0);
  g.advance(3.5 * MIN); // the cron's run is now 5 minutes old
  assert.equal((await a.d.step()).dispatched, true);
  // two ACTIVE nodes (a take-over in progress): the second reads the first one's run and stays out of the slot
  const b = await node(t, g, { name: 'node-b', status: now => status({ node: { name: 'node-b', mode: 'ACTIVE' } }, now) });
  g.advance(30_000);
  const rb = await b.d.step();
  assert.deepEqual([rb.skipped, rb.event], ['RECENT_RUN', 'workflow_dispatch']);
  assert.equal(g.posts().length, 1);
  // five minutes after A's run, whichever node is due goes; the other then sees that run
  g.advance(DISPATCH_EVERY_MS);
  assert.equal((await b.d.step()).dispatched, true);
  g.advance(10_000);
  assert.equal((await a.d.step()).skipped, 'RECENT_RUN');
  assert.equal(g.posts().length, 2);
  assert.ok(MIN_GAP_MS < DISPATCH_EVERY_MS);
});

test('a node that is off by minutes: the runs are aged by GitHub\'s own clock', async t => {
  for (const skew of [-12 * MIN, 12 * MIN]) {
    const g = github({ runs: [{ id: 1, event: 'schedule', at: T0 - MIN }] });
    const n = await node(t, g, { skew });
    assert.equal((await n.d.step()).skipped, 'RECENT_RUN', `skew ${skew}`);
    g.advance(4 * MIN);
    assert.equal((await n.d.step()).dispatched, true, `skew ${skew}`);
    g.advance(DISPATCH_EVERY_MS);
    assert.equal((await n.d.step()).dispatched, true, 'its own earlier run is seen as that: effective, not stuck');
  }
});

test('a failed read or dispatch backs off 1, 2, 4, 8, 15 minutes; the third failure says so once; a success ends the spell and says so', async t => {
  const g = github({ failRuns: true });
  const n = await node(t, g);
  const waits = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await n.d.step();
    assert.equal(r.failed, 'RUNS_UNREADABLE');
    waits.push(r.retryInMs);
    g.advance(r.retryInMs - 1);
    assert.equal((await n.d.step()).skipped, 'NOT_DUE');
    g.advance(1);
  }
  assert.deepEqual(waits, [...BACKOFF_MS, BACKOFF_MS.at(-1), BACKOFF_MS.at(-1)]);
  assert.equal(g.posts().length, 0, 'nothing is dispatched without the list');
  assert.deepEqual(n.notes.filter(x => x.key.startsWith('panel-dispatch-failing:')).map(x => x.title), ['算力面板的 5 分钟触发失败'], 'once per spell');
  g.failRuns = false;
  assert.equal((await n.d.step()).dispatched, true);
  g.advance(DISPATCH_EVERY_MS);
  assert.equal((await n.d.step()).dispatched, true);
  assert.equal(n.d.failures, 0);
  assert.ok(n.notes.some(x => x.key.startsWith('panel-dispatch-recovered:')), 'the recovery is said once the workflow runs again');
  assert.equal(n.notes.filter(x => x.key.startsWith('panel-dispatch-recovered:')).length, 1);
});

test('a refusal that waiting does not cure (403, 404, 422) is said at the first failure; the text never carries gh\'s own output', async t => {
  for (const [stderr, code] of [['gh: Resource not accessible (HTTP 403)', 'DISPATCH_FORBIDDEN'], ['gh: Not Found (HTTP 404)', 'DISPATCH_NOT_FOUND'], ['gh: Workflow does not have workflow_dispatch trigger (HTTP 422)', 'DISPATCH_REJECTED']]) {
    const g = github({ dispatchFails: { code: 1, stdout: '', stderr: `${stderr} gho_SECRET` } });
    const n = await node(t, g);
    const r = await n.d.step();
    assert.deepEqual([r.failed, r.failures, r.retryInMs], [code, 1, BACKOFF_MS[0]]);
    assert.equal(n.notes.length, 1);
    assert.doesNotMatch(JSON.stringify(n.notes), /gho_|SECRET/);
    g.advance(BACKOFF_MS[0]);
    assert.equal((await n.d.step()).failed, code);
    assert.equal(n.notes.length, 1, 'once');
  }
  const slow = github({ dispatchFails: { code: null, stdout: '', stderr: '', timedOut: true } });
  const n = await node(t, slow);
  assert.equal((await n.d.step()).failed, 'DISPATCH_TIMEOUT');
  assert.equal(n.notes.length, 0, 'a timeout may pass: it waits for the third');
  const odd = github({ dispatchFails: { code: 1, stdout: '', stderr: 'dial tcp: lookup api.github.com' } });
  assert.equal((await (await node(t, odd)).d.step()).failed, 'DISPATCH_FAILED');
});

test('a dispatch GitHub accepted but no run followed: counted as a failure at the next look', async t => {
  const g = github({ dispatchMakesRun: false });
  const n = await node(t, g);
  assert.equal((await n.d.step()).dispatched, true);
  g.advance(DISPATCH_EVERY_MS);
  const r = await n.d.step();
  assert.deepEqual([r.failed, r.failures], ['DISPATCH_NO_RUN', 1]);
  assert.equal(g.posts().length, 1, 'no second dispatch on top of an unverified one in the same look');
  g.dispatchMakesRun = true;
  g.advance(BACKOFF_MS[0]);
  assert.equal((await n.d.step()).dispatched, true);
});

test('on duty and no run for 15 minutes: one notification per spell, whatever the cause; the next run says it recovered', async t => {
  const g = github({ dispatchMakesRun: false });
  const n = await node(t, g);
  for (let i = 0; i < 40; i += 1) { await n.d.step(); g.advance(MIN); }
  const stalled = n.notes.filter(x => x.key.startsWith('panel-dispatch-stalled:'));
  assert.equal(stalled.length, 1);
  assert.match(stalled[0].body, /\d+ 分钟内 main 上没有 clued-compute-panel\.yml 的运行/);
  g.dispatchMakesRun = true;
  for (let i = 0; i < 45; i += 1) { await n.d.step(); g.advance(MIN); } // the 15-minute backoff of the failed spell runs out first
  assert.equal(n.notes.filter(x => x.key.startsWith('panel-dispatch-recovered:')).length, 1);
  assert.ok(STALL_NOTIFY_MS === 15 * MIN);
});

test('losing the duty ends the spell: the standby never alarms, and a node that takes over starts clean', async t => {
  const g = github({ failRuns: true });
  const n = await node(t, g);
  for (let i = 0; i < 4; i += 1) { await n.d.step(); g.advance(15 * MIN); }
  const before = n.notes.length;
  n.setStatus(status({ node: { name: 'node-a', mode: 'STANDBY' } }, g.now));
  for (let i = 0; i < 6; i += 1) { assert.equal((await n.d.step()).skipped, 'NOT_ON_DUTY'); g.advance(10 * MIN); }
  assert.equal(n.notes.length, before, 'a standby says nothing');
  assert.equal(n.d.failures, 0);
});

test('the ceiling holds across a restart: no more than 20 dispatches in an hour', async t => {
  const g = github();
  const file = path.join(await tempRoot(t), 'panel.json');
  const state = new PanelDispatchState(file);
  state.data.sent = Array.from({ length: MAX_PER_HOUR }, (_, i) => T0 - 50 * MIN + i * MIN);
  state.data.lastDispatchAt = T0 - 31 * MIN;
  await state.save();
  const n = await node(t, g, { file });
  assert.equal((await n.d.step()).skipped, 'HOURLY_CAP');
  assert.equal(g.calls.length, 0);
  g.advance(11 * MIN); // the oldest of the twenty is more than an hour old
  assert.equal((await n.d.step()).dispatched, true);
});

test('a restart does not dispatch at once again: the memory file keeps the last dispatch and the open verification', async t => {
  const g = github();
  const file = path.join(await tempRoot(t), 'panel.json');
  const first = await node(t, g, { file });
  assert.equal((await first.d.step()).dispatched, true);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual([saved.contract, saved.lastDispatchAt, saved.pendingAt, saved.sent], ['clued.independent-ci.panel-dispatch-state/1', T0, T0, [T0]]);
  g.advance(2 * MIN);
  const second = await node(t, g, { file });
  assert.equal((await second.d.step()).skipped, 'NOT_DUE');
  g.advance(3 * MIN);
  assert.equal((await second.d.step()).dispatched, true, 'verified from the run list, then due');
  // a memory file that is damaged or from another shape starts fresh
  await fs.writeFile(file, '{ not json');
  assert.equal((await PanelDispatchState.open(file)).data.lastDispatchAt, null);
  await fs.writeFile(file, JSON.stringify({ contract: 'other', lastDispatchAt: T0 }));
  assert.equal((await PanelDispatchState.open(file)).data.lastDispatchAt, null);
});

test('a clock set back does not park the next dispatch in the future', async t => {
  const g = github();
  const file = path.join(await tempRoot(t), 'panel.json');
  const state = new PanelDispatchState(file);
  state.data.lastDispatchAt = T0 + 3 * 3_600_000; // written by a clock that was ahead
  await state.save();
  const n = await node(t, g, { file });
  assert.equal((await n.d.step()).dispatched, true);
});

test('the pulse: the memory file says when it last looked, whether the node is on duty and why not', async t => {
  const g = github();
  const n = await node(t, g, { status: status({ node: { name: 'node-a', mode: 'STANDBY' } }) });
  await n.d.step();
  let saved = JSON.parse(await fs.readFile(n.file, 'utf8'));
  assert.deepEqual([saved.tickAt, saved.duty], [T0, { on: false, reason: 'NOT_ACTIVE' }]);
  n.setStatus(status({}, g.now + MIN));
  g.advance(MIN);
  await n.d.step();
  saved = JSON.parse(await fs.readFile(n.file, 'utf8'));
  assert.deepEqual([saved.tickAt, saved.duty, saved.lastDispatchAt], [g.now, { on: true, reason: null }, g.now]);
});

test('the repository is pinned: the dispatcher is built for this repository only, whatever the configuration says', async t => {
  const state = new PanelDispatchState(path.join(await tempRoot(t), 'panel.json'));
  const build = repo => new PanelDispatcher({ nodeName: 'node-a', repo, ghExe: GH, clock: () => T0, run: async () => ({ code: 0 }), readStatus: async () => null, notify: async () => {}, state });
  for (const repo of ['tdoljyj/other-repo', 'someone-else/cross-memory-system', 'a/b']) assert.throws(() => build(repo), /PANEL_DISPATCH_ARGS_INVALID/);
  assert.doesNotThrow(() => build(REPO));
});

test('the hourly ceiling: reached once, then no read, no GitHub call, and the memory file written no more than once a minute', async t => {
  const g = github();
  const file = path.join(await tempRoot(t), 'panel.json');
  const seed = new PanelDispatchState(file);
  seed.data.sent = Array.from({ length: MAX_PER_HOUR }, (_, i) => T0 - 50 * MIN + i * MIN);
  seed.data.lastDispatchAt = T0 - 31 * MIN;
  await seed.save();
  const n = await node(t, g, { file });
  let saves = 0; const save = n.d.state.save.bind(n.d.state); n.d.state.save = async () => { saves += 1; return save(); };
  const first = await n.d.step();
  assert.equal(first.skipped, 'HOURLY_CAP');
  assert.equal(first.untilMs, 10 * MIN);
  const afterFirst = saves, nextAt = n.d.nextAt;
  for (let i = 0; i < 18; i += 1) { g.advance(30_000); assert.equal((await n.d.step()).skipped, 'HOURLY_CAP'); } // nine minutes, 18 looks
  assert.equal(g.calls.length, 0);
  assert.ok(saves - afterFirst <= 9, `${saves - afterFirst} writes in nine minutes: at most one a minute`);
  assert.equal(n.d.nextAt, nextAt, 'the clock guard for the next attempt is not what holds the ceiling');
  g.advance(2 * MIN);
  assert.equal((await n.d.step()).dispatched, true, 'the ceiling ends when the oldest of the twenty is an hour old');
});

test('a clock set back: dispatches stamped in its future do not hold the ceiling', async t => {
  const g = github();
  const file = path.join(await tempRoot(t), 'panel.json');
  const seed = new PanelDispatchState(file);
  seed.data.sent = Array.from({ length: MAX_PER_HOUR }, (_, i) => T0 + 3 * 3_600_000 + i * MIN);
  await seed.save();
  const n = await node(t, g, { file });
  assert.equal((await n.d.step()).dispatched, true);
});

test('the node-specific wait: the same for a name, 0 to 57 s in 3 s steps, different for the two real nodes', () => {
  for (const name of ['node-a', 'node-b', 'home-win-02', 'a']) {
    const w = staggerMs(name);
    assert.equal(w, staggerMs(name));
    assert.ok(w >= 0 && w < STAGGER_STEPS * STAGGER_STEP_MS && w % STAGGER_STEP_MS === 0, `${name} ${w}`);
  }
  assert.notEqual(staggerMs('node-a'), staggerMs('node-b'), 'the two nodes of today do not wake up together');
});

test('taking the duty waits the node\'s own time; so does following a run that was not its own', async t => {
  const g = github({ runs: [{ id: 1, event: 'schedule', at: T0 - 6 * MIN }] });
  const a = await node(t, g, { stagger: 12_000 });
  assert.deepEqual([(await a.d.step()).skipped, a.d.nextAt - g.now], ['NOT_DUE', 12_000]);
  g.advance(11_000);
  assert.equal((await a.d.step()).skipped, 'NOT_DUE');
  g.advance(1_000);
  assert.equal((await a.d.step()).dispatched, true);
  // the other node follows A's run: five minutes after it, plus its own wait, never at A's second
  const b = await node(t, g, { name: 'node-b', status: now => status({ node: { name: 'node-b', mode: 'ACTIVE' } }, now), stagger: 21_000 });
  assert.equal((await b.d.step()).skipped, 'NOT_DUE');
  g.advance(21_000);
  const rb = await b.d.step();
  assert.equal(rb.skipped, 'RECENT_RUN');
  assert.equal(b.d.nextAt - g.now, DISPATCH_EVERY_MS - rb.ageMs + 21_000);
  // A is due at its run + 5 minutes; B only 21 s later, and then finds A's run
  g.advance(DISPATCH_EVERY_MS - 21_000);
  assert.equal((await a.d.step()).dispatched, true);
  g.advance(21_000);
  assert.equal((await b.d.step()).skipped, 'RECENT_RUN');
  assert.equal(g.posts().length, 2, 'one dispatch for each slot');
});

test('another node\'s dispatch between the first read and the POST holds the slot (the list is read again right before)', async t => {
  const g = github();
  const n = await node(t, g);
  g.beforeRead = count => { if (count === 2) g.runs.unshift({ id: 4242, event: 'workflow_dispatch', at: g.now - 2_000 }); };
  const r = await n.d.step();
  assert.deepEqual([r.skipped, r.recheck, r.event], ['RECENT_RUN', true, 'workflow_dispatch']);
  assert.equal(g.posts().length, 0);
  assert.equal(g.reads, 2);
  g.beforeRead = null;
  g.advance(DISPATCH_EVERY_MS + 5_000);
  assert.equal((await n.d.step()).dispatched, true);
  assert.equal(g.reads, 4, 'two reads for each dispatch');
});

test('the duty log: how the duty changed and why, kept across restarts, the last ten', async t => {
  const g = github();
  const ctl = { mode: 'ACTIVE', fresh: true };
  const n = await node(t, g, { status: now => status({ node: { name: 'node-a', mode: ctl.mode } }, ctl.fresh ? now : now - 10 * MIN) });
  await n.d.step();
  ctl.fresh = false; g.advance(MIN); await n.d.step();
  ctl.fresh = true; ctl.mode = 'STANDBY'; g.advance(MIN); await n.d.step();
  g.advance(MIN); await n.d.step(); // unchanged: no new entry
  ctl.mode = 'ACTIVE'; g.advance(MIN); await n.d.step();
  const saved = JSON.parse(await fs.readFile(n.file, 'utf8'));
  assert.deepEqual(saved.dutyLog.map(e => [e.on, e.reason]), [[true, null], [false, 'STATUS_STALE'], [false, 'NOT_ACTIVE'], [true, null]]);
  assert.deepEqual((await PanelDispatchState.open(n.file)).data.dutyLog.map(e => e.reason), [null, 'STATUS_STALE', 'NOT_ACTIVE', null]);
  for (let i = 0; i < 14; i += 1) { ctl.mode = i % 2 ? 'ACTIVE' : 'STANDBY'; g.advance(MIN); await n.d.step(); }
  assert.equal(JSON.parse(await fs.readFile(n.file, 'utf8')).dutyLog.length, DUTY_LOG_KEPT);
});
