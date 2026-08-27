-- P5 independent-review repair: the Data API is not a Binding-token entrypoint.
-- Only the Worker-held, least-privilege gateway JWT may execute P5 RPCs. A
-- server-created Attempt makes commit/transport failure compensation one-shot
-- and binds it to the exact authorized mutation request.

do $role$
begin
  if not exists (select 1 from pg_roles where rolname='clued_p5_gateway') then
    create role clued_p5_gateway nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $role$;

alter role clued_p5_gateway nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant clued_p5_gateway to authenticator;
grant usage on schema public to clued_p5_gateway;

-- Close the vulnerable overloads before replacing them. Moving the mutation
-- implementation preserves the already-reviewed CAS/transaction core while
-- making it unreachable except through the Attempt-validating wrapper below.
revoke execute on function public.clued_p5_mutate(text,jsonb) from public,anon,authenticated,service_role;
alter function public.clued_p5_mutate(text,jsonb) rename to p5_mutate_gateway_core;
alter function public.p5_mutate_gateway_core(text,jsonb) set schema clued_private;
revoke all on function clued_private.p5_mutate_gateway_core(text,jsonb)
  from public,anon,authenticated,service_role,clued_p5_gateway;
drop function if exists public.clued_p5_record_commit_failure(text,jsonb,text);

create table public.clued_p5_gateway_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  binding_id uuid not null references public.clued_agent_bindings(id) on delete restrict,
  operation_family text not null check (operation_family='canonical_mutation'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  target_kind text not null check (target_kind in ('record','project')),
  target_id uuid not null,
  base_version bigint not null check (base_version>0),
  status text not null default 'open' check (status in ('open','completed','failed')),
  canonical_result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '5 minutes'),
  completed_at timestamptz,
  foreign key (organization_id,workspace_id)
    references public.clued_workspaces(organization_id,id) on delete restrict
);

create unique index clued_p5_gateway_attempt_open_uidx
  on public.clued_p5_gateway_attempts(
    organization_id,workspace_id,binding_id,operation_family,idempotency_key,request_hash
  ) where status='open';

alter table public.clued_p5_gateway_attempts enable row level security;
revoke all on table public.clued_p5_gateway_attempts from public,anon,authenticated,service_role,clued_p5_gateway;

