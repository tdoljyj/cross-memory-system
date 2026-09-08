#!/usr/bin/env node
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const CONTRACT_STATUS = 'G1_LOCAL_MACHINE_CONTRACT_PASS';
const IDENTIFIER_STATUS = 'REGISTERED_TRACE_IDENTIFIER';
const IDENTIFIER_EXECUTION = 'NOT_RUN_DEFINITION_ONLY';
const REQUIREMENTS_PATH = 'protocol/continuity/v1/requirements.yaml';
const TRACE_PATH = 'protocol/continuity/v1/trace/requirement-test-gate-profile.json';
const REGISTRY_PATH = 'protocol/continuity/v1/registries/object-registry.json';
const APPLICABILITY_PATH = 'protocol/continuity/v1/applicability/minimum-local-rc.json';
const MANIFEST_PATH = 'protocol/continuity/v1/manifest.json';
const MODEL_SCHEMA_V2_DEFINITION = '2.0.0-local-rc-v15-model';
const MODEL_SCHEMA_V2_COVERAGE_KIND = 'SCHEMA_SUPPORT_ONLY_NOT_EXECUTION_EVIDENCE';
const MODEL_SCHEMA_V2_SOURCE = 'sha256:f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec';
const MODEL_SCHEMA_V2_CI = ["CI-88","CI-89","CI-90","CI-91","CI-92","CI-93","CI-94","CI-95","CI-96","CI-97","CI-98","CI-99","CI-100","CI-101","CI-102"];
const MODEL_SCHEMA_V2_EIA = ["EIA-41","EIA-42","EIA-43","EIA-44","EIA-45","EIA-46","EIA-47","EIA-48","EIA-49","EIA-50"];
const MODEL_SCHEMA_V2_ERRORS = ["MODEL_PROVIDER_UNAVAILABLE","MODEL_TIMEOUT","MODEL_CANCELLED","MODEL_BUDGET_EXCEEDED","MODEL_SCOPE_DENIED","MODEL_OUTPUT_INVALID","MODEL_POLICY_BLOCKED","MODEL_REVISION_DRIFT","MODEL_PAYLOAD_UNAVAILABLE","MODEL_INTERNAL_ERROR"];
const MODEL_SCHEMA_V2 = {
  "protocol/continuity/v1/schemas/model/provider-descriptor.schema.json": {
    "id": "urn:clued:schema:model-provider-descriptor:v2",
    "object_type": "ModelProviderDescriptor",
    "properties": [
      "adapter_version",
      "artifact_digest",
      "cancellation",
      "capabilities",
      "data_classes",
      "health_ttl",
      "idempotency",
      "max_input_bytes",
      "max_output_bytes",
      "model_revisions",
      "object_type",
      "provider_id",
      "provider_type",
      "regions",
      "retention_modes",
      "schema_version",
      "signature_ref",
      "streaming",
      "training_modes"
    ],
    "required": [
      "adapter_version",
      "artifact_digest",
      "cancellation",
      "capabilities",
      "data_classes",
      "health_ttl",
      "idempotency",
      "max_input_bytes",
      "max_output_bytes",
      "model_revisions",
      "object_type",
      "provider_id",
      "provider_type",
      "regions",
      "retention_modes",
      "schema_version",
      "signature_ref",
      "streaming",
      "training_modes"
    ],
    "source_sections": [
      "38.11",
      "38.4",
      "38.5",
      "38.9"
    ],
    "coverage": {
      "schema_support": {
        "ci": [
          "CI-88",
          "CI-96",
          "CI-97"
        ],
        "eia": [
          "EIA-50"
        ]
      },
      "semantic_runtime_required": {
        "ci": [
          "CI-101",
          "CI-102",
          "CI-90",
          "CI-92"
        ],
        "eia": [
          "EIA-46",
          "EIA-47"
        ]
      }
    }
  },
  "protocol/continuity/v1/schemas/model/model-invocation-request.schema.json": {
    "id": "urn:clued:schema:model-invocation-request:v2",
    "object_type": "ModelInvocationRequest",
    "properties": [
      "adapter_version",
      "attempt_id",
      "binding_ref",
      "budgets",
      "capability",
      "context_slice_ref",
      "correlation_id",
      "data_classification",
      "deadline",
      "eval_set_digest",
      "idempotency_key",
      "input_digest",
      "invocation_id",
      "lease_hard_stop",
      "model_revision",
      "object_type",
      "output_schema_digest",
      "policy_snapshot_digest",
      "project_ref",
      "provider_id",
      "provider_qualification_ref",
      "provider_type",
      "purpose",
      "region",
      "retention_mode",
      "schema_version",
      "scope_digest",
      "security_profile_id",
      "step_deadline",
      "subject_ref",
      "template_hash",
      "training_mode",
      "training_opt_in_receipt_ref"
    ],
    "required": [
      "adapter_version",
      "attempt_id",
      "binding_ref",
      "budgets",
      "capability",
      "context_slice_ref",
      "correlation_id",
      "data_classification",
      "deadline",
      "eval_set_digest",
      "idempotency_key",
      "input_digest",
      "invocation_id",
      "lease_hard_stop",
      "model_revision",
      "object_type",
      "output_schema_digest",
      "policy_snapshot_digest",
      "project_ref",
      "provider_id",
      "provider_qualification_ref",
      "provider_type",
      "purpose",
      "region",
      "retention_mode",
      "schema_version",
      "scope_digest",
      "security_profile_id",
      "step_deadline",
      "subject_ref",
      "template_hash",
      "training_mode",
      "training_opt_in_receipt_ref"
    ],
    "source_sections": [
      "38.10",
      "38.11",
      "38.5",
      "38.8",
      "38.9"
    ],
    "coverage": {
      "schema_support": {
        "ci": [
          "CI-102",
          "CI-91",
          "CI-95",
          "CI-97",
          "CI-99"
        ],
        "eia": [
          "EIA-42",
          "EIA-43",
          "EIA-45"
        ]
      },
      "semantic_runtime_required": {
        "ci": [
          "CI-92",
          "CI-93"
        ],
        "eia": [
          "EIA-44",
          "EIA-46",
          "EIA-47",
          "EIA-49"
        ]
      }
    }
  },
  "protocol/continuity/v1/schemas/model/model-invocation-attempt.schema.json": {
    "id": "urn:clued:schema:model-invocation-attempt:v2",
    "object_type": "ModelInvocationAttempt",
    "properties": [
      "adapter_version",
      "attempt_id",
      "attempt_ordinal",
      "backoff_ms",
      "budget_reservation_ref",
      "cancel_requested_at",
      "candidate_acceptance_eligible",
      "idempotency_key",
      "invocation_id",
      "jitter_ms",
      "late_result",
      "late_result_evidence_ref",
      "lease_hard_stop",
      "model_id",
      "model_revision",
      "object_type",
      "output_merge_policy",
      "predecessor_attempt_id",
      "provider_deadline",
      "provider_id",
      "request_digest",
      "result_received_at",
      "retry_not_before",
      "retry_trigger",
      "schema_version",
      "started_at",
      "step_attempt_ref",
      "step_deadline"
    ],
    "required": [
      "adapter_version",
      "attempt_id",
      "attempt_ordinal",
      "backoff_ms",
      "budget_reservation_ref",
      "cancel_requested_at",
      "candidate_acceptance_eligible",
      "idempotency_key",
      "invocation_id",
      "jitter_ms",
      "late_result",
      "late_result_evidence_ref",
      "lease_hard_stop",
      "model_id",
      "model_revision",
      "object_type",
      "output_merge_policy",
      "predecessor_attempt_id",
      "provider_deadline",
      "provider_id",
      "request_digest",
      "result_received_at",
      "retry_not_before",
      "retry_trigger",
      "schema_version",
      "started_at",
      "step_attempt_ref",
      "step_deadline"
    ],
    "source_sections": [
      "10",
      "38.10",
      "38.11",
      "38.6"
    ],
    "coverage": {
      "schema_support": {
        "ci": [
          "CI-94",
          "CI-95",
          "CI-99"
        ],
        "eia": [
          "EIA-41",
          "EIA-45",
          "EIA-48"
        ]
      },
      "semantic_runtime_required": {
        "ci": [],
        "eia": []
      }
    }
  },
  "protocol/continuity/v1/schemas/model/model-invocation-result.schema.json": {
    "id": "urn:clued:schema:model-invocation-result:v2",
    "object_type": "ModelInvocationResult",
    "properties": [
      "adapter_artifact_digest",
      "adapter_version",
      "attempt_id",
      "binding_projection",
      "budget_reservation_ref",
      "business_receipt_boundary",
      "capability",
      "completed_at",
      "correlation_id",
      "data_classification",
      "error",
      "input_digest",
      "invocation_id",
      "invocation_result_authority",
      "model_id",
      "model_revision",
      "object_type",
      "outcome",
      "output_digest",
      "output_schema_digest",
      "payload_ref",
      "policy_snapshot_digest",
      "pre_output_schema_validation_status",
      "project_projection",
      "provider_id",
      "provider_response_id",
      "provider_type",
      "purpose",
      "region",
      "request_budget_snapshot",
      "request_digest",
      "response_summary",
      "result_id",
      "retention_mode",
      "retention_policy",
      "routing_reason",
      "schema_version",
      "scope_digest",
      "settlement_ref",
      "started_at",
      "stop_reason",
      "subject_projection",
      "template_hash",
      "training_mode",
      "usage"
    ],
    "required": [
      "adapter_artifact_digest",
      "adapter_version",
      "attempt_id",
      "binding_projection",
      "budget_reservation_ref",
      "business_receipt_boundary",
      "capability",
      "completed_at",
      "correlation_id",
      "data_classification",
      "error",
      "input_digest",
      "invocation_id",
      "invocation_result_authority",
      "model_id",
      "model_revision",
      "object_type",
      "outcome",
      "output_digest",
      "output_schema_digest",
      "payload_ref",
      "policy_snapshot_digest",
      "pre_output_schema_validation_status",
      "project_projection",
      "provider_id",
      "provider_response_id",
      "provider_type",
      "purpose",
      "region",
      "request_budget_snapshot",
      "request_digest",
      "response_summary",
      "result_id",
      "retention_mode",
      "retention_policy",
      "routing_reason",
      "schema_version",
      "scope_digest",
      "settlement_ref",
      "started_at",
      "stop_reason",
      "subject_projection",
      "template_hash",
      "training_mode",
      "usage"
    ],
    "source_sections": [
      "38.10",
      "38.11",
      "38.5",
      "38.7",
      "38.9"
    ],
    "coverage": {
      "schema_support": {
        "ci": [
          "CI-100",
          "CI-102",
          "CI-92",
          "CI-94",
          "CI-95",
          "CI-96"
        ],
        "eia": [
          "EIA-41",
          "EIA-42",
          "EIA-46",
          "EIA-47",
          "EIA-48",
          "EIA-49",
          "EIA-50"
        ]
      },
      "semantic_runtime_required": {
        "ci": [
          "CI-101",
          "CI-97"
        ],
        "eia": []
      }
    }
  },
  "protocol/continuity/v1/schemas/model/model-output-candidate.schema.json": {
    "id": "urn:clued:schema:model-output-candidate:v2",
    "object_type": "ModelOutputCandidate",
    "properties": [
      "adapter_artifact_digest",
      "adapter_version",
      "attempt_id",
      "authority",
      "binding_ref",
      "candidate_id",
      "canonical_status",
      "capability",
      "correlation_id",
      "data_classification",
      "expires_at",
      "generated_at",
      "immutability",
      "input_digest",
      "invocation_id",
      "invocation_result_digest",
      "invocation_result_id",
      "lifecycle_projection_authority",
      "model_id",
      "model_revision",
      "object_type",
      "output_digest",
      "output_schema_digest",
      "payload_ref",
      "policy_snapshot_digest",
      "project_ref",
      "provider_id",
      "provider_qualification_ref",
      "provider_type",
      "purpose",
      "region",
      "retention_mode",
      "retention_policy",
      "schema_version",
      "scope_digest",
      "subject_ref",
      "template_hash",
      "training_mode"
    ],
    "required": [
      "adapter_artifact_digest",
      "adapter_version",
      "attempt_id",
      "authority",
      "binding_ref",
      "candidate_id",
      "canonical_status",
      "capability",
      "correlation_id",
      "data_classification",
      "expires_at",
      "generated_at",
      "immutability",
      "input_digest",
      "invocation_id",
      "invocation_result_digest",
      "invocation_result_id",
      "lifecycle_projection_authority",
      "model_id",
      "model_revision",
      "object_type",
      "output_digest",
      "output_schema_digest",
      "payload_ref",
      "policy_snapshot_digest",
      "project_ref",
      "provider_id",
      "provider_qualification_ref",
      "provider_type",
      "purpose",
      "region",
      "retention_mode",
      "retention_policy",
      "schema_version",
      "scope_digest",
      "subject_ref",
      "template_hash",
      "training_mode"
    ],
    "source_sections": [
      "38.10",
      "38.11",
      "38.6",
      "38.7",
      "38.8",
      "38.9"
    ],
    "coverage": {
      "schema_support": {
        "ci": [
          "CI-100",
          "CI-102",
          "CI-89",
          "CI-93",
          "CI-98"
        ],
        "eia": [
          "EIA-42",
          "EIA-43",
          "EIA-47",
          "EIA-48",
          "EIA-49"
        ]
      },
      "semantic_runtime_required": {
        "ci": [
          "CI-101",
          "CI-91",
          "CI-94"
        ],
        "eia": [
          "EIA-44"
        ]
      }
    }
  }
};
const MODEL_RULES = new Set([
  'MODEL-AUDIT-01','MODEL-BOUNDARY-01','MODEL-BUDGET-01','MODEL-CANDIDATE-01',
  'MODEL-CANONICAL-01','MODEL-DEADLINE-01','MODEL-DRIFT-01','MODEL-FAILSAFE-01',
  'MODEL-GATE-01','MODEL-IDEMPOTENCY-01','MODEL-MIN-DISCLOSURE-01','MODEL-NO-TRAINING-01',
  'MODEL-OPTIONAL-01','MODEL-PROJECTION-01','MODEL-PROVENANCE-01','MODEL-SECRET-01',
]);

