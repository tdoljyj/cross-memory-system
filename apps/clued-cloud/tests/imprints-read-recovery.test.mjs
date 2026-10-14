import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createClient } from "@supabase/supabase-js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");
function client() {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    vm.runInNewContext(code, { exports, AbortController, setInterval, clearInterval, setTimeout, clearTimeout, console, TextEncoder,
      require(name) {
        assert.ok(name.startsWith("."), "only actual local modules are loaded");
        const base = path.resolve(path.dirname(file), name);
        return load(existsSync(base + ".ts") ? base + ".ts" : base + ".tsx");
      },
    }, { filename: file });
    return exports;
  }
  return load(path.join(APP, "imprints/imprint-client.ts"));
}
const input = { view: "all", scope: "all", query: "", include_history: false, limit: 30, cursor: 0 };
const record = { id: "11111111-1111-4111-8111-111111111111", title: "Existing fixture imprint", content: "Fixture body", record_type: "note",
  canonical_scope: "global", scope: "global", version: 1, record_schema_version: 1, lifecycle_status: "active", organization_version: 0,
  domains: [], record_currentness: "CURRENT", type_fields: { note_kind: "observation" }, relations: {}, source_refs: [] };
const page = () => ({ status: "ok", records: [record], read_semantics: "qualified_saved_latest", selection_complete: true, page: { next_cursor: null, complete: true } });
const safeOptions = diagnostic => ({ isCurrent: () => true, diagnostic: diagnostic ?? (() => {}) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const results = events => events.filter(event => event.outcome !== "start" && event.outcome !== "lifecycle");

test("actual SDK server200/body interruption becomes status0 and the actual imprint read recovers", async () => {
  const m = client(), events = [], observedStatuses = []; let calls = 0;
  const sdk = createClient("https://fixture.invalid", "sb_publishable_fixture", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { async fetch(url) {
      assert.equal(String(url), "https://fixture.invalid/rest/v1/rpc/clued_imprint_read_v1", "all real network is refused");
      if (++calls === 1) return new Response(new ReadableStream({ start(stream) {
        stream.error(new DOMException("CREDENTIAL_TOKEN_SENTINEL/private body", "AbortError"));
      } }), { status: 200, headers: { "content-type": "application/json" } });
      return Response.json(page());
    } },
  });
  await sdk.auth.initialize();
  const rpc = async (name, args, signal) => {
    let request = sdk.rpc(name, args).setHeader("Authorization", "Bearer fixture-native-session");
    if (signal) request = request.abortSignal(signal);
    const result = await request; observedStatuses.push(result.status); return result;
  };
  const result = await m.readImprints(rpc, input, undefined, safeOptions(event => events.push(event)));
  assert.equal(calls, 2); assert.deepEqual(observedStatuses, [0, 200]); assert.equal(result.records[0].id, record.id);
  assert.deepEqual(results(events).map(event => event.outcome), ["retry", "success"]);
  assert.equal(events.filter(event => event.outcome === "start").length, calls);
  assert.doesNotMatch(JSON.stringify(events), /CREDENTIAL_TOKEN_SENTINEL|fixture-native-session|private body|Existing fixture imprint|fixture\.invalid/);
  sdk.auth.stopAutoRefresh();
});

test("three persistent status0 reads are bounded, while auth/shape/semantic refusals are single attempts", async () => {
  const m = client(); let calls = 0;
  await assert.rejects(m.readImprints(async () => { calls++; return { data: null, error: { message: "TypeError: fixture interrupted", code: "" }, status: 0 }; }, input, undefined, safeOptions()));
  assert.equal(calls, 3);
  for (const result of [
    { data: null, error: { message: "fixture auth denied", code: "PGRST301" }, status: 401 },
    { data: null, error: { message: "fixture forbidden", code: "42501" }, status: 403 },
    { data: null, error: { message: "fixture server error", code: "" }, status: 503 },
    { data: { status: "ok", records: "wrong shape" }, error: null, status: 200 },
    { data: { status: "rejected", error_code: "permission_denied" }, error: null, status: 200 },
  ]) {
    calls = 0; const events = [];
    await assert.rejects(m.readImprints(async () => { calls++; return result; }, input, undefined, safeOptions(event => events.push(event))));
    assert.equal(calls, 1);
    assert.equal(events.length, 2); assert.equal(events.filter(event => event.outcome === "start").length, calls);
    assert.equal(results(events).length, 1); assert.equal(results(events)[0].outcome, "failed");
    assert.equal(results(events)[0].category, result.status >= 400 ? "http" : result.data?.status === "rejected" ? "semantic" : "payload");
  }
});

test("source reads recover but a status0 mutation is never automatically repeated", async () => {
  const m = client(); let sourceCalls = 0, mutationCalls = 0;
  const source = await m.readSource(async (name, _args, signal) => {
    assert.equal(name, "clued_imprint_source_v1"); assert.ok(signal);
    if (++sourceCalls === 1) return { data: null, error: { message: "AbortError: fixture response interrupted", code: "20" }, status: 0 };
    return { data: { status: "available", record_version: 1, content: "Fixture source", evidence: {}, segment: null }, error: null, status: 200 };
  }, record.id, "22222222-2222-4222-8222-222222222222", false, 1, safeOptions());
  assert.equal(source.available, true); assert.equal(sourceCalls, 2);
  await assert.rejects(m.mutateRecord(async (name, _args, signal) => {
    assert.equal(name, "clued_user_record_mutate"); assert.equal(signal, undefined); mutationCalls++;
    return { data: null, error: { message: "TypeError: fixture write response lost", code: "" }, status: 0 };
  }, { input: { operation: "create" }, serialized: "{}", hash: "fixture-digest" }));
  assert.equal(mutationCalls, 1);
});

test("changed account/selection suppresses a pending old read without contaminating the new result", async () => {
  const m = client(), old = deferred(), dispatched = deferred(); let current = true, calls = 0, passedSignal;
  const oldRead = m.readImprints((_name, _args, signal) => { calls++; passedSignal = signal; dispatched.resolve(); return old.promise; }, input, undefined, { ...safeOptions(), isCurrent: () => current });
  await dispatched.promise; current = false;
  const fresh = await m.readImprints(async () => ({ data: page(), error: null, status: 200 }), input, undefined, safeOptions());
  await assert.rejects(oldRead); assert.equal(calls, 1); assert.equal(passedSignal.aborted, true);
  old.resolve({ data: { ...page(), records: [{ ...record, title: "Old account result" }] }, error: null, status: 200 });
  assert.equal(fresh.records[0].title, record.title);
});

test("explicit caller abort cancels a pending imprint read and prevents retries", async () => {
  const m = client(), pending = deferred(), dispatched = deferred(), controller = new AbortController(); let calls = 0, passedSignal;
  const work = m.readImprints((_name, _args, signal) => { calls++; passedSignal = signal; dispatched.resolve(); return pending.promise; }, input, undefined, { ...safeOptions(), signal: controller.signal });
  await dispatched.promise; controller.abort();
  await assert.rejects(work); assert.equal(calls, 1); assert.equal(passedSignal.aborted, true);
  pending.resolve({ data: page(), error: null, status: 200 });
});
