import {
  assertBoundIdentityClaimsCurrent,
  createBoundIdentityClaims,
} from "../policy/identity-security.mjs";

export class TenantErasureStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "TenantErasureStoreError";
    this.code = code;
  }
}
const clone = (value) => structuredClone(value);
function reject(code) { throw new TenantErasureStoreError(code); }
const contextKey = (tenantId, context) => tenantId + "|" + context;
const recordKey = (tenantId, context, objectId) => tenantId + "|" + context + "|" + objectId;

export class InMemoryTenantErasureStore {
  #authority = new Map();
  #contexts = new Map();
  #records = new Map();
  #markers = new Map();

  registerCanonicalAuthority(authority) {
    this.#authority.set(authority.tenant_id, clone(authority));
  }
  createClaims(tenantId, scope, context) {
    const current = this.#authority.get(tenantId);
    if (!current) reject("AUTHORIZATION_DENIED");
    return createBoundIdentityClaims(current, {
      scope,
      purpose: "kernel-runtime",
      target_digest: "context:" + context,
    });
  }
  #authorizeWrite(actor, claims, targetTenantId, context) {
    const current = this.#authority.get(actor?.tenant_id);
    if (!current || actor.tenant_id !== targetTenantId) reject("AUTHORIZATION_DENIED");
    try {
      assertBoundIdentityClaimsCurrent({
        actor: current,
        claims,
        target: {
          tenant_id: targetTenantId,
          scope: "context:write",
          purpose: "kernel-runtime",
          target_digest: "context:" + context,
        },
      });
    } catch {
      reject("AUTHORIZATION_DENIED");
    }
  }
  #authorizeRead(actor, claims, targetTenantId, context) {
    const current = this.#authority.get(actor?.tenant_id);
    if (!current || actor.tenant_id !== targetTenantId) reject("RESOURCE_UNAVAILABLE");
    try {
      assertBoundIdentityClaimsCurrent({
        actor: current,
        claims,
        target: {
          tenant_id: targetTenantId,
          scope: "context:read",
          purpose: "kernel-runtime",
          target_digest: "context:" + context,
        },
      });
    } catch {
      reject("RESOURCE_UNAVAILABLE");
    }
  }
  createContext({ actor, claims, context, erasureGeneration = 1 }) {
    this.#authorizeWrite(actor, claims, actor.tenant_id, context);
    const key = contextKey(actor.tenant_id, context);
    if (this.#contexts.has(key)) reject("CONTEXT_ALREADY_EXISTS");
    this.#contexts.set(key, { erasure_generation: erasureGeneration, state: "active" });
  }
  write({ actor, claims, targetTenantId, context, objectId, payload, erasureGeneration }) {
    this.#authorizeWrite(actor, claims, targetTenantId, context);
    const boundary = this.#contexts.get(contextKey(targetTenantId, context));
    if (!boundary || boundary.state !== "active" || erasureGeneration !== boundary.erasure_generation) {
      reject("ERASURE_BARRIER_REJECTED");
    }
    this.#records.set(recordKey(targetTenantId, context, objectId), {
      payload: clone(payload),
      erasure_generation: erasureGeneration,
    });
    return { committed: true, erasure_generation: erasureGeneration };
  }
  read({ actor, claims, targetTenantId, context, objectId }) {
    this.#authorizeRead(actor, claims, targetTenantId, context);
    const boundary = this.#contexts.get(contextKey(targetTenantId, context));
    const record = this.#records.get(recordKey(targetTenantId, context, objectId));
    if (!boundary || boundary.state !== "active" || !record ||
        record.erasure_generation !== boundary.erasure_generation) reject("RESOURCE_UNAVAILABLE");
    return clone(record.payload);
  }
  restore({ actor, claims, targetTenantId, context, objectId, payload, sourceErasureGeneration, erasedMarker }) {
    if (erasedMarker) reject("ERASURE_BARRIER_REJECTED");
    const boundary = this.#contexts.get(contextKey(targetTenantId, context));
    if (!boundary || sourceErasureGeneration !== boundary.erasure_generation) reject("ERASURE_BARRIER_REJECTED");
    return this.write({
      actor, claims, targetTenantId, context, objectId, payload,
      erasureGeneration: sourceErasureGeneration,
    });
  }
  beginDeletion({ actor, claims, targetTenantId, context, expectedGeneration, nextGeneration }) {
    this.#authorizeWrite(actor, claims, targetTenantId, context);
    const key = contextKey(targetTenantId, context);
    const boundary = this.#contexts.get(key);
    if (!boundary || boundary.erasure_generation !== expectedGeneration ||
        !Number.isSafeInteger(nextGeneration) || nextGeneration <= expectedGeneration) {
      reject("ERASURE_BARRIER_CAS_CONFLICT");
    }
    this.#contexts.set(key, { erasure_generation: nextGeneration, state: "deleting" });
    return { erasure_generation: nextGeneration, state: "deleting" };
  }
  completeDeletion({ actor, claims, targetTenantId, context, expectedGeneration }) {
    this.#authorizeWrite(actor, claims, targetTenantId, context);
    const key = contextKey(targetTenantId, context);
    const boundary = this.#contexts.get(key);
    if (!boundary || boundary.state !== "deleting" ||
        boundary.erasure_generation !== expectedGeneration) reject("ERASURE_BARRIER_CAS_CONFLICT");
    for (const keyName of [...this.#records.keys()]) {
      if (keyName.startsWith(targetTenantId + "|" + context + "|")) this.#records.delete(keyName);
    }
    this.#contexts.set(key, { erasure_generation: expectedGeneration, state: "deleted" });
    this.#markers.set(key, {
      tenant_id: targetTenantId,
      context,
      erasure_generation: expectedGeneration,
      payload_exposed: false,
    });
    return clone(this.#markers.get(key));
  }
  marker({ actor, claims, targetTenantId, context }) {
    this.#authorizeRead(actor, claims, targetTenantId, context);
    const marker = this.#markers.get(contextKey(targetTenantId, context));
    if (!marker) reject("RESOURCE_UNAVAILABLE");
    return clone(marker);
  }
}
