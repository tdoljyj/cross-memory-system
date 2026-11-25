-- Accepting a universal node package is an Owner Grant, not a sentence in a
-- chat (Task 87d330d0; plans PLAN-accept-auto-seal-20261125 2.1, 2.2, part A
-- and PLAN-accept-binding-20261125 section 3; framework G9, Owner Decision
-- 61b65d61).
--
-- The Owner accepts one package by approving a fleet.accept request on the
-- confirmation page. The grant's id, its use receipt and the time of the
-- approval are the three values the publisher's seal writes into the
-- acceptance file; nobody copies the Owner's words and no Decision record is
-- written by hand.
--
-- No Binding and no token takes part. The request is opened by the release
-- workflow's database login (the identity of 20261119130000,
-- clued_private.release_identity_v1), the accepted row is written by the
-- Owner's approval itself, and the result is read anonymously.
--
-- 1. Registry: resource kind fleet-node; action fleet.accept at its own door
--    name fleet-accept (not release-workflow: clued_private.release_door_v1
--    approves automatically and must never see this action), risk high. It is
--    never automatic: auto_approvable is false, the table check keeps it
--    false, the door never calls the automatic step, and a grant of the
--    action must come from the page (auto_approve_id is null). Every request
--    and grant names exactly one resource,
--    fleet-node:<owner>/<repo>/<version>/<archive sha256>/<acceptance request sha256>;
--    a grant is once and goes to the requesting anchor only (table checks).
-- 2. Request and approval surfaces: no Binding token may ask for the action
--    (clued_owner_request_v1, bundles; the public token door answers
--    owner_grant_door_action_invalid, unchanged). The page approves it only
--    once, for the requester and the exact resource, and never without the
--    door's request (owner_grant_action_request_only). The approval RPCs are
--    the Owner's signed-in session only, as for every grant (20261002220000).
-- 3. clued_private.fleet_accepted_v1: one row per (owner, repository,
--    version). It is what "accepted" means.
-- 4. clued_private.fleet_accept_apply_v1, called by clued_owner_grant_v1 in
--    the approval's transaction (as connection_permission_apply_v1,
--    20261004150000): refuses a version already accepted, marks the grant
--    used, writes the use receipt and the row. Any refusal rolls the grant
--    back with it.
-- 5. clued_private.fleet_accept_door_v1(p_input): security definer, executable
--    by its owner only (the migration login); not on PostgREST. Input
--    {action:'fleet.accept', resources:[<one>], run_id?, run_attempt?}. The
--    resource names the registered repository. It replays an accepted row,
--    replays a request the Owner rejected (final: it never asks the Owner
--    about that package again; accepting it takes a new version), refuses the
--    version under other hashes (fleet_accept_version_already_accepted), or
--    reuses or opens the pending request on the identity's anchor (a new one
--    only when there is none or the last one expired). It never consumes and
--    never approves.
-- 6. public.clued_fleet_accept_status_v1(p_resource): anonymous, read only.
--    Answers none, pending, accepted, rejected or expired for exactly that
--    resource; every answer carries request_sha256 (the resource's last
--    part). What it shows is what the Release publishes as acceptance.json
--    plus the in-service nodes' (state active or draining) names and reported
--    Source; the confirmation
--    page it points at needs the Owner's session.
--
-- Anchored patches: each replaces one piece of text and fails unless the
-- anchor occurs exactly once.

-- 1. Registry -----------------------------------------------------------------

insert into clued_private.work_claim_resource_kinds(kind,doors,note) values
  ('fleet-node',array['fleet-accept'],
   'fleet-node:<owner>/<repo>/<version>/<archive sha256>/<acceptance request sha256>; one universal node package accepted by the Owner for every registered node');
insert into clued_private.owner_grant_actions(action,doors,title,risk,auto_approvable) values
  ('fleet.accept',array['fleet-accept'],'接受通用节点包（版本与哈希见范围）：全部登记节点原地升级，当班节点升级时 CI 暂停几分钟。拒绝即这个包不要了，此包不再询问，要接受须出新版本；只是先不接受就不点，请求 24 小时后过期可重开','high',false);
