import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageGoogleMetadataBatch } from "./storage-google-metadata-batch";
import { createStorageFetch } from "./storage-fetch";

/** StorageFullCapability.v0.1 P1: read level only (list / stat / search /
 * resolve). No body read, no write, no scope change. Every call is admitted by
 * the Canonical read evaluator, which commits an intent receipt BEFORE any
 * provider request; the receipt is finalized in `finally`, including failures.
 * Root scope is decided here by provider-ID parent chains, never by names. */
type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fileId = /^[A-Za-z0-9_-]{1,160}$/;
const scopes = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const FOLDER = "application/vnd.google-apps.folder", SHORTCUT = "application/vnd.google-apps.shortcut";
const PAGE = 200, MAX_DEPTH = 32, SEARCH_CHUNK = 32, SEARCH_ROUNDS = 8, SEARCH_RESULTS = 200, QUEUE_LIMIT = 256;
// §5.3 provider budget: batch HTTP requests per call. Search stops early with
// a cursor; list/stat/resolve fail closed rather than exceed it.
const SUBREQUEST_BUDGET = 50, SEARCH_RESERVE = 10;
const CURSOR_TTL_MS = 3600000;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });

export class StorageReadError extends Error {
  constructor(readonly code: "storage_read_input_invalid" | "storage_read_unavailable" | "not_found_in_scope" | "cursor_invalid") { super(code); }
}
function fail(code: StorageReadError["code"]): never { throw new StorageReadError(code); }

export const storageReadTool = {
  name: "clued_storage_browse",
  description: "Look inside an Owner-authorized storage root through this client's Clued Binding and an Owner-granted read level. " +
    "Operations: list a folder (default: the root), stat one object, search by name or MIME type inside the root, or resolve a Drive link, ID or root-relative path. " +
    "Returns metadata only, never file bodies. Anything outside the root, and anything missing, is reported the same way (not_found_in_scope); " +
    "not finding something is not proof it does not exist. complete:false means results are partial: continue with next_cursor.",
  inputSchema: {
    type: "object", required: ["connection_id", "operation"], additionalProperties: false,
    properties: {
      connection_id: { type: "string", format: "uuid" },
      operation: { type: "string", enum: ["list", "stat", "search", "resolve"] },
      folder_id: { type: "string", description: "list: folder inside the root; omit for the root itself." },
      object_id: { type: "string", description: "stat: Drive object ID." },
      name_contains: { type: "string", minLength: 1, maxLength: 200, description: "search: case-insensitive name substring." },
      mime_type: { type: "string", minLength: 1, maxLength: 200, description: "search: exact MIME type." },
      within: { type: "string", description: "search: start folder inside the root; default the root." },
      reference: { type: "string", minLength: 1, maxLength: 2000, description: "resolve: Drive link, object ID, or path relative to the root (a/b/c)." },
      cursor: { type: "string", maxLength: 24000, description: "list/search: next_cursor from the previous page, unchanged." },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: { "clued/requiredStorageClass": "read", "clued/scopeEnforcement": "server-side" },
  outputSchema: { type: "object", additionalProperties: true },
};

type Input = {
  connection_id: string; operation: "list" | "stat" | "search" | "resolve";
  folder_id?: string; object_id?: string; name_contains?: string; mime_type?: string; within?: string; reference?: string; cursor?: string;
};
const allowed: Record<Input["operation"], string[]> = {
  list: ["folder_id", "cursor"], stat: ["object_id"], search: ["name_contains", "mime_type", "within", "cursor"], resolve: ["reference"],
};
export function storageReadInput(args: unknown): Input {
  if (!object(args) || typeof args.connection_id !== "string" || !uuid.test(args.connection_id) ||
    typeof args.operation !== "string" || !Object.hasOwn(allowed, args.operation)) fail("storage_read_input_invalid");
  const input = args as Data, op = input.operation as Input["operation"];
  if (Object.keys(input).some(k => !["connection_id", "operation", ...allowed[op]].includes(k))) fail("storage_read_input_invalid");
  for (const k of ["folder_id", "object_id", "within"]) if (k in input && (typeof input[k] !== "string" || !fileId.test(String(input[k])))) fail("storage_read_input_invalid");
  for (const [k, max] of [["name_contains", 200], ["mime_type", 200], ["reference", 2000], ["cursor", 24000]] as const)
    if (k in input && (typeof input[k] !== "string" || !String(input[k]).length || String(input[k]).length > max || /[\u0000-\u001f]/.test(String(input[k]))))
      fail("storage_read_input_invalid");
  if (op === "stat" && !input.object_id) fail("storage_read_input_invalid");
  if (op === "resolve" && !input.reference) fail("storage_read_input_invalid");
  if (op === "search" && !input.name_contains && !input.mime_type) fail("storage_read_input_invalid");
  return input as Input;
}

// Canonical JSON so equal conditions always produce equal HMACs and AADs.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64 = (text: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) fail("cursor_invalid");
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
};
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, "0")).join("");
function key32(text: unknown): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string") fail("storage_read_unavailable");
  const bytes = Uint8Array.from(atob(String(text)), c => c.charCodeAt(0));
  if (bytes.length !== 32) fail("storage_read_unavailable");
  return bytes;
}

