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

test('billing-refused hint cannot transfer either hosted role to Native', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor({ gitleaks: { state: 'BILLING_REFUSED' }, trivy: { state: 'ABSENT' } }) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.reason, 'RELAY_PROVIDER_TRANSFER_REQUIRED');
  f.advance(120 * 60_000);
  assert.equal((await f.exec.tick()).state, 'WAITING');
  assert.deepEqual(stagesRun(engine), [1]);
  assert.equal((await f.ledger.state(r.key)).planIntent, null);
  assert.deepEqual(await receiptBodies(f, 'relay-billing-refused'), []);
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
  // No hint ever: neither the signal deadline nor total timeout transfers scans.
  const g = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => null }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  g.advance(RELAY_ON.wait.signalMs - 1);
  assert.equal((await g.exec.tick()).state, 'WAITING');
  g.advance(1);
  const r2 = await g.exec.tick();
  assert.equal(r2.state, 'WAITING');
  assert.deepEqual(stagesRun(g.engine), [1]);
  const s = await g.ledger.state(r2.key);
  assert.deepEqual([s.planIntent, s.plan], [null, null]);
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
  assert.equal(r.state, 'WAITING');
  assert.equal(r.reason, 'RELAY_PROVIDER_TRANSFER_REQUIRED');
  // Ordinary resume and a passed total cap cannot make one hosted role local.
  const s = await f.ledger.state(r.key);
  assert.equal(s.planIntent, null);
  assert.deepEqual(stagesRun(f.engine), [1]);
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
  assert.equal(r.state, 'WAITING');
  assert.equal(r.reason, 'RELAY_PROVIDER_TRANSFER_REQUIRED');
  assert.deepEqual(stagesRun(engine), []);
  f.companion.hostedHint = async () => Buffer.from(JSON.stringify(hintFor(SUCCESS)));
  assert.equal((await again.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(engine), [9, 6, 7, 8]);
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

test('partial StageR publication is retained, but LOCAL_REQUIRED causes HALT without any local scan', async t => {
  const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => r === 'trivy' ? relayedRow(r) : localRow(r, 'RELAY_NOT_ATTESTED_HOSTED_NOT_SUCCESS')) }) });
  const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'RELAY_PLAN_UNCONFIRMED']);
  assert.deepEqual(stagesRun(engine), [1, 9]);
  assert.deepEqual((await receiptBodies(f, 'relay-attested')).map(b => b.role), ['trivy']);
  const state = await f.ledger.state(r.key);
  assert.ok(state.planIntent); assert.equal(state.plan, null);
  assert.ok(!f.companion.calls.some(c => c[0] === 'wsprep'));
  await f.exec.tick();
  assert.deepEqual(stagesRun(engine), [1, 9], 'HALT never repeats StageR');
});

test('RELAY_PUBLICATION_UNCERTAIN: HALT, head burned, no 25-plan, and never a local stage for any role afterwards', async t => {
  const engine = fakeEngine({ relay: () => ({ ok: false, code: 'RELAY_PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, relay: [] }) });
  const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'RELAY_PLAN_UNCONFIRMED']);
  assert.ok((await receiptBodies(f, 'stage-terminal')).some(x => x.failureCode === 'RELAY_PUBLICATION_UNCERTAIN'), 'original Source refusal remains evidence');
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

test('a hosted run still pending past hard stop waits; later dual success goes through StageR, never Native', async t => {
  let late = false;
  const engine = fakeEngine();
  const companion = fakeCompanion({ hint: (s, at) => hintFor(late ? SUCCESS : { gitleaks: { state: 'PENDING_RUNNING', startedAt: Date.parse('2026-10-20T12:00:00Z') - 40 * 60_000 }, trivy: { state: 'SUCCESS' } }) });
  const f = await executorFixture(t, { engine, policy: ON, companion });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(60 * 60_000);
  assert.equal((await f.exec.tick()).state, 'WAITING');
  assert.deepEqual(stagesRun(engine), [1]);
  late = true;
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.relayed, r.local], ['COMPLETED', ['gitleaks', 'trivy'], ['contract-placement']]);
  assert.deepEqual(stagesRun(engine), [1, 9, 6, 7, 8]);
  assert.deepEqual(await receiptBodies(f, 'relay-late-ignored'), [], 'late observation is not a provider-transfer repair');
});

test('StageR local rows/refusal never create attempt2; Native-only retry semantics remain unchanged', async t => {
  const fail2 = engine => { const base = engine.runStage.bind(engine); let n = 0; engine.runStage = async (b, st, o) => (st.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(b, st, o)); return engine; };
  const relayedTrivy = fail2(fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => r === 'trivy' ? relayedRow(r) : localRow(r)) }) }));
  const f = await executorFixture(t, { engine: relayedTrivy, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.attempt2], ['HALTED', 'RELAY_PLAN_UNCONFIRMED', undefined]);
  assert.deepEqual(stagesRun(relayedTrivy), [1, 9]);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  const nothingRelayed = fail2(fakeEngine());
  const g = await executorFixture(t, { engine: nothingRelayed });
  await g.drop(triggerBytes());
  const r2 = await g.exec.tick();
  assert.equal(r2.state, 'FAILED_CLEAN');
  assert.equal(r2.attempt2, batchKey(subject({ attempt: 2 })));
  // Relay disabled retains the existing Native-only retry contract.
  g.advance(600_000);
  const again = await g.exec.tick();
  assert.deepEqual([again.state, again.key], ['COMPLETED', batchKey(subject({ attempt: 2 }))]);
  await g.drop(triggerBytes({ pr: 990 }));
  assert.ok(['HEAD_ALREADY_EXECUTED_NO_RETRY', 'HEAD_ALREADY_PUBLISHED_NO_RETRY'].includes((await g.exec.tick()).reason));
  // A refused StageR can no longer authorize a local fallback or clean retry.
  const refused = fakeEngine({ relay: () => ({ ok: false, code: 'RELAY_STAGE_REFUSED', proof: WINDOWS_CLEAN }) });
  const h = await executorFixture(t, { engine: refused, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await h.drop(triggerBytes());
  const r3 = await h.exec.tick();
  assert.deepEqual([r3.state, r3.failureCode, r3.attempt2], ['HALTED', 'RELAY_PLAN_UNCONFIRMED', undefined]);
});

