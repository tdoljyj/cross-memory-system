import { createResourceCenterFilesystemAdapter } from "./resource-center-filesystem-adapter.mjs";
import { createResourceCenterAuthorityClient } from "./resource-center-authority-client.mjs";
import { createGoogleDriveMetadataApi } from "./resource-center-google-drive-metadata.mjs";
import { createGoogleDriveProviderIdentityResolver } from "./resource-center-google-drive-identity.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "./resource-center-google-drive-postcondition.mjs";
import { createResourceCenterWriteClient } from "./resource-center-write-client.mjs";
import { createResourceCenterHostAdapter } from "./resource-center-mutation-host.mjs";
import { createGoogleDriveNativeCreateEffect } from "./resource-center-google-drive-create-effect.mjs";
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
 * `prepare_write` reserves and consumes a durable, exact Canonical intent;
 * `commit_post_write` is its Host-owned finalizer. Neither is a caller input.
 * Until a real CAS/Receipt service implementation is installed, omit them: the
 * online Host then exposes only boundary scanning and denies all mutations.
 * The in-process quarantine supplements the service's durable profile fence.
 * Installing callbacks alone is not proof of a qualified production service.
 */
export function createResourceCenterOnlineToolHost({
  trusted_profile: trustedProfile,
  resolve_artifact_online: resolveArtifactOnline,
  prepare_write: prepareWrite,
  commit_post_write: commitPostWrite,
  classify_observed_entry: classifyObservedEntry,
  filesystem,
  clock,
  admission_ttl_ms: admissionTtlMs,
  mutation_effect: mutationEffect,
  scan_boundary: scanBoundary,
  qualified_operations: qualifiedOperations = ["create"],
} = {}) {
  if (typeof resolveArtifactOnline !== "function") {
    throw new TypeError("A trusted online Artifact/Currentness resolver is required.");
  }
  if (mutationEffect !== undefined && typeof mutationEffect !== "function") {
    throw new TypeError("The provider effect must be a Host-owned function.");
  }
  if (scanBoundary !== undefined && (typeof scanBoundary !== "function" || typeof mutationEffect !== "function")) {
    throw new TypeError("A remote boundary scanner requires a Host-owned provider effect.");
  }
  // Only operations whose journal/finalization contract the caller wires are
  // qualified. Rename and file move have one only in the account-policy
  // cloud executor (verified settlement); every other Host keeps create only.
  const qualified = new Set(Array.isArray(qualifiedOperations) ? qualifiedOperations : [null]);
  const single = qualified.size === 1 && qualifiedOperations.length === 1 ? qualifiedOperations[0] : null;
  if (single !== "create" && !(["rename", "move"].includes(single) && typeof mutationEffect === "function")) {
    throw new TypeError("Qualified operations must be create, or one Host-owned rename/move effect.");
  }

  const profile = structuredClone(trustedProfile);
  let quarantined = false;
  let mutationInFlight = false;
  const scanner = scanBoundary ? {
    profile_identity: createResourceCenterHostAdapter({ trusted_profile: profile,
      resolve_artifact: () => { throw new Error("SCAN_ONLY"); }, effect: mutationEffect }).profile_identity,
    scanBoundary,
  } : createResourceCenterFilesystemAdapter({
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
    // A definite unsupported operation has not reserved anything and must not quarantine.
    if (!qualified.has(mutation.operation)) return deny("WRITER_OPERATION_NOT_QUALIFIED");
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

    const adapter = (mutationEffect ? createResourceCenterHostAdapter : createResourceCenterFilesystemAdapter)({
      trusted_profile: profile,
      resolve_artifact: () => authority,
      classify_observed_entry: classifyObservedEntry,
      filesystem,
      clock,
      admission_ttl_ms: admissionTtlMs,
      effect: mutationEffect,
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
    if (typeof prepareWrite !== "function") {
      return deny("DURABLE_WRITE_RESERVATION_UNAVAILABLE");
    }
    let reservation;
    try {
      reservation = await prepareWrite(Object.freeze({
        ...request, binding: preflight.admission.binding,
      }));
      if (reservation?.status !== "started" || reservation.execution_permitted !== true ||
        typeof reservation.intent_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservation.intent_id) ||
        reservation.request_sha256 !== preflight.admission.binding.request_sha256) {
        throw new Error("RESERVATION_INVALID");
      }
      reservation = Object.freeze(structuredClone(reservation));
    } catch {
      // A lost start response may have consumed the durable reservation. Do
      // not retry the effect or clear it; recovery inspects Canonical state.
      quarantined = true;
      return deny("DURABLE_WRITE_RESERVATION_FAILED");
    }
    let effect;
    try {
      // prepare/start includes asynchronous provider and Canonical work. Bind
      // the effect to freshly resolved authority, not the pre-prepare cache.
      authority = await resolveArtifactOnline(request);
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
    if (effect.status !== "committed") {
      // The service has already fenced the operation. Even a local admission
      // denial requires reconciliation rather than silently abandoning it.
      quarantined = true;
      return effect;
    }
    try {
      const receipt = await commitPostWrite(Object.freeze({
        mutation: Object.freeze(structuredClone(mutation)),
        binding: effect.binding,
        reservation,
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
    listTools: () => typeof commitPostWrite === "function" && typeof prepareWrite === "function" && !quarantined
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
  get_drive_credential: getDriveCredential,
  drive_fetch: driveFetch,
  authority_fetch: authorityFetch,
  ...hostOptions
} = {}) {
  const metadata = createGoogleDriveMetadataApi({
    get_access_token: getDriveAccessToken,
    get_credential: getDriveCredential,
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
      get_sharing: metadata.getSharing,
    }),
  });
}

/** A pathname/hash is not proof of local-object -> Drive ID identity. Keep
 * the former mounted candidate unavailable until that mapping is qualified. */
export function createResourceCenterGoogleDriveWriterToolHost() {
  throw new Error("DRIVE_MOUNTED_WRITER_IDENTITY_UNQUALIFIED");
}

/** Native Drive candidate: Agent callers never receive credentials, generated
 * IDs, provider attempts or raw effect APIs. Production use still requires
 * review, isolated bootstrap and temporary end-to-end provider qualification. */
export function createResourceCenterGoogleDriveNativeWriterToolHost({
  trusted_profile: trustedProfile, root_folder_id: rootFolderId, root_parent_id: rootParentId,
  get_drive_credential: getDriveCredential, drive_fetch: driveFetch,
  authority_fetch: authorityFetch, writer_endpoint: writerEndpoint,
  writer_binding_token: writerBindingToken, persist_recovery: persistRecovery,
  persist_provider_attempt: persistProviderAttempt, ...hostOptions
} = {}) {
  const metadata = createGoogleDriveMetadataApi({ get_credential: getDriveCredential, fetch: driveFetch });
  const pinned = { managed_root: trustedProfile?.managed_root, root_folder_id: rootFolderId,
    root_parent_id: rootParentId, get_file: metadata.getFile, list_children: metadata.listChildren };
  const resolve = createGoogleDriveProviderIdentityResolver({ ...pinned, get_sharing: metadata.getSharing });
  const startedProviders = new Map();
  let preparedProvider;
  const writer = createResourceCenterWriteClient({ endpoint: writerEndpoint, binding_token: writerBindingToken,
    resolve_provider_identity: async (request) => { preparedProvider = await resolve(request); return preparedProvider; },
    verify_postcondition: createGoogleDriveCreatePostconditionVerifier({ ...pinned, require_effect_provider_id: true }),
    persist_recovery: persistRecovery, fetch: authorityFetch });
  const effect = createGoogleDriveNativeCreateEffect({ trusted_profile: trustedProfile,
    get_credential: getDriveCredential, resolve_provider_identity: resolve,
    consume_started_provider: (binding) => {
      const started = startedProviders.get(binding.request_sha256);
      startedProviders.delete(binding.request_sha256);
      return started;
    }, persist_provider_attempt: persistProviderAttempt, fetch: driveFetch, clock: hostOptions.clock });
  return createResourceCenterOnlineToolHostFromService({ ...hostOptions,
    trusted_profile: trustedProfile, fetch: authorityFetch, resolve_provider_identity: resolve,
    mutation_effect: effect, commit_post_write: writer.commit_post_write,
    prepare_write: async (request) => {
      preparedProvider = undefined;
      const started = await writer.prepare_write(request);
      if (!preparedProvider) throw new Error("DRIVE_NATIVE_PREPARED_IDENTITY_UNAVAILABLE");
      startedProviders.set(request.binding.request_sha256, Object.freeze({
        ...started, provider: structuredClone(preparedProvider) }));
      return started;
    } });
}
