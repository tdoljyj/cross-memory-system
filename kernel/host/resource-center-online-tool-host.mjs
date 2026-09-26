import { createResourceCenterFilesystemAdapter } from "./resource-center-filesystem-adapter.mjs";
import { createResourceCenterGovernedToolSurface } from "./resource-center-governed-tool-surface.mjs";

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
 */
export function createResourceCenterOnlineToolHost({
  trusted_profile: trustedProfile,
  resolve_artifact_online: resolveArtifactOnline,
  classify_observed_entry: classifyObservedEntry,
  filesystem,
  clock,
  admission_ttl_ms: admissionTtlMs,
} = {}) {
  if (typeof resolveArtifactOnline !== "function") {
    throw new TypeError("A trusted online Artifact/Currentness resolver is required.");
  }

  const profile = structuredClone(trustedProfile);
  const scanner = createResourceCenterFilesystemAdapter({
    trusted_profile: profile,
    resolve_artifact: () => { throw new Error("SCAN_ONLY"); },
    classify_observed_entry: classifyObservedEntry,
    filesystem,
    clock,
    admission_ttl_ms: admissionTtlMs,
  });

  async function guardedMutation(mutation) {
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
    return adapter.commitMutation({ admission: preflight.admission, mutation });
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
    listTools: surface.listTools,
    callTool: surface.callTool,
  });
}
