function invariant(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

const IMMUTABLE_CONTROL_FIELDS = ['plan_digest', 'scope_digest', 'target_digest', 'gate_digest', 'tool_permissions_digest'];

export function enforceUntrustedContentBoundary(base, proposed, sourceTrust) {
  invariant(sourceTrust === 'untrusted', 'CONTENT_SOURCE_CLASSIFICATION_REQUIRED');
  for (const field of IMMUTABLE_CONTROL_FIELDS) {
    invariant(base[field] === proposed[field], 'UNTRUSTED_CONTROL_MUTATION_' + field.toUpperCase());
  }
  return Object.freeze({
    accepted_candidate_fields: Object.fromEntries(Object.entries(proposed).filter(([key]) => !IMMUTABLE_CONTROL_FIELDS.includes(key))),
    control_fields_unchanged: true,
    canonical_write: false
  });
}

export function enforceExternalCopyErasureBarrier(copy, barrier) {
  invariant(copy.tenant_id === barrier.tenant_id && copy.subject_id === barrier.subject_id, 'ERASURE_BARRIER_SCOPE_MISMATCH');
  if (copy.source === 'external_copy' && copy.erasure_generation <= barrier.erasure_generation) {
    const error = new Error('ERASED_EXTERNAL_COPY_CANNOT_BECOME_CURRENT');
    error.code = 'ERASED_EXTERNAL_COPY_CANNOT_BECOME_CURRENT';
    error.import_required = true;
    throw error;
  }
  return { allowed: true, requires_formal_import: copy.source === 'external_copy' };
}

export function assertTenantBoundary(request, resource) {
  const exact = ['tenant_id', 'subject_id', 'project_id', 'binding_id'].every((field) => request[field] === resource[field]);
  invariant(exact, 'OBJECT_NOT_FOUND_OR_NOT_AUTHORIZED');
  return { authorized: true };
}

export function validatePackIsolationManifest(manifest) {
  invariant(manifest && manifest.schema_version === 'clued.pack-isolation-manifest/1', 'PACK_MANIFEST_SCHEMA');
  invariant(/^sha256:[0-9a-f]{64}$/.test(manifest.artifact_digest || ''), 'PACK_ARTIFACT_DIGEST_REQUIRED');
  invariant(manifest.process_boundary === 'independent', 'PACK_PROCESS_BOUNDARY_REQUIRED');
  invariant(manifest.profile_isolated_from_core === true, 'PACK_PROFILE_ISOLATION_REQUIRED');
  invariant(manifest.core_secret_access === false && manifest.canonical_credential_access === false, 'PACK_CORE_SECRET_ACCESS_FORBIDDEN');
  invariant(Array.isArray(manifest.file_permissions) && Array.isArray(manifest.network_permissions), 'PACK_PERMISSIONS_MUST_BE_DECLARED');
  invariant(manifest.undeclared_permission_behavior === 'FAIL_CLOSED', 'PACK_UNDECLARED_PERMISSION_NOT_CLOSED');
  return { valid: true, test_id: 'CI-38' };
}

export function evaluatePackExecutorApplicability(input) {
  const omittedByProfile = input.release_profile.pack === 'omitted' && input.release_profile.external_executor === 'omitted';
  const omittedByBom = input.release_bom.pack_artifacts.length === 0 && input.release_bom.executor_artifacts.length === 0;
  const noRuntime = input.runtime_scan.pack_entrypoints.length === 0 && input.runtime_scan.executor_entrypoints.length === 0;
  const negative = input.negative_invocation.status === 'CAPABILITY_ABSENT_FAIL_CLOSED' && input.negative_invocation.external_effects === 0;
  if (omittedByProfile && omittedByBom && noRuntime && negative) {
    return Object.freeze({
      disposition: 'N/A_WITH_PROOF',
      proof_complete: true,
      claim_exclusions: ['PACK_PROFILE', 'EXTERNAL_EXECUTOR_PROFILE'],
      authority_effect: 'NONE'
    });
  }
  return Object.freeze({
    disposition: 'REQUIRED',
    proof_complete: false,
    missing_conditions: {
      omitted_by_profile: omittedByProfile,
      omitted_by_bom: omittedByBom,
      no_runtime_entrypoint: noRuntime,
      negative_invocation_fail_closed: negative
    }
  });
}
