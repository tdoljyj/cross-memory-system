import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const { code } = await transform(await readFile(new URL("../worker/native-read-trace.ts", import.meta.url), "utf8"), {
  loader: "ts", format: "esm", target: "es2022",
});
const { createNativeReadTrace, NATIVE_READ_TRACE_HEADER: header } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const traceId = "11111111-1111-4111-8111-111111111111";

function captureLogs(action) {
  const original = console.info;
  const logs = [];
  console.info = value => { logs.push(JSON.parse(value)); };
  try { action(logs); }
  finally { console.info = original; }
}

test("valid project-list trace echoes its anonymous ID without consuming the response", () => {
  captureLogs(logs => {
    const request = new Request("https://kooyumi.test/v1/projects?query=private-query", {
      headers: { [header]: traceId, authorization: "Bearer private-token", "x-other": "private-header" },
    });
    // The current deployed compatibility flags do not enable incoming signal.
    Object.defineProperty(request, "signal", { get() { throw new Error("must not inspect incoming signal"); } });
    const trace = createNativeReadTrace(request);
    assert.ok(trace);
    const response = new Response("private-body", { status: 207, headers: { "x-existing": "keep" } });
    trace.complete(response);
    assert.equal(response.bodyUsed, false);
    assert.equal(response.status, 207);
    assert.equal(response.headers.get("x-existing"), "keep");
    assert.equal(response.headers.get(header), traceId);
    assert.deepEqual(logs.map(log => log.stage), ["entry", "response_built"]);
    assert.equal(logs.at(-1).status, 207);
    assert.ok(logs.every(log => log.schema === "kooyumi.native-read-trace/v1" && log.traceId === traceId));
    assert.ok(logs.every(log => Number.isInteger(log.elapsedMs) && log.elapsedMs >= 0 && log.elapsedMs <= 86400000));
    assert.equal(JSON.stringify(logs).includes("private-"), false);
    for (const log of logs) {
      assert.deepEqual(Object.keys(log).sort(), ("status" in log
        ? ["elapsedMs", "schema", "stage", "status", "traceId"]
        : ["elapsedMs", "schema", "stage", "traceId"]));
    }
  });
});

test("invalid, duplicated and absent IDs do not produce diagnostics", () => {
  captureLogs(logs => {
    for (const value of [null, "", "secret-token", traceId + "," + traceId, "x".repeat(1000),
      "00000000-0000-0000-0000-000000000000", "11111111-1111-9111-8111-111111111111",
      "11111111-1111-4111-1111-111111111111"]) {
      const headers = value === null ? {} : { [header]: value };
      assert.equal(createNativeReadTrace(new Request("https://kooyumi.test/v1/projects", { headers })), null);
    }
    assert.deepEqual(logs, []);
  });
});

test("trace cannot attach to writes, other paths or preflight", () => {
  captureLogs(logs => {
    for (const [method, path] of [["POST", "/v1/projects"], ["PATCH", "/v1/projects"],
      ["OPTIONS", "/v1/projects"], ["GET", "/v1/projects/"], ["GET", `/v1/projects/${traceId}`],
      ["GET", "/v1/records"], ["GET", "/v1/continuity/bootstrap"]]) {
      assert.equal(createNativeReadTrace(new Request(`https://kooyumi.test${path}`, {
        method, headers: { [header]: traceId },
      })), null);
    }
    assert.deepEqual(logs, []);
  });
});

test("logging failure does not interrupt stages or response echo", () => {
  const original = console.info;
  console.info = () => { throw new Error("logger unavailable"); };
  try {
    const trace = createNativeReadTrace(new Request("https://kooyumi.test/v1/projects", { headers: { [header]: traceId } }));
    assert.ok(trace);
    assert.doesNotThrow(() => trace.stage("auth_started"));
    const response = new Response("original", { status: 401 });
    assert.doesNotThrow(() => trace.complete(response));
    assert.equal(response.headers.get(header), traceId);
    assert.equal(response.status, 401);
    assert.equal(response.bodyUsed, false);
  } finally { console.info = original; }
});

test("request traces stay independent and invalid statuses are not logged", () => {
  captureLogs(logs => {
    const otherId = "22222222-2222-4222-8222-222222222222";
    const one = createNativeReadTrace(new Request("https://kooyumi.test/v1/projects", { headers: { [header]: traceId } }));
    const two = createNativeReadTrace(new Request("https://kooyumi.test/v1/projects", { headers: { [header]: otherId } }));
    one.stage("auth_started", NaN);
    two.stage("auth_started", 999);
    two.complete(new Response(null, { status: 204 }));
    one.complete(new Response("{}", { status: 200 }));
    assert.deepEqual(logs.filter(log => log.traceId === traceId).map(log => log.stage), ["entry", "auth_started", "response_built"]);
    assert.deepEqual(logs.filter(log => log.traceId === otherId).map(log => log.stage), ["entry", "auth_started", "response_built"]);
    assert.ok(logs.filter(log => log.stage === "auth_started").every(log => !("status" in log)));
  });
});
