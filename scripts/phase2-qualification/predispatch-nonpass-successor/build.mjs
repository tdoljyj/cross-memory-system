// Generate reviewable forward successors; never executes SQL or changes frozen sources.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url)),base=path.resolve(dir,'../nonproduction-control-store/runtime-successor/budget-reservation-successor/install.candidate.sql'),old=path.resolve(dir,'../control-context-verifier-runtime600');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);};
const sqlRaw=fs.readFileSync(base),sql=sqlRaw.toString('utf8').replaceAll('\r\n','\n');need(sha(sqlRaw)==='8f732dd4013a18adde33a254631cdd5a04022f300d4c0a13d05dffbf36f97285','EXACT_DEPLOYED_EXECUTION_TRANSITION_SOURCE');
let fn=sql.slice(sql.indexOf('create function clued_control.execution_transition('),sql.indexOf('create function clued_control.record_effect_intent(')).trim();
fn=fn.replace('create function ','create or replace function ').replace('evidence_json jsonb; field_name text;','evidence_json jsonb; field_name text; reconciliation jsonb;');
const oldGuard="  if a.phase<>'STOPPED' or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'";
need(fn.includes(oldGuard),'EXACT_ORIGINAL_STOPPED_ONLY_GUARD');
const guard=`  if p->'body'->>'termination_mode'='PREDISPATCH_NONPASS_NOT_STARTED' then
   if a.phase<>'UNKNOWN' or a.revoked is distinct from true or a.container_id is not null
   or p->'body'->>'result' is null or p->'body'->>'result' not in ('FAIL','BLOCKED','STALE')
   or exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation' not in ('REVOKE','UNKNOWN'))
   or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='REVOKE')
   then raise exception 'exact_revoked_not_started_attempt_required'; end if;
   if jsonb_typeof(p->'body'->'not_started_evidence_raw') is distinct from 'string'
   or not ((p->'body'->>'not_started_evidence_raw') is json object with unique keys)
   or p->'body'->'not_started_evidence_ref'->>'sha256' is distinct from encode(sha256(convert_to(p->'body'->>'not_started_evidence_raw','UTF8')),'hex')
   then raise exception 'exact_not_started_reconciliation_raw_required'; end if;
   reconciliation:=(p->'body'->>'not_started_evidence_raw')::jsonb;
   if reconciliation->>'kind' is distinct from 'PREDISPATCH_NOT_STARTED_RECONCILIATION'
   or reconciliation->>'ga_id' is distinct from a.ga_id or reconciliation->>'ga_sha256' is distinct from a.ga_sha256
   or reconciliation->>'root_id' is distinct from root or reconciliation->>'controller_digest' is distinct from a.ga->>'controller_digest'
   or reconciliation->'not_started' is distinct from 'true'::jsonb or reconciliation->'stop_action_performed' is distinct from 'false'::jsonb
   or reconciliation->'container_id' is distinct from 'null'::jsonb
   or reconciliation->'execution_sequence' is distinct from to_jsonb(c.sequence)
   or reconciliation->'event_sequences' is distinct from (select coalesce(jsonb_agg(e.sequence order by e.sequence),'[]'::jsonb) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id)
   or p->'body'->'not_started_evidence_ref'->>'uri' is distinct from 'urn:clued:execution-evidence:'||root||':'||(p->'body'->'not_started_evidence_ref'->>'sha256')
   then raise exception 'not_started_reconciliation_subject_or_history_mismatch'; end if;
   if ((p->'body'->>'decision_raw')::jsonb)->'test_results' is distinct from '[]'::jsonb
   or ((p->'body'->>'evidence_index_raw')::jsonb)->'tests' is distinct from '[]'::jsonb
   or (select count(*) from jsonb_array_elements(((p->'body'->>'evidence_index_raw')::jsonb)->'artifacts') x
    where x->>'raw'=p->'body'->>'not_started_evidence_raw' and x->>'sha256'=p->'body'->'not_started_evidence_ref'->>'sha256'
     and x->>'uri'=p->'body'->'not_started_evidence_ref'->>'uri')<>1
   then raise exception 'no_test_execution_and_exact_indexed_reconciliation_required'; end if;
  elsif a.phase<>'STOPPED' then raise exception 'decision_reservation_conflict'; end if;
  if a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'`;
