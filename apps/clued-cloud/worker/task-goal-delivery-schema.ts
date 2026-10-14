/** Optional metadata on the existing Canonical Task. Qualification and all
 * execution/Owner authority remain server-owned; these fields grant neither. */
const identifier = { type: "string", pattern: "^[A-Za-z0-9_.-]{1,80}$", minLength: 1, maxLength: 80 } as const;
const uuid = { type: "string", format: "uuid" } as const;
const sha256 = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const scope = { type: "string", pattern: "^(global|project:[0-9a-fA-F-]{36})$" } as const;
const namedInput = { label: { type: "string", minLength: 1, maxLength: 200 } } as const;

export const taskWorkflowSchema = {
  type: "object",
  description: "Opt a schema-1 Task into goal and file-delivery completion checks. This marker cannot subsequently be removed. The server derives goal_version from the Task ID, scope, title/body and this definition (excluding delivery_refs). Read that version and definition through clued_record_list or clued_search_context; never invent it. Authorized delivery metadata supplies existing file locators and immutable Receipts after each linked source's permission and current registry are rechecked. Goal/body/input changes make old delivery refs and Owner acceptance stale. These fields do not grant execution or storage permission. Machine mode proves the agreed archived bytes and current registered file version, not fresh provider head or semantic quality. Owner mode needs actual Native Owner acceptance; user_confirmed cannot manufacture it. Business/physical effects remain unsupported for completion.",
  required: ["contract", "goal", "scope", "completion_level", "input_versions", "acceptance_mode", "conditions", "deliverables", "delivery_refs"],
  additionalProperties: false,
  properties: {
    contract: { type: "string", const: "clued.task-goal-delivery/1" },
    goal: { type: "string", minLength: 1, maxLength: 4000 },
    scope: { type: "string", minLength: 1, maxLength: 4000 },
    completion_level: { type: "string", enum: ["artifact", "business_effect", "physical_effect"] },
    input_versions: { type: "array", maxItems: 16, items: { oneOf: [
      { type: "object", additionalProperties: false, required: ["label", "kind", "id", "version", "scope"],
        properties: { ...namedInput, kind: { const: "record" }, id: uuid, version: { type: "integer", minimum: 1 }, scope } },
      { type: "object", additionalProperties: false, required: ["label", "kind", "id", "version"],
        properties: { ...namedInput, kind: { const: "artifact" }, id: uuid, version: { type: "integer", minimum: 1 } } },
      { type: "object", additionalProperties: false, required: ["label", "kind", "version"],
        properties: { ...namedInput, kind: { const: "declared" }, version: { type: "string", minLength: 1, maxLength: 200 } },
        description: "User-declared external input version, not independently verified. Only owner acceptance mode can acknowledge this limitation." },
    ] } },
    acceptance_mode: { type: "string", enum: ["machine", "owner"] },
    conditions: { type: "array", minItems: 1, maxItems: 16, items: {
      type: "object", additionalProperties: false, required: ["id", "text", "kind"], properties: {
        id: identifier, text: { type: "string", minLength: 1, maxLength: 1000 },
        kind: { type: "string", enum: ["file_integrity", "owner_review"] }, deliverable_id: identifier,
      },
    } },
    deliverables: { type: "array", minItems: 1, maxItems: 16, items: {
      type: "object", additionalProperties: false, required: ["id", "label", "required"], properties: {
        id: identifier, label: { type: "string", minLength: 1, maxLength: 200 }, required: { type: "boolean" },
        path: { type: "string", minLength: 1, maxLength: 1000 }, mime_type: { type: "string", minLength: 3, maxLength: 255 }, sha256,
      },
      description: "Expected criteria, never proof. At least one file must be required. A MIME criterion needs trusted verified MIME; missing MIME is unknown. Renditions cannot replace the original byte identity.",
    } },
    delivery_refs: { type: "array", maxItems: 16, items: {
      type: "object", additionalProperties: false, required: ["deliverable_id", "job_id", "goal_version"], properties: {
        deliverable_id: identifier, job_id: uuid, goal_version: sha256,
      },
      description: "Bind one existing authorized Storage job to a deliverable and exact server goal_version. The server reads its immutable proof and current registry; caller success, links or hashes are not verification. Queued/unknown jobs cannot complete a required delivery. Old refs may remain as explicitly stale history.",
    } },
  },
} as const;
