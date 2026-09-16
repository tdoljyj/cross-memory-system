// Root10 scope amendment activation kit builder. Candidate only: it connects to
// nothing, executes nothing, signs nothing and issues nothing. Every digest it
// writes is computed from bytes on disk in this working tree.
//
//   node build-root10-scope-amendment-activation.mjs [outdir] [--draft]
//
// Reads the three *.scope.sql drafts, Root10ScopeAmendment.json and the two
// stage-2 materials, substitutes every placeholder token, and emits the
// apply-once / full-rollback / readback artifacts. It throws if any placeholder
// would survive into an artifact, and refuses if any new binding pin equals the
// pin it is supposed to replace.
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
const IDEM='root10_scope_amendment_20260915';
const RC_IDEM='root10_runtime_clock_amendment_20260915';
const CHARGED_SECONDS=11706,CHARGED_BYTES=2604247987;
const EXPECTED_SEQUENCE=119,ACTIVATION_SEQUENCE=120,BUDGET_SEQUENCE=117;
const APPLICABLE=['PQUAL-11','PQUAL-13','PQUAL-15','PQUAL-16','PQUAL-17'];
const OUT_OF_SCOPE=['PQUAL-01','PQUAL-02','PQUAL-03','PQUAL-04','PQUAL-05','PQUAL-06','PQUAL-07','PQUAL-08','PQUAL-09','PQUAL-10','PQUAL-12','PQUAL-14','PQUAL-19','PQUAL-20'];

