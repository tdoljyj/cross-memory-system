import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid";
const token = "clued_bnd_" + "a".repeat(40);
const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_JOBS_V1: "true", SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key" };
const request = (body, bearer = token) => new Request(origin + "/v1/storage/jobs", {
  method: "POST", headers: { "content-type": "application/json", origin, authorization: "Bearer " + bearer }, body: JSON.stringify(body),
});
test("account job transport is off by default and requires a Binding, not a native JWT", async () => {
  const before = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("not expected"); };
  try {
    assert.equal((await worker.fetch(request({}), {})).status, 404);
    assert.equal((await worker.fetch(request({}, "native-jwt"), env)).status, 403);
    assert.equal((await worker.fetch(request({}, "clued_bnd_short"), env)).status, 403);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = before; }
});
test("submit/status route hashes Binding and never supplies an owner or service role", async () => {
  const before = globalThis.fetch; const calls = [];
  const input = { action: "inspect", connection_id: "fixture-connection", job_id: "fixture-job" };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
    return Response.json({ status: "queued", execution_permitted: false });
  };
  try {
    const result = await worker.fetch(request(input), env);
    assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal((await result.json()).execution_permitted, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_jobs_v1");
    assert.deepEqual(calls[0].body, { p_token_hash: createHash("sha256").update(token).digest("hex"), p_input: input });
    assert.equal(calls[0].headers.get("authorization"), "Bearer test-worker-gateway");
  } finally { globalThis.fetch = before; }
});
test("database rejection does not expose payload or internal diagnostics", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: "private-content", code: "42501" }, { status: 403 });
  try {
    const result = await worker.fetch(request({ action: "begin" }), env);
    assert.equal(result.status, 403); assert.equal((await result.text()).includes("private-content"), false);
  } finally { globalThis.fetch = before; }
});

test("V2 job routing is fixed by server configuration and never retries through legacy", async () => {
  const before = globalThis.fetch; const calls = [];
  const input = { action: "inspect", connection_id: "fixture-connection", job_id: "fixture-job" };
  const v2 = { ...env, CLUED_STORAGE_JOBS_V2: "true" };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ message: "private-v2-failure", code: "42501" }, { status: 403 });
  };
  try {
    const result = await worker.fetch(request(input), v2);
    assert.equal(result.status, 403);
    assert.equal((await result.text()).includes("private-v2-failure"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_jobs_router_v2");
    assert.deepEqual(calls[0].body, { p_token_hash: createHash("sha256").update(token).digest("hex"), p_input: input });
  } finally { globalThis.fetch = before; }
});

test("qualified submit schedules only fixed issuer execution; status reads never dispatch", async () => {
  const before=globalThis.fetch, calls=[], pending=[];
  const ref={connection_id:'20000000-0000-4000-8000-000000000001',job_id:'10000000-0000-4000-8000-000000000001'};
  const secret='synthetic-fixed-issuer-'.repeat(3);
  const enabled={ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",...env,CLUED_STORAGE_GOOGLE_V1:'true',CLUED_STORAGE_EXECUTOR_V1:'true',CLUED_STORAGE_CONNECTOR_ISSUER:secret,
    CLUED_STORAGE_GOOGLE_CLIENT_ID:'fixture-client',CLUED_STORAGE_VAULT_KEYS:JSON.stringify({current_key_id:'v1',keys:{v1:Buffer.alloc(32,7).toString('base64url')}})};
  globalThis.fetch=async(url,init)=>{
    const body=JSON.parse(init.body);calls.push({url:String(url),body});
    if(String(url).endsWith('/clued_storage_jobs_v1'))return Response.json({...ref,status:'queued',execution_permitted:false});
    assert.equal(String(url),env.SUPABASE_URL+'/rest/v1/rpc/clued_storage_cloud_worker_v1');
    assert.equal(body.p_issuer_hash,createHash('sha256').update(secret).digest('hex'));
    if(body.p_input.action==='recovery_load')return Response.json({error:'not_recoverable'},{status:403});
    assert.deepEqual(body.p_input,{...ref,action:'load'});
    return Response.json({...ref,contract:'clued.storage-job-execution/1',owner_id:'30000000-0000-4000-8000-000000000001',request_digest:'a'.repeat(64),status:'committed'});
  };
  try {
    const response=await worker.fetch(request({...ref,action:'submit',mutation:{}}),enabled,{waitUntil:p=>pending.push(p)});
    const body=await response.json();assert.equal(body.status,'queued');assert.equal(JSON.stringify(body).includes(secret),false);
    await Promise.all(pending);assert.equal(calls.length,3);
    await worker.fetch(request({...ref,action:'inspect'}),enabled,{waitUntil:p=>pending.push(p)});assert.equal(calls.length,4);assert.equal(pending.length,1);
  }finally{globalThis.fetch=before;}
});

