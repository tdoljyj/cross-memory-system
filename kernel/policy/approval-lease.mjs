import crypto from 'node:crypto';

function invariant(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }

const BINDING_KEYS = ['approval_id','subject_id','scope_digest','approval_vector','plan_digest','target_digest','risk_digest','fencing_token','not_before','latest_action_start','expires_at'];
function validateBinding(binding, now) {
  invariant(binding && BINDING_KEYS.every((key) => Object.hasOwn(binding, key)), 'APPROVAL_BINDING_INCOMPLETE');
  invariant(Object.keys(binding).sort().join('|') === [...BINDING_KEYS].sort().join('|'), 'APPROVAL_BINDING_EXTRA_FIELD');
  invariant(binding.approval_vector && Number.isSafeInteger(binding.approval_vector.generation) && Number.isSafeInteger(binding.approval_vector.sequence), 'APPROVAL_VECTOR_INVALID');
  for (const key of ['scope_digest','plan_digest','target_digest','risk_digest','fencing_token']) invariant(typeof binding[key] === 'string' && binding[key].length > 0, 'APPROVAL_DIGEST_OR_FENCE_INVALID');
  invariant(Number.isSafeInteger(binding.not_before) && Number.isSafeInteger(binding.latest_action_start) && Number.isSafeInteger(binding.expires_at), 'APPROVAL_TIME_INVALID');
  invariant(binding.not_before < binding.latest_action_start && binding.latest_action_start <= binding.expires_at, 'APPROVAL_WINDOW_INVALID');
  invariant(now < binding.latest_action_start, 'APPROVAL_LATEST_ACTION_START_REACHED');
}

export class ApprovalLeaseSaga {
  #reservations = new Map();
  #leases = new Map();
  #approvalUses = new Map();

  reserve(binding, now) {
    validateBinding(binding, now);
    invariant(!this.#reservations.has(binding.approval_id), 'APPROVAL_ALREADY_RESERVED');
    const bindingDigest = digest(binding);
    const reservation = {
      reservation_id: `reservation:${binding.approval_id}`,
      transaction: 1,
      status: 'RESERVED',
      binding: clone(binding),
      binding_digest: bindingDigest,
      signing_statement_digest: digest({ kind: 'APPROVAL_LEASE_ISSUE', binding_digest: bindingDigest })
    };
    this.#reservations.set(binding.approval_id, reservation);
    return clone(reservation);
  }

  externalSignStub(approvalId) {
    const reservation = this.#reservations.get(approvalId);
    invariant(reservation && reservation.status === 'RESERVED', 'RESERVATION_NOT_SIGNABLE');
    return { algorithm: 'EXTERNAL_SIGN_STUB', statement_digest: reservation.signing_statement_digest, signature_stub: `stub:${reservation.signing_statement_digest}` };
  }

  issue(approvalId, signature, now) {
    const reservation = this.#reservations.get(approvalId);
    invariant(reservation && reservation.status === 'RESERVED', 'RESERVATION_NOT_ISSUABLE');
    validateBinding(reservation.binding, now);
    invariant(signature?.algorithm === 'EXTERNAL_SIGN_STUB' && signature.statement_digest === reservation.signing_statement_digest && signature.signature_stub === `stub:${reservation.signing_statement_digest}`, 'EXTERNAL_SIGNATURE_STUB_INVALID');
    const lease = { lease_id: `lease:${approvalId}`, transaction: 2, status: 'ISSUED', binding: clone(reservation.binding), binding_digest: reservation.binding_digest, signature: clone(signature), consumed_by: null };
    reservation.status = 'ISSUED';
    this.#reservations.set(approvalId, reservation);
    this.#leases.set(lease.lease_id, lease);
    return clone(lease);
  }

  consume({ lease_id: leaseId, use_id: useId, binding, fencing_token: fencingToken, now }) {
    const lease = this.#leases.get(leaseId);
    invariant(lease && lease.status === 'ISSUED', 'LEASE_NOT_ISSUED');
    validateBinding(binding, now);
    invariant(now >= binding.not_before && now < binding.expires_at, 'LEASE_NOT_CURRENT');
    invariant(digest(binding) === lease.binding_digest, 'LEASE_BINDING_MISMATCH');
    invariant(fencingToken === lease.binding.fencing_token, 'LEASE_FENCING_MISMATCH');
    if (lease.consumed_by !== null) {
      invariant(lease.consumed_by === useId, 'APPROVAL_USE_ALREADY_CONSUMED');
      return clone({ approval_id: binding.approval_id, lease_id: leaseId, use_id: useId, consumed: true, idempotent_replay: true });
    }
    invariant(!this.#approvalUses.has(binding.approval_id), 'APPROVAL_USE_ALREADY_CONSUMED');
    lease.consumed_by = useId;
    this.#leases.set(leaseId, lease);
    const receipt = { approval_id: binding.approval_id, lease_id: leaseId, use_id: useId, consumed: true, idempotent_replay: false, binding_digest: lease.binding_digest };
    this.#approvalUses.set(binding.approval_id, receipt);
    return clone(receipt);
  }
}
