-- Diagnose a registered file at a different Drive version without changing authority.
-- Keep the original version-matching query and every denial. Only a current file
-- identity may get this fixed label; no identifiers or versions leave the RPC.
-- CREATE OR REPLACE preserves the existing gateway/role ACL. No grants are added.
do $migration$
declare
  body text:=pg_get_functiondef('public.clued_resource_center_authority_v1(text,jsonb)'::regprocedure);
  anchor text:=$anchor$        return jsonb_build_object('status','denied','reason','destination_mismatch');$anchor$;
  replacement text:=$replacement$        -- Classify only an authenticated, current file identity at another version.
        -- The original strict version predicate above still denies the request.
        -- This read-only diagnosis cannot resolve authority or update a registration.
        if coalesce(v_provider->>'destination_file_version','') ~ '^[1-9][0-9]{0,39}$'
          and clued_private.resource_center_path_current_v1(
            v_profile.user_id,v_profile.project_id,v_profile.id,
            v_profile.managed_root,v_destination_path)
          and (not (v_provider ? 'ancestors') or
            clued_private.resource_center_ancestors_match_v1(v_profile,v_provider,v_mutation)='match')
          and exists(select 1 from clued_private.resource_center_artifacts_v1 a
            where a.profile_id=v_profile.id and a.user_id=v_profile.user_id and a.state='active'
              and a.path=v_destination_path and a.target_kind='file'
              and v_mutation->>'target_kind'='file'
              and a.provider_file_id=v_provider->>'destination_file_id'
              and a.provider_file_version is distinct from v_provider->>'destination_file_version'
              and clued_private.resource_center_decision_current_v1(
                v_profile.user_id,v_profile.project_id,a.source_decision_id)) then
          return jsonb_build_object('status','denied','reason','destination_version_mismatch');
        end if;
        return jsonb_build_object('status','denied','reason','destination_mismatch');$replacement$;
  hits integer;
begin
  if position('''destination_version_mismatch''' in body)>0 then
    hits:=(char_length(body)-char_length(replace(body,replacement,'')))/char_length(replacement);
    if hits<>1 then raise exception 'storage_file_version_denial_definition_mismatch'; end if;
    return;
  end if;
  hits:=(char_length(body)-char_length(replace(body,anchor,'')))/char_length(anchor);
  if hits<>1 then raise exception 'storage_file_version_denial_definition_mismatch'; end if;
  body:=replace(body,anchor,replacement);
  execute body;
end $migration$;
