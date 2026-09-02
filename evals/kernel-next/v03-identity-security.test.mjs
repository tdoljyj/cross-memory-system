import assert from "node:assert/strict";
import test from "node:test";
import {
  REVOCATION_COMPONENTS,
  assertBoundIdentityClaimsCurrent,
  createBoundIdentityClaims,
  validateRevocationEpochVector,
} from "../../kernel/policy/identity-security.mjs";
import { InMemoryTestGenerationKeyRing } from "../../kernel/policy/test-generation-keyring.mjs";

const digest = (char) => "sha256:" + char.repeat(64);
const ref = (id, char) => ({ scope_id: id, scope_digest: digest(char) });
const vector = () => ({
  vector_schema_version: "1",
  account_scope_ref: ref("acct:test", "a"),
  account_epoch: 4,
  integration_installation_scope_ref: ref("install:test", "b"),
  integration_installation_epoch: 5,
  context_scope_ref: ref("ctx:test", "c"),
  context_epoch: 6,
  binding_scope_ref: ref("bind:test", "d"),
  binding_epoch: 7,
});
const authority = () => ({
  tenant_id: "tenant-a",
  subject_ref: "subject-a",
  binding_id: "binding-a",
  scope_allowlist: ["context:read", "context:write"],
  purpose_allowlist: ["kernel-runtime"],
  revocation_epoch_vector: vector(),
  generation_claims: {
    runner_generation: 3,
    credential_generation: 9,
    session_generation: 12,
    signing_key_generation: 2,
  },
});

test("V03-ID-01 complete four-layer vector is mandatory", () => {
  assert.equal(JSON.stringify(validateRevocationEpochVector(vector())), JSON.stringify(vector()));
  for (const component of REVOCATION_COMPONENTS) {
    const incomplete = vector();
    delete incomplete[component.scope];
    assert.throws(() => validateRevocationEpochVector(incomplete), { code: "REVOCATION_VECTOR_INCOMPLETE" });
    const invalidNotApplicable = vector();
    invalidNotApplicable[component.scope] = { status: "not_applicable", reason: "fixture" };
    invalidNotApplicable[component.epoch] = 0;
    assert.throws(() => validateRevocationEpochVector(invalidNotApplicable), {
      code: "REVOCATION_NOT_APPLICABLE_INVALID",
    });
  }
});

test("V03-ID-02 every stale or future vector layer and object generation is rejected", () => {
  const current = authority();
  const claims = createBoundIdentityClaims(current, {
    scope: "context:write",
    purpose: "kernel-runtime",
    target_digest: "context:alpha",
  });
  const target = {
    tenant_id: "tenant-a",
    scope: "context:write",
    purpose: "kernel-runtime",
    target_digest: "context:alpha",
  };
  assert.equal(assertBoundIdentityClaimsCurrent({ actor: current, claims, target }), true);
  for (const component of REVOCATION_COMPONENTS) {
    for (const delta of [-1, 1]) {
      const changed = structuredClone(claims);
      changed.revocation_epoch_vector[component.epoch] += delta;
      assert.throws(
        () => assertBoundIdentityClaimsCurrent({ actor: current, claims: changed, target }),
        { code: "STALE_OR_FUTURE_REVOCATION_VECTOR" },
      );
    }
  }
  for (const key of Object.keys(claims.generation_claims)) {
    const changed = structuredClone(claims);
    changed.generation_claims[key] -= 1;
    assert.throws(
      () => assertBoundIdentityClaimsCurrent({ actor: current, claims: changed, target }),
      { code: "STALE_OR_FUTURE_OBJECT_GENERATION" },
    );
  }
});

test("V03-ID-03 tenant, binding, scope, purpose and target remain exact", () => {
  const current = authority();
  const claims = createBoundIdentityClaims(current, {
    scope: "context:read",
    purpose: "kernel-runtime",
    target_digest: "context:alpha",
  });
  const base = {
    tenant_id: "tenant-a",
    scope: "context:read",
    purpose: "kernel-runtime",
    target_digest: "context:alpha",
  };
  for (const mutation of [
    { tenant_id: "tenant-b" },
    { scope: "context:write" },
    { purpose: "analytics" },
    { target_digest: "context:beta" },
  ]) {
    assert.throws(
      () => assertBoundIdentityClaimsCurrent({ actor: current, claims, target: { ...base, ...mutation } }),
      { code: "AUTHORIZATION_DENIED" },
    );
  }
});

test("V03-KEY-01 synthetic key is test-only, dual-verifies, rejects old signing, and is destroyed", () => {
  const ring = new InMemoryTestGenerationKeyRing();
  ring.installInitial({ generation: 1, keyMaterial: Buffer.alloc(32, 1) });
  const oldSignature = ring.sign("payload", { audience: "urn:clued:test:v03" });
  assert.equal(ring.verify("payload", oldSignature, { audience: "urn:clued:test:v03", now: 10 }), true);
  assert.throws(() => ring.sign("payload", { audience: "urn:clued:production" }), {
    code: "PRODUCTION_AUDIENCE_FORBIDDEN",
  });
  ring.rotate({ generation: 2, keyMaterial: Buffer.alloc(32, 2), dualVerifyThrough: 20 });
  const currentSignature = ring.sign("payload", { audience: "urn:clued:test:v03" });
  assert.equal(ring.verify("payload", oldSignature, { audience: "urn:clued:test:v03", now: 20 }), true);
  assert.equal(ring.verify("payload", currentSignature, { audience: "urn:clued:test:v03", now: 20 }), true);
  assert.throws(() => ring.sign("payload", { audience: "urn:clued:test:v03", generation: 1 }), {
    code: "OLD_GENERATION_SIGNING_FORBIDDEN",
  });
  ring.finalizeRotation({ now: 21 });
  assert.equal(ring.verify("payload", oldSignature, { audience: "urn:clued:test:v03", now: 21 }), false);
  ring.destroyAll();
  assert.deepEqual(ring.attestation(), {
    profile_id: "test_generation",
    audience_prefix: "urn:clued:test:",
    current_generation: null,
    previous_generation: null,
    active_key_count: 0,
    destroyed: true,
    private_material_exported: false,
    persisted: false,
  });
});