test('malformed or foreign hints remain WAIT after timeouts and never grant Native authority', async t => {
  const f = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => Buffer.from('{"contract":"x"}') }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING', 'no usable hint: the signal window');
  f.advance(RELAY_ON.wait.totalMs * 2);
  const r = await f.exec.tick();
  assert.equal(r.state, 'WAITING');
  assert.deepEqual(stagesRun(f.engine), [1]);
  assert.equal((await f.ledger.state(r.key)).planIntent, null);
  const g = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS, { head: 'f'.repeat(40) }) }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  g.advance(RELAY_ON.wait.totalMs * 2);
  assert.equal((await g.exec.tick()).state, 'WAITING');
  assert.ok(!stagesRun(g.engine).includes(9), 'a hint for another head never makes a candidate');
});

test('failed hosted scan, NOT_ELIGIBLE and a configured role subset cannot enter any local role', async t => {
  for (const state of ['HOSTED_NOT_SUCCESS', 'NOT_ELIGIBLE']) {
    const f = await executorFixture(t, { policy: ON, companion: fakeCompanion({ hint: () => hintFor({ gitleaks: { state }, trivy: { state: 'SUCCESS' } }) }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).reason, 'RELAY_PROVIDER_TRANSFER_REQUIRED');
    f.advance(2 * RELAY_ON.wait.totalMs);
    assert.equal((await f.exec.tick()).state, 'WAITING');
    assert.deepEqual(stagesRun(f.engine), [1]);
    assert.ok(!f.companion.calls.some(c => c[0] === 'wsprep'));
  }
  const f = await executorFixture(t, { policy: rawPolicy({ relay: { ...RELAY_ON, roles: ['gitleaks'] } }),
    companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).reason, 'RELAY_HOSTED_ROLE_SET_INCOMPLETE');
  assert.deepEqual(stagesRun(f.engine), [1]);
});

test('attestation refusal and every LOCAL_REQUIRED result preserve the intent and HALT without fallback', async t => {
  for (const reason of ['RELAY_NOT_ATTESTED_ATTESTATION_FAILED', 'RELAY_NOT_ATTESTED_HOSTED_NOT_SUCCESS',
    'RELAY_NOT_ATTESTED_BILLING_REFUSED', 'RELAY_NOT_ATTESTED_NOT_ELIGIBLE', 'RELAY_NOT_ATTESTED_OBSERVATION_UNCONFIRMED']) {
    const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => localRow(r, reason)) }) });
    const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
    await f.drop(triggerBytes()); const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['HALTED', 'RELAY_PLAN_UNCONFIRMED']);
    const s = await f.ledger.state(r.key);
    assert.equal(s.outcome, 'FAILED_UNKNOWN'); assert.ok(s.planIntent); assert.equal(s.plan, null);
    assert.deepEqual(stagesRun(engine), [1, 9]);
    assert.deepEqual(await f.ledger.pendingAttempts2(), []);
    assert.ok(!f.companion.calls.some(c => c[0] === 'wsprep'));
  }
});

