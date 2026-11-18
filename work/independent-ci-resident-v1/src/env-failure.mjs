// Environment failures of a required-tests job (Task 1b): a job that died only because of the network or the runner's own setup, with
// no test failing, may be re-run once ("Re-run all jobs", the only re-run clued-required-tests.yml allows). Evidence only, read from
// the job record (its steps) and its log; whatever does not prove an environment failure is "not environment" and never re-run:
//   setup:   every failed step is one of the runner's own steps before the workflow's, in its place: "Set up job", then the job-started
//            hook's "Set up runner" (defect B: the hook refused the job). It died before the workflow's own steps began; no test ran, no
//            log needed. A workflow step of either name sits later in the job and does not count;
//   network: the log names a network failure and shows no failed test, assertion, or "N failed" summary anywhere.
// The classifier of the admission gate (scripts/ci/clued-work-admission.mjs) lives there, inside the pinned file; this is its copy for the
// companion's admission-rerun lane, and test/env-failure.test.mjs keeps the two identical.
// N9: the staging repair uses the same log veto as the gate's existing classifier.
export function hasTimeoutEvidence(job, log, annotations) {
  return job?.status === 'completed' && job.conclusion === 'cancelled' && job.steps?.length > 0 && failedSteps(job)?.length === 0
    && job.steps.every(step => typeof step?.conclusion === 'string')
    && Array.isArray(annotations) && annotations.some(note =>
      typeof note?.message === 'string' && note.message.startsWith('The job has exceeded the maximum execution time of '))
    && typeof log === 'string' && log.length > 0 && log.length <= MAX_LOG_CHARS && !TEST_FAILURE.some(pattern => pattern.test(log));
}

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
// job: the Actions API job record; log: its log text, or null when it was not read. -> { environment, kind, why }
export function jobFailureKind(job, log = null) {
  const no = (why) => ({ environment: false, kind: "unknown", why });
  if (!job || job.status !== "completed" || job.conclusion !== "failure") return no("the job did not end in failure");
  if (diedInSetup(job)) return { environment: true, kind: "setup", why: `the runner's ${failedSteps(job).map((step) => step.name).join(", ")} step failed` };
  const failed = failedSteps(job);
  if (failed === null || failed.length === 0) return no("the job record names no failed step");
  if (typeof log !== "string" || log.length === 0 || log.length > MAX_LOG_CHARS) return no("the job log is missing or too long to judge");
  if (TEST_FAILURE.some((pattern) => pattern.test(log))) return { environment: false, kind: "test", why: "the log shows a failed test" };
  const network = NETWORK_FAILURE.find((pattern) => pattern.test(log));
  return network ? { environment: true, kind: "network", why: `the log shows a network failure (${network.source.slice(0, 40)}) and no failed test` } : no("the log shows no network failure");
}
