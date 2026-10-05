import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";
import { scopeProfile } from "./resource-center-google-scopes.mjs";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed";
const fail = (code) => { throw new Error(code); };
// StorageNormalUse.v0.1 §6.4: multipart up to 5 MiB, one resumable session above, 20 MiB at most.
const MULTIPART_MAX = 5 * 1024 * 1024;
const BINARY_MAX = 20 * 1024 * 1024;
const encoder = new TextEncoder();
/** The staged content a binary create uploads: a bounded-memory source the executor has already
 * run through a full decrypt + sha256 pass (`verified`). `stream()` yields the plaintext and
 * errors before its final bytes if the running digest differs, so a mismatch never completes
 * an upload body. */
export function contentSourceShape(source, ref) {
  return !!source && typeof source === "object" && source.verified === true && typeof source.stream === "function" &&
    !!ref && source.size === ref.size && source.sha256 === ref.sha256;
}
/** One request body of exactly `length` bytes: prefix, the source stream, suffix. Workers get a
 * FixedLengthStream (so Drive sees a Content-Length); elsewhere a plain half-duplex stream. */
function uploadBody(prefix, source, suffix, length) {
  const reader = source.stream().getReader();
  let stage = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (stage === 0) { stage = 1; if (prefix.byteLength) { controller.enqueue(prefix); return; } }
      if (stage === 1) {
        const { done, value } = await reader.read();
        if (!done) { controller.enqueue(value); return; }
        stage = 2;
      }
      if (suffix.byteLength) controller.enqueue(suffix);
      controller.close();
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  const Fixed = globalThis.FixedLengthStream;
  if (typeof Fixed === "function") return { body: body.pipeThrough(new Fixed(length)) };
  return { body, duplex: "half" };
}
/** The exact content reference a binary create job carries (§6.2); anything else is not binary. */
export function contentRefShape(ref) {
  return !!ref && typeof ref === "object" && !Array.isArray(ref) &&
    Object.keys(ref).sort().join(",") === "mime_type,sha256,size,staging_id" &&
    typeof ref.staging_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref.staging_id) &&
    typeof ref.sha256 === "string" && /^[0-9a-f]{64}$/.test(ref.sha256) &&
    Number.isSafeInteger(ref.size) && ref.size >= 1 && ref.size <= BINARY_MAX &&
    typeof ref.mime_type === "string" && /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/.test(ref.mime_type) &&
    !ref.mime_type.startsWith("application/vnd.google-apps.");
}

/** Private effect for the admitted, durable-started Host only. It does not
 * expose a tool, acquire an admission or decide Canonical authority. Generated
 * ID + exact binding are durably recorded BEFORE the one storage POST. A lost
 * reply is inspected by that ID; this function never retries or cleans it up. */
