#!/usr/bin/env node
// Build the fifteen Root10 post-activation/pre-GA rollback probes. Local-only:
// no network, database connection, publication, signature, or GA issuance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const die=m=>{throw new Error(m)};
const read=p=>fs.readFileSync(path.resolve(p),'utf8');
const json=p=>JSON.parse(read(p));
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const q=s=>String(s).replaceAll("'","''");
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const exactKeys=(o,keys,label)=>{
  if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).sort().join(',')!==[...keys].sort().join(','))die(label);
};
const nonemptyRepairs=o=>o&&typeof o==='object'&&Object.entries(o).some(([k,v])=>
  ((k==='repair_refs'||k==='required_repair_refs')&&(!Array.isArray(v)||v.length!==0))||nonemptyRepairs(v));

const argv=process.argv.slice(2);
if(argv.length<2)die('usage: node build-root10-negative-probes.mjs FULL_ROLLBACK.sql MATERIALS.json [--stdout|OUTDIR]');
const [fullPath,materialsPath,outArg='--stdout']=argv;
const full=read(fullPath),m=json(materialsPath),dir=path.dirname(path.resolve(fullPath));
const planPath=path.join(dir,'reserve_gate.actual-negative-fixtures.json');
const manifestPath=path.join(dir,'root10-activation.build.json');
if(!fs.existsSync(planPath)||!fs.existsSync(manifestPath))die('exact sibling negative plan and activation build manifest required');
const plan=json(planPath),manifest=json(manifestPath),fullSha=sha(full),planRaw=read(planPath),planSha=sha(planRaw);
if(manifest.files?.['root10-activation.full-rollback.sql']!==fullSha||manifest.files?.['reserve_gate.actual-negative-fixtures.json']!==planSha)die('full rollback/plan not bound by activation manifest');
if(!/^begin;/im.test(full)||!full.trimEnd().endsWith('rollback;')||/\ncommit;\s*$/i.test(full))die('exact terminal rollback SQL required');
if((full.match(/CREATE OR REPLACE FUNCTION\s+clued_control\.(read_root|reserve_execution_budget|reserve_gate)/gi)||[]).length!==3||
   (full.match(/\$function\$/g)||[]).length!==6||!full.includes('ROOT10_ACTIVATION_POSTIMAGE_FAILED'))die('full rollback does not execute the exact three-function activation');

const ids=['N01_CHANGED_BYTES_SAME_IDEMPOTENCY','N02_SECOND_ROOT10_GA','N03_NONEMPTY_REPAIR_REFS',
 'N04_FIXED_SCHEMA_ISSUER_RISK_PROFILE_VECTOR_SOURCE_DRIFT','N05_STATUS_NOT_GENERATION29','N06_BUDGET_NOT117_OR_RAW_NO_LF',
 'N07_NOT_EXACT_600_SECONDS','N08_HISTORICAL_ATTEMPT_OR_RECEIPT_DRIFT','N09_CONTAINER_OR_ACTIVE_PHASE_PREEXISTS',
 'N10_EXACT_RESPONSE_LOSS_REPLAY','N11_ROOT_OR_EXECUTION_IMMUTABLE_PREFIX_DRIFT','N12_HISTORICAL_BUDGET_GENERATION_OR_EXPIRY_DRIFT',
 'N13_GA6_CLOSURE_111_112_BYTES_DRIFT','N14_EXACT_51_FIELD_SCHEMA_SHAPE_MISSING_OR_EXTRA','N15_CONTAINER_PHASE_MACHINE_DRIFT'];
