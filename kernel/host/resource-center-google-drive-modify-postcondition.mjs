import { isDeepStrictEqual } from "node:util";
import { contentIdentity, modifyShape } from "./resource-center-google-drive-modify-effect.mjs";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";
import { ancestorChain, walkAncestorChain } from "./resource-center-google-drive-ancestors.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const normalized = (value) => bindResourceCenterMutation({ destination_path: value }).destination_path;
const fail = (code) => { throw new Error(code); };

/** Host-owned rename/move verifier (StorageFullCapability §6.1/§6.2). Reads
 * metadata only and never changes or retries storage. Success requires the
 * file, by its provider ID, to be the only entry of its new name in the
 * destination parent, with exactly that parent, the same registered ancestor
 * IDs, unchanged content identity (size, head revision, checksums: a
 * concurrent edit is never settled), a stable version across two reads, and
 * no longer listed under its old name. Drive's version may jump by more than
 * one; with content unchanged only the observed stable version is recorded.
 * Folder versions are not pinned: Drive may advance them when children
 * change. Anything else leaves the intent fenced.
 * @param {{managed_root: string, root_folder_id: string, root_parent_id: string, get_file: Function, list_children: Function, include_verified_proof?: boolean, timeout_ms?: number, poll_ms?: number, clock?: () => number, sleep?: Function}} config
 */
export function createGoogleDriveModifyPostconditionVerifier({
  managed_root: managedRoot, root_folder_id: rootId, root_parent_id: rootParentId,
  get_file: getFile, list_children: listChildren, include_verified_proof: includeVerifiedProof = false,
  timeout_ms: timeoutMs = 30_000, poll_ms: pollMs = 1000,
  clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const root = normalized(managedRoot);
  if (!root || !rootId || !rootParentId || typeof getFile !== "function" || typeof listChildren !== "function" ||
    typeof clock !== "function" || typeof sleep !== "function" || typeof includeVerifiedProof !== "boolean" ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
    !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) {
    throw new TypeError("Pinned Drive identity, metadata API and bounded polling are required.");
  }
  const folderCheck = (file, id, name, parent) => {
    if (!file || file.id !== id || file.name !== name || file.trashed !== false || file.mimeType !== FOLDER ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent ||
      typeof file.version !== "string" || !/^[1-9]\d*$/.test(file.version)) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
  };
  return async function verify({ profile, mutation, provider_before: before, effect_result: effect }) {
    const shape = modifyShape(mutation);
    if (!shape || normalized(profile?.managed_root) !== root || !shape.destination.startsWith(root + "/") ||
      !shape.source.startsWith(root + "/") || effect?.operation !== shape.operation ||
      effect.source_path !== shape.source || effect.destination_path !== shape.destination ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(effect.provider_file_id ?? "") ||
      Object.keys(effect.content ?? {}).sort().join(",") !== "head_revision_id,md5,sha256,size" ||
      !contentIdentity(effect.content ? { size: effect.content.size, sha256Checksum: effect.content.sha256,
        md5Checksum: effect.content.md5, headRevisionId: effect.content.head_revision_id } : null) ||
      before?.root_folder_id !== rootId || before.root_parent_id !== rootParentId ||
      before.source_file_id !== effect.provider_file_id || before.source_file_version !== shape.source_file_version ||
      !before.destination_parent_id || (!Array.isArray(before.ancestors) && !before.destination_parent_version) ||
      before.destination_file_id !== null || before.destination_file_version !== null) {
      fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    }
    const fileId = effect.provider_file_id, name = shape.destination_name, content = effect.content;
    const parts = shape.destination.slice(root.length + 1).split("/");
    parts.pop();
    // The chain to the destination parent is the same: root ID under its
    // pinned parent, each folder by name and parent, the destination parent ID.
    // Step 3: an identity that names its ancestors is walked by their Drive IDs.
    const chain = ancestorChain(before, { root, root_folder_id: rootId, root_parent_id: rootParentId },
      parts.length ? `${root}/${parts.join("/")}` : root);
    if (chain && chain.at(-1).id !== before.destination_parent_id) fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    async function parentIdentity() {
      if (chain) return walkAncestorChain(chain, getFile);
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
      if (matches[0].id !== fileId) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
      const file = await getFile(fileId);
      if (!file || file.id !== fileId || file.name !== name || file.trashed !== false ||
        !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent.id ||
        !file.mimeType || file.mimeType === FOLDER || typeof file.version !== "string" || !/^[1-9]\d*$/.test(file.version)) {
        fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
      }
      if (!isDeepStrictEqual(contentIdentity(file), { ...content })) fail("DRIVE_POSTCONDITION_CONTENT_CHANGED");
      return { listed: matches[0], file };
    }
    const deadline = clock() + timeoutMs;
    const attempts = Math.ceil(timeoutMs / pollMs) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const parent = await parentIdentity();
      const seen = await observe(parent);
      if (seen && seen.listed.version === seen.file.version) {
        // The old name must no longer name this file. For a rename it is
        // re-listed in the same parent; for a move, observe() already requires
        // the file's only parent to be the destination.
        const oldParent = shape.operation === "rename" ? parent.id : null;
        const vacated = oldParent ? await listChildren({ parent_id: oldParent, name: shape.source_name }) : [];
        if (!Array.isArray(vacated)) fail("DRIVE_LIST_INVALID");
        // A name index may lag: a leftover old entry is re-read, not failed.
        const stillListed = vacated.some((entry) => entry?.id === fileId);
        await parentIdentity();
        const again = stillListed ? null : await observe(parent);
        if (again && again.file.version === seen.file.version && again.listed.version === seen.file.version) {
          if (clock() > deadline) fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
          const postcondition = { path: shape.destination, parent_id: parent.id,
            provider_file_id: fileId, provider_file_version: seen.file.version };
          if (!includeVerifiedProof) return Object.freeze(postcondition);
          const verifiedProof = Object.freeze({ contract: `clued.storage-${shape.operation}-verified/1`,
            ...postcondition, operation: shape.operation, source_path: shape.source,
            source_file_version: shape.source_file_version, content: { ...content }, provider_before: structuredClone(before),
            checks: Object.freeze({ identity: true, ancestors: true, stable_state: true, unique_name: true,
              source_vacated: true, content_unchanged: true }) });
          return Object.freeze({ ...postcondition, verified_proof: verifiedProof });
        }
      }
      const remaining = deadline - clock();
      if (remaining <= 0 || attempt === attempts - 1) break;
      await sleep(Math.min(pollMs, remaining));
    }
    fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
  };
}
