import { createResourceCenterFilesystemAdapter } from "./resource-center-filesystem-adapter.mjs";
import { createResourceCenterGovernedToolSurface } from "./resource-center-governed-tool-surface.mjs";

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
  return Object.freeze({
    profile_identity: surface.profile_identity,
    // The enclosing Host must qualify its complete tool registry after this
    // surface is registered. This factory cannot certify its own two tools as
    // proof that no bypass exists elsewhere in the actual Host.
    listTools: surface.listTools,
    callTool: surface.callTool,
  });
}
