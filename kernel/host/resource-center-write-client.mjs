import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation, RESOURCE_CENTER_POLICY_VERSION } from "../policy/resource-center-mutation-policy.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Host-bootstrap-only writer credential and postcondition verifier. Never
 * expose this client's reserve/start/finalize methods as Agent tools. */
export function createResourceCenterWriteClient({
  endpoint, binding_token: bindingToken,
  resolve_provider_identity: resolveProviderIdentity,
  verify_postcondition: verifyPostcondition,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const url = new URL(endpoint);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
    url.pathname !== "/v1/resource-center/write" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("A fixed HTTPS Resource Center writer endpoint is required.");
  }
  if (typeof bindingToken !== "string" || !/^clued_rcw_[A-Za-z0-9_-]{32,}$/.test(bindingToken) ||
    typeof resolveProviderIdentity !== "function" || typeof verifyPostcondition !== "function") {
    throw new TypeError("A dedicated writer Binding and trusted provider verifiers are required.");
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
      const provider = await resolveProviderIdentity({ profile, mutation });
      const key = randomUUID();
      const prepared = await invoke({ action: "prepare", idempotency_key: `${key}:prepare`, request_key: key,
        request_sha256: binding.request_sha256, exact_request: { mutation, binding },
        authority_request: { contract: "clued.resource-center-authority/1",
          policy_version: RESOURCE_CENTER_POLICY_VERSION, profile_id: profile.profile_id,
          profile_version: profile.profile_version, mutation: bindResourceCenterMutation(mutation), provider_identity: provider },
      });
      if (prepared?.status !== "committed" || prepared.state !== "prepared" ||
        prepared.request_sha256 !== binding.request_sha256 || !prepared.intent_id) {
        throw new Error("RESOURCE_CENTER_RESERVATION_DENIED");
      }
      // No retry: an uncertain HTTP start response is resolved by inspection,
      // never by executing a filesystem effect twice.
      const started = await invoke({ action: "start", idempotency_key: `${key}:start`,
        intent_id: prepared.intent_id, base_version: prepared.version, request_sha256: binding.request_sha256 });
      if (started?.status !== "committed" || started.state !== "started" ||
        started.execution_permitted !== true || started.intent_id !== prepared.intent_id ||
        started.request_sha256 !== binding.request_sha256) throw new Error("RESOURCE_CENTER_START_DENIED");
      reservations.set(started.intent_id, { key, profile: structuredClone(profile),
        mutation: structuredClone(mutation), binding: structuredClone(binding), version: started.version, provider });
      return Object.freeze({ status: "started", execution_permitted: true,
        intent_id: started.intent_id, request_sha256: started.request_sha256 });
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
