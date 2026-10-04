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
//   --mode adopt      the run on a merged pull request: reports the merge to
//                     Clued so that, when the Task runs as a multi-copy race,
//                     the copy on this pull request is adopted (adoptMerged())
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
// Enforcement is the Owner's explicit switch, the repository variable
// CLUED_WORK_ADMISSION_ENFORCE=true. Until it is on, the check is advisory: a
// PR that names a claim gets its verdict in the summary, a PR without one is
// reported NOT_ENFORCED, and both are admitted, so nothing changes while the
// migrations, Worker flag and Agent-side claiming are still rolling out. Once
// it is on, a missing trailer, a REJECTED verdict, a missing RPC, a refused
// token or a transport error all fail closed. Non-PR events (push to main,
// dispatch) are not admission subjects and are admitted.
//
// CLUED_CONTEXT_READ_TOKEN is read only by the jobs that run default-branch
// code (the pull_request_target check, the scheduled re-verification and the
// dispatch admission), all in the `clued-admission` environment. No `pull_request` job, whose code the PR
// controls, is given it.
//
// No dependencies: Node 20+ fetch, crypto and fs only, so a hosted runner
// finishes in seconds without an install.

import { createHash, createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function enforcementEnabled(env) {
  return /^(1|true|on|enabled)$/i.test((env.CLUED_WORK_ADMISSION_ENFORCE ?? "").trim());
}

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

export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1; // `**/` also matches zero directories
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

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

async function githubJson(fetchImpl, env, route, { allowMissing = false } = {}) {
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

async function githubPost(fetchImpl, env, route) {
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const response = await fetchImpl(`${base}${route}`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "clued-work-admission",
    },
  });
  if (!response.ok) throw new Error(`GitHub API POST ${route} returned ${response.status}`);
}

