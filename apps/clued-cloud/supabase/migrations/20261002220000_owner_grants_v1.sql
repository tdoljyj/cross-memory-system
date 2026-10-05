-- Owner Credential v0.1, rollout step 1 (development/contracts/
-- owner-authorization/OwnerCredential.v0.1.md §3, §4, §10; Task 3b7adacc).
--
-- Owner Grants: scoped, revocable permissions the Owner gives from the
-- signed-in Clued page, consumed by doors inside their own write transaction.
-- Owner Requests: an Agent asks for one and gets a direct confirmation link.
--
-- Agents (Binding token): clued_owner_request_v1 creates a request,
-- clued_owner_request_status_v1 reads it. They never create, widen or approve
-- a grant.
-- Owner (Native account session, authorization_owner_v12; delegated OAuth and
-- Bindings are refused): clued_owner_request_view_v1,
-- clued_owner_grant_confirmation_issue_v1 + clued_owner_grant_v1 (two-step,
-- single-use token bound to the session and the rendered view),
-- clued_owner_request_reject_v1, clued_owner_grant_revoke_v1,
-- clued_owner_grants_list_v1.
-- A recent sign-in is not required (Decision 667f588b); a session id is.
-- Durations: default 4 hours, at most 7 days (Decision 6fa79397).
-- No door is wired here: nothing consumes a grant yet.

create table clued_private.owner_grant_actions (
  action text primary key check (action ~ '^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$'),
  doors text[] not null check (cardinality(doors)>0),
  title text not null check (char_length(title) between 1 and 200),
  registered_at timestamptz not null default now()
);
insert into clued_private.owner_grant_actions(action,doors,title) values
  ('release.production',array['release-workflow'],'运行生产发布（deploy 模式）'),
  ('migration.production',array['release-workflow'],'经发布 workflow 应用迁移到生产库'),
  ('work_claim.extra_claims',array['work-claim'],'某个 Task 超出每日认领上限后再认领');

create table clued_private.owner_requests_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid not null references public.clued_agent_bindings(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  action text not null references clued_private.owner_grant_actions(action),
  resources text[] not null check (cardinality(resources) between 1 and 50),
  task_id uuid references public.clued_memories(id) on delete cascade,
  suggested_expires_seconds integer check (suggested_expires_seconds between 60 and 604800),
  suggested_max_uses integer check (suggested_max_uses between 1 and 1000),
  agent_note text check (char_length(agent_note) between 1 and 2000),
  status text not null default 'pending' check (status in ('pending','approved_once','granted','rejected')),
  grant_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  unique (user_id,binding_id,idempotency_key),
  check (expires_at>created_at)
);

create table clued_private.owner_grants_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- null: any of the Owner's Agents.
  grantee_binding_id uuid references public.clued_agent_bindings(id) on delete cascade,
  action text not null references clued_private.owner_grant_actions(action),
  resources text[] not null check (cardinality(resources) between 1 and 50),
  task_id uuid references public.clued_memories(id) on delete cascade,
  max_uses integer check (max_uses between 1 and 1000),
  uses integer not null default 0 check (uses>=0),
  granted_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  request_id uuid unique references clued_private.owner_requests_v1(id),
  token_id uuid not null unique references clued_private.native_confirmation_tokens(id),
  receipt_id uuid not null unique references public.clued_audit_receipts(id),
  granted_session_id text not null,
  check (expires_at>granted_at and expires_at<=granted_at+interval '7 days'),
  check (max_uses is null or uses<=max_uses)
);
alter table clued_private.owner_requests_v1
  add constraint owner_requests_v1_grant_fk foreign key (grant_id) references clued_private.owner_grants_v1(id);
create index owner_grants_v1_live_idx on clued_private.owner_grants_v1(user_id,action,expires_at)
  where revoked_at is null;
create index owner_requests_v1_user_idx on clued_private.owner_requests_v1(user_id,created_at desc);

