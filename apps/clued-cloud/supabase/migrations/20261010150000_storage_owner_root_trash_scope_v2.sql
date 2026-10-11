-- Native Owner whole-created-root successor. This explicit /2 confirmation
-- covers the fixed Root and all its contents at execution, including later
-- additions. It is not an atomic Google metadata/subtree CAS. /1 retains its
-- strong ETag and exact preview snapshot. No provider request runs in SQL.
-- No role, grant, credential, Root-stop, delegation or old function is restored.

do $upgrade$
declare v_oid oid:=to_regprocedure('public.clued_storage_owner_lifecycle_v1(text,jsonb)');
  v_source text; v_definition text; v_catalog jsonb; v_new text; v_hash text;
begin
  select p.prosrc,pg_get_functiondef(p.oid),jsonb_build_object(
    'signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
    'security_definer',p.prosecdef,'language',l.lanname,'config',p.proconfig,
    'source_sha256',encode(pg_catalog.sha256(convert_to(p.prosrc,'UTF8')),'hex'))
    into v_source,v_definition,v_catalog from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=v_oid;
  if v_oid is null or not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=v_oid
    and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and l.lanname='plpgsql'
    and p.provolatile='v' and p.prorettype='jsonb'::regtype and p.proconfig=array['search_path=""'])
    or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_roles gr on gr.oid=a.grantee where p.oid=v_oid
      and (a.privilege_type<>'EXECUTE' or a.is_grantable or coalesce(gr.rolname,'PUBLIC') not in ('postgres','authenticated')
        or a.grantor<>(select oid from pg_roles where rolname='postgres')))
    or not has_function_privilege('authenticated',v_oid,'EXECUTE') then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',
      detail=coalesce(v_catalog::text,'missing exact Native function');
  end if;
  v_hash:=encode(pg_catalog.sha256(convert_to(v_source,'UTF8')),'hex');
  if v_hash='a6eb23ee9c69dae6e1f0ac709587f2b46f675478a326b30f2b3a909bf8170017' then return; end if;
  if v_hash<>'e0aaaeef216f736fca47cc3523a5d6c690dcd5cf6711f755411104c96eb7ba04' then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail=v_catalog::text;
  end if;
  v_new:=v_source;
  if (length(v_new)-length(replace(v_new,$old_0$snapshot jsonb; trash boolean; intent uuid; confirmation jsonb;$old_0$,'')))/length($old_0$snapshot jsonb; trash boolean; intent uuid; confirmation jsonb;$old_0$)<>1 then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='anchor:0'; end if;
  v_new:=replace(v_new,$old_0$snapshot jsonb; trash boolean; intent uuid; confirmation jsonb;$old_0$,$new_0$snapshot jsonb; trash boolean; intent uuid; confirmation jsonb; whole_root boolean:=false;$new_0$);
  if (length(v_new)-length(replace(v_new,$old_1$'created_by_clued',clued_private.storage_owner_created_root_v1(u,p.id,root));$old_1$,'')))/length($old_1$'created_by_clued',clued_private.storage_owner_created_root_v1(u,p.id,root));$old_1$)<>1 then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='anchor:1'; end if;
  v_new:=replace(v_new,$old_1$'created_by_clued',clued_private.storage_owner_created_root_v1(u,p.id,root));$old_1$,$new_1$'created_by_clued',clued_private.storage_owner_created_root_v1(u,p.id,root),
      'root_trash_confirmation_mode','whole_created_root_v2');$new_1$);
  if (length(v_new)-length(replace(v_new,$old_2$    if confirmation->>'contract' is distinct from 'clued.storage-owner-confirmation/1'
      or confirmation->>'root_folder_id' is distinct from root
      or confirmation->'confirmed' is distinct from 'true'::jsonb
      or (confirmation-array['contract','root_folder_id','confirmed','normal_use','trash_created_root','metadata_digest','root_version'])<>'{}'::jsonb then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;$old_2$,'')))/length($old_2$    if confirmation->>'contract' is distinct from 'clued.storage-owner-confirmation/1'
      or confirmation->>'root_folder_id' is distinct from root
      or confirmation->'confirmed' is distinct from 'true'::jsonb
      or (confirmation-array['contract','root_folder_id','confirmed','normal_use','trash_created_root','metadata_digest','root_version'])<>'{}'::jsonb then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;$old_2$)<>1 then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='anchor:2'; end if;
  v_new:=replace(v_new,$old_2$    if confirmation->>'contract' is distinct from 'clued.storage-owner-confirmation/1'
      or confirmation->>'root_folder_id' is distinct from root
      or confirmation->'confirmed' is distinct from 'true'::jsonb
      or (confirmation-array['contract','root_folder_id','confirmed','normal_use','trash_created_root','metadata_digest','root_version'])<>'{}'::jsonb then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;$old_2$,$new_2$    whole_root:=coalesce(confirmation->>'contract'='clued.storage-owner-confirmation/2',false);
    if whole_root then
      if op<>'delete_prepare' or confirmation is distinct from jsonb_build_object(
        'contract','clued.storage-owner-confirmation/2','root_folder_id',root,'confirmed',true,
        'trash_created_root',true,'confirmation_mode','whole_created_root_v2') then
        raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    elsif confirmation->>'contract' is distinct from 'clued.storage-owner-confirmation/1'
      or confirmation->>'root_folder_id' is distinct from root
      or confirmation->'confirmed' is distinct from 'true'::jsonb
      or (confirmation-array['contract','root_folder_id','confirmed','normal_use','trash_created_root','metadata_digest','root_version'])<>'{}'::jsonb then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;$new_2$);
  if (length(v_new)-length(replace(v_new,$old_3$        or snapshot->>'metadata_digest' is distinct from confirmation->>'metadata_digest'
        or snapshot->>'root_version' is distinct from confirmation->>'root_version'$old_3$,'')))/length($old_3$        or snapshot->>'metadata_digest' is distinct from confirmation->>'metadata_digest'
        or snapshot->>'root_version' is distinct from confirmation->>'root_version'$old_3$)<>1 then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='anchor:3'; end if;
  v_new:=replace(v_new,$old_3$        or snapshot->>'metadata_digest' is distinct from confirmation->>'metadata_digest'
        or snapshot->>'root_version' is distinct from confirmation->>'root_version'$old_3$,$new_3$        or (not whole_root and (snapshot->>'metadata_digest' is distinct from confirmation->>'metadata_digest'
          or snapshot->>'root_version' is distinct from confirmation->>'root_version'))$new_3$);
  if (length(v_new)-length(replace(v_new,$old_4$        or coalesce(snapshot->>'etag','') !~ '^"[^"\r\n]{1,200}"$'$old_4$,'')))/length($old_4$        or coalesce(snapshot->>'etag','') !~ '^"[^"\r\n]{1,200}"$'$old_4$)<>1 then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='anchor:4'; end if;
  v_new:=replace(v_new,$old_4$        or coalesce(snapshot->>'etag','') !~ '^"[^"\r\n]{1,200}"$'$old_4$,$new_4$        or (not whole_root and coalesce(snapshot->>'etag','') !~ '^"[^"\r\n]{1,200}"$')
        or (whole_root and (jsonb_typeof(snapshot->'etag') is distinct from 'string'
          or length(snapshot->>'etag')>204 or snapshot->>'etag' ~ '[\r\n]'))$new_4$);
  if (length(v_new)-length(replace(v_new,$old_5$        jsonb_build_object('contract','clued.storage-owner-root-lifecycle/1','purpose','owner_root_decommission','root_folder_id',root),$old_5$,'')))/length($old_5$        jsonb_build_object('contract','clued.storage-owner-root-lifecycle/1','purpose','owner_root_decommission','root_folder_id',root),$old_5$)<>1 then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='anchor:5'; end if;
  v_new:=replace(v_new,$old_5$        jsonb_build_object('contract','clued.storage-owner-root-lifecycle/1','purpose','owner_root_decommission','root_folder_id',root),$old_5$,$new_5$        jsonb_build_object('contract',case when whole_root then 'clued.storage-owner-root-lifecycle/2'
          else 'clued.storage-owner-root-lifecycle/1' end,'purpose','owner_root_decommission','root_folder_id',root)
          ||case when whole_root then jsonb_build_object('confirmation_mode','whole_created_root_v2') else '{}'::jsonb end,$new_5$);
  if (length(v_new)-length(replace(v_new,$old_6$  if op='describe' then
    if p_input<>jsonb_build_object('action',op,'connection_id',c.id)$old_6$,'')))/length($old_6$  if op='describe' then
    if p_input<>jsonb_build_object('action',op,'connection_id',c.id)$old_6$)<>1 then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='anchor:6'; end if;
  v_new:=replace(v_new,$old_6$  if op='describe' then
    if p_input<>jsonb_build_object('action',op,'connection_id',c.id)$old_6$,$new_6$  if l.id is not null and l.operation='delete' and l.intent_id is not null and (
    l.confirmation->>'contract'='clued.storage-owner-confirmation/2'
    or exists(select 1 from clued_private.resource_center_mutations_v1 m where m.id=l.intent_id
      and m.authority_request->>'contract'='clued.storage-owner-root-lifecycle/2')) then
    -- Recover/observe can settle only this durable whole-root intent. Neither
    -- caller input nor a changed confirmation can select another mode.
    if l.confirmation-'snapshot' is distinct from jsonb_build_object(
      'contract','clued.storage-owner-confirmation/2','root_folder_id',root,'confirmed',true,
      'trash_created_root',true,'confirmation_mode','whole_created_root_v2')
      or l.confirmation->'snapshot'->>'root_folder_id' is distinct from root
      or l.confirmation->'snapshot'->'owned_by_me' is distinct from 'true'::jsonb
      or l.confirmation->'snapshot'->'can_trash' is distinct from 'true'::jsonb
      or not clued_private.storage_owner_created_root_v1(u,p.id,root)
      or not exists(select 1 from clued_private.resource_center_mutations_v1 m where m.id=l.intent_id
        and m.user_id=u and m.profile_id=p.id and m.profile_version=p.version
        and m.request_sha256=l.request_digest and m.exact_request=l.confirmation-'snapshot'
        and m.authority_request=jsonb_build_object('contract','clued.storage-owner-root-lifecycle/2',
          'purpose','owner_root_decommission','root_folder_id',root,'confirmation_mode','whole_created_root_v2')
        and m.authority_result=jsonb_build_object('native_owner_confirmed',true,'created_by_clued',true)) then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
  end if;
  if op='describe' then
    if p_input<>jsonb_build_object('action',op,'connection_id',c.id)$new_6$);
  if (length(v_new)-length(replace(v_new,$old_7$'oauth_client_id',c.oauth_client_id,'root_folder_id',root,'root_parent_id',p.root_parent_id,'created_by_clued',true));$old_7$,'')))/length($old_7$'oauth_client_id',c.oauth_client_id,'root_folder_id',root,'root_parent_id',p.root_parent_id,'created_by_clued',true));$old_7$)<>1 then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='anchor:7'; end if;
  v_new:=replace(v_new,$old_7$'oauth_client_id',c.oauth_client_id,'root_folder_id',root,'root_parent_id',p.root_parent_id,'created_by_clued',true));$old_7$,$new_7$'oauth_client_id',c.oauth_client_id,'root_folder_id',root,'root_parent_id',p.root_parent_id,'created_by_clued',true)
        ||case when l.confirmation->>'contract'='clued.storage-owner-confirmation/2'
          then jsonb_build_object('root_trash_confirmation_mode','whole_created_root_v2') else '{}'::jsonb end)
      ||case when l.confirmation->>'contract'='clued.storage-owner-confirmation/2'
        then jsonb_build_object('confirmation_contract','clued.storage-owner-confirmation/2',
          'confirmation_mode','whole_created_root_v2') else '{}'::jsonb end;$new_7$);
  if encode(pg_catalog.sha256(convert_to(v_new,'UTF8')),'hex')<>'a6eb23ee9c69dae6e1f0ac709587f2b46f675478a326b30f2b3a909bf8170017' then
    raise exception 'storage_owner_root_trash_upgrade_unqualified' using errcode='42501',detail='patched source mismatch'; end if;
  execute replace(v_definition,v_source,v_new);
end $upgrade$;

notify pgrst,'reload schema';
