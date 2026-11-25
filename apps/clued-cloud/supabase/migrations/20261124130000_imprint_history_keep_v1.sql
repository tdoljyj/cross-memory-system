set local lock_timeout='5s';
-- Imprint record history keeps the 20 newest prior versions of each record (Owner decision, 2026-11-24).
-- Older prior versions leave the online database: they are no longer found by the history search and their
-- revision can no longer be opened. The current body is public.clued_memories and is not touched.
-- The stock is cleaned in this transaction. A lock this file cannot take within five seconds fails it with
-- 55P03 and nothing is changed.

-- One more rule for clued_private.retention_sweep_v1, which finds it by name. A record over the limit loses
-- its oldest prior versions, at most 200 rows a run.
create function clued_private.retention_rule_imprint_history_v1(p_at timestamptz)
returns integer language sql set search_path='' as $$
  with excess as (
    select r.user_id, r.record_id, r.version
      from (select h.user_id, h.record_id, h.version,
                   row_number() over (partition by h.user_id, h.record_id order by h.version desc) as newest
              from clued_private.imprint_record_history_v1 h) r
     where r.newest > 20
     order by r.user_id, r.record_id, r.version
     limit 200),
  removed as (
    delete from clued_private.imprint_record_history_v1 h using excess e
     where h.user_id = e.user_id and h.record_id = e.record_id and h.version = e.version
    returning 1)
  select count(*)::integer from removed
$$;
revoke all on function clued_private.retention_rule_imprint_history_v1(timestamptz)
  from public, anon, authenticated, service_role;

-- History stock. Deleting would leave the files at their size, so the kept rows are copied out, the table is
-- emptied (new files) and the rows are put back, all under one lock in this transaction. Only an UPDATE of
-- a history row is refused (imprint_history_immutable_v1); nothing here updates one.
do $guard$
begin
  -- Row security would hide rows from the copy, and the hidden rows would be lost.
  if row_security_active('clued_private.imprint_record_history_v1') then
    raise exception 'retention_stock_rls_active';
  end if;
end $guard$;
lock table clued_private.imprint_record_history_v1 in access exclusive mode;
create temp table retention_imprint_history_keep_v1 on commit drop as
  select h.* from clued_private.imprint_record_history_v1 h
   where (select count(*) from clued_private.imprint_record_history_v1 newer
           where newer.user_id = h.user_id and newer.record_id = h.record_id and newer.version > h.version) < 20;
truncate table clued_private.imprint_record_history_v1;
insert into clued_private.imprint_record_history_v1 select * from retention_imprint_history_keep_v1;
do $verify$
begin
  -- The daily rule is the judge of what is over the limit: after the refill it must find nothing to remove.
  if (select count(*) from clued_private.imprint_record_history_v1) <> (select count(*) from retention_imprint_history_keep_v1)
     or clued_private.retention_rule_imprint_history_v1(now()) <> 0 then
    raise exception 'retention_stock_refill_mismatch';
  end if;
end $verify$;
