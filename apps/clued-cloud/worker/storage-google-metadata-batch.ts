import { createStorageFetch } from "./storage-fetch";

const endpoint = "https://www.googleapis.com/batch/drive/v3";
const fields = "id,name,mimeType,parents,version,trashed,size,sha256Checksum,isAppAuthorized,driveId,capabilities(canAddChildren)";
const maxParts = 32, maxBody = 16 * 1024 * 1024, maxPart = 2 * 1024 * 1024;
const encoder = new TextEncoder();
type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
function invalid(): never { throw new Error("DRIVE_BATCH_INVALID"); }
function ids(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1025 || new Set(value).size !== value.length ||
    value.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id))) invalid();
}
function headers(raw: string): Map<string, string> {
  if (raw.length > 16384) invalid();
  const result = new Map<string, string>();
  for (const line of raw.split("\r\n")) {
    const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match || result.has(match[1].toLowerCase())) invalid();
    result.set(match[1].toLowerCase(), match[2].trim());
  }
  return result;
}
function status(code: number): void {
  if (code >= 200 && code < 300) return;
  // Only closed codes, never provider text, IDs or response headers.
  throw new Error(`DRIVE_BATCH_HTTP_${[401, 403, 404, 429].includes(code) ? code : code >= 500 ? 500 : 400}`);
}
async function body(response: Response, signal: AbortSignal, consume: (bytes: number) => void): Promise<string> {
  if (!response.body) invalid();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBody) throw new Error("DRIVE_BATCH_SIZE_LIMIT");
      consume(value.byteLength);
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    // Do not wait indefinitely for a misbehaving stream's cancellation hook.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function parse(raw: string, contentType: string | null, expected: string[]): unknown[] {
  const match = /^multipart\/mixed\s*;\s*boundary=(?:"([A-Za-z0-9_.-]{1,70})"|([A-Za-z0-9_.-]{1,70}))\s*$/i.exec(contentType ?? "");
  if (!match) invalid();
  const boundary = "--" + (match[1] ?? match[2]);
  if (raw.startsWith("\r\n")) raw = raw.slice(2);
  if (!raw.startsWith(boundary + "\r\n") || !raw.endsWith(boundary + "--\r\n")) invalid();
  const parts = raw.slice(boundary.length + 2, -(boundary.length + 6)).split("\r\n" + boundary + "\r\n");
  if (parts.length !== expected.length || parts.length > maxParts) invalid();
  const pending = new Set(expected.map(id => "<response-" + id + ">")), values = new Map<string, unknown>();
  for (const part of parts) {
    if (encoder.encode(part).byteLength > maxPart) throw new Error("DRIVE_BATCH_SIZE_LIMIT");
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) invalid();
    const mime = headers(part.slice(0, headerEnd)), contentId = mime.get("content-id");
    if (mime.get("content-type")?.toLowerCase() !== "application/http" || !contentId || !pending.delete(contentId)) invalid();
    const http = part.slice(headerEnd + 4), statusEnd = http.indexOf("\r\n"), httpHeaderEnd = http.indexOf("\r\n\r\n");
    const line = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?$/.exec(http.slice(0, statusEnd));
    if (!line || statusEnd < 0 || httpHeaderEnd <= statusEnd) invalid();
    status(Number(line[1]));
    const inner = headers(http.slice(statusEnd + 2, httpHeaderEnd));
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(inner.get("content-type") ?? "") ||
      inner.has("content-encoding") || inner.has("transfer-encoding")) invalid();
    const payload = http.slice(httpHeaderEnd + 4);
    if (inner.has("content-length") && inner.get("content-length") !== String(encoder.encode(payload).byteLength)) invalid();
    values.set(contentId, JSON.parse(payload));
  }
  if (pending.size) invalid();
  return expected.map(id => values.get("<response-" + id + ">"));
}

/** Private probe-only transport. Token is already scope/subject/generation pinned
 * by the server. No caller URL, headers, methods or bodies are accepted here.
 * POST is only a metadata GET envelope, not a file mutation or OAuth refresh.
 */
