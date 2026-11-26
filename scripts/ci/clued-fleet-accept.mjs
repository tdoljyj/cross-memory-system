#!/usr/bin/env node
// Fleet acceptance, the release workflow's part (Task 87d330d0;
// PLAN-accept-binding-20261125 section 3; migration
// 20261125100000_fleet_accept_door_v1.sql).
//
// The fleet-accept mode of clued-cloud-production-release.yml opens the
// Owner's request to accept one universal node package. It changes nothing
// in production but that pending request: the Owner's approval on the
// confirmation page is the acceptance, and nothing here can give it.
//
//   clued-fleet-accept.mjs input
//     reads FLEET_VERSION and FLEET_REQUEST_SHA256, downloads the package's
//     acceptance request and SHA256SUMS from its public Release (no token),
//     checks them and prints the door's input as one JSON line. It holds no
//     credential and runs before any is read. What it checks:
//       - the request file's bytes have the sha256 the run was given;
//       - it is this repository's request for this version;
//       - the Release's SHA256SUMS names the request's archive hash for the tar;
//       - the request's commit is an ancestor of the checked-out main.
//     Only checked values of fixed shapes reach the door's input; no
//     downloaded byte reaches a shell or SQL text.
//   clued-fleet-accept.mjs report [--error-file <psql stderr>]
//     reads the door's answer on standard input, writes the confirmation link
//     to the run summary and exits 0 when the request is pending or the
//     package is already accepted.
//
// The door is clued_private.fleet_accept_door_v1(jsonb): only the database
// login of the clued-release environment may execute it. The workflow gives
// it this script's input as COPY data, never as SQL text.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

export const DOOR_FUNCTION = "clued_private.fleet_accept_door_v1(jsonb)";
export const ACTION = "fleet.accept";
export const REQUEST_CONTRACT = "clued.independent-ci.fleet-node-acceptance-request/1";
const DEFAULT_ORIGIN = "https://kooyumi.pixelgrav.com";
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,88}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ASSET_BYTES = 1024 * 1024;

const refuse = (code, detail) => { throw new Error(detail ? `${code}: ${detail}` : code); };

export function runInputs(env) {
  const version = env.FLEET_VERSION ?? "";
  const requestSha256 = env.FLEET_REQUEST_SHA256 ?? "";
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!VERSION.test(version)) refuse("FLEET_ACCEPT_VERSION_INVALID");
  if (!HEX64.test(requestSha256)) refuse("FLEET_ACCEPT_REQUEST_SHA256_INVALID");
  if (!REPOSITORY.test(repository)) refuse("FLEET_ACCEPT_REPOSITORY_INVALID");
  return { version, requestSha256, repository };
}

export const tagOf = (version) => `fleet-node-${version}`;
export const requestAssetName = (version) => `${tagOf(version)}.acceptance-request.json`;
// The public download address of one Release asset; nothing is sent with it.
export const assetUrl = (repository, version, name) =>
  `https://github.com/${repository}/releases/download/${encodeURIComponent(tagOf(version))}/${encodeURIComponent(name)}`;

// The checked request: the door's one resource and the commit to hold to main.
export function checkRequest({ version, requestSha256, repository }, requestBytes, sumsBytes) {
  if (crypto.createHash("sha256").update(requestBytes).digest("hex") !== requestSha256) {
    refuse("FLEET_ACCEPT_REQUEST_SHA256_MISMATCH", "the Release's acceptance request is not the file this run was given the hash of");
  }
  let request;
  try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes)); }
  catch { refuse("FLEET_ACCEPT_REQUEST_UNREADABLE"); }
  if (request === null || typeof request !== "object" || Array.isArray(request) || request.contract !== REQUEST_CONTRACT) {
    refuse("FLEET_ACCEPT_REQUEST_CONTRACT");
  }
  if (request.version !== version) refuse("FLEET_ACCEPT_REQUEST_VERSION", "the request is for another version");
  if (request.repository !== repository) refuse("FLEET_ACCEPT_REQUEST_REPOSITORY", "the request is for another repository");
  if (typeof request.archive_sha256 !== "string" || !HEX64.test(request.archive_sha256)) refuse("FLEET_ACCEPT_REQUEST_ARCHIVE");
  if (typeof request.commit !== "string" || !/^[0-9a-f]{40}$/.test(request.commit)) refuse("FLEET_ACCEPT_REQUEST_COMMIT");
  let sums;
  try { sums = new TextDecoder("utf-8", { fatal: true }).decode(sumsBytes); }
  catch { refuse("FLEET_ACCEPT_SHA256SUMS_UNREADABLE"); }
  const tar = `${tagOf(version)}.tar`;
  const named = sums.split("\n").map((line) => /^([0-9a-f]{64}) [ *](.+)$/.exec(line)).filter((m) => m && m[2] === tar);
  if (named.length !== 1 || named[0][1] !== request.archive_sha256) {
    refuse("FLEET_ACCEPT_ARCHIVE_NOT_ON_RELEASE", "the Release's SHA256SUMS does not name the request's archive hash for the tar");
  }
  return { resource: `fleet-node:${repository}/${version}/${request.archive_sha256}/${requestSha256}`, commit: request.commit };
}