test('hosted-enabled train front cannot bypass the strict provider gate', async t => {
  const f = await executorFixture(t, { policy: ON });
  const plan = await f.exec.relayPlan('a'.repeat(64), subject({ testSha: '3'.repeat(40) }), {}, f.clock());
  assert.equal(plan.waiting, true); assert.equal(plan.reason, 'RELAY_PROVIDER_TRANSFER_REQUIRED');
  assert.deepEqual(stagesRun(f.engine), []);
});

test('failed StageR preserves confirmed publications before HALT and after failed SCM readback', async t => {
  const halted = { role: 'trivy', outcome: 'HALT', reason: 'RELAY_PUBLICATION_UNCERTAIN', receipt: null,
    checkRunId: null, externalId: null, attestationSha256: null, detail: null };
  for (const rows of [[relayedRow('gitleaks'), halted], [relayedRow('gitleaks'), relayedRow('trivy')]]) {
    const engine = fakeEngine({ relay: () => ({ ok: false, code: rows[1].outcome === 'HALT' ? 'RELAY_PUBLICATION_UNCERTAIN' : 'SCM_READBACK_NOT_ORIGINAL',
      factsSha256: 'd'.repeat(64), proof: WINDOWS_CLEAN, relay: rows }) });
    const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
    await f.drop(triggerBytes()); const result = await f.exec.tick();
    assert.deepEqual([result.state, result.failureCode], ['HALTED', 'RELAY_PLAN_UNCONFIRMED']);
    assert.deepEqual((await receiptBodies(f, 'relay-attested')).map(x => x.role), rows.filter(x => x.outcome === 'RELAYED').map(x => x.role));
    const state = await f.ledger.state(result.key);
    assert.ok(state.planIntent); assert.equal(state.plan, null); assert.equal(state.outcome, 'FAILED_UNKNOWN');
    assert.deepEqual(stagesRun(engine), [1, 9]);
    assert.deepEqual(await f.ledger.pendingAttempts2(), []);
    assert.ok(!f.companion.calls.some(c => c[0] === 'wsprep'));
    await f.exec.tick();
    assert.deepEqual(stagesRun(engine), [1, 9]);
  }
});

test('failed StageR malformed/foreign/reordered packets cannot mint partial publication receipts', async t => {
  const halt = { role: 'trivy', outcome: 'HALT', reason: 'RELAY_PUBLICATION_UNCERTAIN', receipt: null,
    checkRunId: null, externalId: null, attestationSha256: null, detail: null };
  const good = () => [relayedRow('gitleaks'), { ...halt }];
  const invalid = [() => [relayedRow('gitleaks')], () => [relayedRow('trivy'), { ...halt, role: 'gitleaks' }],
    () => [{ ...relayedRow('gitleaks'), rawToken: 'SECRET_NO_RECEIPT' }, halt],
    () => [{ ...relayedRow('gitleaks'), externalId: relayedRow('gitleaks', 'f'.repeat(40)).externalId }, halt],
    () => [relayedRow('gitleaks'), { ...halt, checkRunId: 1 }],
    () => [relayedRow('gitleaks'), { ...halt, reason: 'SECRET_NOT_A_HALT_CODE' }],
    () => [{ ...relayedRow('gitleaks'), detail: { token: 'SECRET_NO_RECEIPT' } }, halt],
    () => [{ ...halt, role: 'gitleaks' }, relayedRow('trivy')],
    () => [{ ...halt, role: 'gitleaks', outcome: 'NOT_PROCESSED', reason: null }, relayedRow('trivy')],
    () => { const rows = good(); rows.extra = 'SECRET_NO_RECEIPT'; return rows; }];
  for (const create of invalid) {
    const engine = fakeEngine({ relay: () => ({ ok: false, code: 'RELAY_PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, relay: create() }) });
    const f = await executorFixture(t, { engine, policy: ON, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
    await f.drop(triggerBytes()); const result = await f.exec.tick();
    assert.equal(result.state, 'HALTED');
    assert.deepEqual(await receiptBodies(f, 'relay-attested'), []);
    assert.deepEqual(stagesRun(engine), [1, 9]);
    assert.equal((await f.ledger.state(result.key)).plan, null);
    assert.equal(JSON.stringify(await receiptBodies(f, 'stage-terminal')).includes('SECRET'), false);
  }
});
