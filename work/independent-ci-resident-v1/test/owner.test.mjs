// Owner-request, recovery and queue regressions from the second independent review (M6a-e, minors).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor } from '../src/executor.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { rearmRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, notAdmitted, triggerBytes } from './helpers.mjs';

const OWNER = 'S-1-5-21-1-2-3-1001';
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d{8}-|\.json$/g, ''));

test('handled Owner requests never starve new ones, however many accumulate (M6a)', async t => {
  const f = await executorFixture(t);
  await f.ledger.halt('X_Y', {});
  for (let i = 0; i < 12; i += 1) {
    await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: '0'.repeat(64), reason: `stale ${i}`, by: OWNER }, f.clock), f.clock);
    f.advance(1);
  }
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const h = await f.ledger.halted();
  f.advance(1);
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'real one', by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'IDLE', 'the 13th request is read and acted on');
  assert.equal((await receiptTypes(f)).filter(t => t === 'owner-request-refused').length, 12);
});

test('a retry with the same reason after a refusal is a new request, not a silent duplicate (M6b)', async t => {
  const busy = { linuxUnitsInactive: false, containersZero: true };
  const comp = fakeCompanion({ linux: busy });
  const f = await executorFixture(t, { companion: comp });
  await f.ledger.halt('X_Y', {});
  const h = await f.ledger.halted();
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'same words', by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'HALTED');
  busy.linuxUnitsInactive = true;
  f.advance(1);
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'same words', by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'IDLE');
});

test('re-arm after a crash archives the crashed batch even though the HALT names no key (M6c)', async t => {
  const engine = fakeEngine();
  const comp = fakeCompanion();
  const f = await executorFixture(t, { engine, companion: comp });
  const k = batchKey(subject());
  await f.ledger.reserve(k, subject());
  await f.ledger.markStarted(k, { batchId: `${k.slice(0, 16)}-${'0'.repeat(12)}` });
  await f.ledger.halt('RESIDENT_LOOP_EXCEPTION', { message: 'x' }); // the loop's own HALT has no key
  const svc = new ResidentExecutor(f.ports);
  assert.equal((await svc.tick()).state, 'HALTED');
  const h = await f.ledger.halted();
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'checked', by: OWNER }, f.clock), f.clock);
  assert.equal((await svc.tick()).state, 'IDLE');
  // A fixed reason: a failure code is never turned into the archive scope (third review, MAJOR 1).
  assert.deepEqual(engine.calls.filter(c => c[0] === 'archive-windows').map(c => c[1]), ['rearm-unknown-failure']);
  assert.deepEqual(comp.calls.filter(c => c[0] === 'archive-linux').map(c => c[1]), ['rearm-unknown-failure']);
  assert.ok((await f.ledger.state(k)).archived, 'the entry is marked archived, so a later re-arm does not repeat it');
  assert.equal((await f.ledger.unknownUnarchived()).length, 0);
});

test('an unreadable entry is quarantined with its head burned, and re-arm must archive its scene (M6e, third review MAJOR 2)', async t => {
  const engine = fakeEngine();
  const comp = fakeCompanion();
  const f = await executorFixture(t, { engine, companion: comp });
  const k = batchKey(subject());
  await f.ledger.reserve(k, subject());
  await f.ledger.markStarted(k, { batchId: `${k.slice(0, 16)}-${'1'.repeat(12)}` });
  await fs.writeFile(path.join(f.root, 'state', 'ledger', k, '90-terminal.json'), '{torn');
  const svc = new ResidentExecutor(f.ports);
  assert.equal((await svc.tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(k)).state, 'ABSENT');
  assert.equal(await f.ledger.headBurned(headKey(subject())), true, 'quarantine never frees the head');
  assert.equal((await f.ledger.quarantinedUnarchived()).length, 1);
  const h = await f.ledger.halted();
  // Without quiescence the re-arm is refused and the quarantine stays unarchived.
  comp.linuxBusy = true;
  const busy = fakeCompanion({ linux: { linuxUnitsInactive: false, containersZero: true } });
  const svcBusy = new ResidentExecutor({ ...f.ports, companion: busy });
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'too early', by: OWNER }, f.clock), f.clock);
  assert.equal((await svcBusy.tick()).state, 'HALTED');
  f.advance(1);
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'looked at the quarantined entry', by: OWNER }, f.clock), f.clock);
  assert.equal((await svc.tick()).state, 'IDLE');
  assert.deepEqual(comp.calls.filter(c => c[0] === 'archive-linux').map(c => c[1]), ['rearm-quarantine']);
  assert.equal((await f.ledger.quarantinedUnarchived()).length, 0);
  await f.drop(triggerBytes({ baseSha: '3'.repeat(40) }));
  assert.equal((await svc.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
});

