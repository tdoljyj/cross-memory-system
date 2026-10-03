-- Work Claim admission re-review (Task 869d2db7, Owner Decision 38ddb8cf),
-- findings N1, N2 and N5: some calls are a door's own acts and must not be
-- open to every Agent's Binding.
--   - ci-admission: the Binding in the clued-admission GitHub environment.
--     Only it binds a claim to a pull request, meters a head, admits a hand
--     dispatch (verify with pr_ref or ci_dispatch) and reports a merge
--     (clued_work_claim_adopt_v1). Any Binding may still verify read-only.
--   - release-door: the Binding in the clued-release environment. Only it
--     consumes an Owner Grant at the release door.
-- The Owner marks a Binding on the signed-in Clued page, in two Native steps
-- (clued_binding_role_confirmation_issue_v1, then clued_binding_role_set_v1);
-- no MCP tool, OAuth case or Binding can. Until the Owner has marked a live
-- Binding for a role, every Binding keeps the earlier behaviour for it, so
-- nothing stops before the Owner has set the role up.

create table clued_private.binding_roles_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid not null references public.clued_agent_bindings(id),
  role text not null check (role in ('ci-admission','release-door')),
  granted_at timestamptz not null,
  granted_receipt_id uuid not null references public.clued_audit_receipts(id),
  revoked_at timestamptz,
  revoked_receipt_id uuid references public.clued_audit_receipts(id),
  check ((revoked_at is null)=(revoked_receipt_id is null))
);
create unique index binding_roles_v1_live_uidx on clued_private.binding_roles_v1(binding_id,role)
  where revoked_at is null;
create index binding_roles_v1_user_role on clued_private.binding_roles_v1(user_id,role) where revoked_at is null;
alter table clued_private.binding_roles_v1 enable row level security;
revoke all on table clued_private.binding_roles_v1 from public,anon,authenticated,service_role;

create function clued_private.binding_live_v1(b public.clued_agent_bindings) returns boolean
language sql stable set search_path='' as $$
  select b.revoked_at is null
    and coalesce((to_jsonb(b)->>'expires_at')::timestamptz>clock_timestamp(),true)
$$;

-- True when this Binding holds the role, or when the Owner has no live
-- Binding marked for it yet.
create function clued_private.binding_role_admits_v1(p_binding public.clued_agent_bindings,p_role text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=p_binding.id and r.role=p_role and r.revoked_at is null)
    or not exists(select 1 from clued_private.binding_roles_v1 r
      join public.clued_agent_bindings b on b.id=r.binding_id
      where r.user_id=p_binding.user_id and r.role=p_role and r.revoked_at is null
        and clued_private.binding_live_v1(b))
$$;

create function clued_private.binding_role_title_v1(p_role text) returns text
language sql immutable set search_path='' as $$
  select case p_role
    when 'ci-admission' then 'GitHub CI 准入（绑定 PR、计入 CI 额度、手动触发准入、合并后采纳）'
    when 'release-door' then '生产发布门口（消费发布与迁移授权）' end
$$;

-- What the Owner confirms, rendered by Clued from the Binding row.
create function clued_private.binding_role_view_v1(p_binding public.clued_agent_bindings,p_role text,p_enabled boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('binding_id',p_binding.id,'agent_name',p_binding.agent_name,'vendor',p_binding.vendor,
    'scopes',to_jsonb(p_binding.scopes),'created_at',p_binding.created_at,'role',p_role,
    'role_title',clued_private.binding_role_title_v1(p_role),'enabled',p_enabled,
    'others',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,'vendor',b.vendor)
        order by r.granted_at)
      from clued_private.binding_roles_v1 r join public.clued_agent_bindings b on b.id=r.binding_id
      where r.user_id=p_binding.user_id and r.role=p_role and r.revoked_at is null and r.binding_id<>p_binding.id
        and clued_private.binding_live_v1(b)),'[]'::jsonb))
$$;

