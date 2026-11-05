import { googleDriveAccessDigest, googleDriveSharingDigest } from "./resource-center-google-drive-sharing.mjs";

const folder = "application/vnd.google-apps.folder";
const providerId = /^[A-Za-z0-9_-]{1,160}$/;
const validId = value => typeof value === "string" && providerId.test(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const version = /^[1-9][0-9]{0,39}$/;
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const fail = reason => { throw new Error(`DRIVE_REGISTRATION_${reason}`); };
const nameOf = path => path.slice(path.lastIndexOf("/") + 1);
const parentOf = path => path.slice(0, path.lastIndexOf("/"));
const safeName = name => typeof name === "string" && name.length >= 1 && name.length <= 255 &&
  !/[\/\\\p{Cc}]/u.test(name) && name !== "." && name !== "..";
const exactKeys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));

function registeredNode(node, state = false) {
  if (!exactKeys(node, ["artifact_id", "artifact_version", "path", "provider_file_id", "parent_id", "access_digest", "sharing_digest",
        ...(state ? ["registered_state"] : [])]) || state && !["active", "trashed"].includes(node.registered_state) ||
      !uuid.test(node.artifact_id) || !Number.isSafeInteger(node.artifact_version) || node.artifact_version < 1 ||
      typeof node.path !== "string" || !validId(node.provider_file_id) || !validId(node.parent_id) ||
      !safeName(nameOf(node.path)) ||
      [node.access_digest, node.sharing_digest].some(value => value !== null && !digest.test(value))) fail("PLAN_INVALID");
}

function validatePlan(plan) {
  if (!exactKeys(plan, ["contract", "mode", "managed_root", "root_folder_id", "root_parent_id", "intent_id", "request_sha256", "parents", "target"]) ||
      plan.contract !== "clued.storage-registration-plan/1" || !["refresh_directory", "refresh_directory_state", "adopt_create"].includes(plan.mode) ||
      typeof plan.managed_root !== "string" || plan.managed_root.length > 2000 || plan.managed_root.includes("\\") ||
      !safeName(nameOf(plan.managed_root)) || !validId(plan.root_folder_id) || !validId(plan.root_parent_id) ||
      !uuid.test(plan.intent_id) || !digest.test(plan.request_sha256) || !Array.isArray(plan.parents) ||
      plan.parents.length < 2 || plan.parents.length > 20) fail("PLAN_INVALID");
  const ids = new Set();
  for (let i = 0; i < plan.parents.length; i++) {
    const node = plan.parents[i]; registeredNode(node);
    if (ids.has(node.provider_file_id) || (i === 0 ?
      node.path !== plan.managed_root || node.provider_file_id !== plan.root_folder_id || node.parent_id !== plan.root_parent_id :
      parentOf(node.path) !== plan.parents[i - 1].path || node.parent_id !== plan.parents[i - 1].provider_file_id)) fail("PLAN_INVALID");
    ids.add(node.provider_file_id);
  }
  const target = plan.target;
  if (["refresh_directory", "refresh_directory_state"].includes(plan.mode)) registeredNode(target, plan.mode === "refresh_directory_state");
  else if (!exactKeys(target, ["path", "provider_file_id", "parent_id", "target_kind", "mime_type", "size", "sha256"]) ||
      !["file", "directory"].includes(target.target_kind) ||
      (target.target_kind === "directory" ? target.mime_type !== folder || target.size !== null || target.sha256 !== null :
        typeof target.mime_type !== "string" || !target.mime_type || target.mime_type.startsWith("application/vnd.google-apps.") ||
        !/^(0|[1-9][0-9]{0,19})$/.test(target.size) || !digest.test(target.sha256))) fail("PLAN_INVALID");
  if (typeof target.path !== "string" || !safeName(nameOf(target.path)) ||
      !validId(target.provider_file_id) || ids.has(target.provider_file_id) ||
      target.provider_file_id === plan.root_parent_id || parentOf(target.path) !== plan.parents.at(-1).path ||
      target.parent_id !== plan.parents.at(-1).provider_file_id) fail("PLAN_INVALID");
}

