export const PROJECT_CONTEXT_KEY = "system:projects";

export const projectTools = [
  {
    name: "clued_project_mutate",
    description:
      "Create, update, complete, archive, or restore one v1.6 Canonical Project with CAS, Event, and immutable Receipt. Project merge writes are not enabled.",
    inputSchema: {
      type: "object",
      required: ["operation", "project_schema_version", "idempotency_key"],
      properties: {
        operation: { type: "string", enum: ["create", "update", "complete", "archive", "restore"] },
        canonical_project_id: { type: "string", format: "uuid" },
        project_schema_version: { type: "integer", const: 1 },
        base_version: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        mutation: { type: "object" },
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
] as const;

export const projectRpcByTool = {
  clued_project_mutate: "clued_project_mutate",
  clued_project_list: "clued_project_list",
} as const;

export type ProjectToolName = keyof typeof projectRpcByTool;

export function isProjectTool(value: string): value is ProjectToolName {
  return value in projectRpcByTool;
}
