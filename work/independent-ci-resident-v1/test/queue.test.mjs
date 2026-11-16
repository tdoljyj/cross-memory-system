// The executor's own run queue (resident quota redesign phase 2, step 1: design v0.5 §4.1-§4.5): arrival numbering,
// supersession, new triggers, back-off, the release cap, restore, compaction, and a file that cannot be read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RunQueue, RELEASE_BACKOFF_MS, WAITING_BACKOFF_MS, COMPACT_AFTER_MS, SUPERSEDED_MAX, validateQueue, NETWORK_BACKOFF_MS } from '../src/queue.mjs';
import { tempRoot } from './helpers.mjs';

const MIN = 60_000;
const H = n => String(n).repeat(40).slice(0, 40);
const B = 'b'.repeat(40);
const KEY = 'c'.repeat(64);
const OPTS = { depth: 100, cooldownMs: 10 * MIN };
const trig = (pr, n, o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr, headSha: H(n), baseSha: B, prUpdatedAt: null, ...o });

async function fresh(t, now = Date.parse('2026-10-22T12:00:00Z')) {
  const dir = path.join(await tempRoot(t), 'queue');
  let time = now;
  const q = await RunQueue.open(dir, () => time);
  return { q, dir, advance: ms => { time += ms; }, now: () => time };
}

test('arrival order is the executor\'s own; a never-seen commit replaces a waiting one, a seen one never replaces anything', async t => {
  const { q, now } = await fresh(t);
  assert.equal(q.offer(trig(7, 1), now(), OPTS).action, 'new');
  assert.equal(q.offer(trig(8, 2), now(), OPTS).action, 'new');
  assert.deepEqual(q.candidates(now()).map(c => [c.pr, c.origin]), [[7, 'queued'], [8, 'queued']]);
  // PR 7 gets a newer commit while it waits: replaced, unevaluated and unburned, at the arrival place of the new one
  assert.equal(q.offer(trig(7, 3), now(), OPTS).action, 'superseded');
  assert.deepEqual(q.row(7).superseded.map(c => c.headSha), [H(1)]);
  assert.deepEqual(q.candidates(now()).map(c => [c.pr, c.headSha]), [[8, H(2)], [7, H(3)]]);
  // the old commit proposed again (a companion restart, or a stale pass of the poller): it changes nothing
  assert.equal(q.offer(trig(7, 1), now(), OPTS).action, 'seen');
  assert.equal(q.row(7).current.headSha, H(3));
  // the current commit proposed again without a newer prUpdatedAt changes nothing either
  assert.equal(q.offer(trig(7, 3, { prUpdatedAt: '2026-10-22T11:00:00Z' }), now(), OPTS).action, 'seen');
  assert.equal(q.offer(trig(7, 3, { prUpdatedAt: '2026-10-22T10:00:00Z' }), now(), OPTS).action, 'seen');
  // at most 8 superseded commits are kept
  for (let i = 10; i < 30; i++) q.offer(trig(7, i), now(), OPTS);
  assert.equal(q.row(7).superseded.length, SUPERSEDED_MAX);
});

test('a running batch keeps running when its PR gets a newer commit; the newer one is next, the running one decides at its safe point', async t => {
  const { q, now } = await fresh(t);
  q.offer(trig(7, 1), now(), OPTS);
  q.begin(7, H(1), KEY, 'queued', now());
  assert.equal(q.offer(trig(7, 2), now(), OPTS).action, 'pending');
  assert.deepEqual([q.row(7).state, q.row(7).running.headSha, q.row(7).current.headSha], ['RUNNING', H(1), H(2)]);
  assert.deepEqual(q.candidates(now()), [], 'nothing of a running PR is a candidate');
  // a third commit replaces the second (which never ran) while the first still runs
  q.offer(trig(7, 3), now(), OPTS);
  assert.deepEqual(q.row(7).superseded.map(c => c.headSha), [H(2)]);
  // the live read disproves the newer commit: the running one is current again
  assert.equal(q.keepRunning(7, H(1), now()), true);
  assert.deepEqual([q.row(7).current.headSha, q.row(7).superseded.map(c => c.headSha)], [H(1), [H(3), H(2)]]);
  // the batch released (say, superseded before stage 1): the running commit goes back to the superseded list unburned
  q.offer(trig(7, 4), now(), OPTS);
  q.settle(7, H(1), { kind: 'released', reason: 'SUPERSEDED', klass: 'superseded' }, now());
  assert.deepEqual([q.row(7).state, q.row(7).running, q.row(7).current.headSha], ['QUEUED', null, H(4)]);
  assert.ok(q.row(7).superseded.some(c => c.headSha === H(1)));
});

