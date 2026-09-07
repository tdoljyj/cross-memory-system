-- Candidate: explicit per-connection human consent for the mature OAuth gateway.
-- This is not a production activation. Issuer provisioning is an out-of-band
-- owner operation; no endpoint here can create or reveal its secret.
create table clued_private.authorization_issuers_v12 (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  resource text not null check (resource ~ '^https://'),
  name text not null, revoked_at timestamptz
);
create table clued_private.authorization_requests_v12 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  issuer_hash text not null references clued_private.authorization_issuers_v12(token_hash),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  client_id text not null check (length(client_id) between 1 and 4096),
  client_name text not null, redirect_uri text not null, resource text not null,
  requested_scopes text[] not null, eligible jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  version bigint not null default 1,
  expires_at timestamptz not null default (clock_timestamp()+interval '10 minutes'),
  approval_hash text, binding_id uuid references public.clued_agent_bindings(id) on delete set null,
  unique(owner_id,issuer_hash,request_digest)
);
create table clued_private.authorizations_v12 (
  binding_id uuid primary key references public.clued_agent_bindings(id) on delete cascade,
  request_id uuid not null unique references clued_private.authorization_requests_v12(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null, client_name text not null, resource text not null,
  version bigint not null default 1, expires_at timestamptz not null,
  revoked_at timestamptz, created_at timestamptz not null default clock_timestamp()
);
create table clued_private.authorization_entries_v12 (
  binding_id uuid not null references clued_private.authorizations_v12(binding_id) on delete cascade,
  resource_kind text not null check(resource_kind in ('scope','context')),
  resource_id text not null, environment text not null,
  actions text[] not null check(cardinality(actions)>0 and actions <@ array['read','write','close','restore','audit','feedback_submit']::text[]),
  primary key(binding_id,resource_kind,resource_id,environment)
);
create table clued_private.authorization_audit_v12 (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  binding_id uuid, request_id uuid, operation text not null, version bigint,
  selected jsonb, recorded_at timestamptz not null default clock_timestamp()
);
revoke all on clued_private.authorization_issuers_v12,
 clued_private.authorization_requests_v12,clued_private.authorizations_v12,
 clued_private.authorization_entries_v12,clued_private.authorization_audit_v12
 from public,anon,authenticated,service_role;

create function clued_private.authorization_owner_v12() returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();
begin
  if u is null or nullif(auth.jwt()->>'client_id','') is not null
     or not exists(select 1 from auth.users where id=u) then
    raise exception 'direct_human_session_required' using errcode='42501';
  end if;
  perform clued_private.authorization_account_v12(u);
  return u;
end $$;

create function clued_private.authorization_issuer_v12(p_hash text,p_resource text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from clued_private.authorization_issuers_v12
    where token_hash=p_hash and resource=p_resource and revoked_at is null for share;
  if not found then raise exception 'authorization_issuer_required' using errcode='42501'; end if;
end $$;

-- Only current owner resources are eligible in this slice. Project invitations
-- are not implemented by this function, and account ownership is not a substitute.
create function clued_private.authorization_eligible_v12(p_owner uuid,p_scopes text[])
returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(item order by item->>'resource_kind',item->>'resource_id'),'[]'::jsonb)
  from (
    select jsonb_build_object('resource_kind','scope','resource_id',personal.id,
      'environment','canonical','name',personal.name,
      'actions',to_jsonb(array_remove(array[
        case when 'context:read'=any(p_scopes) then 'read' end,
        case when 'context:write'=any(p_scopes) then 'write' end,
        case when 'context:write'=any(p_scopes) then 'close' end,
        case when 'context:write'=any(p_scopes) then 'restore' end,
        case when 'audit:read'=any(p_scopes) then 'audit' end],null))) item from (values ('global','Personal memory'),('profile','Personal profile')) personal(id,name)
    union all
    select jsonb_build_object('resource_kind','scope','resource_id','project:'||p.id,
      'environment','canonical','name',p.name,
      'actions',to_jsonb(array_remove(array[
        case when 'context:read'=any(p_scopes) then 'read' end,
        case when 'context:write'=any(p_scopes) then 'write' end,
        case when 'context:write'=any(p_scopes) then 'close' end,
        case when 'context:write'=any(p_scopes) then 'restore' end,
        case when 'audit:read'=any(p_scopes) then 'audit' end],null)))
      from public.clued_projects p where p.user_id=p_owner
    union all
    select jsonb_build_object('resource_kind','context','resource_id',c.id::text,
      'environment',c.environment,'name',c.name,
      'actions',to_jsonb(array_remove(array[
        case when 'context:read'=any(p_scopes) then 'read' end,
        case when 'context:write'=any(p_scopes) then 'write' end,
        case when 'context:write'=any(p_scopes) then 'close' end,
        case when 'context:write'=any(p_scopes) then 'feedback_submit' end],null)))
      from clued_private.context_spaces_v11 c where c.owner_id=p_owner
  ) e where jsonb_array_length(item->'actions')>0
$$;

create function clued_private.authorization_validate_selection_v12(p_selected jsonb,p_eligible jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare item jsonb; allowed jsonb; actions text[]; total integer;
begin
  if jsonb_typeof(p_selected) is distinct from 'array' or jsonb_array_length(p_selected)>100
     or jsonb_array_length(p_selected)=0 then
    raise exception 'explicit_nonempty_selection_required' using errcode='22023';
  end if;
  select count(*) into total from (
    select distinct x->>'resource_kind',x->>'resource_id',x->>'environment'
    from jsonb_array_elements(p_selected) x) y;
  if total<>jsonb_array_length(p_selected) then raise exception 'duplicate_authorization_resource' using errcode='22023'; end if;
  for item in select value from jsonb_array_elements(p_selected) loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'actions') is distinct from 'array'
       or jsonb_array_length(item->'actions')=0 then
      raise exception 'invalid_authorization_selection' using errcode='22023';
    end if;
    select array_agg(value) into actions from jsonb_array_elements_text(item->'actions');
    select x into allowed from jsonb_array_elements(p_eligible) x
      where x->>'resource_kind'=item->>'resource_kind'
       and x->>'resource_id'=item->>'resource_id'
       and x->>'environment'=item->>'environment';
    if allowed is null or not(actions <@ array(select jsonb_array_elements_text(allowed->'actions'))) then
      raise exception 'selection_exceeds_requested_or_owned_permissions' using errcode='42501';
    end if;
  end loop;
end $$;

create function public.clued_authorization_prepare_v12(p_issuer_hash text,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.authorization_owner_v12(); r clued_private.authorization_requests_v12;
  scopes text[]; eligible jsonb;
begin
  if jsonb_typeof(p_request) is distinct from 'object'
    or coalesce(p_request->>'request_digest','') !~ '^[0-9a-f]{64}$'
    or coalesce(length(p_request->>'client_id'),0) not between 1 and 4096
    or coalesce(length(p_request->>'client_name'),0)>200
    or coalesce(length(p_request->>'redirect_uri'),0) not between 1 and 4096
    or jsonb_typeof(p_request->'requested_scopes') is distinct from 'array' then
    raise exception 'invalid_authorization_request' using errcode='22023';
  end if;
  perform clued_private.authorization_issuer_v12(p_issuer_hash,p_request->>'resource');
  select array_agg(distinct value) into scopes from jsonb_array_elements_text(p_request->'requested_scopes');
  if scopes is null or not(scopes <@ array['context:read','context:write','audit:read']) then
    raise exception 'unsupported_requested_scope' using errcode='22023';
  end if;
  eligible:=clued_private.authorization_eligible_v12(u,scopes);
  insert into clued_private.authorization_requests_v12(owner_id,issuer_hash,request_digest,client_id,client_name,redirect_uri,resource,requested_scopes,eligible)
    values(u,p_issuer_hash,p_request->>'request_digest',p_request->>'client_id',
      coalesce(nullif(btrim(p_request->>'client_name'),''),'AI client'),p_request->>'redirect_uri',p_request->>'resource',scopes,eligible)
    on conflict(owner_id,issuer_hash,request_digest) do nothing returning * into r;
  if r.id is null then
    select * into r from clued_private.authorization_requests_v12
      where owner_id=u and issuer_hash=p_issuer_hash and request_digest=p_request->>'request_digest' for share;
    if r.client_id is distinct from p_request->>'client_id' or r.resource is distinct from p_request->>'resource'
      or r.redirect_uri is distinct from p_request->>'redirect_uri' or r.requested_scopes<>scopes then
      raise exception 'authorization_request_digest_conflict' using errcode='40001';
    end if;
  end if;
  if r.status<>'pending' or r.expires_at<=clock_timestamp() then raise exception 'authorization_request_closed' using errcode='42501'; end if;
  return jsonb_build_object('request_id',r.id,'version',r.version,'eligible',r.eligible);
end $$;

create function clued_private.authorization_selection_v12(p_binding uuid)
returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('resource_kind',resource_kind,'resource_id',resource_id,
  'environment',environment,'actions',actions) order by resource_kind,resource_id),'[]')
 from clued_private.authorization_entries_v12 where binding_id=p_binding
