import { ownerApprovalInputSchema, ownerApprovalOutputSchema } from './model-reference-owner-schema.mjs';
// Integration candidate. Default flags expose no tools or routes. Enabling a
// flag is a reviewed deployment action; registration, grants and qualification
// must be completed independently. This module cannot issue Domain Authority.
export interface ModelDomainFeatureEnv {
  CLUED_MODEL_DOMAIN_SOURCE_V1?: string;
  CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1?: string;
}

export const MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL = "clued_model_reference_owner_approval_refs";
export const MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL = "clued_model_dataset_split_owner_anchor_refs";
export const MODEL_DOMAIN_REFS_TOOL = "clued_model_dataset_split_resolve_refs";
export const MODEL_DOMAIN_VERIFY_TOOL = "clued_model_dataset_split_verify";
export const MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL = "clued_model_dataset_split_bootstrap_request";
export const MODEL_DOMAIN_PLAN_PREPARATION_TOOL = "clued_model_dataset_split_prepare_plan";
export const MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL = "clued_model_dataset_split_verify_successor";
export const MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL = "clued_model_dataset_split_bootstrap_readiness";
export const MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL = "clued_model_dataset_split_bootstrap_commit";
export type ModelDomainToolName = typeof MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL | typeof MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL | typeof MODEL_DOMAIN_REFS_TOOL | typeof MODEL_DOMAIN_VERIFY_TOOL |
  typeof MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL | typeof MODEL_DOMAIN_PLAN_PREPARATION_TOOL | typeof MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL | typeof MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL | typeof MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL;

export function isModelDomainTool(name: unknown): name is ModelDomainToolName {
  return name === MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL || name === MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL || name === MODEL_DOMAIN_REFS_TOOL || name === MODEL_DOMAIN_VERIFY_TOOL || name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL || name === MODEL_DOMAIN_PLAN_PREPARATION_TOOL || name === MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL || name === MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL || name === MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL;
}
export function modelDomainSourceEnabled(env: ModelDomainFeatureEnv) {
  return env.CLUED_MODEL_DOMAIN_SOURCE_V1 === "true";
}
export function modelDomainBootstrapRequestEnabled(env: ModelDomainFeatureEnv) {
  return modelDomainSourceEnabled(env) && env.CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1 === "true";
}