test('waits back off 10, 20, 40, 80, 120, then every 120 minutes, or until ci_retry_after; a release backs off 10, 20, 40 and stops at the cap', async t => {
  const { q, now, advance } = await fresh(t);
  q.offer(trig(7, 1), now(), OPTS);
  const delays = [];
  for (let i = 0; i < 7; i++) {
    const c = q.candidates(Number.MAX_SAFE_INTEGER)[0];
    q.begin(7, H(1), KEY, c.origin, now());
    q.settle(7, H(1), { kind: 'released', klass: 'waiting', code: 'OWNER_REVIEW_REQUIRED' }, now());
    delays.push((q.row(7).nextAt - now()) / MIN);
    advance(q.row(7).nextAt - now());
  }
  assert.deepEqual(delays, [10, 20, 40, 80, 120, 120, 120]);
  assert.deepEqual(WAITING_BACKOFF_MS.map(ms => ms / MIN), [10, 20, 40, 80, 120]);
  assert.equal(q.candidates(now())[0].origin, 'waiting-retry');
  // Native's ci_retry_after decides the wait of TASK_CI_HEAD_CAP_REACHED (never sooner than 10 minutes)
  q.begin(7, H(1), KEY, 'waiting-retry', now());
  q.settle(7, H(1), { kind: 'released', klass: 'waiting', code: 'TASK_CI_HEAD_CAP_REACHED', ciRetryAfter: now() + 3 * 60 * MIN }, now());
  assert.equal(q.row(7).nextAt - now(), 3 * 60 * MIN);
  q.begin(7, H(1), KEY, 'waiting-retry', now());
  q.settle(7, H(1), { kind: 'released', klass: 'waiting', code: 'TASK_CI_HEAD_CAP_REACHED', ciRetryAfter: now() - 1 }, now());
  assert.equal(q.row(7).nextAt - now(), 10 * MIN);

  // a not-admitted release: 10, 20, then the third release in 24 hours stops the row (cap 2)
  q.offer(trig(8, 2), now(), OPTS);
  const release = n => { q.begin(8, H(2), KEY, q.candidates(Number.MAX_SAFE_INTEGER).find(c => c.pr === 8).origin, now()); return q.settle(8, H(2), { kind: 'released', klass: 'not-admitted', code: 'PATHS_OUTSIDE_WRITE_SET', releases24h: n, releaseCap: 2 }, now()); };
  assert.equal(release(1), null);
  assert.deepEqual([q.row(8).state, (q.row(8).nextAt - now()) / MIN], ['BACKOFF', 10]);
  advance(10 * MIN);
  assert.deepEqual(RELEASE_BACKOFF_MS.map(ms => ms / MIN), [10, 20, 40]);
  assert.equal(release(2), 'stopped', 'at most two releases in 24 hours');
  assert.deepEqual([q.row(8).state, q.row(8).stopKind, q.row(8).stopClass], ['STOPPED', 'release-cap', 'not-admitted']);
  // a released row goes to the tail
  q.offer(trig(9, 3), now(), OPTS);
  q.offer(trig(10, 4), now(), OPTS);
  q.begin(9, H(3), KEY, 'queued', now());
  q.settle(9, H(3), { kind: 'released', klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 1, releaseCap: 2 }, now());
  advance(10 * MIN);
  assert.deepEqual(q.candidates(now()).filter(c => [9, 10].includes(c.pr)).map(c => c.pr), [10, 9]);
});

test('G4: a persisted legacy claim BACKOFF uses the waiting budget after restart', async t => {
  const { q, now, advance, dir } = await fresh(t);
  q.offer(trig(7, 1), now(), OPTS);
  q.begin(7, H(1), KEY, 'queued', now());
  q.settle(7, H(1), { kind: 'released', klass: 'not-admitted', code: 'CLAIM_NOT_CURRENT' }, now());
  // The exact scheduling shape written by the previous resident generation.
  Object.assign(q.row(7), { state: 'BACKOFF', level: 0, levelKind: null });
  await q.save();
  const reopened = await RunQueue.open(dir, now);
  advance(10 * MIN);
  assert.equal(reopened.candidates(now())[0].origin, 'waiting-retry');
  assert.equal(reopened.claimChecks()[0].pr, 7);
  reopened.begin(7, H(1), KEY, 'waiting-retry', now());
  reopened.settle(7, H(1), { kind: 'released', klass: 'not-admitted', code: 'CLAIM_NOT_CURRENT' }, now());
  assert.deepEqual([reopened.row(7).state, reopened.row(7).levelKind], ['WAITING', 'waiting']);
});

