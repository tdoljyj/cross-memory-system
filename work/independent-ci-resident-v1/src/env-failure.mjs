// The pinned gate and standalone runner hook carry the same failure classifier.
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
