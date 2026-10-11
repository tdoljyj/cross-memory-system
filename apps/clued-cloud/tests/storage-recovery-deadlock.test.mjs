import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build, stop } from "esbuild";
import { createGoogleDriveCreateAbsenceProbe, CREATE_ABSENT_CONTRACT } from "../../../kernel/host/resource-center-google-drive-absence.mjs";

// BUG-20261007-005: a create whose effect never reached Drive is settled as not
// effected, and an expiring credential is reported before any Drive read.
// Synthetic Drive and RPC only: no database, Google or disk.
const dir = await mkdtemp(path.join(os.tmpdir(), "clued-recovery-deadlock-"));
async function load(name) {
  const outfile = path.join(dir, name + ".mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../worker/" + name + ".ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(outfile));
}
const { createStorageCloudRecovery } = await load("storage-cloud-recovery");
const { createStorageCredentialVault } = await load("storage-credential-vault");
stop();

const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const FILE = "generatedFile0001", PARENT = "trackFolder00001", INTENT = randomUUID();

function drive(options = {}) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    requests.push({ path: u.pathname, q: u.searchParams.get("q"), method: init.method });
    assert.equal(init.method, "GET");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-access-token-0001");
    if (options.fail) throw new Error("private transport detail");
    if (u.pathname === `/drive/v3/files/${FILE}`) {
      if (options.byIdStatus) return new Response("{}", { status: options.byIdStatus });
      return options.exists ? Response.json({ id: FILE }) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    if (u.pathname === "/drive/v3/files" && u.searchParams.get("q")?.startsWith("appProperties has")) {
      if (options.searchStatus) return new Response("{}", { status: options.searchStatus });
      return Response.json({ files: options.tagged ? [{ id: "elsewhere0000001" }] : [], ...(options.nextPage ? { nextPageToken: "more" } : {}) });
    }
    // BUG-20261008-002: the registered folders exist and are unchanged, so the verifier
    // finds them and keeps polling for the missing file instead of failing at once.
    if (options.folders && u.pathname === "/drive/v3/files/rootFolder000001") return Response.json(ROOT_FOLDER);
    if (options.folders && u.pathname === "/drive/v3/files" && u.searchParams.get("q")?.includes("name = '20_P'"))
      return Response.json({ files: [TRACK_FOLDER] });
    if (u.pathname === "/drive/v3/files") return Response.json({ files: [] });
    return Response.json({ error: { code: 404 } }, { status: 404 });
  };
  return { fetch, requests };
}
const FOLDER = "application/vnd.google-apps.folder";
const ROOT_FOLDER = { id: "rootFolder000001", name: "Clued_资料中心", parents: ["myDrive000000001"], trashed: false, version: "5", mimeType: FOLDER };
const TRACK_FOLDER = { id: PARENT, name: "20_P", parents: ["rootFolder000001"], trashed: false, version: "7", mimeType: FOLDER };
const credential = (scope = SCOPE) => async () => ({ access_token: "fixture-access-token-0001", scope });
const target = { provider_file_id: FILE, parent_id: PARENT, intent_id: INTENT };

test("the absence probe proves absence only from a 404 by ID and an empty tag search", async () => {
  const d = drive();
  const proof = await createGoogleDriveCreateAbsenceProbe({ get_credential: credential(), fetch: d.fetch })(target);
  assert.deepEqual(proof, { contract: CREATE_ABSENT_CONTRACT, ...target });
  assert.deepEqual(d.requests.map(r => r.path), [`/drive/v3/files/${FILE}`, "/drive/v3/files"]);
  assert.equal(d.requests[1].q, `appProperties has { key='clued_intent_id' and value='${INTENT}' }`);
});

