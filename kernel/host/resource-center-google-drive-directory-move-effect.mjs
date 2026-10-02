import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";
import { scopeProfile } from "./resource-center-google-scopes.mjs";

const API = "https://www.googleapis.com/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed";
const FOLDER = "application/vnd.google-apps.folder";
const fail = (code) => { throw new Error(code); };
const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));
const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);
const fileId = /^[A-Za-z0-9_-]{1,160}$/;
const digest = /^[0-9a-f]{64}$/;
/** The exact submitted fields; the Host adds only its own authority fields. */
export const DIRECTORY_MOVE_KEYS = Object.freeze(["destination_path", "operation", "source_file_id", "source_file_version",
  "source_path", "target_kind"]);
const otherCallerFields = ["content", "directory_semantics", "destination_file_version", "restore_job_id", "content_ref", "restore_mode"];

/** At most this many registered descendants are re-read after a directory
 * move (StorageFullCapability §6.2: subtree paths sampled). The server picks
 * them: shallowest first, then by path. */
export const SUBTREE_SAMPLE_LIMIT = 10;

/** The directory move shape (StorageFullCapability P6, §3.1 modify_subtree):
 * one registered directory named by its Drive ID, its path and the Drive
 * version the caller observed, moved to another registered folder under the
 * same name. Never into itself or below itself. */
export function directoryMoveShape(mutation) {
  if (mutation?.operation !== "move" || mutation.target_kind !== "directory" ||
    otherCallerFields.some((key) => mutation[key] !== undefined) ||
    typeof mutation.source_path !== "string" || typeof mutation.destination_path !== "string" ||
    !/^[1-9]\d{0,39}$/.test(mutation.source_file_version ?? "") || !fileId.test(mutation.source_file_id ?? "")) return null;
  const bound = bindResourceCenterMutation(mutation);
  const source = bound.source_path, destination = bound.destination_path;
  if (!source || !destination || source !== mutation.source_path || destination !== mutation.destination_path ||
    source.lastIndexOf("/") < 1 || destination.lastIndexOf("/") < 1 ||
    parentOf(source) === parentOf(destination) || nameOf(source) !== nameOf(destination) ||
    destination === source || destination.startsWith(source + "/")) return null;
  return Object.freeze({ operation: "move", target_kind: "directory", source, destination,
    source_parent_path: parentOf(source), destination_parent_path: parentOf(destination), name: nameOf(source),
    source_file_id: mutation.source_file_id, source_file_version: mutation.source_file_version });
}

/** The server-chosen registered descendants a directory move re-reads, each
 * by Drive ID and its path relative to the moved directory. */
export function subtreeSampleShape(sample) {
  if (!Array.isArray(sample) || sample.length > SUBTREE_SAMPLE_LIMIT) return null;
  const seen = new Set();
  for (const item of sample) {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "provider_file_id,relative_path,target_kind" ||
      !fileId.test(item.provider_file_id ?? "") || seen.has(item.provider_file_id) ||
      !["file", "directory"].includes(item.target_kind) || typeof item.relative_path !== "string" ||
      item.relative_path.length < 1 || item.relative_path.length > 1000 ||
      item.relative_path.split("/").some((part) => !part || part === "." || part === "..") ||
      item.relative_path.includes("\\")) return null;
    seen.add(item.provider_file_id);
  }
  return sample.map((item) => Object.freeze({ ...item }));
}

/** The provider identity a directory move must carry: the named directory,
 * its registered folder, the destination folder, and the sharing and access
 * (every permission with its role) of the directory and both folders. Both
 * folders must grant exactly the same access, so the moved subtree's
 * inherited access does not change. */
export function directoryMoveProviderBefore(shape, before) {
  return !!shape && !!before && before.source_file_id === shape.source_file_id &&
    before.source_file_version === shape.source_file_version && fileId.test(before.source_parent_id ?? "") &&
    fileId.test(before.destination_parent_id ?? "") && before.destination_parent_id !== before.source_parent_id &&
    before.destination_parent_id !== shape.source_file_id &&
    before.destination_file_id === null && before.destination_file_version === null &&
    digest.test(before.source_sharing_digest ?? "") && digest.test(before.source_parent_sharing_digest ?? "") &&
    before.source_parent_sharing_digest === before.destination_parent_sharing_digest &&
    digest.test(before.source_access_digest ?? "") && digest.test(before.source_parent_access_digest ?? "") &&
    before.source_parent_access_digest === before.destination_parent_access_digest;
}

/** Each sampled registered descendant sits, by Drive ID, at its path
 * relative to the folder `folderId`: its own name and kind, then each folder
 * up to that folder. Checked before the move (a drifted registry is refused
 * with no effect) and after it (the verifier). Throws `code` otherwise. */
export async function checkSubtreeSample(getFile, folderId, sample, code) {
  for (const item of sample) {
    const segments = item.relative_path.split("/");
    let node = await getFile(item.provider_file_id);
    if (!node || node.id !== item.provider_file_id || node.name !== segments.at(-1) || node.trashed !== false ||
      (node.mimeType === FOLDER) !== (item.target_kind === "directory") ||
      !Array.isArray(node.parents) || node.parents.length !== 1 || typeof node.parents[0] !== "string") fail(code);
    for (let index = segments.length - 2; index >= 0; index -= 1) {
      const parentId = node.parents[0];
      node = await getFile(parentId);
      if (!node || node.id !== parentId || node.name !== segments[index] || node.trashed !== false ||
        node.mimeType !== FOLDER || !Array.isArray(node.parents) || node.parents.length !== 1 ||
        typeof node.parents[0] !== "string") fail(code);
    }
    if (node.parents[0] !== folderId) fail(code);
  }
}

