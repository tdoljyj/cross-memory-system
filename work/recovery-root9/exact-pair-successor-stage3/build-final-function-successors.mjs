import fs from 'node:fs';
import crypto from 'node:crypto';

const src='/tmp/root9-recovery-v1',out='/tmp/root9-exact-pair-stage3-20260915a';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const need=(v,m)=>{if(!v)throw Error(m);};
const exactReplace=(s,a,b,m)=>{need(s.split(a).length===2,m);return s.replace(a,b);};
let execution=fs.readFileSync(src+'/execution.successor.sql','utf8');
let commit=fs.readFileSync(src+'/commit.successor.sql','utf8');
let reserve=fs.readFileSync(src+'/reserve.successor.sql','utf8');
execution=exactReplace(execution,'or c.sequence is distinct from 104','or c.sequence is distinct from 106','EXEC_SEQ');
commit=exactReplace(commit,'or c.sequence is distinct from 106','or c.sequence is distinct from 108','COMMIT_SEQ');
commit=exactReplace(commit,'e.sequence=105','e.sequence=107','COMMIT_DECISION_SEQ');
commit=exactReplace(commit,'e.sequence=106','e.sequence=108','COMMIT_SIGNING_SEQ');
reserve=exactReplace(reserve,'series_recovery := c.sequence=106','series_recovery := c.sequence=108','RESERVE_SERIES_SEQ');
reserve=exactReplace(reserve,'case when series_recovery then 106 else 104 end','case when series_recovery then 108 else 104 end','RESERVE_CURRENT_SEQ');
const begin='previous_binding := jsonb_build_object(';
const end='end if;\n insert into clued_control.gate_attempts';
const i=reserve.indexOf(begin),j=reserve.indexOf(end,i);need(i>=0&&j>i&&reserve.indexOf(begin,i+1)<0&&reserve.indexOf(end,j+1)<0,'RESERVE_EXACT_BLOCK');
const block=`previous_binding := jsonb_build_object(
  'root_id','ctr_414bd3c724264a83894b0c55cf2ab878',
  'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
  'controller_sha256','c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  'qualification_sha256','a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013',
  'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  'gate_id','G-PREENTRY-SKILL-QUALIFICATION','gate_version','fixed-synthetic-20260910.v10-env-order-repair',
  'gate_sha256','3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
  'runtime_acceptance_sha256','c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552',
  'prior_seconds',1506,'prior_evidence_bytes',322546611);
replacement_binding := previous_binding || jsonb_build_object(
  'controller_sha256','9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1',
  'qualification_sha256','3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa',
  'runtime_acceptance_sha256','2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df');
inherited_budget := jsonb_build_object(
  'budget_sequence',102,'budget_reservation_ref',jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102','sha256','51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'),
  'original_controller_sha256','c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b',
  'predecessor_controller_sha256','c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  'replacement_controller_sha256','9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1',
  'root_generation','ctrgen_308a1dfc185cff633892638581e0a34c','profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5','scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  'runner_generation','runnergen_a256855fec9441839105c69b746c5244','credential_generation','credgen_bac92a11e7144a3fb9e67f40a6a07d11','session_generation','sessiongen_ffb02a907d334b0da0b37bf457a758c2',
  'reason','ROOT9_EXACT_PREDISPATCH_BUDGET_INHERITANCE','additional_allocation',false,'automatic_refund',false,'capacity_increase',false,'budget_reassignment',false,'remaining_seconds',600,'remaining_evidence_bytes',134217728);
if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'scope_digest' is distinct from g->>'scope_digest'
 or allocation->>'runner_generation' is distinct from g->>'runner_generation' or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer or start_time<(allocation->>'not_before')::timestamptz or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
 then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;
if allocation->>'controller_digest' is distinct from g->>'controller_digest' then
 select * into correction_event from clued_control.execution_events where root_id=root and sequence=105;
 select * into repoint from clued_control.execution_events where root_id=root and sequence=106;
 correction_evidence_sha:=encode(sha256(convert_to((correction_event.request->'body'->'evidence')::text,'UTF8')),'hex');
 if budget.sequence is distinct from 102 or budget.idempotency_key is distinct from 'root9_final_skill_qualification_budget_v1' or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
 or budget.request->'body'->>'sha256' is distinct from '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'
 or encode(sha256(convert_to(budget.request->'body'->>'raw','UTF8')),'hex') is distinct from '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'
 or allocation->>'controller_digest' is distinct from 'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b'
 or c.sequence is distinct from 108 or c.pending_budget_sequence is distinct from 102 or c.active_ga_id is not null
 or c.charged_seconds is distinct from 11106 or c.charged_evidence_bytes is distinct from 2470030259
 or b.controller_sha256 is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
 or b.qualification_sha256 is distinct from '3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa'
 or b.runtime_acceptance_sha256 is distinct from '2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df'
 or to_jsonb(b) is distinct from replacement_binding
 or g->>'controller_digest' is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
 or g->'controller_qualification_ref'->>'sha256' is distinct from '3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa'
 or g->'status_manifest_ref' is distinct from jsonb_build_object('uri','control://status-manifests/sm_root9_status28_exact_pair_recovery_v1','sha256','4a6dddd73433b51aa1339ae2ebcd08f0d170f71d8ec35e9fb5905efecb3f5944')
 or correction_event.recording_transaction_id is null or correction_event.recording_transaction_id=pg_current_xact_id()
 or correction_event.idempotency_key is distinct from 'root9_exact_pair_successor_v1_qualification' or correction_event.request->>'operation' is distinct from 'SUCCESSOR_BINDING_QUALIFICATION_CORRECTED'
 or correction_event.request->'body'->'supersedes_execution_sequence' is distinct from '103'::jsonb
 or correction_event.request->'body'->>'evidence_sha256' is distinct from correction_evidence_sha
 or correction_event.request->'body'->'evidence'->>'defect_code' is distinct from 'ROOT9_EXPIRED_PREDISPATCH_EXACT_PAIR_SUCCESSOR'
 or correction_event.request->'body'->'evidence'->>'new_controller_sha256' is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
 or correction_event.request->'body'->'evidence'->>'new_qualification_sha256' is distinct from '3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa'
 or correction_event.request->'body'->'evidence'->>'new_runtime_acceptance_sha256' is distinct from '2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df'
 or correction_event.request->'body'->'evidence'->'pending_budget_inheritance' is distinct from inherited_budget
 or jsonb_array_length(correction_event.request->'body'->'evidence'->'required_repair_refs')<>9
 or correction_event.request->'body'->'evidence'->'required_repair_refs'->8 is distinct from jsonb_build_object('budget_sequence',102,'ga_id','ga_4a88b0436cf80beeb5e194c98bb0297e','receipt_sha256','fd1b884641e0752bdf3e5446dfdca5efe2d0f6d0ef27d3a9db201aeb174a772d')
 or repoint.recording_transaction_id is null or repoint.recording_transaction_id=pg_current_xact_id() or repoint.recording_transaction_id is distinct from correction_event.recording_transaction_id
 or repoint.idempotency_key is distinct from 'root9_exact_pair_successor_v1_repoint' or repoint.request->>'operation' is distinct from 'EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'
 or repoint.request->'body'->'supersedes_execution_sequence' is distinct from '104'::jsonb or repoint.request->'body'->'qualification_correction_sequence' is distinct from '105'::jsonb
 or repoint.request->'body'->'previous_binding' is distinct from previous_binding or repoint.request->'body'->'new_binding' is distinct from replacement_binding
 or repoint.request->'body'->>'old_runtime_acceptance_sha256' is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
 or repoint.request->'body'->>'new_runtime_acceptance_sha256' is distinct from '2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df'
 or encode(sha256(convert_to(repoint.request->'body'->>'acceptance_raw','UTF8')),'hex') is distinct from '2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df'
 or repoint.request->'body'->'pending_budget_inheritance' is distinct from inherited_budget
 or repoint.request->'body'->'qualified_evidence' is distinct from correction_event.request->'body'->'evidence'
 then raise exception 'exact_pair_budget_inheritance_binding_mismatch'; end if;
end if;
`;
reserve=reserve.slice(0,i)+block+reserve.slice(j+'end if;\n'.length);
const files=[['execution_transition.exact-pair.sql',execution],['commit_gate_result.exact-pair.sql',commit],['reserve_gate.exact-pair.sql',reserve]];
for(const [name,raw] of files){const p=out+'/'+name;if(fs.existsSync(p))need(fs.readFileSync(p,'utf8')===raw,'REFUSE_OVERWRITE:'+name);else fs.writeFileSync(p,raw);}
const result={state:'ROOT9_EXACT_PAIR_FINAL_FUNCTION_SUCCESSORS_BUILT',functions:Object.fromEntries(files.map(([n,r])=>[n,{sha256:sha(r),bytes:Buffer.byteLength(r)}])),sequence_before_cas:104,sequence_after_cas:106,decision_reserved_sequence:107,signing_sequence:108,reserve_from_sequence:108,budget_sequence:102,old_controller:'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',new_controller:'9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1',refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false,database_writes:0};
const raw=JSON.stringify(result,null,2)+'\n';fs.writeFileSync(out+'/FUNCTION_SUCCESSOR_RESULT.json',raw);process.stdout.write(raw);
