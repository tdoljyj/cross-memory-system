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
import { automaticExecutorGate } from './clued-merge-reconcile-gate.mjs';
import {createNaturalRecorder,observeMutation,naturalRoundId} from "./merge-admission-source-producer.mjs";
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
  resolvePullRequestBinding,
  evaluate,
  withTokenHint,
} from "./clued-work-admission.mjs";
import { cleanupManagedAutoMerge,managedAutoMerge,executorToken,appRequest } from "./clued-managed-auto-merge.mjs";
export {executorToken,managedAutoMerge,EXECUTOR_PERMISSIONS} from "./clued-managed-auto-merge.mjs";
import { HOLDERS_RPC, INDEPENDENT_CI_APP_ID, ciStateOf, ciWorkflows, independentCheckBindsPullRequest, requiredBarrier, requiredChecksOf,
  matchesOperationPR, samePRBindingAuthority, selectHolderBinding } from "./clued-merge-slot-ci.mjs";
import { effectiveRules, parseModeLabel, resolveMode } from "./merge-admission-policy.mjs";
import { createExecutionQualifier } from "./clued-gated-proof-runtime.mjs";

export const OPT_IN = /^\s*Clued-Auto-Merge:\s*([0-9a-f]{40})\s*$/im;
const VERIFIED_CHECK = "kooyumi-admission-verified";

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

// Design A2: the admission check of every source the branch rules require
// (required, from requiredChecksOf) must admit this head. The clued-admission
// App's check (5164952) names its pull request and carries the mode label in
// its title. The independent CI's check (5368905) binds by head and its
// external_id format and carries no label: its mode comes from the live
// admission evaluation instead (live: true). Any other publisher never admits.
async function admissionOf(fetchImpl, env, repository, headSha, prNumber, required) {
  const refused = { admitted: false, mode: null, live: false };
  const sources = (Array.isArray(required) ? required : []).filter((row) => row.name === VERIFIED_CHECK).map((row) => row.app_id);
  if (!sources.length) return refused;
  let mode = null, live = false;
  for (const appId of sources) {
    let newest;
    if (appId === ADMISSION_APP_ID) {
      [newest] = await appChecksOnHead(fetchImpl, env, repository, headSha, VERIFIED_CHECK);
    } else {
      newest = (await githubPaged(fetchImpl, env, `/repos/${repository}/commits/${headSha}/check-runs?check_name=${VERIFIED_CHECK}&filter=all`, "check_runs"))
        .filter((check) => check && check.name === VERIFIED_CHECK && check.head_sha === headSha && check.app &&
          (appId === null || Number(check.app.id) === appId))
        .sort((a, b) => Number(b.id) - Number(a.id))[0];
    }
    if (!newest || newest.status !== "completed" || newest.conclusion !== "success" || !newest.app) return refused;
    const app = Number(newest.app.id);
    if (app === ADMISSION_APP_ID) {
      if (!checkNamesPullRequest(newest, prNumber)) return refused;
      mode ??= parseModeLabel(newest.output && newest.output.title);
    } else if (app === INDEPENDENT_CI_APP_ID) {
      if (!independentCheckBindsPullRequest(newest, { headSha, prNumber, repository })) return refused;
      live = true;
    } else return refused;
  }
  return { admitted: true, mode, live: live && !mode };
}

// The live admission evaluation's mode for an independent CI admission check.
async function liveAdmissionModeOf({ env, fetchImpl, workspace, readPolicyFile, pr }) {
  try {
    const outcome = await evaluate({ env, event: { pull_request: pr }, eventName: "pull_request_target", fetchImpl, workspace,
      withSummary: false, readPolicyFile });
    const mode = outcome && outcome.admission_mode;
    if (outcome?.admitted !== true || outcome.head_sha !== pr.head.sha || !mode || typeof mode.state !== "string" ||
      typeof mode.layer !== "string" || !Number.isInteger(mode.rules?.reruns_per_head)) return null;
    return { state: mode.state, layer: mode.layer, reruns_per_head: mode.rules.reruns_per_head };
  } catch { return null; }
}

