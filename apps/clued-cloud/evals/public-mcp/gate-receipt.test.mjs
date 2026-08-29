import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_CHECKS,
  buildReceipt,
  evaluateCheckRuns,
  validateCandidate,
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