test('clearHalt refuses while a quarantined scene is unarchived', async t => {
  const f = await executorFixture(t);
  const k = batchKey(subject());
  await f.ledger.reserve(k, subject());
  await f.ledger.quarantine(k, { why: 'test' });
  await f.ledger.halt('X_Y', {});
  await assert.rejects(f.ledger.clearHalt((await f.ledger.halted()).sha256, {}), { code: 'REARM_REQUIRES_QUARANTINE_ARCHIVED' });
});

test('a transient Owner-request read failure does not use up the request', async t => {
  const f = await executorFixture(t);
  await f.ledger.halt('X_Y', {});
  const h = await f.ledger.halted();
  const file = await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'r', by: OWNER }, f.clock), f.clock);
  const good = await fs.readFile(file);
  await fs.rm(file);
  await fs.mkdir(file); // unreadable for now (a directory where the file will be)
  assert.equal((await f.exec.tick()).state, 'HALTED');
  await fs.rmdir(file);
  await fs.writeFile(file, good);
  assert.equal((await f.exec.tick()).state, 'IDLE', 'read again after the transient failure');
});

test('a head waiting out its cool-down does not block the PRs behind it', async t => {
  const engine = fakeEngine({ stages: {} });
  const f = await executorFixture(t, { engine });
  engine.runStage = async (batch, stage) => { engine.calls.push(['stage', stage.number]); return batch.key === batchKey(subject()) && stage.number === 1 ? notAdmitted() : { ok: true }; };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  await f.drop(triggerBytes());                                   // same head again, inside the cool-down
  await f.drop(triggerBytes({ pr: 900, headSha: '4'.repeat(40) })); // another PR behind it
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED', 'the PR behind the cooling head ran');
  assert.equal((await fs.readdir(path.join(f.root, 'inbox'))).length, 0, 'every trigger went into the run queue');
  assert.equal(f.queue.row(884).state, 'BACKOFF', 'the released head waits for its own back-off');
});

test('a stage proof field that is present must be true; absent fields add nothing', async t => {
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 3: { ok: false, code: 'STAGE_CHILD_REFUSED', proof: { windowsTreeZero: 'yes', serviceOriginalStopped: true } } } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const g = await executorFixture(t, { engine: fakeEngine({ stages: { 3: { ok: false, code: 'STAGE_CHILD_REFUSED', proof: {} } } }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'FAILED_CLEAN', 'fresh engine and Linux facts alone suffice when the stage reported none');
});

test('quarantine scenes stay visible at every crash point and with a torn marker (fourth review N1)', async t => {
  const f = await executorFixture(t);
  const q = path.join(f.root, 'state', 'ledger-quarantine');
  await fs.mkdir(q, { recursive: true });
  const key = 'c'.repeat(64);
  // Crash after the marker, before the move: marker only.
  await fs.writeFile(path.join(q, `${key}-2026-10-20T120000000Z-aaaaaaaaaaaa.quarantine.json`), JSON.stringify({ key, batchId: null }));
  // Directory without marker (written by an older version or a lost marker).
  await fs.mkdir(path.join(q, `${key}-2026-10-20T120001000Z-bbbbbbbbbbbb`));
  // Torn marker.
  await fs.writeFile(path.join(q, `${key}-2026-10-20T120002000Z-cccccccccccc.quarantine.json`), '{torn');
  const list = await f.ledger.quarantinedUnarchived();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(e => e.batchId).sort(), [`${key.slice(0, 16)}-aaaaaaaaaaaa`, `${key.slice(0, 16)}-bbbbbbbbbbbb`, `${key.slice(0, 16)}-cccccccccccc`], 'unique stand-in ids from each nonce');
  await f.ledger.halt('X_Y', {});
  await assert.rejects(f.ledger.clearHalt((await f.ledger.halted()).sha256, {}), { code: 'REARM_REQUIRES_QUARANTINE_ARCHIVED' });
});

