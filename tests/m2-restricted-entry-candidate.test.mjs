import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createM2RestrictedEntryCandidate } from "../kernel/host/m2-restricted-entry-candidate.mjs";
import { createM2RestrictedStdioCandidate, runM2CandidateStdio } from "../kernel/host/m2-restricted-entry-stdio.mjs";
import { PassThrough } from "node:stream";

const hash = s => createHash("sha256").update(s).digest("hex");
const blockFor = ms => { const end = performance.now() + ms; while (performance.now() < end) {} };
// Contract fixtures, not an OS/VM executor or formal isolation evidence.
function fixture({ role = "A", resolutionChange = {}, recheckChange = {}, input = "PUBLIC_EMPTY", probe,
  stop = true, timeoutMs = 1000, leaseMs = 60000, failCreate = false,
  readDelay = 0, createDelay = 0, stopDelay = 0 } = {}) {
  const stem = role === "A" ? "a" : "r";
  const roots = Object.fromEntries(["input", "output"].map(kind => [kind, {
    platform: "posix", normalized_root: `/srv/clued-m2/probe/${stem}-${kind === "input" ? "input" : role === "A" ? "work" : "output"}`,
    root_file_id: `${role}-${kind}`, volume_id: "fixture-volume", policy_version: "fixture-v1",
    case_sensitive: true, network_share_allowed: false,
  }]));
  const observed = []; const effects = []; let reads = 0; let stops = 0;
  const transport = {
    async withFile(request, fn, signal) {
      observed.push(request);
      const kind = request.operation === "read" ? "input" : "output";
      const resolution = {
        root_file_id: roots[kind].root_file_id, volume_id: "fixture-volume", policy_version: "fixture-v1",
        parent_file_id: "parent", final_file_id: kind === "input" ? "input-id" : null,
        target_exists: kind === "input",
        components: request.path.split("/").map(() => ({ no_follow: true, link_count: 1 })),
        ...resolutionChange,
      };
      return fn({ resolution,
        recheck: async () => ({ ...resolution, ...recheckChange }),
        read: async () => { reads++; blockFor(readDelay); return input; },
        create: async content => {
          if (signal.aborted) throw new Error("aborted");
          if (failCreate) throw new Error("SECRET_ERROR /root/private");
          blockFor(createDelay);
          effects.push(content);
        },
      });
    },
    async runEmptyProbe(binding, signal) {
      observed.push(binding);
      return probe ? probe(signal) : "EMPTY_MARKER_OK";
    },
    async stopAndConfirm() { stops++; blockFor(stopDelay); return stop; },
  };
  const host = createM2RestrictedEntryCandidate({ trustedRole: role, trustedRoots: roots,
    frozenInputs: { "marker.txt": hash("PUBLIC_EMPTY") }, transport, timeoutMs, leaseMs });
  return { host, roots, transport, observed, effects, reads: () => reads, stops: () => stops };
}
const read = (host, id = "read") => host.callTool("m2_read_input", { request_id: id, path: "marker.txt" });
const write = (host, id = "write", path = "result.txt") => host.callTool("m2_write_output", { request_id: id, path, content: "PUBLIC_RESULT" });
const probe = (host, id = "probe") => host.callTool("m2_run_empty_probe", { request_id: id });

