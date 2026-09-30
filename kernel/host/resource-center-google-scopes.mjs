/** Kernel mirror of apps/clued-cloud/worker/storage-google-scopes.ts
 * (StorageNormalUse.v0.1 §2.2). These two modules are the only non-test places
 * that may spell a Google scope URL, besides the local pilot credential
 * (resource-center-google-drive-credential.mjs). Exported values must stay
 * equal item by item (checked by apps/clued-cloud/apps/clued-cloud/tests/resource-center-google-scopes.test.mjs).
 *
 * legacy: drive.file + drive.metadata.readonly.
 * normal: legacy + drive.readonly.
 * Any other set, including one with `drive` or `drive.metadata`, has no profile. */

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DRIVE_METADATA_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
export const GOOGLE_DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Scopes any one of which proves Drive namespace visibility (absence and
 * uniqueness checks of the metadata API). Not an allowed connection set:
 * `drive.metadata` and `drive` still have no profile. */
export const NAMESPACE_READ_SCOPES = Object.freeze([GOOGLE_DRIVE_METADATA_READONLY_SCOPE, GOOGLE_DRIVE_METADATA_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE, GOOGLE_DRIVE_SCOPE].sort());

/** @type {readonly ("legacy"|"normal")[]} */
export const STORAGE_SCOPE_PROFILES = Object.freeze(["legacy", "normal"]);

/** Requested set per profile, deduplicated and sorted. */
export const STORAGE_GOOGLE_SCOPE_SETS = Object.freeze({
  legacy: Object.freeze([GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_METADATA_READONLY_SCOPE].sort()),
  normal: Object.freeze([GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_METADATA_READONLY_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE].sort()),
});

/** @param {unknown} value @returns {value is "legacy"|"normal"} */
export const isStorageScopeProfile = (value) => value === "legacy" || value === "normal";

/** Space-separated, deduplicated, sorted scope string of a profile.
 * @param {"legacy"|"normal"} profile */
export function scopeString(profile) {
  if (!isStorageScopeProfile(profile)) throw new TypeError("unknown scope profile");
  return STORAGE_GOOGLE_SCOPE_SETS[profile].join(" ");
}

/** @param {unknown} value @returns {string[] | null} */
export function normalizeScopes(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return [...new Set(trimmed.split(/\s+/))].sort();
}

/** Exact-set comparison after dedupe and sort.
 * @param {unknown} value @returns {"legacy"|"normal"|null} */
export function scopeProfile(value) {
  const scopes = normalizeScopes(value);
  if (!scopes) return null;
  const key = scopes.join(" ");
  for (const profile of STORAGE_SCOPE_PROFILES) if (key === scopeString(profile)) return profile;
  return null;
}
