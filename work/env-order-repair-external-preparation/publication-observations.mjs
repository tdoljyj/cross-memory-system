// Actual immutable publication guard observation, not a synthetic API response.
import crypto from 'node:crypto';
import {moduleAt,successor} from './dependencies.mjs';
const {api}=await moduleAt('scripts/phase2-qualification/control-context-verifier-runtime600/trusted-github.mjs');
const {verifySourcePublication}=await moduleAt(successor+'source-publication.mjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export function observeActualPublicationDenial({sourceRef,ownerMerge,controllerDigest}){
 const baseline=verifySourcePublication({sourceRef,ownerMerge,controllerDigest});
 if(baseline.state!=='ACTUAL_FIXED_SOURCE_PUBLICATION_VERIFIED')throw Error('ACTUAL_SUCCESSFUL_PUBLICATION_BASELINE_REQUIRED');
 const current=api('repos/tdoljyj/cross-memory-system/commits/'+sourceRef.commit),parent=current.parents?.[0]?.sha;
 if(current.sha!==sourceRef.commit||!/^[a-f0-9]{40}$/.test(parent)||parent===sourceRef.commit)throw Error('ACTUAL_DISTINCT_PUBLICATION_PARENT_REQUIRED');
 const started=process.hrtime.bigint(),observed_at=new Date().toISOString();let error=null,returned=null;
 try{returned=verifySourcePublication({sourceRef,ownerMerge:parent,controllerDigest});}catch(failure){error={name:failure.name,message:failure.message};}
 const value={kind:'ACTUAL_PUBLICATION_REVISION_GUARD_OBSERVATION',test_id:'PQUAL-12',observed_at,baseline,
  original_source_ref:sourceRef,original_owner_merge:ownerMerge,actual_parent_mutation:parent,controller_digest:controllerDigest,
  mutation_origin:{kind:'ACTUAL_SOURCE_PUBLICATION_FIRST_PARENT',source_commit:sourceRef.commit,api_path:'repos/tdoljyj/cross-memory-system/commits/'+sourceRef.commit,returned_commit_sha:current.sha,parent_shas:current.parents.map(p=>p.sha)},
  elapsed_nanoseconds:(process.hrtime.bigint()-started).toString(),error,returned,authority_effect:'NONE',
  boundary:'Actual fixed GitHub source/publication code was called after an actual successful baseline. No GA/source bytes were modified or re-signed and no host effect occurred.',complete_case_pass:false};
 const raw=JSON.stringify(value)+'\n';return {raw,sha256:sha(raw),denied:error!==null,complete_case_pass:false};
}
