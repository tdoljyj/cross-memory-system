// Protected installed consumer only. App/name/external_id are correlation, never authority.
import {consumeInstalledControlCheck,consumeInstalledControlHead,takeActualControlConsumption,REPO} from './publisher.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function readIndependentControlCheck(selector){
 const result=await consumeInstalledControlCheck(selector);return takeActualControlConsumption(result,selector);
}
export async function readIndependentControlChecksOnHead({repository,headSha,name}){
 const result=await consumeInstalledControlHead({repository,headSha,name});
 const selector={repository:result?.subject?.repo,pr:result?.subject?.pr,headSha:result?.subject?.headSha,baseSha:result?.subject?.baseSha,name:result?.definition?.name};
 return [takeActualControlConsumption(result,selector).check];
}
export async function consumeIndependentGate({repository,pr,headSha,baseSha}){
 if(repository!==REPO)fail('FIXED_CONTROL_REPOSITORY_REQUIRED');
 const selector={repository,pr,headSha,baseSha,name:'kooyumi-admission-verified'};
 const proof=await readIndependentControlCheck(selector);
 return Object.freeze({event:'independent-control',admitted:true,verdict:'ADMITTED',reasons:[],head_sha:headSha,base_sha:baseSha,pr_ref:`${repository}#${pr}`,execution_provider:'independent-control-checks-v1',source_observation:{contract:proof.contract,check_run_id:proof.check.id,job_id:proof.subject.id,claim_id:proof.subject.claimId,fence:proof.subject.fence,epoch:proof.subject.epoch,source_manifest_sha256:proof.subject.sourceManifestSha256,effect_key:proof.effectKey,binding_sha256:proof.bindingSha256,native_observation_sha256:proof.nativeObservationAfterSha256},qualification_issued:false,native_ticket_issued:false});
}
