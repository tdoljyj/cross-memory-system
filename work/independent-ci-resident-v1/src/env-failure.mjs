// The one failure rule (Fable 11-20, 单一判定): the classifier and the repair history. The gate imports this module; the companion's lane
// calls it; the runner hook, which its loader runs as one file from main, holds a copy the admission self-tests lock byte for byte.
export const SETUP_STEPS = ["Set up job", "Set up runner"];
// A log longer than this is never classified (the tail with the verdict may be missing): not environment.
export const MAX_LOG_CHARS = 3_500_000;
const NETWORK_FAILURE = [
  /\bECONNRESET\b/, /\bETIMEDOUT\b/, /\bEAI_AGAIN\b/, /\bENOTFOUND\b/, /\bECONNREFUSED\b/, /\bEPIPE\b/,
  /socket hang up/i, /network (?:aborted|timeout|socket disconnected)/i, /connection reset by peer/i, /TLS handshake timeout/i,
  /could not resolve host/i, /temporary failure in name resolution/i, /unexpected disconnect while reading sideband/i,
  /RPC failed; curl \d+/, /early EOF/i, /\b429 Too Many Requests\b/i,
  /npm (?:ERR!|error) network/i, /request to https?:\/\/\S+ failed, reason:/i,
];
const TEST_FAILURE = [
  /\bnot ok \d+/, /# fail [1-9]\d*/, /\bAssertionError\b/, /✖/, /\b[1-9]\d* (?:failed|failing)\b/i, /(?:^|\s)FAIL(?:\s|$)/,
];
export function failedSteps(job) {
  return Array.isArray(job?.steps) ? job.steps.filter((step) => step && step.conclusion === "failure") : null;
}
// Did the job die in the runner's own setup, before any workflow step ran?
export function diedInSetup(job) {
  if (!job || job.status !== "completed" || job.conclusion !== "failure") return false;
  const failed = failedSteps(job);
  return failed !== null && failed.length > 0 && failed.every((step) => SETUP_STEPS[job.steps.indexOf(step)] === step.name);
}
// Did GitHub end the job before any runner took it (9aba97c1)? No step ran and the record says no runner (runner_id 0 or null and runner_name
// null or empty, as GitHub records it); a record without those fields proves nothing.
export function neverAssigned(job) {
  return !!job && job.status === "completed" && ["failure", "cancelled"].includes(job.conclusion) && Array.isArray(job.steps)
    && job.steps.length === 0 && [0, null].includes(job.runner_id) && [null, ""].includes(job.runner_name);
}
// The timeout annotation is emitted on the cancelled job's check run, independently of its log.
function hasTimeoutAnnotation(annotations) {
  return Array.isArray(annotations) && annotations.some(note =>
    typeof note?.message === "string" && note.message.startsWith("The job has exceeded the maximum execution time of "));
}
export function jobFailureKind(job, log = null, annotations = null) {
  const no = (why) => ({ environment: false, kind: "unknown", why });
  if (job?.status !== "completed" || !["failure", "cancelled"].includes(job.conclusion)) return no("the job did not fail or cancel");
  if (diedInSetup(job)) return { environment: true, kind: "setup", why: `the runner's ${failedSteps(job).map((step) => step.name).join(", ")} step failed` };
  if (neverAssigned(job)) return { environment: true, kind: "unassigned", why: "no runner took the job and no step ran" };
  const failed = failedSteps(job);
  const cancelled = job.conclusion === "cancelled";
  if (cancelled) {
    if (failed === null || !job.steps.length || failed.length > 0
      || job.steps.some(step => typeof step?.conclusion !== "string")) return no("the cancelled job lacks a complete record without failed steps");
    if (!hasTimeoutAnnotation(annotations)) return no("the cancelled job has no timeout annotation");
  } else if (!failed?.length) return no("the job record names no failed step");
  if (typeof log !== "string" || log.length === 0 || log.length > MAX_LOG_CHARS) return no("the job log is missing or too long to judge");
  if (TEST_FAILURE.some((pattern) => pattern.test(log))) return { environment: false, kind: "test", why: "the log shows a failed test" };
  if (cancelled) return { environment: true, kind: "timeout", why: "the job exceeded its maximum execution time and the log shows no failed test" };
  const network = NETWORK_FAILURE.find((pattern) => pattern.test(log));
  return network ? { environment: true, kind: "network", why: `the log shows a network failure (${network.source.slice(0, 40)}) and no failed test` } : no("the log shows no network failure");
}

