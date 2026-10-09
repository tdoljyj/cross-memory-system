#!/usr/bin/env node
// Merge Admission v0.1 §7.2–§7.4, step 5 of §13 (Task 91039d74; Owner
// Decisions 661f8c36 and 5aa668e3): the executor does the head of the merge
// queue's work so its Agent need not stay online. The clued-merge-executor
// workflow runs this on the default branch after each clued-merge-slot-ci
// run, hourly and by hand. For each open pull request into the default branch
// whose claim heads a merge queue (clued_work_merge_slot_holders_v1 lists
// only heads since migration 20261009080000):
//
//   behind      the head does not contain the default branch's tip: the
//               executor brings it in with GitHub's "update branch" (a merge
//               commit, expected_head_sha bound to the head it read). A head
//               that only merges the default branch in keeps an Owner grant
//               (Decision a0d93cd0), and the App's push starts CI, which a
//               GITHUB_TOKEN push would not.
//   green       the head contains the tip and the four CI required checks
//               passed: the executor turns on GitHub auto-merge (merge
//               commit, expectedHeadOid), only when
//               - the pull request opted in with a body line
//                 "Clued-Auto-Merge: on" (the Agent writes it once the merge
//                 is approved; without it the Agent merges as before),
//               - the head's clued-admission-verified check admitted it and
//                 the policy allows auto-merge for its state and layer
//                 (never in frozen),
//               - auto-merge is not on already.
//   otherwise   nothing: CI is running, failed (clued-merge-slot-ci returns
//               the slot), or the pull request has a conflict the holder
//               must resolve.
//
// It acts as the clued-admission App, with an installation token for
// Contents: write and Pull requests: write. Until the Owner grants those
// permissions the token request fails and the executor only reports that,
// changing nothing. In frozen it does nothing at all. It never merges by
// itself, never pushes to the default branch (the ruleset forbids it) and
// trusts nothing in the triggering event.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMISSION_APP_ID,
  appChecksOnHead,
  appJwt,
  cluedRpc,
  githubJson,
  githubPaged,
  parseClaimReference,
  withTokenHint,
} from "./clued-work-admission.mjs";
import { HOLDERS_RPC, ciStateOf, ciWorkflows } from "./clued-merge-slot-ci.mjs";
import { effectiveRules, parseModeLabel, resolveMode } from "./merge-admission-policy.mjs";

export const OPT_IN = /^\s*Clued-Auto-Merge:\s*on\s*$/im;
export const EXECUTOR_PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write" });
const VERIFIED_CHECK = "clued-admission-verified";

// Whether the pull request body opts in to auto-merge.
export function optedIn(body) {
  return OPT_IN.test(String(body ?? ""));
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

// The newest clued-admission-verified check on the head: admitted, and its mode.
async function admissionOf(fetchImpl, env, repository, headSha) {
  const [newest] = await appChecksOnHead(fetchImpl, env, repository, headSha, VERIFIED_CHECK);
  if (!newest || newest.status !== "completed" || newest.conclusion !== "success" || !newest.app || Number(newest.app.id) !== ADMISSION_APP_ID) {
    return { admitted: false, mode: null };
  }
  return { admitted: true, mode: parseModeLabel(newest.output && newest.output.title) };
}

const ENABLE_AUTO_MERGE = "mutation($id: ID!, $oid: GitObjectID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: MERGE, expectedHeadOid: $oid}) { pullRequest { number autoMergeRequest { enabledAt } } } }";

// What to do for one head pull request, without doing it.
export async function planFor({ env, fetchImpl, repository, pr, tip, since, workflows, policy, state }) {
  const compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${tip}...${pr.head.sha}`);
  if (Number(compare && compare.behind_by) > 0) {
    return { action: "update_branch", reason: `the head is ${compare.behind_by} commit(s) behind the default branch` };
  }
  if (pr.auto_merge) return { action: "none", reason: "auto-merge is already on" };
  if (!optedIn(pr.body)) return { action: "none", reason: "the pull request did not opt in to auto-merge (Clued-Auto-Merge: on)" };
  const seen = await ciStateOf(fetchImpl, env, repository, pr.head.sha, workflows, since);
  if (seen.state !== "green") return { action: "none", reason: `CI is ${seen.state}: ${seen.reason}` };
  const admission = await admissionOf(fetchImpl, env, repository, pr.head.sha);
  if (!admission.admitted || !admission.mode) return { action: "none", reason: "the head's clued-admission-verified check has not admitted it" };
  // The executor's own state wins over the title's: a switch to frozen applies at once.
  const rules = effectiveRules(policy, state, admission.mode.layer);
  if (rules.auto_merge !== "allowed") return { action: "none", reason: `auto-merge is ${rules.auto_merge} in ${state} for the ${admission.mode.layer} layer` };
  return { action: "enable_auto_merge", reason: "green, up to date, admitted and opted in" };
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
  const pulls = (await githubPaged(fetchImpl, env, `/repos/${repository}/pulls?state=open`))
    .filter((pr) => pr && pr.head && pr.base && pr.base.repo && pr.base.ref === pr.base.repo.default_branch
      && pr.head.repo && pr.head.repo.full_name === repository && !pr.draft);
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
      heads.push({ scope, pr, since: Number.isFinite(since) ? since : null });
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
  for (const { pr, since } of heads) {
    try {
      plans.push({ pr, ...(await planFor({ env, fetchImpl, repository, pr, tip, since, workflows, policy: mode.policy, state: mode.state })) });
    } catch (error) {
      result.errors.push(`#${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const work = plans.filter((plan) => plan.action !== "none");
  for (const plan of plans.filter((entry) => entry.action === "none")) {
    result.actions.push({ pr: plan.pr.number, head_sha: plan.pr.head.sha, action: "none", reason: plan.reason });
  }
  if (!work.length) return result;
  const { token, reason } = await executorToken({ env, fetchImpl, now });
  if (!token) {
    result.notices.push(reason);
    for (const plan of work) {
      result.actions.push({ pr: plan.pr.number, head_sha: plan.pr.head.sha, action: "skipped", wanted: plan.action, reason });
    }
    return result;
  }
  for (const plan of work) {
    const entry = { pr: plan.pr.number, head_sha: plan.pr.head.sha, action: plan.action, reason: plan.reason };
    if (plan.action === "update_branch") {
      const response = await appRequest(fetchImpl, env, "PUT", `/repos/${repository}/pulls/${plan.pr.number}/update-branch`, token,
        { expected_head_sha: plan.pr.head.sha });
      entry.status = response.status;
      // 422: the head moved since it was read, or the merge has a conflict the holder must resolve.
      if (response.status !== 202) entry.error = response.body && response.body.message ? String(response.body.message) : `HTTP ${response.status}`;
    } else {
      const response = await appRequest(fetchImpl, env, "POST", "/graphql", token,
        { query: ENABLE_AUTO_MERGE, variables: { id: plan.pr.node_id, oid: plan.pr.head.sha } });
      entry.status = response.status;
      const errors = response.body && Array.isArray(response.body.errors) ? response.body.errors : [];
      if (response.status !== 200 || errors.length) entry.error = errors.map((e) => e && e.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
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
    lines.push(`- #${action.pr} \`${String(action.head_sha).slice(0, 12)}\`: **${action.action}**${action.wanted ? ` (wanted ${action.wanted})` : ""}: ${action.reason}${action.error ? `; refused: ${action.error}` : ""}`);
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
