-- Classify Resource Center authority denials with a fixed reason code.
--
-- Every denial of public.clued_resource_center_authority_v1 used to return the
-- same {"status":"denied"}, so a pre-write refusal of a Storage job could not be
-- told apart without an Owner-run directory check. Each denial point now adds a
-- fixed "reason" label. The label names the failed check only; it never carries
-- a path, a version, a provider file ID or any other request value.
--
-- The decision is unchanged: every input that was denied before is still denied
-- at the same point, and every input that resolved before still resolves to the
-- same result. The only additions are two read-only lookups, run after a root or
-- destination-parent row did not match, that tell a registered folder at another
-- provider version (root_version_mismatch, parent_version_mismatch) from a folder
-- that is not registered at all (root_unregistered, parent_unregistered).
--
-- Callers that compare a recomputed result with a stored resolved result
-- (mutation journal, cloud bridge, native recovery) still see any denial as
-- distinct from it.

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
      and provider_file_id=v_profile.root_folder_id
      and provider_file_version=v_provider->>'root_folder_version';
  if not found then
    if exists(select 1 from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_profile.managed_root and target_kind='directory'
        and provider_file_id=v_profile.root_folder_id) then
      return jsonb_build_object('status','denied','reason','root_version_mismatch');
    end if;
    return jsonb_build_object('status','denied','reason','root_unregistered');
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
        and provider_file_id=v_provider->>'destination_parent_id'
        and provider_file_version=v_provider->>'destination_parent_version';
    if not found then
      if exists(select 1 from clued_private.resource_center_artifacts_v1
        where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
          and path=v_parent_path and target_kind='directory'
          and provider_file_id=v_provider->>'destination_parent_id') then
        return jsonb_build_object('status','denied','reason','parent_version_mismatch');
      end if;
      return jsonb_build_object('status','denied','reason','parent_unregistered');
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
