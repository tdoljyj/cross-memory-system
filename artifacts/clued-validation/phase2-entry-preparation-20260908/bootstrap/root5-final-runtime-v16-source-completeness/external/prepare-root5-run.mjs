// Reusable local preparation. No SQL, remote write, signing, or authority grant.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
const [configFile,mode,inputFile]=process.argv.slice(2);
const need=(v,m)=>{if(!v)throw Error(m);},sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=p=>fs.readFileSync(p,'utf8'),json=p=>JSON.parse(read(p)),raw=x=>JSON.stringify(x)+'\n';
need(configFile&&['indexes','budget','ga','material'].includes(mode),'CONFIG_AND_FIXED_MODE_REQUIRED');
const c=json(configFile),out=path.resolve(c.run_directory);
need(path.isAbsolute(c.run_directory)&&/final-run-root5-v16-20260911$/.test(out),'EXACT_NEW_RUN_DIRECTORY');
fs.mkdirSync(out,{recursive:true});
const save=(name,value)=>{const bytes=typeof value==='string'?value:raw(value),p=path.join(out,name);fs.writeFileSync(p,bytes,{flag:'wx'});return {path:p,sha256:sha(bytes),bytes:Buffer.byteLength(bytes)};};
const input=inputFile?json(inputFile):null;
if(mode==='indexes'){
 console.log(JSON.stringify(save('pending.input.json',{material_file:path.join(out,'Material.CREATE.json'),observation_file:path.join(out,'PENDING.Observation.json')})));
}else{
 const forward=json(c.forward_input),sources=forward.source_materials;
 const runtime=JSON.parse(sources.runtime_acceptance.raw),expected=runtime.accepted_subject.expected_ga;
 const statusRaw=read(c.signed_status_file),status=JSON.parse(statusRaw);
 need(runtime.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&expected.control_trust_root_generation==='ctrgen_e5df432221344996afc04b5638121d96','REAL_ROOT5_RUNTIME_MATERIAL_REQUIRED');
 need(sha(sources.controller_manifest.raw)===expected.controller_digest&&sha(sources.qualification.raw)===expected.controller_qualification_ref.sha256,'EXACT_FORWARD_SOURCE_BINDINGS');
 if(mode==='budget'){
  const current=input?.row?.execution?.current,binding=input?.row?.execution?.binding;
  need(current&&current.active_ga_id===null&&current.pending_budget_sequence===null,'NO_ACTIVE_OR_PENDING_BUDGET');
  need(binding?.controller_sha256===expected.controller_digest&&binding.runtime_acceptance_sha256===sha(sources.runtime_acceptance.raw),'ACTUAL_INSTALLED_CURRENT_BINDING');
  const value={controller_digest:expected.controller_digest,runner_generation:current.runner_generation,credential_generation:current.credential_generation,session_generation:current.session_generation,environment:expected.environment,evidence_bytes:134217728,expires_at:runtime.expires_at,idempotency_key:'budget600_'+crypto.randomUUID().replaceAll('-',''),not_before:new Date().toISOString(),profile_digest:expected.profile_digest,purpose:expected.purpose,root_generation:expected.control_trust_root_generation,scope_digest:expected.scope_digest,seconds:600};
  const result=save('Budget.raw.json',value);save('BudgetPreparation.json',{state:'PREPARED_NOT_RESERVED',...result,source_sequence:current.sequence,authority_effect:'NONE'});console.log(JSON.stringify({...result,value}));
 }else if(mode==='ga'){
  const budget=input?.budget,current=input?.current;
  need(Number.isSafeInteger(budget?.sequence)&&/^[a-f0-9]{64}$/.test(budget.sha256)&&current?.pending_budget_sequence===budget.sequence,'ACTUAL_RESERVED_BUDGET_REQUIRED');
  need(sha(read(path.join(out,'Budget.raw.json')))===budget.sha256,'EXACT_PREPARED_BUDGET_BYTES');
  const id='ga_'+crypto.randomUUID().replaceAll('-',''),issued=new Date(),deadline=new Date(issued.getTime()+600000).toISOString();
  need(Date.parse(deadline)<=Date.parse(runtime.expires_at),'COMPLETE_600_SECOND_WINDOW_REQUIRED');
  const value={...expected,runner_generation:current.runner_generation,credential_generation:current.credential_generation,session_generation:current.session_generation,budget_reservation_ref:{uri:'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'+budget.sequence,sha256:budget.sha256},status_manifest_ref:{uri:'control://status-manifests/'+status.status_manifest_id,sha256:sha(statusRaw)},target_revision:sources.runtime_acceptance.publication.commitSha,gate_authorization_id:id,authorization_status:'AUTHORIZED',issued_at:issued.toISOString(),expires_at:deadline,deadline,idempotency_key:'qualification600_'+id,signature:'urn:clued:gate-authorization:uscrdifznmlvczcekqpw:'+id+'#signature'};
  const result=save('GA.raw.json',value);save('GAPreparation.json',{state:'PREPARED_NOT_SIGNED_NOT_RESERVED',...result,ga_id:id,deadline,budget_sequence:budget.sequence,authority_effect:'NONE'});console.log(JSON.stringify({...result,value}));
 }else{
  const m=json(c.base_material),gaRaw=read(path.join(out,'GA.raw.json')),ga=JSON.parse(gaRaw);
  need(ga.target_revision===sources.runtime_acceptance.publication.commitSha,'ACTUAL_RUNTIME_OWNER_PUBLICATION');
  m.operation='CREATE';m.ga_raw=gaRaw;
  for(const [name,key] of [['runtime_acceptance','runtime_acceptance'],['controller_qualification','qualification'],['gate_suite','gate_suite'],['execution_scope','scope']])m[name]={...sources[key]};
  m.gate_definition.raw=forward.gate_definition_raw;
  m.status_manifest={raw:statusRaw,payload_raw:read(c.status_payload_file),publication:c.status_payload_publication,store_ref:ga.status_manifest_ref,source_binding_sha256:sha(m.runtime_acceptance.raw)};
  need(status.signature_binding.owner_merge_commit===c.status_payload_publication.commitSha,'EXACT_STATUS_OWNER_PUBLICATION');
  need(same(m.execution_scope.ref,ga.scope_ref)&&sha(m.execution_scope.raw)===ga.scope_digest,'UNCHANGED_SCOPE_ORIGINAL_PUBLICATION');
  // Current applicability must be an actually received independent artifact.
  need(c.result_reviewer_material&&c.current_nonperformance_applicability_file,'ACTUAL_INDEPENDENT_RESULT_MATERIALS_REQUIRED');
  m.result_reviewer=json(c.result_reviewer_material);
  need(same(m.result_reviewer.ref,runtime.accepted_subject.result_reviewer_ref)&&sha(m.result_reviewer.raw)===m.result_reviewer.ref.sha256&&m.result_reviewer.publication,'ACTUAL_REVIEWER_ORIGINAL_PUBLICATION');
  const appRaw=read(c.current_nonperformance_applicability_file),app=JSON.parse(appRaw);
  need(app.state==='ACCEPTED_PARALLEL_SOURCE_NONPERFORMANCE_APPLICABILITY'&&app.independent_reviewer==='/root/project_list_auth_fix'&&app.runtime_acceptance_sha256===sha(m.runtime_acceptance.raw),'RECEIVED_EXACT_CURRENT_INDEPENDENT_APPLICABILITY');
  m.current_nonperformance_applicability={raw:appRaw,ref:{uri:'urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:'+sha(appRaw),sha256:sha(appRaw)}};
  delete m.observation;
  console.log(JSON.stringify(save('Material.CREATE.json',m)));
 }
}
