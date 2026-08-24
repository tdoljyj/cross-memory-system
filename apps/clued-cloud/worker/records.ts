export interface RecordFeatureEnv {
  PROJECT_VIEWS_V2?: string;
}

export function recordsV2Enabled(env: RecordFeatureEnv) {
  return /^(1|true|on|enabled)$/i.test(env.PROJECT_VIEWS_V2?.trim() ?? "");
}

export const recordTools = [
  {
    name: "clued_record_list",
    description:
      "Read one of Clued's State, Task, Decision, Archive or Log views at the Global level or for one effective project. All record views preserve canonical IDs.",
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
      "Write through Clued's single transactional record core. Requires an idempotency key and expected_version for mutations.",
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
