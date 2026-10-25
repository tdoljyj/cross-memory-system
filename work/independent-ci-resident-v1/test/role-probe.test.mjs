import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleProbe, validateRoleProbeFact, ROLE_PROBE_CODES as C, ROLE_PROBE_INTERVAL_MS } from '../src/role-probe.mjs';
import { parseRoleProbe, createMergeSlotNative } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/merge-slot-native.mjs';
import { probeRole } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/role-probe-entry.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';

const at = Date.parse('2026-10-25T14:00:00Z');
const held = { result: 'held', code: C.held }, notHeld = { result: 'not-held', code: C['not-held'] }, uncertain = { result: 'uncertain', code: C.uncertain };
test('C2 has exactly three role states and refuses extra authority', () => {
  for (const f of [held, notHeld, uncertain, { result: 'uncertain', code: C.connection }]) assert.deepEqual(validateRoleProbeFact(f), f);
  for (const f of [{ ...held, active: true }, { result: 'held', code: C.uncertain }, { result: 'unknown', code: C.uncertain }]) assert.throws(() => validateRoleProbeFact(f));
});
test('idle-only cadence is 15min STANDBY, 30min ACTIVE; clocks never reset the floor', () => {
  const p = new RoleProbe();
  assert.equal(p.due({ now: at, mode: 'ACTIVE', idle: false }), false);
  assert.equal(p.due({ now: at, mode: 'UNCERTAIN', idle: true }), false);
  assert.equal(p.due({ now: at, mode: 'ACTIVE', idle: true }), true);
  p.observe(held, at);
  assert.equal(p.due({ now: at - 1, mode: 'ACTIVE', idle: true }), false);
  for (const mode of ['ACTIVE', 'STANDBY']) {
    const end = at + ROLE_PROBE_INTERVAL_MS[mode];
    assert.equal(p.due({ now: end - 1, mode, idle: true }), false);
    assert.equal(p.due({ now: end, mode, idle: true }), true);
  }
  assert.throws(() => p.observe(held, at - 1));
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
  const token = 'clued_bnd_fixture123456', reads = [], protectedCalls = [], native = [];
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
