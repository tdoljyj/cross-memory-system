// The status snapshot (resident quota redesign v0.6 + §9, phase 1, item 7): replaced whole, writtenAt refreshed by a
// timer (not only when the content changes), and what the executor reports into it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUS_CONTRACT, StatusBoard, StatusFile, parseStatus, readStatus, startStatusTimer } from '../src/status.mjs';
import { HEAD, executorFixture, fakeEngine, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

test('status board: fixed shape, state since only moves on a change, outcomes newest first per head, bounded', () => {
  let now = Date.parse('2026-10-22T08:00:00Z');
  const b = new StatusBoard({ clock: () => now, pid: 7 });
  const s0 = b.snapshot();
  assert.deepEqual(Object.keys(s0).sort(), ['backfill', 'breaker', 'changedAt', 'contract', 'current', 'executor', 'halt', 'intakePause', 'limits', 'node', 'notices', 'paused', 'pending', 'pid', 'queue', 'recent', 'writtenAt']);
  assert.equal(s0.contract, STATUS_CONTRACT);
  now += 1000;
  assert.equal(b.setState('IDLE'), true);
  const since = b.content.executor.since;
  now += 1000;
  assert.equal(b.setState('IDLE'), false, 'same state, same since');
  assert.equal(b.content.executor.since, since);
  assert.equal(b.setState('DEFERRED', 'DAILY_BATCH_LIMIT'), true);
  assert.equal(b.content.executor.reason, 'DAILY_BATCH_LIMIT');
  assert.throws(() => b.setState('SOMETHING'), { code: 'STATUS_STATE_INVALID' });
  b.outcome({ pr: 1, headSha: HEAD, outcome: 'FAILED_CLEAN', code: 'STAGE_CHILD_REFUSED', klass: 'unmapped-stage-1', retry: 'new-commit' });
  b.outcome({ pr: 1, headSha: HEAD, outcome: 'COMPLETED' });
  assert.equal(b.content.recent.length, 1, 'one entry per (PR, head, attempt)');
  assert.equal(b.content.recent[0].outcome, 'COMPLETED');
  assert.equal(b.outcome({ pr: 1, headSha: 'not-a-sha', outcome: 'COMPLETED' }), false);
  for (let i = 0; i < 80; i++) b.outcome({ pr: 100 + i, headSha: HEAD, outcome: 'IGNORED', code: 'free text is dropped' });
  assert.equal(b.content.recent.length, 50);
  assert.equal(b.content.recent[0].code, null);
  b.setPending([{ pr: 3, headSha: HEAD, baseSha: HEAD, deferred: 'DAILY_BATCH_LIMIT' }, { pr: 4, headSha: HEAD, baseSha: HEAD }]);
  assert.deepEqual(b.content.pending.map(p => [p.pr, p.position, p.deferred]), [[3, 1, 'DAILY_BATCH_LIMIT'], [4, 2, null]]);
});

test('status file: replaced whole (no leftover temporary file); the companion parses it back', async t => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'state'));
  let now = Date.parse('2026-10-22T08:00:00Z');
  const b = new StatusBoard({ clock: () => now });
  const file = new StatusFile(path.join(root, 'state', 'status.json'));
  await file.write(b.snapshot());
  b.setState('RUNNING');
  b.setCurrent({ key: 'a'.repeat(64), pr: 884, headSha: HEAD, baseSha: HEAD, attempt: 1, stage: 3, phase: 'stage' });
  now += 5000;
  await file.write(b.snapshot());
  assert.deepEqual(await fs.readdir(path.join(root, 'state')), ['status.json']);
  const s = await readStatus(root);
  assert.equal(s.executor.state, 'RUNNING');
  assert.deepEqual([s.current.pr, s.current.stage], [884, 3]);
  assert.equal(s.writtenAt, now);
  assert.throws(() => parseStatus(Buffer.from(JSON.stringify({ ...b.snapshot(), contract: 'x' }))), { code: 'STATUS_REFUSED' });
  assert.throws(() => parseStatus(Buffer.from(JSON.stringify({ ...b.snapshot(), extra: 1 }))), { code: 'STATUS_REFUSED' });
});

