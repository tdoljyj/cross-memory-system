// The node mode (resident primary/standby design v0.4 §5.2, §8.2, §9 C3; Task 17b703a0; DESIGN §29): ACTIVE, STANDBY or UNCERTAIN.
// A start and an Owner re-arm begin UNCERTAIN with the role probe due at once; a probe says held (ACTIVE), not-held (STANDBY) or
// uncertain (the mode stays); stage 1's NODE_ROLE_NOT_HELD goes to STANDBY; while the mode is not ACTIVE nothing new starts, and a
// batch in flight goes on; a failure that may mean the role is gone makes the next probe due at once; status.json /6 carries it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor, NODE_DEFERRALS, PAUSE_CONTRACT, ROLE_LOST_SUSPECT_CODES } from '../src/executor.mjs';
import { StatusBoard, StatusFile, STATUS_CONTRACT, STATUS_CONTRACTS_READABLE, STATUS_STALE_MS, parseStatus, readStatus } from '../src/status.mjs';
import { nodeOf, stallCode } from '../src/node-duty.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { intakePauseRequest } from '../src/intake-pause.mjs';
import { rearmRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, CI_SOURCE, HEAD, RELAY_ON, SAFE_REFUSAL, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, notAdmitted, rawPolicy, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-29T08:00:00Z');
const OWNER = 'S-1-5-21-1-2-3-1001';
const H = n => String(n).repeat(40).slice(0, 40);
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const pick = r => [r.state, r.reason];
const derives = f => f.engine.calls.filter(c => c[0] === 'derive').length;
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const json = v => Buffer.from(JSON.stringify(v));

const HELD = { result: 'held', code: 'ROLE_PROBE_HELD' };
const NOT_HELD = { result: 'not-held', code: 'ROLE_PROBE_NOT_HELD' };
const UNCERTAIN = { result: 'uncertain', code: 'ROLE_PROBE_UNCERTAIN' };
const probeResult = fact => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true }, roleProbe: fact,
  outcome: { status: 'BLOCKED', reason: fact.code, sideEffects: 0, mayHavePublished: false } });

// An executor whose engine can probe the role (so the node mode is on). facts: the probe's answers in order, the last one repeats.
async function nodeFx(t, { facts = [HELD], engine = fakeEngine(), hint = null, ...rest } = {}) {
  engine.facts = [...facts];
  engine.probes = [];
  engine.runRoleProbe = async () => { const fact = engine.facts.length > 1 ? engine.facts.shift() : engine.facts[0]; engine.probes.push(fact.result); return probeResult(fact); };
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  // hint: the companion's hosted hint (a function of the subject), on the fixture's own clock so its heartbeat is fresh
  if (hint) rest.companion = fakeCompanion({ hint }, () => f?.clock() ?? T0);
  f = await executorFixture(t, { engine, status: board, now: T0, ...rest });
  f.board = board;
  return f;
}
const receiptBodies = async (f, type) => {
  const dir = path.join(f.root, 'state', 'receipts');
  const out = [];
  for (const n of (await fs.readdir(dir)).sort()) if (n.endsWith(`-${type}.json`)) out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')).body);
  return out;
};
// A stage-1 answer per PR, over the default engine (scheduler.test.mjs does the same).
const perPr = (per, base = fakeEngine()) => {
  const run = base.runStage;
  base.runStage = async (batch, stage, o) => {
    if (stage.number === 1 && per[batch.pr]) { base.calls.push(['stage', 1]); return per[batch.pr]; }
    return run(batch, stage, o);
  };
  const derive = base.derive;
  base.derive = async (s, key) => ({ ...(await derive(s, key)), pr: s.pr });
  return base;
};
const NO_ROLE = { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: ['admission_binding_required'] } };
const WAIT = { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: ['merge_slot_required'] } };
const notReady = code => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null } }, safeToRerun: false } });

// ---- the mode ----

