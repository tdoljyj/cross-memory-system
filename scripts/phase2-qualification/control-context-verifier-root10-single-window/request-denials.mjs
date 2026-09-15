// Measurement adapter for real verifier calls. This never grants admission or invokes a host effect.
import crypto from 'node:crypto';
import {checkCurrentSemantics,sql,project} from './context.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const raw=value=>JSON.stringify(value)+'\n';
const copy=value=>structuredClone(value);
function differences(before,after,path=''){
 if(JSON.stringify(before)===JSON.stringify(after))return [];
 if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){
  return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key=>{
   const target=path+'/'+key.replaceAll('~','~0').replaceAll('/','~1');
   if(!Object.hasOwn(after,key))return [{op:'remove',path:target}];
   if(!Object.hasOwn(before,key))return [{op:'add',path:target,value:after[key]}];
   return differences(before[key],after[key],target);
  });
 }
 return [{op:'replace',path,value:after}];
}
function reconstruct(before,changes){
 let result=copy(before);
 for(const change of changes){
  if(change.path===''){result=copy(change.value);continue;}
  const keys=change.path.slice(1).split('/').map(key=>key.replaceAll('~1','/').replaceAll('~0','~'));
  let parent=result;for(const key of keys.slice(0,-1))parent=parent[key];
  if(change.op==='remove')delete parent[keys.at(-1)];
  else parent[keys.at(-1)]=copy(change.value);
 }
 return result;
}
const faults=[
 ['PQUAL-02','missing_profile_ref',ga=>{delete ga.profile_ref;}],
 ['PQUAL-02','missing_profile_acceptance',ga=>{delete ga.profile_ref.accepted_ref;}],
 ['PQUAL-02','missing_GA_object_fields',ga=>{for(const key of Object.keys(ga))delete ga[key];}],
 ...[1,2,3,4,5].map(index=>['PQUAL-03','missing_R'+String(index+5).padStart(2,'0')+'_request_reference',ga=>{ga.stage_receipt_refs.splice(index,1);}]),
 ['PQUAL-04','unaccepted_issuer_reference',ga=>{ga.issuer_ref={...ga.issuer_ref,uri:ga.issuer_ref.uri+'-unaccepted'};}],
 ['PQUAL-04','unaccepted_actor_reference',ga=>{ga.actor_ref={...ga.actor_ref,uri:ga.actor_ref.uri+'-unknown-actor'};}],
 ['PQUAL-06','request_ACTIVE_write',ga=>{ga.allowed_write_set.push('ACTIVE/default');}],
 ['PQUAL-07','request_real_Slice_A_purpose',ga=>{ga.purpose='SLICE_A_IMPLEMENTATION';}],
 ['PQUAL-08','request_unaccepted_credential_scope',ga=>{ga.credential_scope={...ga.credential_scope,uri:ga.credential_scope.uri+'-unaccepted-development-credential'};}],
 ['PQUAL-09','request_real_payload_field',ga=>{ga.real_user_payload={requested:true};}],
 ['PQUAL-09','request_production_environment',ga=>{ga.environment='PRODUCTION';}],
 ['PQUAL-11','missing_budget_reservation',ga=>{delete ga.budget_reservation_ref;}],
 ['PQUAL-12','changed_plan_digest',ga=>{ga.plan_digest=hash('changed-plan-fault-input');}],
 ...['fixtures_digest','candidate_skill_digest','host_runtime_config_digest'].map(field=>['PQUAL-12','changed_'+field,ga=>{ga[field]=hash('changed-'+field+'-fault-input');}]),
 ['PQUAL-13','request_stale_generation',ga=>{ga.runner_generation+='-stale-request';}],
 ['PQUAL-14','request_lifetime_over_owner_limit',ga=>{ga.deadline=new Date(Date.parse(ga.issued_at)+601000).toISOString();ga.expires_at=ga.deadline;}],
 ['PQUAL-14','expired_request',ga=>{const now=Date.now();ga.issued_at=new Date(now-601000).toISOString();ga.deadline=new Date(now-1000).toISOString();ga.expires_at=ga.deadline;}],
 ['PQUAL-19','request_wrong_PreEntry_gate',ga=>{ga.gate_id='G1';}],
];