create or replace function public.clued_p5_attempt_begin(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v record; v_attempt_id uuid; v_hash text; v_target_kind text; v_target_id uuid;
  v_base bigint; v_key text; v_existing public.clued_p5_idempotency%rowtype;
begin
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  v_target_kind:=p_input->>'target_kind';
  if v_target_kind not in ('record','project') then raise exception 'P5_INVALID_TARGET_KIND'; end if;
  v_target_id:=(p_input->>'target_id')::uuid;
  v_base:=(p_input->>'base_version')::bigint;
  if v_base<=0 then raise exception 'P5_POSITIVE_BASE_VERSION_REQUIRED'; end if;
  v_key:=p_input->>'idempotency_key';
  if char_length(coalesce(v_key,'')) not between 8 and 160 then raise exception 'P5_INVALID_IDEMPOTENCY_KEY'; end if;
  v_hash:=clued_private.p5_sha256(p_input-'session_token');

  select * into v_existing from public.clued_p5_idempotency i
   where i.organization_id=v.organization_id and i.workspace_id=v.workspace_id
     and i.binding_id=v.binding_id and i.operation_family='canonical_mutation'
     and i.idempotency_key=v_key;
  if found and v_existing.request_hash=v_hash and v_existing.canonical_result is not null then
    return jsonb_build_object('status','replayed','request_hash',v_hash,
      'canonical_result',v_existing.canonical_result,'receipt_id',v_existing.receipt_id);
  end if;

  insert into public.clued_p5_gateway_attempts(
    organization_id,workspace_id,user_id,binding_id,operation_family,idempotency_key,
    request_hash,target_kind,target_id,base_version
  ) values (
    v.organization_id,v.workspace_id,v.user_id,v.binding_id,'canonical_mutation',v_key,
    v_hash,v_target_kind,v_target_id,v_base
  ) on conflict (organization_id,workspace_id,binding_id,operation_family,idempotency_key,request_hash)
      where status='open' do nothing
    returning id into v_attempt_id;
  if v_attempt_id is null then
    select a.id into v_attempt_id from public.clued_p5_gateway_attempts a
     where a.organization_id=v.organization_id and a.workspace_id=v.workspace_id
       and a.binding_id=v.binding_id and a.operation_family='canonical_mutation'
       and a.idempotency_key=v_key and a.request_hash=v_hash and a.status='open'
       and a.expires_at>now()
     order by a.created_at desc limit 1;
  end if;
  if v_attempt_id is null then raise exception 'P5_ATTEMPT_UNAVAILABLE'; end if;
  return jsonb_build_object('status','open','attempt_id',v_attempt_id,'request_hash',v_hash,
    'organization_id',v.organization_id,'workspace_id',v.workspace_id,'binding_id',v.binding_id,
    'target_kind',v_target_kind,'target_id',v_target_id,'base_version',v_base,
    'idempotency_key',v_key);
exception when others then
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',sqlerrm,'sqlstate',sqlstate));
end $$;

create or replace function public.clued_p5_attempt_resolve(
  p_token_hash text,p_input jsonb,p_attempt_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v record; v_attempt public.clued_p5_gateway_attempts%rowtype;
  v_hash text:=clued_private.p5_sha256(p_input-'session_token');
begin
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  select * into v_attempt from public.clued_p5_gateway_attempts a where a.id=p_attempt_id;
  if not found then raise exception 'P5_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.organization_id<>v.organization_id or v_attempt.workspace_id<>v.workspace_id
     or v_attempt.user_id<>v.user_id or v_attempt.binding_id<>v.binding_id
     or v_attempt.request_hash<>v_hash or v_attempt.idempotency_key<>p_input->>'idempotency_key'
     or v_attempt.target_kind<>p_input->>'target_kind'
     or v_attempt.target_id<>(p_input->>'target_id')::uuid
     or v_attempt.base_version<>(p_input->>'base_version')::bigint then
    raise exception 'P5_ATTEMPT_REQUEST_MISMATCH';
  end if;
  if v_attempt.status='open' and v_attempt.expires_at<=now() then raise exception 'P5_ATTEMPT_EXPIRED'; end if;
  return jsonb_build_object('status',v_attempt.status,'attempt_id',v_attempt.id,
    'request_hash',v_attempt.request_hash,'canonical_result',v_attempt.canonical_result);
exception when others then
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',sqlerrm,'sqlstate',sqlstate));
end $$;

create or replace function public.clued_p5_mutate(
  p_token_hash text,p_input jsonb,p_attempt_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v record; v_attempt public.clued_p5_gateway_attempts%rowtype; v_result jsonb;
  v_hash text:=clued_private.p5_sha256(p_input-'session_token');
begin
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  select * into v_attempt from public.clued_p5_gateway_attempts a where a.id=p_attempt_id for update;
  if not found then raise exception 'P5_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.status<>'open' then raise exception 'P5_ATTEMPT_ALREADY_CONSUMED'; end if;
  if v_attempt.expires_at<=now() then raise exception 'P5_ATTEMPT_EXPIRED'; end if;
  if v_attempt.organization_id<>v.organization_id or v_attempt.workspace_id<>v.workspace_id
     or v_attempt.user_id<>v.user_id or v_attempt.binding_id<>v.binding_id
     or v_attempt.request_hash<>v_hash or v_attempt.idempotency_key<>p_input->>'idempotency_key'
     or v_attempt.target_kind<>p_input->>'target_kind'
     or v_attempt.target_id<>(p_input->>'target_id')::uuid
     or v_attempt.base_version<>(p_input->>'base_version')::bigint then
    raise exception 'P5_ATTEMPT_REQUEST_MISMATCH';
  end if;
  v_result:=clued_private.p5_mutate_gateway_core(p_token_hash,p_input);
  update public.clued_p5_gateway_attempts set status='completed',canonical_result=v_result,completed_at=now()
    where id=v_attempt.id;
  return v_result;
exception when others then
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',sqlerrm,'sqlstate',sqlstate));
end $$;

create or replace function public.clued_p5_record_commit_failure(
  p_token_hash text,p_input jsonb,p_attempt_id uuid,p_failure_kind text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v record; v_attempt public.clued_p5_gateway_attempts%rowtype; v_hash text;
  v_idem public.clued_p5_idempotency%rowtype; v_receipt uuid:=gen_random_uuid(); v_result jsonb;
begin
  if p_failure_kind not in ('database_commit_failure','transport_failure') then
    raise exception 'P5_UNTRUSTED_FAILURE_CLASS';
  end if;
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  v_hash:=clued_private.p5_sha256(p_input-'session_token');
  select * into v_attempt from public.clued_p5_gateway_attempts a where a.id=p_attempt_id for update;
  if not found then raise exception 'P5_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.status<>'open' then raise exception 'P5_ATTEMPT_ALREADY_CONSUMED'; end if;
  if v_attempt.expires_at<=now() then raise exception 'P5_ATTEMPT_EXPIRED'; end if;
  if v_attempt.organization_id<>v.organization_id or v_attempt.workspace_id<>v.workspace_id
     or v_attempt.user_id<>v.user_id or v_attempt.binding_id<>v.binding_id
     or v_attempt.request_hash<>v_hash or v_attempt.idempotency_key<>p_input->>'idempotency_key'
     or v_attempt.target_kind<>p_input->>'target_kind'
     or v_attempt.target_id<>(p_input->>'target_id')::uuid
     or v_attempt.base_version<>(p_input->>'base_version')::bigint then
    raise exception 'P5_ATTEMPT_REQUEST_MISMATCH';
  end if;

  insert into public.clued_p5_idempotency(
    organization_id,workspace_id,user_id,binding_id,operation_family,idempotency_key,request_hash
  ) values (v.organization_id,v.workspace_id,v.user_id,v.binding_id,'canonical_mutation',
    p_input->>'idempotency_key',v_hash)
  on conflict (organization_id,workspace_id,binding_id,operation_family,idempotency_key) do nothing;
  select * into v_idem from public.clued_p5_idempotency i
   where i.organization_id=v.organization_id and i.workspace_id=v.workspace_id and i.binding_id=v.binding_id
     and i.operation_family='canonical_mutation' and i.idempotency_key=p_input->>'idempotency_key' for update;
  if v_idem.request_hash<>v_hash then raise exception 'P5_IDEMPOTENCY_REQUEST_MISMATCH'; end if;
  if v_idem.canonical_result is not null then raise exception 'P5_IDEMPOTENCY_ALREADY_RESOLVED'; end if;

  v_result:=jsonb_build_object('status','failed',
    'error',jsonb_build_object('type','TRANSACTION_COMMIT_FAILED','failure_kind',p_failure_kind),
    'attempt_id',v_attempt.id,'receipt_id',v_receipt,'request_hash',v_hash,
    'transaction_rolled_back',true);
  insert into public.clued_p5_receipts(
    id,organization_id,workspace_id,user_actor_id,binding_actor_id,actor_kind,idempotency_id,status,
    target_kind,target_id,base_version,request_hash,error_type,evidence,canonical_result
  ) values (v_receipt,v.organization_id,v.workspace_id,v.user_id,v.binding_id,v.actor_kind,v_idem.id,'failed',
    v_attempt.target_kind,v_attempt.target_id,v_attempt.base_version,v_hash,'TRANSACTION_COMMIT_FAILED',
    jsonb_build_object('attempt_id',v_attempt.id,'failure_kind',p_failure_kind,
      'trusted_gateway',true,'transaction_rolled_back',true),v_result);
  update public.clued_p5_idempotency set state='failed',canonical_result=v_result,
    receipt_id=v_receipt,completed_at=now() where id=v_idem.id;
  perform clued_private.p5_audit(v,v_attempt.target_kind,v_attempt.target_id,v_attempt.base_version,null,'failed',
    jsonb_build_object('scope','canonical:write','attempt_id',v_attempt.id,'failure_kind',p_failure_kind,
      'trusted_gateway',true,'transaction_rolled_back',true),
    'TRANSACTION_COMMIT_FAILED',v_receipt);
  update public.clued_p5_gateway_attempts set status='failed',canonical_result=v_result,completed_at=now()
    where id=v_attempt.id;
  return v_result;
exception when others then
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',sqlerrm,'sqlstate',sqlstate));
end $$;

-- Every P5 public RPC is unreachable to Data API user roles. The gateway role
-- has EXECUTE only; table access, private helper access, LOGIN, inheritance and
-- BYPASSRLS remain absent.
revoke execute on function public.clued_p5_session_open(text,jsonb),
  public.clued_p5_workspace_switch(text,jsonb),
  public.clued_p5_mutate(text,jsonb,uuid),
  public.clued_p5_pending_intent(text,jsonb),
  public.clued_p5_attempt_begin(text,jsonb),
  public.clued_p5_attempt_resolve(text,jsonb,uuid),
  public.clued_p5_record_commit_failure(text,jsonb,uuid,text),
  public.clued_p5_git_divergence(text,jsonb)
  from public,anon,authenticated,service_role;

grant execute on function public.clued_p5_session_open(text,jsonb),
  public.clued_p5_workspace_switch(text,jsonb),
  public.clued_p5_mutate(text,jsonb,uuid),
  public.clued_p5_pending_intent(text,jsonb),
  public.clued_p5_attempt_begin(text,jsonb),
  public.clued_p5_attempt_resolve(text,jsonb,uuid),
  public.clued_p5_record_commit_failure(text,jsonb,uuid,text),
  public.clued_p5_git_divergence(text,jsonb)
  to clued_p5_gateway;

notify pgrst,'reload schema';
