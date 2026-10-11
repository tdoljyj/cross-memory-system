-- Task 6176fdcc; Owner Decision c0e9b0f0, option A.
-- Staged compatibility: activation is a separate reviewed migration after
-- the Worker, CI publication/revocation and runner consumers are qualified.
-- Existing GW80/CI8 entry points are retained. Head authorization is a
-- private-key command of clued_work_renew_v1, not a new public caller grant.

alter table clued_private.work_claims_v1
  add column execution_epoch bigint not null default 1 check (execution_epoch > 0),
  add column execution_handover_pending boolean not null default false;

create table clued_private.work_claim_execution_policy_v1 (
  singleton boolean primary key default true check (singleton),
  activated_at timestamptz,
  qualification_commit text check (qualification_commit is null or qualification_commit ~ '^[0-9a-f]{40}$'),
  check (activated_at is null or qualification_commit is not null)
);
insert into clued_private.work_claim_execution_policy_v1(singleton) values(true);
alter table clued_private.work_claim_execution_policy_v1 enable row level security;
revoke all on clued_private.work_claim_execution_policy_v1 from public,anon,authenticated,service_role;

create function clued_private.work_claim_execution_policy_guard_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.activated_at is not null and new.activated_at is null then
    raise exception 'work_claim_execution_cannot_restore_legacy_access' using errcode='42501';
  end if;
  return new;
end $$;

