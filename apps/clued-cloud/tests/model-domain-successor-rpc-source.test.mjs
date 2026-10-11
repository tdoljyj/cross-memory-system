import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY } from '../worker/model-domain-readonly.mjs';
import { SUCCESSOR_SOURCE_RPC, verifySuccessorWithExistingBindingRpc } from '../worker/model-domain-successor-rpc-source.mjs';

// Fictional transport responses only; these tests grant no live qualification.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-08T04:00:00Z', now = Date.parse(at);
const input = () => ({ permission_record_ref: { id: id(1), version: 1, content_hash: 'a'.repeat(64) },
  producer_registration_ref: { id: id(2), version: 1, content_hash: 'b'.repeat(64) },
  recognition_record_ref: { id: id(3), version: 1, content_hash: 'c'.repeat(64) }, recognition_receipt_id: id(4) });
const output = (request = input()) => ({ status: 'ACTOR_FREE_EXISTING_SOURCE_REFERENCES_READ_ONLY',
  recognition_record_ref: structuredClone(request.recognition_record_ref), recognition_receipt_ref: request.recognition_receipt_id,
  recognition_event_ref: '42', source_scope: POLICY.scope, evaluated_at: at,
  authority_effect: 'NONE', actual_execution: 'NONE', m2_qualification: 'NOT_ISSUED',
  domain_authority_receipt: 'NOT_ISSUED_BY_READER', data_gate: 'NOT_ISSUED', private_actor_fields_exposed: false });
const verify = response => verifySuccessorWithExistingBindingRpc(async () => response, input(), () => now);

test('one exact successor RPC receives only legacy reference selectors and returns immutable actor-free refs', async () => {
  const request = input(), response = output(request); let calls = 0;
  const result = await verifySuccessorWithExistingBindingRpc(async (name, payload) => {
    calls++; assert.equal(name, SUCCESSOR_SOURCE_RPC); assert.deepEqual(payload, request); return response;
  }, request, () => now);
  assert.equal(calls, 1); assert.deepEqual(result, response);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.recognition_record_ref));
  response.recognition_record_ref.version = 2;
  assert.equal(result.recognition_record_ref.version, 1);
});

test('invalid or authority-bearing caller input is denied before transport', async () => {
  for (const mutate of [x => ({ ...x, actor: id(8) }), x => ({ ...x, loader: () => output() }),
    x => ({ ...x, permission_record_ref: { ...x.permission_record_ref, grant: true } }),
    x => ({ ...x, producer_registration_ref: { ...x.producer_registration_ref, version: 1.5 } }),
    x => ({ ...x, recognition_record_ref: { ...x.recognition_record_ref, id: 1 } }),
    x => ({ ...x, recognition_receipt_id: 'unknown' }), () => null, () => []]) {
    let calls = 0;
    await assert.rejects(verifySuccessorWithExistingBindingRpc(async () => { calls++; }, mutate(input()), () => now));
    assert.equal(calls, 0);
  }
});

test('source failure has no legacy retry and reveals no private failure details', async () => {
  const names = [];
  await assert.rejects(verifySuccessorWithExistingBindingRpc(async name => {
    names.push(name); throw new Error('private credential or actor detail');
  }, input(), () => now), error => error.message === 'AUTHENTICATED_SUCCESSOR_SOURCE_DENIED_OR_UNAVAILABLE');
  assert.deepEqual(names, [SUCCESSOR_SOURCE_RPC]);
  await assert.rejects(verifySuccessorWithExistingBindingRpc({}, input(), () => now), /REAL_SERVER_RPC_REQUIRED/);
});

test('extra or missing response fields and legacy success do not become successor proof', async () => {
  for (const mutate of [x => ({ ...x, actor_user_id: id(8) }), x => ({ ...x, binding_id: id(9) }),
    x => ({ ...x, raw_record: {} }), x => ({ ...x, status: 'VERIFIED_EXISTING_SOURCE_REFERENCES_READ_ONLY' }),
    x => { delete x.private_actor_fields_exposed; return x; },
    x => ({ ...x, recognition_record_ref: { ...x.recognition_record_ref, actor: id(8) } })]) {
    await assert.rejects(verify(mutate(output())), /INVALID_SUCCESSOR_SOURCE_RESULT/);
  }
});

test('scope, qualification and authority escalation is rejected', async () => {
  for (const [key, value] of [['source_scope', 'global'], ['authority_effect', 'GRANTED'], ['actual_execution', 'DONE'],
    ['m2_qualification', 'PASS'], ['data_gate', 'PASS'], ['domain_authority_receipt', 'ISSUED'], ['private_actor_fields_exposed', true]]) {
    await assert.rejects(verify({ ...output(), [key]: value }), /INVALID_SUCCESSOR_SOURCE_RESULT/);
  }
});

test('recognition identity/version/hash, receipt and canonical event formats must match exactly', async () => {
  for (const mutate of [x => { x.recognition_record_ref.id = id(9); }, x => { x.recognition_record_ref.version = 2; },
    x => { x.recognition_record_ref.content_hash = 'd'.repeat(64); }, x => { x.recognition_receipt_ref = id(9); },
    ...[42, '0', '-1', '01', '1.0', '9223372036854775808', '1'.repeat(50)].map(value => x => { x.recognition_event_ref = value; })]) {
    const response = output(); mutate(response); await assert.rejects(verify(response), /INVALID_SUCCESSOR_SOURCE_RESULT/);
  }
});

test('timestamp normalization, stale/future observations and invalid clocks are denied', async () => {
  for (const timestamp of ['2026-02-30T04:00:00Z', '2026-10-08T24:00:00Z', '2026-10-08T04:00:00+01:00',
    '2026-10-08T03:54:59Z', '2026-10-08T04:00:01Z', null]) {
    await assert.rejects(verify({ ...output(), evaluated_at: timestamp }));
  }
  for (const clock of [NaN, Infinity, now + 0.5]) await assert.rejects(verifySuccessorWithExistingBindingRpc(async () => output(), input(), () => clock));
  assert.equal((await verify({ ...output(), evaluated_at: '2026-10-08T03:55:00Z' })).status, output().status);
});

test('transport mutation cannot change retained selectors or accepted returned snapshot', async () => {
  const request = input();
  await assert.rejects(verifySuccessorWithExistingBindingRpc(async (_name, payload) => {
    payload.recognition_record_ref.version = 2; return output(payload);
  }, request, () => now), /INVALID_SUCCESSOR_SOURCE_RESULT/);
  assert.equal(request.recognition_record_ref.version, 1);
});

test('non-JSON symbol, inherited and accessor fields cannot hide identity or trigger getters', async () => {
  const symbol = output(); symbol[Symbol('actor')] = id(8);
  await assert.rejects(verify(symbol));
  const inherited = Object.assign(Object.create({ actor: id(8) }), output());
  await assert.rejects(verify(inherited));
  let reads = 0; const accessor = output();
  Object.defineProperty(accessor, 'status', { enumerable: true, get() { reads++; return output().status; } });
  await assert.rejects(verify(accessor)); assert.equal(reads, 0);
});
