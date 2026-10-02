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

/** At most this many registered descendants (all of them; the authority
 * refuses a larger subtree) have their Drive versions refreshed after a
 * directory move (P6.1, Decision e5e99da8). */
export const SUBTREE_REFRESH_LIMIT = 500;
/** Without a batched reader, at most this many are read one by one. */
const SINGLE_READ_LIMIT = 50;
const relativeOk = (path) => typeof path === "string" && path.length >= 1 && path.length <= 1000 && !path.includes("\\") &&
  !path.split("/").some((part) => !part || part === "." || part === "..");
const version = /^[1-9]\d{0,39}$/;

/** Every active or trashed registered descendant of the moved directory, as
 * the durable start returned it: Drive ID, path relative to the directory,
 * kind, registry state and the registered Drive version. */
export function subtreeRegistryShape(list) {
  if (!Array.isArray(list) || list.length > SUBTREE_REFRESH_LIMIT) return null;
  const ids = new Set(), paths = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object" ||
      Object.keys(item).sort().join(",") !== "provider_file_id,provider_file_version,relative_path,state,target_kind" ||
      !["active", "trashed"].includes(item.state) ||
      !fileId.test(item.provider_file_id ?? "") || ids.has(item.provider_file_id) || !relativeOk(item.relative_path) ||
      paths.has(item.relative_path) || !["file", "directory"].includes(item.target_kind) ||
      !/^\d{1,40}$/.test(item.provider_file_version ?? "")) return null;
    ids.add(item.provider_file_id); paths.add(item.relative_path);
  }
  return list.map((item) => Object.freeze({ ...item }));
}

/** The descendants recorded in the attempt: those whose live Drive state was
 * exactly what the registry says, with the content identity (size, sha256)
 * of each file. Directories carry null for both. */
export function subtreeDescendantsShape(list) {
  if (!Array.isArray(list) || list.length > SUBTREE_REFRESH_LIMIT) return null;
  const ids = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object" ||
      Object.keys(item).sort().join(",") !== "provider_file_id,provider_file_version,relative_path,sha256,size,state,target_kind" ||
      !["active", "trashed"].includes(item.state) ||
      !fileId.test(item.provider_file_id ?? "") || ids.has(item.provider_file_id) || !relativeOk(item.relative_path) ||
      !["file", "directory"].includes(item.target_kind) || !/^\d{1,40}$/.test(item.provider_file_version ?? "") ||
      (item.target_kind === "directory" ? item.size !== null || item.sha256 !== null
        : typeof item.size !== "string" || !/^(0|[1-9]\d{0,19})$/.test(item.size) ||
          typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))) return null;
    ids.add(item.provider_file_id);
  }
  return list.map((item) => Object.freeze({ ...item }));
}

/** Reads items by Drive ID: batched when a batch reader exists, otherwise
 * one by one up to SINGLE_READ_LIMIT; null when they are not read. */
async function readMany(getFile, getFiles, ids) {
  if (!ids.length) return [];
  if (typeof getFiles === "function") {
    const results = [];
    for (let index = 0; index < ids.length; index += 100) {
      const chunk = ids.slice(index, index + 100);
      const values = await getFiles(chunk);
      if (!Array.isArray(values) || values.length !== chunk.length) fail("DRIVE_LIST_INVALID");
      results.push(...values);
    }
    return results;
  }
  if (ids.length > SINGLE_READ_LIMIT) return null;
  const results = [];
  for (const id of ids) results.push(await getFile(id));
  return results;
}

// The Drive ID an item's parent must have: the moved directory for a direct
// child, otherwise the registered folder at its parent relative path.
const parentPathOf = (item) => item.relative_path.includes("/") ? item.relative_path.slice(0, item.relative_path.lastIndexOf("/")) : "";
const parentIdOf = (item, folderId, byPath) => {
  const parent = parentPathOf(item);
  return parent === "" ? folderId : byPath.get(parent)?.provider_file_id;
};
const sameItem = (file, item, parentId) => !!file && file.id === item.provider_file_id &&
  file.name === item.relative_path.slice(item.relative_path.lastIndexOf("/") + 1) && file.trashed === (item.state === "trashed") &&
  (file.mimeType === FOLDER) === (item.target_kind === "directory") && typeof parentId === "string" &&
  Array.isArray(file.parents) && file.parents.length === 1 && file.parents[0] === parentId &&
  typeof file.version === "string" && version.test(file.version);

/** P6.1, before the move: the registered descendants whose live state is
 * exactly the registry's (same Drive version, name, kind and folder), each
 * with its content identity. Anything else, or a read that fails, is left
 * out: it keeps its registered version (fail closed, as without P6.1). */
