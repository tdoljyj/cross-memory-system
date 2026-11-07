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
import { pauseRequestBytes } from '../upgrader/src/resident-ports.mjs';
import { refusalSafeToRerun } from '../../actions-hosted-migration/independent-ci-v1/src/formal-work-admission-check-v2/publisher.mjs';
import { BASE, CI_SOURCE, HEAD, RELAY_ON, SAFE_REFUSAL, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, hintFor, relayedRow, notAdmitted, rawPolicy, triggerBytes } from './helpers.mjs';

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

test('an exact upgrade pause permits a fresh read-only probe but keeps queued work and the pause intact', async t => {
  const f = await nodeFx(t, { facts: [NOT_HELD] });
  const bytes = pauseRequestBytes('5e1f0000-0000-4000-8000-000000000001', 50);
  await f.drop(bytes, 'requests');
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  const pause = await f.ledger.paused();
  assert.deepEqual(f.engine.probes, ['not-held']);
  assert.equal(f.exec.roleProbe.last.at, f.clock());
  assert.equal(f.exec.roleProbeMode, 'STANDBY');
  assert.equal(derives(f), 0);
  assert.equal(stagesRun(f.engine).length, 0);
  assert.equal(await f.ledger.paused().then(p => p.sha256), pause.sha256);
  assert.equal((await fs.readdir(path.join(f.root, 'inbox'))).length, 1, 'no intake under pause');
  await f.exec.tick();
  assert.equal(f.engine.probes.length, 1, 'the ordinary cadence still applies');
});

test('ordinary, forged and torn pauses, HALT, open work and an engine busy deferral do not turn the upgrade probe into work', async t => {
  for (const kind of ['ordinary', 'forged', 'torn', 'halt', 'open', 'busy']) {
    const f = await nodeFx(t);
    const reason = 'resident-upgrade 5e1f0000-0000-4000-8000-000000000001 50';
    const bytes = pauseRequestBytes('5e1f0000-0000-4000-8000-000000000001', 50);
    await f.ledger.pause({ reason: kind === 'ordinary' ? 'owner pause' : reason,
      requestSha256: kind === 'forged' ? '0'.repeat(64) : (await import('../src/canonical.mjs')).sha256(bytes) });
    if (kind === 'torn') await fs.writeFile(path.join(f.root, 'state', 'PAUSED.json'), '{');
    if (kind === 'halt') await f.ledger.halt('FIXTURE_HALT', {});
    if (kind === 'open') f.ledger.open = async () => [{ key: 'still-open' }];
    if (kind === 'busy') f.engine.runRoleProbe = async () => ({ deferred: true, code: 'ROLE_PROBE_BUSY' });
    const result = kind === 'open' ? (await f.exec.roleProbeMaintenance({ upgradePaused: true })) ?? { state: 'PAUSED' }
      : await f.exec.tick();
    assert.equal(result.state, kind === 'halt' ? 'HALTED' : 'PAUSED', kind);
    assert.equal(f.engine.probes.length, 0, kind);
    assert.ok(await f.ledger.paused());
    assert.equal(derives(f), 0, kind);
    if (kind === 'busy') assert.equal(await f.ledger.halted(), null);
  }
});
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

// The facts are what the Source's publisher really writes: refusalSafeToRerun is its flag, true beside a deterministic reason now.
const noRoleWith = reasonCodes => ({ ...NO_ROLE, safeToRerun: refusalSafeToRerun({ step: 'boundary', claimed: null, reason: 'full_admission_rejected', diagnostic: { reasonCodes } }),
  diagnostic: { ...NO_ROLE.diagnostic, reasonCodes } });