const acceptedFixtures=[
 {id:'N01_CHANGED_BYTES_SAME_IDEMPOTENCY',expected_error:'idempotency_conflict',mutation:'same idempotency key with different GA bytes'},
 {id:'N02_SECOND_ROOT10_GA',expected_error:'root10_exact_single_ga_preimage_required',mutation:'new GA id/idempotency after first reservation'},
 {id:'N03_NONEMPTY_REPAIR_REFS',expected_error:'root10_exact_accepted_scope_or_zero_repairs_required',mutation:'one repair_refs entry'},
 {id:'N04_FIXED_SCHEMA_ISSUER_RISK_PROFILE_VECTOR_SOURCE_DRIFT',expected_error_one_of:['root10_exact_accepted_scope_or_zero_repairs_required','root10_complete_fixed_and_late_bound_ga_contract_required'],mutation:'change each fixed field one at a time'},
 {id:'N05_STATUS_NOT_GENERATION29',expected_error:'exact_stored_status29_required',mutation:'status ref points at a different stored generation'},
 {id:'N06_BUDGET_NOT117_OR_RAW_NO_LF',expected_error:'root10_exact_prior_committed_budget117_required',mutation:'budget reference/hash/raw bytes differ'},
 {id:'N07_NOT_EXACT_600_SECONDS',expected_error:'root10_exact_600_second_ga_window_required',mutation:'599 or 601 second interval'},
 {id:'N08_HISTORICAL_ATTEMPT_OR_RECEIPT_DRIFT',expected_error_one_of:['series_original_six_attempts_changed','root10_exact_single_ga_preimage_required'],mutation:'attempt id/raw/receipt/result/budget binding differs'},
 {id:'N09_CONTAINER_OR_ACTIVE_PHASE_PREEXISTS',expected_error:'root10_exact_single_ga_preimage_required',mutation:'active Root10 GA or nonterminal historical phase exists'},
 {id:'N10_EXACT_RESPONSE_LOSS_REPLAY',expected_status:'DUPLICATE',mutation:'same exact raw and hash after successful reserve'},
 {id:'N11_ROOT_OR_EXECUTION_IMMUTABLE_PREFIX_DRIFT',expected_error_one_of:['series_full_original_root_changed','series_original_44_events_changed'],mutation:'change one Root<=8 or execution<=44 request field'},
 {id:'N12_HISTORICAL_BUDGET_GENERATION_OR_EXPIRY_DRIFT',expected_error:'root10_exact_single_ga_preimage_required',mutation:'change one post-44 budget root_generation or historical expires_at'},
 {id:'N13_GA6_CLOSURE_111_112_BYTES_DRIFT',expected_error:'root10_exact_single_ga_preimage_required',mutation:'change a decision/evidence/observation raw byte, idempotency key, termination mode, or signing decision hash'},
 {id:'N14_EXACT_51_FIELD_SCHEMA_SHAPE_MISSING_OR_EXTRA',expected_error:'root10_complete_fixed_and_late_bound_ga_contract_required',also_expected_rejection_layer:'trusted host schema/runtime-acceptance verifier before reserve_gate',mutation:'remove any required field or add any field outside the original 51-field schema'},
 {id:'N15_CONTAINER_PHASE_MACHINE_DRIFT',expected_rejection_layer:'unchanged pinned execution_transition',mutation:'CREATED/RUNNING/STOPPED with missing or mismatched container_id, or dispatch from a nonmatching phase'}
];
if(plan.schema_version!=='root10-reserve-gate-negative-fixtures/1'||plan.run_after_activation_before_final_ga!==true||
 plan.authority_effect!=='NONE'||!Array.isArray(plan.fixtures)||plan.fixtures.map(x=>x.id).join(',')!==ids.join(',')||
 JSON.stringify(plan.fixtures)!==JSON.stringify(acceptedFixtures))die('exact accepted fifteen-item plan required');

const intent=json(m.intent_path),live=json(m.live_preimage_path),catalog=json(m.live_function_catalog_path);
const statusRaw=read(m.status29_signed_path),status=JSON.parse(statusRaw);
const runtimeRaw=read(m.runtime_acceptance_path),runtime=JSON.parse(runtimeRaw);
const qualRaw=read(m.controller_qualification_path),qual=JSON.parse(qualRaw);
const prepared=json(m.prepared_evidence_path),qualified=json(m.qualified_evidence_path);
const ROOT='ctr_414bd3c724264a83894b0c55cf2ab878',ROOT10='ctrgen_48100437d24e448ba01c542ebe1290da';
if(intent.root_id!==ROOT||intent.generation_id!==ROOT10||intent.generation_ordinal!==10||intent.new_budget_seconds!==600||
 intent.new_budget_evidence_bytes!==134217728||intent.cumulative_seconds_cap!==11706||intent.cumulative_evidence_bytes_cap!==2604247987||
 intent.cumulative_allocation_cap!==11||intent.max_new_ga!==1||intent.max_new_budgets!==1||intent.automatic_retry||intent.successor_ga||
 intent.refund||intent.reset_counters||intent.budget_reassignment)die('Root10 fixed single-window boundary changed');
if(sha(statusRaw)!==m.status29_full_sha256||sha(runtimeRaw)!==m.runtime_acceptance_sha256||sha(qualRaw)!==m.controller_qualification_sha256)die('actual material byte pin mismatch');
if(status.object_type!=='StatusManifest'||status.generation!==29||status.control_trust_root_generation!==ROOT10||
 !/^[0-9a-f]{40}$/.test(status.signature_binding?.owner_merge_commit||'')||status.signature_binding?.signed_object_sha256==null)die('actual full signed Status29 required');
