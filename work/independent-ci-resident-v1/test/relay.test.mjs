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
import path from 'node:path';
import { ResidentExecutor, PAUSE_CONTRACT } from '../src/executor.mjs';
import { serviceLoop, RESTING_STATES } from '../src/service-main.mjs';
import { rearmRequest, resumeRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
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
const OWNER = 'S-1-5-21-1-2-3-1001';

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
  assert.ok(!(await types(f)).includes('relay-waiting'), 'no wait');
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
  await f.drop(triggerBytes({ pr: 990 }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
});

test('minutes used up mid-month: a billing-refused hint starts at once, no stage R, all local, relay-billing-refused per relayable role', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor({ gitleaks: { state: 'BILLING_REFUSED' }, trivy: { state: 'ABSENT' } }) }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(!(await types(f)).includes('relay-waiting'), 'no wait');
  assert.deepEqual((await receiptBodies(f, 'relay-billing-refused')).map(b => `${b.role}:${b.reason}`), ['gitleaks:RELAY_HINT_BILLING_REFUSED', 'trivy:RELAY_HINT_BILLING_REFUSED']);
});

test('bounded wait is non-blocking: each tick returns WAITING until the hosted jobs succeed, then the batch continues; no hint ends in the signal window', async t => {
  let done = false;
  const companion = fakeCompanion({ hint: (s, at) => hintFor(done ? SUCCESS : { gitleaks: { state: 'PENDING_RUNNING', startedAt: at - 60_000 }, trivy: { state: 'PENDING_QUEUED', queuedAt: at - 60_000 } }) });
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine, policy: ON, companion });
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.equal(first.state, 'WAITING');
  assert.ok(first.until > f.clock());
  for (let i = 0; i < 2; i++) { f.advance(60_000); assert.equal((await f.exec.tick()).state, 'WAITING'); }
  assert.deepEqual(stagesRun(engine), [1], 'stage 1 once; nothing else while waiting');
  assert.equal(engine.calls.filter(c => c[0] === 'derive').length, 1);
  done = true; f.advance(60_000);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.relayed], ['COMPLETED', ['gitleaks', 'trivy']]);
  assert.deepEqual(stagesRun(engine), [1, 9, 6, 7, 8]);
  assert.equal((await f.ledger.state(r.key)).planIntent.waitedMs, 3 * 60_000, 'waited from the stored t0');
  assert.deepEqual((await receiptBodies(f, 'relay-waiting')).length, 1, 'one relay-waiting receipt, not one per tick');
  // no hint ever: wait the 10-minute signal window from t0, then everything local
  const g = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => null }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  g.advance(RELAY_ON.wait.signalMs - 1);
  assert.equal((await g.exec.tick()).state, 'WAITING');
  g.advance(1);
  const r2 = await g.exec.tick();
  assert.equal(r2.state, 'COMPLETED');
  assert.deepEqual(stagesRun(g.engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  const s = await g.ledger.state(r2.key);
  assert.deepEqual([s.planIntent.reason, s.plan.local.map(l => l.reason)], ['RELAY_PARTIAL_OR_TIMED_OUT', ['RELAY_WAIT_TIMED_OUT', 'RELAY_WAIT_TIMED_OUT', 'RELAY_ROLE_NOT_RELAYABLE']]);
});

// Coordinator review: the emergency stop is never delayed by a wait.
// Hint times are on the fixture clock (executorFixture starts at T0); the fake companion's own clock is not.
const T0 = Date.parse('2026-10-20T12:00:00Z');
const pending = () => fakeCompanion({ hint: () => hintFor({ gitleaks: { state: 'PENDING_RUNNING', startedAt: T0 - 60_000 }, trivy: { state: 'SUCCESS' } }) });
async function waitingFixture(t, companion = pending()) {
  const f = await executorFixture(t, { policy: ON, companion });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  return f;
}

test('pause during the wait stops the batch before stage R and any local stage; the Owner resume continues it from the stored t0', async t => {
  const f = await waitingFixture(t);
  await f.drop(Buffer.from(JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'emergency stop' })), 'requests');
  assert.equal((await f.exec.tick()).state, 'PAUSED', 'the pause takes effect on the very next tick');
  f.advance(80 * 60_000); // paused beyond the wait's 60-minute total cap, inside the bundle's 100 minutes (park.test.mjs)
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.deepEqual(stagesRun(f.engine), [1], 'no stage R, no local stage while paused');
  // a resume from the user-writable requests directory does nothing; only the Owner's does
  await f.drop(Buffer.from(JSON.stringify(resumeRequest({ expectedPausedSha256: (await f.ledger.paused()).sha256, by: OWNER }))), 'requests');
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  await writeOwnerRequest(path.join(f.root, 'owner'), resumeRequest({ expectedPausedSha256: (await f.ledger.paused()).sha256, by: OWNER }), f.clock);
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  // t0 is the stored one: the total cap is long past, so it starts at once with what the hints say
  const s = await f.ledger.state(r.key);
  assert.deepEqual([s.planIntent.reason, s.planIntent.candidates], ['RELAY_TOTAL_WAIT_REACHED', ['trivy']]);
  assert.deepEqual(stagesRun(f.engine), [1, 9, 2, 3, 6, 7, 8]);
});

