import { storageAgentResult } from "./storage-agent-tools";
type Data = Record<string, unknown>;
export const RECOVERY_STAGES = ["request", "descriptor", "credential", "provider", "verification", "verified_record", "settlement"] as const;
export type RecoveryStage = typeof RECOVERY_STAGES[number];
export const RECOVERY_REASONS = ["REQUEST_UNAVAILABLE", "DESCRIPTOR_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_EXPIRING",
  "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_INVALID", "PROVIDER_IDENTITY_CHANGED", "REVISION_UNCHANGED",
  "CONTENT_MISMATCH", "PREVIOUS_REVISION_UNCONFIRMED", "RESULT_NOT_YET_VISIBLE", "VERIFIED_RECORD_UNCONFIRMED",
  "SETTLEMENT_UNCONFIRMED", "UNKNOWN_EFFECT"] as const;
export const RECOVERY_NEXT_ACTIONS = ["retry_metadata", "check_existing_authorization", "inspect_original_receipt", "continue_object_recovery", "none"] as const;
export type RecoveryDiagnostic = { stage: RecoveryStage; reason: typeof RECOVERY_REASONS[number]; observed_at: string;
  automatic_next_action: typeof RECOVERY_NEXT_ACTIONS[number] };
const reasons: Readonly<Record<string, RecoveryDiagnostic["reason"]>> = Object.freeze({
  storage_recovery_credential_expiring: "CREDENTIAL_EXPIRING",
  DRIVE_CREDENTIAL_UNAVAILABLE: "CREDENTIAL_UNAVAILABLE",
  DRIVE_NAMESPACE_VISIBILITY_UNPROVEN: "CREDENTIAL_UNAVAILABLE",
  DRIVE_METADATA_TIMEOUT: "PROVIDER_TIMEOUT", DRIVE_METADATA_ABORTED: "PROVIDER_TIMEOUT",
  DRIVE_METADATA_UNAVAILABLE: "PROVIDER_UNAVAILABLE", DRIVE_METADATA_REQUEST_FAILED: "PROVIDER_UNAVAILABLE",
  DRIVE_METADATA_SUBREQUEST_LIMIT: "PROVIDER_UNAVAILABLE", storage_redirect_rejected: "PROVIDER_RESPONSE_INVALID",
  DRIVE_METADATA_RESPONSE_INVALID: "PROVIDER_RESPONSE_INVALID", DRIVE_METADATA_MISMATCH: "PROVIDER_IDENTITY_CHANGED",
  DRIVE_LIST_INVALID: "PROVIDER_RESPONSE_INVALID", DRIVE_PAGINATION_INVALID: "PROVIDER_RESPONSE_INVALID",
  DRIVE_POSTCONDITION_REQUEST_MISMATCH: "DESCRIPTOR_UNAVAILABLE",
  DRIVE_POSTCONDITION_IDENTITY_MISMATCH: "PROVIDER_IDENTITY_CHANGED",
  DRIVE_POSTCONDITION_PARENT_AMBIGUOUS: "PROVIDER_IDENTITY_CHANGED", DRIVE_POSTCONDITION_ANCESTOR_CHANGED: "PROVIDER_IDENTITY_CHANGED",
  DRIVE_POSTCONDITION_REVISION_UNCHANGED: "REVISION_UNCHANGED", DRIVE_POSTCONDITION_CONTENT_MISMATCH: "CONTENT_MISMATCH",
  DRIVE_POSTCONDITION_PREVIOUS_REVISION_NOT_KEPT: "PREVIOUS_REVISION_UNCONFIRMED",
  DRIVE_POSTCONDITION_SYNC_TIMEOUT: "RESULT_NOT_YET_VISIBLE",
});
const defaults: Readonly<Record<RecoveryStage, RecoveryDiagnostic["reason"]>> = Object.freeze({
  request: "REQUEST_UNAVAILABLE", descriptor: "DESCRIPTOR_UNAVAILABLE", credential: "CREDENTIAL_UNAVAILABLE",
  provider: "PROVIDER_UNAVAILABLE", verification: "RESULT_NOT_YET_VISIBLE", verified_record: "VERIFIED_RECORD_UNCONFIRMED",
  settlement: "SETTLEMENT_UNCONFIRMED",
});

/** Only closed codes cross the Owner boundary. Exception messages, provider
 * bodies, sealed descriptors, credentials and database details never do. */
