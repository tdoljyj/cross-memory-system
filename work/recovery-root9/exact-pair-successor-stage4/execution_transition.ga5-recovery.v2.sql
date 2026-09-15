CREATE OR REPLACE FUNCTION clued_control.execution_transition(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current;
 a clued_control.gate_attempts; previous clued_control.execution_events; intent_event clued_control.execution_events;
 r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb; field_name text; reconciliation jsonb;
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
      and (
        p->'body'->>'result'='STALE'
        or (
          a.ga_id='ga_dd2dc30bfc6b93ac2f30b7292dc347cc'
          and a.ga_sha256='bdd9ec691c959d6105b000284939606f4994c6fc69e684598655fc8c4d02dc92'
          and a.budget_sequence=102
          and a.ga->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c'
          and a.ga->>'controller_digest'='9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
          and p->'body'->>'result'='BLOCKED'
          and p->'body'->>'termination_mode'='EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA5'
        )
      )
      and not exists(
        select 1 from clued_control.execution_events e
        where e.root_id=root and e.request->>'ga_id'=a.ga_id
      )
    )
  ) or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;
  if a.phase='PENDING' and p->'body'->>'result'='BLOCKED' then
   if p->'body'->'not_started_evidence_ref'->>'sha256' is distinct from '9ffe53a1b7c4ef216e7e50c85e40be78a8108c8b40624fa1123f98bd7388b9b6'
   or p->'body'->>'decision_sha256' is distinct from 'b948a8252b6e6092079472cf555d4ccfd8ae215a9783ff9ca725286cc3c75d4d'
   or p->'body'->>'evidence_index_sha256' is distinct from 'a85f7bd2d8c525ee3f3e364fe77495bbe31d8c4e50542d25512ba66ca221f919'
   then raise exception 'exact_ga5_signed_evidence_chain_required'; end if;
   if a.ga_id is distinct from 'ga_dd2dc30bfc6b93ac2f30b7292dc347cc'
   or a.ga_sha256 is distinct from 'bdd9ec691c959d6105b000284939606f4994c6fc69e684598655fc8c4d02dc92'
   or a.budget_sequence is distinct from 102
   or a.ga->>'control_trust_root_generation' is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c'
   or a.ga->>'controller_digest' is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
   or c.root_id is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878'
   or c.sequence is distinct from 108
   or c.active_ga_id is distinct from a.ga_id
   or c.pending_budget_sequence is not null
   or jsonb_typeof(p->'body'->'not_started_evidence_raw') is distinct from 'string'
   or not ((p->'body'->>'not_started_evidence_raw') is json object with unique keys)
   or p->'body'->'not_started_evidence_ref'->>'sha256' is distinct from encode(sha256(convert_to(p->'body'->>'not_started_evidence_raw','UTF8')),'hex')
   then raise exception 'exact_root9_not_started_reconciliation_raw_required'; end if;
   reconciliation:=(p->'body'->>'not_started_evidence_raw')::jsonb;
   if reconciliation->>'kind' is distinct from 'EXPIRED_PREDISPATCH_NOT_STARTED_RECONCILIATION_ROOT9'
   or reconciliation->>'ga_id' is distinct from a.ga_id
   or reconciliation->>'ga_sha256' is distinct from a.ga_sha256
   or reconciliation->>'root_id' is distinct from root
   or reconciliation->>'controller_digest' is distinct from a.ga->>'controller_digest'
   or reconciliation->>'docker_nonce' is null
   or reconciliation->'docker_inventory' is distinct from '[]'::jsonb
   or reconciliation->'nonce_directory_present' is distinct from 'false'::jsonb
   or reconciliation->'create_intent_present' is distinct from 'false'::jsonb
   or reconciliation->'start_intent_present' is distinct from 'false'::jsonb
   or reconciliation->'not_started' is distinct from 'true'::jsonb
   or reconciliation->'container_id' is distinct from 'null'::jsonb
   or reconciliation->'stop_action_performed' is distinct from 'false'::jsonb
   or reconciliation->'execution_sequence' is distinct from '108'::jsonb
   or reconciliation->'event_sequences' is distinct from '[]'::jsonb
   or reconciliation->'observed_at' is null
   or p->'body'->'not_started_evidence_ref'->>'uri' is distinct from 'urn:clued:execution-evidence:'||root||':'||(p->'body'->'not_started_evidence_ref'->>'sha256')
   then raise exception 'root9_not_started_reconciliation_subject_or_history_mismatch'; end if;
   if ((p->'body'->>'decision_raw')::jsonb)->'test_results' is distinct from '[]'::jsonb
   or ((p->'body'->>'evidence_index_raw')::jsonb)->'tests' is distinct from '[]'::jsonb
   or ((p->'body'->>'decision_raw')::jsonb)->'not_started_evidence_ref'->>'sha256' is distinct from p->'body'->'not_started_evidence_ref'->>'sha256'
   or (select count(*) from jsonb_array_elements(((p->'body'->>'evidence_index_raw')::jsonb)->'artifacts') x
      where x->>'raw'=p->'body'->>'not_started_evidence_raw'
      and x->>'sha256'=p->'body'->'not_started_evidence_ref'->>'sha256'
      and x->>'uri'=((p->'body'->>'decision_raw')::jsonb)->'not_started_evidence_ref'->>'uri')<>1
   then raise exception 'root9_no_test_execution_and_exact_indexed_reconciliation_required'; end if;
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
end $function$
