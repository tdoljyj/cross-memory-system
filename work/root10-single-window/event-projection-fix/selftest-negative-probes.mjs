#!/usr/bin/env node
// Synthetic generator regression only. This never opens a database connection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1'));
const repo=path.resolve(here,'../../..'),builder=path.join(here,'build-root10-negative-probes.mjs');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const td=fs.mkdtempSync(path.join(os.tmpdir(),'root10-negative-selftest-'));
const put=(name,value)=>{const raw=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';const p=path.join(td,name);fs.writeFileSync(p,raw);return {p,raw,sha:sha(raw)}};
const ids=['N01_CHANGED_BYTES_SAME_IDEMPOTENCY','N02_SECOND_ROOT10_GA','N03_NONEMPTY_REPAIR_REFS','N04_FIXED_SCHEMA_ISSUER_RISK_PROFILE_VECTOR_SOURCE_DRIFT','N05_STATUS_NOT_GENERATION29','N06_BUDGET_NOT117_OR_RAW_NO_LF','N07_NOT_EXACT_600_SECONDS','N08_HISTORICAL_ATTEMPT_OR_RECEIPT_DRIFT','N09_CONTAINER_OR_ACTIVE_PHASE_PREEXISTS','N10_EXACT_RESPONSE_LOSS_REPLAY','N11_ROOT_OR_EXECUTION_IMMUTABLE_PREFIX_DRIFT','N12_HISTORICAL_BUDGET_GENERATION_OR_EXPIRY_DRIFT','N13_GA6_CLOSURE_111_112_BYTES_DRIFT','N14_EXACT_51_FIELD_SCHEMA_SHAPE_MISSING_OR_EXTRA','N15_CONTAINER_PHASE_MACHINE_DRIFT'];
const fixtures=[
 {id:ids[0],expected_error:'idempotency_conflict',mutation:'same idempotency key with different GA bytes'},
 {id:ids[1],expected_error:'root10_exact_single_ga_preimage_required',mutation:'new GA id/idempotency after first reservation'},
 {id:ids[2],expected_error:'root10_exact_accepted_scope_or_zero_repairs_required',mutation:'one repair_refs entry'},
 {id:ids[3],expected_error_one_of:['root10_exact_accepted_scope_or_zero_repairs_required','root10_complete_fixed_and_late_bound_ga_contract_required'],mutation:'change each fixed field one at a time'},
 {id:ids[4],expected_error:'exact_stored_status29_required',mutation:'status ref points at a different stored generation'},
 {id:ids[5],expected_error:'root10_exact_prior_committed_budget117_required',mutation:'budget reference/hash/raw bytes differ'},
 {id:ids[6],expected_error:'root10_exact_600_second_ga_window_required',mutation:'599 or 601 second interval'},
 {id:ids[7],expected_error_one_of:['series_original_six_attempts_changed','root10_exact_single_ga_preimage_required'],mutation:'attempt id/raw/receipt/result/budget binding differs'},
 {id:ids[8],expected_error:'root10_exact_single_ga_preimage_required',mutation:'active Root10 GA or nonterminal historical phase exists'},
 {id:ids[9],expected_status:'DUPLICATE',mutation:'same exact raw and hash after successful reserve'},
 {id:ids[10],expected_error_one_of:['series_full_original_root_changed','series_original_44_events_changed'],mutation:'change one Root<=8 or execution<=44 request field'},
 {id:ids[11],expected_error:'root10_exact_single_ga_preimage_required',mutation:'change one post-44 budget root_generation or historical expires_at'},
 {id:ids[12],expected_error:'root10_exact_single_ga_preimage_required',mutation:'change a decision/evidence/observation raw byte, idempotency key, termination mode, or signing decision hash'},
 {id:ids[13],expected_error:'root10_complete_fixed_and_late_bound_ga_contract_required',also_expected_rejection_layer:'trusted host schema/runtime-acceptance verifier before reserve_gate',mutation:'remove any required field or add any field outside the original 51-field schema'},
 {id:ids[14],expected_rejection_layer:'unchanged pinned execution_transition',mutation:'CREATED/RUNNING/STOPPED with missing or mismatched container_id, or dispatch from a nonmatching phase'}
];
const fixedKeys=['gate_id','profile_ref','purpose','environment','repository_ref','artifact_refs','host_runtime_config_digest','upstream_gate_result_receipt_refs','release_risk_manifest_digest','actor_ref','subject_ref','binding_ref','scope_ref','issuer_ref','authority_source_ref','audience','issuer_purpose','schema_digest','control_trust_root_generation','allowed_read_set','allowed_write_set','forbidden_actions','credential_scope','stop_policy_digest','rollback_point_ref','evidence_sink_ref','controller_digest','candidate_skill_digest','mechanism_digest','plan_digest','fixtures_digest','stage_receipt_refs','revocation_epoch_vector','scope_digest','profile_digest','dominant_role','source_ref','controller_qualification_ref'];
const intentPath=path.join(repo,'work/new-window/Root10Intent.json'),livePath=path.join(repo,'work/new-window/live-preimage-seq110.json');
const intent=JSON.parse(fs.readFileSync(intentPath,'utf8')),controller='5'.repeat(64);
const fixed=Object.fromEntries(fixedKeys.map(k=>[k,'fixture']));Object.assign(fixed,{gate_id:'G-PREENTRY-SKILL-QUALIFICATION',profile_digest:intent.profile_sha256,scope_digest:intent.scope_sha256,controller_digest:controller,control_trust_root_generation:intent.generation_id,purpose:'SKILL_COEXISTENCE_QUALIFICATION',environment:'ISOLATED_TEST',artifact_refs:[],upstream_gate_result_receipt_refs:[],allowed_read_set:[],allowed_write_set:[],forbidden_actions:[],stage_receipt_refs:[],revocation_epoch_vector:{repair_refs:[]}});
const status=put('Status29.full.json',{object_type:'StatusManifest',status_manifest_id:intent.status_manifest_id,generation:29,control_trust_root_generation:intent.generation_id,signature_binding:{owner_merge_commit:'4'.repeat(40),signed_object_sha256:'6'.repeat(64)}});
const qual=put('qualification.json',{state:'ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION',controller_digest:controller,required_repair_refs:[]});
const runtime=put('runtime.json',{state:'ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME',controller_digest:controller,required_repair_refs:[],accepted_subject:{expected_ga:fixed}});
const prepared=put('prepared.json',{controller_sha256:controller,qualification_sha256:qual.sha});
const qualified=put('qualified.json',{required_repair_refs:[],acceptance_publication_ref:{uri:'urn:test:p2',sha256:runtime.sha}});
const materials={intent_path:intentPath,live_preimage_path:livePath,live_function_catalog_path:path.join(repo,'work/new-window/live-function-catalog.json'),status29_signed_path:status.p,status29_full_sha256:status.sha,runtime_acceptance_path:runtime.p,runtime_acceptance_sha256:runtime.sha,controller_qualification_path:qual.p,controller_qualification_sha256:qual.sha,prepared_evidence_path:prepared.p,qualified_evidence_path:qualified.p,controller_sha256:controller,gate_id:'G-PREENTRY-SKILL-QUALIFICATION',ga6_id:'ga_6addc4f9764b69ba8c10d258135ae0d4'};
const mat=put('materials.json',materials),live=JSON.parse(fs.readFileSync(livePath,'utf8'));
const budget={controller_digest:controller,credential_generation:live.execution.current.credential_generation,environment:'ISOLATED_TEST',evidence_bytes:134217728,expires_at:intent.expires_at,idempotency_key:intent.budget_idempotency_key,not_before:intent.not_before,profile_digest:intent.profile_sha256,purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:intent.generation_id,runner_generation:live.execution.current.runner_generation,scope_digest:intent.scope_sha256,seconds:600,session_generation:live.execution.current.session_generation};
const budgetRaw=JSON.stringify(budget)+'\n',budgetSha=sha(budgetRaw);
const activationPayload={schema_version:'root10-activation-request/1',root_registration:{fixture:true},binding_raw:'{}',binding_sha256:sha('{}'),
 status_raw:status.raw,status_sha256:status.sha,prepared_evidence:JSON.parse(prepared.raw),qualified_evidence:JSON.parse(qualified.raw),
 runtime_acceptance_raw:runtime.raw,runtime_acceptance_sha256:runtime.sha,budget_raw:budgetRaw,budget_sha256:budgetSha};
const activationPayloadBase64=Buffer.from(JSON.stringify(activationPayload),'utf8').toString('base64');
const full=`begin;\nCREATE OR REPLACE FUNCTION clued_control.read_root(text) RETURNS jsonb AS $function$ begin return null; end $function$ language plpgsql;\nCREATE OR REPLACE FUNCTION clued_control.reserve_execution_budget(text,text) RETURNS jsonb AS $function$ begin return null; end $function$ language plpgsql;\nCREATE OR REPLACE FUNCTION clued_control.reserve_gate(text,text) RETURNS jsonb AS $function$ begin return null; end $function$ language plpgsql;\ndo $activate$ declare p jsonb:=convert_from(decode('${activationPayloadBase64}','base64'),'UTF8')::jsonb; begin null; end $activate$;\n-- ROOT10_ACTIVATION_POSTIMAGE_FAILED ${intent.generation_id} ${budgetSha} ${runtime.sha} ${qual.sha} ${controller}\nrollback;\n`;
const fullFile=put('root10-activation.full-rollback.sql',full);
const plan=put('reserve_gate.actual-negative-fixtures.json',{schema_version:'root10-reserve-gate-negative-fixtures/1',run_after_activation_before_final_ga:true,authority_effect:'NONE',fixtures});
put('root10-activation.build.json',{pins:{budget_sha256:budgetSha,status29_full_sha256:status.sha,controller_sha256:controller},files:{'root10-activation.full-rollback.sql':fullFile.sha,'reserve_gate.actual-negative-fixtures.json':plan.sha}});

const checks=[];let out;
try{out=JSON.parse(execFileSync(process.execPath,[builder,fullFile.p,mat.p,'--stdout'],{encoding:'utf8',maxBuffer:32*1024*1024}));checks.push(['synthetic build',out.ok]);}catch(e){console.error(e.stderr?.toString()||e.stack);checks.push(['synthetic build',false]);out={files:[]};}
const sqlFiles=out.files.filter(f=>/^root10-negative\.N\d\d_.*[.]rollback[.]sql$/.test(f.name));
const by=id=>sqlFiles.find(f=>f.name===`root10-negative.${id}.rollback.sql`)?.content||'';
checks.push(['exact fifteen files',sqlFiles.length===15&&ids.every(id=>by(id))]);
checks.push(['transaction rollback only',sqlFiles.every(f=>/^-- /m.test(f.content)&&/\nbegin;/.test(f.content)&&f.content.trimEnd().endsWith('rollback;')&&!/\ncommit;/i.test(f.content))]);
checks.push(['postactivation boundary',sqlFiles.every(f=>f.content.includes('c.sequence<>117')&&f.content.includes('pending_budget_sequence<>117')&&f.content.includes('active_ga_id is not null'))]);
checks.push(['valid control before rejection',sqlFiles.every(f=>f.content.includes('valid control failed'))]);
checks.push(['N01 byte idempotency',by(ids[0]).includes('idempotency_conflict')&&by(ids[0]).includes('CHANGED_SQL_LAYER_PROBE')]);
checks.push(['N02 second GA',by(ids[1]).includes('root10_exact_single_ga_preimage_required')]);
checks.push(['N03 both repair paths',['repair_refs','required_repair_refs'].every(x=>by(ids[2]).includes(x))]);
checks.push(['N04 six fixed dimensions',['schema_digest','issuer_ref','release_risk_manifest_digest','profile_digest','revocation_epoch_vector','source_ref'].every(x=>by(ids[3]).includes(x))]);
checks.push(['N05 Status29',by(ids[4]).includes('exact_stored_status29_required')]);
checks.push(['N06 budget ref hash and immutable LF source',['execution-events:116','N06_sha','regexp_replace','N06 exact immutable budget117 source required'].every(x=>by(ids[5]).includes(x))&&!by(ids[5]).includes('update clued_control.execution_events')]);
checks.push(['N07 599 and 601',['599 seconds','601 seconds'].every(x=>by(ids[6]).includes(x))]);
checks.push(['N08 attempt receipt result and exact immutable layer',['N08_attempt_id','immutable_gate_bytes_or_decision','receipt_raw','N08_receipt_result','budget_sequence=101'].every(x=>by(ids[7]).includes(x))&&!by(ids[7]).includes('series_original_six_attempts_changed')]);
checks.push(['N09 Root10 active plus exact historical immutable layer',['n09_preexisting_root10','root10_exact_single_ga_preimage_required','phase=','container_id','immutable_gate_bytes_or_decision'].every(x=>by(ids[8]).includes(x))]);
checks.push(['N10 exact replay',by(ids[9]).includes("r:=clued_control.reserve_gate(raw,h)")&&by(ids[9]).includes("'DUPLICATE'")]);
checks.push(['N11 root and execution exact immutable layer',['clued_control.events','clued_control.execution_events','immutable_control_evidence'].every(x=>by(ids[10]).includes(x))&&!by(ids[10]).includes('series_full_original_root_changed')]);
checks.push(['N12 generation and expiry exact immutable layer',['root_generation','expires_at','immutable_control_evidence'].every(x=>by(ids[11]).includes(x))]);
checks.push(['N13 all closure drift exact immutable layer',['decision_raw','evidence_index_raw','not_started_evidence_raw','idempotency_key=idempotency_key','termination_mode','N13_signing_hash','immutable_control_evidence'].every(x=>by(ids[12]).includes(x))]);
checks.push(['N14 missing and extra',["g:=g-'actor_ref'",'unexpected_probe_field'].every(x=>by(ids[13]).includes(x))]);
checks.push(['N15 four phase guards',['exact_container_missing','phase_or_container_conflict','stopped_observation_missing','phase_conflict'].every(x=>by(ids[14]).includes(x))]);
checks.push(['pinned phase machine',sqlFiles.every(f=>f.content.includes('ROOT10_NEGATIVE_PROBE_PINNED_PHASE_MACHINE_REQUIRED'))]);
checks.push(['combined and manifest',out.files.some(f=>f.name==='root10-negative.all.rollback.sql')&&out.files.some(f=>f.name==='root10-negative-probes.build.json')]);
const builtManifest=JSON.parse(out.files.find(f=>f.name==='root10-negative-probes.build.json')?.content||'{}');
checks.push(['actual rejection layers explicit',builtManifest.rejection_layers?.N08==='GATE_BYTES_IMMUTABILITY_TRIGGER'&&builtManifest.rejection_layers?.N11==='IMMUTABILITY_TRIGGER'&&builtManifest.rejection_layers?.N06_no_lf==='RESERVE_GATE_EXACT_BUDGET117_GUARD_WITH_IMMUTABLE_SOURCE']);
checks.push(['no authority clients',!/(gh api|supabase|psql|docker)/i.test(fs.readFileSync(builder,'utf8'))]);
fs.writeFileSync(plan.p,JSON.stringify({...JSON.parse(plan.raw),fixtures:[...fixtures].reverse()},null,2)+'\n');
let rejected=false;try{execFileSync(process.execPath,[builder,fullFile.p,mat.p,'--stdout'],{stdio:'pipe'});}catch(e){rejected=/(full rollback\/plan not bound|exact accepted fifteen-item plan required)/.test(String(e.stderr));}
checks.push(['plan drift rejected',rejected]);
let failed=false;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);failed||=!ok;}console.log(`PASS ${checks.filter(x=>x[1]).length}/${checks.length} synthetic-only; live_executed=false`);if(failed)process.exit(1);
