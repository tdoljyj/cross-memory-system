import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createResourceCenterOnlineToolHost } from "./resource-center-online-tool-host.mjs";
import { createGoogleDriveMetadataApi } from "./resource-center-google-drive-metadata.mjs";
import { scopeProfile } from "./resource-center-google-scopes.mjs";
import { createGoogleDriveProviderIdentityResolver } from "./resource-center-google-drive-identity.mjs";
import { createGoogleDriveBoundaryScanner } from "./resource-center-google-drive-boundary.mjs";
import { createGoogleDriveNativeCreateEffect, contentRefShape, contentSourceShape } from "./resource-center-google-drive-create-effect.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "./resource-center-google-drive-postcondition.mjs";
import { createGoogleDriveNativeModifyEffect, modifyShape } from "./resource-center-google-drive-modify-effect.mjs";
import { createGoogleDriveModifyPostconditionVerifier } from "./resource-center-google-drive-modify-postcondition.mjs";
import { createGoogleDriveNativeReplaceEffect, replaceShape, sha256Hex, md5Hex } from "./resource-center-google-drive-replace-effect.mjs";
import { createGoogleDriveReplacePostconditionVerifier } from "./resource-center-google-drive-replace-postcondition.mjs";
import { createGoogleDriveNativeDestructiveEffect, destructiveShape, destructiveOwnershipAllowed,
  DESTRUCTIVE_PROOF_CONTRACTS } from "./resource-center-google-drive-destructive-effect.mjs";
