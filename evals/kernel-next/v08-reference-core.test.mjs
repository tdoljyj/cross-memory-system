import test from 'node:test';
import assert from 'node:assert/strict';
import { OBSERVABILITY_AUTHORITY, ObservabilityPort, minimalEnvelope, validateObservabilityProfile } from '../../kernel/runtime/observability-port.mjs';
import { validateFaultToolManifest, validateFuzzManifest, validateShadowManifest, validateSoakManifest } from '../../kernel/policy/observation-manifest.mjs';

const D = (character) => 'sha256:' + character.repeat(64);

function profile(overrides = {}) {
  const base = {
    schema_version: 'clued.observability-profile/1',
    semantic_convention: { version: '1.0.0', digest: D('a') },
    resource: { service_name: 'clued-kernel', component: 'reference-core', version: '0.0.0-candidate', environment: 'isolated_local' },
    allowed_attributes: ['tenant_partition', 'route', 'outcome', 'message'],
    correlation_salt: 'test-only-salt',
    max_string_bytes: 64,
    sensitive_markers: ['SENSITIVEVALUE'],
    sampling: { seed: 17, error: 1, trace: 1, metric: 1, log: 1 },
    rate_limit: { window_ms: 1000, max_per_window: 20, queue_max_events: 20, queue_max_bytes: 20000, retry_budget: 1 },
    provider: { kind: 'none' }
  };
  return {
    ...base,
    ...overrides,
    resource: { ...base.resource, ...(overrides.resource || {}) },
    sampling: { ...base.sampling, ...(overrides.sampling || {}) },
    rate_limit: { ...base.rate_limit, ...(overrides.rate_limit || {}) },
    provider: { ...base.provider, ...(overrides.provider || {}) }
  };
}

function event(kind = 'trace', id = '01', tenant = 'tenant-a') {
  return {
    event_kind: kind,
    timestamp: '2026-09-02T00:00:00.000Z',
    tenant_id: tenant,
    severity: kind === 'error' ? 'error' : 'info',
    trace_id: 'trace-' + id,
    span_id: 'span-' + id,
    correlation: { run_id: 'run-' + id, step_id: 'step-' + id, attempt_id: 'attempt-' + id, evidence_id: 'evidence-' + id },
    attributes: { tenant_partition: tenant, route: 'local-reference', outcome: 'candidate' }
  };
}

test('O01 four minimized envelopes validate and expose zero authority', () => {
  const port = new ObservabilityPort(profile());
  for (const kind of ['error', 'trace', 'metric', 'log']) {
    const result = port.emit(event(kind, kind));
    assert.equal(result.accepted, true);
    assert.equal(result.envelope.event_kind, kind);
    assert.equal(result.envelope.authority.canonical_write, false);
    assert.equal(result.envelope.authority.receipt_authority, false);
  }
  assert.equal(OBSERVABILITY_AUTHORITY.evidence_authority, false);
});

test('CI-51 irreversible correlation and allowlist prevent raw identifiers or forbidden fields', () => {
  const raw = event('log', 'allow');
  raw.attributes.token = 'ordinary-value';
  raw.attributes.user_id = 'raw-user';
  const result = minimalEnvelope(raw, validateObservabilityProfile(profile()));
  assert.equal(result.status, 'SCRUBBED');
  assert.equal(Object.hasOwn(result.envelope.attributes, 'token'), false);
  assert.equal(Object.hasOwn(result.envelope.attributes, 'user_id'), false);
  assert.match(result.envelope.correlation_hashes.run_ref, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.envelope).includes('run-allow'), false);
});

test('CI-51 cross-chunk sensitive value is quarantined before sampling or cache', () => {
  const port = new ObservabilityPort(profile());
  const raw = event('log', 'chunk');
  raw.chunks = ['SENSITIVE', 'VALUE'];
  const result = port.emit(raw);
  assert.equal(result.status, 'QUARANTINED_SENSITIVE');
  assert.equal(port.snapshot().queue_events, 0);
  assert.equal(port.snapshot().audit[0].stage, 'scrub_before_any_cache_sampling_or_export');
});

test('O02 deterministic sampling uses frozen seed and cannot affect canonical outcome', () => {
  const p = profile({ sampling: { trace: 0 } });
  const canonicalOutcome = Object.freeze({ result: 'COMMITTED', receipt_id: 'receipt-1' });
  const left = new ObservabilityPort(p).emit(event('trace', 'sample'), canonicalOutcome);
  const right = new ObservabilityPort(p).emit(event('trace', 'sample'), canonicalOutcome);
  assert.equal(left.status, 'SAMPLED_OUT');
  assert.equal(right.status, left.status);
  assert.equal(left.canonical_outcome.receipt_id, canonicalOutcome.receipt_id);
});

test('O02 per-tenant rate limit isolates a noisy tenant', () => {
  const port = new ObservabilityPort(profile({ rate_limit: { max_per_window: 1 } }));
  assert.equal(port.emit(event('metric', 'a1', 'tenant-a')).accepted, true);
  assert.equal(port.emit(event('metric', 'a2', 'tenant-a')).status, 'RATE_LIMITED');
  assert.equal(port.emit(event('metric', 'b1', 'tenant-b')).accepted, true);
});

test('O02 bounded queue drops telemetry under backpressure without throwing', () => {
  const p = profile({
    provider: { kind: 'adapter', adapter_id: 'test', artifact_digest: D('b') },
    rate_limit: { queue_max_events: 1, queue_max_bytes: 20000 }
  });
  const port = new ObservabilityPort(p, { export: async () => {} });
  assert.equal(port.emit(event('trace', 'q1', 'tenant-a')).status, 'QUEUED');
  assert.equal(port.emit(event('trace', 'q2', 'tenant-b')).status, 'BACKPRESSURE_DROPPED');
  assert.equal(port.snapshot().queue_events, 1);
});

