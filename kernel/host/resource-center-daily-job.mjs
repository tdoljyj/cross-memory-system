import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { qualifyResourceCenterHost } from "./resource-center-host-qualification.mjs";
import { RESOURCE_CENTER_MUTATION_TOOL, RESOURCE_CENTER_BOUNDARY_SCAN_TOOL } from "./resource-center-governed-tool-surface.mjs";

const fail = (code) => { throw new Error(code); };
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
const uncertainDenials = new Set(["DURABLE_WRITE_RESERVATION_FAILED", "POST_WRITE_RECONCILIATION_REQUIRED", "ADMISSION_EXPIRED", "ADMISSION_BINDING_MISMATCH", "ARTIFACT_AUTHORITY_CHANGED"]);
const safeDenials = new Set(["UNAUTHORIZED_WORKSPACE_MUTATION", "ARTIFACT_AUTHORITY_RESOLUTION_FAILED", "ARTIFACT_AUTHORITY_REVALIDATION_FAILED", "WRITER_OPERATION_NOT_QUALIFIED", "CONTROLLED_TOOL_ARGUMENTS_INVALID", "POST_WRITE_CANONICAL_RECEIPT_UNAVAILABLE", "DURABLE_WRITE_RESERVATION_UNAVAILABLE"]);
function safelyFinished(result) {
  return Array.isArray(result) || result?.status === "committed" ||
    (result?.status === "deny" && safeDenials.has(result.error_code) && !uncertainDenials.has(result.error_code) && result.side_effects !== "unknown" && !(result.side_effects > 0));
}
function parseLedger(text) {
  if (text && !text.endsWith("\n")) fail("DAILY_JOB_JOURNAL_INCOMPLETE");
  const jobs = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    let row;try { row = JSON.parse(line); } catch { fail("DAILY_JOB_JOURNAL_CORRUPT"); }
    if (row.contract !== "clued.resource-center-daily-job/1" || !/^[0-9a-f-]{36}$/i.test(row.job_id ?? "") ||
      !/^[0-9a-f]{64}$/.test(row.request_sha256 ?? "") || typeof row.profile_id !== "string") fail("DAILY_JOB_JOURNAL_CORRUPT");
    const prior = jobs.get(row.job_id.toLowerCase());
    const transition = prior && ((prior.state === "pending" && ["finished", "unreconciled"].includes(row.state)) ||
      (["pending", "unreconciled"].includes(prior.state) && row.state === "reconciled"));
    if ((!prior && row.state !== "pending") || (prior && (!transition ||
      prior.request_sha256 !== row.request_sha256 || prior.profile_id !== row.profile_id)) ||
      (["finished", "reconciled"].includes(row.state) && !safelyFinished(row.result)) ||
      (row.state === "reconciled" && (row.result?.status !== "committed" ||
        !/^[0-9a-f-]{36}$/i.test(row.result?.canonical_receipt_id ?? "")))) fail("DAILY_JOB_JOURNAL_CORRUPT");
    jobs.set(row.job_id.toLowerCase(), row);
  }
  return jobs;
}

/** A request ID is correlation, NOT authority. Profiles, credentials and
 * execution callbacks are captured by the installed Host, never this input. */
export function validateDailyJob(input) {
  if (!keys(input, ["job_id", "tool", "arguments"]) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.job_id ?? "") ||
    ![RESOURCE_CENTER_MUTATION_TOOL, RESOURCE_CENTER_BOUNDARY_SCAN_TOOL].includes(input.tool) ||
    !keys(input.arguments, input.tool === RESOURCE_CENTER_BOUNDARY_SCAN_TOOL ? [] :
      ["operation", "destination_path", "target_kind", "directory_semantics", "content"])) fail("DAILY_JOB_INVALID");
  const args = input.arguments;
  if (input.tool === RESOURCE_CENTER_MUTATION_TOOL &&
    (args.operation !== "create" || !["file", "directory"].includes(args.target_kind) ||
      typeof args.destination_path !== "string" || args.destination_path.length > 1000 ||
      (args.target_kind === "file" && (typeof args.content !== "string" || args.directory_semantics !== undefined)) ||
      (args.target_kind === "directory" && (args.content !== undefined || !["topic", "asset_collection"].includes(args.directory_semantics))) ||
      Buffer.byteLength(args.content ?? "", "utf8") > 1024 * 1024)) fail("DAILY_JOB_INVALID");
  return Object.freeze({ job_id: input.job_id.toLowerCase(), tool: input.tool,
    arguments: Object.freeze(Object.fromEntries(Object.keys(args).sort().map(key => [key, args[key]]))) });
}

