#!/usr/bin/env node
// Work Claim Admission v0.1, step 3 (development/contracts/execution-admission/
// WorkClaimAdmission.v0.1.md §4.6 L0a/L0b). One script, two modes:
//
//   --mode required   the unfiltered `clued-work-admission` check on every PR
//   --mode gate       the `admission-gate` job that heavy self-hosted workflows
//                     run first; they `needs:` it and run only on admitted=true
//
// The script asks Clued, through the public MCP endpoint and a read-only
// Binding token, whether the PR's work claim admits the PR's head, base and
// changed files (clued_work_verify, read-only, no receipt). Nothing is trusted
// from the PR itself except the claim id it names.
//
// Enforcement follows the service: while the Worker hides the work-claim
// tools (CLUED_WORK_CLAIMS_V1 off, or the migrations not applied), the script
// reports NOT_ENFORCED and admits, so deploying this check before the rollout
// changes nothing. Every other failure (no token, bad token, transport error,
// unexpected response) fails closed. Non-PR events (push to main, dispatch)
// are not admission subjects and are admitted.
//
// No dependencies: Node 20+ fetch and fs only, so a hosted runner finishes in
// seconds without an install.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MCP_URL = "https://clued.pixelgrav.com/mcp";
export const VERIFY_TOOL = "clued_work_verify";
export const DISABLED_MESSAGE = "Clued work claims are disabled.";
const CLAIM_TRAILER = /^Clued-Work-Claim:[ \t]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*$/m;
const SCOPE_TRAILER = /^Clued-Work-Scope:[ \t]*(global|project:[0-9a-fA-F-]{36})[ \t]*$/m;

// ---------------------------------------------------------------------------
// Claim reference: PR body first, then the head commit message.

export function parseClaimReference(text) {
  if (typeof text !== "string") return null;
  const claim = CLAIM_TRAILER.exec(text);
  if (!claim) return null;
  const scope = SCOPE_TRAILER.exec(text);
  return { claim_id: claim[1].toLowerCase(), scope: scope ? scope[1] : "global" };
}

// ---------------------------------------------------------------------------
// Workflow path filters (GitHub `on.pull_request.paths` / `paths-ignore`).
// A line-based reader is enough for this repository's workflows and keeps the
// script dependency-free; it is exercised against the real files in the test.

export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1; // `**/` also matches zero directories
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseWorkflowTriggers(text) {
  const lines = text.split(/\r?\n/);
  let name = null;
  const triggers = { pull_request: null };
  let inOn = false;
  let trigger = null;
  let listKey = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const top = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (top && top[1] === "name" && name === null) name = unquote(top[2]);
      if (top && top[1] === "on") {
        inOn = true;
        const flow = /^\[(.*)\]$/.exec(top[2].trim());
        if (flow) {
          for (const item of flow[1].split(",").map(unquote)) {
            if (item === "pull_request" || item === "pull_request_target") triggers.pull_request = { paths: [], pathsIgnore: [] };
          }
          inOn = false;
        } else if (top[2].trim() === "pull_request" || top[2].trim() === "pull_request_target") {
          triggers.pull_request = { paths: [], pathsIgnore: [] };
          inOn = false;
        }
        continue;
      }
      inOn = false;
      trigger = null;
      listKey = null;
      continue;
    }
    if (!inOn) continue;
    if (indent === 2) {
      const key = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
      if (/^-\s/.test(line.trim())) {
        // `on:` as a block list of event names.
        const listed = unquote(line.trim().slice(1));
        if (listed === "pull_request" || listed === "pull_request_target") triggers.pull_request = { paths: [], pathsIgnore: [] };
        continue;
      }
      trigger = key ? key[1] : null;
      if (trigger === "pull_request_target") trigger = "pull_request";
      listKey = null;
      if (trigger === "pull_request") triggers.pull_request = { paths: [], pathsIgnore: [] };
      continue;
    }
    if (trigger !== "pull_request") continue;
    if (indent === 4) {
      const key = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
      listKey = key && (key[1] === "paths" || key[1] === "paths-ignore") ? key[1] : null;
      if (listKey && key[2]) {
        const flow = /^\[(.*)\]$/.exec(key[2].trim());
        if (flow) {
          for (const item of flow[1].split(",").map(unquote).filter(Boolean)) {
            triggers.pull_request[listKey === "paths" ? "paths" : "pathsIgnore"].push(item);
          }
        }
      }
      continue;
    }
    if (indent >= 6 && listKey && /^-\s/.test(line.trim())) {
      triggers.pull_request[listKey === "paths" ? "paths" : "pathsIgnore"].push(unquote(line.trim().slice(1)));
    }
  }
  return { name, pull_request: triggers.pull_request };
}

