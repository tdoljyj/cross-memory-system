#!/usr/bin/env node
// Clued runner hook loader (Owner Decision 2026-11-16; scripts/runner/README.md). This is the one file a runner keeps, installed
// under the hook's own name (clued-runner-job-started.mjs), so wrappers, settings, keys and folder rights stay as they are. At each
// job start it reads the hook, scripts/runner/clued-runner-job-started.mjs, from the protected default branch with the hook's own
// read-only App, checks the bytes against the git blob id GitHub names, and runs them in memory (never written where a job could
// swap them). A hook upgrade is a merge into main. Anything that fails refuses the job when CLUED_RUNNER_HOOK_ENFORCE is true
// (fail closed): an unreadable main, other bytes, a hook that throws. Only node: built-ins; the bytes are pinned in its tests.
import { createHash, createSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const LOADER_VERSION = "1.0.0";
const HOOK_PATH = "scripts/runner/clued-runner-job-started.mjs";
// The admission publishing Apps never sign in on a runner (the hook refuses them too).
const PUBLISHING_APPS = ["5164952", "5368905"];
const TRANSIENT = new Set([500, 502, 503, 504]);
const DELAYS_MS = [2_000, 5_000];
const ATTEMPT_MS = 30_000;

export function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// The hook's proxy rule, for the loader's own process (the hook it runs does not restart again).
export function proxyBootstrapArguments({ env = process.env, execArgv = process.execArgv, argv = process.argv,
  allowedFlags = process.allowedNodeEnvironmentFlags } = {}) {
  const proxies = [env.HTTP_PROXY, env.http_proxy, env.HTTPS_PROXY, env.https_proxy].filter((v) => typeof v === "string" && v.trim());
  if (!proxies.length) return null;
  for (const value of proxies) {
    let protocol;
    try { protocol = new URL(value).protocol; } catch { throw new Error("The configured HTTP proxy is invalid."); }
    if (protocol !== "http:" && protocol !== "https:") throw new Error("The configured HTTP proxy protocol is unsupported.");
  }
  if (!allowedFlags.has("--use-env-proxy")) throw new Error("The installed Node runtime cannot use the configured HTTP proxy.");
  const options = env.NODE_OPTIONS ?? "";
  if (env.NODE_USE_ENV_PROXY === "0" || execArgv.includes("--no-use-env-proxy") || /(?:^|\s)--no-use-env-proxy(?:\s|$)/.test(options))
    throw new Error("Node proxy use is explicitly disabled for this execution.");
  if (env.NODE_USE_ENV_PROXY === "1" || execArgv.includes("--use-env-proxy") || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(options)) return null;
  return [...execArgv, "--use-env-proxy", ...argv.slice(1)];
}

// One GitHub call, tried again on a network fault, a timeout or 500-504 (3 attempts, 2 s and 5 s apart); any other answer is final.
async function github(fetchImpl, sleep, token, route, { method = "GET", body, expect = 200 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let failure;
    try {
      const response = await fetchImpl(`https://api.github.com${route}`, { method, signal: AbortSignal.timeout(ATTEMPT_MS),
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "clued-runner-hook-loader",
          "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status === expect) {
        const text = await response.text(); // a reply cut off here is a network fault: tried again
        try { return JSON.parse(text); } catch { throw Object.assign(new Error(`GitHub ${route.split("?")[0]} answered no JSON`), { final: true }); }
      }
      failure = new Error(`GitHub ${route.split("?")[0]} returned ${response.status}`);
      if (!TRANSIENT.has(response.status)) throw Object.assign(failure, { final: true });
    } catch (error) {
      if (error?.final) throw error;
      failure ??= error;
    }
    if (attempt > DELAYS_MS.length) throw failure;
    await sleep(DELAYS_MS[attempt - 1]);
  }
}

async function readToken({ env, fetchImpl, sleep, readFile, now, repository }) {
  const appId = (env.CLUED_RUNNER_HOOK_APP_ID ?? "").trim();
  const keyFile = (env.CLUED_RUNNER_HOOK_APP_KEY_FILE ?? "").trim();
  if (appId || keyFile) {
    if (!/^[0-9]{1,20}$/.test(appId) || PUBLISHING_APPS.includes(appId)) throw new Error(`App ${appId || "(unset)"} may not be the hook's App.`);
    const key = String(readFile(keyFile, "utf8")).trim();
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const iat = Math.floor(now() / 1000) - 60;
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 600, iss: appId })}`;
    const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key, "base64url")}`;
    const installation = await github(fetchImpl, sleep, jwt, `/repos/${repository}/installation`);
    if (!/^[0-9]{1,20}$/.test(String(installation?.id))) throw new Error(`App ${appId} has no installation on ${repository}.`);
    const minted = await github(fetchImpl, sleep, jwt, `/app/installations/${installation.id}/access_tokens`, { method: "POST", expect: 201,
      body: { repositories: [repository.split("/")[1]], permissions: { contents: "read" } } });
    if (typeof minted?.token !== "string" || !minted.token) throw new Error(`App ${appId} returned no installation token.`);
    return minted.token;
  }
  const tokenFile = (env.CLUED_RUNNER_HOOK_TOKEN_FILE ?? "").trim();
  const token = tokenFile ? String(readFile(tokenFile, "utf8")).trim() : "";
  if (!token) throw new Error("No hook App (CLUED_RUNNER_HOOK_APP_ID, CLUED_RUNNER_HOOK_APP_KEY_FILE) or token file is set on this runner.");
  return token;
}

