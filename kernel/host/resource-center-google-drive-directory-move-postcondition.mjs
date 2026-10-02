import { checkSubtreeSample, directoryMoveProviderBefore, directoryMoveShape, refreshedSubtreeVersions, subtreeDescendantsShape,
  subtreeSampleShape } from "./resource-center-google-drive-directory-move-effect.mjs";
import { googleDriveAccessDigest, googleDriveSharingDigest } from "./resource-center-google-drive-sharing.mjs";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const normalized = (value) => bindResourceCenterMutation({ destination_path: value }).destination_path;
const fail = (code) => { throw new Error(code); };

/** Host-owned directory move verifier (StorageFullCapability P6, §6.2). Reads
 * metadata only and never changes or retries storage. Success requires the
 * directory, by its provider ID, to be the only entry of its name in the
 * destination folder, with exactly that parent, the same registered ancestor
 * IDs and the same sharing state as before; to be no longer listed in its old
 * folder; the same access (every permission with its role) as before; each server-chosen registered descendant to still sit, by Drive ID,
 * at its path relative to the moved directory; and the directory's version
 * to be stable across two reads. Folder versions are not pinned: Drive may
 * advance them when children change. Anything else leaves the intent fenced,
 * and the registry is never rewritten from a partial observation (T14).
 * P6.1: the proof also names the new Drive version of each descendant the
 * attempt recorded that still sits at the same place with the same name, kind
 * and content (descendant_versions); the settlement refreshes those. Those
 * reads have their own budget (refresh_ms, never past the verifier's
 * deadline): what is not read in time keeps its registered version, and the
 * proof is not lost to them.
 * @param {{managed_root: string, root_folder_id: string, root_parent_id: string, get_file: Function, get_files?: Function, list_children: Function, get_sharing: Function, get_access: Function, include_verified_proof?: boolean, timeout_ms?: number, poll_ms?: number, refresh_ms?: number, clock?: () => number, sleep?: Function}} config
 */
