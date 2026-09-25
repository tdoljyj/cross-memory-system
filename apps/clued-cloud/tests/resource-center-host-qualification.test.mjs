import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RESOURCE_CENTER_BOUNDARY_SCAN_TOOL,
  RESOURCE_CENTER_MUTATION_TOOL,
  createResourceCenterGovernedToolSurface,
} from "../../../kernel/host/resource-center-governed-tool-surface.mjs";
import { qualifyResourceCenterHost } from "../../../kernel/host/resource-center-host-qualification.mjs";
import { createResourceCenterFilesystemToolHost } from "../../../kernel/host/resource-center-filesystem-tool-host.mjs";

const trustedProfile = Object.freeze({
  registration_status: "registered",
  profile_id: "resource-center-primary",
  profile_version: "resource-center-profile/1",
  managed_root: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3",
  boundary_scan_roots: ["G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8"],
});

function controlledSurface(overrides = {}) {
  const calls = [];
  const adapter = {
    profile_identity: Object.freeze({ profile_id: trustedProfile.profile_id }),
    guardedMutation: async (mutation) => {
      calls.push(mutation);
      return { status: "committed", mutation };
    },
    scanBoundary: async () => [],
    ...overrides,
  };
  return { calls, surface: createResourceCenterGovernedToolSurface({ adapter }) };
}

test("controlled Host surface hides admissions and injects the fixed artifact role", async () => {
  const { calls, surface } = controlledSurface();
  const listed = surface.listTools();
  assert.deepEqual(listed.map((tool) => tool.name), [
    RESOURCE_CENTER_MUTATION_TOOL,
    RESOURCE_CENTER_BOUNDARY_SCAN_TOOL,
  ]);
  assert.equal(Object.hasOwn(listed[0].inputSchema.properties, "admission"), false);
  assert.equal(Object.hasOwn(listed[0].inputSchema.properties, "artifact_role"), false);
  assert.equal(Object.hasOwn(listed[0].inputSchema.properties, "managed_root"), false);

  const result = await surface.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "move",
    source_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/90_\u5f85\u5f52\u7c7b/a.md",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/topic/a.md",
  });
  assert.equal(result.status, "committed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].artifact_role, "clued_resource");
  assert.equal(Object.isFrozen(calls[0]), true);
});

test("controlled Host surface rejects caller-owned admission and authority fields", async () => {
  const { calls, surface } = controlledSurface();
  for (const field of ["admission", "managed_root", "profile_id", "currentness_identity", "workspace_version"]) {
    const result = await surface.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
      operation: "write",
      destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md",
      [field]: "attacker",
    });
    assert.equal(result.error_code, "CONTROLLED_TOOL_ARGUMENTS_INVALID");
    assert.equal(result.field, field);
  }
  assert.equal(calls.length, 0);
});

test("Remote Desktop Commander 0.2.51 is deterministically not qualified", () => {
  const result = qualifyResourceCenterHost({
    trusted_profile: trustedProfile,
    config: { allowedDirectories: [] },
    tools: [
      { name: "write_file", inputSchema: { type: "object" } },
      { name: "write_pdf", inputSchema: { type: "object" } },
      { name: "create_directory", inputSchema: { type: "object" } },
      { name: "move_file", inputSchema: { type: "object" } },
      { name: "edit_block", inputSchema: { type: "object" } },
      { name: "start_process", inputSchema: { type: "object" } },
    ],
  });
  assert.equal(result.status, "not_qualified");
  assert.deepEqual(new Set(result.findings.map((item) => item.code)), new Set([
    "GOVERNED_MUTATION_TOOL_MISSING",
    "BOUNDARY_SCAN_TOOL_MISSING",
    "OPEN_WORLD_PROCESS_TOOL_EXPOSED",
    "GENERIC_MUTATION_SCOPE_UNPROVEN",
  ]));
});

test("the controlled surface qualifies without a generic bypass", () => {
  const { surface } = controlledSurface();
  const result = qualifyResourceCenterHost({
    trusted_profile: trustedProfile,
    tools: surface.listTools(),
    config: { allowedDirectories: [] },
  });
  assert.equal(result.status, "qualified");
  assert.deepEqual(result.findings, []);
});

test("qualification rejects generic mutation overlap and open process escape", () => {
  const { surface } = controlledSurface();
  const result = qualifyResourceCenterHost({
    trusted_profile: trustedProfile,
    tools: [
      ...surface.listTools(),
      { name: "remote.write_file", inputSchema: { type: "object" } },
      { name: "remote.start_process", inputSchema: { type: "object" } },
    ],
    config: { allowedDirectories: ["G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/other"] },
  });
  assert.equal(result.status, "not_qualified");
  assert.equal(result.findings.some((item) =>
    item.code === "GENERIC_MUTATION_SCOPE_OVERLAPS_GOVERNED_BOUNDARY"), true);
  assert.equal(result.findings.some((item) => item.code === "OPEN_WORLD_PROCESS_TOOL_EXPOSED"), true);
});

test("qualification detects prefixed generic writer and process tool names", () => {
  const { surface } = controlledSurface();
  const result = qualifyResourceCenterHost({
    trusted_profile: trustedProfile,
    tools: [
      ...surface.listTools(),
      { name: "mcp__codex_apps__remote_desktop_commander_write_file", inputSchema: { type: "object" } },
      { name: "mcp__codex_apps__remote_desktop_commander_start_process", inputSchema: { type: "object" } },
    ],
    config: { allowedDirectories: [] },
  });
  assert.equal(result.status, "not_qualified");
  assert.equal(result.findings.some((item) => item.code === "GENERIC_MUTATION_SCOPE_UNPROVEN"), true);
  assert.equal(result.findings.some((item) => item.code === "OPEN_WORLD_PROCESS_TOOL_EXPOSED"), true);
});