$$;

create function clued_private.authorization_scope_union_v12(p_selected jsonb)
returns text[] language sql immutable as $$
 select array_agg(distinct case action when 'read' then 'context:read'
  when 'audit' then 'audit:read' else 'context:write' end order by
  case action when 'read' then 'context:read' when 'audit' then 'audit:read' else 'context:write' end)
 from jsonb_array_elements(p_selected) item
 cross join lateral jsonb_array_elements_text(item->'actions') action
$$;

create function clued_private.authorization_replace_entries_v12(p_binding uuid,p_selected jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
 delete from clued_private.authorization_entries_v12 where binding_id=p_binding;
 for item in select value from jsonb_array_elements(p_selected) loop
  insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
   values(p_binding,item->>'resource_kind',item->>'resource_id',item->>'environment',
     array(select distinct jsonb_array_elements_text(item->'actions')));
 end loop;
end $$;

create function public.clued_authorization_approve_v12(
 p_issuer_hash text,p_request_id uuid,p_base_version bigint,p_selected jsonb,
 p_binding_hash text,p_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.authorization_owner_v12(); r clued_private.authorization_requests_v12;
 a clued_private.authorizations_v12; b uuid; scopes text[]; keys text[];
 item jsonb; c clued_private.context_spaces_v11; grant_result jsonb; v_approval_hash text;
begin
 select * into r from clued_private.authorization_requests_v12 where id=p_request_id and owner_id=u for update;
 if not found then raise exception 'authorization_request_not_found' using errcode='42501'; end if;
 perform clued_private.authorization_issuer_v12(p_issuer_hash,r.resource);
 if p_issuer_hash<>r.issuer_hash then raise exception 'authorization_issuer_mismatch' using errcode='42501'; end if;
 if p_binding_hash is null or p_binding_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_binding_hash' using errcode='22023'; end if;
 v_approval_hash:=encode(extensions.digest(jsonb_build_object('selected',p_selected,'binding_hash',p_binding_hash,
   'expires_at',p_expires_at)::text,'sha256'),'hex');
 if r.status='approved' then
   select * into a from clued_private.authorizations_v12 where binding_id=r.binding_id for share;
   if r.approval_hash<>v_approval_hash or a.revoked_at is not null or a.expires_at<=clock_timestamp()
      or a.version<>1 then raise exception 'authorization_approval_replay_conflict' using errcode='40001'; end if;
   return jsonb_build_object('binding_id',a.binding_id,'version',a.version,
     'granted_scopes',clued_private.authorization_scope_union_v12(p_selected),'expires_at',a.expires_at);
 end if;
 if r.status<>'pending' or r.version is distinct from p_base_version or r.expires_at<=clock_timestamp() then
   raise exception 'authorization_request_closed_or_conflict' using errcode='40001'; end if;
 if p_expires_at is null or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '30 days' then
   raise exception 'invalid_authorization_expiry' using errcode='22023'; end if;
 perform clued_private.authorization_validate_selection_v12(p_selected,r.eligible);
 perform clued_private.authorization_validate_selection_v12(p_selected,clued_private.authorization_eligible_v12(u,r.requested_scopes));
 scopes:=clued_private.authorization_scope_union_v12(p_selected);
 if not(scopes <@ r.requested_scopes) then raise exception 'scope_escalation_denied' using errcode='42501'; end if;
 select array_agg(distinct k) into keys from (
   select j->>'resource_id' k from jsonb_array_elements(p_selected) j where j->>'resource_kind'='scope'
   union all select 'project:'||space_row.project_id from jsonb_array_elements(p_selected) j
    join clued_private.context_spaces_v11 space_row on space_row.id::text=j->>'resource_id' and space_row.owner_id=u
    where j->>'resource_kind'='context') entries;
 for item in select value from jsonb_array_elements(p_selected) order by value->>'resource_kind',value->>'resource_id' loop
  perform clued_private.authorization_resource_v12(u,item->>'resource_kind',item->>'resource_id',item->>'environment');
 end loop;
 insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys,oauth_client_id)
   values(u,'OAuth',left(r.client_name,80),p_binding_hash,scopes,keys,null) returning id into b;
 insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at)
   values(b,r.id,u,r.client_id,r.client_name,r.resource,p_expires_at) returning * into a;
 perform clued_private.authorization_replace_entries_v12(b,p_selected);
 -- Existing owner management establishes the corresponding context grant/receipt.
 for item in select value from jsonb_array_elements(p_selected) where value->>'resource_kind'='context' loop
   select * into c from clued_private.context_spaces_v11 where id=(item->>'resource_id')::uuid and owner_id=u;
   grant_result:=public.clued_context_owner(jsonb_build_object('op','grant_upsert','context_id',c.id,'binding_id',b,
     'actions',(select jsonb_agg(distinct case v when 'close' then 'write' else v end) from jsonb_array_elements_text(item->'actions') v),'history_policy','EXISTING_AND_FUTURE','version_policy','LATEST',
     'allowed_fields',jsonb_build_array('*'),'expires_at',p_expires_at,'idempotency_key',r.id::text||':'||c.id::text||':grant'));
   if not('write'=any(array(select jsonb_array_elements_text(item->'actions')))) then
     perform public.clued_context_owner(jsonb_build_object('op','link_upsert','context_id',c.id,'project_id',c.project_id,
       'grant_id',grant_result->'result'->>'id','idempotency_key',r.id::text||':'||c.id::text||':link'));
   end if;
 end loop;
 update clued_private.authorization_requests_v12 set status='approved',version=version+1,binding_id=b,approval_hash=v_approval_hash where id=r.id;
 insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
   values(u,b,r.id,'approve',1,p_selected);
 return jsonb_build_object('binding_id',b,'version',1,'granted_scopes',scopes,'expires_at',p_expires_at);