for (const [form, answer] of [['NODE_ROLE_NOT_HELD', notAdmitted('NODE_ROLE_NOT_HELD', NO_ROLE)], ['NATIVE_NOT_ADMITTED with admission_binding_required (an older Source)', notAdmitted('NATIVE_NOT_ADMITTED', NO_ROLE)],
  ['NODE_ROLE_NOT_HELD beside a deterministic reason (protected_change_not_up_to_date)', notAdmitted('NODE_ROLE_NOT_HELD', noRoleWith(['admission_binding_required', 'protected_change_not_up_to_date']))],
  ['NODE_ROLE_NOT_HELD beside a deterministic reason (changed_files_truncated)', notAdmitted('NODE_ROLE_NOT_HELD', noRoleWith(['admission_binding_required', 'changed_files_truncated']))]]) {
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

test('an older Source beside a deterministic reason: its flag is false, so the head is burned as before C3, and the node still goes STANDBY', async t => {
  const old = { ...NO_ROLE, safeToRerun: false, diagnostic: { ...NO_ROLE.diagnostic, reasonCodes: ['admission_binding_required', 'protected_change_not_up_to_date'] } };
  const f = await nodeFx(t, { engine: fakeEngine({ stages: { 1: notAdmitted('NATIVE_NOT_ADMITTED', old) } }), facts: [HELD] });
  await f.exec.tick();
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.notEqual(r.state, 'NOT_ADMITTED');
  assert.deepEqual([f.exec.roleProbeMode, await f.ledger.headBurned(headKey(subject()))], ['STANDBY', true]);
});

test('a node that holds no role never has a PR burned for it: a stage-1 answer without the safe-to-rerun flag still burns like any other', async t => {
  const f = await nodeFx(t, { engine: fakeEngine({ stages: { 1: notAdmitted('NODE_ROLE_NOT_HELD', { ...NO_ROLE, safeToRerun: false }) } }), facts: [HELD] });
  await f.exec.tick();
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.notEqual(r.state, 'NOT_ADMITTED', 'no flag, no release: the existing rule');
  assert.equal(f.exec.roleProbeMode, 'STANDBY', 'but the node is no longer on duty');
});

test('m1: a node-role release is no new-trigger re-evaluation either (the cap of 6 a day per commit counts decisions about the PR)', async t => {
  const f = await executorFixture(t);
  for (const [n, klass] of [[1, 'node-role'], [2, 'not-admitted']]) {
    const sj = subject({ headSha: H(n) }), key = batchKey(sj);
    await f.ledger.reserve(key, sj, { origin: 'new-trigger' });
    await f.ledger.releaseUnexecuted(key, 'NOT_ADMITTED', { failureCode: 'X_Y', class: klass });
  }
  const u = await f.ledger.usage(0);
  assert.deepEqual([...u.reevaluations], [[`884:${H(2)}`, 1]]);
  assert.deepEqual([u.evaluations, [...u.releasesByHead]], [1, [[H(2), 1]]]);
});

// An engine whose attempt 1 ends in a transient stage-2 failure (so attempt 2 is scheduled) and whose attempt 2 meets `refuse` at stage 1.
function attempt2Engine(refuse) {
  const engine = fakeEngine({ stages: { 2: { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN } } });
  const run = engine.runStage, derive = engine.derive;
  engine.attempts = [];
  engine.refuse = [...refuse];
  engine.derive = async (s, key) => { engine.attempts.push(s.attempt); return { ...(await derive(s, key)), attempt: s.attempt }; };
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1 && batch.attempt === 2 && engine.refuse.length) { engine.calls.push(['stage', 1]); return engine.refuse.shift(); }
    return run(batch, stage, o);
  };
  return engine;
}

