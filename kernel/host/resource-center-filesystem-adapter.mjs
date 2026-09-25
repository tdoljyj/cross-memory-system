import fs from "node:fs/promises";
import path from "node:path";

import { createResourceCenterHostAdapter } from "./resource-center-mutation-host.mjs";

const DEFAULT_SCAN_MAX_DEPTH = 8;
const DEFAULT_SCAN_MAX_ENTRIES = 10_000;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function positiveInteger(value, fallback, code) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) fail(code);
  return selected;
}

function snapshotProfile(profile) {
  if (!profile || profile.registration_status !== "registered" ||
    typeof profile.managed_root !== "string" || profile.managed_root.trim() === "") {
    fail("RESOURCE_CENTER_REGISTERED_PROFILE_REQUIRED");
  }
  const managedRoot = profile.managed_root.trim();
  const scanRoots = [path.dirname(managedRoot), ...(profile.boundary_scan_roots ?? [])];
  return Object.freeze({
    ...profile,
    allowed_root_children: Object.freeze([...(profile.allowed_root_children ?? [])]),
    registered_external_roots: Object.freeze([...(profile.registered_external_roots ?? [])]),
    boundary_scan_roots: Object.freeze([...new Set(scanRoots.map((value) => path.resolve(value)))]),
    boundary_scan_max_depth: positiveInteger(
      profile.boundary_scan_max_depth,
      DEFAULT_SCAN_MAX_DEPTH,
      "BOUNDARY_SCAN_MAX_DEPTH_INVALID",
    ),
    boundary_scan_max_entries: positiveInteger(
      profile.boundary_scan_max_entries,
      DEFAULT_SCAN_MAX_ENTRIES,
      "BOUNDARY_SCAN_MAX_ENTRIES_INVALID",
    ),
  });
}

function contentFor(mutation) {
  if (typeof mutation.content !== "string") fail("RESOURCE_CENTER_TEXT_CONTENT_REQUIRED");
  return mutation.content;
}

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(candidate, root) {
  const child = pathKey(candidate);
  const boundary = pathKey(root);
  return child === boundary || child.startsWith(boundary + path.sep);
}

