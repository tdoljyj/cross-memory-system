import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { RESOURCE_CENTER_POLICY_VERSION, bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const CONTRACT = "clued.resource-center-authority/1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function endpointUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new TypeError("The authority endpoint must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/v1/resource-center/authority") {
    throw new TypeError("The authority endpoint must be the fixed Resource Center route.");
  }
  return url.href;
}

/**
 * Host-bootstrap-only client. The Binding token and registered profile are
 * captured in this closure; neither is accepted from a mutation tool call.
 * A service response is usable only for the exact request just sent.
 */
export function createResourceCenterAuthorityClient({
  endpoint,
  binding_token: bindingToken,
  resolve_provider_identity: resolveProviderIdentity,
  fetch: fetchImpl = globalThis.fetch,
  timeout_ms: timeoutMs = 5000,
} = {}) {
  const url = endpointUrl(endpoint);
  if (typeof bindingToken !== "string" || !/^clued_rcb_[A-Za-z0-9_-]{32,}$/.test(bindingToken)) {
    throw new TypeError("A dedicated Resource Center resolver Binding is required.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required.");
  if (typeof resolveProviderIdentity !== "function") {
    throw new TypeError("A Host-owned provider identity resolver is required.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError("timeout_ms must be 1..10000.");
  }

  return async function resolveArtifactOnline({ profile, mutation }) {
    const providerIdentity = await resolveProviderIdentity(Object.freeze({ profile, mutation }));
    if (!providerIdentity || typeof providerIdentity !== "object" || Array.isArray(providerIdentity) ||
      (typeof providerIdentity.source_file_id !== "string" && providerIdentity.source_file_id !== null) ||
      (typeof providerIdentity.source_file_version !== "string" && providerIdentity.source_file_version !== null) ||
      (typeof providerIdentity.destination_parent_id !== "string" && providerIdentity.destination_parent_id !== null) ||
      (typeof providerIdentity.destination_parent_version !== "string" && providerIdentity.destination_parent_version !== null) ||
      (typeof providerIdentity.destination_file_id !== "string" && providerIdentity.destination_file_id !== null) ||
      (typeof providerIdentity.destination_file_version !== "string" && providerIdentity.destination_file_version !== null) ||
      (mutation.operation === "delete" && !providerIdentity.source_file_id) ||
      (["move", "rename"].includes(mutation.operation) &&
        (!providerIdentity.source_file_id || !providerIdentity.destination_parent_id)) ||
      (["create", "write", "replace"].includes(mutation.operation) && !providerIdentity.destination_parent_id) ||
      (["write", "replace"].includes(mutation.operation) && !providerIdentity.destination_file_id) ||
      (["create", "move", "rename"].includes(mutation.operation) && providerIdentity.destination_file_id !== null) ||
      (providerIdentity.source_file_id !== null && !/^\d+$/.test(providerIdentity.source_file_version)) ||
      (providerIdentity.source_file_id === null && providerIdentity.source_file_version !== null) ||
      (providerIdentity.destination_parent_id !== null && !/^\d+$/.test(providerIdentity.destination_parent_version)) ||
      (providerIdentity.destination_parent_id === null && providerIdentity.destination_parent_version !== null) ||
      (providerIdentity.destination_file_id !== null && !/^\d+$/.test(providerIdentity.destination_file_version)) ||
      (providerIdentity.destination_file_id === null && providerIdentity.destination_file_version !== null) ||
      typeof providerIdentity.root_folder_version !== "string" || !/^\d+$/.test(providerIdentity.root_folder_version) ||
      typeof providerIdentity.root_parent_id !== "string" || !providerIdentity.root_parent_id ||
      typeof providerIdentity.provider_version !== "string" || !/^[0-9a-f]{64}$/.test(providerIdentity.provider_version) ||
      typeof providerIdentity.root_folder_id !== "string" || !providerIdentity.root_folder_id) {
      throw new Error("PROVIDER_IDENTITY_UNAVAILABLE");
    }
    const request = Object.freeze({
      contract: CONTRACT,
      nonce: randomUUID(),
      policy_version: RESOURCE_CENTER_POLICY_VERSION,
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      provider_identity: Object.freeze({
        root_folder_id: providerIdentity.root_folder_id,
        root_parent_id: providerIdentity.root_parent_id,
        root_folder_version: providerIdentity.root_folder_version,
        source_file_id: providerIdentity.source_file_id,
        source_file_version: providerIdentity.source_file_version,
        destination_parent_id: providerIdentity.destination_parent_id,
        destination_parent_version: providerIdentity.destination_parent_version,
        destination_file_id: providerIdentity.destination_file_id,
        destination_file_version: providerIdentity.destination_file_version,
        provider_version: providerIdentity.provider_version,
      }),
      mutation: bindResourceCenterMutation(mutation),
    });
    const requestSha256 = sha256(JSON.stringify(request));
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bindingToken}`,
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ request, request_sha256: requestSha256 }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error("ARTIFACT_AUTHORITY_SERVICE_DENIED");
    const result = await response.json();
    if (result?.contract !== CONTRACT || result?.status !== "resolved" ||
      result?.request_sha256 !== requestSha256 ||
      !isDeepStrictEqual(result?.request, request) ||
      !result?.authority || typeof result.authority !== "object" || Array.isArray(result.authority) ||
      typeof result.authority.workspace_version !== "string" || !result.authority.workspace_version) {
      throw new Error("ARTIFACT_AUTHORITY_RESPONSE_MISMATCH");
    }
    // The in-process admission must drift when Drive identity drifts, even if
    // the Canonical authority version happens to remain unchanged.
    return Object.freeze({
      ...result.authority,
      workspace_version: `provider+canonical:${sha256(JSON.stringify([
        result.authority.workspace_version, request.provider_identity,
      ]))}`,
    });
  };
}
