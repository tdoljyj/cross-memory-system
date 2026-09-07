-- Context Ownership v1.1 successor. Same online Canon, isolated private payloads.
-- M1 transaction/CAS/idempotency semantics are reused; no private content is
-- written to legacy user-wide memories, events, evidence or audit receipts.
-- One owner, explicitly selected Bindings, one canonical_api publication channel.

create table clued_private.context_spaces_v11 (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
  project_id uuid not null references public.clued_projects(id), name text not null,
  environment text not null check(environment in ('test','preview','production')),
  version bigint not null default 1, cursor bigint not null default 0,
  created_at timestamptz not null default now()
);
create table clued_private.context_records_v11 (
  id uuid primary key default gen_random_uuid(), context_id uuid not null references clued_private.context_spaces_v11(id),
  version bigint not null, record_type text not null, body jsonb not null check(jsonb_typeof(body)='object'),
  content_hash text not null, lifecycle_status text not null default 'ACTIVE' check(lifecycle_status in ('ACTIVE','REVOKED','SUPERSEDED')),
  authority text not null default 'candidate', observed_at timestamptz, recorded_at timestamptz not null default now(),
  created_cursor bigint not null, revision_cursor bigint not null, actor_binding_id uuid not null,
  reason text, supersedes uuid, last_verified_at timestamptz, valid_until timestamptz
);
create table clued_private.context_record_versions_v11 (
  record_id uuid not null references clued_private.context_records_v11(id), version bigint not null,
  context_id uuid not null references clued_private.context_spaces_v11(id), revision_cursor bigint not null,
  envelope jsonb not null, primary key(record_id,version)
);
create table clued_private.context_grants_v11 (
  id uuid primary key default gen_random_uuid(), context_id uuid not null references clued_private.context_spaces_v11(id),
  binding_id uuid not null references public.clued_agent_bindings(id), grantor uuid not null references auth.users(id),
  actions text[] not null check(cardinality(actions)>0 and actions <@ array['read','write','accept','publish','feedback_submit','feedback_manage']),
  history_policy text not null check(history_policy in ('EXISTING_ONLY','EXISTING_AND_FUTURE','SINCE_CURSOR','EXPLICIT_SET')),
  version_policy text not null check(version_policy in ('LATEST','FIXED_AT_GRANT')),
  freeze_cursor bigint not null, since_cursor bigint, explicit_record_ids uuid[] not null default '{}',
  allowed_fields text[] not null default array['*'], expires_at timestamptz not null,
  revoked_at timestamptz, version bigint not null default 1, created_at timestamptz not null default now(),
  unique(context_id,binding_id)
);
create table clued_private.context_links_v11 (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null references public.clued_projects(id),
  context_id uuid not null references clued_private.context_spaces_v11(id), grant_id uuid not null references clued_private.context_grants_v11(id),
  version bigint not null default 1, removed_at timestamptz, unique(project_id,grant_id)
);
create table clued_private.context_acceptances_v11 (
  id uuid primary key default gen_random_uuid(), context_id uuid not null references clued_private.context_spaces_v11(id),
  record_id uuid not null references clued_private.context_records_v11(id), record_version bigint not null, content_hash text not null,
  publication_payload jsonb not null, payload_hash text not null, audience text not null,
  channel text not null, environment text not null, actor_binding_id uuid not null, grant_id uuid not null,
  grant_version bigint not null, version bigint not null default 1, status text not null default 'ACCEPTED',
  created_at timestamptz not null default now()
);
create table clued_private.context_publications_v11 (
  id uuid primary key default gen_random_uuid(), context_id uuid not null references clued_private.context_spaces_v11(id),
  acceptance_id uuid not null references clued_private.context_acceptances_v11(id), payload jsonb not null, payload_hash text not null,
  audience text not null, channel text not null, environment text not null, actor_binding_id uuid not null,
  grant_id uuid not null, grant_version bigint not null, previous_id uuid,
  version bigint not null default 1, visibility text not null default 'UNPUBLISHED', delivery_status text not null default 'PENDING',
  created_at timestamptz not null default now(), withdrawn_at timestamptz
);
create table clued_private.context_publication_heads_v11 (
  context_id uuid not null references clued_private.context_spaces_v11(id), audience text not null, channel text not null,
  environment text not null, publication_id uuid, primary key(context_id,audience,channel,environment)
);
create table clued_private.context_feedback_v11 (
  id uuid primary key default gen_random_uuid(), context_id uuid not null references clued_private.context_spaces_v11(id),
  submitter_binding_id uuid not null, body jsonb not null, selected_evidence jsonb not null default '[]',
  source_ref jsonb, state text not null default 'submitted', response jsonb,
  version bigint not null default 1, created_at timestamptz not null default now(), withdrawn_at timestamptz
);
create table clued_private.context_operations_v11 (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, binding_ref text not null,
  context_id uuid, op text not null, idempotency_key text not null, request_hash text not null,
  receipt_id uuid not null default gen_random_uuid(), event_id uuid not null default gen_random_uuid(),
  canonical_version bigint, result jsonb not null, committed_at timestamptz not null default now(),
  unique(owner_id,binding_ref,op,idempotency_key)
);
create index context_records_space_cursor_v11 on clued_private.context_records_v11(context_id,created_cursor,id);
create index context_versions_cursor_v11 on clued_private.context_record_versions_v11(context_id,record_id,revision_cursor desc);
create index context_grants_binding_v11 on clued_private.context_grants_v11(binding_id,context_id);