function fail(code, message, details) {
  process.stdout.write(JSON.stringify({ ok: false, code, message, details: details || {} }) + '\n');
  process.exit(1);
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function same(left, right) {
  return canonical(left) === canonical(right);
}
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    if (key === 'allow-dirty') {
      out[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('ARGUMENT_ERROR', 'missing value for --' + key);
    out[key] = value;
    index += 1;
  }
  return out;
}
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
function repoPath(root, input) {
  if (typeof input !== 'string' || !input || isAbsolute(input) || input.includes('\0')) throw new Error('invalid repository-relative path: ' + String(input));
  const lexical = resolve(root, input);
  const rel = relative(root, lexical);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('path escapes repository: ' + input);
  const parent = realpathSync(dirname(lexical));
  const parentRel = relative(root, parent);
  if (parentRel === '..' || parentRel.startsWith('..' + sep) || isAbsolute(parentRel)) throw new Error('path parent escapes repository: ' + input);
  if (lstatSync(lexical).isSymbolicLink()) throw new Error('symbolic link rejected: ' + input);
  return lexical;
}
function bindingValid(binding) {
  return binding && binding.path === 'work/g1-core-contract/20260902T074932126Z-v15/g1-core-source.json'
    && /^sha256:[0-9a-f]{64}$/.test(binding.sha256)
    && Number.isInteger(binding.size) && binding.size > 0
    && typeof binding.workspace_root === 'string' && isAbsolute(binding.workspace_root);
}
function claimValid(boundary) {
  return boundary && boundary.scope === 'V15_G1_LOCAL_MACHINE_CONTRACT_ONLY'
    && boundary.g1_local_machine_contract_pass_allowed === true
    && boundary.registered_trace_identifier_execution === IDENTIFIER_EXECUTION
    && boundary.v3_3_cryptographic_gate_conformance === false
    && boundary.production === false && boundary.published === false
    && boundary.deployed === false && boundary.authority_effect === 'NONE';
}
function requireBindingEqual(actual, expected, label) {
  if (!bindingValid(actual) || !same(actual, expected)) throw new Error(label + ' intermediate_source binding mismatch');
}
function readIntermediateSource(binding) {
  if (!bindingValid(binding)) throw new Error('intermediate_source binding invalid');
  const workspaceRoot = resolve(binding.workspace_root);
  const sourcePath = resolve(workspaceRoot, binding.path);
  const rel = relative(workspaceRoot, sourcePath);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('intermediate_source path escapes workspace');
  const bytes = readFileSync(sourcePath);
  if (bytes.length !== binding.size || 'sha256:' + sha256(bytes) !== binding.sha256) throw new Error('intermediate_source bytes binding mismatch');
  const source = JSON.parse(bytes.toString('utf8'));
  if (source.schema_version !== 'clued.v15.g1-core-source/1' || source.object_type !== 'G1CoreProtocolSource' || source.package_id !== 'G1_core_contract' || source.definition_version !== '1.0.0-local-rc-v15' || !Array.isArray(source.core_rules) || source.core_rules.length !== 16 || !Array.isArray(source.model_rules) || source.model_rules.length !== 16 || !claimValid(source.claim_boundary)) throw new Error('intermediate_source identity invalid');
  const rules = [...source.core_rules, ...source.model_rules];
  const ids = new Set();
  for (const rule of rules) {
    if (typeof rule.rule_id !== 'string' || ids.has(rule.rule_id) || typeof rule.statement !== 'string' || !Array.isArray(rule.source_refs) || !rule.source_refs.length || !Array.isArray(rule.tests) || !rule.tests.length || !Array.isArray(rule.gates) || !rule.gates.length || !Array.isArray(rule.profiles) || !rule.profiles.length) throw new Error('intermediate_source rule invalid');
    ids.add(rule.rule_id);
  }
  return { source, rules: rules.sort((left, right) => left.rule_id.localeCompare(right.rule_id)) };
}

function validateManifest(root, manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 'clued.protocol-manifest/1' || manifest.object_type !== 'ProtocolManifest' || manifest.status !== CONTRACT_STATUS) throw new Error('unexpected protocol manifest identity');
  if (manifest.validation_scope !== 'G1_MACHINE_CONTRACT_GENERATION_AND_STRUCTURE_ONLY' || manifest.registered_identifier_execution !== IDENTIFIER_EXECUTION || !claimValid(manifest.claim_boundary)) throw new Error('manifest claim boundary exceeds G1 local machine contract');
  const generated = manifest.generated_from;
  if (!bindingValid(generated && generated.intermediate_source)) throw new Error('manifest intermediate_source binding invalid');
  for (const key of ['baseline_commit','baseline_tree','baseline_memory_tree','baseline_protocol_v1_tree']) {
    if (!/^[0-9a-f]{40}$/.test(generated && generated[key] || '')) throw new Error('manifest ' + key + ' invalid');
  }
  const controlSuccessor = manifest.control_root_successor;
  const limitedControlSuccessor = controlSuccessor?.revision_id === 'phase2-control-root-nonproduction-v1-20260908';
  if (controlSuccessor && !limitedControlSuccessor) throw new Error('unknown control root successor');
  if (!limitedControlSuccessor && manifest.control_uri_templates) throw new Error('control mapping without accepted successor identity');
  if (limitedControlSuccessor && (!same(controlSuccessor, {"authority_effect":"NONE","predecessor_manifest_sha256":"05ca5bb70c642dba9c3f58c0b943020d6188636e60cc569b3802c90a9afd36b5","revision_id":"phase2-control-root-nonproduction-v1-20260908","root_set_id":"ctr_414bd3c724264a83894b0c55cf2ab878","schema_sha256":"87f094fa079034aa886d6c568730370a3264e106529b4bfd79bc3369f30b79e5","scope":"NEW_SCHEMA_AND_TYPED_URI_ONLY_NOT_ROOT_REGISTRATION","source_contract":"sha256:f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec"}) || !same(manifest.control_uri_templates, {"ControlTrustRootSet":{"adapter_kind":"PRIVATE_SQL_IN_EXISTING_NONPRODUCTION_CLUED","allowed_root_set_ids":["ctr_414bd3c724264a83894b0c55cf2ab878"],"authority_effect":"NONE","fragments":{"history":"events","revocations":"events filtered to ROOT_REVOKED or GENERATION_REVOKED"},"new_concretization_not_historical_template":true,"object_type":"ControlTrustRootSet","parameter":"root_set_id","project_ref":"uscrdifznmlvczcekqpw","public_rest_exposure":false,"query":"select clued_control.read_root($1) value","schema_path":"protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json","schema_sha256":"87f094fa079034aa886d6c568730370a3264e106529b4bfd79bc3369f30b79e5","uri_template":"urn:clued:control-trust-root-set:uscrdifznmlvczcekqpw:{root_set_id}"}}))) throw new Error('control successor scope mismatch');
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== (limitedControlSuccessor ? 92 : 91)) throw new Error('exact manifest entry count mismatch');
  if (limitedControlSuccessor && !manifest.entries.some(e => e.path === 'protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json' && e.sha256 === 'sha256:' + controlSuccessor.schema_sha256)) throw new Error('control successor schema binding mismatch');
  const paths = new Set();
  for (const entry of manifest.entries) {
    if (paths.has(entry.path)) throw new Error('duplicate manifest path: ' + entry.path);
    paths.add(entry.path);
    const bytes = readFileSync(repoPath(root, entry.path));
    if (entry.sha256 !== 'sha256:' + sha256(bytes) || entry.size !== bytes.length) throw new Error('manifest binding mismatch: ' + entry.path);
  }
  for (const required of [REQUIREMENTS_PATH, TRACE_PATH, REGISTRY_PATH, APPLICABILITY_PATH, 'protocol/continuity/v1/profiles/core.profile.json', 'protocol/continuity/v1/profiles/model-capability.profile.json']) {
    if (!paths.has(required)) throw new Error('required generated path missing: ' + required);
  }
  const computedTree = 'sha256:' + sha256(Buffer.from(canonical(manifest.entries), 'utf8'));
  if (computedTree !== manifest.content_tree_digest) throw new Error('content tree digest mismatch');
  return { manifest, paths };
}

