import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_CHECK_RUN_NAME,
  GATE_STATUS_CONTEXT,
  REQUIRED_CHECKS,
  buildReceipt,
  checkRunFor,
  commitStatusFor,
  gateApplies,
  evaluateCheckRuns,
  validateCandidate,
  verdictAlreadyAnnounced,
  waitForRequiredChecks,
} from "./gate-receipt.mjs";

const SHA = "a".repeat(40);

function runs(conclusion = "success") {
  return REQUIRED_CHECKS.map((name, index) => ({
    id: index + 1,
    name,
    status: "completed",
    conclusion,
    started_at: `2026-08-29T00:00:0${index}Z`,
    details_url: `https://example.invalid/runs/${index + 1}`,
  }));
}

test("four successful checks issue a SHA-bound PASS receipt", () => {
  const evaluation = evaluateCheckRuns(runs());
  assert.equal(evaluation.state, "PASS");
  const receipt = buildReceipt({
    repository: "tdoljyj/cross-memory-system",
    sha: SHA,
    pullRequest: 9,
    evaluation,
    checkedAt: "2026-08-29T00:00:00.000Z",
  });
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.candidate_sha, SHA);
  assert.equal(receipt.required_checks.length, 4);
  assert.equal(receipt.merge_authorized, false);
  assert.equal(receipt.deployment_authorized, false);
});

test("a missing or running check cannot issue a receipt", () => {
  assert.equal(evaluateCheckRuns(runs().slice(0, 3)).state, "PENDING");
  const active = runs();
  active[3] = { ...active[3], status: "in_progress", conclusion: null };
  assert.equal(evaluateCheckRuns(active).state, "PENDING");
});

test("failure, skipped, and neutral conclusions all fail closed", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral"]) {
    const checkRuns = runs();
    checkRuns[2] = { ...checkRuns[2], conclusion };
    const evaluation = evaluateCheckRuns(checkRuns);
    assert.equal(evaluation.state, "FAIL");
    assert.equal(evaluation.failed[0].name, "gitleaks");
  }
});

test("invalid repository or candidate SHA is rejected", () => {
  assert.throws(() => validateCandidate({ repository: "missing-owner", sha: SHA }), /GATE_INVALID_REPOSITORY/);
  assert.throws(() => validateCandidate({ repository: "tdoljyj/cross-memory-system", sha: "main" }), /GATE_INVALID_CANDIDATE_SHA/);
});

test("a known failure waits for every required check to become terminal", async () => {
  for (const status of ["queued", "pending", "in_progress", "waiting"]) {
    const active = runs();
    active[0] = { ...active[0], status, conclusion: null };
    active[2] = { ...active[2], conclusion: "failure" };
    const pending = evaluateCheckRuns(active);
    assert.equal(pending.state, "PENDING");
    assert.equal(pending.failed[0].name, "gitleaks");
    assert.throws(() => buildReceipt({ repository: "tdoljyj/cross-memory-system", sha: SHA, evaluation: pending }), /GATE_RECEIPT_PENDING/);
    let reads = 0;
    let time = 0;
    const terminal = active.map((run) => run.name === "public-mcp-protocol" ? { ...run, status: "completed", conclusion: "success" } : run);
    const result = await waitForRequiredChecks({
      readChecks: async () => ++reads === 1 ? active : terminal,
      timeoutSeconds: 10, pollSeconds: 1, now: () => time,
      sleep: async (ms) => { time += ms; },
    });
    assert.equal(reads, 2);
    assert.equal(result.state, "FAIL");
    assert(result.checks.every((check) => check.status === "completed"));
  }
});

test("pending required checks time out even when another check already failed", async () => {
  const active = runs().slice(1);
  active.find((run) => run.name === "gitleaks").conclusion = "failure";
  let time = 0;
  let reads = 0;
  await assert.rejects(waitForRequiredChecks({
    readChecks: async () => { reads++; return active; },
    timeoutSeconds: 2, pollSeconds: 10, now: () => time,
    sleep: async (ms) => { time += ms; },
  }), /GATE_CHECKS_TIMEOUT/);
  assert.equal(time, 2000);
  assert.equal(reads, 2);
});