test('a start begins UNCERTAIN with the probe due at once: no trigger is taken before the probe says held', async t => {
  const f = await nodeFx(t);
  assert.equal(f.exec.roleProbeMode, 'UNCERTAIN');
  assert.deepEqual(f.board.content.node, { name: 'fixture-node', source: CI_SOURCE.slice(0, 12), mode: 'UNCERTAIN', probe: null }, 'shown from the start');
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.deepEqual(pick(first), ['DEFERRED', 'NODE_ROLE_UNCERTAIN']);
  assert.deepEqual(f.engine.probes, ['held'], 'the probe came at once, in the same quiet tick');
  assert.equal(derives(f), 0, 'no batch, no bundle, no stage 1');
  assert.equal(f.exec.roleProbeMode, 'ACTIVE');
  assert.deepEqual([f.board.content.node.mode, f.board.content.node.probe.result], ['ACTIVE', 'held']);
  assert.equal(f.queue.row(884).state, 'QUEUED', 'the trigger was read, not lost');
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'the next tick takes it');
  assert.deepEqual(await receiptBodies(f, 'node-mode'), [{ from: 'UNCERTAIN', to: 'ACTIVE', why: 'probe-held' }]);
});

test('not-held makes the node STANDBY: nothing is taken, the probe comes every 15 minutes, a later held brings it back', async t => {
  const f = await nodeFx(t, { facts: [NOT_HELD, NOT_HELD, HELD] });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.equal(f.exec.roleProbeMode, 'STANDBY');
  assert.equal(f.board.content.node.mode, 'STANDBY');
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
  assert.equal(f.engine.probes.length, 1, 'not due again at once');
  f.advance(15 * MIN - 1);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
  assert.equal(f.engine.probes.length, 1);
  f.advance(1);
  await f.exec.tick();
  assert.deepEqual([f.engine.probes.length, f.exec.roleProbeMode], [2, 'STANDBY']);
  assert.equal(derives(f), 0, 'a STANDBY node starts nothing, whatever is queued');
  f.advance(15 * MIN);
  await f.exec.tick();
  assert.deepEqual([f.engine.probes, f.exec.roleProbeMode], [['not-held', 'not-held', 'held'], 'ACTIVE']);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual((await receiptBodies(f, 'node-mode')).map(b => `${b.from}>${b.to}`), ['UNCERTAIN>STANDBY', 'STANDBY>ACTIVE']);
});

test('an uncertain probe keeps the mode: UNCERTAIN at a start, ACTIVE, STANDBY alike', async t => {
  // At a start there is no definite answer yet: still UNCERTAIN, nothing taken, and the urgent probe is spent (next in 15 minutes).
  const a = await nodeFx(t, { facts: [UNCERTAIN, HELD] });
  await a.drop(triggerBytes());
  assert.deepEqual(pick(await a.exec.tick()), ['DEFERRED', 'NODE_ROLE_UNCERTAIN']);
  assert.deepEqual([a.exec.roleProbeMode, a.board.content.node.mode, a.board.content.node.probe.result], ['UNCERTAIN', 'UNCERTAIN', 'uncertain']);
  await a.exec.tick();
  assert.equal(a.engine.probes.length, 1, 'no probe at every tick');
  a.advance(15 * MIN);
  await a.exec.tick();
  assert.equal(a.exec.roleProbeMode, 'ACTIVE');
  // ACTIVE stays ACTIVE and goes on taking triggers.
  const b = await nodeFx(t, { facts: [HELD, UNCERTAIN] });
  await b.exec.tick();
  b.advance(30 * MIN);
  await b.exec.tick();
  assert.deepEqual([b.engine.probes, b.exec.roleProbeMode], [['held', 'uncertain'], 'ACTIVE']);
  await b.drop(triggerBytes());
  assert.equal((await b.exec.tick()).state, 'COMPLETED');
  // STANDBY stays STANDBY.
  const c = await nodeFx(t, { facts: [NOT_HELD, UNCERTAIN] });
  await c.exec.tick();
  c.advance(15 * MIN);
  await c.exec.tick();
  assert.deepEqual([c.engine.probes, c.exec.roleProbeMode], [['not-held', 'uncertain'], 'STANDBY']);
  await c.drop(triggerBytes());
  assert.deepEqual(pick(await c.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
  assert.deepEqual(await receiptBodies(a, 'node-mode'), [{ from: 'UNCERTAIN', to: 'ACTIVE', why: 'probe-held' }], 'an uncertain answer changes nothing, so records nothing');
});

test('a restart begins UNCERTAIN again and probes at once, although the last probe was a minute ago', async t => {
  const f = await nodeFx(t);
  await f.exec.tick();
  assert.equal(f.exec.roleProbeMode, 'ACTIVE');
  f.advance(MIN);
  const restarted = new ResidentExecutor(f.ports);
  assert.equal(restarted.roleProbeMode, 'UNCERTAIN');
  assert.equal(f.board.content.node.mode, 'UNCERTAIN', 'the status shows it at once');
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await restarted.tick()), ['DEFERRED', 'NODE_ROLE_UNCERTAIN']);
  assert.equal(f.engine.probes.length, 2, 'not the 30 minutes of an ACTIVE node');
  assert.equal(restarted.roleProbeMode, 'ACTIVE');
  assert.equal(derives(f), 0);
  assert.equal((await restarted.tick()).state, 'COMPLETED');
});

