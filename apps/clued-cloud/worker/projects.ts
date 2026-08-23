export const PROJECT_CONTEXT_KEY = "system:projects";

export const projectTools = [
  {
    name: "clued_project_observe",
    description:
      "Observe a project mention. Use possible for an implied project (created as unconfirmed), confirmed for explicit intent or material work (promotes the same record), and ignore for one-off or third-party mentions.",
    inputSchema: {
      type: "object",
      required: ["name", "intent", "idempotency_key"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        intent: { type: "string", enum: ["possible", "confirmed", "ignore"] },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        summary: { type: "string", maxLength: 2000 },
        evidence_summary: { type: "string", maxLength: 500 },
        source_ref: { type: "string", maxLength: 160 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        aliases: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 120 },
        },
        progress_status: {
          type: "string",
          enum: ["not_started", "active", "paused", "completed", "archived"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_project_list",
    description:
      "List the user's canonical projects, independently filtering certainty and work progress. Dismissed and merged records are hidden by default.",
    inputSchema: {
      type: "object",
      properties: {
        certainty_status: { type: "string", enum: ["unconfirmed", "confirmed"] },
        progress_status: {
          type: "string",
          enum: ["not_started", "active", "paused", "completed", "archived"],
        },
        include_dismissed: { type: "boolean", default: false },
        query: { type: "string", maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_project_update",
    description:
      "Confirm, rename, dismiss, restore, change progress, or merge a project. Promotion preserves the project id and context key.",
    inputSchema: {
      type: "object",
      required: ["project_id", "action", "idempotency_key"],
      properties: {
        project_id: { type: "string", format: "uuid" },
        action: {
          type: "string",
          enum: ["confirm", "rename", "dismiss", "restore", "set_progress", "merge"],
        },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        target_project_id: { type: "string", format: "uuid" },
        name: { type: "string", minLength: 1, maxLength: 120 },
        progress_status: {
          type: "string",
          enum: ["not_started", "active", "paused", "completed", "archived"],
        },
        summary: { type: "string", maxLength: 2000 },
        base_version: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
] as const;

export const projectRpcByTool = {
  clued_project_observe: "clued_project_observe",
  clued_project_list: "clued_project_list",
  clued_project_update: "clued_project_update",
} as const;

export type ProjectToolName = keyof typeof projectRpcByTool;

export function isProjectTool(value: string): value is ProjectToolName {
  return value in projectRpcByTool;
}

