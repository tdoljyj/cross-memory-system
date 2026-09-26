-- Resource Center Gate B: Canonical, source-bound registration and an exact,
-- read-only resolver. No profile, artifact or Binding is seeded by migration.
create table clued_private.resource_center_profiles_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  project_id uuid not null references public.clued_projects(id),
  profile_version text not null check (char_length(profile_version) between 1 and 120),
  policy_version text not null check (policy_version='clued.resource-center-mutation-policy/1'),
  managed_root text not null check (char_length(managed_root) between 2 and 1000),
  root_folder_id text not null check (root_folder_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  root_parent_id text not null check (root_parent_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  state text not null default 'active' check (state in ('active','revoked')),
  version bigint not null default 1 check (version>0),
  source_decision_id uuid not null references public.clued_memories(id),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index resource_center_profiles_v1_root_active_uidx
  on clued_private.resource_center_profiles_v1(user_id,managed_root) where state='active';

create table clued_private.resource_center_artifacts_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  profile_id uuid not null references clued_private.resource_center_profiles_v1(id),
  path text not null check (char_length(path) between 2 and 1000),
  provider_file_id text not null check (provider_file_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  provider_file_version text not null check (
    provider_file_version ~ '^[0-9]+$' and char_length(provider_file_version)<=40),
  target_kind text not null check (target_kind in ('file','directory')),
  governance_class text not null check (governance_class in ('ordinary','governance')),
  delete_authority boolean not null default false,
  state text not null default 'active' check (state in ('active','revoked')),
  version bigint not null default 1 check (version>0),
  source_decision_id uuid not null references public.clued_memories(id),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index resource_center_artifacts_v1_path_active_uidx
  on clued_private.resource_center_artifacts_v1(profile_id,path) where state='active';
create unique index resource_center_artifacts_v1_provider_active_uidx
  on clued_private.resource_center_artifacts_v1(profile_id,provider_file_id) where state='active';

create table clued_private.resource_center_bindings_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  profile_id uuid not null references clued_private.resource_center_profiles_v1(id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  capability text not null default 'authority:read' check (capability='authority:read'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  version bigint not null default 1 check (version>0),
  source_decision_id uuid not null references public.clued_memories(id),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  created_at timestamptz not null default now()
);

alter table clued_private.resource_center_profiles_v1 enable row level security;
alter table clued_private.resource_center_artifacts_v1 enable row level security;
alter table clued_private.resource_center_bindings_v1 enable row level security;
revoke all on clued_private.resource_center_profiles_v1,
  clued_private.resource_center_artifacts_v1,
  clued_private.resource_center_bindings_v1
  from public,anon,authenticated;

-- Administrative writes are service-role-only, require an Owner-authored
-- Canonical Decision in the exact Project, and create M1 Event+Receipt in the
-- same transaction. They are never exposed as an Agent mutation tool.
create function public.clued_resource_center_admin_v1(
  p_user_id uuid,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_action text:=p_input->>'action';
  v_decision_id uuid;
  v_project_id uuid;
  v_profile clued_private.resource_center_profiles_v1%rowtype;
  v_artifact clued_private.resource_center_artifacts_v1%rowtype;
  v_binding clued_private.resource_center_bindings_v1%rowtype;
  v_receipt public.clued_audit_receipts%rowtype;
  v_result jsonb;
  v_target_refs jsonb;
  v_base jsonb:='{}'::jsonb;
  v_committed jsonb:='{}'::jsonb;
  v_event_id text;
  v_target_id uuid;
  v_version bigint;
  v_root text;
  v_path text;
  v_parent text;
  v_error text;
  v_state text;
begin
  if p_user_id is null or v_action not in
    ('profile_register','artifact_register','artifact_update','artifact_revoke',
      'binding_issue','binding_revoke','profile_revoke') then
    raise exception 'resource_center_admin_invalid' using errcode='22023';
  end if;
  if coalesce(p_input->>'source_decision_id','') !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'source_decision_required' using errcode='22023';
  end if;
  v_decision_id:=(p_input->>'source_decision_id')::uuid;
  if v_action='profile_register' then
    v_project_id:=(p_input->>'project_id')::uuid;
  else
    select * into v_profile from clued_private.resource_center_profiles_v1
      where id=(p_input->>'profile_id')::uuid and user_id=p_user_id for update;
    if not found or v_profile.state<>'active' then
      raise exception 'resource_center_profile_unavailable' using errcode='P0002';
    end if;
    v_project_id:=v_profile.project_id;
  end if;
  if not exists(select 1 from public.clued_memories m
    where m.id=v_decision_id and m.user_id=p_user_id and m.record_type='decision'
      and m.authority='user_explicit' and m.lifecycle_status='active'
      and m.canonical_scope='project:'||v_project_id::text
      and clued_private.record_currentness_fence(
        p_user_id,m.id,array['project:'||v_project_id::text])='CURRENT') then
    raise exception 'owner_decision_required' using errcode='42501';
  end if;
  v_receipt:=clued_private.m1_begin_receipt(
    p_user_id,null,'resource_center_admin',p_input,clued_private.m1_sha256(p_input));
  if v_receipt.status<>'pending' then
    return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
      ||jsonb_build_object('replayed',true);
  end if;
  begin
    if v_action='profile_register' then
      v_root:=p_input->>'managed_root';
      if v_root is null or char_length(v_root)<2 or right(v_root,1)='/' or
        position(E'\\' in v_root)>0 or position('..' in v_root)>0 or
        (left(v_root,1)<>'/' and substring(v_root,2,2)<>':/') or
        coalesce(p_input->>'profile_version','')='' or
        coalesce(p_input->>'root_folder_id','')='' or
        coalesce(p_input->>'root_parent_id','')='' or
        coalesce(p_input->>'root_folder_version','') !~ '^[0-9]+$' then
        raise exception 'resource_center_profile_invalid' using errcode='22023';
      end if;
      insert into clued_private.resource_center_profiles_v1(
        user_id,project_id,profile_version,policy_version,managed_root,
        root_folder_id,root_parent_id,source_decision_id,receipt_id)
      values(p_user_id,v_project_id,p_input->>'profile_version',
        'clued.resource-center-mutation-policy/1',v_root,
        p_input->>'root_folder_id',p_input->>'root_parent_id',v_decision_id,v_receipt.id)
      returning * into v_profile;
      insert into clued_private.resource_center_artifacts_v1(
        user_id,profile_id,path,provider_file_id,provider_file_version,
        target_kind,governance_class,delete_authority,source_decision_id,receipt_id)
      values(p_user_id,v_profile.id,v_root,v_profile.root_folder_id,
        p_input->>'root_folder_version','directory','governance',false,v_decision_id,v_receipt.id);
      v_target_id:=v_profile.id; v_version:=v_profile.version;
    elsif v_action='artifact_register' then
      v_path:=p_input->>'path'; v_root:=v_profile.managed_root;
      if v_path is null or left(v_path,char_length(v_root)+1)<>v_root||'/' or
        right(v_path,1)='/' or position(E'\\' in v_path)>0 or
        position('..' in v_path)>0 or
        coalesce(p_input->>'provider_file_id','')='' or
        coalesce(p_input->>'provider_file_version','') !~ '^[0-9]+$' or
        p_input->>'target_kind' not in ('file','directory') or
        p_input->>'governance_class' not in ('ordinary','governance') or
        jsonb_typeof(p_input->'delete_authority')<>'boolean' then
        raise exception 'resource_center_artifact_invalid' using errcode='22023';
      end if;
      v_parent:=left(v_path,char_length(v_path)-strpos(reverse(v_path),'/'));
      if not exists(select 1 from clued_private.resource_center_artifacts_v1 a
        where a.profile_id=v_profile.id and a.path=v_parent and a.state='active'
          and a.target_kind='directory') then
        raise exception 'resource_center_parent_unregistered' using errcode='22023';
      end if;
      insert into clued_private.resource_center_artifacts_v1(
        user_id,profile_id,path,provider_file_id,provider_file_version,target_kind,
        governance_class,delete_authority,source_decision_id,receipt_id)
      values(p_user_id,v_profile.id,v_path,p_input->>'provider_file_id',
        p_input->>'provider_file_version',p_input->>'target_kind',
        p_input->>'governance_class',(p_input->>'delete_authority')::boolean,
        v_decision_id,v_receipt.id) returning * into v_artifact;
      v_target_id:=v_artifact.id; v_version:=v_artifact.version;
    elsif v_action='artifact_update' then
      select * into v_artifact from clued_private.resource_center_artifacts_v1
        where id=(p_input->>'artifact_id')::uuid and profile_id=v_profile.id
          and user_id=p_user_id and state='active' for update;
      if not found or v_artifact.version is distinct from (p_input->>'base_version')::bigint then
        raise exception 'resource_center_artifact_conflict' using errcode='40001';
      end if;
      v_path:=p_input->>'path'; v_root:=v_profile.managed_root;
      if v_path is null or
        (v_path<>v_root and left(v_path,char_length(v_root)+1)<>v_root||'/') or
        right(v_path,1)='/' or position(E'\\' in v_path)>0 or
        position('..' in v_path)>0 or
        coalesce(p_input->>'provider_file_id','')='' or
        coalesce(p_input->>'provider_file_version','') !~ '^[0-9]+$' or
        p_input->>'governance_class' not in ('ordinary','governance') or
        jsonb_typeof(p_input->'delete_authority')<>'boolean' then
        raise exception 'resource_center_artifact_invalid' using errcode='22023';
      end if;
      if v_artifact.target_kind='directory' and
        (v_path<>v_artifact.path or
          p_input->>'provider_file_id'<>v_artifact.provider_file_id or
          p_input->>'governance_class'<>v_artifact.governance_class or
          (p_input->>'delete_authority')::boolean<>v_artifact.delete_authority) then
        raise exception 'resource_center_directory_move_requires_subtree_contract' using errcode='22023';
      end if;
      if v_path<>v_root then
        v_parent:=left(v_path,char_length(v_path)-strpos(reverse(v_path),'/'));
        if not exists(select 1 from clued_private.resource_center_artifacts_v1 a
          where a.profile_id=v_profile.id and a.path=v_parent and a.state='active'
            and a.target_kind='directory') then
          raise exception 'resource_center_parent_unregistered' using errcode='22023';
        end if;
      end if;
      v_base:=jsonb_build_object(v_artifact.id::text,v_artifact.version);
      update clued_private.resource_center_artifacts_v1
        set path=v_path,provider_file_id=p_input->>'provider_file_id',
          provider_file_version=p_input->>'provider_file_version',
          governance_class=p_input->>'governance_class',
          delete_authority=(p_input->>'delete_authority')::boolean,
          version=version+1,updated_at=now(),
          source_decision_id=v_decision_id,receipt_id=v_receipt.id
        where id=v_artifact.id returning * into v_artifact;
      v_target_id:=v_artifact.id; v_version:=v_artifact.version;
    elsif v_action='artifact_revoke' then
      select * into v_artifact from clued_private.resource_center_artifacts_v1
        where id=(p_input->>'artifact_id')::uuid and profile_id=v_profile.id
          and user_id=p_user_id and state='active' for update;
      if not found or v_artifact.path=v_profile.managed_root or
        v_artifact.version is distinct from (p_input->>'base_version')::bigint then
        raise exception 'resource_center_artifact_conflict' using errcode='40001';
      end if;
      update clued_private.resource_center_artifacts_v1
        set state='revoked',version=version+1,updated_at=now(),
          source_decision_id=v_decision_id,receipt_id=v_receipt.id
        where id=v_artifact.id returning * into v_artifact;
      v_target_id:=v_artifact.id; v_version:=v_artifact.version;
      v_base:=jsonb_build_object(v_target_id::text,v_version-1);
    elsif v_action='binding_issue' then
      if coalesce(p_input->>'token_hash','') !~ '^[0-9a-f]{64}$' or
        (p_input->>'expires_at')::timestamptz<=now() or
        (p_input->>'expires_at')::timestamptz>now()+interval '30 days' then
        raise exception 'resource_center_binding_invalid' using errcode='22023';
      end if;
      insert into clued_private.resource_center_bindings_v1(
        user_id,profile_id,token_hash,expires_at,source_decision_id,receipt_id)
      values(p_user_id,v_profile.id,p_input->>'token_hash',
        (p_input->>'expires_at')::timestamptz,v_decision_id,v_receipt.id)
      returning * into v_binding;
      v_target_id:=v_binding.id; v_version:=1;
    elsif v_action='binding_revoke' then
      update clued_private.resource_center_bindings_v1
        set revoked_at=now(),version=version+1,
          source_decision_id=v_decision_id,receipt_id=v_receipt.id
        where id=(p_input->>'binding_id')::uuid and profile_id=v_profile.id
          and user_id=p_user_id and revoked_at is null
        returning * into v_binding;
      if not found then raise exception 'resource_center_binding_unavailable' using errcode='P0002'; end if;
      v_target_id:=v_binding.id; v_version:=v_binding.version;
      v_base:=jsonb_build_object(v_target_id::text,v_version-1);
    elsif v_action='profile_revoke' then
      if v_profile.version is distinct from (p_input->>'base_version')::bigint then
        raise exception 'resource_center_profile_conflict' using errcode='40001';
      end if;
      update clued_private.resource_center_profiles_v1
        set state='revoked',version=version+1,updated_at=now(),
          source_decision_id=v_decision_id,receipt_id=v_receipt.id
        where id=v_profile.id returning * into v_profile;
      update clued_private.resource_center_bindings_v1
        set revoked_at=now(),version=version+1
        where profile_id=v_profile.id and revoked_at is null;
      v_target_id:=v_profile.id; v_version:=v_profile.version;
      v_base:=jsonb_build_object(v_target_id::text,v_version-1);
    end if;
    v_target_refs:=jsonb_build_array(
      jsonb_build_object('kind','system','role','primary','id',v_target_id),
      jsonb_build_object('kind','record','role','source','id',v_decision_id));
    v_committed:=jsonb_build_object(v_target_id::text,v_version);
    v_event_id:=clued_private.m1_append_event_row(
      p_user_id,null,v_receipt.id,v_receipt.canonical_version,
      'extension:resource_center:'||v_action,v_target_refs,
      'project:'||v_project_id::text,null,
      jsonb_build_object('action',v_action,'target_id',v_target_id),
      p_input->>'idempotency_key',v_receipt.request_sha256,
      'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
      v_result:=clued_private.m1_finish_receipt(
      v_receipt.id,'committed',v_target_refs,v_base,v_committed,
      array[v_event_id],'{}'::uuid[],null);
    return v_result||jsonb_build_object('replayed',false);
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(
      v_receipt.id,case when v_state in ('22023','23502','23503','23505','23514','40001','42501','P0002')
        then 'rejected' else 'failed' end,
      '[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::text[],'{}'::uuid[],v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;
revoke all on function public.clued_resource_center_admin_v1(uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.clued_resource_center_admin_v1(uuid,jsonb) to service_role;

-- Resolve only the exact registered path and provider IDs/versions. Unknown,
-- revoked, stale or merely same-named files have no authority result.
create function public.clued_resource_center_authority_v1(
  p_token_hash text,p_request jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding clued_private.resource_center_bindings_v1%rowtype;
  v_profile clued_private.resource_center_profiles_v1%rowtype;
  v_root clued_private.resource_center_artifacts_v1%rowtype;
  v_source clued_private.resource_center_artifacts_v1%rowtype;
  v_parent clued_private.resource_center_artifacts_v1%rowtype;
  v_destination clued_private.resource_center_artifacts_v1%rowtype;
  v_selected clued_private.resource_center_artifacts_v1%rowtype;
  v_decision public.clued_memories%rowtype;
  v_mutation jsonb:=p_request->'mutation';
  v_provider jsonb:=p_request->'provider_identity';
  v_operation text:=v_mutation->>'operation';
  v_source_path text:=v_mutation->>'source_path';
  v_destination_path text:=v_mutation->>'destination_path';
  v_parent_path text;
  v_existing boolean;
begin
  if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or
    jsonb_typeof(p_request)<>'object' or jsonb_typeof(v_mutation)<>'object' or
    jsonb_typeof(v_provider)<>'object' or
    coalesce(p_request->>'policy_version','')<>'clued.resource-center-mutation-policy/1' or
    coalesce(v_mutation->>'artifact_role','')<>'clued_resource' or
    v_operation not in ('create','write','replace','move','rename','delete') or
    coalesce(v_provider->>'provider_version','') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status','denied');
  end if;
  select * into v_binding from clued_private.resource_center_bindings_v1
    where token_hash=p_token_hash and capability='authority:read'
      and revoked_at is null and expires_at>now();
  if not found then return jsonb_build_object('status','denied'); end if;
  select * into v_profile from clued_private.resource_center_profiles_v1
    where id=v_binding.profile_id and user_id=v_binding.user_id and state='active'
      and id::text=p_request->>'profile_id'
      and profile_version=p_request->>'profile_version'
      and policy_version=p_request->>'policy_version';
  if not found or v_provider->>'root_folder_id' is distinct from v_profile.root_folder_id or
    v_provider->>'root_parent_id' is distinct from v_profile.root_parent_id then
    return jsonb_build_object('status','denied');
  end if;
  select * into v_root from clued_private.resource_center_artifacts_v1
    where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
      and path=v_profile.managed_root and target_kind='directory'
      and provider_file_id=v_profile.root_folder_id
      and provider_file_version=v_provider->>'root_folder_version';
  if not found then return jsonb_build_object('status','denied'); end if;
  if v_operation='delete' then
    if v_source_path is null or v_destination_path is not null then
      return jsonb_build_object('status','denied');
    end if;
  elsif v_operation in ('move','rename') then
    if v_source_path is null or v_destination_path is null then
      return jsonb_build_object('status','denied');
    end if;
  elsif v_destination_path is null or v_source_path is not null then
    return jsonb_build_object('status','denied');
  end if;
  if v_source_path is not null then
    select * into v_source from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_source_path and path<>v_profile.managed_root
        and provider_file_id=v_provider->>'source_file_id'
        and provider_file_version=v_provider->>'source_file_version'
        and target_kind=v_mutation->>'target_kind';
    if not found then return jsonb_build_object('status','denied'); end if;
  elsif v_provider->>'source_file_id' is not null or v_provider->>'source_file_version' is not null then
    return jsonb_build_object('status','denied');
  end if;
  if v_destination_path is not null then
    if left(v_destination_path,char_length(v_profile.managed_root)+1)
       <>v_profile.managed_root||'/' then
      return jsonb_build_object('status','denied');
    end if;
    v_parent_path:=left(v_destination_path,
      char_length(v_destination_path)-strpos(reverse(v_destination_path),'/'));
    select * into v_parent from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_parent_path and target_kind='directory'
        and provider_file_id=v_provider->>'destination_parent_id'
        and provider_file_version=v_provider->>'destination_parent_version';
    if not found then return jsonb_build_object('status','denied'); end if;
    v_existing:=v_operation in ('write','replace');
    if v_existing then
      select * into v_destination from clued_private.resource_center_artifacts_v1
        where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
          and path=v_destination_path and target_kind=v_mutation->>'target_kind'
          and provider_file_id=v_provider->>'destination_file_id'
          and provider_file_version=v_provider->>'destination_file_version';
      if not found then return jsonb_build_object('status','denied'); end if;
    elsif v_provider->>'destination_file_id' is not null or
      v_provider->>'destination_file_version' is not null or
      exists(select 1 from clued_private.resource_center_artifacts_v1 a
        where a.profile_id=v_profile.id and a.path=v_destination_path and a.state='active') then
      return jsonb_build_object('status','denied');
    end if;
  elsif v_provider->>'destination_parent_id' is not null or
    v_provider->>'destination_file_id' is not null then
    return jsonb_build_object('status','denied');
  end if;
  if v_source.id is not null then v_selected:=v_source;
  elsif v_destination.id is not null then v_selected:=v_destination;
  else v_selected:=v_parent; end if;
  select * into v_decision from public.clued_memories m
    where m.id=v_selected.source_decision_id and m.user_id=v_profile.user_id
      and m.record_type='decision' and m.authority='user_explicit'
      and m.lifecycle_status='active'
      and m.canonical_scope='project:'||v_profile.project_id::text;
  if not found or clued_private.record_currentness_fence(
    v_profile.user_id,v_decision.id,array['project:'||v_profile.project_id::text])<>'CURRENT' then
    return jsonb_build_object('status','denied');
  end if;
  return jsonb_build_object('status','resolved','authority',jsonb_build_object(
    'artifact_id',case when v_operation='create' then null else v_selected.id end,
    'artifact_role','clued_resource','governance_class',v_selected.governance_class,
    'delete_authority',v_selected.delete_authority,
    'authority_version',v_selected.id::text||':'||v_selected.version::text||':'||v_decision.version::text,
    'currentness_identity','decision:'||v_decision.id::text||':'||v_decision.version::text,
    'workspace_version',v_profile.id::text||':'||v_profile.version::text||':'||v_selected.version::text));
exception when others then
  return jsonb_build_object('status','denied');
end $$;
revoke all on function public.clued_resource_center_authority_v1(text,jsonb)
  from public,anon,authenticated;
grant execute on function public.clued_resource_center_authority_v1(text,jsonb) to anon;
