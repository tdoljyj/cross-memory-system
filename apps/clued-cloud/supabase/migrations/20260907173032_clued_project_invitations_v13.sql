-- Candidate v1.3: verified human invitations to exact development project/environment.
-- This successor does not depend on absent P5 tables, impersonate a resource
-- owner, change frozen registries, or create personal Canonical memory on signup.
create table clued_private.project_memberships_v13 (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.clued_projects(id),
 subject_id uuid not null references auth.users(id), resource_owner_id uuid not null references auth.users(id),
 environment text not null check(environment in ('test','preview','production')),
 role text not null check(role in ('reader','editor')),
 actions text[] not null check(cardinality(actions)>0 and actions <@ array['read','write','close','feedback_submit']::text[]),
 grantor_id uuid not null references auth.users(id), expires_at timestamptz not null,
 revoked_at timestamptz, version bigint not null default 1, created_at timestamptz not null default clock_timestamp(),
 check(role='editor' or actions <@ array['read']::text[])
);
create unique index project_membership_active_v13 on clued_private.project_memberships_v13(project_id,subject_id,environment) where revoked_at is null;
create table clued_private.project_invitations_v13 (
 id uuid primary key default gen_random_uuid(), token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 project_id uuid not null references public.clued_projects(id), resource_owner_id uuid not null references auth.users(id),
 environment text not null check(environment in ('test','preview','production')), target_email text not null,
 target_subject_id uuid references auth.users(id), role text not null check(role in ('reader','editor')),
 actions text[] not null, grantor_id uuid not null references auth.users(id), expires_at timestamptz not null,
 status text not null default 'pending' check(status in ('pending','accepted','revoked')),
 version bigint not null default 1, accepted_by uuid references auth.users(id),
 membership_id uuid references clued_private.project_memberships_v13(id), created_at timestamptz not null default clock_timestamp(),
 check(cardinality(actions)>0 and actions <@ array['read','write','close','feedback_submit']::text[]),
 check(role='editor' or actions <@ array['read']::text[])
);
create table clued_private.project_access_requests_v13 (
 subject_id uuid not null, operation text not null, idempotency_key text not null,
 request_hash text not null, result jsonb, primary key(subject_id,operation,idempotency_key)
);
create table clued_private.project_access_audit_v13 (
 id uuid primary key default gen_random_uuid(), actor_user_id uuid not null, project_id uuid,
 invitation_id uuid, membership_id uuid, operation text not null, version bigint,
 before_actions text[], after_actions text[], recorded_at timestamptz not null default clock_timestamp()
);
revoke all on clued_private.project_memberships_v13,clued_private.project_invitations_v13,
 clued_private.project_access_requests_v13,clued_private.project_access_audit_v13 from public,anon,authenticated,service_role;

create function clued_private.project_verified_email_v13(p_actor uuid)
returns text language plpgsql security definer set search_path='' as $$
declare u jsonb; email text;
begin
 perform clued_private.authorization_account_v12(p_actor);
 select to_jsonb(x) into u from auth.users x where x.id=p_actor for share;
 email:=lower(btrim(u->>'email'));
 if coalesce(email,'')='' or u->>'email_confirmed_at' is null then
  raise exception 'verified_email_required' using errcode='42501';
 end if;
 return email;
end $$;
create function clued_private.project_owner_v13(p_actor uuid,p_project uuid,p_environment text default null)
returns public.clued_projects language plpgsql security definer set search_path='' as $$
declare p public.clued_projects;
begin
 select * into p from public.clued_projects where id=p_project and user_id=p_actor for share;
 if not found then raise exception 'project_owner_required' using errcode='42501'; end if;
 if p_environment is not null and not exists(select 1 from clued_private.development_spaces_v14 c
   where c.project_id=p.id and c.owner_id=p_actor and c.environment=p_environment) then
  raise exception 'owned_project_environment_required' using errcode='42501';
 end if;
 return p;
end $$;
create function clued_private.project_actions_v13(p_role text,p_actions jsonb)
returns text[] language plpgsql security definer set search_path='' as $$
declare a text[];
begin
 if p_role not in ('reader','editor') or jsonb_typeof(p_actions) is distinct from 'array'
  or jsonb_array_length(p_actions) not between 1 and 4 then raise exception 'invalid_project_role_actions' using errcode='22023'; end if;
 select array_agg(distinct value order by value) into a from jsonb_array_elements_text(p_actions);
 if not(a <@ case p_role when 'reader' then array['read'] else array['read','write','close','feedback_submit'] end)
   or cardinality(a)<>jsonb_array_length(p_actions) then raise exception 'project_action_not_allowed' using errcode='42501'; end if;
 return a;
end $$;
create function clued_private.project_invitation_target_v13(p_actor uuid,p_email text,p_invitation clued_private.project_invitations_v13)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_invitation.id is null or p_invitation.target_email is distinct from p_email
  or (p_invitation.target_subject_id is not null and p_invitation.target_subject_id<>p_actor)
  or p_invitation.status<>'pending' or p_invitation.expires_at<=clock_timestamp() then
  raise exception 'invitation_not_available' using errcode='42501';
 end if;
 perform clued_private.project_owner_v13(p_invitation.resource_owner_id,p_invitation.project_id,p_invitation.environment);
 perform clued_private.authorization_account_v12(p_invitation.resource_owner_id);
end $$;