end $$;

create function public.clued_authorization_deny_v12(p_issuer_hash text,p_request_id uuid,p_base_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.authorization_owner_v12(); r clued_private.authorization_requests_v12;
begin
 select * into r from clued_private.authorization_requests_v12 where id=p_request_id and owner_id=u for update;
 if not found then raise exception 'authorization_request_not_found' using errcode='42501'; end if;
 perform clued_private.authorization_issuer_v12(p_issuer_hash,r.resource);
 if r.issuer_hash<>p_issuer_hash or r.status<>'pending' or r.version is distinct from p_base_version then
   raise exception 'authorization_request_closed_or_conflict' using errcode='40001'; end if;
 update clued_private.authorization_requests_v12 set status='denied',version=version+1 where id=r.id;
 insert into clued_private.authorization_audit_v12(owner_id,request_id,operation,version) values(u,r.id,'deny',r.version+1);
 return jsonb_build_object('status','denied','request_id',r.id,'version',r.version+1);
end $$;

create function public.clued_authorization_manage_v12(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.authorization_owner_v12(); a clued_private.authorizations_v12;
 b uuid:=nullif(p_input->>'binding_id','')::uuid; op text:=p_input->>'op'; selected jsonb;
begin
 if op='list' then return jsonb_build_object('bindings',coalesce((
  select jsonb_agg(jsonb_build_object('binding_id',x.binding_id,'client_id',x.client_id,'client_name',x.client_name,
   'version',x.version,'expires_at',x.expires_at,'revoked_at',x.revoked_at,
   'active',x.revoked_at is null and x.expires_at>clock_timestamp() and exists(select 1 from public.clued_agent_bindings b where b.id=x.binding_id and b.revoked_at is null),'grants',clued_private.authorization_selection_v12(x.binding_id)) order by x.created_at desc)
  from clued_private.authorizations_v12 x where x.owner_id=u),'[]')); end if;
 if op not in ('revoke','reduce') then raise exception 'invalid_authorization_operation' using errcode='22023'; end if;
 -- All authorizations use Binding -> Authorization -> Context lock order.
 perform 1 from public.clued_agent_bindings where id=b and user_id=u for update;
 if not found then raise exception 'owned_binding_required' using errcode='42501'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=b and owner_id=u for update;
 if not found then raise exception 'authorization_not_found' using errcode='42501'; end if;
 if a.version is distinct from (p_input->>'base_version')::bigint or a.revoked_at is not null then
   raise exception 'authorization_version_conflict' using errcode='40001'; end if;
 if op='revoke' then
  update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=b;
  update clued_private.authorizations_v12 set revoked_at=clock_timestamp(),version=version+1 where binding_id=b returning * into a;
 else
  selected:=p_input->'selected';
  perform clued_private.authorization_validate_selection_v12(selected,clued_private.authorization_selection_v12(b));
  perform clued_private.authorization_replace_entries_v12(b,selected);
  update public.clued_agent_bindings set scopes=clued_private.authorization_scope_union_v12(selected) where id=b;
  update clued_private.authorizations_v12 set version=version+1 where binding_id=b returning * into a;
 end if;
 insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
   values(u,b,a.request_id,op,a.version,clued_private.authorization_selection_v12(b));
 return jsonb_build_object('binding_id',b,'version',a.version,'expires_at',a.expires_at,'revoked_at',a.revoked_at,
   'selected',clued_private.authorization_selection_v12(b));
end $$;

-- This check is in the same transaction as the actual business operation.
create function clued_private.authorization_assert_entry_v12(p_binding uuid,p_kind text,p_id text,p_environment text,p_action text)
returns void language plpgsql security definer set search_path='' as $$
declare a clued_private.authorizations_v12;
begin
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for share;
 if not found then return; end if; -- Existing non-migrated raw bindings keep their explicit existing grant.
 if a.revoked_at is not null or a.expires_at<=clock_timestamp()
    then
   raise exception 'authorization_revoked_or_expired' using errcode='42501'; end if;
 if not exists(select 1 from clued_private.authorization_entries_v12 e
   where e.binding_id=p_binding and e.resource_kind=p_kind and e.resource_id=p_id
    and e.environment=p_environment and p_action=any(e.actions)) then
   raise exception 'resource_action_not_authorized' using errcode='42501'; end if;
 perform clued_private.authorization_account_v12(a.owner_id);
 perform clued_private.authorization_resource_v12(a.owner_id,p_kind,p_id,p_environment);
end $$;

create or replace function clued_private.resolve_binding(p_token_hash text,p_required_scope text,p_context_key text)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or coalesce(length(p_context_key),0) not between 1 and 160 then
   raise exception 'invalid_binding_or_context' using errcode='28000'; end if;
 select * into b from public.clued_agent_bindings where token_hash=p_token_hash for share;
 if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp()
   or not(p_required_scope=any(b.scopes)) or not('*'=any(b.context_keys) or p_context_key=any(b.context_keys)) then
   raise exception 'binding_not_authorized' using errcode='42501'; end if;
 perform clued_private.authorization_account_v12(b.user_id);
 perform clued_private.authorization_assert_entry_v12(b.id,'scope',p_context_key,'canonical',
   case p_required_scope when 'context:read' then 'read' when 'audit:read' then 'audit' else 'write' end);
 -- No post-check UPDATE: concurrent shared readers must not deadlock on upgrade.
 return b;
end $$;

alter function clued_private.context_execute_v11(uuid,uuid,boolean,jsonb)
 rename to context_execute_before_connection_authorization_v11;
create function clued_private.context_execute_v11(p_owner uuid,p_binding uuid,p_management boolean,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a clued_private.authorizations_v12; c clued_private.context_spaces_v11;
 op text:=p_input->>'op'; action text; result jsonb; rows jsonb;
begin
 perform clued_private.authorization_account_v12(p_owner);
 if not p_management then
   perform 1 from public.clued_agent_bindings where id=p_binding and user_id=p_owner and revoked_at is null for share;
   if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
   select * into a from clued_private.authorizations_v12 where binding_id=p_binding for share;
   if found then
     if a.revoked_at is not null or a.expires_at<=clock_timestamp() then raise exception 'authorization_revoked_or_expired' using errcode='42501'; end if;
     if op<>'context_list' then
       select * into c from clued_private.context_spaces_v11 where id=(p_input->>'context_id')::uuid and owner_id=p_owner;
       if not found then raise exception 'context_access_denied' using errcode='42501'; end if;
       action:=case op when 'record_list' then 'read' when 'publication_read' then 'read'
        when 'record_put' then 'write' when 'record_revoke' then 'close'
        when 'feedback_submit' then 'feedback_submit' when 'feedback_list' then 'feedback_submit'
        when 'feedback_withdraw' then 'feedback_submit' else 'forbidden' end;
       perform clued_private.authorization_assert_entry_v12(p_binding,'context',c.id::text,c.environment,action);
     end if;
   end if;
 end if;
 result:=clued_private.context_execute_before_connection_authorization_v11(p_owner,p_binding,p_management,p_input);
 if not p_management and a.binding_id is not null and op='context_list' then
   select coalesce(jsonb_agg(x),'[]') into rows from jsonb_array_elements(result->'contexts') x
    where exists(select 1 from clued_private.authorization_entries_v12 e
     where e.binding_id=p_binding and e.resource_kind='context' and e.resource_id=x->>'id'
       and e.environment=x->>'environment' and 'read'=any(e.actions));
   result:=jsonb_set(result,'{contexts}',rows);
 end if;
 return result;
end $$;

-- Supabase OAuth JWTs are not issued by the new provider. No user/client-pair
-- auto-provisioning, latest-session guessing, or broad legacy fallback remains.
create or replace function clued_private.resolve_oauth_binding()
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
begin raise exception 'legacy_oauth_requires_new_provider_reauthorization' using errcode='42501'; end $$;
create or replace function public.clued_context_oauth_call(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin raise exception 'legacy_oauth_requires_new_provider_reauthorization' using errcode='42501'; end $$;

-- Reject legacy OAuth tokens on all public data tables, including public data
-- views whose RLS evaluates as the invoker. Direct user sessions retain policy.
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='public' and tablename like 'clued_%' loop
   execute format('create policy clued_v12_no_legacy_oauth on public.%I as restrictive for all to authenticated using (nullif(auth.jwt()->>''client_id'','''') is null) with check (nullif(auth.jwt()->>''client_id'','''') is null)',t.tablename);
 end loop;
end $$;

-- All existing direct-user SECURITY DEFINER RPCs must use a guarded principal;
-- the original body/hash/CAS contracts remain unchanged.
do $$ declare f record; body text; begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'clued_user_%' loop
   body:=pg_get_functiondef(f.oid);
   if body like '%auth.uid()%' then
     body:=replace(body,'auth.uid()','clued_private.authorization_owner_v12()');
     execute body;
   else
     raise exception 'unguarded_user_rpc_requires_review: %',f.oid::regprocedure;
   end if;
 end loop;
end $$;

revoke all on function public.clued_authorization_prepare_v12(text,jsonb),
 public.clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz),
 public.clued_authorization_deny_v12(text,uuid,bigint),
 public.clued_authorization_manage_v12(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_authorization_prepare_v12(text,jsonb),
 public.clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz),
 public.clued_authorization_deny_v12(text,uuid,bigint),
 public.clued_authorization_manage_v12(jsonb) to authenticated;
do $$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='clued_private' and (p.proname like 'authorization_%_v12'
    or p.proname='context_execute_before_connection_authorization_v11') loop
   execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
end $$;


-- Only the connection capability may inspect/revoke its own authorization.
create function public.clued_authorization_status_v12(p_token_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('active',false); end if;
 select * into b from public.clued_agent_bindings where token_hash=p_token_hash for share;
 if not found then return jsonb_build_object('active',false); end if;
 select * into a from clued_private.authorizations_v12 where binding_id=b.id for share;
 if not found then return jsonb_build_object('active',false); end if;
 perform clued_private.authorization_account_v12(a.owner_id);
 return jsonb_build_object('active',b.revoked_at is null and a.revoked_at is null and a.expires_at>clock_timestamp()
   and exists(select 1 from auth.users where id=a.owner_id),
   'binding_id',b.id,'expires_at',a.expires_at,'version',a.version);
exception when insufficient_privilege then return jsonb_build_object('active',false); end $$;
create function public.clued_authorization_revoke_self_v12(p_token_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('active',false); end if;
 select * into b from public.clued_agent_bindings where token_hash=p_token_hash for update;
 if not found then return jsonb_build_object('active',false); end if;
 select * into a from clued_private.authorizations_v12 where binding_id=b.id for update;
 if not found then return jsonb_build_object('active',false); end if;
 if a.revoked_at is null then
  update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=b.id;
  update clued_private.authorizations_v12 set revoked_at=clock_timestamp(),version=version+1 where binding_id=b.id returning * into a;
  insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version)
   values(a.owner_id,b.id,a.request_id,'revoke_self',a.version);
 end if;
 return jsonb_build_object('active',false,'binding_id',b.id,'expires_at',a.expires_at,'version',a.version);
end $$;
revoke all on function public.clued_authorization_status_v12(text),public.clued_authorization_revoke_self_v12(text)
 from public,anon,authenticated,service_role;
grant execute on function public.clued_authorization_status_v12(text),public.clued_authorization_revoke_self_v12(text) to anon,authenticated;

-- Historical global list is an aggregation across projects. For delegated
-- connections filter against the actual canonical scope of each source row.
create or replace function public.clued_record_list(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; result jsonb; rows jsonb; delegated boolean;
begin
 b:=clued_private.resolve_binding(p_token_hash,'context:read',case when p_input->>'level'='project' then 'project:'||(p_input->>'project_id') else 'global' end);
 result:=clued_private.record_list_core(b.user_id,p_input);
 select exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id) into delegated;
 if delegated then
  select coalesce(jsonb_agg(x),'[]') into rows from jsonb_array_elements(result->'records') x
  where exists(
   select 1 from clued_private.authorization_entries_v12 e
    where e.binding_id=b.id and e.resource_kind='scope' and e.environment='canonical' and 'read'=any(e.actions)
     and e.resource_id=case when p_input->>'record_type'='log' then
       (select coalesce(ev.event_scope,ev.context_key) from public.clued_context_events ev where ev.id::text=x->>'id' and ev.user_id=b.user_id)
     else (select coalesce(m.canonical_scope,case when m.project_id is not null then 'project:'||m.project_id else m.scope end)
       from public.clued_memories m where m.id::text=x->>'id' and m.user_id=b.user_id) end
     and (e.resource_id in ('global','profile') or exists(select 1 from public.clued_projects p where 'project:'||p.id=e.resource_id and p.user_id=b.user_id)));
  result:=jsonb_set(result,'{records}',rows);
 end if;
 return result;
end $$;

-- A reclassification changes both source and destination resources.
create or replace function public.clued_record_mutate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; original_scope text;
begin
 b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',coalesce(p_input->>'scope','global'),case p_input->>'operation' when 'close' then 'close' when 'restore' then 'restore' else 'write' end);
 if exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id) and p_input->>'operation'='reclassify_scope' then
  select canonical_scope into original_scope from public.clued_memories where id=(p_input->>'id')::uuid and user_id=b.user_id for update;
  if not found then raise exception 'record_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_assert_entry_v12(b.id,'scope',original_scope,'canonical','write');
 end if;
 if exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id) and p_input->>'operation' in ('close','restore') then
  if (coalesce(p_input->'mutation','{}')-array['closure_summary','closed_reason'])<>'{}'::jsonb
    or p_input ?| array['source_refs','source_unavailable_reason','observed_at','confidence'] then
   raise exception 'lifecycle_action_cannot_edit_record_content' using errcode='42501';
  end if;
 end if;
 return clued_private.record_mutation_core(b.user_id,b.id,p_input,
  clued_private.m1_sha256(jsonb_build_object('operation','record_mutation','payload',p_input)));
end $$;

-- Whole-account canonical export contains records, evidence, and historical
-- receipts outside individual selected resources. Delegation needs a separate
-- reviewed export permission/filtered contract before this operation is enabled.
create or replace function public.clued_canonical_export(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
 b:=clued_private.resolve_binding(p_token_hash,'context:read','global');
 if exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id) then
   raise exception 'delegated_whole_account_export_not_supported' using errcode='42501'; end if;
 return clued_private.canonical_export_core(b.user_id,b.id,p_input,
  clued_private.m1_sha256(jsonb_build_object('operation','export','payload',p_input)));
end $$;
-- Legacy helper was already retired by mandatory continuity; keep it private.
revoke all on function public.clued_resolve_binding(text,text) from public,anon,authenticated,service_role;

-- Provider storage adapter calls this only after its own client/token checks.
-- The issuer can revoke only connections it actually issued, never grant/read.
create function public.clued_authorization_revoke_issuer_v12(p_issuer_hash text,p_binding_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; r clued_private.authorization_requests_v12;
begin
 select * into b from public.clued_agent_bindings where id=p_binding_id for update;
 if not found then raise exception 'issuer_binding_not_authorized' using errcode='42501'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=b.id for update;
 if not found then raise exception 'issuer_binding_not_authorized' using errcode='42501'; end if;
 select * into r from clued_private.authorization_requests_v12 where id=a.request_id;
 if r.issuer_hash is distinct from p_issuer_hash then raise exception 'issuer_binding_not_authorized' using errcode='42501'; end if;
 perform clued_private.authorization_issuer_v12(p_issuer_hash,a.resource);
 if a.revoked_at is null then
  update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=b.id;
  update clued_private.authorizations_v12 set revoked_at=clock_timestamp(),version=version+1 where binding_id=b.id returning * into a;
  insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version)
   values(a.owner_id,b.id,a.request_id,'revoke_issuer',a.version);
 end if;
 return jsonb_build_object('active',false,'binding_id',b.id,'expires_at',a.expires_at,'version',a.version);
end $$;
revoke all on function public.clued_authorization_revoke_issuer_v12(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.clued_authorization_revoke_issuer_v12(text,uuid) to anon,authenticated;

revoke all on function clued_private.context_execute_v11(uuid,uuid,boolean,jsonb) from public,anon,authenticated,service_role;
-- Account and current resource qualification are checked while holding locks
-- through the business transaction, not only when the OAuth token is issued.
create function clued_private.authorization_account_v12(p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
declare account_row jsonb;
begin
 select to_jsonb(u) into account_row from auth.users u where u.id=p_owner for share;
 if not found or account_row->>'deleted_at' is not null
   or coalesce((account_row->>'banned_until')::timestamptz>clock_timestamp(),false) then
  raise exception 'account_not_available' using errcode='42501';
 end if;
end $$;
create function clued_private.authorization_resource_v12(p_owner uuid,p_kind text,p_id text,p_environment text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_kind='scope' and p_id in ('global','profile') and p_environment='canonical' then return; end if;
 if p_kind='scope' and p_environment='canonical' then
  perform 1 from public.clued_projects p where 'project:'||p.id=p_id and p.user_id=p_owner for share;
 elsif p_kind='context' then
  -- The existing context core also writes/locks the context cursor. Acquire the
  -- final lock mode now, avoiding a shared-to-exclusive upgrade deadlock.
  perform 1 from clued_private.context_spaces_v11 c where c.id::text=p_id and c.owner_id=p_owner and c.environment=p_environment for update;
 else
  raise exception 'current_resource_ownership_required' using errcode='42501';
 end if;
 if not found then raise exception 'current_resource_ownership_required' using errcode='42501'; end if;
end $$;
revoke all on function clued_private.authorization_account_v12(uuid),
 clued_private.authorization_resource_v12(uuid,text,text,text) from public,anon,authenticated,service_role;

-- Authorize every superseded record by its actual locked source scope. Missing
-- replacement.scope must never turn SQL NULL comparison into a global fallback.
create or replace function public.clued_decision_supersede(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; item jsonb; source_row public.clued_memories; ids uuid[];
 target_scope text:=nullif(btrim(p_input->'replacement'->>'scope'),'');
begin
 if target_scope is null then raise exception 'replacement_scope_required' using errcode='22023'; end if;
 b:=clued_private.resolve_binding(p_token_hash,'context:write',target_scope);
 if jsonb_typeof(p_input->'source_decisions') is distinct from 'array'
   or jsonb_array_length(p_input->'source_decisions') not between 1 and 100 then
  raise exception 'source_decisions_required' using errcode='22023'; end if;
 select array_agg((x->>'id')::uuid order by x->>'id') into ids from jsonb_array_elements(p_input->'source_decisions') x;
 perform 1 from public.clued_memories where id=any(ids) and user_id=b.user_id order by id for update;
 for item in select value from jsonb_array_elements(p_input->'source_decisions') order by value->>'id' loop
  select * into source_row from public.clued_memories where id=(item->>'id')::uuid and user_id=b.user_id;
  if not found then raise exception 'source_decision_not_authorized' using errcode='42501'; end if;
  perform clued_private.resolve_binding(p_token_hash,'context:write',
    coalesce(source_row.canonical_scope,case when source_row.project_id is not null then 'project:'||source_row.project_id else source_row.scope end));
 end loop;
 return clued_private.decision_supersede_core(b.user_id,b.id,p_input,
  clued_private.m1_sha256(jsonb_build_object('operation','decision_supersede','payload',p_input)));
end $$;

-- OAuth scope is intentionally coarse. This entry resolves the actual business
-- action separately, so context:write never implies close/archive or restore.
create function clued_private.resolve_binding_action_v12(p_token_hash text,p_required_scope text,p_context_key text,p_action text)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or coalesce(length(p_context_key),0) not between 1 and 160 then
  raise exception 'invalid_binding_or_context' using errcode='28000'; end if;
 select * into b from public.clued_agent_bindings where token_hash=p_token_hash for share;
 if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp()
   or not(p_required_scope=any(b.scopes)) or not('*'=any(b.context_keys) or p_context_key=any(b.context_keys)) then
  raise exception 'binding_not_authorized' using errcode='42501'; end if;
 perform clued_private.authorization_account_v12(b.user_id);
 perform clued_private.authorization_assert_entry_v12(b.id,'scope',p_context_key,'canonical',p_action);
 return b;
end $$;
revoke all on function clued_private.resolve_binding_action_v12(text,text,text,text) from public,anon,authenticated,service_role;
