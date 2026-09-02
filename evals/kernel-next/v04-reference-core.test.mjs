import assert from 'node:assert/strict';
import test from 'node:test';
import { AttemptCoordinator } from '../../kernel/domain/attempt-fsm.mjs';

function running(coordinator, id = 'a1') {
  coordinator.create(id);
  coordinator.transition(id, 'DISPATCHED', { expected_version: 0 });
  return coordinator.transition(id, 'RUNNING', { expected_version: 1 });
}

test('V04 CI-08/12/17 EIA-01/02/04: Attempt FSM accepts only legal CAS-bound edges', () => {
  const c = new AttemptCoordinator(); running(c);
  assert.throws(() => c.transition('a1', 'CREATED', { expected_version: 2 }), /ATTEMPT_EDGE_ILLEGAL/);
  assert.throws(() => c.transition('a1', 'SUCCEEDED', { expected_version: 1 }), /ATTEMPT_CAS_CONFLICT/);
  assert.equal(c.transition('a1', 'SUCCEEDED', { expected_version: 2, evidence_state: 'FINAL' }).outcome, 'SUCCESS');
});

test('V04 CI-31/32/35 EIA-13/17/20: result axes stay orthogonal and UNKNOWN never authorizes automatic redispatch', () => {
  const c = new AttemptCoordinator(); running(c);
  const unknown = c.transition('a1', 'UNKNOWN', { expected_version: 2, evidence_state: 'PROVISIONAL', authority_effect: 'UNKNOWN' });
  assert.equal(unknown.outcome, 'UNKNOWN');
  assert.equal(unknown.evidence_state, 'PROVISIONAL');
  assert.equal(unknown.authority_effect, 'UNKNOWN');
  assert.equal(unknown.automatic_redispatch_allowed, false);
  assert.equal(c.transition('a1', 'RECONCILING', { expected_version: 3, evidence_state: 'PROVISIONAL', authority_effect: 'UNKNOWN' }).execution_state, 'RECONCILING');
  assert.equal(c.transition('a1', 'FAILED', { expected_version: 4, evidence_state: 'FINAL', authority_effect: 'NONE' }).outcome, 'FAILURE');
});

test('V04 CI-76 EIA-23/26: handoff allocates exactly one successor', () => {
  const c = new AttemptCoordinator(); running(c);
  c.transition('a1', 'HANDOFF_PENDING', { expected_version: 2 });
  const handoff = c.allocateSuccessor('a1', 'a2', 3);
  assert.equal(handoff.successor.predecessor_attempt_id, 'a1');
  assert.equal(handoff.predecessor.successor_attempt_id, 'a2');
  assert.throws(() => c.allocateSuccessor('a1', 'a3', 4), /SUCCESSOR_ALREADY_ALLOCATED/);
});

test('V04 CI-17/35/76 EIA-31/32/37: cancellation preserves terminal outcome and late result is reconciliation-only', () => {
  const c = new AttemptCoordinator(); running(c);
  const cancelled = c.transition('a1', 'CANCELLED', { expected_version: 2, evidence_state: 'FINAL' });
  assert.equal(cancelled.outcome, 'CANCELLED');
  const late = c.recordLateResult('a1', { reported_outcome: 'SUCCESS', evidence_digest: 'sha256:late' });
  assert.equal(late.outcome, 'CANCELLED');
  assert.equal(late.reconciliation[0].applied_to_outcome, false);
});
