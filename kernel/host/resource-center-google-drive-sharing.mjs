import { createHash } from "node:crypto";

/**
 * Digest of a Drive item's sharing state: whether it is shared and the exact
 * set of permission IDs with access. A registered directory keeps its digest
 * in the registry; a changed digest means its sharing or permissions changed.
 * Returns null when Drive did not return both fields, so callers fail closed.
 */
export function googleDriveSharingDigest(file) {
  if (!file || typeof file.shared !== "boolean" || !Array.isArray(file.permissionIds) ||
    file.permissionIds.length > 1000 ||
    !file.permissionIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(id))) {
    return null;
  }
  const permissionIds = [...new Set(file.permissionIds)].sort();
  return createHash("sha256")
    .update(JSON.stringify({ shared: file.shared, permission_ids: permissionIds }))
    .digest("hex");
}

const text = (value) => typeof value === "string" && value.length <= 320;
const optionalText = (value) => value === undefined || value === null || text(value);

/**
 * Digest of a Drive item's access: every permission with its grantee kind,
 * role, domain, discoverability and expiry (StorageFullCapability P6). Unlike
 * the sharing digest it changes when only a role changes, so a directory
 * moves only between folders that grant exactly the same access. Returns null
 * when Drive did not return a usable permission list, so callers fail closed.
 */
export function googleDriveAccessDigest(file) {
  const permissions = file?.permissions;
  if (!Array.isArray(permissions) || permissions.length < 1 || permissions.length > 1000 ||
    !permissions.every((p) => p && typeof p === "object" && typeof p.id === "string" &&
      /^[A-Za-z0-9_.:-]{1,200}$/.test(p.id) && text(p.type) && text(p.role) && optionalText(p.domain) &&
      optionalText(p.expirationTime) && (p.allowFileDiscovery === undefined || typeof p.allowFileDiscovery === "boolean") &&
      (p.deleted === undefined || typeof p.deleted === "boolean"))) {
    return null;
  }
  const entries = permissions.map((p) => [p.id, p.type, p.role, p.domain ?? null, p.allowFileDiscovery ?? null,
    p.expirationTime ?? null, p.deleted === true])
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return createHash("sha256").update(JSON.stringify({ permissions: entries })).digest("hex");
}
