#!/usr/bin/env node
// Merge Admission v0.1 §7.3, step 3 of §13 (Task 3576d10d; Owner Decisions
// 4f576896 and 1fb7f6b3): the merge slot follows CI. The clued-merge-slot-ci
// workflow runs this on the default branch, with the CI admission Binding's
// token, whenever a CI workflow run of a pull request completes and by hand;
// the hourly re-verification runs it too. It reports the CI state of each
// open pull request that holds a merge slot:
//
//   failed   a CI required check, as the default branch's rules require it
//            (name and integration, read live: requiredChecksOf; today all
//            from the independent CI, App 5368905), finally failed on the head
//            after the claim got the slot (step 4: an admission check that failed
//            before, as it does when the head falls behind while the claim
//            waits in the merge queue, leaves the holder the slot to bring
//            the default branch in and push; it holds green back); Clued
//            returns the slot at once, and a failing kooyumi-merge-slot check is
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
// app id, as the ruleset reads them, from the live branch rules) and from the runs of the default
// branch's CI workflows (gitleaks, trivy and the gated workflows) whose file
// at the head is byte for byte the default branch's (git blob SHA). The
// kooyumi-merge-slot check is not counted: it is the slot's result, not CI's.
//
// It runs from clued-merge-slot-ci.yml (a CI workflow of a pull request
// completed) and as a step of the hourly clued-work-admission-reverify run.
//
// GitHub requests per run: one list of open pull requests, and for each pull request
// that holds a slot one complete check-run snapshot, one complete PR run list and, while something
// runs, one directory listing. Every run looks at every slot, whichever pull
// request's run completed: concurrency keeps one run pending and drops the
// others, so a run must not skip a holder (confirmation review MINOR-A).

import { createHash } from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import fs from "node:fs";
import {ACTOR_WORKFLOW,ACTOR_SOURCE_PATH,classifyActorSource} from './clued-standard-runner-actor-source.mjs';
import {PUBLISHER_FILES,PUBLISHER_SOURCE_PATH,registeredPublisherSource} from "./clued-production-publisher-source.mjs";
import {PUBLISHER_PR_QUALIFICATION_FILES,PUBLISHER_PR_QUALIFICATION_PATH,registeredPublisherPrQualificationSource} from "./clued-publisher-qualification-source.mjs";
import {createNaturalRecorder} from "./merge-admission-source-producer.mjs";
import {NON_PR_CONTROL_FILES,NON_PR_CONTROL_SOURCE_PATH,parseNonPrControlCatalogue,classifyNonPrControlWorkflowSource} from './clued-non-pr-control-source.mjs';
import {parseWorkflowProfiles,registeredWorkflowSource,rolesForSource,roleDefinitionDigest,compileRegisteredWorkflow,WORKFLOW_PROFILES_MAX_BYTES} from './clued-workflow-profile.mjs';
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMISSION_APP_ID,
  MERGE_SLOT_CHECK_NAME,
  appChecksOnHead,
  checkNamesPullRequest,
  cluedRpc,
  githubJson,
  githubPaged,
  resolvePullRequestBinding,
  postAppCheck,
  withTokenHint,
  gateFindings,
  workflowIsGated,
} from "./clued-work-admission.mjs";
import { resolveMode } from "./merge-admission-policy.mjs";
import { normalizePRTaskBinding } from './clued-pr-task-binding.mjs';
import { githubGraphReader, githubAttemptLogReader, observeCompletedSource, createExecutionQualifier } from "./clued-gated-proof-runtime.mjs";

import {cleanupManagedAutoMerge} from "./clued-managed-auto-merge.mjs";