// -> the exit code of the job-started hook.
export async function load({ env = process.env, fetchImpl = globalThis.fetch, readFile = fs.readFileSync,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
  const enforce = /^(1|true|on|enabled)$/i.test((env.CLUED_RUNNER_HOOK_ENFORCE ?? "").trim());
  let stage = "the hook could not be read from main";
  try {
    const repository = (env.CLUED_RUNNER_HOOK_REPOSITORY ?? "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("CLUED_RUNNER_HOOK_REPOSITORY is not set on this runner.");
    const branch = (env.CLUED_RUNNER_HOOK_DEFAULT_BRANCH ?? "").trim() || "main";
    const token = await readToken({ env, fetchImpl, sleep, readFile, now, repository });
    const file = await github(fetchImpl, sleep, token, `/repos/${repository}/contents/${HOOK_PATH}?ref=${encodeURIComponent(branch)}`);
    const bytes = Buffer.from(String(file?.content ?? ""), "base64");
    if (file?.type !== "file" || file.encoding !== "base64" || file.path !== HOOK_PATH || !bytes.length || gitBlobSha(bytes) !== file.sha)
      throw new Error(`${HOOK_PATH} on ${branch} is not one complete file matching its blob id`);
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    console.log(`clued-runner-hook-loader: main blob ${file.sha} sha256 ${sourceSha256} [loader ${LOADER_VERSION}]`);
    stage = "the hook from main failed";
    const hook = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
    if (typeof hook.main !== "function") throw new Error("it has no main");
    const code = await hook.main(env, fetchImpl, { sourceSha256 });
    return code === 0 ? 0 : 1;
  } catch (error) {
    const line = `clued-runner-hook-loader: ${enforce ? "REFUSE" : "WOULD REFUSE"} ${stage}: ${error instanceof Error ? error.message : String(error)} [loader ${LOADER_VERSION}]`;
    console.log(enforce ? `::error title=Clued runner check::${line}` : `::warning title=Clued runner check (not enforced)::${line}`);
    return enforce ? 1 : 0;
  }
}

if (import.meta.main) {
  let proxyArguments;
  try { proxyArguments = proxyBootstrapArguments(); } catch (error) {
    console.log(`::error title=Clued runner check::clued-runner-hook-loader: REFUSE ${error.message} [loader ${LOADER_VERSION}]`);
    process.exit(1);
  }
  if (proxyArguments) {
    const child = spawnSync(process.execPath, proxyArguments, { env: process.env, stdio: "inherit" });
    process.exit(Number.isInteger(child.status) ? child.status : 1);
  }
  load().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
}
