import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const repo='C:/Users/17531/.codex/projects/codex-memory-v16-cutover';
const safe=repo;
const publicationCommit='3694ae41d6e80602ac73da9c6f73667277881d61';
const publicationTree='eeb579aa12bcfa5ed3e6f4fd3eeaa452ad688fc8';
const base='work/recovery-root9/chain-controller-activation-stage-a';
const sha=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const need=(v,m)=>{if(!v)throw Error(m)};
const git=(args,options={})=>execFileSync('git',['-c',`safe.directory=${safe}`,'-C',repo,...args],options);
need(git(['cat-file','-t',publicationCommit],{encoding:'utf8'}).trim()==='commit','PINNED_PUBLICATION_COMMIT_MISSING');
need(git(['show','-s','--format=%T',publicationCommit],{encoding:'utf8'}).trim()===publicationTree,'PINNED_PUBLICATION_TREE_MISMATCH');

const pins={
 'BlockedGRR.ga6.raw.json':{blob:'d7b2afdc44116275d53a25bf8e37f23af0569a06',sha256:'3d6fc55e6d2065fb40974161f3c0abb556817989c560e3072a080bea033ccfdd'},
 'BlockedDecision.ga6.raw.json':{blob:'47dcf3dfe1d2f0ea7a86a73abe53d8bfd8d7538d',sha256:'be4951c1c8177efd8fd9371669ba7988610cc84080c01500d33349f89214f0e4'},
 'BlockedEvidenceIndex.ga6.raw.json':{blob:'377c55dd41e269a91a332dcd8583009476729b4f',sha256:'6f935fa4e5d9c2ca8544653fe01a74f703f36452daa46460b8409373b40c764c'},
 'DockerNotStartedObservation.ga6.json':{blob:'d2244bb4ea32c88a3300f9a37f7a92530ff8642a',sha256:'1556f55026e8861a059fada73c8d91127a885232856023aea0203aae03337dc6'},
 'BlockedGRR.ga6.signature.verified.json':{blob:'81f23d230696ead8e62eab0dbf3f8cba2d2ae153'},
};
const show=name=>{
 const spec=`${publicationCommit}:${base}/${name}`;
 need(git(['rev-parse',spec],{encoding:'utf8'}).trim()===pins[name].blob,`PINNED_GIT_BLOB_MISMATCH:${name}`);
 const value=git(['show',spec],{encoding:'utf8'}).replace(/\r\n/g,'\n');
 if(pins[name].sha256)need(sha(value)===pins[name].sha256,`PINNED_RAW_SHA256_MISMATCH:${name}`);
 return value;
};
const raw={grr:show('BlockedGRR.ga6.raw.json'),decision:show('BlockedDecision.ga6.raw.json'),index:show('BlockedEvidenceIndex.ga6.raw.json'),observation:show('DockerNotStartedObservation.ga6.json'),signature:show('BlockedGRR.ga6.signature.verified.json')};
const parsed=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,JSON.parse(v)]));
const root='ctr_414bd3c724264a83894b0c55cf2ab878';
const gen='ctrgen_308a1dfc185cff633892638581e0a34c';
const ga='ga_6addc4f9764b69ba8c10d258135ae0d4';
const gaSha='327bb92ca8a27f8e67eac06daaa27afa5df99814823fe0a2eb69b7c41747641a';
const controller='9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1';
const decisionSha=pins['BlockedDecision.ga6.raw.json'].sha256,indexSha=pins['BlockedEvidenceIndex.ga6.raw.json'].sha256,observationSha=pins['DockerNotStartedObservation.ga6.json'].sha256,grrSha=pins['BlockedGRR.ga6.raw.json'].sha256;
const observationUri=`https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${pins['DockerNotStartedObservation.ga6.json'].blob}`;
const internalObservationUri=`urn:clued:execution-evidence:${root}:${observationSha}`;
const termination='EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA6';