test('an Owner re-arm that cleared a HALT begins UNCERTAIN again, with the probe due at once', async t => {
  const f = await nodeFx(t, { facts: [HELD, UNCERTAIN, HELD] });
  await f.exec.tick();
  assert.equal(f.exec.roleProbeMode, 'ACTIVE');
  await f.ledger.halt('X_Y', {});
  const h = await f.ledger.halted();
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'checked', by: OWNER }), f.clock);
  await f.drop(triggerBytes());
  f.advance(1);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_ROLE_UNCERTAIN'], 'the probe after the re-arm was uncertain: no trigger');
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual([f.engine.probes, f.exec.roleProbeMode, derives(f)], [['held', 'uncertain'], 'UNCERTAIN', 0]);
  assert.deepEqual((await receiptBodies(f, 'node-mode'))[1], { from: 'ACTIVE', to: 'UNCERTAIN', why: 'rearm' });
  f.advance(15 * MIN);
  await f.exec.tick();
  assert.equal(f.exec.roleProbeMode, 'ACTIVE');
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('an engine that cannot probe the role is the single node it always was: no gate, no status node, no mode receipts', async t => {
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { status: board, now: T0 });
  await f.drop(triggerBytes());
  assert.equal(board.content.node, null);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(board.content.node, null);
  assert.deepEqual(await receiptBodies(f, 'node-mode'), []);
});

// ---- NODE_ROLE_NOT_HELD ----

for (const [form, answer] of [['NODE_ROLE_NOT_HELD', notAdmitted('NODE_ROLE_NOT_HELD', NO_ROLE)], ['NATIVE_NOT_ADMITTED with admission_binding_required (an older Source)', notAdmitted('NATIVE_NOT_ADMITTED', NO_ROLE)],
  ['NATIVE_NOT_ADMITTED with admission_binding_required beside a deterministic reason', notAdmitted('NATIVE_NOT_ADMITTED', { ...NO_ROLE, diagnostic: { ...NO_ROLE.diagnostic, reasonCodes: ['admission_binding_required', 'protected_change_not_up_to_date'] } })]]) {
  test(`stage 1 ${form}: STANDBY, released, no evaluation and no release counted, the row waits and is never stopped`, async t => {
    const f = await nodeFx(t, { engine: fakeEngine({ stages: { 1: answer } }), facts: [HELD] });
    await f.exec.tick();
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode, r.release], ['NOT_ADMITTED', answer.code, 'NOT_ADMITTED']);
    assert.deepEqual([f.exec.roleProbeMode, f.board.content.node.mode], ['STANDBY', 'STANDBY']);
    assert.equal(await f.ledger.headBurned(headKey(subject())), false, 'nothing about the PR was decided');
    const u = await f.ledger.usage(0);
    assert.deepEqual([u.evaluations, u.releasesByHead.size, u.started], [0, 0, 0]);
    assert.deepEqual([f.queue.row(884).state, f.queue.row(884).reason, f.queue.row(884).stopKind], ['BACKOFF', answer.code, null]);
    assert.deepEqual([f.board.content.recent[0].outcome, f.board.content.recent[0].class, f.board.content.recent[0].retry], ['NOT_ADMITTED', 'node-role', 'new-trigger']);
    assert.deepEqual((await receiptBodies(f, 'node-mode')).at(-1), { from: 'ACTIVE', to: 'STANDBY', why: 'role-not-held' });
    assert.equal((await f.exec.tick()).state, 'IDLE', 'the row waits in its back-off');
    f.advance(11 * MIN);
    assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_STANDBY'], 'due, but a STANDBY node starts nothing');
    assert.equal(derives(f), 1);
    // The role comes back and goes again three times (the head's release cap is 2): the row is never stopped and nothing is counted.
    for (let i = 0; i < 3; i++) {
      await f.exec.setNodeMode('ACTIVE', 'test');
      f.advance(41 * MIN);
      assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED', `round ${i + 1}`);
      assert.equal(f.exec.roleProbeMode, 'STANDBY');
      assert.equal(f.queue.row(884).state, 'BACKOFF');
    }
    const after = await f.ledger.usage(0);
    assert.deepEqual([after.evaluations, after.releasesByHead.size], [0, 0]);
    assert.equal(derives(f), 4, 'one batch for the first release, one for each round');
  });
}