function validateRequirements(root, manifest, sourceProjection) {
  const registry = JSON.parse(readFileSync(repoPath(root, REQUIREMENTS_PATH), 'utf8'));
  if (registry.schema_version !== 'requirements-v1' || registry.registry_status !== 'authoritative' || registry.g1_qualified !== true || registry.definition_version !== '1.0.0-local-rc-v15') throw new Error('requirements registry is not G1-qualified local-v15 authority');
  requireBindingEqual(registry.intermediate_source, manifest.generated_from.intermediate_source, 'requirements');
  if (!Array.isArray(registry.requirements) || registry.requirements.length !== 32) throw new Error('requirements count must be 32');
  const ids = new Set();
  const sourceRulesById = new Map(sourceProjection.rules.map((rule) => [rule.rule_id, rule]));
  for (let index = 0; index < registry.requirements.length; index += 1) {
    const item = registry.requirements[index];
    const sourceRule = sourceProjection.rules[index];
    if (!item.requirement_id || ids.has(item.requirement_id)) throw new Error('duplicate/missing requirement id at ' + index);
    ids.add(item.requirement_id);
    if (!sourceRule || item.requirement_id !== sourceRule.rule_id || item.statement !== sourceRule.statement || !same(item.source_refs, sourceRule.source_refs)) throw new Error('requirements registry is not exact intermediate_source projection at ' + index);
    if (item.rule_phase !== 'authoritative' || item.canonical_uri !== REQUIREMENTS_PATH || item.canonical_pointer !== '#/requirements/' + index) throw new Error('non-authoritative requirement pointer: ' + item.requirement_id);
    if (item.typed_uri !== 'urn:clued:requirement:' + item.requirement_id || item.content_digest !== 'sha256:' + sha256(Buffer.from(item.statement || '', 'utf8'))) throw new Error('requirement identity/digest mismatch: ' + item.requirement_id);
    for (const key of ['test_refs','gate_refs','profile_refs']) if (key in item) throw new Error('reverse trace field forbidden in requirements authority: ' + item.requirement_id + '/' + key);
  }
  const actualModel = new Set([...ids].filter((id) => id.startsWith('MODEL-')));
  if (actualModel.size !== 16 || [...MODEL_RULES].some((id) => !actualModel.has(id))) throw new Error('model rule set is not exact 16/16');
  const computed = 'sha256:' + sha256(Buffer.from(canonical(registry.requirements), 'utf8'));
  if (computed !== registry.rule_set_digest || computed !== manifest.rule_set_digest) throw new Error('rule set digest mismatch');
  return { registry, ids, modelRuleCount: actualModel.size, sourceRulesById, sourceRules: sourceProjection.rules };
}

