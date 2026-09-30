import { replaceShape } from "./resource-center-google-drive-replace-effect.mjs";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const normalized = (value) => bindResourceCenterMutation({ destination_path: value }).destination_path;
const fail = (code) => { throw new Error(code); };
const revisionId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);

/** Host-owned replace verifier (StorageFullCapability §6.2, P4). Reads
 * metadata only and never changes or retries storage. Success requires the
 * same file (ID, name, only parent, same ancestor folder IDs) with a new head
 * revision whose size and sha256 are the new content's, a stable version
 * across two reads, the previous head revision kept forever with the previous
 * content's size and md5. Each listed older Clued pin is read and reported
 * released only if Drive shows it unkept; a release is never a condition. A Drive
 * version jump is recorded, not treated as failure. Anything else leaves the
 * intent fenced; recovery repeats only these reads.
 * @param {{managed_root: string, root_folder_id: string, root_parent_id: string, get_file: Function, list_children: Function, get_revision: Function, include_verified_proof?: boolean, timeout_ms?: number, poll_ms?: number, clock?: () => number, sleep?: Function}} config
 */
export function createGoogleDriveReplacePostconditionVerifier({
  managed_root: managedRoot, root_folder_id: rootId, root_parent_id: rootParentId,
  get_file: getFile, list_children: listChildren, get_revision: getRevision,
  include_verified_proof: includeVerifiedProof = false,
  timeout_ms: timeoutMs = 30_000, poll_ms: pollMs = 1000,
  clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const root = normalized(managedRoot);
  if (!root || !rootId || !rootParentId || typeof getFile !== "function" || typeof listChildren !== "function" ||
    typeof getRevision !== "function" || typeof clock !== "function" || typeof sleep !== "function" ||
    typeof includeVerifiedProof !== "boolean" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
    !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) {
    throw new TypeError("Pinned Drive identity, metadata API and bounded polling are required.");
  }
  const folderCheck = (file, id, name, parent) => {
    if (!file || file.id !== id || file.name !== name || file.trashed !== false || file.mimeType !== FOLDER ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
  };
  return async function verify({ profile, mutation, provider_before: before, effect_result: effect }) {
    const shape = replaceShape(mutation);
    const before2 = effect?.content_before, after = effect?.content_after;
    if (!shape || normalized(profile?.managed_root) !== root || !shape.destination.startsWith(root + "/") ||
      effect?.operation !== "replace" || effect.destination_path !== shape.destination ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(effect.provider_file_id ?? "") || !revisionId(effect.pinned_revision_id) ||
      !Array.isArray(effect.release_revision_ids) || !effect.release_revision_ids.every(revisionId) ||
      effect.release_revision_ids.includes(effect.pinned_revision_id) || typeof effect.previously_kept !== "boolean" ||
      Object.keys(before2 ?? {}).sort().join(",") !== "head_revision_id,md5,sha256,size" ||
      before2.head_revision_id !== effect.pinned_revision_id ||
      Object.keys(after ?? {}).sort().join(",") !== "sha256,size" || !/^[0-9a-f]{64}$/.test(after.sha256) ||
      !/^(0|[1-9]\d{0,19})$/.test(after.size) || (effect.restore_job_id ?? null) !== shape.restore_job_id ||
      before?.root_folder_id !== rootId || before.root_parent_id !== rootParentId ||
      before.destination_file_id !== effect.provider_file_id || before.destination_file_version !== shape.destination_file_version ||
      !before.destination_parent_id) {
      fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    }
    const fileId = effect.provider_file_id, name = shape.name;
    const parts = shape.destination.slice(root.length + 1).split("/");
    parts.pop();
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
      if (!Array.isArray(matches) || matches.length !== 1 || matches[0].id !== fileId) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
      const file = await getFile(fileId);
      if (!file || file.id !== fileId || file.name !== name || file.trashed !== false ||
        !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent.id ||
        !file.mimeType || file.mimeType === FOLDER || typeof file.version !== "string" || !/^[1-9]\d*$/.test(file.version) ||
        !revisionId(file.headRevisionId)) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
      if (file.headRevisionId === effect.pinned_revision_id) fail("DRIVE_POSTCONDITION_REVISION_UNCHANGED");
      if (file.size !== after.size ||
        (file.sha256Checksum != null && file.sha256Checksum !== "" && file.sha256Checksum !== after.sha256)) {
        fail("DRIVE_POSTCONDITION_CONTENT_MISMATCH");
      }
      return { listed: matches[0], file };
    }
    const deadline = clock() + timeoutMs;
    const attempts = Math.ceil(timeoutMs / pollMs) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const parent = await parentIdentity();
      const seen = await observe(parent);
      // Drive may publish the checksum after the metadata: absence is provisional.
      const published = seen.file.sha256Checksum === after.sha256;
      if (published && seen.listed.version === seen.file.version) {
        const kept = await getRevision(fileId, effect.pinned_revision_id);
        if (kept?.id !== effect.pinned_revision_id || kept.keepForever !== true ||
          (kept.size != null && kept.size !== before2.size) ||
          (kept.md5Checksum != null && before2.md5 !== null && kept.md5Checksum !== before2.md5)) {
          fail("DRIVE_POSTCONDITION_PREVIOUS_REVISION_NOT_KEPT");
        }
        // Releases are observed, not required: only a revision Drive shows
        // unkept is reported released; any other stays pinned for next time.
        const released = [];
        for (const id of effect.release_revision_ids) {
          let seenRelease = null;
          try { seenRelease = await getRevision(fileId, id); } catch { seenRelease = null; }
          if (seenRelease?.id === id && seenRelease.keepForever === false) released.push(id);
        }
        await parentIdentity();
        const again = await observe(parent);
        if (again.file.version === seen.file.version && again.listed.version === seen.file.version &&
          again.file.headRevisionId === seen.file.headRevisionId) {
          if (clock() > deadline) fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
          const postcondition = { path: shape.destination, parent_id: parent.id,
            provider_file_id: fileId, provider_file_version: seen.file.version };
          if (!includeVerifiedProof) return Object.freeze(postcondition);
          const verifiedProof = Object.freeze({ contract: "clued.storage-replace-verified/1", ...postcondition,
            operation: "replace", destination_file_version: shape.destination_file_version,
            content_before: { ...before2 }, content_after: { ...after }, pinned_revision_id: effect.pinned_revision_id,
            previously_kept: effect.previously_kept, release_revision_ids: [...effect.release_revision_ids],
            released_revision_ids: released, restore_job_id: shape.restore_job_id,
            provider_before: structuredClone(before),
            checks: Object.freeze({ identity: true, ancestors: true, stable_state: true, content: true,
              revision_changed: true, previous_revision_kept: true, releases_observed: true }) });
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