test('m2: a node-role release of attempt 2 gives the same attempt 2 back (never an attempt 3); any other release still spends it', async t => {
  const f = await nodeFx(t, { engine: attempt2Engine([notAdmitted('NODE_ROLE_NOT_HELD', NO_ROLE)]), facts: [HELD] });
  await f.exec.tick();
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.equal(first.state, 'FAILED_CLEAN');
  const key2 = first.attempt2;
  assert.match(key2, /^[0-9a-f]{64}$/);
  f.advance(11 * MIN);
  const second = await f.exec.tick();
  assert.deepEqual([second.state, second.failureCode, f.exec.roleProbeMode], ['NOT_ADMITTED', 'NODE_ROLE_NOT_HELD', 'STANDBY']);
  assert.deepEqual((await f.ledger.pendingAttempts2()).map(a => a.key2), [key2], 'the same attempt 2 is pending again');
  assert.deepEqual(await receiptBodies(f, 'attempt2-reopened'), [{ key: key2, attempt1: first.key }]);
  // STANDBY runs nothing; once the node is ACTIVE again (and the 10-minute cool-down is over) attempt 2 runs, with the same key
  f.advance(11 * MIN);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_STANDBY']);
  assert.deepEqual(f.engine.attempts, [1, 2]);
  await f.exec.setNodeMode('ACTIVE', 'test');
  const third = await f.exec.tick();
  assert.deepEqual([third.state, third.key, third.attempt2], ['FAILED_CLEAN', key2, undefined], 'it ends like attempt 2 does, and schedules no attempt 3');
  assert.deepEqual(f.engine.attempts, [1, 2, 2]);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  for (let i = 0; i < 3; i++) { f.advance(60 * MIN); await f.exec.tick(); }
  assert.deepEqual(f.engine.attempts, [1, 2, 2], 'nothing runs again without a new commit');
  // any other release of attempt 2 stays spent (review MAJOR 1)
  const g = await nodeFx(t, { engine: attempt2Engine([notAdmitted('PATHS_OUTSIDE_WRITE_SET')]), facts: [HELD] });
  await g.exec.tick();
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'FAILED_CLEAN');
  g.advance(11 * MIN);
  assert.equal((await g.exec.tick()).state, 'NOT_ADMITTED');
  assert.deepEqual(await g.ledger.pendingAttempts2(), []);
  assert.deepEqual(await receiptBodies(g, 'attempt2-reopened'), []);
  // the ledger's own rules: a reopening needs a consumption not reopened yet, and a closed intent stays closed
  await assert.rejects(g.ledger.reopenAttempt2('a'.repeat(64), {}), { code: 'ATTEMPT2_NOT_REOPENABLE' }, 'never consumed');
  await f.ledger.reopenAttempt2(first.key, {}); // (attempt 2 is terminal by now, so it is not pending: a reservation needs an absent entry)
  await assert.rejects(f.ledger.reopenAttempt2(first.key, {}), { code: 'ATTEMPT2_NOT_REOPENABLE' }, 'once per consumption');
  await f.ledger.closeAttempt2(first.key, {});
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  await assert.rejects(f.ledger.consumeAttempt2(first.key, {}), { code: 'ATTEMPT2_NOT_PENDING' });
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

// A stage-8 engine for the parking tests: PR 884's first stage-8 try is not ready (it parks at B); PR 900 is refused by a publisher at stage 3.
function parkingEngine() {
  let tries = 0;
  const engine = fakeEngine();
  const run = engine.runStage, derive = engine.derive;
  engine.derive = async (s, key) => ({ ...(await derive(s, key)), pr: s.pr });
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 8 && batch.pr === 884 && tries++ === 0) { engine.calls.push(['stage', 8]); return notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'); }
    if (stage.number === 3 && batch.pr === 900) { engine.calls.push(['stage', 3]); return { ok: false, code: 'PUBLICATION_BLOCKED', proof: WINDOWS_CLEAN }; }
    return run(batch, stage, o);
  };
  return engine;
}

test('the immediate probe does not wait for a batch resting at a parking point (nothing of it runs); the periodic probe of an ACTIVE node still does', async t => {
  // periodic: ACTIVE, not urgent, 31 minutes on, PR 884 parked at B: no probe (the maintenance is called directly; a tick would
  // first run 884's due stage-8 try)
  const p = await nodeFx(t, { engine: parkingEngine(), facts: [HELD] });
  await p.exec.tick();
  await p.drop(triggerBytes());
  assert.equal((await p.exec.tick()).state, 'PARKED');
  p.advance(31 * MIN);
  assert.equal(await p.exec.roleProbeMaintenance(), null);
  assert.equal(p.engine.probes.length, 1, 'C2: the periodic probe keeps away from every open batch');
  p.exec.roleProbe.markUrgent();
  assert.equal(await p.exec.roleProbeMaintenance(), null);
  assert.equal(p.engine.probes.length, 2, 'urgent: it runs, the parked batch is not in its way');

  // urgent after a publisher refused PR 900 at stage 3, while PR 884 rests at B: the next quiet tick probes at once
  const f = await nodeFx(t, { engine: parkingEngine(), facts: [HELD] });
  await f.exec.tick();
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
  assert.equal(f.engine.probes.length, 1);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.equal(f.engine.probes.length, 2, 'probed at once, well before the 30 minutes of an ACTIVE node');
  assert.equal(f.queue.row(884).state, 'PARKED', 'and PR 884 still rests at B');
  f.advance(10 * MIN);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'its stage-8 try finishes it');
  assert.equal(f.engine.probes.length, 2);
});

