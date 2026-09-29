import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createResourceCenterOnlineToolHost } from "./resource-center-online-tool-host.mjs";
import { createGoogleDriveMetadataApi } from "./resource-center-google-drive-metadata.mjs";
import { createGoogleDriveProviderIdentityResolver } from "./resource-center-google-drive-identity.mjs";
import { createGoogleDriveBoundaryScanner } from "./resource-center-google-drive-boundary.mjs";
import { createGoogleDriveNativeCreateEffect } from "./resource-center-google-drive-create-effect.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "./resource-center-google-drive-postcondition.mjs";
import { RESOURCE_CENTER_MUTATION_TOOL } from "./resource-center-governed-tool-surface.mjs";
import { RESOURCE_CENTER_POLICY_VERSION, bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const uuid = value => typeof value==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopes = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const fail = () => { throw new Error("CLOUD_EXECUTOR_UNAVAILABLE"); };
const unavailable = () => ({status:"unavailable",execution_permitted:false});
const logDiagnostic = (status,errorCode) => {
  // Never log the job, credential, path, scan findings or provider reply.
  const code=typeof errorCode==="string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : "UNSPECIFIED";
  console.warn(JSON.stringify({event:status==="deny"?"storage_cloud_denied":"storage_cloud_unreconciled",error_code:code}));
};
const providerAuthorityCodes = new Set([
  "PROVIDER_DESTINATION_EXISTS", "PROVIDER_LIST_UNAVAILABLE", "PROVIDER_METADATA_MISMATCH",
  "PROVIDER_PATH_AMBIGUOUS", "PROVIDER_PATH_OUTSIDE_REGISTERED_ROOT", "PROVIDER_PATH_UNREGISTERED",
  "PROVIDER_PROFILE_ROOT_MISMATCH", "PROVIDER_ROOT_ID_MISMATCH", "PROVIDER_ROOT_MUTATION_FORBIDDEN",
  "DRIVE_CREDENTIAL_UNAVAILABLE", "DRIVE_LIST_INVALID", "DRIVE_METADATA_MISMATCH",
  "DRIVE_METADATA_UNAVAILABLE", "DRIVE_NAMESPACE_VISIBILITY_UNPROVEN", "DRIVE_PAGINATION_INVALID",
  "DRIVE_PAGINATION_LIMIT",
]);
const logAuthorityFailure = (phase,stage,errorCode) => {
  // Emit only fixed labels. In particular, never serialize an exception, RPC response or provider identity.
  console.warn(JSON.stringify({event:"storage_cloud_authority_failed",phase,stage,error_code:errorCode}));
};

/** Private cloud composition, not an Agent tool or production activation.
 * load_job/rpc/credential custody must be fixed, authenticated server closures.
 * run accepts correlation IDs ONLY. Shared DB begin, not this process, owns
 * cross-device exclusion. A lost start/POST is inspection-only forever here.
 * The caller never receives a credential, admission or durable execution grant.
 * @param {{load_job: Function, rpc: Function, get_credential: Function, drive_fetch?: typeof fetch, clock?: () => number, verified_result_mode?: boolean}} config
 */
export function createResourceCenterCloudExecutor({load_job:loadJob,rpc,get_credential:getCredential,
  drive_fetch:driveFetch=globalThis.fetch,clock=Date.now,verified_result_mode:verifiedResultMode=false}={}){
  if([loadJob,rpc,getCredential,driveFetch,clock].some(fn=>typeof fn!=="function") ||
    typeof verifiedResultMode!=="boolean") throw new TypeError("Private server dependencies required.");
  const seen=new Set();
  return Object.freeze({async run(reference){
    if(!reference || Object.keys(reference).sort().join(",")!=="connection_id,job_id" ||
      !uuid(reference.connection_id)||!uuid(reference.job_id)) return unavailable();
    const ref=Object.freeze(structuredClone(reference)), key=ref.connection_id+":"+ref.job_id;
    if(seen.has(key)) return {status:"inspection_required",execution_permitted:false};
    seen.add(key); // before await: never redispatch a lost response in this host.
    let descriptor;
    try{
      descriptor=structuredClone(await loadJob(ref));
      if(descriptor?.contract!=="clued.storage-job-execution/1" || descriptor.job_id!==ref.job_id || descriptor.connection_id!==ref.connection_id ||
        !uuid(descriptor.owner_id) || !/^[0-9a-f]{64}$/.test(descriptor.request_digest??"")) fail();
      if(descriptor.status!=="queued") return {status:"inspection_required",execution_permitted:false};
      if(descriptor.provider!=="google-drive" || typeof descriptor.provider_subject!=="string" || !descriptor.provider_subject ||
        !Number.isSafeInteger(descriptor.credential_version)||descriptor.credential_version<1) fail();
      const profile=structuredClone(descriptor.profile), mutation=structuredClone(descriptor.mutation);
      if(!uuid(profile?.profile_id) || profile.policy_version!==RESOURCE_CENTER_POLICY_VERSION || mutation?.operation!=="create" ||
        !["file","directory"].includes(mutation.target_kind) ||
        Object.keys(mutation).some(k=>!["operation","destination_path","target_kind","directory_semantics","content"].includes(k)) ||
        bindResourceCenterMutation(mutation).destination_path!==mutation.destination_path ||
        (mutation.target_kind==="file" && (typeof mutation.content!=="string" || "directory_semantics" in mutation)) ||
        (mutation.target_kind==="directory" && ("content" in mutation || !["topic","asset_collection"].includes(mutation.directory_semantics)))) fail();
      const credential=async()=>{
        const c=await getCredential(Object.freeze({owner_id:descriptor.owner_id,connection_id:descriptor.connection_id,
          provider_subject:descriptor.provider_subject,credential_version:descriptor.credential_version}));
        if(!c || c.owner_id!==descriptor.owner_id || c.connection_id!==descriptor.connection_id || c.provider_subject!==descriptor.provider_subject ||
          c.credential_version!==descriptor.credential_version || typeof c.scope!=="string" ||
          [...new Set(c.scope.split(/\s+/))].sort().join(" ")!==scopes ||
          !Number.isFinite(c.expires_at_ms)||c.expires_at_ms-clock()<=60000) fail();
        return c;
      };
      const metadata=createGoogleDriveMetadataApi({get_credential:credential,fetch:driveFetch});
      const resolveProvider=createGoogleDriveProviderIdentityResolver({managed_root:profile.managed_root,root_folder_id:descriptor.root_folder_id,
        root_parent_id:descriptor.root_parent_id,get_file:metadata.getFile,list_children:metadata.listChildren});
      const scan=createGoogleDriveBoundaryScanner({trusted_profile:profile,root_folder_id:descriptor.root_folder_id,root_parent_id:descriptor.root_parent_id,
        scan_roots:descriptor.scan_roots,get_file:metadata.getFile,list_folder:metadata.listFolder});
      const findings=await scan();
      if(findings.length) {
        logDiagnostic("deny","UNAUTHORIZED_WORKSPACE_MUTATION");
        return {status:"deny",error_code:"UNAUTHORIZED_WORKSPACE_MUTATION",findings,side_effects:0,execution_permitted:false};
      }
      const authorityRequest=async input=>({contract:"clued.resource-center-authority/1",policy_version:RESOURCE_CENTER_POLICY_VERSION,
        profile_id:profile.profile_id,profile_version:profile.profile_version,mutation:bindResourceCenterMutation(input),
        provider_identity:await resolveProvider({profile,mutation:input})});
      const invoke=async input=>rpc(Object.freeze({...ref,...input}));
      let authorityLookupCount=0;
      const resolveAuthority=async({mutation:input})=>{
        const phase=["initial","revalidation","pre_effect"][Math.min(authorityLookupCount++,2)];
        let request;
        try { request=await authorityRequest(input); }
        catch(error){
          const message=error?.message;
          logAuthorityFailure(phase,"provider_identity",providerAuthorityCodes.has(message)?message:"PROVIDER_IDENTITY_UNAVAILABLE");
          throw error;
        }
        let result;
        try { result=await invoke({action:"authority",request}); }
        catch(error){
          logAuthorityFailure(phase,"canonical_rpc","AUTHORITY_RPC_UNAVAILABLE");
          throw error;
        }
        if(result?.status!=="resolved"){
          logAuthorityFailure(phase,"canonical_result",result?.status==="denied"?"AUTHORITY_RPC_DENIED":"AUTHORITY_RESPONSE_INVALID");
          fail();
        }
        if(!isDeepStrictEqual(result.request,request) || !result.authority?.workspace_version){
          logAuthorityFailure(phase,"canonical_result","AUTHORITY_RESPONSE_MISMATCH");
          fail();
        }
        return Object.freeze({...result.authority,workspace_version:"provider+canonical:"+hash([result.authority.workspace_version,request.provider_identity])});
      };
      let startedProvider=null, saved=null;
      const effect=createGoogleDriveNativeCreateEffect({trusted_profile:profile,get_credential:credential,resolve_provider_identity:resolveProvider,
        fetch:driveFetch,clock,consume_started_provider:binding=>{
          const current=startedProvider;startedProvider=null;
          return current?.request_sha256===binding.request_sha256?current:null;
        },persist_provider_attempt:async attempt=>{
          const result=await invoke({action:"provider_attempt",attempt});
          if(result?.status!=="committed" || result.attempt_recorded!==true || !uuid(result.receipt_id) || !isDeepStrictEqual(result.attempt,attempt)) fail();
        }});
      const verify=createGoogleDriveCreatePostconditionVerifier({managed_root:profile.managed_root,root_folder_id:descriptor.root_folder_id,
        root_parent_id:descriptor.root_parent_id,get_file:metadata.getFile,list_children:metadata.listChildren,
        require_effect_provider_id:true,include_verified_proof:verifiedResultMode,clock});
      const host=createResourceCenterOnlineToolHost({trusted_profile:profile,resolve_artifact_online:resolveAuthority,
        mutation_effect:effect,scan_boundary:scan,clock,
        prepare_write:async({mutation:input,binding})=>{
          const request=await authorityRequest(input);
          const result=await invoke({action:"begin",prepare:{action:"prepare",request_key:"account-job:"+ref.job_id,
            idempotency_key:"account-job:"+ref.job_id+":prepare",request_sha256:binding.request_sha256,
            exact_request:{mutation:input,binding},authority_request:request}});
          if(result?.status!=="committed" || result.state!=="started" || result.execution_permitted!==true || !uuid(result.intent_id) ||
            result.job_id!==ref.job_id || result.job_request_digest!==descriptor.request_digest || result.request_sha256!==binding.request_sha256 ||
            !Number.isSafeInteger(result.version)) fail();
          saved={result:structuredClone(result),provider:request.provider_identity};
          startedProvider={intent_id:result.intent_id,request_sha256:result.request_sha256,provider:request.provider_identity};
          return {status:"started",execution_permitted:true,intent_id:result.intent_id,request_sha256:result.request_sha256};
        },commit_post_write:async({mutation:input,binding,reservation,effect_result:result})=>{
          if(!saved || saved.result.intent_id!==reservation.intent_id) fail();
          const verification=await verify({profile,mutation:input,provider_before:saved.provider,effect_result:result})
            .catch(error=>{
              const code=typeof error?.message==="string" && /^DRIVE_POSTCONDITION_[A-Z_]+$/.test(error.message)
                ? error.message : "DRIVE_POSTCONDITION_UNAVAILABLE";
              console.warn(JSON.stringify({event:"storage_cloud_postcondition_failed",error_code:code}));
              throw error;
            });
          const {verified_proof:proof,...postcondition}=verification;
          const finish={action:"finalize",intent_id:reservation.intent_id,base_version:saved.result.version,
            request_sha256:binding.request_sha256,idempotency_key:"account-job:"+ref.job_id+":finalize",postcondition};
          let finished;
          if(verifiedResultMode){
            if(proof?.contract!=="clued.storage-create-verified/2") fail();
            const recorded=await invoke({action:"verified_record",finish,proof});
            if(recorded?.status!=="verified" || recorded.intent_id!==reservation.intent_id ||
              !uuid(recorded.verified_receipt_id) || !/^[0-9a-f]{64}$/.test(recorded.verified_digest??"") ||
              !Number.isSafeInteger(recorded.version) || recorded.execution_permitted!==false) fail();
            finished=await invoke({action:"settle_verified",intent_id:reservation.intent_id,
              base_version:recorded.version,request_sha256:binding.request_sha256,
              verified_receipt_id:recorded.verified_receipt_id,verified_digest:recorded.verified_digest});
          }else{
            finished=await invoke({action:"finalize",...finish});
          }
          if(finished?.status!=="committed" || finished.state!=="committed" || finished.intent_id!==reservation.intent_id ||
            finished.request_sha256!==binding.request_sha256 || finished.final_result?.status!=="committed" || !uuid(finished.receipt_id)) fail();
          return {status:"committed",receipt_id:finished.receipt_id,request_sha256:binding.request_sha256};
        }});
      const result=await host.callTool(RESOURCE_CENTER_MUTATION_TOOL,mutation);
      if(result.status==="unreconciled" || result.status==="deny") {
        // Keep the original journal fenced, but leave a stable diagnostic.
        logDiagnostic(result.status,result.error_code);
      }
      // Keep the internal admission, binding and provider result out of the
      // public job result. Recovery reads the original durable service state.
      return result.status==="committed" ? {status:"committed",job_id:ref.job_id,receipt_id:result.canonical_receipt_id,execution_permitted:false} :
        {status:result.status,error_code:result.error_code,side_effects:result.side_effects,execution_permitted:false};
    }catch{return unavailable();}
  }});
}
