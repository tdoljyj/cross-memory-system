#!/usr/bin/env node
// Release door v1 (FABLE-release-identity-autonomous-20261119 §1.2;
// development/contracts/owner-authorization/OwnerCredential.v0.1.md §6.1).
//
// Before the deploy and migrate modes of clued-cloud-production-release.yml
// change production, the run consumes one use of an Owner Grant for this exact
// commit (repo:<owner>/<name>/<40-hex sha>) and action (release.production for
// deploy, migration.production for migrate). For migrate the resources are the
// named migration files of that commit
// (repo:<owner>/<name>/<sha>/apps/clued-cloud/supabase/migrations/<file>), and
// the input also names the deploy of the same commit (`with`), so one approval
// covers both (PermissionSimplification §3.3).
//
// The door is the database function clued_private.release_door_v1(jsonb). Only
// the database login of the clued-release environment (CLUED_MIGRATION_DATABASE_URL)
// may execute it; it is not on PostgREST and no token names the caller. The
// workflow calls it through psql, giving this script's input as COPY data, never
// as SQL text: migrate inside the transaction of its first file, deploy in its
// own step. This script does no I/O beyond its standard streams and the run
// summary, and loads only Node's own modules (it runs after npm ci):
//
//   clued-release-grant.mjs input --mode deploy|migrate [--request-only]
//     prints the door's input as one JSON line.
//   clued-release-grant.mjs report --mode deploy|migrate [--error-file <psql stderr>]
//     reads the door's answer on standard input, writes the run summary,
//     explains a refusal in Chinese and exits 0 only when a grant was consumed.
//
// There is no advisory mode: no consumed grant, no run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOOR_FUNCTION = "clued_private.release_door_v1(jsonb)";
export const ACTIONS = { deploy: "release.production", migrate: "migration.production" };
const DEFAULT_ORIGIN = "https://kooyumi.pixelgrav.com";
const WHAT = { deploy: "发布", migrate: "迁移" };

export const MIGRATIONS_DIR = "apps/clued-cloud/supabase/migrations";
const MIGRATION_NAME = /^[0-9]{14}_[a-z0-9_]+\.sql$/;

export function commitResource(env) {
  const repository = (env.GITHUB_REPOSITORY ?? "").trim();
  const sha = (env.GITHUB_SHA ?? "").trim().toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY is not owner/name.");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GITHUB_SHA is not a full commit SHA.");
  return `repo:${repository}/${sha}`;
}

export function migrationResources(env) {
  const names = String(env.MIGRATIONS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0 || names.length > 50) throw new Error("MIGRATIONS must name 1 to 50 migration files.");
  for (const name of names) if (!MIGRATION_NAME.test(name)) throw new Error(`Not a migration file name: ${name}`);
  const commit = commitResource(env);
  return names.map((name) => `${commit}/${MIGRATIONS_DIR}/${name}`);
}

// The door records run_id and run_attempt as the caller's own, unverified account.
export function doorInput(env, mode, { requestOnly = false } = {}) {
  const action = ACTIONS[mode];
  if (!action) throw new Error(`mode ${mode} needs no Owner Grant`);
  const input = { action, resources: mode === "migrate" ? migrationResources(env) : [commitResource(env)] };
  if (mode === "migrate") input.with = [{ action: ACTIONS.deploy, resources: [commitResource(env)] }];
  if (requestOnly) input.request_only = true;
  for (const [key, name] of [["run_id", "GITHUB_RUN_ID"], ["run_attempt", "GITHUB_RUN_ATTEMPT"]]) {
    const value = (env[name] ?? "").trim();
    if (/^[0-9]{1,20}$/.test(value)) input[key] = value;
  }
  return input;
}

