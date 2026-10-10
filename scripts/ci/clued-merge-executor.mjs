#!/usr/bin/env node
// Merge Admission v0.1 §7.2–§7.4; original executor Tasks 91039d74,
// 114d43cf, ff476b06 and R1 f52ca0dd. Default-branch code only.
// Clean executor-managed waiting requests before Clued/proof reads. A cleaned
// PR is not processed again in this invocation. Manual non-opted auto-merge
// is left to its Owner. The executor does not create waiting auto requests.
// For the live FIFO head, the normal platform match-head merge requires
// exact current permission/withdrawal gates, opt-in, complete source-qualified
// real CI, final native run/check barriers and GitHub's clean PR state.
// Behind non-protected heads may use the existing expected-head update API.
// Source-qualified gate-only attempt 1 may rerun all jobs within its limit;
// neither recovery nor skipped jobs authorizes merge. GITHUB_TOKEN performs
// that rerun; the existing App installation token performs merge/update.
// Pure proof tests and consumer tests run offline; main never injects a bypass.

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
  evaluate,
  withTokenHint,
} from "./clued-work-admission.mjs";
import { cleanupManagedAutoMerge,managedAutoMerge,executorToken,appRequest } from "./clued-managed-auto-merge.mjs";
export {executorToken,managedAutoMerge,EXECUTOR_PERMISSIONS} from "./clued-managed-auto-merge.mjs";
import { HOLDERS_RPC, ciStateOf, ciWorkflows,requiredBarrier,matchesOperationPR } from "./clued-merge-slot-ci.mjs";
import { effectiveRules, parseModeLabel, resolveMode } from "./merge-admission-policy.mjs";
import { createExecutionQualifier } from "./clued-gated-proof-runtime.mjs";

export const OPT_IN = /^\s*Clued-Auto-Merge:\s*([0-9a-f]{40})\s*$/im;
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

async function admissionOf(fetchImpl, env, repository, headSha, prNumber) {
  const [newest] = await appChecksOnHead(fetchImpl, env, repository, headSha, VERIFIED_CHECK);
  if (!newest || !checkNamesPullRequest(newest, prNumber) || newest.status !== "completed" || newest.conclusion !== "success" || !newest.app || Number(newest.app.id) !== ADMISSION_APP_ID) {
    return { admitted: false, mode: null };
  }
  return { admitted: true, mode: parseModeLabel(newest.output && newest.output.title) };
}

