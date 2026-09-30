import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";
import { scopeProfile } from "./resource-center-google-scopes.mjs";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed";
const fail = (code) => { throw new Error(code); };

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
} = {}) {
  if (!trustedProfile || typeof getCredential !== "function" || typeof resolveProviderIdentity !== "function" ||
    typeof consumeStartedProvider !== "function" || typeof persistProviderAttempt !== "function" ||
    typeof fetchImpl !== "function" || typeof clock !== "function") throw new TypeError("A private native writer and durable attempt store are required.");
  const profile = structuredClone(trustedProfile);
  async function request(url, options = {}, expiresAt) {
    const credential = await getCredential();
    // Writes accept either allowed profile (StorageNormalUse §2.2); any other set is refused.
    if (typeof credential?.access_token !== "string" || credential.access_token.length < 16 ||
      scopeProfile(credential.scope) === null) fail("DRIVE_NATIVE_GRANT_UNAVAILABLE");
    // Credentials may refresh asynchronously. Nothing awaited may intervene
    // between this final TTL check and dispatch of the only storage POST.
    if (options.method === "POST") {
      const now = Number(clock());
      if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now >= expiresAt) fail("DRIVE_NATIVE_ADMISSION_EXPIRED");
    }
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(10000), headers: { ...options.headers, authorization: `Bearer ${credential.access_token}` } });
      if (!response.ok) fail("DRIVE_NATIVE_REQUEST_FAILED");
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
      (mutation.content !== undefined && typeof mutation.content !== "string")) fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    const started = consumeStartedProvider(binding);
    if (!started || started.request_sha256 !== requestHash || !started.intent_id) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const bound = bindResourceCenterMutation(mutation);
    const content = mutation.content ?? "";
    if (Buffer.byteLength(content, "utf8") > 1024 * 1024) fail("DRIVE_NATIVE_CONTENT_LIMIT");
    const generated = await request(`${API}/generateIds?count=1&space=drive&type=files&fields=ids`);
    const id = generated?.ids?.[0];
    if (!Array.isArray(generated?.ids) || generated.ids.length !== 1 || !/^[A-Za-z0-9_-]{1,160}$/.test(id ?? "")) {
      fail("DRIVE_NATIVE_GENERATED_ID_INVALID");
    }
    const directory = (mutation.target_kind ?? "file") === "directory";
    const metadata = { id, name: bound.destination_path.split("/").at(-1), parents: [before.destination_parent_id],
      mimeType: directory ? "application/vnd.google-apps.folder" : "text/plain",
      appProperties: { clued_intent_id: started.intent_id, clued_request_sha256: requestHash } };
    const attempt = Object.freeze({ contract: "clued.resource-center-provider-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, provider_file_id: id,
      destination_path: bound.destination_path, parent_id: before.destination_parent_id,
      target_kind: directory ? "directory" : "file", binding: structuredClone(binding),
      size: directory ? null : String(Buffer.byteLength(content, "utf8")),
      sha256: directory ? null : createHash("sha256").update(content, "utf8").digest("hex") });
    await persistProviderAttempt(attempt);
    // Recheck after the durable flush, still before the only storage mutation.
    if (!isDeepStrictEqual(await resolveProviderIdentity({ profile, mutation }), before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    let result;
    if (directory) {
      result = await request(`${API}?fields=${FIELDS}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) }, admission.expires_at_ms);
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
