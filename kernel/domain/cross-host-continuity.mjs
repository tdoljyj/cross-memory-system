import { createHash } from 'node:crypto';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function invariant(condition, code) {
  if (!condition) fail(code);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function digest(value) {
  return 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
}

function highestCommon(left, right) {
  const common = left.filter((value) => right.includes(value)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!common.length) fail('NEGOTIATION_NO_COMMON_VERSION');
  return common[0];
}

export class InMemoryContinuityLedger {
  constructor() {
    this.hosts = new Map();
    this.contexts = new Map();
    this.handoffClaims = new Map();
    this.bindingGenerations = new Map();
  }

  registerHost(host) {
    invariant(host && host.host_id && host.process_identity, 'HOST_IDENTITY_REQUIRED');
    invariant(host.tenant_id && host.subject_id && host.project_id && host.context_key, 'HOST_CONTEXT_BINDING_REQUIRED');
    invariant(host.binding_id && host.credential_id, 'HOST_BINDING_CREDENTIAL_REQUIRED');
    invariant(Array.isArray(host.protocol_versions) && host.protocol_versions.length, 'HOST_PROTOCOLS_REQUIRED');
    invariant(Array.isArray(host.profile_versions) && host.profile_versions.length, 'HOST_PROFILES_REQUIRED');
    invariant(host.scope && Array.isArray(host.scope.read_fields) && Array.isArray(host.scope.write_fields), 'HOST_SCOPE_REQUIRED');
    for (const existing of this.hosts.values()) {
      invariant(existing.process_identity !== host.process_identity, 'HOST_PROCESS_IDENTITY_REUSED');
      invariant(existing.binding_id !== host.binding_id, 'HOST_BINDING_REUSED');
      invariant(existing.credential_id !== host.credential_id, 'HOST_CREDENTIAL_REUSED');
    }
    const generation = host.binding_generation || 1;
    const saved = structuredClone({ ...host, binding_generation: generation, active: true });
    this.hosts.set(host.host_id, saved);
    this.bindingGenerations.set(host.binding_id, generation);
    return structuredClone(saved);
  }

  requireAuthorizedHost(hostId, contextKey) {
    const host = this.hosts.get(hostId);
    invariant(host && host.active && host.context_key === contextKey, 'CONTEXT_NOT_FOUND_OR_NOT_AUTHORIZED');
    invariant(this.bindingGenerations.get(host.binding_id) === host.binding_generation, 'CONTEXT_NOT_FOUND_OR_NOT_AUTHORIZED');
    return host;
  }

  checkpoint(hostId, input) {
    const host = this.requireAuthorizedHost(hostId, input.context_key);
    const current = this.contexts.get(input.context_key);
    if (current) {
      invariant(current.tenant_id === host.tenant_id && current.subject_id === host.subject_id && current.project_id === host.project_id, 'CONTEXT_NOT_FOUND_OR_NOT_AUTHORIZED');
      invariant(input.expected_generation === current.generation, 'CHECKPOINT_CAS_CONFLICT');
    } else {
      invariant(input.expected_generation === 0, 'CHECKPOINT_CAS_CONFLICT');
    }
    invariant(input.state && typeof input.state.next_action === 'string' && input.state.next_action.length > 0, 'CHECKPOINT_UNIQUE_NEXT_ACTION_REQUIRED');
    const record = Object.freeze({
      context_key: input.context_key,
      tenant_id: host.tenant_id,
      subject_id: host.subject_id,
      project_id: host.project_id,
      generation: (current?.generation || 0) + 1,
      state: structuredClone(input.state),
      blockers: structuredClone(input.blockers || []),
      decision_reason: input.decision_reason || null,
      next_action: input.state.next_action,
      writer_host_id: hostId,
      protocol_versions: structuredClone(host.protocol_versions),
      profile_versions: structuredClone(host.profile_versions),
      digest: digest({
        context_key: input.context_key,
        generation: (current?.generation || 0) + 1,
        state: input.state,
        blockers: input.blockers || [],
        decision_reason: input.decision_reason || null
      })
    });
    this.contexts.set(input.context_key, record);
    return structuredClone(record);
  }

  resume(hostId, contextKey) {
    const host = this.requireAuthorizedHost(hostId, contextKey);
    const record = this.contexts.get(contextKey);
    invariant(record && record.tenant_id === host.tenant_id && record.subject_id === host.subject_id && record.project_id === host.project_id, 'CONTEXT_NOT_FOUND_OR_NOT_AUTHORIZED');
    const protocol_version = highestCommon(record.protocol_versions, host.protocol_versions);
    const profile_version = highestCommon(record.profile_versions, host.profile_versions);
    const projection = {};
    for (const field of host.scope.read_fields) {
      if (Object.hasOwn(record.state, field)) projection[field] = structuredClone(record.state[field]);
      else if (field === 'blockers') projection.blockers = structuredClone(record.blockers);
      else if (field === 'decision_reason') projection.decision_reason = record.decision_reason;
      else if (field === 'next_action') projection.next_action = record.next_action;
    }
    return Object.freeze({
      context_key: contextKey,
      generation: record.generation,
      checkpoint_digest: record.digest,
      protocol_version,
      profile_version,
      projection,
      blockers: host.scope.read_fields.includes('blockers') ? structuredClone(record.blockers) : undefined,
      decision_reason: host.scope.read_fields.includes('decision_reason') ? record.decision_reason : undefined,
      next_action: host.scope.read_fields.includes('next_action') ? record.next_action : undefined,
      unique_next_action_count: 1
    });
  }

  writeProjection(hostId, contextKey, patch, expectedGeneration) {
    const host = this.requireAuthorizedHost(hostId, contextKey);
    const record = this.contexts.get(contextKey);
    invariant(record && record.tenant_id === host.tenant_id && record.subject_id === host.subject_id && record.project_id === host.project_id, 'CONTEXT_NOT_FOUND_OR_NOT_AUTHORIZED');
    invariant(record.generation === expectedGeneration, 'CHECKPOINT_CAS_CONFLICT');
    for (const field of Object.keys(patch)) invariant(host.scope.write_fields.includes(field), 'SCOPE_WRITE_DENIED');
    const nextState = { ...structuredClone(record.state), ...structuredClone(patch) };
    return this.checkpoint(hostId, {
      context_key: contextKey,
      expected_generation: expectedGeneration,
      state: nextState,
      blockers: record.blockers,
      decision_reason: record.decision_reason
    });
  }

  claimHandoff(hostId, handoffId, contextKey, expectedCheckpointDigest) {
    const host = this.requireAuthorizedHost(hostId, contextKey);
    const record = this.contexts.get(contextKey);
    invariant(record && record.digest === expectedCheckpointDigest, 'HANDOFF_CHECKPOINT_MISMATCH');
    const existing = this.handoffClaims.get(handoffId);
    if (existing) {
      return Object.freeze({
        status: 'CONFLICT_RECONCILE',
        winner_host_id: existing.host_id,
        claim_lease_id: existing.claim_lease_id,
        canonical_checkpoint_digest: record.digest
      });
    }
    const claim = Object.freeze({
      handoff_id: handoffId,
      host_id: host.host_id,
      binding_id: host.binding_id,
      context_key: contextKey,
      claim_lease_id: 'claim:' + digest({ handoffId, hostId, checkpoint: record.digest }).slice(7, 31),
      checkpoint_digest: record.digest
    });
    this.handoffClaims.set(handoffId, claim);
    return Object.freeze({ status: 'CLAIMED', ...structuredClone(claim) });
  }

  revokeBinding(bindingId, expectedGeneration) {
    invariant(this.bindingGenerations.get(bindingId) === expectedGeneration, 'BINDING_GENERATION_CONFLICT');
    this.bindingGenerations.set(bindingId, expectedGeneration + 1);
    for (const host of this.hosts.values()) {
      if (host.binding_id === bindingId) host.active = false;
    }
    return { binding_id: bindingId, generation: expectedGeneration + 1, context_revoked: false };
  }
}
