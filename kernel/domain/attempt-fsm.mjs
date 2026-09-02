function invariant(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

const EDGES = new Map([
  ['CREATED', new Set(['DISPATCHED','CANCELLED'])],
  ['DISPATCHED', new Set(['RUNNING','CANCELLED','UNKNOWN'])],
  ['RUNNING', new Set(['WAITING','HANDOFF_PENDING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN'])],
  ['WAITING', new Set(['RUNNING','HANDOFF_PENDING','CANCELLED','UNKNOWN'])],
  ['HANDOFF_PENDING', new Set(['HANDED_OFF','CANCELLED','UNKNOWN'])],
  ['UNKNOWN', new Set(['RECONCILING'])],
  ['RECONCILING', new Set(['SUCCEEDED','FAILED','CANCELLED'])]
]);
const TERMINAL = new Set(['SUCCEEDED','FAILED','CANCELLED','HANDED_OFF']);

function baseAttempt(id, predecessorId = null) {
  return {
    attempt_id: id, predecessor_attempt_id: predecessorId, successor_attempt_id: null,
    version: 0, execution_state: 'CREATED', outcome: 'NONE', evidence_state: 'NONE', authority_effect: 'NONE',
    automatic_redispatch_allowed: false, reconciliation: []
  };
}

function validateAxes(attempt) {
  const expectedOutcome = { SUCCEEDED: 'SUCCESS', FAILED: 'FAILURE', CANCELLED: 'CANCELLED', UNKNOWN: 'UNKNOWN' }[attempt.execution_state];
  if (expectedOutcome) invariant(attempt.outcome === expectedOutcome, 'RESULT_AXIS_MISMATCH');
  if (!expectedOutcome && !TERMINAL.has(attempt.execution_state)) invariant(['NONE','UNKNOWN'].includes(attempt.outcome), 'NONTERMINAL_OUTCOME_INVALID');
  invariant(['NONE','PROVISIONAL','FINAL'].includes(attempt.evidence_state), 'EVIDENCE_AXIS_INVALID');
  invariant(['NONE','CONFIRMED','UNKNOWN'].includes(attempt.authority_effect), 'AUTHORITY_EFFECT_AXIS_INVALID');
  if (attempt.execution_state === 'UNKNOWN') invariant(attempt.automatic_redispatch_allowed === false, 'UNKNOWN_AUTOMATIC_REDISPATCH_FORBIDDEN');
}

export class AttemptCoordinator {
  #attempts = new Map();

  create(attemptId, predecessorId = null) {
    invariant(typeof attemptId === 'string' && !this.#attempts.has(attemptId), 'ATTEMPT_ID_DUPLICATE');
    const attempt = baseAttempt(attemptId, predecessorId);
    this.#attempts.set(attemptId, attempt);
    return clone(attempt);
  }

  transition(attemptId, nextState, { expected_version: expectedVersion, evidence_state: evidenceState = 'NONE', authority_effect: authorityEffect = 'NONE' }) {
    const current = this.#attempts.get(attemptId);
    invariant(current, 'ATTEMPT_NOT_FOUND');
    invariant(current.version === expectedVersion, 'ATTEMPT_CAS_CONFLICT');
    invariant(EDGES.get(current.execution_state)?.has(nextState), 'ATTEMPT_EDGE_ILLEGAL');
    const next = clone(current);
    next.version += 1;
    next.execution_state = nextState;
    next.evidence_state = evidenceState;
    next.authority_effect = authorityEffect;
    next.outcome = { SUCCEEDED: 'SUCCESS', FAILED: 'FAILURE', CANCELLED: 'CANCELLED', UNKNOWN: 'UNKNOWN' }[nextState] ?? (nextState === 'RECONCILING' ? 'UNKNOWN' : 'NONE');
    next.automatic_redispatch_allowed = false;
    validateAxes(next);
    this.#attempts.set(attemptId, next);
    return clone(next);
  }

  allocateSuccessor(predecessorId, successorId, expectedVersion) {
    const predecessor = this.#attempts.get(predecessorId);
    invariant(predecessor && predecessor.execution_state === 'HANDOFF_PENDING', 'HANDOFF_NOT_PENDING');
    invariant(predecessor.version === expectedVersion, 'ATTEMPT_CAS_CONFLICT');
    invariant(predecessor.successor_attempt_id === null, 'SUCCESSOR_ALREADY_ALLOCATED');
    invariant(!this.#attempts.has(successorId), 'ATTEMPT_ID_DUPLICATE');
    const successor = baseAttempt(successorId, predecessorId);
    const updated = clone(predecessor);
    updated.successor_attempt_id = successorId;
    updated.version += 1;
    this.#attempts.set(successorId, successor);
    this.#attempts.set(predecessorId, updated);
    return { predecessor: clone(updated), successor: clone(successor) };
  }

  recordLateResult(attemptId, result) {
    const current = this.#attempts.get(attemptId);
    invariant(current && ['CANCELLED','UNKNOWN'].includes(current.execution_state), 'LATE_RESULT_NOT_RECONCILABLE');
    const next = clone(current);
    next.reconciliation.push({ kind: 'LATE_RESULT', result: clone(result), applied_to_outcome: false });
    next.version += 1;
    this.#attempts.set(attemptId, next);
    return clone(next);
  }

  get(attemptId) {
    const value = this.#attempts.get(attemptId);
    invariant(value, 'ATTEMPT_NOT_FOUND');
    return clone(value);
  }
}
