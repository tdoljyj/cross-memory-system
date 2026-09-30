/** StorageNormalUse.v0.1 §3 item 2: the single content channel of the read
 * agent. It is the only code that builds a Drive file detail, `alt=media`
 * (optionally with Range) or `/export` request, and it only does so for IDs
 * that the caller admitted after they passed the root-scope check in the SAME
 * call. Callers never pass a URL: the host is fixed to www.googleapis.com and
 * the path is one of `/drive/v3/files/{id}` or `/drive/v3/files/{id}/export`.
 * An unadmitted ID throws before any fetch (R8). One gateway belongs to one
 * tool call; nothing is cached across calls. */
const fileId = /^[A-Za-z0-9_-]{1,160}$/;
const HOST = "https://www.googleapis.com";
// N1b: Sheets export as xlsx for text extraction (StorageNormalUse §4.1).
const EXPORT_TYPES = new Set(["text/plain", "text/markdown", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
const FIELD = /^[A-Za-z0-9]+$/;

export class StorageContentGatewayError extends Error {
  readonly code: "content_not_admitted" | "content_request_invalid";
  constructor(code: "content_not_admitted" | "content_request_invalid") { super("storage_" + code); this.code = code; }
}

export function createStorageContentGateway(config: { access_token: string; fetch: typeof fetch; signal: AbortSignal }) {
  if (typeof config.access_token !== "string" || config.access_token.length < 16 || /[\r\n]/.test(config.access_token) ||
    typeof config.fetch !== "function" || !(config.signal instanceof AbortSignal)) throw new StorageContentGatewayError("content_request_invalid");
  const admitted = new Set<string>();
  const authorization = "Bearer " + config.access_token;
  const request = async (id: string, suffix: "" | "/export", params: Record<string, string>, headers: Record<string, string> = {}) => {
    if (typeof id !== "string" || !fileId.test(id)) throw new StorageContentGatewayError("content_request_invalid");
    if (!admitted.has(id)) throw new StorageContentGatewayError("content_not_admitted");
    const url = new URL(HOST + "/drive/v3/files/" + id + suffix);
    url.search = new URLSearchParams(params).toString();
    return config.fetch(url.href, { method: "GET", redirect: "manual", headers: { ...headers, Authorization: authorization }, signal: config.signal });
  };
  return Object.freeze({
    /** Only for an ID that passed the root-scope check in this call. */
    admit(id: string) {
      if (typeof id !== "string" || !fileId.test(id)) throw new StorageContentGatewayError("content_request_invalid");
      admitted.add(id);
    },
    detail(id: string, fields: string[]) {
      if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== "string" || !FIELD.test(field)))
        throw new StorageContentGatewayError("content_request_invalid");
      return request(id, "", { fields: fields.join(","), supportsAllDrives: "true" });
    },
    media(id: string, range?: { from: number; to: number }) {
      if (range && (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to < range.from))
        throw new StorageContentGatewayError("content_request_invalid");
      return request(id, "", { alt: "media", supportsAllDrives: "true" }, range ? { Range: `bytes=${range.from}-${range.to}` } : {});
    },
    export(id: string, mimeType: string) {
      if (!EXPORT_TYPES.has(mimeType)) throw new StorageContentGatewayError("content_request_invalid");
      return request(id, "/export", { mimeType });
    },
  });
}
