-- Match registered directories by sharing state instead of their Drive version.
--
-- A registered directory's Google Drive version advances with ordinary Drive
-- activity. The authority lookup and the verified settlement required it to
-- equal the registered version, so writes were refused until the Owner ran a
-- directory check and approved a registry update. Placement is protected by the
-- exact provider ID, path and parent checks and by the live-to-live checks in the
-- executor (boundary rescan, three authority lookups, identity recheck around the
-- write, ancestors unchanged across the write). The version pin additionally
-- caught a sharing or permission change on a directory; that is now checked
-- directly.
--
-- A directory row may hold provider_sharing_digest: SHA-256 of its Drive shared
-- flag and sorted permission IDs (kernel/host/resource-center-google-drive-sharing.mjs).
-- For the managed root and the destination parent:
--   * digest recorded: the request's sharing digest must equal it; the Drive
--     version is not compared (reasons *_sharing_changed, *_sharing_unavailable);
--   * no digest: the Drive version must equal the registered one, as before
--     (reason *_version_mismatch).
-- Files, and source directories of move/rename/delete, keep the exact version.
-- Digests are recorded only by an Owner-approved artifact_update of a directory;
-- the directory check can now return them.
--
-- Rows that do not hold a digest behave exactly as before, so applying this
-- migration changes no current decision.

alter table clued_private.resource_center_artifacts_v1
  add column provider_sharing_digest text
  check (provider_sharing_digest is null or
    (provider_sharing_digest ~ '^[0-9a-f]{64}$' and target_kind='directory'));

create function clued_private.resource_center_directory_match_v1(
  p_registered_version text,p_registered_sharing text,p_request_version text,p_request_sharing text
) returns text language sql immutable set search_path='' as $$
  select case
    when p_registered_sharing is null then
      case when p_registered_version is not distinct from p_request_version
        then 'match' else 'version_mismatch' end
    when p_request_sharing is null then 'sharing_unavailable'
    when p_request_sharing=p_registered_sharing then 'match'
    else 'sharing_changed' end
$$;
revoke all on function clued_private.resource_center_directory_match_v1(text,text,text,text)
  from public,anon,authenticated,service_role;

