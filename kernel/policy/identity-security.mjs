export const REVOCATION_COMPONENTS = Object.freeze([
  Object.freeze({ scope: "account_scope_ref", epoch: "account_epoch" }),
  Object.freeze({ scope: "integration_installation_scope_ref", epoch: "integration_installation_epoch" }),
  Object.freeze({ scope: "context_scope_ref", epoch: "context_epoch" }),
  Object.freeze({ scope: "binding_scope_ref", epoch: "binding_epoch" }),
]);

export class IdentitySecurityError extends Error {
  constructor(code) {
    super(code);
    this.name = "IdentitySecurityError";
    this.code = code;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = (value) => structuredClone(value);

function reject(code) {
  throw new IdentitySecurityError(code);
}

function validDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function validateRevocationEpochVector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("REVOCATION_VECTOR_INVALID");
  if (value.vector_schema_version !== "1") reject("REVOCATION_VECTOR_SCHEMA_UNSUPPORTED");
  for (const component of REVOCATION_COMPONENTS) {
    if (!own(value, component.scope) || !own(value, component.epoch)) {
      reject("REVOCATION_VECTOR_INCOMPLETE");
    }
    const scopeRef = value[component.scope];
    const epoch = value[component.epoch];
    if (scopeRef && scopeRef.status === "not_applicable") {
      if (epoch !== "not_applicable" || typeof scopeRef.reason !== "string" || scopeRef.reason.length === 0) {
        reject("REVOCATION_NOT_APPLICABLE_INVALID");
      }
      continue;
    }
    if (!scopeRef || typeof scopeRef !== "object" || typeof scopeRef.scope_id !== "string" ||
        scopeRef.scope_id.length === 0 || !validDigest(scopeRef.scope_digest)) {
      reject("REVOCATION_SCOPE_REF_INVALID");
    }
    if (!Number.isSafeInteger(epoch) || epoch < 0) reject("REVOCATION_EPOCH_INVALID");
  }
  return clone(value);
}

export function assertExactRevocationVector(boundVector, currentVector) {
  const bound = validateRevocationEpochVector(boundVector);
  const current = validateRevocationEpochVector(currentVector);
  if (!equal(bound, current)) reject("STALE_OR_FUTURE_REVOCATION_VECTOR");
  return true;
}

function assertExactGenerations(bound, current) {
  if (!bound || !current || typeof bound !== "object" || typeof current !== "object") {
    reject("GENERATION_CLAIMS_INCOMPLETE");
  }
  const boundKeys = Object.keys(bound).sort();
  const currentKeys = Object.keys(current).sort();
  if (!equal(boundKeys, currentKeys)) reject("GENERATION_CLAIMS_INCOMPLETE");
  for (const key of currentKeys) {
    if (!Number.isSafeInteger(bound[key]) || !Number.isSafeInteger(current[key]) || bound[key] !== current[key]) {
      reject("STALE_OR_FUTURE_OBJECT_GENERATION");
    }
  }
}

export function createBoundIdentityClaims(current, request) {
  validateRevocationEpochVector(current.revocation_epoch_vector);
  if (!current.scope_allowlist?.includes(request.scope) ||
      !current.purpose_allowlist?.includes(request.purpose)) {
    reject("AUTHORIZATION_DENIED");
  }
  return {
    tenant_id: current.tenant_id,
    subject_ref: current.subject_ref,
    binding_id: current.binding_id,
    scope: request.scope,
    purpose: request.purpose,
    target_digest: request.target_digest,
    revocation_epoch_vector: clone(current.revocation_epoch_vector),
    generation_claims: clone(current.generation_claims),
  };
}

export function assertBoundIdentityClaimsCurrent({ actor, claims, target }) {
  if (!actor || !claims || !target) reject("AUTHORIZATION_DENIED");
  const matches =
    actor.tenant_id === target.tenant_id &&
    claims.tenant_id === actor.tenant_id &&
    claims.subject_ref === actor.subject_ref &&
    claims.binding_id === actor.binding_id &&
    claims.scope === target.scope &&
    claims.purpose === target.purpose &&
    claims.target_digest === target.target_digest &&
    actor.scope_allowlist?.includes(target.scope) &&
    actor.purpose_allowlist?.includes(target.purpose);
  if (!matches) reject("AUTHORIZATION_DENIED");
  assertExactRevocationVector(claims.revocation_epoch_vector, actor.revocation_epoch_vector);
  assertExactGenerations(claims.generation_claims, actor.generation_claims);
  return true;
}

export function vectorsHaveMonotonicRaise(previousVector, nextVector) {
  const previous = validateRevocationEpochVector(previousVector);
  const next = validateRevocationEpochVector(nextVector);
  let raised = false;
  for (const component of REVOCATION_COMPONENTS) {
    if (!equal(previous[component.scope], next[component.scope])) return false;
    const before = previous[component.epoch];
    const after = next[component.epoch];
    if (before === "not_applicable" || after === "not_applicable") {
      if (before !== after) return false;
      continue;
    }
    if (after < before) return false;
    if (after > before) raised = true;
  }
  return raised;
}
