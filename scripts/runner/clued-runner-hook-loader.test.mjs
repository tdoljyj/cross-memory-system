// The runner hook loader (Owner Decision 2026-11-16, review REVIEW-fable-runner-hook-20261116 §3.1). Each runner keeps only the
// loader; at every job start it takes the hook from the protected default branch with the hook's own read-only App, checks it
// against its git blob id, and runs it in memory. A hook upgrade is a merge into main: no runner is touched again.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { LOADER_VERSION, gitBlobSha, load, proxyBootstrapArguments } from "./clued-runner-hook-loader.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const API = "https://api.github.com/repos/o/r";
const CONTENTS = `${API}/contents/scripts/runner/clued-runner-job-started.mjs?ref=main`;
const env = (overrides = {}) => ({ CLUED_RUNNER_HOOK_REPOSITORY: "o/r", CLUED_RUNNER_HOOK_TOKEN_FILE: "/token",
  CLUED_RUNNER_HOOK_ENFORCE: "true", GITHUB_REPOSITORY: "o/r", ...overrides });
// GitHub's contents reply: base64 in lines of 60, and the blob id of the bytes.
const contents = (source, overrides = {}) => {
  const bytes = Buffer.from(source);
  return { status: 200, body: { type: "file", encoding: "base64", path: "scripts/runner/clued-runner-job-started.mjs",
    content: bytes.toString("base64").replace(/.{60}/g, "$&\n"), sha: gitBlobSha(bytes), ...overrides } };
};
// A stand-in hook: records each run, prints its version line as the real hook does.
let unique = 0;
const hookSource = (version, body = "return 0;") => `// ${unique++}
export const HOOK_VERSION = ${JSON.stringify(version)};
export async function main(env, fetchImpl, options) {
  (globalThis.__hookRuns ??= []).push({ version: HOOK_VERSION, sourceSha256: options?.sourceSha256 ?? null, repo: env.CLUED_RUNNER_HOOK_REPOSITORY });
  console.log("clued-runner-hook: ALLOW test [hook " + HOOK_VERSION + "]");
  ${body}
}`;
function fakeGitHub(replies) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null, auth: init.headers?.authorization });
    const key = Object.keys(replies).filter((k) => String(url).startsWith(k)).sort((a, b) => b.length - a.length)[0];
    let r = key ? replies[key] : { status: 500, body: null };
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
    if (typeof r === "function") r = r();
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
  };
  return { fetchImpl, calls };
}
async function run(replies, overrides = {}, extra = {}) {
  const gh = fakeGitHub(replies);
  const sleeps = [];
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  globalThis.__hookRuns = [];
  let code;
  try {
    code = await load({ env: env(overrides), fetchImpl: gh.fetchImpl, readFile: (p) => (p === "/token" ? "ghs_read\n" : fs.readFileSync(p, "utf8")),
      sleep: async (ms) => { sleeps.push(ms); }, ...extra });
  } finally { console.log = log; console.error = err; }
  return { code, lines, sleeps, calls: gh.calls, runs: globalThis.__hookRuns };
}
const contentCalls = (calls) => calls.filter((c) => c.url.startsWith(`${API}/contents/`));

test("target: the same installed loader runs whatever hook main holds at each job start (X, then Y), no file on the runner changes", async () => {
  const x = hookSource("X");
  const y = hookSource("Y");
  const first = await run({ [CONTENTS]: contents(x) });
  const second = await run({ [CONTENTS]: contents(y) });
  assert.deepEqual([first.code, second.code], [0, 0]);
  assert.ok(first.lines.some((l) => l.endsWith("[hook X]")), first.lines.join("\n"));
  assert.ok(second.lines.some((l) => l.endsWith("[hook Y]")), second.lines.join("\n"));
  const sha = createHash("sha256").update(x).digest("hex");
  assert.equal(first.lines[0], `clued-runner-hook-loader: main blob ${gitBlobSha(Buffer.from(x))} sha256 ${sha} [loader ${LOADER_VERSION}]`);
  // The hook reports the bytes it was loaded from (its clued-r9-pre-job source_sha256), not a file on disk.
  assert.deepEqual(first.runs, [{ version: "X", sourceSha256: sha, repo: "o/r" }]);
  // The default branch only, by name: never a pull request's ref.
  assert.deepEqual(contentCalls(first.calls).map((c) => [c.url, c.method, c.auth]), [[CONTENTS, "GET", "Bearer ghs_read"]]);
});

test("integrity: bytes that are not the blob GitHub names, or a reply that is not one base64 file, refuse; the hook never runs", async () => {
  const x = hookSource("X");
  for (const [label, reply] of [
    ["blob id of other bytes", contents(x, { sha: gitBlobSha(Buffer.from("other")) })],
    ["no blob id", contents(x, { sha: undefined })],
    ["a directory", contents(x, { type: "dir" })],
    ["not base64", contents(x, { encoding: "none" })],
    ["empty (too large for the contents API)", contents(x, { content: "" })],
    ["another path", contents(x, { path: "scripts/runner/other.mjs" })],
  ]) {
    const r = await run({ [CONTENTS]: reply });
    assert.equal(r.code, 1, label);
    assert.deepEqual(r.runs, [], label);
    assert.match(r.lines.at(-1), /^::error title=Clued runner check::clued-runner-hook-loader: REFUSE .* \[loader 1\.0\.0\]$/, label);
  }
});