export async function observeSubtreeRegistry({ get_file: getFile, get_files: getFiles }, folderId, registry) {
  const byPath = new Map(registry.map((item) => [item.relative_path, item]));
  let live;
  try { live = await readMany(getFile, getFiles, registry.map((item) => item.provider_file_id)); } catch { return []; }
  if (!live) return [];
  // Shallowest first: an item counts only when its whole folder chain up to
  // the moved directory counted too.
  const observed = [], placed = new Set([""]);
  registry.forEach((item, index) => {
    const file = live[index];
    if (!placed.has(parentPathOf(item)) || !sameItem(file, item, parentIdOf(item, folderId, byPath)) ||
      file.version !== item.provider_file_version) return;
    if (item.target_kind === "directory") {
      if (item.state === "active") placed.add(item.relative_path);
      observed.push({ ...item, size: null, sha256: null });
    } else if (typeof file.size === "string" && /^(0|[1-9]\d{0,19})$/.test(file.size) &&
      typeof file.sha256Checksum === "string" && /^[0-9a-f]{64}$/.test(file.sha256Checksum)) {
      observed.push({ ...item, size: file.size, sha256: file.sha256Checksum });
    }
  });
  return observed;
}

/** P6.1, after the move: the new Drive version of each recorded descendant
 * that still sits at the same place with the same name, kind and content and
 * whose version did not go backwards. Anything else, or a failed read, is
 * left out and keeps its registered version. */
export async function refreshedSubtreeVersions({ get_file: getFile, get_files: getFiles }, folderId, descendants) {
  const byPath = new Map(descendants.map((item) => [item.relative_path, item]));
  let live;
  try { live = await readMany(getFile, getFiles, descendants.map((item) => item.provider_file_id)); } catch { return []; }
  if (!live) return [];
  // Shallowest first: an item counts only when its whole folder chain up to
  // the moved directory still holds.
  const refreshed = [], placed = new Set([""]);
  descendants.forEach((item, index) => {
    const file = live[index];
    if (!placed.has(parentPathOf(item)) || !sameItem(file, item, parentIdOf(item, folderId, byPath)) ||
      BigInt(file.version) < BigInt(item.provider_file_version)) return;
    if (item.target_kind === "file" && (file.size !== item.size || file.sha256Checksum !== item.sha256)) return;
    if (item.target_kind === "directory" && item.state === "active") placed.add(item.relative_path);
    refreshed.push({ provider_file_id: item.provider_file_id, provider_file_version: file.version });
  });
  return refreshed;
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
 * (chosen under the start's locks). P6.1: the attempt also records every
 * registered descendant whose live state matches the registry, with its
 * content identity, so the settlement can refresh its Drive version. A lost
 * reply is inspected, never retried.
 * @param {{trusted_profile: object, get_credential: Function, get_file: Function, get_files?: Function, resolve_provider_identity: Function, consume_started_provider: Function, persist_provider_attempt: Function, fetch?: typeof fetch, clock?: () => number}} config
 */
export function createGoogleDriveNativeDirectoryMoveEffect({
  trusted_profile: trustedProfile, get_credential: getCredential, get_file: getFile, get_files: getFiles,
  resolve_provider_identity: resolveProviderIdentity,
  consume_started_provider: consumeStartedProvider,
  persist_provider_attempt: persistProviderAttempt,
  fetch: fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (!trustedProfile || typeof getCredential !== "function" || typeof getFile !== "function" ||
    (getFiles !== undefined && typeof getFiles !== "function") ||
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
    const registry = subtreeRegistryShape(started.subtree_registry);
    if (!sample || !registry) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider) || !directoryMoveProviderBefore(shape, before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    const sourceParent = before.source_parent_id, destinationParent = before.destination_parent_id;
    await sourceFolder(shape, sourceParent);
    await checkSubtreeSample(getFile, shape.source_file_id, sample, "DRIVE_NATIVE_SUBTREE_DRIFT");
    const descendants = await observeSubtreeRegistry({ get_file: getFile, get_files: getFiles }, shape.source_file_id, registry);
    const attempt = Object.freeze({ contract: "clued.storage-subtree-move-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, operation: "move", target_kind: "directory",
      provider_file_id: shape.source_file_id, source_path: shape.source, source_file_version: shape.source_file_version,
      source_parent_id: sourceParent, destination_path: shape.destination, parent_id: destinationParent,
      subtree_sample: sample.map((item) => ({ ...item })), descendants: descendants.map((item) => ({ ...item })),
      binding: structuredClone(binding) });
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
      subtree_sample: sample.map((item) => ({ ...item })), descendants: descendants.map((item) => ({ ...item })),
      intent_id: started.intent_id });
  };
}
