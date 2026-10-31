import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { googleDriveAccessDigest, googleDriveSharingDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";

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
const FLAGS = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_JOBS_V2: "true",
  CLUED_STORAGE_EXECUTOR_V1: "true", CLUED_STORAGE_CONNECTOR_ISSUER: "i".repeat(40), CLUED_STORAGE_GOOGLE_CLIENT_ID: CLIENT,
  SUPABASE_URL: "https://db.example.test", SUPABASE_PUBLISHABLE_KEY: "publishable" };

async function fixture({ drive = {}, token = {}, load = {}, directories, renewal = false, enabled = true } = {}) {
  const vaultConfig = { current_key_id: "k1", keys: { k1: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(vaultConfig);
  const owner = randomUUID(), connection = randomUUID(), artifact = randomUUID();
  const context = { owner_id: owner, connection_id: connection, provider: "google-drive", provider_subject: "subject",
    oauth_client_id: CLIENT, credential_version: 3 };
  let version=3;
  let envelope = await vault.seal(JSON.stringify({ access_token: "synthetic-private-access", refresh_token:'synthetic-private-refresh-token', token_type: "Bearer", scope: SCOPE,
    expires_at_ms: Date.now() + 3600000, ...token }), context);
  const calls = [], driveUrls = [];
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    if(url.origin==='https://oauth2.googleapis.com'){
      calls.push({action:'provider_token'});return Response.json({access_token:'synthetic-private-access',token_type:'Bearer',expires_in:3600});
    }
    if (url.origin === "https://www.googleapis.com") {
      driveUrls.push(url);
      if(renewal&&url.pathname.endsWith('/about'))return Response.json({user:{me:true,permissionId:'subject'}});
      if(renewal&&url.pathname.endsWith('/root'))return Response.json({id:'root',parents:['parent'],mimeType:'application/vnd.google-apps.folder',
        trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
      if (url.pathname.endsWith("/pfolder")) {
        if (drive.parent?.status) return new Response("{}", { status: drive.parent.status });
        const permissions = drive.parent?.permissions ?? PERMISSIONS;
        return Response.json(/shared/.test(url.searchParams.get("fields"))
          ? { id: "pfolder", shared: false, permissionIds: permissions.map(p => p.id) }
          : { id: "pfolder", version: "40", permissions });
      }
      if (drive.status) return new Response("{}", { status: drive.status });
      return Response.json({ id: "folder", version: "7", permissions: PERMISSIONS, ...drive.body });
    }
    assert.ok(['/rest/v1/rpc/clued_storage_access_digest_backfill_v1','/rest/v1/rpc/clued_storage_refresh_worker_v1'].includes(url.pathname));
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-worker-gateway');
    assert.equal(new Headers(init.headers).get('apikey'), FLAGS.SUPABASE_PUBLISHABLE_KEY);
    const body = JSON.parse(init.body);
    assert.match(body.p_issuer_hash, /^[0-9a-f]{64}$/);
    const input2 = body.p_input;
    calls.push(input2);
    if(url.pathname.endsWith('/clued_storage_refresh_worker_v1')){
      if(input2.action==='prepare_credential')return Response.json({contract:'clued.storage-demand-preflight/1',...context,
        credential_version:version,credential_envelope:envelope,provider_scope_profile:'legacy',delegation_version:1,
        renewal_enabled:enabled,refresh_state:'idle',proof:'clued_srp_'+'b'.repeat(64)});
      if(input2.action==='observe_credential')return Response.json({status:'current'});
      if(input2.action==='claim')return Response.json({...context,credential_version:version,credential_envelope:envelope,status:'acquired',
        attempt_id:input2.attempt_id,root_folder_id:'root',root_parent_id:'parent',expires_at:new Date(Date.now()+120000).toISOString()});
      if(input2.action==='commit'){version++;envelope=input2.credential_envelope;return Response.json({status:'committed'});}
      throw Error('unexpected refresh RPC');
    }
    if (input2.action === "due") return Response.json({ status: "ok",
      directories: directories ?? [{ connection_id: connection, artifact_id: artifact }] });
    if (input2.action === "load") return Response.json({ status: "read_only", owner_id: owner, connection_id: connection,
      artifact_id: artifact, provider: "google-drive", provider_subject: "subject", oauth_client_id: CLIENT, credential_version: version,
      credential_envelope: envelope, provider_file_id: "folder", registered_version: "7", row_version: 2,
      execution_permitted: false, ...load });
    if (input2.action === "commit") return Response.json({ status: "committed", artifact_id: artifact,
      outcome: input2.found && input2.observed_version === "7" && input2.access_digest ? "recorded"
        : input2.access_digest && input2.parent?.observed_access === input2.access_digest ? "recorded_inherited" : "missing:version_changed",
      execution_permitted: false });
    throw new Error("unexpected rpc");
  };
  const env = { ...FLAGS, CLUED_STORAGE_VAULT_KEYS: JSON.stringify(vaultConfig),...(renewal?{
    CLUED_STORAGE_REFRESH_V1:'true',CLUED_STORAGE_GOOGLE_CLIENT_SECRET:'synthetic-client-secret'}:{}) };
  return { env, fetch, calls, driveUrls, connection, artifact };
}

test("disabled without the storage flags, unavailable without the issuer, vault or client", async () => {
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled({}), { status: "disabled" });
  const f = await fixture();
  for (const missing of ["CLUED_DB_GATEWAY_TOKEN", "CLUED_STORAGE_CONNECTOR_ISSUER", "CLUED_STORAGE_VAULT_KEYS", "CLUED_STORAGE_GOOGLE_CLIENT_ID"])
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
    registered_version: "7", found: true, observed_version: "7", access_digest: googleDriveAccessDigest({ permissions: PERMISSIONS }) });
});