test("reads: network faults and 500-504 are tried again (3 attempts, 2 s and 5 s apart); 401/403/404/429 are final at once", async () => {
  const x = hookSource("X");
  const once = await run({ [CONTENTS]: [{ status: 502 }, contents(x)] });
  assert.deepEqual([once.code, once.sleeps, contentCalls(once.calls).length], [0, [2000], 2]);
  const cut = await run({ [CONTENTS]: [new TypeError("fetch failed"), new TypeError("fetch failed"), contents(x)] });
  assert.deepEqual([cut.code, cut.sleeps, contentCalls(cut.calls).length], [0, [2000, 5000], 3]);
  const always = await run({ [CONTENTS]: { status: 503 } });
  assert.deepEqual([always.code, always.sleeps, contentCalls(always.calls).length], [1, [2000, 5000], 3]);
  assert.match(always.lines.at(-1), /returned 503/);
  for (const status of [401, 403, 404, 429]) {
    const r = await run({ [CONTENTS]: { status } });
    assert.deepEqual([status, r.code, r.sleeps, contentCalls(r.calls).length], [status, 1, [], 1]);
  }
  // Not enforced: the same failure only warns.
  const advisory = await run({ [CONTENTS]: { status: 404 } }, { CLUED_RUNNER_HOOK_ENFORCE: "" });
  assert.equal(advisory.code, 0);
  assert.match(advisory.lines.at(-1), /^::warning title=Clued runner check \(not enforced\)::clued-runner-hook-loader: WOULD REFUSE/);
});

test("the hook: one that throws on import or has no main refuses; its own verdict passes through; a rejected main refuses", async () => {
  const boom = await run({ [CONTENTS]: contents(`// ${unique++}\nthrow new Error("boom");`) });
  assert.equal(boom.code, 1);
  assert.match(boom.lines.at(-1), /^::error .*REFUSE the hook from main failed: boom/);
  const advisory = await run({ [CONTENTS]: contents(`// ${unique++}\nthrow new Error("boom");`) }, { CLUED_RUNNER_HOOK_ENFORCE: "false" });
  assert.equal(advisory.code, 0);
  assert.match(advisory.lines.at(-1), /^::warning /);
  assert.equal((await run({ [CONTENTS]: contents(`// ${unique++}\nexport const HOOK_VERSION = "N";`) })).code, 1);
  assert.equal((await run({ [CONTENTS]: contents(hookSource("R", "return 1;")) })).code, 1, "the hook's REFUSE");
  const rejected = await run({ [CONTENTS]: contents(hookSource("J", "throw new Error('late');")) });
  assert.equal(rejected.code, 1);
  assert.match(rejected.lines.at(-1), /REFUSE the hook from main failed: late/);
});

test("configuration: no repository refuses; the hook's own App mints a contents-read token; the admission Apps are refused", async () => {
  const x = hookSource("X");
  assert.equal((await run({ [CONTENTS]: contents(x) }, { CLUED_RUNNER_HOOK_REPOSITORY: "" })).code, 1);
  assert.equal((await run({ [CONTENTS]: contents(x) }, { CLUED_RUNNER_HOOK_TOKEN_FILE: "" })).code, 1);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const app = { CLUED_RUNNER_HOOK_APP_ID: "5231716", CLUED_RUNNER_HOOK_APP_KEY_FILE: "/key.pem", CLUED_RUNNER_HOOK_TOKEN_FILE: "" };
  const readFile = (p) => (p === "/key.pem" ? pem : "");
  const replies = { [`${API}/installation`]: { body: { id: 42 } },
    "https://api.github.com/app/installations/42/access_tokens": [{ status: 502 }, { status: 201, body: { token: "ghs_app" } }], [CONTENTS]: contents(x) };
  const r = await run(replies, app, { readFile });
  assert.equal(r.code, 0, r.lines.join("\n"));
  const mint = r.calls.filter((c) => c.url.endsWith("/access_tokens"));
  assert.equal(mint.length, 2, "the token mint is a read: tried again");
  assert.deepEqual(JSON.parse(mint[1].body), { repositories: ["r"], permissions: { contents: "read" } });
  assert.equal(contentCalls(r.calls)[0].auth, "Bearer ghs_app");
  for (const id of ["5164952", "5368905"]) {
    const refused = await run(replies, { ...app, CLUED_RUNNER_HOOK_APP_ID: id }, { readFile });
    assert.equal(refused.code, 1, id);
    assert.equal(refused.calls.length, 0, `${id}: nothing is asked of GitHub`);
  }
});

