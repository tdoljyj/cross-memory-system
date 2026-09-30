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