-- The Owner's live Bindings with their roles (Native account session).
create function public.clued_binding_roles_list_v1(p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('status','ok',
    'roles',jsonb_build_array(
      jsonb_build_object('role','ci-admission','title',clued_private.binding_role_title_v1('ci-admission'),
        'required_scope','context:read'),
      jsonb_build_object('role','release-door','title',clued_private.binding_role_title_v1('release-door'),
        'required_scope','context:write')),
    'bindings',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,
        'vendor',b.vendor,'scopes',to_jsonb(b.scopes),'created_at',b.created_at,'last_used_at',b.last_used_at,
        'roles',coalesce((select jsonb_agg(r.role order by r.role) from clued_private.binding_roles_v1 r
          where r.binding_id=b.id and r.revoked_at is null),'[]'::jsonb)) order by b.created_at desc)
      from public.clued_agent_bindings b where b.user_id=v_owner and clued_private.binding_live_v1(b)),'[]'::jsonb));
end $$;

-- Step 1. Input {binding_id, role, enabled}. The token covers exactly the view.
create function public.clued_binding_role_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); b public.clued_agent_bindings%rowtype;
  v_role text; v_enabled boolean; v_view jsonb; v_digest text; v_raw text; v_token_id uuid;
  v_expires timestamptz; v_now timestamptz; v_error text; v_subject text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('binding_id','role','enabled')) then
      raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
    if coalesce(p_input->>'binding_id','') !~* '^[0-9a-f-]{36}$' then
      raise exception 'binding_role_binding_invalid' using errcode='22023'; end if;
    v_role:=p_input->>'role';
    if v_role is null or v_role not in ('ci-admission','release-door') then
      raise exception 'binding_role_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then
      raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
    v_enabled:=(p_input->>'enabled')::boolean;
    select * into b from public.clued_agent_bindings x where x.id=(p_input->>'binding_id')::uuid and x.user_id=v_owner;
    if not found or not clued_private.binding_live_v1(b) then
      raise exception 'binding_role_binding_invalid' using errcode='22023'; end if;
    if v_enabled and not ((case v_role when 'ci-admission' then 'context:read' else 'context:write' end)=any(b.scopes)) then
      raise exception 'binding_role_scope_missing' using errcode='22023'; end if;
    if v_enabled=exists(select 1 from clued_private.binding_roles_v1 r
        where r.binding_id=b.id and r.role=v_role and r.revoked_at is null) then
      raise exception 'binding_role_unchanged' using errcode='22023'; end if;
    v_view:=clued_private.binding_role_view_v1(b,v_role,v_enabled);
    v_digest:=clued_private.m1_sha256(v_view);
    v_subject:=b.id::text||':'||v_role;
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='binding_role' and subject_key=v_subject and consumed_at is null and revoked_at is null;
    v_raw:='clued_brl_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'binding_role',v_subject,0,
      jsonb_build_object('binding_id',b.id,'role',v_role,'enabled',v_enabled),v_view,v_digest,
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

-- Step 2: consume the token, re-render the view, set or end the role.
create function public.clued_binding_role_set_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; b public.clued_agent_bindings%rowtype; v_receipt uuid; v_now timestamptz;
  v_error text; v_state text; c jsonb; v_role text; v_enabled boolean;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'binding_role_input_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=v_owner and t.action='binding_role' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_token.consumed_receipt_id,
        'binding_id',v_token.native_choices->>'binding_id','role',v_token.native_choices->>'role',
        'enabled',(v_token.native_choices->>'enabled')::boolean);
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
    v_role:=c->>'role'; v_enabled:=(c->>'enabled')::boolean;
    select * into b from public.clued_agent_bindings x where x.id=(c->>'binding_id')::uuid and x.user_id=v_owner for update;
    if not found or not clued_private.binding_live_v1(b) then
      raise exception 'binding_role_binding_invalid' using errcode='22023'; end if;
    if clued_private.m1_sha256(clued_private.binding_role_view_v1(b,v_role,v_enabled))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','binding_role_set','binding_role',b.id::text||':'||v_role,1,
      jsonb_build_object('receipt_kind',case when v_enabled then 'BINDING_ROLE_GRANTED' else 'BINDING_ROLE_ENDED' end,
        'binding_id',b.id,'role',v_role,'token_id',v_token.id,'view_digest',v_token.view_digest,
        'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    if v_enabled then
      insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values(v_owner,b.id,v_role,v_now,v_receipt);
    else
      update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
        where binding_id=b.id and role=v_role and revoked_at is null;
      if not found then raise exception 'binding_role_unchanged' using errcode='22023'; end if;
    end if;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'binding_id',b.id,'role',v_role,'enabled',v_enabled);
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','binding_role_set','binding_role',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','BINDING_ROLE_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