export function recoveryDiagnostic(stage: RecoveryStage, error: unknown, now = Date.now(), timedOut = false): RecoveryDiagnostic {
  const recognized = error instanceof Error && Object.hasOwn(reasons, error.message) ? reasons[error.message] : undefined;
  const reason = timedOut ? "PROVIDER_TIMEOUT" : recognized ?? defaults[stage];
  const automatic_next_action = reason === "CREDENTIAL_UNAVAILABLE" || reason === "CREDENTIAL_EXPIRING"
    ? "check_existing_authorization" : stage === "verified_record" || stage === "settlement"
      ? "inspect_original_receipt" : "retry_metadata";
  return Object.freeze({ stage, reason, observed_at: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(), automatic_next_action });
}

export function sanitizeRecoveryDiagnostic(value: unknown): RecoveryDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const d = value as Data;
  if (Object.keys(d).sort().join(",") !== "automatic_next_action,observed_at,reason,stage" ||
      !RECOVERY_STAGES.includes(d.stage as RecoveryStage) || !RECOVERY_REASONS.includes(d.reason as RecoveryDiagnostic["reason"]) ||
      !RECOVERY_NEXT_ACTIONS.includes(d.automatic_next_action as RecoveryDiagnostic["automatic_next_action"]) ||
      typeof d.observed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(d.observed_at) ||
      !Number.isFinite(Date.parse(d.observed_at))) return;
  return { stage: d.stage as RecoveryStage, reason: d.reason as RecoveryDiagnostic["reason"], observed_at: d.observed_at,
    automatic_next_action: d.automatic_next_action as RecoveryDiagnostic["automatic_next_action"] };
}

function reviewAvailability(raw: Data): Data {
  if (!("review_available" in raw) && !("abandon_available" in raw)) return {};
  if (typeof raw.review_available !== "boolean" || "abandon_available" in raw && typeof raw.abandon_available !== "boolean")
    throw new Error("storage_recovery_response_invalid");
  const availability = { review_available: raw.review_available, ...("abandon_available" in raw ? { abandon_available: raw.abandon_available } : {}),
    ...(!raw.review_available ? { review_unavailable_reason: raw.review_unavailable_reason === "DIRECTORY_REVIEW_UNSUPPORTED"
      ? "DIRECTORY_REVIEW_UNSUPPORTED" : "REVIEW_UNAVAILABLE" } : {}) };
  if (!raw.review_available && raw.abandon_available !== true) return availability;
  if (!Number.isSafeInteger(raw.base_version) || Number(raw.base_version) < 1 || typeof raw.source_receipt_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw.source_receipt_id) ||
      (raw.review_available || raw.file_name !== undefined) && (typeof raw.file_name !== "string" || !raw.file_name.length || raw.file_name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(raw.file_name)))
    throw new Error("storage_recovery_response_invalid");
  return { ...availability, base_version: raw.base_version, source_receipt_id: raw.source_receipt_id,
    ...(raw.file_name !== undefined ? { file_name: raw.file_name } : {}) };
}

function automaticRecovery(raw: Data): Data {
  if (!("automatic_recovery" in raw)) return {};
  if (!["pending", "current_state_conflict", "resolved"].includes(String(raw.automatic_recovery)) ||
      raw.automatic_recovery === "resolved" && raw.status !== "resolved" ||
      raw.automatic_recovery !== "resolved" && ["resolved", "committed", "cancelled", "denied"].includes(String(raw.status)))
    throw new Error("storage_recovery_response_invalid");
  return { automatic_recovery: raw.automatic_recovery };
}

function currentDirectoryState(raw: Data): Data {
  if (Object.hasOwn(raw,"current_path") && (!Object.hasOwn(raw,"current_artifact_state") ||
      raw.current_artifact_state !== "active" || typeof raw.current_path !== "string" ||
      raw.current_path.length < 2 || raw.current_path.length > 1000 || raw.current_path.endsWith("/") ||
      /[\\\p{Cc}]/u.test(raw.current_path) || raw.current_path.split("/").some(part=>part==="."||part==="..")))
    throw new Error("storage_recovery_response_invalid");
  if (!Object.hasOwn(raw, "current_artifact_state")) return {};
  if (raw.status !== "resolved" || raw.resolution !== "automatically_registered_current_state" ||
      raw.automatic_recovery !== "resolved" || typeof raw.current_artifact_state !== "string" || !["active", "trashed"].includes(raw.current_artifact_state))
    throw new Error("storage_recovery_response_invalid");
  return { current_artifact_state: raw.current_artifact_state,
    ...(Object.hasOwn(raw,"current_path")?{current_path:raw.current_path}:{}) };
}

