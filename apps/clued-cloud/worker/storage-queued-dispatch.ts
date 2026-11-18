/**
 * BUG-20261008-001 (Clued Task f7a4dd7d): queued storage jobs are no longer
 * dispatched only once.
 *
 * The Worker dispatches a job once after submit. When that dispatch is lost, or
 * the database refuses its load (for example while an unsettled job fences the
 * root), the job used to stay queued for good. Every ten minutes this run calls
 * `clued_storage_queued_sweep_v1`, which settles text jobs still queued after
 * 2 hours as attention_required (reason DISPATCH_NOT_STARTED) and, with the
 * executor switch on, lists queued jobs of quiet roots with backoff. Each listed
 * job is dispatched exactly as after submit: through the job queue when bound,
 * else in place. The durable job and its fences decide what runs; a listed job
 * that already started only answers its status at load.
 */
import { resolveSupabasePublicConfig } from "../app/supabase-public-config";
import { databaseGatewayToken, type DatabaseGatewayEnv } from "./database-gateway";

export interface StorageQueuedSweepEnv extends DatabaseGatewayEnv {
  CLUED_STORAGE_ACCOUNT_V1?: string;
  CLUED_STORAGE_JOBS_V1?: string;
  CLUED_STORAGE_JOBS_V2?: string;
  CLUED_STORAGE_GOOGLE_V1?: string;
  CLUED_STORAGE_EXECUTOR_V1?: string;
  CLUED_STORAGE_CONNECTOR_ISSUER?: string;
  CLUED_STORAGE_JOB_QUEUE?: { send(body: { connection_id: string; job_id: string }): Promise<unknown> };
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

type Reference = { connection_id: string; job_id: string };
export type StorageQueuedSweepResult =
  | { status: "disabled" | "unavailable" }
  | { status: "ok"; settled: number; dispatched: number; root_busy: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

const count = (value: unknown, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** The settlement runs with the storage account, Google and jobs flags; dispatch also needs the executor switch. */
export async function runStorageQueuedSweepScheduled(env: StorageQueuedSweepEnv,
  deps: { runJob: (env: StorageQueuedSweepEnv, reference: Reference) => Promise<unknown> }): Promise<StorageQueuedSweepResult> {
  if (env.CLUED_STORAGE_ACCOUNT_V1 !== "true" || env.CLUED_STORAGE_JOBS_V1 !== "true" ||
      env.CLUED_STORAGE_GOOGLE_V1 !== "true" || env.CLUED_STORAGE_JOBS_V2 !== "true") return { status: "disabled" };
  const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER;
  const gatewayToken = databaseGatewayToken(env);
  if (!issuer || issuer.length < 32 || !gatewayToken) return { status: "unavailable" };
  const dispatch = env.CLUED_STORAGE_EXECUTOR_V1 === "true";
  let result: Record<string, unknown>;
  try {
    const defaults = resolveSupabasePublicConfig({});
    const url = (env.SUPABASE_URL ?? defaults.url).replace(/\/$/, "");
    const key = env.SUPABASE_PUBLISHABLE_KEY ?? defaults.key;
    const response = await fetch(`${url}/rest/v1/rpc/clued_storage_queued_sweep_v1`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
      headers: { apikey: key, authorization: `Bearer ${gatewayToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ p_issuer_hash: await sha256(issuer), p_input: { action: "due", dispatch } }),
    });
    if (!response.ok) return { status: "unavailable" };
    result = await response.json() as Record<string, unknown>;
  } catch { return { status: "unavailable" }; }
  const jobs = result?.jobs;
  if (!result || typeof result !== "object" || result.status !== "ok" || !count(result.settled, 3) || !count(result.root_busy, 20) ||
      !Array.isArray(jobs) || jobs.length > 3 || (!dispatch && jobs.length > 0) ||
      !jobs.every(job => job && typeof job === "object" && Object.keys(job).sort().join(",") === "connection_id,job_id" &&
        UUID.test(String(job.connection_id)) && UUID.test(String(job.job_id)))) return { status: "unavailable" };
  let dispatched = 0;
  for (const job of jobs as Reference[]) {
    const reference = { connection_id: job.connection_id, job_id: job.job_id };
    try {
      if (env.CLUED_STORAGE_JOB_QUEUE) {
        try { await env.CLUED_STORAGE_JOB_QUEUE.send(reference); dispatched++; continue; }
        catch { console.warn(JSON.stringify({ event: "storage_job_enqueue_failed" })); }
      }
      await deps.runJob(env, reference);
      dispatched++;
    } catch { /* The job stays queued; its backoff is already counted. */ }
  }
  return { status: "ok", settled: Number(result.settled), dispatched, root_busy: Number(result.root_busy) };
}
