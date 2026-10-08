import { createHash } from "node:crypto";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";
import { contentRefShape } from "./resource-center-google-drive-create-effect.mjs";
import { googleDriveAccessDigest, googleDriveSharingDigest } from "./resource-center-google-drive-sharing.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const normalized = (value) => bindResourceCenterMutation({ destination_path: value }).destination_path;
const fail = (code) => { throw new Error(code); };

/** Host-owned create verifier. Polls metadata only, never reads remote content
 * and never changes/retries storage. An uncertain result leaves the durable
 * write intent fenced; it is not permission to repeat the filesystem effect.
 * P6.2 (Decision 06b54716): with get_sharing, a created directory whose
 * sharing equals its destination folder's (as the provider identity recorded
 * it) carries that digest in its proof (provider_sharing_digest), so it is
 * registered matched by sharing rather than by its Drive version. Any other
 * outcome, or a failed read, leaves the digest out: version matching, as before.
 * Storage step 2 (Task e2eb07d1): with get_access as well (a read returning
 * id, version and permissions together), such a directory also carries the
 * access digest it was observed with (provider_access_digest), only when that
 * read saw the verified version.
 * @param {{managed_root: string, root_folder_id: string, root_parent_id: string, get_file: Function, list_children: Function, get_sharing?: Function, get_access?: Function, require_effect_provider_id?: boolean, include_verified_proof?: boolean, timeout_ms?: number, poll_ms?: number, clock?: () => number, sleep?: Function}} config
 */