alter table clued_private.owner_grant_actions drop constraint owner_grant_actions_auto_approvable_check;
alter table clued_private.owner_grant_actions add constraint owner_grant_actions_auto_approvable_check
  check (not auto_approvable or action not in ('connection.permission','fleet.accept'));

create function clued_private.fleet_accept_resource_ok_v1(p_resource text) returns boolean
language sql immutable set search_path='' as $$
  select p_resource is not null and p_resource ~
    '^fleet-node:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9][A-Za-z0-9._+-]{0,88}/[0-9a-f]{64}/[0-9a-f]{64}$'
$$;
revoke all on function clued_private.fleet_accept_resource_ok_v1(text) from public,anon,authenticated,service_role,clued_worker_gateway;

alter table clued_private.owner_requests_v1 add constraint owner_requests_v1_fleet_accept_check
  check (action<>'fleet.accept' or (cardinality(resources)=1 and clued_private.fleet_accept_resource_ok_v1(resources[1])));
alter table clued_private.owner_grants_v1 add constraint owner_grants_v1_fleet_accept_check
  check (action<>'fleet.accept' or (cardinality(resources)=1 and clued_private.fleet_accept_resource_ok_v1(resources[1])
    and max_uses is not distinct from 1 and grantee_binding_id is not null and request_id is not null
    and auto_approve_id is null and expires_at<=granted_at+interval '24 hours'));

-- 2. Request and approval surfaces ------------------------------------------------

do $patch$
declare x record; body text;
begin
  for x in select * from (values
    -- Door-only, never bundled, exact and once on the page, never without the
    -- door's request (as ci.resident_upgrade and ci.connection_renew).
    ('public.clued_owner_request_v1(text,jsonb)',
     $a$in ('repo.protected_change','ci.resident_upgrade','ci.connection_renew')$a$,
     $r$in ('repo.protected_change','ci.resident_upgrade','ci.connection_renew','fleet.accept')$r$),
    ('public.clued_owner_request_bundle_v1(text,jsonb)',
     $a$'connection.permission','repo.protected_change','ci.resident_upgrade','ci.connection_renew'$a$,
     $r$'connection.permission','repo.protected_change','ci.resident_upgrade','ci.connection_renew','fleet.accept'$r$),
    ('public.clued_owner_request_view_v1(jsonb)',
     $a$in ('repo.protected_change','ci.resident_upgrade','ci.connection_renew')$a$,
     $r$in ('repo.protected_change','ci.resident_upgrade','ci.connection_renew','fleet.accept')$r$),
    ('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
     $a$in ('repo.protected_change','ci.resident_upgrade','ci.connection_renew')$a$,
     $r$in ('repo.protected_change','ci.resident_upgrade','ci.connection_renew','fleet.accept')$r$),
    ('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
     $a$v_req.action in ('connection.permission','ci.resident_upgrade','ci.connection_renew')$a$,
     $r$v_req.action in ('connection.permission','ci.resident_upgrade','ci.connection_renew','fleet.accept')$r$),
    ('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
     $a$p_input->>'action' in ('connection.permission','ci.resident_upgrade','ci.connection_renew')$a$,
     $r$p_input->>'action' in ('connection.permission','ci.resident_upgrade','ci.connection_renew','fleet.accept')$r$)
  ) v(sig,anchor,replacement) loop
    body:=pg_get_functiondef(x.sig::regprocedure);
    if (length(body)-length(replace(body,x.anchor,'')))<>length(x.anchor) then
      raise exception 'fleet_accept_door_patch_anchor_mismatch: % [%]',x.sig,x.anchor; end if;
    execute replace(body,x.anchor,x.replacement);
  end loop;
end $patch$;

-- 3. The accepted row ------------------------------------------------------------

