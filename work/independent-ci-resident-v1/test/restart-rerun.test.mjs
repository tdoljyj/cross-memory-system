// DESIGN §71: a batch that a reboot interrupted. The service died at every point of a batch; the next start took over the executor
// lock from an earlier boot (lockFromEarlierBoot). A batch proven to have published nothing and quiet on both hosts is closed
// FAILED_CLEAN EXECUTOR_RESTARTED_UNPUBLISHED and runs again as its one attempt 2, without a HALT; everything else HALTs as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RESTART_ARCHIVE_REASON, RESTART_QUIESCENCE_ATTEMPTS, ResidentExecutor, lockHeldInEarlierBoot } from '../src/executor.mjs';
import { ATTEMPT2_RESIDENT_CODES, attempt2Decision } from '../src/attempts.mjs';
import { EXECUTOR_RESTARTED_UNPUBLISHED, failureRow } from '../src/classify.mjs';
import { mayHavePublished } from '../src/executed-heads.mjs';
import { acquireInstanceLock } from '../src/instance-lock.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { BASE, HEAD, RELAY_ON, SOURCE, executorFixture, fakeCompanion, fakeEngine, hintFor, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const KEY2 = batchKey(subject({ attempt: 2 }));
const SUCCESS = { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } };
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
async function bodies(f, type) {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
}

// The service dies (never returns) at one point of a batch; the dying tick is left hanging, as a killed process would, and its
// executor never wakes again (its abort watch of a running scanner stage would otherwise poll for ever).
const HANG = () => new Promise(() => {});
const never = reached => () => { reached(); return HANG(); };
const kill = exec => { exec.sleep = HANG; };
const POINTS = {
  bundle: (f, die) => { f.companion.buildBundle = never(die); },
  'stage-1': (f, die) => { const run = f.engine.runStage; f.engine.runStage = (b, s, o) => (s.number === 1 ? never(die)() : run(b, s, o)); },
  workspace: (f, die) => { f.companion.prepareWorkspaces = never(die); },
  'stage-2': (f, die) => { const run = f.engine.runStage; f.engine.runStage = (b, s, o) => (s.number === 2 ? never(die)() : run(b, s, o)); },
  ...Object.fromEntries([3, 4, 5, 6, 7, 8].map(n => [`stage-${n}`, (f, die) => { const run = f.engine.runStage; f.engine.runStage = (b, s, o) => (s.number === n ? never(die)() : run(b, s, o)); }])),
};

async function dieAt(t, point, { policy, companion, engine } = {}) {
  const f = await executorFixture(t, { policy, engine: engine ?? fakeEngine(), ...(companion ? { companion } : {}) });
  let died;
  const reached = new Promise(resolve => { died = resolve; });
  POINTS[point](f, died);
  await f.drop(triggerBytes());
  f.exec.tick();
  await reached;
  kill(f.exec);
  return f;
}
// The next start: fresh host ports, the same state; lockFromEarlierBoot as the instance lock found it.
const restart = (f, { earlierBoot = true, engine = fakeEngine(), companion = fakeCompanion({}, f.clock) } = {}) =>
  new ResidentExecutor({ ...f.ports, engine, companion, ...(earlierBoot ? { lockFromEarlierBoot: true } : {}) });

test('the code: stages 1 and 2 only, burned, attempt 2, never published', () => {
  assert.deepEqual(ATTEMPT2_RESIDENT_CODES[EXECUTOR_RESTARTED_UNPUBLISHED], [1, 2]);
  for (const stage of [1, 2]) {
    const row = failureRow({ code: EXECUTOR_RESTARTED_UNPUBLISHED, stage });
    assert.deepEqual([row.disposition, row.retry, row.class], ['burn', 'attempt2', 'environment']);
    assert.equal(attempt2Decision({ policy: { automaticAttempt2: { enabled: true } }, subject: { attempt: 1 }, outcome: 'FAILED_CLEAN',
      failure: { code: EXECUTOR_RESTARTED_UNPUBLISHED, stageNumber: stage, relayedRoles: 0 } }).eligible, true);
    assert.equal(mayHavePublished({}, { terminal: { outcome: 'FAILED_CLEAN', facts: { failureCode: EXECUTOR_RESTARTED_UNPUBLISHED, stage } } }).published, false);
  }
  for (const stage of [0, 3, 4, 5, 6, 7, 8, 9]) assert.equal(failureRow({ code: EXECUTOR_RESTARTED_UNPUBLISHED, stage }).retry, 'new-commit', `never attempt 2 at stage ${stage}`);
  assert.equal(attempt2Decision({ policy: { automaticAttempt2: { enabled: true } }, subject: { attempt: 2 }, outcome: 'FAILED_CLEAN',
    failure: { code: EXECUTOR_RESTARTED_UNPUBLISHED, stageNumber: 2, relayedRoles: 0 } }).reason, 'ATTEMPT2_ONLY_AFTER_ATTEMPT1');
});