export const TOUCH_RPC = "clued_work_merge_slot_touch_v1";
export const HOLDERS_RPC = "clued_work_merge_slot_holders_v1";
const BINDING_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const BINDING_SHA = /^[0-9a-f]{40}$/;
function normalizedBinding(value, subject) {
  const normalized = normalizePRTaskBinding(value, subject ?? { scope: value?.scope, repository: value?.repository,
    prNumber: value?.pr_number, headSha: value?.head_sha, baseSha: value?.base_sha, targetBranch: value?.target_branch });
  if (normalized.binding_status !== 'bound' || !BINDING_UUID.test(normalized.head_authorization_id ?? ''))
    throw new Error('current Native binding required');
  return normalized;
}
// A renewal may extend a lease, but must never silently change the exact PR
// subject, Task, current holder generation or its private head authorization.
export function samePRBindingAuthority(expected, actual) {
  try {
    const a = normalizedBinding(expected), b = normalizedBinding(actual, { scope: a.scope, repository: a.repository,
      prNumber: a.pr_number, headSha: a.head_sha, baseSha: a.base_sha, targetBranch: a.target_branch });
    return a.task_id === b.task_id && a.claim.claim_id === b.claim.claim_id && a.claim.fence === b.claim.fence
      && a.claim.execution_epoch === b.claim.execution_epoch && a.head_authorization_id === b.head_authorization_id;
  } catch { return false; }
}
// The holder is the raw, repository-scoped Native API response. Array
// membership only schedules independently authorized current PR projections.
export function selectHolderBinding(holder, candidates, repository) {
  try {
    if (!holder || !BINDING_UUID.test(holder.claim_id ?? '') || !BINDING_UUID.test(holder.task_id ?? '')
      || !Array.isArray(holder.bound_prs) || !Array.isArray(candidates)) return null;
    const refs = new Set();
    for (const ref of holder.bound_prs) {
      if (typeof ref !== 'string' || !ref.startsWith(repository + '#')
        || !/^[1-9][0-9]{0,9}$/.test(ref.slice(repository.length + 1)) || refs.has(ref)) return null;
      refs.add(ref);
    }
    const eligible = [], numbers = new Set();
    for (const candidate of candidates) {
      const pr = candidate?.pr, raw = candidate?.binding;
      if (!pr || !refs.has(repository + '#' + pr.number)) continue;
      if (raw?.binding_status !== 'bound') continue;
      if (pr.state !== 'open' || pr.draft !== false || pr.base?.repo?.full_name !== repository) return null;
      const binding = normalizedBinding(raw, { scope: raw.scope, repository, prNumber: pr.number,
        headSha: pr.head?.sha, baseSha: pr.base?.sha, targetBranch: pr.base?.ref });
      if (binding.task_id !== holder.task_id || binding.claim.claim_id !== holder.claim_id || numbers.has(pr.number)) return null;
      numbers.add(pr.number); eligible.push({ candidate, binding });
    }
    if (!eligible.length) return null;
    const first = eligible[0].binding;
    if (eligible.some(({ binding: b }) => b.scope !== first.scope || b.claim.fence !== first.claim.fence
      || b.claim.execution_epoch !== first.claim.execution_epoch)) return null;
    const ci = holder.merge_slot_ci;
    if (['running', 'green'].includes(ci?.ci_state) && BINDING_SHA.test(ci?.ci_head_sha ?? '')) {
      const current = eligible.filter(({ binding }) => binding.head_sha === ci.ci_head_sha);
      if (!current.length) return null; // preserve an in-flight head instead of overwriting it with another PR
      return current.sort((a, b) => a.binding.pr_number - b.binding.pr_number)[0].candidate;
    }
    return eligible.sort((a, b) => a.binding.pr_number - b.binding.pr_number)[0].candidate;
  } catch { return null; }
}
export const ACTIONS_APP_ID = 15368;
export const INDEPENDENT_CI_APP_ID = 5368905;
// The main ruleset's mapping before 2026-10-20 (docs/maintenance/
// kooyumi-ci-check-cutover.md), by (name, app id). Design A2 (Owner Decisions
// 89945332, 22b0e0ed): nothing counts by this list any more. The reporter and
// the merge executor read the ruleset's actual required checks
// (requiredChecksOf), so App 5368905 today, and an Owner's temporary
// disaster-recovery switch of the ruleset (docs/maintenance/independent-ci.md)
// is followed without a code change. Kept as the legacy fixture reference.
export const LEGACY_CI_REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ name: "gitleaks", app_id: ACTIONS_APP_ID }),
  Object.freeze({ name: "trivy", app_id: ACTIONS_APP_ID }),
  Object.freeze({ name: "kooyumi-work-admission", app_id: ACTIONS_APP_ID }),
  Object.freeze({ name: "kooyumi-admission-verified", app_id: ADMISSION_APP_ID }),
  Object.freeze({ name: "contract-placement", app_id: ACTIONS_APP_ID }),
]);
// Workflows that count as CI besides the gated ones: those of the required
// checks' work. Since PR-B they are hosted executors (gitleaks-hosted-executor
// and so on): a run of one keeps a slot running, but while the ruleset counts
// no GitHub Actions check their failure is not CI's (hostedExecutorFailure).
export const REQUIRED_CHECK_WORKFLOWS = Object.freeze(["gitleaks.yml", "trivy.yml", "contract-placement.yml"]);

// The required status checks of the default branch, as GitHub enforces them:
// every required_status_checks rule of every active ruleset that applies to
// the branch, by (context, integration_id); a missing integration is any
// source (app_id null). Read live, never hard-coded. Fails closed: an
// unreadable, malformed or empty list throws and nothing is reported.
export async function requiredChecksOf(fetchImpl, env, repository, branch) {
  if (typeof branch !== "string" || !branch || /[\u0000-\u0020\u007f]/.test(branch))
    throw new Error("the default branch is unknown; its required checks cannot be read");
  const rules = await githubPaged(fetchImpl, env, `/repos/${repository}/rules/branches/${encodeURIComponent(branch)}`);
  const required = [];
  for (const rule of rules) {
    if (!rule || rule.type !== "required_status_checks") continue;
    const list = rule.parameters && rule.parameters.required_status_checks;
    if (!Array.isArray(list)) throw new Error("a required_status_checks rule has no check list");
    for (const entry of list) {
      const appId = entry && entry.integration_id !== undefined && entry.integration_id !== null ? entry.integration_id : null;
      if (!entry || typeof entry.context !== "string" || !entry.context || entry.context.length > 255 ||
        (appId !== null && (!Number.isSafeInteger(appId) || appId <= 0))) throw new Error("invalid required status check in the branch rules");
      if (!required.some((row) => row.name === entry.context && row.app_id === appId))
        required.push(Object.freeze({ name: entry.context, app_id: appId }));
    }
  }
  if (!required.length) throw new Error(`the ${branch} rules require no status check; CI cannot be counted`);
  return Object.freeze(required);
}
// kooyumi-merge-slot is required too, but it is the slot's own result, not CI's.
export const ciRequiredChecks = (required) => required.filter((row) => row.name !== MERGE_SLOT_CHECK_NAME);
const countsActionsChecks = (required) => required.some((row) => row.app_id === ACTIONS_APP_ID || row.app_id === null);

