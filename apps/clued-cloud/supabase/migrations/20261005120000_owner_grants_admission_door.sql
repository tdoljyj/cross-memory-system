-- Work Claim Admission v0.1, re-review 7, MAJOR-3 (Owner Decision b43f8b8a,
-- Task c7b721ee; WorkClaimAdmission.v0.1.md §4.6, OwnerCredential.v0.1.md §6.3).
--
-- The main ruleset requires no approving review, so an Agent can merge any
-- pull request that passes its checks. A pull request that changes the code
-- guarding production (the admission check, the release door, the runner
-- check, a workflow that names a GitHub environment, a new secret or a new
-- trigger on a self-hosted workflow) could then remove the guard for every
-- later run. The admission check now asks the Owner first: it names the head
-- commit as repo:<owner>/<name>/<head sha> under the action
-- repo.protected_change, and only a live Owner Grant covering that commit
-- admits it. With none, the door opens (or reuses) one pending request whose
-- confirmation link the check prints; only the Owner approves it on the
-- signed-in Clued page.
--
-- Only the ci-admission Binding calls this door (binding_role_admits_v1, fail
-- closed once the Owner marked the role). It needs context:read only, like
-- verify: the admission token is read-only.
--
-- A grant is used once per commit: the first admission of a commit takes one
-- use and records it; later runs of the same commit (the hourly
-- re-verification, an edited pull request) are admitted by that record while
-- the grant is live (not revoked, not expired), without taking another use.
-- A grant approved once therefore admits exactly one commit.

insert into clued_private.owner_grant_actions(action,doors,title,risk) values
  ('repo.protected_change',array['ci-admission'],'合并改动准入、发布、runner 检查或 workflow 环境/密钥/触发器的提交','high');

create function clued_private.owner_grant_admission_request_v1(
  p_binding public.clued_agent_bindings,p_action text,p_resources text[]
) returns clued_private.owner_requests_v1 language plpgsql volatile security definer set search_path='' as $$
declare v_req clued_private.owner_requests_v1%rowtype; v_receipt uuid;
begin
  select * into v_req from clued_private.owner_requests_v1 r
    where r.user_id=p_binding.user_id and r.binding_id=p_binding.id and r.action=p_action
      and r.resources=p_resources and r.status='pending' and r.expires_at>clock_timestamp()
    order by r.created_at desc limit 1;
  if found then return v_req; end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,'global','owner_request_create','owner_request',p_action,1,
    jsonb_build_object('receipt_kind','OWNER_REQUEST_CREATED','action',p_action,
      'resources',to_jsonb(p_resources),'origin','ci-admission'))
  returning id into v_receipt;
  insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,
    suggested_max_uses,expires_at,receipt_id)
  values(p_binding.user_id,p_binding.id,'admission-door:'||gen_random_uuid()::text,p_action,p_resources,
    1,clock_timestamp()+interval '24 hours',v_receipt)
  returning * into v_req;
  return v_req;
end $$;

create function clued_private.owner_grant_admission_use_v1(
  p_user_id uuid,p_binding_id uuid,p_action text,p_resources text[]
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare g clued_private.owner_grants_v1%rowtype; v_receipt uuid; v_prior uuid; v_prior_grant uuid;
begin
  perform clued_private.owner_grant_lock_v1(p_user_id);
  -- A live grant that already admitted these exact resources at this door.
  select x.id, r.id into v_prior_grant, v_prior
    from clued_private.owner_grants_v1 x
    join public.clued_audit_receipts r on r.user_id=x.user_id and r.operation='owner_grant_use'
      and r.object_type='owner_grant' and r.object_id=x.id::text
      and r.metadata->>'door'='ci-admission' and r.metadata->'resources'=to_jsonb(p_resources)
    where x.user_id=p_user_id and x.action=p_action and x.revoked_at is null
      and x.expires_at>clock_timestamp()
    order by x.expires_at desc limit 1;
  if v_prior_grant is not null then
    select * into g from clued_private.owner_grants_v1 where id=v_prior_grant;
    return jsonb_build_object('grant_id',g.id,'receipt_id',v_prior,'use',g.uses,'max_uses',g.max_uses,
      'expires_at',g.expires_at,'replayed',true);
  end if;
  select * into g from clued_private.owner_grants_v1 x
    where x.user_id=p_user_id and x.action=p_action and x.revoked_at is null
      and x.expires_at>clock_timestamp() and (x.max_uses is null or x.uses<x.max_uses)
      and cardinality(p_resources)>0
      and not exists(select 1 from unnest(p_resources) r where not clued_private.owner_grant_covers_v1(x.resources,r))
    order by x.expires_at,x.granted_at limit 1 for update;
  if not found then return null; end if;
  update clued_private.owner_grants_v1 set uses=uses+1 where id=g.id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(p_user_id,p_binding_id,'global','owner_grant_use','owner_grant',g.id::text,g.uses+1,
    jsonb_build_object('receipt_kind','OWNER_GRANT_USED','grant_id',g.id,'action',p_action,
      'resources',to_jsonb(p_resources),'door','ci-admission','use',g.uses+1,'max_uses',g.max_uses))
  returning id into v_receipt;
  return jsonb_build_object('grant_id',g.id,'receipt_id',v_receipt,'use',g.uses+1,'max_uses',g.max_uses,
    'expires_at',g.expires_at,'replayed',false);
end $$;

create function public.clued_owner_grant_admission_door_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings; v_action clued_private.owner_grant_actions%rowtype;
  v_resources text[]; v_grant jsonb; v_req clued_private.owner_requests_v1%rowtype;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('action','resources')) then
    raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  if not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then
    raise exception 'owner_grant_door_binding_not_authorized' using errcode='42501'; end if;
  select * into v_action from clued_private.owner_grant_actions where action=p_input->>'action';
  if not found or not ('ci-admission'=any(v_action.doors)) then
    raise exception 'owner_grant_door_action_invalid' using errcode='22023'; end if;
  if jsonb_typeof(p_input->'resources') is distinct from 'array'
      or jsonb_array_length(p_input->'resources') not between 1 and 50 then
    raise exception 'owner_grant_door_resources_invalid' using errcode='22023'; end if;
  v_resources:=clued_private.work_claim_normalize_paths(p_input->'resources');
  if cardinality(v_resources) not between 1 and 50 then
    raise exception 'owner_grant_door_resources_invalid' using errcode='22023'; end if;
  v_grant:=clued_private.owner_grant_admission_use_v1(v_binding.user_id,v_binding.id,v_action.action,v_resources);
  if v_grant is not null then
    return jsonb_build_object('status','ok','admitted',true,'action',v_action.action,
      'resources',to_jsonb(v_resources),'grant',v_grant);
  end if;
  v_req:=clued_private.owner_grant_admission_request_v1(v_binding,v_action.action,v_resources);
  return jsonb_build_object('status','ok','admitted',false,'action',v_action.action,
    'resources',to_jsonb(v_resources),'owner_request',clued_private.owner_request_public_v1(v_req));
end $$;

revoke all on function clued_private.owner_grant_admission_request_v1(public.clued_agent_bindings,text,text[]),
  clued_private.owner_grant_admission_use_v1(uuid,uuid,text,text[]),
  public.clued_owner_grant_admission_door_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_owner_grant_admission_door_v1(text,jsonb) to anon;

notify pgrst,'reload schema';