import { createGoogleDriveDestructivePostconditionVerifier } from "./resource-center-google-drive-destructive-postcondition.mjs";
import { RESOURCE_CENTER_MUTATION_TOOL } from "./resource-center-governed-tool-surface.mjs";
import { RESOURCE_CENTER_POLICY_VERSION, bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const uuid = value => typeof value==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Each refusal names the failed check with a fixed label; the default keeps the legacy label.
const fail = (code="CLOUD_EXECUTOR_UNAVAILABLE") => { throw new Error(code); };
const unavailable = () => ({status:"unavailable",execution_permitted:false});
const logDiagnostic = (status,errorCode) => {
  // Never log the job, credential, path, scan findings or provider reply.
  const code=typeof errorCode==="string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : "UNSPECIFIED";
  const event=status==="deny"?"storage_cloud_denied":status==="unavailable"?"storage_cloud_unavailable":"storage_cloud_unreconciled";
  console.warn(JSON.stringify({event,error_code:code}));
};
// The Owner-private reason stored with a pre-reservation dispatch outcome.
// Only fixed labels and the boundary scan's own finding paths; never logged.
const reasonCode = /^[A-Z][A-Z0-9_]{2,63}$/;
const findingReason = /^[a-z][a-z0-9_]{2,63}$/;
export function cloudDispatchOutcome(result) {
  const status = result?.status==="deny" ? "denied" : "attention_required";
  const code = result?.error_code;
  if (typeof code!=="string" || !reasonCode.test(code)) return {status};
  const findings = status==="denied" && Array.isArray(result.findings) ? result.findings
    .filter(f=>typeof f?.path==="string" && f.path.length>0 && !f.path.includes("\u0000") &&
      typeof f.reason==="string" && findingReason.test(f.reason))
    .slice(0,10).map(f=>({path:Array.from(f.path).slice(0,1000).join(""),reason:f.reason})) : [];
  return {status,reason:findings.length ? {code,findings} : {code}};
}
// Only Clued's own fixed labels (never an exception or provider text) name an
// unavailable run: descriptor/shape checks, DRIVE_BOUNDARY_* scan refusals,
// Drive transport categories, credential closure labels and provider identity codes.
const unavailableCode = error => {
  const message=error?.message;
  return typeof message==="string" && message.length<=64 &&
    /^(CLOUD|DRIVE|PROVIDER|STORAGE)_[A-Z0-9_]+$/.test(message) ? message : "UNSPECIFIED";
};
const providerAuthorityCodes = new Set([
  "PROVIDER_DESTINATION_EXISTS", "PROVIDER_LIST_UNAVAILABLE", "PROVIDER_METADATA_MISMATCH",
  "PROVIDER_PATH_AMBIGUOUS", "PROVIDER_PATH_OUTSIDE_REGISTERED_ROOT", "PROVIDER_PATH_UNREGISTERED",
  "PROVIDER_PROFILE_ROOT_MISMATCH", "PROVIDER_ROOT_ID_MISMATCH", "PROVIDER_ROOT_MUTATION_FORBIDDEN",
  "DRIVE_CREDENTIAL_UNAVAILABLE", "DRIVE_LIST_INVALID", "DRIVE_METADATA_MISMATCH",
  "DRIVE_METADATA_UNAVAILABLE", "DRIVE_NAMESPACE_VISIBILITY_UNPROVEN", "DRIVE_PAGINATION_INVALID",
  "DRIVE_PAGINATION_LIMIT", "SOURCE_VERSION_MISMATCH", "DESTINATION_VERSION_MISMATCH", "REVISION_KEEP_LIMIT",
  "REPLACE_TARGET_UNSUPPORTED", "STORAGE_CONTENT_STAGING_MISMATCH", "SOURCE_ID_MISMATCH",
]);
// Fixed denial labels from public.clued_resource_center_authority_v1; each names a failed check, never a value.
const authorityDenialReasons = new Set([
  "request_invalid", "binding_inactive", "profile_mismatch", "root_identity_mismatch", "decision_not_current",
  "root_version_mismatch", "root_unregistered", "root_path_not_current", "operation_shape_invalid",
  "root_sharing_changed", "root_sharing_unavailable", "parent_sharing_changed", "parent_sharing_unavailable",
  "source_mismatch", "destination_outside_root", "parent_version_mismatch", "parent_unregistered",
  "parent_path_not_current", "destination_mismatch", "destination_exists", "artifact_decision_not_current",
  "delete_authority_required", "restore_name_conflict", "directory_not_empty", "track_forbidden", "internal_error",
]);
const logAuthorityFailure = (phase,stage,errorCode,reason) => {
  // Emit only fixed labels. In particular, never serialize an exception, RPC response or provider identity.
  console.warn(JSON.stringify({event:"storage_cloud_authority_failed",phase,stage,error_code:errorCode,
    ...(authorityDenialReasons.has(reason) ? {reason} : {})}));
};
const postWriteFailureCodes = Object.freeze({
  reservation:"POST_WRITE_RESERVATION_MISMATCH",
  verify:"DRIVE_POSTCONDITION_UNAVAILABLE",
  postcondition:"POST_WRITE_POSTCONDITION_INVALID",
  proof:"POST_WRITE_PROOF_INVALID",
  verified_record_rpc:"VERIFIED_RECORD_RPC_UNAVAILABLE",
  verified_record_result:"VERIFIED_RECORD_RESPONSE_INVALID",
  settle_verified_rpc:"SETTLE_VERIFIED_RPC_UNAVAILABLE",
  settle_verified_result:"SETTLE_VERIFIED_RESPONSE_INVALID",
  finalize_rpc:"FINALIZE_RPC_UNAVAILABLE",
  finalize_result:"FINALIZE_RESPONSE_INVALID",
});
const safeVerifyErrorCodes = new Set([
  "CLOUD_EXECUTOR_UNAVAILABLE", "DRIVE_CREDENTIAL_UNAVAILABLE", "DRIVE_NAMESPACE_VISIBILITY_UNPROVEN",
  "DRIVE_METADATA_UNAVAILABLE", "DRIVE_METADATA_MISMATCH", "DRIVE_METADATA_TIMEOUT",
  "DRIVE_METADATA_ABORTED", "DRIVE_METADATA_REQUEST_FAILED", "DRIVE_METADATA_RESPONSE_INVALID",
  "DRIVE_METADATA_SUBREQUEST_LIMIT",
  "DRIVE_LIST_INVALID", "DRIVE_ENUMERATION_LIMIT", "DRIVE_PAGINATION_INVALID", "DRIVE_PAGINATION_LIMIT",
  // Fixed labels thrown by the Worker credential closure (apps/clued-cloud/worker/storage-cloud-executor.ts).
  "STORAGE_CREDENTIAL_CONTEXT_MISMATCH", "STORAGE_CREDENTIAL_OPEN_FAILED", "STORAGE_CREDENTIAL_INVALID",
  "STORAGE_CREDENTIAL_EXPIRING", "STORAGE_CREDENTIAL_REFRESH_FAILED",
]);
const logPostWriteFailure = (stage,error) => {
  // These fixed labels identify the failed step without logging job, file, credential or raw error data.
  const knownVerifierCode=stage==="verify" && typeof error?.message==="string" &&
    (safeVerifyErrorCodes.has(error.message) || /^DRIVE_POSTCONDITION_[A-Z_]{1,48}$/.test(error.message));
  console.warn(JSON.stringify({event:stage==="verify"?"storage_cloud_postcondition_failed":"storage_cloud_postwrite_failed",stage,
    error_code:knownVerifierCode?error.message:postWriteFailureCodes[stage]}));
};

/** Private cloud composition, not an Agent tool or production activation.
 * load_job/rpc/credential custody must be fixed, authenticated server closures.
 * run accepts correlation IDs ONLY. Shared DB begin, not this process, owns
 * cross-device exclusion. A lost start/POST is inspection-only forever here.
 * The caller never receives a credential, admission or durable execution grant.
 * metadata_batch, when supplied, returns {getFiles, listFolders} bound to one
 * validated access token; the boundary scan then reads a folder level per call.
 * load_staged_content, when supplied, opens a binary create job's staged object (StorageNormalUse
 * §6.2) as a bounded-memory source {size, sha256, verify(), stream()}; the executor runs verify()
 * (full decrypt + sha256) before any reservation. Without it binary jobs are refused.
 * @param {{load_job: Function, rpc: Function, get_credential: Function, drive_fetch?: typeof fetch, clock?: () => number, verified_result_mode?: boolean, metadata_batch?: Function, load_staged_content?: Function}} config
 */
export function createResourceCenterCloudExecutor({load_job:loadJob,rpc,get_credential:getCredential,
  drive_fetch:driveFetch=globalThis.fetch,clock=Date.now,verified_result_mode:verifiedResultMode=false,
  metadata_batch:metadataBatch,load_staged_content:loadStagedContent}={}){
  if([loadJob,rpc,getCredential,driveFetch,clock].some(fn=>typeof fn!=="function") ||
    (metadataBatch!==undefined && typeof metadataBatch!=="function") ||
    (loadStagedContent!==undefined && typeof loadStagedContent!=="function") ||
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
        !uuid(descriptor.owner_id) || !/^[0-9a-f]{64}$/.test(descriptor.request_digest??"")) fail("CLOUD_DESCRIPTOR_INVALID");
      if(descriptor.status!=="queued") return {status:"inspection_required",execution_permitted:false};
      if(descriptor.provider!=="google-drive" || typeof descriptor.provider_subject!=="string" || !descriptor.provider_subject ||
        !Number.isSafeInteger(descriptor.credential_version)||descriptor.credential_version<1) fail("CLOUD_DESCRIPTOR_INVALID");
      const profile=structuredClone(descriptor.profile), mutation=structuredClone(descriptor.mutation);
      if(!uuid(profile?.profile_id) || profile.policy_version!==RESOURCE_CENTER_POLICY_VERSION) fail("CLOUD_PROFILE_INVALID");
      // Rename and file move (StorageFullCapability P3) run only in the
      // verified-result (account policy) mode, whose server proof names them.
      const modify=mutation?.operation==="rename" || mutation?.operation==="move";
      // Replace and revert (P4) likewise; the server names the Clued-pinned
      // revisions to release and, for a revert, the pinned revision to restore.
      const replace=mutation?.operation==="replace";
      // Trash ("delete") and untrash ("restore", P5) likewise; for an untrash
      // the server names the registered, trashed source's Drive ID.
      const destructive=mutation?.operation==="delete" || mutation?.operation==="restore";
      const revisionIdOk=value=>typeof value==="string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
      if(replace){
        if(!verifiedResultMode || !replaceShape(mutation) || mutation.target_kind!=="file" ||
          Object.keys(mutation).some(k=>!["operation","destination_path","target_kind","destination_file_version","content","restore_job_id"].includes(k)) ||
          !Array.isArray(descriptor.revision_releases) || descriptor.revision_releases.length>200 || !descriptor.revision_releases.every(revisionIdOk) ||
          (mutation.restore_job_id===undefined ? descriptor.restore!=null :
            (!descriptor.restore || !revisionIdOk(descriptor.restore.revision_id) ||
              !/^[A-Za-z0-9_-]{1,160}$/.test(descriptor.restore.provider_file_id??"") ||
              !/^(0|[1-9]\d{0,19})$/.test(descriptor.restore.size??"") ||
              (descriptor.restore.sha256==null && descriptor.restore.md5==null)))) fail("CLOUD_MUTATION_SHAPE_INVALID");
      }else if(destructive){
        // The server names an untrash's registered, trashed source by the
        // exact Drive ID and version the job carries (one row, or nothing).
        const source=descriptor.untrash_source;
        const keys=Object.keys(mutation).sort().join(",");
        if(!verifiedResultMode || !destructiveShape(mutation) ||
          (keys!=="operation,source_file_id,source_file_version,source_path,target_kind" &&
            keys!=="destination_path,operation,restore_mode,source_file_id,source_file_version,source_path,target_kind") ||
          (mutation.operation==="restore" ? (!source || typeof source!=="object" ||
            Object.keys(source).sort().join(",")!=="provider_file_id,provider_file_version" ||
            source.provider_file_id!==mutation.source_file_id || source.provider_file_version!==mutation.source_file_version)
            : source!=null)) fail("CLOUD_MUTATION_SHAPE_INVALID");
      }else if(modify){
        if(!verifiedResultMode || !modifyShape(mutation) || mutation.target_kind!=="file" ||
          Object.keys(mutation).some(k=>!["operation","source_path","destination_path","target_kind","source_file_version"].includes(k))) fail("CLOUD_MUTATION_SHAPE_INVALID");
      }else if(mutation?.operation==="create" && mutation.content_ref!==undefined){
        // Binary create (N3): account-policy mode only, exact content reference, staged bytes loader.
        if(!verifiedResultMode || !loadStagedContent || mutation.target_kind!=="file" ||
          Object.keys(mutation).sort().join(",")!=="content_ref,destination_path,operation,target_kind" ||
          bindResourceCenterMutation(mutation).destination_path!==mutation.destination_path ||
          !contentRefShape(mutation.content_ref) || descriptor.staging?.staging_id!==mutation.content_ref.staging_id) fail("CLOUD_MUTATION_SHAPE_INVALID");
      }else if(mutation?.operation!=="create" ||
        !["file","directory"].includes(mutation.target_kind) ||
        Object.keys(mutation).some(k=>!["operation","destination_path","target_kind","directory_semantics","content"].includes(k)) ||
        bindResourceCenterMutation(mutation).destination_path!==mutation.destination_path ||
        (mutation.target_kind==="file" && (typeof mutation.content!=="string" || "directory_semantics" in mutation)) ||
        (mutation.target_kind==="directory" && ("content" in mutation || !["topic","asset_collection"].includes(mutation.directory_semantics)))) fail("CLOUD_MUTATION_SHAPE_INVALID");
      const credential=async()=>{
        const c=await getCredential(Object.freeze({owner_id:descriptor.owner_id,connection_id:descriptor.connection_id,
          provider_subject:descriptor.provider_subject,credential_version:descriptor.credential_version}));
        if(!c || c.owner_id!==descriptor.owner_id || c.connection_id!==descriptor.connection_id || c.provider_subject!==descriptor.provider_subject ||
          c.credential_version!==descriptor.credential_version || typeof c.scope!=="string" ||
          scopeProfile(c.scope)===null ||
          !Number.isFinite(c.expires_at_ms)||c.expires_at_ms-clock()<=60000) fail();
        return c;
      };
      const metadata=createGoogleDriveMetadataApi({get_credential:credential,fetch:driveFetch});
      const resolveProvider=createGoogleDriveProviderIdentityResolver({managed_root:profile.managed_root,root_folder_id:descriptor.root_folder_id,
        root_parent_id:descriptor.root_parent_id,get_file:metadata.getFile,list_children:metadata.listChildren,
        get_sharing:metadata.getSharing,
        ...(mutation.operation==="restore" ? {restore_source_id:descriptor.untrash_source.provider_file_id} : {})});
      let batched={};
      if(metadataBatch){
        const batch=await metadataBatch(Object.freeze({access_token:(await credential()).access_token}));
        if(typeof batch?.getFiles!=="function" || typeof batch?.listFolders!=="function") fail("CLOUD_METADATA_BATCH_INVALID");
        // The batch transport's fields already include isAppAuthorized.
        batched={get_files:ids=>batch.getFiles(ids),list_folders:ids=>batch.listFolders(ids)};
      }
      // Full, unfiltered listings; each entry also carries isAppAuthorized for
      // the island rule only (StorageNormalUse §3.1).
      const scan=createGoogleDriveBoundaryScanner({trusted_profile:profile,root_folder_id:descriptor.root_folder_id,root_parent_id:descriptor.root_parent_id,
        scan_roots:descriptor.scan_roots,get_file:metadata.getFile,
        // The server names the owner's other active roots under the same parent.
        registered_sibling_roots:descriptor.registered_sibling_roots===undefined ? [] : descriptor.registered_sibling_roots,
        list_folder:id=>metadata.listFolder(id,{app_authorized:true}),...batched});
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
          if(result?.status==="denied") logAuthorityFailure(phase,"canonical_result","AUTHORITY_RPC_DENIED",result.reason);
          else logAuthorityFailure(phase,"canonical_result","AUTHORITY_RESPONSE_INVALID");
          fail();
        }
        if(!isDeepStrictEqual(result.request,request) || !result.authority?.workspace_version){
          logAuthorityFailure(phase,"canonical_result","AUTHORITY_RESPONSE_MISMATCH");
          fail();
        }
        // §6.1 version precondition: the Agent names the version it observed.
        // A change since then is refused before any durable reservation.
        if((modify||destructive) && request.provider_identity.source_file_version!==input.source_file_version){
          logAuthorityFailure(phase,"provider_identity","SOURCE_VERSION_MISMATCH");
          fail();
        }
        // P5: trash/untrash name the item by its Drive ID, not only its path.
        if(destructive && request.provider_identity.source_file_id!==input.source_file_id){
          logAuthorityFailure(phase,"provider_identity","SOURCE_ID_MISMATCH");
          fail();
        }
        if(replace && request.provider_identity.destination_file_version!==input.destination_file_version){
          logAuthorityFailure(phase,"provider_identity","DESTINATION_VERSION_MISMATCH");
          fail();
        }
        // Keeping the current head forever must stay within Drive's 200 limit.
        if(replace && phase==="initial" && await metadata.countKeptRevisions(request.provider_identity.destination_file_id)>=200){
          logAuthorityFailure(phase,"provider_identity","REVISION_KEEP_LIMIT");
          fail();
        }
        // The level covers text files whose kept content can be reverted:
        // a text type, at most 1 MiB, with a sha256 to check a restore by.
        if(replace && phase==="initial"){
          const target=await metadata.getFile(request.provider_identity.destination_file_id);
          if(!/^(text\/[a-z0-9.+-]+|application\/(json|xml))$/.test(target?.mimeType??"") ||
            !/^[0-9a-f]{64}$/.test(target.sha256Checksum??"") || !/^(0|[1-9]\d{0,19})$/.test(target.size??"") ||
            Number(target.size)>1024*1024){
            logAuthorityFailure(phase,"provider_identity","REPLACE_TARGET_UNSUPPORTED");
            fail();
          }
        }
        return Object.freeze({...result.authority,workspace_version:"provider+canonical:"+hash([result.authority.workspace_version,request.provider_identity])});
      };
      let startedProvider=null, saved=null;
      const effectConfig={trusted_profile:profile,get_credential:credential,resolve_provider_identity:resolveProvider,
        fetch:driveFetch,clock,consume_started_provider:binding=>{
          const current=startedProvider;startedProvider=null;
          return current?.request_sha256===binding.request_sha256?current:null;
        },persist_provider_attempt:async attempt=>{
          const result=await invoke({action:"provider_attempt",attempt});
          if(result?.status!=="committed" || result.attempt_recorded!==true || !uuid(result.receipt_id) || !isDeepStrictEqual(result.attempt,attempt)) fail();
        }};
      // The replacement bytes are fixed before any reservation: the new text,
      // or a restored revision read back and checked against its pin.
      // Binary create: the staged object is read back, decrypted and checked against the job's
      // content reference before any reservation; a mismatch is refused with no effect.
      let staged;
      const binary=mutation.content_ref!==undefined;
      if(binary){
        try{
          staged=await loadStagedContent(Object.freeze({owner_id:descriptor.owner_id,connection_id:descriptor.connection_id,
            staging:structuredClone(descriptor.staging),content_ref:structuredClone(mutation.content_ref)}));
          // A bounded-memory source: one full streaming decrypt + sha256 pass here, before any
          // reservation or provider byte; the effect streams it again and re-checks the digest.
          if(!staged || typeof staged!=="object" || typeof staged.verify!=="function" || typeof staged.stream!=="function" ||
            staged.size!==mutation.content_ref.size || staged.sha256!==mutation.content_ref.sha256) throw new Error("mismatch");
          await staged.verify();
          if(!contentSourceShape(staged,mutation.content_ref)) throw new Error("mismatch");
        }catch{
          logDiagnostic("deny","STORAGE_CONTENT_STAGING_MISMATCH");
          return {status:"deny",error_code:"STORAGE_CONTENT_STAGING_MISMATCH",side_effects:0,execution_permitted:false};
        }
      }
      let replacement=null;
      if(replace && mutation.content!==undefined) replacement=new Uint8Array(Buffer.from(mutation.content,"utf8"));
      else if(replace){
        const restore=descriptor.restore;
        replacement=await metadata.downloadRevision(restore.provider_file_id,restore.revision_id,1024*1024);
        if(String(replacement.byteLength)!==restore.size || (restore.sha256!=null && sha256Hex(replacement)!==restore.sha256) ||
          (restore.md5!=null && md5Hex(replacement)!==restore.md5)) fail();
      }
      const effect=destructive ? createGoogleDriveNativeDestructiveEffect({...effectConfig,get_file:metadata.getFile,
          get_ownership:metadata.getOwnership,has_children:metadata.hasChildren})
        : replace ? createGoogleDriveNativeReplaceEffect({...effectConfig,get_file:metadata.getFile,get_revision:metadata.getRevision,replacement,
          release_revision_ids:descriptor.revision_releases})
        : modify ? createGoogleDriveNativeModifyEffect({...effectConfig,get_file:metadata.getFile})
        : createGoogleDriveNativeCreateEffect(binary ? {...effectConfig,content_source:staged} : effectConfig);
      const verifierConfig={managed_root:profile.managed_root,root_folder_id:descriptor.root_folder_id,
        root_parent_id:descriptor.root_parent_id,get_file:metadata.getFile,list_children:metadata.listChildren,
        include_verified_proof:verifiedResultMode,clock};
      const verify=destructive ? createGoogleDriveDestructivePostconditionVerifier({...verifierConfig,has_children:metadata.hasChildren})
        : replace ? createGoogleDriveReplacePostconditionVerifier({...verifierConfig,get_revision:metadata.getRevision})
        : modify ? createGoogleDriveModifyPostconditionVerifier(verifierConfig)
        : createGoogleDriveCreatePostconditionVerifier({...verifierConfig,require_effect_provider_id:true});
      const proofContract=destructive ? DESTRUCTIVE_PROOF_CONTRACTS[mutation.operation]
        : replace ? "clued.storage-replace-verified/1"
        : modify ? `clued.storage-${mutation.operation}-verified/1`
        : binary ? "clued.storage-create-verified/3" : "clued.storage-create-verified/2";
      const host=createResourceCenterOnlineToolHost({trusted_profile:profile,resolve_artifact_online:resolveAuthority,
        mutation_effect:effect,scan_boundary:scan,clock,qualified_operations:modify||replace||destructive?[mutation.operation]:["create"],
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
          let stage="reservation";
          try{
            if(!saved || saved.result.intent_id!==reservation.intent_id) fail();
            stage="verify";
            const verification=await verify({profile,mutation:input,provider_before:saved.provider,effect_result:result});
            stage="postcondition";
            const {verified_proof:proof,...postcondition}=verification;
            const finish={action:"finalize",intent_id:reservation.intent_id,base_version:saved.result.version,
              request_sha256:binding.request_sha256,idempotency_key:"account-job:"+ref.job_id+":finalize",postcondition};
            let finished;
            if(verifiedResultMode){
              stage="proof";
              if(proof?.contract!==proofContract) fail();
              stage="verified_record_rpc";
              const recorded=await invoke({action:"verified_record",finish,proof});
              stage="verified_record_result";
              if(recorded?.status!=="verified" || recorded.intent_id!==reservation.intent_id ||
                !uuid(recorded.verified_receipt_id) || !/^[0-9a-f]{64}$/.test(recorded.verified_digest??"") ||
                !Number.isSafeInteger(recorded.version) || recorded.execution_permitted!==false) fail();
              stage="settle_verified_rpc";
              finished=await invoke({action:"settle_verified",intent_id:reservation.intent_id,
                base_version:recorded.version,request_sha256:binding.request_sha256,
                verified_receipt_id:recorded.verified_receipt_id,verified_digest:recorded.verified_digest});
              stage="settle_verified_result";
            }else{
              stage="finalize_rpc";
              finished=await invoke({action:"finalize",...finish});
              stage="finalize_result";
            }
            if(finished?.status!=="committed" || finished.state!=="committed" || finished.intent_id!==reservation.intent_id ||
              finished.request_sha256!==binding.request_sha256 || finished.final_result?.status!=="committed" || !uuid(finished.receipt_id)) fail();
            return {status:"committed",receipt_id:finished.receipt_id,request_sha256:binding.request_sha256};
          }catch(error){
            logPostWriteFailure(stage,error);
            throw error;
          }
        }});
      // §3.4 item 6: a file someone else owns (or that Drive will not let this
      // account trash or untrash) is refused before any reservation, with its
      // own fixed reason. A lookup failure falls through: the authority below
      // resolves the same identity and fails closed.
      // Likewise, with fixed reasons the Agent can act on (Decision 7f9daf68):
      // an untrash whose name is taken in Drive (RESTORE_NAME_CONFLICT: ask
      // the user for another folder or a " (n)" name), and a directory that is
      // not empty, trashed children included (DIRECTORY_NOT_EMPTY).
      if(destructive){
        let refusal=null;
        try{
          const identity=await resolveProvider({profile,mutation});
          if(identity.source_file_id===mutation.source_file_id){
            if(!destructiveOwnershipAllowed(mutation.operation,await metadata.getOwnership(identity.source_file_id))) refusal="PROVIDER_OWNER_REQUIRED";
            else if(mutation.target_kind==="directory" && await metadata.hasChildren(identity.source_file_id)) refusal="DIRECTORY_NOT_EMPTY";
          }
        }catch(error){
          if(mutation.operation==="restore" && error?.message==="PROVIDER_DESTINATION_EXISTS") refusal="RESTORE_NAME_CONFLICT";
        }
        if(refusal){
          logDiagnostic("deny",refusal);
          return {status:"deny",error_code:refusal,side_effects:0,execution_permitted:false};
        }
      }
      const result=await host.callTool(RESOURCE_CENTER_MUTATION_TOOL,mutation);
      if(result.status==="unreconciled" || result.status==="deny") {
        // Keep the original journal fenced, but leave a stable diagnostic.
        logDiagnostic(result.status,result.error_code);
      }
      // Keep the internal admission, binding and provider result out of the
      // public job result. Recovery reads the original durable service state.
      return result.status==="committed" ? {status:"committed",job_id:ref.job_id,receipt_id:result.canonical_receipt_id,execution_permitted:false} :
        {status:result.status,error_code:result.error_code,side_effects:result.side_effects,execution_permitted:false};
    }catch(error){
      const code=unavailableCode(error);
      logDiagnostic("unavailable",code);
      return code==="UNSPECIFIED" ? unavailable() : {...unavailable(),error_code:code};
    }
  }});
}