// GitHub's earlier attempts are the repair budget. Skipped jobs after a
// known gate refusal or setup death do not consume it.
const REPAIR_GATE_JOB = "admission-gate";
const REPAIR_NOT_ADMITTED = /^(?:ADMISSION_PENDING|RERUN_REFUSED):/;
const REPAIR_TRANSIENT_API_ERROR = /^GitHub API \S+ (?:returned 5[0-9]{2}|could not be reached after [0-9]+ attempts)/;
// Fable 11-20 (补：车头缺必需检查): at most three attempts of a workflow on one head in all (the first run and two re-runs), whatever made
// them (this rule, the companion's lane, a person) and for both kinds of process cause together (a run that produced no result, and the
// environment failures below): every run of the workflow on the head counts. The smaller of it and the environment limit holds.
export const REPAIR_ATTEMPTS_MAX = 3;

async function repairAnnotations(read, repository, jobId) {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("the job has no check run ID");
  const notes = [];
  for (let page = 1; page <= 50; page += 1) {
    const batch = await read(`/repos/${repository}/check-runs/${jobId}/annotations?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) throw new Error("the job annotations are unreadable");
    notes.push(...batch);
    if (batch.length < 100) return notes;
  }
  throw new Error("the job annotations are incomplete");
}

async function repairEnvironmentFailures({ read, readLog, repository, heavy }) {
  if (heavy.some(job => job.status !== "completed" || !["success", "skipped", "failure", "cancelled"].includes(job.conclusion))) return null;
  const failures = [];
  for (const job of heavy) {
    if (job.conclusion === "success" || job.conclusion === "skipped") continue;
    // A job no runner took (9aba97c1) ran nothing, like a setup death: no log, no annotation.
    const unassigned = neverAssigned(job);
    const setup = diedInSetup(job) || unassigned;
    const cancelled = job.conclusion === "cancelled" && !unassigned;
    const steps = failedSteps(job);
    if (!setup && (!Number.isSafeInteger(job.id) || job.id <= 0 || !steps || (cancelled ? steps.length > 0 : steps.length === 0))) return null;
    const annotations = cancelled ? await repairAnnotations(read, repository, job.id) : null;
    if (cancelled && !hasTimeoutAnnotation(annotations)) return null;
    const log = setup ? null : await readLog(`/repos/${repository}/actions/jobs/${job.id}/logs`);
    const evidence = jobFailureKind(job, log, annotations);
    if (!evidence.environment || typeof job.name !== "string" || !job.name) return null;
    failures.push({ name: job.name, kind: evidence.kind });
  }
  return failures.length > 0 ? failures : null;
}

async function hasRepairRecovery({ read, repository, runId, workflowId, head, after, jobs }) {
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0 || !Number.isFinite(after)) return false;
  const needed = new Set(jobs);
  // Include old attempts of other runs and successes in runs that failed a
  // different job. A run may have started before the failed attempt ended.
  for (let page = 1; page <= 50; page += 1) {
    const listing = await read(`/repos/${repository}/actions/workflows/${workflowId}/runs?per_page=100&page=${page}`);
    const runs = listing?.workflow_runs;
    if (!Array.isArray(runs) || runs.length > 100) return false;
    for (const run of runs) {
      if (run?.workflow_id !== workflowId || !Number.isSafeInteger(run.id) || run.id <= 0 || String(run.id) === String(runId)
        || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "") || run.head_sha === head
        || (run.status === "completed" && Date.parse(run.updated_at) <= after)) continue;
      for (let jobPage = 1; jobPage <= 50; jobPage += 1) {
        const { jobs: candidates } = await read(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${jobPage}`) ?? {};
        if (!Array.isArray(candidates) || candidates.length > 100) return false;
        for (const job of candidates) {
          if (job?.head_sha === run.head_sha && job.status === "completed" && job.conclusion === "success"
            && Date.parse(job.completed_at) > after) needed.delete(job.name);
        }
        if (needed.size === 0) return true;
        if (candidates.length < 100) break;
      }
    }
    if (runs.length < 100) break;
  }
  return false;
}

// Attempts of the workflow on the head, this one included: the run's attempt and every other run of the same workflow on the head.
async function headAttempts({ read, repository, runId, head, attempt, workflowId }) {
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0) return attempt;
  const listing = await read(`/repos/${repository}/actions/runs?head_sha=${head}&per_page=100&page=1`);
  const runs = listing?.workflow_runs;
  if (!Array.isArray(runs) || runs.length > 100 || listing.total_count !== runs.length) throw new Error("the head's runs are unreadable");
  return attempt + runs.filter(run => run?.workflow_id === workflowId && run.head_sha === head && String(run.id) !== String(runId))
    .reduce((n, run) => n + (Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 ? run.run_attempt : 1), 0);
}

