create or replace function clued_control.record_effect_intent(p_ga text,p_key text,p_body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n bigint; prior_n bigint; r jsonb; expected_phase text; event_count bigint;
begin
 perform 1 from clued_control.current_head where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for share;
 select sequence into n from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for update;
 select (request->>'expected_sequence')::bigint into prior_n from clued_control.execution_events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and idempotency_key=p_key;
 if found then n:=prior_n; end if;
 r:=clued_control.execution_transition(jsonb_build_object('ga_id',p_ga,'idempotency_key',p_key,
  'expected_sequence',n,'operation','INTENT_RECORDED','body',p_body));

 -- Only this dedicated wrapper's successful response describes the recorded operation.
 -- The database attempt phase and full current_context remain the exact transition result.
 if r->>'status'='RECORDED' then
  expected_phase:=case p_body->>'operation' when 'CREATE' then 'PENDING' when 'START' then 'CREATED' else null end;
  if expected_phase is null or r->>'phase' is distinct from expected_phase then raise exception 'intent_response_attempt_phase_mismatch'; end if;
  select count(*) into event_count from jsonb_array_elements(r->'current_context'->'events') e
   where e->>'idempotency_key'=p_key and e->'sequence'=r->'sequence'
    and e->'request'->>'ga_id'=p_ga and e->'request'->>'operation'='INTENT_RECORDED'
    and e->'request'->'body'=p_body;
  if event_count<>1 then raise exception 'intent_response_exact_event_required'; end if;
  return r||jsonb_build_object('operation','INTENT_RECORDED','attempt_phase',r->'phase','phase','INTENT_RECORDED');
 end if;
 -- Historical duplicate responses are unchanged; consumers must still reject redispatch.
 return r;
end $$;
