import fs from 'node:fs';
import crypto from 'node:crypto';

const stage2='/tmp/root9-exact-pair-stage2-20260915a';
const stage3='/tmp/root9-exact-pair-stage3-20260915a';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(v,m)=>{if(!v)throw Error(m);};
const runtimeRaw=fs.readFileSync(stage3+'/RuntimeAcceptance.root9.exact-pair.json','utf8');
const statusRaw=fs.readFileSync(stage3+'/Status28Generation.json','utf8');
const qualificationRaw=fs.readFileSync(stage2+'/ControllerQualification.root9.exact-pair.candidate.json','utf8');
const runtimeSha=sha(runtimeRaw),statusSha=sha(statusRaw),qualificationSha=sha(qualificationRaw);
need(runtimeSha==='2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df','RUNTIME_SHA');
need(statusSha==='4a6dddd73433b51aa1339ae2ebcd08f0d170f71d8ec35e9fb5905efecb3f5944','STATUS_SHA');
need(qualificationSha==='3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa','QUALIFICATION_SHA');
for(const [tag,raw] of [['status28',statusRaw],['runtime28',runtimeRaw],['qualification28',qualificationRaw]])need(!raw.includes(`$${tag}$`),'DOLLAR_TAG_COLLISION');

const sql=`-- SEALED CANDIDATE. Execute only after this exact file is Owner-published and an independent reviewer gives final GO.
-- Exact writes: append Status28; append execution events 105/106; expected-current CAS sequence 104->106.
-- It does not terminate the old GA, sign a GRR/GA, reserve an attempt, allocate budget, refund, or change capacity.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $root9_exact_pair_cas$
declare
 root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878';
 old_ga constant text:='ga_4a88b0436cf80beeb5e194c98bb0297e';
 old_ga_sha constant text:='50583449ba31202aa5a7cbb908ff82e556baf95bc6a8734c5b8e58890d6d8819';
 root9 constant text:='ctrgen_308a1dfc185cff633892638581e0a34c';
 old_controller constant text:='c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a';
 new_controller constant text:='9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1';
 old_qualification constant text:='a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013';
 new_qualification constant text:='${qualificationSha}';
 old_acceptance constant text:='c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552';
 new_acceptance constant text:='${runtimeSha}';
 budget_sha constant text:='51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a';
 status_sha constant text:='${statusSha}';
 status_uri constant text:='control://status-manifests/sm_root9_status28_exact_pair_recovery_v1';
 q_idem constant text:='root9_exact_pair_successor_v1_qualification';
 r_idem constant text:='root9_exact_pair_successor_v1_repoint';
 status_raw constant text:=$status28$${statusRaw}$status28$;
 runtime_raw constant text:=$runtime28$${runtimeRaw}$runtime28$;
 qualification_raw constant text:=$qualification28$${qualificationRaw}$qualification28$;
 c clued_control.execution_current; h clued_control.current_head; a clued_control.gate_attempts;
 b record; budget clued_control.execution_events; q_old clued_control.execution_events; r_old clued_control.execution_events;
 status_result jsonb; old_binding jsonb; new_binding jsonb; inheritance jsonb; repair_refs jsonb;
 evidence jsonb; q_req jsonb; r_req jsonb; fingerprint text; fn record;
begin
 if encode(sha256(convert_to(status_raw,'UTF8')),'hex') is distinct from status_sha
 or encode(sha256(convert_to(runtime_raw,'UTF8')),'hex') is distinct from new_acceptance
 or encode(sha256(convert_to(qualification_raw,'UTF8')),'hex') is distinct from new_qualification
 then raise exception 'sealed_payload_hash_mismatch'; end if;
 if not(status_raw is json object with unique keys) or not(runtime_raw is json object with unique keys) or not(qualification_raw is json object with unique keys)
 then raise exception 'sealed_payload_unique_json_required'; end if;
 if (status_raw::jsonb)->>'status_manifest_id' is distinct from 'sm_root9_status28_exact_pair_recovery_v1'
 or (status_raw::jsonb)->'generation' is distinct from '28'::jsonb
 or (status_raw::jsonb)->'signature_binding'->>'owner_merge_commit' is distinct from 'ec6e3df1cc36d4ef8dbd2bfb91555aa5a604f5b6'
 or (status_raw::jsonb)->'signature_binding'->>'signed_object_sha256' is distinct from 'a765cc9a6506c8486cb46087cbfa0c9f81f0ff03df23cb0dd421ea83f877a154'
 or (status_raw::jsonb)->'observations'->>'controller_digest' is distinct from new_controller
 then raise exception 'exact_status28_required'; end if;
 if (runtime_raw::jsonb)->>'controller_digest' is distinct from new_controller
 or (runtime_raw::jsonb)->'accepted_subject'->'expected_ga'->>'controller_digest' is distinct from new_controller
 or (runtime_raw::jsonb)->'accepted_subject'->'expected_ga'->'controller_qualification_ref'->>'sha256' is distinct from new_qualification
 or (runtime_raw::jsonb)->'accepted_subject'->'late_bound_fields'->'status_manifest_ref'->>'signed_payload_sha256' is distinct from 'a765cc9a6506c8486cb46087cbfa0c9f81f0ff03df23cb0dd421ea83f877a154'
 or (runtime_raw::jsonb)->'accepted_subject'->'exact_pair_recovery'->>'failed_ga_id' is distinct from old_ga
 or (runtime_raw::jsonb)->'accepted_subject'->'exact_pair_recovery'->'budget_sequence' is distinct from '102'::jsonb
 or jsonb_array_length((runtime_raw::jsonb)->'accepted_subject'->'bounded_series_materials'->'repairs')<>9
 then raise exception 'exact_runtime28_required'; end if;
 if (qualification_raw::jsonb)->>'controller_digest' is distinct from new_controller
 or (qualification_raw::jsonb)->'postbudget_repair'->'inherited_pending_budget'->'sequence' is distinct from '102'::jsonb
 or (qualification_raw::jsonb)->'postbudget_repair'->'refund' is distinct from 'false'::jsonb
 or (qualification_raw::jsonb)->'postbudget_repair'->'capacity_change' is distinct from 'false'::jsonb
 or (qualification_raw::jsonb)->'postbudget_repair'->'second_budget_allocation' is distinct from 'false'::jsonb
 or (qualification_raw::jsonb)->'postbudget_repair'->'budget_reassignment' is distinct from 'false'::jsonb
 then raise exception 'exact_qualification28_required'; end if;

 select * into h from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into a from clued_control.gate_attempts where root_id=root and ga_id=old_ga for update;
 select * into b from clued_control.effective_execution_binding();
 select * into budget from clued_control.execution_events where root_id=root and sequence=102;
 if h.sequence is distinct from 9 or h.generation_id is distinct from root9 or h.revoked is distinct from false
 or c.sequence is distinct from 104 or c.active_ga_id is distinct from old_ga or c.pending_budget_sequence is not null
 or c.charged_seconds is distinct from 11106 or c.charged_evidence_bytes is distinct from 2470030259
 or c.runner_generation is distinct from 'runnergen_a256855fec9441839105c69b746c5244'
 or c.credential_generation is distinct from 'credgen_bac92a11e7144a3fb9e67f40a6a07d11'
 or c.session_generation is distinct from 'sessiongen_ffb02a907d334b0da0b37bf457a758c2'
 then raise exception 'expected_current_seq104_lost'; end if;
 if a.ga_sha256 is distinct from old_ga_sha or a.phase is distinct from 'PENDING' or a.sequence is distinct from 0
 or a.container_id is not null or a.revoked or a.budget_sequence is distinct from 102 or a.receipt_raw is not null
 or a.ga->>'controller_digest' is distinct from old_controller or a.ga->>'control_trust_root_generation' is distinct from root9
 or (select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=old_ga)<>0
 then raise exception 'exact_unstarted_old_ga_preimage_required'; end if;
 if budget.request->>'operation' is distinct from 'BUDGET_RESERVED' or budget.request->'body'->>'sha256' is distinct from budget_sha
 or encode(sha256(convert_to(budget.request->'body'->>'raw','UTF8')),'hex') is distinct from budget_sha
 then raise exception 'exact_budget102_bytes_required'; end if;

 old_binding:=jsonb_build_object('root_id',root,'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5','controller_sha256',old_controller,'qualification_sha256',old_qualification,'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5','gate_id','G-PREENTRY-SKILL-QUALIFICATION','gate_version','fixed-synthetic-20260910.v10-env-order-repair','gate_sha256','3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a','runtime_acceptance_sha256',old_acceptance,'prior_seconds',1506,'prior_evidence_bytes',322546611);
 new_binding:=old_binding||jsonb_build_object('controller_sha256',new_controller,'qualification_sha256',new_qualification,'runtime_acceptance_sha256',new_acceptance);
 if to_jsonb(b) is distinct from old_binding then raise exception 'exact_old_binding_required'; end if;
 inheritance:=jsonb_build_object('budget_sequence',102,'budget_reservation_ref',jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102','sha256',budget_sha),'original_controller_sha256','c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b','predecessor_controller_sha256',old_controller,'replacement_controller_sha256',new_controller,'root_generation',root9,'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5','scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5','runner_generation',c.runner_generation,'credential_generation',c.credential_generation,'session_generation',c.session_generation,'reason','ROOT9_EXACT_PREDISPATCH_BUDGET_INHERITANCE','additional_allocation',false,'automatic_refund',false,'capacity_increase',false,'budget_reassignment',false,'remaining_seconds',600,'remaining_evidence_bytes',134217728);
 select e.request->'body'->'evidence'->'required_repair_refs' into repair_refs from clued_control.execution_events e where e.root_id=root and e.sequence=103;
 if jsonb_typeof(repair_refs) is distinct from 'array' or jsonb_array_length(repair_refs)<>8 then raise exception 'exact_prior_repair_set_required'; end if;
 repair_refs:=repair_refs||jsonb_build_array(jsonb_build_object('budget_sequence',102,'ga_id',old_ga,'receipt_sha256','fd1b884641e0752bdf3e5446dfdca5efe2d0f6d0ef27d3a9db201aeb174a772d'));
 evidence:=jsonb_build_object('authority_effect','NONE','defect_code','ROOT9_EXPIRED_PREDISPATCH_EXACT_PAIR_SUCCESSOR','new_controller_sha256',new_controller,'new_qualification_sha256',new_qualification,'new_runtime_acceptance_sha256',new_acceptance,'stage2_publication_ref',jsonb_build_object('uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/6996d7b7b14689bc77149e27ad94712775b3e174','sha256','5989508e165c4b2033e183e8feb0e5ed1f9c0e1175d843bc4551a90fa8cd2b88'),'repair_acceptance_ref',jsonb_build_object('uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/87571bfd9ae43c8652c1a4f182abb431c0b964f2','sha256','21eb0391fb2de19789441eca3ae8915fa9741ed0aad56994ec469f52fe7ec10a'),'status_manifest_ref',jsonb_build_object('uri',status_uri,'sha256',status_sha),'pending_budget_inheritance',inheritance,'required_repair_refs',repair_refs,'root_unchanged',true,'gate_unchanged',true,'profile_unchanged',true,'scope_unchanged',true,'generations_unchanged',true,'refund',false,'capacity_increase',false,'new_allocation',false,'budget_reassignment',false);
 q_req:=jsonb_build_object('operation','SUCCESSOR_BINDING_QUALIFICATION_CORRECTED','body',jsonb_build_object('binding_id','sb_201178b7a8111000d515f7f26a75a28b','supersedes_execution_sequence',103,'status_manifest_ref',jsonb_build_object('uri',status_uri,'sha256',status_sha),'evidence',evidence,'evidence_sha256',encode(sha256(convert_to(evidence::text,'UTF8')),'hex')));
 r_req:=jsonb_build_object('operation','EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED','body',jsonb_build_object('binding_id','sb_201178b7a8111000d515f7f26a75a28b','supersedes_execution_sequence',104,'qualification_correction_sequence',105,'previous_binding',old_binding,'previous_binding_sha256',encode(sha256(convert_to(old_binding::text,'UTF8')),'hex'),'new_binding',new_binding,'new_binding_sha256',encode(sha256(convert_to(new_binding::text,'UTF8')),'hex'),'old_runtime_acceptance_sha256',old_acceptance,'new_runtime_acceptance_sha256',new_acceptance,'acceptance_raw',runtime_raw,'acceptance_sha256',new_acceptance,'qualified_evidence',evidence,'pending_budget_inheritance',inheritance));

 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) order by e.sequence),'[]'::jsonb)::text,'UTF8')),'hex') into fingerprint from clued_control.events e where e.root_id=root;
 if fingerprint is distinct from '1d6b8ca4738b1ed882553e76b5ee7fa6a5ad0a5c92f71bf2cb137988f8ac53e0' then raise exception 'root_prefix_drift'; end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) order by e.sequence),'[]'::jsonb)::text,'UTF8')),'hex') into fingerprint from clued_control.execution_events e where e.root_id=root and e.sequence<=104;
 if fingerprint is distinct from '1fd9788cb572d35f85d5be234c584c14901379d522b302616cd658860bfd6e72' then raise exception 'execution_prefix_drift'; end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(a) order by a.ga_id),'[]'::jsonb)::text,'UTF8')),'hex') into fingerprint from clued_control.gate_attempts a where a.root_id=root;
 if fingerprint is distinct from '31f90c23d21c4c5f52943ab5ba91ef84acc7d440ad981e21de8ca58ff0252127' then raise exception 'attempts_drift'; end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) order by s.binding_id),'[]'::jsonb)::text,'UTF8')),'hex') into fingerprint from clued_control.successor_binding s where s.root_id=root;
 if fingerprint is distinct from '6af55eeb4dd39ebc6721c338eca535e53ca517bc5d5de72f7b6c8ea7273a81d2' then raise exception 'successors_drift'; end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(o) order by o.object_type,o.generation,o.uri),'[]'::jsonb)::text,'UTF8')),'hex') into fingerprint from clued_control.control_objects o where o.root_id=root;
 if fingerprint is distinct from 'a6202a3df76bb91576b8432b98eaa2fd968217f79ca393aca8069272aec806f3' then raise exception 'control_objects_drift'; end if;
 for fn in select p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') digest from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_control' and p.proname in ('append_status_manifest','effective_execution_binding','effective_execution_window','read_root','execution_transition','commit_gate_result','reserve_gate') loop
  if fn.digest is distinct from case fn.proname when 'append_status_manifest' then '1a75b3b9ecfec1d2fe5c700124544d323506fa16e35a99be7c1dc5c3c1ec6280' when 'effective_execution_binding' then '9d8278d9845cffab99624d0ab70d592e2398d8d6a906d608ce5bdd0b14d2e7a1' when 'effective_execution_window' then 'c1531b643ae7ac19079def01664133b236e35b1ba47c10b5a14c321f7131c09f' when 'read_root' then 'ef6935ebdfa0c8f5c4a18dc6e7386d035ba9b076cef070d3af7b2acdb13a0667' when 'execution_transition' then '96ee8ccbcfaa97ffce03a3a233968bd9f4db04b61cc333dac6977f39d38cd754' when 'commit_gate_result' then '705915e4c9b930a5d03bfc37fd1b4e690b9f7817f9f6c8dbaeb856742d9067e3' when 'reserve_gate' then '9b2697a5d779073e8cfa658b9c0f1214c244d9b5eab33175703a6ee31db1dc00' end then raise exception 'function_preimage_drift:%',fn.proname; end if;
 end loop;
 select * into q_old from clued_control.execution_events where root_id=root and idempotency_key=q_idem;
 select * into r_old from clued_control.execution_events where root_id=root and idempotency_key=r_idem;
 if q_old.sequence is not null or r_old.sequence is not null then raise exception 'exact_pair_cas_replay_requires_manual_readback'; end if;

 status_result:=clued_control.append_status_manifest(status_raw,status_sha);
 if status_result->>'status' is distinct from 'STORED_NO_AUTHORITY' then raise exception 'status28_store_failed'; end if;
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values(root,105,q_idem,q_req),(root,106,r_idem,r_req);
 update clued_control.execution_current set sequence=106 where root_id=root and sequence=104 and active_ga_id=old_ga and pending_budget_sequence is null and charged_seconds=11106 and charged_evidence_bytes=2470030259;
 if not found then raise exception 'expected_current_cas_lost'; end if;
 select * into c from clued_control.execution_current where root_id=root;select * into b from clued_control.effective_execution_binding();
 if c.sequence is distinct from 106 or c.active_ga_id is distinct from old_ga or c.pending_budget_sequence is not null or c.charged_seconds is distinct from 11106 or c.charged_evidence_bytes is distinct from 2470030259 or to_jsonb(b) is distinct from new_binding
 or (select count(*) from clued_control.execution_events e where e.root_id=root)<>106
 or (select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'operation'='BUDGET_RESERVED')<>16
 or (select count(*) from clued_control.control_objects o where o.root_id=root and o.object_type='StatusManifest' and o.generation=28 and o.sha256=status_sha and o.raw=status_raw)<>1
 or (select count(*) from clued_control.gate_attempts x where x.root_id=root and x.ga_id=old_ga and x.phase='PENDING' and x.sequence=0 and x.receipt_raw is null)<>1
 then raise exception 'exact_pair_cas_postimage_failed'; end if;
 raise notice 'ROOT9_EXACT_PAIR_EXPECTED_CURRENT_CAS seq=106 active_old_ga=true budget102_unchanged=true';
end
$root9_exact_pair_cas$;
commit;
`;
const output=stage3+'/root9_exact_pair_expected_current_cas.sealed.sql';
if(fs.existsSync(output))need(fs.readFileSync(output,'utf8')===sql,'REFUSE_OVERWRITE_SQL');else fs.writeFileSync(output,sql);
const result={state:'ROOT9_EXACT_PAIR_EXPECTED_CURRENT_CAS_BUILT',sha256:sha(sql),bytes:Buffer.byteLength(sql),expected_sequence_before:104,expected_sequence_after:106,status_generation:28,runtime_acceptance_sha256:runtimeSha,qualification_sha256:qualificationSha,controller_sha256:'9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1',old_ga_untouched_by_cas:true,budget_sequence:102,refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false,database_writes:0};
const resultRaw=JSON.stringify(result,null,2)+'\n';if(fs.existsSync(stage3+'/CAS_BUILD_RESULT.json'))need(fs.readFileSync(stage3+'/CAS_BUILD_RESULT.json','utf8')===resultRaw,'REFUSE_RESULT');else fs.writeFileSync(stage3+'/CAS_BUILD_RESULT.json',resultRaw);
process.stdout.write(resultRaw);