test('the start reads whether the executor lock it takes over was held in an earlier boot (the same rule as the instance lock)', async t => {
  const root = await tempRoot(t);
  let up = 5 * 3_600_000;
  assert.equal(await lockHeldInEarlierBoot(root, { uptime: () => up }), false, 'no lock');
  await acquireInstanceLock(root, { pid: 11, alive: async () => false, uptime: () => up });
  up += 1000;
  assert.equal(await lockHeldInEarlierBoot(root, { uptime: () => up }), false, 'a holder of this boot');
  up = 90_000;
  assert.equal(await lockHeldInEarlierBoot(root, { uptime: () => up }), true, 'a holder of an earlier boot');
  up = 5 * 3_600_000 - 59_000;
  assert.equal(await lockHeldInEarlierBoot(root, { uptime: () => up }), false, 'within the margin: not recognised (one-way)');
  await fs.writeFile(path.join(root, 'executor.lock', 'holder.json'), '{torn');
  await fs.writeFile(path.join(root, 'executor.lock', 'alive.json'), JSON.stringify({ token: 'x', at: 0, uptimeMs: 10 * 3_600_000 }));
  assert.equal(await lockHeldInEarlierBoot(root, { uptime: () => 90_000 }), false, 'an unreadable holder: false');
});

test('a reboot before any publication stage: FAILED_CLEAN, no HALT, the one attempt 2 runs the head to the end', async t => {
  for (const [point, stage, linux] of [['bundle', 1, false], ['stage-1', 1, false], ['workspace', 2, true], ['stage-2', 2, true]]) {
    const f = await dieAt(t, point);
    assert.equal((await f.ledger.state(KEY)).state, stage === 1 ? 'RESERVED' : 'STARTED', point);
    const companion = fakeCompanion({}, f.clock), engine = fakeEngine();
    const exec = restart(f, { engine, companion });
    const r = await exec.tick();
    assert.notEqual(r.state, 'HALTED', point);
    assert.equal(await f.ledger.halted(), null, `${point}: no HALT`);
    const s = await f.ledger.state(KEY);
    assert.deepEqual([s.outcome, s.terminal.facts.failureCode, s.terminal.facts.stage, s.terminal.facts.basis],
      ['FAILED_CLEAN', EXECUTOR_RESTARTED_UNPUBLISHED, stage, 'restart-earlier-boot-unpublished'], point);
    assert.equal(await f.ledger.headBurned(headKey(subject())), true, `${point}: attempt 1's head is burned`);
    assert.ok(engine.calls.some(c => c[0] === 'archive-windows' && c[1] === RESTART_ARCHIVE_REASON), `${point}: Windows archived`);
    assert.equal(companion.calls.some(c => c[0] === 'archive-linux'), linux, `${point}: Linux archived only after 10-started`);
    assert.ok(companion.calls.some(c => c[0] === 'quiescence'), `${point}: Linux quiescence proven`);
    assert.deepEqual((await bodies(f, 'attempt2-scheduled')).map(b => [b.key, b.attempt2, b.failureCode, b.stage]), [[KEY, KEY2, EXECUTOR_RESTARTED_UNPUBLISHED, stage]], point);
    // no batch before attempt 2 is due; then attempt 2 runs every stage and completes
    f.advance(600_000);
    const second = await exec.tick();
    assert.deepEqual([second.state, second.key], ['COMPLETED', KEY2], point);
    assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8], point);
    f.advance(600_000);
    assert.equal((await exec.tick()).state, 'IDLE', `${point}: never an attempt 3`);
  }
});