// `permissions` is complete only if the requester can share the item. This
// deliberately narrow new qualification supports an owner-private My Drive
// item, not a guessed ACL or a change to an existing explicit baseline.
// permission IDs and provider_subject are different contracts: never compare
// an OAuth subject to a permission ID to manufacture an ownership proof.
function privateAccess(file, listedPermissions) {
  const permissions = listedPermissions === undefined ? file.permissions : listedPermissions;
  if (file.ownedByMe !== true || listedPermissions === undefined && file.capabilities?.canShare !== true || file.driveId != null ||
      file.shared !== false || !Array.isArray(permissions) || permissions.length !== 1 ||
      !Array.isArray(file.permissionIds) || file.permissionIds.length !== 1) fail("OWNERSHIP_UNPROVEN");
  const permission = permissions[0];
  if (!exactKeys(permission, ["id", "type", "role"], ["domain", "allowFileDiscovery", "expirationTime", "deleted", "pendingOwner", "view"]) ||
      typeof permission.id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(permission.id) ||
      permission.type !== "user" || permission.role !== "owner" || file.permissionIds[0] !== permission.id ||
      permission.domain != null || permission.expirationTime != null || permission.view != null ||
      (permission.deleted !== undefined && permission.deleted !== false) ||
      (permission.pendingOwner !== undefined && permission.pendingOwner !== false) ||
      (permission.allowFileDiscovery !== undefined && permission.allowFileDiscovery !== false)) fail("OWNERSHIP_UNPROVEN");
  const access = googleDriveAccessDigest({ ...file, permissions }), sharing = googleDriveSharingDigest(file);
  if (!access || !sharing) fail("ACL_INCOMPLETE");
  return { access_digest: access, sharing_digest: sharing,
    owner_permission_id: permission.id, owner_allow_file_discovery: permission.allowFileDiscovery ?? null };
}

function identity(file, node, directory, currentState = false) {
  if (!object(file) || file.id !== node.provider_file_id || file.name !== nameOf(node.path) ||
      !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== node.parent_id ||
      (currentState ? typeof file.trashed !== "boolean" || file.explicitlyTrashed !== file.trashed :
        file.trashed !== false || file.explicitlyTrashed !== false) || !version.test(file.version) ||
      (directory ? file.mimeType !== folder : typeof file.mimeType !== "string" || file.mimeType.startsWith("application/vnd.google-apps.")))
    fail("IDENTITY_CHANGED");
}

function baseline(node, acl) {
  // An explicit mismatch never falls through to the missing-baseline rule.
  if (node.access_digest !== null && node.access_digest !== acl.access_digest ||
      node.sharing_digest !== null && node.sharing_digest !== acl.sharing_digest) fail("ACL_CHANGED");
}

/**
 * GET-only current-state qualification. The authenticated database builds the
 * plan and independently rechecks it, authority and CAS at settlement. This
 * observer creates neither a grant nor an old successful mutation. There is
 * no provider effect, Agent fallback, confirmation flag or caller credential.
 * @param {{metadata?: {getFile: Function, listChildren: Function, hasChildren: Function, listPermissions?: Function}, clock?: () => number}} [config]
 */
