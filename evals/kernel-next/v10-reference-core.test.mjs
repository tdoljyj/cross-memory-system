import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryContinuityLedger } from '../../kernel/domain/cross-host-continuity.mjs';
import { createInMemoryTestHostIdentity, SignedCrossHostChannel } from '../../kernel/runtime/cross-host-channel.mjs';
import { ExternalInvocationLedger } from '../../kernel/runtime/external-invocation-ledger.mjs';
import { assertTenantBoundary, enforceExternalCopyErasureBarrier, enforceUntrustedContentBoundary, evaluatePackExecutorApplicability, validatePackIsolationManifest } from '../../kernel/policy/cross-host-policy.mjs';

const D = (character) => 'sha256:' + character.repeat(64);

function host(id, overrides = {}) {
  return {
    host_id: id,
    process_identity: 'process-' + id,
    tenant_id: 'tenant-1',
    subject_id: 'subject-1',
    project_id: 'project-1',
    context_key: 'context-1',
    binding_id: 'binding-' + id,
    credential_id: 'credential-' + id,
    binding_generation: 1,
    protocol_versions: ['1.0', '1.1'],
    profile_versions: ['core-1.0', 'core-1.1'],
    scope: { read_fields: ['status', 'blockers', 'decision_reason', 'next_action'], write_fields: ['status', 'next_action'] },
    ...overrides
  };
}

function ledgerFixture(bOverrides = {}) {
  const ledger = new InMemoryContinuityLedger();
  ledger.registerHost(host('a'));
  ledger.registerHost(host('b', bOverrides));
  const checkpoint = ledger.checkpoint('a', {
    context_key: 'context-1',
    expected_generation: 0,
    state: { status: 'blocked', next_action: 'resolve-contract-pin', private_notes: 'not-in-b-scope' },
    blockers: ['missing-pin'],
    decision_reason: 'exact binding required'
  });
  return { ledger, checkpoint };
}

test('XAG-01 independent Host B resumes state blockers reason and unique next action', () => {
  const { ledger } = ledgerFixture({ protocol_versions: ['1.0'], profile_versions: ['core-1.0'] });
  const resumed = ledger.resume('b', 'context-1');
  assert.equal(resumed.projection.status, 'blocked');
  assert.equal(resumed.blockers[0], 'missing-pin');
  assert.equal(resumed.decision_reason, 'exact binding required');
  assert.equal(resumed.next_action, 'resolve-contract-pin');
  assert.equal(resumed.unique_next_action_count, 1);
});

test('XAG-02 narrower Host B sees projection only and cannot write outside scope', () => {
  const { ledger } = ledgerFixture();
  const resumed = ledger.resume('b', 'context-1');
  assert.equal(Object.hasOwn(resumed.projection, 'private_notes'), false);
  assert.throws(() => ledger.writeProjection('b', 'context-1', { private_notes: 'forbidden' }, 1), /SCOPE_WRITE_DENIED/);
  const updated = ledger.writeProjection('b', 'context-1', { status: 'ready', next_action: 'continue' }, 1);
  assert.equal(updated.generation, 2);
});

test('XAG-03 concurrent handoff claims have one winner and loser reconciles', () => {
  const { ledger, checkpoint } = ledgerFixture();
  const first = ledger.claimHandoff('b', 'handoff-1', 'context-1', checkpoint.digest);
  const second = ledger.claimHandoff('a', 'handoff-1', 'context-1', checkpoint.digest);
  assert.equal(first.status, 'CLAIMED');
  assert.equal(second.status, 'CONFLICT_RECONCILE');
  assert.equal(second.claim_lease_id, first.claim_lease_id);
});

test('XAG-04 revoking A binding leaves B and context active', () => {
  const { ledger } = ledgerFixture();
  const revoked = ledger.revokeBinding('binding-a', 1);
  assert.equal(revoked.context_revoked, false);
  assert.throws(() => ledger.resume('a', 'context-1'), /CONTEXT_NOT_FOUND_OR_NOT_AUTHORIZED/);
  assert.equal(ledger.resume('b', 'context-1').next_action, 'resolve-contract-pin');
});

