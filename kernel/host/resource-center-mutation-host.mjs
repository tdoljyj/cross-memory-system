import { createHash, randomUUID } from "node:crypto";

import {
  RESOURCE_CENTER_POLICY_VERSION,
  bindResourceCenterMutation,
  detectResourceCenterBoundaryViolations,
  evaluateResourceCenterMutation,
} from "../policy/resource-center-mutation-policy.mjs";

const MAX_ADMISSION_TTL_MS = 60_000;
const DEFAULT_ADMISSION_TTL_MS = 30_000;
const CALLER_AUTHORITY_FIELDS = new Set([
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
  "currentness_identity",
  "workspace_version",
]);

function deny(errorCode, details = {}) {
  return {
    status: "deny",
    policy_version: RESOURCE_CENTER_POLICY_VERSION,
    error_code: errorCode,
    ...details,
  };
}

function snapshotTrustedProfile(profile) {
  if (!profile || profile.registration_status !== "registered" ||
    typeof profile.profile_id !== "string" || profile.profile_id.trim() === "" ||
    typeof profile.profile_version !== "string" || profile.profile_version.trim() === "" ||
    typeof profile.managed_root !== "string" || profile.managed_root.trim() === "" ||
    !Array.isArray(profile.allowed_root_children)) {
    throw new TypeError("A registered, versioned Host-owned Resource Center profile is required.");
  }

  return Object.freeze({
    registration_status: "registered",
    profile_id: profile.profile_id.trim(),
    profile_version: profile.profile_version.trim(),
    managed_root: profile.managed_root,
    allowed_root_children: Object.freeze([...profile.allowed_root_children]),
    status_directory_names: profile.status_directory_names === undefined
      ? undefined
      : Object.freeze([...profile.status_directory_names]),
    registered_external_roots: Object.freeze([...(profile.registered_external_roots ?? [])]),
    boundary_scan_roots: Object.freeze([...(profile.boundary_scan_roots ?? [])]),
    boundary_scan_max_depth: profile.boundary_scan_max_depth,
    boundary_scan_max_entries: profile.boundary_scan_max_entries,
  });
}

function snapshotJson(value, seen = new WeakSet(), path = "mutation") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not JSON-safe`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => snapshotJson(item, seen, `${path}[${index}]`));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain objects and arrays`);
    }
    const result = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).filter((name) => descriptors[name].enumerable).sort()) {
      const descriptor = descriptors[key];
      if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
        throw new TypeError(`${path}.${key} must be a data property`);
      }
      Object.defineProperty(result, key, {
        value: snapshotJson(descriptor.value, seen, `${path}.${key}`),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function mutationSnapshot(mutation) {
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
    throw new TypeError("mutation must be a plain object");
  }
  return deepFreeze(snapshotJson(mutation));
}

function resolveTrustedArtifact(resolveArtifact, profile, mutation) {
  let resolved;
  try {
    resolved = resolveArtifact(Object.freeze({ profile, mutation }));
    if (resolved && typeof resolved.then === "function") {
      return deny("ARTIFACT_AUTHORITY_ASYNC_FORBIDDEN");
    }
    resolved = deepFreeze(snapshotJson(resolved, new WeakSet(), "artifact_authority"));
  } catch (error) {
    return deny("ARTIFACT_AUTHORITY_RESOLUTION_FAILED", { reason: error.message });
  }

  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved) ||
    resolved.artifact_role !== "clued_resource" ||
    !["ordinary", "governance"].includes(resolved.governance_class) ||
    typeof resolved.delete_authority !== "boolean" ||
    typeof resolved.authority_version !== "string" || resolved.authority_version.trim() === "" ||
    typeof resolved.currentness_identity !== "string" || resolved.currentness_identity.trim() === "" ||
    typeof resolved.workspace_version !== "string" || resolved.workspace_version.trim() === "" ||
    !(resolved.artifact_id === null ||
      (typeof resolved.artifact_id === "string" && resolved.artifact_id.trim() !== ""))) {
    return deny("ARTIFACT_AUTHORITY_INVALID");
  }
  if (mutation.artifact_role !== resolved.artifact_role) {
    return deny("ARTIFACT_ROLE_MISMATCH");
  }

  return {
    status: "resolved",
    mutation: deepFreeze({
      ...mutation,
      artifact_id: resolved.artifact_id?.trim() ?? null,
      artifact_role: resolved.artifact_role,
      governance_class: resolved.governance_class,
      delete_authority: resolved.delete_authority,
      artifact_authority_version: resolved.authority_version.trim(),
      currentness_identity: resolved.currentness_identity.trim(),
      workspace_version: resolved.workspace_version.trim(),
    }),
  };
}

function callerAuthorityField(mutation) {
  return Object.keys(mutation).find((key) => CALLER_AUTHORITY_FIELDS.has(key)) ?? null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactBinding(profile, mutation) {
  return deepFreeze({
    policy_version: RESOURCE_CENTER_POLICY_VERSION,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    ...bindResourceCenterMutation(mutation),
    request_sha256: sha256(JSON.stringify(mutation)),
  });
}

function validateTtl(value) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_ADMISSION_TTL_MS) {
    throw new TypeError(`admission_ttl_ms must be an integer from 1 to ${MAX_ADMISSION_TTL_MS}`);
  }
  return value;
}