create table clued_private.fleet_accepted_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  version text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,88}$'),
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  grant_id uuid not null unique references clued_private.owner_grants_v1(id),
  receipt_id uuid not null unique references public.clued_audit_receipts(id),
  binding_id uuid not null references public.clued_agent_bindings(id),
  accepted_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (user_id,repository,version)
);
create index fleet_accepted_v1_latest_idx on clued_private.fleet_accepted_v1(user_id,repository,accepted_at desc);
alter table clued_private.fleet_accepted_v1 enable row level security;
revoke all on clued_private.fleet_accepted_v1 from public,anon,authenticated,service_role,clued_worker_gateway;


-- 4. The approval writes the row ---------------------------------------------------

-- The parts of a checked resource: repository, version, archive, request.
create function clued_private.fleet_accept_parts_v1(p_resource text) returns text[]
language sql immutable set search_path='' as $$
  select array[p[1]||'/'||p[2],p[3],p[4],p[5]]
  from (select string_to_array(substr(p_resource,char_length('fleet-node:')+1),'/') p) s
  where clued_private.fleet_accept_resource_ok_v1(p_resource)
$$;

-- Runs inside clued_owner_grant_v1's transaction after the grant row is
-- written. Any failure rolls the grant back with it.
create function clued_private.fleet_accept_apply_v1(p_owner uuid,p_grant_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare g clued_private.owner_grants_v1%rowtype; v_identity clued_private.release_identity_v1%rowtype;
  v_parts text[]; v_receipt uuid;
begin
  select * into g from clued_private.owner_grants_v1 where id=p_grant_id and user_id=p_owner for update;
  if not found or g.action<>'fleet.accept' or g.request_id is null or g.token_id is null
      or g.auto_approve_id is not null or cardinality(g.resources)<>1 or g.uses<>0 then
    raise exception 'owner_grant_choice_invalid' using errcode='22023'; end if;
  select * into v_identity from clued_private.release_identity_v1;
  if not found or v_identity.user_id<>p_owner or g.grantee_binding_id is distinct from v_identity.anchor_binding_id
      or not exists(select 1 from clued_private.owner_requests_v1 r where r.id=g.request_id and r.user_id=p_owner
        and r.binding_id=v_identity.anchor_binding_id and r.action='fleet.accept' and r.resources=g.resources) then
    raise exception 'fleet_accept_request_invalid' using errcode='55000'; end if;
  v_parts:=clued_private.fleet_accept_parts_v1(g.resources[1]);
  if v_parts is null or v_parts[1]<>v_identity.repository then
    raise exception 'fleet_accept_request_invalid' using errcode='55000'; end if;
  -- One acceptance per version, whatever the hashes.
  if exists(select 1 from clued_private.fleet_accepted_v1 a
      where a.user_id=p_owner and a.repository=v_parts[1] and a.version=v_parts[2]) then
    raise exception 'fleet_accept_version_already_accepted' using errcode='55000'; end if;
  update clued_private.owner_grants_v1 set uses=uses+1 where id=g.id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(p_owner,v_identity.anchor_binding_id,'global','owner_grant_use','owner_grant',g.id::text,1,
    jsonb_build_object('receipt_kind','OWNER_GRANT_USED','grant_id',g.id,'action','fleet.accept',
      'resources',to_jsonb(g.resources),'door','fleet-accept','use',1,'max_uses',g.max_uses,
      'used_by','owner_approval','request_id',g.request_id))
  returning id into v_receipt;
  insert into clued_private.fleet_accepted_v1(user_id,repository,version,archive_sha256,request_sha256,
    grant_id,receipt_id,binding_id,accepted_at)
  values(p_owner,v_parts[1],v_parts[2],v_parts[3],v_parts[4],g.id,v_receipt,v_identity.anchor_binding_id,g.granted_at);
end $$;

do $patch$
declare body text:=pg_get_functiondef('public.clued_owner_grant_v1(jsonb)'::regprocedure);
  anchor text:=$a$    if v_grant.action='connection.permission' then
      perform clued_private.connection_permission_apply_v1(v_owner,v_grant.id);
    end if;$a$;
begin
  if (length(body)-length(replace(body,anchor,'')))<>length(anchor) then
    raise exception 'fleet_accept_door_patch_anchor_mismatch: clued_owner_grant_v1'; end if;
  execute replace(body,anchor,anchor||$r$
    if v_grant.action='fleet.accept' then
      perform clued_private.fleet_accept_apply_v1(v_owner,v_grant.id);
    end if;$r$);
end $patch$;

-- 5. The answer, the door and the anonymous read -------------------------------------

-- The one answer for a checked resource of this account: the door and the
-- anonymous read both return it.
create function clued_private.fleet_accept_answer_v1(p_user uuid,p_anchor uuid,p_resource text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_parts text[]:=clued_private.fleet_accept_parts_v1(p_resource); v_base jsonb;
  v_row clued_private.fleet_accepted_v1%rowtype; v_req clued_private.owner_requests_v1%rowtype;
begin
  if v_parts is null then raise exception 'fleet_accept_resource_invalid' using errcode='22023'; end if;
  v_base:=jsonb_build_object('action','fleet.accept','resources',jsonb_build_array(p_resource),
    'repository',v_parts[1],'version',v_parts[2],'archive_sha256',v_parts[3],'request_sha256',v_parts[4]);
  select * into v_row from clued_private.fleet_accepted_v1 a
    where a.user_id=p_user and a.repository=v_parts[1] and a.version=v_parts[2];
  if found and v_row.archive_sha256=v_parts[3] and v_row.request_sha256=v_parts[4] then
    return v_base||jsonb_build_object('status','accepted','grant_id',v_row.grant_id,'receipt_id',v_row.receipt_id,
      'accepted_at',v_row.accepted_at,
      -- The fleet is the in-service nodes (active or draining, as the gateway and the duty holder count them;
      -- a registered node not yet approved is not in it). Each node exactly what rollout/fleet/accept-door.mjs
      -- readFleet uses: name, reported Source, paused.
      'nodes',coalesce((select jsonb_agg(jsonb_build_object('name',n.name,
          'source_sha256',l.reported_source_sha256,
          'paused',coalesce(l.reported_state in ('PAUSED','INTAKE_PAUSED'),false)) order by n.name,n.created_at,n.node_id)
        from clued_private.ci_nodes_v1 n left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id
        where n.user_id=p_user and n.state in ('active','draining')),'[]'::jsonb));
  end if;
  if found then
    -- This version is accepted as another package or request: this one never will be.
    return v_base||jsonb_build_object('status','none','conflict','fleet_accept_version_already_accepted');
  end if;
  select * into v_req from clued_private.owner_requests_v1 r
    where r.user_id=p_user and r.binding_id=p_anchor and r.action='fleet.accept' and r.resources=array[p_resource]
    order by r.created_at desc,r.id desc limit 1;
  if not found then return v_base||jsonb_build_object('status','none'); end if;
  if v_req.status='pending' and v_req.expires_at>clock_timestamp() then
    return v_base||jsonb_build_object('status','pending','request_id',v_req.id,
      'confirm_path','/confirm/'||v_req.id::text,'expires_at',v_req.expires_at);
  end if;
  -- Decided without a row: the Owner said no. A pending one past its time ran out.
  return v_base||jsonb_build_object('status',case when v_req.status='rejected' then 'rejected' else 'expired' end,
    'request_id',v_req.id,'decided_at',v_req.decided_at,'expires_at',v_req.expires_at);
end $$;

create function clued_private.fleet_accept_door_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_identity clued_private.release_identity_v1%rowtype; v_anchor public.clued_agent_bindings;
  v_resource text; v_parts text[]; v_answer jsonb; v_req clued_private.owner_requests_v1%rowtype;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('action','resources','run_id','run_attempt'))
      or p_input->>'action' is distinct from 'fleet.accept'
      or (p_input ? 'run_id' and (jsonb_typeof(p_input->'run_id') is distinct from 'string'
        or p_input->>'run_id' !~ '^[1-9][0-9]{0,19}$'))
      or (p_input ? 'run_attempt' and (jsonb_typeof(p_input->'run_attempt') is distinct from 'string'
        or p_input->>'run_attempt' !~ '^[1-9][0-9]{0,5}$')) then
    raise exception 'fleet_accept_door_input_invalid' using errcode='22023'; end if;
  -- The identity, as clued_private.release_door_v1 checks it.
  select * into v_identity from clued_private.release_identity_v1;
  if not found then raise exception 'release_door_identity_missing' using errcode='55000'; end if;
  perform clued_private.authorization_account_v12(v_identity.user_id);
  select * into v_anchor from public.clued_agent_bindings b
    where b.id=v_identity.anchor_binding_id and b.user_id=v_identity.user_id;
  if not found or v_anchor.revoked_at is null then
    raise exception 'release_door_identity_invalid' using errcode='55000'; end if;
  if not exists(select 1 from clued_private.owner_grant_actions a
      where a.action='fleet.accept' and a.doors=array['fleet-accept'] and not a.auto_approvable) then
    raise exception 'fleet_accept_door_action_missing' using errcode='55000'; end if;
  if jsonb_typeof(p_input->'resources') is distinct from 'array' or jsonb_array_length(p_input->'resources')<>1
      or jsonb_typeof(p_input->'resources'->0) is distinct from 'string' then
    raise exception 'fleet_accept_door_resources_invalid' using errcode='22023'; end if;
  v_resource:=p_input->'resources'->>0;
  v_parts:=clued_private.fleet_accept_parts_v1(v_resource);
  if v_parts is null or v_parts[1]<>v_identity.repository then
    raise exception 'fleet_accept_door_resources_invalid' using errcode='22023'; end if;
  perform clued_private.owner_grant_lock_v1(v_identity.user_id);
  v_answer:=clued_private.fleet_accept_answer_v1(v_identity.user_id,v_anchor.id,v_resource);
  -- Accepted, or rejected by the Owner: both final. The Owner's no is never asked again for this
  -- package; accepting it takes a new version. Only none and expired open a request.
  if v_answer->>'status' in ('accepted','rejected') then return v_answer; end if;
  if v_answer ? 'conflict' then
    raise exception 'fleet_accept_version_already_accepted' using errcode='22023'; end if;
  -- Ask the Owner: the pending request for this resource, or a new one. Never
  -- consumed here, never approved here.
  v_req:=clued_private.owner_grant_door_request_v1(v_anchor,'fleet.accept',array[v_resource]);
  return clued_private.fleet_accept_answer_v1(v_identity.user_id,v_anchor.id,v_resource);
end $$;

create function public.clued_fleet_accept_status_v1(p_resource text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_identity clued_private.release_identity_v1%rowtype; v_parts text[];
begin
  v_parts:=clued_private.fleet_accept_parts_v1(p_resource);
  if v_parts is null then raise exception 'fleet_accept_resource_invalid' using errcode='22023'; end if;
  select * into v_identity from clued_private.release_identity_v1;
  if not found then raise exception 'release_door_identity_missing' using errcode='55000'; end if;
  if v_parts[1]<>v_identity.repository then
    raise exception 'fleet_accept_resource_invalid' using errcode='22023'; end if;
  return clued_private.fleet_accept_answer_v1(v_identity.user_id,v_identity.anchor_binding_id,p_resource);
end $$;

revoke all on function clued_private.fleet_accept_parts_v1(text),
  clued_private.fleet_accept_apply_v1(uuid,uuid),
  clued_private.fleet_accept_answer_v1(uuid,uuid,text),
  clued_private.fleet_accept_door_v1(jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
revoke all on function public.clued_fleet_accept_status_v1(text) from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_fleet_accept_status_v1(text) to anon;

notify pgrst,'reload schema';
