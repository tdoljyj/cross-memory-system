// Synthetic provider/credential fixtures only. A built candidate and mock HTTP
// prove transport behavior, not live Host qualification or storage authority.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build, stop } from "esbuild";
import { RESOURCE_CENTER_MUTATION_TOOL as TOOL } from "../../../kernel/host/resource-center-governed-tool-surface.mjs";

test("built daily consumer sends authority, writer and settlement inspection only to the fixed Kooyumi origin", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kooyumi-daily-origin-")), bundle = path.join(dir, "runner.mjs");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  try {
    await build({ entryPoints: [fileURLToPath(new URL("../scripts/resource-center-daily-runner.mjs", import.meta.url))],
      outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  } finally { await stop(); }
  const { createDailyNativeWriterToolHost, createDailySettlementInspector } = await import(pathToFileURL(bundle));
  const reader = "clued_rcb_" + "a".repeat(40), writer = "clued_rcw_" + "b".repeat(40), root = "G:/review/Clued_资料中心";
  const profile = { registration_status: "registered", profile_id: randomUUID(), profile_version: "fixture/1",
    managed_root: root, allowed_root_children: ["track"] };
  const authority = { artifact_id: null, artifact_role: "clued_resource", governance_class: "ordinary",
    delete_authority: false, authority_version: "authority/1", currentness_identity: "decision/1", workspace_version: "canonical/1" };
  const timeouts = new WeakMap(), originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", ms => { const signal = originalTimeout.call(AbortSignal, ms);timeouts.set(signal, ms);return signal; });
  const calls = [], recovery = [];
  const transport = async (url, options) => {
    const body = JSON.parse(options.body), request = body.request;
    calls.push({ url, options, body, timeout: timeouts.get(options.signal) });
    if (url.endsWith("/authority")) return Response.json({ contract: request.contract, status: "resolved",
      request, request_sha256: body.request_sha256, authority });
    return Response.json({ ...body, outcome: { status: "denied" } });
  };
  const info = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
  let providerWrites = 0;
  const host = createDailyNativeWriterToolHost({ trusted_profile: profile, root_folder_id: "root", root_parent_id: "container",
    // Even Host options cannot move these fixed service endpoints.
    authority_endpoint: "https://clued.pixelgrav.com/v1/resource-center/authority",
    writer_endpoint: "https://clued.pixelgrav.com/v1/resource-center/write",
    authority_binding_token: reader, writer_binding_token: writer, authority_fetch: transport,
    get_drive_credential: async () => ({ access_token: "synthetic-provider-token", scope:
      "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly" }),
    persist_recovery: async ticket => recovery.push(ticket), persist_provider_attempt: async () => {},
    drive_fetch: async (url, options) => {
      if (options.method === "POST") { providerWrites++;throw Error("PROVIDER_EFFECT_FORBIDDEN"); }
      const parsed = new URL(url);
      if (parsed.searchParams.get("fields") === "id,shared,permissionIds")
        return Response.json({ id: parsed.pathname.split("/").at(-1), shared: false, permissionIds: ["owner"] });
      if (parsed.pathname.endsWith("/root")) return Response.json(info("root", "Clued_资料中心", "container"));
      const q = parsed.searchParams.get("q") ?? "";
      if (q.includes("'root' in parents")) return Response.json({ files: [info("track", "track", "root")] });
      if (q.includes("'track' in parents")) return Response.json({ files: [info("topic", "topic", "track")] });
      return Response.json({ files: [] });
    } });
  const result = await host.callTool(TOOL, { operation: "create", destination_path: root + "/track/topic/new.txt", target_kind: "file", content: "fixture" });
  assert.ok(result.error_code, "the denied reservation never becomes a successful provider write");
  assert.equal(providerWrites, 0);assert.equal(recovery.length, 1);
  assert.ok(calls.some(c => c.url.endsWith("/authority")));
  assert.equal(calls.filter(c => c.url.endsWith("/write")).length, 1);
  for (const c of calls) {
    const resolver = c.url.endsWith("/authority");
    assert.equal(c.url, "https://kooyumi.pixelgrav.com/v1/resource-center/" + (resolver ? "authority" : "write"));
    assert.equal(c.options.headers.authorization, "Bearer " + (resolver ? reader : writer));
    assert.equal(c.options.method, "POST");assert.equal(c.options.redirect, "error");assert.equal(c.options.cache, "no-store");
    assert.equal(c.timeout, resolver ? 5000 : 10000);
    assert.equal(resolver ? c.body.request.contract : c.body.contract, resolver ? "clued.resource-center-authority/1" : "clued.resource-center-write/1");
  }
  const inspections = [], ticket = { contract: "clued.resource-center-recovery/1", request_key: randomUUID(), request_sha256: "c".repeat(64) };
  const inspector = createDailySettlementInspector(writer, async (url, options) => {
    inspections.push({ url, options });return Response.json({ ...JSON.parse(options.body), outcome: { status: "committed", receipt_id: "synthetic-receipt" } });
  });
  assert.equal((await inspector.inspect_recovery(ticket)).status, "committed");
  assert.equal(inspections.length, 1);assert.equal(inspections[0].url, "https://kooyumi.pixelgrav.com/v1/resource-center/write");
  assert.equal(inspections[0].options.headers.authorization, "Bearer " + writer);assert.equal(inspections[0].options.redirect, "error");
  assert.equal(timeouts.get(inspections[0].options.signal), 10000);
  assert.equal(JSON.parse(inspections[0].options.body).request.action, "inspect");
  await assert.rejects(inspector.prepare_write({ profile, mutation: { operation: "create" } }), /DAILY_SETTLEMENT_READ_ONLY/);
  assert.equal(inspections.length, 1, "settlement cannot prepare or start a provider operation");
  assert.throws(() => createDailySettlementInspector("clued_bnd_" + "a".repeat(40)), /dedicated writer Binding/);
  const failed = [];
  await assert.rejects(createDailySettlementInspector(writer, async url => { failed.push(url);throw Error("offline"); }).inspect_recovery(ticket), /offline/);
  assert.deepEqual(failed, ["https://kooyumi.pixelgrav.com/v1/resource-center/write"], "no legacy fallback after a failure");
});
