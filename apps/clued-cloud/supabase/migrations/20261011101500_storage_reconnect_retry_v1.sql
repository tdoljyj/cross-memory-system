-- Closing a consent page must not strand an unclaimed reconnect for ten minutes.
-- A NEW Native confirmation may replace only a credential-free, unclaimed
-- preparation. Root stop remains denied; claimed/unknown effects still block.
do $upgrade$
declare
  target regprocedure := 'public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure;
  definition text; source_hash text; anchor text; replacement text; hits integer;
begin
  if not exists(select 1 from pg_proc where oid=target
    and pg_get_userbyid(proowner)='postgres' and prosecdef
    and proconfig=array['search_path=""']
    and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
    raise exception 'storage_reconnect_retry_upgrade_unqualified' using errcode='42501';
  end if;
  select pg_get_functiondef(target),encode(sha256(convert_to(prosrc,'UTF8')),'hex')
    into definition,source_hash from pg_proc where oid=target;
  if source_hash='dfc42609cbfa7af4086259c093f6993e1a541ceda8a4c1dd399a88983c3d9317' then return; end if;
  if source_hash<>'52ac7fd31ce54b212dc528d657bddb21641d7896e4b93d859ac0131c54d3e00d' then
    raise exception 'storage_reconnect_retry_upgrade_unqualified' using errcode='42501';
  end if;
  anchor := $a$        if l.expires_at>clock_timestamp() then raise exception 'storage_owner_lifecycle_conflict' using errcode='40001'; end if;$a$;
  hits := (length(definition)-length(replace(definition,anchor,'')))/length(anchor);
  if hits<>1 then raise exception 'storage_reconnect_retry_definition_mismatch'; end if;
  definition := replace(definition,anchor,'');
  anchor := $a$        if fresh.id is null or fresh.account_policy_id is not null or fresh.auth_mode<>'legacy' or fresh.revoked_at is not null then
          raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;$a$;
  replacement := $r$        if fresh.id is null or fresh.account_policy_id is not null or fresh.auth_mode<>'legacy' or fresh.revoked_at is not null
          or fresh.state<>'awaiting_provider' or fresh.credential_envelope is not null then
          raise exception 'storage_owner_lifecycle_conflict' using errcode='40001'; end if;
        -- Connection lock serializes OAuth claim before its outbound token POST.
        -- Never retire a claimed/completed attempt, even after its TTL elapsed.
        perform 1 from clued_private.storage_oauth_attempts_v1
          where owner_id=u and connection_id=fresh.id order by id for update;
        if exists(select 1 from clued_private.storage_oauth_attempts_v1
          where owner_id=u and connection_id=fresh.id and status<>'prepared') then
          raise exception 'storage_owner_lifecycle_conflict' using errcode='40001'; end if;
        update clued_private.storage_oauth_attempts_v1 set expires_at=least(expires_at,clock_timestamp())
          where owner_id=u and connection_id=fresh.id and status='prepared';$r$;
  hits := (length(definition)-length(replace(definition,anchor,'')))/length(anchor);
  if hits<>1 then raise exception 'storage_reconnect_retry_definition_mismatch'; end if;
  definition := replace(definition,anchor,replacement);
  -- The expired-recovery branch has different indentation. Apply the same
  -- no-start proof there, preserving its existing cancellation-only behavior.
  anchor := replace(anchor,E'\n          ',E'\n        ');
  anchor := substring(anchor from 3);
  replacement := regexp_replace(replacement,'^  |\n  ',E'\n','g');
  replacement := ltrim(replacement,E'\n');
  hits := (length(definition)-length(replace(definition,anchor,'')))/length(anchor);
  if hits<>1 then raise exception 'storage_reconnect_retry_definition_mismatch'; end if;
  definition := replace(definition,anchor,replacement);
  execute definition;
end $upgrade$;
notify pgrst,'reload schema';
