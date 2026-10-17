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
const fileId = /^[A-Za-z0-9_-]{1,160}$/;

/** Proof contract of each destructive operation (StorageFullCapability §6.1:
 * clued.storage-{op}-verified/1, named by the external operation). */
export const DESTRUCTIVE_PROOF_CONTRACTS = Object.freeze({
  delete: "clued.storage-trash-verified/1",
  restore: "clued.storage-untrash-verified/1",
});

/** True when `candidate` is `name` with a " (n)" suffix before its extension,
 * n from 1 to 99 (the untrash name-conflict option, Decision 7f9daf68). */
export function suffixedName(name, candidate) {
  if (typeof name !== "string" || typeof candidate !== "string") return false;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  if (candidate.length <= stem.length + ext.length + 3 || !candidate.startsWith(stem + " (") ||
    !candidate.endsWith(")" + ext)) return false;
  return /^[1-9]\d?$/.test(candidate.slice(stem.length + 2, candidate.length - ext.length - 1));
}

/** The trash/untrash shape shared by the effect and the verifier (§6.1): one
 * registered file or EMPTY directory named by its Drive ID, its source path
 * and the Drive version the caller observed. Internally trash is "delete" and
 * untrash is "restore", as the Artifact authority names them. An untrash of a
 * file may opt in to a different final location when its name is taken:
 * restore_mode "folder" (same name, another registered folder) or "suffix"
 * (same folder, "name (n).ext"); destination_path is the final path. */
export function destructiveShape(mutation) {
  const operation = mutation?.operation;
  if (!["delete", "restore"].includes(operation)) return null;
  const kind = mutation.target_kind ?? "file";
  if (!["file", "directory"].includes(kind) || typeof mutation.source_path !== "string" ||
    !/^[1-9]\d{0,39}$/.test(mutation.source_file_version ?? "") || !fileId.test(mutation.source_file_id ?? "") ||
    mutation.content !== undefined || mutation.directory_semantics !== undefined) return null;
  const bound = bindResourceCenterMutation(mutation);
  const source = bound.source_path;
  if (!source || source !== mutation.source_path || source.lastIndexOf("/") < 1) return null;
  let destination = null, mode = null;
  if (mutation.destination_path !== undefined || mutation.restore_mode !== undefined) {
    if (operation !== "restore" || kind !== "file" || !["folder", "suffix"].includes(mutation.restore_mode)) return null;
    destination = bound.destination_path;
    if (!destination || destination !== mutation.destination_path || destination.lastIndexOf("/") < 1) return null;
    const sameParent = parentOf(destination) === parentOf(source);
    if (mutation.restore_mode === "folder" ? (nameOf(destination) !== nameOf(source) || sameParent)
      : (!sameParent || !suffixedName(nameOf(source), nameOf(destination)))) return null;
    mode = mutation.restore_mode;
  }
  const final = destination ?? source;
  return Object.freeze({ operation, target_kind: kind, directory: kind === "directory", source,
    source_parent_path: parentOf(source), source_name: nameOf(source), source_file_id: mutation.source_file_id,
    source_file_version: mutation.source_file_version, destination, restore_mode: mode,
    final_path: final, final_parent_path: parentOf(final), final_name: nameOf(final),
    trashed_before: operation === "restore" });
}

/** §3.4 item 6: only the file's owner trashes it in My Drive, and Drive must
 * report the matching capability. Anything else is refused before any write
 * (PROVIDER_OWNER_REQUIRED); Clued never tries another way around it. */
export function destructiveOwnershipAllowed(operation, ownership) {
  return ownership?.owned_by_me === true &&
    (operation === "delete" ? ownership.can_trash === true : ownership.can_untrash === true);
}

/** The provider identity a destructive request must carry: the named source
 * and its folder, and for a relocating untrash the destination folder only. */
export function destructiveProviderBefore(shape, before) {
  return !!shape && !!before && before.source_file_id === shape.source_file_id &&
    before.source_file_version === shape.source_file_version && fileId.test(before.source_parent_id ?? "") &&
    before.destination_file_id === null && before.destination_file_version === null &&
    (shape.destination ? fileId.test(before.destination_parent_id ?? "") : before.destination_parent_id === null);
}

/** Private effect for the admitted, durable-started Host only. The exact
 * attempt (file ID, parents, content identity) is durably recorded BEFORE the
 * one files.update {trashed} call; there is never a files.delete. Drive has no
 * conditional update (§6.2): the item is re-read (and a directory re-checked
 * for children, trashed ones included) before and after the durable flush,
 * and the verifier re-reads after. A lost reply is inspected, never retried. */