// Design A2: a check run of the independent CI (App 5368905) names no pull
// request in its external_id. It binds by its head and by the independent
// CI's own exact external_id formats: the v1 staged, Native admission and
// control publishers (independent-ci-v1 src/queue.mjs jobs), the Source v2
// publishers (src/job-v2.mjs scanExternalIdV2 and admissionExternalIdV2:
// ':v2:<job id>:a<attempt 1|2>', admission and control also
// ':c<claim id prefix>:f<fence>:e<epoch>'), and the relay
// (src/hosted-relay-v1/relay-plan.mjs, gitleaks and trivy only). A control
// check only counts from its own control role, and a summary that names
// another pull request of this repository is not this one's.
const INDEPENDENT_EXTERNAL_ID = new RegExp("^independent-ci:(?:" + [
  // v1: <job id>:f<fence>:e<epoch>:a<attempt>
  "(?:staged|native-work-admission):[a-f0-9]{64}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9}:a[1-9][0-9]{0,9}",
  "control:(control-admission|control-merge-slot):[a-f0-9]{64}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9}:a[1-9][0-9]{0,9}",
  // v2 scanner content proof: staged:v2:<job id>:a<attempt>
  "staged:v2:[a-f0-9]{64}:a[12]",
  // v2 admission and control: ...:v2:<job id>:a<attempt>:c<claim prefix>:f<fence>:e<epoch>
  "native-work-admission:v2:[a-f0-9]{64}:a[12]:c[a-f0-9]{8}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9}",
  "control:(control-admission|control-merge-slot):v2:[a-f0-9]{64}:a[12]:c[a-f0-9]{8}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9}",
  // relay: relay:<role>:<head12>:run<run id>:a<run attempt>
  "relay:(?:gitleaks|trivy):[a-f0-9]{12}:run[1-9][0-9]{0,19}:a[1-9][0-9]{0,3}",
].join("|") + ")$");
const INDEPENDENT_CONTROL_ROLE = Object.freeze({ "kooyumi-admission-verified": "control-admission", "kooyumi-merge-slot": "control-merge-slot" });
export function independentCheckBindsPullRequest(check, { headSha, prNumber, repository } = {}) {
  if (!check || check.head_sha !== headSha || !check.app || Number(check.app.id) !== INDEPENDENT_CI_APP_ID) return false;
  const match = INDEPENDENT_EXTERNAL_ID.exec(String(check.external_id ?? ""));
  if (!match) return false;
  const role = INDEPENDENT_CONTROL_ROLE[check.name], controlRole = match[1] ?? match[2];
  if (role ? controlRole !== role : controlRole !== undefined) return false;
  // A native admission id belongs to the work admission check only.
  if (/^independent-ci:native-work-admission:/.test(match[0]) !== (check.name === "kooyumi-work-admission") &&
    !/^independent-ci:staged:/.test(match[0])) return false;
  // A relay id names the relayed role and the head; both must be this check's.
  const relay = /^independent-ci:relay:(gitleaks|trivy):([a-f0-9]{12}):/.exec(match[0]);
  if (relay && (relay[1] !== check.name || relay[2] !== headSha.slice(0, 12))) return false;
  if (typeof repository === "string" && Number.isSafeInteger(prNumber)) {
    const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = [...String((check.output && check.output.summary) ?? "").matchAll(new RegExp(`${escaped}#([0-9]{1,10})(?![0-9])`, "gi"))];
    if (named.some((found) => Number(found[1]) !== prNumber)) return false;
  }
  return true;
}
// The pull request binding of a counted check, by the App that posted it.
function checkBindsPullRequest(check, required, { headSha, prNumber, repository }) {
  const appId = Number(check.app && check.app.id);
  if (appId === INDEPENDENT_CI_APP_ID) return independentCheckBindsPullRequest(check, { headSha, prNumber, repository });
  if (required.name === "kooyumi-admission-verified" && appId === ADMISSION_APP_ID)
    return !Number.isSafeInteger(prNumber) || checkNamesPullRequest(check, prNumber);
  return true;
}
// Design A2 (D8): a hosted executor (App 15368) run is not CI while the
// ruleset counts no GitHub Actions check. Its failure, a billing refusal
// included, never returns the slot; only the ruleset source's final failure does.
function hostedExecutorFailure(proof, required) {
  const reason = String((proof && proof.reason) ?? "");
  return !countsActionsChecks(required) && REQUIRED_CHECK_WORKFLOWS.some((file) => reason.startsWith(`.github/workflows/${file}:`));
}
// A required check passes as the ruleset counts it. A final failure returns
// the slot; cancelled is not one: the admission run of an edited pull request
// cancels the previous one on the same head, and the next run's check may not
// exist yet (review NIT).
const PASSING = new Set(["success"]);
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
  const bounded=(location,limit,label)=>{
    const raw=readFile(location),bytes=Buffer.isBuffer(raw)?raw:typeof raw==='string'?Buffer.from(raw,'utf8'):null;
    if(!bytes||bytes.length>limit)throw Error(label+' exceeds bounds');
    const text=bytes.toString('utf8');
    if(!Buffer.from(text,'utf8').equals(bytes))throw Error(label+' invalid UTF-8');
    return {bytes,text};
  };
  // One observation-local snapshot only; never cache Source/Role authorization
  // between this call and the final fresh directory barrier.
  let ordinary=null;
  const ordinarySource=(workflowPath,text,bytes)=>{
    if(!ordinary){
      const profiles=bounded(path.join(workspace,'scripts/ci/clued-gated-proof-profiles.json'),WORKFLOW_PROFILES_MAX_BYTES,'ordinary Source registry'),
        roles=bounded(path.join(workspace,'scripts/ci/clued-gated-proof-role-specs.json'),524288,'ordinary Role registry');
      ordinary={profiles:parseWorkflowProfiles(profiles.bytes),roles:JSON.parse(roles.text)};
    }
    if(!Object.hasOwn(ordinary.profiles.workflows,workflowPath))return false;
    const selected=registeredWorkflowSource(ordinary.profiles,workflowPath,gitBlobSha(bytes));
    if(!selected.passed||selected.profile.gated!==false)throw Error('unregistered default ordinary Source');
    const profile=selected.profile,roles=rolesForSource(ordinary.roles,workflowPath,profile.workflow_blob);
    if(!roles||roles.length!==profile.primary_ids.length||roles.some(role=>!role.definition||
      roleDefinitionDigest(role.definition)!==role.definition_sha256))throw Error('unregistered default ordinary Role');
    const compiled=compileRegisteredWorkflow(text,{primary_ids:profile.primary_ids,accepted_roles:roles,
      parseYaml:()=>({on:{pull_request:profile.pull_request},jobs:Object.fromEntries(roles.map(role=>[role.job_id,role.definition]))})});
    const {accepted_sources,...sourceSubject}=profile;
    if(!isDeepStrictEqual(compiled,sourceSubject))throw Error('default ordinary Source/Role differs');
    return true;
  };
  for (const file of readDir(dir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const {bytes,text}=bounded(path.join(dir,file),524288,'workflow Source'),workflowPath=`.github/workflows/${file}`;
    if(workflowPath===ACTOR_WORKFLOW){
      const raw=bounded(path.join(workspace,ACTOR_SOURCE_PATH),524288,'actor Source registry');
      const actor=classifyActorSource(JSON.parse(raw.text),workflowPath,text);
      if(actor.passed)continue;
      // An unregistered/mutated manual Source remains counted, never inferred N/A.
      out.set(workflowPath,gitBlobSha(bytes));continue;
    }
    if(Object.hasOwn(NON_PR_CONTROL_FILES,workflowPath)){
      const raw=bounded(path.join(workspace,NON_PR_CONTROL_SOURCE_PATH),524288,'non-PR Source registry'),
        selected=classifyNonPrControlWorkflowSource(parseNonPrControlCatalogue(raw.bytes),workflowPath,text);
      if(!selected.passed)throw Error('unregistered default non-PR control Source');
      continue;
    }
    if (REQUIRED_CHECK_WORKFLOWS.includes(file) || workflowIsGated(text)) {
      if(Object.hasOwn(PUBLISHER_PR_QUALIFICATION_FILES,workflowPath)) {
        const raw=readFile(path.join(workspace,PUBLISHER_PR_QUALIFICATION_PATH));
        if(raw.length>524288)throw Error('PR qualification Source registry exceeds bounds');
        const selected=registeredPublisherPrQualificationSource(JSON.parse(raw.toString('utf8')),workflowPath,bytes.toString('utf8'));
        if(!selected.passed||gateFindings(bytes.toString('utf8'),bytes.toString('utf8')).length)
          throw Error('unregistered default PR qualification Source');
        continue;
      }
      if(Object.hasOwn(PUBLISHER_FILES,workflowPath)) {
        // Only the exact registered default Source can be excluded from PR
        // proof enumeration. A basename or dispatch trigger is insufficient.
        const raw=readFile(path.join(workspace,PUBLISHER_SOURCE_PATH));
        if(raw.length>524288)throw Error('publisher Source registry exceeds bounds');
        const selected=registeredPublisherSource(JSON.parse(raw.toString('utf8')),workflowPath,bytes.toString('utf8'));
        if(!selected.passed||selected.profile.source_kind!=='gated_successor'||
          gateFindings(bytes.toString('utf8'),bytes.toString('utf8')).length)throw Error('unregistered default publisher Source');
        continue;
      }
      out.set(workflowPath, gitBlobSha(bytes));
    }else if(ordinarySource(workflowPath,text,bytes))out.set(workflowPath,gitBlobSha(bytes));
  }
  return out;
}

