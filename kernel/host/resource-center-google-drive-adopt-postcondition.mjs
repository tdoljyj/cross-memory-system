import { adoptShape, adoptItemAllowed, adoptProviderBefore } from "./resource-center-google-drive-adopt-effect.mjs";
import { googleDriveSharingDigest } from "./resource-center-google-drive-sharing.mjs";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const normalized = (value) => bindResourceCenterMutation({ destination_path: value }).destination_path;
const fail = (code) => { throw new Error(code); };

/** Host-owned adopt verifier (StorageFullCapability §6.3). Reads metadata
 * only. Success requires the item, by its Drive ID, to be the only entry of
 * its name in its folder, under the same registered ancestor IDs, still at the
 * Drive version the authority saw (read twice), owned by this account, not a
 * shortcut and, for a directory, with exactly its folder's sharing state.
 * Anything else leaves the item unregistered; nothing in Drive changed.
 * @param {{managed_root: string, root_folder_id: string, root_parent_id: string, get_file: Function, list_children: Function, get_ownership: Function, get_sharing: Function, include_verified_proof?: boolean}} config
 */
export function createGoogleDriveAdoptPostconditionVerifier({
  managed_root: managedRoot, root_folder_id: rootId, root_parent_id: rootParentId,
  get_file: getFile, list_children: listChildren, get_ownership: getOwnership, get_sharing: getSharing,
  include_verified_proof: includeVerifiedProof = false,
} = {}) {
  const root = normalized(managedRoot);
  if (!root || !rootId || !rootParentId || typeof getFile !== "function" || typeof listChildren !== "function" ||
    typeof getOwnership !== "function" || typeof getSharing !== "function" || typeof includeVerifiedProof !== "boolean") {
    throw new TypeError("Pinned Drive identity and a metadata API are required.");
  }
  const folderCheck = (file, id, name, parent) => {
    if (!file || file.id !== id || file.name !== name || file.trashed !== false || file.mimeType !== FOLDER ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent ||
      typeof file.version !== "string" || !/^[1-9]\d*$/.test(file.version)) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
  };
  const sharing = async (id) => {
    const result = await getSharing(id);
    return result?.id === id ? googleDriveSharingDigest(result) : null;
  };
  return async function verify({ profile, mutation, provider_before: before, effect_result: effect }) {
    const shape = adoptShape(mutation);
    if (!shape || normalized(profile?.managed_root) !== root || !shape.source.startsWith(root + "/") ||
      before?.root_folder_id !== rootId || before.root_parent_id !== rootParentId || !adoptProviderBefore(shape, before) ||
      effect?.operation !== "adopt" || effect.source_path !== shape.source || effect.provider_file_id !== shape.source_file_id ||
      effect.provider_file_version !== before.source_file_version ||
      (shape.directory && (typeof before.source_sharing_digest !== "string" ||
        before.source_sharing_digest !== before.source_parent_sharing_digest))) {
      fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    }
    const parts = shape.source.slice(root.length + 1).split("/");
    parts.pop();
    // The chain to the item's folder is the same: root ID under its pinned
    // parent, each folder by name and parent, the folder the identity named.
    let node = await getFile(rootId);
    folderCheck(node, rootId, root.slice(root.lastIndexOf("/") + 1), rootParentId);
    for (const part of parts) {
      const matches = await listChildren({ parent_id: node.id, name: part });
      if (!Array.isArray(matches) || matches.length !== 1) fail("DRIVE_POSTCONDITION_PARENT_AMBIGUOUS");
      folderCheck(matches[0], matches[0].id, part, node.id);
      node = matches[0];
    }
    if (node.id !== before.source_parent_id) fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
    const listed = await listChildren({ parent_id: node.id, name: shape.name });
    if (!Array.isArray(listed) || listed.length !== 1 || listed[0]?.id !== shape.source_file_id) fail("DRIVE_POSTCONDITION_DESTINATION_AMBIGUOUS");
    const observe = async () => {
      const file = await getFile(shape.source_file_id);
      if (!adoptItemAllowed(shape, file, await getOwnership(shape.source_file_id)) || file.parents[0] !== node.id)
        fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
      if (file.version !== before.source_file_version) fail("DRIVE_POSTCONDITION_VERSION_CHANGED");
      return file;
    };
    await observe();
    let digest = null;
    if (shape.directory) {
      digest = await sharing(shape.source_file_id);
      if (digest === null || digest !== before.source_sharing_digest || await sharing(node.id) !== digest) fail("DRIVE_POSTCONDITION_SHARING_CHANGED");
    }
    // Stable across two reads (the listing too).
    if (listed[0].version !== undefined && listed[0].version !== before.source_file_version) fail("DRIVE_POSTCONDITION_VERSION_CHANGED");
    await observe();
    const postcondition = { path: shape.source, parent_id: node.id,
      provider_file_id: shape.source_file_id, provider_file_version: before.source_file_version };
    if (!includeVerifiedProof) return Object.freeze(postcondition);
    const verifiedProof = Object.freeze({ contract: "clued.storage-adopt-verified/1", ...postcondition, operation: "adopt",
      target_kind: shape.target_kind, provider_before: structuredClone(before),
      checks: Object.freeze({ identity: true, ancestors: true, stable_state: true, unique_name: true, owned_by_me: true,
        not_shortcut: true, ...(shape.directory ? { sharing_matches_parent: true } : {}) }),
      ...(shape.directory ? { provider_sharing_digest: digest } : {}) });
    return Object.freeze({ ...postcondition, verified_proof: verifiedProof });
  };
}
