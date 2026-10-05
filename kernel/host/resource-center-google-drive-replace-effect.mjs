import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";
import { contentIdentity } from "./resource-center-google-drive-modify-effect.mjs";
import { scopeProfile } from "./resource-center-google-scopes.mjs";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed,size,sha256Checksum,md5Checksum,headRevisionId";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_BYTES = 1024 * 1024;
const fail = (code) => { throw new Error(code); };
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const md5Hex = (bytes) => createHash("md5").update(bytes).digest("hex");

/** The replace shape (StorageFullCapability §6.1/§6.2, P4): one registered
 * file as the target only, the version the Agent observed, and either new
 * UTF-8 content or restore_job_id, the committed replace job whose pinned
 * previous revision is restored (revert). */
export function replaceShape(mutation) {
  if (mutation?.operation !== "replace" || (mutation.target_kind ?? "file") !== "file" ||
    mutation.source_path !== undefined || mutation.directory_semantics !== undefined ||
    typeof mutation.destination_path !== "string" || !/^[1-9]\d{0,39}$/.test(mutation.destination_file_version ?? "") ||
    (mutation.content === undefined) === (mutation.restore_job_id === undefined) ||
    (mutation.content !== undefined && (typeof mutation.content !== "string" || Buffer.byteLength(mutation.content, "utf8") > MAX_BYTES)) ||
    (mutation.restore_job_id !== undefined && !uuid(mutation.restore_job_id))) return null;
  const destination = bindResourceCenterMutation(mutation).destination_path;
  if (!destination || destination !== mutation.destination_path) return null;
  return Object.freeze({ destination, name: destination.slice(destination.lastIndexOf("/") + 1),
    destination_file_version: mutation.destination_file_version, restore_job_id: mutation.restore_job_id ?? null });
}

/** Content of the new head: its size and sha256. */
export const contentAfter = (bytes) => Object.freeze({ size: String(bytes.byteLength), sha256: sha256Hex(bytes) });

/** Private effect for the admitted, durable-started Host only. The exact
 * attempt (file, previous content identity, the revision to keep and whether
 * the Owner already kept it, the new content's identity and the Clued-pinned
 * revisions to release) is durably recorded BEFORE the first provider write.
 * Then, in order: keep the current head revision forever (unless already
 * kept), upload the new bytes, try to release the listed older Clued pins. Drive has no conditional update; the file is re-read before and
 * after the durable flush and the verifier re-reads afterwards. A lost reply
 * is inspected, never retried. `replacement` is the Host-validated bytes
 * (the new content, or a restored revision checked against its pin). */