test('a reboot at or after a publication stage HALTs exactly as before', async t => {
  for (const point of ['stage-3', 'stage-4', 'stage-5', 'stage-6', 'stage-7', 'stage-8']) {
    const f = await dieAt(t, point);
    const companion = fakeCompanion({}, f.clock);
    assert.equal((await restart(f, { companion }).tick()).state, 'HALTED', point);
    const s = await f.ledger.state(KEY);
    assert.deepEqual([s.outcome, s.terminal.facts.failureCode], ['FAILED_UNKNOWN', 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH'], point);
    assert.deepEqual(await f.ledger.pendingAttempts2(), [], `${point}: no attempt 2`);
    assert.ok(!companion.calls.some(c => c[0] === 'archive-linux'), `${point}: the scene is left for the Owner`);
  }
});

test('a reboot in or after stage R HALTs: stage R interrupted, or a role relayed', async t => {
  const policy = rawPolicy({ relay: RELAY_ON });
  // stage R interrupted (20-plan-intent without 25-plan)
  const engineR = fakeEngine();
  engineR.runRelayStage = () => new Promise(() => {});
  const f = await executorFixture(t, { policy, engine: engineR, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  await f.drop(triggerBytes());
  f.exec.tick();
  kill(f.exec);
  for (let i = 0; i < 200 && !(await f.ledger.state(KEY)).planIntent; i += 1) await new Promise(r => setTimeout(r, 5));
  assert.equal((await restart(f).tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(KEY)).terminal.facts.failureCode, 'RELAY_STAGE_INTERRUPTED');
  // gitleaks and trivy relayed, placement interrupted locally
  const g = await dieAt(t, 'stage-6', { policy, companion: fakeCompanion({ hint: () => hintFor(SUCCESS) }) });
  assert.equal((await g.ledger.state(KEY)).plan.relayed.length, 2);
  assert.equal((await restart(g).tick()).state, 'HALTED');
  assert.equal((await g.ledger.state(KEY)).terminal.facts.failureCode, 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH');
});

test('anything not proven HALTs as before: same boot, Linux not quiet, a HALT already latched, a may-have-published record, drift', async t => {
  const cases = {
    'same boot': { restart: f => restart(f, { earlierBoot: false }) },
    'Linux not quiet': { restart: f => restart(f, { companion: fakeCompanion({ linux: { linuxUnitsInactive: true, containersZero: false } }, f.clock) }) },
    'HALT latched': { before: f => f.ledger.halt('RESIDENT_LOOP_EXCEPTION', {}), restart: f => restart(f) },
    'head recorded as may have published': { before: f => f.executedHeads.record(subject(), { key: KEY, origin: 'publication', basis: 'before-stage-3', stage: 3 }), restart: f => restart(f) },
    'installed bytes drifted': { restart: f => new ResidentExecutor({ ...f.ports, engine: fakeEngine(), companion: fakeCompanion({}, f.clock), lockFromEarlierBoot: true,
      sourceIntegrity: async () => ({ ok: false }) }) },
  };
  for (const [label, c] of Object.entries(cases)) {
    const f = await dieAt(t, 'stage-2');
    await c.before?.(f);
    const exec = c.restart(f);
    assert.equal((await exec.tick()).state, 'HALTED', label);
    const s = await f.ledger.state(KEY);
    assert.equal(s.outcome, 'FAILED_UNKNOWN', label);
    assert.deepEqual(await f.ledger.pendingAttempts2(), [], `${label}: no attempt 2`);
  }
});

test('Linux quiescence is re-checked while the companion comes up after the reboot (bounded)', async t => {
  const f = await dieAt(t, 'stage-2');
  let asked = 0;
  const companion = fakeCompanion({}, f.clock);
  companion.linuxQuiescence = async () => { asked += 1; return asked < 5 ? { linuxUnitsInactive: false, containersZero: false } : { linuxUnitsInactive: true, containersZero: true }; };
  assert.notEqual((await restart(f, { companion }).tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_CLEAN');
  assert.equal(asked, 5);
  // never answered: bounded, then the old HALT
  const g = await dieAt(t, 'stage-2');
  let tries = 0;
  const silent = fakeCompanion({}, g.clock);
  silent.linuxQuiescence = async () => { tries += 1; return { linuxUnitsInactive: false, containersZero: false }; };
  assert.equal((await restart(g, { companion: silent }).tick()).state, 'HALTED');
  assert.equal(tries, RESTART_QUIESCENCE_ATTEMPTS);
  assert.equal((await g.ledger.state(KEY)).terminal.facts.failureCode, 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH');
});

test('only entries the earlier boot left: one this process opened HALTs; attempt 2 interrupted by a reboot closes clean without attempt 3', async t => {
  // this process's own entry (opened after its first recovery) is never taken for the earlier boot's
  const f = await executorFixture(t);
  const exec = restart(f);
  assert.equal((await exec.tick()).state, 'IDLE');
  await f.ledger.reserve(KEY, subject());
  await f.ledger.markStarted(KEY, { batchId: `${KEY.slice(0, 16)}-${'0'.repeat(12)}` });
  assert.equal((await exec.tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(KEY)).terminal.facts.failureCode, 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH');
  // attempt 2 itself interrupted by a second reboot in stage 2
  const g = await dieAt(t, 'stage-2');
  const first = restart(g);
  await first.tick();
  g.advance(600_000);
  const run = first.engine.runStage;
  let died;
  const reached = new Promise(resolve => { died = resolve; });
  first.engine.runStage = (b, s, o) => (s.number === 2 ? never(died)() : run(b, s, o));
  first.tick();
  await reached;
  kill(first);
  assert.equal((await g.ledger.state(KEY2)).state, 'STARTED');
  const again = restart(g);
  assert.notEqual((await again.tick()).state, 'HALTED');
  const s = await g.ledger.state(KEY2);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode], ['FAILED_CLEAN', EXECUTOR_RESTARTED_UNPUBLISHED]);
  assert.equal(await g.ledger.halted(), null);
  g.advance(600_000);
  assert.equal((await again.tick()).state, 'IDLE', 'never an attempt 3');
});
