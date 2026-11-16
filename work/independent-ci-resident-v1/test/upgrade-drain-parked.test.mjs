// DESIGN §72 (4), field 2026-11-16 (DESK, op to fleet-node-2026.11.16-446a7106): the on-duty node's upgrade sat in WAITING_DRAIN with
// openBatches 1, PR #1130's front batch resting at B, whose stage-8 tries all said TRAIN_SINGLE_GREEN_NOT_PROVEN: the standby already ran the
// new Source, so the train could not prove a single green until this node was upgraded too, and this node's upgrade waited for that batch.
// The tries at the merge queue's first place never count towards park.stage8MaxTries, so only park.maxMs (24 hours) would have ended it:
// the drain's 120 minutes ran out, every retry met the same batch, and the Owner closed the PR by hand.
//
// These tests run the frozen upgrader's own drain step (upgrader/src/machine.mjs STEPS.drain) over the frozen observation surface
// (upgrader/src/resident-ports.mjs: the intake hold it drops into requests\, openBatches over state\ledger) against a real executor,
// whose versions port reads the upgrader's real status file (upgrader/src/status.mjs buildStatus/writeStatus).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STEPS, Machine, stateOf } from '../upgrader/src/machine.mjs';
import { HOLDER_UPGRADE, ResidentPort } from '../upgrader/src/resident-ports.mjs';
import { buildStatus, writeStatus } from '../upgrader/src/status.mjs';
import * as executor from '../src/executor.mjs';
import { intakePauseRequest } from '../src/intake-pause.mjs';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { readVersionState } from '../src/status.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, triggerBytes } from './helpers.mjs';

const { SUPERSEDED_AT_SAFE_POINT } = executor;
const UPGRADE_DRAIN_BASIS = 'upgrade-drain';
const MIN = 60_000;
const T0 = Date.parse('2026-11-16T02:29:00Z');
const OP = '0c6a1f3e-5b7d-4e8a-9c2f-1d3e5f7a9b1c';
const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 };
const KEY = batchKey(subject);
const iso = ms => new Date(ms).toISOString();
const stage8Tries = f => f.engine.calls.filter(c => c[0] === 'stage' && c[1] === 8).length;
// Stage 8 as at #1130: zero side effects, the claim first in the merge queue, the single green not proven.
const notProven = () => ({ ok: false, code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', sideEffects: 0, mayHavePublished: false, diagnostic: null,
    scheduling: { ciRetryAfter: null, mergeQueue: { entered: true, state: 'queued', position: 1 } }, safeToRerun: false } });

async function fx(t) {
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 8 ? (engine.calls.push(['stage', 8]), notProven()) : base(batch, stage, o));
  let f;
  const companion = fakeCompanion({ pull: n => ({ number: n, state: 'open', headSha: HEAD }) }, () => f?.clock() ?? T0);
  f = await executorFixture(t, { engine, companion, now: T0 });
  // The executor's versions port as service-main.mjs wires it: upgrade\current.json, the Linux facts and upgrade\status.json of this root.
  f.exec.versions = () => readVersionState({ root: f.root, policy: f.ports.policy, clock: f.clock });
  await fs.mkdir(path.join(f.root, 'upgrade'), { recursive: true });
  await fs.mkdir(path.join(f.root, 'mailbox', 'responses'), { recursive: true });
  await f.drop(triggerBytes());
  for (let i = 0; i < 3 && !Ledger.parkedAt(await f.ledger.state(KEY)); i++) await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'parked at B');
  return f;
}

// The upgrader's side, one pass: its status file (what upgrader-main writes each pass), the companion heartbeat it reads, its drain step.
function upgrader(f, { opState = stateOf('drain') } = {}) {
  const port = new ResidentPort(f.root, { clock: f.clock });
  const m = { opId: OP, clock: f.clock, t: { deferMaxHours: 24 }, planOf: () => ({ drainMaxMinutes: 120 }), resident: port, heartbeatFresh: Machine.prototype.heartbeatFresh };
  const j = { steps: [{ step: 'grant', intent: { at: iso(T0) }, result: { ok: true, detail: { consumedAt: iso(T0) } } }] };
  const intent = { at: iso(f.clock()) };
  return {
    port,
    async pass() {
      await writeStatus(path.join(f.root, 'upgrade', 'status.json'),
        buildStatus({ clock: f.clock, pid: 4242, current: null, op: opState ? { opId: OP, state: opState, phase: 'drain', phaseSince: intent.at, code: null } : null }));
      await fs.writeFile(path.join(f.root, 'mailbox', 'responses', 'heartbeat.json'), JSON.stringify({ at: f.clock() }));
      return STEPS.drain.run(m, j, intent);
    },
  };
}