create or replace function public.clued_resource_center_admin_v1(
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
      if p_input ? 'provider_sharing_digest' and p_input->'provider_sharing_digest'<>'null'::jsonb and
        (v_artifact.target_kind<>'directory' or
          coalesce(p_input->>'provider_sharing_digest','') !~ '^[0-9a-f]{64}$') then
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
          provider_sharing_digest=case when p_input ? 'provider_sharing_digest'
            then p_input->>'provider_sharing_digest' else provider_sharing_digest end,
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

create or replace function public.clued_resource_center_authority_v1(
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
    return jsonb_build_object('status','denied','reason','request_invalid');
  end if;
  select * into v_binding from clued_private.resource_center_bindings_v1
    where token_hash=p_token_hash and capability='authority:read'
      and revoked_at is null and expires_at>now();
  if not found or not clued_private.resource_center_renewal_current_v1(v_binding.id) then return jsonb_build_object('status','denied','reason','binding_inactive'); end if;
  select * into v_profile from clued_private.resource_center_profiles_v1
    where id=v_binding.profile_id and user_id=v_binding.user_id and state='active'
      and id::text=p_request->>'profile_id'
      and profile_version=p_request->>'profile_version'
      and policy_version=p_request->>'policy_version';
  if not found then
    return jsonb_build_object('status','denied','reason','profile_mismatch');
  end if;
  if v_provider->>'root_folder_id' is distinct from v_profile.root_folder_id or
    v_provider->>'root_parent_id' is distinct from v_profile.root_parent_id then
    return jsonb_build_object('status','denied','reason','root_identity_mismatch');
  end if;
  if not clued_private.resource_center_decision_current_v1(
      v_profile.user_id,v_profile.project_id,v_profile.source_decision_id) or
    not clued_private.resource_center_decision_current_v1(
      v_profile.user_id,v_profile.project_id,v_binding.source_decision_id) then
    return jsonb_build_object('status','denied','reason','decision_not_current');
  end if;
  select * into v_root from clued_private.resource_center_artifacts_v1
    where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
      and path=v_profile.managed_root and target_kind='directory'
      and provider_file_id=v_profile.root_folder_id;
  if not found then
    return jsonb_build_object('status','denied','reason','root_unregistered');
  end if;
  if clued_private.resource_center_directory_match_v1(v_root.provider_file_version,v_root.provider_sharing_digest,
      v_provider->>'root_folder_version',v_provider->>'root_sharing_digest') is distinct from 'match' then
    return jsonb_build_object('status','denied','reason','root_'||clued_private.resource_center_directory_match_v1(
      v_root.provider_file_version,v_root.provider_sharing_digest,
      v_provider->>'root_folder_version',v_provider->>'root_sharing_digest'));
  end if;
  if not clued_private.resource_center_path_current_v1(
    v_profile.user_id,v_profile.project_id,v_profile.id,
    v_profile.managed_root,v_profile.managed_root) then
    return jsonb_build_object('status','denied','reason','root_path_not_current');
  end if;
  if v_operation='delete' then
    if v_source_path is null or v_destination_path is not null then
      return jsonb_build_object('status','denied','reason','operation_shape_invalid');
    end if;
  elsif v_operation in ('move','rename') then
    if v_source_path is null or v_destination_path is null then
      return jsonb_build_object('status','denied','reason','operation_shape_invalid');
    end if;
  elsif v_destination_path is null or v_source_path is not null then
    return jsonb_build_object('status','denied','reason','operation_shape_invalid');
  end if;
  if v_source_path is not null then
    select * into v_source from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_source_path and path<>v_profile.managed_root
        and provider_file_id=v_provider->>'source_file_id'
        and provider_file_version=v_provider->>'source_file_version'
        and target_kind=v_mutation->>'target_kind';
    if not found or not clued_private.resource_center_path_current_v1(
      v_profile.user_id,v_profile.project_id,v_profile.id,
      v_profile.managed_root,v_source_path) then
      return jsonb_build_object('status','denied','reason','source_mismatch');
    end if;
  elsif v_provider->>'source_file_id' is not null or v_provider->>'source_file_version' is not null then
    return jsonb_build_object('status','denied','reason','operation_shape_invalid');
  end if;
  if v_destination_path is not null then
    if left(v_destination_path,char_length(v_profile.managed_root)+1)
       <>v_profile.managed_root||'/' then
      return jsonb_build_object('status','denied','reason','destination_outside_root');
    end if;
    v_parent_path:=left(v_destination_path,
      char_length(v_destination_path)-strpos(reverse(v_destination_path),'/'));
    select * into v_parent from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_parent_path and target_kind='directory'
        and provider_file_id=v_provider->>'destination_parent_id';
    if not found then
      return jsonb_build_object('status','denied','reason','parent_unregistered');
    end if;
    if clued_private.resource_center_directory_match_v1(v_parent.provider_file_version,v_parent.provider_sharing_digest,
        v_provider->>'destination_parent_version',v_provider->>'destination_parent_sharing_digest') is distinct from 'match' then
      return jsonb_build_object('status','denied','reason','parent_'||clued_private.resource_center_directory_match_v1(
        v_parent.provider_file_version,v_parent.provider_sharing_digest,
        v_provider->>'destination_parent_version',v_provider->>'destination_parent_sharing_digest'));
    end if;
    if not clued_private.resource_center_path_current_v1(
      v_profile.user_id,v_profile.project_id,v_profile.id,
      v_profile.managed_root,v_parent_path) then
      return jsonb_build_object('status','denied','reason','parent_path_not_current');
    end if;
    v_existing:=v_operation in ('write','replace');
    if v_existing then
      select * into v_destination from clued_private.resource_center_artifacts_v1
        where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
          and path=v_destination_path and target_kind=v_mutation->>'target_kind'
          and provider_file_id=v_provider->>'destination_file_id'
          and provider_file_version=v_provider->>'destination_file_version';
      if not found or not clued_private.resource_center_path_current_v1(
        v_profile.user_id,v_profile.project_id,v_profile.id,
        v_profile.managed_root,v_destination_path) then
        return jsonb_build_object('status','denied','reason','destination_mismatch');
      end if;
    elsif v_provider->>'destination_file_id' is not null or
      v_provider->>'destination_file_version' is not null then
      return jsonb_build_object('status','denied','reason','operation_shape_invalid');
    elsif exists(select 1 from clued_private.resource_center_artifacts_v1 a
        where a.profile_id=v_profile.id and a.path=v_destination_path and a.state='active') then
      return jsonb_build_object('status','denied','reason','destination_exists');
    end if;
  elsif v_provider->>'destination_parent_id' is not null or
    v_provider->>'destination_file_id' is not null then
    return jsonb_build_object('status','denied','reason','operation_shape_invalid');
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
    return jsonb_build_object('status','denied','reason','artifact_decision_not_current');
  end if;
  return jsonb_build_object('status','resolved','authority',jsonb_build_object(
    'artifact_id',case when v_operation='create' then null else v_selected.id end,
    'artifact_role','clued_resource','governance_class',v_selected.governance_class,
    'delete_authority',v_selected.delete_authority,
    'authority_version',v_selected.id::text||':'||v_selected.version::text||':'||v_decision.version::text,
    'currentness_identity','decision:'||v_decision.id::text||':'||v_decision.version::text,
    'workspace_version',v_profile.id::text||':'||v_profile.version::text||':'||v_selected.version::text));
exception when others then
  return jsonb_build_object('status','denied','reason','internal_error');
end $$;
revoke all on function public.clued_resource_center_authority_v1(text,jsonb)
  from public,anon,authenticated;
grant execute on function public.clued_resource_center_authority_v1(text,jsonb) to anon;

create or replace function clued_private.storage_verified_result_v2(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op text:=p_input->>'action'; app clued_private.storage_oauth_apps_v1;
  c clued_private.storage_connections_v1; j clued_private.storage_jobs_v1;
  p clued_private.resource_center_profiles_v1; policy clued_private.storage_account_policies_v2;
  m clued_private.resource_center_mutations_v1; parent clued_private.resource_center_artifacts_v1;
  r public.clued_audit_receipts; audit public.clued_audit_receipts; start_receipt public.clued_audit_receipts;
  proof jsonb:=p_input->'proof'; finish jsonb:=p_input->'finish'; post jsonb;
  expected jsonb; attempt_expected jsonb; req jsonb; refs jsonb; ev text; registered jsonb; result jsonb;
  ancestors jsonb; saved jsonb; parent_path text; root_key text; decision_version bigint; authority jsonb;
  registration_input jsonb; start_request jsonb; input_digest text:=clued_private.m1_sha256(p_input);
begin
  if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(p_input->'action') is distinct from 'string'
    or op not in ('verified_record','verified_inspect','settle_verified') then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  if (op='verified_record' and p_input-array['action','connection_id','job_id','credential_version','finish','proof']<>'{}'::jsonb)
    or (op='settle_verified' and p_input-array['action','connection_id','job_id','intent_id','base_version','request_sha256','verified_receipt_id','verified_digest']<>'{}'::jsonb)
    or (op='verified_inspect' and p_input is distinct from jsonb_build_object('action','verified_inspect','connection_id',p_input->>'connection_id','job_id',p_input->>'job_id')) then
    raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
  -- Operational pause (execution_enabled=false) is not final issuer revoke.
  -- This endpoint cannot load credentials or permit a provider request.
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and oauth_client_id=app.oauth_client_id;
  if not found then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('storage-job:'||c.owner_id::text||':'||(p_input->>'job_id')::uuid::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=(p_input->>'job_id')::uuid and connection_id=c.id;
  if not found or j.authority_snapshot_v2 is null or (j.intent_id is null and op<>'verified_inspect') then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  select root_folder_id into root_key from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  if root_key is null then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text||':'||root_key,0));
  perform clued_private.authorization_account_v12(c.owner_id);
  select * into c from clued_private.storage_connections_v1 where id=c.id for share;
  select * into policy from clued_private.storage_account_policies_v2 where id=(j.authority_snapshot_v2->>'policy_id')::uuid and owner_id=c.owner_id and connection_id=c.id for share;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id for update;
  if op='verified_inspect' and j.intent_id is null then
    -- This is NOT authority for fresh execution. Only the ordinary evaluator
    -- may subsequently load a queued job. Unknown/outcome paths never fall back.
    select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=j.job_id for share;
    if j.dispatch_outcome is null and c.auth_mode='account_policy' and c.state='active'
      and c.revoked_at is null and policy.state='active' then
      return jsonb_build_object('status','none','connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
    return jsonb_build_object('status','inspection_required','connection_id',c.id,'job_id',j.job_id,'execution_permitted',false);
  end if;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=c.owner_id and profile_id=p.id;
  parent_path:=left(j.mutation->>'destination_path',char_length(j.mutation->>'destination_path')-strpos(reverse(j.mutation->>'destination_path'),'/'));
  -- Profile lock serializes registry changes; lock all relevant Decisions in
  -- stable order before job/journal rows, including each registered ancestor.
  perform 1 from public.clued_memories d where d.id in (
    select unnest(array[c.source_decision_id,p.source_decision_id,policy.source_decision_id,m.source_decision_id,(p.cloud_runtime->>'source_decision_id')::uuid])
    union select a.source_decision_id from clued_private.resource_center_artifacts_v1 a
      where a.profile_id=p.id and a.user_id=c.owner_id and a.state='active'
        and (a.path=parent_path or left(parent_path,char_length(a.path)+1)=a.path||'/')) order by d.id for share;
  perform 1 from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=c.owner_id
    and a.state='active' and (a.path=parent_path or left(parent_path,char_length(a.path)+1)=a.path||'/') order by a.id for share;
  select jsonb_agg(to_jsonb(a) order by a.path collate "C") into ancestors
    from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=c.owner_id
      and a.state='active' and (a.path=parent_path or left(parent_path,char_length(a.path)+1)=a.path||'/');
  select * into parent from clued_private.resource_center_artifacts_v1 where profile_id=p.id and user_id=c.owner_id and state='active' and path=parent_path;
  select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=j.job_id for update;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=c.owner_id and profile_id=p.id for update;
  if m.id is null or policy.id is null or c.oauth_client_id<>app.oauth_client_id
    or p.root_folder_id<>root_key or j.connection_id<>c.id or j.authority_snapshot_v2 is null
    or m.writer_binding_id is distinct from j.cloud_writer_binding_id
    or m.exact_request->'mutation' is distinct from (j.mutation||jsonb_build_object('artifact_role','clued_resource'))
    or j.mutation->>'operation' is distinct from 'create'
    or j.request_digest is distinct from clued_private.m1_sha256(jsonb_build_object('connection_id',c.id,'mutation',j.mutation))
    or j.authority_snapshot_v2->>'owner_id' is distinct from c.owner_id::text
    or j.authority_snapshot_v2->>'connection_id' is distinct from c.id::text
    or j.authority_snapshot_v2->>'profile_id' is distinct from p.id::text
    or j.authority_snapshot_v2->>'profile_version' is distinct from m.profile_version::text
    or j.authority_snapshot_v2->>'binding_id' is distinct from j.binding_id::text
    or j.authority_snapshot_v2->>'authorization_version' is distinct from j.authorization_version::text
    or j.grant_receipt_id is distinct from policy.activation_receipt_id
    or j.authority_snapshot_v2->>'policy_receipt_id' is distinct from policy.activation_receipt_id::text
    or j.authority_snapshot_v2->>'consent_receipt_id' is distinct from policy.consent_receipt_id::text
    or not exists(select 1 from public.clued_audit_receipts where id=j.receipt_id and user_id=c.owner_id and binding_id=j.binding_id
      and status='committed' and operation='storage_job_submit' and received_payload_hash=j.request_digest
      and request_sha256=clued_private.m1_sha256(jsonb_build_object('operation','storage_job_submit','payload',
        jsonb_build_object('job_id',j.job_id,'request_digest',j.request_digest)))) then
    raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
  saved:=m.verified_result_v2;
  -- The original atomic begin always prepared at version 1 and started at 2.
  -- Preserve that exact durable admission receipt independently of m.receipt_id,
  -- which uncertain/finalize subsequently replace. Hashes below are checked
  -- internally only: authority_token_hash never enters this new audit payload.
  start_request:=jsonb_build_object('action','start','intent_id',m.id,'base_version',1,
    'request_sha256',m.request_sha256,'idempotency_key','account-job:'||j.job_id::text||':start',
    'profile_id',m.profile_id,'source_decision_id',m.source_decision_id,
    'authority_token_hash',m.authority_token_hash,'writer_binding_id',m.writer_binding_id);
  select * into start_receipt from public.clued_audit_receipts where user_id=c.owner_id
    and operation_family='resource_center_journal' and operation='resource_center_journal'
    and idempotency_key=start_request->>'idempotency_key' and owns_idempotency_key;
  if not found or start_receipt.status<>'committed' or start_receipt.binding_id is not null
    or start_receipt.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object(
      'operation','resource_center_journal','payload',start_request-'idempotency_key'))
    or start_receipt.received_payload_hash is distinct from clued_private.m1_sha256(start_request)
    or start_receipt.target_refs is distinct from jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id))
    or start_receipt.committed_versions is distinct from jsonb_build_object(m.id::text,2)
    or start_receipt.canonical_result is distinct from clued_private.m1_result_envelope(start_receipt)
    or start_receipt.response_hash is distinct from clued_private.m1_sha256(start_receipt.canonical_result)
    or (saved is not null and saved->>'start_receipt_id' is distinct from start_receipt.id::text)
    or (m.state='started' and (m.version<>2 or m.receipt_id is distinct from start_receipt.id)) then
    raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
  if saved is null and op='verified_record' then
    select * into audit from public.clued_audit_receipts where id=m.receipt_id and user_id=c.owner_id
      and operation='resource_center_journal' and status='committed';
    if not found or audit.target_refs is distinct from start_receipt.target_refs
      or audit.committed_versions is distinct from jsonb_build_object(m.id::text,m.version)
      or audit.canonical_result is distinct from clued_private.m1_result_envelope(audit)
      or audit.response_hash is distinct from clued_private.m1_sha256(audit.canonical_result) then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
  end if;
  if saved is not null and m.state='committed' then
    -- A concurrent active finalize is historical success only when its exact
    -- Artifact receipt registered the SAME persisted proof, not another version.
    registration_input:=jsonb_build_object('action','artifact_register','profile_id',p.id,'source_decision_id',m.source_decision_id,
      'idempotency_key','resource-center-finalize:'||m.id::text,'path',saved->'proof'->>'path',
      'provider_file_id',saved->'proof'->>'provider_file_id','provider_file_version',saved->'proof'->>'provider_file_version',
      'target_kind',m.authority_request->'mutation'->>'target_kind','governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false);
    if not exists(select 1 from public.clued_audit_receipts where id=(m.final_result->>'receipt_id')::uuid
      and user_id=c.owner_id and status='committed' and operation='resource_center_admin'
      and request_sha256=clued_private.m1_sha256(jsonb_build_object('operation','resource_center_admin','payload',registration_input-'idempotency_key'))
      and received_payload_hash=clued_private.m1_sha256(registration_input)) then
      raise exception 'storage_verified_conflict' using errcode='40001'; end if;
  end if;
  if op='verified_inspect' then
    if saved is not null and (saved->>'issuer_hash' is distinct from p_issuer_hash
      or m.verified_digest_v2 is distinct from clued_private.m1_sha256(saved)
      or not exists(select 1 from public.clued_audit_receipts where id=m.verified_receipt_id_v2 and user_id=c.owner_id
        and status='committed' and operation='storage_verified_record')) then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    if m.state='committed' and exists(select 1 from public.clued_audit_receipts where id=m.receipt_id and user_id=c.owner_id and status='committed') then
      return jsonb_build_object('status','committed','state','committed','connection_id',c.id,'job_id',j.job_id,'intent_id',m.id,'version',m.version,
        'request_sha256',m.request_sha256,'receipt_id',m.receipt_id,'final_result',m.final_result,'execution_permitted',false);
    elsif saved is not null then
      return jsonb_build_object('status','verified','connection_id',c.id,'job_id',j.job_id,'verified_receipt_id',m.verified_receipt_id_v2,'verified_digest',m.verified_digest_v2,
        'intent_id',m.id,'version',(saved->>'intent_version')::bigint,'request_sha256',m.request_sha256,'execution_permitted',false);
    else
      return jsonb_build_object('status','inspection_required','connection_id',c.id,'job_id',j.job_id,'intent_id',m.id,'execution_permitted',false);
    end if;
  end if;
  -- Exact record response recovery is metadata only, even if connection state
  -- changed after its commit. It never records late proof after final revoke.
  if op='verified_record' and saved is not null then
    if saved->>'issuer_hash' is distinct from p_issuer_hash or saved->>'record_input_digest' is distinct from input_digest
      or m.verified_digest_v2 is distinct from clued_private.m1_sha256(saved)
      or not exists(select 1 from public.clued_audit_receipts where id=m.verified_receipt_id_v2 and user_id=c.owner_id and status='committed' and operation='storage_verified_record') then
      raise exception 'storage_verified_conflict' using errcode='40001'; end if;
    return jsonb_build_object('status','verified','verified_receipt_id',m.verified_receipt_id_v2,'verified_digest',m.verified_digest_v2,
      'intent_id',m.id,'version',(saved->>'intent_version')::bigint,'execution_permitted',false);
  end if;
  if op='settle_verified' then
    if saved is null or saved->>'issuer_hash' is distinct from p_issuer_hash
      or m.verified_digest_v2 is distinct from clued_private.m1_sha256(saved)
      or (p_input is distinct from jsonb_build_object('action','settle_verified','connection_id',c.id,'job_id',j.job_id)
        and p_input is distinct from jsonb_build_object('action','settle_verified','connection_id',c.id,'job_id',j.job_id,
        'intent_id',m.id,'base_version',(saved->>'intent_version')::bigint,'request_sha256',m.request_sha256,
        'verified_receipt_id',m.verified_receipt_id_v2,'verified_digest',m.verified_digest_v2))
      or saved->'provider_attempt' is distinct from m.provider_attempt
      or saved->>'provider_attempt_receipt_id' is distinct from m.provider_attempt_receipt_id::text
      or saved->>'writer_binding_id' is distinct from m.writer_binding_id::text
      or saved->'authority_snapshot' is distinct from j.authority_snapshot_v2
      or saved->>'job_request_digest' is distinct from j.request_digest
      or saved->>'submit_receipt_id' is distinct from j.receipt_id::text
      or saved->>'exact_request_digest' is distinct from clued_private.m1_sha256(m.exact_request)
      or saved->>'authority_request_digest' is distinct from clued_private.m1_sha256(m.authority_request)
      or saved->'authority_result' is distinct from m.authority_result then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    select * into audit from public.clued_audit_receipts where id=m.verified_receipt_id_v2 and user_id=c.owner_id and status='committed' and operation='storage_verified_record';
    req:=jsonb_build_object('idempotency_key','storage-verified:'||m.id::text,'intent_id',m.id,'verified_digest',m.verified_digest_v2);
    if not found or audit.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_verified_record','payload',req-'idempotency_key'))
      or audit.received_payload_hash is distinct from clued_private.m1_sha256(req)
      or audit.response_hash is distinct from clued_private.m1_sha256(audit.canonical_result) then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    if m.state='committed' then
      if m.version<>(saved->>'intent_version')::bigint+1 or not exists(select 1 from public.clued_audit_receipts
        where id=m.receipt_id and user_id=c.owner_id and status='committed') then raise exception 'storage_verified_conflict' using errcode='40001'; end if;
      return clued_private.storage_job_status_v1(j)||jsonb_build_object('state','committed','version',m.version,
        'request_sha256',m.request_sha256,'final_result',m.final_result);
    end if;
    if m.version<>(saved->>'intent_version')::bigint or m.state not in ('started','uncertain') then raise exception 'storage_verified_conflict' using errcode='40001'; end if;
    proof:=saved->'proof'; finish:=saved->'finish';
    if ancestors is distinct from saved->'ancestors' then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  end if;
  -- No token/Binding is renewed for these checks; they describe the original
  -- still-current registry. A changed registry preserves unknown, not overwrite.
  if p.state<>'active' or p.version<>m.profile_version or parent.id is null or parent.target_kind<>'directory'
    or parent.provider_file_id is distinct from m.provider_attempt->>'parent_id'
    or clued_private.resource_center_directory_match_v1(parent.provider_file_version,parent.provider_sharing_digest,
      m.authority_request->'provider_identity'->>'destination_parent_version',
      m.authority_request->'provider_identity'->>'destination_parent_sharing_digest') is distinct from 'match'
    or not clued_private.resource_center_path_current_v1(c.owner_id,p.project_id,p.id,p.managed_root,parent_path)
    or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,m.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,(p.cloud_runtime->>'source_decision_id')::uuid)
    or not exists(select 1 from public.clued_memories where id=(p.cloud_runtime->>'source_decision_id')::uuid
      and version=(p.cloud_runtime->>'decision_version')::bigint)
    or not exists(select 1 from clued_private.resource_center_artifacts_v1 where profile_id=p.id and user_id=c.owner_id
      and path=p.managed_root and state='active' and target_kind='directory' and provider_file_id=p.root_folder_id
      and clued_private.resource_center_directory_match_v1(provider_file_version,provider_sharing_digest,
        m.authority_request->'provider_identity'->>'root_folder_version',
        m.authority_request->'provider_identity'->>'root_sharing_digest')='match') then
    raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  select version into decision_version from public.clued_memories where id=parent.source_decision_id and user_id=c.owner_id;
  authority:=jsonb_build_object('status','resolved','authority',jsonb_build_object('artifact_id',null,
    'artifact_role','clued_resource','governance_class',parent.governance_class,'delete_authority',parent.delete_authority,
    'authority_version',parent.id::text||':'||parent.version::text||':'||decision_version::text,
    'currentness_identity','decision:'||parent.source_decision_id::text||':'||decision_version::text,
    'workspace_version',p.id::text||':'||p.version::text||':'||parent.version::text));
  if authority is distinct from m.authority_result then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  if op='verified_record' then
    if c.auth_mode<>'account_policy' or c.state not in ('active','reauthorization_required') or c.revoked_at is not null
      or policy.state<>'active' or policy.revoked_at is not null or c.account_policy_id<>policy.id
      or c.auth_generation::text is distinct from j.authority_snapshot_v2->>'auth_generation'
      or policy.policy_generation::text is distinct from j.authority_snapshot_v2->>'policy_generation'
      or policy.scope_digest is distinct from j.authority_snapshot_v2->>'scope_digest'
      or c.credential_version is distinct from (p_input->>'credential_version')::bigint
      or coalesce(policy.expires_at<=clock_timestamp(),false)
      or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,c.source_decision_id)
      or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,policy.source_decision_id)
      or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=c.owner_id and provider=c.provider
        and provider_subject=c.provider_subject and root_folder_id=root_key and lineage_id is null and denied) then
      raise exception 'storage_verified_denied' using errcode='42501'; end if;
    if m.state not in ('started','uncertain') or m.provider_attempt is null or m.provider_attempt_receipt_id is null
      or jsonb_typeof(finish) is distinct from 'object' or finish-array['action','intent_id','base_version','request_sha256','idempotency_key','postcondition']<>'{}'::jsonb
      or finish->>'action' is distinct from 'finalize' or finish->>'intent_id' is distinct from m.id::text
      or finish->>'base_version' is distinct from m.version::text or finish->>'request_sha256' is distinct from m.request_sha256
      or coalesce(length(finish->>'idempotency_key'),0) not between 1 and 160 then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    attempt_expected:=jsonb_build_object('contract','clued.resource-center-provider-attempt/1','intent_id',m.id,
      'request_sha256',m.request_sha256,'profile_id',p.id,'provider_file_id',m.provider_attempt->>'provider_file_id',
      'destination_path',j.mutation->>'destination_path','parent_id',m.authority_request->'provider_identity'->>'destination_parent_id',
      'target_kind',j.mutation->>'target_kind','binding',m.exact_request->'binding',
      'size',case when j.mutation->>'target_kind'='file' then octet_length(j.mutation->>'content')::text end,
      'sha256',case when j.mutation->>'target_kind'='file' then encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);
    if m.provider_attempt is distinct from attempt_expected then raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    select * into audit from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=c.owner_id and status='committed' and operation='storage_provider_attempt';
    req:=jsonb_build_object('idempotency_key','storage-provider-attempt:'||m.id::text,'intent_id',m.id,'attempt_digest',clued_private.m1_sha256(attempt_expected));
    if not found or audit.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_provider_attempt','payload',req-'idempotency_key'))
      or audit.received_payload_hash is distinct from clued_private.m1_sha256(req)
      or audit.response_hash is distinct from clued_private.m1_sha256(audit.canonical_result) then raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    post:=jsonb_build_object('path',attempt_expected->>'destination_path','parent_id',attempt_expected->>'parent_id',
      'provider_file_id',attempt_expected->>'provider_file_id','provider_file_version',proof->>'provider_file_version');
    expected:=post||jsonb_build_object('contract','clued.storage-create-verified/2','target_kind',j.mutation->>'target_kind',
      'size',attempt_expected->'size','sha256',attempt_expected->'sha256','provider_before',m.authority_request->'provider_identity',
      'checks',jsonb_build_object('identity',true,'content',true,'ancestors',true,'unique_name',true,'stable_version',true));
    if proof is distinct from expected or finish->'postcondition' is distinct from post
      or coalesce(proof->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$'
      or coalesce(proof->>'provider_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    saved:=jsonb_build_object('contract','clued.storage-persisted-verification/2','issuer_hash',p_issuer_hash,
      'record_input_digest',input_digest,'recorded_at',clock_timestamp(),'owner_id',c.owner_id,'connection_id',c.id,'job_id',j.job_id,
      'job_request_digest',j.request_digest,'submit_receipt_id',j.receipt_id,'start_receipt_id',start_receipt.id,
      'intent_id',m.id,'intent_version',m.version,
      'request_sha256',m.request_sha256,'writer_binding_id',m.writer_binding_id,'provider_attempt',m.provider_attempt,
      'provider_attempt_receipt_id',m.provider_attempt_receipt_id,'authority_snapshot',j.authority_snapshot_v2,
      'exact_request_digest',clued_private.m1_sha256(m.exact_request),'authority_request_digest',clued_private.m1_sha256(m.authority_request),
      'authority_result',m.authority_result,'ancestors',ancestors,'proof',proof,'finish',finish);
    req:=jsonb_build_object('idempotency_key','storage-verified:'||m.id::text,'intent_id',m.id,'verified_digest',clued_private.m1_sha256(saved));
    r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_verified_record',req,clued_private.m1_sha256(req));
    if r.status<>'pending' then raise exception 'storage_verified_conflict' using errcode='40001'; end if;
    update clued_private.resource_center_mutations_v1 set verified_result_v2=saved,verified_receipt_id_v2=r.id,
      verified_digest_v2=clued_private.m1_sha256(saved) where id=m.id returning * into m;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
    ev:=clued_private.m1_append_event_row(c.owner_id,null,r.id,r.canonical_version,'extension:storage:verified_recorded',refs,
      'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
    if coalesce(policy.expires_at<=clock_timestamp(),false) then raise exception 'storage_verified_denied' using errcode='42501'; end if;
    return jsonb_build_object('status','verified','verified_receipt_id',r.id,'verified_digest',m.verified_digest_v2,
      'intent_id',m.id,'version',m.version,'execution_permitted',false);
  end if;
  -- All registration data comes from the immutable DB proof, never fresh
  -- caller postconditions. The original admin supplies its independent receipt.
  req:=jsonb_build_object('idempotency_key','storage-settle-verified:'||m.id::text,'intent_id',m.id,'verified_digest',m.verified_digest_v2);
  r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_verified_settle',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_verified_conflict' using errcode='40001'; end if;
  registration_input:=jsonb_build_object('action','artifact_register','profile_id',p.id,'source_decision_id',m.source_decision_id,
    'idempotency_key','resource-center-finalize:'||m.id::text,'path',proof->>'path','provider_file_id',proof->>'provider_file_id',
    'provider_file_version',proof->>'provider_file_version','target_kind',m.authority_request->'mutation'->>'target_kind',
    'governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false);
  registered:=public.clued_resource_center_admin_v1(c.owner_id,registration_input);
  if registered->>'status' is distinct from 'committed' then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  update clued_private.resource_center_mutations_v1 set state='committed',version=version+1,updated_at=clock_timestamp(),
    receipt_id=r.id,final_result=registered where id=m.id returning * into m;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
  ev:=clued_private.m1_append_event_row(c.owner_id,null,r.id,r.canonical_version,'extension:storage:verified_settled',refs,
    'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,jsonb_build_object(m.id::text,m.version),array[ev],'{}'::uuid[],null);
  return result||jsonb_build_object('state','committed','connection_id',c.id,'job_id',j.job_id,'intent_id',m.id,'version',m.version,'request_sha256',m.request_sha256,
    'execution_permitted',false,'final_result',registered);
end $$;

create or replace function public.clued_storage_directory_probe_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); app clued_private.storage_oauth_apps_v1;
  c clued_private.storage_connections_v1; x clued_private.storage_directory_probes_v1;
  cid uuid; root_id text; d jsonb; o jsonb:=p_input->'observation'; item jsonb; expected jsonb; parent_id text;
  r public.clued_audit_receipts; req jsonb; refs jsonb; ev text; result jsonb; op text:=p_input->>'action';
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('prepare','complete') then
    raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  if op='prepare' then
    if p_input is distinct from jsonb_build_object('action','prepare','connection_id',p_input->>'connection_id') then
      raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
    cid:=(p_input->>'connection_id')::uuid;
  else
    if (p_input-array['action','attempt_id','observation'])<>'{}'::jsonb then
      raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
    select * into x from clued_private.storage_directory_probes_v1 where id=(p_input->>'attempt_id')::uuid and owner_id=u
      and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=app.issuer_hash;
    if not found then raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
    cid:=x.connection_id;
  end if;
  select pr.root_folder_id into root_id from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u where co.id=cid and co.owner_id=u;
  if root_id is null then raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root_id,0));
  perform clued_private.storage_root_quiet_v1(u,root_id);
  d:=clued_private.storage_directory_descriptor_v1(u,cid);
  select * into c from clued_private.storage_connections_v1 where id=cid;
  if c.oauth_client_id<>app.oauth_client_id or not clued_private.storage_envelope_valid_v1(c.credential_envelope) then
    raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  if op='prepare' then
    insert into clued_private.storage_directory_probes_v1(owner_id,session_id,issuer_hash,connection_id,descriptor,credential_digest)
      values(u,(auth.jwt()->>'session_id')::uuid,app.issuer_hash,cid,d,clued_private.m1_sha256(c.credential_envelope)) returning * into x;
    result:=jsonb_build_object('status','prepared','attempt_id',x.id,'descriptor',d,
      'credential_envelope',c.credential_envelope,'expires_at',x.expires_at);
  else
    select * into x from clued_private.storage_directory_probes_v1 where id=x.id for update;
    if x.expires_at<=clock_timestamp() or x.descriptor is distinct from d or
      x.credential_digest is distinct from clued_private.m1_sha256(c.credential_envelope) then
      raise exception 'storage_directory_probe_stale' using errcode='40001'; end if;
    if x.receipt_id is not null then
      if o is distinct from x.observation then raise exception 'storage_directory_probe_conflict' using errcode='40001'; end if;
    else
      if jsonb_typeof(o) is distinct from 'object' or (o-array['contract','status','execution_permitted','observed_at_ms','directories'])<>'{}'::jsonb
        or o->>'contract' is distinct from 'clued.storage-directory-observation/1' or o->>'status' is distinct from 'metadata_observed'
        or o->'execution_permitted' is distinct from 'false'::jsonb or jsonb_typeof(o->'observed_at_ms') is distinct from 'number'
        or (o->>'observed_at_ms')::numeric < extract(epoch from x.created_at)*1000-1000
        or (o->>'observed_at_ms')::numeric > extract(epoch from clock_timestamp())*1000+1000
        or jsonb_typeof(o->'directories') is distinct from 'array' then
        raise exception 'storage_directory_probe_invalid' using errcode='22023'; end if;
      if jsonb_array_length(o->'directories')<>jsonb_array_length(d->'layout'->'directories') or
        (select count(distinct e->>'path') from jsonb_array_elements(o->'directories') e)<>jsonb_array_length(o->'directories') then
        raise exception 'storage_directory_probe_invalid' using errcode='22023'; end if;
      for item in select value from jsonb_array_elements(o->'directories') loop
        select e into expected from jsonb_array_elements(d->'layout'->'directories') e where e->>'path'=item->>'path';
        if item->>'path'=d->'layout'->>'managed_root' then parent_id:=d->'layout'->>'root_parent_id';
        else select e->>'provider_file_id' into parent_id from jsonb_array_elements(d->'layout'->'directories') e
          where e->>'path'=regexp_replace(item->>'path','/[^/]+$',''); end if;
        if expected is null or parent_id is null or jsonb_typeof(item) is distinct from 'object'
          or (item-array['path','provider_file_id','provider_file_version','parent_id','provider_sharing_digest'])<>'{}'::jsonb
          or (item ? 'provider_sharing_digest' and item->'provider_sharing_digest'<>'null'::jsonb
            and coalesce(item->>'provider_sharing_digest','') !~ '^[0-9a-f]{64}$')
          or item->>'provider_file_id' is distinct from expected->>'provider_file_id' or item->>'parent_id' is distinct from parent_id
          or coalesce(item->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$' then
          raise exception 'storage_directory_probe_invalid' using errcode='22023'; end if;
      end loop;
      req:=jsonb_build_object('idempotency_key',x.id::text||':directory-observation','attempt_id',x.id,
        'descriptor_digest',clued_private.m1_sha256(d),'observation_digest',clued_private.m1_sha256(o));
      r:=clued_private.m1_begin_receipt(u,null,'storage_directory_observe',req,clued_private.m1_sha256(req));
      if r.status<>'pending' then raise exception 'storage_directory_probe_conflict' using errcode='40001'; end if;
      refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',cid));
      ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:directory_observed',refs,
        'project:'||(d->>'project_id'),null,req-'idempotency_key',req->>'idempotency_key',r.request_sha256,
        'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
      perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
      update clued_private.storage_directory_probes_v1 set observation=o,receipt_id=r.id where id=x.id;
      x.receipt_id:=r.id;
    end if;
    result:=jsonb_build_object('status','metadata_observed','attempt_id',x.id,'receipt_id',x.receipt_id,'execution_permitted',false);
  end if;
  -- Wall-clock checks after all lock waits. Expiry is not transaction-start now().
  perform clued_private.storage_owner_v1();
  if x.expires_at<=clock_timestamp() then raise exception 'storage_directory_probe_stale' using errcode='40001'; end if;
  return result;
end $$;
