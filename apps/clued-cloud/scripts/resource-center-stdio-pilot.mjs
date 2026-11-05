import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createResourceCenterStdioPilot } from "../../../kernel/host/resource-center-stdio-pilot.mjs";

const PROFILE_FIELDS = new Set([
  "registration_status",
  "profile_id",
  "profile_version",
  "managed_root",
  "allowed_root_children",
  "boundary_scan_roots",
  "boundary_scan_max_depth",
  "boundary_scan_max_entries",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/** The pinned file and digest are Host launch inputs, never mutation arguments. */
export async function loadPinnedPilotProfile(profilePath, expectedSha256) {
  if (typeof profilePath !== "string" || !path.isAbsolute(profilePath) ||
    !/^[a-f0-9]{64}$/i.test(expectedSha256 ?? "")) {
    fail("PILOT_PROFILE_PIN_INVALID");
  }
  const bytes = await fs.readFile(profilePath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) fail("PILOT_PROFILE_HASH_MISMATCH");
  let profile;
  try {
    profile = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("PILOT_PROFILE_JSON_INVALID");
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile) ||
    Object.keys(profile).some((key) => !PROFILE_FIELDS.has(key)) ||
    profile.registration_status !== "registered" ||
    typeof profile.profile_id !== "string" || !profile.profile_id.trim() ||
    typeof profile.profile_version !== "string" || !profile.profile_version.trim() ||
    typeof profile.managed_root !== "string" || !path.isAbsolute(profile.managed_root) ||
    !Array.isArray(profile.allowed_root_children) ||
    profile.allowed_root_children.some((value) => typeof value !== "string" || !value.trim()) ||
    !Array.isArray(profile.boundary_scan_roots) ||
    profile.boundary_scan_roots.some((value) => typeof value !== "string" || !path.isAbsolute(value))) {
    fail("PILOT_PROFILE_SHAPE_INVALID");
  }
  return Object.freeze({
    ...profile,
    allowed_root_children: Object.freeze([...profile.allowed_root_children]),
    boundary_scan_roots: Object.freeze([...profile.boundary_scan_roots]),
  });
}

export function createPilotMcpServer(pilot) {
  const server = new Server({ name: "clued-resource-center-stdio-pilot", version: "0.1.0" }, {
    capabilities: { tools: {} },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: pilot.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await pilot.callTool(request.params.name, request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { result },
        isError: result?.status === "deny",
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "RESOURCE_CENTER_PILOT_CALL_FAILED";
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "deny", error_code: code }) }],
        structuredContent: { result: { status: "deny", error_code: code } },
        isError: true,
      };
    }
  });
  return server;
}

export async function startPilotServer(profilePath, expectedSha256) {
  const trustedProfile = await loadPinnedPilotProfile(profilePath, expectedSha256);
  const pilot = createResourceCenterStdioPilot({ trusted_profile: trustedProfile });
  const server = createPilotMcpServer(pilot);
  await server.connect(new StdioServerTransport());
  return server;
}

if (import.meta.main) {
  startPilotServer(process.argv[2], process.argv[3]).catch((error) => {
    process.stderr.write(`${error?.code ?? "RESOURCE_CENTER_PILOT_START_FAILED"}\n`);
    process.exitCode = 1;
  });
}
