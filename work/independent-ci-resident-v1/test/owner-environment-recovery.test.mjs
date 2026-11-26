import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { batchKey, headKey } from '../src/ledger.mjs';
import { closedBreaker } from '../src/breaker.mjs';
import { breakerReleaseRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const OWNER = 'S-1-5-21-1-2-3-1001';
const DAY = 86_400_000;
const subject = (pr = 884, extra = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr, headSha: HEAD, baseSha: BASE,
  sourceManifestSha256: SOURCE, attempt: 1, ...extra });
const stop = (f, s = subject(), klass = 'environment') => {
  f.queue.breaker ??= closedBreaker();
  f.queue.offer(s, f.clock(), { depth: 100, cooldownMs: 600_000 });
  f.queue.stopAtCap(s.pr, s.headSha, 'NATIVE_ADMISSION_UNAVAILABLE', f.clock(), klass);
  return f.queue.row(s.pr);
};
const receipts = async (f, type) => {
  const dir = path.join(f.root, 'state', 'receipts');
  const names = (await fs.readdir(dir)).filter(n => n.endsWith(`-${type}.json`)).sort();
  return Promise.all(names.map(async n => JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')).body));
};
const request = f => breakerReleaseRequest({ reason: 'Native environment repaired and checked', by: OWNER }, f.clock);

test('two real broker-no-launch releases stop with an absent active ledger; Owner recovery permits one normal run and no replay', async t => {
  let repaired = false, stage1 = 0;
  const engine = fakeEngine(), run = engine.runStage;
  engine.runStage = async (batch, stage, opts) => {
    if (stage.number === 1) {
      stage1++;
      if (!repaired) return { ok: false, code: 'BROKER_REQUEST_EXPIRED', proof: WINDOWS_CLEAN, brokerNoLaunch: true, outcome: null };
    }
    return run(batch, stage, opts);
  };
  const f = await executorFixture(t, { engine });
  const key = batchKey(subject());
  await f.drop(triggerBytes());
  await f.exec.tick();
  f.advance(600_000);
  await f.exec.tick();
  assert.equal(stage1, 2);
  assert.deepEqual([f.queue.breaker.state, f.queue.row(884).state, f.queue.row(884).stopKind, f.queue.row(884).stopClass],
    ['closed', 'STOPPED', 'release-cap', 'environment']);
  assert.equal((await f.ledger.state(key)).state, 'ABSENT');
  assert.equal((await f.ledger.unexecutedRecords(key, 0)).length, 2, 'both original releases remain archived');
  assert.equal(await f.executedHeads.published(subject()), false);
  const before = structuredClone(f.queue.breaker);
  const req = request(f);
  await writeOwnerRequest(path.join(f.root, 'owner'), req, f.clock);
  await f.exec.takeOwnerRequests();
  assert.deepEqual(f.queue.breaker, before, 'no breaker cycle, history or counters reset');
  const [receipt] = await receipts(f, 'owner-request');
  assert.deepEqual([receipt.kind, receipt.mode, receipt.reason, receipt.by, receipt.lifted, receipt.woke, receipt.skipped, receipt.nextTrialAt],
    ['breaker-release', 'closed-environment-recovery', req.reason, OWNER, [884], [], [], null]);
  assert.equal(stage1, 2, 'the request only changes scheduling, without running stage 1');
  repaired = true;
  // Recovery still observes the original cool-down, then runs through the ordinary executor.
  await f.exec.tick();
  assert.equal(stage1, 2);
  f.advance(600_000);
  await f.exec.tick();
  assert.equal(stage1, 3);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
  assert.equal((await f.ledger.unexecutedRecords(key, 0)).length, 2);
  await writeOwnerRequest(path.join(f.root, 'owner'), req, f.clock);
  await f.exec.tick();
  assert.equal(stage1, 3, 'replayed request cannot execute the head again');
  assert.equal((await receipts(f, 'owner-request')).length, 1);
  assert.equal((await receipts(f, 'owner-request-duplicate')).length, 1);
});

test('closed recovery skips burned, published across Sources, and existing ledger entries; other stops and network waits stay unchanged', async t => {
  const f = await executorFixture(t);
  const subjects = Array.from({ length: 7 }, (_, i) => subject(i + 1, { headSha: String(i + 3).repeat(40) }));
  for (const s of subjects) stop(f, s);
  const [burned, published, reserved, unknown, eligible, deterministic, waiting] = subjects;
  await f.ledger.reserve(batchKey(burned), burned);
  await f.ledger.burnHead(batchKey(burned), { failureCode: 'TEST_BURNED' });
  await f.executedHeads.record({ ...published, sourceManifestSha256: 'c'.repeat(64) },
    { key: batchKey(published), origin: 'publication', basis: 'before-stage-3', stage: 3 });
  await f.ledger.reserve(batchKey(reserved), reserved);
  await fs.mkdir(f.ledger.dir(batchKey(unknown)));
  f.queue.row(deterministic.pr).stopClass = 'not-admitted';
  const networkRow = f.queue.row(waiting.pr);
  Object.assign(networkRow, { state: 'BACKOFF', stopKind: null, stopClass: null, levelKind: 'network', nextAt: f.clock() + DAY });
  const unchanged = structuredClone([f.queue.row(deterministic.pr), networkRow]);
  const out = await f.exec.releaseBreaker(request(f));
  assert.deepEqual(out.lifted, [eligible.pr]);
  assert.deepEqual(out.skipped.map(s => s.code), ['HEAD_ALREADY_EXECUTED_NO_RETRY', 'HEAD_ALREADY_PUBLISHED_NO_RETRY',
    'CONTENT_ALREADY_EXECUTED_NO_RETRY', 'CONTENT_ALREADY_EXECUTED_NO_RETRY']);
  assert.deepEqual([f.queue.row(deterministic.pr), networkRow], unchanged);
  assert.equal((await f.ledger.state(batchKey(reserved))).state, 'RESERVED');
});

test('an unavailable authoritative read refuses the Owner request before any row is lifted', async t => {
  const f = await executorFixture(t);
  stop(f);
  stop(f, subject(885, { headSha: '3'.repeat(40) }));
  const before = structuredClone(f.queue.data);
  const state = f.ledger.state.bind(f.ledger);
  let reads = 0;
  f.ledger.state = async key => { if (++reads === 2) throw Object.assign(new Error('busy'), { code: 'EACCES' }); return state(key); };
  await writeOwnerRequest(path.join(f.root, 'owner'), request(f), f.clock);
  await f.exec.takeOwnerRequests();
  assert.deepEqual(f.queue.data, before);
  assert.equal((await receipts(f, 'owner-request-refused')).length, 1);
});

test('when every environment stop is blocked, recovery records why and changes neither rows nor breaker', async t => {
  const f = await executorFixture(t);
  const burned = subject(), published = subject(885, { headSha: '3'.repeat(40) }), reserved = subject(886, { headSha: '4'.repeat(40) });
  for (const s of [burned, published, reserved]) stop(f, s);
  await f.ledger.reserve(batchKey(burned), burned);
  await f.ledger.burnHead(batchKey(burned), { failureCode: 'TEST_BURNED' });
  await f.executedHeads.record(published, { key: batchKey(published), origin: 'publication', basis: 'before-stage-3', stage: 3 });
  await f.ledger.reserve(batchKey(reserved), reserved);
  const before = structuredClone(f.queue.data);
  const out = await f.exec.releaseBreaker(request(f));
  assert.deepEqual(out.lifted, []);
  assert.equal(out.skipped.length, 3);
  assert.deepEqual(f.queue.data, before);
});

test('closed with no eligible stops and half-open still refuse; a subject changed during reads is not lifted', async t => {
  const f = await executorFixture(t);
  stop(f, subject(), 'not-admitted');
  await assert.rejects(f.exec.releaseBreaker(request(f)), { code: 'BREAKER_NOT_OPEN' });
  f.queue.row(884).stopClass = 'environment';
  f.queue.breaker.state = 'half-open';
  await assert.rejects(f.exec.releaseBreaker(request(f)), { code: 'BREAKER_NOT_OPEN' });
  f.queue.breaker.state = 'closed';
  const published = f.executedHeads.published.bind(f.executedHeads);
  f.executedHeads.published = async s => {
    const result = await published(s);
    // a front commit always carries its front number with S (queue.mjs#commitOk; R3 batch 2 rowSubject reads it)
    Object.assign(f.queue.row(s.pr).current, { testSha: '5'.repeat(40), frontAttempt: 1 });
    return result;
  };
  const out = await f.exec.releaseBreaker(request(f));
  assert.deepEqual(out.lifted, []);
  assert.equal(f.queue.row(884).state, 'STOPPED');
});

test('a lifted row still observes the ledger daily budgets', async t => {
  const f = await executorFixture(t);
  const s = subject(), key = batchKey(s), hk = headKey(s);
  stop(f);
  await f.exec.releaseBreaker(request(f));
  const candidate = f.queue.candidates(f.clock())[0];
  assert.equal(candidate.origin, 'lifted');
  const usage = await f.ledger.usage(f.clock() - DAY);
  usage.started = f.exec.policy.limits.maxBatchesPer24h;
  assert.equal((await f.exec.precheck(key, hk, s, { usage, origin: candidate.origin })).defer, 'DAILY_BATCH_LIMIT');
  usage.started = 0;
  usage.evaluations = f.exec.policy.limits.maxEvaluationsPer24h;
  assert.equal((await f.exec.precheck(key, hk, s, { usage, origin: candidate.origin })).defer, 'DAILY_EVALUATION_LIMIT');
});
