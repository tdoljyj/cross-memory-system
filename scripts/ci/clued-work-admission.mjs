#!/usr/bin/env node
// Work Claim Admission v0.1, step 3 (development/contracts/execution-admission/
// WorkClaimAdmission.v0.1.md §4.6 L0a/L0b). One script, four modes:
//
//   --mode required   the unfiltered `kooyumi-work-admission` check on every PR
//   --mode gate       the `admission-gate` job that heavy self-hosted workflows
//                     run first; they `needs:` it and run only on admitted=true.
//                     It does not call Clued and holds no Clued token: it reads
//                     the result of the trusted required check (see gate())
//   --mode dispatch-admit
//                     the `clued-work-admission-dispatch` run on the default
//                     branch: verifies a claim before a heavy workflow is
//                     dispatched by hand (see dispatchAdmit())
//   --mode reverify   the scheduled re-check: every open PR whose last
//                     admission run passed is verified again, and that run is
//                     re-run when its claim no longer admits the PR (expired,
//                     released, superseded, or bound to another PR), so a
//                     green check does not outlive its claim
//   --mode adopt      the run on a closed pull request: reports a merge to
//                     Clued so that, when the Task runs as a multi-copy race,
//                     the copy on this pull request is adopted (adoptMerged()),
//                     and returns the merge slot of a merged or closed one
//
// The admission run also posts the kooyumi-merge-slot check (mergeSlotState()):
// a pull request that contains the base branch's tip can merge only while its
// claim holds the merge slot (agent contract §1.7).
//
// The required check runs on `pull_request_target`: the workflow file and this
// script come from the base branch, and no code of the PR is checked out or
// executed. The PR is read through the API only, fetched fresh on every run so
// an edited body or a re-run sees the current trailer and head.
//
// Each verify call carries pr_ref "<owner>/<repo>#<number>". The first verify
// that admits binds the claim to that pull request in Clued; any other PR
// naming the same claim is REJECTED (claim_bound_to_other_pr).
//
// The required and reverify modes ask Clued whether the PR's work claim admits
// the PR's head, base and changed files: clued_work_verify_v1 (read-only, no receipt), called on
// the Clued database's PostgREST endpoint with the public publishable key and
// the SHA-256 of the read-only Binding token in CLUED_CONTEXT_READ_TOKEN. The
// database resolves the Binding and its scope itself, exactly as it does for
// the Worker. The public /mcp route cannot be used here: in production it is
// owned by the delegated OAuth provider and accepts OAuth access tokens only.
//
// Admission is always enforced: a missing trailer, a REJECTED verdict, a
// missing RPC, a refused token or a transport error all fail closed, except
// where the merge admission policy itself only advises the claim (below).
// Until Merge Admission step 6 (2026-10-09) the repository variables
// CLUED_WORK_ADMISSION_ENFORCE and CLUED_OWNER_REVIEW_ENFORCE could turn the
// check into an advisory one; they are no longer read. The rollback is the
// frozen state and the main ruleset's Owner emergency steps
// (MergeAdmission.v0.1.md §13). Non-PR events (push to main, dispatch) are
// not admission subjects and are admitted.
//
// CLUED_CONTEXT_READ_TOKEN is read only by the jobs that run default-branch
// code (the pull_request_target check, the scheduled re-verification and the
// dispatch admission), all in the `clued-admission` environment. No `pull_request` job, whose code the PR
// controls, is given it.
//
// Merge Admission v0.1 (MergeAdmission.v0.1.md, Owner Decision d130195e): what
// a pull request needs besides its claim is no longer a set of constants here
// but the merge admission policy (merge-admission-policy.mjs and
// config/merge-admission-policy.json, read from the default branch's
// checkout). The pull request's paths give its layer (protected, code or
// docs), the Owner's variable CLUED_MERGE_ADMISSION_STATE the state (normal,
// efficiency or frozen), and the two give the rules: whether the claim is
// enforced or only advised, whether an Owner Grant and the base branch's tip
// are needed, whether the merge slot is required and whether auto-merge is
// allowed. The summary and the App check's title show the mode a head was
// judged in.
//
// No dependencies: Node 20+ fetch, crypto and fs only, so a hosted runner
// finishes in seconds without an install.

import { createHash, createSign, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import {isDeepStrictEqual} from "node:util";
import {CONTROL_WORKFLOW_FILES,registeredControlWorkflowTransition} from './clued-control-workflow-source.mjs';
import {PUBLISHER_FILES,registeredPublisherTransition} from "./clued-production-publisher-source.mjs";
import {PUBLISHER_PR_QUALIFICATION_FILES,registeredPublisherPrQualificationTransition} from "./clued-publisher-qualification-source.mjs";
import {compileRegisteredWorkflow,registeredWorkflowSource,rolesForSource,roleDefinitionDigest,workflowBlob,parseWorkflowProfiles} from "./clued-workflow-profile.mjs";
import {createNaturalRecorder,observeEvaluation} from "./merge-admission-source-producer.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proxyBootstrapArguments } from "../runner/clued-runner-job-started.mjs";

import {
  effectiveProtectedPaths,
  effectiveRules,
  globToRegExp,
  layerOf,
  loadPolicy,
  modeLabel,
  parseModeLabel,
  POLICY_PATH,
  resolveMode,
} from "./merge-admission-policy.mjs";

export { globToRegExp };

// The public project URL and publishable key come from the repository's single
// source for them, app/supabase-public-config.ts (the web app and the Worker
// default to the same values), or from CLUED_SUPABASE_URL /
// CLUED_SUPABASE_PUBLISHABLE_KEY when both are set. The script never carries a
// copy of the key. A publishable key is not a secret; the Binding token is,
// and only its hash leaves the runner.
export const PUBLIC_CONFIG_SOURCE = "apps/clued-cloud/app/supabase-public-config.ts";
export const VERIFY_RPC = "clued_work_verify_v1";

export function resolvePublicSupabaseConfig(env, workspace, readFile = fs.readFileSync) {
  const url = (env.CLUED_SUPABASE_URL ?? "").trim();
  const key = (env.CLUED_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  if (url && key) return { url: url.replace(/\/$/, ""), key, source: "env" };
  if (url || key) throw new Error("CLUED_SUPABASE_URL and CLUED_SUPABASE_PUBLISHABLE_KEY must be set together.");
  if (!workspace) throw new Error(`GITHUB_WORKSPACE is not set; cannot read ${PUBLIC_CONFIG_SOURCE}.`);
  const text = readFile(path.join(workspace, PUBLIC_CONFIG_SOURCE), "utf8");
  const match = /return \{ url: "(https:\/\/[^"]+)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};/.exec(text);
  if (!match) throw new Error(`${PUBLIC_CONFIG_SOURCE} has no recognizable public default; set CLUED_SUPABASE_URL and CLUED_SUPABASE_PUBLISHABLE_KEY.`);
  return { url: match[1].replace(/\/$/, ""), key: match[2], source: PUBLIC_CONFIG_SOURCE };
}

// Read only the current epoch of a target whose GitHub gate has already
// qualified it. A public observation cannot create or refresh an admission.
// No CI Binding, lease key, or GitHub App private key is needed on a runner.
export async function executionEpochCurrent(fetchImpl, env, workspace, input) {
  const config = resolvePublicSupabaseConfig(env, workspace);
  const response = await fetchImpl(`${config.url}/rest/v1/rpc/clued_work_verify_v1`, {
    method: "POST", signal: AbortSignal.timeout(10000), headers: { apikey: config.key, authorization: `Bearer ${config.key}`, "content-type": "application/json" },
    body: JSON.stringify({ p_token_hash: null, p_input: { action: "execution_current", ...input } }),
  });
  if (response.status !== 200) throw new Error(`Clued execution epoch unavailable (${response.status})`);
  const result = await response.json();
  if (result?.status !== "ok" || typeof result.guard_required !== "boolean"
    || (result.guard_required && typeof result.epoch_current !== "boolean"))
    throw new Error("Clued execution epoch observation is invalid");
  return !result.guard_required || result.epoch_current === true;
}
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
// globToRegExp lives in merge-admission-policy.mjs, which matches the policy's
// layers with the same semantics.

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);

export function parseWorkflowTriggers(text) {
  const lines = text.split(/\r?\n/);
  let name = null;
  const triggers = { pull_request: null };
  const all = [];
  const open = () => {
    triggers.pull_request = { paths: [], pathsIgnore: [] };
    all.push(triggers.pull_request);
  };
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
            if (PR_EVENTS.has(item)) open();
          }
          inOn = false;
        } else if (PR_EVENTS.has(top[2].trim())) {
          open();
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
        if (PR_EVENTS.has(unquote(line.trim().slice(1)))) open();
        continue;
      }
      trigger = key ? key[1] : null;
      if (trigger === "pull_request_target") trigger = "pull_request";
      listKey = null;
      if (trigger === "pull_request") open();
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
  // pull_request and pull_request_target together: the workflow runs when
  // either does, so one unfiltered trigger makes the whole workflow unfiltered.
  if (all.length === 0) return { name, pull_request: null };
  if (all.some((t) => t.paths.length === 0 && t.pathsIgnore.length === 0)) {
    return { name, pull_request: { paths: [], pathsIgnore: [] } };
  }
  if (all.length === 1) return { name, pull_request: all[0] };
  return { name, pull_request: { ...all[0], any: all } };
}

export function workflowApplies(trigger, changedPaths) {
  if (!trigger) return { applies: false, reason: "no pull_request trigger" };
  if (trigger.any) {
    const hit = trigger.any.map((one) => workflowApplies(one, changedPaths)).find((d) => d.applies);
    return hit ?? { applies: false, reason: "no changed path matches its filter" };
  }
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

export async function githubJson(fetchImpl, env, route, { allowMissing = false } = {}) {
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

export async function githubPaged(fetchImpl, env, route, key) {
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

// The files endpoint stops at 3000 entries. Callers compare file_count with
// the PR's changed_files and fail closed when the list came back short.
export async function changedPathsOfPullRequest(fetchImpl, env, repository, number) {
  const files = await githubPaged(fetchImpl, env, `/repos/${repository}/pulls/${number}/files`);
  const paths = new Set();
  for (const file of files) {
    if (typeof file.filename === "string") paths.add(file.filename);
    if (typeof file.previous_filename === "string") paths.add(file.previous_filename);
  }
  return { paths: [...paths].sort(), file_count: files.length, files };
}

// ---------------------------------------------------------------------------
// Gate guard (Owner Decision 37e01bb1). The admission-gate job and the needs
// that tie heavy jobs to it live in the PR's own workflow files, so a pull
// request could delete them and run the heavy jobs anyway. This check runs
// base-branch code and reads every workflow the PR adds or changes. A
// workflow that is gated on the base branch, or a new workflow with a
// self-hosted job, must keep the admission-gate job exactly as one of
// GATE_JOB_SHA256 and
// make every other job need it with an `if:` that is the gate condition
// joined by && to one parenthesized group. Changing the gate job itself is a
// two-step change: first add the new job's digest here, then the workflows.

const GATE_JOB = "admission-gate";
const GATE_CONDITION = "needs.admission-gate.outputs.admitted == 'true'";
export const GATE_JOB_SHA256 = new Set([
  // Owner Decision f86179b3: the gate (with `checks: read`, re-review 2 N3c)
  // runs on the self-hosted Linux pool with a pinned Node, so it spends no
  // hosted minutes. The hosted variant (62f231ef…) is no longer accepted.
  "41e789754b90dcb27c8297bf83169194b7aaab2659d909859ddd8618d0fa07c4",
  // Task fb97ebd5: the same gate with Pull requests: read for private-PR
  // re-runs. Register this exact version before updating the workflows.
  "4136409cf9440c3e8755ed03014cd3c39f90a169f4f8a2ce3d83af2e4a0111cd",
  // Merge Admission step 6 (Task 958f8ed7): the same gate without the
  // CLUED_WORK_ADMISSION_ENFORCE line, once enforcement no longer reads it.
  "37620beee0357ddf3b46f145e170ea7819db0fbbaded1156d656b9bbfbf2e7dc",
  // BUG-20261010-CI-TMP-001: exactly the same enforced gate, plus the
  // checked-out temporary-storage bootstrap immediately before its command.
  // Register on trusted main first; workflow rollout is a separate PR.
  "d6d96a1eef2f756770304c25b1bf0aab3b8ec72408553ceb141edc0230a995c9",
  // Stage C: the same trusted-base gate exports the independently observed
  // main-refresh route. Register these exact bytes before consumer rollout.
  "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb",
  // Owner Decisions 325717a6 and 22b0e0ed: the Stage C gate on
  // ubuntu-latest for the gitleaks, trivy and contract-placement hosted
  // executors on free minutes ($0 Actions budget cap). Only gitleaks and
  // trivy are relayable (hosted-relay-v1 RELAYABLE_ROLES); the placement
  // hosted run is execution only and never relayed. Admitting on the
  // independent CI's own admission (CLUED_ADMISSION_GATE_SOURCE, a
  // 600-second bounded wait, a 15-minute job). Registered here (PR-A)
  // before the workflows change (PR-B).
  "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
  // Owner Decision b30b1b79 (Task 52157cac): the d6d96a1e… gate on any runner of the self-hosted
  // pool, Linux or Windows, at any site (runs-on without `Linux`), still self-hosted with the
  // pinned Node of Decision f86179b3, so the compute panel keeps alerting while the company's
  // Linux runners are offline. Registered here (PR-A) before clued-compute-panel.yml changes (PR-B).
  "b000e5a2bc4b0ca76de4beb7dfc3001dca7a428dde79578e457057081e1109ce",
  // Task 2a5fdb66 (Owner Decision 9eb313f8: new execution self-hosted only): the
  // 3f48159e… gate, admitting on the independent CI's own admission, with only
  // runs-on moved from ubuntu-latest to the self-hosted Linux pool, for the
  // required test checks of clued-required-tests.yml. Registered here (PR-A)
  // before that workflow is added (PR-B, #971).
  "9c582144f424d1bc9ef7d3b048d3b7771c7b639ef5544bc04a8a80515c52b2f2",
]);
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
export const PRODUCTION_PUBLISHER_WORKFLOW = ".github/workflows/clued-cloud-production-release.yml";
export const PLACEMENT_WORKFLOW = ".github/workflows/contract-placement.yml";
const PLACEMENT_PREDECESSOR_BLOB = "90c632e917de5c84a3d8fb49e634f624703139cd";
// Prior local candidate only; never represented as a published main generation.
const PLACEMENT_DRAFT_V1_BLOB = "606e2179c957c1537320a71673a2c572cf1a037d";
// The self-hosted successor now on main. Owner Decisions 325717a6, 22b0e0ed
// and bc6fdad1 replace it with the exact PR-B hosted executor
// (contract-placement-hosted-executor, same checks). Its relay identity step
// is inert: contract-placement is never relayed (it runs PR code while it
// holds id-token: write); App 5368905 publishes contract-placement only from
// its formal local role, as the PR-B workflow comment states.
const PLACEMENT_SELF_HOSTED_SUCCESSOR_BLOB = "54ee2f11cc0f52d7cd9c0f6a63b75da8ef3e2b3a";
const PLACEMENT_SUCCESSOR_BLOB = "3640f0895cc72caffb8b2bc0c1df21b76b4b5340";
const PLACEMENT_SUCCESSOR_SHA256 = "4898299bee3e804a19acfef51d15b582e5a52526a655a290cf09bb56c39de84b";
const PLACEMENT_ROLE_SHA256 = "01d8c96aed0a55154156254899bd2e08dffaf7ec7ea8041acfaf6b2be5307e78";
const PLACEMENT_GATE_SHA256 = "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9";

// Only this independently reviewed Source/FullRole can cross the old ungated
// boundary. Keep checking later gated edits: a retained gate cannot authorize
// removing the ordinary-CI subject check or moving it onto another workflow.
export function registeredPlacementSuccessor({file,headText,baseText,profiles,roleSpecs}={}) {
  const no=reason=>({passed:false,registeredPlacementTransition:false,reason});
  try {
    if(file?.filename!==PLACEMENT_WORKFLOW || file.status!=="modified" ||
      file.previous_filename && file.previous_filename!==PLACEMENT_WORKFLOW ||
      typeof baseText!=="string" || typeof headText!=="string")return no("placement exact modified path/base required");
    const baseBlob=workflowBlob(baseText),headBlob=workflowBlob(headText);
    if(![PLACEMENT_PREDECESSOR_BLOB,PLACEMENT_DRAFT_V1_BLOB,PLACEMENT_SELF_HOSTED_SUCCESSOR_BLOB,PLACEMENT_SUCCESSOR_BLOB].includes(baseBlob) ||
      headBlob!==PLACEMENT_SUCCESSOR_BLOB || sha256Hex(headText)!==PLACEMENT_SUCCESSOR_SHA256)
      return no("placement exact predecessor/successor bytes required");
    const before=registeredWorkflowSource(profiles,PLACEMENT_WORKFLOW,baseBlob),
      after=registeredWorkflowSource(profiles,PLACEMENT_WORKFLOW,headBlob);
    if(!before.passed || !after.passed || before.profile.source_yaml!==baseText || after.profile.source_yaml!==headText)
      return no("placement Sources must already be registered on main");
    const profile=after.profile,roles=rolesForSource(roleSpecs,PLACEMENT_WORKFLOW,headBlob),role=roles?.[0];
    if(roles?.length!==1 || role.job_id!=="contract-placement" || !role.definition ||
      role.definition_sha256!==PLACEMENT_ROLE_SHA256 || roleDefinitionDigest(role.definition)!==PLACEMENT_ROLE_SHA256)
      return no("placement independent complete Role required");
    // The exact Source hash binds the complete YAML. Recompile route/command
    // metadata from its separately accepted FullRole without executing a PR
    // parser or importing any candidate code.
    const compiled=compileRegisteredWorkflow(headText,{primary_ids:["contract-placement"],accepted_roles:roles,
      parseYaml:()=>({name:"contract-placement",on:{pull_request:null},jobs:{"admission-gate":{},"contract-placement":role.definition}})});
    if(!isDeepStrictEqual(compiled,profile) ||
      sha256Hex(workflowJobs(headText).find(job=>job.name===GATE_JOB)?.lines.join("\n")??"")!==PLACEMENT_GATE_SHA256)
      return no("placement compiled Source/FrozenGate differs");
    return {passed:true,registeredPlacementTransition:before.profile.gated===false,profile,role};
  }catch{return no("placement Source/Role invalid");}
}

function trustedPlacementCatalogues() {
  const read=(name,limit)=>{
    const location=new URL(name,import.meta.url),info=fs.lstatSync(location);
    if(!info.isFile() || info.isSymbolicLink() || info.size>limit)throw Error("trusted placement catalogue unavailable");
    const bytes=fs.readFileSync(location),text=bytes.toString("utf8");
    if(bytes.length>limit || !Buffer.from(text,"utf8").equals(bytes))throw Error("trusted placement catalogue invalid");
    return name.endsWith("clued-gated-proof-profiles.json")?parseWorkflowProfiles(bytes):JSON.parse(text);
  };
  try{return {profiles:read("./clued-gated-proof-profiles.json",1048576),
    roleSpecs:read("./clued-gated-proof-role-specs.json",524288)};}
  catch{return {profiles:null,roleSpecs:null};}
}

// BEGIN exact bootstrap ordinary Source integration; no runtime work inputs.
const BOOTSTRAP_ORDINARY_SOURCES=Object.freeze([
  {
    "file": ".github/workflows/clued-cloud-quality-gate.yml",
    "predecessor_blob": "a811a0128db82fb23f78b51fefea73288a103223",
    "candidate_blob": "f00faf1d60179780f26f25dd338f591c4319b352",
    "candidate_sha256": "dd05c39a6dee035a500d4ba56c5d49a7f5f784ddfa7aa2f2032493d7d809739d",
    "gate_sha256": "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb",
    "roles": [
      {
        "job_id": "trusted-self-hosted",
        "definition_sha256": "fcdeb46431eb70d29f3027b9f99f3de2de9da3982594c62594eced64e5adf254"
      },
      {
        "job_id": "untrusted-hosted",
        "definition_sha256": "b6d8f88b6fde77d47735e9680d9c0e4418fcdffaf3d7f444c14ab855aaa1ded1"
      }
    ]
  },
  {
    "file": ".github/workflows/clued-components.yml",
    "predecessor_blob": "c1d5649e420263e313ff5d52247b09d27920536f",
    "candidate_blob": "c146ce2f79ab4f6228c079d31a3dd2b9cfb4ae07",
    "candidate_sha256": "e652630eb5048a28eccfb02aa272ff5cfcb2267932272ba0e2a6705b06e53b49",
    "gate_sha256": "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb",
    "roles": [
      {
        "job_id": "trusted-self-hosted",
        "definition_sha256": "2df1e615ebc6a51510530d43bcfa96c4cd3e42d9bb5d61c4d64a65daedda09af"
      },
      {
        "job_id": "untrusted-hosted",
        "definition_sha256": "86f9463a0bb3f8c23e3e03499ce9cf171ec4a1e2562053c14a7a5b7f27e970bb"
      }
    ]
  },
  {
    "file": ".github/workflows/gitleaks.yml",
    "predecessor_blob": "74043d68d20dbee9f9404a66f0a02d3285fea0aa",
    "candidate_blob": "95f4527be27d02889892d029b398ab1cf2e71429",
    "candidate_sha256": "688073ac1281c4322c90673816b761852989f6849083c07eca2cbd8f4e424091",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "gitleaks-trusted-self-hosted",
        "definition_sha256": "a4aeb5d5ab4d38eac6bff4dcd68b19f0c7874ef009a17483d8e4375f3af4bfda"
      }
    ]
  },
  {
    "file": ".github/workflows/gitleaks.yml",
    "predecessor_blob": "95f4527be27d02889892d029b398ab1cf2e71429",
    "candidate_blob": "d0fe73eeabc9c163d3216e57ca6a7633288262c5",
    "candidate_sha256": "46627f909229d06a6b5c35112f7619b28c6aa9f0a196a526b067e3a962d9da2b",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "gitleaks-trusted-self-hosted",
        "definition_sha256": "ce19a253d56ca6b81ad83cb6d86045f30e679397e815f14a632fe8aada46dacc"
      }
    ]
  },
  {
    "file": ".github/workflows/gitleaks.yml",
    "predecessor_blob": "d0fe73eeabc9c163d3216e57ca6a7633288262c5",
    "candidate_blob": "8d172bdfeda9b554d2c8c0e5868ccae6e1a3096d",
    "candidate_sha256": "6f61572b6cd7550772925b8ad3b26e129cf010901f04122662ceeb00d01c7cd1",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "gitleaks-trusted-self-hosted",
        "definition_sha256": "6c30ca4a766e00abe10aa225ff8296d3903857d384e43ecbae5fd8c374281103"
      }
    ]
  },
  {
    "file": ".github/workflows/gitleaks.yml",
    "predecessor_blob": "8d172bdfeda9b554d2c8c0e5868ccae6e1a3096d",
    "candidate_blob": "e6fafbb0a40ce37795f1e50bbda03cd33fbf40e0",
    "candidate_sha256": "9d6c23d2ae4769d123f7ddcd3a25810878d36a85efc2403c07ecec5ecd17cdab",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "gitleaks-trusted-self-hosted",
        "definition_sha256": "339ea01c079430a47e66f1822cccdb281630117934158287dfbf1629c51e497f"
      }
    ]
  },
  {
    "file": ".github/workflows/trivy.yml",
    "predecessor_blob": "f7f8d075d1a0f314a7c5eb295e459599288d538c",
    "candidate_blob": "300ad19a59bf529ccebd45ae7fbb76189f806316",
    "candidate_sha256": "94e9ac722e3a3e0c4f924ce3b27371803dc2a04b5e177a7b0bcffd2bdf28b810",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "trivy-trusted-self-hosted",
        "definition_sha256": "c7b119873990af82908377518126526da392fb7aa351c4b00841d30970062625"
      }
    ]
  },
  {
    "file": ".github/workflows/trivy.yml",
    "predecessor_blob": "300ad19a59bf529ccebd45ae7fbb76189f806316",
    "candidate_blob": "50bd4ae3312ea3c5b1896a9ec81922b0b392343b",
    "candidate_sha256": "8ec20479b6a7bbf3cc3c2b085271c9a7ed4dc06a16ea9e39c05900428adfa0d2",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "trivy-trusted-self-hosted",
        "definition_sha256": "55d8a4d90ceb55f6abdd4ce583d0a0481987b28b9fbc7ba80372a455c48bdde8"
      }
    ]
  },
  {
    "file": ".github/workflows/runner-budget-policy.yml",
    "predecessor_blob": "9a5f46cdb30f2fb0394f0ea3c0fdb91a7539cb13",
    "candidate_blob": "5619452aa4e616a992861fa3f7f154f4b484f6a4",
    "candidate_sha256": "dda08be0e13d271d495a625d0ad25d4c60646ccc805bcc0542056b1c46fc778d",
    "gate_sha256": "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb",
    "roles": [
      {
        "job_id": "trusted-self-hosted",
        "definition_sha256": "0c9bde9a02ccb317e593614441f564e522e98401597f6fd74b8be37096d0681c"
      },
      {
        "job_id": "untrusted-hosted",
        "definition_sha256": "6ef6e62469265c9d9222876fa029164e88661dbbccd8a3f8c3221fa74334d0d0"
      }
    ]
  },
  {
    "file": ".github/workflows/clued-connection-authorization.yml",
    "predecessor_blob": "3d20ba406c8397cfa86bf29be6904bf9fb6ba287",
    "candidate_blob": "90cac082bf246af83377b19669d21ea82abd026f",
    "candidate_sha256": "0de704b484c993d5a9d9759d4c17d1644e2035d9e71172b0259ad2b3c3519ba9",
    "gate_sha256": "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb",
    "roles": [
      {
        "job_id": "isolated-candidate-trusted-self-hosted",
        "definition_sha256": "023ff3555032c89046d457851c3d467cb29bbe9bc5d71c82292717c152cfe6c7"
      },
      {
        "job_id": "isolated-candidate-untrusted-hosted",
        "definition_sha256": "122289e1c2c3b0e2c32dceec654ab878043fa6b36f69017ae7e5ff53ff68d29c"
      }
    ]
  },
  {
    "file": ".github/workflows/information-flow-e2e.yml",
    "predecessor_blob": "312e1ef4d963ccf5be13ee9db57b30cdaef6cf99",
    "candidate_blob": "7b098eb798482099b2ffaf650a344e0d0ba12510",
    "candidate_sha256": "dfbe58c1edf4caacda109dfdf39b19fc66526bcb503ea10992472f8e9c086e1c",
    "gate_sha256": "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb",
    "roles": [
      {
        "job_id": "e2e-trusted-self-hosted",
        "definition_sha256": "41641adb256b4d24b73a15534df32b527165d6563ee36d3cd8d0d6766853f889"
      },
      {
        "job_id": "e2e-untrusted-hosted",
        "definition_sha256": "9d156e66707037d0eb4cda7df91d630bfb18871696897e9bcddbe7368da97e76"
      }
    ]
  },
  {
    "file": ".github/workflows/public-mcp-behavior.yml",
    "predecessor_blob": "05aaf31c642cee6be608b4aa1f635f6f1f9df5ec",
    "candidate_blob": "f21fc0ebc64d6ddef684c496ffd98a663564ed5d",
    "candidate_sha256": "644d79d52f4b3e376300461f8260f25715bfa254ed75b990bbb279f0f7cedc38",
    "gate_sha256": "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb",
    "roles": [
      {
        "job_id": "trusted-self-hosted",
        "definition_sha256": "14b1c2ca529f017e926d28082009c5c3d3390894a1e8bb70d78639e0c9eaa8f4"
      },
      {
        "job_id": "untrusted-hosted",
        "definition_sha256": "7d7d11171c286b45a64096d36bdd9f064ec5573a60ac12d16f26683f59b565c0"
      }
    ]
  },
  {
    "file": ".github/workflows/public-mcp-protocol.yml",
    "predecessor_blob": "cdd4a4a1e55c3e59b933b8617fdd9c44310f2078",
    "candidate_blob": "482185df0d258a968bee7eb3500cdf1847ac6287",
    "candidate_sha256": "17fb876b9ef5b0f169b4601eb633381a677b9c9b02b5e23678ddba1a794daca9",
    "gate_sha256": "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb",
    "roles": [
      {
        "job_id": "trusted-self-hosted",
        "definition_sha256": "446fd76242ded564e057f395419329b222bde354e258442999bf4555252399b1"
      },
      {
        "job_id": "untrusted-hosted",
        "definition_sha256": "f968f1e82055b40013ef4bb560b0b11bd7af6bc90b0817f821c59db273dc794a"
      }
    ]
  },
  {
    "file": ".github/workflows/gitleaks.yml",
    "predecessor_blob": "e6fafbb0a40ce37795f1e50bbda03cd33fbf40e0",
    "candidate_blob": "ba4690650935961e7f4aa289a3aa0dc874b8b4fd",
    "candidate_sha256": "d8daffb6f35d572ada3028f1b372bc9e728edb9d757a6442a702ae423645ff77",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "gitleaks-trusted-self-hosted",
        "definition_sha256": "2325e6f3f3d459f1204a77a842d4726b13cad06e73c1312478a6b9df013882bd"
      }
    ]
  },
  {
    "file": ".github/workflows/trivy.yml",
    "predecessor_blob": "50bd4ae3312ea3c5b1896a9ec81922b0b392343b",
    "candidate_blob": "9867c4c847a61aa33761e27b793e0928bc6cbfdc",
    "candidate_sha256": "ef85f4ad53e75d2105c1892600b83b8b70b198dc1518ff856ba53fb6c4053ccb",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "trivy-trusted-self-hosted",
        "definition_sha256": "7745a8c7286ffba75761d8ee00fbb099809318a9bdc6bf52760064d040cefa8f"
      }
    ]
  },
  {
    "file": ".github/workflows/gitleaks.yml",
    "predecessor_blob": "ba4690650935961e7f4aa289a3aa0dc874b8b4fd",
    "candidate_blob": "6441fc32b084002de697415ea8343af07816c929",
    "candidate_sha256": "116e6b201e30251b0f702ff4416dcfd015d2b311cbd2f000cdcd3e81e6d29966",
    "gate_sha256": "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9",
    "roles": [
      {
        "job_id": "gitleaks-trusted-self-hosted",
        "definition_sha256": "9dd1c58aa9a60dce0a079158bd0ce3ac47b93626854c85672e9c217f5a623caf"
      }
    ]
  }
]);
const bootstrapOrdinarySame=(a,b)=>roleDefinitionDigest(a)===roleDefinitionDigest(b);
const bootstrapOrdinaryRefusal=reason=>({passed:false,registeredBootstrapOrdinaryTransition:false,reason});
export function bootstrapOrdinaryKnownFile(file){return BOOTSTRAP_ORDINARY_SOURCES.some(source=>source.file===file);}

