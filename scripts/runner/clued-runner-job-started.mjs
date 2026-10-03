#!/usr/bin/env node
// Clued self-hosted runner pre-job check (Task 869d2db7, Owner Decision
// b0c53143). The GitHub runner runs this before every job through
// ACTIONS_RUNNER_HOOK_JOB_STARTED; a non-zero exit fails the job before any
// step runs. It is installed on the runner machine, outside the repository, so
// a branch that edits a workflow cannot edit this check too.
//
// A job may start when its run comes from:
//   - main: push, schedule, workflow_run, pull_request_target, or a hand
//     dispatch on main. Those workflow files are main's own.
//   - a pull request into main that changes no file under .github/workflows/.
//     Its workflows are main's, so each keeps its admission-gate job, which
//     waits for the Clued admission of the pull request.
//   - a pull request into main that changes a workflow, once the base-branch
//     admission run (clued-work-admission.yml, pull_request_target) for that
//     pull request and head succeeded. That run executes main's code, which
//     checks the workflow change.
//   - a hand dispatch on another branch that changes no workflow against main.
//     Its workflow keeps the dispatch gate, which needs a Clued admission run
//     for the dispatched commit.
// Any workflow file counts, not only the one running: a called (reusable)
// workflow runs under its caller's name.
// Everything else is refused: pushes to other branches, pull requests into
// other branches, other events.
//
// Configuration (runner machine environment, e.g. the runner's .env file):
//   CLUED_RUNNER_HOOK_REPOSITORY   owner/name this runner serves (required)
//   CLUED_RUNNER_HOOK_TOKEN_FILE   file holding a read-only GitHub token
//                                  (contents, actions, pull requests: read)
//   CLUED_RUNNER_HOOK_ENFORCE      "true" refuses; anything else only reports
//   CLUED_RUNNER_HOOK_WAIT_SECONDS how long to wait for the admission run (480)
// It needs Node 18 or newer (the runner bundles one under externals/).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ADMISSION_WORKFLOW = "clued-work-admission.yml";
const MAIN_EVENTS = new Set(["push", "schedule", "workflow_run", "pull_request_target", "workflow_dispatch"]);