function assertRegistered(items, idKey, prefix, label) {
  if (!Array.isArray(items) || items.length === 0) throw new Error(label + ' registered identifier set empty');
  const uris = new Set();
  for (const item of items) {
    if (!item[idKey] || item.typed_uri !== prefix + item[idKey] || item.registration_status !== IDENTIFIER_STATUS || item.execution_status !== IDENTIFIER_EXECUTION || uris.has(item.typed_uri)) throw new Error(label + ' registered identifier invalid');
    uris.add(item.typed_uri);
  }
  return uris;
}

function validateTrace(root, requirements, manifest) {
  const trace = JSON.parse(readFileSync(repoPath(root, TRACE_PATH), 'utf8'));
  requireBindingEqual(trace.intermediate_source, manifest.generated_from.intermediate_source, 'trace');
  if (trace.schema_version !== 'clued.requirement-trace/2' || trace.requirements_count !== 32 || trace.model_rule_count !== 16 || trace.rule_set_digest !== requirements.registry.rule_set_digest || trace.registered_identifier_execution !== IDENTIFIER_EXECUTION || !Array.isArray(trace.entries) || trace.entries.length !== 32) throw new Error('trace identity/count mismatch');
  const testUris = assertRegistered(trace.registered_tests, 'test_id', 'urn:clued:test:', 'test');
  const gateUris = assertRegistered(trace.registered_gates, 'gate_id', 'urn:clued:gate:', 'gate');
  const profileUris = assertRegistered(trace.registered_release_profiles, 'profile_id', 'urn:clued:release-profile:', 'profile');
  const expectedTestUris = [...new Set(requirements.sourceRules.flatMap((rule) => rule.tests).map((id) => 'urn:clued:test:' + id))].sort();
  const expectedGateUris = [...new Set(requirements.sourceRules.flatMap((rule) => rule.gates).map((id) => 'urn:clued:gate:' + id))].sort();
  const expectedProfileUris = [...new Set(requirements.sourceRules.flatMap((rule) => rule.profiles).map((id) => 'urn:clued:release-profile:' + id))].sort();
  if (!same([...testUris].sort(), expectedTestUris) || !same([...gateUris].sort(), expectedGateUris) || !same([...profileUris].sort(), expectedProfileUris)) throw new Error('global registered identifier sets are not exact intermediate_source projection');
  const seenRequirements = new Set();
  const usedTests = new Set();
  const usedGates = new Set();
  const usedProfiles = new Set();
  const expectedEdges = [];
  const mappings = [];
  const graph = new Map();
  const indegree = new Map();
  const addNode = (id) => {
    if (!graph.has(id)) {
      graph.set(id, new Set());
      indegree.set(id, 0);
    }
  };
  const addEdge = (left, right) => {
    addNode(left);
    addNode(right);
    if (!graph.get(left).has(right)) {
      graph.get(left).add(right);
      indegree.set(right, indegree.get(right) + 1);
    }
  };
  for (const entry of trace.entries) {
    const id = entry.requirement_ref && entry.requirement_ref.replace('urn:clued:requirement:', '');
    const sourceRule = requirements.sourceRulesById.get(id);
    if (!requirements.ids.has(id) || seenRequirements.has(id) || entry.trace_entry_id !== 'TRACE-' + id || entry.execution_status !== IDENTIFIER_EXECUTION) throw new Error('unknown/duplicate trace requirement: ' + entry.requirement_ref);
    seenRequirements.add(id);
    const testRefs = entry.registered_test_refs;
    const gateRefs = entry.registered_gate_refs;
    const profileRefs = entry.registered_release_profile_refs;
    const expectedTestRefs = [...new Set(sourceRule.tests)].sort().map((item) => 'urn:clued:test:' + item);
    const expectedGateRefs = [...new Set(sourceRule.gates)].sort().map((item) => 'urn:clued:gate:' + item);
    const expectedProfileRefs = [...new Set(sourceRule.profiles)].sort().map((item) => 'urn:clued:release-profile:' + item);
    if (!same(testRefs, expectedTestRefs) || !same(gateRefs, expectedGateRefs) || !same(profileRefs, expectedProfileRefs)) throw new Error('per-rule trace is not exact intermediate_source projection: ' + id);
    if (!Array.isArray(testRefs) || !testRefs.length || testRefs.some((ref) => !testUris.has(ref))) throw new Error('invalid registered test trace: ' + id);
    if (!Array.isArray(gateRefs) || !gateRefs.length || gateRefs.some((ref) => !gateUris.has(ref))) throw new Error('invalid registered gate trace: ' + id);
    if (!Array.isArray(profileRefs) || !profileRefs.length || profileRefs.some((ref) => !profileUris.has(ref))) throw new Error('invalid registered profile trace: ' + id);
    testRefs.forEach((ref) => usedTests.add(ref));
    gateRefs.forEach((ref) => usedGates.add(ref));
    profileRefs.forEach((ref) => usedProfiles.add(ref));
    const exactEdges = [
      { ordinal: 1, source_kind: 'Requirement', source_refs: [entry.requirement_ref], target_kind: 'RegisteredTestIdentifierSet', target_refs: testRefs, edge_semantics: 'verified_by_registered_set' },
      { ordinal: 2, source_kind: 'RegisteredTestIdentifierSet', source_refs: testRefs, target_kind: 'RegisteredGateIdentifierSet', target_refs: gateRefs, edge_semantics: 'accepted_by_registered_set' },
      { ordinal: 3, source_kind: 'RegisteredGateIdentifierSet', source_refs: gateRefs, target_kind: 'RegisteredReleaseProfileIdentifierSet', target_refs: profileRefs, edge_semantics: 'included_in_registered_set' },
    ];
    if (!same(entry.trace_edges, exactEdges)) throw new Error('trace edge exact-set mismatch: ' + id);
    for (const edge of exactEdges) expectedEdges.push({ trace_entry_id: entry.trace_entry_id, requirement_ref: entry.requirement_ref, ...edge });
    mappings.push({ requirement_ref: entry.requirement_ref, registered_test_refs: testRefs, registered_gate_refs: gateRefs, registered_release_profile_refs: profileRefs });
    const r = entry.requirement_ref;
    const t = 'urn:clued:trace-layer:' + id + ':tests';
    const g = 'urn:clued:trace-layer:' + id + ':gates';
    const p = 'urn:clued:trace-layer:' + id + ':profiles';
    addEdge(r, t);
    addEdge(t, g);
    addEdge(g, p);
  }
  if (seenRequirements.size !== requirements.ids.size || usedTests.size !== testUris.size || usedGates.size !== gateUris.size || usedProfiles.size !== profileUris.size) throw new Error('trace orphan detected');
  const mappingDigest = 'sha256:' + sha256(Buffer.from(canonical(mappings), 'utf8'));
  if (trace.downstream_mapping_digest !== mappingDigest || manifest.downstream_mapping_digest !== mappingDigest) throw new Error('downstream mapping digest mismatch');
  const queue = [...indegree].filter((item) => item[1] === 0).map((item) => item[0]).sort();
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const next of [...graph.get(id)].sort()) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  if (visited !== graph.size) throw new Error('Requirement-Test-Gate-ReleaseProfile trace DAG contains a cycle');
  const objectRegistry = JSON.parse(readFileSync(repoPath(root, REGISTRY_PATH), 'utf8'));
  requireBindingEqual(objectRegistry.intermediate_source, manifest.generated_from.intermediate_source, 'object registry');
  if (objectRegistry.registered_identifier_execution !== IDENTIFIER_EXECUTION || objectRegistry.downstream_mapping_digest !== mappingDigest || !same(objectRegistry.registered_tests, trace.registered_tests) || !same(objectRegistry.registered_gates, trace.registered_gates) || !same(objectRegistry.registered_release_profiles, trace.registered_release_profiles) || !same(objectRegistry.construction_edges, expectedEdges)) throw new Error('object registry trace exact-set mismatch');
  return {
    entries: trace.entries.length,
    trace_edges: expectedEdges.length,
    registered_tests: testUris.size,
    registered_gates: gateUris.size,
    registered_release_profiles: profileUris.size,
    downstream_mapping_digest: mappingDigest,
    registered_identifier_execution: IDENTIFIER_EXECUTION,
    dag_nodes: graph.size,
  };
}

