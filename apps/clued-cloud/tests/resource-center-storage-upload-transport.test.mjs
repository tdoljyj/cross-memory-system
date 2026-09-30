// StorageNormalUse.v0.1 N3 transport: clued_storage_upload_begin, the signed PUT endpoint,
// inline content_base64 submit and the staging sweep, through the real continuity handler
// with a synthetic staging RPC and an in-memory R2 bucket. Never a real database or Drive.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
import { memoryBucket, pngBytes, sha256Hex } from "./resource-center-storage-binary.fixture.mjs";
import { buildZip } from "./resource-center-zip.fixture.mjs";

const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid";
const token = "clued_bnd_" + "b".repeat(40);
const tokenHash = createHash("sha256").update(token).digest("hex");
const issuer = "synthetic-fixed-issuer-".repeat(3);
const issuerHash = createHash("sha256").update(issuer).digest("hex");
const CONNECTION = "20000000-0000-4000-8000-000000000031", OWNER = "30000000-0000-4000-8000-000000000031", BINDING = "40000000-0000-4000-8000-000000000031";
const ROOT = "G:/My Drive/Clued_资料中心/20_P_产品与体验";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const baseEnv = () => ({ CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_JOBS_V1: "true", CLUED_STORAGE_JOBS_V2: "true",
  CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_BINARY_V1: "true", CLUED_STORAGE_EXECUTOR_V1: "true", CLUED_STORAGE_CONNECTOR_ISSUER: issuer,
  CLUED_STORAGE_STAGING: memoryBucket(), CLUED_STORAGE_STAGING_URL_KEY: Buffer.alloc(32, 5).toString("base64url"),
  CLUED_STORAGE_STAGING_KEYS: JSON.stringify({ current_key_id: "s1", keys: { s1: Buffer.alloc(32, 6).toString("base64url") } }),
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key" });

/** Synthetic staging RPC with the database's state machine (issued -> receiving -> validating -> ready). */
function database() {
  const rows = new Map(), calls = [], jobs = [];
  const error = (message, status = 403) => Response.json({ message, code: status === 400 ? "22023" : "42501" }, { status });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/clued_storage_jobs_router_v2")) {
      jobs.push(body);
      const m = body.p_input.mutation;
      const row = rows.get(m.staging_id);
      if (!row || row.state !== "ready") return error("staging_expired");
      row.state = "consumed";
      return Response.json({ job_id: body.p_input.job_id, connection_id: body.p_input.connection_id, request_digest: "c".repeat(64),
        status: "queued", intent_id: null, receipt_id: randomUUID(), execution_permitted: false, replayed: false });
    }
    assert.equal(String(url), "https://db.example.invalid/rest/v1/rpc/clued_storage_staging_v1");
    assert.equal(body.p_issuer_hash, issuerHash);
    const input = body.p_input;
    if (input.action === "begin") {
      assert.equal(body.p_token_hash, tokenHash);
      if (database.gateOff) return error("storage_binary_upload_disabled");
      const id = randomUUID(), exp = Math.floor(Date.now() / 1000) + (database.expired ? -1 : 600);
      rows.set(id, { ...input, id, state: "issued", exp });
      return Response.json({ contract: "clued.storage-staging/1", staging_id: id, owner_id: OWNER, connection_id: input.connection_id, binding_id: BINDING,
        destination_path: input.destination_path, mime_type: input.mime_type, size: input.size, sha256: input.content_sha256,
        transport: input.transport, state: "issued", expires_at: exp });
    }
    assert.equal(body.p_token_hash, null, "only begin carries the Binding token");
    const row = rows.get(input.staging_id);
    if (input.action === "receive") {
      if (!row || input.owner_id !== OWNER || input.binding_id !== BINDING || input.exp !== row.exp || input.size !== row.size) return error("upload_url_invalid");
      if (row.state !== "issued") return error("upload_url_used");
      row.state = "receiving"; row.key_id = input.key_id;
      return Response.json({ staging_id: row.id, owner_id: OWNER, connection_id: row.connection_id, size: row.size, sha256: row.content_sha256,
        mime_type: row.mime_type, key_id: input.key_id, state: "receiving" });
    }
    if (input.action === "received" || input.action === "validated") {
      const from = input.action === "received" ? "receiving" : "validating";
      if (row.state !== from) return error("storage_staging_state_conflict", 409);
      row.state = input.outcome; row.reason = input.reason;
      return Response.json({ staging_id: row.id, state: row.state, replayed: false, ...(row.state === "ready" ? { ready_expires_at: Math.floor(Date.now() / 1000) + 3600 } : {}) });
    }
    if (input.action === "sweep") {
      const deletable = [...rows.values()].filter(r => ["rejected", "expired", "consumed"].includes(r.state) && !r.deleted).map(r => r.id);
      return Response.json({ status: "ok", expired: 0, stalled: 0, cancelled_jobs: 0, delete: deletable });
    }
    if (input.action === "object_deleted") {
      for (const id of input.staging_ids) rows.get(id).deleted = true;
      return Response.json({ status: "ok", marked: input.staging_ids.length });
    }
    throw new Error("unexpected action " + input.action);
  };
  return { rows, calls, jobs, fetch };
}