test("a changed version, a folder Drive no longer shows or no usable permission list commits as missing", async () => {
  for (const [drive, found, observed, digest] of [
    [{ body: { version: "8" } }, true, "8", googleDriveAccessDigest({ permissions: PERMISSIONS })],
    [{ status: 404 }, false, null, null],
    [{ body: { permissions: [] } }, true, "7", null],
  ]) {
    const f = await fixture({ drive });
    assert.deepEqual(await runStorageAccessDigestBackfillScheduled(f.env, { fetch: f.fetch }), { status: "ok", recorded: 0, missing: 1, skipped: 0 });
    const commit = f.calls.at(-1);
    assert.equal(commit.action, "commit");
    assert.equal(commit.found, found);
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

test("a transient, credential or foreign answer commits nothing", async () => {
  for (const drive of [{ status: 401 }, { status: 403 }, { status: 500 }, { body: { id: "another" } }, { body: { version: "x" } }]) {
    const f = await fixture({ drive });
    assert.deepEqual(await runStorageAccessDigestBackfillScheduled(f.env, { fetch: f.fetch }), { status: "ok", recorded: 0, missing: 0, skipped: 1 });
    assert.deepEqual(f.calls.map(call => call.action), ["due", "load"], JSON.stringify(drive));
  }
});

test('expired eligible maintenance renews once, reloads its artifact and reads it with the new version',async()=>{
  const f=await fixture({renewal:true,token:{expires_at_ms:Date.now()-1000}});
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(f.env,{fetch:f.fetch}),{status:'ok',recorded:1,missing:0,skipped:0});
  assert.equal(f.calls.filter(call=>call.action==='provider_token').length,1);
  const finalPrepare=f.calls.findLastIndex(call=>call.action==='prepare_credential');
  assert.ok(f.calls.findIndex(call=>call.action==='load')>finalPrepare,'operation reloads current artifact after renewal');
  assert.ok(f.calls.filter(call=>call.action==='prepare_credential').every(call=>call.request.artifact_id===f.artifact));
});

test('renewal off preserves valid maintenance use; an expired token never exchanges and empty due never creates a vault',async()=>{
  const valid=await fixture({renewal:true,enabled:false});
  assert.equal((await runStorageAccessDigestBackfillScheduled(valid.env,{fetch:valid.fetch})).recorded,1);
  assert.equal(valid.calls.some(call=>call.action==='claim'||call.action==='provider_token'),false);
  const expired=await fixture({renewal:true,enabled:false,token:{expires_at_ms:Date.now()-1000}});
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(expired.env,{fetch:expired.fetch}),{status:'ok',recorded:0,missing:0,skipped:1});
  assert.equal(expired.driveUrls.length,0);assert.equal(expired.calls.some(call=>call.action==='claim'),false);
  const empty=await fixture({renewal:true,directories:[]});
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled({...empty.env,CLUED_STORAGE_VAULT_KEYS:'invalid'},
    {fetch:empty.fetch}),{status:'ok',recorded:0,missing:0,skipped:0});
  assert.deepEqual(empty.calls.map(call=>call.action),['due']);
});