export function bootstrapOrdinaryRegistryView(profiles,roleSpecs){
  const file='.github/workflows/runner-budget-policy.yml',source=profiles?.bootstrap_ordinary_sources,
    roles=roleSpecs?.bootstrap_ordinary_sources,descriptor=BOOTSTRAP_ORDINARY_SOURCES.find(row=>row.file===file);
  if(source===undefined&&roles===undefined)return {profiles,roleSpecs,staged:false};
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&bootstrapOrdinarySame(Object.keys(value).sort(),keys.sort());
  if(!exact(source,['schema','workflows'])||!exact(roles,['schema','workflows'])||
    source.schema!=='clued.bootstrap-ordinary-source-stage/1'||roles.schema!=='clued.bootstrap-ordinary-role-stage/1'||
    !exact(source.workflows,[file])||!exact(roles.workflows,[file])||profiles.workflows?.[file]||roleSpecs.workflows?.[file])
    throw Error('bounded staged ordinary catalogue identity');
  const entry=source.workflows[file],roleEntry=roles.workflows[file];
  if(!exact(entry,['registration_status','predecessor','successor'])||entry.registration_status!=='accepted_not_installed'||
    entry.predecessor?.workflow_blob!==descriptor.predecessor_blob||entry.successor?.workflow_blob!==descriptor.candidate_blob||
    !exact(roleEntry,['sources'])||!exact(roleEntry.sources,[descriptor.predecessor_blob,descriptor.candidate_blob]))
    throw Error('bounded staged ordinary Source/Role identity');
  const view={...profiles,workflows:{...profiles.workflows,[file]:{...entry.predecessor,accepted_sources:[entry.successor]}}},
    specs={...roleSpecs,workflows:{...roleSpecs.workflows,[file]:roleEntry}};
  for(const blob of [descriptor.predecessor_blob,descriptor.candidate_blob])if(!registeredWorkflowSource(view,file,blob).passed||
    !rolesForSource(specs,file,blob))throw Error('staged ordinary Source/Role integrity');
  return {profiles:view,roleSpecs:specs,staged:true};
}

export function registeredBootstrapOrdinarySuccessor({file,headText,baseText,profiles,roleSpecs}={}){
  try{
    const candidates=BOOTSTRAP_ORDINARY_SOURCES.filter(row=>row.file===file?.filename);
    if(!candidates.length||file.status!=='modified'||file.previous_filename!==undefined&&file.previous_filename!==file.filename||
      typeof headText!=='string'||typeof baseText!=='string')return bootstrapOrdinaryRefusal('exact modified ordinary-CI identity');
    const beforeBlob=workflowBlob(baseText),headBlob=workflowBlob(headText);
    // Each exact successor keeps its own predecessor and already-installed self-pair.
    // A catalogue entry alone cannot permit a skipped generation or rollback.
    const matches=candidates.filter(row=>headBlob===row.candidate_blob&&
      [row.predecessor_blob,row.candidate_blob].includes(beforeBlob));
    if(matches.length!==1||sha256Hex(headText)!==matches[0].candidate_sha256)
      return bootstrapOrdinaryRefusal('exact ordinary-CI Source bytes');
    const descriptor=matches[0];
    ({profiles,roleSpecs}=bootstrapOrdinaryRegistryView(profiles,roleSpecs));
    const before=registeredWorkflowSource(profiles,descriptor.file,beforeBlob),after=registeredWorkflowSource(profiles,descriptor.file,headBlob);
    if(!before.passed||!after.passed||before.profile.source_yaml!==baseText||after.profile.source_yaml!==headText)
      return bootstrapOrdinaryRefusal('ordinary-CI Source must be registered on trusted main');
    const roles=rolesForSource(roleSpecs,descriptor.file,headBlob);
    if(!roles||roles.length!==descriptor.roles.length||!bootstrapOrdinarySame(roles.map(({job_id,definition_sha256})=>({job_id,definition_sha256})),descriptor.roles)||
      roles.some(role=>!role.definition||roleDefinitionDigest(role.definition)!==role.definition_sha256))return bootstrapOrdinaryRefusal('independent full ordinary-CI Roles');
    const profile=after.profile,compiled=compileRegisteredWorkflow(headText,{primary_ids:descriptor.roles.map(role=>role.job_id),accepted_roles:roles,
      parseYaml:()=>({name:descriptor.file==='.github/workflows/clued-cloud-quality-gate.yml'?'clued-cloud-quality':descriptor.file.split('/').pop().replace(/\.yml$/,''),
        on:{pull_request:profile.pull_request},jobs:{'admission-gate':{},...Object.fromEntries(roles.map(role=>[role.job_id,role.definition]))}})});
    if(!bootstrapOrdinarySame(compiled,profile)||sha256Hex(workflowJobs(headText).find(job=>job.name==='admission-gate')?.lines.join('\n')??'')!==descriptor.gate_sha256)
      return bootstrapOrdinaryRefusal('compiled ordinary-CI Source/FrozenGate differs');
    return {passed:true,scope:'exact_ordinary_ci_source_only',registeredBootstrapOrdinaryTransition:before.profile.gated===false,
      profile,roles,execution_authority:false,host_qualification:'separate_required'};
  }catch{return bootstrapOrdinaryRefusal('ordinary-CI Source invalid');}
}
// END exact bootstrap ordinary Source integration.

// A publisher conversion is registered on trusted main before its workflow
// changes. PR-provided profiles, flags and environment variables are not inputs.
// Unknown or ambiguous sources keep the original ungated-workflow refusal.
export function registeredPublisherGatedSuccessor(file, headText, baseText, profiles) {
  const workflowPath = file?.filename;
  if (workflowPath !== PRODUCTION_PUBLISHER_WORKFLOW || file.status !== "modified" ||
      workflowBasePath(file) !== PRODUCTION_PUBLISHER_WORKFLOW || baseText === null ||
      workflowIsGated(baseText) || !workflowIsGated(headText)) return false;
  return registeredPublisherTransition(profiles, workflowPath, headText, baseText).passed;
}

function trustedControlProfiles() {
  try {
    const location=new URL('./clued-control-workflow-sources.json',import.meta.url),info=fs.lstatSync(location);
    if(!info.isFile()||info.isSymbolicLink()||info.size>524288)return null;
    const bytes=fs.readFileSync(location),text=bytes.toString('utf8');
    if(bytes.length>524288||!Buffer.from(text,'utf8').equals(bytes))return null;
    return JSON.parse(text);
  }catch{return null;}
}