export function workflowApplies(trigger, changedPaths) {
  if (!trigger) return { applies: false, reason: "no pull_request trigger" };
  const { paths, pathsIgnore } = trigger;
  if (paths.length === 0 && pathsIgnore.length === 0) return { applies: true, reason: "unfiltered" };
  if (paths.length > 0) {
    const regexps = paths.map(globToRegExp);
    const hit = changedPaths.find((file) => regexps.some((re) => re.test(file)));
    return hit ? { applies: true, reason: `matches ${hit}` } : { applies: false, reason: "no changed path matches its filter" };
  }
  const regexps = pathsIgnore.map(globToRegExp);
  const hit = changedPaths.find((file) => !regexps.some((re) => re.test(file)));
  return hit ? { applies: true, reason: `${hit} is not ignored` } : { applies: false, reason: "every changed path is ignored" };
}

export function readWorkflowTriggers(workspace, readDir = fs.readdirSync, readFile = fs.readFileSync) {
  const dir = path.join(workspace, ".github", "workflows");
  let entries = [];
  try {
    entries = readDir(dir).filter((file) => /\.ya?ml$/.test(file)).sort();
  } catch {
    return [];
  }
  return entries.map((file) => ({ file, ...parseWorkflowTriggers(readFile(path.join(dir, file), "utf8")) }));
}

// ---------------------------------------------------------------------------
// GitHub REST (GITHUB_TOKEN of the run; read-only).

async function githubJson(fetchImpl, env, route, { allowMissing = false } = {}) {
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const response = await fetchImpl(`${base}${route}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "clued-work-admission",
    },
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${route} returned ${response.status}`);
  return await response.json();
}

async function githubPaged(fetchImpl, env, route, key) {
  const items = [];
  for (let page = 1; page <= 50; page += 1) {
    const sep = route.includes("?") ? "&" : "?";
    const body = await githubJson(fetchImpl, env, `${route}${sep}per_page=100&page=${page}`);
    const chunk = key ? body[key] : body;
    items.push(...chunk);
    if (chunk.length < 100) break;
  }
  return items;
}

export async function changedPathsOfPullRequest(fetchImpl, env, repository, number) {
  const files = await githubPaged(fetchImpl, env, `/repos/${repository}/pulls/${number}/files`);
  const paths = new Set();
  for (const file of files) {
    if (typeof file.filename === "string") paths.add(file.filename);
    if (typeof file.previous_filename === "string") paths.add(file.previous_filename);
  }
  return [...paths].sort();
}

// ---------------------------------------------------------------------------
// Clued MCP (read-only Binding token).

