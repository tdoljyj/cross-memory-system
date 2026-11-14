// DESIGN §72, ADR 0027: a batch stands only while its PR is open, the PR's head is the batch's head and this node holds ci-admission.
// When one of them is known to be false, the next tick ends it the one way (SUPERSEDED_AT_SAFE_POINT: quiescence, the head burned, a
// rename-only archive), under PAUSE too. No answer never ends a batch; park.maxMs stays the backstop outside the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PAUSE_CONTRACT, SUPERSEDE_LIVE_READ_MS, SUPERSEDED_AT_SAFE_POINT, SUPERSEDED_ARCHIVE_REASON } from '../src/executor.mjs';
import { Ledger, batchKey } from '../src/ledger.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, holdAtA, rawPolicy, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-13T08:00:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const reads = f => f.companion.calls.filter(c => c[0] === 'pr-head').length - (f.readsBefore ?? 0);
const receiptBodies = async (f, type) => {
  const dir = path.join(f.root, 'state', 'receipts');
  const out = [];
  for (const n of (await fs.readdir(dir)).sort()) if (n.endsWith(`-${type}.json`)) out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')).body);
  return out;
};
// What the uninstall and the reinstall's W1 count: ledger entries without 90-terminal.json.
const openEntries = async f => {
  const dir = path.join(f.root, 'state', 'ledger');
  let n = 0;
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    if (d.isDirectory() && !(await fs.stat(path.join(dir, d.name, '90-terminal.json')).then(() => true, () => false))) n += 1;
  }
  return n;
};
const notReady = code => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null } }, safeToRerun: false } });
const HELD = { result: 'held', code: 'ROLE_PROBE_HELD' };
const UNCERTAIN = { result: 'uncertain', code: 'ROLE_PROBE_UNCERTAIN' };
const probeResult = fact => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true }, roleProbe: fact,
  outcome: { status: 'BLOCKED', reason: fact.code, sideEffects: 0, mayHavePublished: false } });

// A node whose stage 8 is never ready (the claim never reaches the merge-queue head, as for PR #1080), whose PR the companion reads as
// `pr.state` / `pr.headSha`, with an optional role probe (facts: its answers, the last one repeats) and a heartbeat it may let lapse.
async function fx(t, { probe = null, policy = rawPolicy(), hint = null } = {}) {
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 8 ? (engine.calls.push(['stage', 8]), notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED')) : base(batch, stage, o));
  if (probe) {
    engine.facts = [...probe];
    engine.runRoleProbe = async () => probeResult(engine.facts.length > 1 ? engine.facts.shift() : engine.facts[0]);
  }
  const pr = { state: 'open', headSha: HEAD, answer: true };
  const script = { pull: n => (pr.answer ? { number: n, state: pr.state, headSha: pr.headSha } : null), hint };
  let f;
  const companion = fakeCompanion(script, () => f?.clock() ?? T0);
  f = await executorFixture(t, { engine, companion, policy, now: T0 });
  return Object.assign(f, { pr, script });
}
async function parkedAtB(f) {
  await f.drop(triggerBytes());
  for (let i = 0; i < 3 && !Ledger.parkedAt(await f.ledger.state(KEY)); i++) await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'parked at B');
  f.readsBefore = reads(f); // runRow's own read before the reservation is not the rule's
}
const ended = async (f, basis, stage = 8) => {
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode, s.terminal.facts.basis, s.terminal.facts.stage, s.selfAbort.basis],
    ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, basis, stage, basis]);
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'archive-windows').map(c => c[1]), [SUPERSEDED_ARCHIVE_REASON], 'one rename-only archive');
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 'never an attempt 2');
  assert.equal(await openEntries(f), 0);
};

