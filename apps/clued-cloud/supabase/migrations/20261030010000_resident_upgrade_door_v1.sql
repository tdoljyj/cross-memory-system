-- Resident CI in-place upgrade, PR-0 (Task 018da927; Owner Decisions dda41297
-- and 3ce5200c): the Grant door for ci.resident_upgrade.
--
-- A resident CI node upgrades itself only with an Owner Grant that names the
-- node and the exact package: ci-resident:<nodeName>/<packageManifestSha256>.
-- The node's upgrader asks through the existing anonymous release RPC
-- clued_owner_grant_door_consume_v1 (no new anon RPC: the anon definer surface
-- stays CI8), which hands this action to a private function at its first line.
--
-- 1. Registry: resource kind ci-resident; action ci.resident_upgrade at door
--    resident-upgrader, risk high (approved once by default: 24 hours, one
--    use). It is never automatic (Decision 3ce5200c): auto_approvable is false,
--    a check keeps it false, and the door never calls the auto-approval step,
--    so even with the switch on a request stays pending until the Owner
--    approves it on the page.
--    Every request and grant of the action names exactly one resource of the
--    ci-resident pattern; a grant is once (one use, at most 24 hours) and goes
--    to the requesting Binding only (table checks).
-- 2. Binding role resident-upgrade, marked by the Owner on /bindings like
--    release-door. Each node has its own Binding, and the node is that
--    Binding's name: the Owner marks only a Binding whose agent_name is a node
--    name, that has no other role, whose scopes are exactly context:read, and
--    whose name no other live resident-upgrade Binding of the Owner carries.
--    No other role (by hand or by ci-admission handover) is marked on a
--    resident-upgrade Binding.
-- 3. clued_private.owner_grant_resident_upgrade_door_v1: input {action,
--    resources, op_id, note?}; only a Binding whose resident-upgrade row is
--    live and started (exact holder, no "role unmarked" opening) and that can
--    only read; exactly one resource matching the ci-resident pattern, no
--    glob, naming the caller's own node (its agent_name); a repeated op_id
--    replays its use receipt unless the Owner revoked that grant; otherwise a
--    live grant given to this Binding for exactly this resource is used once
--    and the use receipt records door resident-upgrader and op_id; otherwise
--    the op's request (idempotency key resident-upgrade:<op_id>) is returned
--    as it stands, or opened (origin resident-upgrader, one use, 24 hours). A
--    rejected or expired request is returned as it is; a new op needs a new
--    grant.
-- 4. clued_owner_grant_door_consume_v1 hands this action to (3) right after
--    its payload cap. release.production and migration.production keep every
--    other statement as it was.
-- 5. An Agent cannot open this request itself (door-only), cannot bundle it;
--    the Owner cannot grant it without a request; the confirmation page
--    approves it only once, for the requesting Binding and the exact resource;
--    the page names the upgrader as the author of its note.
--
-- Anchored patches: each replaces one statement and fails unless the anchor
-- occurs exactly once.

-- 1. Registry -----------------------------------------------------------------

insert into clued_private.work_claim_resource_kinds(kind,doors,note) values
  ('ci-resident',array['resident-upgrader'],
   'ci-resident:<nodeName>/<packageManifestSha256>; one resident CI node upgraded to one exact package, approved by the Owner');
insert into clued_private.owner_grant_actions(action,doors,title,risk,auto_approvable) values
  ('ci.resident_upgrade',array['resident-upgrader'],'把常驻 CI 节点原地升级到指定的包（按节点与包 manifest 精确匹配）','high',false);
alter table clued_private.owner_grant_actions drop constraint owner_grant_actions_auto_approvable_check;
alter table clued_private.owner_grant_actions add constraint owner_grant_actions_auto_approvable_check
  check (not auto_approvable or action not in ('connection.permission','ci.resident_upgrade'));
alter table clued_private.owner_requests_v1 add constraint owner_requests_v1_resident_upgrade_check
  check (action<>'ci.resident_upgrade' or (cardinality(resources)=1
    and resources[1] ~ '^ci-resident:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?/[0-9a-f]{64}$'));
