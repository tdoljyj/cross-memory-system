// Ordinary exact evidence transport only; no authority or new protocol object.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const applicabilityHash='433913315714fb00deb3ebdefda5c9b52588d7bc2fb4318780ed6e01cfb795a1';
const supportHash='1e97291caa7ca1cec1987396c776cc206d867c0bf5f8915a65bc99e8220096bf';
const prefix='urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),raw=x=>JSON.stringify(x)+'\n',need=(v,m)=>{if(!v)throw Error(m);};
export const applicabilityPath=path.resolve(here,'../kernel-phase2-repo/artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/CaseObservationCombinationIndependentApplicability.json').replaceAll('\\','/');
function timestamp(s){need(typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s,'ACTUAL_LOCAL_READ_TIME');}
function validate(record){
 need(record&&[applicabilityHash,supportHash].includes(record.sha256)&&typeof record.raw==='string'&&hash(record.raw)===record.sha256&&record.bytes===Buffer.byteLength(record.raw)&&record.bytes>0&&record.bytes<=65536&&record.executed===false,'EXACT_COMPLETE_ORDINARY_LOCAL_BYTES');timestamp(record.read_at);
 need(record.owner_merge===undefined&&record.ref===undefined,'LOCAL_ORIGIN_NOT_SIGNED_PUBLICATION');
 if(record.sha256===applicabilityHash){
  const x=JSON.parse(record.raw);need(record.read_origin==='LOCAL_FILESYSTEM_NAMED_INDEPENDENT_EVIDENCE'&&record.local_path===applicabilityPath&&x.independent_reviewer==='/root/project_list_auth_fix'&&x.state==='ACCEPTED_SCOPED_CASE_EVIDENCE_COMPOSITION_AND_PREEXECUTION_APPLICABILITY'&&x.controller_manifest_sha256==='edf31377656e1a9a473d0095df72231c058266007e4fd4046e0a9b8c2d6a60d9','EXACT_ALREADY_RECEIVED_INDEPENDENT_APPLICABILITY');
 }else need(record.read_origin==='LOCAL_FILESYSTEM_EXACT_REPORT_BOUND_SUPPORT'&&record.local_path===path.resolve(here,'../runtime-store-independent-targeted.mjs').replaceAll('\\','/')&&record.report_ref?.sha256==='62e09c32a24da5d855408e59ac4b9e6362d7dbbf68e70c70745cd465480019cd'&&record.report_field==='/validation/independent_script_sha256','EXACT_REPORT_BOUND_SUPPORT');
 return record;
}
export function readLocalApplicability(){
 for(let p=applicabilityPath;;p=path.dirname(p)){need(!fs.lstatSync(p).isSymbolicLink(),'UNLINKED_FIXED_APPLICABILITY');if(p===path.dirname(p))break;}
 const st=fs.statSync(applicabilityPath);need(st.isFile()&&st.size>0&&st.size<=65536,'BOUNDED_FIXED_APPLICABILITY');
 const bytes=fs.readFileSync(applicabilityPath),text=bytes.toString('utf8');need(Buffer.from(text).equals(bytes),'LOSSLESS_LOCAL_APPLICABILITY');
 return validate({read_origin:'LOCAL_FILESYSTEM_NAMED_INDEPENDENT_EVIDENCE',local_path:applicabilityPath,raw:text,sha256:hash(bytes),bytes:bytes.length,read_at:new Date().toISOString(),executed:false});
}
export function packLocalSources(records){
 need(Array.isArray(records)&&records.length>0&&records.length<=2&&new Set(records.map(r=>r.sha256)).size===records.length,'UNIQUE_FIXED_LOCAL_SOURCES');records.forEach(validate);
 const content=raw({sources:records}),bytes=Buffer.from(content);need(bytes.length<=65536,'BOUNDED_ORDINARY_SOURCE_BOOK');
 const s=raw({kind:'EXACT_ORDINARY_LOCAL_COMPONENT_SOURCES_DEFLATE_V1',original_bytes:bytes.length,original_sha256:hash(bytes),compressed_base64:zlib.deflateSync(bytes).toString('base64')});
 return {uri:prefix+hash(s),sha256:hash(s),raw:s};
}
export function unpackLocalSources(artifact){
 need(artifact&&typeof artifact.raw==='string'&&Buffer.byteLength(artifact.raw)<=131072&&hash(artifact.raw)===artifact.sha256&&artifact.uri===prefix+artifact.sha256,'EXACT_SHARED_ORDINARY_ARTIFACT');
 const v=JSON.parse(artifact.raw);need(raw(v)===artifact.raw&&Object.keys(v).sort().join(',')==='compressed_base64,kind,original_bytes,original_sha256'&&v.kind==='EXACT_ORDINARY_LOCAL_COMPONENT_SOURCES_DEFLATE_V1'&&Number.isSafeInteger(v.original_bytes)&&v.original_bytes>0&&v.original_bytes<=65536&&typeof v.compressed_base64==='string','FIXED_ORDINARY_SOURCE_ENCODING');
 const compressed=Buffer.from(v.compressed_base64,'base64');need(compressed.toString('base64')===v.compressed_base64,'CANONICAL_BASE64');
 const result=zlib.inflateSync(compressed,{maxOutputLength:65536,info:true}),bytes=result.buffer;
 need(result.engine.bytesWritten===compressed.length&&bytes.length===v.original_bytes&&hash(bytes)===v.original_sha256,'EXACT_FULL_DEFLATE_STREAM');
 const text=bytes.toString('utf8');need(Buffer.from(text).equals(bytes),'LOSSLESS_SOURCE_BOOK');const book=JSON.parse(text);
 need(raw(book)===text&&Object.keys(book).join(',')==='sources'&&Array.isArray(book.sources)&&book.sources.length>0&&book.sources.length<=2&&new Set(book.sources.map(r=>r.sha256)).size===book.sources.length,'EXACT_UNIQUE_SOURCE_BOOK');return book.sources.map(validate);
}
export function sharedDescriptor(record,artifact){validate(record);return {read_origin:record.read_origin,sha256:record.sha256,bytes:record.bytes,read_at:record.read_at,shared_artifact_ref:{uri:artifact.uri,sha256:artifact.sha256}};}
export function resolveSharedLocal(descriptor,artifacts){
 need(descriptor&&Object.keys(descriptor).sort().join(',')==='bytes,read_at,read_origin,sha256,shared_artifact_ref'&&Object.keys(descriptor.shared_artifact_ref??{}).sort().join(',')==='sha256,uri','EXACT_ORDINARY_SHARED_DESCRIPTOR');
 const found=artifacts.filter(a=>a.uri===descriptor.shared_artifact_ref.uri&&a.sha256===descriptor.shared_artifact_ref.sha256);need(found.length===1,'ONE_COMPLETE_SHARED_ORDINARY_ARTIFACT');
 const rows=unpackLocalSources(found[0]),record=rows.find(r=>r.sha256===descriptor.sha256);need(record&&record.read_origin===descriptor.read_origin&&record.bytes===descriptor.bytes&&record.read_at===descriptor.read_at,'EXACT_SHARED_LOCAL_SOURCE_READBACK_BINDING');return record;
}
