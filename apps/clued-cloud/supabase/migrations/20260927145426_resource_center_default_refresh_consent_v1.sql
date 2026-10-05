-- Native, disclosed first-connection consent. Old attempts remain opted out.
alter table clued_private.storage_oauth_attempts_v1
  add column default_refresh_consent boolean not null default false;
alter table clued_private.storage_connections_v1
  add column refresh_default_blocked boolean not null default true;
-- Existing connections never acquire a new standing grant through a reconnect,
-- including old disables made before a delegation row existed.
alter table clued_private.storage_connections_v1
  alter column refresh_default_blocked set default false;

-- A disable must persist even before OAuth has created a delegation. All three
-- native mutation paths use provider-root -> connection ordering, as OAuth does.
alter function public.clued_storage_refresh_manage_v1(jsonb) set schema clued_private;
revoke all on function clued_private.clued_storage_refresh_manage_v1(jsonb) from public,anon,authenticated,service_role;
create function public.clued_storage_refresh_manage_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); root text; result jsonb;
begin
  select p.root_folder_id into root from clued_private.storage_connections_v1 c
    join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
    where c.id=(p_input->>'connection_id')::uuid and c.owner_id=u;
  if root is null then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if p_input->>'action' in ('enable','disable') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  end if;
  result:=clued_private.clued_storage_refresh_manage_v1(p_input);
  if p_input->>'action'='disable' then
    update clued_private.storage_connections_v1 set refresh_default_blocked=true
      where id=(p_input->>'connection_id')::uuid and owner_id=u;
  end if;
  perform clued_private.storage_owner_v1();
  return result;
end $$;
revoke all on function public.clued_storage_refresh_manage_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_refresh_manage_v1(jsonb) to authenticated;

alter function public.clued_storage_account_v1(jsonb) set schema clued_private;
revoke all on function clued_private.clued_storage_account_v1(jsonb) from public,anon,authenticated,service_role;
create function public.clued_storage_account_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); root text;
begin
  if p_input->>'action'='revoke_connection' then
    select p.root_folder_id into root from clued_private.storage_connections_v1 c
      join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
      where c.id=(p_input->>'connection_id')::uuid and c.owner_id=u;
    if root is null then raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  end if;
  return clued_private.clued_storage_account_v1(p_input);
end $$;
revoke all on function public.clued_storage_account_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_account_v1(jsonb) to authenticated;

-- Preserve the reviewed credential recovery wrapper and every original fence.
alter function public.clued_storage_oauth_v1(text,jsonb) rename to storage_oauth_recovery_v1;
alter function public.storage_oauth_recovery_v1(text,jsonb) set schema clued_private;
revoke all on function clued_private.storage_oauth_recovery_v1(text,jsonb) from public,anon,authenticated,service_role;
create function public.clued_storage_oauth_v1(p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); connection uuid; root text; result jsonb;
  op text:=p_input->>'action'; c clued_private.storage_connections_v1;
  x clued_private.storage_oauth_attempts_v1; eligible boolean; consent boolean:=false;
  req jsonb; refs jsonb; ev text; r public.clued_audit_receipts; project uuid;
begin
  if op in ('claim','complete') then
    select connection_id into connection from clued_private.storage_oauth_attempts_v1
      where state_hash=p_input->>'state_hash' and owner_id=u;
  else connection:=(p_input->>'connection_id')::uuid; end if;
  select p.root_folder_id,p.project_id into root,project from clued_private.storage_connections_v1 c0
    join clued_private.resource_center_profiles_v1 p on p.id=c0.profile_id where c0.id=connection and c0.owner_id=u;
  if root is null then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  select * into c from clued_private.storage_connections_v1 where id=connection and owner_id=u for update;
  -- Root-wide history, not a per-client/per-device default. Replacement IDs,
  -- changed OAuth clients or reconnecting must never erase a previous stop.
  eligible:=c.state='awaiting_provider' and c.credential_version=0 and not exists (
    select 1 from clued_private.storage_connections_v1 history
      join clued_private.resource_center_profiles_v1 hp on hp.id=history.profile_id
      left join clued_private.storage_refresh_delegations_v1 d on d.connection_id=history.id
      where history.owner_id=u and hp.root_folder_id=root and history.provider=c.provider
        and (history.refresh_default_blocked or history.revoked_at is not null or history.state<>'awaiting_provider'
          or history.credential_version>0 or d.connection_id is not null));
  if op='prepare' and p_input ? 'default_refresh_consent' then
    if jsonb_typeof(p_input->'default_refresh_consent') is distinct from 'boolean' then
      raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    consent:=(p_input->>'default_refresh_consent')::boolean;
    if consent and not eligible then raise exception 'storage_default_refresh_unavailable' using errcode='42501'; end if;
  end if;
  if op='complete' then
    select * into x from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash' and owner_id=u;
  end if;
  -- Only prepare may carry consent. Later callback payloads cannot grant it.
  result:=clued_private.storage_oauth_recovery_v1(p_issuer_hash,
    case when op='prepare' then p_input-'default_refresh_consent' else p_input end);
  if op='describe' then result:=result||jsonb_build_object('default_refresh_eligible',eligible); end if;
  if op='prepare' then
    update clued_private.storage_oauth_attempts_v1 set default_refresh_consent=consent
      where id=(p_input->>'attempt_id')::uuid and owner_id=u;
  end if;
  if op='complete' and result->>'status'='completed' and x.default_refresh_consent and eligible then
    -- Separate effects, separate immutable receipts, one database transaction.
    -- Never append new effects to an already-finished OAuth receipt.
    req:=jsonb_build_object('idempotency_key','oauth-default-refresh:'||x.id::text,
      'connection_id',c.id,'oauth_attempt_id',x.id,'oauth_receipt_id',result->>'receipt_id',
      'session_id',x.session_id,'issuer_hash',p_issuer_hash,'until_revoked',true);
    r:=clued_private.m1_begin_receipt(u,null,'storage_default_refresh',req,clued_private.m1_sha256(req));
    if r.status<>'pending' then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    insert into clued_private.storage_refresh_delegations_v1(connection_id,issuer_hash,enabled,receipt_id)
      values(c.id,p_issuer_hash,true,r.id);
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
    ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:default_refresh_enable',
      refs,'project:'||project::text,null,
      jsonb_build_object('connection_id',c.id,'oauth_attempt_id',x.id,'oauth_receipt_id',result->>'receipt_id','until_revoked',true),
      req->>'idempotency_key',r.request_sha256,
      'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
    result:=result||jsonb_build_object('refresh_receipt_id',r.id);
  end if;
  if op in ('claim','complete') and result->>'status'='completed' then
    result:=result||jsonb_build_object('refresh_enabled',exists(select 1 from clued_private.storage_refresh_delegations_v1
      where connection_id=connection and enabled));
  end if;
  perform clued_private.storage_owner_v1();
  if op in ('claim','complete') and not exists(select 1 from clued_private.storage_oauth_attempts_v1
    where state_hash=p_input->>'state_hash' and owner_id=u and session_id=(auth.jwt()->>'session_id')::uuid
      and issuer_hash=p_issuer_hash and expires_at>clock_timestamp()) then
    raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  return result;
end $$;
revoke all on function public.clued_storage_oauth_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_oauth_v1(text,jsonb) to authenticated;
