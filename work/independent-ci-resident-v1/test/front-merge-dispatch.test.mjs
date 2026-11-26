// DESIGN §80: the node on duty asks for the train front's main merge when stage 10 says FRONT_NEEDS_MAIN_MERGE: once per (pr, head,
// main), again after RETRY_MS while it still says so, at most MAX_TRIES times; never from a standby node or a stale summary. A fake gh
// stands in; nothing here runs a workflow. The summary goes through the real status reader's parser (train.mjs#parseTrainLast).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FRONT_MERGE_REPO, FRONT_MERGE_WORKFLOW, FrontMergeDispatchState, FrontMergeDispatcher, MAX_TRIES, RETRY_MS, SUMMARY_FRESH_MS,
  frontMergeArgv, wantedFrontMerge } from '../src/front-merge-dispatch.mjs';
import { parseTrainLast } from '../src/train.mjs';
import { tempRoot } from './helpers.mjs';

const MIN = 60_000, T0 = Date.parse('2026-11-16T02:00:00Z');
const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const H = 'a'.repeat(40), M = '7'.repeat(40);
// The summary as stage 10 leaves it in status.json, read back by the status reader's own parser.
const last = (o = {}, at = T0) => parseTrainLast({ at: new Date(at).toISOString(), mode: 'on', wouldDo: 'FRONT_NEEDS_MAIN_MERGE', decision: 'FRONT_NEEDS_MAIN_MERGE',
  onDuty: true, front: { pr: 1125, headSha: H }, mainSha: M, strict: true, ...o });
const status = (o = {}, now = T0) => ({ writtenAt: now - 10_000, intakePause: null, node: { name: 'node-a', mode: 'ACTIVE' }, train: { enabled: 'on', last: last() }, ...o });

async function lane(t, st, { code = 0 } = {}) {
  const g = { now: T0, calls: [] };
  const d = new FrontMergeDispatcher({ nodeName: 'node-a', repo: FRONT_MERGE_REPO, ghExe: GH, clock: () => g.now,
    run: async argv => { g.calls.push(argv); return { code, stdout: '', stderr: code ? 'gh: (HTTP 422)' : '' }; },
    readStatus: async () => (typeof st === 'function' ? st(g.now) : st), state: await FrontMergeDispatchState.open(path.join(await tempRoot(t), 'front.json')) });
  return { g, d };
}

test('the summary parser keeps what the lane reads, and the argv is the one fixed dispatch of the one workflow', () => {
  assert.deepEqual(wantedFrontMerge(status(), 'node-a', T0), { pr: 1125, head: H, main: M });
  assert.deepEqual(frontMergeArgv(GH, FRONT_MERGE_REPO, { pr: 1125, head: H }), [GH, 'api', '--method', 'POST',
    `repos/${FRONT_MERGE_REPO}/actions/workflows/${FRONT_MERGE_WORKFLOW}/dispatches`, '-f', 'ref=main', '-f', 'inputs[pr]=1125', '-f', `inputs[head]=${H}`]);
  assert.throws(() => frontMergeArgv(GH, 'other/repo', { pr: 1125, head: H }));
  assert.throws(() => frontMergeArgv(GH, FRONT_MERGE_REPO, { pr: 1125, head: 'x' }));
});

test('only the node on duty, only for a fresh FRONT_NEEDS_MAIN_MERGE of mode on', () => {
  for (const [name, st] of [
    ['standby', status({ node: { name: 'node-a', mode: 'STANDBY' } })],
    ['another node', status({ node: { name: 'node-b', mode: 'ACTIVE' } })],
    ['stale status', status({ writtenAt: T0 - 60 * MIN })],
    ['stale summary', status({ train: { enabled: 'on', last: last({}, T0 - SUMMARY_FRESH_MS - 1) } })],
    ['shadow', status({ train: { enabled: 'shadow', last: last({ mode: 'shadow' }) } })],
    ['other decision', status({ train: { enabled: 'on', last: last({ decision: 'OPEN_FRONT_BATCH', wouldDo: 'OPEN_FRONT_BATCH' }) } })],
    ['no front', status({ train: { enabled: 'on', last: last({ front: null }) } })],
    ['no summary', status({ train: { enabled: 'on', last: null } })],
  ]) assert.equal(wantedFrontMerge(st, 'node-a', T0), null, name);
});

test('片 5 审查 6：协议 1 仅暂停接新时仍续办既有车头，PAUSE 和 HALT 各自阻断', async t => {
  const until = new Date(T0 + MIN).toISOString();
  const intakePause = { until, holders: [{ holder: 'owner', since: new Date(T0).toISOString(), until }] };
  for (const latch of [{ paused: true }, { halt: { code: 'RECOVERY_UNCONFIRMED' } }]) {
    const { g, d } = await lane(t, status({ intakePause, ...latch }));
    assert.equal((await d.step()).dispatched, false);
    assert.equal(g.calls.length, 0);
  }
  const { g, d } = await lane(t, status({ intakePause }));
  d.trainProtocolVersion = 1;
  assert.equal((await d.step()).dispatched, true);
  assert.equal(g.calls.length, 1);
});

test('once per front head and main, again after RETRY_MS while it still says so, at most MAX_TRIES times; a new head asks at once', async t => {
  let summary = last();
  const { g, d } = await lane(t, now => status({ train: { enabled: 'on', last: { ...summary, at: now } } }, now));
  assert.equal((await d.step()).dispatched, true);
  g.now += MIN; assert.equal((await d.step()).dispatched, false, 'not again within RETRY_MS');
  for (let i = 1; i < MAX_TRIES; i++) { g.now += RETRY_MS; assert.equal((await d.step()).dispatched, true, `try ${i + 1}`); }
  g.now += RETRY_MS; assert.equal((await d.step()).dispatched, false, 'tries used up (a conflict the holder must resolve)');
  assert.equal(g.calls.length, MAX_TRIES);
  summary = { ...summary, mainSha: '8'.repeat(40) };
  assert.equal((await d.step()).dispatched, true, 'main moved: a new request');
  // A restart keeps the memory: no doubled dispatch.
  const again = new FrontMergeDispatcher({ ...d, state: await FrontMergeDispatchState.open(d.state.file) });
  assert.equal((await again.step()).dispatched, false);
  assert.equal(g.calls.length, MAX_TRIES + 1);
});

test('a refused dispatch counts as a try and is asked again only after RETRY_MS', async t => {
  const { g, d } = await lane(t, now => status({ train: { enabled: 'on', last: last({}, now) } }, now), { code: 1 });
  assert.equal((await d.step()).dispatched, false);
  g.now += MIN; await d.step(); assert.equal(g.calls.length, 1);
  g.now += RETRY_MS; await d.step(); assert.equal(g.calls.length, 2);
});