create or replace function clued_private.work_claim_ref_valid_v1(p_ref jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(p_ref) is distinct from 'object' then return false; end if;
  return p_ref ?& array['claim_id','fence']
    and p_ref-array['claim_id','fence','lease_key']='{}'::jsonb
    and jsonb_typeof(p_ref->'claim_id')='string'
    and p_ref->>'claim_id' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    and jsonb_typeof(p_ref->'fence')='number' and p_ref->>'fence' ~ '^[1-9][0-9]*$'
    and (not(p_ref ? 'lease_key') or (jsonb_typeof(p_ref->'lease_key')='string'
      and p_ref->>'lease_key' ~ '^clued_lk_[0-9a-f]{64}$'));
end $$;

do $copy_storage_gate$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_gate_v1(uuid,uuid,text,text,text,text[],jsonb)'::regprocedure);
  body:=replace(body,'FUNCTION clued_private.work_claim_gate_v1(',
    'FUNCTION clued_private.work_claim_gate_before_execution_v1(');
  if position('FUNCTION clued_private.work_claim_gate_before_execution_v1(' in body)=0 then
    raise exception 'work_claim_storage_gate_source_unexpected'; end if;
  execute body;
end $copy_storage_gate$;
revoke all on function clued_private.work_claim_gate_before_execution_v1(uuid,uuid,text,text,text,text[],jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function clued_private.work_claim_gate_v1(p_user uuid,p_binding uuid,p_door text,p_operation text,
  p_mode text,p_resources text[],p_claim jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; b public.clued_agent_bindings%rowtype; code text;
begin
  if p_mode not in ('collision_only','require_claim') or p_door is null or p_operation is null then
    raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
  if p_claim is not null then
    if not clued_private.work_claim_ref_valid_v1(p_claim) then
      raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
    -- Before the empty-resource shortcut, staging consumption or job creation.
    perform clued_private.work_claim_lock(p_user);
    select * into c from clued_private.work_claims_v1 where user_id=p_user
      and claim_id=(p_claim->>'claim_id')::uuid for update;
    if not found then code:='work_claim_not_found';
    elsif c.holder_binding_id is distinct from p_binding then code:='work_claim_not_holder';
    elsif c.outcome='not_adopted' then code:='copy_not_adopted';
    elsif c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then code:='work_claim_not_active';
    elsif c.fence<>(p_claim->>'fence')::bigint then code:='work_claim_fence_mismatch'; end if;
    if code is null and (c.execution_handover_pending or p_claim ? 'lease_key'
      or (c.lease_key_required and clued_private.work_claim_execution_enabled_v1())) then
      code:=clued_private.work_claim_execution_key_error_v1(c,p_binding,p_claim->>'lease_key');
    end if;
    if code is not null then
      select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_user;
      if b.id is null then raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
      return clued_private.work_claim_reject_log_v1(b,coalesce(c.context_key,'global'),c.task_id,
        (p_claim->>'claim_id')::uuid,p_door||':'||p_operation,code,
        jsonb_build_object('door',p_door,'resources',coalesce(to_jsonb(p_resources),'[]'::jsonb)));
    end if;
  end if;
  return clued_private.work_claim_gate_before_execution_v1(p_user,p_binding,p_door,p_operation,p_mode,
    p_resources,case when p_claim is null then null else p_claim-'lease_key' end);
end $$;
create trigger work_claim_execution_policy_guard_v1 before update on clued_private.work_claim_execution_policy_v1
  for each row execute function clued_private.work_claim_execution_policy_guard_v1();
revoke all on function clued_private.work_claim_execution_policy_guard_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;

create table clued_private.work_claim_head_authorizations_v1 (
  authorization_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  claim_id uuid not null references clued_private.work_claims_v1(claim_id),
  execution_epoch bigint not null check (execution_epoch > 0),
  binding_id uuid not null references public.clued_agent_bindings(id),
  copy_index integer,
  repository text not null check (repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  target_branch text not null check (length(target_branch) between 1 and 200 and target_branch !~ '[[:space:]]'),
  pr_ref text,
  workflow text,
  idempotency_key text not null,
  request_digest text not null,
  issued_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique(user_id,claim_id,execution_epoch,idempotency_key),
  check (pr_ref is null or pr_ref ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$'),
  check (workflow is null or workflow ~ '^[A-Za-z0-9_.-]{1,200}\.ya?ml$')
);
create index work_claim_head_authorizations_live_v1
  on clued_private.work_claim_head_authorizations_v1(claim_id,execution_epoch,head_sha)
  where revoked_at is null;
alter table clued_private.work_claim_head_authorizations_v1 enable row level security;
revoke all on clued_private.work_claim_head_authorizations_v1 from public,anon,authenticated,service_role;

create function clued_private.work_claim_execution_enabled_v1() returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select activated_at is not null
    from clued_private.work_claim_execution_policy_v1 where singleton),false)
$$;

-- A fresh claim/takeover cannot make the same guarded Task lose its private
-- credential requirement. Ordinary Tasks remain compatible.
create function clued_private.work_claim_execution_inherit_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if clued_private.work_claim_execution_enabled_v1() and exists(
      select 1 from clued_private.work_claims_v1 prior where prior.user_id=new.user_id
        and prior.task_id=new.task_id and prior.lease_key_required) then
    new.lease_key_required:=true;
  end if;
  return new;
end $$;
create trigger work_claim_execution_inherit_v1 before insert on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_execution_inherit_v1();
revoke all on function clued_private.work_claim_execution_inherit_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;

do $execution_views$
declare body text; anchor text;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_view(clued_private.work_claims_v1)'::regprocedure);
  anchor:=$a$'lease_key_required',c.lease_key_required,$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_execution_view_source_unexpected'; end if;
  execute replace(body,anchor,$a$'lease_key_required',c.lease_key_required,
    'execution_epoch',c.execution_epoch,'execution_handover_pending',c.execution_handover_pending,$a$);
end $execution_views$;

-- Proof is always the current private key, including the current Binding.
-- A public fence, a session label and a same-Binding caller are not proof.
create function clued_private.work_claim_execution_key_error_v1(
  c clued_private.work_claims_v1,p_binding uuid,p_key text) returns text
language sql stable security definer set search_path='' as $$
  select case
    when c.claim_id is null then 'work_claim_not_found'
    when c.execution_handover_pending then 'work_claim_handover_pending'
    when c.holder_binding_id is distinct from p_binding then 'work_claim_not_holder'
    when c.outcome='not_adopted' then 'copy_not_adopted'
    when c.status <> 'ACTIVE' or c.expires_at <= clock_timestamp() then 'work_claim_not_active'
    when p_key is null then 'work_claim_lease_key_required'
    when p_key !~ '^clued_lk_[0-9a-f]{64}$' or c.lease_key_hash is null
      or clued_private.work_claim_lease_key_hash_v1(p_key) is distinct from c.lease_key_hash
      then 'work_claim_lease_key_invalid'
    else null end
$$;

create function clued_private.work_claim_authorize_head_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare
  b public.clued_agent_bindings%rowtype;
  c clued_private.work_claims_v1%rowtype;
  a clued_private.work_claim_head_authorizations_v1%rowtype;
  wanted_scope text:=coalesce(p_input->>'scope','global');
  repo text:=lower(p_input->>'repository');
  head text:=lower(p_input->>'head_sha');
  branch text:=p_input->>'target_branch';
  pull_ref text:=nullif(p_input->>'pr_ref','');
  wf text:=nullif(p_input->>'workflow','');
  safe_request jsonb; digest text; code text; receipt uuid;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['scope','claim_id','fence','lease_version','progress_ref','lease_key','action',
      'repository','head_sha','target_branch','pr_ref','workflow','idempotency_key',
      'holder_client','holder_label','holder_session_ref','holder_session_title']<>'{}'::jsonb
    or coalesce(p_input->>'action','')<>'authorize_head'
    or jsonb_typeof(p_input->'claim_id') is distinct from 'string'
    or jsonb_typeof(p_input->'fence') is distinct from 'number'
    or jsonb_typeof(p_input->'lease_version') is distinct from 'number'
    or jsonb_typeof(p_input->'repository') is distinct from 'string'
    or jsonb_typeof(p_input->'head_sha') is distinct from 'string'
    or jsonb_typeof(p_input->'target_branch') is distinct from 'string'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or coalesce(p_input->>'claim_id','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    or coalesce(p_input->>'fence','') !~ '^[1-9][0-9]*$'
    or coalesce(p_input->>'lease_version','') !~ '^[1-9][0-9]*$'
    or coalesce(repo,'') !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
    or coalesce(head,'') !~ '^[0-9a-f]{40}$'
    or coalesce(length(branch),0) not between 1 and 200 or branch ~ '[[:space:]]'
    or (pull_ref is not null and (pull_ref !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$'
      or lower(split_part(pull_ref,'#',1))<>repo))
    or (wf is not null and wf !~ '^[A-Za-z0-9_.-]{1,200}\.ya?ml$')
    or (pull_ref is not null and wf is not null) then
    raise exception 'work_claim_head_authorization_input_invalid' using errcode='22023';
  end if;
  perform clued_private.work_claim_idempotency(p_input->>'idempotency_key');
  b:=clued_private.resolve_binding(p_token_hash,'context:write',wanted_scope);
  perform clued_private.work_claim_lock(b.user_id);
  select * into c from clued_private.work_claims_v1 w
    where w.user_id=b.user_id and w.context_key=wanted_scope and w.claim_id=(p_input->>'claim_id')::uuid for update;
  code:=clued_private.work_claim_execution_key_error_v1(c,b.id,p_input->>'lease_key');
  if code is null and c.fence<>(p_input->>'fence')::bigint then code:='work_claim_fence_mismatch'; end if;
  if code is null and c.lease_version<>(p_input->>'lease_version')::bigint then code:='work_claim_version_conflict'; end if;
  if code is null and c.bound_pr is not null and (pull_ref is distinct from c.bound_pr) then
    code:='claim_bound_to_other_pr'; end if;
  if code is not null then
    return clued_private.work_claim_reject_log_v1(b,wanted_scope,c.task_id,c.claim_id,
      'work_claim_authorize_head',code,'{}'::jsonb);
  end if;
  -- This digest names public business intent only. Neither the key nor its
  -- hash enters an authorization row, Event, Receipt or response.
  safe_request:=jsonb_build_object('scope',wanted_scope,'claim_id',c.claim_id,
    'execution_epoch',c.execution_epoch,'repository',repo,'head_sha',head,
    'target_branch',branch,'pr_ref',pull_ref,'workflow',wf);
  digest:=clued_private.m1_sha256(safe_request);
  select * into a from clued_private.work_claim_head_authorizations_v1
    where user_id=b.user_id and claim_id=c.claim_id and execution_epoch=c.execution_epoch
      and idempotency_key=p_input->>'idempotency_key' for update;
  if found then
    if a.request_digest<>digest or a.revoked_at is not null then
      return clued_private.work_claim_reject_log_v1(b,wanted_scope,c.task_id,c.claim_id,
        'work_claim_authorize_head','work_claim_authorization_idempotency_conflict','{}'::jsonb);
    end if;
    return jsonb_build_object('status','committed','replayed',true,'authorization_id',a.authorization_id,
      'execution_epoch',a.execution_epoch,'head_sha',a.head_sha);
  end if;
  insert into clued_private.work_claim_head_authorizations_v1
    (user_id,claim_id,execution_epoch,binding_id,copy_index,repository,head_sha,target_branch,
      pr_ref,workflow,idempotency_key,request_digest)
  values(b.user_id,c.claim_id,c.execution_epoch,b.id,c.copy_index,repo,head,branch,
    pull_ref,wf,p_input->>'idempotency_key',digest) returning * into a;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(b.user_id,b.id,wanted_scope,'work_claim_authorize_head','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_HEAD_AUTHORIZED','authorization_id',a.authorization_id,
      'execution_epoch',c.execution_epoch,'repository',repo,'head_sha',head,'target_branch',branch,
      'pr_ref',pull_ref,'workflow',wf,'copy_index',c.copy_index)) returning id into receipt;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',receipt,
    'authorization_id',a.authorization_id,'execution_epoch',c.execution_epoch,'head_sha',head);
end $$;

revoke all on function
  clued_private.work_claim_execution_enabled_v1(),
  clued_private.work_claim_execution_key_error_v1(clued_private.work_claims_v1,uuid,text),
  clued_private.work_claim_authorize_head_v1(text,jsonb)
from public,anon,authenticated,service_role;

-- Keep the original RPC OID and its exact GW80 caller ACL. The copied
-- implementation is private and is never a new raw Binding entry point.
do $copy_renew$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_renew_v1(text,jsonb)'::regprocedure);
  body:=replace(body,'FUNCTION public.clued_work_renew_v1(',
    'FUNCTION clued_private.work_claim_renew_before_execution_v1(');
  if position('FUNCTION clued_private.work_claim_renew_before_execution_v1(' in body)=0 then
    raise exception 'work_claim_renew_source_unexpected';
  end if;
  execute body;
end $copy_renew$;
revoke all on function clued_private.work_claim_renew_before_execution_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function public.clued_work_renew_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
begin
  if p_input->>'action'='authorize_head' then
    return clued_private.work_claim_authorize_head_v1(p_token_hash,p_input);
  end if;
  if p_input ? 'action' then raise exception 'work_claim_action_invalid' using errcode='22023'; end if;
  b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  perform clued_private.work_claim_lock(b.user_id);
  if coalesce(p_input->>'claim_id','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id
      and claim_id=(p_input->>'claim_id')::uuid;
    if c.execution_handover_pending then
      return clued_private.work_claim_reject_log_v1(b,c.context_key,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_handover_pending','{}'::jsonb);
    end if;
  end if;
  return clued_private.work_claim_renew_before_execution_v1(p_token_hash,p_input);
end $$;

-- A generation change is serialized by the existing claim/user lock. It
-- never resets admitted_heads, the bound PR, quota or immutable history.
create function clued_private.work_claim_execution_epoch_trigger_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.fence is distinct from old.fence
    or new.holder_binding_id is distinct from old.holder_binding_id
    or (new.execution_handover_pending and not old.execution_handover_pending)
    or (new.lease_key_required and not old.lease_key_required and not old.execution_handover_pending) then
    new.execution_epoch:=old.execution_epoch+1;
  end if;
  if new.execution_epoch<old.execution_epoch then
    raise exception 'work_claim_execution_epoch_regression' using errcode='22023';
  end if;
  if new.execution_epoch<>old.execution_epoch then
    update clued_private.work_claim_head_authorizations_v1 set revoked_at=clock_timestamp()
      where claim_id=old.claim_id and revoked_at is null;
  end if;
  return new;
end $$;
create trigger work_claim_execution_epoch_v1 before update on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_execution_epoch_trigger_v1();
revoke all on function clued_private.work_claim_execution_epoch_trigger_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;

do $copy_lease_access$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_lease_access_v1(clued_private.work_claims_v1,uuid,jsonb)'::regprocedure);
  body:=replace(body,'FUNCTION clued_private.work_claim_lease_access_v1(',
    'FUNCTION clued_private.work_claim_lease_access_before_execution_v1(');
  if position('FUNCTION clued_private.work_claim_lease_access_before_execution_v1(' in body)=0 then
    raise exception 'work_claim_lease_access_source_unexpected'; end if;
  execute body;
end $copy_lease_access$;
revoke all on function clued_private.work_claim_lease_access_before_execution_v1(clued_private.work_claims_v1,uuid,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
create or replace function clued_private.work_claim_lease_access_v1(
  c clued_private.work_claims_v1,p_binding_id uuid,p_input jsonb) returns text
language sql stable set search_path='' as $$
  select case when c.execution_handover_pending then 'work_claim_handover_pending'
    else clued_private.work_claim_lease_access_before_execution_v1(c,p_binding_id,p_input) end
$$;

do $copy_verify$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  body:=replace(body,'FUNCTION public.clued_work_verify_v1(',
    'FUNCTION clued_private.work_claim_verify_before_execution_v1(');
  if position('FUNCTION clued_private.work_claim_verify_before_execution_v1(' in body)=0 then
    raise exception 'work_claim_verify_source_unexpected'; end if;
  execute body;
end $copy_verify$;
revoke all on function clued_private.work_claim_verify_before_execution_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- CI-derived footprints let both the runner and the external revoker observe
-- the epoch that actually admitted a target. This is never a holder credential.
create table clued_private.work_claim_execution_admissions_v1 (
  admission_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  claim_id uuid not null references clued_private.work_claims_v1(claim_id),
  execution_epoch bigint not null,
  ci_binding_id uuid not null references public.clued_agent_bindings(id),
  repository text not null,
  head_sha text not null check(head_sha ~ '^[0-9a-f]{40}$'),
  target_branch text not null,
  pr_ref text,
  workflow text,
  resources_digest text not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table clued_private.work_claim_execution_admissions_v1 enable row level security;
create index work_claim_execution_admissions_target_v1 on clued_private.work_claim_execution_admissions_v1(repository,head_sha);
create index work_claim_execution_admissions_claim_v1 on clued_private.work_claim_execution_admissions_v1(claim_id,execution_epoch);
create index work_claim_execution_guarded_pr_v1 on clued_private.work_claims_v1(bound_pr) where lease_key_required;
revoke all on clued_private.work_claim_execution_admissions_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare
  b public.clued_agent_bindings%rowtype;
  c clued_private.work_claims_v1%rowtype;
  a clued_private.work_claim_head_authorizations_v1%rowtype;
  result jsonb; executing boolean;
  pull_ref text:=nullif(p_input->>'pr_ref','');
  repo text; head text:=lower(p_input->>'head_sha');
  branch text:=p_input->>'target_branch';
  wf text:=nullif(p_input->>'workflow','');
begin
  if p_token_hash is null and p_input->>'action'='execution_current' then
    return clued_private.work_claim_execution_current_v1(p_input-'action');
  end if;
  b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
  perform clued_private.work_claim_lock(b.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    return clued_private.work_claim_verify_before_execution_v1(p_token_hash,p_input);
  end if;
  select * into c from clued_private.work_claims_v1 where user_id=b.user_id
    and context_key=coalesce(p_input->>'scope','global') and claim_id=(p_input->>'claim_id')::uuid for update;
  if c.execution_handover_pending then
    return jsonb_build_object('status','ok','verdict','REJECTED','execution_authorized',false,
      'reasons',jsonb_build_array('work_claim_handover_pending'),'execution_epoch',c.execution_epoch);
  end if;
  executing:=pull_ref is not null or coalesce(p_input->>'ci_dispatch','false')='true';
  if c.lease_key_required and clued_private.work_claim_execution_enabled_v1() and executing then
    if not exists(select 1 from clued_private.binding_roles_v1 where binding_id=b.id
        and user_id=b.user_id and role='ci-admission' and revoked_at is null) then
      return jsonb_build_object('status','ok','verdict','REJECTED','execution_authorized',false,
        'reasons',jsonb_build_array('admission_binding_required'));
    end if;
    repo:=case when pull_ref is not null then lower(split_part(pull_ref,'#',1)) else lower(p_input->>'repository') end;
    if jsonb_typeof(p_input->'head_sha') is distinct from 'string'
      or coalesce(head,'') !~ '^[0-9a-f]{40}$'
      or jsonb_typeof(p_input->'target_branch') is distinct from 'string'
      or branch is null or (pull_ref is null and wf is null) then
      return jsonb_build_object('status','ok','verdict','REJECTED','execution_authorized',false,
        'reasons',jsonb_build_array('head_authorization_target_required'));
    end if;
    select * into a from clued_private.work_claim_head_authorizations_v1
      where user_id=b.user_id and claim_id=c.claim_id and execution_epoch=c.execution_epoch
        and revoked_at is null and repository=repo and head_sha=head and target_branch=branch
        and copy_index is not distinct from c.copy_index
        and workflow is not distinct from wf
        and (pr_ref=pull_ref or pr_ref is null)
      order by issued_at,authorization_id limit 1 for update;
    if not found then
      return jsonb_build_object('status','ok','verdict','REJECTED','execution_authorized',false,
        'reasons',jsonb_build_array('head_authorization_required'),'execution_epoch',c.execution_epoch);
    end if;
  end if;
  result:=clued_private.work_claim_verify_before_execution_v1(p_token_hash,p_input);
  if a.authorization_id is not null and result->>'verdict'='ADMITTED' and a.pr_ref is null and pull_ref is not null then
    update clued_private.work_claim_head_authorizations_v1 set pr_ref=pull_ref where authorization_id=a.authorization_id;
  end if;
  if executing and result->>'verdict'='ADMITTED' and head ~ '^[0-9a-f]{40}$' and branch is not null
    and exists(select 1 from clued_private.binding_roles_v1 where user_id=b.user_id and binding_id=b.id
      and role='ci-admission' and revoked_at is null) then
    insert into clued_private.work_claim_execution_admissions_v1
      (user_id,claim_id,execution_epoch,ci_binding_id,repository,head_sha,target_branch,pr_ref,workflow,resources_digest)
    values(b.user_id,c.claim_id,c.execution_epoch,b.id,
      case when pull_ref is not null then lower(split_part(pull_ref,'#',1)) else lower(p_input->>'repository') end,
      head,branch,pull_ref,wf,clued_private.m1_sha256(jsonb_build_object('write_set',c.write_set,'trigger_refs',c.trigger_refs)));
  end if;
  return result||jsonb_build_object('execution_epoch',c.execution_epoch,
    'execution_authorized',executing and result->>'verdict'='ADMITTED',
    'head_authorization_id',a.authorization_id,
    'execution_policy',case when clued_private.work_claim_execution_enabled_v1() then 'active' else 'staged' end);
end $$;

-- Bounded observation for the existing authenticated GitHub gate/runner.
-- The public answer neither admits a head nor returns a claim, owner, grant,
-- or credential. An unguarded target still needs every existing GitHub gate.
-- A guarded target needs a current CI-derived admission as well.
create function clued_private.work_claim_execution_current_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1; a clued_private.work_claim_execution_admissions_v1;
  holder public.clued_agent_bindings; ci public.clued_agent_bindings; found_guard boolean:=false;
  repo text:=lower(p_input->>'repository'); head text:=p_input->>'head_sha';
  pr text:=nullif(p_input->>'pr_ref',''); wf text:=nullif(p_input->>'workflow',''); branch text:=p_input->>'target_branch';
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['repository','head_sha','pr_ref','workflow','target_branch']<>'{}'::jsonb
    or coalesce(repo,'') !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
    or coalesce(head,'') !~ '^[0-9a-f]{40}$'
    or coalesce(length(branch),0) not between 1 and 200 or branch ~ '[[:space:]]'
    or (pr is not null and (pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$'
      or lower(split_part(pr,'#',1))<>repo))
    or (wf is not null and wf !~ '^[A-Za-z0-9_.-]{1,200}\.ya?ml$')
    or ((pr is null)=(wf is null)) then
    raise exception 'work_claim_execution_observation_invalid' using errcode='22023'; end if;
  if not clued_private.work_claim_execution_enabled_v1() then
    return jsonb_build_object('status','ok','guard_required',false,'epoch_current',null); end if;
  for c in select w.* from clued_private.work_claims_v1 w where w.lease_key_required and (
      (pr is not null and w.bound_pr=pr) or exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
        where e.claim_id=w.claim_id and e.repository=repo and e.head_sha=head
          and e.pr_ref is not distinct from pr and e.workflow is not distinct from wf))
      order by w.updated_at desc limit 100 loop
    found_guard:=true;
    perform clued_private.work_claim_lock(c.user_id);
    select * into c from clued_private.work_claims_v1 where claim_id=c.claim_id;
    if c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() or c.execution_handover_pending
      or c.outcome='not_adopted' then continue; end if;
    if exists(select 1 from clued_private.work_claims_v1 newer where newer.user_id=c.user_id
        and newer.task_id=c.task_id and newer.fence>c.fence) then continue; end if;
    select * into a from clued_private.work_claim_execution_admissions_v1 e where e.claim_id=c.claim_id
      and e.execution_epoch=c.execution_epoch and e.repository=repo and e.head_sha=head
      and e.target_branch=branch and e.pr_ref is not distinct from pr and e.workflow is not distinct from wf
      and e.resources_digest=clued_private.m1_sha256(jsonb_build_object('write_set',c.write_set,'trigger_refs',c.trigger_refs))
      order by e.created_at desc limit 1;
    if a.admission_id is null then continue; end if;
    begin
      select * into holder from public.clued_agent_bindings where id=c.holder_binding_id and user_id=c.user_id;
      perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(holder.token_hash),'context:write',c.context_key);
      select * into ci from public.clued_agent_bindings where id=a.ci_binding_id and user_id=c.user_id;
      perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(ci.token_hash),'context:read',c.context_key);
      perform clued_private.work_claim_task(c.user_id,c.context_key,c.task_id::text);
      if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=c.user_id
          and r.binding_id=ci.id and r.role='ci-admission' and r.revoked_at is null) then continue; end if;
      return jsonb_build_object('status','ok','guard_required',true,'epoch_current',true);
    exception when others then continue;
    end;
  end loop;
  return jsonb_build_object('status','ok','guard_required',found_guard,
    'epoch_current',case when found_guard then false else null end);
end $$;
revoke all on function clued_private.work_claim_execution_current_v1(jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- An async job retains only a server-derived proof of its original work
-- authorization. No credential is persisted in the job or its snapshot.
create table clued_private.work_claim_storage_authorizations_v1 (
  owner_id uuid not null references auth.users(id),
  job_id uuid not null,
  claim_id uuid not null references clued_private.work_claims_v1(claim_id),
  execution_epoch bigint not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  resources text[] not null,
  captured_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,job_id),
  foreign key(owner_id,job_id) references clued_private.storage_jobs_v1(owner_id,job_id)
    deferrable initially deferred
);
alter table clued_private.work_claim_storage_authorizations_v1 enable row level security;
revoke all on clued_private.work_claim_storage_authorizations_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_storage_capture_v1(
  p_owner uuid,p_binding uuid,p_job uuid,p_digest text,p_resources text[],p_ref jsonb
) returns void language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1;
begin
  if p_ref is null then return; end if;
  if not clued_private.work_claim_ref_valid_v1(p_ref) then
    raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(p_owner);
  select * into c from clued_private.work_claims_v1
    where user_id=p_owner and claim_id=(p_ref->>'claim_id')::uuid for update;
  if c.claim_id is null or c.holder_binding_id is distinct from p_binding
    or c.fence is distinct from (p_ref->>'fence')::bigint
    or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp()
    or c.execution_handover_pending then
    raise exception 'work_claim_job_authorization_invalid' using errcode='42501'; end if;
  insert into clued_private.work_claim_storage_authorizations_v1
    (owner_id,job_id,claim_id,execution_epoch,request_digest,resources)
  values(p_owner,p_job,c.claim_id,c.execution_epoch,p_digest,coalesce(p_resources,'{}'::text[]));
end $$;

create function clued_private.work_claim_storage_current_v1(p_owner uuid,p_job uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare a clued_private.work_claim_storage_authorizations_v1;
  c clued_private.work_claims_v1; j clued_private.storage_jobs_v1;
begin
  if not clued_private.work_claim_execution_enabled_v1() then return; end if;
  select * into a from clued_private.work_claim_storage_authorizations_v1
    where owner_id=p_owner and job_id=p_job;
  if a.job_id is null then return; end if;
  -- The claim lock is also held by handover. An admitted provider attempt
  -- and a handover therefore have one transaction order, not two snapshots.
  perform clued_private.work_claim_lock(p_owner);
  select * into c from clued_private.work_claims_v1
    where user_id=p_owner and claim_id=a.claim_id;
  select * into j from clued_private.storage_jobs_v1
    where owner_id=p_owner and job_id=p_job;
  if c.claim_id is null or j.job_id is null or a.request_digest is distinct from j.request_digest
    or c.execution_epoch is distinct from a.execution_epoch or c.execution_handover_pending
    or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp()
    or c.outcome='not_adopted' then
    raise exception 'work_claim_job_epoch_stale' using errcode='42501'; end if;
  if exists(select 1 from unnest(a.resources) resource
      where not clued_private.work_claim_resource_covered_v1(resource,c.write_set)) then
    raise exception 'work_claim_job_resources_changed' using errcode='42501'; end if;
end $$;

-- Patch only the exact existing composition point. If a source moved, do
-- not silently omit the guard or reconstruct a different storage writer.
do $storage_capture$
declare body text; anchor text:=$a$  if gate is not null then return gate; end if;$a$;
  addition text:=$a$
  perform clued_private.work_claim_storage_capture_v1(
    (snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,v_job_id,digest,
    clued_private.work_claim_storage_resources_v1(connection_id,(snapshot->>'profile_id')::uuid,m),
    p_input->'work_claim');$a$;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.storage_jobs_policy_core_v2(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_storage_capture_source_unexpected'; end if;
  execute replace(body,anchor,anchor||addition);
end $storage_capture$;

do $storage_epoch_guards$
declare signature text; body text; anchor text; addition text;
begin
  -- Checking current_v2 covers initial load, authority/preparation, begin
  -- and provider_attempt. Settlement/recovery deliberately uses its own
  -- existing journal path and never acquires another execution permit.
  signature:='clued_private.storage_cloud_job_current_v2(uuid,uuid)';
  body:=pg_catalog.pg_get_functiondef(signature::regprocedure);
  anchor:='  s:=clued_private.storage_policy_evaluate_v2(clued_private.credential_internal_proof_v1(b.token_hash),j.connection_id,wanted,p_job);';
  addition:=E'\n  perform clued_private.work_claim_storage_current_v1(p_owner,p_job);';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_storage_current_source_unexpected'; end if;
  -- Keep issuer/lineage/job/root locks before the claim lock, exactly as
  -- submit does. Handover never takes a storage root lock.
  execute replace(body,anchor,anchor||addition);
end $storage_epoch_guards$;

revoke all on function
  clued_private.work_claim_storage_capture_v1(uuid,uuid,uuid,text,text[],jsonb),
  clued_private.work_claim_storage_current_v1(uuid,uuid)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- A successful GitHub publication is not in the PostgreSQL transaction.
-- Persist its in-flight identity; never expire an uncertain publication and
-- then pretend that no late green check can arrive.
create table clued_private.work_claim_publications_v1 (
  publication_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  claim_id uuid not null references clued_private.work_claims_v1(claim_id),
  execution_epoch bigint not null,
  repository text not null,
  head_sha text not null check(head_sha ~ '^[0-9a-f]{40}$'),
  pr_ref text not null,
  run_id text not null check(run_id ~ '^[0-9]{1,20}$'),
  publication_key uuid not null,
  state text not null default 'open' check(state in ('open','published','reconciled')),
  check_run_id text,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique(claim_id,execution_epoch,publication_key)
);
create table clued_private.work_claim_revocation_outbox_v1 (
  outbox_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  claim_id uuid not null references clued_private.work_claims_v1(claim_id),
  context_key text not null,
  execution_epoch bigint not null,
  repository text not null,
  head_sha text check(head_sha is null or head_sha ~ '^[0-9a-f]{40}$'),
  pr_ref text,
  workflow text,
  state text not null default 'pending' check(state in ('pending','acknowledged')),
  created_at timestamptz not null default clock_timestamp(),
  acknowledged_at timestamptz,
  evidence jsonb,
  unique(claim_id,execution_epoch,repository,head_sha,pr_ref,workflow)
);
alter table clued_private.work_claim_publications_v1 enable row level security;
alter table clued_private.work_claim_revocation_outbox_v1 enable row level security;
revoke all on clued_private.work_claim_publications_v1,clued_private.work_claim_revocation_outbox_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_revocations_capture_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.execution_epoch=old.execution_epoch or not clued_private.work_claim_execution_enabled_v1() then
    return new; end if;
  insert into clued_private.work_claim_revocation_outbox_v1
    (user_id,claim_id,context_key,execution_epoch,repository,head_sha,pr_ref,workflow)
    select distinct old.user_id,old.claim_id,old.context_key,new.execution_epoch,
      a.repository,a.head_sha,a.pr_ref,a.workflow
    from clued_private.work_claim_head_authorizations_v1 a
    where a.claim_id=old.claim_id and a.execution_epoch<new.execution_epoch;
  insert into clued_private.work_claim_revocation_outbox_v1
    (user_id,claim_id,context_key,execution_epoch,repository,head_sha,pr_ref,workflow)
    select distinct old.user_id,old.claim_id,old.context_key,new.execution_epoch,
      a.repository,a.head_sha,a.pr_ref,a.workflow
    from clued_private.work_claim_execution_admissions_v1 a
    where a.claim_id=old.claim_id and a.execution_epoch<new.execution_epoch;
  -- An old bound PR may predate the authorization table. Its live head and
  -- all checks/runs must be enumerated by the trusted revoker as well.
  if old.bound_pr is not null then
    insert into clued_private.work_claim_revocation_outbox_v1
      (user_id,claim_id,context_key,execution_epoch,repository,pr_ref)
    values(old.user_id,old.claim_id,old.context_key,new.execution_epoch,
      lower(split_part(old.bound_pr,'#',1)),old.bound_pr);
  end if;
  new.execution_handover_pending:=true;
  return new;
end $$;
create trigger work_claim_zz_revocations_v1 before update on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_revocations_capture_v1();

create function clued_private.work_claim_ci_command_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.work_claims_v1;
  o clued_private.work_claim_revocation_outbox_v1; p clued_private.work_claim_publications_v1;
  op text:=p_input->>'action'; scope text:=coalesce(p_input->>'scope','global');
  epoch bigint; result jsonb; id uuid; verification_input jsonb;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:read',scope);
  -- A role label supplied in a payload or a read-only Agent connection is
  -- never a CI principal. This is the existing Owner-designated CI Binding.
  if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id
      and r.binding_id=b.id and r.role='ci-admission' and r.revoked_at is null) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  perform clued_private.work_claim_lock(b.user_id);
  if op='revocations_list' then
    if p_input-array['action','scope']<>'{}'::jsonb then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    return jsonb_build_object('status','ok','revocations',coalesce((select jsonb_agg(to_jsonb(x))
      from (select outbox_id,claim_id,execution_epoch,repository,head_sha,pr_ref,workflow
        from clued_private.work_claim_revocation_outbox_v1 where user_id=b.user_id
          and context_key=scope and state='pending' order by created_at,outbox_id limit 100) x),'[]'::jsonb),
      'publications',coalesce((select jsonb_agg(to_jsonb(x)) from (
        select pubs.publication_id,pubs.claim_id,pubs.execution_epoch,pubs.repository,pubs.head_sha,pubs.pr_ref,pubs.run_id,pubs.check_run_id
        from clued_private.work_claim_publications_v1 pubs
          join clued_private.work_claims_v1 claim_row on claim_row.claim_id=pubs.claim_id
        where pubs.user_id=b.user_id and claim_row.context_key=scope and pubs.state='open'
          and pubs.execution_epoch<claim_row.execution_epoch
        order by pubs.started_at,pubs.publication_id limit 100) x),'[]'::jsonb));
  end if;
  if op='revocation_ack' then
    if p_input-array['action','scope','outbox_id','execution_epoch','evidence']<>'{}'::jsonb
      or jsonb_typeof(p_input->'evidence') is distinct from 'object' then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into o from clued_private.work_claim_revocation_outbox_v1
      where user_id=b.user_id and context_key=scope and outbox_id=(p_input->>'outbox_id')::uuid for update;
    if o.outbox_id is null or o.execution_epoch is distinct from (p_input->>'execution_epoch')::bigint then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_stale'); end if;
    select * into c from clued_private.work_claims_v1 where claim_id=o.claim_id and user_id=b.user_id;
    if c.execution_epoch<>o.execution_epoch then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_stale'); end if;
    if exists(select 1 from clued_private.work_claim_publications_v1 where claim_id=c.claim_id
        and execution_epoch<c.execution_epoch and state='open') then
      return jsonb_build_object('status','rejected','error_code','work_claim_publications_unresolved'); end if;
    if p_input->'evidence'->'checks_revoked' is distinct from 'true'::jsonb
      or p_input->'evidence'->'auto_merge_disabled' is distinct from 'true'::jsonb
      or p_input->'evidence'->'dispatch_revoked' is distinct from 'true'::jsonb then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_incomplete'); end if;
    update clued_private.work_claim_revocation_outbox_v1 set state='acknowledged',
      acknowledged_at=clock_timestamp(),evidence=p_input->'evidence' where outbox_id=o.outbox_id;
    return jsonb_build_object('status','committed','outbox_id',o.outbox_id,'execution_epoch',o.execution_epoch);
  end if;
  if op='publication_reconcile' or op='publication_finish' then
    if p_input-array['action','scope','publication_id','check_run_id','checks_revoked','publisher_stopped']<>'{}'::jsonb then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into p from clued_private.work_claim_publications_v1 where user_id=b.user_id
      and publication_id=(p_input->>'publication_id')::uuid for update;
    if p.publication_id is null then return jsonb_build_object('status','rejected','error_code','work_claim_publication_not_found'); end if;
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=p.claim_id and context_key=scope;
    if c.claim_id is null then return jsonb_build_object('status','rejected','error_code','work_claim_publication_not_found'); end if;
    if op='publication_reconcile' then
      if p_input->'checks_revoked' is distinct from 'true'::jsonb
        or p_input->'publisher_stopped' is distinct from 'true'::jsonb
        or coalesce(p_input->>'check_run_id','') !~ '^[0-9]{1,20}$'
        or (p.check_run_id is not null and p.check_run_id<>p_input->>'check_run_id') then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
      update clued_private.work_claim_publications_v1 set state='reconciled',check_run_id=p_input->>'check_run_id',finished_at=clock_timestamp()
        where publication_id=p.publication_id;
    else
      if p.state='reconciled' then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_reconciled'); end if;
      if coalesce(p_input->>'check_run_id','') !~ '^[0-9]{1,20}$' then
        raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
      update clued_private.work_claim_publications_v1 set state=case
        when p.execution_epoch<>c.execution_epoch or c.execution_handover_pending
          or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then 'open' else 'published' end,
        check_run_id=p_input->>'check_run_id',finished_at=clock_timestamp() where publication_id=p.publication_id;
    end if;
    return jsonb_build_object('status','committed','execution_epoch',p.execution_epoch,
      'must_revoke',p.execution_epoch<>c.execution_epoch or c.execution_handover_pending
        or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp());
  end if;
  if op='publication_abort' then
    if p_input-array['action','scope','publication_id','not_sent']<>'{}'::jsonb
      or p_input->'not_sent' is distinct from 'true'::jsonb then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into p from clued_private.work_claim_publications_v1 where user_id=b.user_id
      and publication_id=(p_input->>'publication_id')::uuid for update;
    if p.publication_id is null or p.state<>'open' or p.check_run_id is not null
      or not exists(select 1 from clued_private.work_claims_v1 claim_row
        where claim_row.claim_id=p.claim_id and claim_row.context_key=scope) then
      return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
    update clued_private.work_claim_publications_v1 set state='reconciled',finished_at=clock_timestamp()
      where publication_id=p.publication_id;
    return jsonb_build_object('status','committed','publication_id',p.publication_id);
  end if;
  if op='publication_begin' then
    if coalesce(p_input->>'run_id','') !~ '^[0-9]{1,20}$'
      or coalesce(p_input->>'publication_key','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    verification_input:=p_input-array['action','run_id','publication_key'];
    if not(verification_input ? 'claim_id') then
      select * into c from clued_private.work_claims_v1 where user_id=b.user_id
        and bound_pr=p_input->>'pr_ref' and lease_key_required and status in ('ACTIVE','DRAINING')
        order by updated_at desc limit 1;
      if c.claim_id is null then
        return jsonb_build_object('status','ok','publication_required',false); end if;
      verification_input:=verification_input||jsonb_build_object('claim_id',c.claim_id,'scope',c.context_key);
    end if;
    result:=public.clued_work_verify_v1(p_token_hash,verification_input);
    if result->>'verdict'<>'ADMITTED' then return result; end if;
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id and context_key=verification_input->>'scope'
      and claim_id=(verification_input->>'claim_id')::uuid;
    if not clued_private.work_claim_execution_enabled_v1() or not c.lease_key_required then
      return result||jsonb_build_object('publication_required',false); end if;
    if c.execution_handover_pending or coalesce(p_input->>'pr_ref','')='' then
      return jsonb_build_object('status','rejected','error_code','work_claim_handover_pending'); end if;
    insert into clued_private.work_claim_publications_v1(user_id,claim_id,execution_epoch,repository,
      head_sha,pr_ref,run_id,publication_key) values(b.user_id,c.claim_id,c.execution_epoch,
      lower(split_part(p_input->>'pr_ref','#',1)),p_input->>'head_sha',p_input->>'pr_ref',p_input->>'run_id',
      (p_input->>'publication_key')::uuid)
      on conflict(claim_id,execution_epoch,publication_key) do nothing
      returning publication_id into id;
    if id is null then
      select * into p from clued_private.work_claim_publications_v1 where claim_id=c.claim_id
        and execution_epoch=c.execution_epoch and publication_key=(p_input->>'publication_key')::uuid;
      if p.head_sha is distinct from p_input->>'head_sha' or p.pr_ref is distinct from p_input->>'pr_ref'
        or p.run_id is distinct from p_input->>'run_id' then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_idempotency_conflict'); end if;
      id:=p.publication_id;
    end if;
    return result||jsonb_build_object('publication_required',true,'publication_id',id,'scope',c.context_key);
  end if;
  raise exception 'work_claim_ci_command_invalid' using errcode='22023';
end $$;

-- Reuse the existing CI8 function; no new raw caller or Worker grant.
do $ci_commands$
declare body text; anchor text:=$a$  b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));$a$;
  addition text:=$a$  if p_input ? 'action' then
    return clued_private.work_claim_ci_command_v1(p_token_hash,p_input);
  end if;
$a$;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_ci_command_source_unexpected'; end if;
  execute replace(body,anchor,addition||anchor);
end $ci_commands$;
revoke all on function clued_private.work_claim_ci_command_v1(text,jsonb),
  clued_private.work_claim_revocations_capture_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;

create table clued_private.work_claim_handover_deliveries_v1 (
  delivery_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  claim_id uuid not null references clued_private.work_claims_v1(claim_id),
  execution_epoch bigint not null,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  native_session_id text,
  receiver_binding_id uuid references public.clued_agent_bindings(id),
  receiver_key_hash text,
  delivered_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check ((native_session_id is not null and receiver_binding_id is null and receiver_key_hash is null)
    or (native_session_id is null and receiver_binding_id is not null and receiver_key_hash ~ '^[0-9a-f]{64}$'))
);
alter table clued_private.work_claim_handover_deliveries_v1 enable row level security;
revoke all on clued_private.work_claim_handover_deliveries_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_handover_drained_v1(c clued_private.work_claims_v1)
returns boolean language sql stable security definer set search_path='' as $$
  select not exists(select 1 from clued_private.work_claim_revocation_outbox_v1
    where claim_id=c.claim_id and execution_epoch=c.execution_epoch and state<>'acknowledged')
    and not exists(select 1 from clued_private.work_claim_publications_v1
      where claim_id=c.claim_id and execution_epoch<c.execution_epoch and state='open')
$$;

-- Only a delivered credential completes handover. No plaintext credential
-- is buffered while the external revoker is unavailable.
create function clued_private.work_claim_handover_deliver_v1(d clued_private.work_claim_handover_deliveries_v1)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1; key text; receipt uuid;
begin
  perform clued_private.work_claim_lock(d.user_id);
  select * into c from clued_private.work_claims_v1 where user_id=d.user_id and claim_id=d.claim_id for update;
  if c.execution_epoch is distinct from d.execution_epoch or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
  if d.delivered_at is not null then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_text_already_delivered'); end if;
  if not clued_private.work_claim_handover_drained_v1(c) then
    return jsonb_build_object('status','pending','delivery_id',d.delivery_id,'receipt_id',d.receipt_id,
      'claim',clued_private.work_claim_view(c),'execution_epoch',c.execution_epoch); end if;
  update clued_private.work_claims_v1 set execution_handover_pending=false where claim_id=c.claim_id returning * into c;
  key:=clued_private.work_claim_lease_key_issue_v1(c.claim_id);
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(c.user_id,d.receiver_binding_id,c.context_key,'work_claim_handover_complete','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_HANDOVER_COMPLETED','delivery_id',d.delivery_id,
      'handover_receipt_id',d.receipt_id,'execution_epoch',c.execution_epoch,'claim_id',c.claim_id)) returning id into receipt;
  update clued_private.work_claim_handover_deliveries_v1 set delivered_at=clock_timestamp() where delivery_id=d.delivery_id;
  return jsonb_build_object('status','committed','receipt_id',receipt,'handover_receipt_id',d.receipt_id,
    'claim',clued_private.work_claim_view(c),'lease_key',key,'execution_epoch',c.execution_epoch);
end $$;

do $copy_native_handover$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_claim_handover_v1(jsonb)'::regprocedure);
  body:=replace(body,'FUNCTION public.clued_work_claim_handover_v1(',
    'FUNCTION clued_private.work_claim_native_handover_before_execution_v1(');
  if position('FUNCTION clued_private.work_claim_native_handover_before_execution_v1(' in body)=0 then
    raise exception 'work_claim_native_handover_source_unexpected'; end if;
  body:=replace(body,$a$'receipt_kind','WORK_CLAIM_HANDOVER',$a$,
    $a$'receipt_kind',case when clued_private.work_claim_execution_enabled_v1()
      then 'WORK_CLAIM_HANDOVER_PENDING' else 'WORK_CLAIM_HANDOVER' end,$a$);
  body:=replace(body,'if c.lease_key_hash is null then',
    'if c.lease_key_hash is null and not (c.execution_handover_pending and clued_private.work_claim_execution_enabled_v1()) then');
  execute body;
end $copy_native_handover$;
revoke all on function clued_private.work_claim_native_handover_before_execution_v1(jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

do $native_pending_recovery$
declare body text; anchor text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_claim_handover_confirmation_issue_v1(jsonb)'::regprocedure);
  anchor:='if c.lease_key_hash is null then';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_pending_confirmation_source_unexpected'; end if;
  execute replace(body,anchor,
    'if c.lease_key_hash is null and not (c.execution_handover_pending and clued_private.work_claim_execution_enabled_v1()) then');
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_owner_row_v1(clued_private.work_claims_v1)'::regprocedure);
  anchor:=$a$'handover_available',x.state='ACTIVE' and c.lease_key_hash is not null)$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_pending_owner_view_source_unexpected'; end if;
  execute replace(body,anchor,$a$'handover_available',x.state='ACTIVE' and (c.lease_key_hash is not null or c.execution_handover_pending),
    'execution_epoch',c.execution_epoch,'execution_handover_pending',c.execution_handover_pending,
    'handover_pending_delivery_id',(select delivery_id from clued_private.work_claim_handover_deliveries_v1 d
      where d.user_id=c.user_id and d.claim_id=c.claim_id and d.execution_epoch=c.execution_epoch
        and d.native_session_id=clued_private.native_session_id_v1() and d.delivered_at is null
      order by d.created_at desc limit 1))$a$);
end $native_pending_recovery$;

create or replace function public.clued_work_claim_handover_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); sid text:=clued_private.native_session_id_v1();
  r jsonb; c clued_private.work_claims_v1; d clued_private.work_claim_handover_deliveries_v1;
begin
  if sid is null then raise exception 'confirmation_token_session_id_required' using errcode='42501'; end if;
  perform clued_private.work_claim_lock(owner_id);
  if p_input->>'action'='collect' then
    if p_input-array['action','delivery_id']<>'{}'::jsonb then
      raise exception 'work_claim_handover_input_invalid' using errcode='22023'; end if;
    select * into d from clued_private.work_claim_handover_deliveries_v1
      where user_id=owner_id and delivery_id=(p_input->>'delivery_id')::uuid and native_session_id=sid for update;
    if d.delivery_id is null then return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
    return clued_private.work_claim_handover_deliver_v1(d);
  end if;
  r:=clued_private.work_claim_native_handover_before_execution_v1(p_input);
  if not clued_private.work_claim_execution_enabled_v1() or r->>'status'<>'committed' then return r; end if;
  -- A replay of the confirmation never rotates or rediscloses a key.
  if coalesce((r->>'replayed')::boolean,false) then
    select * into d from clued_private.work_claim_handover_deliveries_v1
      where user_id=owner_id and receipt_id=(r->>'receipt_id')::uuid and native_session_id=sid;
    if d.delivered_at is not null then
      return jsonb_build_object('status','rejected','error_code','work_claim_handover_text_already_delivered',
        'receipt_id',d.receipt_id); end if;
    return (r-'lease_key')||jsonb_build_object('status','pending','delivery_id',d.delivery_id);
  end if;
  select * into c from clued_private.work_claims_v1 where user_id=owner_id
    and claim_id=(r#>>'{claim,claim_id}')::uuid for update;
  update clued_private.work_claims_v1 set lease_key_hash=null,execution_handover_pending=true where claim_id=c.claim_id;
  insert into clued_private.work_claim_handover_deliveries_v1
    (user_id,claim_id,execution_epoch,receipt_id,native_session_id)
  values(owner_id,c.claim_id,c.execution_epoch,(r->>'receipt_id')::uuid,sid) returning * into d;
  return clued_private.work_claim_handover_deliver_v1(d);
end $$;

revoke all on function
  clued_private.work_claim_handover_drained_v1(clued_private.work_claims_v1),
  clued_private.work_claim_handover_deliver_v1(clued_private.work_claim_handover_deliveries_v1)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_receiver_collect_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.work_claims_v1;
  d clued_private.work_claim_handover_deliveries_v1; key text; receipt uuid;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  perform clued_private.work_claim_lock(b.user_id);
  select * into d from clued_private.work_claim_handover_deliveries_v1
    where user_id=b.user_id and receiver_binding_id=b.id
      and delivery_id=(p_input->>'delivery_id')::uuid for update;
  if d.delivery_id is null or coalesce(p_input->>'lease_key','') !~ '^clued_lk_[0-9a-f]{64}$'
    or d.receiver_key_hash is distinct from clued_private.work_claim_lease_key_hash_v1(p_input->>'lease_key') then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_receiver_invalid'); end if;
  select * into c from clued_private.work_claims_v1 where user_id=b.user_id
    and claim_id=d.claim_id and context_key=coalesce(p_input->>'scope','global');
  if c.claim_id is null or c.holder_binding_id<>b.id or c.execution_epoch<>d.execution_epoch
    or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
  if d.delivered_at is not null then
    -- The receiving session can recover an uncertain response with its
    -- private capability. A replay rotates the key; a public ID cannot.
    key:=clued_private.work_claim_lease_key_issue_v1(c.claim_id);
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(b.user_id,b.id,c.context_key,'work_claim_handover_recover','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('delivery_id',d.delivery_id,'execution_epoch',c.execution_epoch)) returning id into receipt;
    return jsonb_build_object('status','committed','receipt_id',receipt,'replayed',true,'claim',clued_private.work_claim_view(c),
      'lease_key',key,'execution_epoch',c.execution_epoch);
  end if;
  return clued_private.work_claim_handover_deliver_v1(d);
end $$;

do $copy_renew_delivery$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_renew_v1(text,jsonb)'::regprocedure);
  body:=replace(body,'FUNCTION public.clued_work_renew_v1(',
    'FUNCTION clued_private.work_claim_renew_before_delivery_v1(');
  if position('FUNCTION clued_private.work_claim_renew_before_delivery_v1(' in body)=0 then
    raise exception 'work_claim_renew_delivery_source_unexpected'; end if;
  execute body;
end $copy_renew_delivery$;
revoke all on function clued_private.work_claim_renew_before_delivery_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function public.clued_work_renew_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r jsonb; b public.clued_agent_bindings; c clued_private.work_claims_v1;
  d clued_private.work_claim_handover_deliveries_v1;
begin
  if p_input->>'action'='finish_handover' then
    return clued_private.work_claim_receiver_collect_v1(p_token_hash,p_input); end if;
  r:=clued_private.work_claim_renew_before_delivery_v1(p_token_hash,p_input);
  if not clued_private.work_claim_execution_enabled_v1() or r->>'status'<>'committed'
    or r->'transferred' is distinct from 'true'::jsonb then return r; end if;
  b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  select * into c from clued_private.work_claims_v1 where user_id=b.user_id
    and claim_id=(r#>>'{claim,claim_id}')::uuid for update;
  -- The previous private key is the receiver's recovery proof, fixed to
  -- this authenticated Binding; neither value reaches any public view.
  update clued_private.work_claims_v1 set lease_key_hash=null,lease_key_required=true,
    execution_handover_pending=true where claim_id=c.claim_id;
  insert into clued_private.work_claim_handover_deliveries_v1
    (user_id,claim_id,execution_epoch,receipt_id,receiver_binding_id,receiver_key_hash)
  values(b.user_id,c.claim_id,c.execution_epoch,(r->>'receipt_id')::uuid,b.id,
    clued_private.work_claim_lease_key_hash_v1(p_input->>'lease_key')) returning * into d;
  return clued_private.work_claim_handover_deliver_v1(d);
end $$;
revoke all on function clued_private.work_claim_receiver_collect_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Account consent controls voluntary Agent handover, never the independent
-- execution permission of a Task. No row means enabled, including for an
-- existing account. Only a direct Native Owner session may change it.
create table clued_private.work_claim_free_handover_settings_v1 (
  user_id uuid primary key references auth.users(id),
  enabled boolean not null,
  version bigint not null check(version>0),
  updated_at timestamptz not null,
  receipt_id uuid not null references public.clued_audit_receipts(id)
);
alter table clued_private.work_claim_free_handover_settings_v1 enable row level security;
revoke all on clued_private.work_claim_free_handover_settings_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_free_handover_setting_view_v1(p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_build_object('enabled',enabled,'version',version,
      'default',false,'updated_at',updated_at,'receipt_id',receipt_id)
    from clued_private.work_claim_free_handover_settings_v1 where user_id=p_user),
    jsonb_build_object('enabled',true,'version',0,'default',true,'updated_at',null,'receipt_id',null))
$$;
create function public.clued_work_free_handover_setting_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12();
begin
  if jsonb_typeof(p_input) is distinct from 'object' or p_input<>'{}'::jsonb then
    raise exception 'work_claim_handover_setting_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('status','ok','available',clued_private.work_claim_execution_enabled_v1())
    ||clued_private.work_claim_free_handover_setting_view_v1(owner_id);
end $$;

create table clued_private.work_claim_handover_requests_v1 (
  request_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  claim_id uuid not null references clued_private.work_claims_v1(claim_id),
  context_key text not null,
  source_binding_id uuid not null references public.clued_agent_bindings(id),
  receiver_binding_id uuid not null references public.clued_agent_bindings(id),
  receiver_key_hash text not null check(receiver_key_hash ~ '^[0-9a-f]{64}$'),
  receiver_session_ref text,
  receiver_label text not null,
  receiver_client text,
  receiver_session_title text,
  expected_fence bigint not null,
  expected_epoch bigint not null,
  expected_resources_digest text not null,
  setting_version bigint not null,
  idempotency_key text not null,
  state text not null default 'prepared' check(state in ('prepared','offered','accepted','cancelled')),
  offered_at timestamptz,
  accepted_at timestamptz,
  expires_at timestamptz not null,
  delivery_id uuid references clued_private.work_claim_handover_deliveries_v1(delivery_id),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,receiver_binding_id,idempotency_key)
);
alter table clued_private.work_claim_handover_requests_v1 enable row level security;
revoke all on clued_private.work_claim_handover_requests_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function public.clued_work_free_handover_setting_set_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); sid text:=clued_private.native_session_id_v1();
  current_setting jsonb; wanted boolean; version bigint; receipt uuid;
begin
  if sid is null then raise exception 'direct_human_session_required' using errcode='42501'; end if;
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['enabled','base_version']<>'{}'::jsonb
    or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
    or coalesce(p_input->>'base_version','') !~ '^[0-9]{1,18}$' then
    raise exception 'work_claim_handover_setting_input_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(owner_id);
  current_setting:=clued_private.work_claim_free_handover_setting_view_v1(owner_id);
  version:=(current_setting->>'version')::bigint;
  if version<>(p_input->>'base_version')::bigint then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_setting_version_conflict',
      'current',current_setting); end if;
  wanted:=(p_input->>'enabled')::boolean;
  if wanted=(current_setting->>'enabled')::boolean then
    return jsonb_build_object('status','committed','changed',false)||current_setting; end if;
  insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata)
  values(owner_id,'global','work_claim_free_handover_setting','work_claim_setting',owner_id::text,version+1,
    jsonb_build_object('receipt_kind',case when wanted then 'WORK_CLAIM_FREE_HANDOVER_ENABLED'
      else 'WORK_CLAIM_FREE_HANDOVER_DISABLED' end,'enabled',wanted,'session_id',sid)) returning id into receipt;
  insert into clued_private.work_claim_free_handover_settings_v1(user_id,enabled,version,updated_at,receipt_id)
  values(owner_id,wanted,version+1,clock_timestamp(),receipt)
  on conflict(user_id) do update set enabled=excluded.enabled,version=excluded.version,
    updated_at=excluded.updated_at,receipt_id=excluded.receipt_id;
  -- Turning the switch off cannot restore a previous holder. It cancels
  -- only unaccepted offers; an already accepted transfer may finish drain.
  if not wanted then update clued_private.work_claim_handover_requests_v1 set state='cancelled'
    where user_id=owner_id and state in ('prepared','offered'); end if;
  return jsonb_build_object('status','committed','changed',true,'available',clued_private.work_claim_execution_enabled_v1())
    ||clued_private.work_claim_free_handover_setting_view_v1(owner_id);