/** One operator-provisioned state directory, shared by every invocation of
 * this profile. Crash locks and pending jobs are NEVER auto-cleared. */
export async function runDailyJob({ job: input, state_directory: stateDirectory,
  trusted_profile: profile, host, run_isolated: runIsolated } = {}) {
  const job = validateDailyJob(input);
  if (!path.isAbsolute(stateDirectory ?? "") || typeof runIsolated !== "function" ||
    typeof host?.callTool !== "function" ||
    qualifyResourceCenterHost({ trusted_profile: profile, tools: host?.listTools?.() }).status !== "qualified") fail("DAILY_HOST_UNQUALIFIED");
  const dir = await fs.lstat(stateDirectory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) fail("DAILY_STORE_UNSAFE");
  const lockPath = path.join(stateDirectory, "executor.lock");
  const lock = await fs.open(lockPath, "wx");
  let release = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, job_id: job.job_id, profile_id: profile.profile_id }));
    await lock.sync();
    // Pre-provisioned single ledger: no per-job directory-entry durability
    // assumption. A lost crash-lock directory entry cannot erase pending work.
    const jobPath = path.join(stateDirectory, "jobs.jsonl");
    const identity = { contract: "clued.resource-center-daily-job/1", job_id: job.job_id,
      profile_id: profile.profile_id, request_sha256: createHash("sha256").update(JSON.stringify(job)).digest("hex") };
    const before = await fs.lstat(jobPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024 * 1024) fail("DAILY_JOB_JOURNAL_UNSAFE");
    const journal = await fs.open(jobPath, "r+");
    try {
      const after = await journal.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1) fail("DAILY_JOB_JOURNAL_UNSAFE");
      const jobs = parseLedger(await journal.readFile("utf8"));
      const prior = jobs.get(job.job_id.toLowerCase());
      if (prior) {
        if (Object.entries(identity).some(([key, value]) => prior[key] !== value)) fail("DAILY_JOB_IDENTITY_CONFLICT");
        if (!["finished", "reconciled"].includes(prior.state)) fail("DAILY_JOB_RECONCILIATION_REQUIRED");
        release = true;
        return Object.freeze({ ...identity, result: prior.result, replayed: true, execution_boundary: "dedicated-isolated-consumer-not-whole-codex" });
      }
      if ([...jobs.values()].some(row => row.profile_id !== profile.profile_id || !["finished", "reconciled"].includes(row.state))) fail("DAILY_JOB_RECONCILIATION_REQUIRED");
      await journal.writeFile(JSON.stringify({ ...identity, state: "pending" }) + "\n");
      await journal.sync();
      let step = 0; let actualResult;
      const callTool = async (name, args) => {
        if (step === 0 && name === RESOURCE_CENTER_BOUNDARY_SCAN_TOOL && isDeepStrictEqual(args, {})) {
          step = 1;
          const findings = await host.callTool(name, args);
          if (!Array.isArray(findings)) fail("DAILY_BOUNDARY_SCAN_INVALID");
          if (findings.length) { actualResult = { status: "deny", error_code: "UNAUTHORIZED_WORKSPACE_MUTATION", side_effects: 0, findings }; step = 3; }
          else if (job.tool === RESOURCE_CENTER_BOUNDARY_SCAN_TOOL) { actualResult = findings; step = 3; }
          return findings;
        }
        if (step !== 1 || name !== job.tool || !isDeepStrictEqual(args, job.arguments)) fail("DAILY_CONSUMER_REQUEST_CHANGED");
        step = 2; // consume before await: no parallel/replayed dispatch
        actualResult = await host.callTool(name, args);
        step = 3;
        return actualResult;
      };
      const result = await runIsolated({ job, tools: host.listTools(), call_tool: callTool });
      if (step !== 3 || !isDeepStrictEqual(result, actualResult)) fail("DAILY_CONSUMER_RESULT_MISMATCH");
      const safe = safelyFinished(result);
      await journal.writeFile(JSON.stringify({ ...identity, state: safe ? "finished" : "unreconciled", result }) + "\n");
      await journal.sync();
      release = safe;
      return Object.freeze({ ...identity, result, replayed: false, execution_boundary: "dedicated-isolated-consumer-not-whole-codex" });
    } finally { await journal.close(); }
  } finally {
    await lock.close();
    if (release) await fs.unlink(lockPath);
  }
}