alter table clued_private.owner_grants_v1 add constraint owner_grants_v1_resident_upgrade_check
  check (action<>'ci.resident_upgrade' or (cardinality(resources)=1
    and resources[1] ~ '^ci-resident:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?/[0-9a-f]{64}$'
    and max_uses=1 and grantee_binding_id is not null and request_id is not null
    and expires_at<=granted_at+interval '24 hours'));

-- 2. Binding role resident-upgrade ----------------------------------------------

alter table clued_private.binding_roles_v1 drop constraint binding_roles_v1_role_check;
alter table clued_private.binding_roles_v1 add constraint binding_roles_v1_role_check
  check (role in ('ci-admission','release-door','resident-upgrade'));

create or replace function clued_private.binding_role_title_v1(p_role text) returns text
language sql immutable set search_path='' as $$
  select case p_role
    when 'ci-admission' then 'GitHub CI 准入（绑定 PR、计入 CI 额度、手动触发准入、合并后采纳）'
    when 'release-door' then '生产发布门口（消费发布与迁移授权）'
    when 'resident-upgrade' then '常驻节点升级门口（消费本节点的原地升级授权）' end
$$;

create function clued_private.resident_upgrade_door_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'resident_upgrade_door_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

select clued_private.resident_upgrade_door_patch_v1('public.clued_binding_roles_list_v1(jsonb)',
$a$          where r.user_id=v_owner and r.role='release-door' and r.revoked_at is null))),$a$,
$r$          where r.user_id=v_owner and r.role='release-door' and r.revoked_at is null)),
      jsonb_build_object('role','resident-upgrade','title',clued_private.binding_role_title_v1('resident-upgrade'),
        'required_scope','context:read',
        'marked',exists(select 1 from clued_private.binding_roles_v1 r
          where r.user_id=v_owner and r.role='resident-upgrade' and r.revoked_at is null))),$r$);

select clued_private.resident_upgrade_door_patch_v1('public.clued_binding_role_confirmation_issue_v1(jsonb)',
$a$    if v_role is null or v_role not in ('ci-admission','release-door') then$a$,
$r$    if v_role is null or v_role not in ('ci-admission','release-door','resident-upgrade') then$r$);

select clued_private.resident_upgrade_door_patch_v1('public.clued_binding_role_confirmation_issue_v1(jsonb)',
$a$    if v_enabled and not ((case v_role when 'ci-admission' then 'context:read' else 'context:write' end)=any(b.scopes)) then$a$,
$r$    if v_enabled and not ((case v_role when 'ci-admission' then 'context:read' when 'resident-upgrade' then 'context:read'
        else 'context:write' end)=any(b.scopes)) then$r$);

-- Both Native steps of a hand change (confirmation and set, under the role's
-- lock) run this check; only marking reaches the anchor.
select clued_private.resident_upgrade_door_patch_v1(
  'clued_private.binding_role_change_check_v1(public.clued_agent_bindings,text,boolean,jsonb)',
$a$  if p_role<>'ci-admission' then
    if p_purpose is not null then raise exception 'binding_role_purpose_invalid' using errcode='22023'; end if;$a$,
$r$  -- Task 018da927: a resident-upgrade Binding is one node's upgrader and nothing else.
  if p_role='resident-upgrade' then
    if exists(select 1 from clued_private.binding_roles_v1 x where x.binding_id=p_binding.id and x.revoked_at is null) then
      raise exception 'binding_role_exclusive' using errcode='22023'; end if;
    if not (p_binding.scopes <@ array['context:read'] and 'context:read'=any(p_binding.scopes)) then
      raise exception 'binding_role_scope_invalid' using errcode='22023'; end if;
    if p_binding.agent_name !~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$' then
      raise exception 'binding_role_node_name_invalid' using errcode='22023'; end if;
    if exists(select 1 from clued_private.binding_roles_v1 x join public.clued_agent_bindings o on o.id=x.binding_id
        where x.user_id=p_binding.user_id and x.role='resident-upgrade' and x.revoked_at is null
          and o.id<>p_binding.id and o.agent_name=p_binding.agent_name) then
      raise exception 'binding_role_node_taken' using errcode='22023'; end if;
  elsif exists(select 1 from clued_private.binding_roles_v1 x
      where x.binding_id=p_binding.id and x.role='resident-upgrade' and x.revoked_at is null) then
    raise exception 'binding_role_exclusive' using errcode='22023';
  end if;
  if p_role<>'ci-admission' then
    if p_purpose is not null then raise exception 'binding_role_purpose_invalid' using errcode='22023'; end if;$r$);