if(runtime.state!=='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'||qual.state!=='ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION'||
 runtime.controller_digest!==m.controller_sha256||qual.controller_digest!==m.controller_sha256||nonemptyRepairs(runtime)||nonemptyRepairs(qual)||
 nonemptyRepairs(prepared)||nonemptyRepairs(qualified))die('exact zero-repair Root10 qualification/runtime/evidence required');
const fixed=runtime.accepted_subject?.expected_ga;
const fixedKeys=['gate_id','profile_ref','purpose','environment','repository_ref','artifact_refs','host_runtime_config_digest','upstream_gate_result_receipt_refs',
 'release_risk_manifest_digest','actor_ref','subject_ref','binding_ref','scope_ref','issuer_ref','authority_source_ref','audience','issuer_purpose','schema_digest',
 'control_trust_root_generation','allowed_read_set','allowed_write_set','forbidden_actions','credential_scope','stop_policy_digest','rollback_point_ref','evidence_sink_ref',
 'controller_digest','candidate_skill_digest','mechanism_digest','plan_digest','fixtures_digest','stage_receipt_refs','revocation_epoch_vector','scope_digest','profile_digest',
 'dominant_role','source_ref','controller_qualification_ref'];
exactKeys(fixed,fixedKeys,'exact 38-field fixed GateAuthorization contract required');
if(fixed.control_trust_root_generation!==ROOT10||fixed.controller_digest!==m.controller_sha256||fixed.profile_digest!==intent.profile_sha256||
 fixed.scope_digest!==intent.scope_sha256||fixed.gate_id!==m.gate_id||nonemptyRepairs(fixed))die('fixed GateAuthorization boundary mismatch');
const budget={controller_digest:m.controller_sha256,credential_generation:live.execution.current.credential_generation,environment:'ISOLATED_TEST',
 evidence_bytes:134217728,expires_at:intent.expires_at,idempotency_key:intent.budget_idempotency_key,not_before:intent.not_before,
 profile_digest:intent.profile_sha256,purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:ROOT10,
 runner_generation:live.execution.current.runner_generation,scope_digest:intent.scope_sha256,seconds:600,
 session_generation:live.execution.current.session_generation};
const budgetRaw=JSON.stringify(budget)+'\n',budgetSha=sha(budgetRaw),statusSha=sha(statusRaw),p2=status.signature_binding.owner_merge_commit;
const transitionRows=catalog.filter(x=>x.proname==='execution_transition'&&x.arguments==='p jsonb');
if(transitionRows.length!==1||!/^[0-9a-f]{64}$/.test(transitionRows[0].sha256||''))die('exact live execution_transition catalog pin required');
const transitionSha=transitionRows[0].sha256;
for(const token of [ROOT10,budgetSha,m.runtime_acceptance_sha256,m.controller_qualification_sha256,m.controller_sha256])
 if(!full.includes(token))die('full rollback/material boundary mismatch: '+token);
const activationPayloadMatch=full.match(/declare p jsonb:=convert_from\(decode\('([^']+)'\s*,\s*'base64'\)/i);
if(!activationPayloadMatch)die('full rollback embedded activation payload missing');
let activationPayload;
try{activationPayload=JSON.parse(Buffer.from(activationPayloadMatch[1],'base64').toString('utf8'));}
catch{die('full rollback embedded activation payload invalid');}
exactKeys(activationPayload,['schema_version','root_registration','binding_raw','binding_sha256','status_raw','status_sha256',
 'prepared_evidence','qualified_evidence','runtime_acceptance_raw','runtime_acceptance_sha256','budget_raw','budget_sha256'],
 'full rollback embedded activation payload fields changed');
if(activationPayload.schema_version!=='root10-activation-request/1'||activationPayload.status_raw!==statusRaw||
 activationPayload.status_sha256!==statusSha||sha(activationPayload.status_raw)!==activationPayload.status_sha256||
 activationPayload.runtime_acceptance_raw!==runtimeRaw||activationPayload.runtime_acceptance_sha256!==m.runtime_acceptance_sha256||
 sha(activationPayload.runtime_acceptance_raw)!==activationPayload.runtime_acceptance_sha256||
 activationPayload.budget_raw!==budgetRaw||activationPayload.budget_sha256!==budgetSha||sha(activationPayload.budget_raw)!==activationPayload.budget_sha256)
 die('full rollback embedded activation payload/material boundary mismatch');
if(manifest.pins?.budget_sha256!==budgetSha||manifest.pins?.status29_full_sha256!==statusSha||manifest.pins?.controller_sha256!==m.controller_sha256)die('activation manifest pins changed');

const fixedExpr=`convert_from(decode('${b64(JSON.stringify(fixed))}','base64'),'UTF8')::jsonb`;
const statusRef=`jsonb_build_object('uri','control://status-manifests/${q(status.status_manifest_id)}','sha256','${statusSha}')`;
const budgetRef=`jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:117','sha256','${budgetSha}')`;
const gaId=label=>'ga_'+sha('root10-negative-'+label).slice(0,32);
const idem=label=>'root10_negative_'+label.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,100);
const makeGa=label=>`g:=base_ga||jsonb_build_object(
 'gate_authorization_id','${gaId(label)}','authorization_status','AUTHORIZED','status_manifest_ref',${statusRef},
 'issued_at',t0,'expires_at',t0+interval '600 seconds','deadline',t0+interval '600 seconds',
 'budget_reservation_ref',${budgetRef},'target_revision','${p2}',
 'runner_generation','${q(live.execution.current.runner_generation)}','credential_generation','${q(live.execution.current.credential_generation)}',
 'session_generation','${q(live.execution.current.session_generation)}','idempotency_key','${idem(label)}',
 'signature','SQL_LAYER_SYNTHETIC_ROLLBACK_PROBE_NOT_AUTHORITY');`;