need(parsed.grr.object_type==='GateResultReceipt'&&parsed.grr.gate_authorization_id===ga&&parsed.grr.gate_authorization_sha256===gaSha&&parsed.grr.result==='BLOCKED','EXACT_GA6_BLOCKED_GRR');
need(parsed.grr.decision_sha256===decisionSha&&parsed.grr.evidence_index_ref?.sha256===indexSha&&parsed.grr.executor_ref?.sha256===controller,'EXACT_GA6_GRR_CHAIN');
need(parsed.grr.test_results?.length===0&&parsed.grr.actual_write_set?.length===0&&parsed.grr.raw_evidence_refs?.length===1&&parsed.grr.raw_evidence_refs[0].uri===observationUri&&parsed.grr.raw_evidence_refs[0].sha256===observationSha&&parsed.grr.stop_evidence_ref?.uri===observationUri&&parsed.grr.stop_evidence_ref?.sha256===observationSha,'GA6_GRR_NO_EXECUTION_AND_EXACT_EVIDENCE');
need(parsed.decision.object_type==='Root9PredispatchBlockedDecision'&&parsed.decision.ga_id===ga&&parsed.decision.ga_sha256===gaSha&&parsed.decision.result==='BLOCKED'&&parsed.decision.termination_mode===termination&&parsed.decision.not_started_evidence_ref?.uri===observationUri&&parsed.decision.not_started_evidence_ref?.sha256===observationSha&&parsed.decision.test_results?.length===0&&parsed.decision.authority_effect==='NONE','EXACT_GA6_BLOCKED_DECISION');
need(parsed.index.object_type==='Root9PredispatchBlockedEvidenceIndex'&&parsed.index.ga_id===ga&&parsed.index.ga_sha256===gaSha&&parsed.index.tests?.length===0&&parsed.index.artifacts?.length===1&&parsed.index.authority_effect==='NONE'&&parsed.index.artifacts[0].uri===observationUri&&parsed.index.artifacts[0].sha256===observationSha&&parsed.index.artifacts[0].raw===raw.observation,'EXACT_GA6_BLOCKED_INDEX');
need(parsed.observation.kind==='EXPIRED_PREDISPATCH_NOT_STARTED_RECONCILIATION_ROOT9'&&parsed.observation.root_id===root&&parsed.observation.ga_id===ga&&parsed.observation.ga_sha256===gaSha&&parsed.observation.controller_digest===controller&&parsed.observation.execution_sequence===110&&parsed.observation.not_started===true&&parsed.observation.container_id===null&&parsed.observation.create_intent_present===false&&parsed.observation.start_intent_present===false&&parsed.observation.nonce_directory_present===false&&parsed.observation.stop_action_performed===false&&parsed.observation.docker_inventory?.length===0&&parsed.observation.event_sequences?.length===0&&parsed.observation.authority_effect==='NONE','EXACT_GA6_NEVER_STARTED_FACTS');
need(parsed.signature.state==='ACTUAL_EXACT_HISTORICAL_SIGNATURE_VERIFIED'&&parsed.signature.type==='GateResultReceipt'&&parsed.signature.id==='grr_root9_exact_pair_ga6_blocked_20260915'&&parsed.signature.payload_sha256===grrSha,'SIGNATURE_EVIDENCE_SUBJECT');
need(parsed.signature.commit_sha==='344cd2fa4c700320acc3e18ec8cde1052b8417c7'&&parsed.signature.commitment_blob_sha1==='a4b9b149c8e328aeb6459a20a127061c2e818091'&&parsed.signature.commitment_sha256==='16775aa9323a7a08c0e931a3cc9b91da24067564439979c30635a073357c28db','SIGNATURE_EVIDENCE_COMMITMENT');
need(parsed.signature.verified?.state==='HISTORICAL_SIGNATURE_OBSERVED_ONLY'&&parsed.signature.verified?.algorithm==='GITHUB_API_VERIFIED_OWNER_SINGLE_PARENT_COMMITMENT_V1_CANDIDATE'&&parsed.signature.verified?.commit_sha===parsed.signature.commit_sha&&parsed.signature.verified?.commitment_sha256===parsed.signature.commitment_sha256&&parsed.signature.verified?.authority_effect==='NONE'&&parsed.signature.authority_effect==='NONE'&&parsed.signature.current_admission_claimed===false&&parsed.signature.automatic_retry===false,'SIGNATURE_EVIDENCE_BINDING');