-- Stable typed Receipt/Event objects over one atomic operation row. These are
-- private deterministic representations, not second event or receipt writers.
create view clued_private.context_receipts_v11 with (security_invoker=true) as
  select receipt_id as id,id as operation_id,owner_id,binding_ref,context_id,op,request_hash,
    canonical_version,'committed'::text as status,result,committed_at from clued_private.context_operations_v11;
create view clued_private.context_events_v11 with (security_invoker=true) as
  select event_id as id,id as operation_id,receipt_id,owner_id,binding_ref,context_id,op as event_type,
    request_hash,canonical_version,committed_at from clued_private.context_operations_v11;
revoke all on clued_private.context_receipts_v11,clued_private.context_events_v11 from public,anon,authenticated,service_role;

-- OAuth clients must never obtain sibling Binding hashes or rewrite delegation.
-- Restrictive policies compose with existing owner/P5 policies, never widen them.
create policy clued_v11_oauth_binding_select on public.clued_agent_bindings as restrictive for select to authenticated
  using (nullif(auth.jwt()->>'client_id','') is null or oauth_client_id=auth.jwt()->>'client_id');
create policy clued_v11_oauth_binding_insert on public.clued_agent_bindings as restrictive for insert to authenticated
  with check (nullif(auth.jwt()->>'client_id','') is null);
create policy clued_v11_oauth_binding_update on public.clued_agent_bindings as restrictive for update to authenticated
  using (nullif(auth.jwt()->>'client_id','') is null) with check (nullif(auth.jwt()->>'client_id','') is null);
create policy clued_v11_oauth_binding_delete on public.clued_agent_bindings as restrictive for delete to authenticated
  using (nullif(auth.jwt()->>'client_id','') is null);

create function clued_private.context_hash_v11(p_value jsonb) returns text
language sql immutable set search_path='' as $$
  select encode(extensions.digest(convert_to(p_value::text,'UTF8'),'sha256'),'hex')
$$;

create function clued_private.context_active_grant_v11(p_context uuid,p_binding uuid,p_action text)
returns clued_private.context_grants_v11 language plpgsql security definer set search_path='' as $$
declare g clued_private.context_grants_v11;
begin
  select x.* into g from clued_private.context_grants_v11 x
    join public.clued_agent_bindings b on b.id=x.binding_id
    join clued_private.context_spaces_v11 c on c.id=x.context_id and c.owner_id=b.user_id
    where x.context_id=p_context and x.binding_id=p_binding and p_action=any(x.actions)
      and x.revoked_at is null and x.expires_at>clock_timestamp() and b.revoked_at is null
      and (to_jsonb(b)->>'expires_at' is null or (to_jsonb(b)->>'expires_at')::timestamptz>clock_timestamp())
      and to_jsonb(b)->>'organization_id' is null;
  if not found then raise exception 'context_access_denied' using errcode='42501'; end if;
  return g;
end $$;

create function clued_private.context_visible_record_v11(p_record uuid,p_grant clued_private.context_grants_v11)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r clued_private.context_records_v11; v jsonb; filtered jsonb;
begin
  select * into r from clued_private.context_records_v11 where id=p_record and context_id=p_grant.context_id;
  if not found or r.lifecycle_status<>'ACTIVE' then return null; end if;
  if p_grant.history_policy='EXISTING_ONLY' and r.created_cursor>p_grant.freeze_cursor then return null; end if;
  if p_grant.history_policy='SINCE_CURSOR' and r.created_cursor<=p_grant.since_cursor then return null; end if;
  if p_grant.history_policy='EXPLICIT_SET' and not(r.id=any(p_grant.explicit_record_ids)) then return null; end if;
  if p_grant.version_policy='FIXED_AT_GRANT' then
    select envelope into v from clued_private.context_record_versions_v11
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
    v:=v||jsonb_build_object('source_access',clued_private.context_reference_status_v11(v->'body'->'annotation_of',p_grant.binding_id));
  end if;
  return (v-'actor_binding_id'-'reason') || jsonb_build_object('freshness',
    case when r.valid_until is not null and r.valid_until<clock_timestamp() then 'STALE' else 'UNKNOWN' end);
end $$;