async function githubPaged(fetchImpl, env, route, key) {
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
  // Re-review 2, N3c: the gate job has `checks: read`, so it can read the
  // admission App's check.
  "62f231ef508663a7c52567b465634dbbfc0ef36889d9b3875aa454171e3afc4b",
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
  const match = /^\s*(\d{1,4})\s*(#.*)?$/.exec(value.split("\n")[0]);
  return match && value.split("\n").slice(1).every((line) => /^\s*(#.*)?$/.test(line)) ? Number(match[1]) : null;
}

// A job counts as GitHub-hosted only when its runs-on is one literal
// ubuntu-*, windows-* or macos-* label and it neither calls a reusable
// workflow nor merges YAML anchors; anything else may reach a self-hosted
// runner, so it is treated as one.
const HOSTED_LABEL = /^(ubuntu|windows|macos)-[A-Za-z0-9.-]+$/;
export function jobIsHosted(job) {
  if (job.lines.some((line) => /^ {4}uses:/.test(line) || /^\s*<<\s*:/.test(line))) return false;
  const value = jobField(job, "runs-on");
  if (value === null) return false;
  const text = value.replace(/#.*$/gm, "").trim();
  if (text.includes("\n")) return false;
  return HOSTED_LABEL.test(unquote(text));
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

export async function workflowGateFindings(fetchImpl, env, repository, files, headSha, baseSha) {
  const findings = [];
  for (const file of files) {
    if (file.status === "removed" || !WORKFLOW_FILE.test(file.filename ?? "")) continue;
    const head = await fileAt(fetchImpl, env, repository, file.filename, headSha);
    if (head === null) throw new Error(`${file.filename} is missing at ${headSha}.`);
    const base = await fileAt(fetchImpl, env, repository, file.previous_filename ?? file.filename, baseSha);
    for (const finding of gateFindings(head, base)) findings.push(`workflow_gate:${file.filename}:${finding}`);
  }
  return findings;
}

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

function emptyOutcome(eventName, enforced) {
  return {
    mode: null, event: eventName, admitted: false, enforced, verdict: null, reasons: [], notices: [],
    claim_id: null, scope: null, head_sha: null, base_sha: null, pr_ref: null, changed_paths: [],
    applicable_workflows: [], error: null,
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

export async function evaluate({ env, event, eventName, fetchImpl, workspace, withSummary }) {
  const enforced = enforcementEnabled(env);
  const outcome = emptyOutcome(eventName, enforced);
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

  // Advisory mode must never fail the job for a reason unrelated to the PR:
  // whatever goes wrong below is reported and the PR is admitted.
  const notEnforced = (reason) => {
    outcome.admitted = true;
    if (outcome.verdict === null || outcome.verdict === "ERROR") outcome.verdict = "NOT_ENFORCED";
    outcome.reasons.push(reason);
    return outcome;
  };
  try {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
    const repository = env.GITHUB_REPOSITORY;
    const changed = await changedPathsOfPullRequest(fetchImpl, env, repository, pr.number);
    outcome.changed_paths = changed.paths;
    const truncated = Number.isInteger(pr.changed_files) && changed.file_count < pr.changed_files;
    const gateFindingsOfPr = await workflowGateFindings(fetchImpl, env, repository, changed.files, pr.head.sha, pr.base.sha);
    if (gateFindingsOfPr.length) outcome.workflow_gate_findings = gateFindingsOfPr;
    if (withSummary && workspace) {
      await summarizeWorkflows(fetchImpl, env, repository, pr.head.sha, outcome.changed_paths, workspace, outcome);
    }

    if (!env.CLUED_CONTEXT_READ_TOKEN) {
      if (enforced) throw new Error("CLUED_CONTEXT_READ_TOKEN is not set; admission cannot be verified.");
      return notEnforced("CLUED_CONTEXT_READ_TOKEN is not set; advisory verification skipped");
    }

    let reference = parseClaimReference(pr.body);
    if (!reference) {
      const commit = await githubJson(fetchImpl, env, `/repos/${repository}/commits/${pr.head.sha}`);
      reference = parseClaimReference(commit && commit.commit && commit.commit.message);
    }
    if (!reference) {
      if (enforced) {
        outcome.verdict = "REJECTED";
        outcome.reasons.push("claim_trailer_missing");
        return outcome;
      }
      return notEnforced("no Clued-Work-Claim trailer in the PR body or head commit");
    }
    outcome.claim_id = reference.claim_id;
    outcome.scope = reference.scope;
    if (truncated) {
      // Paths past the API limit cannot be checked against the write set.
      if (enforced) {
        outcome.verdict = "REJECTED";
        outcome.reasons.push(`changed_files_truncated:${pr.changed_files}`);
        return outcome;
      }
      return notEnforced(`changed file list truncated (${pr.changed_files} files); advisory verification skipped`);
    }

    // Re-review N8: a PR the workflow guard already refuses is verified
    // read-only, so it neither binds the claim nor uses the Task's CI budget.
    const verified = await verifyClaim(fetchImpl, env, gateFindingsOfPr.length ? {
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
    }, workspace);
    if (verified.kind === "rpc_unavailable") {
      if (enforced) throw new Error(`Clued ${VERIFY_RPC} is not deployed (${verified.detail}); enforcement is on, so admission cannot be verified.`);
      return notEnforced(`${VERIFY_RPC} is not deployed yet (${verified.detail})`);
    }
    if (verified.kind === "refused") {
      if (enforced) throw new Error(`Clued refused the verification request (${verified.detail}).`);
      return notEnforced(`Clued refused the verification request (${verified.detail})`);
    }

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
      const compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${claimBase}...${pr.base.sha}`, { allowMissing: true });
      if (!compare) {
        outcome.verdict = "REJECTED";
        outcome.reasons.push(`claim_base_unknown:${claimBase}`);
      } else if (compare.status !== "ahead" && compare.status !== "identical") {
        outcome.notices.push(`base_behind_claim:${compare.status} (the claim's base_commit ${claimBase} is newer than this PR's base ${pr.base.sha}; merge main into the branch or claim with the branch's merge-base)`);
      }
    }
    if (gateFindingsOfPr.length) {
      outcome.verdict = "REJECTED";
      outcome.reasons.push(...gateFindingsOfPr);
    }
    if (enforced) {
      outcome.admitted = outcome.verdict === "ADMITTED";
    } else {
      outcome.advisory = true;
      outcome.admitted = true;
      outcome.reasons.push("advisory only: CLUED_WORK_ADMISSION_ENFORCE is not set");
    }
    return outcome;
  } catch (error) {
    if (enforced) throw error;
    return notEnforced(`advisory verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Re-verification. A check run is a verdict at one moment; the claim behind it
// can expire, be released or be taken over afterwards. For every open,
// non-draft PR, the latest successful run of the admission workflow on its
// head (per triggering event) is re-run when a fresh evaluation no longer
// admits the PR. The re-run evaluates again and turns the check red. Transport
// errors are reported, never turned into a re-run.

export const ADMISSION_WORKFLOW = "clued-work-admission.yml";

export async function reverify({ env, fetchImpl, workspace }) {
  const result = { enforced: enforcementEnabled(env), checked: [], reran: [], errors: [] };
  if (!result.enforced) {
    result.skipped = "CLUED_WORK_ADMISSION_ENFORCE is not set; checks are advisory";
    return result;
  }
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
  const repository = env.GITHUB_REPOSITORY;
  const pulls = await githubPaged(fetchImpl, env, `/repos/${repository}/pulls?state=open`);
  for (const pr of pulls) {
    if (pr.draft || !pr.head || !pr.base) continue;
    try {
      const runs = (await githubJson(fetchImpl, env,
        `/repos/${repository}/actions/workflows/${ADMISSION_WORKFLOW}/runs?head_sha=${pr.head.sha}&per_page=50`)).workflow_runs ?? [];
      const latest = new Map();
      for (const run of runs) {
        const prior = latest.get(run.event);
        if (!prior || Date.parse(run.created_at) > Date.parse(prior.created_at)) latest.set(run.event, run);
      }
      const passing = [...latest.values()].filter((run) => run.status === "completed" && run.conclusion === "success");
      if (passing.length === 0) continue;
      const outcome = await evaluate({ env, event: { pull_request: pr }, eventName: "pull_request_target", fetchImpl, workspace, withSummary: false });
      result.checked.push({ pr: pr.number, verdict: outcome.verdict, reasons: outcome.reasons });
      if (outcome.admitted) continue;
      for (const run of passing) {
        await githubPost(fetchImpl, env, `/repos/${repository}/actions/runs/${run.id}/rerun`);
        result.reran.push({ pr: pr.number, run_id: run.id, event: run.event, verdict: outcome.verdict, reasons: outcome.reasons });
      }
    } catch (error) {
      result.errors.push({ pr: pr.number, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function renderReverifySummary(result) {
  const lines = ["## clued-work-admission re-verification", ""];
  if (result.skipped) {
    lines.push(`Skipped: ${result.skipped}.`, "");
    return lines.join("\n");
  }
  lines.push(`Open PRs with a passing admission run checked: ${result.checked.length} · re-runs requested: ${result.reran.length} · errors: ${result.errors.length}`);
  for (const rerun of result.reran) lines.push(`- #${rerun.pr}: run ${rerun.run_id} (${rerun.event}) re-run, ${rerun.verdict}: ${rerun.reasons.join("; ")}`);
  for (const error of result.errors) lines.push(`- #${error.pr}: error ${error.error}`);
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
  // The newest App check of each admission run, with the pull request it names.
  const posted = new Map();
  for (const check of (body && body.check_runs) || []) {
    if (check.name !== APP_CHECK_NAME || check.head_sha !== headSha) continue;
    if (!check.app || Number(check.app.id) !== ADMISSION_APP_ID) continue;
    const match = EXTERNAL_ID.exec(String(check.external_id ?? ""));
    if (!match) continue;
    const prior = posted.get(match[2]);
    if (!prior || Number(check.id) > Number(prior.check.id)) posted.set(match[2], { check, pr: Number(match[1]) });
  }
  const runs = (await githubJson(fetchImpl, env,
    `/repos/${repository}/actions/workflows/${ADMISSION_WORKFLOW}/runs?head_sha=${headSha}&event=pull_request_target&per_page=100`)).workflow_runs ?? [];
  const fresh = runs
    .filter((run) => run && run.event === "pull_request_target" && Date.parse(run.created_at) >= since - SAME_EVENT_MS)
    .sort((a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || (Number(b.id) - Number(a.id)));
  for (const run of fresh) {
    const entry = posted.get(String(run.id));
    if (entry && entry.pr !== Number(prNumber)) continue;
    return { run, check: entry ? entry.check : null };
  }
  return { run: null, check: null };
}

// Re-review 3, N-R3: a re-run replays the run's own workflow file and event,
// so one of a run from before the gates existed has no gate, and "re-run
// failed jobs" keeps the gate's earlier output. The gate refuses re-runs of
// pull request and branch dispatch runs; push a new commit instead (the
// runner check refuses them before any job, including "re-run failed jobs").
export function rerunAttempt(env) {
  const attempt = Number.parseInt(String(env.GITHUB_RUN_ATTEMPT ?? "1"), 10);
  return Number.isInteger(attempt) && attempt > 1 ? attempt : null;
}
const RERUN_HOWTO = "re-runs are not admitted; push a new commit";

export async function gate({ env, event, eventName, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  let enforced = enforcementEnabled(env);
  const outcome = emptyOutcome(eventName, enforced);
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
  // A fork pull request may not receive repository variables, so an unset
  // CLUED_WORK_ADMISSION_ENFORCE here proves nothing. The gate then follows
  // the App check, which main's admission run posts after reading the
  // variable in the base repository; it succeeds whenever admission is advisory.
  const headRepo = pr.head.repo && pr.head.repo.full_name;
  const baseRepo = (pr.base.repo && pr.base.repo.full_name) || env.GITHUB_REPOSITORY;
  if (!enforced && headRepo && baseRepo && headRepo !== baseRepo) {
    enforced = true;
    outcome.enforced = true;
    outcome.notices.push(`fork pull request from ${headRepo}: following the ${ADMISSION_WORKFLOW} result whatever this run sees of CLUED_WORK_ADMISSION_ENFORCE`);
  }
  const waitSeconds = Number.parseInt(env.CLUED_ADMISSION_GATE_WAIT_SECONDS ?? "", 10);
  const limit = Number.isInteger(waitSeconds) && waitSeconds >= 0 ? waitSeconds : GATE_WAIT_SECONDS;
  try {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
    const attempt = rerunAttempt(env);
    if (attempt) {
      outcome.verdict = "RERUN_REFUSED";
      outcome.reasons.push(`run attempt ${attempt}: ${RERUN_HOWTO}`);
      throw Object.assign(new Error("refused"), { refused: true });
    }
    if (!/^[0-9]{1,20}$/.test(String(env.GITHUB_RUN_ID ?? ""))) throw new Error("GITHUB_RUN_ID is not set.");
    const self = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
    const since = Date.parse(self && self.created_at);
    if (!Number.isFinite(since)) throw new Error(`run ${env.GITHUB_RUN_ID} has no created_at.`);
    let found = { run: null, check: null };
    const what = `${APP_CHECK_NAME} of App ${ADMISSION_APP_ID} for #${pr.number} from the admission run of this event (created since ${self.created_at} less ${SAME_EVENT_MS / 1000}s)`;
    for (let waited = 0; ; waited += GATE_POLL_SECONDS) {
      found = await eventAdmissionCheck(fetchImpl, env, env.GITHUB_REPOSITORY, pr.head.sha, since, pr.number);
      if ((found.check && found.check.status === "completed") || waited >= limit) break;
      await sleep(GATE_POLL_SECONDS * 1000);
    }
    const run = found.check;
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
    } else if (run.conclusion === "success") {
      outcome.verdict = "ADMITTED";
      outcome.admitted = true;
    } else {
      outcome.verdict = "REJECTED";
      outcome.reasons.push(`${what} ${run.id} concluded ${run.conclusion}`);
    }
  } catch (error) {
    if (!(error && error.refused)) {
      if (enforced) throw error;
      outcome.verdict = "NOT_ENFORCED";
      outcome.reasons.push(`advisory gate unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!outcome.admitted && !enforced) {
    outcome.advisory = true;
    outcome.admitted = true;
    outcome.reasons.push("advisory only: CLUED_WORK_ADMISSION_ENFORCE is not set");
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
  try {
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
  } catch (error) {
    if (outcome.enforced) throw error;
    outcome.verdict = "NOT_ENFORCED";
    outcome.reasons.push(`advisory gate unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!outcome.admitted && !outcome.enforced) {
    outcome.advisory = true;
    outcome.admitted = true;
    outcome.reasons.push("advisory only: CLUED_WORK_ADMISSION_ENFORCE is not set");
  }
  return outcome;
}

// The dispatch admission run (step 1 above). Inputs arrive as environment
// variables; the run must be on the default branch.
export async function dispatchAdmit({ env, fetchImpl, workspace }) {
  const enforced = enforcementEnabled(env);
  const outcome = emptyOutcome("workflow_dispatch", enforced);
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
  const notEnforced = (reason) => {
    outcome.admitted = true;
    if (outcome.verdict === null || outcome.verdict === "ERROR") outcome.verdict = "NOT_ENFORCED";
    outcome.reasons.push(reason);
    return outcome;
  };
  try {
    const commit = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/commits/${encodeURIComponent(ref)}`, { allowMissing: true });
    if (!commit || typeof commit.sha !== "string") throw new Error(`ref ${ref} was not found.`);
    outcome.head_sha = commit.sha;
    if (!env.CLUED_CONTEXT_READ_TOKEN) {
      if (enforced) throw new Error("CLUED_CONTEXT_READ_TOKEN is not set; admission cannot be verified.");
      return notEnforced("CLUED_CONTEXT_READ_TOKEN is not set; advisory verification skipped");
    }
    // The dispatched head is metered against the Task's CI budget like a pull
    // request head (re-review MAJOR-6), and the run records the head it
    // admitted, which the heavy workflow's gate compares with its own commit.
    const verified = await verifyClaim(fetchImpl, env, { scope, claim_id: claimId, head_sha: commit.sha, ci_dispatch: true }, workspace);
    if (verified.kind === "rpc_unavailable") {
      if (enforced) throw new Error(`Clued ${VERIFY_RPC} is not deployed (${verified.detail}).`);
      return notEnforced(`${VERIFY_RPC} is not deployed yet (${verified.detail})`);
    }
    if (verified.kind === "refused") {
      if (enforced) throw new Error(`Clued refused the verification request (${verified.detail}).`);
      return notEnforced(`Clued refused the verification request (${verified.detail})`);
    }
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
    if (enforced) {
      outcome.admitted = outcome.verdict === "ADMITTED";
    } else {
      outcome.advisory = true;
      outcome.admitted = true;
      outcome.reasons.push("advisory only: CLUED_WORK_ADMISSION_ENFORCE is not set");
    }
    if (outcome.admitted) console.log(`::notice title=${ADMITTED_HEAD_TITLE}::${commit.sha}`);
    return outcome;
  } catch (error) {
    if (enforced) throw error;
    return notEnforced(`advisory verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Reporting.

export function renderSummary(outcome) {
  const lines = [];
  lines.push("## clued-work-admission");
  lines.push("");
  const mode = outcome.enforced ? "enforced" : "advisory (CLUED_WORK_ADMISSION_ENFORCE is not set)";
  lines.push(`**Verdict:** \`${outcome.verdict}\` · admitted: \`${outcome.admitted}\` · ${mode}`);
  if (outcome.claim_id) lines.push(`**Claim:** \`${outcome.claim_id}\` (scope \`${outcome.scope}\`)`);
  if (outcome.claim) {
    lines.push(`**Claim state:** task \`${outcome.claim.task_id}\` · ${outcome.claim.status} · fence ${outcome.claim.fence} · expires ${outcome.claim.expires_at}${outcome.claim.base_commit ? ` · base \`${outcome.claim.base_commit}\`` : ""}`);
  }
  if (outcome.head_sha) lines.push(`**Head:** \`${outcome.head_sha}\` · **Base:** \`${outcome.base_sha}\``);
  if (outcome.claim && outcome.claim.bound_pr) lines.push(`**Claim bound to:** \`${outcome.claim.bound_pr}\``);
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

export async function appCheck({ env, fetchImpl, now = () => Date.now() }) {
  const appId = (env.CLUED_ADMISSION_APP_ID ?? "").trim();
  const key = (env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? "").trim();
  if (!appId || !key) return { posted: false, reason: "the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY)" };
  const headSha = (env.ADMISSION_HEAD_SHA ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(headSha)) return { posted: false, reason: "the admission step reported no head commit; nothing to post (the required check stays missing)" };
  const success = env.ADMISSION_OUTCOME === "success";
  const repository = env.GITHUB_REPOSITORY;
  try {
    const jwt = appJwt(appId, key, Math.floor(now() / 1000));
    const installation = await appRequest(fetchImpl, env, "GET", `/repos/${repository}/installation`, jwt);
    const token = await appRequest(fetchImpl, env, "POST", `/app/installations/${installation.id}/access_tokens`, jwt,
      { repositories: [repository.split("/")[1]], permissions: { checks: "write" } });
    const verdict = (env.ADMISSION_VERDICT ?? "").trim() || (success ? "ADMITTED" : "NOT ADMITTED");
    const prNumber = String(env.ADMISSION_PR_NUMBER ?? "").trim();
    const runId = String(env.GITHUB_RUN_ID ?? "").trim();
    const externalId = /^[0-9]{1,10}$/.test(prNumber) && /^[0-9]{1,20}$/.test(runId) ? `pr:${prNumber}:run:${runId}` : undefined;
    const check = await appRequest(fetchImpl, env, "POST", `/repos/${repository}/check-runs`, token.token, {
      name: APP_CHECK_NAME, head_sha: headSha, status: "completed", conclusion: success ? "success" : "failure",
      ...(externalId ? { external_id: externalId } : {}),
      output: { title: verdict, summary: `clued-work-admission ${success ? "admitted" : "did not admit"} this head (run ${env.GITHUB_RUN_ID ?? "?"}).` },
    });
    return { posted: true, head_sha: headSha, conclusion: success ? "success" : "failure", check_run_id: check.id ?? null };
  } catch (error) {
    return { posted: false, error: error instanceof Error ? error.message : String(error) };
  }
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

export async function adoptMerged({ env, event, eventName, fetchImpl, workspace }) {
  const pr = event && event.pull_request;
  const result = { adopted: false, pr_ref: null, merge_sha: null, claim_id: null, scope: null, reason: null, error: null, payload: null };
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
    let reference = parseClaimReference(pr.body);
    if (!reference && env.GITHUB_TOKEN && pr.head && pr.head.sha) {
      const commit = await githubJson(fetchImpl, env, `/repos/${env.GITHUB_REPOSITORY}/commits/${pr.head.sha}`);
      reference = parseClaimReference(commit && commit.commit && commit.commit.message);
    }
    if (!reference) {
      result.reason = "no Clued-Work-Claim trailer; not a copy";
      return result;
    }
    result.claim_id = reference.claim_id;
    result.scope = reference.scope;
    const { url: base, key } = resolvePublicSupabaseConfig(env, workspace);
    const response = await fetchImpl(`${base}/rest/v1/rpc/${ADOPT_RPC}`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "clued-work-admission",
      },
      body: JSON.stringify({
        p_token_hash: sha256Hex(env.CLUED_CONTEXT_READ_TOKEN),
        p_input: { scope: reference.scope, pr_ref: result.pr_ref, merge_sha: result.merge_sha },
      }),
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
    if (response.status === 404 && body && body.code === "PGRST202") {
      result.reason = `${ADOPT_RPC} is not deployed (${detail}); adoption skipped`;
      return result;
    }
    if (response.status !== 200 || !body || typeof body !== "object") throw new Error(`Clued ${ADOPT_RPC} returned ${detail}`);
    result.payload = body;
    if (body.status === "rejected") {
      result.reason = `${body.error_code ?? "rejected"}: another copy of this Task was adopted first`;
      return result;
    }
    if (body.status !== "ok") throw new Error(`Clued ${ADOPT_RPC} returned status ${String(body.status)} (${detail})`);
    result.adopted = body.adopted === true;
    if (!result.adopted) result.reason = typeof body.reason === "string" ? body.reason : "not adopted";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function renderAdoptSummary(result) {
  const lines = ["## clued-work-admission: multi-copy adoption", ""];
  lines.push(`- Pull request: ${result.pr_ref ?? "n/a"}`);
  if (result.merge_sha) lines.push(`- Merge commit: \`${result.merge_sha}\``);
  if (result.claim_id) lines.push(`- Claim: \`${result.claim_id}\` (${result.scope})`);
  if (result.adopted) {
    const out = Array.isArray(result.payload?.not_adopted) ? result.payload.not_adopted.length : 0;
    lines.push(`- Adopted copy ${result.payload?.copy_index ?? "?"} of Task \`${result.payload?.task_id ?? "?"}\`${result.payload?.replayed ? " (already adopted)" : ""}; ${out} other cop${out === 1 ? "y" : "ies"} put out.`);
  }
  if (result.reason) lines.push(`- ${result.reason}`);
  if (result.error) lines.push(`- Error: ${result.error}`);
  lines.push("");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch) {
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
    if (!result.posted) console.error(`::notice title=${APP_CHECK_NAME}::${result.reason}`);
    return 0;
  }
  if (mode === "reverify") {
    const result = await reverify({ env, fetchImpl, workspace: env.GITHUB_WORKSPACE });
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
    else outcome = await evaluate({ env, event, eventName, fetchImpl, workspace: env.GITHUB_WORKSPACE, withSummary: true });
  } catch (error) {
    outcome = emptyOutcome(eventName, enforcementEnabled(env));
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
    "",
  ].join("\n"));
  if (outcome.error) {
    console.error(`::error title=clued-work-admission::${withTokenHint(outcome.error)}`);
    return 1;
  }
  if (!outcome.admitted) {
    const text = withTokenHint(`${outcome.verdict}: ${outcome.reasons.join("; ")}`);
    if (mode === "required" || mode === "dispatch-admit") {
      console.error(`::error title=clued-work-admission::${text}`);
      return 1;
    }
    console.error(`::warning title=admission-gate::${text}; heavy jobs are skipped.`);
    return 0;
  }
  if (outcome.verdict === "NOT_ENFORCED") {
    console.error(`::notice title=clued-work-admission::Not enforced: ${outcome.reasons.join("; ")}`);
  } else if (outcome.advisory) {
    console.error(`::notice title=clued-work-admission::Advisory verdict ${outcome.verdict}${outcome.reasons.length ? ` (${outcome.reasons.join("; ")})` : ""}`);
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