// The live event-119 pins. Written literally: they are what the control store
// holds today, and a build script must never silently re-derive a pin it is
// about to assert the database against.
const OLD={controller:'5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6',qualification:'6a7145fa0c09a00a917b40c42f5dbaa38f4c6028e75ab747dd234351b993b849',runtime:'321221816f4c368d98833de6f698adcb1835d88e6b7c991c0b9d9537abba3c1e'};
const RC_AMEND_SHA='e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402';
const OLD_BINDING={gate_id:'G-PREENTRY-SKILL-QUALIFICATION',root_id:ROOT,gate_sha256:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',gate_version:'fixed-synthetic-20260910.v10-env-order-repair',scope_sha256:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',prior_seconds:1506,profile_sha256:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',controller_sha256:OLD.controller,prior_evidence_bytes:322546611,qualification_sha256:OLD.qualification,runtime_acceptance_sha256:OLD.runtime};

const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const gitBlobSha=buf=>crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const die=m=>{throw Error(m);};
const q=s=>s.replaceAll("'","''");
const read=p=>fs.readFileSync(p,'utf8');
const exactKeys=(v,keys,label)=>{if(!v||Array.isArray(v)||typeof v!=='object'||JSON.stringify(Object.keys(v).sort())!==JSON.stringify([...keys].sort()))die(label);};
const sameList=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

const args=process.argv.slice(2);
const DRAFT=args.includes('--draft');
const positional=args.filter(a=>!a.startsWith('--'));
if(args.some(a=>a.startsWith('--')&&a!=='--draft'))die('usage: node build-root10-scope-amendment-activation.mjs [outdir] [--draft]');
if(positional.length>1)die('usage: node build-root10-scope-amendment-activation.mjs [outdir] [--draft]');

const here=path.dirname(fileURLToPath(import.meta.url));
const rcDir=path.resolve(here,'..','runtime-clock','activation');

// ---------------------------------------------------------------------------
// 1. The Owner amendment. Digests come from the bytes, never from a constant.
// ---------------------------------------------------------------------------
const amendmentPath=path.join(here,'Root10ScopeAmendment.json');
const amendmentBytes=fs.readFileSync(amendmentPath);
const amendmentRaw=amendmentBytes.toString('utf8'),amendment=JSON.parse(amendmentRaw);
exactKeys(amendment,['object_type','schema_version','root_id','control_trust_root_generation','supersedes','activation','carries_forward','why','amended_terms','preserved_invariants','removed_restrictions','authority_effect'],'amendment keys');
exactKeys(amendment.carries_forward,['object_type','activation_sequence','disposition','note'],'amendment carries_forward keys');
const terms=amendment.amended_terms?.applicable_test_set_for_this_generation;
exactKeys(terms,['rule','applicable_test_ids','out_of_scope_test_ids','disposition_of_out_of_scope_tests'],'amendment applicable_test_set keys');
if(amendment.object_type!=='Root10ScopeAmendment'||amendment.schema_version!=='1.0'||amendment.root_id!==ROOT||amendment.control_trust_root_generation!==GEN||amendment.carries_forward.object_type!=='Root10RuntimeClockAmendment'||amendment.carries_forward.activation_sequence!==EXPECTED_SEQUENCE||amendment.carries_forward.disposition!=='ALL_RUNTIME_CLOCK_TERMS_REMAIN_IN_FORCE_UNCHANGED'||amendment.authority_effect!=='NONE')die('amendment semantics');
if(!sameList(terms.applicable_test_ids,APPLICABLE)||!sameList(terms.out_of_scope_test_ids,OUT_OF_SCOPE))die('amendment test set does not match the set this kit writes');
if(new Set([...APPLICABLE,...OUT_OF_SCOPE]).size!==19)die('applicable + out-of-scope must partition the 19-test suite');
if(amendment.preserved_invariants?.no_double_charge===undefined||amendment.preserved_invariants?.no_new_authority===undefined)die('amendment must preserve no_double_charge and no_new_authority');
const AMEND_SHA=sha(amendmentBytes);
const AMEND_BLOB=gitBlobSha(amendmentBytes);
const AMEND_REF={uri:`https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${AMEND_BLOB}`,sha256:AMEND_SHA};

// ---------------------------------------------------------------------------
// 2. The two stage-2 materials. Their digests are the new binding pins, and are
//    computed from the bytes on disk -- never taken from a config or a literal.
// ---------------------------------------------------------------------------
const qualificationPath=path.join(here,'ControllerQualification.root10.scope.json');
const acceptancePath=path.join(here,'RuntimeAcceptance.root10.scope.json');
const qualificationBytes=fs.readFileSync(qualificationPath),acceptanceBytes=fs.readFileSync(acceptancePath);
const qualification=JSON.parse(qualificationBytes.toString('utf8')),acceptance=JSON.parse(acceptanceBytes.toString('utf8'));
const NEW_QUALIFICATION=sha(qualificationBytes),NEW_ACCEPTANCE=sha(acceptanceBytes);
const NEW_CONTROLLER=qualification.controller_digest;
if(!/^[0-9a-f]{64}$/.test(NEW_CONTROLLER??''))die('qualification controller_digest');
if(acceptance.controller_digest!==NEW_CONTROLLER)die('acceptance controller_digest must equal the qualification controller_digest');
if(qualification.root_id!==ROOT||qualification.generation_id!==GEN)die('qualification root/generation');
if(qualification.amendment_object_type!=='Root10ScopeAmendment')die('qualification amendment_object_type');
if(qualification.amendment_ref?.sha256!==AMEND_SHA||qualification.amendment_ref?.uri!==AMEND_REF.uri)die('qualification amendment_ref must be the amendment bytes on disk');
if(qualification.predecessor_controller_digest!==OLD.controller)die('qualification predecessor_controller_digest must be the live pin');
if(qualification.scope_digest!==OLD_BINDING.scope_sha256||acceptance.scope_digest!==OLD_BINDING.scope_sha256)die('scope_digest must carry forward unchanged');
if(qualification.qualification_issued!==false||acceptance.acceptance_issued!==false||qualification.signature_verified!==false||acceptance.signature_verified!==false)die('materials must not claim issuance or signature');
if(qualification.first_budget_sequence!==BUDGET_SEQUENCE)die('qualification first_budget_sequence');
const historical=(acceptance.accepted_subject?.historical_component_evidence??[]).map(e=>e.test_id).slice().sort();
if(!sameList(historical,[...APPLICABLE].sort()))die('APPLICABLE_SET_MUST_MATCH_HISTORICAL_EVIDENCE');

// No new pin may equal the pin it replaces: an unchanged digest means the
// material was never rebuilt, and event 120 would re-assert event 119.
if(NEW_CONTROLLER===OLD.controller)die('new controller pin equals the live controller pin');
if(NEW_QUALIFICATION===OLD.qualification)die('new qualification pin equals the live qualification pin');
if(NEW_ACCEPTANCE===OLD.runtime)die('new runtime acceptance pin equals the live runtime acceptance pin');
if(new Set([NEW_CONTROLLER,NEW_QUALIFICATION,NEW_ACCEPTANCE]).size!==3)die('the three new pins must be distinct');

// Publication-dependent fields the Owner merge has not produced yet. Their
// bytes are inside the qualification, so its sha256 -- and therefore the whole
// event-120 body -- changes the moment they are filled. Emitting anyway is
// allowed only under an explicit --draft, and the artifacts say so.
const unresolvedPublication=(qualificationBytes.toString('utf8').match(/__[A-Z][A-Z0-9_]*__/g)??[]);
if(unresolvedPublication.length&&!DRAFT)die(`ControllerQualification.root10.scope.json still carries ${unresolvedPublication.join(', ')}; its sha256 is not final. Re-run after the Owner merge, or pass --draft to emit a marked, non-executable draft.`);
if((acceptanceBytes.toString('utf8').match(/__[A-Z][A-Z0-9_]*__/g)??[]).length)die('RuntimeAcceptance.root10.scope.json carries unresolved placeholders');
if((amendmentRaw.match(/__[A-Z][A-Z0-9_]*__/g)??[]).length)die('Root10ScopeAmendment.json carries unresolved placeholders');

// ---------------------------------------------------------------------------
// 3. Substitute the three scope drafts.
// ---------------------------------------------------------------------------
const NEW_BINDING={...OLD_BINDING,controller_sha256:NEW_CONTROLLER,qualification_sha256:NEW_QUALIFICATION,runtime_acceptance_sha256:NEW_ACCEPTANCE};
const SUBS={__SCOPE_AMEND_SHA256__:AMEND_SHA,__SCOPE_AMEND_BLOB_SHA1__:AMEND_BLOB,__NEW_CONTROLLER_SHA256__:NEW_CONTROLLER,__NEW_QUALIFICATION_SHA256__:NEW_QUALIFICATION,__NEW_ACCEPTANCE_SHA256__:NEW_ACCEPTANCE};
const noPlaceholders=(s,label)=>{const m=s.match(/__[A-Z][A-Z0-9_]*__/);if(m)die(`unsubstituted placeholder ${m[0]} in ${label}`);return s;};
const substitute=(s,label)=>{for(const [token,value] of Object.entries(SUBS)){if(!s.includes(token))die(`${label} missing ${token}`);s=s.split(token).join(value);}return noPlaceholders(s,label);};

const SCOPE_NAMES=['effective_execution_binding.scope.sql','execution_transition.scope.sql','commit_gate_result.scope.sql'];
const RC_NAMES=['effective_execution_binding.runtime-clock.sql','execution_transition.runtime-clock.sql','commit_gate_result.runtime-clock.sql'];
const scope=Object.fromEntries(SCOPE_NAMES.map(n=>[n,substitute(read(path.join(here,n)),n)]));

// The event-119 bodies are the runtime-clock sources under their own tokens:
// the runtime-clock kit's new pins are exactly this amendment's old pins, so
// substituting them here reproduces the installed text rather than restating it.
const rcAmendmentBytes=fs.readFileSync(path.resolve(here,'..','runtime-clock','Root10RuntimeClockAmendment.json'));
if(sha(rcAmendmentBytes)!==RC_AMEND_SHA)die('runtime-clock amendment bytes are not the activated event-119 amendment');
const RC_SUBS={__AMEND_SHA256__:RC_AMEND_SHA,__AMEND_BLOB_SHA1__:gitBlobSha(rcAmendmentBytes),__NEW_CONTROLLER_SHA256__:OLD.controller,__NEW_QUALIFICATION_SHA256__:OLD.qualification,__NEW_ACCEPTANCE_SHA256__:OLD.runtime};
const rcSubstitute=(s,label)=>{for(const [token,value] of Object.entries(RC_SUBS)){if(!s.includes(token))die(`${label} missing ${token}`);s=s.split(token).join(value);}return noPlaceholders(s,label);};
const rc=Object.fromEntries(RC_NAMES.map(n=>[n,rcSubstitute(read(path.join(rcDir,n)),'runtime-clock/'+n)]));

// pg_get_functiondef form: the .sql sources are the catalog definition plus ';'.
const defOf=(s,label)=>{const t=s.trimEnd();if(!t.endsWith('$function$;'))die(`${label} must end with $function$;`);return t.slice(0,-1)+'\n';};
const OLD_FN={effective:sha(defOf(rc[RC_NAMES[0]],RC_NAMES[0])),transition:sha(defOf(rc[RC_NAMES[1]],RC_NAMES[1])),commit:sha(defOf(rc[RC_NAMES[2]],RC_NAMES[2]))};
const NEW_FN={effective:sha(defOf(scope[SCOPE_NAMES[0]],SCOPE_NAMES[0])),transition:sha(defOf(scope[SCOPE_NAMES[1]],SCOPE_NAMES[1])),commit:sha(defOf(scope[SCOPE_NAMES[2]],SCOPE_NAMES[2]))};
for(const k of ['effective','transition','commit'])if(OLD_FN[k]===NEW_FN[k])die(`${k} is unchanged; a scope activation must replace all three function bodies`);

// Independent check that the bodies the rollback restores are the bodies the
// committed runtime-clock repair proved installed: its post-image asserts the
// same three digests, so a mismatch means this tree is not the live text.
const repairProof=read(path.join(rcDir,'root10-runtime-clock-repair-output','root10-runtime-clock-repair.apply-once.sql'));
const proofOf=(sig,digest)=>`pg_get_functiondef('clued_control.${sig}'::regprocedure),'UTF8')),'hex')<>'${digest}'`;
for(const [sig,digest] of [['effective_execution_binding()',OLD_FN.effective],['execution_transition(jsonb)',OLD_FN.transition],['commit_gate_result(text,text,text)',OLD_FN.commit]])
 if(!repairProof.includes(proofOf(sig,digest)))die(`${sig} digest ${digest} is not the digest the committed runtime-clock repair proved installed`);

// ---------------------------------------------------------------------------
// 4. Rebuild the event-120 predicate the three functions enforce, and assert
//    that the substituted drafts contain it verbatim.
// ---------------------------------------------------------------------------
const sqlArray=xs=>`array[${xs.map(x=>`'${q(x)}'`).join(',')}]::text[]`;
const keySet=(expr,keys)=>`(select array_agg(k order by k) from jsonb_object_keys(${expr}) k)=${sqlArray([...keys].sort())}`;
const REQUEST_KEYS=['body','expected_sequence','ga_id','idempotency_key','operation'];
const BODY_KEYS=['activated_at','amendment_ref','amendment_sha256','applicable_test_ids','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','carries_forward_sequence','control_trust_root_generation','finalization_expires_at','max_predispatch_resets','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','out_of_scope_test_ids','preparation_expires_at','prior_ga_sha256','runtime_seconds'];
const BINDING_KEYS=Object.keys(OLD_BINDING);
const oldBindingSql=`'${q(JSON.stringify(OLD_BINDING))}'::jsonb`;
const newBindingSql=`'${q(JSON.stringify(NEW_BINDING))}'::jsonb`;
const applicableSql=`'${q(JSON.stringify(APPLICABLE))}'::jsonb`;
const outOfScopeSql=`'${q(JSON.stringify(OUT_OF_SCOPE))}'::jsonb`;
const scGuard=alias=>`${alias}.root_id='${ROOT}' and ${alias}.sequence=${ACTIVATION_SEQUENCE} and ${alias}.idempotency_key='${IDEM}' and ${keySet(`${alias}.request`,REQUEST_KEYS)} and ${alias}.request->>'operation'='SCOPE_AMENDMENT_ACTIVATED' and ${alias}.request->>'ga_id'='${GA}' and ${alias}.request->>'idempotency_key'='${IDEM}' and ${alias}.request->'expected_sequence'='${EXPECTED_SEQUENCE}'::jsonb and ${keySet(`${alias}.request->'body'`,BODY_KEYS)} and ${keySet(`${alias}.request->'body'->'amendment_ref'`,['sha256','uri'])} and ${alias}.request->'body'->'amendment_ref'='${q(JSON.stringify(AMEND_REF))}'::jsonb and ${alias}.request->'body'->>'amendment_sha256'='${AMEND_SHA}' and ${alias}.request->'body'->>'budget_raw_sha256'='${BUDGET_SHA}' and ${alias}.request->'body'->'budget_sequence'='${BUDGET_SEQUENCE}'::jsonb and ${alias}.request->'body'->>'prior_ga_sha256'='${GA_SHA}' and ${alias}.request->'body'->'automatic_retry'='false'::jsonb and ${alias}.request->'body'->'new_ga'='false'::jsonb and ${alias}.request->'body'->'new_budget'='false'::jsonb and ${alias}.request->'body'->'budget_refund'='false'::jsonb and ${alias}.request->'body'->>'control_trust_root_generation'='${GEN}' and ${alias}.request->'body'->'carries_forward_sequence'='${EXPECTED_SEQUENCE}'::jsonb and ${alias}.request->'body'->>'preparation_expires_at'='${PREP}' and ${alias}.request->'body'->>'finalization_expires_at'='${FINAL}' and ${alias}.request->'body'->'runtime_seconds'='600'::jsonb and ${alias}.request->'body'->'max_predispatch_resets'='3'::jsonb and (${alias}.request->'body'->>'activated_at')::timestamptz<(${alias}.request->'body'->>'finalization_expires_at')::timestamptz and ${alias}.request->'body'->'applicable_test_ids'=${applicableSql} and ${alias}.request->'body'->'out_of_scope_test_ids'=${outOfScopeSql} and ${keySet(`${alias}.request->'body'->'old_binding'`,BINDING_KEYS)} and ${alias}.request->'body'->'old_binding'=${oldBindingSql} and ${alias}.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((${alias}.request->'body'->'old_binding')::text,'UTF8')),'hex') and ${keySet(`${alias}.request->'body'->'new_binding'`,BINDING_KEYS)} and ${alias}.request->'body'->'new_binding'=${newBindingSql} and ${alias}.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((${alias}.request->'body'->'new_binding')::text,'UTF8')),'hex')`;
if(!scope[SCOPE_NAMES[1]].includes(scGuard('sc_event')))die('transition scope guard drift');
if(!scope[SCOPE_NAMES[2]].includes(scGuard('sc_event')))die('commit scope guard drift');
if(!scope[SCOPE_NAMES[0]].includes(scGuard('e')))die('effective scope guard drift');
// The scope functions must still bind event 119 by its own amendment bytes.
if(!scope[SCOPE_NAMES[0]].includes(`rc.request->'body'->>'amendment_sha256'='${RC_AMEND_SHA}'`))die('effective must pin the event-119 amendment bytes');

// ---------------------------------------------------------------------------
// 5. Emit.
// ---------------------------------------------------------------------------
const banner=unresolvedPublication.length?`-- DRAFT -- NOT EXECUTABLE. ControllerQualification.root10.scope.json still carries unresolved publication
-- placeholders for its source_publication.owner_merge_commit and source_publication.source_tree fields.
-- Its sha256 (${NEW_QUALIFICATION}) is therefore a draft digest and WILL change
-- when the Owner merge fills them. Re-run this builder after the merge and discard this artifact.
`:'';
const amendmentB64=amendmentBytes.toString('base64');
const applyOnce=`${banner}-- Root10 scope amendment activation. Candidate only; one transaction; no GA, no budget, no refund, no authority effect.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='90s';
create temp table _root10_scope_fn on commit drop as select p.oid,n.nspname,p.proname,pg_get_functiondef(p.oid) def,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') digest,p.proowner,p.proacl::text acl,p.proconfig::text config,p.prosecdef,p.provolatile,p.prokind,p.proparallel,p.proleakproof from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid in ('clued_control.effective_execution_binding()'::regprocedure,'clued_control.execution_transition(jsonb)'::regprocedure,'clued_control.commit_gate_result(text,text,text)'::regprocedure);
do $pre$ declare h clued_control.current_head;c clued_control.execution_current;a clued_control.gate_attempts;b clued_control.execution_binding;budget clued_control.execution_events;rc clued_control.execution_events; amendment_raw text:=convert_from(decode('${amendmentB64}','base64'),'UTF8');begin
 if (select count(*) from _root10_scope_fn)<>3 or (select digest from _root10_scope_fn where proname='effective_execution_binding')<>'${OLD_FN.effective}' or (select digest from _root10_scope_fn where proname='execution_transition')<>'${OLD_FN.transition}' or (select digest from _root10_scope_fn where proname='commit_gate_result')<>'${OLD_FN.commit}' then raise exception 'ROOT10_SCOPE_FUNCTION_PREIMAGE_DRIFT'; end if;
 select * into h from clued_control.current_head where root_id='${ROOT}' for share; select * into c from clued_control.execution_current where root_id='${ROOT}' for update; select * into a from clued_control.gate_attempts where root_id='${ROOT}' and ga_id='${GA}' for update; select * into b from clued_control.effective_execution_binding(); select * into budget from clued_control.execution_events where root_id='${ROOT}' and sequence=${BUDGET_SEQUENCE}; select * into rc from clued_control.execution_events where root_id='${ROOT}' and sequence=${EXPECTED_SEQUENCE};
 if h.sequence<>10 or h.generation_id<>'${GEN}' or h.revoked or c.sequence<>${EXPECTED_SEQUENCE} or c.active_ga_id<>'${GA}' or c.pending_budget_sequence is not null or c.charged_seconds<>${CHARGED_SECONDS} or c.charged_evidence_bytes<>${CHARGED_BYTES} or a.phase<>'PENDING' or a.sequence<>0 or a.container_id is not null or a.decision is not null or a.receipt_raw is not null or a.revoked or a.ga_sha256<>'${GA_SHA}' or a.budget_sequence<>${BUDGET_SEQUENCE} or a.ga->>'control_trust_root_generation'<>'${GEN}' or exists(select 1 from clued_control.execution_events e where e.root_id='${ROOT}' and e.sequence>${EXPECTED_SEQUENCE}) then raise exception 'ROOT10_SCOPE_EXACT_PREIMAGE_REQUIRED'; end if;
 if rc.idempotency_key<>'${RC_IDEM}' or rc.request->>'operation'<>'RUNTIME_CLOCK_AMENDMENT_ACTIVATED' or rc.request->>'ga_id'<>'${GA}' or rc.request->'body'->>'amendment_sha256'<>'${RC_AMEND_SHA}' or rc.request->'body'->'new_binding'<>${oldBindingSql} or rc.request->'body'->>'preparation_expires_at'<>'${PREP}' or rc.request->'body'->>'finalization_expires_at'<>'${FINAL}' or rc.request->'body'->'runtime_seconds'<>'600'::jsonb or rc.request->'body'->'max_predispatch_resets'<>'3'::jsonb or rc.request->'body'->>'budget_raw_sha256'<>'${BUDGET_SHA}' or rc.request->'body'->'budget_sequence'<>'${BUDGET_SEQUENCE}'::jsonb or rc.request->'body'->>'prior_ga_sha256'<>'${GA_SHA}' then raise exception 'ROOT10_SCOPE_RUNTIME_CLOCK_PREDECESSOR_DRIFT'; end if;
 if budget.request->>'operation'<>'BUDGET_RESERVED' or budget.request->'body'->>'sha256'<>'${BUDGET_SHA}' or encode(sha256(convert_to(budget.request->'body'->>'raw','UTF8')),'hex')<>'${BUDGET_SHA}' or b.controller_sha256<>'${OLD.controller}' or b.qualification_sha256<>'${OLD.qualification}' or b.runtime_acceptance_sha256<>'${OLD.runtime}' or to_jsonb(b)<>${oldBindingSql} or not (${keySet('to_jsonb(b)',BINDING_KEYS)}) then raise exception 'ROOT10_SCOPE_BUDGET_OR_BINDING_PREIMAGE_DRIFT'; end if;
 if encode(sha256(convert_to(amendment_raw,'UTF8')),'hex')<>'${AMEND_SHA}' or amendment_raw::jsonb->>'object_type'<>'Root10ScopeAmendment' or amendment_raw::jsonb->>'root_id'<>'${ROOT}' or amendment_raw::jsonb->>'control_trust_root_generation'<>'${GEN}' or amendment_raw::jsonb->'carries_forward'->>'object_type'<>'Root10RuntimeClockAmendment' or amendment_raw::jsonb->'carries_forward'->'activation_sequence'<>'${EXPECTED_SEQUENCE}'::jsonb or amendment_raw::jsonb->>'authority_effect'<>'NONE' or amendment_raw::jsonb->'amended_terms'->'applicable_test_set_for_this_generation'->'applicable_test_ids'<>${applicableSql} or amendment_raw::jsonb->'amended_terms'->'applicable_test_set_for_this_generation'->'out_of_scope_test_ids'<>${outOfScopeSql} then raise exception 'ROOT10_SCOPE_OWNER_AMENDMENT_BYTES_REQUIRED'; end if;
 if clock_timestamp()>='${FINAL}'::timestamptz-interval '10 minutes' then raise exception 'ROOT10_SCOPE_INSUFFICIENT_WINDOW'; end if;
end $pre$;
${scope[SCOPE_NAMES[0]].trimEnd()}
${scope[SCOPE_NAMES[1]].trimEnd()}
${scope[SCOPE_NAMES[2]].trimEnd()}
do $activate$ declare c clued_control.execution_current;a clued_control.gate_attempts;oldb jsonb;newb jsonb;request jsonb;activated timestamptz:=clock_timestamp();begin
 if activated>='${FINAL}'::timestamptz-interval '10 minutes' then raise exception 'ROOT10_SCOPE_INSUFFICIENT_WINDOW'; end if;
 select * into c from clued_control.execution_current where root_id='${ROOT}' for update; select * into a from clued_control.gate_attempts where root_id='${ROOT}' and ga_id='${GA}' for update; select to_jsonb(x) into oldb from clued_control.effective_execution_binding() x;
 if oldb<>${oldBindingSql} or not (${keySet('oldb',BINDING_KEYS)}) then raise exception 'ROOT10_SCOPE_OLD_BINDING_DRIFT'; end if;
 newb:=oldb||jsonb_build_object('controller_sha256','${NEW_CONTROLLER}','qualification_sha256','${NEW_QUALIFICATION}','runtime_acceptance_sha256','${NEW_ACCEPTANCE}');
 if newb<>${newBindingSql} or not (${keySet('newb',BINDING_KEYS)}) or (select count(*) from jsonb_each(oldb) o join jsonb_each(newb) n using(key) where o.value is distinct from n.value)<>3 then raise exception 'ROOT10_SCOPE_BINDING_DIFF_INVALID'; end if;
 request:=jsonb_build_object('operation','SCOPE_AMENDMENT_ACTIVATED','ga_id','${GA}','expected_sequence',${EXPECTED_SEQUENCE},'idempotency_key','${IDEM}','body',jsonb_build_object('activated_at',activated,'amendment_ref','${q(JSON.stringify(AMEND_REF))}'::jsonb,'amendment_sha256','${AMEND_SHA}','applicable_test_ids',${applicableSql},'automatic_retry',false,'budget_raw_sha256','${BUDGET_SHA}','budget_refund',false,'budget_sequence',${BUDGET_SEQUENCE},'carries_forward_sequence',${EXPECTED_SEQUENCE},'control_trust_root_generation','${GEN}','finalization_expires_at','${FINAL}','max_predispatch_resets',3,'new_binding',newb,'new_binding_sha256',encode(sha256(convert_to(newb::text,'UTF8')),'hex'),'new_budget',false,'new_ga',false,'old_binding',oldb,'old_binding_sha256',encode(sha256(convert_to(oldb::text,'UTF8')),'hex'),'out_of_scope_test_ids',${outOfScopeSql},'preparation_expires_at','${PREP}','prior_ga_sha256','${GA_SHA}','runtime_seconds',600));
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values('${ROOT}',${ACTIVATION_SEQUENCE},'${IDEM}',request);
 update clued_control.execution_current set sequence=${ACTIVATION_SEQUENCE} where root_id='${ROOT}' and sequence=${EXPECTED_SEQUENCE} and active_ga_id='${GA}' and pending_budget_sequence is null and charged_seconds=${CHARGED_SECONDS} and charged_evidence_bytes=${CHARGED_BYTES}; if not found then raise exception 'ROOT10_SCOPE_ACTIVATION_CAS_FAILED'; end if;
end $activate$;
do $post$ declare c clued_control.execution_current;a clued_control.gate_attempts;e clued_control.execution_events;rc clued_control.execution_events;b clued_control.execution_binding;begin select * into c from clued_control.execution_current where root_id='${ROOT}';select * into a from clued_control.gate_attempts where root_id='${ROOT}' and ga_id='${GA}';select * into e from clued_control.execution_events where root_id='${ROOT}' and sequence=${ACTIVATION_SEQUENCE};select * into rc from clued_control.execution_events where root_id='${ROOT}' and sequence=${EXPECTED_SEQUENCE};select * into b from clued_control.effective_execution_binding(); if c.sequence<>${ACTIVATION_SEQUENCE} or c.active_ga_id<>'${GA}' or c.pending_budget_sequence is not null or c.charged_seconds<>${CHARGED_SECONDS} or c.charged_evidence_bytes<>${CHARGED_BYTES} or a.phase<>'PENDING' or a.sequence<>0 or a.container_id is not null or a.decision is not null or a.receipt_raw is not null or a.revoked or a.ga_sha256<>'${GA_SHA}' or a.budget_sequence<>${BUDGET_SEQUENCE} or rc.idempotency_key<>'${RC_IDEM}' or rc.request->'body'->>'amendment_sha256'<>'${RC_AMEND_SHA}' or not (${scGuard('e')}) or e.request->'body'->'old_binding'<>rc.request->'body'->'new_binding' or b.controller_sha256<>'${NEW_CONTROLLER}' or b.qualification_sha256<>'${NEW_QUALIFICATION}' or b.runtime_acceptance_sha256<>'${NEW_ACCEPTANCE}' or to_jsonb(b)<>${newBindingSql} or (select count(*) from clued_control.execution_events x where x.root_id='${ROOT}' and x.sequence>${ACTIVATION_SEQUENCE})<>0 or (select count(*) from _root10_scope_fn o join pg_proc p on p.oid=o.oid where p.proowner<>o.proowner or p.proacl::text is distinct from o.acl or p.proconfig::text is distinct from o.config or p.prosecdef<>o.prosecdef or p.provolatile<>o.provolatile or p.prokind<>o.prokind or p.proparallel<>o.proparallel or p.proleakproof<>o.proleakproof)<>0 or encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.effective}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.transition}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex')<>'${NEW_FN.commit}' then raise exception 'ROOT10_SCOPE_POSTIMAGE_DRIFT'; end if; end $post$;
select jsonb_build_object('state','ROOT10_SCOPE_AMENDMENT_ACTIVATED','execution_sequence',${ACTIVATION_SEQUENCE},'carries_forward_sequence',${EXPECTED_SEQUENCE},'ga_id','${GA}','ga_sha256','${GA_SHA}','budget_sequence',${BUDGET_SEQUENCE},'budget_sha256','${BUDGET_SHA}','new_ga',false,'new_budget',false,'charged_seconds',${CHARGED_SECONDS},'charged_evidence_bytes',${CHARGED_BYTES},'runtime_seconds',600,'max_predispatch_resets',3,'preparation_expires_at','${PREP}','finalization_expires_at','${FINAL}','applicable_test_ids',${applicableSql},'out_of_scope_test_ids',${outOfScopeSql},'function_sha256',jsonb_build_object('effective_execution_binding','${NEW_FN.effective}','execution_transition','${NEW_FN.transition}','commit_gate_result','${NEW_FN.commit}'),'authority_effect','NONE');
commit;
`;

const rollback=`${banner}-- Root10 scope amendment full rollback. One transaction; restores the three event-119 function bodies
-- verbatim and removes event 120 only when nothing was built on it.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='90s';
do $guard$ declare c clued_control.execution_current;a clued_control.gate_attempts;e clued_control.execution_events;rc clued_control.execution_events;begin
 select * into c from clued_control.execution_current where root_id='${ROOT}' for update; select * into a from clued_control.gate_attempts where root_id='${ROOT}' and ga_id='${GA}' for update; select * into e from clued_control.execution_events where root_id='${ROOT}' and sequence=${ACTIVATION_SEQUENCE}; select * into rc from clued_control.execution_events where root_id='${ROOT}' and sequence=${EXPECTED_SEQUENCE};
 if c.sequence<>${ACTIVATION_SEQUENCE} or c.active_ga_id<>'${GA}' or c.pending_budget_sequence is not null or c.charged_seconds<>${CHARGED_SECONDS} or c.charged_evidence_bytes<>${CHARGED_BYTES} or a.phase<>'PENDING' or a.sequence<>0 or a.container_id is not null or a.decision is not null or a.receipt_raw is not null or a.revoked or a.ga_sha256<>'${GA_SHA}' or a.budget_sequence<>${BUDGET_SEQUENCE} or e.idempotency_key<>'${IDEM}' or e.request->>'operation'<>'SCOPE_AMENDMENT_ACTIVATED' or e.request->>'ga_id'<>'${GA}' or rc.idempotency_key<>'${RC_IDEM}' or rc.request->>'operation'<>'RUNTIME_CLOCK_AMENDMENT_ACTIVATED' or rc.request->'body'->>'amendment_sha256'<>'${RC_AMEND_SHA}' or exists(select 1 from clued_control.execution_events x where x.root_id='${ROOT}' and x.sequence>${ACTIVATION_SEQUENCE}) then raise exception 'ROOT10_SCOPE_ROLLBACK_GUARD_FAILED'; end if;
end $guard$;
${rc[RC_NAMES[0]].trimEnd()}
${rc[RC_NAMES[1]].trimEnd()}
${rc[RC_NAMES[2]].trimEnd()}
do $undo$ declare b clued_control.execution_binding;begin
 delete from clued_control.execution_events where root_id='${ROOT}' and sequence=${ACTIVATION_SEQUENCE} and idempotency_key='${IDEM}' and request->>'operation'='SCOPE_AMENDMENT_ACTIVATED'; if not found then raise exception 'ROOT10_SCOPE_ROLLBACK_EVENT_MISSING'; end if;
 update clued_control.execution_current set sequence=${EXPECTED_SEQUENCE} where root_id='${ROOT}' and sequence=${ACTIVATION_SEQUENCE} and active_ga_id='${GA}'; if not found then raise exception 'ROOT10_SCOPE_ROLLBACK_CAS_FAILED'; end if;
 select * into b from clued_control.effective_execution_binding(); if to_jsonb(b)<>${oldBindingSql} or encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex')<>'${OLD_FN.effective}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex')<>'${OLD_FN.transition}' or encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex')<>'${OLD_FN.commit}' then raise exception 'ROOT10_SCOPE_ROLLBACK_POSTIMAGE_DRIFT'; end if;
end $undo$;
commit;
`;

const readback=`${banner}select jsonb_build_object('observed_at',clock_timestamp(),'scope_event',(select to_jsonb(e) from clued_control.execution_events e where e.root_id='${ROOT}' and e.sequence=${ACTIVATION_SEQUENCE} and e.idempotency_key='${IDEM}'),'runtime_clock_event',(select to_jsonb(e) from clued_control.execution_events e where e.root_id='${ROOT}' and e.sequence=${EXPECTED_SEQUENCE} and e.idempotency_key='${RC_IDEM}'),'current_sequence',(select c.sequence from clued_control.execution_current c where c.root_id='${ROOT}'),'effective_binding',(select to_jsonb(b) from clued_control.effective_execution_binding() b),'function_sha256',jsonb_build_object('effective_execution_binding',encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex'),'execution_transition',encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex'),'commit_gate_result',encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex')),'authority_effect','NONE');
`;

const files=[['root10-scope-amendment-activation.apply-once.sql',applyOnce],['root10-scope-amendment-activation.full-rollback.sql',rollback],['root10-scope-amendment-activation.readback.sql',readback]];
for(const [name,content] of files)noPlaceholders(content,name);
const out=path.resolve(positional[0]??path.join(here,'root10-scope-amendment-activation-output'));
fs.mkdirSync(out,{recursive:true});
for(const [name,content] of files)fs.writeFileSync(path.join(out,name),content,{flag:'wx'});
process.stdout.write(JSON.stringify({
 state:DRAFT?'ROOT10_SCOPE_AMENDMENT_ACTIVATION_DRAFT_NOT_EXECUTED':'ROOT10_SCOPE_AMENDMENT_ACTIVATION_CANDIDATE_NOT_EXECUTED',
 authority_effect:'NONE',
 live_database_write:false,
 draft:DRAFT,
 unresolved_publication_placeholders:unresolvedPublication,
 out,
 inputs:{amendment_sha256:AMEND_SHA,amendment_blob_sha1:AMEND_BLOB,amendment_ref:AMEND_REF,new_controller_sha256:NEW_CONTROLLER,new_qualification_sha256:NEW_QUALIFICATION,new_runtime_acceptance_sha256:NEW_ACCEPTANCE},
 pins:{root_id:ROOT,generation:GEN,ga_id:GA,ga_sha256:GA_SHA,budget_sequence:BUDGET_SEQUENCE,budget_sha256:BUDGET_SHA,expected_sequence:EXPECTED_SEQUENCE,activation_sequence:ACTIVATION_SEQUENCE,charged_seconds:CHARGED_SECONDS,charged_evidence_bytes:CHARGED_BYTES,preparation_expires_at:PREP,finalization_expires_at:FINAL,runtime_seconds:600,max_predispatch_resets:3,applicable_test_ids:APPLICABLE,out_of_scope_test_ids:OUT_OF_SCOPE,runtime_clock_amendment_sha256:RC_AMEND_SHA,old_binding:OLD_BINDING,new_binding:NEW_BINDING,old_function_sha256:OLD_FN,new_function_sha256:NEW_FN},
 files:Object.fromEntries(files.map(([name,content])=>[name,{sha256:sha(content),bytes:Buffer.byteLength(content)}])),
},null,2)+'\n');