// A snapshot belongs to one observation only. Every final barrier reads again.
const SNAPSHOT_PAGE_CAP = 20;
async function completeHeadSnapshot(fetchImpl, env, repository, headSha, kind) {
  const checks = kind === 'check_runs';
  const route = checks ? `/repos/${repository}/commits/${headSha}/check-runs?filter=all`
    : `/repos/${repository}/actions/runs?head_sha=${headSha}&event=pull_request`;
  const key = checks ? 'check_runs' : 'workflow_runs';
  const rows = [], ids = new Set(); let total = null;
  for (let page = 1; page <= SNAPSHOT_PAGE_CAP; page++) {
    const body = await githubJson(fetchImpl, env, `${route}&per_page=100&page=${page}`);
    if (!body || !Array.isArray(body[key]) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 ||
      body.total_count > SNAPSHOT_PAGE_CAP * 100 || (total !== null && body.total_count !== total) || body[key].length > 100)
      throw Error(`incomplete ${key} snapshot`);
    total = body.total_count;
    for (const row of body[key]) {
      if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) || row.head_sha !== headSha ||
        typeof row.status !== 'string' || !(ACTIVE.has(row.status) || row.status === 'completed') ||
        (checks ? typeof row.name !== 'string' || !row.name || !Number.isSafeInteger(row.app?.id) || row.app.id <= 0 ||
          !(row.conclusion === null || typeof row.conclusion === 'string') :
          row.event !== 'pull_request' || typeof row.path !== 'string' || !row.path))
        throw Error(`invalid ${key} snapshot row`);
      ids.add(row.id); rows.push(row);
    }
    if (rows.length === total) return rows;
    if (rows.length > total || body[key].length !== 100) throw Error(`incomplete ${key} snapshot`);
  }
  throw Error(`incomplete ${key} snapshot`);
}

