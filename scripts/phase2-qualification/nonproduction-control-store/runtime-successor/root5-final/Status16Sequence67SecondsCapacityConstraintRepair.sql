begin;
set local timezone='UTC';
set local lock_timeout='5s';
set local statement_timeout='30s';
lock table clued_control.execution_current in access exclusive mode;

do $status16_seconds_preimage$
declare
  c clued_control.execution_current%rowtype;
  seconds_constraint text;
  bytes_constraint text;
begin
  if current_database() is distinct from 'postgres'
     or (select project_ref from clued_control.accepted_binding where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') is distinct from 'uscrdifznmlvczcekqpw'
  then raise exception 'STATUS16_SECONDS_EXACT_DATABASE_REQUIRED'; end if;

  select * into strict c from clued_control.execution_current
  where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for update;
  select pg_get_constraintdef(oid,true) into strict seconds_constraint from pg_constraint
  where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_seconds_check';
  select pg_get_constraintdef(oid,true) into strict bytes_constraint from pg_constraint
  where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_evidence_bytes_check';

  if c.sequence is distinct from 67
     or c.charged_seconds is distinct from 6906
     or c.charged_evidence_bytes is distinct from 1530506163
     or c.active_ga_id is not null or c.pending_budget_sequence is not null
     or seconds_constraint is distinct from 'CHECK (charged_seconds >= 1410 AND charged_seconds <= 7200)'
     or bytes_constraint is distinct from 'CHECK (charged_evidence_bytes >= 19264968 AND charged_evidence_bytes <= 1664723891)'
     or (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) is distinct from '0a05aae01612b51f74b619ca9e1885f8a92be8f6f5f38f08543dea520cffc7d1'
     or (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='clued_control.reserve_gate(text,text)'::regprocedure) is distinct from '27b474b24da7ed203142d7bbed093d72a7ef8a47a47d3b1e1bdf6ad2b5093c54'
  then raise exception 'STATUS16_SECONDS_EXACT_PREIMAGE_REQUIRED'; end if;
end
$status16_seconds_preimage$;

alter table clued_control.execution_current
  drop constraint execution_current_charged_seconds_check,
  add constraint execution_current_charged_seconds_check
    check (charged_seconds >= 1410 and charged_seconds <= 7506);

do $status16_seconds_postimage$
declare
  c clued_control.execution_current%rowtype;
  seconds_constraint text;
begin
  select * into strict c from clued_control.execution_current
  where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
  select pg_get_constraintdef(oid,true) into strict seconds_constraint from pg_constraint
  where conrelid='clued_control.execution_current'::regclass and conname='execution_current_charged_seconds_check';

  if c.sequence is distinct from 67
     or c.charged_seconds is distinct from 6906
     or c.charged_evidence_bytes is distinct from 1530506163
     or c.active_ga_id is not null or c.pending_budget_sequence is not null
     or seconds_constraint is distinct from 'CHECK (charged_seconds >= 1410 AND charged_seconds <= 7506)'
     or (select count(*) from clued_control.execution_events where root_id=c.root_id) is distinct from 67::bigint
     or (select count(*) from clued_control.control_objects where root_id=c.root_id) is distinct from 16::bigint
     or (select count(*) from clued_control.gate_attempts where root_id=c.root_id) is distinct from 9::bigint
  then raise exception 'STATUS16_SECONDS_EXACT_POSTIMAGE_REQUIRED'; end if;
end
$status16_seconds_postimage$;

commit;