// What to do for one head pull request, without doing it.
export async function planFor({ env, fetchImpl, repository, pr, tip, since, progress_ref, workflows, policy, state, qualifyExecution }) {
  if (pr.auto_merge && !managedAutoMerge(pr)) return {action:'none',reason:'manual auto-merge is not managed by this executor'};
  const managed = managedAutoMerge(pr);
  const stop = reason => ({ action: managed ? 'disable_auto_merge' : 'none', reason });
  if (state === 'frozen') return stop('auto-merge is forbidden in frozen state');
  const admission = await admissionOf(fetchImpl, env, repository, pr.head.sha, pr.number);
  const layer = admission.mode ? admission.mode.layer : null;
  const compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${tip}...${pr.head.sha}`);
  if (Number(compare && compare.behind_by) > 0) {
    if (layer === "protected" || !layer) {
      return stop(`the head is ${compare.behind_by} commit(s) behind; ${layer ? "a protected-layer pull request is brought up to date by its holder" : "its admission check has no mode yet"}`);
    }
    if (managed) return stop('the managed auto-merge head is behind the default branch');
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
  if (!admission.admitted || !admission.mode) return stop("the head's clued-admission-verified check for this pull request has not admitted it");
  // The executor's own state wins over the title's: a switch to frozen applies at once.
  const rules = effectiveRules(policy, state, layer);
  if (rules.auto_merge !== "allowed") return stop(`auto-merge is ${rules.auto_merge} in ${state} for the ${layer} layer`);
  const seen = await ciStateOf(fetchImpl, env, repository, pr.head.sha, workflows, since, { pr, qualifyExecution });
  if (seen.state === "failed" || seen.state === "running") return stop(`CI ${seen.state}: ${seen.reason}`);
  // GitHub's auto-merge waits only for the ruleset's required checks, and no gated workflow is
  // required: act only once every CI workflow that ran on the head passed, its gated jobs run,
  // as the direct merge does (Task 114d43cf). The executor runs after each slot report, that is
  // after each CI run on the head, so it acts when the last one passes.
  const gated = seen.execution ?? (typeof qualifyExecution === 'function' ? await qualifyExecution(pr, tip) :
    {passed:false,state:'unknown',reason:'execution qualification unavailable'});
  if (gated.head !== pr.head.sha || gated.pr_number !== pr.number) return stop(gated.reason ?? 'execution proof identity unavailable');
  if (gated.rerun) {
    if (managed) return stop('gate-only execution invalidates managed auto-merge before recovery');
    const attempt = gated.rerun.run_attempt;
    const limit = admission.mode.reruns_per_head;
    if (Number.isInteger(attempt) && Number.isInteger(limit) && attempt < 1 + limit && attempt === 1) {
      return { action: "rerun_gated", run: gated.rerun, execution:gated,
        reason: `${gated.reason}; admitted, rerunning all jobs once (attempt ${attempt + 1}, reruns ${limit})` };
    }
    return { action: "none", reason: `waiting for CI on this head: ${gated.reason}; no automatic rerun: attempt ${attempt ?? "unknown"}, reruns ${limit ?? "unknown"} (limit reached or already retried)` };
  }
  if (!gated.passed || gated.state !== 'qualified' || seen.state !== 'green') return stop(`waiting for CI execution on this head: ${gated.reason}`);
  if (pr.auto_merge) return { action: "none", reason: "auto-merge is already on with current qualified execution" };
  if (!opted && !renewed) return { action: "none", reason: "the pull request did not opt in to auto-merge (Clued-Auto-Merge: <head sha> or a claim renewal naming this head)" };
  if (!covered) return { action: "none", reason: `the opt-in names ${opted.slice(0, 12)}, not this head or a merge of the default branch into it` };
  return { action: "merge_pull_request", execution:gated, reason: `up to date, admitted, ${renewed ? `opted in by the claim renewal at ${pr.head.sha}` : "opted in"} and ${gated.reason}` };
}

export async function currentOperationAuthority({env,fetchImpl,workspace,readPolicyFile,repository,pr,tip,scope,action}) {
  try {
    const current=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${pr.number}`);
    const mode=resolveMode({env,workspace,readFile:readPolicyFile});
    const reference=parseClaimReference(current?.body),expected=parseClaimReference(pr.body);
    if(current?.number!==pr.number || current.state!=='open' || current.draft!==false || current.head?.sha!==pr.head.sha ||
      current.base?.ref!==pr.base.ref || current.base?.repo?.full_name!==repository ||
      current.base.repo.default_branch!==pr.base.repo.default_branch || !reference ||
      reference.claim_id!==expected?.claim_id || reference.scope!==scope || mode.state==='frozen')return {valid:false};
    const branch=await githubJson(fetchImpl,env,`/repos/${repository}/branches/${encodeURIComponent(current.base.ref)}`);
    if(branch?.commit?.sha!==tip)return {valid:false};
    const holders=await cluedRpc(fetchImpl,env,workspace,HOLDERS_RPC,{scope,repository});
    const ref=`merge:${repository}:${current.base.ref}`.toLowerCase();
    const holder=holders.body?.status==='ok' && holders.body.holders?.find(row=>row.claim_id===reference.claim_id &&
      String(row.bound_pr).toLowerCase()===`${repository}#${current.number}`.toLowerCase() &&
      row.merge_refs?.some(value=>String(value).toLowerCase()===ref));
    if(!holder)return {valid:false};
    // This reuses admission's existing live permission/withdrawal verifier;
    // execution qualification never enters the ADMITTED evaluator.
    const outcome=await evaluate({env,event:{pull_request:current},eventName:'pull_request_target',fetchImpl,workspace,
      withSummary:false,readPolicyFile});
    if(outcome.admitted!==true || outcome.head_sha!==current.head.sha || outcome.scope!==scope || outcome.claim_id!==reference.claim_id ||
      outcome.merge_slot?.tip!==tip ||
      outcome.admission_mode?.state!==mode.state || outcome.admission_mode.rules?.auto_merge!=='allowed')return {valid:false};
    const held=outcome.merge_slot?.state==='held' ||
      (outcome.admission_mode.rules?.merge_slot==='advise' && outcome.merge_slot?.state==='not_required' && outcome.merge_slot.observed==='held');
    if(action!=='update_branch' && !held)return {valid:false};
    if(action==='update_branch' && outcome.admission_mode.layer==='protected')return {valid:false};
    const freshAdmission=await admissionOf(fetchImpl,env,repository,current.head.sha,current.number);
    if(!freshAdmission.admitted || !freshAdmission.mode || freshAdmission.mode.state!==mode.state ||
      freshAdmission.mode.layer!==outcome.admission_mode.layer ||
      freshAdmission.mode.reruns_per_head!==outcome.admission_mode.rules.reruns_per_head)return {valid:false};
    const final=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${pr.number}`);
    const finalBranch=await githubJson(fetchImpl,env,`/repos/${repository}/branches/${encodeURIComponent(current.base.ref)}`);
    if(final?.number!==current.number || final.state!=='open' || final.draft!==false || final.head?.sha!==current.head.sha ||
      final.body!==current.body || final.base?.ref!==current.base.ref || final.base?.repo?.full_name!==repository ||
      finalBranch?.commit?.sha!==tip)return {valid:false};
    return {valid:true,pr:current,mode,progress_ref:holder.progress_ref};
  } catch {return {valid:false};}
}

export async function runExecutor({ env, fetchImpl, workspace, readPolicyFile = fs.readFileSync, now = () => Date.now(),
  qualifyExecution, authorizeOperation = currentOperationAuthority }) {
  const repository = env.GITHUB_REPOSITORY;
  const mode = resolveMode({ env, workspace, readFile: readPolicyFile });
  const result = { state: mode.state, heads: [], actions: [], notices: [], errors: [] };
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  // Only pull requests whose body names their claim: an update-branch merge commit carries no
  // trailer, so a claim named only in a commit would be lost (review MINOR-3).
  const openPulls = await githubPaged(fetchImpl, env, `/repos/${repository}/pulls?state=open`);
  const cleanup=await cleanupManagedAutoMerge({env,fetchImpl,pulls:openPulls,now});
  result.actions.push(...cleanup.actions);result.notices.push(...cleanup.notices);result.errors.push(...cleanup.errors);
  if (!(env.CLUED_CONTEXT_READ_TOKEN ?? "").trim()) {
    result.errors.push(withTokenHint("CLUED_CONTEXT_READ_TOKEN is not set."));
    return result;
  }

  const pulls = openPulls.filter(pr=>!cleanup.blocked.has(pr.number))
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
  const qualify = qualifyExecution ?? createExecutionQualifier({env,fetchImpl,workspace,workflows});
  const plans = [];
  for (const { pr, since, progress_ref, scope, orphaned } of heads) {
    try {
      let plan=orphaned?{action:'disable_auto_merge',reason:'managed auto-merge no longer holds a live FIFO slot'}:
        await planFor({ env, fetchImpl, repository, pr, tip, since, progress_ref, workflows, policy: mode.policy, state: mode.state,qualifyExecution:qualify });
      if(managedAutoMerge(pr) && plan.action==='none') {
        const authority=await authorizeOperation({env,fetchImpl,workspace,readPolicyFile,repository,pr,tip,scope,action:'merge_pull_request'});
        if(authority?.valid!==true)plan={action:'disable_auto_merge',reason:'managed request lost current permission, withdrawal or FIFO eligibility'};
      }
      plans.push({pr,scope,since,progress_ref,...plan});
    } catch (error) {
      if(managedAutoMerge(pr))plans.push({pr,scope,action:'disable_auto_merge',reason:'execution eligibility could not be revalidated'});
      else result.errors.push(`#${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
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
    let lastPr=plan.pr,lastExecution=plan.execution;
    if(plan.action==='disable_auto_merge') {
      const current=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${plan.pr.number}`);
      if(current?.node_id!==plan.pr.node_id || current.state!=='open' || !managedAutoMerge(current)) {
        result.actions.push({...entry,action:'none',reason:'managed request is no longer present'});continue;
      }
    } else {
      const authority=await authorizeOperation({env,fetchImpl,workspace,readPolicyFile,repository,pr:plan.pr,tip,
        scope:plan.scope,action:plan.action});
      if(authority?.valid!==true) {
        result.actions.push({...entry,action:'none',reason:'current permission, withdrawal, policy or FIFO gate refused the operation'});continue;
      }
      const final=await planFor({env,fetchImpl,repository,pr:authority.pr,tip,since:plan.since,progress_ref:authority.progress_ref,
        workflows,policy:authority.mode.policy,state:authority.mode.state,qualifyExecution:qualify});
      if(final.action!==plan.action || (plan.run && (final.run?.id!==plan.run.id || final.run.run_attempt!==plan.run.run_attempt))) {
        result.actions.push({...entry,action:'none',reason:'execution or opt-in eligibility changed before the operation'});continue;
      }
      // Qualification may take time: recheck live authority after it, rather
      // than retaining the permission/withdrawal decision from before it.
      const lastAuthority=await authorizeOperation({env,fetchImpl,workspace,readPolicyFile,repository,pr:plan.pr,tip,
        scope:plan.scope,action:plan.action});
      if(lastAuthority?.valid!==true || lastAuthority.progress_ref!==authority.progress_ref ||
        lastAuthority.pr.body!==authority.pr.body || lastAuthority.mode.state!==authority.mode.state) {
        result.actions.push({...entry,action:'none',reason:'live authority changed during execution qualification'});continue;
      }
      lastPr=lastAuthority.pr;lastExecution=final.execution;
    }
    if (plan.action === "rerun_gated") {
      // Unlike merge/update-branch, the rerun API has no expected-head CAS.
      // Recheck both the PR and attempt just before using the workflow token.
      const current = await githubJson(fetchImpl, env, `/repos/${repository}/pulls/${plan.pr.number}`);
      const run = await githubJson(fetchImpl, env, `/repos/${repository}/actions/runs/${plan.run.id}`);
      if (current?.head?.sha !== plan.pr.head.sha || current.state !== "open" || current.draft
          || run.head_sha !== plan.pr.head.sha || run.event !== "pull_request"
          || run.run_attempt !== plan.run.run_attempt || run.status !== "completed" || run.conclusion !== "success") {
        entry.action = "none";
        entry.reason = "the pull request head or gate-only run changed before rerunning; nothing rerun";
      } else {
        if(!await requiredBarrier(fetchImpl,env,repository,plan.pr.head.sha,plan.pr.number,lastExecution,{expectedPR:lastPr,action:plan.action})){result.actions.push({...entry,action:'none',reason:'native latest state changed after authority'});continue;}
        const response = await appRequest(fetchImpl, env, "POST", `/repos/${repository}/actions/runs/${plan.run.id}/rerun`, env.GITHUB_TOKEN);
        entry.run_id = plan.run.id;
        entry.status = response.status;
        if (response.status !== 201) entry.error = response.body?.message ?? `HTTP ${response.status}`;
      }
    } else if (plan.action === "update_branch") {
      const current=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${plan.pr.number}`);
      if(!matchesOperationPR(current,lastPr,plan.action)) {result.actions.push({...entry,action:'none',reason:'native PR permission changed before update'});continue;}
      const response = await appRequest(fetchImpl, env, "PUT", `/repos/${repository}/pulls/${plan.pr.number}/update-branch`, token,
        { expected_head_sha: plan.pr.head.sha });
      entry.status = response.status;
      // 422: the head moved since it was read, or the merge has a conflict the holder must resolve.
      if (response.status !== 202) entry.error = response.body && response.body.message ? String(response.body.message) : `HTTP ${response.status}`;
    } else if (plan.action==='merge_pull_request') {
      const current=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${plan.pr.number}`);
      if(current?.head?.sha!==plan.pr.head.sha || current.state!=='open' || current.draft || current.auto_merge || current.mergeable_state!=='clean') {
        entry.action='none';entry.reason='native PR is not clean, current and free of waiting auto-merge';
      } else if(!await requiredBarrier(fetchImpl,env,repository,plan.pr.head.sha,plan.pr.number,lastExecution,{expectedPR:lastPr,action:plan.action})) {
        entry.action='none';entry.reason='native latest state changed after authority';
      } else {
        const merged=await appRequest(fetchImpl,env,'PUT',`/repos/${repository}/pulls/${plan.pr.number}/merge`,token,
          {merge_method:'merge',sha:plan.pr.head.sha});
        entry.merge_status=merged.status;
        if(merged.status===200 && merged.body?.merged===true){entry.result='merged';entry.merge_commit=merged.body.sha??null;}
        else {entry.result=merged.status===405||merged.status===409?'mergeable_now':'merge_refused';
          entry.error=`merge refused: ${merged.body?.message??`HTTP ${merged.status}`}`;}
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
