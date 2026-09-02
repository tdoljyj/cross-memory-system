function invariant(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

const SHA = /^sha256:[0-9a-f]{64}$/;

function requireDigest(value, code) {
  invariant(SHA.test(value || ''), code);
}

function requiredStrings(object, fields, prefix) {
  for (const field of fields) invariant(typeof object[field] === 'string' && object[field].length > 0, prefix + '_' + field.toUpperCase() + '_REQUIRED');
}

export function validateFaultToolManifest(manifest) {
  invariant(manifest && manifest.schema_version === 'clued.fault-tool-manifest/1', 'FAULT_MANIFEST_SCHEMA');
  requiredStrings(manifest, ['tool_id', 'tool_version', 'script_id', 'fault_profile', 'target_environment'], 'FAULT');
  requireDigest(manifest.tool_digest, 'FAULT_TOOL_DIGEST_REQUIRED');
  requireDigest(manifest.script_digest, 'FAULT_SCRIPT_DIGEST_REQUIRED');
  requireDigest(manifest.data_digest, 'FAULT_DATA_DIGEST_REQUIRED');
  requireDigest(manifest.target_digest, 'FAULT_TARGET_DIGEST_REQUIRED');
  invariant(manifest.target_environment === 'isolated_local', 'FAULT_PRODUCTION_TARGET_FORBIDDEN');
  invariant(manifest.network_access === false && manifest.production_access === false, 'FAULT_ZERO_EXTERNAL_REQUIRED');
  return { valid: true, test_id: 'CI-52' };
}

export function validateFuzzManifest(manifest) {
  invariant(manifest && manifest.schema_version === 'clued.fuzz-assurance-manifest/1', 'FUZZ_MANIFEST_SCHEMA');
  for (const field of ['candidate_digest', 'tool_digest', 'corpus_digest', 'security_profile_digest', 'dictionary_digest', 'seed_partition_digest']) {
    requireDigest(manifest[field], 'FUZZ_' + field.toUpperCase() + '_REQUIRED');
  }
  invariant(manifest.frozen === true, 'FUZZ_MANIFEST_NOT_FROZEN');
  invariant(Number.isInteger(manifest.deadline_seconds) && manifest.deadline_seconds > 0 && manifest.deadline_seconds <= 1800, 'FUZZ_DEADLINE_EXCEEDS_PT30M');
  invariant(Array.isArray(manifest.target_families) && manifest.target_families.length > 0, 'FUZZ_TARGET_FAMILY_REQUIRED');
  for (const target of manifest.target_families) {
    requiredStrings(target, ['id'], 'FUZZ_TARGET');
    invariant(Number.isInteger(target.minimum_executions) && target.minimum_executions > 0, 'FUZZ_MIN_EXECUTIONS_REQUIRED');
    invariant(Number.isFinite(target.minimum_branch_coverage) && target.minimum_branch_coverage > 0, 'FUZZ_BRANCH_THRESHOLD_REQUIRED');
    invariant(Number.isFinite(target.minimum_edge_coverage) && target.minimum_edge_coverage > 0, 'FUZZ_EDGE_THRESHOLD_REQUIRED');
    invariant(target.actual_executions >= target.minimum_executions, 'FUZZ_MIN_EXECUTIONS_NOT_MET');
    invariant(target.actual_branch_coverage >= target.minimum_branch_coverage, 'FUZZ_BRANCH_COVERAGE_NOT_MET');
    invariant(target.actual_edge_coverage >= target.minimum_edge_coverage, 'FUZZ_EDGE_COVERAGE_NOT_MET');
  }
  invariant(Array.isArray(manifest.equal_windows) && manifest.equal_windows.length === 3, 'FUZZ_THREE_EQUAL_WINDOWS_REQUIRED');
  invariant(manifest.equal_windows.every((window) => window.executions === manifest.equal_windows[0].executions), 'FUZZ_WINDOWS_NOT_EQUAL');
  invariant(manifest.equal_windows.every((window) => window.coverage_delta <= manifest.convergence_delta_max), 'FUZZ_COVERAGE_NOT_CONVERGED');
  invariant(manifest.last_twenty_percent_new_unresolved_crashes === 0, 'FUZZ_LAST_20_PERCENT_HAS_NEW_UNRESOLVED');
  invariant(manifest.unresolved_unique_crashes === 0, 'FUZZ_UNRESOLVED_CRASHES_NONZERO');
  invariant(manifest.elapsed_seconds <= manifest.deadline_seconds, 'FUZZ_DEADLINE_EXCEEDED');
  return { valid: true, test_id: 'CI-70' };
}

export function validateShadowManifest(manifest) {
  invariant(manifest && manifest.schema_version === 'clued.shadow-observation-manifest/1', 'SHADOW_MANIFEST_SCHEMA');
  for (const field of ['candidate_digest', 'baseline_digest', 'eligible_traffic_digest', 'normalization_digest', 'policy_digest']) {
    requireDigest(manifest[field], 'SHADOW_' + field.toUpperCase() + '_REQUIRED');
  }
  invariant(manifest.frozen === true, 'SHADOW_MANIFEST_NOT_FROZEN');
  invariant(Number.isFinite(manifest.hard_difference_threshold), 'SHADOW_HARD_THRESHOLD_REQUIRED');
  invariant(manifest.observed_hard_difference <= manifest.hard_difference_threshold, 'SHADOW_HARD_THRESHOLD_EXCEEDED');
  invariant(Number.isInteger(manifest.deadline_seconds) && manifest.deadline_seconds > 0, 'SHADOW_DEADLINE_REQUIRED');
  requiredStrings(manifest, ['stop_condition', 'rollback_condition', 'checkpoint_id'], 'SHADOW');
  invariant(manifest.result_mode === 'SIGNED_RESULT_OR_USER_WAIT', 'SHADOW_RESULT_MODE_INVALID');
  invariant(['signed_result', 'waiting_user_approval'].includes(manifest.result_state), 'SHADOW_RESULT_STATE_INVALID');
  return { valid: true, test_id: 'CI-71' };
}

export function validateSoakManifest(manifest) {
  invariant(manifest && manifest.schema_version === 'clued.soak-capacity-observation-manifest/1', 'SOAK_MANIFEST_SCHEMA');
  for (const field of ['candidate_digest', 'load_model_digest', 'quota_profile_digest', 'resource_cap_digest', 'slo_digest', 'policy_digest']) {
    requireDigest(manifest[field], 'SOAK_' + field.toUpperCase() + '_REQUIRED');
  }
  invariant(manifest.frozen === true, 'SOAK_MANIFEST_NOT_FROZEN');
  invariant(Number.isInteger(manifest.deadline_seconds) && manifest.deadline_seconds > 0, 'SOAK_DEADLINE_REQUIRED');
  requiredStrings(manifest, ['stop_condition', 'recovery_condition', 'checkpoint_id'], 'SOAK');
  invariant(manifest.within_resource_caps === true && manifest.slo_met === true, 'SOAK_THRESHOLDS_NOT_MET');
  invariant(manifest.result_mode === 'SIGNED_RESULT_OR_USER_WAIT', 'SOAK_RESULT_MODE_INVALID');
  invariant(['signed_result', 'waiting_user_approval'].includes(manifest.result_state), 'SOAK_RESULT_STATE_INVALID');
  return { valid: true, test_id: 'CI-72' };
}
