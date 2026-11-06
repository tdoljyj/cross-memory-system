// Generation 13 (DESIGN §57.1, Owner Decision 2907d858; Task 6104ca37): a role probe (or a queue watch) interrupted by a restart or a power
// cut is recovered by itself; only policy roleProbe.interruptedMax interruptions in a row, or a Windows side that is not quiet, HALT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_PROBE_CODES } from '../src/role-probe.mjs';
import { POLICY_CONTRACT_V10, TRAIN_DEFAULTS, validatePolicy } from '../src/policy.mjs';
import fs from 'node:fs/promises';
import { events } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { executorFixture, rawPolicy } from './helpers.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-06T08:00:00Z');
const NETWORK = { trialDelayMs: 600_000, earlyTrialProbes: 2, releasesPerHeadPer24h: 36 };
const v10 = (interruptedMax = 3) => { const p = rawPolicy(); return rawPolicy({ contract: POLICY_CONTRACT_V10, breaker: { ...p.breaker, network: NETWORK },
  train: { ...p.train, ...TRAIN_DEFAULTS }, roleProbe: { interruptedMax } }); };
const probeResult = (fact = { result: 'held', code: ROLE_PROBE_CODES.held }) => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
  roleProbe: fact, outcome: { status: 'BLOCKED', reason: fact.code, sideEffects: 0, mayHavePublished: false } });

// A fixture whose receipts already hold `before` (a list of 'done' | 'interrupted' | 'halted' probes) and then one open intent.
async function interrupted(t, { policy = v10(), before = [], windows = undefined, watchPr = null } = {}) {
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { policy, status: board, now: T0, ...(windows ? { engineScript: { windows } } : {}) });
  if (windows) f.engine.windowsQuiescence = async () => windows;
  for (const kind of before) {
    const intent = await f.receipts.append('role-probe-intent', { mode: 'ACTIVE' });
    const state = { last: { result: 'held', code: ROLE_PROBE_CODES.held, at: T0 - 10 * MIN }, failures: 0, failingSince: null, connectionNotified: false, uncertainNotified: false };
    await f.receipts.append('role-probe-result', { intentSeq: intent.seq, deferred: false, ok: kind === 'done', fact: kind === 'done' ? { result: 'held', code: ROLE_PROBE_CODES.held } : null,
      ...(kind === 'done' ? {} : { interrupted: true, halted: kind === 'halted' }), state });
  }
  f.openIntent = await f.receipts.append('role-probe-intent', { mode: 'ACTIVE', ...(watchPr ? { watchPr } : {}) });
  f.probes = 0;
  f.engine.runRoleProbe = async () => { f.probes += 1; return probeResult(); };
  f.board = board;
  return f;
}
const lastResult = async f => (await f.receipts.latest(['role-probe-result'], 1))[0].value.body;

test('policy /10: roleProbe.interruptedMax 1..10 is required, and only under /10', () => {
  assert.equal(validatePolicy(v10(3)).roleProbe.interruptedMax, 3);
  for (const bad of [0, 11, 2.5, '3']) assert.throws(() => validatePolicy(v10(bad)), { code: 'POLICY_ROLE_PROBE_INVALID' });
  const p = v10(); delete p.roleProbe;
  assert.throws(() => validatePolicy(p), { code: 'POLICY_KEYS_INVALID' });
  assert.throws(() => validatePolicy({ ...v10(), roleProbe: { interruptedMax: 3, extra: 1 } }), { code: 'POLICY_ROLE_PROBE_KEYS_INVALID' });
  assert.throws(() => validatePolicy({ ...rawPolicy(), roleProbe: { interruptedMax: 3 } }), { code: 'POLICY_KEYS_INVALID' }, 'not under /7');
});