test('M1: after a restart or a re-arm a batch parked at B or A does not keep the node UNCERTAIN: the probe runs at the next quiet tick', async t => {
  // B, restart: PR 884 rests at B; the restarted executor is UNCERTAIN and takes no new PR, yet it probes at once and leaves UNCERTAIN
  const f = await nodeFx(t, { engine: parkingEngine(), facts: [HELD] });
  await f.exec.tick();
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  assert.equal(f.engine.probes.length, 1);
  const restarted = new ResidentExecutor(f.ports);
  assert.equal(restarted.roleProbeMode, 'UNCERTAIN');
  await f.drop(triggerBytes({ pr: 901, headSha: H(5) }));
  const before = derives(f);
  assert.deepEqual(pick(await restarted.tick()), ['DEFERRED', 'NODE_ROLE_UNCERTAIN'], 'a new PR is not started before the probe');
  assert.equal(f.engine.probes.length, 2, 'the parked batch did not stop the probe');
  assert.equal(restarted.roleProbeMode, 'ACTIVE');
  assert.equal(derives(f), before);
  assert.equal((await restarted.tick()).state, 'COMPLETED', 'now PR 901 is taken');
  assert.equal(f.queue.row(884).state, 'PARKED', 'PR 884 rests at B all the while');

  // B, re-arm: a HALT cleared by the Owner while PR 884 rests at B
  const h = await nodeFx(t, { engine: parkingEngine(), facts: [HELD] });
  await h.exec.tick();
  await h.drop(triggerBytes());
  assert.equal((await h.exec.tick()).state, 'PARKED');
  await h.ledger.halt('X_Y', {});
  const halt = await h.ledger.halted();
  await writeOwnerRequest(path.join(h.root, 'owner'), rearmRequest({ expectedHaltSha256: halt.sha256, reason: 'checked', by: OWNER }), h.clock);
  h.advance(1);
  await h.exec.tick();
  assert.equal(await h.ledger.halted(), null);
  assert.deepEqual([h.engine.probes.length, h.exec.roleProbeMode], [2, 'ACTIVE']);
  assert.deepEqual((await receiptBodies(h, 'node-mode')).map(b => `${b.from}>${b.to}:${b.why}`), ['UNCERTAIN>ACTIVE:probe-held', 'ACTIVE>UNCERTAIN:rearm', 'UNCERTAIN>ACTIVE:probe-held']);

  // A, restart: a batch waiting for hosted signals stays the tick's result, and the probe still runs
  const g = await nodeFx(t, { policy: rawPolicy({ relay: RELAY_ON }), hint: () => Buffer.from('{"contract":"x"}'), facts: [HELD] });
  await g.exec.tick();
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  const again = new ResidentExecutor(g.ports);
  g.advance(MIN);
  assert.equal((await again.tick()).state, 'WAITING');
  assert.deepEqual([g.engine.probes.length, again.roleProbeMode], [2, 'ACTIVE']);
  assert.equal(derives(g), 1);
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
  // No usable hint keeps the batch waiting. Fresh success + attested Stage R
  // lets this existing batch continue under STANDBY with only placement local.
  let hostedDone = false;
  const hostedEngine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role)) }) });
  const g = await nodeFx(t, { engine: hostedEngine, policy: rawPolicy({ relay: RELAY_ON }),
    hint: (s, at) => hostedDone ? hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }, { pr: s.pr, head: s.headSha, at }) : null, facts: [HELD] });
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
  assert.deepEqual(stagesRun(g.engine), [1], 'neither local scanner starts while hosted is pending');
  hostedDone = true;
  g.advance(RELAY_ON.wait.signalMs);
  const completed = await g.exec.tick();
  assert.equal(completed.state, 'COMPLETED', 'it continues to its end; live admission decides');
  assert.deepEqual([completed.relayed, completed.local], [['gitleaks', 'trivy'], ['contract-placement']]);
  assert.deepEqual(stagesRun(g.engine), [1, 9, 6, 7, 8]);
  assert.deepEqual(await g.ledger.pendingAttempts2(), []);
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