// The newest check run of a required check on an already complete snapshot.
// A rule without an integration (app_id null) takes any App's check.
function newestCheck(checks, headSha, { name, app_id: appId }) {
  return checks
    .filter((check) => check && check.name === name && check.head_sha === headSha
      && check.app && (appId === null || Number(check.app.id) === appId))
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}
export function matchesOperationPR(current,expected,action) {
  return Boolean(current && expected && current.number===expected.number && current.state==='open' && current.draft===false &&
    current.head?.sha===expected.head?.sha && current.body===expected.body &&
    current.base?.ref===expected.base?.ref && current.base?.repo?.full_name===expected.base?.repo?.full_name &&
    current.base?.repo?.default_branch===expected.base?.repo?.default_branch &&
    (!action || current.auto_merge===null) && (action!=='merge_pull_request' || current.mergeable_state==='clean'));
}
// The final barrier reads the branch rules again unless the caller passes the
// list it read in this same observation (required).
export async function requiredBarrier(fetchImpl,env,repository,head,prNumber,proof,{expectedPR,action,required,branch}={}) {
  const signal=AbortSignal.timeout(12000);
  const bounded=(url,init)=>fetchImpl(url,{...init,signal,redirect:'error'});
  if(proof?.tip || expectedPR) {
    const current=await githubJson(bounded,env,`/repos/${repository}/pulls/${prNumber}`);
    if(expectedPR && !matchesOperationPR(current,expectedPR,action))return false;
    if(proof?.tip) {
      if(!proof.default_branch || current?.number!==prNumber || current.state!=='open' || current.draft!==false ||
        current.head?.sha!==head || current.base?.ref!==proof.default_branch || current.base?.repo?.full_name!==repository ||
        current.base?.repo?.default_branch!==proof.default_branch)return false;
      const branch=await githubJson(bounded,env,`/repos/${repository}/branches/${encodeURIComponent(proof.default_branch)}`);
      if(branch?.commit?.sha!==proof.tip)return false;
    }
  }
  let checkSnapshot,requiredChecks;
  try {
    requiredChecks=ciRequiredChecks(required??await requiredChecksOf(bounded,env,repository,
      branch??proof?.default_branch??expectedPR?.base?.ref));
    checkSnapshot=await completeHeadSnapshot(bounded,env,repository,head,'check_runs');
  }
  catch { return false; }
  if(!requiredChecks.length)return false;
  for(const entry of requiredChecks) {
    const check=newestCheck(checkSnapshot,head,entry);
    if(!check || check.status!=='completed' || check.conclusion!=='success' ||
      !checkBindsPullRequest(check,entry,{headSha:head,prNumber,repository}))return false;
  }
  if(proof && !Array.isArray(proof.native_runs))return false;
  const expected=proof?.native_runs??[];
  const matches=(a,b)=>a?.id===b.id && a.head_sha===head && a.run_attempt===b.run_attempt &&
    a.event==='pull_request' && a.status===b.status && a.conclusion===b.conclusion &&
    String(a.path??'').replace(/@.*$/,'')===b.path &&
    Array.isArray(a.pull_requests) && JSON.stringify(a.pull_requests.map(pr=>pr.number))===JSON.stringify(b.pull_requests);
  for(const run of expected)if(!matches(await githubJson(bounded,env,`/repos/${repository}/actions/runs/${run.id}`),run))return false;
  let total=null;const seen=new Set(),latest=new Map();
  for(let page=1;page<=20;page++) {
    const body=await githubJson(bounded,env,`/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request&per_page=100&page=${page}`);
    if(!Array.isArray(body.workflow_runs) || !Number.isSafeInteger(body.total_count) || body.total_count<0 ||
      (total!==null && total!==body.total_count))return false;
    total=body.total_count;
    for(const run of body.workflow_runs) {
      if(!Number.isSafeInteger(run.id) || seen.has(run.id) || run.head_sha!==head || run.event!=='pull_request' ||
        run.status!=='completed')return false;
      seen.add(run.id);
      const file=String(run.path??'').replace(/@.*$/,'');
      if(!latest.has(file)||run.id>latest.get(file).id)latest.set(file,run);
    }
    if(seen.size===total)return expected.every(run=>matches(latest.get(run.path),run));
    if(seen.size>total || body.workflow_runs.length!==100)return false;
  }
  return false;
}