type Item = { id: string; name: string; mime_type: string; kind: "folder" | "shortcut" | "file"; parents: string[];
  size?: string; version?: string; sha256?: string; trashed?: boolean };
function item(raw: Data, rootId: string): Item {
  const mime = String(raw.mimeType ?? "");
  const kind = mime === FOLDER ? "folder" : mime === SHORTCUT ? "shortcut" : "file";
  const parents = Array.isArray(raw.parents) ? raw.parents.filter((p): p is string => typeof p === "string") : [];
  return { id: String(raw.id), name: String(raw.name ?? ""), mime_type: mime, kind,
    parents: raw.id === rootId ? [] : parents,
    ...(typeof raw.size === "string" ? { size: raw.size } : {}), ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    ...(typeof raw.sha256Checksum === "string" ? { sha256: raw.sha256Checksum } : {}), ...(raw.trashed === true ? { trashed: true } : {}) };
}
const valid = (raw: unknown): raw is Data => object(raw) && typeof raw.id === "string" && fileId.test(raw.id) &&
  typeof raw.name === "string" && typeof raw.mimeType === "string" && Array.isArray(raw.parents);

export async function createStorageReadAgent(config: {
  client_id: string; vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: Data) => Promise<Data>; receipt_keys: unknown; cursor_key: unknown;
  fetch?: typeof fetch; clock?: () => number;
}) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id)) fail("storage_read_unavailable");
  const vault = await createStorageCredentialVault(config.vault);
  const clock = config.clock ?? Date.now;
  const ring = config.receipt_keys;
  if (!object(ring) || typeof ring.current !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(ring.current) || !object(ring.keys)) fail("storage_read_unavailable");
  const receiptRing = ring as { current: string; keys: Data };
  const receiptKey = await crypto.subtle.importKey("raw", key32(receiptRing.keys[receiptRing.current]), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const cursorKey = await crypto.subtle.importKey("raw", key32(config.cursor_key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

  // Domain-separated per connection (which belongs to exactly one owner).
  const conditionHmac = async (connection: string, condition: Data) => hex(await crypto.subtle.sign("HMAC", receiptKey,
    encoder.encode("clued.storage-read/1\u0000" + connection + "\u0000condition\u0000" + canonical(condition))));
  const aad = (bind: Data) => encoder.encode("clued.storage-read-cursor/1\u0000" + canonical(bind));
  const seal = async (bind: Data, state: Data) => {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(bind) }, cursorKey,
      encoder.encode(JSON.stringify({ ...state, exp: clock() + CURSOR_TTL_MS }))));
    return b64(nonce) + "." + b64(sealed);
  };
  const open = async (cursor: string, bind: Data): Promise<Data> => {
    const [nonce, body, extra] = cursor.split(".");
    if (!nonce || !body || extra !== undefined) fail("cursor_invalid");
    let state: unknown;
    try {
      state = JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(nonce), additionalData: aad(bind) }, cursorKey, unb64(body))));
    } catch { return fail("cursor_invalid"); }
    if (!object(state) || !Number.isFinite(state.exp) || Number(state.exp) < clock()) fail("cursor_invalid");
    return state as Data;
  };

  return Object.freeze({ async run(token_hash: string, raw: unknown) {
    const input = storageReadInput(raw);
    const condition: Data = input.operation === "search" ? { name_contains: input.name_contains, mime_type: input.mime_type, within: input.within }
      : input.operation === "resolve" ? { reference: input.reference } : {};
    const hmac = Object.values(condition).some(v => v !== undefined) ? await conditionHmac(input.connection_id, condition) : null;
    const objectId = input.operation === "stat" ? input.object_id : input.operation === "list" ? input.folder_id : input.operation === "search" ? input.within : undefined;
    let admitted: Data = {};
    try {
      admitted = await config.rpc({ token_hash, input: { action: "admit", connection_id: input.connection_id, operation: input.operation,
        ...(objectId ? { object_id: objectId } : {}), ...(hmac ? { condition_hmac: hmac, key_id: receiptRing.current } : {}) } });
    } catch { return fail("storage_read_unavailable"); }
    let count = 0, complete = false;
    try {
      // Validated inside try so that any admitted intent is still finalized.
      if (admitted.contract !== "clued.storage-read-admission/1" || !uuid.test(String(admitted.receipt_id)) || admitted.class !== "read" ||
        admitted.connection_id !== input.connection_id || admitted.oauth_client_id !== config.client_id || !uuid.test(String(admitted.owner_id)) ||
        !uuid.test(String(admitted.binding_id)) || typeof admitted.root_folder_id !== "string" || !fileId.test(admitted.root_folder_id) ||
        typeof admitted.provider_subject !== "string" || !Number.isSafeInteger(admitted.credential_version) ||
        !Number.isSafeInteger(admitted.read_generation)) fail("storage_read_unavailable");
      const rootId = String(admitted.root_folder_id);
      // Cursors are bound to the exact Binding, not only the connection.
      const bind = { connection_id: input.connection_id, binding_id: admitted.binding_id, read_generation: admitted.read_generation, root: rootId,
        operation: input.operation, condition: hmac ?? "", folder: input.operation === "list" ? (input.folder_id ?? rootId) : "" };
      const context: StorageCredentialContext = { owner_id: String(admitted.owner_id), connection_id: input.connection_id, provider: "google-drive",
        provider_subject: String(admitted.provider_subject), oauth_client_id: config.client_id, credential_version: Number(admitted.credential_version) };
      let token: unknown;
      try { token = JSON.parse(await vault.open(admitted.credential_envelope as StorageCredentialEnvelope, context)); }
      catch { return fail("storage_read_unavailable"); }
      if (!object(token) || token.token_type !== "Bearer" || typeof token.access_token !== "string" || token.access_token.length < 16 ||
        typeof token.scope !== "string" || [...new Set(token.scope.split(/\s+/))].sort().join(" ") !== scopes ||
        !Number.isFinite(token.expires_at_ms) || Number(token.expires_at_ms) - clock() <= 60000) fail("storage_read_unavailable");
      let used = 0;
      const base = createStorageFetch(config.fetch);
      const budgeted: typeof fetch = async (url, init) => {
        if (++used > SUBREQUEST_BUDGET) throw new Error("DRIVE_READ_BUDGET");
        return base(url, init);
      };
      const drive = createStorageGoogleMetadataBatch({ access_token: String(token.access_token), fetch: budgeted, signal: AbortSignal.timeout(25000) });

      // Parent-chain root scope (§5.2): every chain of every object must reach
      // the root by provider ID within MAX_DEPTH; otherwise out of scope.
      const known = new Map<string, Data>(), missing404 = new Set<string>();
      const fetchAll = async (ids: string[]) => {
        const missing = [...new Set(ids)].filter(id => !known.has(id) && !missing404.has(id) && id !== rootId);
        for (let i = 0; i < missing.length; i += 1024) {
          const chunk = missing.slice(i, i + 1024);
          // Isolating 404s costs one request per ID; only for small batches.
          const isolate = chunk.length <= 8;
          let values: unknown[];
          try { values = await drive.getFiles(chunk); }
          catch (error) {
            // A missing or invisible object is out of scope, like one outside
            // the root. A batch fails as a whole, so isolate each ID once.
            if (!(error instanceof Error && error.message === "DRIVE_BATCH_HTTP_404") || !isolate) return fail("storage_read_unavailable");
            values = [];
            for (const id of chunk) {
              try { values.push(...await drive.getFiles([id])); }
              catch (single) {
                if (single instanceof Error && single.message === "DRIVE_BATCH_HTTP_404") { missing404.add(id); continue; }
                return fail("storage_read_unavailable");
              }
            }
          }
          values.forEach(v => { if (!valid(v)) fail("storage_read_unavailable"); known.set(String(v.id), v); });
        }
      };
      const inRoot = async (ids: string[]): Promise<Set<string>> => {
        const verdict = new Map<string, boolean>([[rootId, true]]);
        let frontier = [...new Set(ids)];
        for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
          await fetchAll(frontier);
          frontier = frontier.flatMap(id => id === rootId ? [] : (known.get(id)?.parents as string[] ?? []));
          frontier = frontier.filter(id => !verdict.has(id) && fileId.test(id));
        }
        const decide = (id: string, seen: Set<string>): boolean => {
          if (verdict.has(id)) return verdict.get(id)!;
          const raw = known.get(id);
          if (!raw || seen.has(id) || seen.size > MAX_DEPTH) { verdict.set(id, false); return false; }
          const parents = raw.parents as string[];
          const next = new Set(seen).add(id);
          const ok = parents.length > 0 && parents.every(p => decide(p, next));
          verdict.set(id, ok); return ok;
        };
        return new Set(ids.filter(id => decide(id, new Set())));
      };
      const children = async (folders: string[]) => {
        try { return await drive.listFolders(folders); } catch { return fail("storage_read_unavailable"); }
      };
      // A child of an in-root folder is in root unless another parent leads out.
      const scopedChildren = async (lists: unknown[][]) => {
        const all = lists.flat().filter(valid) as Data[];
        if (all.length !== lists.flat().length) fail("storage_read_unavailable");
        all.forEach(raw => known.set(String(raw.id), raw));
        const multi = all.filter(raw => (raw.parents as string[]).length > 1).map(raw => String(raw.id));
        const okMulti = multi.length ? await inRoot(multi) : new Set<string>();
        return lists.map(list => (list as Data[]).filter(raw => (raw.parents as string[]).length <= 1 || okMulti.has(String(raw.id))));
      };
      const byName = (a: Item, b: Item) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

      if (input.operation === "stat") {
        const id = String(input.object_id);
        if (!(await inRoot([id])).has(id)) fail("not_found_in_scope");
        await fetchAll([id]);
        const found = id === rootId ? null : known.get(id);
        const result = found ? item(found, rootId) : { id: rootId, name: "", mime_type: FOLDER, kind: "folder" as const, parents: [] };
        count = 1; complete = true;
        return { item: result, complete: true };
      }

      if (input.operation === "list") {
        const folder = input.folder_id ?? rootId;
        const state = input.cursor ? await open(input.cursor, bind) : { offset: 0 };
        if (folder !== rootId && !(await inRoot([folder])).has(folder)) fail("not_found_in_scope");
        if (folder !== rootId && known.get(folder)?.mimeType !== FOLDER) fail("not_found_in_scope");
        const [list] = await scopedChildren(await children([folder]));
        const items = list.map(raw => item(raw, rootId)).sort(byName);
        const offset = Number(state.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) fail("cursor_invalid");
        const page = items.slice(offset, offset + PAGE);
        count = page.length; complete = offset + PAGE >= items.length;
        return { folder_id: folder, items: page, complete, provider_errors: [], next_cursor: complete ? null : await seal(bind, { offset: offset + PAGE }) };
      }

      if (input.operation === "search") {
        const start = input.within ?? rootId;
        let queue: string[], lossy = false;
        const resumed = new Set<string>();
        if (input.cursor) {
          const state = await open(input.cursor, bind);
          if (!Array.isArray(state.queue) || state.queue.some(id => typeof id !== "string" || !fileId.test(id))) fail("cursor_invalid");
          queue = state.queue as string[];
          if (queue.length > QUEUE_LIMIT || typeof state.lossy !== "boolean") fail("cursor_invalid");
          lossy = state.lossy as boolean;
          queue.forEach(id => resumed.add(id));
        } else {
          if (start !== rootId && (!(await inRoot([start])).has(start) || known.get(start)?.mimeType !== FOLDER)) fail("not_found_in_scope");
          queue = [start];
        }
        const needle = input.name_contains?.toLocaleLowerCase();
        const matches: Item[] = [];
        let rounds = 0;
        while (queue.length && rounds < SEARCH_ROUNDS && matches.length < SEARCH_RESULTS && used <= SUBREQUEST_BUDGET - SEARCH_RESERVE) {
          let chunk = queue.splice(0, SEARCH_CHUNK);
          // Folders carried in a cursor are re-checked on the page that uses
          // them; one moved out of the root since the last page is dropped.
          const stale = chunk.filter(id => resumed.has(id) && id !== rootId);
          if (stale.length) { const ok = await inRoot(stale); chunk = chunk.filter(id => !resumed.has(id) || id === rootId || ok.has(id)); }
          if (!chunk.length) continue;
          rounds++;
          const lists = await scopedChildren(await children(chunk));
          for (const raw of lists.flat()) {
            const it = item(raw, rootId);
            // A dropped subtree makes this search lossy for good: the flag is
            // sealed into every later cursor, so no later page claims complete.
            if (it.kind === "folder") { if (queue.length < QUEUE_LIMIT) queue.push(it.id); else lossy = true; }
            if ((!needle || it.name.toLocaleLowerCase().includes(needle)) && (!input.mime_type || it.mime_type === input.mime_type)) matches.push(it);
          }
        }
        matches.sort(byName);
        count = matches.length; complete = !queue.length && !lossy;
        return { items: matches, complete, next_cursor: queue.length ? await seal(bind, { queue, lossy }) : null,
          ...(lossy ? { limit_reached: true } : {}) };
      }

      // resolve: Drive link or ID -> stat; otherwise a root-relative path by exact names.
      const reference = String(input.reference).trim();
      const linked = /^https:\/\/(?:drive|docs)\.google\.com\/.*?(?:\/d\/|\/folders\/|[?&]id=)([A-Za-z0-9_-]{10,160})/.exec(reference)?.[1];
      const direct = linked ?? (fileId.test(reference) && !reference.includes("/") && reference.length >= 10 ? reference : null);
      if (direct && (await inRoot([direct])).has(direct)) {
        await fetchAll([direct]);
        count = 1; complete = true;
        return { matches: [direct === rootId ? { id: rootId, name: "", mime_type: FOLDER, kind: "folder", parents: [] } : item(known.get(direct)!, rootId)], complete: true };
      }
      // A link that is not in scope never falls back; a bare token may be a name.
      if (linked) fail("not_found_in_scope");
      const segments = reference.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      if (!segments.length || segments.length > MAX_DEPTH || segments.some(s => s === "." || s === "..")) fail("storage_read_input_invalid");
      let current = rootId, candidates: Item[] = [];
      for (const [index, segment] of segments.entries()) {
        const [list] = await scopedChildren(await children([current]));
        candidates = list.map(raw => item(raw, rootId)).filter(it => it.name === segment).sort(byName);
        if (!candidates.length) fail("not_found_in_scope");
        if (candidates.length > 1 || index === segments.length - 1) break;
        if (candidates[0].kind !== "folder") fail("not_found_in_scope");
        current = candidates[0].id;
        candidates = [];
      }
      const exact = candidates.length === 1 && segments.length > 0;
      count = candidates.length; complete = true;
      return { matches: candidates, complete: true, ...(exact ? {} : { ambiguous: true }) };
    } finally {
      if (uuid.test(String(admitted.receipt_id))) try {
        await config.rpc({ token_hash, input: { action: "finalize", connection_id: input.connection_id, receipt_id: admitted.receipt_id,
          item_count: count, byte_count: 0, complete } });
      } catch { console.warn(JSON.stringify({ event: "storage_read_finalize_failed" })); }
    }
  } });
}
