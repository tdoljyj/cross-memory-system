import { cloudDispatchOutcome, createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import type { StorageDemandResult } from "./storage-demand-refresh";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-postcondition.mjs";
import { createStorageFetch } from "./storage-fetch";
import { createStorageGoogleMetadataBatch } from "./storage-google-metadata-batch";
import { scopeProfile } from "./storage-google-scopes";
import { createRegistrationRecoveryRpc } from "./registration-recovery";
import { isDeepStrictEqual } from "node:util";
import { sanitizeReservationDiagnostic } from "../../../kernel/host/resource-center-write-client.mjs";

type Data = Record<string, unknown>;
type Reference = {connection_id: string; job_id: string};
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const denied = () => new Error("storage_cloud_unavailable");
// Only the trusted PostgREST adapter supplies these Error/status/details
// triples. A lost HTTP response, an AbortError or an arbitrary exception is
// not evidence that the original transaction rolled back.
const rolledBackAdmission = (error: unknown) => {
  if (!(error instanceof Error) || !object(error) || error.status !== 500 || !object(error.details)) return false;
  const code = error.details.code;
  return code === "57014" && error.message === "canceling statement due to statement timeout" ||
    code === "55P03" && error.message === "canceling statement due to lock timeout" ||
    code === "40P01" && error.message === "deadlock detected";
};
const authorityCancellationCause = (error: unknown) => !rolledBackAdmission(error) ? null
  : (error as Error & {details: Data}).details.code === "57014" ? "AUTHORITY_STATEMENT_TIMEOUT"
  : (error as Error & {details: Data}).details.code === "55P03" ? "AUTHORITY_LOCK_TIMEOUT" : "AUTHORITY_DEADLOCK";
const sameQueuedDescriptor = (current: Data, previous: Data) =>
  object(current) && current.contract === "clued.storage-job-execution/1" && current.status === "queued" &&
  current.intent_id == null && current.attempt == null && current.dispatch_outcome == null &&
  ["owner_id","connection_id","job_id","request_digest","provider","provider_subject","credential_version",
    "oauth_client_id","mutation","profile","root_folder_id","root_parent_id","ancestor_match","scan_roots",
    "registered_sibling_roots","staging","revision_releases","restore","untrash_source","subtree_sample",
    "registration_recovery"].every(key => isDeepStrictEqual(current[key],previous[key]));
const currentAdmissionRefusal = (error: unknown) => error instanceof Error && object(error) &&
  object(error.details) && [400,403,404,409].includes(Number(error.status)) &&
  ["42501","22023","P0002","40001"].includes(String(error.details.code));
const originalStatus = (value: unknown, reference: Reference, digest: unknown): Data | null =>
  object(value) && value.job_id === reference.job_id && value.connection_id === reference.connection_id &&
    value.request_digest === digest && value.execution_permitted === false ? value : null;
const originalReceiptId = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const inspectOriginal = (reference: Reference, value?: Data | null) => {
  // Only callers that checked originalStatus may supply a value. Project a
  // known result from its real Receipt, never its private raw payload or an
  // execution permit. A concurrent terminal settlement needs no more review.
  if (value && originalReceiptId(value.receipt_id)) {
    if (value.status === "committed" && originalReceiptId(value.intent_id))
      return {status:"committed",job_id:reference.job_id,receipt_id:value.receipt_id,execution_permitted:false};
    if (["denied","cancelled","attention_required"].includes(String(value.status)))
      return {status:value.status,job_id:reference.job_id,receipt_id:value.receipt_id,execution_permitted:false,
        ...(["STORAGE_OBJECT_UNDER_REVIEW","NO_PROVIDER_ATTEMPT","PROVIDER_EFFECT_ABSENT",
          "ADOPT_NOT_SETTLED","DISPATCH_NOT_STARTED","DURABLE_WRITE_RESERVATION_FAILED"].includes(String(value.reason_code))
          ? {reason_code:value.reason_code} : {})};
  }
  return {status:"inspection_required",job_id:reference.job_id,execution_permitted:false};
};

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
  const providerFetch = createStorageFetch(config.fetch);
  return Object.freeze({ async run(reference: Reference) {
    let loaded: Data | null = null;
    let recoveryMode=false, refreshed=false;
    let registrationRecovery: Data | null = null;
    let admissionDeferred = false, beginUnknown = false;
    let recoveredStatus: Data | null = null, deferredCurrentUnusable = false;
    const clock = config.clock ?? Date.now;
    // One allowance for pre-begin authority and begin recovery, measured
    // from this run's start. A fresh executor must not open another 25 s window.
    const retryUntil = clock() + 25000, wallRetryUntil = Date.now() + 25000;
    let retries = 0, retryActive = false, retryExpired = false, admissionStarted = false, closed = false;
    let durableAdmissionDispatched = false, beginDispatched = false, admissionCause: string | null = null;
    let authorityRollbackPhase: "initial" | "revalidation" | null = null, reloadExpected: Data | null = null;
    const retryAbort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let expireRetry!: (error: Error) => void;
    const expired = new Promise<never>((_, reject) => { expireRetry = reject; });
    void expired.catch(() => {});
    const remaining = () => Math.min(retryUntil - clock(),wallRetryUntil - Date.now());
    const expire = () => {
      if (retryExpired || admissionStarted) return;
      retryExpired = true; retryAbort.abort();
      expireRetry(new Error("STORAGE_ADMISSION_RETRY_EXPIRED"));
    };
    const check = () => {
      if (retryActive && !admissionStarted && remaining() <= 0) expire();
      if (closed || retryExpired) throw new Error("STORAGE_ADMISSION_RETRY_EXPIRED");
    };
    const activateRetry = () => {
      if (!retryActive) {
        retryActive = true;
        if (remaining() <= 0) expire();
        else retryTimer = setTimeout(expire,remaining());
      }
    };
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      check();
      const value = await (retryActive && !admissionStarted ? Promise.race([work(),expired]) : work());
      check();
      return value;
    };
    const fetcher: typeof fetch = (input,init) => bounded(() => providerFetch(input,
      retryActive && !admissionStarted ? {...init,signal:AbortSignal.any([retryAbort.signal,...(init?.signal ? [init.signal] : [])])} : init));
    const pauseForRetry = async () => {
      activateRetry();
      if (retries >= 2 || retryExpired) return false;
      const delay = 200 * 2 ** retries++ + Math.floor(Math.random() * 100);
      try { await bounded(() => new Promise<void>(resolve => setTimeout(resolve,Math.min(delay,Math.max(0,remaining()))))); }
      catch { return false; }
      return true;
    };
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
    const createExecutor = () => {
      // The kernel's seen set is per instance. Only a proven pre-begin, zero-effect
      // rollback may replace it; each old instance is permanently closed first.
      const attempt = {closed:false,authorities:0};
      const attemptCheck = () => { check(); if (attempt.closed) throw denied(); };
      const attemptBounded = async <T>(work: () => Promise<T>): Promise<T> => {
        attemptCheck(); const value = await bounded(work); attemptCheck(); return value;
      };
      const attemptFetch: typeof fetch = (input,init) => attemptBounded(() => fetcher(input,init));
      const canonicalRpc = async (input: Data) => {
        attemptCheck();
        let phase: "initial" | "revalidation" | null = null;
        try { return await attemptBounded(() => {
          // Set these synchronously at the actual dispatch boundary, after
          // every deadline check and before invoking any potentially durable RPC.
          if (input.action === "authority") {
            const ordinal = attempt.authorities++;
            if (ordinal < 2 && !durableAdmissionDispatched && !beginDispatched && !admissionStarted && !registrationRecovery)
              phase = ordinal === 0 ? "initial" : "revalidation";
          }
          if (input.action === "begin") beginDispatched = true;
          if (input.action === "begin" || String(input.action).startsWith("registration_")) durableAdmissionDispatched = true;
          return config.rpc(input);
        }); }
        catch (error) {
          // Registration helper authority calls share this bridge. Its actual
          // registration_* dispatch permanently disqualifies a fresh attempt.
          const cause = phase && !durableAdmissionDispatched && !beginDispatched && !admissionStarted && !registrationRecovery &&
            config.account_policy_v2 === true ? authorityCancellationCause(error) : null;
          if (cause) { authorityRollbackPhase = phase; admissionCause = cause; }
          throw error;
        }
      };
      const executionRpc = config.account_policy_v2 === true ? createRegistrationRecoveryRpc({
        rpc: canonicalRpc, descriptor: () => loaded, clock: config.clock,
        on_recovery: result => { registrationRecovery = result; },
        get_file: async id => {
          if (!loaded) throw denied();
          const descriptor = loaded;
          const metadata = createGoogleDriveMetadataApi({
            get_credential: () => credential({owner_id:String(descriptor.owner_id),connection_id:String(descriptor.connection_id),
              provider_subject:String(descriptor.provider_subject),credential_version:Number(descriptor.credential_version)}),
            fetch: async (url, init) => {
              if (init?.method !== "GET") throw denied();
              return attemptFetch(url, init);
            },
          });
          return await metadata.getFile(id);
        },
      }) : canonicalRpc;
      const executor = createResourceCenterCloudExecutor({
        clock, drive_fetch: attemptFetch,
        // The boundary scan reads a whole folder level per request, so one run
        // stays within the Worker's per-invocation subrequest budget.
        metadata_batch: ({ access_token }: { access_token: string }) =>
          // Metadata reads back off and retry rate limits and 5xx (Decision 24422a98).
          createStorageGoogleMetadataBatch({ access_token, fetch: attemptFetch, transient_retries: 3,
            signal: AbortSignal.any([AbortSignal.timeout(60000),retryAbort.signal]) }),
        verified_result_mode: config.account_policy_v2 === true,
        ...(config.account_policy_v2 === true ? { semantic_recovery_client_id: config.client_id } : {}),
        ...(config.load_staged_content ? { load_staged_content: (input: Data) => attemptBounded(() => config.load_staged_content!(input)) } : {}),
        load_job: async (ref: Reference) => {
          if (config.credential_preflight && (await attemptBounded(() => config.credential_preflight!(ref))).status !== "ready")
            throw reject("STORAGE_CREDENTIAL_REFRESH_PENDING");
          // BUG-20261008-001: a refused load leaves the job queued (the scheduled sweep
          // dispatches it again); name the fixed cause in the diagnostic instead of UNSPECIFIED.
          let result: Data;
          try { result = await attemptBounded(() => config.rpc({...ref, action:"load"})); }
          catch (error) {
            // After a proven pre-begin rollback, an unreadable current job is no
            // permission to retry or to replace its durable queued state.
            if (reloadExpected && !currentAdmissionRefusal(error)) admissionDeferred = true;
            throw reject(error instanceof Error && error.message === "storage_object_under_review" ? "STORAGE_OBJECT_UNDER_REVIEW"
              : error instanceof Error && error.message === "storage_root_has_unresolved_mutation"
              ? "STORAGE_ROOT_BUSY" : "STORAGE_JOB_LOAD_REFUSED");
          }
          if (reloadExpected && !sameQueuedDescriptor(result,reloadExpected)) {
            recoveredStatus = originalStatus(result,reference,reloadExpected.request_digest);
            deferredCurrentUnusable = true;
            admissionDeferred = true;
            throw reject("STORAGE_ADMISSION_DESCRIPTOR_CHANGED");
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
        get_credential: (expected: Omit<StorageCredentialContext,"provider"|"oauth_client_id">) => attemptBounded(() => credential(expected)),
        rpc: async (input: Data) => {
          if (!loaded || input.connection_id !== loaded.connection_id || input.job_id !== loaded.job_id) throw denied();
          const {connection_id, job_id, action, ...body} = input;
          try {
            const request: Data = {connection_id, job_id, action,
              ...(action==="settle_verified" ? {} : {credential_version:loaded.credential_version}),
              ...(action==="finalize" ? {finish:{action,...body}} : body)};
            if (action !== "begin" || config.account_policy_v2 !== true) return await executionRpc(request);
            for (;;) {
              try {
                const result = await executionRpc(structuredClone(request));
                beginUnknown = false;
                // Only an on-time, fully matched durable start ends admission's
                // deadline. A late/invalid start remains an unknown original.
                if (result.status === "committed" && result.state === "started" && result.execution_permitted === true &&
                    originalReceiptId(result.intent_id) && result.job_id === reference.job_id &&
                    result.job_request_digest === loaded.request_digest && object(request.prepare) &&
                    result.request_sha256 === request.prepare.request_sha256 && Number.isSafeInteger(result.version)) {
                  admissionStarted = true;
                  clearTimeout(retryTimer);
                }
                return result;
              } catch (error) {
                beginUnknown = true;
                if (!rolledBackAdmission(error)) throw error;
                if (!await pauseForRetry()) {
                  admissionDeferred = true;
                  throw error;
                }
                let current: Data;
                try { current = await attemptBounded(() => config.rpc({...reference,action:"load"})); }
                catch (readError) {
                  if (currentAdmissionRefusal(readError)) throw readError;
                  admissionDeferred = true; throw error;
                }
                // A real load returns this full descriptor only while the same
                // original job has no intent/outcome and all current gates pass.
                // It must still identify the original request and credential;
                // never manufacture a new job/key or reuse stale authority.
                const unchanged = sameQueuedDescriptor(current,loaded);
                if (!unchanged) {
                  recoveredStatus = originalStatus(current,reference,loaded.request_digest);
                  deferredCurrentUnusable = true;
                  admissionDeferred = true;
                  throw error;
                }
                if (remaining() <= 0) { expire(); admissionDeferred = true; throw error; }
              }
            }
          } catch (error) {
            if (error instanceof Error && error.message === "storage_object_under_review") throw reject("STORAGE_OBJECT_UNDER_REVIEW");
            throw error;
          }
        },
      });
      return {async run() {
        try { return await attemptBounded(() => executor.run(reference)); }
        finally { attempt.closed = true; }
      }};
    };
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
      let result: Data;
      for (;;) {
        authorityRollbackPhase = null;
        try { result = await createExecutor().run(); }
        catch {
          if (!retryExpired) throw denied();
          if (!beginDispatched) admissionDeferred = true;
          else beginUnknown = true;
          result = {status:"unavailable",execution_permitted:false};
        }
        const expectedFailure = authorityRollbackPhase === "initial" ? "ARTIFACT_AUTHORITY_RESOLUTION_FAILED"
          : authorityRollbackPhase === "revalidation" ? "ARTIFACT_AUTHORITY_REVALIDATION_FAILED" : null;
        if (!expectedFailure || durableAdmissionDispatched || beginDispatched || admissionStarted || registrationRecovery ||
            result.status !== "deny" || result.error_code !== expectedFailure || result.side_effects !== 0) break;
        if (!await pauseForRetry()) { admissionDeferred = true; break; }
        reloadExpected = loaded ? structuredClone(loaded) : null;
        if (!reloadExpected) { admissionDeferred = true; break; }
      }
      const reservationDiagnostic = sanitizeReservationDiagnostic("reservation_diagnostic" in result ? result.reservation_diagnostic : undefined);
      if (reservationDiagnostic?.reservation_status === "unknown" &&
          ["begin_rpc","begin_result"].includes(reservationDiagnostic.stage)) beginUnknown = true;
      if (registrationRecovery) {
        // Only the qualified, pre-intent registration helper sets this value.
        // Its sidecar/lease is durable; an RPC outage leaves the original job
        // queued for the existing bounded sweep. Never report this as denied.
        return {status: "registration_recovery", job_id: reference.job_id,
          registration_recovery: registrationRecovery, execution_permitted: false};
      }
      if (admissionDeferred) {
        const descriptor = loaded as Data | null;
        const inspect = () => ({...inspectOriginal(reference),...(admissionCause ? {reason_code:admissionCause} : {})});
        if (recoveredStatus) {
          const original = inspectOriginal(reference,recoveredStatus);
          return original.status === "inspection_required" ? inspect() : original;
        }
        if (deferredCurrentUnusable || retryExpired || !descriptor) return inspect();
        // Only a current, matching Canonical queued descriptor qualifies this
        // unavailable result for the existing durable sweep/backoff/expiry.
        // A lost/late read or a concurrent intent is inspection, never NoEffect.
        let current: Data;
        try { current = await bounded(() => config.rpc({...reference,action:"load"})); }
        catch { return inspect(); }
        if (!sameQueuedDescriptor(current,descriptor)) {
          const original = inspectOriginal(reference,originalStatus(current,reference,descriptor.request_digest));
          return original.status === "inspection_required" ? inspect() : original;
        }
        return {status:"unavailable",job_id:reference.job_id,error_code:"STORAGE_ADMISSION_RETRY_PENDING",
          ...(admissionCause ? {reason_code:admissionCause} : {}),execution_permitted:false};
      }
      if (loaded && ["deny","unavailable","unreconciled"].includes(String(result.status))) {
        // Account-policy mode stores the fixed reason (and, for a boundary denial, the
        // scan's finding paths) in the Owner's private job row. It is never logged. A
        // server that predates the reason, or refuses its shape, still gets the plain outcome.
        const report=(outcome: Data) => config.rpc({...reference,action:"report",
          credential_version:(loaded as Data).credential_version,outcome});
        const outcome=cloudDispatchOutcome(result) as Data;
        const plain={status:outcome.status};
        let reported: Data | null = null;
        try {
          if (config.account_policy_v2 === true && "reason" in outcome) {
            try { reported = await report(outcome); } catch { reported = await report(plain); }
          } else reported = await report(plain);
        }
        catch { /* Never redispatch. Original Canonical journal remains authoritative. */ }
        if (config.account_policy_v2 === true) {
          const current = originalStatus(reported,reference,(loaded as Data).request_digest);
          if (current && typeof current.intent_id === "string" &&
              (beginUnknown || result.status === "deny" || current.status === "committed")) return inspectOriginal(reference,current);
          if (beginUnknown && (!current || !["denied","attention_required","cancelled"].includes(String(current.status))))
            return inspectOriginal(reference,current);
        }
      }
      return result;
    }
    finally { closed = true; clearTimeout(retryTimer); retryAbort.abort(); loaded = null; }
  }});
}
