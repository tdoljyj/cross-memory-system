import { createHash } from "node:crypto";

import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";
import { googleDriveAccessDigest, googleDriveSharingDigest } from "./resource-center-google-drive-sharing.mjs";

const FOLDER_MIME = "application/vnd.google-apps.folder";
// provider_version when no ancestor is matched by its Drive version.
export const EMPTY_PROVIDER_VERSION = createHash("sha256").update("clued.provider-version/empty").digest("hex");
const ANCESTOR_MATCH_MODES = new Set(["access", "sharing", "version"]);

/** The server's description of the registered directories on the way (load's
 * ancestor_match): at most 64 entries {path, provider_file_id, match}, unique
 * paths at or under the managed root. Returns null when it is not one. */
export function ancestorMatchShape(value, managedRoot) {
  const root = pathOf(managedRoot);
  if (!root || !Array.isArray(value) || value.length > 64) return null;
  const paths = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "match,path,provider_file_id" ||
      !ANCESTOR_MATCH_MODES.has(entry.match) || typeof entry.provider_file_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(entry.provider_file_id) || typeof entry.path !== "string" ||
      !(entry.path === root || entry.path.startsWith(`${root}/`)) || paths.has(entry.path)) return null;
    paths.add(entry.path);
  }
  return value.map(entry => Object.freeze({ ...entry }));
}

function fail(code) {
  throw new Error(code);
}

function pathOf(value) {
  return bindResourceCenterMutation({ destination_path: value }).destination_path;
}

function segmentsWithin(value, root) {
  const path = pathOf(value);
  if (!path || !(path === root || path.toLowerCase().startsWith(`${root.toLowerCase()}/`))) {
    fail("PROVIDER_PATH_OUTSIDE_REGISTERED_ROOT");
  }
  return path === root ? [] : path.slice(root.length + 1).split("/");
}

function checkedFile(file, expectedName, parentId, folder) {
  if (!file || typeof file !== "object" ||
    typeof file.id !== "string" || !file.id ||
    file.name !== expectedName || file.trashed !== false ||
    !Array.isArray(file.parents) || !file.parents.includes(parentId) ||
    typeof file.version !== "string" || !/^\d+$/.test(file.version) ||
    (folder && file.mimeType !== FOLDER_MIME) ||
    (!folder && file.mimeType === FOLDER_MIME)) {
    fail("PROVIDER_METADATA_MISMATCH");
  }
  return file;
}

/**
 * Resolves a mounted-path projection against live Drive file IDs. The injected
 * operations must use a Host-owned Drive credential, and list_children must
 * exhaust pagination before returning. Duplicate names, missing
 * metadata, root moves and unregistered paths all fail closed.
 */
