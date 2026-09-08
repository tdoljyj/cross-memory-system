// Lossless packaging for original measured inputs; the original denial observations stay byte-identical.
import crypto from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {observeRequestDenials} from './request-denials.mjs';
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const raw=value=>JSON.stringify(value)+'\n';
const need=(value,message)=>{if(!value)throw Error(message);};
const maximumOriginalBytes=1048576;
export function packOriginalInputs(originalArtifact){
 need(typeof originalArtifact?.raw==='string'&&Buffer.byteLength(originalArtifact.raw)<=maximumOriginalBytes,'BOUNDED_ORIGINAL_INPUTS');
 need(sha(originalArtifact.raw)===originalArtifact.sha256&&originalArtifact.uri.endsWith(':'+originalArtifact.sha256),'EXACT_ORIGINAL_INPUTS_REF');
 const original=JSON.parse(originalArtifact.raw);need(original.kind==='ACTUAL_VERIFIER_ORIGINAL_INPUTS','ORIGINAL_INPUT_KIND');
 const packed=raw({kind:'EXACT_ORIGINAL_VERIFIER_INPUTS_DEFLATE_V1',original_ref:{uri:originalArtifact.uri,sha256:originalArtifact.sha256},
  original_bytes:Buffer.byteLength(originalArtifact.raw),data_base64:deflateRawSync(Buffer.from(originalArtifact.raw,'utf8')).toString('base64')});
 need(Buffer.byteLength(packed)<=131072,'BOUNDED_PACKED_INPUTS');
 const envelope=JSON.parse(packed),recovered=inflateRawSync(Buffer.from(envelope.data_base64,'base64'),{maxOutputLength:maximumOriginalBytes});
 need(recovered.equals(Buffer.from(originalArtifact.raw,'utf8')),'LOSSLESS_ORIGINAL_BYTE_ROUNDTRIP');
 return {uri:originalArtifact.uri.slice(0,-64)+sha(packed),sha256:sha(packed),raw:packed};
}
export function decodeOriginalInputs(packedRaw,originalRef){
 need(typeof packedRaw==='string'&&Buffer.byteLength(packedRaw)<=131072,'BOUNDED_PACKED_SOURCE');
 const envelope=JSON.parse(packedRaw);
 need(raw(envelope)===packedRaw&&Object.keys(envelope).sort().join(',')==='data_base64,kind,original_bytes,original_ref','EXACT_PACKED_SCHEMA');
 need(envelope.kind==='EXACT_ORIGINAL_VERIFIER_INPUTS_DEFLATE_V1'&&raw(envelope.original_ref)===raw(originalRef),'EXACT_UNCOMPRESSED_REFERENCE');
 need(Number.isSafeInteger(envelope.original_bytes)&&envelope.original_bytes>0&&envelope.original_bytes<=maximumOriginalBytes,'BOUNDED_ORIGINAL_LENGTH');
 need(typeof envelope.data_base64==='string'&&Buffer.from(envelope.data_base64,'base64').toString('base64')===envelope.data_base64,'EXACT_BASE64');
 const bytes=inflateRawSync(Buffer.from(envelope.data_base64,'base64'),{maxOutputLength:maximumOriginalBytes});
 need(bytes.length===envelope.original_bytes&&sha(bytes)===originalRef.sha256,'EXACT_ORIGINAL_BYTE_RESTORATION');
 const text=bytes.toString('utf8');need(Buffer.from(text,'utf8').equals(bytes),'EXACT_ORIGINAL_UTF8_BYTES');
 const value=JSON.parse(text);need(raw(value)===text&&value.kind==='ACTUAL_VERIFIER_ORIGINAL_INPUTS','EXACT_ORIGINAL_INPUT_ENCODING');
 return value;
}
export function validatePackedDenialSource({packedRaw,sourceRaw}){
 const source=JSON.parse(sourceRaw);need(raw(source)===sourceRaw&&source.kind==='ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION','EXACT_ACTUAL_DENIAL_SOURCE');
 const original=decodeOriginalInputs(packedRaw,source.original_inputs_ref);
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
 need(raw(digests)===raw(source.called_input_digests)&&source.actual_entry==='control-context-verifier-runtime600/context.mjs#checkCurrentSemantics','EXACT_ACTUALLY_CALLED_INPUTS');
 need(source.actual_current_observation_sha256===sha(original.observation_raw)&&source.baseline_ga_sha256===sha(original.ga_raw),'EXACT_ACTUAL_BASELINE_BINDING');
 return {state:'ORIGINAL_MEASURED_INPUT_BYTES_RESTORED',test_id:source.test_id,operation:reconstructed.operation,oracle_pass_claimed:false};
}
export function observePackedRequestDenials(input){
 const measured=observeRequestDenials(input),original=measured.original_inputs_artifact;
 const packed=packOriginalInputs(original);
 for(const item of measured.results)validatePackedDenialSource({packedRaw:packed.raw,sourceRaw:item.raw});
 return {...measured,original_inputs_artifact:packed,original_uncompressed_inputs_ref:{uri:original.uri,sha256:original.sha256},
  packaging:'LOSSLESS_SHARED_ORIGINAL_INPUTS; original measurement raw bytes unchanged; every recorded input reconstructed and digest-checked',complete_pqual_pass:false};
}
