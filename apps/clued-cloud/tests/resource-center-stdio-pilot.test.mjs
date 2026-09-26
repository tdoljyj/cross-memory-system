import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";

import { createResourceCenterStdioPilot } from "../../../kernel/host/resource-center-stdio-pilot.mjs";
import {
  RESOURCE_CENTER_BOUNDARY_SCAN_TOOL,
  RESOURCE_CENTER_MUTATION_TOOL,
} from "../../../kernel/host/resource-center-governed-tool-surface.mjs";
import { qualifyResourceCenterHost } from "../../../kernel/host/resource-center-host-qualification.mjs";
import { loadPinnedPilotProfile } from "../scripts/resource-center-stdio-pilot.mjs";

const serverPath = fileURLToPath(new URL("../scripts/resource-center-stdio-pilot.mjs", import.meta.url));

function profileFor(root) {
  return {
    registration_status: "registered",
    profile_id: "resource-center-stdio-pilot-test",
    profile_version: "pilot/1",
    managed_root: path.join(root, "Clued_资料中心"),
    allowed_root_children: ["20_P_产品与体验", "90_待归类"],
    boundary_scan_roots: [root],
  };
}

test("pilot exposes only canonical tools and denies mutation before any filesystem effect", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clued-pilot-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = profileFor(root);
  await fs.mkdir(profile.managed_root);
  const pilot = createResourceCenterStdioPilot({ trusted_profile: profile });
  assert.deepEqual(pilot.listTools().map((tool) => tool.name), [
    RESOURCE_CENTER_MUTATION_TOOL,
    RESOURCE_CENTER_BOUNDARY_SCAN_TOOL,
  ]);
  assert.equal(qualifyResourceCenterHost({ trusted_profile: profile, tools: pilot.listTools() }).status,
    "qualified");

  const destination = path.join(profile.managed_root, "20_P_产品与体验");
  const denied = await pilot.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create",
    destination_path: destination,
    target_kind: "directory",
    directory_semantics: "track",
  });
  assert.deepEqual(denied, {
    status: "deny",
    error_code: "TRUSTED_ARTIFACT_CURRENTNESS_RESOLVER_UNAVAILABLE",
    side_effects: 0,
  });
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("pinned profile rejects changed bytes and caller-added authority fields", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clued-pilot-pin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "profile.json");
  const bytes = Buffer.from(JSON.stringify(profileFor(root)), "utf8");
  await fs.writeFile(profilePath, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal((await loadPinnedPilotProfile(profilePath, digest)).profile_id,
    "resource-center-stdio-pilot-test");
  await assert.rejects(loadPinnedPilotProfile(profilePath, "0".repeat(64)),
    { code: "PILOT_PROFILE_HASH_MISMATCH" });
  const extra = Buffer.from(JSON.stringify({ ...profileFor(root), delete_authority: true }), "utf8");
  await fs.writeFile(profilePath, extra);
  await assert.rejects(loadPinnedPilotProfile(profilePath,
    createHash("sha256").update(extra).digest("hex")),
  { code: "PILOT_PROFILE_SHAPE_INVALID" });
});

test("stdio MCP pilot roundtrip is read-only and scans sibling islands deterministically", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clued-pilot-mcp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = profileFor(root);
  await fs.mkdir(profile.managed_root);
  const profilePath = path.join(root, "profile.json");
  const bytes = Buffer.from(JSON.stringify(profile), "utf8");
  await fs.writeFile(profilePath, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const client = new Client({ name: "resource-center-pilot-test", version: "1.0.0" }, {
    capabilities: {},
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, profilePath, digest],
    cwd: path.resolve("."),
  });
  await client.connect(transport);
  t.after(async () => client.close());
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    RESOURCE_CENTER_MUTATION_TOOL,
    RESOURCE_CENTER_BOUNDARY_SCAN_TOOL,
  ]);

  const destination = path.join(profile.managed_root, "20_P_产品与体验");
  const denied = await client.callTool({ name: RESOURCE_CENTER_MUTATION_TOOL, arguments: {
    operation: "create",
    destination_path: destination,
    target_kind: "directory",
    directory_semantics: "track",
  } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.result.error_code,
    "TRUSTED_ARTIFACT_CURRENTNESS_RESOLVER_UNAVAILABLE");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });

  await fs.mkdir(path.join(root, "Clued_孤岛"));
  const scan = await client.callTool({ name: RESOURCE_CENTER_BOUNDARY_SCAN_TOOL, arguments: {} });
  assert.equal(scan.isError, false);
  assert.equal(scan.structuredContent.result.some((item) =>
    item.code === "UNAUTHORIZED_WORKSPACE_MUTATION"), true);
});

test("self-contained bundle keeps the same fail-closed MCP tool surface", { timeout: 10_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clued-pilot-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = profileFor(root);
  await fs.mkdir(profile.managed_root);
  const profilePath = path.join(root, "profile.json");
  const bytes = Buffer.from(JSON.stringify(profile), "utf8");
  await fs.writeFile(profilePath, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const bundlePath = path.join(root, "host.mjs");
  await build({
    entryPoints: [serverPath],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    logLevel: "silent",
  });
  const client = new Client({ name: "resource-center-bundle-test", version: "1.0.0" }, {
    capabilities: {},
  });
  t.after(async () => client.close());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundlePath, profilePath, digest],
    cwd: root,
    stderr: "pipe",
  });
  let childStderr = "";
  transport.stderr?.on("data", (chunk) => { childStderr += chunk.toString(); });
  await client.connect(transport);
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
      RESOURCE_CENTER_MUTATION_TOOL,
      RESOURCE_CENTER_BOUNDARY_SCAN_TOOL,
    ]);
    const result = await client.callTool({
      name: RESOURCE_CENTER_MUTATION_TOOL,
      arguments: { operation: "delete", source_path: path.join(profile.managed_root, "missing.md") },
    });
    assert.equal(result.structuredContent.result.error_code,
      "TRUSTED_ARTIFACT_CURRENTNESS_RESOLVER_UNAVAILABLE");
  } catch (error) {
    throw new Error(`Bundled MCP roundtrip failed: ${error.message}; stderr=${childStderr}`);
  } finally {
    await client.close();
  }
});