-- References preserve user authorship without materializing a source body.
-- This checker does not recursively traverse annotation chains.
create function clued_private.context_reference_status_v11(p_ref jsonb,p_binding uuid) returns text
language plpgsql security definer set search_path='' as $$
declare g clued_private.context_grants_v11; r clued_private.context_records_v11; v jsonb; b public.clued_agent_bindings; c clued_private.context_spaces_v11;
begin
  if jsonb_typeof(p_ref) is distinct from 'object' then return 'unavailable'; end if;
  g:=clued_private.context_active_grant_v11((p_ref->>'context_id')::uuid,p_binding,'read');
  select * into b from public.clued_agent_bindings where id=p_binding;
  select * into c from clued_private.context_spaces_v11 where id=g.context_id;
  if not('context:read'=any(b.scopes)) or not('*'=any(b.context_keys) or ('project:'||c.project_id)=any(b.context_keys))
    or not('*'=any(g.allowed_fields)) then return 'restricted'; end if;
  if not('write'=any(g.actions)) and not exists(select 1 from clued_private.context_links_v11 k where k.grant_id=g.id and k.removed_at is null) then return 'restricted'; end if;
  select * into r from clued_private.context_records_v11 where id=(p_ref->>'record_id')::uuid and context_id=g.context_id;
  if not found or r.lifecycle_status<>'ACTIVE' then return 'unavailable'; end if;
  if (g.history_policy='EXISTING_ONLY' and r.created_cursor>g.freeze_cursor)
    or (g.history_policy='SINCE_CURSOR' and r.created_cursor<=g.since_cursor)
    or (g.history_policy='EXPLICIT_SET' and not(r.id=any(g.explicit_record_ids))) then return 'restricted'; end if;
  if g.version_policy='FIXED_AT_GRANT' then
    select envelope into v from clued_private.context_record_versions_v11 where record_id=r.id and revision_cursor<=g.freeze_cursor order by version desc limit 1;
  else v:=to_jsonb(r); end if;
  if v is null then return 'restricted'; end if;
  if (v->>'version')::bigint is distinct from (p_ref->>'version')::bigint or v->>'content_hash' is distinct from p_ref->>'content_hash' then return 'changed'; end if;
  return 'current';
exception when insufficient_privilege then return 'restricted';
end $$;

create function clued_private.context_publication_valid_v11(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.context_publications_v11 p
    join clued_private.context_acceptances_v11 a on a.id=p.acceptance_id
    join clued_private.context_records_v11 r on r.id=a.record_id
    join clued_private.context_grants_v11 ag on ag.id=a.grant_id and ag.version=a.grant_version
    join clued_private.context_grants_v11 pg on pg.id=p.grant_id and pg.version=p.grant_version
    join public.clued_agent_bindings ab on ab.id=a.actor_binding_id
    join public.clued_agent_bindings pb on pb.id=p.actor_binding_id
    where p.id=p_id and p.visibility='PUBLISHED' and p.delivery_status='VERIFIED'
      and a.status='ACCEPTED' and r.lifecycle_status='ACTIVE' and r.version=a.record_version and r.content_hash=a.content_hash
      and (r.valid_until is null or r.valid_until>now())
      and ag.revoked_at is null and pg.revoked_at is null and ag.expires_at>now() and pg.expires_at>now()
      and 'accept'=any(ag.actions) and 'publish'=any(pg.actions) and ab.revoked_at is null and pb.revoked_at is null
      and (to_jsonb(ab)->>'expires_at' is null or (to_jsonb(ab)->>'expires_at')::timestamptz>now())
      and (to_jsonb(pb)->>'expires_at' is null or (to_jsonb(pb)->>'expires_at')::timestamptz>now()))
$$;

