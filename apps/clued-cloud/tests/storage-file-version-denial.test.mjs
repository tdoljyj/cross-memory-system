import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixture, ids, root } from "./resource-center-cloud-executor.fixture.mjs";
import { cloudDispatchOutcome } from "../../../kernel/host/resource-center-cloud-executor.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const loaded = build({ entryPoints: [fileURLToPath(new URL("../worker/storage-agent-tools.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" })
  .then(result => import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")));

function replaceFixture() {
  const content = "unchanged bytes";
  const f = fixture({ mutation: { operation: "replace", target_kind: "file", destination_path: root + "/track/fixed.md",
    destination_file_version: "3", content } });
  f.config.verified_result_mode = true;
  const load = f.config.load_job;
  f.config.load_job = async ref => ({ ...await load(ref), revision_releases: [] });
  f.files.set("fixed", { id: "fixed", name: "fixed.md", parents: ["track"], version: "3", trashed: false,
    mimeType: "text/plain", size: String(Buffer.byteLength(content)), sha256Checksum: createHash("sha256").update(content).digest("hex") });
  return f;
}

test("initial file registration version denial has a stable code and no reservation or provider write", async () => {
  const f = replaceFixture(), rpc = f.config.rpc;
  f.config.rpc = input => input.action === "authority" ? Promise.resolve({ status: "denied", reason: "destination_version_mismatch" }) : rpc(input);
  const result = await (await f.run()).run(f.reference);
  assert.deepEqual(result, { status: "deny", error_code: "ARTIFACT_VERSION_MISMATCH", side_effects: 0, execution_permitted: false });
  assert.equal(f.info().starts, 0);
  assert.equal(f.info().posts, 0);
  assert.deepEqual(cloudDispatchOutcome(result), { status: "denied", reason: { code: "ARTIFACT_VERSION_MISMATCH" } });
});

test("identity and unknown denials keep their generic code", async () => {
  for (const reason of ["destination_mismatch", "private-value-not-allowed"]) {
    const f = replaceFixture(), rpc = f.config.rpc;
    f.config.rpc = input => input.action === "authority" ? Promise.resolve({ status: "denied", reason }) : rpc(input);
    const result = await (await f.run()).run(f.reference);
    assert.equal(result.error_code, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
    assert.equal(f.info().starts, 0);
    assert.equal(f.info().posts, 0);
  }
});

test("a version denial after initial authority does not get the initial no-effect diagnostic", async () => {
  const f = fixture(), rpc = f.config.rpc;
  let lookups = 0;
  f.config.rpc = input => input.action === "authority" && ++lookups === 2 ?
    Promise.resolve({ status: "denied", reason: "destination_version_mismatch" }) : rpc(input);
  const result = await (await f.run()).run(f.reference);
  assert.notEqual(result.error_code, "ARTIFACT_VERSION_MISMATCH");
  assert.equal(f.info().posts, 0);
});

test("storage inspection returns a fixed actionable hint and excludes private RPC fields", async () => {
  const { storageAgentResult } = await loaded;
  const input = { connection_id: ids.connection, job_id: ids.job };
  const raw = { ...input, status: "denied", request_digest: "a".repeat(64), receipt_id: ids.receipt, intent_id: null,
    execution_permitted: false, reason_code: "ARTIFACT_VERSION_MISMATCH", hint: "untrusted database text",
    provider_file_id: "private-id", registered_version: "2", actual_version: "3", path: "/private/path" };
  const result = storageAgentResult(raw, input);
  assert.match(result.hint, /registered version.*differs/i);
  assert.match(result.hint, /formal registration management/);
  assert.match(result.hint, /Do not retry or adopt/);
  assert.match(result.hint, /new job_id/);
  for (const key of ["provider_file_id", "registered_version", "actual_version", "path"]) assert.equal(key in result, false);
  assert.equal(result.hint.includes("untrusted database text"), false);
  assert.equal("hint" in storageAgentResult({ ...raw, reason_code: "ARTIFACT_AUTHORITY_RESOLUTION_FAILED" }, input), false);
  assert.throws(() => storageAgentResult({ ...raw, status: "committed" }, input), /storage_job_response_invalid/);
});