// failed, running, green, or idle (not reported), with what was seen. An
// admission check's failure that completed before slotSince (when the claim
// became head of the merge queue, ms) is not reported.
const STALE_OK = new Set(["kooyumi-work-admission", "kooyumi-admission-verified"]);
// required: the branch rules as read in this observation (requiredChecksOf);
// read here from the pull request's default branch when not given.
export async function ciStateOf(fetchImpl, env, repository, headSha, workflows, slotSince = null, { pr, qualifyExecution, required } = {}) {
  const checks = [];
  let before = null;
  const rules = required ?? await requiredChecksOf(fetchImpl, env, repository,
    pr && pr.base && (pr.base.repo && pr.base.repo.default_branch || pr.base.ref));
  const requiredChecks = ciRequiredChecks(rules);
  if (!requiredChecks.length) return { state: "idle", reason: "the branch rules require no CI check", checks };
  const checkSnapshot = await completeHeadSnapshot(fetchImpl, env, repository, headSha, 'check_runs');
  for (const required of requiredChecks) {
    const check = newestCheck(checkSnapshot, headSha, required);
    checks.push({ name: required.name, app_id: required.app_id, status: check ? check.status : "missing", conclusion: check ? check.conclusion ?? null : null });
    if (check && !checkBindsPullRequest(check, required, { headSha, prNumber: pr ? pr.number : undefined, repository }))
      return { state: "idle", reason: `the newest ${required.name === "kooyumi-admission-verified" ? "admission" : required.name} check does not bind this pull request`, checks };
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
  const runs = await completeHeadSnapshot(fetchImpl, env, repository, headSha, 'workflow_runs');
  const anyActive = runs
    .filter((run) => ACTIVE.has(run.status))
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
    return { state: "idle", reason: `only runs that are not counted are active: ${anyActive.map((run) => `${run.path} ${run.status}`).join(", ")}`, checks, active_runs: anyActive };
  }
  if (before) return { state: "idle", reason: before, checks };
  if (checks.every((check) => check.status === "completed" && PASSING.has(check.conclusion))) {
    if (!pr || pr.head?.sha !== headSha || typeof qualifyExecution !== "function")
      return { state: "idle", reason: "required checks passed; execution qualification context unavailable", checks };
    const proof = await qualifyExecution(pr);
    if (proof?.head !== headSha || proof.pr_number !== pr.number)
      return { state: "idle", reason: proof?.reason ?? "execution proof identity missing", checks };
    if (proof.state === "failed") {
      if (hostedExecutorFailure(proof, requiredChecks))
        return { state: "idle", reason: `${proof.reason}; a hosted executor is not a required check of these rules, so the slot is not returned`, checks, execution: proof };
      return { state: "failed", reason: proof.reason, checks, execution: proof };
    }
    if (proof.passed === true && proof.state === "qualified" && await requiredBarrier(fetchImpl,env,repository,headSha,pr.number,proof,{required:rules}))
      return { state: "green", reason: proof.reason, checks, execution: proof };
    return { state: "idle", reason: proof.reason ?? "execution scope remains unknown", checks, execution: proof };
  }
  return { state: "idle", reason: "no CI result yet and no CI run active", checks };
}

// The clued-admission App (5164952) posts the failing slot check below. It
// does so only where the rules take kooyumi-merge-slot from that App (or from
// any App, or name no source). Where the independent CI (5368905) owns the
// check, its stage 8 publishes it only for a live slot at the queue head, and
// a foreign same-name failure (Owner Decision bc6fdad1) could never be cleared.
const reporterPostsSlotCheck = (required) => {
  const sources = (required ?? []).filter((row) => row.name === MERGE_SLOT_CHECK_NAME).map((row) => row.app_id);
  return !sources.length || sources.some((appId) => appId === ADMISSION_APP_ID || appId === null);
};
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

