#!/usr/bin/env node
// Clued self-hosted runner pre-job check (Task 869d2db7, Owner Decision
// b0c53143). The GitHub runner runs this before every job through
// ACTIONS_RUNNER_HOOK_JOB_STARTED; a non-zero exit fails the job before any
// step runs. It is installed on the runner machine, outside the repository, so
// a branch that edits a workflow cannot edit this check too.
//
// A job may start when its run comes from:
//   - main: push, schedule, workflow_run, pull_request_target, or a hand
//     dispatch on main. Those workflow files are main's own. A
//     pull_request_target run counts only for a pull request into main
//     (re-review 7, m1).
//   - a pull request into main that changes no file under .github/workflows/.
//     Its workflows are main's, so each keeps its admission-gate job, which
//     waits for the Clued admission of the pull request.
//   - a pull request into main that changes a workflow, once the admission
//     run of this run's own event (clued-work-admission.yml, triggered by
//     pull_request_target) has succeeded. That run checks the workflow change.
//     (Re-review 3, N-R1, and re-review 5, n1: an older success on the same
//     head cannot stand in.) Task b979d5a2: the hook reads that run, not the
//     clued-admission App's check, because a fine-grained token cannot read
//     the Checks API. See admissionRun below.
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
//   CLUED_RUNNER_HOOK_TOKEN_FILE   file holding a read-only fine-grained
//                                  GitHub token (actions and contents: read)
//   CLUED_RUNNER_HOOK_ENFORCE      "true" refuses; anything else only reports
//   CLUED_RUNNER_HOOK_WAIT_SECONDS how long to wait for the admission run (480)
// It needs Node 18 or newer (the runner bundles one under externals/).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// The admission run of this run's own event (re-review 5, n1; the same
// selection as eventAdmissionCheck in scripts/ci/clued-work-admission.mjs).
// The runs of one event are created together, so it is the newest
// pull_request_target run of the admission workflow on this head created no
// earlier than SAME_EVENT_MS before this run. A run's creation time, not a
// later posting time, tells a closed and reopened pull request's events apart.
// Skipped runs are passed over: the admission job skips a pull request into
// another branch, and an Agent can open one on the same head.
//
// The run stands in for the clued-admission App's check, which a fine-grained
// token cannot read (Task b979d5a2):
//   - pull_request_target always runs the default branch's copy of the
//     workflow, whatever the pull request's base, and that copy admits only
//     pull requests into the default branch (re-review 6, B1). No branch's
//     edited copy of the file runs on pull_request_target. Runs are listed by
//     the workflow's file name, so a workflow another file adds under the same
//     display name does not count.
//   - The run succeeds only when its admit step does, the same condition on
//     which it posts a successful check.
// The check also named its pull request (re-review 4, m1); a run does not
// (its pull_requests list names every open pull request with the same head).
// Another pull request into main with the same head and an event within
// SAME_EVENT_MS can therefore stand in. Its run judged the same commit and the
// same workflow changes.
export const SAME_EVENT_MS = 15_000;
const ADMISSION_WORKFLOW = "clued-work-admission.yml";
async function admissionRun(fetchImpl, token, repository, headSha, since) {
  const runs = (await github(fetchImpl, token,
    `/repos/${repository}/actions/workflows/${ADMISSION_WORKFLOW}/runs?head_sha=${headSha}&event=pull_request_target&per_page=100`))
    ?.workflow_runs ?? [];
  return runs
    .filter((run) => run && run.event === "pull_request_target" && run.head_sha === headSha && run.conclusion !== "skipped"
      && Date.parse(run.created_at) >= since - SAME_EVENT_MS)
    .sort((a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || (Number(b.id) - Number(a.id)))[0] ?? null;
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
    // Re-review 7, m1: pull_request_target runs on the default branch's ref
    // whatever the pull request's base, and a workflow may check out that
    // base, which an Agent controls when it is another branch.
    if (event === "pull_request_target") {
      const payload = JSON.parse(String(readFile(env.GITHUB_EVENT_PATH, "utf8")));
      const base = payload && payload.pull_request && payload.pull_request.base;
      if (!base || base.ref !== defaultBranch) {
        result.reason = `pull_request_target for a pull request into ${base ? base.ref : "(unknown)"}, not ${defaultBranch}`;
        return result;
      }
    }
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
    const since = Date.parse(run && run.created_at);
    if (!Number.isFinite(since)) throw new Error(`run ${runId} has no created_at.`);
    let found = null;
    for (let waited = 0; ; waited += 10) {
      found = await admissionRun(fetchImpl, token, repository, pr.head.sha, since);
      if ((found && found.status === "completed") || waited >= limit) break;
      await sleep(10_000);
    }
    result.allow = Boolean(found && found.status === "completed" && found.conclusion === "success");
    const what = [...new Set(changed)].join(", ");
    const seen = !found ? "no admission run" : `admission run ${found.id}: ${found.status}/${found.conclusion ?? "none"}`;
    result.reason = result.allow ? `pull request #${pr.number} changes ${what}; admission run ${found.id} succeeded`
      : `pull request #${pr.number} changes ${what}; no successful ${ADMISSION_WORKFLOW} run on ${pr.head.sha} from this event (created since ${run.created_at} less ${SAME_EVENT_MS / 1000}s; ${seen})`;
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
