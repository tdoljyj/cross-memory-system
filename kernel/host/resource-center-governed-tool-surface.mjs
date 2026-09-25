export const RESOURCE_CENTER_MUTATION_TOOL = "clued_resource_center_mutate";
export const RESOURCE_CENTER_BOUNDARY_SCAN_TOOL = "clued_resource_center_scan_boundary";

const MUTATION_CALLER_FIELDS = new Set([
  "operation",
  "source_path",
  "destination_path",
  "target_kind",
  "directory_semantics",
  "duplicate_bytes",
  "content",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

const mutationInputSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["operation"],
  properties: {
    operation: { type: "string", enum: ["create", "write", "move", "rename", "replace", "delete"] },
    source_path: { type: "string", minLength: 1 },
    destination_path: { type: "string", minLength: 1 },
    target_kind: { type: "string", enum: ["file", "directory"] },
    directory_semantics: { type: "string", enum: ["track", "topic", "asset_collection"] },
    duplicate_bytes: { type: "boolean" },
    content: { type: "string" },
  },
});

const scanInputSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

const tools = deepFreeze([
  {
    name: RESOURCE_CENTER_MUTATION_TOOL,
    description: "Execute one Resource Center mutation through Host-owned preflight, admission and commit.",
    inputSchema: mutationInputSchema,
  },
  {
    name: RESOURCE_CENTER_BOUNDARY_SCAN_TOOL,
    description: "Deterministically scan registered Resource Center boundary roots for unauthorized Clued material.",
    inputSchema: scanInputSchema,
  },
]);
export const RESOURCE_CENTER_GOVERNED_TOOL_MANIFEST = tools;

function invalidArguments(details = {}) {
  return {
    status: "deny",
    error_code: "CONTROLLED_TOOL_ARGUMENTS_INVALID",
    ...details,
  };
}

function snapshotCallerArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidArguments();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const name of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[name];
    if (!MUTATION_CALLER_FIELDS.has(name)) return invalidArguments({ field: name });
    if (!descriptor.enumerable || typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      return invalidArguments({ field: name });
    }
    const item = descriptor.value;
    if (item !== null && !["string", "boolean", "number"].includes(typeof item)) {
      return invalidArguments({ field: name });
    }
    result[name] = item;
  }
  if (typeof result.operation !== "string") return invalidArguments({ field: "operation" });
  return Object.freeze(result);
}

/**
 * Exposes the only transport-callable Resource Center mutation surface.
 * The opaque admission and raw adapter never cross this boundary.
 */
export function createResourceCenterGovernedToolSurface({ adapter } = {}) {
  if (!adapter || typeof adapter.guardedMutation !== "function" || typeof adapter.scanBoundary !== "function") {
    throw new TypeError("A governed Resource Center adapter is required.");
  }

  async function callTool(name, args = {}) {
    if (name === RESOURCE_CENTER_MUTATION_TOOL) {
      const snapshot = snapshotCallerArguments(args);
      if (snapshot.status === "deny") return snapshot;
      return adapter.guardedMutation(Object.freeze({
        ...snapshot,
        artifact_role: "clued_resource",
      }));
    }
    if (name === RESOURCE_CENTER_BOUNDARY_SCAN_TOOL) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0) {
        return invalidArguments();
      }
      return adapter.scanBoundary();
    }
    return {
      status: "deny",
      error_code: "CONTROLLED_TOOL_NOT_FOUND",
      tool: name,
    };
  }

  return Object.freeze({
    profile_identity: adapter.profile_identity,
    listTools: () => tools,
    callTool,
  });
}
