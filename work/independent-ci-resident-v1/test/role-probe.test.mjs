import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleProbe, validateRoleProbeFact, ROLE_PROBE_CODES as C, ROLE_PROBE_INTERVAL_MS, ROLE_PROBE_UNCERTAIN_BACKOFF_MS } from '../src/role-probe.mjs';
import { parseRoleProbe, createMergeSlotNative } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/merge-slot-native.mjs';
import { probeRole } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/role-probe-entry.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';

const at = Date.parse('2026-10-25T14:00:00Z');
const held = { result: 'held', code: C.held }, notHeld = { result: 'not-held', code: C['not-held'] }, uncertain = { result: 'uncertain', code: C.uncertain };
test('C2 has exactly three role states and refuses extra authority', () => {
  for (const f of [held, notHeld, uncertain, { result: 'uncertain', code: C.connection }]) assert.deepEqual(validateRoleProbeFact(f), f);
  for (const f of [{ ...held, active: true }, { result: 'held', code: C.uncertain }, { result: 'unknown', code: C.uncertain }]) assert.throws(() => validateRoleProbeFact(f));
});
test('idle-only cadence is 1 min STANDBY (and UNCERTAIN), 5 min ACTIVE; clocks never reset the floor (ADR 0025)', () => {
  assert.deepEqual(ROLE_PROBE_INTERVAL_MS, { STANDBY: 60_000, ACTIVE: 5 * 60_000 });
  const p = new RoleProbe();
  assert.equal(p.due({ now: at, mode: 'ACTIVE', idle: false }), false);
  assert.equal(p.due({ now: at, mode: 'NONE', idle: true }), false);
  assert.equal(p.due({ now: at, mode: 'ACTIVE', idle: true }), true);
  p.observe(held, at);
  assert.equal(p.due({ now: at - 1, mode: 'ACTIVE', idle: true }), false);
  for (const [mode, every] of [['ACTIVE', 5 * 60_000], ['STANDBY', 60_000], ['UNCERTAIN', 60_000]]) {
    assert.equal(p.due({ now: at + every - 1, mode, idle: true }), false);
    assert.equal(p.due({ now: at + every, mode, idle: true }), true);
  }
  assert.throws(() => p.observe(held, at - 1));
});
test('an idle ACTIVE node always learns it lost the role before the new holder can start (5-minute activation delay)', () => {
  // The server ends the old holder's role at T0 and starts the new one at T0 + 5 minutes. Whatever the phase of the old node's
  // last probe, its next one comes no later than T0 + 5 minutes; the new node's first held answer comes no earlier.
  const ACTIVATION_DELAY_MS = 5 * 60_000;
  for (const sinceLast of [0, 1, 60_000, 4 * 60_000 + 59_999]) {
    const p = new RoleProbe();
    const T0 = at + 10 * 60_000;
    p.observe(held, T0 - sinceLast);
    let t = T0;
    while (!p.due({ now: t, mode: 'ACTIVE', idle: true })) t += 1000;
    assert.ok(t <= T0 + ACTIVATION_DELAY_MS, `probed at T0+${t - T0} ms`);
  }
});
test('an uncertain answer backs off 1, 2, 4, then 5 minutes in every mode, never below the mode interval', () => {
  assert.deepEqual(ROLE_PROBE_UNCERTAIN_BACKOFF_MS, [60_000, 120_000, 240_000, 300_000]);
  const p = new RoleProbe();
  assert.equal(p.due({ now: at, mode: 'UNCERTAIN', idle: true }), true, 'a first probe is due');
  assert.equal(p.due({ now: at, mode: 'UNCERTAIN', idle: false }), false, 'only when nothing runs');
  let t0 = at;
  for (const wait of ROLE_PROBE_UNCERTAIN_BACKOFF_MS) {
    p.observe(uncertain, t0);
    for (const mode of ['UNCERTAIN', 'STANDBY']) {
      assert.equal(p.due({ now: t0 + wait - 1, mode, idle: true }), false);
      assert.equal(p.due({ now: t0 + wait, mode, idle: true }), true);
    }
    const active = Math.max(wait, ROLE_PROBE_INTERVAL_MS.ACTIVE);
    assert.equal(p.due({ now: t0 + active - 1, mode: 'ACTIVE', idle: true }), false, 'ACTIVE never sooner than its 5 minutes');
    assert.equal(p.due({ now: t0 + active, mode: 'ACTIVE', idle: true }), true);
    t0 += wait;
  }
  p.observe(uncertain, t0);
  assert.equal(p.due({ now: t0 + 5 * 60_000 - 1, mode: 'STANDBY', idle: true }), false, 'capped at 5 minutes');
  assert.equal(p.due({ now: t0 + 5 * 60_000, mode: 'STANDBY', idle: true }), true);
  assert.equal(p.due({ now: t0 - 1, mode: 'UNCERTAIN', idle: true }), false, 'a backward clock is never due');
  p.observe(notHeld, t0 + 5 * 60_000);
  assert.equal(p.due({ now: t0 + 6 * 60_000, mode: 'STANDBY', idle: true }), true, 'a definite answer ends the backoff');
});
test('clock skew: a clock that jumps back never probes early and never loses the book; one that jumps forward only probes sooner', () => {
  const p = new RoleProbe();
  p.observe(notHeld, at);
  // Back by ten minutes: not due until the clock is past the last answer plus the interval again.
  for (const now of [at - 10 * 60_000, at - 1, at + 59_999]) assert.equal(p.due({ now, mode: 'STANDBY', idle: true }), false);
  assert.throws(() => p.observe(held, at - 10 * 60_000), /ROLE_PROBE_CLOCK_REFUSED/);
  assert.equal(p.last.result, 'not-held', 'a refused observation leaves the book as it was');
  // Forward by an hour: due at once (one extra read-only probe), and the next interval counts from there.
  assert.equal(p.due({ now: at + 3_600_000, mode: 'STANDBY', idle: true }), true);
  p.observe(held, at + 3_600_000);
  assert.equal(p.due({ now: at + 3_600_000 + 59_999, mode: 'STANDBY', idle: true }), false);
});
test('C3 urgent: the next idle tick probes without waiting for the interval; any observation clears it; a backward clock is never due; it is not stored', () => {
  const p = new RoleProbe();
  p.observe(held, at);
  assert.equal(p.due({ now: at + 1000, mode: 'ACTIVE', idle: true }), false);
  p.markUrgent();
  assert.equal(p.due({ now: at + 1000, mode: 'ACTIVE', idle: true }), true);
  assert.equal(p.due({ now: at + 1000, mode: 'STANDBY', idle: true }), true);
  assert.equal(p.due({ now: at + 1000, mode: 'ACTIVE', idle: false }), false, 'only when nothing runs');
  assert.equal(p.due({ now: at - 1, mode: 'ACTIVE', idle: true }), false, 'a backward clock is never due');
  assert.equal(p.due({ now: at + 1000, mode: 'NONE', idle: true }), false, 'an unknown mode is never due');
  assert.deepEqual(Object.keys(p.snapshot()).sort(), ['connectionNotified', 'failingSince', 'failures', 'last', 'uncertainNotified'], 'urgent is not part of the book');
  p.observe(uncertain, at + 1000);
  assert.equal(p.urgent, false);
  assert.equal(p.due({ now: at + 1001, mode: 'STANDBY', idle: true }), false);
  const restored = new RoleProbe();
  restored.restore(p.snapshot());
  assert.equal(restored.urgent, false, 'a restart is urgent by the executor, not by the stored book');
});
test('uncertain notifies once at three consecutive failures and resets only on confirmed role', () => {
  const p = new RoleProbe();
  assert.equal(p.observe(uncertain, at).notices.length, 0);
  assert.equal(p.observe(uncertain, at + 1).notices.length, 0);
  assert.equal(p.observe(uncertain, at + 2).notices[0].kind, 'role-probe-uncertain');
  assert.equal(p.observe(uncertain, at + 3).notices.length, 0);
  assert.equal(p.observe(notHeld, at + 4).probe.failures, 0);
  p.observe(uncertain, at + 5); p.observe(uncertain, at + 6);
  assert.equal(p.observe(uncertain, at + 7).notices.length, 1);
});
test('revoked/expired authorization has a distinct stable notification without claiming an exact cause', () => {
  const p = new RoleProbe(), connection = { result: 'uncertain', code: C.connection };
  assert.equal(p.observe(connection, at).notices[0].kind, 'role-probe-connection');
  assert.equal(p.observe(connection, at + 1).notices.length, 0);
  assert.equal(p.observe(connection, at + 2).notices[0].kind, 'role-probe-uncertain');
  assert.equal(p.last.result, 'uncertain');
  p.observe(held, at + 3);
  assert.equal(p.observe(connection, at + 4).notices[0].kind, 'role-probe-connection');
});
test('role-gated RPC truth table never exposes holders, claims, raw errors or an invented role', () => {
  const repo = 'tdoljyj/cross-memory-system';
  assert.deepEqual(parseRoleProbe(200, { status: 'ok', repository: repo, holders: [] }, repo), held);
  assert.deepEqual(parseRoleProbe(200, { status: 'ok', reason: 'admission_binding_required', holders: [] }, repo), notHeld);
  assert.deepEqual(parseRoleProbe(403, { code: '42501', message: 'binding_not_authorized', details: 'untrusted text' }, repo), { result: 'uncertain', code: C.connection });
  assert.deepEqual(parseRoleProbe(403, { code: '42501', message: 'authorization_revoked_or_expired' }, repo), { result: 'uncertain', code: C.connection });
  assert.deepEqual(parseRoleProbe(200, { status: 'ok', reason: 'admission_binding_required', holders: [{}] }, repo), uncertain);
  for (const [http, v] of [[500, {}], [200, { status: 'REJECTED' }], [200, { status: 'ok', reason: 'some_new_reason', holders: [] }], [200, { status: 'ok', repository: 'wrong/repo', holders: [] }], [403, { code: '42501', message: 'other' }]])
    assert.deepEqual(parseRoleProbe(http, v, repo), uncertain);
});
test('role probe sends only the fixed read RPC, scope/repository and token hash; no PR/evaluate/meter/write', async () => {
  const calls = [], config = { supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'fixture-public-key', scope: 'project:fixture', repository: 'tdoljyj/cross-memory-system' };
  const port = createMergeSlotNative({ config, nativeToken: 'fixture-token', fetchImpl: async (url, opts) => {
    calls.push({ url, opts }); return new Response(JSON.stringify({ status: 'ok', repository: config.repository, holders: [] }), { status: 200 });
  } });
  assert.deepEqual(await port.roleProbe(), held);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://fixture.supabase.co/rest/v1/rpc/clued_work_merge_slot_holders_v1');
  assert.equal(calls[0].opts.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { p_token_hash: digest('fixture-token'), p_input: { scope: config.scope, repository: config.repository } });
  const bad = createMergeSlotNative({ config, nativeToken: 'fixture-token', fetchImpl: async () => { throw Error('token-like untrusted detail'); } });
  assert.deepEqual(await bad.roleProbe(), uncertain);
  const huge = createMergeSlotNative({ config, nativeToken: 'fixture-token', fetchImpl: async () => new Response('x'.repeat(65537)) });
  assert.deepEqual(await huge.roleProbe(), uncertain);
});
test('controller entry reads exactly native token under the pinned full-profile SID; never App key', async () => {
  const token = 'clued_bnd_00000000', reads = [], protectedCalls = [], native = [];
  const record = { accepted: { node: { controllerSid: 'S-1-5-21-1-2-3-1015' }, ciTokenPinSha256: digest('clued.independent-ci.ci-binding-pin/1\0' + token) },
    config: { supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'fixture', scope: 'project:fixture', repository: 'tdoljyj/cross-memory-system' } };
  const out = await probeRole({ record, live() {}, protect: async (...v) => protectedCalls.push(v), tokenReader: async (file, options) => { reads.push({ file, options }); return token; },
    fetchImpl: async (...v) => { native.push(v); return new Response(JSON.stringify({ status: 'ok', repository: record.config.repository, holders: [] })); } });
  assert.deepEqual(out, { status: 'BLOCKED', reason: C.held, sideEffects: 0 });
  assert.equal(reads.length, 1); assert.match(reads[0].file, /ci-admission\.token$/);
  assert.equal(reads[0].options.controllerSid, record.accepted.node.controllerSid); assert.equal(protectedCalls.length, 1); assert.equal(native.length, 1);
  await assert.rejects(probeRole({ record: { ...record, accepted: { ...record.accepted, ciTokenPinSha256: '0'.repeat(64) } }, live() {}, protect: async () => {}, tokenReader: async () => token, fetchImpl: async () => { assert.fail('no request'); } }), { code: 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' });
});
test('bounded probe state survives restart without losing uncertainty or repeating notices', () => {
  const p = new RoleProbe(); p.observe({ result: 'uncertain', code: C.connection }, at); p.observe(uncertain, at + 1); p.observe(uncertain, at + 2);
  const restored = new RoleProbe(); restored.restore(p.snapshot());
  assert.equal(restored.observe({ result: 'uncertain', code: C.connection }, at + 3).notices.length, 0);
  assert.equal(restored.due({ now: at + 4, mode: 'ACTIVE', idle: true }), false);
  assert.throws(() => restored.restore({ ...p.snapshot(), failures: -1 }));
});