const callGate=`raw:=g::text; h:=encode(sha256(convert_to(raw,'UTF8')),'hex'); r:=clued_control.reserve_gate(raw,h);`;
const positive=label=>`begin
 ${makeGa(label+'_control')}
 ${callGate}
 if r->>'status'<>'RESERVED' then raise exception 'valid control did not reserve'; end if;
 raise exception '__R10_CONTROL_ROLLBACK_${label}__';
exception when others then
 if sqlerrm is distinct from '__R10_CONTROL_ROLLBACK_${label}__' then raise exception '${label} valid control failed: %',sqlerrm; end if;
end;`;
const expectError=(label,expected,{setup='',mutate='',make=true}={})=>`begin
 ${setup}
 ${make?makeGa(label):''}
 ${mutate}
 ${callGate}
 raise exception '__UNEXPECTED_ACCEPT_${label}__';
exception when others then
 if sqlerrm is distinct from '${q(expected)}' then raise exception '${label} expected ${q(expected)}, got %',sqlerrm; end if;
end;`;
const expectStatus=(label,statusExpected,body)=>`begin
 ${body}
 if r->>'status'<>'${q(statusExpected)}' then raise exception '${label} expected status ${q(statusExpected)}'; end if;
 raise exception '__R10_STATUS_ROLLBACK_${label}__';
exception when others then
 if sqlerrm is distinct from '__R10_STATUS_ROLLBACK_${label}__' then raise exception '${label} status assertion failed: %',sqlerrm; end if;
end;`;
const mutateBudget=(field,valueSql)=>`select request->'body'->>'raw' into tmp from clued_control.execution_events where root_id=root and sequence=102;
 tmpj:=tmp::jsonb||jsonb_build_object('${field}',${valueSql}); tmp:=tmpj::text;
 update clued_control.execution_events set request=jsonb_set(jsonb_set(request,'{body,raw}',to_jsonb(tmp)),
   '{body,sha256}',to_jsonb(encode(sha256(convert_to(tmp,'UTF8')),'hex'))) where root_id=root and sequence=102;`;
const mutateBudget117NoLf=`select request->'body'->>'raw' into tmp from clued_control.execution_events where root_id=root and sequence=117;
 if tmp is null or encode(sha256(convert_to(tmp,'UTF8')),'hex')<>'${budgetSha}' or right(tmp,1) is distinct from E'\n'
 then raise exception 'N06 exact immutable budget117 source required'; end if;
 tmp:=regexp_replace(tmp,E'\\n$','');
 g:=jsonb_set(g,'{budget_reservation_ref,sha256}',to_jsonb(encode(sha256(convert_to(tmp,'UTF8')),'hex')));`;

