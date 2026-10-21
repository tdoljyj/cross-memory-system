// Stage R in the resident executor (free-minutes design S19-S22): the bounded hosted wait after stage 1,
// 20-plan-intent / 25-plan, only LOCAL_REQUIRED roles run locally, HALT on any relay uncertainty, crash
// recovery of an interrupted stage R, late hosted results ignored, and no attempt 2 after a relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchKey, headKey } from '../src/ledger.mjs';
import { RELAY_LOCAL_REASONS, RELAY_ROW_FIELDS, relayPlanFromRows } from '../src/classify.mjs';
import { RELAY_RECEIPTS } from '../src/receipts.mjs';
import { LOCAL_REASONS } from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/stage.mjs';
import { RELAY_PLAN_ROW_FIELDS, RELAY_RECEIPTS as SOURCE_RELAY_RECEIPTS } from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/relay-plan.mjs';
import { BASE, HEAD, RELAY_ON, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, hintFor, localRow, rawPolicy, relayedRow, triggerBytes } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const ON = rawPolicy({ relay: RELAY_ON });
const types = async f => (await f.receipts.entries()).map(e => e.type);
async function receiptBodies(f, type) {
  const fs = await import('node:fs/promises'); const path = await import('node:path');
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
}
const SUCCESS = { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } };

test('the resident mirror of the stage-R plan contract equals the Source (reasons, row fields, receipt types)', () => {
  assert.deepEqual([...RELAY_LOCAL_REASONS], [...LOCAL_REASONS]);
  assert.deepEqual([...RELAY_ROW_FIELDS], [...RELAY_PLAN_ROW_FIELDS]);
  for (const r of SOURCE_RELAY_RECEIPTS) assert.ok(Object.values(RELAY_RECEIPTS).includes(r), r);
  assert.equal(RELAY_RECEIPTS.lateIgnored, 'relay-late-ignored');
  assert.deepEqual(relayPlanFromRows([relayedRow('gitleaks'), localRow('trivy')], ['gitleaks', 'trivy']).relayed.map(r => r.role), ['gitleaks']);
  for (const bad of [[{ ...relayedRow('gitleaks'), outcome: 'HALT', reason: 'RELAY_PUBLICATION_UNCERTAIN', receipt: null, checkRunId: null, externalId: null, attestationSha256: null }],
    [{ ...localRow('gitleaks'), reason: 'SOMETHING' }], [{ ...relayedRow('gitleaks'), externalId: relayedRow('trivy').externalId }], [{ ...relayedRow('gitleaks'), extra: 1 }], [relayedRow('trivy')]])
    assert.equal(relayPlanFromRows(bad, ['gitleaks']), null, JSON.stringify(bad));
  assert.equal(relayPlanFromRows([], []), null);
});

test('relay off (the shipped default): no wait, no stage R, all three roles local, plan recorded, no relay receipts', async t => {
  const f = await executorFixture(t);
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.deepEqual(stagesRun(f.engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(f.sleeps, []);
  const s = await f.ledger.state(r.key);
  assert.deepEqual([s.planIntent.candidates, s.planIntent.reason, s.plan.relayed, s.plan.local.map(l => `${l.role}:${l.reason}`)],
    [[], 'RELAY_DISABLED', [], ['gitleaks:RELAY_DISABLED', 'trivy:RELAY_DISABLED', 'contract-placement:RELAY_DISABLED']]);
  const ts = await types(f);
  assert.ok(!ts.some(x => x.startsWith('relay-') && x !== 'relay-plan-intent'));
  assert.deepEqual(f.engine.opts.filter(([n]) => [2, 4, 6].includes(n)).map(([n, o]) => [n, o.firstLinux, o.betweenRoles]), [[2, true, false], [4, false, true], [6, false, true]]);
});

test('minutes available: 1 -> R (gitleaks, trivy relayed) -> placement locally -> 8; receipts in order; the head burns', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.relayed, r.local], ['COMPLETED', ['gitleaks', 'trivy'], ['contract-placement']]);
  assert.deepEqual(stagesRun(engine), [1, 9, 6, 7, 8]);
  assert.deepEqual(engine.relayRoles, ['gitleaks', 'trivy']);
  assert.deepEqual(engine.opts.find(([n]) => n === 6)[1], { betweenRoles: false, firstLinux: true }, 'placement is the first local Linux role: refs gate, no between-roles archive');
  const ts = (await types(f)).filter(x => !['service-start'].includes(x));
  const at = x => ts.indexOf(x);
  assert.ok(at('batch-started') < at('relay-plan-intent') && at('relay-plan-intent') < at('relay-attested') && at('relay-attested') < at('relay-local-fallback'));
  assert.deepEqual((await receiptBodies(f, 'relay-attested')).map(b => b.role), ['gitleaks', 'trivy']);
  assert.deepEqual((await receiptBodies(f, 'relay-local-fallback')).map(b => `${b.role}:${b.reason}`), ['contract-placement:RELAY_ROLE_NOT_RELAYABLE']);
  const s = await f.ledger.state(r.key);
  assert.deepEqual(s.plan.relayed.map(x => x.role), ['gitleaks', 'trivy']);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true, 'a batch that relayed its scanners still burns its head');
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
});