-- A ci-admission handover never lands on a resident-upgrade Binding.
select clued_private.resident_upgrade_door_patch_v1(
  'clued_private.binding_role_handover_check_v1(public.clued_agent_bindings,public.clued_agent_bindings)',
$a$      where r.binding_id=p_to.id and r.role='ci-admission' and r.revoked_at is null) then$a$,
$r$      where r.binding_id=p_to.id and r.role in ('ci-admission','resident-upgrade') and r.revoked_at is null) then$r$);

-- 3. The resident-upgrader door ---------------------------------------------------

create function clued_private.owner_grant_resident_upgrade_door_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings; v_resource text; v_resources text[]; v_op text; v_note text;
  v_prior public.clued_audit_receipts%rowtype; g clued_private.owner_grants_v1%rowtype; v_receipt uuid;
  v_req clued_private.owner_requests_v1%rowtype; v_key text;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('action','resources','op_id','note'))
      or p_input->>'action' is distinct from 'ci.resident_upgrade'
      or jsonb_typeof(p_input->'op_id') is distinct from 'string'
      or p_input->>'op_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (p_input ? 'note' and (jsonb_typeof(p_input->'note') is distinct from 'string'
        or char_length(p_input->>'note')>2000)) then
    raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
  v_op:=p_input->>'op_id';
  v_note:=nullif(btrim(p_input->>'note'),'');
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  -- Exact holder: only a Binding the Owner marked resident-upgrade, whose row
  -- has started and which can only read. An unmarked role admits nobody.
  if not exists(select 1 from clued_private.binding_roles_v1 r
      where r.user_id=v_binding.user_id and r.binding_id=v_binding.id and r.role='resident-upgrade'
        and r.revoked_at is null and r.effective_at<=clock_timestamp())
      or not (v_binding.scopes <@ array['context:read']) then
    raise exception 'owner_grant_door_binding_not_authorized' using errcode='42501'; end if;
  if jsonb_typeof(p_input->'resources') is distinct from 'array'
      or jsonb_array_length(p_input->'resources')<>1
      or jsonb_typeof(p_input->'resources'->0) is distinct from 'string'
      or p_input->'resources'->>0 !~ '^ci-resident:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?/[0-9a-f]{64}$' then
    raise exception 'owner_grant_door_resources_invalid' using errcode='22023'; end if;
  v_resource:=p_input->'resources'->>0;
  v_resources:=clued_private.work_claim_normalize_paths(p_input->'resources');
  if v_resources is distinct from array[v_resource] then
    raise exception 'owner_grant_door_resources_invalid' using errcode='22023'; end if;
  -- The node is the Binding's own name (checked when the Owner marked it).
  if split_part(substr(v_resource,char_length('ci-resident:')+1),'/',1)<>v_binding.agent_name then
    raise exception 'owner_grant_door_resources_invalid' using errcode='22023',detail='resident_node_mismatch'; end if;
  perform clued_private.owner_grant_lock_v1(v_binding.user_id);
  v_key:='resident-upgrade:'||v_op;
  -- The same op again: its use receipt decides, unless the Owner has revoked
  -- that grant since (its expiry does not matter). A revoked op stays
  -- unconsumed; a new op needs a new grant.
  select * into v_prior from public.clued_audit_receipts r
    where r.user_id=v_binding.user_id and r.operation='owner_grant_use' and r.object_type='owner_grant'
      and r.metadata->>'door'='resident-upgrader' and r.metadata->>'op_id'=v_op
    order by r.created_at,r.id limit 1;
  if found then
    if v_prior.binding_id is distinct from v_binding.id or v_prior.metadata->'resources'<>to_jsonb(v_resources) then
      raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
    select * into g from clued_private.owner_grants_v1 where id=(v_prior.metadata->>'grant_id')::uuid;
    if g.revoked_at is not null then
      select * into v_req from clued_private.owner_requests_v1 r
        where r.user_id=v_binding.user_id and r.binding_id=v_binding.id and r.idempotency_key=v_key;
      return jsonb_build_object('status','ok','consumed',false,'revoked',true,'action','ci.resident_upgrade',
        'resources',to_jsonb(v_resources),'grant',jsonb_build_object('grant_id',g.id,'receipt_id',v_prior.id,
          'use',(v_prior.metadata->>'use')::integer,'max_uses',g.max_uses,'expires_at',g.expires_at,
          'replayed',true,'revoked',true),
        'owner_request',case when v_req.id is null then null else clued_private.owner_request_public_v1(v_req) end);
    end if;
    return jsonb_build_object('status','ok','consumed',true,'action','ci.resident_upgrade',
      'resources',to_jsonb(v_resources),'grant',jsonb_build_object('grant_id',g.id,'receipt_id',v_prior.id,
        'use',(v_prior.metadata->>'use')::integer,'max_uses',g.max_uses,'expires_at',g.expires_at,'replayed',true));
  end if;
  -- A live grant given to this Binding for exactly this node and package.
  select * into g from clued_private.owner_grants_v1 x
    where x.user_id=v_binding.user_id and x.action='ci.resident_upgrade' and x.revoked_at is null
      and x.grantee_binding_id=v_binding.id
      and x.expires_at>clock_timestamp() and (x.max_uses is null or x.uses<x.max_uses)
      and x.resources=v_resources
    order by x.expires_at,x.granted_at limit 1 for update;
  if found then
    update clued_private.owner_grants_v1 set uses=uses+1 where id=g.id;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_binding.user_id,v_binding.id,'global','owner_grant_use','owner_grant',g.id::text,g.uses+1,
      jsonb_build_object('receipt_kind','OWNER_GRANT_USED','grant_id',g.id,'action','ci.resident_upgrade',
        'resources',to_jsonb(v_resources),'door','resident-upgrader','op_id',v_op,'use',g.uses+1,'max_uses',g.max_uses))
    returning id into v_receipt;
    return jsonb_build_object('status','ok','consumed',true,'action','ci.resident_upgrade',
      'resources',to_jsonb(v_resources),'grant',jsonb_build_object('grant_id',g.id,'receipt_id',v_receipt,
        'use',g.uses+1,'max_uses',g.max_uses,'expires_at',g.expires_at,'replayed',false));
  end if;
  -- No grant: this op's request as it stands, or a new one. Never automatic.
  select * into v_req from clued_private.owner_requests_v1 r
    where r.user_id=v_binding.user_id and r.binding_id=v_binding.id and r.idempotency_key=v_key;
  if found then
    if v_req.action<>'ci.resident_upgrade' or v_req.resources<>v_resources then
      raise exception 'owner_grant_door_input_invalid' using errcode='22023'; end if;
  else
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_binding.user_id,v_binding.id,'global','owner_request_create','owner_request','ci.resident_upgrade',1,
      jsonb_build_object('receipt_kind','OWNER_REQUEST_CREATED','action','ci.resident_upgrade',
        'resources',to_jsonb(v_resources),'origin','resident-upgrader','op_id',v_op))
    returning id into v_receipt;
    insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,
      suggested_max_uses,agent_note,expires_at,receipt_id)
    values(v_binding.user_id,v_binding.id,v_key,'ci.resident_upgrade',v_resources,
      1,v_note,clock_timestamp()+interval '24 hours',v_receipt)
    returning * into v_req;
  end if;
  return jsonb_build_object('status','ok','consumed',false,'action','ci.resident_upgrade',
    'resources',to_jsonb(v_resources),'owner_request',clued_private.owner_request_public_v1(v_req));
