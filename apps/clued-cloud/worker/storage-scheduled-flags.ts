import type { ContinuityEnv } from "./continuity";

export function storageJobsEnabled(env: Pick<ContinuityEnv, "CLUED_STORAGE_ACCOUNT_V1" | "CLUED_STORAGE_JOBS_V1">) {
  return env.CLUED_STORAGE_ACCOUNT_V1 === "true" && env.CLUED_STORAGE_JOBS_V1 === "true";
}

// StorageNormalUse N3: binary upload is available only in account-policy mode, with every
// deployment piece present; anything missing fails closed.
export function storageBinaryEnabled(env: Pick<ContinuityEnv, "CLUED_STORAGE_ACCOUNT_V1" | "CLUED_STORAGE_JOBS_V1" | "CLUED_STORAGE_JOBS_V2" | "CLUED_STORAGE_GOOGLE_V1" | "CLUED_STORAGE_BINARY_V1">) {
  return storageJobsEnabled(env) && env.CLUED_STORAGE_GOOGLE_V1 === "true" && env.CLUED_STORAGE_JOBS_V2 === "true" &&
    env.CLUED_STORAGE_BINARY_V1 === "true";
}

const google = (env: ContinuityEnv) =>
  env.CLUED_STORAGE_ACCOUNT_V1 === "true" && env.CLUED_STORAGE_GOOGLE_V1 === "true";
const jobsV2 = (env: ContinuityEnv) => google(env) && env.CLUED_STORAGE_JOBS_V2 === "true";
const executor = (env: ContinuityEnv) => jobsV2(env) && env.CLUED_STORAGE_EXECUTOR_V1 === "true";

// Shared by the registry and direct sweep callers. Settlement and expiry must
// still work with the executor or the onboarding page switched off.
export const storageScheduleEnabled = {
  refresh: (env: ContinuityEnv) => google(env) && env.CLUED_STORAGE_REFRESH_V1 === "true",
  recovery: executor,
  unattemptedRelease: jobsV2,
  queuedSweep: (env: ContinuityEnv) => jobsV2(env) && env.CLUED_STORAGE_JOBS_V1 === "true",
  accessDigestBackfill: executor,
  staging: (env: ContinuityEnv) => storageBinaryEnabled(env) && env.CLUED_STORAGE_EXECUTOR_V1 === "true",
  onboard: google,
};