test('the timer rewrites writtenAt even when nothing changed (a 45-minute stage is no stopped executor)', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-22T08:00:00Z');
  const b = new StatusBoard({ clock: () => now });
  b.setState('RUNNING');
  let fire = null;
  const timer = startStatusTimer({ board: b, file: new StatusFile(path.join(root, 'status.json')), intervalMs: 15_000, schedule: (fn, ms) => { fire = fn; return { ms }; }, cancel: () => { fire = null; } });
  await timer.flush();
  const first = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8'));
  now += 45 * 60_000;
  assert.equal(await fire(), true, 'the timer callback writes');
  const later = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8'));
  assert.equal(later.changedAt, first.changedAt, 'nothing changed');
  assert.equal(Date.parse(later.writtenAt) - Date.parse(first.writtenAt), 45 * 60_000, 'but writtenAt moved');
  timer.stop();
  assert.equal(fire, null);
  // a failing write never escapes the timer
  const broken = startStatusTimer({ board: b, file: { write: async () => { throw new Error('disk'); } }, schedule: () => ({}), cancel: () => {} });
  assert.equal(await broken.flush(), false);
});

test('the executor reports its batch in flight, recent outcomes, pending triggers, limits and HALT into the board', async t => {
  let now = Date.parse('2026-10-20T12:00:00Z');
  const status = new StatusBoard({ clock: () => now });
  const seen = [];
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => { seen.push([stage.number, status.content.current?.stage, status.content.current?.pr]); return base(batch, stage, o); };
  const f = await executorFixture(t, { engine, status, policy: rawPolicy({ limits: { ...rawPolicy().limits, maxBatchesPer24h: 1 } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(seen.map(([n, s, pr]) => [n === s, pr]), seen.map(() => [true, 884]), 'the board names the stage that runs');
  assert.equal(status.content.current, null);
  assert.deepEqual([status.content.recent[0].pr, status.content.recent[0].outcome], [884, 'COMPLETED']);
  assert.equal(status.content.backfill.complete, true);
  assert.equal(status.content.executor.state, 'COMPLETED');
  // the same head in another PR is ignored, and shows so (its own PR's row has already seen it)
  await f.drop(triggerBytes({ pr: 885 }));
  const ignored = await f.exec.tick();
  assert.equal(ignored.reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY', JSON.stringify(ignored));
  assert.deepEqual([status.content.recent[0].pr, status.content.recent[0].outcome, status.content.recent[0].code], [885, 'IGNORED', 'HEAD_ALREADY_EXECUTED_NO_RETRY']);
  // the next head waits for the daily limit: pending, with its reason
  await f.drop(triggerBytes({ pr: 900, headSha: '4'.repeat(40) }));
  assert.equal((await f.exec.tick()).reason, 'DAILY_BATCH_LIMIT');
  assert.deepEqual(status.content.pending.filter(p => p.state === 'QUEUED').map(p => [p.pr, p.position]), [[900, 1]]);
  assert.equal(status.content.queue.generation, f.queue.generation);
  assert.deepEqual([status.content.limits.batches24h, status.content.limits.maxBatches], [1, 1]);
  assert.deepEqual([status.content.executor.state, status.content.executor.reason], ['DEFERRED', 'DAILY_BATCH_LIMIT']);
  // a HALT shows with its code
  await f.ledger.halt('ROLE_ALREADY_PUBLISHED_ON_HEAD', {});
  await f.exec.tick();
  assert.deepEqual([status.content.executor.state, status.content.halt.code], ['HALTED', 'ROLE_ALREADY_PUBLISHED_ON_HEAD']);
});
