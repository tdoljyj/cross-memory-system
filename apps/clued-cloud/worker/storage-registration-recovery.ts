import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveRegistrationRecovery } from "../../../kernel/host/resource-center-google-drive-registration-recovery.mjs";
import { createStorageCredentialVault, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { scopeProfile } from "./storage-google-scopes";

type Data = Record<string, unknown>;
type Reference = { connection_id: string; job_id: string };
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const denied = () => new Error("storage_current_registration_unavailable");

function resolution(value: Data, reference: Reference, intentId: string, base?: Data, observedState?: string): Data & {status: "resolved"} {
  if (value.status !== "resolved" || value.resolution !== "automatically_registered_current_state" ||
      value.automatic_recovery !== "resolved" || value.execution_permitted !== false ||
      value.connection_id !== reference.connection_id || value.job_id !== reference.job_id || value.intent_id !== intentId ||
      !uuid.test(String(value.receipt_id)) || !uuid.test(String(value.source_receipt_id)) || value.receipt_id === value.source_receipt_id ||
      !Number.isSafeInteger(value.base_version) || Number(value.base_version) < 1 ||
      base && (value.base_version !== base.base_version || value.source_receipt_id !== base.source_receipt_id) ||
      value.current_artifact_state !== undefined && (typeof value.current_artifact_state !== "string" || !["active", "trashed"].includes(value.current_artifact_state)) ||
      observedState !== undefined && value.current_artifact_state !== observedState) throw denied();
  return { status: "resolved", resolution: "automatically_registered_current_state", automatic_recovery: "resolved",
    ...reference, intent_id: intentId, receipt_id: value.receipt_id, source_receipt_id: value.source_receipt_id,
    base_version: value.base_version, ...(value.current_artifact_state !== undefined ? { current_artifact_state: value.current_artifact_state } : {}),
    execution_permitted: false };
}

/** A fresh program-owned metadata registration, not the old Agent operation.
 * Both RPCs use the existing authenticated issuer wrapper. This adapter has
 * no Drive writer, effect retry, adopted Agent identity or confirmation flag.
 */
export async function createStorageCurrentRegistrationRecovery(config: {
  client_id: string; vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: Data) => Promise<Data>; fetch?: typeof fetch; clock?: () => number; timeout_ms?: number;
}) {
  const timeout = config.timeout_ms ?? 30000;
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id) || typeof config.rpc !== "function" ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw denied();
  const vault = await createStorageCredentialVault(config.vault), fetcher = createStorageFetch(config.fetch), clock = config.clock ?? Date.now;
  return Object.freeze({ async run(reference: Reference, intentId: string) {
    if (!object(reference) || Object.keys(reference).sort().join(",") !== "connection_id,job_id" ||
        !uuid.test(reference.connection_id) || !uuid.test(reference.job_id) || !uuid.test(intentId)) throw denied();
    const pinned = { ...reference }, controller = new AbortController();
    const expired = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("DRIVE_METADATA_TIMEOUT")), { once: true }));
    void expired.catch(() => {});
    const timer = setTimeout(() => controller.abort(), timeout), bounded = <T>(work: Promise<T>) => Promise.race([work, expired]);
    try {
      const raw = await bounded(config.rpc({ action: "registration_current_load", ...pinned })); controller.signal.throwIfAborted();
      if (!object(raw)) throw denied();
      const d = structuredClone(raw);
      if (d.status === "resolved") return resolution(d, pinned, intentId);
      const actor = d.registration_authority, reader = d.recovery_reader, plan = d.registration_plan;
      if (d.status !== "registration_required" || d.connection_id !== pinned.connection_id || d.job_id !== pinned.job_id || d.intent_id !== intentId ||
          d.execution_permitted !== false || !uuid.test(String(d.owner_id)) || !uuid.test(String(d.source_receipt_id)) ||
          !Number.isSafeInteger(d.base_version) || Number(d.base_version) < 1 || !Number.isSafeInteger(d.credential_version) || Number(d.credential_version) < 1 ||
          !object(actor) || actor.contract !== "clued.storage-registration-program-authority/1" || actor.actor_kind !== "storage_program" ||
          actor.owner_id !== d.owner_id || actor.original_connection_id !== pinned.connection_id || actor.job_id !== pinned.job_id || actor.intent_id !== intentId ||
          actor.provider !== "google-drive" || actor.oauth_client_id !== config.client_id || actor.registration_action !== "modify" ||
          actor.provider_scope_profile !== "full" || !Array.isArray(actor.actions) || !actor.actions.includes("modify") ||
          !uuid.test(String(actor.issuer_id)) || !Number.isSafeInteger(actor.issuer_credential_generation) || Number(actor.issuer_credential_generation) < 1 ||
          typeof actor.provider_subject !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(actor.provider_subject) ||
          !object(reader) || reader.contract !== "clued.storage-recovery-reader/1" || !uuid.test(String(reader.connection_id)) ||
          actor.connection_id !== reader.connection_id || actor.credential_version !== d.credential_version || reader.credential_version !== d.credential_version ||
          !object(plan) || plan.contract !== "clued.storage-registration-plan/1" || !["refresh_directory", "refresh_directory_state", "adopt_create"].includes(String(plan.mode)) || plan.intent_id !== intentId ||
          actor.root_folder_id !== plan.root_folder_id || actor.root_parent_id !== plan.root_parent_id || actor.managed_root !== plan.managed_root) throw denied();
      if (plan.mode === "adopt_create" && (!object(plan.target) || !["file", "directory"].includes(String(plan.target.target_kind)) ||
          !actor.actions.includes(plan.target.target_kind === "directory" ? "create_topic" : "create_file"))) throw denied();
      const secret: unknown = JSON.parse(await bounded(vault.open(d.credential_envelope as StorageCredentialEnvelope, {
        owner_id: String(d.owner_id), connection_id: String(reader.connection_id), provider: "google-drive", provider_subject: actor.provider_subject,
        oauth_client_id: config.client_id, credential_version: Number(d.credential_version),
      })));
      const credential = async () => {
        controller.signal.throwIfAborted();
        if (!object(secret) || secret.token_type !== "Bearer" || typeof secret.access_token !== "string" || secret.access_token.length < 16 ||
            scopeProfile(secret.scope) !== "full" || !Number.isFinite(secret.expires_at_ms) || !Number.isFinite(clock())) throw denied();
        if (Number(secret.expires_at_ms) - clock() < Math.max(60000, timeout + 1000)) throw new Error("storage_recovery_credential_expiring");
        return { access_token: secret.access_token, scope: secret.scope };
      };
      await credential(); // DB full label is insufficient; check actual sealed grant before any GET.
      const metadata = createGoogleDriveMetadataApi({ registration_details: true, get_credential: credential, transient_retries: 2,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          controller.signal.throwIfAborted();
          const url = new URL(String(input));
          if (init?.method !== "GET" || init.body != null || url.origin !== "https://www.googleapis.com" || url.username || url.password || url.hash ||
              !/^\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+(?:\/permissions)?)?$/.test(url.pathname) ||
              [...url.searchParams.keys()].some(key => !["fields", "supportsAllDrives", "includeItemsFromAllDrives", "includePermissionsForView", "q", "pageSize", "pageToken"].includes(key)) ||
              url.searchParams.has("includePermissionsForView") && url.searchParams.get("includePermissionsForView") !== "published") throw denied();
          return bounded(fetcher(input, { ...init, signal: AbortSignal.any([controller.signal, ...(init.signal ? [init.signal] : [])]) }));
        } });
      const observations = await bounded(createGoogleDriveRegistrationRecovery({ metadata, clock }).observe(plan, { signal: controller.signal }));
      controller.signal.throwIfAborted();
      const settled = await bounded(config.rpc({ action: "registration_current_commit", ...pinned,
        base_version: d.base_version, source_receipt_id: d.source_receipt_id, registration_authority: actor, registration_plan: plan, ...observations }));
      controller.signal.throwIfAborted();
      return resolution(settled, pinned, intentId, d, observations.second_observation.target.current_state);
    } finally { clearTimeout(timer); controller.abort(); }
  } });
}
