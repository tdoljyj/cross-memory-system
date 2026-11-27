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
import os from 'node:os';
import path from 'node:path';
import { acceptanceBytes, acceptanceOf } from '../../work/independent-ci-resident-v1/src/fleet-acceptance.mjs';
import { deliveryBound, deliverySubject, fleetDeliveryPreflight } from '../../work/independent-ci-resident-v1/rollout/fleet/delivery-preflight.mjs';
import { verifyDeliveryTree } from '../../work/independent-ci-resident-v1/rollout/fleet/delivery-reader.mjs';
import { deliveryWorkflowPacket, STAGED_PAYLOAD_MAX_LENGTH, STAGED_REQUEST_MAX_BYTES } from '../../work/independent-ci-resident-v1/rollout/fleet/delivery-workflow.mjs';
import { sourceHashOf, validateAcceptance } from '../../work/independent-ci-resident-v1/rollout/fleet/install.mjs';
import { checkDeliveryAssets, checkDeliveryKit, deliveryAssetManifestName, DRILL_RESERVED, namesDrillReserved, readRequest } from '../../work/independent-ci-resident-v1/rollout/fleet/publish.mjs';

export { checkDeliveryKit };

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
export async function download(url, fetchImpl = fetch, maxBytes = MAX_ASSET_BYTES, { digestOnly = false, timeout = 30_000 } = {}) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeout) });
      if (response.status === 404) refuse("FLEET_ACCEPT_ASSET_NOT_ON_RELEASE", url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunks = [];
      const digest = digestOnly ? crypto.createHash('sha256') : null;
      let length = 0;
      const body = response.body ?? [Buffer.from(await response.arrayBuffer())];
      for await (const chunk of body) {
        length += chunk.length;
        if (length > maxBytes) refuse("FLEET_ACCEPT_ASSET_SIZE", url);
        if (digest) digest.update(chunk);
        else chunks.push(Buffer.from(chunk));
      }
      if (length === 0) refuse("FLEET_ACCEPT_ASSET_SIZE", url);
      return digest ? digest.digest('hex') : Buffer.concat(chunks, length);
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

export async function buildInput(env, { fetchImpl = fetch, isAncestor = gitIsAncestor, isPinned } = {}) {
  const run = runInputs(env);
  if (env.FLEET_OPERATION === 'project' && env.FLEET_DELIVERY_KEY?.includes('.')) return stagedInput(env, run, isAncestor);
  const requestBytes = await download(assetUrl(run.repository, run.version, requestAssetName(run.version)), fetchImpl);
  const sumsBytes = await download(assetUrl(run.repository, run.version, "SHA256SUMS"), fetchImpl);
  const { resource, commit } = checkRequest(run, requestBytes, sumsBytes);
  if (!isAncestor(commit)) refuse("FLEET_ACCEPT_COMMIT_NOT_ON_MAIN", commit);
  const input = doorInput(env, resource);
  if (gated(run.version)) input.delivery = await deliveryInput(env, JSON.parse(requestBytes), run, sumsBytes, fetchImpl, isPinned);
  else if (env.FLEET_OPERATION || env.FLEET_DELIVERY_KEY || env.FLEET_ACCEPTANCE_SHA256) refuse('FLEET_DELIVERY_GENERATION_REFUSED');
  return input;
}

const FLEET_GENERATION = /^g(\d{6})$/;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const generation = version => Number(FLEET_GENERATION.exec(version)?.[1]);
const gated = version => generation(version) >= 25;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function stagedInput(env, run, isAncestor) {
  const match = /^([A-Za-z0-9_-]{59})\.([A-Za-z0-9_-]+)$/.exec(env.FLEET_DELIVERY_KEY ?? '');
  if (!gated(run.version) || !match || match[2].length > STAGED_PAYLOAD_MAX_LENGTH || env.FLEET_ACCEPTANCE_SHA256) refuse('FLEET_DELIVERY_INPUT_REFUSED');
  const [, transportKey, packed] = match;
  const { request: encoded } = JSON.parse(Buffer.from(packed, 'base64url'));
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) refuse('FLEET_DELIVERY_INPUT_REFUSED');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length > STAGED_REQUEST_MAX_BYTES) refuse('FLEET_DELIVERY_INPUT_REFUSED');
  if (hash(bytes) !== run.requestSha256) refuse('FLEET_ACCEPT_REQUEST_SHA256_MISMATCH');
  const request = readRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (request.version !== run.version || request.repository !== run.repository || request.commit !== env.GITHUB_SHA ||
      !isAncestor(request.commit) || namesDrillReserved(request)) refuse('FLEET_DELIVERY_SUBJECT_CHANGED');
  validateAcceptance(acceptanceOf(request, DRILL_RESERVED));
  return { delivery: { operation: 'preflight', candidate: deliverySubject(request, run.requestSha256), transportKey } };
}

