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

function assertUniqueRegularFile(stats, code) {
  if (!stats.isFile()) fail("MUTATION_TARGET_NOT_REGULAR_FILE");
  if (stats.nlink !== 1) fail(code, { link_count: stats.nlink });
}

function sameObjectIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function writeExistingManagedFile(filesystem, candidate, managedRoot, content, replace) {
  await assertExistingPathWithin(
    filesystem,
    candidate,
    [managedRoot],
    "DESTINATION_REALPATH_OUTSIDE_MANAGED_ROOT",
  );
  const handle = await filesystem.open(candidate, "r+");
  try {
    if (!handle || typeof handle.stat !== "function" || typeof handle.writeFile !== "function" ||
      typeof handle.truncate !== "function" || typeof handle.sync !== "function" ||
      typeof handle.close !== "function") {
      fail("RESOURCE_CENTER_FILE_HANDLE_INVALID");
    }
    const before = await handle.stat();
    assertUniqueRegularFile(before, "HARD_LINK_ALIAS_FORBIDDEN");
    const pathBefore = await filesystem.stat(candidate);
    if (!sameObjectIdentity(before, pathBefore)) fail("MUTATION_TARGET_IDENTITY_CHANGED");

    // Re-check the resolved path after opening, then mutate only through the
    // verified handle so a path-based write cannot silently target another
    // object between verification and the side effect.
    await assertExistingPathWithin(
      filesystem,
      candidate,
      [managedRoot],
      "DESTINATION_REALPATH_OUTSIDE_MANAGED_ROOT",
    );
    if (replace) await handle.truncate(0);
    await handle.writeFile(content);
    await handle.sync();

    const after = await handle.stat();
    const pathAfter = await filesystem.stat(candidate);
    assertUniqueRegularFile(after, "HARD_LINK_ALIAS_DETECTED_AFTER_WRITE");
    if (!sameObjectIdentity(before, after) || !sameObjectIdentity(after, pathAfter)) {
      fail("MUTATION_TARGET_IDENTITY_CHANGED");
    }
    return Object.freeze({
      device: after.dev,
      inode: after.ino,
      link_count: after.nlink,
      size: after.size,
    });
  } finally {
    await handle?.close?.();
  }
}

async function applyFilesystemMutation(filesystem, profile, mutation) {
  const destination = mutation.destination_path;
  const source = mutation.source_path;
  const sourceRoots = [profile.managed_root, ...profile.registered_external_roots];
  let objectIdentity;
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
      objectIdentity = await writeExistingManagedFile(
        filesystem,
        destination,
        profile.managed_root,
        contentFor(mutation),
        false,
      );
      break;
    case "replace":
      if (mutation.target_kind === "directory") fail("DIRECTORY_REPLACE_FORBIDDEN");
      objectIdentity = await writeExistingManagedFile(
        filesystem,
        destination,
        profile.managed_root,
        contentFor(mutation),
        true,
      );
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
    object_identity: objectIdentity ?? null,
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
    typeof filesystem.mkdir !== "function" || typeof filesystem.realpath !== "function" ||
    typeof filesystem.open !== "function" || typeof filesystem.stat !== "function") {
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