revoke all on function clued_private.binding_live_v1(public.clued_agent_bindings),
  clued_private.binding_role_admits_v1(public.clued_agent_bindings,text),
  clued_private.binding_role_title_v1(text),
  clued_private.binding_role_view_v1(public.clued_agent_bindings,text,boolean)
from public,anon,authenticated,service_role;
revoke all on function public.clued_binding_roles_list_v1(jsonb),
  public.clued_binding_role_confirmation_issue_v1(jsonb),
  public.clued_binding_role_set_v1(jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.clued_binding_roles_list_v1(jsonb),
  public.clued_binding_role_confirmation_issue_v1(jsonb),
  public.clued_binding_role_set_v1(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- The doors, as in 20261003180000 (verify), 20261003120000 (adopt) and
-- 20261003170000 (release door), with the role checks. verify also takes
-- ci_dispatch: a hand-dispatch admission meters the dispatched head against
-- the Task's GitHub CI budget, as a pull request head is (finding MAJOR-6).

create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_reasons jsonb:='[]'::jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_max_fence bigint; v_paths text[];
  v_outside text[]:='{}'::text[]; v_p text; v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_head text:=lower(nullif(btrim(coalesce(p_input->>'head_sha','')),''));
  v_cap integer:=(clued_private.work_claim_profile_v1()->>'github_ci_heads_per_task_24h')::integer;
  v_used integer; v_retry timestamptz; v_dispatch boolean:=false;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if p_input ? 'ci_dispatch' then
    if jsonb_typeof(p_input->'ci_dispatch') is distinct from 'boolean' then
      raise exception 'work_claim_ci_dispatch_invalid' using errcode='22023'; end if;
    v_dispatch:=(p_input->>'ci_dispatch')::boolean;
  end if;
  if v_dispatch and (p_input ? 'pr_ref' or v_head is null) then
    raise exception 'work_claim_ci_dispatch_invalid' using errcode='22023'; end if;
  -- Decision 38ddb8cf: binding a claim to a pull request, metering a head and
  -- admitting a hand dispatch are the GitHub door's acts, so only the Owner's
  -- CI admission Binding may do them once the Owner has marked one
  -- (binding_roles_v1). Any Binding may still verify read-only.
  if (v_pr is not null or v_dispatch)
      and not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then
    return jsonb_build_object('status','ok','verdict','REJECTED','verified_at',v_now,
      'reasons',jsonb_build_array('admission_binding_required'));
  end if;
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  if p_input ? 'pr_ref' and (v_pr is null
      or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$') then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if v_head is not null and v_head !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  -- With a pr_ref the row is locked: two pull requests verified at once
  -- cannot both bind the same claim.
  if v_pr is null then
    select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
      and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope;
  else
    select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
      and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  end if;
  if not found then
    return jsonb_build_object('status','ok','verdict','REJECTED','verified_at',v_now,
      'reasons',jsonb_build_array('claim_not_found'));
  end if;
  if c.status not in ('ACTIVE','DRAINING') or c.expires_at<=v_now then
    v_reasons:=v_reasons||to_jsonb('claim_not_current'::text); end if;
  select max(w.fence) into v_max_fence from clued_private.work_claims_v1 w
    where w.user_id=c.user_id and w.task_id=c.task_id;
  -- Copies of a race share the Task's fence sequence; a copy is current while
  -- it is live and not out of the race, whatever later copies took.
  if c.copy_index is null and v_max_fence<>c.fence then
    v_reasons:=v_reasons||to_jsonb('fence_superseded'::text); end if;
  if c.outcome='not_adopted' then v_reasons:=v_reasons||to_jsonb('copy_not_adopted'::text); end if;
  if p_input ? 'changed_paths' then
    v_paths:=clued_private.work_claim_normalize_paths(p_input->'changed_paths');
    foreach v_p in array v_paths loop
      if not clued_private.work_claim_path_covered(v_p,c.write_set) then v_outside:=v_outside||v_p; end if;
    end loop;
    if cardinality(v_outside)>0 then v_reasons:=v_reasons||to_jsonb('paths_outside_write_set'::text); end if;
  end if;
  if v_pr is not null and c.bound_pr is not null and c.bound_pr<>v_pr then
    v_reasons:=v_reasons||to_jsonb('claim_bound_to_other_pr'::text);
  end if;
  -- GitHub CI per Task (§10.4): a head is counted once, the first time any
  -- claim of the Task admits it; the count is the Task's heads in the last
  -- 24 hours. A per-Task lock keeps two verifies from both taking the last
  -- place; nothing else takes it, so it cannot deadlock with the row lock.
  if (v_pr is not null or v_dispatch) and v_head is not null and jsonb_array_length(v_reasons)=0 then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'clued-work-claim-ci:'||c.user_id::text||':'||c.task_id::text,0));
    if not exists(select 1 from clued_private.work_claim_door_usage_v1 u
        where u.user_id=c.user_id and u.door='github-ci' and u.task_id=c.task_id and u.unit_key=v_head) then
      select count(*),min(u.used_at) into v_used,v_retry from clued_private.work_claim_door_usage_v1 u
        where u.user_id=c.user_id and u.door='github-ci' and u.task_id=c.task_id
          and u.used_at>v_now-interval '24 hours';
      if v_used>=v_cap then
        v_reasons:=v_reasons||to_jsonb('task_ci_head_cap_reached'::text);
        v_retry:=v_retry+interval '24 hours';
      else
        insert into clued_private.work_claim_door_usage_v1(user_id,door,task_id,binding_id,claim_id,unit_key,used_at)
        values(c.user_id,'github-ci',c.task_id,v_binding.id,c.claim_id,v_head,v_now);
        v_retry:=null;
      end if;
    else
      v_retry:=null;
    end if;
    if v_pr is not null and jsonb_array_length(v_reasons)=0 and not (v_head=any(c.admitted_heads)) then
      update clued_private.work_claims_v1 set admitted_heads=admitted_heads||v_head,updated_at=v_now
        where claim_id=c.claim_id returning * into c;
    end if;
  end if;
  if v_pr is not null and c.bound_pr is null and jsonb_array_length(v_reasons)=0 then
    update clued_private.work_claims_v1 set bound_pr=v_pr,updated_at=v_now
      where claim_id=c.claim_id returning * into c;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
      object_type,object_id,version,metadata)
    values(c.user_id,v_binding.id,c.context_key,'work_claim_bind_pr','work_claim',
      c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_BOUND_TO_PR',
        'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'bound_pr',v_pr,
        'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha'));
  end if;
  select count(*) into v_used from clued_private.work_claim_door_usage_v1 u
    where u.user_id=c.user_id and u.door='github-ci' and u.task_id=c.task_id
      and u.used_at>v_now-interval '24 hours';
  return jsonb_build_object('status','ok',
    'verdict',case when jsonb_array_length(v_reasons)=0 then 'ADMITTED' else 'REJECTED' end,
    'verified_at',v_now,'reasons',v_reasons,'paths_outside_write_set',to_jsonb(v_outside),
    'current_fence',v_max_fence,'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha',
    'pr_ref',v_pr,'bound_pr',c.bound_pr,'admitted_heads',cardinality(c.admitted_heads),
    'task_ci_heads_24h',v_used,'task_ci_head_cap',v_cap,'ci_retry_after',v_retry,
    'claim',clued_private.work_claim_view(c));