test('one interruption under /10: closed as interrupted, the role judged afresh at once, no HALT, the Owner told once', async t => {
  const f = await interrupted(t, { before: ['done'] });
  const r = await f.exec.tick();
  assert.notEqual(r.state, 'HALTED');
  assert.equal(await f.ledger.halted(), null);
  assert.equal(f.probes, 1, 'a fresh probe ran at once (urgent)');
  const results = await f.receipts.latest(['role-probe-result'], 2);
  assert.deepEqual([results[0].value.body.interrupted, results[0].value.body.halted, results[0].value.body.interruptions], [true, false, 1]);
  assert.equal(results[1].value.body.ok, true, 'the fresh probe ended with a fact');
  assert.equal(f.exec.roleProbe.last.result, 'held');
  const st = parseStatus(Buffer.from(JSON.stringify(f.board.snapshot())));
  const toasts = events({ status: st, now: f.clock() }).filter(e => e.key.startsWith('notice:role-probe-interrupted:'));
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].title, /已自动恢复/);
});

test('the recovered role book is the last probe that ended; nothing of the interrupted one is used', async t => {
  const f = await interrupted(t, { before: ['done'] });
  f.engine.runRoleProbe = async () => { f.probes += 1; return { ok: false, code: 'ROLE_PROBE_BUSY', deferred: true, proof: null, roleProbe: null }; };
  await f.exec.tick();
  const closed = (await f.receipts.latest(['role-probe-result'], 2)).find(r => r.value.body.interrupted === true).value.body;
  assert.equal(closed.state.last.at, T0 - 10 * MIN, 'restored from the last ended probe');
  assert.equal(closed.fact, null);
});

test('interruptions in a row reach interruptedMax: HALT as before; a probe that ended in between resets the count', async t => {
  const a = await interrupted(t, { before: ['done', 'interrupted', 'interrupted'] });
  assert.equal((await a.exec.tick()).state, 'HALTED');
  assert.equal((await a.ledger.halted()).value.code, 'ROLE_PROBE_INTERRUPTED');
  assert.equal(a.probes, 0);
  assert.deepEqual([(await lastResult(a)).interrupted, (await lastResult(a)).halted], [true, true]);
  const b = await interrupted(t, { before: ['interrupted', 'interrupted', 'done', 'interrupted'] });
  assert.notEqual((await b.exec.tick()).state, 'HALTED', 'two in a row after a probe that ended');
  assert.equal(b.probes, 1);
  // a HALT the Owner re-armed ends the row too
  const c = await interrupted(t, { before: ['interrupted', 'halted'] });
  assert.notEqual((await c.exec.tick()).state, 'HALTED');
});

test('a Windows side that is not quiet (a swap may still be in flight) HALTs whatever the count', async t => {
  for (const windows of [{ windowsTreeZero: false, serviceOriginalStopped: true }, { windowsTreeZero: true, serviceOriginalStopped: false }]) {
    const f = await interrupted(t, { before: ['done'], windows });
    assert.equal((await f.exec.tick()).state, 'HALTED', JSON.stringify(windows));
    assert.equal((await f.ledger.halted()).value.code, 'ROLE_PROBE_INTERRUPTED');
    assert.equal(f.probes, 0);
  }
  const g = await interrupted(t, { before: ['done'] });
  g.engine.windowsQuiescence = async () => { throw new Error('unreadable'); };
  assert.equal((await g.exec.tick()).state, 'HALTED');
});

test('under /9 and earlier an interruption still HALTs at once (interruptedMax 1)', async t => {
  const f = await interrupted(t, { policy: rawPolicy(), before: ['done'] });
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal((await f.ledger.halted()).value.code, 'ROLE_PROBE_INTERRUPTED');
  assert.equal(f.probes, 0);
  const g = await interrupted(t, { policy: v10(1), before: ['done'] });
  assert.equal((await g.exec.tick()).state, 'HALTED', 'interruptedMax 1 under /10 too');
});