test("default endpoint is closed, including all three known tools", async () => {
  const host = createM2RestrictedEntryCandidate();
  assert.equal(host.status().transport, "NOT_CONFIGURED");
  for (const result of [await read(host), await write(host), await probe(host)]) {
    assert.equal(result.error_code, "NOT_CONFIGURED"); assert.equal(result.qualification, "NOT_ISSUED");
  }
  assert.equal((await read(host)).error_code, "REPLAY_REJECTED");
});
for (const role of ["A", "R"]) test(`fixed ${role} binding and frozen-input/own-output positive contract`, async () => {
  const f = fixture({ role });
  assert.equal((await read(f.host)).content, "PUBLIC_EMPTY");
  assert.equal((await write(f.host)).status, "candidate_ok");
  assert.equal((await probe(f.host)).result, "EMPTY_MARKER_OK");
  assert.deepEqual(f.effects, ["PUBLIC_RESULT"]);
  for (const r of f.observed) {
    assert.equal(r.principal, role === "A" ? "m2-a" : "m2-r");
    assert.equal(r.input_root, f.roots.input.normalized_root);
    assert.equal(r.output_root, f.roots.output.normalized_root);
  }
});
for (const key of ["role", "uid", "root", "command", "shell", "probe", "transport"]) {
  test(`caller cannot inject ${key}`, async () => {
    const f = fixture();
    assert.equal((await f.host.callTool("m2_run_empty_probe", { request_id: key, [key]: "root" })).error_code, "REQUEST_INVALID");
    assert.equal(f.observed.length, 0);
  });
}
test("closed tool surface and defensive list copy", async () => {
  const f = fixture(); const tools = f.host.listTools();
  assert.equal(tools.length, 3); tools.push({ name: "exec_command" });
  assert.equal(f.host.listTools().length, 3);
  for (const name of ["exec_command", "shell", "read_file", "revoke", "m2_read_holdout"]) {
    assert.equal((await f.host.callTool(name, {})).error_code, "TOOL_NOT_ALLOWED");
  }
  assert.equal(f.observed.length, 0);
});
for (const path of ["../h-private/marker", "/root/secret", "C:/Clued/a", "a\\b", "a/../r-input", "a//b", "./a", "a/.", "a/..", "a\u0000b", "a:$DATA"]) {
  test(`reject path ${JSON.stringify(path)} before transport`, async () => {
    const f = fixture(); assert.equal((await write(f.host, "negative", path)).error_code, "PATH_INVALID");
    assert.equal(f.observed.length, 0); assert.equal(f.effects.length, 0);
  });
}
for (const component of [{ symlink: true }, { reparse: true }, { mount_escape: true }, { no_follow: false },
  { identity_ambiguous: true }, { special_object: true }, { link_count: 2 }]) {
  test(`unsafe output resolution ${JSON.stringify(component)} has zero effects`, async () => {
    const f = fixture({ resolutionChange: { components: [{ no_follow: true, link_count: 1, ...component }] } });
    assert.equal((await write(f.host)).error_code, "OPERATION_REJECTED");
    assert.equal(f.effects.length, 0);
  });
}
for (const change of [{ root_file_id: "H-private" }, { volume_id: "other" }, { policy_version: "other" },
  { network_share: true }, { components: [] }, { parent_file_id: "changed" }, { target_exists: true, final_file_id: "existing" }]) {
  test(`rechecked output identity ${JSON.stringify(change)} denied`, async () => {
    const f = fixture({ recheckChange: change });
    assert.equal((await write(f.host)).error_code, "OPERATION_REJECTED"); assert.equal(f.effects.length, 0);
  });
}
test("input symlink is rejected before any read", async () => {
  const f = fixture({ resolutionChange: { components: [{ no_follow: true, symlink: true }] } });
  assert.equal((await read(f.host)).error_code, "OPERATION_REJECTED"); assert.equal(f.reads(), 0);
});
test("input identity drift, unlisted input and hash mismatch do not leak content", async () => {
  const drift = fixture({ recheckChange: { final_file_id: "changed" } });
  assert.equal((await read(drift.host)).error_code, "OPERATION_REJECTED"); assert.equal(drift.reads(), 0);
  const f = fixture({ input: "SECRET_DIFFERENT" });
  assert.equal((await f.host.callTool("m2_read_input", { request_id: "unlisted", path: "h-private" })).error_code, "INPUT_NOT_FROZEN");
  const result = await read(f.host);
  assert.equal(result.error_code, "OPERATION_REJECTED"); assert.equal(JSON.stringify(result).includes("SECRET"), false);
});
test("output overwrite and oversized content are refused", async () => {
  const f = fixture({ resolutionChange: { target_exists: true, final_file_id: "existing" } });
  assert.equal((await write(f.host)).error_code, "OPERATION_REJECTED"); assert.equal(f.effects.length, 0);
  const g = fixture();
  assert.equal((await g.host.callTool("m2_write_output", { request_id: "big", path: "result.txt", content: "字".repeat(30000) })).error_code, "CONTENT_TOO_LARGE");
  assert.equal(g.observed.length, 0);
});
test("replay is consumed once and errors never expose exception text", async () => {
  const f = fixture(); await write(f.host);
  assert.equal((await write(f.host)).error_code, "REPLAY_REJECTED"); assert.equal(f.effects.length, 1);
  const g = fixture({ failCreate: true }); const result = await write(g.host);
  assert.equal(result.error_code, "OPERATION_REJECTED"); assert.equal(result.execution_state, "UNKNOWN");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal((await probe(g.host)).error_code, "ENTRY_REVOKED_OR_EXPIRED");
});
test("timeout aborts, asks executor to stop and invalidates whole entry", async () => {
  let aborted = false;
  const f = fixture({ timeoutMs: 15, probe: signal => new Promise(resolve => {
    signal.addEventListener("abort", () => { aborted = true; resolve("EMPTY_MARKER_OK"); }, { once: true });
  }) });
  assert.equal((await probe(f.host)).error_code, "ENTRY_INTERRUPTED");
  assert.equal(aborted, true); assert.equal(f.stops(), 1);
  assert.equal((await write(f.host)).error_code, "ENTRY_REVOKED_OR_EXPIRED");
});
test("missing stop confirmation is UNKNOWN, never a false termination proof", async () => {
  const f = fixture({ timeoutMs: 10, stop: false, probe: () => new Promise(() => {}) });
  const result = await probe(f.host);
  assert.equal(result.error_code, "EXECUTION_STOP_UNCONFIRMED"); assert.equal(result.execution_state, "UNKNOWN");
});
test("hanging stop confirmation is bounded", async () => {
  const f = fixture({ timeoutMs: 10, stop: new Promise(() => {}), probe: () => new Promise(() => {}) });
  assert.equal((await probe(f.host)).error_code, "EXECUTION_STOP_UNCONFIRMED");
});
test("explicit revoke interrupts current request and excludes subsequent calls", async () => {
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  const f = fixture({ probe: signal => new Promise(resolve => {
    enter(); signal.addEventListener("abort", () => resolve("EMPTY_MARKER_OK"), { once: true });
  }) });
  const pending = probe(f.host); await entered; f.host.revoke();
  assert.equal((await pending).error_code, "ENTRY_INTERRUPTED");
  assert.equal((await read(f.host)).error_code, "ENTRY_REVOKED_OR_EXPIRED");
});
test("expiry prevents dispatch", async () => {
  const f = fixture({ leaseMs: 1 }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await read(f.host)).error_code, "ENTRY_REVOKED_OR_EXPIRED"); assert.equal(f.observed.length, 0);
});
test("parallel call rejected, public probe verdict only", async () => {
  let finish; const f = fixture({ probe: () => new Promise(resolve => { finish = resolve; }) });
  const pending = probe(f.host);
  assert.equal((await write(f.host)).error_code, "ENTRY_BUSY"); finish("EMPTY_MARKER_OK"); await pending;
  const g = fixture({ probe: async () => "SECRET_STDOUT" });
  const result = await probe(g.host); assert.equal(result.error_code, "OPERATION_REJECTED");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});
