BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SET LOCAL idle_in_transaction_session_timeout='90s';
CREATE TEMP TABLE _root9_ga6_original_execution ON COMMIT DROP AS SELECT p.oid,pg_get_functiondef(p.oid) def,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') digest,p.proowner,p.proacl::text acl,p.proconfig::text config,p.prosecdef,p.provolatile,p.prokind,p.proparallel,p.proleakproof FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='clued_control' AND p.oid='clued_control.execution_transition(jsonb)'::regprocedure;
DO $pre$ DECLARE c clued_control.execution_current;h clued_control.current_head;a clued_control.gate_attempts;BEGIN
 IF (SELECT count(*) FROM _root9_ga6_original_execution)<>1 OR (SELECT digest FROM _root9_ga6_original_execution) IS DISTINCT FROM '96ee8ccbcfaa97ffce03a3a233968bd9f4db04b61cc333dac6977f39d38cd754' OR encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '705915e4c9b930a5d03bfc37fd1b4e690b9f7817f9f6c8dbaeb856742d9067e3' THEN RAISE EXCEPTION 'TRUSTED_FUNCTION_PREIMAGE_DRIFT';END IF;
 SELECT * INTO h FROM clued_control.current_head WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' FOR SHARE; SELECT * INTO c FROM clued_control.execution_current WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' FOR UPDATE; SELECT * INTO a FROM clued_control.gate_attempts WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND ga_id='ga_6addc4f9764b69ba8c10d258135ae0d4' FOR UPDATE;
 IF h.sequence<>9 OR h.generation_id<>'ctrgen_308a1dfc185cff633892638581e0a34c' OR h.revoked OR c.sequence<>110 OR c.active_ga_id<>'ga_6addc4f9764b69ba8c10d258135ae0d4' OR c.pending_budget_sequence IS NOT NULL OR c.charged_seconds<>11106 OR c.charged_evidence_bytes<>2470030259 OR a.phase<>'PENDING' OR a.sequence<>0 OR a.container_id IS NOT NULL OR a.receipt_raw IS NOT NULL OR a.decision IS NOT NULL OR a.revoked OR a.ga_sha256<>'327bb92ca8a27f8e67eac06daaa27afa5df99814823fe0a2eb69b7c41747641a' OR a.budget_sequence<>102 OR a.ga->>'control_trust_root_generation'<>'ctrgen_308a1dfc185cff633892638581e0a34c' OR a.ga->>'controller_digest'<>'9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1' OR a.expires_at>CLOCK_TIMESTAMP() OR EXISTS(SELECT 1 FROM clued_control.execution_events e WHERE e.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND e.request->>'ga_id'='ga_6addc4f9764b69ba8c10d258135ae0d4') THEN RAISE EXCEPTION 'NOT_EXACT_EXPIRED_NEVER_STARTED_GA6_AT_SEQ110';END IF;
 IF (SELECT count(*) FROM clued_control.gate_attempts WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND budget_sequence=102)<>3 OR (SELECT count(*) FROM clued_control.execution_events WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878')<>110 OR (SELECT count(*) FROM clued_control.execution_events WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND request->>'operation'='BUDGET_RESERVED')<>16 THEN RAISE EXCEPTION 'ROOT9_SERIES_PREIMAGE_DRIFT';END IF;
END $pre$;
CREATE OR REPLACE FUNCTION clued_control.execution_transition(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current;
 a clued_control.gate_attempts; previous clued_control.execution_events; intent_event clued_control.execution_events;
 r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb; field_name text;
 reconciliation jsonb; decision_json jsonb; index_json jsonb;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>131072
 or coalesce(p->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or jsonb_typeof(p->'expected_sequence') is distinct from 'number'
 or coalesce(p->>'expected_sequence','') !~ '^(0|[1-9][0-9]{0,14})$'
 or jsonb_typeof(p->'body') is distinct from 'object' then raise exception 'invalid_transition'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 if not found then raise exception 'execution_binding_missing'; end if;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key=p->>'idempotency_key';
 if found then
  if previous.request is distinct from p then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
 if (p->>'expected_sequence')::bigint<>c.sequence then raise exception 'sequence_conflict'; end if;
 op:=p->>'operation';
 select * into a from clued_control.gate_attempts where root_id=root and ga_id=p->>'ga_id' for update;
 if not found or c.active_ga_id is distinct from a.ga_id then raise exception 'exact_active_attempt_missing'; end if;
 if op='INTENT_RECORDED' then
  if not ((a.phase='PENDING' and p->'body'->>'operation'='CREATE') or (a.phase='CREATED' and p->'body'->>'operation'='START'))
  then raise exception 'intent_phase_conflict'; end if;
  evidence_raw:=p->'body'->>'raw';
  if jsonb_typeof(p->'body'->'raw') is distinct from 'string' or not (evidence_raw is json object with unique keys)
  or p->'body'->>'sha256' is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex') then raise exception 'exact_intent_bytes_required'; end if;
  evidence_json:=evidence_raw::jsonb;
  if evidence_json->>'ga_sha256' is distinct from a.ga_sha256 or evidence_json->>'ga_id' is distinct from a.ga_id
  or evidence_json->>'operation' is distinct from p->'body'->>'operation' then raise exception 'intent_binding_mismatch'; end if;
  if exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id
   and e.request->>'operation'='INTENT_RECORDED' and e.request->'body'->>'operation'=p->'body'->>'operation')
  then raise exception 'one_immutable_intent_per_effect'; end if;
  next_phase:=a.phase;
 elsif op in ('CREATE_SENT','START_SENT') then
  r:=clued_control.read_root(root);
  if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or a.revoked or clock_timestamp()>=a.expires_at
  or a.ga->>'control_trust_root_generation' is distinct from r->>'generation_id'
  or a.ga->>'runner_generation' is distinct from c.runner_generation
  or a.ga->>'credential_generation' is distinct from c.credential_generation
  or a.ga->>'session_generation' is distinct from c.session_generation then raise exception 'current_authority_or_generation_changed'; end if;
  if not ((op='CREATE_SENT' and a.phase='PENDING') or (op='START_SENT' and a.phase='CREATED')) then raise exception 'phase_conflict'; end if;
  if coalesce(p->'body'->>'intent_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'durable_intent_binding_missing'; end if;
  if jsonb_typeof(p->'body'->'intent_sequence') is distinct from 'number'
  or coalesce(p->'body'->>'intent_sequence','') !~ '^[1-9][0-9]{0,14}$' then raise exception 'committed_intent_sequence_required'; end if;
  select * into intent_event from clued_control.execution_events where root_id=root and sequence=(p->'body'->>'intent_sequence')::bigint;
  if not found or intent_event.recording_transaction_id=pg_current_xact_id()
  or intent_event.request->>'operation' is distinct from 'INTENT_RECORDED'
  or intent_event.request->>'ga_id' is distinct from a.ga_id
  or intent_event.request->'body'->>'operation' is distinct from replace(op,'_SENT','')
  or intent_event.request->'body'->>'sha256' is distinct from p->'body'->>'intent_sha256'
  then raise exception 'exact_prior_committed_intent_required'; end if;
  next_phase:=op;
 elsif op='CREATED' then
  if a.phase<>'CREATE_SENT' or coalesce(p->'body'->>'container_id','') !~ '^[0-9a-f]{64}$' then raise exception 'exact_container_missing'; end if;
  update clued_control.gate_attempts set container_id=p->'body'->>'container_id' where root_id=root and ga_id=a.ga_id;
  next_phase:='CREATED';
 elsif op='RECONCILED_CONTAINER' then
  if a.phase<>'UNKNOWN' or a.container_id is not null
  or coalesce(p->'body'->>'container_id','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'observation_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'exact_unknown_reconciliation_required'; end if;
  update clued_control.gate_attempts set container_id=p->'body'->>'container_id' where root_id=root and ga_id=a.ga_id;
  next_phase:='UNKNOWN'; -- Discovery permits cleanup, never a replacement START.
 elsif op='RUNNING' then
  if a.phase<>'START_SENT' or p->'body'->>'container_id' is distinct from a.container_id then raise exception 'phase_or_container_conflict'; end if;next_phase:='RUNNING';
 elsif op='STOP_SENT' then
  if a.container_id is null or p->'body'->>'container_id' is distinct from a.container_id then raise exception 'exact_container_missing'; end if;
  next_phase:='STOP_SENT';
 elsif op='STOPPED' then
  if a.phase<>'STOP_SENT' or p->'body'->>'container_id' is distinct from a.container_id
  or coalesce(p->'body'->>'observation_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'stopped_observation_missing'; end if;
  next_phase:='STOPPED';
 elsif op in ('UNKNOWN','REVOKE') then
  next_phase:='UNKNOWN';
  if op='REVOKE' then update clued_control.gate_attempts set revoked=true where root_id=root and ga_id=a.ga_id;end if;
 elsif op='DECISION_RESERVED' then
  if not (
    a.phase='STOPPED'
    or (
      a.phase='PENDING'
      and clock_timestamp()>=a.expires_at
      and a.container_id is null
      and p->'body'->>'result' in ('STALE','BLOCKED')
      and (p->'body'->>'result'='STALE' or (
       a.ga_id='ga_6addc4f9764b69ba8c10d258135ae0d4' and a.ga_sha256='327bb92ca8a27f8e67eac06daaa27afa5df99814823fe0a2eb69b7c41747641a' and a.budget_sequence=102
       and a.ga->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c' and a.ga->>'controller_digest'='9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
       and p->'body'->>'result'='BLOCKED' and p->'body'->>'termination_mode'='EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA6'))
      and not exists(
        select 1 from clued_control.execution_events e
        where e.root_id=root and e.request->>'ga_id'=a.ga_id
      )
    )
  ) or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;
  if a.phase='PENDING' and p->'body'->>'result'='BLOCKED' then
   if a.ga_id is distinct from 'ga_6addc4f9764b69ba8c10d258135ae0d4' or a.ga_sha256 is distinct from '327bb92ca8a27f8e67eac06daaa27afa5df99814823fe0a2eb69b7c41747641a' or a.budget_sequence is distinct from 102 or a.revoked
   or a.ga->>'control_trust_root_generation' is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c' or a.ga->>'controller_digest' is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
   or c.root_id is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878' or c.sequence is distinct from 110 or c.active_ga_id is distinct from a.ga_id or c.pending_budget_sequence is not null
   or p->'body'->>'termination_mode' is distinct from 'EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA6' or p->'body'->>'decision_sha256' is distinct from 'be4951c1c8177efd8fd9371669ba7988610cc84080c01500d33349f89214f0e4'
   or p->'body'->>'evidence_index_sha256' is distinct from '6f935fa4e5d9c2ca8544653fe01a74f703f36452daa46460b8409373b40c764c' or p->'body'->'not_started_evidence_ref'->>'sha256' is distinct from '1556f55026e8861a059fada73c8d91127a885232856023aea0203aae03337dc6'
   or p->'body'->'not_started_evidence_ref'->>'uri' is distinct from 'urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:1556f55026e8861a059fada73c8d91127a885232856023aea0203aae03337dc6' or jsonb_typeof(p->'body'->'not_started_evidence_raw') is distinct from 'string'
   or not ((p->'body'->>'not_started_evidence_raw') is json object with unique keys) or encode(sha256(convert_to(p->'body'->>'not_started_evidence_raw','UTF8')),'hex') is distinct from '1556f55026e8861a059fada73c8d91127a885232856023aea0203aae03337dc6'
   then raise exception 'exact_ga6_blocked_close_required'; end if;
   reconciliation:=(p->'body'->>'not_started_evidence_raw')::jsonb; decision_json:=(p->'body'->>'decision_raw')::jsonb; index_json:=(p->'body'->>'evidence_index_raw')::jsonb;
   if reconciliation->>'kind' is distinct from 'EXPIRED_PREDISPATCH_NOT_STARTED_RECONCILIATION_ROOT9' or reconciliation->>'root_id' is distinct from root
   or reconciliation->>'ga_id' is distinct from a.ga_id or reconciliation->>'ga_sha256' is distinct from a.ga_sha256 or reconciliation->>'controller_digest' is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
   or reconciliation->>'docker_nonce' is distinct from 'd0658ef39ecb6aa6c8a84ed993f1a823' or reconciliation->'docker_inventory' is distinct from '[]'::jsonb
   or reconciliation->'nonce_directory_present' is distinct from 'false'::jsonb or reconciliation->'create_intent_present' is distinct from 'false'::jsonb
   or reconciliation->'start_intent_present' is distinct from 'false'::jsonb or reconciliation->'not_started' is distinct from 'true'::jsonb
   or reconciliation->'container_id' is distinct from 'null'::jsonb or reconciliation->'stop_action_performed' is distinct from 'false'::jsonb
   or reconciliation->'execution_sequence' is distinct from '110'::jsonb or reconciliation->'event_sequences' is distinct from '[]'::jsonb
   or reconciliation->>'observed_at' is distinct from '2026-09-15T02:09:13.764Z' or reconciliation->>'authority_effect' is distinct from 'NONE'
   then raise exception 'exact_ga6_not_started_observation_required'; end if;
   if decision_json->>'object_type' is distinct from 'Root9PredispatchBlockedDecision' or decision_json->>'ga_id' is distinct from a.ga_id or decision_json->>'ga_sha256' is distinct from a.ga_sha256
   or decision_json->>'result' is distinct from 'BLOCKED' or decision_json->>'termination_mode' is distinct from 'EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA6' or decision_json->'test_results' is distinct from '[]'::jsonb
   or decision_json->>'authority_effect' is distinct from 'NONE' or decision_json->'not_started_evidence_ref'->>'uri' is distinct from 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/d2244bb4ea32c88a3300f9a37f7a92530ff8642a' or decision_json->'not_started_evidence_ref'->>'sha256' is distinct from '1556f55026e8861a059fada73c8d91127a885232856023aea0203aae03337dc6'
   or index_json->>'object_type' is distinct from 'Root9PredispatchBlockedEvidenceIndex' or index_json->>'ga_id' is distinct from a.ga_id or index_json->>'ga_sha256' is distinct from a.ga_sha256
   or index_json->'tests' is distinct from '[]'::jsonb or index_json->>'authority_effect' is distinct from 'NONE' or jsonb_array_length(index_json->'artifacts')<>1
   or (select count(*) from jsonb_array_elements(index_json->'artifacts') x where x->>'uri'='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/d2244bb4ea32c88a3300f9a37f7a92530ff8642a' and x->>'sha256'='1556f55026e8861a059fada73c8d91127a885232856023aea0203aae03337dc6' and x->>'raw'=p->'body'->>'not_started_evidence_raw')<>1
   then raise exception 'exact_ga6_signed_decision_index_required'; end if;
  end if;
  foreach field_name in array array['decision','evidence_index'] loop
   evidence_raw:=p->'body'->>(field_name||'_raw');
   if jsonb_typeof(p->'body'->(field_name||'_raw')) is distinct from 'string'
   or not(evidence_raw is json object with unique keys)
   or p->'body'->>(field_name||'_sha256') is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex')
   then raise exception 'complete_reserved_evidence_bytes_required'; end if;
   evidence_json:=evidence_raw::jsonb;
   if evidence_json->>'ga_id' is distinct from a.ga_id or evidence_json->>'ga_sha256' is distinct from a.ga_sha256
   then raise exception 'reserved_evidence_ga_mismatch'; end if;
   if field_name='decision' and (evidence_json->>'result' is distinct from p->'body'->>'result'
    or coalesce(evidence_json->>'result','') not in ('PASS','FAIL','BLOCKED','STALE'))
   then raise exception 'reserved_decision_result_mismatch'; end if;
  end loop;
  update clued_control.gate_attempts set decision=p->'body' where root_id=root and ga_id=a.ga_id;next_phase:=op;
 elsif op='SIGNING' then
  if a.phase<>'DECISION_RESERVED' or p->'body'->>'decision_sha256' is distinct from a.decision->>'decision_sha256' then raise exception 'signing_reservation_conflict'; end if;next_phase:=op;
 else raise exception 'unsupported_transition'; end if;
 if op in ('CREATED','RUNNING','STOPPED','RECONCILED_CONTAINER') then
  evidence_raw:=p->'body'->>'raw';
  if jsonb_typeof(p->'body'->'raw') is distinct from 'string' or not (evidence_raw is json object with unique keys)
  or p->'body'->>'sha256' is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex') then raise exception 'exact_result_bytes_required'; end if;
  evidence_json:=evidence_raw::jsonb;
  if evidence_json->>'ga_sha256' is distinct from a.ga_sha256 or evidence_json->>'ga_id' is distinct from a.ga_id
  or evidence_json->>'operation' is distinct from op or evidence_json->>'container_id' is distinct from p->'body'->>'container_id'
  or jsonb_typeof(evidence_json->'observation') is distinct from 'object' then raise exception 'result_binding_mismatch'; end if;
 end if;
 -- UNKNOWN never releases the active slot, even after expiry or root revocation.
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values(root,c.sequence+1,p->>'idempotency_key',p);
 update clued_control.execution_current set sequence=c.sequence+1 where root_id=root;
 update clued_control.gate_attempts set phase=next_phase,sequence=sequence+1 where root_id=root and ga_id=a.ga_id;
 return jsonb_build_object('status','RECORDED','phase',next_phase,'sequence',c.sequence+1,
  'prior_committed_intent_readback',case when intent_event.sequence is null then null else to_jsonb(intent_event) end,
  'current_context',clued_control.read_execution()||jsonb_build_object('observed_at',clock_timestamp()),'authority_effect','NONE');
end $function$;
DO $close$ DECLARE c clued_control.execution_current;a clued_control.gate_attempts;r jsonb;original_def text;BEGIN
 IF encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '20ff0a91eeaccab87a2de764e10a9830ee254b4f25bbbae75b51979b18ef2b5a' OR EXISTS(SELECT 1 FROM _root9_ga6_original_execution o JOIN pg_proc p ON p.oid='clued_control.execution_transition(jsonb)'::regprocedure WHERE p.proowner<>o.proowner OR p.proacl::text IS DISTINCT FROM o.acl OR p.proconfig::text IS DISTINCT FROM o.config OR p.prosecdef<>o.prosecdef OR p.provolatile<>o.provolatile OR p.prokind<>o.prokind OR p.proparallel<>o.proparallel OR p.proleakproof<>o.proleakproof) THEN RAISE EXCEPTION 'EXACT_GA6_HELPER_INSTALL_DRIFT';END IF;
 r:=clued_control.execution_transition(jsonb_build_object('idempotency_key','root9_ga6_single_window_close_decision_111','expected_sequence',110,'ga_id','ga_6addc4f9764b69ba8c10d258135ae0d4','operation','DECISION_RESERVED','body',jsonb_build_object('result','BLOCKED','termination_mode','EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA6','decision_raw',convert_from(decode('eyJvYmplY3RfdHlwZSI6IlJvb3Q5UHJlZGlzcGF0Y2hCbG9ja2VkRGVjaXNpb24iLCJzY2hlbWFfdmVyc2lvbiI6IjEuMCIsImdhX2lkIjoiZ2FfNmFkZGM0Zjk3NjRiNjliYThjMTBkMjU4MTM1YWUwZDQiLCJnYV9zaGEyNTYiOiIzMjdiYjkyY2E4YTI3ZjhlNjdlYWMwNmRhYWEyN2FmYTVkZjk5ODE0ODIzZmUwYTJlYjY5YjdjNDE3NDc2NDFhIiwicmVzdWx0IjoiQkxPQ0tFRCIsInRlcm1pbmF0aW9uX21vZGUiOiJFWFBJUkVEX1BSRURJU1BBVENIX05PVF9TVEFSVEVEX0JMT0NLRURfUk9PVDlfU1VDQ0VTU09SX0dBNiIsIm5vdF9zdGFydGVkX2V2aWRlbmNlX3JlZiI6eyJ1cmkiOiJodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zL3Rkb2xqeWovY3Jvc3MtbWVtb3J5LXN5c3RlbS9naXQvYmxvYnMvZDIyNDRiYjRlYTMyYzg4YTMzMDBmOWEzN2Y3YTkyNTMwZmY4NjQyYSIsInNoYTI1NiI6IjE1NTZmNTUwMjZlODg2MWEwNTlmYWRhNzNjOGQ5MTEyN2E4ODUyMzI4NTYwMjNhZWEwMjAzYWFlMDMzMzdkYzYifSwidGVzdF9yZXN1bHRzIjpbXSwiYXV0aG9yaXR5X2VmZmVjdCI6Ik5PTkUifQo=','base64'),'UTF8'),'decision_sha256','be4951c1c8177efd8fd9371669ba7988610cc84080c01500d33349f89214f0e4','evidence_index_raw',convert_from(decode('eyJvYmplY3RfdHlwZSI6IlJvb3Q5UHJlZGlzcGF0Y2hCbG9ja2VkRXZpZGVuY2VJbmRleCIsInNjaGVtYV92ZXJzaW9uIjoiMS4wIiwiZ2FfaWQiOiJnYV82YWRkYzRmOTc2NGI2OWJhOGMxMGQyNTgxMzVhZTBkNCIsImdhX3NoYTI1NiI6IjMyN2JiOTJjYThhMjdmOGU2N2VhYzA2ZGFhYTI3YWZhNWRmOTk4MTQ4MjNmZTBhMmViNjliN2M0MTc0NzY0MWEiLCJ0ZXN0cyI6W10sImFydGlmYWN0cyI6W3sidXJpIjoiaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy90ZG9sanlqL2Nyb3NzLW1lbW9yeS1zeXN0ZW0vZ2l0L2Jsb2JzL2QyMjQ0YmI0ZWEzMmM4OGEzMzAwZjlhMzdmN2E5MjUzMGZmODY0MmEiLCJzaGEyNTYiOiIxNTU2ZjU1MDI2ZTg4NjFhMDU5ZmFkYTczYzhkOTExMjdhODg1MjMyODU2MDIzYWVhMDIwM2FhZTAzMzM3ZGM2IiwicmF3Ijoie1xuICBcImtpbmRcIjogXCJFWFBJUkVEX1BSRURJU1BBVENIX05PVF9TVEFSVEVEX1JFQ09OQ0lMSUFUSU9OX1JPT1Q5XCIsXG4gIFwicm9vdF9pZFwiOiBcImN0cl80MTRiZDNjNzI0MjY0YTgzODk0YjBjNTVjZjJhYjg3OFwiLFxuICBcImdhX2lkXCI6IFwiZ2FfNmFkZGM0Zjk3NjRiNjliYThjMTBkMjU4MTM1YWUwZDRcIixcbiAgXCJnYV9zaGEyNTZcIjogXCIzMjdiYjkyY2E4YTI3ZjhlNjdlYWMwNmRhYWEyN2FmYTVkZjk5ODE0ODIzZmUwYTJlYjY5YjdjNDE3NDc2NDFhXCIsXG4gIFwiY29udHJvbGxlcl9kaWdlc3RcIjogXCI5MzczZTNkOTg0MzA1NWU5YmFiYzE1NjRmNGFhY2ViMDk2Njg4NmY4NTRmYzBlMTA3MjgxZDRjZTYxOGIzY2UxXCIsXG4gIFwiZG9ja2VyX25vbmNlXCI6IFwiZDA2NThlZjM5ZWNiNmFhNmM4YTg0ZWQ5OTNmMWE4MjNcIixcbiAgXCJkb2NrZXJfaW52ZW50b3J5XCI6IFtdLFxuICBcIm5vbmNlX2RpcmVjdG9yeV9wcmVzZW50XCI6IGZhbHNlLFxuICBcImNyZWF0ZV9pbnRlbnRfcHJlc2VudFwiOiBmYWxzZSxcbiAgXCJzdGFydF9pbnRlbnRfcHJlc2VudFwiOiBmYWxzZSxcbiAgXCJub3Rfc3RhcnRlZFwiOiB0cnVlLFxuICBcImNvbnRhaW5lcl9pZFwiOiBudWxsLFxuICBcInN0b3BfYWN0aW9uX3BlcmZvcm1lZFwiOiBmYWxzZSxcbiAgXCJleGVjdXRpb25fc2VxdWVuY2VcIjogMTEwLFxuICBcImV2ZW50X3NlcXVlbmNlc1wiOiBbXSxcbiAgXCJvYnNlcnZlZF9hdFwiOiBcIjIwMjYtMDktMTVUMDI6MDk6MTMuNzY0WlwiLFxuICBcIm9ic2VydmVyXCI6IFwiQ29kZXhAREVTSy1XLTU5MSB2aWEgY2x1ZWQtcm9vdDktbGl2ZWhvc3RcIixcbiAgXCJhdXRob3JpdHlfZWZmZWN0XCI6IFwiTk9ORVwiXG59XG4ifV0sImF1dGhvcml0eV9lZmZlY3QiOiJOT05FIn0K','base64'),'UTF8'),'evidence_index_sha256','6f935fa4e5d9c2ca8544653fe01a74f703f36452daa46460b8409373b40c764c','not_started_evidence_raw',convert_from(decode('ewogICJraW5kIjogIkVYUElSRURfUFJFRElTUEFUQ0hfTk9UX1NUQVJURURfUkVDT05DSUxJQVRJT05fUk9PVDkiLAogICJyb290X2lkIjogImN0cl80MTRiZDNjNzI0MjY0YTgzODk0YjBjNTVjZjJhYjg3OCIsCiAgImdhX2lkIjogImdhXzZhZGRjNGY5NzY0YjY5YmE4YzEwZDI1ODEzNWFlMGQ0IiwKICAiZ2Ffc2hhMjU2IjogIjMyN2JiOTJjYThhMjdmOGU2N2VhYzA2ZGFhYTI3YWZhNWRmOTk4MTQ4MjNmZTBhMmViNjliN2M0MTc0NzY0MWEiLAogICJjb250cm9sbGVyX2RpZ2VzdCI6ICI5MzczZTNkOTg0MzA1NWU5YmFiYzE1NjRmNGFhY2ViMDk2Njg4NmY4NTRmYzBlMTA3MjgxZDRjZTYxOGIzY2UxIiwKICAiZG9ja2VyX25vbmNlIjogImQwNjU4ZWYzOWVjYjZhYTZjOGE4NGVkOTkzZjFhODIzIiwKICAiZG9ja2VyX2ludmVudG9yeSI6IFtdLAogICJub25jZV9kaXJlY3RvcnlfcHJlc2VudCI6IGZhbHNlLAogICJjcmVhdGVfaW50ZW50X3ByZXNlbnQiOiBmYWxzZSwKICAic3RhcnRfaW50ZW50X3ByZXNlbnQiOiBmYWxzZSwKICAibm90X3N0YXJ0ZWQiOiB0cnVlLAogICJjb250YWluZXJfaWQiOiBudWxsLAogICJzdG9wX2FjdGlvbl9wZXJmb3JtZWQiOiBmYWxzZSwKICAiZXhlY3V0aW9uX3NlcXVlbmNlIjogMTEwLAogICJldmVudF9zZXF1ZW5jZXMiOiBbXSwKICAib2JzZXJ2ZWRfYXQiOiAiMjAyNi0wOS0xNVQwMjowOToxMy43NjRaIiwKICAib2JzZXJ2ZXIiOiAiQ29kZXhAREVTSy1XLTU5MSB2aWEgY2x1ZWQtcm9vdDktbGl2ZWhvc3QiLAogICJhdXRob3JpdHlfZWZmZWN0IjogIk5PTkUiCn0K','base64'),'UTF8'),'not_started_evidence_ref',jsonb_build_object('uri','urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:1556f55026e8861a059fada73c8d91127a885232856023aea0203aae03337dc6','sha256','1556f55026e8861a059fada73c8d91127a885232856023aea0203aae03337dc6')))); IF r->>'status'<>'RECORDED' OR (r->>'sequence')::bigint<>111 THEN RAISE EXCEPTION 'DECISION_111_NOT_RECORDED';END IF;
 r:=clued_control.execution_transition(jsonb_build_object('idempotency_key','root9_ga6_single_window_close_signing_112','expected_sequence',111,'ga_id','ga_6addc4f9764b69ba8c10d258135ae0d4','operation','SIGNING','body',jsonb_build_object('decision_sha256','be4951c1c8177efd8fd9371669ba7988610cc84080c01500d33349f89214f0e4'))); IF r->>'status'<>'RECORDED' OR (r->>'sequence')::bigint<>112 THEN RAISE EXCEPTION 'SIGNING_112_NOT_RECORDED';END IF;
 r:=clued_control.commit_gate_result(convert_from(decode('eyJvYmplY3RfdHlwZSI6IkdhdGVSZXN1bHRSZWNlaXB0Iiwic2NoZW1hX3ZlcnNpb24iOiIxLjAiLCJzY2hlbWFfZGlnZXN0IjoiMjkyZGE4N2QwNWIxYmIwMDMzN2EyMDQ1ZTNkMjZmNmRmMGJlNzBhYWY1MjBhYTUxOTU3MmZhM2RlYzM5NTI1MiIsImF1ZGllbmNlIjoidXJuOmNsdWVkOmF1ZGllbmNlOnNraWxsLWNvZXhpc3RlbmNlLXF1YWxpZmljYXRpb246dXNjcmRpZnpubWx2Y3pjZWtxcHciLCJjb250cm9sX3RydXN0X3Jvb3RfZ2VuZXJhdGlvbiI6ImN0cmdlbl8zMDhhMWRmYzE4NWNmZjYzMzg5MjYzODU4MWUwYTM0YyIsImlzc3Vlcl9yZWYiOnsidXJpIjoiaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy90ZG9sanlqL2Nyb3NzLW1lbW9yeS1zeXN0ZW0vZ2l0L2Jsb2JzLzQ5OTYwODk5MDhiMWYyYzBiYWQzNjIzNGM1NDI3MWQzNTAwNjJmNTUiLCJzaGEyNTYiOiJmZmFmYzllYjYzYTIxNDgxNzZkY2EwZTY2ZDVhMjJiZjA3ZWU5ZjBhNTQ2MmM5NjZkNDJhNzlkMjQ3ZjAwODhjIn0sImdhdGVfcmVzdWx0X3JlY2VpcHRfaWQiOiJncnJfcm9vdDlfZXhhY3RfcGFpcl9nYTZfYmxvY2tlZF8yMDI2MDkxNSIsImdhdGVfYXV0aG9yaXphdGlvbl9pZCI6ImdhXzZhZGRjNGY5NzY0YjY5YmE4YzEwZDI1ODEzNWFlMGQ0IiwiZ2F0ZV9hdXRob3JpemF0aW9uX3NoYTI1NiI6IjMyN2JiOTJjYThhMjdmOGU2N2VhYzA2ZGFhYTI3YWZhNWRmOTk4MTQ4MjNmZTBhMmViNjliN2M0MTc0NzY0MWEiLCJnYXRlX2RlZmluaXRpb25fcmVmIjp7ImdhdGVfaWQiOiJHLVBSRUVOVFJZLVNLSUxMLVFVQUxJRklDQVRJT04iLCJkZWZpbml0aW9uX3ZlcnNpb24iOiJmaXhlZC1zeW50aGV0aWMtMjAyNjA5MTAudjEwLWVudi1vcmRlci1yZXBhaXIiLCJjb250ZW50X2RpZ2VzdCI6IjM0ODdkOWZjNmNjZWU1NDc4NTY5MDIxOTYxZWFjOTNiZjVlZjZiZDRiYzI0Mjg1NTliMjBhNDRhYmI5YzE1NWEifSwiaXNzdWVyX3B1cnBvc2UiOiJHQVRFX1JFU1VMVCIsInJlc3VsdCI6IkJMT0NLRUQiLCJkZWNpc2lvbl9zaGEyNTYiOiJiZTQ5NTFjMWM4MTc3ZWZkOGZkOTM3MTY2OWJhNzk4ODYxMGNjODQwODBjMDE1MDBkMzMzNDlmODkyMTRmMGU0IiwidGVzdF9yZXZpc2lvbiI6ImZpeGVkLXN5bnRoZXRpYy0yMDI2MDkxMC52MTAtZW52LW9yZGVyLXJlcGFpciIsImZpeHR1cmVfcmVmcyI6W3sidXJpIjoiaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy90ZG9sanlqL2Nyb3NzLW1lbW9yeS1zeXN0ZW0vZ2l0L2Jsb2JzL2IzNTc1YjVlNzAwODRlMTY2MjJiOTk5Yzg4ZTBiYjVjMjMwODMwMTgiLCJzaGEyNTYiOiI5OGM0ZDAxNjUxNDRhNGViZmJkNDg4OWE5OGRhNjVhOGM2ZDNhNzFmYmYwODJhZjM5M2MxNWI5ZDAwYTNjMThhIn1dLCJleGVjdXRvcl9yZWYiOnsidXJpIjoiaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy90ZG9sanlqL2Nyb3NzLW1lbW9yeS1zeXN0ZW0vZ2l0L2Jsb2JzLzk4N2YzOWEwNDgzNGZhNzI1Mzg5MGY0MTczN2FlZTAyZmQ4ZjIxYzgiLCJzaGEyNTYiOiI5MzczZTNkOTg0MzA1NWU5YmFiYzE1NjRmNGFhY2ViMDk2Njg4NmY4NTRmYzBlMTA3MjgxZDRjZTYxOGIzY2UxIn0sInBlcmZvcm1hbmNlX3Nsb19yZXZpc2lvbiI6Ik5PVF9BUFBMSUNBQkxFX1BSRURJU1BBVENIX05PVF9TVEFSVEVEIiwidGVzdF9yZXN1bHRzIjpbXSwiaW5wdXRfYXJ0aWZhY3RfZGlnZXN0cyI6WyIzMjdiYjkyY2E4YTI3ZjhlNjdlYWMwNmRhYWEyN2FmYTVkZjk5ODE0ODIzZmUwYTJlYjY5YjdjNDE3NDc2NDFhIiwiMTU1NmY1NTAyNmU4ODYxYTA1OWZhZGE3M2M4ZDkxMTI3YTg4NTIzMjg1NjAyM2FlYTAyMDNhYWUwMzMzN2RjNiIsImJlNDk1MWMxYzgxNzdlZmQ4ZmQ5MzcxNjY5YmE3OTg4NjEwY2M4NDA4MGMwMTUwMGQzMzM0OWY4OTIxNGYwZTQiLCI2ZjkzNWZhNGU1ZDljMmNhODU0NDY1M2ZlMDFhNzRmNzAzZjM2NDUyZGFhNDY0NjBiODQwOTM3M2I0MGM3NjRjIl0sImV2aWRlbmNlX2luZGV4X3JlZiI6eyJ1cmkiOiJ1cm46Y2x1ZWQ6ZXhlY3V0aW9uLWV2aWRlbmNlOmN0cl80MTRiZDNjNzI0MjY0YTgzODk0YjBjNTVjZjJhYjg3ODo2ZjkzNWZhNGU1ZDljMmNhODU0NDY1M2ZlMDFhNzRmNzAzZjM2NDUyZGFhNDY0NjBiODQwOTM3M2I0MGM3NjRjIiwic2hhMjU2IjoiNmY5MzVmYTRlNWQ5YzJjYTg1NDQ2NTNmZTAxYTc0ZjcwM2YzNjQ1MmRhYTQ2NDYwYjg0MDkzNzNiNDBjNzY0YyJ9LCJyYXdfZXZpZGVuY2VfcmVmcyI6W3sidXJpIjoiaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy90ZG9sanlqL2Nyb3NzLW1lbW9yeS1zeXN0ZW0vZ2l0L2Jsb2JzL2QyMjQ0YmI0ZWEzMmM4OGEzMzAwZjlhMzdmN2E5MjUzMGZmODY0MmEiLCJzaGEyNTYiOiIxNTU2ZjU1MDI2ZTg4NjFhMDU5ZmFkYTczYzhkOTExMjdhODg1MjMyODU2MDIzYWVhMDIwM2FhZTAzMzM3ZGM2In1dLCJhY3R1YWxfd3JpdGVfc2V0IjpbXSwic3RhcnRlZF9hdCI6IjIwMjYtMDktMTVUMDA6MzE6MDQuODc2WiIsImVuZGVkX2F0IjoiMjAyNi0wOS0xNVQwMjowOToxMy43NjRaIiwiaXNzdWVkX2F0IjoiMjAyNi0wOS0xNVQwMjowOToxMy43NjRaIiwiZXhwaXJlc19hdCI6IjIwMjYtMDktMTVUMDM6MDA6MDAuMDAwWiIsImV4ZWN1dG9yX2FjdG9yX3JlZiI6eyJ1cmkiOiJodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zL3Rkb2xqeWovY3Jvc3MtbWVtb3J5LXN5c3RlbS9naXQvYmxvYnMvNWUwN2JiYzU0YjMzNGJmMTk1ZmUzNmFhZGI4Y2I0OTdkMWYxMTY5OSIsInNoYTI1NiI6IjI3NmRmNzg2ZmQ3ZTVlOWFmOTcyNGZkY2VhNmYwM2JiODY2MWEwMDVhZWZmZWI0MGEwZDY5MDViYThiNGM4MDcifSwiaW5kZXBlbmRlbnRfcmV2aWV3ZXJfcmVmIjp7InVyaSI6Imh0dHBzOi8vYXBpLmdpdGh1Yi5jb20vcmVwb3MvdGRvbGp5ai9jcm9zcy1tZW1vcnktc3lzdGVtL2dpdC9ibG9icy8xYjBmMGMyMWNiYThjOGI3ZTg4N2U3MzlmNTAyY2U3NDEwNzI3YzViIiwic2hhMjU2IjoiOWNhNDUxMzZmODY0YmVlZTA0ZjkwNzRhNzUyMDcwZTk1ZmY0NWY4MjdlN2I3YTM0ODlkZjRkMGNkYzZlYzk5ZCJ9LCJzdG9wX2V2aWRlbmNlX3JlZiI6eyJ1cmkiOiJodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zL3Rkb2xqeWovY3Jvc3MtbWVtb3J5LXN5c3RlbS9naXQvYmxvYnMvZDIyNDRiYjRlYTMyYzg4YTMzMDBmOWEzN2Y3YTkyNTMwZmY4NjQyYSIsInNoYTI1NiI6IjE1NTZmNTUwMjZlODg2MWEwNTlmYWRhNzNjOGQ5MTEyN2E4ODUyMzI4NTYwMjNhZWEwMjAzYWFlMDMzMzdkYzYifSwic2lnbmF0dXJlIjoidXJuOmNsdWVkOmdhdGUtcmVzdWx0LXJlY2VpcHQ6dXNjcmRpZnpubWx2Y3pjZWtxcHc6Z3JyX3Jvb3Q5X2V4YWN0X3BhaXJfZ2E2X2Jsb2NrZWRfMjAyNjA5MTUjc2lnbmF0dXJlIn0K','base64'),'UTF8'),'3d6fc55e6d2065fb40974161f3c0abb556817989c560e3072a080bea033ccfdd','be4951c1c8177efd8fd9371669ba7988610cc84080c01500d33349f89214f0e4'); IF r->>'status'<>'COMMITTED' OR r->>'result'<>'BLOCKED' OR r->>'authority_effect'<>'NONE' THEN RAISE EXCEPTION 'GA6_NOT_BLOCKED';END IF;
 SELECT def INTO original_def FROM _root9_ga6_original_execution;EXECUTE original_def;
 IF EXISTS(SELECT 1 FROM _root9_ga6_original_execution o JOIN pg_proc p ON p.oid='clued_control.execution_transition(jsonb)'::regprocedure WHERE encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')<>o.digest OR p.proowner<>o.proowner OR p.proacl::text IS DISTINCT FROM o.acl OR p.proconfig::text IS DISTINCT FROM o.config OR p.prosecdef<>o.prosecdef OR p.provolatile<>o.provolatile OR p.prokind<>o.prokind OR p.proparallel<>o.proparallel OR p.proleakproof<>o.proleakproof) THEN RAISE EXCEPTION 'ORIGINAL_EXECUTION_FUNCTION_NOT_RESTORED';END IF;
 SELECT * INTO c FROM clued_control.execution_current WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878';SELECT * INTO a FROM clued_control.gate_attempts WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND ga_id='ga_6addc4f9764b69ba8c10d258135ae0d4';
 IF c.sequence<>112 OR c.active_ga_id IS NOT NULL OR c.pending_budget_sequence IS NOT NULL OR c.charged_seconds<>11106 OR c.charged_evidence_bytes<>2470030259 OR a.phase<>'BLOCKED' OR a.sequence<>2 OR a.container_id IS NOT NULL OR a.revoked OR a.receipt_id<>'grr_root9_exact_pair_ga6_blocked_20260915' OR a.receipt_sha256<>'3d6fc55e6d2065fb40974161f3c0abb556817989c560e3072a080bea033ccfdd' OR a.decision->>'decision_sha256'<>'be4951c1c8177efd8fd9371669ba7988610cc84080c01500d33349f89214f0e4' OR a.decision->>'evidence_index_sha256'<>'6f935fa4e5d9c2ca8544653fe01a74f703f36452daa46460b8409373b40c764c' THEN RAISE EXCEPTION 'GA6_CLOSE_POSTIMAGE_DRIFT';END IF;
 IF (SELECT count(*) FROM clued_control.execution_events e WHERE e.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND e.request->>'ga_id'='ga_6addc4f9764b69ba8c10d258135ae0d4')<>2 OR NOT EXISTS(SELECT 1 FROM clued_control.execution_events e WHERE e.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND e.sequence=111 AND e.request->>'ga_id'='ga_6addc4f9764b69ba8c10d258135ae0d4' AND e.request->>'operation'='DECISION_RESERVED') OR NOT EXISTS(SELECT 1 FROM clued_control.execution_events e WHERE e.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND e.sequence=112 AND e.request->>'ga_id'='ga_6addc4f9764b69ba8c10d258135ae0d4' AND e.request->>'operation'='SIGNING') OR (SELECT count(*) FROM clued_control.execution_events WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878')<>112 OR (SELECT count(*) FROM clued_control.gate_attempts WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND budget_sequence=102)<>3 OR (SELECT count(*) FROM clued_control.execution_events WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND request->>'operation'='BUDGET_RESERVED')<>16 THEN RAISE EXCEPTION 'GA6_CLOSE_EVENT_OR_BUDGET_POSTIMAGE_DRIFT';END IF;
END $close$;
SELECT jsonb_build_object('state','PASS_ROOT9_GA6_BLOCKED_SEQ112_NO_SUCCESSOR','root_sequence',(SELECT sequence FROM clued_control.current_head WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878'),'execution_sequence',(SELECT sequence FROM clued_control.execution_current WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878'),'active_ga_id',(SELECT active_ga_id FROM clued_control.execution_current WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878'),'pending_budget_sequence',(SELECT pending_budget_sequence FROM clued_control.execution_current WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878'),'charged_seconds',(SELECT charged_seconds FROM clued_control.execution_current WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878'),'charged_evidence_bytes',(SELECT charged_evidence_bytes FROM clued_control.execution_current WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878'),'ga6_phase',(SELECT phase FROM clued_control.gate_attempts WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND ga_id='ga_6addc4f9764b69ba8c10d258135ae0d4'),'seq102_attempts',(SELECT count(*) FROM clued_control.gate_attempts WHERE root_id='ctr_414bd3c724264a83894b0c55cf2ab878' AND budget_sequence=102),'execution_function_sha256',encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex'),'refund',false,'capacity_increase',false,'budget_reassignment',false,'new_allocation',false,'successor',false) result;
COMMIT;