// What to do for one head pull request, without doing it.
export async function planFor({ env, fetchImpl, repository, pr, tip, since, progress_ref, workflows, policy, state, qualifyExecution,
  required, admissionMode }) {
  if (pr.auto_merge && !managedAutoMerge(pr)) return {action:'none',reason:'manual auto-merge is not managed by this executor'};
  const managed = managedAutoMerge(pr);
  const stop = reason => ({ action: managed ? 'disable_auto_merge' : 'none', reason });
  if (state === 'frozen') return stop('auto-merge is forbidden in frozen state');
  const branchChecks = required ?? await requiredChecksOf(fetchImpl, env, repository, pr.base.repo.default_branch);
  // ADR 0018: this never-published, App-pinned check marks push landing.
  // Updating H would invalidate the train's batch; merging is the train's job.
  if (branchChecks.some(check => check.name === 'kooyumi-train-landed' && check.app_id === INDEPENDENT_CI_APP_ID))
    return { action: 'none', reason: '列车自己落地（kooyumi-train-landed@5368905）；不更新或合并车头' };
  let admission = await admissionOf(fetchImpl, env, repository, pr.head.sha, pr.number, branchChecks);
  if (admission.admitted && admission.live)
    admission = { ...admission, mode: typeof admissionMode === "function" ? await admissionMode(pr) : null };
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
  if (!admission.admitted || !admission.mode) return stop("the head's kooyumi-admission-verified check for this pull request has not admitted it");
  // The executor's own state wins over the title's: a switch to frozen applies at once.
  const rules = effectiveRules(policy, state, layer);
  if (rules.auto_merge !== "allowed") return stop(`auto-merge is ${rules.auto_merge} in ${state} for the ${layer} layer`);
  const seen = await ciStateOf(fetchImpl, env, repository, pr.head.sha, workflows, since, { pr, qualifyExecution, required: branchChecks });
  if (seen.state === "failed" || seen.state === "running") return stop(`CI ${seen.state}: ${seen.reason}`);
  // The final barrier forbids any active PR run, including uncounted runs.
  // Only a complete observation can take this early wait; other idle states
  // still need qualification so that admitted gate-only recovery remains possible.
  if (seen.state === 'idle' && Array.isArray(seen.active_runs) && seen.active_runs.length)
    return stop(`waiting for active CI: ${seen.reason}`);
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

const plannedAuthorityFields = binding => ({ task_id: binding.task_id, claim_id: binding.claim.claim_id,
  fence: binding.claim.fence, execution_epoch: binding.claim.execution_epoch, head_authorization_id: binding.head_authorization_id });

export async function currentOperationAuthority({env,fetchImpl,workspace,readPolicyFile,repository,pr,tip,scope,action,expectedBinding}) {
  try {
    if (repository !== env.GITHUB_REPOSITORY || !samePRBindingAuthority(expectedBinding,expectedBinding)
      || expectedBinding.scope !== scope) return {valid:false};
    const current=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${pr.number}`);
    const mode=resolveMode({env,workspace,readFile:readPolicyFile});
    if(current?.number!==pr.number || current.state!=='open' || current.draft!==false || current.head?.sha!==pr.head.sha ||
      current.base?.ref!==pr.base.ref || current.base?.repo?.full_name!==repository ||
      current.base.repo.default_branch!==pr.base.repo.default_branch || mode.state==='frozen')return {valid:false};
    const binding=await resolvePullRequestBinding(fetchImpl,env,current,{workspace,scope,readOnly:true});
    if(!samePRBindingAuthority(expectedBinding,binding))return {valid:false};
    const branch=await githubJson(fetchImpl,env,`/repos/${repository}/branches/${encodeURIComponent(current.base.ref)}`);
    if(branch?.commit?.sha!==tip)return {valid:false};
    const holders=await cluedRpc(fetchImpl,env,workspace,HOLDERS_RPC,{scope,repository});
    const ref=`merge:${repository}:${current.base.ref}`.toLowerCase();
    const holder=holders.status===200 && holders.body?.status==='ok' && holders.body.holders?.find(row=>
      selectHolderBinding(row,[{pr:current,binding}],repository)!==null &&
      row.merge_refs?.some(value=>String(value).toLowerCase()===ref));
    if(!holder)return {valid:false};
    // This reuses admission's existing live permission/withdrawal verifier;
    // execution qualification never enters the ADMITTED evaluator.
    const outcome=await evaluate({env,event:{pull_request:current},eventName:'pull_request_target',fetchImpl,workspace,
      withSummary:false,readPolicyFile,bindingScope:scope});
    if(outcome.admitted!==true || !samePRBindingAuthority(expectedBinding,outcome.claim_binding)
      || outcome.head_sha!==current.head.sha || outcome.scope!==scope || outcome.claim_id!==expectedBinding.claim.claim_id ||
      outcome.merge_slot?.tip!==tip ||
      outcome.admission_mode?.state!==mode.state || outcome.admission_mode.rules?.auto_merge!=='allowed')return {valid:false};
    const held=outcome.merge_slot?.state==='held' ||
      (outcome.admission_mode.rules?.merge_slot==='advise' && outcome.merge_slot?.state==='not_required' && outcome.merge_slot.observed==='held');
    if(action!=='update_branch' && !held)return {valid:false};
    if(action==='update_branch' && outcome.admission_mode.layer==='protected')return {valid:false};
    const required=await requiredChecksOf(fetchImpl,env,repository,current.base.ref);
    const freshAdmission=await admissionOf(fetchImpl,env,repository,current.head.sha,current.number,required);
    // An independent CI admission check carries no mode label; the live
    // evaluation just above is its mode, already bound to this head and state.
    if(!freshAdmission.admitted || (!freshAdmission.live && (!freshAdmission.mode || freshAdmission.mode.state!==mode.state ||
      freshAdmission.mode.layer!==outcome.admission_mode.layer ||
      freshAdmission.mode.reruns_per_head!==outcome.admission_mode.rules.reruns_per_head)))return {valid:false};
    const final=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${pr.number}`);
    const finalBranch=await githubJson(fetchImpl,env,`/repos/${repository}/branches/${encodeURIComponent(current.base.ref)}`);
    if(final?.number!==current.number || final.state!=='open' || final.draft!==false || final.head?.sha!==current.head.sha ||
      final.body!==current.body || final.base?.ref!==current.base.ref || final.base?.repo?.full_name!==repository ||
      finalBranch?.commit?.sha!==tip)return {valid:false};
    return {valid:true,pr:current,mode,progress_ref:holder.progress_ref,claim_binding:binding,
      observation_fence:expectedBinding.claim.fence};
  } catch {return {valid:false};}
}