const rpc = (method, params, bearer = token) => new Request(origin + "/mcp", { method: "POST",
  headers: { "content-type": "application/json", origin, ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const call = async (env, name, args) => (await (await worker.fetch(rpc("tools/call", { name, arguments: args }), env)).json()).result;
const begin = (env, bytes, extra = {}) => call(env, "clued_storage_upload_begin", { connection_id: CONNECTION, destination_path: ROOT + "/photo.png",
  mime_type: "image/png", size: bytes.length, content_sha256: sha256Hex(bytes), ...extra });
const put = (url, bytes, headers = {}) => worker.fetch(new Request(url, { method: "PUT", body: bytes,
  headers: { "content-type": "image/png", "content-length": String(bytes.length), ...headers } }), put.env);

async function withDatabase(fn) {
  const before = globalThis.fetch, db = database();
  globalThis.fetch = db.fetch; database.gateOff = false; database.expired = false;
  try { return await fn(db); } finally { globalThis.fetch = before; }
}

test("discovery: upload_begin and binary submit variants exist only with every binary flag", async () => {
  for (const [env, expected] of [[{ ...baseEnv(), CLUED_STORAGE_BINARY_V1: undefined }, false], [{ ...baseEnv(), CLUED_STORAGE_JOBS_V2: undefined }, false], [baseEnv(), true]]) {
    const tools = (await (await worker.fetch(rpc("tools/list", {}), env)).json()).result.tools;
    assert.equal(tools.some(t => t.name === "clued_storage_upload_begin"), expected);
    assert.equal(tools.find(t => t.name === "clued_storage_submit").inputSchema.properties.mutation.oneOf.length, expected ? 7 : 5);
    if (!expected) assert.equal((await worker.fetch(new Request(origin + "/storage/staging/" + randomUUID() + "?t=x", { method: "PUT", body: "x" }), env)).status, 404);
  }
});

test("upload_begin signs a single-use URL; the PUT stores only ciphertext and makes the row ready", async () => withDatabase(async db => {
  const env = baseEnv(); put.env = env;
  const bytes = pngBytes(200 * 1024 + 11);
  const started = await begin(env, bytes);
  assert.equal(started.isError, false, JSON.stringify(started));
  const out = started.structuredContent;
  assert.equal(out.method, "PUT");
  assert.deepEqual(out.required_headers, { "Content-Type": "image/png", "Content-Length": String(bytes.length) });
  assert.match(out.upload_url, new RegExp(`^${origin}/storage/staging/${out.staging_id}\\?t=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$`));
  assert.equal(db.calls[0].body.p_input.transport, "url");
  const response = await put(out.upload_url, bytes);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).state, "ready");
  const stored = env.CLUED_STORAGE_STAGING.objects.get("staging/" + out.staging_id);
  assert.equal(stored.length, bytes.length + 16 * Math.ceil(bytes.length / 65536), "64 KiB chunks, one tag each");
  assert.equal(stored.includes(Buffer.from(bytes.subarray(1000, 1064))), false, "no plaintext at rest");
  assert.deepEqual(db.calls.slice(1).map(c => c.body.p_input.action + ":" + (c.body.p_input.outcome ?? "")), ["receive:", "received:validating", "validated:ready"]);
  assert.equal(db.calls[1].body.p_input.key_id, "s1");
  // Single use: the second PUT is refused by the database CAS.
  const again = await put(out.upload_url, bytes);
  assert.equal(again.status, 409); assert.equal((await again.json()).error, "upload_url_used");
}));

test("signature is the only credential; declared headers are checked before the URL is used", async () => withDatabase(async db => {
  const env = baseEnv(); put.env = env;
  const bytes = pngBytes(512);
  const { structuredContent: out } = await begin(env, bytes);
  const [base, tokenValue] = out.upload_url.split("?t=");
  const before = db.calls.length;
  for (const [url, headers, status, code] of [
    [base + "?t=" + tokenValue.slice(0, -2) + "AA", {}, 403, "upload_url_invalid"],
    [base.replace(out.staging_id, randomUUID()) + "?t=" + tokenValue, {}, 403, "upload_url_invalid"],
    [out.upload_url + "&extra=1", {}, 403, "upload_url_invalid"],
    [out.upload_url, { authorization: "Bearer " + token }, 403, "upload_url_invalid"],
    [out.upload_url, { "content-type": "image/jpeg" }, 400, "storage_job_input_invalid"],
  ]) {
    const response = await put(url, bytes, headers);
    assert.equal(response.status, status, url); assert.equal((await response.json()).error, code);
  }
  const shortLength = await worker.fetch(new Request(out.upload_url, { method: "PUT", body: bytes.subarray(1),
    headers: { "content-type": "image/png", "content-length": String(bytes.length - 1) } }), env);
  assert.equal(shortLength.status, 400);
  assert.equal(db.calls.length, before, "no RPC and no single-use claim for a refused request");
  assert.equal((await put(out.upload_url, bytes)).status, 200, "the URL still works after client mistakes");
  database.expired = true;
  const { structuredContent: late } = await begin(env, bytes);
  const expired = await put(late.upload_url, bytes);
  assert.equal(expired.status, 410); assert.equal((await expired.json()).error, "staging_expired");
}));

test("content checks: denylisted magic, digest mismatch and zip macros reject the row and delete the object", async () => withDatabase(async db => {
  const env = baseEnv(); put.env = env;
  const exe = new Uint8Array(4096); exe.set([0x4d, 0x5a]);
  const { structuredContent: a } = await begin(env, exe);
  let response = await put(a.upload_url, exe);
  assert.equal(response.status, 415); assert.equal((await response.json()).error, "content_type_mismatch");
  assert.equal(db.rows.get(a.staging_id).state, "rejected"); assert.equal(db.rows.get(a.staging_id).reason, "content_type_mismatch");
  assert.equal(env.CLUED_STORAGE_STAGING.objects.has("staging/" + a.staging_id), false);

  const bytes = pngBytes(70000), other = pngBytes(70000); other[69999] ^= 1;
  const { structuredContent: b } = await begin(env, bytes);
  response = await put(b.upload_url, other);
  assert.equal(response.status, 400); assert.equal((await response.json()).error, "storage_job_input_invalid");
  assert.equal(db.rows.get(b.staging_id).reason, "digest_mismatch");
  assert.equal(env.CLUED_STORAGE_STAGING.objects.has("staging/" + b.staging_id), false);

  const docx = await buildZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/vbaProject.bin", data: "macro" }]);
  const { structuredContent: c } = await begin(env, docx, { destination_path: ROOT + "/report.docx", mime_type: DOCX });
  response = await put(c.upload_url, docx, { "content-type": DOCX });
  assert.equal(response.status, 415);
  assert.equal(db.rows.get(c.staging_id).state, "rejected");
  assert.equal(db.calls.filter(x => x.body.p_input.staging_id === c.staging_id).map(x => x.body.p_input.outcome ?? x.body.p_input.action).join(","),
    "receive,validating,rejected", "the macro check runs in the validating stage");
  assert.equal(env.CLUED_STORAGE_STAGING.objects.has("staging/" + c.staging_id), false);
}));

test("upload_begin refuses types before any RPC and maps gate refusals to fixed codes", async () => withDatabase(async db => {
  const env = baseEnv();
  for (const extra of [{ destination_path: ROOT + "/photo.jpg" }, { destination_path: ROOT + "/page.html", mime_type: "text/html" },
    { destination_path: ROOT + "/logo.svg", mime_type: "image/svg+xml" }, { destination_path: ROOT + "/m.docm", mime_type: "application/vnd.ms-word.document.macroEnabled.12" }]) {
    const result = await begin(env, pngBytes(), extra);
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error, "content_type_mismatch");
  }
  assert.equal((await begin(env, pngBytes(), { size: 20 * 1024 * 1024 + 1 })).structuredContent.error, "storage_job_input_invalid");
  assert.equal(db.calls.length, 0);
  database.gateOff = true;
  const gated = await begin(env, pngBytes());
  assert.equal(gated.structuredContent.error, "storage_binary_upload_disabled");
  assert.equal(JSON.stringify(gated).includes("db.example"), false);
}));