end $$;

create or replace function public.clued_work_claim_adopt_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_merge text:=lower(nullif(btrim(coalesce(p_input->>'merge_sha','')),''));
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','pr_ref','merge_sha')) then
    raise exception 'work_claim_adopt_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  -- Decision 38ddb8cf: only the CI admission Binding reports a merge.
  if not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then
    return jsonb_build_object('status','ok','adopted',false,'reason','admission_binding_required');
  end if;
  if v_pr is null or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if v_merge is null or v_merge !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  select * into c from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.context_key=v_scope and w.bound_pr=v_pr and w.copy_index is not null
    order by w.issued_at desc limit 1;
  if not found then return jsonb_build_object('status','ok','adopted',false,'reason','no_copy_for_pr','pr_ref',v_pr); end if;
  return clued_private.work_claim_adopt_core_v1(c,v_binding.id,'github',
    jsonb_build_object('pr_ref',v_pr,'merge_sha',v_merge))||jsonb_build_object('pr_ref',v_pr);
end $$;

create or replace function public.clued_owner_grant_door_consume_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings; v_action clued_private.owner_grant_actions%rowtype;
  v_resources text[]; v_grant jsonb; v_req clued_private.owner_requests_v1%rowtype; v_receipt uuid;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('action','resources')) then
    raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write','global');
  -- Decision 38ddb8cf: only the release environment's Binding uses a grant here.
  if not clued_private.binding_role_admits_v1(v_binding,'release-door') then
    raise exception 'owner_grant_door_binding_not_authorized' using errcode='42501'; end if;
  select * into v_action from clued_private.owner_grant_actions where action=p_input->>'action';
  if not found or not ('release-workflow'=any(v_action.doors)) then
    raise exception 'owner_grant_door_action_invalid' using errcode='22023'; end if;
  if jsonb_typeof(p_input->'resources') is distinct from 'array'
      or jsonb_array_length(p_input->'resources') not between 1 and 50 then
    raise exception 'owner_grant_door_resources_invalid' using errcode='22023'; end if;
  v_resources:=clued_private.work_claim_normalize_paths(p_input->'resources');
  if cardinality(v_resources) not between 1 and 50 then
    raise exception 'owner_grant_door_resources_invalid' using errcode='22023'; end if;
  v_grant:=clued_private.owner_grant_consume_door_v1(v_binding.user_id,v_binding.id,v_action.action,v_resources);
  if v_grant is not null then
    return jsonb_build_object('status','ok','consumed',true,'action',v_action.action,
      'resources',to_jsonb(v_resources),'grant',v_grant);
  end if;
  -- No grant: reuse this door's pending request for the same action and
  -- resources, or open one. Same shape as an Agent's request.
  select * into v_req from clued_private.owner_requests_v1 r
    where r.user_id=v_binding.user_id and r.binding_id=v_binding.id and r.action=v_action.action
      and r.resources=v_resources and r.status='pending' and r.expires_at>clock_timestamp()
    order by r.created_at desc limit 1;
  if not found then
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_binding.user_id,v_binding.id,'global','owner_request_create','owner_request',v_action.action,1,
      jsonb_build_object('receipt_kind','OWNER_REQUEST_CREATED','action',v_action.action,
        'resources',to_jsonb(v_resources),'origin','release-workflow'))
    returning id into v_receipt;
    insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,
      suggested_max_uses,expires_at,receipt_id)
    values(v_binding.user_id,v_binding.id,'release-door:'||gen_random_uuid()::text,v_action.action,v_resources,
      1,clock_timestamp()+interval '24 hours',v_receipt)
    returning * into v_req;
  end if;
  return jsonb_build_object('status','ok','consumed',false,'action',v_action.action,
    'resources',to_jsonb(v_resources),'owner_request',clued_private.owner_request_public_v1(v_req));
end $$;

notify pgrst,'reload schema';