async function mcp(fetchImpl, env, id, method, params) {
  const response = await fetchImpl(env.CLUED_MCP_URL || DEFAULT_MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CLUED_CONTEXT_READ_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "clued-work-admission",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  let text = "";
  let body = null;
  try {
    text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  // Diagnostics for a refusal: who answered (Worker vs. an edge layer) and why.
  const diag = {};
  for (const name of ["server", "cf-ray", "cf-mitigated", "www-authenticate", "content-type", "x-clued-release-version"]) {
    const value = response.headers && typeof response.headers.get === "function" ? response.headers.get(name) : null;
    if (value) diag[name] = value;
  }
  return { status: response.status, body, text: text.slice(0, 400), diag };
}

function errorMessage(body) {
  return body && body.error && typeof body.error.message === "string" ? body.error.message : "";
}

function describe(answer) {
  const parts = [];
  const message = errorMessage(answer.body);
  if (message) parts.push(message);
  else if (answer.text) parts.push(answer.text.replace(/\s+/g, " "));
  const diag = Object.entries(answer.diag ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  if (diag) parts.push(`[${diag}]`);
  return parts.length ? `: ${parts.join(" ")}` : "";
}

// Returns { enforced, reason } from tools/list: the Worker hides the work
// claim tools while the feature is off, so advertisement is the switch.
export async function probeEnforcement(fetchImpl, env) {
  const listed = await mcp(fetchImpl, env, 1, "tools/list", {});
  if (listed.status === 401) throw new Error(`Clued rejected CLUED_CONTEXT_READ_TOKEN (401)${describe(listed)}`);
  if (listed.status !== 200 || !listed.body || !listed.body.result || !Array.isArray(listed.body.result.tools)) {
    throw new Error(`Clued tools/list returned ${listed.status}${describe(listed)}`);
  }
  const advertised = listed.body.result.tools.some((tool) => tool && tool.name === VERIFY_TOOL);
  return advertised ? { enforced: true, reason: `${VERIFY_TOOL} advertised` } : { enforced: false, reason: `${VERIFY_TOOL} not advertised (CLUED_WORK_CLAIMS_V1 off)` };
}

export async function verifyClaim(fetchImpl, env, args) {
  const called = await mcp(fetchImpl, env, 2, "tools/call", { name: VERIFY_TOOL, arguments: args });
  if (called.status === 404 && errorMessage(called.body) === DISABLED_MESSAGE) return { disabled: true };
  if (called.status === 401) throw new Error(`Clued rejected CLUED_CONTEXT_READ_TOKEN (401)${describe(called)}`);
  if (called.status !== 200 || !called.body || !called.body.result) {
    throw new Error(`Clued ${VERIFY_TOOL} returned ${called.status}${describe(called)}`);
  }
  const result = called.body.result;
  let payload = result.structuredContent;
  if (!payload && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === "string") {
    try {
      payload = JSON.parse(result.content[0].text);
    } catch {
      payload = null;
    }
  }
  if (result.isError) {
    const message = payload && (payload.error_code || payload.error || payload.message);
    return { verdict: "REJECTED", reasons: [`verify_error:${message || "unknown"}`], payload };
  }
  if (!payload || (payload.verdict !== "ADMITTED" && payload.verdict !== "REJECTED")) {
    throw new Error(`Clued ${VERIFY_TOOL} returned no verdict.`);
  }
  return { verdict: payload.verdict, reasons: Array.isArray(payload.reasons) ? payload.reasons : [], payload };
}

// ---------------------------------------------------------------------------
// Evaluation.

export async function evaluate({ env, event, eventName, fetchImpl, workspace, withSummary }) {
  const outcome = {
    mode: null,
    event: eventName,
    admitted: false,
    enforced: null,
    verdict: null,
    reasons: [],
    claim_id: null,
    scope: null,
    head_sha: null,
    base_sha: null,
    changed_paths: [],
    applicable_workflows: [],
    error: null,
  };
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    outcome.admitted = true;
    outcome.verdict = "NOT_APPLICABLE";
    outcome.reasons = [`event ${eventName} is not an admission subject`];
    return outcome;
  }
  const pr = event && event.pull_request;
  if (!pr || !pr.head || !pr.base) throw new Error("pull_request payload is missing head/base.");
  const repository = env.GITHUB_REPOSITORY;
  outcome.head_sha = pr.head.sha;
  outcome.base_sha = pr.base.sha;
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  outcome.changed_paths = await changedPathsOfPullRequest(fetchImpl, env, repository, pr.number);

  if (withSummary && workspace) {
    const triggers = readWorkflowTriggers(workspace);
    let runsByPath = new Map();
    try {
      const runs = await githubPaged(fetchImpl, env, `/repos/${repository}/actions/runs?head_sha=${pr.head.sha}&event=pull_request`, "workflow_runs");
      runsByPath = new Map(runs.map((run) => [run.path, run]));
    } catch (error) {
      outcome.reasons.push(`workflow runs unavailable: ${error.message}`);
    }
    outcome.applicable_workflows = triggers.map((workflow) => {
      const decision = workflowApplies(workflow.pull_request, outcome.changed_paths);
      const run = runsByPath.get(`.github/workflows/${workflow.file}`);
      return {
        file: workflow.file,
        name: workflow.name ?? workflow.file,
        applies: decision.applies,
        reason: decision.reason,
        run_status: run ? run.status : null,
        run_conclusion: run ? run.conclusion : null,
      };
    });
  }

  if (!env.CLUED_CONTEXT_READ_TOKEN) throw new Error("CLUED_CONTEXT_READ_TOKEN is not set; admission cannot be verified.");
  const probe = await probeEnforcement(fetchImpl, env);
  outcome.enforced = probe.enforced;
  if (!probe.enforced) {
    outcome.admitted = true;
    outcome.verdict = "NOT_ENFORCED";
    outcome.reasons.push(probe.reason);
    return outcome;
  }

  let reference = parseClaimReference(pr.body);
  if (!reference) {
    const commit = await githubJson(fetchImpl, env, `/repos/${repository}/commits/${pr.head.sha}`);
    reference = parseClaimReference(commit && commit.commit && commit.commit.message);
  }
  if (!reference) {
    outcome.verdict = "REJECTED";
    outcome.reasons.push("claim_trailer_missing");
    return outcome;
  }
  outcome.claim_id = reference.claim_id;
  outcome.scope = reference.scope;

  const verified = await verifyClaim(fetchImpl, env, {
    scope: reference.scope,
    claim_id: reference.claim_id,
    changed_paths: outcome.changed_paths,
    head_sha: pr.head.sha,
    base_sha: pr.base.sha,
  });
  if (verified.disabled) {
    outcome.enforced = false;
    outcome.admitted = true;
    outcome.verdict = "NOT_ENFORCED";
    outcome.reasons.push(DISABLED_MESSAGE);
    return outcome;
  }
  outcome.verdict = verified.verdict;
  outcome.reasons.push(...verified.reasons);
  if (verified.payload && Array.isArray(verified.payload.paths_outside_write_set) && verified.payload.paths_outside_write_set.length) {
    outcome.paths_outside_write_set = verified.payload.paths_outside_write_set;
  }

  // The claim's base must not be ahead of the PR's base: a claim taken on a
  // newer main than the PR targets is not the work this PR carries.
  const claimBase = verified.payload && verified.payload.claim && verified.payload.claim.base_commit;
  if (verified.verdict === "ADMITTED" && typeof claimBase === "string" && claimBase) {
    const compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${claimBase}...${pr.base.sha}`, { allowMissing: true });
    if (!compare) {
      outcome.verdict = "REJECTED";
      outcome.reasons.push(`claim_base_unknown:${claimBase}`);
    } else if (compare.status !== "ahead" && compare.status !== "identical") {
      outcome.verdict = "REJECTED";
      outcome.reasons.push(`base_behind_claim:${compare.status}`);
    }
  }
  outcome.admitted = outcome.verdict === "ADMITTED";
  return outcome;
}

// ---------------------------------------------------------------------------
// Reporting.

export function renderSummary(outcome) {
  const lines = [];
  lines.push("## clued-work-admission");
  lines.push("");
  lines.push(`**Verdict:** \`${outcome.verdict}\` · admitted: \`${outcome.admitted}\` · enforced: \`${outcome.enforced === null ? "n/a" : outcome.enforced}\``);
  if (outcome.claim_id) lines.push(`**Claim:** \`${outcome.claim_id}\` (scope \`${outcome.scope}\`)`);
  if (outcome.head_sha) lines.push(`**Head:** \`${outcome.head_sha}\` · **Base:** \`${outcome.base_sha}\``);
  if (outcome.error) lines.push(`**Error:** ${outcome.error}`);
  if (outcome.reasons.length) {
    lines.push("");
    lines.push("Reasons:");
    for (const reason of outcome.reasons) lines.push(`- ${reason}`);
  }
  if (outcome.paths_outside_write_set && outcome.paths_outside_write_set.length) {
    lines.push("");
    lines.push("Changed paths outside the claim's write set (renew the claim with a wider write set first):");
    for (const file of outcome.paths_outside_write_set) lines.push(`- \`${file}\``);
  }
  if (outcome.applicable_workflows.length) {
    lines.push("");
    lines.push(`Path-filtered workflows against the ${outcome.changed_paths.length} changed path(s) of this PR:`);
    lines.push("");
    lines.push("| Workflow | Applies | Why | Run on head |");
    lines.push("| --- | --- | --- | --- |");
    for (const workflow of outcome.applicable_workflows) {
      const run = workflow.run_status ? `${workflow.run_status}${workflow.run_conclusion ? ` / ${workflow.run_conclusion}` : ""}` : "none";
      lines.push(`| \`${workflow.file}\` | ${workflow.applies ? "yes" : "no"} | ${workflow.reason} | ${run} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function appendFile(file, text) {
  if (file) fs.appendFileSync(file, text);
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch) {
  const modeIndex = argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "required";
  if (mode !== "required" && mode !== "gate") {
    console.error("usage: clued-work-admission.mjs --mode required|gate");
    return 2;
  }
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  let event = null;
  if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  }
  let outcome;
  try {
    outcome = await evaluate({
      env, event, eventName, fetchImpl,
      workspace: env.GITHUB_WORKSPACE, withSummary: mode === "required",
    });
  } catch (error) {
    outcome = {
      mode, event: eventName, admitted: false, enforced: null, verdict: "ERROR", reasons: [],
      claim_id: null, scope: null, head_sha: null, base_sha: null, changed_paths: [],
      applicable_workflows: [], error: error instanceof Error ? error.message : String(error),
    };
  }
  outcome.mode = mode;
  console.log(JSON.stringify(outcome, null, 2));
  appendFile(env.GITHUB_STEP_SUMMARY, renderSummary(outcome));
  appendFile(env.GITHUB_OUTPUT, [
    `admitted=${outcome.admitted ? "true" : "false"}`,
    `enforced=${outcome.enforced === null ? "" : String(outcome.enforced)}`,
    `verdict=${outcome.verdict ?? ""}`,
    `claim_id=${outcome.claim_id ?? ""}`,
    "",
  ].join("\n"));
  if (outcome.error) {
    console.error(`::error title=clued-work-admission::${outcome.error}`);
    return 1;
  }
  if (!outcome.admitted) {
    const text = `${outcome.verdict}: ${outcome.reasons.join("; ")}`;
    if (mode === "required") {
      console.error(`::error title=clued-work-admission::${text}`);
      return 1;
    }
    console.error(`::warning title=admission-gate::${text}; heavy jobs are skipped.`);
    return 0;
  }
  if (outcome.verdict === "NOT_ENFORCED") {
    console.error("::notice title=clued-work-admission::Work claims are not enforced by the Clued service yet; admitted without a claim.");
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
