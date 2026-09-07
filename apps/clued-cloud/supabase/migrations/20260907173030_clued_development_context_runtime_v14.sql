-- New unified authorization development runtime. Applied after retirement of
-- the obsolete standalone bridge. No Link, Acceptance or Publication model.
create table clued_private.development_spaces_v14 (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
  project_id uuid not null references public.clued_projects(id), name text not null,
  environment text not null check(environment in ('test','preview','production')),
  version bigint not null default 1, cursor bigint not null default 0,
  created_at timestamptz not null default now()
);
create table clued_private.development_records_v14 (
  id uuid primary key default gen_random_uuid(), context_id uuid not null references clued_private.development_spaces_v14(id),
  version bigint not null, record_type text not null, body jsonb not null check(jsonb_typeof(body)='object'),
  content_hash text not null, lifecycle_status text not null default 'ACTIVE' check(lifecycle_status in ('ACTIVE','REVOKED','SUPERSEDED')),
  authority text not null default 'candidate', observed_at timestamptz, recorded_at timestamptz not null default now(),
  created_cursor bigint not null, revision_cursor bigint not null, actor_binding_id uuid not null,
  reason text, supersedes uuid, last_verified_at timestamptz, valid_until timestamptz
);
create table clued_private.development_record_versions_v14 (
  record_id uuid not null references clued_private.development_records_v14(id), version bigint not null,
  context_id uuid not null references clued_private.development_spaces_v14(id), revision_cursor bigint not null,
  envelope jsonb not null, primary key(record_id,version)
);
create table clued_private.development_grants_v14 (
  id uuid primary key default gen_random_uuid(), context_id uuid not null references clued_private.development_spaces_v14(id),
  binding_id uuid not null references public.clued_agent_bindings(id), grantor uuid not null references auth.users(id),
  actions text[] not null check(cardinality(actions)>0 and actions <@ array['read','write','feedback_submit']),
  history_policy text not null check(history_policy in ('EXISTING_ONLY','EXISTING_AND_FUTURE','SINCE_CURSOR','EXPLICIT_SET')),
  version_policy text not null check(version_policy in ('LATEST','FIXED_AT_GRANT')),
  freeze_cursor bigint not null, since_cursor bigint, explicit_record_ids uuid[] not null default '{}',
  allowed_fields text[] not null default array['*'], expires_at timestamptz not null,
  revoked_at timestamptz, version bigint not null default 1, created_at timestamptz not null default now(),
  unique(context_id,binding_id)
);
create table clued_private.development_feedback_v14 (
  id uuid primary key default gen_random_uuid(), context_id uuid not null references clued_private.development_spaces_v14(id),
  submitter_binding_id uuid not null, body jsonb not null, selected_evidence jsonb not null default '[]',
  source_ref jsonb, state text not null default 'submitted', response jsonb,
  version bigint not null default 1, created_at timestamptz not null default now(), withdrawn_at timestamptz
);
create table clued_private.development_operations_v14 (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, actor_user_id uuid references auth.users(id), binding_ref text not null,
  context_id uuid, op text not null, idempotency_key text not null, request_hash text not null,
  receipt_id uuid not null default gen_random_uuid(), event_id uuid not null default gen_random_uuid(),
  canonical_version bigint, result jsonb not null, committed_at timestamptz not null default now(),
  unique(owner_id,binding_ref,op,idempotency_key)
);
create index development_records_space_cursor_v14 on clued_private.development_records_v14(context_id,created_cursor,id);
create index development_versions_cursor_v14 on clued_private.development_record_versions_v14(context_id,record_id,revision_cursor desc);
create index development_grants_binding_v14 on clued_private.development_grants_v14(binding_id,context_id);

-- Stable typed Receipt/Event objects over one atomic operation row. These are
-- private deterministic representations, not second event or receipt writers.
create view clued_private.development_receipts_v14 with (security_invoker=true) as
  select receipt_id as id,id as operation_id,owner_id,binding_ref,context_id,op,request_hash,
    canonical_version,'committed'::text as status,result,committed_at from clued_private.development_operations_v14;