end $$;

revoke all on function clued_private.owner_grant_resident_upgrade_door_v1(text,jsonb)
  from public,anon,authenticated,service_role;

-- 4. The release RPC hands this action over ------------------------------------

select clued_private.resident_upgrade_door_patch_v1('public.clued_owner_grant_door_consume_v1(text,jsonb)',
$a$  perform clued_private.intake_payload_cap_v1(p_input);$a$,
$r$  perform clued_private.intake_payload_cap_v1(p_input);
  -- Task 018da927: the resident-upgrader door (its own Binding role and rules).
  if p_input->>'action'='ci.resident_upgrade' then
    return clued_private.owner_grant_resident_upgrade_door_v1(p_token_hash,p_input); end if;$r$);

-- 5. Door-only, never bundled, exact on the page, the upgrader's note ----------

select clued_private.resident_upgrade_door_patch_v1('public.clued_owner_request_v1(text,jsonb)',
$a$  if p_input->>'action'='repo.protected_change' then$a$,
$r$  if p_input->>'action' in ('repo.protected_change','ci.resident_upgrade') then$r$);

select clued_private.resident_upgrade_door_patch_v1('public.clued_owner_request_bundle_v1(text,jsonb)',
$a$          or x->>'action' in ('connection.permission','repo.protected_change'))$a$,
$r$          or x->>'action' in ('connection.permission','repo.protected_change','ci.resident_upgrade'))$r$);