test('O03-PROVIDER-NONE requires zero DSN and exports nothing', async () => {
  const port = new ObservabilityPort(profile());
  port.emit(event('trace', 'none'));
  const flushed = await port.flush();
  assert.equal(flushed.status, 'PROVIDER_NONE');
  assert.equal(port.snapshot().counters.provider_none, 1);
  assert.throws(() => validateObservabilityProfile(profile({ provider: { kind: 'none', dsn: 'https://forbidden.invalid' } })), /OBS_PROVIDER_NONE_MUST_HAVE_ZERO_CONNECTION_CONFIG/);
});

test('O03 adapter failure has bounded retry and leaves business result unchanged', async () => {
  const p = profile({ provider: { kind: 'adapter', adapter_id: 'failing-test', artifact_digest: D('c') } });
  const business = Object.freeze({ result: 'COMMITTED', version: 7 });
  const port = new ObservabilityPort(p, { export: async () => { throw new Error('offline'); } });
  const emitted = port.emit(event('error', 'fail'), business);
  const flushed = await port.flush();
  assert.equal(emitted.canonical_outcome.version, 7);
  assert.equal(flushed.status, 'DROPPED_AFTER_BOUNDED_RETRY');
  assert.equal(port.snapshot().counters.provider_failures, 2);
});

test('CI-52 fault tool manifest is frozen to isolated local targets', () => {
  const valid = {
    schema_version: 'clued.fault-tool-manifest/1',
    tool_id: 'toxiproxy-fixture',
    tool_version: '0.0-test',
    tool_digest: D('1'),
    script_id: 'dns-tls-timeout',
    script_digest: D('2'),
    data_digest: D('3'),
    fault_profile: 'bounded-local',
    target_environment: 'isolated_local',
    target_digest: D('4'),
    network_access: false,
    production_access: false
  };
  assert.equal(validateFaultToolManifest(valid).valid, true);
  assert.throws(() => validateFaultToolManifest({ ...valid, target_environment: 'production' }), /FAULT_PRODUCTION_TARGET_FORBIDDEN/);
});

test('CI-70 frozen A30 fuzz manifest enforces coverage, convergence and zero unresolved crashes', () => {
  const valid = {
    schema_version: 'clued.fuzz-assurance-manifest/1',
    frozen: true,
    candidate_digest: D('1'),
    tool_digest: D('2'),
    corpus_digest: D('3'),
    security_profile_digest: D('4'),
    dictionary_digest: D('5'),
    seed_partition_digest: D('6'),
    deadline_seconds: 1800,
    elapsed_seconds: 120,
    target_families: [{ id: 'envelope', minimum_executions: 100, actual_executions: 120, minimum_branch_coverage: 80, actual_branch_coverage: 85, minimum_edge_coverage: 75, actual_edge_coverage: 80 }],
    equal_windows: [{ executions: 40, coverage_delta: 0.2 }, { executions: 40, coverage_delta: 0.1 }, { executions: 40, coverage_delta: 0 }],
    convergence_delta_max: 0.25,
    last_twenty_percent_new_unresolved_crashes: 0,
    unresolved_unique_crashes: 0
  };
  assert.equal(validateFuzzManifest(valid).valid, true);
  assert.throws(() => validateFuzzManifest({ ...valid, unresolved_unique_crashes: 1 }), /FUZZ_UNRESOLVED_CRASHES_NONZERO/);
  assert.throws(() => validateFuzzManifest({ ...valid, deadline_seconds: 1801 }), /FUZZ_DEADLINE_EXCEEDS_PT30M/);
});

test('CI-71 shadow manifest freezes candidate baseline threshold stop rollback and checkpoint', () => {
  const manifest = {
    schema_version: 'clued.shadow-observation-manifest/1',
    frozen: true,
    candidate_digest: D('1'),
    baseline_digest: D('2'),
    eligible_traffic_digest: D('3'),
    normalization_digest: D('4'),
    policy_digest: D('5'),
    hard_difference_threshold: 0,
    observed_hard_difference: 0,
    deadline_seconds: 300,
    stop_condition: 'hard_difference_gt_zero',
    rollback_condition: 'candidate_disabled',
    checkpoint_id: 'shadow-checkpoint-1',
    result_mode: 'SIGNED_RESULT_OR_USER_WAIT',
    result_state: 'waiting_user_approval'
  };
  assert.equal(validateShadowManifest(manifest).valid, true);
  assert.throws(() => validateShadowManifest({ ...manifest, observed_hard_difference: 1 }), /SHADOW_HARD_THRESHOLD_EXCEEDED/);
});

test('CI-72 soak manifest freezes load quota caps SLO recovery and checkpoint', () => {
  const manifest = {
    schema_version: 'clued.soak-capacity-observation-manifest/1',
    frozen: true,
    candidate_digest: D('1'),
    load_model_digest: D('2'),
    quota_profile_digest: D('3'),
    resource_cap_digest: D('4'),
    slo_digest: D('5'),
    policy_digest: D('6'),
    deadline_seconds: 600,
    stop_condition: 'resource_cap_reached',
    recovery_condition: 'bounded_queue_drained',
    checkpoint_id: 'soak-checkpoint-1',
    within_resource_caps: true,
    slo_met: true,
    result_mode: 'SIGNED_RESULT_OR_USER_WAIT',
    result_state: 'signed_result'
  };
  assert.equal(validateSoakManifest(manifest).valid, true);
  assert.throws(() => validateSoakManifest({ ...manifest, within_resource_caps: false }), /SOAK_THRESHOLDS_NOT_MET/);
});
