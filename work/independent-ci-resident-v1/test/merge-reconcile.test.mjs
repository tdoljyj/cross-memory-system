// Offline event/transport matrix. A fake gh receives fixed argv; no workflow,
// merge, branch update or role scan is executed by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { MergeReconcileState, MergeReconciler, RECONCILE_REPO, RECONCILE_WORKFLOW, RECONCILE_REF, RECONCILE_EVERY_MS,
  RECONCILE_MAX_DISPATCHES_PER_HOUR, RECONCILE_MAX_READS_PER_HOUR, reconcileDispatchArgv, reconcileSourceArgv,
  reconcileRunsArgv, reconcileDutyOf } from '../src/merge-reconcile.mjs';

const T0 = Date.parse('2026-11-07T00:00:00Z'), HOUR = 3_600_000, MIN = 60_000;
const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe', NODE = 'node-b';
const SOURCE = Buffer.from('name: clued-merge-reconcile\non: workflow_dispatch\n');
const PIN = createHash('sha256').update(SOURCE).digest('hex');
const expected = { nodeName: NODE, repo: RECONCILE_REPO, pinnedSource: PIN };
const ID = '00000000-0000-4000-8000-000000000001';
const publicStatus = now => ({ writtenAt: now, node: { name: NODE, mode: 'ACTIVE' }, paused: false, halt: null, intakePause: null,
  versions: { consistent: true, upgrade: null }, executor: { state: 'IDLE', reason: null } });
