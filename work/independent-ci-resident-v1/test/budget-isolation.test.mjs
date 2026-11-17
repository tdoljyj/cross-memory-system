import test from 'node:test';
import assert from 'node:assert/strict';
import { executorFixture, rawPolicy, SOURCE, HEAD, BASE } from './helpers.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { TRAIN_DEFAULTS } from '../src/policy.mjs';

const s = (overrides = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 1, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...overrides });
const check = async (f, subj, origin = 'queued') => f.exec.precheck(batchKey(subj), headKey(subj), subj,
  { origin, usage: await f.ledger.usage(0, { separateNetwork: !!f.exec.policy.breaker.network }) });

// scope-isolation: limits.perPrBatchesPer24h
test('another PR exhausting its execution limit leaves this PR runnable', async t => {
  const f = await executorFixture(t, { policy: rawPolicy({ limits: { ...rawPolicy().limits, perPrBatchesPer24h: 1 } }) });
  await f.ledger.reserve(batchKey(s()), s()); await f.ledger.markStarted(batchKey(s()), {});
  assert.equal((await check(f, s({ headSha: '3'.repeat(40) }))).defer, 'PR_DAILY_BATCH_LIMIT');
  assert.deepEqual(await check(f, s({ pr: 2, headSha: '4'.repeat(40) })), {});
});

// scope-isolation: limits.reevaluationsPerPrHeadPer24h
test('a full PR commit reevaluation budget leaves a different PR or head runnable', async t => {
  const f = await executorFixture(t, { policy: rawPolicy({ limits: { ...rawPolicy().limits, reevaluationsPerPrHeadPer24h: 1 } }) });
  await f.ledger.reserve(batchKey(s()), s(), { origin: 'new-trigger' });
  await f.ledger.releaseUnexecuted(batchKey(s()), 'SUPERSEDED', { class: 'superseded' });
  assert.equal((await check(f, s({ baseSha: '5'.repeat(40) }), 'new-trigger')).defer, 'REEVALUATION_CAP');
  assert.deepEqual(await check(f, s({ pr: 2 }), 'new-trigger'), {});
  assert.deepEqual(await check(f, s({ headSha: '4'.repeat(40) }), 'new-trigger'), {});
});

// scope-isolation: limits.releasesPerHeadPer24h
test('another head exhausting its release budget leaves this head runnable', async t => {
  const f = await executorFixture(t, { policy: rawPolicy({ limits: { ...rawPolicy().limits, releasesPerHeadPer24h: 1 } }) });
  await f.ledger.reserve(batchKey(s()), s());
  await f.ledger.releaseUnexecuted(batchKey(s()), 'BUNDLE_UNAVAILABLE', { class: 'environment', breakerState: 'closed' });
  f.advance(600001);
  assert.equal((await check(f, s({ baseSha: '5'.repeat(40) }))).stop, 'RELEASE_CAP_REACHED');
  assert.deepEqual(await check(f, s({ headSha: '4'.repeat(40) })), {});
});

// scope-isolation: breaker.network.releasesPerHeadPer24h
test('another head exhausting its network release budget leaves this head runnable', async t => {
  const p = rawPolicy(); p.contract = 'clued.independent-ci.resident-policy/9';
  p.train = { ...p.train, ...TRAIN_DEFAULTS };
  p.breaker.network = { trialDelayMs: 60000, earlyTrialProbes: 1, releasesPerHeadPer24h: 1 };
  const f = await executorFixture(t, { policy: p });
  await f.ledger.reserve(batchKey(s()), s());
  await f.ledger.releaseUnexecuted(batchKey(s()), 'BUNDLE_UNAVAILABLE', { class: 'environment', breakerState: 'closed', network: true });
  f.advance(600001);
  const refused = await check(f, s({ baseSha: '5'.repeat(40) }));
  assert.equal(refused.stop, 'NETWORK_RELEASE_CAP_REACHED');
  assert.equal(refused.notice.budget.policyKey, 'breaker.network.releasesPerHeadPer24h');
  assert.deepEqual(await check(f, s({ headSha: '4'.repeat(40) })), {});
});
