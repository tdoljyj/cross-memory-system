import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor } from '../src/executor.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { TRAIN_DEFAULTS } from '../src/policy.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, notAdmitted, rawPolicy, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const subject = (pr = 884, headSha = HEAD) => ({ repo: 'tdoljyj/cross-memory-system', pr, headSha, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);

test('two stage-1 admission refusals do not cap a new PR on the same head, including after restart', async t => {
  const stages = { 1: notAdmitted() };
  const f = await executorFixture(t, { engine: fakeEngine({ stages }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  f.advance(10 * MIN + 1);
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  assert.deepEqual(stagesRun(f.engine), [1, 1], 'no execution stage ran');
  f.queue.closePr(884, f.clock());
  delete stages[1];
  const exec = new ResidentExecutor(f.ports);
  await f.drop(triggerBytes({ pr: 885 }));
  const result = await exec.tick();
  assert.equal(result.state, 'COMPLETED', JSON.stringify(result));
  const usage = await f.ledger.usage(0);
  assert.equal(usage.releasesByHead.get(HEAD) ?? 0, 0);
  assert.deepEqual([usage.evaluations, usage.started], [2, 1], 'refusals still spend the evaluation budget');
});

test('stage-1 admission refusals stay in backoff and retry without a new head or trigger', async t => {
  const stages = { 1: notAdmitted() };
  const f = await executorFixture(t, { engine: fakeEngine({ stages }) });
  await f.drop(triggerBytes());
  await f.exec.tick();
  f.advance(10 * MIN + 1);
  await f.exec.tick();
  assert.equal(f.queue.row(884).state, 'BACKOFF');
  delete stages[1];
  f.advance(20 * MIN + 1);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('stage-1 network admission refusals spend neither release cap under a network policy', async t => {
  const p = rawPolicy();
  const stages = { 1: notAdmitted('GITHUB_TRANSIENT_UNAVAILABLE', {
    status: 'BLOCKED', reason: 'github_http_503', sideEffects: 0, mayHavePublished: false, safeToRerun: true,
  }) };
  const f = await executorFixture(t, { engine: fakeEngine({ stages }), policy: rawPolicy({ contract: 'clued.independent-ci.resident-policy/9',
    breaker: { ...p.breaker, network: { trialDelayMs: 10 * MIN, earlyTrialProbes: 2, releasesPerHeadPer24h: 2 } },
    train: { ...p.train, ...TRAIN_DEFAULTS },
  }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  f.advance(10 * MIN + 1);
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  const usage = await f.ledger.usage(0, { separateNetwork: true });
  assert.deepEqual([usage.releasesByHead.get(HEAD) ?? 0, usage.networkReleasesByHead.get(HEAD) ?? 0], [0, 0]);
  assert.equal(f.queue.row(884).state, 'BACKOFF');
  delete stages[1];
  f.advance(20 * MIN + 1);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('a stage-2 execution still burns its head and spends the daily execution budget', async t => {
  const p = rawPolicy();
  const f = await executorFixture(t, { policy: rawPolicy({ limits: { ...p.limits, maxBatchesPer24h: 1 } }),
    engine: fakeEngine({ stages: { 2: { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN } } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
  assert.deepEqual(stagesRun(f.engine), [1, 2]);
  assert.equal((await f.ledger.usage(0)).started, 1);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
  await f.drop(triggerBytes({ pr: 885 }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
  const next = subject(886, '3'.repeat(40));
  const pre = await f.exec.precheck(batchKey(next), headKey(next), next, { usage: await f.ledger.usage(0) });
  assert.equal(pre.defer, 'DAILY_BATCH_LIMIT');
});

test('unknown or missing archived release reasons do not gain the admission exemption', async t => {
  const f = await executorFixture(t);
  for (const reason of ['UNRECOGNIZED_RELEASE', null]) {
    const s = subject(), key = batchKey(s);
    await f.ledger.reserve(key, s);
    const archived = await f.ledger.releaseUnexecuted(key, 'NOT_ADMITTED', { network: true });
    const file = path.join(archived, '90-terminal.json');
    const terminal = JSON.parse(await fs.readFile(file, 'utf8'));
    if (reason === null) delete terminal.reason;
    else terminal.reason = reason;
    await fs.writeFile(file, JSON.stringify(terminal));
  }
  assert.equal((await f.ledger.usage(0)).releasesByHead.get(HEAD), 2);
  const separate = await f.ledger.usage(0, { separateNetwork: true });
  assert.deepEqual([separate.releasesByHead.get(HEAD), separate.networkReleasesByHead.get(HEAD)], [undefined, 2]);
});
