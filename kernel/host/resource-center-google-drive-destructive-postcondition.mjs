import { isDeepStrictEqual } from "node:util";
import { contentIdentity } from "./resource-center-google-drive-modify-effect.mjs";
import { DESTRUCTIVE_PROOF_CONTRACTS, destructiveProviderBefore, destructiveShape } from "./resource-center-google-drive-destructive-effect.mjs";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const normalized = (value) => bindResourceCenterMutation({ destination_path: value }).destination_path;
const fail = (code) => { throw new Error(code); };
const contentKeys = "head_revision_id,md5,sha256,size";

/** Host-owned trash/untrash verifier (StorageFullCapability §6.1/§6.2). Reads
 * metadata only and never changes or retries storage. Success requires the
 * item, by its provider ID, to have the requested trashed state under exactly
 * its expected folder (the original one, or the opted-in destination of a
 * relocating untrash) with the same registered ancestor IDs, the expected
 * name, unchanged content identity (a directory: still no children at all)
 * and a stable version across two reads. A trashed item must no longer be
 * listed under its name; an untrashed one must be the only entry of its name
 * in that folder. Drive's version may jump by more than one; only the
 * observed stable version is recorded. Folder versions are not pinned.
 * Anything else leaves the intent fenced.
 * @param {{managed_root: string, root_folder_id: string, root_parent_id: string, get_file: Function, list_children: Function, has_children?: Function, include_verified_proof?: boolean, timeout_ms?: number, poll_ms?: number, clock?: () => number, sleep?: Function}} config
 */
export function createGoogleDriveDestructivePostconditionVerifier({
  managed_root: managedRoot, root_folder_id: rootId, root_parent_id: rootParentId,
  get_file: getFile, list_children: listChildren, has_children: hasChildren,
  include_verified_proof: includeVerifiedProof = false,
  timeout_ms: timeoutMs = 30_000, poll_ms: pollMs = 1000,
  clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const root = normalized(managedRoot);
  if (!root || !rootId || !rootParentId || typeof getFile !== "function" || typeof listChildren !== "function" ||
    (hasChildren !== undefined && typeof hasChildren !== "function") ||
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
    const shape = destructiveShape(mutation);
    const content = effect?.content;
    const contentOk = shape?.directory ? content === null
      : !!content && Object.keys(content).sort().join(",") === contentKeys &&
        !!contentIdentity({ size: content.size, sha256Checksum: content.sha256, md5Checksum: content.md5, headRevisionId: content.head_revision_id });
    if (!shape || normalized(profile?.managed_root) !== root || !shape.final_path.startsWith(root + "/") ||
      effect?.operation !== shape.operation || effect.source_path !== shape.source ||
      (effect.destination_path ?? null) !== shape.destination || effect.provider_file_id !== shape.source_file_id ||
      !contentOk || (shape.directory && !hasChildren) ||
      before?.root_folder_id !== rootId || before.root_parent_id !== rootParentId || !destructiveProviderBefore(shape, before)) {
      fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    }
    const fileId = shape.source_file_id, name = shape.final_name;
    const expectedParent = shape.destination ? before.destination_parent_id : before.source_parent_id;
    const trashed = shape.operation === "delete";
    const parts = shape.final_parent_path === root ? [] : shape.final_parent_path.slice(root.length + 1).split("/");
    // The chain to the expected folder is the same: root ID under its pinned
    // parent, each folder by name and parent, the recorded folder ID.
    async function parentIdentity() {
      let node = await getFile(rootId);
      folderCheck(node, rootId, root.slice(root.lastIndexOf("/") + 1), rootParentId);
      for (const part of parts) {
        const matches = await listChildren({ parent_id: node.id, name: part });
        if (!Array.isArray(matches) || matches.length !== 1) fail("DRIVE_POSTCONDITION_PARENT_AMBIGUOUS");
        folderCheck(matches[0], matches[0].id, part, node.id);
        node = matches[0];
      }
      if (node.id !== expectedParent) fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
      return node;
    }
    async function observe(parent) {
      const file = await getFile(fileId);
      if (!file || file.id !== fileId || file.name !== name ||
        !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent.id ||
        !file.mimeType || (file.mimeType === FOLDER) !== shape.directory ||
        typeof file.version !== "string" || !/^[1-9]\d*$/.test(file.version)) {
        fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
      }
      if (shape.directory) {
        if (await hasChildren(fileId)) fail("DRIVE_POSTCONDITION_DIRECTORY_NOT_EMPTY");
      } else if (!isDeepStrictEqual(contentIdentity(file), { ...content })) fail("DRIVE_POSTCONDITION_CONTENT_CHANGED");
      if (file.trashed !== trashed) return null;
      // The name listing excludes trashed entries: a trashed item must be gone
      // from it; an untrashed item must be its only entry.
      const listed = await listChildren({ parent_id: parent.id, name });
      if (!Array.isArray(listed)) fail("DRIVE_LIST_INVALID");
      if (trashed) {
        if (listed.some((entry) => entry?.id === fileId)) return null; // a name index may lag
      } else {
        if (listed.length > 1 || (listed.length === 1 && listed[0]?.id !== fileId)) fail("DRIVE_POSTCONDITION_DESTINATION_AMBIGUOUS");
        if (listed.length === 0 || listed[0].version !== file.version) return null;
      }
      return file;
    }
    const deadline = clock() + timeoutMs;
    const attempts = Math.ceil(timeoutMs / pollMs) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const parent = await parentIdentity();
      const seen = await observe(parent);
      if (seen) {
        await parentIdentity();
        const again = await observe(parent);
        if (again && again.version === seen.version) {
          if (clock() > deadline) fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
          const postcondition = { path: shape.final_path, parent_id: parent.id,
            provider_file_id: fileId, provider_file_version: seen.version };
          if (!includeVerifiedProof) return Object.freeze(postcondition);
          const last = shape.directory ? { empty: true } : { content_unchanged: true };
          const verifiedProof = Object.freeze({ contract: DESTRUCTIVE_PROOF_CONTRACTS[shape.operation],
            ...postcondition, operation: shape.operation, target_kind: shape.target_kind, source_path: shape.source,
            source_file_version: shape.source_file_version, restore_mode: shape.restore_mode, trashed,
            content: content === null ? null : { ...content }, provider_before: structuredClone(before),
            checks: Object.freeze(trashed
              ? { identity: true, ancestors: true, stable_state: true, trashed: true, parent: true, name_vacated: true, ...last }
              : { identity: true, ancestors: true, stable_state: true, untrashed: true, parent: true, unique_name: true, ...last }) });
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