export function createGoogleDriveNativeCreateEffect({
  trusted_profile: trustedProfile, get_credential: getCredential,
  resolve_provider_identity: resolveProviderIdentity,
  consume_started_provider: consumeStartedProvider,
  persist_provider_attempt: persistProviderAttempt,
  fetch: fetchImpl = globalThis.fetch,
  clock = Date.now,
  // Binary create only: the staged content source, already verified by the caller.
  content_source: contentSource,
} = {}) {
  if (!trustedProfile || typeof getCredential !== "function" || typeof resolveProviderIdentity !== "function" ||
    typeof consumeStartedProvider !== "function" || typeof persistProviderAttempt !== "function" ||
    typeof fetchImpl !== "function" || typeof clock !== "function" ||
    (contentSource !== undefined && (!contentSource || typeof contentSource !== "object"))) throw new TypeError("A private native writer and durable attempt store are required.");
  const profile = structuredClone(trustedProfile);
  async function request(url, options = {}, expiresAt, { raw = false, timeoutMs = 10000 } = {}) {
    const credential = await getCredential();
    // Writes accept either allowed profile (StorageNormalUse §2.2); any other set is refused.
    if (typeof credential?.access_token !== "string" || credential.access_token.length < 16 ||
      scopeProfile(credential.scope) === null) fail("DRIVE_NATIVE_GRANT_UNAVAILABLE");
    // Credentials may refresh asynchronously. Nothing awaited may intervene
    // between this final TTL check and dispatch of the only storage POST.
    if (options.method === "POST" || options.method === "PUT") {
      const now = Number(clock());
      if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now >= expiresAt) fail("DRIVE_NATIVE_ADMISSION_EXPIRED");
    }
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs), headers: { ...options.headers, authorization: `Bearer ${credential.access_token}` } });
      if (!response.ok) fail("DRIVE_NATIVE_REQUEST_FAILED");
      if (raw) return response;
      return await response.json();
    } catch { fail("DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN"); }
  }
  return async function effect({ mutation, admission, profile_identity: identity }) {
    const binding = admission?.binding;
    const requestHash = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
    if (mutation?.operation !== "create" || mutation.source_path || !binding ||
      binding.request_sha256 !== requestHash || binding.profile_id !== profile.profile_id ||
      identity?.profile_id !== profile.profile_id || identity.profile_version !== profile.profile_version ||
      !["directory", "file"].includes(mutation.target_kind ?? "file") ||
      (mutation.content !== undefined && typeof mutation.content !== "string") ||
      (mutation.content_ref !== undefined && (mutation.content !== undefined || mutation.target_kind !== "file" ||
        !contentRefShape(mutation.content_ref) || !contentSource)) ||
      (mutation.content_ref === undefined && contentSource !== undefined)) fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    const started = consumeStartedProvider(binding);
    if (!started || started.request_sha256 !== requestHash || !started.intent_id) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const bound = bindResourceCenterMutation(mutation);
    const ref = mutation.content_ref;
    const content = mutation.content ?? "";
    if (!ref && Buffer.byteLength(content, "utf8") > 1024 * 1024) fail("DRIVE_NATIVE_CONTENT_LIMIT");
    // The staged content must match the job's content reference and have passed the caller's
    // full verification pass before any provider call.
    if (ref && !contentSourceShape(contentSource, ref)) fail("STORAGE_CONTENT_STAGING_MISMATCH");
    const generated = await request(`${API}/generateIds?count=1&space=drive&type=files&fields=ids`);
    const id = generated?.ids?.[0];
    if (!Array.isArray(generated?.ids) || generated.ids.length !== 1 || !/^[A-Za-z0-9_-]{1,160}$/.test(id ?? "")) {
      fail("DRIVE_NATIVE_GENERATED_ID_INVALID");
    }
    const directory = (mutation.target_kind ?? "file") === "directory";
    const metadata = { id, name: bound.destination_path.split("/").at(-1), parents: [before.destination_parent_id],
      mimeType: directory ? "application/vnd.google-apps.folder" : ref ? ref.mime_type : "text/plain",
      appProperties: { clued_intent_id: started.intent_id, clued_request_sha256: requestHash } };
    const attempt = Object.freeze({ contract: "clued.resource-center-provider-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, provider_file_id: id,
      destination_path: bound.destination_path, parent_id: before.destination_parent_id,
      target_kind: directory ? "directory" : "file", binding: structuredClone(binding),
      size: directory ? null : ref ? String(ref.size) : String(Buffer.byteLength(content, "utf8")),
      sha256: directory ? null : ref ? ref.sha256 : createHash("sha256").update(content, "utf8").digest("hex") });
    await persistProviderAttempt(attempt);
    // Recheck after the durable flush, still before the only storage mutation.
    if (!isDeepStrictEqual(await resolveProviderIdentity({ profile, mutation }), before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    let result;
    if (directory) {
      result = await request(`${API}?fields=${FIELDS}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) }, admission.expires_at_ms);
    } else if (ref && ref.size > MULTIPART_MAX) {
      // One resumable session, uploaded with a single PUT of the whole body (no 308 chunk loop,
      // so the redirect guard stays intact). The session URI lives only in this closure; it is
      // never persisted, logged or returned. A lost reply on either request is an unknown
      // outcome: the Host marks the journal uncertain and recovery only reads (by the
      // generated ID and appProperties.clued_intent_id); nothing here retries or re-uploads.
      const session = await request(`${UPLOAD}?uploadType=resumable&fields=${FIELDS}`, { method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": ref.mime_type,
          "x-upload-content-length": String(ref.size) }, body: JSON.stringify(metadata) }, admission.expires_at_ms, { raw: true });
      let location;
      try { location = new URL(session.headers.get("location") ?? ""); } catch { fail("DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN"); }
      if (location.protocol !== "https:" || location.host !== "www.googleapis.com" || location.username || location.password ||
        location.pathname !== "/upload/drive/v3/files" || location.searchParams.get("uploadType") !== "resumable" ||
        !/^[A-Za-z0-9_-]{1,512}$/.test(location.searchParams.get("upload_id") ?? "")) fail("DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN");
      result = await request(location.href, { method: "PUT", headers: { "content-type": ref.mime_type },
        ...uploadBody(new Uint8Array(0), contentSource, new Uint8Array(0), ref.size) }, admission.expires_at_ms, { timeoutMs: 120000 });
    } else if (ref) {
      const boundary = `clued_${randomUUID()}`;
      const prefix = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${ref.mime_type}\r\n\r\n`), suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
      result = await request(`${UPLOAD}?uploadType=multipart&fields=${FIELDS}`, { method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        ...uploadBody(prefix, contentSource, suffix, prefix.byteLength + ref.size + suffix.byteLength) }, admission.expires_at_ms, { timeoutMs: 60000 });
    } else {
      const boundary = `clued_${randomUUID()}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--\r\n`;
      result = await request(`${UPLOAD}?uploadType=multipart&fields=${FIELDS}`, { method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` }, body }, admission.expires_at_ms);
    }
    if (result?.id !== id || result.name !== metadata.name || result.trashed !== false ||
      !isDeepStrictEqual(result.parents, metadata.parents) || result.mimeType !== metadata.mimeType ||
      !/^[1-9]\d*$/.test(result.version ?? "")) fail("DRIVE_NATIVE_RESPONSE_MISMATCH");
    return Object.freeze({ operation: "create", source_path: null, destination_path: mutation.destination_path,
      provider_file_id: id, provider_file_version: result.version, intent_id: started.intent_id });
  };
}