test('a node that holds no role never has a PR burned for it: a stage-1 answer without the safe-to-rerun flag still burns like any other', async t => {
  const f = await nodeFx(t, { engine: fakeEngine({ stages: { 1: notAdmitted('NODE_ROLE_NOT_HELD', { ...NO_ROLE, safeToRerun: false }) } }), facts: [HELD] });
  await f.exec.tick();
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.notEqual(r.state, 'NOT_ADMITTED', 'no flag, no release: the existing rule');
  assert.equal(f.exec.roleProbeMode, 'STANDBY', 'but the node is no longer on duty');
});

// ---- the immediate probe ----

for (const [name, stage, answer, urgent] of [
  ['PUBLICATION_BLOCKED at stage 3', 3, { ok: false, code: 'PUBLICATION_BLOCKED', proof: WINDOWS_CLEAN }, true],
  ['a refused live admission after stage 1 (BATCH_CLAIM_CHANGED at stage 5)', 5, { ok: false, code: 'BATCH_CLAIM_CHANGED', proof: WINDOWS_CLEAN }, true],
  ['a not-admitted code after stage 1 (PR_NOT_OPEN_OR_CHANGED at stage 3)', 3, { ok: false, code: 'PR_NOT_OPEN_OR_CHANGED', proof: WINDOWS_CLEAN }, true],
  ['a not-admitted answer at stage 1 (CLAIM_NOT_CURRENT)', 1, notAdmitted('CLAIM_NOT_CURRENT', { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: ['claim_not_found'] } }), false],
  ['an unrelated clean ending after stage 1 (STAGE_CHILD_TIMEOUT at stage 4)', 4, { ok: false, code: 'STAGE_CHILD_TIMEOUT', proof: WINDOWS_CLEAN }, false],
]) {
  test(`${name}: ${urgent ? 'the next quiet tick probes at once' : 'the probe keeps its own interval'}`, async t => {
    const f = await nodeFx(t, { engine: fakeEngine({ stages: { [stage]: answer } }), facts: [HELD] });
    await f.exec.tick();
    assert.equal(f.engine.probes.length, 1);
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.ok(['FAILED_CLEAN', 'NOT_ADMITTED'].includes(r.state), r.state);
    assert.equal(f.engine.probes.length, 1, 'the batch tick itself never probes');
    f.advance(MIN);
    await f.exec.tick();
    assert.equal(f.engine.probes.length, urgent ? 2 : 1, 'not waiting for the 30 minutes of an ACTIVE node');
    assert.equal(f.exec.roleProbeMode, 'ACTIVE');
  });
}