test("stdio-shaped pilot exposes only closed tools and no configured execution", async () => {
  const endpoint = createM2RestrictedStdioCandidate();
  const list = await endpoint.request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.result.tools.length, 3);
  const call = await endpoint.request({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "m2_run_empty_probe", arguments: { request_id: "one" } } });
  assert.equal(JSON.parse(call.result.content[0].text).error_code, "NOT_CONFIGURED");
  assert.equal(call.result.isError, true);
  assert.equal((await endpoint.request({ jsonrpc: "2.0", id: 3, method: "initialize" })).result.protocolVersion, "2025-11-25");
  endpoint.close();
});
test("real stream framing, parse failures, replay and EOF never configure VM", async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk; });
  const running = runM2CandidateStdio({ input, output });
  input.write('{bad}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "m2_run_empty_probe", arguments: { request_id: "same" } } });
  input.write(message.slice(0, 10)); input.end(message.slice(10) + "\n" + message + "\nunfinished");
  await running;
  const results = text.trim().split("\n").map(JSON.parse);
  assert.equal(results.length, 4); assert.equal(results[0].error.code, -32700);
  assert.equal(JSON.parse(results[1].result.content[0].text).error_code, "NOT_CONFIGURED");
  assert.equal(JSON.parse(results[2].result.content[0].text).error_code, "REPLAY_REJECTED");
  assert.equal(results[3].error.message, "Incomplete frame");
});
test("oversize stdio frame fails closed", async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk; });
  const running = runM2CandidateStdio({ input, output });
  input.end("x".repeat(131073)); await running;
  assert.equal(JSON.parse(text).error.message, "Stdio boundary failure");
});
test("Host configuration cannot select H/root or a foreign root", () => {
  assert.throws(() => createM2RestrictedEntryCandidate({ trustedRole: "root" }), /HOST_PROFILE_INVALID/);
  assert.throws(() => createM2RestrictedEntryCandidate({ trustedRole: "H" }), /HOST_PROFILE_INVALID/);
  assert.throws(() => createM2RestrictedEntryCandidate({ transport: {} }), /TRANSPORT_CONTRACT_INVALID/);
  const f = fixture();
  f.roots.input.normalized_root = "/root";
  assert.throws(() => createM2RestrictedEntryCandidate({ transport: f.transport,
    trustedRoots: f.roots, frozenInputs: { "marker.txt": hash("PUBLIC_EMPTY") } }), /HOST_ROOT_INVALID/);
});
for (const trustedRole of ["__proto__", "constructor", "toString", ["A"], null, { toString: null }]) {
  test(`reject non-own/non-string role ${JSON.stringify(trustedRole)} before transport`, () => {
    const f = fixture();
    const roots = structuredClone(f.roots);
    delete roots.input.normalized_root; delete roots.output.normalized_root;
    assert.throws(() => createM2RestrictedEntryCandidate({ trustedRole, trustedRoots: roots,
      transport: f.transport, frozenInputs: { "marker.txt": hash("PUBLIC_EMPTY") } }), /HOST_PROFILE_INVALID/);
    assert.equal(f.observed.length, 0);
  });
}
for (const root of [undefined, null, "", 123, []]) test(`invalid root type ${JSON.stringify(root)} fails profile`, () => {
  const f = fixture(); f.roots.input.normalized_root = root;
  assert.throws(() => createM2RestrictedEntryCandidate({ trustedRoots: f.roots, transport: f.transport,
    frozenInputs: { "marker.txt": hash("PUBLIC_EMPTY") } }), /HOST_PROFILE_INVALID/);
  assert.equal(f.observed.length, 0);
});
for (const kind of ["probe", "read", "create"]) test(`synchronous late ${kind} cannot return candidate_ok`, async () => {
  const f = fixture({ timeoutMs: 10, readDelay: kind === "read" ? 35 : 0,
    createDelay: kind === "create" ? 35 : 0,
    probe: kind === "probe" ? () => { blockFor(35); return "EMPTY_MARKER_OK"; } : undefined });
  const result = kind === "probe" ? await probe(f.host) : kind === "read" ? await read(f.host) : await write(f.host);
  assert.equal(result.error_code, "ENTRY_INTERRUPTED");
  assert.equal(f.host.status().revoked, true); assert.equal(f.stops(), 1);
  assert.equal((await probe(f.host, "after")).error_code, "ENTRY_REVOKED_OR_EXPIRED");
});
test("synchronous late stop confirmation is UNKNOWN even when timer cannot fire", async () => {
  const f = fixture({ timeoutMs: 10, stopDelay: 130, probe: () => { blockFor(35); return "EMPTY_MARKER_OK"; } });
  const result = await probe(f.host);
  assert.equal(result.error_code, "EXECUTION_STOP_UNCONFIRMED");
  assert.equal(result.execution_state, "UNKNOWN"); assert.equal(f.host.status().revoked, true);
});
test("synchronous late transport exception still follows timeout stop path", async () => {
  const f = fixture({ timeoutMs: 10, probe: () => { blockFor(35); throw new Error("PRIVATE_TRANSPORT_ERROR"); } });
  const result = await probe(f.host);
  assert.equal(result.error_code, "ENTRY_INTERRUPTED"); assert.equal(f.stops(), 1);
  assert.equal(f.host.status().revoked, true);
});
test("malformed request_id is REQUEST_INVALID and next stdio request survives", async () => {
  const endpoint = createM2RestrictedStdioCandidate();
  const bad = await endpoint.request({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "m2_run_empty_probe", arguments: { request_id: { toString: null } } } });
  assert.equal(JSON.parse(bad.result.content[0].text).error_code, "REQUEST_INVALID");
  assert.equal((await endpoint.request({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.length, 3);
  const input = new PassThrough(); const output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk; });
  const running = runM2CandidateStdio({ input, output });
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "m2_run_empty_probe", arguments: { request_id: { toString: null } } } }) +
    '\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await running; const lines = text.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0].result.content[0].text).error_code, "REQUEST_INVALID");
  assert.equal(lines[1].result.tools.length, 3);
});
