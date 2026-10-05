-- Permission simplification step 3 (PermissionSimplification.v0.1 §3.3,
-- Task 23045c17): one approval for several actions on the same work, for
-- example a production migration and the deploy of the same commit.
--
-- A bundle is a set of ordinary Owner Requests that share bundle_id (the id
-- of the first). Each member keeps its own action, resources, status, grant
-- and Receipts, and each door still consumes its own grant once. What is new:
-- - clued_owner_request_bundle_v1: an Agent asks for 2 to 5 actions in one
--   call and gets one confirmation link;
-- - the release door, when it finds no grant, opens the request for its own
--   action together with the others the run names (`with`), skipping any a
--   live grant already admits;
-- - every request view lists its bundle, so the confirmation page shows all
--   members and the Owner approves them with one click. The page still runs
--   the two-step confirmation for each member over that member's own view.
-- connection.permission is never bundled: it changes the connection itself
-- and keeps its own page.

alter table clued_private.owner_requests_v1 add column bundle_id uuid;
create index owner_requests_v1_bundle_idx on clued_private.owner_requests_v1(user_id,bundle_id)
  where bundle_id is not null;

-- Same as 20261002220000 plus bundle: the members in creation order.
create or replace function clued_private.owner_request_public_v1(r clued_private.owner_requests_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('request_id',r.id,'action',r.action,'resources',to_jsonb(r.resources),
    'task_id',r.task_id,
    'status',case when r.status='pending' and r.expires_at<=clock_timestamp() then 'expired' else r.status end,
    'confirm_path','/confirm/'||r.id::text,'created_at',r.created_at,'expires_at',r.expires_at,
    'decided_at',r.decided_at,
    'grant',(select jsonb_build_object('grant_id',g.id,'expires_at',g.expires_at,'max_uses',g.max_uses,
        'uses',g.uses,'revoked',g.revoked_at is not null,'any_agent',g.grantee_binding_id is null)
      from clued_private.owner_grants_v1 g where g.id=r.grant_id),
    'bundle',case when r.bundle_id is null then null else
      (select jsonb_agg(jsonb_build_object('request_id',x.id,'action',x.action,'resources',to_jsonb(x.resources),
          'status',case when x.status='pending' and x.expires_at<=clock_timestamp() then 'expired' else x.status end,
          'confirm_path','/confirm/'||x.id::text) order by x.created_at,x.id)
        from clued_private.owner_requests_v1 x where x.user_id=r.user_id and x.bundle_id=r.bundle_id) end)
$$;

-- Joins requests into one bundle: the first request's bundle if it has one,
-- else a new bundle named by the first request. A pending request the door
-- reuses moves into the newest bundle; a bundle only groups requests for the
-- confirmation page and grants nothing by itself.
create function clued_private.owner_request_bundle_join_v1(p_user_id uuid,p_ids uuid[]) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare v_bundle uuid;
begin
  select coalesce(bundle_id,id) into v_bundle from clued_private.owner_requests_v1
    where user_id=p_user_id and id=p_ids[1];
  update clued_private.owner_requests_v1 set bundle_id=v_bundle
    where user_id=p_user_id and id=any(p_ids) and bundle_id is distinct from v_bundle;
  return v_bundle;
end $$;

-- Input: {scope?, actions: [{action, resources}] (2 to 5, distinct actions),
-- task_id?, suggested_grant?, agent_note?, idempotency_key}. Each member is
-- created by clued_owner_request_v1 with idempotency_key '<key>#<n>', so the
-- rules, Receipts and replay are those of a single request; the whole call is
-- one transaction.
create function public.clued_owner_request_bundle_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_item jsonb; v_n integer:=0; v_result jsonb; v_ids uuid[]:='{}'; v_replayed boolean:=true;
  v_user uuid; v_receipt uuid; v_lead clued_private.owner_requests_v1%rowtype;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in
        ('scope','actions','task_id','suggested_grant','agent_note','idempotency_key')) then
    raise exception 'owner_request_bundle_invalid' using errcode='22023'; end if;
  if jsonb_typeof(p_input->'actions') is distinct from 'array'
      or jsonb_array_length(p_input->'actions') not between 2 and 5
      or exists(select 1 from jsonb_array_elements(p_input->'actions') x
        where jsonb_typeof(x) is distinct from 'object'
          or exists(select 1 from jsonb_object_keys(x) k where k not in ('action','resources'))
          or jsonb_typeof(x->'action') is distinct from 'string'
          or x->>'action'='connection.permission')
      or (select count(distinct x->>'action') from jsonb_array_elements(p_input->'actions') x)
        <>jsonb_array_length(p_input->'actions') then
    raise exception 'owner_request_bundle_invalid' using errcode='22023'; end if;
  if char_length(coalesce(p_input->>'idempotency_key','')) not between 8 and 150 then
    raise exception 'owner_request_idempotency_key_required' using errcode='22023'; end if;
  for v_item in select value from jsonb_array_elements(p_input->'actions') loop
    v_n:=v_n+1;
    v_result:=public.clued_owner_request_v1(p_token_hash,(p_input-'actions')||jsonb_build_object(
      'action',v_item->'action','resources',v_item->'resources',
      'idempotency_key',(p_input->>'idempotency_key')||'#'||v_n));
    v_replayed:=v_replayed and coalesce((v_result->>'replayed')::boolean,false);
    v_ids:=v_ids||((v_result->'request'->>'request_id')::uuid);
    if v_n=1 then v_receipt:=(v_result->>'receipt_id')::uuid; end if;
  end loop;
  select user_id into v_user from clued_private.owner_requests_v1 where id=v_ids[1];
  perform clued_private.owner_request_bundle_join_v1(v_user,v_ids);
  select * into v_lead from clued_private.owner_requests_v1 where id=v_ids[1];
  return jsonb_build_object('status','committed','replayed',v_replayed,'receipt_id',v_receipt,
    'request',clued_private.owner_request_public_v1(v_lead));
