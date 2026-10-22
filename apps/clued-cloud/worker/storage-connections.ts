/** Storage connection discovery (Owner Decision 1721045d): the connections this client's
 * Binding may use, so an Agent never has to ask the Owner for a connection_id. Read-only;
 * the database lists a connection only when the same evaluators the storage tools use admit
 * this Binding, and every storage call still checks its own grant when it runs. */
type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITE_LEVELS = ["create_file", "create_topic", "modify", "overwrite", "modify_subtree", "destructive"];
const READ_CLASSES = ["read", "read_content"];
const ENTRY_KEYS = ["connection_id", "inspect", "managed_root", "name", "normal_use", "project_id", "read", "tracks", "write_levels"].join(",");

/** The connection_id parameter of every storage tool: where it comes from, so no Agent asks the Owner. */
export const connectionIdSchema = { type: "string", format: "uuid",
  description: "The storage connection's ID, from clued_storage_connections. Never ask the user for it." };

export const storageConnectionsTool = {
  name: "clued_storage_connections",
  description: "List the Clued storage connections this client may use, with the connection_id that every other clued_storage_* tool takes. " +
    "Call it whenever you need a connection_id; never ask the user for one, it is an internal ID they should not need to know. " +
    "Each entry names the root folder (name, the folder name the Owner knows it by, and managed_root, its registered path, or null when that path is only a Drive ID), " +
    "its project_id, its tracks (the root's top-level folders), " +
    "inspect (clued_storage_inspect is allowed), the write_levels the Owner granted (create_file, create_topic, modify, overwrite, modify_subtree, destructive), " +
    "the read classes (read: clued_storage_browse; read_content: clued_storage_read) and normal_use. " +
    "Pick the connection whose name or managed_root matches the storage the user named; when several match, ask the user to choose by name, never by ID. " +
    "Address files with paths relative to the root (for example 90_待归类/note.md), which every storage tool accepts. " +
    "An empty list means the Owner has not authorized this client for any storage, and a missing level means the Owner has not granted it: " +
    "tell the user what to turn on, and for which storage, on the Clued storage page. " +
    "The list is not an admission: each storage call still checks its own grant. Reads only; writes nothing.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { "clued/scopeEnforcement": "server-side" },
  outputSchema: { type: "object", additionalProperties: true },
};

export class StorageConnectionsError extends Error {
  constructor(readonly code: "storage_connections_input_invalid" | "storage_connections_unavailable") { super(code); }
}

export function storageConnectionsInput(args: unknown) {
  if (args !== undefined && args !== null && (!object(args) || Object.keys(args).length > 0)) throw new StorageConnectionsError("storage_connections_input_invalid");
}

const strings = (value: unknown, allowed?: string[]) => Array.isArray(value) &&
  value.every(item => typeof item === "string" && item.length > 0 && item.length <= 1000 && (!allowed || allowed.includes(item))) &&
  new Set(value).size === value.length;

/** Exact projection of the database answer. reads/writes false blank the classes whose tools this
 * deployment does not offer, so the list never names a tool the client cannot call. */
export function storageConnectionsResult(value: unknown, offered: { reads: boolean; writes: boolean }) {
  if (!object(value) || value.contract !== "clued.storage-connections/1" || typeof value.complete !== "boolean" ||
    !Array.isArray(value.connections) || value.connections.length > 50) throw new StorageConnectionsError("storage_connections_unavailable");
  const connections = value.connections.map(item => {
    if (!object(item) || Object.keys(item).sort().join(",") !== ENTRY_KEYS || typeof item.connection_id !== "string" || !uuid.test(item.connection_id) ||
      typeof item.name !== "string" || item.name.length < 1 || item.name.length > 1000 ||
      (item.managed_root !== null && (typeof item.managed_root !== "string" || item.managed_root.length < 1 || item.managed_root.length > 4096)) ||
      typeof item.project_id !== "string" || !uuid.test(item.project_id) || !strings(item.tracks) ||
      typeof item.inspect !== "boolean" || !strings(item.write_levels, WRITE_LEVELS) || !strings(item.read, READ_CLASSES) ||
      typeof item.normal_use !== "boolean") throw new StorageConnectionsError("storage_connections_unavailable");
    return { connection_id: item.connection_id, name: item.name, managed_root: item.managed_root as string | null, project_id: item.project_id,
      tracks: item.tracks as string[],
      inspect: offered.writes && item.inspect, write_levels: offered.writes ? item.write_levels as string[] : [],
      read: offered.reads ? item.read as string[] : [], normal_use: offered.reads && item.normal_use };
  }).filter(item => item.inspect || item.write_levels.length > 0 || item.read.length > 0);
  return { contract: "clued.storage-connections/1", connections, complete: value.complete };
}

export const storageConnectionsMessages = {
  storage_connections_input_invalid: "clued_storage_connections takes no arguments.",
  storage_connections_unavailable: "Storage connections are unavailable right now. Do not ask the user for a connection_id; try again later, or tell the user that BeamingFace storage could not be reached.",
} as const;