export function workflowPathOf(env) {
  const match = /^[^/]+\/[^/]+\/(\.github\/workflows\/[^@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? "");
  return match ? match[1] : null;
}

async function github(fetchImpl, token, url, { allowMissing = false } = {}) {
  const response = await fetchImpl(`https://api.github.com${url}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "clued-runner-hook",
      "x-github-api-version": "2022-11-28" },
  });
  if (allowMissing && response.status === 404) return null;
  if (response.status !== 200) throw new Error(`GitHub ${url} returned ${response.status}`);
  return response.json();
}

// The workflow files a commit changes against the default branch (from their
// merge base). A list GitHub truncates counts as changing workflows.
export const COMPARE_FILE_LIMIT = 300;
async function changedWorkflows(fetchImpl, token, repository, base, head) {
  const body = await github(fetchImpl, token, `/repos/${repository}/compare/${encodeURIComponent(base)}...${head}`);
  const files = (body && Array.isArray(body.files)) ? body.files : null;
  if (!files || files.length >= COMPARE_FILE_LIMIT) return ["(file list unavailable or truncated)"];
  return files.map((f) => String(f.filename ?? "")).concat(files.map((f) => String(f.previous_filename ?? "")))
    .filter((name) => name.startsWith(".github/workflows/"));
}

async function admissionSucceeded(fetchImpl, token, repository, prNumber, headSha) {
  const body = await github(fetchImpl, token,
    `/repos/${repository}/actions/workflows/${ADMISSION_WORKFLOW}/runs?head_sha=${headSha}&event=pull_request_target&per_page=20`);
  let latest = null;
  for (const run of (body && body.workflow_runs) || []) {
    if (run.event !== "pull_request_target" || run.head_sha !== headSha) continue;
    if (!Array.isArray(run.pull_requests) || !run.pull_requests.some((p) => p && p.number === prNumber)) continue;
    if (!latest || Date.parse(run.created_at) > Date.parse(latest.created_at)) latest = run;
  }
  return latest;
}

export async function decide({ env, fetchImpl, readFile = fs.readFileSync, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const result = { allow: false, reason: "", event: env.GITHUB_EVENT_NAME ?? "", ref: env.GITHUB_REF ?? "", workflow: null };
  const repository = (env.CLUED_RUNNER_HOOK_REPOSITORY ?? "").trim();
  const defaultBranch = (env.CLUED_RUNNER_HOOK_DEFAULT_BRANCH ?? "").trim() || "main";
  const mainRef = `refs/heads/${defaultBranch}`;
  if (!repository) throw new Error("CLUED_RUNNER_HOOK_REPOSITORY is not set on this runner.");
  if (env.GITHUB_REPOSITORY !== repository) {
    result.reason = `repository ${env.GITHUB_REPOSITORY} is not ${repository}`;
    return result;
  }
  const workflow = workflowPathOf(env);
  result.workflow = workflow;
  if (!workflow) throw new Error(`GITHUB_WORKFLOW_REF is not a workflow path: ${env.GITHUB_WORKFLOW_REF}`);
  const event = result.event;
  if (MAIN_EVENTS.has(event) && result.ref === mainRef) {
    result.allow = true;
    result.reason = `${event} on ${defaultBranch}`;
    return result;
  }
  if (event !== "pull_request" && event !== "workflow_dispatch") {
    result.reason = `${event} on ${result.ref} is not allowed on this runner`;
    return result;
  }
  const tokenFile = (env.CLUED_RUNNER_HOOK_TOKEN_FILE ?? "").trim();
  if (!tokenFile) throw new Error("CLUED_RUNNER_HOOK_TOKEN_FILE is not set on this runner.");
  const token = String(readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error(`${tokenFile} is empty.`);
  const sha = (env.GITHUB_SHA ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GITHUB_SHA is not a commit SHA.");
  if (event === "workflow_dispatch") {
    const changed = await changedWorkflows(fetchImpl, token, repository, defaultBranch, sha);
    result.allow = changed.length === 0;
    result.reason = result.allow ? `dispatch on ${result.ref}, no workflow changed from ${defaultBranch}`
      : `dispatch on ${result.ref} changes ${[...new Set(changed)].join(", ")}`;
    return result;
  }
  if (event === "pull_request") {
    const payload = JSON.parse(String(readFile(env.GITHUB_EVENT_PATH, "utf8")));
    const pr = payload && payload.pull_request;
    if (!pr || !pr.base || !pr.head) throw new Error("pull_request payload is missing.");
    if (pr.base.ref !== defaultBranch) {
      result.reason = `pull request into ${pr.base.ref}, not ${defaultBranch}`;
      return result;
    }
    const changed = await changedWorkflows(fetchImpl, token, repository, defaultBranch, pr.head.sha);
    if (changed.length === 0) {
      result.allow = true;
      result.reason = `pull request #${pr.number} changes no workflow`;
      return result;
    }
    const waitSeconds = Number.parseInt(env.CLUED_RUNNER_HOOK_WAIT_SECONDS ?? "", 10);
    const limit = Number.isInteger(waitSeconds) && waitSeconds >= 0 ? waitSeconds : 480;
    let run = null;
    for (let waited = 0; ; waited += 10) {
      run = await admissionSucceeded(fetchImpl, token, repository, pr.number, pr.head.sha);
      if ((run && run.status === "completed") || waited >= limit) break;
      await sleep(10_000);
    }
    result.allow = Boolean(run && run.status === "completed" && run.conclusion === "success");
    const what = [...new Set(changed)].join(", ");
    result.reason = result.allow ? `pull request #${pr.number} changes ${what}; admission run ${run.id} succeeded`
      : `pull request #${pr.number} changes ${what}; no successful admission run for it (${run ? `${run.status}/${run.conclusion}` : "none"})`;
    return result;
  }
  throw new Error(`unreachable event ${event}`);
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const enforce = /^(1|true|on|enabled)$/i.test((env.CLUED_RUNNER_HOOK_ENFORCE ?? "").trim());
  let result;
  try {
    result = await decide({ env, fetchImpl });
  } catch (error) {
    result = { allow: false, reason: `check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const line = `clued-runner-hook: ${result.allow ? "ALLOW" : enforce ? "REFUSE" : "WOULD REFUSE"} ${result.reason}`;
  if (result.allow) { console.log(line); return 0; }
  console.log(enforce ? `::error title=Clued runner check::${line}` : `::warning title=Clued runner check (not enforced)::${line}`);
  return enforce ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
}