select clued_private.resident_upgrade_door_patch_v1('public.clued_owner_request_view_v1(jsonb)',
$a$    'resource_options',case when v_req.action='repo.protected_change' then$a$,
$r$    'resource_options',case when v_req.action in ('repo.protected_change','ci.resident_upgrade') then$r$);

select clued_private.resident_upgrade_door_patch_v1('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
$a$            or (v_req.action='repo.protected_change' and not (v_resources <@ v_req.resources))) then$a$,
$r$            or (v_req.action in ('repo.protected_change','ci.resident_upgrade') and not (v_resources <@ v_req.resources))) then$r$);

-- Approved only once (one use, 24 hours) and only for the requesting Binding,
-- like connection.permission; with the request's resources fixed for "once".
select clued_private.resident_upgrade_door_patch_v1('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
$a$      if v_req.action='connection.permission'
          and (v_choice<>'once'$a$,
$r$      if v_req.action in ('connection.permission','ci.resident_upgrade')
          and (v_choice<>'once'$r$);

-- Never granted without the door's request.
select clued_private.resident_upgrade_door_patch_v1('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
$a$      if p_input->>'action'='connection.permission' then
        raise exception 'owner_grant_action_request_only'$a$,
$r$      if p_input->>'action' in ('connection.permission','ci.resident_upgrade') then
        raise exception 'owner_grant_action_request_only'$r$);

-- The note_source of 20261005140000 is in owner_grant_view_v1, which
-- 20261014044323 renames to owner_grant_view_before_contexts_v2 (the new
-- owner_grant_view_v1 calls it). Patch whichever body holds it, so a database
-- that installs the authorization successors after this file keeps the patch.
select clued_private.resident_upgrade_door_patch_v1(coalesce(
    to_regprocedure('clued_private.owner_grant_view_before_contexts_v2(uuid,jsonb)')::text,
    'clued_private.owner_grant_view_v1(uuid,jsonb)'),
$a$              and rc.metadata->>'origin'='ci-admission') then 'ci-admission' else 'agent' end) end);$a$,
$r$              and rc.metadata->>'origin'='ci-admission') then 'ci-admission'
          when exists(select 1 from public.clued_audit_receipts rc
            where rc.id=v_req.receipt_id and rc.operation='owner_request_create'
              and rc.metadata->>'origin'='resident-upgrader') then 'resident-upgrader' else 'agent' end) end);$r$);

drop function clued_private.resident_upgrade_door_patch_v1(text,text,text);

notify pgrst,'reload schema';