async function reportMergeSlotsCore({ env, event, eventName, fetchImpl, workspace, readPolicyFile = fs.readFileSync,
  sourceObservationBudgetMs, qualifyExecution }) {
  const repository = env.GITHUB_REPOSITORY;
  const mode = resolveMode({ env, workspace, readFile: readPolicyFile });
  const hardCap = (mode.policy && mode.policy.merge_slot_hard_cap_minutes) || DEFAULT_HARD_CAP_MINUTES;
  const result = { event: eventName, hard_cap_minutes: hardCap, holders: [], reports: [], skipped: null, notices: [], errors: [] };
  const observations=arguments[0].observation_recorder;
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  const workflows = ciWorkflows(workspace);
  const qualify = qualifyExecution ?? createExecutionQualifier({ env, fetchImpl, workspace, workflows });
  const openPulls=await githubPaged(fetchImpl,env,`/repos/${repository}/pulls?state=open`);
  const cleanup=await cleanupManagedAutoMerge({env,fetchImpl,pulls:openPulls});
  result.managed_cleanup=cleanup.actions;result.notices.push(...cleanup.notices);result.errors.push(...cleanup.errors);
  if (!(env.CLUED_CONTEXT_READ_TOKEN ?? "").trim()) {
    result.errors.push(withTokenHint("CLUED_CONTEXT_READ_TOKEN is not set."));
    return result;
  }

  if (eventName === "workflow_run" && Number.isSafeInteger(event?.workflow_run?.id)) {
    result.source_observation = await observeCompletedSource({ env, event, eventName, workspace, workflows,
      budgetMs: sourceObservationBudgetMs,
      read: (route, { signal }) => githubJson((url, init) => fetchImpl(url, { ...init, signal, redirect: "error" }), env, route),
      graphRead: githubGraphReader(fetchImpl, env),
      readLog: githubAttemptLogReader(fetchImpl, env) });
  }
  const pulls = openPulls.filter(pr=>!cleanup.blocked.has(pr.number))
    .filter((pr) => pr && pr.head && pr.base && pr.base.repo && pr.base.ref === pr.base.repo.default_branch);
  // Only authenticated Native PR projections identify a Task/scope/current
  // claim. PR prose, commits and an assumed global scope have no authority.
  const candidates = [];
  for (const pr of pulls) {
    try {
      if (pr.state !== 'open' || pr.draft !== false || pr.base.repo.full_name !== repository) continue;
      const binding = await resolvePullRequestBinding(fetchImpl, env, pr, { workspace, readOnly: true });
      if (binding.binding_status === 'bound') candidates.push({ pr, binding });
      else if (binding.binding_status === 'conflict') result.errors.push(`#${pr.number}: Native PR Task binding is ambiguous or outside the served scope`);
      else result.notices.push(`#${pr.number}: Native binding is ${binding.binding_status}; no CI state is reported`);
    } catch {
      result.errors.push(`#${pr.number}: Native PR Task binding is unconfirmed`);
    }
  }
  const scopes = [...new Set(candidates.map(({ binding }) => binding.scope))].sort();
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
    const holders = response.body.holders;
    const claims = new Set(), tasks = new Set(), refs = new Set();
    if (response.body.repository !== repository || !Array.isArray(holders) || holders.some(holder => {
      if (!holder || !BINDING_UUID.test(holder.claim_id ?? '') || !BINDING_UUID.test(holder.task_id ?? '')
        || !Array.isArray(holder.bound_prs) || !Number.isFinite(Date.parse(holder.merge_slot_until ?? ''))
        || claims.has(holder.claim_id) || tasks.has(holder.task_id)) return true;
      claims.add(holder.claim_id); tasks.add(holder.task_id);
      for (const ref of holder.bound_prs) {
        if (typeof ref !== 'string' || !ref.startsWith(repository + '#')
          || !/^[1-9][0-9]{0,9}$/.test(ref.slice(repository.length + 1)) || refs.has(ref)) return true;
        refs.add(ref);
      }
      return false;
    })) { result.errors.push(`Clued ${HOLDERS_RPC}: unsupported or inconsistent Native holder projection`); continue; }
    for (const holder of holders) {
      const possible = candidates.filter(({ binding }) => binding.scope === scope);
      const selected = selectHolderBinding(holder, possible, repository), pr = selected?.pr;
      const memberCount = possible.filter(({ pr }) => holder.bound_prs.includes(`${repository}#${pr.number}`)).length;
      if (!selected && memberCount) result.errors.push(`Clued ${HOLDERS_RPC}: Task/current-claim ambiguity or in-flight head changed`);
      result.holders.push({ scope, claim_id: holder.claim_id, task_id: holder.task_id,
        bound_pr: pr ? `${repository}#${pr.number}` : holder.bound_prs.length === 1 ? holder.bound_prs[0] : null,
        bound_prs: holder.bound_prs, open: Boolean(pr),
        merge_slot_until: holder.merge_slot_until ?? null });
      const since = Date.parse(holder.merge_slot_ci && holder.merge_slot_ci.taken_at || "");
      if (selected) live.push({ scope, pr, binding: selected.binding, since: Number.isFinite(since) ? since : null });
    }
  }
  // The slot check is failed only where the policy requires the slot: in
  // efficiency it only advises it for code and docs (confirmation review
  // MINOR-B). Admission is always enforced since Merge Admission step 6.
  const slotRequired = mode.state !== "efficiency";
  // The branch rules are read once per run, only when a live slot is reported.
  let required = null;
  for (const { pr, scope, since, binding } of live) {
    const prRef = `${repository}#${pr.number}`;
    try {
      required ??= await requiredChecksOf(fetchImpl, env, repository, pr.base.repo.default_branch);
      let seen = await ciStateOf(fetchImpl, env, repository, pr.head.sha, workflows, since, { pr, qualifyExecution: qualify, required });
      observations.record("round_ci_observation",{scope,pr,seen});
      const report = { pr: pr.number, head_sha: pr.head.sha, ci_state: seen.state, reason: seen.reason };
      if (seen.state !== "idle") {
        const current = await githubJson(fetchImpl, env, `/repos/${repository}/pulls/${pr.number}`);
        const tip = seen.execution?.tip ? await githubJson(fetchImpl, env,
          `/repos/${repository}/branches/${encodeURIComponent(pr.base.repo.default_branch)}`) : null;
        if (current?.number !== pr.number || current.state !== "open" || current.draft !== false || current.head?.sha !== pr.head.sha ||
          current.base?.ref !== pr.base.ref || current.base?.repo?.full_name !== repository ||
          current.base.repo.default_branch !== pr.base.repo.default_branch ||
          (seen.execution?.tip && tip?.commit?.sha !== seen.execution.tip)) {
          Object.assign(report, { ci_state: "idle", reason: "PR or default tip changed before reporting CI" });
          result.reports.push(report);continue;
        }
        if(seen.state==='green' && !await requiredBarrier(fetchImpl,env,repository,pr.head.sha,pr.number,seen.execution,
          {branch:pr.base.repo.default_branch})) {
          Object.assign(report,{ci_state:'idle',reason:'required checks or active runs changed before reporting CI'});
          result.reports.push(report);continue;
        }
        const freshBinding = await resolvePullRequestBinding(fetchImpl, env, current, { workspace, scope, readOnly: true });
        if (!samePRBindingAuthority(binding, freshBinding)) {
          Object.assign(report, { ci_state: 'idle', reason: 'Native PR Task/current-claim authority changed before reporting CI' });
          result.reports.push(report); continue;
        }
        const response = await cluedRpc(fetchImpl, env, workspace, TOUCH_RPC, {
          scope, pr_ref: prRef, head_sha: pr.head.sha, ci_state: seen.state,
          ...(seen.state === "failed" ? { reason: [...seen.reason.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")].slice(0, 300).join("") } : { hard_cap_minutes: hardCap }),
        });
        observations.record("slot_touch",{scope,pr,seen,response});
        const error = rpcError(TOUCH_RPC, response);
        if (error) throw new Error(error);
        Object.assign(report, seen.state === "failed"
          ? { returned: Boolean(response.body.returned), notified: response.body.notified ?? [] }
          : { touched: Boolean(response.body.touched), merge_slot_until: response.body.merge_slot_until ?? null });
        // The head's kooyumi-merge-slot check may still be green: fail it, so a
        // re-run that turns CI green cannot let auto-merge merge without the
        // slot. Also when an earlier run returned the slot but could not post
        // (confirmation review NIT-2): the newest App check is still green then.
        const stale = seen.state === "failed" && slotRequired && reporterPostsSlotCheck(required)
          && (report.returned || await newestSlotCheckGreen(fetchImpl, env, repository, pr.head.sha));
        if (stale) {
          const posted = await postAppCheck({ env, fetchImpl, headSha: pr.head.sha, success: false, prNumber: pr.number,
            name: MERGE_SLOT_CHECK_NAME, title: "Merge slot returned: CI failed",
            summary: `${seen.reason} on this head, so Clued gave the merge slot back (Merge Admission v0.1 §7.3). `
              + "Turn auto-merge off and fix the cause; then take the slot again and push to run this check again. PR prose does not establish claim authority." });
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

export async function reportMergeSlots(args) {
  const recorder=args.observation_recorder??createNaturalRecorder({env:args.env,workspace:args.workspace,sourceUrl:import.meta.url,sourcePath:"scripts/ci/clued-merge-slot-ci.mjs"});
  let completion="exception";
  try {const result=await reportMergeSlotsCore({...args,observation_recorder:recorder});completion="returned";return result;}
  finally {if(!args.observation_recorder)recorder.finish(completion);}
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
    lines.push(`- #${report.pr} \`${report.head_sha.slice(0, 12)}\`: **${report.ci_state}** (${report.reason}); ${outcome}${report.ci_state === "failed" ? `; notified ${(report.notified ?? []).length} claim(s)` : ""}`);
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