function validateModelSchemasV2(root) {
  const exact = (actual, expected, label) => {
    if (!same([...(actual || [])].sort(), [...expected].sort())) throw new Error(label + ' exact set mismatch');
  };
  const walkClosed = (node, label) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      if (node.additionalProperties !== false || !node.properties || !Array.isArray(node.required)) throw new Error(label + ' object not closed');
      exact(node.required, Object.keys(node.properties), label + ' required');
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && node.type === 'object') for (const [child, schema] of Object.entries(value)) walkClosed(schema, label + '/properties/' + child);
      else walkClosed(value, label + '/' + key);
    }
  };
  const ci = new Set();
  const eia = new Set();
  const loaded = new Map();
  for (const [path, spec] of Object.entries(MODEL_SCHEMA_V2)) {
    const schema = JSON.parse(readFileSync(repoPath(root, path), 'utf8'));
    loaded.set(path, schema);
    if (schema.$id !== spec.id || schema.properties.schema_version.const !== '2.0' || schema.properties.object_type.const !== spec.object_type || schema['x-clued-definition-version'] !== MODEL_SCHEMA_V2_DEFINITION || schema['x-clued-generated-from'] !== MODEL_SCHEMA_V2_SOURCE || schema['x-clued-coverage-kind'] !== MODEL_SCHEMA_V2_COVERAGE_KIND || schema['x-clued-registered-test-execution'] !== IDENTIFIER_EXECUTION) throw new Error('model schema v2 identity mismatch: ' + path);
    exact(schema.required, spec.required, path + ' required');
    exact(Object.keys(schema.properties || {}), spec.properties, path + ' properties');
    exact(schema['x-clued-source-sections'], spec.source_sections, path + ' source');
    if (!same(schema['x-clued-registered-test-coverage'], spec.coverage)) throw new Error(path + ' coverage mismatch');
    for (const group of Object.values(spec.coverage)) {
      group.ci.forEach((id) => ci.add(id));
      group.eia.forEach((id) => eia.add(id));
    }
    walkClosed(schema, path);
  }
  exact([...ci], MODEL_SCHEMA_V2_CI, 'model schema v2 CI union');
  exact([...eia], MODEL_SCHEMA_V2_EIA, 'model schema v2 EIA union');
  const request = loaded.get('protocol/continuity/v1/schemas/model/model-invocation-request.schema.json');
  const attempt = loaded.get('protocol/continuity/v1/schemas/model/model-invocation-attempt.schema.json');
  const result = loaded.get('protocol/continuity/v1/schemas/model/model-invocation-result.schema.json');
  const candidate = loaded.get('protocol/continuity/v1/schemas/model/model-output-candidate.schema.json');
  const budget = request.properties.budgets;
  const usage = result.properties.usage;
  const snapshot = result.properties.request_budget_snapshot;
  for (const key of ['currency','currency_exponent','currency_profile_digest']) {
    if (!same(budget.properties[key], usage.properties[key]) || !same(budget.properties[key], snapshot.properties[key])) throw new Error('currency triple schema mismatch: ' + key);
  }
  if (!same(budget.properties.max_cost_minor_units, usage.properties.cost_minor_units)) throw new Error('minor-unit schema mismatch');
  exact(result.$defs.standard_error.properties.code.enum, MODEL_SCHEMA_V2_ERRORS, 'standard errors');
  if (attempt.properties.output_merge_policy.const !== 'FORBID_CROSS_ATTEMPT_MERGE' || !attempt['x-clued-derived-wire-contract']) throw new Error('attempt derived/retry boundary missing');
  if (result.properties.invocation_result_authority.const !== 'PROVIDER_CALL_OUTCOME_ONLY' || result.properties.business_receipt_boundary.const !== 'SEPARATE_ID_SCHEMA_OUTCOME_AND_STORAGE' || !result['x-clued-outcome-contract']) throw new Error('result business boundary missing');
  if (candidate.properties.authority.const !== 'NON_AUTHORITATIVE_CANDIDATE' || candidate.properties.canonical_status.const !== 'NOT_CANONICAL' || candidate.properties.immutability.const !== 'IMMUTABLE_APPEND_ONLY' || candidate.properties.lifecycle_projection_authority.const !== 'EVENT_DECISION_RECEIPT_ONLY') throw new Error('candidate boundary missing');
  for (const forbidden of ['status','canonical_object_ref','canonical_receipt_id','business_outcome']) if (forbidden in candidate.properties) throw new Error('candidate forbidden field: ' + forbidden);
  return { version: MODEL_SCHEMA_V2_DEFINITION, schemas: loaded.size, ci_registered: MODEL_SCHEMA_V2_CI.length, eia_registered: MODEL_SCHEMA_V2_EIA.length, execution_status: IDENTIFIER_EXECUTION, coverage_kind: MODEL_SCHEMA_V2_COVERAGE_KIND };
}

