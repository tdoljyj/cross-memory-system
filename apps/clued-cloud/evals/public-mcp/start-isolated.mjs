import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cloudRoot = path.resolve(here, "../..");
const secretPath = path.join(here, ".dev.vars.public-mcp");

function reportedPublishableKey() {
  try {
    const output = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["--yes", "supabase@2.115.0", "status", "--output", "json"],
      {
        cwd: cloudRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );
    const status = JSON.parse(output);
    return status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  } catch {
    return undefined;
  }
}

// `db reset` ends by restarting containers, and `status` can omit the keys
// until they are back. Wait for the key instead of failing on the first read.
async function localPublishableKey() {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const key = reportedPublishableKey();
    if (key) return key;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Local Supabase did not report a publishable key.");
}

fs.writeFileSync(secretPath, `SUPABASE_PUBLISHABLE_KEY=${await localPublishableKey()}\n`, { mode: 0o600 });

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(command, [
  "wrangler", "dev",
  "--config", "evals/public-mcp/wrangler.jsonc",
  "--env", "public-mcp",
  "--port", process.env.MCP_ISOLATED_PORT ?? "8787",
  "--local",
  "--show-interactive-dev-session", "false",
  "--log-level", "error",
], {
  cwd: cloudRoot,
  env: { ...process.env, WRANGLER_LOG_PATH: path.join(cloudRoot, ".wrangler", "public-mcp.log") },
  stdio: "inherit",
  shell: process.platform === "win32",
});

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  fs.rmSync(secretPath, { force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
process.on("exit", cleanup);
