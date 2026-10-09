import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalGatewayUrl, createLocalGatewayToken, localGatewayChildEnv } from './gateway-token.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cloudRoot = path.resolve(here, "../..");
const secretPath = path.join(here, ".dev.vars.public-mcp");

function reportedLocalStatus() {
  try {
    const statusArgs = process.platform === "linux" && process.arch === "x64"
      ? ["--yes", "--package=supabase@2.115.0", "--package=@supabase/cli-linux-x64@2.115.0",
        "supabase", "status", "--output", "json"]
      : ["--yes", "supabase@2.115.0", "status", "--output", "json"];
    const output = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      statusArgs,
      {
        cwd: cloudRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: localGatewayChildEnv(),
      },
    );
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

// `db reset` ends by restarting containers, and `status` can omit the keys
// until they are back. Wait for the key instead of failing on the first read.
async function localCredentials() {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const status = reportedLocalStatus();
    const key = status?.PUBLISHABLE_KEY ?? status?.ANON_KEY;
    if (key && status.JWT_SECRET) {
      const origin = assertLocalGatewayUrl(status.API_URL);
      const config = JSON.parse(fs.readFileSync(path.join(here, 'wrangler.jsonc'), 'utf8'));
      if (assertLocalGatewayUrl(config.vars.SUPABASE_URL) !== origin) {
        throw new Error('isolated Worker and local Supabase origins differ');
      }
      return { key, gateway: createLocalGatewayToken({ apiUrl: origin, jwtSecret: status.JWT_SECRET }) };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Local Supabase did not report a publishable key and JWT_SECRET.");
}

const credentials = await localCredentials();
fs.writeFileSync(secretPath, `SUPABASE_PUBLISHABLE_KEY=${credentials.key}\nCLUED_DB_GATEWAY_TOKEN=${credentials.gateway}\n`, { mode: 0o600 });

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
  env: localGatewayChildEnv(process.env, { WRANGLER_LOG_PATH: path.join(cloudRoot, ".wrangler", "public-mcp.log") }),
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
child.on('error', () => { cleanup(); process.exitCode = 1; });
process.on("exit", cleanup);
