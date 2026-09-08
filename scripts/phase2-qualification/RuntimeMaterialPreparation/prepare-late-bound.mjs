// Forward preparation under the three exact resolver policies; old catalog preserved.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assemble} from './prepare.mjs';
export const lateFields=['budget_reservation_ref','status_manifest_ref','target_revision'];
export function prepareLate(supplied={},statusPayloadSha=null){
 for(const field of lateFields)if(Object.hasOwn(supplied,field))throw Error('Late-bound fields require actual fixed resolver, not supplied value');
 if(statusPayloadSha!==null&&(typeof statusPayloadSha!=='string'||!/^[a-f0-9]{64}$/.test(statusPayloadSha)))throw Error('Actual complete Status signing-payload SHA required');
 const material=assemble(supplied);
 for(const field of lateFields)delete material.expected_ga[field];
 material.field_source_map=material.field_source_map.filter(x=>!lateFields.includes(x.field));
 material.unresolved_fields=material.unresolved_fields.filter(x=>!lateFields.includes(x));
 material.state='NON_ISSUING_THREE_RESOLVER_RUNTIME_PREPARATION';
 material.late_bound_fields={
  budget_reservation_ref:{resolver:'CURRENT_EXACT_EXECUTION_BUDGET_EVENT_V1',maximum_seconds:180,maximum_evidence_bytes:134217728},
  status_manifest_ref:{resolver:'STORED_STATUS_FROM_EXACT_OWNER_SIGNED_PAYLOAD_V1',signed_payload_sha256:statusPayloadSha},
  target_revision:{resolver:'ACTUAL_RUNTIME_AND_SOURCE_MANIFEST_OWNER_MERGE_V1'}
 };
 material.pending_policy_inputs=statusPayloadSha===null?['actual original Status signing payload SHA; no fake signature_binding']:[];
 material.required_stages=['R05','R06','R07','R08','R09','R10'];
 material.policy_applicability='Exact assessor-authorized successor preparation; resolver implementation, final independent runtime acceptance and actual source/current reads remain mandatory';
 return material;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 if(process.argv.length!==2)throw Error('No arbitrary path arguments');
 const input=JSON.parse(fs.readFileSync(new URL('input-definitions/PreparedBindings.json',import.meta.url),'utf8'));
 // Preserve coordinator's proposed definition status. Verify source bytes, do not
 // assert the prospective Git blob exists or was accepted because its SHA is known.
 for(const item of Object.values(input.bindings)){
  const allowed='scripts/phase2-qualification/RuntimeMaterialPreparation/input-definitions/';
  if(!item.provenance.source.startsWith(allowed)||item.provenance.source.slice(allowed.length).includes('/')||item.provenance.source.includes('..'))throw Error('Fixed input-definition source only');
  const raw=fs.readFileSync(new URL('input-definitions/'+item.provenance.source.slice(allowed.length),import.meta.url));
  if(crypto.createHash('sha256').update(raw).digest('hex')!==item.provenance.sha256)throw Error('Input definition drift');
 }
 const path=new URL('work/late-bindings.json',import.meta.url);
 const remaining=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{bindings:{},status_payload_sha256:null};
 if(Object.keys(remaining.bindings).some(k=>Object.hasOwn(input.bindings,k)))throw Error('Coordinator fixed definitions cannot be silently replaced');
 const result=prepareLate({...input.bindings,...remaining.bindings},remaining.status_payload_sha256);
 fs.writeFileSync(new URL('PreparedLateBoundRuntime.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({state:result.state,fixed_fields:Object.keys(result.expected_ga).length,unresolved:result.unresolved_fields.length,authority_effect:'NONE'}));
}
