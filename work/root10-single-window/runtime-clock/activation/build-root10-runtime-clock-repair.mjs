// Replace the three runtime-clock functions with their corrected bodies. This is
// a repair of the installed function text only: event 119 stays exactly as the
// owner activated it, no counter, binding, attempt or decision is touched, and
// the post-image proves the whole control state came through byte-identical.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT='ctr_414bd3c724264a83894b0c55cf2ab878';
const GEN='ctrgen_48100437d24e448ba01c542ebe1290da';
const GA='ga_32daa5daf52c4deb8e893c25b08eff38';
const GA_SHA='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78';
const BUDGET_SHA='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462';
const PREP='2026-09-16T03:00:00Z';
const FINAL='2026-09-16T03:00:00Z';
const IDEM='root10_runtime_clock_amendment_20260915';
const CHARGED_SECONDS=11706,CHARGED_BYTES=2604247987;
const OLD={controller:'aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041',qualification:'e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405',runtime:'17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42'};
const OLD_BINDING={gate_id:'G-PREENTRY-SKILL-QUALIFICATION',root_id:ROOT,gate_sha256:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',gate_version:'fixed-synthetic-20260910.v10-env-order-repair',scope_sha256:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',prior_seconds:1506,profile_sha256:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',controller_sha256:OLD.controller,prior_evidence_bytes:322546611,qualification_sha256:OLD.qualification,runtime_acceptance_sha256:OLD.runtime};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const gitBlobSha=buf=>crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const die=m=>{throw Error(m);};
const q=s=>s.replaceAll("'","''");
const read=p=>fs.readFileSync(p,'utf8');
const exactKeys=(v,keys,label)=>{if(!v||Array.isArray(v)||typeof v!=='object'||JSON.stringify(Object.keys(v).sort())!==JSON.stringify([...keys].sort()))die(label);};

const args=process.argv.slice(2),configPath=args[0];
if(!configPath)die('usage: node build-root10-runtime-clock-repair.mjs config.json [outdir]');
const config=JSON.parse(read(configPath));
exactKeys(config,['new_controller_sha256','new_qualification_sha256','new_runtime_acceptance_sha256','installed_function_sha256'],'config keys');
for(const k of ['new_controller_sha256','new_qualification_sha256','new_runtime_acceptance_sha256'])if(!/^[0-9a-f]{64}$/.test(config[k]))die(k);
exactKeys(config.installed_function_sha256,['effective','transition','commit'],'installed_function_sha256 keys');
for(const k of Object.keys(config.installed_function_sha256))if(!/^[0-9a-f]{64}$/.test(config.installed_function_sha256[k]))die('installed '+k);

const here=path.dirname(fileURLToPath(import.meta.url));
const amendmentPath=path.resolve(here,'..','Root10RuntimeClockAmendment.json');
const amendmentBytes=fs.readFileSync(amendmentPath);
const AMEND_SHA=sha(amendmentBytes);
const AMEND_BLOB=gitBlobSha(amendmentBytes);
const AMEND_REF={uri:`https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${AMEND_BLOB}`,sha256:AMEND_SHA};
const NEW_BINDING={...OLD_BINDING,controller_sha256:config.new_controller_sha256,qualification_sha256:config.new_qualification_sha256,runtime_acceptance_sha256:config.new_runtime_acceptance_sha256};

const SUBS={__AMEND_SHA256__:AMEND_SHA,__AMEND_BLOB_SHA1__:AMEND_BLOB,__NEW_CONTROLLER_SHA256__:config.new_controller_sha256,__NEW_QUALIFICATION_SHA256__:config.new_qualification_sha256,__NEW_ACCEPTANCE_SHA256__:config.new_runtime_acceptance_sha256};
const noPlaceholders=(s,label)=>{const m=s.match(/__[A-Z][A-Z0-9_]*__/);if(m)die(`unsubstituted placeholder ${m[0]} in ${label}`);return s;};
const substitute=(s,label)=>{for(const [token,value] of Object.entries(SUBS)){if(!s.includes(token))die(`${label} missing ${token}`);s=s.split(token).join(value);}return noPlaceholders(s,label);};

const NAMES=['effective_execution_binding.runtime-clock.sql','execution_transition.runtime-clock.sql','commit_gate_result.runtime-clock.sql'];
const corrected=Object.fromEntries(NAMES.map(name=>[name,substitute(read(path.join(here,name)),name)]));
// The installed text is the committed version of these same files, substituted
// identically; reading it from git rather than restating it keeps the pre-image
// honest -- if HEAD is not what was activated, the digests below will not match.
const committed=Object.fromEntries(NAMES.map(name=>{
 const raw=execFileSync('git',['show',`HEAD:work/root10-single-window/runtime-clock/activation/${name}`],{cwd:path.resolve(here,'..','..','..','..'),encoding:'utf8',maxBuffer:4194304});
 return [name,substitute(raw,'HEAD:'+name)];
}));

// pg_get_functiondef form: the emitted .sql artifacts are the catalog definition plus a trailing ';'.
const defOf=(s,label)=>{const t=s.trimEnd();if(!t.endsWith('$function$;'))die(`${label} must end with $function$;`);return t.slice(0,-1)+'\n';};
const digestsOf=set=>({effective:sha(defOf(set[NAMES[0]],NAMES[0])),transition:sha(defOf(set[NAMES[1]],NAMES[1])),commit:sha(defOf(set[NAMES[2]],NAMES[2]))});
const OLD_FN=digestsOf(committed),NEW_FN=digestsOf(corrected);
for(const key of ['effective','transition','commit'])if(OLD_FN[key]!==config.installed_function_sha256[key])die(`installed ${key} digest is not the committed source: ${OLD_FN[key]}`);
if(NEW_FN.transition===OLD_FN.transition)die('execution_transition is unchanged; nothing to repair');
if(NEW_FN.commit===OLD_FN.commit)die('commit_gate_result is unchanged; nothing to repair');
if(NEW_FN.effective!==OLD_FN.effective)die('effective_execution_binding must not change in a repair');

const sqlArray=xs=>`array[${xs.map(x=>`'${q(x)}'`).join(',')}]::text[]`;
const keySet=(expr,keys)=>`(select array_agg(k order by k) from jsonb_object_keys(${expr}) k)=${sqlArray([...keys].sort())}`;
const REQUEST_KEYS=['body','expected_sequence','ga_id','idempotency_key','operation'];
const BODY_KEYS=['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','finalization_expires_at','max_predispatch_resets','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','preparation_expires_at','prior_ga_sha256','runtime_seconds'];
const BINDING_KEYS=Object.keys(OLD_BINDING);
const oldBindingSql=`'${q(JSON.stringify(OLD_BINDING))}'::jsonb`;
const newBindingSql=`'${q(JSON.stringify(NEW_BINDING))}'::jsonb`;
const rcGuard=alias=>`${alias}.root_id='${ROOT}' and ${alias}.sequence=119 and ${alias}.idempotency_key='${IDEM}' and ${keySet(`${alias}.request`,REQUEST_KEYS)} and ${alias}.request->>'operation'='RUNTIME_CLOCK_AMENDMENT_ACTIVATED' and ${alias}.request->>'ga_id'='${GA}' and ${alias}.request->>'idempotency_key'='${IDEM}' and ${alias}.request->'expected_sequence'='118'::jsonb and ${keySet(`${alias}.request->'body'`,BODY_KEYS)} and ${keySet(`${alias}.request->'body'->'amendment_ref'`,['sha256','uri'])} and ${alias}.request->'body'->'amendment_ref'='${q(JSON.stringify(AMEND_REF))}'::jsonb and ${alias}.request->'body'->>'amendment_sha256'='${AMEND_SHA}' and ${alias}.request->'body'->>'budget_raw_sha256'='${BUDGET_SHA}' and ${alias}.request->'body'->'budget_sequence'='117'::jsonb and ${alias}.request->'body'->>'prior_ga_sha256'='${GA_SHA}' and ${alias}.request->'body'->'automatic_retry'='false'::jsonb and ${alias}.request->'body'->'new_ga'='false'::jsonb and ${alias}.request->'body'->'new_budget'='false'::jsonb and ${alias}.request->'body'->'budget_refund'='false'::jsonb and ${alias}.request->'body'->>'preparation_expires_at'='${PREP}' and ${alias}.request->'body'->>'finalization_expires_at'='${FINAL}' and ${alias}.request->'body'->'runtime_seconds'='600'::jsonb and ${alias}.request->'body'->'max_predispatch_resets'='3'::jsonb and (${alias}.request->'body'->>'activated_at')::timestamptz<(${alias}.request->'body'->>'finalization_expires_at')::timestamptz and ${keySet(`${alias}.request->'body'->'old_binding'`,BINDING_KEYS)} and ${alias}.request->'body'->'old_binding'=${oldBindingSql} and ${alias}.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((${alias}.request->'body'->'old_binding')::text,'UTF8')),'hex') and ${keySet(`${alias}.request->'body'->'new_binding'`,BINDING_KEYS)} and ${alias}.request->'body'->'new_binding'=${newBindingSql} and ${alias}.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((${alias}.request->'body'->'new_binding')::text,'UTF8')),'hex')`;
if(!corrected[NAMES[1]].includes(rcGuard('rc_event')))die('transition runtime clock guard drift');
if(!corrected[NAMES[2]].includes(rcGuard('rc_event')))die('commit runtime clock guard drift');
if(!corrected[NAMES[0]].includes(rcGuard('e')))die('effective runtime clock guard drift');

const snapshot=`create temp table _rc_repair_state on commit drop as select
 (select to_jsonb(c) from clued_control.execution_current c where c.root_id='${ROOT}') current_row,
 (select to_jsonb(a) from clued_control.gate_attempts a where a.root_id='${ROOT}' and a.ga_id='${GA}') attempt_row,
 (select to_jsonb(e) from clued_control.execution_events e where e.root_id='${ROOT}' and e.sequence=119) event119,
 (select to_jsonb(b) from clued_control.effective_execution_binding() b) binding_row,
 (select count(*) from clued_control.execution_events e where e.root_id='${ROOT}') event_count;`;

// Both guards read the control rows LIVE. The pre guard also records them; the
// post guard additionally requires every live row to still equal what the pre
// guard recorded, so "nothing moved" is proven against fresh reads rather than
// against the snapshot comparing with itself.
const liveRows=`select to_jsonb(c) into cur from clued_control.execution_current c where c.root_id='${ROOT}';
 select to_jsonb(a) into att from clued_control.gate_attempts a where a.root_id='${ROOT}' and a.ga_id='${GA}';
 select to_jsonb(b) into bind from clued_control.effective_execution_binding() b;
 select count(*) into events from clued_control.execution_events x where x.root_id='${ROOT}';
 select * into h from clued_control.current_head where root_id='${ROOT}';
 select * into e from clued_control.execution_events where root_id='${ROOT}' and sequence=119;`;
const stateGuard=label=>`${liveRows}
 if cur is null or att is null or bind is null or e.sequence is null then raise exception '${label}_CONTROL_ROW_MISSING'; end if;
 if h.sequence<>10 or h.generation_id<>'${GEN}' or h.revoked then raise exception '${label}_HEAD_DRIFT'; end if;
 if cur->>'sequence'<>'119' or cur->>'active_ga_id'<>'${GA}' or cur->'pending_budget_sequence'<>'null'::jsonb or cur->>'charged_seconds'<>'${CHARGED_SECONDS}' or cur->>'charged_evidence_bytes'<>'${CHARGED_BYTES}' then raise exception '${label}_CURRENT_DRIFT'; end if;
 if att->>'phase'<>'PENDING' or att->>'sequence'<>'0' or att->'container_id'<>'null'::jsonb or att->'decision'<>'null'::jsonb or att->'receipt_raw'<>'null'::jsonb or att->'revoked'<>'false'::jsonb or att->>'ga_sha256'<>'${GA_SHA}' or att->>'budget_sequence'<>'117' then raise exception '${label}_ATTEMPT_DRIFT'; end if;
 if bind<>${newBindingSql} or not (${keySet('bind',BINDING_KEYS)}) then raise exception '${label}_BINDING_DRIFT'; end if;
 if events<>119 then raise exception '${label}_EVENT_COUNT_DRIFT'; end if;
 if not (${rcGuard('e')}) then raise exception '${label}_ACTIVATION_EVENT_DRIFT'; end if;`;
const snapshotGuard=label=>`if (select count(*) from _rc_repair_state)<>1 then raise exception '${label}_SNAPSHOT_MISSING'; end if;
 select * into snap from _rc_repair_state;
 if snap.current_row is distinct from cur or snap.attempt_row is distinct from att or snap.binding_row is distinct from bind or snap.event119 is distinct from to_jsonb(e) or snap.event_count is distinct from events then raise exception '${label}_CONTROL_STATE_MOVED'; end if;`;
const DECLS='snap _rc_repair_state;h clued_control.current_head;e clued_control.execution_events;cur jsonb;att jsonb;bind jsonb;events bigint;';

const applyOnce=`-- Root10 runtime clock function repair. Candidate only; one transaction.
-- Replaces the three installed function bodies with their corrected text. Event
-- 119 is not rewritten, no counter moves, no budget or GA is created, and the
-- post-image proves every control row came through byte-identical.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='90s';
create temp table _rc_repair_fn on commit drop as select p.oid,n.nspname,p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') digest,p.proowner,p.proacl::text acl,p.proconfig::text config,p.prosecdef,p.provolatile,p.prokind,p.proparallel,p.proleakproof from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid in ('clued_control.effective_execution_binding()'::regprocedure,'clued_control.execution_transition(jsonb)'::regprocedure,'clued_control.commit_gate_result(text,text,text)'::regprocedure);
${snapshot}
do $pre$ declare ${DECLS}begin
 -- Refuse unless the installed text is exactly the committed source this repair
 -- was built against; a surprise body means someone else changed the functions.
 if (select count(*) from _rc_repair_fn)<>3 or (select digest from _rc_repair_fn where proname='effective_execution_binding')<>'${OLD_FN.effective}' or (select digest from _rc_repair_fn where proname='execution_transition')<>'${OLD_FN.transition}' or (select digest from _rc_repair_fn where proname='commit_gate_result')<>'${OLD_FN.commit}' then raise exception 'ROOT10_RUNTIME_CLOCK_REPAIR_PREIMAGE_DRIFT'; end if;
 ${stateGuard('ROOT10_RUNTIME_CLOCK_REPAIR_PRE')}
 if clock_timestamp()>='${FINAL}'::timestamptz then raise exception 'ROOT10_RUNTIME_CLOCK_REPAIR_WINDOW_CLOSED'; end if;
end $pre$;
${corrected[NAMES[0]].trimEnd()}
${corrected[NAMES[1]].trimEnd()}
${corrected[NAMES[2]].trimEnd()}
do $post$ declare ${DECLS}begin
 ${stateGuard('ROOT10_RUNTIME_CLOCK_REPAIR_POST')}
 ${snapshotGuard('ROOT10_RUNTIME_CLOCK_REPAIR_POST')}
 if (select count(*) from _rc_repair_fn o join pg_proc p on p.oid=o.oid where p.proowner<>o.proowner or p.proacl::text is distinct from o.acl or p.proconfig::text is distinct from o.config or p.prosecdef<>o.prosecdef or p.provolatile<>o.provolatile or p.prokind<>o.prokind or p.proparallel<>o.proparallel or p.proleakproof<>o.proleakproof)<>0 then raise exception 'ROOT10_RUNTIME_CLOCK_REPAIR_FUNCTION_ATTRIBUTE_DRIFT'; end if;
 if encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.effective}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.transition}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.commit}' then raise exception 'ROOT10_RUNTIME_CLOCK_REPAIR_POSTIMAGE_DRIFT'; end if;
end $post$;
select jsonb_build_object('state','ROOT10_RUNTIME_CLOCK_FUNCTIONS_REPAIRED','execution_sequence',119,'ga_id','${GA}','ga_sha256','${GA_SHA}','budget_sequence',117,'new_ga',false,'new_budget',false,'events_appended',0,'charged_seconds',${CHARGED_SECONDS},'charged_evidence_bytes',${CHARGED_BYTES},'function_sha256',jsonb_build_object('effective_execution_binding','${NEW_FN.effective}','execution_transition','${NEW_FN.transition}','commit_gate_result','${NEW_FN.commit}'),'replaced_function_sha256',jsonb_build_object('execution_transition','${OLD_FN.transition}','commit_gate_result','${OLD_FN.commit}'),'authority_effect','NONE');
commit;
`;
const rollback=`-- Root10 runtime clock function repair rollback. Restores the activated bodies.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='90s';
create temp table _rc_repair_fn on commit drop as select p.oid,p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') digest from pg_proc p where p.oid in ('clued_control.effective_execution_binding()'::regprocedure,'clued_control.execution_transition(jsonb)'::regprocedure,'clued_control.commit_gate_result(text,text,text)'::regprocedure);
do $guard$ begin
 if (select count(*) from _rc_repair_fn)<>3 or (select digest from _rc_repair_fn where proname='execution_transition')<>'${NEW_FN.transition}' or (select digest from _rc_repair_fn where proname='commit_gate_result')<>'${NEW_FN.commit}' then raise exception 'ROOT10_RUNTIME_CLOCK_REPAIR_ROLLBACK_GUARD_FAILED'; end if;
 if exists(select 1 from clued_control.execution_events e where e.root_id='${ROOT}' and e.sequence>119) then raise exception 'ROOT10_RUNTIME_CLOCK_REPAIR_ROLLBACK_EFFECTS_EXIST'; end if;
end $guard$;
${committed[NAMES[1]].trimEnd()}
${committed[NAMES[2]].trimEnd()}
do $post$ begin
 if encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex')<>'${OLD_FN.transition}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex')<>'${OLD_FN.commit}' then raise exception 'ROOT10_RUNTIME_CLOCK_REPAIR_ROLLBACK_POSTIMAGE_DRIFT'; end if;
end $post$;
commit;
`;
const readback=`select jsonb_build_object('observed_at',clock_timestamp(),'current_sequence',(select c.sequence from clued_control.execution_current c where c.root_id='${ROOT}'),'event_count',(select count(*) from clued_control.execution_events e where e.root_id='${ROOT}'),'effective_binding',(select to_jsonb(b) from clued_control.effective_execution_binding() b),'function_sha256',(select jsonb_object_agg(p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) from pg_proc p where p.oid in ('clued_control.effective_execution_binding()'::regprocedure,'clued_control.execution_transition(jsonb)'::regprocedure,'clued_control.commit_gate_result(text,text,text)'::regprocedure)),'authority_effect','NONE');
`;
const files=[['root10-runtime-clock-repair.apply-once.sql',applyOnce],['root10-runtime-clock-repair.full-rollback.sql',rollback],['root10-runtime-clock-repair.readback.sql',readback]];
for(const [name,content] of files)noPlaceholders(content,name);
const out=path.resolve(args[1]??'root10-runtime-clock-repair-output');
fs.mkdirSync(out,{recursive:true});
for(const [name,content] of files)fs.writeFileSync(path.join(out,name),content,{flag:'wx'});
process.stdout.write(JSON.stringify({state:'ROOT10_RUNTIME_CLOCK_REPAIR_CANDIDATE_NOT_EXECUTED',authority_effect:'NONE',out,events_appended:0,pins:{root_id:ROOT,generation:GEN,ga_id:GA,activation_sequence:119,amendment_sha256:AMEND_SHA,new_binding:NEW_BINDING,installed_function_sha256:OLD_FN,repaired_function_sha256:NEW_FN},files:Object.fromEntries(files.map(([name,content])=>[name,{sha256:sha(content),bytes:Buffer.byteLength(content)}]))},null,2)+'\n');