function pinnedGeneration({ version, commit, archive_sha256 }) {
  try {
    const tag = tagOf(version);
    const raw = execFileSync('git', ['cat-file', 'tag', `refs/tags/${tag}`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    const [header, ...messages] = raw.split('\n\n');
    const claim = JSON.parse(messages.join('\n\n'));
    return header.startsWith(`object ${commit}\ntype commit\ntag ${tag}\n`) &&
      claim.contract === 'clued.independent-ci.fleet-package-generation/1' && claim.version === version &&
      claim.release_tag === tag && claim.commit === commit && claim.archive_sha256 === archive_sha256;
  } catch { return false; }
}

async function verifyDeliverySource(archive, request, candidate) {
  verifyDeliveryTree(archive, request);
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fleet-qualified-'));
  try {
    const artifactPath = path.join(temp, 'candidate.tar');
    await fs.promises.writeFile(artifactPath, archive, { flag: 'wx' });
    const found = await sourceHashOf({ artifactPath, artifactSha256: candidate.archiveSha256, acceptance: acceptanceOf(request, DRILL_RESERVED) });
    if (found.ciSourceManifestSha256 !== candidate.sourceSha256) refuse('FLEET_DELIVERY_SOURCE_CHANGED');
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

async function deliveryInput(env, request, run, sumsBytes, fetchImpl, isPinned = pinnedGeneration) {
  const operation = env.FLEET_OPERATION || 'open';
  const transportKey = env.FLEET_DELIVERY_KEY || null;
  const expected = env.FLEET_ACCEPTANCE_SHA256 || null;
  if (!['open', 'project', 'confirm'].includes(operation) ||
      (operation === 'open' ? transportKey !== null : !/^[A-Za-z0-9_-]{59}$/.test(transportKey ?? '')) ||
      (operation === 'confirm' ? !HEX64.test(expected ?? '') : expected !== null)) refuse('FLEET_DELIVERY_INPUT_REFUSED');
  readRequest(request);
  if (!isPinned(request)) refuse('FLEET_DELIVERY_GENERATION_NOT_PINNED');
  const candidate = deliverySubject(request, run.requestSha256);
  if (operation === 'project') return { operation, candidate, transportKey };

  const tag = tagOf(run.version);
  const asset = name => assetUrl(run.repository, run.version, name);
  const archive = await download(asset(tag + '.tar'), fetchImpl, 512 * 1024 * 1024);
  const kit = await download(asset(tag + '.first-install-kit.json'), fetchImpl);
  if (generation(run.version) >= 27) {
    const manifest = await download(asset(deliveryAssetManifestName(run.version)), fetchImpl);
    await checkDeliveryAssets({ request, manifest, kit, assetSha256: name => {
      if (name === tag + '.tar') return hash(archive);
      if (name === 'SHA256SUMS') return hash(sumsBytes);
      const roleImage = name.startsWith('role-image-');
      return download(asset(name), fetchImpl, roleImage ? 2 * 1024 ** 3 : MAX_ASSET_BYTES,
        { digestOnly: true, timeout: roleImage ? 90_000 : 30_000 });
    } });
  }
  await verifyDeliverySource(archive, request, candidate);
  checkDeliveryKit(kit, candidate);

  if (operation === 'open') return { operation, candidate };
  const bytes = await download(asset(tag + '.acceptance.json'), fetchImpl);
  const accepted = JSON.parse(bytes);
  const grantId = accepted.cluedDecision, receiptId = accepted.fleetRefs?.ownerReceiptRef;
  if (!ID.test(grantId ?? '') || !ID.test(receiptId ?? '') || grantId === receiptId || hash(bytes) !== expected ||
      !bytes.equals(acceptanceBytes(acceptanceOf(request, { decision: grantId, receipt: receiptId, acceptedAt: accepted.acceptedAt })))) {
    refuse('FLEET_DELIVERY_ACCEPTANCE_ASSET_REFUSED');
  }
  validateAcceptance(accepted, Date.now());
  return { operation, candidate, transportKey, grantId, receiptId,
    acceptanceSha256: expected, acceptedAt: accepted.acceptedAt };
}

export async function qualifyDelivery(input, database, clock = Date.now) {
  const { delivery, ...door } = input;
  const { operation, candidate } = delivery;
  const read = () => database('project', candidate);
  if (operation === 'project') {
    // The two queries each return a complete, single-statement snapshot.
    const first = await read();
    return { first, last: await read() };
  }
  if (!['preflight', 'open', 'confirm'].includes(operation)) refuse('FLEET_DELIVERY_INPUT_REFUSED');
  let last;
  const readFleetRegistry = async candidate => {
    last = await read();
    return deliveryBound(last?.candidate, candidate) ? last : null;
  };
  const result = await fleetDeliveryPreflight({ candidate, readFleetRegistry, clock });
  if (operation === 'preflight') {
    // 暂存端只需判定结果和绑定证据摘要。
    const { status, reason, observedAt, registrySha256 } = result;
    if (reason) return { status, reason };
    if (!HEX64.test(last?.snapshotToken ?? '')) refuse('FLEET_DELIVERY_PREFLIGHT_REFUSED');
    return { status, observedAt, registrySha256 };
  }
  if (result.status !== 'PASS' || !HEX64.test(last?.snapshotToken ?? '')) {
    refuse('FLEET_DELIVERY_PREFLIGHT_REFUSED', result.reason ?? result.status);
  }
  const snapshotToken = last.snapshotToken;
  if (operation === 'open') return database('open', { ...door, delivery: { candidate, snapshotToken } });
  const { acceptanceSha256, grantId, receiptId, acceptedAt } = delivery;
  return database('confirm', { candidate, acceptanceSha256, grantId, receiptId, acceptedAt, snapshotToken });
}

const DELIVERY_DB_FUNCTIONS = {
  project: 'fleet_delivery_registry_v1',
  open: 'fleet_accept_door_v1',
  confirm: 'fleet_delivery_seal_v1',
};

function callDeliveryDatabase(env, operation, input) {
  const fn = DELIVERY_DB_FUNCTIONS[operation];
  if (!fn || !env.CLUED_FLEET_DATABASE_URL) refuse('FLEET_DELIVERY_DATABASE_NOT_CONFIGURED');
  const answer = execFileSync('docker', ['run', '--rm', '-i', '--user', `${process.getuid()}:${process.getgid()}`,
    'postgres:17-alpine', 'psql', env.CLUED_FLEET_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-X', '-qtA',
    '-c', 'create temp table door_input(line text)',
    '-c', String.raw`copy door_input(line) from stdin with (format csv, delimiter e'\x01', quote e'\x02')`,
    ...(operation === 'project' ? ['-c', 'begin read only'] : []),
    '-c', `select clued_private.${fn}(line::jsonb)::text from door_input`,
    ...(operation === 'project' ? ['-c', 'commit'] : [])],
  { input: JSON.stringify(input) + '\n', encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(answer.trim());
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
  const candidate = result.resources.length === 1
    ? /^fleet-node:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/g([0-9]{6})\/([0-9a-f]{64})\/([0-9a-f]{64})$/.exec(result.resources[0])
    : null;
  const generation = candidate && candidate[3] === result.request_sha256 ? Number(candidate[1]) : null;
  const lines = [generation >= 23 ? `## 确认第 ${generation} 代通用节点包` : "## 接受通用节点包：fleet.accept", ""];
  if (generation >= 23) lines.push(`- 安装包 SHA-256：\`${candidate[2]}\``, `- 接受请求 SHA-256：\`${candidate[3]}\``);
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
  if (command === "delivery") {
    try {
      const input = JSON.parse(typeof io.stdin === 'string' ? io.stdin : await readStream(io.stdin ?? process.stdin));
      const result = await qualifyDelivery(input, deps.database ?? ((operation, input) => callDeliveryDatabase(env, operation, input)));
      if (input.delivery.operation === 'open') return main(['report'], env, { ...io, stdin: JSON.stringify(result) });
      io.write(deliveryWorkflowPacket({ operation: input.delivery.operation, candidate: input.delivery.candidate, result },
        input.delivery.transportKey, input.delivery.candidate.requestSha256) + '\n');
      return 0;
    } catch (error) {
      const message = /^FLEET_DELIVERY_[A-Z_]+(?:: [A-Z_]+)?$/.test(error?.message ?? '') ? error.message : 'FLEET_DELIVERY_DATABASE_REFUSED';
      io.error(`::error title=节点交付预检::${message}\n`);
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