test('the resident names the upgrader\'s hold exactly as the frozen upgrader drops it', () => {
  assert.equal(executor.UPGRADE_HOLDER, HOLDER_UPGRADE);
});

test('#1130: a batch resting at B for the train no longer holds the on-duty node\'s upgrade; the drain passes at its next look', async t => {
  const f = await fx(t);
  const u = upgrader(f);
  const first = await u.pass();
  assert.equal(first.view?.drain?.openBatches, 1, 'the drain sees the parked batch and waits');
  const tries = stage8Tries(f);
  let drained = null;
  // At most the drain's own deadline (drainMaxMinutes 120), one upgrader pass and one executor tick a minute.
  for (let i = 0; i < 120 && !drained; i++) {
    f.advance(MIN);
    await f.exec.tick();
    const r = await u.pass();
    if (r.ok) drained = r;
    else assert.equal(r.code, undefined, `no refusal while waiting: ${JSON.stringify(r)}`);
  }
  assert.ok(drained, 'the drain passed before its deadline');
  assert.deepEqual(drained.detail, { openBatches: 0 });
  assert.ok(f.clock() - T0 <= 3 * MIN, `within minutes, not hours (${(f.clock() - T0) / MIN} min)`);
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode, s.terminal.facts.basis, s.terminal.facts.stage, s.selfAbort.basis],
    ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, UPGRADE_DRAIN_BASIS, 8, UPGRADE_DRAIN_BASIS]);
  assert.equal(stage8Tries(f), tries, 'no stage-8 try once the upgrade waits for it');
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 'never an attempt 2');
  assert.equal(await f.ledger.halted(), null);
  assert.equal(await u.port.openBatches(), 0);
});

test('only the upgrader\'s drain ends it: an Owner hold, the upgrader\'s status alone, its hold alone, or a stale companion leave the batch at B', async t => {
  // an intake hold of another holder while the upgrader is idle
  const a = await fx(t);
  await a.drop(Buffer.from(JSON.stringify(intakePauseRequest({ holder: 'owner', minutes: 120, reason: 'switch' }, a.clock))), 'requests');
  for (let i = 0; i < 5; i++) { a.advance(MIN); await a.exec.tick(); }
  assert.ok(Ledger.parkedAt(await a.ledger.state(KEY)), 'an Owner hold is no upgrade');

  // the upgrader's status says WAITING_DRAIN but its hold is not in force (a status the upgrader left behind; the hold runs out by itself)
  const b = await fx(t);
  await writeStatus(path.join(b.root, 'upgrade', 'status.json'),
    buildStatus({ clock: b.clock, pid: 1, current: null, op: { opId: OP, state: 'WAITING_DRAIN', phase: 'drain', phaseSince: iso(b.clock()), code: null } }));
  for (let i = 0; i < 5; i++) { b.advance(MIN); await b.exec.tick(); }
  assert.ok(Ledger.parkedAt(await b.ledger.state(KEY)), 'the status alone is not the drain');

  // a hold named like the upgrader's (requests\ is the Owner session's) while the upgrader's status shows no draining op
  const c = await fx(t);
  const uc = upgrader(c, { opState: 'DEFERRED' });
  for (let i = 0; i < 5; i++) { await uc.pass(); c.advance(MIN); await c.exec.tick(); }
  assert.ok(Ledger.parkedAt(await c.ledger.state(KEY)), 'a hold without the upgrader\'s WAITING_DRAIN is not the drain');

  // the drain, but the companion's heartbeat is stale: the end needs its quiescence proof, so it waits (no HALT)
  const d = await fx(t);
  const ud = upgrader(d);
  await ud.pass();
  const beat = () => d.clock() - 10 * MIN;
  d.companion.heartbeat = async () => ({ at: beat() });
  d.advance(MIN);
  await d.exec.tick();
  assert.ok(Ledger.parkedAt(await d.ledger.state(KEY)), 'no fresh heartbeat: not yet');
  assert.equal(await d.ledger.halted(), null);
});