test('PR closed: a batch parked at B ends at its next live read (within 10 minutes), not after 24 hours of stage-8 tries', async t => {
  const f = await fx(t);
  await parkedAtB(f);
  const tries = stagesRun(f.engine).filter(n => n === 8).length;
  f.pr.state = 'closed';
  f.advance(SUPERSEDE_LIVE_READ_MS - 1);
  await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'stage 1 was the first read: the next is 10 minutes after it');
  assert.equal(reads(f), 0);
  f.advance(1);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'parked']);
  assert.equal(stagesRun(f.engine).filter(n => n === 8).length, tries, 'no stage-8 try after the read showed the PR closed');
  assert.equal(reads(f), 1);
  await ended(f, 'pr-closed');
  assert.equal(await f.executedHeads.published(subject()), true, 'stages 3, 5, 7 published: the head is never run again');
  assert.deepEqual((await receiptBodies(f, 'batch-terminal')).map(b => [b.failureCode, b.basis]).at(-1), [SUPERSEDED_AT_SAFE_POINT, 'pr-closed']);
});

test('PR new commit: the live read ends the parked batch even without a trigger; a trigger makes the read due at once', async t => {
  // no trigger (the poller did not see it): the batch's own 10-minute read
  const f = await fx(t);
  await parkedAtB(f);
  f.pr.headSha = H(7);
  f.advance(SUPERSEDE_LIVE_READ_MS);
  assert.equal((await f.exec.tick()).failureCode, SUPERSEDED_AT_SAFE_POINT);
  await ended(f, 'head-moved');
  // a trigger for the newer commit: the read is due on the very next tick
  const g = await fx(t);
  await parkedAtB(g);
  g.pr.headSha = H(7);
  await g.drop(triggerBytes({ headSha: H(7) }));
  g.advance(1);
  const r = await g.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT]);
  await ended(g, 'head-moved');
  assert.equal((await g.exec.tick()).state, 'PARKED', 'the newer commit runs next (and parks: its stage 8 is not ready either)');
});

test('node loses duty: STANDBY ends every resting batch (A and B) at the next tick, without a PR read; UNCERTAIN and a stale heartbeat do not', async t => {
  // B: the probe said held; then the role moved (STANDBY): ended at once, no live read needed
  const f = await fx(t, { probe: [HELD] });
  await f.exec.tick();
  await parkedAtB(f);
  await f.exec.setNodeMode('STANDBY', 'probe-not-held');
  const tries = stagesRun(f.engine).filter(n => n === 8).length;
  f.advance(1);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'parked']);
  assert.equal(reads(f), 0, 'the node mode alone decides');
  assert.equal(stagesRun(f.engine).filter(n => n === 8).length, tries, 'no stage-8 try on a node off duty');
  await ended(f, 'not-on-duty');

  // A: a batch resting at parking point A ends the same way (stage 1 only: not published, the head may run on the node on duty)
  const g = await fx(t, { probe: [HELD] });
  holdAtA(g.exec);
  await g.exec.tick();
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  await g.exec.setNodeMode('STANDBY', 'probe-not-held');
  g.advance(MIN);
  const a = await g.exec.tick();
  assert.deepEqual([a.state, a.failureCode, a.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'waiting']);
  await ended(g, 'not-on-duty', 1);
  assert.equal(await g.executedHeads.published(subject()), false);

  // UNCERTAIN is no answer: the batch stays (and the stale heartbeat case below too)
  const h = await fx(t, { probe: [HELD, UNCERTAIN] });
  await h.exec.tick();
  await parkedAtB(h);
  await h.exec.setNodeMode('UNCERTAIN', 'test');
  h.advance(1);
  await h.exec.tick();
  h.advance(1);
  await h.exec.tick();
  assert.equal(h.exec.nodeMode(), 'UNCERTAIN');
  assert.ok(Ledger.parkedAt(await h.ledger.state(KEY)), 'UNCERTAIN never ends a batch');
  // STANDBY with a lapsed companion heartbeat: the end needs the companion's quiescence proof, so it waits for the next tick
  const k = await fx(t, { probe: [HELD] });
  await k.exec.tick();
  await parkedAtB(k);
  await k.exec.setNodeMode('STANDBY', 'probe-not-held');
  k.script.heartbeat = k.clock() - 10 * MIN;
  k.advance(1);
  await k.exec.tick();
  assert.ok(Ledger.parkedAt(await k.ledger.state(KEY)), 'no fresh heartbeat: not yet');
  assert.equal(await k.ledger.halted(), null, 'and no HALT');
  delete k.script.heartbeat;
  k.advance(1);
  assert.equal((await k.exec.tick()).failureCode, SUPERSEDED_AT_SAFE_POINT);
});