create view clued_private.development_events_v14 with (security_invoker=true) as
  select event_id as id,id as operation_id,receipt_id,owner_id,binding_ref,context_id,op as event_type,
    request_hash,canonical_version,committed_at from clued_private.development_operations_v14;
revoke all on clued_private.development_receipts_v14,clued_private.development_events_v14 from public,anon,authenticated,service_role;

create function clued_private.development_hash_v14(p_value jsonb) returns text
language sql immutable set search_path='' as $$
  select encode(extensions.digest(convert_to(p_value::text,'UTF8'),'sha256'),'hex')
$$;

create function clued_private.development_visible_record_v14(p_record uuid,p_grant clued_private.development_grants_v14)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r clued_private.development_records_v14; v jsonb; filtered jsonb;
begin
  select * into r from clued_private.development_records_v14 where id=p_record and context_id=p_grant.context_id;
  if not found or r.lifecycle_status<>'ACTIVE' then return null; end if;
  if p_grant.history_policy='EXISTING_ONLY' and r.created_cursor>p_grant.freeze_cursor then return null; end if;
  if p_grant.history_policy='SINCE_CURSOR' and r.created_cursor<=p_grant.since_cursor then return null; end if;
  if p_grant.history_policy='EXPLICIT_SET' and not(r.id=any(p_grant.explicit_record_ids)) then return null; end if;
  if p_grant.version_policy='FIXED_AT_GRANT' then
    select envelope into v from clued_private.development_record_versions_v14
      where record_id=r.id and revision_cursor<=p_grant.freeze_cursor order by version desc limit 1;
  else v:=to_jsonb(r); end if;
  if v is null then return null; end if;
  if not('*'=any(p_grant.allowed_fields)) then
    select coalesce(jsonb_object_agg(key,value),'{}') into filtered from jsonb_each(v->'body') where key=any(p_grant.allowed_fields);
    v:=jsonb_set(v,'{body}',filtered);
    -- Hashing the complete secret body is also outside a field-restricted view.
    v:=v-'content_hash';
  end if;
  if r.record_type='annotation' then
    v:=v||jsonb_build_object('source_access',clued_private.development_reference_status_v14(v->'body'->'annotation_of',p_grant.binding_id));
  end if;
  return (v-'actor_binding_id'-'reason') || jsonb_build_object('freshness',
    case when r.valid_until is not null and r.valid_until<clock_timestamp() then 'STALE' else 'UNKNOWN' end);
end $$;