test("a present or tagged file is not absent; errors and partial pages are not proofs", async () => {
  for (const options of [{ exists: true }, { tagged: true }]) {
    assert.equal(await createGoogleDriveCreateAbsenceProbe({ get_credential: credential(), fetch: drive(options).fetch })(target), null);
  }
  for (const options of [{ byIdStatus: 403 }, { byIdStatus: 500 }, { searchStatus: 500 }, { nextPage: true }, { fail: true }]) {
    await assert.rejects(createGoogleDriveCreateAbsenceProbe({ get_credential: credential(), fetch: drive(options).fetch })(target),
      /DRIVE_ABSENCE_(UNPROVEN|REQUEST_FAILED)/);
  }
  // Without namespace visibility (drive.file alone) absence is never proven.
  await assert.rejects(createGoogleDriveCreateAbsenceProbe({ get_credential: credential("https://www.googleapis.com/auth/drive.file"),
    fetch: drive().fetch })(target), /DRIVE_NAMESPACE_VISIBILITY_UNPROVEN/);
  for (const bad of [{ ...target, provider_file_id: "../x" }, { ...target, intent_id: "x' or '1'='1" }, { ...target, parent_id: "" }]) {
    await assert.rejects(createGoogleDriveCreateAbsenceProbe({ get_credential: credential(), fetch: drive().fetch })(bad), TypeError);
  }
});

async function recovery(options = {}) {
  const vaultConfig = { current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(vaultConfig);
  const now = Date.parse("2026-10-07T12:00:00Z");
  const reference = { connection_id: randomUUID(), job_id: randomUUID() };
  const owner = randomUUID(), operation = options.operation ?? "create";
  const descriptor = {
    status: "recovery_only", ...reference, owner_id: owner, intent_id: INTENT, provider: "google-drive",
    oauth_client_id: "fixture-client", provider_subject: "subject-1", credential_version: 4, version: 2,
    request_sha256: "a".repeat(64), root_folder_id: "rootFolder000001", root_parent_id: "myDrive000000001",
    profile: { managed_root: "G:/My Drive/Clued_资料中心" },
    mutation: operation === "create"
      ? { operation, target_kind: "file", destination_path: "G:/My Drive/Clued_资料中心/20_P/evidence.zip" }
      : { operation, target_kind: "file", source_path: "G:/My Drive/Clued_资料中心/20_P/a.md", destination_path: "G:/My Drive/Clued_资料中心/20_P/b.md" },
    provider_before: options.folders ? { root_folder_id: "rootFolder000001", root_parent_id: "myDrive000000001", root_folder_version: "5",
      destination_parent_id: PARENT, destination_parent_version: "7", destination_file_id: null, destination_file_version: null,
      provider_version: createHash("sha256").update(JSON.stringify([["rootFolder000001", "5"], [PARENT, "7"]])).digest("hex") }
      : { destination_parent_id: PARENT },
    attempt: { provider_file_id: FILE, parent_id: PARENT, intent_id: INTENT,
      destination_path: operation === "create" ? "G:/My Drive/Clued_资料中心/20_P/evidence.zip" : "G:/My Drive/Clued_资料中心/20_P/b.md",
      ...(operation === "create" ? {} : { contract: "clued.storage-modify-attempt/1", operation, source_path: "G:/My Drive/Clued_资料中心/20_P/a.md" }) },
  };
  descriptor.credential_envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "fixture-access-token-0001",
    scope: SCOPE, expires_at_ms: now + (options.expiresInMs ?? 3600000) }), { owner_id: owner, connection_id: reference.connection_id,
    provider: "google-drive", provider_subject: "subject-1", oauth_client_id: "fixture-client", credential_version: 4 });
  const d = drive({ ...options.drive, ...(options.folders ? { folders: true } : {}) }), settles = [], verifiedCalls = [];
  const run = await createStorageCloudRecovery({
    client_id: "fixture-client", vault: vaultConfig, clock: () => now, fetch: d.fetch, timeout_ms: 2000,
    rpc: async () => assert.fail("scheduled recovery passes its descriptor; no load RPC"),
    verified: { descriptor, rpc: async input => { verifiedCalls.push(input); assert.fail("nothing is verified when the file is missing"); } },
    ...(options.noAbsent ? {} : { absent: { rpc: async input => {
      settles.push(structuredClone(input));
      if (options.settleError) throw new Error("private database detail");
      return { status: "committed", state: "cancelled", replayed: false, ...reference, intent_id: INTENT,
        receipt_id: options.receipt ?? randomUUID(), execution_permitted: false, ...options.settled };
    } } }),
    ...(options.reportExpiring ? { report_expiring: true } : {}),
  });
  return { run, reference, d, settles, verifiedCalls };
}

