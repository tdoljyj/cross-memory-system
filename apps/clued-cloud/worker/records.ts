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
  version: "clued-v1.6-m1-k-cont-project-v2",
  read_order: [
    "global_registry_and_priority",
    "project_state_task_decision",
    "log_and_archive_on_demand",
  ],
  current_truth: ["state", "task", "decision"],
  context_architecture: "clued-context-v2",
  standard_work_projection: ["state", "task", "decision", "archive", "log"],
  projection_levels: ["global", "project"],
  online_authority: "authenticated_canonical_service",
  current_sources: ["canonical_records", "active_event_truth_carriers"],
  task_execution_body: "canonical_task_only",
  state_next_action: "derived_task_reference_only",
  frontier_action: "versioned_task_rendering_with_currentness_and_authorization",
  checkpoint_authority: "continuity_only_reconcile_required",
  archive_authority: "terminal_lifecycle_projection_same_identity",
  log_authority: "history_view_event_carrier_authority_is_separate",
  request_idempotency_is_semantic_deduplication: false,
  semantic_intent_publication: "requires_verified_stable_relation_or_fail_closed",
  execution_authorization: "revalidate_at_actual_operation",
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
  project_creation: "recognition_decision_then_create",
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
      "Read canonical records at the Global level or for one effective project. By default, only records proven current by the shared server Currentness Core are returned; an active Event remains a separate search_context current source. Set include_history=true explicitly for historical or diagnostic records, which are not authoritative current rows. Read global priority first, then project State, Task and Decision; use Log or Archive only for history. Every view returns the same canonical id.",
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
        include_history: { type: "boolean", default: false, description: "Explicit history/diagnostic view; shadowed records are non-authoritative." },
        context_key: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_record_mutate",
    description:
      "Create, update, close, restore, or explicitly reclassify one v1.6 Canonical Record with CAS, Evidence authorization, Event, and immutable Receipt. authority=user_explicit requires user_confirmed=true only when the user explicitly confirmed this exact record; otherwise use the actual observed/inferred authority. Create requires mutation, source_refs, and source_unavailable_reason; mutation.type_fields requires rationale (decision), state_kind (state), execution_bucket (task), fact_kind (profile_fact), or note_kind (note). execution_bucket accepts only now, next, blocked, later. The database requires the other four keys but imposes no value enum: use a rationale explaining the decision, state_kind=manual for a manual State, fact_kind=preference for a preference, or note_kind=log for a follow-up note. On an existing record, mutation.type_fields and mutation.relations merge into the stored top-level keys: omitted keys are kept and a key sent as null is removed; field_mode=replace replaces each object sent whole. Restore requires explicit user confirmation, a reason, and the current terminal Receipt ID. Use decision.type_fields.constraint=true for a resident constraint. source_refs accepts Evidence IDs only ([] when there are none), never Record IDs; relations.supersedes changes only through clued_decision_supersede.",
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
        field_mode: { type: "string", enum: ["merge", "replace"] },
        source_refs: { type: "array", uniqueItems: true, items: { type: "string", format: "uuid" }, description: "Evidence IDs only ([] when there are none). A Record ID is rejected as evidence_not_authorized." },
        source_unavailable_reason: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
        mutation: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            type_fields: { type: "object", description: "Create requires the key for record_type. Only execution_bucket has a database value enum; other required keys have no value enum.", properties: {
              execution_bucket: { type: "string", enum: ["now", "next", "blocked", "later"], description: "Required for task." },
              rationale: { description: "Required for decision; explain the decision. No database value enum." },
              state_kind: { description: "Required for state; manual is used for a manual State. No database value enum." },
              fact_kind: { description: "Required for profile_fact; preference is used for a preference. No database value enum." },
              note_kind: { description: "Required for note; log is used for a follow-up note. No database value enum." },
            } },
            relations: { type: "object" },
            closure_summary: { type: "string" },
            closed_reason: { type: "string" },
          },
          additionalProperties: false,
        },
        reclassification_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
        reopen_reason: { type: "string", minLength: 1, maxLength: 1000 },
        terminal_receipt_id: { type: "string", format: "uuid" },
        authority: { type: "string", enum: ["user_explicit", "observed", "inferred", "imported"] },
        user_confirmed: { type: "boolean", description: "Must be true with authority=user_explicit, only when the user explicitly confirmed this exact record." },
        observed_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
        confidence: { anyOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] },
        confidence_reason: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_decision_supersede",
    description:
      "Atomically replace one or more active Decisions using multi-target CAS. source_decisions names each active Decision to retire with its current version as base_version; all must share one scope. replacement is the new Decision created in the same transaction and needs the same fields as a clued_record_mutate create: record_schema_version 1, the sources' scope, title, content, type_fields.rationale, relations.supersedes equal to the set of source_decisions ids, source_refs (Evidence IDs only, [] when there are none; a Record ID is rejected as evidence_not_authorized), source_unavailable_reason (string or null) and authority; authority=user_explicit requires top-level user_confirmed=true. A replacement that omits record_schema_version, scope or authority is rejected (replacement_record_schema_version_required, replacement_scope_required, invalid_authority) and no source Decision is closed.",
    inputSchema: { type: "object", required: ["source_decisions", "replacement", "supersede_reason", "idempotency_key"], properties: {
      source_decisions: {
        type: "array", minItems: 1, maxItems: 100, description: "Active Decisions to supersede; all must share one scope.",
        items: { type: "object", required: ["id", "base_version"], properties: {
          id: { type: "string", format: "uuid" },
          base_version: { type: "integer", minimum: 1, description: "The source Decision's current version (CAS)." },
        } },
      },
      replacement: {
        type: "object",
        description: "The new Decision. Same shape as a clued_record_mutate create, flattened: record fields next to the mutation fields.",
        required: ["record_schema_version", "scope", "title", "content", "type_fields", "relations", "source_refs", "source_unavailable_reason", "authority"],
        properties: {
          id: { type: "string", format: "uuid" },
          record_schema_version: { type: "integer", const: 1 },
          scope: { type: "string", pattern: "^(profile|global|project:[0-9a-fA-F-]{36})$", description: "Must equal the scope of every source Decision." },
          title: { type: "string" },
          content: { type: "string" },
          type_fields: { type: "object", required: ["rationale"], properties: {
            rationale: { description: "Required; explain the decision. No database value enum." },
            constraint: { type: "boolean", description: "true marks a resident constraint." },
          } },
          relations: { type: "object", required: ["supersedes"], properties: {
            supersedes: { type: "array", uniqueItems: true, items: { type: "string", format: "uuid" }, description: "Must equal the set of source_decisions ids (supersedes_set_mismatch otherwise)." },
          } },
          source_refs: { type: "array", uniqueItems: true, items: { type: "string", format: "uuid" }, description: "Evidence IDs only ([] when there are none). A Record ID is rejected as evidence_not_authorized." },
          source_unavailable_reason: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
          authority: { type: "string", enum: ["user_explicit", "observed", "inferred", "imported"] },
          observed_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
          confidence: { anyOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] },
          confidence_reason: { type: "string" },
        },
      },
      supersede_reason: { type: "string", minLength: 1 }, idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
      request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      user_confirmed: { type: "boolean", description: "Must be true with replacement.authority=user_explicit, only when the user explicitly confirmed this exact record." },
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
  clued_canonical_export: "clued_canonical_export_v2",
} as const;

export type UserRecordRpc = "clued_user_record_list" | "clued_user_record_mutate" |
  "clued_user_decision_supersede" | "clued_user_evidence_ingest" | "clued_user_event_append" |
  "clued_user_canonical_export_v2";
