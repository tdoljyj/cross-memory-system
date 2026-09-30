/** Clued Storage binary upload staging (StorageNormalUse.v0.1 §6.2, §7.2, MAJOR-2, m-e, m-l, N-T10, N-T13).
 *
 * - `clued_storage_upload_begin` (MCP, create_file level) reserves the upload budget and returns a
 *   single-use, 10-minute signed PUT URL. The token is HMAC-SHA256 under its own key
 *   (CLUED_STORAGE_STAGING_URL_KEY) over owner, connection, Binding, staging_id, sha256, size, MIME
 *   and expiry. The PUT endpoint accepts only that signature, never a Binding bearer.
 * - The staged object is AES-256-GCM in 64 KiB chunks under a per-object key
 *   K = HKDF-SHA256(master, salt = staging_id, info = "clued.storage-staging/1"), a 96-bit
 *   big-endian chunk counter as nonce, and AAD = owner_id ‖ connection_id ‖ staging_id ‖
 *   chunk_index (u64 BE) ‖ is_final (u8): truncation, reordering and cross-object splicing fail.
 *   The master keyring (CLUED_STORAGE_STAGING_KEYS) is separate from the credential vault and
 *   rotatable (the row records key_id). R2 keys never contain a file name.
 * - The database row (public.clued_storage_staging_v1) owns every state change; this module
 *   holds no durable state. Missing R2 binding or keys fail closed.
 */
import { createHash } from "node:crypto";
import { binaryUploadTarget, firstChunkCheck, validateStagedContent, BINARY_UPLOAD_MAX_BYTES,
  BINARY_INLINE_MAX_BYTES } from "../../../kernel/host/resource-center-storage-binary.mjs";

type Data = Record<string, unknown>;
export const STAGING_CHUNK = 64 * 1024;
const TAG = 16;
const URL_CONTRACT = "clued.storage-staging-url/1";
const KEY_INFO = "clued.storage-staging/1";
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** Fixed, caller-safe error codes (§5.3). Nothing else leaves this module. */
export type StorageUploadCode = "storage_binary_upload_disabled" | "upload_url_invalid" | "upload_url_used" |
  "content_type_mismatch" | "staging_expired" | "storage_job_input_invalid" | "budget_exhausted" | "storage_upload_unavailable";
export class StorageUploadError extends Error {
  constructor(readonly code: StorageUploadCode) { super(code); this.name = "StorageUploadError"; }
}
const refuse = (code: StorageUploadCode): never => { throw new StorageUploadError(code); };

/** Map a database rejection (its fixed exception text) to a caller-safe code. */
export function stagingErrorCode(error: unknown): StorageUploadCode {
  if (error instanceof StorageUploadError) return error.code;
  const message = error instanceof Error ? error.message : "";
  switch (message) {
    case "storage_binary_upload_disabled": case "storage_policy_denied": case "storage_policy_mode_denied":
      return "storage_binary_upload_disabled";
    case "upload_url_invalid": case "upload_url_used": case "staging_expired": case "content_type_mismatch":
      return message;
    case "storage_job_input_invalid": case "storage_staging_input_invalid": return "storage_job_input_invalid";
    case "storage_upload_budget_exhausted": return "budget_exhausted";
    default: return "storage_upload_unavailable";
  }
}

export interface StagingBucket {
  put(key: string, value: ReadableStream | Uint8Array, options?: Data): Promise<unknown>;
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string | string[]): Promise<void>;
}
export type StagingRpc = (input: Data, token_hash?: string) => Promise<Data>;
export interface StagingRuntime {
  bucket: StagingBucket;
  url_key: CryptoKey;
  keyring: { current_key_id: string; keys: Map<string, CryptoKey> };
  rpc: StagingRpc;
  clock: () => number;
}

export const stagingObjectKey = (stagingId: string) => {
  if (!uuid.test(stagingId)) refuse("storage_upload_unavailable");
  return `staging/${stagingId}`;
};
export const stagingChunkCount = (size: number) => Math.ceil(size / STAGING_CHUNK);
export const stagingObjectSize = (size: number) => size + TAG * stagingChunkCount(size);

