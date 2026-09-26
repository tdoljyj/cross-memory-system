import { createResourceCenterFilesystemToolHost } from "./resource-center-filesystem-tool-host.mjs";
import { qualifyResourceCenterHost } from "./resource-center-host-qualification.mjs";
import {
  RESOURCE_CENTER_MUTATION_TOOL,
} from "./resource-center-governed-tool-surface.mjs";

/**
 * Read-only endpoint pilot. It proves the separate MCP transport and real
 * boundary scanner without inventing an Artifact/Currentness authority source.
 * A later, separately qualified Host must replace this factory to enable writes.
 */
export function createResourceCenterStdioPilot({ trusted_profile: trustedProfile, filesystem } = {}) {
  const host = createResourceCenterFilesystemToolHost({
    trusted_profile: trustedProfile,
    filesystem,
    resolve_artifact: () => {
      throw new Error("TRUSTED_ARTIFACT_CURRENTNESS_RESOLVER_UNAVAILABLE");
    },
  });
  const tools = Object.freeze(host.listTools().map((tool) => Object.freeze(
    tool.name === RESOURCE_CENTER_MUTATION_TOOL
      ? { ...tool, description: "Read-only pilot: Resource Center mutations always fail closed until a trusted live Artifact/Currentness resolver is installed." }
      : tool,
  )));
  const qualification = qualifyResourceCenterHost({ trusted_profile: trustedProfile, tools });
  if (qualification.status !== "qualified") {
    throw new Error("RESOURCE_CENTER_PILOT_TOOL_SURFACE_NOT_QUALIFIED");
  }

  return Object.freeze({
    listTools: () => tools,
    async callTool(name, args = {}) {
      if (name === RESOURCE_CENTER_MUTATION_TOOL) {
        return Object.freeze({
          status: "deny",
          error_code: "TRUSTED_ARTIFACT_CURRENTNESS_RESOLVER_UNAVAILABLE",
          side_effects: 0,
        });
      }
      return host.callTool(name, args);
    },
  });
}