test('PR state unreadable: the batch stays parked (one read per 10 minutes, no receipt churn) until park.maxMs, the backstop', async t => {
  const f = await fx(t);
  await parkedAtB(f);
  f.pr.answer = false;
  for (let i = 0; i < 6; i++) { f.advance(SUPERSEDE_LIVE_READ_MS); await f.exec.tick(); }
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)), 'no answer is never a fact');
  assert.equal(reads(f), 6, 'one read per 10 minutes');
  assert.deepEqual(await receiptBodies(f, 'supersede-unconfirmed'), [], 'nothing named another head: no receipt');
  assert.equal(await f.ledger.halted(), null);
  // a trigger names another head while the read still fails: one receipt, the batch still stays
  await f.drop(triggerBytes({ headSha: H(7) }));
  f.advance(1);
  await f.exec.tick();
  assert.ok(Ledger.parkedAt(await f.ledger.state(KEY)));
  assert.equal((await receiptBodies(f, 'supersede-unconfirmed')).length, 1);
  // park.maxMs is outside the rule: it bounds how long a batch the rule cannot decide holds its parking place
  f.advance(24 * 60 * MIN);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'RESIDENT_QUEUE_HEAD_NOT_REACHED']);
});

test('reinstall: on a paused node off duty the rule ends the residue, so W1 and the uninstall find no open batch; the pause stays', async t => {
  const f = await fx(t, { probe: [HELD] });
  await f.exec.tick();
  await parkedAtB(f);
  await f.drop(Buffer.from(JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'reinstall' })), 'requests');
  f.advance(1);
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  const pause = await f.ledger.paused();
  assert.equal(await openEntries(f), 1, 'on duty, the PR open at the head: the batch stands, also under PAUSE');
  await f.exec.setNodeMode('STANDBY', 'probe-not-held');
  const tries = stagesRun(f.engine).filter(n => n === 8).length;
  f.advance(1);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT]);
  assert.equal(await openEntries(f), 0, 'no open batch: nothing for an Owner re-arm or drain to do');
  assert.equal(stagesRun(f.engine).filter(n => n === 8).length, tries, 'PAUSE still stops every try');
  f.advance(1);
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.equal((await f.ledger.paused()).sha256, pause.sha256, 'the pause is untouched');
  assert.equal(await f.ledger.halted(), null);
});

test('attempt 2: one live read after the precheck closes it when the head moved on (ATTEMPT2_SUPERSEDED); none when the read fails', async t => {
  for (const [answer, want] of [[true, ['IGNORED', 'ATTEMPT2_SUPERSEDED']], [false, ['COMPLETED', undefined]]]) {
    let n = 0;
    const engine = fakeEngine();
    const base = engine.runStage;
    engine.runStage = async (batch, stage) => (stage.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(batch, stage));
    let head = HEAD;
    const f = await executorFixture(t, { engine, companion: fakeCompanion({ pull: pr => (answer ? { number: pr, state: 'open', headSha: head } : null) }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
    const before = f.companion.calls.filter(c => c[0] === 'pr-head').length;
    head = H(7);
    f.advance(600_000);
    const second = await f.exec.tick();
    assert.deepEqual([second.state, second.reason], want);
    assert.equal(f.companion.calls.filter(c => c[0] === 'pr-head').length - before, 1, 'one read');
    assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  }
});
