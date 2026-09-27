-- Candidate only. No seeds, secrets, automatic grants or production activation.
-- Storage grants extend existing OAuth Bindings; they are not device identities.
create table clued_private.storage_connections_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  profile_id uuid not null references clued_private.resource_center_profiles_v1(id),
  profile_version bigint not null,
  source_decision_id uuid not null references public.clued_memories(id),
  decision_version bigint not null,
  provider text not null check(provider='google-drive'),
  provider_subject text,
  oauth_client_id text,
  state text not null default 'awaiting_provider' check(state in ('awaiting_provider','active','reauthorization_required','revoked')),
  version bigint not null default 1,
  credential_version bigint not null default 0,
  credential_envelope jsonb,
  revoked_at timestamptz,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  check ((state='revoked')=(revoked_at is not null)),
  check (state<>'active' or (provider_subject is not null and oauth_client_id is not null and credential_envelope is not null and credential_version>0))
);
create unique index storage_connection_profile_live_v1 on clued_private.storage_connections_v1(profile_id) where revoked_at is null;
create index storage_connection_owner_v1 on clued_private.storage_connections_v1(owner_id);
create table clued_private.storage_client_grants_v1 (
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  binding_id uuid not null references clued_private.authorizations_v12(binding_id),
  authorization_version bigint not null,
  actions text[] not null check(cardinality(actions)>0 and actions <@ array['inspect','create_file','create_topic']::text[]),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  primary key(connection_id,binding_id)
);
create index storage_client_grants_binding_v1 on clued_private.storage_client_grants_v1(binding_id);
alter table clued_private.storage_connections_v1 enable row level security;
alter table clued_private.storage_client_grants_v1 enable row level security;
revoke all on clued_private.storage_connections_v1,clued_private.storage_client_grants_v1 from public,anon,authenticated,service_role;

-- Sensitive owner actions require the live native session, not just an unexpired
-- JWT. Never apply this check to an independently approved background delegation.
create function clued_private.storage_owner_v1() returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.authorization_owner_v12(); sid uuid;
begin
  begin sid:=(auth.jwt()->>'session_id')::uuid; exception when invalid_text_representation then
    raise exception 'storage_native_session_required' using errcode='42501'; end;
  if sid is null then raise exception 'storage_native_session_required' using errcode='42501'; end if;
  perform 1 from auth.sessions s where s.id=sid and s.user_id=u
    and ((to_jsonb(s)->>'not_after') is null or (to_jsonb(s)->>'not_after')::timestamptz>clock_timestamp()) for share;
  if not found then raise exception 'storage_native_session_required' using errcode='42501'; end if;
  return u;
end $$;
revoke all on function clued_private.storage_owner_v1() from public,anon,authenticated,service_role;