function trustedPublisherProfiles() {
  // The fixed adjacent default-branch catalogue is not a PR proof registry.
  // A caller workspace, environment variable or PR file cannot select it.
  const location = new URL("./clued-production-publisher-sources.json", import.meta.url);
  try {
    const info = fs.lstatSync(location);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 524288) return null;
    const bytes = fs.readFileSync(location);
    if (bytes.length > 524288) return null;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function trustedPublisherPrQualificationProfiles() {
  const location = new URL("./clued-publisher-qualification-sources.json", import.meta.url);
  try {
    const info=fs.lstatSync(location);
    if(!info.isFile()||info.isSymbolicLink()||info.size>524288)return null;
    const bytes=fs.readFileSync(location),text=bytes.toString('utf8');
    if(bytes.length>524288||!Buffer.from(text,'utf8').equals(bytes))return null;
    return JSON.parse(text);
  }catch{return null;}
}

export function workflowJobs(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start < 0) return [];
  const jobs = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) break;
    const key = /^  ([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (key) {
      current = { name: key[1], lines: [] };
      jobs.push(current);
    }
    if (current) current.lines.push(line);
  }
  // Blank and comment lines before the next job belong to that job, not this one.
  for (const job of jobs) {
    while (job.lines.length > 1 && /^\s*(#.*)?$/.test(job.lines[job.lines.length - 1])) job.lines.pop();
  }
  return jobs;
}

function jobField(job, field) {
  const index = job.lines.findIndex((line) => line.startsWith(`    ${field}:`));
  if (index < 0) return null;
  const parts = [job.lines[index].slice(`    ${field}:`.length)];
  for (let i = index + 1; i < job.lines.length && /^ {5,}\S|^\s*$/.test(job.lines[i]); i += 1) parts.push(job.lines[i]);
  return parts.join("\n");
}

function jobNeeds(job) {
  const value = jobField(job, "needs");
  if (value === null) return [];
  const text = value.replace(/#.*$/gm, "");
  const inline = text.split("\n")[0].trim();
  if (inline.startsWith("[")) return inline.replace(/[[\]'"]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  if (inline) return [unquote(inline)];
  return [...text.matchAll(/^\s*-\s*(\S+)/gm)].map((m) => unquote(m[1]));
}

function jobCondition(job) {
  const value = jobField(job, "if");
  if (value === null) return null;
  let text = value.replace(/^\s*[>|][+-]?/, "").replace(/\s+/g, " ").trim();
  const wrapped = /^\$\{\{(.*)\}\}$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  return text;
}

// One parenthesized group spanning the whole string, quotes respected.
function singleGroup(text) {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") { depth -= 1; if (depth === 0 && i < text.length - 1) return false; }
  }
  return depth === 0 && quote === null;
}

export function gateConditionHolds(condition) {
  if (condition === null) return false;
  if (condition === GATE_CONDITION) return true;
  const prefix = `${GATE_CONDITION} && `;
  return condition.startsWith(prefix) && singleGroup(condition.slice(prefix.length).trim());
}

export function workflowIsGated(text) {
  return workflowJobs(text).some((job) => job.name === GATE_JOB);
}

// Re-review N4 (Task 869d2db7): the line reader above understands one YAML
// form only, so a workflow the PR adds or changes must be in that form, or the
// check refuses it. The jobs block is one bare `jobs:` line; inside it every
// line is a blank or comment line, a bare `  <job>:` key line with nothing
// after the colon, or indented four or more spaces. Quoted, flow-style or
// aliased jobs, tabs and a second YAML document are refused.
// Re-review 2: the line reader splits on \n only, but YAML parsers also break
// lines at a lone \r (and some at U+0085, U+2028 and U+2029), so such a
// character could hide a whole job from it. Those characters, and the other
// control characters, are refused anywhere in the file.
const HIDDEN_LINE_BREAK = /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/;
export function workflowFormFindings(text) {
  const raw = String(text ?? "");
  if (HIDDEN_LINE_BREAK.test(raw)) return ["workflow_not_canonical:line_break"];
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const findings = [];
  const jobsLines = lines.map((line, i) => [line, i]).filter(([line]) => /^["']?jobs["']?\s*:/.test(line));
  if (jobsLines.length !== 1 || !/^jobs:\s*(#.*)?$/.test(jobsLines[0][0])) return ["workflow_not_canonical:jobs"];
  let started = false;
  lines.forEach((line, i) => {
    if (/\t/.test(line)) findings.push(`workflow_not_canonical:tab:${i + 1}`);
    if (started && /^(---|\.\.\.)\s*$/.test(line)) findings.push(`workflow_not_canonical:document:${i + 1}`);
    if (/^\S/.test(line) && !/^#/.test(line)) started = true;
  });
  const jobsStart = jobsLines[0][1];
  let jobsEnd = jobsStart + 1;
  while (jobsEnd < lines.length && !/^[^\s#]/.test(lines[jobsEnd])) jobsEnd += 1;
  findings.push(...layoutFindings(lines, jobsStart, jobsEnd));
  // Task b5234943, P4: every top-level line is a plain (or simply quoted) key
  // or a bare document marker, so none can be a tagged, anchored, explicit or
  // differently cased second `jobs` key, a merge key or a directive.
  lines.forEach((line, i) => {
    if (!/^[^\s#]/.test(line) || i === jobsStart || /^(---|\.\.\.)(\s+#.*|\s*)$/.test(line)) return;
    const key = /^(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'):(?:\s|$)/.exec(line);
    if (!key || /^jobs$/i.test(key[1] ?? key[2] ?? key[3])) findings.push(`workflow_not_canonical:top_level:${i + 1}`);
  });
  let inJob = false;
  const jobNames = new Set();
  let jobKeys = new Set();
  for (let i = jobsStart + 1; i < jobsEnd; i += 1) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const job = /^  ([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (job) {
      // A second job of the same name replaces the first in lenient parsers.
      if (jobNames.has(job[1])) findings.push(`workflow_not_canonical:duplicate_job:${i + 1}`);
      jobNames.add(job[1]);
      jobKeys = new Set();
      inJob = true;
      continue;
    }
    if (inJob && /^ {4}\S/.test(line)) {
      // Task b5234943, P1, P6 and 7: a job key is plain and written once
      // (`strategy :`, `"strategy":`, `? strategy`, `!!str runs-on:`,
      // `&a needs:` and `!!merge <<:` are refused). A bare `<<:` merge key
      // stays readable here; jobIsHosted and the strategy check refuse it.
      // An indentless `- ` item belongs to the key above it.
      if (/^ {4}-(?: |$)/.test(line)) continue;
      const key = /^ {4}([A-Za-z0-9_-]+|<<):(?:\s|$)/.exec(line);
      if (!key) findings.push(`workflow_not_canonical:job_key:${i + 1}`);
      else if (jobKeys.has(key[1])) findings.push(`workflow_not_canonical:duplicate_job_key:${i + 1}`);
      else jobKeys.add(key[1]);
      continue;
    }
    if (inJob && /^ {5,}\S/.test(line)) continue;
    findings.push(`workflow_not_canonical:job_line:${i + 1}`);
  }
  return [...new Set(findings)];
}

// Task b5234943, P2 to P4: the line reader takes a line's indentation as its
// place in the YAML tree. A quoted scalar or a flow collection written over
// several lines breaks that: YAML reads its later lines as text of the one
// value (lenient parsers at any indentation), so such a line could pass for a
// job, a job key or the end of the jobs block, and one indented four spaces or
// less ends jobField's and strategyRegion's view of a strategy that YAML reads
// on. Inside the jobs block such a line must be indented five spaces or more,
// so it stays inside the job key it started under; elsewhere at least one, so
// it cannot pass for a top-level key. Block scalars and plain multi-line
// scalars are followed as YAML reads them (their lines are text). Explicit
// keys (`? `), block scalars with an indentation indicator, a quote inside an
// unquoted flow item and anything after a closed quote or flow collection
// other than a comment (or a key's `:`) are not read and are refused.
function quoteEnd(line, from, quote) {
  for (let i = from; i < line.length; i += 1) {
    if (quote === '"' && line[i] === "\\") { i += 1; continue; }
    if (line[i] !== quote) continue;
    if (quote === "'" && line[i + 1] === "'") { i += 1; continue; }
    return i + 1;
  }
  return -1;
}
function layoutFindings(lines, jobsStart, jobsEnd) {
  const unread = (i, what) => [`workflow_not_canonical:${what}:${i + 1}`];
  const isComment = (line, i) => line[i] === "#" && (i === 0 || line[i - 1] === " ");
  const restIsEmpty = (line, i) => { while (line[i] === " ") i += 1; return i >= line.length || isComment(line, i); };
  let block = null; // { n, content }: the lines of a block scalar.
  let plain = null; // n: a plain scalar that may go on below.
  let flow = null; // { depth, start, quote, quoted, threshold }: an open quoted scalar or flow collection.
  // Reads a flow collection from line[i] on; returns the index after it, or -1 at the end of the line.
  const scanFlow = (line, i, lineNo) => {
    while (i < line.length) {
      if (flow.quote) {
        const end = quoteEnd(line, i, flow.quote);
        if (end < 0) return -1;
        flow.quote = null;
        flow.start = false;
        flow.quoted = true;
        i = end;
        if (flow.depth === 0) return i;
        continue;
      }
      const ch = line[i];
      if (ch === " ") { i += 1; continue; }
      if (isComment(line, i)) return -1;
      const quoted = flow.quoted;
      flow.quoted = false;
      if (ch === "[" || ch === "{") { flow.depth += 1; flow.start = true; i += 1; continue; }
      if (ch === "]" || ch === "}") {
        flow.depth -= 1;
        flow.start = false;
        i += 1;
        if (flow.depth === 0) return i;
        continue;
      }
      if (ch === ",") { flow.start = true; i += 1; continue; }
      if (ch === '"' || ch === "'") {
        if (!flow.start) throw unread(lineNo, "flow_quote");
        flow.quote = ch;
        i += 1;
        continue;
      }
      if ((ch === ":" || ch === "?") && (quoted || i + 1 >= line.length || /[ ,[\]{}]/.test(line[i + 1]))) {
        flow.start = true;
        i += 1;
        continue;
      }
      if (flow.start && (ch === "|" || ch === ">" || ch === "%" || ch === "@" || ch === "`")) throw unread(lineNo, "flow_item");
      if (flow.start && (ch === "&" || ch === "!" || ch === "*")) {
        while (i < line.length && !/[ ,[\]{}]/.test(line[i])) i += 1;
        flow.start = ch !== "*";
        continue;
      }
      flow.start = false;
      i += 1;
    }
    return -1;
  };
  // Reads one node of a block line from line[i] on; n is the indentation it belongs to.
  const scanNode = (line, i, n, lineNo) => {
    for (;;) {
      while (line[i] === " ") i += 1;
      if (i >= line.length || isComment(line, i)) return;
      const ch = line[i];
      if (ch === "-" && (i + 1 >= line.length || line[i + 1] === " ")) { n = i; i += 1; continue; }
      if ((ch === "?" || ch === ":") && (i + 1 >= line.length || line[i + 1] === " ")) throw unread(lineNo, "explicit_key");
      if (ch === "&" || ch === "!") { while (i < line.length && line[i] !== " ") i += 1; continue; }
      if (ch === "|" || ch === ">") {
        const header = /^[|>]([+-]?)(?:\s+#.*|\s*)$/.exec(line.slice(i));
        if (!header) throw unread(lineNo, "block_scalar");
        block = { n, content: null };
        return;
      }
      if (ch === '"' || ch === "'" || ch === "[" || ch === "{") {
        flow = { depth: 0, start: true, quote: null, quoted: false };
        if (ch === '"' || ch === "'") flow.quote = ch; else flow.depth = 1;
        const end = scanFlow(line, i + 1, lineNo);
        if (end < 0) {
          flow.threshold = lineNo > jobsStart && lineNo < jobsEnd ? 5 : 1;
          return;
        }
        flow = null;
        let j = end;
        while (line[j] === " ") j += 1;
        if (line[j] === ":" && (j + 1 >= line.length || line[j + 1] === " ")) { n = i; i = j + 1; continue; }
        if (!restIsEmpty(line, j)) throw unread(lineNo, "after_value");
        return;
      }
      // A plain scalar, or a plain key when `: ` follows.
      let j = i;
      while (j < line.length && !(line[j] === ":" && (j + 1 >= line.length || line[j + 1] === " ")) && !isComment(line, j)) j += 1;
      if (j < line.length && line[j] === ":") { n = i; i = j + 1; continue; }
      if (j >= line.length) plain = n;
      return;
    }
  };
  try {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const indent = line.length - line.trimStart().length;
      const blank = line.trim() === "";
      if (block) {
        if (blank) continue;
        if (block.content === null ? indent > block.n : indent >= block.content) { block.content ??= indent; continue; }
        block = null;
      }
      if (flow) {
        if (blank) continue;
        if (indent < flow.threshold) return unread(i, "continuation");
        const end = scanFlow(line, 0, i);
        if (end < 0) continue;
        flow = null;
        if (!restIsEmpty(line, end)) return unread(i, "after_value");
        continue;
      }
      if (blank) continue;
      if (plain !== null) {
        if (line.trimStart().startsWith("#")) { plain = null; continue; }
        if (indent > plain) {
          if (/ #/.test(line)) plain = null;
          continue;
        }
        plain = null;
      }
      scanNode(line, 0, indent, i);
    }
  } catch (error) {
    if (Array.isArray(error)) return error;
    throw error;
  }
  return flow ? unread(lines.length - 1, "continuation") : [];
}

// A job's literal timeout-minutes, or null when it has none or an expression.
export function jobTimeout(job) {
  const value = jobField(job, "timeout-minutes");
  if (value === null) return null;
  // Re-review 7, n2: a comment needs whitespace before its #, as in YAML.
  const match = /^\s*(\d{1,4})(\s+#.*|\s*)$/.exec(value.split("\n")[0]);
  return match && value.split("\n").slice(1).every((line) => /^\s*(#.*)?$/.test(line)) ? Number(match[1]) : null;
}

// A job counts as GitHub-hosted with one literal ubuntu-*, windows-* or
// macos-* label, or the exact state_change choice between two fixed hosted
// labels below. It must neither call a reusable workflow nor merge YAML
// anchors. Every other expression may reach a self-hosted runner.
const HOSTED_LABEL = /^(ubuntu|windows|macos)-[A-Za-z0-9.-]+$/;
const HOSTED_STATE_CHANGE_RUNNER = "${{ inputs.reason == 'state_change' && 'ubuntu-latest' || 'ubuntu-slim' }}";
export function jobIsHosted(job) {
  if (job.lines.some((line) => /^ {4}uses:/.test(line) || /^\s*<<\s*:/.test(line))) return false;
  // Task b5234943: one runs-on key in its own spelling; a second one in
  // another case, a uses key in another case, or a job key that is not plain
  // (tagged, anchored, quoted, explicit or a tagged merge) is not hosted.
  const runners = job.lines.filter((line) => /^ {4}(?:runs-on|uses)\s*:/i.test(line));
  if (runners.length !== 1 || !runners[0].startsWith("    runs-on:") ||
    job.lines.some((line) => /^ {4}[^\sA-Za-z0-9_#-]/.test(line) || /!!merge|tag:yaml\.org,2002:merge/.test(line))) return false;
  const value = jobField(job, "runs-on");
  if (value === null) return false;
  const text = value.replace(/(^|\s)#.*$/gm, "").trim();
  if (text.includes("\n")) return false;
  return HOSTED_LABEL.test(unquote(text)) || text === HOSTED_STATE_CHANGE_RUNNER;
}

// A job's strategy as a tree, or null when it is not in the one plain block
// form read here: mapping keys, `- ` items, and one-line values that are a
// plain or simply quoted scalar or a flow list of simple scalars. Blank and
// whole-line comment lines carry no value and are dropped (at any indent, as
// in YAML). Anchors, aliases, tags, merge keys, block or multi-line scalars,
// flow mappings, inline comments, a bare `-`, a duplicate key, uneven
// indentation and whitespace other than spaces are not read, nor is a job
// with a strategy key written in another case or given twice, or any job key
// that does not start with a plain key character (quoted, tagged, anchored).
const STRATEGY_KEY = /^([A-Za-z0-9_-]+):(?: +(.+))?$/;
const STRATEGY_MAX_DEPTH = 32;
const STRATEGY_PLAIN = /^(?:[^ [\]{},#&*!|>'"%@`?:-]|-[^ ])/;
const STRATEGY_FLOW_ITEM = /^(?:(?!-$)[A-Za-z0-9_./+-]+|"[^"\\,[\]{}]*"|'[^',[\]{}]*')$/;
function strategyValue(text) {
  if (/^"[^"\\]*"$|^'[^']*'$/.test(text)) return { scalar: text };
  const flow = /^\[(.*)\]$/.exec(text);
  if (flow) {
    const items = flow[1].split(",").map((item) => item.trim());
    return items.every((item) => STRATEGY_FLOW_ITEM.test(item)) ? { flow: items } : null;
  }
  return STRATEGY_PLAIN.test(text) && !/:( |$)| #/.test(text) ? { scalar: text } : null;
}
function strategyTree(job) {
  const keyLines = job.lines.filter((line) => /^ {4}(?:[^\sA-Za-z0-9_#-]|strategy\s*:)/i.test(line));
  if (keyLines.length !== 1 || !/^ {4}strategy: *$/.test(keyLines[0]) ||
    job.lines.some((line) => /^ *(?:- +)?<<\s*:/.test(line))) return null;
  const rows = [];
  for (const line of job.lines.slice(job.lines.indexOf(keyLines[0]) + 1)) {
    if (/[^\S ]/.test(line) || HIDDEN_LINE_BREAK.test(line)) return null;
    if (/^ *(#.*)?$/.test(line)) continue;
    if (!line.startsWith("     ")) break;
    // Only spaces are left as whitespace here, so trim() strips exactly those
    // (a / +$/ replace is quadratic on a long run of spaces).
    const text = line.trimEnd();
    const indent = text.length - text.trimStart().length;
    rows.push({ indent, text: text.slice(indent) });
  }
  let i = 0;
  const unread = new Error("strategy not read");
  // Task b5234943, item 8: nesting is read to a fixed depth (a strategy has a
  // few levels), so a deep one is unread rather than a stack overflow.
  let depth = 0;
  const block = (indent) => {
    if (++depth > STRATEGY_MAX_DEPTH) throw unread;
    const node = rows[i].text.startsWith("- ") ? { seq: [] } : { map: [] };
    const names = new Set();
    while (i < rows.length && rows[i].indent === indent) {
      if (node.seq) {
        if (!rows[i].text.startsWith("- ")) throw unread;
        const rest = rows[i].text.slice(2);
        if (STRATEGY_KEY.test(rest)) {
          // `- key: ...` opens a mapping whose keys sit two columns in.
          rows[i] = { indent: indent + 2, text: rest };
          node.seq.push(block(indent + 2));
        } else {
          const value = strategyValue(rest);
          if (!value) throw unread;
          node.seq.push(value);
          i += 1;
        }
      } else {
        const key = STRATEGY_KEY.exec(rows[i].text);
        if (!key || names.has(key[1])) throw unread;
        names.add(key[1]);
        i += 1;
        if (key[2] === undefined) {
          if (i >= rows.length || rows[i].indent <= indent) throw unread;
          node.map.push([key[1], block(rows[i].indent)]);
        } else {
          const value = strategyValue(key[2]);
          if (!value) throw unread;
          node.map.push([key[1], value]);
        }
      }
      if (i < rows.length && rows[i].indent > indent) throw unread;
    }
    depth -= 1;
    return node;
  };
  try {
    if (!rows.length) return null;
    const tree = block(rows[0].indent);
    return i === rows.length && tree.map ? tree : null;
  } catch (error) {
    if (error === unread || error instanceof RangeError) return null;
    throw error;
  }
}

// Task b5234943, P1, 5, 6 and 7: every place a job could hold a strategy that
// YAML reads and jobField or strategyRegion do not: each job key that is not
// a plain key (a merge key above all) or is `strategy` in any spelling or
// case, with the lines that belong to it as in strategyRegion, and indentless
// `- ` items after it. workflowFormFindings refuses most of these spellings
// at the head; the base may still hold them.
const STRATEGY_KEY_LINE = /^ {4}(?:[^\sA-Za-z0-9_#-]|strategy\s*:)/i;
function strategyRegions(job) {
  const regions = [];
  for (let start = 0; start < job.lines.length; start += 1) {
    if (!STRATEGY_KEY_LINE.test(job.lines[start])) continue;
    let end = start + 1;
    while (end < job.lines.length && (/^\s*(#.*)?$/.test(job.lines[end]) || job.lines[end].startsWith("     ") ||
      /^ {4}-(?: |$)/.test(job.lines[end]))) end += 1;
    while (end > start + 1 && /^\s*(#.*)?$/.test(job.lines[end - 1])) end -= 1;
    regions.push(job.lines.slice(start, end).join("\n"));
  }
  return regions.join("\n\u0000\n");
}

// Item 5: an alias in a strategy region names a node written elsewhere in the
// file, so equal text does not mean an equal strategy. Any `*name` that may be
// an alias (outside whole-line comments) counts.
function strategyHasAlias(regions) {
  return regions.split("\n").some((line) => !/^\s*#/.test(line) && /(?:^|[\s[{,:])\*[^\s,[\]{}]/.test(line));
}

// The lines of a job's strategy as YAML reads them, or null without one.
// Bootstrap review 11af4710, finding 1: jobField ends the field at the first
// comment line indented four spaces or less, but YAML ignores the indentation
// of comments, so entries after such a line still belong to the strategy. The
// region runs from the strategy key to the first other line indented less
// than five spaces, comment and blank lines inside it included; trailing ones
// carry nothing and are left out.
function strategyRegion(job) {
  const start = job.lines.findIndex((line) => line.startsWith("    strategy:"));
  if (start < 0) return null;
  let end = start + 1;
  while (end < job.lines.length && (/^\s*(#.*)?$/.test(job.lines[end]) || job.lines[end].startsWith("     "))) end += 1;
  while (end > start + 1 && /^\s*(#.*)?$/.test(job.lines[end - 1])) end -= 1;
  return job.lines.slice(start, end).join("\n");
}

// Owner Decision 586181ec: true only when the head job's strategy is the base
// job's with entries removed and nothing else changed. Entries may go from
// matrix.include, or from a matrix axis list when the matrix has no include:
// a removed axis value could turn an include entry that extended its
// combinations into new combinations of its own. Each changed list keeps at
// least one entry and the rest in their order (an include entry may overwrite
// values an earlier one added, so a reorder is a change). Keys, their order,
// every other value, exclude, fail-fast and max-parallel stay as they are. A
// change of comments or blank lines alone removes nothing and stays a change.
function strategyShrinks(job, old) {
  const head = strategyTree(job);
  const base = strategyTree(old);
  if (!head || !base) return false;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const keys = (node) => node.map.map(([key]) => key);
  if (!same(keys(head), keys(base))) return false;
  let removed = 0;
  for (const [i, [key, was]] of base.map.entries()) {
    const now = head.map[i][1];
    if (same(was, now)) continue;
    if (key !== "matrix" || !was.map || !now.map || !same(keys(was), keys(now))) return false;
    // `Include` or `EXCLUDE` would be an axis to GitHub; refuse rather than guess.
    if (keys(was).some((name) => /^(?:in|ex)clude$/i.test(name) && name !== name.toLowerCase())) return false;
    const hasInclude = keys(was).includes("include");
    for (const [j, [list, entries]] of was.map.entries()) {
      const kept = now.map[j][1];
      if (same(entries, kept)) continue;
      if (list === "exclude" || (list !== "include" && hasInclude)) return false;
      const kind = entries.seq ? "seq" : entries.flow ? "flow" : null;
      const from = kind && entries[kind];
      const to = kind && kept[kind];
      if (!to || to.length < 1 || to.length >= from.length) return false;
      // The kept entries, in their order, are a subsequence of the base's.
      // Each entry is serialized once, so a large one is not compared again and again.
      const fromText = from.map((entry) => JSON.stringify(entry));
      let k = 0;
      for (const entry of to.map((item) => JSON.stringify(item))) {
        while (k < fromText.length && fromText[k] !== entry) k += 1;
        if (k === fromText.length) return false;
        k += 1;
      }
      removed += from.length - to.length;
    }
  }
  return removed > 0;
}

// Findings for one workflow at the PR head; baseText is its base-branch
// version, or null when the PR adds it. Existing ungated workflows (the
// short checks of Owner Decision 75abfe80) stay ungated.
export function gateFindings(headText, baseText, { registeredPublisherTransition = false, registeredPlacementTransition = false, registeredControlTransition = false, registeredBootstrapOrdinaryTransition = false } = {}) {
  const form = workflowFormFindings(headText);
  if (form.length) return form;
  // Only the trusted-main exact-pair caller may set this Source classification.
  // A controller remains ungated to avoid waiting on its own admission result.
  if(registeredControlTransition===true){
    if(baseText===null||workflowIsGated(baseText)||workflowIsGated(headText))return ['controller_Source_expected_ungated'];
    return [];
  }
  const jobs = workflowJobs(headText);
  const selfHosted = jobs.some((job) => !jobIsHosted(job));
  const required = baseText === null ? selfHosted : workflowIsGated(baseText) ||
    ((registeredPublisherTransition === true || registeredPlacementTransition === true || registeredBootstrapOrdinaryTransition === true) && workflowIsGated(headText));
  if (!required) {
    // An existing ungated workflow (a short check) may not grow a job that can
    // reach a self-hosted runner: no new one, no hosted job moved to a
    // self-hosted runner, and (re-review 3, N-R5) no self-hosted job that
    // drops or raises its timeout-minutes.
    if (baseText === null) return [];
    // Task b5234943, P3: a base the line reader does not follow (a flow or
    // quoted value running over lines indented four spaces or less, say) may
    // hold a strategy it does not see, so no self-hosted strategy counts as
    // unchanged against it.
    const baseUnread = workflowFormFindings(baseText).length > 0;
    const before = new Map(workflowJobs(baseText).map((job) => [job.name, job]));
    const findings = [];
    for (const job of jobs) {
      if (jobIsHosted(job)) continue;
      const old = before.get(job.name);
      if (!old) findings.push(`self_hosted_job_added_ungated:${job.name}`);
      else if (jobIsHosted(old)) findings.push(`self_hosted_job_switched_ungated:${job.name}`);
      else {
        const was = jobTimeout(old);
        const now = jobTimeout(job);
        if (now === null || (was !== null && now > was)) findings.push(`self_hosted_timeout_raised_ungated:${job.name}`);
        // Re-review 4, m3: a new or changed strategy (a matrix) multiplies the
        // job; one admitted head would buy many self-hosted runs. Owner
        // Decision 586181ec: a strategy that only loses matrix entries runs the
        // job fewer times and passes (strategyShrinks). A change counts in
        // jobField's view or in the whole region (strategyRegion).
        // Task b5234943: also every other spelling of a strategy key and every
        // merge key (strategyRegions), a strategy that names an alias, and any
        // strategy against a base not read with certainty.
        const regions = strategyRegions(job);
        // Review of b5234943 (M1): a base not read with certainty, or a strategy naming an alias, is never
        // excused as a shrink: the line reader may have seen a matrix the base never had.
        if (baseUnread || strategyHasAlias(regions) ||
          (((jobField(job, "strategy") ?? "").trim() !== (jobField(old, "strategy") ?? "").trim() ||
          strategyRegion(job) !== strategyRegion(old) || regions !== strategyRegions(old)) && !strategyShrinks(job, old))) {
          findings.push(`self_hosted_strategy_changed_ungated:${job.name}`);
        }
      }
    }
    return findings;
  }
  const gate = jobs.find((job) => job.name === GATE_JOB);
  if (!gate) return ["admission_gate_missing"];
  const findings = [];
  if (!GATE_JOB_SHA256.has(sha256Hex(gate.lines.join("\n")))) findings.push("admission_gate_changed");
  for (const job of jobs) {
    if (job.name === GATE_JOB) continue;
    if (!jobNeeds(job).includes(GATE_JOB)) findings.push(`job_not_gated:${job.name}`);
    else if (!gateConditionHolds(jobCondition(job))) findings.push(`job_condition_not_gated:${job.name}`);
  }
  return findings;
}

async function fileAt(fetchImpl, env, repository, path, ref) {
  const body = await githubJson(fetchImpl, env,
    `/repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, { allowMissing: true });
  if (!body) return null;
  if (typeof body.content !== "string") throw new Error(`${path}@${ref} has no inline content.`);
  return Buffer.from(body.content, "base64").toString("utf8");
}

// The base version a changed workflow is compared with. Re-review 7, MAJOR-2:
// a file renamed into .github/workflows/ from anywhere else, or copied, is a
// new workflow; only a rename between two workflow files keeps its base.
export function workflowBasePath(file) {
  if (file.status === "added" || file.status === "copied") return null;
  if (file.status === "renamed") return WORKFLOW_FILE.test(file.previous_filename ?? "") ? file.previous_filename : null;
  return file.filename;
}

// Workflow findings of a pull request: `gate` are refused outright (the gate
// guard above), `owner` need an Owner Grant on the head commit (ownerReviewFindings).
export async function workflowFindings(fetchImpl, env, repository, files, headSha, baseSha) {
  const gate = [];
  const owner = [];
  for (const file of files) {
    if (file.status === "removed" || !WORKFLOW_FILE.test(file.filename ?? "")) continue;
    const head = await fileAt(fetchImpl, env, repository, file.filename, headSha);
    if (head === null) throw new Error(`${file.filename} is missing at ${headSha}.`);
    const basePath = workflowBasePath(file);
    const base = basePath === null ? null : await fileAt(fetchImpl, env, repository, basePath, baseSha);
    if(Object.hasOwn(PUBLISHER_PR_QUALIFICATION_FILES,file.filename)&&
      (!['added','modified'].includes(file.status)||
        file.status==='modified'&&basePath!==file.filename||
        !registeredPublisherPrQualificationTransition(trustedPublisherPrQualificationProfiles(),file.filename,head,base,{repository}).passed)) {
      gate.push(`workflow_gate:${file.filename}:publisher_PR_qualification_Source_not_registered`);
    }
    const controlKnown=Object.hasOwn(CONTROL_WORKFLOW_FILES,file.filename)||Object.hasOwn(CONTROL_WORKFLOW_FILES,file.previous_filename??'');
    const controlSource=controlKnown?registeredControlWorkflowTransition(trustedControlProfiles(),file.filename,head,base,{repository,change:file}):null;
    if(controlKnown&&!controlSource.passed)gate.push(`workflow_gate:${file.filename}:control_Source_not_registered`);
    const registeredPublisherTransition = file.filename === PRODUCTION_PUBLISHER_WORKFLOW &&
      registeredPublisherGatedSuccessor(file, head, base, trustedPublisherProfiles());
    const placement=(file.filename===PLACEMENT_WORKFLOW || file.previous_filename===PLACEMENT_WORKFLOW) &&
      (workflowIsGated(head) || base!==null && workflowIsGated(base));
    const placementSource=placement?registeredPlacementSuccessor({file,headText:head,baseText:base,
      ...trustedPlacementCatalogues()}):null;
    if(placement && !placementSource.passed)gate.push(`workflow_gate:${file.filename}:placement_Source_not_registered`);
    const ordinaryKnown=bootstrapOrdinaryKnownFile(file.filename)||bootstrapOrdinaryKnownFile(file.previous_filename);
    const ordinaryRequired=ordinaryKnown&&(workflowIsGated(head)||base!==null&&workflowIsGated(base));
    const ordinarySource=ordinaryRequired?registeredBootstrapOrdinarySuccessor({file,headText:head,baseText:base,...trustedPlacementCatalogues()}):null;
    if(ordinaryRequired&&!ordinarySource.passed)gate.push(`workflow_gate:${file.filename}:bootstrap_ordinary_Source_not_registered`);
    for (const finding of gateFindings(head, base, { registeredControlTransition:controlSource?.passed===true, registeredPublisherTransition,
      registeredPlacementTransition:placementSource?.registeredPlacementTransition===true,
      registeredBootstrapOrdinaryTransition:ordinarySource?.registeredBootstrapOrdinaryTransition===true })) {
      gate.push(`workflow_gate:${file.filename}:${finding}`);
    }
    for (const finding of ownerReviewFindings(head, base)) owner.push(`${file.filename}:${finding}`);
  }
  // A workflow the pull request deletes or renames away may be the one that
  // holds a guard (an environment, the release door): its removal is owner-reviewed too.
  for (const file of files) {
    const gone = file.status === "removed" ? file.filename : file.status === "renamed" ? file.previous_filename : null;
    if (!gone || !WORKFLOW_FILE.test(gone) || (file.status === "renamed" && WORKFLOW_FILE.test(file.filename ?? ""))) continue;
    const base = await fileAt(fetchImpl, env, repository, gone, baseSha);
    if (base !== null && workflowHasEnvironment(base)) owner.push(`${gone}:environment_workflow_removed`);
  }
  return { gate, owner };
}

export async function workflowGateFindings(fetchImpl, env, repository, files, headSha, baseSha) {
  return (await workflowFindings(fetchImpl, env, repository, files, headSha, baseSha)).gate;
}

// Merge Admission v0.1 §3.3, review MAJOR-1: a broken policy file on the
// default branch judges every pull request as frozen. A pull request that
// changes the file is refused outright, as the workflow guard refuses a
// workflow, when its head's file would not load or when it removes the file.
// The head's file is checked with the default branch's loadPolicy, so a new
// schema is a two-step change: first a loader that accepts it, then the file.
export async function policyFileFindings(fetchImpl, env, repository, files, headSha) {
  const findings = [];
  for (const file of files) {
    if (file.filename !== POLICY_PATH && file.previous_filename !== POLICY_PATH) continue;
    // A copy of the file elsewhere leaves it as it is.
    if (file.status === "copied" && file.filename !== POLICY_PATH) continue;
    if (file.status === "removed" || file.filename !== POLICY_PATH) {
      findings.push(`policy_file_removed:${POLICY_PATH}`);
      continue;
    }
    const text = await fileAt(fetchImpl, env, repository, POLICY_PATH, headSha);
    const { errors } = text === null ? { errors: ["missing at the head"] } : loadPolicy(text);
    if (errors.length) findings.push(`policy_file_invalid:${errors[0]}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ""}`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Owner review (re-review 7, MAJOR-3; re-review 8, Owner Decision f2bf949a).
// The main ruleset requires no approving review, so whatever the admission
// check admits can be merged by an Agent, and a merged change to the code that
// guards production applies to every later run: it could drop the release
// door's grant step, read the clued-release or clued-admission environment's
// secrets, point admission at another server or give a self-hosted workflow a
// schedule. A pull request that changes any PROTECTED_PATHS entry is admitted
// only with an Owner Grant of repo.protected_change on its exact head commit
// (OwnerCredential §6.3), asked of Clued's admission door with the admission
// Binding. Always enforced (until Merge Admission step 6 the Owner's switch
// CLUED_OWNER_REVIEW_ENFORCE could reduce it to a notice).
// Re-review 8, MAJOR-1/2: the decision is by path only. Reading a workflow's
// environments, secrets and triggers line by line missed YAML escapes,
// explicit keys and aliases, and the admission job's own tests ran with its
// keys; ownerReviewFindings now only adds hints to the summary.
//
// Not covered, and written down (WorkClaimAdmission §4.7): code outside these
// paths that a job with secrets imports or builds (the Worker source), the
// repository-level secrets and hosted minutes (any branch can add an on: push
// workflow), and anyone holding the repository's admin rights.

export const OWNER_REVIEW_ACTION = "repo.protected_change";
export const OWNER_REVIEW_RPC = "clued_owner_grant_admission_door_v1";
// The protected paths: the merge admission policy's CORE_PROTECTED_PATHS
// (merge-admission-policy.mjs) and the policy file itself. The policy can add
// more (effectiveProtectedPaths), never remove any; the name stays for the
// references to it.
export const PROTECTED_PATHS = Object.freeze(effectiveProtectedPaths(null));

export function protectedPathFindings(paths, protectedPaths = effectiveProtectedPaths(null)) {
  const patterns = protectedPaths.map((pattern) => [pattern, globToRegExp(pattern)]);
  const findings = [];
  for (const changed of paths) {
    const hit = patterns.find(([, regex]) => regex.test(changed));
    if (hit) findings.push(`protected_path:${changed}`);
  }
  return findings;
}

// A YAML comment starts at a # that follows whitespace (or starts the line)
// outside quotes.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function codeLines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split("\n").map(stripComment);
}

// Any environment key, quoted or not, block or flow; or an anchor merge,
// which could carry one.
export function workflowHasEnvironment(text) {
  return codeLines(text).some((line) => /["']?\benvironment\b["']?\s*:/.test(line) || /<<\s*:/.test(line));
}

// The secrets a workflow names; "*" when it reads them by a computed name,
// passes them all on, or serializes them.
export function workflowSecrets(text) {
  const names = new Set();
  for (const line of codeLines(text)) {
    for (const match of line.matchAll(/\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
    if (/\bsecrets\s*\[|toJSON\s*\(\s*secrets\s*\)|secrets\s*:\s*inherit|\bsecrets\s*[),}]/.test(line)) names.add("*");
  }
  names.delete("GITHUB_TOKEN");
  return names;
}

// The top-level `on:` block (or `true:`, the same key in YAML 1.1), comments
// and blank lines dropped.
export function workflowTriggers(text) {
  const lines = codeLines(text);
  const start = lines.findIndex((line) => /^["']?(on|true)["']?\s*:/.test(line));
  if (start < 0) return "";
  const block = [lines[start].trim()];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i += 1) {
    if (lines[i].trim()) block.push(lines[i].trimEnd());
  }
  return block.join("\n");
}

const PR_ONLY_TRIGGERS = /^(on|true)\s*:\s*(\[\s*)?(pull_request|workflow_dispatch)(\s*,\s*(pull_request|workflow_dispatch))*(\s*\])?\s*$/;
function triggersArePrOnly(triggers) {
  const [first, ...rest] = triggers.split("\n");
  if (PR_ONLY_TRIGGERS.test(first.replace(/["']/g, ""))) return rest.length === 0;
  if (!/^["']?(on|true)["']?\s*:\s*$/.test(first)) return false;
  const keys = rest.filter((line) => /^  \S/.test(line)).map((line) => line.trim().replace(/["']/g, "").replace(/:.*$/, ""));
  return keys.length > 0 && keys.every((key) => key === "pull_request" || key === "workflow_dispatch");
}

// Findings for one workflow that need the Owner; baseText is null for a new one.
export function ownerReviewFindings(headText, baseText) {
  const findings = [];
  if (workflowHasEnvironment(headText) || (baseText !== null && workflowHasEnvironment(baseText))) {
    findings.push("environment_workflow_changed");
  }
  const before = baseText === null ? new Set() : workflowSecrets(baseText);
  const added = [...workflowSecrets(headText)].filter((name) => !before.has(name)).sort();
  for (const name of added) findings.push(`secret_added:${name}`);
  if (workflowJobs(headText).some((job) => !jobIsHosted(job))) {
    const triggers = workflowTriggers(headText);
    if (baseText === null ? !triggersArePrOnly(triggers) : triggers !== workflowTriggers(baseText)) {
      findings.push("self_hosted_triggers_changed");
    }
  }
  return findings;
}

// Task 2b2359da: the door can exceed the anon role's 3 s statement timeout
// (500, code 57014) on a fresh database connection. A cancelled call rolls
// back as a whole and the door is idempotent (it reuses the pending request
// and replays a grant use), so that one error is retried, twice at most.
export const DOOR_RETRY_DELAYS_MS = Object.freeze([2000, 4000]);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ownerReviewDoor(fetchImpl, env, repository, headSha, workspace, note,
  { delays = DOOR_RETRY_DELAYS_MS, sleep = sleepMs } = {}) {
  const { url: base, key } = resolvePublicSupabaseConfig(env, workspace);
  const resource = `repo:${repository}/${headSha}`;
  let response;
  let text = "";
  let body = null;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetchImpl(`${base}/rest/v1/rpc/${OWNER_REVIEW_RPC}`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "clued-work-admission",
      },
      body: JSON.stringify({ p_token_hash: sha256Hex(env.CLUED_CONTEXT_READ_TOKEN),
        p_input: { action: OWNER_REVIEW_ACTION, resources: [resource], ...(note ? { note } : {}) } }),
    });
    text = "";
    body = null;
    try {
      text = await response.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const timedOut = response.status === 500 && body && body.code === "57014";
    if (!timedOut || attempt >= delays.length) break;
    await sleep(delays[attempt]);
  }
  const detail = describe(response.status, body, text, response.headers);
  if (response.status === 404 && body && body.code === "PGRST202") return { kind: "rpc_unavailable", detail, resource };
  // Re-review 9, MINOR-4: a server or gateway error says nothing about the
  // pull request; the hourly re-verification must not turn a check red for it.
  if (response.status >= 500 || response.status === 429) return { kind: "transient", detail, resource };
  if (response.status !== 200 || !body || body.status !== "ok") return { kind: "refused", detail, resource };
  const request = body.owner_request;
  const confirmUrl = request && typeof request.confirm_path === "string"
    ? (env.CLUED_CONFIRM_ORIGIN ?? DEFAULT_CONFIRM_ORIGIN).replace(/\/$/, "") + request.confirm_path : null;
  return { kind: body.admitted === true ? "granted" : "pending", resource, grant: body.grant ?? null, confirm_url: confirmUrl };
}
const DEFAULT_CONFIRM_ORIGIN = "https://kooyumi.pixelgrav.com";

// ---------------------------------------------------------------------------
// Clued database RPC (PostgREST, publishable key, Binding token hash).

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function describe(status, body, text, headers) {
  const parts = [];
  if (body && typeof body === "object") {
    const fields = ["code", "message", "details", "hint"].map((k) => (body[k] ? `${k}=${body[k]}` : null)).filter(Boolean);
    if (fields.length) parts.push(fields.join(" "));
  } else if (text) {
    parts.push(text.replace(/\s+/g, " ").slice(0, 300));
  }
  const diag = ["server", "cf-ray", "www-authenticate", "content-type"]
    .map((k) => (headers && typeof headers.get === "function" && headers.get(k) ? `${k}=${headers.get(k)}` : null))
    .filter(Boolean)
    .join(" ");
  if (diag) parts.push(`[${diag}]`);
  return `${status}${parts.length ? `: ${parts.join(" ")}` : ""}`;
}

// Returns one of:
//   { kind: "verdict", verdict, reasons, payload }
//   { kind: "rpc_unavailable", detail }   the function is not deployed (PGRST202)
//   { kind: "refused", detail }           the database refused the Binding or input
// and throws on transport failures or unexpected answers.
export async function verifyClaim(fetchImpl, env, args, workspace) {
  const { url: base, key } = resolvePublicSupabaseConfig(env, workspace);
  const response = await fetchImpl(`${base}/rest/v1/rpc/${VERIFY_RPC}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "clued-work-admission",
    },
    body: JSON.stringify({ p_token_hash: sha256Hex(env.CLUED_CONTEXT_READ_TOKEN), p_input: args }),
  });
  let text = "";
  let body = null;
  try {
    text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const detail = describe(response.status, body, text, response.headers);
  if (response.status === 404 && body && body.code === "PGRST202") return { kind: "rpc_unavailable", detail };
  if (response.status === 401 || response.status === 403 || (response.status === 400 && body && typeof body.code === "string")) {
    return { kind: "refused", detail };
  }
  if (response.status !== 200 || !body || typeof body !== "object") {
    throw new Error(`Clued ${VERIFY_RPC} returned ${detail}`);
  }
  if (body.status === "rejected") return { kind: "refused", detail: `${response.status}: error_code=${body.error_code ?? "unknown"}` };
  if (body.verdict !== "ADMITTED" && body.verdict !== "REJECTED") throw new Error(`Clued ${VERIFY_RPC} returned no verdict (${detail}).`);
  return { kind: "verdict", verdict: body.verdict, reasons: Array.isArray(body.reasons) ? body.reasons : [], payload: body };
}

// ---------------------------------------------------------------------------
// Evaluation.

// enforced is always true since Merge Admission step 6; it stays in the
// outcome for the `enforced` output of the registered admission-gate job.
function emptyOutcome(eventName) {
  return {
    mode: null, event: eventName, admitted: false, enforced: true, verdict: null, reasons: [], notices: [],
    claim_id: null, scope: null, head_sha: null, base_sha: null, pr_ref: null, changed_paths: [],
    applicable_workflows: [], error: null, admission_mode: null,
  };
}

async function summarizeWorkflows(fetchImpl, env, repository, headSha, changedPaths, workspace, outcome) {
  const triggers = readWorkflowTriggers(workspace);
  let runsByPath = new Map();
  try {
    const runs = await githubPaged(fetchImpl, env, `/repos/${repository}/actions/runs?head_sha=${headSha}&event=pull_request`, "workflow_runs");
    runsByPath = new Map(runs.map((run) => [run.path, run]));
  } catch (error) {
    outcome.reasons.push(`workflow runs unavailable: ${error.message}`);
  }
  outcome.applicable_workflows = triggers.map((workflow) => {
    const decision = workflowApplies(workflow.pull_request, changedPaths);
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

// Re-review 7, MAJOR-3: a pull request with owner-review findings needs an
// Owner Grant on its head commit; anything short of a grant rejects it.
// Path names come from the pull request: only plain characters reach the
// summary, the Owner's note and the check (re-review 10 MINOR-1, re-review 11 NIT).
export function plainFinding(finding) {
  return String(finding).replace(/[^A-Za-z0-9._/*:() -]/g, "?").slice(0, 160);
}

// Merge Admission v0.1: asked whenever the rules say owner_grant: required. In
// frozen a pull request outside the protected layer is asked too (frozenLayer
// names its layer in the Owner's note), and no approval is carried over
// (carryOver false), so every head needs its own grant.
async function ownerReview(fetchImpl, env, repository, pr, workspace, findings, outcome, tipCompare,
  { protectedPaths, carryOver = true, frozenLayer = null } = {}) {
  const baseTip = tipCompare ? tipCompare.tip : null;
  const headSha = pr.head.sha;
  const summary = findings.slice(0, 10).map(plainFinding).join(", ") + (findings.length > 10 ? `, and ${findings.length - 10} more` : "");
  // Owner Decision a0d93cd0: the base branch merged into an approved head.
  let source = null;
  if (carryOver) {
    try {
      source = await carriedApprovalSource(fetchImpl, env, repository, headSha, tipCompare, protectedPaths);
    } catch (error) {
      outcome.notices.push(`owner_review_carry_over_unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (source) {
    const carryNote = `${outcome.pr_ref ?? repository} @ ${source.slice(0, 12)}: earlier head of this pull request; its approval would carry over to ${headSha.slice(0, 12)}, which only merged ${pr.base.ref} into it`.slice(0, 2000);
    let carried;
    try {
      carried = await ownerReviewDoor(fetchImpl, env, repository, source, workspace, carryNote);
    } catch (error) {
      carried = { kind: "transient", detail: error instanceof Error ? error.message : String(error) };
    }
    if (carried.kind === "granted" || carried.kind === "transient") {
      outcome.owner_review = { kind: carried.kind, resource: carried.resource ?? null, confirm_url: null,
        grant_id: carried.grant && carried.grant.grant_id ? carried.grant.grant_id : null, carried_from: source };
      if (carried.kind === "granted") {
        outcome.notices.push(`owner_review_carried:${outcome.owner_review.grant_id} from ${source} (${summary})`);
        return;
      }
      outcome.verdict = "REJECTED";
      outcome.reasons.push(`owner_review_unavailable:transient (${summary}; ${carried.detail})`);
      return;
    }
    outcome.notices.push(`owner_review_not_carried: ${source} is not admitted by a live Owner Grant (${carried.kind})`);
  }
  // Re-review 8, MINOR-3; re-review 9, MAJOR-2: the request tells the Owner
  // which pull request and which changes it is for, with the compare link of
  // the pushed commits (the confirmation page marks this note as written by
  // the admission check, not by an Agent).
  // Re-review 10, MINOR-1: path names come from the pull request, so they are
  // reduced to plain characters and only counted beyond the first ten; the
  // compare link is the record of what changed.
  const listed = findings.slice(0, 10)
    .map((finding) => finding.replace(/^protected_path:/, "").replace(/[^A-Za-z0-9._/*-]/g, "?").slice(0, 120)).join(", ");
  // Re-review 11, NIT: compared with the tip the pull request must contain.
  const compare = `https://github.com/${repository}/compare/${baseTip ?? pr.base.sha}...${headSha}`;
  const note = (frozenLayer
    ? `${outcome.pr_ref ?? repository} @ ${headSha.slice(0, 12)}: merge admission is frozen, so this ${frozenLayer}-layer change of ${outcome.changed_paths.length} path(s) needs an Owner Grant too, see ${compare}`
    : `${outcome.pr_ref ?? repository} @ ${headSha.slice(0, 12)}: ${findings.length} protected path(s) changed, see ${compare} (${listed}${findings.length > 10 ? `, and ${findings.length - 10} more` : ""})`).slice(0, 2000);
  let door;
  try {
    door = await ownerReviewDoor(fetchImpl, env, repository, headSha, workspace, note);
  } catch (error) {
    door = { kind: "transient", detail: error instanceof Error ? error.message : String(error) };
  }
  outcome.owner_review = { kind: door.kind, resource: door.resource ?? null, confirm_url: door.confirm_url ?? null,
    grant_id: door.grant && door.grant.grant_id ? door.grant.grant_id : null };
  if (door.kind === "granted") {
    outcome.notices.push(`owner_review_granted:${outcome.owner_review.grant_id} (${summary})`);
    return;
  }
  outcome.verdict = "REJECTED";
  outcome.reasons.push(door.kind === "pending"
    ? `owner_review_required (${summary}); ask the Owner to approve ${door.confirm_url ?? "the pending request"}`
    : `owner_review_unavailable:${door.kind} (${summary}; ${door.detail})`);
}

// Re-review 9 MAJOR-1, re-review 10 MAJOR-1/2 (Owner Decision 5a3b4935): a
// pull request's file list is relative to a merge base that stays put while
// main moves on, so a branch could carry a change to a protected path that
// cancels out against an older main and comes back once main has moved, and a
// grant on its head would keep admitting it. Two rules close this:
//   - the protected paths are read from the pull request's files and from
//     the compare of the base branch's current tip with the head (whose merge
//     base moves with main), and
//   - a pull request with protected paths must contain that tip (the head is
//     ahead of it, or is it), so merging it yields exactly the head the Owner
//     approved. When main moves, the next evaluation (a push to main runs the
//     re-verification) refuses it until main is merged in: a new head, a new
//     grant.
export const BASE_COMPARE_LIMIT = 300;
export async function baseTipCompare(fetchImpl, env, repository, pr) {
  const branch = await githubJson(fetchImpl, env, `/repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}`);
  const tip = branch && branch.commit && branch.commit.sha;
  if (typeof tip !== "string" || !/^[0-9a-f]{40}$/.test(tip)) throw new Error(`the tip of ${pr.base.ref} could not be read`);
  if (tip === pr.head.sha) return { tip, upToDate: true, paths: [], truncated: false };
  const body = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${tip}...${pr.head.sha}`);
  const files = body && Array.isArray(body.files) ? body.files : [];
  const paths = new Set();
  for (const file of files) {
    if (typeof file.filename === "string") paths.add(file.filename);
    if (typeof file.previous_filename === "string") paths.add(file.previous_filename);
  }
  return {
    tip,
    upToDate: Boolean(body) && (body.status === "ahead" || body.status === "identical"),
    paths: [...paths].sort(),
    truncated: !body || !Array.isArray(body.files) || files.length >= BASE_COMPARE_LIMIT,
  };
}

// Owner Decision a0d93cd0: merging the base branch into a head the Owner
// approved keeps that approval when the protected change stays the one the
// Owner saw. Each step back from the head must be a two-parent merge whose
// second parent the base branch's tip contains (the base branch merged in),
// and its first parent is the earlier head. An earlier head qualifies when:
//   - no protected path the head changes against the tip was touched by the
//     merges since that earlier head (so the head's content of those files is
//     the approved head's), and
//   - the base branch did not touch them either between the approved head's
//     merge base with the tip and the tip (so the base side is the same),
// which makes the head's protected diff against the tip the approved head's
// diff against its own base. Any protected file a merge brought in differs
// from the tip in nothing (it is not in the head's diff): it is main's.
// Only an earlier head whose trusted admission check ever passed is
// asked about, the deepest one first (a head admitted this way leads back to
// the head the Owner approved), and the Owner review door stays the authority:
// it admits a head again only while the grant that admitted it is not revoked.
// A later failing check on that head does not count against it: once main
// moves, the re-verification posts "RE-VERIFIED: REJECTED" on the approved head
// (it no longer contains the tip), which is exactly why the author merges main.
export const CARRY_OVER_DEPTH = 10;

async function compareSummary(fetchImpl, env, repository, from, to) {
  const body = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${from}...${to}`);
  const files = body && Array.isArray(body.files) ? body.files : null;
  if (!files || files.length >= BASE_COMPARE_LIMIT) return null;
  const paths = new Set();
  for (const file of files) {
    if (typeof file.filename === "string") paths.add(file.filename);
    if (typeof file.previous_filename === "string") paths.add(file.previous_filename);
  }
  const mergeBase = body.merge_base_commit && typeof body.merge_base_commit.sha === "string" ? body.merge_base_commit.sha : null;
  return { status: body.status, mergeBase, paths: [...paths] };
}

// The earlier head whose Owner Grant the head may keep, or null.
export async function carriedApprovalSource(fetchImpl, env, repository, headSha, tipCompare, protectedPaths = effectiveProtectedPaths(null)) {
  if (tipCompare.truncated || !tipCompare.upToDate) return null;
  const protectedOf = (paths) => protectedPathFindings(paths, protectedPaths).map((finding) => finding.replace(/^protected_path:/, ""));
  const changedNow = new Set(protectedOf(tipCompare.paths));
  const untouched = (paths) => !protectedOf(paths).some((path) => changedNow.has(path));
  let source = null;
  let current = headSha;
  for (let step = 0; step < CARRY_OVER_DEPTH; step += 1) {
    const commit = await githubJson(fetchImpl, env, `/repos/${repository}/commits/${current}`);
    const parents = commit && Array.isArray(commit.parents) ? commit.parents.map((parent) => parent && parent.sha) : [];
    if (parents.length !== 2 || !parents.every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha))) break;
    const [earlier, merged] = parents;
    const fromBase = await compareSummary(fetchImpl, env, repository, merged, tipCompare.tip);
    if (!fromBase || (fromBase.status !== "ahead" && fromBase.status !== "identical")) break;
    const sinceEarlier = await compareSummary(fetchImpl, env, repository, earlier, headSha);
    if (!sinceEarlier || !untouched(sinceEarlier.paths)) break;
    const earlierToTip = await compareSummary(fetchImpl, env, repository, tipCompare.tip, earlier);
    if (!earlierToTip || !earlierToTip.mergeBase) break;
    const onBase = await compareSummary(fetchImpl, env, repository, earlierToTip.mergeBase, tipCompare.tip);
    if (!onBase || !untouched(onBase.paths)) break;
    // Historical proof may predate the display-name cutover. The live Owner
    // door still revalidates the original Grant; current gates use new names.
    const checks = await appChecksOnHead(fetchImpl, env, repository, earlier, null);
    if (checks.some((check) => check.status === "completed" && check.conclusion === "success")) source = earlier;
    current = earlier;
  }
  return source;
}

// The mode as the summary and the outputs report it; layer, rules and label
// are added once the pull request's paths are known.
function modeOutcome(mode) {
  return { state: mode.state, requested: mode.requested, source: mode.source, policy_version: mode.policy_version,
    errors: mode.errors, layer: null, rules: null, label: null };
}

// readPolicyFile reads config/merge-admission-policy.json of the workspace;
// the self-tests pass a fixed table so that they never depend on the
// repository's copy (review MAJOR-1).
async function evaluateCore({ env, event, eventName, fetchImpl, workspace, withSummary, readPolicyFile = fs.readFileSync, observation_recorder, evaluation_id, observation_entry = "required" }) {
  const mode = resolveMode({ env, workspace, readFile: readPolicyFile });
  const outcome = emptyOutcome(eventName);
  outcome.admission_mode = modeOutcome(mode);
  if (!PR_EVENTS.has(eventName)) {
    outcome.admitted = true;
    outcome.verdict = "NOT_APPLICABLE";
    outcome.reasons = [`event ${eventName} is not an admission subject`];
    return outcome;
  }
  let pr = event && event.pull_request;
  if (!pr || !pr.head || !pr.base) throw new Error("pull_request payload is missing head/base.");
  if (eventName === "pull_request_target") {
    // A re-run replays the original payload; the PR itself may have moved.
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
    pr = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/pulls/${pr.number}`);
    if (!pr || !pr.head || !pr.base) throw new Error(`pull request ${event.pull_request.number} could not be read.`);
  }
  outcome.head_sha = pr.head.sha;
  outcome.base_sha = pr.base.sha;
  outcome.pr_ref = `${env.GITHUB_REPOSITORY}#${pr.number}`;
  observation_recorder?.record("admission_selected",{evaluation_id,pr,entry:observation_entry});
  // Merge Admission step 2: auto_merge_disabled can arrive for a pull request
  // that was just merged or closed. It is not judged, and nothing passes.
  if (typeof pr.state === "string" && pr.state !== "open") {
    outcome.verdict = "PR_NOT_OPEN";
    outcome.reasons.push(`pull request #${pr.number} is ${plainFinding(pr.state)}; nothing to judge`);
    return outcome;
  }

  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  const repository = env.GITHUB_REPOSITORY;
  const changed = await changedPathsOfPullRequest(fetchImpl, env, repository, pr.number);
  outcome.changed_paths = changed.paths;
  const truncated = Number.isInteger(pr.changed_files) && changed.file_count < pr.changed_files;
  const workflowResult = await workflowFindings(fetchImpl, env, repository, changed.files, pr.head.sha, pr.base.sha);
  const gateFindingsOfPr = [...workflowResult.gate, ...await policyFileFindings(fetchImpl, env, repository, changed.files, pr.head.sha)];
  if (gateFindingsOfPr.length) outcome.workflow_gate_findings = gateFindingsOfPr;
  const tipCompare = await baseTipCompare(fetchImpl, env, repository, pr);
  const allPaths = [...new Set([...changed.paths, ...tipCompare.paths])].sort();
  const protectedPaths = effectiveProtectedPaths(mode.policy);
  const ownerFindings = protectedPathFindings(allPaths, protectedPaths);
  // A long compare may hide a protected path: the Owner is asked.
  if (tipCompare.truncated) ownerFindings.push(`protected_path_unknown:the compare of ${tipCompare.tip} with the head is unavailable or lists ${BASE_COMPARE_LIMIT} or more files`);
  if (ownerFindings.length) outcome.owner_review_findings = ownerFindings;
  // Merge Admission v0.1 §3.2: the strictest layer of all paths decides,
  // and the rules follow from it and the state (protected exactly when
  // ownerFindings is not empty).
  const layer = layerOf(allPaths, mode.policy, { unknown: tipCompare.truncated });
  const rules = effectiveRules(mode.policy, mode.state, layer);
  Object.assign(outcome.admission_mode, { layer, rules, label: modeLabel(mode.state, layer, rules) });
  const claimAdvisory = rules.work_claim === "advise";
  for (const hint of workflowResult.owner) outcome.notices.push(`workflow_review_hint:${hint}`);
  if (withSummary && workspace) {
    await summarizeWorkflows(fetchImpl, env, repository, pr.head.sha, outcome.changed_paths, workspace, outcome);
  }

  if (!env.CLUED_CONTEXT_READ_TOKEN) throw new Error("CLUED_CONTEXT_READ_TOKEN is not set; admission cannot be verified.");

  let reference = parseClaimReference(pr.body);
  if (!reference) {
    const commit = await githubJson(fetchImpl, env, `/repos/${repository}/commits/${pr.head.sha}`);
    reference = parseClaimReference(commit && commit.commit && commit.commit.message);
  }
  if (!reference) {
    if (!claimAdvisory) {
      outcome.verdict = "REJECTED";
      outcome.reasons.push("claim_trailer_missing");
      return outcome;
    }
    // Merge Admission v0.1 §5.1: work_claim: advise admits it and says so.
    outcome.notices.push(`claim_advisory_missing: no Clued-Work-Claim trailer in the PR body or head commit (the ${layer} layer only advises a claim in ${mode.state})`);
  } else {
    outcome.claim_id = reference.claim_id;
    outcome.scope = reference.scope;
  }
  if (truncated) {
    // Paths past the API limit cannot be checked against the write set.
    outcome.verdict = "REJECTED";
    outcome.reasons.push(`changed_files_truncated:${pr.changed_files}`);
    return outcome;
  }

  let verified = null;
  if (reference) {
    // Re-review N8: a PR the workflow guard already refuses is verified
    // read-only, so it neither binds the claim nor uses the Task's CI budget.
    const reasonsBefore = outcome.reasons.length;
    let result;
    try {
      result = await verifyClaim(fetchImpl, env, gateFindingsOfPr.length ? {
        scope: reference.scope,
        claim_id: reference.claim_id,
        changed_paths: outcome.changed_paths,
      } : {
        scope: reference.scope,
        claim_id: reference.claim_id,
        changed_paths: outcome.changed_paths,
        head_sha: pr.head.sha,
        base_sha: pr.base.sha,
        pr_ref: outcome.pr_ref,
        target_branch: pr.base.ref,
        // Merge Admission v0.1 §10 (step 3): the Receipts of the binding and
        // of a newly admitted head name the mode it was judged in. A service
        // before migration 20261009010000 ignores the key.
        admission_mode: { state: mode.state, layer, reruns_per_head: rules.reruns_per_head },
      }, workspace);
    } catch (error) {
      if (!claimAdvisory) throw error;
      result = { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
    }
    if (result.kind !== "verdict") {
      const what = result.kind === "rpc_unavailable" ? `${VERIFY_RPC} is not deployed (${result.detail})`
        : result.kind === "refused" ? `Clued refused the verification request (${result.detail})`
          : `the verification is unavailable (${result.detail})`;
      if (claimAdvisory) {
        outcome.notices.push(`claim_advisory_unverified: ${what}`);
      } else if (result.kind === "rpc_unavailable") {
        throw new Error(`Clued ${VERIFY_RPC} is not deployed (${result.detail}); admission cannot be verified.`);
      } else {
        throw new Error(`Clued refused the verification request (${result.detail}).`);
      }
    } else {
      verified = result;
      observation_recorder?.record("claim_verification",{evaluation_id,input:{scope:reference.scope,claim_id:reference.claim_id,head_sha:pr.head.sha},result});
      outcome.verdict = verified.verdict;
      outcome.reasons.push(...verified.reasons);
      const outside = verified.payload.paths_outside_write_set;
      if (Array.isArray(outside) && outside.length) outcome.paths_outside_write_set = outside;
      if (Number.isInteger(verified.payload.admitted_heads)) {
        outcome.admitted_heads = verified.payload.admitted_heads;
        outcome.max_heads_per_claim = verified.payload.max_heads_per_claim ?? null;
      }
      // GitHub CI per Task in 24 hours (GenericWorkClaim §10.4, Task bb9f1e36).
      if (Number.isInteger(verified.payload.task_ci_heads_24h)) {
        outcome.task_ci_heads_24h = verified.payload.task_ci_heads_24h;
        outcome.task_ci_head_cap = verified.payload.task_ci_head_cap ?? null;
        outcome.ci_retry_after = verified.payload.ci_retry_after ?? null;
      }
      if (verified.payload.claim && typeof verified.payload.claim === "object") {
        const { claim } = verified.payload;
        outcome.claim = {
          task_id: claim.task_id ?? null, status: claim.status ?? null, fence: claim.fence ?? null,
          expires_at: claim.expires_at ?? null, base_commit: claim.base_commit ?? null,
          bound_pr: claim.bound_pr ?? null,
          write_set: Array.isArray(claim.write_set) ? claim.write_set : [],
        };
      }
      // The claim's base must name a commit of this repository. A claim taken on
      // a newer main than the PR's base is only reported (Owner Decision
      // 36b50981): base_commit is declared by the Agent, so the comparison
      // cannot catch a wrong claim, and rejecting it only forced re-pushes.
      const claimBase = outcome.claim && outcome.claim.base_commit;
      if (outcome.verdict === "ADMITTED" && typeof claimBase === "string" && claimBase) {
        let compare;
        try {
          compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${claimBase}...${pr.base.sha}`, { allowMissing: true });
        } catch (error) {
          if (!claimAdvisory) throw error;
          outcome.notices.push(`claim_advisory_unverified: the claim's base_commit could not be compared (${error instanceof Error ? error.message : String(error)})`);
        }
        if (compare === undefined) {
          // work_claim: advise and the compare failed: noted above.
        } else if (!compare) {
          outcome.verdict = "REJECTED";
          outcome.reasons.push(`claim_base_unknown:${claimBase}`);
        } else if (compare.status !== "ahead" && compare.status !== "identical") {
          outcome.notices.push(`base_behind_claim:${compare.status} (the claim's base_commit ${claimBase} is newer than this PR's base ${pr.base.sha}; merge main into the branch or claim with the branch's merge-base)`);
        }
      }
    }
    // Merge Admission v0.1 §5.1: work_claim: advise admits a claim that does
    // not admit the pull request, and moves its reasons to the notices.
    if (claimAdvisory && outcome.verdict !== "ADMITTED") {
      if (outcome.verdict) outcome.claim_verdict = outcome.verdict;
      for (const reason of outcome.reasons.splice(reasonsBefore)) outcome.notices.push(`claim_advisory:${reason}`);
    }
  }
  if (claimAdvisory) outcome.verdict = "ADMITTED";
  if (gateFindingsOfPr.length) {
    outcome.verdict = "REJECTED";
    outcome.reasons.push(...gateFindingsOfPr);
  }
  // Merge Admission v0.1 §5.1 up_to_date and owner_grant (WorkClaimAdmission
  // §4.6, re-review 10): the protected layer's, and every layer's in frozen.
  const reviewFindings = ownerFindings.length ? ownerFindings : [`state_frozen:${layer}`];
  // Review MINOR-1: in frozen every head needs its own grant (§4.2), the
  // protected layer's too, so no approval is carried over.
  const frozen = mode.state === "frozen";
  const listedFindings = `${reviewFindings.slice(0, 10).map(plainFinding).join(", ")}${reviewFindings.length > 10 ? `, and ${reviewFindings.length - 10} more` : ""}`;
  if (rules.up_to_date === "check_and_strict" && !tipCompare.upToDate && outcome.verdict === "ADMITTED") {
    outcome.verdict = "REJECTED";
    outcome.reasons.push(`protected_change_not_up_to_date:${tipCompare.tip} (merge ${pr.base.ref} into the branch first; ${listedFindings}${frozen ? "; merge admission is frozen, so the new head needs its own Owner Grant" : ""})`);
  }
  if (rules.owner_grant === "required" && outcome.verdict === "ADMITTED") {
    await ownerReview(fetchImpl, env, repository, pr, workspace, reviewFindings, outcome, tipCompare,
      { protectedPaths, carryOver: !frozen, frozenLayer: frozen && layer !== "protected" ? layer : null });
  }
  // Re-review 7, m2: the file list was read after the head, so a push in
  // between would pair this head's verdict with another head's files.
  if (outcome.verdict === "ADMITTED") {
    const now = await githubJson(fetchImpl, env, `/repos/${repository}/pulls/${pr.number}`);
    if (!now || !now.head || now.head.sha !== pr.head.sha) {
      throw new Error(`the pull request's head moved from ${pr.head.sha} to ${now && now.head ? now.head.sha : "(unknown)"} during admission; the next run judges the new head`);
    }
  }
  // Owner Decision 2ea795e4: a head that contains the base branch's tip can
  // merge, so only the claim holding the merge slot may have it.
  // Merge Admission v0.1: merge_slot: advise passes it as not_required, and
  // auto_merge: forbidden (frozen) fails it while auto-merge is on.
  const slot = mergeSlotState({ repository, branch: pr.base.ref, tip: tipCompare.tip,
    upToDate: tipCompare.upToDate, claim: verified ? verified.payload.claim : null,
    verifiedAt: verified ? verified.payload.verified_at : null, claimless: !verified });
  if (rules.auto_merge === "forbidden" && pr.auto_merge) outcome.merge_slot = { ...slot, observed: slot.state, state: "auto_merge_forbidden" };
  else if (rules.merge_slot === "advise") outcome.merge_slot = { ...slot, observed: slot.state, state: "not_required" };
  else outcome.merge_slot = slot;
  outcome.admitted = outcome.verdict === "ADMITTED";
  return outcome;
}

// ---------------------------------------------------------------------------
// Merge slot (agent contract v33 §1.7; Owner Decisions 0edf7889, 2ea795e4).
// The default branch requires a pull request to contain its tip before it
// merges, so a merge by another session during a CI run wastes that run. The
// merge slot, the trigger ref merge:<owner>/<name>:<branch>, is a first-in,
// first-out queue whose head holds the slot (migration 20261009080000, Merge
// Admission step 4); merge_slot_until is set only for the head. The admission run
// posts the kooyumi-merge-slot check as the clued-admission App: it fails while
// the head contains the base branch's tip and the claim does not hold the slot,
// so once the Owner makes the check required, nobody can merge without it.
// A head that does not contain the tip passes: GitHub blocks its merge anyway.
// It is a check of its own because the heavy workflows' gates follow
// kooyumi-admission-verified, and they must still run on a head that merely
// happens to contain the tip.

// Observe the original evaluator; no permission/result/return-code change.
export async function evaluate(args) {
  const recorder=args.observation_recorder??createNaturalRecorder({env:args.env,workspace:args.workspace,sourceUrl:import.meta.url,sourcePath:"scripts/ci/clued-work-admission.mjs"});
  return observeEvaluation(evaluateCore,{...args,observation_close_owned:!args.observation_recorder},recorder);
}

export const MERGE_SLOT_CHECK_NAME = "kooyumi-merge-slot";

export function mergeSlotRef(repository, branch) {
  return `merge:${repository}:${branch}`;
}

// states: held, not_needed (the head does not contain the tip), not_reported
// (the Clued service predates merge slots), missing. A pull request admitted
// with no verified claim (work_claim: advise) holds no slot (claimless).
// evaluate() adds not_required (merge_slot: advise) and auto_merge_forbidden
// (frozen with auto-merge on).
export function mergeSlotState({ repository, branch, tip, upToDate, claim, verifiedAt, claimless = false }) {
  const ref = mergeSlotRef(repository, branch);
  const base = { ref, tip: tip ?? null, until: null };
  if (!upToDate) return { ...base, state: "not_needed" };
  if (claimless) return { ...base, state: "missing" };
  if (!claim || typeof claim !== "object" || !Object.hasOwn(claim, "merge_slot_until")) return { ...base, state: "not_reported" };
  const refs = Array.isArray(claim.trigger_refs) ? claim.trigger_refs : [];
  const named = refs.some((value) => typeof value === "string" && value.toLowerCase() === ref.toLowerCase());
  const until = typeof claim.merge_slot_until === "string" ? claim.merge_slot_until : null;
  const at = Date.parse(verifiedAt ?? "");
  const live = until !== null && Number.isFinite(at) && Date.parse(until) > at;
  return { ...base, until, state: named && live ? "held" : "missing" };
}

// The check for one admission result: admitted and holding (or not needing)
// the slot passes; everything else fails. mode is the admission's mode label
// ("<state> · <layer> · reruns <n>", Merge Admission v0.1 §10).
export function mergeSlotCheck({ admitted, state, ref, until, tip, claimId, branch, mode }) {
  const slot = ref || "merge:<owner>/<name>:<branch>";
  const target = branch || "the base branch";
  const [modeState, modeLayer] = String(mode ?? "").split(" · ");
  if (!admitted) {
    return { success: false, title: "Not admitted",
      summary: "kooyumi-work-admission did not admit this head, so it cannot hold the merge slot." };
  }
  switch (state) {
    case "not_required":
      return { success: true, title: `not_required(${modeLayer || "layer"}, ${modeState || "state"})`,
        summary: `The merge admission policy only advises the merge slot for the ${modeLayer || "pull request's"} layer in the ${modeState || "current"} state, so this check does not require \`${slot}\` (Merge Admission v0.1 §5).` };
    case "auto_merge_forbidden":
      return { success: false, title: "Auto-merge is not allowed while merge admission is frozen",
        summary: "Merge admission is frozen: only the Owner merges, and auto-merge is forbidden (Merge Admission v0.1 §4.2). "
          + "Turn auto-merge off for this pull request; then push, or edit the pull request body, to run this check again." };
    case "held":
      return { success: true, title: `Merge slot held until ${until}`,
        summary: `The claim holds \`${slot}\` until ${until}. Merge, then give the slot back (renew without the ref, or release the claim).` };
    case "not_needed":
      return { success: true, title: `Not needed: the branch does not contain ${target}'s tip`,
        summary: `This head does not contain ${tip ? `\`${tip}\`` : `the tip of ${target}`}, so GitHub does not let it merge yet. Take \`${slot}\` before you bring ${target} in for the final run.` };
    case "not_reported":
      return { success: true, title: "Not checked: Clued does not report merge slots yet",
        summary: "The Clued service does not report merge_slot_until yet (migration 20261006120000 is not applied), so the merge slot is not checked." };
    case "missing":
      return { success: false, title: "Merge slot not held",
        summary: `This head contains the tip of ${target}, so it could merge now, and only the session holding the merge slot may merge. `
          + `Join the merge queue by renewing the claim${claimId ? ` \`${claimId}\`` : ""} with \`${slot}\` added to its trigger_refs, or, if it is already there, wait until its merge_queue shows it as head (agent contract §1.7). `
          + "Then push, or edit the pull request body, to run this check again." };
    default:
      return { success: false, title: "Merge slot unknown",
        summary: "The admission run reported no merge slot state for this head." };
  }
}

// ---------------------------------------------------------------------------
// Re-verification. A check run is a verdict at one moment; the claim behind it
// can expire, be released or be taken over afterwards. Every hour, for every
// open, non-draft pull request into the default branch whose newest
// kooyumi-admission-verified App check (the one the ruleset reads) is a success,
// the pull request is evaluated again; when it is no longer admitted, a failing
// App check is posted on its head, which blocks the merge until a new event
// re-admits it.
// Re-review 7, MAJOR-1: this used to pick the newest admission run on the
// head, whatever pull request it belonged to, and re-run it only when it had
// succeeded. A second pull request with the same head into another branch (its
// admission job is skipped) or a cancelled run then hid the first one's run,
// and its green check outlived its claim. It now reads the App checks, which
// name their pull request, and posts the failing check itself. Without the
// App's key it re-verifies nothing and fails (re-review 8: re-running a run
// named by an App check could pick the re-verification's own run).
// Transport errors are reported, never turned into a verdict.

export const ADMISSION_WORKFLOW = "clued-work-admission.yml";

export async function appChecksOnHead(fetchImpl, env, repository, headSha, name = APP_CHECK_NAME) {
  // This selector grants no authority: the concrete installed reader obtains
  // a private proof from the protected journal, Source lease and fresh Native.
  if(env.CLUED_EXECUTION_PROVIDER==='independent-control-checks-v1'&&name!==null){
    const {readIndependentControlChecksOnHead}=await import('../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v1/consumer.mjs');
    return readIndependentControlChecksOnHead({repository,headSha,name});
  }
  // Source v2 (resident executor): the same selector over the v2 control pair (external id
  // independent-ci:control:<role>:v2:..., journal state2\effects-control); fails closed off the
  // installed clued-control principal.
  if(env.CLUED_EXECUTION_PROVIDER==='independent-control-checks-v2'&&name!==null){
    const {readIndependentControlChecksOnHeadV2}=await import('../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/consumer.mjs');
    return readIndependentControlChecksOnHeadV2({repository,headSha,name});
  }

  const historical = name === null;
  const names = new Set(historical ? [APP_CHECK_NAME, "clued-admission-verified"] : [name]);
  const checks = await githubPaged(fetchImpl, env,
    `/repos/${repository}/commits/${headSha}/check-runs?${historical ? "" : `check_name=${name}&`}filter=all`, "check_runs");
  return checks
    .filter((check) => check && names.has(check.name) && check.head_sha === headSha
      && check.app && Number(check.app.id) === ADMISSION_APP_ID)
    .sort((a, b) => Number(b.id) - Number(a.id));
}

// Merge Admission v0.1 §4.1 item 3 (step 3): after the Owner switches the
// state, the Owner dispatches this workflow with reason=state_change. Every
// open, non-draft pull request into the default branch is then judged again
// and gets both App checks anew, passing or failing, with the new mode in the
// title, since a switch back from frozen must turn its red checks green. The
// hourly run keeps posting failures only.
export const STATE_CHANGE_REASON = "state_change";
const STATE_CHANGE_PREFIX = "RE-VERIFIED (state change): ";

async function rejudge({ env, fetchImpl, now, pr, outcome, result }) {
  const label = outcome.admission_mode && outcome.admission_mode.label;
  // A transient Owner review door leaves both checks as they are (review MINOR-2).
  if (outcome.owner_review && outcome.owner_review.kind === "transient") {
    throw new Error(`Clued's Owner review door is unavailable (${outcome.reasons.join("; ")}); the checks stay as they are until the next run`);
  }
  const verdict = outcome.verdict ?? (outcome.admitted ? "ADMITTED" : "NOT ADMITTED");
  const admission = await postAppCheck({
    env, fetchImpl, now, headSha: pr.head.sha, success: outcome.admitted, prNumber: pr.number,
    title: `${STATE_CHANGE_PREFIX}${verdict}${label ? ` [${label}]` : ""}`,
    summary: `Merge admission state changed; #${pr.number} was judged again${label ? ` in mode ${label}` : ""}: `
      + (outcome.admitted ? "admitted." : `not admitted: ${outcome.reasons.join("; ") || "no reason given"}.`),
  });
  if (!admission.posted) throw new Error(`no ${APP_CHECK_NAME} check could be posted: ${admission.error ?? admission.reason}`);
  const state = outcome.merge_slot ? outcome.merge_slot.state : "unknown";
  const slot = mergeSlotCheck({ admitted: outcome.admitted, state,
    ref: outcome.merge_slot ? outcome.merge_slot.ref : mergeSlotRef(env.GITHUB_REPOSITORY, pr.base.ref),
    until: outcome.merge_slot ? outcome.merge_slot.until : null, tip: outcome.merge_slot ? outcome.merge_slot.tip : null,
    claimId: outcome.claim_id, branch: pr.base.ref, mode: label });
  const posted = await postAppCheck({
    env, fetchImpl, now, headSha: pr.head.sha, success: slot.success, title: `${STATE_CHANGE_PREFIX}${slot.title}`,
    prNumber: pr.number, name: MERGE_SLOT_CHECK_NAME, summary: slot.summary,
  });
  if (!posted.posted) throw new Error(`no ${MERGE_SLOT_CHECK_NAME} check could be posted: ${posted.error ?? posted.reason}`);
  result.rejudged.push({ pr: pr.number, verdict, admitted: outcome.admitted, check_run_id: admission.check_run_id,
    merge_slot: state, merge_slot_passed: slot.success, merge_slot_check_run_id: posted.check_run_id });
}

async function reverifyCore({ env, fetchImpl, workspace, now = () => Date.now(), readPolicyFile = fs.readFileSync, observation_recorder }) {
  const mode = resolveMode({ env, workspace, readFile: readPolicyFile });
  const stateChange = (env.CLUED_REVERIFY_REASON ?? "").trim() === STATE_CHANGE_REASON;
  const result = { mode: { state: mode.state, source: mode.source, errors: mode.errors },
    reason: stateChange ? STATE_CHANGE_REASON : "scheduled", checked: [], blocked: [], rejudged: [], errors: [] };
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  // Re-review 8, NIT: without the App nothing can be blocked, and the App
  // checks this reads would not exist; say so instead of passing quietly.
  if (!(env.CLUED_ADMISSION_APP_ID ?? "").trim() || !(env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? "").trim()) {
    result.errors.push({ pr: null, error: "the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY); nothing can be re-verified" });
    return result;
  }
  const repository = env.GITHUB_REPOSITORY;
  const recorder=observation_recorder;
  const batch_id=recorder.newId(),selected=[];
  const pulls = await githubPaged(fetchImpl, env, `/repos/${repository}/pulls?state=open`);
  recorder.record("batch_initial",{batch_id,pulls,entry:stateChange?"rejudge":"reverify"});
  for (const pr of pulls) {
    if (pr.draft || !pr.head || !pr.base) {
      recorder.record("batch_candidate",{batch_id,pr,selection_state:pr.draft?"excluded":"unknown",reason_code:pr.draft?"DRAFT":"NATIVE_PR_IDENTITY_UNAVAILABLE"});
      continue;
    }
    const defaultBranch = pr.base.repo && pr.base.repo.default_branch;
    if (defaultBranch && pr.base.ref !== defaultBranch) {recorder.record("batch_candidate",{batch_id,pr,selection_state:"excluded",reason_code:"OTHER_BASE"});continue;}
    if (stateChange) {
      try {
        const observation_evaluation_id=recorder.newId();selected.push({pr,evaluation_id:observation_evaluation_id});
        recorder.record("batch_selection",{batch_id,pr,evaluation_id:observation_evaluation_id,entry:"rejudge",criterion:"state_change"});
        const outcome = await evaluate({ env, event: { pull_request: pr }, eventName: "pull_request_target", fetchImpl, workspace, withSummary: false, readPolicyFile,observation_recorder:recorder,observation_evaluation_id,observation_entry:"rejudge" });
        if (outcome.verdict === "PR_NOT_OPEN") continue;
        await rejudge({ env, fetchImpl, now, pr, outcome, result });
      } catch (error) {
        result.errors.push({ pr: pr.number, error: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    try {
      const green = (checks) => Boolean(checks[0]) && checks[0].status === "completed" && checks[0].conclusion === "success";
      const admissionGreen = green(await appChecksOnHead(fetchImpl, env, repository, pr.head.sha));
      // A merge slot that lapsed or was given back since its check passed
      // (Owner Decision 2ea795e4).
      const slotGreen = green(await appChecksOnHead(fetchImpl, env, repository, pr.head.sha, MERGE_SLOT_CHECK_NAME));
      if (!admissionGreen && !slotGreen) {recorder.record("batch_candidate",{batch_id,pr,selection_state:"excluded",reason_code:"NO_PRIOR_GREEN",admission_green:admissionGreen,slot_green:slotGreen});continue;}
      const observation_evaluation_id=recorder.newId();selected.push({pr,evaluation_id:observation_evaluation_id});
      recorder.record("batch_selection",{batch_id,pr,evaluation_id:observation_evaluation_id,entry:"reverify",criterion:"prior_app_green",admission_green:admissionGreen,slot_green:slotGreen});
      const outcome = await evaluate({ env, event: { pull_request: pr }, eventName: "pull_request_target", fetchImpl, workspace, withSummary: false, readPolicyFile,observation_recorder:recorder,observation_evaluation_id,observation_entry:"reverify" });
      // Closed between the list and the fresh read: nothing to re-verify.
      if (outcome.verdict === "PR_NOT_OPEN") continue;
      const label = outcome.admission_mode && outcome.admission_mode.label;
      result.checked.push({ pr: pr.number, verdict: outcome.verdict, reasons: outcome.reasons,
        ...(label ? { mode: label } : {}),
        ...(outcome.merge_slot ? { merge_slot: outcome.merge_slot.state } : {}) });
      // A transient Owner review door leaves both checks as they are (review MINOR-2).
      const transient = Boolean(outcome.owner_review && outcome.owner_review.kind === "transient");
      const slotFails = outcome.merge_slot && ["missing", "auto_merge_forbidden"].includes(outcome.merge_slot.state);
      if (slotGreen && !transient && (!outcome.admitted || slotFails)) {
        const slot = mergeSlotCheck({ admitted: outcome.admitted, state: outcome.merge_slot ? outcome.merge_slot.state : "unknown",
          ref: outcome.merge_slot ? outcome.merge_slot.ref : mergeSlotRef(repository, pr.base.ref),
          tip: outcome.merge_slot ? outcome.merge_slot.tip : null, claimId: outcome.claim_id, branch: pr.base.ref, mode: label });
        const posted = await postAppCheck({
          env, fetchImpl, now, headSha: pr.head.sha, success: false, title: `RE-VERIFIED: ${slot.title}`, prNumber: pr.number,
          name: MERGE_SLOT_CHECK_NAME, summary: slot.summary,
        });
        // Reported, and the admission check below is still handled (review MINOR-3).
        if (!posted.posted) {
          result.errors.push({ pr: pr.number, error: `no failing ${MERGE_SLOT_CHECK_NAME} check could be posted: ${posted.error ?? posted.reason}` });
        } else {
          result.blocked.push({ pr: pr.number, check: MERGE_SLOT_CHECK_NAME, check_run_id: posted.check_run_id,
            verdict: slot.title, reasons: [outcome.merge_slot ? outcome.merge_slot.ref : outcome.verdict ?? "not admitted"] });
        }
      }
      if (!admissionGreen || outcome.admitted) continue;
      // The Owner review runs only on an otherwise admitted pull request, so a
      // transient door error is the only thing standing against it (re-review 10, NIT).
      if (outcome.owner_review && outcome.owner_review.kind === "transient") {
        throw new Error(`Clued's Owner review door is unavailable (${outcome.reasons.join("; ")}); the check stays as it is until the next run`);
      }
      const verdict = `RE-VERIFIED: ${outcome.verdict ?? "NOT ADMITTED"}${label ? ` [${label}]` : ""}`;
      const posted = await postAppCheck({
        env, fetchImpl, now, headSha: pr.head.sha, success: false, title: verdict, prNumber: pr.number,
        summary: `The re-verification no longer admits #${pr.number}: ${outcome.reasons.join("; ") || "no reason given"}. `
          + (outcome.reasons.some((reason) => reason.startsWith("protected_change_not_up_to_date:"))
            ? (outcome.admission_mode && outcome.admission_mode.state === "frozen"
              ? `Merge ${pr.base.ref} into the branch and push; merge admission is frozen, so the new head needs its own Owner Grant.`
              : `Merge ${pr.base.ref} into the branch and push; the approval carries over when the merge leaves the protected changes as they were, otherwise the new head needs its own Owner Grant.`)
            : "Push a commit or edit the pull request once it is admitted again."),
      });
      if (!posted.posted) throw new Error(`not admitted (${outcome.verdict}) and no failing check could be posted: ${posted.error ?? posted.reason}`);
      result.blocked.push({ pr: pr.number, check_run_id: posted.check_run_id, verdict: outcome.verdict, reasons: outcome.reasons });
    } catch (error) {
      recorder.record("batch_candidate",{batch_id,pr,selection_state:"unknown",reason_code:"SELECTION_READ_FAILED"});
      result.errors.push({ pr: pr.number, error: error instanceof Error ? error.message : String(error) });
    }
  }
  recorder.record("batch_closing",{batch_id,selected,completion:"normal"});
  return result;
}

export async function reverify(args) {
  const recorder=args.observation_recorder??createNaturalRecorder({env:args.env,workspace:args.workspace,sourceUrl:import.meta.url,sourcePath:"scripts/ci/clued-work-admission.mjs"});
  let completion="exception";
  try {const result=await reverifyCore({...args,observation_recorder:recorder});completion="returned";return result;}
  finally {if(!args.observation_recorder)recorder.finish(completion);}
}

export function renderReverifySummary(result) {
  const lines = ["## kooyumi-work-admission re-verification", ""];
  if (result.mode) {
    lines.push(`**Mode:** \`${result.mode.state}\` · source \`${result.mode.source}\``);
    for (const error of result.mode.errors ?? []) lines.push(`- fail closed to frozen: ${error}`);
    lines.push("");
  }
  if (result.reason === STATE_CHANGE_REASON) {
    lines.push(`State change: open PRs judged again: ${result.rejudged.length} · errors: ${result.errors.length}`);
    for (const pr of result.rejudged) {
      lines.push(`- #${pr.pr}: ${pr.verdict} (check ${pr.check_run_id}), merge slot \`${pr.merge_slot}\` ${pr.merge_slot_passed ? "passing" : "failing"} (check ${pr.merge_slot_check_run_id})`);
    }
    for (const error of result.errors) lines.push(`- ${error.pr === null ? "re-verification" : `#${error.pr}`}: error ${error.error}`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`Open PRs with a passing admission check checked: ${result.checked.length} · failing checks posted: ${result.blocked.length} · errors: ${result.errors.length}`);
  for (const blocked of result.blocked) lines.push(`- #${blocked.pr}: failing ${blocked.check ?? "check"} ${blocked.check_run_id} posted, ${blocked.verdict}: ${blocked.reasons.join("; ")}`);
  for (const error of result.errors) lines.push(`- ${error.pr === null ? "re-verification" : `#${error.pr}`}: error ${error.error}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gate. The admission-gate jobs run inside `pull_request` workflows, whose
// workflow file and checkout come from the PR, so they must not hold the Clued
// token. They do not ask Clued. They read the verdict of the trusted check:
// the kooyumi-admission-verified check of the clued-admission App that main's
// admission run of the same event posts on this head (eventAdmissionCheck
// below); only main's admission run can post it, so neither a look-alike job in a PR workflow nor an admission run of
// a pull request into another branch satisfies the gate. Both start on the
// same push, so the gate waits for the check. A PR that edits this script or
// its gate job changes only its own cost gating; the required check, which
// merging needs, is unaffected.

// R1: release the gate's self-hosted slot after three minutes of polling.
// A late App check never changes this attempt's admitted=false output. The
// executor must qualify a current-head gate-only attempt and run all jobs
// once, within the live admission's rerun allowance, before considering merge.
export const GATE_WAIT_SECONDS = 180;
export const GATE_POLL_SECONDS = 10;

// Owner Decision 22b0e0ed (PR-B hosted executors): a gate whose job names
// this source admits on the independent CI's own admission. The
// clued-admission App no longer runs on pull requests (its workflow is
// disabled), so the gate reads App 5368905's kooyumi-work-admission check of
// the exact head, which the resident executor's stage 1 publishes before it
// waits for hosted results. It polls every INDEPENDENT_GATE_POLL_SECONDS for
// at most INDEPENDENT_GATE_WAIT_SECONDS. Only the newest check of App 5368905
// counts: success, the exact head, the independent CI's native-work-admission
// external_id and a summary that names this pull request. A same-name check
// of any other App is never read. While the Owner's disaster-recovery switch
// runs the clued-admission workflow again, its event-bound App check below
// still decides when it settles first. The job is digest-pinned, so a pull
// request cannot select this source for another workflow.
export const INDEPENDENT_GATE_SOURCE = "independent-ci-native-work-admission";
export const INDEPENDENT_ADMISSION_APP_ID = 5368905;
export const INDEPENDENT_ADMISSION_CHECK = "kooyumi-work-admission";
export const INDEPENDENT_GATE_WAIT_SECONDS = 600;
export const INDEPENDENT_GATE_POLL_SECONDS = 30;
// The independent CI's native-work-admission ids: v1 (<job id>:f<fence>:e<epoch>:a<attempt>) and
// Source v2 (src/job-v2.mjs admissionExternalIdV2: v2:<job id>:a<1|2>:c<claim prefix>:f<fence>:e<epoch>).
const INDEPENDENT_NATIVE_ADMISSION_ID = /^independent-ci:native-work-admission:(?:[a-f0-9]{64}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9}:a[1-9][0-9]{0,9}|v2:[a-f0-9]{64}:a[12]:c[a-f0-9]{8}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9})$/;
export async function independentAdmissionCheck(fetchImpl, env, repository, headSha, prNumber) {
  let checks;
  try {
    checks = await githubPaged(fetchImpl, env,
      `/repos/${repository}/commits/${headSha}/check-runs?check_name=${INDEPENDENT_ADMISSION_CHECK}&filter=all`, "check_runs");
  } catch (error) {
    if (/ returned 403$/.test(String(error && error.message))) throw new Error(`${error.message}: the admission-gate job needs \`checks: read\``);
    throw error;
  }
  const newest = (Array.isArray(checks) ? checks : [])
    .filter((check) => check && check.name === INDEPENDENT_ADMISSION_CHECK && check.head_sha === headSha
      && check.app && Number(check.app.id) === INDEPENDENT_ADMISSION_APP_ID)
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
  if (!newest || newest.status !== "completed") return { settled: false, check: newest };
  const named = [...String((newest.output && newest.output.summary) ?? "").matchAll(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]{1,10})(?![0-9])/g)]
    .filter((match) => match[1].toLowerCase() === String(repository).toLowerCase()).map((match) => Number(match[2]));
  const bound = INDEPENDENT_NATIVE_ADMISSION_ID.test(String(newest.external_id ?? "")) &&
    named.length > 0 && named.every((number) => number === Number(prNumber));
  return { settled: true, check: newest, bound, admitted: bound && newest.conclusion === "success" };
}

async function independentGateOutcome({ env, fetchImpl, outcome, pr, attempt, independent, limit }) {
  const what = `${INDEPENDENT_ADMISSION_CHECK} of App ${INDEPENDENT_ADMISSION_APP_ID} for #${pr.number} on ${pr.head.sha}`;
  outcome.admission_source = INDEPENDENT_GATE_SOURCE;
  outcome.automation_self_hosted = false;
  const check = independent && independent.check;
  if (check) outcome.admission_run = { id: check.id, status: check.status, conclusion: check.conclusion ?? null,
    html_url: check.html_url ?? null, source: what };
  if (!independent || !independent.settled) {
    outcome.verdict = "ADMISSION_PENDING";
    outcome.reasons.push(`${what}: ${check ? `check ${check.id} still ${check.status}` : "has posted no check"} after ${limit}s`);
  } else if (!independent.bound) {
    outcome.verdict = "REJECTED";
    outcome.reasons.push(`${what}: check ${check.id} does not bind this pull request (external_id or summary)`);
  } else if (!independent.admitted) {
    outcome.verdict = "REJECTED";
    outcome.reasons.push(`${what} ${check.id} concluded ${check.conclusion}`);
  } else if (!pr.base || !pr.base.repo || pr.base.ref !== pr.base.repo.default_branch) {
    outcome.verdict = "REJECTED";
    outcome.reasons.push("the independent CI admits only pull requests into the default branch");
  } else if (attempt) {
    outcome.verdict = "RERUN_REFUSED";
    outcome.reasons.push(`run attempt ${attempt}: the independent CI admission names no re-run allowance; push a new commit`);
  } else if (!await executionEpochCurrent(fetchImpl, env, env.GITHUB_WORKSPACE, {
    repository: env.GITHUB_REPOSITORY, head_sha: pr.head.sha, pr_ref: outcome.pr_ref, target_branch: pr.base.ref,
  })) {
    outcome.verdict = "REJECTED";
    outcome.reasons.push("work_claim_execution_epoch_stale");
  } else {
    outcome.verdict = "ADMITTED";
    outcome.admitted = true;
  }
  return outcome;
}

// Re-review 2, N3c: the pull_requests list of a run names every open pull
// request with that head, not the one that triggered it, so a pull request
// into another branch, whose copy of the admission workflow passes anything,
// could stand in. The trusted signal is the kooyumi-admission-verified check of
// the clued-admission App on the head: its key lives in the clued-admission
// environment, which deploys from main only, and main's admission job checks
// out main and runs only for pull requests into main (re-review 6, B1). The
// gate job needs `checks: read` to read it.
export const ADMISSION_APP_ID = 5164952;

// A GitHub App login alone never qualifies candidate code for the internal
// pool. This observer is called only after the ordinary exact-head admission,
// execution epoch and rerun checks; it adds bounded main-refresh provenance.
export const AUTOMATION_BOT = Object.freeze({ id: 337003645, login: 'clued-admission[bot]', type: 'Bot' });
const WEB_FLOW = Object.freeze({ id: 19864447, login: 'web-flow', type: 'User' });
const APP_ID = ADMISSION_APP_ID;
const SHA = /^[a-f0-9]{40}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const identity = (value, expected) => value?.id === expected.id && value?.login === expected.login && value?.type === expected.type;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const denied = reason => ({ qualified: false, reason });
class RouteRefusal extends Error {}
const requireProof = (condition, reason) => { if (!condition) throw new RouteRefusal(reason); };

export function automationRouteRequested({ env, run }) {
  return run?.actor?.type === 'Bot' || run?.actor?.id === AUTOMATION_BOT.id ||
    run?.actor?.login === AUTOMATION_BOT.login || /\[bot\]$/.test(env.GITHUB_ACTOR ?? '');
}

function checkFor(check, head, prNumber) {
  const externalId = String(check?.external_id ?? '');
  const match = EXTERNAL_ID.exec(externalId);
  return positive(check?.id) && check.name === APP_CHECK_NAME && check.app?.id === APP_ID &&
    check.app?.slug === 'clued-admission' && check.head_sha === head &&
    match !== null && match[0] === externalId && positive(prNumber) &&
    Number(match[1]) === prNumber && positive(Number(match[2]));
}
function successful(check) { return check.status === 'completed' && check.conclusion === 'success'; }
function boundedChecks(value) {
  requireProof(Number.isSafeInteger(value?.total_count) && value.total_count >= 0 && value.total_count < 100 &&
    Array.isArray(value.check_runs) && value.check_runs.length === value.total_count, 'check_listing_incomplete');
  return value.check_runs;
}
function samePR(pr, { repository, number, head, base, branch, owner }) {
  return pr?.number === number && pr.state === 'open' && identity(pr.user, owner) &&
    pr.head?.sha === head && pr.head.ref === branch && pr.head.repo?.full_name === repository &&
    pr.base?.sha === base && pr.base.ref === 'main' && pr.base.repo?.full_name === repository;
}

// read is the gate's authenticated, GET-only GitHub JSON reader. Returned
// evidence contains identifiers only; payloads, credentials and exception text
// never enter route diagnostics. An unavailable observation is a refusal.
export async function qualifyTrustedAutomationRoute({ env, event, run, currentAdmission, read }) {
  let reason = 'automation_route_unavailable';
  try {
    const repository = env.GITHUB_REPOSITORY;
    requireProof(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
      env.GITHUB_REPOSITORY_OWNER === repository.split('/')[0] && typeof read === 'function', 'repository_identity');
    const pr = event?.pull_request;
    requireProof(env.GITHUB_EVENT_NAME === 'pull_request' && event?.action === 'synchronize' &&
      positive(pr?.number) && SHA.test(pr.head?.sha ?? '') && SHA.test(pr.base?.sha ?? '') &&
      typeof pr.head?.ref === 'string' && pr.head.ref.length > 0, 'refresh_event_identity');
    const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? '1');
    requireProof(positive(run?.id) && String(run.id) === env.GITHUB_RUN_ID && positive(attempt) &&
      run.run_attempt === attempt && run.event === 'pull_request' && run.head_sha === pr.head.sha &&
      run.head_branch === pr.head.ref && run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository && /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(run.path ?? '') &&
      env.GITHUB_REF === `refs/pull/${pr.number}/merge` && env.GITHUB_HEAD_REF === pr.head.ref &&
      env.GITHUB_BASE_REF === 'main', 'native_run_identity');
    requireProof(identity(run.actor, AUTOMATION_BOT) && env.GITHUB_ACTOR === AUTOMATION_BOT.login,
      'automation_actor_identity');
    requireProof(checkFor(currentAdmission, pr.head.sha, pr.number) && successful(currentAdmission), 'current_admission_identity');
    const repo = await read(`/repos/${repository}`);
    const owner = repo?.owner;
    requireProof(repo?.full_name === repository && repo.default_branch === 'main' && positive(owner?.id) &&
      owner.login === env.GITHUB_REPOSITORY_OWNER && owner.type === 'User', 'repository_owner_identity');
    const context = { repository, number: pr.number, head: pr.head.sha, base: pr.base.sha, branch: pr.head.ref, owner };
    requireProof(samePR(pr, context), 'owner_pr_identity');
    requireProof(run.triggering_actor?.login === env.GITHUB_TRIGGERING_ACTOR &&
      (attempt === 1 ? identity(run.triggering_actor, AUTOMATION_BOT) :
        identity(run.triggering_actor, AUTOMATION_BOT) || identity(run.triggering_actor, owner)), 'triggering_actor_identity');
    const live = await read(`/repos/${repository}/pulls/${pr.number}`);
    requireProof(samePR(live, context), 'live_pr_changed');
    const main = await read(`/repos/${repository}/branches/main`);
    requireProof(main?.name === 'main' && main.commit?.sha === pr.base.sha, 'main_tip_changed');
    const commit = await read(`/repos/${repository}/commits/${pr.head.sha}`);
    const parents = commit?.parents?.map(parent => parent?.sha);
    requireProof(commit?.sha === pr.head.sha && parents?.length === 2 && parents.every(parent => SHA.test(parent ?? '')) &&
      parents[0] !== parents[1] && !parents.includes(pr.head.sha) && parents[1] === pr.base.sha, 'refresh_parents');
    requireProof(identity(commit.author, AUTOMATION_BOT) && identity(commit.committer, WEB_FLOW), 'refresh_platform_identity');
    const verification = commit.commit?.verification;
    requireProof(SHA.test(commit.commit?.tree?.sha ?? '') && verification?.verified === true && verification.reason === 'valid' &&
      typeof verification.signature === 'string' && verification.signature.length > 0 &&
      typeof verification.payload === 'string' && verification.payload.startsWith(
        `tree ${commit.commit.tree.sha}\nparent ${parents[0]}\nparent ${parents[1]}\n`), 'refresh_signature');
    const mergedAt = timestamp(commit.commit?.committer?.date), createdAt = timestamp(run.created_at);
    requireProof(mergedAt !== null && createdAt !== null && mergedAt <= createdAt, 'refresh_time');
    const checksPath = head => `/repos/${repository}/commits/${head}/check-runs?check_name=${APP_CHECK_NAME}&filter=all&per_page=100`;
    const prior = boundedChecks(await read(checksPath(parents[0]))).filter(check => {
      const finished = timestamp(check.completed_at);
      return checkFor(check, parents[0], pr.number) && successful(check) && finished !== null && finished <= mergedAt;
    }).sort((a, b) => b.id - a.id)[0];
    // This earlier successful check proves provenance only. It cannot replace
    // the current head's live admission, epoch or rerun authorization.
    requireProof(prior, 'prior_pr_admission_missing');
    const priorRunId = Number(EXTERNAL_ID.exec(prior.external_id)?.[2]);
    requireProof(positive(priorRunId), 'prior_admission_origin');
    const priorRun = await read(`/repos/${repository}/actions/runs/${priorRunId}`);
    requireProof(positive(priorRunId) && priorRun?.id === priorRunId && priorRun.event === 'pull_request_target' &&
      priorRun.path === '.github/workflows/clued-work-admission.yml' && priorRun.status === 'completed' &&
      priorRun.conclusion === 'success' && priorRun.repository?.full_name === repository &&
      priorRun.head_repository?.full_name === repository && timestamp(priorRun.created_at) !== null &&
      timestamp(priorRun.created_at) <= timestamp(prior.completed_at) &&
      (identity(priorRun.actor, owner) || identity(priorRun.actor, AUTOMATION_BOT)), 'prior_admission_origin');
    const latest = boundedChecks(await read(checksPath(pr.head.sha))).filter(check =>
      checkFor(check, pr.head.sha, pr.number)).sort((a, b) => b.id - a.id)[0];
    requireProof(latest?.id === currentAdmission.id && successful(latest), 'current_admission_changed');
    requireProof(samePR(await read(`/repos/${repository}/pulls/${pr.number}`), context), 'live_pr_changed');
    return { qualified: true, reason: 'admitted_owner_pr_signed_main_refresh', run_id: run.id, run_attempt: attempt,
      pr_number: pr.number, head_sha: pr.head.sha, previous_head_sha: parents[0], main_sha: parents[1],
      actor_id: AUTOMATION_BOT.id, prior_check_id: prior.id, prior_admission_run_id: priorRunId,
      current_check_id: currentAdmission.id };
  } catch (error) {
    if (error instanceof RouteRefusal) reason = error.message;
    return denied(reason);
  }
}

// Re-review 3, N-R1: the App check is posted when an admission run ends, so
// until then an older success on the same head (a force-push back to an
// admitted commit, a reopened pull request, a second pull request with the
// same head) could stand in for it.
// Re-review 4, m1: main's admission run names its pull request and itself in
// the check's external_id ("pr:<number>:run:<run id>"), so a pull request with
// the same head cannot ride another pull request's admission.
// Re-review 5, n1: the check's posting time does not tell events apart (a pull
// request closed and reopened within two minutes), so the gate binds to the
// admission run of its own event instead. GitHub creates the runs of one event
// together (measured: within a second). The event's admission run is the newest
// main admission run (pull_request_target, this head) created no earlier than
// SAME_EVENT_MS before this run, leaving out runs whose check names another
// pull request. Only that run's check decides; while the run has posted
// nothing, the gate waits. The run list only locates the run: the authority
// stays the App check, which only main's admission run can post.
export const SAME_EVENT_MS = 15_000;
const EXTERNAL_ID = /^pr:([0-9]{1,10}):run:([0-9]{1,20})(?::publication:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?$/;
export function checkNamesPullRequest(check, prNumber) {
  const match = EXTERNAL_ID.exec(String((check && check.external_id) ?? ""));
  return Boolean(match) && Number(match[1]) === Number(prNumber);
}

export async function eventAdmissionCheck(fetchImpl, env, repository, headSha, since, prNumber) {
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const route = `/repos/${repository}/commits/${headSha}/check-runs?check_name=${APP_CHECK_NAME}&filter=all&per_page=100`;
  const response = await fetchImpl(`${base}${route}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "clued-work-admission",
    },
  });
  if (response.status === 403) {
    throw new Error(`GitHub API ${route} returned 403: the admission-gate job needs \`checks: read\``);
  }
  if (!response.ok) throw new Error(`GitHub API ${route} returned ${response.status}`);
  const body = await response.json();
  // The newest App check of each admission run, with the pull request it names,
  // and the newest naming this pull request from any run (re-verification
  // included), which a re-run also has to pass (Merge Admission step 2).
  const posted = new Map();
  let newestForPr = null;
  for (const check of (body && body.check_runs) || []) {
    if (check.name !== APP_CHECK_NAME || check.head_sha !== headSha) continue;
    if (!check.app || Number(check.app.id) !== ADMISSION_APP_ID) continue;
    const match = EXTERNAL_ID.exec(String(check.external_id ?? ""));
    if (!match) continue;
    const prior = posted.get(match[2]);
    if (!prior || Number(check.id) > Number(prior.check.id)) posted.set(match[2], { check, pr: Number(match[1]) });
    if (Number(match[1]) === Number(prNumber) && (!newestForPr || Number(check.id) > Number(newestForPr.id))) newestForPr = check;
  }
  const runs = (await githubJson(fetchImpl, env,
    `/repos/${repository}/actions/workflows/${ADMISSION_WORKFLOW}/runs?head_sha=${headSha}&event=pull_request_target&per_page=100`)).workflow_runs ?? [];
  const fresh = runs
    .filter((run) => run && run.event === "pull_request_target" && run.conclusion !== "skipped"
      && Date.parse(run.created_at) >= since - SAME_EVENT_MS)
    .sort((a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || (Number(b.id) - Number(a.id)));
  for (const run of fresh) {
    const entry = posted.get(String(run.id));
    if (entry && entry.pr !== Number(prNumber)) continue;
    return { run, check: entry ? entry.check : null, newestForPr };
  }
  return { run: null, check: null, newestForPr };
}

// Re-review 3, N-R3: a re-run replays the run's own workflow file and event,
// so one of a run from before the gates existed has no gate, and "re-run
// failed jobs" keeps the gate's earlier output. The gate refuses re-runs of
// branch dispatch runs; push a new commit instead.
// Merge Admission v0.1 §8 (step 2, Owner Decisions 77216370, 1b93760d): a
// pull request run's "Re-run all jobs" runs this gate again, which admits it
// only on the pull request's current head and only while the attempt is at
// most 1 + the reruns_per_head in the admission check's title. "Re-run failed
// jobs" does not run the gate again; the runner check refuses its heavy jobs.
export function rerunAttempt(env) {
  const attempt = Number.parseInt(String(env.GITHUB_RUN_ATTEMPT ?? "1"), 10);
  return Number.isInteger(attempt) && attempt > 1 ? attempt : null;
}
const RERUN_HOWTO = "re-runs are not admitted; push a new commit";
const PR_RERUN_HOWTO = "only \"Re-run all jobs\" of the current head's run, as many times as the kooyumi-admission-verified title allows; push a new commit otherwise";

// The pull request as it is now, for a re-run (the event payload is the
// original one). GitHub lets a token with contents: read read it.
async function currentHeadOf(fetchImpl, env, pr) {
  let now;
  try {
    now = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/pulls/${pr.number}`);
  } catch (error) {
    return `pull request #${pr.number} could not be read (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!now || now.state !== "open") return `pull request #${pr.number} is ${now && now.state ? now.state : "unreadable"}`;
  if (!now.head || now.head.sha !== pr.head.sha) return `${pr.head.sha} is no longer the head of #${pr.number} (now ${now.head && now.head.sha})`;
  if (!now.base || now.base.ref !== pr.base.ref) return `#${pr.number} now targets ${now.base && now.base.ref}, not ${pr.base.ref}`;
  return null;
}

export async function gate({ env, event, eventName, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  if(env.CLUED_EXECUTION_PROVIDER==='independent-control-checks-v1'){
    const {consumeIndependentGate}=await import('../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v1/consumer.mjs');
    const pr=event?.pull_request;
    return consumeIndependentGate({repository:env.GITHUB_REPOSITORY,pr:pr?.number,headSha:pr?.head?.sha,baseSha:pr?.base?.sha});
  }
  if(env.CLUED_EXECUTION_PROVIDER==='independent-control-checks-v2'){
    const {consumeIndependentGateV2}=await import('../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/consumer.mjs');
    const pr=event?.pull_request;
    return consumeIndependentGateV2({repository:env.GITHUB_REPOSITORY,pr:pr?.number,headSha:pr?.head?.sha,baseSha:pr?.base?.sha});
  }

  const outcome = emptyOutcome(eventName);
  if (eventName === "workflow_dispatch") return dispatchGate({ env, event, fetchImpl, now, outcome });
  if (!PR_EVENTS.has(eventName)) {
    outcome.admitted = true;
    outcome.verdict = "NOT_APPLICABLE";
    outcome.reasons = [`event ${eventName} is not an admission subject`];
    return outcome;
  }
  const pr = event && event.pull_request;
  if (!pr || !pr.head || !pr.base) throw new Error("pull_request payload is missing head/base.");
  outcome.head_sha = pr.head.sha;
  outcome.base_sha = pr.base.sha;
  outcome.pr_ref = `${env.GITHUB_REPOSITORY}#${pr.number}`;
  // A fork pull request, like any other, follows the App check that main's
  // admission run posts; the gate reads no repository variable.
  const source = env.CLUED_ADMISSION_GATE_SOURCE;
  if (source !== undefined && source !== "" && source !== INDEPENDENT_GATE_SOURCE)
    throw new Error(`unknown admission gate source ${JSON.stringify(String(source)).slice(0, 80)}`);
  const independentSource = source === INDEPENDENT_GATE_SOURCE;
  const maxWait = independentSource ? INDEPENDENT_GATE_WAIT_SECONDS : GATE_WAIT_SECONDS;
  const pollSeconds = independentSource ? INDEPENDENT_GATE_POLL_SECONDS : GATE_POLL_SECONDS;
  const waitSeconds = Number.parseInt(env.CLUED_ADMISSION_GATE_WAIT_SECONDS ?? "", 10);
  const limit = Number.isInteger(waitSeconds) && waitSeconds >= 0
    ? Math.min(waitSeconds, maxWait) : maxWait;
  try {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
    const attempt = rerunAttempt(env);
    if (attempt) {
      const stale = await currentHeadOf(fetchImpl, env, pr);
      if (stale) {
        outcome.verdict = "RERUN_REFUSED";
        outcome.reasons.push(`run attempt ${attempt}: ${stale}; ${PR_RERUN_HOWTO}`);
        throw Object.assign(new Error("refused"), { refused: true });
      }
    }
    if (!/^[0-9]{1,20}$/.test(String(env.GITHUB_RUN_ID ?? ""))) throw new Error("GITHUB_RUN_ID is not set.");
    const self = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
    const since = Date.parse(self && self.created_at);
    if (!Number.isFinite(since)) throw new Error(`run ${env.GITHUB_RUN_ID} has no created_at.`);
    let found = { run: null, check: null };
    let independent = null;
    const what = `${APP_CHECK_NAME} of App ${ADMISSION_APP_ID} for #${pr.number} from the admission run of this event (created since ${self.created_at} less ${SAME_EVENT_MS / 1000}s)`;
    for (let waited = 0; ;) {
      if (independentSource) {
        independent = await independentAdmissionCheck(fetchImpl, env, env.GITHUB_REPOSITORY, pr.head.sha, pr.number);
        if (independent.settled) break;
      }
      found = await eventAdmissionCheck(fetchImpl, env, env.GITHUB_REPOSITORY, pr.head.sha, since, pr.number);
      // On a re-run the admission run may itself be running again under its
      // old id, with its previous attempt's check posted: wait for it to end.
      const settled = found.check && found.check.status === "completed" && (!attempt || !found.run || found.run.status === "completed");
      if (settled || waited >= limit) break;
      const delay = Math.min(pollSeconds, limit - waited);
      await sleep(delay * 1000);
      waited += delay;
    }
    // The independent source decides unless the clued-admission App's
    // event-bound check (disaster recovery only) settled first.
    if (independentSource && (independent?.settled || !(found.check && found.check.status === "completed")))
      return await independentGateOutcome({ env, fetchImpl, outcome, pr, attempt, independent, limit });
    // Merge Admission step 2 (review MINOR-3/4): on a re-run, the newest
    // check for this pull request on this head decides, whichever admission
    // run (or re-verification) posted it: every later check is a later
    // judgement of the same head.
    // (postAppCheck only ever posts completed checks, so an unfinished newer
    // one does not occur.)
    const newer = attempt && found.check && found.newestForPr && found.newestForPr.status === "completed"
      && Number(found.newestForPr.id) > Number(found.check.id) ? found.newestForPr : null;
    const run = newer ?? found.check;
    if (run) {
      outcome.admission_run = { id: run.id, status: run.status, conclusion: run.conclusion ?? null, html_url: run.html_url ?? null,
        workflow_run_id: found.run.id, source: what };
    }
    if (!found.run) {
      outcome.verdict = "NO_ADMISSION_RUN";
      outcome.reasons.push(`no ${what} on ${pr.head.sha} within ${limit}s`);
    } else if (!run || run.status !== "completed") {
      outcome.verdict = "ADMISSION_PENDING";
      outcome.reasons.push(`${what}: run ${found.run.id} ${run ? `check ${run.id} still ${run.status}` : "has posted no check"} after ${limit}s`);
    } else if (attempt && !newer && found.run.status !== "completed") {
      outcome.verdict = "ADMISSION_PENDING";
      outcome.reasons.push(`${what}: run ${found.run.id} is running again (${found.run.status}) after ${limit}s; its check ${run.id} is from an earlier attempt`);
    } else if (run.conclusion === "success") {
      outcome.verdict = "ADMITTED";
      outcome.admitted = true;
    } else {
      outcome.verdict = "REJECTED";
      outcome.reasons.push(`${what} ${run.id} concluded ${run.conclusion}`);
    }
    if (outcome.admitted && !await executionEpochCurrent(fetchImpl, env, env.GITHUB_WORKSPACE, {
      repository: env.GITHUB_REPOSITORY, head_sha: pr.head.sha, pr_ref: outcome.pr_ref, target_branch: pr.base.ref,
    })) {
      outcome.admitted = false;
      outcome.verdict = "REJECTED";
      outcome.reasons.push("work_claim_execution_epoch_stale");
    }
    // Merge Admission v0.1 §10: the gate does not read the policy; it reads
    // the mode main's admission run put in the check's title.
    const label = run && run.status === "completed" ? parseModeLabel(run.output && run.output.title) : null;
    if (label) {
      outcome.admission_mode = { state: label.state, layer: label.layer, reruns_per_head: label.reruns_per_head, source: "admission check title",
        label: `${label.state} · ${label.layer} · reruns ${label.reruns_per_head}` };
    }
    if (attempt && outcome.admitted) {
      const allowed = label ? label.reruns_per_head : 0;
      if (attempt > 1 + allowed) {
        outcome.admitted = false;
        outcome.verdict = "RERUN_REFUSED";
        outcome.reasons.push(`run attempt ${attempt}: ${label ? `the ${label.layer} layer allows ${allowed} re-run(s) per head in ${label.state}` : "the admission check names no re-run allowance"}; ${PR_RERUN_HOWTO}`);
      }
    }
    if (outcome.admitted && automationRouteRequested({ env, run: self })) {
      const route = await qualifyTrustedAutomationRoute({ env, event, run: self, currentAdmission: run,
        read: (route) => githubJson(fetchImpl, env, route) });
      outcome.automation_route = route;
      outcome.automation_self_hosted = false;
      if (!route.qualified) {
        outcome.admitted = false;
        outcome.verdict = "REJECTED";
        outcome.reasons.push(`trusted_automation_route:${route.reason}`);
      } else if (!await executionEpochCurrent(fetchImpl, env, env.GITHUB_WORKSPACE, {
        repository: env.GITHUB_REPOSITORY, head_sha: pr.head.sha, pr_ref: outcome.pr_ref, target_branch: pr.base.ref,
      })) {
        outcome.automation_route = { ...route, qualified: false, reason: "execution_epoch_changed" };
        outcome.admitted = false;
        outcome.verdict = "REJECTED";
        outcome.reasons.push("work_claim_execution_epoch_stale");
      } else outcome.automation_self_hosted = true;
    }
  } catch (error) {
    if (!(error && error.refused)) throw error;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Hand dispatch (Owner Decision 75abfe80). Agents act through the Owner's
// account, so "only the Owner may dispatch" does not require a claim. A heavy
// workflow dispatched by hand runs only after a claim was verified:
//
//   1. Dispatch clued-work-admission-dispatch.yml on the default branch with
//      inputs workflow (one of DISPATCH_GATED_WORKFLOWS), ref and claim_id.
//      That run holds the Clued token (clued-admission environment), verifies
//      the claim and names itself "admit <workflow> <ref> <claim_id>".
//   2. Dispatch the heavy workflow on that ref with admission_run_id = the
//      run id of step 1. Its admission-gate (no token) reads that run and
//      admits only when it succeeded on the default branch within
//      DISPATCH_ADMISSION_TTL_SECONDS and names this workflow and ref.
//
// The admission run must come from the default branch: a copy of the
// dispatch workflow on another branch could skip the check, and the
// environment's branch policy keeps the token from it anyway.

export const DISPATCH_ADMISSION_WORKFLOW = "clued-work-admission-dispatch.yml";
export const DISPATCH_GATED_WORKFLOWS = ["clued-connection-authorization.yml", "clued-g4-database.yml", "information-flow-e2e.yml", "clued-handover-external-qualification.yml", "clued-handover-disposable-idle.yml"];
export const DISPATCH_ADMISSION_TTL_SECONDS = 1800;
export const ADMITTED_HEAD_TITLE = "clued-admitted-head";

// The head the admission run verified, from its own notice annotation. The
// run executes default-branch code only, so the annotation is that code's.
async function admittedHeadOf(fetchImpl, env, runId) {
  const jobs = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${runId}/jobs`);
  for (const job of (jobs && jobs.jobs) || []) {
    const annotations = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/check-runs/${job.id}/annotations`);
    for (const note of Array.isArray(annotations) ? annotations : []) {
      if (note && note.title === ADMITTED_HEAD_TITLE && /^[0-9a-f]{40}$/.test(String(note.message ?? "").trim())) {
        return String(note.message).trim();
      }
    }
  }
  return null;
}
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^(global|project:[0-9a-fA-F-]{36})$/;
const GIT_REF = /^[A-Za-z0-9._/-]{1,200}$/;

export function dispatchTitle(workflow, ref, claimId) {
  return `admit ${workflow} ${ref} ${claimId}`;
}

function workflowFileOf(env) {
  const match = /\.github\/workflows\/([^@/]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? "");
  return match ? match[1] : null;
}

const DISPATCH_HOWTO = `dispatch ${DISPATCH_ADMISSION_WORKFLOW} on the default branch with workflow, ref and claim_id first, then pass its run id as admission_run_id`;

async function dispatchGate({ env, event, fetchImpl, now, outcome }) {
  const workflow = workflowFileOf(env);
  const ref = env.GITHUB_REF_NAME ?? "";
  if(workflow && Object.hasOwn(PUBLISHER_FILES,`.github/workflows/${workflow}`) &&
    !DISPATCH_GATED_WORKFLOWS.includes(workflow)) {
    outcome.verdict="REJECTED";
    outcome.reasons=["publisher_dispatch_not_installed: a qualified self-hosted admission control is required"];
    return outcome;
  }
  if (!workflow || !DISPATCH_GATED_WORKFLOWS.includes(workflow)) {
    outcome.admitted = true;
    outcome.verdict = "NOT_APPLICABLE";
    outcome.reasons = [`workflow ${workflow ?? "unknown"} is not dispatch-gated`];
    return outcome;
  }
  const defaultBranch = (event && event.repository && event.repository.default_branch) || "main";
  const runId = String((event && event.inputs && event.inputs.admission_run_id) ?? "").trim();
  const attempt = rerunAttempt(env);
  if (attempt) {
    outcome.verdict = "RERUN_REFUSED";
    outcome.reasons.push(`run attempt ${attempt}: ${RERUN_HOWTO}`);
  } else if (!/^[0-9]{1,20}$/.test(runId)) {
    outcome.verdict = "REJECTED";
    outcome.reasons.push(`admission_run_missing: ${DISPATCH_HOWTO}`);
  } else {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
    const run = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`, { allowMissing: true });
    if (!run) {
      outcome.verdict = "REJECTED";
      outcome.reasons.push(`admission_run_not_found:${runId}`);
    } else {
      outcome.admission_run = { id: run.id, status: run.status, conclusion: run.conclusion ?? null, html_url: run.html_url ?? null };
      const title = String(run.display_title ?? "").split(" ");
      const expectedPath = `.github/workflows/${DISPATCH_ADMISSION_WORKFLOW}`;
      const runPath = String(run.path ?? "");
      const checks = [
        [runPath === expectedPath || runPath.startsWith(`${expectedPath}@`), `admission_run_wrong_workflow:${runPath}`],
        [run.event === "workflow_dispatch", `admission_run_wrong_event:${run.event}`],
        [run.head_branch === defaultBranch, `admission_run_not_on_default_branch:${run.head_branch}`],
        [run.status === "completed" && run.conclusion === "success", `admission_run_not_successful:${run.status}/${run.conclusion}`],
        [now() - Date.parse(run.created_at) <= DISPATCH_ADMISSION_TTL_SECONDS * 1000, `admission_run_expired:${run.created_at}`],
        [title.length === 4 && title[0] === "admit" && title[1] === workflow && title[2] === ref && CLAIM_ID.test(title[3]),
          `admission_run_other_target:${run.display_title}`],
      ];
      for (const [ok, reason] of checks) if (!ok) outcome.reasons.push(reason);
      if (title.length === 4 && CLAIM_ID.test(title[3])) outcome.claim_id = title[3];
      if (outcome.reasons.length === 0) {
        // Re-review N3: the admission covers the commit it verified, not
        // whatever the ref points at later.
        const admitted = await admittedHeadOf(fetchImpl, env, run.id);
        outcome.head_sha = env.GITHUB_SHA ?? null;
        if (!admitted) outcome.reasons.push("admission_run_head_unknown");
        else if (admitted !== String(env.GITHUB_SHA ?? "").toLowerCase()) outcome.reasons.push(`admission_run_other_head:${admitted}`);
      }
      if (outcome.reasons.length === 0) {
        if (!await executionEpochCurrent(fetchImpl, env, env.GITHUB_WORKSPACE, {
          repository: env.GITHUB_REPOSITORY, head_sha: env.GITHUB_SHA, target_branch: ref, workflow,
        })) outcome.reasons.push("work_claim_execution_epoch_stale");
      }
      if (outcome.reasons.length === 0) {
        outcome.verdict = "ADMITTED";
        outcome.admitted = true;
      } else {
        outcome.verdict = "REJECTED";
      }
    }
  }
  return outcome;
}

// The dispatch admission run (step 1 above). Inputs arrive as environment
// variables; the run must be on the default branch.
async function dispatchAdmitCore({ env, fetchImpl, workspace }) {
  const outcome = emptyOutcome("workflow_dispatch");
  const workflow = String(env.ADMIT_WORKFLOW ?? "").trim();
  const ref = String(env.ADMIT_REF ?? "").trim();
  const claimId = String(env.ADMIT_CLAIM_ID ?? "").trim();
  const scope = String(env.ADMIT_SCOPE ?? "").trim() || "global";
  const defaultBranch = String(env.CLUED_DEFAULT_BRANCH ?? "").trim() || "main";
  if (env.GITHUB_REF !== `refs/heads/${defaultBranch}`) throw new Error(`dispatch admission runs only on ${defaultBranch}, not ${env.GITHUB_REF}.`);
  if (!DISPATCH_GATED_WORKFLOWS.includes(workflow)) throw new Error(`workflow ${workflow} is not dispatch-gated.`);
  if (!GIT_REF.test(ref) || ref.includes("..")) throw new Error(`ref ${ref} is not a branch or tag name.`);
  if (!CLAIM_ID.test(claimId)) throw new Error("claim_id is not a claim id.");
  if (!SCOPE.test(scope)) throw new Error(`scope ${scope} is not global or project:<id>.`);
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  outcome.claim_id = claimId;
  outcome.scope = scope;
  const commit = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/commits/${encodeURIComponent(ref)}`, { allowMissing: true });
  if (!commit || typeof commit.sha !== "string") throw new Error(`ref ${ref} was not found.`);
  outcome.head_sha = commit.sha;
  if (!env.CLUED_CONTEXT_READ_TOKEN) throw new Error("CLUED_CONTEXT_READ_TOKEN is not set; admission cannot be verified.");
  // The dispatched head is metered against the Task's CI budget like a pull
  // request head (re-review MAJOR-6), and the run records the head it
  // admitted, which the heavy workflow's gate compares with its own commit.
  const verified = await verifyClaim(fetchImpl, env, { scope, claim_id: claimId, head_sha: commit.sha,
    ci_dispatch: true, repository: env.GITHUB_REPOSITORY, target_branch: ref, workflow }, workspace);
  if (verified.kind === "rpc_unavailable") throw new Error(`Clued ${VERIFY_RPC} is not deployed (${verified.detail}).`);
  if (verified.kind === "refused") throw new Error(`Clued refused the verification request (${verified.detail}).`);
  outcome.verdict = verified.verdict;
  outcome.reasons.push(...verified.reasons);
  if (verified.payload.claim && typeof verified.payload.claim === "object") {
    const { claim } = verified.payload;
    outcome.claim = {
      task_id: claim.task_id ?? null, status: claim.status ?? null, fence: claim.fence ?? null,
      expires_at: claim.expires_at ?? null, base_commit: claim.base_commit ?? null,
      bound_pr: claim.bound_pr ?? null,
      write_set: Array.isArray(claim.write_set) ? claim.write_set : [],
    };
  }
  outcome.admitted = outcome.verdict === "ADMITTED";
  if (outcome.admitted) console.log(`::notice title=${ADMITTED_HEAD_TITLE}::${commit.sha}`);
  return outcome;
}

// ---------------------------------------------------------------------------
// Reporting.

export function renderSummary(outcome) {
  const lines = [];
  lines.push("## kooyumi-work-admission");
  lines.push("");
  // Merge Admission v0.1 §10: the mode first, then the rules it gave.
  const admission = outcome.admission_mode;
  if (admission) {
    lines.push(`**Mode:** \`${admission.state}\`${admission.layer ? ` · layer \`${admission.layer}\`` : ""} · source \`${admission.source}\`${admission.policy_version ? ` · policy v${admission.policy_version}` : ""}`);
    for (const error of admission.errors ?? []) lines.push(`- fail closed to frozen: ${error}`);
  }
  lines.push(`**Verdict:** \`${outcome.verdict}\` · admitted: \`${outcome.admitted}\` · enforced`);
  if (admission && admission.rules) {
    const columns = ["work_claim", "owner_grant", "up_to_date", "merge_slot", "reruns_per_head", "auto_merge", "merge_actor"];
    lines.push("");
    lines.push(`| ${columns.join(" | ")} |`);
    lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
    lines.push(`| ${columns.map((column) => admission.rules[column]).join(" | ")} |`);
    lines.push("");
  }
  if (outcome.claim_id) lines.push(`**Claim:** \`${outcome.claim_id}\` (scope \`${outcome.scope}\`)`);
  if (outcome.claim) {
    lines.push(`**Claim state:** task \`${outcome.claim.task_id}\` · ${outcome.claim.status} · fence ${outcome.claim.fence} · expires ${outcome.claim.expires_at}${outcome.claim.base_commit ? ` · base \`${outcome.claim.base_commit}\`` : ""}`);
  }
  if (outcome.head_sha) lines.push(`**Head:** \`${outcome.head_sha}\` · **Base:** \`${outcome.base_sha}\``);
  if (outcome.claim && outcome.claim.bound_pr) lines.push(`**Claim bound to:** \`${outcome.claim.bound_pr}\``);
  if (outcome.merge_slot) {
    lines.push(`**Merge slot:** \`${outcome.merge_slot.ref}\` · ${outcome.merge_slot.state}${outcome.merge_slot.until ? ` until ${outcome.merge_slot.until}` : ""}`);
  }
  if (outcome.admission_run) {
    const run = outcome.admission_run;
    lines.push(`**Admission run:** ${run.html_url ? `[${run.id}](${run.html_url})` : run.id} · ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}`);
  }
  if (outcome.error) lines.push(`**Error:** ${outcome.error}`);
  if (outcome.reasons.length) {
    lines.push("");
    lines.push("Reasons:");
    for (const reason of outcome.reasons) lines.push(`- ${reason}`);
  }
  if (outcome.notices && outcome.notices.length) {
    lines.push("");
    lines.push("Notices (not blocking):");
    for (const notice of outcome.notices) lines.push(`- ${notice}`);
  }
  if (outcome.reasons.includes("task_ci_head_cap_reached")) {
    lines.push("");
    lines.push(`This Task already ran CI on ${outcome.task_ci_heads_24h ?? "the maximum number of"} pull-request heads in the last 24 hours (cap ${outcome.task_ci_head_cap ?? 40}, all of its claims together). Each push is one head; the next place frees up at ${outcome.ci_retry_after ?? "the end of the 24-hour window"}. Another claim does not help; push again after that, or tell the Owner.`);
  }
  if (outcome.reasons.includes("claim_head_cap_reached")) {
    lines.push("");
    lines.push(`This claim already admitted ${outcome.admitted_heads ?? "the maximum number of"} pull-request heads (cap ${outcome.max_heads_per_claim ?? 20}, Owner Decision a264ea02). Each push is one head; claim the Task again and put the new claim in the PR.`);
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

// ---------------------------------------------------------------------------
// App-posted check (Owner Decision 37e01bb1). Any job can be named
// kooyumi-work-admission, so a pull request could add one that passes. This
// mode posts the admission result once more as the Owner's dedicated GitHub
// App, whose private key lives only in the clued-admission environment
// (deployment branches: main). The main ruleset can then require
// APP_CHECK_NAME from that App, which no pull-request workflow can post.
// Without the App's id and key it posts nothing and says so.

export const APP_CHECK_NAME = "kooyumi-admission-verified";

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function appJwt(appId, privateKeyPem, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

async function appRequest(fetchImpl, env, method, route, bearer, body) {
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const response = await fetchImpl(`${base}${route}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${bearer}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "clued-work-admission",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${route} returned ${response.status}`);
  return response.json();
}

// Posts one completed kooyumi-admission-verified check as the App. externalId
// names the pull request and the run that decided ("pr:<n>:run:<run id>").
export async function postAppCheckCore({ env, fetchImpl, now = () => Date.now(), headSha, success, title, summary, prNumber, name = APP_CHECK_NAME }) {
  const appId = (env.CLUED_ADMISSION_APP_ID ?? "").trim();
  const key = (env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? "").trim();
  if (!appId || !key) return { posted: false, reason: "the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY)" };
  const repository = env.GITHUB_REPOSITORY;
  let publication = null;
  let publicationSettlement = null;
  let publicationScope = "global";
  let publicationPostStarted = false;
  try {
    if (success) {
      if (!env.CLUED_CONTEXT_READ_TOKEN || !env.GITHUB_TOKEN || !/^[0-9]{1,10}$/.test(String(prNumber ?? ""))) {
        throw new Error("live publication verification credentials or pull request are missing");
      }
      const pr = await githubJson(fetchImpl, env, `/repos/${repository}/pulls/${prNumber}`);
      if (pr?.state !== "open" || pr?.head?.sha !== headSha) throw new Error("the publication head is no longer current");
      const reference = await claimReferenceOf(fetchImpl, env, pr);
      publicationScope = reference?.scope ?? "global";
      const paths = await changedPathsOfPullRequest(fetchImpl, env, repository, prNumber);
      if (paths.file_count !== pr.changed_files) throw new Error("publication changed paths are incomplete");
      const publicationReply = await cluedRpc(fetchImpl, env, env.GITHUB_WORKSPACE, VERIFY_RPC, {
        action: "publication_begin", scope: publicationScope, ...(reference ?? {}),
        pr_ref: `${repository}#${prNumber}`, head_sha: headSha, base_sha: pr.base.sha,
        target_branch: pr.base.ref, changed_paths: paths.paths, run_id: String(env.GITHUB_RUN_ID),
        publication_key: randomUUID(),
      });
      if (publicationReply.status !== 200 || !publicationReply.body || typeof publicationReply.body !== "object") {
        throw new Error(`live publication verification failed: ${publicationReply.detail}`);
      }
      publication = publicationReply.body;
      if (typeof publication.scope === "string") publicationScope = publication.scope;
      if (publication.publication_required !== false && publication.verdict !== "ADMITTED") {
        success = false; title = "REJECTED: handover authorization changed";
        summary = "The live work authorization no longer admits this publication.";
      }
    }
    const jwt = appJwt(appId, key, Math.floor(now() / 1000));
    const installation = await appRequest(fetchImpl, env, "GET", `/repos/${repository}/installation`, jwt);
    const token = await appRequest(fetchImpl, env, "POST", `/app/installations/${installation.id}/access_tokens`, jwt,
      { repositories: [repository.split("/")[1]], permissions: { checks: "write" } });
    const number = String(prNumber ?? "").trim();
    const runId = String(env.GITHUB_RUN_ID ?? "").trim();
    const externalId = /^[0-9]{1,10}$/.test(number) && /^[0-9]{1,20}$/.test(runId)
      ? `pr:${number}:run:${runId}` + (publication?.publication_id ? `:publication:${publication.publication_id}` : "") : undefined;
    publicationPostStarted = true;
    const check = await appRequest(fetchImpl, env, "POST", `/repos/${repository}/check-runs`, token.token, {
      name, head_sha: headSha, status: "completed", conclusion: success ? "success" : "failure",
      ...(externalId ? { external_id: externalId } : {}),
      output: { title, summary },
    });
    if (publication?.publication_id) {
      const finishReply = await cluedRpc(fetchImpl, env, env.GITHUB_WORKSPACE, VERIFY_RPC, {
        action: "publication_finish", scope: publicationScope,
        publication_id: publication.publication_id, check_run_id: String(check.id),
      });
      if (finishReply.status !== 200 || finishReply.body?.status !== "committed") {
        throw new Error(`publication settlement failed: ${finishReply.detail}`);
      }
      const finished = finishReply.body;
      publicationSettlement = finished;
      if (finished.must_revoke) {
        await appRequest(fetchImpl, env, "PATCH", `/repos/${repository}/check-runs/${check.id}`, token.token, {
          status: "completed", conclusion: "failure", output: {
            title: "REJECTED: handover superseded this publication",
            summary: "This publication finished after its execution epoch was revoked.",
          },
        });
        success = false;
      }
    }
    return { posted: true, head_sha: headSha, conclusion: success ? "success" : "failure", check_run_id: check.id ?? null,
      ...(publication?.publication_id ? { external_id: externalId, publication_observation: {
        publication_id: publication.publication_id, begin_receipt_id: publication.receipt_id,
        begin_execution_epoch: publication.execution_epoch ?? publication.claim?.execution_epoch,
        finish_receipt_id: publicationSettlement?.receipt_id,
        finish_execution_epoch: publicationSettlement?.execution_epoch,
        finish_status: publicationSettlement?.status, must_revoke: publicationSettlement?.must_revoke,
      }} : {}) };
  } catch (error) {
    if (publication?.publication_id && !publicationPostStarted) {
      // This path knows the check POST was never sent. An uncertain POST
      // leaves its ticket open until its exact external effect is found.
      await cluedRpc(fetchImpl, env, env.GITHUB_WORKSPACE, VERIFY_RPC, {
        action: "publication_abort", scope: publicationScope, publication_id: publication.publication_id, not_sent: true,
      }).catch(() => {});
    }
    return { posted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function postAppCheck(args) {
  const recorder=args.observation_recorder??createNaturalRecorder({env:args.env,sourceUrl:import.meta.url,sourcePath:"scripts/ci/clued-work-admission.mjs"});let result=null;
  try {result=await postAppCheckCore(args);return result;}
  finally {
    recorder.record("app_check",{prNumber:args.prNumber,headSha:args.headSha,name:args.name??APP_CHECK_NAME,result,
      admitStepOutcome:args.env.ADMISSION_OUTCOME,failure_code:!(args.env.CLUED_ADMISSION_APP_ID??"").trim()?"APP_NOT_CONFIGURED":"APP_POST_FAILED"});
    if(!args.observation_recorder)recorder.finish(result===null?"exception":"returned");
  }
}

export async function appCheck({ env, fetchImpl, now = () => Date.now(), observation_recorder }) {
  const headSha = (env.ADMISSION_HEAD_SHA ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    const configured = (env.CLUED_ADMISSION_APP_ID ?? "").trim() && (env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? "").trim();
    if (!configured) return { posted: false, reason: "the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY)" };
    return { posted: false, reason: "the admission step reported no head commit; nothing to post (the required check stays missing)" };
  }
  const success = env.ADMISSION_OUTCOME === "success";
  const verdict = (env.ADMISSION_VERDICT ?? "").trim() || (success ? "ADMITTED" : "NOT ADMITTED");
  // Merge Admission v0.1 §10: the title names the mode, "ADMITTED [normal · code · reruns 0]".
  const mode = (env.ADMISSION_MODE ?? "").replace(/[\r\n[\]]/g, " ").trim();
  const result = await postAppCheck({
    env, fetchImpl, now, observation_recorder, headSha, success, title: mode ? `${verdict} [${mode}]` : verdict, prNumber: env.ADMISSION_PR_NUMBER,
    summary: `kooyumi-work-admission ${success ? "admitted" : "did not admit"} this head (run ${env.GITHUB_RUN_ID ?? "?"})${mode ? ` in mode ${mode}` : ""}.`,
  });
  // The merge slot check on the same head (Owner Decision 2ea795e4).
  const slot = mergeSlotCheck({ admitted: success, state: (env.ADMISSION_MERGE_SLOT ?? "").trim(),
    ref: (env.ADMISSION_MERGE_SLOT_REF ?? "").trim(), until: (env.ADMISSION_MERGE_SLOT_UNTIL ?? "").trim(),
    tip: (env.ADMISSION_MERGE_SLOT_TIP ?? "").trim(), claimId: (env.ADMISSION_CLAIM_ID ?? "").trim(),
    branch: (env.ADMISSION_BASE_REF ?? "").trim(), mode });
  result.merge_slot = await postAppCheck({
    env, fetchImpl, now, observation_recorder, headSha, success: slot.success, title: slot.title, summary: slot.summary,
    prNumber: env.ADMISSION_PR_NUMBER, name: MERGE_SLOT_CHECK_NAME,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Multi-copy write-back (GenericWorkClaim §5.3). When the Owner runs a Task as
// a race, each copy works on its own pull request and every one is admitted.
// The first copy's pull request to merge is the adopted copy: this mode runs
// on `pull_request_target: closed` for a merged pull request and reports it to
// Clued (clued_work_claim_adopt_v1, same endpoint, key and Binding token hash
// as verify). Clued adopts the copy bound to this pull request, if any, and
// puts the other copies out; their pull requests then fail the next
// verification. A pull request that is not a copy is answered no_copy_for_pr
// and nothing changes.

export const ADOPT_RPC = "clued_work_claim_adopt_v1";
export const ADOPT_QUIET_REASONS = new Set(["no_copy_for_pr", "not_a_copy"]);
// A pull request closed without a merge gives its merge slot back
// (migration 20261006120000, Owner Decision 2ea795e4).
export const MERGE_SLOT_RETURN_RPC = "clued_work_merge_slot_return_v1";

async function claimReferenceOf(fetchImpl, env, pr) {
  let reference = parseClaimReference(pr.body);
  if (!reference && env.GITHUB_TOKEN && pr.head && pr.head.sha) {
    const commit = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/commits/${pr.head.sha}`);
    reference = parseClaimReference(commit && commit.commit && commit.commit.message);
  }
  return reference;
}

export async function cluedRpc(fetchImpl, env, workspace, rpc, input) {
  const { url: base, key } = resolvePublicSupabaseConfig(env, workspace);
  const response = await fetchImpl(`${base}/rest/v1/rpc/${rpc}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "clued-work-admission",
    },
    body: JSON.stringify({ p_token_hash: sha256Hex(env.CLUED_CONTEXT_READ_TOKEN), p_input: input }),
  });
  let text = "";
  let body = null;
  try {
    text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, detail: describe(response.status, body, text, response.headers) };
}

async function returnMergeSlot({ env, pr, fetchImpl, workspace, result }) {
  result.pr_ref = `${env.GITHUB_REPOSITORY}#${pr.number}`;
  result.closed_unmerged = true;
  if (!env.CLUED_CONTEXT_READ_TOKEN) {
    result.reason = "CLUED_CONTEXT_READ_TOKEN is not set; merge slot not returned";
    return result;
  }
  try {
    const reference = await claimReferenceOf(fetchImpl, env, pr);
    if (!reference) {
      result.reason = "no Clued-Work-Claim trailer; no merge slot to return";
      return result;
    }
    result.claim_id = reference.claim_id;
    result.scope = reference.scope;
    const { status, body, detail } = await cluedRpc(fetchImpl, env, workspace, MERGE_SLOT_RETURN_RPC,
      { scope: reference.scope, pr_ref: result.pr_ref });
    if (status === 404 && body && body.code === "PGRST202") {
      result.reason = `${MERGE_SLOT_RETURN_RPC} is not deployed (${detail}); the slot lapses on its own`;
      return result;
    }
    if (status !== 200 || !body || typeof body !== "object" || body.status !== "ok") {
      throw new Error(`Clued ${MERGE_SLOT_RETURN_RPC} returned ${detail}`);
    }
    result.payload = body;
    if (body.reason === "admission_binding_required") {
      result.error = "merge slot not returned: admission_binding_required";
      return result;
    }
    const returned = Array.isArray(body.merge_slot_returned) ? body.merge_slot_returned : [];
    result.merge_slot_returned = returned;
    result.reason = returned.length ? `closed without a merge; merge slot returned (${returned.join(", ")})` : "closed without a merge; no merge slot held";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export async function adoptMerged({ env, event, eventName, fetchImpl, workspace }) {
  const pr = event && event.pull_request;
  const result = { adopted: false, pr_ref: null, merge_sha: null, claim_id: null, scope: null, reason: null, error: null, payload: null };
  if (eventName === "pull_request_target" && event && event.action === "closed" && pr && pr.merged === false) {
    return returnMergeSlot({ env, pr, fetchImpl, workspace, result });
  }
  if (eventName !== "pull_request_target" || !event || event.action !== "closed" || !pr || pr.merged !== true) {
    result.reason = "not a merged pull request";
    return result;
  }
  result.pr_ref = `${env.GITHUB_REPOSITORY}#${pr.number}`;
  result.merge_sha = typeof pr.merge_commit_sha === "string" ? pr.merge_commit_sha.toLowerCase() : null;
  if (!result.merge_sha || !/^[0-9a-f]{40}$/.test(result.merge_sha)) {
    result.error = "the merged pull request has no merge commit SHA";
    return result;
  }
  if (!env.CLUED_CONTEXT_READ_TOKEN) {
    result.reason = "CLUED_CONTEXT_READ_TOKEN is not set; adoption skipped";
    return result;
  }
  try {
    // Only a pull request that names a claim can be a copy; its scope trailer
    // picks the context the claim lives in.
    const reference = await claimReferenceOf(fetchImpl, env, pr);
    if (!reference) {
      result.reason = "no Clued-Work-Claim trailer; not a copy";
      return result;
    }
    result.claim_id = reference.claim_id;
    result.scope = reference.scope;
    const response = await cluedRpc(fetchImpl, env, workspace, ADOPT_RPC,
      { scope: reference.scope, pr_ref: result.pr_ref, merge_sha: result.merge_sha });
    const { body, detail } = response;
    if (response.status === 404 && body && body.code === "PGRST202") {
      result.reason = `${ADOPT_RPC} is not deployed (${detail}); adoption skipped`;
      return result;
    }
    if (response.status !== 200 || !body || typeof body !== "object") throw new Error(`Clued ${ADOPT_RPC} returned ${detail}`);
    result.payload = body;
    if (Array.isArray(body.merge_slot_returned)) result.merge_slot_returned = body.merge_slot_returned;
    if (body.status === "rejected") {
      result.reason = `${body.error_code ?? "rejected"}: another copy of this Task was adopted first`;
      return result;
    }
    if (body.status !== "ok") throw new Error(`Clued ${ADOPT_RPC} returned status ${String(body.status)} (${detail})`);
    result.adopted = body.adopted === true;
    if (!result.adopted) {
      result.reason = typeof body.reason === "string" ? body.reason : "not adopted";
      // Re-review 7, m6: only "this pull request is no copy" is a quiet
      // outcome. Anything else (admission_binding_required after a rotation,
      // an unknown answer) leaves the race undecided, so the job fails.
      if (!ADOPT_QUIET_REASONS.has(result.reason)) result.error = `not adopted: ${result.reason}`;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function renderAdoptSummary(result) {
  const lines = [result.closed_unmerged ? "## kooyumi-work-admission: merge slot of a closed pull request"
    : "## kooyumi-work-admission: multi-copy adoption", ""];
  lines.push(`- Pull request: ${result.pr_ref ?? "n/a"}`);
  if (result.merge_sha) lines.push(`- Merge commit: \`${result.merge_sha}\``);
  if (result.claim_id) lines.push(`- Claim: \`${result.claim_id}\` (${result.scope})`);
  if (result.adopted) {
    const out = Array.isArray(result.payload?.not_adopted) ? result.payload.not_adopted.length : 0;
    lines.push(`- Adopted copy ${result.payload?.copy_index ?? "?"} of Task \`${result.payload?.task_id ?? "?"}\`${result.payload?.replayed ? " (already adopted)" : ""}; ${out} other cop${out === 1 ? "y" : "ies"} put out.`);
  }
  if (!result.closed_unmerged && Array.isArray(result.merge_slot_returned) && result.merge_slot_returned.length) {
    lines.push(`- Merge slot returned: ${result.merge_slot_returned.map((id) => `\`${id}\``).join(", ")}`);
  }
  if (result.reason) lines.push(`- ${result.reason}`);
  if (result.error) lines.push(`- Error: ${result.error}`);
  lines.push("");
  return lines.join("\n");
}

// The merge slot state for the app-check step; without one (admission
// stopped before verifying), unknown, which fails the check.
export function mergeSlotOutputs(outcome) {
  const slot = outcome.merge_slot;
  const clean = (value) => String(value ?? "").replace(/[\r\n]/g, " ");
  const state = slot ? slot.state : "unknown";
  return [`merge_slot=${clean(state)}`, `merge_slot_ref=${clean(slot && slot.ref)}`,
    `merge_slot_until=${clean(slot && slot.until)}`, `merge_slot_tip=${clean(slot && slot.tip)}`];
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, { readPolicyFile = fs.readFileSync } = {}) {
  const modeIndex = argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "required";
  if (!["required", "gate", "reverify", "dispatch-admit", "app-check", "adopt"].includes(mode)) {
    console.error("usage: clued-work-admission.mjs --mode required|gate|reverify|dispatch-admit|app-check|adopt");
    return 2;
  }
  if (mode === "adopt") {
    let event = null;
    if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
      event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    }
    const result = await adoptMerged({ env, event, eventName: env.GITHUB_EVENT_NAME ?? "", fetchImpl, workspace: env.GITHUB_WORKSPACE });
    console.log(JSON.stringify(result, null, 2));
    appendFile(env.GITHUB_STEP_SUMMARY, renderAdoptSummary(result));
    if (result.error) {
      console.error(`::error title=kooyumi-work-admission adoption::${result.error}`);
      return 1;
    }
    if (result.payload?.status === "rejected") console.error(`::warning title=kooyumi-work-admission adoption::${result.reason}`);
    return 0;
  }
  if (mode === "app-check") {
    const result = await appCheck({ env, fetchImpl });
    console.log(JSON.stringify(result, null, 2));
    if (result.error) {
      console.error(`::error title=${APP_CHECK_NAME}::${result.error}`);
      return 1;
    }
    if (result.merge_slot && result.merge_slot.error) {
      console.error(`::error title=${MERGE_SLOT_CHECK_NAME}::${result.merge_slot.error}`);
      return 1;
    }
    if (!result.posted) console.error(`::notice title=${APP_CHECK_NAME}::${result.reason}`);
    return 0;
  }
  if (mode === "reverify") {
    const result = await reverify({ env, fetchImpl, workspace: env.GITHUB_WORKSPACE, readPolicyFile });
    console.log(JSON.stringify(result, null, 2));
    appendFile(env.GITHUB_STEP_SUMMARY, renderReverifySummary(result));
    if (result.errors.length) {
      console.error(`::error title=kooyumi-work-admission re-verification::${result.errors.length} PR(s) could not be re-verified`);
      return 1;
    }
    return 0;
  }
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  let event = null;
  if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  }
  let outcome;
  try {
    if (mode === "gate") outcome = await gate({ env, event, eventName, fetchImpl });
    else if (mode === "dispatch-admit") outcome = await dispatchAdmit({ env, fetchImpl, workspace: env.GITHUB_WORKSPACE });
    else outcome = await evaluate({ env, event, eventName, fetchImpl, workspace: env.GITHUB_WORKSPACE, withSummary: true, readPolicyFile });
  } catch (error) {
    // Review MINOR-2: an admission run that fails still says in which mode.
    const admissionMode = mode === "required" ? resolveMode({ env, workspace: env.GITHUB_WORKSPACE, readFile: readPolicyFile }) : null;
    outcome = emptyOutcome(eventName);
    if (admissionMode) outcome.admission_mode = modeOutcome(admissionMode);
    outcome.verdict = "ERROR";
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  outcome.mode = mode;
  console.log(JSON.stringify(outcome, null, 2));
  appendFile(env.GITHUB_STEP_SUMMARY, renderSummary(outcome));
  appendFile(env.GITHUB_OUTPUT, [
    `admitted=${outcome.admitted ? "true" : "false"}`,
    `automation_self_hosted=${outcome.admitted && outcome.automation_self_hosted === true ? "true" : "false"}`,
    `enforced=${String(outcome.enforced)}`,
    `verdict=${outcome.verdict ?? ""}`,
    `claim_id=${outcome.claim_id ?? ""}`,
    `head_sha=${outcome.head_sha ?? ""}`,
    `admission_mode=${String((outcome.admission_mode && outcome.admission_mode.label) ?? "").replace(/[\r\n]/g, " ")}`,
    ...mergeSlotOutputs(outcome),
    "",
  ].join("\n"));
  if (outcome.error) {
    console.error(`::error title=kooyumi-work-admission::${withTokenHint(outcome.error)}`);
    return 1;
  }
  // PR_NOT_OPEN: the workflow posts no check for it, but the run still fails:
  // the runner hook admits a workflow-changing pull request's jobs on the
  // admission run's success alone (confirmation review MAJOR-N1).
  if (outcome.verdict === "PR_NOT_OPEN") {
    console.error(`::error title=kooyumi-work-admission::${outcome.reasons.join("; ")}`);
    return 1;
  }
  if (!outcome.admitted) {
    const text = withTokenHint(`${outcome.verdict}: ${outcome.reasons.join("; ")}`);
    if (mode === "required" || mode === "dispatch-admit") {
      console.error(`::error title=kooyumi-work-admission::${text}`);
      return 1;
    }
    // Merge Admission step 2 (review MAJOR-1): on attempt 1 a gate that does
    // not admit succeeds and its heavy jobs are skipped (the admission check
    // already shows why). A re-run that is not admitted fails instead, so the
    // run is red and skipped heavy jobs never look like a pass.
    if (mode === "gate" && rerunAttempt(env)) {
      console.error(`::error title=admission-gate::${text}; this re-run did not run the heavy jobs.`);
      return 1;
    }
    console.error(`::warning title=admission-gate::${text}; heavy jobs are skipped.`);
    return 0;
  }
  return 0;
}

// PermissionSimplification §3.5: a missing token, or one whose Binding no
// longer holds the ci-admission role (for example after a rotation moved the
// role to a new token), names the secret to update instead of only the code.
export const ADMISSION_TOKEN_HINT = "Fix: set the clued-admission environment secret CLUED_ADMISSION_CLUED_TOKEN "
  + "to the token of the Binding that holds the ci-admission role (Clued /oauth/connections). "
  + "A rotation moves the role to the new token at once; update the secret with the new token.";
export function withTokenHint(text) {
  return /CLUED_CONTEXT_READ_TOKEN is not set|admission_binding_required/.test(text)
    ? `${text} ${ADMISSION_TOKEN_HINT}` : text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Both the trusted publisher and the branch gate use native fetch. Reuse
  // the installed hook's bounded routing setup without changing credentials,
  // TLS, admission rules or any machine setting.
  try {
    const proxyArguments = proxyBootstrapArguments();
    if (proxyArguments) {
      const child = spawnSync(process.execPath, proxyArguments, { env: process.env, stdio: "inherit" });
      if (child.error) throw new Error("The proxy-enabled admission process could not start.");
      process.exit(Number.isInteger(child.status) ? child.status : 1);
    }
  } catch (error) {
    console.error(`::error title=admission-gate::${error.message}`);
    process.exit(1);
  }
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}

// The original dispatch has no per-PR final envelope; retain its real event without assigning a fake target.
export async function dispatchAdmit(args) {
  const recorder=createNaturalRecorder({env:args.env,workspace:args.workspace,sourceUrl:import.meta.url,sourcePath:"scripts/ci/clued-work-admission.mjs"});
  return observeEvaluation(dispatchAdmitCore,{...args,observation_entry:"dispatch_admit",observation_close_owned:true},recorder);
}
