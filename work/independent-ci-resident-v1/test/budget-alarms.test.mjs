import test from 'node:test';
import assert from 'node:assert/strict';
import { executorFixture, SOURCE, HEAD, BASE, triggerBytes } from './helpers.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { describe, events, PrStatusReporter, LocalStore } from '../src/pr-status.mjs';
import { boundedNotice } from '../src/budget-alert.mjs';

const DAY = 86400000;
const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 };

test('every scheduling quota refusal carries scope, usage and the first rolling expiration through status to the PR and Owner', async t => {
  const f = await executorFixture(t);
  const old = { ...subject, pr: 1, headSha: '3'.repeat(40) };
  await f.ledger.reserve(batchKey(old), old);
  await f.ledger.markStarted(batchKey(old), {});
  f.exec.policy.limits.maxBatchesPer24h = 1;
  const u = await f.ledger.usage(f.clock() - DAY);
  const pre = await f.exec.precheck(batchKey(subject), headKey(subject), subject, { usage: u });
  assert.equal(pre.defer, 'DAILY_BATCH_LIMIT');
  assert.equal(pre.notice.budget.used, 1);
  assert.equal(pre.notice.budget.limit, 1);
  assert.equal(pre.notice.budget.scope, 'node');
  assert.equal(pre.notice.budget.resetsAt, f.clock() + DAY);
  await f.exec.deferral(pre, batchKey(subject), subject.pr);
  const board = new StatusBoard({ clock: f.clock });
  board.update({ notices: f.queue.notices, backfill: { complete: true } });
  board.setPending([{ pr: 884, headSha: HEAD, state: 'QUEUED' }]);
  const status = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  const text = describe({ pull: { pr: 884, headSha: HEAD, eligible: true }, status, now: f.clock() }).description;
  assert.match(text, /maxBatchesPer24h.*全节点.*1\/1/);
  assert.match(text, /2026-10-21T12:00:00/);
  const notes = events({ status, now: f.clock() });
  assert.equal(notes.filter(n => /1\/1/.test(n.body)).length, 1);
  assert.equal(pre.notice.key, (await f.exec.precheck(batchKey(subject), headKey(subject), subject, { usage: u })).notice.key);
  assert.doesNotMatch(describe({ pull: { pr: 900, headSha: '9'.repeat(40), eligible: true }, status, now: f.clock() }).description, /maxBatchesPer24h/);
  f.advance(DAY + 1);
  assert.doesNotMatch(describe({ pull: { pr: 884, headSha: HEAD, eligible: true }, status: { ...status, writtenAt: f.clock() }, now: f.clock() }).description, /1\/1/);
});

for (const [code, key, usageKey, origin, mapKey] of [
  ['DAILY_EVALUATION_LIMIT', 'maxEvaluationsPer24h', 'evaluations', 'queued'],
  ['WAITING_BUDGET_EXHAUSTED', 'waitingRetriesPer24h', 'waitingRetries', 'waiting-retry'],
  ['PR_DAILY_BATCH_LIMIT', 'perPrBatchesPer24h', 'startedByPr', 'queued', 884],
  ['REEVALUATION_CAP', 'reevaluationsPerPrHeadPer24h', 'reevaluations', 'new-trigger', `884:${HEAD}`],
  ['RELEASE_CAP_REACHED', 'releasesPerHeadPer24h', 'releasesByHead', 'queued', HEAD],
]) test(`quota ${code} has a detailed notice without changing the gate`, async t => {
  const f = await executorFixture(t);
  const u = await f.ledger.usage(0);
  if (mapKey !== undefined) u[usageKey].set(mapKey, f.exec.policy.limits[key]);
  else u[usageKey] = f.exec.policy.limits[key];
  const pre = await f.exec.precheck(batchKey(subject), headKey(subject), subject, { usage: u, origin });
  assert.equal(pre.defer ?? pre.stop, code);
  assert.equal(pre.notice.budget.policyKey, `limits.${key}`);
  assert.equal(pre.notice.budget.used, f.exec.policy.limits[key]);
});

test('queue depth refusal and stage-10 daily cap also notify without removing their checks', async t => {
  const f = await executorFixture(t);
  f.exec.policy.limits.queueDepth = 1;
  await f.drop(triggerBytes()); await f.drop(triggerBytes({ pr: 885, headSha: '4'.repeat(40) }));
  await f.exec.tick();
  assert.ok(f.queue.notices.some(n => n.code === 'QUEUE_DEPTH_EXCEEDED' && n.budget.used === 1 && n.budget.limit === 1));
  const notice = boundedNotice({ code: 'TRAIN_DAILY_LIMIT', used: 200, limit: 200, now: f.clock(), resetsAt: f.clock() + DAY, recovery: null });
  assert.match(events({ status: { pending: [], notices: [notice] }, now: f.clock() })[0].body, /maintenanceMaxPerDay.*200\/200/);
});

test('a failed budget notification enqueue is retried, successful enqueue is deduplicated', async () => {
  const store = new LocalStore('unused', () => 1);
  let fail = true, attempts = 0;
  const reporter = new PrStatusReporter({ store, clock: () => 1, node: 'fixture-node', notify: async () => { attempts++; if (fail) throw Error('offline'); } });
  const event = { key: 'notice:budget:test', title: '额度已满', body: '1/1' };
  assert.equal(await reporter.toast(event, 1), false);
  assert.equal(store.data.notified[event.key], undefined);
  fail = false;
  assert.equal(await reporter.toast(event, 1), true);
  assert.ok(store.data.notified[event.key]);
  assert.equal(attempts, 2);
});

test('a node execution quota does not mask a parked batch that may still retry stage 8', () => {
  const now = Date.parse('2026-11-18T01:00:00Z'), board = new StatusBoard({ clock: () => now });
  board.update({ backfill: { complete: true }, notices: [{ key: 'budget:full', kind: 'batch-limit', code: 'DAILY_BATCH_LIMIT', pr: null, headSha: null, at: now,
    budget: { policyKey: 'limits.maxBatchesPer24h', scope: 'node', used: 72, limit: 72, resetsAt: now + DAY } }] });
  board.setPending([{ pr: 884, headSha: HEAD, state: 'PARKED', deferred: 'RESIDENT_MERGE_QUEUE_NOT_JOINED', nextAt: now + 60_000 }]);
  const status = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  const text = describe({ pull: { pr: 884, headSha: HEAD, eligible: true }, status, now }).description;
  assert.match(text, /已测通/);
  assert.doesNotMatch(text, /maxBatchesPer24h/);
});

test('a shared head quota explains every PR on that head, while a different head keeps its own status', () => {
  const now = Date.parse('2026-11-18T01:00:00Z'), board = new StatusBoard({ clock: () => now });
  board.update({ backfill: { complete: true }, notices: [{ key: 'budget:head', kind: 'budget', code: 'RELEASE_CAP_REACHED', pr: 884, headSha: HEAD, at: now,
    budget: { policyKey: 'limits.releasesPerHeadPer24h', scope: 'head', used: 2, limit: 2, resetsAt: now + DAY } }] });
  board.setPending([{ pr: 885, headSha: HEAD, state: 'QUEUED' }, { pr: 886, headSha: '5'.repeat(40), state: 'QUEUED' }]);
  const status = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  assert.match(describe({ pull: { pr: 885, headSha: HEAD, eligible: true }, status, now }).description, /releasesPerHeadPer24h.*每 head.*2\/2/);
  assert.doesNotMatch(describe({ pull: { pr: 886, headSha: '5'.repeat(40), eligible: true }, status, now }).description, /releasesPerHeadPer24h/);
});