const probes={};
probes.N01_CHANGED_BYTES_SAME_IDEMPOTENCY=`begin
 ${makeGa('n01_first')} ${callGate}
 if r->>'status'<>'RESERVED' then raise exception 'N01 control reserve failed'; end if;
 g:=jsonb_set(g,'{signature}',to_jsonb('CHANGED_SQL_LAYER_PROBE'::text));
 raw:=g::text;h:=encode(sha256(convert_to(raw,'UTF8')),'hex');perform clued_control.reserve_gate(raw,h);
 raise exception '__UNEXPECTED_ACCEPT_N01__';
exception when others then if sqlerrm is distinct from 'idempotency_conflict' then raise exception 'N01 expected idempotency_conflict, got %',sqlerrm; end if; end;`;
probes.N02_SECOND_ROOT10_GA=`begin
 ${makeGa('n02_first')} ${callGate}
 if r->>'status'<>'RESERVED' then raise exception 'N02 control reserve failed'; end if;
 ${makeGa('n02_second')} raw:=g::text;h:=encode(sha256(convert_to(raw,'UTF8')),'hex');perform clued_control.reserve_gate(raw,h);
 raise exception '__UNEXPECTED_ACCEPT_N02__';
exception when others then if sqlerrm is distinct from 'root10_exact_single_ga_preimage_required' then raise exception 'N02 wrong rejection: %',sqlerrm; end if; end;`;
probes.N03_NONEMPTY_REPAIR_REFS=[
 expectError('N03_repair_refs','root10_exact_accepted_scope_or_zero_repairs_required',{mutate:`g:=g||jsonb_build_object('repair_refs',jsonb_build_array('forbidden'));`}),
 expectError('N03_required_repair_refs','root10_exact_accepted_scope_or_zero_repairs_required',{mutate:`g:=jsonb_set(g,'{revocation_epoch_vector}',coalesce(g->'revocation_epoch_vector','{}'::jsonb)||jsonb_build_object('required_repair_refs',jsonb_build_array('forbidden')));`})
].join('\n');
probes.N04_FIXED_SCHEMA_ISSUER_RISK_PROFILE_VECTOR_SOURCE_DRIFT=[
 ['schema_digest',`to_jsonb(repeat('0',64))`,'root10_complete_fixed_and_late_bound_ga_contract_required'],
 ['issuer_ref',`jsonb_build_object('uri','urn:probe:issuer','sha256',repeat('0',64))`,'root10_complete_fixed_and_late_bound_ga_contract_required'],
 ['release_risk_manifest_digest',`to_jsonb(repeat('0',64))`,'root10_complete_fixed_and_late_bound_ga_contract_required'],
 ['profile_digest',`to_jsonb(repeat('0',64))`,'root10_exact_accepted_scope_or_zero_repairs_required'],
 ['revocation_epoch_vector',`jsonb_build_object('probe','drift')`,'root10_complete_fixed_and_late_bound_ga_contract_required'],
 ['source_ref',`jsonb_build_object('commit',repeat('0',40))`,'root10_complete_fixed_and_late_bound_ga_contract_required']
].map(([field,value,error])=>expectError('N04_'+field,error,{mutate:`g:=jsonb_set(g,'{${field}}',${value});`})).join('\n');
probes.N05_STATUS_NOT_GENERATION29=expectError('N05_status','exact_stored_status29_required',{mutate:`g:=jsonb_set(g,'{status_manifest_ref}',jsonb_build_object('uri','control://status-manifests/sm_root10_wrong_generation','sha256',repeat('0',64)));`});
probes.N06_BUDGET_NOT117_OR_RAW_NO_LF=[
 expectError('N06_sequence','root10_exact_prior_committed_budget117_required',{mutate:`g:=jsonb_set(g,'{budget_reservation_ref,uri}',to_jsonb('urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:116'::text));`}),
 expectError('N06_sha','root10_exact_prior_committed_budget117_required',{mutate:`g:=jsonb_set(g,'{budget_reservation_ref,sha256}',to_jsonb(repeat('0',64)));`}),
 expectError('N06_no_lf','root10_exact_prior_committed_budget117_required',{mutate:mutateBudget117NoLf})
].join('\n');
probes.N07_NOT_EXACT_600_SECONDS=[599,601].map(seconds=>expectError('N07_'+seconds,'root10_exact_600_second_ga_window_required',{mutate:`g:=jsonb_set(jsonb_set(g,'{deadline}',to_jsonb(t0+interval '${seconds} seconds')),'{expires_at}',to_jsonb(t0+interval '${seconds} seconds'));`})).join('\n');
probes.N08_HISTORICAL_ATTEMPT_OR_RECEIPT_DRIFT=[
 expectError('N08_attempt_id','immutable_gate_bytes_or_decision',{setup:`update clued_control.gate_attempts set ga=jsonb_set(ga,'{gate_authorization_id}',to_jsonb('ga_00000000000000000000000000000000'::text)) where root_id=root and ga_id='ga_165dc2e72b62414a8023e726d8114f28';`}),
 expectError('N08_original_attempt','immutable_gate_bytes_or_decision',{setup:`update clued_control.gate_attempts set ga_raw=ga_raw||E' ' where root_id=root and ga_id='ga_165dc2e72b62414a8023e726d8114f28';`}),
 expectError('N08_ga6_receipt','immutable_gate_bytes_or_decision',{setup:`update clued_control.gate_attempts set receipt_raw=receipt_raw||E' ' where root_id=root and ga_id='${q(m.ga6_id)}';`}),
 expectError('N08_receipt_result','immutable_gate_bytes_or_decision',{setup:`select receipt_raw into tmp from clued_control.gate_attempts where root_id=root and ga_id='${q(m.ga6_id)}';tmpj:=tmp::jsonb||jsonb_build_object('result','FAIL');tmp:=tmpj::text;update clued_control.gate_attempts set receipt_raw=tmp,receipt_sha256=encode(sha256(convert_to(tmp,'UTF8')),'hex') where root_id=root and ga_id='${q(m.ga6_id)}';`}),
 expectError('N08_budget_binding','immutable_gate_bytes_or_decision',{setup:`update clued_control.gate_attempts set budget_sequence=101 where root_id=root and ga_id='${q(m.ga6_id)}';`})
].join('\n');
probes.N09_CONTAINER_OR_ACTIVE_PHASE_PREEXISTS=[`begin
 ${makeGa('n09_preexisting_root10')} ${callGate}
 if r->>'status'<>'RESERVED' then raise exception 'N09 Root10 preexisting control failed'; end if;
 ${makeGa('n09_after_preexisting')} raw:=g::text;h:=encode(sha256(convert_to(raw,'UTF8')),'hex');perform clued_control.reserve_gate(raw,h);
 raise exception '__UNEXPECTED_ACCEPT_N09_ACTIVE__';
exception when others then if sqlerrm is distinct from 'root10_exact_single_ga_preimage_required' then raise exception 'N09 active Root10 wrong rejection: %',sqlerrm; end if; end;`,
 expectError('N09_phase','immutable_gate_bytes_or_decision',{setup:`update clued_control.gate_attempts set phase='RUNNING' where root_id=root and ga_id='${q(m.ga6_id)}';`}),
 expectError('N09_container','immutable_gate_bytes_or_decision',{setup:`update clued_control.gate_attempts set container_id=repeat('a',64) where root_id=root and ga_id='${q(m.ga6_id)}';`})
].join('\n');
probes.N10_EXACT_RESPONSE_LOSS_REPLAY=expectStatus('N10','DUPLICATE',`${makeGa('n10_replay')} ${callGate}
 if r->>'status'<>'RESERVED' then raise exception 'N10 first reserve failed'; end if;
 r:=clued_control.reserve_gate(raw,h);`);
