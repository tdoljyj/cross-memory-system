import crypto from 'node:crypto';
import {api,readBlobRef} from '../control-context-verifier-next-window-successor/trusted-github.mjs';
import {decodeOriginalInputs as decodeLegacy} from '../scenario-observations/request-denials-packed.mjs';
import {decodeOriginalInputs as decodePriorBlob} from '../control-context-verifier-evidence-blob-successor/original-inputs-blob.mjs';
// Original V2 implementation below retains its exact body except module export keywords.
const v2=(()=>{
// Explicit 2 MiB logical Evidence successor. Original five raw fields are unchanged; legacy 1 MiB formats retain their original decoders.
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),raw=x=>JSON.stringify(x)+'\n',need=(v,m)=>{if(!v)throw Error(m);};
const kind='EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V2_2MIB';
const repository='tdoljyj/cross-memory-system',branch='codex/phase2-qualification-evidence-20260908';
const pathPrefix='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/';
const originalPrefix='urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:';
const sessions=new WeakMap();
function beginOriginalInputVerification(){const session=Object.freeze({});sessions.set(session,new Map());return session;}
function checkEnvelope(packedRaw,originalRef){
 need(typeof packedRaw==='string'&&Buffer.byteLength(packedRaw)<=4096,'BOUNDED_BLOB_ENVELOPE');const e=JSON.parse(packedRaw);
 need(raw(e)===packedRaw&&Object.keys(e).sort().join(',')==='blob_ref,kind,original_bytes,original_ref,publication','EXACT_BLOB_ENVELOPE_SCHEMA');
 need(e.kind===kind&&raw(e.original_ref)===raw(originalRef)&&Object.keys(originalRef).sort().join(',')==='sha256,uri'&&/^[a-f0-9]{64}$/.test(originalRef.sha256)&&originalRef.uri===originalPrefix+originalRef.sha256,'EXACT_ORIGINAL_INPUT_REFERENCE');
 need(Number.isSafeInteger(e.original_bytes)&&e.original_bytes>0&&e.original_bytes<=2097152,'EXPLICIT_ORIGINAL_TWO_MIB_SUCCESSOR_LIMIT');
 need(Object.keys(e.blob_ref).sort().join(',')==='sha256,uri'&&/^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[a-f0-9]{40}$/.test(e.blob_ref.uri)&&e.blob_ref.sha256===originalRef.sha256,'FIXED_SAME_REPOSITORY_BLOB');
 const p=e.publication;need(p&&Object.keys(p).sort().join(',')==='artifact_path,branch,commit_sha,ga_id'&&p.branch===branch&&/^[a-f0-9]{40}$/.test(p.commit_sha)&&/^ga_[a-f0-9]{32}$/.test(p.ga_id),'FIXED_IMMUTABLE_PUBLICATION');
 need(p.artifact_path===pathPrefix+'original-inputs-'+p.ga_id.slice(3)+'/result.json','ONE_FIXED_THIS_GA_EVIDENCE_PATH');return e;
}
function checkRestoredOriginal(text,e){
 need(typeof text==='string'&&Buffer.byteLength(text)===e.original_bytes&&sha(text)===e.original_ref.sha256,'EXACT_FULL_ORIGINAL_BYTES');
 const v=JSON.parse(text);need(raw(v)===text&&Object.keys(v).sort().join(',')==='ga_raw,kind,observation_raw,qualification_raw,runtime_acceptance_raw'&&v.kind==='ACTUAL_VERIFIER_ORIGINAL_INPUTS','ORIGINAL_INPUT_ENCODING_UNCHANGED');
 need(JSON.parse(v.ga_raw).gate_authorization_id===e.publication.ga_id,'ORIGINAL_INPUT_THIS_PUBLICATION_GA');return v;
}
function decodeOriginalInputs(packedRaw,originalRef,verificationSession){
 if(JSON.parse(packedRaw).kind==='EXACT_ORIGINAL_VERIFIER_INPUTS_DEFLATE_V1')return decodeLegacy(packedRaw,originalRef);
 if(JSON.parse(packedRaw).kind==='EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V1')return decodePriorBlob(packedRaw,originalRef);
 const e=checkEnvelope(packedRaw,originalRef),key=packedRaw+'\0'+raw(originalRef);
 const cache=verificationSession===undefined?null:sessions.get(verificationSession);need(verificationSession===undefined||cache,'EXACT_LOCAL_VERIFICATION_SESSION');
 if(cache?.has(key))return cache.get(key);
 const repo=api('repos/'+repository);need(repo.full_name===repository&&repo.private===true,'ACTUAL_PRIVATE_EVIDENCE_REPOSITORY');
 const commit=api('repos/'+repository+'/git/commits/'+e.publication.commit_sha);need(commit.sha===e.publication.commit_sha&&/^[a-f0-9]{40}$/.test(commit.tree?.sha),'ACTUAL_IMMUTABLE_COMMIT_TREE');
 const tree=api('repos/'+repository+'/git/trees/'+commit.tree.sha+'?recursive=1');need(tree.sha===commit.tree.sha&&tree.truncated===false&&Array.isArray(tree.tree),'COMPLETE_IMMUTABLE_EVIDENCE_TREE');
 const found=tree.tree.filter(x=>x.path===e.publication.artifact_path);need(found.length===1&&found[0].mode==='100644'&&found[0].type==='blob'&&found[0].sha===e.blob_ref.uri.split('/').at(-1)&&found[0].size===e.original_bytes,'EXACT_COMMIT_PATH_BLOB_SIZE');
 const original=Object.freeze(checkRestoredOriginal(readBlobRef(e.blob_ref),e));cache?.set(key,original);return original;
}
function envelopeFromPublication(originalArtifact,publication,blobRef){
 const packed=raw({kind,original_ref:{uri:originalArtifact.uri,sha256:originalArtifact.sha256},original_bytes:Buffer.byteLength(originalArtifact.raw),blob_ref:blobRef,publication});
 const e=checkEnvelope(packed,{uri:originalArtifact.uri,sha256:originalArtifact.sha256});checkRestoredOriginal(originalArtifact.raw,e);
 // Envelope preparation is data only. The consuming terminal always performs
 // the fixed actual Git commit/tree/blob read above; this helper grants nothing.
 return {uri:originalPrefix+sha(packed),sha256:sha(packed),raw:packed};
}
function validatePackedDenialSource({packedRaw,sourceRaw,verificationSession}){
 const source=JSON.parse(sourceRaw);need(raw(source)===sourceRaw&&source.kind==='ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION','EXACT_ACTUAL_DENIAL_SOURCE');
 const original=decodeOriginalInputs(packedRaw,source.original_inputs_ref,verificationSession);
 let reconstructed={ga:JSON.parse(original.ga_raw),operation:'CREATE',runtimeAcceptance:JSON.parse(original.runtime_acceptance_raw),qualification:JSON.parse(original.qualification_raw)};
 need(Array.isArray(source.fault_input_changes)&&source.fault_input_changes.length>0,'ACTUAL_FAULT_CHANGES_REQUIRED');
 for(const change of source.fault_input_changes){
  need(['remove','add','replace'].includes(change.op)&&typeof change.path==='string','FIXED_DELTA_ENCODING');
  if(change.path===''){need(change.op==='replace','FIXED_ROOT_REPLACEMENT');reconstructed=structuredClone(change.value);continue;}
  need(change.path.startsWith('/'),'ABSOLUTE_JSON_POINTER');
  const keys=change.path.slice(1).split('/').map(key=>key.replaceAll('~1','/').replaceAll('~0','~'));
  need(keys.every(key=>!['__proto__','constructor','prototype'].includes(key)),'NO_PROTOTYPE_PATH');
  let parent=reconstructed;for(const key of keys.slice(0,-1)){need(parent&&Object.hasOwn(parent,key),'EXISTING_DELTA_PARENT');parent=parent[key];}
  if(change.op==='remove'){need(Object.hasOwn(parent,keys.at(-1)),'EXISTING_REMOVAL');delete parent[keys.at(-1)];}
  else parent[keys.at(-1)]=structuredClone(change.value);
 }
 need(reconstructed&&Object.keys(reconstructed).sort().join(',')==='ga,operation,qualification,runtimeAcceptance'&&['CREATE','MODEL'].includes(reconstructed.operation),'EXACT_CALLED_ARGUMENT_BOUNDARY');
 const compactGa=raw(reconstructed.ga);
 const originalGaMatches=compactGa===raw(JSON.parse(original.ga_raw))&&sha(original.ga_raw)===source.called_input_digests?.ga_raw;
 const digests={ga_raw:sha(originalGaMatches?original.ga_raw:compactGa),runtime_acceptance_raw:sha(raw(reconstructed.runtimeAcceptance)),qualification_raw:sha(raw(reconstructed.qualification))};
 need(raw(digests)===raw(source.called_input_digests)&&source.actual_entry==='control-context-verifier-ordinary-bounded-acyclic-successor/context.mjs#checkCurrentSemantics','EXACT_ACTUALLY_CALLED_INPUTS');
 need(source.actual_current_observation_sha256===sha(original.observation_raw)&&source.baseline_ga_sha256===sha(original.ga_raw),'EXACT_ACTUAL_BASELINE_BINDING');
 return {state:'ORIGINAL_MEASURED_INPUT_BYTES_RESTORED',test_id:source.test_id,operation:reconstructed.operation,oracle_pass_claimed:false};
}

return {kind,repository,branch,pathPrefix,beginOriginalInputVerification,checkEnvelope,checkRestoredOriginal,decodeOriginalInputs,envelopeFromPublication,validatePackedDenialSource};
})();

