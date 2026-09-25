import { createResourceCenterFilesystemAdapter } from "./resource-center-filesystem-adapter.mjs";
import { createResourceCenterGovernedToolSurface } from "./resource-center-governed-tool-surface.mjs";
import { qualifyResourceCenterHost } from "./resource-center-host-qualification.mjs";

/**
 * Bootstraps the official filesystem-backed Host surface. Only listTools and
 * callTool escape this factory; the raw adapter and admissions stay private.
 */
export function createResourceCenterFilesystemToolHost({
  trusted_profile: trustedProfile,
  resolve_artifact: resolveArtifact,
  classify_observed_entry: classifyObservedEntry,
  filesystem,
  clock,
  admission_ttl_ms: admissionTtlMs,
} = {}) {
  const adapter = createResourceCenterFilesystemAdapter({
    trusted_profile: trustedProfile,
    resolve_artifact: resolveArtifact,
    classify_observed_entry: classifyObservedEntry,
    filesystem,
    clock,
    admission_ttl_ms: admissionTtlMs,
  });
  const surface = createResourceCenterGovernedToolSurface({ adapter });
  const qualification = qualifyResourceCenterHost({
    trusted_profile: trustedProfile,
    tools: surface.listTools(),
    config: { allowedDirectories: [] },
  });
  if (qualification.status !== "qualified") {
    const error = new Error("RESOURCE_CENTER_HOST_QUALIFICATION_FAILED");
    error.code = "RESOURCE_CENTER_HOST_QUALIFICATION_FAILED";
    error.qualification = qualification;
    throw error;
  }

  return Object.freeze({
    profile_identity: surface.profile_identity,
    qualification,
    listTools: surface.listTools,
    callTool: surface.callTool,
  });
}
