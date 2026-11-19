// FABLE-ci-10min-20261119 §3.2 P1c (T2): an ordinary batch runs its stage 1 (the admission check, the hosted jobs' gate) before its
// bundle, so the check is out a bundle's time earlier (45-105 s in the field; #1172: 104 s). The bundle still comes before the head is
// burned: a bundle failure releases the reservation as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executorFixture, fakeEngine, notAdmitted, triggerBytes } from './helpers.mjs';

const BUNDLE_MS = 90_000;
// The companion's bundle, slowed to BUNDLE_MS of the fixture clock; what the receipts said when it started and when it ended.
function slowBundle(f, answer = { ok: true }) {
  const seen = [];
  f.companion.buildBundle = async () => {
    f.companion.calls.push(['bundle']);
    const startedAt = f.clock();
    f.advance(BUNDLE_MS);
    seen.push({ startedAt, endedAt: f.clock(), stage1: (await f.receipts.latest(['stage-terminal'], 50)).map(e => e.value).filter(v => v.body.stage === 1) });
    return answer;
  };
  return seen;
}

test('P1c: a bundle the stand-in drags out 90 s: stage 1\'s receipt is written before the bundle ends (before the fix: after it)', async t => {
  const f = await executorFixture(t);
  const seen = slowBundle(f);
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.equal(seen.length, 1, 'one bundle');
  const [b] = seen;
  assert.equal(b.stage1.length, 1, 'stage 1 had ended when the bundle started');
  assert.equal(b.stage1[0].body.ok, true);
  assert.ok(Date.parse(b.stage1[0].at) <= b.startedAt && b.startedAt + BUNDLE_MS === b.endedAt,
    `stage 1 receipt at ${b.stage1[0].at}, bundle ${new Date(b.startedAt).toISOString()}..${new Date(b.endedAt).toISOString()}`);
  const stages = f.engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
  assert.deepEqual(stages, [1, 2, 3, 4, 5, 6, 7, 8], 'the rest of the batch as before');
});

test('P1c: a bundle that fails after stage 1 releases the reservation (not executed, the head not burned), as a bundle failure did before', async t => {
  const f = await executorFixture(t);
  const seen = slowBundle(f, { ok: false });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(seen.length, 1);
  assert.deepEqual([r.state, r.failureCode], ['NOT_EXECUTED', 'BUNDLE_UNAVAILABLE']);
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'stage').map(c => c[1]), [1], 'stage 1 ran, nothing after it');
  assert.equal((await f.receipts.latest(['batch-started'], 10)).length, 0, 'the head was never burned');
  assert.equal((await f.receipts.latest(['batch-unexecuted'], 10)).length, 1);
});

test('P1c: stage 1 not admitted: no bundle is built for nothing', async t => {
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 1: notAdmitted() } }) });
  const seen = slowBundle(f);
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'NOT_ADMITTED');
  assert.equal(seen.length, 0, 'the refusal came before any bundle');
});