test('Owner re-arm during the wait: a HALT latched while a batch waits blocks it; re-arm clears it and the wait continues', async t => {
  const f = await waitingFixture(t);
  await f.ledger.halt('RESIDENT_LOOP_EXCEPTION', { message: 'drill' });
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.deepEqual(stagesRun(f.engine), [1]);
  const halt = await f.ledger.halted();
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: halt.sha256, reason: 'checked: nothing runs while waiting', by: OWNER }), f.clock);
  const after = await f.exec.tick();
  assert.equal(await f.ledger.halted(), null, 'the waiting batch is no scene: re-arm is not refused for it');
  assert.equal(after.state, 'WAITING', 'the same batch keeps waiting');
  const waiting = await f.ledger.waiting();
  assert.equal(waiting.state, 'STARTED');
  assert.equal((await f.receipts.entries()).some(e => e.type === 'owner-request'), true);
});

test('restart during the wait: a new executor resumes the wait from the stored t0 without deriving or running stage 1 again', async t => {
  const f = await waitingFixture(t);
  const key = (await f.ledger.waiting()).key;
  const t0 = (await f.ledger.state(key)).wait.t0;
  // a new process: the same state root, a fresh executor; recovery must not treat the waiting batch as a crash
  const engine = fakeEngine();
  const again = new ResidentExecutor({ ...f.ports, engine });
  f.advance(30 * 60_000);
  assert.equal((await again.tick()).state, 'WAITING');
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual(engine.calls.filter(c => c[0] === 'derive' || c[0] === 'stage'), [], 'nothing derived or run again');
  f.advance(6 * 60_000); // past the running job's timeout + slack from its start, relative to t0's batch
  const r = await again.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.deepEqual(stagesRun(engine), [9, 2, 3, 6, 7, 8]);
  assert.equal((await f.ledger.state(key)).wait.t0, t0);
  assert.equal((await f.ledger.state(key)).planIntent.waitedMs, f.clock() - t0);
});

test('service loop: every iteration refreshes the lock and checks the stop request; a waiting tick never blocks it', async t => {
  const f = await waitingFixture(t);
  let touches = 0, stop = false, ticks = 0;
  const exec = { tick: async () => { ticks += 1; const r = await f.exec.tick(); if (ticks === 3) stop = true; return r; } };
  const slept = [];
  const code = await serviceLoop({ exec, lock: { touch: async () => { touches += 1; } }, sleep: async ms => { slept.push(ms); f.advance(ms); },
    stopRequested: async () => stop, acknowledgeStop: async () => {}, onLoopException: async () => {}, betweenBatches: async () => {} });
  assert.equal(code, 0, 'the stop is honoured while the batch waits');
  assert.deepEqual([ticks, touches], [3, 4], 'one liveness refresh per iteration, before each tick and before the stop check');
  assert.ok(slept.every(ms => ms === 15_000), 'a waiting tick rests like an idle one');
  assert.ok(RESTING_STATES.includes('WAITING'));
  assert.ok(await f.ledger.waiting(), 'still waiting after the stop; the next start resumes it');
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
  await f.ledger.beginWait(key, { t0: f.clock(), batch: { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key } });
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
  const companion = fakeCompanion({ hint: (s, at) => hintFor(late ? SUCCESS : { gitleaks: { state: 'PENDING_RUNNING', startedAt: Date.parse('2026-10-20T12:00:00Z') - 40 * 60_000 }, trivy: { state: 'SUCCESS' } }) });
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
  // and it runs: attempt 1's own "before stage R" executed-head record does not stop it (independent review of phase 1,
  // MINOR 5), while a new trigger of the head is still refused
  g.advance(600_000);
  const again = await g.exec.tick();
  assert.deepEqual([again.state, again.key], ['COMPLETED', batchKey(subject({ attempt: 2 }))]);
  await g.drop(triggerBytes({ pr: 990 }));
  assert.ok(['HEAD_ALREADY_EXECUTED_NO_RETRY', 'HEAD_ALREADY_PUBLISHED_NO_RETRY'].includes((await g.exec.tick()).reason));
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
  assert.equal((await f.exec.tick()).state, 'WAITING', 'no usable hint: the signal window');
  f.advance(RELAY_ON.wait.signalMs);
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.deepEqual(stagesRun(f.engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await f.ledger.state(r.key)).planIntent.hintRefused, true);
  const g = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS, { head: 'f'.repeat(40) }) }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  g.advance(RELAY_ON.wait.signalMs);
  assert.equal((await g.exec.tick()).state, 'COMPLETED');
  assert.ok(!stagesRun(g.engine).includes(9), 'a hint for another head never makes a candidate');
});