export function createGoogleDriveNativeDestructiveEffect({
  trusted_profile: trustedProfile, get_credential: getCredential, get_file: getFile,
  get_ownership: getOwnership, has_children: hasChildren,
  resolve_provider_identity: resolveProviderIdentity,
  consume_started_provider: consumeStartedProvider,
  persist_provider_attempt: persistProviderAttempt,
  intent_marker: intentMarker = false,
  fetch: fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (!trustedProfile || typeof getCredential !== "function" || typeof getFile !== "function" ||
    typeof getOwnership !== "function" || typeof hasChildren !== "function" ||
    typeof resolveProviderIdentity !== "function" || typeof consumeStartedProvider !== "function" ||
    typeof persistProviderAttempt !== "function" || typeof fetchImpl !== "function" || typeof clock !== "function" ||
    typeof intentMarker !== "boolean") {
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
  async function sourceItem(shape, parentId) {
    const file = await getFile(shape.source_file_id);
    if (!file || file.id !== shape.source_file_id || file.name !== shape.source_name || file.trashed !== shape.trashed_before ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parentId ||
      !file.mimeType || (file.mimeType === FOLDER) !== shape.directory || typeof file.version !== "string") fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    if (file.version !== shape.source_file_version) fail("DRIVE_NATIVE_SOURCE_VERSION_MISMATCH");
    if (!shape.directory && !contentIdentity(file)) fail("DRIVE_NATIVE_SOURCE_CONTENT_UNPROVEN");
    // Google trashes a folder with everything in it: only an empty one is ever touched.
    if (shape.directory && await hasChildren(file.id)) fail("DRIVE_NATIVE_DIRECTORY_NOT_EMPTY");
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
    // §3.4 item 2, again at the effect: a governance item needs delete authority.
    if (shape.operation === "delete" && mutation.governance_class !== "ordinary" &&
      !(mutation.governance_class === "governance" && mutation.delete_authority === true)) fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    const started = consumeStartedProvider(binding);
    if (!started || started.request_sha256 !== requestHash || !started.intent_id) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider) || !destructiveProviderBefore(shape, before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const sourceParent = before.source_parent_id;
    const finalParent = shape.destination ? before.destination_parent_id : sourceParent;
    const file = await sourceItem(shape, sourceParent);
    if (!destructiveOwnershipAllowed(shape.operation, await getOwnership(file.id))) fail("PROVIDER_OWNER_REQUIRED");
    const content = shape.directory ? null : contentIdentity(file);
    const attempt = Object.freeze({ contract: "clued.storage-destructive-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, operation: shape.operation, target_kind: shape.target_kind,
      provider_file_id: file.id, source_path: shape.source, source_file_version: shape.source_file_version,
      destination_path: shape.destination, restore_mode: shape.restore_mode,
      parent_id: finalParent, content, binding: structuredClone(binding) });
    await persistProviderAttempt(attempt);
    // Recheck after the durable flush, still before the only storage update.
    if (!isDeepStrictEqual(await resolveProviderIdentity({ profile, mutation }), before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const again = await sourceItem(shape, sourceParent);
    if (!isDeepStrictEqual(shape.directory ? null : contentIdentity(again), content)) fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    // Never files.delete: only the trashed flag changes (D3), plus the opted-in
    // relocation of an untrashed file (Decision 7f9daf68).
    const trashed = shape.operation === "delete";
    const url = new URL(`${API}/${encodeURIComponent(file.id)}`);
    url.searchParams.set("fields", FIELDS);
    if (shape.restore_mode === "folder") {
      url.searchParams.set("addParents", finalParent);
      url.searchParams.set("removeParents", sourceParent);
    }
    const body = shape.restore_mode === "suffix" ? { trashed, name: shape.final_name } : { trashed };
    if (intentMarker) body.appProperties = { clued_intent_id: started.intent_id };
    const result = await patch(url.href, body, admission.expires_at_ms);
    if (result?.id !== file.id || result.name !== shape.final_name || result.trashed !== trashed ||
      !isDeepStrictEqual(result.parents, [finalParent]) || result.mimeType !== file.mimeType ||
      !/^[1-9]\d*$/.test(result.version ?? "") ||
      (!shape.directory && !isDeepStrictEqual(contentIdentity(result), content))) fail("DRIVE_NATIVE_RESPONSE_MISMATCH");
    return Object.freeze({ operation: shape.operation, target_kind: shape.target_kind, source_path: shape.source,
      destination_path: shape.destination, provider_file_id: file.id, provider_file_version: result.version,
      parent_id: finalParent, content, intent_id: started.intent_id });
  };
}