export function createStorageGoogleMetadataBatch(config: {
  access_token: string; fetch?: typeof fetch; signal: AbortSignal;
}) {
  if (typeof config.access_token !== "string" || config.access_token.length < 16 || /[\r\n]/.test(config.access_token) ||
    !(config.signal instanceof AbortSignal)) invalid();
  const fetcher = createStorageFetch(config.fetch);
  // One adapter belongs to one probe: count actual decompressed bytes across
  // all pages AND before/after phases, not only each individual HTTP envelope.
  let totalBytes = 0;
  const consume = (bytes: number) => {
    totalBytes += bytes;
    if (totalBytes > 32 * 1024 * 1024) throw new Error("DRIVE_BATCH_SIZE_LIMIT");
  };
  async function batch(paths: string[], parentSignal?: AbortSignal): Promise<unknown[]> {
    if (!paths.length || paths.length > maxParts || paths.some(path => path.length > 8000 ||
      !/^\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?\?[^\r\n ]+$/.test(path))) invalid();
    const signal = AbortSignal.any([config.signal, AbortSignal.timeout(10000), ...(parentSignal ? [parentSignal] : [])]);
    const nonce = crypto.randomUUID(), boundary = "clued_" + nonce;
    const requestIds = paths.map((_, index) => `clued-${nonce}-${index}`);
    const payload = paths.map((path, index) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${requestIds[index]}>\r\n\r\nGET ${path} HTTP/1.1\r\nAccept: application/json\r\n\r\n`).join("") + `--${boundary}--\r\n`;
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      return await Promise.race([aborted, (async () => {
        const response = await fetcher(endpoint, { method: "POST", redirect: "manual", cache: "no-store", signal,
          headers: { authorization: "Bearer " + config.access_token, "content-type": `multipart/mixed; boundary=${boundary}` }, body: payload });
        status(response.status);
        const raw = await body(response, signal, consume);
        signal.throwIfAborted();
        return parse(raw, response.headers.get("content-type"), requestIds);
      })()]);
    } catch (error) {
      if (config.signal.aborted) throw new Error("DRIVE_QUALIFICATION_OBSERVATION_EXPIRED");
      if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") throw new Error("DRIVE_BATCH_TIMEOUT");
      throw error;
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  async function groups(paths: string[], signal?: AbortSignal): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let i = 0; i < paths.length; i += maxParts) result.push(...await batch(paths.slice(i, i + maxParts), signal));
    return result;
  }
  return Object.freeze({
    async getFiles(fileIds: string[], { signal }: { signal?: AbortSignal } = {}) {
      ids(fileIds);
      const values = await groups(fileIds.map(id => "/drive/v3/files/" + id + "?" + new URLSearchParams({ fields, supportsAllDrives: "true" })), signal);
      if (values.some((value, i) => !object(value) || value.id !== fileIds[i])) throw new Error("DRIVE_METADATA_MISMATCH");
      return values;
    },
    // Sharing state only, for directory sharing digests (resource-center-google-drive-sharing.mjs).
    async getSharings(fileIds: string[], { signal }: { signal?: AbortSignal } = {}) {
      ids(fileIds);
      const values = await groups(fileIds.map(id => "/drive/v3/files/" + id + "?" +
        new URLSearchParams({ fields: "id,shared,permissionIds", supportsAllDrives: "true" })), signal);
      if (values.some((value, i) => !object(value) || value.id !== fileIds[i])) throw new Error("DRIVE_METADATA_MISMATCH");
      return values;
    },
    /** Direct children of each folder. With fullText (StorageNormalUse §5.2)
     * only children whose indexed content matches; the caller intersects the
     * result with its own scoped child list. `\` and `'` are escaped.
     * With appAuthorizedOnly (the write path, StorageNormalUse §3.1) only
     * children with isAppAuthorized === true are kept, before the entry limit
     * is counted, so a drive.readonly token sees the drive.file namespace.
     * The read path (storage-read-agent.ts) never sets it. */
    async listFolders(folderIds: string[], { signal, fullText, appAuthorizedOnly }:
      { signal?: AbortSignal; fullText?: string; appAuthorizedOnly?: boolean } = {}) {
      ids(folderIds);
      if (appAuthorizedOnly !== undefined && typeof appAuthorizedOnly !== "boolean") invalid();
      if (fullText !== undefined && (typeof fullText !== "string" || !fullText.length || fullText.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(fullText))) invalid();
      const textClause = fullText === undefined ? ""
        : ` and fullText contains '${fullText.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
      const states = folderIds.map(id => ({ id, token: "", seen: new Set<string>(), files: [] as unknown[] }));
      let active = [...states], count = 0;
      for (let page = 0; page < 100 && active.length; page++) {
        const next: typeof active = [];
        for (let offset = 0; offset < active.length; offset += maxParts) {
        const current = active.slice(offset, offset + maxParts);
        const values = await batch(current.map(state => {
          const params = new URLSearchParams({ q: `'${state.id}' in parents${textClause} and trashed = false`,
            fields: `nextPageToken,incompleteSearch,files(${fields})`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
          if (state.token) params.set("pageToken", state.token);
          return "/drive/v3/files?" + params;
        }), signal);
        values.forEach((value, index) => {
          if (!object(value) || !Array.isArray(value.files) || value.incompleteSearch === true) throw new Error("DRIVE_LIST_INVALID");
          const files = appAuthorizedOnly === true
            ? value.files.filter(file => object(file) && file.isAppAuthorized === true) : value.files;
          count += files.length;
          if (count > 10000) throw new Error("DRIVE_ENUMERATION_LIMIT");
          const state = current[index]; state.files.push(...files);
          if (value.nextPageToken !== undefined && value.nextPageToken !== "") {
            if (typeof value.nextPageToken !== "string" || value.nextPageToken.length > 4096 || state.seen.has(value.nextPageToken)) throw new Error("DRIVE_PAGINATION_INVALID");
            state.seen.add(value.nextPageToken); state.token = value.nextPageToken; next.push(state);
          }
        });
        }
        active = next;
      }
      if (active.length) throw new Error("DRIVE_PAGINATION_LIMIT");
      return states.map(state => state.files);
    },
  });
}