test('XAG-05 selects common protocol/profile and fails closed without common version', () => {
  const common = ledgerFixture({ protocol_versions: ['1.0'], profile_versions: ['core-1.0'] }).ledger.resume('b', 'context-1');
  assert.equal(common.protocol_version, '1.0');
  assert.equal(common.profile_version, 'core-1.0');
  const noCommon = ledgerFixture({ protocol_versions: ['2.0'], profile_versions: ['core-2.0'] }).ledger;
  assert.throws(() => noCommon.resume('b', 'context-1'), /NEGOTIATION_NO_COMMON_VERSION/);
});

test('two local process-host identities use distinct Binding Credential and Ed25519 key without shared secret', () => {
  const a = createInMemoryTestHostIdentity({ host_id: 'a', process_identity: 'pid-a', binding_id: 'binding-a', credential_id: 'cred-a', tenant_id: 'tenant-1', audience: 'host-b' });
  const b = createInMemoryTestHostIdentity({ host_id: 'b', process_identity: 'pid-b', binding_id: 'binding-b', credential_id: 'cred-b', tenant_id: 'tenant-1', audience: 'host-a' });
  const channel = new SignedCrossHostChannel([a, b]);
  const evidence = channel.separationEvidence();
  assert.equal(evidence.distinct_process_identities, true);
  assert.equal(evidence.distinct_bindings, true);
  assert.equal(evidence.distinct_credentials, true);
  assert.equal(evidence.distinct_public_keys, true);
  assert.equal(evidence.shared_secret_count, 0);
  const signed = channel.signEnvelope('a', { destination_host_id: 'b', audience: 'host-b', sequence: 1, nonce: 'nonce-1', payload: { checkpoint: D('1') } });
  assert.equal(channel.verifyEnvelope(signed, { destination_host_id: 'b', audience: 'host-b', tenant_id: 'tenant-1' }).status, 'VERIFIED');
});

test('signed cross-host channel rejects replay audience and tenant confusion', () => {
  const a = createInMemoryTestHostIdentity({ host_id: 'a', process_identity: 'pid-a', binding_id: 'binding-a', credential_id: 'cred-a', tenant_id: 'tenant-1', audience: 'host-b' });
  const b = createInMemoryTestHostIdentity({ host_id: 'b', process_identity: 'pid-b', binding_id: 'binding-b', credential_id: 'cred-b', tenant_id: 'tenant-1', audience: 'host-a' });
  const channel = new SignedCrossHostChannel([a, b]);
  const signed = channel.signEnvelope('a', { destination_host_id: 'b', audience: 'host-b', sequence: 1, nonce: 'nonce-replay', payload: { ok: true } });
  assert.throws(() => channel.verifyEnvelope(signed, { destination_host_id: 'b', audience: 'wrong', tenant_id: 'tenant-1' }), /CHANNEL_AUDIENCE_MISMATCH/);
  assert.equal(channel.verifyEnvelope(signed, { destination_host_id: 'b', audience: 'host-b', tenant_id: 'tenant-1' }).status, 'VERIFIED');
  assert.throws(() => channel.verifyEnvelope(signed, { destination_host_id: 'b', audience: 'host-b', tenant_id: 'tenant-1' }), /CHANNEL_REPLAY_NONCE/);
});

test('CI-54 untrusted content cannot mutate Plan Scope Target Gate or tool permissions', () => {
  const base = { plan_digest: D('1'), scope_digest: D('2'), target_digest: D('3'), gate_digest: D('4'), tool_permissions_digest: D('5'), suggestion: 'old' };
  const safe = enforceUntrustedContentBoundary(base, { ...base, suggestion: 'new' }, 'untrusted');
  assert.equal(safe.control_fields_unchanged, true);
  assert.throws(() => enforceUntrustedContentBoundary(base, { ...base, target_digest: D('6') }, 'untrusted'), /UNTRUSTED_CONTROL_MUTATION_TARGET_DIGEST/);
});