/** Operator-only settlement after the ORIGINAL Canonical intent is committed.
 * The captured inspector is authenticated and read-only. No provider effect,
 * reserve/start, force-unlock or caller-supplied receipt is accepted here. */
export async function settleDailyJob({ state_directory: directory, job_id: jobId,
  trusted_profile: profile, inspect_committed_job: inspect } = {}) {
  if (!path.isAbsolute(directory ?? "") || !/^[0-9a-f-]{36}$/i.test(jobId ?? "") || typeof inspect !== "function") fail("DAILY_SETTLEMENT_INVALID");
  const operatorPath = path.join(directory, "operator.lock");
  const operator = await fs.open(operatorPath, "wx");
  const lockPath = path.join(directory, "executor.lock");
  let releaseExecutor = false;
  try {
    try {
      const created = await fs.open(lockPath, "wx");
      try { await created.writeFile(JSON.stringify({ pid: process.pid, profile_id: profile.profile_id, job_id: jobId }));await created.sync(); }
      finally { await created.close(); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const st = await fs.lstat(lockPath);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail("DAILY_SETTLEMENT_LOCK_UNSAFE");
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (owner.profile_id !== profile.profile_id || !Number.isSafeInteger(owner.pid) || owner.pid < 1) fail("DAILY_SETTLEMENT_LOCK_UNSAFE");
      try { process.kill(owner.pid, 0);fail("DAILY_EXECUTOR_STILL_RUNNING"); }
      catch (probe) { if (probe.code !== "ESRCH") throw probe; }
    }
    const journalPath = path.join(directory, "jobs.jsonl");
    const st = await fs.lstat(journalPath);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 64 * 1024 * 1024) fail("DAILY_JOB_JOURNAL_UNSAFE");
    const journal = await fs.open(journalPath, "r+");
    try {
      const opened = await journal.stat();
      if (opened.dev !== st.dev || opened.ino !== st.ino || opened.nlink !== 1) fail("DAILY_JOB_JOURNAL_UNSAFE");
      const jobs = parseLedger(await journal.readFile("utf8"));
      const prior = jobs.get(jobId.toLowerCase());
      if (!prior || prior.profile_id !== profile.profile_id) fail("DAILY_SETTLEMENT_JOB_MISMATCH");
      if (!["finished", "reconciled"].includes(prior.state)) {
        const result = await inspect(Object.freeze({ ...prior }));
        if (result?.status !== "committed" || result.job_id !== prior.job_id || result.profile_id !== prior.profile_id ||
          result.job_sha256 !== prior.request_sha256 || !/^[0-9a-f-]{36}$/i.test(result.canonical_receipt_id ?? "") ||
          !/^[0-9a-f-]{36}$/i.test(result.intent_id ?? "")) fail("DAILY_CANONICAL_SETTLEMENT_UNPROVEN");
        const row = { ...prior, state: "reconciled", result };
        await journal.writeFile(JSON.stringify(row) + "\n");await journal.sync();jobs.set(prior.job_id, row);
      }
      releaseExecutor = [...jobs.values()].every(row => row.profile_id === profile.profile_id && ["finished", "reconciled"].includes(row.state));
      return { status: "reconciled", result: jobs.get(prior.job_id).result, write_gate_released: releaseExecutor };
    } finally { await journal.close(); }
  } finally {
    if (releaseExecutor) await fs.unlink(lockPath);
    await operator.close();await fs.unlink(operatorPath);
  }
}
