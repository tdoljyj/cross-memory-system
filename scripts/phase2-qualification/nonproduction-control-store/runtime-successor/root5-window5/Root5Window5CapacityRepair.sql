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
     is distinct from '{"root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","sequence":70,"active_ga_id":null,"pending_budget_sequence":null,"charged_seconds":7506,"charged_evidence_bytes":1664723891,"runner_generation":"runnergen_a256855fec9441839105c69b746c5244","credential_generation":"credgen_bac92a11e7144a3fb9e67f40a6a07d11","session_generation":"sessiongen_ffb02a907d334b0da0b37bf457a758c2"}'::jsonb
  or (select phase from clued_control.gate_attempts where root_id=root and ga_id='ga_6abb193a56304029a788f7cb624a0d35') is distinct from 'BLOCKED'
  then raise exception 'exact_terminalized_sequence70_preimage_required'; end if;
  select jsonb_build_object(
    'current',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_current x),
    'events',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_events x),
    'attempts',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.gate_attempts x),
    'objects',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.control_objects x)
  ) into old_rows;
  if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)
     is distinct from '0a05aae01612b51f74b619ca9e1885f8a92be8f6f5f38f08543dea520cffc7d1'
  or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure)
     is distinct from '27b474b24da7ed203142d7bbed093d72a7ef8a47a47d3b1e1bdf6ad2b5093c54'
  then raise exception 'exact_v9_function_preimage_required'; end if;

  select pg_get_functiondef('clued_control.reserve_execution_budget(text,text)'::regprocedure) into fn;
  fn:=replace(fn,'series_n>4 or series_f>9','series_n>5 or series_f>10');
  fn:=replace(fn,'c.charged_seconds>7506 or c.charged_evidence_bytes>1664723891','c.charged_seconds>8106 or c.charged_evidence_bytes>1798941619');
  fn:=replace(fn,'if series_n>=4 or series_count<>series_n','if series_n>=5 or series_count<>series_n');
  fn:=replace(fn,'c.charged_seconds+600>7506','c.charged_seconds+600>8106');
  fn:=replace(fn,'c.charged_evidence_bytes+134217728>1664723891','c.charged_evidence_bytes+134217728>1798941619');
  execute fn;

  select pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure) into fn;
  fn:=replace(fn,'series_n>4 or series_f>9','series_n>5 or series_f>10');
  fn:=replace(fn,'c.charged_seconds>7506 or c.charged_evidence_bytes>1664723891','c.charged_seconds>8106 or c.charged_evidence_bytes>1798941619');
  execute fn;

  alter table clued_control.execution_current drop constraint execution_current_charged_seconds_check;
  alter table clued_control.execution_current add constraint execution_current_charged_seconds_check check (charged_seconds>=1410 and charged_seconds<=8106);
  alter table clued_control.execution_current drop constraint execution_current_charged_evidence_bytes_check;
  alter table clued_control.execution_current add constraint execution_current_charged_evidence_bytes_check check (charged_evidence_bytes>=19264968 and charged_evidence_bytes<=1798941619);

  if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)
     is distinct from '302f3e0f0bdd75f6f1d21843b0c27e11e59d9d469bdf4fe3bc4e39b2ceb848bd'
  or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure)
     is distinct from 'c1c50e656d6b568da6a54d61444f5c6cdbc8b352ecda7173d47def9e361b3acc'
  or (select pg_get_constraintdef(oid,true) from pg_constraint where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_seconds_check')
     is distinct from 'CHECK (charged_seconds >= 1410 AND charged_seconds <= 8106)'
  or (select pg_get_constraintdef(oid,true) from pg_constraint where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_evidence_bytes_check')
     is distinct from 'CHECK (charged_evidence_bytes >= 19264968 AND charged_evidence_bytes <= 1798941619)'
  then raise exception 'exact_window5_function_or_constraint_postimage_required'; end if;
  if old_rows is distinct from jsonb_build_object(
    'current',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_current x),
    'events',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.execution_events x),
    'attempts',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.gate_attempts x),
    'objects',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from clued_control.control_objects x)
  ) then raise exception 'capacity_repair_changed_control_rows'; end if;
end
$repair$;
commit;