async function existingRealRoots(filesystem, roots) {
  const result = [];
  for (const root of roots) {
    try {
      result.push(await filesystem.realpath(root));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return result;
}

async function assertExistingPathWithin(filesystem, candidate, roots, code) {
  const realCandidate = await filesystem.realpath(candidate);
  const realRoots = await existingRealRoots(filesystem, roots);
  if (!realRoots.some((root) => isWithin(realCandidate, root))) fail(code, { path: candidate });
}

async function assertDestinationParentWithin(filesystem, candidate, managedRoot) {
  const realParent = await filesystem.realpath(path.dirname(candidate));
  const realManagedRoot = await filesystem.realpath(managedRoot);
  if (!isWithin(realParent, realManagedRoot)) {
    fail("DESTINATION_REALPATH_OUTSIDE_MANAGED_ROOT", { path: candidate });
  }
}

async function applyFilesystemMutation(filesystem, profile, mutation) {
  const destination = mutation.destination_path;
  const source = mutation.source_path;
  const sourceRoots = [profile.managed_root, ...profile.registered_external_roots];
  switch (mutation.operation) {
    case "create":
      await assertDestinationParentWithin(filesystem, destination, profile.managed_root);
      if (mutation.target_kind === "directory") {
        await filesystem.mkdir(destination, { recursive: false });
      } else {
        await filesystem.writeFile(destination, mutation.content ?? "", { flag: "wx" });
      }
      break;
    case "write":
      if (mutation.target_kind === "directory") fail("DIRECTORY_WRITE_FORBIDDEN");
      await assertExistingPathWithin(filesystem, destination, [profile.managed_root], "DESTINATION_REALPATH_OUTSIDE_MANAGED_ROOT");
      await filesystem.writeFile(destination, contentFor(mutation), { flag: "r+" });
      break;
    case "replace":
      if (mutation.target_kind === "directory") fail("DIRECTORY_REPLACE_FORBIDDEN");
      await assertExistingPathWithin(filesystem, destination, [profile.managed_root], "DESTINATION_REALPATH_OUTSIDE_MANAGED_ROOT");
      await filesystem.writeFile(destination, contentFor(mutation), { flag: "w" });
      break;
    case "move":
    case "rename":
      await assertExistingPathWithin(filesystem, source, sourceRoots, "SOURCE_REALPATH_OUTSIDE_REGISTERED_ROOT");
      await assertDestinationParentWithin(filesystem, destination, profile.managed_root);
      await filesystem.rename(source, destination);
      break;
    case "delete":
      await assertExistingPathWithin(filesystem, source, sourceRoots, "SOURCE_REALPATH_OUTSIDE_REGISTERED_ROOT");
      if (mutation.target_kind === "directory") await filesystem.rmdir(source);
      else await filesystem.unlink(source);
      break;
    default:
      fail("MUTATION_OPERATION_INVALID");
  }
  return Object.freeze({
    operation: mutation.operation,
    source_path: source ?? null,
    destination_path: destination ?? null,
  });
}

async function enumerateEntries(filesystem, profile, classifyObservedEntry) {
  const observed = [];
  const queue = profile.boundary_scan_roots.map((root) => ({ root, current: root, depth: 0 }));
  while (queue.length > 0) {
    const item = queue.shift();
    let entries;
    try {
      entries = await filesystem.readdir(item.current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail("BOUNDARY_SCAN_READ_FAILED", { scan_path: item.current, cause: error?.code ?? "unknown" });
    }
    for (const entry of entries) {
      const entryPath = path.join(item.current, entry.name);
      let artifactRole;
      if (classifyObservedEntry) {
        artifactRole = await classifyObservedEntry(Object.freeze({ path: entryPath }));
        if (artifactRole !== undefined && artifactRole !== null && artifactRole !== "clued_resource") {
          fail("BOUNDARY_SCAN_CLASSIFICATION_INVALID", { scan_path: entryPath });
        }
      }
      observed.push(Object.freeze({ path: entryPath, artifact_role: artifactRole ?? undefined }));
      if (observed.length > profile.boundary_scan_max_entries) {
        fail("BOUNDARY_SCAN_ENTRY_LIMIT_EXCEEDED", { max_entries: profile.boundary_scan_max_entries });
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && item.depth < profile.boundary_scan_max_depth) {
        queue.push({ root: item.root, current: entryPath, depth: item.depth + 1 });
      }
    }
  }
  return observed;
}

/**
 * Official Node filesystem integration for a Host-registered Resource Center.
 * The mutation caller receives only this adapter; profile, artifact authority,
 * filesystem effect and boundary enumeration are captured bootstrap inputs.
 */
export function createResourceCenterFilesystemAdapter({
  trusted_profile: trustedProfile,
  resolve_artifact: resolveArtifact,
  classify_observed_entry: classifyObservedEntry,
  filesystem = fs,
  clock,
  admission_ttl_ms: admissionTtlMs,
} = {}) {
  if (!filesystem || typeof filesystem.readdir !== "function" ||
    typeof filesystem.writeFile !== "function" || typeof filesystem.rename !== "function" ||
    typeof filesystem.unlink !== "function" || typeof filesystem.rmdir !== "function" ||
    typeof filesystem.mkdir !== "function" || typeof filesystem.realpath !== "function") {
    fail("RESOURCE_CENTER_FILESYSTEM_INVALID");
  }
  if (classifyObservedEntry !== undefined && typeof classifyObservedEntry !== "function") {
    fail("BOUNDARY_SCAN_CLASSIFIER_INVALID");
  }
  const profile = snapshotProfile(trustedProfile);
  const host = createResourceCenterHostAdapter({
    trusted_profile: profile,
    resolve_artifact: resolveArtifact,
    effect: ({ mutation }) => applyFilesystemMutation(filesystem, profile, mutation),
    clock,
    admission_ttl_ms: admissionTtlMs,
  });

  async function scanBoundary() {
    const observedEntries = await enumerateEntries(filesystem, profile, classifyObservedEntry);
    return host.scanBoundary({ observed_entries: observedEntries });
  }

  return Object.freeze({
    profile_identity: host.profile_identity,
    preflight: host.preflight,
    commitMutation: host.commitMutation,
    guardedMutation: host.guardedMutation,
    scanBoundary,
  });
}