test('minutes used up mid-month: a billing-refused hint starts at once, no stage R, all local, relay-billing-refused per relayable role', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor({ gitleaks: { state: 'BILLING_REFUSED' }, trivy: { state: 'ABSENT' } }) }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual((await receiptBodies(f, 'relay-billing-refused')).map(b => `${b.role}:${b.reason}`), ['gitleaks:RELAY_HINT_BILLING_REFUSED', 'trivy:RELAY_HINT_BILLING_REFUSED']);
});

test('bounded wait: running hosted jobs are waited for, then relayed once they succeed; no hint at all ends in the signal window', async t => {
  let now = null, done = false;
  const companion = fakeCompanion({ hint: (s, at) => { now = at; return hintFor(done ? SUCCESS : { gitleaks: { state: 'PENDING_RUNNING', startedAt: at - 60_000 }, trivy: { state: 'PENDING_QUEUED', queuedAt: at - 60_000 } }); } });
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine, policy: ON, companion });
  const sleep = f.exec.sleep;
  let polls = 0;
  f.exec.sleep = async ms => { polls += 1; if (polls === 3) done = true; await sleep(ms); };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.relayed], ['COMPLETED', ['gitleaks', 'trivy']]);
  assert.equal(polls, 3);
  assert.ok(f.sleeps.every(ms => ms <= RELAY_ON.wait.pollMs));
  assert.equal((await f.ledger.state(r.key)).planIntent.waitedMs, f.sleeps.reduce((a, b) => a + b, 0), 'the waited time is recorded');
  assert.ok(now !== null);
  // no hint ever: wait the 10-minute signal window, then everything local
  const g = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => null }) });
  await g.drop(triggerBytes());
  const r2 = await g.exec.tick();
  assert.equal(r2.state, 'COMPLETED');
  assert.deepEqual(stagesRun(g.engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(g.sleeps.reduce((a, b) => a + b, 0), RELAY_ON.wait.signalMs);
  const s = await g.ledger.state(r2.key);
  assert.deepEqual([s.planIntent.reason, s.plan.local.map(l => l.reason)], ['RELAY_PARTIAL_OR_TIMED_OUT', ['RELAY_WAIT_TIMED_OUT', 'RELAY_WAIT_TIMED_OUT', 'RELAY_ROLE_NOT_RELAYABLE']]);
});

test('minutes run out within one head: trivy relayed, gitleaks falls back locally; between-roles archives only where needed', async t => {
  const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => r === 'trivy' ? relayedRow(r) : localRow(r, 'RELAY_NOT_ATTESTED_HOSTED_NOT_SUCCESS')) }) });
  const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.relayed, r.local], ['COMPLETED', ['trivy'], ['gitleaks', 'contract-placement']]);
  assert.deepEqual(stagesRun(engine), [1, 9, 2, 3, 6, 7, 8]);
  assert.deepEqual(engine.opts.filter(([n]) => [2, 6].includes(n)).map(([n, o]) => [n, o.firstLinux, o.betweenRoles]), [[2, true, false], [6, false, true]]);
  assert.deepEqual((await receiptBodies(f, 'relay-local-fallback')).map(b => `${b.role}:${b.reason}:${b.source}`),
    ['gitleaks:RELAY_NOT_ATTESTED_HOSTED_NOT_SUCCESS:stage-r', 'contract-placement:RELAY_ROLE_NOT_RELAYABLE:resident']);
});

test('RELAY_PUBLICATION_UNCERTAIN: HALT, head burned, no 25-plan, and never a local stage for any role afterwards', async t => {
  const engine = fakeEngine({ relay: () => ({ ok: false, code: 'RELAY_PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, relay: [] }) });
  const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'RELAY_PUBLICATION_UNCERTAIN']);
  assert.deepEqual(stagesRun(engine), [1, 9]);
  const s = await f.ledger.state(r.key);
  assert.deepEqual([s.outcome, !!s.planIntent, s.plan], ['FAILED_UNKNOWN', true, null]);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
  for (const code of ['ROLE_ALREADY_PUBLISHED_ON_HEAD', 'RELAY_PLAN_UNCONFIRMED']) {
    const e = fakeEngine({ relay: () => ({ ok: false, code, proof: WINDOWS_CLEAN }) });
    const g = await executorFixture(t, { engine: e, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
    await g.drop(triggerBytes());
    assert.equal((await g.exec.tick()).state, 'HALTED', code);
  }
});

test('a "complete" stage R whose rows are not a clean plan is RELAY_PLAN_UNCONFIRMED: HALT, nothing local', async t => {
  for (const rows of [roles => roles.map(r => ({ ...localRow(r), reason: 'MADE_UP_REASON' })), roles => roles.slice(1).map(r => relayedRow(r)), () => null]) {
    const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: rows(roles) }) });
    const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['HALTED', 'RELAY_PLAN_UNCONFIRMED']);
    assert.deepEqual(stagesRun(engine), [1, 9]);
  }
});