create function clued_private.context_execute_v11(p_owner uuid,p_binding uuid,p_management boolean,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare
  op text:=p_input->>'op'; cid uuid:=nullif(p_input->>'context_id','')::uuid;
  binding_ref text:=coalesce(p_binding::text,'owner_session'); action text;
  c clued_private.context_spaces_v11; b public.clued_agent_bindings;
  g clued_private.context_grants_v11; target_g clued_private.context_grants_v11;
  r clued_private.context_records_v11; a clued_private.context_acceptances_v11;
  p clued_private.context_publications_v11; f clued_private.context_feedback_v11;
  l clued_private.context_links_v11; operation clued_private.context_operations_v11;
  result jsonb; rows jsonb; item jsonb; reqhash text; ikey text:=p_input->>'idempotency_key';
  version_base bigint; seq bigint; old_head uuid; rid uuid; selected uuid[]; fields text[]; actions text[];
  cursor_after bigint:=coalesce((p_input->>'after_cursor')::bigint,0); lim int:=least(greatest(coalesce((p_input->>'limit')::int,100),1),200);
begin
  if p_owner is null or not exists(select 1 from auth.users where id=p_owner) then raise exception 'account_required' using errcode='28000'; end if;
  if jsonb_typeof(p_input)<>'object' or op is null or length(p_input::text)>200000 then raise exception 'invalid_context_input' using errcode='22023'; end if;
  if p_input ? 'owner_id' or p_input ? 'owner_ref' or p_input ? 'grantor' then raise exception 'owner_is_server_derived' using errcode='42501'; end if;
  if not p_management then
    select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_owner and revoked_at is null for share;
    if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
    if (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() or to_jsonb(b)->>'organization_id' is not null then
      raise exception 'personal_current_binding_required' using errcode='42501'; end if;
  end if;

  if op='owner_list' and p_management then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at),'[]') into rows from clued_private.context_spaces_v11 s where s.owner_id=p_owner;
    return jsonb_build_object('status','ok','contexts',rows,
      'projects',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'name',x.name) order by x.name,x.id) from public.clued_projects x where x.user_id=p_owner),'[]'),
      'bindings',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'agent_name',x.agent_name,'oauth_client_id',x.oauth_client_id,'revoked_at',x.revoked_at)) from public.clued_agent_bindings x where x.user_id=p_owner),'[]'),
      'grants',coalesce((select jsonb_agg(to_jsonb(x)) from clued_private.context_grants_v11 x join clued_private.context_spaces_v11 s on s.id=x.context_id where s.owner_id=p_owner),'[]'),
      'links',coalesce((select jsonb_agg(to_jsonb(x)) from clued_private.context_links_v11 x where x.owner_id=p_owner and x.removed_at is null),'[]'));
  end if;
  if op='context_list' and not p_management then
    if not('context:read'=any(b.scopes)) then raise exception 'binding_not_authorized' using errcode='42501'; end if;
    if coalesce(p_input->>'mode','ordinary') not in ('ordinary','development_history') then raise exception 'invalid_context_mode' using errcode='22023'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'project_id',s.project_id,'name',s.name,'environment',s.environment,'version',s.version) order by s.created_at),'[]') into rows
      from clued_private.context_spaces_v11 s where s.owner_id=p_owner
      and ('*'=any(b.context_keys) or ('project:'||s.project_id)=any(b.context_keys))
      and (not(p_input ? 'environment') or p_input->>'environment'=s.environment) and
      (case when coalesce(p_input->>'mode','ordinary')='ordinary' then exists(
        select 1 from clued_private.context_publication_heads_v11 h where h.context_id=s.id and clued_private.context_publication_valid_v11(h.publication_id))
       else exists(select 1 from clued_private.context_grants_v11 x where x.context_id=s.id and x.binding_id=p_binding and 'read'=any(x.actions)
         and x.revoked_at is null and x.expires_at>clock_timestamp()
         and ('write'=any(x.actions) or exists(select 1 from clued_private.context_links_v11 k where k.grant_id=x.id and k.removed_at is null))) end);
    return jsonb_build_object('status','ok','contexts',rows);
  end if;

  if op<>'context_create' then
    -- One context row serializes grants, record revisions and publication CAS.
    -- Reuse existing database row locking, no additional distributed lock service.
    select * into c from clued_private.context_spaces_v11 where id=cid and owner_id=p_owner for update;
    if not found then raise exception 'context_access_denied' using errcode='42501'; end if;
    if p_input ? 'environment' and p_input->>'environment' is distinct from c.environment then raise exception 'environment_mismatch' using errcode='42501'; end if;
  elsif not p_management then raise exception 'owner_management_required' using errcode='42501'; end if;

  if p_management then
    if not(op=any(array['context_create','grant_upsert','grant_revoke','link_upsert','link_remove'])) then raise exception 'owner_management_only' using errcode='42501'; end if;
  else
    action:=case op when 'record_list' then 'read' when 'record_put' then 'write' when 'record_revoke' then 'write'
      when 'accept' then 'accept' when 'publish' then 'publish' when 'publication_deliver' then 'publish' when 'publication_withdraw' then 'publish'
      when 'feedback_submit' then 'feedback_submit' when 'feedback_update' then 'feedback_manage'
      when 'feedback_list' then 'feedback_submit' when 'feedback_withdraw' then 'feedback_submit' when 'publication_read' then null else 'INVALID' end;
    if action='INVALID' then raise exception 'unsupported_context_operation' using errcode='22023'; end if;
    if not((case when op in ('record_list','publication_read','feedback_list') then 'context:read' else 'context:write' end)=any(b.scopes)) then raise exception 'binding_not_authorized' using errcode='42501'; end if;
    if not('*'=any(b.context_keys) or ('project:'||c.project_id)=any(b.context_keys)) then raise exception 'binding_context_denied' using errcode='42501'; end if;
    if action is not null then g:=clued_private.context_active_grant_v11(cid,p_binding,action); end if;
  end if;

  if op='record_list' then
    if p_input->>'mode' is distinct from 'development_history' then raise exception 'explicit_development_history_mode_required' using errcode='42501'; end if;
    -- A configured Link is required for User history-only grants; full developer
    -- writers can resume their own authorized context without a Dogfood project.
    if not('write'=any(g.actions)) and not exists(select 1 from clued_private.context_links_v11 x where x.grant_id=g.id and x.removed_at is null) then
      raise exception 'context_link_required' using errcode='42501'; end if;
    select coalesce(jsonb_agg(t.envelope order by t.created_cursor,t.id),'[]') into rows from (
      select x.id,x.created_cursor,clued_private.context_visible_record_v11(x.id,g) envelope
      from clued_private.context_records_v11 x where x.context_id=cid and x.created_cursor>cursor_after
    ) t where t.envelope is not null;
    select coalesce(jsonb_agg(value),'[]') into rows from (select value from jsonb_array_elements(rows) limit lim) s;
    return jsonb_build_object('status','ok','records',rows,'next_cursor',case when jsonb_array_length(rows)=lim then rows->(jsonb_array_length(rows)-1)->'created_cursor' else null end,'cache_policy','no-store');
  elsif op='publication_read' then
    select x.* into p from clued_private.context_publication_heads_v11 h join clued_private.context_publications_v11 x on x.id=h.publication_id
      where h.context_id=cid and h.audience='authenticated_owner' and h.channel='canonical_api' and h.environment=c.environment
      and clued_private.context_publication_valid_v11(x.id);
    if not found then raise exception 'publication_unavailable' using errcode='42501'; end if;
    return jsonb_build_object('status','ok','publication',jsonb_build_object('id',p.id,'version',p.version,'payload',p.payload,'payload_hash',p.payload_hash,'environment',p.environment,'channel',p.channel,'audience',p.audience,'delivery_status',p.delivery_status,'created_at',p.created_at),'cache_policy','no-store');
  elsif op='feedback_list' then
    select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'version',x.version,'body',x.body,'selected_evidence',x.selected_evidence,'state',x.state,'response',x.response,'withdrawn_at',x.withdrawn_at) order by x.created_at),'[]') into rows
      from clued_private.context_feedback_v11 x where x.context_id=cid and (x.submitter_binding_id=p_binding or 'feedback_manage'=any(g.actions));
    return jsonb_build_object('status','ok','feedback',rows,'cache_policy','no-store');
  end if;

  if ikey is null or length(ikey) not between 8 and 160 then raise exception 'idempotency_key_required' using errcode='22023'; end if;
  reqhash:=clued_private.context_hash_v11(p_input);
  -- Context-independent owner create operations also need same-key serialization.
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text||binding_ref||op||ikey,0));
  select * into operation from clued_private.context_operations_v11 x where x.owner_id=p_owner and x.binding_ref=binding_ref and x.op=op and x.idempotency_key=ikey;
  if found then
    if operation.request_hash<>reqhash then raise exception 'idempotency_request_mismatch' using errcode='22023'; end if;
    -- Authorization above is current, and replay payload contains no private body.
    return operation.result||jsonb_build_object('replayed',true);
  end if;

  if op='context_create' then
    if length(coalesce(p_input->>'name','')) not between 1 and 160 or not exists(select 1 from public.clued_projects x where x.id=(p_input->>'project_id')::uuid and x.user_id=p_owner) then raise exception 'invalid_owned_project' using errcode='42501'; end if;
    insert into clued_private.context_spaces_v11(owner_id,project_id,name,environment)
      values(p_owner,(p_input->>'project_id')::uuid,p_input->>'name',coalesce(p_input->>'environment','test')) returning * into c;
    cid:=c.id; result:=to_jsonb(c);
  elsif op='grant_upsert' then
    select * into b from public.clued_agent_bindings where id=(p_input->>'binding_id')::uuid and user_id=p_owner and revoked_at is null;
    if not found then raise exception 'owned_binding_required' using errcode='42501'; end if;
    if (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() or to_jsonb(b)->>'organization_id' is not null
      or not('*'=any(b.context_keys) or ('project:'||c.project_id)=any(b.context_keys)) then raise exception 'personal_current_scoped_binding_required' using errcode='42501'; end if;
    select array_agg(value) into actions from jsonb_array_elements_text(p_input->'actions');
    select coalesce(array_agg(value),'{}') into fields from jsonb_array_elements_text(coalesce(p_input->'allowed_fields','["*"]'));
    select coalesce(array_agg(value::uuid),'{}') into selected from jsonb_array_elements_text(coalesce(p_input->'explicit_record_ids','[]'));
    if actions is null or fields is null or cardinality(fields)=0 or p_input->>'expires_at' is null or (p_input->>'expires_at')::timestamptz<=clock_timestamp() then raise exception 'invalid_grant' using errcode='22023'; end if;
    if coalesce(p_input->>'history_policy','')='SINCE_CURSOR' and ((p_input->>'since_cursor') is null or (p_input->>'since_cursor')::bigint<0 or (p_input->>'since_cursor')::bigint>c.cursor) then raise exception 'invalid_since_cursor' using errcode='22023'; end if;
    if p_input->>'history_policy'='EXPLICIT_SET' and (cardinality(selected)=0 or exists(select 1 from unnest(selected) x where not exists(select 1 from clued_private.context_records_v11 y where y.id=x and y.context_id=cid))) then raise exception 'invalid_explicit_record_set' using errcode='22023'; end if;
    if p_input ? 'fixed_versions' then raise exception 'server_fixed_readpoint_required' using errcode='22023'; end if;
    -- Write/accept/publish must see complete latest sources, avoiding blind writes.
    if actions && array['write','accept','publish'] and (p_input->>'history_policy'<>'EXISTING_AND_FUTURE' or p_input->>'version_policy'<>'LATEST' or fields<>array['*']) then raise exception 'full_source_grant_required' using errcode='22023'; end if;
    select * into target_g from clued_private.context_grants_v11 where context_id=cid and binding_id=b.id;
    if found then
      if (p_input->>'grant_id')::uuid is distinct from target_g.id or (p_input->>'base_version')::bigint is distinct from target_g.version then raise exception 'grant_version_conflict' using errcode='40001'; end if;
      update clued_private.context_grants_v11 set actions=actions,history_policy=p_input->>'history_policy',version_policy=p_input->>'version_policy',
        freeze_cursor=c.cursor,since_cursor=(p_input->>'since_cursor')::bigint,explicit_record_ids=selected,allowed_fields=fields,
        expires_at=(p_input->>'expires_at')::timestamptz,revoked_at=null,version=version+1 where id=target_g.id returning * into target_g;
    else
      if p_input ? 'grant_id' then raise exception 'grant_not_found' using errcode='40001'; end if;
      insert into clued_private.context_grants_v11(context_id,binding_id,grantor,actions,history_policy,version_policy,freeze_cursor,since_cursor,explicit_record_ids,allowed_fields,expires_at)
      values(cid,b.id,p_owner,actions,p_input->>'history_policy',p_input->>'version_policy',c.cursor,(p_input->>'since_cursor')::bigint,selected,fields,(p_input->>'expires_at')::timestamptz) returning * into target_g;
    end if; result:=to_jsonb(target_g);
  elsif op='grant_revoke' then
    update clued_private.context_grants_v11 set revoked_at=clock_timestamp(),version=version+1 where id=(p_input->>'grant_id')::uuid and context_id=cid and version=(p_input->>'base_version')::bigint returning * into target_g;
    if not found then raise exception 'grant_version_conflict' using errcode='40001'; end if; result:=to_jsonb(target_g);
  elsif op='link_upsert' then
    if not exists(select 1 from public.clued_projects x where x.id=(p_input->>'project_id')::uuid and x.user_id=p_owner) then raise exception 'owned_project_required' using errcode='42501'; end if;
    select * into target_g from clued_private.context_grants_v11 where id=(p_input->>'grant_id')::uuid and context_id=cid and revoked_at is null and expires_at>clock_timestamp();
    if not found then raise exception 'valid_grant_required' using errcode='42501'; end if;
    select * into l from clued_private.context_links_v11 where project_id=(p_input->>'project_id')::uuid and grant_id=target_g.id;
    if found then
      if l.version is distinct from (p_input->>'base_version')::bigint then raise exception 'link_version_conflict' using errcode='40001'; end if;
      update clued_private.context_links_v11 set removed_at=null,version=version+1 where id=l.id returning * into l;
    else insert into clued_private.context_links_v11(owner_id,project_id,context_id,grant_id) values(p_owner,(p_input->>'project_id')::uuid,cid,target_g.id) returning * into l; end if;
    result:=to_jsonb(l);
  elsif op='link_remove' then
    update clued_private.context_links_v11 set removed_at=clock_timestamp(),version=version+1 where id=(p_input->>'link_id')::uuid and context_id=cid and owner_id=p_owner and version=(p_input->>'base_version')::bigint returning * into l;
    if not found then raise exception 'link_version_conflict' using errcode='40001'; end if; result:=to_jsonb(l);
  elsif op='record_put' then
    if jsonb_typeof(p_input->'body') is distinct from 'object' or coalesce(p_input->>'record_type','') not in ('state','task','decision','note','observation','annotation') then raise exception 'invalid_context_record' using errcode='22023'; end if;
    if p_input->>'record_type'='annotation' and clued_private.context_reference_status_v11(p_input->'body'->'annotation_of',p_binding)<>'current' then
      raise exception 'authorized_exact_annotation_source_required' using errcode='42501'; end if;
    update clued_private.context_spaces_v11 set cursor=cursor+1 where id=cid returning cursor into seq;
    if p_input ? 'record_id' then
      select * into r from clued_private.context_records_v11 where id=(p_input->>'record_id')::uuid and context_id=cid;
      if not found or r.version is distinct from (p_input->>'base_version')::bigint or r.lifecycle_status<>'ACTIVE' or r.record_type<>p_input->>'record_type' then raise exception 'record_version_conflict' using errcode='40001'; end if;
      update clued_private.context_records_v11 set version=version+1,body=p_input->'body',content_hash=clued_private.context_hash_v11(p_input->'body'),
        revision_cursor=seq,recorded_at=clock_timestamp(),actor_binding_id=p_binding,observed_at=(p_input->>'observed_at')::timestamptz,
        valid_until=(p_input->>'valid_until')::timestamptz where id=r.id returning * into r;
    else
      insert into clued_private.context_records_v11(context_id,version,record_type,body,content_hash,observed_at,created_cursor,revision_cursor,actor_binding_id,valid_until)
      values(cid,1,p_input->>'record_type',p_input->'body',clued_private.context_hash_v11(p_input->'body'),(p_input->>'observed_at')::timestamptz,seq,seq,p_binding,(p_input->>'valid_until')::timestamptz) returning * into r;
    end if;
    insert into clued_private.context_record_versions_v11 values(r.id,r.version,cid,r.revision_cursor,to_jsonb(r));
    result:=to_jsonb(r)-'body';
  elsif op='record_revoke' then
    if length(coalesce(p_input->>'reason',''))<1 then raise exception 'revocation_reason_required' using errcode='22023'; end if;
    update clued_private.context_spaces_v11 set cursor=cursor+1 where id=cid returning cursor into seq;
    update clued_private.context_records_v11 set lifecycle_status='REVOKED',reason=p_input->>'reason',version=version+1,revision_cursor=seq,recorded_at=clock_timestamp()
      where id=(p_input->>'record_id')::uuid and context_id=cid and version=(p_input->>'base_version')::bigint returning * into r;
    if not found then raise exception 'record_version_conflict' using errcode='40001'; end if;
    insert into clued_private.context_record_versions_v11 values(r.id,r.version,cid,r.revision_cursor,to_jsonb(r)); result:=to_jsonb(r)-'body'-'reason';
  elsif op='accept' then
    select * into r from clued_private.context_records_v11 where id=(p_input->>'record_id')::uuid and context_id=cid and lifecycle_status='ACTIVE';
    if not found or r.version is distinct from (p_input->>'record_version')::bigint or r.content_hash is distinct from p_input->>'content_hash' then raise exception 'acceptance_source_conflict' using errcode='40001'; end if;
    if r.valid_until<=clock_timestamp() then raise exception 'acceptance_source_stale' using errcode='42501'; end if;
    if jsonb_typeof(p_input->'publication_payload') is distinct from 'object' or p_input->>'audience' is distinct from 'authenticated_owner' or p_input->>'channel' is distinct from 'canonical_api' or p_input->>'environment' is distinct from c.environment then raise exception 'unsupported_publication_scope' using errcode='22023'; end if;
    insert into clued_private.context_acceptances_v11(context_id,record_id,record_version,content_hash,publication_payload,payload_hash,audience,channel,environment,actor_binding_id,grant_id,grant_version)
      values(cid,r.id,r.version,r.content_hash,p_input->'publication_payload',clued_private.context_hash_v11(p_input->'publication_payload'),p_input->>'audience',p_input->>'channel',c.environment,p_binding,g.id,g.version) returning * into a;
    result:=to_jsonb(a)-'publication_payload';
  elsif op='publish' then
    select x.* into a from clued_private.context_acceptances_v11 x
      join clued_private.context_records_v11 y on y.id=x.record_id and y.version=x.record_version and y.content_hash=x.content_hash and y.lifecycle_status='ACTIVE' and (y.valid_until is null or y.valid_until>clock_timestamp())
      join clued_private.context_grants_v11 z on z.id=x.grant_id and z.version=x.grant_version and z.revoked_at is null and z.expires_at>clock_timestamp()
      join public.clued_agent_bindings ab on ab.id=x.actor_binding_id and ab.revoked_at is null
      where x.id=(p_input->>'acceptance_id')::uuid and x.context_id=cid and x.status='ACCEPTED'
      and (to_jsonb(ab)->>'expires_at' is null or (to_jsonb(ab)->>'expires_at')::timestamptz>clock_timestamp());
    if not found then raise exception 'acceptance_invalidated' using errcode='42501'; end if;
    if a.payload_hash is distinct from clued_private.context_hash_v11(p_input->'payload') or a.audience is distinct from p_input->>'audience' or a.channel is distinct from p_input->>'channel' or a.environment is distinct from p_input->>'environment' then raise exception 'publication_approval_mismatch' using errcode='42501'; end if;
    if not(p_input ? 'expected_current') then raise exception 'expected_current_required' using errcode='22023'; end if;
    select publication_id into old_head from clued_private.context_publication_heads_v11 where context_id=cid and audience=a.audience and channel=a.channel and environment=a.environment;
    if old_head is distinct from (p_input->>'expected_current')::uuid then raise exception 'publication_current_conflict' using errcode='40001'; end if;
    insert into clued_private.context_publications_v11(context_id,acceptance_id,payload,payload_hash,audience,channel,environment,actor_binding_id,grant_id,grant_version,previous_id)
      values(cid,a.id,a.publication_payload,a.payload_hash,a.audience,a.channel,a.environment,p_binding,g.id,g.version,old_head) returning * into p;
    result:=to_jsonb(p)-'payload';
  elsif op='publication_deliver' then
    select * into p from clued_private.context_publications_v11 where id=(p_input->>'publication_id')::uuid and context_id=cid;
    if not found or p.version is distinct from (p_input->>'base_version')::bigint or p.delivery_status<>'PENDING' or p.visibility<>'UNPUBLISHED' then raise exception 'publication_version_conflict' using errcode='40001'; end if;
    select x.* into a from clued_private.context_acceptances_v11 x
      join clued_private.context_records_v11 y on y.id=x.record_id and y.version=x.record_version and y.content_hash=x.content_hash and y.lifecycle_status='ACTIVE' and (y.valid_until is null or y.valid_until>clock_timestamp())
      join clued_private.context_grants_v11 z on z.id=x.grant_id and z.version=x.grant_version and z.revoked_at is null and z.expires_at>clock_timestamp()
      join public.clued_agent_bindings ab on ab.id=x.actor_binding_id and ab.revoked_at is null
      where x.id=p.acceptance_id and x.context_id=cid and x.status='ACCEPTED'
        and (to_jsonb(ab)->>'expires_at' is null or (to_jsonb(ab)->>'expires_at')::timestamptz>clock_timestamp());
    if not found or p.grant_id<>g.id or p.grant_version<>g.version then raise exception 'publication_authorization_invalidated' using errcode='42501'; end if;
    -- This required consumer is the same DB-backed canonical_api. Re-read its
    -- staged exact bytes and approval in the delivery transaction before switch.
    if p.payload_hash<>clued_private.context_hash_v11(p.payload) or a.payload_hash<>p.payload_hash or a.publication_payload<>p.payload
      or a.environment<>p.environment or a.audience<>p.audience or a.channel<>p.channel then raise exception 'staged_payload_mismatch' using errcode='42501'; end if;
    if not(p_input ? 'expected_current') then raise exception 'expected_current_required' using errcode='22023'; end if;
    select publication_id into old_head from clued_private.context_publication_heads_v11 where context_id=cid and audience=p.audience and channel=p.channel and environment=p.environment;
    if old_head is distinct from (p_input->>'expected_current')::uuid or old_head is distinct from p.previous_id then raise exception 'publication_current_conflict' using errcode='40001'; end if;
    update clued_private.context_publications_v11 set visibility='PUBLISHED',delivery_status='VERIFIED',version=version+1 where id=p.id returning * into p;
    insert into clued_private.context_publication_heads_v11 values(cid,p.audience,p.channel,p.environment,p.id)
      on conflict(context_id,audience,channel,environment) do update set publication_id=excluded.publication_id;
    result:=to_jsonb(p)-'payload';
  elsif op='publication_withdraw' then
    update clued_private.context_publications_v11 set visibility='WITHDRAWN',withdrawn_at=clock_timestamp(),version=version+1
      where id=(p_input->>'publication_id')::uuid and context_id=cid and version=(p_input->>'base_version')::bigint returning * into p;
    if not found then raise exception 'publication_version_conflict' using errcode='40001'; end if;
    update clued_private.context_publication_heads_v11 set publication_id=null where context_id=cid and publication_id=p.id;
    result:=to_jsonb(p)-'payload';
  elsif op='feedback_submit' then
    if jsonb_typeof(p_input->'body') is distinct from 'object' or jsonb_typeof(coalesce(p_input->'selected_evidence','[]'))<>'array' then raise exception 'invalid_feedback' using errcode='22023'; end if;
    insert into clued_private.context_feedback_v11(context_id,submitter_binding_id,body,selected_evidence,source_ref)
      values(cid,p_binding,p_input->'body',coalesce(p_input->'selected_evidence','[]'),p_input->'source_ref') returning * into f;
    result:=to_jsonb(f)-'body'-'selected_evidence'-'source_ref';
  elsif op in ('feedback_update','feedback_withdraw') then
    select * into f from clued_private.context_feedback_v11 where id=(p_input->>'feedback_id')::uuid and context_id=cid;
    if not found or f.version is distinct from (p_input->>'base_version')::bigint then raise exception 'feedback_version_conflict' using errcode='40001'; end if;
    if op='feedback_withdraw' then
      if f.submitter_binding_id<>p_binding then raise exception 'feedback_submitter_required' using errcode='42501'; end if;
      update clued_private.context_feedback_v11 set state='withdrawn',body='{}',selected_evidence='[]',source_ref=null,response=null,withdrawn_at=clock_timestamp(),version=version+1 where id=f.id returning * into f;
    else
      if f.withdrawn_at is not null or coalesce(p_input->>'state','') not in ('triaged','duplicate','needs_evidence','unreproducible','candidate','closed','resolved') or jsonb_typeof(p_input->'response') is distinct from 'object' then raise exception 'invalid_feedback_transition' using errcode='22023'; end if;
      update clued_private.context_feedback_v11 set state=p_input->>'state',response=p_input->'response',version=version+1 where id=f.id returning * into f;
    end if;
    result:=to_jsonb(f)-'body'-'selected_evidence'-'source_ref'-'response';
  end if;
  if result is null then raise exception 'unsupported_context_operation' using errcode='22023'; end if;
  insert into clued_private.context_operations_v11(owner_id,binding_ref,context_id,op,idempotency_key,request_hash,canonical_version,result)
    values(p_owner,binding_ref,cid,op,ikey,reqhash,nextval('clued_private.canonical_version_seq'),'{}') returning * into operation;
  result:=jsonb_build_object('status','committed','operation_id',operation.id,'receipt_id',operation.receipt_id,'event_id',operation.event_id,'canonical_version',operation.canonical_version,'result',result,'replayed',false,
    'receipt',jsonb_build_object('id',operation.receipt_id,'operation_id',operation.id,'status','committed','request_hash',reqhash,'canonical_version',operation.canonical_version),
    'event',jsonb_build_object('id',operation.event_id,'operation_id',operation.id,'receipt_id',operation.receipt_id,'event_type',op,'context_id',cid,'canonical_version',operation.canonical_version));
  update clued_private.context_operations_v11 set result=result where id=operation.id;
  return result;
end $$;

-- Public wrappers retain caller identity; private dispatch cannot be invoked by
-- anon/authenticated directly. No service-role fallback or Skill-supplied roles.
create function public.clued_context_call(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_binding' using errcode='28000'; end if;
  select * into b from public.clued_agent_bindings where token_hash=p_token_hash and revoked_at is null and oauth_client_id is null;
  if not found then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  return clued_private.context_execute_v11(b.user_id,b.id,false,p_input);
end $$;
create function public.clued_context_oauth_call(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; client text:=nullif(auth.jwt()->>'client_id','');
begin
  if auth.uid() is null or client is null then raise exception 'oauth_binding_required' using errcode='28000'; end if;
  select * into b from public.clued_agent_bindings where user_id=auth.uid() and oauth_client_id=client and revoked_at is null;
  if not found then raise exception 'existing_oauth_binding_required' using errcode='42501'; end if;
  return clued_private.context_execute_v11(b.user_id,b.id,false,p_input);
end $$;
create function public.clued_context_owner(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or nullif(auth.jwt()->>'client_id','') is not null then raise exception 'direct_owner_session_required' using errcode='42501'; end if;
  return clued_private.context_execute_v11(auth.uid(),null,true,p_input);
end $$;

do $$ declare obj record; begin
  for obj in select tablename from pg_tables where schemaname='clued_private' and tablename like 'context_%_v11' loop
    execute format('alter table clued_private.%I enable row level security',obj.tablename);
    execute format('revoke all on table clued_private.%I from public,anon,authenticated,service_role',obj.tablename);
  end loop;
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='clued_private' and p.proname like 'context_%_v11' loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',obj.signature);
  end loop;
end $$;
revoke all on function public.clued_context_call(text,jsonb),public.clued_context_oauth_call(jsonb),public.clued_context_owner(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_context_call(text,jsonb) to anon,authenticated;
grant execute on function public.clued_context_oauth_call(jsonb),public.clued_context_owner(jsonb) to authenticated;