alter table clued_private.owner_grant_actions enable row level security;
alter table clued_private.owner_requests_v1 enable row level security;
alter table clued_private.owner_grants_v1 enable row level security;
revoke all on clued_private.owner_grant_actions,clued_private.owner_requests_v1,clued_private.owner_grants_v1
  from public,anon,authenticated,service_role;

create function clued_private.owner_grant_lock_v1(p_user_id uuid) returns void
language sql volatile set search_path='' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('owner-grant:'||p_user_id::text))
$$;

-- A resource of a grant covers a requested one when both have the same kind
-- (or are both bare paths) and the grant's value, as a path or glob, covers
-- the requested value. Coverage never crosses kinds.
create function clued_private.owner_grant_covers_v1(p_grant text[],p_resource text) returns boolean
language sql immutable set search_path='' as $$
  select exists(select 1 from unnest(p_grant) g
    where (clued_private.work_claim_resource_split(g))[1]
            is not distinct from (clued_private.work_claim_resource_split(p_resource))[1]
      and clued_private.work_claim_path_covered((clued_private.work_claim_resource_split(p_resource))[2],
            array[(clued_private.work_claim_resource_split(g))[2]]))
$$;

-- Agent-facing view of a request; the effective status turns "expired" once a
-- pending request outlives expires_at.
create function clued_private.owner_request_public_v1(r clued_private.owner_requests_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('request_id',r.id,'action',r.action,'resources',to_jsonb(r.resources),
    'task_id',r.task_id,
    'status',case when r.status='pending' and r.expires_at<=clock_timestamp() then 'expired' else r.status end,
    'confirm_path','/confirm/'||r.id::text,'created_at',r.created_at,'expires_at',r.expires_at,
    'decided_at',r.decided_at,
    'grant',(select jsonb_build_object('grant_id',g.id,'expires_at',g.expires_at,'max_uses',g.max_uses,
        'uses',g.uses,'revoked',g.revoked_at is not null,'any_agent',g.grantee_binding_id is null)
      from clued_private.owner_grants_v1 g where g.id=r.grant_id))
$$;

-- What the Owner confirms, rendered by Clued from structured fields. The
-- Agent's note is carried separately and marked unverified (Decision 6fa79397).
create function clued_private.owner_grant_view_v1(p_user_id uuid,p_choices jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_action clued_private.owner_grant_actions%rowtype; v_task public.clued_memories%rowtype;
  v_req clued_private.owner_requests_v1%rowtype; v_grantee public.clued_agent_bindings%rowtype;
begin
  select * into v_action from clued_private.owner_grant_actions where action=p_choices->>'action';
  if p_choices->>'task_id' is not null then
    select * into v_task from public.clued_memories where id=(p_choices->>'task_id')::uuid and user_id=p_user_id;
  end if;
  if p_choices->>'request_id' is not null then
    select * into v_req from clued_private.owner_requests_v1 where id=(p_choices->>'request_id')::uuid;
  end if;
  if p_choices->>'grantee_binding_id' is not null then
    select * into v_grantee from public.clued_agent_bindings where id=(p_choices->>'grantee_binding_id')::uuid;
  end if;
  return jsonb_build_object('action',v_action.action,'action_title',v_action.title,
    'resources',p_choices->'resources',
    'task',case when v_task.id is null then null
      else jsonb_build_object('task_id',v_task.id,'title',v_task.title) end,
    'grantee',case when v_grantee.id is null then jsonb_build_object('any_agent',true)
      else jsonb_build_object('any_agent',false,'binding_id',v_grantee.id,'agent_name',v_grantee.agent_name,
        'vendor',v_grantee.vendor) end,
    'choice',p_choices->>'choice','expires_seconds',(p_choices->>'expires_seconds')::integer,
    'max_uses',(p_choices->>'max_uses')::integer,
    'request',case when v_req.id is null then null
      else jsonb_build_object('request_id',v_req.id,'status',v_req.status,'created_at',v_req.created_at,
        'agent_note_unverified',v_req.agent_note) end);
end $$;

-- Doors call this inside their own write transaction. It takes the live grant
-- that admits (binding, action, every resource, task) and expires first,
-- counts one use and writes a Receipt; null when none admits.
create function clued_private.owner_grant_consume_v1(
  p_user_id uuid,p_binding_id uuid,p_action text,p_resources text[],p_task_id uuid
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare g clued_private.owner_grants_v1%rowtype; v_receipt uuid;
begin
  perform clued_private.owner_grant_lock_v1(p_user_id);
  select * into g from clued_private.owner_grants_v1 x
    where x.user_id=p_user_id and x.action=p_action and x.revoked_at is null
      and x.expires_at>clock_timestamp() and (x.max_uses is null or x.uses<x.max_uses)
      and (x.grantee_binding_id is null or x.grantee_binding_id=p_binding_id)
      and (x.task_id is null or x.task_id=p_task_id)
      and cardinality(p_resources)>0
      and not exists(select 1 from unnest(p_resources) r where not clued_private.owner_grant_covers_v1(x.resources,r))
    order by x.expires_at,x.granted_at limit 1 for update;
  if not found then return null; end if;
  update clued_private.owner_grants_v1 set uses=uses+1 where id=g.id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(p_user_id,p_binding_id,'global','owner_grant_use','owner_grant',g.id::text,g.uses+1,
    jsonb_build_object('receipt_kind','OWNER_GRANT_USED','grant_id',g.id,'action',p_action,
      'resources',to_jsonb(p_resources),'task_id',p_task_id,'use',g.uses+1,'max_uses',g.max_uses))
  returning id into v_receipt;
  return jsonb_build_object('grant_id',g.id,'receipt_id',v_receipt,'use',g.uses+1,'max_uses',g.max_uses,
    'expires_at',g.expires_at);
end $$;

-- ---------------------------------------------------------------------------
-- Agent RPCs (Binding token hash).

create function public.clued_owner_request_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings; v_scope text:=coalesce(p_input->>'scope','global');
  v_resources text[]; v_task public.clued_memories%rowtype; v_req clued_private.owner_requests_v1%rowtype;
  v_receipt uuid; v_expires_s integer; v_max integer; v_note text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'owner_request_input_invalid' using errcode='22023'; end if;
  if exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('scope','action','resources','task_id','suggested_grant','agent_note','idempotency_key')) then
    raise exception 'owner_request_unknown_field' using errcode='22023'; end if;
  if v_scope !~ '^(global|project:[0-9a-fA-F-]{36})$' then
    raise exception 'owner_request_scope_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  if char_length(coalesce(p_input->>'idempotency_key','')) not between 8 and 160 then
    raise exception 'owner_request_idempotency_key_required' using errcode='22023'; end if;
  perform clued_private.owner_grant_lock_v1(v_binding.user_id);
  select * into v_req from clued_private.owner_requests_v1
    where user_id=v_binding.user_id and binding_id=v_binding.id and idempotency_key=p_input->>'idempotency_key';
  if found then
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_req.receipt_id,
      'request',clued_private.owner_request_public_v1(v_req));
  end if;
  if not exists(select 1 from clued_private.owner_grant_actions where action=p_input->>'action') then
    raise exception 'owner_grant_action_unknown' using errcode='22023'; end if;
  v_resources:=clued_private.work_claim_normalize_paths(p_input->'resources');
  if cardinality(v_resources)>50 then raise exception 'owner_request_resources_invalid' using errcode='22023'; end if;
  if p_input ? 'task_id' then v_task:=clued_private.work_claim_task(v_binding.user_id,v_scope,p_input->>'task_id'); end if;
  if p_input ? 'suggested_grant' then
    if jsonb_typeof(p_input->'suggested_grant') is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input->'suggested_grant') k where k not in ('expires_seconds','max_uses')) then
      raise exception 'owner_request_suggested_grant_invalid' using errcode='22023'; end if;
    begin
      v_expires_s:=(p_input->'suggested_grant'->>'expires_seconds')::integer;
      v_max:=(p_input->'suggested_grant'->>'max_uses')::integer;
    exception when others then raise exception 'owner_request_suggested_grant_invalid' using errcode='22023'; end;
    if (v_expires_s is not null and v_expires_s not between 60 and 604800)
      or (v_max is not null and v_max not between 1 and 1000) then
      raise exception 'owner_request_suggested_grant_invalid' using errcode='22023'; end if;
  end if;
  if p_input ? 'agent_note' then
    if jsonb_typeof(p_input->'agent_note') is distinct from 'string'
      or char_length(btrim(p_input->>'agent_note')) not between 1 and 2000 then
      raise exception 'owner_request_agent_note_invalid' using errcode='22023'; end if;
    v_note:=btrim(p_input->>'agent_note');
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,v_scope,'owner_request_create','owner_request',p_input->>'idempotency_key',1,
    jsonb_build_object('receipt_kind','OWNER_REQUEST_CREATED','action',p_input->>'action',
      'resources',to_jsonb(v_resources),'task_id',v_task.id))
  returning id into v_receipt;
  insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,task_id,
    suggested_expires_seconds,suggested_max_uses,agent_note,expires_at,receipt_id)
  values(v_binding.user_id,v_binding.id,p_input->>'idempotency_key',p_input->>'action',v_resources,v_task.id,
    v_expires_s,v_max,v_note,clock_timestamp()+interval '24 hours',v_receipt)
  returning * into v_req;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'request',clued_private.owner_request_public_v1(v_req));
