export const RESOURCE_CENTER_POLICY_VERSION = "clued.resource-center-mutation-policy/1";

// "restore" (StorageFullCapability P5) takes a trashed file out of the trash: source only, like delete.
// "adopt" (P7) registers one existing item where it is: source only, nothing written.
const MUTATIONS = new Set(["create", "write", "move", "rename", "replace", "delete", "restore", "adopt"]);
const NAVIGATION_DIRECTORY = "00_从这里开始";
const NAVIGATION_ENTRY = "Clued_资料中心使用前必读.md";
const DEFAULT_STATUS_DIRECTORY_NAMES = [
  "current",
  "current baseline",
  "current version",
  "现行基线",
  "当前",
  "当前基线",
  "当前版本",
  "fixed",
  "frozen",
  "candidate",
  "historical",
  "候选",
  "历史",
  "正式",
  "候选与素材",
  "评审",
  "复核",
  "reviews",
  "review",
];

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
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const prefix = drive ? drive[0].toUpperCase() + ":/" : absolute ? "/" : "";
  const normalized = prefix + parts.join("/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function pathKey(value) {
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

function foldName(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\d+[\s_.-]*/, "")
    .replace(/[\s_.-]+/g, " ")
    .trim();
}

function isWithin(path, root) {
  const candidate = pathKey(path);
  const boundary = pathKey(root);
  return candidate === boundary || candidate.startsWith(boundary + "/");
}

function relativeSegments(path, root) {
  if (path === root) return [];
  return path.slice(root.length + 1).split("/").filter(Boolean);
}

export function evaluateResourceCenterMutation(input) {
  const profile = input?.profile ?? {};
  const operation = input?.operation;
  const managedRoot = normalizePath(profile.managed_root);
  const destination = normalizePath(input?.destination_path);
  const source = normalizePath(input?.source_path);
  const artifactRole = input?.artifact_role;
  const targetKind = input?.target_kind ?? "file";
  const directorySemantics = input?.directory_semantics;
  const governanceClass = input?.governance_class;
  const allowedChildren = new Set(profile.allowed_root_children ?? []);
  const registeredExternalRoots = (profile.registered_external_roots ?? [])
    .map(normalizePath)
    .filter(Boolean);
  const statusNames = new Set(
    (profile.status_directory_names ?? DEFAULT_STATUS_DIRECTORY_NAMES).map(foldName),
  );

  const deny = (code, details = {}) => ({
    status: "deny",
    policy_version: RESOURCE_CENTER_POLICY_VERSION,
    error_code: code,
    ...details,
  });

  if (!MUTATIONS.has(operation)) return deny("MUTATION_OPERATION_INVALID");
  if (!managedRoot) return deny("MANAGED_ROOT_REQUIRED");
  if (artifactRole !== "clued_resource") return deny("ARTIFACT_ROLE_REQUIRED");
  if (operation === "delete" || operation === "restore") {
    if (!source) return deny("DELETE_TARGET_REQUIRED");
    // An untrash may name the final path the user chose (Decision 7f9daf68).
    if (destination && operation === "delete") return deny("DELETE_DESTINATION_FORBIDDEN");
  } else if (operation === "move" || operation === "rename") {
    if (!source || !destination) return deny("SOURCE_AND_DESTINATION_REQUIRED");
  } else if (operation === "adopt") {
    if (!source) return deny("ADOPT_TARGET_REQUIRED");
    if (destination) return deny("ADOPT_DESTINATION_FORBIDDEN");
  } else {
    if (!destination) return deny("DESTINATION_REQUIRED");
    if (source) return deny("SOURCE_PATH_FORBIDDEN_FOR_OPERATION", { operation });
  }
  // Trash and untrash of an empty directory (P5), a directory move (P6) and
  // adopting a directory (P7) name an existing directory and carry no
  // directory semantics.
  if (targetKind === "directory" && operation !== "delete" && operation !== "restore" && operation !== "move" &&
    operation !== "adopt" &&
    !["track", "topic", "asset_collection"].includes(directorySemantics)) {
    return deny("DIRECTORY_SEMANTICS_REQUIRED");
  }

  const target = operation === "delete" || operation === "adopt" || (operation === "restore" && !destination) ? source : destination;
  if (artifactRole === "clued_resource" && !isWithin(target, managedRoot)) {
    return deny("SIBLING_ISLAND_FORBIDDEN", { managed_root: managedRoot });
  }
  if (source && !isWithin(source, managedRoot) &&
    !registeredExternalRoots.some((root) => isWithin(source, root))) {
    return deny("SOURCE_OUTSIDE_REGISTERED_ROOT", { managed_root: managedRoot });
  }

  for (const path of [source, destination].filter(Boolean)) {
    if (!isWithin(path, managedRoot)) continue;
    const segments = relativeSegments(path, managedRoot);
    if (segments.length === 0) return deny("MANAGED_ROOT_MUTATION_FORBIDDEN");
    // The existing live navigation entry is a reserved maintenance target,
    // never a writable track. P7 adoption and P4 in-place replacement still
    // require the Host's online authority, registered parent, provider identity,
    // grants and CAS. No caller field or profile allowlist can widen this slot.
    if (segments[0] === NAVIGATION_DIRECTORY) {
      if (targetKind !== "file" || segments.length !== 2 || segments[1] !== NAVIGATION_ENTRY ||
          (operation !== "adopt" && operation !== "replace")) {
        return deny("RESOURCE_CENTER_NAVIGATION_ENTRY_PROTECTED");
      }
      continue;
    }
    if (!allowedChildren.has(segments[0])) {
      return deny("RESOURCE_CENTER_ROOT_CHILD_FORBIDDEN", { root_child: segments[0] });
    }
  }

  // No new status-semantic directory: creating one, or moving or renaming a
  // directory to such a name, is refused. A file written into a status-named
  // folder that already exists is allowed (Owner Decision f382c494: the rules
  // stay, ordinary writes are not refused). The source is never blocked, so
  // material can be moved back into a legal topic; adopting an item there (P7)
  // writes nothing.
  if (destination && isWithin(destination, managedRoot) && targetKind === "directory") {
    const name = relativeSegments(destination, managedRoot).at(-1);
    if (name !== undefined && statusNames.has(foldName(name))) {
      return deny("STATUS_SEMANTIC_DIRECTORY_FORBIDDEN", { directory: name });
    }
  }

  if (operation === "delete" && !["ordinary", "governance"].includes(governanceClass)) {
    return deny("GOVERNANCE_CLASS_REQUIRED");
  }

  if (operation === "delete" && governanceClass === "governance" && input?.delete_authority !== true) {
    return deny("DELETE_AUTHORITY_REQUIRED", {
      duplicate_bytes: input?.duplicate_bytes === true,
    });
  }

  return {
    status: "allow",
    policy_version: RESOURCE_CENTER_POLICY_VERSION,
    managed_root: managedRoot,
  };
}


