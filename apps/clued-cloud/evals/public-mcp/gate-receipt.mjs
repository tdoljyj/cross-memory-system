import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const REQUIRED_CHECKS = Object.freeze([
  "public-mcp-protocol",
  "public-mcp-behavior",
  "gitleaks",
  "trivy",
]);

// The gate applies to exactly the pull requests public-mcp-behavior runs for.
export const GATE_APPLICABILITY_CHECK = "public-mcp-behavior";
export const GATE_STATUS_CONTEXT = "public-mcp-gate-receipt";
// Commit statuses do not raise check-suite events, so watchers of a pull request
// never learn the verdict. A terminal verdict is also written as a completed
// check run under its own name; the commit status stays the gate.
export const GATE_CHECK_RUN_NAME = "public-mcp-gate-receipt-verdict";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateCandidate({ repository, sha }) {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("GATE_INVALID_REPOSITORY");
  }
  if (!SHA_PATTERN.test(sha)) {
    throw new Error("GATE_INVALID_CANDIDATE_SHA");
  }
}

export function evaluateCheckRuns(checkRuns) {
  const latestByName = new Map();
  for (const run of checkRuns) {
    if (!REQUIRED_CHECKS.includes(run.name)) continue;
    const previous = latestByName.get(run.name);
    const previousTime = previous?.started_at ?? previous?.created_at ?? "";
    const currentTime = run.started_at ?? run.created_at ?? "";
    if (!previous || currentTime >= previousTime) latestByName.set(run.name, run);
  }

  const checks = REQUIRED_CHECKS.map((name) => {
    const run = latestByName.get(name);
    return {
      name,
      present: Boolean(run),
      status: run?.status ?? "missing",
      conclusion: run?.conclusion ?? null,
      details_url: run?.details_url ?? null,
      check_run_id: run?.id ?? null,
    };
  });

  const failed = checks.filter((check) =>
    check.present && check.status === "completed" && check.conclusion !== "success"
  );
  // A known failure does not make the other required checks terminal.
  // Preserve it while polling, then issue one complete verdict or time out.
  if (checks.some((check) => !check.present || check.status !== "completed")) {
    return { state: "PENDING", checks, failed };
  }
  if (failed.length > 0) return { state: "FAIL", checks, failed };

  const ready = checks.every((check) =>
    check.present && check.status === "completed" && check.conclusion === "success"
  );
  return { state: ready ? "PASS" : "PENDING", checks, failed: [] };
}

export function buildReceipt({ repository, sha, pullRequest, evaluation, checkedAt }) {
  validateCandidate({ repository, sha });
  if (evaluation.state === "PENDING") throw new Error("GATE_RECEIPT_PENDING");
  return {
    schema_version: 1,
    contract_version: "clued-pre-kernel-public-mcp-gate-receipt/1.1",
    verdict: evaluation.state,
    repository,
    candidate_sha: sha,
    pull_request: pullRequest,
    checked_at: checkedAt,
    required_checks: evaluation.checks,
    owner_merge_authorization_required: true,
    merge_authorized: false,
    deployment_authorized: false,
  };
}

export function gateApplies(checkRuns) {
  return checkRuns.some((run) => run.name === GATE_APPLICABILITY_CHECK);
}

export function commitStatusFor({ evaluation, receiptSha256, targetUrl }) {
  const state = { PASS: "success", FAIL: "failure", PENDING: "pending" }[evaluation.state];
  let description;
  if (evaluation.state === "PENDING") {
    const waiting = evaluation.checks.filter((check) => check.status !== "completed").map((check) => check.name);
    description = `Waiting for ${waiting.join(", ")}`;
  } else {
    description = `${evaluation.state} receipt sha256:${receiptSha256.slice(0, 16)}`;
  }
  return {
    state,
    context: GATE_STATUS_CONTEXT,
    description: description.slice(0, 140),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  };
}

export function checkRunFor({ sha, evaluation, receiptSha256, targetUrl }) {
  if (evaluation.state === "PENDING") throw new Error("GATE_CHECK_RUN_PENDING");
  const summary = evaluation.checks
    .map(({ name, conclusion }) => `- ${name}: ${conclusion}`).join("\n");
  return {
    name: GATE_CHECK_RUN_NAME,
    head_sha: sha,
    status: "completed",
    conclusion: evaluation.state === "PASS" ? "success" : "failure",
    ...(targetUrl ? { details_url: targetUrl } : {}),
    output: {
      title: `${evaluation.state} receipt sha256:${receiptSha256.slice(0, 16)}`,
      summary,
    },
  };
}

// Each required check's completion re-runs the gate, so a terminal verdict
// would be announced again for every later completion. Announce it only when
// the latest verdict check run on the candidate does not already carry it.
export function verdictAlreadyAnnounced(checkRuns, evaluation) {
  const conclusion = evaluation.state === "PASS" ? "success" : "failure";
  const latest = checkRuns
    .filter((run) => run.name === GATE_CHECK_RUN_NAME)
    .sort((a, b) => String(b.started_at ?? b.created_at ?? "")
      .localeCompare(String(a.started_at ?? a.created_at ?? "")))[0];
  return latest?.status === "completed" && latest.conclusion === conclusion;
}

function parseInteger(value, fallback, minimum) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