test('the immediate probe waits for the executor to be idle: with a batch at a parking point nothing probes until it ends', async t => {
  let tries = 0;
  const engine = fakeEngine();
  const run = engine.runStage, derive = engine.derive;
  engine.derive = async (s, key) => ({ ...(await derive(s, key)), pr: s.pr });
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 8 && batch.pr === 884 && tries++ === 0) { engine.calls.push(['stage', 8]); return notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'); }
    if (stage.number === 3 && batch.pr === 900) { engine.calls.push(['stage', 3]); return { ok: false, code: 'PUBLICATION_BLOCKED', proof: WINDOWS_CLEAN }; }
    return run(batch, stage, o);
  };
  const f = await nodeFx(t, { engine, facts: [HELD] });
  await f.exec.tick();
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  // PR 900 is refused by a publisher after stage 1: the probe is due at once, but PR 884 still rests at B (an open batch)
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.equal(f.engine.probes.length, 1, 'a batch is open: no probe');
  f.advance(10 * MIN);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'PR 884\'s stage-8 try finishes it');
  assert.equal(f.engine.probes.length, 1);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.equal(f.engine.probes.length, 2, 'idle now: the pending immediate probe runs, well before the 30 minutes of an ACTIVE node');
});

// ---- STANDBY and UNCERTAIN behave alike; a batch in flight goes on ----