end $$;

create function public.clued_owner_request_status_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings; v_req clued_private.owner_requests_v1%rowtype;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(p_input->>'request_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'owner_request_id_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
  select * into v_req from clued_private.owner_requests_v1
    where id=(p_input->>'request_id')::uuid and user_id=v_binding.user_id;
  if not found then return jsonb_build_object('status','rejected','error_code','owner_request_not_found'); end if;
  return jsonb_build_object('status','ok','request',clued_private.owner_request_public_v1(v_req));
end $$;

-- ---------------------------------------------------------------------------
-- Owner RPCs (Native account session).

create function public.clued_owner_request_view_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_req clued_private.owner_requests_v1%rowtype;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(p_input->>'request_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'owner_request_id_invalid' using errcode='22023'; end if;
  select * into v_req from clued_private.owner_requests_v1 where id=(p_input->>'request_id')::uuid and user_id=v_owner;
  if not found then return jsonb_build_object('status','rejected','error_code','owner_request_not_found'); end if;
  return jsonb_build_object('status','ok','request',clued_private.owner_request_public_v1(v_req),
    'view',clued_private.owner_grant_view_v1(v_owner,jsonb_build_object('request_id',v_req.id,'action',v_req.action,
      'resources',to_jsonb(v_req.resources),'task_id',v_req.task_id,'grantee_binding_id',v_req.binding_id,
      'choice','grant','expires_seconds',coalesce(v_req.suggested_expires_seconds,14400),
      'max_uses',v_req.suggested_max_uses)));
end $$;

-- Step 1. Input: {request_id, choice: once|grant, expires_seconds?, max_uses?,
-- grantee?: requester|any_agent} for a request, or {action, resources,
-- task_id?, scope?, expires_seconds?, max_uses?} for a grant the Owner starts
-- (any Agent). The page calls it on open; the token covers exactly that view.
create function public.clued_owner_grant_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_req clued_private.owner_requests_v1%rowtype;
  v_choices jsonb; v_view jsonb; v_digest text; v_raw text; v_token_id uuid; v_expires timestamptz;
  v_choice text; v_seconds integer; v_max integer; v_resources text[]; v_task public.clued_memories%rowtype;
  v_subject text; v_error text; v_now timestamptz;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object' then
      raise exception 'owner_grant_input_invalid' using errcode='22023'; end if;
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in
        ('request_id','choice','expires_seconds','max_uses','grantee','action','resources','task_id','scope')) then
      raise exception 'owner_grant_unknown_field' using errcode='22023'; end if;
    perform clued_private.owner_grant_lock_v1(v_owner);
    begin
      v_seconds:=(p_input->>'expires_seconds')::integer;
      v_max:=(p_input->>'max_uses')::integer;
    exception when others then raise exception 'owner_grant_limits_invalid' using errcode='22023'; end;
    if p_input ? 'request_id' then
      if exists(select 1 from jsonb_object_keys(p_input) k where k in ('action','resources','task_id','scope')) then
        raise exception 'owner_grant_request_fields_fixed' using errcode='22023'; end if;
      select * into v_req from clued_private.owner_requests_v1
        where id=(p_input->>'request_id')::uuid and user_id=v_owner for update;
      if not found then raise exception 'owner_request_not_found' using errcode='22023'; end if;
      if v_req.status<>'pending' then raise exception 'owner_request_decided' using errcode='55000'; end if;
      if v_req.expires_at<=clock_timestamp() then raise exception 'owner_request_expired' using errcode='55000'; end if;
      v_choice:=coalesce(p_input->>'choice','grant');
      if v_choice not in ('once','grant') then raise exception 'owner_grant_choice_invalid' using errcode='22023'; end if;
      if coalesce(p_input->>'grantee','requester') not in ('requester','any_agent') then
        raise exception 'owner_grant_grantee_invalid' using errcode='22023'; end if;
      if v_choice='once' then v_seconds:=86400; v_max:=1;
      else v_seconds:=coalesce(v_seconds,v_req.suggested_expires_seconds,14400); v_max:=coalesce(v_max,v_req.suggested_max_uses);
      end if;
      v_choices:=jsonb_build_object('request_id',v_req.id,'action',v_req.action,'resources',to_jsonb(v_req.resources),
        'task_id',v_req.task_id,'choice',v_choice,'expires_seconds',v_seconds,'max_uses',v_max,
        'grantee_binding_id',case when coalesce(p_input->>'grantee','requester')='any_agent' then null else v_req.binding_id end);
      v_subject:=v_req.id::text;
    else
      if p_input ? 'choice' or p_input ? 'grantee' then
        raise exception 'owner_grant_direct_fields_invalid' using errcode='22023'; end if;
      if not exists(select 1 from clued_private.owner_grant_actions where action=p_input->>'action') then
        raise exception 'owner_grant_action_unknown' using errcode='22023'; end if;
      v_resources:=clued_private.work_claim_normalize_paths(p_input->'resources');
      if cardinality(v_resources)>50 then raise exception 'owner_grant_resources_invalid' using errcode='22023'; end if;
      if p_input ? 'task_id' then
        v_task:=clued_private.work_claim_task(v_owner,coalesce(p_input->>'scope','global'),p_input->>'task_id'); end if;
      v_seconds:=coalesce(v_seconds,14400);
      v_choices:=jsonb_build_object('request_id',null,'action',p_input->>'action','resources',to_jsonb(v_resources),
        'task_id',v_task.id,'choice','grant','expires_seconds',v_seconds,'max_uses',v_max,'grantee_binding_id',null);
      v_subject:='direct:'||(p_input->>'action');
    end if;
    if v_seconds not between 60 and 604800 then raise exception 'owner_grant_duration_invalid' using errcode='22023'; end if;
    if v_max is not null and v_max not between 1 and 1000 then raise exception 'owner_grant_limits_invalid' using errcode='22023'; end if;
    v_view:=clued_private.owner_grant_view_v1(v_owner,v_choices);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='owner_grant' and subject_key=v_subject and consumed_at is null and revoked_at is null;
    v_raw:='clued_ogr_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'owner_grant',v_subject,0,v_choices,v_view,v_digest,
      encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),
      coalesce(clued_private.native_auth_time_v1(),v_now),v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,'expires_at',v_expires,
      'confirmation_view',v_view,'view_digest',v_digest,'authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '42501' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2: consume the token, re-render the view, write the grant.
