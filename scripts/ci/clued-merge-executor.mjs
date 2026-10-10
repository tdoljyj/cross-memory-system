#!/usr/bin/env node
// Merge Admission v0.1 §7.2–§7.4, step 5 of §13 (Task 91039d74; Owner
// Decisions 661f8c36 and 5aa668e3): the executor does the head of the merge
// queue's work while its Agent keeps the claim live. The clued-merge-executor
// workflow runs this on the default branch after each clued-merge-slot-ci
// run, after each push to main and by hand. For each open pull request into the default branch
// whose claim heads a merge queue (clued_work_merge_slot_holders_v1 lists
// only heads since migration 20261009080000):
//
//   behind      the head does not contain the default branch's tip: the
//               executor brings it in with GitHub's "update branch" (a merge
//               commit, expected_head_sha bound to the head it read). A head
//               that only merges the default branch in keeps an Owner grant
//               (Decision a0d93cd0), and the App's push starts CI, which a
//               GITHUB_TOKEN push would not. Not for a protected-layer pull
//               request: when the default branch changed a protected file it
//               also changes, the merge needs a new Owner Grant, so its
//               holder brings the branch in (review MINOR-4).
//   up to date  the executor turns on GitHub auto-merge (merge commit,
//               expectedHeadOid) and GitHub waits for the required checks
//               still running (§7.4; GitHub refuses auto-merge on a pull
//               request that is already mergeable, review MAJOR-1). Only
//               once every CI workflow that ran on the head passed, its
//               gated jobs run (no gated workflow is a required check, so
//               auto-merge alone would not wait for them; Task 114d43cf),
//               and only when
//               - a non-protected claim renewal names the complete current
//                 head SHA, or the body has "Clued-Auto-Merge: <head sha>" naming
//                 this head, or an ancestor such that every file changed
//                 since is identical to the default branch's (the Agent
//                 writes it once the merge of that head is approved; any
//                 other change needs a new line, review MAJOR-2),
//               - the head's clued-admission-verified check, posted for this
//                 pull request, admitted it and the policy allows auto-merge
//                 for its state and layer (never in frozen; a protected
//                 layer is under Owner review, which is always enforced since
//                 Merge Admission step 6, review MINOR-1),
//               - no CI required check has finally failed on the head,
//               - auto-merge is not on already.
//               When the line names another head and auto-merge is on, the
//               executor turns it off. Without a line it leaves auto-merge
//               alone: the Agent merges as before.
//   mergeable   GitHub refuses auto-merge on a pull request that can merge
//               now ("clean status"). Under the same conditions, and only when
//               the newest pull_request run of every CI workflow on the head
//               succeeded with its gate and gated jobs run (GitHub counts a skipped gated
//               job as passing, and none of the gated workflows is required by
//               the ruleset; review MAJOR-1), the executor merges it itself
//               (merge commit, sha bound to the head it read); the ruleset
//               still requires every required check. The opt-in line is the
//               merge approval, so nobody has to click merge (Owner, Task
//               ff476b06). "unstable status" (a check that is not required
//               failed or is pending) is never merged. A merge the executor
//               does is a material outcome its holder records in Clued on its
//               next resume. The state is read when the job starts: a switch
//               to frozen during a run of at most five minutes does not stop
//               a merge already decided (review MINOR-1).
//   otherwise   nothing: the pull request has a conflict the holder must
//               resolve, or CI failed (clued-merge-slot-ci returns the slot).
//   gate only   after admission, rerun all jobs of a successful run whose
//               gate passed and every other job skipped, once within the
//               admission title's rerun limit. Use the workflow GITHUB_TOKEN;
//               the App's permissions are unchanged. Both trusted entry points
//               serialize the executor, and the run attempt is rechecked.
//
// It acts as the clued-admission App, with an installation token for
// Contents: write and Pull requests: write. Until the Owner grants those
// permissions the token request fails and the executor only reports that,
// changing nothing. In frozen it does nothing at all. It merges only an
// opted-in head GitHub can merge now, never pushes to the default branch (the
// ruleset forbids it) and trusts nothing in the triggering event.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMISSION_APP_ID,
  appChecksOnHead,
  appJwt,
  checkNamesPullRequest,
  cluedRpc,
  githubJson,
  githubPaged,
  parseClaimReference,
  withTokenHint,
} from "./clued-work-admission.mjs";
import { HOLDERS_RPC, ciStateOf, ciWorkflows } from "./clued-merge-slot-ci.mjs";
import { effectiveRules, parseModeLabel, resolveMode } from "./merge-admission-policy.mjs";