create function public.clued_project_access_v13(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=clued_private.authorization_owner_v12(); email text;
 op text:=p_input->>'op'; ikey text:=p_input->>'idempotency_key'; rhash text; prior clued_private.project_access_requests_v13;
 inv clued_private.project_invitations_v13; member clued_private.project_memberships_v13; project_row public.clued_projects;
 v_actions text[]; old_actions text[]; token text; token_hash text; v_result jsonb; target text; target_subject uuid;
begin
 email:=clued_private.project_verified_email_v13(actor);
 if op='list' then
  return jsonb_build_object(
   'owned_projects',coalesce((select jsonb_agg(jsonb_build_object('project_id',p.id,'name',p.name,
     'environments',coalesce((select jsonb_agg(distinct c.environment) from clued_private.development_spaces_v14 c where c.project_id=p.id and c.owner_id=actor),'[]')) order by p.name)
      from public.clued_projects p where p.user_id=actor),'[]'),
   'memberships',coalesce((select jsonb_agg(jsonb_build_object('membership_id',m.id,'project_id',m.project_id,'project_name',p.name,
     'subject_id',m.subject_id,'environment',m.environment,'role',m.role,'actions',m.actions,'expires_at',m.expires_at,
     'revoked_at',m.revoked_at,'version',m.version) order by m.created_at desc)
      from clued_private.project_memberships_v13 m join public.clued_projects p on p.id=m.project_id
      where p.user_id=actor or m.subject_id=actor),'[]'),
   'invitations',coalesce((select jsonb_agg(jsonb_build_object('invitation_id',i.id,'project_id',i.project_id,'project_name',p.name,
     'environment',i.environment,'role',i.role,'actions',i.actions,'target_email',i.target_email,
     'status',case when i.status='pending' and i.expires_at<=clock_timestamp() then 'expired' else i.status end,
     'expires_at',i.expires_at,'version',i.version) order by i.created_at desc)
      from clued_private.project_invitations_v13 i join public.clued_projects p on p.id=i.project_id where p.user_id=actor),'[]'));
 end if;
 if op='invite_inspect' then
  select * into inv from clued_private.project_invitations_v13 where project_invitations_v13.token_hash=encode(extensions.digest(coalesce(p_input->>'invite_token',''),'sha256'),'hex') for share;
  perform clued_private.project_invitation_target_v13(actor,email,inv);
  select * into project_row from public.clued_projects where id=inv.project_id;
  return jsonb_build_object('invitation_id',inv.id,'version',inv.version,'project_id',inv.project_id,'project_name',project_row.name,
    'environment',inv.environment,'role',inv.role,'actions',inv.actions,'expires_at',inv.expires_at);
 end if;
 if op is null or op not in ('invite_create','invite_accept','invite_revoke','member_reduce','member_revoke')
   or coalesce(length(ikey),0) not between 8 and 160 then raise exception 'invalid_project_access_operation_or_key' using errcode='22023'; end if;
 rhash:=clued_private.m1_sha256(p_input-'idempotency_key');
 perform pg_advisory_xact_lock(hashtextextended('project-access-v13:'||actor||':'||op||':'||ikey,0));
 select * into prior from clued_private.project_access_requests_v13 where subject_id=actor and operation=op and idempotency_key=ikey for update;
 if found then
  if prior.request_hash<>rhash then raise exception 'project_access_idempotency_conflict' using errcode='40001'; end if;
  return prior.result||jsonb_build_object('replayed',true);
 end if;
 insert into clued_private.project_access_requests_v13 values(actor,op,ikey,rhash,null);
 if op='invite_create' then
  project_row:=clued_private.project_owner_v13(actor,(p_input->>'project_id')::uuid,p_input->>'environment');
  if p_input->>'environment' is null then raise exception 'exact_environment_required' using errcode='22023'; end if;
  v_actions:=clued_private.project_actions_v13(p_input->>'role',p_input->'actions');
  target:=lower(btrim(coalesce(p_input->>'target_email','')));
  if length(target) not between 3 and 320 or strpos(target,'@')<2 or target=email then raise exception 'invalid_invitation_target' using errcode='22023'; end if;
  if p_input->>'expires_at' is null or (p_input->>'expires_at')::timestamptz<=clock_timestamp()
   or (p_input->>'expires_at')::timestamptz>clock_timestamp()+interval '30 days' then raise exception 'invalid_invitation_expiry' using errcode='22023'; end if;
  select id into target_subject from auth.users u where lower(btrim(u.email))=target and to_jsonb(u)->>'email_confirmed_at' is not null;
  token:='clued_inv_'||encode(extensions.gen_random_bytes(32),'hex');
  token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  insert into clued_private.project_invitations_v13(token_hash,project_id,resource_owner_id,environment,target_email,target_subject_id,role,actions,grantor_id,expires_at)
   values(token_hash,project_row.id,actor,p_input->>'environment',target,target_subject,p_input->>'role',v_actions,actor,(p_input->>'expires_at')::timestamptz) returning * into inv;
  v_result:=jsonb_build_object('invitation_id',inv.id,'version',inv.version,'expires_at',inv.expires_at,'invite_token',token,'replayed',false,'token_unavailable',false);
 elsif op='invite_accept' then
  select * into inv from clued_private.project_invitations_v13 where project_invitations_v13.token_hash=encode(extensions.digest(coalesce(p_input->>'invite_token',''),'sha256'),'hex') for update;
  perform clued_private.project_invitation_target_v13(actor,email,inv);
  if inv.version is distinct from (p_input->>'base_version')::bigint then raise exception 'invitation_version_conflict' using errcode='40001'; end if;
  -- A new invitation always creates a new qualification ID; old Binding entries
  -- can never inherit renewed membership after revocation or expiry.
  if exists(select 1 from clued_private.project_memberships_v13 where subject_id=actor and project_id=inv.project_id and environment=inv.environment and revoked_at is null) then
   raise exception 'existing_membership_requires_owner_revocation' using errcode='40001';
  end if;
  insert into clued_private.project_memberships_v13(project_id,subject_id,resource_owner_id,environment,role,actions,grantor_id,expires_at)
   values(inv.project_id,actor,inv.resource_owner_id,inv.environment,inv.role,inv.actions,inv.grantor_id,inv.expires_at) returning * into member;
  update clued_private.project_invitations_v13 set status='accepted',accepted_by=actor,membership_id=member.id,version=version+1 where id=inv.id returning * into inv;
  v_result:=jsonb_build_object('membership_id',member.id,'version',member.version,'project_id',member.project_id,
   'environment',member.environment,'role',member.role,'actions',member.actions,'expires_at',member.expires_at,'replayed',false);
 elsif op='invite_revoke' then
  select * into inv from clued_private.project_invitations_v13 where id=(p_input->>'invitation_id')::uuid for update;
  if not found then raise exception 'invitation_not_available' using errcode='42501'; end if;
  perform clued_private.project_owner_v13(actor,inv.project_id);
  if inv.version is distinct from (p_input->>'base_version')::bigint or inv.status<>'pending' then raise exception 'invitation_version_conflict' using errcode='40001'; end if;
  update clued_private.project_invitations_v13 set status='revoked',version=version+1 where id=inv.id returning * into inv;
  v_result:=jsonb_build_object('invitation_id',inv.id,'version',inv.version,'status',inv.status,'replayed',false);
 else
  select * into member from clued_private.project_memberships_v13 where id=(p_input->>'membership_id')::uuid for update;
  if not found then raise exception 'membership_not_available' using errcode='42501'; end if;
  perform clued_private.project_owner_v13(actor,member.project_id);
  if member.version is distinct from (p_input->>'base_version')::bigint or member.revoked_at is not null then raise exception 'membership_version_conflict' using errcode='40001'; end if;
  old_actions:=member.actions;
  if op='member_reduce' then
   v_actions:=clued_private.project_actions_v13(member.role,p_input->'actions');
   if not(v_actions <@ member.actions) then raise exception 'membership_expansion_requires_new_invitation' using errcode='42501'; end if;
   update clued_private.project_memberships_v13 set actions=v_actions,version=version+1 where id=member.id returning * into member;
  else
   update clued_private.project_memberships_v13 set revoked_at=clock_timestamp(),version=version+1 where id=member.id returning * into member;
  end if;
  v_result:=jsonb_build_object('membership_id',member.id,'version',member.version,'project_id',member.project_id,'environment',member.environment,
   'role',member.role,'actions',member.actions,'expires_at',member.expires_at,'revoked_at',member.revoked_at,'replayed',false);
 end if;
 insert into clued_private.project_access_audit_v13(actor_user_id,project_id,invitation_id,membership_id,operation,version,before_actions,after_actions)
  values(actor,coalesce(inv.project_id,member.project_id),inv.id,coalesce(member.id,inv.membership_id),op,
   case when member.id is not null then member.version else inv.version end,old_actions,coalesce(member.actions,inv.actions));
 update clued_private.project_access_requests_v13 set result=(v_result-'invite_token')||
   case when op='invite_create' then jsonb_build_object('token_unavailable',true) else '{}'::jsonb end
  where subject_id=actor and operation=op and idempotency_key=ikey;
 return v_result;
end $$;
revoke all on function public.clued_project_access_v13(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_project_access_v13(jsonb) to authenticated;
do $$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_private' and p.proname like 'project_%_v13' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
end $$;

-- A delegated entry remembers the qualification that was explicitly consented.
-- Revoking it and issuing a new membership can never revive an old connection.
alter table clued_private.authorization_entries_v12 add column qualification_id uuid references clued_private.project_memberships_v13(id);

-- Existing IDs/views are unchanged; the successor includes an explicit actor
-- for new cross-account operations without guessing historical actors.
create view clued_private.development_events_with_actor_v14 with (security_invoker=true) as
 select e.*,o.actor_user_id from clued_private.development_events_v14 e join clued_private.development_operations_v14 o on o.id=e.operation_id;
create view clued_private.development_receipts_with_actor_v14 with (security_invoker=true) as
 select r.*,o.actor_user_id from clued_private.development_receipts_v14 r join clued_private.development_operations_v14 o on o.id=r.operation_id;
revoke all on clued_private.development_events_with_actor_v14,clued_private.development_receipts_with_actor_v14 from public,anon,authenticated,service_role;

create function clued_private.project_context_membership_v13(p_actor uuid,p_context uuid,p_environment text,p_membership uuid default null)
returns clued_private.project_memberships_v13 language plpgsql security definer set search_path='' as $$
declare m clued_private.project_memberships_v13; c clued_private.development_spaces_v14; p public.clued_projects;
begin
 -- Lock before reading ownership, so a queued call cannot validate an old owner.
 select * into c from clued_private.development_spaces_v14 where id=p_context for update;
 if not found or c.environment<>p_environment then raise exception 'project_qualification_required' using errcode='42501'; end if;
 select * into m from clued_private.project_memberships_v13 x
  where x.subject_id=p_actor and x.project_id=c.project_id and x.environment=c.environment
    and (p_membership is null or x.id=p_membership) and x.revoked_at is null for share;
 if not found or m.expires_at<=clock_timestamp() then raise exception 'project_qualification_required' using errcode='42501'; end if;
 select * into p from public.clued_projects where id=c.project_id for share;
 if not found or p.user_id<>m.resource_owner_id or c.owner_id<>m.resource_owner_id then
  raise exception 'project_qualification_required' using errcode='42501'; end if;
 return m;
end $$;

alter function clued_private.authorization_eligible_v12(uuid,text[]) rename to authorization_owner_eligible_v12;
create function clued_private.authorization_eligible_v12(p_owner uuid,p_scopes text[])
returns jsonb language sql security definer set search_path='' as $$
 select clued_private.authorization_owner_eligible_v12(p_owner,p_scopes)||coalesce((
  select jsonb_agg(jsonb_build_object('resource_kind','context','resource_id',c.id::text,'environment',c.environment,'name',p.name||' / '||c.name,
   'qualification_id',m.id,'actions',to_jsonb(array(select a from unnest(m.actions) a
      where case when a='read' then 'context:read' else 'context:write' end=any(p_scopes)))) order by c.id)
  from clued_private.project_memberships_v13 m
  join public.clued_projects p on p.id=m.project_id and p.user_id=m.resource_owner_id
  join clued_private.development_spaces_v14 c on c.project_id=m.project_id and c.owner_id=m.resource_owner_id and c.environment=m.environment
  where m.subject_id=p_owner and c.owner_id<>p_owner and m.revoked_at is null and m.expires_at>clock_timestamp()
    and exists(select 1 from unnest(m.actions) a where case when a='read' then 'context:read' else 'context:write' end=any(p_scopes))
 ),'[]'::jsonb)
$$;
alter function clued_private.authorization_resource_v12(uuid,text,text,text) rename to authorization_owner_resource_v12;
create function clued_private.authorization_resource_v12(p_owner uuid,p_kind text,p_id text,p_environment text)
returns void language plpgsql security definer set search_path='' as $$
declare c clued_private.development_spaces_v14;
begin
 if p_kind='context' then
  select * into c from clued_private.development_spaces_v14 where id::text=p_id;
  if found and c.owner_id<>p_owner then
   perform clued_private.project_context_membership_v13(p_owner,c.id,p_environment);
   perform 1 from clued_private.development_spaces_v14 where id=c.id and environment=p_environment for update;
   return;
  end if;
 end if;
 perform clued_private.authorization_owner_resource_v12(p_owner,p_kind,p_id,p_environment);
end $$;

alter function clued_private.authorization_assert_entry_v12(uuid,text,text,text,text) rename to authorization_owner_assert_entry_v12;
create function clued_private.authorization_assert_entry_v12(p_binding uuid,p_kind text,p_id text,p_environment text,p_action text)
returns void language plpgsql security definer set search_path='' as $$
declare a clued_private.authorizations_v12; e clued_private.authorization_entries_v12; m clued_private.project_memberships_v13;
begin
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for share;
 if not found then return; end if;
 perform clued_private.authorization_account_v12(a.owner_id);
 if a.revoked_at is not null or a.expires_at<=clock_timestamp() then raise exception 'authorization_revoked_or_expired' using errcode='42501'; end if;
 select * into e from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind=p_kind and resource_id=p_id and environment=p_environment;
 if not found or not(p_action=any(e.actions)) then raise exception 'resource_action_not_authorized' using errcode='42501'; end if;
 if e.qualification_id is not null then
  if p_kind<>'context' then raise exception 'qualification_resource_mismatch' using errcode='42501'; end if;
  m:=clued_private.project_context_membership_v13(a.owner_id,p_id::uuid,p_environment,e.qualification_id);
  if not(p_action=any(m.actions)) then raise exception 'current_project_action_required' using errcode='42501'; end if;
  perform 1 from clued_private.development_spaces_v14 where id=p_id::uuid and environment=p_environment for update;
 else
  -- A previously owned entry cannot silently acquire a new member role.
  perform clued_private.authorization_owner_resource_v12(a.owner_id,p_kind,p_id,p_environment);
 end if;
end $$;

-- Binding association comes from the trusted request snapshot, not submitted
-- qualification IDs. Reducing entries preserves their original qualification.
create or replace function clued_private.authorization_replace_entries_v12(p_binding uuid,p_selected jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare a clued_private.authorizations_v12; req clued_private.authorization_requests_v12;
 item jsonb; snapshot jsonb; m clued_private.project_memberships_v13; old_q uuid; q uuid;
begin
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding;
 select * into req from clued_private.authorization_requests_v12 where id=a.request_id;
 for item in select value from jsonb_array_elements(p_selected) loop
  select qualification_id into old_q from clued_private.authorization_entries_v12
   where binding_id=p_binding and resource_kind=item->>'resource_kind' and resource_id=item->>'resource_id' and environment=item->>'environment';
  if found then q:=old_q;
  else
   select x into snapshot from jsonb_array_elements(req.eligible) x
    where x->>'resource_kind'=item->>'resource_kind' and x->>'resource_id'=item->>'resource_id' and x->>'environment'=item->>'environment';
   q:=nullif(snapshot->>'qualification_id','')::uuid;
   if q is not null then
    m:=clued_private.project_context_membership_v13(a.owner_id,(item->>'resource_id')::uuid,item->>'environment',q);
    if not(array(select jsonb_array_elements_text(item->'actions')) <@ m.actions) then raise exception 'current_project_action_required' using errcode='42501'; end if;
   end if;
  end if;
  insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions,qualification_id)
   values(p_binding,item->>'resource_kind',item->>'resource_id',item->>'environment',array(select distinct jsonb_array_elements_text(item->'actions')),q)
  on conflict(binding_id,resource_kind,resource_id,environment) do update set actions=excluded.actions;
 end loop;
 delete from clued_private.authorization_entries_v12 e where e.binding_id=p_binding and not exists(
  select 1 from jsonb_array_elements(p_selected) x where x->>'resource_kind'=e.resource_kind and x->>'resource_id'=e.resource_id and x->>'environment'=e.environment);
end $$;

create function clued_private.authorization_context_grant_v13(p_actor uuid,p_binding uuid,p_request uuid,p_item jsonb,p_expires_at timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare c clued_private.development_spaces_v14; e clued_private.authorization_entries_v12; m clued_private.project_memberships_v13;
 g clued_private.development_grants_v14; op_row clued_private.development_operations_v14; granted text[]; payload jsonb; v_result jsonb; action text;
begin
 select * into c from clued_private.development_spaces_v14 where id=(p_item->>'resource_id')::uuid for update;
 if not found then raise exception 'context_not_available' using errcode='42501'; end if;
 select * into e from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind='context' and resource_id=c.id::text and environment=c.environment;
 if e.qualification_id is null then
  if c.owner_id<>p_actor then raise exception 'owner_qualification_required' using errcode='42501'; end if;
  v_result:=public.clued_development_owner_v14(jsonb_build_object('op','grant_upsert','context_id',c.id,'binding_id',p_binding,
   'actions',(select jsonb_agg(distinct case v when 'close' then 'write' else v end) from unnest(e.actions) v),
   'history_policy','EXISTING_AND_FUTURE','version_policy','LATEST','allowed_fields',jsonb_build_array('*'),
   'expires_at',p_expires_at,'idempotency_key',p_request::text||':'||c.id::text||':grant'));

  return;
 end if;
 m:=clued_private.project_context_membership_v13(p_actor,c.id,c.environment,e.qualification_id);
 foreach action in array e.actions loop
  perform clued_private.authorization_assert_entry_v12(p_binding,'context',c.id::text,c.environment,action);
 end loop;
 select array_agg(distinct case x when 'close' then 'write' else x end) into granted from unnest(e.actions) x;
 insert into clued_private.development_grants_v14(context_id,binding_id,grantor,actions,history_policy,version_policy,freeze_cursor,allowed_fields,expires_at)
  values(c.id,p_binding,m.grantor_id,granted,'EXISTING_AND_FUTURE','LATEST',c.cursor,array['*'],least(p_expires_at,m.expires_at)) returning * into g;
 payload:=jsonb_build_object('context_id',c.id,'binding_id',p_binding,'membership_id',m.id,'actions',e.actions);
 insert into clued_private.development_operations_v14(owner_id,actor_user_id,binding_ref,context_id,op,idempotency_key,request_hash,canonical_version,result)
  values(c.owner_id,p_actor,p_binding::text,c.id,'grant_upsert',p_request::text||':'||c.id::text||':grant',
   clued_private.development_hash_v14(payload),nextval('clued_private.canonical_version_seq'),'{}') returning * into op_row;
 v_result:=jsonb_build_object('status','committed','operation_id',op_row.id,'receipt_id',op_row.receipt_id,'event_id',op_row.event_id,
   'canonical_version',op_row.canonical_version,'result',to_jsonb(g),'replayed',false,
   'actor_user_id',p_actor,'resource_owner_id',c.owner_id);
 update clued_private.development_operations_v14 set result=v_result where id=op_row.id;
end $$;
-- Replace only the consent-to-grant adapter, keeping validation/CAS and exact
-- idempotency contract already accepted for v1.2.
do $$ declare body text; first_pos integer; last_pos integer; begin
 body:=pg_get_functiondef('public.clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz)'::regprocedure);
 body:=replace(body,'and space_row.owner_id=u','');
 first_pos:=strpos(body,' -- Existing owner management establishes');
 last_pos:=strpos(body,' update clued_private.authorization_requests_v12 set status=');
 if first_pos=0 or last_pos<=first_pos then raise exception 'authorization_adapter_source_mismatch'; end if;
 body:=substr(body,1,first_pos-1)||$adapter$
 for item in select value from jsonb_array_elements(p_selected) where value->>'resource_kind'='context' loop
  perform clued_private.authorization_context_grant_v13(u,b,r.id,item,p_expires_at);
 end loop;
$adapter$||substr(body,last_pos);
 execute body;
end $$;

-- A distinct successor kernel: p_actor is the verified human behind p_binding;
-- resource ownership is read from the locked context, never substituted into
-- the caller's identity. Existing owner-only operations retain the v1.2 path.
create function clued_private.development_execute_authorized_v14(p_actor uuid,p_binding uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; e clued_private.authorization_entries_v12;
 c clued_private.development_spaces_v14; g clued_private.development_grants_v14; r clued_private.development_records_v14;
 f clued_private.development_feedback_v14; operation_row clued_private.development_operations_v14;
 op text:=p_input->>'op'; action text; required_scope text; ikey text:=p_input->>'idempotency_key';
 rhash text; seq bigint; rows jsonb; v_result jsonb; lim integer:=least(greatest(coalesce((p_input->>'limit')::integer,100),1),200);
begin
 perform clued_private.authorization_account_v12(p_actor);
 select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_actor for share;
 if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() then raise exception 'binding_not_authorized' using errcode='42501'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=p_actor for share;
 if not found or a.revoked_at is not null or a.expires_at<=clock_timestamp() then raise exception 'authorization_revoked_or_expired' using errcode='42501'; end if;
 select * into c from clued_private.development_spaces_v14 where id=(p_input->>'context_id')::uuid;
 if not found then raise exception 'context_access_denied' using errcode='42501'; end if;
 if p_input ? 'environment' and p_input->>'environment' is distinct from c.environment then raise exception 'context_environment_denied' using errcode='42501'; end if;
 action:=case op when 'record_list' then 'read' when 'record_put' then 'write' when 'record_revoke' then 'close'
  when 'feedback_submit' then 'feedback_submit' when 'feedback_list' then 'feedback_submit' when 'feedback_withdraw' then 'feedback_submit' else null end;
 if action is null then raise exception 'member_operation_not_authorized' using errcode='42501'; end if;
 required_scope:=case when op='record_list' then 'context:read' else 'context:write' end;
 if not(required_scope=any(b.scopes)) or not(('project:'||c.project_id)=any(b.context_keys)) then raise exception 'binding_not_authorized' using errcode='42501'; end if;
 select * into e from clued_private.authorization_entries_v12 where binding_id=b.id and resource_kind='context' and resource_id=c.id::text and environment=c.environment;
 if not found then raise exception 'explicit_development_authorization_required' using errcode='42501'; end if;
 perform clued_private.authorization_assert_entry_v12(b.id,'context',c.id::text,c.environment,action);
 -- The authorization helper holds the current membership/project/context locks.
 select * into c from clued_private.development_spaces_v14 where id=c.id for update;
 select * into g from clued_private.development_grants_v14 where context_id=c.id and binding_id=b.id
  and (case action when 'close' then 'write' else action end)=any(actions) and revoked_at is null and expires_at>clock_timestamp() for share;
 if not found then raise exception 'context_access_denied' using errcode='42501'; end if;
 if op='record_list' then
  if p_input->>'mode' is distinct from 'development_history' then raise exception 'explicit_development_history_mode_required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(x.envelope order by x.created_cursor,x.id),'[]') into rows from (
   select z.* from (
    select y.id,y.created_cursor,clued_private.development_visible_record_v14(y.id,g) envelope
    from clued_private.development_records_v14 y where y.context_id=c.id and y.created_cursor>coalesce((p_input->>'after_cursor')::bigint,0)
   ) z where z.envelope is not null order by z.created_cursor,z.id limit lim) x;
  return jsonb_build_object('status','ok','records',rows,'next_cursor',case when jsonb_array_length(rows)=lim then rows->(lim-1)->'created_cursor' else null end,'cache_policy','no-store');
 elsif op='feedback_list' then
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'version',x.version,'body',x.body,'selected_evidence',x.selected_evidence,
   'state',x.state,'response',x.response,'withdrawn_at',x.withdrawn_at) order by x.created_at),'[]') into rows
   from clued_private.development_feedback_v14 x where x.context_id=c.id and x.submitter_binding_id=b.id;
  return jsonb_build_object('status','ok','feedback',rows,'cache_policy','no-store');
 end if;
 if coalesce(length(ikey),0) not between 8 and 160 then raise exception 'idempotency_key_required' using errcode='22023'; end if;
 rhash:=clued_private.development_hash_v14(p_input);
 perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text||b.id::text||op||ikey,0));
 select * into operation_row from clued_private.development_operations_v14 x
  where x.owner_id=c.owner_id and x.binding_ref=b.id::text and x.op=p_input->>'op' and x.idempotency_key=ikey;
 if found then
  if operation_row.request_hash<>rhash then raise exception 'idempotency_request_mismatch' using errcode='22023'; end if;
  return operation_row.result||jsonb_build_object('replayed',true);
 end if;
 if op='record_put' then
  if jsonb_typeof(p_input->'body') is distinct from 'object' or coalesce(p_input->>'record_type','') not in ('state','task','decision','note','observation','annotation') then raise exception 'invalid_context_record' using errcode='22023'; end if;
  if p_input->>'record_type'='annotation' then
   perform clued_private.authorization_assert_entry_v12(b.id,'context',c.id::text,c.environment,'read');
   if p_input->'body'->'annotation_of'->>'context_id' is distinct from c.id::text
    or clued_private.development_reference_status_v14(p_input->'body'->'annotation_of',b.id)<>'current' then
    raise exception 'authorized_exact_annotation_source_required' using errcode='42501'; end if;
  end if;
  update clued_private.development_spaces_v14 set cursor=cursor+1 where id=c.id returning cursor into seq;
  if p_input ? 'record_id' then
   select * into r from clued_private.development_records_v14 where id=(p_input->>'record_id')::uuid and context_id=c.id;
   if not found or r.version is distinct from (p_input->>'base_version')::bigint or r.lifecycle_status<>'ACTIVE' or r.record_type<>p_input->>'record_type' then raise exception 'record_version_conflict' using errcode='40001'; end if;
   update clued_private.development_records_v14 set version=version+1,body=p_input->'body',content_hash=clued_private.development_hash_v14(p_input->'body'),
    revision_cursor=seq,recorded_at=clock_timestamp(),actor_binding_id=b.id,observed_at=(p_input->>'observed_at')::timestamptz,
    valid_until=(p_input->>'valid_until')::timestamptz where id=r.id returning * into r;
  else
   insert into clued_private.development_records_v14(context_id,version,record_type,body,content_hash,observed_at,created_cursor,revision_cursor,actor_binding_id,valid_until)
    values(c.id,1,p_input->>'record_type',p_input->'body',clued_private.development_hash_v14(p_input->'body'),(p_input->>'observed_at')::timestamptz,
     seq,seq,b.id,(p_input->>'valid_until')::timestamptz) returning * into r;
  end if;
  insert into clued_private.development_record_versions_v14 values(r.id,r.version,c.id,r.revision_cursor,to_jsonb(r));
  v_result:=to_jsonb(r)-'body';
 elsif op='record_revoke' then
  if length(coalesce(p_input->>'reason',''))<1 then raise exception 'revocation_reason_required' using errcode='22023'; end if;
  update clued_private.development_spaces_v14 set cursor=cursor+1 where id=c.id returning cursor into seq;
  update clued_private.development_records_v14 set lifecycle_status='REVOKED',reason=p_input->>'reason',version=version+1,revision_cursor=seq,recorded_at=clock_timestamp(),actor_binding_id=b.id
   where id=(p_input->>'record_id')::uuid and context_id=c.id and version=(p_input->>'base_version')::bigint returning * into r;
  if not found then raise exception 'record_version_conflict' using errcode='40001'; end if;
  insert into clued_private.development_record_versions_v14 values(r.id,r.version,c.id,r.revision_cursor,to_jsonb(r));
  v_result:=jsonb_build_object('id',r.id,'context_id',r.context_id,'version',r.version,'lifecycle_status',r.lifecycle_status,'revision_cursor',r.revision_cursor,'actor_binding_id',r.actor_binding_id);
 elsif op='feedback_submit' then
  if jsonb_typeof(p_input->'body') is distinct from 'object' or jsonb_typeof(coalesce(p_input->'selected_evidence','[]')) is distinct from 'array' then raise exception 'invalid_feedback' using errcode='22023'; end if;
  insert into clued_private.development_feedback_v14(context_id,submitter_binding_id,body,selected_evidence,source_ref)
   values(c.id,b.id,p_input->'body',coalesce(p_input->'selected_evidence','[]'),p_input->'source_ref') returning * into f;
  v_result:=to_jsonb(f)-'body'-'selected_evidence'-'source_ref';
 elsif op='feedback_withdraw' then
  select * into f from clued_private.development_feedback_v14 where id=(p_input->>'feedback_id')::uuid and context_id=c.id;
  if not found or f.submitter_binding_id<>b.id then raise exception 'feedback_submitter_required' using errcode='42501'; end if;
  if f.version is distinct from (p_input->>'base_version')::bigint then raise exception 'feedback_version_conflict' using errcode='40001'; end if;
  update clued_private.development_feedback_v14 set state='withdrawn',body='{}',selected_evidence='[]',source_ref=null,response=null,
    withdrawn_at=clock_timestamp(),version=version+1 where id=f.id returning * into f;
  v_result:=to_jsonb(f)-'body'-'selected_evidence'-'source_ref'-'response';
 end if;
 insert into clued_private.development_operations_v14(owner_id,actor_user_id,binding_ref,context_id,op,idempotency_key,request_hash,canonical_version,result)
  values(c.owner_id,p_actor,b.id::text,c.id,op,ikey,rhash,nextval('clued_private.canonical_version_seq'),'{}') returning * into operation_row;
 v_result:=jsonb_build_object('status','committed','operation_id',operation_row.id,'receipt_id',operation_row.receipt_id,'event_id',operation_row.event_id,
  'canonical_version',operation_row.canonical_version,'result',v_result,'replayed',false,'actor_user_id',p_actor,'resource_owner_id',c.owner_id,
  'receipt',jsonb_build_object('id',operation_row.receipt_id,'operation_id',operation_row.id,'status','committed','request_hash',rhash,'canonical_version',operation_row.canonical_version,'actor_user_id',p_actor,'resource_owner_id',c.owner_id),
  'event',jsonb_build_object('id',operation_row.event_id,'operation_id',operation_row.id,'receipt_id',operation_row.receipt_id,'event_type',op,'context_id',c.id,'canonical_version',operation_row.canonical_version,'actor_user_id',p_actor,'resource_owner_id',c.owner_id));
 update clued_private.development_operations_v14 set result=v_result where id=operation_row.id;
 return v_result;