create function public.clued_owner_grant_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; v_grant clued_private.owner_grants_v1%rowtype; v_req clued_private.owner_requests_v1%rowtype;
  v_receipt uuid; v_now timestamptz; v_error text; v_state text; c jsonb;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'owner_grant_unknown_field' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    perform clued_private.owner_grant_lock_v1(v_owner);
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=v_owner and t.action='owner_grant' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      select * into v_grant from clued_private.owner_grants_v1 where token_id=v_token.id;
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_grant.receipt_id,
        'grant',jsonb_build_object('grant_id',v_grant.id,'expires_at',v_grant.expires_at,'max_uses',v_grant.max_uses));
    end if;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
    if coalesce(p_input->>'view_digest','')<>v_token.view_digest
      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    c:=v_token.native_choices;
    if c->>'request_id' is not null then
      select * into v_req from clued_private.owner_requests_v1 where id=(c->>'request_id')::uuid for update;
      if v_req.status<>'pending' then raise exception 'owner_request_decided' using errcode='55000'; end if;
      if v_req.expires_at<=clock_timestamp() then raise exception 'owner_request_expired' using errcode='55000'; end if;
    end if;
    if clued_private.m1_sha256(clued_private.owner_grant_view_v1(v_owner,c))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','owner_grant','owner_grant',coalesce(c->>'request_id',v_token.subject_key),1,
      jsonb_build_object('receipt_kind','OWNER_GRANT_GIVEN','choices',c,'token_id',v_token.id,
        'view_digest',v_token.view_digest,'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    insert into clued_private.owner_grants_v1(user_id,grantee_binding_id,action,resources,task_id,max_uses,
      granted_at,expires_at,request_id,token_id,receipt_id,granted_session_id)
    values(v_owner,(c->>'grantee_binding_id')::uuid,c->>'action',
      array(select jsonb_array_elements_text(c->'resources')),(c->>'task_id')::uuid,(c->>'max_uses')::integer,
      v_now,v_now+make_interval(secs=>(c->>'expires_seconds')::integer),(c->>'request_id')::uuid,
      v_token.id,v_receipt,v_token.session_id)
    returning * into v_grant;
    if v_req.id is not null then
      update clued_private.owner_requests_v1 set status=case when c->>'choice'='once' then 'approved_once' else 'granted' end,
        grant_id=v_grant.id,decided_at=v_now where id=v_req.id;
    end if;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'grant',jsonb_build_object('grant_id',v_grant.id,'action',v_grant.action,'resources',to_jsonb(v_grant.resources),
        'task_id',v_grant.task_id,'any_agent',v_grant.grantee_binding_id is null,'expires_at',v_grant.expires_at,
        'max_uses',v_grant.max_uses));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','owner_grant','owner_grant',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','OWNER_GRANT_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

