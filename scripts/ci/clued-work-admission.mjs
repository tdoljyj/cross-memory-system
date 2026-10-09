#!/usr/bin/env node
// Work Claim Admission v0.1, step 3 (development/contracts/execution-admission/
// WorkClaimAdmission.v0.1.md §4.6 L0a/L0b). One script, four modes:
//
//   --mode required   the unfiltered `clued-work-admission` check on every PR
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
// The admission run also posts the clued-merge-slot check (mergeSlotState()):
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

import { createHash, createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
]);
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

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
  let inJob = false;
  for (let i = jobsLines[0][1] + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) break;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^  [A-Za-z0-9_-]+:\s*(#.*)?$/.test(line)) { inJob = true; continue; }
    if (inJob && /^ {4,}\S/.test(line)) continue;
    findings.push(`workflow_not_canonical:job_line:${i + 1}`);
  }
  return [...new Set(findings)];
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
  const value = jobField(job, "runs-on");
  if (value === null) return false;
  const text = value.replace(/(^|\s)#.*$/gm, "").trim();
  if (text.includes("\n")) return false;
  return HOSTED_LABEL.test(unquote(text)) || text === HOSTED_STATE_CHANGE_RUNNER;
}

// Findings for one workflow at the PR head; baseText is its base-branch
// version, or null when the PR adds it. Existing ungated workflows (the
// short checks of Owner Decision 75abfe80) stay ungated.
export function gateFindings(headText, baseText) {
  const form = workflowFormFindings(headText);
  if (form.length) return form;
  const jobs = workflowJobs(headText);
  const selfHosted = jobs.some((job) => !jobIsHosted(job));
  const required = baseText === null ? selfHosted : workflowIsGated(baseText);
  if (!required) {
    // An existing ungated workflow (a short check) may not grow a job that can
    // reach a self-hosted runner: no new one, no hosted job moved to a
    // self-hosted runner, and (re-review 3, N-R5) no self-hosted job that
    // drops or raises its timeout-minutes.
    if (baseText === null) return [];
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
        // job; one admitted head would buy many self-hosted runs.
        if ((jobField(job, "strategy") ?? "").trim() !== (jobField(old, "strategy") ?? "").trim()) {
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
    for (const finding of gateFindings(head, base)) gate.push(`workflow_gate:${file.filename}:${finding}`);
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
const DEFAULT_CONFIRM_ORIGIN = "https://clued.pixelgrav.com";

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
// Only an earlier head whose clued-admission-verified check ever passed is
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
    const checks = await appChecksOnHead(fetchImpl, env, repository, earlier);
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
export async function evaluate({ env, event, eventName, fetchImpl, workspace, withSummary, readPolicyFile = fs.readFileSync }) {
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
// posts the clued-merge-slot check as the clued-admission App: it fails while
// the head contains the base branch's tip and the claim does not hold the slot,
// so once the Owner makes the check required, nobody can merge without it.
// A head that does not contain the tip passes: GitHub blocks its merge anyway.
// It is a check of its own because the heavy workflows' gates follow
// clued-admission-verified, and they must still run on a head that merely
// happens to contain the tip.
export const MERGE_SLOT_CHECK_NAME = "clued-merge-slot";

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
      summary: "clued-work-admission did not admit this head, so it cannot hold the merge slot." };
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
// clued-admission-verified App check (the one the ruleset reads) is a success,
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
  const checks = await githubPaged(fetchImpl, env,
    `/repos/${repository}/commits/${headSha}/check-runs?check_name=${name}&filter=all`, "check_runs");
  return checks
    .filter((check) => check && check.name === name && check.head_sha === headSha
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

export async function reverify({ env, fetchImpl, workspace, now = () => Date.now(), readPolicyFile = fs.readFileSync }) {
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
  const pulls = await githubPaged(fetchImpl, env, `/repos/${repository}/pulls?state=open`);
  for (const pr of pulls) {
    if (pr.draft || !pr.head || !pr.base) continue;
    const defaultBranch = pr.base.repo && pr.base.repo.default_branch;
    if (defaultBranch && pr.base.ref !== defaultBranch) continue;
    if (stateChange) {
      try {
        const outcome = await evaluate({ env, event: { pull_request: pr }, eventName: "pull_request_target", fetchImpl, workspace, withSummary: false, readPolicyFile });
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
      if (!admissionGreen && !slotGreen) continue;
      const outcome = await evaluate({ env, event: { pull_request: pr }, eventName: "pull_request_target", fetchImpl, workspace, withSummary: false, readPolicyFile });
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
      result.errors.push({ pr: pr.number, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function renderReverifySummary(result) {
  const lines = ["## clued-work-admission re-verification", ""];
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
// the clued-admission-verified check of the clued-admission App that main's
// admission run of the same event posts on this head (eventAdmissionCheck
// below); only main's admission run can post it, so neither a look-alike job in a PR workflow nor an admission run of
// a pull request into another branch satisfies the gate. Both start on the
// same push, so the gate waits for the check. A PR that edits this script or
// its gate job changes only its own cost gating; the required check, which
// merging needs, is unaffected.

export const GATE_WAIT_SECONDS = 480;
export const GATE_POLL_SECONDS = 10;

// Re-review 2, N3c: the pull_requests list of a run names every open pull
// request with that head, not the one that triggered it, so a pull request
// into another branch, whose copy of the admission workflow passes anything,
// could stand in. The trusted signal is the clued-admission-verified check of
// the clued-admission App on the head: its key lives in the clued-admission
// environment, which deploys from main only, and main's admission job checks
// out main and runs only for pull requests into main (re-review 6, B1). The
// gate job needs `checks: read` to read it.
export const ADMISSION_APP_ID = 5164952;

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
const EXTERNAL_ID = /^pr:([0-9]{1,10}):run:([0-9]{1,20})$/;
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
const PR_RERUN_HOWTO = "only \"Re-run all jobs\" of the current head's run, as many times as the clued-admission-verified title allows; push a new commit otherwise";

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
  const waitSeconds = Number.parseInt(env.CLUED_ADMISSION_GATE_WAIT_SECONDS ?? "", 10);
  const limit = Number.isInteger(waitSeconds) && waitSeconds >= 0 ? waitSeconds : GATE_WAIT_SECONDS;
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
    const what = `${APP_CHECK_NAME} of App ${ADMISSION_APP_ID} for #${pr.number} from the admission run of this event (created since ${self.created_at} less ${SAME_EVENT_MS / 1000}s)`;
    for (let waited = 0; ; waited += GATE_POLL_SECONDS) {
      found = await eventAdmissionCheck(fetchImpl, env, env.GITHUB_REPOSITORY, pr.head.sha, since, pr.number);
      // On a re-run the admission run may itself be running again under its
      // old id, with its previous attempt's check posted: wait for it to end.
      const settled = found.check && found.check.status === "completed" && (!attempt || !found.run || found.run.status === "completed");
      if (settled || waited >= limit) break;
      await sleep(GATE_POLL_SECONDS * 1000);
    }
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
export const DISPATCH_GATED_WORKFLOWS = ["clued-connection-authorization.yml", "clued-g4-database.yml", "information-flow-e2e.yml"];
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
export async function dispatchAdmit({ env, fetchImpl, workspace }) {
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
  const verified = await verifyClaim(fetchImpl, env, { scope, claim_id: claimId, head_sha: commit.sha, ci_dispatch: true }, workspace);
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
  lines.push("## clued-work-admission");
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
// clued-work-admission, so a pull request could add one that passes. This
// mode posts the admission result once more as the Owner's dedicated GitHub
// App, whose private key lives only in the clued-admission environment
// (deployment branches: main). The main ruleset can then require
// APP_CHECK_NAME from that App, which no pull-request workflow can post.
// Without the App's id and key it posts nothing and says so.

export const APP_CHECK_NAME = "clued-admission-verified";

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

// Posts one completed clued-admission-verified check as the App. externalId
// names the pull request and the run that decided ("pr:<n>:run:<run id>").
export async function postAppCheck({ env, fetchImpl, now = () => Date.now(), headSha, success, title, summary, prNumber, name = APP_CHECK_NAME }) {
  const appId = (env.CLUED_ADMISSION_APP_ID ?? "").trim();
  const key = (env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? "").trim();
  if (!appId || !key) return { posted: false, reason: "the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY)" };
  const repository = env.GITHUB_REPOSITORY;
  try {
    const jwt = appJwt(appId, key, Math.floor(now() / 1000));
    const installation = await appRequest(fetchImpl, env, "GET", `/repos/${repository}/installation`, jwt);
    const token = await appRequest(fetchImpl, env, "POST", `/app/installations/${installation.id}/access_tokens`, jwt,
      { repositories: [repository.split("/")[1]], permissions: { checks: "write" } });
    const number = String(prNumber ?? "").trim();
    const runId = String(env.GITHUB_RUN_ID ?? "").trim();
    const externalId = /^[0-9]{1,10}$/.test(number) && /^[0-9]{1,20}$/.test(runId) ? `pr:${number}:run:${runId}` : undefined;
    const check = await appRequest(fetchImpl, env, "POST", `/repos/${repository}/check-runs`, token.token, {
      name, head_sha: headSha, status: "completed", conclusion: success ? "success" : "failure",
      ...(externalId ? { external_id: externalId } : {}),
      output: { title, summary },
    });
    return { posted: true, head_sha: headSha, conclusion: success ? "success" : "failure", check_run_id: check.id ?? null };
  } catch (error) {
    return { posted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function appCheck({ env, fetchImpl, now = () => Date.now() }) {
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
    env, fetchImpl, now, headSha, success, title: mode ? `${verdict} [${mode}]` : verdict, prNumber: env.ADMISSION_PR_NUMBER,
    summary: `clued-work-admission ${success ? "admitted" : "did not admit"} this head (run ${env.GITHUB_RUN_ID ?? "?"})${mode ? ` in mode ${mode}` : ""}.`,
  });
  // The merge slot check on the same head (Owner Decision 2ea795e4).
  const slot = mergeSlotCheck({ admitted: success, state: (env.ADMISSION_MERGE_SLOT ?? "").trim(),
    ref: (env.ADMISSION_MERGE_SLOT_REF ?? "").trim(), until: (env.ADMISSION_MERGE_SLOT_UNTIL ?? "").trim(),
    tip: (env.ADMISSION_MERGE_SLOT_TIP ?? "").trim(), claimId: (env.ADMISSION_CLAIM_ID ?? "").trim(),
    branch: (env.ADMISSION_BASE_REF ?? "").trim(), mode });
  result.merge_slot = await postAppCheck({
    env, fetchImpl, now, headSha, success: slot.success, title: slot.title, summary: slot.summary,
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
  const lines = [result.closed_unmerged ? "## clued-work-admission: merge slot of a closed pull request"
    : "## clued-work-admission: multi-copy adoption", ""];
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
      console.error(`::error title=clued-work-admission adoption::${result.error}`);
      return 1;
    }
    if (result.payload?.status === "rejected") console.error(`::warning title=clued-work-admission adoption::${result.reason}`);
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
      console.error(`::error title=clued-work-admission re-verification::${result.errors.length} PR(s) could not be re-verified`);
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
    `enforced=${String(outcome.enforced)}`,
    `verdict=${outcome.verdict ?? ""}`,
    `claim_id=${outcome.claim_id ?? ""}`,
    `head_sha=${outcome.head_sha ?? ""}`,
    `admission_mode=${String((outcome.admission_mode && outcome.admission_mode.label) ?? "").replace(/[\r\n]/g, " ")}`,
    ...mergeSlotOutputs(outcome),
    "",
  ].join("\n"));
  if (outcome.error) {
    console.error(`::error title=clued-work-admission::${withTokenHint(outcome.error)}`);
    return 1;
  }
  // PR_NOT_OPEN: the workflow posts no check for it, but the run still fails:
  // the runner hook admits a workflow-changing pull request's jobs on the
  // admission run's success alone (confirmation review MAJOR-N1).
  if (outcome.verdict === "PR_NOT_OPEN") {
    console.error(`::error title=clued-work-admission::${outcome.reasons.join("; ")}`);
    return 1;
  }
  if (!outcome.admitted) {
    const text = withTokenHint(`${outcome.verdict}: ${outcome.reasons.join("; ")}`);
    if (mode === "required" || mode === "dispatch-admit") {
      console.error(`::error title=clued-work-admission::${text}`);
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
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