export function createGoogleDriveProviderIdentityResolver({
  managed_root: managedRoot,
  root_folder_id: rootFolderId,
  root_parent_id: rootParentId,
  get_file: getFile,
  list_children: listChildren,
  get_sharing: getSharing,
  // Directory move (P6): every permission with its role, for the access digests.
  get_access: getAccess,
  // Untrash (StorageFullCapability P5): the Drive ID of the registered,
  // trashed source. A trashed file is never listed by name, so it is read by
  // this server-supplied ID and must still sit, trashed, under its path's parent.
  restore_source_id: restoreSourceId,
  // Storage step 3 (StorageFineGrainedConcurrency §4.2): load's
  // ancestor_match. With it, every directory walked from the root to the
  // folders the mutation works in is reported in ancestors[] with its Drive
  // ID, parent ID and the value it is matched by (access digest, sharing
  // digest or Drive version); only version-matched ones enter
  // provider_version, and the root and destination folder versions are
  // reported only when they are matched by version. Without it the identity
  // is exactly the legacy one.
  ancestor_match: ancestorMatch,
} = {}) {
  const root = pathOf(managedRoot);
  if (!root || typeof rootFolderId !== "string" || !rootFolderId ||
    typeof rootParentId !== "string" || !rootParentId ||
    typeof getFile !== "function" || typeof listChildren !== "function" ||
    (getSharing !== undefined && typeof getSharing !== "function") ||
    (getAccess !== undefined && typeof getAccess !== "function") ||
    (restoreSourceId !== undefined && (typeof restoreSourceId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(restoreSourceId))) ||
    (ancestorMatch !== undefined && ancestorMatchShape(ancestorMatch, managedRoot) === null)) {
    throw new TypeError("A pinned Drive root and Host-owned metadata API are required.");
  }
  const matchByPath = ancestorMatch === undefined ? null :
    new Map(ancestorMatchShape(ancestorMatch, managedRoot).map(entry => [entry.path, entry.match]));
  const rootName = root.slice(root.lastIndexOf("/") + 1);

  return async function resolveProviderIdentity({ profile, mutation }) {
    if (pathOf(profile?.managed_root) !== root) fail("PROVIDER_PROFILE_ROOT_MISMATCH");
    const versions = [];
    const rootFile = checkedFile(await getFile(rootFolderId), rootName, rootParentId, true);
    if (rootFile.id !== rootFolderId) fail("PROVIDER_ROOT_ID_MISMATCH");
    versions.push([rootFile.id, rootFile.version]);
    // Every folder walked on the way, by path, with the parent it was found in.
    const folders = new Map([[root, { file: rootFile, parent_id: rootParentId }]]);

    async function child(parent, name, folder, required) {
      const matches = await listChildren({ parent_id: parent.id, name });
      if (!Array.isArray(matches)) fail("PROVIDER_LIST_UNAVAILABLE");
      if (matches.length > 1) fail("PROVIDER_PATH_AMBIGUOUS");
      if (matches.length === 0) {
        if (required) fail("PROVIDER_PATH_UNREGISTERED");
        return null;
      }
      const found = checkedFile(matches[0], name, parent.id, folder);
      versions.push([found.id, found.version]);
      return found;
    }

    async function walk(parts) {
      let node = rootFile;
      for (let index = 0; index < parts.length; index++) {
        const parent = node;
        node = await child(node, parts[index], true, true);
        folders.set(`${root}/${parts.slice(0, index + 1).join("/")}`, { file: node, parent_id: parent.id });
      }
      return node;
    }

    let source = null;
    let sourceParent = null;
    if (mutation.source_path) {
      const parts = segmentsWithin(mutation.source_path, root);
      if (parts.length === 0) fail("PROVIDER_ROOT_MUTATION_FORBIDDEN");
      // A relocating untrash (restore_mode folder/suffix) never needs the
      // original folder's path: the trashed item names its own parent.
      const relocating = mutation.operation === "restore" && !!mutation.destination_path;
      const parent = relocating ? null : await walk(parts.slice(0, -1));
      sourceParent = parent;
      if (mutation.operation === "restore") {
        // The registered, trashed item is read by its ID; in place, its name
        // must be free again in its folder.
        if (!restoreSourceId) fail("PROVIDER_PATH_UNREGISTERED");
        const folder = mutation.target_kind === "directory";
        const trashed = await getFile(restoreSourceId);
        if (!trashed || trashed.id !== restoreSourceId || trashed.name !== parts.at(-1) || trashed.trashed !== true ||
          !Array.isArray(trashed.parents) || trashed.parents.length !== 1 ||
          typeof trashed.parents[0] !== "string" || (parent && trashed.parents[0] !== parent.id) ||
          typeof trashed.version !== "string" || !/^\d+$/.test(trashed.version) || (trashed.mimeType === FOLDER_MIME) !== folder) {
          fail("PROVIDER_METADATA_MISMATCH");
        }
        if (!relocating) {
          const taken = await listChildren({ parent_id: parent.id, name: parts.at(-1) });
          if (!Array.isArray(taken)) fail("PROVIDER_LIST_UNAVAILABLE");
          if (taken.length > 0) fail("PROVIDER_DESTINATION_EXISTS");
        }
        sourceParent = parent ?? { id: trashed.parents[0] };
        versions.push([trashed.id, trashed.version]);
        source = trashed;
      } else {
        // Adopt (P7) names an existing, unregistered item by its path: the
        // same exact walk, and the only item of its name in its folder.
        source = await child(parent, parts.at(-1), mutation.target_kind === "directory", true);
      }
    }

    let destinationParent = null;
    let destinationFile = null;
    if (mutation.destination_path) {
      const parts = segmentsWithin(mutation.destination_path, root);
      if (parts.length === 0) fail("PROVIDER_ROOT_MUTATION_FORBIDDEN");
      destinationParent = await walk(parts.slice(0, -1));
      const mustExist = ["write", "replace"].includes(mutation.operation);
      destinationFile = await child(destinationParent, parts.at(-1),
        mutation.target_kind === "directory", mustExist);
      if (!mustExist && destinationFile) fail("PROVIDER_DESTINATION_EXISTS");
    }

    // Registered directories are matched by sharing state instead of their
    // Drive version when the registry holds a digest (see authority_v1).
    // Without get_sharing, or when Drive omits the fields, the digest is null.
    // With ancestor_match, each folder's sharing and access are read at most
    // once per resolution; the legacy identity reads exactly as before.
    const read = new Map();
    const once = (kind, id, load) => {
      if (!matchByPath) return load();
      const key = `${kind}:${id}`;
      if (!read.has(key)) read.set(key, load());
      return read.get(key);
    };
    const sharing = async (file) => {
      if (!getSharing || !file) return null;
      return once("sharing", file.id, async () => {
        const result = await getSharing(file.id);
        return result?.id === file.id ? googleDriveSharingDigest(result) : null;
      });
    };
    const rootSharingDigest = await sharing(rootFile);
    const destinationParentSharingDigest = await sharing(destinationParent);
    // A directory move (P6) names the directory's folder and the sharing and
    // access (every permission with its role) of the directory and both
    // folders: the authority requires both folders to grant the same access,
    // and the verifier the directory's to stay unchanged.
    const directoryMove = mutation.operation === "move" && mutation.target_kind === "directory";
    const access = async (file) => {
      if (!getAccess || !file) return null;
      return once("access", file.id, async () => {
        const result = await getAccess(file.id);
        return result?.id === file.id ? googleDriveAccessDigest(result) : null;
      });
    };
    // Adopt (P7) names the item's folder with its Drive version and sharing
    // (matched like any destination folder) and, for a directory, its own
    // sharing (the authority requires the two to be equal).
    const adopt = mutation.operation === "adopt";
    const sourceSharingDigest = directoryMove || (adopt && mutation.target_kind === "directory") ? await sharing(source) : null;
    const sourceParentSharingDigest = directoryMove || adopt ? await sharing(sourceParent) : null;
    const accessDigests = directoryMove ? { source_access_digest: await access(source),
      source_parent_access_digest: await access(sourceParent),
      destination_parent_access_digest: await access(destinationParent) } : {};

    // Ancestors (step 3). A folder the server did not describe is matched by
    // version; the server refuses the set. Adopt and directory move keep
    // their legacy identity (version fields and provider_version) and never
    // report ancestors. A folder matched by its sharing digest also has its
    // access digest in ancestor_access: the server does not match it, but the
    // effects' re-resolution then notices a role-only change during the job,
    // as its Drive version did before.
    let ancestors = null, ancestorAccess = null;
    const modeOf = path => matchByPath.get(path) ?? "version";
    if (matchByPath && !directoryMove && !adopt) {
      ancestors = [];
      ancestorAccess = [];
      for (const [path, { file, parent_id: parentId }] of [...folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const match = modeOf(path);
        const value = match === "access" ? await access(file) : match === "sharing" ? await sharing(file) : file.version;
        ancestors.push(Object.freeze({ path, id: file.id, parent_id: parentId, match, value }));
        if (match === "sharing") ancestorAccess.push(Object.freeze([file.id, await access(file)]));
      }
      Object.freeze(ancestors);
      Object.freeze(ancestorAccess);
    }
    const byIdentity = ancestors !== null;
    const versionMatched = ancestors?.filter(entry => entry.match === "version").map(entry => [entry.id, entry.value]) ?? [];
    const destinationParentPath = mutation.destination_path
      ? `${root}/${segmentsWithin(mutation.destination_path, root).slice(0, -1).join("/")}`.replace(/\/$/, "") : null;

    return Object.freeze({
      root_folder_id: rootFolderId,
      root_parent_id: rootParentId,
      root_folder_version: byIdentity && modeOf(root) !== "version" ? null : rootFile.version,
      source_file_id: source?.id ?? null,
      source_file_version: source?.version ?? null,
      destination_parent_id: destinationParent?.id ?? null,
      destination_parent_version: !destinationParent ? null
        : byIdentity && modeOf(destinationParentPath) !== "version" ? null : destinationParent.version,
      destination_file_id: destinationFile?.id ?? null,
      destination_file_version: destinationFile?.version ?? null,
      provider_version: !byIdentity ? createHash("sha256").update(JSON.stringify(versions)).digest("hex")
        : versionMatched.length === 0 ? EMPTY_PROVIDER_VERSION
          : createHash("sha256").update(JSON.stringify(versionMatched)).digest("hex"),
      ...(ancestors ? { ancestors } : {}),
      ...(ancestorAccess?.length ? { ancestor_access: ancestorAccess } : {}),
      root_sharing_digest: rootSharingDigest,
      destination_parent_sharing_digest: destinationParentSharingDigest,
      // Trash and untrash name the source's folder, which the authority and
      // the verified settlement require to be its registered parent.
      ...(mutation.operation === "delete" || mutation.operation === "restore"
        ? { source_parent_id: sourceParent?.id ?? null } : {}),
      // The settlement records the source folder's sharing digest only while
      // the registry still holds this version of it (P6.2).
      ...(directoryMove ? { source_parent_id: sourceParent?.id ?? null, source_parent_version: sourceParent?.version ?? null,
        source_sharing_digest: sourceSharingDigest,
        source_parent_sharing_digest: sourceParentSharingDigest, ...accessDigests } : {}),
      ...(adopt ? { source_parent_id: sourceParent?.id ?? null, source_parent_version: sourceParent?.version ?? null,
        source_parent_sharing_digest: sourceParentSharingDigest,
        ...(mutation.target_kind === "directory" ? { source_sharing_digest: sourceSharingDigest } : {}) } : {}),
    });
  };
}