export const OPT_IN = /^\s*Clued-Auto-Merge:\s*([0-9a-f]{40})\s*$/im;
export const EXECUTOR_PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write" });
const VERIFIED_CHECK = "clued-admission-verified";

// The head the pull request body opts in to auto-merge for, or null.
export function optInSha(body) {
  const match = OPT_IN.exec(String(body ?? ""));
  return match ? match[1].toLowerCase() : null;
}

// Whether the opt-in for optedSha still covers headSha, which contains tip:
// optedSha is an ancestor of the head, and every file the head changed since
// optedSha is byte-identical to tip's (it is not in the head-versus-tip diff).
// So the only changes since the approval came from the default branch; a
// hand-resolved conflict or an amended merge needs a new line (confirmation
// review MAJOR). Fails closed when a diff may be truncated.
const COMPARE_FILE_LIMIT = 300;
export async function optInCovers(fetchImpl, env, repository, optedSha, headSha, tip) {
  if (optedSha === headSha) return true;
  const sinceApproval = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${optedSha}...${headSha}`);
  if (Number(sinceApproval && sinceApproval.behind_by) !== 0) return false;
  const changed = Array.isArray(sinceApproval && sinceApproval.files) ? sinceApproval.files : null;
  if (!changed || changed.length >= COMPARE_FILE_LIMIT) return false;
  const againstTip = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${tip}...${headSha}`);
  const differs = Array.isArray(againstTip && againstTip.files) ? againstTip.files : null;
  if (!differs || differs.length >= COMPARE_FILE_LIMIT || Number(againstTip.behind_by) !== 0) return false;
  const fromTip = new Set(differs.flatMap((file) => [file && file.filename, file && file.previous_filename]).filter(Boolean));
  return changed.every((file) => file && !fromTip.has(file.filename) && !(file.previous_filename && fromTip.has(file.previous_filename)));
}

