import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build, stop } from "esbuild";

const directory = await mkdtemp(path.join(os.tmpdir(), "storage-before-cloud-"));
async function load(name) {
  const output = path.join(directory, `${name}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL(`../worker/${name}.ts`, import.meta.url))], outfile: output,
    bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(output));
}
const { createStorageCloudRecovery } = await load("storage-cloud-recovery");
const { createStorageCredentialVault } = await load("storage-credential-vault");
stop();
const NOW = Date.parse("2026-10-16T12:00:00Z"), SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const oldHash = "a".repeat(64), newHash = "b".repeat(64), FOLDER = "application/vnd.google-apps.folder";

async function fixture(options = {}) {
  const reference = { connection_id: randomUUID(), job_id: randomUUID() }, source = randomUUID(), receipt = randomUUID(), calls = [], requests = [], reports = [];
  const vaultConfig = { current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } }, vault = await createStorageCredentialVault(vaultConfig);
  const context = { owner_id: randomUUID(), connection_id: reference.connection_id, provider: "google-drive", provider_subject: "subject",
    oauth_client_id: "fixture-client", credential_version: 4 };
  const descriptor = { ...context, ...reference, status: "recovery_only", intent_id: randomUUID(), version: 3, request_sha256: "d".repeat(64),
    root_folder_id: "root", root_parent_id: "drive", profile: { managed_root: "/root" },
    mutation: { operation: "replace", target_kind: "file", destination_path: "/root/track/a.txt", destination_file_version: "5", content: "test", artifact_role: "clued_resource" },
    provider_before: { root_folder_id: "root", root_parent_id: "drive", root_folder_version: "1", destination_parent_id: "track", destination_parent_version: "1",
      destination_file_id: "file", destination_file_version: "5", provider_version: "c".repeat(64) },
    attempt: { contract: "clued.storage-replace-attempt/1", operation: "replace", provider_file_id: "file", parent_id: "track", destination_path: "/root/track/a.txt",
      destination_file_version: "5", pinned_revision_id: "rev1", content_before: { size: "3", sha256: oldHash, head_revision_id: "rev1", md5: "a".repeat(32) },
      content_after: { size: "4", sha256: newHash }, previously_kept: false, release_revision_ids: [], restore_job_id: null },
    conflict_reconcile: { source_receipt_id: source, closed_version: 3 },
    credential_envelope: await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-original-access-token", scope: options.scope ?? SCOPE,
      expires_at_ms: NOW + (options.expiresInMs ?? 3600000) }), context) };
  options.mutate?.(descriptor);
  let targetReads = 0, time = NOW;
  const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: FOLDER });
  const current = () => {
    const state = options.changeBetween && targetReads >= 2 ? "changed" : options.state ?? "before";
    return { id: "file", name: "a.txt", parents: ["track"], version: state === "before" ? "5" : "6", trashed: false, mimeType: "text/plain",
      size: state === "after" ? "4" : "3", sha256Checksum: state === "before" ? oldHash : state === "after" ? newHash : "e".repeat(64),
      headRevisionId: state === "before" ? "rev1" : "rev2" };
  };
  const pinned = { ...reference, intent_id: descriptor.intent_id, source_receipt_id: source, base_version: 3, execution_permitted: false };
  const config = { client_id: "fixture-client", vault: vaultConfig, clock: () => time, timeout_ms: options.timeout ?? 1000, report_expiring: true,
    report_diagnostic: async (ref, diagnostic) => reports.push({ ref, diagnostic }),
    fetch: async (url, init) => {
      const u = new URL(String(url)); requests.push(u.pathname); time += 10;
      assert.equal(init.method, "GET"); assert.equal(init.body, undefined); assert.equal(u.origin, "https://www.googleapis.com");
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      if (u.pathname === "/drive/v3/files/file/revisions/rev1") return Response.json({ id: "rev1", keepForever: true, size: "3", md5Checksum: "a".repeat(32) });
      if (u.pathname === "/drive/v3/files/file") { targetReads++; return Response.json(current()); }
      if (u.pathname === "/drive/v3/files/root") return Response.json(folder("root", "root", "drive"));
      assert.equal(u.pathname, "/drive/v3/files");
      if (u.searchParams.get("q").includes("name = 'track'")) return Response.json({ files: [folder("track", "track", "root")] });
      assert.ok(u.searchParams.get("q").includes("name = 'a.txt'")); return Response.json({ files: [current()] });
    }, rpc: async input => {
      calls.push(structuredClone(input)); assert.equal(input.action, "reconcile_before");
      if (options.rpcError) throw Error("private policy stopped");
      const state = input.second_observation.observed_state;
      const response = state === "before" ? { status: "resolved", resolution: "automatically_reconciled_before", automatic_recovery: "resolved", ...pinned, receipt_id: receipt }
        : state === "after" ? { status: "after_observed", ...pinned }
          : { status: "inspection_required", ...pinned, diagnostic: { stage: "verification", reason: "CONTENT_MISMATCH",
            observed_at: input.second_observation.observed_at, automatic_next_action: "continue_object_recovery" } };
      return options.reply ? options.reply(response) : response;
    }, verified: { descriptor, rpc: async input => {
      calls.push(structuredClone(input));
      if (input.action === "verified_record") {
        assert.equal(input.proof.contract, "clued.storage-replace-verified/1");
        return { status: "verified", intent_id: descriptor.intent_id, version: 3, verified_receipt_id: randomUUID(), verified_digest: "f".repeat(64), execution_permitted: false };
      }
      assert.equal(input.action, "settle_verified");
      return { status: "committed", state: "committed", ...reference, intent_id: descriptor.intent_id, receipt_id: receipt,
        final_result: { status: "committed" }, execution_permitted: false };
    } } };
  return { reference, source, receipt, descriptor, calls, requests, reports, config, recovery: await createStorageCloudRecovery(config) };
}

test("eligible unchanged replace reconciles before the after verifier, without another write or finalization", async () => {
  const f = await fixture(), result = await f.recovery.run(f.reference);
  assert.equal(result.status, "resolved"); assert.equal(result.resolution, "automatically_reconciled_before");
  assert.equal(result.receipt_id, f.receipt); assert.notEqual(result.receipt_id, f.source);
  assert.deepEqual(f.calls.map(c => c.action), ["reconcile_before"]);
  assert.equal(f.requests.filter(p => p === "/drive/v3/files/file").length, 2);
  assert.equal(f.requests.some(p => p.includes("/revisions/")), false); assert.equal(f.reports.length, 0);
});

test("observed after continues through the actual existing verified-record and settlement path", async () => {
  const f = await fixture({ state: "after" }), result = await f.recovery.run(f.reference);
  assert.deepEqual(result, { status: "committed", job_id: f.reference.job_id, receipt_id: f.receipt, execution_permitted: false });
  assert.deepEqual(f.calls.map(c => c.action), ["reconcile_before", "verified_record", "settle_verified"]);
  assert.equal(f.requests.filter(p => p.endsWith("/revisions/rev1")).length, 1);
  assert.ok(f.calls.every(c => c.job_id === f.reference.job_id && c.connection_id === f.reference.connection_id));
});

test("stable actual content conflict returns the SQL diagnostic and never attempts the old after settlement", async () => {
  const f = await fixture({ state: "changed" }), result = await f.recovery.run(f.reference);
  assert.equal(result.status, "inspection_required"); assert.equal(result.diagnostic.reason, "CONTENT_MISMATCH");
  assert.equal(result.diagnostic.automatic_next_action, "continue_object_recovery");
  assert.deepEqual(f.calls.map(c => c.action), ["reconcile_before"]); assert.equal(f.reports.length, 0);
});

test("changed-between-GETs and expiring original credentials do not send a reconciliation or provider effect", async () => {
  const changing = await fixture({ changeBetween: true }), changedResult = await changing.recovery.run(changing.reference);
  assert.equal(changedResult.status, "inspection_required"); assert.equal(changing.calls.length, 0);
  const expiring = await fixture({ expiresInMs: 59999 });
  assert.equal((await expiring.recovery.run(expiring.reference)).status, "credential_expiring");
  assert.equal(expiring.requests.length, 0); assert.equal(expiring.calls.length, 0);
});

test("a missing descriptor is not loaded with bypass credentials; malformed eligibility is rejected before Drive", async () => {
  for (const mutate of [d => { d.conflict_reconcile.closed_version = 2; }, d => { d.conflict_reconcile.source_receipt_id = "bad"; },
    d => { d.attempt.parent_id = "other"; }, d => { d.mutation.target_kind = "directory"; }]) {
    const f = await fixture({ mutate }); assert.equal((await f.recovery.run(f.reference)).status, "inspection_required");
    assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(), denied = await createStorageCloudRecovery({ ...f.config, verified: undefined,
    rpc: async () => { throw Error("read authorization disabled"); } });
  assert.equal((await denied.run(f.reference)).status, "inspection_required"); assert.equal(f.requests.length, 0);
});

test("RPC authorization rejection or mismatched replies stop once and never fall through to settle", async () => {
  for (const options of [{ rpcError: true }, { reply: r => ({ ...r, intent_id: randomUUID() }) },
    { reply: r => ({ ...r, receipt_id: r.source_receipt_id }) }, { reply: r => ({ ...r, execution_permitted: true }) },
    { reply: r => ({ ...r, resolution: "accepted_current_state" }) }, { reply: r => ({ ...r, status: "after_observed" }) }]) {
    const f = await fixture(options); assert.equal((await f.recovery.run(f.reference)).status, "inspection_required");
    assert.deepEqual(f.calls.map(c => c.action), ["reconcile_before"]);
  }
});

test("the outer recovery deadline cancels late metadata before it can send a reconciliation RPC", async () => {
  const f = await fixture({ timeout: 20, delay: 50 }), started = Date.now();
  assert.equal((await f.recovery.run(f.reference)).status, "inspection_required");
  assert.ok(Date.now() - started < 500); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 1);
});