const originalExecutionSha='96ee8ccbcfaa97ffce03a3a233968bd9f4db04b61cc333dac6977f39d38cd754';
const originalExecution=fs.readFileSync(path.join(here,'live-functions','execution_transition.sql'),'utf8').replace(/\r\n/g,'\n').trimEnd()+'\n';
need(sha(originalExecution)===originalExecutionSha,'LOCAL_LIVE_EXECUTION_PREIMAGE_MISMATCH');
const replaceOnce=(source,from,to,label)=>{need(source.split(from).length-1===1,`TRANSFORM_SOURCE_NOT_UNIQUE:${label}`);const value=source.replace(from,()=>to);need(value!==source,`TRANSFORM_DID_NOT_APPLY:${label}`);return value};
let exactExecution=replaceOnce(originalExecution,' r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb; field_name text;',' r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb; field_name text;\n reconciliation jsonb; decision_json jsonb; index_json jsonb;','DECLARE_EXACT_EVIDENCE');
exactExecution=replaceOnce(exactExecution,"      and p->'body'->>'result'='STALE'\n      and not exists(",`      and p->'body'->>'result' in ('STALE','BLOCKED')
      and (p->'body'->>'result'='STALE' or (
       a.ga_id='${ga}' and a.ga_sha256='${gaSha}' and a.budget_sequence=102
       and a.ga->>'control_trust_root_generation'='${gen}' and a.ga->>'controller_digest'='${controller}'
       and p->'body'->>'result'='BLOCKED' and p->'body'->>'termination_mode'='${termination}'))
      and not exists(`,'ALLOW_EXACT_GA6_BLOCKED');