// Bug 38bb5ddf (Decision 24422a98): version drift alone is settled against the
// registered parent, as Drive inherits permissions; a real difference is not.
const PARENT = (mode = "access") => ({ artifact_id: randomUUID(), provider_file_id: "pfolder", row_version: 5, mode });
test("a moved version is compared with the registered parent read in the same run", async () => {
  for (const mode of ["access", "sharing"]) {
    const parent = PARENT(mode);
    const f = await fixture({ drive: { body: { version: "9" } }, load: { parent } });
    assert.deepEqual(await runStorageAccessDigestBackfillScheduled(f.env, { fetch: f.fetch }), { status: "ok", recorded: 1, missing: 0, skipped: 0 });
    const commit = f.calls.at(-1), access = googleDriveAccessDigest({ permissions: PERMISSIONS });
    assert.deepEqual(commit.parent, { artifact_id: parent.artifact_id, row_version: 5,
      observed_digest: mode === "access" ? access : googleDriveSharingDigest({ shared: false, permissionIds: ["owner"] }), observed_access: access });
    assert.equal(f.driveUrls.filter(u => u.pathname.endsWith("/pfolder")).length, mode === "access" ? 1 : 2);
  }
});
test("a folder shared beyond its parent still commits as missing; the parent is read only when the version moved", async () => {
  const wider = await fixture({ drive: { body: { version: "9", permissions: [...PERMISSIONS, { id: "anyone", type: "anyone", role: "reader" }] } },
    load: { parent: PARENT() } });
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(wider.env, { fetch: wider.fetch }), { status: "ok", recorded: 0, missing: 1, skipped: 0 });
  assert.notEqual(wider.calls.at(-1).parent.observed_access, wider.calls.at(-1).access_digest);
  const same = await fixture({ load: { parent: PARENT() } });
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(same.env, { fetch: same.fetch }), { status: "ok", recorded: 1, missing: 0, skipped: 0 });
  assert.equal(same.driveUrls.length, 1); assert.equal("parent" in same.calls.at(-1), false);
  // No parent baseline: commits without one, and the database retries later.
  const orphan = await fixture({ drive: { body: { version: "9" } }, load: { parent: null } });
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(orphan.env, { fetch: orphan.fetch }), { status: "ok", recorded: 0, missing: 1, skipped: 0 });
  assert.equal("parent" in orphan.calls.at(-1), false);
});
test("a parent read that fails transiently commits nothing; a malformed parent descriptor reads nothing", async () => {
  const f = await fixture({ drive: { body: { version: "9" }, parent: { status: 503 } }, load: { parent: PARENT() } });
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(f.env, { fetch: f.fetch }), { status: "ok", recorded: 0, missing: 0, skipped: 1 });
  assert.deepEqual(f.calls.map(c => c.action), ["due", "load"]);
  const gone = await fixture({ drive: { body: { version: "9" }, parent: { status: 404 } }, load: { parent: PARENT() } });
  assert.deepEqual(await runStorageAccessDigestBackfillScheduled(gone.env, { fetch: gone.fetch }), { status: "ok", recorded: 0, missing: 1, skipped: 0 });
  assert.equal("parent" in gone.calls.at(-1), false);
  for (const parent of [{ ...PARENT(), extra: 1 }, { ...PARENT(), mode: "version" }, { ...PARENT(), provider_file_id: "bad id" }]) {
    const bad = await fixture({ load: { parent } });
    assert.deepEqual(await runStorageAccessDigestBackfillScheduled(bad.env, { fetch: bad.fetch }), { status: "ok", recorded: 0, missing: 0, skipped: 1 });
    assert.equal(bad.driveUrls.length, 0);
  }
});
