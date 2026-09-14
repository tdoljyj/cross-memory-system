-- READ ONLY. Run immediately before a sealed CAS submission.
begin transaction isolation level repeatable read read only;
with k as (
  select 'ctr_414bd3c724264a83894b0c55cf2ab878'::text root,
         'ctrgen_308a1dfc185cff633892638581e0a34c'::text root9,
         'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b'::text controller,
         '171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71'::text qualification,
         '107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9'::text acceptance,
         '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'::text budget_sha
), catalog as (
  select jsonb_build_object(
    'append_status_manifest_sha256',encode(sha256(convert_to(pg_get_functiondef('clued_control.append_status_manifest(text,text)'::regprocedure),'UTF8')),'hex'),
    'effective_execution_binding_sha256',encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex'),
    'effective_execution_window_sha256',encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_window()'::regprocedure),'UTF8')),'hex'),
    'read_root_sha256',encode(sha256(convert_to(pg_get_functiondef('clued_control.read_root(text)'::regprocedure),'UTF8')),'hex'),
    'reserve_gate_sha256',encode(sha256(convert_to(pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure),'UTF8')),'hex'),
    'reserve_gate_catalog',(select to_jsonb(p)-'prosrc' from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure),
    'reserve_gate_acl_pass',
      not has_function_privilege('public','clued_control.reserve_gate(text,text)','EXECUTE')
      and not has_function_privilege('anon','clued_control.reserve_gate(text,text)','EXECUTE')
      and not has_function_privilege('authenticated','clued_control.reserve_gate(text,text)','EXECUTE')
      and has_function_privilege('service_role','clued_control.reserve_gate(text,text)','EXECUTE'),
    'target_trigger_defs_sha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(c.relname,t.tgname,pg_get_triggerdef(t.oid,true)) order by c.relname,t.tgname),'[]'::jsonb)::text,'UTF8')),'hex') from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_control' and not t.tgisinternal and c.relname in ('control_objects','execution_events','execution_current')),
    'target_constraints_sha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid,true)) order by c.conrelid::regclass::text,c.conname),'[]'::jsonb)::text,'UTF8')),'hex') from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='clued_control' and c.conrelid in ('clued_control.control_objects'::regclass,'clued_control.execution_events'::regclass,'clued_control.execution_current'::regclass)),
    'dependent_acl_pass',
      not has_function_privilege('public','clued_control.append_status_manifest(text,text)','EXECUTE') and not has_function_privilege('anon','clued_control.append_status_manifest(text,text)','EXECUTE') and not has_function_privilege('authenticated','clued_control.append_status_manifest(text,text)','EXECUTE') and has_function_privilege('service_role','clued_control.append_status_manifest(text,text)','EXECUTE')
      and not has_function_privilege('public','clued_control.effective_execution_binding()','EXECUTE') and not has_function_privilege('anon','clued_control.effective_execution_binding()','EXECUTE') and not has_function_privilege('authenticated','clued_control.effective_execution_binding()','EXECUTE') and has_function_privilege('service_role','clued_control.effective_execution_binding()','EXECUTE')
      and not has_function_privilege('public','clued_control.effective_execution_window()','EXECUTE') and not has_function_privilege('anon','clued_control.effective_execution_window()','EXECUTE') and not has_function_privilege('authenticated','clued_control.effective_execution_window()','EXECUTE') and has_function_privilege('service_role','clued_control.effective_execution_window()','EXECUTE')
      and not has_function_privilege('public','clued_control.read_root(text)','EXECUTE') and not has_function_privilege('anon','clued_control.read_root(text)','EXECUTE') and not has_function_privilege('authenticated','clued_control.read_root(text)','EXECUTE') and has_function_privilege('service_role','clued_control.read_root(text)','EXECUTE')) body
), immutable_snapshot as (
  select jsonb_build_object(
    'root_events_1_9_sha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) order by e.sequence),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.events e,k where e.root_id=k.root and e.sequence between 1 and 9),
    'execution_events_1_102_sha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) order by e.sequence),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.execution_events e,k where e.root_id=k.root and e.sequence between 1 and 102),
    'gate_attempts_sha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(a) order by a.ga_id),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.gate_attempts a,k where a.root_id=k.root),
    'successor_bindings_sha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) order by s.binding_id),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.successor_binding s,k where s.root_id=k.root),
    'control_objects_through_26_sha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(o) order by o.object_type,o.generation,o.uri),'[]'::jsonb)::text,'UTF8')),'hex') from clued_control.control_objects o,k where o.root_id=k.root and not (o.object_type='StatusManifest' and o.generation>26))) body
), x as (
  select
    (select to_jsonb(h) from clued_control.current_head h,k where h.root_id=k.root) head,
    (select to_jsonb(c) from clued_control.execution_current c,k where c.root_id=k.root) current,
    (select to_jsonb(b) from clued_control.effective_execution_binding() b) binding,
    (select to_jsonb(e) from clued_control.execution_events e,k where e.root_id=k.root and e.sequence=102) budget,
    (select e.request->'body'->'evidence'->'required_repair_refs'
       from clued_control.execution_events e,k where e.root_id=k.root and e.sequence=100) repair_refs,
    (select count(*) from clued_control.events e,k where e.root_id=k.root) root_events,
    (select count(*) from clued_control.execution_events e,k where e.root_id=k.root) execution_events,
    (select count(*) from clued_control.gate_attempts a,k where a.root_id=k.root) attempts,
    (select count(*) from clued_control.execution_events e,k where e.root_id=k.root and e.sequence>44 and e.request->>'operation'='BUDGET_RESERVED') allocations,
    (select count(*) from clued_control.execution_events e,k where e.root_id=k.root and e.sequence>44 and e.request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') forwards,
    (select count(*) from clued_control.control_objects o,k where o.root_id=k.root and o.object_type='StatusManifest' and o.generation>26) status_after26
)
select jsonb_build_object(
  'state',case when
    head->'sequence'='9'::jsonb and head->>'generation_id'=k.root9 and head->'revoked'='false'::jsonb
    and current->'sequence'='102'::jsonb and current->'pending_budget_sequence'='102'::jsonb
    and current->'active_ga_id'='null'::jsonb
    and current->'charged_seconds'='11106'::jsonb
    and current->'charged_evidence_bytes'='2470030259'::jsonb
    and binding->>'controller_sha256'=k.controller
    and binding->>'qualification_sha256'=k.qualification
    and binding->>'runtime_acceptance_sha256'=k.acceptance
    and budget->'request'->>'operation'='BUDGET_RESERVED'
    and budget->'request'->'body'->>'sha256'=k.budget_sha
    and encode(sha256(convert_to(budget->'request'->'body'->>'raw','UTF8')),'hex')=k.budget_sha
    and jsonb_typeof(repair_refs)='array' and jsonb_array_length(repair_refs)=8
    and (select body->>'append_status_manifest_sha256' from catalog)='1a75b3b9ecfec1d2fe5c700124544d323506fa16e35a99be7c1dc5c3c1ec6280'
    and (select body->>'effective_execution_binding_sha256' from catalog)='9d8278d9845cffab99624d0ab70d592e2398d8d6a906d608ce5bdd0b14d2e7a1'
    and (select body->>'effective_execution_window_sha256' from catalog)='c1531b643ae7ac19079def01664133b236e35b1ba47c10b5a14c321f7131c09f'
    and (select body->>'reserve_gate_sha256' from catalog)='61e700ffd16dc754061676b5cca3ff76aa1ca2ba4eabf3573caac41b00d23db5'
    and (select body->'reserve_gate_catalog'->'prosecdef' from catalog)='true'::jsonb
    and (select body->'reserve_gate_catalog'->>'provolatile' from catalog)='v'
    and (select body->'reserve_gate_catalog'->>'prokind' from catalog)='f'
    and (select body->'reserve_gate_catalog'->'proconfig' from catalog)=to_jsonb(array['search_path=""','TimeZone=UTC']::text[])
    and (select body->'reserve_gate_acl_pass' from catalog)='true'::jsonb
    and (select body->'dependent_acl_pass' from catalog)='true'::jsonb
    and clock_timestamp()+interval '600 seconds'<'2026-09-15T03:00:00Z'::timestamptz
    and root_events=9 and execution_events=102 and attempts=14
    and allocations=10 and forwards=17 and status_after26=0
    and not exists(select 1 from clued_control.execution_events e where e.root_id=k.root and e.sequence in (103,104))
  then 'PASS_EXACT_ROOT9_SEQ102_PENDING' else 'FAIL_CLOSED' end,
  'observed_at',clock_timestamp(),'head',head,'current',current,'effective_binding',binding,
  'budget102',budget,'catalog_pins',(select body from catalog),
  'required_repair_refs',repair_refs,
  'immutable_snapshot',(select body from immutable_snapshot),
  'root_events',root_events,'execution_events',execution_events,
  'attempts',attempts,'allocations',allocations,'forwards',forwards,'status_after26',status_after26)
from x cross join k;
rollback;