/** Private effect for the admitted, durable-started Host only. The exact
 * attempt (directory ID, both folders, both paths and the server-chosen
 * descendants to re-read) is durably recorded BEFORE the one files.update
 * call. Drive has no conditional update (§6.2): the directory and the sampled
 * descendants are re-read before and after the durable flush, and the
 * verifier re-reads after. The sample is the one the durable start returned
 * (chosen under the start's locks). A lost reply is inspected, never retried.
 * @param {{trusted_profile: object, get_credential: Function, get_file: Function, resolve_provider_identity: Function, consume_started_provider: Function, persist_provider_attempt: Function, fetch?: typeof fetch, clock?: () => number}} config
 */
export function createGoogleDriveNativeDirectoryMoveEffect({
  trusted_profile: trustedProfile, get_credential: getCredential, get_file: getFile,
  resolve_provider_identity: resolveProviderIdentity,
  consume_started_provider: consumeStartedProvider,
  persist_provider_attempt: persistProviderAttempt,
  fetch: fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (!trustedProfile || typeof getCredential !== "function" || typeof getFile !== "function" ||
    typeof resolveProviderIdentity !== "function" || typeof consumeStartedProvider !== "function" ||
    typeof persistProviderAttempt !== "function" ||
    typeof fetchImpl !== "function" || typeof clock !== "function") {
    throw new TypeError("A private native writer and durable attempt store are required.");
  }
  const profile = structuredClone(trustedProfile);
  async function patch(url, expiresAt) {
    const credential = await getCredential();
    if (typeof credential?.access_token !== "string" || credential.access_token.length < 16 ||
      scopeProfile(credential.scope) === null) fail("DRIVE_NATIVE_GRANT_UNAVAILABLE");
    // Nothing awaited may intervene between this TTL check and the only update.
    const now = Number(clock());
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now >= expiresAt) fail("DRIVE_NATIVE_ADMISSION_EXPIRED");
    let response;
    try {
      response = await fetchImpl(url, { method: "PATCH", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(10000), body: "{}",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential.access_token}` } });
      if (!response.ok) fail("DRIVE_NATIVE_REQUEST_FAILED");
      return await response.json();
    } catch { fail("DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN"); }
  }
  async function sourceFolder(shape, parentId) {
    const file = await getFile(shape.source_file_id);
    if (!file || file.id !== shape.source_file_id || file.name !== shape.name || file.trashed !== false ||
      file.mimeType !== FOLDER || !isDeepStrictEqual(file.parents, [parentId]) || typeof file.version !== "string") {
      fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    }
    if (file.version !== shape.source_file_version) fail("DRIVE_NATIVE_SOURCE_VERSION_MISMATCH");
    return file;
  }
  return async function effect({ mutation, admission, profile_identity: identity }) {
    const binding = admission?.binding;
    const requestHash = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
    const shape = directoryMoveShape(mutation);
    if (!shape || !binding || binding.request_sha256 !== requestHash || binding.profile_id !== profile.profile_id ||
      identity?.profile_id !== profile.profile_id || identity.profile_version !== profile.profile_version) {
      fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    }
    const started = consumeStartedProvider(binding);
    if (!started || started.request_sha256 !== requestHash || !started.intent_id) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const sample = subtreeSampleShape(started.subtree_sample);
    if (!sample) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider) || !directoryMoveProviderBefore(shape, before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const sourceParent = before.source_parent_id, destinationParent = before.destination_parent_id;
    await sourceFolder(shape, sourceParent);
    await checkSubtreeSample(getFile, shape.source_file_id, sample, "DRIVE_NATIVE_SUBTREE_DRIFT");
    const attempt = Object.freeze({ contract: "clued.storage-subtree-move-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, operation: "move", target_kind: "directory",
      provider_file_id: shape.source_file_id, source_path: shape.source, source_file_version: shape.source_file_version,
      source_parent_id: sourceParent, destination_path: shape.destination, parent_id: destinationParent,
      subtree_sample: sample.map((item) => ({ ...item })), binding: structuredClone(binding) });
    await persistProviderAttempt(attempt);
    // Recheck after the durable flush, still before the only storage update.
    if (!isDeepStrictEqual(await resolveProviderIdentity({ profile, mutation }), before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    await sourceFolder(shape, sourceParent);
    await checkSubtreeSample(getFile, shape.source_file_id, sample, "DRIVE_NATIVE_SUBTREE_DRIFT");
    const url = `${API}/${encodeURIComponent(shape.source_file_id)}?fields=${FIELDS}` +
      `&addParents=${encodeURIComponent(destinationParent)}&removeParents=${encodeURIComponent(sourceParent)}`;
    const result = await patch(url, admission.expires_at_ms);
    if (result?.id !== shape.source_file_id || result.name !== shape.name || result.trashed !== false ||
      result.mimeType !== FOLDER || !isDeepStrictEqual(result.parents, [destinationParent]) ||
      !/^[1-9]\d*$/.test(result.version ?? "")) fail("DRIVE_NATIVE_RESPONSE_MISMATCH");
    return Object.freeze({ operation: "move", target_kind: "directory", source_path: shape.source,
      destination_path: shape.destination, provider_file_id: shape.source_file_id, provider_file_version: result.version,
      subtree_sample: sample.map((item) => ({ ...item })), intent_id: started.intent_id });
  };
}
