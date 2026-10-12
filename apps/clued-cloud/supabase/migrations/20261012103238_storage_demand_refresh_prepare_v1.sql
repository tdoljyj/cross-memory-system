-- Prepare operational demand metadata. Idle scheduling is not activated here.
-- Native caller wrappers and the qualified Worker must be installed before use.
create table clued_private.storage_refresh_activity_v1 (
  connection_id uuid primary key references clued_private.storage_connections_v1(id),
  credential_version bigint not null check(credential_version>=1),
  credential_expires_at timestamptz not null,
  last_demand_at timestamptz,
  last_successful_exchange_at timestamptz,
  keepalive_anchor_at timestamptz not null default clock_timestamp(),
  observed_at timestamptz not null default clock_timestamp()
);
create table clued_private.storage_refresh_demand_proofs_v1 (
  proof_hash text primary key check(proof_hash ~ '^[0-9a-f]{64}$'),
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  owner_id uuid not null,
  issuer_hash text not null,
  caller_kind text not null check(caller_kind in ('agent_read','owner','job','recovery','maintenance')),
  caller_token_hash text,
  owner_session_id uuid,
  original_request jsonb not null check(jsonb_typeof(original_request)='object'),
  credential_version bigint not null,
  delegation_version bigint not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index storage_refresh_demand_expiry_v1 on clued_private.storage_refresh_demand_proofs_v1(expires_at);
alter table clued_private.storage_refresh_activity_v1 enable row level security;
alter table clued_private.storage_refresh_demand_proofs_v1 enable row level security;
revoke all on clued_private.storage_refresh_activity_v1,clued_private.storage_refresh_demand_proofs_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Only private, current Native evaluators call this helper. A connection ID by
-- itself is never an authorization to issue a renewal proof.
create function clued_private.storage_demand_authorize_v1(
  p_issuer_hash text,p_connection uuid,p_kind text,p_actor_hash text,p_session uuid,p_request jsonb)
returns clued_private.storage_connections_v1 language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; app clued_private.storage_oauth_apps_v1;
  evaluated jsonb; result jsonb; identity text; wanted text; root_id text;
begin
  -- Private entry: the public RPC resolved the actual rotating credential.
  -- Re-entering a public router with its historical identity would wrongly
  -- attempt to authenticate with an identity whose old credential is retired.
  identity:=p_issuer_hash;
  if not exists(select 1 from clued_private.issuer_identities_v1 i
    join clued_private.issuer_credentials_v1 k on k.issuer_id=i.id
    where i.kind='storage' and i.legacy_key=identity and k.state='active'
      and coalesce(k.valid_until>clock_timestamp(),true)) then
    raise exception 'storage_demand_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=identity and revoked_at is null for share;
  select * into c from clued_private.storage_connections_v1 where id=p_connection;
  if app.issuer_hash is null or c.id is null or c.oauth_client_id is distinct from app.oauth_client_id
    or jsonb_typeof(p_request) is distinct from 'object' then
    raise exception 'storage_demand_denied' using errcode='42501'; end if;
  if p_kind='agent_read' then
    if not app.read_enabled or coalesce(p_actor_hash,'') !~ '^[0-9a-f]{64}$'
      or coalesce(p_request->>'operation','') not in ('list','stat','search','resolve','read') then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
    wanted:=case when p_request->>'operation'='read' then 'read_content' else 'read' end;
    if wanted='read_content' then
      perform clued_private.storage_read_evaluate_v1(p_actor_hash,p_connection,'read');
    end if;
    evaluated:=clued_private.storage_read_evaluate_v1(p_actor_hash,p_connection,wanted);
    if (evaluated->>'owner_id')::uuid is distinct from c.owner_id
      or (evaluated->>'connection_id')::uuid is distinct from c.id then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
    if p_request->'content_search'='true'::jsonb then
      if evaluated->>'content_profile' is distinct from 'normal/1' or c.provider_scope_profile not in ('normal','full') then
        raise exception 'storage_read_scope_upgrade_required' using errcode='42501'; end if;
      perform clued_private.storage_read_evaluate_v1(p_actor_hash,p_connection,'read_content');
    end if;
  elsif p_kind='owner' then
    select p.root_folder_id into root_id from clued_private.resource_center_profiles_v1 p where p.id=c.profile_id;
    if root_id is null then raise exception 'storage_demand_denied' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text||':'||root_id,0));
    perform 1 from auth.sessions s where s.id=p_session and s.user_id=c.owner_id
      and coalesce(s.not_after>clock_timestamp(),true) for share;
    if p_session is null or not found then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
    perform clued_private.authorization_account_v12(c.owner_id);
  elsif p_kind in ('job','recovery') then
    if not app.execution_enabled or p_request->>'connection_id' is distinct from c.id::text
      or coalesce(p_request->>'job_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (p_request-array['connection_id','job_id'])<>'{}'::jsonb then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
    -- Recovery keeps its existing exact-job/intent/provider-attempt evaluator.
    -- Normal job load can issue internal reader/writer bindings and receipts;
    -- it is not a pure read and is never used as recovery authorization.
    if p_kind='recovery' and c.auth_mode='account_policy' then
      result:=clued_private.ii_pub_clued_storage_scheduled_recovery_v2(identity,p_request||jsonb_build_object('action','load'));
    else
      result:=clued_private.ii_pub_clued_storage_cloud_worker_router_v2(identity,p_request||jsonb_build_object('action',
        case when p_kind='recovery' then 'recovery_load' else 'load' end));
    end if;
    if result->>'status' is distinct from (case when p_kind='recovery' then 'recovery_only' else 'queued' end)
      or result->>'connection_id' is distinct from c.id::text or result->>'job_id' is distinct from p_request->>'job_id' then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
    if p_kind='recovery' then
      -- The dedicated evaluator already checks account, profile, source and
      -- provider-attempt fences, including reauthorization-required recovery.
      select sc.* into c from clued_private.storage_connections_v1 sc where sc.id=c.id and sc.owner_id=c.owner_id;
      return c;
    end if;
  elsif p_kind='maintenance' then
    -- Fixed background issuer plus the live standing delegation; this is not
    -- authority to read files or perform Owner/Agent operations.
    select p.root_folder_id into root_id from clued_private.resource_center_profiles_v1 p where p.id=c.profile_id;
    if root_id is null then raise exception 'storage_demand_denied' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text||':'||root_id,0));
    perform clued_private.authorization_account_v12(c.owner_id);
    if p_request->>'operation'='access_digest' then
      result:=clued_private.ii_pub_clued_storage_access_digest_backfill_v1(identity,
        jsonb_build_object('action','load','connection_id',c.id,'artifact_id',p_request->>'artifact_id'));
      if result->>'status' is distinct from 'read_only' or result->>'connection_id' is distinct from c.id::text
        or result->>'artifact_id' is distinct from p_request->>'artifact_id' then
        raise exception 'storage_demand_denied' using errcode='42501'; end if;
    elsif p_request<>jsonb_build_object('operation','scheduled') or not exists(
      select 1 from clued_private.storage_refresh_delegations_v1 d
      where d.connection_id=c.id and d.enabled and d.issuer_hash=identity) then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
  else raise exception 'storage_demand_denied' using errcode='42501'; end if;
  return clued_private.storage_connection_current_v1(c.id,c.owner_id);