test("a create proven absent is settled once through the absence RPC with the exact proof", async () => {
  const receipt = randomUUID();
  const f = await recovery({ receipt });
  assert.deepEqual(await f.run.run(f.reference),
    { status: "released_not_effected", job_id: f.reference.job_id, receipt_id: receipt, execution_permitted: false });
  assert.deepEqual(f.settles, [{ action: "settle_absent", ...f.reference, intent_id: INTENT, base_version: 2,
    request_sha256: "a".repeat(64), proof: { contract: CREATE_ABSENT_CONTRACT, ...target } }]);
  assert.equal(f.d.requests.every(r => r.method === "GET"), true);
});

test("a missing create under unchanged registered folders is still settled as absent (BUG-20261008-002)", async () => {
  // The verifier polls for the file for half the budget only, leaving the rest for the
  // absence probe and its settlement; polling the whole budget left the job started.
  const receipt = randomUUID();
  const f = await recovery({ receipt, folders: true });
  assert.deepEqual(await f.run.run(f.reference),
    { status: "released_not_effected", job_id: f.reference.job_id, receipt_id: receipt, execution_permitted: false });
  assert.equal(f.settles.length, 1);
  assert.equal(f.d.requests.filter(r => r.q?.includes("name = 'evidence.zip'")).length >= 1, true, "the verifier looked for the file first");
  assert.equal(f.d.requests.some(r => r.q?.startsWith("appProperties has")), true);
});

test("present, tagged or unreadable effects, other operations and bad replies are never settled as absent", async () => {
  for (const drive of [{ exists: true }, { tagged: true }, { byIdStatus: 500 }, { nextPage: true }]) {
    const f = await recovery({ drive });
    assert.deepEqual(await f.run.run(f.reference), { status: "inspection_required", execution_permitted: false });
    assert.equal(f.settles.length, 0);
  }
  const rename = await recovery({ operation: "rename" });
  assert.deepEqual(await rename.run.run(rename.reference), { status: "inspection_required", execution_permitted: false });
  assert.equal(rename.settles.length, 0);
  assert.equal(rename.d.requests.some(r => r.q?.startsWith("appProperties has")), false);
  const without = await recovery({ noAbsent: true });
  assert.deepEqual(await without.run.run(without.reference), { status: "inspection_required", execution_permitted: false });
  for (const options of [{ settleError: true }, { settled: { state: "committed" } }, { settled: { execution_permitted: true } },
    { settled: { intent_id: randomUUID() } }, { settled: { receipt_id: "not-a-uuid" } }]) {
    const f = await recovery(options);
    assert.deepEqual(await f.run.run(f.reference), { status: "inspection_required", execution_permitted: false });
    assert.equal(f.settles.length, 1, "an unknown settlement is never repeated");
  }
});

test("an expiring credential is reported before any Drive read only when asked", async () => {
  const reported = await recovery({ expiresInMs: 1000, reportExpiring: true });
  assert.deepEqual(await reported.run.run(reported.reference), { status: "credential_expiring", execution_permitted: false });
  assert.equal(reported.d.requests.length, 0); assert.equal(reported.settles.length, 0);
  const silent = await recovery({ expiresInMs: 1000 });
  assert.deepEqual(await silent.run.run(silent.reference), { status: "inspection_required", execution_permitted: false });
  assert.equal(silent.d.requests.length, 0); assert.equal(silent.settles.length, 0);
});

test("an absence settlement requires a verified (account-policy) recovery", async () => {
  await assert.rejects(createStorageCloudRecovery({ client_id: "fixture-client",
    vault: { current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } },
    rpc: async () => ({}), absent: { rpc: async () => ({}) } }), /storage_recovery_unavailable/);
});