test('an unarchived failed-unknown scene keeps the executor halted even if HALT.json is gone (N1)', async t => {
  const f = await executorFixture(t);
  const k = batchKey(subject());
  await f.ledger.reserve(k, subject());
  await f.ledger.terminal(k, 'FAILED_UNKNOWN', { failureCode: 'X_Y' }); // as if HALT had not been written
  await f.drop(triggerBytes({ pr: 900, headSha: '4'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal(f.engine.calls.length, 0, 'no candidate runs');
  assert.equal((await f.ledger.halted()).value.code, 'UNARCHIVED_FAILURE_SCENE', 'HALT is latched again');
});

test('a torn HALT.json is still a HALT the Owner can name and clear; torn unexecuted records do not wedge', async t => {
  const f = await executorFixture(t);
  await fs.writeFile(path.join(f.root, 'state', 'HALT.json'), '{"code":"X_Y",');
  const h = await f.ledger.halted();
  assert.equal(h.value.code, 'HALT_RECORD_UNREADABLE');
  assert.equal((await f.exec.tick()).state, 'HALTED');
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'torn halt reviewed', by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  const k = batchKey(subject());
  await fs.mkdir(path.join(f.root, 'state', 'ledger-unexecuted', `${k}-x`), { recursive: true });
  await fs.writeFile(path.join(f.root, 'state', 'ledger-unexecuted', `${k}-x`, '90-terminal.json'), '{torn');
  await fs.writeFile(path.join(f.root, 'state', 'ledger-unexecuted', `${k}-x`, '00-reserved.json'), '{torn');
  assert.equal((await f.ledger.unexecutedSince(k, 0)).length, 1);
  assert.equal(await f.ledger.evaluationsSince(0), 1);
});

test('a torn PAUSED.json is still a pause the Owner can name and resume (fifth review, minor 1)', async t => {
  const f = await executorFixture(t);
  await fs.writeFile(path.join(f.root, 'state', 'PAUSED.json'), '{"source":');
  const p = await f.ledger.paused();
  assert.equal(p.value.source, 'PAUSE_RECORD_UNREADABLE');
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  const { resumeRequest } = await import('../tools/rearm-tool.mjs');
  await writeOwnerRequest(path.join(f.root, 'owner'), resumeRequest({ expectedPausedSha256: p.sha256, by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

// Field defect 2026-11-13 (DESK, PR #1085): the Owner resumed at 03:32:14Z and the same tick ran the batch to 03:46:45Z; status.json kept
// paused=true the whole time (only the tick's end reported the ledger), so the PR page said 停摆（PAUSED） while the batch ran and the
// standby wrote "停摆 10 分钟". The latch a resume (or a re-arm) lifts reaches the status in the tick that lifts it, before any batch.
test('a resume reaches the status before the batch it lets run (field 2026-11-13, PR #1085)', async t => {
  const { StatusBoard } = await import('../src/status.mjs');
  const { NodeDuty, freshMemory } = await import('../src/node-duty.mjs');
  const { describe } = await import('../src/pr-status.mjs');
  const seen = [];
  let f;
  const engine = fakeEngine();
  const runStage = engine.runStage.bind(engine);
  engine.runStage = async (batch, stage, o) => {
    const s = f.exec.status.content;
    // What the companion writes on the PR page at this moment (pr-status.mjs#describe through node-duty.mjs#want).
    const status = { ...s, writtenAt: f.clock() };
    const duty = new NodeDuty({ memory: freshMemory(), fallbackName: 'desk-w-591', staleMs: 600_000 });
    duty.node = { name: 'desk-w-591', mode: 'ACTIVE', probe: null, known: false };
    const pull = { pr: 884, headSha: HEAD, eligible: true };
    seen.push([stage.number, s.paused, duty.want(pull, status, f.clock(), describe({ pull, status, now: f.clock() }))?.description ?? null]);
    return runStage(batch, stage, o);
  };
  f = await executorFixture(t, { engine, status: new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') }) });
  await f.ledger.pause({ reason: 'fleet-node-reinstall-hold-after-install' });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.equal(f.exec.status.content.paused, true);
  const p = await f.ledger.paused();
  const { resumeRequest } = await import('../tools/rearm-tool.mjs');
  await writeOwnerRequest(path.join(f.root, 'owner'), resumeRequest({ expectedPausedSha256: p.sha256, by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.ok(seen.length >= 2, 'the batch ran in the resuming tick');
  for (const [stage, paused, text] of seen) {
    assert.equal(paused, false, `stage ${stage}: status still paused`);
    assert.ok(!/^停摆/.test(text ?? ''), `stage ${stage}: ${text}`);
  }
});