export function createGoogleDriveCreatePostconditionVerifier({
  managed_root: managedRoot, root_folder_id: rootId, root_parent_id: rootParentId,
  get_file: getFile, list_children: listChildren, get_sharing: getSharing, get_access: getAccess,
  require_effect_provider_id: requireEffectProviderId = false,
  include_verified_proof: includeVerifiedProof = false,
  timeout_ms: timeoutMs = 30_000, poll_ms: pollMs = 1000,
  clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const root = normalized(managedRoot);
  if (!root || !rootId || !rootParentId || typeof getFile !== "function" ||
    typeof listChildren !== "function" || typeof clock !== "function" || typeof sleep !== "function" ||
    (getSharing !== undefined && typeof getSharing !== "function") ||
    (getAccess !== undefined && typeof getAccess !== "function") ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
    !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs ||
    typeof includeVerifiedProof !== "boolean" || (includeVerifiedProof && !requireEffectProviderId)) {
    throw new TypeError("Pinned Drive identity, metadata API and bounded polling are required.");
  }
  function check(file, id, name, parent, folder, mimeType) {
    if (!file || file.id !== id || file.name !== name || file.trashed !== false ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parent ||
      typeof file.version !== "string" || !/^[1-9]\d*$/.test(file.version) ||
      (folder ? file.mimeType !== FOLDER : !file.mimeType || file.mimeType.startsWith("application/vnd.google-apps.")) ||
      (mimeType !== undefined && file.mimeType !== mimeType)) {
      fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
    }
  }
  return async function verify({ profile, mutation, provider_before: before, effect_result: effect }) {
    const destination = normalized(mutation?.destination_path);
    if (mutation?.operation !== "create" || mutation.source_path ||
      !["file", "directory"].includes(mutation.target_kind ?? "file") || normalized(profile?.managed_root) !== root ||
      !destination?.startsWith(root + "/") || !effect || effect.operation !== "create" ||
      normalized(effect.destination_path) !== destination ||
      before?.root_folder_id !== rootId || before.root_parent_id !== rootParentId ||
      !before.destination_parent_id || !before.destination_parent_version || !/^[0-9a-f]{64}$/.test(before.provider_version ?? "") ||
      before.destination_file_id !== null || before.destination_file_version !== null ||
      (requireEffectProviderId && !/^[A-Za-z0-9_-]{1,160}$/.test(effect.provider_file_id ?? ""))) {
      fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    }
    const parts = destination.slice(root.length + 1).split("/");
    const name = parts.pop();
    const folder = mutation.target_kind === "directory";
    // Binary create (StorageNormalUse §6.4): size, sha256 and MIME come from the job's content
    // reference, Drive's sha256Checksum must equal it, and the proof is create-verified/3.
    const ref = mutation.content_ref;
    if (ref !== undefined && (folder || mutation.content !== undefined || !contentRefShape(ref))) fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    const content = mutation.content ?? "";
    if (!folder && !ref && typeof content !== "string") fail("DRIVE_POSTCONDITION_CONTENT_REQUIRED");
    const size = folder ? null : ref ? String(ref.size) : String(Buffer.byteLength(content, "utf8"));
    const digest = folder ? null : ref ? ref.sha256 : createHash("sha256").update(content, "utf8").digest("hex");
    const mimeType = ref ? ref.mime_type : undefined;
    async function parentIdentity() {
      let node = await getFile(rootId);
      check(node, rootId, root.slice(root.lastIndexOf("/") + 1), rootParentId, true);
      const versions = [[node.id, node.version]];
      if (node.version !== before.root_folder_version) fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
      for (const part of parts) {
        const matches = await listChildren({ parent_id: node.id, name: part });
        if (!Array.isArray(matches) || matches.length !== 1) fail("DRIVE_POSTCONDITION_PARENT_AMBIGUOUS");
        const child = matches[0];
        check(child, child.id, part, node.id, true);
        node = child;
        versions.push([node.id, node.version]);
      }
      if (node.id !== before.destination_parent_id || node.version !== before.destination_parent_version) {
        fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
      }
      if (createHash("sha256").update(JSON.stringify(versions)).digest("hex") !== before.provider_version) {
        fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
      }
      return node;
    }
    const deadline = clock() + timeoutMs;
    // Iteration bound also protects against an injected/non-monotonic clock.
    const attempts = Math.ceil(timeoutMs / pollMs) + 1;
    async function waitForStableVersion(attempt) {
      // Drive may advance a new file's version while publishing its metadata.
      // Recheck the entire identity/content/ancestor chain; never repeat create.
      const remaining = deadline - clock();
      if (remaining <= 0 || attempt === attempts - 1) fail("DRIVE_POSTCONDITION_VERSION_CHANGED");
      await sleep(Math.min(pollMs, remaining));
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const parent = await parentIdentity();
      const matches = await listChildren({ parent_id: parent.id, name });
      if (!Array.isArray(matches) || matches.length > 1) fail("DRIVE_POSTCONDITION_DESTINATION_AMBIGUOUS");
      if (matches.length === 1) {
        const listed = matches[0];
        if (effect.provider_file_id && listed.id !== effect.provider_file_id) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
        if (typeof listed.id !== "string" || !listed.id) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
        const file = await getFile(listed.id);
        check(file, listed.id, name, parent.id, folder, mimeType);
        if (!folder && ((file.size != null && file.size !== size) ||
          (file.sha256Checksum != null && file.sha256Checksum !== "" && file.sha256Checksum !== digest)))
          fail("DRIVE_POSTCONDITION_CONTENT_MISMATCH");
        if (file.version !== listed.version) {
          await waitForStableVersion(attempt);
          continue;
        }
        if (!folder && file.size === size && (file.sha256Checksum == null || file.sha256Checksum === "")) {
          // Drive may list a newly created object before publishing its
          // checksum. Only absence is provisional; a different checksum or
          // byte count is a real mismatch and must fail closed.
          const remaining = deadline - clock();
          if (remaining <= 0 || attempt === attempts - 1) break;
          await sleep(Math.min(pollMs, remaining));
          continue;
        }
        if (!folder && (file.size !== size || file.sha256Checksum !== digest)) {
          fail("DRIVE_POSTCONDITION_CONTENT_MISMATCH");
        }
        await parentIdentity();
        const finalList = await listChildren({ parent_id: parent.id, name });
        if (!Array.isArray(finalList) || finalList.length !== 1 || finalList[0].id !== file.id)
          fail("DRIVE_POSTCONDITION_VERSION_CHANGED");
        if (finalList[0].version !== file.version) {
          await waitForStableVersion(attempt);
          continue;
        }
        if (clock() > deadline) fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
        const postcondition = { path: destination, parent_id: parent.id,
          provider_file_id: file.id, provider_file_version: file.version };
        if (!includeVerifiedProof) return Object.freeze(postcondition);
        // A new folder inherits its parent's sharing; record it only when it
        // is exactly the destination folder's, as the authority checked it.
        let sharingDigest = null;
        if (folder && typeof getSharing === "function" && /^[0-9a-f]{64}$/.test(before.destination_parent_sharing_digest ?? "")) {
          try {
            const sharing = await getSharing(file.id);
            sharingDigest = sharing?.id === file.id ? googleDriveSharingDigest(sharing) : null;
          } catch { sharingDigest = null; }
          if (sharingDigest !== before.destination_parent_sharing_digest) sharingDigest = null;
        }
        // Step 2: the folder's own access, recorded only with the sharing digest.
        let accessDigest = null;
        if (sharingDigest && typeof getAccess === "function") {
          try {
            const access = await getAccess(file.id);
            accessDigest = access?.id === file.id && access.version === file.version ? googleDriveAccessDigest(access) : null;
          } catch { accessDigest = null; }
        }
        // This is emitted only after the complete metadata/content/ancestor and
        // uniqueness checks above. The fixed server bridge, never an Agent,
        // may persist it against the original started journal before revoke.
        const verifiedProof = ref ? Object.freeze({ contract: "clued.storage-create-verified/3",
          ...postcondition, target_kind: "file", size, sha256: digest, mime_type: ref.mime_type,
          provider_before: structuredClone(before),
          checks: Object.freeze({ identity: true, content: true, ancestors: true,
            unique_name: true, stable_version: true, mime_type: true, sha256_checksum: true }) })
          : Object.freeze({ contract: "clued.storage-create-verified/2",
          ...postcondition, target_kind: mutation.target_kind, size, sha256: digest,
          ...(sharingDigest ? { provider_sharing_digest: sharingDigest } : {}),
          ...(accessDigest ? { provider_access_digest: accessDigest } : {}),
          provider_before: structuredClone(before),
          checks: Object.freeze({ identity: true, content: true, ancestors: true,
            unique_name: true, stable_version: true }) });
        return Object.freeze({ ...postcondition, verified_proof: verifiedProof });
      }
      const remaining = deadline - clock();
      if (remaining <= 0 || attempt === attempts - 1) break;
      await sleep(Math.min(pollMs, remaining));
    }
    fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
  };
}