create function public.clued_owner_request_reject_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_req clued_private.owner_requests_v1%rowtype; v_receipt uuid;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(p_input->>'request_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'owner_request_id_invalid' using errcode='22023'; end if;
  perform clued_private.owner_grant_lock_v1(v_owner);
  select * into v_req from clued_private.owner_requests_v1
    where id=(p_input->>'request_id')::uuid and user_id=v_owner for update;
  if not found then return jsonb_build_object('status','rejected','error_code','owner_request_not_found'); end if;
  if v_req.status<>'pending' then return jsonb_build_object('status','rejected','error_code','owner_request_decided'); end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,'global','owner_request_reject','owner_request',v_req.id::text,1,
    jsonb_build_object('receipt_kind','OWNER_REQUEST_REJECTED','principal','native_account_session'))
  returning id into v_receipt;
  update clued_private.owner_requests_v1 set status='rejected',decided_at=clock_timestamp() where id=v_req.id
    returning * into v_req;
  return jsonb_build_object('status','committed','receipt_id',v_receipt,'request',clued_private.owner_request_public_v1(v_req));
end $$;

create function public.clued_owner_grant_revoke_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); g clued_private.owner_grants_v1%rowtype; v_receipt uuid;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(p_input->>'grant_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'owner_grant_id_invalid' using errcode='22023'; end if;
  perform clued_private.owner_grant_lock_v1(v_owner);
  select * into g from clued_private.owner_grants_v1 where id=(p_input->>'grant_id')::uuid and user_id=v_owner for update;
  if not found then return jsonb_build_object('status','rejected','error_code','owner_grant_not_found'); end if;
  if g.revoked_at is not null then return jsonb_build_object('status','committed','replayed',true); end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,'global','owner_grant_revoke','owner_grant',g.id::text,g.uses+1,
    jsonb_build_object('receipt_kind','OWNER_GRANT_REVOKED','principal','native_account_session'))
  returning id into v_receipt;
  update clued_private.owner_grants_v1 set revoked_at=clock_timestamp() where id=g.id;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,'grant_id',g.id);
