import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ResidentExecutor } from '../src/executor.mjs';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { drainRequest, abortRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { executorFixture, holdAtA, triggerBytes } from './helpers.mjs';
import { MIN, OWNER, H, subject, KEY, notReady, stage8Engine, bodies, UNCERTAIN, K900 } from './park-fixtures.mjs';

describe('parking: Owner aborts and drain', () => {
  test('the Owner aborts a parked batch at a tick start, and a drain ends every parked batch (before a reinstall)', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    assert.equal((await f.exec.tick()).state, 'PARKED');
    const latest = await f.ledger.latestRecord(KEY);
    assert.equal(latest.name, '72-tried-01.json');
    await writeOwnerRequest(path.join(f.root, 'owner'), abortRequest({ batchKey: KEY, expectedLedgerEntrySha256: latest.sha256, reason: 'stuck', by: OWNER }), f.clock);
    await f.exec.tick();
    const s = await f.ledger.state(KEY);
    assert.deepEqual([s.outcome, s.terminal.facts.failureCode, s.terminal.facts.safePoint], ['FAILED_CLEAN', 'OWNER_ABORTED', 'parked']);
    // drain: the other parked batch ends too; nothing is open afterwards, so the uninstall is allowed
    f.advance(1);
    await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
    await f.exec.tick();
    assert.equal((await f.ledger.open()).length, 0);
    assert.equal((await f.ledger.state(batchKey(subject({ pr: 900, headSha: H(4) })))).terminal.facts.failureCode, 'OWNER_ABORTED');
    assert.equal(await f.executedHeads.published(subject({ pr: 900, headSha: H(4) })), true);
  });

  test('review M1, m10: the drain keeps the Owner abort guards (another scene, drift, a failed recovery, a stale request)', async t => {
    // PR 884 parks; PR 900 then fails stage 3 uncertain: FAILED_UNKNOWN, HALT, its scene unarchived
    const engine = stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY);
    const at8 = engine.runStage;
    engine.runStage = async (batch, stage, o) => (batch.key === K900 && stage.number === 3 ? (engine.calls.push(['stage', 3]), UNCERTAIN) : at8(batch, stage, o));
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
    assert.equal((await f.exec.tick()).state, 'HALTED');
    assert.ok((await f.ledger.unarchivedScenes()) > 0);
    f.advance(1);
    await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
    await f.exec.tick();
    assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_DRAIN_UNARCHIVED_SCENE_PRESENT']);
    assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'the parked batch is untouched; nothing was archived over the scene');
    assert.equal(engine.calls.filter(c => c[0] === 'archive-windows').length, 0);
    // drifted installed bytes
    const g = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
    await g.drop(triggerBytes());
    assert.equal((await g.exec.tick()).state, 'PARKED');
    const drifted = new ResidentExecutor({ ...g.ports, sourceIntegrity: async () => ({ ok: false }) });
    g.advance(1);
    await writeOwnerRequest(path.join(g.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, g.clock), g.clock);
    await drifted.tick();
    assert.deepEqual((await bodies(g, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_DRAIN_SOURCE_DRIFT']);
    assert.ok(Ledger.parkedAt(await g.ledger.state(KEY)));
    // a request written more than an hour before the service reads it
    const h = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
    await h.drop(triggerBytes());
    assert.equal((await h.exec.tick()).state, 'PARKED');
    const written = h.clock();
    h.advance(61 * MIN);
    await writeOwnerRequest(path.join(h.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, () => written), h.clock);
    await h.exec.tick();
    assert.ok((await bodies(h, 'owner-request-refused')).some(b => b.failureCode === 'OWNER_DRAIN_REQUEST_STALE'));
    // recovery failed this tick: refused too
    const k = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
    await k.drop(triggerBytes());
    assert.equal((await k.exec.tick()).state, 'PARKED');
    k.exec.recover = async () => { throw new Error('disk'); };
    k.advance(1);
    await writeOwnerRequest(path.join(k.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, k.clock), k.clock);
    await k.exec.tick();
    assert.ok((await bodies(k, 'owner-request-refused')).some(b => b.failureCode === 'OWNER_DRAIN_RECOVERY_UNCONFIRMED'));
  });

  test('review M1: the drain ends a batch waiting at parking point A (not published) the same way', async t => {
    const f = await executorFixture(t);
    holdAtA(f.exec);
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'WAITING');
    f.advance(1);
    await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
    await f.exec.tick();
    const s = await f.ledger.state(KEY);
    assert.deepEqual([s.outcome, s.terminal.facts.failureCode, s.terminal.facts.safePoint, s.abort.safePoint], ['FAILED_CLEAN', 'OWNER_ABORTED', 'waiting', 'waiting']);
    assert.equal(await f.executedHeads.published(subject()), false);
    assert.deepEqual((await bodies(f, 'owner-request')).map(b => [b.kind, b.remaining]), [['drain', 0]]);
  });

  test('review m2: the Owner abort of a batch at B records safe point parked from its first record', async t => {
    const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')], KEY) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'PARKED');
    const latest = await f.ledger.latestRecord(KEY);
    await writeOwnerRequest(path.join(f.root, 'owner'), abortRequest({ batchKey: KEY, expectedLedgerEntrySha256: latest.sha256, reason: 'stuck', by: OWNER }), f.clock);
    await f.exec.tick();
    const s = await f.ledger.state(KEY);
    assert.deepEqual([s.abort.safePoint, s.terminal.facts.safePoint], ['parked', 'parked']);
    assert.deepEqual((await bodies(f, 'owner-abort-accepted')).map(b => b.safePoint), ['parked']);
  });

  test('final check n6: a later entry failing after its acceptance stops the drain with what it ended, then HALTs', async t => {
    // the Owner abort's own path fails on the second entry (accepted, not concluded), or so does its UNKNOWN ending
    for (const where of ['owner-abort', 'unknown']) {
      const f = await executorFixture(t, { engine: stage8Engine([notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')]) });
      await f.drop(triggerBytes());
      assert.equal((await f.exec.tick()).state, 'PARKED');
      await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
      assert.equal((await f.exec.tick()).state, 'PARKED');
      const disk = () => Object.assign(new Error('disk'), { code: 'LEDGER_WRITE_FAILED' });
      let calls = 0;
      if (where === 'owner-abort') {
        const ownerAbort = f.exec.ownerAbort.bind(f.exec);
        f.exec.ownerAbort = async (...a) => { if (++calls === 2) throw disk(); return ownerAbort(...a); };
      } else {
        const accept = f.exec.acceptAbort.bind(f.exec);
        f.exec.acceptAbort = async (...a) => { const r = await accept(...a); if (++calls === 2) throw disk(); return r; };
        f.exec.unknown = async () => { throw disk(); };
      }
      f.advance(1);
      await writeOwnerRequest(path.join(f.root, 'owner'), drainRequest({ reason: 'reinstall', by: OWNER }, f.clock), f.clock);
      assert.equal((await f.exec.tick()).state, 'HALTED', where);
      const done = (await bodies(f, 'owner-request')).find(b => b.kind === 'drain');
      assert.ok(done, where);
      assert.deepEqual([done.ended.length, done.ended[0].failureCode, done.remaining, done.stoppedBy, done.unconfirmed.length], [1, 'OWNER_ABORTED', 1, 'RESIDENT_EXECUTOR_EXCEPTION', 64], where);
      assert.equal((await bodies(f, 'owner-request-refused')).length, 0, where);
      assert.equal((await f.ledger.halted()).value.code, 'OWNER_ABORT_UNCONFIRMED', where);
      assert.deepEqual((await f.ledger.crashed()).map(e => e.key), [done.unconfirmed], where);
    }
  });
});
