-- One state namespace: legacy attempts stay connection-purpose. Recovery is
-- fresh human consent for credentials ONLY, never permission or file replay.
alter table clued_private.storage_oauth_attempts_v1
  add column purpose text not null default 'connection',
  add column recovery_job_id uuid,
  add column recovery_binding text,
  add column recovery_refresh_snapshot jsonb,
  add constraint storage_oauth_purpose_v1 check (
    (purpose='connection' and recovery_job_id is null and recovery_binding is null and recovery_refresh_snapshot is null) or
    (purpose='credential_recovery' and recovery_job_id is not null and recovery_binding is not null
      and recovery_binding ~ '^[0-9a-f]{64}$' and recovery_refresh_snapshot is not null
      and jsonb_typeof(recovery_refresh_snapshot)='array' and not default_refresh_consent)),
  add constraint storage_oauth_recovery_job_v1 foreign key(owner_id,recovery_job_id)
    references clued_private.storage_jobs_v1(owner_id,job_id);

create function clued_private.storage_credential_recovery_oauth_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  app clued_private.storage_oauth_apps_v1; x clued_private.storage_oauth_attempts_v1;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  connection uuid; job uuid; d jsonb; descriptor jsonb; pending jsonb; bound text; result jsonb;
  req jsonb; r public.clued_audit_receipts; refs jsonb; ev text;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('describe','prepare','claim','complete') then
    raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
  if (op='describe' and p_input is distinct from jsonb_build_object('action',op,'connection_id',p_input->>'connection_id','job_id',p_input->>'job_id')) or
    (op='prepare' and (p_input-array['action','connection_id','job_id','connection_version','attempt_id','state_hash','verifier_envelope','recovery_binding'])<>'{}'::jsonb) or
    (op='claim' and p_input is distinct from jsonb_build_object('action',op,'state_hash',p_input->>'state_hash')) or
    (op='complete' and (p_input-array['action','state_hash','provider_subject','credential_envelope'])<>'{}'::jsonb) then
    raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
  if op in ('claim','complete') then
    -- Read only for routing. Never lock the attempt before job/root locks.
    select * into x from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash'
      and owner_id=u and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=app.issuer_hash
      and purpose='credential_recovery' and expires_at>clock_timestamp();
    if not found then raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
    connection:=x.connection_id; job:=x.recovery_job_id;
  else connection:=(p_input->>'connection_id')::uuid; job:=(p_input->>'job_id')::uuid; end if;
  -- Same original job and root serialization as settlement. No root_quiet bypass
  -- for an ordinary operation: only this exact existing unknown effect qualifies.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||u::text||':'||job::text,0));
  select * into c from clued_private.storage_connections_v1 where id=connection and owner_id=u;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u;
  if p.id is null then raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||p.root_folder_id,0));
  select * into c from clued_private.storage_connections_v1 where id=connection and owner_id=u for update;
  if c.oauth_client_id is distinct from app.oauth_client_id or c.revoked_at is not null or
    c.state not in ('active','reauthorization_required') then
    raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
  if x.id is not null then
    select * into x from clued_private.storage_oauth_attempts_v1 where id=x.id for update;
    if x.purpose<>'credential_recovery' or x.connection_id<>connection or x.recovery_job_id<>job or
      x.owner_id<>u or x.session_id<>(auth.jwt()->>'session_id')::uuid or x.issuer_hash<>app.issuer_hash or
      x.expires_at<=clock_timestamp() then raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
    if x.status='completed' then
      -- A lost commit response is read from this original attempt. No second
      -- token exchange, no dependence on whether the file was later settled.
      if op<>'claim' then raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
      perform clued_private.storage_owner_v1();
      if x.expires_at<=clock_timestamp() then raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
      return jsonb_build_object('status','completed','receipt_id',x.receipt_id,'purpose','credential_recovery');
    end if;
  end if;
  d:=public.clued_storage_native_recovery_v1(p_issuer_hash,jsonb_build_object(
    'action','recovery_load','connection_id',connection,'job_id',job));
  -- The root lock also serializes refresh claims. Bind complete old-generation
  -- pending identities; a new/finished/changed claim invalidates this consent.
  perform 1 from clued_private.storage_refresh_attempts_v1 where connection_id=connection and state='claimed' order by id for update;
  if exists(select 1 from clued_private.storage_refresh_attempts_v1 where connection_id=connection and state='claimed'
    and credential_version<>c.credential_version) then raise exception 'storage_credential_recovery_stale' using errcode='40001'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) into pending
    from clued_private.storage_refresh_attempts_v1 a where connection_id=connection and state='claimed' and credential_version=c.credential_version;
  bound:=clued_private.m1_sha256(jsonb_build_object('recovery_binding',d->>'recovery_binding','pending_refresh',pending,
    -- Fairness polling is observation, not a change of credential authority.
    'delegation',(select to_jsonb(delegation)-'last_polled_at' from clued_private.storage_refresh_delegations_v1 delegation where connection_id=connection)));
  descriptor:=jsonb_build_object('owner_id',u,'connection_id',connection,'connection_version',c.version,
    'credential_version',c.credential_version+1,'provider_subject',c.provider_subject,'oauth_client_id',app.oauth_client_id,
    'redirect_uri',app.redirect_uri,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'recovery_binding',bound);
  if op='describe' then result:=descriptor;
  elsif op='prepare' then
    if p_input->>'recovery_binding' is distinct from bound or p_input->>'connection_version' is distinct from c.version::text or
      coalesce(p_input->>'state_hash','') !~ '^[0-9a-f]{64}$' or
      not clued_private.storage_envelope_valid_v1(p_input->'verifier_envelope') then
      raise exception 'storage_credential_recovery_stale' using errcode='40001'; end if;
    insert into clued_private.storage_oauth_attempts_v1(id,connection_id,owner_id,session_id,issuer_hash,connection_version,
      state_hash,verifier_envelope,expires_at,purpose,recovery_job_id,recovery_binding,recovery_refresh_snapshot)
      values((p_input->>'attempt_id')::uuid,connection,u,(auth.jwt()->>'session_id')::uuid,app.issuer_hash,c.version,
        p_input->>'state_hash',p_input->'verifier_envelope',clock_timestamp()+interval '10 minutes','credential_recovery',job,bound,pending);
    result:=jsonb_build_object('status','prepared');
  else
    if x.connection_version<>c.version or x.recovery_binding<>bound or x.recovery_refresh_snapshot<>pending then
      raise exception 'storage_credential_recovery_stale' using errcode='40001'; end if;
    if op='claim' then
      if x.status<>'prepared' then raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
      update clued_private.storage_oauth_attempts_v1 set status='claimed' where id=x.id;
      result:=descriptor||jsonb_build_object('status','claimed','attempt_id',x.id,'verifier_envelope',x.verifier_envelope,'purpose','credential_recovery');
    else
      if x.status<>'claimed' or p_input->>'provider_subject' is distinct from c.provider_subject or
        not clued_private.storage_envelope_valid_v1(p_input->'credential_envelope') then
        raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
      req:=jsonb_build_object('idempotency_key',x.id::text||':credential-recovery','connection_id',connection,'job_id',job,
        'oauth_attempt_id',x.id,'credential_version',c.credential_version+1,'request_digest',clued_private.m1_sha256(p_input));
      r:=clued_private.m1_begin_receipt(u,null,'storage_credential_recovery',req,clued_private.m1_sha256(req));
      if r.status<>'pending' then raise exception 'storage_credential_recovery_stale' using errcode='40001'; end if;
      update clued_private.storage_connections_v1 set credential_envelope=p_input->'credential_envelope',
        credential_version=credential_version+1,version=version+1,receipt_id=r.id where id=connection returning * into c;
      -- Only the snapshotted credential-only exchanges are resolved. No broad
      -- root sweep, delegation enable/disable, failure reset or schedule reset.
      update clued_private.storage_refresh_attempts_v1 set state='superseded',receipt_id=r.id
        where id in (select (item->>'id')::uuid from jsonb_array_elements(pending) item)
          and connection_id=connection and credential_version=c.credential_version-1 and state='claimed';
      refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',connection));
      ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:credential_recovered',refs,
        'project:'||p.project_id::text,null,jsonb_build_object('connection_id',connection,'job_id',job,'oauth_attempt_id',x.id,
          'credential_version',c.credential_version,'superseded_refresh_count',jsonb_array_length(pending),'execution_permitted',false),
        req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
      perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(connection::text,x.connection_version),
        jsonb_build_object(connection::text,c.version),array[ev],'{}'::uuid[],null);
      update clued_private.storage_oauth_attempts_v1 set status='completed',receipt_id=r.id where id=x.id;
      result:=jsonb_build_object('status','completed','receipt_id',r.id,'purpose','credential_recovery');
    end if;
  end if;
  perform clued_private.storage_owner_v1();
  if x.id is not null and x.expires_at<=clock_timestamp() then raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
  return result;