// Separate candidate V3 implementation; no old decoder cap changes.
const v3=(()=>{
// Explicit 2 MiB logical Evidence successor. Original five raw fields are unchanged; legacy 1 MiB formats retain their original decoders.
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),raw=x=>JSON.stringify(x)+'\n',need=(v,m)=>{if(!v)throw Error(m);};
const kind='EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V6_4000000';
const repository='tdoljyj/cross-memory-system',branch='codex/phase2-qualification-evidence-20260908';
const pathPrefix='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/';
const originalPrefix='urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:';
const sessions=new WeakMap();
function beginOriginalInputVerification(){const session=Object.freeze({});sessions.set(session,new Map());return session;}
function checkEnvelope(packedRaw,originalRef){
 need(typeof packedRaw==='string'&&Buffer.byteLength(packedRaw)<=4096,'BOUNDED_BLOB_ENVELOPE');const e=JSON.parse(packedRaw);
 need(raw(e)===packedRaw&&Object.keys(e).sort().join(',')==='blob_ref,kind,original_bytes,original_ref,publication','EXACT_BLOB_ENVELOPE_SCHEMA');
 need(e.kind===kind&&raw(e.original_ref)===raw(originalRef)&&Object.keys(originalRef).sort().join(',')==='sha256,uri'&&/^[a-f0-9]{64}$/.test(originalRef.sha256)&&originalRef.uri===originalPrefix+originalRef.sha256,'EXACT_ORIGINAL_INPUT_REFERENCE');
 need(Number.isSafeInteger(e.original_bytes)&&e.original_bytes>0&&e.original_bytes<=4000000,'EXPLICIT_ORIGINAL_V6_FINITE_CANDIDATE_LIMIT');
 need(Object.keys(e.blob_ref).sort().join(',')==='sha256,uri'&&/^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[a-f0-9]{40}$/.test(e.blob_ref.uri)&&e.blob_ref.sha256===originalRef.sha256,'FIXED_SAME_REPOSITORY_BLOB');
 const p=e.publication;need(p&&Object.keys(p).sort().join(',')==='artifact_path,branch,commit_sha,ga_id'&&p.branch===branch&&/^[a-f0-9]{40}$/.test(p.commit_sha)&&/^ga_[a-f0-9]{32}$/.test(p.ga_id),'FIXED_IMMUTABLE_PUBLICATION');
 need(p.artifact_path===pathPrefix+'original-inputs-'+p.ga_id.slice(3)+'/result.json','ONE_FIXED_THIS_GA_EVIDENCE_PATH');return e;
}
function checkRestoredOriginal(text,e){
 need(typeof text==='string'&&Buffer.byteLength(text)===e.original_bytes&&sha(text)===e.original_ref.sha256,'EXACT_FULL_ORIGINAL_BYTES');
 need(Buffer.from(text,'utf8').toString('utf8')===text,'EXACT_ORIGINAL_UTF8');
 const v=JSON.parse(text);need(raw(v)===text&&Object.keys(v).sort().join(',')==='ga_raw,kind,observation_raw,qualification_raw,runtime_acceptance_raw'&&v.kind==='ACTUAL_VERIFIER_ORIGINAL_INPUTS'&&['ga_raw','observation_raw','qualification_raw','runtime_acceptance_raw'].every(k=>typeof v[k]==='string'),'ORIGINAL_INPUT_ENCODING_UNCHANGED');
 need(JSON.parse(v.ga_raw).gate_authorization_id===e.publication.ga_id,'ORIGINAL_INPUT_THIS_PUBLICATION_GA');return v;
}
function decodeOriginalInputs(packedRaw,originalRef,verificationSession){
 if(JSON.parse(packedRaw).kind==='EXACT_ORIGINAL_VERIFIER_INPUTS_DEFLATE_V1')return decodeLegacy(packedRaw,originalRef);
 if(JSON.parse(packedRaw).kind==='EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V1')return decodePriorBlob(packedRaw,originalRef);
 const e=checkEnvelope(packedRaw,originalRef),key=packedRaw+'\0'+raw(originalRef);
 const cache=verificationSession===undefined?null:sessions.get(verificationSession);need(verificationSession===undefined||cache,'EXACT_LOCAL_VERIFICATION_SESSION');
 if(cache?.has(key))return cache.get(key);
 const repo=api('repos/'+repository);need(repo.full_name===repository&&repo.private===true,'ACTUAL_PRIVATE_EVIDENCE_REPOSITORY');
 const commit=api('repos/'+repository+'/git/commits/'+e.publication.commit_sha);need(commit.sha===e.publication.commit_sha&&/^[a-f0-9]{40}$/.test(commit.tree?.sha),'ACTUAL_IMMUTABLE_COMMIT_TREE');
 const tree=api('repos/'+repository+'/git/trees/'+commit.tree.sha+'?recursive=1');need(tree.sha===commit.tree.sha&&tree.truncated===false&&Array.isArray(tree.tree),'COMPLETE_IMMUTABLE_EVIDENCE_TREE');
 const found=tree.tree.filter(x=>x.path===e.publication.artifact_path);need(found.length===1&&found[0].mode==='100644'&&found[0].type==='blob'&&found[0].sha===e.blob_ref.uri.split('/').at(-1)&&found[0].size===e.original_bytes,'EXACT_COMMIT_PATH_BLOB_SIZE');
 const original=Object.freeze(checkRestoredOriginal(readBlobRef(e.blob_ref),e));cache?.set(key,original);return original;
}
function envelopeFromPublication(originalArtifact,publication,blobRef){
 const packed=raw({kind,original_ref:{uri:originalArtifact.uri,sha256:originalArtifact.sha256},original_bytes:Buffer.byteLength(originalArtifact.raw),blob_ref:blobRef,publication});
 const e=checkEnvelope(packed,{uri:originalArtifact.uri,sha256:originalArtifact.sha256});checkRestoredOriginal(originalArtifact.raw,e);
 // Envelope preparation is data only. The consuming terminal always performs
 // the fixed actual Git commit/tree/blob read above; this helper grants nothing.
 return {uri:originalPrefix+sha(packed),sha256:sha(packed),raw:packed};
}
function validatePackedDenialSource({packedRaw,sourceRaw,verificationSession}){
 const source=JSON.parse(sourceRaw);need(raw(source)===sourceRaw&&source.kind==='ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION','EXACT_ACTUAL_DENIAL_SOURCE');
 const original=decodeOriginalInputs(packedRaw,source.original_inputs_ref,verificationSession);
 let reconstructed={ga:JSON.parse(original.ga_raw),operation:'CREATE',runtimeAcceptance:JSON.parse(original.runtime_acceptance_raw),qualification:JSON.parse(original.qualification_raw)};
 need(Array.isArray(source.fault_input_changes)&&source.fault_input_changes.length>0,'ACTUAL_FAULT_CHANGES_REQUIRED');
 for(const change of source.fault_input_changes){
  need(['remove','add','replace'].includes(change.op)&&typeof change.path==='string','FIXED_DELTA_ENCODING');
  if(change.path===''){need(change.op==='replace','FIXED_ROOT_REPLACEMENT');reconstructed=structuredClone(change.value);continue;}
  need(change.path.startsWith('/'),'ABSOLUTE_JSON_POINTER');
  const keys=change.path.slice(1).split('/').map(key=>key.replaceAll('~1','/').replaceAll('~0','~'));
  need(keys.every(key=>!['__proto__','constructor','prototype'].includes(key)),'NO_PROTOTYPE_PATH');
  let parent=reconstructed;for(const key of keys.slice(0,-1)){need(parent&&Object.hasOwn(parent,key),'EXISTING_DELTA_PARENT');parent=parent[key];}
  if(change.op==='remove'){need(Object.hasOwn(parent,keys.at(-1)),'EXISTING_REMOVAL');delete parent[keys.at(-1)];}
  else parent[keys.at(-1)]=structuredClone(change.value);
 }
 need(reconstructed&&Object.keys(reconstructed).sort().join(',')==='ga,operation,qualification,runtimeAcceptance'&&['CREATE','MODEL'].includes(reconstructed.operation),'EXACT_CALLED_ARGUMENT_BOUNDARY');
 const compactGa=raw(reconstructed.ga);
 const originalGaMatches=compactGa===raw(JSON.parse(original.ga_raw))&&sha(original.ga_raw)===source.called_input_digests?.ga_raw;
 const digests={ga_raw:sha(originalGaMatches?original.ga_raw:compactGa),runtime_acceptance_raw:sha(raw(reconstructed.runtimeAcceptance)),qualification_raw:sha(raw(reconstructed.qualification))};
 need(raw(digests)===raw(source.called_input_digests)&&source.actual_entry==='control-context-verifier-root5-final-successor/context.mjs#checkCurrentSemantics','EXACT_ACTUALLY_CALLED_INPUTS');
 need(source.actual_current_observation_sha256===sha(original.observation_raw)&&source.baseline_ga_sha256===sha(original.ga_raw),'EXACT_ACTUAL_BASELINE_BINDING');
 return {state:'ORIGINAL_MEASURED_INPUT_BYTES_RESTORED',test_id:source.test_id,operation:reconstructed.operation,oracle_pass_claimed:false};
}

return {kind,repository,branch,pathPrefix,beginOriginalInputVerification,checkEnvelope,checkRestoredOriginal,decodeOriginalInputs,envelopeFromPublication,validatePackedDenialSource};
})();