const http = (status, body = '', headers = '') => ({ code: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} OK\r\n${headers}\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`, stderr: '' });
const sourceReply = () => http(200, { type: 'file', path: `.github/workflows/${RECONCILE_WORKFLOW}`, sha: '1'.repeat(40),
  size: SOURCE.length, content: SOURCE.toString('base64'), encoding: 'base64' });
const row = (id, request, at, overrides = {}) => ({ id, display_title: `clued-merge-reconcile ${request}`, event: 'workflow_dispatch',
  head_branch: 'main', head_sha: '2'.repeat(40), status: 'completed', created_at: new Date(at).toISOString(), ...overrides });

async function harness(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-reconcile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const h = { file: path.join(dir, 'state.json'), now: T0, calls: [], runs: [], source: sourceReply, notices: [], posts: [],
    status: () => publicStatus(h.now), post: () => http(204), ...options };
  h.run = async argv => {
    h.calls.push(argv);
    if (argv.includes('POST')) { h.posts.push(argv); return h.post(argv); }
    if (argv.some(s => s.includes('/contents/'))) return h.source(argv);
    if (argv.some(s => s.includes('/runs?'))) return h.readRuns ? h.readRuns(argv) : http(200, { workflow_runs: h.runs });
    throw Error('unexpected argv');
  };
  h.open = async () => new MergeReconciler({ ...expected, ghExe: GH, clock: () => h.now, run: h.run,
    state: await MergeReconcileState.open(h.file, expected), readStatus: async () => h.status(), notify: async (...v) => h.notices.push(v) });
  h.r = await h.open();
  return h;
}

test('fixed argv cannot select another repository, workflow, branch or PR', () => {
  assert.equal(RECONCILE_REF, 'main');
  assert.deepEqual(reconcileDispatchArgv(GH, RECONCILE_REPO, ID), [GH, 'api', '--include', '--method', 'POST',
    `repos/${RECONCILE_REPO}/actions/workflows/clued-merge-reconcile.yml/dispatches`, '-f', 'ref=main', '-f', `inputs[reconcile_request_id]=${ID}`]);
  assert.ok(reconcileSourceArgv(GH, RECONCILE_REPO).at(-1).endsWith('?ref=main'));
  assert.ok(reconcileRunsArgv(GH, RECONCILE_REPO).at(-1).includes('branch=main'));
  for (const repo of ['x/y', '', 'TDOLJYJ/cross-memory-system']) assert.throws(() => reconcileDispatchArgv(GH, repo, ID));
  for (const id of ['x', `${ID}\n-f bad=true`, null]) assert.throws(() => reconcileDispatchArgv(GH, RECONCILE_REPO, id));
  assert.throws(() => reconcileDispatchArgv('gh', RECONCILE_REPO, ID));
});

test('missing completion and no new push: a cadence wake-up needs no PR/head/event input', async t => {
  const h = await harness(t);
  const first = await h.r.step(); assert.equal(first.dispatched, true); assert.equal(h.posts.length, 1);
  const persisted = JSON.parse(await fs.readFile(h.file, 'utf8'));
  assert.equal(persisted.pending.requestId, first.requestId); assert.equal(persisted.pending.phase, 'ACCEPTED');
  h.r = await h.open(); // restart preserves the pending request
  assert.equal((await h.r.step()).skipped, 'NOT_DUE'); assert.equal(h.posts.length, 1);
  h.runs = [row(10, first.requestId, h.now)]; h.now += RECONCILE_EVERY_MS;
  assert.equal((await h.r.step()).observed, true); assert.equal(h.posts.length, 1);
  assert.equal((await h.r.step()).dispatched, true); assert.equal(h.posts.length, 2);
  assert.ok(h.calls.every(argv => !argv.some(s => /pulls\/|rerun|\/merge$|update-branch/.test(s))));
});

test('a durable INTENT exists before POST; a failed state write sends nothing', async t => {
  const h = await harness(t);
  h.post = async () => {
    const saved = JSON.parse(await fs.readFile(h.file, 'utf8'));
    assert.equal(saved.pending.phase, 'INTENT'); assert.equal(saved.dispatches.length, 1); return http(204);
  };
  assert.equal((await h.r.step()).dispatched, true);
  const n = await harness(t); const save = n.r.state.save.bind(n.r.state); let saves = 0;
  n.r.state.save = async () => { saves++; if (n.r.state.data.pending) throw Error('disk refused'); await save(); };
  assert.equal((await n.r.step()).skipped, 'STATE_OR_READ_FAILURE'); assert.ok(saves >= 1); assert.equal(n.posts.length, 0);
});

test('crash after INTENT but before delivery stays unknown after restart rather than retrying', async t => {
  const h = await harness(t);
  const d = h.r.state.data; d.lastTickAt = h.now; d.nextAt = h.now; d.dispatches = [h.now];
  d.pending = { requestId: ID, at: h.now, sourceSha256: PIN, phase: 'INTENT' }; await h.r.state.save();
  h.r = await h.open(); assert.equal((await h.r.step()).skipped, 'DISPATCH_UNKNOWN');
  h.now += HOUR; h.r = await h.open(); assert.equal((await h.r.step()).skipped, 'DISPATCH_UNKNOWN'); assert.equal(h.posts.length, 0);
});

test('unknown timeout/500/invalid response never blindly resends; positive run evidence resolves it', async t => {
  for (const post of [() => ({ code: 1, stdout: '', timedOut: true }), () => http(500), () => ({ code: 0, stdout: '' }), () => { throw Error('transport'); }]) {
    const h = await harness(t, { post });
    assert.equal((await h.r.step()).skipped, 'DISPATCH_UNKNOWN'); const request = h.r.state.data.pending.requestId;
    h.now += HOUR; h.r = await h.open(); assert.equal((await h.r.step()).skipped, 'DISPATCH_UNKNOWN'); assert.equal(h.posts.length, 1);
    h.runs = [row(20, request, T0, { status: 'in_progress' })]; h.now += RECONCILE_EVERY_MS;
    assert.equal((await h.r.step()).observed, true); assert.equal(h.posts.length, 1);
  }
});

test('duplicate/out-of-order and unrelated PR/main observations confer no cached merge authority', async t => {
  const h = await harness(t); const first = await h.r.step();
  h.runs = [row(3, ID, T0 - MIN), row(1, first.requestId, T0), row(1, first.requestId, T0), row(2, ID, T0 - 2 * MIN)];
  h.now += RECONCILE_EVERY_MS; assert.equal((await h.r.step()).requestId, first.requestId);
  h.now += RECONCILE_EVERY_MS; h.runs[0].head_sha = '3'.repeat(40); // main moved; wake-up still carries no expected PR permission
  assert.equal((await h.r.step()).dispatched, true);
  assert.ok(h.posts.every(a => a.filter(v => v.startsWith('inputs[')).length === 1));
});

test('only a matching workflow_dispatch title on main acknowledges the pending request', async t => {
  const h = await harness(t); const first = await h.r.step(); h.now += RECONCILE_EVERY_MS;
  h.runs = [row(1, first.requestId, T0, { event: 'push' })];
  assert.equal((await h.r.step()).skipped, 'DISPATCH_UNKNOWN'); assert.ok(h.r.state.data.pending);
  h.now += RECONCILE_EVERY_MS; h.runs = [row(1, first.requestId, T0, { head_branch: 'feature' })];
  assert.equal((await h.r.step()).skipped, 'RUNS_UNREADABLE'); assert.ok(h.r.state.data.pending);
});

test('standby/stale/future/Owner intake pause/PAUSE/HALT/upgrade/drain/version unknown produce zero API calls', async t => {
  const variants = [() => null, now => ({ ...publicStatus(now), node: { name: NODE, mode: 'STANDBY' } }),
    now => ({ ...publicStatus(now), writtenAt: now - 60_001 }), now => ({ ...publicStatus(now), writtenAt: now + 1 }),
    now => ({ ...publicStatus(now), intakePause: { holders: [{ holder: 'owner' }] } }),
    now => ({ ...publicStatus(now), paused: true }), now => ({ ...publicStatus(now), halt: { code: 'HALT' } }),
    now => ({ ...publicStatus(now), versions: { consistent: true, upgrade: { state: 'RUNNING' } } }),
    now => ({ ...publicStatus(now), executor: { reason: 'UPGRADE_DRAIN' } }), now => ({ ...publicStatus(now), versions: null })];
  for (const make of variants) {
    const h = await harness(t); h.status = () => make(h.now);
    assert.equal((await h.r.step()).skipped, 'NOT_ON_DUTY'); assert.equal(h.calls.length, 0);
  }
  assert.equal(reconcileDutyOf(publicStatus(T0), NODE, T0), null);
  const dualPause = { ...publicStatus(T0), intakePause: { holders: [{ holder: 'dual-active' }] } };
  assert.equal(reconcileDutyOf(dualPause, NODE, T0), 'INTAKE_HELD');
  assert.equal(reconcileDutyOf(dualPause, NODE, T0, 2), null);
});

test('duty changes while reading or the final pinned Source changes: zero POST', async t => {
  const h = await harness(t); let reads = 0;
  h.source = () => { reads++; if (reads === 2) h.status = () => ({ ...publicStatus(h.now), paused: true }); return sourceReply(); };
  assert.equal((await h.r.step()).skipped, 'NOT_ON_DUTY'); assert.equal(h.posts.length, 0);
  const n = await harness(t); let nr = 0;
  n.source = () => { nr++; return nr === 2 ? http(200, { ...JSON.parse(sourceReply().stdout.split('\r\n\r\n')[1]), content: Buffer.from('changed').toString('base64'), size: 7 }) : sourceReply(); };
  assert.equal((await n.r.step()).skipped, 'SOURCE_MISMATCH'); assert.equal(n.posts.length, 0);
});

test('missing or unaccepted Source never falls back to the old executor workflow', async t => {
  for (const source of [() => http(404), () => http(200, {}), () => ({ code: 1, stdout: '', timedOut: true })]) {
    const h = await harness(t, { source }); assert.equal((await h.r.step()).skipped, 'SOURCE_MISMATCH'); assert.equal(h.posts.length, 0);
    assert.ok(h.calls.every(a => !a.some(x => /clued-merge-executor\.yml/.test(x))));
  }
});

test('known dispatch rejection can retry, 429 honors Retry-After durably across restart', async t => {
  const h = await harness(t, { post: () => http(429, {}, 'Retry-After: 1200\r\n') });
  const first = await h.r.step(); assert.equal(first.skipped, 'RATE_LIMITED'); assert.equal(first.pending, false);
  assert.equal(first.retryAt, T0 + 20 * MIN); h.r = await h.open(); h.now += 19 * MIN;
  assert.equal((await h.r.step()).skipped, 'NOT_DUE'); assert.equal(h.posts.length, 1);
  h.now += MIN; h.post = () => http(204); assert.equal((await h.r.step()).dispatched, true); assert.equal(h.posts.length, 2);
  const n = await harness(t, { post: () => http(403, {}) }); assert.equal((await n.r.step()).skipped, 'DISPATCH_REFUSED');
  assert.equal(n.r.state.data.pending, null); assert.equal(n.r.state.data.dispatches.length, 1);
});

test('read 429 and unreadable runs preserve state and never POST', async t => {
  const h = await harness(t); h.readRuns = () => http(429, {}, 'Retry-After: 600\r\n');
  assert.equal((await h.r.step()).retryAt, T0 + 10 * MIN); assert.equal(h.posts.length, 0);
  const n = await harness(t); n.readRuns = () => http(200, { workflow_runs: [{ id: 'bad' }] });
  assert.equal((await n.r.step()).skipped, 'RUNS_UNREADABLE'); assert.equal(n.posts.length, 0);
});

test('Retry-After longer than one hour is not shortened by a local backoff cap', async t => {
  const h = await harness(t, { post: () => http(429, {}, 'Retry-After: 7200\r\n') });
  assert.equal((await h.r.step()).retryAt, T0 + 2 * HOUR);
  h.now += HOUR; h.r = await h.open(); assert.equal((await h.r.step()).skipped, 'NOT_DUE'); assert.equal(h.posts.length, 1);
});

test('recent or queued native controller run holds another wake-up, without trusting its result as green', async t => {
  for (const overrides of [{ status: 'queued' }, { created_at: new Date(T0 - MIN).toISOString(), conclusion: 'failure' }]) {
    const h = await harness(t); h.runs = [row(1, ID, T0 - HOUR, overrides)];
    assert.ok(['RUN_PENDING', 'RECENT_RUN'].includes((await h.r.step()).skipped)); assert.equal(h.posts.length, 0);
  }
});

test('corrupt/unknown-schema/wrong-node/wrong-pin state fails closed instead of resetting budgets', async t => {
  const h = await harness(t); await h.r.state.save(); const original = JSON.parse(await fs.readFile(h.file, 'utf8'));
  for (const value of ['{', JSON.stringify({ ...original, contract: 'new-schema' }), JSON.stringify({ ...original, nodeName: 'node-a' }),
    JSON.stringify({ ...original, sourceSha256: 'f'.repeat(64) }), JSON.stringify({ ...original, dispatches: [T0] })]) {
    await fs.writeFile(h.file, value); await assert.rejects(() => h.open()); assert.equal(h.posts.length, 0);
  }
});

test('clock rollback/future persisted timestamps do not erase or spend the ledger', async t => {
  const h = await harness(t); await h.r.step(); const saved = JSON.stringify(h.r.state.data);
  h.now -= 1; h.r = await h.open(); assert.equal((await h.r.step()).skipped, 'CLOCK_BACKWARD_OR_INVALID');
  assert.equal(JSON.stringify(h.r.state.data), saved); assert.equal(h.posts.length, 1);
});

test('hourly dispatch and read caps survive restart and include failed attempts', async t => {
  const h = await harness(t); const d = h.r.state.data;
  d.lastTickAt = T0; d.dispatches = Array(RECONCILE_MAX_DISPATCHES_PER_HOUR).fill(T0); await h.r.state.save();
  h.r = await h.open(); assert.equal((await h.r.step()).skipped, 'DISPATCH_BUDGET'); assert.equal(h.posts.length, 0);
  const n = await harness(t); n.r.state.data.lastTickAt = T0;
  n.r.state.data.reads = Array(RECONCILE_MAX_READS_PER_HOUR).fill(T0); await n.r.state.save(); n.r = await n.open();
  assert.equal((await n.r.step()).skipped, 'MERGE_RECONCILE_API_BUDGET'); assert.equal(n.calls.length, 0);
});

test('one companion lane cannot overlap steps and produce two dispatches', async t => {
  const h = await harness(t); let release; const gate = new Promise(r => { release = r; });
  h.source = async () => { await gate; return sourceReply(); };
  const first = h.r.step(); await Promise.resolve(); assert.equal((await h.r.step()).skipped, 'BUSY');
  release(); assert.equal((await first).dispatched, true); assert.equal(h.posts.length, 1);
});
