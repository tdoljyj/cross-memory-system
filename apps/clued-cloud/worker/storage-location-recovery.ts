import { isDeepStrictEqual } from "node:util";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveLocationRecovery } from "../../../kernel/host/resource-center-google-drive-location-recovery.mjs";
import { createStorageCredentialVault, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { scopeProfile } from "./storage-google-scopes";

type Data = Record<string, unknown>;
type Reference = {connection_id:string;job_id:string};
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const unavailable = () => new Error("storage_current_location_unavailable");
function pending(value:Data, reference:Reference, intent:string) {
  if (value.status !== "pending") return null;
  if (Object.keys(value).sort().join(",") !== "automatic_recovery,connection_id,contract,execution_permitted,job_id,reason_code,status" ||
      value.contract !== "clued.storage-current-location-busy/1" || value.connection_id !== reference.connection_id ||
      value.job_id !== reference.job_id || value.automatic_recovery !== "pending" ||
      value.reason_code !== "REGISTRATION_LOCATION_BUSY" || value.execution_permitted !== false) throw unavailable();
  // The durable original job remains due under Native backoff. This private
  // protocol is mapped to the existing Owner/scheduler response, not a failure
  // Receipt, a provider dispatch or a new job reference.
  return {status:"inspection_required",automatic_recovery:"pending",...reference,intent_id:intent,execution_permitted:false};
}
const result = (value: Data, reference: Reference, intent: string, base?: Data) => {
  if (value.status !== "resolved" || value.resolution !== "automatically_registered_current_state" ||
      value.automatic_recovery !== "resolved" || value.execution_permitted !== false ||
      value.connection_id !== reference.connection_id || value.job_id !== reference.job_id || value.intent_id !== intent ||
      !uuid(value.receipt_id) || !uuid(value.source_receipt_id) || value.receipt_id === value.source_receipt_id ||
      !Number.isSafeInteger(value.base_version) || Number(value.base_version) < 1 || value.current_artifact_state !== "active" ||
      typeof value.current_path !== "string" || value.current_path.length < 2 || value.current_path.length > 1000 ||
      value.current_path.endsWith("/") || /[\\\p{Cc}]/u.test(value.current_path) ||
      value.current_path.split("/").some(part=>part==="."||part==="..") ||
      base && (value.base_version !== base.base_version || value.source_receipt_id !== base.source_receipt_id ||
        !object(base.registration_plan) || !object(base.registration_plan.target) ||
        value.current_path !== base.registration_plan.target.path)) throw unavailable();
  return {status:"resolved",resolution:"automatically_registered_current_state",automatic_recovery:"resolved",
    ...reference,intent_id:intent,receipt_id:value.receipt_id,source_receipt_id:value.source_receipt_id,
    base_version:value.base_version,current_artifact_state:"active",current_path:value.current_path,execution_permitted:false};
};

/** Current-location registration has no provider writer. Discovery is a hint;
 * the private Native plan and atomic commit independently authorize the same
 * original identity. No old effect or Agent permission is restored. */
export async function createStorageCurrentLocationRecovery(config: {
  client_id:string;vault:Parameters<typeof createStorageCredentialVault>[0];
  rpc:(input:Data)=>Promise<Data>;fetch?:typeof fetch;clock?:()=>number;timeout_ms?:number;
}) {
  const timeout = config.timeout_ms ?? 30000, clock = config.clock ?? Date.now;
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id) || typeof config.rpc !== "function" ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw unavailable();
  const vault = await createStorageCredentialVault(config.vault), fetcher = createStorageFetch(config.fetch);
  return Object.freeze({async run(reference:Reference, intent:string) {
    if (!object(reference) || Object.keys(reference).sort().join(",") !== "connection_id,job_id" ||
        !uuid(reference.connection_id) || !uuid(reference.job_id) || !uuid(intent)) throw unavailable();
    const pinned = {...reference}, controller = new AbortController();
    const expired = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(unavailable()), {once:true}));
    void expired.catch(() => {});
    const timer = setTimeout(() => controller.abort(), timeout);
    const bounded = <T>(work:Promise<T>) => Promise.race([work,expired]);
    try {
      const loaded = await bounded(config.rpc({...pinned,action:"registration_location_load"}));
      controller.signal.throwIfAborted();
      if (!object(loaded)) throw unavailable();
      const loadPending=pending(loaded,pinned,intent);if(loadPending)return loadPending;
      if (loaded.status === "resolved") return result(loaded,pinned,intent);
      const d = structuredClone(loaded), actor = d.registration_authority, reader = d.recovery_reader, seed = d.registration_seed;
      if (d.status !== "registration_location_required" || d.connection_id !== pinned.connection_id ||
          d.job_id !== pinned.job_id || d.intent_id !== intent || !uuid(d.owner_id) || !uuid(d.source_receipt_id) ||
          d.execution_permitted !== false || !Number.isSafeInteger(d.base_version) || Number(d.base_version) < 1 ||
          !Number.isSafeInteger(d.credential_version) || Number(d.credential_version) < 1 ||
          !object(actor) || actor.contract !== "clued.storage-registration-program-authority/1" ||
          actor.actor_kind !== "storage_program" || actor.owner_id !== d.owner_id ||
          actor.original_connection_id !== pinned.connection_id || actor.job_id !== pinned.job_id || actor.intent_id !== intent ||
          actor.provider !== "google-drive" || actor.oauth_client_id !== config.client_id || actor.registration_action !== "modify" ||
          actor.provider_scope_profile !== "full" || !Array.isArray(actor.actions) || !actor.actions.includes("modify") ||
          !uuid(actor.issuer_id) || !Number.isSafeInteger(actor.issuer_credential_generation) ||
          Number(actor.issuer_credential_generation) < 1 || typeof actor.provider_subject !== "string" ||
          !/^[A-Za-z0-9_-]{1,255}$/.test(actor.provider_subject) ||
          !object(reader) || reader.contract !== "clued.storage-recovery-reader/1" || !uuid(reader.connection_id) ||
          actor.connection_id !== reader.connection_id || actor.credential_version !== d.credential_version ||
          reader.credential_version !== d.credential_version || !object(seed) ||
          seed.contract !== "clued.storage-directory-location-seed/1" || seed.intent_id !== intent ||
          seed.root_folder_id !== actor.root_folder_id || seed.root_parent_id !== actor.root_parent_id ||
          seed.managed_root !== actor.managed_root || !object(seed.target)) throw unavailable();
      const secret:unknown = JSON.parse(await bounded(vault.open(d.credential_envelope as StorageCredentialEnvelope,{
        owner_id:String(d.owner_id),connection_id:reader.connection_id,provider:"google-drive",
        provider_subject:actor.provider_subject,oauth_client_id:config.client_id,credential_version:Number(d.credential_version)})));
      const credential = async () => {
        controller.signal.throwIfAborted();
        if (!object(secret) || secret.token_type !== "Bearer" || typeof secret.access_token !== "string" ||
            secret.access_token.length < 16 || scopeProfile(secret.scope) !== "full" ||
            !Number.isFinite(secret.expires_at_ms) || !Number.isFinite(clock()) ||
            Number(secret.expires_at_ms)-clock() < Math.max(60000,timeout+1000)) throw unavailable();
        return {access_token:secret.access_token,scope:secret.scope};
      };
      await credential();
      const metadata = createGoogleDriveMetadataApi({registration_details:true,get_credential:credential,transient_retries:2,
        fetch:async (input:RequestInfo|URL,init?:RequestInit) => {
          controller.signal.throwIfAborted();const url = new URL(String(input));
          if (init?.method !== "GET" || init.body != null || url.origin !== "https://www.googleapis.com" ||
              url.username || url.password || url.hash ||
              !/^\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+(?:\/permissions)?)?$/.test(url.pathname) ||
              [...url.searchParams.keys()].some(key =>
                !["fields","supportsAllDrives","includeItemsFromAllDrives","includePermissionsForView","q","pageSize","pageToken"].includes(key)) ||
              url.searchParams.has("includePermissionsForView") && url.searchParams.get("includePermissionsForView") !== "published")
            throw unavailable();
          return bounded(fetcher(input,{...init,signal:AbortSignal.any([controller.signal,...(init.signal?[init.signal]:[])])}));
        }});
      const observer = createGoogleDriveLocationRecovery({metadata,clock});
      const hint = await bounded(observer.discover(seed,{signal:controller.signal}));
      const planned = await bounded(config.rpc({...pinned,action:"registration_location_plan",base_version:d.base_version,
        source_receipt_id:d.source_receipt_id,registration_authority:actor,registration_seed:seed,location_hint:hint}));
      controller.signal.throwIfAborted();
      if (!object(planned)) throw unavailable();
      const planPending=pending(planned,pinned,intent);if(planPending)return planPending;
      if (planned.status === "resolved") return result(planned,pinned,intent);
      const plan = planned.registration_plan;
      if (planned.status !== "registration_required" || planned.execution_permitted !== false ||
          planned.connection_id !== pinned.connection_id || planned.job_id !== pinned.job_id || planned.intent_id !== intent ||
          planned.base_version !== d.base_version || planned.source_receipt_id !== d.source_receipt_id ||
          !isDeepStrictEqual(planned.registration_authority,actor) || !object(plan) ||
          plan.intent_id !== intent || plan.request_sha256 !== seed.request_sha256 ||
          plan.managed_root !== seed.managed_root || plan.root_folder_id !== seed.root_folder_id || plan.root_parent_id !== seed.root_parent_id ||
          !object(plan.target) || !Array.isArray(plan.parents) || plan.parents.length < 2 || !object(plan.parents[1]) ||
          !object(actor.runtime) || !Array.isArray(actor.runtime.allowed_root_children) ||
          !actor.runtime.allowed_root_children.some(track => typeof track === "string" &&
            plan.parents instanceof Array && object(plan.parents[1]) && plan.parents[1].path === String(plan.managed_root)+"/"+track) ||
          !isDeepStrictEqual(plan.target,{...seed.target,path:plan.target.path,parent_id:plan.target.parent_id,
            registered_path:seed.target.path,registered_parent_id:seed.target.parent_id})) throw unavailable();
      const observations = await bounded(observer.observe(plan,{signal:controller.signal}));
      controller.signal.throwIfAborted();
      const settled = await bounded(config.rpc({...pinned,action:"registration_location_commit",base_version:d.base_version,
        source_receipt_id:d.source_receipt_id,registration_authority:actor,registration_plan:plan,...observations}));
      controller.signal.throwIfAborted();
      const commitPending=pending(settled,pinned,intent);if(commitPending)return commitPending;
      return result(settled,pinned,intent,planned);
    } finally {clearTimeout(timer);controller.abort();}
  }});
}
