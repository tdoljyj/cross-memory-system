export const PROJECT_CONTEXT_KEY = "system:projects";

export const projectTools = [
  {
    name: "clued_project_mutate",
    description:
      "Create, update, complete, archive, or restore one Project Lifecycle v2 Canonical Project with CAS, Event, and immutable Receipt. Recognition metadata is evidence, not a lifecycle state. Project merge writes are not enabled.",
    inputSchema: {
      type: "object",
      required: ["operation", "project_schema_version", "idempotency_key"],
      properties: {
        operation: { type: "string", enum: ["create", "update", "complete", "archive", "restore"] },
        canonical_project_id: { type: "string", format: "uuid" },
        project_schema_version: { type: "integer", const: 2 },
        base_version: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        idempotency_key: { type: "string", minLength: 8, maxLength: 160 },
        request_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        mutation: { type: "object" },
        recognition: {
          type: "object",
          properties: {
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string", minLength: 1, maxLength: 500 },
            source: { type: "string", enum: ["v2_explicit_create", "v2_agent_recognition"] },
            source_refs: { type: "array", uniqueItems: true, items: { type: "string", format: "uuid" } },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clued_project_list",
    description:
      "List the user's recognized canonical Projects, optionally filtering work progress. Recognition metadata and legacy certainty compatibility fields are not exposed. Dismissed and merged records are hidden by default.",
    inputSchema: {
      type: "object",
      properties: {
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
  clued_project_mutate: "clued_project_mutate_v2",
  clued_project_list: "clued_project_list_v2",
} as const;

export type ProjectToolName = keyof typeof projectRpcByTool;

export function isProjectTool(value: string): value is ProjectToolName {
  return value in projectRpcByTool;
}