test('STANDBY: a batch parked at B keeps trying stage 8, a batch waiting at A goes on; a new PR, a due wait and a due attempt 2 start nothing', async t => {
  // B: PR 884 parks; PR 900 is told it has no role (STANDBY) while PR 884 rests; PR 884 finishes its stage-8 try meanwhile.
  let tries = 0;
  const engine = perPr({ 900: notAdmitted('NODE_ROLE_NOT_HELD', NO_ROLE) });
  const run = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 8 && batch.pr === 884 && tries++ === 0 ? (engine.calls.push(['stage', 8]), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')) : run(batch, stage, o));
  const f = await nodeFx(t, { engine, facts: [HELD] });
  await f.exec.tick();
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  assert.equal(f.exec.roleProbeMode, 'STANDBY');
  await f.drop(triggerBytes({ pr: 901, headSha: H(5) }));
  const before = derives(f);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_STANDBY'], 'PR 901 and the released PR 900 wait');
  assert.equal(derives(f), before);
  f.advance(10 * MIN);
  const done = await f.exec.tick();
  assert.equal(done.state, 'COMPLETED', 'PR 884 is in flight: its stage-8 try runs under STANDBY');
  assert.equal(done.key, batchKey(subject()));
  assert.equal(derives(f), before, 'nothing new started');
  f.advance(60 * MIN);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
  assert.equal(derives(f), before);
  assert.deepEqual(['QUEUED'], [f.queue.row(901).state]);

  // A: a batch waiting for hosted signals is resumed and finishes; the tick's result stays WAITING with the batch in the status.
  // no usable hint: the signal window, then local
  const g = await nodeFx(t, { policy: rawPolicy({ relay: RELAY_ON }), hint: () => Buffer.from('{"contract":"x"}'), facts: [HELD] });
  await g.exec.tick();
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  await g.exec.setNodeMode('STANDBY', 'test');
  await g.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  g.advance(MIN);
  const waiting = await g.exec.tick();
  assert.equal(waiting.state, 'WAITING', 'the batch at A stays the tick\'s result under STANDBY');
  assert.equal(g.board.content.current?.pr, 884, 'and the status\'s batch in flight');
  assert.equal(derives(g), 1);
  g.advance(RELAY_ON.wait.signalMs);
  assert.equal((await g.exec.tick()).state, 'COMPLETED', 'it continues to its end; live admission decides');
  assert.equal(derives(g), 1, 'PR 900 never started');
  assert.deepEqual(pick(await g.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
});

test('STANDBY starts no attempt 2 and no waiting-retry when they fall due; ACTIVE again runs them', async t => {
  // attempt 2: a transient stage-2 ending before any role was published schedules it after the policy delay (10 minutes)
  const a = await nodeFx(t, { engine: fakeEngine({ stages: { 2: { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN } } }), facts: [HELD] });
  await a.exec.tick();
  await a.drop(triggerBytes());
  const first = await a.exec.tick();
  assert.equal(first.state, 'FAILED_CLEAN');
  assert.match(first.attempt2 ?? '', /^[0-9a-f]{64}$/);
  await a.exec.setNodeMode('STANDBY', 'test');
  a.advance(11 * MIN);
  assert.deepEqual(pick(await a.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
  assert.equal(derives(a), 1);
  assert.equal((await a.ledger.pendingAttempts2()).length, 1, 'still pending, not lost');
  await a.exec.setNodeMode('ACTIVE', 'test');
  await a.exec.tick();
  assert.equal(derives(a), 2, 'attempt 2 ran once the node was ACTIVE again');

  // a wait (Native says not yet) is retried on its own after its back-off
  const w = await nodeFx(t, { engine: fakeEngine({ stages: { 1: notAdmitted('NATIVE_NOT_ADMITTED', WAIT) } }), facts: [HELD] });
  await w.exec.tick();
  await w.drop(triggerBytes());
  assert.equal((await w.exec.tick()).state, 'NOT_ADMITTED');
  assert.equal(w.queue.row(884).state, 'WAITING');
  await w.exec.setNodeMode('STANDBY', 'test');
  w.advance(11 * MIN);
  assert.deepEqual(pick(await w.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
  assert.equal(derives(w), 1);
  await w.exec.setNodeMode('ACTIVE', 'test');
  assert.equal((await w.exec.tick()).state, 'NOT_ADMITTED');
  assert.equal(derives(w), 2, 'the retry ran once the node was ACTIVE again');
  assert.equal(w.queue.row(884).origin, 'waiting-retry');
});

test('the deferral reasons are fixed codes and a quiet result: the probe and stage 10 still run', async t => {
  assert.deepEqual(NODE_DEFERRALS, { STANDBY: 'NODE_STANDBY', UNCERTAIN: 'NODE_ROLE_UNCERTAIN' });
  const f = await nodeFx(t, { policy: rawPolicy({ train: { enabled: 'shadow', nonFrontRuns: true, maintenanceEveryMs: 600_000, maintenanceMaxPerDay: 200 } }), facts: [NOT_HELD] });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.equal(f.exec.roleProbeMode, 'STANDBY');
  const trainRuns = () => f.engine.calls.filter(c => c[0] === 'stage' && c[1] === 10).length;
  assert.equal(trainRuns(), 1, 'stage 10 ran in the quiet tick that made the node STANDBY');
  f.advance(10 * MIN);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
  assert.equal(trainRuns(), 2, 'stage 10 asks the server for the duty itself (NOT_ON_DUTY); it is not held by the mode');
  assert.equal(stagesRun(f.engine).filter(n => n !== 10).length, 0, 'but no batch stage ran');
  assert.ok(ROLE_LOST_SUSPECT_CODES.includes('PUBLICATION_BLOCKED') && ROLE_LOST_SUSPECT_CODES.includes('NODE_ROLE_NOT_HELD') && ROLE_LOST_SUSPECT_CODES.includes('BATCH_CLAIM_CHANGED'));
});

// ---- status.json /6 and the companion ----

test('status /6: node carries name, source (12 hex), mode and the last probe; the companion reads it; the old /5 file is still read', async t => {
  assert.equal(STATUS_CONTRACT, 'clued.independent-ci.resident-status/6');
  assert.deepEqual([...STATUS_CONTRACTS_READABLE], ['clued.independent-ci.resident-status/5', 'clued.independent-ci.resident-status/6']);
  const f = await nodeFx(t, { facts: [HELD] });
  const file = new StatusFile(path.join(f.root, 'state', 'status.json'));
  // a start: UNCERTAIN, no probe yet; the companion reads "not on duty" (停摆 NODE_ROLE_UNCERTAIN)
  await file.write(f.board.snapshot());
  const started = await readStatus(f.root);
  assert.deepEqual(started.node, { name: 'fixture-node', source: CI_SOURCE.slice(0, 12), mode: 'UNCERTAIN', probe: null });
  const fresh = { ...started, writtenAt: f.clock(), executor: { ...started.executor, state: 'IDLE' } };
  assert.deepEqual(nodeOf(started), { name: 'fixture-node', mode: 'UNCERTAIN', probe: null, known: true });
  assert.equal(stallCode(fresh, nodeOf(started), f.clock(), STATUS_STALE_MS), 'NODE_ROLE_UNCERTAIN');
  // after the probe: ACTIVE, the probe's time and result; on duty
  await f.exec.tick();
  await file.write(f.board.snapshot());
  const raw = JSON.parse(await fs.readFile(path.join(f.root, 'state', 'status.json'), 'utf8'));
  assert.equal(raw.contract, 'clued.independent-ci.resident-status/6');
  assert.deepEqual(Object.keys(raw.node).sort(), ['mode', 'name', 'probe', 'source']);
  assert.match(raw.node.source, /^[0-9a-f]{12}$/);
  const s = await readStatus(f.root);
  assert.deepEqual(s.node, { name: 'fixture-node', source: CI_SOURCE.slice(0, 12), mode: 'ACTIVE', probe: { at: f.clock(), result: 'held', failures: 0, failingSince: null } });
  const duty = nodeOf(s);
  assert.deepEqual([duty.name, duty.mode, duty.known, duty.probe.result], ['fixture-node', 'ACTIVE', true, 'held']);
  assert.equal(stallCode({ ...s, writtenAt: f.clock() }, duty, f.clock(), STATUS_STALE_MS), null, 'a node that probed held and has nothing wrong is on duty');
  // STANDBY after not-held
  const g = await nodeFx(t, { facts: [NOT_HELD] });
  await g.exec.tick();
  assert.equal(nodeOf(parseStatus(Buffer.from(JSON.stringify(g.board.snapshot())))).mode, 'STANDBY');
  // the /5 file of the executor that was running before the install: still read (no source); other contracts are refused
  const old = { ...JSON.parse(JSON.stringify(g.board.snapshot())), contract: 'clued.independent-ci.resident-status/5' };
  delete old.node.source;
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify(old))).node, { name: 'fixture-node', source: null, mode: 'STANDBY', probe: parseStatus(Buffer.from(JSON.stringify(old))).node.probe });
  for (const contract of ['clued.independent-ci.resident-status/4', 'clued.independent-ci.resident-status/7']) {
    assert.throws(() => parseStatus(Buffer.from(JSON.stringify({ ...old, contract }))), { code: 'STATUS_REFUSED' }, contract);
  }
  // a source that does not fit is no source
  const odd = JSON.parse(JSON.stringify(g.board.snapshot()));
  odd.node.source = 'NOT-HEX';
  assert.equal(parseStatus(Buffer.from(JSON.stringify(odd))).node.source, null);
});

test('N3: the executor writes the breaker and the intake pause into status.json, also under PAUSE and HALT; the companion reads both as not on duty', async t => {
  const burn = { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN };
  const f = await nodeFx(t, { engine: fakeEngine({ stages: { 1: burn } }), facts: [HELD] });
  await f.exec.tick();
  for (const n of [1, 2, 3]) { await f.drop(triggerBytes({ pr: n, headSha: H(n) })); assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN', `PR ${n}`); }
  // breaker open
  await f.drop(triggerBytes({ pr: 4, headSha: H(4) }));
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'BREAKER_OPEN']);
  const snap = () => parseStatus(Buffer.from(JSON.stringify(f.board.snapshot())));
  assert.equal(f.board.snapshot().breaker.state, 'open');
  assert.deepEqual([snap().breaker.state, snap().breaker.nextTrialAt > f.clock(), snap().breaker.openedAt <= f.clock()], ['open', true, true]);
  const onDuty = s => stallCode({ ...s, writtenAt: f.clock() }, nodeOf(s), f.clock(), STATUS_STALE_MS);
  assert.equal(onDuty(snap()), 'BREAKER_OPEN');
  // an intake pause, and PAUSE on top: both are written while the executor is PAUSED
  await f.drop(json(intakePauseRequest({ minutes: 30, reason: 'planned switch' }, f.clock)), 'requests');
  await f.drop(Buffer.from(JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'Owner away' })), 'requests');
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  const paused = snap();
  assert.equal(paused.paused, true);
  assert.deepEqual([paused.intakePause?.holders.map(h => h.holder), paused.intakePause?.until > f.clock(), paused.breaker.state], [['owner'], true, 'open']);
  assert.equal(onDuty(paused), 'PAUSED');
  assert.equal(onDuty({ ...paused, paused: false }), 'INTAKE_PAUSED');
  // and under HALT: the HALT code first, the two fields still there
  await f.ledger.halt('X_Y', {});
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const halted = snap();
  assert.deepEqual([halted.halt.code, halted.intakePause !== null, halted.breaker.state], ['X_Y', true, 'open']);
  assert.equal(onDuty(halted), 'X_Y');
});