test("qualification rejects invalid or relative generic writer scopes", () => {
  const { surface } = controlledSurface();
  for (const allowedDirectories of [[""], ["relative/output"], ["D:/isolated-output", null]]) {
    const result = qualifyResourceCenterHost({
      trusted_profile: trustedProfile,
      tools: [...surface.listTools(), { name: "write_file", inputSchema: { type: "object" } }],
      config: { allowedDirectories },
    });
    assert.equal(result.status, "not_qualified");
    assert.equal(result.findings.some((item) => item.code === "GENERIC_MUTATION_SCOPE_UNPROVEN"), true);
  }
});

test("qualification permits a generic file tool only when its scope is provably isolated", () => {
  const { surface } = controlledSurface();
  const result = qualifyResourceCenterHost({
    trusted_profile: trustedProfile,
    tools: [
      ...surface.listTools(),
      { name: "write_file", inputSchema: { type: "object" } },
    ],
    config: { allowedDirectories: ["D:/isolated-non-clued-output"] },
  });
  assert.equal(result.status, "qualified");
});

test("qualification rejects transport-visible admissions and authority fields", () => {
  const { surface } = controlledSurface();
  const mutated = surface.listTools().map((tool) => tool.name === RESOURCE_CENTER_MUTATION_TOOL
    ? {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          admission: { type: "object" },
          currentness_identity: { type: "string" },
        },
      },
    }
    : tool);
  const result = qualifyResourceCenterHost({
    trusted_profile: trustedProfile,
    tools: mutated,
  });
  assert.equal(result.status, "not_qualified");
  assert.equal(result.findings.some((item) => item.code === "CALLER_ADMISSION_FIELD_EXPOSED"), true);
  assert.equal(result.findings.some((item) =>
    item.code === "CALLER_AUTHORITY_FIELD_EXPOSED" && item.field === "currentness_identity"), true);
});

test("qualification rejects separately exposed preflight or commit tools", () => {
  const { surface } = controlledSurface();
  const result = qualifyResourceCenterHost({
    trusted_profile: trustedProfile,
    tools: [
      ...surface.listTools(),
      { name: "clued_resource_center_preflight", inputSchema: { type: "object", properties: {} } },
      { name: "clued_resource_center_commitMutation", inputSchema: { type: "object", properties: {} } },
    ],
  });
  assert.equal(result.status, "not_qualified");
  assert.equal(result.findings.filter((item) => item.code === "GATE_INTERNAL_TOOL_EXPOSED").length, 2);
});

test("official filesystem tool Host keeps admission internal and denies 00_\u73b0\u884c\u57fa\u7ebf before mutation", async (t) => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "clued-resource-center-tool-host-"));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const managedRoot = path.join(sandbox, "Clued_\u8d44\u6599\u4e2d\u5fc3");
  const topicRoot = path.join(managedRoot, "20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c", "\u54c1\u724c\u4e0e\u89c6\u89c9");
  await fs.mkdir(topicRoot, { recursive: true });
  const host = createResourceCenterFilesystemToolHost({
    trusted_profile: {
      registration_status: "registered",
      profile_id: "filesystem-tool-host-test",
      profile_version: "resource-center-profile/2",
      managed_root: managedRoot,
      allowed_root_children: ["20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c", "90_\u5f85\u5f52\u7c7b"],
      boundary_scan_roots: [sandbox],
    },
    resolve_artifact: () => ({
      artifact_id: "artifact:tool-host-test",
      artifact_role: "clued_resource",
      governance_class: "ordinary",
      delete_authority: false,
      authority_version: "artifact-registry/1",
      currentness_identity: "canonical:cv_155",
      workspace_version: "snapshot:test",
    }),
  });
  assert.equal(host.qualification.status, "qualified");
  assert.equal(Object.hasOwn(host, "preflight"), false);
  assert.equal(Object.hasOwn(host, "commitMutation"), false);

  const forbidden = path.join(topicRoot, "00_\u73b0\u884c\u57fa\u7ebf");
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create",
    destination_path: forbidden,
    target_kind: "directory",
    directory_semantics: "topic",
  });
  assert.equal(result.error_code, "STATUS_SEMANTIC_DIRECTORY_FORBIDDEN");
  await assert.rejects(fs.stat(forbidden), { code: "ENOENT" });

  const inbox = path.join(managedRoot, "90_\u5f85\u5f52\u7c7b");
  const source = path.join(inbox, "a.md");
  const destination = path.join(topicRoot, "a.md");
  await fs.mkdir(inbox, { recursive: true });
  await fs.writeFile(source, "normal track to topic");
  const moved = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "move",
    source_path: source,
    destination_path: destination,
  });
  assert.equal(moved.status, "committed");
  assert.equal(await fs.readFile(destination, "utf8"), "normal track to topic");

  const secondSource = path.join(inbox, "b.md");
  await fs.writeFile(secondSource, "must not overwrite");
  await assert.rejects(host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "move",
    source_path: secondSource,
    destination_path: destination,
  }), { code: "DESTINATION_ALREADY_EXISTS" });
  assert.equal(await fs.readFile(destination, "utf8"), "normal track to topic");
  assert.equal(await fs.readFile(secondSource, "utf8"), "must not overwrite");

  await fs.mkdir(path.join(sandbox, "Clued_\u5b64\u5c9b"));
  const violations = await host.callTool(RESOURCE_CENTER_BOUNDARY_SCAN_TOOL, {});
  assert.equal(violations.some((item) => item.code === "UNAUTHORIZED_WORKSPACE_MUTATION"), true);
});
