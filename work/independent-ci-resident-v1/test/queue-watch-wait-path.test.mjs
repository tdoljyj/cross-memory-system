// Generation 12, review round 14 (DESIGN §56.2, §56.3): batch work that does not start in driveReserved — a batch resumed from parking
// point A — also ends the watched mark of other parked rows at once, and a running batch keeps its lease even when its PR's queue row
// shows a newer commit. Built on the reviewer's two reproductions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_WATCH_MS } from '../src/executor.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { HEAD, RELAY_ON, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, hintFor, rawPolicy, relayedRow, triggerBytes } from './helpers.mjs';

const T0 = Date.parse('2026-11-05T08:00:00Z');
const HELD = { result: 'held', code: 'ROLE_PROBE_HELD' };
const probeResult = fact => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true }, roleProbe: fact,
  outcome: { status: 'BLOCKED', reason: fact.code, sideEffects: 0, mayHavePublished: false } });
const notReady = code => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null } }, safeToRerun: false } });
const withLease = (r, exp) => ({ ...r, outcome: { status: r.ok ? 'SETTLED' : 'BLOCKED', reason: r.code ?? null, sideEffects: 0, mayHavePublished: !r.ok ? false : true, diagnostic: null,
  scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null }, claimExpiresAt: exp }, safeToRerun: false } });

test('a batch resumed from parking point A: from its first stage on, the parked rows are no longer shown as watched', async t => {
  const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role)) }) });
  engine.probes = [];
  engine.queueWatchSupported = async () => true;
  engine.runRoleProbe = async opts => { engine.probes.push(opts ?? null); return probeResult(HELD); };
  const derive = engine.derive, run = engine.runStage;
  engine.derive = async (s, key) => ({ ...(await derive(s, key)), pr: s.pr });
  let left = 1, f;
  const seen = [];
  const row = () => parseStatus(Buffer.from(JSON.stringify(f.exec.status.snapshot()))).pending.find(p => p.pr === 884);
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 8 && batch.pr === 884 && left) { left--; engine.calls.push(['stage', 8]); return notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'); }
    if (batch.pr === 900 && stage.number !== 1) { seen.push([stage.number, row()?.watched]); f.advance(5 * 60_000); }
    return run(batch, stage, o);
  };
  let ready900 = false;
  const companion = fakeCompanion({ hint: (s, now) => (s.pr === 884 || ready900)
    ? hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }, { pr: s.pr, head: s.headSha, at: now }) : null });
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine, companion, status: board, now: T0, policy: rawPolicy({ relay: RELAY_ON }) });
  await f.exec.tick();
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: 'c'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.ok(engine.probes.some(p => p?.watchPr === 884), 'PR 884 was watched while PR 900 rested at A');
  ready900 = true;
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.ok(seen.length > 0);
  assert.deepEqual(seen.filter(([, w]) => w !== false), [], JSON.stringify(seen));
});

test('a running batch keeps its lease when its PR’s queue row shows a newer commit (the live read keeps it running)', async t => {
  const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role)) }) });
  const run = engine.runStage;
  let f;
  const seen = [];
  const exp = new Date(T0 + 40 * 60_000).toISOString();
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) { engine.calls.push(['stage', 1]); return withLease({ ok: true, factsSha256: 'd'.repeat(64) }, exp); }
    if (stage.number !== 8) seen.push([stage.number, parseStatus(Buffer.from(JSON.stringify(f.exec.status.snapshot()))).current?.claimExpiresAt ?? null, f.exec.leaseOf({ pr: 884, headSha: HEAD })]);
    return run(batch, stage, o);
  };
  let ready = false;
  const companion = fakeCompanion({ hint: (s, now) => ready ? hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }, { pr: s.pr, head: s.headSha, at: now }) : null,
    pull: pr => ({ number: pr, state: 'open', headSha: HEAD }) });
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine, companion, status: board, now: T0, policy: rawPolicy({ relay: RELAY_ON }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  await f.drop(triggerBytes({ headSha: 'd'.repeat(40) }));
  ready = true;
  f.advance(2 * 60_000);
  await f.exec.tick();
  assert.ok(seen.length > 0);
  for (const [stage, shown, kept] of seen) {
    assert.equal(kept, exp, `stage ${stage}: the lease is kept`);
    assert.equal(shown, Date.parse(exp), `stage ${stage}: and shown on the status`);
  }
});

test('review round 15: a batch still resting at A does not end the watched mark of a parked row during quiet ticks (no flicker)', async t => {
  const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role)) }) });
  engine.probes = [];
  engine.queueWatchSupported = async () => true;
  engine.runRoleProbe = async opts => { engine.probes.push(opts ?? null); return probeResult(HELD); };
  const derive = engine.derive, run = engine.runStage;
  engine.derive = async (s, key) => ({ ...(await derive(s, key)), pr: s.pr });
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 8 && batch.pr === 884) { engine.calls.push(['stage', 8]); return notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'); }
    return run(batch, stage, o);
  };
  const companion = fakeCompanion({ hint: (s, now) => s.pr === 884
    ? hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }, { pr: s.pr, head: s.headSha, at: now }) : null });
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine, companion, status: board, now: T0, policy: rawPolicy({ relay: RELAY_ON }) });
  const row = () => parseStatus(Buffer.from(JSON.stringify(f.exec.status.snapshot()))).pending.find(p => p.pr === 884);
  await f.exec.tick();
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  await f.drop(triggerBytes({ pr: 900, headSha: 'c'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick(); // the first watch sets the mark
  const sched = f.exec.schedule.bind(f.exec), mid = [];
  f.exec.schedule = async (...a) => { mid.push(row()?.watched); return sched(...a); };
  const after = [];
  for (let i = 0; i < 4; i++) { f.advance(QUEUE_WATCH_MS); const r = await f.exec.tick(); after.push([r.state, row()?.watched]); }
  assert.deepEqual(mid, [true, true, true, true], 'mid-tick');
  assert.deepEqual(after, Array(4).fill(['WAITING', true]));
  assert.ok(engine.probes.filter(p => p?.watchPr === 884).length >= 4, 'watches went on');
});