/**
 * Creates the official in-process Resource Center mutation boundary.
 *
 * `trusted_profile`, `resolve_artifact` and `effect` are Host bootstrap
 * dependencies. Mutation
 * callers receive the returned adapter only; they cannot replace the managed
 * root, profile or external-root registry through a mutation payload.
 */
export function createResourceCenterHostAdapter({
  trusted_profile: trustedProfile,
  resolve_artifact: resolveArtifact,
  effect,
  clock = Date.now,
  admission_ttl_ms: admissionTtlMs = DEFAULT_ADMISSION_TTL_MS,
} = {}) {
  if (typeof effect !== "function") {
    throw new TypeError("A trusted Host effect function is required.");
  }
  if (typeof resolveArtifact !== "function") {
    throw new TypeError("A trusted Host artifact authority resolver is required.");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const profile = snapshotTrustedProfile(trustedProfile);
  const ttlMs = validateTtl(admissionTtlMs);
  const admissions = new WeakMap();
  const profileIdentity = Object.freeze({
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    policy_version: RESOURCE_CENTER_POLICY_VERSION,
  });

  function preflight(mutation) {
    let snapshot;
    try {
      snapshot = mutationSnapshot(mutation);
    } catch (error) {
      return deny("MUTATION_PAYLOAD_INVALID", { reason: error.message });
    }

    const authorityField = callerAuthorityField(snapshot);
    if (authorityField) {
      return deny("CALLER_AUTHORITY_FIELDS_FORBIDDEN", { field: authorityField });
    }

    const resolved = resolveTrustedArtifact(resolveArtifact, profile, snapshot);
    if (resolved.status !== "resolved") return resolved;
    const authorizedMutation = resolved.mutation;
    const result = evaluateResourceCenterMutation({ profile, ...authorizedMutation });
    if (result.status !== "allow") return result;

    const issuedAt = Number(clock());
    if (!Number.isFinite(issuedAt)) return deny("HOST_CLOCK_INVALID");
    const expiresAt = issuedAt + ttlMs;
    const binding = exactBinding(profile, authorizedMutation);
    const admission = deepFreeze({
      admission_kind: "host_instance_opaque_single_use",
      admission_id: randomUUID(),
      policy_version: RESOURCE_CENTER_POLICY_VERSION,
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      issued_at_ms: issuedAt,
      expires_at_ms: expiresAt,
      binding,
    });
    admissions.set(admission, { binding, expiresAt, consumed: false });

    return {
      status: "admitted",
      policy_version: RESOURCE_CENTER_POLICY_VERSION,
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      admission,
    };
  }

  async function commitMutation({ admission, mutation } = {}) {
    if (!admission) return deny("ADMISSION_REQUIRED");
    const state = admissions.get(admission);
    if (!state) return deny("ADMISSION_INVALID");
    if (state.consumed) return deny("ADMISSION_ALREADY_CONSUMED");

    // Any execution attempt consumes the proof before validation/effect so an
    // error or thrown side effect cannot turn it into a retryable broad token.
    state.consumed = true;
    const observedAt = Number(clock());
    if (!Number.isFinite(observedAt)) return deny("HOST_CLOCK_INVALID");
    if (observedAt >= state.expiresAt) return deny("ADMISSION_EXPIRED");

    let snapshot;
    try {
      snapshot = mutationSnapshot(mutation);
    } catch (error) {
      return deny("MUTATION_PAYLOAD_INVALID", { reason: error.message });
    }
    const authorityField = callerAuthorityField(snapshot);
    if (authorityField) {
      return deny("CALLER_AUTHORITY_FIELDS_FORBIDDEN", { field: authorityField });
    }

    const resolved = resolveTrustedArtifact(resolveArtifact, profile, snapshot);
    if (resolved.status !== "resolved") return resolved;
    const authorizedMutation = resolved.mutation;
    const policyResult = evaluateResourceCenterMutation({ profile, ...authorizedMutation });
    if (policyResult.status !== "allow") return policyResult;
    const binding = exactBinding(profile, authorizedMutation);
    if (JSON.stringify(binding) !== JSON.stringify(state.binding)) {
      return deny("ADMISSION_BINDING_MISMATCH");
    }

    const effectResult = await effect({
      mutation: authorizedMutation,
      admission,
      profile_identity: profileIdentity,
    });
    return {
      status: "committed",
      policy_version: RESOURCE_CENTER_POLICY_VERSION,
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      admission_id: admission.admission_id,
      binding,
      effect_result: effectResult,
    };
  }

  async function guardedMutation(mutation) {
    const result = preflight(mutation);
    if (result.status !== "admitted") return result;
    return commitMutation({ admission: result.admission, mutation });
  }

  function scanBoundary({ observed_entries: observedEntries } = {}) {
    return detectResourceCenterBoundaryViolations({
      profile,
      observed_entries: observedEntries,
    });
  }

  return Object.freeze({
    profile_identity: profileIdentity,
    preflight,
    commitMutation,
    guardedMutation,
    scanBoundary,
  });
}

