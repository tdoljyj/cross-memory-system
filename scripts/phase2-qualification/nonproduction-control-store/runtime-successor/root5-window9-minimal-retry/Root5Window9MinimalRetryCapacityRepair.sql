begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $repair$
declare
 root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878';
 c clued_control.execution_current;
 old_rows jsonb;
 fn text;
begin
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 if c.sequence<>87 or c.active_ga_id is not null or c.pending_budget_sequence is not null
    or c.charged_seconds<>9906 or c.charged_evidence_bytes<>2201594803 then
  raise exception 'exact_sequence87_terminal_preimage_required';
 end if;
 select jsonb_build_object(
  'current',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_current x),
  'events',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_events x),
  'attempts',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.gate_attempts x),
  'objects',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.control_objects x)
 ) into old_rows;
 if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) is distinct from '1b8a9066498c84041fe4b34a2db1670fc8899541595b5ca6066204af0bd7dd19'
 or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure) is distinct from 'dfba3af239cd60c915db58237aefb4d328b0cbbeac8b37befd2a143a6ef30d61' then
  raise exception 'exact_window8_function_preimage_required';
 end if;
 select pg_get_functiondef('clued_control.reserve_execution_budget(text,text)'::regprocedure) into fn;
 fn:=replace(replace(replace(replace(replace(fn,'series_n>8','series_n>9'),'series_f>14','series_f>15'),'series_n>=8','series_n>=9'),'9906','10506'),'2201594803','2335812531');
 execute fn;
 select pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure) into fn;
 fn:=replace(replace(replace(replace(fn,'series_n>8','series_n>9'),'series_f>14','series_f>15'),'9906','10506'),'2201594803','2335812531');
 execute fn;
 alter table clued_control.execution_current drop constraint execution_current_charged_seconds_check;
 alter table clued_control.execution_current add constraint execution_current_charged_seconds_check check (charged_seconds>=1410 and charged_seconds<=10506);
 alter table clued_control.execution_current drop constraint execution_current_charged_evidence_bytes_check;
 alter table clued_control.execution_current add constraint execution_current_charged_evidence_bytes_check check (charged_evidence_bytes>=19264968 and charged_evidence_bytes<=2335812531);
 if old_rows is distinct from (select jsonb_build_object(
  'current',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_current x),
  'events',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_events x),
  'attempts',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.gate_attempts x),
  'objects',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.control_objects x)
 )) then raise exception 'minimal_retry_capacity_changed_control_rows'; end if;
 if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) is distinct from '431bf26e4ab8ab779271a0a324a489c21b7f2024205266d68ac8452f41b63abc'
 or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure) is distinct from '56eefb41c2798516e9c7c8fbd4ba8d6a20fdb9085db6e87eb8293f0a3e267eb0' then
  raise exception 'minimal_retry_capacity_postimage_required';
 end if;
end $repair$;
commit;