export const kind=v3.kind,repository=v3.repository,branch=v3.branch,pathPrefix=v3.pathPrefix,maximumOriginalBytes=4000000;
const dualSessions=new WeakMap();
export function beginOriginalInputVerification(){const x=Object.freeze({});dualSessions.set(x,{v2:v2.beginOriginalInputVerification(),v3:v3.beginOriginalInputVerification()});return x;}
function choose(raw){return JSON.parse(raw).kind===kind?'v3':'v2';}
function session(x,k){if(x===undefined)return undefined;const found=dualSessions.get(x);if(!found)throw Error('EXACT_LOCAL_VERIFICATION_SESSION');return found[k];}
export function checkEnvelope(raw,ref){return ({v2,v3})[choose(raw)].checkEnvelope(raw,ref);}
export function checkRestoredOriginal(raw,envelope){return (envelope.kind===kind?v3:v2).checkRestoredOriginal(raw,envelope);}
export function decodeOriginalInputs(raw,ref,x){const k=choose(raw);return ({v2,v3})[k].decodeOriginalInputs(raw,ref,session(x,k));}
export function envelopeFromPublication(...args){return v3.envelopeFromPublication(...args);}
export function validatePackedDenialSource({packedRaw,sourceRaw,verificationSession}){const k=choose(packedRaw);return ({v2,v3})[k].validatePackedDenialSource({packedRaw,sourceRaw,verificationSession:session(verificationSession,k)});}