fn=fn.replace(oldGuard,()=>guard);
fs.writeFileSync(path.join(dir,'alter.candidate.sql'),'-- Candidate: existing function only; no tables, grants, counters, or history rewritten.\n'+fn+'\n',{flag:'wx'});
const bindings=[{path:path.relative(path.resolve(dir,'../../..'),base).replaceAll('\\','/'),sha256:sha(sqlRaw)}];
for(const name of ['grr.mjs','result-terminal.mjs','write-targets.mjs']){
 const bytes=fs.readFileSync(path.join(old,name));bindings.push({path:'scripts/phase2-qualification/control-context-verifier-runtime600/'+name,sha256:sha(bytes)});
 let source=bytes.toString('utf8');
 // Changed local imports resolve the unchanged original modules explicitly.
 source=source.replaceAll("from './context.mjs'","from '../control-context-verifier-runtime600/context.mjs'").replaceAll("from './trusted-github.mjs'","from '../control-context-verifier-runtime600/trusted-github.mjs'").replaceAll("from './historical-component-observations.mjs'","from '../control-context-verifier-runtime600/historical-component-observations.mjs'");
 if(name==='grr.mjs'){
  source="import {checkNotStarted,mode} from './not-started.mjs';\n"+source;
  const start=source.indexOf(' const stopped=state.events.filter'),end=source.indexOf(' const started=time(receipt.started_at)',start);need(start>0&&end>start,'EXACT_STOP_BLOCK');
  source=source.slice(0,start)+" if(a.decision?.termination_mode===mode){checkNotStarted({receipt,ga,state});}else{\n"+source.slice(start,end)+" }\n"+source.slice(end);
 }
 if(name==='write-targets.mjs'){
  source="import {checkNotStarted,mode} from './not-started.mjs';\n"+source;
  const anchor=" const observed=collectActualWriteTargets({ga,state,receiptId:receipt.gate_result_receipt_id});";need(source.includes(anchor),'EXACT_WRITE_TARGET_CHECK');
  source=source.replace(anchor," const a=state.attempts.find(x=>x.ga_id===ga.gate_authorization_id);\n if(a?.decision?.termination_mode===mode){const checked=checkNotStarted({receipt,ga,state});return {...checked,targets:receipt.actual_write_set};}\n"+anchor);
 }
 if(name==='result-terminal.mjs'){
  source="import {verifyRecoverySources} from './recovery-sources.mjs';\n"+source;
  const anchor=" verifyDynamicPayload(material.grr_raw,'GateResultReceipt',receipt.expires_at);";need(source.includes(anchor),'EXACT_ORIGINAL_SIGNATURE_CALL');
  source=source.replace(anchor," if(attempt.decision?.termination_mode==='PREDISPATCH_NONPASS_NOT_STARTED')verifyRecoverySources({material,ga,receipt,state});\n"+anchor);
 }
 fs.writeFileSync(path.join(dir,name),source.replaceAll('\r\n','\n'),{flag:'wx'});
}
fs.writeFileSync(path.join(dir,'OriginalSourceBindings.json'),JSON.stringify({state:'EXACT_PARENT_BYTES_PRESERVED_NOT_DEPLOYED',sources:bindings},null,2)+'\n',{flag:'wx'});
const contextBytes=fs.readFileSync(path.join(old,'context.mjs'));
let context=contextBytes.toString('utf8').replaceAll('\r\n','\n');
for(const line of ["import {intentFor} from '../preentry-parent/runtime-successor/sql_effect.mjs';\n","import {deriveEventKey} from '../preentry-parent/runtime-successor/supervisor.mjs';\n","import {checkDispatchEvidence} from '../control-context-verifier-runtime180/dispatch-evidence.mjs';\n","import {invokeFixedHost} from './host-effect.mjs';\n"]){need(context.includes(line),'EXACT_OLD_EFFECT_IMPORT');context=context.replace(line,'');}
for(const file of ['budget-evidence.mjs','late-bound-policy.mjs','source-publication.mjs','trusted-github.mjs'])context=context.replaceAll("from './"+file+"'","from '../control-context-verifier-runtime600/"+file+"'");
const functionAnchor='export async function prepareTrustedToolMaterial(material){';
context=context.replace(functionAnchor,functionAnchor+"\n check(material?.operation==='GRR'&&['FAIL','BLOCKED','STALE'].includes(parseExact(material.grr_raw).result),'RECOVERY_NONPASS_GRR_ONLY');\n check(material.observation?.row?.execution?.attempts?.some(a=>a.ga_id===parseExact(material.ga_raw).gate_authorization_id&&a.decision?.termination_mode==='PREDISPATCH_NONPASS_NOT_STARTED'),'RECOVERY_NOT_STARTED_ONLY');");
const effectStart=context.indexOf(" check(['CREATE','START'].includes(operation),'FIXED_EFFECT_ENTRY_ONLY');");need(effectStart>0,'EXACT_EFFECT_TAIL');context=context.slice(0,effectStart)+" throw Error('RECOVERY_ENTRY_HAS_NO_EFFECT_PORT');\n}\n";
fs.writeFileSync(path.join(dir,'recovery-context.mjs'),context,{flag:'wx'});