test("missing R2 binding or keys fail closed", async () => withDatabase(async db => {
  for (const missing of ["CLUED_STORAGE_STAGING", "CLUED_STORAGE_STAGING_URL_KEY", "CLUED_STORAGE_STAGING_KEYS"]) {
    const env = { ...baseEnv(), [missing]: undefined };
    const result = await begin(env, pngBytes());
    assert.equal(result.structuredContent.error, "storage_upload_unavailable", missing);
    const response = await worker.fetch(new Request(origin + "/storage/staging/" + randomUUID() + "?t=a.b", { method: "PUT", body: "x" }), env);
    assert.equal(response.status, 503, missing);
  }
  assert.equal(db.calls.length, 0);
}));

test("inline content_base64 stages through the same pipeline, then submits only the staging_id", async () => withDatabase(async db => {
  const env = baseEnv();
  const bytes = pngBytes(3000);
  const job = randomUUID();
  const result = await call(env, "clued_storage_submit", { connection_id: CONNECTION, job_id: job, mutation: { operation: "create", target_kind: "file",
    destination_path: ROOT + "/inline.png", mime_type: "image/png", content_sha256: sha256Hex(bytes), content_base64: Buffer.from(bytes).toString("base64") } });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(db.calls[0].body.p_input.transport, "inline");
  assert.equal(db.jobs.length, 1);
  const submitted = db.jobs[0].p_input.mutation;
  assert.deepEqual(Object.keys(submitted).sort(), ["content_sha256", "destination_path", "mime_type", "operation", "staging_id", "target_kind"]);
  assert.equal(JSON.stringify(db.jobs[0]).includes(Buffer.from(bytes).toString("base64").slice(0, 40)), false, "no content in the job");
  // A wrong declared sha256 is refused before any RPC.
  const before = db.calls.length;
  const wrong = await call(env, "clued_storage_submit", { connection_id: CONNECTION, job_id: randomUUID(), mutation: { operation: "create", target_kind: "file",
    destination_path: ROOT + "/inline.png", mime_type: "image/png", content_sha256: "0".repeat(64), content_base64: Buffer.from(bytes).toString("base64") } });
  assert.equal(wrong.structuredContent.error, "storage_job_input_invalid");
  assert.equal(db.calls.length, before);
  // Binary shapes with the feature off: refused with the fixed code and no RPC.
  const off = await call({ ...env, CLUED_STORAGE_BINARY_V1: undefined }, "clued_storage_submit", { connection_id: CONNECTION, job_id: randomUUID(),
    mutation: { operation: "create", target_kind: "file", destination_path: ROOT + "/x.png", mime_type: "image/png", content_sha256: "0".repeat(64), staging_id: randomUUID() } });
  assert.equal(off.structuredContent.error, "storage_binary_upload_disabled");
  assert.equal(db.calls.length, before);
}));

test("large uploads stream in pieces; the sweep deletes objects the database lists", async () => withDatabase(async db => {
  const env = baseEnv(); put.env = env;
  const bytes = pngBytes(6 * 1024 * 1024 + 5);
  const { structuredContent: out } = await begin(env, bytes);
  let offset = 0;
  const body = new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) return controller.close();
    const size = 1000 + (offset % 70001); controller.enqueue(bytes.slice(offset, offset + size)); offset += size;
  } });
  const response = await worker.fetch(new Request(out.upload_url, { method: "PUT", body, duplex: "half",
    headers: { "content-type": "image/png", "content-length": String(bytes.length) } }), env);
  assert.equal(response.status, 200, await response.clone().text());
  db.rows.get(out.staging_id).state = "consumed";
  const swept = await worker.runStorageStagingScheduled(env);
  assert.equal(swept.status, "ok"); assert.equal(swept.deleted, 1);
  assert.equal(env.CLUED_STORAGE_STAGING.objects.size, 0);
  assert.equal(db.rows.get(out.staging_id).deleted, true);
  assert.equal((await worker.runStorageStagingScheduled({ ...env, CLUED_STORAGE_BINARY_V1: undefined })).status, "disabled");
}));
