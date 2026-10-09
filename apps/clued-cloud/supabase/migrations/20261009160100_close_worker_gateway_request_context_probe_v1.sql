-- Mandatory cleanup, applied only after the separate, approved HTTP acceptance read.
-- Retain the private close tombstone; a replay of the opening migration stays closed.
do $migration$
declare life record;
  table_oid oid:=to_regclass('clued_private.worker_request_probe_lifecycle_v1');
  function_oid oid:=to_regprocedure('public.clued_worker_request_context_probe_v1()');
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='clued_worker_request_context_probe_v1'
        and (function_oid is null or p.oid<>function_oid)) then
    raise exception 'worker_request_context_probe_identity_mismatch' using errcode='55000';
  end if;
  if table_oid is null then raise exception 'worker_request_context_probe_lifecycle_required' using errcode='55000'; end if;
  if not exists(select 1 from pg_class where oid=table_oid and relkind='r' and relpersistence='p'
      and not relispartition and reloptions is null and relrowsecurity
      and not relforcerowsecurity and relowner=current_user::regrole::oid)
    or (select array_agg(attname::text order by attnum) from pg_attribute where attrelid=table_oid and attnum>0 and not attisdropped)
      is distinct from array['singleton','opened_at','deadline','closed_at','function_oid','function_owner_oid','function_definition']
    or (select array_agg(atttypid order by attnum) from pg_attribute where attrelid=table_oid and attnum>0 and not attisdropped)
      is distinct from array['bool'::regtype::oid,'timestamptz'::regtype::oid,'timestamptz'::regtype::oid,'timestamptz'::regtype::oid,'oid'::regtype::oid,'oid'::regtype::oid,'text'::regtype::oid]
    or (select array_agg(attnotnull order by attnum) from pg_attribute where attrelid=table_oid and attnum>0 and not attisdropped)
      is distinct from array[true,true,true,false,true,true,true]
    or exists(select 1 from pg_attribute where attrelid=table_oid and attnum>0
      and (attisdropped or atthasdef or attidentity<>'' or attgenerated<>'' or attndims<>0 or attacl is not null))
    or exists(select 1 from pg_attribute a join pg_type t on t.oid=a.atttypid
      where a.attrelid=table_oid and a.attnum>0 and a.attcollation<>t.typcollation)
    or exists(select 1 from pg_inherits where inhrelid=table_oid or inhparent=table_oid)
    or exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) a where c.oid=table_oid and a.grantee<>c.relowner)
    or exists(select 1 from pg_policy where polrelid=table_oid)
    or exists(select 1 from pg_trigger where tgrelid=table_oid and not tgisinternal)
    or (select count(*) from pg_index where indrelid=table_oid)<>1
    or exists(select 1 from pg_index where indrelid=table_oid
      and (not indisprimary or not indisunique or not indisvalid or not indisready))
    or (select array_agg(conname::text||':'||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=table_oid and contype in ('p','c'))
      is distinct from array[
        'worker_request_probe_lifecycle_v1_closed_check:CHECK (((closed_at IS NULL) OR (closed_at >= opened_at)))',
        'worker_request_probe_lifecycle_v1_deadline_check:CHECK ((deadline = (opened_at + ''00:30:00''::interval)))',
        'worker_request_probe_lifecycle_v1_pkey:PRIMARY KEY (singleton)',
        'worker_request_probe_lifecycle_v1_singleton_check:CHECK (singleton)']
    -- PostgreSQL 18 additionally catalogs NOT NULL constraints; 17 represents them in attnotnull only.
    or exists(select 1 from pg_constraint where conrelid=table_oid
      and (contype not in ('p','c','n') or (contype='n' and cardinality(conkey)<>1)))
    or (select coalesce(array_agg(conkey[1] order by conkey[1]),'{}'::smallint[]) from pg_constraint where conrelid=table_oid and contype='n')
      is distinct from (case when current_setting('server_version_num')::integer>=180000
        then array[1,2,3,5,6,7]::smallint[] else '{}'::smallint[] end)
    or exists(select 1 from pg_constraint where conrelid=table_oid and not convalidated) then
    raise exception 'worker_request_context_probe_lifecycle_drift' using errcode='55000';
  end if;
  lock table clued_private.worker_request_probe_lifecycle_v1 in exclusive mode;
  select * into life from clued_private.worker_request_probe_lifecycle_v1 where singleton;
  if not found then raise exception 'worker_request_context_probe_lifecycle_required' using errcode='55000'; end if;
  if life.closed_at is not null then
    if function_oid is not null then raise exception 'worker_request_context_probe_identity_mismatch' using errcode='55000'; end if;
    return;
  end if;
  if function_oid is null or function_oid<>life.function_oid
    or not exists(select 1 from pg_proc where oid=function_oid and proowner=life.function_owner_oid
      and proowner=current_user::regrole::oid and not prosecdef and not proleakproof
      and provolatile='s' and prorettype='jsonb'::regtype and pronargs=0 and not proretset
      and proconfig=array['search_path=""'] and pg_get_functiondef(oid)=life.function_definition
      and (regexp_match(prosrc,$deadline$statement_timestamp\(\)>='([^']+)'::timestamptz$deadline$))[1]::timestamptz=life.deadline)
    or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=function_oid and (a.grantee not in (p.proowner,'clued_worker_gateway'::regrole::oid)
        or a.privilege_type<>'EXECUTE' or (a.grantee<>p.proowner and (a.is_grantable or a.grantor<>p.proowner))))
    or not has_function_privilege('clued_worker_gateway',function_oid,'EXECUTE') then
    raise exception 'worker_request_context_probe_identity_mismatch' using errcode='55000';
  end if;
  drop function public.clued_worker_request_context_probe_v1(); -- No CASCADE; never drop an unknown function.
  update clued_private.worker_request_probe_lifecycle_v1 set closed_at=clock_timestamp() where singleton;
end $migration$;
notify pgrst,'reload config';
notify pgrst,'reload schema';