async function appRequest(fetchImpl, env, method, route, bearer, body) {
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const response = await fetchImpl(`${base}${route}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${bearer}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "clued-merge-executor",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

// An installation token with the executor's permissions, or the reason there
// is none (the App is not configured, or the installation lacks a permission).
export async function executorToken({ env, fetchImpl, now = () => Date.now() }) {
  const appId = (env.CLUED_ADMISSION_APP_ID ?? "").trim();
  const key = (env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? "").trim();
  if (!appId || !key) return { token: null, reason: "the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY)" };
  const repository = env.GITHUB_REPOSITORY;
  const jwt = appJwt(appId, key, Math.floor(now() / 1000));
  const installation = await appRequest(fetchImpl, env, "GET", `/repos/${repository}/installation`, jwt);
  if (installation.status !== 200 || !installation.body || !installation.body.id) {
    return { token: null, reason: `GitHub API GET /repos/${repository}/installation returned ${installation.status}` };
  }
  const minted = await appRequest(fetchImpl, env, "POST", `/app/installations/${installation.body.id}/access_tokens`, jwt,
    { repositories: [repository.split("/")[1]], permissions: EXECUTOR_PERMISSIONS });
  if (minted.status === 201 && minted.body && minted.body.token) return { token: minted.body.token, reason: null };
  if (minted.status === 422 || minted.status === 403) {
    return { token: null, reason: "the clued-admission App does not have Contents: write and Pull requests: write on this repository yet; the executor changed nothing (Owner Decision 5aa668e3)" };
  }
  return { token: null, reason: `GitHub API POST /app/installations/…/access_tokens returned ${minted.status}` };
}

// The newest clued-admission-verified check on the head posted for this pull
// request (review MINOR-2): admitted, and its mode.
async function admissionOf(fetchImpl, env, repository, headSha, prNumber) {
  const [newest] = (await appChecksOnHead(fetchImpl, env, repository, headSha, VERIFIED_CHECK))
    .filter((check) => checkNamesPullRequest(check, prNumber));
  if (!newest || newest.status !== "completed" || newest.conclusion !== "success" || !newest.app || Number(newest.app.id) !== ADMISSION_APP_ID) {
    return { admitted: false, mode: null };
  }
  return { admitted: true, mode: parseModeLabel(newest.output && newest.output.title) };
}

// Every CI workflow's newest pull_request run on the head: completed and
// successful, no job failed, the admission gate (where there is one) passed,
// and at least one job besides the gate ran and passed. Each workflow runs one
// of a pair of jobs (trusted-self-hosted / untrusted-hosted, so the other is
// always skipped), and a refused gate skips every job after it (review
// MAJOR-1 of #675; confirmation review of #684).
export async function gatedCiOf(fetchImpl, env, repository, headSha, workflows) {
  const listed = await githubJson(fetchImpl, env, `/repos/${repository}/actions/runs?head_sha=${headSha}&event=pull_request&per_page=100`);
  const newest = new Map();
  for (const run of Array.isArray(listed && listed.workflow_runs) ? listed.workflow_runs : []) {
    if (!run || run.head_sha !== headSha || run.event !== "pull_request") continue;
    const file = String(run.path ?? "").replace(/@.*$/, "");
    if (!workflows.has(file)) continue;
    const seen = newest.get(file);
    if (!seen || Number(run.id) > Number(seen.id)) newest.set(file, run);
  }
  if (!newest.size) return { passed: false, reason: "no CI workflow ran on this head" };
  for (const [file, run] of [...newest].sort(([a], [b]) => a.localeCompare(b))) {
    if (run.status !== "completed" || run.conclusion !== "success") {
      return { passed: false, reason: `${file} is ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}` };
    }
    const listedJobs = await githubJson(fetchImpl, env, `/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    const jobs = (Array.isArray(listedJobs && listedJobs.jobs) ? listedJobs.jobs : []).filter(Boolean);
    if (Number(listedJobs?.total_count) > jobs.length) return { passed: false, reason: `${file} jobs may be truncated` };
    const unfinished = jobs.find((job) => !["success", "skipped", "neutral"].includes(job.conclusion));
    if (unfinished) return { passed: false, reason: `${file} job ${unfinished.name} is ${unfinished.conclusion ?? unfinished.status}` };
    const gate = jobs.find((job) => job.name === GATE_JOB);
    if (gate && gate.conclusion !== "success") return { passed: false, reason: `${file} ${GATE_JOB} was ${gate.conclusion}` };
    if (!jobs.some((job) => job.name !== GATE_JOB && job.conclusion === "success")) {
      const otherJobs = jobs.filter((job) => job.name !== GATE_JOB);
      const gateOnly = gate?.conclusion === "success" && otherJobs.length > 0
        && otherJobs.every((job) => job.conclusion === "skipped");
      return { passed: false, reason: `${file} ran no job besides its gate (all skipped)`,
        ...(gateOnly ? { rerun: { id: run.id, run_attempt: run.run_attempt, path: file } } : {}) };
    }
  }
  return { passed: true, reason: `${newest.size} CI workflow run(s) passed on this head` };
}

const GATE_JOB = "admission-gate";
const ENABLE_AUTO_MERGE = "mutation($id: ID!, $oid: GitObjectID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: MERGE, expectedHeadOid: $oid}) { pullRequest { number autoMergeRequest { enabledAt } } } }";
const DISABLE_AUTO_MERGE = "mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { number } } }";

