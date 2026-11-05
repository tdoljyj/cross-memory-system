// DESIGN 51 (C): a scanner publisher stage (3, 5, 7) that ended clean BEFORE writing anything, because GitHub / Native were passingly
// unavailable and its entry says so (outcome.safeToRerun), is run again by the resident with the same signed result, after 30 s,
// 90 s and 5 min; the head is not burned, nothing is re-scanned (no stage 2/4/6 run again). Everything else still ends the batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PUBLICATION_RETRY_MS, PUBLICATION_RETRY_STAGES, publicationRetryable } from '../src/executor.mjs';
import { batchKey } from '../src/ledger.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const receiptBodies = async (f, type) => {
  const dir = path.join(f.root, 'state', 'receipts'), out = [];
  for (const n of (await fs.readdir(dir)).sort()) if (n.endsWith(`-${type}.json`)) out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')).body);
  return out;
};
// The Source's clean pre-write ending of a publisher stage: BLOCKED, zero side effects, nothing published, the entry's own flag.
const unavailable = (reason = 'github_http_502', o = {}) => ({ ok: false, code: 'GITHUB_TRANSIENT_UNAVAILABLE', proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: true, ...o } });
// An engine whose stage `number` answers from a list (then success).
function stageEngine(number, answers) {
  const engine = fakeEngine();
  const base = engine.runStage;
  let i = 0;
  engine.runStage = async (batch, stage, o) => (stage.number === number && i < answers.length ? (engine.calls.push(['stage', number]), answers[i++]) : base(batch, stage, o));
  return engine;
}
async function fixture(t, engine) {
  const waits = [];
  const f = await executorFixture(t, { engine, sleep: async ms => { if (ms >= PUBLICATION_RETRY_MS[0]) waits.push(ms); } });
  f.waits = waits;
  return f;
}

test('publicationRetryable: only the entry own flag on a clean BLOCKED zero-side-effect ending of stage 3, 5 or 7 on a restored runner', () => {
  assert.deepEqual([...PUBLICATION_RETRY_STAGES], [3, 5, 7]);
  assert.deepEqual([...PUBLICATION_RETRY_MS], [30_000, 90_000, 300_000]);
  const r = unavailable();
  for (const n of [3, 5, 7]) assert.equal(publicationRetryable(n, r), true, String(n));
  for (const n of [1, 2, 4, 6, 8]) assert.equal(publicationRetryable(n, r), false, `stage ${n}`);
  assert.equal(publicationRetryable(3, { ...r, ok: true }), false);
  for (const o of [{ safeToRerun: false }, { safeToRerun: undefined }, { sideEffects: 1 }, { mayHavePublished: true }, { status: 'REVOKED' }, { status: 'UNCERTAIN' }])
    assert.equal(publicationRetryable(3, unavailable('github_http_502', o)), false, JSON.stringify(o));
  assert.equal(publicationRetryable(3, { ...r, proof: { windowsTreeZero: true } }), false, 'the runner must read back as the original');
  assert.equal(publicationRetryable(3, { ...r, proof: { serviceOriginalStopped: true } }), false);
  assert.equal(publicationRetryable(3, { ...r, outcome: null }), false);
});

test('stage 3 ending clean without writing is run again after 30 s, 90 s: the batch completes, nothing is re-scanned', async t => {
  const engine = stageEngine(3, [unavailable(), unavailable('github_transport_unconfirmed')]);
  const f = await fixture(t, engine);
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r)); // it went on to stage 8 and completed, nothing burned
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 3, 3, 4, 5, 6, 7, 8], 'stage 3 three times, every scan stage once');
  assert.deepEqual(f.waits, [30_000, 90_000]);
  const retries = await receiptBodies(f, 'publication-retry');
  assert.deepEqual(retries.map(b => [b.stage, b.try, b.afterMs, b.failureCode, b.reason]), [[3, 1, 30_000, 'GITHUB_TRANSIENT_UNAVAILABLE', 'github_http_502'], [3, 2, 90_000, 'GITHUB_TRANSIENT_UNAVAILABLE', 'github_transport_unconfirmed']]);
  const terminals = (await receiptBodies(f, 'stage-terminal')).filter(b => b.stage === 3);
  assert.deepEqual(terminals.map(b => b.ok), [false, false, true]);
  assert.notEqual((await f.ledger.state(KEY)).state, 'FAILED_CLEAN');
});

test('stages 5 and 7 are run again the same way', async t => {
  for (const number of [5, 7]) {
    const engine = stageEngine(number, [unavailable()]);
    const f = await fixture(t, engine);
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'COMPLETED', String(number));
    assert.equal(stagesRun(engine).filter(n => n === number).length, 2, String(number));
    assert.deepEqual(stagesRun(engine).filter(n => [2, 4, 6].includes(n)), [2, 4, 6]);
  }
});

test('three repeats are the most: the fourth unavailable answer ends the batch as before (burned, clean), after 30 s, 90 s and 5 min', async t => {
  const engine = stageEngine(3, [unavailable(), unavailable(), unavailable(), unavailable()]);
  const f = await fixture(t, engine);
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'GITHUB_TRANSIENT_UNAVAILABLE']);
  assert.deepEqual(f.waits, [30_000, 90_000, 300_000]);
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 3, 3, 3]);
  assert.equal(r.attempt2, undefined, 'after the first stage there is no attempt 2 (the scans already ran)');
});

test('anything the entry did not call safe to run again ends the batch at once: a write was made, the flag is missing, the runner is not restored', async t => {
  for (const answer of [unavailable('github_http_502', { safeToRerun: false }), unavailable('github_http_502', { sideEffects: 2, status: 'REVOKED' }),
    { ...unavailable(), proof: { windowsTreeZero: true } }, { ok: false, code: 'PUBLICATION_BLOCKED', proof: WINDOWS_CLEAN, outcome: { status: 'BLOCKED', reason: 'role_already_published_on_head', sideEffects: 0, mayHavePublished: false, safeToRerun: false } }]) {
    const engine = stageEngine(3, [answer, unavailable()]);
    const f = await fixture(t, engine);
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.equal(r.state, 'FAILED_CLEAN');
    assert.deepEqual(stagesRun(engine), [1, 2, 3], JSON.stringify(answer.outcome));
    assert.deepEqual(f.waits, []);
    assert.deepEqual(await receiptBodies(f, 'publication-retry'), []);
  }
});

test('other stages are never run again by this rule: the scan stages keep their own paths', async t => {
  const engine = stageEngine(2, [unavailable()]);
  const f = await fixture(t, engine);
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'FAILED_CLEAN');
  assert.deepEqual(stagesRun(engine), [1, 2]);
  assert.deepEqual(f.waits, []);
});
