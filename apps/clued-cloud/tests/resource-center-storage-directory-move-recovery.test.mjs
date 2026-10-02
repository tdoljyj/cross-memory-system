import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build, stop } from "esbuild";

// StorageFullCapability.v0.1 P6: the Worker recovery path (the Owner's
// native recovery; scheduled recovery never loads a directory move)
// re-verifies a directory move by GET only and settles through the verified
// record with the directory move proof.
const dir = await mkdtemp(path.join(os.tmpdir(), "clued-directory-move-recovery-"));
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
const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });

const SHARING = { shared: false, permissionIds: ["owner-permission"] };
const { googleDriveSharingDigest } = await import("../../../kernel/host/resource-center-google-drive-sharing.mjs");
const DIGEST = googleDriveSharingDigest(SHARING);
const SAMPLE = [{ provider_file_id: "note", relative_path: "note.md", target_kind: "file" }];

async function setup({ moved = true, sample = SAMPLE } = {}) {
  const files = new Map([["root", folder("root", "Clued_资料中心", "container")], ["track", folder("track", "20_P_产品与体验", "root")],
    ["topic", folder("topic", "topic", "track")], ["dir", { ...folder("dir", "folder", moved ? "topic" : "track"), version: "9" }],
    ["note", { id: "note", name: "note.md", parents: ["dir"], version: "3", trashed: false, mimeType: "text/markdown" }]]);
  const vaultConfig = { current_key_id: "test", keys: { test: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(vaultConfig);
  const mutation = { operation: "move", target_kind: "directory", source_path: TRACK + "/folder", destination_path: TRACK + "/topic/folder",
    source_file_version: "6", source_file_id: "dir" };
  const provider = { root_folder_id: "root", root_parent_id: "container", root_folder_version: "1", source_file_id: "dir",
    source_file_version: "6", destination_parent_id: "topic", destination_parent_version: "1", destination_file_id: null,
    destination_file_version: null, provider_version: "a".repeat(64), root_sharing_digest: DIGEST, destination_parent_sharing_digest: DIGEST,
    source_parent_id: "track", source_sharing_digest: DIGEST, source_parent_sharing_digest: DIGEST };
  const descriptor = { status: "recovery_only", owner_id: ids.owner, connection_id: ids.connection, job_id: ids.job, intent_id: ids.intent,
    version: 2, provider: "google-drive", oauth_client_id: "test-client", provider_subject: "subject", credential_version: 1,
    request_sha256: "b".repeat(64), root_folder_id: "root", root_parent_id: "container",
    profile: { managed_root: ROOT }, mutation, provider_before: provider,
    attempt: { contract: "clued.storage-subtree-move-attempt/1", intent_id: ids.intent, operation: "move", target_kind: "directory",
      provider_file_id: "dir", source_path: mutation.source_path, source_file_version: "6", source_parent_id: "track",
      destination_path: mutation.destination_path, parent_id: "topic", subtree_sample: sample } };
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
        return Response.json({ files: [...files.values()].filter(f => f.parents.includes(parentId) && !f.trashed && (!name || f.name === name)), incompleteSearch: false });
      }
      const found = files.get(u.pathname.split("/").at(-1));
      if (found && u.searchParams.get("fields") === "id,shared,permissionIds") return Response.json({ id: found.id, ...SHARING });
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

test("a lost directory move reply is settled by GET-only re-verification with the directory move proof", async () => {
  const f = await setup();
  const result = await f.recovery.run({ connection_id: ids.connection, job_id: ids.job });
  assert.deepEqual(result, { status: "committed", job_id: ids.job, receipt_id: ids.receipt, execution_permitted: false });
  assert.ok(f.methods.every(method => method === "GET"), "recovery never writes");
  assert.deepEqual(f.calls.map(c => c.action), ["verified_record", "settle_verified"]);
  assert.equal(f.calls[0].proof.contract, "clued.storage-directory-move-verified/1");
  assert.deepEqual(f.calls[0].proof.subtree_sample, SAMPLE);
  assert.equal(f.calls[0].finish.postcondition.parent_id, "topic"); assert.equal(f.calls[0].finish.postcondition.provider_file_version, "9");
});

test("an unmoved directory, a wrong attempt contract or a malformed sample stays for inspection", async () => {
  const unmoved = await setup({ moved: false });
  assert.equal((await unmoved.recovery.run({ connection_id: ids.connection, job_id: ids.job })).status, "inspection_required");
  assert.equal(unmoved.calls.length, 0);
  const wrong = await setup();
  wrong.descriptor.attempt.contract = "clued.storage-modify-attempt/1";
  assert.equal((await wrong.recovery.run({ connection_id: ids.connection, job_id: ids.job })).status, "inspection_required");
  assert.equal(wrong.calls.length, 0);
  const malformed = await setup({ sample: [{ provider_file_id: "note", relative_path: "../note.md", target_kind: "file" }] });
  assert.equal((await malformed.recovery.run({ connection_id: ids.connection, job_id: ids.job })).status, "inspection_required");
  assert.equal(malformed.calls.length, 0);
});