export function storageRecoveryResolutionResult(value: unknown, reference: Data): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("storage_recovery_response_invalid");
  const raw = value as Data, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const automatic = ["automatically_reconciled_before", "automatically_registered_current_state"].includes(String(raw.resolution));
  if (raw.status !== "resolved" || !["accepted_current_state", "abandoned_registration", "automatically_reconciled_before", "automatically_registered_current_state"].includes(String(raw.resolution)) ||
      raw.connection_id !== reference.connection_id || raw.job_id !== reference.job_id || raw.execution_permitted !== false ||
      !uuid.test(String(raw.receipt_id)) || !uuid.test(String(raw.source_receipt_id)) ||
      !Number.isSafeInteger(raw.base_version) || Number(raw.base_version) < 1 ||
      raw.receipt_id === raw.source_receipt_id || automatic && raw.automatic_recovery !== "resolved" ||
      (!automatic && raw.resolution === "accepted_current_state" || raw.observation_id != null) && !uuid.test(String(raw.observation_id)))
    throw new Error("storage_recovery_response_invalid");
  return { status: "resolved", resolution: raw.resolution, connection_id: raw.connection_id, job_id: raw.job_id,
    receipt_id: raw.receipt_id, source_receipt_id: raw.source_receipt_id, base_version: raw.base_version,
    ...(raw.observation_id !== undefined ? { observation_id: raw.observation_id } : {}), review_available: false,
    ...(automatic ? { automatic_recovery: "resolved" } : {}), ...currentDirectoryState(raw), execution_permitted: false };
}

/** Native recovery may show a quarantined conflict as attention required. The
 * normal Agent job projection remains unchanged. */
export function storageRecoveryOwnerResult(value: unknown, reference: Data): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("storage_recovery_response_invalid");
  const raw = value as Data;
  currentDirectoryState(raw);
  if (raw.status === "resolved") return storageRecoveryResolutionResult(raw, reference);
  const projected = storageAgentResult(raw.status === "conflict" ? { ...raw, status: "attention_required" } : raw, reference);
  if (projected.job_id !== reference.job_id || projected.connection_id !== reference.connection_id ||
      typeof projected.receipt_id !== "string" || projected.execution_permitted !== false)
    throw new Error("storage_recovery_response_invalid");
  const review = { ...reviewAvailability(raw), ...automaticRecovery(raw) };
  if (!("diagnostic" in raw) || raw.diagnostic === null) return { ...projected, ...review };
  const diagnostic = sanitizeRecoveryDiagnostic(raw.diagnostic);
  if (!diagnostic) throw new Error("storage_recovery_response_invalid");
  return { ...projected, ...review, diagnostic };
}

export function storageRecoveryListResult(value: unknown, connectionId: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("storage_recovery_response_invalid");
  const raw = value as Data, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (raw.status !== "ok" || raw.connection_id !== connectionId || raw.execution_permitted !== false ||
      !Array.isArray(raw.jobs) || raw.jobs.length > 20) throw new Error("storage_recovery_response_invalid");
  const seen = new Set<string>();
  const jobs = raw.jobs.map(job => {
    if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("storage_recovery_response_invalid");
    const j = job as Data;
    if (typeof j.connection_id !== "string" || !uuid.test(j.connection_id) ||
        (j.read_connection_id !== undefined ? j.read_connection_id !== connectionId : j.connection_id !== connectionId) ||
        j.execution_permitted !== false || typeof j.job_id !== "string" || !uuid.test(j.job_id) ||
        typeof j.receipt_id !== "string" || !uuid.test(j.receipt_id) || seen.has(j.job_id) ||
        !["queued", "prepared", "started", "uncertain", "committed", "cancelled", "denied", "attention_required", "conflict", "resolved"].includes(String(j.status)))
      throw new Error("storage_recovery_response_invalid");
    seen.add(j.job_id);
    currentDirectoryState(j);
    const context = j.read_connection_id !== undefined ? { read_connection_id: connectionId } : {};
    if (j.status === "resolved") return { ...storageRecoveryResolutionResult(j, { connection_id: j.connection_id, job_id: j.job_id }), ...context };
    const diagnostic = j.diagnostic === null || j.diagnostic === undefined ? undefined : sanitizeRecoveryDiagnostic(j.diagnostic);
    if (j.diagnostic != null && !diagnostic) throw new Error("storage_recovery_response_invalid");
    return { job_id: j.job_id, connection_id: j.connection_id, ...context, receipt_id: j.receipt_id, status: j.status === "conflict" ? "attention_required" : j.status,
      execution_permitted: false, ...reviewAvailability(j), ...automaticRecovery(j), ...(diagnostic ? { diagnostic } : {}) };
  });
  return { status: "ok", connection_id: connectionId, jobs, execution_permitted: false };
}
