import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT='ctr_414bd3c724264a83894b0c55cf2ab878';
const GEN='ctrgen_48100437d24e448ba01c542ebe1290da';
const GA='ga_32daa5daf52c4deb8e893c25b08eff38';
const GA_SHA='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78';
const BUDGET_SHA='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462';
const PREP='2026-09-16T03:00:00Z';
const FINAL='2026-09-16T03:00:00Z';
const IDEM='root10_runtime_clock_amendment_20260915';
const TEMPORAL_IDEM='root10_same_ga_temporal_continuation_20260915';
const TEMPORAL_AMENDMENT_SHA='38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6';
const OLD={controller:'aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041',qualification:'e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405',runtime:'17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42'};
const OLD_BINDING={gate_id:'G-PREENTRY-SKILL-QUALIFICATION',root_id:ROOT,gate_sha256:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',gate_version:'fixed-synthetic-20260910.v10-env-order-repair',scope_sha256:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',prior_seconds:1506,profile_sha256:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',controller_sha256:OLD.controller,prior_evidence_bytes:322546611,qualification_sha256:OLD.qualification,runtime_acceptance_sha256:OLD.runtime};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const gitBlobSha=buf=>crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const die=m=>{throw Error(m);};
const q=s=>s.replaceAll("'","''");
const read=p=>fs.readFileSync(p,'utf8');
const exactKeys=(v,keys,label)=>{if(!v||Array.isArray(v)||typeof v!=='object'||JSON.stringify(Object.keys(v).sort())!==JSON.stringify([...keys].sort()))die(label);};

const args=process.argv.slice(2),configPath=args[0];
if(!configPath)die('usage: node build-root10-runtime-clock-activation.mjs config.json [outdir]');
const config=JSON.parse(read(configPath));
exactKeys(config,['new_controller_sha256','new_qualification_sha256','new_runtime_acceptance_sha256'],'config keys');
for(const k of ['new_controller_sha256','new_qualification_sha256','new_runtime_acceptance_sha256'])if(!/^[0-9a-f]{64}$/.test(config[k]))die(k);
if(config.new_controller_sha256===OLD.controller||config.new_qualification_sha256===OLD.qualification||config.new_runtime_acceptance_sha256===OLD.runtime)die('all three runtime clock pins must change');

const here=path.dirname(fileURLToPath(import.meta.url));
const temporalDir=path.resolve(here,'..','..','temporal-continuation','stage2','activation');
const amendmentPath=path.resolve(here,'..','Root10RuntimeClockAmendment.json');
const amendmentBytes=fs.readFileSync(amendmentPath);
const amendmentRaw=amendmentBytes.toString('utf8'),amendment=JSON.parse(amendmentRaw);
exactKeys(amendment,['object_type','schema_version','root_id','control_trust_root_generation','supersedes','why','amended_terms','preserved_invariants','removed_restrictions','activation','invariants','authority_effect'],'amendment keys');
exactKeys(amendment.supersedes,['object_type','sha256','activation_sequence','disposition'],'amendment supersedes keys');
exactKeys(amendment.activation,['operation','idempotency_key','expected_sequence','activation_sequence','maximum_activations','ga_ref','budget_ref','preparation_expires_at','runtime_seconds','max_predispatch_resets','finalization_expires_at'],'amendment activation keys');
exactKeys(amendment.activation.ga_ref,['ga_id','sha256'],'amendment ga ref keys');
exactKeys(amendment.activation.budget_ref,['sequence','sha256','seconds','evidence_bytes'],'amendment budget ref keys');
if(amendment.object_type!=='Root10RuntimeClockAmendment'||amendment.schema_version!=='1.0'||amendment.root_id!==ROOT||amendment.control_trust_root_generation!==GEN||amendment.supersedes?.object_type!=='Root10TemporalContinuationAmendment'||amendment.supersedes?.sha256!==TEMPORAL_AMENDMENT_SHA||amendment.supersedes?.activation_sequence!==118||amendment.activation?.operation!=='RUNTIME_CLOCK_AMENDMENT_ACTIVATED'||amendment.activation?.idempotency_key!==IDEM||amendment.activation?.expected_sequence!==118||amendment.activation?.activation_sequence!==119||amendment.activation?.maximum_activations!==1||amendment.activation?.ga_ref?.ga_id!==GA||amendment.activation?.ga_ref?.sha256!==GA_SHA||amendment.activation?.budget_ref?.sequence!==117||amendment.activation?.budget_ref?.sha256!==BUDGET_SHA||amendment.activation?.budget_ref?.seconds!==600||amendment.activation?.budget_ref?.evidence_bytes!==134217728||amendment.activation?.preparation_expires_at!==PREP||amendment.activation?.finalization_expires_at!==FINAL||amendment.activation?.runtime_seconds!==600||amendment.activation?.max_predispatch_resets!==3||amendment.invariants?.automatic_retry!==false||amendment.invariants?.refund!==false||amendment.invariants?.capacity_increase!==false||amendment.invariants?.new_gate_authorizations!==0||amendment.invariants?.new_budgets!==0||amendment.authority_effect!=='NONE')die('amendment semantics');

const AMEND_SHA=sha(amendmentBytes);
const AMEND_BLOB=gitBlobSha(amendmentBytes);
const AMEND_REF={uri:`https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${AMEND_BLOB}`,sha256:AMEND_SHA};
const NEW_BINDING={...OLD_BINDING,controller_sha256:config.new_controller_sha256,qualification_sha256:config.new_qualification_sha256,runtime_acceptance_sha256:config.new_runtime_acceptance_sha256};

const SUBS={__AMEND_SHA256__:AMEND_SHA,__AMEND_BLOB_SHA1__:AMEND_BLOB,__NEW_CONTROLLER_SHA256__:config.new_controller_sha256,__NEW_QUALIFICATION_SHA256__:config.new_qualification_sha256,__NEW_ACCEPTANCE_SHA256__:config.new_runtime_acceptance_sha256};
const noPlaceholders=(s,label)=>{const m=s.match(/__[A-Z][A-Z0-9_]*__/);if(m)die(`unsubstituted placeholder ${m[0]} in ${label}`);return s;};
const substitute=(s,label)=>{for(const [token,value] of Object.entries(SUBS)){if(!s.includes(token))die(`${label} missing ${token}`);s=s.split(token).join(value);}return noPlaceholders(s,label);};

let effective=substitute(read(path.join(here,'effective_execution_binding.runtime-clock.sql')),'effective_execution_binding.runtime-clock.sql');
let transition=substitute(read(path.join(here,'execution_transition.runtime-clock.sql')),'execution_transition.runtime-clock.sql');
let commit=substitute(read(path.join(here,'commit_gate_result.runtime-clock.sql')),'commit_gate_result.runtime-clock.sql');
const temporalEffective=read(path.join(temporalDir,'effective_execution_binding.temporal.sql'));
const temporalTransition=read(path.join(temporalDir,'execution_transition.temporal.sql'));
const temporalCommit=read(path.join(temporalDir,'commit_gate_result.temporal.sql'));

// pg_get_functiondef form: the emitted .sql artifacts are the catalog definition plus a trailing ';'.
const defOf=(s,label)=>{const t=s.trimEnd();if(!t.endsWith('$function$;'))die(`${label} must end with $function$;`);return t.slice(0,-1)+'\n';};
const OLD_FN={effective:sha(defOf(temporalEffective,'temporal effective')),transition:sha(defOf(temporalTransition,'temporal transition')),commit:sha(defOf(temporalCommit,'temporal commit'))};
const NEW_FN={effective:sha(defOf(effective,'runtime clock effective')),transition:sha(defOf(transition,'runtime clock transition')),commit:sha(defOf(commit,'runtime clock commit'))};

const sqlArray=xs=>`array[${xs.map(x=>`'${q(x)}'`).join(',')}]::text[]`;
const keySet=(expr,keys)=>`(select array_agg(k order by k) from jsonb_object_keys(${expr}) k)=${sqlArray([...keys].sort())}`;
const REQUEST_KEYS=['body','expected_sequence','ga_id','idempotency_key','operation'];
const BODY_KEYS=['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','finalization_expires_at','max_predispatch_resets','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','preparation_expires_at','prior_ga_sha256','runtime_seconds'];
const BINDING_KEYS=Object.keys(OLD_BINDING);
const oldBindingSql=`'${q(JSON.stringify(OLD_BINDING))}'::jsonb`;
const newBindingSql=`'${q(JSON.stringify(NEW_BINDING))}'::jsonb`;
const rcGuard=alias=>`${alias}.root_id='${ROOT}' and ${alias}.sequence=119 and ${alias}.idempotency_key='${IDEM}' and ${keySet(`${alias}.request`,REQUEST_KEYS)} and ${alias}.request->>'operation'='RUNTIME_CLOCK_AMENDMENT_ACTIVATED' and ${alias}.request->>'ga_id'='${GA}' and ${alias}.request->>'idempotency_key'='${IDEM}' and ${alias}.request->'expected_sequence'='118'::jsonb and ${keySet(`${alias}.request->'body'`,BODY_KEYS)} and ${keySet(`${alias}.request->'body'->'amendment_ref'`,['sha256','uri'])} and ${alias}.request->'body'->'amendment_ref'='${q(JSON.stringify(AMEND_REF))}'::jsonb and ${alias}.request->'body'->>'amendment_sha256'='${AMEND_SHA}' and ${alias}.request->'body'->>'budget_raw_sha256'='${BUDGET_SHA}' and ${alias}.request->'body'->'budget_sequence'='117'::jsonb and ${alias}.request->'body'->>'prior_ga_sha256'='${GA_SHA}' and ${alias}.request->'body'->'automatic_retry'='false'::jsonb and ${alias}.request->'body'->'new_ga'='false'::jsonb and ${alias}.request->'body'->'new_budget'='false'::jsonb and ${alias}.request->'body'->'budget_refund'='false'::jsonb and ${alias}.request->'body'->>'preparation_expires_at'='${PREP}' and ${alias}.request->'body'->>'finalization_expires_at'='${FINAL}' and ${alias}.request->'body'->'runtime_seconds'='600'::jsonb and ${alias}.request->'body'->'max_predispatch_resets'='3'::jsonb and (${alias}.request->'body'->>'activated_at')::timestamptz<(${alias}.request->'body'->>'finalization_expires_at')::timestamptz and ${keySet(`${alias}.request->'body'->'old_binding'`,BINDING_KEYS)} and ${alias}.request->'body'->'old_binding'=${oldBindingSql} and ${alias}.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((${alias}.request->'body'->'old_binding')::text,'UTF8')),'hex') and ${keySet(`${alias}.request->'body'->'new_binding'`,BINDING_KEYS)} and ${alias}.request->'body'->'new_binding'=${newBindingSql} and ${alias}.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((${alias}.request->'body'->'new_binding')::text,'UTF8')),'hex')`;
if(!transition.includes(rcGuard('rc_event')))die('transition runtime clock guard drift');
if(!commit.includes(rcGuard('rc_event')))die('commit runtime clock guard drift');
if(!effective.includes(rcGuard('e')))die('effective runtime clock guard drift');

const amendmentB64=amendmentBytes.toString('base64');
const applyOnce=`-- Root10 runtime clock amendment activation. Candidate only; one transaction; no GA/budget/effect.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='90s';
create temp table _root10_runtime_clock_fn on commit drop as select p.oid,n.nspname,p.proname,pg_get_functiondef(p.oid) def,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') digest,p.proowner,p.proacl::text acl,p.proconfig::text config,p.prosecdef,p.provolatile,p.prokind,p.proparallel,p.proleakproof from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid in ('clued_control.effective_execution_binding()'::regprocedure,'clued_control.execution_transition(jsonb)'::regprocedure,'clued_control.commit_gate_result(text,text,text)'::regprocedure);
do $pre$ declare h clued_control.current_head;c clued_control.execution_current;a clued_control.gate_attempts;b clued_control.execution_binding;budget clued_control.execution_events;t118 clued_control.execution_events; amendment_raw text:=convert_from(decode('${amendmentB64}','base64'),'UTF8');begin
 if (select count(*) from _root10_runtime_clock_fn)<>3 or (select digest from _root10_runtime_clock_fn where proname='effective_execution_binding')<>'${OLD_FN.effective}' or (select digest from _root10_runtime_clock_fn where proname='execution_transition')<>'${OLD_FN.transition}' or (select digest from _root10_runtime_clock_fn where proname='commit_gate_result')<>'${OLD_FN.commit}' then raise exception 'ROOT10_RUNTIME_CLOCK_FUNCTION_PREIMAGE_DRIFT'; end if;
 select * into h from clued_control.current_head where root_id='${ROOT}' for share; select * into c from clued_control.execution_current where root_id='${ROOT}' for update; select * into a from clued_control.gate_attempts where root_id='${ROOT}' and ga_id='${GA}' for update; select * into b from clued_control.effective_execution_binding(); select * into budget from clued_control.execution_events where root_id='${ROOT}' and sequence=117; select * into t118 from clued_control.execution_events where root_id='${ROOT}' and sequence=118;
 if h.sequence<>10 or h.generation_id<>'${GEN}' or h.revoked or c.sequence<>118 or c.active_ga_id<>'${GA}' or c.pending_budget_sequence is not null or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987 or a.phase<>'PENDING' or a.sequence<>0 or a.container_id is not null or a.decision is not null or a.receipt_raw is not null or a.revoked or a.ga_sha256<>'${GA_SHA}' or a.budget_sequence<>117 or t118.idempotency_key<>'${TEMPORAL_IDEM}' or t118.request->>'operation'<>'TEMPORAL_CONTINUATION_ACTIVATED' or t118.request->>'ga_id'<>'${GA}' or exists(select 1 from clued_control.execution_events e where e.root_id='${ROOT}' and e.sequence>118) then raise exception 'ROOT10_RUNTIME_CLOCK_EXACT_PREIMAGE_REQUIRED'; end if;
 if budget.request->>'operation'<>'BUDGET_RESERVED' or budget.request->'body'->>'sha256'<>'${BUDGET_SHA}' or encode(sha256(convert_to(budget.request->'body'->>'raw','UTF8')),'hex')<>'${BUDGET_SHA}' or b.controller_sha256<>'${OLD.controller}' or b.qualification_sha256<>'${OLD.qualification}' or b.runtime_acceptance_sha256<>'${OLD.runtime}' or to_jsonb(b)<>${oldBindingSql} or not (${keySet('to_jsonb(b)',BINDING_KEYS)}) then raise exception 'ROOT10_RUNTIME_CLOCK_BUDGET_OR_BINDING_PREIMAGE_DRIFT'; end if;
 if encode(sha256(convert_to(amendment_raw,'UTF8')),'hex')<>'${AMEND_SHA}' or amendment_raw::jsonb->>'object_type'<>'Root10RuntimeClockAmendment' or amendment_raw::jsonb->'activation'->>'operation'<>'RUNTIME_CLOCK_AMENDMENT_ACTIVATED' or amendment_raw::jsonb->'activation'->>'idempotency_key'<>'${IDEM}' then raise exception 'ROOT10_RUNTIME_CLOCK_OWNER_AMENDMENT_BYTES_REQUIRED'; end if;
 if clock_timestamp()>='${FINAL}'::timestamptz-interval '10 minutes' then raise exception 'ROOT10_RUNTIME_CLOCK_INSUFFICIENT_WINDOW'; end if;
end $pre$;
${effective.trimEnd()}
${transition.trimEnd()}
${commit.trimEnd()}
do $activate$ declare c clued_control.execution_current;a clued_control.gate_attempts;oldb jsonb;newb jsonb;request jsonb;activated timestamptz:=clock_timestamp();begin
 if activated>='${FINAL}'::timestamptz-interval '10 minutes' then raise exception 'ROOT10_RUNTIME_CLOCK_INSUFFICIENT_WINDOW'; end if;
 select * into c from clued_control.execution_current where root_id='${ROOT}' for update; select * into a from clued_control.gate_attempts where root_id='${ROOT}' and ga_id='${GA}' for update; select to_jsonb(x) into oldb from clued_control.effective_execution_binding() x;
 if oldb<>${oldBindingSql} or not (${keySet('oldb',BINDING_KEYS)}) then raise exception 'ROOT10_RUNTIME_CLOCK_OLD_BINDING_DRIFT'; end if;
 newb:=oldb||jsonb_build_object('controller_sha256','${config.new_controller_sha256}','qualification_sha256','${config.new_qualification_sha256}','runtime_acceptance_sha256','${config.new_runtime_acceptance_sha256}');
 if newb<>${newBindingSql} or not (${keySet('newb',BINDING_KEYS)}) or (select count(*) from jsonb_each(oldb) o join jsonb_each(newb) n using(key) where o.value is distinct from n.value)<>3 then raise exception 'ROOT10_RUNTIME_CLOCK_BINDING_DIFF_INVALID'; end if;
 request:=jsonb_build_object('operation','RUNTIME_CLOCK_AMENDMENT_ACTIVATED','ga_id','${GA}','expected_sequence',118,'idempotency_key','${IDEM}','body',jsonb_build_object('activated_at',activated,'amendment_ref','${q(JSON.stringify(AMEND_REF))}'::jsonb,'amendment_sha256','${AMEND_SHA}','automatic_retry',false,'budget_raw_sha256','${BUDGET_SHA}','budget_refund',false,'budget_sequence',117,'finalization_expires_at','${FINAL}','max_predispatch_resets',3,'new_binding',newb,'new_binding_sha256',encode(sha256(convert_to(newb::text,'UTF8')),'hex'),'new_budget',false,'new_ga',false,'old_binding',oldb,'old_binding_sha256',encode(sha256(convert_to(oldb::text,'UTF8')),'hex'),'preparation_expires_at','${PREP}','prior_ga_sha256','${GA_SHA}','runtime_seconds',600));
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values('${ROOT}',119,'${IDEM}',request);
 update clued_control.execution_current set sequence=119 where root_id='${ROOT}' and sequence=118 and active_ga_id='${GA}' and pending_budget_sequence is null and charged_seconds=11706 and charged_evidence_bytes=2604247987; if not found then raise exception 'ROOT10_RUNTIME_CLOCK_ACTIVATION_CAS_FAILED'; end if;
end $activate$;
do $post$ declare c clued_control.execution_current;a clued_control.gate_attempts;e clued_control.execution_events;b clued_control.execution_binding;begin select * into c from clued_control.execution_current where root_id='${ROOT}';select * into a from clued_control.gate_attempts where root_id='${ROOT}' and ga_id='${GA}';select * into e from clued_control.execution_events where root_id='${ROOT}' and sequence=119;select * into b from clued_control.effective_execution_binding(); if c.sequence<>119 or c.active_ga_id<>'${GA}' or c.pending_budget_sequence is not null or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987 or a.phase<>'PENDING' or a.sequence<>0 or a.container_id is not null or a.ga_sha256<>'${GA_SHA}' or a.budget_sequence<>117 or not (${rcGuard('e')}) or b.controller_sha256<>'${config.new_controller_sha256}' or b.qualification_sha256<>'${config.new_qualification_sha256}' or b.runtime_acceptance_sha256<>'${config.new_runtime_acceptance_sha256}' or (select count(*) from _root10_runtime_clock_fn o join pg_proc p on p.oid=o.oid where p.proowner<>o.proowner or p.proacl::text is distinct from o.acl or p.proconfig::text is distinct from o.config or p.prosecdef<>o.prosecdef or p.provolatile<>o.provolatile or p.prokind<>o.prokind or p.proparallel<>o.proparallel or p.proleakproof<>o.proleakproof)<>0 or encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.effective}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.transition}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.commit}' then raise exception 'ROOT10_RUNTIME_CLOCK_POSTIMAGE_DRIFT'; end if; end $post$;
select jsonb_build_object('state','ROOT10_RUNTIME_CLOCK_AMENDMENT_ACTIVATED','execution_sequence',119,'ga_id','${GA}','ga_sha256','${GA_SHA}','budget_sequence',117,'budget_sha256','${BUDGET_SHA}','new_ga',false,'new_budget',false,'charged_seconds',11706,'charged_evidence_bytes',2604247987,'runtime_seconds',600,'max_predispatch_resets',3,'preparation_expires_at','${PREP}','finalization_expires_at','${FINAL}','function_sha256',jsonb_build_object('effective_execution_binding','${NEW_FN.effective}','execution_transition','${NEW_FN.transition}','commit_gate_result','${NEW_FN.commit}'),'authority_effect','NONE');
commit;
`;
const rollback=`-- Root10 runtime clock amendment full rollback. One transaction; restores the temporal-continuation functions and removes event 119 only when nothing was built on it.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='90s';
do $guard$ declare c clued_control.execution_current;a clued_control.gate_attempts;e clued_control.execution_events;begin
 select * into c from clued_control.execution_current where root_id='${ROOT}' for update; select * into a from clued_control.gate_attempts where root_id='${ROOT}' and ga_id='${GA}' for update; select * into e from clued_control.execution_events where root_id='${ROOT}' and sequence=119;
 if c.sequence<>119 or c.active_ga_id<>'${GA}' or c.pending_budget_sequence is not null or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987 or a.phase<>'PENDING' or a.sequence<>0 or a.container_id is not null or a.decision is not null or a.receipt_raw is not null or a.revoked or e.idempotency_key<>'${IDEM}' or e.request->>'operation'<>'RUNTIME_CLOCK_AMENDMENT_ACTIVATED' or exists(select 1 from clued_control.execution_events x where x.root_id='${ROOT}' and x.sequence>119) then raise exception 'ROOT10_RUNTIME_CLOCK_ROLLBACK_GUARD_FAILED'; end if;
end $guard$;
${temporalEffective.trimEnd()}
${temporalTransition.trimEnd()}
${temporalCommit.trimEnd()}
do $undo$ begin
 delete from clued_control.execution_events where root_id='${ROOT}' and sequence=119 and idempotency_key='${IDEM}' and request->>'operation'='RUNTIME_CLOCK_AMENDMENT_ACTIVATED'; if not found then raise exception 'ROOT10_RUNTIME_CLOCK_ROLLBACK_EVENT_MISSING'; end if;
 update clued_control.execution_current set sequence=118 where root_id='${ROOT}' and sequence=119 and active_ga_id='${GA}'; if not found then raise exception 'ROOT10_RUNTIME_CLOCK_ROLLBACK_CAS_FAILED'; end if;
end $undo$;
commit;
`;
const readback=`select jsonb_build_object('observed_at',clock_timestamp(),'runtime_clock_event',(select to_jsonb(e) from clued_control.execution_events e where e.root_id='${ROOT}' and e.sequence=119 and e.idempotency_key='${IDEM}'),'current_sequence',(select c.sequence from clued_control.execution_current c where c.root_id='${ROOT}'),'effective_binding',(select to_jsonb(b) from clued_control.effective_execution_binding() b),'authority_effect','NONE');
`;
const files=[['root10-runtime-clock-activation.apply-once.sql',applyOnce],['root10-runtime-clock-activation.full-rollback.sql',rollback],['root10-runtime-clock-activation.readback.sql',readback]];
for(const [name,content] of files)noPlaceholders(content,name);
const out=path.resolve(args[1]??'root10-runtime-clock-activation-output');
fs.mkdirSync(out,{recursive:true});
for(const [name,content] of files)fs.writeFileSync(path.join(out,name),content,{flag:'wx'});
process.stdout.write(JSON.stringify({state:'ROOT10_RUNTIME_CLOCK_ACTIVATION_CANDIDATE_NOT_EXECUTED',authority_effect:'NONE',out,inputs:{amendment_sha256:AMEND_SHA,amendment_blob_sha1:AMEND_BLOB,amendment_ref:AMEND_REF,new_controller_sha256:config.new_controller_sha256,new_qualification_sha256:config.new_qualification_sha256,new_runtime_acceptance_sha256:config.new_runtime_acceptance_sha256},pins:{root_id:ROOT,generation:GEN,ga_id:GA,ga_sha256:GA_SHA,budget_sequence:117,budget_sha256:BUDGET_SHA,expected_sequence:118,activation_sequence:119,preparation_expires_at:PREP,finalization_expires_at:FINAL,runtime_seconds:600,max_predispatch_resets:3,old_binding:OLD_BINDING,old_function_sha256:OLD_FN,new_function_sha256:NEW_FN},files:Object.fromEntries(files.map(([name,content])=>[name,{sha256:sha(content),bytes:Buffer.byteLength(content)}]))},null,2)+'\n');
