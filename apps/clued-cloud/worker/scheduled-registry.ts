import {
  fetchWorkerDue, projectionBuilderToken, wakeProjectionRefresh, runStorageCloudJob,
  runStorageRefreshScheduled, runStorageRecoveryScheduled, runStorageUnattemptedReleaseScheduled,
  runStorageStagingScheduled, runStorageOnboardScheduled, type ContinuityEnv,
} from "./continuity";
import { runStorageQueuedSweepScheduled } from "./storage-queued-dispatch";
import { runStorageAccessDigestBackfillScheduled } from "./storage-access-digest-backfill";
import { storageScheduleEnabled } from "./storage-scheduled-flags";

// Wire contract of clued_worker_due_v1. Each key must have exactly one task.
type WorkerDue = {
  projection_refresh: boolean;
  storage_refresh: boolean;
  storage_recovery: boolean;
  storage_unattempted_release: boolean;
  storage_queued_sweep: boolean;
  storage_access_digest_backfill: boolean;
  storage_staging: boolean;
  storage_onboard: boolean;
};

type ScheduledTask = {
  enabled(env: ContinuityEnv): boolean;
  run(env: ContinuityEnv): Promise<unknown>;
};

function warn(event: string, fields: Record<string, unknown> = {}) {
  console.warn(JSON.stringify({ event, ...fields }));
}

const registry = {
  projection_refresh: {
    enabled: env => Boolean(projectionBuilderToken(env)),
    run: wakeProjectionRefresh,
  },
  storage_refresh: {
    enabled: storageScheduleEnabled.refresh,
    async run(env) {
      const { status } = await runStorageRefreshScheduled(env);
      if (status === "unavailable" || status === "attention_required") warn("storage_refresh_attention_required", { status });
    },
  },
  storage_recovery: {
    enabled: storageScheduleEnabled.recovery,
    async run(env) {
      const { status } = await runStorageRecoveryScheduled(env);
      if (status === "unavailable" || status === "attention_required") warn("storage_recovery_attention_required", { status });
    },
  },
  storage_unattempted_release: {
    enabled: storageScheduleEnabled.unattemptedRelease,
    async run(env) {
      const result = await runStorageUnattemptedReleaseScheduled(env);
      if (result.status === "unavailable") warn("storage_unattempted_release_unavailable");
      if (result.status === "ok" && result.released > 0) warn("storage_unattempted_released", { released: result.released });
    },
  },
  storage_queued_sweep: {
    enabled: storageScheduleEnabled.queuedSweep,
    async run(env) {
      const result = await runStorageQueuedSweepScheduled(env, { runJob: runStorageCloudJob });
      if (result.status === "unavailable") warn("storage_queued_sweep_unavailable");
      if (result.status === "ok" && (result.settled > 0 || result.dispatched > 0 || result.root_busy > 0)) {
        warn("storage_queued_sweep", { settled: result.settled, dispatched: result.dispatched, root_busy: result.root_busy });
      }
    },
  },
  storage_access_digest_backfill: {
    enabled: storageScheduleEnabled.accessDigestBackfill,
    async run(env) {
      const result = await runStorageAccessDigestBackfillScheduled(env);
      if (result.status === "unavailable") warn("storage_access_digest_backfill_unavailable");
      if (result.status === "ok" && (result.recorded > 0 || result.missing > 0 || result.skipped > 0)) {
        warn("storage_access_digest_backfill", { recorded: result.recorded, missing: result.missing, skipped: result.skipped });
      }
    },
  },
  storage_staging: {
    enabled: storageScheduleEnabled.staging,
    async run(env) {
      const { status } = await runStorageStagingScheduled(env);
      if (status === "unavailable") warn("storage_staging_sweep_unavailable");
    },
  },
  storage_onboard: {
    enabled: storageScheduleEnabled.onboard,
    async run(env) {
      const { status } = await runStorageOnboardScheduled(env);
      if (status === "unavailable" && env.CLUED_STORAGE_ONBOARD_V1 === "true") warn("storage_onboard_sweep_unavailable");
    },
  },
} satisfies Record<keyof WorkerDue, ScheduledTask>;

const dueKeys = Object.keys(registry) as (keyof WorkerDue)[];
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDue(value: unknown): WorkerDue {
  if (!object(value) || value.status !== "ok" || typeof value.observed_at !== "string" ||
      !Number.isFinite(Date.parse(value.observed_at))) throw new Error("invalid_due_envelope");
  const due = value.due;
  if (!object(due) || Object.keys(due).length !== dueKeys.length ||
      !dueKeys.every(key => typeof due[key] === "boolean")) throw new Error("invalid_due_flags");
  return due as WorkerDue;
}

export async function runScheduledTasks(env: ContinuityEnv, ctx: { waitUntil(promise: Promise<unknown>): void }) {
  let due: WorkerDue;
  try {
    due = readDue(await fetchWorkerDue(env));
  } catch {
    warn("worker_due_unavailable");
    return;
  }
  for (const dueKey of dueKeys) {
    const task = registry[dueKey];
    if (due[dueKey] && task.enabled(env)) ctx.waitUntil(task.run(env));
  }
}