end $$;

alter function clued_private.development_execute_v14(uuid,uuid,boolean,jsonb) rename to development_execute_before_membership_v14;
create function clued_private.development_execute_v14(p_owner uuid,p_binding uuid,p_management boolean,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e clued_private.authorization_entries_v12; c clued_private.development_spaces_v14; result jsonb; contexts jsonb;
begin
 if p_management then return clued_private.development_execute_before_membership_v14(p_owner,p_binding,true,p_input); end if;
 if p_input->>'op'='context_list' then
  result:=clued_private.development_execute_before_membership_v14(p_owner,p_binding,false,p_input);
  contexts:=coalesce(result->'contexts','[]');
  if p_input->>'mode'='development_history' then
   for e in select * from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind='context'
     and qualification_id is not null and 'read'=any(actions) order by resource_id loop
    begin
     if not('read'=any(clued_private.authorization_effective_actions_v13(p_binding,'context',e.resource_id,e.environment))) then continue; end if;
     select * into c from clued_private.development_spaces_v14 where id::text=e.resource_id;
     if p_input ? 'environment' and p_input->>'environment' is distinct from c.environment then continue; end if;
     contexts:=contexts||jsonb_build_array(jsonb_build_object('id',c.id,'name',c.name,'project_id',c.project_id,'environment',c.environment,'access_source','project_membership'));
    exception when insufficient_privilege then null;
    end;
   end loop;
  end if;
  return jsonb_set(result,'{contexts}',contexts);
 end if;
 select * into e from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind='context' and resource_id=p_input->>'context_id';
 if e.qualification_id is not null then return clued_private.development_execute_authorized_v14(p_owner,p_binding,p_input); end if;
 return clued_private.development_execute_before_membership_v14(p_owner,p_binding,false,p_input);
end $$;

create function clued_private.authorization_effective_actions_v13(p_binding uuid,p_kind text,p_id text,p_environment text)
returns text[] language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; e clued_private.authorization_entries_v12; c clued_private.development_spaces_v14;
 a text; allowed text[]:='{}';
begin
 select * into b from public.clued_agent_bindings where id=p_binding for share;
 if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() then return allowed; end if;
 select * into e from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind=p_kind and resource_id=p_id and environment=p_environment;
 if not found then return allowed; end if;
 if p_kind='context' then
  select * into c from clued_private.development_spaces_v14 where id::text=p_id and environment=p_environment;
  if not found or not(('project:'||c.project_id)=any(b.context_keys) or '*'=any(b.context_keys)) then return allowed; end if;
 elsif not(p_id=any(b.context_keys) or '*'=any(b.context_keys)) then return allowed;
 end if;
 foreach a in array e.actions loop
  begin
   if (case a when 'read' then 'context:read' when 'audit' then 'audit:read' else 'context:write' end)=any(b.scopes) then
    perform clued_private.authorization_assert_entry_v12(p_binding,p_kind,p_id,p_environment,a);
    if p_kind='context' and not exists(select 1 from clued_private.development_grants_v14 g
      where g.context_id=c.id and g.binding_id=b.id and g.revoked_at is null and g.expires_at>clock_timestamp()
       and (case a when 'close' then 'write' else a end)=any(g.actions)) then continue; end if;
    allowed:=array_append(allowed,a);
   end if;
  exception when insufficient_privilege then null;
  end;
 end loop;
 return allowed;
end $$;

do $$ declare body text; first_pos integer; last_pos integer; begin
 body:=pg_get_functiondef('public.clued_authorization_manage_v12(jsonb)'::regprocedure);
 first_pos:=strpos(body,' if op=''list''');
 last_pos:=strpos(body,' if op not in');
 if first_pos=0 or last_pos<=first_pos then raise exception 'authorization_manage_source_mismatch'; end if;
 body:=substr(body,1,first_pos-1)||$list$
 if op='list' then return jsonb_build_object('bindings',coalesce((
  select jsonb_agg(jsonb_build_object('binding_id',x.binding_id,'client_id',x.client_id,'client_name',x.client_name,
   'version',x.version,'created_at',x.created_at,'last_used_at',b.last_used_at,'expires_at',x.expires_at,'revoked_at',coalesce(x.revoked_at,b.revoked_at),
   'active',x.revoked_at is null and b.revoked_at is null and x.expires_at>clock_timestamp(),
   'grants',coalesce((select jsonb_agg(jsonb_build_object('resource_kind',e.resource_kind,'resource_id',e.resource_id,
     'environment',e.environment,'actions',e.actions,'qualification_id',e.qualification_id,
     'effective_actions',clued_private.authorization_effective_actions_v13(x.binding_id,e.resource_kind,e.resource_id,e.environment)))
     from clued_private.authorization_entries_v12 e where e.binding_id=x.binding_id),'[]'))
   order by x.created_at desc)
  from clued_private.authorizations_v12 x join public.clued_agent_bindings b on b.id=x.binding_id where x.owner_id=u),'[]')); end if;
$list$||substr(body,last_pos);
 execute body;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_private' and p.prokind='f' and (p.proname like '%_v13' or p.proname like 'authorization_%_v12'
    or p.proname='development_execute_v14') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
