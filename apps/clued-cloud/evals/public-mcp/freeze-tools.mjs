import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.MCP_ISOLATED_URL ?? "http://127.0.0.1:8787/mcp";
const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
if (!response.ok) throw new Error(`tools/list failed with HTTP ${response.status}`);
const envelope = await response.json();
const tools = envelope.result?.tools;
if (!Array.isArray(tools)) throw new Error("tools/list returned no tool array.");

const baseline = { tools };
const target = path.join(here, "tools-list.baseline.json");
fs.writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(JSON.stringify({ status: "FROZEN", tool_count: tools.length, target }));