test('crash inside stage R (20-plan-intent without 25-plan): recovery closes it FAILED_UNKNOWN RELAY_STAGE_INTERRUPTED and HALTs', async t => {
  const f = await executorFixture(t, { policy: ON });
  const s = subject(), key = batchKey(s);
  await f.ledger.reserve(key, s);
  await f.ledger.markStarted(key, { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}` });
  await f.ledger.writePlanIntent(key, { candidates: ['gitleaks', 'trivy'], local: ['contract-placement'], reasons: {}, reason: 'RELAY_ALL_HOSTED_SUCCESS' });
  await assert.rejects(f.ledger.writePlanIntent(key, { candidates: [] }), { code: 'RELAY_PLAN_INTENT_REQUIRES_STARTED_ENTRY' });
  const r = await f.exec.tick();
  assert.equal(r.state, 'HALTED');
  const st = await f.ledger.state(key);
  assert.deepEqual([st.outcome, st.terminal.facts.failureCode], ['FAILED_UNKNOWN', 'RELAY_STAGE_INTERRUPTED']);
  assert.equal((await f.ledger.halted()).value.code, 'RELAY_STAGE_INTERRUPTED');
  assert.deepEqual(stagesRun(f.engine), [], 'nothing of it runs again');
});

test('a hosted run that succeeds after the local path started is ignored (relay-late-ignored), the role still runs locally once', async t => {
  let late = false;
  const engine = fakeEngine();
  const base = engine.runStage.bind(engine);
  engine.runStage = async (batch, stage, opts) => { if (stage.number === 2) late = true; return base(batch, stage, opts); };
  const companion = fakeCompanion({ hint: (s, at) => hintFor(late ? SUCCESS : { gitleaks: { state: 'PENDING_RUNNING', startedAt: at - 30 * 60_000 }, trivy: { state: 'SUCCESS' } }) });
  const f = await executorFixture(t, { engine, policy: ON, companion });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.relayed, r.local], ['COMPLETED', ['trivy'], ['gitleaks', 'contract-placement']]);
  assert.deepEqual(stagesRun(engine), [1, 9, 2, 3, 6, 7, 8]);
  assert.deepEqual((await receiptBodies(f, 'relay-late-ignored')).map(b => b.role), ['gitleaks']);
  const ts = await types(f);
  assert.ok(ts.lastIndexOf('stage-terminal') > ts.indexOf('relay-late-ignored'), 'recorded before stage 8 ends the batch');
});

test('attempt 2 never follows a relay; with stage R relaying nothing, a stage-2 transient is still eligible', async t => {
  const fail2 = engine => { const base = engine.runStage.bind(engine); let n = 0; engine.runStage = async (b, st, o) => (st.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(b, st, o)); return engine; };
  const relayedTrivy = fail2(fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => r === 'trivy' ? relayedRow(r) : localRow(r)) }) }));
  const f = await executorFixture(t, { engine: relayedTrivy, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.attempt2], ['FAILED_CLEAN', undefined]);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  const nothingRelayed = fail2(fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => localRow(r)) }) }));
  const g = await executorFixture(t, { engine: nothingRelayed, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await g.drop(triggerBytes());
  const r2 = await g.exec.tick();
  assert.equal(r2.state, 'FAILED_CLEAN');
  assert.equal(r2.attempt2, batchKey(subject({ attempt: 2 })));
  // a clean failure of stage R itself is final for the head
  const refused = fakeEngine({ relay: () => ({ ok: false, code: 'RELAY_STAGE_REFUSED', proof: WINDOWS_CLEAN }) });
  const h = await executorFixture(t, { engine: refused, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await h.drop(triggerBytes());
  const r3 = await h.exec.tick();
  assert.deepEqual([r3.state, r3.failureCode, r3.attempt2], ['FAILED_CLEAN', 'RELAY_STAGE_REFUSED', undefined]);
});

test('a malformed or foreign hint is "no hint": it can only make the batch wait or run locally', async t => {
  const f = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => Buffer.from('{"contract":"x"}') }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.deepEqual(stagesRun(f.engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await f.ledger.state(r.key)).planIntent.hintRefused, true);
  const g = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS, { head: 'f'.repeat(40) }) }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'COMPLETED');
  assert.ok(!stagesRun(g.engine).includes(9), 'a hint for another head never makes a candidate');
});
