import { RESOURCE_CENTER_POLICY_VERSION } from "../policy/resource-center-mutation-policy.mjs";
import {
  RESOURCE_CENTER_BOUNDARY_SCAN_TOOL,
  RESOURCE_CENTER_MUTATION_TOOL,
} from "./resource-center-governed-tool-surface.mjs";

export const RESOURCE_CENTER_HOST_QUALIFICATION_VERSION = "clued.resource-center-host-qualification/1";

const CALLER_AUTHORITY_FIELDS = new Set([
  "admission",
  "profile",
  "registered_profile",
  "profile_id",
  "profile_version",
  "managed_root",
  "allowed_root_children",
  "status_directory_names",
  "registered_external_roots",
  "boundary_scan_roots",
  "boundary_scan_max_depth",
  "boundary_scan_max_entries",
  "policy_version",
  "governance_class",
  "delete_authority",
  "artifact_authority_version",
  "artifact_id",
  "artifact_role",
  "currentness_identity",
  "workspace_version",
]);

const GENERIC_MUTATION_NAMES = new Set([
  "write_file",
  "write_pdf",
  "create_directory",
  "move_file",
  "rename_file",
  "copy_file",
  "delete_file",
  "remove_file",
  "replace_file",
  "edit_block",
  "mkdir",
  "rmdir",
]);

const OPEN_PROCESS_NAMES = new Set([
  "start_process",
  "exec",
  "exec_command",
  "execute_command",
  "run_command",
  "shell",
  "terminal",
  "powershell",
  "command_prompt",
]);

function terminalToolName(name) {
  const normalized = String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[.:/\\-]+/g, "_");
  for (const candidate of [...GENERIC_MUTATION_NAMES, ...OPEN_PROCESS_NAMES].sort((a, b) => b.length - a.length)) {
    if (normalized === candidate || normalized.endsWith(`_${candidate}`)) return candidate;
  }
  return normalized;
}

function isGateInternalTool(name) {
  const normalized = String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[.:/\\-]+/g, "_");
  return normalized.includes("resource_center_preflight") ||
    normalized.includes("resource_center_commit_mutation") ||
    normalized.includes("resource_center_admission");
}

function normalizePath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const drive = /^[A-Za-z]:/.exec(raw)?.[0] ?? "";
  const absolute = raw.startsWith("/") || drive !== "";
  const rest = drive ? raw.slice(drive.length) : raw;
  const parts = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  const prefix = drive ? `${drive[0].toUpperCase()}:/` : absolute ? "/" : "";
  const result = prefix + parts.join("/");
  return (result.length > 1 ? result.replace(/\/$/, "") : result).toLowerCase();
}

function parentPath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return null;
  const index = normalized.lastIndexOf("/");
  return index > 2 ? normalized.slice(0, index) : normalized.slice(0, index + 1);
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function finding(code, details = {}) {
  return Object.freeze({ code, ...details });
}

function toolSchema(tool) {
  return tool?.inputSchema ?? tool?.input_schema ?? {};
}

function profileSnapshot(profile) {
  if (!profile || profile.registration_status !== "registered" ||
    typeof profile.profile_id !== "string" || profile.profile_id.trim() === "" ||
    typeof profile.profile_version !== "string" || profile.profile_version.trim() === "" ||
    !normalizePath(profile.managed_root)) {
    throw new TypeError("A registered Host-owned Resource Center profile is required for qualification.");
  }
  return Object.freeze({
    profile_id: profile.profile_id.trim(),
    profile_version: profile.profile_version.trim(),
    managed_root: normalizePath(profile.managed_root),
    boundary_scan_roots: Object.freeze((profile.boundary_scan_roots ?? []).map(normalizePath).filter(Boolean)),
  });
}

function verifyGovernedMutationSchema(tool, findings) {
  const schema = toolSchema(tool);
  const properties = schema?.properties ?? {};
  if (schema?.type !== "object" || schema?.additionalProperties !== false ||
    !Array.isArray(schema?.required) || !schema.required.includes("operation")) {
    findings.push(finding("GOVERNED_MUTATION_SCHEMA_NOT_CLOSED"));
  }
  for (const field of Object.keys(properties)) {
    if (CALLER_AUTHORITY_FIELDS.has(field)) {
      findings.push(finding("CALLER_AUTHORITY_FIELD_EXPOSED", { field }));
    }
  }
  const operations = properties?.operation?.enum;
  if (!Array.isArray(operations) ||
    ["create", "write", "move", "rename", "replace", "delete"].some((item) => !operations.includes(item))) {
    findings.push(finding("GOVERNED_MUTATION_OPERATIONS_INCOMPLETE"));
  }
}

