import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTenantErasureStore } from "../../kernel/runtime/tenant-erasure-store.mjs";

const digest = (char) => "sha256:" + char.repeat(64);
const ref = (id, char) => ({ scope_id: id, scope_digest: digest(char) });
const authority = (tenant, char) => ({
  tenant_id: tenant,
  subject_ref: "subject-" + tenant,
  binding_id: "binding-" + tenant,
  scope_allowlist: ["context:read", "context:write"],
  purpose_allowlist: ["kernel-runtime"],
  revocation_epoch_vector: {
    vector_schema_version: "1",
    account_scope_ref: ref("acct:" + tenant, char),
    account_epoch: 1,
    integration_installation_scope_ref: ref("install:" + tenant, char),
    integration_installation_epoch: 1,
    context_scope_ref: ref("ctx:" + tenant, char),
    context_epoch: 1,
    binding_scope_ref: ref("bind:" + tenant, char),
    binding_epoch: 1,
  },
  generation_claims: {
    runner_generation: 1,
    credential_generation: 1,
    session_generation: 1,
  },
});

test("V03-TENANT-01 cross-tenant read is opaque for existing and missing records", () => {
  const store = new InMemoryTenantErasureStore();
  const tenantA = authority("tenant-a", "a");
  const tenantB = authority("tenant-b", "b");
  store.registerCanonicalAuthority(tenantA);
  store.registerCanonicalAuthority(tenantB);
  const readA = store.createClaims("tenant-a", "context:read", "alpha");
  const writeA = store.createClaims("tenant-a", "context:write", "alpha");
  store.createContext({ actor: tenantA, claims: writeA, context: "alpha" });
  store.write({
    actor: tenantA,
    claims: writeA,
    targetTenantId: "tenant-a",
    context: "alpha",
    objectId: "secret",
    payload: { value: "victim-data" },
    erasureGeneration: 1,
  });
  const ownRead = store.read({
    actor: tenantA,
    claims: readA,
    targetTenantId: "tenant-a",
    context: "alpha",
    objectId: "secret",
  });
  assert.equal(ownRead.value, "victim-data");
  assert.equal(Object.keys(ownRead).length, 1);
  const readB = store.createClaims("tenant-b", "context:read", "alpha");
  const outcomes = [];
  for (const objectId of ["secret", "missing"]) {
    try {
      store.read({
        actor: tenantB,
        claims: readB,
        targetTenantId: "tenant-a",
        context: "alpha",
        objectId,
      });
    } catch (error) {
      outcomes.push({ code: error.code, message: error.message, keys: Object.keys(error).sort() });
    }
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0], {
    code: "RESOURCE_UNAVAILABLE",
    message: "RESOURCE_UNAVAILABLE",
    keys: ["code", "name"],
  });
});

test("V03-TENANT-02 cross-tenant writes deny before target existence is inspected", () => {
  const store = new InMemoryTenantErasureStore();
  const tenantA = authority("tenant-a", "a");
  const tenantB = authority("tenant-b", "b");
  store.registerCanonicalAuthority(tenantA);
  store.registerCanonicalAuthority(tenantB);
  const writeB = store.createClaims("tenant-b", "context:write", "alpha");
  for (const context of ["alpha", "does-not-exist"]) {
    assert.throws(() => store.write({
      actor: tenantB,
      claims: writeB,
      targetTenantId: "tenant-a",
      context,
      objectId: "probe",
      payload: { attack: true },
      erasureGeneration: 1,
    }), { code: "AUTHORIZATION_DENIED" });
  }
});

test("V03-ERASURE-01 late write, old restore, and current-generation write during deletion fail closed", () => {
  const store = new InMemoryTenantErasureStore();
  const tenantA = authority("tenant-a", "a");
  store.registerCanonicalAuthority(tenantA);
  const write = store.createClaims("tenant-a", "context:write", "alpha");
  const read = store.createClaims("tenant-a", "context:read", "alpha");
  store.createContext({ actor: tenantA, claims: write, context: "alpha" });
  store.write({
    actor: tenantA,
    claims: write,
    targetTenantId: "tenant-a",
    context: "alpha",
    objectId: "record",
    payload: { before: true },
    erasureGeneration: 1,
  });
  store.beginDeletion({
    actor: tenantA,
    claims: write,
    targetTenantId: "tenant-a",
    context: "alpha",
    expectedGeneration: 1,
    nextGeneration: 2,
  });
  for (const erasureGeneration of [1, 2]) {
    assert.throws(() => store.write({
      actor: tenantA,
      claims: write,
      targetTenantId: "tenant-a",
      context: "alpha",
      objectId: "late",
      payload: { late: true },
      erasureGeneration,
    }), { code: "ERASURE_BARRIER_REJECTED" });
  }
  assert.throws(() => store.restore({
    actor: tenantA,
    claims: write,
    targetTenantId: "tenant-a",
    context: "alpha",
    objectId: "restored",
    payload: { old: true },
    sourceErasureGeneration: 1,
    erasedMarker: false,
  }), { code: "ERASURE_BARRIER_REJECTED" });
  const marker = store.completeDeletion({
    actor: tenantA,
    claims: write,
    targetTenantId: "tenant-a",
    context: "alpha",
    expectedGeneration: 2,
  });
  assert.equal(marker.payload_exposed, false);
  assert.throws(() => store.read({
    actor: tenantA,
    claims: read,
    targetTenantId: "tenant-a",
    context: "alpha",
    objectId: "record",
  }), { code: "RESOURCE_UNAVAILABLE" });
});