test('status /6 (written as /8 since the stage timings; /7 since DESIGN §34): node carries name, source (12 hex), mode and the last probe; the companion reads it; the old /5 file is still read', async t => {
  assert.equal(STATUS_CONTRACT, 'clued.independent-ci.resident-status/8');
  assert.deepEqual([...STATUS_CONTRACTS_READABLE], ['clued.independent-ci.resident-status/5', 'clued.independent-ci.resident-status/6', 'clued.independent-ci.resident-status/7', 'clued.independent-ci.resident-status/8']);
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
  assert.equal(raw.contract, 'clued.independent-ci.resident-status/8');
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
  delete old.versions;
  delete old.timing;
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify(old))).node, { name: 'fixture-node', source: null, mode: 'STANDBY', probe: parseStatus(Buffer.from(JSON.stringify(old))).node.probe });
  for (const contract of ['clued.independent-ci.resident-status/4', 'clued.independent-ci.resident-status/9']) {
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

// DESIGN 49 (Owner decision 4f5f35d3): a passing GitHub / Native fault at stage 1 that wrote nothing releases the head (backs off, does not burn it)
// and gives attempt 2 back; it is not a node-role answer (the node stays ACTIVE), and a stage after the first still burns into attempt 2.
const TRANSIENT_REFUSAL = reason => ({ status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false, safeToRerun: true, diagnostic: null });
test('a stage-1 GitHub 5xx / Native-unavailable that wrote nothing releases the head and gives attempt 2 back; unflagged it burns into attempt 2 as before', async t => {
  for (const [code, reason] of [['GITHUB_TRANSIENT_UNAVAILABLE', 'github_http_502'], ['NATIVE_ADMISSION_UNAVAILABLE', 'full_admission_unavailable']]) {
    const f = await nodeFx(t, { engine: attempt2Engine([notAdmitted(code, TRANSIENT_REFUSAL(reason))]), facts: [HELD] });
    await f.exec.tick();
    await f.drop(triggerBytes());
    const first = await f.exec.tick();
    assert.equal(first.state, 'FAILED_CLEAN', code);
    const key2 = first.attempt2;
    f.advance(11 * MIN);
    const second = await f.exec.tick();
    assert.deepEqual([second.state, second.failureCode, second.release, second.settle?.klass, f.exec.roleProbeMode], ['NOT_ADMITTED', code, 'NOT_ADMITTED', 'environment', 'ACTIVE'], code);
    assert.deepEqual((await f.ledger.pendingAttempts2()).map(a => a.key2), [key2], `${code}: attempt 2 is pending again, not spent`);
    assert.deepEqual(await receiptBodies(f, 'attempt2-reopened'), [{ key: key2, attempt1: first.key }], code);
    // the head is not burned: after the backoff attempt 2 runs again with the same key (the fake engine now answers ok)
    f.advance(61 * MIN);
    const third = await f.exec.tick();
    assert.deepEqual([third.key, third.attempt2], [key2, undefined], code);
    assert.deepEqual(f.engine.attempts, [1, 2, 2], code);
  }
  // without the entry's own flag it is a burn into attempt 2 (clean cleanup proof), exactly as before
  const g = await nodeFx(t, { engine: attempt2Engine([notAdmitted('GITHUB_TRANSIENT_UNAVAILABLE', { ...TRANSIENT_REFUSAL('github_http_502'), safeToRerun: false })]), facts: [HELD] });
  await g.exec.tick();
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'FAILED_CLEAN');
  g.advance(11 * MIN);
  const burned = await g.exec.tick();
  assert.deepEqual([burned.state, burned.failureCode], ['FAILED_CLEAN', 'GITHUB_TRANSIENT_UNAVAILABLE']);
  assert.deepEqual(await g.ledger.pendingAttempts2(), []);
  assert.deepEqual(await receiptBodies(g, 'attempt2-reopened'), []);
});