async function runExecutorCore({ env, fetchImpl, workspace, readPolicyFile = fs.readFileSync, now = () => Date.now(),
  qualifyExecution, authorizeOperation = currentOperationAuthority, admissionMode }) {
  const repository = env.GITHUB_REPOSITORY;
  const mode = resolveMode({ env, workspace, readFile: readPolicyFile });
  const result = { state: mode.state, heads: [], actions: [], notices: [], errors: [] };
  const observations=arguments[0].observation_recorder;
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  // PR text carries only the separate auto-merge opt-in; Native supplies Task authority.
  const openPulls = await githubPaged(fetchImpl, env, `/repos/${repository}/pulls?state=open`);
  const cleanup=await cleanupManagedAutoMerge({env,fetchImpl,pulls:openPulls,now});
  result.actions.push(...cleanup.actions);result.notices.push(...cleanup.notices);result.errors.push(...cleanup.errors);
  if (!(env.CLUED_CONTEXT_READ_TOKEN ?? "").trim()) {
    result.errors.push(withTokenHint("CLUED_CONTEXT_READ_TOKEN is not set."));
    return result;
  }

  const pulls = openPulls.filter(pr=>!cleanup.blocked.has(pr.number))
    .filter((pr) => pr && pr.head && pr.base && pr.base.repo && pr.base.ref === pr.base.repo.default_branch
      && pr.head.repo && pr.head.repo.full_name === repository && !pr.draft);
  const candidates=[];
  for(const pr of pulls) {
    try {
      const binding=await resolvePullRequestBinding(fetchImpl,env,pr,{workspace,readOnly:true});
      if(binding.binding_status==='bound' && samePRBindingAuthority(binding,binding))candidates.push({pr,binding});
      else result.notices.push(`#${pr.number}: Native PR binding is ${binding.binding_status}; waiting`);
    }catch {result.notices.push(`#${pr.number}: Native PR binding unavailable; waiting`);}
  }
  const scopes = [...new Set(candidates.map(c=>c.binding.scope))].sort();
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
      const selected=selectHolderBinding(holder,candidates.filter(c=>c.binding.scope===scope),repository),pr=selected?.pr;
      if (!pr || heads.some((entry) => entry.pr === pr)) continue;
      // Only the head of the default branch's queue: another branch's slot is not this merge.
      const ref = `merge:${repository}:${pr.base.repo.default_branch}`.toLowerCase();
      if (!(Array.isArray(holder.merge_refs) ? holder.merge_refs : []).some((r) => String(r).toLowerCase() === ref)) continue;
      const since = Date.parse(holder.merge_slot_ci && holder.merge_slot_ci.taken_at || "");
      heads.push({ scope, pr, expectedBinding:selected.binding, progress_ref: holder.progress_ref, since: Number.isFinite(since) ? since : null });
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
  // Design A2: the branch rules decide which checks and sources count. They
  // are read once for planning (an unreadable read fails every head's plan,
  // so a managed request is turned off), and again by every final barrier,
  // pre-operation plan and authority check.
  let rulesRead = null;
  const branchRules = () => (rulesRead ??= requiredChecksOf(fetchImpl, env, repository, defaultBranch));
  const liveMode = admissionMode ?? (pr => liveAdmissionModeOf({ env, fetchImpl, workspace, readPolicyFile, pr }));
  const plans = [];
  for (const { pr, since, progress_ref, scope, orphaned, expectedBinding } of heads) {
    try {
      let plan=orphaned?{action:'disable_auto_merge',reason:'managed auto-merge no longer holds a live FIFO slot'}:
        await planFor({ env, fetchImpl, repository, pr, tip, since, progress_ref, workflows, policy: mode.policy, state: mode.state,qualifyExecution:qualify,
          required: await branchRules(), admissionMode: liveMode });
      if(managedAutoMerge(pr) && plan.action==='none') {
        const authority=await authorizeOperation({env,fetchImpl,workspace,readPolicyFile,repository,pr,tip,scope,expectedBinding,action:'merge_pull_request'});
        if(authority?.valid!==true)plan={action:'disable_auto_merge',reason:'managed request lost current permission, withdrawal or FIFO eligibility'};
      }
      plans.push({pr,scope,since,progress_ref,expectedBinding,...plan});
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
    let lastPr=plan.pr,lastExecution=plan.execution,lastFence=null;
    if(plan.action==='disable_auto_merge') {
      const current=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${plan.pr.number}`);
      if(current?.node_id!==plan.pr.node_id || current.state!=='open' || !managedAutoMerge(current)) {
        result.actions.push({...entry,action:'none',reason:'managed request is no longer present'});continue;
      }
    } else {
      const authority=await authorizeOperation({env,fetchImpl,workspace,readPolicyFile,repository,pr:plan.pr,tip,
        scope:plan.scope,expectedBinding:plan.expectedBinding,action:plan.action});
      if(authority?.valid!==true) {
        result.actions.push({...entry,action:'none',reason:'current permission, withdrawal, policy or FIFO gate refused the operation'});continue;
      }
      const final=await planFor({env,fetchImpl,repository,pr:authority.pr,tip,since:plan.since,progress_ref:authority.progress_ref,
        workflows,policy:authority.mode.policy,state:authority.mode.state,qualifyExecution:qualify,admissionMode:liveMode});
      if(final.action!==plan.action || (plan.run && (final.run?.id!==plan.run.id || final.run.run_attempt!==plan.run.run_attempt))) {
        result.actions.push({...entry,action:'none',reason:'execution or opt-in eligibility changed before the operation'});continue;
      }
      // Qualification may take time: recheck live authority after it, rather
      // than retaining the permission/withdrawal decision from before it.
      const lastAuthority=await authorizeOperation({env,fetchImpl,workspace,readPolicyFile,repository,pr:plan.pr,tip,
        scope:plan.scope,expectedBinding:plan.expectedBinding,action:plan.action});
      if(lastAuthority?.valid!==true || lastAuthority.progress_ref!==authority.progress_ref ||
        lastAuthority.pr.body!==authority.pr.body || lastAuthority.mode.state!==authority.mode.state) {
        result.actions.push({...entry,action:'none',reason:'live authority changed during execution qualification'});continue;
      }
      lastPr=lastAuthority.pr;lastExecution=final.execution;lastFence=lastAuthority.observation_fence??null;
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
      const operation_id=observations.newId();
      const pre=observations.record("operation_pre",{operation_id,pr:current,main_sha:tip});
      observations.record("operation_request",{operation_id,pre_observation_id:pre.record_id,action:plan.action,scope:plan.scope,pr:current,expected_head_sha:plan.pr.head.sha,main_sha:tip,
        ...plannedAuthorityFields(plan.expectedBinding),reason_code:'MAIN_MOVED_REQUIRES_RERUN'});
      const response = await observeMutation(()=>appRequest(fetchImpl, env, "PUT", `/repos/${repository}/pulls/${plan.pr.number}/update-branch`, token,
        { expected_head_sha: plan.pr.head.sha }),observations,{operation_id,action:plan.action});
      entry.status = response.status;
      // 422: the head moved since it was read, or the merge has a conflict the holder must resolve.
      if (response.status !== 202) entry.error = response.body && response.body.message ? String(response.body.message) : `HTTP ${response.status}`;
      // One fresh confirmation read, never retrying a 202. Observation failure
      // preserves the original operation result and remains an explicit gap.
      try {const post=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${plan.pr.number}`);
        const commit=await githubJson(fetchImpl,env,`/repos/${repository}/commits/${post.head.sha}`);
        if(post.number!==plan.pr.number||post.base?.repo?.full_name!==repository||commit.sha!==post.head.sha||!Array.isArray(commit.parents))throw Error();
        observations.record('operation_post',{operation_id,pr:post,main_sha:tip,parents:commit.parents.map(x=>x.sha),provider_request_id:response.request_id});
        if(response.status===202&&post.head.sha!==current.head.sha&&commit.parents.some(x=>x.sha===current.head.sha)&&commit.parents.some(x=>x.sha===tip))
          observations.record('round_termination',{operation_id,round_id:null,scope:plan.scope,pr:current,main_sha:tip});
      }catch{observations.record('operation_post_gap',{operation_id});}
    } else if (plan.action==='merge_pull_request') {
      const current=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${plan.pr.number}`);
      if(current?.head?.sha!==plan.pr.head.sha || current.state!=='open' || current.draft || current.auto_merge || current.mergeable_state!=='clean') {
        entry.action='none';entry.reason='native PR is not clean, current and free of waiting auto-merge';
      } else if(!await requiredBarrier(fetchImpl,env,repository,plan.pr.head.sha,plan.pr.number,lastExecution,{expectedPR:lastPr,action:plan.action})) {
        entry.action='none';entry.reason='native latest state changed after authority';
      } else {
        const operation_id=observations.newId();
        const run_keys=(lastExecution.native_runs??[]).map(r=>String(r.id)+':'+r.run_attempt).sort();
        observations.record('round_ci_observation',{scope:plan.scope,pr:current,seen:{state:'green',execution:lastExecution}});
        observations.record("operation_request",{operation_id,action:plan.action,scope:plan.scope,pr:current,expected_head_sha:plan.pr.head.sha,main_sha:tip,
          ...plannedAuthorityFields(plan.expectedBinding),run_keys,original_round_id:naturalRoundId(run_keys)});
        const merged=await observeMutation(()=>appRequest(fetchImpl,env,'PUT',`/repos/${repository}/pulls/${plan.pr.number}/merge`,token,
          {merge_method:'merge',sha:plan.pr.head.sha}),observations,{operation_id,action:plan.action});
        entry.merge_status=merged.status;
        if(merged.status===200 && merged.body?.merged===true){entry.result='merged';entry.merge_commit=merged.body.sha??null;
          try{const post=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${plan.pr.number}`);
            if(post.number!==plan.pr.number||post.head?.sha!==plan.pr.head.sha||post.merged!==true||post.merge_commit_sha!==merged.body.sha)throw Error();
            observations.record('merge_native_post',{operation_id,pr:post});
          }catch{observations.record('operation_post_gap',{operation_id});}}
        else {entry.result=merged.status===405||merged.status===409?'mergeable_now':'merge_refused';
          entry.error=`merge refused: ${merged.body?.message??`HTTP ${merged.status}`}`;}
      }
    }
    if (entry.error) result.notices.push(`#${plan.pr.number}: ${plan.action} was refused: ${entry.error}`);
    result.actions.push(entry);
  }
  return result;
}

