import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const API = "https://www.googleapis.com/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed,size,sha256Checksum,md5Checksum,headRevisionId";
const FOLDER = "application/vnd.google-apps.folder";
const fail = (code) => { throw new Error(code); };
const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));
const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);

/** Content identity of a stored (non Google-native) file: size, head
 * revision and at least one checksum. A rename or move must not change it;
 * a concurrent edit would, and is then never settled (§6.1, T5). */
export function contentIdentity(file) {
  const value = { size: file?.size ?? null, sha256: file?.sha256Checksum ?? null, md5: file?.md5Checksum ?? null,
    head_revision_id: file?.headRevisionId ?? null };
  return /^(0|[1-9]\d{0,19})$/.test(value.size ?? "") && /^[A-Za-z0-9_-]{1,200}$/.test(value.head_revision_id ?? "") &&
    (value.sha256 === null || /^[0-9a-f]{64}$/.test(value.sha256)) && (value.md5 === null || /^[0-9a-f]{32}$/.test(value.md5)) &&
    (value.sha256 !== null || value.md5 !== null) ? Object.freeze(value) : null;
}

/** The rename/move shape shared by the effect and the verifier
 * (StorageFullCapability §6.1): one registered file, a rename keeps the parent
 * and changes the name, a move keeps the name and changes the parent. */
export function modifyShape(mutation) {
  if (!["rename", "move"].includes(mutation?.operation) || (mutation.target_kind ?? "file") !== "file" ||
    typeof mutation.source_path !== "string" || typeof mutation.destination_path !== "string" ||
    !/^[1-9]\d{0,39}$/.test(mutation.source_file_version ?? "") || mutation.content !== undefined ||
    mutation.directory_semantics !== undefined) return null;
  const bound = bindResourceCenterMutation(mutation);
  const source = bound.source_path, destination = bound.destination_path;
  if (!source || !destination || source !== mutation.source_path || destination !== mutation.destination_path) return null;
  const sameParent = parentOf(source) === parentOf(destination), sameName = nameOf(source) === nameOf(destination);
  if (mutation.operation === "rename" ? !sameParent || sameName : sameParent || !sameName) return null;
  return Object.freeze({ operation: mutation.operation, source, destination,
    source_name: nameOf(source), destination_name: nameOf(destination), source_file_version: mutation.source_file_version });
}

/** Private effect for the admitted, durable-started Host only. The exact
 * attempt (file ID, both parents, both paths) is durably recorded BEFORE the
 * one files.update call. Drive has no conditional update (§6.2): the source is
 * re-read before and after the durable flush, and the verifier re-reads after.
 * A lost reply is inspected, never retried. */
export function createGoogleDriveNativeModifyEffect({
  trusted_profile: trustedProfile, get_credential: getCredential, get_file: getFile,
  resolve_provider_identity: resolveProviderIdentity,
  consume_started_provider: consumeStartedProvider,
  persist_provider_attempt: persistProviderAttempt,
  fetch: fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (!trustedProfile || typeof getCredential !== "function" || typeof getFile !== "function" ||
    typeof resolveProviderIdentity !== "function" || typeof consumeStartedProvider !== "function" ||
    typeof persistProviderAttempt !== "function" || typeof fetchImpl !== "function" || typeof clock !== "function") {
    throw new TypeError("A private native writer and durable attempt store are required.");
  }
  const profile = structuredClone(trustedProfile);
  async function patch(url, body, expiresAt) {
    const credential = await getCredential();
    const grants = new Set(credential?.scope?.split(/\s+/));
    if (typeof credential?.access_token !== "string" || credential.access_token.length < 16 ||
      !grants.has("https://www.googleapis.com/auth/drive.file") ||
      !grants.has("https://www.googleapis.com/auth/drive.metadata.readonly")) fail("DRIVE_NATIVE_GRANT_UNAVAILABLE");
    // Nothing awaited may intervene between this TTL check and the only update.
    const now = Number(clock());
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now >= expiresAt) fail("DRIVE_NATIVE_ADMISSION_EXPIRED");
    let response;
    try {
      response = await fetchImpl(url, { method: "PATCH", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(10000), body: JSON.stringify(body),
        headers: { "content-type": "application/json", authorization: `Bearer ${credential.access_token}` } });
      if (!response.ok) fail("DRIVE_NATIVE_REQUEST_FAILED");
      return await response.json();
    } catch { fail("DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN"); }
  }
  async function sourceFile(id, shape) {
    const file = await getFile(id);
    if (!file || file.id !== id || file.name !== shape.source_name || file.trashed !== false ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || typeof file.parents[0] !== "string" ||
      !file.mimeType || file.mimeType === FOLDER || typeof file.version !== "string") fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    if (file.version !== shape.source_file_version) fail("DRIVE_NATIVE_SOURCE_VERSION_MISMATCH");
    if (!contentIdentity(file)) fail("DRIVE_NATIVE_SOURCE_CONTENT_UNPROVEN");
    return file;
  }
  return async function effect({ mutation, admission, profile_identity: identity }) {
    const binding = admission?.binding;
    const requestHash = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
    const shape = modifyShape(mutation);
    if (!shape || !binding || binding.request_sha256 !== requestHash || binding.profile_id !== profile.profile_id ||
      identity?.profile_id !== profile.profile_id || identity.profile_version !== profile.profile_version) {
      fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    }
    const started = consumeStartedProvider(binding);
    if (!started || started.request_sha256 !== requestHash || !started.intent_id) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(before.source_file_id ?? "") || before.source_file_version !== shape.source_file_version ||
      !before.destination_parent_id || before.destination_file_id !== null) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const file = await sourceFile(before.source_file_id, shape);
    const sourceParent = file.parents[0], destinationParent = before.destination_parent_id, content = contentIdentity(file);
    if ((shape.operation === "rename") !== (sourceParent === destinationParent)) fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    const attempt = Object.freeze({ contract: "clued.storage-modify-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, operation: shape.operation,
      provider_file_id: file.id, source_path: shape.source, source_file_version: shape.source_file_version,
      source_parent_id: sourceParent, destination_path: shape.destination, parent_id: destinationParent,
      target_kind: "file", content, binding: structuredClone(binding) });
    await persistProviderAttempt(attempt);
    // Recheck after the durable flush, still before the only storage update.
    if (!isDeepStrictEqual(await resolveProviderIdentity({ profile, mutation }), before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const again = await sourceFile(file.id, shape);
    if (again.parents[0] !== sourceParent || !isDeepStrictEqual(contentIdentity(again), content)) fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    const url = `${API}/${encodeURIComponent(file.id)}?fields=${FIELDS}` + (shape.operation === "move"
      ? `&addParents=${encodeURIComponent(destinationParent)}&removeParents=${encodeURIComponent(sourceParent)}` : "");
    const result = await patch(url, shape.operation === "rename" ? { name: shape.destination_name } : {}, admission.expires_at_ms);
    if (result?.id !== file.id || result.name !== shape.destination_name || result.trashed !== false ||
      !isDeepStrictEqual(result.parents, [destinationParent]) || result.mimeType !== file.mimeType ||
      !/^[1-9]\d*$/.test(result.version ?? "") || !isDeepStrictEqual(contentIdentity(result), content)) fail("DRIVE_NATIVE_RESPONSE_MISMATCH");
    return Object.freeze({ operation: shape.operation, source_path: shape.source, destination_path: shape.destination,
      provider_file_id: file.id, provider_file_version: result.version, content, intent_id: started.intent_id });
  };
}