// The door records run_id and run_attempt as the caller's own, unverified account.
export function doorInput(env, resource) {
  const input = { action: ACTION, resources: [resource] };
  for (const [key, name, shape] of [["run_id", "GITHUB_RUN_ID", /^[1-9][0-9]{0,19}$/], ["run_attempt", "GITHUB_RUN_ATTEMPT", /^[1-9][0-9]{0,5}$/]]) {
    const value = (env[name] ?? "").trim();
    if (shape.test(value)) input[key] = value;
  }
  return input;
}

// One public asset, whole, within the size limit; a failed read is tried three times.
export async function download(url, fetchImpl = fetch) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) refuse("FLEET_ACCEPT_ASSET_NOT_ON_RELEASE", url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) refuse("FLEET_ACCEPT_ASSET_SIZE", `${url}: ${bytes.length} bytes`);
      return bytes;
    } catch (error) {
      if (/^FLEET_ACCEPT_/.test(error?.message ?? "")) throw error;
      last = error;
    }
  }
  return refuse("FLEET_ACCEPT_ASSET_UNREADABLE", `${url}: ${last?.message ?? last}`);
}

const gitIsAncestor = (commit) => {
  try { execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" }); return true; }
  catch { return false; }
};

export async function buildInput(env, { fetchImpl = fetch, isAncestor = gitIsAncestor } = {}) {
  const run = runInputs(env);
  const requestBytes = await download(assetUrl(run.repository, run.version, requestAssetName(run.version)), fetchImpl);
  const sumsBytes = await download(assetUrl(run.repository, run.version, "SHA256SUMS"), fetchImpl);
  const { resource, commit } = checkRequest(run, requestBytes, sumsBytes);
  if (!isAncestor(commit)) refuse("FLEET_ACCEPT_COMMIT_NOT_ON_MAIN", commit);
  return doorInput(env, resource);
}

// psql's own words for a failed call, most specific first.
const REFUSALS = [
  [/fleet_accept_version_already_accepted/, () => "这个版本已经以另一份请求或另一个包被接受过，接受门拒绝再开请求。换版本号重新发布。"],
  [/function clued_private\.fleet_accept_door_v1\(jsonb\) does not exist/, () =>
    "接受门 clued_private.fleet_accept_door_v1 不在这个数据库里。先触发一次 mode=migrate，migrations 填 20261125100000_fleet_accept_door_v1.sql，再重跑本次。"],
  [/release_door_identity_(missing|invalid)/, () => "发布身份没有登记或已失效（clued_private.release_identity_v1），接受门拒绝了这次调用。"],
  [/\baccount_not_available\b/, () => "发布身份登记的账号当前不可用，接受门拒绝了这次调用。"],
  [/permission denied for (function|schema)/, () => "CLUED_MIGRATION_DATABASE_URL 的登录角色无权调用接受门。它必须是迁移用的数据库登录角色。"],
  [/psql: error|connection to server|password authentication failed|could not translate host name|Connection refused/i, () =>
    "连不上生产库（CLUED_MIGRATION_DATABASE_URL），没有开出请求。核对这个 secret 后重跑。"],
  [/\bfleet_accept_[a-z_]+\b/, (match) => `接受门拒绝了这次调用：${match[0]}。`],
];

function parseAnswer(text) {
  const line = String(text ?? "").split("\n").map((value) => value.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function explain({ answerText, errorText, env }) {
  const result = { action: ACTION, status: null, resources: [], request_sha256: null, request_id: null, confirm_url: null,
    expires_at: null, grant_id: null, ok: false, reason: null };
  const answer = parseAnswer(answerText);
  if (answer && Array.isArray(answer.resources)) result.resources = answer.resources.filter((r) => typeof r === "string");
  if (answer && typeof answer.request_sha256 === "string") result.request_sha256 = answer.request_sha256;
  if (answer && answer.status === "pending" && typeof answer.confirm_path === "string"
      && /^\/confirm\/[0-9a-f-]{36}$/.test(answer.confirm_path)) {
    result.status = "pending";
    result.ok = true;
    result.request_id = typeof answer.request_id === "string" ? answer.request_id : null;
    result.expires_at = typeof answer.expires_at === "string" ? answer.expires_at : null;
    result.confirm_url = (env.CLUED_CONFIRM_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, "") + answer.confirm_path;
    result.reason = `请求已开出，等 Owner 批准。请 Owner 打开 ${result.confirm_url} 核对版本与哈希后点一次“批准”。`;
    return result;
  }
  if (answer && answer.status === "accepted") {
    result.status = "accepted";
    result.ok = true;
    result.grant_id = typeof answer.grant_id === "string" ? answer.grant_id : null;
    result.reason = "这个包已经被接受，没有再开请求。";
    return result;
  }
  if (answer && answer.status === "rejected") {
    // The Owner's no is final; the door replays it and never opens another request for this package.
    result.status = "rejected";
    result.request_id = typeof answer.request_id === "string" ? answer.request_id : null;
    result.reason = "Owner 已拒绝这个包：此包不再询问，没有开出请求。要接受须出新版本。";
    return result;
  }
  const text = String(errorText ?? "");
  for (const [pattern, say] of REFUSALS) {
    const match = text.match(pattern);
    if (match) { result.reason = say(match); return result; }
  }
  result.reason = answer ? `接受门的回答无法识别：${JSON.stringify(answer).slice(0, 300)}` :
    `接受门没有回答${text.trim() ? `：${text.trim().split("\n").at(-1).slice(0, 300)}` : "。"}`;
  return result;
}

export function renderSummary(result) {
  const lines = ["## 接受通用节点包：fleet.accept", ""];
  lines.push(`- 资源：${result.resources.map((r) => `\`${r}\``).join("，") || "n/a"}`);
  lines.push("- 调用方：发布环境的数据库登录身份（clued_private.fleet_accept_door_v1）；本运行只开请求，不批准、不改生产。");
  if (result.status === "pending") {
    lines.push(`- 确认链接：${result.confirm_url}`, `- 请求 \`${result.request_id ?? "?"}\`，到期 ${result.expires_at ?? "?"}。`);
  } else if (result.status === "accepted") {
    lines.push(`- 已接受（授权 \`${result.grant_id ?? "?"}\`），没有再开请求。`);
  } else if (result.reason) {
    lines.push(`- ${result.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

const readStream = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
};

export async function main(argv = process.argv.slice(2), env = process.env,
  io = { stdin: null, write: (text) => process.stdout.write(text), error: (text) => process.stderr.write(text) }, deps = {}) {
  const [command] = argv;
  const option = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  if (command === "input") {
    try {
      io.write(`${JSON.stringify(await buildInput(env, deps))}\n`);
      return 0;
    } catch (error) {
      io.error(`::error title=接受通用节点包::${error instanceof Error ? error.message : String(error)}（没有读取任何凭据，没有开出请求）\n`);
      return 1;
    }
  }
  if (command !== "report") {
    io.error("usage: clued-fleet-accept.mjs input\n       clued-fleet-accept.mjs report [--error-file <file>]\n");
    return 2;
  }
  const answerText = typeof io.stdin === "string" ? io.stdin : await readStream(io.stdin ?? process.stdin);
  const errorFile = option("--error-file");
  const errorText = errorFile && fs.existsSync(errorFile) ? fs.readFileSync(errorFile, "utf8") : "";
  const result = explain({ answerText, errorText, env });
  io.write(`${JSON.stringify(result, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
  if (result.ok) {
    io.write(`${result.reason}\n`);
    return 0;
  }
  io.error(`::error title=接受通用节点包::${result.reason ?? "没有开出请求"}\n`);
  return 1;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
