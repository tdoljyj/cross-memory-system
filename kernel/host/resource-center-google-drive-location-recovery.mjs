import { createGoogleDriveRegistrationRecovery } from "./resource-center-google-drive-registration-recovery.mjs";

const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && keys.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => keys.includes(key));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const provider = /^[A-Za-z0-9_-]{1,160}$/;
const version = /^[1-9][0-9]{0,39}$/;
const digest = /^[0-9a-f]{64}$/;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const nameOf = path => path.slice(path.lastIndexOf("/") + 1);
const parentOf = path => path.slice(0, path.lastIndexOf("/"));
const safeName = value => typeof value === "string" && value.length >= 1 && value.length <= 255 &&
  !/[\/\\\p{Cc}]/u.test(value) && value !== "." && value !== "..";
const fail = reason => { throw new Error("DRIVE_LOCATION_" + reason); };
const targetKeys = ["artifact_id", "artifact_version", "path", "provider_file_id", "parent_id",
  "access_digest", "sharing_digest", "registered_state"];
const commonKeys = ["contract", "managed_root", "root_folder_id", "root_parent_id", "intent_id", "request_sha256"];

function common(value) {
  if (typeof value.managed_root !== "string" || value.managed_root.length < 2 || value.managed_root.length > 1000 ||
      value.managed_root.endsWith("/") || !matches(provider,value.root_folder_id) || !matches(provider,value.root_parent_id) ||
      value.root_folder_id === value.root_parent_id || !matches(uuid,value.intent_id) || !matches(digest,value.request_sha256))
    fail("PLAN_INVALID");
}
function registeredTarget(target, managedRoot) {
  if (!exact(target, targetKeys) || !matches(uuid,target.artifact_id) ||
      !Number.isSafeInteger(target.artifact_version) || target.artifact_version < 1 ||
      !matches(provider,target.provider_file_id) || !matches(provider,target.parent_id) ||
      target.provider_file_id === target.parent_id || !["active", "trashed"].includes(target.registered_state) ||
      target.access_digest !== null && !matches(digest,target.access_digest) ||
      target.sharing_digest !== null && !matches(digest,target.sharing_digest) ||
      typeof target.path !== "string" || !target.path.startsWith(managedRoot + "/") ||
      parentOf(target.path) === managedRoot || !safeName(nameOf(target.path))) fail("PLAN_INVALID");
}

/** A preliminary fixed-ID GET provides only a hint. Native must resolve its
 * parent to current Canonical registration and authorize a full fresh plan.
 * Neither this observer nor its returned hint grants execution permission.
 * @param {{metadata?: {getFile: Function, listChildren: Function, hasChildren: Function, listPermissions?: Function}, clock?: () => number}} [config]
 */
export function createGoogleDriveLocationRecovery({metadata, clock = Date.now} = {}) {
  if (!metadata || typeof metadata.getFile !== "function" || typeof clock !== "function")
    throw new TypeError("Host-owned metadata API and clock required.");
  const observer = createGoogleDriveRegistrationRecovery({metadata, clock});
  return Object.freeze({
    async discover(seed, {signal} = {}) {
      if (!exact(seed, [...commonKeys, "target"]) || seed.contract !== "clued.storage-directory-location-seed/1")
        fail("SEED_INVALID");
      common(seed); registeredTarget(seed.target, seed.managed_root);
      if ([seed.root_folder_id, seed.root_parent_id].includes(seed.target.provider_file_id)) fail("SEED_INVALID");
      const pinned = structuredClone(seed); signal?.throwIfAborted();
      const file = await metadata.getFile(pinned.target.provider_file_id, {signal});
      signal?.throwIfAborted();
      if (!object(file) || file.id !== pinned.target.provider_file_id || file.mimeType !== "application/vnd.google-apps.folder" ||
          file.trashed !== false || file.explicitlyTrashed !== false || file.ownedByMe !== true || file.driveId != null ||
          !safeName(file.name) || !matches(version,file.version) || !Array.isArray(file.parents) || file.parents.length !== 1 ||
          !matches(provider,file.parents[0]) || file.parents[0] === file.id ||
          [pinned.root_folder_id, pinned.root_parent_id].includes(file.parents[0])) fail("CURRENT_LOCATION_UNSUPPORTED");
      return {contract:"clued.storage-directory-location-hint/1",provider_file_id:file.id,
        provider_file_version:file.version,parent_id:file.parents[0],name:file.name};
    },
    async observe(plan, {signal} = {}) {
      if (!exact(plan, [...commonKeys, "mode", "parents", "target"]) ||
          plan.contract !== "clued.storage-directory-location-plan/1" || plan.mode !== "refresh_directory_location" ||
          !object(plan.target) || !exact(plan.target, [...targetKeys, "registered_path", "registered_parent_id"]))
        fail("PLAN_INVALID");
      common(plan);
      const {registered_path, registered_parent_id, ...target} = plan.target;
      registeredTarget(target, plan.managed_root);
      registeredTarget({...target,path:registered_path,parent_id:registered_parent_id}, plan.managed_root);
      if (target.path === registered_path ||
          [plan.root_folder_id,plan.root_parent_id].includes(target.provider_file_id)) fail("PLAN_INVALID");
      // This inner plan only reuses the already strict metadata observation
      // schema. Native V4 separately rebuilds it from its authorized outer
      // plan; it never passes this projection to the old state commit.
      const inner = {contract:"clued.storage-registration-plan/1",mode:"refresh_directory_state",
        managed_root:plan.managed_root,root_folder_id:plan.root_folder_id,root_parent_id:plan.root_parent_id,
        intent_id:plan.intent_id,request_sha256:plan.request_sha256,parents:structuredClone(plan.parents),target};
      const observations = await observer.observe(inner, {signal});
      if (observations.first_observation.target.current_state !== "active" ||
          observations.second_observation.target.current_state !== "active") fail("CURRENT_LOCATION_UNSUPPORTED");
      return observations;
    },
  });
}
