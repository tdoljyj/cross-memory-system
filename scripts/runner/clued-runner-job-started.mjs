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
//   - a pull request into main that changes a workflow, once the head carries
//     a successful clued-admission-verified check from the clued-admission
//     GitHub App. Only main's admission run can post it: the App key lives in
//     the clued-admission environment, which deploys from main only. That run
//     checks the workflow change. (Re-review 2, N3c: a workflow run's
//     pull_requests list names every open pull request with the same head, not
//     the one that triggered it, so an admission run of a pull request into
//     another branch, whose copy of the admission workflow passes anything,
//     could have stood in for it.)
//     (Re-review 3, N-R1: only a check posted after this run was created
//     counts, so an older success on the same head cannot stand in.)
//   - a hand dispatch on another branch of one of DISPATCH_GATED_WORKFLOWS,
//     whose .github/workflows directory is exactly main's. That workflow keeps
//     the dispatch gate, which needs a Clued admission run for the dispatched
//     commit. (Re-review 2, finding B: the earlier main...sha compare saw no
//     change on a branch pointing at an old main commit, from before a
//     workflow had its gate. Re-review 3, N-R2: other dispatchable workflows
//     have no gate, so they run on main only.)
// Any workflow file counts, not only the one running: a called (reusable)
// workflow runs under its caller's name.
// Re-review 3, N-R3: a re-run (run attempt 2 or later) of a pull request or
// branch dispatch run is refused. A re-run replays its run's own workflow
// file, which may be one from before the gates existed, and "re-run failed
// jobs" keeps the gate's earlier output. Push a new commit instead.
// Everything else is refused: pushes to other branches, pull requests into
// other branches, other events.
//
// Configuration (runner machine environment, e.g. the runner's .env file):
//   CLUED_RUNNER_HOOK_REPOSITORY   owner/name this runner serves (required)
//   CLUED_RUNNER_HOOK_TOKEN_FILE   file holding a read-only GitHub token
//                                  (contents, actions, checks, pull requests:
//                                  read)
//   CLUED_RUNNER_HOOK_ADMISSION_APP_ID  id of the clued-admission App whose
//                                  check admits a head (default: the Owner's
//                                  App, ADMISSION_APP_ID below)
//   CLUED_RUNNER_HOOK_ENFORCE      "true" refuses; anything else only reports
//   CLUED_RUNNER_HOOK_WAIT_SECONDS how long to wait for the admission run (480)
// It needs Node 18 or newer (the runner bundles one under externals/).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ADMISSION_CHECK = "clued-admission-verified";
export const ADMISSION_APP_ID = 5164952;
// The same list as DISPATCH_GATED_WORKFLOWS in scripts/ci/clued-work-admission.mjs
// (this file is installed alone, so it keeps its own copy; a test compares them).
export const DISPATCH_GATED_WORKFLOWS = ["clued-connection-authorization.yml", "clued-g4-database.yml", "information-flow-e2e.yml"];
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

// The workflow files a pull request changes against the default branch (from
// their merge base). Its workflows run from the merge ref, which is main plus
// these changes. A list GitHub truncates counts as changing workflows.
export const COMPARE_FILE_LIMIT = 300;
async function changedWorkflows(fetchImpl, token, repository, base, head) {
  const body = await github(fetchImpl, token, `/repos/${repository}/compare/${encodeURIComponent(base)}...${head}`);
  const files = (body && Array.isArray(body.files)) ? body.files : null;
  if (!files || files.length >= COMPARE_FILE_LIMIT) return ["(file list unavailable or truncated)"];
  return files.map((f) => String(f.filename ?? "")).concat(files.map((f) => String(f.previous_filename ?? "")))
    .filter((name) => name.startsWith(".github/workflows/"));
}