test("V2 cloud dispatch never retries a failed account job through the legacy executor", async () => {
  const before = globalThis.fetch; const calls = []; const pending = [];
  const ref = { connection_id: "20000000-0000-4000-8000-000000000002", job_id: "10000000-0000-4000-8000-000000000002" };
  const issuer = "synthetic-fixed-issuer-".repeat(3);
  const enabled = { ...env, CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_EXECUTOR_V1: "true",
    CLUED_STORAGE_CONNECTOR_ISSUER: issuer, CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture-client",
    CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "v1", keys: { v1: Buffer.alloc(32, 7).toString("base64url") } }) };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).endsWith("/clued_storage_jobs_router_v2")) return Response.json({ ...ref, status: "queued", execution_permitted: false });
    assert.equal(String(url), env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_cloud_worker_router_v2");
    return Response.json({ message: "private-v2-denial", code: "42501" }, { status: 403 });
  };
  try {
    const response = await worker.fetch(request({ ...ref, action: "submit", mutation: {} }), enabled, { waitUntil: p => pending.push(p) });
    assert.equal(response.status, 200);
    await Promise.all(pending);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => !call.url.endsWith("/clued_storage_jobs_v1") && !call.url.endsWith("/clued_storage_cloud_worker_v1")));
    assert.equal(calls[1].body.p_issuer_hash, createHash("sha256").update(issuer).digest("hex"));
    assert.equal(calls[1].body.p_input.action, "verified_inspect");
  } finally { globalThis.fetch = before; }
});

test("with a job queue binding, submit enqueues the exact job and the consumer runs it once and acks", async () => {
  const before = globalThis.fetch; const calls = []; const pending = []; const sent = [];
  const ref = { connection_id: "20000000-0000-4000-8000-000000000003", job_id: "10000000-0000-4000-8000-000000000003" };
  const secret = "synthetic-fixed-issuer-".repeat(3);
  const enabled = { ...env, CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_EXECUTOR_V1: "true", CLUED_STORAGE_CONNECTOR_ISSUER: secret,
    CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture-client",
    CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "v1", keys: { v1: Buffer.alloc(32, 7).toString("base64url") } }),
    CLUED_STORAGE_JOB_QUEUE: { send: async body => { sent.push(body); } } };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url: String(url), body });
    if (String(url).endsWith("/clued_storage_jobs_v1")) return Response.json({ ...ref, status: "queued", execution_permitted: false });
    assert.equal(String(url), env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_cloud_worker_v1");
    if (body.p_input.action === "recovery_load") return Response.json({ error: "not_recoverable" }, { status: 403 });
    assert.deepEqual(body.p_input, { ...ref, action: "load" });
    return Response.json({ ...ref, contract: "clued.storage-job-execution/1", owner_id: "30000000-0000-4000-8000-000000000001",
      request_digest: "a".repeat(64), status: "committed" });
  };
  try {
    const response = await worker.fetch(request({ ...ref, action: "submit", mutation: {} }), enabled, { waitUntil: p => pending.push(p) });
    assert.equal((await response.json()).status, "queued");
    await Promise.all(pending);
    assert.deepEqual(sent, [ref]);
    assert.equal(calls.length, 1);
    const acks = [];
    await worker.runStorageJobQueue({ messages: [{ body: sent[0], ack: () => acks.push("job") }] }, enabled);
    assert.deepEqual(acks, ["job"]);
    assert.equal(calls.length, 3);
    assert.ok(calls.slice(1).every(call => call.url.endsWith("/clued_storage_cloud_worker_v1")));
  } finally { globalThis.fetch = before; }
});

test("job queue consumer acks malformed messages without dispatch, and a failed enqueue runs the job in place", async () => {
  const before = globalThis.fetch; const calls = []; const pending = [];
  const ref = { connection_id: "20000000-0000-4000-8000-000000000004", job_id: "10000000-0000-4000-8000-000000000004" };
  const secret = "synthetic-fixed-issuer-".repeat(3);
  const enabled = { ...env, CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_EXECUTOR_V1: "true", CLUED_STORAGE_CONNECTOR_ISSUER: secret,
    CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture-client",
    CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "v1", keys: { v1: Buffer.alloc(32, 7).toString("base64url") } }),
    CLUED_STORAGE_JOB_QUEUE: { send: async () => { throw new Error("queue unavailable"); } } };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url: String(url), body });
    if (String(url).endsWith("/clued_storage_jobs_v1")) return Response.json({ ...ref, status: "queued", execution_permitted: false });
    if (body.p_input.action === "recovery_load") return Response.json({ error: "not_recoverable" }, { status: 403 });
    return Response.json({ ...ref, contract: "clued.storage-job-execution/1", owner_id: "30000000-0000-4000-8000-000000000001",
      request_digest: "a".repeat(64), status: "committed" });
  };
  const warn = console.warn; console.warn = () => {};
  try {
    const acks = [];
    await worker.runStorageJobQueue({ messages: [
      { body: null, ack: () => acks.push("null") },
      { body: { connection_id: "not-a-uuid", job_id: ref.job_id }, ack: () => acks.push("bad-id") },
      { body: { job_id: ref.job_id }, ack: () => acks.push("missing") },
    ] }, enabled);
    assert.deepEqual(acks, ["null", "bad-id", "missing"]);
    assert.equal(calls.length, 0);
    await worker.fetch(request({ ...ref, action: "submit", mutation: {} }), enabled, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    assert.equal(calls.length, 3);
    assert.ok(calls.some(call => call.url.endsWith("/clued_storage_cloud_worker_v1") &&
      JSON.stringify(call.body.p_input) === JSON.stringify({ ...ref, action: "load" })));
  } finally { globalThis.fetch = before; console.warn = warn; }
});