const marker="  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;\n  foreach field_name in array array['decision','evidence_index'] loop";
const check=`  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;
  if a.phase='PENDING' and p->'body'->>'result'='BLOCKED' then
   if a.ga_id is distinct from '${ga}' or a.ga_sha256 is distinct from '${gaSha}' or a.budget_sequence is distinct from 102 or a.revoked
   or a.ga->>'control_trust_root_generation' is distinct from '${gen}' or a.ga->>'controller_digest' is distinct from '${controller}'
   or c.root_id is distinct from '${root}' or c.sequence is distinct from 110 or c.active_ga_id is distinct from a.ga_id or c.pending_budget_sequence is not null
   or p->'body'->>'termination_mode' is distinct from '${termination}' or p->'body'->>'decision_sha256' is distinct from '${decisionSha}'
   or p->'body'->>'evidence_index_sha256' is distinct from '${indexSha}' or p->'body'->'not_started_evidence_ref'->>'sha256' is distinct from '${observationSha}'
   or p->'body'->'not_started_evidence_ref'->>'uri' is distinct from '${internalObservationUri}' or jsonb_typeof(p->'body'->'not_started_evidence_raw') is distinct from 'string'
   or not ((p->'body'->>'not_started_evidence_raw') is json object with unique keys) or encode(sha256(convert_to(p->'body'->>'not_started_evidence_raw','UTF8')),'hex') is distinct from '${observationSha}'
   then raise exception 'exact_ga6_blocked_close_required'; end if;
   reconciliation:=(p->'body'->>'not_started_evidence_raw')::jsonb; decision_json:=(p->'body'->>'decision_raw')::jsonb; index_json:=(p->'body'->>'evidence_index_raw')::jsonb;
   if reconciliation->>'kind' is distinct from 'EXPIRED_PREDISPATCH_NOT_STARTED_RECONCILIATION_ROOT9' or reconciliation->>'root_id' is distinct from root
   or reconciliation->>'ga_id' is distinct from a.ga_id or reconciliation->>'ga_sha256' is distinct from a.ga_sha256 or reconciliation->>'controller_digest' is distinct from '${controller}'
   or reconciliation->>'docker_nonce' is distinct from 'd0658ef39ecb6aa6c8a84ed993f1a823' or reconciliation->'docker_inventory' is distinct from '[]'::jsonb
   or reconciliation->'nonce_directory_present' is distinct from 'false'::jsonb or reconciliation->'create_intent_present' is distinct from 'false'::jsonb
   or reconciliation->'start_intent_present' is distinct from 'false'::jsonb or reconciliation->'not_started' is distinct from 'true'::jsonb
   or reconciliation->'container_id' is distinct from 'null'::jsonb or reconciliation->'stop_action_performed' is distinct from 'false'::jsonb
   or reconciliation->'execution_sequence' is distinct from '110'::jsonb or reconciliation->'event_sequences' is distinct from '[]'::jsonb
   or reconciliation->>'observed_at' is distinct from '2026-09-15T02:09:13.764Z' or reconciliation->>'authority_effect' is distinct from 'NONE'
   then raise exception 'exact_ga6_not_started_observation_required'; end if;
   if decision_json->>'object_type' is distinct from 'Root9PredispatchBlockedDecision' or decision_json->>'ga_id' is distinct from a.ga_id or decision_json->>'ga_sha256' is distinct from a.ga_sha256
   or decision_json->>'result' is distinct from 'BLOCKED' or decision_json->>'termination_mode' is distinct from '${termination}' or decision_json->'test_results' is distinct from '[]'::jsonb
   or decision_json->>'authority_effect' is distinct from 'NONE' or decision_json->'not_started_evidence_ref'->>'uri' is distinct from '${observationUri}' or decision_json->'not_started_evidence_ref'->>'sha256' is distinct from '${observationSha}'
   or index_json->>'object_type' is distinct from 'Root9PredispatchBlockedEvidenceIndex' or index_json->>'ga_id' is distinct from a.ga_id or index_json->>'ga_sha256' is distinct from a.ga_sha256
   or index_json->'tests' is distinct from '[]'::jsonb or index_json->>'authority_effect' is distinct from 'NONE' or jsonb_array_length(index_json->'artifacts')<>1
   or (select count(*) from jsonb_array_elements(index_json->'artifacts') x where x->>'uri'='${observationUri}' and x->>'sha256'='${observationSha}' and x->>'raw'=p->'body'->>'not_started_evidence_raw')<>1
   then raise exception 'exact_ga6_signed_decision_index_required'; end if;
  end if;
  foreach field_name in array array['decision','evidence_index'] loop`;
exactExecution=replaceOnce(exactExecution,marker,check,'CLOSE_GA6_EVIDENCE_CHAIN');
need((exactExecution.match(/end \$function\$/g)||[]).length===1,'EXACTLY_ONE_FUNCTION_TERMINATOR_REQUIRED');
need((exactExecution.match(/CREATE OR REPLACE FUNCTION clued_control\.execution_transition\(p jsonb\)/g)||[]).length===1,'EXACTLY_ONE_EXECUTION_FUNCTION_REQUIRED');
const exactExecutionSha=sha(exactExecution);
const q=s=>`convert_from(decode('${Buffer.from(s,'utf8').toString('base64')}','base64'),'UTF8')`;