// What to do for one head pull request, without doing it.
export async function planFor({ env, fetchImpl, repository, pr, tip, since, progress_ref, workflows, policy, state }) {
  const admission = await admissionOf(fetchImpl, env, repository, pr.head.sha, pr.number);
  const layer = admission.mode ? admission.mode.layer : null;
  const compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${tip}...${pr.head.sha}`);
  if (Number(compare && compare.behind_by) > 0) {
    if (layer === "protected" || !layer) {
      return { action: "none", reason: `the head is ${compare.behind_by} commit(s) behind; ${layer ? "a protected-layer pull request is brought up to date by its holder" : "its admission check has no mode yet"}` };
    }
    return { action: "update_branch", reason: `the head is ${compare.behind_by} commit(s) behind the default branch` };
  }
  const opted = optInSha(pr.body);
  const renewed = (layer === "code" || layer === "docs") && /^[0-9a-f]{40}$/i.test(String(progress_ref ?? ""))
    && progress_ref.toLowerCase() === pr.head.sha.toLowerCase();
  const covered = renewed || (opted ? await optInCovers(fetchImpl, env, repository, opted, pr.head.sha, tip) : false);
  if (pr.auto_merge) {
    if (opted && !covered) return { action: "disable_auto_merge", reason: `the opt-in names ${opted.slice(0, 12)}, not this head or a merge of the default branch into it` };
  }
  // A fully admitted queue head may recover a gate-only run even before
  // opting in to merge. Rerunning CI never grants permission to merge.
  if (!admission.admitted || !admission.mode) return { action: "none", reason: "the head's clued-admission-verified check for this pull request has not admitted it" };
  // The executor's own state wins over the title's: a switch to frozen applies at once.
  const rules = effectiveRules(policy, state, layer);
  if (rules.auto_merge !== "allowed") return { action: "none", reason: `auto-merge is ${rules.auto_merge} in ${state} for the ${layer} layer` };
  const seen = await ciStateOf(fetchImpl, env, repository, pr.head.sha, workflows, since);
  if (seen.state === "failed") return { action: "none", reason: `CI failed: ${seen.reason}` };
  // GitHub's auto-merge waits only for the ruleset's required checks, and no gated workflow is
  // required: act only once every CI workflow that ran on the head passed, its gated jobs run,
  // as the direct merge does (Task 114d43cf). The executor runs after each slot report, that is
  // after each CI run on the head, so it acts when the last one passes.
  const gated = await gatedCiOf(fetchImpl, env, repository, pr.head.sha, workflows);
  if (gated.rerun) {
    const attempt = gated.rerun.run_attempt;
    const limit = admission.mode.reruns_per_head;
    if (Number.isInteger(attempt) && Number.isInteger(limit) && attempt < 1 + limit && attempt === 1) {
      return { action: "rerun_gated", run: gated.rerun,
        reason: `${gated.reason}; admitted, rerunning all jobs once (attempt ${attempt + 1}, reruns ${limit})` };
    }
    return { action: "none", reason: `waiting for CI on this head: ${gated.reason}; no automatic rerun: attempt ${attempt ?? "unknown"}, reruns ${limit ?? "unknown"} (limit reached or already retried)` };
  }
  if (pr.auto_merge) return { action: "none", reason: "auto-merge is already on" };
  if (!opted && !renewed) return { action: "none", reason: "the pull request did not opt in to auto-merge (Clued-Auto-Merge: <head sha> or a claim renewal naming this head)" };
  if (!covered) return { action: "none", reason: `the opt-in names ${opted.slice(0, 12)}, not this head or a merge of the default branch into it` };
  if (!gated.passed) return { action: "none", reason: `waiting for CI on this head: ${gated.reason}` };
  return { action: "enable_auto_merge", reason: `up to date, admitted, ${renewed ? `opted in by the claim renewal at ${pr.head.sha}` : "opted in"} and ${gated.reason}` };
}

export async function runExecutor({ env, fetchImpl, workspace, readPolicyFile = fs.readFileSync, now = () => Date.now() }) {
  const repository = env.GITHUB_REPOSITORY;
  const mode = resolveMode({ env, workspace, readFile: readPolicyFile });
  const result = { state: mode.state, heads: [], actions: [], notices: [], errors: [] };
  if (mode.state === "frozen") {
    result.notices.push("the merge admission state is frozen: only the Owner merges, so the executor does nothing");
    return result;
  }
  if (!(env.CLUED_CONTEXT_READ_TOKEN ?? "").trim()) {
    result.errors.push(withTokenHint("CLUED_CONTEXT_READ_TOKEN is not set."));
    return result;
  }
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  // Only pull requests whose body names their claim: an update-branch merge commit carries no
  // trailer, so a claim named only in a commit would be lost (review MINOR-3).
  const pulls = (await githubPaged(fetchImpl, env, `/repos/${repository}/pulls?state=open`))
    .filter((pr) => pr && pr.head && pr.base && pr.base.repo && pr.base.ref === pr.base.repo.default_branch
      && pr.head.repo && pr.head.repo.full_name === repository && !pr.draft && parseClaimReference(pr.body));
  const byRef = new Map(pulls.map((pr) => [`${repository}#${pr.number}`.toLowerCase(), pr]));
  const scopes = [...new Set(pulls.map((pr) => parseClaimReference(pr.body)).filter(Boolean).map((ref) => ref.scope))].sort();
  const heads = [];
  for (const scope of scopes) {
    const response = await cluedRpc(fetchImpl, env, workspace, HOLDERS_RPC, { scope, repository });
    if (response.status !== 200 || !response.body || response.body.status !== "ok") {
      result.errors.push(`Clued ${HOLDERS_RPC} returned ${response.detail}`);
      continue;
    }
    if (response.body.reason === "admission_binding_required") {
      result.errors.push(withTokenHint(`Clued ${HOLDERS_RPC}: admission_binding_required`));
      continue;
    }
    for (const holder of Array.isArray(response.body.holders) ? response.body.holders : []) {
      const pr = typeof holder.bound_pr === "string" ? byRef.get(holder.bound_pr.toLowerCase()) : undefined;
      if (!pr || heads.some((entry) => entry.pr === pr)) continue;
      // Only the head of the default branch's queue: another branch's slot is not this merge.
      const ref = `merge:${repository}:${pr.base.repo.default_branch}`.toLowerCase();
      if (!(Array.isArray(holder.merge_refs) ? holder.merge_refs : []).some((r) => String(r).toLowerCase() === ref)) continue;
      const since = Date.parse(holder.merge_slot_ci && holder.merge_slot_ci.taken_at || "");
      heads.push({ scope, pr, progress_ref: holder.progress_ref, since: Number.isFinite(since) ? since : null });
    }
  }
  result.heads = heads.map(({ pr }) => ({ pr: pr.number, head_sha: pr.head.sha }));
  if (!heads.length) return result;

  const defaultBranch = heads[0].pr.base.repo.default_branch;
  const branch = await githubJson(fetchImpl, env, `/repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`);
  const tip = branch && branch.commit && branch.commit.sha;
  if (!/^[0-9a-f]{40}$/.test(String(tip ?? ""))) {
    result.errors.push(`could not read the tip of ${defaultBranch}`);
    return result;
  }
  const workflows = ciWorkflows(workspace);
  const plans = [];
  for (const { pr, since, progress_ref } of heads) {
    try {
      plans.push({ pr, ...(await planFor({ env, fetchImpl, repository, pr, tip, since, progress_ref, workflows, policy: mode.policy, state: mode.state })) });
    } catch (error) {
      result.errors.push(`#${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const work = plans.filter((plan) => plan.action !== "none");
  for (const plan of plans.filter((entry) => entry.action === "none")) {
    result.actions.push({ pr: plan.pr.number, head_sha: plan.pr.head.sha, action: "none", reason: plan.reason });
  }
  if (!work.length) return result;
  const { token, reason } = work.some((plan) => plan.action !== "rerun_gated")
    ? await executorToken({ env, fetchImpl, now }) : { token: null, reason: null };
  if (reason) {
    result.notices.push(reason);
  }
  for (const plan of work) {
    if (plan.action !== "rerun_gated" && !token) {
      result.actions.push({ pr: plan.pr.number, head_sha: plan.pr.head.sha, action: "skipped", wanted: plan.action, reason });
      continue;
    }
    const entry = { pr: plan.pr.number, head_sha: plan.pr.head.sha, action: plan.action, reason: plan.reason };
    if (plan.action === "rerun_gated") {
      // Unlike merge/update-branch, the rerun API has no expected-head CAS.
      // Recheck both the PR and attempt just before using the workflow token.
      const current = await githubJson(fetchImpl, env, `/repos/${repository}/pulls/${plan.pr.number}`);
      const latest = await gatedCiOf(fetchImpl, env, repository, plan.pr.head.sha, workflows);
      const run = await githubJson(fetchImpl, env, `/repos/${repository}/actions/runs/${plan.run.id}`);
      if (current?.head?.sha !== plan.pr.head.sha || current.state !== "open" || current.draft
          || latest.rerun?.id !== plan.run.id || latest.rerun?.run_attempt !== plan.run.run_attempt
          || run.head_sha !== plan.pr.head.sha || run.event !== "pull_request"
          || run.run_attempt !== plan.run.run_attempt || run.status !== "completed" || run.conclusion !== "success") {
        entry.action = "none";
        entry.reason = "the pull request head or gate-only run changed before rerunning; nothing rerun";
      } else {
        const response = await appRequest(fetchImpl, env, "POST", `/repos/${repository}/actions/runs/${plan.run.id}/rerun`, env.GITHUB_TOKEN);
        entry.run_id = plan.run.id;
        entry.status = response.status;
        if (response.status !== 201) entry.error = response.body?.message ?? `HTTP ${response.status}`;
      }
    } else if (plan.action === "update_branch") {
      const response = await appRequest(fetchImpl, env, "PUT", `/repos/${repository}/pulls/${plan.pr.number}/update-branch`, token,
        { expected_head_sha: plan.pr.head.sha });
      entry.status = response.status;
      // 422: the head moved since it was read, or the merge has a conflict the holder must resolve.
      if (response.status !== 202) entry.error = response.body && response.body.message ? String(response.body.message) : `HTTP ${response.status}`;
    } else {
      const enable = plan.action === "enable_auto_merge";
      const response = await appRequest(fetchImpl, env, "POST", "/graphql", token, enable
        ? { query: ENABLE_AUTO_MERGE, variables: { id: plan.pr.node_id, oid: plan.pr.head.sha } }
        : { query: DISABLE_AUTO_MERGE, variables: { id: plan.pr.node_id } });
      entry.status = response.status;
      const errors = response.body && Array.isArray(response.body.errors) ? response.body.errors : [];
      if (response.status !== 200 || errors.length) entry.error = errors.map((e) => e && e.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
      // GitHub refuses auto-merge on a pull request that can merge now. On "clean status" the
      // plan's conditions hold, so the executor merges it, bound to the head it read, once every
      // CI workflow ran and passed on it (Task ff476b06; review MAJOR-1). "unstable status" (a
      // check that is not required failed or is pending) is left to its holder.
      if (enable && entry.error && /(clean|unstable) status/i.test(entry.error)) {
        const unstable = /unstable status/i.test(entry.error);
        delete entry.error;
        entry.result = "mergeable_now";
        let gated = { passed: false, reason: "a check that is not required failed or is still pending (unstable status)" };
        if (!unstable) {
          try {
            gated = await gatedCiOf(fetchImpl, env, repository, plan.pr.head.sha, workflows);
          } catch (error) {
            gated = { passed: false, reason: `the CI runs could not be read: ${error instanceof Error ? error.message : String(error)}` };
          }
        }
        if (!gated.passed) {
          result.notices.push(`#${plan.pr.number}: already mergeable, but not merged: ${gated.reason}`);
        } else {
          const merged = await appRequest(fetchImpl, env, "PUT", `/repos/${repository}/pulls/${plan.pr.number}/merge`, token,
            { merge_method: "merge", sha: plan.pr.head.sha });
          entry.merge_status = merged.status;
          if (merged.status === 200 && merged.body && merged.body.merged === true) {
            entry.result = "merged";
            entry.merge_commit = merged.body.sha ?? null;
            result.notices.push(`#${plan.pr.number}: already mergeable, so GitHub does not take auto-merge; the executor merged it (${String(entry.merge_commit).slice(0, 12)})`);
          } else {
            // 405: not mergeable after all (a required check, the ruleset); 409: the head moved.
            if (merged.status !== 405 && merged.status !== 409) entry.result = "merge_refused";
            entry.error = `merge refused: ${merged.body && merged.body.message ? String(merged.body.message) : `HTTP ${merged.status}`}`;
          }
        }
      }
    }
    if (entry.error) result.notices.push(`#${plan.pr.number}: ${plan.action} was refused: ${entry.error}`);
    result.actions.push(entry);
  }
  return result;
}

export function renderSummary(result) {
  const lines = ["## clued-merge-executor", "", `State \`${result.state}\``, ""];
  if (!result.heads.length) lines.push("No open pull request heads a merge queue.");
  for (const action of result.actions) {
    lines.push(`- #${action.pr} \`${String(action.head_sha).slice(0, 12)}\`: **${action.result ?? action.action}**${action.wanted ? ` (wanted ${action.wanted})` : ""}: ${action.reason}${action.error ? `; refused: ${action.error}` : ""}`);
  }
  for (const notice of result.notices) lines.push(`- notice: ${notice}`);
  for (const error of result.errors) lines.push(`- error: ${error}`);
  return `${lines.join("\n")}\n`;
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const result = await runExecutor({ env, fetchImpl, workspace: env.GITHUB_WORKSPACE });
  console.log(JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
  for (const notice of result.notices) console.error(`::notice title=clued-merge-executor::${notice}`);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`::error title=clued-merge-executor::${error}`);
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