end $$;

create function clued_private.development_reference_status_v14(p_ref jsonb,p_binding uuid)
returns text language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.development_spaces_v14; g clued_private.development_grants_v14; r clued_private.development_records_v14; v jsonb;
begin
 if jsonb_typeof(p_ref) is distinct from 'object' then return 'unavailable'; end if;
 select * into b from public.clued_agent_bindings where id=p_binding and revoked_at is null for share;
 if not found then return 'restricted'; end if;
 select * into c from clued_private.development_spaces_v14 where id=(p_ref->>'context_id')::uuid;
 if not found then return 'unavailable'; end if;
 if not('context:read'=any(b.scopes)) or not('*'=any(b.context_keys) or ('project:'||c.project_id)=any(b.context_keys)) then return 'restricted'; end if;
 perform clued_private.authorization_assert_entry_v12(b.id,'context',c.id::text,c.environment,'read');
 select * into g from clued_private.development_grants_v14 where context_id=c.id and binding_id=b.id
   and 'read'=any(actions) and revoked_at is null and expires_at>clock_timestamp() for share;
 if not found or not('*'=any(g.allowed_fields)) then return 'restricted'; end if;
 select * into r from clued_private.development_records_v14 where id=(p_ref->>'record_id')::uuid and context_id=c.id;
 if not found or r.lifecycle_status<>'ACTIVE' then return 'unavailable'; end if;
 if (g.history_policy='EXISTING_ONLY' and r.created_cursor>g.freeze_cursor)
  or (g.history_policy='SINCE_CURSOR' and r.created_cursor<=g.since_cursor)
  or (g.history_policy='EXPLICIT_SET' and not(r.id=any(g.explicit_record_ids))) then return 'restricted'; end if;
 if g.version_policy='FIXED_AT_GRANT' then
  select envelope into v from clued_private.development_record_versions_v14 where record_id=r.id and revision_cursor<=g.freeze_cursor order by version desc limit 1;
 else v:=to_jsonb(r); end if;
 if v is null then return 'restricted'; end if;
 if (v->>'version')::bigint is distinct from (p_ref->>'version')::bigint or v->>'content_hash' is distinct from p_ref->>'content_hash' then return 'changed'; end if;
 return 'current';
