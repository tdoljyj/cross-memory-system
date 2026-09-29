import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
import { createStorageCredentialVault } from "../worker/storage-credential-vault.ts";

// StorageFullCapability.v0.1 P1 read tool over the real continuity handler.
// Synthetic RPC and an in-memory Drive only: no database, Google or disk.
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid";
const token = "clued_bnd_" + "r".repeat(40);
const sha = value => createHash("sha256").update(value).digest("hex");
const vaultKeys = { current_key_id: "test", keys: { test: btoa("v".repeat(32)).replace(/=+$/, "") } };
const OWNER = "10000000-0000-4000-8000-0000000000a1", CONNECTION = "20000000-0000-4000-8000-0000000000a1";
const ROOT = "rootFolderId0001", OUTSIDE = "outsideFolder0001", MYDRIVE = "myDriveRoot00001";
const FOLDER = "application/vnd.google-apps.folder";
const env = {
  CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_READ_V1: "true",
  CLUED_STORAGE_CONNECTOR_ISSUER: "i".repeat(40), CLUED_STORAGE_VAULT_KEYS: JSON.stringify(vaultKeys),
  CLUED_STORAGE_GOOGLE_CLIENT_ID: "read-client", CLUED_STORAGE_READ_CURSOR_KEY: btoa("c".repeat(32)),
  CLUED_STORAGE_READ_RECEIPT_KEYS: JSON.stringify({ current: "k1", keys: { k1: btoa("h".repeat(32)) } }),
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
};
const vault = await createStorageCredentialVault(vaultKeys);
const context = { owner_id: OWNER, connection_id: CONNECTION, provider: "google-drive", provider_subject: "subject-1", oauth_client_id: "read-client", credential_version: 3 };
const envelope = async (overrides = {}) => vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "fixture-read-access-token",
  scope: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.file", expires_at_ms: Date.now() + 3600000, ...overrides }), context);

function tree() {
  const files = new Map();
  const add = (id, name, parents, mimeType = "text/plain") => files.set(id, { id, name, mimeType, parents, version: "1", trashed: false, size: "10" });
  add(MYDRIVE, "My Drive", [], FOLDER);
  add(ROOT, "Clued_资料中心", [MYDRIVE], FOLDER);
  add(OUTSIDE, "Elsewhere", [MYDRIVE], FOLDER);
  add("trackFolder00001", "20_P_产品与体验", [ROOT], FOLDER);
  add("planAFile0000001", "Plan A.md", ["trackFolder00001"], "text/markdown");
  add("subFolder0000001", "sub", ["trackFolder00001"], FOLDER);
  add("planBFile0000001", "plan b.txt", ["subFolder0000001"]);
  add("shortcut00000001", "link", ["trackFolder00001"], "application/vnd.google-apps.shortcut");
  add("multiParent00001", "plan shared", ["trackFolder00001", OUTSIDE]);
  add("readmeFile000001", "Readme.md", [ROOT], "text/markdown");
  add("secretPlan000001", "Plan secret", [OUTSIDE]);
  return { files, add };
}