test("a pending snapshot can become four green without changing the candidate", async () => {
  let reads = 0;
  const result = await waitForRequiredChecks({
    readChecks: async () => ++reads === 1 ? [] : runs(),
    timeoutSeconds: 2, pollSeconds: 1, now: () => 0, sleep: async () => {},
  });
  assert.equal(reads, 2);
  assert.equal(result.state, "PASS");
});

test("the gate applies only where public-mcp-behavior runs", () => {
  assert.equal(gateApplies(runs()), true);
  assert.equal(gateApplies(runs().filter((run) => run.name !== "public-mcp-behavior")), false);
  assert.equal(gateApplies([]), false);
});

test("commit status mirrors the verdict and names the receipt digest", () => {
  const digest = "b".repeat(64);
  const pass = commitStatusFor({ evaluation: evaluateCheckRuns(runs()), receiptSha256: digest, targetUrl: "https://example.invalid/run" });
  assert.deepEqual(pass, {
    state: "success",
    context: GATE_STATUS_CONTEXT,
    description: `PASS receipt sha256:${"b".repeat(16)}`,
    target_url: "https://example.invalid/run",
  });
  const fail = commitStatusFor({ evaluation: evaluateCheckRuns(runs("failure")), receiptSha256: digest });
  assert.equal(fail.state, "failure");
  assert.equal("target_url" in fail, false);

  const active = runs();
  active[0] = { ...active[0], status: "queued", conclusion: null };
  const pending = commitStatusFor({ evaluation: evaluateCheckRuns(active) });
  assert.equal(pending.state, "pending");
  assert.equal(pending.description, "Waiting for public-mcp-protocol");
  assert(pending.description.length <= 140);
});

test("a terminal verdict is announced as a completed check run on the candidate", () => {
  const digest = "c".repeat(64);
  const pass = checkRunFor({ sha: SHA, evaluation: evaluateCheckRuns(runs()),
    receiptSha256: digest, targetUrl: "https://example.invalid/run" });
  assert.equal(pass.name, GATE_CHECK_RUN_NAME);
  assert.notEqual(pass.name, GATE_STATUS_CONTEXT);
  assert.equal(pass.head_sha, SHA);
  assert.equal(pass.status, "completed");
  assert.equal(pass.conclusion, "success");
  assert.equal(pass.details_url, "https://example.invalid/run");
  assert.equal(pass.output.title, `PASS receipt sha256:${"c".repeat(16)}`);
  assert.match(pass.output.summary, /- public-mcp-behavior: success/);

  const fail = checkRunFor({ sha: SHA, evaluation: evaluateCheckRuns(runs("failure")), receiptSha256: digest });
  assert.equal(fail.conclusion, "failure");
  assert.equal("details_url" in fail, false);

  const active = runs();
  active[0] = { ...active[0], status: "queued", conclusion: null };
  assert.throws(() => checkRunFor({ sha: SHA, evaluation: evaluateCheckRuns(active), receiptSha256: digest }),
    /GATE_CHECK_RUN_PENDING/);
});

test("the verdict check run never counts as one of the required checks", () => {
  const withVerdict = [...runs(), { id: 99, name: GATE_CHECK_RUN_NAME, status: "completed",
    conclusion: "failure", started_at: "2026-08-29T00:00:09Z" }];
  assert.equal(evaluateCheckRuns(withVerdict).state, "PASS");
});

test("a verdict already announced on the candidate is not announced again", () => {
  const verdict = (conclusion, minute) => ({ id: 100 + minute, name: GATE_CHECK_RUN_NAME, status: "completed",
    conclusion, started_at: `2026-08-29T00:0${minute}:00Z` });
  const pass = evaluateCheckRuns(runs());
  const fail = evaluateCheckRuns(runs("failure"));
  assert.equal(verdictAlreadyAnnounced(runs(), pass), false);
  assert.equal(verdictAlreadyAnnounced([...runs(), verdict("success", 1)], pass), true);
  assert.equal(verdictAlreadyAnnounced([...runs(), verdict("failure", 1)], fail), true);
  // A changed verdict (a failed check re-run to green) is announced; only the
  // latest announcement counts.
  assert.equal(verdictAlreadyAnnounced([...runs(), verdict("failure", 1)], pass), false);
  assert.equal(verdictAlreadyAnnounced([...runs(), verdict("success", 1), verdict("failure", 2)], pass), false);
  assert.equal(verdictAlreadyAnnounced([...runs(), verdict("failure", 1), verdict("success", 2)], pass), true);
});