test('CI-60 erased external copy cannot silently become current', () => {
  const copy = { tenant_id: 'tenant-1', subject_id: 'subject-1', source: 'external_copy', erasure_generation: 4 };
  const barrier = { tenant_id: 'tenant-1', subject_id: 'subject-1', erasure_generation: 4 };
  assert.throws(() => enforceExternalCopyErasureBarrier(copy, barrier), /ERASED_EXTERNAL_COPY_CANNOT_BECOME_CURRENT/);
  assert.equal(enforceExternalCopyErasureBarrier({ ...copy, erasure_generation: 5 }, barrier).requires_formal_import, true);
});

test('CI-38 Pack isolation manifest denies Core secrets and undeclared permissions', () => {
  const valid = {
    schema_version: 'clued.pack-isolation-manifest/1',
    artifact_digest: D('a'),
    process_boundary: 'independent',
    profile_isolated_from_core: true,
    core_secret_access: false,
    canonical_credential_access: false,
    file_permissions: [],
    network_permissions: [],
    undeclared_permission_behavior: 'FAIL_CLOSED'
  };
  assert.equal(validatePackIsolationManifest(valid).valid, true);
  assert.throws(() => validatePackIsolationManifest({ ...valid, core_secret_access: true }), /PACK_CORE_SECRET_ACCESS_FORBIDDEN/);
});

test('optional Pack and External Executor may be N/A only with all machine proofs', () => {
  const proof = {
    release_profile: { pack: 'omitted', external_executor: 'omitted' },
    release_bom: { pack_artifacts: [], executor_artifacts: [] },
    runtime_scan: { pack_entrypoints: [], executor_entrypoints: [] },
    negative_invocation: { status: 'CAPABILITY_ABSENT_FAIL_CLOSED', external_effects: 0 }
  };
  assert.equal(evaluatePackExecutorApplicability(proof).disposition, 'N/A_WITH_PROOF');
  assert.equal(evaluatePackExecutorApplicability({ ...proof, runtime_scan: { pack_entrypoints: ['pack.run'], executor_entrypoints: [] } }).disposition, 'REQUIRED');
});

function invocationFixture() {
  const ledger = new ExternalInvocationLedger({ aliasKey: Buffer.alloc(32, 7) });
  const vector = {
    account_epoch: { scope_id: 'account-1', scope_digest: D('1'), epoch: 1 },
    integration_installation_epoch: { scope_id: 'install-1', scope_digest: D('2'), epoch: 1 },
    context_epoch: { scope_id: 'context-1', scope_digest: D('3'), epoch: 1 },
    binding_epoch: { scope_id: 'binding-1', scope_digest: D('4'), epoch: 1 }
  };
  const input = {
    jti: 'jti-1',
    tenant_id: 'tenant-1',
    subject_id: 'subject-1',
    context_key: 'context-1',
    audience: 'executor-a',
    connector_id: 'connector-a',
    executor_identity_id: 'executor-a-id',
    run_id: 'run-1',
    attempt_id: 'attempt-1',
    plan_digest: D('5'),
    segment_digest: D('6'),
    scope_digest: D('7'),
    purpose_digest: D('8'),
    target_digest: D('9'),
    lease_id: 'lease-1',
    fencing_token: 'fence-1',
    max_uses: 1,
    issued_at_ms: 1000,
    expires_at_ms: 2000,
    alias_generation: 1,
    revocation_epoch_vector: vector,
    external_executor_identity_generation: 1,
    connector_credential_generation: 1,
    approval_use_generation: 1,
    tenant_erasure_generation: 1,
    signing_key_generation: 1,
    policy_version: '1',
    policy_digest: D('a'),
    evidence_policy_version: '1',
    evidence_policy_digest: D('b')
  };
  const signed = ledger.issueCapability(input);
  const current = Object.fromEntries([
    'revocation_epoch_vector',
    'external_executor_identity_generation',
    'connector_credential_generation',
    'approval_use_generation',
    'tenant_erasure_generation',
    'signing_key_generation',
    'policy_version',
    'policy_digest',
    'evidence_policy_version',
    'evidence_policy_digest',
    'lease_id',
    'fencing_token'
  ].map((field) => [field, signed.payload[field]]));
  return { ledger, signed, current };
}

