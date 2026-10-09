#!/usr/bin/env node
// Merge Admission v0.1 §7.3, step 3 of §13 (Task 3576d10d; Owner Decisions
// 4f576896 and 1fb7f6b3): the merge slot follows CI. The clued-merge-slot-ci
// workflow runs this on the default branch, with the CI admission Binding's
// token, whenever a CI workflow run of a pull request completes and by hand;
// the hourly re-verification runs it too. It reports the CI state of each
// open pull request that holds a merge slot:
//
//   failed   a CI required check (gitleaks, trivy, contract-placement and
//            clued-work-admission from GitHub Actions, clued-admission-verified
//            from the clued-admission App) finally failed on the head after
//            the claim got the slot (step 4: an admission check that failed
//            before, as it does when the head falls behind while the claim
//            waits in the merge queue, leaves the holder the slot to bring
//            the default branch in and push; it holds green back); Clued
//            returns the slot at once, and a failing clued-merge-slot check is
//            posted on the head so that auto-merge cannot merge it on a
//            re-run's green (independent review MAJOR-2).
//   running  a run of a CI workflow is queued or in progress on the head; the
//            slot stays 90 minutes after the report.
//   green    all required checks passed and no run of the head's pull request is
//            active, counted or not; the slot stays 30 minutes after the
//            head's first green report, for the merge.
// Anything else (checks not posted yet, nothing running, or only runs of
// workflows the pull request changed) is not reported, and the slot keeps its
// clocks (clued_work_merge_slot_touch_v1).
//
// Nothing in the triggering event is trusted (§7.3, re-review 2 N3c): a
// workflow_run event also fires for workflows a pull request adds or edits,
// and its name, branch, conclusion and pull requests come from that run. The
// event is only a signal to look. The pull requests come from the API, the
// slots from Clued, and the state from the head's check runs (by name and
// app id, as the ruleset reads them) and from the runs of the default
// branch's CI workflows (gitleaks, trivy and the gated workflows) whose file
// at the head is byte for byte the default branch's (git blob SHA). The
// clued-merge-slot check is not counted: it is the slot's result, not CI's.
//
// It runs from clued-merge-slot-ci.yml (a CI workflow of a pull request
// completed) and as a step of the hourly clued-work-admission-reverify run.
//
// GitHub requests per run: one list of open pull requests, one commit for
// each open pull request whose body names no claim, and for each pull request
// that holds a slot one check-run list per required check, one run list and, while something
// runs, one directory listing. Every run looks at every slot, whichever pull
// request's run completed: concurrency keeps one run pending and drops the
// others, so a run must not skip a holder (confirmation review MINOR-A).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMISSION_APP_ID,
  MERGE_SLOT_CHECK_NAME,
  admissionEnforced,
  appChecksOnHead,
  cluedRpc,
  githubJson,
  githubPaged,
  parseClaimReference,
  postAppCheck,
  withTokenHint,
  workflowIsGated,
} from "./clued-work-admission.mjs";
import { resolveMode } from "./merge-admission-policy.mjs";

export const TOUCH_RPC = "clued_work_merge_slot_touch_v1";
export const HOLDERS_RPC = "clued_work_merge_slot_holders_v1";
export const ACTIONS_APP_ID = 15368;
// All CI required checks of the main ruleset, by (name, app id).
// clued-merge-slot is required too, but it is the slot's own result.
export const CI_REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ name: "gitleaks", app_id: ACTIONS_APP_ID }),
  Object.freeze({ name: "trivy", app_id: ACTIONS_APP_ID }),
  Object.freeze({ name: "clued-work-admission", app_id: ACTIONS_APP_ID }),
  Object.freeze({ name: "clued-admission-verified", app_id: ADMISSION_APP_ID }),
  Object.freeze({ name: "contract-placement", app_id: ACTIONS_APP_ID }),
]);
// Workflows that count as CI besides the gated ones: those of the required checks
// that run on the self-hosted runners. clued-work-admission takes seconds.
export const REQUIRED_CHECK_WORKFLOWS = Object.freeze(["gitleaks.yml", "trivy.yml", "contract-placement.yml"]);
// A required check passes as the ruleset counts it. A final failure returns
// the slot; cancelled is not one: the admission run of an edited pull request
// cancels the previous one on the same head, and the next run's check may not
// exist yet (review NIT).
const PASSING = new Set(["success", "neutral", "skipped"]);
const FAILING = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
export const DEFAULT_HARD_CAP_MINUTES = 120;