test('a new trigger pokes a row that waits: due after the 10-minute cool-down; a stopped row (cap or burned) needs a new commit', async t => {
  const { q, now, advance } = await fresh(t);
  q.offer(trig(7, 1, { prUpdatedAt: '2026-10-22T11:00:00Z' }), now(), OPTS);
  q.begin(7, H(1), KEY, 'queued', now());
  q.settle(7, H(1), { kind: 'released', klass: 'waiting', code: 'OWNER_REVIEW_REQUIRED' }, now());
  advance(10 * MIN);
  q.begin(7, H(1), KEY, 'waiting-retry', now());
  q.settle(7, H(1), { kind: 'released', klass: 'waiting', code: 'OWNER_REVIEW_REQUIRED' }, now());
  assert.equal(q.row(7).nextAt - now(), 20 * MIN, 'its own next try');
  advance(3 * MIN);
  const r = q.offer(trig(7, 1, { prUpdatedAt: '2026-10-22T12:02:00Z' }), now(), OPTS);
  assert.deepEqual([r.action, r.dueAt - now()], ['new-trigger', 7 * MIN]);
  assert.deepEqual(q.candidates(now()), [], 'not before the cool-down');
  advance(7 * MIN);
  assert.deepEqual(q.candidates(now()).map(c => [c.pr, c.origin, c.poked]), [[7, 'new-trigger', true]]);
  // the same prUpdatedAt again is no new trigger; an Agent's own trigger (no prUpdatedAt) always is
  q.begin(7, H(1), KEY, 'new-trigger', now());
  q.settle(7, H(1), { kind: 'released', klass: 'waiting', code: 'OWNER_REVIEW_REQUIRED' }, now());
  assert.equal(q.offer(trig(7, 1, { prUpdatedAt: '2026-10-22T12:02:00Z' }), now(), OPTS).action, 'seen');
  assert.equal(q.offer(trig(7, 1), now(), OPTS).action, 'new-trigger');
  // a burned head is only ever run again by a new commit
  q.offer(trig(8, 2), now(), OPTS);
  q.begin(8, H(2), KEY, 'queued', now());
  q.settle(8, H(2), { kind: 'burned', klass: 'deterministic-pr', code: 'PROTECTED_CHANGE_NOT_UP_TO_DATE' }, now());
  assert.equal(q.offer(trig(8, 2), now(), OPTS).action, 'seen');
  assert.equal(q.offer(trig(8, 3), now(), OPTS).action, 'new');
  assert.equal(q.row(8).state, 'QUEUED');
});

test('restore after falsification: the head the live read saw, if it is one of the PR\'s superseded commits and not burned', async t => {
  const { q, now } = await fresh(t);
  q.offer(trig(7, 2), now(), OPTS);                 // the real newest head B arrives first (an Agent's trigger)
  q.offer(trig(7, 1), now(), OPTS);                 // then a stale pass proposes the never-seen older A: it replaces B
  assert.equal(q.row(7).current.headSha, H(1));
  q.begin(7, H(1), KEY, 'queued', now());
  q.settle(7, H(1), { kind: 'burned', klass: 'deterministic-pr', code: 'PR_NOT_OPEN_OR_CHANGED' }, now());
  assert.equal(q.restore(7, H(2), now(), { burned: true }), false, 'a burned head never comes back');
  assert.equal(q.restore(7, H(9), now(), { burned: false }), false, 'a head this PR never had: the poller proposes it');
  assert.equal(q.restore(7, H(2), now(), { burned: false }), true);
  assert.deepEqual([q.row(7).state, q.row(7).current.headSha, q.candidates(now())[0].origin], ['QUEUED', H(2), 'restored']);
  assert.equal(q.closePr(7, now()), true);
  assert.deepEqual([q.row(7).state, q.row(7).reason], ['DONE', 'PR_CLOSED']);
});

