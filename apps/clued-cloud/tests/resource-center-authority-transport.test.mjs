import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const token = "clued_rcb_" + "a".repeat(40);
const contract = "clued.resource-center-authority/1";
const authority = {
  artifact_id: null, artifact_role: "clued_resource",
  governance_class: "ordinary", delete_authority: false,
  authority_version: "artifact/1", currentness_identity: "decision/1",
  workspace_version: "profile/1",
};
const request = {
  contract, nonce: "11111111-1111-4111-8111-111111111111",
  policy_version: "clued.resource-center-mutation-policy/1",
  profile_id: "22222222-2222-4222-8222-222222222222",
  profile_version: "test/1",
  provider_identity: {
    root_folder_id: "root-id", root_parent_id: "my-drive",
    root_folder_version: "1", source_file_id: null, source_file_version: null,
    destination_parent_id: "root-id", destination_parent_version: "1",
    destination_file_id: null, destination_file_version: null,
    provider_version: "a".repeat(64),
  },
  mutation: {
    operation: "create", source_path: null, destination_path: "/tmp/Clued_资料中心/topic",
    artifact_role: "clued_resource", target_kind: "directory", directory_semantics: "topic",
  },
};
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const envelope = { request, request_sha256: digest(request) };
const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };

function authorityRequest(credential, body = envelope) {
  return new Request("https://clued.test/v1/resource-center/authority", {
    method: "POST",
    headers: { authorization: "Bearer " + credential, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("dedicated authority route returns only an exact authenticated read", async () => {
  const worker = await loadContinuityWorker();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(init.body) });
    return Response.json({ status: "resolved", authority });
  };
  try {
    const response = await worker.fetch(authorityRequest(token), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      contract, status: "resolved", request, request_sha256: envelope.request_sha256, authority,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/clued_resource_center_authority_v1$/);
    assert.equal(calls[0].body.p_token_hash, createHash("sha256").update(token).digest("hex"));
    assert.deepEqual(calls[0].body.p_request, request);
    assert.equal(JSON.stringify(calls).includes(token), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal Clued Bindings, changed request digests and denied registration have no authority", async () => {
  const worker = await loadContinuityWorker();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ status: "denied" });
  };
  try {
    assert.equal((await worker.fetch(authorityRequest("clued_bnd_" + "b".repeat(40)), env, ctx)).status, 403);
    assert.equal((await worker.fetch(authorityRequest(token, {
      ...envelope, request_sha256: "0".repeat(64),
    }), env, ctx)).status, 403);
    assert.equal(calls, 0);
    assert.equal((await worker.fetch(authorityRequest(token), env, ctx)).status, 403);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("writer route separates credentials, binds responses and fails closed on transport error", async () => {
  const worker = await loadContinuityWorker();
  const originalFetch = globalThis.fetch;
  const writerToken = "clued_rcw_" + "w".repeat(40);
  const writeRequest = { action: "inspect", intent_id: "11111111-1111-4111-8111-111111111111",
    request_sha256: "a".repeat(64) };
  const body = { contract: "clued.resource-center-write/1", nonce: request.nonce,
    request: writeRequest, request_sha256: digest(writeRequest) };
  const call = (credential, payload = body) => worker.fetch(new Request("https://clued.test/v1/resource-center/write", {
    method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), env, ctx);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ status: "prepared", execution_permitted: false });
  };
  try {
    assert.equal((await call(token)).status, 403);
    assert.equal((await call("clued_bnd_" + "b".repeat(40))).status, 403);
    assert.equal((await call(writerToken, { ...body, request_sha256: "0".repeat(64) })).status, 403);
    assert.equal(calls.length, 0);
    const response = await call(writerToken);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ...body, outcome: { status: "prepared", execution_permitted: false } });
    assert.match(calls[0].url, /\/rpc\/clued_resource_center_write_v1$/);
    assert.equal(JSON.stringify(calls).includes(writerToken), false);
    globalThis.fetch = async () => Response.json({ status: "denied" });
    assert.equal((await call(writerToken)).status, 403);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal((await call(writerToken)).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
