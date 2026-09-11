begin;
set local timezone='UTC';
set local lock_timeout='5s';
set local statement_timeout='30s';
lock table clued_control.execution_current in access exclusive mode;

do $repair$
declare
  root constant text := 'ctr_414bd3c724264a83894b0c55cf2ab878';
  before_row jsonb;
begin
  select to_jsonb(c) into before_row from clued_control.execution_current c where c.root_id=root;
  if before_row is distinct from '{"root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","sequence":75,"active_ga_id":null,"pending_budget_sequence":null,"charged_seconds":8106,"charged_evidence_bytes":1798941619,"runner_generation":"runnergen_a256855fec9441839105c69b746c5244","credential_generation":"credgen_bac92a11e7144a3fb9e67f40a6a07d11","session_generation":"sessiongen_ffb02a907d334b0da0b37bf457a758c2"}'::jsonb
  then raise exception 'exact_bound_sequence75_preimage_required'; end if;
  if (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)
     is distinct from '4e83ad5f263d707c958dc289db2e5c191694790580446799c7b28d34b6646d9e'
  or (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure)
     is distinct from '47d1196ff8cea56fabfe87c8d5a83f48282ab20ddecc526bbf269d4bb931a603'
  then raise exception 'exact_window6_functions_required'; end if;
  if (select pg_get_constraintdef(oid,true) from pg_constraint where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_seconds_check')
     is distinct from 'CHECK (charged_seconds >= 1410 AND charged_seconds <= 8106)'
  or (select pg_get_constraintdef(oid,true) from pg_constraint where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_evidence_bytes_check')
     is distinct from 'CHECK (charged_evidence_bytes >= 19264968 AND charged_evidence_bytes <= 1798941619)'
  then raise exception 'exact_window5_constraints_required'; end if;
end
$repair$;

alter table clued_control.execution_current drop constraint execution_current_charged_seconds_check;
alter table clued_control.execution_current add constraint execution_current_charged_seconds_check check (charged_seconds >= 1410 and charged_seconds <= 8706);
alter table clued_control.execution_current drop constraint execution_current_charged_evidence_bytes_check;
alter table clued_control.execution_current add constraint execution_current_charged_evidence_bytes_check check (charged_evidence_bytes >= 19264968 and charged_evidence_bytes <= 1933159347);

do $verify$
begin
  if (select pg_get_constraintdef(oid,true) from pg_constraint where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_seconds_check')
     is distinct from 'CHECK (charged_seconds >= 1410 AND charged_seconds <= 8706)'
  or (select pg_get_constraintdef(oid,true) from pg_constraint where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_evidence_bytes_check')
     is distinct from 'CHECK (charged_evidence_bytes >= 19264968 AND charged_evidence_bytes <= 1933159347)'
  then raise exception 'exact_window6_constraints_required'; end if;
  if (select to_jsonb(c) from clued_control.execution_current c where c.root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
     is distinct from '{"root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","sequence":75,"active_ga_id":null,"pending_budget_sequence":null,"charged_seconds":8106,"charged_evidence_bytes":1798941619,"runner_generation":"runnergen_a256855fec9441839105c69b746c5244","credential_generation":"credgen_bac92a11e7144a3fb9e67f40a6a07d11","session_generation":"sessiongen_ffb02a907d334b0da0b37bf457a758c2"}'::jsonb
  then raise exception 'constraint_repair_changed_current_row'; end if;
end
$verify$;
commit;
