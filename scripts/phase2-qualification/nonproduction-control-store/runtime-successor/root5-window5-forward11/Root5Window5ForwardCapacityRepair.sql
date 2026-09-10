begin;
set local timezone='UTC';
set local lock_timeout='5s';
set local statement_timeout='30s';
lock table clued_control.execution_current,clued_control.execution_events,clued_control.gate_attempts,clued_control.control_objects in access exclusive mode;

do $repair$
declare
  root constant text := 'ctr_414bd3c724264a83894b0c55cf2ab878';
  fn text;
  old_rows jsonb;
begin
  if (select to_jsonb(c) from clued_control.execution_current c where c.root_id=root)
     is distinct from '{"root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","sequence":71,"active_ga_id":null,"pending_budget_sequence":null,"charged_seconds":7506,"charged_evidence_bytes":1664723891,"runner_generation":"runnergen_a256855fec9441839105c69b746c5244","credential_generation":"credgen_bac92a11e7144a3fb9e67f40a6a07d11","session_generation":"sessiongen_ffb02a907d334b0da0b37bf457a758c2"}'::jsonb
  then raise exception 'exact_bound_sequence71_preimage_required'; end if;
  select jsonb_build_object(
    'current',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_current x),
    'events',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_events x),
    'attempts',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.gate_attempts x),
    'objects',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.control_objects x)
  ) into old_rows;
  if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)
     is distinct from '302f3e0f0bdd75f6f1d21843b0c27e11e59d9d469bdf4fe3bc4e39b2ceb848bd'
  or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure)
     is distinct from 'c1c50e656d6b568da6a54d61444f5c6cdbc8b352ecda7173d47def9e361b3acc'
  then raise exception 'exact_window5_function_preimage_required'; end if;

  select pg_get_functiondef('clued_control.reserve_execution_budget(text,text)'::regprocedure) into fn;
  if (length(fn)-length(replace(fn,'series_f>10','')))/length('series_f>10') <> 1
  then raise exception 'exact_budget_forward_cap_token_required'; end if;
  execute replace(fn,'series_f>10','series_f>11');

  select pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure) into fn;
  if (length(fn)-length(replace(fn,'series_f>10','')))/length('series_f>10') <> 1
  then raise exception 'exact_gate_forward_cap_token_required'; end if;
  execute replace(fn,'series_f>10','series_f>11');

  if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)
     is distinct from '5fdd415c8883f83aedc73c05384b96355c02bc5c6f5c2c0fdc97d8d4bb6e0695'
  or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure)
     is distinct from 'b661e37eb22e8f54f1d28d83fb6dcf1e487bfc9c7cba1e767eae4d467282f1fa'
  then raise exception 'exact_forward11_function_postimage_required'; end if;
  if old_rows is distinct from jsonb_build_object(
    'current',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_current x),
    'events',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_events x),
    'attempts',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.gate_attempts x),
    'objects',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.control_objects x)
  ) then raise exception 'forward_capacity_repair_changed_control_rows'; end if;
end
$repair$;
commit;