function verifyBoundaryScanSchema(tool, findings) {
  const schema = toolSchema(tool);
  if (schema?.type !== "object" || schema?.additionalProperties !== false ||
    Object.keys(schema?.properties ?? {}).length !== 0 ||
    (Array.isArray(schema?.required) && schema.required.length !== 0)) {
    findings.push(finding("BOUNDARY_SCAN_SCHEMA_NOT_CLOSED"));
  }
}

/**
 * Deterministically qualifies an actual Host tool manifest/configuration.
 * It never calls a model and does not mutate Host configuration.
 */
export function qualifyResourceCenterHost({ trusted_profile: trustedProfile, tools, config = {} } = {}) {
  const profile = profileSnapshot(trustedProfile);
  const manifest = Array.isArray(tools) ? tools : [];
  const findings = [];
  const byName = new Map(manifest.map((tool) => [tool?.name, tool]));

  const governedMutation = byName.get(RESOURCE_CENTER_MUTATION_TOOL);
  if (!governedMutation) findings.push(finding("GOVERNED_MUTATION_TOOL_MISSING"));
  else verifyGovernedMutationSchema(governedMutation, findings);
  const boundaryScan = byName.get(RESOURCE_CENTER_BOUNDARY_SCAN_TOOL);
  if (!boundaryScan) {
    findings.push(finding("BOUNDARY_SCAN_TOOL_MISSING"));
  } else verifyBoundaryScanSchema(boundaryScan, findings);

  const processTools = manifest
    .map((tool) => tool?.name)
    .filter((name) => OPEN_PROCESS_NAMES.has(terminalToolName(name)));
  for (const tool of processTools) findings.push(finding("OPEN_WORLD_PROCESS_TOOL_EXPOSED", { tool }));

  const genericMutationTools = manifest
    .map((tool) => tool?.name)
    .filter((name) => GENERIC_MUTATION_NAMES.has(terminalToolName(name)));
  if (genericMutationTools.length > 0) {
    const allowedDirectories = config?.allowedDirectories;
    if (!Array.isArray(allowedDirectories) || allowedDirectories.length === 0) {
      findings.push(finding("GENERIC_MUTATION_SCOPE_UNPROVEN", { tools: genericMutationTools }));
    } else {
      const normalizedDirectories = allowedDirectories.map(normalizePath);
      if (normalizedDirectories.some((value) => !value || !/^([a-z]:\/|\/)/.test(value))) {
        findings.push(finding("GENERIC_MUTATION_SCOPE_UNPROVEN", { tools: genericMutationTools }));
      }
      const protectedRoots = [
        profile.managed_root,
        parentPath(profile.managed_root),
        ...profile.boundary_scan_roots,
      ].filter(Boolean);
      for (const allowed of normalizedDirectories.filter(Boolean)) {
        if (protectedRoots.some((root) => overlaps(allowed, root))) {
          findings.push(finding("GENERIC_MUTATION_SCOPE_OVERLAPS_GOVERNED_BOUNDARY", {
            allowed_directory: allowed,
            tools: genericMutationTools,
          }));
        }
      }
    }
  }

  for (const tool of manifest) {
    const properties = toolSchema(tool)?.properties ?? {};
    if (isGateInternalTool(tool?.name)) {
      findings.push(finding("GATE_INTERNAL_TOOL_EXPOSED", { tool: tool?.name ?? null }));
    }
    if (Object.hasOwn(properties, "admission")) {
      findings.push(finding("CALLER_ADMISSION_FIELD_EXPOSED", { tool: tool?.name ?? null }));
    }
  }

  return Object.freeze({
    status: findings.length === 0 ? "qualified" : "not_qualified",
    qualification_version: RESOURCE_CENTER_HOST_QUALIFICATION_VERSION,
    policy_version: RESOURCE_CENTER_POLICY_VERSION,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    findings: Object.freeze(findings),
  });
}