end $$;
revoke all on function clued_private.storage_demand_authorize_v1(text,uuid,text,text,uuid,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_demand_prepare_v1(
  p_issuer_hash text,p_connection uuid,p_kind text,p_actor_hash text,p_session uuid,p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; d clued_private.storage_refresh_delegations_v1;
  identity text; secret text; hashed text; expiry timestamptz; pending boolean;
begin
  c:=clued_private.storage_demand_authorize_v1(p_issuer_hash,p_connection,p_kind,p_actor_hash,p_session,p_request);
  identity:=p_issuer_hash;
  select * into d from clued_private.storage_refresh_delegations_v1 where connection_id=c.id;
  if c.credential_envelope is null or c.credential_version<1 or c.provider_subject is null then
    raise exception 'storage_demand_denied' using errcode='42501'; end if;
  -- Bounded operational proofs do not alter business memory or issue a file
  -- admission. They are never returned through an Agent/browser response.
  perform pg_advisory_xact_lock(hashtextextended('storage-demand-proof:'||c.id::text,0));
  delete from clued_private.storage_refresh_demand_proofs_v1 where connection_id=c.id and expires_at<=clock_timestamp();
  if (select count(*) from clued_private.storage_refresh_demand_proofs_v1 where connection_id=c.id)>31 then
    raise exception 'storage_demand_busy' using errcode='42501'; end if;
  secret:='clued_srp_'||encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
  hashed:=encode(sha256(convert_to(secret,'UTF8')),'hex');
  expiry:=clock_timestamp()+interval '60 seconds';
  if p_kind='owner' then
    select least(expiry,s.not_after) into expiry from auth.sessions s where s.id=p_session and s.user_id=c.owner_id;
  end if;
  insert into clued_private.storage_refresh_demand_proofs_v1(proof_hash,connection_id,owner_id,issuer_hash,caller_kind,
    caller_token_hash,owner_session_id,original_request,credential_version,delegation_version,expires_at)
    values(hashed,c.id,c.owner_id,identity,p_kind,p_actor_hash,p_session,p_request,c.credential_version,coalesce(d.version,0),expiry);
  select exists(select 1 from clued_private.storage_refresh_attempts_v1 x where x.connection_id=c.id and x.state='claimed') into pending;
  return jsonb_build_object('contract','clued.storage-demand-preflight/1','connection_id',c.id,'owner_id',c.owner_id,
    'provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,'credential_version',c.credential_version,
    'credential_envelope',c.credential_envelope,'provider_scope_profile',c.provider_scope_profile,
    'delegation_version',coalesce(d.version,0),'renewal_enabled',coalesce(d.enabled,false),
    'refresh_state',case when pending then 'pending' else 'idle' end,'proof',secret);
end $$;
revoke all on function clued_private.storage_demand_prepare_v1(text,uuid,text,text,uuid,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Public signatures, GW80/CI8 ACLs and legacy refresh scheduling are unchanged.
-- Consumer wrappers and activation are a separate qualified implementation step.
notify pgrst,'reload schema';