// psql's own words for a failed call, most specific first.
const REFUSALS = [
  [/release_grant_not_consumed/, () => "门没有消费到授权，这次的事务已整体回滚，生产没有变化。"],
  [/release_door_probe_failed/, () => "这条迁移执行后发布门不可用（探门失败），整条迁移已回滚，生产没有变化。修改这条迁移，不要动发布门。"],
  [/release_door_not_installed/, () => "第一条文件的 md5 与钉死的安装迁移相同，执行后发布门却仍不存在；已回滚，生产没有变化。查安装迁移。"],
  [/function clued_private\.release_door_v1\(jsonb\) does not exist|schema "clued_private" does not exist/, () =>
    "发布门 clued_private.release_door_v1 不在这个数据库里。先触发一次 mode=migrate，migrations 只填安装迁移（*_release_door_db_identity_v1.sql）完成自举，再重跑本次。"],
  [/permission denied for (function|schema)/, () =>
    "CLUED_MIGRATION_DATABASE_URL 的登录角色无权调用发布门。它必须是迁移用的数据库登录角色；不要换成别的口令。"],
  [/psql: error|connection to server|password authentication failed|could not translate host name|Connection refused/i, () =>
    "连不上生产库（CLUED_MIGRATION_DATABASE_URL），没有用掉任何授权。核对这个 secret 后重跑。"],
  [/\brelease_door_[a-z_]+\b/, (match) => `发布门拒绝了这次调用：${match[0]}。按这个拒绝原因改正输入后重跑。`],
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

export function explain({ mode, answerText, errorText, env }) {
  const result = { mode, action: ACTIONS[mode] ?? null, resources: [], consumed: false, grant: null,
    request_id: null, confirm_url: null, bundle: [], reason: null, error: null };
  try {
    result.resources = doorInput(env, mode).resources;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  const answer = parseAnswer(answerText);
  if (answer && answer.status === "ok" && answer.consumed === true) {
    result.consumed = true;
    result.grant = answer.grant && typeof answer.grant === "object" ? answer.grant : null;
    return result;
  }
  if (answer && answer.status === "ok" && answer.consumed === false) {
    const request = answer.owner_request && typeof answer.owner_request === "object" ? answer.owner_request : {};
    result.request_id = typeof request.request_id === "string" ? request.request_id : null;
    if (Array.isArray(request.bundle)) {
      result.bundle = request.bundle.filter((m) => m && typeof m.action === "string")
        .map((m) => ({ action: m.action, request_id: typeof m.request_id === "string" ? m.request_id : null }));
    }
    if (typeof request.confirm_path === "string" && /^\/confirm\/[0-9a-f-]{36}$/.test(request.confirm_path)) {
      result.confirm_url = (env.CLUED_CONFIRM_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, "") + request.confirm_path;
    }
    result.reason = `没有授权放行这次${WHAT[mode] ?? mode}（自动批准未开或不适用于这次），生产没有变化。` +
      (result.confirm_url ? `请 Owner 打开 ${result.confirm_url} 点一次“批准”，然后重跑本运行。` : "门没有给出确认链接。");
    return result;
  }
  const text = String(errorText ?? "");
  for (const [pattern, say] of REFUSALS) {
    const match = text.match(pattern);
    if (match) {
      result.reason = say(match);
      return result;
    }
  }
  result.reason = answer ? `发布门的回答无法识别：${JSON.stringify(answer).slice(0, 300)}` :
    `发布门没有回答${text.trim() ? `：${text.trim().split("\n").at(-1).slice(0, 300)}` : "。"}`;
  return result;
}

export function renderSummary(result) {
  const lines = [`## Owner Grant：${result.mode}`, ""];
  lines.push(`- 动作：\`${result.action ?? "n/a"}\``, `- 资源：${result.resources.map((r) => `\`${r}\``).join("，") || "n/a"}`);
  lines.push("- 调用方：发布环境的数据库登录身份（clued_private.release_door_v1）");
  if (result.consumed) {
    const grant = result.grant ?? {};
    lines.push(`- 已消费授权 \`${grant.grant_id ?? "?"}\`，第 ${grant.use ?? "?"} 次${grant.max_uses ? `（共 ${grant.max_uses} 次）` : ""}。`);
  } else {
    if (result.reason) lines.push(`- ${result.reason}`);
    if (result.error) lines.push(`- 错误：${result.error}`);
    if (result.bundle.length > 1) lines.push(`- 这个链接同时覆盖 ${result.bundle.map((m) => `\`${m.action}\``).join(" 和 ")}：批准一次即可。`);
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
  io = { stdin: null, write: (text) => process.stdout.write(text), error: (text) => process.stderr.write(text) }) {
  const [command] = argv;
  const option = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const mode = option("--mode");
  if (!["input", "report"].includes(command) || !ACTIONS[mode]) {
    io.error("usage: clued-release-grant.mjs input --mode deploy|migrate [--request-only]\n" +
      "       clued-release-grant.mjs report --mode deploy|migrate [--error-file <file>]\n");
    return 2;
  }
  if (command === "input") {
    io.write(`${JSON.stringify(doorInput(env, mode, { requestOnly: argv.includes("--request-only") }))}\n`);
    return 0;
  }
  const answerText = typeof io.stdin === "string" ? io.stdin : await readStream(io.stdin ?? process.stdin);
  const errorFile = option("--error-file");
  const errorText = errorFile && fs.existsSync(errorFile) ? fs.readFileSync(errorFile, "utf8") : "";
  const result = explain({ mode, answerText, errorText, env });
  io.write(`${JSON.stringify(result, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
  if (result.consumed) {
    io.write(`已消费授权 ${result.grant?.grant_id ?? "?"}（${result.action}）。\n`);
    return 0;
  }
  io.error(`::error title=Owner Grant::${result.reason ?? result.error ?? "没有消费到授权"}\n`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
