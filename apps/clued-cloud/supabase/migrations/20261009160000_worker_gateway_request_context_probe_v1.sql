-- Temporary HTTP-only C1 acceptance probe. Apply separately from its close migration.
-- Its sole additional gateway EXECUTE grant must be removed before the final 80-RPC audit.
do $migration$
declare life record;
  table_oid oid; function_oid oid; opened timestamptz; deadline timestamptz; body text;
begin
  function_oid:=to_regprocedure('public.clued_worker_request_context_probe_v1()');
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='clued_worker_request_context_probe_v1'
        and (function_oid is null or p.oid<>function_oid)) then
    raise exception 'worker_request_context_probe_identity_mismatch' using errcode='55000';
  end if;
  table_oid:=to_regclass('clued_private.worker_request_probe_lifecycle_v1');
  if table_oid is null then
    if to_regprocedure('public.clued_worker_request_context_probe_v1()') is not null then
      raise exception 'worker_request_context_probe_identity_mismatch' using errcode='55000';
    end if;
    create table clued_private.worker_request_probe_lifecycle_v1 (
      singleton boolean not null,
      opened_at timestamptz not null,
      deadline timestamptz not null,
      closed_at timestamptz,
      function_oid oid not null,
      function_owner_oid oid not null,
      function_definition text not null,
      constraint worker_request_probe_lifecycle_v1_pkey primary key(singleton),
      constraint worker_request_probe_lifecycle_v1_singleton_check check(singleton),
      constraint worker_request_probe_lifecycle_v1_deadline_check check(deadline=opened_at+interval '30 minutes'),
      constraint worker_request_probe_lifecycle_v1_closed_check check(closed_at is null or closed_at>=opened_at)
    );
    alter table clued_private.worker_request_probe_lifecycle_v1 enable row level security;
    revoke all on clued_private.worker_request_probe_lifecycle_v1 from public,anon,authenticated,service_role,clued_worker_gateway;
    table_oid:='clued_private.worker_request_probe_lifecycle_v1'::regclass;
  end if;
  -- No alternate table shape, policy, trigger, column grant or non-owner ACL is admitted.
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
  function_oid:=to_regprocedure('public.clued_worker_request_context_probe_v1()');
  if found then
    if life.closed_at is not null then
      if function_oid is not null then raise exception 'worker_request_context_probe_identity_mismatch' using errcode='55000'; end if;
      return; -- A close tombstone survives a full migration replay; never resurrect the probe.
    end if;
    if function_oid is null or function_oid<>life.function_oid then
      raise exception 'worker_request_context_probe_identity_mismatch' using errcode='55000';
    end if;
  else
    if function_oid is not null then raise exception 'worker_request_context_probe_identity_mismatch' using errcode='55000'; end if;
    opened:=clock_timestamp(); deadline:=opened+interval '30 minutes';
    body:=format($probe$
declare request_role text:=pg_catalog.current_setting('role',true); claims jsonb;
begin
  begin
    claims:=coalesce(nullif(pg_catalog.current_setting('request.jwt.claims',true),''),'{}')::jsonb;
  exception when invalid_text_representation then
    raise exception 'worker_request_context_probe_denied' using errcode='42501';
  end;
  if current_user<>'clued_worker_gateway' or request_role is distinct from 'clued_worker_gateway'
    or pg_catalog.jsonb_typeof(claims) is distinct from 'object'
    or claims->>'role' is distinct from 'clued_worker_gateway' then
    raise exception 'worker_request_context_probe_denied' using errcode='42501';
  end if;
  if pg_catalog.statement_timestamp()>=%L::timestamptz then
    raise exception 'worker_request_context_probe_expired' using errcode='42501';
  end if;
  return pg_catalog.jsonb_build_object('current_user',current_user,'request_role',request_role,
    'jwt_role',claims->>'role','statement_timeout',pg_catalog.current_setting('statement_timeout'),
    'deadline',%L::timestamptz);
end
$probe$,deadline,deadline);
    execute format('create function public.clued_worker_request_context_probe_v1() returns jsonb language plpgsql stable security invoker set search_path='''' as %L',body);
    revoke all on function public.clued_worker_request_context_probe_v1() from public,anon,authenticated,service_role;
    grant execute on function public.clued_worker_request_context_probe_v1() to clued_worker_gateway;
    function_oid:='public.clued_worker_request_context_probe_v1()'::regprocedure;
    insert into clued_private.worker_request_probe_lifecycle_v1
      select true,opened,deadline,null,function_oid,proowner,pg_get_functiondef(oid) from pg_proc where oid=function_oid;
    select * into strict life from clued_private.worker_request_probe_lifecycle_v1 where singleton;
  end if;
  if not exists(select 1 from pg_proc where oid=function_oid and proowner=life.function_owner_oid
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
end $migration$;
notify pgrst,'reload config';
notify pgrst,'reload schema';