-- Human owner setup and authorization-derived internal grants. Business calls
-- always use the explicit connection kernel installed by the following migration.
create function clued_private.development_execute_v14(p_owner uuid,p_binding uuid,p_management boolean,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op text:=p_input->>'op'; c clued_private.development_spaces_v14; b public.clued_agent_bindings;
 g clued_private.development_grants_v14; entry record;
 operation_row clued_private.development_operations_v14; v_result jsonb; rows jsonb:='[]';
 ikey text:=p_input->>'idempotency_key'; rhash text; v_actions text[]; v_fields text[]; v_selected uuid[];
 cid uuid:=nullif(p_input->>'context_id','')::uuid;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or length(p_input::text)>200000 or op is null then
  raise exception 'invalid_context_input' using errcode='22023'; end if;
 perform clued_private.authorization_account_v12(p_owner);
 if not p_management then
  select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_owner and revoked_at is null for share;
  if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  if op='context_list' then
   if not('context:read'=any(b.scopes)) then raise exception 'binding_not_authorized' using errcode='42501'; end if;
   if coalesce(p_input->>'mode','ordinary') not in ('ordinary','development_history') then raise exception 'invalid_context_mode' using errcode='22023'; end if;
   if p_input->>'mode'='development_history' then
    for c in select * from clued_private.development_spaces_v14 x where x.owner_id=p_owner
      and (not(p_input ? 'environment') or x.environment=p_input->>'environment') order by x.created_at,x.id loop
     if 'read'=any(clued_private.authorization_effective_actions_v13(b.id,'context',c.id::text,c.environment)) then
      rows:=rows||jsonb_build_array(jsonb_build_object('id',c.id,'project_id',c.project_id,'name',c.name,'environment',c.environment,'version',c.version));
     end if;
    end loop;
   end if;
   return jsonb_build_object('status','ok','contexts',rows);
  end if;
  return clued_private.development_execute_authorized_v14(p_owner,p_binding,p_input);
 end if;
 if op='owner_list' then
  return jsonb_build_object('status','ok','contexts',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id)
    from clued_private.development_spaces_v14 x where x.owner_id=p_owner and exists(select 1 from public.clued_projects p where p.id=x.project_id and p.user_id=p_owner)),'[]'),
   'projects',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by p.name,p.id)
    from public.clued_projects p where p.user_id=p_owner),'[]'));
 end if;
 if op not in ('context_create','grant_upsert','grant_revoke') then raise exception 'development_owner_operation_not_supported' using errcode='42501'; end if;
 if coalesce(length(ikey),0) not between 8 and 160 then raise exception 'idempotency_key_required' using errcode='22023'; end if;
 rhash:=clued_private.development_hash_v14(p_input);
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':owner:'||op||':'||ikey,0));
 select * into operation_row from clued_private.development_operations_v14 x
  where x.owner_id=p_owner and x.binding_ref='owner_session' and x.op=p_input->>'op' and x.idempotency_key=ikey;
 if found then
  if operation_row.request_hash<>rhash then raise exception 'idempotency_request_mismatch' using errcode='22023'; end if;
  return operation_row.result||jsonb_build_object('replayed',true);
 end if;
 if op='context_create' then
  if coalesce(length(btrim(p_input->>'name')),0) not between 1 and 120
   or coalesce(p_input->>'environment','') not in ('test','preview','production') then raise exception 'invalid_context_definition' using errcode='22023'; end if;
  perform 1 from public.clued_projects where id=(p_input->>'project_id')::uuid and user_id=p_owner for share;
  if not found then raise exception 'owned_project_required' using errcode='42501'; end if;
  insert into clued_private.development_spaces_v14(owner_id,project_id,name,environment)
   values(p_owner,(p_input->>'project_id')::uuid,btrim(p_input->>'name'),p_input->>'environment') returning * into c;
  cid:=c.id;v_result:=to_jsonb(c);
 else
  select * into c from clued_private.development_spaces_v14 where id=cid and owner_id=p_owner for update;
  if not found then raise exception 'context_access_denied' using errcode='42501'; end if;
  perform 1 from public.clued_projects p where p.id=c.project_id and p.user_id=p_owner for share;
  if not found then raise exception 'current_project_owner_required' using errcode='42501'; end if;
  if op='grant_upsert' then
   select * into b from public.clued_agent_bindings where id=(p_input->>'binding_id')::uuid and user_id=p_owner and revoked_at is null for share;
   if not found or not('*'=any(b.context_keys) or ('project:'||c.project_id)=any(b.context_keys)) then raise exception 'owned_binding_required' using errcode='42501'; end if;
   select array_agg(value) into v_actions from jsonb_array_elements_text(p_input->'actions');
   select coalesce(array_agg(value),'{}') into v_fields from jsonb_array_elements_text(coalesce(p_input->'allowed_fields','["*"]'));
   select coalesce(array_agg(value::uuid),'{}') into v_selected from jsonb_array_elements_text(coalesce(p_input->'explicit_record_ids','[]'));
   if v_actions is null or not(v_actions <@ array['read','write','feedback_submit']) or cardinality(v_fields)=0
    or p_input->>'expires_at' is null or (p_input->>'expires_at')::timestamptz<=clock_timestamp() then raise exception 'invalid_grant' using errcode='22023'; end if;
   if p_input->>'history_policy' is distinct from 'EXISTING_AND_FUTURE' or p_input->>'version_policy' is distinct from 'LATEST'
    or v_fields<>array['*'] then raise exception 'explicit_connection_history_required' using errcode='42501'; end if;
   -- A grant is a storage projection of explicit consent, never an alternate
   -- source of delegated authority. Its coarse write may back close only.
   select * into entry from clued_private.authorization_entries_v12 where binding_id=b.id and resource_kind='context'
    and resource_id=c.id::text and environment=c.environment;
   if not found or not(v_actions <@ array(select distinct case x when 'close' then 'write' else x end from unnest(entry.actions) x))
    then raise exception 'explicit_connection_grant_required' using errcode='42501'; end if;
   select * into g from clued_private.development_grants_v14 where context_id=cid and binding_id=b.id;
   if found then
    if g.id is distinct from (p_input->>'grant_id')::uuid or g.version is distinct from (p_input->>'base_version')::bigint then raise exception 'grant_version_conflict' using errcode='40001'; end if;
    update clued_private.development_grants_v14 set actions=v_actions,expires_at=(p_input->>'expires_at')::timestamptz,
      revoked_at=null,version=version+1 where id=g.id returning * into g;
   else
    insert into clued_private.development_grants_v14(context_id,binding_id,grantor,actions,history_policy,version_policy,freeze_cursor,allowed_fields,expires_at)
     values(cid,b.id,p_owner,v_actions,'EXISTING_AND_FUTURE','LATEST',c.cursor,array['*'],(p_input->>'expires_at')::timestamptz) returning * into g;
   end if;
   v_result:=to_jsonb(g);
  else
   update clued_private.development_grants_v14 set revoked_at=clock_timestamp(),version=version+1
    where id=(p_input->>'grant_id')::uuid and context_id=cid and version=(p_input->>'base_version')::bigint returning * into g;
   if not found then raise exception 'grant_version_conflict' using errcode='40001'; end if;
   v_result:=to_jsonb(g);
  end if;
 end if;
 insert into clued_private.development_operations_v14(owner_id,actor_user_id,binding_ref,context_id,op,idempotency_key,request_hash,canonical_version,result)
  values(p_owner,p_owner,'owner_session',cid,op,ikey,rhash,nextval('clued_private.canonical_version_seq'),'{}') returning * into operation_row;
 v_result:=jsonb_build_object('status','committed','operation_id',operation_row.id,'receipt_id',operation_row.receipt_id,'event_id',operation_row.event_id,
  'canonical_version',operation_row.canonical_version,'result',v_result,'replayed',false,
  'receipt',jsonb_build_object('id',operation_row.receipt_id,'operation_id',operation_row.id,'status','committed','request_hash',rhash,'canonical_version',operation_row.canonical_version),
  'event',jsonb_build_object('id',operation_row.event_id,'operation_id',operation_row.id,'receipt_id',operation_row.receipt_id,'event_type',op,'context_id',cid,'canonical_version',operation_row.canonical_version));
 update clued_private.development_operations_v14 set result=v_result where id=operation_row.id;
 return v_result;
end $$;
create function public.clued_development_call_v14(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_binding' using errcode='28000'; end if;
 select * into b from public.clued_agent_bindings where token_hash=p_token_hash and revoked_at is null and oauth_client_id is null;
 if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
 return clued_private.development_execute_v14(b.user_id,b.id,false,p_input);
end $$;
create function public.clued_development_owner_v14(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=clued_private.authorization_owner_v12();
begin
 return clued_private.development_execute_v14(actor,null,true,p_input);
end $$;
revoke all on function public.clued_development_call_v14(text,jsonb),public.clued_development_owner_v14(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_development_call_v14(text,jsonb) to anon,authenticated;
grant execute on function public.clued_development_owner_v14(jsonb) to authenticated;
do $$ declare obj record; begin
 for obj in select tablename from pg_tables where schemaname='clued_private' and tablename like 'development_%_v14' loop
  execute format('alter table clued_private.%I enable row level security',obj.tablename);
  execute format('revoke all on table clued_private.%I from public,anon,authenticated,service_role',obj.tablename);
 end loop;
 for obj in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_private' and p.proname like 'development_%_v14' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',obj.sig);
 end loop;
end $$;