end $$;
revoke all on function clued_private.storage_credential_recovery_oauth_v1(text,jsonb) from public,anon,authenticated,service_role;

-- Only server-bound describe/prepare use this entry. Browser payloads never pick
-- the callback purpose or supply an authorization/profile to the database.
create function public.clued_storage_recovery_oauth_start_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if coalesce(p_input->>'action','') not in ('describe','prepare') then
    raise exception 'storage_credential_recovery_denied' using errcode='42501'; end if;
  return clued_private.storage_credential_recovery_oauth_v1(p_issuer_hash,p_input);
end $$;
revoke all on function public.clued_storage_recovery_oauth_start_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_recovery_oauth_start_v1(text,jsonb) to authenticated;

alter function public.clued_storage_oauth_v1(text,jsonb) rename to storage_oauth_connection_consent_v1;
alter function public.storage_oauth_connection_consent_v1(text,jsonb) set schema clued_private;
revoke all on function clued_private.storage_oauth_connection_consent_v1(text,jsonb) from public,anon,authenticated,service_role;
create function public.clued_storage_oauth_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); x clued_private.storage_oauth_attempts_v1;
begin
  if p_input->>'action' in ('claim','complete','inspect') then
    perform 1 from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
    if not found then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    select * into x from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash' and owner_id=u
      and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=p_issuer_hash
      and (p_input->>'action'='inspect' or expires_at>clock_timestamp());
    if not found then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    if p_input->>'action'='inspect' then
      if x.purpose<>'credential_recovery' or p_input is distinct from jsonb_build_object('action','inspect','state_hash',x.state_hash) then
        raise exception 'storage_oauth_denied' using errcode='42501'; end if;
      perform clued_private.storage_owner_v1();
      return jsonb_build_object('purpose','credential_recovery','status',case when x.status<>'completed' and x.expires_at<=clock_timestamp()
        then 'expired' else x.status end,'receipt_id',x.receipt_id,'execution_permitted',false);
    end if;
    if x.purpose='credential_recovery' then return clued_private.storage_credential_recovery_oauth_v1(p_issuer_hash,p_input);
    elsif x.purpose<>'connection' then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  end if;
  return clued_private.storage_oauth_connection_consent_v1(p_issuer_hash,p_input);
end $$;
revoke all on function public.clued_storage_oauth_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_oauth_v1(text,jsonb) to authenticated;