test('an interrupted queue watch (its intent carries watchPr) is recovered the same way', async t => {
  const f = await interrupted(t, { before: ['done'], watchPr: 1001 });
  assert.notEqual((await f.exec.tick()).state, 'HALTED');
  assert.equal(await f.ledger.halted(), null);
  const closed = (await f.receipts.latest(['role-probe-result'], 2)).find(r => r.value.body.intentSeq === f.openIntent.seq).value.body;
  assert.deepEqual([closed.interrupted, closed.halted], [true, false]);
  assert.deepEqual(f.exec.roleProbeNotices.map(n => n.kind), ['role-probe-interrupted']);
});

test('an earlier start HALTed for this intent and crashed before its result: closed as halted, no notice, never recovered (review round 1, MINOR 1)', async t => {
  const f = await interrupted(t, { before: ['done'] });
  await f.ledger.halt('ROLE_PROBE_INTERRUPTED', { intentSeq: f.openIntent.seq, interruptions: 3, interruptedMax: 3, windowsQuiet: true });
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal(f.probes, 0);
  const last = await lastResult(f);
  assert.deepEqual([last.intentSeq, last.interrupted, last.halted], [f.openIntent.seq, true, true]);
  assert.deepEqual(f.exec.roleProbeNotices, []);
  // the next count starts after it: a halted interruption is never counted as one that was not HALTed
  assert.equal((await f.receipts.latest(['role-probe-result'], 5)).filter(r => r.value.body.interrupted === true && r.value.body.halted !== true).length, 0);
});

test('a HALT for another intent (or another code) is not this one: the open intent is decided as usual', async t => {
  const f = await interrupted(t, { before: ['done'] });
  await f.ledger.halt('ROLE_PROBE_INTERRUPTED', { intentSeq: f.openIntent.seq - 1 });
  await f.exec.tick();
  const last = (await f.receipts.latest(['role-probe-result'], 3)).find(r => r.value.body.intentSeq === f.openIntent.seq)?.value.body;
  assert.equal(last?.interruptions, 1, 'decided by the count of interruptions, not closed by the HALT of another intent');
});

test('policy /10 example: the /9 example plus roleProbe.interruptedMax 3, nothing else', async () => {
  const read = async name => JSON.parse(await fs.readFile(new URL(`../config/${name}`, import.meta.url), 'utf8'));
  const v9 = await read('policy.v9.example.json'), v10x = await read('policy.v10.example.json');
  assert.equal(validatePolicy(v10x).contract, POLICY_CONTRACT_V10);
  const { roleProbe, ...rest } = v10x;
  assert.deepEqual(roleProbe, { interruptedMax: 3 });
  assert.deepEqual({ ...rest, contract: v9.contract }, v9);
});

test('a halted interruption carries the role book of the last probe that ended, so a later recovery never starts from an empty one (review round 1, NIT)', async t => {
  const f = await interrupted(t, { policy: v10(1), before: ['done'] });
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const halted = await lastResult(f);
  assert.deepEqual([halted.halted, halted.state.last?.result, halted.state.last?.at], [true, 'held', T0 - 10 * MIN]);
});

test('a node HALTed for something else gets no "recovered by itself" notice; the HALT is what the Owner sees (review round 2, NIT)', async t => {
  const f = await interrupted(t, { before: ['done'] });
  await f.ledger.halt('OWNER_TEST_HALT', {});
  await f.exec.tick();
  const closed = (await f.receipts.latest(['role-probe-result'], 2)).find(r => r.value.body.intentSeq === f.openIntent.seq).value.body;
  assert.deepEqual([closed.interrupted, closed.halted], [true, false]);
  assert.deepEqual(f.exec.roleProbeNotices, []);
});

test('a recovery whose fresh probe never ran (stopped again right after the closing record): the probe is still due at once (review round 2, NIT)', async t => {
  const f = await interrupted(t, { before: ['done'] });
  const s = (await f.receipts.latest(['role-probe-result'], 1))[0].value.body.state;
  await f.receipts.append('role-probe-result', { intentSeq: f.openIntent.seq, deferred: false, ok: false, fact: null, interrupted: true, halted: false, interruptions: 1, state: s });
  assert.equal(await f.exec.roleProbeRecover(), null);
  assert.equal(f.exec.roleProbe.urgent, true);
});