function b64urlEncode(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64urlDecode(value: string, min: number, max: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(max * 4 / 3)) refuse("storage_upload_unavailable");
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)); }
  catch { return refuse("storage_upload_unavailable"); }
  if (bytes.length < min || bytes.length > max || b64urlEncode(bytes) !== value) refuse("storage_upload_unavailable");
  return bytes;
}
/** Strict standard base64 (inline content_base64); decoded in one pass, chunk-safe. */
export function decodeContentBase64(value: unknown) {
  if (typeof value !== "string" || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) refuse("storage_job_input_invalid");
  let binary: string;
  try { binary = atob(value as string); } catch { return refuse("storage_job_input_invalid"); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Parse deployment configuration. Any missing or malformed piece disables uploads (fail closed). */
export async function createStagingRuntime(config: {
  bucket?: unknown; url_key?: string; staging_keys?: string; rpc: StagingRpc; clock?: () => number;
}): Promise<StagingRuntime> {
  const bucket = config.bucket as StagingBucket | undefined;
  if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function" || typeof bucket.delete !== "function" ||
    typeof config.url_key !== "string" || typeof config.staging_keys !== "string") return refuse("storage_upload_unavailable");
  const rawUrlKey = b64urlDecode(config.url_key, 32, 64);
  const url_key = await crypto.subtle.importKey("raw", rawUrlKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  rawUrlKey.fill(0);
  let parsed: unknown;
  try { parsed = JSON.parse(config.staging_keys); } catch { return refuse("storage_upload_unavailable"); }
  const ring = parsed as { current_key_id?: unknown; keys?: unknown };
  if (!ring || typeof ring !== "object" || Object.keys(ring).sort().join(",") !== "current_key_id,keys" ||
    typeof ring.current_key_id !== "string" || !keyIdPattern.test(ring.current_key_id) || !ring.keys || typeof ring.keys !== "object" ||
    Array.isArray(ring.keys) || !Object.hasOwn(ring.keys, ring.current_key_id) || Object.keys(ring.keys).length > 4) return refuse("storage_upload_unavailable");
  const keys = new Map<string, CryptoKey>();
  for (const [id, raw] of Object.entries(ring.keys as Record<string, unknown>)) {
    if (!keyIdPattern.test(id) || typeof raw !== "string") refuse("storage_upload_unavailable");
    const bytes = b64urlDecode(raw as string, 32, 32);
    try { keys.set(id, await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"])); }
    finally { bytes.fill(0); }
  }
  return { bucket, url_key, keyring: { current_key_id: ring.current_key_id, keys }, rpc: config.rpc, clock: config.clock ?? Date.now };
}

// ---- signed upload URL ----------------------------------------------------------------------

export type UploadClaims = { owner_id: string; connection_id: string; binding_id: string; staging_id: string;
  sha256: string; size: number; mime_type: string; exp: number };
const claimTuple = (c: UploadClaims) => [URL_CONTRACT, c.owner_id, c.connection_id, c.binding_id, c.staging_id, c.sha256, c.size, c.mime_type, c.exp];

export async function signUploadToken(key: CryptoKey, claims: UploadClaims) {
  const payload = b64urlEncode(encoder.encode(JSON.stringify(claimTuple(claims))));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${URL_CONTRACT}.${payload}`)));
  return `${payload}.${b64urlEncode(signature)}`;
}

/** Verify signature (constant time), shape, path binding and expiry. */
export async function verifyUploadToken(key: CryptoKey, token: unknown, stagingId: string, nowMs: number): Promise<UploadClaims> {
  if (typeof token !== "string" || token.length > 2048) return refuse("upload_url_invalid");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return refuse("upload_url_invalid");
  let sig: Uint8Array<ArrayBuffer>;
  try { sig = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)); }
  catch { return refuse("upload_url_invalid"); }
  if (!await crypto.subtle.verify("HMAC", key, sig, encoder.encode(`${URL_CONTRACT}.${payload}`))) return refuse("upload_url_invalid");
  let tuple: unknown;
  try { tuple = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)))); }
  catch { return refuse("upload_url_invalid"); }
  if (!Array.isArray(tuple) || tuple.length !== 9 || tuple[0] !== URL_CONTRACT) return refuse("upload_url_invalid");
  const [, owner_id, connection_id, binding_id, staging_id, sha256, size, mime_type, exp] = tuple;
  const claims = { owner_id, connection_id, binding_id, staging_id, sha256, size, mime_type, exp } as UploadClaims;
  if (![owner_id, connection_id, binding_id, staging_id].every(v => typeof v === "string" && uuid.test(v)) || staging_id !== stagingId ||
    typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > BINARY_UPLOAD_MAX_BYTES ||
    typeof mime_type !== "string" || !Number.isSafeInteger(exp)) return refuse("upload_url_invalid");
  if (exp * 1000 <= nowMs) return refuse("staging_expired");
  return claims;
}

// ---- chunked AEAD ---------------------------------------------------------------------------

export type StagingContext = { owner_id: string; connection_id: string; staging_id: string };

export async function stagingObjectKeyMaterial(master: CryptoKey, stagingId: string) {
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(stagingId), info: encoder.encode(KEY_INFO) },
    master, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function chunkNonce(index: number) {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index), false);
  return nonce;
}
function chunkAad(context: StagingContext, index: number, final: boolean) {
  if (![context.owner_id, context.connection_id, context.staging_id].every(v => uuid.test(v))) refuse("storage_upload_unavailable");
  const aad = new Uint8Array(36 * 3 + 9);
  aad.set(encoder.encode(context.owner_id), 0);
  aad.set(encoder.encode(context.connection_id), 36);
  aad.set(encoder.encode(context.staging_id), 72);
  new DataView(aad.buffer).setBigUint64(108, BigInt(index), false);
  aad[116] = final ? 1 : 0;
  return aad;
}
export async function encryptStagingChunk(key: CryptoKey, context: StagingContext, index: number, final: boolean, plaintext: Uint8Array) {
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkNonce(index), additionalData: chunkAad(context, index, final), tagLength: 128 }, key, plaintext as Uint8Array<ArrayBuffer>));
}
/** Decrypt a whole staged object and check its exact size and sha256. */
export async function decryptStagingObject(key: CryptoKey, context: StagingContext, ciphertext: Uint8Array, size: number, sha256: string) {
  const count = stagingChunkCount(size);
  if (!Number.isSafeInteger(size) || size < 1 || ciphertext.byteLength !== stagingObjectSize(size)) refuse("storage_upload_unavailable");
  const out = new Uint8Array(size);
  const digest = createHash("sha256");
  for (let i = 0, at = 0, written = 0; i < count; i += 1) {
    const plainLength = i === count - 1 ? size - STAGING_CHUNK * (count - 1) : STAGING_CHUNK;
    const chunk = ciphertext.subarray(at, at + plainLength + TAG);
    let plain: Uint8Array;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkNonce(i), additionalData: chunkAad(context, i, i === count - 1), tagLength: 128 }, key, chunk as Uint8Array<ArrayBuffer>)); }
    catch { return refuse("storage_upload_unavailable"); }
    out.set(plain, written); digest.update(plain);
    at += plainLength + TAG; written += plainLength;
  }
  if (digest.digest("hex") !== sha256) refuse("storage_upload_unavailable");
  return out;
}

async function* bytesOf(source: ReadableStream<Uint8Array> | Uint8Array): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) { yield source; return; }
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.byteLength) yield value;
    }
  } finally { reader.releaseLock(); }
}

type Received = { staging_id: string; owner_id: string; connection_id: string; size: number; sha256: string; mime_type: string; key_id: string };

/** Encrypt-and-store one staged object from a byte stream (§6.2 steps 3-5). The first chunk is
 * type-checked before anything is written; digest and length are checked at the end; the stored
 * object is then read back, decrypted and validated (§6.3) before the row becomes `ready`. */
async function storeAndValidate(runtime: StagingRuntime, row: Received, source: ReadableStream<Uint8Array> | Uint8Array) {
  const context = { owner_id: row.owner_id, connection_id: row.connection_id, staging_id: row.staging_id };
  const master = runtime.keyring.keys.get(row.key_id);
  if (!master) return refuse("storage_upload_unavailable");
  const key = await stagingObjectKeyMaterial(master, row.staging_id);
  const objectKey = stagingObjectKey(row.staging_id);
  const count = stagingChunkCount(row.size);
  const reject = async (reason: string, code: StorageUploadCode): Promise<never> => {
    await runtime.bucket.delete(objectKey).catch(() => {});
    await runtime.rpc({ action: "received", staging_id: row.staging_id, outcome: "rejected", reason }).catch(() => {});
    return refuse(code);
  };
  // FixedLengthStream (Workers) gives R2 the exact object length up front.
  const Fixed = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  const pipe = Fixed ? new Fixed(stagingObjectSize(row.size)) : new TransformStream<Uint8Array, Uint8Array>();
  const writer = pipe.writable.getWriter();
  const stored = runtime.bucket.put(objectKey, pipe.readable);
  stored.catch(() => {});
  const digest = createHash("sha256");
  let buffer = new Uint8Array(STAGING_CHUNK), filled = 0, index = 0, total = 0;
  const outcome: { failure: [string, StorageUploadCode] | null } = { failure: null };
  const flush = async (final: boolean) => {
    const plain = buffer.subarray(0, filled);
    if (index === 0) {
      try { firstChunkCheck(plain, row.mime_type); } catch { outcome.failure = ["content_type_mismatch", "content_type_mismatch"]; return false; }
    }
    digest.update(plain);
    await writer.write(await encryptStagingChunk(key, context, index, final, plain));
    index += 1; buffer = new Uint8Array(STAGING_CHUNK); filled = 0;
    return true;
  };
  const lengthMismatch: [string, StorageUploadCode] = ["length_mismatch", "storage_job_input_invalid"];
  try {
    outer: for await (const part of bytesOf(source)) {
      total += part.byteLength;
      if (total > row.size) { outcome.failure = lengthMismatch; break; }
      for (let at = 0; at < part.byteLength;) {
        const take = Math.min(STAGING_CHUNK - filled, part.byteLength - at);
        buffer.set(part.subarray(at, at + take), filled); filled += take; at += take;
        // A full chunk is final only if it ends the declared size.
        if (filled === STAGING_CHUNK && !await flush(index === count - 1)) break outer;
      }
    }
    if (!outcome.failure && total !== row.size) outcome.failure = lengthMismatch;
    if (!outcome.failure && filled > 0) await flush(true);
    if (!outcome.failure && index !== count) outcome.failure = lengthMismatch;
  } catch {
    outcome.failure = outcome.failure ?? ["storage_failed", "storage_upload_unavailable"];
  }
  if (outcome.failure) {
    await writer.abort().catch(() => {});
    return reject(outcome.failure[0], outcome.failure[1]);
  }
  try { await writer.close(); await stored; }
  catch { return reject("storage_failed", "storage_upload_unavailable"); }
  if (digest.digest("hex") !== row.sha256) return reject("digest_mismatch", "storage_job_input_invalid");
  await runtime.rpc({ action: "received", staging_id: row.staging_id, outcome: "validating" });
  // §6.3 validating stage: read back and decrypt the stored object, then the whole-object checks.
  const rejectValidated = async (reason: string, code: StorageUploadCode): Promise<never> => {
    await runtime.bucket.delete(objectKey).catch(() => {});
    await runtime.rpc({ action: "validated", staging_id: row.staging_id, outcome: "rejected", reason }).catch(() => {});
    return refuse(code);
  };
  let plain: Uint8Array;
  try {
    const object = await runtime.bucket.get(objectKey);
    if (!object) throw new Error("missing");
    plain = await decryptStagingObject(key, context, new Uint8Array(await object.arrayBuffer()), row.size, row.sha256);
  } catch { return rejectValidated("storage_failed", "storage_upload_unavailable"); }
  try { await validateStagedContent(plain, row.mime_type); }
  catch { return rejectValidated("content_type_mismatch", "content_type_mismatch"); }
  const ready = await runtime.rpc({ action: "validated", staging_id: row.staging_id, outcome: "ready" });
  if (ready.state !== "ready") refuse("storage_upload_unavailable");
  return { staging_id: row.staging_id, state: "ready" as const, size: row.size, sha256: row.sha256, mime_type: row.mime_type,
    ready_expires_at: typeof ready.ready_expires_at === "number" ? new Date(ready.ready_expires_at * 1000).toISOString() : undefined };
}

/** Single-use claim of a verified URL (issued -> receiving CAS in the database), then store. */
export async function receiveStaged(runtime: StagingRuntime, claims: UploadClaims, source: ReadableStream<Uint8Array> | Uint8Array) {
  let received: Data;
  try {
    received = await runtime.rpc({ action: "receive", staging_id: claims.staging_id, owner_id: claims.owner_id,
      connection_id: claims.connection_id, binding_id: claims.binding_id, sha256: claims.sha256, size: claims.size,
      mime_type: claims.mime_type, exp: claims.exp, key_id: runtime.keyring.current_key_id });
  } catch (error) { return refuse(stagingErrorCode(error)); }
  if (received.staging_id !== claims.staging_id || received.owner_id !== claims.owner_id || received.connection_id !== claims.connection_id ||
    received.size !== claims.size || received.sha256 !== claims.sha256 || received.mime_type !== claims.mime_type ||
    received.key_id !== runtime.keyring.current_key_id || received.state !== "receiving") return refuse("storage_upload_unavailable");
  try {
    return await storeAndValidate(runtime, received as unknown as Received, source);
  } catch (error) { return refuse(stagingErrorCode(error)); }
}

// ---- MCP: clued_storage_upload_begin -------------------------------------------------------

export const storageUploadBeginTool = {
  name: "clued_storage_upload_begin",
  description: "Start a binary file upload for clued_storage_submit (create). Needs the Owner's create_file level with \"normal use\" on (read access normal/1 on a connection Google granted the normal scope set). Declare the destination path, MIME type, exact byte size (at most 20 MiB) and sha256; the extension must match the type (png, jpg/jpeg, gif, webp, pdf, zip, docx, xlsx, pptx, odt, ods, odp, doc, xls, ppt). Macro-enabled Office files, executables, scripts, HTML and SVG are refused (HTML/SVG only as text content). Returns a single-use upload URL valid for 10 minutes. A client with a shell uploads with: curl -T <local file> -H \"Content-Type: <mime_type>\" \"<upload_url>\" and then calls clued_storage_submit with staging_id, mime_type and content_sha256. Clients without a shell (claude.ai, Claude Desktop remote connectors) cannot send PUT: use clued_storage_submit with content_base64 instead (whole request at most 1 MiB, about 700 KiB of file). The URL writes only to encrypted staging; nothing reaches Drive until submit. Treat the URL as a secret.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["connection_id", "destination_path", "mime_type", "size", "content_sha256"],
    properties: {
      connection_id: { type: "string", format: "uuid" },
      destination_path: { type: "string", minLength: 1, maxLength: 1000, description: "Exact new file path under the connection's registered root; its extension must match mime_type." },
      mime_type: { type: "string", minLength: 3, maxLength: 255 },
      size: { type: "integer", minimum: 1, maximum: BINARY_UPLOAD_MAX_BYTES },
      content_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
  },
  outputSchema: { type: "object", additionalProperties: true },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _meta: { "clued/requiredStorageGrant": ["create_file"], "clued/scopeEnforcement": "server-side" },
};

export function uploadBeginInput(args: unknown) {
  const a = args as Data;
  if (!a || typeof a !== "object" || Array.isArray(a) ||
    Object.keys(a).sort().join(",") !== "connection_id,content_sha256,destination_path,mime_type,size" ||
    typeof a.connection_id !== "string" || !uuid.test(a.connection_id) ||
    typeof a.destination_path !== "string" || a.destination_path.length < 1 || a.destination_path.length > 1000 ||
    typeof a.mime_type !== "string" || !Number.isSafeInteger(a.size) || (a.size as number) < 1 || (a.size as number) > BINARY_UPLOAD_MAX_BYTES ||
    typeof a.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.content_sha256)) return refuse("storage_job_input_invalid");
  if (!binaryUploadTarget(a.destination_path, a.mime_type).ok) refuse("content_type_mismatch");
  return { connection_id: a.connection_id as string, destination_path: a.destination_path as string, mime_type: a.mime_type as string,
    size: a.size as number, content_sha256: a.content_sha256 as string };
}

async function begin(runtime: StagingRuntime, tokenHash: string, input: ReturnType<typeof uploadBeginInput>, transport: "url" | "inline") {
  let row: Data;
  try {
    row = await runtime.rpc({ action: "begin", connection_id: input.connection_id, destination_path: input.destination_path,
      mime_type: input.mime_type, size: input.size, content_sha256: input.content_sha256, transport }, tokenHash);
  } catch (error) { return refuse(stagingErrorCode(error)); }
  if (row.contract !== "clued.storage-staging/1" || typeof row.staging_id !== "string" || !uuid.test(row.staging_id) ||
    typeof row.owner_id !== "string" || row.connection_id !== input.connection_id || typeof row.binding_id !== "string" ||
    row.size !== input.size || row.sha256 !== input.content_sha256 || row.mime_type !== input.mime_type ||
    row.destination_path !== input.destination_path || !Number.isSafeInteger(row.expires_at)) return refuse("storage_upload_unavailable");
  return { owner_id: row.owner_id, connection_id: input.connection_id, binding_id: row.binding_id as string, staging_id: row.staging_id,
    sha256: input.content_sha256, size: input.size, mime_type: input.mime_type, exp: row.expires_at as number } as UploadClaims;
}

export async function uploadBegin(runtime: StagingRuntime, tokenHash: string, args: unknown, origin: string) {
  const input = uploadBeginInput(args);
  const claims = await begin(runtime, tokenHash, input, "url");
  const token = await signUploadToken(runtime.url_key, claims);
  return { staging_id: claims.staging_id, upload_url: `${origin}/storage/staging/${claims.staging_id}?t=${token}`, method: "PUT",
    required_headers: { "Content-Type": claims.mime_type, "Content-Length": String(claims.size) },
    expires_at: new Date(claims.exp * 1000).toISOString() };
}

/** Inline transport (§6.2): `content_base64` inside the existing 1 MiB MCP body. Budget is reserved
 * at request start, the bytes go through the same encrypted staging and checks, and the returned
 * staging_id is submitted in the same request. */
export async function stageInline(runtime: StagingRuntime, tokenHash: string, input: {
  connection_id: string; destination_path: string; mime_type: string; content_sha256: string; content_base64: unknown;
}) {
  const bytes = decodeContentBase64(input.content_base64);
  if (bytes.byteLength < 1 || bytes.byteLength > BINARY_INLINE_MAX_BYTES) refuse("storage_job_input_invalid");
  if (createHash("sha256").update(bytes).digest("hex") !== input.content_sha256) refuse("storage_job_input_invalid");
  const claims = await begin(runtime, tokenHash, uploadBeginInput({ connection_id: input.connection_id, destination_path: input.destination_path,
    mime_type: input.mime_type, size: bytes.byteLength, content_sha256: input.content_sha256 }), "inline");
  return receiveStaged(runtime, claims, bytes);
}

// ---- PUT /storage/staging/<staging_id>?t=<token> --------------------------------------------

const uploadStatus: Record<StorageUploadCode, number> = {
  upload_url_invalid: 403, storage_binary_upload_disabled: 403, upload_url_used: 409, staging_expired: 410,
  content_type_mismatch: 415, storage_job_input_invalid: 400, budget_exhausted: 429, storage_upload_unavailable: 503,
};
const uploadMessage: Record<StorageUploadCode, string> = {
  upload_url_invalid: "The upload URL is invalid. Call clued_storage_upload_begin again.",
  upload_url_used: "This upload URL was already used. Call clued_storage_upload_begin again for another upload.",
  staging_expired: "The upload URL or staged file expired. Call clued_storage_upload_begin again.",
  storage_binary_upload_disabled: "Binary upload is not enabled for this connection (needs the create_file level and normal use).",
  content_type_mismatch: "The file content does not match the declared type, or the type is not accepted.",
  storage_job_input_invalid: "Content-Length, Content-Type, the byte count or sha256 does not match the declared values.",
  budget_exhausted: "The hourly upload budget is used up. Try again later.",
  storage_upload_unavailable: "Storage upload unavailable.",
};
export function uploadErrorBody(code: StorageUploadCode) { return { error: code, message: uploadMessage[code] }; }

export async function handleStagingPut(request: Request, runtime: StagingRuntime | null, stagingId: string): Promise<Response> {
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
  const fail = (code: StorageUploadCode) => Response.json(uploadErrorBody(code), { status: uploadStatus[code], headers });
  try {
    if (request.method !== "PUT") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...headers, allow: "PUT" } });
    if (!runtime) return fail("storage_upload_unavailable");
    if (!uuid.test(stagingId)) return fail("upload_url_invalid");
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].join(",") !== "t") return fail("upload_url_invalid");
    // The signature is the only credential; a Binding bearer is neither needed nor accepted.
    if (request.headers.has("authorization")) return fail("upload_url_invalid");
    const claims = await verifyUploadToken(runtime.url_key, url.searchParams.get("t"), stagingId, runtime.clock());
    // Declared headers are checked before the single-use claim, so a client mistake does not burn the URL.
    const length = request.headers.get("content-length");
    if (length !== String(claims.size) || request.headers.get("content-type") !== claims.mime_type || !request.body)
      return fail("storage_job_input_invalid");
    const result = await receiveStaged(runtime, claims, request.body);
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    return fail(stagingErrorCode(error));
  }
}

// ---- executor loader and cleanup -----------------------------------------------------------

/** Read back, decrypt and check the staged object of a binary job (§6.4 "effect 前取回暂存并重算 sha256"). */
export async function loadStagedContent(runtime: Pick<StagingRuntime, "bucket" | "keyring">, input: {
  owner_id: string; connection_id: string; staging: unknown; content_ref: { staging_id: string; sha256: string; size: number; mime_type: string };
}) {
  const staging = input.staging as Data | null;
  if (!staging || staging.staging_id !== input.content_ref.staging_id || typeof staging.key_id !== "string" ||
    staging.size !== input.content_ref.size || staging.sha256 !== input.content_ref.sha256) return refuse("storage_upload_unavailable");
  const master = runtime.keyring.keys.get(staging.key_id);
  if (!master) return refuse("storage_upload_unavailable");
  const object = await runtime.bucket.get(stagingObjectKey(input.content_ref.staging_id));
  if (!object) return refuse("storage_upload_unavailable");
  const key = await stagingObjectKeyMaterial(master, input.content_ref.staging_id);
  return decryptStagingObject(key, { owner_id: input.owner_id, connection_id: input.connection_id, staging_id: input.content_ref.staging_id },
    new Uint8Array(await object.arrayBuffer()), input.content_ref.size, input.content_ref.sha256);
}

/** Cron: TTL expiry, 12 h job cancellation, then delete objects the database lists as deletable. */
export async function sweepStaging(runtime: Pick<StagingRuntime, "bucket" | "rpc">) {
  const swept = await runtime.rpc({ action: "sweep" });
  if (swept.status !== "ok" || !Array.isArray(swept.delete) || swept.delete.length > 50 ||
    !swept.delete.every(id => typeof id === "string" && uuid.test(id))) return { status: "unavailable" };
  const ids = swept.delete as string[];
  let deleted: string[] = [];
  if (ids.length) {
    try { await runtime.bucket.delete(ids.map(stagingObjectKey)); deleted = ids; } catch { deleted = []; }
    if (deleted.length) await runtime.rpc({ action: "object_deleted", staging_ids: deleted });
  }
  return { status: "ok", expired: swept.expired, cancelled_jobs: swept.cancelled_jobs, deleted: deleted.length };
}
