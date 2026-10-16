import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build, stop } from "esbuild";

const directory = await mkdtemp(path.join(os.tmpdir(), "storage-before-review-"));
async function load(name) {
  const output = path.join(directory, `${name}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL(`../worker/${name}.ts`, import.meta.url))], outfile: output,
    bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(output));
}
const { createStorageRecoveryReview } = await load("storage-recovery-review");
const { createStorageCredentialVault } = await load("storage-credential-vault");
stop();

const NOW = Date.parse("2026-10-16T12:00:00Z");
const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const hash = "a".repeat(64), newHash = "b".repeat(64), FOLDER = "application/vnd.google-apps.folder";

// Real Worker/vault/metadata implementation; synthetic GET transport and private
// RPC. Database authorization and production Google acceptance are separate.
async function fixture(options = {}) {
  const reference = { connection_id: randomUUID(), job_id: randomUUID() }, source = randomUUID(), receipt = randomUUID();
  const vaultConfig = { current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(vaultConfig);
  const context = { owner_id: randomUUID(), connection_id: reference.connection_id, provider: "google-drive", provider_subject: "subject",
    oauth_client_id: "fixture-client", credential_version: 4 };
  const descriptor = { ...context, ...reference, status: "recovery_only", intent_id: randomUUID(), version: 3,
    root_folder_id: "root", root_parent_id: "drive", profile: { managed_root: "/root" },
    mutation: { operation: "replace", target_kind: "file", destination_path: "/root/track/a.txt", destination_file_version: "5" },
    provider_before: { destination_parent_id: "track", destination_file_id: "file", destination_file_version: "5" },
    attempt: { contract: "clued.storage-replace-attempt/1", operation: "replace", provider_file_id: "file", parent_id: "track",
      destination_path: "/root/track/a.txt", pinned_revision_id: "rev1", content_before: { size: "3", sha256: hash, head_revision_id: "rev1" },
      content_after: { size: "4", sha256: newHash } },
    conflict_reconcile: { source_receipt_id: source, closed_version: 3 },
    credential_envelope: await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-original-access-token",
      scope: options.scope ?? SCOPE, expires_at_ms: NOW + (options.expiresInMs ?? 3600000) }), context) };
  options.mutate?.(descriptor);
  let time = NOW, targetReads = 0;
  const requests = [], calls = [], completed = [];
  const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: FOLDER });
  const file = () => {
    const state = options.changeBetween && targetReads >= 2 ? "changed" : options.state ?? "before";
    return { id: "file", name: "a.txt", parents: ["track"], version: state === "before" ? "5" : "6", trashed: false,
      mimeType: "text/plain", size: state === "after" ? "4" : "3", sha256Checksum: state === "before" ? hash : state === "after" ? newHash : "c".repeat(64),
      headRevisionId: state === "before" ? "rev1" : "rev2", ...options.file };
  };
  const config = { client_id: "fixture-client", vault: vaultConfig, descriptor, source_receipt_id: source, clock: () => time,
    timeout_ms: options.timeout ?? 1000, fetch: async (url, init) => {
      const u = new URL(String(url)); requests.push(u.pathname); time += 10;
      assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-original-access-token");
      assert.equal(u.origin, "https://www.googleapis.com");
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      if (u.pathname === "/drive/v3/files/file") { targetReads++; return Response.json(file()); }
      if (u.pathname === "/drive/v3/files/root") return Response.json(folder("root", "root", "drive"));
      assert.equal(u.pathname, "/drive/v3/files");
      if (u.searchParams.get("q").includes("name = 'track'")) return Response.json({ files: [folder("track", "track", "root")] });
      assert.ok(u.searchParams.get("q").includes("name = 'a.txt'")); completed.push(time);
      return Response.json({ files: [file()] });
    }, rpc: async input => {
      calls.push(structuredClone(input));
      assert.equal(input.action, "reconcile_before");
      const pinned = { ...reference, intent_id: descriptor.intent_id, source_receipt_id: source, base_version: 3, execution_permitted: false };
      const state = input.second_observation.observed_state;
      const response = state === "before" ? { status: "resolved", resolution: "automatically_reconciled_before", automatic_recovery: "resolved", ...pinned, receipt_id: receipt }
        : state === "after" ? { status: "after_observed", ...pinned }
          : { status: "inspection_required", ...pinned, diagnostic: { stage: "verification", reason: "CONTENT_MISMATCH",
            observed_at: input.second_observation.observed_at, automatic_next_action: "continue_object_recovery" } };
      if (options.rpcError) throw Error("private disabled policy");
      return options.reply ? options.reply(response, input) : response;
    } };
  return { reference, source, receipt, descriptor, requests, calls, completed, config, review: await createStorageRecoveryReview(config) };
}

test("two stable real before observations reconcile once with independently captured times and a distinct receipt", async () => {
  const f = await fixture(), result = await f.review.reconcile(f.reference);
  assert.deepEqual(result, { status: "resolved", resolution: "automatically_reconciled_before", automatic_recovery: "resolved", ...f.reference,
    intent_id: f.descriptor.intent_id, source_receipt_id: f.source, base_version: 3, execution_permitted: false, receipt_id: f.receipt });
  assert.equal(f.calls.length, 1); assert.equal(f.requests.filter(p => p.endsWith("/file")).length, 2);
  const [input] = f.calls;
  assert.equal(input.credential_version, 4); assert.equal(input.source_receipt_id, f.source);
  assert.equal(input.first_observation.observed_at, new Date(f.completed[0]).toISOString());
  assert.equal(input.second_observation.observed_at, new Date(f.completed[1]).toISOString());
  assert.ok(Date.parse(input.first_observation.observed_at) < Date.parse(input.second_observation.observed_at));
  for (const observation of [input.first_observation, input.second_observation]) { assert.equal(Object.keys(observation).length, 12);assert.equal(observation.boundary_status,"qualified"); }
  assert.doesNotMatch(JSON.stringify(input), /confirmed|review_accept|access_token|credential_envelope|verified_proof/);
});

test("historical content fields are compared when present; absent optional fields do not invent a historical no-effect proof", async () => {
  for (const old of [undefined, {}, { size: "3" }, { sha256: hash }]) {
    const f = await fixture({ mutate: d => { d.attempt.content_before = old; } });
    assert.equal((await f.review.reconcile(f.reference)).resolution, "automatically_reconciled_before");
  }
  for (const old of [{ size: "9" }, { sha256: newHash }, { head_revision_id: "other" }]) {
    const f = await fixture({ mutate: d => { d.attempt.content_before = old; } });
    assert.equal((await f.review.reconcile(f.reference)).status, "inspection_required");
    assert.equal(f.calls[0].second_observation.observed_state, "changed");
  }
});

test("after is only observed; a stable changed target retains inspection with the fixed SQL diagnostic", async () => {
  const after = await fixture({ state: "after" });
  assert.equal((await after.review.reconcile(after.reference)).status, "after_observed");
  assert.equal(after.calls.length, 1);
  const changed = await fixture({ state: "changed" }), result = await changed.review.reconcile(changed.reference);
  assert.equal(result.status, "inspection_required");
  assert.deepEqual(result.diagnostic, { stage: "verification", reason: "CONTENT_MISMATCH",
    observed_at: changed.calls[0].second_observation.observed_at, automatic_next_action: "continue_object_recovery" });
  assert.equal("receipt_id" in result, false);
});

test("a change between GETs, unprovable identity or expiry cannot call the reconciliation RPC", async () => {
  for (const options of [{ changeBetween: true }, { file: { mimeType: FOLDER } },
    { scope: "https://www.googleapis.com/auth/drive.file" }, { expiresInMs: 59999 }]) {
    const f = await fixture(options);
    await assert.rejects(f.review.reconcile(f.reference)); assert.equal(f.calls.length, 0);
    if (options.expiresInMs) assert.equal(f.requests.length, 0);
  }
});

test("stable target rename, movement and trash are reported as boundary conflicts, never automatic before or after", async () => {
  for (const file of [{ parents:["other"] }, { name:"renamed.txt" }, { trashed:true }]) {
    const f=await fixture({file}),result=await f.review.reconcile(f.reference);
    assert.equal(result.status,"inspection_required");assert.equal(result.automatic_recovery,"current_state_conflict");
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].second_observation.observed_state,"changed");
    assert.equal(f.calls[0].second_observation.boundary_status,"identity_changed");
    assert.equal(f.requests.filter(p=>p.endsWith('/file')).length,2);
  }
});

test("automatic eligibility and original scope references are checked before any provider read", async () => {
  for (const mutate of [d => { delete d.conflict_reconcile; }, d => { d.conflict_reconcile.closed_version = 2; },
    d => { d.conflict_reconcile.source_receipt_id = randomUUID(); }, d => { d.attempt.parent_id = "other"; },
    d => { d.provider_before.destination_file_id = "other"; }, d => { d.mutation.operation = "rename"; },
    d => { d.mutation.destination_path = "/other/a.txt"; }, d => { d.mutation.target_kind = "directory"; }]) {
    const f = await fixture({ mutate }); await assert.rejects(f.review.reconcile(f.reference));
    assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
  }
});

test("unknown or mismatched reconciliation replies fail closed without a second RPC or native acceptance", async () => {
  for (const reply of [r => ({ ...r, job_id: randomUUID() }), r => ({ ...r, connection_id: randomUUID() }),
    r => ({ ...r, intent_id: randomUUID() }), r => ({ ...r, base_version: 4 }), r => ({ ...r, source_receipt_id: randomUUID() }),
    r => ({ ...r, execution_permitted: true }), r => ({ ...r, receipt_id: r.source_receipt_id }), r => ({ ...r, receipt_id: "bad" }),
    r => ({ ...r, resolution: "accepted_current_state" }), r => ({ ...r, status: "committed" }), r => ({ ...r, status: "after_observed" })]) {
    const f = await fixture({ reply }); await assert.rejects(f.review.reconcile(f.reference));
    assert.equal(f.calls.length, 1);
  }
  const changed = await fixture({ state: "changed", reply: r => ({ ...r, diagnostic: { ...r.diagnostic, reason: "private detail" } }) });
  await assert.rejects(changed.review.reconcile(changed.reference)); assert.equal(changed.calls.length, 1);
});

test("read authorization rejected by the database is never retried as an effect or Owner acceptance", async () => {
  const f = await fixture({ rpcError: true }); await assert.rejects(f.review.reconcile(f.reference), /private disabled policy/);
  assert.deepEqual(f.calls.map(c => c.action), ["reconcile_before"]);
});