test('depth counts live rows only; done and stopped rows leave after 24 hours; the breaker lifts environment stops', async t => {
  const { q, now, advance } = await fresh(t);
  const small = { ...OPTS, depth: 2 };
  q.offer(trig(1, 1), now(), small);
  q.offer(trig(2, 2), now(), small);
  assert.deepEqual(q.offer(trig(3, 3), now(), small), { action: 'refused', code: 'QUEUE_DEPTH_EXCEEDED' });
  assert.equal(q.offer(trig(2, 4), now(), small).action, 'superseded', 'a new commit of a live row is no new row');
  q.begin(1, H(1), KEY, 'queued', now());
  q.settle(1, H(1), { kind: 'completed' }, now());
  assert.equal(q.offer(trig(3, 3), now(), small).action, 'new', 'a done row is not live');
  // the release cap stopped a row because of an environment fault: lifted when the breaker closes
  q.begin(3, H(3), KEY, 'queued', now());
  q.settle(3, H(3), { kind: 'released', klass: 'environment', code: 'BROKER_REQUEST_EXPIRED', releases24h: 3, releaseCap: 2 }, now());
  assert.equal(q.row(3).stopClass, 'environment');
  assert.deepEqual(q.liftEnvironmentStops(now()), [3]);
  assert.deepEqual([q.row(3).state, q.candidates(now()).some(c => c.pr === 3)], ['BACKOFF', true]);
  advance(COMPACT_AFTER_MS);
  assert.equal(q.compact(now()), 1);
  assert.equal(q.row(1), null);
});

test('the file is replaced whole; an unreadable one is renamed aside (never deleted) and the queue starts over with a new generation', async t => {
  const { q, dir, now } = await fresh(t);
  q.offer(trig(7, 1), now(), OPTS);
  await q.save();
  assert.deepEqual(await fs.readdir(dir), ['queue.json'], 'no temporary file left');
  const again = await RunQueue.open(dir, now);
  assert.deepEqual([again.generation, again.row(7).current.headSha, again.rebuilt], [q.generation, H(1), null]);
  await fs.writeFile(path.join(dir, 'queue.json'), '{"contract":"clued.independent-ci.resident-queue/1","rows":[{"pr":-1}]}');
  const rebuilt = await RunQueue.open(dir, now);
  assert.notEqual(rebuilt.generation, q.generation);
  assert.equal(rebuilt.data.rows.length, 0);
  assert.match(rebuilt.rebuilt.keptAs, /^queue\.unreadable-.*\.json$/);
  assert.ok((await fs.readdir(dir)).includes(rebuilt.rebuilt.keptAs));
  assert.throws(() => validateQueue({ ...q.data, rows: [{ ...q.row(7), state: 'RUNNING', running: null }] }), { code: 'QUEUE_FILE_INVALID' });
});

test('the status view: positions among the rows that may run now, an estimated start, the next try of a waiting row', async t => {
  const { q, now } = await fresh(t);
  q.offer(trig(7, 1), now(), OPTS);
  q.offer(trig(8, 2), now(), OPTS);
  q.begin(8, H(2), KEY, 'queued', now());
  q.settle(8, H(2), { kind: 'released', klass: 'waiting', code: 'OWNER_REVIEW_REQUIRED' }, now());
  q.offer(trig(9, 3), now(), OPTS);
  const v = q.view(now(), { etaBatchMs: 22 * MIN });
  assert.deepEqual(v.map(r => [r.pr, r.state, r.position]), [[7, 'QUEUED', 1], [9, 'QUEUED', 2], [8, 'WAITING', null]]);
  assert.equal(v[1].eta - now(), 22 * MIN);
  assert.equal(v[2].nextAt - now(), 10 * MIN);
  assert.equal(v[2].reason, 'OWNER_REVIEW_REQUIRED');
});