function validateSchemas(root, paths) {
  const schemaPaths = [...paths].filter((path) => path.includes('/schemas/') && path.endsWith('.schema.json'));
  const hasControlRoot = paths.has('protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json');
  if (schemaPaths.length !== (hasControlRoot ? 66 : 65)) throw new Error('exact schema count mismatch');
  const modelPaths = new Set(Object.keys(MODEL_SCHEMA_V2));
  const ids = new Set();
  for (const path of schemaPaths) {
    const schema = JSON.parse(readFileSync(repoPath(root, path), 'utf8'));
    const expectedDefinition = path === 'protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json' ? '1.0.0-phase2-control-root-nonproduction' : (modelPaths.has(path) ? MODEL_SCHEMA_V2_DEFINITION : '1.0.0-local-rc-v15');
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' || typeof schema.$id !== 'string' || ids.has(schema.$id) || schema['x-clued-definition-version'] !== expectedDefinition || schema.additionalProperties !== false || !Array.isArray(schema.required) || !schema.required.includes('schema_version') || !schema.required.includes('object_type')) throw new Error('invalid generated schema: ' + path);
    ids.add(schema.$id);
  }
  return { count: schemaPaths.length, model_schema_v2: validateModelSchemasV2(root) };
}

function validateApplicability(root, manifest) {
  const proof = JSON.parse(readFileSync(repoPath(root, APPLICABILITY_PATH), 'utf8'));
  requireBindingEqual(proof.intermediate_source, manifest.generated_from.intermediate_source, 'applicability');
  if (proof.provider !== 'none' || proof.authority_effect !== 'NONE' || !claimValid(proof.claim_boundary) || proof.registered_identifier_execution !== IDENTIFIER_EXECUTION || !Array.isArray(proof.n_a_with_proof) || proof.n_a_with_proof.length !== 9) throw new Error('minimum local-RC applicability proof invalid');
  return proof.n_a_with_proof.length;
}