probes.N11_ROOT_OR_EXECUTION_IMMUTABLE_PREFIX_DRIFT=[
 expectError('N11_root','immutable_control_evidence',{setup:`update clued_control.events set request=request||jsonb_build_object('negative_probe',true) where root_id=root and sequence=1;`}),
 expectError('N11_execution','immutable_control_evidence',{setup:`update clued_control.execution_events set request=request||jsonb_build_object('negative_probe',true) where root_id=root and sequence=1;`})
].join('\n');
probes.N12_HISTORICAL_BUDGET_GENERATION_OR_EXPIRY_DRIFT=[
 expectError('N12_generation','immutable_control_evidence',{setup:mutateBudget('root_generation',`'${ROOT10}'`)}),
 expectError('N12_expiry','immutable_control_evidence',{setup:mutateBudget('expires_at',`'2026-09-15T02:59:59Z'`)} )
].join('\n');
probes.N13_GA6_CLOSURE_111_112_BYTES_DRIFT=[
 expectError('N13_decision_raw','immutable_control_evidence',{setup:`select request->'body'->>'decision_raw' into tmp from clued_control.execution_events where root_id=root and sequence=111;tmp:=tmp||E' ';update clued_control.execution_events set request=jsonb_set(jsonb_set(request,'{body,decision_raw}',to_jsonb(tmp)),'{body,decision_sha256}',to_jsonb(encode(sha256(convert_to(tmp,'UTF8')),'hex'))) where root_id=root and sequence=111;`}),
 expectError('N13_evidence_raw','immutable_control_evidence',{setup:`select request->'body'->>'evidence_index_raw' into tmp from clued_control.execution_events where root_id=root and sequence=111;tmp:=tmp||E' ';update clued_control.execution_events set request=jsonb_set(jsonb_set(request,'{body,evidence_index_raw}',to_jsonb(tmp)),'{body,evidence_index_sha256}',to_jsonb(encode(sha256(convert_to(tmp,'UTF8')),'hex'))) where root_id=root and sequence=111;`}),
 expectError('N13_observation_raw','immutable_control_evidence',{setup:`select request->'body'->>'not_started_evidence_raw' into tmp from clued_control.execution_events where root_id=root and sequence=111;tmp:=tmp||E' ';h:=encode(sha256(convert_to(tmp,'UTF8')),'hex');update clued_control.execution_events set request=jsonb_set(jsonb_set(request,'{body,not_started_evidence_raw}',to_jsonb(tmp)),'{body,not_started_evidence_ref}',jsonb_build_object('uri','urn:clued:execution-evidence:${ROOT}:'||h,'sha256',h)) where root_id=root and sequence=111;`}),
 expectError('N13_idempotency','immutable_control_evidence',{setup:`update clued_control.execution_events set idempotency_key=idempotency_key||'_probe' where root_id=root and sequence=111;`}),
 expectError('N13_termination','immutable_control_evidence',{setup:`update clued_control.execution_events set request=jsonb_set(request,'{body,termination_mode}',to_jsonb('DRIFT'::text)) where root_id=root and sequence=111;`}),
 expectError('N13_signing_hash','immutable_control_evidence',{setup:`update clued_control.execution_events set request=jsonb_set(request,'{body,decision_sha256}',to_jsonb(repeat('0',64))) where root_id=root and sequence=112;`})
].join('\n');
probes.N14_EXACT_51_FIELD_SCHEMA_SHAPE_MISSING_OR_EXTRA=[
 expectError('N14_missing','root10_complete_fixed_and_late_bound_ga_contract_required',{mutate:`g:=g-'actor_ref';`}),
 expectError('N14_extra','root10_complete_fixed_and_late_bound_ga_contract_required',{mutate:`g:=g||jsonb_build_object('unexpected_probe_field',true);`})
].join('\n');
const trans=(label,op,body,error)=>`begin
 perform clued_control.execution_transition(jsonb_build_object('operation','${op}','ga_id',g->>'gate_authorization_id','expected_sequence',117,'idempotency_key','${idem(label)}','body',${body}));
 raise exception '__UNEXPECTED_TRANSITION_${label}__';
exception when others then if sqlerrm is distinct from '${error}' then raise exception '${label} wrong rejection: %',sqlerrm; end if; end;`;
probes.N15_CONTAINER_PHASE_MACHINE_DRIFT=`begin
 ${makeGa('n15_active')} ${callGate}
 if r->>'status'<>'RESERVED' then raise exception 'N15 control reserve failed'; end if;
 ${trans('N15_created','CREATED',`'{}'::jsonb`,'exact_container_missing')}
 ${trans('N15_running','RUNNING',`jsonb_build_object('container_id',repeat('b',64))`,'phase_or_container_conflict')}
 ${trans('N15_stopped','STOPPED',`jsonb_build_object('container_id',repeat('b',64),'observation_sha256',repeat('c',64))`,'stopped_observation_missing')}
 ${trans('N15_dispatch_phase','START_SENT',`jsonb_build_object('intent_sha256',repeat('d',64),'intent_sequence',1)`,'phase_conflict')}
 raise exception '__R10_N15_ROLLBACK__';
exception when others then if sqlerrm is distinct from '__R10_N15_ROLLBACK__' then raise; end if; end;`;

