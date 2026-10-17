import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation, RESOURCE_CENTER_POLICY_VERSION } from "../policy/resource-center-mutation-policy.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const reservationFailures = new WeakMap();
const reservationStages = Object.freeze({
  provider_identity: "RESERVATION_PROVIDER_IDENTITY_UNAVAILABLE",
  recovery_ticket: "RESERVATION_RECOVERY_TICKET_UNAVAILABLE",
  prepare_rpc: "RESERVATION_PREPARE_RPC_UNAVAILABLE",
  prepare_result: "RESERVATION_PREPARE_RESPONSE_INVALID",
  start_rpc: "RESERVATION_START_RPC_UNAVAILABLE",
  start_result: "RESERVATION_START_RESPONSE_INVALID",
  begin_rpc: "RESERVATION_BEGIN_RPC_UNAVAILABLE",
  begin_result: "RESERVATION_BEGIN_RESPONSE_INVALID",
  reservation_result: "RESERVATION_RESPONSE_INVALID",
});
const unreservedStages = new Set(["provider_identity", "recovery_ticket"]);
const reservationRpcReasons = Object.freeze(Object.fromEntries([
  "storage_cloud_denied", "storage_cloud_snapshot_changed", "storage_cloud_credential_changed",
  "storage_cloud_mode_denied", "storage_cloud_unqualified", "storage_job_unavailable",
  "storage_job_attempt_mismatch", "storage_job_prepare_denied", "storage_job_start_denied",
  "storage_root_has_unresolved_mutation", "storage_object_under_review",
  "work_claim_not_active", "work_claim_not_covered", "work_claim_not_holder", "work_claim_fence_mismatch",
].map(reason => [reason, reason.toUpperCase()])));
const reservationReasons = new Set([
  ...Object.values(reservationStages),
  ...Object.values(reservationRpcReasons),
  "RESOURCE_CENTER_WRITER_UNAVAILABLE", "RESOURCE_CENTER_WRITER_RESPONSE_MISMATCH",
  "RESOURCE_CENTER_RESERVATION_DENIED", "RESOURCE_CENTER_START_DENIED",
  "DRIVE_METADATA_TIMEOUT", "DRIVE_METADATA_ABORTED", "DRIVE_METADATA_REQUEST_FAILED",
  "DRIVE_METADATA_UNAVAILABLE", "DRIVE_METADATA_RESPONSE_INVALID", "DRIVE_METADATA_SUBREQUEST_LIMIT",
  "DRIVE_CREDENTIAL_UNAVAILABLE", "PROVIDER_METADATA_MISMATCH", "PROVIDER_LIST_UNAVAILABLE",
  "PROVIDER_PATH_AMBIGUOUS", "PROVIDER_PATH_UNREGISTERED", "PROVIDER_DESTINATION_EXISTS",
  "STORAGE_CREDENTIAL_EXPIRING", "STORAGE_CREDENTIAL_OPEN_FAILED", "STORAGE_CREDENTIAL_INVALID",
  "STORAGE_CREDENTIAL_CONTEXT_MISMATCH", "STORAGE_CREDENTIAL_REFRESH_FAILED",
]);

/** Only trusted adapters mark the stage. Never retain or serialize a raw cause.
 * Once a reservation RPC was dispatched, even a denial-looking response needs
 * inspection of its original ticket; the stage cannot clear that uncertainty. */
export function resourceCenterReservationFailure(stage, error) {
  if (!Object.hasOwn(reservationStages, stage)) throw new TypeError("Invalid reservation stage.");
  const message = error?.message;
  const reason = reservationReasons.has(message) ? message :
    Object.hasOwn(reservationRpcReasons, message) ? reservationRpcReasons[message] : reservationStages[stage];
  const diagnostic = Object.freeze({ stage, reason_code: reason,
    reservation_status: unreservedStages.has(stage) ? "not_started" : "unknown" });
  const failure = new Error(reason);
  reservationFailures.set(failure, diagnostic);
  return failure;
}

// Arbitrary exception properties cannot assert that no RPC was dispatched.
export function resourceCenterReservationDiagnostic(error) {
  return error && typeof error === "object" ? reservationFailures.get(error) : undefined;
}

export function sanitizeReservationDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "reason_code,reservation_status,stage" ||
      !Object.hasOwn(reservationStages, value.stage) || !reservationReasons.has(value.reason_code) ||
      value.reservation_status !== (unreservedStages.has(value.stage) ? "not_started" : "unknown")) return null;
  return Object.freeze({ stage: value.stage, reason_code: value.reason_code, reservation_status: value.reservation_status });
}

export function isUnreservedPreparationFailure(result) {
  return result?.status === "deny" && result.error_code === "DURABLE_WRITE_PREPARATION_FAILED" && result.side_effects === 0 &&
    sanitizeReservationDiagnostic(result.reservation_diagnostic)?.reservation_status === "not_started";
}

/** Host-bootstrap-only writer credential and postcondition verifier. Never
 * expose this client's reserve/start/finalize methods as Agent tools. */
