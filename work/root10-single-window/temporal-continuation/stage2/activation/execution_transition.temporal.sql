CREATE OR REPLACE FUNCTION clued_control.execution_transition(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current;
 a clued_control.gate_attempts; previous clued_control.execution_events; intent_event clued_control.execution_events; temporal_event clued_control.execution_events;
 temporal_deadline timestamptz;
 r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb; field_name text;
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
 select * into temporal_event from clued_control.execution_events e where e.root_id=root and e.sequence=118 and e.request->>'operation'='TEMPORAL_CONTINUATION_ACTIVATED' and e.request->>'ga_id'=a.ga_id;
 if found then
  if a.ga_id<>'ga_32daa5daf52c4deb8e893c25b08eff38' or a.ga_sha256<>'68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' or a.budget_sequence<>117 or not (temporal_event.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and temporal_event.sequence=118 and temporal_event.idempotency_key='root10_same_ga_temporal_continuation_20260915' and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[] and temporal_event.request->>'operation'='TEMPORAL_CONTINUATION_ACTIVATED' and temporal_event.request->>'ga_id'='ga_32daa5daf52c4deb8e893c25b08eff38' and temporal_event.request->>'idempotency_key'='root10_same_ga_temporal_continuation_20260915' and temporal_event.request->'expected_sequence'='117'::jsonb and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body') k)=array['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','effect_deadline','finalization_expires_at','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','prior_ga_sha256']::text[] and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'amendment_ref') k)=array['sha256','uri']::text[] and temporal_event.request->'body'->'amendment_ref'='{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/fc0770fc90b90a1fb3bfa167fd3ee75c0db92604","sha256":"38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6"}'::jsonb and temporal_event.request->'body'->>'amendment_sha256'='38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6' and temporal_event.request->'body'->>'budget_raw_sha256'='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' and temporal_event.request->'body'->'budget_sequence'='117'::jsonb and temporal_event.request->'body'->>'prior_ga_sha256'='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' and temporal_event.request->'body'->'automatic_retry'='false'::jsonb and temporal_event.request->'body'->'new_ga'='false'::jsonb and temporal_event.request->'body'->'new_budget'='false'::jsonb and temporal_event.request->'body'->'budget_refund'='false'::jsonb and temporal_event.request->'body'->>'finalization_expires_at'='2026-09-16T03:00:00Z' and (temporal_event.request->'body'->>'activated_at')::timestamptz<(temporal_event.request->'body'->>'effect_deadline')::timestamptz and (temporal_event.request->'body'->>'effect_deadline')::timestamptz-(temporal_event.request->'body'->>'activated_at')::timestamptz=interval '600 seconds' and (temporal_event.request->'body'->>'effect_deadline')::timestamptz<'2026-09-16T03:00:00Z'::timestamptz and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'old_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and temporal_event.request->'body'->'old_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"d01bd55e02614c0d2b6f51f80fe5b56816aecc2f29e753344a4bcac56aaaf559","prior_evidence_bytes":322546611,"qualification_sha256":"3cd157e704660dac18d3e6c5fb790f6854f29d644c66d53b968bf94c07f12143","runtime_acceptance_sha256":"bc6cb688231763f2ad1a56bbc77a22eb7a35cfd749b12e8827f5040582443a88"}'::jsonb and temporal_event.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((temporal_event.request->'body'->'old_binding')::text,'UTF8')),'hex') and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'new_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and temporal_event.request->'body'->'new_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041","prior_evidence_bytes":322546611,"qualification_sha256":"e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405","runtime_acceptance_sha256":"17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42"}'::jsonb and temporal_event.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((temporal_event.request->'body'->'new_binding')::text,'UTF8')),'hex')) or temporal_event.request->>'idempotency_key'<>'root10_same_ga_temporal_continuation_20260915'
  or temporal_event.request->'body'->>'amendment_sha256'<>'38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6' or temporal_event.request->'body'->'amendment_ref'->>'sha256'<>'38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6'
  or temporal_event.request->'body'->>'budget_raw_sha256'<>'669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' or temporal_event.request->'body'->>'prior_ga_sha256'<>a.ga_sha256
  or temporal_event.request->'body'->'automatic_retry'<>'false'::jsonb or temporal_event.request->'body'->'new_ga'<>'false'::jsonb or temporal_event.request->'body'->'new_budget'<>'false'::jsonb or temporal_event.request->'body'->'budget_refund'<>'false'::jsonb
  or temporal_event.request->'body'->>'finalization_expires_at'<>'2026-09-16T03:00:00Z'
  or (temporal_event.request->'body'->>'effect_deadline')::timestamptz-(temporal_event.request->'body'->>'activated_at')::timestamptz<>interval '600 seconds'
  then raise exception 'invalid_root10_temporal_continuation_event'; end if;
  temporal_deadline:=(temporal_event.request->'body'->>'effect_deadline')::timestamptz;
  if clock_timestamp()>=(temporal_event.request->'body'->>'finalization_expires_at')::timestamptz and op not in ('UNKNOWN','REVOKE','RECONCILED_CONTAINER') then raise exception 'root10_temporal_finalization_expired'; end if;
 end if;
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
  if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or a.revoked or clock_timestamp()>=coalesce(temporal_deadline,a.expires_at)
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
  if a.container_id is null or (temporal_event.sequence=118 and clock_timestamp()>=temporal_deadline) or p->'body'->>'container_id' is distinct from a.container_id then raise exception 'exact_container_missing'; end if;
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
      and p->'body'->>'result'='STALE'
      and not exists(
        select 1 from clued_control.execution_events e
        where e.root_id=root and e.request->>'ga_id'=a.ga_id
      )
    )
  ) or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;
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
  if temporal_event.sequence=118 and (coalesce(evidence_json->>'started_utc','') !~ '^\d{4}-\d\d-\d\dT' or coalesce(evidence_json->>'ended_utc','') !~ '^\d{4}-\d\d-\d\dT' or (evidence_json->>'started_utc')::timestamptz<(temporal_event.request->'body'->>'activated_at')::timestamptz or (evidence_json->>'started_utc')::timestamptz>(evidence_json->>'ended_utc')::timestamptz or (evidence_json->>'ended_utc')::timestamptz>temporal_deadline or (op='STOPPED' and (coalesce(evidence_json->'observation'->'State'->>'FinishedAt','') !~ '^\d{4}-\d\d-\d\dT' or (evidence_json->'observation'->'State'->>'FinishedAt')::timestamptz<(temporal_event.request->'body'->>'activated_at')::timestamptz or (evidence_json->'observation'->'State'->>'FinishedAt')::timestamptz>(evidence_json->>'ended_utc')::timestamptz))) then raise exception 'root10_temporal_effect_timestamp_outside_window'; end if;
 end if;
 -- UNKNOWN never releases the active slot, even after expiry or root revocation.
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values(root,c.sequence+1,p->>'idempotency_key',p);
 update clued_control.execution_current set sequence=c.sequence+1 where root_id=root;
 update clued_control.gate_attempts set phase=next_phase,sequence=sequence+1 where root_id=root and ga_id=a.ga_id;
 return jsonb_build_object('status','RECORDED','phase',next_phase,'sequence',c.sequence+1,
  'prior_committed_intent_readback',case when intent_event.sequence is null then null else to_jsonb(intent_event) end,
  'current_context',clued_control.read_execution()||jsonb_build_object('observed_at',clock_timestamp()),'authority_effect','NONE');
end $function$;
