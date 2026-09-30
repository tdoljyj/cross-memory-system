/** Agent transport only: Canonical jobs RPC remains the authorization authority.
 * No credential, admission, grant-management or raw provider tool is exposed. */
type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const idSchema = { type: "string", format: "uuid" };
const reference = { connection_id: idSchema, job_id: { ...idSchema, description: "Stable caller-created job UUID. Keep it for the same request, including after a lost reply; never create another ID to retry an unknown effect." } };
const destination = { type: "string", minLength: 1, maxLength: 1000, description: "Exact destination under the connection's registered root. A path is a requested target, never authority to change the registered profile." };
const source = { type: "string", minLength: 1, maxLength: 1000, description: "Exact current path of a file Clued registered (one it created) under the registered root." };
const sourceVersion = { type: "string", pattern: "^[1-9][0-9]{0,39}$", description: "The file's Drive version as last observed with clued_storage_browse stat. If the file changed since, the job is refused; stat it again first. If it is refused again with the version stat returns, Clued's registered version is older than Drive's and only the Owner can re-register the file; do not retry." };
const targetVersion = { type: "string", pattern: "^[1-9][0-9]{0,39}$", description: "The target file's Drive version as last observed with clued_storage_browse stat; a changed file is refused." };
const pathParent = (path: string) => path.slice(0, path.lastIndexOf("/"));
const pathName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const storageAgentTools = [
  {
    name: "clued_storage_submit",
    description: "Submit an explicitly authorized storage job using this client's existing Clued Binding and an Owner-granted storage permission. context:write is insufficient. create makes a new file or directory. rename (same folder, new name) and move (new folder, same name) apply to one file Clued registered and need the Owner's modify level. replace overwrites one registered text file with new content (at most 1 MiB), or with restore_job_id restores the content that an earlier committed replace job kept; both need the Owner's overwrite level, and the previous content is kept as a Drive revision. Reuse job_id and identical payload for correlation; queued/started/uncertain is NOT completion. On a lost reply inspect the same job; never re-dispatch with another ID. Policy, single-use admission and provider execution remain server-owned. No directory move or delete.",
    inputSchema: {
      type: "object", required: ["connection_id", "job_id", "mutation"], additionalProperties: false,
      properties: { ...reference, mutation: { oneOf: [
        { type: "object", required: ["operation", "target_kind", "destination_path", "content"], additionalProperties: false,
          properties: { operation: { const: "create" }, target_kind: { const: "file" }, destination_path: destination,
            content: { type: "string", maxLength: 1048576, description: "UTF-8 text; the full JSON request must also fit the transport size limit. Binary upload is not supported." } } },
        { type: "object", required: ["operation", "target_kind", "destination_path", "directory_semantics"], additionalProperties: false,
          properties: { operation: { const: "create" }, target_kind: { const: "directory" }, destination_path: destination,
            directory_semantics: { type: "string", enum: ["topic", "asset_collection"] } } },
        { type: "object", required: ["operation", "target_kind", "source_path", "destination_path", "source_file_version"], additionalProperties: false,
          properties: { operation: { enum: ["rename", "move"] }, target_kind: { const: "file" }, source_path: source,
            destination_path: destination, source_file_version: sourceVersion } },
        { type: "object", required: ["operation", "target_kind", "destination_path", "destination_file_version", "content"], additionalProperties: false,
          properties: { operation: { const: "replace" }, target_kind: { const: "file" }, destination_path: destination,
            destination_file_version: targetVersion,
            content: { type: "string", maxLength: 1048576, description: "The complete new UTF-8 text of the file." } } },
        { type: "object", required: ["operation", "target_kind", "destination_path", "destination_file_version", "restore_job_id"], additionalProperties: false,
          properties: { operation: { const: "replace" }, target_kind: { const: "file" }, destination_path: destination,
            destination_file_version: targetVersion,
            restore_job_id: { ...idSchema, description: "A committed replace job of this file whose kept previous content is restored (revert)." } } },
      ] } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { "clued/requiredStorageGrant": ["create_file, create_topic, modify or overwrite"], "clued/scopeEnforcement": "server-side" },
  },
  {
    name: "clued_storage_inspect",
    description: "Read one account storage job's status and receipt using an Owner-granted inspect permission on this client's Binding. This does not read file contents, resume execution, refresh credentials or clear an unresolved fence. Keep the original job_id after a lost reply.",
    inputSchema: { type: "object", required: ["connection_id", "job_id"], properties: reference, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { "clued/requiredStorageGrant": ["inspect"], "clued/scopeEnforcement": "server-side" },
  },
].map(tool => ({ ...tool, outputSchema: { type: "object", additionalProperties: true } }));

export function isStorageAgentTool(name: unknown): name is "clued_storage_submit" | "clued_storage_inspect" {
  return name === "clued_storage_submit" || name === "clued_storage_inspect";
}

export function storageAgentInput(name: "clued_storage_submit" | "clued_storage_inspect", args: unknown): Data {
  const fail = () => { throw new Error("storage_job_input_invalid"); };
  if (!object(args) || !uuid(args.connection_id) || !uuid(args.job_id)) return fail();
  const submit = name === "clued_storage_submit";
  if (Object.keys(args).some(k => !["connection_id", "job_id", ...(submit ? ["mutation"] : [])].includes(k))) return fail();
  if (submit) {
    const m = args.mutation;
    if (!object(m) || typeof m.destination_path !== "string" ||
      m.destination_path.length < 1 || m.destination_path.length > 1000) return fail();
    const allowed = ["operation", "target_kind", "destination_path"];
    if (m.operation === "rename" || m.operation === "move") {
      // Shape only; the server re-validates it and the registered source.
      if (m.target_kind !== "file" || typeof m.source_path !== "string" || m.source_path.length < 1 || m.source_path.length > 1000 ||
        typeof m.source_file_version !== "string" || !/^[1-9][0-9]{0,39}$/.test(m.source_file_version)) return fail();
      const sameParent = pathParent(m.source_path) === pathParent(m.destination_path);
      const sameName = pathName(m.source_path) === pathName(m.destination_path);
      if (m.operation === "rename" ? !sameParent || sameName : sameParent || !sameName) return fail();
      allowed.push("source_path", "source_file_version");
    } else if (m.operation === "replace") {
      if (m.target_kind !== "file" || typeof m.destination_file_version !== "string" ||
        !/^[1-9][0-9]{0,39}$/.test(m.destination_file_version) || ("content" in m) === ("restore_job_id" in m)) return fail();
      if ("content" in m && (typeof m.content !== "string" || new TextEncoder().encode(m.content).length > 1048576)) return fail();
      if ("restore_job_id" in m && !uuid(m.restore_job_id)) return fail();
      allowed.push("destination_file_version", "content" in m ? "content" : "restore_job_id");
    } else if (m.operation !== "create") return fail();
    else if (m.target_kind === "file") {
      allowed.push("content");
      if (typeof m.content !== "string" || new TextEncoder().encode(m.content).length > 1048576) return fail();
    } else if (m.target_kind === "directory") {
      allowed.push("directory_semantics");
      if (m.directory_semantics !== "topic" && m.directory_semantics !== "asset_collection") return fail();
    } else return fail();
    if (Object.keys(m).some(k => !allowed.includes(k))) return fail();
  }
  return { ...args, action: submit ? "submit" : "inspect" };
}

/** Do not let future private RPC fields become public tool output by accident. */
export function storageAgentResult(value: unknown, input: Data): Data {
  if (!object(value) || value.job_id !== input.job_id || value.connection_id !== input.connection_id ||
    value.execution_permitted !== false || typeof value.request_digest !== "string" || !/^[0-9a-f]{64}$/.test(value.request_digest) ||
    !uuid(value.receipt_id) || (value.intent_id !== null && !uuid(value.intent_id)) ||
    !["queued", "prepared", "started", "uncertain", "committed", "cancelled", "denied", "attention_required"].includes(String(value.status)) ||
    ("replayed" in value && typeof value.replayed !== "boolean")) throw new Error("storage_job_response_invalid");
  return Object.fromEntries(["job_id", "connection_id", "request_digest", "status", "intent_id", "receipt_id", "execution_permitted", "replayed"]
    .filter(key => key in value).map(key => [key, value[key]]));
}
