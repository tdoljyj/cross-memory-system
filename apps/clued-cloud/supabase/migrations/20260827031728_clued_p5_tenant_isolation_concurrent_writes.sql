-- Clued P5 tenant isolation, fresh authorization, and concurrent canonical writes.
-- Additive to M1. Existing personal rows remain readable through the legacy owner
-- policy; P5 rows are always bound to organization + workspace and are writable
-- only through the authenticated service contract below.

create table if not exists public.clued_organizations (
  id uuid primary key default gen_random_uuid(),
  tenant_key text not null unique check (tenant_key ~ '^[a-z0-9][a-z0-9_-]{2,79}$'),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  policy_version bigint not null default 1 check (policy_version > 0),
  revocation_epoch bigint not null default 1 check (revocation_epoch > 0),
  status text not null default 'active' check (status in ('active','suspended','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clued_workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.clued_organizations(id) on delete restrict,
  workspace_key text not null check (workspace_key ~ '^[a-z0-9][a-z0-9_-]{2,79}$'),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  policy_version bigint not null default 1 check (policy_version > 0),
  revocation_epoch bigint not null default 1 check (revocation_epoch > 0),
  status text not null default 'active' check (status in ('active','suspended','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, workspace_key),
  unique (organization_id, id)
);

create table if not exists public.clued_workspace_memberships (
  organization_id uuid not null references public.clued_organizations(id) on delete restrict,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor','reader','denied')),
  scopes text[] not null default '{}'::text[],
  purposes text[] not null default '{}'::text[],
  policy_version bigint not null default 1 check (policy_version > 0),
  revocation_epoch bigint not null default 1 check (revocation_epoch > 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, workspace_id, user_id),
  foreign key (organization_id, workspace_id)
    references public.clued_workspaces(organization_id, id) on delete restrict,
  constraint clued_workspace_memberships_scopes_check check (
    cardinality(scopes) between 1 and 32 and array_position(scopes, null) is null
  ),
  constraint clued_workspace_memberships_purposes_check check (
    cardinality(purposes) between 1 and 32 and array_position(purposes, null) is null
  )
);

alter table public.clued_agent_bindings
  add column if not exists organization_id uuid references public.clued_organizations(id) on delete restrict,
  add column if not exists workspace_id uuid,
  add column if not exists active_context_key text,
  add column if not exists role text,
  add column if not exists purpose text,
  add column if not exists policy_version bigint,
  add column if not exists revocation_epoch bigint,
  add column if not exists expires_at timestamptz,
  add column if not exists actor_kind text;

alter table public.clued_agent_bindings
  drop constraint if exists clued_agent_bindings_scopes_check;
alter table public.clued_agent_bindings
  add constraint clued_agent_bindings_scopes_check check (
    scopes <@ array[
      'context:read','context:write','audit:read',
      'canonical:read','canonical:write','project:read','project:write'
    ]::text[] and cardinality(scopes) > 0
  );
alter table public.clued_agent_bindings
  add constraint clued_agent_bindings_p5_role_check check (
    role is null or role in ('owner','admin','editor','reader','denied')
  ) not valid;
alter table public.clued_agent_bindings
  add constraint clued_agent_bindings_p5_actor_check check (
    actor_kind is null or actor_kind in ('user','agent_binding','service_account','automation')
  ) not valid;
alter table public.clued_agent_bindings
  add constraint clued_agent_bindings_p5_shape_check check (
    organization_id is null or (
      workspace_id is not null and active_context_key is not null and role is not null
      and purpose is not null and policy_version > 0 and revocation_epoch > 0
      and expires_at is not null and actor_kind is not null
    )
  ) not valid;
alter table public.clued_agent_bindings
  add constraint clued_agent_bindings_p5_workspace_fkey
  foreign key (organization_id, workspace_id)
  references public.clued_workspaces(organization_id, id) on delete restrict not valid;

alter table public.clued_continuity_sessions
  add column if not exists organization_id uuid references public.clued_organizations(id) on delete restrict,
  add column if not exists workspace_id uuid,
  add column if not exists purpose text,
  add column if not exists policy_version bigint,
  add column if not exists revocation_epoch bigint,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_reason text;
alter table public.clued_continuity_sessions
  add constraint clued_continuity_sessions_p5_workspace_fkey
  foreign key (organization_id, workspace_id)
  references public.clued_workspaces(organization_id, id) on delete restrict not valid;

alter table public.clued_memories
  add column if not exists organization_id uuid references public.clued_organizations(id) on delete restrict,
  add column if not exists workspace_id uuid,
  add column if not exists p5_visibility text;
alter table public.clued_memories
  add constraint clued_memories_p5_workspace_fkey
  foreign key (organization_id, workspace_id)
  references public.clued_workspaces(organization_id, id) on delete restrict not valid;
alter table public.clued_memories
  add constraint clued_memories_p5_visibility_check check (
    (organization_id is null and workspace_id is null and p5_visibility is null)
    or (organization_id is not null and workspace_id is not null and p5_visibility in ('private','workspace'))
  ) not valid;

alter table public.clued_projects
  add column if not exists organization_id uuid references public.clued_organizations(id) on delete restrict,
  add column if not exists workspace_id uuid,
  add column if not exists p5_visibility text;
alter table public.clued_projects
  add constraint clued_projects_p5_workspace_fkey
  foreign key (organization_id, workspace_id)
  references public.clued_workspaces(organization_id, id) on delete restrict not valid;
alter table public.clued_projects
  add constraint clued_projects_p5_visibility_check check (
    (organization_id is null and workspace_id is null and p5_visibility is null)
    or (organization_id is not null and workspace_id is not null and p5_visibility in ('private','workspace'))
  ) not valid;

create table if not exists public.clued_p5_idempotency (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  binding_id uuid not null references public.clued_agent_bindings(id) on delete restrict,
  operation_family text not null check (char_length(operation_family) between 1 and 80),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending','committed','rejected','failed')),
  canonical_result jsonb,
  receipt_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (organization_id, workspace_id, binding_id, operation_family, idempotency_key),
  foreign key (organization_id, workspace_id)
    references public.clued_workspaces(organization_id, id) on delete restrict
);

create table if not exists public.clued_p5_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  user_actor_id uuid not null references auth.users(id) on delete restrict,
  binding_actor_id uuid not null references public.clued_agent_bindings(id) on delete restrict,
  actor_kind text not null check (actor_kind in ('user','agent_binding','service_account','automation')),
  event_type text not null check (char_length(event_type) between 1 and 96),
  target_kind text not null check (target_kind in ('record','project')),
  target_id uuid not null,
  base_version bigint not null check (base_version > 0),
  new_version bigint not null check (new_version = base_version + 1),
  idempotency_id uuid not null unique references public.clued_p5_idempotency(id) on delete restrict,
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references public.clued_workspaces(organization_id, id) on delete restrict
);

create table if not exists public.clued_p5_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  user_actor_id uuid not null references auth.users(id) on delete restrict,
  binding_actor_id uuid not null references public.clued_agent_bindings(id) on delete restrict,
  actor_kind text not null check (actor_kind in ('user','agent_binding','service_account','automation')),
  idempotency_id uuid references public.clued_p5_idempotency(id) on delete restrict,
  status text not null check (status in ('committed','rejected','failed')),
  target_kind text check (target_kind is null or target_kind in ('record','project')),
  target_id uuid,
  base_version bigint,
  new_version bigint,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  event_id uuid references public.clued_p5_events(id) on delete restrict,
  error_type text,
  evidence jsonb not null,
  canonical_result jsonb,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references public.clued_workspaces(organization_id, id) on delete restrict
);
create unique index if not exists clued_p5_receipts_idempotency_uidx
  on public.clued_p5_receipts(idempotency_id) where idempotency_id is not null;

create table if not exists public.clued_p5_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  actor_kind text not null check (actor_kind in ('user','agent_binding','service_account','automation')),
  user_actor_id uuid references auth.users(id) on delete restrict,
  binding_actor_id uuid references public.clued_agent_bindings(id) on delete restrict,
  service_account_actor text,
  automation_actor text,
  target_kind text,
  target_id uuid,
  context_key text not null,
  role text not null,
  scope text not null,
  purpose text not null,
  policy_version bigint not null,
  revocation_epoch bigint not null,
  base_version bigint,
  new_version bigint,
  result text not null check (result in ('committed','replayed','rejected','failed','pending')),
  evidence jsonb not null,
  error_type text,
  receipt_id uuid references public.clued_p5_receipts(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references public.clued_workspaces(organization_id, id) on delete restrict
);

create table if not exists public.clued_pending_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  binding_id uuid not null references public.clued_agent_bindings(id) on delete restrict,
  context_key text not null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  encrypted_intent_ref text not null check (char_length(encrypted_intent_ref) between 1 and 1000),
  status text not null default 'pending' check (status = 'pending'),
  created_at timestamptz not null default now(),
  unique (organization_id, workspace_id, binding_id, idempotency_key),
  foreign key (organization_id, workspace_id)
    references public.clued_workspaces(organization_id, id) on delete restrict
);

create index if not exists clued_p5_audit_target_idx
  on public.clued_p5_audit_events(organization_id, workspace_id, target_kind, target_id, created_at);
create index if not exists clued_p5_sessions_fresh_idx
  on public.clued_continuity_sessions(binding_id, organization_id, workspace_id, context_key, expires_at)
  where ended_at is null and revoked_at is null;

create or replace function clued_private.p5_immutable_row()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'P5_IMMUTABLE_ROW' using errcode='55000';
end $$;

drop trigger if exists clued_p5_events_immutable on public.clued_p5_events;
create trigger clued_p5_events_immutable before update or delete on public.clued_p5_events
for each row execute function clued_private.p5_immutable_row();
alter table public.clued_p5_events enable always trigger clued_p5_events_immutable;
drop trigger if exists clued_p5_receipts_immutable on public.clued_p5_receipts;
create trigger clued_p5_receipts_immutable before update or delete on public.clued_p5_receipts
for each row execute function clued_private.p5_immutable_row();
alter table public.clued_p5_receipts enable always trigger clued_p5_receipts_immutable;
drop trigger if exists clued_p5_audit_immutable on public.clued_p5_audit_events;
create trigger clued_p5_audit_immutable before update or delete on public.clued_p5_audit_events
for each row execute function clued_private.p5_immutable_row();
alter table public.clued_p5_audit_events enable always trigger clued_p5_audit_immutable;

create or replace function clued_private.p5_sha256(p_value jsonb)
returns text language sql immutable strict set search_path='' as $$
  select encode(extensions.digest(convert_to(p_value::text,'UTF8'),'sha256'),'hex')
$$;

create or replace function clued_private.p5_effective_policy(
  p_org_policy bigint,p_workspace_policy bigint,p_member_policy bigint,p_binding_policy bigint
) returns bigint language sql immutable strict set search_path='' as $$
  select greatest(p_org_policy,p_workspace_policy,p_member_policy,p_binding_policy)
$$;

create or replace function clued_private.p5_effective_epoch(
  p_org_epoch bigint,p_workspace_epoch bigint,p_member_epoch bigint,p_binding_epoch bigint
) returns bigint language sql immutable strict set search_path='' as $$
  select greatest(p_org_epoch,p_workspace_epoch,p_member_epoch,p_binding_epoch)
$$;

create or replace function clued_private.p5_resolve_binding(
  p_token_hash text,p_input jsonb,p_required_scope text
) returns table(
  binding_id uuid,user_id uuid,organization_id uuid,workspace_id uuid,
  context_key text,role text,purpose text,policy_version bigint,
  revocation_epoch bigint,actor_kind text
) language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_org public.clued_organizations%rowtype;
  v_workspace public.clued_workspaces%rowtype;
  v_member public.clued_workspace_memberships%rowtype;
  v_org_id uuid; v_workspace_id uuid; v_policy bigint; v_epoch bigint;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'P5_INVALID_BINDING_TOKEN' using errcode='28000';
  end if;
  begin
    v_org_id := (p_input->>'organization_id')::uuid;
    v_workspace_id := (p_input->>'workspace_id')::uuid;
  exception when others then
    raise exception 'P5_INVALID_TENANT_CONTEXT' using errcode='22023';
  end;
  select * into v_binding from public.clued_agent_bindings b where b.token_hash=p_token_hash;
  if not found then raise exception 'P5_BINDING_NOT_FOUND' using errcode='42501'; end if;
  if v_binding.revoked_at is not null then raise exception 'P5_BINDING_REVOKED' using errcode='42501'; end if;
  if v_binding.expires_at is null or v_binding.expires_at<=now() then raise exception 'P5_BINDING_EXPIRED' using errcode='42501'; end if;
  if v_binding.organization_id is distinct from v_org_id or v_binding.workspace_id is distinct from v_workspace_id then
    raise exception 'P5_TENANT_WORKSPACE_DENIED' using errcode='42501';
  end if;
  if v_binding.active_context_key is distinct from p_input->>'context_key'
     or not (v_binding.active_context_key=any(v_binding.context_keys) or '*'=any(v_binding.context_keys)) then
    raise exception 'P5_CONTEXT_INVALIDATED' using errcode='42501';
  end if;
  if v_binding.role is distinct from p_input->>'role' then raise exception 'P5_ROLE_CHANGED' using errcode='42501'; end if;
  if v_binding.purpose is distinct from p_input->>'purpose' then raise exception 'P5_PURPOSE_DENIED' using errcode='42501'; end if;
  if p_input->>'scope' is distinct from p_required_scope or not p_required_scope=any(v_binding.scopes) then
    raise exception 'P5_SCOPE_DENIED' using errcode='42501';
  end if;
  select * into v_org from public.clued_organizations o where o.id=v_org_id and o.status='active';
  if not found then raise exception 'P5_ORGANIZATION_INACTIVE' using errcode='42501'; end if;
  select * into v_workspace from public.clued_workspaces w
   where w.id=v_workspace_id and w.organization_id=v_org_id and w.status='active';
  if not found then raise exception 'P5_WORKSPACE_INACTIVE' using errcode='42501'; end if;
  select * into v_member from public.clued_workspace_memberships m
   where m.organization_id=v_org_id and m.workspace_id=v_workspace_id and m.user_id=v_binding.user_id;
  if not found or v_member.revoked_at is not null or (v_member.expires_at is not null and v_member.expires_at<=now()) then
    raise exception 'P5_MEMBERSHIP_REVOKED' using errcode='42501';
  end if;
  if v_member.role is distinct from v_binding.role or v_member.role is distinct from p_input->>'role' then
    raise exception 'P5_ROLE_CHANGED' using errcode='42501';
  end if;
  if v_member.role in ('reader','denied') and p_required_scope in ('canonical:write','project:write') then
    raise exception 'P5_ROLE_WRITE_DENIED' using errcode='42501';
  end if;
  if not p_required_scope=any(v_member.scopes) then raise exception 'P5_SCOPE_DENIED' using errcode='42501'; end if;
  if not v_binding.purpose=any(v_member.purposes) then raise exception 'P5_PURPOSE_DENIED' using errcode='42501'; end if;
  v_policy:=clued_private.p5_effective_policy(v_org.policy_version,v_workspace.policy_version,v_member.policy_version,v_binding.policy_version);
  v_epoch:=clued_private.p5_effective_epoch(v_org.revocation_epoch,v_workspace.revocation_epoch,v_member.revocation_epoch,v_binding.revocation_epoch);
  if coalesce((p_input->>'policy_version')::bigint,0)<>v_policy then raise exception 'P5_POLICY_VERSION_CHANGED' using errcode='42501'; end if;
  if coalesce((p_input->>'revocation_epoch')::bigint,0)<>v_epoch then raise exception 'P5_REVOCATION_EPOCH_CHANGED' using errcode='42501'; end if;
  return query select v_binding.id,v_binding.user_id,v_org_id,v_workspace_id,
    v_binding.active_context_key,v_binding.role,v_binding.purpose,v_policy,v_epoch,v_binding.actor_kind;
end $$;

create or replace function clued_private.p5_resolve_request(
  p_token_hash text,p_input jsonb,p_required_scope text
) returns table(
  binding_id uuid,user_id uuid,organization_id uuid,workspace_id uuid,
  context_key text,role text,purpose text,policy_version bigint,
  revocation_epoch bigint,actor_kind text,session_id uuid
) language plpgsql security definer set search_path='' as $$
declare v record; v_session public.clued_continuity_sessions%rowtype; v_session_hash text;
begin
  select * into v from clued_private.p5_resolve_binding(p_token_hash,p_input,p_required_scope);
  if nullif(p_input->>'session_token','') is null then raise exception 'P5_SESSION_REQUIRED' using errcode='42501'; end if;
  v_session_hash:=encode(extensions.digest(convert_to(p_input->>'session_token','UTF8'),'sha256'),'hex');
  select * into v_session from public.clued_continuity_sessions s where s.token_hash=v_session_hash;
  if not found or v_session.ended_at is not null or v_session.revoked_at is not null or v_session.expires_at<=now() then
    raise exception 'P5_SESSION_INVALID' using errcode='42501';
  end if;
  if v_session.binding_id<>v.binding_id or v_session.user_id<>v.user_id
     or v_session.organization_id is distinct from v.organization_id
     or v_session.workspace_id is distinct from v.workspace_id
     or v_session.context_key is distinct from v.context_key
     or v_session.purpose is distinct from v.purpose
     or v_session.policy_version is distinct from v.policy_version
     or v_session.revocation_epoch is distinct from v.revocation_epoch then
    raise exception 'P5_SESSION_CONTEXT_STALE' using errcode='42501';
  end if;
  update public.clued_continuity_sessions set last_seen_at=now() where id=v_session.id;
  return query select v.binding_id,v.user_id,v.organization_id,v.workspace_id,v.context_key,
    v.role,v.purpose,v.policy_version,v.revocation_epoch,v.actor_kind,v_session.id;
end $$;

create or replace function clued_private.p5_audit(
  p_auth record,p_target_kind text,p_target_id uuid,p_base bigint,p_new bigint,
  p_result text,p_evidence jsonb,p_error text,p_receipt uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  insert into public.clued_p5_audit_events(
    organization_id,workspace_id,actor_kind,user_actor_id,binding_actor_id,
    service_account_actor,automation_actor,target_kind,target_id,context_key,role,scope,purpose,
    policy_version,revocation_epoch,base_version,new_version,result,evidence,error_type,receipt_id
  ) values (
    p_auth.organization_id,p_auth.workspace_id,p_auth.actor_kind,p_auth.user_id,p_auth.binding_id,
    case when p_auth.actor_kind='service_account' then p_auth.binding_id::text end,
    case when p_auth.actor_kind='automation' then p_auth.binding_id::text end,
    p_target_kind,p_target_id,p_auth.context_key,p_auth.role,
    coalesce(p_evidence->>'scope','canonical:write'),p_auth.purpose,p_auth.policy_version,p_auth.revocation_epoch,
    p_base,p_new,p_result,p_evidence,p_error,p_receipt
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function public.clued_p5_session_open(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v record; v_raw text; v_hash text; v_id uuid; v_expires timestamptz;
begin
  select * into v from clued_private.p5_resolve_binding(p_token_hash,p_input,coalesce(p_input->>'scope','canonical:write'));
  v_raw:='clued_p5s_'||encode(extensions.gen_random_bytes(32),'hex');
  v_hash:=encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex');
  v_expires:=least(now()+interval '1 hour',(select expires_at from public.clued_agent_bindings where id=v.binding_id));
  insert into public.clued_continuity_sessions(
    user_id,binding_id,context_key,token_hash,restored_version,expires_at,
    organization_id,workspace_id,purpose,policy_version,revocation_epoch
  ) values (v.user_id,v.binding_id,v.context_key,v_hash,0,v_expires,
    v.organization_id,v.workspace_id,v.purpose,v.policy_version,v.revocation_epoch)
  returning id into v_id;
  return jsonb_build_object('status','authorized','session_id',v_id,'session_token',v_raw,
    'organization_id',v.organization_id,'workspace_id',v.workspace_id,'context_key',v.context_key,
    'role',v.role,'scope',p_input->>'scope','purpose',v.purpose,'policy_version',v.policy_version,
    'revocation_epoch',v.revocation_epoch,'expires_at',v_expires);
exception when others then
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',sqlerrm));
end $$;

create or replace function public.clued_p5_workspace_switch(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v record; v_new_workspace uuid; v_new_context text; v_member public.clued_workspace_memberships%rowtype;
  v_workspace public.clued_workspaces%rowtype; v_new_epoch bigint; v_new_policy bigint;
begin
  select null::uuid as binding_id,null::uuid as user_id,null::uuid as organization_id,null::uuid as workspace_id,
    null::text as context_key,null::text as role,null::text as purpose,null::bigint as policy_version,
    null::bigint as revocation_epoch,null::text as actor_kind,null::uuid as session_id into v;
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  v_new_workspace:=(p_input->>'new_workspace_id')::uuid;
  v_new_context:=p_input->>'new_context_key';
  if v_new_context is null or char_length(v_new_context) not between 1 and 160 then raise exception 'P5_INVALID_NEW_CONTEXT'; end if;
  select * into v_workspace from public.clued_workspaces w
    where w.id=v_new_workspace and w.organization_id=v.organization_id and w.status='active';
  if not found then raise exception 'P5_NEW_WORKSPACE_DENIED'; end if;
  select * into v_member from public.clued_workspace_memberships m
    where m.organization_id=v.organization_id and m.workspace_id=v_new_workspace and m.user_id=v.user_id
      and m.revoked_at is null and (m.expires_at is null or m.expires_at>now());
  if not found or v_member.role in ('reader','denied') or not 'canonical:write'=any(v_member.scopes)
     or not v.purpose=any(v_member.purposes) then raise exception 'P5_NEW_WORKSPACE_DENIED'; end if;
  update public.clued_agent_bindings set workspace_id=v_new_workspace,active_context_key=v_new_context,
    context_keys=array[v_new_context],role=v_member.role,policy_version=greatest(policy_version,v_member.policy_version,v_workspace.policy_version),
    revocation_epoch=revocation_epoch+1,last_used_at=now() where id=v.binding_id
    returning revocation_epoch into v_new_epoch;
  update public.clued_continuity_sessions set revoked_at=now(),revoked_reason='workspace_switched',ended_at=now()
    where binding_id=v.binding_id and ended_at is null;
  v_new_policy:=greatest(v.policy_version,v_member.policy_version,v_workspace.policy_version);
  perform clued_private.p5_audit(v,'workspace',v_new_workspace,null,null,'committed',
    jsonb_build_object('scope','canonical:write','old_workspace_id',v.workspace_id,'new_workspace_id',v_new_workspace,
      'old_context_key',v.context_key,'new_context_key',v_new_context),null,null);
  return jsonb_build_object('status','committed','workspace_id',v_new_workspace,'context_key',v_new_context,
    'role',v_member.role,'policy_version',v_new_policy,'revocation_epoch',v_new_epoch,'old_context_invalidated',true);
exception when others then
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',sqlerrm));
end $$;

create or replace function public.clued_p5_mutate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v record; v_target_kind text; v_target_id uuid; v_base bigint; v_actual bigint; v_new bigint;
  v_visibility text; v_owner uuid; v_target_org uuid; v_target_workspace uuid;
  v_hash text; v_key text; v_inserted integer; v_idem public.clued_p5_idempotency%rowtype;
  v_event uuid; v_receipt uuid; v_result jsonb; v_error text; v_state text; v_fault text;
begin
  select null::uuid as binding_id,null::uuid as user_id,null::uuid as organization_id,null::uuid as workspace_id,
    null::text as context_key,null::text as role,null::text as purpose,null::bigint as policy_version,
    null::bigint as revocation_epoch,null::text as actor_kind,null::uuid as session_id into v;
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  v_target_kind:=p_input->>'target_kind';
  if v_target_kind not in ('record','project') then raise exception 'P5_INVALID_TARGET_KIND'; end if;
  v_target_id:=(p_input->>'target_id')::uuid;
  v_base:=(p_input->>'base_version')::bigint;
  if v_base<=0 then raise exception 'P5_POSITIVE_BASE_VERSION_REQUIRED'; end if;
  v_key:=p_input->>'idempotency_key';
  if char_length(coalesce(v_key,'')) not between 8 and 160 then raise exception 'P5_INVALID_IDEMPOTENCY_KEY'; end if;
  v_hash:=clued_private.p5_sha256(p_input-'session_token');
  v_fault:=nullif(p_input->>'fault_at','');
  if v_fault is not null and current_setting('clued.p5_test_faults',true)<>'on' then raise exception 'P5_FAULT_INJECTION_DISABLED'; end if;

  insert into public.clued_p5_idempotency(
    organization_id,workspace_id,user_id,binding_id,operation_family,idempotency_key,request_hash
  ) values (v.organization_id,v.workspace_id,v.user_id,v.binding_id,'canonical_mutation',v_key,v_hash)
  on conflict (organization_id,workspace_id,binding_id,operation_family,idempotency_key) do nothing;
  get diagnostics v_inserted=row_count;
  select * into v_idem from public.clued_p5_idempotency i
   where i.organization_id=v.organization_id and i.workspace_id=v.workspace_id and i.binding_id=v.binding_id
     and i.operation_family='canonical_mutation' and i.idempotency_key=v_key for update;
  if v_inserted=0 then
    if v_idem.request_hash<>v_hash then
      insert into public.clued_p5_receipts(
        organization_id,workspace_id,user_actor_id,binding_actor_id,actor_kind,status,target_kind,target_id,
        base_version,request_hash,error_type,evidence
      ) values (v.organization_id,v.workspace_id,v.user_id,v.binding_id,v.actor_kind,'rejected',v_target_kind,v_target_id,
        v_base,v_hash,'IDEMPOTENCY_PAYLOAD_CONFLICT',jsonb_build_object('original_request_hash',v_idem.request_hash,
          'received_request_hash',v_hash,'idempotency_key',v_key)) returning id into v_receipt;
      perform clued_private.p5_audit(v,v_target_kind,v_target_id,v_base,null,'rejected',
        jsonb_build_object('scope','canonical:write','original_request_hash',v_idem.request_hash,'received_request_hash',v_hash),
        'IDEMPOTENCY_PAYLOAD_CONFLICT',v_receipt);
      return jsonb_build_object('status','rejected','error',jsonb_build_object('type','IDEMPOTENCY_PAYLOAD_CONFLICT'),
        'receipt_id',v_receipt,'evidence',jsonb_build_object('original_request_hash',v_idem.request_hash,'received_request_hash',v_hash));
    end if;
    return v_idem.canonical_result;
  end if;

  begin
    if v_target_kind='record' then
      select m.user_id,m.organization_id,m.workspace_id,m.p5_visibility,m.version
        into v_owner,v_target_org,v_target_workspace,v_visibility,v_actual
        from public.clued_memories m where m.id=v_target_id;
    else
      select p.user_id,p.organization_id,p.workspace_id,p.p5_visibility,p.version
        into v_owner,v_target_org,v_target_workspace,v_visibility,v_actual
        from public.clued_projects p where p.id=v_target_id;
    end if;
    if v_actual is null or v_target_org is distinct from v.organization_id or v_target_workspace is distinct from v.workspace_id
       or (v_visibility='private' and v_owner<>v.user_id) then
      raise exception 'P5_TARGET_SCOPE_DENIED' using errcode='42501';
    end if;
    if v_target_kind='record' then
      update public.clued_memories set
        title=case when p_input->'mutation' ? 'title' then nullif(btrim(p_input->'mutation'->>'title'),'') else title end,
        content=case when p_input->'mutation' ? 'content' then p_input->'mutation'->>'content' else content end,
        updated_at=now(),version=version+1
      where id=v_target_id and organization_id=v.organization_id and workspace_id=v.workspace_id
        and version=v_base and (p5_visibility='workspace' or user_id=v.user_id)
      returning version into v_new;
    else
      update public.clued_projects set
        name=case when p_input->'mutation' ? 'name' then p_input->'mutation'->>'name' else name end,
        summary=case when p_input->'mutation' ? 'summary' then p_input->'mutation'->>'summary' else summary end,
        updated_at=now(),version=version+1
      where id=v_target_id and organization_id=v.organization_id and workspace_id=v.workspace_id
        and version=v_base and (p5_visibility='workspace' or user_id=v.user_id)
      returning version into v_new;
    end if;
    if v_new is null then
      if v_target_kind='record' then select version into v_actual from public.clued_memories where id=v_target_id;
      else select version into v_actual from public.clued_projects where id=v_target_id; end if;
      raise exception 'CANONICAL_CAS_CONFLICT' using errcode='40001';
    end if;
    if v_fault='after_mutation' then raise exception 'P5_INJECT_AFTER_MUTATION'; end if;
    v_event:=gen_random_uuid();
    v_receipt:=gen_random_uuid();
    v_result:=jsonb_build_object('status','committed','target_kind',v_target_kind,'target_id',v_target_id,
      'base_version',v_base,'new_version',v_new,'event_id',v_event,'receipt_id',v_receipt,
      'request_hash',v_hash,'atomic_contract',true);
    insert into public.clued_p5_events(
      id,
      organization_id,workspace_id,user_actor_id,binding_actor_id,actor_kind,event_type,target_kind,target_id,
      base_version,new_version,idempotency_id,evidence
    ) values (v_event,v.organization_id,v.workspace_id,v.user_id,v.binding_id,v.actor_kind,'canonical_mutated',v_target_kind,v_target_id,
      v_base,v_new,v_idem.id,jsonb_build_object('request_hash',v_hash,'changed_fields',
        coalesce((select jsonb_agg(key order by key) from jsonb_object_keys(coalesce(p_input->'mutation','{}')) key),'[]'::jsonb)));
    if v_fault='after_event' then raise exception 'P5_INJECT_AFTER_EVENT'; end if;
    if v_fault='receipt_write' then raise exception 'P5_INJECT_RECEIPT_WRITE'; end if;
    insert into public.clued_p5_receipts(
      id,
      organization_id,workspace_id,user_actor_id,binding_actor_id,actor_kind,idempotency_id,status,target_kind,target_id,
      base_version,new_version,request_hash,event_id,evidence,canonical_result
    ) values (v_receipt,v.organization_id,v.workspace_id,v.user_id,v.binding_id,v.actor_kind,v_idem.id,'committed',v_target_kind,v_target_id,
      v_base,v_new,v_hash,v_event,jsonb_build_object('cas_expected',v_base,'cas_committed',v_new,'atomic_contract',true),v_result);
    if v_fault='after_receipt' then raise exception 'P5_INJECT_AFTER_RECEIPT'; end if;
    if v_fault='audit_write' then raise exception 'P5_INJECT_AUDIT_WRITE'; end if;
    perform clued_private.p5_audit(v,v_target_kind,v_target_id,v_base,v_new,'committed',
      jsonb_build_object('scope','canonical:write','request_hash',v_hash,'event_id',v_event),null,v_receipt);
    update public.clued_p5_idempotency set state='committed',canonical_result=v_result,receipt_id=v_receipt,completed_at=now()
      where id=v_idem.id;
    return v_result;
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
  end;

  if v_error='CANONICAL_CAS_CONFLICT' then
    v_result:=jsonb_build_object('status','conflict','error',jsonb_build_object('type','CANONICAL_CAS_CONFLICT',
      'expected_version',v_base,'actual_version',v_actual),'target_kind',v_target_kind,'target_id',v_target_id,
      'evidence',jsonb_build_object('conflict_domain','canonical_store','cas_checked_at','transaction_update','auto_merge',false));
    insert into public.clued_p5_receipts(
      organization_id,workspace_id,user_actor_id,binding_actor_id,actor_kind,idempotency_id,status,target_kind,target_id,
      base_version,new_version,request_hash,error_type,evidence,canonical_result
    ) values (v.organization_id,v.workspace_id,v.user_id,v.binding_id,v.actor_kind,v_idem.id,'rejected',v_target_kind,v_target_id,
      v_base,v_actual,v_hash,'CANONICAL_CAS_CONFLICT',v_result->'evidence',v_result) returning id into v_receipt;
    v_result:=v_result||jsonb_build_object('receipt_id',v_receipt);
    update public.clued_p5_idempotency set state='rejected',canonical_result=v_result,receipt_id=v_receipt,completed_at=now() where id=v_idem.id;
    perform clued_private.p5_audit(v,v_target_kind,v_target_id,v_base,v_actual,'rejected',
      jsonb_build_object('scope','canonical:write','expected_version',v_base,'actual_version',v_actual),
      'CANONICAL_CAS_CONFLICT',v_receipt);
    return v_result;
  end if;
  v_result:=jsonb_build_object('status',case when v_state='42501' then 'rejected' else 'failed' end,
    'error',jsonb_build_object('type',v_error,'sqlstate',v_state),
    'target_kind',v_target_kind,'target_id',v_target_id,'base_version',v_base,
    'evidence',jsonb_build_object('atomic_rollback',true,'success_event',false,'success_receipt',false));
  insert into public.clued_p5_receipts(
    organization_id,workspace_id,user_actor_id,binding_actor_id,actor_kind,idempotency_id,status,target_kind,target_id,
    base_version,request_hash,error_type,evidence,canonical_result
  ) values (v.organization_id,v.workspace_id,v.user_id,v.binding_id,v.actor_kind,v_idem.id,
    case when v_state='42501' then 'rejected' else 'failed' end,v_target_kind,v_target_id,
    v_base,v_hash,v_error,v_result->'evidence',v_result) returning id into v_receipt;
  v_result:=v_result||jsonb_build_object('receipt_id',v_receipt);
  update public.clued_p5_idempotency set state=case when v_state='42501' then 'rejected' else 'failed' end,
    canonical_result=v_result,receipt_id=v_receipt,completed_at=now() where id=v_idem.id;
  perform clued_private.p5_audit(v,v_target_kind,v_target_id,v_base,null,
    case when v_state='42501' then 'rejected' else 'failed' end,
    jsonb_build_object('scope','canonical:write','atomic_rollback',true),v_error,v_receipt);
  return v_result;
exception when others then
  get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
  if v.binding_id is null and p_token_hash ~ '^[0-9a-f]{64}$' then
    select b.id as binding_id,b.user_id,b.organization_id,b.workspace_id,
      coalesce(b.active_context_key,p_input->>'context_key') as context_key,
      coalesce(b.role,p_input->>'role') as role,coalesce(b.purpose,p_input->>'purpose') as purpose,
      greatest(coalesce(o.policy_version,1),coalesce(w.policy_version,1),coalesce(m.policy_version,1),coalesce(b.policy_version,1)) as policy_version,
      greatest(coalesce(o.revocation_epoch,1),coalesce(w.revocation_epoch,1),coalesce(m.revocation_epoch,1),coalesce(b.revocation_epoch,1)) as revocation_epoch,
      coalesce(b.actor_kind,'agent_binding') as actor_kind,null::uuid as session_id
      into v
      from public.clued_agent_bindings b
      left join public.clued_organizations o on o.id=b.organization_id
      left join public.clued_workspaces w on w.id=b.workspace_id and w.organization_id=b.organization_id
      left join public.clued_workspace_memberships m on m.organization_id=b.organization_id and m.workspace_id=b.workspace_id and m.user_id=b.user_id
     where b.token_hash=p_token_hash and b.organization_id=(p_input->>'organization_id')::uuid
       and b.workspace_id=(p_input->>'workspace_id')::uuid;
  end if;
  if v.binding_id is not null then
    perform clued_private.p5_audit(v,coalesce(v_target_kind,p_input->>'target_kind'),v_target_id,v_base,null,'rejected',
      jsonb_build_object('scope','canonical:write','service_authorization',true),v_error,null);
  end if;
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',v_error,'sqlstate',v_state));
end $$;

create or replace function public.clued_p5_pending_intent(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v record; v_id uuid; v_hash text;
begin
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  v_hash:=clued_private.p5_sha256(p_input-'session_token');
  insert into public.clued_pending_intents(
    organization_id,workspace_id,user_id,binding_id,context_key,idempotency_key,request_hash,encrypted_intent_ref
  ) values (v.organization_id,v.workspace_id,v.user_id,v.binding_id,v.context_key,p_input->>'idempotency_key',v_hash,
    p_input->>'encrypted_intent_ref')
  on conflict (organization_id,workspace_id,binding_id,idempotency_key) do update
    set encrypted_intent_ref=public.clued_pending_intents.encrypted_intent_ref
    where public.clued_pending_intents.request_hash=excluded.request_hash
  returning id into v_id;
  if v_id is null then raise exception 'IDEMPOTENCY_PAYLOAD_CONFLICT'; end if;
  perform clued_private.p5_audit(v,'pending_intent',v_id,null,null,'pending',
    jsonb_build_object('scope','canonical:write','offline_only',true,'server_confirmed',false,'request_hash',v_hash),null,null);
  return jsonb_build_object('status','pending','intent_id',v_id,'request_hash',v_hash,
    'server_confirmed',false,'canonical_mutated',false,'event_created',false,'receipt_created',false);
exception when others then
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',sqlerrm));
end $$;

create or replace function public.clued_p5_git_divergence(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'P5_INVALID_BINDING_TOKEN'; end if;
  if coalesce(p_input->>'base','') !~ '^[0-9a-f]{40}$' or coalesce(p_input->>'local','') !~ '^[0-9a-f]{40}$'
     or coalesce(p_input->>'remote','') !~ '^[0-9a-f]{40}$' then raise exception 'P5_INVALID_GIT_EVIDENCE'; end if;
  return jsonb_build_object('status','conflict','error',jsonb_build_object('type','GIT_DIVERGENCE'),
    'evidence',jsonb_build_object('conflict_domain','git_history','base',p_input->>'base','local',p_input->>'local',
      'remote',p_input->>'remote','auto_merge',false,'auto_overwrite',false));
end $$;

create or replace function clued_private.p5_rls_authorized(
  p_owner_user_id uuid,p_organization_id uuid,p_workspace_id uuid,p_visibility text,p_required_scope text
) returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.clued_agent_bindings b
    join public.clued_workspace_memberships m on m.organization_id=b.organization_id
      and m.workspace_id=b.workspace_id and m.user_id=b.user_id
    join public.clued_organizations o on o.id=b.organization_id
    join public.clued_workspaces w on w.id=b.workspace_id and w.organization_id=b.organization_id
    where b.id=nullif(auth.jwt()->'app_metadata'->>'clued_binding_id','')::uuid
      and b.user_id=auth.uid() and b.organization_id=p_organization_id and b.workspace_id=p_workspace_id
      and auth.jwt()->'app_metadata'->>'clued_organization_id'=p_organization_id::text
      and auth.jwt()->'app_metadata'->>'clued_workspace_id'=p_workspace_id::text
      and auth.jwt()->'app_metadata'->>'clued_context_key'=b.active_context_key
      and auth.jwt()->'app_metadata'->>'clued_purpose'=b.purpose
      and (auth.jwt()->'app_metadata'->>'clued_policy_version')::bigint=
        greatest(o.policy_version,w.policy_version,m.policy_version,b.policy_version)
      and (auth.jwt()->'app_metadata'->>'clued_revocation_epoch')::bigint=
        greatest(o.revocation_epoch,w.revocation_epoch,m.revocation_epoch,b.revocation_epoch)
      and b.revoked_at is null and b.expires_at>now() and b.role=m.role and b.role<>'denied'
      and (p_required_scope=any(b.scopes)) and (p_required_scope=any(m.scopes)) and b.purpose=any(m.purposes)
      and m.revoked_at is null and (m.expires_at is null or m.expires_at>now())
      and o.status='active' and w.status='active'
      and (p_visibility='workspace' or (p_visibility='private' and p_owner_user_id=auth.uid()))
  )
$$;

alter table public.clued_organizations enable row level security;
alter table public.clued_workspaces enable row level security;
alter table public.clued_workspace_memberships enable row level security;
alter table public.clued_p5_idempotency enable row level security;
alter table public.clued_p5_events enable row level security;
alter table public.clued_p5_receipts enable row level security;
alter table public.clued_p5_audit_events enable row level security;
alter table public.clued_pending_intents enable row level security;

drop policy if exists clued_memories_v2_select_own on public.clued_memories;
drop policy if exists clued_memories_v2_insert_legacy_note on public.clued_memories;
drop policy if exists clued_memories_v2_update_legacy_note on public.clued_memories;
drop policy if exists clued_memories_v2_delete_legacy_note on public.clued_memories;
create policy clued_memories_p5_select on public.clued_memories for select to authenticated using (
  (organization_id is null and auth.uid()=user_id)
  or clued_private.p5_rls_authorized(user_id,organization_id,workspace_id,p5_visibility,'canonical:read')
);

drop policy if exists clued_projects_owner_select on public.clued_projects;
create policy clued_projects_p5_select on public.clued_projects for select to authenticated using (
  (organization_id is null and auth.uid()=user_id)
  or clued_private.p5_rls_authorized(user_id,organization_id,workspace_id,p5_visibility,'project:read')
);

create policy clued_organizations_p5_select on public.clued_organizations for select to authenticated using (
  exists(select 1 from public.clued_workspace_memberships m where m.organization_id=id and m.user_id=auth.uid()
    and m.revoked_at is null and (m.expires_at is null or m.expires_at>now()))
);
create policy clued_workspaces_p5_select on public.clued_workspaces for select to authenticated using (
  exists(select 1 from public.clued_workspace_memberships m where m.organization_id=organization_id and m.workspace_id=id
    and m.user_id=auth.uid() and m.revoked_at is null and (m.expires_at is null or m.expires_at>now()))
);
create policy clued_memberships_p5_select on public.clued_workspace_memberships for select to authenticated using (user_id=auth.uid());
create policy clued_p5_events_select on public.clued_p5_events for select to authenticated using (
  clued_private.p5_rls_authorized(user_actor_id,organization_id,workspace_id,'workspace','canonical:read')
);
create policy clued_p5_receipts_select on public.clued_p5_receipts for select to authenticated using (
  clued_private.p5_rls_authorized(user_actor_id,organization_id,workspace_id,'workspace','audit:read')
);
create policy clued_p5_audit_select on public.clued_p5_audit_events for select to authenticated using (
  clued_private.p5_rls_authorized(coalesce(user_actor_id,auth.uid()),organization_id,workspace_id,'workspace','audit:read')
);

revoke all on table public.clued_organizations,public.clued_workspaces,public.clued_workspace_memberships,
  public.clued_p5_idempotency,public.clued_p5_events,public.clued_p5_receipts,public.clued_p5_audit_events,
  public.clued_pending_intents from public,anon,authenticated;
grant select on table public.clued_organizations,public.clued_workspaces,public.clued_workspace_memberships,
  public.clued_p5_events,public.clued_p5_receipts,public.clued_p5_audit_events to authenticated;
revoke insert,update,delete on table public.clued_memories,public.clued_projects from authenticated;
revoke insert,update,delete on table public.clued_agent_bindings,public.clued_continuity_sessions from authenticated;

grant usage on schema clued_private to authenticated;
revoke all on function clued_private.p5_immutable_row(),clued_private.p5_sha256(jsonb),
  clued_private.p5_effective_policy(bigint,bigint,bigint,bigint),clued_private.p5_effective_epoch(bigint,bigint,bigint,bigint),
  clued_private.p5_resolve_binding(text,jsonb,text),clued_private.p5_resolve_request(text,jsonb,text),
  clued_private.p5_audit(record,text,uuid,bigint,bigint,text,jsonb,text,uuid),
  clued_private.p5_rls_authorized(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function clued_private.p5_rls_authorized(uuid,uuid,uuid,text,text) to authenticated;

revoke all on function public.clued_p5_session_open(text,jsonb),public.clued_p5_workspace_switch(text,jsonb),
  public.clued_p5_mutate(text,jsonb),public.clued_p5_pending_intent(text,jsonb),
  public.clued_p5_git_divergence(text,jsonb) from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
