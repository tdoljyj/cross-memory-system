import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// Existing project dependency only. No package download or runtime gate wiring.
const require = createRequire(new URL('../../../apps/clued-cloud/package.json', import.meta.url));
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true, strictKeywords: true, format: 'full' });
const read = name => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8'));
const vectorSchema = read('revocation-epoch-vector.candidate.schema.json');
const profileSchema = read('preentry-profile.candidate.schema.json');
const gaSchema = read('gate-authorization.candidate.schema.json');
ajv.addSchema(vectorSchema, 'revocation-epoch-vector.candidate.schema.json');
const vectorCheck = ajv.getSchema('revocation-epoch-vector.candidate.schema.json');
const profileCheck = ajv.compile(profileSchema);
const gaCheck = ajv.compile(gaSchema);
const clone = value => JSON.parse(JSON.stringify(value));
const h = crypto.createHash('sha256').update('SYNTHETIC_SHAPE_ONLY_NOT_ISSUED').digest('hex');
const ref = () => ({ uri: 'urn:synthetic:unresolved:not-issued', sha256: h });
const layers = ['account', 'integration_installation', 'context', 'binding'];
const vector = {
  vector_schema_version: 'synthetic-not-accepted-v1',
  account_scope_ref: 'urn:synthetic:account', account_epoch: 3,
  integration_installation_scope_ref: 'urn:synthetic:installation', integration_installation_epoch: 4,
  context_scope_ref: 'urn:synthetic:context', context_epoch: 2,
  binding_scope_ref: 'urn:synthetic:binding', binding_epoch: 5,
};
const profile = {
  profile_id: 'DP-PREENTRY-SKILL-QUALIFICATION', definition_version: 'synthetic-not-accepted',
  purpose: 'SKILL_COEXISTENCE_QUALIFICATION', allowed_environments: ['ISOLATED_TEST'],
  allowed_subject_kinds: ['ISOLATED_TEST_SUBJECT'],
  allowed_candidate_states: ['UNQUALIFIED_QUARANTINED_TEST_SUBJECT_ONLY'],
  required_stages: ['R05', 'R06', 'R07', 'R08', 'R09', 'R10'],
  candidate_must_differ_from_controller: true,
  required_true: ['profile_accepted', 'authority_chain_verified', 'owner_or_delegate_verified',
    'phase_authorization_valid', 'controller_qualification_valid', 'isolated_host_proven',
    'scope_contained', 'exact_digests_bound', 'budget_reserved', 'evidence_sink_durable',
    'stop_channel_ready', 'revocation_fresh', 'target_revision_matches', 'no_credential_crossing',
    'pre_registered_expectations'],
  required_false: ['real_user_payload', 'production_credentials', 'public_distribution',
    'economic_rights', 'model_action', 'scope_expansion', 'candidate_pointer_write'],
  gate_control_type: 'GateAuthorization', terminal_receipt_control_type: 'GateResultReceipt',
  gate_refs: [{ gate_id: 'synthetic-not-registered', definition_version: 'synthetic', content_digest: h }],
  gate_definition_set_digest: h, max_lifetime_seconds: 600,
};
const ga = {
  gate_authorization_id: 'ga_synthetic_not_issued', authorization_status: 'AUTHORIZED',
  gate_id: 'synthetic-not-registered',
  profile_ref: { profile_id: profile.profile_id, definition_version: 'synthetic', content_digest: h, accepted_ref: ref() },
  purpose: profile.purpose, environment: 'ISOLATED_TEST', repository_ref: ref(),
  source_ref: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), blobs: [ref()] },
  artifact_refs: [ref()], host_runtime_config_digest: h, upstream_gate_result_receipt_refs: [],
  status_manifest_ref: ref(), release_risk_manifest_digest: h,
  actor_ref: ref(), subject_ref: ref(), binding_ref: ref(), scope_ref: ref(),
  scope_digest: h, profile_digest: h, dominant_role: 'synthetic-not-authorized',
  issuer_ref: ref(), authority_source_ref: ref(), audience: 'synthetic-not-accepted',
  issuer_purpose: 'synthetic-not-authorized', schema_digest: h,
  control_trust_root_generation: 'synthetic-unresolved-root-ref-NOT_A_VALID_GENERATION',
  allowed_read_set: [], allowed_write_set: [], forbidden_actions: ['all_real_actions'],
  credential_scope: ref(), issued_at: '2000-01-01T00:00:00Z',
  expires_at: '2000-01-01T00:10:00Z', deadline: '2000-01-01T00:10:00Z',
  stop_policy_digest: h, rollback_point_ref: ref(), budget_reservation_ref: ref(), evidence_sink_ref: ref(),
  controller_digest: h, controller_qualification_ref: ref(), candidate_skill_digest: h, mechanism_digest: h,
  plan_digest: h, fixtures_digest: h, stage_receipt_refs: [ref()], target_revision: 'synthetic',
  runner_generation: 'synthetic-unresolved', credential_generation: 'synthetic-unresolved',
  session_generation: 'synthetic-unresolved', idempotency_key: 'synthetic-never-dispatched',
  revocation_epoch_vector: vector, signature: 'SYNTHETIC_NOT_A_SIGNATURE',
};
const accepts = (check, value) => assert.equal(check(value), true, JSON.stringify(check.errors));
const rejects = (check, value) => assert.equal(check(value), false, 'Expected shape rejection');

