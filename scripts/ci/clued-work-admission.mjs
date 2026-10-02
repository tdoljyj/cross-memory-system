#!/usr/bin/env node
// Work Claim Admission v0.1, step 3 (development/contracts/execution-admission/
// WorkClaimAdmission.v0.1.md §4.6 L0a/L0b). One script, two modes:
//
//   --mode required   the unfiltered `clued-work-admission` check on every PR
//   --mode gate       the `admission-gate` job that heavy self-hosted workflows
//                     run first; they `needs:` it and run only on admitted=true
//   --mode reverify   the scheduled re-check: every open PR whose last
//                     admission run passed is verified again, and that run is
//                     re-run when its claim no longer admits the PR (expired,
//                     released, superseded, or bound to another PR), so a
//                     green check does not outlive its claim
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
// The script asks Clued whether the PR's work claim admits the PR's head, base
// and changed files: clued_work_verify_v1 (read-only, no receipt), called on
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
// No dependencies: Node 20+ fetch, crypto and fs only, so a hosted runner
// finishes in seconds without an install.

import { createHash } from "node:crypto";
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
  return { paths: [...paths].sort(), file_count: files.length };
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
    mode: null, event: eventName, admitted: false, enforced, verdict: null, reasons: [],
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

    const verified = await verifyClaim(fetchImpl, env, {
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
    if (verified.payload.claim && typeof verified.payload.claim === "object") {
      const { claim } = verified.payload;
      outcome.claim = {
        task_id: claim.task_id ?? null, status: claim.status ?? null, fence: claim.fence ?? null,
        expires_at: claim.expires_at ?? null, base_commit: claim.base_commit ?? null,
        bound_pr: claim.bound_pr ?? null,
        write_set: Array.isArray(claim.write_set) ? claim.write_set : [],
      };
    }
    // The claim's base must not be ahead of the PR's base: a claim taken on a
    // newer main than the PR targets is not the work this PR carries.
    const claimBase = outcome.claim && outcome.claim.base_commit;
    if (outcome.verdict === "ADMITTED" && typeof claimBase === "string" && claimBase) {
      const compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${claimBase}...${pr.base.sha}`, { allowMissing: true });
      if (!compare) {
        outcome.verdict = "REJECTED";
        outcome.reasons.push(`claim_base_unknown:${claimBase}`);
      } else if (compare.status !== "ahead" && compare.status !== "identical") {
        outcome.verdict = "REJECTED";
        outcome.reasons.push(`base_behind_claim:${compare.status}`);
      }
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
  if (outcome.error) lines.push(`**Error:** ${outcome.error}`);
  if (outcome.reasons.length) {
    lines.push("");
    lines.push("Reasons:");
    for (const reason of outcome.reasons) lines.push(`- ${reason}`);
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

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch) {
  const modeIndex = argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "required";
  if (mode !== "required" && mode !== "gate" && mode !== "reverify") {
    console.error("usage: clued-work-admission.mjs --mode required|gate|reverify");
    return 2;
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
    outcome = await evaluate({
      env, event, eventName, fetchImpl,
      workspace: env.GITHUB_WORKSPACE, withSummary: mode === "required",
    });
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
    "",
  ].join("\n"));
  if (outcome.error) {
    console.error(`::error title=clued-work-admission::${outcome.error}`);
    return 1;
  }
  if (!outcome.admitted) {
    const text = `${outcome.verdict}: ${outcome.reasons.join("; ")}`;
    if (mode === "required") {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
