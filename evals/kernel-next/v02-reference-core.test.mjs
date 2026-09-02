import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryOperationCommitStore } from '../../kernel/domain/operation-commit.mjs';
import { CheckpointPointerStore, LkgRegistry, negotiateProtocol } from '../../kernel/runtime/continuity-runtime.mjs';

const operation = (id = 'op-1') => ({
  operation_id: id, aggregate_id: 'subject-1', expected_version: 0, next_state: { status: 'ACTIVE' },
  event: { type: 'SubjectActivated', payload: { source: 'fixture' } },
  receipt_stub: { receipt_id: 'receipt-1', result: 'ACCEPTED' },
  outbox: [{ message_id: 'msg-1', topic: 'subject.changed', payload: { id: 'subject-1' } }, { message_id: 'msg-2', topic: 'audit.append', payload: { id: 'subject-1' } }]
});

test('V02 CI-13/29/30 EIA-16: OperationCommit atomically writes canonical transition, ordered Event, Receipt Stub and Outbox', () => {
  const store = new InMemoryOperationCommitStore();
  const result = store.commit(operation());
  assert.equal(result.aggregate.version, 1);
  assert.equal(result.event.sequence, 1);
  assert.equal(result.receipt_stub.event_sequence, 1);
  assert.deepEqual(result.outbox.map((item) => item.order), [1, 2]);
  assert.equal(store.snapshot().outbox.length, 2);
});

test('V02 CI-13/33 EIA-27: invalid outbox and CAS conflict leave no partial OperationCommit writes', () => {
  const store = new InMemoryOperationCommitStore();
  const invalid = operation(); invalid.outbox[1].message_id = 'msg-1';
  assert.throws(() => store.commit(invalid), /OUTBOX_DUPLICATE_MESSAGE/);
  assert.deepEqual(store.snapshot(), { aggregates: [], events: [], receipt_stubs: [], outbox: [] });
  const conflict = operation('op-2'); conflict.expected_version = 7;
  assert.throws(() => store.commit(conflict), /CANONICAL_VERSION_CONFLICT/);
  assert.equal(store.snapshot().events.length, 0);
});

test('V02 CI-40 EIA-24: protocol/profile/schema negotiation fails closed and downgrade requires explicit opt-in', () => {
  assert.throws(() => negotiateProtocol({ client: { majors: [2], profiles: ['p1'], schemas: ['s1'] }, server: { majors: [1], profiles: ['p1'], schemas: ['s1'] } }), /PROTOCOL_MAJOR_UNSUPPORTED/);
  assert.throws(() => negotiateProtocol({ client: { majors: [2,1], preferred_major: 2, profiles: ['p1'], schemas: ['s1'] }, server: { majors: [1], profiles: ['p1'], schemas: ['s1'] } }), /PROTOCOL_DOWNGRADE_NOT_AUTHORIZED/);
  assert.deepEqual(negotiateProtocol({ client: { majors: [2,1], preferred_major: 2, allow_downgrade: true, profiles: ['p2','p1'], schemas: ['s1'] }, server: { majors: [1], profiles: ['p1'], schemas: ['s1'] } }), { major: 1, profile: 'p1', schema: 's1', decision: 'NEGOTIATED_EXACT_INTERSECTION' });
});

test('V02 CI-42 EIA-38: LKG enforces TTL, same-generation immutability and anti-rollback', () => {
  const lkg = new LkgRegistry();
  lkg.accept({ key: 'profile', generation: 2, digest: 'sha256:new', issued_at: 10, expires_at: 30 }, 20);
  assert.equal(lkg.resolve('profile', 29).generation, 2);
  assert.throws(() => lkg.resolve('profile', 30), /LKG_TTL_EXPIRED/);
  assert.throws(() => lkg.accept({ key: 'profile', generation: 1, digest: 'sha256:old', issued_at: 10, expires_at: 40 }, 20), /LKG_ROLLBACK_REJECTED/);
  assert.throws(() => lkg.accept({ key: 'profile', generation: 2, digest: 'sha256:drift', issued_at: 10, expires_at: 40 }, 20), /LKG_SAME_GENERATION_DRIFT/);
});

test('V02 CI-33/42 EIA-27/38: checkpoint and snapshot pointer updates use CAS and verified readback', () => {
  const store = new CheckpointPointerStore();
  assert.equal(store.writeCheckpoint({ run_id: 'run-1', expected_version: 0, state_digest: 'sha256:s1', next_step: 'step-2' }).version, 1);
  assert.throws(() => store.writeCheckpoint({ run_id: 'run-1', expected_version: 0, state_digest: 'sha256:s2', next_step: 'step-3' }), /CHECKPOINT_CAS_CONFLICT/);
  assert.throws(() => store.casPointer({ expected_version: 0, next_version: 1, digest: 'sha256:a', readback_digest: 'sha256:b' }), /POINTER_READBACK_MISMATCH/);
  assert.deepEqual(store.casPointer({ expected_version: 0, next_version: 1, digest: 'sha256:a', readback_digest: 'sha256:a' }), { version: 1, digest: 'sha256:a' });
  assert.throws(() => store.casPointer({ expected_version: 0, next_version: 1, digest: 'sha256:a', readback_digest: 'sha256:a' }), /POINTER_CAS_CONFLICT/);
});
