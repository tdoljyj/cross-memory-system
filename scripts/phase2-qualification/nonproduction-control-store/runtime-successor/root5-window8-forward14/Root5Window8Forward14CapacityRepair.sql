begin;
set local timezone='UTC';
set local lock_timeout='5s';
set local statement_timeout='30s';
lock table clued_control.execution_current,clued_control.execution_events,clued_control.gate_attempts,clued_control.control_objects in access exclusive mode;
do $repair$
declare root constant text := 'ctr_414bd3c724264a83894b0c55cf2ab878'; fn text; old_rows jsonb;
begin
 if (select to_jsonb(c) from clued_control.execution_current c where c.root_id=root) is distinct from '{"root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","sequence":83,"active_ga_id":null,"pending_budget_sequence":null,"charged_seconds":9306,"charged_evidence_bytes":2067377075,"runner_generation":"runnergen_a256855fec9441839105c69b746c5244","credential_generation":"credgen_bac92a11e7144a3fb9e67f40a6a07d11","session_generation":"sessiongen_ffb02a907d334b0da0b37bf457a758c2"}'::jsonb then raise exception 'exact_sequence83_preimage_required'; end if;
 select jsonb_build_object('current',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_current x),'events',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_events x),'attempts',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.gate_attempts x),'objects',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.control_objects x)) into old_rows;
 if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) is distinct from '1f9413d0f70d730ae66ee6afdf21d41a4f47060229b3cc11079a48526c7a47d3' or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure) is distinct from '83d6c5b12041faedf2b61592432230d60c24c4e28d4e591b5a49a3db461ec82e' then raise exception 'exact_window7_function_preimage_required'; end if;
 select pg_get_functiondef('clued_control.reserve_execution_budget(text,text)'::regprocedure) into fn;
 fn:=replace(replace(replace(replace(replace(fn,'series_n>7','series_n>8'),'series_f>13','series_f>14'),'series_n>=7','series_n>=8'),'9306','9906'),'2067377075','2201594803'); execute fn;
 select pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure) into fn;
 fn:=replace(replace(replace(replace(fn,'series_n>7','series_n>8'),'series_f>13','series_f>14'),'9306','9906'),'2067377075','2201594803'); execute fn;
 if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) is distinct from '1b8a9066498c84041fe4b34a2db1670fc8899541595b5ca6066204af0bd7dd19' or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure) is distinct from 'dfba3af239cd60c915db58237aefb4d328b0cbbeac8b37befd2a143a6ef30d61' then raise exception 'exact_window8_function_postimage_required'; end if;
 alter table clued_control.execution_current drop constraint execution_current_charged_seconds_check;
 alter table clued_control.execution_current add constraint execution_current_charged_seconds_check check (charged_seconds>=1410 and charged_seconds<=9906);
 alter table clued_control.execution_current drop constraint execution_current_charged_evidence_bytes_check;
 alter table clued_control.execution_current add constraint execution_current_charged_evidence_bytes_check check (charged_evidence_bytes>=19264968 and charged_evidence_bytes<=2201594803);
 if old_rows is distinct from (select jsonb_build_object('current',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_current x),'events',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_events x),'attempts',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.gate_attempts x),'objects',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.control_objects x))) then raise exception 'window7_capacity_repair_changed_control_rows'; end if;
end $repair$;
commit;