const uuid = { type: "string", format: "uuid" } as const;
const canonicalRef = {
  type: "object", properties: { id: uuid, version: { type: "integer", minimum: 1 },
    content_hash: { type: "string", pattern: "^[0-9a-f]{64}$" } },
  required: ["id", "version", "content_hash"], additionalProperties: false,
} as const;
export const modelDomainTools = [
  {
    name: MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL,
    description: "Read only a new exact Owner experiment-approval Decision/Receipt/Event chain in fixed Project0597 and Task1502 for PC M1_FIXED_REFERENCE QUALIFICATION. This same authorized Binding is admitted with context:read before Canonical rows. Recomputes the full M1 server hash, Currentness, private Actor and exact request/operation/window/budget semantics. Returns exactly 16 actor-free/body-free verified reference/status fields; no opaque Host source_ref, Actor DTO, record body or token. This read never issues an ExperimentProfile, grants model permission, consumes an attempt, invokes Native or writes Canonical data. Host integration uses a distinct actor-free bridge and is not compatible with the old raw-Actor reader protocol.",
    inputSchema: ownerApprovalInputSchema, outputSchema: ownerApprovalOutputSchema,
  },
  {
    name: MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL,
    description: "Read only the two fixed Owner Decision anchor references in the fixed Model Program Project through this same authorized Binding. Returns exact id/version/full Record server content hash and projection-only markers. No caller selector, actor, raw Record or authority proof is accepted. This call never submits an Owner request, grants permission or invokes a Canonical/M1 writer; it does not resolve historical hash semantics or issue M2 qualification.",
    inputSchema: { type: "object", properties: { schema: { type: "string", const: "clued.model-owner-anchor-refs/1" } }, additionalProperties: false },
  },
  {
    name: MODEL_DOMAIN_REFS_TOOL,
    description: "Resolve only three existing DatasetSplit projection references in the fixed Model Program Project. Returns id/version/server content hash, with no domain permission, actor, record body or M2 verdict. The same authorized Binding is verified by the server.",
    inputSchema: { type: "object", properties: { permission_record_id: uuid, producer_registration_id: uuid,
      recognition_record_id: uuid }, required: ["permission_record_id", "producer_registration_id", "recognition_record_id"], additionalProperties: false },
  },
  {
    name: MODEL_DOMAIN_VERIFY_TOOL,
    description: "Verify existing DatasetSplit source references in the fixed Model Program Project. Requires separately registered Native verify/recognize/producer grants for this same Binding and Task before Canonical reads. Returns only minimal recognition references; it does not issue domain authority, M2 acceptance or training permission. This legacy projection reader does not validate the successor actor-free M1 templates.",
    inputSchema: { type: "object", properties: { permission_record_ref: canonicalRef, producer_registration_ref: canonicalRef,
      recognition_record_ref: canonicalRef, recognition_receipt_id: uuid }, required: ["permission_record_ref", "producer_registration_ref", "recognition_record_ref", "recognition_receipt_id"], additionalProperties: false },
  },
  {
    name: MODEL_DOMAIN_PLAN_PREPARATION_TOOL,
    description: "Prepare one uncommitted, unauthorized DatasetSplit bootstrap plan proposal inside this same authenticated Request/Binding. Reads only the two fixed Owner anchors through the protected source RPC, then generates three proposed target IDs and exact plan bytes/hash. Accepts no caller refs, actor, transport, scope, grant or clock. Each call generates a distinct proposal; save and reuse its returned bytes rather than call again for a retry. No Native request, permission, Canonical/M1 write, SQL installation, DomainAuthority or M2 verdict is issued. An immutable reviewed Git binding and a separate exact Native approval remain required before any write.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL,
    description: "Verify existing actor-free DatasetSplit M1 projection references using this same Binding and Task through a separate successor source RPC. Requires the separately registered Native verify/recognize/producer grants before Canonical reads. Verifies private real M1 Actor/Receipt/Event chains and fixed Owner anchors server-side; returns only minimal recognition references. No legacy fallback, private Actor, record body, domain authority, DataGate, M2 acceptance or training permission is returned.",
    inputSchema: { type: "object", properties: { permission_record_ref: canonicalRef, producer_registration_ref: canonicalRef,
      recognition_record_ref: canonicalRef, recognition_receipt_id: uuid }, required: ["permission_record_ref", "producer_registration_ref", "recognition_record_ref", "recognition_receipt_id"], additionalProperties: false },
  },
  {
    name: MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL,
    description: "Create only a Native Owner approval request for a proposed non-production DatasetSplit bootstrap. Resolves the two fixed Owner Decision anchors using this same Binding and sends their actual server hashes, three exact proposed target IDs and immutable Git plan reference through the existing clued_owner_request entry. Returns that entry's confirm_url; the Owner must approve in Native. This call never invokes M1 or creates Canonical records. Actual M1 execution requires the separate installed, Native-gated atomic commit tool; this request tool never writes projections.",
    inputSchema: { type: "object", properties: { producer_record_id: uuid, permission_record_id: uuid, recognition_record_id: uuid,
      idempotency_key: { type: "string", minLength: 8, maxLength: 100 }, immutable_plan_resource: { type: "string",
        pattern: "^repo:tdoljyj/cross-memory-system/[0-9a-f]{40}/development/contracts/model-program/stage-admission/[A-Za-z0-9_.-]+\\.json$" } },
      required: ["producer_record_id", "permission_record_id", "recognition_record_id", "idempotency_key", "immutable_plan_resource"], additionalProperties: false },
  },
  {
    name: MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL,
    description: "Read only the installed immutable DatasetSplit plan and two fixed Owner source chains through this same Binding. Recomputes complete server Record hashes and verifies private M1 Receipt/Event chains; returns minimal references and readiness only. Accepts no selector, Actor, scope, grant, proof or clock. It grants no bootstrap, DomainAuthority, DataGate, M2 or training permission.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL,
    description: "Create only the three fixed non-production DatasetSplit M1 definition projections in one database transaction. Requires a separately approved exact Native single-use bootstrap grant, installed immutable plan, current same-Binding Task claim/fence and all three declared Record targets. Verifies fixed Owner chains and preserves private Actor data. No Kernel DomainAuthority, DataGate, M2 or model/training permission is issued. Completion uncertainty must be inspected with the original receipts and target IDs; never automatically retry or regenerate a plan.",
    inputSchema: { type: "object", properties: { owner_adoption_server_ref: canonicalRef, final_recognizer_server_ref: canonicalRef,
      producer_record_id: uuid, permission_record_id: uuid, recognition_record_id: uuid,
      idempotency_key: { type: "string", minLength: 8, maxLength: 100 }, immutable_plan_resource: { type: "string",
        pattern: "^repo:tdoljyj/cross-memory-system/[0-9a-f]{40}/development/contracts/model-program/stage-admission/[A-Za-z0-9_.-]+\\.json$" } },
      required: ["owner_adoption_server_ref", "final_recognizer_server_ref", "producer_record_id", "permission_record_id",
        "recognition_record_id", "idempotency_key", "immutable_plan_resource"], additionalProperties: false },
  },
] as const;
export const modelDomainToolPolicies = {
  [MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL]: { scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  [MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL]: { scopes: ["context:read", "context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  [MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL]: { scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  [MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL]: { scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  [MODEL_DOMAIN_REFS_TOOL]: { scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  [MODEL_DOMAIN_VERIFY_TOOL]: { scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  [MODEL_DOMAIN_PLAN_PREPARATION_TOOL]: { scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  [MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL]: { scopes: ["context:read"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  [MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL]: { scopes: ["context:read", "context:write"], readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
} as const;