function parentPath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return null;
  const index = normalized.lastIndexOf("/");
  if (index <= 2 && /^[A-Za-z]:\/$/.test(normalized.slice(0, index + 1))) {
    return normalized.slice(0, index + 1);
  }
  return index > 0 ? normalized.slice(0, index) : "/";
}

export function detectResourceCenterBoundaryViolations(input) {
  const profile = input?.profile ?? {};
  const managedRoot = normalizePath(profile.managed_root);
  if (!managedRoot) {
    return [{
      code: "MANAGED_ROOT_REQUIRED",
      policy_version: RESOURCE_CENTER_POLICY_VERSION,
    }];
  }

  const parent = parentPath(managedRoot);
  const registeredExternalRoots = (profile.registered_external_roots ?? [])
    .map(normalizePath)
    .filter(Boolean);
  const entries = Array.isArray(input?.observed_entries) ? input.observed_entries : [];
  const violations = [];

  for (const entry of entries) {
    const path = normalizePath(typeof entry === "string" ? entry : entry?.path);
    if (!path || isWithin(path, managedRoot)) continue;
    if (registeredExternalRoots.some((root) => isWithin(path, root))) continue;

    const explicitRole = typeof entry === "object" && entry?.artifact_role === "clued_resource";
    // Island rule (Clued Decision fd94bd2f, StorageNormalUse §3.1): a Clued-named
    // entry outside the managed root counts only when the Clued app created or
    // opened it. Only an explicit `is_app_authorized: false` (Drive's
    // isAppAuthorized) exempts it; a missing or other value still counts.
    const appAuthorized = !(typeof entry === "object" && entry?.is_app_authorized === false);
    const cluedNamed = appAuthorized && path.split("/").some((segment) => /clued/i.test(segment));
    const inManagedParent = parent ? isWithin(path, parent) : false;
    if (!explicitRole && !cluedNamed) continue;

    violations.push({
      code: "UNAUTHORIZED_WORKSPACE_MUTATION",
      policy_version: RESOURCE_CENTER_POLICY_VERSION,
      path,
      managed_root: managedRoot,
      reason: inManagedParent
        ? "resource_center_parent_or_sibling_island"
        : "unregistered_clued_resource_location",
    });
  }

  return violations;
}


export function bindResourceCenterMutation(input) {
  return {
    operation: input?.operation ?? null,
    source_path: normalizePath(input?.source_path),
    destination_path: normalizePath(input?.destination_path),
    artifact_role: input?.artifact_role ?? null,
    target_kind: input?.target_kind ?? "file",
    directory_semantics: input?.directory_semantics ?? null,
    artifact_id: input?.artifact_id ?? null,
    governance_class: input?.governance_class ?? null,
    delete_authority: input?.delete_authority === true,
    artifact_authority_version: input?.artifact_authority_version ?? null,
    duplicate_bytes: input?.duplicate_bytes === true,
    currentness_identity: input?.currentness_identity ?? null,
    workspace_version: input?.workspace_version ?? null,
  };
}
