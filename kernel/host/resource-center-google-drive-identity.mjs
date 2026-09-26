import { createHash } from "node:crypto";

import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER_MIME = "application/vnd.google-apps.folder";

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
} = {}) {
  const root = pathOf(managedRoot);
  if (!root || typeof rootFolderId !== "string" || !rootFolderId ||
    typeof rootParentId !== "string" || !rootParentId ||
    typeof getFile !== "function" || typeof listChildren !== "function") {
    throw new TypeError("A pinned Drive root and Host-owned metadata API are required.");
  }
  const rootName = root.slice(root.lastIndexOf("/") + 1);

  return async function resolveProviderIdentity({ profile, mutation }) {
    if (pathOf(profile?.managed_root) !== root) fail("PROVIDER_PROFILE_ROOT_MISMATCH");
    const versions = [];
    const rootFile = checkedFile(await getFile(rootFolderId), rootName, rootParentId, true);
    if (rootFile.id !== rootFolderId) fail("PROVIDER_ROOT_ID_MISMATCH");
    versions.push([rootFile.id, rootFile.version]);

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
      for (const part of parts) node = await child(node, part, true, true);
      return node;
    }

    let source = null;
    if (mutation.source_path) {
      const parts = segmentsWithin(mutation.source_path, root);
      if (parts.length === 0) fail("PROVIDER_ROOT_MUTATION_FORBIDDEN");
      const parent = await walk(parts.slice(0, -1));
      source = await child(parent, parts.at(-1), mutation.target_kind === "directory", true);
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

    return Object.freeze({
      root_folder_id: rootFolderId,
      source_file_id: source?.id ?? null,
      destination_parent_id: destinationParent?.id ?? null,
      destination_file_id: destinationFile?.id ?? null,
      provider_version: createHash("sha256").update(JSON.stringify(versions)).digest("hex"),
    });
  };
}
