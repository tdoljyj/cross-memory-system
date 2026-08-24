export interface RecordFeatureEnv {
  PROJECT_VIEWS_V2?: string;
}

export function recordsV2Enabled(env: RecordFeatureEnv) {
  return /^(1|true|on|enabled)$/i.test(env.PROJECT_VIEWS_V2?.trim() ?? "");
}

export const currentWorkContract = {
  version: "two-level-five-view-v1",
  read_order: [
    "global_registry_and_priority",
    "project_state_task_decision",
    "log_and_archive_on_demand",
  ],
  current_truth: ["state", "task", "decision"],
  history_on_demand: ["log", "archive"],
  write_order: [
    "canonical_record",
    "event_and_receipt_same_transaction",
    "derived_views",
  ],
  canonical_id_field: "id",
  mirror_mode: "query_results_or_stable_id_references",
  mirror_layout: {
    global_directory: "Global",
    project_directory_pattern: "Projects/{canonical_project_id}",
    view_files: ["State.md", "Task.md", "Decision.md", "Archive.md", "Log.md"],
    entry_mode: "query_conclusion_or_stable_id_reference",
  },
  project_creation: "explicit_confirmation_required",
  double_write: false,
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
    name: "clued_record_write",
    description:
      "Write once through Clued's canonical transactional core. The same transaction emits Event and Receipt, and derived views reflect the result; never dual-write a Markdown copy. Requires an idempotency key and expected_version for mutations.",
    inputSchema: {
      type: "object",
      required: ["action", "idempotency_key"],
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "update",
            "archive",
            "restore",
            "supersede_decision",
            "complete_task_and_advance_state",
          ],
        },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        expected_version: { type: "integer", minimum: 1 },
        record_id: { type: "string", format: "uuid" },
        record_type: {
          type: "string",
          enum: ["note", "state", "task", "decision", "archive_snapshot"],
        },
        scope: { type: "string", enum: ["global", "project"] },
        project_id: { type: "string", format: "uuid" },
        title: { type: "string", minLength: 1, maxLength: 120 },
        content: { type: "string", minLength: 1, maxLength: 8000 },
        record_key: { type: "string", minLength: 1, maxLength: 160 },
        status: { type: "string" },
        priority: { type: "integer", minimum: 0, maximum: 100 },
        source_ref: { type: "string", maxLength: 500 },
        state_id: { type: "string", format: "uuid" },
        next_task_id: { type: "string", format: "uuid" },
        state_content: { type: "string", maxLength: 8000 },
        context_key: { type: "string" },
      },
      additionalProperties: false,
    },
  },
] as const;

export const recordRpcByTool = {
  clued_record_list: "clued_record_list",
  clued_record_write: "clued_record_write",
} as const;

export type UserRecordRpc = "clued_user_record_list" | "clued_user_record_write";