end $$;

create function public.clued_owner_grants_list_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  return jsonb_build_object('status','ok',
    'grants',coalesce((select jsonb_agg(jsonb_build_object('grant_id',g.id,'action',g.action,
        'action_title',a.title,'resources',to_jsonb(g.resources),'task_id',g.task_id,
        'any_agent',g.grantee_binding_id is null,'agent_name',b.agent_name,'granted_at',g.granted_at,
        'expires_at',g.expires_at,'max_uses',g.max_uses,'uses',g.uses) order by g.expires_at)
      from clued_private.owner_grants_v1 g join clued_private.owner_grant_actions a on a.action=g.action
      left join public.clued_agent_bindings b on b.id=g.grantee_binding_id
      where g.user_id=v_owner and g.revoked_at is null and g.expires_at>clock_timestamp()
        and (g.max_uses is null or g.uses<g.max_uses)),'[]'::jsonb),
    'pending_requests',coalesce((select jsonb_agg(clued_private.owner_request_public_v1(r) order by r.created_at)
      from clued_private.owner_requests_v1 r
      where r.user_id=v_owner and r.status='pending' and r.expires_at>clock_timestamp()),'[]'::jsonb));
end $$;

revoke all on function
  clued_private.owner_grant_lock_v1(uuid),
  clued_private.owner_grant_covers_v1(text[],text),
  clued_private.owner_request_public_v1(clued_private.owner_requests_v1),
  clued_private.owner_grant_view_v1(uuid,jsonb),
  clued_private.owner_grant_consume_v1(uuid,uuid,text,text[],uuid)
from public,anon,authenticated,service_role;

revoke all on function
  public.clued_owner_request_v1(text,jsonb),
  public.clued_owner_request_status_v1(text,jsonb),
  public.clued_owner_request_view_v1(jsonb),
  public.clued_owner_grant_confirmation_issue_v1(jsonb),
  public.clued_owner_grant_v1(jsonb),
  public.clued_owner_request_reject_v1(jsonb),
  public.clued_owner_grant_revoke_v1(jsonb),
  public.clued_owner_grants_list_v1(jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.clued_owner_request_v1(text,jsonb),public.clued_owner_request_status_v1(text,jsonb)
  to anon;
grant execute on function public.clued_owner_request_view_v1(jsonb),public.clued_owner_grant_confirmation_issue_v1(jsonb),
  public.clued_owner_grant_v1(jsonb),public.clued_owner_request_reject_v1(jsonb),public.clued_owner_grant_revoke_v1(jsonb),
  public.clued_owner_grants_list_v1(jsonb)
  to authenticated;