export function createGoogleDriveNativeReplaceEffect({
  trusted_profile: trustedProfile, get_credential: getCredential, get_file: getFile,
  get_revision: getRevision, resolve_provider_identity: resolveProviderIdentity,
  consume_started_provider: consumeStartedProvider,
  persist_provider_attempt: persistProviderAttempt,
  replacement, release_revision_ids: releaseRevisionIds,
  fetch: fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (!trustedProfile || typeof getCredential !== "function" || typeof getFile !== "function" ||
    typeof getRevision !== "function" || typeof resolveProviderIdentity !== "function" || typeof consumeStartedProvider !== "function" ||
    typeof persistProviderAttempt !== "function" || typeof fetchImpl !== "function" || typeof clock !== "function" ||
    !(replacement instanceof Uint8Array) || replacement.byteLength > MAX_BYTES ||
    !Array.isArray(releaseRevisionIds) || releaseRevisionIds.length > 200 ||
    releaseRevisionIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) {
    throw new TypeError("A private native writer, durable attempt store and validated replacement are required.");
  }
  const profile = structuredClone(trustedProfile);
  const releases = Object.freeze([...releaseRevisionIds]);
  async function write(url, { method = "PATCH", body, contentType = "application/json" }, expiresAt) {
    const credential = await getCredential();
    // Writes accept either allowed profile (StorageNormalUse §2.2); any other set is refused.
    if (typeof credential?.access_token !== "string" || credential.access_token.length < 16 ||
      scopeProfile(credential.scope) === null) fail("DRIVE_NATIVE_GRANT_UNAVAILABLE");
    // Nothing awaited may intervene between this TTL check and the write.
    const now = Number(clock());
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now >= expiresAt) fail("DRIVE_NATIVE_ADMISSION_EXPIRED");
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000),
        body, headers: { "content-type": contentType, authorization: `Bearer ${credential.access_token}` } });
      if (!response.ok) fail("DRIVE_NATIVE_REQUEST_FAILED");
      return await response.json();
    } catch { fail("DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN"); }
  }
  async function targetFile(id, shape, parent) {
    const file = await getFile(id);
    if (!file || file.id !== id || file.name !== shape.name || file.trashed !== false ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent ||
      !file.mimeType || file.mimeType === FOLDER || file.mimeType.startsWith("application/vnd.google-apps.") ||
      typeof file.version !== "string") fail("DRIVE_NATIVE_TARGET_MISMATCH");
    if (file.version !== shape.destination_file_version) fail("DRIVE_NATIVE_TARGET_VERSION_MISMATCH");
    if (!contentIdentity(file)) fail("DRIVE_NATIVE_TARGET_CONTENT_UNPROVEN");
    return file;
  }
  return async function effect({ mutation, admission, profile_identity: identity }) {
    const binding = admission?.binding;
    const requestHash = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
    const shape = replaceShape(mutation);
    if (!shape || !binding || binding.request_sha256 !== requestHash || binding.profile_id !== profile.profile_id ||
      identity?.profile_id !== profile.profile_id || identity.profile_version !== profile.profile_version ||
      (mutation.content !== undefined && !isDeepStrictEqual(Buffer.from(mutation.content, "utf8"), Buffer.from(replacement)))) {
      fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    }
    const started = consumeStartedProvider(binding);
    if (!started || started.request_sha256 !== requestHash || !started.intent_id) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(before.destination_file_id ?? "") || !before.destination_parent_id ||
      before.destination_file_version !== shape.destination_file_version || before.source_file_id !== null) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const file = await targetFile(before.destination_file_id, shape, before.destination_parent_id);
    const contentBefore = contentIdentity(file), pinned = file.headRevisionId, after = contentAfter(replacement);
    if (releases.includes(pinned)) fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    // A head the Owner already keeps forever is recorded as such: Clued then
    // neither sets nor ever releases it, and it does not count toward K.
    const head = await getRevision(file.id, pinned);
    if (head?.id !== pinned || typeof head.keepForever !== "boolean") fail("DRIVE_NATIVE_TARGET_MISMATCH");
    const previouslyKept = head.keepForever;
    const attempt = Object.freeze({ contract: "clued.storage-replace-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, operation: "replace", provider_file_id: file.id,
      destination_path: shape.destination, parent_id: before.destination_parent_id,
      destination_file_version: shape.destination_file_version, content_before: contentBefore,
      pinned_revision_id: pinned, previously_kept: previouslyKept, content_after: after, restore_job_id: shape.restore_job_id,
      release_revision_ids: releases, target_kind: "file", binding: structuredClone(binding) });
    await persistProviderAttempt(attempt);
    // Recheck after the durable flush, still before the first provider write.
    if (!isDeepStrictEqual(await resolveProviderIdentity({ profile, mutation }), before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const again = await targetFile(file.id, shape, before.destination_parent_id);
    if (!isDeepStrictEqual(contentIdentity(again), contentBefore)) fail("DRIVE_NATIVE_TARGET_MISMATCH");
    const revision = (id) => `${API}/${encodeURIComponent(file.id)}/revisions/${encodeURIComponent(id)}?fields=id,keepForever`;
    if (!previouslyKept) {
      const kept = await write(revision(pinned), { body: JSON.stringify({ keepForever: true }) }, admission.expires_at_ms);
      if (kept?.id !== pinned || kept.keepForever !== true) fail("DRIVE_NATIVE_RESPONSE_MISMATCH");
    }
    const result = await write(`${UPLOAD}/${encodeURIComponent(file.id)}?uploadType=media&fields=${FIELDS}`,
      { body: replacement, contentType: file.mimeType }, admission.expires_at_ms);
    if (result?.id !== file.id || result.name !== file.name || result.trashed !== false ||
      !isDeepStrictEqual(result.parents, file.parents) || !/^[1-9]\d*$/.test(result.version ?? "") ||
      typeof result.headRevisionId !== "string" || result.headRevisionId === pinned ||
      (result.size != null && result.size !== after.size) ||
      (result.sha256Checksum != null && result.sha256Checksum !== "" && result.sha256Checksum !== after.sha256)) {
      fail("DRIVE_NATIVE_RESPONSE_MISMATCH");
    }
    // Releases are cleanup, not part of the replace: a failed or expired
    // release is left to the verifier's observation, and a pin Drive still
    // keeps stays pinned and is listed again by the next replace.
    for (const id of releases) {
      try { await write(revision(id), { body: JSON.stringify({ keepForever: false }) }, admission.expires_at_ms); } catch { /* observed later */ }
    }
    return Object.freeze({ operation: "replace", source_path: null, destination_path: shape.destination,
      provider_file_id: file.id, provider_file_version: result.version, content_before: contentBefore,
      content_after: after, pinned_revision_id: pinned, previously_kept: previouslyKept, release_revision_ids: releases,
      restore_job_id: shape.restore_job_id, intent_id: started.intent_id });
  };
}