end $$;

create function clued_private.work_claim_free_handover_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; receiver public.clued_agent_bindings;
  c clued_private.work_claims_v1; r clued_private.work_claim_handover_requests_v1;
  d clued_private.work_claim_handover_deliveries_v1;
  op text:=p_input->>'action'; scope text:=coalesce(p_input->>'scope','global');
  setting jsonb; key text; code text; receipt uuid; next_fence bigint; resources_digest text;
  profile jsonb:=clued_private.work_claim_profile_v1(); binding_count integer; session_count integer;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['action','scope','claim_id','fence','lease_version','progress_ref','lease_key',
      'request_id','receiver_key','idempotency_key','holder_session_ref','holder_label','holder_client','holder_session_title']<>'{}'::jsonb
    or coalesce(op,'') not in ('prepare_handover','offer_handover','accept_handover','cancel_handover') then
    raise exception 'work_claim_handover_input_invalid' using errcode='22023'; end if;
  b:=clued_private.resolve_binding(p_token_hash,'context:write',scope);
  perform clued_private.work_claim_lock(b.user_id);
  setting:=clued_private.work_claim_free_handover_setting_view_v1(b.user_id);
  if not clued_private.work_claim_execution_enabled_v1() then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_not_ready'); end if;
  if op='prepare_handover' then
    if clued_private.work_claim_self_report_v1(p_input,'holder_label',200) is null then
      raise exception 'work_claim_holder_label_required' using errcode='22023'; end if;
    if (setting->>'enabled')::boolean is not true then
      return jsonb_build_object('status','rejected','error_code','work_claim_free_handover_disabled'); end if;
    perform clued_private.work_claim_idempotency(p_input->>'idempotency_key');
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id
      and context_key=scope and claim_id=(p_input->>'claim_id')::uuid for update;
    if c.claim_id is null or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp()
      or c.execution_handover_pending or c.fence is distinct from (p_input->>'fence')::bigint then
      return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
    perform clued_private.work_claim_handover_renewable_v1(c);
    perform clued_private.work_claim_task(b.user_id,scope,c.task_id::text);
    select * into r from clued_private.work_claim_handover_requests_v1
      where user_id=b.user_id and receiver_binding_id=b.id and idempotency_key=p_input->>'idempotency_key';
    if r.request_id is not null then
      if r.claim_id is distinct from c.claim_id or r.context_key is distinct from scope
        or r.expected_fence is distinct from c.fence
        or r.expected_epoch is distinct from c.execution_epoch
        or r.receiver_session_ref is distinct from clued_private.work_claim_self_report_v1(p_input,'holder_session_ref',200)
        or r.receiver_label is distinct from clued_private.work_claim_self_report_v1(p_input,'holder_label',200)
        or r.receiver_client is distinct from clued_private.work_claim_self_report_v1(p_input,'holder_client',80)
        or r.receiver_session_title is distinct from clued_private.work_claim_self_report_v1(p_input,'holder_session_title',200) then
        return jsonb_build_object('status','rejected','error_code','work_claim_handover_idempotency_conflict'); end if;
      -- A public replay cannot steal another session's receiving capability.
      return jsonb_build_object('status','committed','replayed',true,'request_id',r.request_id,
        'receiver_key_unavailable',true,'expires_at',r.expires_at); end if;
    if (select count(*) from clued_private.work_claim_handover_requests_v1 where user_id=b.user_id
        and receiver_binding_id=b.id and state in ('prepared','offered') and expires_at>clock_timestamp())>=10 then
      return jsonb_build_object('status','rejected','error_code','work_claim_handover_requests_full'); end if;
    key:='clued_lk_'||encode(extensions.gen_random_bytes(32),'hex');
    resources_digest:=clued_private.m1_sha256(jsonb_build_object('write_set',c.write_set,'trigger_refs',c.trigger_refs));
    insert into clued_private.work_claim_handover_requests_v1(user_id,claim_id,context_key,source_binding_id,
      receiver_binding_id,receiver_key_hash,receiver_session_ref,receiver_label,receiver_client,receiver_session_title,
      expected_fence,expected_epoch,expected_resources_digest,setting_version,idempotency_key,expires_at)
    values(b.user_id,c.claim_id,scope,c.holder_binding_id,b.id,
      clued_private.work_claim_lease_key_hash_v1(key),
      clued_private.work_claim_self_report_v1(p_input,'holder_session_ref',200),
      clued_private.work_claim_self_report_v1(p_input,'holder_label',200),
      clued_private.work_claim_self_report_v1(p_input,'holder_client',80),
      clued_private.work_claim_self_report_v1(p_input,'holder_session_title',200),
      c.fence,c.execution_epoch,resources_digest,(setting->>'version')::bigint,p_input->>'idempotency_key',
      least(clock_timestamp()+interval '15 minutes',c.hard_deadline_at)) returning * into r;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(b.user_id,b.id,scope,'work_claim_handover_prepare','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('request_id',r.request_id,'execution_epoch',c.execution_epoch,'expires_at',r.expires_at))
      returning id into receipt;
    return jsonb_build_object('status','committed','receipt_id',receipt,'request_id',r.request_id,'receiver_key',key,
      'claim_id',c.claim_id,'scope',scope,'fence',c.fence,'expires_at',r.expires_at);
  end if;
  select * into r from clued_private.work_claim_handover_requests_v1 where user_id=b.user_id
    and context_key=scope and request_id=(p_input->>'request_id')::uuid for update;
  if r.request_id is null then return jsonb_build_object('status','rejected','error_code','work_claim_handover_request_not_found'); end if;
  select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=r.claim_id for update;
  if p_input ? 'claim_id' and (p_input->>'claim_id')::uuid is distinct from r.claim_id then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
  if c.claim_id is null or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
  if op='accept_handover' and r.state='accepted' then
    -- Accepted handover is an existing operation, not a new one after Off.
    return clued_private.work_claim_receiver_collect_v1(p_token_hash,
      jsonb_build_object('scope',scope,'delivery_id',r.delivery_id,'lease_key',p_input->>'receiver_key'));
  end if;
  if op='cancel_handover' then
    if r.state='accepted' or b.id<>r.receiver_binding_id
      or coalesce(p_input->>'receiver_key','') !~ '^clued_lk_[0-9a-f]{64}$'
      or clued_private.work_claim_lease_key_hash_v1(p_input->>'receiver_key')<>r.receiver_key_hash then
      return jsonb_build_object('status','rejected','error_code','work_claim_handover_receiver_invalid'); end if;
    update clued_private.work_claim_handover_requests_v1 set state='cancelled' where request_id=r.request_id;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(b.user_id,b.id,scope,'work_claim_handover_cancel','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('request_id',r.request_id,'execution_epoch',c.execution_epoch)) returning id into receipt;
    return jsonb_build_object('status','committed','receipt_id',receipt,'request_id',r.request_id,'state','cancelled'); end if;
  if r.state='cancelled' or (setting->>'enabled')::boolean is not true or r.setting_version<>(setting->>'version')::bigint then
    return jsonb_build_object('status','rejected','error_code','work_claim_free_handover_disabled'); end if;
  if r.expires_at<=clock_timestamp() then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
  if p_input ? 'fence' and (p_input->>'fence')::bigint is distinct from c.fence then
    return jsonb_build_object('status','rejected','error_code','work_claim_fence_mismatch'); end if;
  if c.fence<>r.expected_fence or c.execution_epoch<>r.expected_epoch or c.execution_handover_pending
    or c.holder_binding_id<>r.source_binding_id
    or r.expected_resources_digest<>clued_private.m1_sha256(jsonb_build_object('write_set',c.write_set,'trigger_refs',c.trigger_refs)) then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
  if op='offer_handover' then
    code:=clued_private.work_claim_execution_key_error_v1(c,b.id,p_input->>'lease_key');
    if code is not null then return jsonb_build_object('status','rejected','error_code',code); end if;
    select * into receiver from public.clued_agent_bindings where id=r.receiver_binding_id and user_id=b.user_id;
    if receiver.id is null then return jsonb_build_object('status','rejected','error_code','work_claim_handover_receiver_invalid'); end if;
    -- Revalidate the exact receiver's current grant, not its self-report.
    perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(receiver.token_hash),'context:write',scope);
    update clued_private.work_claim_handover_requests_v1 set state='offered',offered_at=clock_timestamp() where request_id=r.request_id;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(b.user_id,b.id,scope,'work_claim_handover_offer','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('request_id',r.request_id,'execution_epoch',c.execution_epoch)) returning id into receipt;
    return jsonb_build_object('status','committed','receipt_id',receipt,'request_id',r.request_id,'state','offered');
  end if;
  if b.id<>r.receiver_binding_id or coalesce(p_input->>'receiver_key','') !~ '^clued_lk_[0-9a-f]{64}$'
    or clued_private.work_claim_lease_key_hash_v1(p_input->>'receiver_key')<>r.receiver_key_hash then
    return jsonb_build_object('status','rejected','error_code','work_claim_handover_receiver_invalid'); end if;
  if r.state<>'offered' then return jsonb_build_object('status','rejected','error_code','work_claim_handover_not_offered'); end if;
  select * into receiver from public.clued_agent_bindings where id=r.source_binding_id and user_id=b.user_id;
  if receiver.id is null then return jsonb_build_object('status','rejected','error_code','work_claim_handover_stale'); end if;
  perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(receiver.token_hash),'context:write',scope);
  perform clued_private.work_claim_handover_renewable_v1(c);
  perform clued_private.work_claim_task(b.user_id,scope,c.task_id::text);
  select count(*)::integer,count(*) filter(where holder_session_ref is not distinct from r.receiver_session_ref)::integer
    into binding_count,session_count from clued_private.work_claims_v1 where user_id=b.user_id
      and holder_binding_id=b.id and claim_id<>c.claim_id and status in ('ACTIVE','DRAINING') and expires_at>clock_timestamp();
  if binding_count>=(profile->>'max_active_per_binding')::integer
    or session_count>=(profile->>'max_active_per_session')::integer then
    return jsonb_build_object('status','rejected','error_code','work_claim_budget_exhausted'); end if;
  select max(fence)+1 into next_fence from clued_private.work_claims_v1 where user_id=b.user_id and task_id=c.task_id;
  update clued_private.work_claims_v1 set holder_binding_id=b.id,holder_session_ref=r.receiver_session_ref,
    holder_label=r.receiver_label,holder_client=r.receiver_client,holder_session_title=r.receiver_session_title,
    fence=next_fence,lease_version=lease_version+1,lease_key_required=true,lease_key_hash=null,
    expires_at=least(clock_timestamp()+make_interval(secs=>(profile->>'lease_seconds')::integer),hard_deadline_at),
    updated_at=clock_timestamp() where claim_id=c.claim_id returning * into c;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(b.user_id,b.id,scope,'work_claim_agent_handover','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_HANDOVER_PENDING','request_id',r.request_id,
      'claim_id',c.claim_id,'execution_epoch',c.execution_epoch,'previous_binding_id',r.source_binding_id,
      'receiver_binding_id',b.id,'fence',c.fence)) returning id into receipt;
  insert into clued_private.work_claim_handover_deliveries_v1
    (user_id,claim_id,execution_epoch,receipt_id,receiver_binding_id,receiver_key_hash)
  values(b.user_id,c.claim_id,c.execution_epoch,receipt,b.id,r.receiver_key_hash) returning * into d;
  update clued_private.work_claim_handover_requests_v1 set state='accepted',accepted_at=clock_timestamp(),
    delivery_id=d.delivery_id,expires_at=c.hard_deadline_at where request_id=r.request_id;
  return clued_private.work_claim_handover_deliver_v1(d);
end $$;

do $free_handover_commands$
declare body text; anchor text:='begin';
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_renew_v1(text,jsonb)'::regprocedure);
  if position(E'\nbegin\n' in body)=0 then raise exception 'work_claim_free_handover_source_unexpected'; end if;
  execute replace(body,E'\nbegin\n',$a$
begin
  if p_input->>'action' in ('prepare_handover','offer_handover','accept_handover','cancel_handover') then
    return clued_private.work_claim_free_handover_v1(p_token_hash,p_input);
  end if;
$a$);
end $free_handover_commands$;

revoke all on function clued_private.work_claim_free_handover_setting_view_v1(uuid),
  clued_private.work_claim_free_handover_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
revoke all on function public.clued_work_free_handover_setting_v1(jsonb),
  public.clued_work_free_handover_setting_set_v1(jsonb) from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_work_free_handover_setting_v1(jsonb),
  public.clued_work_free_handover_setting_set_v1(jsonb) to authenticated;