export function createGoogleDriveDirectoryMovePostconditionVerifier({
  managed_root: managedRoot, root_folder_id: rootId, root_parent_id: rootParentId,
  get_file: getFile, get_files: getFiles, list_children: listChildren, get_sharing: getSharing, get_access: getAccess,
  include_verified_proof: includeVerifiedProof = false,
  timeout_ms: timeoutMs = 30_000, poll_ms: pollMs = 1000, refresh_ms: refreshMs = 10_000,
  clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const root = normalized(managedRoot);
  if (!root || !rootId || !rootParentId || typeof getFile !== "function" || typeof listChildren !== "function" ||
    typeof getSharing !== "function" || typeof getAccess !== "function" ||
    (getFiles !== undefined && typeof getFiles !== "function") ||
    typeof clock !== "function" || typeof sleep !== "function" || typeof includeVerifiedProof !== "boolean" ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
    !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs ||
    !Number.isInteger(refreshMs) || refreshMs < 1 || refreshMs > 60_000) {
    throw new TypeError("Pinned Drive identity, metadata and sharing API and bounded polling are required.");
  }
  const folderCheck = (file, id, name, parent) => {
    if (!file || file.id !== id || file.name !== name || file.trashed !== false || file.mimeType !== FOLDER ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent ||
      typeof file.version !== "string" || !/^[1-9]\d*$/.test(file.version)) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
  };
  return async function verify({ profile, mutation, provider_before: before, effect_result: effect }) {
    const shape = directoryMoveShape(mutation);
    const sample = subtreeSampleShape(effect?.subtree_sample);
    // An attempt stored before P6.1 has no descendants: its proof names no
    // refresh, exactly as it was recorded.
    const legacy = effect?.descendants === undefined;
    const descendants = legacy ? [] : subtreeDescendantsShape(effect.descendants);
    if (!shape || !sample || !descendants || normalized(profile?.managed_root) !== root ||
      !shape.source.startsWith(root + "/") || !shape.destination.startsWith(root + "/") ||
      effect?.operation !== "move" || effect.target_kind !== "directory" ||
      effect.source_path !== shape.source || effect.destination_path !== shape.destination ||
      effect.provider_file_id !== shape.source_file_id ||
      before?.root_folder_id !== rootId || before.root_parent_id !== rootParentId || !directoryMoveProviderBefore(shape, before)) {
      fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    }
    const folderId = shape.source_file_id, name = shape.name;
    const parts = shape.destination_parent_path === root ? [] : shape.destination_parent_path.slice(root.length + 1).split("/");
    // The chain to the destination folder is the same: root ID under its
    // pinned parent, each folder by name and parent, the destination ID.
    async function parentIdentity() {
      let node = await getFile(rootId);
      folderCheck(node, rootId, root.slice(root.lastIndexOf("/") + 1), rootParentId);
      for (const part of parts) {
        const matches = await listChildren({ parent_id: node.id, name: part });
        if (!Array.isArray(matches) || matches.length !== 1) fail("DRIVE_POSTCONDITION_PARENT_AMBIGUOUS");
        folderCheck(matches[0], matches[0].id, part, node.id);
        node = matches[0];
      }
      if (node.id !== before.destination_parent_id) fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
      return node;
    }
    async function observe(parent) {
      const matches = await listChildren({ parent_id: parent.id, name });
      if (!Array.isArray(matches) || matches.length > 1) fail("DRIVE_POSTCONDITION_DESTINATION_AMBIGUOUS");
      if (matches.length === 0) return null;
      if (matches[0].id !== folderId) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
      const file = await getFile(folderId);
      folderCheck(file, folderId, name, parent.id);
      return { listed: matches[0], file };
    }
    // The moved directory keeps its sharing: both folders had the same access.
    async function sharingUnchanged() {
      const sharing = await getSharing(folderId);
      if (sharing?.id !== folderId || googleDriveSharingDigest(sharing) !== before.source_sharing_digest) {
        fail("DRIVE_POSTCONDITION_SHARING_CHANGED");
      }
      const access = await getAccess(folderId);
      if (access?.id !== folderId || googleDriveAccessDigest(access) !== before.source_access_digest) {
        fail("DRIVE_POSTCONDITION_SHARING_CHANGED");
      }
    }
    // Each sampled registered descendant still sits at its relative path.
    const subtreeConsistent = () => checkSubtreeSample(getFile, folderId, sample, "DRIVE_POSTCONDITION_SUBTREE_MISMATCH");
    const deadline = clock() + timeoutMs;
    const attempts = Math.ceil(timeoutMs / pollMs) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const parent = await parentIdentity();
      const seen = await observe(parent);
      if (seen && seen.listed.version === seen.file.version) {
        // The old folder must no longer list it. A name index may lag: a
        // leftover old entry is re-read, not failed.
        const vacated = await listChildren({ parent_id: before.source_parent_id, name });
        if (!Array.isArray(vacated)) fail("DRIVE_LIST_INVALID");
        const stillListed = vacated.some((entry) => entry?.id === folderId);
        if (!stillListed) {
          await sharingUnchanged();
          await subtreeConsistent();
          await parentIdentity();
          const again = await observe(parent);
          if (again && again.file.version === seen.file.version && again.listed.version === seen.file.version) {
            if (clock() > deadline) fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
            const postcondition = { path: shape.destination, parent_id: parent.id,
              provider_file_id: folderId, provider_file_version: seen.file.version };
            if (!includeVerifiedProof) return Object.freeze(postcondition);
            const descendantVersions = legacy ? null : await refreshedSubtreeVersions({ get_file: getFile, get_files: getFiles,
              until: Math.min(deadline, clock() + refreshMs), clock }, folderId, descendants);
            const verifiedProof = Object.freeze({ contract: "clued.storage-directory-move-verified/1",
              ...postcondition, operation: "move", target_kind: "directory", source_path: shape.source,
              source_file_version: shape.source_file_version, subtree_sample: sample.map((item) => ({ ...item })),
              ...(legacy ? {} : { descendant_versions: descendantVersions }),
              provider_before: structuredClone(before),
              checks: Object.freeze({ identity: true, ancestors: true, stable_state: true, unique_name: true,
                source_vacated: true, sharing_unchanged: true, subtree: true }) });
            return Object.freeze({ ...postcondition, verified_proof: verifiedProof });
          }
        }
      }
      const remaining = deadline - clock();
      if (remaining <= 0 || attempt === attempts - 1) break;
      await sleep(Math.min(pollMs, remaining));
    }
    fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
  };
}