// The git blob SHA of a file's bytes, as the contents API reports it.
export function gitBlobSha(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

// The default branch's CI workflows in this checkout: path -> blob SHA.
export function ciWorkflows(workspace, readDir = fs.readdirSync, readFile = fs.readFileSync) {
  const dir = path.join(workspace, ".github", "workflows");
  const out = new Map();
  for (const file of readDir(dir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const bytes = readFile(path.join(dir, file));
    if (REQUIRED_CHECK_WORKFLOWS.includes(file) || workflowIsGated(bytes.toString("utf8"))) {
      out.set(`.github/workflows/${file}`, gitBlobSha(bytes));
    }
  }
  return out;
}

// The newest check run of a required check on the head, or null.
async function newestCheck(fetchImpl, env, repository, headSha, { name, app_id: appId }) {
  const checks = await githubPaged(fetchImpl, env,
    `/repos/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all`, "check_runs");
  return checks
    .filter((check) => check && check.name === name && check.head_sha === headSha
      && check.app && Number(check.app.id) === appId)
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}

// failed, running, green, or idle (not reported), with what was seen. An
// admission check's failure that completed before slotSince (when the claim
// became head of the merge queue, ms) is not reported.
const STALE_OK = new Set(["clued-work-admission", "clued-admission-verified"]);
export async function ciStateOf(fetchImpl, env, repository, headSha, workflows, slotSince = null) {
  const checks = [];
  let before = null;
  for (const required of CI_REQUIRED_CHECKS) {
    const check = await newestCheck(fetchImpl, env, repository, headSha, required);
    checks.push({ name: required.name, status: check ? check.status : "missing", conclusion: check ? check.conclusion ?? null : null });
    if (check && check.status === "completed" && FAILING.has(check.conclusion)) {
      const completed = Date.parse(check.completed_at ?? "");
      // Only the admission checks: they fail when the head falls behind while the claim waits. A
      // gitleaks or trivy failure is the head's own (independent review MINOR-6).
      if (STALE_OK.has(required.name) && Number.isFinite(slotSince) && Number.isFinite(completed) && completed < slotSince) {
        before ??= `${required.name} concluded ${check.conclusion} before the slot was taken`;
        continue;
      }
      return { state: "failed", reason: `${required.name} concluded ${check.conclusion}`, checks };
    }
  }
  const runs = await githubJson(fetchImpl, env, `/repos/${repository}/actions/runs?head_sha=${headSha}&per_page=100`);
  const anyActive = (Array.isArray(runs && runs.workflow_runs) ? runs.workflow_runs : [])
    .filter((run) => run && run.head_sha === headSha && run.event === "pull_request" && ACTIVE.has(run.status))
    .map((run) => ({ id: run.id, path: String(run.path ?? "").replace(/@.*$/, ""), status: run.status }));
  const active = anyActive.filter((run) => workflows.has(run.path));
  if (active.length) {
    // Counted only while the head's copy of the workflow is the default branch's.
    const listing = await githubJson(fetchImpl, env, `/repos/${repository}/contents/.github/workflows?ref=${headSha}`);
    const atHead = new Map((Array.isArray(listing) ? listing : []).map((entry) => [entry.path, entry.sha]));
    const same = active.filter((run) => atHead.get(run.path) === workflows.get(run.path));
    if (same.length) return { state: "running", reason: same.map((run) => `${run.path} ${run.status}`).join(", "), checks };
  }
  // A run that is not counted (a workflow the pull request added or changed)
  // keeps nothing alive, but it is CI the pull request still waits for: not
  // green yet (confirmation review MINOR-C).
  if (anyActive.length) {
    return { state: "idle", reason: `only runs that are not counted are active: ${anyActive.map((run) => `${run.path} ${run.status}`).join(", ")}`, checks };
  }
  if (before) return { state: "idle", reason: before, checks };
  if (checks.every((check) => check.status === "completed" && PASSING.has(check.conclusion))) {
    return { state: "green", reason: "all CI required checks passed", checks };
  }
  return { state: "idle", reason: "no CI result yet and no CI run active", checks };
}

async function newestSlotCheckGreen(fetchImpl, env, repository, headSha) {
  const [newest] = await appChecksOnHead(fetchImpl, env, repository, headSha, MERGE_SLOT_CHECK_NAME);
  return Boolean(newest) && newest.status === "completed" && newest.conclusion === "success";
}

const notDeployed = (response) => response.status === 404 && response.body && response.body.code === "PGRST202";

function rpcError(name, response) {
  if (response.status !== 200 || !response.body || typeof response.body !== "object") return `Clued ${name} returned ${response.detail}`;
  if (response.body.status !== "ok") return `Clued ${name} answered ${response.detail}`;
  if (response.body.reason === "admission_binding_required") return withTokenHint(`Clued ${name}: admission_binding_required`);
  return null;
}

export async function reportMergeSlots({ env, event, eventName, fetchImpl, workspace, readPolicyFile = fs.readFileSync }) {
  const repository = env.GITHUB_REPOSITORY;
  const mode = resolveMode({ env, workspace, readFile: readPolicyFile });
  const hardCap = (mode.policy && mode.policy.merge_slot_hard_cap_minutes) || DEFAULT_HARD_CAP_MINUTES;
  const result = { event: eventName, hard_cap_minutes: hardCap, holders: [], reports: [], skipped: null, notices: [], errors: [] };
  if (!(env.CLUED_CONTEXT_READ_TOKEN ?? "").trim()) {
    result.errors.push(withTokenHint("CLUED_CONTEXT_READ_TOKEN is not set."));
    return result;
  }
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  const workflows = ciWorkflows(workspace);
  const pulls = (await githubPaged(fetchImpl, env, `/repos/${repository}/pulls?state=open`))
    .filter((pr) => pr && pr.head && pr.base && pr.base.repo && pr.base.ref === pr.base.repo.default_branch);
  const byRef = new Map(pulls.map((pr) => [`${repository}#${pr.number}`.toLowerCase(), pr]));
  // The scopes the open pull requests name; a slot's pull request names its
  // claim, in its body or, as admission also reads it, its head commit.
  const references = [];
  for (const pr of pulls) {
    let reference = parseClaimReference(pr.body);
    if (!reference) {
      try {
        const commit = await githubJson(fetchImpl, env, `/repos/${repository}/commits/${pr.head.sha}`);
        reference = parseClaimReference(commit && commit.commit && commit.commit.message);
      } catch (error) {
        // One unreadable commit does not stop the other pull requests' reports.
        result.errors.push(`#${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (reference) references.push(reference);
  }
  const scopes = [...new Set(references.map((ref) => ref.scope))].sort();
  const live = [];
  for (const scope of scopes) {
    const response = await cluedRpc(fetchImpl, env, workspace, HOLDERS_RPC, { scope, repository });
    // Merged before migration 20261009010000 was applied: nothing to report yet (review MINOR-6).
    if (notDeployed(response)) {
      result.notices.push(`${HOLDERS_RPC} is not deployed yet (migration 20261009010000); nothing reported`);
      return result;
    }
    const error = rpcError(HOLDERS_RPC, response);
    if (error) { result.errors.push(error); continue; }
    for (const holder of Array.isArray(response.body.holders) ? response.body.holders : []) {
      const pr = typeof holder.bound_pr === "string" ? byRef.get(holder.bound_pr.toLowerCase()) : undefined;
      result.holders.push({ scope, claim_id: holder.claim_id, bound_pr: holder.bound_pr ?? null, open: Boolean(pr),
        merge_slot_until: holder.merge_slot_until ?? null });
      // Two claims bound to one pull request are reported once: the report is per pull request.
      const since = Date.parse(holder.merge_slot_ci && holder.merge_slot_ci.taken_at || "");
      if (pr && !live.some((entry) => entry.pr === pr)) live.push({ scope, pr, since: Number.isFinite(since) ? since : null });
    }
  }
  // The slot check is failed only where the policy requires the slot: in
  // efficiency it only advises it for code and docs, and while admission is
  // advisory the check is not enforced (confirmation review MINOR-B).
  const slotRequired = admissionEnforced(env, mode) && mode.state !== "efficiency";
  for (const { pr, scope, since } of live) {
    const prRef = `${repository}#${pr.number}`;
    try {
      const seen = await ciStateOf(fetchImpl, env, repository, pr.head.sha, workflows, since);
      const report = { pr: pr.number, head_sha: pr.head.sha, ci_state: seen.state, reason: seen.reason };
      if (seen.state !== "idle") {
        const response = await cluedRpc(fetchImpl, env, workspace, TOUCH_RPC, {
          scope, pr_ref: prRef, head_sha: pr.head.sha, ci_state: seen.state,
          ...(seen.state === "failed" ? {} : { hard_cap_minutes: hardCap }),
        });
        const error = rpcError(TOUCH_RPC, response);
        if (error) throw new Error(error);
        Object.assign(report, seen.state === "failed"
          ? { returned: Boolean(response.body.returned) }
          : { touched: Boolean(response.body.touched), merge_slot_until: response.body.merge_slot_until ?? null });
        // The head's clued-merge-slot check may still be green: fail it, so a
        // re-run that turns CI green cannot let auto-merge merge without the
        // slot. Also when an earlier run returned the slot but could not post
        // (confirmation review NIT-2): the newest App check is still green then.
        const stale = seen.state === "failed" && slotRequired
          && (report.returned || await newestSlotCheckGreen(fetchImpl, env, repository, pr.head.sha));
        if (stale) {
          const posted = await postAppCheck({ env, fetchImpl, headSha: pr.head.sha, success: false, prNumber: pr.number,
            name: MERGE_SLOT_CHECK_NAME, title: "Merge slot returned: CI failed",
            summary: `${seen.reason} on this head, so Clued gave the merge slot back (Merge Admission v0.1 §7.3). `
              + "Turn auto-merge off and fix the cause; then take the slot again and push, or edit the pull request body, to run this check again." });
          if (!posted.posted) throw new Error(`the slot was returned but no failing ${MERGE_SLOT_CHECK_NAME} check could be posted: ${posted.error ?? posted.reason}`);
          report.merge_slot_check_run_id = posted.check_run_id;
        }
      }
      result.reports.push(report);
    } catch (error) {
      result.errors.push(`#${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export function renderSummary(result) {
  const lines = ["## clued-merge-slot-ci", "", `Event \`${result.event || "?"}\` · hard cap ${result.hard_cap_minutes} minutes`, ""];
  if (!result.holders.length) lines.push("No open pull request holds a merge slot.");
  for (const holder of result.holders) {
    lines.push(`- slot of claim \`${holder.claim_id}\` on ${holder.bound_pr ?? "no pull request"}${holder.open ? "" : " (not an open pull request into the default branch)"}, until ${holder.merge_slot_until ?? "?"}`);
  }
  if (result.skipped) lines.push("", `Skipped: ${result.skipped}.`);
  for (const notice of result.notices) lines.push(`- notice: ${notice}`);
  for (const report of result.reports) {
    const outcome = report.ci_state === "idle" ? "not reported"
      : report.ci_state === "failed" ? (report.returned ? "slot returned" : "nothing to return")
        : report.touched ? `slot kept until ${report.merge_slot_until}` : "no live slot to keep";
    lines.push(`- #${report.pr} \`${report.head_sha.slice(0, 12)}\`: **${report.ci_state}** (${report.reason}); ${outcome}`);
  }
  for (const error of result.errors) lines.push(`- error: ${error}`);
  return `${lines.join("\n")}\n`;
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  let event = null;
  if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  }
  const result = await reportMergeSlots({ env, event, eventName: env.GITHUB_EVENT_NAME ?? "", fetchImpl, workspace: env.GITHUB_WORKSPACE });
  console.log(JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
  for (const notice of result.notices) console.error(`::notice title=clued-merge-slot-ci::${notice}`);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`::error title=clued-merge-slot-ci::${error}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
