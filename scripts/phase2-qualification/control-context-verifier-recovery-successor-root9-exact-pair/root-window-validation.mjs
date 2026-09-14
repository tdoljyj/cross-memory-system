import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const Ajv=require('ajv');
export const rootId='ctr_414bd3c724264a83894b0c55cf2ab878';
export const projectRef='uscrdifznmlvczcekqpw';
export const rootUri=`urn:clued:control-trust-root-set:${projectRef}:${rootId}`;
export const sourceSchema=JSON.parse(fs.readFileSync(new URL('../nonproduction-control-store/protocol-successor/control-trust-root-set.schema.json',import.meta.url),'utf8'));
const schemaDigest=crypto.createHash('sha256').update(fs.readFileSync(new URL('../nonproduction-control-store/protocol-successor/control-trust-root-set.schema.json',import.meta.url))).digest('hex');
// Existing Ajv6 evaluates only the common draft-07/2020-12 assertion subset used here.
// This is not a claim of a complete draft-2020 implementation. Annotations are not assertions.
const compatible=structuredClone(sourceSchema);compatible.$schema='http://json-schema.org/draft-07/schema#';
for(const k of Object.keys(compatible))if(k.startsWith('x-clued-'))delete compatible[k];
const check=new Ajv({allErrors:true,strictKeywords:true,format:'full'}).compile(compatible);
function canonical(value){
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('Unsafe or floating canonical number');
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 if(!['string','number','boolean'].includes(typeof value)&&value!==null)throw Error('Unsupported canonical value');
 return JSON.stringify(value);
}
export function canonicalDigest(value){return crypto.createHash('sha256').update(canonical(value)+'\n','utf8').digest('hex');}
export function reviewSubjectDigest(root){const value=structuredClone(root);delete value.signature_binding;delete value.independent_acceptance_ref;return canonicalDigest(value);}
export function signaturePayloadDigest(root){const value=structuredClone(root);delete value.signature_binding;return canonicalDigest(value);}
export function validateRootShape(value){
 if(!check(value))throw Error('RootSet schema shape rejected: '+JSON.stringify(check.errors));
 assert.equal(value.schema_digest,schemaDigest,'exact active schema digest');
 const start=Date.parse(value.not_before),end=Date.parse(value.expires_at);
 assert.ok(start>=Date.parse('2026-09-14T03:00:00Z')&&start<end&&end<=Date.parse('2026-09-15T03:00:00Z'),'Owner window');
 assert.ok(Date.parse(value.revocation.as_of)<Date.parse(value.revocation.expires_at)&&Date.parse(value.revocation.expires_at)<=end,'revocation freshness window');
 const purposes=value.issuer_bindings.map(x=>x.purpose);
 assert.equal(new Set(purposes).size,purposes.length,'separate issuer purpose binding');
 assert.ok(value.issuer_bindings.every(x=>x.audience===value.audience),'exact issuer Audience');
 assert.equal(value.signature_binding.signed_object_sha256,signaturePayloadDigest(value),'actual signature payload commitment');
 return {status:'SHAPE_VALID_ONLY',authority_effect:'NONE',signature_verified:false};
}
export function parseControlUri(uri){
 if(typeof uri!=='string'||![rootUri,rootUri+'#history',rootUri+'#revocations'].includes(uri))throw Error('Unknown typed control URI or scope');
 return {root_set_id:rootId,project_ref:projectRef,fragment:uri.split('#')[1]??'root'};
}
export async function readControlUri(uri,store){
 const scope=parseControlUri(uri);const value=await store.read();
 if(!value||value.root_set_id!==rootId||!Array.isArray(value.events))throw Error('Control source absent or wrong scope');
 const events=value.events;
 if(events.length!==value.sequence||events.some((e,i)=>e.root_id!==rootId||e.sequence!==i+1))throw Error('Incomplete control history');
 let data;
 if(scope.fragment==='history')data=events;
 else if(scope.fragment==='revocations')data=events.filter(e=>['ROOT_REVOKED','GENERATION_REVOKED'].includes(e.request.kind));
 else{
  if(value.state!=='STORED_NO_GATE_AUTHORITY')throw Error('Root expired/revoked/not current');
  const current=events.filter(e=>e.request.kind==='GENERATION_REGISTERED').at(-1);
  if(!current||current.request.generation_id!==value.generation_id)throw Error('Current generation missing/mismatch');
  validateRootShape(current.request.body);
  const prefix=events.slice(0,current.sequence-1);
  if(current.request.body.control_trust_root_generation!==current.request.generation_id||current.request.body.history.prefix_sequence!==prefix.length||current.request.body.history.prefix_digest!==canonicalDigest(prefix)||current.request.body.status!=='REGISTERED')throw Error('Root body does not bind actual pre-append history prefix');
  data=current.request.body;
 }
 return {data,status:'UNVERIFIED_SOURCE_READ_ONLY',authority_effect:'NONE',signature_verified:false};
}


