set local lock_timeout='5s';
-- Retention sweep v1: memory audit keeps 30 days; a continuity session over 35 days past its end or expiry
-- gives up its two resume payload columns (the row stays); one daily pg_cron job runs every retention rule.
-- The stock is cleaned in this transaction. A lock this file cannot take within five seconds fails it with
-- 55P03 and nothing is changed.

-- Each retention period is written once, in its predicate; the stock cleanup below and the daily rule use it.
create function clued_private.retention_memory_audit_expired_v1(a public.clued_memory_audit, p_at timestamptz)
returns boolean language sql stable as $$
  select a.occurred_at < p_at - interval '30 days'
$$;

create function clued_private.retention_session_payload_expired_v1(s public.clued_continuity_sessions, p_at timestamptz)
returns boolean language sql stable as $$
  select coalesce(s.ended_at, s.expires_at) < p_at - interval '35 days'
    and (s.restored_currentness_vector is not null or s.delivered_constraint_refs is not null)
$$;

-- A rule is clued_private.retention_rule_<name>_v<n>(timestamptz) returns integer: it removes what is due at
-- that time, in a bounded batch, and returns the row count. A rule that finds nothing writes nothing.
create function clued_private.retention_rule_memory_audit_v1(p_at timestamptz)
returns integer language sql set search_path='' as $$
  with removed as (
    delete from public.clued_memory_audit
     where id in (select a.id from public.clued_memory_audit a
                   where clued_private.retention_memory_audit_expired_v1(a, p_at) limit 5000)
    returning 1)
  select count(*)::integer from removed
$$;

-- Only the two payload columns: the row, its token hash, its times and constraint_view stay as they are.
create function clued_private.retention_rule_session_payload_v1(p_at timestamptz)
returns integer language sql set search_path='' as $$
  with due as (
    select s.id from public.clued_continuity_sessions s
     where clued_private.retention_session_payload_expired_v1(s, p_at)
     limit 2000 for update skip locked),
  emptied as (
    update public.clued_continuity_sessions s
       set restored_currentness_vector = null, delivered_constraint_refs = null
      from due where s.id = due.id
    returning 1)
  select count(*)::integer from emptied
$$;

-- Some installations have no pg_cron. Same rows as the clued-cron-run-history-retention job this replaces.
create function clued_private.retention_rule_cron_run_history_v1(p_at timestamptz)
returns integer language plpgsql set search_path='' as $$
declare v_count integer;
begin
  if pg_catalog.to_regclass('cron.job_run_details') is null then return 0; end if;
  execute $sql$
    delete from cron.job_run_details
    where status in ('succeeded', 'failed')
      and coalesce(end_time, start_time) < $1 - interval '1 day'
  $sql$ using p_at;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Runs every rule by name, so a later rule is one more function and no change here. A rule that cannot take
-- a lock within three seconds is reported and skipped; the others still run. Any other error fails the run.
create function clued_private.retention_sweep_v1(p_at timestamptz default clock_timestamp())
returns jsonb language plpgsql set search_path='' set lock_timeout='3s' as $$
declare v_rule text; v_count integer; v_result jsonb := '{}'::jsonb;
begin
  for v_rule in
    select p.proname::text from pg_catalog.pg_proc p
     where p.pronamespace = 'clued_private'::regnamespace and p.prokind = 'f' and not p.proretset
       and p.proname ~ '^retention_rule_[a-z0-9_]+_v[0-9]+$'
       and p.pronargs = 1 and p.proargtypes[0] = 'timestamptz'::regtype and p.prorettype = 'integer'::regtype
     order by p.proname collate "C"
  loop
    begin
      execute pg_catalog.format('select clued_private.%I($1)', v_rule) into v_count using p_at;
      v_result := v_result || pg_catalog.jsonb_build_object(v_rule, v_count);
    exception when lock_not_available then
      v_result := v_result || pg_catalog.jsonb_build_object(v_rule, 'lock_not_available');
    end;
  end loop;
  return v_result;
end $$;

revoke all on function
  clued_private.retention_memory_audit_expired_v1(public.clued_memory_audit, timestamptz),
  clued_private.retention_session_payload_expired_v1(public.clued_continuity_sessions, timestamptz),
  clued_private.retention_rule_memory_audit_v1(timestamptz),
  clued_private.retention_rule_session_payload_v1(timestamptz),
  clued_private.retention_rule_cron_run_history_v1(timestamptz),
  clued_private.retention_sweep_v1(timestamptz)
  from public, anon, authenticated, service_role;

comment on table public.clued_memory_audit is
  'Read-only user audit trail with metadata and content digests, kept for 30 days; deleted content is not retained.';

-- Memory audit stock. Deleting would leave the files at their size, so the kept rows are copied out, the
-- table is emptied (new files) and the rows are put back, all under one lock in this transaction.
do $guard$
begin
  -- Row security would hide rows from the copy, and the hidden rows would be lost.
  if row_security_active('public.clued_memory_audit') then
    raise exception 'retention_stock_rls_active';
  end if;
end $guard$;
lock table public.clued_memory_audit in access exclusive mode;
create temp table retention_memory_audit_keep_v1 on commit drop as
  select a.* from public.clued_memory_audit a
   where not clued_private.retention_memory_audit_expired_v1(a, now());
truncate table public.clued_memory_audit;
insert into public.clued_memory_audit select * from retention_memory_audit_keep_v1;
do $verify$
begin
  if (select count(*) from public.clued_memory_audit) <> (select count(*) from retention_memory_audit_keep_v1)
     or exists (select from public.clued_memory_audit a
                 where clued_private.retention_memory_audit_expired_v1(a, now())) then
    raise exception 'retention_stock_refill_mismatch';
  end if;
end $verify$;

-- Session stock: the same predicate, no batch limit, rows stay; the freed space is reused by new sessions.
update public.clued_continuity_sessions s
   set restored_currentness_vector = null, delivered_constraint_refs = null
 where clued_private.retention_session_payload_expired_v1(s, now());

-- One daily job (20:37 UTC) for every rule. The statement timeout is in the command text: a function-level
-- setting is not armed for the call that carries it.
do $cron$
begin
  if to_regclass('cron.job') is not null then
    perform cron.schedule('clued-retention-sweep', '37 20 * * *',
      $command$set local statement_timeout='60s'; select clued_private.retention_sweep_v1()$command$);
    if exists (select from cron.job where jobname = 'clued-cron-run-history-retention') then
      perform cron.unschedule('clued-cron-run-history-retention');
    end if;
  end if;
end $cron$;
