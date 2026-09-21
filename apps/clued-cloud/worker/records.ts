export interface RecordFeatureEnv {
  PROJECT_VIEWS_V2?: string;
}

export function recordsV2Enabled(env: RecordFeatureEnv) {
  return /^(1|true|on|enabled)$/i.test(env.PROJECT_VIEWS_V2?.trim() ?? "");
}

export const P6_AUTHORITY_CONFLICT_POLICY = {
  current_fields: ["state", "task", "decision"],
  log_role: "historical_event_evidence_only",
  behavior: "retain_current_and_report_log_conflicts",
  silent_merge: false,
} as const;

export const currentWorkContract = {
  version: "clued-v1.6-m1-k-cont",
  read_order: [
    "global_registry_and_priority",
    "project_state_task_decision",
    "log_and_archive_on_demand",
  ],
  current_truth: ["state", "task", "decision"],
  history_on_demand: ["log", "archive"],
  write_order: ["canonical_entity", "event_and_receipt_same_transaction", "derived_views"],
  canonical_id_field: "id",
  mirror_mode: "query_results_or_stable_id_references",
  mirror_layout: {
    global_directory: "Global",
    project_directory_pattern: "Projects/{canonical_project_id}",
    view_files: ["State.md", "Task.md", "Decision.md", "Archive.md", "Log.md"],
    entry_mode: "query_conclusion_or_stable_id_reference",
    entry_template: "- `{id}` — {title}: {conclusion} [status={status}; version={version}]",
  },
  project_creation: "explicit_confirmation_required",
  idempotency_boundary: "verified_user_and_operation_family",
  event_stream_ordering_enabled: false,
  record_merge_write_enabled: false,
  project_merge_write_enabled: false,
  canonical_export: "authorized_live_recheck",
  double_write: false,
  constraint_marker: "decision.type_fields.constraint=true",
  checkpoint_coverage: "explicit_context_track_and_event_ids",
  unabsorbed_owner_decisions: "remain_pending_until_explicitly_absorbed",
} as const;

export const recordTools = [
  {
    name: "clued_record_list",
    description:
      "Read canonical records at the Global level or for one effective project. Read global priority first, then project State, Task and Decision; use Log or Archive only for history. Every view returns the same canonical id.",
    inputSchema: {
      type: "object",
      required: ["record_type"],
      properties: {
        level: { type: "string", enum: ["global", "project"], default: "global" },
        project_id: { type: "string", format: "uuid" },
        record_type: {
          type: "string",
          enum: ["note", "state", "task", "decision", "archive", "log"],
        },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
        context_key: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_record_mutate",
    description:
      "Create, update, close, restore, or explicitly reclassify one v1.6 Canonical Record with CAS, Evidence authorization, Event, and immutable Receipt. Create requires mutation, source_refs, and source_unavailable_reason; mutation.type_fields requires rationale (decision), state_kind (state), execution_bucket (task), fact_kind (profile_fact), or note_kind (note). Use decision.type_fields.constraint=true for a resident constraint.",
    inputSchema: {
      type: "object",
      required: ["operation", "record_type", "record_schema_version", "lifecycle_status", "scope", "idempotency_key", "authority", "confidence_reason"],
      properties: {
        operation: { type: "string", enum: ["create", "update", "close", "restore", "reclassify_scope"] },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        id: { type: "string", format: "uuid" },
        record_type: { type: "string", enum: ["state", "task", "decision", "profile_fact", "note"] },
        record_schema_version: { type: "integer", const: 1 },
        lifecycle_status: { type: "string", enum: ["active", "completed", "cancelled", "archived", "revoked"] },
        scope: { type: "string", pattern: "^(profile|global|project:[0-9a-fA-F-]{36})$" },
        base_version: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        source_refs: { type: "array", uniqueItems: true, items: { type: "string", format: "uuid" } },
        source_unavailable_reason: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
        mutation: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            type_fields: { type: "object" },
            relations: { type: "object" },
            closure_summary: { type: "string" },
            closed_reason: { type: "string" },
          },
          additionalProperties: false,
        },
        reclassification_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
        authority: { type: "string", enum: ["user_explicit", "observed", "inferred", "imported"] },
        user_confirmed: { type: "boolean" },
        observed_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
        confidence: { anyOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] },
        confidence_reason: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_decision_supersede",
    description: "Atomically replace one or more active Decisions using multi-target CAS.",
    inputSchema: { type: "object", required: ["source_decisions", "replacement", "supersede_reason", "idempotency_key"], properties: {
      source_decisions: { type: "array", minItems: 1, items: { type: "object" } }, replacement: { type: "object" },
      supersede_reason: { type: "string", minLength: 1 }, idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
      request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" }, user_confirmed: { type: "boolean" },
    }, additionalProperties: false },
  },
  {
    name: "clued_evidence_ingest",
    description: "Ingest private Evidence and its committed Receipt atomically; standalone ingest emits no work Event.",
    inputSchema: { type: "object", required: ["evidence_schema_version", "evidence_type", "storage_ref", "content_hash", "idempotency_key"], properties: {
      evidence_id: { type: "string", format: "uuid" }, evidence_schema_version: { type: "integer", const: 1 },
      evidence_type: { type: "string", enum: ["user_quote", "file", "image", "web_ref", "test_output", "legacy_document"] },
      storage_ref: { type: "string", minLength: 1, maxLength: 1000 }, content_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      mime_type: { anyOf: [{ type: "string" }, { type: "null" }] }, size_bytes: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }, captured_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      idempotency_key: { type: "string", minLength: 8, maxLength: 160 }, request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    }, additionalProperties: false },
  },
  {
    name: "clued_event_append",
    description: "Append an authorized extension Event without mutating a business entity; built-in business Event types are server-only.",
    inputSchema: { type: "object", required: ["event_schema_version", "event_type", "event_scope", "idempotency_key"], properties: {
      event_schema_version: { type: "integer", const: 1 }, event_type: { type: "string", pattern: "^extension:[a-z0-9_.-]+:[a-z0-9_.-]+$" },
      event_scope: { type: "string", pattern: "^(profile|global|project:[0-9a-fA-F-]{36})$" }, target_refs: { type: "array" }, change_summary: { anyOf: [{ type: "array" }, { type: "null" }] },
      audit_visibility: { type: "string", enum: ["audit_only", "work_log"] }, evidence_refs: { type: "array", items: { type: "string", format: "uuid" } }, artifact_refs: { type: "array" },
      idempotency_key: { type: "string", minLength: 8, maxLength: 160 }, request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    }, additionalProperties: false },
  },
  {
    name: "clued_canonical_export",
    description: "Create a Receipt-backed Canonical Export for live recheck; legacy rows remain explicit compatibility envelopes.",
    inputSchema: { type: "object", required: ["idempotency_key"], properties: {
      idempotency_key: { type: "string", minLength: 8, maxLength: 160 }, request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    }, additionalProperties: false },
  },
] as const;

export const recordRpcByTool = {
  clued_record_list: "clued_record_list",
  clued_record_mutate: "clued_record_mutate",
  clued_decision_supersede: "clued_decision_supersede",
  clued_evidence_ingest: "clued_evidence_ingest",
  clued_event_append: "clued_event_append",
  clued_canonical_export: "clued_canonical_export",
} as const;

export type UserRecordRpc = "clued_user_record_list" | "clued_user_record_mutate" |
  "clued_user_decision_supersede" | "clued_user_evidence_ingest" | "clued_user_event_append" |
  "clued_user_canonical_export";