// A hand dispatch runs the dispatched commit's own workflow files, so they
// must be main's exactly: same entries, same blob (or tree) object ids.
async function workflowsDifferFromMain(fetchImpl, token, repository, base, sha) {
  const listing = async (ref) => {
    const body = await github(fetchImpl, token, `/repos/${repository}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
      { allowMissing: true });
    if (body === null) return new Map();
    if (!Array.isArray(body)) throw new Error(".github/workflows is not a directory");
    return new Map(body.map((entry) => [String(entry.path ?? entry.name ?? ""), `${entry.type}:${entry.sha}`]));
  };
  const [mine, main] = await Promise.all([listing(sha), listing(base)]);
  const names = new Set([...mine.keys(), ...main.keys()]);
  return [...names].filter((name) => mine.get(name) !== main.get(name)).sort();
}

// The newest clued-admission-verified check of the admission App on a head,
// posted at or after `since` (ms).
async function admissionCheck(fetchImpl, token, repository, headSha, appId, since) {
  const body = await github(fetchImpl, token,
    `/repos/${repository}/commits/${headSha}/check-runs?check_name=${ADMISSION_CHECK}&filter=all&per_page=100`);
  let latest = null;
  for (const check of (body && body.check_runs) || []) {
    if (check.name !== ADMISSION_CHECK || check.head_sha !== headSha) continue;
    if (!check.app || Number(check.app.id) !== appId) continue;
    const posted = Date.parse(check.started_at ?? check.completed_at ?? "");
    if (!(posted >= since)) continue;
    if (!latest || Number(check.id) > Number(latest.id)) latest = check;
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
  const runId = (env.GITHUB_RUN_ID ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(runId)) throw new Error("GITHUB_RUN_ID is not a run id.");
  const run = await github(fetchImpl, token, `/repos/${repository}/actions/runs/${runId}`);
  const attempt = Math.max(Number(run && run.run_attempt) || 1, Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? "1", 10) || 1);
  if (attempt > 1) {
    result.reason = `${event} on ${result.ref}: run attempt ${attempt}; re-runs are refused, push a new commit`;
    return result;
  }
  if (event === "workflow_dispatch") {
    const file = workflow.slice(".github/workflows/".length);
    if (!DISPATCH_GATED_WORKFLOWS.includes(file)) {
      result.reason = `dispatch of ${workflow} on ${result.ref}: only ${DISPATCH_GATED_WORKFLOWS.join(", ")} may be dispatched on another branch; this one runs on ${defaultBranch} only`;
      return result;
    }
    const differing = await workflowsDifferFromMain(fetchImpl, token, repository, defaultBranch, sha);
    result.allow = differing.length === 0;
    result.reason = result.allow ? `dispatch on ${result.ref}, workflows identical to ${defaultBranch}`
      : `dispatch on ${result.ref}: workflows differ from ${defaultBranch} (${differing.join(", ")}); merge ${defaultBranch} into the branch first`;
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
    const configured = Number.parseInt((env.CLUED_RUNNER_HOOK_ADMISSION_APP_ID ?? "").trim(), 10);
    const appId = Number.isInteger(configured) && configured > 0 ? configured : ADMISSION_APP_ID;
    const since = Date.parse(run && run.created_at);
    if (!Number.isFinite(since)) throw new Error(`run ${runId} has no created_at.`);
    let check = null;
    for (let waited = 0; ; waited += 10) {
      check = await admissionCheck(fetchImpl, token, repository, pr.head.sha, appId, since);
      if ((check && check.status === "completed") || waited >= limit) break;
      await sleep(10_000);
    }
    result.allow = Boolean(check && check.status === "completed" && check.conclusion === "success");
    const what = [...new Set(changed)].join(", ");
    result.reason = result.allow ? `pull request #${pr.number} changes ${what}; ${ADMISSION_CHECK} ${check.id} succeeded`
      : `pull request #${pr.number} changes ${what}; no successful ${ADMISSION_CHECK} from App ${appId} on ${pr.head.sha} posted since ${run.created_at} (${check ? `${check.status}/${check.conclusion}` : "none"})`;
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
