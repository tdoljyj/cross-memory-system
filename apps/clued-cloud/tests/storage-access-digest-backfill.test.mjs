import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { googleDriveAccessDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";

// Storage step 2 (Task e2eb07d1): the scheduled access digest backfill.
const dir = await mkdtemp(path.join(os.tmpdir(), "clued-access-digest-backfill-"));
async function load(name) {
  const outfile = path.join(dir, name + ".mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../worker/" + name + ".ts", import.meta.url))], outfile, bundle: true,
    platform: "node", format: "esm" });
  return import(pathToFileURL(outfile));
}
const { runStorageAccessDigestBackfillScheduled } = await load("storage-access-digest-backfill");
const { createStorageCredentialVault } = await load("storage-credential-vault");

const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const CLIENT = "backfill.apps.googleusercontent.com";
const PERMISSIONS = [{ id: "owner", type: "user", role: "owner" }];
const FLAGS = { CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_JOBS_V2: "true",
  CLUED_STORAGE_EXECUTOR_V1: "true", CLUED_STORAGE_CONNECTOR_ISSUER: "i".repeat(40), CLUED_STORAGE_GOOGLE_CLIENT_ID: CLIENT,
  SUPABASE_URL: "https://db.example.test", SUPABASE_PUBLISHABLE_KEY: "publishable" };

async function fixture({ drive = {}, token = {}, load = {}, directories } = {}) {
  const vaultConfig = { current_key_id: "k1", keys: { k1: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(vaultConfig);
  const owner = randomUUID(), connection = randomUUID(), artifact = randomUUID();
  const context = { owner_id: owner, connection_id: connection, provider: "google-drive", provider_subject: "subject",
    oauth_client_id: CLIENT, credential_version: 3 };
  const envelope = await vault.seal(JSON.stringify({ access_token: "synthetic-private-access", token_type: "Bearer", scope: SCOPE,
    expires_at_ms: Date.now() + 3600000, ...token }), context);
  const calls = [], driveUrls = [];
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://www.googleapis.com") {
      driveUrls.push(url);
      if (drive.fail) return new Response("{}", { status: 403 });
      return Response.json({ id: "folder", version: "7", permissions: PERMISSIONS, ...drive.body });
    }
    assert.equal(url.pathname, "/rest/v1/rpc/clued_storage_access_digest_backfill_v1");
    const body = JSON.parse(init.body);
    assert.match(body.p_issuer_hash, /^[0-9a-f]{64}$/);
    const input2 = body.p_input;
    calls.push(input2);
    if (input2.action === "due") return Response.json({ status: "ok",
      directories: directories ?? [{ connection_id: connection, artifact_id: artifact }] });
    if (input2.action === "load") return Response.json({ status: "read_only", owner_id: owner, connection_id: connection,
      artifact_id: artifact, provider: "google-drive", provider_subject: "subject", oauth_client_id: CLIENT, credential_version: 3,
      credential_envelope: envelope, provider_file_id: "folder", registered_version: "7", row_version: 2,
      execution_permitted: false, ...load });
    if (input2.action === "commit") return Response.json({ status: "committed", artifact_id: artifact,
      outcome: input2.observed_version === "7" && input2.access_digest ? "recorded" : "missing", execution_permitted: false });
    throw new Error("unexpected rpc");
  };
  const env = { ...FLAGS, CLUED_STORAGE_VAULT_KEYS: JSON.stringify(vaultConfig) };
  return { env, fetch, calls, driveUrls, connection, artifact };
}

test("disabled without the storage flags, unavailable without the issuer, vault or client", async () => {
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled({}), { status: "disabled" });
  const f = await fixture();
  for (const missing of ["CLUED_STORAGE_CONNECTOR_ISSUER", "CLUED_STORAGE_VAULT_KEYS", "CLUED_STORAGE_GOOGLE_CLIENT_ID"])
    assert.deepEqual(await runStorageAccessDigestBackfillScheduled({ ...f.env, [missing]: "" }, { fetch: f.fetch }), { status: "unavailable" });
});

test("a directory at its registered version gets the digest from one Drive read", async () => {
  const f = await fixture();
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(f.env, { fetch: f.fetch }), { status: "ok", recorded: 1, missing: 0, skipped: 0 });
  assert.equal(f.driveUrls.length, 1);
  assert.equal(f.driveUrls[0].pathname, "/drive/v3/files/folder");
  assert.equal(f.driveUrls[0].searchParams.get("fields"),
    "id,version,permissions(id,type,role,domain,allowFileDiscovery,expirationTime,deleted)");
  assert.deepEqual(f.calls.map(call => call.action), ["due", "load", "commit"]);
  assert.deepEqual(f.calls[2], { action: "commit", connection_id: f.connection, artifact_id: f.artifact, row_version: 2,
    registered_version: "7", observed_version: "7", access_digest: googleDriveAccessDigest({ permissions: PERMISSIONS }) });
});

test("a changed version, a failed read or no usable permission list commits as missing", async () => {
  for (const [drive, observed, digest] of [
    [{ body: { version: "8" } }, "8", googleDriveAccessDigest({ permissions: PERMISSIONS })],
    [{ fail: true }, null, null],
    [{ body: { permissions: [] } }, "7", null],
    [{ body: { id: "another" } }, null, null],
  ]) {
    const f = await fixture({ drive });
    assert.deepEqual(await runStorageAccessDigestBackfillScheduled(f.env, { fetch: f.fetch }), { status: "ok", recorded: 0, missing: 1, skipped: 0 });
    const commit = f.calls.at(-1);
    assert.equal(commit.action, "commit");
    assert.equal(commit.observed_version, observed);
    assert.equal(commit.access_digest, digest);
  }
});

test("an expiring credential, an unexpected descriptor or a malformed listing reads nothing", async () => {
  const expiring = await fixture({ token: { expires_at_ms: Date.now() + 30000 } });
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(expiring.env, { fetch: expiring.fetch }), { status: "ok", recorded: 0, missing: 0, skipped: 1 });
  assert.equal(expiring.driveUrls.length, 0);
  assert.deepEqual(expiring.calls.map(call => call.action), ["due", "load"]);
  for (const load of [{ oauth_client_id: "other.apps.googleusercontent.com" }, { execution_permitted: true }, { provider_file_id: "bad id" }]) {
    const f = await fixture({ load });
    assert.deepEqual(await runStorageAccessDigestBackfillScheduled(f.env, { fetch: f.fetch }), { status: "ok", recorded: 0, missing: 0, skipped: 1 });
    assert.equal(f.driveUrls.length, 0);
  }
  const malformed = await fixture({ directories: [{ connection_id: "x", artifact_id: "y" }] });
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(malformed.env, { fetch: malformed.fetch }), { status: "unavailable" });
  const none = await fixture({ directories: [] });
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(none.env, { fetch: none.fetch }), { status: "ok", recorded: 0, missing: 0, skipped: 0 });
});