export async function runExecutor(args) {
  // The accepted activation controls every automatic caller, including old
  // push/workflow_run entry points. Delegate before cleanup, qualification,
  // recording or any GitHub/Native read; only the durable route may mutate.
  const delegated = automaticExecutorGate(args.fetchImpl);
  if (delegated) return delegated;
  const recorder=args.observation_recorder??createNaturalRecorder({env:args.env,workspace:args.workspace,sourceUrl:import.meta.url,sourcePath:"scripts/ci/clued-merge-executor.mjs"});
  let completion="exception";
  try {const result=await runExecutorCore({...args,observation_recorder:recorder});completion="returned";return result;}
  finally {if(!args.observation_recorder)recorder.finish(completion);}
}

// Explicit holder dispatch only. Ordinary automatic dispatch/push behavior is
// unchanged. This is an original operation entry, not an imported JSON receipt:
// the code makes the pre/read/request/response/fresh-post itself. No retries.
export async function runRecordedHolderOperation({env,fetchImpl,workspace,input,observation_recorder,
  authorizeOperation=currentOperationAuthority,readPolicyFile=fs.readFileSync,now=()=>Date.now(),getToken=executorToken}){
  const refused=reason=>({status:'REFUSED',reason,operation_id:null});
  if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR!==env.GITHUB_REPOSITORY_OWNER||input?.measurement_opt_in!=='true')return refused('explicit Owner holder dispatch required');
  if(!['update_branch','cancel_ci_attempt'].includes(input.measurement_operation)||!/^\d+$/.test(String(input.measurement_pr??''))||
    !Number.isSafeInteger(Number(input.measurement_pr))||Number(input.measurement_pr)<1||!/^[a-f0-9]{40}$/.test(input.measurement_head??''))return refused('invalid exact operation subject');
  const repository=env.GITHUB_REPOSITORY,pr=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${Number(input.measurement_pr)}`);
  if(pr.head?.sha!==input.measurement_head||pr.state!=='open'||pr.draft||pr.base?.repo?.full_name!==repository)return refused('current original PR subject required');
  let expectedBinding;
  try { expectedBinding=await resolvePullRequestBinding(fetchImpl,env,pr,{workspace,readOnly:true}); }
  catch {return refused('current Native PR binding unavailable');}
  if(!samePRBindingAuthority(expectedBinding,expectedBinding))return refused('current Native PR binding required');
  const scope=expectedBinding.scope;
  const branch=await githubJson(fetchImpl,env,`/repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}`),tip=branch?.commit?.sha;
  const action=input.measurement_operation==='update_branch'?'holder_update_branch':'holder_cancel_ci_attempt';
  let authority=await authorizeOperation({env,fetchImpl,workspace,readPolicyFile,repository,pr,tip,scope,expectedBinding,action});
  if(authority?.valid!==true)return refused('current original permission/withdrawal/admission/FIFO gates refused');
  const recorder=observation_recorder??createNaturalRecorder({env,workspace,sourceUrl:import.meta.url,sourcePath:'scripts/ci/clued-merge-executor.mjs'}),operation_id=recorder.newId();
  let completion='exception';
  try{
    recorder.record('manual_operation_input',{operation_id,action:input.measurement_operation,pr_number:pr.number,expected_head_sha:pr.head.sha,
      ...plannedAuthorityFields(expectedBinding),run_id:input.measurement_run,attempt:input.measurement_attempt});
    const operationToken=input.measurement_operation==='update_branch'?(await getToken({env,fetchImpl,now})).token:null;
    if(input.measurement_operation==='update_branch'&&!operationToken)return refused('existing operation App permission unavailable');
    const last=await authorizeOperation({env,fetchImpl,workspace,readPolicyFile,repository,pr,tip,scope,expectedBinding,action});
    if(last?.valid!==true||last.pr.body!==authority.pr.body||last.pr.head.sha!==pr.head.sha||last.mode.state!==authority.mode.state)return refused('final live original authority changed');
    authority=last;
    const current=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${pr.number}`),main=await githubJson(fetchImpl,env,`/repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}`);
    if(!matchesOperationPR(current,authority.pr,input.measurement_operation)||main.commit?.sha!==tip)return refused('final Native PR/default branch changed');
    const pre=recorder.record('operation_pre',{operation_id,pr:current,main_sha:tip});
    const requestPayload={operation_id,pre_observation_id:pre.record_id,action:input.measurement_operation,origin:'holder_adapter',scope,pr:current,
      expected_head_sha:pr.head.sha,main_sha:tip,...plannedAuthorityFields(expectedBinding),
      reason_code:input.measurement_reason==='MAIN_MOVED_REQUIRES_RERUN'?'MAIN_MOVED_REQUIRES_RERUN':'GENERAL_UPDATE'};
    let response;
    if(input.measurement_operation==='update_branch'){
      recorder.record('operation_request',requestPayload);
      response=await observeMutation(()=>appRequest(fetchImpl,env,'PUT',`/repos/${repository}/pulls/${pr.number}/update-branch`,operationToken,{expected_head_sha:pr.head.sha}),recorder,{operation_id,action:'update_branch'});
    }else{
      if(!/^[1-9][0-9]{0,19}$/.test(input.measurement_run??'')||!/^\d+$/.test(String(input.measurement_attempt??'')))return refused('exact Native cancel attempt required');
      const r=await githubJson(fetchImpl,env,`/repos/${repository}/actions/runs/${input.measurement_run}`);
      if(r.head_sha!==pr.head.sha||r.event!=='pull_request'||r.run_attempt!==Number(input.measurement_attempt)||r.status==='completed'||
        !r.pull_requests?.some(x=>x.number===pr.number))return refused('active associated Native cancel subject changed');
      recorder.record('cancel_intent',{operation_id,run_id:String(r.id),attempt:r.run_attempt,request_receipt_id:pre.record_id,reason_code:'OWNER_STOP_REQUEST'});
      recorder.record('operation_request',requestPayload);
      response=await observeMutation(()=>appRequest(fetchImpl,env,'POST',`/repos/${repository}/actions/runs/${r.id}/cancel`,env.GITHUB_TOKEN),recorder,{operation_id,action:'cancel_ci_attempt'});
      const postRun=await githubJson(fetchImpl,env,`/repos/${repository}/actions/runs/${r.id}`);
      if(postRun.id!==r.id||postRun.run_attempt!==r.run_attempt||postRun.head_sha!==r.head_sha)return refused('fresh Native cancel post identity changed');
      recorder.record('cancel_native_post',{operation_id,run:postRun});
    }
    const post=await githubJson(fetchImpl,env,`/repos/${repository}/pulls/${pr.number}`);
    if(post?.number!==pr.number||post.base?.repo?.full_name!==repository||post.base?.ref!==pr.base.ref)return refused('fresh Native post identity unavailable');
    const commit=await githubJson(fetchImpl,env,`/repos/${repository}/commits/${post.head.sha}`);
    if(commit?.sha!==post.head.sha||!Array.isArray(commit.parents)||commit.parents.some(x=>!/^[a-f0-9]{40}$/.test(x.sha)))return refused('fresh Native commit post unavailable');
    recorder.record('operation_post',{operation_id,pr:post,main_sha:tip,parents:commit.parents.map(x=>x.sha),provider_request_id:response.request_id});
    if(input.measurement_operation==='update_branch'&&response.status===202&&input.measurement_reason==='MAIN_MOVED_REQUIRES_RERUN'&&
      post.head.sha!==pr.head.sha&&commit.parents.some(x=>x.sha===pr.head.sha)&&commit.parents.some(x=>x.sha===tip))
      recorder.record('round_termination',{operation_id,round_id:null,scope,pr:current,main_sha:tip});
    completion='returned';return {status:'RECORDED_ORIGINAL_OPERATION',operation_id,response_status:response.status,
      native_post_head:post.head.sha,confirmation:post.head.sha===pr.head.sha?'NOT_YET_CHANGED':'ACTUAL_NATIVE_POST_CHANGED',cancel_cause:'UNKNOWN_CAUSE'};
  }finally{if(!observation_recorder)recorder.finish(completion);}
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

export function executorEntryAllowed(env, event) {
  if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_RUN_ATTEMPT !== '1') return false;
  if (env.GITHUB_EVENT_NAME === 'push') return true;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    return event?.action === 'completed' && ['pull_request', 'pull_request_target'].includes(event.workflow_run?.event);
  }
  const owner = env.GITHUB_REPOSITORY_OWNER;
  return env.GITHUB_EVENT_NAME === 'workflow_dispatch' && Boolean(owner)
    && env.GITHUB_ACTOR === owner && env.GITHUB_TRIGGERING_ACTOR === owner
    && event?.repository?.owner?.login === owner;
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const event = env.GITHUB_EVENT_PATH && env.GITHUB_EVENT_NAME !== 'push'
    ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : null;
  if (!executorEntryAllowed(env, event)) {
    console.error('clued-merge-executor: event, actor or run attempt refused');
    return 1;
  }
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && event.inputs?.measurement_opt_in === 'true') {
    const recorded = await runRecordedHolderOperation({ env, fetchImpl, workspace: env.GITHUB_WORKSPACE, input: event.inputs });
    console.log(JSON.stringify(recorded));
    return recorded.status === 'RECORDED_ORIGINAL_OPERATION' ? 0 : 1;
  }
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