exception when insufficient_privilege then return 'restricted';
end $$;

revoke all on function clued_private.development_reference_status_v14(jsonb,uuid),
 clued_private.development_visible_record_v14(uuid,clued_private.development_grants_v14) from public,anon,authenticated,service_role;

-- A07 successor: context-only connections restore an authorized capability
-- projection. They do not mint a Canonical continuity session or read personal
-- checkpoints. The public tool signature stays unchanged; status is explicit.
alter function public.clued_mcp_restore(text,jsonb) rename to clued_mcp_restore_before_project_access_v13;
revoke all on function public.clued_mcp_restore_before_project_access_v13(text,jsonb) from public,anon,authenticated,service_role;
create function public.clued_mcp_restore(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; e clued_private.authorization_entries_v12;
 c clued_private.development_spaces_v14; project_name text; allowed text[]; contexts jsonb:='[]'; sources jsonb:='[]';
 requested text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or length(requested) not between 1 and 160 then
  raise exception 'invalid_binding_or_context' using errcode='28000'; end if;
 select * into b from public.clued_agent_bindings where token_hash=p_token_hash for share;
 if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp()
  or not('context:read'=any(b.scopes)) then raise exception 'binding_not_authorized' using errcode='42501'; end if;
 perform clued_private.authorization_account_v12(b.user_id);
 select * into a from clued_private.authorizations_v12 where binding_id=b.id for share;
 if not found then return public.clued_mcp_restore_before_project_access_v13(p_token_hash,p_input); end if;
 if a.owner_id<>b.user_id or a.revoked_at is not null or a.expires_at<=clock_timestamp() then
  raise exception 'authorization_revoked_or_expired' using errcode='42501'; end if;
 if exists(select 1 from clued_private.authorization_entries_v12 x where x.binding_id=b.id
   and x.resource_kind='scope' and x.resource_id=requested and x.environment='canonical' and 'read'=any(x.actions)) then
  return public.clued_mcp_restore_before_project_access_v13(p_token_hash,p_input);
 end if;
 -- Global here is a discovery request only; it never grants/reads Global memory.
 if requested<>'global' and requested !~ '^project:[0-9a-fA-F-]{36}$' then
  raise exception 'requested_context_not_authorized' using errcode='42501'; end if;
 for e in select * from clued_private.authorization_entries_v12 x where x.binding_id=b.id
   and x.resource_kind='context' and 'read'=any(x.actions) order by x.resource_id,x.environment loop
  allowed:=clued_private.authorization_effective_actions_v13(b.id,e.resource_kind,e.resource_id,e.environment);
  if not('read'=any(allowed)) then continue; end if;
  select * into c from clued_private.development_spaces_v14 where id::text=e.resource_id and environment=e.environment;
  if not found or (requested<>'global' and requested<>'project:'||c.project_id) then continue; end if;
  select name into project_name from public.clued_projects where id=c.project_id;
  contexts:=contexts||jsonb_build_array(jsonb_build_object('context_id',c.id,'name',c.name,
   'project_id',c.project_id,'project_name',project_name,'environment',c.environment,'actions',allowed,
   'mode','development_history'));
  sources:=sources||jsonb_build_array('context:'||c.id||':authorization_metadata');
 end loop;
 if jsonb_array_length(contexts)=0 then raise exception 'no_authorized_development_context' using errcode='42501'; end if;
 return jsonb_build_object('status','scoped_context_ready','session_resumed',false,'session_checkpoint_supported',false,
  'requested_context_key',requested,'authorized_contexts',contexts,'sources_read',sources,'cache_policy','no-store',
  'next_action',jsonb_build_object('tool','clued_context','op','record_list','mode','development_history',
   'instruction','Read state, task and decision records in the listed authorized contexts. Writes return their own atomic receipts; no Canonical session checkpoint is supported.'),
  'provenance',jsonb_build_object('canonical_store','clued-cloud/supabase','projection','authorized_context_capabilities_v13','binding_id',b.id));
end $$;
revoke all on function public.clued_mcp_restore(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_mcp_restore(text,jsonb) to anon,authenticated;

-- Offline control plane only. A platform administrator designation is not an
-- implicit project membership, OAuth grant, or personal-memory permission.
-- Registration cannot initialize it; ordinary API roles cannot CALL either
-- procedure. Operational evidence is supplied by the authenticated DB operator.
create table clued_private.platform_admin_v13 (
 singleton boolean primary key default true check(singleton),
 subject_id uuid not null references auth.users(id), version bigint not null check(version>0),
 initialized_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create table clued_private.platform_admin_audit_v13 (
 id uuid primary key default gen_random_uuid(), operation text not null check(operation in ('bootstrap','recover')),
 old_subject_id uuid, new_subject_id uuid not null, version bigint not null,
 operator_role text not null, session_role text not null, evidence_ref text not null, reason text not null,
 recorded_at timestamptz not null default clock_timestamp()
);
revoke all on clued_private.platform_admin_v13,clued_private.platform_admin_audit_v13 from public,anon,authenticated,service_role;
create procedure clued_private.platform_admin_bootstrap_v13(p_subject uuid,p_evidence_ref text,p_reason text)
language plpgsql security invoker set search_path='' as $$
begin
 if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
   where oid='clued_private.platform_admin_bootstrap_v13(uuid,text,text)'::regprocedure) then
  raise exception 'offline_database_operator_required' using errcode='42501'; end if;
 if length(btrim(coalesce(p_evidence_ref,''))) not between 8 and 512 or length(btrim(coalesce(p_reason,''))) not between 8 and 1024 then
  raise exception 'verified_recovery_evidence_required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('platform-admin-bootstrap-v13',0));
 if exists(select 1 from clued_private.platform_admin_v13) then raise exception 'platform_admin_already_initialized' using errcode='40001'; end if;
 perform clued_private.project_verified_email_v13(p_subject);
 insert into clued_private.platform_admin_v13(subject_id,version) values(p_subject,1);
 insert into clued_private.platform_admin_audit_v13(operation,new_subject_id,version,operator_role,session_role,evidence_ref,reason)
  values('bootstrap',p_subject,1,current_user,session_user,p_evidence_ref,p_reason);
end $$;
create procedure clued_private.platform_admin_recover_v13(p_subject uuid,p_base_version bigint,p_evidence_ref text,p_reason text)
language plpgsql security invoker set search_path='' as $$
declare old_admin clued_private.platform_admin_v13;
begin
 if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
   where oid='clued_private.platform_admin_recover_v13(uuid,bigint,text,text)'::regprocedure) then
  raise exception 'offline_database_operator_required' using errcode='42501'; end if;
 if length(btrim(coalesce(p_evidence_ref,''))) not between 8 and 512 or length(btrim(coalesce(p_reason,''))) not between 8 and 1024 then
  raise exception 'verified_recovery_evidence_required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('platform-admin-bootstrap-v13',0));
 select * into old_admin from clued_private.platform_admin_v13 where singleton for update;
 if not found or old_admin.version is distinct from p_base_version then raise exception 'platform_admin_version_conflict' using errcode='40001'; end if;
 if old_admin.subject_id=p_subject then raise exception 'platform_admin_target_unchanged' using errcode='22023'; end if;
 perform clued_private.project_verified_email_v13(p_subject);
 update clued_private.platform_admin_v13 set subject_id=p_subject,version=version+1,updated_at=clock_timestamp() where singleton;
 insert into clued_private.platform_admin_audit_v13(operation,old_subject_id,new_subject_id,version,operator_role,session_role,evidence_ref,reason)
  values('recover',old_admin.subject_id,p_subject,old_admin.version+1,current_user,session_user,p_evidence_ref,p_reason);
end $$;
revoke all on procedure clued_private.platform_admin_bootstrap_v13(uuid,text,text),
 clued_private.platform_admin_recover_v13(uuid,bigint,text,text) from public,anon,authenticated,service_role;


do $$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_private' and p.prokind='f' and p.proname like 'development_%_v14' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
end $$;
