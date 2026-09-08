// Prepare only: restore the exact original function after the original GA has a real non-PASS receipt.
// Never updates binding/history/budget, calls SQL, signs, or starts another qualification run.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {isDeepStrictEqual as same} from 'node:util';
const dir=path.dirname(fileURLToPath(import.meta.url)),workspace=path.resolve(dir,'../../../..'),live=path.join(workspace,'qualification-live');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);};
const baselineSha='bfa43e28367d6b213b7b6e1455161868a8e5dae4d7067fd02e29f3c1aedc4b60',originalSha='e75e18bbe3c7ed3125aba7b7b2c5db95e23b8022cd05b5bf0e818440becbca88',patchSha='ea114e8f65f08d223fa7dd2fc64ce3c4fd66a6de822311c706a3e6f6c8c78f31';
export const snapshotQuery=`select clock_timestamp() as observed_at,
clued_control.read_root('ctr_414bd3c724264a83894b0c55cf2ab878') as root,
clued_control.read_execution() as execution,
(select coalesce(jsonb_agg(to_jsonb(o) order by o.uri),'[]'::jsonb) from clued_control.control_objects o) as stored_control_objects,
jsonb_build_object('execution_binding',(select count(*) from clued_control.execution_binding),'execution_current',(select count(*) from clued_control.execution_current),'gate_attempts',(select count(*) from clued_control.gate_attempts),'execution_events',(select count(*) from clued_control.execution_events),'control_objects',(select count(*) from clued_control.control_objects)) as counts,
(select jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl::text,'rls',c.relrowsecurity) order by c.relname) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_control' and c.relkind='r') as tables,
(select jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef,'sha256',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'),'prosrc_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) order by p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_control') as functions,
pg_catalog.pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure) as transition_definition`;
const withoutClock=x=>{const o=structuredClone(x);delete o.observed_at;delete o.transition_definition;return o;};
const security=f=>{const x=structuredClone(f);delete x.sha256;delete x.prosrc_sha256;return x;};
const quote=x=>"'"+x.replaceAll("'","''")+"'";
function guard(expected,label){return `do $guard$ declare actual jsonb; begin
lock table clued_control.accepted_binding,clued_control.current_head,clued_control.events,clued_control.execution_binding,clued_control.execution_current,clued_control.execution_events,clued_control.gate_attempts,clued_control.control_objects in share row exclusive mode;
select to_jsonb(s)-'observed_at'-'transition_definition' into actual from (${snapshotQuery}) s;
if actual is distinct from ${quote(JSON.stringify(expected))}::jsonb then raise exception '${label}'; end if;
end $guard$;\n`;}
export function prepareRestoration({baselineRaw,terminalSnapshot,patchRaw}){
 need(sha(baselineRaw)===baselineSha,'EXACT_1921_ORIGINAL_SNAPSHOT');const original=JSON.parse(baselineRaw),current=terminalSnapshot;
 need(sha(original.transition_definition)===originalSha&&original.functions.length===14&&original.tables.length===8,'EXACT_ORIGINAL_FUNCTION_AND_SCHEMA');
 need(sha(patchRaw)===patchSha,'EXACT_ACCEPTED_RECOVERY_PATCH');const body=patchRaw.slice(patchRaw.indexOf('as $$')+5,patchRaw.lastIndexOf('$$;'));
 need(body.startsWith('\ndeclare root constant text:='),'EXACT_PATCH_FUNCTION_BODY');
 need(current?.functions?.length===14&&current.tables?.length===8&&same(current.root,original.root)&&same(current.execution.root,original.execution.root)&&same(current.execution.binding,original.execution.binding)&&same(current.tables,original.tables),'ROOT_BINDING_TABLE_SECURITY_UNCHANGED');
 for(const f of original.functions){const matches=current.functions.filter(x=>x.name===f.name&&x.arguments===f.arguments);need(matches.length===1,'EXACT_FOURTEEN_FUNCTION_IDENTITIES');const actual=matches[0];need(same(security(actual),security(f)),'FUNCTION_OWNER_ACL_SECURITY_CONFIG_UNCHANGED');if(f.name==='execution_transition'){need(actual.prosrc_sha256===sha(body)&&actual.sha256===sha(current.transition_definition),'ACTUAL_EXACT_ACCEPTED_PATCH_CURRENT');}else need(same(actual,f),'OTHER_THIRTEEN_FUNCTION_BYTES_UNCHANGED');}
 const prior=original.execution,currentState=current.execution,c=currentState.current;
 need(c.active_ga_id===null&&c.pending_budget_sequence===null&&c.charged_seconds===prior.current.charged_seconds&&c.charged_evidence_bytes===prior.current.charged_evidence_bytes,'TERMINAL_NO_ACTIVE_PENDING_OR_BUDGET_ROLLBACK');
 for(const key of ['runner_generation','credential_generation','session_generation'])need(c[key]===prior.current[key],'NO_GENERATION_REWRITE');
 need(currentState.attempts.length===1,'ONLY_ORIGINAL_ATTEMPT');const a=currentState.attempts[0],old=prior.attempts[0];
 need(a.ga_id==='ga_18ce0e28e92f448c967fae1c92de7100'&&a.ga_id===old.ga_id&&a.ga_raw===old.ga_raw&&a.ga_sha256===old.ga_sha256&&a.revoked===true&&a.container_id===null&&['FAIL','BLOCKED','STALE'].includes(a.phase),'ORIGINAL_REVOKED_NOT_STARTED_NONPASS_ONLY');
 need(typeof a.receipt_raw==='string'&&sha(a.receipt_raw)===a.receipt_sha256&&JSON.parse(a.receipt_raw).gate_result_receipt_id===a.receipt_id&&JSON.parse(a.receipt_raw).result===a.phase&&a.decision?.termination_mode==='PREDISPATCH_NONPASS_NOT_STARTED','ACTUAL_UNIQUE_NONPASS_RECEIPT_REQUIRED');
 need(prior.events.every(e=>currentState.events.some(x=>same(x,e)))&&currentState.events.filter(e=>e.request.ga_id===a.ga_id).every(e=>['REVOKE','UNKNOWN','DECISION_RESERVED','SIGNING'].includes(e.request.operation)),'PRESERVE_ALL_HISTORY_NO_DISPATCH');
 need(Array.isArray(current.stored_control_objects)&&current.stored_control_objects.length===original.counts.control_objects&&same(current.stored_control_objects.map(o=>({raw:o.raw,uri:o.uri,sha256:o.sha256,object_type:o.object_type})).sort((a,b)=>a.uri.localeCompare(b.uri)),[...prior.control_objects].sort((a,b)=>a.uri.localeCompare(b.uri))),'ACTUAL_STORED_STATUS_BYTES_PRESERVED_NOT_ACTIVE_PROJECTION');
 need(current.counts.gate_attempts===1&&current.counts.execution_binding===1&&current.counts.execution_current===1&&current.counts.control_objects===original.counts.control_objects&&current.counts.execution_events===currentState.events.length,'NO_OTHER_DATA_REPLACEMENT');
 const before=withoutClock(current),after=structuredClone(before);after.functions=structuredClone(original.functions);
 const sql=guard(before,'exact_terminal_restoration_preimage_drift')+original.transition_definition+';\n'+guard(after,'original_fourteen_function_restoration_postimage_mismatch')+snapshotQuery+';\n';
 return {state:'PREPARED_EXACT_ORIGINAL_FUNCTION_RESTORATION_NOT_EXECUTED',sql,sql_sha256:sha(sql),original_function_sha256:originalSha,expected_full_postimage:after,retained_receipt_id:a.receipt_id,retained_receipt_sha256:a.receipt_sha256,charged_seconds:c.charged_seconds,charged_evidence_bytes:c.charged_evidence_bytes,recovery_branch_remains_installed:false,new_qualification_admitted:false,authority_effect:'NONE'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const baselineRaw=fs.readFileSync(path.join(live,'recovery-install-preflight.json'),'utf8'),file=path.join(live,'recovery-terminal-restoration-preflight.json');
 if(!fs.existsSync(file)){console.log(JSON.stringify({state:'WAITING_FOR_ACTUAL_NONPASS_TERMINAL_PREFLIGHT',required_file:file,authority_effect:'NONE'}));process.exitCode=2;}
 else{const value=prepareRestoration({baselineRaw,terminalSnapshot:JSON.parse(fs.readFileSync(file)),patchRaw:fs.readFileSync(path.join(dir,'../predispatch-nonpass-successor/alter.candidate.sql'),'utf8')});for(const [name,raw] of [['restore-original-transition.v2.guarded.sql',value.sql],['restore-original-transition.v2.preparation.json',JSON.stringify(value,null,2)+'\n']]){const fd=fs.openSync(path.join(live,name),'wx');try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}console.log(JSON.stringify({state:value.state,sql_sha256:value.sql_sha256,authority_effect:'NONE'}));}
}