export function observeRequestDenials({gaRaw,observation,runtimeAcceptance,qualification}){
 if(observation?.project!==project||observation.query_sha256!==hash(sql))throw Error('EXACT_TRUSTED_READ_COLLECTION_REQUIRED');
 // This check is deliberately real and first: a broken baseline cannot make every negative appear to pass.
 const baseline=checkCurrentSemantics({gaRaw,operation:'CREATE',observation,runtimeAcceptance,qualification});
 if(baseline.state!=='SEMANTICS_ONLY_NOT_ADMISSION')throw Error('ACTUAL_BASELINE_SEMANTICS_REQUIRED');
 const before=raw(observation),ga=JSON.parse(gaRaw),results=[];
 const baselineInput={ga,operation:'CREATE',runtimeAcceptance,qualification};
 const originalInputs=raw({kind:'ACTUAL_VERIFIER_ORIGINAL_INPUTS',ga_raw:gaRaw,observation_raw:before,
  runtime_acceptance_raw:raw(runtimeAcceptance),qualification_raw:raw(qualification)});
 const originalRef={uri:'urn:clued:execution-evidence:'+observation.row.execution.binding.root_id+':'+hash(originalInputs),sha256:hash(originalInputs)};
 function measure(test_id,fault_name,input){
  const called={ga:JSON.parse(input.gaRaw),operation:input.operation,runtimeAcceptance:input.runtimeAcceptance,qualification:input.qualification};
  const changes=differences(baselineInput,called);
  if(raw(reconstruct(baselineInput,changes))!==raw(called))throw Error('EXACT_FAULT_INPUT_RECONSTRUCTION_REQUIRED');
  const start=process.hrtime.bigint(),started_at=new Date().toISOString();let error=null,returned=null;
  try{returned=checkCurrentSemantics(input);}catch(failure){error={name:failure.name,message:failure.message};}
  const ended_at=new Date().toISOString();
  const source={kind:'ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION',test_id,fault_name,
   baseline_ga_sha256:hash(gaRaw),actual_current_observation_sha256:hash(before),
   actual_entry:'control-context-verifier-root5-final-successor/context.mjs#checkCurrentSemantics',
   original_inputs_ref:originalRef,
   fault_input_changes:changes,exact_input_reconstruction_checked:true,
   called_input_digests:{ga_raw:hash(input.gaRaw),runtime_acceptance_raw:hash(raw(input.runtimeAcceptance)),qualification_raw:hash(raw(input.qualification))},
   started_at,ended_at,elapsed_monotonic_nanoseconds:(process.hrtime.bigint()-start).toString(),error,returned,
   authority_effect:'NONE',host_effect_api_invocations:0,sql_mutation_api_invocations:0,
   measurement_boundary:'Actual semantic request-validation code executed against an unchanged collected SQL observation. This is not full signed admission, a live revocation, transport fault, host effect, or complete PQUAL acceptance.'};
  results.push({test_id,denied:error!==null,raw:raw(source),sha256:hash(raw(source)),complete_case_pass:false});
 }
 for(const [id,name,mutate] of faults){
  const changed=copy(ga);mutate(changed);
  measure(id,name,{gaRaw:raw(changed),operation:'CREATE',observation,runtimeAcceptance,qualification});
 }
 measure('PQUAL-05','self_dependent_qualification_input',{gaRaw,operation:'CREATE',observation,runtimeAcceptance,
  qualification:{...qualification,independent_of_tested_skill:false}});
 measure('PQUAL-05','forbidden_stage_dependent_qualification_input',{gaRaw,operation:'CREATE',observation,runtimeAcceptance,
  qualification:{...qualification,forbidden_stage_dependencies_excluded:false}});
 measure('PQUAL-10','request_MODEL_operation',{gaRaw,operation:'MODEL',observation,runtimeAcceptance,qualification});
 measure('PQUAL-19','R14_added_to_runtime_prerequisites',{gaRaw,operation:'CREATE',observation,qualification,
  runtimeAcceptance:{...runtimeAcceptance,accepted_subject:{...runtimeAcceptance.accepted_subject,
   required_stages:[...runtimeAcceptance.accepted_subject.required_stages,'R14']}}});
 if(raw(observation)!==before)throw Error('ORIGINAL_CURRENT_OBSERVATION_MUTATED');
 return {state:'ACTUAL_REQUEST_DENIAL_SUBCASE_MEASUREMENTS',baseline_verified_semantics_only:true,
  baseline_ga_sha256:hash(gaRaw),original_inputs_artifact:{...originalRef,raw:originalInputs},results,complete_pqual_pass:false,
  remaining:['actual signed positive synthetic action','actual publication target/source verification boundary','actual current-generation transition boundary',
   'unconverged capacity/renewal fencing','unknown result and no duplicate terminal','unwritable sink refusal',
   'no automatic readiness or broader authority after results','independent assessment of every original Test oracle']};
}

