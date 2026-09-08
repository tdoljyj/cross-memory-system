// Bounded forward preparation only. Never executes SQL, signs, or calls a host.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const repo=path.resolve('work/kernel-phase2-repo'),base=path.join(repo,'scripts/phase2-qualification/predispatch-nonpass-successor'),out=path.join(repo,'scripts/phase2-qualification/recorded-intent-nonpass-successor');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),need=(x,m)=>{if(!x)throw Error(m)},read=n=>fs.readFileSync(path.join(base,n),'utf8'),write=(n,s)=>fs.writeFileSync(path.join(out,n),s.replaceAll('\r\n','\n'),{flag:'wx'});
fs.mkdirSync(out,{recursive:true});const parentBytes=fs.readFileSync(path.join(base,'RecoverySourceManifest.json')),parent=JSON.parse(parentBytes);
for(const f of parent.files){const b=fs.readFileSync(path.join(base,f.path));need(b.length===f.bytes&&sha(b)===f.sha256,'EXACT_PARENT_'+f.path);}
const oldMode='PREDISPATCH_NONPASS_NOT_STARTED',mode='PREDISPATCH_RECORDED_INTENT_NONPASS_NOT_STARTED',gaId='ga_a7a420f7de4a4037b9dcb5cd7dae796e',gaSha='30739d18ac4b6d6836799f292533a0ce71cf2e1b3f05a38724ab61945b0d72fa';
const intentCheck=`
 need(ga.gate_authorization_id==='${gaId}'&&a.ga_sha256==='${gaSha}','EXACT_SECOND_GA_ONLY');
 const intents=events.filter(e=>e.request.operation==='INTENT_RECORDED'),revokes=events.filter(e=>e.request.operation==='REVOKE');
 need(intents.length===1&&revokes.length===1,'ONE_CREATE_INTENT_ONE_REVOKE');const ie=intents[0],ir=ie.request;
 need(ie.sequence===6&&ir.expected_sequence===5&&ie.sequence<revokes[0].sequence&&ir.ga_id===a.ga_id&&ir.body.operation==='CREATE','EXACT_UNDISPATCHED_CREATE_INTENT');
 need(ir.idempotency_key==='intent_c2c1616fda42c115f30e53bbb2e82deacdda65148e8625eb66a095289f0b8bc3'&&ie.idempotency_key===ir.idempotency_key,'EXACT_ORIGINAL_INTENT_KEY');
 need(ir.body.raw===JSON.stringify({ga_id:a.ga_id,ga_sha256:a.ga_sha256,operation:'CREATE'})&&sha(ir.body.raw)===ir.body.sha256&&ir.body.sha256==='4b8e05bec02db77cd4767c6b98329aeb33f88eae02ae002c841a0bf207106ce2','EXACT_ORIGINAL_INTENT_BYTES');
`;
let s=read('not-started.mjs').replaceAll(oldMode,mode).replace("import crypto from 'node:crypto';","import crypto from 'node:crypto';import {inflateSync} from 'node:zlib';import path from 'node:path';");
s=s.replace("['REVOKE','UNKNOWN','DECISION_RESERVED','SIGNING']","['INTENT_RECORDED','REVOKE','UNKNOWN','DECISION_RESERVED','SIGNING']").replace("'NO_INTENT_OR_DISPATCH_IN_COMPLETE_HISTORY');","'NO_DISPATCH_OR_EFFECT_IN_COMPLETE_HISTORY');"+intentCheck);
s=s.replace("return JSON.parse(x.raw);","const value=JSON.parse(x.raw);if(value.kind==='LOSSLESS_RECONCILIATION_SQL_SOURCE'){need(value.encoding==='deflate-base64'&&Number.isSafeInteger(value.raw_bytes)&&value.raw_bytes>0&&value.raw_bytes<=2097152&&typeof value.data==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data),'BOUNDED_EXACT_SQL_PACK');const compressed=Buffer.from(value.data,'base64');need(compressed.toString('base64')===value.data,'CANONICAL_SQL_PACK');const decoded=inflateSync(compressed,{maxOutputLength:2097152,info:true});need(decoded.engine.bytesWritten===compressed.length&&decoded.buffer.length===value.raw_bytes&&sha(decoded.buffer)===value.raw_sha256,'LOSSLESS_COMPLETE_SQL_SOURCE');const text=decoded.buffer.toString('utf8');need(Buffer.from(text).equals(decoded.buffer),'VALID_UTF8_SQL_SOURCE');return JSON.parse(text);}return value;");
s=s.replace("proof.kind==='PREDISPATCH_NOT_STARTED_RECONCILIATION'","proof.kind==='PREDISPATCH_RECORDED_INTENT_NOT_STARTED_RECONCILIATION'");
s=s.replace("docker.exact_nonce_directory==='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo/scripts/phase2-qualification/preentry-parent/work/'+nonce","path.win32.normalize(docker.exact_nonce_directory)===path.win32.normalize('C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo/scripts/phase2-qualification/preentry-parent/work/'+nonce)");
s=s.replace("failure.original_output_raw.includes('FRESH_SQL_OBSERVATION_REQUIRED')","failure.original_output_raw.includes('NO_DISPATCH_ON_OLD_OR_UNKNOWN_INTENT')").replace("'ORIGINAL_FRESHNESS_REJECTION_BYTES'","'ORIGINAL_INTENT_PHASE_REJECTION_BYTES'");
const cancellation=`
 const cancellation=resolve(proof.verifier_cancellation_ref),stdout=resolve(proof.verifier_stdout_ref);
 need(cancellation.kind==='ACTUAL_WAITING_VERIFIER_CANCELLED_WITH_INVALID_CHALLENGE'&&cancellation.ga_id===a.ga_id&&cancellation.session_id===68227&&cancellation.input_raw==='{}\\n'&&cancellation.actual_write_stdin_result?.exit_code===1&&cancellation.dispatch_sent===false&&cancellation.capacity_released===false,'ACTUAL_WAITING_PROCESS_EXIT_NO_CHALLENGE');
 need(stdout.kind==='ACTUAL_FIXED_VERIFIER_STDOUT_BYTES'&&stdout.ga_id===a.ga_id&&stdout.ga_sha256===a.ga_sha256&&typeof stdout.raw==='string'&&sha(stdout.raw)===stdout.sha256&&stdout.bytes===Buffer.byteLength(stdout.raw),'EXACT_TERMINATED_VERIFIER_STDOUT');
 const lines=stdout.raw.split('\\n');need(lines.at(-1)===''&&lines.length===3,'EXACT_TWO_VERIFIER_MESSAGES');const messages=lines.slice(0,-1).map(x=>JSON.parse(x));
 need(messages[0].state==='NEED_COMMITTED_DISPATCH'&&messages[0].intent?.gaId===a.ga_id&&messages[0].intent.key===ir.idempotency_key&&same(messages[0].intent.body,ir.body)&&messages[1].state==='UNKNOWN'&&messages[1].reason==='EXACT_LIVE_PROCESS_CHALLENGE_REQUIRED'&&messages[1].capacity_released===false&&messages[1].automatic_retry===false&&messages[1].qualified===false,'ORIGINAL_VERIFIER_NEVER_COMPLETED_DISPATCH');
`;
s=s.replace(' const review=resolve(proof.independent_assessment_ref);',cancellation+' const review=resolve(proof.independent_assessment_ref);');
s=s.replace("review.kind==='INDEPENDENT_NOT_STARTED_RECONCILIATION_ASSESSMENT'","review.kind==='INDEPENDENT_RECORDED_INTENT_NOT_STARTED_RECONCILIATION_ASSESSMENT'");
s=s.replace('[proof.sql_observation_ref,proof.container_lookup_ref,...proof.entry_failure_refs]','[proof.sql_observation_ref,proof.container_lookup_ref,...proof.entry_failure_refs,proof.verifier_cancellation_ref,proof.verifier_stdout_ref]');write('not-started.mjs',s);
let sql=read('alter.candidate.sql').replaceAll(oldMode,mode).replaceAll("'PREDISPATCH_NOT_STARTED_RECONCILIATION'","'PREDISPATCH_RECORDED_INTENT_NOT_STARTED_RECONCILIATION'");
sql=sql.replace("not in ('REVOKE','UNKNOWN')","not in ('INTENT_RECORDED','REVOKE','UNKNOWN')");
const guard=`   or a.ga_id<>'${gaId}' or a.ga_sha256<>'${gaSha}'
   or (select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='INTENT_RECORDED')<>1
   or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.sequence=6
     and e.idempotency_key='intent_c2c1616fda42c115f30e53bbb2e82deacdda65148e8625eb66a095289f0b8bc3'
     and e.request->>'idempotency_key'=e.idempotency_key and e.request->>'ga_id'=a.ga_id
     and e.request->'expected_sequence'='5'::jsonb and e.request->>'operation'='INTENT_RECORDED'
     and e.request->'body'->>'operation'='CREATE'
     and e.request->'body'->>'sha256'='4b8e05bec02db77cd4767c6b98329aeb33f88eae02ae002c841a0bf207106ce2'
     and encode(sha256(convert_to(e.request->'body'->>'raw','UTF8')),'hex')=e.request->'body'->>'sha256'
     and (e.request->'body'->>'raw')::jsonb=jsonb_build_object('ga_id',a.ga_id,'ga_sha256',a.ga_sha256,'operation','CREATE'))
   or (select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='REVOKE' and e.sequence>6)<>1
`;
sql=sql.replace("   then raise exception 'exact_revoked_not_started_attempt_required'; end if;",guard+"   then raise exception 'exact_revoked_recorded_intent_not_started_attempt_required'; end if;");write('alter.candidate.sql',sql);
for(const n of ['grr.mjs','result-terminal.mjs','write-targets.mjs','recovery-context.mjs','recovery-cli.mjs','tool-entry.functions.js','recovery-sources.mjs']){let v=read(n).replaceAll(oldMode,mode).replaceAll('predispatch-nonpass-successor','recorded-intent-nonpass-successor').replaceAll('ACCEPTED_EXACT_PREDISPATCH_NONPASS_RECOVERY_SOURCES','ACCEPTED_EXACT_RECORDED_INTENT_NONPASS_RECOVERY_SOURCES');write(n,v);}
write('OriginalSourceBindings.json',JSON.stringify({state:'EXACT_PARENT_PRESERVED_NEW_RECORDED_INTENT_RECOVERY_CANDIDATE',parent_manifest_sha256:sha(parentBytes),parent_files:parent.files},null,2)+'\n');
write('build.mjs',fs.readFileSync(import.meta.filename,'utf8'));
const names=parent.files.map(f=>f.path);write('RecoverySourceManifest.json',JSON.stringify({state:'EXACT_RECORDED_INTENT_NONPASS_RECOVERY_CANDIDATE_NOT_EXECUTOR_QUALIFICATION',ga_id:gaId,ga_sha256:gaSha,original_controller_digest:parent.original_controller_digest,old_qualification_extended:false,new_action_authorized:false,parent_manifest_sha256:sha(parentBytes),files:names.map(p=>{const b=fs.readFileSync(path.join(out,p));return {path:p,sha256:sha(b),bytes:b.length};})},null,2)+'\n');
console.log(JSON.stringify({directory:out,manifest_sha256:sha(fs.readFileSync(path.join(out,'RecoverySourceManifest.json'))),sql_sha256:sha(fs.readFileSync(path.join(out,'alter.candidate.sql')))}));
