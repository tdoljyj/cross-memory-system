import { createResourceCenterFilesystemAdapter } from "./resource-center-filesystem-adapter.mjs";
import { createResourceCenterAuthorityClient } from "./resource-center-authority-client.mjs";
import { createGoogleDriveMetadataApi } from "./resource-center-google-drive-metadata.mjs";
import { createGoogleDriveProviderIdentityResolver } from "./resource-center-google-drive-identity.mjs";
import {
  createResourceCenterGovernedToolSurface,
  RESOURCE_CENTER_MUTATION_TOOL,
} from "./resource-center-governed-tool-surface.mjs";

function deny(errorCode) {
  return Object.freeze({ status: "deny", error_code: errorCode, side_effects: 0 });
}

/**
 * Bridge an asynchronous, Host-owned online authority lookup to the existing
 * in-process single-use admission. This is a bootstrap dependency, never a
 * caller tool argument. A new adapter instance per call prevents one request's
 * authority snapshot from being observed by another concurrent request.
 *
 * The lookup must itself authenticate a least-privilege Binding and return a
 * live, path-specific Artifact/Currentness result. This factory does not treat
 * a local file, caller claim, or cached snapshot as that authority.
 * `commit_post_write` is a Host-owned Canonical finalizer, not a caller input.
 * Until a real CAS/Receipt service implementation is installed, omit it: the
 * online Host then exposes only boundary scanning and denies all mutations.
 * An in-process quarantine is a local fail-closed measure, not durable
 * recovery or proof that another Host instance cannot write.
 */
export function createResourceCenterOnlineToolHost({
  trusted_profile: trustedProfile,
  resolve_artifact_online: resolveArtifactOnline,
  commit_post_write: commitPostWrite,
  classify_observed_entry: classifyObservedEntry,
  filesystem,
  clock,
  admission_ttl_ms: admissionTtlMs,
} = {}) {
  if (typeof resolveArtifactOnline !== "function") {
    throw new TypeError("A trusted online Artifact/Currentness resolver is required.");
  }

  const profile = structuredClone(trustedProfile);
  let quarantined = false;
  let mutationInFlight = false;
  const scanner = createResourceCenterFilesystemAdapter({
    trusted_profile: profile,
    resolve_artifact: () => { throw new Error("SCAN_ONLY"); },
    classify_observed_entry: classifyObservedEntry,
    filesystem,
    clock,
    admission_ttl_ms: admissionTtlMs,
  });

  async function guardedMutation(mutation) {
    if (quarantined) return deny("POST_WRITE_RECONCILIATION_REQUIRED");
    if (mutationInFlight) return deny("MUTATION_ALREADY_IN_PROGRESS");
    mutationInFlight = true;
    try {
      return await executeMutation(mutation);
    } finally {
      mutationInFlight = false;
    }
  }

  async function executeMutation(mutation) {
    let authority;
    const request = Object.freeze({
      profile: Object.freeze(structuredClone(profile)),
      mutation: Object.freeze(structuredClone(mutation)),
    });
    try {
      authority = await resolveArtifactOnline(request);
    } catch {
      return deny("ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
    }

    const adapter = createResourceCenterFilesystemAdapter({
      trusted_profile: profile,
      resolve_artifact: () => authority,
      classify_observed_entry: classifyObservedEntry,
      filesystem,
      clock,
      admission_ttl_ms: admissionTtlMs,
    });
    const preflight = adapter.preflight(mutation);
    if (preflight.status !== "admitted") return preflight;

    try {
      authority = await resolveArtifactOnline(request);
    } catch {
      return deny("ARTIFACT_AUTHORITY_REVALIDATION_FAILED");
    }
    // Read authority alone is not a write grant. Without a Host-owned
    // Canonical finalizer, refuse before the filesystem effect.
    if (typeof commitPostWrite !== "function") {
      return deny("POST_WRITE_CANONICAL_RECEIPT_UNAVAILABLE");
    }
    let effect;
    try {
      effect = await adapter.commitMutation({ admission: preflight.admission, mutation });
    } catch {
      // A thrown provider call may have changed storage before it failed.
      quarantined = true;
      return Object.freeze({
        status: "unreconciled",
        error_code: "PROVIDER_MUTATION_OUTCOME_UNKNOWN",
        side_effects: "unknown",
      });
    }
    if (effect.status !== "committed") return effect;
    try {
      const receipt = await commitPostWrite(Object.freeze({
        mutation: Object.freeze(structuredClone(mutation)),
        binding: effect.binding,
        effect_result: effect.effect_result,
      }));
      if (receipt?.status !== "committed" ||
        typeof receipt.receipt_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.receipt_id) ||
        receipt.request_sha256 !== effect.binding.request_sha256) {
        throw new Error("POST_WRITE_RECEIPT_INVALID");
      }
      return Object.freeze({ ...effect, canonical_receipt_id: receipt.receipt_id });
    } catch {
      // Never report a storage effect as a committed Canonical mutation.
      // Keep this Host instance closed until an operator reconciles it.
      quarantined = true;
      return Object.freeze({
        status: "unreconciled",
        error_code: "POST_WRITE_CANONICAL_RECONCILIATION_FAILED",
        side_effects: 1,
      });
    }
  }

  const surface = createResourceCenterGovernedToolSurface({
    adapter: Object.freeze({
      profile_identity: scanner.profile_identity,
      guardedMutation,
      scanBoundary: scanner.scanBoundary,
    }),
  });
  return Object.freeze({
    profile_identity: surface.profile_identity,
    // A read-only registration must not advertise a qualified mutation tool.
    listTools: () => typeof commitPostWrite === "function"
      ? surface.listTools()
      : surface.listTools().filter((tool) => tool.name !== RESOURCE_CENTER_MUTATION_TOOL),
    callTool: surface.callTool,
  });
}

/** Production wiring: the only remote lookup comes from a Host-held Binding. */
export function createResourceCenterOnlineToolHostFromService({
  authority_endpoint: authorityEndpoint,
  authority_binding_token: authorityBindingToken,
  resolve_provider_identity: resolveProviderIdentity,
  fetch,
  ...hostOptions
} = {}) {
  return createResourceCenterOnlineToolHost({
    ...hostOptions,
    resolve_artifact_online: createResourceCenterAuthorityClient({
      endpoint: authorityEndpoint,
      binding_token: authorityBindingToken,
      resolve_provider_identity: resolveProviderIdentity,
      fetch,
    }),
  });
}

/** Compose the pinned Drive identity and Clued authority checks at bootstrap. */
export function createResourceCenterGoogleDriveOnlineToolHost({
  trusted_profile: trustedProfile,
  root_folder_id: rootFolderId,
  root_parent_id: rootParentId,
  get_drive_access_token: getDriveAccessToken,
  drive_fetch: driveFetch,
  authority_fetch: authorityFetch,
  ...hostOptions
} = {}) {
  const metadata = createGoogleDriveMetadataApi({
    get_access_token: getDriveAccessToken,
    fetch: driveFetch,
  });
  return createResourceCenterOnlineToolHostFromService({
    ...hostOptions,
    trusted_profile: trustedProfile,
    fetch: authorityFetch,
    resolve_provider_identity: createGoogleDriveProviderIdentityResolver({
      managed_root: trustedProfile?.managed_root,
      root_folder_id: rootFolderId,
      root_parent_id: rootParentId,
      get_file: metadata.getFile,
      list_children: metadata.listChildren,
    }),
  });
}
