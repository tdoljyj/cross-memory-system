import { cloudDispatchOutcome, createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import type { StorageDemandResult } from "./storage-demand-refresh";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-postcondition.mjs";
import { createStorageFetch } from "./storage-fetch";
import { createStorageGoogleMetadataBatch } from "./storage-google-metadata-batch";
import { scopeProfile } from "./storage-google-scopes";
import { createRegistrationRecoveryRpc } from "./registration-recovery";

type Data = Record<string, unknown>;
type Reference = {connection_id: string; job_id: string};
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const denied = () => new Error("storage_cloud_unavailable");

/** Private server bridge. The fixed RPC authenticates the issuer and derives
 * owner/profile/writer from Canonical job state. No raw result is an API reply.
 * Envelope decryption stays here; the native effect receives access_token only.
 */
export async function createStorageCloudWorker(config: {
  client_id: string; vault: Parameters<typeof createStorageCredentialVault>[0];
  rpc: (input: Data) => Promise<Data>; fetch?: typeof fetch; clock?: () => number;
  recovery_refresh?: (reference: Reference) => Promise<{status:string}>;
  credential_preflight?: (reference: Reference) => Promise<StorageDemandResult>;
  account_policy_v2?: boolean;
  // Binary create (StorageNormalUse N3), absent = binary jobs refused. Opens a binary job's staged object as a bounded-memory source (verify + stream), never the whole bytes.
  load_staged_content?: (input: Data) => Promise<{ size: number; sha256: string; readonly verified: boolean; verify(): Promise<void>; stream(): ReadableStream<Uint8Array> }>;
}) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id)) throw denied();
  const vault = await createStorageCredentialVault(config.vault);
  const fetcher = createStorageFetch(config.fetch);
  return Object.freeze({ async run(reference: Reference) {
    let loaded: Data | null = null;
    let recoveryMode=false, refreshed=false;
    let registrationRecovery: Data | null = null;
    // Each rejection below carries a fixed label so post-write diagnostics can name
    // the credential step. Outcomes are unchanged: every branch still fails closed.
    const reject = (code: string) => new Error(code);
    const credential = async (expected: Omit<StorageCredentialContext,"provider"|"oauth_client_id">): Promise<Data> => {
      if (!loaded || expected.owner_id !== loaded.owner_id || expected.connection_id !== loaded.connection_id ||
          expected.provider_subject !== loaded.provider_subject || expected.credential_version !== loaded.credential_version)
        throw reject("STORAGE_CREDENTIAL_CONTEXT_MISMATCH");
      const context: StorageCredentialContext = {...expected,provider:"google-drive",oauth_client_id:config.client_id};
      let token: unknown;
      try { token = JSON.parse(await vault.open(loaded.credential_envelope as StorageCredentialEnvelope,context)); }
      catch { throw reject("STORAGE_CREDENTIAL_OPEN_FAILED"); }
      if (!object(token) || token.token_type !== "Bearer" || typeof token.access_token !== "string" || token.access_token.length<16 ||
        scopeProfile(token.scope)===null ||
        !Number.isFinite(token.expires_at_ms)) throw reject("STORAGE_CREDENTIAL_INVALID");
      if (Number(token.expires_at_ms)-(config.clock??Date.now)()<=60000) {
        if (!recoveryMode || refreshed || !config.recovery_refresh) throw reject("STORAGE_CREDENTIAL_EXPIRING");
        refreshed=true;
        let fresh: Data;
        try {
          if ((await config.recovery_refresh(reference)).status!=="committed") throw denied();
          fresh=await config.rpc({...reference,action:"recovery_load"});
        } catch { throw reject("STORAGE_CREDENTIAL_REFRESH_FAILED"); }
        if (fresh.status!=="recovery_only" || fresh.owner_id!==loaded.owner_id || fresh.connection_id!==loaded.connection_id ||
          fresh.job_id!==loaded.job_id || fresh.provider_subject!==loaded.provider_subject || fresh.oauth_client_id!==config.client_id ||
          fresh.intent_id!==loaded.intent_id || fresh.request_sha256!==loaded.request_sha256 ||
          Number(fresh.credential_version)!==expected.credential_version+1) throw reject("STORAGE_CREDENTIAL_REFRESH_FAILED");
        loaded=fresh;
        return credential({...expected,credential_version:Number(fresh.credential_version)});
      }
      return {...expected,access_token:token.access_token,scope:token.scope,expires_at_ms:token.expires_at_ms};
    };
    const executionRpc = config.account_policy_v2 === true ? createRegistrationRecoveryRpc({
      rpc: config.rpc, descriptor: () => loaded, clock: config.clock,
      on_recovery: result => { registrationRecovery = result; },
      get_file: async id => {
        if (!loaded) throw denied();
        const descriptor = loaded;
        const metadata = createGoogleDriveMetadataApi({
          get_credential: () => credential({owner_id:String(descriptor.owner_id),connection_id:String(descriptor.connection_id),
            provider_subject:String(descriptor.provider_subject),credential_version:Number(descriptor.credential_version)}),
          fetch: async (url, init) => {
            if (init?.method !== "GET") throw denied();
            return fetcher(url, init);
          },
        });
        return await metadata.getFile(id);
      },
    }) : config.rpc;
    const executor = createResourceCenterCloudExecutor({
      clock: config.clock ?? Date.now, drive_fetch: fetcher,
      // The boundary scan reads a whole folder level per request, so one run
      // stays within the Worker's per-invocation subrequest budget.
      metadata_batch: ({ access_token }: { access_token: string }) =>
        createStorageGoogleMetadataBatch({ access_token, fetch: config.fetch, signal: AbortSignal.timeout(60000) }),
      verified_result_mode: config.account_policy_v2 === true,
      ...(config.account_policy_v2 === true ? { semantic_recovery_client_id: config.client_id } : {}),
      ...(config.load_staged_content ? { load_staged_content: config.load_staged_content } : {}),
      load_job: async (ref: Reference) => {
        if (config.credential_preflight && (await config.credential_preflight(ref)).status !== "ready")
          throw reject("STORAGE_CREDENTIAL_REFRESH_PENDING");
        // BUG-20261008-001: a refused load leaves the job queued (the scheduled sweep
        // dispatches it again); name the fixed cause in the diagnostic instead of UNSPECIFIED.
        let result: Data;
        try { result = await config.rpc({...ref, action:"load"}); }
        catch (error) {
          throw reject(error instanceof Error && error.message === "storage_object_under_review" ? "STORAGE_OBJECT_UNDER_REVIEW"
            : error instanceof Error && error.message === "storage_root_has_unresolved_mutation"
            ? "STORAGE_ROOT_BUSY" : "STORAGE_JOB_LOAD_REFUSED");
        }
        // The database can settle an already queued overlap before issuing a
        // writer. Preserve that terminal cause without reporting a second result.
        if (result.contract === "clued.storage-job-execution/1" && result.status === "denied" &&
            result.reason_code === "STORAGE_OBJECT_UNDER_REVIEW" && result.execution_permitted === false &&
            result.connection_id === ref.connection_id && result.job_id === ref.job_id && result.intent_id === null &&
            typeof result.receipt_id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.receipt_id) &&
            typeof result.request_digest === "string" && /^[0-9a-f]{64}$/.test(result.request_digest))
          throw reject("STORAGE_OBJECT_UNDER_REVIEW");
        if (result.status === "queued" && result.oauth_client_id !== config.client_id) throw denied();
        loaded = result;
        const descriptor = {...result}; delete descriptor.credential_envelope; delete descriptor.oauth_client_id;
        return descriptor;
      },
      get_credential: credential,
      rpc: async (input: Data) => {
        if (!loaded || input.connection_id !== loaded.connection_id || input.job_id !== loaded.job_id) throw denied();
        const {connection_id, job_id, action, ...body} = input;
        try {
          return await executionRpc({connection_id, job_id, action,
            ...(action==="settle_verified" ? {} : {credential_version:loaded.credential_version}),
            ...(action==="finalize" ? {finish:{action,...body}} : body)});
        } catch (error) {
          if (error instanceof Error && error.message === "storage_object_under_review") throw reject("STORAGE_OBJECT_UNDER_REVIEW");
          throw error;
        }
      },
    });
    try {
      if (config.account_policy_v2 === true) {
        // Read the original journal before any provider access. A recorded proof
        // is settled from Canonical state only, even after a Worker restart.
        try {
          const prior=await config.rpc({...reference,action:"verified_inspect"});
          if (prior.status==="verified") {
            if (prior.job_id!==reference.job_id || prior.connection_id!==reference.connection_id ||
              typeof prior.verified_receipt_id!=="string" || typeof prior.verified_digest!=="string") throw denied();
            const settled=await config.rpc({...reference,action:"settle_verified"});
            if (settled.status!=="committed" || settled.state!=="committed" ||
              !object(settled.final_result) || settled.final_result.status!=="committed" || typeof settled.receipt_id!=="string" ||
              settled.execution_permitted!==false) throw denied();
            return {status:"committed",job_id:reference.job_id,receipt_id:settled.receipt_id,execution_permitted:false};
          }
          if (prior.status==="committed") {
            if (prior.job_id!==reference.job_id || prior.connection_id!==reference.connection_id ||
              typeof prior.receipt_id!=="string" || prior.execution_permitted!==false) throw denied();
            return {status:"committed",job_id:reference.job_id,receipt_id:prior.receipt_id,execution_permitted:false};
          }
          if (prior.status!=="none" || prior.job_id!==reference.job_id || prior.connection_id!==reference.connection_id ||
              prior.execution_permitted!==false) throw denied();
        } catch { return {status:"inspection_required",execution_permitted:false}; }
      }
      // Fixed server identity may settle a previously authorized effect even if
      // the submitting client is revoked. It never needs a successful new load.
      let recovery: Data | null=null;
      if (config.account_policy_v2 !== true) {
        try { recovery=await config.rpc({...reference,action:"recovery_load"}); } catch { /* No recoverable effect; normal load remains fully gated. */ }
      }
      if (recovery?.status==="recovery_only") {
        try {
          if (typeof recovery.owner_id!=="string" || recovery.connection_id!==reference.connection_id || recovery.job_id!==reference.job_id || recovery.oauth_client_id!==config.client_id ||
            recovery.provider!=="google-drive" || !object(recovery.profile) || !object(recovery.mutation) || !object(recovery.attempt)) throw denied();
          loaded=recovery; recoveryMode=true;
          const recoveryDescriptor=recovery;
          const metadata=createGoogleDriveMetadataApi({get_credential:()=>credential({owner_id:String(recovery.owner_id),connection_id:reference.connection_id,
            provider_subject:String(recoveryDescriptor.provider_subject),credential_version:Number((loaded as Data).credential_version)}),
            fetch:async (url,init) => {
              if (init?.method!=="GET") throw denied();
              return fetcher(url,init);
            }});
          const verify=createGoogleDriveCreatePostconditionVerifier({managed_root:String(recovery.profile.managed_root),
            root_folder_id:String(recovery.root_folder_id),root_parent_id:String(recovery.root_parent_id),get_file:metadata.getFile,list_children:metadata.listChildren,
            require_effect_provider_id:true,timeout_ms:10000,poll_ms:1000,clock:config.clock??Date.now});
          const postcondition=await verify({profile:recovery.profile,mutation:recovery.mutation,provider_before:recovery.provider_before,
            effect_result:{operation:"create",destination_path:recovery.mutation.destination_path,provider_file_id:recovery.attempt.provider_file_id}});
          const done=await config.rpc({...reference,action:"recovery_finalize",credential_version:(loaded as Data).credential_version,
            finish:{intent_id:recovery.intent_id,base_version:recovery.version,request_sha256:recovery.request_sha256,postcondition}});
          if (done.status!=="committed" || done.state!=="committed" || done.intent_id!==recovery.intent_id ||
            typeof done.receipt_id!=="string" || done.execution_permitted!==false) throw denied();
          return {status:"committed",job_id:reference.job_id,receipt_id:done.receipt_id,execution_permitted:false};
        } catch { return {status:"inspection_required",execution_permitted:false}; }
      }
      const result=await executor.run(reference);
      if (registrationRecovery) {
        // Only the qualified, pre-intent registration helper sets this value.
        // Its sidecar/lease is durable; an RPC outage leaves the original job
        // queued for the existing bounded sweep. Never report this as denied.
        return {status: "registration_recovery", job_id: reference.job_id,
          registration_recovery: registrationRecovery, execution_permitted: false};
      }
      if (loaded && ["deny","unavailable","unreconciled"].includes(result.status)) {
        // Account-policy mode stores the fixed reason (and, for a boundary denial, the
        // scan's finding paths) in the Owner's private job row. It is never logged. A
        // server that predates the reason, or refuses its shape, still gets the plain outcome.
        const report=(outcome: Data) => config.rpc({...reference,action:"report",
          credential_version:(loaded as Data).credential_version,outcome});
        const outcome=cloudDispatchOutcome(result) as Data;
        const plain={status:outcome.status};
        try {
          if (config.account_policy_v2 === true && "reason" in outcome) {
            try { await report(outcome); } catch { await report(plain); }
          } else await report(plain);
        }
        catch { /* Never redispatch. Original Canonical journal remains authoritative. */ }
      }
      return result;
    }
    finally { loaded = null; }
  }});
}