export function createGoogleDriveRegistrationRecovery({ metadata, clock = Date.now } = {}) {
  if (!metadata || ["getFile", "listChildren", "hasChildren"].some(key => typeof metadata[key] !== "function") || typeof clock !== "function")
    throw new TypeError("Host-owned metadata API and clock required.");
  return Object.freeze({ async observe(plan, { signal } = {}) {
    validatePlan(plan);
    const pinned = structuredClone(plan);
    const readNode = async (node, directory, currentState = false) => {
      signal?.throwIfAborted();
      const file = await metadata.getFile(node.provider_file_id, { signal });
      identity(file, node, directory, currentState);
      let permissions;
      if (currentState && file.trashed && file.capabilities?.canShare !== true) {
        if (file.ownedByMe !== true || file.driveId != null || typeof metadata.listPermissions !== "function") fail("OWNERSHIP_UNPROVEN");
        permissions = await metadata.listPermissions(node.provider_file_id, { signal });
      }
      const acl = privateAccess(file, permissions);
      if (Object.hasOwn(node, "artifact_id")) baseline(node, acl);
      return { file, acl };
    };
    const observe = async () => {
      const parents = [];
      for (const node of pinned.parents) {
        const { file, acl } = await readNode(node, true);
        // An empty listing with this capability false is not absence proof.
        if (file.capabilities?.canListChildren !== true) fail("NAMESPACE_UNPROVEN");
        if (parents.length) {
          const matches = await metadata.listChildren({ parent_id: node.parent_id, name: nameOf(node.path) }, { signal });
          if (!Array.isArray(matches) || matches.length !== 1 || matches[0].id !== node.provider_file_id) fail("NAMESPACE_CONFLICT");
        }
        parents.push({ ...node, ...acl, provider_file_version: file.version });
      }
      const target = pinned.target, state = pinned.mode === "refresh_directory_state";
      const directory = state || pinned.mode === "refresh_directory" || target.target_kind === "directory";
      const { file, acl } = await readNode(target, directory, state);
      // An explicitly trashed object owns no active name slot. A new active
      // same-name object is neither adopted nor overwritten by this repair.
      if (!file.trashed) {
        const matches = await metadata.listChildren({ parent_id: target.parent_id, name: nameOf(target.path) }, { signal });
        if (!Array.isArray(matches) || matches.length !== 1 || matches[0].id !== target.provider_file_id) fail("NAMESPACE_CONFLICT");
      }
      // Registration does not widen the parent namespace's access.
      if (acl.access_digest !== parents.at(-1).access_digest || acl.sharing_digest !== parents.at(-1).sharing_digest) fail("ACL_CHANGED");
      let empty = null;
      if (directory) {
        if (file.size != null || file.sha256Checksum != null || file.headRevisionId != null) fail("IDENTITY_CHANGED");
        if (!file.trashed) {
          if (file.capabilities?.canListChildren !== true) fail("NAMESPACE_UNPROVEN");
          empty = !(await metadata.hasChildren(target.provider_file_id, { signal }));
        }
        // This is new current metadata for this directory only. Preserve the
        // observed child-presence fact; children are neither adopted nor
        // changed, and the old mutation's typed proof is not being rebuilt.
      }
      if (pinned.mode === "adopt_create") {
        if (!object(file.appProperties) || file.appProperties.clued_intent_id !== pinned.intent_id ||
            file.appProperties.clued_request_sha256 !== pinned.request_sha256 || file.mimeType !== target.mime_type ||
            (!directory && (file.size !== target.size || file.sha256Checksum !== target.sha256))) fail("CREATE_IDENTITY_UNPROVEN");
      }
      return { contract: "clued.storage-registration-observation/1", mode: pinned.mode, parents,
        target: { ...target, ...acl, provider_file_version: file.version, mime_type: file.mimeType,
          size: directory ? null : file.size, sha256: directory ? null : file.sha256Checksum, empty,
          ...(state ? { current_state: file.trashed ? "trashed" : "active" } : {}),
          intent_tag: pinned.mode === "adopt_create" ? file.appProperties.clued_intent_id : null,
          request_tag: pinned.mode === "adopt_create" ? file.appProperties.clued_request_sha256 : null } };
    };
    // Freshness starts before the oldest read, not after a slow first scan.
    const firstAt = clock();
    const first = await observe();
    const second = await observe(), secondAt = clock();
    signal?.throwIfAborted();
    // A parent directory can gain an unrelated child without changing its
    // identity or ACL. Keep both actual versions, compare semantic facts.
    const semantic = observation => ({ ...observation,
      parents: observation.parents.map(({ provider_file_version, ...facts }) => facts) });
    if (JSON.stringify(semantic(first)) !== JSON.stringify(semantic(second))) fail("OBSERVATION_CHANGED");
    if (![firstAt, secondAt].every(Number.isFinite) || secondAt < firstAt || secondAt - firstAt > 30000) fail("OBSERVATION_EXPIRED");
    return { first_observation: { ...first, observed_at: new Date(firstAt).toISOString() },
      second_observation: { ...second, observed_at: new Date(secondAt).toISOString() } };
  } });
}