test('CI-86 only Kernel atomically consumes unique use before dispatch with nonce', () => {
  const { ledger, signed, current } = invocationFixture();
  assert.equal(Object.hasOwn(signed.payload, 'subject_id'), false);
  assert.throws(() => ledger.consume({ actor_role: 'external_executor', signed_capability: signed, use_index: 0, request_fingerprint: D('c'), expected_audience: 'executor-a', now_ms: 1500, current_state: current }), /EXT_USE_KERNEL_ONLY/);
  const first = ledger.consume({ actor_role: 'kernel', signed_capability: signed, use_index: 0, request_fingerprint: D('c'), expected_audience: 'executor-a', now_ms: 1500, current_state: current });
  assert.equal(first.status, 'CONSUMED_AND_OUTBOX_COMMITTED');
  assert.equal(first.invocation.dispatch_state, 'OUTBOX_READY');
  assert.ok(first.invocation.invocation_nonce);
  assert.equal(ledger.outbox.length, 1);
  const replay = ledger.consume({ actor_role: 'kernel', signed_capability: signed, use_index: 0, request_fingerprint: D('c'), expected_audience: 'executor-a', now_ms: 1500, current_state: current });
  assert.equal(replay.status, 'IDEMPOTENT_REPLAY');
  assert.equal(ledger.outbox.length, 1);
  assert.throws(() => ledger.consume({ actor_role: 'kernel', signed_capability: signed, use_index: 0, request_fingerprint: D('d'), expected_audience: 'executor-a', now_ms: 1500, current_state: current }), /EXT_USE_FINGERPRINT_CONFLICT/);
});

test('external callback remains untrusted until Kernel OperationCommit finalization', () => {
  const { ledger, signed, current } = invocationFixture();
  const consumed = ledger.consume({ actor_role: 'kernel', signed_capability: signed, use_index: 0, request_fingerprint: D('c'), expected_audience: 'executor-a', now_ms: 1500, current_state: current });
  const callback = ledger.receiveCallback({
    external_invocation_id: consumed.invocation.external_invocation_id,
    invocation_nonce: consumed.invocation.invocation_nonce,
    correlation_id: consumed.invocation.correlation_id,
    source_identity_verified: true,
    declared_result: { status: 'success' }
  });
  assert.equal(callback.canonical_result, false);
  assert.throws(() => ledger.finalize({ actor_role: 'external_executor', external_invocation_id: consumed.invocation.external_invocation_id, operation_commit_receipt_id: 'receipt-1' }), /EXT_FINALIZE_KERNEL_ONLY/);
  assert.equal(ledger.finalize({ actor_role: 'kernel', external_invocation_id: consumed.invocation.external_invocation_id, operation_commit_receipt_id: 'receipt-1' }).canonical_result, true);
});

test('CI-102 tenant subject project and binding isolation is opaque and exact', () => {
  const exact = { tenant_id: 't1', subject_id: 's1', project_id: 'p1', binding_id: 'b1' };
  assert.equal(assertTenantBoundary(exact, exact).authorized, true);
  for (const field of ['tenant_id', 'subject_id', 'project_id', 'binding_id']) {
    assert.throws(() => assertTenantBoundary(exact, { ...exact, [field]: 'other' }), /OBJECT_NOT_FOUND_OR_NOT_AUTHORIZED/);
  }
});


test('pairwise subject alias is audience and connector specific without raw Subject', () => {
  const ledger = new ExternalInvocationLedger({ aliasKey: Buffer.alloc(32, 9) });
  const base = { tenant_id: 'tenant-1', subject_id: 'subject-1', alias_generation: 1 };
  const one = ledger.pairwiseAlias({ ...base, audience: 'executor-a', connector_id: 'connector-a' });
  const two = ledger.pairwiseAlias({ ...base, audience: 'executor-b', connector_id: 'connector-a' });
  const three = ledger.pairwiseAlias({ ...base, audience: 'executor-a', connector_id: 'connector-b' });
  assert.notEqual(one, two);
  assert.notEqual(one, three);
  assert.equal(one.includes('subject-1'), false);
});
