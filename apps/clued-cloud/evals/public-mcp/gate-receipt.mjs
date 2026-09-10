import fs from "node:fs/promises";
import path from "node:path";

export const REQUIRED_CHECKS = Object.freeze([
  "public-mcp-protocol",
  "public-mcp-behavior",
  "gitleaks",
  "trivy",
]);

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

async function writeReceipt(output, receipt) {
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
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

  validateCandidate({ repository, sha });
  if (!token) throw new Error("GATE_GITHUB_TOKEN_REQUIRED");

  const evaluation = await waitForRequiredChecks({
    readChecks: () => fetchCheckRuns({
      apiUrl,
      repository,
      sha,
      token,
      requestTimeoutSeconds,
    }),
    timeoutSeconds,
    pollSeconds,
  });
  const receipt = buildReceipt({
    repository,
    sha,
    pullRequest,
    evaluation,
    checkedAt: new Date().toISOString(),
  });
  await writeReceipt(output, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    candidate_sha: receipt.candidate_sha,
    checks: receipt.required_checks.map(({ name, conclusion }) => ({ name, conclusion })),
  }));
  if (receipt.verdict !== "PASS") process.exitCode = 1;
}

if (!process.env.NODE_TEST_CONTEXT) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "GATE_UNKNOWN_ERROR");
    process.exitCode = 1;
  });
}
