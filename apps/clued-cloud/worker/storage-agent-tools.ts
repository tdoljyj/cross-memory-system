/** Agent transport only: Canonical jobs RPC remains the authorization authority.
 * No credential, admission, grant-management or raw provider tool is exposed. */
type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const idSchema = { type: "string", format: "uuid" };
const reference = { connection_id: idSchema, job_id: { ...idSchema, description: "Stable caller-created job UUID. Keep it for the same request, including after a lost reply; never create another ID to retry an unknown effect." } };
const pathForms = "Either relative to the connection's registered root (for example 90_待归类/note.md, the same form clued_storage_browse resolve takes) or the full path under that root; both name the same target and give the same job. No empty, '.' or '..' segments, trailing '/' or backslash; an absolute path outside the root is refused (storage_path_outside_root).";
const destination = { type: "string", minLength: 1, maxLength: 1000, description: `Destination under the connection's registered root. ${pathForms} A path is a requested target, never authority to change the registered profile.` };
const source = { type: "string", minLength: 1, maxLength: 1000, description: `Current path of a file Clued registered (one it created) under the registered root. ${pathForms}` };
const sourceVersion = { type: "string", pattern: "^[1-9][0-9]{0,39}$", description: "The file's Drive version as last observed with clued_storage_browse stat. If the file changed since, the job is refused; stat it again first. If it is refused again with the version stat returns, Clued's registered version is older than Drive's and only the Owner can re-register the file; do not retry." };
const targetVersion = { type: "string", pattern: "^[1-9][0-9]{0,39}$", description: "The target file's Drive version as last observed with clued_storage_browse stat; a changed file is refused." };
const binaryMime = { type: "string", minLength: 3, maxLength: 255, description: "MIME type bound to the destination extension (png, jpg/jpeg, gif, webp, pdf, zip, docx, xlsx, pptx, odt, ods, odp; legacy doc/xls/ppt and macro-carrying packages are refused)." };
const binarySha = { type: "string", pattern: "^[0-9a-f]{64}$", description: "sha256 of the exact file bytes; Clued checks it on staging and against Drive's checksum after the write." };
const pathParent = (path: string) => path.lastIndexOf("/") < 0 ? "" : path.slice(0, path.lastIndexOf("/"));
const pathName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** Relative to the registered root: no leading "/" or "\\", drive prefix or scheme. */
const relativePath = (path: string) => !/^([/\\]|[A-Za-z]:|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(path);

/** Fixed path refusals. The database canonicalizes a relative path to the full path under the
 * connection's managed root before the request digest (20260930233000_storage_relative_paths_v1)
 * and decides outside-root; the Worker refuses the syntax early with the same code. */
export type StoragePathCode = "storage_path_invalid" | "storage_path_outside_root";
export const storagePathMessages: Record<StoragePathCode, string> = {
  storage_path_invalid: "The path is not valid. Use a path relative to the connection's registered root (for example 90_待归类/note.md) or the full path under it, with no empty, '.' or '..' segments, no trailing '/' and no backslash. Retrying the same path will not help.",
  storage_path_outside_root: "The path is absolute but not under the connection's registered root. Use a path relative to the root (for example 90_待归类/note.md) or the full path under it. Retrying the same path will not help.",
};
export function storagePathCode(error: unknown): StoragePathCode | null {
  const message = error instanceof Error ? error.message : "";
  return message === "storage_path_invalid" || message === "storage_path_outside_root" ? message : null;
}
/** Syntax only (the root is known to the database): the same segment rules as storage_path_canonical_v1. */
export function storagePathSyntaxValid(path: string): boolean {
  return path.length >= 1 && path.length <= 1000 && !/(^|\/)\.{1,2}(\/|$)/.test(path) && !path.includes("//") &&
    !path.endsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/.test(path);
}

export const storageAgentTools = [
  {
    name: "clued_storage_submit",
    description: "Submit an explicitly authorized storage job using this client's existing Clued Binding and an Owner-granted storage permission. context:write is insufficient. create makes a new file or directory. rename (same folder, new name) and move (new folder, same name) apply to one file Clued registered and need the Owner's modify level. replace overwrites one registered text file with new content (at most 1 MiB), or with restore_job_id restores the content that an earlier committed replace job kept; both need the Owner's overwrite level, and the previous content is kept as a Drive revision. Reuse job_id and identical payload for correlation; queued/started/uncertain is NOT completion. On a lost reply inspect the same job; never re-dispatch with another ID. destination_path and source_path may be relative to the connection's registered root (90_待归类/note.md) or full paths under it; a malformed or outside-root path is refused at submit with storage_path_invalid or storage_path_outside_root, before any job exists. Policy, single-use admission and provider execution remain server-owned. No directory move or delete.",
    inputSchema: {
      type: "object", required: ["connection_id", "job_id", "mutation"], additionalProperties: false,
      properties: { ...reference, mutation: { oneOf: [
        { type: "object", required: ["operation", "target_kind", "destination_path", "content"], additionalProperties: false,
          properties: { operation: { const: "create" }, target_kind: { const: "file" }, destination_path: destination,
            content: { type: "string", maxLength: 1048576, description: "UTF-8 text, stored as text/plain; the full JSON request must also fit the transport size limit. HTML and SVG are accepted only this way." } } },
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
    description: "Read one account storage job's status and receipt using an Owner-granted inspect permission on this client's Binding. A denied or attention_required job may carry a fixed reason_code (for example UNAUTHORIZED_WORKSPACE_MUTATION); details stay with the Owner. This does not read file contents, resume execution, refresh credentials or clear an unresolved fence. Keep the original job_id after a lost reply.",
    inputSchema: { type: "object", required: ["connection_id", "job_id"], properties: reference, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { "clued/requiredStorageGrant": ["inspect"], "clued/scopeEnforcement": "server-side" },
  },
].map(tool => ({ ...tool, outputSchema: { type: "object", additionalProperties: true } }));

// StorageNormalUse N3: published only when binary upload is configured (CLUED_STORAGE_BINARY_V1).
const binaryVariants = [
  { type: "object", required: ["operation", "target_kind", "destination_path", "mime_type", "content_sha256", "staging_id"], additionalProperties: false,
    properties: { operation: { const: "create" }, target_kind: { const: "file" }, destination_path: destination,
      mime_type: binaryMime, content_sha256: binarySha,
      staging_id: { ...idSchema, description: "The staging_id returned by clued_storage_upload_begin after the PUT succeeded; destination_path, mime_type and content_sha256 must repeat the declared values." } } },
  { type: "object", required: ["operation", "target_kind", "destination_path", "mime_type", "content_sha256", "content_base64"], additionalProperties: false,
    properties: { operation: { const: "create" }, target_kind: { const: "file" }, destination_path: destination,
      mime_type: binaryMime, content_sha256: binarySha,
      content_base64: { type: "string", maxLength: 1048576, description: "Standard base64 of the file bytes, for clients without a shell; the whole JSON request must fit in 1 MiB (about 700 KiB of file)." } } },
];
const binaryNote = " A binary file (images, PDF, zip, OOXML/ODF Office files, at most 20 MiB) needs the Owner's create_file level with normal use, and is sent either as staging_id from clued_storage_upload_begin or inline as content_base64 (whole request at most 1 MiB), with mime_type and content_sha256. Legacy Office (doc, xls, ppt), macro-enabled Office files, packages declaring VBA, ActiveX or macro sheets, executables, scripts, HTML and SVG are refused in binary form. Files the Owner uploaded by hand cannot be renamed, moved or deleted.";

export function storageAgentToolsFor(binary: boolean) {
  if (!binary) return storageAgentTools;
  return storageAgentTools.map(tool => tool.name !== "clued_storage_submit" ? tool : {
    ...tool, description: tool.description + binaryNote,
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
      mutation: { oneOf: [...(tool.inputSchema.properties as { mutation: { oneOf: unknown[] } }).mutation.oneOf, ...binaryVariants] } } },
  });
}

/** Storage agent tools whose authority is the Owner's storage grant (checked by the storage RPC),
 * not a context scope. clued_storage_upload_begin (N3) belongs here too: delegated OAuth uses this
 * predicate to require no context scope for it; the continuity router handles it before submit/inspect. */
export function isStorageAgentTool(name: unknown): name is "clued_storage_submit" | "clued_storage_inspect" | "clued_storage_upload_begin" {
  return name === "clued_storage_submit" || name === "clued_storage_inspect" || name === "clued_storage_upload_begin";
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
    if (!storagePathSyntaxValid(m.destination_path) || (typeof m.source_path === "string" && !storagePathSyntaxValid(m.source_path)))
      throw new Error("storage_path_invalid");
    const allowed = ["operation", "target_kind", "destination_path"];
    if (m.operation === "rename" || m.operation === "move") {
      // Shape only; the server re-validates it and the registered source.
      if (m.target_kind !== "file" || typeof m.source_path !== "string" || m.source_path.length < 1 || m.source_path.length > 1000 ||
        typeof m.source_file_version !== "string" || !/^[1-9][0-9]{0,39}$/.test(m.source_file_version)) return fail();
      // Parents are comparable here only when both paths use the same form; the database
      // re-checks rename/move after both are canonicalized to full paths.
      const sameName = pathName(m.source_path) === pathName(m.destination_path);
      if (relativePath(m.source_path) === relativePath(m.destination_path)) {
        const sameParent = pathParent(m.source_path) === pathParent(m.destination_path);
        if (m.operation === "rename" ? !sameParent || sameName : sameParent || !sameName) return fail();
      } else if (m.operation === "rename" ? sameName : !sameName) return fail();
      allowed.push("source_path", "source_file_version");
    } else if (m.operation === "replace") {
      if (m.target_kind !== "file" || typeof m.destination_file_version !== "string" ||
        !/^[1-9][0-9]{0,39}$/.test(m.destination_file_version) || ("content" in m) === ("restore_job_id" in m)) return fail();
      if ("content" in m && (typeof m.content !== "string" || new TextEncoder().encode(m.content).length > 1048576)) return fail();
      if ("restore_job_id" in m && !uuid(m.restore_job_id)) return fail();
      allowed.push("destination_file_version", "content" in m ? "content" : "restore_job_id");
    } else if (m.operation !== "create") return fail();
    else if (m.target_kind === "file" && ("staging_id" in m || "content_base64" in m)) {
      // Binary create (N3): shape only here; staging, gate and type checks are server-owned.
      if (("staging_id" in m) === ("content_base64" in m) || "content" in m || typeof m.mime_type !== "string" ||
        m.mime_type.length < 3 || m.mime_type.length > 255 || typeof m.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.content_sha256) ||
        ("staging_id" in m && !uuid(m.staging_id)) ||
        ("content_base64" in m && (typeof m.content_base64 !== "string" || m.content_base64.length > 1048576))) return fail();
      allowed.push("mime_type", "content_sha256", "staging_id" in m ? "staging_id" : "content_base64");
    }
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
    ("replayed" in value && typeof value.replayed !== "boolean") ||
    // Only the fixed reason code of a pre-reservation outcome; its findings stay in the Owner's row.
    ("reason_code" in value && (typeof value.reason_code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value.reason_code) ||
      (value.status !== "denied" && value.status !== "attention_required")))) throw new Error("storage_job_response_invalid");
  return Object.fromEntries(["job_id", "connection_id", "request_digest", "status", "intent_id", "receipt_id", "execution_permitted", "replayed", "reason_code"]
    .filter(key => key in value).map(key => [key, value[key]]));
}