const pre=`do $pre$
declare h clued_control.current_head;c clued_control.execution_current;d text;
begin
 select * into h from clued_control.current_head where root_id='${ROOT}' for update;
 select * into c from clued_control.execution_current where root_id='${ROOT}' for update;
 if h.sequence<>10 or h.generation_id<>'${ROOT10}' or h.revoked or c.sequence<>117 or c.pending_budget_sequence<>117 or c.active_ga_id is not null
 or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987
 or (select count(*) from clued_control.events where root_id=h.root_id)<>10
 or (select count(*) from clued_control.execution_events where root_id=h.root_id)<>117
 or (select count(*) from clued_control.gate_attempts where root_id=h.root_id)<>17
 or exists(select 1 from clued_control.gate_attempts where root_id=h.root_id and ga->>'control_trust_root_generation'='${ROOT10}')
 or not exists(select 1 from clued_control.control_objects where root_id=h.root_id and uri='control://status-manifests/${q(status.status_manifest_id)}' and sha256='${statusSha}' and generation=29)
 or not exists(select 1 from clued_control.execution_events where root_id=h.root_id and sequence=117 and idempotency_key='${q(intent.budget_idempotency_key)}'
   and request=jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',convert_from(decode('${b64(budgetRaw)}','base64'),'UTF8'),'sha256','${budgetSha}')))
 or clock_timestamp()<'${q(intent.not_before)}'::timestamptz or clock_timestamp()+interval '600 seconds'>='${q(intent.expires_at)}'::timestamptz
 then raise exception 'ROOT10_NEGATIVE_PROBE_POSTACTIVATION_PREIMAGE_REQUIRED';end if;
 foreach d in array array['clued_control.reserve_gate(text,text)','clued_control.execution_transition(jsonb)'] loop
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(d) and p.proowner='postgres'::regrole and p.prosecdef
   and p.proconfig @> array['search_path=""','TimeZone=UTC']::text[]) then raise exception 'ROOT10_NEGATIVE_PROBE_FUNCTION_SECURITY_REQUIRED: %',d;end if;
  if d='clued_control.execution_transition(jsonb)' and encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(d)),'UTF8')),'hex')<>'${transitionSha}'
   then raise exception 'ROOT10_NEGATIVE_PROBE_PINNED_PHASE_MACHINE_REQUIRED';end if;
 end loop;
end $pre$;`;
const buildSql=id=>`-- ${id}; exact accepted plan; post-activation/pre-GA only; all writes roll back.
-- activation_full_rollback_sha256=${fullSha}
-- activation_materials_sha256=${sha(read(materialsPath))}
-- authority_effect=NONE; synthetic SQL-layer signature is not execution authority.
begin;
set local lock_timeout='5s';set local statement_timeout='120s';
${pre}
do $probe$
declare root constant text:='${ROOT}';base_ga jsonb:=${fixedExpr};g jsonb;raw text;h text;r jsonb;tmp text;tmpj jsonb;
 t0 timestamptz:=greatest(clock_timestamp()-interval '1 second','${q(intent.not_before)}'::timestamptz);
begin
 ${positive(id)}
 ${probes[id]}
end $probe$;
select jsonb_build_object('state','ROOT10_NEGATIVE_ASSERTIONS_SATISFIED_ROLLBACK','probe_id','${id}','authority_effect','NONE');
rollback;
`;
const files=ids.map(id=>({name:`root10-negative.${id}.rollback.sql`,content:buildSql(id)}));
const all=files.map(f=>f.content).join('\n');
files.push({name:'root10-negative.all.rollback.sql',content:all});
for(const f of files)f.sha256=sha(f.content);
const outManifest={schema_version:'root10-negative-probes-build/1',state:'LOCAL_ROLLBACK_PROBES_BUILT_NOT_EXECUTED',authority_effect:'NONE',
 activation_full_rollback_sha256:fullSha,activation_materials_sha256:sha(read(materialsPath)),accepted_plan_sha256:planSha,
 root_id:ROOT,generation_id:ROOT10,p2_owner_merge_commit:p2,status29_full_sha256:statusSha,budget117_sha256:budgetSha,
 rejection_layers:{N06_no_lf:'RESERVE_GATE_EXACT_BUDGET117_GUARD_WITH_IMMUTABLE_SOURCE',N08:'GATE_BYTES_IMMUTABILITY_TRIGGER',N09_historical_mutations:'GATE_BYTES_IMMUTABILITY_TRIGGER',N11:'IMMUTABILITY_TRIGGER',N12:'IMMUTABILITY_TRIGGER',N13:'IMMUTABILITY_TRIGGER'},
 probe_count:15,subcase_count:2+1+2+6+1+3+2+5+3+1+2+2+6+2+4,run_after_activation_before_final_ga:true,
 live_executed:false,ga_issued:false,files:Object.fromEntries(files.map(f=>[f.name,f.sha256]))};
const manifestContent=JSON.stringify(outManifest,null,2)+'\n';
files.push({name:'root10-negative-probes.build.json',content:manifestContent,sha256:sha(manifestContent)});
const result={ok:true,write_performed:outArg!=='--stdout',files};
if(outArg==='--stdout')process.stdout.write(JSON.stringify(result));
else{const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});for(const f of files)fs.writeFileSync(path.join(out,f.name),f.content,'utf8');
 process.stdout.write(JSON.stringify({ok:true,outdir:out,files:files.map(({name,sha256})=>({name,sha256}))},null,2)+'\n');}
