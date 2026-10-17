import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GATE_CHECK_RUN_NAME,
  GATE_STATUS_CONTEXT,
  REQUIRED_CHECKS,
  buildReceipt,
  bootstrapGateProxy,
  checkRunFor,
  commitStatusFor,
  gateApplies,
  gateFetch,
  evaluateCheckRuns,
  validateCandidate,
  verdictAlreadyAnnounced,
  waitForRequiredChecks,
} from "./gate-receipt.mjs";

const SHA = "a".repeat(40);

test("gate proxy bootstrap reuses one same-Node child before credential reads", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:18080" };
  Object.defineProperty(env, "GH_TOKEN", { get() { throw new Error("credential read too early"); } });
  const calls = [];
  const status = bootstrapGateProxy({ env, execArgv: [], argv: ["node", "gate-receipt.mjs"],
    allowedFlags: new Set(["--use-env-proxy"]), spawn: (...args) => { calls.push(args); return { status: 0 }; } });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ["--use-env-proxy", "gate-receipt.mjs"]);
  assert.equal(calls[0][2].env, env);
  assert.equal(calls[0][2].stdio, "inherit");
});

test("gate proxy bootstrap is a no-op without a proxy or in its proxy-enabled child", () => {
  const spawn = () => { throw new Error("unexpected child"); };
  assert.equal(bootstrapGateProxy({ env: {}, spawn }), null);
  assert.equal(bootstrapGateProxy({ env: { HTTPS_PROXY: "http://127.0.0.1:18080", NODE_USE_ENV_PROXY: "1" },
    execArgv: [], allowedFlags: new Set(["--use-env-proxy"]), spawn }), null);
  assert.equal(bootstrapGateProxy({ env: { HTTPS_PROXY: "http://127.0.0.1:18080" },
    execArgv: ["--use-env-proxy"], allowedFlags: new Set(["--use-env-proxy"]), spawn }), null);
});

test("gate proxy bootstrap preserves invalid, unsupported and explicit opt-out refusals", () => {
  let calls = 0;
  const base = { execArgv: [], allowedFlags: new Set(["--use-env-proxy"]), spawn: () => { calls++; } };
  assert.throws(() => bootstrapGateProxy({ ...base, env: { HTTPS_PROXY: "private:invalid" } }), /protocol is unsupported/);
  assert.throws(() => bootstrapGateProxy({ ...base, env: { HTTPS_PROXY: "not a proxy" } }), /proxy is invalid/);
  assert.throws(() => bootstrapGateProxy({ ...base, env: { HTTPS_PROXY: "http://127.0.0.1:18080" }, allowedFlags: new Set() }), /cannot use/);
  assert.throws(() => bootstrapGateProxy({ ...base, env: { HTTPS_PROXY: "http://127.0.0.1:18080", NODE_USE_ENV_PROXY: "0" } }), /explicitly disabled/);
  assert.equal(calls, 0);
});

test("gate proxy child failure stays a failure without leaking its error", () => {
  const base = { env: { HTTPS_PROXY: "http://127.0.0.1:18080" }, execArgv: [],
    argv: ["node", "gate-receipt.mjs"], allowedFlags: new Set(["--use-env-proxy"]) };
  assert.equal(bootstrapGateProxy({ ...base, spawn: () => ({ status: 7 }) }), 7);
  assert.equal(bootstrapGateProxy({ ...base, spawn: () => ({ status: null, signal: "SIGTERM" }) }), 1);
  assert.throws(() => bootstrapGateProxy({ ...base, spawn: () => ({ error: new Error("private credentials") }) }),
    { message: "GATE_PROXY_PROCESS_START_FAILED" });
  assert.throws(() => bootstrapGateProxy({ ...base, spawn: () => { throw new Error("private credentials"); } }),
    { message: "GATE_PROXY_PROCESS_START_FAILED" });
});

test("GitHub request transport preserves successful and HTTP failure responses unchanged", async () => {
  const options = { method: "POST", body: "unchanged", signal: AbortSignal.timeout(1000) };
  const response = { ok: false, status: 403 };
  let calls = 0;
  assert.equal(await gateFetch("STATUS_WRITE", "https://example.invalid/status", options, async (url, init) => {
    calls++; assert.equal(url, "https://example.invalid/status"); assert.equal(init, options); return response;
  }), response);
  assert.equal(calls, 1);
});

test("each failed request reports its bounded phase and cause without retry or secret text", async () => {
  for (const phase of ["CHECKS_READ", "STATUS_WRITE", "VERDICT_ANNOUNCE"]) {
    let calls = 0;
    await assert.rejects(gateFetch(phase, "https://example.invalid/private", {}, async () => {
      calls++; throw new TypeError("private URL and token", { cause: { code: "ECONNRESET" } });
    }), { message: `GATE_GITHUB_NETWORK:${phase}:TypeError:ECONNRESET` });
    assert.equal(calls, 1);
  }
  const failure = new Error("private message"); failure.name = "private name"; failure.cause = { code: "private code" };
  await assert.rejects(gateFetch("CHECKS_READ", "https://example.invalid", {}, async () => { throw failure; }),
    { message: "GATE_GITHUB_NETWORK:CHECKS_READ:Error:UNKNOWN" });
  await assert.rejects(gateFetch("private phase", "https://example.invalid", {}, () => { throw new Error("unexpected fetch"); }),
    { message: "GATE_INVALID_NETWORK_PHASE" });
});

test("actual gate CLI fails a status POST without announcing PASS or retrying it", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "gate-status-failure-"));
  const output = path.join(directory, "receipt.json"), requests = [];
  const server = createServer((request, response) => {
    requests.push([request.method, request.url]);
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ check_runs: runs() }));
    } else { response.writeHead(503); response.end("fixture unavailable"); }
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const env = { ...process.env, GATE_REPOSITORY: "example/repository", CANDIDATE_SHA: SHA, GATE_PR_NUMBER: "1",
      GATE_MODE: "once", GATE_RECEIPT_OUTPUT: output, GH_TOKEN: "fixture-not-a-real-token",
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` };
    for (const key of ["NODE_TEST_CONTEXT", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) delete env[key];
    const child = spawn(process.execPath, [fileURLToPath(new URL("./gate-receipt.mjs", import.meta.url))],
      { env, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 1);
    assert.match(stderr, /GATE_STATUS_API_503/);
    assert.doesNotMatch(stdout, /PASS/);
    assert.deepEqual(requests, [["GET", `/repos/example/repository/commits/${SHA}/check-runs?filter=latest&per_page=100`],
      ["POST", `/repos/example/repository/statuses/${SHA}`]]);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(output, { force: true });
    await fs.rmdir(directory);
  }
});

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