const sql=`BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SET LOCAL idle_in_transaction_session_timeout='90s';
CREATE TEMP TABLE _root9_ga6_original_execution ON COMMIT DROP AS SELECT p.oid,pg_get_functiondef(p.oid) def,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') digest,p.proowner,p.proacl::text acl,p.proconfig::text config,p.prosecdef,p.provolatile,p.prokind,p.proparallel,p.proleakproof FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='clued_control' AND p.oid='clued_control.execution_transition(jsonb)'::regprocedure;
DO $pre$ DECLARE c clued_control.execution_current;h clued_control.current_head;a clued_control.gate_attempts;BEGIN
 IF (SELECT count(*) FROM _root9_ga6_original_execution)<>1 OR (SELECT digest FROM _root9_ga6_original_execution) IS DISTINCT FROM '${originalExecutionSha}' OR encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '705915e4c9b930a5d03bfc37fd1b4e690b9f7817f9f6c8dbaeb856742d9067e3' THEN RAISE EXCEPTION 'TRUSTED_FUNCTION_PREIMAGE_DRIFT';END IF;
 SELECT * INTO h FROM clued_control.current_head WHERE root_id='${root}' FOR SHARE; SELECT * INTO c FROM clued_control.execution_current WHERE root_id='${root}' FOR UPDATE; SELECT * INTO a FROM clued_control.gate_attempts WHERE root_id='${root}' AND ga_id='${ga}' FOR UPDATE;
 IF h.sequence<>9 OR h.generation_id<>'${gen}' OR h.revoked OR c.sequence<>110 OR c.active_ga_id<>'${ga}' OR c.pending_budget_sequence IS NOT NULL OR c.charged_seconds<>11106 OR c.charged_evidence_bytes<>2470030259 OR a.phase<>'PENDING' OR a.sequence<>0 OR a.container_id IS NOT NULL OR a.receipt_raw IS NOT NULL OR a.decision IS NOT NULL OR a.revoked OR a.ga_sha256<>'${gaSha}' OR a.budget_sequence<>102 OR a.ga->>'control_trust_root_generation'<>'${gen}' OR a.ga->>'controller_digest'<>'${controller}' OR a.expires_at>CLOCK_TIMESTAMP() OR EXISTS(SELECT 1 FROM clued_control.execution_events e WHERE e.root_id='${root}' AND e.request->>'ga_id'='${ga}') THEN RAISE EXCEPTION 'NOT_EXACT_EXPIRED_NEVER_STARTED_GA6_AT_SEQ110';END IF;
 IF (SELECT count(*) FROM clued_control.gate_attempts WHERE root_id='${root}' AND budget_sequence=102)<>3 OR (SELECT count(*) FROM clued_control.execution_events WHERE root_id='${root}')<>110 OR (SELECT count(*) FROM clued_control.execution_events WHERE root_id='${root}' AND request->>'operation'='BUDGET_RESERVED')<>16 THEN RAISE EXCEPTION 'ROOT9_SERIES_PREIMAGE_DRIFT';END IF;
END $pre$;
${exactExecution.trimEnd()};
DO $close$ DECLARE c clued_control.execution_current;a clued_control.gate_attempts;r jsonb;original_def text;BEGIN
 IF encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '${exactExecutionSha}' OR EXISTS(SELECT 1 FROM _root9_ga6_original_execution o JOIN pg_proc p ON p.oid='clued_control.execution_transition(jsonb)'::regprocedure WHERE p.proowner<>o.proowner OR p.proacl::text IS DISTINCT FROM o.acl OR p.proconfig::text IS DISTINCT FROM o.config OR p.prosecdef<>o.prosecdef OR p.provolatile<>o.provolatile OR p.prokind<>o.prokind OR p.proparallel<>o.proparallel OR p.proleakproof<>o.proleakproof) THEN RAISE EXCEPTION 'EXACT_GA6_HELPER_INSTALL_DRIFT';END IF;
 r:=clued_control.execution_transition(jsonb_build_object('idempotency_key','root9_ga6_single_window_close_decision_111','expected_sequence',110,'ga_id','${ga}','operation','DECISION_RESERVED','body',jsonb_build_object('result','BLOCKED','termination_mode','${termination}','decision_raw',${q(raw.decision)},'decision_sha256','${decisionSha}','evidence_index_raw',${q(raw.index)},'evidence_index_sha256','${indexSha}','not_started_evidence_raw',${q(raw.observation)},'not_started_evidence_ref',jsonb_build_object('uri','${internalObservationUri}','sha256','${observationSha}')))); IF r->>'status'<>'RECORDED' OR (r->>'sequence')::bigint<>111 THEN RAISE EXCEPTION 'DECISION_111_NOT_RECORDED';END IF;
 r:=clued_control.execution_transition(jsonb_build_object('idempotency_key','root9_ga6_single_window_close_signing_112','expected_sequence',111,'ga_id','${ga}','operation','SIGNING','body',jsonb_build_object('decision_sha256','${decisionSha}'))); IF r->>'status'<>'RECORDED' OR (r->>'sequence')::bigint<>112 THEN RAISE EXCEPTION 'SIGNING_112_NOT_RECORDED';END IF;
 r:=clued_control.commit_gate_result(${q(raw.grr)},'${grrSha}','${decisionSha}'); IF r->>'status'<>'COMMITTED' OR r->>'result'<>'BLOCKED' OR r->>'authority_effect'<>'NONE' THEN RAISE EXCEPTION 'GA6_NOT_BLOCKED';END IF;
 SELECT def INTO original_def FROM _root9_ga6_original_execution;EXECUTE original_def;
 IF EXISTS(SELECT 1 FROM _root9_ga6_original_execution o JOIN pg_proc p ON p.oid='clued_control.execution_transition(jsonb)'::regprocedure WHERE encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')<>o.digest OR p.proowner<>o.proowner OR p.proacl::text IS DISTINCT FROM o.acl OR p.proconfig::text IS DISTINCT FROM o.config OR p.prosecdef<>o.prosecdef OR p.provolatile<>o.provolatile OR p.prokind<>o.prokind OR p.proparallel<>o.proparallel OR p.proleakproof<>o.proleakproof) THEN RAISE EXCEPTION 'ORIGINAL_EXECUTION_FUNCTION_NOT_RESTORED';END IF;
 SELECT * INTO c FROM clued_control.execution_current WHERE root_id='${root}';SELECT * INTO a FROM clued_control.gate_attempts WHERE root_id='${root}' AND ga_id='${ga}';
 IF c.sequence<>112 OR c.active_ga_id IS NOT NULL OR c.pending_budget_sequence IS NOT NULL OR c.charged_seconds<>11106 OR c.charged_evidence_bytes<>2470030259 OR a.phase<>'BLOCKED' OR a.sequence<>2 OR a.container_id IS NOT NULL OR a.revoked OR a.receipt_id<>'grr_root9_exact_pair_ga6_blocked_20260915' OR a.receipt_sha256<>'${grrSha}' OR a.decision->>'decision_sha256'<>'${decisionSha}' OR a.decision->>'evidence_index_sha256'<>'${indexSha}' THEN RAISE EXCEPTION 'GA6_CLOSE_POSTIMAGE_DRIFT';END IF;
 IF (SELECT count(*) FROM clued_control.execution_events e WHERE e.root_id='${root}' AND e.request->>'ga_id'='${ga}')<>2 OR NOT EXISTS(SELECT 1 FROM clued_control.execution_events e WHERE e.root_id='${root}' AND e.sequence=111 AND e.request->>'ga_id'='${ga}' AND e.request->>'operation'='DECISION_RESERVED') OR NOT EXISTS(SELECT 1 FROM clued_control.execution_events e WHERE e.root_id='${root}' AND e.sequence=112 AND e.request->>'ga_id'='${ga}' AND e.request->>'operation'='SIGNING') OR (SELECT count(*) FROM clued_control.execution_events WHERE root_id='${root}')<>112 OR (SELECT count(*) FROM clued_control.gate_attempts WHERE root_id='${root}' AND budget_sequence=102)<>3 OR (SELECT count(*) FROM clued_control.execution_events WHERE root_id='${root}' AND request->>'operation'='BUDGET_RESERVED')<>16 THEN RAISE EXCEPTION 'GA6_CLOSE_EVENT_OR_BUDGET_POSTIMAGE_DRIFT';END IF;
END $close$;
SELECT jsonb_build_object('state','PASS_ROOT9_GA6_BLOCKED_SEQ112_NO_SUCCESSOR','root_sequence',(SELECT sequence FROM clued_control.current_head WHERE root_id='${root}'),'execution_sequence',(SELECT sequence FROM clued_control.execution_current WHERE root_id='${root}'),'active_ga_id',(SELECT active_ga_id FROM clued_control.execution_current WHERE root_id='${root}'),'pending_budget_sequence',(SELECT pending_budget_sequence FROM clued_control.execution_current WHERE root_id='${root}'),'charged_seconds',(SELECT charged_seconds FROM clued_control.execution_current WHERE root_id='${root}'),'charged_evidence_bytes',(SELECT charged_evidence_bytes FROM clued_control.execution_current WHERE root_id='${root}'),'ga6_phase',(SELECT phase FROM clued_control.gate_attempts WHERE root_id='${root}' AND ga_id='${ga}'),'seq102_attempts',(SELECT count(*) FROM clued_control.gate_attempts WHERE root_id='${root}' AND budget_sequence=102),'execution_function_sha256',encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex'),'refund',false,'capacity_increase',false,'budget_reassignment',false,'new_allocation',false,'successor',false) result;
__FINAL__;
`;
const rollbackSql=sql.replace('__FINAL__','ROLLBACK'),applySql=sql.replace('__FINAL__','COMMIT');
const build={state:'BUILT_EXACT_GA6_CLOSE_NO_SUCCESSOR',publication_commit:publicationCommit,publication_tree:publicationTree,original_execution_sha256:originalExecutionSha,exact_close_execution_sha256:exactExecutionSha,decision_sha256:decisionSha,index_sha256:indexSha,observation_sha256:observationSha,grr_sha256:grrSha,signature_commit:parsed.signature.commit_sha,expected_sequence_before:110,expected_sequence_after:112,pending_budget_sequence_after:null,authority_effect:'NONE',successor:false};
if(process.argv.includes('--emit-json')){
 console.log(JSON.stringify({build,files:{'execution_transition.ga6-close-once.sql':exactExecution,'close-root9-ga6.preflight-rollback.sql':rollbackSql,'close-root9-ga6.apply-once.sql':applySql,'close-root9-ga6.build.json':JSON.stringify(build,null,2)+'\n'}}));
 process.exit(0);
}
if(!process.argv.includes('--review-only')){
 fs.writeFileSync(path.join(here,'execution_transition.ga6-close-once.sql'),exactExecution,{encoding:'utf8'});
 fs.writeFileSync(path.join(here,'close-root9-ga6.preflight-rollback.sql'),rollbackSql,{encoding:'utf8'});
 fs.writeFileSync(path.join(here,'close-root9-ga6.apply-once.sql'),applySql,{encoding:'utf8'});
 fs.writeFileSync(path.join(here,'close-root9-ga6.build.json'),JSON.stringify(build,null,2)+'\n',{encoding:'utf8'});
}
console.log(JSON.stringify({...build,review_only:process.argv.includes('--review-only'),helper_bytes:Buffer.byteLength(exactExecution),rollback_sql_sha256:sha(rollbackSql),rollback_sql_bytes:Buffer.byteLength(rollbackSql),apply_sql_sha256:sha(applySql),apply_sql_bytes:Buffer.byteLength(applySql)}));
