/** StorageNormalUse.v0.1 §2.2: the only Google Drive scope sets Clued accepts.
 * This module and its kernel mirror (kernel/host/resource-center-google-scopes.mjs)
 * are the only non-test places that may spell a Google scope URL, besides the
 * local pilot credential. Their exported values must stay equal item by item
 * (checked by apps/clued-cloud/tests/resource-center-google-scopes.test.mjs).
 *
 * legacy: drive.file + drive.metadata.readonly (bodies of Clued-created files only).
 * normal: legacy + drive.readonly (any body under the registered root, enforced
 *         server-side; no read path uses it before N1).
 * full:   normal + drive (StorageFullCapability P7: modify existing files Clued
 *         adopted under the registered root, enforced server-side).
 * Any other set, including one with `drive.metadata`, has no profile. */
export type StorageScopeProfile = "legacy" | "normal" | "full";

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DRIVE_METADATA_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
export const GOOGLE_DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Scopes any one of which proves Drive namespace visibility (absence and
 * uniqueness checks of the metadata API). Not an allowed connection set:
 * `drive.metadata` still has no profile. */
export const NAMESPACE_READ_SCOPES: readonly string[] = Object.freeze([GOOGLE_DRIVE_METADATA_READONLY_SCOPE, GOOGLE_DRIVE_METADATA_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE, GOOGLE_DRIVE_SCOPE].sort());

export const STORAGE_SCOPE_PROFILES: readonly StorageScopeProfile[] = Object.freeze(["legacy", "normal", "full"] as StorageScopeProfile[]);

/** Requested set per profile, deduplicated and sorted. */
export const STORAGE_GOOGLE_SCOPE_SETS: Readonly<Record<StorageScopeProfile, readonly string[]>> = Object.freeze({
  legacy: Object.freeze([GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_METADATA_READONLY_SCOPE].sort()),
  normal: Object.freeze([GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_METADATA_READONLY_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE].sort()),
  full: Object.freeze([GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_METADATA_READONLY_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE,
    GOOGLE_DRIVE_SCOPE].sort()),
});

export const isStorageScopeProfile = (value: unknown): value is StorageScopeProfile =>
  value === "legacy" || value === "normal" || value === "full";

/** Each profile includes every lower one: full reads like normal (P7). */
export const scopeProfileCovers = (profile: unknown, wanted: StorageScopeProfile): boolean =>
  isStorageScopeProfile(profile) && STORAGE_SCOPE_PROFILES.indexOf(profile) >= STORAGE_SCOPE_PROFILES.indexOf(wanted);

/** Space-separated, deduplicated, sorted scope string of a profile. */
export function scopeString(profile: StorageScopeProfile): string {
  if (!isStorageScopeProfile(profile)) throw new TypeError("unknown scope profile");
  return STORAGE_GOOGLE_SCOPE_SETS[profile].join(" ");
}

/** Deduplicated, sorted scopes of a space-separated OAuth scope value, or null
 * when it is not a non-empty string. */
export function normalizeScopes(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return [...new Set(trimmed.split(/\s+/))].sort();
}

/** Exact-set comparison after dedupe and sort: "legacy", "normal", "full" or null. */
export function scopeProfile(value: unknown): StorageScopeProfile | null {
  const scopes = normalizeScopes(value);
  if (!scopes) return null;
  const key = scopes.join(" ");
  for (const profile of STORAGE_SCOPE_PROFILES) if (key === scopeString(profile)) return profile;
  return null;
}
