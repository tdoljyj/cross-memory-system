// Offline preparation only. Reads immutable Git objects, never production,
// secrets, a database, workflow dispatch or an installed qualification store.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateRegistry,registryDigestOf,REGISTRY_CONTRACT_V2,REPOSITORY,REPOSITORY_ID,REQUIRED_CHECK_NAMES,safeRepoPath}
  from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.mjs';
import {gitObjectReader,gitBlobSha1} from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/build-registry.mjs';
import {TRUSTED_WORKFLOW_PATHS,trustedWorkflowSha256s} from '../../actions-hosted-migration/independent-ci-v1/worker/trusted-workflows.mjs';
import {canonicalJson} from '../src/canonical.mjs';

export const PLAN_CONTRACT='clued.ci-scan-start-cutover-policy-plan/1';
export const REGISTRY_PATH='work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.json';
const HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ROLES=['contract-placement','gitleaks','trivy'];
const GATES=['OWNER_AND_EXACT_SOURCE_ACCEPTANCE','ALL_THREE_NATIVE_ROLES_POLICY_ACCEPTANCE','QUALIFIED_CONSUMER_AND_HANDOVER_SEAM','NATIVE_ONLY_FIRST_REAL_PROOF',
  'DEDICATED_NEW_HEAD_NATIVE_HOLD','INSTALLED_ACCEPTED_SOURCE_EXACT_HEAD_HOLD_PROOF','ACTUAL_L1_L2_L3_L4_QUALIFICATION','COORDINATED_PROVIDER_AND_RELAY_ACTIVATION'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(ok,code)=>{if(!ok)fail(code);};
const plain=v=>v!==null&&Object.getPrototypeOf(v)===Object.prototype;
function exact(v,keys,code){
  need(plain(v),code);const d=Object.getOwnPropertyDescriptors(v);
  need(Reflect.ownKeys(d).length===keys.length&&keys.every(k=>d[k]&&'value'in d[k]&&d[k].enumerable),code);
}
const nativePath=p=>typeof p==='string'&&p.length<=500&&safeRepoPath(p)&&/^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/.test(p);
const clone=v=>JSON.parse(JSON.stringify(v));
function pinned(reader,commit,file){
  need(safeRepoPath(file),'CUTOVER_PIN_PATH_INVALID');const e=reader.entry(commit,file);
  need(e?.type==='blob'&&['100644','100755'].includes(e.mode),'CUTOVER_REGULAR_GIT_BLOB_REQUIRED');
  const bytes=reader.blob(e.sha);need(gitBlobSha1(bytes)===e.sha,'CUTOVER_GIT_BLOB_MISMATCH');
  return {pin:{path:file,mode:e.mode,blob:e.sha,sha256:sha(bytes)},bytes};
}
function absent(reader,commit,file){
  need(reader.entry(commit,file)===null,'CUTOVER_REQUIRED_ABSENCE_CHANGED');
  const parts=file.split('/');for(let n=1;n<parts.length;n++){
    const parent=reader.entry(commit,parts.slice(0,n).join('/'));
    need(parent===null||parent.type==='tree'&&parent.mode==='040000','CUTOVER_ABSENCE_ANCESTOR_NOT_DIRECTORY');
  }
}
function rolesValid(roles,hostedEnabled){
  exact(roles,ROLES,'CUTOVER_THREE_ROLES_REQUIRED');
  for(const role of ROLES){
    const r=roles[role];exact(r,['workflow_path','workflow_blob','workflow_sha256','check_name','hosted_allowed','closure','must_not_exist','forbidden_change_prefixes'],'CUTOVER_ROLE_SHAPE');
    need(r.workflow_path===TRUSTED_WORKFLOW_PATHS[role]&&HEX40.test(r.workflow_blob)&&HEX64.test(r.workflow_sha256),'CUTOVER_WORKFLOW_PIN');
    need(typeof r.hosted_allowed==='boolean'&&r.hosted_allowed===(hostedEnabled&&role!=='contract-placement'),'CUTOVER_NATIVE_ONLY_PLACEMENT');
    need(typeof r.check_name==='string'&&r.check_name.length>0&&r.check_name.length<=100&&!/[\x00-\x1f\x7f]/.test(r.check_name),'CUTOVER_CHECK_NAME');
    need(role==='contract-placement'?r.check_name===role:!REQUIRED_CHECK_NAMES.includes(r.check_name),'CUTOVER_HOSTED_NAME_IS_REQUIRED');
    need(Array.isArray(r.closure)&&r.closure.length>0&&r.closure.length<=64,'CUTOVER_CLOSURE_REQUIRED');
    const paths=new Set();for(const p of r.closure){
      exact(p,['path','mode','blob','sha256'],'CUTOVER_CLOSURE_PIN_SHAPE');
      need(nativePath(p.path)&&!paths.has(p.path)&&['100644','100755'].includes(p.mode)&&HEX40.test(p.blob)&&HEX64.test(p.sha256),'CUTOVER_CLOSURE_PIN');paths.add(p.path);
    }
    const w=r.closure.find(p=>p.path===r.workflow_path);
    need(w?.mode==='100644'&&w.blob===r.workflow_blob&&w.sha256===r.workflow_sha256,'CUTOVER_WORKFLOW_NOT_IN_CLOSURE');
    need(Array.isArray(r.must_not_exist)&&r.must_not_exist.length<=64&&new Set(r.must_not_exist).size===r.must_not_exist.length
      &&r.must_not_exist.every(p=>nativePath(p)&&!paths.has(p)),'CUTOVER_ABSENCE_SHAPE');
    need(Array.isArray(r.forbidden_change_prefixes)&&r.forbidden_change_prefixes.length<=64&&new Set(r.forbidden_change_prefixes).size===r.forbidden_change_prefixes.length
      &&r.forbidden_change_prefixes.every(p=>typeof p==='string'&&p.length<=500&&p.endsWith('/')&&nativePath(p.slice(0,-1))),'CUTOVER_PREFIX_SHAPE');
  }
}

export function validateCutoverPolicyPlan(plan){
  exact(plan,['contract','state','installability','liveQualified','accepted','activated','frozenSource','policy','hostedQualificationPolicy','allHeadsPolicy','qualificationSubject','bindingAuthority','missingExactInputs','remainingGates','cutover','credentialHandling','qualificationNotice','draftSha256'],'CUTOVER_PLAN_SHAPE');
  need(plan.contract===PLAN_CONTRACT&&plan.state==='DRAFT_NOT_ACCEPTED_NOT_ACTIVATED'&&plan.installability==='NOT_INSTALLABLE'
    &&plan.liveQualified===false&&plan.accepted===false&&plan.activated===false,'CUTOVER_DRAFT_ONLY');
  exact(plan.frozenSource,['commit','tree','registryPath','registryBlob','registryRawSha256','registryStructuralDigestForAuditOnly','workflowFreezeCommit','workflowFreezeTree',
    'hostedClosuresVerifiedAgainstBothCommits','sourceHashInputIsNotQualification'],'CUTOVER_FROZEN_SOURCE_SHAPE');
  const f=plan.frozenSource;need([f.commit,f.tree,f.registryBlob,f.workflowFreezeCommit,f.workflowFreezeTree].every(v=>typeof v==='string'&&HEX40.test(v))
    &&f.registryPath===REGISTRY_PATH&&HEX64.test(f.registryRawSha256)&&HEX64.test(f.registryStructuralDigestForAuditOnly)
    &&f.hostedClosuresVerifiedAgainstBothCommits===true&&f.sourceHashInputIsNotQualification===true,'CUTOVER_FROZEN_SOURCE_BINDING');
  const policyFields=['repository_id','repository_owner_id','repository','user_id','project_id','scope','source_manifest_sha256','registry_sha256','roles','hosted_head_sha','activated_at','disabled_at'];
  exact(plan.policy,policyFields,'CUTOVER_POLICY_SHAPE');
  const p=plan.policy;need(p.repository===REPOSITORY&&p.repository_id===REPOSITORY_ID&&p.activated_at===null&&p.disabled_at===null,'CUTOVER_POLICY_INACTIVE');
  need(p.repository_owner_id===null||Number.isSafeInteger(p.repository_owner_id)&&p.repository_owner_id>0,'CUTOVER_OWNER_ID');
  need(p.user_id===null||UUID.test(p.user_id),'CUTOVER_OWNER_USER_ID');need(p.project_id===null||UUID.test(p.project_id),'CUTOVER_PROJECT_ID');
  need(p.scope===(p.project_id===null?null:'project:'+p.project_id),'CUTOVER_SCOPE');
  need(p.source_manifest_sha256===null||HEX64.test(p.source_manifest_sha256),'CUTOVER_SOURCE_SHA');
  need(HEX64.test(p.registry_sha256)&&p.registry_sha256===plan.frozenSource.registryRawSha256,'CUTOVER_RAW_REGISTRY_SHA_MISMATCH');
  rolesValid(p.roles,false);
  exact(plan.qualificationSubject,['headSha','holdEvidenceSha256','liveHoldVerified'],'CUTOVER_QUALIFICATION_SUBJECT_SHAPE');
  const q=plan.qualificationSubject;
  need((q.headSha===null||typeof q.headSha==='string'&&HEX40.test(q.headSha))
    &&(q.holdEvidenceSha256===null||typeof q.holdEvidenceSha256==='string'&&HEX64.test(q.holdEvidenceSha256))
    &&q.liveHoldVerified===false,'CUTOVER_EXACT_HEAD_HOLD_BINDING');
  need(p.hosted_head_sha===null&&plan.allHeadsPolicy===null,'CUTOVER_NO_GLOBAL_HOSTED_QUALIFICATION');
  const normal=policy=>({...policy,hosted_head_sha:null,roles:Object.fromEntries(Object.entries(policy.roles).map(([role,r])=>[role,{...r,hosted_allowed:false}]))});
  if(q.headSha===null)need(plan.hostedQualificationPolicy===null,'CUTOVER_NO_GLOBAL_HOSTED_QUALIFICATION');
  else{
    exact(plan.hostedQualificationPolicy,policyFields,'CUTOVER_POLICY_SHAPE');rolesValid(plan.hostedQualificationPolicy.roles,true);
    need(plan.hostedQualificationPolicy.hosted_head_sha===q.headSha,'CUTOVER_NO_GLOBAL_HOSTED_QUALIFICATION');
    need(canonicalJson(normal(p))===canonicalJson(normal(plan.hostedQualificationPolicy)),'CUTOVER_PHASE_POLICY_DRIFT');
  }
  const missing=[];if(p.user_id===null)missing.push('owner_user_id');if(p.project_id===null)missing.push('project_id_and_scope');
  if(p.source_manifest_sha256===null)missing.push('accepted_source_manifest_sha256');if(p.repository_owner_id===null)missing.push('github_repository_owner_id');
  if(q.headSha===null)missing.push('installed_qualification_hold_head_sha');if(q.holdEvidenceSha256===null)missing.push('installed_qualification_hold_evidence_sha256');
  need(canonicalJson(plan.missingExactInputs)===canonicalJson(missing)&&canonicalJson(plan.remainingGates)===canonicalJson(GATES),'CUTOVER_UNMET_GATES');
  need(plan.bindingAuthority==='EXISTING_LIVE_QUALIFIED_INDEPENDENT_CONSUMER_ONLY','CUTOVER_BINDING_AUTHORITY');
  exact(plan.cutover,['nativeOnlyMustPassFirst','exactHeadQualificationHoldRequired','requiredOrdinaryHostedGlobalEnabled','requiredInitialRelayEnabled','observedLiveSwitches',
    'hostedGlobalWithRelayFalseForbidden','qualificationDispatchRestrictedToHeldNewHead','unknownOutcomeKeepsHold','ordinaryResumeOrSourceChangeCannotReleaseHold',
    'oldHeadsMayBeRescanned','resetMetersOrReleaseCaps','atomicKey','providerRunAttemptClaimOrSourceNeverCreateAnotherKey'],'CUTOVER_PROVIDER_GUARD');
  need(plan.cutover.nativeOnlyMustPassFirst===true&&plan.cutover.exactHeadQualificationHoldRequired===true
    &&plan.cutover.requiredOrdinaryHostedGlobalEnabled===false&&plan.cutover.requiredInitialRelayEnabled===false
    &&plan.cutover.hostedGlobalWithRelayFalseForbidden===true&&plan.cutover.oldHeadsMayBeRescanned===false
    &&plan.cutover.resetMetersOrReleaseCaps===false&&plan.cutover.observedLiveSwitches===null
    &&plan.cutover.qualificationDispatchRestrictedToHeldNewHead===true&&plan.cutover.unknownOutcomeKeepsHold===true
    &&plan.cutover.ordinaryResumeOrSourceChangeCannotReleaseHold===true&&plan.cutover.providerRunAttemptClaimOrSourceNeverCreateAnotherKey===true
    &&canonicalJson(plan.cutover.atomicKey)===canonicalJson(['repository_id','head_sha','role']),'CUTOVER_PROVIDER_GUARD');
  exact(plan.credentialHandling,['readSecrets','fetchCredentials','preserveProtectedOldCopies','deleteOldCredentials','preserveFailureAndCostEvidence'],'CUTOVER_CREDENTIAL_GUARD');
  need(plan.credentialHandling.readSecrets===false&&plan.credentialHandling.preserveProtectedOldCopies===true
    &&plan.credentialHandling.deleteOldCredentials===false&&plan.credentialHandling.fetchCredentials===false&&plan.credentialHandling.preserveFailureAndCostEvidence===true,'CUTOVER_CREDENTIAL_GUARD');
  const {draftSha256,...body}=plan;need(HEX64.test(draftSha256)&&draftSha256===sha(Buffer.from(canonicalJson(body))),'CUTOVER_DRAFT_DIGEST');return plan;
}

export function buildScanStartCutoverPlan(input){
  const allowed=['repoDir','frozenCommit','sourceManifestSha256','ownerUserId','projectId','expectedRawRegistrySha256','qualificationHeadSha','qualificationHoldEvidenceSha256'];
  need(plain(input)&&Object.keys(input).every(k=>allowed.includes(k)),'CUTOVER_INPUT_SHAPE');
  const {repoDir,frozenCommit,sourceManifestSha256=null,ownerUserId=null,projectId=null,expectedRawRegistrySha256=null,qualificationHeadSha=null,qualificationHoldEvidenceSha256=null}=input;
  need(typeof repoDir==='string'&&HEX40.test(frozenCommit??''),'CUTOVER_FIXED_GIT_COMMIT_REQUIRED');
  need(sourceManifestSha256===null||HEX64.test(sourceManifestSha256),'CUTOVER_SOURCE_SHA');
  need(ownerUserId===null||UUID.test(ownerUserId),'CUTOVER_OWNER_USER_ID');need(projectId===null||UUID.test(projectId),'CUTOVER_PROJECT_ID');
  need(expectedRawRegistrySha256===null||HEX64.test(expectedRawRegistrySha256),'CUTOVER_RAW_REGISTRY_SHA_REQUIRED');
  need(qualificationHeadSha===null||typeof qualificationHeadSha==='string'&&HEX40.test(qualificationHeadSha),'CUTOVER_QUALIFICATION_HEAD');
  need(qualificationHoldEvidenceSha256===null||typeof qualificationHoldEvidenceSha256==='string'&&HEX64.test(qualificationHoldEvidenceSha256),'CUTOVER_QUALIFICATION_HOLD_EVIDENCE');
  const reader=gitObjectReader(repoDir),frozen=reader.resolve(frozenCommit);need(frozen.commit===frozenCommit,'CUTOVER_FIXED_GIT_COMMIT_REQUIRED');
  const raw=pinned(reader,frozenCommit,REGISTRY_PATH);need(raw.bytes.length<=262144,'CUTOVER_REGISTRY_BOUND');
  const registry=validateRegistry(JSON.parse(raw.bytes.toString('utf8')),{domain:'production'});
  need(registry.contract===REGISTRY_CONTRACT_V2&&registry.requireCheckRunIdClaim===true,'CUTOVER_REGISTRY_V2_REQUIRED');
  const rawSha=sha(raw.bytes);need(expectedRawRegistrySha256===null||expectedRawRegistrySha256===rawSha,'CUTOVER_RAW_REGISTRY_SHA_MISMATCH');
  const workflowFreeze=reader.resolve(registry.sourceCommit);need(workflowFreeze.tree===registry.sourceTree,'CUTOVER_WORKFLOW_TREE_MISMATCH');
  const roles={};
  for(const role of ['gitleaks','trivy']){
    const r=registry.roles[role];need(r,'CUTOVER_HOSTED_ROLE_REQUIRED');
    for(const commit of new Set([frozenCommit,registry.sourceCommit])){
      for(const pin of r.closure){const actual=pinned(reader,commit,pin.path);need(canonicalJson(actual.pin)===canonicalJson(pin),'CUTOVER_FROZEN_CLOSURE_DRIFT');}
      for(const file of r.mustNotExist)absent(reader,commit,file);
    }
    roles[role]={workflow_path:r.workflowPath,workflow_blob:r.workflowBlob,workflow_sha256:r.workflowSha256,check_name:r.hostedCheckName,hosted_allowed:true,
      closure:clone(r.closure),must_not_exist:clone(r.mustNotExist),forbidden_change_prefixes:clone(r.forbiddenChangePrefixes)};
  }
  const cp=pinned(reader,frozenCommit,TRUSTED_WORKFLOW_PATHS['contract-placement']).pin;
  need(cp.mode==='100644'&&trustedWorkflowSha256s(cp.path).includes(cp.sha256),'CUTOVER_NATIVE_PLACEMENT_WORKFLOW_NOT_TRUSTED');
  roles['contract-placement']={workflow_path:cp.path,workflow_blob:cp.blob,workflow_sha256:cp.sha256,check_name:'contract-placement',hosted_allowed:false,
    closure:[cp],must_not_exist:[],forbidden_change_prefixes:clone(registry.forbiddenChangePrefixes)};
  const missingExactInputs=[];if(ownerUserId===null)missingExactInputs.push('owner_user_id');if(projectId===null)missingExactInputs.push('project_id_and_scope');
  if(sourceManifestSha256===null)missingExactInputs.push('accepted_source_manifest_sha256');if(registry.repositoryOwnerId===null)missingExactInputs.push('github_repository_owner_id');
  if(qualificationHeadSha===null)missingExactInputs.push('installed_qualification_hold_head_sha');
  if(qualificationHoldEvidenceSha256===null)missingExactInputs.push('installed_qualification_hold_evidence_sha256');
  const qualificationPolicy={repository_id:registry.repositoryId,repository_owner_id:registry.repositoryOwnerId,repository:registry.repository,user_id:ownerUserId,project_id:projectId,
    scope:projectId===null?null:'project:'+projectId,source_manifest_sha256:sourceManifestSha256,registry_sha256:rawSha,roles,hosted_head_sha:qualificationHeadSha,activated_at:null,disabled_at:null};
  const nativeOnlyPolicy={...clone(qualificationPolicy),hosted_head_sha:null};
  for(const role of Object.values(nativeOnlyPolicy.roles))role.hosted_allowed=false;
  const body={contract:PLAN_CONTRACT,state:'DRAFT_NOT_ACCEPTED_NOT_ACTIVATED',installability:'NOT_INSTALLABLE',liveQualified:false,accepted:false,activated:false,
    frozenSource:{commit:frozen.commit,tree:frozen.tree,registryPath:REGISTRY_PATH,registryBlob:raw.pin.blob,registryRawSha256:rawSha,
      registryStructuralDigestForAuditOnly:registryDigestOf(registry),workflowFreezeCommit:registry.sourceCommit,workflowFreezeTree:registry.sourceTree,
      hostedClosuresVerifiedAgainstBothCommits:true,sourceHashInputIsNotQualification:true},
    policy:nativeOnlyPolicy,hostedQualificationPolicy:qualificationHeadSha===null?null:qualificationPolicy,allHeadsPolicy:null,
    qualificationSubject:{headSha:qualificationHeadSha,holdEvidenceSha256:qualificationHoldEvidenceSha256,liveHoldVerified:false},
    bindingAuthority:'EXISTING_LIVE_QUALIFIED_INDEPENDENT_CONSUMER_ONLY',missingExactInputs,
    remainingGates:[...GATES],
    cutover:{nativeOnlyMustPassFirst:true,exactHeadQualificationHoldRequired:true,requiredOrdinaryHostedGlobalEnabled:false,requiredInitialRelayEnabled:false,
      observedLiveSwitches:null,hostedGlobalWithRelayFalseForbidden:true,qualificationDispatchRestrictedToHeldNewHead:true,
      unknownOutcomeKeepsHold:true,ordinaryResumeOrSourceChangeCannotReleaseHold:true,oldHeadsMayBeRescanned:false,resetMetersOrReleaseCaps:false,
      atomicKey:['repository_id','head_sha','role'],providerRunAttemptClaimOrSourceNeverCreateAnotherKey:true},
    credentialHandling:{readSecrets:false,fetchCredentials:false,preserveProtectedOldCopies:true,deleteOldCredentials:false,preserveFailureAndCostEvidence:true},
    qualificationNotice:'Git pins and caller-supplied identity/hash inputs are draft bindings only. No Owner acceptance, install qualification, L1-L4 proof, provider switch or production effect is granted.'};
  const plan={...body,draftSha256:sha(Buffer.from(canonicalJson(body)))};validateCutoverPolicyPlan(plan);return plan;
}
export const serializeCutoverPolicyPlan=plan=>{validateCutoverPolicyPlan(plan);return JSON.stringify(plan,null,2)+'\n';};

export function main(argv=process.argv.slice(2),out=process.stdout){
  const flags={'--repo':'repoDir','--commit':'frozenCommit','--source-manifest-sha256':'sourceManifestSha256','--owner-user-id':'ownerUserId','--project-id':'projectId','--expected-registry-sha256':'expectedRawRegistrySha256',
    '--qualification-head-sha':'qualificationHeadSha','--qualification-hold-evidence-sha256':'qualificationHoldEvidenceSha256'};
  try{const input={};let destination=null;for(let n=0;n<argv.length;n++){
    const flag=argv[n],value=argv[++n];need(value!==undefined,'CUTOVER_ARGUMENTS_REQUIRED');
    if(flag==='--out'){need(destination===null,'CUTOVER_DUPLICATE_ARGUMENT');destination=value;}else{need(Object.hasOwn(flags,flag)&&!Object.hasOwn(input,flags[flag]),'CUTOVER_ARGUMENTS_REQUIRED');input[flags[flag]]=value;}
  }
  const plan=buildScanStartCutoverPlan(input),bytes=serializeCutoverPolicyPlan(plan);if(destination)fs.writeFileSync(destination,bytes,{flag:'wx'});else out.write(bytes);
  return 0;}catch(e){out.write(JSON.stringify({state:'REFUSED',error_code:/^CUTOVER_|^RELAY_/.test(e?.code??'')?e.code:'CUTOVER_BUILD_REFUSED'})+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=main();
