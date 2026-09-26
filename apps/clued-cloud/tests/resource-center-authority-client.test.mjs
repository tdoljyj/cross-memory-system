import assert from "node:assert/strict";
import test from "node:test";

import { createResourceCenterAuthorityClient } from "../../../kernel/host/resource-center-authority-client.mjs";

const TOKEN = `clued_rcb_${"a".repeat(40)}`;
const profile = { profile_id: "registered-profile", profile_version: "2" };
const mutation = {
  operation: "create", destination_path: "G:/My Drive/Clued_资料中心/20_P/主题",
  target_kind: "directory", directory_semantics: "topic", artifact_role: "clued_resource",
};
const authority = {
  artifact_id: null, artifact_role: "clued_resource", governance_class: "ordinary",
  delete_authority: false, authority_version: "canonical/1",
  currentness_identity: "currentness/1", workspace_version: "workspace/1",
};
const providerIdentity = {
  root_folder_id: "root-id", source_file_id: null,
  destination_parent_id: "parent-id", destination_file_id: null,
  provider_version: "123",
};

test("dedicated resolver binds the exact request and keeps its token out of tool input", async () => {
  const calls = [];
  const resolve = createResourceCenterAuthorityClient({
    endpoint: "https://clued.example/v1/resource-center/authority",
    binding_token: TOKEN,
    resolve_provider_identity: async () => providerIdentity,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        contract: body.request.contract, status: "resolved", request: body.request,
        request_sha256: body.request_sha256, authority,
      }) };
    },
  });
  assert.deepEqual(await resolve({ profile, mutation }), authority);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.body.includes(TOKEN), false);
  assert.equal(JSON.parse(calls[0].options.body).request.mutation.destination_path.toLowerCase(),
    mutation.destination_path.toLowerCase());
  assert.deepEqual(JSON.parse(calls[0].options.body).request.provider_identity, providerIdentity);
  await resolve({ profile, mutation });
  assert.notEqual(JSON.parse(calls[0].options.body).request.nonce,
    JSON.parse(calls[1].options.body).request.nonce);
});

test("resolver rejects reply substitution, stale identity and non-TLS endpoint", async () => {
  const resolve = createResourceCenterAuthorityClient({
    endpoint: "https://clued.example/v1/resource-center/authority",
    binding_token: TOKEN,
    resolve_provider_identity: async () => providerIdentity,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        contract: body.request.contract, status: "resolved", request: {
          ...body.request,
          mutation: { ...body.request.mutation, operation: "delete" },
        },
        request_sha256: body.request_sha256, authority,
      }) };
    },
  });
  await assert.rejects(resolve({ profile, mutation }), /RESPONSE_MISMATCH/);
  assert.throws(() => createResourceCenterAuthorityClient({
    endpoint: "http://clued.example/v1/resource-center/authority", binding_token: TOKEN,
    resolve_provider_identity: async () => providerIdentity,
  }), /HTTPS/);
  assert.throws(() => createResourceCenterAuthorityClient({
    endpoint: "https://clued.example/v1/resource-center/authority?root=other", binding_token: TOKEN,
    resolve_provider_identity: async () => providerIdentity,
  }), /fixed Resource Center route/);
});

test("resolver never calls Clued when provider IDs cannot be proven", async () => {
  let networkCalls = 0;
  const resolve = createResourceCenterAuthorityClient({
    endpoint: "https://clued.example/v1/resource-center/authority",
    binding_token: TOKEN,
    resolve_provider_identity: async () => ({ ...providerIdentity, destination_parent_id: null }),
    fetch: async () => { networkCalls += 1; throw new Error("must not call"); },
  });
  await assert.rejects(resolve({ profile, mutation }), /PROVIDER_IDENTITY_UNAVAILABLE/);
  assert.equal(networkCalls, 0);
});
