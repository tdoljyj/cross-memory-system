import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const fileId = /^[A-Za-z0-9_-]{1,160}$/;
const fail = (code) => { throw new Error(code); };

/** The exact job mutation keys of an adopt (StorageFullCapability P7). */
export const ADOPT_KEYS = Object.freeze(["operation", "source_file_id", "source_path", "target_kind"]);

/** The adopt shape shared by the executor, the effect and the verifier
 * (StorageFullCapability §6.3, Decision 6dc1cf20): one existing file or
 * directory, named by its path under the root and its Drive ID; nothing else. */
export function adoptShape(mutation) {
  if (mutation?.operation !== "adopt" || !["file", "directory"].includes(mutation.target_kind) ||
    typeof mutation.source_path !== "string" || !fileId.test(mutation.source_file_id ?? "") ||
    mutation.destination_path !== undefined || mutation.content !== undefined || mutation.directory_semantics !== undefined) return null;
  const bound = bindResourceCenterMutation(mutation);
  if (!bound.source_path || bound.source_path !== mutation.source_path || bound.destination_path) return null;
  const source = bound.source_path;
  return Object.freeze({ source, name: source.slice(source.lastIndexOf("/") + 1), target_kind: mutation.target_kind,
    directory: mutation.target_kind === "directory", source_file_id: mutation.source_file_id });
}

/** An item Clued may adopt: exactly the named item, of the named kind, never
 * a shortcut, not trashed, in exactly one folder, and owned by this account
 * (Decision 6dc1cf20 item 2). */
export function adoptItemAllowed(shape, file, ownership) {
  return !!shape && !!file && file.id === shape.source_file_id && file.name === shape.name && file.trashed === false &&
    typeof file.mimeType === "string" && file.mimeType !== SHORTCUT && (file.mimeType === FOLDER) === shape.directory &&
    Array.isArray(file.parents) && file.parents.length === 1 && typeof file.parents[0] === "string" &&
    typeof file.version === "string" && /^[1-9]\d{0,39}$/.test(file.version) &&
    ownership?.id === file.id && ownership.owned_by_me === true;
}

/** The provider identity an adopt must carry: the named item, its folder and
 * the folder's sharing; no destination. */
export function adoptProviderBefore(shape, before) {
  return !!shape && !!before && before.source_file_id === shape.source_file_id &&
    /^[1-9]\d{0,39}$/.test(before.source_file_version ?? "") && fileId.test(before.source_parent_id ?? "") &&
    typeof before.source_parent_version === "string" &&
    before.destination_parent_id === null && before.destination_file_id === null && before.destination_file_version === null;
}

/** Private effect for the admitted, durable-started Host only. Adopt writes
 * nothing to Drive: it re-reads the item, durably records the exact attempt
 * (the item, its folder and the Drive version the authority saw) and returns
 * the observation for the verifier. */
export function createGoogleDriveAdoptEffect({
  trusted_profile: trustedProfile, get_file: getFile, get_ownership: getOwnership,
  resolve_provider_identity: resolveProviderIdentity,
  consume_started_provider: consumeStartedProvider,
  persist_provider_attempt: persistProviderAttempt,
} = {}) {
  if (!trustedProfile || typeof getFile !== "function" || typeof getOwnership !== "function" ||
    typeof resolveProviderIdentity !== "function" || typeof consumeStartedProvider !== "function" ||
    typeof persistProviderAttempt !== "function") {
    throw new TypeError("A private metadata reader and durable attempt store are required.");
  }
  const profile = structuredClone(trustedProfile);
  async function item(shape, before) {
    const file = await getFile(shape.source_file_id);
    if (!adoptItemAllowed(shape, file, await getOwnership(shape.source_file_id)) ||
      file.parents[0] !== before.source_parent_id || file.version !== before.source_file_version) fail("DRIVE_NATIVE_SOURCE_MISMATCH");
    return file;
  }
  return async function effect({ mutation, admission, profile_identity: identity }) {
    const binding = admission?.binding;
    const requestHash = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
    const shape = adoptShape(mutation);
    if (!shape || !binding || binding.request_sha256 !== requestHash || binding.profile_id !== profile.profile_id ||
      identity?.profile_id !== profile.profile_id || identity.profile_version !== profile.profile_version) {
      fail("DRIVE_NATIVE_REQUEST_MISMATCH");
    }
    const started = consumeStartedProvider(binding);
    if (!started || started.request_sha256 !== requestHash || !started.intent_id) fail("DRIVE_NATIVE_DURABLE_START_REQUIRED");
    const before = await resolveProviderIdentity({ profile, mutation });
    if (!isDeepStrictEqual(before, started.provider) || !adoptProviderBefore(shape, before)) fail("DRIVE_NATIVE_PROVIDER_CHANGED");
    await item(shape, before);
    const attempt = Object.freeze({ contract: "clued.storage-adopt-attempt/1", intent_id: started.intent_id,
      request_sha256: requestHash, profile_id: profile.profile_id, operation: "adopt", target_kind: shape.target_kind,
      provider_file_id: shape.source_file_id, source_path: shape.source, provider_file_version: before.source_file_version,
      parent_id: before.source_parent_id, binding: structuredClone(binding) });
    await persistProviderAttempt(attempt);
    // Nothing is written; the verifier observes the same item again.
    return Object.freeze({ operation: "adopt", source_path: shape.source, provider_file_id: shape.source_file_id,
      provider_file_version: before.source_file_version, intent_id: started.intent_id });
  };
}