// Fake Supabase RPC + Drive batch endpoint. Records every call for assertions.
function harness(options = {}) {
  const drive = options.drive ?? tree(), calls = [];
  const state = { calls, drive, googleRequests: 0, admitError: options.admitError };
  const reply = parts => {
    const boundary = "batch_" + randomUUID();
    const body = parts.map(({ id, status, json }) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\n` +
      `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Not Found"}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(json)}`).join("\r\n") + `\r\n--${boundary}--\r\n`;
    return new Response(body, { status: 200, headers: { "content-type": `multipart/mixed; boundary=${boundary}` } });
  };
  state.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === env.SUPABASE_URL) {
      assert.equal(u.pathname, "/rest/v1/rpc/clued_storage_read_v1");
      const body = JSON.parse(init.body);
      calls.push(body);
      assert.equal(body.p_issuer_hash, sha(env.CLUED_STORAGE_CONNECTOR_ISSUER));
      assert.equal(body.p_token_hash, sha(token));
      if (body.p_input.action === "admit") {
        if (state.admitError) return new Response(JSON.stringify({ message: "storage_read_denied" }), { status: 403 });
        return Response.json({ contract: "clued.storage-read-admission/1", receipt_id: randomUUID(), class: "read", owner_id: OWNER,
          connection_id: body.p_input.connection_id, provider: "google-drive", provider_subject: "subject-1", oauth_client_id: "read-client",
          credential_version: 3, credential_envelope: options.envelope ?? await envelope(), root_folder_id: ROOT, read_generation: options.generation ?? 1 });
      }
      return Response.json({ receipt_id: body.p_input.receipt_id, state: "finalized", replayed: false });
    }
    state.googleRequests++;
    assert.equal(String(url), "https://www.googleapis.com/batch/drive/v3");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-read-access-token");
    const parts = [...String(init.body).matchAll(/Content-ID: <([^>]+)>\r\n\r\nGET ([^ ]+) HTTP/g)].map(([, id, path]) => {
      const request = new URL("https://www.googleapis.com" + path);
      assert.equal(request.searchParams.has("alt"), false, "metadata only, never file bodies");
      const q = request.searchParams.get("q");
      if (q) {
        const parent = /^'([^']+)' in parents and trashed = false$/.exec(q)[1];
        return { id, status: 200, json: { files: [...drive.files.values()].filter(f => f.parents.includes(parent) && !f.trashed) } };
      }
      const found = drive.files.get(request.pathname.split("/").at(-1));
      return found ? { id, status: 200, json: found } : { id, status: 404, json: { error: { code: 404 } } };
    });
    return reply(parts);
  };
  return state;
}
async function browse(args, options = {}, config = env, bearer = token) {
  const h = options.harness ?? harness(options), before = globalThis.fetch;
  globalThis.fetch = h.fetch;
  try {
    const response = await worker.fetch(new Request(origin + "/mcp", { method: "POST",
      headers: { "content-type": "application/json", origin, ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clued_storage_browse", arguments: { connection_id: CONNECTION, ...args } } }) }), config);
    if (response.status !== 200) return { status: response.status, h };
    const reply = await response.json();
    return { h, isError: reply.result.isError, value: reply.result.structuredContent, cache: response.headers.get("cache-control") };
  } finally { globalThis.fetch = before; }
}
const names = value => value.items.map(item => item.name);

test("discovery needs account, Google and read flags; the write tools are unaffected", async () => {
  const list = async flags => (await (await worker.fetch(new Request(origin + "/mcp", { method: "POST",
    headers: { "content-type": "application/json", origin, authorization: "Bearer " + token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }), flags)).json()).result.tools.map(t => t.name).filter(n => n.startsWith("clued_storage_"));
  for (const flags of [{}, { ...env, CLUED_STORAGE_READ_V1: "false" }, { ...env, CLUED_STORAGE_GOOGLE_V1: "false" }, { ...env, CLUED_STORAGE_ACCOUNT_V1: "false" }]) {
    assert.deepEqual(await list(flags), []);
    assert.equal((await browse({ operation: "list" }, {}, flags)).status, 404);
  }
  assert.deepEqual(await list(env), ["clued_storage_browse"]);
  assert.deepEqual(await list({ ...env, CLUED_STORAGE_JOBS_V1: "true" }), ["clued_storage_submit", "clued_storage_inspect", "clued_storage_browse"]);
});

test("invalid input, caller authority and missing Binding fail before any RPC or Google request", async () => {
  for (const args of [{ operation: "read", object_id: "planAFile0000001" }, { operation: "delete" }, { operation: "list", owner_id: OWNER },
    { operation: "list", root_folder_id: ROOT }, { operation: "stat" }, { operation: "stat", object_id: "../etc" },
    { operation: "search" }, { operation: "search", name_contains: "" }, { operation: "resolve" }, { operation: "list", class: "read_content" },
    { operation: "list", folder_id: ROOT, name_contains: "x" }]) {
    const { h, isError, value } = await browse(args);
    assert.equal(isError, true, JSON.stringify(args)); assert.equal(value.error, "storage_read_input_invalid");
    assert.equal(h.calls.length, 0); assert.equal(h.googleRequests, 0);
  }
  for (const bearer of ["", "native-jwt", "clued_bnd_short"]) {
    const { h, isError, value } = await browse({ operation: "list" }, {}, env, bearer);
    assert.equal(isError, true); assert.equal(value.error, "storage_read_unavailable"); assert.equal(h.calls.length, 0);
  }
  const { h, isError, value } = await browse({ operation: "list" }, { admitError: true });
  assert.equal(isError, true); assert.equal(value.error, "storage_read_unavailable"); assert.equal(h.googleRequests, 0);
});

test("list returns in-root children by name, excludes a multi-parent object with an outside chain, and finalizes the receipt", async () => {
  const root = await browse({ operation: "list" });
  assert.equal(root.isError, false); assert.equal(root.cache, "no-store");
  assert.deepEqual(names(root.value), ["20_P_产品与体验", "Readme.md"]);
  assert.equal(root.value.complete, true); assert.equal(root.value.next_cursor, null);
  const [admit, finalize] = root.h.calls.map(c => c.p_input);
  assert.deepEqual(admit, { action: "admit", connection_id: CONNECTION, operation: "list" });
  assert.equal(finalize.action, "finalize"); assert.equal(finalize.item_count, 2); assert.equal(finalize.complete, true);
  const track = await browse({ operation: "list", folder_id: "trackFolder00001" });
  assert.deepEqual(names(track.value), ["link", "Plan A.md", "sub"]);
  assert.equal(track.value.items.find(i => i.name === "link").kind, "shortcut");
  assert.equal(track.h.calls[0].p_input.object_id, "trackFolder00001");
  for (const folder_id of [OUTSIDE, "planAFile0000001", "doesNotExist0001"]) {
    const denied = await browse({ operation: "list", folder_id });
    assert.equal(denied.value.error, "not_found_in_scope", folder_id);
    const fin = denied.h.calls.at(-1).p_input;
    assert.equal(fin.action, "finalize"); assert.equal(fin.item_count, 0); assert.equal(fin.complete, false);
  }
});

test("stat and resolve decide scope by provider-ID chains, never by names", async () => {
  assert.equal((await browse({ operation: "stat", object_id: "planBFile0000001" })).value.item.name, "plan b.txt");
  assert.equal((await browse({ operation: "stat", object_id: ROOT })).value.item.id, ROOT);
  for (const object_id of ["secretPlan000001", OUTSIDE, "multiParent00001", MYDRIVE, "missingObject001"]) {
    const denied = await browse({ operation: "stat", object_id });
    assert.equal(denied.value.error, "not_found_in_scope", object_id);
  }
  const link = await browse({ operation: "resolve", reference: "https://drive.google.com/file/d/planAFile0000001/view?usp=sharing" });
  assert.deepEqual(link.value.matches.map(m => m.id), ["planAFile0000001"]);
  assert.equal((await browse({ operation: "resolve", reference: "https://drive.google.com/drive/folders/secretPlan000001" })).value.error, "not_found_in_scope");
  const path = await browse({ operation: "resolve", reference: "20_P_产品与体验/sub/plan b.txt" });
  assert.deepEqual(path.value.matches.map(m => m.id), ["planBFile0000001"]); assert.equal(path.value.ambiguous, undefined);
  assert.equal((await browse({ operation: "resolve", reference: "20_P_产品与体验/nothing" })).value.error, "not_found_in_scope");
  assert.equal((await browse({ operation: "resolve", reference: "20_P_产品与体验/../x" })).value.error, "storage_read_input_invalid");
  const drive = tree(); drive.add("dupA000000000001", "Twin", [ROOT]); drive.add("dupB000000000001", "Twin", [ROOT]);
  const twin = await browse({ operation: "resolve", reference: "Twin" }, { drive });
  assert.equal(twin.value.ambiguous, true); assert.deepEqual(twin.value.matches.map(m => m.id), ["dupA000000000001", "dupB000000000001"]);
  const hmac = link.h.calls[0].p_input;
  assert.match(hmac.condition_hmac, /^[0-9a-f]{64}$/); assert.equal(hmac.key_id, "k1");
  assert.equal(JSON.stringify(link.h.calls).includes("planAFile0000001/view"), false, "the raw reference never reaches Canonical");
});

test("search stays inside the root subtree and reports no filtered counts", async () => {
  const found = await browse({ operation: "search", name_contains: "PLAN" });
  assert.deepEqual(names(found.value), ["Plan A.md", "plan b.txt"]);
  assert.equal(found.value.complete, true); assert.equal(found.value.next_cursor, null);
  assert.deepEqual(Object.keys(found.value).sort(), ["complete", "items", "next_cursor"]);
  assert.equal(JSON.stringify(found.h.calls).includes("PLAN"), false, "search terms are HMAC-only in receipts");
  const within = await browse({ operation: "search", name_contains: "plan", within: "subFolder0000001" });
  assert.deepEqual(names(within.value), ["plan b.txt"]);
  assert.equal((await browse({ operation: "search", name_contains: "plan", within: OUTSIDE })).value.error, "not_found_in_scope");
  const md = await browse({ operation: "search", mime_type: "text/markdown" });
  assert.deepEqual(names(md.value), ["Plan A.md", "Readme.md"]);
});

test("cursors are sealed, bound and re-checked: tampering, cross-binding and moved folders fail closed", async () => {
  const drive = tree();
  drive.add("bigFolder0000001", "big", [ROOT], FOLDER);
  for (let i = 0; i < 230; i++) drive.add(`bigFile${String(i).padStart(9, "0")}`, `plan ${String(i).padStart(3, "0")}`, ["bigFolder0000001"]);
  drive.add("deepFolder000001", "deep", ["bigFolder0000001"], FOLDER);
  drive.add("deepPlan00000001", "plan zz deep", ["deepFolder000001"]);
  const h = harness({ drive });
  const first = await browse({ operation: "list", folder_id: "bigFolder0000001" }, { harness: h });
  assert.equal(first.value.items.length, 200); assert.equal(first.value.complete, false);
  const second = await browse({ operation: "list", folder_id: "bigFolder0000001", cursor: first.value.next_cursor }, { harness: h });
  assert.equal(second.value.items.length, 31); assert.equal(second.value.complete, true);
  const [nonce, body] = first.value.next_cursor.split(".");
  const flipped = body.slice(0, -2) + (body.at(-2) === "A" ? "B" : "A") + body.at(-1);
  for (const cursor of [nonce + "." + flipped, "x.y", "not-a-cursor"]) {
    assert.equal((await browse({ operation: "list", folder_id: "bigFolder0000001", cursor }, { harness: h })).value.error, "cursor_invalid");
  }
  assert.equal((await browse({ operation: "list", folder_id: ROOT, cursor: first.value.next_cursor }, { harness: h })).value.error, "cursor_invalid");
  assert.equal((await browse({ operation: "list", folder_id: "bigFolder0000001", cursor: first.value.next_cursor }, { drive, generation: 2 })).value.error,
    "cursor_invalid", "a changed read_generation invalidates the cursor");
  // Search stops after the result budget with the deeper folder still queued.
  const partial = await browse({ operation: "search", name_contains: "plan" }, { harness: h });
  assert.equal(partial.value.complete, false); assert.ok(partial.value.next_cursor);
  assert.equal(names(partial.value).includes("plan zz deep"), false);
  assert.equal((await browse({ operation: "search", name_contains: "other", cursor: partial.value.next_cursor }, { harness: h })).value.error, "cursor_invalid");
  drive.files.get("deepFolder000001").parents = [OUTSIDE];
  const resumed = await browse({ operation: "search", name_contains: "plan", cursor: partial.value.next_cursor }, { harness: h });
  assert.equal(resumed.isError, false);
  assert.equal(names(resumed.value).includes("plan zz deep"), false, "a folder moved out of the root between pages is not searched");
  drive.files.get("deepFolder000001").parents = ["bigFolder0000001"];
  const back = await browse({ operation: "search", name_contains: "plan", cursor: partial.value.next_cursor }, { harness: h });
  assert.equal(names(back.value).includes("plan zz deep"), true);
});

test("credential scope, subject and expiry are rechecked; failures still finalize the receipt", async () => {
  for (const override of [{ scope: "https://www.googleapis.com/auth/drive" }, { expires_at_ms: Date.now() + 1000 }, { access_token: "short" }]) {
    const { h, value } = await browse({ operation: "list" }, { envelope: await envelope(override) });
    assert.equal(value.error, "storage_read_unavailable"); assert.equal(h.googleRequests, 0);
    assert.equal(h.calls.at(-1).p_input.action, "finalize");
  }
  const wrong = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "fixture-read-access-token", scope: "x", expires_at_ms: Date.now() + 3600000 }),
    { ...context, provider_subject: "someone-else" });
  const { value } = await browse({ operation: "list" }, { envelope: wrong });
  assert.equal(value.error, "storage_read_unavailable");
});