test('three candidate schemas compile and synthetic shapes validate without claiming issuance', () => {
  accepts(vectorCheck, vector); accepts(profileCheck, profile); accepts(gaCheck, ga);
  // This expired object with unresolved roots intentionally passes SHAPE ONLY.
  assert.ok(Date.parse(ga.expires_at) < Date.now());
  assert.equal(ga.signature, 'SYNTHETIC_NOT_A_SIGNATURE');
});
test('each of the nine original Vector fields is mandatory', () => {
  for (const key of Object.keys(vector)) { const x = clone(vector); delete x[key]; rejects(vectorCheck, x); }
});
test('epochs reject booleans, negative values and scalar string substitution', () => {
  for (const value of [true, -1, '5', null]) rejects(vectorCheck, { ...vector, binding_epoch: value });
});
test('a single N/A layer needs paired marker, reason and accepted-schema reference shape', () => {
  const x = { ...vector, integration_installation_scope_ref: 'not_applicable',
    integration_installation_epoch: 'not_applicable',
    not_applicable_evidence: { integration_installation: { reason: 'synthetic syntax only', accepted_schema_ref: ref() } } };
  accepts(vectorCheck, x);
  const noReason = clone(x); delete noReason.not_applicable_evidence.integration_installation.reason; rejects(vectorCheck, noReason);
  const noRef = clone(x); delete noRef.not_applicable_evidence.integration_installation.accepted_schema_ref; rejects(vectorCheck, noRef);
  rejects(vectorCheck, { ...x, integration_installation_epoch: 0 });
});
test('all-layer N/A without accepted-schema references is rejected and never defaulted', () => {
  const x = { vector_schema_version: 'synthetic', not_applicable_evidence: {} };
  for (const layer of layers) {
    x[layer + '_scope_ref'] = 'not_applicable'; x[layer + '_epoch'] = 'not_applicable';
    x.not_applicable_evidence[layer] = { reason: 'synthetic-only missing acceptance' };
  }
  rejects(vectorCheck, x);
  assert.equal(vector.not_applicable_evidence, undefined);
});
test('independent runner generation cannot replace Vector or be hidden inside it', () => {
  rejects(vectorCheck, { ...vector, runner_generation: 'synthetic' });
  const x = clone(ga); delete x.revocation_epoch_vector; rejects(gaCheck, x);
});
test('GA rejects missing exact bindings and missing or wrong-type root generation', () => {
  for (const key of ['schema_digest', 'profile_ref', 'subject_ref', 'binding_ref', 'authority_source_ref', 'control_trust_root_generation', 'signature']) {
    const x = clone(ga); delete x[key]; rejects(gaCheck, x);
  }
  for (const value of [1, true, null, '']) rejects(gaCheck, { ...ga, control_trust_root_generation: value });
});
test('Profile preserves pre-entry stage, purpose, environment, no-model and 600-second boundaries', () => {
  rejects(profileCheck, { ...profile, purpose: 'CORE_SLICE_A_IMPLEMENTATION' });
  rejects(profileCheck, { ...profile, allowed_environments: ['PRODUCTION'] });
  rejects(profileCheck, { ...profile, required_stages: profile.required_stages.filter(x => x !== 'R09') });
  rejects(profileCheck, { ...profile, required_false: profile.required_false.filter(x => x !== 'model_action') });
  rejects(profileCheck, { ...profile, max_lifetime_seconds: 601 });
  accepts(profileCheck, { ...profile, required_stages: [...profile.required_stages].reverse() });
});
test('Profile N/A permission cannot omit accepted-schema reference or reason', () => {
  rejects(profileCheck, { ...profile, not_applicable_layer_permissions: { context: { reason: 'synthetic' } } });
  rejects(profileCheck, { ...profile, not_applicable_layer_permissions: { context: { accepted_schema_ref: ref() } } });
});
test('GA shape rejects production substitution, malformed digest and invalid timestamp', () => {
  rejects(gaCheck, { ...ga, environment: 'PRODUCTION' });
  rejects(gaCheck, { ...ga, schema_digest: 'unresolved' });
  rejects(gaCheck, { ...ga, deadline: 'later' });
});

test('review fix: all four epochs reject rounded unsafe integers at the Number boundary', () => {
  const unsafeA = JSON.parse('9007199254740992');
  const unsafeB = JSON.parse('9007199254740993');
  assert.equal(unsafeA, unsafeB, 'Reproduce the Number precision counterexample');
  for (const layer of layers) {
    const field = layer + '_epoch';
    accepts(vectorCheck, { ...vector, [field]: Number.MAX_SAFE_INTEGER });
    rejects(vectorCheck, { ...vector, [field]: unsafeA });
    rejects(vectorCheck, { ...vector, [field]: unsafeB });
  }
});
test('review fix: full date-time format rejects impossible calendar dates', () => {
  for (const field of ['issued_at', 'expires_at', 'deadline']) {
    for (const invalid of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z']) {
      rejects(gaCheck, { ...ga, [field]: invalid });
    }
    accepts(gaCheck, { ...ga, [field]: '2024-02-29T00:00:00Z' });
  }
});
