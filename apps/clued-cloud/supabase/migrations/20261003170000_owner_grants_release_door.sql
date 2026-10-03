-- Owner Credential v0.1, rollout step 4 (development/contracts/
-- owner-authorization/OwnerCredential.v0.1.md §6.1, Task 2a31ca2a).
--
-- The release door: the production release workflow consumes an Owner Grant
-- before it deploys (release.production) or applies migrations
-- (migration.production). It calls with its own Binding token, held in the
-- clued-release environment, which is not the Agent that asked the Owner.
-- Owner choice (2026-10-03): this door matches a grant by action and
-- resources only (the exact commit, repo:<owner>/<name>/<sha>), whichever
-- Agent requested it and whichever Task it named.
-- When no grant admits the call, the door opens (or reuses) a pending request
-- under its own Binding and returns it, so the run can print the confirmation
-- link. Only the Owner approves, on the signed-in confirmation page.

-- Same as owner_grant_consume_v1 without the grantee and Task filters.
create function clued_private.owner_grant_consume_door_v1(
  p_user_id uuid,p_binding_id uuid,p_action text,p_resources text[]
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare g clued_private.owner_grants_v1%rowtype; v_receipt uuid;
begin
  perform clued_private.owner_grant_lock_v1(p_user_id);
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
      'resources',to_jsonb(p_resources),'door','release-workflow','use',g.uses+1,'max_uses',g.max_uses))
  returning id into v_receipt;
  return jsonb_build_object('grant_id',g.id,'receipt_id',v_receipt,'use',g.uses+1,'max_uses',g.max_uses,
    'expires_at',g.expires_at);
end $$;

-- Input {action, resources}. A context:write Binding (the release
-- environment's). Returns {status:'ok', consumed:true, grant} or
-- {status:'ok', consumed:false, owner_request}.
create function public.clued_owner_grant_door_consume_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings; v_action clued_private.owner_grant_actions%rowtype;
  v_resources text[]; v_grant jsonb; v_req clued_private.owner_requests_v1%rowtype; v_receipt uuid;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('action','resources')) then
    raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write','global');
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

revoke all on function clued_private.owner_grant_consume_door_v1(uuid,uuid,text,text[])
  from public,anon,authenticated,service_role;
revoke all on function public.clued_owner_grant_door_consume_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_owner_grant_door_consume_v1(text,jsonb) to anon;

notify pgrst,'reload schema';
