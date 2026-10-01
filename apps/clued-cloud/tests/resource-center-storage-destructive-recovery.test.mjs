import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build, stop } from "esbuild";

// StorageFullCapability.v0.1 P5: the Worker recovery path re-verifies a
// trash or untrash by GET only and settles through the verified record.
const dir = await mkdtemp(path.join(os.tmpdir(), "clued-destructive-recovery-"));
async function load(name) {
  const outfile = path.join(dir, name + ".mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../worker/" + name + ".ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(outfile));
}
const { createStorageCloudRecovery } = await load("storage-cloud-recovery");
const { createStorageCredentialVault } = await load("storage-credential-vault");
stop();

const ROOT = "G:/test/Clued_资料中心", TRACK = ROOT + "/20_P_产品与体验";
const ids = { owner: "10000000-0000-4000-8000-000000000001", connection: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003", intent: "40000000-0000-4000-8000-000000000004", receipt: "50000000-0000-4000-8000-000000000005" };
const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const CONTENT = { size: "12", sha256: "c".repeat(64), md5: "d".repeat(32), head_revision_id: "rev-1" };
const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });

async function setup(operation, { trashed = operation === "delete", parent = "track" } = {}) {
  const files = new Map([["root", folder("root", "Clued_资料中心", "container")], ["track", folder("track", "20_P_产品与体验", "root")],
    ["file", { id: "file", name: "a.txt", parents: [parent], version: "9", trashed, mimeType: "text/plain",
      size: "12", sha256Checksum: "c".repeat(64), md5Checksum: "d".repeat(32), headRevisionId: "rev-1" }]]);
  const vaultConfig = { current_key_id: "test", keys: { test: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(vaultConfig);
  const mutation = { operation, target_kind: "file", source_path: TRACK + "/a.txt", source_file_version: "5", source_file_id: "file" };
  const provider = { root_folder_id: "root", root_parent_id: "container", root_folder_version: "1", source_file_id: "file",
    source_file_version: "5", destination_parent_id: null, destination_parent_version: null, destination_file_id: null,
    destination_file_version: null, provider_version: "a".repeat(64), root_sharing_digest: null, destination_parent_sharing_digest: null,
    source_parent_id: "track" };
  const descriptor = { status: "recovery_only", owner_id: ids.owner, connection_id: ids.connection, job_id: ids.job, intent_id: ids.intent,
    version: 2, provider: "google-drive", oauth_client_id: "test-client", provider_subject: "subject", credential_version: 1,
    request_sha256: "b".repeat(64), root_folder_id: "root", root_parent_id: "container",
    profile: { registration_status: "registered", profile_id: "p", profile_version: "1", managed_root: ROOT }, mutation, provider_before: provider,
    attempt: { contract: "clued.storage-destructive-attempt/1", intent_id: ids.intent, operation, provider_file_id: "file",
      source_path: mutation.source_path, source_file_version: "5", destination_path: null, restore_mode: null,
      parent_id: "track", target_kind: "file", content: CONTENT } };
  descriptor.credential_envelope = await vault.seal(JSON.stringify({ access_token: "recovery-access-token-0001", scope: SCOPE,
    token_type: "Bearer", expires_at_ms: Date.now() + 3600000 }), { owner_id: ids.owner, connection_id: ids.connection, provider: "google-drive",
    provider_subject: "subject", oauth_client_id: "test-client", credential_version: 1 });
  const calls = [], methods = [];
  const recovery = await createStorageCloudRecovery({ client_id: "test-client", vault: vaultConfig, rpc: async () => { throw new Error("unused"); },
    fetch: async (url, init) => {
      methods.push(init.method);
      const u = new URL(String(url)), query = u.searchParams.get("q");
      if (query) {
        const parentId = /'([^']+)' in parents/.exec(query)[1], name = /name = '([^']+)'/.exec(query)?.[1];
        const all = !/trashed = false/.test(query); // hasChildren counts trashed children too
        return Response.json({ files: [...files.values()].filter(f => f.parents.includes(parentId) && (all || !f.trashed) && (!name || f.name === name)), incompleteSearch: false });
      }
      const found = files.get(u.pathname.split("/").at(-1));
      return found ? Response.json(found) : new Response("", { status: 404 });
    },
    verified: { descriptor, rpc: async input => {
      calls.push(structuredClone(input));
      if (input.action === "verified_record") return { status: "verified", intent_id: ids.intent, version: 2, verified_receipt_id: ids.receipt,
        verified_digest: "f".repeat(64), execution_permitted: false };
      return { status: "committed", state: "committed", intent_id: ids.intent, receipt_id: ids.receipt, execution_permitted: false,
        final_result: { status: "committed" } };
    } } });
  return { recovery, calls, methods, descriptor };
}

test("a lost trash reply is settled by GET-only re-verification with the trash proof", async () => {
  const f = await setup("delete");
  const result = await f.recovery.run({ connection_id: ids.connection, job_id: ids.job });
  assert.deepEqual(result, { status: "committed", job_id: ids.job, receipt_id: ids.receipt, execution_permitted: false });
  assert.ok(f.methods.every(method => method === "GET"), "recovery never writes");
  assert.deepEqual(f.calls.map(c => c.action), ["verified_record", "settle_verified"]);
  assert.equal(f.calls[0].proof.contract, "clued.storage-trash-verified/1");
  assert.equal(f.calls[0].proof.trashed, true); assert.equal(f.calls[0].finish.postcondition.provider_file_version, "9");
});

test("a lost untrash reply settles with the untrash proof", async () => {
  const f = await setup("restore");
  assert.equal((await f.recovery.run({ connection_id: ids.connection, job_id: ids.job })).status, "committed");
  assert.equal(f.calls[0].proof.contract, "clued.storage-untrash-verified/1");
});

test("an unconfirmed state or a mismatched attempt parent stays for inspection", async () => {
  const pending = await setup("delete", { trashed: false });
  assert.equal((await pending.recovery.run({ connection_id: ids.connection, job_id: ids.job })).status, "inspection_required");
  assert.equal(pending.calls.length, 0);
  const wrong = await setup("delete");
  wrong.descriptor.attempt.parent_id = "root";
  assert.equal((await wrong.recovery.run({ connection_id: ids.connection, job_id: ids.job })).status, "inspection_required");
  assert.equal(wrong.calls.length, 0);
});