end $$;

-- Non-consuming twin of owner_grant_consume_door_v1's match: would a live
-- grant admit this action and these resources at the release door?
create function clued_private.owner_grant_door_admits_v1(p_user_id uuid,p_action text,p_resources text[])
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.owner_grants_v1 x
    where x.user_id=p_user_id and x.action=p_action and x.revoked_at is null
      and x.expires_at>clock_timestamp() and (x.max_uses is null or x.uses<x.max_uses)
      and cardinality(p_resources)>0
      and not exists(select 1 from unnest(p_resources) r where not clued_private.owner_grant_covers_v1(x.resources,r)))
$$;

-- The door's pending request for one action and resources: reused, or opened.
create function clued_private.owner_grant_door_request_v1(
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
      'resources',to_jsonb(p_resources),'origin','release-workflow'))
  returning id into v_receipt;
  insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,
    suggested_max_uses,expires_at,receipt_id)
  values(p_binding.user_id,p_binding.id,'release-door:'||gen_random_uuid()::text,p_action,p_resources,
    1,clock_timestamp()+interval '24 hours',v_receipt)
  returning * into v_req;
  return v_req;
end $$;

-- Same as 20261003200000 plus `with`: up to 4 other {action, resources} the
-- run will also need. With no grant for its own action, the door opens its
-- request together with one for each of those that no live grant admits yet,
-- as one bundle. It still consumes only its own action.
create or replace function public.clued_owner_grant_door_consume_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings; v_action clued_private.owner_grant_actions%rowtype;
  v_resources text[]; v_grant jsonb; v_req clued_private.owner_requests_v1%rowtype;
  v_with jsonb:='[]'::jsonb; v_item jsonb; v_other clued_private.owner_grant_actions%rowtype;
  v_other_resources text[]; v_ids uuid[]; v_member clued_private.owner_requests_v1%rowtype;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('action','resources','with')) then
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
  if p_input ? 'with' then
    if jsonb_typeof(p_input->'with') is distinct from 'array' or jsonb_array_length(p_input->'with') not between 1 and 4 then
      raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
    for v_item in select value from jsonb_array_elements(p_input->'with') loop
      if jsonb_typeof(v_item) is distinct from 'object'
          or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('action','resources')) then
        raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
      select * into v_other from clued_private.owner_grant_actions where action=v_item->>'action';
      if not found or not ('release-workflow'=any(v_other.doors)) or v_other.action=v_action.action
          or v_with @> jsonb_build_array(jsonb_build_object('action',v_other.action)) then
        raise exception 'owner_grant_door_action_invalid' using errcode='22023'; end if;
      if jsonb_typeof(v_item->'resources') is distinct from 'array'
          or jsonb_array_length(v_item->'resources') not between 1 and 50 then
        raise exception 'owner_grant_door_resources_invalid' using errcode='22023'; end if;
      v_other_resources:=clued_private.work_claim_normalize_paths(v_item->'resources');
      if cardinality(v_other_resources) not between 1 and 50 then
        raise exception 'owner_grant_door_resources_invalid' using errcode='22023'; end if;
      v_with:=v_with||jsonb_build_array(jsonb_build_object('action',v_other.action,'resources',to_jsonb(v_other_resources)));
    end loop;
  end if;
  v_grant:=clued_private.owner_grant_consume_door_v1(v_binding.user_id,v_binding.id,v_action.action,v_resources);
  if v_grant is not null then
    return jsonb_build_object('status','ok','consumed',true,'action',v_action.action,
      'resources',to_jsonb(v_resources),'grant',v_grant);
  end if;
  -- No grant: reuse this door's pending request for the same action and
  -- resources, or open one, with the others the run named.
  v_req:=clued_private.owner_grant_door_request_v1(v_binding,v_action.action,v_resources);
  v_ids:=array[v_req.id];
  for v_item in select value from jsonb_array_elements(v_with) loop
    select array_agg(value order by ordinality) into v_other_resources
      from jsonb_array_elements_text(v_item->'resources') with ordinality;
    continue when clued_private.owner_grant_door_admits_v1(v_binding.user_id,v_item->>'action',v_other_resources);
    v_member:=clued_private.owner_grant_door_request_v1(v_binding,v_item->>'action',v_other_resources);
    v_ids:=v_ids||v_member.id;
  end loop;
  if cardinality(v_ids)>1 then
    perform clued_private.owner_request_bundle_join_v1(v_binding.user_id,v_ids);
    select * into v_req from clued_private.owner_requests_v1 where id=v_req.id;
  end if;
  return jsonb_build_object('status','ok','consumed',false,'action',v_action.action,
    'resources',to_jsonb(v_resources),'owner_request',clued_private.owner_request_public_v1(v_req));
end $$;

revoke all on function clued_private.owner_request_bundle_join_v1(uuid,uuid[]),
  clued_private.owner_grant_door_admits_v1(uuid,text,text[]),
  clued_private.owner_grant_door_request_v1(public.clued_agent_bindings,text,text[]),
  public.clued_owner_request_bundle_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_owner_request_bundle_v1(text,jsonb) to anon;

notify pgrst,'reload schema';