// The one answer to "may this attempt be a repair" (the gate imports it, the companion's lane calls it, the runner hook holds a copy the
// admission self-tests lock byte for byte). Refusals carry why for the lane: unreadable (read again later), waiting (no recovery evidence
// yet), exhausted (three real attempts, with the last failures), budget (three attempts of the workflow on the head).
export async function requiredTestsRepairHistory({ read, readLog, repository, runId, head, attempt, workflowId }) {
  const refuse = (reason, more = {}) => ({ allowed: false, reason, ...more });
  const attempts = [];
  let realAttempts = 0;
  let lastFailures = [];
  let lastKinds = [];
  let completedAt;
  try {
    for (let earlier = 1; earlier < attempt; earlier += 1) {
      const body = await read(`/repos/${repository}/actions/runs/${runId}/attempts/${earlier}/jobs?per_page=100`);
      const jobs = body?.jobs;
      if (!Array.isArray(jobs) || body.total_count !== jobs.length || jobs.length > 100 || jobs.some(job => !job || typeof job !== "object"))
        return refuse(`attempt ${earlier}'s job list is incomplete`);
      const gates = jobs.filter(job => job.name === REPAIR_GATE_JOB);
      const heavy = jobs.filter(job => job.name !== REPAIR_GATE_JOB);
      if (gates.length !== 1 || heavy.length === 0)
        return refuse(`attempt ${earlier} does not list one ${REPAIR_GATE_JOB} job and its heavy jobs`);
      if (jobs.some(job => job.head_sha !== head))
        return refuse(`attempt ${earlier} has a job of another head than ${head}`);
      if (jobs.some(job => job.run_attempt != null && Number(job.run_attempt) !== earlier))
        return refuse(`attempt ${earlier} has a job of another attempt`);
      const [gateJob] = gates;
      // A job no runner took (9aba97c1) ran nothing, like a skipped one.
      const ran = heavy.filter(job => (job.status !== "completed" || job.conclusion !== "skipped") && !neverAssigned(job));
      if (ran.length > 0) {
        realAttempts += 1;
        if (realAttempts === 3) return refuse("three real attempts have already run", { exhausted: lastKinds });
        const failures = gateJob.status === "completed" && gateJob.conclusion === "success"
          ? await repairEnvironmentFailures({ read, readLog, repository, heavy }) : null;
        if (!failures)
          return refuse(`attempt ${earlier} already ran ${ran.map(job => `${String(job.name).slice(0, 80)}: ${job.status}/${job.conclusion ?? "none"}`).join(", ")}; its gate or environment evidence does not allow repair`);
        lastFailures = failures.map(job => job.name);
        lastKinds = failures.map(job => ({ name: job.name, kind: job.kind }));
        completedAt = Math.max(...jobs.map(job => Date.parse(job.completed_at)));
        attempts.push({ attempt: earlier, heavy_jobs: heavy.length, environment_failure: lastFailures,
          environment_failure_kinds: Object.fromEntries(failures.map(job => [job.name, job.kind])) });
        continue;
      }
      // Nothing ran: the gate died in setup, or no runner took it or a job after it (GitHub then records them all cancelled, unrun).
      const setup = diedInSetup(gateJob) || neverAssigned(gateJob) || heavy.some(neverAssigned);
      const notes = !setup && gateJob.status === "completed" ? await repairAnnotations(read, repository, gateJob.id) : [];
      if (!setup && !notes.some(note =>
        (note?.title === REPAIR_GATE_JOB && REPAIR_NOT_ADMITTED.test(note.message ?? "")) ||
        (note?.title === "kooyumi-work-admission" && REPAIR_TRANSIENT_API_ERROR.test(note.message ?? ""))))
        return refuse(`the ${REPAIR_GATE_JOB} job of attempt ${earlier} did not end in ADMISSION_PENDING, RERUN_REFUSED or a GitHub API outage`);
      attempts.push({ attempt: earlier, heavy_jobs: heavy.length });
    }
    const total = await headAttempts({ read, repository, runId, head, attempt, workflowId });
    if (total > REPAIR_ATTEMPTS_MAX)
      return refuse(`three attempts of this workflow have already been made on this head (${total} with this one)`, { budget: true });
    if (realAttempts === 2 && !await hasRepairRecovery({ read, repository, runId, workflowId, head, after: completedAt, jobs: lastFailures }))
      return refuse("the second repair needs recovery evidence: a later success of each failed job in the same workflow on another commit", { waiting: true });
  } catch (error) {
    return refuse(`the earlier attempts could not be read (${error instanceof Error ? error.message : String(error)})`, { unreadable: true });
  }
  return { allowed: true, attempts };
}