async function fetchCheckRuns({ apiUrl, repository, sha, token, requestTimeoutSeconds }) {
  const response = await fetch(
    `${apiUrl}/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "clued-public-mcp-gate-receipt-v1.1",
      },
      signal: AbortSignal.timeout(requestTimeoutSeconds * 1000),
    },
  );
  if (!response.ok) throw new Error(`GATE_GITHUB_API_${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.check_runs)) throw new Error("GATE_GITHUB_API_INVALID_RESPONSE");
  return payload.check_runs;
}

async function postCommitStatus({ apiUrl, repository, sha, token, requestTimeoutSeconds, status }) {
  const response = await fetch(`${apiUrl}/repos/${repository}/statuses/${sha}`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "clued-public-mcp-gate-receipt-v1.1",
    },
    body: JSON.stringify(status),
    signal: AbortSignal.timeout(requestTimeoutSeconds * 1000),
  });
  if (!response.ok) throw new Error(`GATE_STATUS_API_${response.status}`);
}

async function postCheckRun({ apiUrl, repository, token, requestTimeoutSeconds, checkRun }) {
  const response = await fetch(`${apiUrl}/repos/${repository}/check-runs`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "clued-public-mcp-gate-receipt-v1.1",
    },
    body: JSON.stringify(checkRun),
    signal: AbortSignal.timeout(requestTimeoutSeconds * 1000),
  });
  if (!response.ok) throw new Error(`GATE_CHECK_RUN_API_${response.status}`);
}

async function writeReceipt(output, receipt) {
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, text, { encoding: "utf8", flag: "wx" });
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function waitForRequiredChecks({
  readChecks,
  timeoutSeconds,
  pollSeconds,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const deadline = now() + timeoutSeconds * 1000;
  while (true) {
    const evaluation = evaluateCheckRuns(await readChecks());
    if (evaluation.state !== "PENDING") return evaluation;
    if (now() >= deadline) throw new Error("GATE_CHECKS_TIMEOUT");
    await sleep(Math.min(pollSeconds * 1000, deadline - now()));
  }
}

async function main() {
  const repository = process.env.GATE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "";
  const sha = (process.env.CANDIDATE_SHA ?? "").toLowerCase();
  const pullRequest = parseInteger(process.env.GATE_PR_NUMBER, 0, 0) || null;
  const output = process.env.GATE_RECEIPT_OUTPUT ?? "gate-receipt.json";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  const timeoutSeconds = parseInteger(process.env.GATE_TIMEOUT_SECONDS, 900, 1);
  const pollSeconds = parseInteger(process.env.GATE_POLL_SECONDS, 10, 1);
  const requestTimeoutSeconds = parseInteger(process.env.GATE_REQUEST_TIMEOUT_SECONDS, 30, 1);

  // "once" evaluates the current snapshot a single time and reports it as a
  // commit status on the candidate; the workflow re-runs it whenever one of
  // the required checks completes, so no runner is held while they queue.
  const once = process.env.GATE_MODE === "once";
  const targetUrl = process.env.GATE_STATUS_TARGET_URL || null;

  validateCandidate({ repository, sha });
  if (!token) throw new Error("GATE_GITHUB_TOKEN_REQUIRED");

  const readChecks = () => fetchCheckRuns({
    apiUrl,
    repository,
    sha,
    token,
    requestTimeoutSeconds,
  });
  let evaluation;
  let checkRuns = [];
  if (once) {
    checkRuns = await readChecks();
    if (!gateApplies(checkRuns)) {
      console.log(JSON.stringify({ verdict: "NOT_APPLICABLE", candidate_sha: sha }));
      return;
    }
    evaluation = evaluateCheckRuns(checkRuns);
    if (evaluation.state === "PENDING") {
      await postCommitStatus({
        apiUrl, repository, sha, token, requestTimeoutSeconds,
        status: commitStatusFor({ evaluation, targetUrl }),
      });
      console.log(JSON.stringify({
        verdict: "PENDING",
        candidate_sha: sha,
        checks: evaluation.checks.map(({ name, status }) => ({ name, status })),
      }));
      return;
    }
  } else {
    evaluation = await waitForRequiredChecks({ readChecks, timeoutSeconds, pollSeconds });
  }
  const receipt = buildReceipt({
    repository,
    sha,
    pullRequest,
    evaluation,
    checkedAt: new Date().toISOString(),
  });
  const receiptSha256 = await writeReceipt(output, receipt);
  if (once) {
    await postCommitStatus({
      apiUrl, repository, sha, token, requestTimeoutSeconds,
      status: commitStatusFor({ evaluation, receiptSha256, targetUrl }),
    });
    // The status above is the gate; the check run only announces it, so a
    // failure here is reported without changing the verdict.
    if (!verdictAlreadyAnnounced(checkRuns, evaluation)) {
      try {
        await postCheckRun({
          apiUrl, repository, token, requestTimeoutSeconds,
          checkRun: checkRunFor({ sha, evaluation, receiptSha256, targetUrl }),
        });
      } catch (error) {
        console.error(`GATE_CHECK_RUN_NOT_POSTED ${error instanceof Error ? error.message : ""}`);
      }
    }
  }
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    candidate_sha: receipt.candidate_sha,
    receipt_sha256: receiptSha256,
    checks: receipt.required_checks.map(({ name, conclusion }) => ({ name, conclusion })),
  }));
  // In once mode the verdict lives in the commit status on the candidate; the
  // evaluating job itself is attached to the default branch and stays green.
  if (!once && receipt.verdict !== "PASS") process.exitCode = 1;
}

if (!process.env.NODE_TEST_CONTEXT) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "GATE_UNKNOWN_ERROR");
    process.exitCode = 1;
  });
}
