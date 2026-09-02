import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

function invariant(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function digest(value) {
  return 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
}

const VECTOR_COMPONENTS = ['account_epoch', 'integration_installation_epoch', 'context_epoch', 'binding_epoch'];
const GENERATIONS = ['external_executor_identity_generation', 'connector_credential_generation', 'approval_use_generation', 'tenant_erasure_generation', 'signing_key_generation'];

function validateVector(vector) {
  invariant(vector && Object.keys(vector).sort().join('|') === [...VECTOR_COMPONENTS].sort().join('|'), 'EXT_VECTOR_EXACT_FOUR_COMPONENTS_REQUIRED');
  for (const name of VECTOR_COMPONENTS) {
    const component = vector[name];
    invariant(component && component.scope_id && component.scope_digest, 'EXT_VECTOR_SCOPE_REQUIRED');
    invariant(Number.isInteger(component.epoch) || component.not_applicable === true, 'EXT_VECTOR_EPOCH_OR_NA_REQUIRED');
  }
}

function compareState(capability, current) {
  invariant(canonical(capability.revocation_epoch_vector) === canonical(current.revocation_epoch_vector), 'EXT_STALE_REVOCATION_VECTOR');
  for (const field of GENERATIONS) invariant(capability[field] === current[field], 'EXT_STALE_' + field.toUpperCase());
  invariant(capability.policy_version === current.policy_version && capability.policy_digest === current.policy_digest, 'EXT_POLICY_MISMATCH');
  invariant(capability.evidence_policy_version === current.evidence_policy_version && capability.evidence_policy_digest === current.evidence_policy_digest, 'EXT_EVIDENCE_POLICY_MISMATCH');
  invariant(capability.lease_id === current.lease_id && capability.fencing_token === current.fencing_token, 'EXT_LEASE_FENCING_MISMATCH');
}

export class ExternalInvocationLedger {
  constructor({ aliasKey = null } = {}) {
    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.aliasKey = aliasKey || randomBytes(32);
    this.uses = new Map();
    this.outbox = [];
    this.inbox = [];
    this.finalized = new Map();
  }

  pairwiseAlias(input) {
    invariant(input.tenant_id && input.subject_id && input.audience && input.connector_id && Number.isInteger(input.alias_generation), 'EXT_ALIAS_INPUT_REQUIRED');
    return 'psa_' + createHmac('sha256', this.aliasKey)
      .update([input.tenant_id, input.subject_id, input.audience, input.connector_id, input.alias_generation].join('|'))
      .digest('hex');
  }

  issueCapability(input) {
    for (const field of ['tenant_id', 'subject_id', 'context_key', 'audience', 'connector_id', 'executor_identity_id', 'run_id', 'attempt_id', 'plan_digest', 'segment_digest', 'scope_digest', 'purpose_digest', 'target_digest', 'lease_id', 'fencing_token', 'policy_version', 'policy_digest', 'evidence_policy_version', 'evidence_policy_digest']) {
      invariant(input[field], 'EXT_' + field.toUpperCase() + '_REQUIRED');
    }
    validateVector(input.revocation_epoch_vector);
    for (const field of GENERATIONS) invariant(Number.isInteger(input[field]) && input[field] >= 0, 'EXT_' + field.toUpperCase() + '_REQUIRED');
    invariant(Number.isInteger(input.max_uses) && input.max_uses > 0, 'EXT_MAX_USES_INVALID');
    invariant(Number.isFinite(input.issued_at_ms) && Number.isFinite(input.expires_at_ms) && input.expires_at_ms > input.issued_at_ms, 'EXT_EXPIRY_INVALID');
    const pairwise_subject_alias = this.pairwiseAlias({
      tenant_id: input.tenant_id,
      subject_id: input.subject_id,
      audience: input.audience,
      connector_id: input.connector_id,
      alias_generation: input.alias_generation
    });
    const payload = Object.freeze({
      schema_version: 'clued.external-invocation-capability/1',
      jti: input.jti || randomBytes(16).toString('hex'),
      tenant_id: input.tenant_id,
      pairwise_subject_alias,
      context_key: input.context_key,
      audience: input.audience,
      connector_id: input.connector_id,
      executor_identity_id: input.executor_identity_id,
      run_id: input.run_id,
      attempt_id: input.attempt_id,
      plan_digest: input.plan_digest,
      segment_digest: input.segment_digest,
      scope_digest: input.scope_digest,
      purpose_digest: input.purpose_digest,
      target_digest: input.target_digest,
      lease_id: input.lease_id,
      fencing_token: input.fencing_token,
      max_uses: input.max_uses,
      issued_at_ms: input.issued_at_ms,
      expires_at_ms: input.expires_at_ms,
      revocation_epoch_vector: structuredClone(input.revocation_epoch_vector),
      external_executor_identity_generation: input.external_executor_identity_generation,
      connector_credential_generation: input.connector_credential_generation,
      approval_use_generation: input.approval_use_generation,
      tenant_erasure_generation: input.tenant_erasure_generation,
      signing_key_generation: input.signing_key_generation,
      policy_version: input.policy_version,
      policy_digest: input.policy_digest,
      evidence_policy_version: input.evidence_policy_version,
      evidence_policy_digest: input.evidence_policy_digest
    });
    invariant(!Object.hasOwn(payload, 'subject_id'), 'EXT_RAW_SUBJECT_MUST_NOT_LEAVE_KERNEL');
    return Object.freeze({
      payload,
      payload_hash: digest(payload),
      signature: sign(null, Buffer.from(canonical(payload)), this.privateKey).toString('base64')
    });
  }

  consume({ actor_role, signed_capability, use_index, request_fingerprint, expected_audience, now_ms, current_state }) {
    invariant(actor_role === 'kernel', 'EXT_USE_KERNEL_ONLY');
    const capability = signed_capability.payload;
    invariant(verify(null, Buffer.from(canonical(capability)), this.publicKey, Buffer.from(signed_capability.signature, 'base64')), 'EXT_CAPABILITY_SIGNATURE_INVALID');
    invariant(signed_capability.payload_hash === digest(capability), 'EXT_CAPABILITY_HASH_INVALID');
    invariant(capability.audience === expected_audience, 'EXT_AUDIENCE_MISMATCH');
    invariant(now_ms >= capability.issued_at_ms && now_ms < capability.expires_at_ms, 'EXT_CAPABILITY_EXPIRED_OR_NOT_YET_VALID');
    invariant(Number.isInteger(use_index) && use_index >= 0 && use_index < capability.max_uses, 'EXT_MAX_USES_EXCEEDED');
    compareState(capability, current_state);
    const key = capability.jti + ':' + use_index;
    const existing = this.uses.get(key);
    if (existing) {
      invariant(existing.request_fingerprint === request_fingerprint, 'EXT_USE_FINGERPRINT_CONFLICT');
      return Object.freeze({ status: 'IDEMPOTENT_REPLAY', invocation: structuredClone(existing) });
    }
    const invocation = Object.freeze({
      external_invocation_use_id: 'eiu_' + digest({ key, request_fingerprint }).slice(7, 31),
      external_invocation_id: 'einv_' + digest({ key, request_fingerprint, audience: capability.audience }).slice(7, 31),
      jti: capability.jti,
      use_index,
      request_fingerprint,
      invocation_nonce: randomBytes(16).toString('hex'),
      correlation_id: randomBytes(16).toString('hex'),
      audience: capability.audience,
      tenant_id: capability.tenant_id,
      capability_payload_hash: signed_capability.payload_hash,
      dispatch_state: 'OUTBOX_READY',
      canonical_result: false
    });
    this.uses.set(key, invocation);
    this.outbox.push(invocation);
    return Object.freeze({ status: 'CONSUMED_AND_OUTBOX_COMMITTED', invocation: structuredClone(invocation) });
  }

  receiveCallback(input) {
    const invocation = [...this.uses.values()].find((item) => item.external_invocation_id === input.external_invocation_id);
    invariant(invocation, 'EXT_CALLBACK_INVOCATION_UNKNOWN');
    invariant(input.source_identity_verified === true, 'EXT_CALLBACK_SOURCE_UNVERIFIED');
    invariant(input.invocation_nonce === invocation.invocation_nonce && input.correlation_id === invocation.correlation_id, 'EXT_CALLBACK_CORRELATION_MISMATCH');
    const inbox = Object.freeze({
      external_invocation_id: invocation.external_invocation_id,
      external_invocation_use_id: invocation.external_invocation_use_id,
      correlation_id: invocation.correlation_id,
      declared_result_digest: digest(input.declared_result),
      receive_sequence: this.inbox.length + 1,
      source_identity_verified: true,
      trust: 'UNTRUSTED_DECLARATION',
      canonical_result: false
    });
    this.inbox.push(inbox);
    return inbox;
  }

  finalize({ actor_role, external_invocation_id, operation_commit_receipt_id }) {
    invariant(actor_role === 'kernel', 'EXT_FINALIZE_KERNEL_ONLY');
    invariant(operation_commit_receipt_id, 'EXT_OPERATION_COMMIT_RECEIPT_REQUIRED');
    const inbox = this.inbox.find((item) => item.external_invocation_id === external_invocation_id);
    invariant(inbox, 'EXT_CALLBACK_REQUIRED');
    invariant(!this.finalized.has(external_invocation_id), 'EXT_FINALIZE_ALREADY_EXISTS');
    const result = Object.freeze({
      external_invocation_id,
      canonical_result: true,
      operation_commit_receipt_id,
      causal_inbox_sequence: inbox.receive_sequence
    });
    this.finalized.set(external_invocation_id, result);
    return result;
  }
}
