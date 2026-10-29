// Risk tiers of the daily budgets (Task 12ada80e, from c0ff5167; DESIGN §35). A stage-1 ending that proves it published
// nothing still burns its head, but counts against the evaluation budget, not the execution one; a global deferral is
// receipted once per reason and day. The values stay the interim 48/96 (Decision ca70ea31): only the counting changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { headKey } from '../src/ledger.mjs';
import { HEAD, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

const DAY = 86_400_000;
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d+-|\.json$/g, ''));
const headRecord = async (f, subject) => JSON.parse(await fs.readFile(path.join(f.root, 'state', 'ledger-heads', `${headKey(subject)}.json`), 'utf8'));
const subjectOf = (pr, headSha) => ({ repo: 'tdoljyj/cross-memory-system', pr, headSha, baseSha: '2'.repeat(40), sourceManifestSha256: 'a'.repeat(64), attempt: 1 });
// A stage-1 refusal the failure table burns (deterministic PR problem), as the Source binds it.
const refused = (o = {}) => ({ ok: false, code: 'STAGE_CHILD_REFUSED', proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: 'pr_files_page_limit', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false, ...o } });
const policy = (limits = {}) => { const p = rawPolicy(); return rawPolicy({ limits: { ...p.limits, ...limits } }); };

test('a stage-1 burn that proves it published nothing uses the evaluation budget, not the execution one; the head still never runs again', async t => {
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 1: refused() } }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'FAILED_CLEAN');
  const rec = await headRecord(f, subjectOf(884, HEAD));
  assert.equal(rec.burnedBy.quotaTier, 'evaluation');
  const u = await f.ledger.usage(f.clock() - DAY);
  assert.deepEqual([u.started, u.lowRiskBurns, u.evaluations, u.startedByPr.get(884) ?? 0], [0, 1, 1, 0]);
  // burned all the same: the same head is never reserved again
  await f.drop(triggerBytes({ pr: 885 }));
  const again = await f.exec.tick();
  assert.equal(again.state, 'IGNORED');
});

test('the execution tier keeps every ending that may have published or reached a later stage', async t => {
  const cases = [
    ['mayHavePublished true', { 1: refused({ mayHavePublished: true }) }],
    ['side effects', { 1: refused({ sideEffects: 1 }) }],
    ['no bound outcome', { 1: { ok: false, code: 'STAGE_CHILD_REFUSED', proof: WINDOWS_CLEAN } }],
    ['stage 3', { 3: { ok: false, code: 'STAGE_CHILD_REFUSED', proof: WINDOWS_CLEAN } }],
  ];
  for (const [what, stages] of cases) {
    const f = await executorFixture(t, { engine: fakeEngine({ stages }) });
    await f.drop(triggerBytes());
    await f.exec.tick();
    const u = await f.ledger.usage(f.clock() - DAY);
    assert.deepEqual([u.started, u.lowRiskBurns], [1, 0], what);
    const rec = await headRecord(f, subjectOf(884, HEAD));
    assert.equal(rec.burnedBy?.quotaTier, undefined, what);
  }
});

test('an unclean Linux side keeps the execution tier (the CLEAN class needs both hosts)', async t => {
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 1: refused() } }), companion: fakeCompanion({ linux: { linuxUnitsInactive: false, containersZero: true } }, () => Date.parse('2026-10-20T12:00:00Z')) });
  await f.drop(triggerBytes());
  await f.exec.tick();
  const u = await f.ledger.usage(f.clock() - DAY);
  assert.equal(u.lowRiskBurns, 0);
  assert.equal(u.started, 1);
});

test('low-risk burns leave the execution budget for real batches; a full budget is receipted once per reason and day', async t => {
  let n = 0;
  const engine = fakeEngine();
  engine.runStage = async (batch, stage) => { engine.calls.push(['stage', stage.number]); if (stage.number === 1 && n++ === 0) return refused(); return { ok: true, factsSha256: 'd'.repeat(64) }; };
  const f = await executorFixture(t, { engine, policy: policy({ maxBatchesPer24h: 1 }) });
  // the first PR is refused at stage 1 (low risk): the one execution of the day is still free
  await f.drop(triggerBytes({ pr: 884, headSha: HEAD }));
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
  await f.drop(triggerBytes({ pr: 886, headSha: '6'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  // now the budget is used up: deferred, with one batch-deferred receipt however often it is tried
  await f.drop(triggerBytes({ pr: 887, headSha: '7'.repeat(40) }));
  const d = await f.exec.tick();
  assert.deepEqual([d.state, d.reason], ['DEFERRED', 'DAILY_BATCH_LIMIT']);
  f.advance(60_000);
  assert.equal((await f.exec.tick()).reason, 'DAILY_BATCH_LIMIT');
  assert.equal((await receiptTypes(f)).filter(x => x === 'batch-deferred').length, 1);
  const rc = (await fs.readdir(path.join(f.root, 'state', 'receipts'))).find(x => x.includes('batch-deferred'));
  const body = JSON.parse(await fs.readFile(path.join(f.root, 'state', 'receipts', rc), 'utf8')).body;
  assert.deepEqual([body.failureCode, body.usage.started, body.usage.lowRiskBurns], ['DAILY_BATCH_LIMIT', 1, 1]);
  // the next UTC day receipts it again
  f.advance(DAY);
  await f.drop(triggerBytes({ pr: 888, headSha: '8'.repeat(40) }));
  await f.exec.tick();
});