create function clued_private.storage_connection_current_v1(p_connection uuid,p_owner uuid)
returns clued_private.storage_connections_v1 language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
begin
  perform clued_private.authorization_account_v12(p_owner);
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=p_owner for share;
  if not found or c.state<>'active' or c.revoked_at is not null then
    raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner for share;
  if not found or p.state<>'active' or p.version<>c.profile_version then
    raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
  perform 1 from public.clued_memories where id in (c.source_decision_id,p.source_decision_id) order by id for share;
  if not exists(select 1 from public.clued_memories where id=c.source_decision_id and version=c.decision_version)
    or not clued_private.resource_center_decision_current_v1(p.user_id,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(p.user_id,p.project_id,p.source_decision_id) then
    raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
  return c;
end $$;
revoke all on function clued_private.storage_connection_current_v1(uuid,uuid) from public,anon,authenticated,service_role;

-- Used only inside a subsequent mutation transaction. Never an exposed proof.
-- Lock order: Binding -> v12 authorization -> account -> connection -> grant ->
-- profile -> Decision. Existing OAuth revoke/reduce take the first two locks.
create function clued_private.storage_binding_v1(p_hash text,p_connection uuid,p_action text)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
  c clued_private.storage_connections_v1; g clued_private.storage_client_grants_v1;
begin
  if coalesce(p_hash,'') !~ '^[0-9a-f]{64}$' or coalesce(p_action,'') not in ('inspect','create_file','create_topic') then
    raise exception 'storage_binding_denied' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where token_hash=p_hash for share;
  if not found or b.revoked_at is not null or (b.expires_at is not null and b.expires_at<=clock_timestamp()) then
    raise exception 'storage_binding_denied' using errcode='42501'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=b.user_id for share;
  if not found or a.revoked_at is not null or a.expires_at<=clock_timestamp() then
    raise exception 'storage_binding_denied' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(b.user_id);
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=b.user_id for share;
  if not found then raise exception 'storage_binding_denied' using errcode='42501'; end if;
  select * into g from clued_private.storage_client_grants_v1 where connection_id=c.id and binding_id=b.id for share;
  if not found or g.revoked_at is not null or g.expires_at<=clock_timestamp() or g.authorization_version<>a.version
    or not(p_action=any(g.actions)) then raise exception 'storage_binding_denied' using errcode='42501'; end if;
  perform clued_private.storage_connection_current_v1(c.id,b.user_id);
  if least(b.expires_at,a.expires_at,g.expires_at)<=clock_timestamp() then
    raise exception 'storage_binding_denied' using errcode='42501'; end if;
  return b;
end $$;
revoke all on function clued_private.storage_binding_v1(text,uuid,text) from public,anon,authenticated,service_role;

create function public.clued_storage_account_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  a clued_private.authorizations_v12; b public.clued_agent_bindings;
  r public.clued_audit_receipts; refs jsonb; ev text; actions text[]; expiry timestamptz;
  d uuid; dv bigint; summary jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'storage_input_invalid' using errcode='22023'; end if;
  if op='list' and p_input=jsonb_build_object('action','list') then
    return jsonb_build_object('connections',coalesce((select jsonb_agg(jsonb_build_object(
      'id',x.id,'profile_id',x.profile_id,'provider',x.provider,'state',x.state,'version',x.version,
      'credential_version',x.credential_version,'revoked_at',x.revoked_at,'receipt_id',x.receipt_id))
      from clued_private.storage_connections_v1 x where x.owner_id=u),'[]'::jsonb));
  end if;
  if coalesce(op,'') not in ('register','grant_client','revoke_client','revoke_connection') or
    coalesce(length(p_input->>'idempotency_key'),0) not between 1 and 160 then
    raise exception 'storage_input_invalid' using errcode='22023'; end if;
  if op='register' then
    if (p_input-array['action','idempotency_key','profile_id','source_decision_id'])<>'{}'::jsonb then
      raise exception 'storage_input_invalid' using errcode='22023'; end if;
    select * into p from clued_private.resource_center_profiles_v1 where id=(p_input->>'profile_id')::uuid and user_id=u for share;
    d:=(p_input->>'source_decision_id')::uuid;
    if not found or p.state<>'active' then raise exception 'storage_registration_denied' using errcode='42501'; end if;
    perform 1 from public.clued_memories where id in (d,p.source_decision_id) order by id for share;
    if not clued_private.resource_center_decision_current_v1(u,p.project_id,d)
      or not clued_private.resource_center_decision_current_v1(u,p.project_id,p.source_decision_id) then
      raise exception 'storage_registration_denied' using errcode='42501'; end if;
    select version into dv from public.clued_memories where id=d for share;
  else
    if op in ('grant_client','revoke_client') then
      if (p_input-array['action','idempotency_key','connection_id','base_version','binding_id','authorization_version','actions','expires_at'])<>'{}'::jsonb then
        raise exception 'storage_input_invalid' using errcode='22023'; end if;
      select * into b from public.clued_agent_bindings where id=(p_input->>'binding_id')::uuid and user_id=u for share;
      if not found then raise exception 'storage_binding_denied' using errcode='42501'; end if;
      select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=u for share;
      if not found then raise exception 'storage_binding_denied' using errcode='42501'; end if;
    elsif (p_input-array['action','idempotency_key','connection_id','base_version'])<>'{}'::jsonb then
      raise exception 'storage_input_invalid' using errcode='22023';
    end if;
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for update;
    if not found then raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
  end if;
  r:=clued_private.m1_begin_receipt(u,null,'storage_account_'||op,p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then return r.canonical_result; end if;
  if op='register' then
    insert into clued_private.storage_connections_v1(owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,receipt_id)
      values(u,p.id,p.version,d,dv,'google-drive',r.id) returning * into c;
  else
    if c.version is distinct from (p_input->>'base_version')::bigint then raise exception 'storage_version_conflict' using errcode='40001'; end if;
    if op='grant_client' then
      perform clued_private.storage_connection_current_v1(c.id,u);
      if b.revoked_at is not null or a.revoked_at is not null or (b.expires_at is not null and b.expires_at<=clock_timestamp())
        or a.expires_at<=clock_timestamp() or a.version is distinct from (p_input->>'authorization_version')::bigint then
        raise exception 'storage_binding_denied' using errcode='42501'; end if;
      if jsonb_typeof(p_input->'actions') is distinct from 'array' then raise exception 'storage_input_invalid' using errcode='22023'; end if;
      select array_agg(distinct value order by value) into actions from jsonb_array_elements_text(p_input->'actions');
      expiry:=(p_input->>'expires_at')::timestamptz;
      if actions is null or not(actions <@ array['inspect','create_file','create_topic']::text[]) or expiry is null
        or expiry<=clock_timestamp() or expiry>least(b.expires_at,a.expires_at) then
        raise exception 'storage_binding_denied' using errcode='42501'; end if;
      insert into clued_private.storage_client_grants_v1(connection_id,binding_id,authorization_version,actions,expires_at,receipt_id)
        values(c.id,b.id,a.version,actions,expiry,r.id)
        on conflict(connection_id,binding_id) do update set authorization_version=excluded.authorization_version,
          actions=excluded.actions,expires_at=excluded.expires_at,revoked_at=null,receipt_id=excluded.receipt_id;
    elsif op='revoke_client' then
      update clued_private.storage_client_grants_v1 set revoked_at=coalesce(revoked_at,clock_timestamp()),receipt_id=r.id
        where connection_id=c.id and binding_id=b.id;
    else
      update clued_private.storage_connections_v1 set state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()) where id=c.id;
    end if;
    update clued_private.storage_connections_v1 set version=version+1,receipt_id=r.id where id=c.id returning * into c;
  end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
  summary:=jsonb_build_object('connection_id',c.id,'version',c.version,'state',c.state);
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:account_'||op,
    refs,'project:'||p.project_id::text,null,summary,p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  summary:=clued_private.m1_finish_receipt(r.id,'committed',refs,
    case when op='register' then '{}'::jsonb else jsonb_build_object(c.id::text,(p_input->>'base_version')::bigint) end,
    jsonb_build_object(c.id::text,c.version),array[ev],'{}'::uuid[],null);
  -- All writes and their Receipt are in this transaction. A session that expired
  -- during ANY lock wait must roll them back, even if its row still exists.
  perform clued_private.storage_owner_v1();
  return summary;
end $$;
revoke all on function public.clued_storage_account_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_account_v1(jsonb) to authenticated;
