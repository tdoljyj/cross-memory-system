-- Fresh Native consent enables renewal only after completed reconnect activation.
-- Previous delegations and the initial-onboarding eligibility guard are untouched.
do $upgrade$
declare definition text; patch record; hits integer; source_hash text;
begin
  if not exists(select 1 from pg_proc p where p.oid='public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure
    and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig=array['search_path=""']
    and p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
    raise exception 'storage_reconnect_refresh_upgrade_unqualified' using errcode='42501'; end if;
  select encode(sha256(convert_to(prosrc,'UTF8')),'hex') into source_hash from pg_proc
    where oid='public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure;
  if source_hash='5507655146cad446408ddb26136a3c8cbeb84b88ee559aa19114b8f3c03a2238' then return; end if;
  if source_hash<>'dfc42609cbfa7af4086259c093f6993e1a541ceda8a4c1dd399a88983c3d9317' then
    raise exception 'storage_reconnect_refresh_upgrade_unqualified' using errcode='42501'; end if;
  definition:=pg_get_functiondef('public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure);
  for patch in select * from (values
    ($a$return l.result;$a$,
     $r$return case when l.confirmation->>'contract'='clued.storage-owner-confirmation/4' then
        l.result||jsonb_build_object('refresh_enabled',coalesce((select refresh_delegate.enabled and fresh_connection.state='active'
          from clued_private.storage_connections_v1 fresh_connection left join clued_private.storage_refresh_delegations_v1 refresh_delegate on refresh_delegate.connection_id=fresh_connection.id
          where fresh_connection.id=l.new_connection_id and fresh_connection.owner_id=u),false))
      else l.result end;$r$,2),
    ($a$    elsif confirmation->>'contract'='clued.storage-owner-confirmation/3' then$a$,
     $r$    elsif confirmation->>'contract'='clued.storage-owner-confirmation/4' then
      if op<>'reconnect_begin' or jsonb_typeof(confirmation->'master_enabled') is distinct from 'boolean'
        or jsonb_typeof(confirmation->'default_refresh') is distinct from 'boolean'
        or confirmation is distinct from jsonb_build_object('contract','clued.storage-owner-confirmation/4',
          'root_folder_id',root,'confirmed',true,'master_enabled',confirmation->'master_enabled',
          'disclosure_version','clued.storage-master-disclosure/1','default_refresh',confirmation->'default_refresh',
          'refresh_disclosure_version','clued.storage-reconnect-refresh-disclosure/1') then
        raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    elsif confirmation->>'contract'='clued.storage-owner-confirmation/3' then$r$,1),
    ($a$confirmation->>'contract'<>'clued.storage-owner-confirmation/3'$a$,
     $r$confirmation->>'contract' not in ('clued.storage-owner-confirmation/3','clued.storage-owner-confirmation/4')$r$,1),
    ($a$case when confirmation->>'contract'='clued.storage-owner-confirmation/3' then$a$,
     $r$case when confirmation->>'contract' in ('clued.storage-owner-confirmation/3','clued.storage-owner-confirmation/4') then$r$,1),
    ($a$case when normal then '全开' else '关闭' end
          else '重新授权原资料根$a$,
     $r$case when normal then '全开' else '关闭' end
          ||case when confirmation->>'contract'='clued.storage-owner-confirmation/4' then
            E'\n授权成功后，允许 Clued 在后台自动续签此连接，直到你关闭后台续签或断开连接。不会恢复旧连接的续签授权。不开启时，授权到期后需要重新连接。\nOwner 确认的后台续签状态：'
            ||case when (confirmation->>'default_refresh')::boolean then '开启' else '关闭' end else '' end
          else '重新授权原资料根$r$,1),
    ($a$confirmation->>'contract'='clued.storage-owner-confirmation/3' and normal$a$,
     $r$confirmation->>'contract' in ('clued.storage-owner-confirmation/3','clued.storage-owner-confirmation/4') and normal$r$,1),
    ($a$if l.confirmation->>'contract'='clued.storage-owner-confirmation/3' then$a$,
     $r$if l.confirmation->>'contract' in ('clued.storage-owner-confirmation/3','clued.storage-owner-confirmation/4') then$r$,1),
    ($a$    perform clued_private.storage_owner_v1();
    perform clued_private.issuer_resolve_identity_v1(p_issuer_hash,'storage');
    return answer;$a$,
     $r$    -- Completed replay returns above this branch and cannot undo a later stop.
    if l.confirmation->>'contract'='clued.storage-owner-confirmation/4' then
      if (l.confirmation->>'default_refresh')::boolean then
        perform public.clued_storage_refresh_manage_v1(jsonb_build_object('action','enable','connection_id',fresh.id,
          'base_version',(select version from clued_private.storage_connections_v1 where id=fresh.id),
          'delegation_version',coalesce((select version from clued_private.storage_refresh_delegations_v1 where connection_id=fresh.id),0),
          'idempotency_key','storage-reconnect-refresh:'||l.id::text,'until_revoked',true));
      end if;
      answer:=answer||jsonb_build_object('refresh_enabled',coalesce((select enabled from clued_private.storage_refresh_delegations_v1 where connection_id=fresh.id),false));
      update clued_private.storage_owner_lifecycle_v1 x set result=answer where x.id=l.id;
    end if;
    perform clued_private.storage_owner_v1();
    perform clued_private.issuer_resolve_identity_v1(p_issuer_hash,'storage');
    return answer;$r$,1)
  ) v(anchor,replacement,expected) loop
    hits:=(length(definition)-length(replace(definition,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then raise exception 'storage_reconnect_refresh_definition_mismatch: %',left(patch.anchor,90) using errcode='42501'; end if;
    definition:=replace(definition,patch.anchor,patch.replacement);
  end loop;
  execute definition;
  if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
    where oid='public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure)<>'5507655146cad446408ddb26136a3c8cbeb84b88ee559aa19114b8f3c03a2238' then
    raise exception 'storage_reconnect_refresh_definition_mismatch' using errcode='42501'; end if;
end $upgrade$;
notify pgrst,'reload schema';
