export const RESOURCE_CENTER_POLICY_VERSION = "clued.resource-center-mutation-policy/1";

const MUTATIONS = new Set(["create", "write", "move", "rename", "replace", "delete"]);
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

function directorySegments(path, root, targetKind) {
  const segments = relativeSegments(path, root);
  if (targetKind === "directory") return segments;
  return segments.slice(0, -1);
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
  if (!destination && operation !== "delete") return deny("DESTINATION_REQUIRED");
  if (operation === "delete" && !source && !destination) return deny("DELETE_TARGET_REQUIRED");
  if (targetKind === "directory" && !["track", "topic", "asset_collection"].includes(directorySemantics)) {
    return deny("DIRECTORY_SEMANTICS_REQUIRED");
  }

  const target = destination ?? source;
  if (artifactRole === "clued_resource" && !isWithin(target, managedRoot)) {
    return deny("SIBLING_ISLAND_FORBIDDEN", { managed_root: managedRoot });
  }

  for (const path of [source, destination].filter(Boolean)) {
    if (!isWithin(path, managedRoot)) continue;
    const segments = relativeSegments(path, managedRoot);
    if (segments.length === 0) return deny("MANAGED_ROOT_MUTATION_FORBIDDEN");
    if (!allowedChildren.has(segments[0])) {
      return deny("RESOURCE_CENTER_ROOT_CHILD_FORBIDDEN", { root_child: segments[0] });
    }
    const forbidden = directorySegments(
      path,
      managedRoot,
      path === destination ? targetKind : "file",
    ).find((segment) => statusNames.has(foldName(segment)));
    if (forbidden) {
      return deny("STATUS_SEMANTIC_DIRECTORY_FORBIDDEN", { directory: forbidden });
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