export function createResourceCenterWriteClient({
  endpoint, binding_token: bindingToken,
  resolve_provider_identity: resolveProviderIdentity,
  verify_postcondition: verifyPostcondition,
  persist_recovery: persistRecovery,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const url = new URL(endpoint);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
    url.pathname !== "/v1/resource-center/write" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("A fixed HTTPS Resource Center writer endpoint is required.");
  }
  if (typeof bindingToken !== "string" || !/^clued_rcw_[A-Za-z0-9_-]{32,}$/.test(bindingToken) ||
    typeof resolveProviderIdentity !== "function" || typeof verifyPostcondition !== "function" ||
    typeof persistRecovery !== "function") {
    throw new TypeError("A dedicated writer Binding, trusted provider verifiers and durable recovery store are required.");
  }
  async function invoke(request) {
    const nonce = randomUUID();
    const requestHash = hash(request);
    const response = await fetchImpl(url.href, { method: "POST", redirect: "error", cache: "no-store",
      headers: { authorization: `Bearer ${bindingToken}`, "content-type": "application/json", "cache-control": "no-store" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ contract: "clued.resource-center-write/1", nonce, request, request_sha256: requestHash }),
    });
    if (!response.ok) throw new Error("RESOURCE_CENTER_WRITER_UNAVAILABLE");
    const result = await response.json();
    if (result.contract !== "clued.resource-center-write/1" || result.nonce !== nonce ||
      result.request_sha256 !== requestHash || !isDeepStrictEqual(result.request, request)) {
      throw new Error("RESOURCE_CENTER_WRITER_RESPONSE_MISMATCH");
    }
    return result.outcome;
  }
  const reservations = new Map();
  return Object.freeze({
    async prepare_write({ profile, mutation, binding }) {
      if (mutation.operation !== "create") throw new Error("WRITER_OPERATION_NOT_QUALIFIED");
      let provider;
      try { provider = await resolveProviderIdentity({ profile, mutation }); }
      catch (error) { throw resourceCenterReservationFailure("provider_identity", error); }
      const key = randomUUID();
      // Persist correlation before any network side effect, including prepare.
      // Never persist a credential or an execution grant. A recovered ticket is
      // inspection-only; it cannot start/replay an old filesystem operation.
      try { await persistRecovery(Object.freeze({ contract: "clued.resource-center-recovery/1",
        request_key: key, request_sha256: binding.request_sha256,
        profile_id: profile.profile_id, mutation: structuredClone(mutation) })); }
      catch (error) { throw resourceCenterReservationFailure("recovery_ticket", error); }
      let prepared;
      try { prepared = await invoke({ action: "prepare", idempotency_key: `${key}:prepare`, request_key: key,
        request_sha256: binding.request_sha256, exact_request: { mutation, binding },
        authority_request: { contract: "clued.resource-center-authority/1",
          policy_version: RESOURCE_CENTER_POLICY_VERSION, profile_id: profile.profile_id,
          profile_version: profile.profile_version, mutation: bindResourceCenterMutation(mutation), provider_identity: provider },
      }); }
      catch (error) { throw resourceCenterReservationFailure("prepare_rpc", error); }
      if (prepared?.status !== "committed" || prepared.state !== "prepared" ||
        prepared.request_sha256 !== binding.request_sha256 || !prepared.intent_id) {
        throw resourceCenterReservationFailure("prepare_result", new Error("RESOURCE_CENTER_RESERVATION_DENIED"));
      }
      // No retry: an uncertain HTTP start response is resolved by inspection,
      // never by executing a filesystem effect twice.
      let started;
      try { started = await invoke({ action: "start", idempotency_key: `${key}:start`,
        intent_id: prepared.intent_id, base_version: prepared.version, request_sha256: binding.request_sha256 }); }
      catch (error) { throw resourceCenterReservationFailure("start_rpc", error); }
      if (started?.status !== "committed" || started.state !== "started" ||
        started.execution_permitted !== true || started.intent_id !== prepared.intent_id ||
        started.request_sha256 !== binding.request_sha256)
        throw resourceCenterReservationFailure("start_result", new Error("RESOURCE_CENTER_START_DENIED"));
      reservations.set(started.intent_id, { key, profile: structuredClone(profile),
        mutation: structuredClone(mutation), binding: structuredClone(binding), version: started.version, provider });
      return Object.freeze({ status: "started", execution_permitted: true,
        intent_id: started.intent_id, request_sha256: started.request_sha256 });
    },
    async inspect_recovery(ticket) {
      if (ticket?.contract !== "clued.resource-center-recovery/1" ||
        !/^[0-9a-f-]{36}$/i.test(ticket.request_key ?? "") ||
        !/^[0-9a-f]{64}$/.test(ticket.request_sha256 ?? "")) {
        throw new Error("RESOURCE_CENTER_RECOVERY_TICKET_INVALID");
      }
      return invoke({ action: "inspect", request_key: ticket.request_key,
        request_sha256: ticket.request_sha256 });
    },
    async commit_post_write({ mutation, binding, reservation, effect_result: effectResult }) {
      const state = reservations.get(reservation.intent_id);
      if (!state || !isDeepStrictEqual(state.mutation, mutation) || !isDeepStrictEqual(state.binding, binding)) {
        throw new Error("RESOURCE_CENTER_RESERVATION_MISMATCH");
      }
      const postcondition = await verifyPostcondition(Object.freeze({ profile: state.profile,
        mutation, binding, provider_before: state.provider, effect_result: effectResult }));
      const result = await invoke({ action: "finalize", idempotency_key: `${state.key}:finalize`,
        intent_id: reservation.intent_id, base_version: state.version,
        request_sha256: binding.request_sha256, postcondition });
      if (result?.status !== "committed" || result.state !== "committed" ||
        result.intent_id !== reservation.intent_id || result.request_sha256 !== binding.request_sha256 ||
        result.final_result?.status !== "committed") throw new Error("RESOURCE_CENTER_FINALIZATION_FAILED");
      reservations.delete(reservation.intent_id);
      return Object.freeze({ status: "committed", receipt_id: result.receipt_id,
        intent_id: result.intent_id, request_sha256: result.request_sha256 });
    },
  });
}
