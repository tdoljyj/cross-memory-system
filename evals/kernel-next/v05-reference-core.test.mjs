import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalLeaseSaga } from '../../kernel/policy/approval-lease.mjs';

const binding = () => ({
  approval_id: 'approval-1', subject_id: 'subject-1', scope_digest: 'sha256:scope', approval_vector: { generation: 3, sequence: 9 },
  plan_digest: 'sha256:plan', target_digest: 'sha256:target', risk_digest: 'sha256:risk', fencing_token: 'fence-7',
  not_before: 100, latest_action_start: 200, expires_at: 250
});

test('V05 CI-10/27 EIA-03/19: APPROVAL-LEASE-01 uses reserve → external-sign stub → issue as two transactions', () => {
  const saga = new ApprovalLeaseSaga();
  const reservation = saga.reserve(binding(), 150);
  assert.equal(reservation.transaction, 1);
  const signature = saga.externalSignStub('approval-1');
  const lease = saga.issue('approval-1', signature, 160);
  assert.equal(lease.transaction, 2);
  assert.equal(lease.status, 'ISSUED');
});

test('V05 CI-84/85 EIA-21/22/33: lease binds subject/scope/vector/plan/target/risk/fencing and approval use consumes once', () => {
  const saga = new ApprovalLeaseSaga();
  const exact = binding(); saga.reserve(exact, 150); const lease = saga.issue('approval-1', saga.externalSignStub('approval-1'), 160);
  const first = saga.consume({ lease_id: lease.lease_id, use_id: 'use-1', binding: exact, fencing_token: 'fence-7', now: 170 });
  assert.equal(first.consumed, true);
  assert.equal(saga.consume({ lease_id: lease.lease_id, use_id: 'use-1', binding: exact, fencing_token: 'fence-7', now: 170 }).idempotent_replay, true);
  assert.throws(() => saga.consume({ lease_id: lease.lease_id, use_id: 'use-2', binding: exact, fencing_token: 'fence-7', now: 170 }), /APPROVAL_USE_ALREADY_CONSUMED/);
});

test('V05 CI-87 EIA-35: now == latest_action_start is rejected at reserve, issue and consume boundaries', () => {
  assert.throws(() => new ApprovalLeaseSaga().reserve(binding(), 200), /APPROVAL_LATEST_ACTION_START_REACHED/);
  const issueSaga = new ApprovalLeaseSaga(); issueSaga.reserve(binding(), 150);
  assert.throws(() => issueSaga.issue('approval-1', issueSaga.externalSignStub('approval-1'), 200), /APPROVAL_LATEST_ACTION_START_REACHED/);
  const consumeSaga = new ApprovalLeaseSaga(); const exact = binding(); consumeSaga.reserve(exact, 150); const lease = consumeSaga.issue('approval-1', consumeSaga.externalSignStub('approval-1'), 160);
  assert.throws(() => consumeSaga.consume({ lease_id: lease.lease_id, use_id: 'use-1', binding: exact, fencing_token: 'fence-7', now: 200 }), /APPROVAL_LATEST_ACTION_START_REACHED/);
});
