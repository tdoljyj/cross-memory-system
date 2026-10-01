import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";
import { contentIdentity } from "./resource-center-google-drive-modify-effect.mjs";
import { scopeProfile } from "./resource-center-google-scopes.mjs";

const API = "https://www.googleapis.com/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed,size,sha256Checksum,md5Checksum,headRevisionId";
const FOLDER = "application/vnd.google-apps.folder";
const fail = (code) => { throw new Error(code); };
const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));
const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);

/** Proof contract of each destructive operation (StorageFullCapability §6.1:
 * clued.storage-{op}-verified/1, named by the external operation). */
export const DESTRUCTIVE_PROOF_CONTRACTS = Object.freeze({
  delete: "clued.storage-trash-verified/1",
  restore: "clued.storage-untrash-verified/1",
});

/** The trash/untrash shape shared by the effect and the verifier (§6.1): one
 * registered file named by its source path and the Drive version the caller
 * observed; no destination, content or directory semantics. Internally trash
 * is "delete" and untrash is "restore", as the Artifact authority names them. */
export function destructiveShape(mutation) {
  if (!["delete", "restore"].includes(mutation?.operation) || (mutation.target_kind ?? "file") !== "file" ||
    typeof mutation.source_path !== "string" || mutation.destination_path !== undefined ||
    !/^[1-9]\d{0,39}$/.test(mutation.source_file_version ?? "") || mutation.content !== undefined ||
    mutation.directory_semantics !== undefined) return null;
  const source = bindResourceCenterMutation(mutation).source_path;
  if (!source || source !== mutation.source_path || source.lastIndexOf("/") < 1) return null;
  return Object.freeze({ operation: mutation.operation, source, source_parent_path: parentOf(source),
    source_name: nameOf(source), source_file_version: mutation.source_file_version,
    trashed_before: mutation.operation === "restore" });
}

/** §3.4 item 6: only the file's owner trashes it in My Drive, and Drive must
 * report the matching capability. Anything else is refused before any write
 * (PROVIDER_OWNER_REQUIRED); Clued never tries another way around it. */
export function destructiveOwnershipAllowed(operation, ownership) {
  return ownership?.owned_by_me === true &&
    (operation === "delete" ? ownership.can_trash === true : ownership.can_untrash === true);
}

/** Private effect for the admitted, durable-started Host only. The exact
 * attempt (file ID, parent, content identity) is durably recorded BEFORE the
 * one files.update {trashed} call; there is never a files.delete. Drive has no
 * conditional update (§6.2): the file is re-read before and after the durable
 * flush, and the verifier re-reads after. A lost reply is inspected, never
 * retried. */
export function createGoogleDriveNativeDestructiveEffect({
  trusted_profile: trustedProfile, get_credential: getCredential, get_file: getFile,
  get_ownership: getOwnership,
  resolve_provider_identity: resolveProviderIdentity,
  consume_started_provider: consumeStartedProvider,
  persist_provider_attempt: persistProviderAttempt,
  fetch: fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (!trustedProfile || typeof getCredential !== "function" || typeof getFile !== "function" ||
    typeof getOwnership !== "function" ||
    typeof resolveProviderIdentity !== "function" || typeof consumeStartedProvider !== "function" ||
    typeof persistProviderAttempt !== "function" || typeof fetchImpl !== "function" || typeof clock !== "function") {
    throw new TypeError("A private native writer and durable attempt store are required.");
  }
  const profile = structuredClone(trustedProfile);
  async function patch(url, body, expiresAt) {
    const credential = await getCredential();
    // Writes accept either allowed profile (StorageNormalUse §2.2); any other set is refused.
    if (typeof credential?.access_token !== "string" || credential.access_token.length < 16 ||
      scopeProfile(credential.scope) === null) fail("DRIVE_NATIVE_GRANT_UNAVAILABLE");
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
  async function sourceFile(id, shape, parentId) {
    const file = await getFile(id);
    if (!file || file.id !== id || file.name !== shape.source_name || file.trashed !== shape.trashed_before ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parentId ||
      !file.mimeType || file.mimeType === FOLDER || typeof file.version !== "string") fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    if (file.version !== shape.source_file_version) fail("DRIVE_NATIVE_SOURCE_VERSION_MISMATCH");
    if (!contentIdentity(file)) fail("DRIVE_NATIVE_SOURCE_CONTENT_UNPROVEN");
    return file;
  }
  return async function effect({ mutation, admission, profile_identity: identity }) {
    const binding = admission?.binding;
    const requestHash = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
    const shape = destructiveShape(mutation);
    if (!shape || !binding || binding.request_sha256 !== requestHash || binding.profile_id !== profile.profile_id ||
      identity?.profile_id !== profile.profile_id || identity.profile_version !== profile.profile_version) {
      fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    }
    // §3.4 item 2, again at the effect: a governance file needs delete authority.
    if (shape.operation === "delete" && mutation.governance_class !== "ordinary" &&
      !(mutation.governance_class === "governance" && mutation.delete_authority === true)) fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    const started = consumeStartedProvider(binding);
    if (!started || started.request_sha256 !== requestHash || !started.intent_id) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(before.source_file_id ?? "") || before.source_file_version !== shape.source_file_version ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(before.source_parent_id ?? "") || before.destination_parent_id !== null ||
      before.destination_file_id !== null) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const parentId = before.source_parent_id;
    const file = await sourceFile(before.source_file_id, shape, parentId);
    if (!destructiveOwnershipAllowed(shape.operation, await getOwnership(file.id))) fail("PROVIDER_OWNER_REQUIRED");
    const content = contentIdentity(file);
    const attempt = Object.freeze({ contract: "clued.storage-destructive-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, operation: shape.operation,
      provider_file_id: file.id, source_path: shape.source, source_file_version: shape.source_file_version,
      parent_id: parentId, target_kind: "file", content, binding: structuredClone(binding) });
    await persistProviderAttempt(attempt);
    // Recheck after the durable flush, still before the only storage update.
    if (!isDeepStrictEqual(await resolveProviderIdentity({ profile, mutation }), before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const again = await sourceFile(file.id, shape, parentId);
    if (!isDeepStrictEqual(contentIdentity(again), content)) fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    // Never files.delete: only the trashed flag changes (D3).
    const trashed = shape.operation === "delete";
    const result = await patch(`${API}/${encodeURIComponent(file.id)}?fields=${FIELDS}`, { trashed }, admission.expires_at_ms);
    if (result?.id !== file.id || result.name !== shape.source_name || result.trashed !== trashed ||
      !isDeepStrictEqual(result.parents, [parentId]) || result.mimeType !== file.mimeType ||
      !/^[1-9]\d*$/.test(result.version ?? "") || !isDeepStrictEqual(contentIdentity(result), content)) fail("DRIVE_NATIVE_RESPONSE_MISMATCH");
    return Object.freeze({ operation: shape.operation, source_path: shape.source, provider_file_id: file.id,
      provider_file_version: result.version, parent_id: parentId, content, intent_id: started.intent_id });
  };
}