test('step 3c-2b: a train front commit carries S and its attempt, goes first, supersedes a waiting commit, never a running batch; it survives a reload', async t => {
  const { q, dir, now } = await fresh(t);
  q.offer(trig(7, 1), now(), OPTS);
  q.offer(trig(8, 2), now(), OPTS);
  const S = '9'.repeat(40);
  assert.deepEqual(q.offerFront({ pr: 8, headSha: H(3), baseSha: B, testSha: S, attempt: 1 }, now(), OPTS).action, 'front');
  const c = q.candidates(now());
  assert.deepEqual(c.map(x => [x.pr, x.testSha ?? null, x.frontAttempt ?? null]), [[8, S, 1], [7, null, null]], 'the front first');
  assert.deepEqual(q.row(8).superseded.map(s => s.headSha), [H(2)]);
  q.begin(8, H(3), KEY, 'queued', now());
  assert.equal(q.row(8).running.testSha, S);
  assert.equal(q.offerFront({ pr: 8, headSha: H(3), baseSha: B, testSha: S, attempt: 2 }, now(), OPTS).action, 'busy');
  for (const bad of [{ testSha: H(3) }, { attempt: 3 }, { testSha: 'x' }]) assert.throws(() => q.offerFront({ pr: 8, headSha: H(3), baseSha: B, testSha: S, attempt: 1, ...bad }, now(), OPTS), { code: 'QUEUE_FRONT_INVALID' });
  await q.save();
  const again = await RunQueue.open(dir, now);
  assert.equal(again.row(8).running.testSha, S);
  assert.throws(() => validateQueue({ ...again.data, rows: [{ ...again.data.rows.find(r => r.pr === 8), current: { ...again.row(8).current, frontAttempt: 5 } }] }), { code: 'QUEUE_FILE_INVALID' });
});

test('generation 10 (DESIGN 53.3): a network release backs off a flat 10 minutes towards its own cap; other releases keep their ladder and cap', async t => {
  const { q, now, advance } = await fresh(t);
  assert.deepEqual(NETWORK_BACKOFF_MS.map(ms => ms / MIN), [10]);
  q.offer(trig(5, 5), now(), OPTS);
  const settle = o => { q.begin(5, H(5), KEY, q.candidates(Number.MAX_SAFE_INTEGER).find(c => c.pr === 5).origin, now()); return q.settle(5, H(5), { kind: 'released', releaseCap: 2, ...o }, now()); };
  for (let n = 1; n < 6; n += 1) {
    // the head's own releases24h (already at the cap) do not stop a network release; only its own cap does
    assert.equal(settle({ klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 5, network: true, networkReleases24h: n, networkCap: 6 }), null, `release ${n}`);
    assert.deepEqual([q.row(5).state, q.row(5).stopKind, (q.row(5).nextAt - now()) / MIN, q.row(5).levelKind], ['BACKOFF', null, 10, 'network'], `release ${n}`);
    advance(10 * MIN);
  }
  assert.equal(settle({ klass: 'environment', code: 'BUNDLE_UNAVAILABLE', network: true, networkReleases24h: 6, networkCap: 6 }), 'stopped');
  assert.deepEqual([q.row(5).state, q.row(5).stopKind, q.row(5).stopClass], ['STOPPED', 'release-cap', 'environment'], 'an environment stop: lifted with the others');
  assert.deepEqual(q.liftEnvironmentStops(now()), [5]);
  // a release that is not the network (a deterministic bundle refusal) keeps the ladder and the head's cap
  advance(MIN);
  assert.equal(settle({ klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 1, network: false }), null);
  assert.deepEqual([(q.row(5).nextAt - now()) / MIN, q.row(5).levelKind], [10, 'release']);
  advance(10 * MIN);
  assert.equal(settle({ klass: 'environment', code: 'BUNDLE_UNAVAILABLE', releases24h: 2, network: false }), 'stopped');
  // the outside answers again: a network back-off is due now; other back-offs are not touched
  q.offer(trig(6, 6), now(), OPTS);
  q.begin(6, H(6), KEY, 'queued', now());
  q.settle(6, H(6), { kind: 'released', klass: 'environment', code: 'BUNDLE_UNAVAILABLE', network: true, networkReleases24h: 1, networkCap: 6, releaseCap: 2 }, now());
  q.offer(trig(7, 7), now(), OPTS);
  q.begin(7, H(7), KEY, 'queued', now());
  q.settle(7, H(7), { kind: 'released', klass: 'not-admitted', code: 'CLAIM_NOT_CURRENT', releases24h: 1, releaseCap: 2 }, now());
  assert.deepEqual(q.wakeNetworkRows(now()), [6]);
  assert.deepEqual([q.row(6).nextAt === now(), q.row(7).nextAt > now()], [true, true]);
  assert.deepEqual(q.wakeNetworkRows(now()), [], 'nothing twice');
});