test("proxy: the loader restarts itself with Node's proxy support; a runtime without it or an opt-out refuses", () => {
  const base = { env: {}, execArgv: [], argv: ["node", "/opt/clued-runner-hook/clued-runner-job-started.mjs"], allowedFlags: new Set(["--use-env-proxy"]) };
  assert.equal(proxyBootstrapArguments(base), null);
  assert.deepEqual(proxyBootstrapArguments({ ...base, env: { HTTPS_PROXY: "http://proxy:3128" } }),
    ["--use-env-proxy", "/opt/clued-runner-hook/clued-runner-job-started.mjs"]);
  assert.equal(proxyBootstrapArguments({ ...base, env: { HTTPS_PROXY: "http://proxy:3128", NODE_USE_ENV_PROXY: "1" } }), null);
  assert.throws(() => proxyBootstrapArguments({ ...base, env: { HTTPS_PROXY: "http://proxy:3128" }, allowedFlags: new Set() }), /cannot use/);
  assert.throws(() => proxyBootstrapArguments({ ...base, env: { HTTPS_PROXY: "http://proxy:3128", NODE_USE_ENV_PROXY: "0" } }), /disabled/);
  assert.throws(() => proxyBootstrapArguments({ ...base, env: { HTTPS_PROXY: "socks5://proxy" } }), /unsupported/);
});

// A real process, as a runner starts it: the loader installed under the hook's own name (wrappers, settings and keys unchanged),
// GitHub answered by a preloaded stand-in for fetch that serves this checkout's hook as main's. The real hook runs from memory.
test("process: the installed loader runs this checkout's hook; its clued-r9-pre-job source_sha256 is that file's", { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-hook-loader-"));
  try {
    const hookFile = path.join(HERE, "clued-runner-job-started.mjs");
    const hook = fs.readFileSync(hookFile);
    fs.copyFileSync(path.join(HERE, "clued-runner-hook-loader.mjs"), path.join(dir, "clued-runner-job-started.mjs"));
    fs.copyFileSync(path.join(HERE, "clued-runner-job-started.sh"), path.join(dir, "clued-runner-job-started.sh"));
    fs.writeFileSync(path.join(dir, "token"), "ghs_read\n");
    const reply = JSON.stringify(contents(hook).body);
    fs.writeFileSync(path.join(dir, "stub.mjs"), `const reply = ${JSON.stringify(reply)};
globalThis.fetch = async (url) => String(url) === ${JSON.stringify(CONTENTS)} ? new Response(reply, { status: 200 }) : new Response("null", { status: 500 });`);
    const childEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_OPTIONS: `--import=${pathToFileURL(path.join(dir, "stub.mjs")).href}`,
      CLUED_RUNNER_HOOK_REPOSITORY: "o/r", CLUED_RUNNER_HOOK_TOKEN_FILE: path.join(dir, "token"), CLUED_RUNNER_HOOK_ENFORCE: "true",
      CLUED_RUNNER_HOOK_NODE: process.execPath, GITHUB_REPOSITORY: "o/r", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: "o/r/.github/workflows/heartbeat.yml@refs/heads/main", GITHUB_RUN_ID: "555", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "beat" };
    const starts = [[process.execPath, [path.join(dir, "clued-runner-job-started.mjs")]]];
    if (process.platform !== "win32") starts.push(["sh", [path.join(dir, "clued-runner-job-started.sh")]]);
    const sha = createHash("sha256").update(hook).digest("hex");
    const version = /export const HOOK_VERSION = "([^"]+)";/.exec(hook.toString("utf8"))[1];
    for (const [command, args] of starts) {
      const child = spawnSync(command, args, { env: childEnv, encoding: "utf8", timeout: 30_000 });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, `${command}: ${child.stdout}\n${child.stderr}`);
      assert.match(child.stdout, new RegExp(`clued-runner-hook-loader: main blob ${gitBlobSha(hook)} sha256 ${sha} \\[loader ${LOADER_VERSION.replace(/\./g, "\\.")}\\]`));
      const observation = JSON.parse(/clued-r9-pre-job: (.*)/.exec(child.stdout)[1]);
      assert.deepEqual([observation.source_sha256, observation.hook_version, observation.allow], [sha, version, true]);
      assert.match(child.stdout, new RegExp(`clued-runner-hook: ALLOW push on main \\[hook ${version}\\]`));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The loader is the one file that is still installed on runners: changing its bytes is a deliberate decision (a new version and a
// new pin here), never a side effect.
const LOADER_SHA256 = "de10d6bc74f8d965ab86190c87949248295896f9bb6fbab0dc774333f0d1c978";
test("the loader's bytes are pinned, and its component version is the one it prints", () => {
  const bytes = fs.readFileSync(path.join(HERE, "clued-runner-hook-loader.mjs"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), LOADER_SHA256);
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "../../config/clued-components.json"), "utf8"));
  const component = manifest.components.find((c) => c.id === "hook.runner-loader");
  assert.deepEqual([component?.version, component?.files], [LOADER_VERSION, ["clued-runner-hook-loader.mjs"]]);
  assert.ok(bytes.length < 12_000, "the loader stays small");
});
