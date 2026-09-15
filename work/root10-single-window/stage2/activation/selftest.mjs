#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1'));
const repo=path.resolve(here,'../../..');
const sha=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const canonicalDigest=v=>sha(JSON.stringify(ordered(v))+'\n');
const src=fs.readFileSync(path.join(here,'build-root10-activation.mjs'),'utf8');
const checks=[
 ['callback replacements',/replace\(root9MetaCase, \(\) =>/.test(src)&&/replace\(stateAnchor, \(\) =>/.test(src)],
 ['single-function closure guard',/closes !== 2/.test(src)],
 ['exact sequence chain',[113,114,115,116,117].every(n=>src.includes(String(n)))],
 ['Root10 zero repairs',src.includes('repair_refs !== 0')&&src.includes('Root10 carries repair refs')],
 ['closure forward count 17',src.includes('forwards_after_44: 17')],
 ['monotonic cap',src.includes('charged_seconds=charged_seconds+600')&&src.includes('charged_evidence_bytes=charged_evidence_bytes+134217728')],
 ['no external clients',!/(npx|docker|gh\s)/i.test(src)],
 ['activation issues no GA',(src.match(/insert into clued_control\.gate_attempts/g)||[]).length===1&&!src.includes('result:=clued_control.reserve_gate')],
 ['transaction postimage',src.includes('ROOT10_ACTIVATION_POSTIMAGE_FAILED')&&src.includes('commit;')],
 ['stdout envelope',src.includes("outArg==='--stdout'")&&src.includes('files')],
 ['historical gate invariants retained',['d34490fc17bf86e062fe28c1164193c735a49550d904e9ff2cd6b7167f766f43','48be880b2a66a396b388fce96e2429de9ce7394449b9cf21ff2250e299ad2e21','7f28f748c5ca671b9813232aebcd131c0ba1713469d530f1548c423505951bc2','b5ed3460a9447b8240155129c8901a1a3ec78c6ac980ed8c4fa3e4eb0997116c'].every(x=>src.includes(x))],
 ['exact closure and 51-field GA guards',src.includes('root9_ga6_single_window_close_decision_111')&&src.includes("exactKeys(fixedGa,fixedGaRequired")&&src.includes('allGaKeys.length!==51')],
];
const td=fs.mkdtempSync(path.join(os.tmpdir(),'root10-activation-selftest-'));
const put=(n,o)=>{const raw=typeof o==='string'?o:JSON.stringify(o);const p=path.join(td,n);fs.writeFileSync(p,raw);return {p,raw,sha:sha(raw)}};
try {
 const intent=JSON.parse(fs.readFileSync(path.join(repo,'work/new-window/Root10Intent.json'),'utf8'));
 const root=JSON.parse(fs.readFileSync(path.join(repo,'work/new-window/root/Root10ReviewSubject.json'),'utf8'));
 root.independent_acceptance_ref={uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+('a'.repeat(40)),sha256:'b057eb56b92b94109f9aec965a22c08433691e4f3e6d99ba1def4f4011abc966'};
 root.signature_binding={owner_merge_commit:'1'.repeat(40),signed_object_sha256:'',signature_evidence_ref:{uri:'urn:test:root-signature',sha256:'3'.repeat(64)}}; const rootPayload=structuredClone(root);delete rootPayload.signature_binding;root.signature_binding.signed_object_sha256=canonicalDigest(rootPayload);
 const rf=put('root.json',root);
 const controllerDigest='5'.repeat(64);
 const statusObj={object_type:'StatusManifest',status_manifest_id:intent.status_manifest_id,generation:29,control_trust_root_generation:intent.generation_id,schema_digest:'6f9a6799109cbad00b4e615b58f535f91fe0ec4a53790fa744000caa2bf3282e',issuer_purpose:'STATUS',audience:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',issuer_ref:root.issuer_bindings.find(x=>x.purpose==='STATUS').qualification_ref,expires_at:intent.expires_at,observations:{root_set_id:intent.root_id,root_generation:intent.generation_id,profile_digest:intent.profile_sha256,scope_digest:intent.scope_sha256,gate_digest:intent.gate_sha256,controller_digest:controllerDigest},source_digests:[intent.profile_sha256,intent.scope_sha256,intent.gate_sha256,controllerDigest]}; const statusSignedPayloadSha=canonicalDigest(statusObj);statusObj.signature_binding={owner_merge_commit:'4'.repeat(40),signed_object_sha256:statusSignedPayloadSha};const sf=put('status.json',statusObj);
 const common={controller_digest:controllerDigest,scope_digest:intent.scope_sha256,not_before:intent.not_before,expires_at:intent.expires_at,repair_refs:[]};
 const fixedKeys=['gate_id','profile_ref','purpose','environment','repository_ref','artifact_refs','host_runtime_config_digest','upstream_gate_result_receipt_refs','release_risk_manifest_digest','actor_ref','subject_ref','binding_ref','scope_ref','issuer_ref','authority_source_ref','audience','issuer_purpose','schema_digest','control_trust_root_generation','allowed_read_set','allowed_write_set','forbidden_actions','credential_scope','stop_policy_digest','rollback_point_ref','evidence_sink_ref','controller_digest','candidate_skill_digest','mechanism_digest','plan_digest','fixtures_digest','stage_receipt_refs','revocation_epoch_vector','scope_digest','profile_digest','dominant_role','source_ref','controller_qualification_ref'];
 const expected_ga=Object.fromEntries(fixedKeys.map(k=>[k,'fixture'])); Object.assign(expected_ga,{gate_id:'G-PREENTRY-SKILL-QUALIFICATION',purpose:'SKILL_COEXISTENCE_QUALIFICATION',environment:'ISOLATED_TEST',controller_digest:common.controller_digest,scope_digest:intent.scope_sha256,profile_digest:intent.profile_sha256,control_trust_root_generation:intent.generation_id,artifact_refs:[],upstream_gate_result_receipt_refs:[],allowed_read_set:[],allowed_write_set:[],forbidden_actions:[],stage_receipt_refs:[],revocation_epoch_vector:{repair_refs:[]}});
 const qf=put('qualification.json',{...common,state:'ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION',independent_reviewer:'/root',environment:'ISOLATED_TEST',purpose:'SKILL_COEXISTENCE_QUALIFICATION',independent_of_tested_skill:true,forbidden_stage_dependencies_excluded:true}), af=put('runtime.json',{...common,state:'ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME',independent_reviewer:'/root',accepted_subject:{root_id:intent.root_id,project_ref:'uscrdifznmlvczcekqpw',gate:{gate_id:'G-PREENTRY-SKILL-QUALIFICATION',definition_version:'fixed-synthetic-20260910.v10-env-order-repair',content_digest:intent.gate_sha256},expected_ga,late_bound_fields:{budget_reservation_ref:{resolver:'CURRENT_EXACT_EXECUTION_BUDGET_EVENT_V1',maximum_seconds:600,maximum_evidence_bytes:134217728},status_manifest_ref:{resolver:'STORED_STATUS_FROM_EXACT_OWNER_SIGNED_PAYLOAD_V1',signed_payload_sha256:statusSignedPayloadSha},target_revision:{resolver:'ACTUAL_RUNTIME_AND_SOURCE_MANIFEST_OWNER_MERGE_V1'}}}});
 const pf=put('prepared.json',{controller_sha256:common.controller_digest,qualification_sha256:qf.sha});
 const ef=put('qualified.json',{required_repair_refs:[],acceptance_publication_ref:{uri:'urn:test:acceptance',sha256:af.sha}});
 const contract=JSON.parse(fs.readFileSync(path.join(repo,'work/new-window/controller/Root10ControllerContract.candidate.json'),'utf8'));
 contract.ready=true; contract.baseline.execution_sequence=112; contract.baseline.historical_preimage110={execution_events_sha256:'7'.repeat(64),other_attempts_sha256:'8'.repeat(64),attempt_ids:['ga_6addc4f9764b69ba8c10d258135ae0d4',...Array.from({length:16},(_,i)=>`ga_${String(i).padStart(32,'0')}`)]}; Object.assign(contract.baseline.closure,{ga_id:'ga_6addc4f9764b69ba8c10d258135ae0d4',ga_sha256:'327bb92ca8a27f8e67eac06daaa27afa5df99814823fe0a2eb69b7c41747641a',budget_sequence:102,decision_sequence:111,signing_sequence:112,receipt_sha256:'6'.repeat(64)}); contract.baseline.series_forward_count=17; contract.postbaseline.budget_sequence=117;
 const cf=put('contract.json',contract);
 const rr=path.join(repo,'work/new-window/live-functions/read_root.sql'), rb=path.join(repo,'work/new-window/live-functions/reserve_execution_budget.sql'), rg=path.join(repo,'work/new-window/live-functions/reserve_gate.sql');
 const mat={intent_path:path.join(repo,'work/new-window/Root10Intent.json'),live_preimage_path:path.join(repo,'work/new-window/live-preimage-seq110.json'),live_function_catalog_path:path.join(repo,'work/new-window/live-function-catalog.json'),live_constraints_path:path.join(repo,'work/new-window/live-constraints.json'),root10_signed_path:rf.p,root10_full_sha256:rf.sha,predecessor_root_sha256:root.predecessor.sha256,root9_binding_sha256:'d3c597a2425343bb6fb897e4a6eaddd76cb73adf282a8cd07187e23a527cd76e',status29_signed_path:sf.p,status29_full_sha256:sf.sha,status_schema_sha256:'6f9a6799109cbad00b4e615b58f535f91fe0ec4a53790fa744000caa2bf3282e',controller_qualification_path:qf.p,controller_qualification_sha256:qf.sha,runtime_acceptance_path:af.p,runtime_acceptance_sha256:af.sha,prepared_evidence_path:pf.p,qualified_evidence_path:ef.p,root10_controller_contract_path:cf.p,root10_controller_contract_sha256:cf.sha,controller_sha256:common.controller_digest,gate_id:'G-PREENTRY-SKILL-QUALIFICATION',gate_version:'fixed-synthetic-20260910.v10-env-order-repair',ga6_id:'ga_6addc4f9764b69ba8c10d258135ae0d4',ga6_sha256:'327bb92ca8a27f8e67eac06daaa27afa5df99814823fe0a2eb69b7c41747641a',ga6_blocked_receipt_sha256:'6'.repeat(64),activation_idempotency_key:'root10_single_window_activation_20260915',current_read_root_sql_path:rr,current_read_root_file_sha256:sha(fs.readFileSync(rr,'utf8')),current_read_root_catalog_sha256:'ef6935ebdfa0c8f5c4a18dc6e7386d035ba9b076cef070d3af7b2acdb13a0667',current_reserve_budget_sql_path:rb,current_reserve_budget_file_sha256:sha(fs.readFileSync(rb,'utf8')),current_reserve_budget_catalog_sha256:'719f007c615949ee57fd0ebf9a1760de103d3c2e98e6eb4fec402325992a6532',current_reserve_gate_sql_path:rg,current_reserve_gate_file_sha256:sha(fs.readFileSync(rg,'utf8')),current_reserve_gate_catalog_sha256:'9b2697a5d779073e8cfa658b9c0f1214c244d9b5eab33175703a6ee31db1dc00'};
 const mf=put('materials.json',mat);
 const out=JSON.parse(execFileSync(process.execPath,[path.join(here,'build-root10-activation.mjs'),mf.p,'--stdout'],{encoding:'utf8',maxBuffer:32*1024*1024}));
 const apply=out.files.find(x=>x.name==='root10-activation.apply-once.sql')?.content||'';
 checks.push(['full parameterized stdout build',out.ok&&out.files.length===9]);
 checks.push(['three closed generated functions',(apply.match(/CREATE OR REPLACE FUNCTION/g)||[]).length===3&&(apply.match(/\$function\$/g)||[]).length===6]);
 checks.push(['generated read_root clean',!/^\+/m.test(out.files.find(x=>x.name==='read_root.root10.sql').content)]);
 const fullRollback=out.files.find(x=>x.name==='root10-activation.full-rollback.sql')?.content||'';
 checks.push(['full rollback executes activation',fullRollback===apply.replace(/\ncommit;\s*$/,()=> '\nrollback;\n')&&fullRollback.includes('ROOT10_ACTIVATION_POSTIMAGE_FAILED')&&fullRollback.includes("'function_sha256',jsonb_build_object")&&fullRollback.trim().endsWith('rollback;')&&!/\ncommit;\s*$/.test(fullRollback)]);
 checks.push(['preimage-only fixture',out.files.find(x=>x.name==='root10-activation.preimage-only.sql').content.trim().endsWith('rollback;')]);
} catch(e) { checks.push(['full parameterized stdout build',false]); console.error(e.stderr?.toString()||e.stack); }
for(const [n,ok] of checks) console.log(`${ok?'PASS':'FAIL'} ${n}`);
if(checks.some(x=>!x[1])) process.exit(1);
console.log(`PASS ${checks.length}/${checks.length}`);
