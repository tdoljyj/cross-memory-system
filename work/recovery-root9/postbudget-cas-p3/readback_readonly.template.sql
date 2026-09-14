-- READ ONLY. Seal the three new digest tokens; use after any clear or unknown response.
begin transaction isolation level repeatable read read only;
with k as (
  select 'ctr_414bd3c724264a83894b0c55cf2ab878'::text root,
         '__NEW_CONTROLLER_SHA256__'::text controller,
         '__NEW_QUALIFICATION_SHA256__'::text qualification,
         '__NEW_ACCEPTANCE_SHA256__'::text acceptance,
         '__STATUS27_SHA256__'::text status_sha,
         '__STATUS27_SIGNED_PAYLOAD_SHA256__'::text status_signed_sha,
         '__EVENT103_REQUEST_JSONB_SHA256__'::text event103_request_sha,
         '__EVENT104_REQUEST_JSONB_SHA256__'::text event104_request_sha,
         '__NEW_BINDING_JSONB_SHA256__'::text new_binding_sha,
         '__ROOT_EVENTS_1_9_SHA256__'::text root_prefix_sha,
         '__EXECUTION_EVENTS_1_102_SHA256__'::text execution_prefix_sha,
         '__GATE_ATTEMPTS_SHA256__'::text attempts_sha,
         '__SUCCESSOR_BINDINGS_SHA256__'::text successors_sha,
         '__CONTROL_OBJECTS_THROUGH_26_SHA256__'::text control_objects_prefix_sha,
         '__RESERVE_GATE_POST_PG_GET_FUNCTIONDEF_SHA256__'::text reserve_gate_sha,
         '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'::text budget_sha
), x as (
  select
    (select to_jsonb(h) from clued_control.current_head h,k where h.root_id=k.root) head,
    (select to_jsonb(c) from clued_control.execution_current c,k where c.root_id=k.root) current,
    (select to_jsonb(b) from clued_control.effective_execution_binding() b) binding,
    (select to_jsonb(e) from clued_control.execution_events e,k where e.root_id=k.root and e.sequence=102) budget,
    (select to_jsonb(e) from clued_control.execution_events e,k where e.root_id=k.root and e.sequence=103) correction,
    (select to_jsonb(e) from clued_control.execution_events e,k where e.root_id=k.root and e.sequence=104) repoint,
    (select to_jsonb(o) from clued_control.control_objects o,k where o.root_id=k.root and o.object_type='StatusManifest' and o.generation=27) status27,
    (select count(*) from clued_control.events e,k where e.root_id=k.root) root_events,
    (select count(*) from clued_control.execution_events e,k where e.root_id=k.root) execution_events,
    (select count(*) from clued_control.gate_attempts a,k where a.root_id=k.root) attempts,
    (select count(*) from clued_control.execution_events e,k where e.root_id=k.root and e.sequence>44 and e.request->>'operation'='BUDGET_RESERVED') allocations,
    (select count(*) from clued_control.execution_events e,k where e.root_id=k.root and e.sequence>44 and e.request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') forwards,
    (select count(*) from clued_control.control_objects o,k where o.root_id=k.root and o.object_type='StatusManifest' and o.generation>26) status_after26
    ,(select jsonb_build_object(
        'sha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
        'catalog',to_jsonb(p)-'prosrc',
        'acl_pass',
          not has_function_privilege('public','clued_control.reserve_gate(text,text)','EXECUTE')
          and not has_function_privilege('anon','clued_control.reserve_gate(text,text)','EXECUTE')
          and not has_function_privilege('authenticated','clued_control.reserve_gate(text,text)','EXECUTE')
          and has_function_privilege('service_role','clued_control.reserve_gate(text,text)','EXECUTE'))
      from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure) reserve_gate
), immutable_snapshot as (
  select
    (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) order by e.sequence),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.events e,k where e.root_id=k.root and e.sequence between 1 and 9) root_prefix_sha,
    (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) order by e.sequence),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.execution_events e,k where e.root_id=k.root and e.sequence between 1 and 102) execution_prefix_sha,
    (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(a) order by a.ga_id),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.gate_attempts a,k where a.root_id=k.root) attempts_sha,
    (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) order by s.binding_id),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.successor_binding s,k where s.root_id=k.root) successors_sha,
    (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(o) order by o.object_type,o.generation,o.uri),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.control_objects o,k where o.root_id=k.root and not (o.object_type='StatusManifest' and o.generation>26)) control_objects_prefix_sha
)
select jsonb_build_object(
  'state',case when
    head->'sequence'='9'::jsonb and head->>'generation_id'='ctrgen_308a1dfc185cff633892638581e0a34c'
    and current->'sequence'='104'::jsonb and current->'pending_budget_sequence'='102'::jsonb
    and current->'active_ga_id'='null'::jsonb
    and current->'charged_seconds'='11106'::jsonb
    and current->'charged_evidence_bytes'='2470030259'::jsonb
    and binding->>'controller_sha256'=k.controller
    and binding->>'qualification_sha256'=k.qualification
    and binding->>'runtime_acceptance_sha256'=k.acceptance
    and budget->'request'->'body'->>'sha256'=k.budget_sha
    and correction->'request'->>'operation'='SUCCESSOR_BINDING_QUALIFICATION_CORRECTED'
    and correction->>'idempotency_key'='root9_postbudget_dynamic_signing_repair_v1_qualification'
    and encode(sha256(convert_to((correction->'request')::text,'UTF8')),'hex')=k.event103_request_sha
    and correction->'request'->'body'->'supersedes_execution_sequence'='100'::jsonb
    and repoint->'request'->>'operation'='EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'
    and repoint->>'idempotency_key'='root9_postbudget_dynamic_signing_repair_v1_repoint'
    and encode(sha256(convert_to((repoint->'request')::text,'UTF8')),'hex')=k.event104_request_sha
    and repoint->'request'->'body'->'supersedes_execution_sequence'='101'::jsonb
    and repoint->'request'->'body'->'pending_budget_inheritance'->'budget_sequence'='102'::jsonb
    and repoint->'request'->'body'->'pending_budget_inheritance'->'budget_reservation_ref'->>'sha256'=k.budget_sha
    and status27->>'sha256'=k.status_sha
    and status_after26=1
    and reserve_gate->>'sha256'=k.reserve_gate_sha
    and reserve_gate->'catalog'->'prosecdef'='true'::jsonb
    and reserve_gate->'catalog'->>'provolatile'='v'
    and reserve_gate->'catalog'->>'prokind'='f'
    and reserve_gate->'catalog'->'proconfig'=to_jsonb(array['search_path=""','TimeZone=UTC']::text[])
    and reserve_gate->'acl_pass'='true'::jsonb
    and encode(sha256(convert_to(status27->>'raw','UTF8')),'hex')=k.status_sha
    and (status27->>'raw')::jsonb->'signature_binding'->>'signed_object_sha256'=k.status_signed_sha
    and encode(sha256(convert_to(binding::text,'UTF8')),'hex')=k.new_binding_sha
    and binding=jsonb_build_object(
      'root_id',k.root,
      'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
      'controller_sha256',k.controller,
      'qualification_sha256',k.qualification,
      'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
      'gate_id','G-PREENTRY-SKILL-QUALIFICATION',
      'gate_version','fixed-synthetic-20260910.v10-env-order-repair',
      'gate_sha256','3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
      'runtime_acceptance_sha256',k.acceptance,
      'prior_seconds',1506,'prior_evidence_bytes',322546611)
    and (select s.root_prefix_sha=k.root_prefix_sha
                and s.execution_prefix_sha=k.execution_prefix_sha
                and s.attempts_sha=k.attempts_sha
                and s.successors_sha=k.successors_sha
                and s.control_objects_prefix_sha=k.control_objects_prefix_sha
           from immutable_snapshot s)
    and root_events=9 and execution_events=104 and attempts=14 and allocations=10 and forwards=17
  then 'PASS_EXACT_ROOT9_SEQ104_PENDING102_INHERITED' else 'FAIL_CLOSED' end,
  'observed_at',clock_timestamp(),'head',head,'current',current,'effective_binding',binding,
  'budget102',budget,'event103',correction,'event104',repoint,'status27',status27,
  'immutable_snapshot',(select to_jsonb(s) from immutable_snapshot s),
  'root_events',root_events,'execution_events',execution_events,'attempts',attempts,
  'allocations',allocations,'forwards',forwards,
  'status_after26',status_after26,'reserve_gate',reserve_gate)
from x cross join k;
rollback;