function validateBom(root, bomPath, manifest, requirements) {
  const bom = JSON.parse(readFileSync(resolve(bomPath), 'utf8'));
  const head = git(root, ['rev-parse','HEAD']);
  const tree = git(root, ['rev-parse','HEAD^{tree}']);
  if (bom.source && (bom.source.commit_sha1 !== head || bom.source.tree_sha1 !== tree)) throw new Error('fresh V00 BOM does not bind current commit/tree');
  const req = bom.machine_contract_inputs && bom.machine_contract_inputs.requirements;
  const protocol = bom.machine_contract_inputs && bom.machine_contract_inputs.protocol_manifest;
  const reqBytes = readFileSync(repoPath(root, REQUIREMENTS_PATH));
  const manifestBytes = readFileSync(repoPath(root, MANIFEST_PATH));
  if (!req || req.path !== REQUIREMENTS_PATH || req.sha256 !== 'sha256:' + sha256(reqBytes) || req.registry_status !== 'authoritative' || req.g1_qualified !== true) throw new Error('fresh V00 BOM requirements binding invalid');
  if (!protocol || protocol.path !== MANIFEST_PATH || protocol.sha256 !== 'sha256:' + sha256(manifestBytes) || protocol.content_tree_digest !== manifest.content_tree_digest || protocol.rule_set_digest !== requirements.registry.rule_set_digest) throw new Error('fresh V00 BOM protocol manifest binding invalid');
  if (!bom.authorization_boundary || bom.authorization_boundary.production_authorized !== false || !bom.integrity || bom.integrity.production_trusted !== false) throw new Error('fresh V00 BOM overclaims production');
  if (bom.integrity.signature && bom.integrity.public_key && bom.integrity.content_digest) {
    const copy = structuredClone(bom);
    delete copy.integrity.content_digest;
    delete copy.integrity.signature;
    delete copy.integrity.public_key;
    const payloadDigest = sha256(Buffer.from(canonical(copy)));
    if (bom.integrity.content_digest !== 'sha256:' + payloadDigest || !verifySignature(null, Buffer.from(payloadDigest, 'hex'), createPublicKey(bom.integrity.public_key), Buffer.from(bom.integrity.signature, 'base64'))) throw new Error('fresh V00 BOM signature invalid');
  }
  return { commit: head, tree };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) fail('ARGUMENT_ERROR', '--manifest is required');
  try {
    const root = git(process.cwd(), ['rev-parse','--show-toplevel']);
    if (!args['allow-dirty'] && git(root, ['status','--porcelain=v1']) !== '') throw new Error('Git worktree is not clean; use --allow-dirty only for pre-commit patch validation');
    const manifestPath = resolve(args.manifest);
    const validated = validateManifest(root, manifestPath);
    const sourceProjection = readIntermediateSource(validated.manifest.generated_from.intermediate_source);
    const requirements = validateRequirements(root, validated.manifest, sourceProjection);
    const trace = validateTrace(root, requirements, validated.manifest);
    const schemaValidation = validateSchemas(root, validated.paths);
    const naCount = validateApplicability(root, validated.manifest);
    const generated = validated.manifest.generated_from;
    const pins = {
      commit: generated.baseline_commit,
      tree: generated.baseline_tree,
      memory_tree: generated.baseline_memory_tree,
      protocol_v1_tree: generated.baseline_protocol_v1_tree,
    };
    const explicitPins = {
      commit: args['expected-commit'],
      tree: args['expected-tree'],
      memory_tree: args['expected-memory-tree'],
      protocol_v1_tree: args['expected-protocol-v1-tree'],
    };
    for (const key of Object.keys(explicitPins)) if (explicitPins[key] && explicitPins[key] !== pins[key]) throw new Error('explicit ' + key + ' must equal manifest pin');
    const actual = {
      commit: git(root, ['rev-parse','HEAD']),
      tree: git(root, ['rev-parse','HEAD^{tree}']),
      memory_tree: git(root, ['rev-parse','HEAD:memory']),
      protocol_v1_tree: git(root, ['rev-parse','HEAD:protocol/continuity/v1']),
    };
    for (const key of Object.keys(pins)) if (!/^[0-9a-f]{40}$/.test(pins[key]) || actual[key] !== pins[key]) throw new Error(key + ' changed from manifest pin');
    const bom = args.bom ? validateBom(root, args.bom, validated.manifest, requirements) : null;
    process.stdout.write(JSON.stringify({
      ok: true,
      code: CONTRACT_STATUS,
      validation_scope: 'G1_MACHINE_CONTRACT_GENERATION_AND_STRUCTURE_ONLY',
      manifest_sha256: 'sha256:' + sha256(readFileSync(manifestPath)),
      content_tree_digest: validated.manifest.content_tree_digest,
      rule_set_digest: validated.manifest.rule_set_digest,
      downstream_mapping_digest: validated.manifest.downstream_mapping_digest,
      requirements: 32,
      model_rules: requirements.modelRuleCount,
      schemas: schemaValidation.count,
      model_schema_v2: schemaValidation.model_schema_v2,
      trace,
      na_proofs: naCount,
      repository_pins: pins,
      repository_actual: actual,
      bom,
      registered_identifier_execution: IDENTIFIER_EXECUTION,
      production: false,
      writes: [],
    }) + '\n');
  } catch (error) {
    fail('G1_GENERATED_ARTIFACTS_INVALID', error.message);
  }
}
main();
